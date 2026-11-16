//! 共享叶子工具（hermes `gateway/hosted_rooms_common.py` 的 Rust 逐函数移植）。
//!
//! 上游自述：
//! > Each hosted-room module validates identifiers, bounded integers, exact field sets
//! > and canonical JSON with its own error class and pinned error strings; these
//! > helpers take the error class and message templates as parameters so failures
//! > stay byte-identical while the logic lives once. **Must stay a leaf: never
//! > import a hosted_room\* module (import cycle).**
//!
//! 移植要点（逐条对照，不自行发挥）：
//!
//! - `identifier` → [`identifier`]：strip + 长度 ≤ 128 + `IDENTIFIER_RE` 全匹配
//! - `bounded_int` → [`bounded_int`]：**拒绝 bool**（Python 里 `True` 是 `int` 子类，
//!   上游显式挡掉；Rust 用调用方传入 i64，bool 不存在，但 nil/float 的
//!   拒绝语义保留在 JSON 解析层）
//! - `exact_fields` → [`exact_fields`]：required 必须齐全、可选之外一律拒绝，
//!   报错时**字段名按字典序拼**（上游 `", ".join(sorted(...))`）
//! - `text` → [`text`]：非空白 + UTF-8 字节数上限；`strip=false` 时按原始文本量长
//! - `compact_json` → [`compact_json`]：**键排序 + 无空格分隔**（digest/存储的规范形）
//! - `canonical_json` → [`canonical_json`]：`compact_json` + 字节上限
//! - `utf8_len` / `clock` → [`utf8_len`] / [`clock`]
//! - `fenced_update` → [`fenced_update`]：CAS UPDATE，**不是恰好一行 = fence 丢失**
//! - `table_exists` / `table_columns` → 同名
//!
//! 存储连接（`open_sqlite` / `connect` / `transaction`）见 `store` 模块——上游
//! 它们转调 `hermes_cli.sqlite_util`，宿主对偶是 `rusqlite`（版本与 rpi 同源）。

use rusqlite::Connection;
use serde_json::Value;

/// 上游 `IDENTIFIER_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]*$")`。
///
/// 手写匹配器而非 regex 依赖：语义只有「首字符字母数字 + 其后字母数字或
/// `._:-`」，逐字符判断与正则等价且零依赖（`chars` 按 Unicode 标量遍历，
/// 非 ASCII 一律不匹配，与 Python `re` 的默认 ASCII 类不同——上游 `re` 未
/// 加 `re.ASCII`，但字符类里全是显式 ASCII 范围，故两者等价）。
pub fn is_identifier(value: &str) -> bool {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !(first.is_ascii_alphanumeric()) {
        return false;
    }
    chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '-'))
}

/// 标识符校验的错误（上游由调用方传入自己的错误类，此处宿主统一一种）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FieldError(pub String);

impl std::fmt::Display for FieldError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for FieldError {}

pub type Result<T> = std::result::Result<T, FieldError>;

fn err<T>(message: impl Into<String>) -> Result<T> {
    Err(FieldError(message.into()))
}

/// 上游 `identifier()`：strip 后校验长度与形状。
///
/// `invalid` 为 `None` 时用上游默认文案 `invalid {label}`。
pub fn identifier(
    value: &str,
    label: &str,
    max_chars: usize,
    check_shape: bool,
    invalid: Option<&str>,
) -> Result<String> {
    let trimmed = value.trim();
    if trimmed.is_empty()
        || trimmed.chars().count() > max_chars
        || (check_shape && !is_identifier(trimmed))
    {
        return err(invalid.map_or_else(|| format!("invalid {label}"), str::to_owned));
    }
    Ok(trimmed.to_owned())
}

/// 上游 `identifier()` 的默认形态（`max_chars=128`、形状校验开）。
pub fn identifier_default(value: &str, label: &str) -> Result<String> {
    identifier(value, label, 128, true, None)
}

/// 上游 `bounded_int()`：落在 `[low, high]`。
///
/// Python 侧额外拒绝 `bool`；Rust 的 `i64` 不带 bool 语义，故调用方若从 JSON
/// 取值须先经 [`json_i64`]（它拒绝 `true/false` 与浮点）。
pub fn bounded_int(value: i64, low: i64, high: Option<i64>, message: &str) -> Result<i64> {
    if value < low || high.is_some_and(|h| value > h) {
        return err(message.to_owned());
    }
    Ok(value)
}

/// 从 JSON 取整数，**拒绝 bool 与浮点**（对齐上游 `isinstance(value, bool)` 挡板）。
pub fn json_i64(value: &Value) -> Option<i64> {
    match value {
        // `n` would only be bound in the second alternative if these were
        // or-patterns — split them so the guard sees an initialized binding.
        Value::Bool(_) => None,
        Value::Number(n) if n.is_f64() => None,
        Value::Number(n) => n.as_i64(),
        _ => None,
    }
}

/// 上游 `exact_fields()`：required 必须齐全，required ∪ optional 之外一律拒绝。
///
/// 报错文案里的字段名**按字典序**拼接（上游 `", ".join(sorted(...))`）。
pub fn exact_fields(
    value: &Value,
    label: &str,
    required: &[&str],
    optional: &[&str],
    not_object: Option<&str>,
    missing_fmt: &str,
    unknown_fmt: &str,
) -> Result<()> {
    let Value::Object(map) = value else {
        return err(not_object.map_or_else(|| format!("{label} must be an object"), str::to_owned));
    };

    let mut missing: Vec<&str> = required
        .iter()
        .copied()
        .filter(|key| !map.contains_key(*key))
        .collect();
    if !missing.is_empty() {
        missing.sort_unstable();
        return err(
            missing_fmt
                .replace("{label}", label)
                .replace("{fields}", &missing.join(", ")),
        );
    }

    let mut unknown: Vec<&str> = map
        .keys()
        .map(String::as_str)
        .filter(|key| !required.contains(key) && !optional.contains(key))
        .collect();
    if !unknown.is_empty() {
        unknown.sort_unstable();
        return err(
            unknown_fmt
                .replace("{label}", label)
                .replace("{fields}", &unknown.join(", ")),
        );
    }
    Ok(())
}

/// 上游 `exact_fields()` 的默认文案形态。
pub fn exact_fields_default(value: &Value, label: &str, required: &[&str], optional: &[&str]) -> Result<()> {
    exact_fields(
        value,
        label,
        required,
        optional,
        None,
        "{label} is missing fields: {fields}",
        "{label} has unknown fields: {fields}",
    )
}

/// 上游 `text()`：非空白 + UTF-8 字节上限；`strip=false` 时保留并量原始文本。
pub fn text(value: &str, label: &str, max_bytes: usize, strip: bool) -> Result<String> {
    if value.trim().is_empty() {
        return err(format!("{label} must not be empty"));
    }
    let bounded = if strip { value.trim().to_owned() } else { value.to_owned() };
    if bounded.len() > max_bytes {
        return err(format!("{label} is too large"));
    }
    Ok(bounded)
}

/// 上游 `compact_json()`：**键排序 + 无空格分隔**。
///
/// 不能直接用 `Value::to_string()`：`serde_json` 的 `Map` 默认虽是 `BTreeMap`，
/// 但 `json!` 宏构造的对象在 `to_string` 时按**插入顺序**输出（实测：
/// `json!({"b":1,"a":2}).to_string()` = `{"b":1,"a":2}`，非键序）。
/// 而上游 `dumps(sort_keys=True)` 是**递归键排序**。所以这里自己递归序列化：
/// 对象按 key 字典序、数组保序、字符串/数字按 JSON 规范输出。
///
/// `ensure_ascii` 上游默认 `true`（非 ASCII 转 `\uXXXX`）。
pub fn compact_json(value: &Value, ensure_ascii: bool) -> String {
    let mut out = String::new();
    write_compact(value, ensure_ascii, &mut out);
    out
}

/// 递归写出紧凑 JSON（对象键字典序 + 无空格）。
fn write_compact(value: &Value, ensure_ascii: bool, out: &mut String) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => out.push_str(&n.to_string()),
        Value::String(s) => write_json_string(s, ensure_ascii, out),
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_compact(item, ensure_ascii, out);
            }
            out.push(']');
        }
        Value::Object(map) => {
            // 键字典序（上游 sort_keys=True）
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort_unstable();
            out.push('{');
            for (i, key) in keys.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_json_string(key, ensure_ascii, out);
                out.push(':');
                if let Some(item) = map.get(*key) {
                    write_compact(item, ensure_ascii, out);
                }
            }
            out.push('}');
        }
    }
}

/// 写一个 JSON 字符串（含引号），按 `ensure_ascii` 决定非 ASCII 的转义形式。
fn write_json_string(input: &str, ensure_ascii: bool, out: &mut String) {
    out.push('"');
    for ch in input.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            // 其余控制字符（0x00-0x1F）必须转义
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c if c.is_ascii() => out.push(c),
            c if ensure_ascii => {
                let mut buf = [0u16; 2];
                for unit in c.encode_utf16(&mut buf) {
                    out.push_str(&format!("\\u{unit:04x}"));
                }
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

/// 上游 `canonical_json()`：`compact_json` + UTF-8 字节上限。
pub fn canonical_json(value: &Value, label: &str, max_bytes: usize, ensure_ascii: bool) -> Result<String> {
    let encoded = compact_json(value, ensure_ascii);
    if encoded.len() > max_bytes {
        return err(format!("{label} is too large"));
    }
    Ok(encoded)
}

/// 上游 `utf8_len()`。
pub fn utf8_len(parts: &[&str]) -> usize {
    parts.iter().map(|part| part.len()).sum()
}

/// 上游 `clock()`：给定时用给定值，`None` 用当前墙钟（float 秒）。
pub fn clock(now: Option<f64>) -> f64 {
    now.unwrap_or_else(|| {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0.0, |d| d.as_secs_f64())
    })
}

/// 上游 `fenced_update()`：CAS UPDATE，**不是恰好一行 = fence 丢失**。
///
/// 返回受影响的错误（调用方自己拼上游的固定文案，保持字节一致）。
pub fn fenced_update(conn: &Connection, sql: &str, params: &[&dyn rusqlite::ToSql]) -> Result<()> {
    let affected = conn
        .execute(sql, params)
        .map_err(|e| FieldError(e.to_string()))?;
    if affected != 1 {
        return err("fence lost");
    }
    Ok(())
}

/// 上游 `table_exists()`。
pub fn table_exists(conn: &Connection, table: &str) -> bool {
    conn.query_row(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1",
        [table],
        |_| Ok(()),
    )
    .is_ok()
}

/// 上游 `table_columns()`：`PRAGMA table_info(<table>)` 的第 2 列。
pub fn table_columns(conn: &Connection, table: &str) -> std::collections::BTreeSet<String> {
    let mut columns = std::collections::BTreeSet::new();
    let sql = format!("PRAGMA table_info({table})");
    let Ok(mut stmt) = conn.prepare(&sql) else {
        return columns;
    };
    let Ok(rows) = stmt.query_map([], |row| row.get::<_, String>(1)) else {
        return columns;
    };
    for name in rows.flatten() {
        columns.insert(name);
    }
    columns
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn identifier_shapes_match_upstream_regex() {
        assert!(is_identifier("room-1"));
        assert!(is_identifier("a"));
        assert!(is_identifier("A.b_c:d-1"));
        // 首字符必须是字母数字
        assert!(!is_identifier("_x"));
        assert!(!is_identifier(".x"));
        assert!(!is_identifier(""));
        // 非法字符
        assert!(!is_identifier("a b"));
        assert!(!is_identifier("a/b"));
        assert!(!is_identifier("房间"));
    }

    #[test]
    fn identifier_strips_and_bounds() {
        assert_eq!(identifier_default("  abc  ", "room_id").unwrap(), "abc");
        assert!(identifier_default("   ", "room_id").is_err());
        // 129 字符超限
        let long = "a".repeat(129);
        assert!(identifier_default(&long, "room_id").is_err());
        assert!(identifier_default(&"a".repeat(128), "room_id").is_ok());
    }

    #[test]
    fn identifier_invalid_message_defaults() {
        let e = identifier_default("bad id", "room_id").unwrap_err();
        assert_eq!(e.0, "invalid room_id");
    }

    #[test]
    fn bounded_int_rejects_out_of_range() {
        assert_eq!(bounded_int(5, 0, Some(10), "bad").unwrap(), 5);
        assert!(bounded_int(-1, 0, None, "must be >= 0").is_err());
        assert_eq!(
            bounded_int(11, 0, Some(10), "too big").unwrap_err().0,
            "too big"
        );
    }

    #[test]
    fn json_i64_rejects_bool_and_float() {
        // 上游显式挡 bool：Python 里 True 是 int 子类
        assert_eq!(json_i64(&json!(true)), None);
        assert_eq!(json_i64(&json!(false)), None);
        // 浮点不算整数
        assert_eq!(json_i64(&json!(1.5)), None);
        assert_eq!(json_i64(&json!(7)), Some(7));
        assert_eq!(json_i64(&json!("7")), None);
    }

    #[test]
    fn exact_fields_reports_sorted_offenders() {
        let value = json!({ "z": 1, "a": 2 });
        let e = exact_fields_default(&value, "room", &["a", "b", "c"], &[]).unwrap_err();
        // missing 按字典序
        assert_eq!(e.0, "room is missing fields: b, c");

        let value = json!({ "a": 1, "zz": 2, "bb": 3 });
        let e = exact_fields_default(&value, "room", &["a"], &[]).unwrap_err();
        assert_eq!(e.0, "room has unknown fields: bb, zz");
    }

    #[test]
    fn exact_fields_accepts_optional() {
        let value = json!({ "a": 1, "opt": 2 });
        assert!(exact_fields_default(&value, "room", &["a"], &["opt"]).is_ok());
    }

    #[test]
    fn exact_fields_not_object() {
        let e = exact_fields_default(&json!([1]), "room", &["a"], &[]).unwrap_err();
        assert_eq!(e.0, "room must be an object");
    }

    #[test]
    fn text_bounds_by_utf8_bytes() {
        assert_eq!(text("  hi  ", "name", 128, true).unwrap(), "hi");
        // strip=false 保留原样
        assert_eq!(text("  hi  ", "name", 128, false).unwrap(), "  hi  ");
        assert!(text("   ", "name", 128, true).is_err());
        // 中文按 3 字节计：4 个字 = 12 字节
        assert!(text("房间名字", "name", 11, true).is_err());
        assert!(text("房间名字", "name", 12, true).is_ok());
    }

    #[test]
    fn compact_json_sorts_keys_and_drops_spaces() {
        let value = json!({ "b": 1, "a": [1, 2] });
        assert_eq!(compact_json(&value, true), r#"{"a":[1,2],"b":1}"#);
    }

    #[test]
    fn compact_json_escapes_non_ascii_like_python() {
        // Python: json.dumps({"a":"房"}, ensure_ascii=True) -> {"a":"\u623f"}
        let value = json!({ "a": "房" });
        assert_eq!(compact_json(&value, true), r#"{"a":"\u623f"}"#);
        // ensure_ascii=false 保留原文
        assert_eq!(compact_json(&value, false), r#"{"a":"房"}"#);
    }

    #[test]
    fn compact_json_escapes_astral_plane_as_surrogate_pair() {
        // U+1F600 -> \ud83d\ude00（Python ensure_ascii 同形）
        let value = json!({ "a": "😀" });
        assert_eq!(compact_json(&value, true), r#"{"a":"\ud83d\ude00"}"#);
    }

    #[test]
    fn canonical_json_enforces_byte_cap() {
        let value = json!({ "a": "房" });
        // ensure_ascii=true 后是 {"a":"\u623f"} = 14 字节
        assert!(canonical_json(&value, "payload", 13, true).is_err());
        assert!(canonical_json(&value, "payload", 14, true).is_ok());
    }

    #[test]
    fn utf8_len_sums_parts() {
        assert_eq!(utf8_len(&["ab", "房"]), 5);
    }

    #[test]
    fn clock_passes_through_or_uses_now() {
        assert_eq!(clock(Some(12.5)), 12.5);
        assert!(clock(None) > 1_700_000_000.0);
    }
}
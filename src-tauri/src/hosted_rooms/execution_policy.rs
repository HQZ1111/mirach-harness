//! 目标下发的执行权限（hermes `gateway/hosted_room_execution_policy.py` 的 Rust 移植）。
//!
//! 上游自述：
//! > Target-issued execution authority for RoomLink member turns.
//!
//! ## 这个模块做什么
//!
//! RoomLink 成员的一次 turn 有一份**由目标方签名**的执行策略（工具集、审批模式、
//! 迭代上限）。策略里带 `policy_digest`，是对「除 digest 之外的字段」的
//! canonical JSON 做 sha256——任何字段被篡改，digest 校验就失败（fail closed）。
//!
//! ## 保真要点
//!
//! - 字段集必须**恰好**是那 6 个
//! - `version` 必须等于 `POLICY_VERSION`
//! - `enabled_toolsets`：1..=128 项、每项是 identifier、**排序后**再算 digest、
//!   不许重复、**必须包含 `"bot_room"`**
//! - `approval_mode`：strip + 小写后必须是 `manual` / `smart` / `off`
//! - `max_iterations`：1..=2^53-1
//! - digest 用小写比对
//! - 算 digest 时 `compact_json` 的 `ensure_ascii` 上游取**默认 True**

use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use super::common;

// ── 常量（上游逐字）────────────────────────────────────────────────────────

pub const POLICY_VERSION: i64 = 1;
pub const MAX_POLICY_TOOLSETS: usize = 128;
/// 上游 `(1 << 53) - 1`：JS 安全整数上界。
pub const MAX_POLICY_ITERATIONS: i64 = (1_i64 << 53) - 1;

/// 策略的精确字段集。
pub const POLICY_FIELDS: &[&str] = &[
    "version",
    "target_profile",
    "enabled_toolsets",
    "approval_mode",
    "max_iterations",
    "policy_digest",
];

/// 成员 turn 必须带的工具集（上游硬编码）。
pub const REQUIRED_TOOLSET: &str = "bot_room";

const APPROVAL_MODES: &[&str] = &["manual", "smart", "off"];

// ── 错误 ────────────────────────────────────────────────────────────────────

/// 上游 `RoomExecutionPolicyError`。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RoomExecutionPolicyError(pub String);

impl std::fmt::Display for RoomExecutionPolicyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for RoomExecutionPolicyError {}

fn fail<T>(message: impl Into<String>) -> Result<T, RoomExecutionPolicyError> {
    Err(RoomExecutionPolicyError(message.into()))
}

pub type PolicyResult<T> = Result<T, RoomExecutionPolicyError>;

// ── 策略 ────────────────────────────────────────────────────────────────────

/// 上游 `RoomExecutionPolicy`：在 agent 与审批边界生效的不可变目标策略。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RoomExecutionPolicy {
    pub version: i64,
    pub target_profile: String,
    /// 已排序、已去重。
    pub enabled_toolsets: Vec<String>,
    pub approval_mode: String,
    pub max_iterations: i64,
    pub policy_digest: String,
}

impl RoomExecutionPolicy {
    /// 上游 `as_mapping()`：转回 6 字段的 JSON。
    pub fn as_mapping(&self) -> Value {
        json!({
            "version": self.version,
            "target_profile": self.target_profile,
            "enabled_toolsets": self.enabled_toolsets,
            "approval_mode": self.approval_mode,
            "max_iterations": self.max_iterations,
            "policy_digest": self.policy_digest,
        })
    }

    /// 上游 `from_mapping()`：严格解析并校验 digest。
    ///
    /// 错误文案逐字对照（共 7 条）：
    /// - `execution policy fields are invalid`
    /// - `execution policy version is unsupported`
    /// - `{field} is invalid`（target_profile / enabled_toolset）
    /// - `enabled_toolsets are invalid`（形状 / 重复 / 缺 bot_room，共 3 处同文案）
    /// - `approval_mode is invalid`
    /// - `max_iterations is invalid`
    /// - `policy_digest does not match the execution policy`
    pub fn from_mapping(value: &Value) -> PolicyResult<Self> {
        let Value::Object(map) = value else {
            return fail("execution policy fields are invalid");
        };
        // 上游 `set(value) != _POLICY_FIELDS`：字段集必须恰好相等
        if map.len() != POLICY_FIELDS.len() || !POLICY_FIELDS.iter().all(|f| map.contains_key(*f)) {
            return fail("execution policy fields are invalid");
        }

        if common::json_i64(&map["version"]) != Some(POLICY_VERSION) {
            return fail("execution policy version is unsupported");
        }

        // 上游 `_identifier`: 先 str(value or "") 再校验，所以 None/非法都报 "is invalid"
        let target_profile = policy_identifier(map.get("target_profile"), "target_profile")?;

        let Value::Array(raw_toolsets) = &map["enabled_toolsets"] else {
            return fail("enabled_toolsets are invalid");
        };
        if raw_toolsets.is_empty() || raw_toolsets.len() > MAX_POLICY_TOOLSETS {
            return fail("enabled_toolsets are invalid");
        }
        let mut toolsets: Vec<String> = Vec::with_capacity(raw_toolsets.len());
        for item in raw_toolsets {
            toolsets.push(policy_identifier(Some(item), "enabled_toolset")?);
        }
        toolsets.sort_unstable();
        // 重复检查（排序后相邻比较）
        if toolsets.windows(2).any(|w| w[0] == w[1]) {
            return fail("enabled_toolsets are invalid");
        }
        if !toolsets.iter().any(|t| t == REQUIRED_TOOLSET) {
            return fail("enabled_toolsets are invalid");
        }

        // 上游 `str(value or "").strip().lower()`
        let approval_mode = raw_string(map.get("approval_mode")).trim().to_lowercase();
        if !APPROVAL_MODES.contains(&approval_mode.as_str()) {
            return fail("approval_mode is invalid");
        }

        let Some(max_iterations) = common::json_i64(&map["max_iterations"]) else {
            return fail("max_iterations is invalid");
        };
        common::bounded_int(
            max_iterations,
            1,
            Some(MAX_POLICY_ITERATIONS),
            "max_iterations is invalid",
        )
        .map_err(|e| RoomExecutionPolicyError(e.0))?;

        // 签名：用「除 digest 外」的字段（工具集已排序）
        let unsigned = json!({
            "version": POLICY_VERSION,
            "target_profile": target_profile,
            "enabled_toolsets": toolsets,
            "approval_mode": approval_mode,
            "max_iterations": max_iterations,
        });
        let expected = policy_digest(&unsigned);

        let supplied = raw_string(map.get("policy_digest")).trim().to_lowercase();
        if supplied != expected {
            return fail("policy_digest does not match the execution policy");
        }

        Ok(Self {
            version: POLICY_VERSION,
            target_profile,
            enabled_toolsets: toolsets,
            approval_mode,
            max_iterations,
            policy_digest: supplied,
        })
    }
}

/// 上游 `_policy_digest()`：canonical JSON（**ensure_ascii 默认 True**）的 sha256 hex。
pub fn policy_digest(unsigned: &Value) -> String {
    let canonical = common::compact_json(unsigned, true);
    let mut hasher = Sha256::new();
    hasher.update(canonical.as_bytes());
    hex_lower(&hasher.finalize())
}

/// 上游 `_identifier()`：先字符串化（`None` → `""`），再走 identifier 校验。
fn policy_identifier(value: Option<&Value>, field: &str) -> PolicyResult<String> {
    let raw = raw_string(value);
    common::identifier(&raw, field, 128, true, Some(&format!("{field} is invalid")))
        .map_err(|e| RoomExecutionPolicyError(e.0))
}

/// 上游 `str(value or "")`：非字符串先尽量转成字符串（None/null → ""）。
fn raw_string(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Bool(b)) => {
            if *b {
                "True".to_owned()
            } else {
                "False".to_owned()
            }
        }
        Some(Value::Number(n)) => n.to_string(),
        Some(other) => other.to_string(),
    }
}

/// 十六进制小写（sha2 的 `GenericArray` 没有内置 hex，手写避免额外依赖）。
fn hex_lower(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}

/// 构造一份合法策略（测试与上层调用用）：自动算好 digest。
pub fn build_policy(
    target_profile: &str,
    toolsets: &[&str],
    approval_mode: &str,
    max_iterations: i64,
) -> Value {
    let mut sorted: Vec<String> = toolsets.iter().map(|s| (*s).to_owned()).collect();
    sorted.sort_unstable();
    let unsigned = json!({
        "version": POLICY_VERSION,
        "target_profile": target_profile,
        "enabled_toolsets": sorted,
        "approval_mode": approval_mode.to_lowercase(),
        "max_iterations": max_iterations,
    });
    let digest = policy_digest(&unsigned);
    let mut map: Map<String, Value> = unsigned.as_object().cloned().unwrap_or_default();
    map.insert("policy_digest".to_owned(), Value::String(digest));
    Value::Object(map)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid() -> Value {
        build_policy("alice", &["bot_room", "read", "bash"], "smart", 10)
    }

    #[test]
    fn accepts_valid_policy_and_sorts_toolsets() {
        let policy = RoomExecutionPolicy::from_mapping(&valid()).unwrap();
        assert_eq!(policy.version, POLICY_VERSION);
        assert_eq!(policy.target_profile, "alice");
        // 排序后：bash < bot_room < read
        assert_eq!(policy.enabled_toolsets, vec!["bash", "bot_room", "read"]);
        assert_eq!(policy.approval_mode, "smart");
        assert_eq!(policy.max_iterations, 10);
    }

    #[test]
    fn as_mapping_round_trips() {
        let original = valid();
        let policy = RoomExecutionPolicy::from_mapping(&original).unwrap();
        let again = policy.as_mapping();
        assert_eq!(RoomExecutionPolicy::from_mapping(&again).unwrap(), policy);
    }

    #[test]
    fn rejects_wrong_field_set() {
        assert_eq!(
            RoomExecutionPolicy::from_mapping(&json!({})).unwrap_err().0,
            "execution policy fields are invalid"
        );
        let mut map = valid().as_object().unwrap().clone();
        map.insert("extra".into(), json!(1));
        assert_eq!(
            RoomExecutionPolicy::from_mapping(&Value::Object(map)).unwrap_err().0,
            "execution policy fields are invalid"
        );
        assert_eq!(
            RoomExecutionPolicy::from_mapping(&json!([1, 2])).unwrap_err().0,
            "execution policy fields are invalid"
        );
    }

    #[test]
    fn rejects_unsupported_version() {
        let mut map = valid().as_object().unwrap().clone();
        map.insert("version".into(), json!(2));
        assert_eq!(
            RoomExecutionPolicy::from_mapping(&Value::Object(map)).unwrap_err().0,
            "execution policy version is unsupported"
        );
    }

    #[test]
    fn rejects_invalid_target_profile() {
        let mut map = valid().as_object().unwrap().clone();
        map.insert("target_profile".into(), json!("bad profile"));
        assert_eq!(
            RoomExecutionPolicy::from_mapping(&Value::Object(map)).unwrap_err().0,
            "target_profile is invalid"
        );
    }

    #[test]
    fn rejects_toolsets_missing_bot_room() {
        let mut map = valid().as_object().unwrap().clone();
        let unsigned = json!({
            "version": 1, "target_profile": "alice",
            "enabled_toolsets": ["read"], "approval_mode": "smart", "max_iterations": 10
        });
        map.insert("enabled_toolsets".into(), json!(["read"]));
        map.insert("policy_digest".into(), json!(policy_digest(&unsigned)));
        assert_eq!(
            RoomExecutionPolicy::from_mapping(&Value::Object(map)).unwrap_err().0,
            "enabled_toolsets are invalid"
        );
    }

    #[test]
    fn rejects_duplicate_toolsets() {
        let mut map = valid().as_object().unwrap().clone();
        map.insert("enabled_toolsets".into(), json!(["bot_room", "bot_room"]));
        assert_eq!(
            RoomExecutionPolicy::from_mapping(&Value::Object(map)).unwrap_err().0,
            "enabled_toolsets are invalid"
        );
    }

    #[test]
    fn rejects_empty_and_oversized_toolsets() {
        let map = valid().as_object().unwrap().clone();
        let mut empty = map.clone();
        empty.insert("enabled_toolsets".into(), json!([]));
        assert!(RoomExecutionPolicy::from_mapping(&Value::Object(empty)).is_err());

        let too_many: Vec<String> = (0..=MAX_POLICY_TOOLSETS)
            .map(|i| format!("tool{i}"))
            .chain(std::iter::once(REQUIRED_TOOLSET.to_owned()))
            .collect();
        let mut big = map;
        big.insert("enabled_toolsets".into(), json!(too_many));
        assert_eq!(
            RoomExecutionPolicy::from_mapping(&Value::Object(big)).unwrap_err().0,
            "enabled_toolsets are invalid"
        );
    }

    #[test]
    fn rejects_invalid_approval_mode() {
        let mut map = valid().as_object().unwrap().clone();
        map.insert("approval_mode".into(), json!("yolo"));
        assert_eq!(
            RoomExecutionPolicy::from_mapping(&Value::Object(map)).unwrap_err().0,
            "approval_mode is invalid"
        );
    }

    #[test]
    fn approval_mode_is_trimmed_and_lowercased() {
        let mut map = valid().as_object().unwrap().clone();
        map.insert("approval_mode".into(), json!("  SMART  "));
        // 小写化后才算 digest，所以合法值应能过
        let policy = RoomExecutionPolicy::from_mapping(&Value::Object(map.clone())).unwrap();
        assert_eq!(policy.approval_mode, "smart");

        // 但 digest 是按小写算的，所以 raw 大小写不同不影响
        let mut bad = map;
        bad.insert("policy_digest".into(), json!("0".repeat(64)));
        assert_eq!(
            RoomExecutionPolicy::from_mapping(&Value::Object(bad)).unwrap_err().0,
            "policy_digest does not match the execution policy"
        );
    }

    #[test]
    fn rejects_out_of_range_max_iterations() {
        for bad in [0, -1, MAX_POLICY_ITERATIONS + 1] {
            let mut map = valid().as_object().unwrap().clone();
            map.insert("max_iterations".into(), json!(bad));
            assert_eq!(
                RoomExecutionPolicy::from_mapping(&Value::Object(map)).unwrap_err().0,
                "max_iterations is invalid"
            );
        }
        // 上界本身合法（用 build_policy 生成，digest 按实现同一套排序口径算）
        let at_bound = build_policy("alice", &["bot_room", "read"], "smart", MAX_POLICY_ITERATIONS);
        assert!(RoomExecutionPolicy::from_mapping(&at_bound).is_ok());
    }

    #[test]
    fn rejects_tampered_digest() {
        let mut map = valid().as_object().unwrap().clone();
        map.insert("policy_digest".into(), json!("0".repeat(64)));
        assert_eq!(
            RoomExecutionPolicy::from_mapping(&Value::Object(map)).unwrap_err().0,
            "policy_digest does not match the execution policy"
        );
    }

    #[test]
    fn digest_matches_python_sha256_shape() {
        // 已知向量：{"a":1} 的 canonical JSON 是 {"a":1}
        let digest = policy_digest(&json!({ "a": 1 }));
        assert_eq!(digest.len(), 64);
        assert!(digest.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
        // 与 Python 对拍：sha256(b'{"a":1}').hexdigest()
        assert_eq!(
            digest,
            "015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862"
        );
    }

    #[test]
    fn digest_uses_ensure_ascii() {
        // 非 ASCII 想按 \uXXXX 转义后算，与 Python 默认行为一致
        let ascii = policy_digest(&json!({ "a": "房" }));
        // b'{"a":"\\u623f"}'
        let mut hasher = Sha256::new();
        hasher.update(br#"{"a":"\u623f"}"#);
        assert_eq!(ascii, hex_lower(&hasher.finalize()));
    }
}
//! 房间工作证据（hermes `gateway/hosted_room_work_records.py` 的 Rust 移植）。
//!
//! 上游自述：
//! > **Bounded room-scoped evidence, never executable driver state or authority.**
//!
//! 这是本模块最重要的语义：工作记录是**证据**，不是可执行状态、也不是权限。
//! 它记录「房间里发生过什么」供对账/审计，**绝不能**被当成驱动依据。
//!
//! ## 关键约束
//!
//! - `LIMITATIONS` 必须**逐字**等于上游那 5 条——它们是诚实的边界声明：
//!   进程内审批没记、字段日志没记、外部副作用没记、**「记录缺席 ≠ 未准入」**、
//!   **不是执行检查点**。
//! - `digest` 是「除 revision 与 digest 本身之外所有字段」的 canonical JSON
//!   sha256——任何篡改都会被发现。
//! - `availability == "unavailable"` 时 tasks/receipts **必须为空**
//!   （「unavailable 的记录不得看起来完整」）。
//! - v1 / v2 两个 schema 版本并存（v2 多 `lineage_sha256` + `incompleteness`）。
//!
//! ## 移植边界
//!
//! ✅ 本文件：常量、`encode` / `digest`（**ensure_ascii=false**，与上游
//!   `allow_nan=False` 语义）、完整 `validate()` 与全部子校验。
//! ⏳ 未移植（依赖 SQL 存储层与 driver 表遍历）：`initialize` / `capture*` /
//!   `history_anchor` / `prepare_delivery*` / `acknowledge*` / `roster_digest`。

use serde_json::{Map, Value};

use super::common;

// ── 常量（上游逐字）────────────────────────────────────────────────────────

pub const VERSION: i64 = 1;
pub const PERMISSION: &str = "work_records";
pub const MAX_TASKS: usize = 128;
pub const MAX_RECEIPTS: usize = 256;
pub const MAX_BYTES: usize = 128 * 1024;
pub const MAX_STORE_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_STORE_ROWS: usize = 512;

pub const SOURCE_TABLE: &str = "hosted_room_work_records_source";
pub const TARGET_TABLE: &str = "hosted_room_work_records_target";
pub const PENDING_TABLE: &str = "hosted_room_work_records_pending";

/// 会让投递被视为「被挡住」的状态。
pub const BLOCKED_DELIVERY_STATUSES: &[&str] = &[
    "rejected",
    "needs_reauthorization",
    "invalid_ack",
    "unsupported_lineage",
    "invalid_work_evidence",
];

/// 上游 `LIMITATIONS`：**必须逐字**，它是这份证据的诚实边界声明。
pub const LIMITATIONS: &[&str] = &[
    "process_local_approvals_not_captured",
    "field_journals_not_captured",
    "external_effects_not_captured",
    "absent_record_is_not_non_admission",
    "not_execution_checkpoint",
];

/// 允许的任务阶段（= driver 的 8 态）。
const PHASES: &[&str] = &[
    "queued",
    "running",
    "indeterminate",
    "stopping",
    "deferred",
    "settled",
    "failed",
    "cancelled",
];

const TASK_FIELDS: &[&str] = &[
    "task_id",
    "thread_id",
    "turn_id",
    "source_event_seq",
    "payload_sha256",
    "member_id",
    "profile",
    "execution_generation",
    "cancel_generation",
    "phase",
    "settlement_id",
    "cancel_id",
];

const RECEIPT_FIELDS: &[&str] = &[
    "room_id",
    "home_install_id",
    "authority_gateway_id",
    "authority_epoch",
    "member_id",
    "target_install_id",
    "target_profile",
    "task_id",
    "execution_generation",
    "run_id",
    "session_id",
];

const FIELDS: &[&str] = &[
    "version",
    "room_id",
    "home_install_id",
    "authority",
    "roster_sha256",
    "history",
    "revision",
    "digest",
    "availability",
    "reason",
    "tasks",
    "receipts",
    "stop",
    "limitations",
];

/// v2 额外字段。
const FIELDS_V2_EXTRA: &[&str] = &["lineage_sha256", "incompleteness"];

// ── 错误 ────────────────────────────────────────────────────────────────────

/// 上游 `WorkRecordError` 家族（用 message 区分，语义由调用点判断）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkRecordError(pub String);

impl std::fmt::Display for WorkRecordError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for WorkRecordError {}

fn fail<T>(message: impl Into<String>) -> Result<T, WorkRecordError> {
    Err(WorkRecordError(message.into()))
}

pub type RecordResult<T> = Result<T, WorkRecordError>;

// ── 编码与摘要 ──────────────────────────────────────────────────────────────

/// 上游 `encode()`：`sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False`。
///
/// 注意与 `common::compact_json` 的差别：这里 **ensure_ascii=false**（保留原文，
/// 不转 `\uXXXX`），因为它是给 digest 用的内部表示，不跨语言比对。
pub fn encode(value: &Value) -> RecordResult<String> {
    // 上游 allow_nan=False：JSON 里出现 NaN/Infinity 会抛。serde_json 的
    // Number 不含 NaN（构造时就拒绝），但显式检查浮点以对齐语义。
    ensure_no_nan(value)?;
    Ok(common::compact_json(value, false))
}

/// 递归检查有无 NaN/Infinity（上游 `allow_nan=False`）。
fn ensure_no_nan(value: &Value) -> RecordResult<()> {
    match value {
        Value::Number(n) => {
            if let Some(f) = n.as_f64() {
                if !f.is_finite() {
                    return fail("work record contains a non-finite number");
                }
            }
            Ok(())
        }
        Value::Array(items) => {
            for item in items {
                ensure_no_nan(item)?;
            }
            Ok(())
        }
        Value::Object(map) => {
            for item in map.values() {
                ensure_no_nan(item)?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

/// 上游 `digest()`：`encode` 后取 sha256 hex。
pub fn digest(value: &Value) -> RecordResult<String> {
    let encoded = encode(value)?;
    Ok(super::driver::payload_digest_str(&encoded))
}

// ── 子校验 ──────────────────────────────────────────────────────────────────

/// 上游 `_fields()`：字段集必须**恰好**相等。
fn fields(value: Option<&Value>, expected: &[&str], message: &str) -> RecordResult<()> {
    let Some(Value::Object(map)) = value else {
        return fail(message);
    };
    if map.len() != expected.len() || !expected.iter().all(|f| map.contains_key(*f)) {
        return fail(message);
    }
    Ok(())
}

/// 上游 `_integer()`：必须是非 bool 整数且落在 `[minimum, 2^63)`。
fn integer(value: Option<&Value>, minimum: i64) -> RecordResult<i64> {
    // json_i64 已拒绝 bool 与浮点（对齐上游 `type(value) is not int`）
    let Some(n) = value.and_then(common::json_i64) else {
        return fail("work record integer is invalid");
    };
    if n < minimum || n >= i64::MAX {
        return fail("work record integer is invalid");
    }
    Ok(n)
}

/// 上游 `_id()`：必须过 identifier 校验**且**已规范（strip 后不变）。
fn id(value: Option<&Value>) -> RecordResult<String> {
    let Some(s) = value.and_then(Value::as_str) else {
        return fail("work record identity is invalid");
    };
    let validated = common::identifier(s, "record identity", 256, true, None)
        .map_err(|e| WorkRecordError(e.0))?;
    if validated != s {
        return fail("work record identity is not canonical");
    }
    Ok(validated)
}

/// 上游 `_sha()`：必须是小写 64 位十六进制。
fn sha(value: Option<&Value>) -> RecordResult<String> {
    let Some(s) = value.and_then(Value::as_str) else {
        return fail("work record digest is invalid");
    };
    if s.len() != 64 || !s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
        return fail("work record digest is invalid");
    }
    Ok(s.to_owned())
}

/// 上游 `_validate_tasks()`。
fn validate_tasks(record: &Value, tasks: &Value) -> RecordResult<()> {
    let tasks = tasks
        .as_array()
        .ok_or_else(|| WorkRecordError("work record list exceeds its bound".into()))?;
    let history_seq = integer(record.get("history").and_then(|h| h.get("seq")), 0)?;

    let mut task_ids = std::collections::BTreeSet::new();
    for task in tasks {
        fields(
            Some(task),
            TASK_FIELDS,
            "work record fields are invalid",
        )?;
        for name in ["task_id", "thread_id", "turn_id", "member_id", "profile"] {
            id(task.get(name))?;
        }
        for name in ["settlement_id", "cancel_id"] {
            if let Some(value) = task.get(name) {
                if !value.is_null() {
                    id(Some(value))?;
                }
            }
        }
        integer(task.get("execution_generation"), 0)?;
        integer(task.get("cancel_generation"), 0)?;
        integer(task.get("source_event_seq"), 1)?;
        sha(task.get("payload_sha256"))?;

        let source_seq = integer(task.get("source_event_seq"), 1)?;
        let phase = task.get("phase").and_then(Value::as_str).unwrap_or("");
        let task_id = task.get("task_id").and_then(Value::as_str).unwrap_or("");

        // 上游：source_event_seq 不能超出 history.seq；phase 必须合法；task_id 不能重复
        if source_seq > history_seq || !PHASES.contains(&phase) || !task_ids.insert(task_id.to_owned()) {
            return fail("work record task conflicts");
        }
    }
    Ok(())
}

/// 上游 `_validate_receipts()`。
fn validate_receipts(record: &Value, receipts: &Value, v2: bool) -> RecordResult<()> {
    let receipts = receipts
        .as_array()
        .ok_or_else(|| WorkRecordError("work record list exceeds its bound".into()))?;
    let room_id = record.get("room_id").and_then(Value::as_str).unwrap_or("");
    let home_install_id = record.get("home_install_id").and_then(Value::as_str).unwrap_or("");

    // 上游用「按字段名排序后的除 run_id/session_id 外全部字段」作为唯一键
    let key_fields: Vec<&str> = {
        let mut fs: Vec<&str> = RECEIPT_FIELDS
            .iter()
            .copied()
            .filter(|f| *f != "run_id" && *f != "session_id")
            .collect();
        fs.sort_unstable();
        fs
    };

    let mut seen = std::collections::BTreeSet::new();
    for receipt in receipts {
        fields(
            Some(receipt),
            RECEIPT_FIELDS,
            "work record fields are invalid",
        )?;
        for name in RECEIPT_FIELDS {
            if *name == "authority_epoch" || *name == "execution_generation" {
                continue;
            }
            id(receipt.get(name))?;
        }
        integer(receipt.get("execution_generation"), 1)?;
        integer(receipt.get("authority_epoch"), 1)?;

        let receipt_room = receipt.get("room_id").and_then(Value::as_str).unwrap_or("");
        let authority_gateway = receipt
            .get("authority_gateway_id")
            .and_then(Value::as_str)
            .unwrap_or("");
        let receipt_home = receipt
            .get("home_install_id")
            .and_then(Value::as_str)
            .unwrap_or("");
        let epoch = integer(receipt.get("authority_epoch"), 1)?;

        if receipt_room != room_id
            || authority_gateway != receipt_home
            || (!v2 && (receipt_home != home_install_id || epoch != 1))
        {
            return fail("work record receipt lineage conflicts");
        }

        // 唯一键
        let key: Vec<String> = key_fields
            .iter()
            .map(|f| {
                receipt
                    .get(*f)
                    .map(|v| v.to_string())
                    .unwrap_or_else(|| "null".to_owned())
            })
            .collect();
        if !seen.insert(key.join("\u{0}")) {
            return fail("work record receipt is duplicated");
        }
    }
    Ok(())
}

/// 上游 `_validate_stop()`。
fn validate_stop(record: &Value) -> RecordResult<()> {
    let stop = record.get("stop");
    fields(
        stop,
        &["closing", "revocation_complete", "seq", "cancel_id"],
        "work record fields are invalid",
    )?;
    let stop = stop.unwrap();

    for key in ["closing", "revocation_complete"] {
        // 上游 `type(x) is not bool`
        if !matches!(stop.get(key), Some(Value::Bool(_))) {
            return fail("work record closing fact is invalid");
        }
    }
    let seq = integer(stop.get("seq"), 0)?;
    let history_seq = integer(record.get("history").and_then(|h| h.get("seq")), 0)?;
    if seq > history_seq {
        return fail("work record stop is beyond its prefix");
    }
    if let Some(cancel_id) = stop.get("cancel_id") {
        if !cancel_id.is_null() {
            id(Some(cancel_id))?;
        }
    }
    Ok(())
}

/// 上游 `_validate_availability()`。
fn validate_availability(record: &Value) -> RecordResult<()> {
    let availability = record.get("availability").and_then(Value::as_str).unwrap_or("");
    if availability != "available" && availability != "unavailable" {
        return fail("work record availability is invalid");
    }

    let reason = record.get("reason");
    let reason_ok = match reason {
        Some(Value::Null) | None => true,
        Some(Value::String(s)) => {
            matches!(
                s.as_str(),
                "task_store_missing" | "unsupported_task" | "bounds_exceeded"
            )
        }
        _ => false,
    };
    if !reason_ok {
        return fail("work record availability is invalid");
    }

    // 上游：(availability == "available") != (reason is None) → 冲突
    let is_available = availability == "available";
    let reason_is_none = matches!(reason, Some(Value::Null) | None);
    if is_available != reason_is_none {
        return fail("work record availability conflicts");
    }

    let tasks = record.get("tasks");
    let receipts = record.get("receipts");
    let tasks_len = tasks.and_then(Value::as_array).map(Vec::len);
    let receipts_len = receipts.and_then(Value::as_array).map(Vec::len);
    let (Some(tasks_len), Some(receipts_len)) = (tasks_len, receipts_len) else {
        return fail("work record list exceeds its bound");
    };
    if tasks_len > MAX_TASKS || receipts_len > MAX_RECEIPTS {
        return fail("work record list exceeds its bound");
    }

    // 上游：unavailable 时不得带 tasks/receipts
    if !is_available && (tasks_len > 0 || receipts_len > 0) {
        return fail("unavailable work record must not appear complete");
    }
    Ok(())
}

// ── 主校验 ──────────────────────────────────────────────────────────────────

/// 上游 `validate()`：完整校验一份工作记录。
///
/// v2 检测：`version == 2` 时字段集多 `lineage_sha256` + `incompleteness`。
pub fn validate(record: &Value) -> RecordResult<()> {
    let v2 = record.get("version").and_then(common::json_i64) == Some(2);

    let expected: Vec<&str> = if v2 {
        FIELDS
            .iter()
            .copied()
            .chain(FIELDS_V2_EXTRA.iter().copied())
            .collect()
    } else {
        FIELDS.to_vec()
    };
    fields(Some(record), &expected, "work record fields are invalid")?;

    let version = record
        .get("version")
        .and_then(common::json_i64)
        .ok_or_else(|| WorkRecordError("work record version is unsupported".into()))?;
    if version != 1 && version != 2 {
        return fail("work record version is unsupported");
    }

    id(record.get("room_id"))?;
    id(record.get("home_install_id"))?;

    let authority = record.get("authority");
    fields(
        authority,
        &["gateway_id", "epoch"],
        "work record fields are invalid",
    )?;
    let authority = authority.unwrap();
    let epoch = integer(authority.get("epoch"), 1)?;
    let authority_gateway = authority.get("gateway_id").and_then(Value::as_str).unwrap_or("");
    let home_install_id = record.get("home_install_id").and_then(Value::as_str).unwrap_or("");
    if authority_gateway != home_install_id || (!v2 && epoch != 1) {
        return fail("work record authority is unsupported");
    }

    if v2 {
        sha(record.get("lineage_sha256"))?;
        // 上游：incompleteness 必须恰好是 ["prior_authority_work_unknown"]
        let incompleteness = record.get("incompleteness");
        let expected_incompleteness = Value::Array(vec![Value::String(
            "prior_authority_work_unknown".to_owned(),
        )]);
        if incompleteness != Some(&expected_incompleteness) {
            return fail("work record incompleteness is required");
        }
    }

    sha(record.get("roster_sha256"))?;
    integer(record.get("revision"), 1)?;

    let history = record.get("history");
    fields(
        history,
        &["seq", "event_sha256"],
        "work record fields are invalid",
    )?;
    let history = history.unwrap();
    integer(history.get("seq"), 0)?;
    sha(history.get("event_sha256"))?;

    // limitations 必须逐字等于上游那 5 条
    let limitations = record.get("limitations");
    let expected_limitations = Value::Array(
        LIMITATIONS
            .iter()
            .map(|s| Value::String((*s).to_owned()))
            .collect(),
    );
    if limitations != Some(&expected_limitations) {
        return fail("work record limitations are required");
    }

    validate_availability(record)?;
    validate_tasks(record, record.get("tasks").unwrap_or(&Value::Null))?;
    validate_receipts(record, record.get("receipts").unwrap_or(&Value::Null), v2)?;
    validate_stop(record)?;

    let supplied_digest = sha(record.get("digest"))?;

    // 上游：digest 是「除 revision 与 digest 外」所有字段的 sha256
    let Value::Object(map) = record else {
        return fail("work record fields are invalid");
    };
    let mut unsigned: Map<String, Value> = Map::new();
    for (key, value) in map {
        if key == "revision" || key == "digest" {
            continue;
        }
        unsigned.insert(key.clone(), value.clone());
    }
    let expected_digest = digest(&Value::Object(unsigned))?;
    if supplied_digest != expected_digest {
        return fail("work record content digest conflicts");
    }

    // 字节上限
    if encode(record)?.len() > MAX_BYTES {
        return fail("work record exceeds its byte bound");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// 造一份合法的 v1 记录。
    ///
    /// digest = sha256(除 `revision` 与 `digest` 外全部字段的 canonical JSON)
    /// ——与实现同一口径（上游 `digest({k: v for k, v in record.items() if k not in
    /// {"revision", "digest"}})`）。
    fn valid_record() -> Value {
        let mut record = json!({
            "version": 1,
            "room_id": "room-1",
            "home_install_id": "install-1",
            "authority": { "gateway_id": "install-1", "epoch": 1 },
            "roster_sha256": "a".repeat(64),
            "history": { "seq": 5, "event_sha256": "b".repeat(64) },
            "revision": 1,
            "availability": "available",
            "reason": null,
            "tasks": [],
            "receipts": [],
            "stop": { "closing": false, "revocation_complete": false, "seq": 0, "cancel_id": null },
            "limitations": LIMITATIONS,
            "digest": "0".repeat(64),
        });
        record["digest"] = json!(content_digest(&record));
        record
    }

    /// 与实现同一口径的内容摘要：排除 `revision` 与 `digest`。
    fn content_digest(record: &Value) -> String {
        let Value::Object(map) = record else {
            panic!("not an object")
        };
        let mut unsigned = Map::new();
        for (key, value) in map {
            if key == "revision" || key == "digest" {
                continue;
            }
            unsigned.insert(key.clone(), value.clone());
        }
        digest(&Value::Object(unsigned)).unwrap()
    }

    #[test]
    fn accepts_valid_record() {
        validate(&valid_record()).unwrap();
    }

    #[test]
    fn rejects_wrong_field_set() {
        let mut record = valid_record();
        record["extra"] = json!(1);
        assert_eq!(
            validate(&record).unwrap_err().0,
            "work record fields are invalid"
        );
    }

    #[test]
    fn rejects_unsupported_version() {
        let mut record = valid_record();
        record["version"] = json!(3);
        // v2 检测不命中（version != 2），所以字段集按 v1 校对——字段集本身合法，
        // 因此落到版本检查上。
        assert_eq!(
            validate(&record).unwrap_err().0,
            "work record version is unsupported"
        );
    }

    #[test]
    fn rejects_authority_mismatch() {
        let mut record = valid_record();
        record["authority"]["gateway_id"] = json!("other");
        assert_eq!(
            validate(&record).unwrap_err().0,
            "work record authority is unsupported"
        );
    }

    #[test]
    fn rejects_missing_limitations() {
        let mut record = valid_record();
        record["limitations"] = json!(["something_else"]);
        assert_eq!(
            validate(&record).unwrap_err().0,
            "work record limitations are required"
        );
    }

    #[test]
    fn limitations_are_exactly_the_upstream_five() {
        assert_eq!(LIMITATIONS.len(), 5);
        assert!(LIMITATIONS.contains(&"absent_record_is_not_non_admission"));
        assert!(LIMITATIONS.contains(&"not_execution_checkpoint"));
    }

    #[test]
    fn rejects_tampered_digest() {
        let mut record = valid_record();
        record["digest"] = json!("c".repeat(64));
        assert_eq!(
            validate(&record).unwrap_err().0,
            "work record content digest conflicts"
        );
    }

    #[test]
    fn digest_excludes_revision_and_digest() {
        let mut a = valid_record();
        let mut b = valid_record();
        // 只改 revision：digest 不变，所以两份都该合法
        b["revision"] = json!(2);
        validate(&a).unwrap();
        validate(&b).unwrap();

        // digest 本身必须一致（因为 revision 不参与）
        assert_eq!(a["digest"], b["digest"]);
        // 但改别的字段就会冲突
        a["room_id"] = json!("room-2");
        assert!(validate(&a).is_err());
    }

    #[test]
    fn rejects_unavailable_with_tasks() {
        let mut record = valid_record();
        record["availability"] = json!("unavailable");
        record["reason"] = json!("bounds_exceeded");
        record["tasks"] = json!([{
            "task_id": "t1", "thread_id": "th", "turn_id": "tu",
            "source_event_seq": 1, "payload_sha256": "d".repeat(64),
            "member_id": "m1", "profile": "alice",
            "execution_generation": 0, "cancel_generation": 0,
            "phase": "queued", "settlement_id": null, "cancel_id": null
        }]);
        assert_eq!(
            validate(&record).unwrap_err().0,
            "unavailable work record must not appear complete"
        );
    }

    #[test]
    fn rejects_availability_reason_conflict() {
        let mut record = valid_record();
        record["reason"] = json!("bounds_exceeded");
        assert_eq!(
            validate(&record).unwrap_err().0,
            "work record availability conflicts"
        );
    }

    #[test]
    fn validates_task_phase_and_seq_bounds() {
        let mut record = valid_record();
        let task = json!({
            "task_id": "t1", "thread_id": "th", "turn_id": "tu",
            "source_event_seq": 9, // history.seq = 5 → 越界
            "payload_sha256": "d".repeat(64),
            "member_id": "m1", "profile": "alice",
            "execution_generation": 1, "cancel_generation": 0,
            "phase": "running", "settlement_id": null, "cancel_id": null
        });
        record["tasks"] = json!([task]);
        assert_eq!(validate(&record).unwrap_err().0, "work record task conflicts");
    }

    #[test]
    fn rejects_duplicate_task_ids() {
        let mut record = valid_record();
        let task = json!({
            "task_id": "t1", "thread_id": "th", "turn_id": "tu",
            "source_event_seq": 1, "payload_sha256": "d".repeat(64),
            "member_id": "m1", "profile": "alice",
            "execution_generation": 1, "cancel_generation": 0,
            "phase": "running", "settlement_id": null, "cancel_id": null
        });
        record["tasks"] = json!([task.clone(), task]);
        assert_eq!(validate(&record).unwrap_err().0, "work record task conflicts");
    }

    #[test]
    fn rejects_bad_phase() {
        let mut record = valid_record();
        record["tasks"] = json!([{
            "task_id": "t1", "thread_id": "th", "turn_id": "tu",
            "source_event_seq": 1, "payload_sha256": "d".repeat(64),
            "member_id": "m1", "profile": "alice",
            "execution_generation": 1, "cancel_generation": 0,
            "phase": "exploded", "settlement_id": null, "cancel_id": null
        }]);
        assert_eq!(validate(&record).unwrap_err().0, "work record task conflicts");
    }

    #[test]
    fn rejects_stop_beyond_prefix() {
        let mut record = valid_record();
        record["stop"]["seq"] = json!(99);
        assert_eq!(
            validate(&record).unwrap_err().0,
            "work record stop is beyond its prefix"
        );
    }

    #[test]
    fn rejects_non_bool_closing_fact() {
        let mut record = valid_record();
        record["stop"]["closing"] = json!(1);
        assert_eq!(
            validate(&record).unwrap_err().0,
            "work record closing fact is invalid"
        );
    }

    #[test]
    fn rejects_integer_forms_python_rejects() {
        // bool 与浮点都不是整数（上游 type(x) is not int）
        let mut record = valid_record();
        record["revision"] = json!(true);
        assert_eq!(
            validate(&record).unwrap_err().0,
            "work record integer is invalid"
        );

        let mut record = valid_record();
        record["revision"] = json!(1.5);
        assert_eq!(
            validate(&record).unwrap_err().0,
            "work record integer is invalid"
        );
    }

    #[test]
    fn rejects_non_canonical_identity() {
        let mut record = valid_record();
        record["room_id"] = json!("  room-1  "); // strip 后变化 → 非规范
        assert_eq!(
            validate(&record).unwrap_err().0,
            "work record identity is not canonical"
        );
    }

    #[test]
    fn rejects_bad_sha_shape() {
        let mut record = valid_record();
        record["roster_sha256"] = json!("A".repeat(64)); // 大写不接受
        assert_eq!(
            validate(&record).unwrap_err().0,
            "work record digest is invalid"
        );

        let mut record = valid_record();
        record["roster_sha256"] = json!("a".repeat(63));
        assert_eq!(
            validate(&record).unwrap_err().0,
            "work record digest is invalid"
        );
    }

    #[test]
    fn encode_is_ensure_ascii_false() {
        // 与 common::compact_json(ensure_ascii=true) 不同：保留原文
        let value = json!({"a": "房"});
        assert_eq!(encode(&value).unwrap(), r#"{"a":"房"}"#);
        // 键排序仍然有
        assert_eq!(encode(&json!({"b":1,"a":2})).unwrap(), r#"{"a":2,"b":1}"#);
    }

    #[test]
    fn v2_requires_lineage_and_incompleteness() {
        let mut record = valid_record();
        record["version"] = json!(2);
        record["lineage_sha256"] = json!("e".repeat(64));
        record["incompleteness"] = json!(["prior_authority_work_unknown"]);
        // 重算 digest
        let mut unsigned = record.clone();
        unsigned.as_object_mut().unwrap().remove("digest");
        unsigned.as_object_mut().unwrap().remove("revision");
        record["digest"] = json!(digest(&unsigned).unwrap());
        validate(&record).unwrap();

        // 去掉 incompleteness → 报错
        let mut bad = record.clone();
        bad.as_object_mut().unwrap().remove("incompleteness");
        assert_eq!(
            validate(&bad).unwrap_err().0,
            "work record fields are invalid"
        );
    }
}
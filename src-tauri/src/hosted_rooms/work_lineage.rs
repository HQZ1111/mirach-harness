//! 工作证据的血缘校验（hermes `gateway/hosted_room_work_lineage.py`）。
//!
//! 上游自述：
//! > **Validate passive evidence against committed authority spans, never elect
//! > an owner.**
//!
//! 职责：拿一份 work record，用「已提交的归属区间」（`authority_history` 的
//! span 链）去核对——每个任务的 `source_event_seq`、每个回执的归属，都必须
//! 落在链上某个真实 span 里。**它只核对，从不选举/认定谁该当主人。**
//!
//! ## 三条校验
//!
//! 1. `validate_provenance`：任务的 source_event_seq 必须在链上可定位；
//!    回执必须有一条 span 同时满足 `gateway == home_install == authority_gateway`
//!    且 `epoch` 相同。
//! 2. `task_origins`：每个任务 id → 它产生时的 `{gateway_id, epoch}`。
//! 3. `source_prefix_locked`（需要 SQL 连接）→ 见下，属存储层，未移植。

use serde_json::Value;

use super::authority_history::{at_sequence, AuthorityHistoryError, AuthoritySpan};
use super::work_records::WorkRecordError;

/// 上游 `validate_provenance()`：把证据对到归属区间上。
///
/// 注意上游注释：**execution generation 仍是每任务独立的计数器**，不参与
/// 归属链判断（它只证明"第几次尝试"，不证明"谁有权"）。
pub fn validate_provenance(record: &Value, spans: &[AuthoritySpan]) -> Result<(), WorkRecordError> {
    let tasks = record
        .get("tasks")
        .and_then(Value::as_array)
        .ok_or_else(|| WorkRecordError("work record fields are invalid".into()))?;

    // 每个任务的 source_event_seq 必须能在链上定位
    for task in tasks {
        let Some(seq) = task.get("source_event_seq").and_then(super::common::json_i64) else {
            return Err(WorkRecordError("work record integer is invalid".into()));
        };
        at_sequence(spans, seq).map_err(|e| WorkRecordError(e.0))?;
    }

    let receipts = record
        .get("receipts")
        .and_then(Value::as_array)
        .ok_or_else(|| WorkRecordError("work record fields are invalid".into()))?;

    // 每个回执必须有一条 span 在「原归属」上
    for receipt in receipts {
        let home_install = receipt.get("home_install_id").and_then(Value::as_str).unwrap_or("");
        let authority_gateway = receipt
            .get("authority_gateway_id")
            .and_then(Value::as_str)
            .unwrap_or("");
        let epoch = receipt
            .get("authority_epoch")
            .and_then(super::common::json_i64)
            .unwrap_or(-1);

        let found = spans.iter().any(|span| {
            span.gateway_id == home_install
                && home_install == authority_gateway
                && span.epoch == epoch
        });
        if !found {
            return Err(WorkRecordError(
                "work record receipt has no original authority span".into(),
            ));
        }
    }
    Ok(())
}

/// 上游 `task_origins()`：任务 id → 它产生时的归属。
///
/// 返回 `BTreeMap<task_id, (gateway_id, epoch)>`（上游是 dict，顺序无关）。
pub fn task_origins(
    record: &Value,
    spans: &[AuthoritySpan],
) -> Result<std::collections::BTreeMap<String, (String, i64)>, WorkRecordError> {
    let tasks = record
        .get("tasks")
        .and_then(Value::as_array)
        .ok_or_else(|| WorkRecordError("work record fields are invalid".into()))?;

    let mut origins = std::collections::BTreeMap::new();
    for task in tasks {
        let Some(task_id) = task.get("task_id").and_then(Value::as_str) else {
            return Err(WorkRecordError("work record identity is invalid".into()));
        };
        let Some(seq) = task.get("source_event_seq").and_then(super::common::json_i64) else {
            return Err(WorkRecordError("work record integer is invalid".into()));
        };
        let span = at_sequence(spans, seq).map_err(|e| WorkRecordError(e.0))?;
        origins.insert(task_id.to_owned(), (span.gateway_id.clone(), span.epoch));
    }
    Ok(origins)
}

/// 把 `AuthorityHistoryError` 转成 `WorkRecordError`（上游用两种异常类，语义不同）。
pub fn history_error_to_record(err: AuthorityHistoryError) -> WorkRecordError {
    WorkRecordError(err.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn spans() -> Vec<AuthoritySpan> {
        vec![
            AuthoritySpan {
                gateway_id: "install-1".to_owned(),
                epoch: 1,
                from_seq: 0,
            },
            AuthoritySpan {
                gateway_id: "install-2".to_owned(),
                epoch: 2,
                from_seq: 10,
            },
        ]
    }

    fn record_with(tasks: Value, receipts: Value) -> Value {
        json!({ "tasks": tasks, "receipts": receipts })
    }

    fn task(id: &str, seq: i64) -> Value {
        json!({ "task_id": id, "source_event_seq": seq })
    }

    fn receipt(home: &str, gateway: &str, epoch: i64) -> Value {
        json!({
            "home_install_id": home,
            "authority_gateway_id": gateway,
            "authority_epoch": epoch,
        })
    }

    // ── validate_provenance ───────────────────────────────────────────────

    #[test]
    fn accepts_task_on_any_span() {
        let record = record_with(json!([task("t1", 5), task("t2", 15)]), json!([]));
        validate_provenance(&record, &spans()).unwrap();
    }

    #[test]
    fn accepts_receipt_matching_its_span() {
        let record = record_with(
            json!([]),
            json!([
                receipt("install-1", "install-1", 1),
                receipt("install-2", "install-2", 2),
            ]),
        );
        validate_provenance(&record, &spans()).unwrap();
    }

    #[test]
    fn rejects_receipt_without_matching_span() {
        // epoch 3 不存在于链上
        let record = record_with(json!([]), json!([receipt("install-1", "install-1", 3)]));
        assert_eq!(
            validate_provenance(&record, &spans()).unwrap_err().0,
            "work record receipt has no original authority span"
        );

        // gateway 与 home_install 不一致
        let record = record_with(json!([]), json!([receipt("install-1", "install-2", 1)]));
        assert!(validate_provenance(&record, &spans()).is_err());
    }

    #[test]
    fn rejects_task_before_known_history() {
        let empty: Vec<AuthoritySpan> = Vec::new();
        let record = record_with(json!([task("t1", 1)]), json!([]));
        assert_eq!(
            validate_provenance(&record, &empty).unwrap_err().0,
            "event precedes the known authority history"
        );
    }

    #[test]
    fn rejects_malformed_record() {
        assert!(validate_provenance(&json!({}), &spans()).is_err());
    }

    // ── task_origins ──────────────────────────────────────────────────────

    #[test]
    fn maps_tasks_to_their_origins() {
        let record = record_with(json!([task("t1", 5), task("t2", 15)]), json!([]));
        let origins = task_origins(&record, &spans()).unwrap();
        assert_eq!(
            origins.get("t1"),
            Some(&("install-1".to_owned(), 1))
        );
        assert_eq!(
            origins.get("t2"),
            Some(&("install-2".to_owned(), 2))
        );
    }

    #[test]
    fn origins_empty_for_no_tasks() {
        let record = record_with(json!([]), json!([]));
        assert!(task_origins(&record, &spans()).unwrap().is_empty());
    }

    #[test]
    fn origin_fails_for_seq_before_history() {
        let empty: Vec<AuthoritySpan> = Vec::new();
        let record = record_with(json!([task("t1", 1)]), json!([]));
        assert!(task_origins(&record, &empty).is_err());
    }
}
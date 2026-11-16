//! 任务输入上下文（hermes `gateway/hosted_room_task_input.py` 的 Rust 移植）。
//!
//! 上游自述：
//! > Bounded immutable input references carried by compacting policy callers.
//!
//! 24 行的极小模块，语义完全确定：`{watermark, event_seqs}` 两个字段，
//! seq 必须**严格递增且都大于 watermark**，上限 128 条。
//!
//! 它是 discussion 策略里「一个 turn 读了哪些事件」的压缩表示，替代把整段
//! 事件内容塞进任务 payload（那样会让 task id 哈希随内容膨胀）。

use serde_json::{json, Value};

/// 上游 `MAX_TASK_INPUT_EVENTS = 128`。
pub const MAX_TASK_INPUT_EVENTS: usize = 128;

/// 上游 `i64` 上界（`2**63 - 1`）。
const I64_MAX: i64 = i64::MAX;

/// 归一后的任务输入上下文。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskInput {
    pub watermark: i64,
    pub event_seqs: Vec<i64>,
}

impl TaskInput {
    /// 转回上游形状的 JSON（`{watermark, event_seqs}`）。
    pub fn to_json(&self) -> Value {
        json!({
            "watermark": self.watermark,
            "event_seqs": self.event_seqs,
        })
    }
}

/// 上游 `validate_task_input()`。
///
/// 错误文案逐字对照：
/// - `invalid task input context`（不是对象 / 字段集不对）
/// - `invalid task input watermark`（watermark 不是非负整数）
/// - `task input context exceeded its bound`（seqs 不是 list 或长度不在 1..=128）
/// - `task input sequences must be increasing after the watermark`
///
/// 注意上游用 `type(x) is not int`——**排除 bool 与浮点**。Rust 侧用
/// [`crate::hosted_rooms::common::json_i64`] 做同等判定。
pub fn validate_task_input(value: &Value) -> Result<TaskInput, String> {
    let Value::Object(map) = value else {
        return Err("invalid task input context".to_owned());
    };
    // 上游 `set(value) != {"watermark", "event_seqs"}`：字段集必须**恰好**这两个
    if map.len() != 2 || !map.contains_key("watermark") || !map.contains_key("event_seqs") {
        return Err("invalid task input context".to_owned());
    }

    let Some(watermark) = crate::hosted_rooms::common::json_i64(&map["watermark"]) else {
        return Err("invalid task input watermark".to_owned());
    };
    if watermark < 0 {
        return Err("invalid task input watermark".to_owned());
    }

    let Value::Array(raw_seqs) = &map["event_seqs"] else {
        return Err("task input context exceeded its bound".to_owned());
    };
    if raw_seqs.is_empty() || raw_seqs.len() > MAX_TASK_INPUT_EVENTS {
        return Err("task input context exceeded its bound".to_owned());
    }

    let mut previous = watermark;
    let mut event_seqs = Vec::with_capacity(raw_seqs.len());
    for raw in raw_seqs {
        let Some(seq) = crate::hosted_rooms::common::json_i64(raw) else {
            return Err("task input sequences must be increasing after the watermark".to_owned());
        };
        if !(previous < seq && seq <= I64_MAX) {
            return Err("task input sequences must be increasing after the watermark".to_owned());
        }
        previous = seq;
        event_seqs.push(seq);
    }

    Ok(TaskInput {
        watermark,
        event_seqs,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_valid_input() {
        let value = json!({ "watermark": 10, "event_seqs": [11, 12, 15] });
        let input = validate_task_input(&value).unwrap();
        assert_eq!(input.watermark, 10);
        assert_eq!(input.event_seqs, vec![11, 12, 15]);
        assert_eq!(input.to_json(), value);
    }

    #[test]
    fn rejects_non_object_and_wrong_field_set() {
        assert_eq!(
            validate_task_input(&json!([1])).unwrap_err(),
            "invalid task input context"
        );
        assert_eq!(
            validate_task_input(&json!({ "watermark": 0 })).unwrap_err(),
            "invalid task input context"
        );
        // 多一个字段也算错（上游 set 相等判定）
        assert_eq!(
            validate_task_input(&json!({ "watermark": 0, "event_seqs": [1], "x": 1 })).unwrap_err(),
            "invalid task input context"
        );
    }

    #[test]
    fn rejects_bad_watermark() {
        assert_eq!(
            validate_task_input(&json!({ "watermark": -1, "event_seqs": [1] })).unwrap_err(),
            "invalid task input watermark"
        );
        // 浮点不算整数
        assert_eq!(
            validate_task_input(&json!({ "watermark": 1.5, "event_seqs": [2] })).unwrap_err(),
            "invalid task input watermark"
        );
        // bool 不算整数（上游 type() is not int 挡掉）
        assert_eq!(
            validate_task_input(&json!({ "watermark": true, "event_seqs": [1] })).unwrap_err(),
            "invalid task input watermark"
        );
    }

    #[test]
    fn rejects_empty_or_oversized_seq_list() {
        assert_eq!(
            validate_task_input(&json!({ "watermark": 0, "event_seqs": [] })).unwrap_err(),
            "task input context exceeded its bound"
        );
        let too_many: Vec<i64> = (1..=(MAX_TASK_INPUT_EVENTS as i64 + 1)).collect();
        assert_eq!(
            validate_task_input(&json!({ "watermark": 0, "event_seqs": too_many })).unwrap_err(),
            "task input context exceeded its bound"
        );
    }

    #[test]
    fn accepts_exactly_the_bound() {
        let seqs: Vec<i64> = (1..=(MAX_TASK_INPUT_EVENTS as i64)).collect();
        assert!(validate_task_input(&json!({ "watermark": 0, "event_seqs": seqs })).is_ok());
    }

    #[test]
    fn rejects_non_increasing_sequences() {
        // 等于 watermark
        assert_eq!(
            validate_task_input(&json!({ "watermark": 5, "event_seqs": [5] })).unwrap_err(),
            "task input sequences must be increasing after the watermark"
        );
        // 重复
        assert_eq!(
            validate_task_input(&json!({ "watermark": 0, "event_seqs": [1, 1] })).unwrap_err(),
            "task input sequences must be increasing after the watermark"
        );
        // 逆序
        assert_eq!(
            validate_task_input(&json!({ "watermark": 0, "event_seqs": [3, 2] })).unwrap_err(),
            "task input sequences must be increasing after the watermark"
        );
    }

    #[test]
    fn rejects_non_integer_seq_entries() {
        assert_eq!(
            validate_task_input(&json!({ "watermark": 0, "event_seqs": ["1"] })).unwrap_err(),
            "task input sequences must be increasing after the watermark"
        );
        assert_eq!(
            validate_task_input(&json!({ "watermark": 0, "event_seqs": [true] })).unwrap_err(),
            "task input sequences must be increasing after the watermark"
        );
    }
}
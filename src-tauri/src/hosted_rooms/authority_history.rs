//! 已提交的权限变更重放上下文（hermes `gateway/hosted_room_authority_history.py`）。
//!
//! 上游自述：
//! > **Bounded replay context for committed authority changes, never election
//! > proof.** / Validate passive evidence against committed authority spans,
//! > never elect an owner.
//!
//! ## 为什么重要
//!
//! 房间的 `authority_epoch` 会因为转移而推进。一个任务/回执产生时的**当时归属**
//! 必须可证——否则「谁有权做这件事」就无法核对。本模块从事件日志重建出
//! `AuthoritySpan` 链（每条 span = 一次归属，带 `from_seq` 起点）。
//!
//! 它**只是被动的重放上下文**，拿到这份数据不赋予任何控制权。
//!
//! ## 核心规则
//!
//! - 链首：`epoch == 1 && from_seq == 0`（「无已验证起点」= 非法）
//! - 链上：`epoch == 前一条 epoch + 1`（无 gap）且 `from_seq > 前一条 from_seq`（有序）
//! - 链尾：必须等于 `(gateway_id, epoch)` —— 即**必须到达当前归属**
//! - `at_sequence`：按事件序查「那个时刻归属谁」，前序未知则报错

use serde_json::Value;

use super::common;

/// 上游 `MAX_AUTHORITY_SPANS`。
pub const MAX_AUTHORITY_SPANS: usize = 1024;

/// 归属转移事件（上游 `TRANSFER_KINDS`）。
///
/// 两种都带同样的 previous/next/epoch 载荷、按同样规则检查：`authority.claimed`
/// 是新主的记录，`authority.lost` 是旧主被 fence 到更新 epoch 时提交的记录。
pub const TRANSFER_KINDS: &[&str] = &["authority.claimed", "authority.lost"];

/// 上游 `AuthorityHistoryError`。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthorityHistoryError(pub String);

impl std::fmt::Display for AuthorityHistoryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for AuthorityHistoryError {}

fn fail<T>(message: impl Into<String>) -> Result<T, AuthorityHistoryError> {
    Err(AuthorityHistoryError(message.into()))
}

/// 一条归属区间（上游 `AuthoritySpan`）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthoritySpan {
    pub gateway_id: String,
    pub epoch: i64,
    pub from_seq: i64,
}

impl AuthoritySpan {
    /// 上游 `as_mapping()`。
    pub fn as_mapping(&self) -> Value {
        serde_json::json!({
            "gateway_id": self.gateway_id,
            "epoch": self.epoch,
            "from_seq": self.from_seq,
        })
    }
}

/// 上游 `_gateway()`：过 identifier 且必须已规范化。
fn gateway(value: &str) -> Result<String, AuthorityHistoryError> {
    let validated = common::identifier(value, "authority gateway", 128, true, None)
        .map_err(|e| AuthorityHistoryError(e.0))?;
    if validated != value {
        return fail("authority gateway must be canonical");
    }
    Ok(validated)
}

/// 上游 `validate_history()`：校验上下文 epoch 链，返回 span 元组。
///
/// `value` 为 `None` 时返回单条 span（epoch=1, from_seq=0）。
///
/// 上游注释：「contextual epochs; possession of this data grants no control
/// rights」——拿到这份数据不赋予控制权。
pub fn validate_history(
    value: Option<&Value>,
    gateway_id: &str,
    epoch: i64,
) -> Result<Vec<AuthoritySpan>, AuthorityHistoryError> {
    let Some(value) = value else {
        return Ok(vec![AuthoritySpan {
            gateway_id: gateway_id.to_owned(),
            epoch,
            from_seq: 0,
        }]);
    };

    let Value::Array(items) = value else {
        return fail("authority history exceeds its bound or is absent");
    };
    if items.is_empty() || items.len() > MAX_AUTHORITY_SPANS {
        return fail("authority history exceeds its bound or is absent");
    }

    let mut spans: Vec<AuthoritySpan> = Vec::with_capacity(items.len());
    for item in items {
        let Value::Object(map) = item else {
            return fail("authority history fields are invalid");
        };
        if map.len() != 3 || !map.contains_key("gateway_id") || !map.contains_key("epoch")
            || !map.contains_key("from_seq")
        {
            return fail("authority history fields are invalid");
        }

        let source = gateway(map["gateway_id"].as_str().unwrap_or(""))?;

        // 上游 `type(x) is not int`：拒绝 bool 与浮点
        let generation = map
            .get("epoch")
            .and_then(common::json_i64)
            .ok_or_else(|| AuthorityHistoryError("authority history coordinates are invalid".into()))?;
        let start = map
            .get("from_seq")
            .and_then(common::json_i64)
            .ok_or_else(|| AuthorityHistoryError("authority history coordinates are invalid".into()))?;

        if !(1 <= generation && generation < i64::MAX) || !(0 <= start && start < i64::MAX) {
            return fail("authority history coordinates are invalid");
        }

        if spans.is_empty() {
            // 链首必须是 epoch 1 / seq 0
            if generation != 1 || start != 0 {
                return fail("authority history has no verified starting point");
            }
        } else {
            let previous = spans.last().unwrap();
            if generation != previous.epoch + 1 {
                return fail("authority history has a gap or unordered boundary");
            }
            if start <= previous.from_seq {
                return fail("authority history has a gap or unordered boundary");
            }
        }
        spans.push(AuthoritySpan {
            gateway_id: source,
            epoch: generation,
            from_seq: start,
        });
    }

    let last = spans.last().unwrap();
    if (last.gateway_id.as_str(), last.epoch) != (gateway_id, epoch) {
        return fail("authority history does not reach the current owner");
    }
    Ok(spans)
}

/// 上游 `at_sequence()`：查「seq 这个事件归属谁」。
pub fn at_sequence(history: &[AuthoritySpan], seq: i64) -> Result<&AuthoritySpan, AuthorityHistoryError> {
    for span in history.iter().rev() {
        if seq >= span.from_seq {
            return Ok(span);
        }
    }
    fail("event precedes the known authority history")
}

/// 上游 `origin_gateway_id()`：让 group/session 命名空间在协调者更换时保持稳定。
///
/// 返回链首的 gateway_id（即房间最初的归属），而不是当前的。
pub fn origin_gateway_id(room: &Value) -> Result<String, AuthorityHistoryError> {
    let Value::Object(map) = room else {
        return fail("authority history fields are invalid");
    };
    let gateway_id = map
        .get("authority_gateway_id")
        .and_then(Value::as_str)
        .ok_or_else(|| AuthorityHistoryError("authority history fields are invalid".into()))?;
    let Some(epoch) = map.get("authority_epoch").and_then(common::json_i64) else {
        return fail("authority history coordinates are invalid");
    };
    let history = validate_history(map.get("authority_history"), gateway_id, epoch)?;
    Ok(history[0].gateway_id.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn span(gateway_id: &str, epoch: i64, from_seq: i64) -> AuthoritySpan {
        AuthoritySpan {
            gateway_id: gateway_id.to_owned(),
            epoch,
            from_seq,
        }
    }

    fn history_json(spans: &[AuthoritySpan]) -> Value {
        json!(spans.iter().map(|s| s.as_mapping()).collect::<Vec<_>>())
    }

    // ── validate_history ──────────────────────────────────────────────────

    #[test]
    fn none_yields_single_span() {
        let spans = validate_history(None, "gw-1", 1).unwrap();
        assert_eq!(spans.len(), 1);
        assert_eq!(spans[0].gateway_id, "gw-1");
        assert_eq!(spans[0].epoch, 1);
        assert_eq!(spans[0].from_seq, 0);
    }

    #[test]
    fn empty_list_is_rejected() {
        assert_eq!(
            validate_history(Some(&json!([])), "gw-1", 1)
                .unwrap_err()
                .0,
            "authority history exceeds its bound or is absent"
        );
    }

    #[test]
    fn single_span_must_be_epoch_one_seq_zero() {
        let good = json!([{"gateway_id": "gw-1", "epoch": 1, "from_seq": 0}]);
        assert!(validate_history(Some(&good), "gw-1", 1).is_ok());

        let bad = json!([{"gateway_id": "gw-1", "epoch": 1, "from_seq": 5}]);
        assert_eq!(
            validate_history(Some(&bad), "gw-1", 1)
                .unwrap_err()
                .0,
            "authority history has no verified starting point"
        );

        let bad2 = json!([{"gateway_id": "gw-1", "epoch": 2, "from_seq": 0}]);
        assert_eq!(
            validate_history(Some(&bad2), "gw-1", 2)
                .unwrap_err()
                .0,
            "authority history has no verified starting point"
        );
    }

    #[test]
    fn multi_span_chain_must_be_contiguous() {
        let good = json!([
            {"gateway_id": "gw-1", "epoch": 1, "from_seq": 0},
            {"gateway_id": "gw-2", "epoch": 2, "from_seq": 10},
            {"gateway_id": "gw-3", "epoch": 3, "from_seq": 20},
        ]);
        assert!(validate_history(Some(&good), "gw-3", 3).is_ok());

        // gap：epoch 跳了 2 → 3
        let gap = json!([
            {"gateway_id": "gw-1", "epoch": 1, "from_seq": 0},
            {"gateway_id": "gw-3", "epoch": 3, "from_seq": 10},
        ]);
        assert_eq!(
            validate_history(Some(&gap), "gw-3", 3)
                .unwrap_err()
                .0,
            "authority history has a gap or unordered boundary"
        );

        // 无序：from_seq 不增
        let unordered = json!([
            {"gateway_id": "gw-1", "epoch": 1, "from_seq": 0},
            {"gateway_id": "gw-2", "epoch": 2, "from_seq": 5},
            {"gateway_id": "gw-3", "epoch": 3, "from_seq": 5},
        ]);
        assert_eq!(
            validate_history(Some(&unordered), "gw-3", 3)
                .unwrap_err()
                .0,
            "authority history has a gap or unordered boundary"
        );
    }

    #[test]
    fn must_reach_current_owner() {
        let history = json!([
            {"gateway_id": "gw-1", "epoch": 1, "from_seq": 0},
            {"gateway_id": "gw-2", "epoch": 2, "from_seq": 10},
        ]);
        assert!(validate_history(Some(&history), "gw-2", 2).is_ok());
        assert_eq!(
            validate_history(Some(&history), "gw-3", 2)
                .unwrap_err()
                .0,
            "authority history does not reach the current owner"
        );
    }

    #[test]
    fn rejects_bad_field_set_and_types() {
        let bad_fields = json!([{"gateway_id": "gw-1", "epoch": 1}]);
        assert_eq!(
            validate_history(Some(&bad_fields), "gw-1", 1)
                .unwrap_err()
                .0,
            "authority history fields are invalid"
        );

        // epoch 是字符串 → 不是 int
        let bad_type = json!([{"gateway_id": "gw-1", "epoch": "1", "from_seq": 0}]);
        assert_eq!(
            validate_history(Some(&bad_type), "gw-1", 1)
                .unwrap_err()
                .0,
            "authority history coordinates are invalid"
        );

        // epoch 是 bool → type is not int 挡掉
        let bad_bool = json!([{"gateway_id": "gw-1", "epoch": true, "from_seq": 0}]);
        assert_eq!(
            validate_history(Some(&bad_bool), "gw-1", 1)
                .unwrap_err()
                .0,
            "authority history coordinates are invalid"
        );
    }

    #[test]
    fn rejects_oversized_history() {
        // 上游：`not 1 <= len(value) <= MAX_AUTHORITY_SPANS` → 超过上限才算错。
        // 正好 1024 条是合法的，1025 条才越界。
        let mut items = Vec::new();
        for i in 1..=(MAX_AUTHORITY_SPANS as i64 + 1) {
            items.push(json!({"gateway_id": format!("gw-{i}"), "epoch": i, "from_seq": i - 1}));
        }
        let value = json!(items);
        let target_gateway = format!("gw-{}", MAX_AUTHORITY_SPANS + 1);
        let err = validate_history(Some(&value), &target_gateway, MAX_AUTHORITY_SPANS as i64 + 1).unwrap_err();
        assert_eq!(err.0, "authority history exceeds its bound or is absent");
    }

    #[test]
    fn accepts_exactly_the_bound() {
        let mut items = Vec::new();
        for i in 1..=(MAX_AUTHORITY_SPANS as i64) {
            items.push(json!({"gateway_id": format!("gw-{i}"), "epoch": i, "from_seq": i - 1}));
        }
        let value = json!(items);
        let target_gateway = format!("gw-{}", MAX_AUTHORITY_SPANS);
        assert!(
            validate_history(Some(&value), &target_gateway, MAX_AUTHORITY_SPANS as i64).is_ok()
        );
    }

    // ── at_sequence ───────────────────────────────────────────────────────

    #[test]
    fn at_sequence_finds_enclosing_span() {
        let history = vec![
            span("gw-1", 1, 0),
            span("gw-2", 2, 10),
            span("gw-3", 3, 20),
        ];
        assert_eq!(at_sequence(&history, 5).unwrap().gateway_id, "gw-1");
        assert_eq!(at_sequence(&history, 10).unwrap().gateway_id, "gw-2");
        assert_eq!(at_sequence(&history, 19).unwrap().gateway_id, "gw-2");
        assert_eq!(at_sequence(&history, 20).unwrap().gateway_id, "gw-3");
        assert_eq!(at_sequence(&history, 99).unwrap().gateway_id, "gw-3");
    }

    #[test]
    fn at_sequence_fails_before_known_history() {
        let history = vec![span("gw-1", 1, 0), span("gw-2", 2, 10)];
        // from_seq 都是 >= 0，所以不存在 "前序未知" 的情况；空 history 才会
        assert_eq!(
            at_sequence(&[], 1)
                .unwrap_err()
                .0,
            "event precedes the known authority history"
        );
    }

    // ── origin_gateway_id ─────────────────────────────────────────────────

    #[test]
    fn origin_returns_first_span_gateway() {
        let room = json!({
            "authority_gateway_id": "gw-3",
            "authority_epoch": 3,
            "authority_history": [
                {"gateway_id": "gw-1", "epoch": 1, "from_seq": 0},
                {"gateway_id": "gw-2", "epoch": 2, "from_seq": 10},
                {"gateway_id": "gw-3", "epoch": 3, "from_seq": 20},
            ],
        });
        // 命名空间稳定：最初的归属，不是当前的
        assert_eq!(origin_gateway_id(&room).unwrap(), "gw-1");
    }

    #[test]
    fn origin_without_history_is_the_current_gateway() {
        let room = json!({
            "authority_gateway_id": "gw-1",
            "authority_epoch": 1,
        });
        assert_eq!(origin_gateway_id(&room).unwrap(), "gw-1");
    }
}
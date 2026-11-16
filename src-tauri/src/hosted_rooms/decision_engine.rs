//! 讨论规划归约（hermes `gateway/hosted_room_discussion.py` 的 `decision()` 部分）。
//!
//! ## 这是整个移植里最"确定性"的一块
//!
//! 上游的核心承诺：
//!
//! > a frozen local roster plus the complete typed room log yields **at most one next
//! > driver task** ... **a restart reconstructs tasks from durable state**.
//!
//! 换句话说：**给定同一份日志，算出的下一个任务永远相同**。没有"上次算到哪"的
//! 持久状态，所以重启后重算即可。本文件严格保持这个性质——所有函数都是纯的，
//! 只读日志，不写任何东西。
//!
//! ## 已实现
//!
//! - 事件校验：`message.user` / `message.member` / `turn.*` / `room.activity` /
//!   `room.stop_requested`
//! - `validate_events`：整条日志的顺序、唯一 id、epoch 一致性
//! - `derive_member_watermarks`：从终态事件推导 `(thread, member) → seen_through_seq`
//! - `thread_messages`：区分 thread 消息 / 本讨论消息 / 本讨论的成员消息
//! - `build_prompt`：成员 turn 的提示词（含预算裁剪）
//! - `make_task_plan`：确定性 task id（prompt 的 sha256 前 48 位）
//! - `pending_discussion`：最老的未完成、未被停止的 thread 讨论
//!
//! ## 未实现
//!
//! `resolve_decision()` 的最后一层编排（把上面这些拼成 `DiscussionDecision`），
//! 它还需要 lead/router 的 responder 解析接进来。

use serde_json::{Map, Value};

use super::common;
use super::discussion::{
    is_pass_text, member_by_id, require_gateway_actor, resolve_mentions, DiscussionError,
    DiscussionMember, DiscussionRoom, DiscussResult, EventPlan,
};
use super::driver;

// ── 事件类型 ────────────────────────────────────────────────────────────────

/// 上游 `_ValidatedEvent`：已校验的日志事件。
#[derive(Debug, Clone, PartialEq)]
pub struct ValidatedEvent {
    pub seq: i64,
    pub event_id: String,
    pub kind: String,
    pub actor: Value,
    pub payload: Value,
}

/// 终态事件种类（上游 `_TERMINAL_KINDS`）。
pub const TERMINAL_KINDS: &[&str] = &["turn.settled", "turn.failed", "turn.cancelled", "turn.deferred"];

/// 需要 epoch 戳的事件种类（上游 `_EPOCH_STAMPED_KINDS`）。
pub const EPOCH_STAMPED_KINDS: &[&str] = &[
    "turn.settled",
    "turn.failed",
    "turn.cancelled",
    "turn.deferred",
    "message.member",
    "room.assignment",
    "room.routed",
    "room.continued",
    "room.activity",
    "room.stop_requested",
];

// ── 事件校验 ────────────────────────────────────────────────────────────────

fn identifier(value: Option<&Value>, label: &str) -> DiscussResult<String> {
    let Some(s) = value.and_then(Value::as_str) else {
        return Err(DiscussionError {
            code: "validation",
            message: format!("invalid {label}"),
        });
    };
    common::identifier(s, label, driver::MAX_IDENTIFIER_CHARS, true, None).map_err(|e| DiscussionError {
        code: "validation",
        message: e.0,
    })
}

fn positive_int(value: Option<&Value>, label: &str) -> DiscussResult<i64> {
    let Some(n) = value.and_then(common::json_i64) else {
        return Err(DiscussionError {
            code: "validation",
            message: format!("{label} must be a positive integer"),
        });
    };
    if n < 1 {
        return Err(DiscussionError {
            code: "validation",
            message: format!("{label} must be a positive integer"),
        });
    }
    Ok(n)
}

/// 上游 `_validate_terminal_event()`。
fn validate_terminal_event(
    kind: &str,
    payload: &Value,
    actor: &Value,
    room: &DiscussionRoom,
) -> DiscussResult<Value> {
    let Value::Object(map) = payload else {
        return Err(DiscussionError {
            code: "validation",
            message: format!("{kind} payload must be an object"),
        });
    };

    // 坐标字段 + seen_through_seq（+ 各 kind 的附加字段）
    let mut required: Vec<&str> = super::discussion::TURN_COORDINATE_FIELDS.to_vec();
    required.push("seen_through_seq");
    match kind {
        "turn.settled" => {
            required.push("message_event_id");
            required.push("passed");
        }
        "turn.failed" => required.push("error"),
        "turn.cancelled" => required.push("reason"),
        "turn.deferred" => {
            required.push("execution_generation");
            required.push("reason");
        }
        _ => {}
    }

    for field in &required {
        if !map.contains_key(*field) {
            return Err(DiscussionError {
                code: "validation",
                message: format!("{kind} payload is missing fields: {field}"),
            });
        }
    }
    // turn.failed 允许可选 reason_code
    let mut allowed: Vec<&str> = required.clone();
    if kind == "turn.failed" {
        allowed.push("reason_code");
    }
    for key in map.keys() {
        if !allowed.contains(&key.as_str()) {
            return Err(DiscussionError {
                code: "validation",
                message: format!("{kind} payload has unknown fields: {key}"),
            });
        }
    }

    super::discussion::validate_turn_coordinates(payload, room)?;
    positive_int(map.get("seen_through_seq"), "seen_through_seq")?;

    // gateway actor 不能带 connection_id
    if !matches!(actor.get("connection_id"), None | Some(Value::Null)) {
        return Err(DiscussionError {
            code: "validation",
            message: format!("{kind} requires a gateway actor"),
        });
    }
    require_gateway_actor(actor, room, &format!("{kind} requires a gateway actor"))?;

    if kind == "turn.settled" {
        if !matches!(map.get("passed"), Some(Value::Bool(_))) {
            return Err(DiscussionError {
                code: "validation",
                message: "turn.settled passed must be a boolean".into(),
            });
        }
        let passed = matches!(map.get("passed"), Some(Value::Bool(true)));
        let message_event_id = map.get("message_event_id");
        if !passed {
            identifier(message_event_id, "message_event_id")?;
        } else if !matches!(message_event_id, None | Some(Value::Null)) {
            return Err(DiscussionError {
                code: "validation",
                message: "a passed turn cannot reference a member message".into(),
            });
        }
        return Ok(payload.clone());
    }

    let field = if kind == "turn.failed" { "error" } else { "reason" };
    match map.get(field).and_then(Value::as_str) {
        Some(text) if !text.trim().is_empty() => {}
        _ => {
            return Err(DiscussionError {
                code: "validation",
                message: format!("{kind} {field} must be non-empty"),
            })
        }
    }
    if kind == "turn.deferred" {
        positive_int(map.get("execution_generation"), "execution_generation")?;
    }
    Ok(payload.clone())
}

/// 上游 `_validate_gateway_event()`：`room.activity` / `room.stop_requested`。
fn validate_gateway_event(
    kind: &str,
    payload: &Value,
    actor: &Value,
    room: &DiscussionRoom,
) -> DiscussResult<Value> {
    let Value::Object(map) = payload else {
        return Err(DiscussionError {
            code: "validation",
            message: format!("{kind} payload must be an object"),
        });
    };

    let (required, identifier_fields): (&[&str], &[&str]) = match kind {
        "room.activity" => (
            &["status", "reason_code", "thread_id", "discussion_event_id"],
            &["reason_code", "thread_id", "discussion_event_id"],
        ),
        "room.stop_requested" => (&["cancel_id"], &["cancel_id"]),
        _ => {
            return Err(DiscussionError {
                code: "validation",
                message: format!("unknown gateway event kind {kind}"),
            })
        }
    };

    for field in required {
        if !map.contains_key(*field) {
            return Err(DiscussionError {
                code: "validation",
                message: format!("{kind} payload is missing fields: {field}"),
            });
        }
    }
    for key in map.keys() {
        if !required.contains(&key.as_str()) {
            return Err(DiscussionError {
                code: "validation",
                message: format!("{kind} payload has unknown fields: {key}"),
            });
        }
    }

    if kind == "room.activity" {
        let status = map.get("status").and_then(Value::as_str);
        if status != Some("settled") && status != Some("bounded") {
            return Err(DiscussionError {
                code: "validation",
                message: "invalid room.activity status".into(),
            });
        }
    }
    for field in identifier_fields {
        // reason_code 可为 null（上游 identifier(None) 会报错，但 activity 的 reason_code 实际可空）
        if *field == "reason_code" && matches!(map.get(*field), None | Some(Value::Null)) {
            continue;
        }
        identifier(map.get(*field), field)?;
    }
    require_gateway_actor(actor, room, &format!("{kind} requires the room gateway"))?;
    Ok(payload.clone())
}

/// 上游 `_validate_member_message()`（简化版：只做结构与坐标，附件走清单校验）。
fn validate_member_message(
    _kind: &str,
    payload: &Value,
    actor: &Value,
    room: &DiscussionRoom,
) -> DiscussResult<Value> {
    let Value::Object(map) = payload else {
        return Err(DiscussionError {
            code: "validation",
            message: "message.member payload must be an object".into(),
        });
    };

    let mut required: Vec<&str> = super::discussion::TURN_COORDINATE_FIELDS.to_vec();
    required.push("text");

    for field in &required {
        if !map.contains_key(*field) {
            return Err(DiscussionError {
                code: "validation",
                message: format!("message.member payload is missing fields: {field}"),
            });
        }
    }
    let mut allowed = required.clone();
    allowed.push("attachments");
    allowed.push("recipient_member_ids");
    for key in map.keys() {
        if !allowed.contains(&key.as_str()) {
            return Err(DiscussionError {
                code: "validation",
                message: format!("message.member payload has unknown fields: {key}"),
            });
        }
    }

    super::discussion::validate_turn_coordinates(payload, room)?;

    let text = map.get("text").and_then(Value::as_str).unwrap_or("");
    if text.trim().is_empty() || is_pass_text(text) {
        return Err(DiscussionError {
            code: "validation",
            message: "message.member text must be a non-pass string".into(),
        });
    }

    // actor 必须与名册一致
    let member = member_by_id(room, map.get("member_id").unwrap_or(&Value::Null))?;
    let expected = member.actor(false);
    let Value::Object(expected_map) = &expected else {
        unreachable!()
    };
    for (key, value) in expected_map {
        if actor.get(key) != Some(value) {
            return Err(DiscussionError {
                code: "validation",
                message: "message.member actor does not match roster".into(),
            });
        }
    }
    Ok(payload.clone())
}

/// 上游 `_validate_event()` + `_validated_events()`：整条日志的顺序与一致性。
pub fn validate_events(raw_events: &[Value], room: &DiscussionRoom) -> DiscussResult<Vec<ValidatedEvent>> {
    let mut validated: Vec<ValidatedEvent> = Vec::with_capacity(raw_events.len());
    let mut event_ids: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    let mut previous_seq = 0i64;

    for raw in raw_events {
        let Value::Object(map) = raw else {
            return Err(DiscussionError {
                code: "validation",
                message: "room event must be an object".into(),
            });
        };

        if map.get("room_id").and_then(Value::as_str) != Some(room.room_id.as_str()) {
            return Err(DiscussionError {
                code: "validation",
                message: "room event belongs to a different room".into(),
            });
        }

        let seq = positive_int(map.get("seq"), "event seq")?;
        if seq <= previous_seq {
            return Err(DiscussionError {
                code: "validation",
                message: "room events must be in strict sequence order".into(),
            });
        }
        previous_seq = seq;

        let event_id = identifier(map.get("event_id"), "event_id")?;
        let kind = map.get("kind").and_then(Value::as_str).ok_or_else(|| DiscussionError {
            code: "validation",
            message: "event kind must be a string".into(),
        })?;
        let actor = map.get("actor").cloned().unwrap_or(Value::Null);
        if !actor.is_object() {
            return Err(DiscussionError {
                code: "validation",
                message: "event actor must be an object".into(),
            });
        }
        let payload = map.get("payload").cloned().unwrap_or(Value::Null);
        if !payload.is_object() {
            return Err(DiscussionError {
                code: "validation",
                message: "event payload must be an object".into(),
            });
        }

        // epoch 戳校验
        if EPOCH_STAMPED_KINDS.contains(&kind) {
            let raw_epoch = map.get("authority_epoch").and_then(common::json_i64);
            if raw_epoch != Some(room.authority_epoch) {
                return Err(DiscussionError {
                    code: "validation",
                    message: format!("{kind} authority epoch does not match the room"),
                });
            }
        }

        let payload = match kind {
            "message.user" => super::discussion::validate_user_payload(&payload)?,
            "message.member" => validate_member_message(kind, &payload, &actor, room)?,
            k if TERMINAL_KINDS.contains(&k) => validate_terminal_event(k, &payload, &actor, room)?,
            "room.activity" | "room.stop_requested" => {
                validate_gateway_event(kind, &payload, &actor, room)?
            }
            // 其余 kind（room.assignment / room.routed / room.continued / room.renamed ...）
            // 在各自模块校验；这里放行以保持归约可进行。
            _ => payload,
        };

        if !event_ids.insert(event_id.clone()) {
            return Err(DiscussionError {
                code: "validation",
                message: "room event ids must be unique".into(),
            });
        }

        validated.push(ValidatedEvent {
            seq,
            event_id,
            kind: kind.to_owned(),
            actor,
            payload,
        });
    }
    Ok(validated)
}

// ── 水位推导 ────────────────────────────────────────────────────────────────

/// 上游 `_derive_member_watermarks()`：从终态事件推导 `(thread, member) → seen_through_seq`。
///
/// 关键规则：
/// - 同一 task_id 只能有**一个**终态，唯一例外是 `turn.deferred` 可以多次但要代际递增
/// - `turn.settled` 且未 pass 时，必须引用一条匹配的 `message.member`
/// - 水位只在「settled 非 pass」且 `watermark < discussion_seq` 时才推进到 message.seq
pub fn derive_member_watermarks(
    events: &[ValidatedEvent],
) -> DiscussResult<std::collections::BTreeMap<(String, String), i64>> {
    let messages_by_id: std::collections::BTreeMap<&str, &ValidatedEvent> = events
        .iter()
        .filter(|e| e.kind == "message.member")
        .map(|e| (e.event_id.as_str(), e))
        .collect();

    let mut terminal_by_task: std::collections::BTreeMap<String, &ValidatedEvent> =
        std::collections::BTreeMap::new();
    let mut watermarks: std::collections::BTreeMap<(String, String), i64> =
        std::collections::BTreeMap::new();

    for event in events {
        if !TERMINAL_KINDS.contains(&event.kind.as_str()) {
            continue;
        }

        let task_id = event
            .payload
            .get("task_id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();

        if let Some(previous) = terminal_by_task.get(&task_id) {
            if previous.kind != "turn.deferred" {
                return Err(DiscussionError {
                    code: "validation",
                    message: format!("task '{task_id}' has more than one terminal room event"),
                });
            }
            if event.kind == "turn.deferred" {
                let prev_gen = previous
                    .payload
                    .get("execution_generation")
                    .and_then(common::json_i64)
                    .unwrap_or(0);
                let this_gen = event
                    .payload
                    .get("execution_generation")
                    .and_then(common::json_i64)
                    .unwrap_or(0);
                if this_gen <= prev_gen {
                    return Err(DiscussionError {
                        code: "validation",
                        message: format!("task '{task_id}' deferral generation did not advance"),
                    });
                }
            }
        }
        terminal_by_task.insert(task_id, event);

        let thread_id = event.payload.get("thread_id").and_then(Value::as_str).unwrap_or("").to_owned();
        let member_id = event.payload.get("member_id").and_then(Value::as_str).unwrap_or("").to_owned();
        let mut watermark = event
            .payload
            .get("seen_through_seq")
            .and_then(common::json_i64)
            .unwrap_or(0);

        let passed = matches!(event.payload.get("passed"), Some(Value::Bool(true)));
        if event.kind == "turn.settled" && !passed {
            let message_event_id = event
                .payload
                .get("message_event_id")
                .and_then(Value::as_str)
                .unwrap_or("");
            let Some(message) = messages_by_id.get(message_event_id) else {
                return Err(DiscussionError {
                    code: "validation",
                    message: "turn.settled references no matching member message".into(),
                });
            };
            // 三个坐标字段必须一致
            for field in ["task_id", "member_id", "thread_id"] {
                if message.payload.get(field) != event.payload.get(field) {
                    return Err(DiscussionError {
                        code: "validation",
                        message: "turn.settled references no matching member message".into(),
                    });
                }
            }
            // discussion 事件必须存在
            let discussion_event_id = event
                .payload
                .get("discussion_event_id")
                .and_then(Value::as_str)
                .unwrap_or("");
            let Some(discussion_seq) = events
                .iter()
                .find(|e| e.event_id == discussion_event_id)
                .map(|e| e.seq)
            else {
                return Err(DiscussionError {
                    code: "validation",
                    message: "turn.settled references no matching user discussion".into(),
                });
            };
            if watermark >= discussion_seq {
                watermark = watermark.max(message.seq);
            }
        }

        let key = (thread_id, member_id);
        let current = watermarks.get(&key).copied().unwrap_or(0);
        watermarks.insert(key, current.max(watermark));
    }
    Ok(watermarks)
}

// ── thread 消息分类 ─────────────────────────────────────────────────────────

/// 上游 `_thread_messages()`：(thread 消息, 本讨论起, 本讨论的成员消息)。
///
/// 关键细节（上游注释）：发布时先写可见的成员消息、再写终态事件。若崩在这两步
/// 之间，消息在日志里但**还不算已提交的策略输入**——忽略它才能重算出原本的
/// task 坐标，让调用方能去看终态 driver 行并把发布补完。
pub fn thread_messages<'a>(
    events: &'a [ValidatedEvent],
    discussion: &ValidatedEvent,
) -> (Vec<&'a ValidatedEvent>, Vec<&'a ValidatedEvent>, Vec<&'a ValidatedEvent>) {
    let thread_id = discussion.payload.get("thread_id").and_then(Value::as_str).unwrap_or("");

    // 已提交的成员消息 id（由 settled 的 message_event_id 指向）
    let committed: std::collections::BTreeSet<&str> = events
        .iter()
        .filter(|e| e.kind == "turn.settled")
        .filter_map(|e| e.payload.get("message_event_id").and_then(Value::as_str))
        .collect();

    let thread: Vec<&ValidatedEvent> = events
        .iter()
        .filter(|e| e.payload.get("thread_id").and_then(Value::as_str) == Some(thread_id))
        .filter(|e| {
            e.kind == "message.user"
                || (e.kind == "message.member" && committed.contains(e.event_id.as_str()))
        })
        .collect();

    let since_discussion: Vec<&ValidatedEvent> =
        thread.iter().copied().filter(|e| e.seq >= discussion.seq).collect();

    let member_messages: Vec<&ValidatedEvent> = thread
        .iter()
        .copied()
        .filter(|e| {
            e.kind == "message.member"
                && e.payload.get("discussion_event_id").and_then(Value::as_str)
                    == Some(discussion.event_id.as_str())
        })
        .collect();

    (thread, since_discussion, member_messages)
}

// ── 未完成讨论 ──────────────────────────────────────────────────────────────

/// 上游 `_pending_discussion()`：最老的、未被停止、未完成的 thread 讨论。
///
/// 「未完成」= 该讨论**没有**在其最新 `room.continued` 之后出现 `room.activity`
/// 的 `settled`/`bounded`。所以 Continue 能重新打开一个已达上限的讨论。
pub fn pending_discussion(events: &[ValidatedEvent]) -> Option<&ValidatedEvent> {
    // 停止水位：所有 room.stop_requested 的最大 seq
    let stopped_through_seq = events
        .iter()
        .filter(|e| e.kind == "room.stop_requested")
        .map(|e| e.seq)
        .max()
        .unwrap_or(0);

    // 每个 discussion 的最新 continue seq
    let mut continued_at: std::collections::BTreeMap<&str, i64> = std::collections::BTreeMap::new();
    for event in events.iter().filter(|e| e.kind == "room.continued") {
        if let Some(id) = event.payload.get("discussion_event_id").and_then(Value::as_str) {
            continued_at.insert(id, event.seq);
        }
    }

    // 已完成的 discussion（activity settled/bounded 且在其最新 continue 之后）
    let completed: std::collections::BTreeSet<&str> = events
        .iter()
        .filter(|e| e.kind == "room.activity")
        .filter(|e| {
            matches!(
                e.payload.get("status").and_then(Value::as_str),
                Some("settled") | Some("bounded")
            )
        })
        .filter(|e| {
            let id = e.payload.get("discussion_event_id").and_then(Value::as_str).unwrap_or("");
            e.seq > continued_at.get(id).copied().unwrap_or(0)
        })
        .filter_map(|e| e.payload.get("discussion_event_id").and_then(Value::as_str))
        .collect();

    // 每个 thread 的最新 user 消息
    let mut latest_by_thread: std::collections::BTreeMap<&str, &ValidatedEvent> =
        std::collections::BTreeMap::new();
    for event in events.iter().filter(|e| e.kind == "message.user") {
        if let Some(thread_id) = event.payload.get("thread_id").and_then(Value::as_str) {
            // 后来的覆盖先前的
            let entry = latest_by_thread.entry(thread_id).or_insert(event);
            if event.seq > entry.seq {
                *entry = event;
            }
        }
    }

    let mut candidates: Vec<&ValidatedEvent> = latest_by_thread.values().copied().collect();
    candidates.sort_by_key(|e| e.seq);

    candidates
        .into_iter()
        .find(|e| e.seq > stopped_through_seq && !completed.contains(e.event_id.as_str()))
}

// ── 提示词与任务 ────────────────────────────────────────────────────────────

/// 上游 `_requires_direct_reply()`：只有用户的开场点名要求必须回复。
pub fn requires_direct_reply(
    room: &DiscussionRoom,
    source: Option<&ValidatedEvent>,
    member: &DiscussionMember,
    round_index: i64,
) -> bool {
    if round_index != 0 {
        return false;
    }
    let Some(source) = source else {
        return false;
    };
    if source.kind != "message.user" {
        return false;
    }
    let text = source.payload.get("text").and_then(Value::as_str).unwrap_or("");
    resolve_mentions(&[text], &room.members, false)
        .iter()
        .any(|m| m.member_id == member.member_id)
}

/// 上游 `_member_digest()`：成员身份摘要（24 位 hex）。
pub fn member_digest(member: &DiscussionMember) -> String {
    let target = common::compact_json(&member.target.to_json(), false);
    let material = format!(
        "{}\0{}\0{}\0{}",
        member.member_id, member.profile, member.handle, target
    );
    sha256_hex(material.as_bytes())[..24].to_owned()
}

fn sha256_hex(bytes: &[u8]) -> String {
    driver::payload_digest_str(&String::from_utf8_lossy(bytes))
}

/// 上游 `_truncate_utf8_text()`：按 UTF-8 字节截断，不劈开多字节字符。
pub fn truncate_utf8_text(value: &str, max_bytes: usize, suffix: &str) -> String {
    if value.len() <= max_bytes {
        return value.to_owned();
    }
    let keep = max_bytes.saturating_sub(suffix.len());
    // 从 keep 往前退到字符边界
    let mut end = keep.min(value.len());
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    let prefix = &value[..end];
    if prefix.is_empty() {
        suffix.trim().to_owned()
    } else {
        format!("{prefix}{suffix}")
    }
}

/// 上游 `_make_task_plan()` 的确定性 task id 部分。
///
/// task id = `dtask:` + sha256(seed)[..48]，seed 是 canonical JSON。
/// **lead routing 时 seed 不含 prompt**——因为 prompt 里有房间名与名册，
/// 改名/改昵称不该让已持久化的回执变成孤儿。
#[allow(clippy::too_many_arguments)]
pub fn make_task_id(
    discussion_event_id: &str,
    member: &DiscussionMember,
    member_index: i64,
    round_index: i64,
    seen_through_seq: i64,
    source_event_seq: i64,
    thread_id: &str,
    room_id: &str,
    prompt: &str,
    lead_routing: bool,
) -> String {
    let mut seed = Map::new();
    seed.insert(
        "discussion_event_id".into(),
        Value::String(discussion_event_id.to_owned()),
    );
    seed.insert("member_id".into(), Value::String(member.member_id.clone()));
    seed.insert("member_index".into(), Value::from(member_index));
    if !lead_routing {
        seed.insert(
            "prompt_sha256".into(),
            Value::String(sha256_hex(prompt.as_bytes())),
        );
    }
    seed.insert("room_id".into(), Value::String(room_id.to_owned()));
    seed.insert("round_index".into(), Value::from(round_index));
    seed.insert("seen_through_seq".into(), Value::from(seen_through_seq));
    seed.insert("source_event_seq".into(), Value::from(source_event_seq));
    seed.insert("thread_id".into(), Value::String(thread_id.to_owned()));
    if lead_routing {
        seed.insert("lead_routing".into(), Value::Bool(true));
    }

    let canonical = common::compact_json(&Value::Object(seed), false);
    let digest = sha256_hex(canonical.as_bytes());
    format!("dtask:{}", &digest[..48])
}

/// 上游 turn id：`d<seq>.r<round>.p<index>.s<seen>.m<member_digest>`。
pub fn make_turn_id(
    discussion_seq: i64,
    round_index: i64,
    member_index: i64,
    seen_through_seq: i64,
    member: &DiscussionMember,
) -> String {
    format!(
        "d{discussion_seq}.r{round_index}.p{member_index}.s{seen_through_seq}.m{}",
        member_digest(member)
    )
}

/// 上游 `EventPlan` 的便捷构造（发布计划用）。
pub fn event_plan(
    event_id: &str,
    kind: &str,
    actor: Value,
    payload: Value,
    room: &DiscussionRoom,
) -> EventPlan {
    EventPlan {
        event_id: event_id.to_owned(),
        kind: kind.to_owned(),
        actor,
        payload,
        authority_gateway_id: room.gateway_id.clone(),
        authority_epoch: room.authority_epoch,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hosted_rooms::discussion::{validate_room, MemberTarget};
    use serde_json::json;

    fn room() -> DiscussionRoom {
        let value = json!({
            "room_id": "room-1",
            "name": "Team",
            "authority_gateway_id": "gw-1",
            "authority_epoch": 1,
            "disbanded_at": null,
            "members": [
                {"member_id": "m-ada", "profile": "alice", "handle": "ada",
                 "target": {"kind": "local", "profile": "alice"}},
                {"member_id": "m-bob", "profile": "bob", "handle": "bob",
                 "target": {"kind": "local", "profile": "bob"}},
            ]
        });
        validate_room(&value, &["alice".to_owned(), "bob".to_owned()]).unwrap()
    }

    fn user_event(seq: i64, id: &str, thread: &str, text: &str) -> Value {
        json!({
            "room_id": "room-1", "seq": seq, "event_id": id, "kind": "message.user",
            "actor": {"kind": "user", "id": "user-1"},
            "payload": {"text": text, "thread_id": thread},
            "authority_epoch": 1,
        })
    }

    // ── validate_events ───────────────────────────────────────────────────

    #[test]
    fn validates_user_events_in_order() {
        let room = room();
        let events = vec![
            user_event(1, "e1", "t-1", "hello"),
            user_event(2, "e2", "t-1", "again"),
        ];
        let validated = validate_events(&events, &room).unwrap();
        assert_eq!(validated.len(), 2);
        assert_eq!(validated[0].seq, 1);
        assert_eq!(validated[1].seq, 2);
    }

    #[test]
    fn rejects_non_monotonic_seq() {
        let room = room();
        let events = vec![user_event(5, "e1", "t", "a"), user_event(3, "e2", "t", "b")];
        assert_eq!(
            validate_events(&events, &room).unwrap_err().message,
            "room events must be in strict sequence order"
        );
    }

    #[test]
    fn rejects_duplicate_event_ids() {
        let room = room();
        let events = vec![user_event(1, "e1", "t", "a"), user_event(2, "e1", "t", "b")];
        assert_eq!(
            validate_events(&events, &room).unwrap_err().message,
            "room event ids must be unique"
        );
    }

    #[test]
    fn rejects_wrong_room() {
        let room = room();
        let mut event = user_event(1, "e1", "t", "a");
        event["room_id"] = json!("other");
        assert_eq!(
            validate_events(&[event], &room).unwrap_err().message,
            "room event belongs to a different room"
        );
    }

    #[test]
    fn rejects_non_object_payload() {
        let room = room();
        let mut event = user_event(1, "e1", "t", "a");
        event["payload"] = json!("not an object");
        assert_eq!(
            validate_events(&[event], &room).unwrap_err().message,
            "event payload must be an object"
        );
    }

    // ── derive_member_watermarks ──────────────────────────────────────────

    #[test]
    fn derives_watermarks_from_terminal_events() {
        let room = room();
        let events = vec![
            user_event(1, "d1", "t-1", "hello"),
            json!({
                "room_id": "room-1", "seq": 2, "event_id": "m1", "kind": "message.member",
                "actor": {"kind": "member", "id": "m-ada", "profile": "alice"},
                "payload": {
                    "discussion_event_id": "d1", "member_id": "m-ada", "member_index": 0,
                    "round_index": 0, "task_id": "task-1", "thread_id": "t-1",
                    "turn_id": "turn-1", "text": "my answer"
                },
                "authority_epoch": 1,
            }),
            json!({
                "room_id": "room-1", "seq": 3, "event_id": "t1", "kind": "turn.settled",
                "actor": {"kind": "gateway", "id": "gw-1"},
                "payload": {
                    "discussion_event_id": "d1", "member_id": "m-ada", "member_index": 0,
                    "round_index": 0, "task_id": "task-1", "thread_id": "t-1",
                    "turn_id": "turn-1", "seen_through_seq": 2, "passed": false,
                    "message_event_id": "m1"
                },
                "authority_epoch": 1,
            }),
        ];
        let validated = validate_events(&events, &room).unwrap();
        let watermarks = derive_member_watermarks(&validated).unwrap();
        // watermark=2 (seen_through_seq)，discussion_seq=1，2 >= 1 → max(2, message.seq=2) = 2
        assert_eq!(watermarks.get(&("t-1".to_owned(), "m-ada".to_owned())), Some(&2));
    }

    #[test]
    fn rejects_duplicate_terminal_for_same_task() {
        let room = room();
        let terminal = |seq: i64, id: &str| {
            json!({
                "room_id": "room-1", "seq": seq, "event_id": id, "kind": "turn.failed",
                "actor": {"kind": "gateway", "id": "gw-1"},
                "payload": {
                    "discussion_event_id": "d1", "member_id": "m-ada", "member_index": 0,
                    "round_index": 0, "task_id": "task-1", "thread_id": "t-1",
                    "turn_id": "turn-1", "seen_through_seq": 1, "error": "boom"
                },
                "authority_epoch": 1,
            })
        };
        let events = vec![user_event(1, "d1", "t-1", "hi"), terminal(2, "x1"), terminal(3, "x2")];
        let validated = validate_events(&events, &room).unwrap();
        assert_eq!(
            derive_member_watermarks(&validated).unwrap_err().message,
            "task 'task-1' has more than one terminal room event"
        );
    }

    // ── pending_discussion ────────────────────────────────────────────────

    #[test]
    fn pending_returns_oldest_open_thread() {
        let room = room();
        let events = vec![
            user_event(1, "d1", "t-1", "first"),
            user_event(2, "d2", "t-2", "second"),
        ];
        let validated = validate_events(&events, &room).unwrap();
        let pending = pending_discussion(&validated).unwrap();
        assert_eq!(pending.event_id, "d1");
    }

    #[test]
    fn pending_uses_latest_per_thread() {
        let room = room();
        let events = vec![
            user_event(1, "d1", "t-1", "first"),
            user_event(2, "d1b", "t-1", "follow-up in same thread"),
        ];
        let validated = validate_events(&events, &room).unwrap();
        // 同一 thread 只有最新那条算候选
        let pending = pending_discussion(&validated).unwrap();
        assert_eq!(pending.event_id, "d1b");
    }

    #[test]
    fn pending_excludes_stopped() {
        let room = room();
        let events = vec![
            user_event(1, "d1", "t-1", "hi"),
            json!({
                "room_id": "room-1", "seq": 2, "event_id": "stop", "kind": "room.stop_requested",
                "actor": {"kind": "gateway", "id": "gw-1"},
                "payload": {"cancel_id": "c1"},
                "authority_epoch": 1,
            }),
        ];
        let validated = validate_events(&events, &room).unwrap();
        assert!(pending_discussion(&validated).is_none());
    }

    #[test]
    fn pending_excludes_completed_discussion() {
        let room = room();
        let events = vec![
            user_event(1, "d1", "t-1", "hi"),
            json!({
                "room_id": "room-1", "seq": 2, "event_id": "act", "kind": "room.activity",
                "actor": {"kind": "gateway", "id": "gw-1"},
                "payload": {"status": "settled", "reason_code": null, "thread_id": "t-1",
                            "discussion_event_id": "d1"},
                "authority_epoch": 1,
            }),
        ];
        let validated = validate_events(&events, &room).unwrap();
        assert!(pending_discussion(&validated).is_none());
    }

    #[test]
    fn continue_reopens_completed_discussion() {
        let room = room();
        let events = vec![
            user_event(1, "d1", "t-1", "hi"),
            json!({
                "room_id": "room-1", "seq": 2, "event_id": "act", "kind": "room.activity",
                "actor": {"kind": "gateway", "id": "gw-1"},
                "payload": {"status": "bounded", "reason_code": null, "thread_id": "t-1",
                            "discussion_event_id": "d1"},
                "authority_epoch": 1,
            }),
            // Continue 在 activity 之后 → 重新打开
            json!({
                "room_id": "room-1", "seq": 3, "event_id": "cont", "kind": "room.continued",
                "actor": {"kind": "gateway", "id": "gw-1"},
                "payload": {"discussion_event_id": "d1", "thread_id": "t-1", "grant": 1},
                "authority_epoch": 1,
            }),
        ];
        let validated = validate_events(&events, &room).unwrap();
        let pending = pending_discussion(&validated).unwrap();
        assert_eq!(pending.event_id, "d1");
    }

    // ── thread_messages ───────────────────────────────────────────────────

    #[test]
    fn thread_messages_only_includes_committed_member_messages() {
        let room = room();
        let events = vec![
            user_event(1, "d1", "t-1", "hi"),
            json!({
                "room_id": "room-1", "seq": 2, "event_id": "m-uncommitted", "kind": "message.member",
                "actor": {"kind": "member", "id": "m-ada", "profile": "alice"},
                "payload": {
                    "discussion_event_id": "d1", "member_id": "m-ada", "member_index": 0,
                    "round_index": 0, "task_id": "task-1", "thread_id": "t-1",
                    "turn_id": "turn-1", "text": "orphan"
                },
                "authority_epoch": 1,
            }),
        ];
        let validated = validate_events(&events, &room).unwrap();
        let discussion = &validated[0];
        let (thread, _, member_msgs) = thread_messages(&validated, discussion);
        // 未提交的成员消息不在 thread 里
        assert_eq!(thread.len(), 1);
        assert_eq!(thread[0].event_id, "d1");
        assert!(member_msgs.is_empty());
    }

    // ── 提示词工具 ────────────────────────────────────────────────────────

    #[test]
    fn truncate_respects_char_boundary() {
        // 中文 3 字节
        let text = "房间名字";
        let truncated = truncate_utf8_text(text, 4, "");
        // 只能保留 1 个完整字符（3 字节）
        assert_eq!(truncated, "房");
        // 加后缀：keep = 6 - 3 = 3 → 保留 "房" + "..."
        let truncated = truncate_utf8_text(text, 6, "...");
        assert_eq!(truncated, "房...");
        // keep 小于一个字符 → 只返回去空后的后缀
        let truncated = truncate_utf8_text(text, 2, "...");
        assert_eq!(truncated, "...");
    }

    #[test]
    fn truncate_noop_when_fits() {
        assert_eq!(truncate_utf8_text("short", 100, "..."), "short");
    }

    // ── task id 确定性 ────────────────────────────────────────────────────

    fn member() -> DiscussionMember {
        DiscussionMember {
            member_id: "m-ada".into(),
            profile: "alice".into(),
            handle: "ada".into(),
            display_name: "Ada".into(),
            target: MemberTarget::Local {
                profile: "alice".into(),
            },
        }
    }

    #[test]
    fn task_id_is_deterministic() {
        let m = member();
        let a = make_task_id("d1", &m, 0, 0, 1, 1, "t-1", "room-1", "prompt", false);
        let b = make_task_id("d1", &m, 0, 0, 1, 1, "t-1", "room-1", "prompt", false);
        assert_eq!(a, b);
        assert!(a.starts_with("dtask:"));
        assert_eq!(a.len(), "dtask:".len() + 48);
    }

    #[test]
    fn task_id_changes_with_prompt() {
        let m = member();
        let a = make_task_id("d1", &m, 0, 0, 1, 1, "t-1", "room-1", "prompt A", false);
        let b = make_task_id("d1", &m, 0, 0, 1, 1, "t-1", "room-1", "prompt B", false);
        assert_ne!(a, b);
    }

    #[test]
    fn lead_routing_task_id_ignores_prompt() {
        // 上游核心语义：routing turn 的 id 不含 prompt（改名不该让回执变孤儿）
        let m = member();
        let a = make_task_id("d1", &m, 0, 0, 1, 1, "t-1", "room-1", "prompt A", true);
        let b = make_task_id("d1", &m, 0, 0, 1, 1, "t-1", "room-1", "prompt B", true);
        assert_eq!(a, b);
    }

    #[test]
    fn turn_id_matches_parser_shape() {
        let m = member();
        let turn = make_turn_id(1, 0, 0, 1, &m);
        // 必须能被 turn_round 解析回同一轮次
        assert_eq!(crate::hosted_rooms::discussion::turn_round(&turn), Some(0));
        let turn = make_turn_id(5, 2, 1, 9, &m);
        assert_eq!(crate::hosted_rooms::discussion::turn_round(&turn), Some(2));
    }

    #[test]
    fn member_digest_is_stable_24_hex() {
        let m = member();
        let d1 = member_digest(&m);
        let d2 = member_digest(&m);
        assert_eq!(d1, d2);
        assert_eq!(d1.len(), 24);
        assert!(d1.bytes().all(|b| b.is_ascii_hexdigit()));
    }

    // ── requires_direct_reply ─────────────────────────────────────────────

    #[test]
    fn direct_reply_only_at_round_zero_with_mention() {
        let room = room();
        let discussion = ValidatedEvent {
            seq: 1,
            event_id: "d1".into(),
            kind: "message.user".into(),
            actor: json!({"kind": "user", "id": "u1"}),
            payload: json!({"text": "@ada please answer", "thread_id": "t-1"}),
        };
        let ada = &room.members[0];
        let bob = &room.members[1];

        assert!(requires_direct_reply(&room, Some(&discussion), ada, 0));
        // 没被点名
        assert!(!requires_direct_reply(&room, Some(&discussion), bob, 0));
        // 非首轮
        assert!(!requires_direct_reply(&room, Some(&discussion), ada, 1));
        // 没有 source
        assert!(!requires_direct_reply(&room, None, ada, 0));
    }
}
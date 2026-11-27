//! 讨论决策编排（hermes `gateway/hosted_room_discussion.py` 的 `plan_next_task()`）。
//!
//! ## 上游契约
//!
//! > Replay the complete room log and return **at most one** next member task.
//!
//! 这是整个讨论系统的顶层入口：吃一份房间 + 完整日志，吐**零或一个**下一步任务。
//! 所有下层（事件校验、水位、提示词、task id）都已在别处实现，本文件只做编排。
//!
//! ## 决策优先级（顺序即语义，与上游逐条一致）
//!
//! 1. **无待处理讨论** → `idle / no_pending_user_event`
//! 2. **消息数达上限** → `bounded / max_messages`
//! 3. **router 还在等**（`routing: auto` 且尚未记 `room.routed`）→ `route / router_pending`
//! 4. **lead 路由 turn** → `task / lead_routing`
//! 5. **逐轮扫描**：
//!    - 首轮 responders 由 lead > router > 提及解析决定
//!    - 后续轮只给「被 Bot 点名且之后没再发言」的成员
//!    - Continue 之后的那一轮若无点名 → 全员重新参与
//! 6. **该轮无人发言** → `settled / silent_round`
//! 7. **轮数达上限** → `bounded / max_rounds`
//!
//! ## Continue 的预算语义
//!
//! > Each Continue grants one more full budget of rounds and messages for the same discussion.
//!
//! 即 `max_rounds * (continues + 1)`、`max_messages * (continues + 1)`。

use serde_json::Value;

use super::common;
use super::decision_engine::{
    derive_member_watermarks, make_task_id, make_turn_id, pending_discussion, requires_direct_reply,
    thread_messages, validate_events, ValidatedEvent,
};
use super::discussion::{
    resolve_mentions, DiscussionError, DiscussionLimits, DiscussionMember, DiscussionRoom, DiscussResult,
};
use super::router;

// ── 决策结果 ────────────────────────────────────────────────────────────────

/// 上游 `DiscussionDecision`。
#[derive(Debug, Clone, PartialEq)]
pub struct DiscussionDecision {
    pub status: String,
    pub reason: String,
    pub discussion_event_id: Option<String>,
    pub source_event_seq: Option<i64>,
    pub thread_id: Option<String>,
    /// 下一个任务（`status == "task"` 时存在）。
    pub task: Option<PlannedTask>,
    /// 该讨论被 Continue 过几次。
    pub continues: usize,
}

/// 上游 `DiscussionTaskPlan`（只保留编排层需要的字段）。
#[derive(Debug, Clone, PartialEq)]
pub struct PlannedTask {
    pub task_id: String,
    pub turn_id: String,
    pub thread_id: String,
    pub member_id: String,
    pub member_index: i64,
    pub round_index: i64,
    pub seen_through_seq: i64,
    pub prompt: String,
    pub source_event_seq: i64,
}

/// 房间设置（上游 `room_context`）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RoomSettings {
    pub purpose: String,
    pub notes: String,
    pub routing: String,
    pub lead_member_id: String,
}

impl Default for RoomSettings {
    fn default() -> Self {
        Self {
            purpose: String::new(),
            notes: String::new(),
            routing: "everyone".to_owned(),
            lead_member_id: String::new(),
        }
    }
}

impl RoomSettings {
    /// 从 JSON 宽松读取（缺字段用默认值，非字符串转字符串）。
    pub fn from_json(value: Option<&Value>) -> Self {
        let read = |key: &str, fallback: &str| -> String {
            value
                .and_then(|v| v.get(key))
                .map(|v| match v {
                    Value::String(s) => s.clone(),
                    Value::Null => fallback.to_owned(),
                    other => other.to_string(),
                })
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| fallback.to_owned())
        };
        Self {
            purpose: read("purpose", ""),
            notes: read("notes", ""),
            routing: read("routing", "everyone"),
            lead_member_id: read("lead_member_id", ""),
        }
    }
}

// ── 编排 ────────────────────────────────────────────────────────────────────

fn decide(
    status: &str,
    reason: &str,
    discussion: &ValidatedEvent,
    continues: usize,
) -> DiscussionDecision {
    DiscussionDecision {
        status: status.to_owned(),
        reason: reason.to_owned(),
        discussion_event_id: Some(discussion.event_id.clone()),
        source_event_seq: Some(discussion.seq),
        thread_id: discussion
            .payload
            .get("thread_id")
            .and_then(Value::as_str)
            .map(str::to_owned),
        task: None,
        continues,
    }
}

/// 上游 `_first_round_responders()`：无提及 = 全员；定时帖只拉被 @ 的人，通知帖不拉任何人。
fn first_round_responders(discussion: &ValidatedEvent, room: &DiscussionRoom) -> Vec<DiscussionMember> {
    // 判定是否调度器作者（`cron:` / `cron-notice:` 前缀）
    let scheduled = scheduled_post_kind(&discussion.actor);
    if scheduled == Some("notice") {
        return Vec::new();
    }
    let text = discussion.payload.get("text").and_then(Value::as_str).unwrap_or("");
    // 定时结果帖：default_all = false（只拉被 @ 的）；人类消息：default_all = true
    resolve_mentions(&[text], &room.members, scheduled.is_none())
}

/// 上游 `scheduled_post_kind()`（复用 context 模块的语义）。
fn scheduled_post_kind(actor: &Value) -> Option<&'static str> {
    super::context::scheduled_post_kind(Some(actor))
}

/// 上游 `_rotate()`：按轮次旋转 responders。
fn rotate(members: &[DiscussionMember], round_index: i64) -> Vec<DiscussionMember> {
    if members.is_empty() {
        return Vec::new();
    }
    let shift = (round_index.rem_euclid(members.len() as i64)) as usize;
    let mut out = Vec::with_capacity(members.len());
    out.extend_from_slice(&members[shift..]);
    out.extend_from_slice(&members[..shift]);
    out
}

/// 上游 `_unaddressed_member_mentions()`：被 Bot 点名、且之后没再发言的成员。
fn unaddressed_member_mentions(messages: &[&ValidatedEvent], room: &DiscussionRoom) -> Vec<DiscussionMember> {
    let mut cited_at: std::collections::BTreeMap<String, i64> = std::collections::BTreeMap::new();
    let mut last_post_at: std::collections::BTreeMap<String, i64> = std::collections::BTreeMap::new();

    for event in messages.iter().filter(|e| e.kind == "message.member") {
        let speaker = event.payload.get("member_id").and_then(Value::as_str).unwrap_or("");
        last_post_at.insert(speaker.to_owned(), event.seq);

        let text = event.payload.get("text").and_then(Value::as_str).unwrap_or("");
        for member in resolve_mentions(&[text], &room.members, false) {
            if member.member_id != speaker {
                cited_at.insert(member.member_id.clone(), event.seq);
            }
        }
    }

    room.members
        .iter()
        .filter(|member| {
            cited_at
                .get(&member.member_id)
                .is_some_and(|cited| last_post_at.get(&member.member_id).copied().unwrap_or(0) <= *cited)
        })
        .cloned()
        .collect()
}

/// 上游 `_context_lines()`：purpose/notes 渲染进 user-role turn prompt。
fn context_lines(settings: &RoomSettings) -> Vec<String> {
    let mut lines = Vec::new();
    if !settings.purpose.is_empty() {
        lines.push(format!(
            "Room purpose (set by the user): {}",
            settings.purpose
        ));
    }
    if !settings.notes.is_empty() {
        lines.push("Room notes (shared with every member; the user keeps them in room settings):".to_owned());
        for line in settings.notes.lines() {
            lines.push(format!("  {line}"));
        }
    }
    if lines.is_empty() {
        return Vec::new();
    }
    lines.push(String::new());
    lines
}

/// 上游 `_format_message()`：把一条事件渲染成 prompt 里的一行。
fn format_message(event: &ValidatedEvent, room: &DiscussionRoom) -> String {
    let text = event.payload.get("text").and_then(Value::as_str).unwrap_or("");
    if event.kind == "message.user" {
        return match scheduled_post_kind(&event.actor) {
            None => format!("User (user): {text}"),
            Some(_) => {
                let job = event
                    .actor
                    .get("display_name")
                    .or_else(|| event.actor.get("id"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                format!("Scheduled job \"{job}\" (automated post, not the user): {text}")
            }
        };
    }
    let member_id = event.payload.get("member_id").and_then(Value::as_str).unwrap_or("");
    let handle = room
        .members
        .iter()
        .find(|m| m.member_id == member_id)
        .map(|m| m.handle.as_str())
        .unwrap_or(member_id);
    format!("@{handle}: {text}")
}

/// 上游 `_build_prompt()`：成员 turn 的提示词（含字节预算裁剪）。
#[allow(clippy::too_many_arguments)]
pub fn build_turn_prompt(
    room: &DiscussionRoom,
    member: &DiscussionMember,
    messages: &[&ValidatedEvent],
    watermark: i64,
    seen_through_seq: i64,
    settings: &RoomSettings,
    reply_required: bool,
    routed: bool,
) -> DiscussResult<String> {
    // delta = watermark < seq <= seen_through_seq，取最后 24 条
    let mut delta: Vec<&ValidatedEvent> = messages
        .iter()
        .copied()
        .filter(|e| e.seq > watermark && e.seq <= seen_through_seq)
        .collect();
    if delta.len() > super::discussion::MAX_DISCUSSION_DELTA_LINES {
        delta = delta[delta.len() - super::discussion::MAX_DISCUSSION_DELTA_LINES..].to_vec();
    }

    let peers: Vec<String> = room
        .members
        .iter()
        .filter(|m| m.member_id != member.member_id)
        .map(|m| format!("@{}", m.handle))
        .collect();
    let peers_text = if peers.is_empty() {
        "no other members".to_owned()
    } else {
        peers.join(", ")
    };

    let mut opening = vec![format!(
        "[Discussion: \"{}\"] You are @{}, one participant with {} and the user.",
        room.name, member.handle, peers_text
    )];
    opening.push(String::new());
    opening.extend(context_lines(settings));
    opening.push("New messages in this thread since your last turn (oldest first):".to_owned());

    let addressed = if routed {
        "- The room picked you to answer the user's message.".to_owned()
    } else {
        "- The user directly addressed you.".to_owned()
    };
    let participation = if reply_required || routed {
        vec![
            format!("{addressed} Reply with your answer, result, or concrete blocker."),
            "- Do not return \"(pass)\". If you cannot proceed, explain why and what you need from the user."
                .to_owned(),
        ]
    } else {
        vec![
            "- Reply with one conversational message only when you have something new worth adding.".to_owned(),
            "- If you have nothing new to add, reply with exactly \"(pass)\".".to_owned(),
        ]
    };

    let mut rules = vec![String::new(), "Rules for this Discussion:".to_owned()];
    rules.extend(participation);
    rules.push("- Mention a teammate by handle to pull them into the next round; do not repeat points already made.".to_owned());
    rules.push("- Never reveal content from private conversations. Your reply is published verbatim.".to_owned());

    // 预算：prompt 总字节上限
    let fixed_bytes = opening.join("\n").len() + rules.join("\n").len();
    let mut available = super::driver::MAX_PROMPT_BYTES.saturating_sub(fixed_bytes).saturating_sub(1);

    let mut selected: Vec<String> = Vec::new();
    for event in delta.iter().rev() {
        let line = format!("  {}", format_message(event, room));
        let line_bytes = line.len() + 1;
        if line_bytes > available {
            if selected.is_empty() && available > 32 {
                selected.push(super::decision_engine::truncate_utf8_text(&line, available, ""));
            }
            selected.push("  [Earlier content omitted to fit this turn.]".to_owned());
            break;
        }
        selected.push(line);
        available -= line_bytes;
    }
    selected.reverse();

    let mut all = opening;
    all.extend(selected);
    all.extend(rules);
    let prompt = all.join("\n");
    if prompt.len() > super::driver::MAX_PROMPT_BYTES {
        return Err(DiscussionError {
            code: "validation",
            message: "Discussion prompt exceeds the driver limit".into(),
        });
    }
    Ok(prompt)
}

/// 上游 `plan_next_task()`：**顶层入口**。
///
/// 返回零或一个下一步决策。所有输入都是纯数据，函数无副作用。
pub fn plan_next_task(
    room: &DiscussionRoom,
    raw_events: &[Value],
    settings: &RoomSettings,
    limits: DiscussionLimits,
) -> DiscussResult<DiscussionDecision> {
    limits.validate()?;

    let validated = validate_events(raw_events, room)?;

    // 1) 无待处理讨论
    let Some(discussion) = pending_discussion(&validated) else {
        return Ok(DiscussionDecision {
            status: super::discussion::STATUS_IDLE.to_owned(),
            reason: "no_pending_user_event".to_owned(),
            discussion_event_id: None,
            source_event_seq: None,
            thread_id: None,
            task: None,
            continues: 0,
        });
    };
    let discussion = discussion.clone();

    let continues = count_continues(&validated, &discussion.event_id);
    // 每次 Continue 给一整份额度
    let max_rounds = limits.max_rounds * (continues as i64 + 1);
    let max_messages = limits.max_messages * (continues as i64 + 1);

    let (thread_msgs, _discussion_msgs, member_msgs) = thread_messages(&validated, &discussion);
    let thread_id = discussion.payload.get("thread_id").and_then(Value::as_str).unwrap_or("");

    // 2) 消息数达上限
    if member_msgs.len() as i64 >= max_messages {
        return Ok(decide("bounded", "max_messages", &discussion, continues));
    }

    // 3) router 还在等（routing: auto 且没有 room.routed）
    let routed_responders = if settings.routing == "auto" {
        match router::routed_event(&to_log_events(&validated), &discussion.event_id) {
            None => return Ok(decide("route", "router_pending", &discussion, continues)),
            Some(event) => {
                let everyone = event.payload.get("everyone").and_then(Value::as_bool).unwrap_or(false);
                if everyone {
                    Some(room.members.clone())
                } else {
                    let chosen: std::collections::BTreeSet<&str> = event
                        .payload
                        .get("member_ids")
                        .and_then(Value::as_array)
                        .map(|a| a.iter().filter_map(Value::as_str).collect())
                        .unwrap_or_default();
                    Some(
                        room.members
                            .iter()
                            .filter(|m| chosen.contains(m.member_id.as_str()))
                            .cloned()
                            .collect(),
                    )
                }
            }
        }
    } else {
        None
    };

    // 4) 逐轮扫描
    let watermarks = derive_member_watermarks(&validated)?;
    let resume_round = router::resume_round(
        &to_log_events(&validated),
        &discussion.event_id,
        &to_log_events_refs(&member_msgs),
    );

    // 已结算的 (round, member) 组合（排除 lead routing turn）。
    //
    // **`turn.deferred` 不算结清**（hermes `hosted_room_lead`："turn.deferred
    // is not terminal: it awaits Retry or Discard"）：成员不可用被 defer 后，
    // plan 继续给出同一 (round, member) 的同一个 task_id，由前端驱动按日志
    // 暂停（不重跑）并展示 Retry 卡；重试成功写 settled、丢弃写 cancelled
    // 后才推进。若把它当终态，房间会越过一个没说话的成员继续下一轮。
    let terminals: std::collections::BTreeSet<(i64, String)> = validated
        .iter()
        .filter(|e| super::decision_engine::TERMINAL_KINDS.contains(&e.kind.as_str()))
        .filter(|e| e.kind != "turn.deferred")
        .filter(|e| {
            e.payload.get("discussion_event_id").and_then(Value::as_str)
                == Some(discussion.event_id.as_str())
        })
        .filter_map(|e| {
            let round = e.payload.get("round_index").and_then(common::json_i64)?;
            let member = e.payload.get("member_id").and_then(Value::as_str)?.to_owned();
            Some((round, member))
        })
        .collect();

    for round_index in 0..max_rounds {
        let responders: Vec<DiscussionMember> = if round_index == 0 {
            match &routed_responders {
                Some(list) => list.clone(),
                None => first_round_responders(&discussion, room),
            }
        } else {
            unaddressed_member_mentions(&member_msgs, room)
        };

        let responders = if responders.is_empty() && Some(round_index) == resume_round {
            // Continue 之后那一轮：没人被点名 → 全员重新参与
            room.members.clone()
        } else {
            responders
        };

        let rotated = rotate(&responders, round_index);

        for (member_index, member) in rotated.iter().enumerate() {
            let watermark = watermarks
                .get(&(thread_id.to_owned(), member.member_id.clone()))
                .copied()
                .unwrap_or(0);

            // delta：watermark 之后的消息
            let delta: Vec<&ValidatedEvent> = thread_msgs
                .iter()
                .copied()
                .filter(|e| e.seq > watermark)
                .collect();

            if delta.is_empty() || terminals.contains(&(round_index, member.member_id.clone())) {
                continue;
            }

            let seen_through_seq = delta.last().map(|e| e.seq).unwrap_or(watermark);
            let reply_required = requires_direct_reply(room, Some(&discussion), member, round_index);
            let routed_flag = round_index == 0
                && routed_responders
                    .as_ref()
                    .is_some_and(|list| list.len() < room.members.len());

            let prompt = build_turn_prompt(
                room,
                member,
                &thread_msgs,
                watermark,
                seen_through_seq,
                settings,
                reply_required,
                routed_flag,
            )?;

            let task_id = make_task_id(
                &discussion.event_id,
                member,
                member_index as i64,
                round_index,
                seen_through_seq,
                discussion.seq,
                thread_id,
                &room.room_id,
                &prompt,
                false,
            );
            let turn_id = make_turn_id(
                discussion.seq,
                round_index,
                member_index as i64,
                seen_through_seq,
                member,
            );

            let mut decision = decide("task", "member_turn", &discussion, continues);
            decision.task = Some(PlannedTask {
                task_id,
                turn_id,
                thread_id: thread_id.to_owned(),
                member_id: member.member_id.clone(),
                member_index: member_index as i64,
                round_index,
                seen_through_seq,
                prompt,
                source_event_seq: discussion.seq,
            });
            return Ok(decision);
        }

        // 该轮无人发言
        let had_member_message = member_msgs
            .iter()
            .any(|e| e.payload.get("round_index").and_then(common::json_i64) == Some(round_index));
        if !had_member_message {
            return Ok(decide("settled", "silent_round", &discussion, continues));
        }
        if round_index == max_rounds - 1 {
            return Ok(decide("bounded", "max_rounds", &discussion, continues));
        }
    }

    Err(DiscussionError {
        code: "validation",
        message: "bounded Discussion loop exhausted unexpectedly".into(),
    })
}

/// 上游 `router.continue_count()`。
fn count_continues(events: &[ValidatedEvent], discussion_event_id: &str) -> usize {
    events
        .iter()
        .filter(|e| e.kind == router::CONTINUED_EVENT_KIND)
        .filter(|e| {
            e.payload.get("discussion_event_id").and_then(Value::as_str) == Some(discussion_event_id)
        })
        .count()
}

/// 把 `ValidatedEvent` 转成 router 模块的 `LogEvent`。
fn to_log_events(events: &[ValidatedEvent]) -> Vec<router::LogEvent> {
    events
        .iter()
        .map(|e| router::LogEvent {
            seq: e.seq,
            event_id: e.event_id.clone(),
            kind: e.kind.clone(),
            payload: e.payload.as_object().cloned().unwrap_or_default(),
        })
        .collect()
}

fn to_log_events_refs(events: &[&ValidatedEvent]) -> Vec<router::LogEvent> {
    events
        .iter()
        .map(|e| router::LogEvent {
            seq: e.seq,
            event_id: e.event_id.clone(),
            kind: e.kind.clone(),
            payload: e.payload.as_object().cloned().unwrap_or_default(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hosted_rooms::discussion::validate_room;
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

    fn settings() -> RoomSettings {
        RoomSettings::default()
    }

    // ── 基本决策 ──────────────────────────────────────────────────────────

    #[test]
    fn no_events_yields_idle() {
        let decision = plan_next_task(&room(), &[], &settings(), DiscussionLimits::default()).unwrap();
        assert_eq!(decision.status, "idle");
        assert_eq!(decision.reason, "no_pending_user_event");
        assert!(decision.task.is_none());
    }

    #[test]
    fn unaddressed_message_plans_first_member_turn() {
        let room = room();
        let events = vec![user_event(1, "d1", "t-1", "hello everyone")];
        let decision = plan_next_task(&room, &events, &settings(), DiscussionLimits::default()).unwrap();
        assert_eq!(decision.status, "task");
        assert_eq!(decision.reason, "member_turn");
        let task = decision.task.unwrap();
        // 无提及 → 全员 → 旋转后第一个是 ada
        assert_eq!(task.member_id, "m-ada");
        assert_eq!(task.round_index, 0);
        assert_eq!(task.member_index, 0);
        assert_eq!(task.seen_through_seq, 1);
        assert!(task.task_id.starts_with("dtask:"));
        assert!(task.prompt.contains("hello everyone"));
    }

    #[test]
    fn mention_selects_specific_member() {
        let room = room();
        let events = vec![user_event(1, "d1", "t-1", "@bob please handle this")];
        let decision = plan_next_task(&room, &events, &settings(), DiscussionLimits::default()).unwrap();
        let task = decision.task.unwrap();
        assert_eq!(task.member_id, "m-bob");
        // 被直接点名 → prompt 含 required 语气
        assert!(task.prompt.contains("Do not return \"(pass)\""));
    }

    #[test]
    fn decision_is_deterministic() {
        let room = room();
        let events = vec![user_event(1, "d1", "t-1", "hello")];
        let a = plan_next_task(&room, &events, &settings(), DiscussionLimits::default()).unwrap();
        let b = plan_next_task(&room, &events, &settings(), DiscussionLimits::default()).unwrap();
        assert_eq!(a, b, "同一份日志必须算出同一个决策");
    }

    // ── router pending ────────────────────────────────────────────────────

    #[test]
    fn auto_routing_waits_for_router_answer() {
        let room = room();
        let events = vec![user_event(1, "d1", "t-1", "hello")];
        let mut s = settings();
        s.routing = "auto".to_owned();
        let decision = plan_next_task(&room, &events, &s, DiscussionLimits::default()).unwrap();
        assert_eq!(decision.status, "route");
        assert_eq!(decision.reason, "router_pending");
    }

    // ── Continue 重开 ─────────────────────────────────────────────────────

    #[test]
    fn continue_grants_more_budget() {
        let room = room();
        // 构造：一条 user 消息 + activity bounded。之后 Continue 重开。
        let events = vec![
            user_event(1, "d1", "t-1", "hello"),
            json!({
                "room_id": "room-1", "seq": 2, "event_id": "act", "kind": "room.activity",
                "actor": {"kind": "gateway", "id": "gw-1"},
                "payload": {"status": "bounded", "reason_code": null, "thread_id": "t-1",
                            "discussion_event_id": "d1"},
                "authority_epoch": 1,
            }),
            json!({
                "room_id": "room-1", "seq": 3, "event_id": "cont", "kind": "room.continued",
                "actor": {"kind": "gateway", "id": "gw-1"},
                "payload": {"discussion_event_id": "d1", "thread_id": "t-1", "grant": 1},
                "authority_epoch": 1,
            }),
        ];
        let decision = plan_next_task(&room, &events, &settings(), DiscussionLimits::default()).unwrap();
        // 重开后继续规划（不是 bounded）
        assert_eq!(decision.status, "task");
        assert_eq!(decision.continues, 1);
    }

    // ── 上限 ──────────────────────────────────────────────────────────────

    #[test]
    fn rejects_invalid_limits() {
        let room = room();
        let bad = DiscussionLimits {
            max_rounds: 0,
            max_messages: 10,
        };
        assert!(plan_next_task(&room, &[], &settings(), bad).is_err());
    }

    // ── 提示词构建 ────────────────────────────────────────────────────────

    #[test]
    fn prompt_includes_context_lines() {
        let room = room();
        let events = vec![user_event(1, "d1", "t-1", "hi")];
        let validated = validate_events(&events, &room).unwrap();
        let mut s = settings();
        s.purpose = "ship the thing".to_owned();
        s.notes = "line one\nline two".to_owned();

        let prompt = build_turn_prompt(
            &room,
            &room.members[0],
            &validated.iter().collect::<Vec<_>>(),
            0,
            1,
            &s,
            false,
            false,
        )
        .unwrap();

        assert!(prompt.contains("Room purpose (set by the user): ship the thing"));
        assert!(prompt.contains("Room notes (shared with every member"));
        assert!(prompt.contains("  line one"));
        assert!(prompt.contains("  line two"));
        assert!(prompt.contains("You are @ada, one participant with @bob and the user"));
    }

    #[test]
    fn prompt_offers_pass_when_not_required() {
        let room = room();
        let events = vec![user_event(1, "d1", "t-1", "hi")];
        let validated = validate_events(&events, &room).unwrap();
        let prompt = build_turn_prompt(
            &room,
            &room.members[0],
            &validated.iter().collect::<Vec<_>>(),
            0,
            1,
            &settings(),
            false,
            false,
        )
        .unwrap();
        assert!(prompt.contains("reply with exactly \"(pass)\""));
        assert!(!prompt.contains("Do not return"));
    }

    #[test]
    fn prompt_requires_reply_when_addressed() {
        let room = room();
        let events = vec![user_event(1, "d1", "t-1", "hi")];
        let validated = validate_events(&events, &room).unwrap();
        let prompt = build_turn_prompt(
            &room,
            &room.members[0],
            &validated.iter().collect::<Vec<_>>(),
            0,
            1,
            &settings(),
            true,
            false,
        )
        .unwrap();
        assert!(prompt.contains("Do not return \"(pass)\""));
        assert!(!prompt.contains("reply with exactly"));
    }

    // ── rotate ────────────────────────────────────────────────────────────

    #[test]
    fn rotate_shifts_by_round() {
        let members = room().members;
        let r0 = rotate(&members, 0);
        assert_eq!(r0[0].member_id, "m-ada");
        let r1 = rotate(&members, 1);
        assert_eq!(r1[0].member_id, "m-bob");
        // 环绕
        let r2 = rotate(&members, 2);
        assert_eq!(r2[0].member_id, "m-ada");
    }

    #[test]
    fn rotate_empty_is_safe() {
        assert!(rotate(&[], 5).is_empty());
    }

    // ── first_round_responders ────────────────────────────────────────────

    #[test]
    fn scheduled_notice_pulls_nobody() {
        let room = room();
        let discussion = ValidatedEvent {
            seq: 1,
            event_id: "d1".into(),
            kind: "message.user".into(),
            actor: json!({"kind": "user", "id": "cron-notice:job-1"}),
            payload: json!({"text": "@ada failed", "thread_id": "t-1"}),
        };
        // 通知帖永不拉人（即使文本里 @ 了人）
        assert!(first_round_responders(&discussion, &room).is_empty());
    }

    #[test]
    fn scheduled_post_pulls_only_mentioned() {
        let room = room();
        let discussion = ValidatedEvent {
            seq: 1,
            event_id: "d1".into(),
            kind: "message.user".into(),
            actor: json!({"kind": "user", "id": "cron:job-1"}),
            payload: json!({"text": "@bob result ready", "thread_id": "t-1"}),
        };
        let responders = first_round_responders(&discussion, &room);
        assert_eq!(responders.len(), 1);
        assert_eq!(responders[0].member_id, "m-bob");
    }

    // ── RoomSettings ──────────────────────────────────────────────────────

    #[test]
    fn settings_default_to_everyone() {
        let s = RoomSettings::from_json(None);
        assert_eq!(s.routing, "everyone");
        assert!(s.purpose.is_empty());
    }

    #[test]
    fn settings_read_from_json() {
        let s = RoomSettings::from_json(Some(&json!({
            "purpose": "ship",
            "routing": "lead",
            "lead_member_id": "m-ada",
        })));
        assert_eq!(s.purpose, "ship");
        assert_eq!(s.routing, "lead");
        assert_eq!(s.lead_member_id, "m-ada");
        // notes 缺失 → 空
        assert!(s.notes.is_empty());
    }
}
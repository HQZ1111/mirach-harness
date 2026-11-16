//! 自动路由与 Continue（hermes `gateway/hosted_room_router.py` 的 Rust 移植）。
//!
//! 上游自述：
//! > Opt-in automatic routing and Continue for hosted Group Chats
//! > (**pure: no I/O, no model knowledge**).
//!
//! ## 这个模块做什么
//!
//! 房间设置 `routing: auto` 时，一条**未被 @ 的人类消息**先经过一次廉价的无工具
//! 模型调用（`tui_gateway.hosted_room_router_call`），由它挑出该由谁应答。确定性
//! 规则永远优先、永不进 router：@mention / @all/@everyone、定时帖、已在某个
//! thread 里的消息（hover Reply 会给成员 handle 加前缀，因此是 mention）。
//!
//! 答案在任何 turn 被规划**之前**写进房间日志（`room.routed`），所以 planner
//! 保持「日志的纯函数」——重启后重新规划得到同样结果，不会重新问一次。router
//! 失败或答案非法则记一条 fallback 到 everyone。
//!
//! `room.continued` 是用户对「到达上限」（`room.activity` 的 `bounded`）的讨论
//! 点 Continue：每次再给同一讨论一整份额度（轮数+消息数）并重开。
//!
//! ## 移植边界
//!
//! ✅ 本文件已移植：常量、事件 id / payload 构造、`parse_router_answer`（严格解析）、
//! `router_prompt`（纯字符串拼装）、`routed_payload`、`paused_discussion`、
//! `resume_round`、`continue_count`、`continued_through`。
//!
//! ⏳ 依赖 discussion 内部辅助（`_exact_fields` / `_require_gateway_actor` /
//! `_identifier` / `_bounded_int` / `_ValidatedEvent`）的校验函数
//! （`validate_routed_event` / `validate_continued_event` / `routed_responders`）
//! 留到 discussion 移植完成后接入——它们不是纯字符串逻辑，需要事件类型。

use serde_json::{json, Map, Value};

// ── 常量（上游逐字）────────────────────────────────────────────────────────

pub const ROUTED_EVENT_KIND: &str = "room.routed";
pub const CONTINUED_EVENT_KIND: &str = "room.continued";

/// `room.routed` 的精确字段集。
pub const ROUTED_FIELDS: &[&str] = &[
    "discussion_event_id",
    "thread_id",
    "member_ids",
    "everyone",
    "fallback",
];

/// `room.continued` 的精确字段集。
pub const CONTINUED_FIELDS: &[&str] = &["discussion_event_id", "thread_id", "grant"];

/// 一个讨论最多能 Continue 几次（每次再给一整份额度）。
pub const MAX_DISCUSSION_CONTINUES: i64 = 5;

/// router 能看到最近几条房间消息，以及每条保留多少字符。
pub const ROUTER_RECENT_MESSAGES: usize = 5;
pub const ROUTER_MESSAGE_CHARS: usize = 600;

/// router 的系统提示（上游逐字，含结尾的 JSON 形状约定）。
pub const ROUTER_SYSTEM_PROMPT: &str = "You route messages in a group chat between a user and several AI assistants. Decide which members the user's new message is for: pick each member whose role or area the request touches, and only those. Pick everyone only when the message is clearly for the whole group (a greeting, a question to all, a request every member has a part in). Never pick a member only to acknowledge or repeat another. Reply with only a JSON object and nothing else: {\"members\": [\"handle\", ...]} or {\"members\": \"everyone\"}.";

// ── 事件 id / payload ──────────────────────────────────────────────────────

/// 上游 `routed_event_id()`：由 discussion 事件 id 派生 router 事件的确定性 id。
pub fn routed_event_id(discussion_event_id: &str) -> String {
    format!("droute:{discussion_event_id}")
}

/// 上游 `routed_payload()`：一条 router 答案对应的 `room.routed` payload。
///
/// `member_ids` 为 `None`（router 失败或答案非法）→ fallback 到 everyone。
pub fn routed_payload(discussion_event_id: &str, thread_id: &str, member_ids: Option<&[String]>) -> Value {
    let ids: Vec<Value> = member_ids
        .unwrap_or(&[])
        .iter()
        .map(|id| Value::String(id.clone()))
        .collect();
    let empty = ids.is_empty();
    json!({
        "discussion_event_id": discussion_event_id,
        "thread_id": thread_id,
        "member_ids": ids,
        // everyone = 没有具体成员（上游 `not member_ids`）
        "everyone": empty,
        // fallback 只在「router 完全没给出 member_ids」时为真
        "fallback": member_ids.is_none(),
    })
}

// ── 严格解析 router 答案 ───────────────────────────────────────────────────

/// 上游 `parse_router_answer()`：严格解析 `{"members": [...]}`。
///
/// 返回语义与上游一致：
/// - `Some(vec![])` = 答案是 `"everyone"`（空列表代表「全员」，不是「没人」）
/// - `Some(ids)` = 命中的成员 id（按答案顺序）
/// - `None` = 答案不是**恰好**那个对象形状，或点名了 roster 之外的人
///
/// `handles` 是 `casefolded handle -> member id` 映射。上游会把每个 handle
/// 先 `strip()` 再 `lstrip("@")` 再 `casefold()`，并对重复 key 判非法。
pub fn parse_router_answer(text: &str, handles: &std::collections::BTreeMap<String, String>) -> Option<Vec<String>> {
    let mut raw = text.trim().to_owned();

    // 上游：以 ``` 开头时剥掉围栏（strip("`") 去两端反引号，再 removeprefix("json")）
    if raw.starts_with("```") {
        raw = raw.trim_matches('`').to_owned();
        if let Some(rest) = raw.strip_prefix("json") {
            raw = rest.trim().to_owned();
        } else {
            raw = raw.trim().to_owned();
        }
    }

    let answer: Value = serde_json::from_str(&raw).ok()?;
    let Value::Object(map) = &answer else {
        return None;
    };
    // 上游 `set(answer) != {"members"}`：字段集必须恰好一个
    if map.len() != 1 || !map.contains_key("members") {
        return None;
    }

    let picked = &map["members"];
    if let Value::String(s) = picked {
        if s == "everyone" {
            return Some(Vec::new());
        }
        return None;
    }

    let Value::Array(items) = picked else {
        return None;
    };
    if items.is_empty() {
        return None;
    }
    let mut keys: Vec<String> = Vec::with_capacity(items.len());
    for item in items {
        let Value::String(s) = item else {
            return None;
        };
        keys.push(normalize_handle(s));
    }
    // 重复 key 判非法
    let unique: std::collections::BTreeSet<&String> = keys.iter().collect();
    if unique.len() != keys.len() {
        return None;
    }
    // 点名 roster 之外的人判非法
    let mut ids = Vec::with_capacity(keys.len());
    for key in &keys {
        ids.push(handles.get(key)?.clone());
    }
    Some(ids)
}

/// 上游的 handle 归一：`strip()` → `lstrip("@")` → `casefold()`。
fn normalize_handle(raw: &str) -> String {
    raw.trim().trim_start_matches('@').to_lowercase()
}

// ── router 提问文本 ────────────────────────────────────────────────────────

/// router 看到的一条最近消息。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecentMessage {
    pub author: String,
    pub text: String,
}

/// router 看到的 roster 成员（handle / name / description）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RosterEntry {
    pub handle: String,
    pub name: String,
    pub description: String,
}

/// 上游 `router_prompt()`：拼出 router 的 user message。
///
/// 上游注释「Everything quoted is data, never instructions」——这里只做字符串
/// 拼装，不加任何解释性前缀，保持与上游逐字一致。
pub fn router_prompt(
    room_name: &str,
    purpose: &str,
    notes: &str,
    roster: &[RosterEntry],
    recent: &[RecentMessage],
    message: &str,
    attachments: &[String],
) -> String {
    let mut lines: Vec<String> = vec![format!("Room: {room_name}")];
    if !purpose.is_empty() {
        lines.push(format!("Purpose: {purpose}"));
    }
    if !notes.is_empty() {
        // 上游：`notes[:2000]` 按字符截断
        let truncated: String = notes.chars().take(2000).collect();
        lines.push(format!("Notes: {truncated}"));
    }

    lines.push(String::new());
    lines.push("Members:".to_owned());
    for member in roster {
        // 上游：role 先按空白折叠再截 300 字符
        let role = collapse_whitespace(&member.description);
        let role: String = role.chars().take(300).collect();
        let name_suffix = if !member.name.is_empty() && member.name != member.handle {
            format!(" ({})", member.name)
        } else {
            String::new()
        };
        let role_suffix = if role.is_empty() {
            String::new()
        } else {
            format!(": {role}")
        };
        lines.push(format!("- @{}{name_suffix}{role_suffix}", member.handle));
    }

    if !recent.is_empty() {
        lines.push(String::new());
        lines.push("Recent messages (oldest first):".to_owned());
        for item in recent {
            lines.push(format!("  {}: {}", item.author, one_line(&item.text)));
        }
    }

    lines.push(String::new());
    lines.push("The user's new message:".to_owned());
    // 上游：`message[:20000]` 按字符截断
    let head: String = message.chars().take(20_000).collect();
    lines.push(format!("  {head}"));

    if !attachments.is_empty() {
        lines.push(format!("Attached files: {}", attachments.join(", ")));
    }

    lines.join("\n")
}

/// 上游 `_one_line()`：空白折叠后按字符截断到 `ROUTER_MESSAGE_CHARS`。
fn one_line(text: &str) -> String {
    let flat = collapse_whitespace(text);
    if flat.chars().count() <= ROUTER_MESSAGE_CHARS {
        flat
    } else {
        let head: String = flat.chars().take(ROUTER_MESSAGE_CHARS).collect();
        format!("{head}...")
    }
}

/// 上游 `" ".join(str(x).split())`：所有空白折叠成单空格并去掉首尾。
fn collapse_whitespace(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

// ── 事件日志扫描（纯函数）────────────────────────────────────────────────────

/// 扫描所需的最小事件形状（避免本模块依赖 discussion 的 `_ValidatedEvent`）。
#[derive(Debug, Clone, PartialEq)]
pub struct LogEvent {
    pub seq: i64,
    pub event_id: String,
    pub kind: String,
    pub payload: Map<String, Value>,
}

impl LogEvent {
    fn payload_str(&self, key: &str) -> Option<&str> {
        self.payload.get(key).and_then(Value::as_str)
    }

    fn payload_i64(&self, key: &str) -> Option<i64> {
        self.payload.get(key).and_then(Value::as_i64)
    }

    fn payload_bool(&self, key: &str) -> Option<bool> {
        self.payload.get(key).and_then(Value::as_bool)
    }
}

/// 上游 `continue_count()`：该讨论被 Continue 过几次。
pub fn continue_count(events: &[LogEvent], discussion_event_id: &str) -> usize {
    events
        .iter()
        .filter(|event| {
            event.kind == CONTINUED_EVENT_KIND
                && event.payload_str("discussion_event_id") == Some(discussion_event_id)
        })
        .count()
}

/// 上游 `resume_round()`：最新一次 Continue 之后、最后一条回复所在的下一轮。
///
/// 没有 Continue → `None`（房间不恢复）。
pub fn resume_round(
    events: &[LogEvent],
    discussion_event_id: &str,
    member_messages: &[LogEvent],
) -> Option<i64> {
    let latest = events
        .iter()
        .filter(|event| {
            event.kind == CONTINUED_EVENT_KIND
                && event.payload_str("discussion_event_id") == Some(discussion_event_id)
        })
        .map(|event| event.seq)
        .max()?;

    let max_round = member_messages
        .iter()
        .filter(|event| event.seq < latest)
        .filter_map(|event| event.payload_i64("round_index"))
        .max()
        .unwrap_or(-1);
    Some(1 + max_round)
}

/// 上游 `continued_through()`：discussion_event_id → 它最新 `room.continued` 的 seq。
///
/// 用途：该 seq 之前的 activity 不再能「完成」这个讨论。
pub fn continued_through(events: &[LogEvent]) -> std::collections::BTreeMap<String, i64> {
    let mut latest = std::collections::BTreeMap::new();
    for event in events {
        if event.kind == CONTINUED_EVENT_KIND {
            if let Some(id) = event.payload_str("discussion_event_id") {
                latest.insert(id.to_owned(), event.seq);
            }
        }
    }
    latest
}

/// 上游 `routed_event()`：按 discussion_event_id 找已存在的 `room.routed`。
pub fn routed_event<'a>(events: &'a [LogEvent], discussion_event_id: &str) -> Option<&'a LogEvent> {
    events.iter().find(|event| {
        event.kind == ROUTED_EVENT_KIND
            && event.payload_str("discussion_event_id") == Some(discussion_event_id)
    })
}

/// 「被上限暂停」的讨论信息（上游 `paused_discussion` 的返回形状）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PausedDiscussion {
    pub thread_id: String,
    /// 下一次 Continue 用的序号（1-based）。
    pub grant: i64,
}

/// 上游 `paused_discussion()`：讨论的最新结局是「到达上限」且其后没有 Stop、
/// 没有同 thread 的更新消息时，返回 `{thread_id, grant}`。
///
/// 关键语义（上游注释）：Stop 或同 thread 的更新消息一旦出现在讨论消息之后，
/// 这个讨论就被**永久**挡开——即使那条更晚的消息落在「按旧快照算出的上限通知」
/// 之前。因为更新的消息已经占有了这个 thread，Continue 重开旧讨论会让它搁浅。
pub fn paused_discussion(events: &[LogEvent], discussion_event_id: &str) -> Option<PausedDiscussion> {
    let mut bounded: Option<&LogEvent> = None;
    let mut grants: i64 = 0;

    for event in events {
        if event.payload_str("discussion_event_id") != Some(discussion_event_id) {
            continue;
        }
        if event.kind == CONTINUED_EVENT_KIND {
            grants += 1;
            bounded = None;
        } else if event.kind == "room.activity" {
            bounded = if event.payload_str("status") == Some("bounded") {
                Some(event)
            } else {
                None
            };
        }
    }

    let bounded = bounded?;
    let thread_id = bounded.payload_str("thread_id")?.to_owned();

    // 讨论自己的消息 seq；找不到就退回 bounded 的 seq（上游同逻辑）
    let source_seq = events
        .iter()
        .find(|event| event.event_id == discussion_event_id)
        .map(|event| event.seq)
        .unwrap_or(bounded.seq);

    // 之后有 Stop，或有同 thread 的新 user 消息 → 永久挡开
    let fenced = events.iter().any(|event| {
        event.seq > source_seq
            && (event.kind == "room.stop_requested"
                || (event.kind == "message.user"
                    && event.payload_str("thread_id") == Some(thread_id.as_str())))
    });
    if fenced {
        return None;
    }

    Some(PausedDiscussion {
        thread_id,
        grant: grants + 1,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn handles(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(h, id)| ((*h).to_owned(), (*id).to_owned()))
            .collect()
    }

    fn event(seq: i64, id: &str, kind: &str, payload: Value) -> LogEvent {
        LogEvent {
            seq,
            event_id: id.to_owned(),
            kind: kind.to_owned(),
            payload: payload.as_object().cloned().unwrap_or_default(),
        }
    }

    // ── parse_router_answer ────────────────────────────────────────────────

    #[test]
    fn parses_member_list() {
        let h = handles(&[("ada", "m-ada"), ("linus", "m-linus")]);
        let got = parse_router_answer(r#"{"members":["ada","linus"]}"#, &h).unwrap();
        assert_eq!(got, vec!["m-ada".to_owned(), "m-linus".to_owned()]);
    }

    #[test]
    fn parses_everyone_as_empty_vec() {
        let h = handles(&[("ada", "m-ada")]);
        assert_eq!(parse_router_answer(r#"{"members":"everyone"}"#, &h), Some(Vec::new()));
    }

    #[test]
    fn strips_code_fences() {
        let h = handles(&[("ada", "m-ada")]);
        let fenced = "```json\n{\"members\":[\"ada\"]}\n```";
        assert_eq!(
            parse_router_answer(fenced, &h),
            Some(vec!["m-ada".to_owned()])
        );
    }

    #[test]
    fn normalizes_at_prefix_and_case() {
        let h = handles(&[("ada", "m-ada")]);
        assert_eq!(
            parse_router_answer(r#"{"members":["@ADA"]}"#, &h),
            Some(vec!["m-ada".to_owned()])
        );
    }

    #[test]
    fn rejects_off_roster_names() {
        let h = handles(&[("ada", "m-ada")]);
        assert_eq!(parse_router_answer(r#"{"members":["bob"]}"#, &h), None);
    }

    #[test]
    fn rejects_duplicates() {
        let h = handles(&[("ada", "m-ada")]);
        assert_eq!(parse_router_answer(r#"{"members":["ada","ADA"]}"#, &h), None);
    }

    #[test]
    fn rejects_extra_fields_and_empty_list() {
        let h = handles(&[("ada", "m-ada")]);
        assert_eq!(
            parse_router_answer(r#"{"members":["ada"],"x":1}"#, &h),
            None
        );
        assert_eq!(parse_router_answer(r#"{"members":[]}"#, &h), None);
    }

    #[test]
    fn rejects_non_json_and_non_strings() {
        let h = handles(&[("ada", "m-ada")]);
        assert_eq!(parse_router_answer("not json", &h), None);
        assert_eq!(parse_router_answer(r#"{"members":[1]}"#, &h), None);
        assert_eq!(parse_router_answer(r#"{"members":"nobody"}"#, &h), None);
    }

    // ── routed_payload ─────────────────────────────────────────────────────

    #[test]
    fn routed_payload_marks_fallback_when_none() {
        let p = routed_payload("d1", "t1", None);
        assert_eq!(p["everyone"], true);
        assert_eq!(p["fallback"], true);
        assert_eq!(p["member_ids"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn routed_payload_names_members_without_fallback() {
        let ids = vec!["m1".to_owned()];
        let p = routed_payload("d1", "t1", Some(&ids));
        assert_eq!(p["everyone"], false);
        assert_eq!(p["fallback"], false);
        assert_eq!(p["member_ids"], json!(["m1"]));
    }

    // ── router_prompt ──────────────────────────────────────────────────────

    #[test]
    fn router_prompt_renders_room_roster_and_message() {
        let roster = vec![
            RosterEntry {
                handle: "ada".into(),
                name: "Ada".into(),
                description: "backend   engineer".into(),
            },
            RosterEntry {
                handle: "linus".into(),
                name: String::new(),
                description: String::new(),
            },
        ];
        let recent = vec![RecentMessage {
            author: "user".into(),
            text: "hi   there".into(),
        }];
        let prompt = router_prompt("Team", "ship it", "", &roster, &recent, "who owns the API?", &[]);

        assert!(prompt.starts_with("Room: Team"));
        assert!(prompt.contains("Purpose: ship it"));
        assert!(prompt.contains("- @ada (Ada): backend engineer"));
        // name 为空时只有 handle，无括号
        assert!(prompt.contains("- @linus\n") || prompt.ends_with("- @linus"));
        assert!(prompt.contains("Recent messages (oldest first):"));
        // 空白折叠
        assert!(prompt.contains("user: hi there"));
        assert!(prompt.contains("The user's new message:"));
        assert!(prompt.contains("  who owns the API?"));
    }

    #[test]
    fn router_prompt_omits_empty_sections() {
        let prompt = router_prompt("Team", "", "", &[], &[], "hello", &[]);
        assert!(!prompt.contains("Purpose:"));
        assert!(!prompt.contains("Notes:"));
        assert!(!prompt.contains("Recent messages"));
        assert!(!prompt.contains("Attached files:"));
    }

    #[test]
    fn router_prompt_lists_attachments() {
        let prompt = router_prompt("T", "", "", &[], &[], "m", &["a.txt".into(), "b.png".into()]);
        assert!(prompt.contains("Attached files: a.txt, b.png"));
    }

    #[test]
    fn router_prompt_truncates_long_message_and_notes() {
        let long_msg = "x".repeat(25_000);
        let prompt = router_prompt("T", "", "", &[], &[], &long_msg, &[]);
        // 20000 字符上限
        assert!(prompt.matches('x').count() <= 20_000 + 100);

        let long_notes = "y".repeat(3_000);
        let prompt = router_prompt("T", "", &long_notes, &[], &[], "m", &[]);
        assert!(prompt.matches('y').count() <= 2_000);
    }

    #[test]
    fn one_line_collapses_and_truncates() {
        assert_eq!(one_line("  a   b  "), "a b");
        let long = "z".repeat(ROUTER_MESSAGE_CHARS + 10);
        let rendered = one_line(&long);
        assert!(rendered.ends_with("..."));
        assert_eq!(rendered.chars().count(), ROUTER_MESSAGE_CHARS + 3);
    }

    // ── 日志扫描 ───────────────────────────────────────────────────────────

    #[test]
    fn continue_count_counts_matching_discussion() {
        let events = vec![
            event(1, "e1", CONTINUED_EVENT_KIND, json!({"discussion_event_id": "d1"})),
            event(2, "e2", CONTINUED_EVENT_KIND, json!({"discussion_event_id": "d2"})),
            event(3, "e3", CONTINUED_EVENT_KIND, json!({"discussion_event_id": "d1"})),
        ];
        assert_eq!(continue_count(&events, "d1"), 2);
        assert_eq!(continue_count(&events, "d3"), 0);
    }

    #[test]
    fn resume_round_is_none_without_continue() {
        let events = vec![event(1, "e1", "message.user", json!({}))];
        assert_eq!(resume_round(&events, "d1", &[]), None);
    }

    #[test]
    fn resume_round_after_latest_continue() {
        let events = vec![
            event(5, "c1", CONTINUED_EVENT_KIND, json!({"discussion_event_id": "d1"})),
            event(9, "c2", CONTINUED_EVENT_KIND, json!({"discussion_event_id": "d1"})),
        ];
        // 最新 continue 在 seq 9；其前最后一条回复 round_index=2 → 恢复轮 = 3
        let member_messages = vec![
            event(6, "m1", "message.member", json!({"round_index": 1})),
            event(8, "m2", "message.member", json!({"round_index": 2})),
            event(10, "m3", "message.member", json!({"round_index": 9})),
        ];
        assert_eq!(resume_round(&events, "d1", &member_messages), Some(3));
    }

    #[test]
    fn continued_through_records_latest_seq() {
        let events = vec![
            event(3, "c1", CONTINUED_EVENT_KIND, json!({"discussion_event_id": "d1"})),
            event(7, "c2", CONTINUED_EVENT_KIND, json!({"discussion_event_id": "d1"})),
            event(9, "c3", CONTINUED_EVENT_KIND, json!({"discussion_event_id": "d2"})),
        ];
        let map = continued_through(&events);
        assert_eq!(map.get("d1"), Some(&7));
        assert_eq!(map.get("d2"), Some(&9));
    }

    #[test]
    fn routed_event_matches_by_discussion_id() {
        let events = vec![
            event(1, "r1", ROUTED_EVENT_KIND, json!({"discussion_event_id": "d1"})),
            event(2, "r2", ROUTED_EVENT_KIND, json!({"discussion_event_id": "d2"})),
        ];
        assert_eq!(routed_event(&events, "d2").map(|e| e.seq), Some(2));
        assert!(routed_event(&events, "d9").is_none());
    }

    // ── paused_discussion ──────────────────────────────────────────────────

    fn bounded_activity(seq: i64, thread: &str, discussion: &str) -> LogEvent {
        event(
            seq,
            "act",
            "room.activity",
            json!({"status": "bounded", "thread_id": thread, "discussion_event_id": discussion}),
        )
    }

    #[test]
    fn paused_returns_grant_one_without_continue() {
        let events = vec![
            event(1, "d1", "message.user", json!({"thread_id": "t1"})),
            bounded_activity(2, "t1", "d1"),
        ];
        let paused = paused_discussion(&events, "d1").unwrap();
        assert_eq!(paused.thread_id, "t1");
        assert_eq!(paused.grant, 1);
    }

    #[test]
    fn paused_grant_advances_per_continue() {
        let events = vec![
            event(1, "d1", "message.user", json!({"thread_id": "t1"})),
            bounded_activity(2, "t1", "d1"),
            event(3, "c1", CONTINUED_EVENT_KIND, json!({"discussion_event_id": "d1"})),
            bounded_activity(4, "t1", "d1"),
        ];
        assert_eq!(paused_discussion(&events, "d1").unwrap().grant, 2);
    }

    #[test]
    fn paused_is_none_when_not_bounded() {
        let events = vec![
            event(1, "d1", "message.user", json!({"thread_id": "t1"})),
            event(
                2,
                "act",
                "room.activity",
                json!({"status": "settled", "thread_id": "t1", "discussion_event_id": "d1"}),
            ),
        ];
        assert!(paused_discussion(&events, "d1").is_none());
    }

    #[test]
    fn paused_is_fenced_by_stop_after_discussion() {
        let events = vec![
            event(1, "d1", "message.user", json!({"thread_id": "t1"})),
            bounded_activity(2, "t1", "d1"),
            event(3, "stop", "room.stop_requested", json!({"cancel_id": "c"})),
        ];
        assert!(paused_discussion(&events, "d1").is_none());
    }

    #[test]
    fn paused_is_fenced_by_newer_thread_message() {
        let events = vec![
            event(1, "d1", "message.user", json!({"thread_id": "t1"})),
            bounded_activity(2, "t1", "d1"),
            event(3, "d2", "message.user", json!({"thread_id": "t1"})),
        ];
        assert!(paused_discussion(&events, "d1").is_none());
    }

    #[test]
    fn paused_ignores_newer_message_on_other_thread() {
        let events = vec![
            event(1, "d1", "message.user", json!({"thread_id": "t1"})),
            bounded_activity(2, "t1", "d1"),
            event(3, "d2", "message.user", json!({"thread_id": "t2"})),
        ];
        assert!(paused_discussion(&events, "d1").is_some());
    }

    #[test]
    fn paused_continue_clears_bounded_until_next_cap() {
        let events = vec![
            event(1, "d1", "message.user", json!({"thread_id": "t1"})),
            bounded_activity(2, "t1", "d1"),
            event(3, "c1", CONTINUED_EVENT_KIND, json!({"discussion_event_id": "d1"})),
        ];
        // Continue 之后尚未再次到上限 → 无 paused
        assert!(paused_discussion(&events, "d1").is_none());
    }
}
//! 主机器人路由（hermes `gateway/hosted_room_lead.py` 的 Rust 移植）。
//!
//! 上游自述：
//! > Opt-in lead routing for hosted Group Chats.
//! > A room whose settings say `routing: lead` sends an unaddressed human message
//! > to its lead first. The lead runs one routing turn on its own member session and
//! > answers with the handles that should take the message; the gateway records that
//! > as a `room.assignment` event (the Desktop renders "Ada gave this to Linus") and
//! > only the chosen members take the normal round. **Anything the lead answers that
//! > names no roster member wakes the lead alone: a routing answer can never broadcast.**
//!
//! ## 关键语义（上游注释里点明的两个反直觉点）
//!
//! 1. **「点名无人的答案只唤醒 lead 自己」**——不是广播。所以 lead 乱答不会
//!    把消息轰给全员。
//! 2. 路由 turn 是**普通 driver 任务**，payload 带 `lead_routing: true`。这个
//!    true 会被哈希进 task id（**prompt 不进**——prompt 里含房间名，改名不该让
//!    planner 按 id 查的回执变成孤儿）。它的 `seen_through_seq` 是消息 seq 减一，
//!    这样终态回执永远不会把 lead 的水位推过它还没应答的那条消息。
//!
//! ## 移植边界
//!
//! ✅ 本文件：常量、`parse_assignment`（宽松解析，容忍 prose 里的花括号）、
//!   `routing_prompt`（纯字符串）、`is_routing_task`、`assignment_event_id`。
//!
//! ⏳ 未移植（依赖 discussion 的 `DiscussionRoom` / `_ValidatedEvent` /
//!   `DiscussionTaskPlan` / `EventPlan`）：`lead_member`、`routes_through_lead`、
//!   `first_round_members`、`validate_assignment_event`、`assignment_effect`。

use serde_json::{Map, Value};

use super::router::LogEvent;

// ── 常量（上游逐字）────────────────────────────────────────────────────────

pub const ASSIGNMENT_EVENT_KIND: &str = "room.assignment";

/// `room.assignment` 的精确字段集。
pub const ASSIGNMENT_FIELDS: &[&str] = &[
    "discussion_event_id",
    "thread_id",
    "task_id",
    "lead_member_id",
    "member_ids",
    "fallback",
];

/// 上游 `_ROUTING_INSTRUCTIONS`：附在 lead 提示末尾的两句硬指令。
const ROUTING_INSTRUCTIONS: [&str; 2] = [
    "You are the lead of this room. A message arrived that names nobody, so you decide who takes it: pick the \
member(s) whose role the request touches (yourself included when it is yours). Do not answer the message \
itself here; whoever you pick answers it next.",
    "Reply with only a JSON object and nothing else, for example {\"assign\": [\"handle\"]}.",
];

// ── 解析 ────────────────────────────────────────────────────────────────────

/// 上游 `_first_assign_object()`：找出 `text` 里**第一个**带 `assign` 键的平衡 JSON 对象。
///
/// 为什么要这样：lead 经常把答案包在散文里，散文本身也可能带花括号
/// （比如 `see {notes}`），所以贪婪的外层匹配不是答案。这里逐个 `{` 起点试
/// `raw_decode`，第一个解析成功且含 `assign` 的对象才算。
fn first_assign_object(text: &str) -> Option<Map<String, Value>> {
    let mut search_from = 0usize;
    while let Some(offset) = text[search_from..].find('{') {
        let start = search_from + offset;
        // 从 start 起尝试解析一个完整的 JSON 值
        if let Ok(value) = parse_json_prefix(&text[start..]) {
            if let Value::Object(map) = value {
                if map.contains_key("assign") {
                    return Some(map);
                }
            }
        }
        search_from = start + 1;
    }
    None
}

/// 解析 `input` 开头的**一个**完整 JSON 值（等价 Python `raw_decode`：忽略尾部多余内容）。
///
/// 实现方式：用 `serde_json::Deserializer::from_str` 的 `into_iter`（stream）
/// 取第一个值——它天然允许尾随内容。
fn parse_json_prefix(input: &str) -> Result<Value, ()> {
    let mut stream = serde_json::Deserializer::from_str(input).into_iter::<Value>();
    match stream.next() {
        Some(Ok(value)) => Ok(value),
        _ => Err(()),
    }
}

/// 上游 `parse_assignment()`：lead 答案里点名的成员 id，**按 roster 顺序**。
///
/// 答案里点名无人、或根本不是 JSON → 空元组（**不是广播**）。
///
/// `roster` 是 `(handle, member_id)` 的有序列表；handle 比较用 `casefold`
/// （Rust 侧用 `to_lowercase`，与上游 `casefold()` 对 ASCII 等价）。
pub fn parse_assignment(text: &str, roster: &[(String, String)]) -> Vec<String> {
    let Some(answer) = first_assign_object(text) else {
        return Vec::new();
    };
    let Some(Value::Array(picked)) = answer.get("assign") else {
        return Vec::new();
    };

    // 上游：只收字符串项，strip + lstrip("@") + casefold
    let handles: std::collections::BTreeSet<String> = picked
        .iter()
        .filter_map(Value::as_str)
        .map(|item| item.trim().trim_start_matches('@').to_lowercase())
        .collect();

    // 按 roster 顺序输出（上游 `for member in room.members if ... in handles`）
    roster
        .iter()
        .filter(|(handle, _)| handles.contains(&handle.to_lowercase()))
        .map(|(_, member_id)| member_id.clone())
        .collect()
}

// ── 任务判定 ────────────────────────────────────────────────────────────────

/// 上游 `is_routing_task()`：payload 的 `lead_routing` **恰好是 `true`**。
///
/// 注意是 `is True` 语义：字符串 `"true"`、数字 `1` 都不算。
pub fn is_routing_task(payload: &Map<String, Value>) -> bool {
    matches!(payload.get("lead_routing"), Some(Value::Bool(true)))
}

// ── 事件 id ────────────────────────────────────────────────────────────────

/// 上游 `assignment_effect` 里的事件 id：`dassign:<task_id 去掉 dtask: 前缀>`。
pub fn assignment_event_id(task_id: &str) -> String {
    format!("dassign:{}", task_id.strip_prefix("dtask:").unwrap_or(task_id))
}

/// 上游 `assignment()`：按 discussion_event_id 找已存在的 `room.assignment`。
pub fn assignment<'a>(events: &'a [LogEvent], discussion_event_id: &str) -> Option<&'a LogEvent> {
    events.iter().find(|event| {
        event.kind == ASSIGNMENT_EVENT_KIND
            && event.payload.get("discussion_event_id").and_then(Value::as_str)
                == Some(discussion_event_id)
    })
}

// ── 提示文本 ────────────────────────────────────────────────────────────────

/// lead 提示里的一行上下文（上游 `context_lines` 由调用方提供）。
///
/// roster 项渲染成：`- @handle (display_name) (you)`，`(you)` 只加在 lead 自己身上。
#[allow(clippy::too_many_arguments)]
pub fn routing_prompt(
    room_name: &str,
    lead_handle: &str,
    context_lines: &[String],
    roster: &[(String, Option<String>, bool)], // (handle, display_name, is_lead)
    message_text: &str,
    attachments: &[AttachmentLine],
) -> String {
    let mut lines: Vec<String> = vec![
        format!("[Discussion: \"{room_name}\"] You are @{lead_handle}, the lead of this room."),
        String::new(),
    ];
    lines.extend(context_lines.iter().cloned());
    lines.push("Members:".to_owned());
    for (handle, display_name, is_lead) in roster {
        let name_suffix = display_name
            .as_ref()
            .map(|name| format!(" ({name})"))
            .unwrap_or_default();
        let you_suffix = if *is_lead { " (you)" } else { "" };
        lines.push(format!("- @{handle}{name_suffix}{you_suffix}"));
    }
    lines.push(String::new());
    lines.push("The message (from the user):".to_owned());
    lines.push(format!("  {message_text}"));
    lines.extend(attachment_lines(attachments));
    lines.push(String::new());
    lines.extend(ROUTING_INSTRUCTIONS.iter().map(|s| (*s).to_owned()));
    lines.join("\n")
}

/// 附件的一行描述（上游 `_attachment_lines`）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AttachmentLine {
    pub name: String,
    pub kind: String,
    pub mime: Option<String>,
}

/// 上游 `_attachment_lines()`：只列**名字与类型**，让 lead 能据附件路由
/// （纯附件消息没有文本）；文件本身只到真正接手那个成员手里。
pub fn attachment_lines(attachments: &[AttachmentLine]) -> Vec<String> {
    if attachments.is_empty() {
        return Vec::new();
    }
    let mut lines = vec!["Attached files:".to_owned()];
    for item in attachments {
        // 上游：`' '.join(str(name or 'file').split())` → 空白折叠，空则 "file"
        let name_raw = if item.name.trim().is_empty() {
            "file".to_owned()
        } else {
            item.name.clone()
        };
        let name = name_raw.split_whitespace().collect::<Vec<_>>().join(" ");
        let kind = if item.kind.trim().is_empty() {
            "file".to_owned()
        } else {
            item.kind.clone()
        };
        let mime_suffix = item
            .mime
            .as_ref()
            .filter(|m| !m.is_empty())
            .map(|m| format!(", {m}"))
            .unwrap_or_default();
        lines.push(format!("  - {name} ({kind}{mime_suffix})"));
    }
    lines
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn roster() -> Vec<(String, String)> {
        vec![
            ("ada".to_owned(), "m-ada".to_owned()),
            ("linus".to_owned(), "m-linus".to_owned()),
            ("grace".to_owned(), "m-grace".to_owned()),
        ]
    }

    // ── parse_assignment ───────────────────────────────────────────────────

    #[test]
    fn parses_plain_assignment() {
        let got = parse_assignment(r#"{"assign": ["linus"]}"#, &roster());
        assert_eq!(got, vec!["m-linus".to_owned()]);
    }

    #[test]
    fn output_follows_roster_order_not_answer_order() {
        // 答案顺序 grace, ada → 输出按 roster（ada 在前）
        let got = parse_assignment(r#"{"assign": ["grace", "ada"]}"#, &roster());
        assert_eq!(got, vec!["m-ada".to_owned(), "m-grace".to_owned()]);
    }

    #[test]
    fn finds_assignment_inside_prose() {
        // 散文里带自己的花括号，贪婪外层匹配会失败——必须找到带 assign 的那个对象
        let text = r#"Sure, see {notes} for detail. Here: {"assign": ["ada"]} — done."#;
        assert_eq!(parse_assignment(text, &roster()), vec!["m-ada".to_owned()]);
    }

    #[test]
    fn skips_brace_objects_without_assign() {
        let text = r#"{"other": 1} then {"assign": ["grace"]}"#;
        assert_eq!(parse_assignment(text, &roster()), vec!["m-grace".to_owned()]);
    }

    #[test]
    fn names_nobody_yields_empty_not_broadcast() {
        // 上游核心语义：点名无人 → 空（只唤醒 lead），绝不广播
        assert_eq!(parse_assignment(r#"{"assign": []}"#, &roster()), Vec::<String>::new());
        assert_eq!(
            parse_assignment(r#"{"assign": ["nobody"]}"#, &roster()),
            Vec::<String>::new()
        );
        assert_eq!(parse_assignment("no json here", &roster()), Vec::<String>::new());
        assert_eq!(parse_assignment("", &roster()), Vec::<String>::new());
    }

    #[test]
    fn normalizes_at_prefix_and_case() {
        let got = parse_assignment(r#"{"assign": ["@ADA"]}"#, &roster());
        assert_eq!(got, vec!["m-ada".to_owned()]);
    }

    #[test]
    fn ignores_non_string_entries() {
        let got = parse_assignment(r#"{"assign": [1, null, "ada"]}"#, &roster());
        assert_eq!(got, vec!["m-ada".to_owned()]);
    }

    #[test]
    fn rejects_non_list_assign() {
        assert_eq!(
            parse_assignment(r#"{"assign": "ada"}"#, &roster()),
            Vec::<String>::new()
        );
        assert_eq!(
            parse_assignment(r#"{"assign": {"a": 1}}"#, &roster()),
            Vec::<String>::new()
        );
    }

    #[test]
    fn deduplicates_repeated_handles() {
        let got = parse_assignment(r#"{"assign": ["ada", "ada", "linus"]}"#, &roster());
        assert_eq!(got, vec!["m-ada".to_owned(), "m-linus".to_owned()]);
    }

    // ── is_routing_task ────────────────────────────────────────────────────

    #[test]
    fn routing_task_requires_exact_true() {
        let with = |v: Value| {
            let mut map = Map::new();
            map.insert("lead_routing".to_owned(), v);
            map
        };
        assert!(is_routing_task(&with(json!(true))));
        // 上游 `is True`：假值都算普通成员 turn
        assert!(!is_routing_task(&with(json!("true"))));
        assert!(!is_routing_task(&with(json!(1))));
        assert!(!is_routing_task(&with(json!(false))));
        assert!(!is_routing_task(&Map::new()));
    }

    // ── 事件 id ────────────────────────────────────────────────────────────

    #[test]
    fn assignment_event_id_strips_dtask_prefix() {
        assert_eq!(assignment_event_id("dtask:abc123"), "dassign:abc123");
        // 没有前缀时原样带过去
        assert_eq!(assignment_event_id("abc123"), "dassign:abc123");
    }

    // ── assignment 查找 ────────────────────────────────────────────────────

    fn log_event(seq: i64, id: &str, kind: &str, payload: Value) -> LogEvent {
        LogEvent {
            seq,
            event_id: id.to_owned(),
            kind: kind.to_owned(),
            payload: payload.as_object().cloned().unwrap_or_default(),
        }
    }

    #[test]
    fn assignment_finds_by_discussion_id() {
        let events = vec![
            log_event(1, "a1", ASSIGNMENT_EVENT_KIND, json!({"discussion_event_id": "d1"})),
            log_event(2, "a2", ASSIGNMENT_EVENT_KIND, json!({"discussion_event_id": "d2"})),
        ];
        assert_eq!(assignment(&events, "d2").map(|e| e.seq), Some(2));
        assert!(assignment(&events, "d9").is_none());
    }

    // ── routing_prompt ─────────────────────────────────────────────────────

    #[test]
    fn routing_prompt_renders_roster_and_message() {
        let roster = vec![
            ("ada".to_owned(), Some("Ada Lovelace".to_owned()), true),
            ("linus".to_owned(), None, false),
        ];
        let prompt = routing_prompt(
            "Team",
            "ada",
            &["Purpose: ship it".to_owned()],
            &roster,
            "who owns the API?",
            &[],
        );
        assert!(prompt.starts_with("[Discussion: \"Team\"] You are @ada, the lead of this room."));
        assert!(prompt.contains("Purpose: ship it"));
        assert!(prompt.contains("- @ada (Ada Lovelace) (you)"));
        assert!(prompt.contains("- @linus"));
        assert!(prompt.contains("The message (from the user):"));
        assert!(prompt.contains("  who owns the API?"));
        // 两条硬指令都在
        assert!(prompt.contains("You are the lead of this room."));
        assert!(prompt.contains(r#"{"assign": ["handle"]}"#));
        // 没有附件时不渲染附件段
        assert!(!prompt.contains("Attached files:"));
    }

    #[test]
    fn routing_prompt_lists_attachments() {
        let attachments = vec![
            AttachmentLine {
                name: "report.pdf".into(),
                kind: "document".into(),
                mime: Some("application/pdf".into()),
            },
            AttachmentLine {
                name: "  ".into(),
                kind: "image".into(),
                mime: None,
            },
        ];
        let prompt = routing_prompt("T", "ada", &[], &[], "m", &attachments);
        assert!(prompt.contains("Attached files:"));
        assert!(prompt.contains("  - report.pdf (document, application/pdf)"));
        // 空名回落 "file"
        assert!(prompt.contains("  - file (image)"));
    }

    #[test]
    fn attachment_lines_collapses_whitespace_in_names() {
        let attachments = vec![AttachmentLine {
            name: "  my   report.pdf ".into(),
            kind: "document".into(),
            mime: None,
        }];
        let lines = attachment_lines(&attachments);
        assert_eq!(lines[1], "  - my report.pdf (document)");
    }

    #[test]
    fn attachment_lines_empty_when_none() {
        assert!(attachment_lines(&[]).is_empty());
    }
}
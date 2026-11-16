//! 房间上下文：purpose / notes / routing（hermes `gateway/hosted_room_context.py` 的 Rust 移植）。
//!
//! 上游自述：
//! > Room purpose, shared notes and scheduled-job posts for hosted Group Chats.
//! > Both live in the append-only room log, **never in a side file**: the Discussion
//! > planner must stay a pure function of durable room state, because a member turn's
//! > task id hashes its prompt.
//!
//! ## 为什么不能放 side file
//!
//! 这是上游刻意设计：purpose/notes 作为 `room.context_set` 事件进日志，且**按
//! 打开讨论的那条消息的 seq 读取**（`before_seq`）。所以讨论中途改 purpose
//! 不会重新规划一个已准入的 turn——改动从下一条消息起生效。
//!
//! ## 移植边界
//!
//! ✅ 本文件：`validate_context`（纯归一）、`scheduled_post_kind`（纯判定）、
//! `room_context`（从事件日志读最新值，接 store）。
//!
//! ⏳ 未移植（依赖 `append_event` 的 payload-as-function 能力与附件/事件重写）：
//! `set_room_context`、`post_scheduled_message`、`groups_state_result`。

use rusqlite::Connection;
use serde_json::{json, Map, Value};

use super::store::{HostedRoomError, RoomResult};

// ── 常量（上游逐字）────────────────────────────────────────────────────────

pub const CONTEXT_EVENT_KIND: &str = "room.context_set";
pub const MAX_PURPOSE_CHARS: usize = 500;
pub const MAX_NOTES_BYTES: usize = 4 * 1024;

/// 调度器作者的消息 id 前缀：结果帖能因 @mention 开启一轮。
pub const SCHEDULED_POST_PREFIX: &str = "cron:";
/// 失败通知的前缀：永不开启一轮（文本是机器写的，没有点名谁）。
pub const SCHEDULED_NOTICE_PREFIX: &str = "cron-notice:";

pub const ROUTING_MODES: &[&str] = &["everyone", "lead", "auto"];

/// 上游 `_EMPTY_CONTEXT`：默认设置。
pub fn empty_context() -> RoomContext {
    RoomContext {
        purpose: String::new(),
        notes: String::new(),
        routing: "everyone".to_owned(),
        lead_member_id: String::new(),
    }
}

/// 归一后的房间设置（上游 `dict[str, str]`）。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct RoomContext {
    pub purpose: String,
    pub notes: String,
    pub routing: String,
    pub lead_member_id: String,
}

impl RoomContext {
    pub fn to_json(&self) -> Value {
        json!({
            "purpose": self.purpose,
            "notes": self.notes,
            "routing": self.routing,
            "lead_member_id": self.lead_member_id,
        })
    }
}

// ── 归一 ────────────────────────────────────────────────────────────────────

/// 上游 `validate_context()`：归一一条房间设置。
///
/// 关键语义：
/// - `purpose` 空白折叠（`" ".join(split())`），≤500 **字符**
/// - `notes` 只 strip，≤4KB **字节**
/// - `routing` 必须是那三个值之一
/// - `routing == "lead"` 必须有 `lead_member_id`
/// - `routing != "lead"` 时 `lead_member_id` **一律清空**（上游 `else ""`）
///
/// purpose / notes 允许为空（用于清除）。
pub fn validate_context(
    purpose: &str,
    notes: &str,
    routing: &str,
    lead_member_id: &str,
) -> RoomResult<RoomContext> {
    // purpose：空白折叠
    let purpose_norm = purpose.split_whitespace().collect::<Vec<_>>().join(" ");
    let notes_norm = notes.trim();

    if purpose_norm.chars().count() > MAX_PURPOSE_CHARS {
        return Err(HostedRoomError(format!(
            "purpose must be at most {MAX_PURPOSE_CHARS} characters"
        )));
    }
    if notes_norm.len() > MAX_NOTES_BYTES {
        return Err(HostedRoomError(format!(
            "notes must be at most {MAX_NOTES_BYTES} bytes"
        )));
    }
    if !ROUTING_MODES.contains(&routing) {
        return Err(HostedRoomError(
            "routing must be 'everyone', 'lead' or 'auto'".to_owned(),
        ));
    }

    let lead_trimmed = lead_member_id.trim();
    if routing == "lead" && lead_trimmed.is_empty() {
        return Err(HostedRoomError(
            "lead routing needs a lead_member_id".to_owned(),
        ));
    }

    Ok(RoomContext {
        purpose: purpose_norm,
        notes: notes_norm.to_owned(),
        routing: routing.to_owned(),
        // 非 lead 路由不保留 lead（上游 `if routing == "lead" else ""`）
        lead_member_id: if routing == "lead" {
            lead_trimmed.to_owned()
        } else {
            String::new()
        },
    })
}

/// 上游 `scheduled_post_kind()`：`"post"` / `"notice"` / `None`（人类）。
///
/// 判据：actor.kind 必须是 `"user"`，再看 id 前缀。notice 优先判断——因为
/// `"cron-notice:"` 也以 `"cron"` 开头。
pub fn scheduled_post_kind(actor: Option<&Value>) -> Option<&'static str> {
    let actor = actor?;
    let Value::Object(map) = actor else {
        return None;
    };
    if map.get("kind").and_then(Value::as_str) != Some("user") {
        return None;
    }
    let id = map.get("id").and_then(Value::as_str).unwrap_or("");
    if id.starts_with(SCHEDULED_NOTICE_PREFIX) {
        Some("notice")
    } else if id.starts_with(SCHEDULED_POST_PREFIX) {
        Some("post")
    } else {
        None
    }
}

// ── 读取（接 store）──────────────────────────────────────────────────────────

/// 上游 `_latest_context()`：取最新一条 `room.context_set`，或 `before_seq` 之前的最新一条。
///
/// 「`before_seq` 之前」是讨论确定性的关键：讨论按打开它的那条消息的 seq 读设置，
/// 所以中途改设置不影响已准入的 turn。
pub fn latest_context(
    conn: &Connection,
    room_id: &str,
    before_seq: Option<i64>,
) -> RoomResult<RoomContext> {
    let (sql, params): (&str, Vec<Box<dyn rusqlite::ToSql>>) = match before_seq {
        Some(seq) => (
            "SELECT payload_json FROM hosted_room_events
             WHERE room_id=?1 AND kind=?2 AND seq<?3 ORDER BY seq DESC LIMIT 1",
            vec![
                Box::new(room_id.to_owned()),
                Box::new(CONTEXT_EVENT_KIND.to_owned()),
                Box::new(seq),
            ],
        ),
        None => (
            "SELECT payload_json FROM hosted_room_events
             WHERE room_id=?1 AND kind=?2 ORDER BY seq DESC LIMIT 1",
            vec![
                Box::new(room_id.to_owned()),
                Box::new(CONTEXT_EVENT_KIND.to_owned()),
            ],
        ),
    };

    let mut stmt = conn.prepare(sql)?;
    let params_ref: Vec<&dyn rusqlite::ToSql> = params.iter().map(|p| p.as_ref()).collect();
    let row: Option<String> = stmt
        .query_row(params_ref.as_slice(), |row| row.get(0))
        .ok();

    let Some(payload_json) = row else {
        return Ok(empty_context());
    };

    let parsed: Value = serde_json::from_str(&payload_json)
        .map_err(|e| HostedRoomError(format!("invalid context payload: {e}")))?;
    let Value::Object(map) = &parsed else {
        return Ok(empty_context());
    };
    Ok(context_from_map(map))
}

/// 上游 `{key: str(payload.get(key) or default)}`：缺失/null/空串都退回默认值。
fn context_from_map(map: &Map<String, Value>) -> RoomContext {
    let defaults = empty_context();
    let read = |key: &str, fallback: &str| -> String {
        match map.get(key) {
            Some(Value::String(s)) if !s.is_empty() => s.clone(),
            _ => fallback.to_owned(),
        }
    };
    RoomContext {
        purpose: read("purpose", &defaults.purpose),
        notes: read("notes", &defaults.notes),
        routing: read("routing", &defaults.routing),
        lead_member_id: read("lead_member_id", &defaults.lead_member_id),
    }
}

/// 上游 `room_context()`：`before_seq` 为 `None` 时给当前生效的设置。
pub fn room_context(conn: &Connection, room_id: &str, before_seq: Option<i64>) -> RoomResult<RoomContext> {
    // 上游先 `_room_id(room_id)` 校验
    crate::hosted_rooms::store::validate_room_id_pub(&Value::String(room_id.to_owned()))?;
    latest_context(conn, room_id, before_seq)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_normalizes_purpose_whitespace() {
        let ctx = validate_context("  ship   the   thing  ", "", "everyone", "").unwrap();
        assert_eq!(ctx.purpose, "ship the thing");
    }

    #[test]
    fn validate_bounds_purpose_by_chars_not_bytes() {
        // 500 个中文字符 = 1500 字节，按字符计合法
        let ok = "房".repeat(MAX_PURPOSE_CHARS);
        assert!(validate_context(&ok, "", "everyone", "").is_ok());
        let too_long = "房".repeat(MAX_PURPOSE_CHARS + 1);
        assert_eq!(
            validate_context(&too_long, "", "everyone", "").unwrap_err().0,
            "purpose must be at most 500 characters"
        );
    }

    #[test]
    fn validate_bounds_notes_by_bytes() {
        let ok = "a".repeat(MAX_NOTES_BYTES);
        assert!(validate_context("", &ok, "everyone", "").is_ok());
        let too_long = "a".repeat(MAX_NOTES_BYTES + 1);
        assert_eq!(
            validate_context("", &too_long, "everyone", "").unwrap_err().0,
            "notes must be at most 4096 bytes"
        );
    }

    #[test]
    fn validate_rejects_unknown_routing() {
        assert_eq!(
            validate_context("", "", "shout", "").unwrap_err().0,
            "routing must be 'everyone', 'lead' or 'auto'"
        );
    }

    #[test]
    fn validate_requires_lead_for_lead_routing() {
        assert_eq!(
            validate_context("", "", "lead", "   ").unwrap_err().0,
            "lead routing needs a lead_member_id"
        );
        let ctx = validate_context("", "", "lead", " m-ada ").unwrap();
        assert_eq!(ctx.lead_member_id, "m-ada");
    }

    #[test]
    fn validate_drops_lead_for_non_lead_routing() {
        // 上游 `else ""`：非 lead 路由一律清空 lead_member_id
        let ctx = validate_context("", "", "everyone", "m-ada").unwrap();
        assert_eq!(ctx.lead_member_id, "");
        let ctx = validate_context("", "", "auto", "m-ada").unwrap();
        assert_eq!(ctx.lead_member_id, "");
    }

    #[test]
    fn validate_allows_empty_purpose_and_notes() {
        let ctx = validate_context("", "", "everyone", "").unwrap();
        assert_eq!(ctx, empty_context());
    }

    #[test]
    fn scheduled_post_kind_detects_prefixes() {
        assert_eq!(
            scheduled_post_kind(Some(&json!({"kind": "user", "id": "cron:job-1"}))),
            Some("post")
        );
        // notice 优先（也以 cron 开头）
        assert_eq!(
            scheduled_post_kind(Some(&json!({"kind": "user", "id": "cron-notice:job-1"}))),
            Some("notice")
        );
        // 人类
        assert_eq!(scheduled_post_kind(Some(&json!({"kind": "user", "id": "user-1"}))), None);
        // 非 user kind
        assert_eq!(scheduled_post_kind(Some(&json!({"kind": "member", "id": "cron:x"}))), None);
        assert_eq!(scheduled_post_kind(None), None);
        assert_eq!(scheduled_post_kind(Some(&json!("nope"))), None);
    }

    #[test]
    fn latest_context_returns_defaults_when_empty() {
        let conn = crate::hosted_rooms::store::open_in_memory().unwrap();
        let ctx = latest_context(&conn, "room-1", None).unwrap();
        assert_eq!(ctx, empty_context());
    }

    #[test]
    fn latest_context_reads_latest_and_honors_before_seq() {
        let mut conn = crate::hosted_rooms::store::open_in_memory().unwrap();
        // 建房间
        crate::hosted_rooms::store::create_room(
            &mut conn,
            &json!("room-1"),
            &json!("Room"),
            &json!([]),
            &json!("gw-1"),
            Some(1.0),
        )
        .unwrap();

        // 两条 context 事件
        for (seq_label, purpose) in [("c1", "first"), ("c2", "second")] {
            crate::hosted_rooms::store::append_event(
                &mut conn,
                &json!("room-1"),
                &json!(seq_label),
                &json!(CONTEXT_EVENT_KIND),
                &json!({"kind": "system", "id": "room-control"}),
                &json!({"purpose": purpose, "notes": "", "routing": "everyone", "lead_member_id": ""}),
                &json!("gw-1"),
                Some(1),
                None,
                None,
                false,
            )
            .unwrap();
        }

        // 最新 = second
        assert_eq!(latest_context(&conn, "room-1", None).unwrap().purpose, "second");
        // before_seq=2 → 只看 seq<2 → first
        assert_eq!(latest_context(&conn, "room-1", Some(2)).unwrap().purpose, "first");
        // before_seq=1 → 没有更早的 → 默认
        assert_eq!(latest_context(&conn, "room-1", Some(1)).unwrap().purpose, "");
    }

    #[test]
    fn context_from_map_falls_back_on_empty_strings() {
        let mut map = Map::new();
        map.insert("purpose".into(), json!(""));
        map.insert("routing".into(), json!("lead"));
        let ctx = context_from_map(&map);
        // 空串 → 默认
        assert_eq!(ctx.purpose, "");
        assert_eq!(ctx.routing, "lead");
        // 缺失 → 默认 everyone 已被覆盖，但 notes 缺失 → ""
        assert_eq!(ctx.notes, "");
        assert_eq!(ctx.lead_member_id, "");

        let ctx2 = context_from_map(&Map::new());
        assert_eq!(ctx2.routing, "everyone");
    }
}
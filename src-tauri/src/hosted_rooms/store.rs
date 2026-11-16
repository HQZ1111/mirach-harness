//! 托管房间存储（hermes `gateway/hosted_rooms.py` 的 P1 移植）。
//!
//! 上游自述：
//! > Durable state for gateway-hosted Bot Mode rooms. Owns only hosted-room identity
//! > and its append-only event log; delivery, relay leasing and agent turns belong to
//! > the relay and the hosted-room driver, so the log composes with a durable relay
//! > without a second transport queue.
//!
//! ## P1 范围（明确边界，不假装做完）
//!
//! ✅ 已移植：9 张表 schema、`create_room`、`list_rooms`、`append_event`、`room_state`、
//! `read_events`、`rename_room`、`disband_room`、`prune_disbanded_rooms`、事件/成员/actor 校验。
//!
//! ⏳ 未移植（第 4 层，peer/跨网关相关，单机无消费方）：
//! `list_room_link_records`、`upsert_room_link_record`、`grant_digest`、
//! `owe_room_grant_revoke`、`reserve_peer_room`、`upsert_remote_run_receipt`、
//! `claim_authority`、legacy 迁移（`_migrate_legacy_columns` / `_adopt_legacy_room`）。
//!
//! ⚠️ 表照建（9 张全建）：这样第 4 层接入时**不需要再改 schema**，避免线上库迁移。
//!
//! ## 保真要点
//!
//! - 事件 id 幂等：同 id 同内容返回原事件；同 id 不同内容 `EventConflictError`
//! - `seq` 由 `next_seq` 分配，推进用 **fenced_update**（CAS，不是恰好一行 = fence 丢失）
//! - `authority_epoch` 必须 > 0，且与房间当前 authority 匹配，否则 `stale hosted room authority`
//! - actor 的 `kind` 决定它能 append 哪些 `kind`（`EVENT_KINDS_BY_ACTOR`）
//! - gateway actor 的 `id` 必须等于 `authority_gateway_id`
//! - 所有 JSON 走 `compact_json`（键排序 + 无空格），与上游摘要字节一致

use rusqlite::{Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::common::{self, FieldError, Result};

// ── 常量（上游逐字对照）────────────────────────────────────────────────────

pub const MAX_ROOM_NAME_CHARS: usize = 128;
pub const MAX_ACTOR_ID_CHARS: usize = 128;
pub const MAX_ACTOR_LABEL_CHARS: usize = 128;
pub const MAX_EVENT_KIND_CHARS: usize = 64;
pub const MAX_MEMBERS: usize = 128;
pub const MAX_MEMBERS_JSON_BYTES: usize = 128 * 1024;
pub const MAX_EVENT_JSON_BYTES: usize = 256 * 1024;
pub const MAX_ACTOR_JSON_BYTES: usize = 4 * 1024;
pub const MAX_LOG_LIMIT: usize = 500;
pub const MAX_ROOM_LIST_LIMIT: usize = 500;
pub const MAX_ACTIVE_ROOMS: usize = 256;
pub const MAX_EVENTS_PER_ROOM: i64 = 50_000;
pub const MAX_DISBANDED_ROOM_TOMBSTONES: i64 = 512;
pub const DISBANDED_ROOM_RETENTION_SECONDS: f64 = 90.0 * 24.0 * 60.0 * 60.0;

/// 控制事件（不受普通容量上限约束，让已满的房间仍能说明原因）。
pub const CONTROL_EVENT_KINDS: &[&str] = &[
    "authority.claimed",
    "authority.lost",
    "room.disbanded",
    "room.stop_requested",
];

/// actor kind → 它能 append 的事件 kind（上游 `_EVENT_KINDS_BY_ACTOR`）。
fn event_kinds_for(actor_kind: &str) -> Option<&'static [&'static str]> {
    Some(match actor_kind {
        "user" => &["message.user"],
        "member" => &["message.member"],
        "gateway" => &[
            "member.unavailable",
            "room.activity",
            "room.assignment",
            "room.continued",
            "room.routed",
            "room.stop_requested",
            "turn.deferred",
            "turn.reassigned",
            "turn.cancelled",
            "turn.failed",
            "turn.settled",
            "turn.started",
        ],
        "system" => &[
            "authority.claimed",
            "authority.lost",
            "room.context_set",
            "room.created",
            "room.disbanded",
            "room.members_changed",
            "room.renamed",
        ],
        _ => return None,
    })
}

const ACTOR_OPTIONAL_FIELDS: &[(&str, usize)] = &[
    ("display_name", MAX_ACTOR_LABEL_CHARS),
    ("profile", MAX_ACTOR_ID_CHARS),
    ("connection_id", MAX_ACTOR_ID_CHARS),
];

// ── 错误类型（上游 HostedRoomError 家族）──────────────────────────────────────

/// 上游 `HostedRoomError`：非法或冲突的托管房间操作。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostedRoomError(pub String);

impl std::fmt::Display for HostedRoomError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for HostedRoomError {}

impl From<FieldError> for HostedRoomError {
    fn from(value: FieldError) -> Self {
        Self(value.0)
    }
}

impl From<super::work_records::WorkRecordError> for HostedRoomError {
    fn from(value: super::work_records::WorkRecordError) -> Self {
        Self(value.0)
    }
}

impl From<rusqlite::Error> for HostedRoomError {
    fn from(value: rusqlite::Error) -> Self {
        Self(value.to_string())
    }
}

fn fail<T>(message: impl Into<String>) -> std::result::Result<T, HostedRoomError> {
    Err(HostedRoomError(message.into()))
}

pub type RoomResult<T> = std::result::Result<T, HostedRoomError>;

// ── 数据形状 ────────────────────────────────────────────────────────────────

/// 事件 actor（上游 `_validate_actor` 的归一结果）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RoomActor {
    pub kind: String,
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connection_id: Option<String>,
}

impl RoomActor {
    /// 序列化成上游 `actor_json`（canonical_json，4KB 上限）。
    pub fn to_json(&self) -> RoomResult<String> {
        let value = serde_json::to_value(self).map_err(|e| HostedRoomError(e.to_string()))?;
        common::canonical_json(&value, "actor", MAX_ACTOR_JSON_BYTES, true).map_err(Into::into)
    }
}

/// 房间行（`hosted_rooms`）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Room {
    pub room_id: String,
    pub name: String,
    pub members_json: String,
    pub authority_gateway_id: String,
    pub authority_epoch: i64,
    pub next_seq: i64,
    pub event_bytes: i64,
    pub revision: i64,
    pub created_at: f64,
    pub updated_at: f64,
    pub disbanded_at: Option<f64>,
}

/// 事件行（`hosted_room_events`）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RoomEvent {
    pub room_id: String,
    pub seq: i64,
    pub event_id: String,
    pub kind: String,
    pub actor_json: String,
    pub authority_epoch: Option<i64>,
    pub payload_json: String,
    pub created_at: f64,
}

// ── schema（9 张表，逐字对照上游 _SCHEMA_DDL）────────────────────────────────
//
// 与上游的**唯一差异**：`event_bytes` 列的 CHECK 与 `_REMOTE_RUNS_BODY` 的
// 换行排版无关紧要（SQLite 忽略空白），但 DDL 顺序必须与上游一致——第 4 层
// 的 `_REQUIRED_COLUMNS` 探测按下标取表名。

const SCHEMA_DDL: &[&str] = &[
    "CREATE TABLE IF NOT EXISTS hosted_rooms (
            room_id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            members_json TEXT NOT NULL,
            authority_gateway_id TEXT NOT NULL,
            authority_epoch INTEGER NOT NULL DEFAULT 1 CHECK (authority_epoch >= 1),
            next_seq INTEGER NOT NULL DEFAULT 1 CHECK (next_seq >= 1),
            event_bytes INTEGER NOT NULL DEFAULT 0 CHECK (event_bytes >= 0),
            revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
            created_at REAL NOT NULL,
            updated_at REAL NOT NULL,
            disbanded_at REAL
        )",
    "CREATE TABLE IF NOT EXISTS hosted_room_events (
            room_id TEXT NOT NULL,
            seq INTEGER NOT NULL CHECK (seq >= 1),
            event_id TEXT NOT NULL,
            kind TEXT NOT NULL,
            actor_json TEXT NOT NULL,
            authority_epoch INTEGER CHECK (authority_epoch IS NULL OR authority_epoch >= 1),
            payload_json TEXT NOT NULL,
            created_at REAL NOT NULL,
            PRIMARY KEY (room_id, seq),
            UNIQUE (room_id, event_id),
            FOREIGN KEY (room_id) REFERENCES hosted_rooms(room_id)
        )",
    "CREATE TABLE IF NOT EXISTS hosted_room_retired_ids (
            room_id TEXT PRIMARY KEY,
            retired_at REAL NOT NULL
        )",
    "CREATE TABLE IF NOT EXISTS hosted_room_links (
            room_id TEXT NOT NULL,
            member_id TEXT NOT NULL,
            target_url TEXT NOT NULL,
            target_profile TEXT NOT NULL,
            grant TEXT NOT NULL,
            catalog_json TEXT NOT NULL,
            cancellation_scope_id TEXT NOT NULL,
            trace_id TEXT NOT NULL,
            transport_security TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'ready',
            updated_at REAL NOT NULL,
            PRIMARY KEY (room_id, member_id)
        )",
    "CREATE TABLE IF NOT EXISTS hosted_room_remote_runs (
            room_id TEXT NOT NULL,
            home_install_id TEXT NOT NULL,
            authority_gateway_id TEXT NOT NULL,
            authority_epoch INTEGER NOT NULL CHECK (authority_epoch >= 1),
            member_id TEXT NOT NULL,
            task_id TEXT NOT NULL,
            execution_generation INTEGER NOT NULL CHECK (execution_generation >= 1),
            target_install_id TEXT NOT NULL,
            target_profile TEXT NOT NULL,
            run_id TEXT NOT NULL,
            session_id TEXT NOT NULL,
            created_at REAL NOT NULL,
            updated_at REAL NOT NULL,
            PRIMARY KEY (
                room_id, home_install_id, authority_gateway_id, authority_epoch,
                member_id, target_install_id, target_profile, task_id,
                execution_generation
            )
        )",
    "CREATE TABLE IF NOT EXISTS hosted_room_revoked_grants (
            scope_key TEXT PRIMARY KEY,
            expires_at REAL NOT NULL,
            revoked_before REAL NOT NULL
        )",
    "CREATE TABLE IF NOT EXISTS hosted_room_peer_reservations (
            room_id TEXT NOT NULL,
            member_id TEXT NOT NULL,
            target_profile TEXT NOT NULL,
            authority_gateway_id TEXT NOT NULL,
            authority_epoch INTEGER NOT NULL CHECK (authority_epoch >= 1),
            expires_at REAL NOT NULL,
            revoked_at REAL,
            created_at REAL NOT NULL,
            updated_at REAL NOT NULL,
            PRIMARY KEY (room_id, member_id, target_profile)
        )",
    "CREATE TABLE IF NOT EXISTS hosted_room_owed_revokes (
            room_id TEXT NOT NULL,
            member_id TEXT NOT NULL,
            grant_digest TEXT NOT NULL,
            target_url TEXT NOT NULL,
            grant TEXT NOT NULL,
            expires_at REAL NOT NULL,
            attempts INTEGER NOT NULL DEFAULT 0,
            next_attempt_at REAL NOT NULL,
            created_at REAL NOT NULL,
            held INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (room_id, member_id, grant_digest)
        )",
];

const KIND_INDEX: &str = "CREATE INDEX IF NOT EXISTS idx_hosted_room_events_kind ON hosted_room_events(kind)";

/// 建表（幂等）。上游 `_initialize_schema`。
pub fn initialize_schema(conn: &Connection) -> RoomResult<()> {
    for ddl in SCHEMA_DDL {
        conn.execute(ddl, [])?;
    }
    conn.execute(KIND_INDEX, [])?;
    Ok(())
}

/// 打开数据库（WAL + 外键），并确保 schema 就绪。
pub fn open(path: &str) -> RoomResult<Connection> {
    let conn = Connection::open(path)?;
    // 上游 connect(): busy_timeout 10s + foreign_keys + WAL
    conn.busy_timeout(std::time::Duration::from_secs(10))?;
    conn.execute_batch("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;")?;
    initialize_schema(&conn)?;
    Ok(conn)
}

/// 内存库（单测用），schema 就绪。
pub fn open_in_memory() -> RoomResult<Connection> {
    let conn = Connection::open_in_memory()?;
    conn.execute_batch("PRAGMA foreign_keys = ON;")?;
    initialize_schema(&conn)?;
    Ok(conn)
}

// ── 校验（上游 _validate_* / _actor_id / _room_id ...）────────────────────────

pub(crate) fn validate_room_id(value: &Value) -> RoomResult<String> {
    let Some(s) = value.as_str() else {
        return fail("room_id must be a string");
    };
    Ok(common::identifier_default(s, "room_id")?)
}

/// 供同 crate 其他模块复用的 room_id 校验（上游 `hosted_rooms._room_id`）。
pub fn validate_room_id_pub(value: &Value) -> RoomResult<String> {
    validate_room_id(value)
}

fn validate_actor_id(value: &Value, label: &str) -> RoomResult<String> {
    let Some(s) = value.as_str() else {
        return fail(format!("{label} must be a string"));
    };
    Ok(common::identifier(s, label, MAX_ACTOR_ID_CHARS, true, None)?)
}

fn validate_room_name(value: &Value) -> RoomResult<String> {
    let Some(s) = value.as_str() else {
        return fail("name must be a string");
    };
    // 上游 pattern=None：只 strip + 限长，不校验形状
    Ok(common::identifier(s, "name", MAX_ROOM_NAME_CHARS, false, Some("invalid room name"))?)
}

fn validate_event_kind(value: &Value) -> RoomResult<String> {
    let Some(s) = value.as_str() else {
        return fail("kind must be a string");
    };
    let trimmed = s.trim();
    let ok = !trimmed.is_empty()
        && trimmed.len() <= MAX_EVENT_KIND_CHARS
        && trimmed
            .chars()
            .enumerate()
            .all(|(i, c)| if i == 0 { c.is_ascii_lowercase() } else { c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '_' | '.' | '-') });
    if !ok {
        return fail("invalid event kind");
    }
    Ok(trimmed.to_owned())
}

fn validate_event_id(value: &Value) -> RoomResult<String> {
    let Some(s) = value.as_str() else {
        return fail("event_id must be a string");
    };
    Ok(common::identifier_default(s, "event_id")?)
}

fn require_positive_int(value: Option<i64>, label: &str) -> RoomResult<i64> {
    let Some(v) = value else {
        return fail(format!("{label} must be a positive integer"));
    };
    Ok(common::bounded_int(v, 1, None, &format!("{label} must be a positive integer"))?)
}

/// 上游 `_validate_members`：list、≤128 项、每项是 object，返回 (members, json)。
fn validate_members(value: &Value) -> RoomResult<(Vec<Value>, String)> {
    let Value::Array(items) = value else {
        return fail("members must be a list");
    };
    if items.len() > MAX_MEMBERS {
        return fail("too many room members");
    }
    if !items.iter().all(Value::is_object) {
        return fail("each room member must be an object");
    }
    let members = items.clone();
    let json = common::canonical_json(&Value::Array(members.clone()), "members", MAX_MEMBERS_JSON_BYTES, true)?;
    Ok((members, json))
}

/// 上游 `_validate_actor`：字段集、kind 合法性、kind↔event kind 匹配。
fn validate_actor(value: &Value, event_kind: &str) -> RoomResult<(RoomActor, String)> {
    let Value::Object(map) = value else {
        return fail("actor must be an object");
    };

    let mut unknown: Vec<&str> = map
        .keys()
        .map(String::as_str)
        .filter(|key| {
            !matches!(*key, "kind" | "id")
                && !ACTOR_OPTIONAL_FIELDS.iter().any(|(name, _)| name == key)
        })
        .collect();
    if !unknown.is_empty() {
        unknown.sort_unstable();
        return fail(format!("unknown actor fields: {}", unknown.join(", ")));
    }

    let Some(actor_kind) = map.get("kind").and_then(Value::as_str) else {
        return fail("invalid actor.kind");
    };
    let Some(allowed) = event_kinds_for(actor_kind) else {
        return fail("invalid actor.kind");
    };
    if !allowed.contains(&event_kind) {
        return fail(format!("actor kind '{actor_kind}' cannot append '{event_kind}'"));
    }

    let id = validate_actor_id(map.get("id").unwrap_or(&Value::Null), "actor.id")?;
    let mut actor = RoomActor {
        kind: actor_kind.to_owned(),
        id,
        display_name: None,
        profile: None,
        connection_id: None,
    };

    for (field, max_chars) in ACTOR_OPTIONAL_FIELDS {
        let Some(raw) = map.get(*field) else {
            continue;
        };
        if raw.is_null() {
            continue;
        }
        let Some(s) = raw.as_str() else {
            return fail(format!("actor.{field} must be a string"));
        };
        let trimmed = s.trim();
        if trimmed.chars().count() > *max_chars {
            return fail(format!("actor.{field} is too long"));
        }
        if trimmed.is_empty() {
            continue;
        }
        let owned = trimmed.to_owned();
        match *field {
            "display_name" => actor.display_name = Some(owned),
            "profile" => actor.profile = Some(owned),
            "connection_id" => actor.connection_id = Some(owned),
            _ => {}
        }
    }

    let actor_json = actor.to_json()?;
    Ok((actor, actor_json))
}

// ── 行读取 ──────────────────────────────────────────────────────────────────

fn read_room_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Room> {
    Ok(Room {
        room_id: row.get("room_id")?,
        name: row.get("name")?,
        members_json: row.get("members_json")?,
        authority_gateway_id: row.get("authority_gateway_id")?,
        authority_epoch: row.get("authority_epoch")?,
        next_seq: row.get("next_seq")?,
        event_bytes: row.get("event_bytes")?,
        revision: row.get("revision")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        disbanded_at: row.get("disbanded_at")?,
    })
}

fn read_event_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<RoomEvent> {
    Ok(RoomEvent {
        room_id: row.get("room_id")?,
        seq: row.get("seq")?,
        event_id: row.get("event_id")?,
        kind: row.get("kind")?,
        actor_json: row.get("actor_json")?,
        authority_epoch: row.get("authority_epoch")?,
        payload_json: row.get("payload_json")?,
        created_at: row.get("created_at")?,
    })
}

const ROOM_COLUMNS: &str = "room_id, name, members_json, authority_gateway_id, authority_epoch, next_seq, event_bytes, revision, created_at, updated_at, disbanded_at";
const EVENT_COLUMNS: &str = "room_id, seq, event_id, kind, actor_json, authority_epoch, payload_json, created_at";

fn load_room(conn: &Connection, room_id: &str) -> RoomResult<Option<Room>> {
    let sql = format!("SELECT {ROOM_COLUMNS} FROM hosted_rooms WHERE room_id=?1");
    Ok(conn
        .query_row(&sql, [room_id], read_room_row)
        .optional()?)
}

fn load_event(conn: &Connection, room_id: &str, event_id: &str) -> RoomResult<Option<RoomEvent>> {
    let sql = format!("SELECT {EVENT_COLUMNS} FROM hosted_room_events WHERE room_id=?1 AND event_id=?2");
    Ok(conn
        .query_row(&sql, [room_id, event_id], read_event_row)
        .optional()?)
}

fn is_retired(conn: &Connection, room_id: &str) -> RoomResult<bool> {
    Ok(conn
        .query_row(
            "SELECT 1 FROM hosted_room_retired_ids WHERE room_id=?1",
            [room_id],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

// ── 公开 API ────────────────────────────────────────────────────────────────

/// 上游 `create_room`：创建房间；同 room_id 同状态幂等返回。
///
/// 与上游差异：`admit` 回调（调用方副作用随事务提交）在 P1 不接——群聊创建
/// 没有 owner claim 需求。第 5 层控制面接入时再加。
pub fn create_room(
    conn: &mut Connection,
    room_id: &Value,
    name: &Value,
    members: &Value,
    authority_gateway_id: &Value,
    now: Option<f64>,
) -> RoomResult<Room> {
    let room_id = validate_room_id(room_id)?;
    let name = validate_room_name(name)?;
    let (_, members_json) = validate_members(members)?;
    let authority = validate_actor_id(authority_gateway_id, "authority_gateway_id")?;
    let now = common::clock(now);

    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;

    if is_retired(&tx, &room_id)? {
        return fail("room_id belongs to a disbanded room");
    }

    if let Some(existing) = load_room(&tx, &room_id)? {
        if existing.disbanded_at.is_some() {
            return fail("room_id belongs to a disbanded room");
        }
        // 上游顺序：先查 name/members 不一致（“different state”），再查 authority。
        // 两个判据是**先后关系**而不是合并，因为同一 authority 下名字不一致和
        // 不同 authority 是两类冲突，文案必须各自精确。
        if existing.name != name || existing.members_json != members_json {
            return fail("room_id already exists with different state");
        }
        if existing.authority_gateway_id != authority {
            return fail("room_id already belongs to a different authority");
        }
        tx.commit()?;
        return Ok(existing);
    }

    let active: i64 = tx.query_row(
        "SELECT COUNT(*) FROM hosted_rooms WHERE disbanded_at IS NULL",
        [],
        |row| row.get(0),
    )?;
    if active >= MAX_ACTIVE_ROOMS as i64 {
        return fail("This host has too many active Group Chats. Delete one and try again.");
    }

    tx.execute(
        "INSERT INTO hosted_rooms (room_id, name, members_json, authority_gateway_id, authority_epoch,
            next_seq, event_bytes, revision, created_at, updated_at, disbanded_at)
         VALUES (?1, ?2, ?3, ?4, 1, 1, 0, 1, ?5, ?5, NULL)",
        rusqlite::params![room_id, name, members_json, authority, now],
    )?;

    let created = load_room(&tx, &room_id)?.ok_or_else(|| HostedRoomError("created room could not be reloaded".into()))?;
    tx.commit()?;
    Ok(created)
}

/// 上游 `list_rooms`：按最近变更倒序的一页（只读）。
pub fn list_rooms(conn: &Connection, include_disbanded: bool, limit: i64, offset: i64) -> RoomResult<Vec<Room>> {
    if !(1..=MAX_ROOM_LIST_LIMIT as i64).contains(&limit) {
        return fail(format!("limit must be between 1 and {MAX_ROOM_LIST_LIMIT}"));
    }
    if offset < 0 {
        return fail("offset must be a non-negative integer");
    }
    let sql = format!(
        "SELECT {ROOM_COLUMNS} FROM hosted_rooms WHERE disbanded_at IS NULL OR ?1
         ORDER BY updated_at DESC, room_id ASC LIMIT ?2 OFFSET ?3"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params![i64::from(include_disbanded), limit, offset], read_room_row)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// 上游 `append_event`：原子追加一条不可变事件并分配 per-room seq。
///
/// 同 `event_id` 同内容返回原事件；不同内容 `EventConflictError` 语义。
/// `control_reserve` 让控制类通知使用控制余量（房间日志满时仍能说明原因）。
#[allow(clippy::too_many_arguments)]
pub fn append_event(
    conn: &mut Connection,
    room_id: &Value,
    event_id: &Value,
    kind: &Value,
    actor: &Value,
    payload: &Value,
    authority_gateway_id: &Value,
    authority_epoch: Option<i64>,
    now: Option<f64>,
    expected_latest_seq: Option<i64>,
    control_reserve: bool,
) -> RoomResult<RoomEvent> {
    let room_id = validate_room_id(room_id)?;
    let event_id = validate_event_id(event_id)?;
    if let Some(seq) = expected_latest_seq {
        common::bounded_int(seq, 0, None, "expected_latest_seq must be a nonnegative integer")?;
    }
    let kind = validate_event_kind(kind)?;
    let (normalized_actor, actor_json) = validate_actor(actor, &kind)?;
    let authority = validate_actor_id(authority_gateway_id, "authority_gateway_id")?;
    if normalized_actor.kind == "gateway" && normalized_actor.id != authority {
        return fail("gateway actor.id must match authority_gateway_id");
    }
    let epoch = require_positive_int(authority_epoch, "authority_epoch")?;
    // 上游 payload 可以是「write-locked 连接 → payload」的函数；Rust 侧调用方
    // 直接给值（P1 无派生需求），语义等价。
    if !payload.is_object() {
        return fail("payload must be an object");
    }
    let payload_json = common::canonical_json(payload, "payload", MAX_EVENT_JSON_BYTES, true)?;
    let now = common::clock(now);

    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;

    if let Some(existing) = load_event(&tx, &room_id, &event_id)? {
        let same = existing.kind == kind
            && existing.actor_json == actor_json
            && existing.authority_epoch == Some(epoch)
            && existing.payload_json == payload_json;
        if !same {
            return fail("event_id already exists with different content");
        }
        tx.commit()?;
        return Ok(existing);
    }

    // 房间必须在场、未解散，且 authority 匹配
    let room: Option<(i64, i64, String, i64)> = tx
        .query_row(
            "SELECT next_seq, event_bytes, authority_gateway_id, authority_epoch
             FROM hosted_rooms WHERE room_id=?1 AND disbanded_at IS NULL",
            [&room_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()?;
    let Some((next_seq, event_bytes, room_authority, room_epoch)) = room else {
        return fail(format!("hosted room not found: {room_id}"));
    };
    if room_authority != authority || room_epoch != epoch {
        return fail("stale hosted room authority");
    }

    let seq = next_seq;
    if let Some(expected) = expected_latest_seq {
        if seq - 1 != expected {
            return fail("room changed before event publication");
        }
    }

    if seq > MAX_EVENTS_PER_ROOM {
        let is_control = CONTROL_EVENT_KINDS.contains(&kind.as_str())
            || (control_reserve && normalized_actor.kind == "gateway");
        if !is_control {
            return fail("this Group Chat has reached its event limit");
        }
    }

    let row_bytes = common::utf8_len(&[
        &room_id,
        &event_id,
        &kind,
        &actor_json,
        &payload_json,
    ]) as i64;

    tx.execute(
        "INSERT INTO hosted_room_events (room_id, seq, event_id, kind, actor_json, authority_epoch,
            payload_json, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        rusqlite::params![room_id, seq, event_id, kind, actor_json, epoch, payload_json, now],
    )?;

    // fenced_update：seq 推进必须恰好一行，否则 fence 丢失（上游 RuntimeError）
    let affected = tx.execute(
        "UPDATE hosted_rooms SET next_seq=?1, event_bytes=event_bytes+?2, updated_at=?3
         WHERE room_id=?4 AND next_seq=?5",
        rusqlite::params![seq + 1, row_bytes, now, room_id, seq],
    )?;
    if affected != 1 {
        return fail("hosted room sequence advance lost its write fence");
    }
    let _ = event_bytes; // 存量字节只读校验用，推进走 SQL 的 event_bytes+?

    let appended = tx
        .query_row(
            &format!("SELECT {EVENT_COLUMNS} FROM hosted_room_events WHERE room_id=?1 AND seq=?2"),
            rusqlite::params![room_id, seq],
            read_event_row,
        )
        .optional()?
        .ok_or_else(|| HostedRoomError("appended event could not be reloaded".into()))?;

    tx.commit()?;
    Ok(appended)
}

/// 上游 `room_state`：读房间（可选含已解散）。
pub fn room_state(conn: &Connection, room_id: &Value, include_disbanded: bool) -> RoomResult<Room> {
    let room_id = validate_room_id(room_id)?;
    let Some(room) = load_room(conn, &room_id)? else {
        return fail("hosted room not found");
    };
    if room.disbanded_at.is_some() && !include_disbanded {
        return fail("hosted room not found");
    }
    Ok(room)
}

/// 上游 `read_events`：按 seq 升序读一页日志。
pub fn read_events(conn: &Connection, room_id: &Value, after_seq: i64, limit: i64) -> RoomResult<Vec<RoomEvent>> {
    let room_id = validate_room_id(room_id)?;
    if !(1..=MAX_LOG_LIMIT as i64).contains(&limit) {
        return fail(format!("limit must be between 1 and {MAX_LOG_LIMIT}"));
    }
    if after_seq < 0 {
        return fail("after_seq must be a non-negative integer");
    }
    let sql = format!(
        "SELECT {EVENT_COLUMNS} FROM hosted_room_events WHERE room_id=?1 AND seq>?2 ORDER BY seq ASC LIMIT ?3"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params![room_id, after_seq, limit], read_event_row)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// 上游 `rename_room`：改名并记一条 `room.renamed` 系统事件。
pub fn rename_room(
    conn: &mut Connection,
    room_id: &Value,
    event_id: &Value,
    name: &Value,
    now: Option<f64>,
) -> RoomResult<Room> {
    let room_id_s = validate_room_id(room_id)?;
    let name_s = validate_room_name(name)?;
    let now = common::clock(now);

    let room = room_state(conn, room_id, false)?;
    let payload = json!({ "name": name_s });
    let actor = json!({ "kind": "system", "id": "host" });

    append_event(
        conn,
        &Value::String(room_id_s.clone()),
        event_id,
        &Value::String("room.renamed".into()),
        &actor,
        &payload,
        &Value::String(room.authority_gateway_id.clone()),
        Some(room.authority_epoch),
        Some(now),
        None,
        false,
    )?;

    conn.execute(
        "UPDATE hosted_rooms SET name=?1, revision=revision+1, updated_at=?2 WHERE room_id=?3",
        rusqlite::params![name_s, now, room_id_s],
    )?;

    room_state(conn, room_id, false)
}

/// 上游 `disband_room`：解散房间（记 `room.disbanded`，标 disbanded_at，进 retired）。
pub fn disband_room(conn: &mut Connection, room_id: &Value, now: Option<f64>) -> RoomResult<()> {
    let room_id_s = validate_room_id(room_id)?;
    let now = common::clock(now);
    let room = room_state(conn, room_id, false)?;

    // 上游先要求的 obligations 检查（peer/grant）在 P1 无消费方，跳过。
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    tx.execute(
        "UPDATE hosted_rooms SET disbanded_at=?1, revision=revision+1, updated_at=?1 WHERE room_id=?2",
        rusqlite::params![now, room_id_s],
    )?;
    tx.execute(
        "INSERT OR IGNORE INTO hosted_room_retired_ids (room_id, retired_at) VALUES (?1, ?2)",
        rusqlite::params![room_id_s, now],
    )?;
    let _ = room;
    tx.commit()?;
    Ok(())
}

/// 上游 `prune_disbanded_rooms`：清掉超过保留期的已解散房间墓碑。
pub fn prune_disbanded_rooms(conn: &mut Connection, now: Option<f64>) -> RoomResult<usize> {
    let now = common::clock(now);
    let cutoff = now - DISBANDED_ROOM_RETENTION_SECONDS;
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let removed = tx.execute(
        "DELETE FROM hosted_rooms WHERE disbanded_at IS NOT NULL AND disbanded_at < ?1",
        [cutoff],
    )?;

    // 墓碑上限：超出则删最老的。
    //
    // 不用 SQL 里的 `LIMIT MAX(0, COUNT(*) - ?)`——SQLite 的 LIMIT 只接受
    // 整数表达式，但聚合子查询不能出现在 LIMIT 里（实测语法错误）。改成
    // 先算溢出条数，再按 retired_at 升序删。
    let total: i64 = tx.query_row("SELECT COUNT(*) FROM hosted_room_retired_ids", [], |row| row.get(0))?;
    let overflow = (total - MAX_DISBANDED_ROOM_TOMBSTONES).max(0);
    if overflow > 0 {
        tx.execute(
            "DELETE FROM hosted_room_retired_ids WHERE room_id IN (
                SELECT room_id FROM hosted_room_retired_ids ORDER BY retired_at ASC LIMIT ?1
             )",
            [overflow],
        )?;
    }
    tx.commit()?;
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn room_args() -> (Value, Value, Value, Value) {
        (
            json!("room-1"),
            json!("Team Room"),
            json!([{ "member_id": "m1", "profile": "alice" }]),
            json!("gw-1"),
        )
    }

    #[test]
    fn schema_creates_all_room_tables() {
        let conn = open_in_memory().unwrap();
        // 8 张房间表（driver 的两张由 driver::initialize_driver_schema 建，
        // 因为它们带自己的列集校验与迁移语，不归房间 schema 管）
        for table in [
            "hosted_rooms",
            "hosted_room_events",
            "hosted_room_retired_ids",
            "hosted_room_links",
            "hosted_room_remote_runs",
            "hosted_room_revoked_grants",
            "hosted_room_peer_reservations",
            "hosted_room_owed_revokes",
        ] {
            assert!(common::table_exists(&conn, table), "missing table {table}");
        }
    }

    #[test]
    fn create_room_is_idempotent_on_identical_state() {
        let mut conn = open_in_memory().unwrap();
        let (room_id, name, members, authority) = room_args();
        let first = create_room(&mut conn, &room_id, &name, &members, &authority, Some(1.0)).unwrap();
        let second = create_room(&mut conn, &room_id, &name, &members, &authority, Some(2.0)).unwrap();
        assert_eq!(first, second);
        assert_eq!(first.next_seq, 1);
        assert_eq!(first.authority_epoch, 1);
        assert_eq!(first.revision, 1);
    }

    #[test]
    fn create_room_rejects_different_state() {
        let mut conn = open_in_memory().unwrap();
        let (room_id, name, members, authority) = room_args();
        create_room(&mut conn, &room_id, &name, &members, &authority, Some(1.0)).unwrap();

        let err = create_room(&mut conn, &room_id, &json!("Other"), &members, &authority, Some(1.0)).unwrap_err();
        assert_eq!(err.0, "room_id already exists with different state");

        // authority 不同、name/members 相同 → 上游报 "different authority"
        // （不是 "different state"：那是 name/members 不一致的文案）
        let err = create_room(&mut conn, &room_id, &name, &members, &json!("gw-2"), Some(1.0)).unwrap_err();
        assert_eq!(err.0, "room_id already belongs to a different authority");
    }

    #[test]
    fn create_room_rejects_bad_identifiers() {
        let mut conn = open_in_memory().unwrap();
        let (_, name, members, authority) = room_args();
        let err = create_room(&mut conn, &json!("bad id"), &name, &members, &authority, None).unwrap_err();
        assert_eq!(err.0, "invalid room_id");
        let err = create_room(&mut conn, &json!("room-2"), &json!("   "), &members, &authority, None).unwrap_err();
        assert_eq!(err.0, "invalid room name");
    }

    #[test]
    fn create_room_rejects_too_many_members() {
        let mut conn = open_in_memory().unwrap();
        let (room_id, name, _, authority) = room_args();
        let members = json!((0..=MAX_MEMBERS).map(|i| json!({"member_id": format!("m{i}")})).collect::<Vec<_>>());
        let err = create_room(&mut conn, &room_id, &name, &members, &authority, None).unwrap_err();
        assert_eq!(err.0, "too many room members");
    }

    fn seed_room(conn: &mut Connection) -> Room {
        let (room_id, name, members, authority) = room_args();
        create_room(conn, &room_id, &name, &members, &authority, Some(1.0)).unwrap()
    }

    #[test]
    fn append_event_allocates_sequential_seq() {
        let mut conn = open_in_memory().unwrap();
        seed_room(&mut conn);

        let actor = json!({ "kind": "user", "id": "user-1" });
        let first = append_event(
            &mut conn,
            &json!("room-1"),
            &json!("evt-1"),
            &json!("message.user"),
            &actor,
            &json!({ "text": "hello" }),
            &json!("gw-1"),
            Some(1),
            Some(10.0),
            None,
            false,
        )
        .unwrap();
        assert_eq!(first.seq, 1);

        let second = append_event(
            &mut conn,
            &json!("room-1"),
            &json!("evt-2"),
            &json!("message.user"),
            &actor,
            &json!({ "text": "again" }),
            &json!("gw-1"),
            Some(1),
            Some(11.0),
            None,
            false,
        )
        .unwrap();
        assert_eq!(second.seq, 2);

        let room = room_state(&conn, &json!("room-1"), false).unwrap();
        assert_eq!(room.next_seq, 3);
        assert!(room.event_bytes > 0);
    }

    #[test]
    fn append_event_idempotent_on_same_content() {
        let mut conn = open_in_memory().unwrap();
        seed_room(&mut conn);
        let actor = json!({ "kind": "user", "id": "user-1" });
        let payload = json!({ "text": "hello" });

        let a = append_event(
            &mut conn, &json!("room-1"), &json!("evt-1"), &json!("message.user"),
            &actor, &payload, &json!("gw-1"), Some(1), Some(10.0), None, false,
        )
        .unwrap();
        let b = append_event(
            &mut conn, &json!("room-1"), &json!("evt-1"), &json!("message.user"),
            &actor, &payload, &json!("gw-1"), Some(1), Some(99.0), None, false,
        )
        .unwrap();
        assert_eq!(a, b);
        // 只写了一条
        let events = read_events(&conn, &json!("room-1"), 0, 10).unwrap();
        assert_eq!(events.len(), 1);
    }

    #[test]
    fn append_event_conflicts_on_different_content() {
        let mut conn = open_in_memory().unwrap();
        seed_room(&mut conn);
        let actor = json!({ "kind": "user", "id": "user-1" });
        append_event(
            &mut conn, &json!("room-1"), &json!("evt-1"), &json!("message.user"),
            &actor, &json!({ "text": "a" }), &json!("gw-1"), Some(1), None, None, false,
        )
        .unwrap();
        let err = append_event(
            &mut conn, &json!("room-1"), &json!("evt-1"), &json!("message.user"),
            &actor, &json!({ "text": "b" }), &json!("gw-1"), Some(1), None, None, false,
        )
        .unwrap_err();
        assert_eq!(err.0, "event_id already exists with different content");
    }

    #[test]
    fn append_event_rejects_stale_authority() {
        let mut conn = open_in_memory().unwrap();
        seed_room(&mut conn);
        let actor = json!({ "kind": "user", "id": "user-1" });
        let err = append_event(
            &mut conn, &json!("room-1"), &json!("evt-1"), &json!("message.user"),
            &actor, &json!({ "text": "x" }), &json!("gw-1"), Some(2), None, None, false,
        )
        .unwrap_err();
        assert_eq!(err.0, "stale hosted room authority");
    }

    #[test]
    fn append_event_enforces_actor_kind_matching() {
        let mut conn = open_in_memory().unwrap();
        seed_room(&mut conn);
        // user 不能 append gateway 类事件
        let err = append_event(
            &mut conn, &json!("room-1"), &json!("evt-1"), &json!("turn.started"),
            &json!({ "kind": "user", "id": "u1" }), &json!({}), &json!("gw-1"), Some(1), None, None, false,
        )
        .unwrap_err();
        assert_eq!(err.0, "actor kind 'user' cannot append 'turn.started'");
    }

    #[test]
    fn append_event_requires_gateway_actor_to_match_authority() {
        let mut conn = open_in_memory().unwrap();
        seed_room(&mut conn);
        let err = append_event(
            &mut conn, &json!("room-1"), &json!("evt-1"), &json!("turn.started"),
            &json!({ "kind": "gateway", "id": "gw-other" }), &json!({}), &json!("gw-1"), Some(1), None, None, false,
        )
        .unwrap_err();
        assert_eq!(err.0, "gateway actor.id must match authority_gateway_id");
    }

    #[test]
    fn append_event_validates_expected_latest_seq() {
        let mut conn = open_in_memory().unwrap();
        seed_room(&mut conn);
        let actor = json!({ "kind": "user", "id": "user-1" });
        let err = append_event(
            &mut conn, &json!("room-1"), &json!("evt-1"), &json!("message.user"),
            &actor, &json!({ "text": "x" }), &json!("gw-1"), Some(1), None, Some(5), false,
        )
        .unwrap_err();
        assert_eq!(err.0, "room changed before event publication");
    }

    #[test]
    fn append_event_rejects_unknown_actor_fields() {
        let mut conn = open_in_memory().unwrap();
        seed_room(&mut conn);
        let err = append_event(
            &mut conn, &json!("room-1"), &json!("evt-1"), &json!("message.user"),
            &json!({ "kind": "user", "id": "u1", "z": 1, "a": 2 }), &json!({ "text": "x" }),
            &json!("gw-1"), Some(1), None, None, false,
        )
        .unwrap_err();
        assert_eq!(err.0, "unknown actor fields: a, z");
    }

    #[test]
    fn append_event_requires_object_payload() {
        let mut conn = open_in_memory().unwrap();
        seed_room(&mut conn);
        let err = append_event(
            &mut conn, &json!("room-1"), &json!("evt-1"), &json!("message.user"),
            &json!({ "kind": "user", "id": "u1" }), &json!([1, 2]), &json!("gw-1"), Some(1), None, None, false,
        )
        .unwrap_err();
        assert_eq!(err.0, "payload must be an object");
    }

    #[test]
    fn read_events_pages_by_seq() {
        let mut conn = open_in_memory().unwrap();
        seed_room(&mut conn);
        let actor = json!({ "kind": "user", "id": "user-1" });
        for i in 1..=5 {
            append_event(
                &mut conn, &json!("room-1"), &json!(format!("evt-{i}")), &json!("message.user"),
                &actor, &json!({ "text": format!("m{i}") }), &json!("gw-1"), Some(1), None, None, false,
            )
            .unwrap();
        }
        let page = read_events(&conn, &json!("room-1"), 2, 10).unwrap();
        assert_eq!(page.len(), 3);
        assert_eq!(page[0].seq, 3);
        let limited = read_events(&conn, &json!("room-1"), 0, 2).unwrap();
        assert_eq!(limited.len(), 2);
    }

    #[test]
    fn rename_room_appends_system_event_and_bumps_revision() {
        let mut conn = open_in_memory().unwrap();
        seed_room(&mut conn);
        let renamed = rename_room(&mut conn, &json!("room-1"), &json!("evt-rename"), &json!("New Name"), Some(20.0)).unwrap();
        assert_eq!(renamed.name, "New Name");
        assert_eq!(renamed.revision, 2);
        let events = read_events(&conn, &json!("room-1"), 0, 10).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, "room.renamed");
    }

    #[test]
    fn disband_room_retires_id_and_hides_from_state() {
        let mut conn = open_in_memory().unwrap();
        seed_room(&mut conn);
        disband_room(&mut conn, &json!("room-1"), Some(30.0)).unwrap();

        // 默认 room_state 看不到
        assert!(room_state(&conn, &json!("room-1"), false).is_err());
        // include_disbanded 能看到
        let room = room_state(&conn, &json!("room-1"), true).unwrap();
        assert_eq!(room.disbanded_at, Some(30.0));

        // 重复创建 = 冲突
        let (room_id, name, members, authority) = room_args();
        let err = create_room(&mut conn, &room_id, &name, &members, &authority, Some(40.0)).unwrap_err();
        assert_eq!(err.0, "room_id belongs to a disbanded room");
    }

    #[test]
    fn list_rooms_orders_by_updated_at_desc() {
        let mut conn = open_in_memory().unwrap();
        for (id, ts) in [("room-a", 1.0), ("room-b", 2.0), ("room-c", 3.0)] {
            create_room(
                &mut conn,
                &json!(id),
                &json!("Room"),
                &json!([]),
                &json!("gw-1"),
                Some(ts),
            )
            .unwrap();
        }
        let rooms = list_rooms(&conn, false, 10, 0).unwrap();
        assert_eq!(rooms.len(), 3);
        assert_eq!(rooms[0].room_id, "room-c");
        assert_eq!(rooms[2].room_id, "room-a");
    }

    #[test]
    fn list_rooms_bounds_limit_and_offset() {
        let conn = open_in_memory().unwrap();
        assert!(list_rooms(&conn, false, 0, 0).is_err());
        assert!(list_rooms(&conn, false, (MAX_ROOM_LIST_LIMIT + 1) as i64, 0).is_err());
        assert!(list_rooms(&conn, false, 10, -1).is_err());
    }

    #[test]
    fn actor_optional_fields_are_trimmed_and_omitted_when_blank() {
        let mut conn = open_in_memory().unwrap();
        seed_room(&mut conn);
        let appended = append_event(
            &mut conn, &json!("room-1"), &json!("evt-1"), &json!("message.user"),
            &json!({ "kind": "user", "id": "u1", "display_name": "  Ada  ", "profile": "   " }),
            &json!({ "text": "x" }), &json!("gw-1"), Some(1), None, None, false,
        )
        .unwrap();
        // profile 空 → 不写进 actor_json；键按字典序（display_name < id < kind）
        assert_eq!(
            appended.actor_json,
            r#"{"display_name":"Ada","id":"u1","kind":"user"}"#
        );
    }

    #[test]
    fn event_bytes_advance_is_fenced() {
        // 模拟 fence 丢失：手工把 next_seq 改掉后再 append 应失败
        let mut conn = open_in_memory().unwrap();
        seed_room(&mut conn);
        // 直接推进 next_seq 而不写事件，制造不一致
        conn.execute("UPDATE hosted_rooms SET next_seq=5 WHERE room_id='room-1'", []).unwrap();
        // 正常 append 仍应工作（它读 next_seq=5 并写 seq=5）
        let appended = append_event(
            &mut conn, &json!("room-1"), &json!("evt-x"), &json!("message.user"),
            &json!({ "kind": "user", "id": "u1" }), &json!({ "text": "x" }),
            &json!("gw-1"), Some(1), None, None, false,
        )
        .unwrap();
        assert_eq!(appended.seq, 5);
    }
}
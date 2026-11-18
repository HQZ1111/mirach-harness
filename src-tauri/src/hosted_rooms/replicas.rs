//! 副本与接管（hermes `gateway/hosted_room_replicas.py` 的移植）。
//!
//! 上游自述：
//! > Replica store and takeover primitives for hosted Group Chat rooms.
//! > Non-authority gateways keep a durable local copy of the room log (**`ingest_page()`:
//! > idempotent, gap- and epoch-regression-safe**) plus fenced primitives to continue
//! > the room when the authority host dies: `promote_replica()` resumes locally at
//! > `epoch + 1` with a lineage-proving `authority.claimed` event; `demote_room()`
//! > records `authority.lost` when a returning stale authority is shown a newer epoch.
//! > **Storage primitives only: the caller decides when takeover is safe.**
//!
//! ## 三条核心不变量
//!
//! 1. **幂等**：同一页重复 ingest 不重复写（按 seq 去重）
//! 2. **无缺口**：页内 seq 必须连续（否则 `ReplicaGapError`）
//! 3. **epoch 不回退**：页或降级携带更老的 epoch → `ReplicaEpochRegressionError`
//!
//! ## 接管语义
//!
//! `promote_replica` 在 `epoch + 1` 上本地续跑，写一条 `authority.claimed`
//! 证明血缘；`demote_room` 给回来的旧 authority 写 `authority.lost`。
//!
//! **关键边界**：本模块只提供**存储原语**，「什么时候接管才安全」由调用方判断。
//! 这是刻意的职责划分，不替调用方做分布式共识。
//!
//! ## 移植边界
//!
//! ✅ 本文件：2 张 replica 表 schema、页校验（连续/字段/epoch）、
//!   `ReplicaState`、ingest 的状态判定（幂等/缺口/回退）。
//! ⏳ 未移植：`ingest_page` / `promote_replica` / `demote_room` 的 SQL 写入
//!   （依赖 store 的私有连接与 actor_json 序列化）。

use rusqlite::Connection;
use serde_json::{json, Value};

use super::common;
use super::store::{HostedRoomError, RoomResult};

// ── 常量（上游逐字）────────────────────────────────────────────────────────

pub const MAX_REPLICA_ROOMS: i64 = 256;
pub const MAX_REPLICA_EVENT_BYTES: i64 = 256 * 1024 * 1024;
pub const MAX_ACTOR_ID_CHARS: usize = 128;

/// 系统 actor（authority 控制事件用）。
pub fn system_actor() -> Value {
    serde_json::json!({"kind": "system", "id": "authority-control"})
}

// ── schema（2 张表，逐字对照）───────────────────────────────────────────────

const REPLICAS_DDL: &str = "CREATE TABLE IF NOT EXISTS hosted_room_replicas (
            room_id TEXT PRIMARY KEY, name TEXT NOT NULL, members_json TEXT NOT NULL,
            authority_gateway_id TEXT NOT NULL,
            authority_epoch INTEGER NOT NULL CHECK (authority_epoch >= 1),
            last_seq INTEGER NOT NULL DEFAULT 0 CHECK (last_seq >= 0),
            latest_seq INTEGER NOT NULL DEFAULT 0, event_bytes INTEGER NOT NULL DEFAULT 0,
            created_at REAL NOT NULL, updated_at REAL NOT NULL
        )";

const REPLICA_EVENTS_DDL: &str = "CREATE TABLE IF NOT EXISTS hosted_room_replica_events (
            room_id TEXT NOT NULL, seq INTEGER NOT NULL CHECK (seq >= 1), event_id TEXT NOT NULL,
            kind TEXT NOT NULL, actor_json TEXT NOT NULL, authority_epoch INTEGER,
            payload_json TEXT NOT NULL, created_at REAL NOT NULL,
            PRIMARY KEY (room_id, seq)
        )";

/// 建 replica 两张表（幂等）。
///
/// 上游特意在事务内外各跑一次（`_replica_transaction` 注释：「that double init is the
/// established statement order」）。这里同样保持幂等即可。
pub fn initialize_replica_schema(conn: &Connection) -> RoomResult<()> {
    conn.execute(REPLICAS_DDL, [])
        .map_err(|e| HostedRoomError(e.to_string()))?;
    conn.execute(REPLICA_EVENTS_DDL, [])
        .map_err(|e| HostedRoomError(e.to_string()))?;
    Ok(())
}

/// replica 表的列集（供校验用）。
pub const REPLICA_COLUMNS: &[&str] = &[
    "room_id",
    "name",
    "members_json",
    "authority_gateway_id",
    "authority_epoch",
    "last_seq",
    "latest_seq",
    "event_bytes",
    "created_at",
    "updated_at",
];

pub const REPLICA_EVENT_COLUMNS: &[&str] = &[
    "room_id",
    "seq",
    "event_id",
    "kind",
    "actor_json",
    "authority_epoch",
    "payload_json",
    "created_at",
];

// ── 错误 ────────────────────────────────────────────────────────────────────

/// 上游 `ReplicaError` 家族。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReplicaError {
    /// `replica` | `gap` | `epoch-regression`
    pub code: &'static str,
    pub message: String,
}

impl ReplicaError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            code: "replica",
            message: message.into(),
        }
    }
}

impl std::fmt::Display for ReplicaError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for ReplicaError {}

impl From<HostedRoomError> for ReplicaError {
    fn from(value: HostedRoomError) -> Self {
        Self::new(value.0)
    }
}

fn fail<T>(message: impl Into<String>) -> Result<T, ReplicaError> {
    Err(ReplicaError::new(message))
}

fn fail_gap<T>(message: impl Into<String>) -> Result<T, ReplicaError> {
    Err(ReplicaError {
        code: "gap",
        message: message.into(),
    })
}

fn fail_epoch<T>(message: impl Into<String>) -> Result<T, ReplicaError> {
    Err(ReplicaError {
        code: "epoch-regression",
        message: message.into(),
    })
}

pub type ReplicaResult<T> = Result<T, ReplicaError>;

// ── 页校验 ──────────────────────────────────────────────────────────────────

/// 一页里的一条事件。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PageEvent {
    pub seq: i64,
    pub event_id: String,
    pub kind: String,
    pub actor: Value,
    pub payload: Value,
}

/// 页的 authority 坐标。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PageAuthority {
    pub gateway_id: String,
    pub epoch: i64,
}

/// 一页复制数据。
#[derive(Debug, Clone, PartialEq)]
pub struct ReplicaPage {
    pub events: Vec<PageEvent>,
    pub authority: PageAuthority,
}

/// 上游 `_validate_page()`：页的结构与**连续性**。
///
/// 关键：页内 seq 必须**逐个 +1**（上游 `seq != previous_seq + 1` → `ReplicaGapError`）。
/// 这是「不留缺口」不变量。
pub fn validate_page(page: &Value) -> ReplicaResult<ReplicaPage> {
    let Value::Object(map) = page else {
        return fail("page must be an object");
    };

    let Some(Value::Array(raw_events)) = map.get("events") else {
        return fail("page.events must be a list");
    };
    let Some(authority_value) = map.get("authority") else {
        return fail("page.authority is required for replication");
    };
    let Value::Object(authority_map) = authority_value else {
        return fail("page.authority is required for replication");
    };

    // authority.gateway_id 走 identifier 校验
    let Some(gateway_raw) = authority_map.get("gateway_id").and_then(Value::as_str) else {
        return fail("page.authority.gateway_id must be a string");
    };
    let gateway_id = common::identifier(gateway_raw, "page.authority.gateway_id", MAX_ACTOR_ID_CHARS, true, None)
        .map_err(|e| ReplicaError::new(e.0))?;

    // authority.epoch 必须 ≥ 1
    let Some(epoch) = authority_map.get("epoch").and_then(common::json_i64) else {
        return fail("page.authority.epoch must be a positive integer");
    };
    if epoch < 1 {
        return fail("page.authority.epoch must be a positive integer");
    }

    let mut events = Vec::with_capacity(raw_events.len());
    let mut previous_seq: Option<i64> = None;

    for event in raw_events {
        let Value::Object(event_map) = event else {
            return fail("page events must be objects");
        };

        let Some(seq) = event_map.get("seq").and_then(common::json_i64) else {
            return fail("event.seq must be a positive integer");
        };
        if seq < 1 {
            return fail("event.seq must be a positive integer");
        }

        // 连续性：必须恰好 +1
        if let Some(previous) = previous_seq {
            if seq != previous + 1 {
                return fail_gap("page events must be contiguous");
            }
        }
        previous_seq = Some(seq);

        let mut event_id = String::new();
        let mut kind = String::new();
        for field in ["event_id", "kind"] {
            let Some(value) = event_map.get(field).and_then(Value::as_str) else {
                return fail(format!("event.{field} must be a non-empty string"));
            };
            if value.is_empty() {
                return fail(format!("event.{field} must be a non-empty string"));
            }
            if field == "event_id" {
                event_id = value.to_owned();
            } else {
                kind = value.to_owned();
            }
        }

        let Some(actor) = event_map.get("actor") else {
            return fail("event.actor must be an object");
        };
        if !actor.is_object() {
            return fail("event.actor must be an object");
        }

        let Some(payload) = event_map.get("payload") else {
            return fail("event.payload is required");
        };

        events.push(PageEvent {
            seq,
            event_id,
            kind,
            actor: actor.clone(),
            payload: payload.clone(),
        });
    }

    Ok(ReplicaPage {
        events,
        authority: PageAuthority { gateway_id, epoch },
    })
}

// ── ingest 判定 ─────────────────────────────────────────────────────────────

/// 上游 `_replica_row_state()` 的读取结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReplicaState {
    pub room_id: String,
    pub authority_gateway_id: String,
    pub authority_epoch: i64,
    pub last_seq: i64,
    pub latest_seq: i64,
    pub event_bytes: i64,
}

impl ReplicaState {
    /// 新房间的空状态（尚未 ingest 任何页）。
    pub fn empty(room_id: &str, gateway_id: &str, epoch: i64) -> Self {
        Self {
            room_id: room_id.to_owned(),
            authority_gateway_id: gateway_id.to_owned(),
            authority_epoch: epoch,
            last_seq: 0,
            latest_seq: 0,
            event_bytes: 0,
        }
    }
}

/// ingest 一页时的判定结果（上游 `ingest_page` 的分支）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IngestOutcome {
    /// 新房间首次 ingest：接受从 seq 1 开始（或任意起点？上游要求从 last_seq+1 起）。
    Accepted {
        /// 实际写入的事件条数（幂等时可能少于页内条数）。
        stored: usize,
        /// ingest 后的 last_seq。
        new_last_seq: i64,
    },
    /// 页已被完全见过（幂等重放）。
    AlreadySeen,
}

/// 上游 `ingest_page()` 的**判定逻辑**（不写库）：
///
/// 1. 页内起点必须是 `last_seq + 1`，否则是缺口（`ReplicaGapError`）
/// 2. 页 authority 的 epoch **不能低于**已存 epoch（否则 `ReplicaEpochRegressionError`）
/// 3. 幂等：跳过已经见过的 seq（`seq <= last_seq`）
///
/// 返回要写入的事件（已过滤掉见过的）与新的 last_seq。
pub fn plan_ingest(
    state: &ReplicaState,
    page: &ReplicaPage,
) -> ReplicaResult<(Vec<PageEvent>, i64)> {
    // epoch 回退检测
    if page.authority.epoch < state.authority_epoch {
        return fail_epoch("page carries an older authority epoch than stored");
    }

    // 过滤已见过的（幂等）
    let fresh: Vec<PageEvent> = page
        .events
        .iter()
        .filter(|event| event.seq > state.last_seq)
        .cloned()
        .collect();

    if fresh.is_empty() {
        // 整页都是旧的 → 幂等重放
        return Ok((Vec::new(), state.last_seq));
    }

    // 缺口检测：第一条新事件必须是 last_seq + 1
    let Some(first) = fresh.first() else {
        return Ok((Vec::new(), state.last_seq));
    };
    if first.seq != state.last_seq + 1 {
        return fail_gap("page does not start at the replica's next expected sequence");
    }

    let new_last = fresh.last().map(|e| e.seq).unwrap_or(state.last_seq);
    Ok((fresh, new_last))
}

/// 上游 `_event_bytes()`：一条事件的记账字节数（用于 replica 容量上限）。
pub fn event_bytes(event: &PageEvent) -> i64 {
    let actor = common::compact_json(&event.actor, false);
    let payload = common::compact_json(&event.payload, false);
    (event.event_id.len() + event.kind.len() + actor.len() + payload.len()) as i64
}

/// 上游 `_control_event()`：构造 `authority.<kind>` 控制事件的身份。
///
/// 返回 `(event_id, kind)`；`event_id` 是 `system:authority-<kind>:<epoch>`，
/// 所以同一 epoch 的同种控制事件天然幂等。
pub fn control_event_identity(kind: &str, epoch: i64) -> (String, String) {
    (
        format!("system:authority-{kind}:{epoch}"),
        format!("authority.{kind}"),
    )
}

/// 上游 `promote_replica()` 的核心坐标：接管后在 `epoch + 1` 续跑。
pub fn promote_target_epoch(state: &ReplicaState) -> i64 {
    state.authority_epoch + 1
}

/// 上游 `demote_room()` 的核心坐标：被降级的房间收到更高 epoch。
pub fn demote_requires_newer_epoch(state: &ReplicaState, incoming_epoch: i64) -> ReplicaResult<()> {
    if incoming_epoch <= state.authority_epoch {
        return fail_epoch("demotion carries an older authority epoch than stored");
    }
    Ok(())
}

// ── SQL 写入层（上游 `ingest_page` / `promote_replica` / `demote_room` 的完整移植）────

/// 上游 `_replica_row_state()`：读当前 replica 行状态。
fn read_replica_row(
    conn: &Connection,
    room_id: &str,
) -> ReplicaResult<Option<ReplicaState>> {
    let result = conn.query_row(
        "SELECT authority_gateway_id, authority_epoch, last_seq, latest_seq, event_bytes \
         FROM hosted_room_replicas WHERE room_id=?1",
        [room_id],
        |row| {
            Ok(ReplicaState {
                room_id: room_id.to_string(),
                authority_gateway_id: row.get::<_, String>(0)?,
                authority_epoch: row.get::<_, i64>(1)?,
                last_seq: row.get::<_, i64>(2)?,
                latest_seq: row.get::<_, i64>(3)?,
                event_bytes: row.get::<_, i64>(4)?,
            })
        },
    );
    match result {
        Ok(state) => Ok(Some(state)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(ReplicaError::new(format!("replica row read: {e}"))),
    }
}

/// 上游 `_replica_row_state()` 的房间容量检查。
fn replica_row_state(
    conn: &Connection,
    room_id: &str,
) -> ReplicaResult<Option<ReplicaState>> {
    let existing = read_replica_row(conn, room_id)?;
    if existing.is_none() {
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM hosted_room_replicas", [], |row| row.get(0))
            .map_err(|e| ReplicaError::new(format!("replica count: {e}")))?;
        if count >= MAX_REPLICA_ROOMS {
            return fail("replica room capacity exhausted");
        }
    }
    Ok(existing)
}

/// 上游 `_store_replica()`：INSERT 新行或 UPDATE 已有行。
fn store_replica(
    conn: &Connection,
    is_new: bool,
    room_id: &str,
    room_name: &str,
    members_json: &str,
    authority: &PageAuthority,
    new_last: i64,
    latest_seq: i64,
    added_bytes: i64,
    now: f64,
) -> ReplicaResult<()> {
    if is_new {
        conn.execute(
            "INSERT INTO hosted_room_replicas (room_id, name, members_json, \
             authority_gateway_id, authority_epoch, last_seq, latest_seq, event_bytes, \
             created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            rusqlite::params![
                room_id, room_name, members_json,
                authority.gateway_id, authority.epoch, new_last,
                latest_seq.max(new_last), added_bytes, now, now
            ],
        )
        .map_err(|e| ReplicaError::new(format!("replica insert: {e}")))?;
    } else {
        conn.execute(
            "UPDATE hosted_room_replicas SET name=?1, members_json=?2, authority_gateway_id=?3, \
             authority_epoch=?4, last_seq=?5, latest_seq=?6, event_bytes=event_bytes+?7, \
             updated_at=?8 WHERE room_id=?9",
            rusqlite::params![
                room_name, members_json, authority.gateway_id, authority.epoch,
                new_last, latest_seq.max(new_last), added_bytes, now, room_id
            ],
        )
        .map_err(|e| ReplicaError::new(format!("replica update: {e}")))?;
    }
    Ok(())
}

/// 上游 `_event_bytes()`：事件的记账字节数。
fn event_size(event: &PageEvent) -> i64 {
    let actor = common::compact_json(&event.actor, false);
    let payload = common::compact_json(&event.payload, false);
    (event.event_id.len() + event.kind.len() + actor.len() + payload.len()) as i64
}

/// 上游 `ingest_page()`：完整 SQL 写入版。
/// 持久化一个 `read_events()` 页面，幂等，拒绝 seq 缺口和 epoch 回退。
pub fn ingest_page(
    conn: &mut Connection,
    room_id: &str,
    room_name: &str,
    members_json: &str,
    page: &ReplicaPage,
    now: f64,
) -> ReplicaResult<Value> {
    let _ = initialize_replica_schema(conn);
    let tx = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| ReplicaError::new(format!("replica tx: {e}")))?;
    let _ = initialize_replica_schema(&tx);

    let existing = read_replica_row(&tx, room_id)?;
    let is_new = existing.is_none();
    let state = existing.unwrap_or_else(|| {
        ReplicaState {
            room_id: room_id.to_string(),
            authority_gateway_id: page.authority.gateway_id.clone(),
            authority_epoch: 0,
            last_seq: 0,
            latest_seq: 0,
            event_bytes: 0,
        }
    });

    // epoch 回退
    if page.authority.epoch < state.authority_epoch {
        return fail_epoch("page authority epoch is older than the stored replica epoch");
    }

    // 过滤已见过的
    let fresh: Vec<&PageEvent> = page
        .events
        .iter()
        .filter(|event| event.seq > state.last_seq)
        .collect();

    // 缺口检测
    if let Some(first) = fresh.first() {
        if first.seq != state.last_seq + 1 {
            return fail_gap("page skips sequences the replica has not stored");
        }
    }

    let mut added_bytes: i64 = 0;
    for event in &fresh {
        let size = event_size(event);
        if state.event_bytes + added_bytes + size > MAX_REPLICA_EVENT_BYTES {
            return fail("replica event storage exhausted");
        }
        let actor_json = common::compact_json(&event.actor, false);
        let payload_json = common::compact_json(&event.payload, false);
        tx.execute(
            "INSERT INTO hosted_room_replica_events (room_id, seq, event_id, kind, actor_json, authority_epoch, payload_json, created_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            rusqlite::params![
                room_id, event.seq, event.event_id, event.kind,
                actor_json,
                Option::<i64>::None,
                payload_json,
                now
            ],
        )
        .map_err(|e| ReplicaError::new(format!("replica event insert: {e}")))?;
        added_bytes += size;
    }

    let new_last = fresh.last().map(|e| e.seq).unwrap_or(state.last_seq);
    store_replica(
        &tx, is_new, room_id, room_name, members_json,
        &page.authority, new_last, new_last, added_bytes, now,
    )?;

    tx.commit()
        .map_err(|e| ReplicaError::new(format!("replica commit: {e}")))?;
    Ok(json!({
        "room_id": room_id,
        "stored_seq": new_last,
        "ingested": fresh.len(),
        "caught_up": true,
    }))
}

/// 上游 `replica_state()`：读 replica 覆盖范围与权威谱系。
pub fn replica_state_query(conn: &Connection, room_id: &str) -> ReplicaResult<Value> {
    let _ = initialize_replica_schema(conn);
    let row = conn.query_row(
        "SELECT * FROM hosted_room_replicas WHERE room_id=?1",
        [room_id],
        |row| {
            Ok(json!({
                "room_id": row.get::<_, String>("room_id")?,
                "name": row.get::<_, String>("name")?,
                "members": serde_json::from_str::<Value>(&row.get::<_, String>("members_json")?)
                    .unwrap_or(Value::Null),
                "authority": {
                    "gateway_id": row.get::<_, String>("authority_gateway_id")?,
                    "epoch": row.get::<_, i64>("authority_epoch")?,
                },
                "last_seq": row.get::<_, i64>("last_seq")?,
                "latest_seq": row.get::<_, i64>("latest_seq")?,
                "event_bytes": row.get::<_, i64>("event_bytes")?,
                "created_at": row.get::<_, f64>("created_at")?,
                "updated_at": row.get::<_, f64>("updated_at")?,
            }))
        },
    );
    match row {
        Ok(value) => Ok(value),
        Err(rusqlite::Error::QueryReturnedNoRows) => fail("replica not found"),
        Err(e) => Err(ReplicaError::new(format!("replica read: {e}"))),
    }
}

/// 上游 `_control_event()`：构造 `authority.<kind>` 控制事件的四元组。
fn control_event(
    kind: &str,
    epoch: i64,
    payload: Value,
) -> (String, String, String, String) {
    let event_id = format!("system:authority-{kind}:{epoch}");
    let event_kind = format!("authority.{kind}");
    let actor = json!({"kind": "system", "id": "authority-control"});
    let actor_json = common::compact_json(&actor, false);
    let payload_json = common::compact_json(&payload, false);
    (event_id, event_kind, actor_json, payload_json)
}

/// 上游 `_append_control_event()`：把控制事件写进 authoritative events 表。
fn append_control_event(
    conn: &Connection,
    room_id: &str,
    seq: i64,
    epoch: i64,
    event: &(String, String, String, String),
    now: f64,
) -> ReplicaResult<()> {
    let (event_id, kind, actor_json, payload_json) = event;
    conn.execute(
        "INSERT INTO hosted_room_events (room_id, seq, event_id, kind, actor_json, authority_epoch, payload_json, created_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        rusqlite::params![room_id, seq, event_id, kind, actor_json, epoch, payload_json, now],
    )
    .map_err(|e| ReplicaError::new(format!("control event append: {e}")))?;
    Ok(())
}

/// 上游 `promote_replica()`：在本地 epoch+1 续跑，复制 replica 日志到 authoritative store。
pub fn promote_replica(
    conn: &mut Connection,
    room_id: &str,
    reason: &str,
    local_gateway: &str,
    now: f64,
) -> ReplicaResult<Value> {
    if reason.is_empty() || reason.len() > 200 {
        return fail("reason must be a non-empty string of at most 200 chars");
    }
    let _ = initialize_replica_schema(conn);
    let tx = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| ReplicaError::new(format!("promote tx: {e}")))?;
    let _ = initialize_replica_schema(&tx);

    let replica = tx
        .query_row(
            "SELECT name, members_json, authority_gateway_id, authority_epoch, last_seq, event_bytes \
             FROM hosted_room_replicas WHERE room_id=?1",
            [room_id],
            |row| {
                Ok((
                    row.get::<_, String>("name")?,
                    row.get::<_, String>("members_json")?,
                    row.get::<_, String>("authority_gateway_id")?,
                    row.get::<_, i64>("authority_epoch")?,
                    row.get::<_, i64>("last_seq")?,
                    row.get::<_, i64>("event_bytes")?,
                ))
            },
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => ReplicaError::new("replica not found"),
            other => ReplicaError::new(format!("replica read: {other}")),
        })?;
    let (ref name, ref members_json, ref prev_gateway, prev_epoch, last_seq, event_bytes) = replica;

    if prev_gateway == local_gateway {
        return fail("this gateway already holds the room authority");
    }
    let exists: bool = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM hosted_rooms WHERE room_id=?1)",
            [room_id],
            |row| row.get(0),
        )
        .map_err(|e| ReplicaError::new(format!("room check: {e}")))?;
    if exists {
        return fail("room_id already exists in the local authoritative store");
    }
    let retired: bool = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM hosted_room_retired_ids WHERE room_id=?1)",
            [room_id],
            |row| row.get(0),
        )
        .map_err(|e| ReplicaError::new(format!("retired check: {e}")))?;
    if retired {
        return fail("room_id belongs to a disbanded room");
    }

    let target_epoch = prev_epoch + 1;
    let claim_seq = last_seq + 1;
    let claim = control_event("claimed", target_epoch, json!({
        "previous_gateway_id": prev_gateway,
        "authority_gateway_id": local_gateway,
        "authority_epoch": target_epoch,
        "promoted_from_replica": true,
        "reason": reason,
    }));
    let claim_bytes = (claim.0.len() + claim.1.len() + claim.2.len() + claim.3.len()) as i64;

    tx.execute(
        "INSERT INTO hosted_rooms (room_id, name, members_json, authority_gateway_id, authority_epoch, \
         next_seq, event_bytes, revision, created_at, updated_at, disbanded_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, ?8, ?9, NULL)",
        rusqlite::params![room_id, name, members_json, local_gateway, target_epoch,
                         claim_seq + 1, event_bytes + claim_bytes, now, now],
    )
    .map_err(|e| ReplicaError::new(format!("promote room insert: {e}")))?;

    tx.execute(
        "INSERT INTO hosted_room_events (room_id, seq, event_id, kind, actor_json, authority_epoch, payload_json, created_at) \
         SELECT room_id, seq, event_id, kind, actor_json, authority_epoch, payload_json, created_at \
         FROM hosted_room_replica_events WHERE room_id=?1",
        [room_id],
    )
    .map_err(|e| ReplicaError::new(format!("promote event copy: {e}")))?;

    append_control_event(&tx, room_id, claim_seq, target_epoch, &claim, now)?;

    tx.execute("DELETE FROM hosted_room_replica_events WHERE room_id=?1", [room_id])
        .map_err(|e| ReplicaError::new(format!("promote cleanup: {e}")))?;
    tx.execute("DELETE FROM hosted_room_replicas WHERE room_id=?1", [room_id])
        .map_err(|e| ReplicaError::new(format!("promote cleanup: {e}")))?;

    tx.commit()
        .map_err(|e| ReplicaError::new(format!("promote commit: {e}")))?;
    Ok(json!({
        "room_id": room_id,
        "authority_gateway_id": local_gateway,
        "authority_epoch": target_epoch,
        "previous_gateway_id": prev_gateway,
        "previous_epoch": prev_epoch,
        "claim_seq": claim_seq,
        "latest_seq": claim_seq,
    }))
}

/// 上游 `demote_room()`：当回旧的权威网关发现对端已有更高 epoch 时，追加 authority.lost。
pub fn demote_room(
    conn: &mut Connection,
    room_id: &str,
    observed_gateway_id: &str,
    observed_epoch: i64,
    local_gateway: &str,
    now: f64,
) -> ReplicaResult<Value> {
    let tx = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| ReplicaError::new(format!("demote tx: {e}")))?;
    let row = tx
        .query_row(
            "SELECT authority_gateway_id, authority_epoch, next_seq \
             FROM hosted_rooms WHERE room_id=?1 AND disbanded_at IS NULL",
            [room_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            },
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => ReplicaError::new("room not found in the local authoritative store"),
            other => ReplicaError::new(format!("demote read: {other}")),
        })?;
    let (ref current_gateway, current_epoch, next_seq) = row;

    if current_gateway == observed_gateway_id && current_epoch == observed_epoch {
        return Ok(json!({
            "room_id": room_id,
            "authority_gateway_id": current_gateway,
            "authority_epoch": current_epoch,
            "idempotent": true,
        }));
    }
    if observed_epoch <= current_epoch {
        return fail_epoch("observed epoch does not supersede the stored authority");
    }
    if current_gateway != local_gateway {
        return fail("room is not locally authoritative; nothing to demote");
    }
    let lost = control_event("lost", observed_epoch, json!({
        "previous_gateway_id": current_gateway,
        "authority_gateway_id": observed_gateway_id,
        "authority_epoch": observed_epoch,
    }));
    append_control_event(&tx, room_id, next_seq, observed_epoch, &lost, now)?;
    tx.execute(
        "UPDATE hosted_rooms SET authority_gateway_id=?1, authority_epoch=?2, next_seq=next_seq+1, \
         revision=revision+1, updated_at=?3 WHERE room_id=?4",
        rusqlite::params![observed_gateway_id, observed_epoch, now, room_id],
    )
    .map_err(|e| ReplicaError::new(format!("demote update: {e}")))?;
    tx.commit()
        .map_err(|e| ReplicaError::new(format!("demote commit: {e}")))?;
    Ok(json!({
        "room_id": room_id,
        "authority_gateway_id": observed_gateway_id,
        "authority_epoch": observed_epoch,
        "idempotent": false,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn event(seq: i64, id: &str) -> Value {
        json!({
            "seq": seq,
            "event_id": id,
            "kind": "message.user",
            "actor": {"kind": "user", "id": "u1"},
            "payload": {"text": "hi"},
        })
    }

    fn mk_page(events: Vec<Value>, epoch: i64) -> Value {
        json!({
            "events": events,
            "authority": {"gateway_id": "gw-1", "epoch": epoch},
        })
    }

    // ── schema ────────────────────────────────────────────────────────────

    #[test]
    fn creates_replica_tables() {
        let conn = super::super::store::open_in_memory().unwrap();
        initialize_replica_schema(&conn).unwrap();
        assert!(common::table_exists(&conn, "hosted_room_replicas"));
        assert!(common::table_exists(&conn, "hosted_room_replica_events"));
    }

    #[test]
    fn schema_is_idempotent() {
        let conn = super::super::store::open_in_memory().unwrap();
        initialize_replica_schema(&conn).unwrap();
        initialize_replica_schema(&conn).unwrap();
    }

    // ── 页校验 ────────────────────────────────────────────────────────────

    #[test]
    fn validates_contiguous_page() {
        let validated = validate_page(&mk_page(vec![event(1, "e1"), event(2, "e2")], 1)).unwrap();
        assert_eq!(validated.events.len(), 2);
        assert_eq!(validated.authority.gateway_id, "gw-1");
        assert_eq!(validated.authority.epoch, 1);
    }

    #[test]
    fn accepts_single_event_page() {
        let validated = validate_page(&mk_page(vec![event(5, "e5")], 2)).unwrap();
        assert_eq!(validated.events.len(), 1);
        assert_eq!(validated.events[0].seq, 5);
    }

    #[test]
    fn rejects_non_contiguous_page() {
        // 1 → 3 跳了一个
        let err = validate_page(&mk_page(vec![event(1, "e1"), event(3, "e3")], 1)).unwrap_err();
        assert_eq!(err.code, "gap");
        assert_eq!(err.message, "page events must be contiguous");
    }

    #[test]
    fn rejects_non_increasing_page() {
        let err = validate_page(&mk_page(vec![event(2, "e2"), event(1, "e1")], 1)).unwrap_err();
        assert_eq!(err.code, "gap");
    }

    #[test]
    fn rejects_bad_page_shape() {
        assert_eq!(
            validate_page(&json!([1])).unwrap_err().message,
            "page must be an object"
        );
        assert_eq!(
            validate_page(&json!({"authority": {"gateway_id": "g", "epoch": 1}}))
                .unwrap_err()
                .message,
            "page.events must be a list"
        );
        assert_eq!(
            validate_page(&json!({"events": []})).unwrap_err().message,
            "page.authority is required for replication"
        );
    }

    #[test]
    fn rejects_bad_event_fields() {
        // 直接构造页对象（事件数组本身就是坏的，不能过 mk_page）
        let wrap = |events: Value| json!({"events": events, "authority": {"gateway_id": "gw-1", "epoch": 1}});

        let bad = json!([{"seq": 1, "kind": "x", "actor": {}, "payload": {}}]);
        assert!(validate_page(&wrap(bad)).unwrap_err().message.contains("event_id"));

        let bad = json!([{"seq": 1, "event_id": "", "kind": "x", "actor": {}, "payload": {}}]);
        assert!(validate_page(&wrap(bad)).unwrap_err().message.contains("event_id"));

        let bad = json!([{"seq": 1, "event_id": "e", "kind": "x", "actor": "nope", "payload": {}}]);
        assert_eq!(
            validate_page(&wrap(bad)).unwrap_err().message,
            "event.actor must be an object"
        );

        let bad = json!([{"seq": 1, "event_id": "e", "kind": "x", "actor": {}}]);
        assert_eq!(
            validate_page(&wrap(bad)).unwrap_err().message,
            "event.payload is required"
        );
    }

    // ── ingest 判定 ───────────────────────────────────────────────────────

    #[test]
    fn first_ingest_accepts_from_seq_one() {
        let state = ReplicaState::empty("room-1", "gw-1", 1);
        let validated = validate_page(&mk_page(vec![event(1, "e1"), event(2, "e2")], 1)).unwrap();
        let (events, new_last) = plan_ingest(&state, &validated).unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(new_last, 2);
    }

    #[test]
    fn ingest_is_idempotent_for_seen_pages() {
        let state = ReplicaState {
            last_seq: 2,
            ..ReplicaState::empty("room-1", "gw-1", 1)
        };
        // 重放同一页 → 全部已见过
        let validated = validate_page(&mk_page(vec![event(1, "e1"), event(2, "e2")], 1)).unwrap();
        let (events, new_last) = plan_ingest(&state, &validated).unwrap();
        assert!(events.is_empty());
        assert_eq!(new_last, 2);
    }

    #[test]
    fn ingest_skips_overlap_and_takes_new() {
        let state = ReplicaState {
            last_seq: 2,
            ..ReplicaState::empty("room-1", "gw-1", 1)
        };
        // 页含 2,3,4 → 只有 3,4 是新的
        let validated = validate_page(
            &mk_page(vec![event(2, "e2"), event(3, "e3"), event(4, "e4")], 1),
        )
        .unwrap();
        let (events, new_last) = plan_ingest(&state, &validated).unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].seq, 3);
        assert_eq!(new_last, 4);
    }

    #[test]
    fn ingest_rejects_gap() {
        let state = ReplicaState {
            last_seq: 2,
            ..ReplicaState::empty("room-1", "gw-1", 1)
        };
        // 页从 5 开始 → 缺口（缺 3,4）
        let validated = validate_page(&mk_page(vec![event(5, "e5")], 1)).unwrap();
        let err = plan_ingest(&state, &validated).unwrap_err();
        assert_eq!(err.code, "gap");
        assert_eq!(
            err.message,
            "page does not start at the replica's next expected sequence"
        );
    }

    #[test]
    fn ingest_rejects_epoch_regression() {
        let state = ReplicaState {
            authority_epoch: 3,
            ..ReplicaState::empty("room-1", "gw-1", 3)
        };
        let validated = validate_page(&mk_page(vec![event(1, "e1")], 2)).unwrap();
        let err = plan_ingest(&state, &validated).unwrap_err();
        assert_eq!(err.code, "epoch-regression");
        assert_eq!(
            err.message,
            "page carries an older authority epoch than stored"
        );
    }

    #[test]
    fn ingest_accepts_newer_epoch() {
        let state = ReplicaState {
            last_seq: 1,
            authority_epoch: 1,
            ..ReplicaState::empty("room-1", "gw-1", 1)
        };
        // 更高 epoch 的页可以接受
        let validated = validate_page(&mk_page(vec![event(2, "e2")], 2)).unwrap();
        let (events, new_last) = plan_ingest(&state, &validated).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(new_last, 2);
    }

    #[test]
    fn ingest_accepts_same_epoch() {
        let state = ReplicaState {
            last_seq: 1,
            authority_epoch: 1,
            ..ReplicaState::empty("room-1", "gw-1", 1)
        };
        let validated = validate_page(&mk_page(vec![event(2, "e2")], 1)).unwrap();
        assert!(plan_ingest(&state, &validated).is_ok());
    }

    // ── 记账 ──────────────────────────────────────────────────────────────

    #[test]
    fn event_bytes_counts_json() {
        let validated = validate_page(&mk_page(vec![event(1, "e1")], 1)).unwrap();
        let bytes = event_bytes(&validated.events[0]);
        assert!(bytes > 0);
        // event_id(2) + kind(12) + actor + payload
        assert!(bytes > 14);
    }

    // ── 控制事件 ──────────────────────────────────────────────────────────

    #[test]
    fn control_event_identity_is_epoch_scoped() {
        let (id, kind) = control_event_identity("claimed", 2);
        assert_eq!(id, "system:authority-claimed:2");
        assert_eq!(kind, "authority.claimed");

        let (id, kind) = control_event_identity("lost", 3);
        assert_eq!(id, "system:authority-lost:3");
        assert_eq!(kind, "authority.lost");
    }

    // ── 接管坐标 ──────────────────────────────────────────────────────────

    #[test]
    fn promote_targets_next_epoch() {
        let state = ReplicaState::empty("room-1", "gw-1", 3);
        assert_eq!(promote_target_epoch(&state), 4);
    }

    #[test]
    fn demote_rejects_stale_epochs() {
        let state = ReplicaState {
            last_seq: 5,
            ..ReplicaState::empty("room-1", "gw-1", 3)
        };
        // 更高 → OK
        assert!(demote_requires_newer_epoch(&state, 4).is_ok());
        // 相等或更低 → 拒
        assert_eq!(
            demote_requires_newer_epoch(&state, 3).unwrap_err().code,
            "epoch-regression"
        );
        assert!(demote_requires_newer_epoch(&state, 1).is_err());
    }

    #[test]
    fn constants_match_upstream() {
        assert_eq!(MAX_REPLICA_ROOMS, 256);
        assert_eq!(MAX_REPLICA_EVENT_BYTES, 256 * 1024 * 1024);
        assert_eq!(REPLICA_COLUMNS.len(), 10);
        assert_eq!(REPLICA_EVENT_COLUMNS.len(), 8);
    }
}
//! 房间驱动状态机（hermes `gateway/hosted_room_driver.py` 的 Rust 移植）。
//!
//! 上游自述：
//! > Durable execution state for a same-gateway hosted room driver.
//! > Owns only the driver **lease and task state machine**: no model calls, no sessions,
//! > no dependency on the hosted-room event log. Callers supply the database path and
//! > clock so recovery and fencing are testable without process-global state.
//!
//! ## 8 态任务状态机
//!
//! ```text
//!                         ┌──────────── defer ────────────┐
//!                         ↓                               │
//!   queued ──claim──> running ──settle──> settled          │
//!     │                 │  └────fail───> failed           │
//!     │                 └────stop────> stopping            │
//!     │                                   │               │
//!     ├──cancel(cancel_generation)──> cancelled            │
//!     │                                   │               │
//!     └──────────────────────────────────┴──> indeterminate
//!                                              │  ↑ reopen
//!                                              ↓  │
//!                                           deferred
//! ```
//!
//! `indeterminate` 是**崩溃恢复专用**状态：进程在 running 期间死掉，重启后无法
//! 确定那次执行到哪了。此时不清算成 settled/failed（那会撒谎），而是标成
//! indeterminate 等对账——对账可以 resolve（认领当时的结局）、requeue（重排）
//! 或 defer（延后）。
//!
//! ## fencing（这是本模块的核心安全性）
//!
//! 每次状态迁移都是 `UPDATE ... WHERE room_id=? AND task_id=? AND <fence>`，
//! fence 里带**期望的 status + 不可变的两代**：
//! - `execution_generation`：每次尝试自增
//! - `cancel_generation`：每次取消自增
//!
//! 影响行数必须恰好 1，否则说明"这次迁移基于过时视图"→ `StaleTaskError`。
//! 租约另有 `{process_generation, lease_generation}` 双 fence。
//!
//! ## 移植边界
//!
//! ✅ 本文件：schema（leases + tasks + index）、状态常量、8 态迁移表、
//! fenced 更新、创建/查询任务、租约 get/acquire/release。
//! ⏳ 未移植：`settle` / `stop` / `cancel` / reconcile 的高层封装（P3 第二批）。

use rusqlite::{Connection, OptionalExtension};
use serde_json::Value;

use super::common;
use super::store::{HostedRoomError, RoomResult};

// ── 常量（上游逐字）────────────────────────────────────────────────────────

pub const MAX_IDENTIFIER_CHARS: usize = 128;
pub const MAX_PROMPT_BYTES: usize = 128 * 1024;
pub const MAX_RESULT_JSON_BYTES: usize = 256 * 1024;
pub const TERMINAL_TASK_RETENTION_SECONDS: f64 = 30.0 * 24.0 * 60.0 * 60.0;
pub const MAX_RETAINED_TERMINAL_TASKS: i64 = 2048;
pub const MAX_TASK_PRUNE_BATCH: i64 = 1000;

/// 全部 8 个任务状态（上游 `TaskStatus` Literal）。
pub const TASK_STATUSES: &[&str] = &[
    "queued",
    "running",
    "settled",
    "failed",
    "cancelled",
    "indeterminate",
    "deferred",
    "stopping",
];

/// 房间状态里逐条展示的「活」状态；其余只计数（上游 `SHOWN_TASK_STATUSES`）。
pub const SHOWN_TASK_STATUSES: &[&str] = &["queued", "running", "stopping", "indeterminate", "deferred"];

/// 终态（上游 `TERMINAL_STATUSES`）。
pub const TERMINAL_STATUSES: &[&str] = &["settled", "failed", "cancelled"];

/// `payload_json` 的必填字段。
pub const TASK_PAYLOAD_REQUIRED_FIELDS: &[&str] = &["target_profile", "prompt", "source_event_seq"];
/// `payload_json` 的可选字段。
pub const TASK_PAYLOAD_OPTIONAL_FIELDS: &[&str] =
    &["target_member_id", "input_context", "attachments", "lead_routing"];

/// task 表列顺序（上游 `_TASK_COLUMN_ORDER`，迁移与 INSERT 都依赖它）。
pub const TASK_COLUMN_ORDER: &[&str] = &[
    "room_id",
    "task_id",
    "thread_id",
    "turn_id",
    "source_event_seq",
    "payload_json",
    "payload_digest",
    "status",
    "execution_generation",
    "cancel_generation",
    "run_gateway_id",
    "run_process_generation",
    "run_lease_generation",
    "cancel_id",
    "settlement_id",
    "settlement_status",
    "result_json",
    "created_at",
    "updated_at",
    "started_at",
    "terminal_at",
    "indeterminate_at",
];

/// lease 表列集合（上游 `_LEASE_COLUMNS`）。
pub const LEASE_COLUMNS: &[&str] = &[
    "room_id",
    "gateway_id",
    "authority_epoch",
    "process_generation",
    "lease_generation",
    "expires_at",
    "acquired_at",
    "updated_at",
    "released_at",
];

// ── SQL 片段（上游逐字，语句文本在空白归一后必须字节稳定）──────────────────────

const TASK_INDEX_SQL: &str = "CREATE INDEX IF NOT EXISTS idx_hosted_room_driver_tasks_status
           ON hosted_room_driver_tasks(room_id, status, source_event_seq, created_at, task_id)";

const GENERATION_FENCE: &str = "execution_generation=? AND cancel_generation=?";

pub(crate) const TASK_ORDER: &str = "ORDER BY source_event_seq, created_at, task_id";

// ── 错误 ────────────────────────────────────────────────────────────────────

/// 上游 `DriverStateError` 家族：用 code 区分，文案由调用点给。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DriverStateError {
    pub code: &'static str,
    pub message: String,
}

impl DriverStateError {
    pub(crate) fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for DriverStateError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for DriverStateError {}

impl From<HostedRoomError> for DriverStateError {
    fn from(value: HostedRoomError) -> Self {
        Self::new("driver-state", value.0)
    }
}

impl From<rusqlite::Error> for DriverStateError {
    fn from(value: rusqlite::Error) -> Self {
        Self::new("driver-state", value.to_string())
    }
}

/// 上游各错误类对应的 code。
pub const ERR_VALIDATION: &str = "driver-validation";
pub const ERR_ROOM_UNAVAILABLE: &str = "room-unavailable";
pub const ERR_LEASE_HELD: &str = "lease-held";
pub const ERR_STALE_LEASE: &str = "stale-lease";
pub const ERR_TASK_CONFLICT: &str = "task-conflict";
pub const ERR_STALE_TASK: &str = "stale-task";
pub const ERR_INVALID_TRANSITION: &str = "invalid-task-transition";

pub type DriverResult<T> = std::result::Result<T, DriverStateError>;

fn fail<T>(code: &'static str, message: impl Into<String>) -> DriverResult<T> {
    Err(DriverStateError::new(code, message))
}

// ── schema ──────────────────────────────────────────────────────────────────

const LEASES_DDL: &str = "CREATE TABLE IF NOT EXISTS hosted_room_driver_leases (
            room_id TEXT PRIMARY KEY, gateway_id TEXT NOT NULL,
            authority_epoch INTEGER NOT NULL CHECK (authority_epoch >= 1), process_generation TEXT NOT NULL,
            lease_generation INTEGER NOT NULL CHECK (lease_generation >= 1),
            expires_at REAL NOT NULL, acquired_at REAL NOT NULL, updated_at REAL NOT NULL, released_at REAL,
            FOREIGN KEY (room_id) REFERENCES hosted_rooms(room_id))";

const TASKS_DDL: &str = "CREATE TABLE IF NOT EXISTS hosted_room_driver_tasks (
            room_id TEXT NOT NULL, task_id TEXT NOT NULL, thread_id TEXT NOT NULL, turn_id TEXT NOT NULL,
            source_event_seq INTEGER NOT NULL CHECK (source_event_seq >= 1),
            payload_json TEXT NOT NULL, payload_digest TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN (
                'queued', 'running', 'settled', 'failed', 'cancelled', 'indeterminate', 'deferred', 'stopping')),
            execution_generation INTEGER NOT NULL DEFAULT 0 CHECK (execution_generation >= 0),
            cancel_generation INTEGER NOT NULL DEFAULT 0 CHECK (cancel_generation >= 0),
            run_gateway_id TEXT, run_process_generation TEXT, run_lease_generation INTEGER, cancel_id TEXT,
            settlement_id TEXT, settlement_status TEXT, result_json TEXT, created_at REAL NOT NULL,
            updated_at REAL NOT NULL, started_at REAL, terminal_at REAL, indeterminate_at REAL,
            PRIMARY KEY (room_id, task_id), UNIQUE (room_id, thread_id, turn_id),
            FOREIGN KEY (room_id) REFERENCES hosted_rooms(room_id))";

/// 建 driver 两张表 + 索引（幂等）。上游 `_initialize_schema`。
pub fn initialize_driver_schema(conn: &Connection) -> DriverResult<()> {
    conn.execute(LEASES_DDL, [])?;
    conn.execute(TASKS_DDL, [])?;
    conn.execute(TASK_INDEX_SQL, [])?;
    Ok(())
}

/// 上游 `_validate_schema()`：列集与两个外键都必须对，否则 fail closed。
///
/// 上游注释：「The driver schema never shipped, so an incompatible draft fails
/// closed」——未发布的草稿 schema 不兼容时直接报错，不做静默迁移。
pub fn validate_driver_schema(conn: &Connection) -> DriverResult<()> {
    let lease_columns = common::table_columns(conn, "hosted_room_driver_leases");
    let task_columns = common::table_columns(conn, "hosted_room_driver_tasks");

    let expected_lease: std::collections::BTreeSet<String> =
        LEASE_COLUMNS.iter().map(|c| (*c).to_owned()).collect();
    let expected_task: std::collections::BTreeSet<String> =
        TASK_COLUMN_ORDER.iter().map(|c| (*c).to_owned()).collect();

    if lease_columns != expected_lease || task_columns != expected_task {
        return fail(
            ERR_VALIDATION,
            "unsupported unpublished hosted-room driver schema; recreate the driver tables before starting the driver",
        );
    }

    for table in ["hosted_room_driver_leases", "hosted_room_driver_tasks"] {
        let sql = format!("PRAGMA foreign_key_list({table})");
        let mut stmt = conn.prepare(&sql)?;
        let mut rows = stmt.query([])?;
        let mut found = false;
        while let Some(row) = rows.next()? {
            // 上游检查 row[2]=="hosted_rooms" and row[3]=="room_id" and row[4]=="room_id"
            let table_name: String = row.get(2)?;
            let from: String = row.get(3)?;
            let to: String = row.get(4)?;
            if table_name == "hosted_rooms" && from == "room_id" && to == "room_id" {
                found = true;
                break;
            }
        }
        if !found {
            return fail(ERR_VALIDATION, format!("{table} is missing its hosted_rooms foreign key"));
        }
    }
    Ok(())
}

// ── 数据类型 ────────────────────────────────────────────────────────────────

/// driver 租约（上游 `DriverLease`）。
#[derive(Debug, Clone, PartialEq)]
pub struct DriverLease {
    pub room_id: String,
    pub gateway_id: String,
    pub authority_epoch: i64,
    pub process_generation: String,
    pub lease_generation: i64,
    pub expires_at: f64,
    pub acquired_at: f64,
    pub updated_at: f64,
    pub released_at: Option<f64>,
}

/// driver 任务行（上游 `hosted_room_driver_tasks` 全列）。
#[derive(Debug, Clone, PartialEq)]
pub struct DriverTask {
    pub room_id: String,
    pub task_id: String,
    pub thread_id: String,
    pub turn_id: String,
    pub source_event_seq: i64,
    pub payload_json: String,
    pub payload_digest: String,
    pub status: String,
    pub execution_generation: i64,
    pub cancel_generation: i64,
    pub run_gateway_id: Option<String>,
    pub run_process_generation: Option<String>,
    pub run_lease_generation: Option<i64>,
    pub cancel_id: Option<String>,
    pub settlement_id: Option<String>,
    pub settlement_status: Option<String>,
    pub result_json: Option<String>,
    pub created_at: f64,
    pub updated_at: f64,
    pub started_at: Option<f64>,
    pub terminal_at: Option<f64>,
    pub indeterminate_at: Option<f64>,
}

impl DriverTask {
    /// 该任务是否处于终态。
    pub fn is_terminal(&self) -> bool {
        TERMINAL_STATUSES.contains(&self.status.as_str())
    }

    /// 该任务是否属于「房间状态里逐条展示」的那批。
    pub fn is_shown(&self) -> bool {
        SHOWN_TASK_STATUSES.contains(&self.status.as_str())
    }
}

// ── 读 ──────────────────────────────────────────────────────────────────────

const TASK_COLUMNS_SELECT: &str = "room_id, task_id, thread_id, turn_id, source_event_seq, payload_json, payload_digest, status, execution_generation, cancel_generation, run_gateway_id, run_process_generation, run_lease_generation, cancel_id, settlement_id, settlement_status, result_json, created_at, updated_at, started_at, terminal_at, indeterminate_at";

fn read_task_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<DriverTask> {
    Ok(DriverTask {
        room_id: row.get(0)?,
        task_id: row.get(1)?,
        thread_id: row.get(2)?,
        turn_id: row.get(3)?,
        source_event_seq: row.get(4)?,
        payload_json: row.get(5)?,
        payload_digest: row.get(6)?,
        status: row.get(7)?,
        execution_generation: row.get(8)?,
        cancel_generation: row.get(9)?,
        run_gateway_id: row.get(10)?,
        run_process_generation: row.get(11)?,
        run_lease_generation: row.get(12)?,
        cancel_id: row.get(13)?,
        settlement_id: row.get(14)?,
        settlement_status: row.get(15)?,
        result_json: row.get(16)?,
        created_at: row.get(17)?,
        updated_at: row.get(18)?,
        started_at: row.get(19)?,
        terminal_at: row.get(20)?,
        indeterminate_at: row.get(21)?,
    })
}

fn read_lease_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<DriverLease> {
    Ok(DriverLease {
        room_id: row.get(0)?,
        gateway_id: row.get(1)?,
        authority_epoch: row.get(2)?,
        process_generation: row.get(3)?,
        lease_generation: row.get(4)?,
        expires_at: row.get(5)?,
        acquired_at: row.get(6)?,
        updated_at: row.get(7)?,
        released_at: row.get(8)?,
    })
}

/// 上游 `_SELECT_LEASE`。
pub fn read_lease(conn: &Connection, room_id: &str) -> DriverResult<Option<DriverLease>> {
    let mut stmt = conn.prepare("SELECT room_id, gateway_id, authority_epoch, process_generation, lease_generation, expires_at, acquired_at, updated_at, released_at FROM hosted_room_driver_leases WHERE room_id=?1")?;
    Ok(stmt.query_row([room_id], read_lease_row).optional()?)
}

/// 上游 `_SELECT_TASK`。
pub fn read_task(conn: &Connection, room_id: &str, task_id: &str) -> DriverResult<Option<DriverTask>> {
    let sql = format!("SELECT {TASK_COLUMNS_SELECT} FROM hosted_room_driver_tasks WHERE room_id=?1 AND task_id=?2");
    let mut stmt = conn.prepare(&sql)?;
    Ok(stmt.query_row([room_id, task_id], read_task_row).optional()?)
}

/// 上游 `_TASK_ORDER`：房间内的任务按 (source_event_seq, created_at, task_id) 排。
pub fn list_tasks(conn: &Connection, room_id: &str, limit: i64) -> DriverResult<Vec<DriverTask>> {
    if !(1..=MAX_TASK_PRUNE_BATCH).contains(&limit) {
        return fail(ERR_VALIDATION, "limit is out of range");
    }
    let sql = format!(
        "SELECT {TASK_COLUMNS_SELECT} FROM hosted_room_driver_tasks WHERE room_id=?1 {TASK_ORDER} LIMIT ?2"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([room_id, &limit.to_string()], read_task_row);
    let rows = rows?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// 按状态列任务（上游 room status 的「逐条展示」那批）。
pub fn list_shown_tasks(conn: &Connection, room_id: &str, limit: i64) -> DriverResult<Vec<DriverTask>> {
    let sql = format!(
        "SELECT {TASK_COLUMNS_SELECT} FROM hosted_room_driver_tasks
         WHERE room_id=?1 AND status IN ('queued','running','stopping','indeterminate','deferred')
         {TASK_ORDER} LIMIT ?2"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([room_id, &limit.to_string()], read_task_row)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// 房间是否可用于驱动（未解散）。
fn ensure_room_available(conn: &Connection, room_id: &str) -> DriverResult<()> {
    let exists: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM hosted_rooms WHERE room_id=?1 AND disbanded_at IS NULL",
            [room_id],
            |row| row.get(0),
        )
        .optional()?;
    if exists.is_none() {
        return fail(ERR_ROOM_UNAVAILABLE, "hosted room is unavailable");
    }
    Ok(())
}

// ── 租约 ────────────────────────────────────────────────────────────────────

/// 租约获取/续期的输入（上游 `acquire_lease` 的参数）。
#[derive(Debug, Clone)]
pub struct LeaseRequest<'a> {
    pub room_id: &'a str,
    pub gateway_id: &'a str,
    pub authority_epoch: i64,
    pub process_generation: &'a str,
    pub ttl_seconds: f64,
    pub now: f64,
}

/// 上游租约语义：拿到或续期房间的 driver 租约。
///
/// 规则（与上游一致）：
/// - 无租约 → 新建，`lease_generation = 1`
/// - 已有且 `expires_at > now` 且 **不是自己的 process_generation** → `LeaseHeldError`
/// - 已有且未过期且是自己的 process_generation → 续期（`lease_generation += 1`）
/// - 已过期 → 接管，`lease_generation += 1`
/// - `released_at` 非空视为已释放，可接管
pub fn acquire_lease(conn: &mut Connection, req: &LeaseRequest<'_>) -> DriverResult<DriverLease> {
    if !(req.ttl_seconds.is_finite() && req.ttl_seconds > 0.0) {
        return fail(ERR_VALIDATION, "ttl must be a positive finite number");
    }
    if !req.now.is_finite() {
        return fail(ERR_VALIDATION, "clock must be finite");
    }
    if req.authority_epoch < 1 {
        return fail(ERR_VALIDATION, "authority_epoch must be a positive integer");
    }
    common::identifier(req.gateway_id, "gateway_id", MAX_IDENTIFIER_CHARS, true, None)
        .map_err(|e| DriverStateError::new(ERR_VALIDATION, e.0))?;
    common::identifier(req.process_generation, "process_generation", MAX_IDENTIFIER_CHARS, true, None)
        .map_err(|e| DriverStateError::new(ERR_VALIDATION, e.0))?;

    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    ensure_room_available(&tx, req.room_id)?;

    let expires_at = req.now + req.ttl_seconds;
    let existing = read_lease(&tx, req.room_id)?;

    let lease = match existing {
        None => {
            tx.execute(
                "INSERT INTO hosted_room_driver_leases (room_id, gateway_id, authority_epoch, process_generation,
                    lease_generation, expires_at, acquired_at, updated_at, released_at)
                 VALUES (?1, ?2, ?3, ?4, 1, ?5, ?6, ?6, NULL)",
                rusqlite::params![
                    req.room_id,
                    req.gateway_id,
                    req.authority_epoch,
                    req.process_generation,
                    expires_at,
                    req.now
                ],
            )?;
            DriverLease {
                room_id: req.room_id.to_owned(),
                gateway_id: req.gateway_id.to_owned(),
                authority_epoch: req.authority_epoch,
                process_generation: req.process_generation.to_owned(),
                lease_generation: 1,
                expires_at,
                acquired_at: req.now,
                updated_at: req.now,
                released_at: None,
            }
        }
        Some(current) => {
            let live = current.released_at.is_none() && current.expires_at > req.now;
            if live && current.process_generation != req.process_generation {
                // 另一个未过期的进程代持有租约
                return fail(ERR_LEASE_HELD, "another unexpired driver generation owns the room");
            }
            if live && current.gateway_id != req.gateway_id {
                return fail(ERR_LEASE_HELD, "another gateway owns the room lease");
            }
            if !live && current.authority_epoch > req.authority_epoch {
                // 过期但 authority 已推进：不接受落后 authority 的接管
                return fail(ERR_STALE_LEASE, "lease authority epoch is stale");
            }

            let next_generation = current.lease_generation + 1;
            // fenced：只有租约还是我读到的那一代才更新
            let affected = tx.execute(
                "UPDATE hosted_room_driver_leases
                 SET gateway_id=?1, authority_epoch=?2, process_generation=?3, lease_generation=?4,
                     expires_at=?5, updated_at=?6, released_at=NULL
                 WHERE room_id=?7 AND lease_generation=?8",
                rusqlite::params![
                    req.gateway_id,
                    req.authority_epoch,
                    req.process_generation,
                    next_generation,
                    expires_at,
                    req.now,
                    req.room_id,
                    current.lease_generation
                ],
            )?;
            if affected != 1 {
                return fail(ERR_STALE_LEASE, "lease generation changed during renewal");
            }
            DriverLease {
                room_id: req.room_id.to_owned(),
                gateway_id: req.gateway_id.to_owned(),
                authority_epoch: req.authority_epoch,
                process_generation: req.process_generation.to_owned(),
                lease_generation: next_generation,
                expires_at,
                acquired_at: current.acquired_at,
                updated_at: req.now,
                released_at: None,
            }
        }
    };

    tx.commit()?;
    Ok(lease)
}

/// 释放租约（fenced：代际不符 = StaleLeaseError）。
pub fn release_lease(conn: &mut Connection, room_id: &str, process_generation: &str, lease_generation: i64, now: f64) -> DriverResult<()> {
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let affected = tx.execute(
        "UPDATE hosted_room_driver_leases SET released_at=?1, updated_at=?1
         WHERE room_id=?2 AND process_generation=?3 AND lease_generation=?4",
        rusqlite::params![now, room_id, process_generation, lease_generation],
    )?;
    if affected != 1 {
        return fail(ERR_STALE_LEASE, "lease generation can no longer mutate room state");
    }
    tx.commit()?;
    Ok(())
}

// ── 任务状态迁移（fenced）───────────────────────────────────────────────────

/// 上游 `_GENERATION_TRANSITIONS` 里的一条：`(from_status, set_clause, stale_message)`。
pub struct GenerationTransition {
    pub from_status: &'static str,
    pub set_clause: &'static str,
    pub stale_message: &'static str,
}

/// 上游 `_GENERATION_TRANSITIONS` 表（7 条）。
///
/// 这张表是整个状态机的核心：每条迁移只允许从指定状态出发，且必须匹配
/// `execution_generation` + `cancel_generation` 双 fence。
pub const GENERATION_TRANSITIONS: &[(&str, GenerationTransition)] = &[
    (
        "resolve",
        GenerationTransition {
            from_status: "indeterminate",
            set_clause: "status=?, settlement_id=?, settlement_status=?, result_json=?, terminal_at=?, updated_at=?",
            stale_message: "indeterminate task generation changed",
        },
    ),
    (
        "resolve_cancel",
        GenerationTransition {
            from_status: "indeterminate",
            set_clause: "status='cancelled', cancel_generation=?, cancel_id=?, terminal_at=?, updated_at=?",
            stale_message: "indeterminate cancellation proof is stale",
        },
    ),
    (
        "requeue",
        GenerationTransition {
            from_status: "indeterminate",
            set_clause: "status='queued', run_gateway_id=NULL, run_process_generation=NULL, run_lease_generation=NULL, started_at=NULL, indeterminate_at=NULL, updated_at=?",
            stale_message: "indeterminate task generation changed",
        },
    ),
    (
        "defer",
        GenerationTransition {
            from_status: "indeterminate",
            set_clause: "status='deferred', result_json=?, terminal_at=?, updated_at=?",
            stale_message: "indeterminate task generation changed",
        },
    ),
    (
        "defer_stopping",
        GenerationTransition {
            from_status: "stopping",
            set_clause: "status='deferred', result_json=?, terminal_at=?, updated_at=?",
            stale_message: "stopping task generation changed",
        },
    ),
    (
        "reopen_deferred",
        GenerationTransition {
            from_status: "deferred",
            set_clause: "status='indeterminate', result_json=NULL, terminal_at=NULL, started_at=?, indeterminate_at=?, updated_at=?",
            stale_message: "deferred task generation changed",
        },
    ),
    (
        "requeue_deferred",
        GenerationTransition {
            from_status: "deferred",
            set_clause: "status='queued', run_gateway_id=NULL, run_process_generation=NULL, run_lease_generation=NULL, result_json=NULL, started_at=NULL, terminal_at=NULL, indeterminate_at=NULL, updated_at=?",
            stale_message: "deferred task generation changed",
        },
    ),
];

/// 查一条迁移定义。
pub fn generation_transition(name: &str) -> Option<&'static GenerationTransition> {
    GENERATION_TRANSITIONS
        .iter()
        .find(|(key, _)| *key == name)
        .map(|(_, t)| t)
}

/// 上游 `_generation_update()`：拼出「带双代 fence 的状态迁移 UPDATE」。
///
/// 形状：`UPDATE ... SET <set> WHERE room_id=? AND task_id=? AND status='<from>' AND
/// execution_generation=? AND cancel_generation=?`
pub fn generation_update_sql(transition: &GenerationTransition) -> String {
    format!(
        "UPDATE hosted_room_driver_tasks SET {} WHERE room_id=? AND task_id=? AND status='{}' AND {}",
        transition.set_clause, transition.from_status, GENERATION_FENCE
    )
}

/// 计算 payload 的 canonical JSON sha256（上游 `payload_digest`）。
pub fn payload_digest(payload: &Value) -> String {
    let canonical = common::compact_json(payload, true);
    sha256_hex(canonical.as_bytes())
}

/// 对**已编码的 JSON 字符串**求 sha256 hex（work_records 的 encode+digest 复用）。
pub fn payload_digest_str(encoded: &str) -> String {
    sha256_hex(encoded.as_bytes())
}

/// sha256 hex（复用 execution_policy 里的实现口径）。
fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}

/// 上游 `_task_payload()` 的校验部分：必填齐全、可选之外拒绝、prompt 字节上限。
pub fn validate_task_payload(payload: &Value) -> DriverResult<(String, String)> {
    let Value::Object(map) = payload else {
        return fail(ERR_VALIDATION, "task payload must be an object");
    };
    // 必填
    let mut missing: Vec<&str> = TASK_PAYLOAD_REQUIRED_FIELDS
        .iter()
        .copied()
        .filter(|key| !map.contains_key(*key))
        .collect();
    if !missing.is_empty() {
        missing.sort_unstable();
        return fail(
            ERR_VALIDATION,
            format!("task payload is missing fields: {}", missing.join(", ")),
        );
    }
    // 未知
    let mut unknown: Vec<&str> = map
        .keys()
        .map(String::as_str)
        .filter(|key| {
            !TASK_PAYLOAD_REQUIRED_FIELDS.contains(key) && !TASK_PAYLOAD_OPTIONAL_FIELDS.contains(key)
        })
        .collect();
    if !unknown.is_empty() {
        unknown.sort_unstable();
        return fail(
            ERR_VALIDATION,
            format!("task payload has unknown fields: {}", unknown.join(", ")),
        );
    }
    // prompt 字节上限
    let Some(prompt) = map.get("prompt").and_then(Value::as_str) else {
        return fail(ERR_VALIDATION, "task payload prompt must be a string");
    };
    if prompt.len() > MAX_PROMPT_BYTES {
        return fail(ERR_VALIDATION, "task payload prompt is too large");
    }
    // source_event_seq 必须 ≥ 1
    let Some(seq) = common::json_i64(&map["source_event_seq"]) else {
        return fail(ERR_VALIDATION, "task payload source_event_seq must be a positive integer");
    };
    if seq < 1 {
        return fail(ERR_VALIDATION, "task payload source_event_seq must be a positive integer");
    }

    let json = common::compact_json(payload, true);
    let digest = sha256_hex(json.as_bytes());
    Ok((json, digest))
}

/// 插入一条新任务（上游 `create_task` 的核心写入）。
///
/// 同 `(room_id, thread_id, turn_id)` 已存在 → `TaskConflictError`（UNIQUE 约束）。
#[allow(clippy::too_many_arguments)]
pub fn create_task(
    conn: &mut Connection,
    room_id: &str,
    task_id: &str,
    thread_id: &str,
    turn_id: &str,
    source_event_seq: i64,
    payload: &Value,
    now: f64,
) -> DriverResult<DriverTask> {
    if source_event_seq < 1 {
        return fail(ERR_VALIDATION, "source_event_seq must be a positive integer");
    }
    let (payload_json, payload_digest) = validate_task_payload(payload)?;

    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    ensure_room_available(&tx, room_id)?;

    let inserted = tx.execute(
        "INSERT INTO hosted_room_driver_tasks (
            room_id, task_id, thread_id, turn_id, source_event_seq, payload_json, payload_digest, status,
            execution_generation, cancel_generation, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'queued', 0, 0, ?8, ?8)",
        rusqlite::params![
            room_id,
            task_id,
            thread_id,
            turn_id,
            source_event_seq,
            payload_json,
            payload_digest,
            now
        ],
    );

    match inserted {
        Ok(_) => {}
        Err(rusqlite::Error::SqliteFailure(err, _))
            if err.code == rusqlite::ErrorCode::ConstraintViolation =>
        {
            return fail(ERR_TASK_CONFLICT, "task idempotency key was reused for different task state");
        }
        Err(e) => return Err(e.into()),
    }

    let task = read_task(&tx, room_id, task_id)?
        .ok_or_else(|| DriverStateError::new(ERR_VALIDATION, "created task could not be reloaded"))?;
    tx.commit()?;
    Ok(task)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn seeded() -> Connection {
        let mut conn = super::super::store::open_in_memory().unwrap();
        super::super::store::create_room(
            &mut conn,
            &json!("room-1"),
            &json!("Room"),
            &json!([]),
            &json!("gw-1"),
            Some(1.0),
        )
        .unwrap();
        initialize_driver_schema(&conn).unwrap();
        conn
    }

    // ── schema ─────────────────────────────────────────────────────────────

    #[test]
    fn creates_both_driver_tables() {
        let conn = seeded();
        assert!(common::table_exists(&conn, "hosted_room_driver_leases"));
        assert!(common::table_exists(&conn, "hosted_room_driver_tasks"));
        assert_eq!(common::table_columns(&conn, "hosted_room_driver_tasks").len(), TASK_COLUMN_ORDER.len());
        assert_eq!(common::table_columns(&conn, "hosted_room_driver_leases").len(), LEASE_COLUMNS.len());
    }

    #[test]
    fn validates_schema_and_foreign_keys() {
        let conn = seeded();
        validate_driver_schema(&conn).unwrap();
    }

    #[test]
    fn rejects_incompatible_schema() {
        let conn = super::super::store::open_in_memory().unwrap();
        conn.execute(
            "CREATE TABLE hosted_room_driver_leases (room_id TEXT PRIMARY KEY)",
            [],
        )
        .unwrap();
        conn.execute(
            "CREATE TABLE hosted_room_driver_tasks (room_id TEXT PRIMARY KEY)",
            [],
        )
        .unwrap();
        let err = validate_driver_schema(&conn).unwrap_err();
        assert!(err.message.contains("unsupported unpublished"));
    }

    // ── 状态机表 ───────────────────────────────────────────────────────────

    #[test]
    fn generation_transitions_cover_all_seven() {
        assert_eq!(GENERATION_TRANSITIONS.len(), 7);
        for name in [
            "resolve",
            "resolve_cancel",
            "requeue",
            "defer",
            "defer_stopping",
            "reopen_deferred",
            "requeue_deferred",
        ] {
            assert!(generation_transition(name).is_some(), "missing {name}");
        }
        assert!(generation_transition("nope").is_none());
    }

    #[test]
    fn generation_transitions_start_from_expected_status() {
        assert_eq!(generation_transition("resolve").unwrap().from_status, "indeterminate");
        assert_eq!(generation_transition("defer_stopping").unwrap().from_status, "stopping");
        assert_eq!(
            generation_transition("reopen_deferred").unwrap().from_status,
            "deferred"
        );
    }

    #[test]
    fn generation_update_sql_carries_fences() {
        let sql = generation_update_sql(generation_transition("resolve").unwrap());
        assert!(sql.contains("status='indeterminate'"));
        assert!(sql.contains("execution_generation=? AND cancel_generation=?"));
        assert!(sql.starts_with("UPDATE hosted_room_driver_tasks SET "));
    }

    // ── 任务 payload 校验 ──────────────────────────────────────────────────

    #[test]
    fn payload_accepts_required_fields() {
        let payload = json!({"target_profile": "alice", "prompt": "hi", "source_event_seq": 1});
        let (json_out, digest) = validate_task_payload(&payload).unwrap();
        assert!(json_out.contains("\"prompt\":\"hi\""));
        assert_eq!(digest.len(), 64);
    }

    #[test]
    fn payload_accepts_optional_fields() {
        let payload = json!({
            "target_profile": "alice", "prompt": "hi", "source_event_seq": 1,
            "target_member_id": "m1", "lead_routing": true
        });
        assert!(validate_task_payload(&payload).is_ok());
    }

    #[test]
    fn payload_rejects_missing_and_unknown_fields() {
        let missing = json!({"prompt": "hi"});
        let err = validate_task_payload(&missing).unwrap_err();
        assert_eq!(
            err.message,
            "task payload is missing fields: source_event_seq, target_profile"
        );

        let unknown = json!({
            "target_profile": "a", "prompt": "hi", "source_event_seq": 1, "zzz": 1, "aaa": 2
        });
        let err = validate_task_payload(&unknown).unwrap_err();
        assert_eq!(err.message, "task payload has unknown fields: aaa, zzz");
    }

    #[test]
    fn payload_rejects_bad_prompt_and_seq() {
        let big = "x".repeat(MAX_PROMPT_BYTES + 1);
        let err = validate_task_payload(&json!({
            "target_profile": "a", "prompt": big, "source_event_seq": 1
        }))
        .unwrap_err();
        assert_eq!(err.message, "task payload prompt is too large");

        let err = validate_task_payload(&json!({
            "target_profile": "a", "prompt": "hi", "source_event_seq": 0
        }))
        .unwrap_err();
        assert_eq!(err.message, "task payload source_event_seq must be a positive integer");
    }

    #[test]
    fn payload_digest_matches_canonical_json_sha256() {
        let payload = json!({"b": 2, "a": 1});
        // canonical: {"a":1,"b":2}
        let expected = sha256_hex(br#"{"a":1,"b":2}"#);
        assert_eq!(payload_digest(&payload), expected);
    }

    // ── 租约 ───────────────────────────────────────────────────────────────

    fn lease_req<'a>(pg: &'a str, now: f64) -> LeaseRequest<'a> {
        LeaseRequest {
            room_id: "room-1",
            gateway_id: "gw-1",
            authority_epoch: 1,
            process_generation: pg,
            ttl_seconds: 30.0,
            now,
        }
    }

    #[test]
    fn first_acquire_creates_generation_one() {
        let mut conn = seeded();
        let lease = acquire_lease(&mut conn, &lease_req("proc-a", 100.0)).unwrap();
        assert_eq!(lease.lease_generation, 1);
        assert_eq!(lease.process_generation, "proc-a");
        assert_eq!(lease.expires_at, 130.0);
        assert!(lease.released_at.is_none());
    }

    #[test]
    fn renewing_own_live_lease_bumps_generation() {
        let mut conn = seeded();
        acquire_lease(&mut conn, &lease_req("proc-a", 100.0)).unwrap();
        let renewed = acquire_lease(&mut conn, &lease_req("proc-a", 110.0)).unwrap();
        assert_eq!(renewed.lease_generation, 2);
        assert_eq!(renewed.expires_at, 140.0);
    }

    #[test]
    fn rejects_other_process_while_live() {
        let mut conn = seeded();
        acquire_lease(&mut conn, &lease_req("proc-a", 100.0)).unwrap();
        let err = acquire_lease(&mut conn, &lease_req("proc-b", 110.0)).unwrap_err();
        assert_eq!(err.code, ERR_LEASE_HELD);
    }

    #[test]
    fn takes_over_expired_lease() {
        let mut conn = seeded();
        acquire_lease(&mut conn, &lease_req("proc-a", 100.0)).unwrap();
        // 130 已过期（expires_at = 130，需 > now 才算活）
        let taken = acquire_lease(&mut conn, &lease_req("proc-b", 131.0)).unwrap();
        assert_eq!(taken.lease_generation, 2);
        assert_eq!(taken.process_generation, "proc-b");
    }

    #[test]
    fn released_lease_can_be_taken_immediately() {
        let mut conn = seeded();
        let lease = acquire_lease(&mut conn, &lease_req("proc-a", 100.0)).unwrap();
        release_lease(&mut conn, "room-1", "proc-a", lease.lease_generation, 105.0).unwrap();
        let taken = acquire_lease(&mut conn, &lease_req("proc-b", 106.0)).unwrap();
        assert_eq!(taken.process_generation, "proc-b");
        assert_eq!(taken.lease_generation, 2);
    }

    #[test]
    fn release_with_stale_generation_fails() {
        let mut conn = seeded();
        acquire_lease(&mut conn, &lease_req("proc-a", 100.0)).unwrap();
        let err = release_lease(&mut conn, "room-1", "proc-a", 99, 105.0).unwrap_err();
        assert_eq!(err.code, ERR_STALE_LEASE);
    }

    #[test]
    fn acquire_requires_positive_ttl() {
        let mut conn = seeded();
        for bad in [0.0, -1.0, f64::INFINITY, f64::NAN] {
            let mut req = lease_req("proc-a", 100.0);
            req.ttl_seconds = bad;
            assert_eq!(acquire_lease(&mut conn, &req).unwrap_err().code, ERR_VALIDATION);
        }
    }

    #[test]
    fn acquire_requires_available_room() {
        let mut conn = seeded();
        let mut req = lease_req("proc-a", 100.0);
        req.room_id = "room-missing";
        assert_eq!(acquire_lease(&mut conn, &req).unwrap_err().code, ERR_ROOM_UNAVAILABLE);
    }

    // ── 任务创建 ───────────────────────────────────────────────────────────

    fn payload() -> Value {
        json!({"target_profile": "alice", "prompt": "do it", "source_event_seq": 1})
    }

    #[test]
    fn creates_queued_task() {
        let mut conn = seeded();
        let task = create_task(&mut conn, "room-1", "task-1", "thread-1", "turn-1", 1, &payload(), 10.0).unwrap();
        assert_eq!(task.status, "queued");
        assert_eq!(task.execution_generation, 0);
        assert_eq!(task.cancel_generation, 0);
        assert!(task.started_at.is_none());
        assert!(!task.is_terminal());
        assert!(task.is_shown());
    }

    #[test]
    fn rejects_duplicate_thread_turn() {
        let mut conn = seeded();
        create_task(&mut conn, "room-1", "task-1", "thread-1", "turn-1", 1, &payload(), 10.0).unwrap();
        // 同 (room, thread, turn) 但不同 task_id → UNIQUE 冲突
        let err = create_task(&mut conn, "room-1", "task-2", "thread-1", "turn-1", 1, &payload(), 11.0).unwrap_err();
        assert_eq!(err.code, ERR_TASK_CONFLICT);
    }

    #[test]
    fn rejects_task_for_missing_room() {
        let mut conn = seeded();
        let err = create_task(&mut conn, "room-x", "task-1", "thread-1", "turn-1", 1, &payload(), 10.0)
            .unwrap_err();
        assert_eq!(err.code, ERR_ROOM_UNAVAILABLE);
    }

    #[test]
    fn rejects_task_with_bad_payload() {
        let mut conn = seeded();
        let err = create_task(
            &mut conn,
            "room-1",
            "task-1",
            "thread-1",
            "turn-1",
            1,
            &json!({"prompt": "x"}),
            10.0,
        )
        .unwrap_err();
        assert_eq!(err.code, ERR_VALIDATION);
    }

    #[test]
    fn lists_tasks_in_source_order() {
        let mut conn = seeded();
        for (id, seq) in [("t3", 3), ("t1", 1), ("t2", 2)] {
            create_task(
                &mut conn,
                "room-1",
                id,
                &format!("thread-{id}"),
                &format!("turn-{id}"),
                seq,
                &json!({"target_profile": "a", "prompt": "p", "source_event_seq": seq}),
                10.0,
            )
            .unwrap();
        }
        let tasks = list_tasks(&conn, "room-1", 10).unwrap();
        assert_eq!(
            tasks.iter().map(|t| t.task_id.as_str()).collect::<Vec<_>>(),
            vec!["t1", "t2", "t3"]
        );
    }

    #[test]
    fn shown_tasks_exclude_terminal() {
        let mut conn = seeded();
        create_task(&mut conn, "room-1", "task-1", "thread-1", "turn-1", 1, &payload(), 10.0).unwrap();
        // 手工标成 settled，模拟终态
        conn.execute(
            "UPDATE hosted_room_driver_tasks SET status='settled' WHERE task_id='task-1'",
            [],
        )
        .unwrap();
        assert!(list_shown_tasks(&conn, "room-1", 10).unwrap().is_empty());
    }

    #[test]
    fn read_task_round_trips() {
        let mut conn = seeded();
        create_task(&mut conn, "room-1", "task-1", "thread-1", "turn-1", 1, &payload(), 10.0).unwrap();
        let task = read_task(&conn, "room-1", "task-1").unwrap().unwrap();
        assert_eq!(task.task_id, "task-1");
        assert_eq!(task.payload_digest.len(), 64);
        assert!(read_task(&conn, "room-1", "nope").unwrap().is_none());
    }
}
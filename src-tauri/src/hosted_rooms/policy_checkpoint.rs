//! 房间策略投影（hermes `gateway/hosted_room_policy_checkpoint.py`）。
//!
//! 上游自述：
//! > Durable bounded policy projection for hosted Group Chat preparation.
//! > The append-only room log remains the **user-visible source of truth**.
//! > This module materializes only the state needed to choose and reconstruct the
//! > next active discussion, so a busy room does not replay its complete history
//! > every poll.
//!
//! ## 定位
//!
//! 它是**纯性能优化层**：把「算出下一个活跃讨论」所需的中间状态物化到 9 张表里，
//! 避免每次轮询重放整个房间历史。日志仍是唯一真相——投影丢了可以重建。
//!
//! ## 9 张表
//!
//! | 表 | 作用 |
//! |---|---|
//! | `policy_capacity` | 单行，记 `max_active_events` |
//! | `policy_cursors` | 每房间的 `through_seq` / `stopped_through_seq` |
//! | `policy_threads` | 每 thread 的最新用户 seq + 是否已完成 |
//! | `policy_events` | 活跃讨论事件（受 `max_active_events` 约束） |
//! | `policy_watermarks` | 每 (thread, member) 的 `seen_through_seq` |
//! | `policy_publications` | 已发布的发布记录 |
//! | `policy_transcript` | transcript **只存引用**（seq），不复制 payload |
//! | `policy_transcript_state` | transcript schema 版本 |
//! | （+ 2 个索引） | 待处理扫描、活跃事件扫描 |
//!
//! 上游注释特别说明 transcript 的设计：「stores only references into the already
//! bounded room log, so prompt payloads are never duplicated outside room byte
//! limits」——**只存引用，不复制**，否则提示词会绕过房间字节上限。
//!
//! ## 移植边界
//!
//! ✅ 本文件：全部 9 张表 DDL + 索引、常量、`PolicySnapshot` 形状、
//!   `initialize`、`require_room`、游标读写。
//! ⏳ 未移植（依赖 discussion 的事件类型与完整 planner）：
//!   `HostedRoomPolicyCheckpoint::advance` 的增量归约主体、`_settled_source_users`、
//!   transcript 重建。它们要靠 P2 的 discussion 事件类型接起来。

use rusqlite::{Connection, OptionalExtension};
use serde_json::Value;

use super::store::{HostedRoomError, RoomResult};

// ── 常量（上游逐字）────────────────────────────────────────────────────────

pub const MAX_ACTIVE_POLICY_EVENTS: i64 = 64;
/// `turn.deferred` 回执来自用户显式重试，不占回复预算，所以单独设上限。
pub const MAX_ACTIVE_RETRY_RECEIPTS: i64 = 64;
pub const MAX_THREAD_TRANSCRIPT_EVENTS: i64 = 24;
/// transcript schema 版本（5: 重建旧 settle 在更新消息下关闭的 thread）。
pub const TRANSCRIPT_SCHEMA_VERSION: i64 = 5;
pub const MAX_TRANSCRIPT_POLICY_EVENTS: i64 = MAX_THREAD_TRANSCRIPT_EVENTS * (MAX_ACTIVE_POLICY_EVENTS + 2);

/// 终态事件（上游 `_TERMINAL_KINDS`）。
pub const TERMINAL_KINDS: &[&str] = &["turn.settled", "turn.failed", "turn.cancelled", "turn.deferred"];

// ── schema（9 张表 + 2 索引，逐字对照）──────────────────────────────────────

const SCHEMA_DDL: &[&str] = &[
    "CREATE TABLE IF NOT EXISTS hosted_room_policy_capacity (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1), max_active_events INTEGER NOT NULL)",
    "CREATE TABLE IF NOT EXISTS hosted_room_policy_cursors (
        room_id TEXT PRIMARY KEY, through_seq INTEGER NOT NULL DEFAULT 0,
        stopped_through_seq INTEGER NOT NULL DEFAULT 0, updated_at REAL NOT NULL DEFAULT 0)",
    "CREATE TABLE IF NOT EXISTS hosted_room_policy_threads (
        room_id TEXT NOT NULL, thread_id TEXT NOT NULL, discussion_event_id TEXT NOT NULL,
        latest_user_seq INTEGER NOT NULL, completed INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(room_id, thread_id))",
    "CREATE INDEX IF NOT EXISTS idx_hosted_room_policy_pending
        ON hosted_room_policy_threads(room_id, completed, latest_user_seq, thread_id)",
    "CREATE TABLE IF NOT EXISTS hosted_room_policy_events (
        room_id TEXT NOT NULL, thread_id TEXT NOT NULL, discussion_event_id TEXT NOT NULL,
        seq INTEGER NOT NULL, event_json TEXT NOT NULL, PRIMARY KEY(room_id, seq))",
    "CREATE INDEX IF NOT EXISTS idx_hosted_room_policy_events_active
        ON hosted_room_policy_events(room_id, discussion_event_id, seq)",
    "CREATE TABLE IF NOT EXISTS hosted_room_policy_watermarks (
        room_id TEXT NOT NULL, thread_id TEXT NOT NULL, member_id TEXT NOT NULL,
        seen_through_seq INTEGER NOT NULL, PRIMARY KEY(room_id, thread_id, member_id))",
    "CREATE TABLE IF NOT EXISTS hosted_room_policy_publications (
        room_id TEXT NOT NULL, task_id TEXT NOT NULL, kind TEXT NOT NULL,
        execution_generation INTEGER NOT NULL DEFAULT 0, seq INTEGER NOT NULL,
        PRIMARY KEY(room_id, task_id, kind, execution_generation))",
    // transcript 只存对已受限房间日志的**引用**，所以提示词绝不在房间字节上限之外被复制
    "CREATE TABLE IF NOT EXISTS hosted_room_policy_transcript (
        room_id TEXT NOT NULL, thread_id TEXT NOT NULL, seq INTEGER NOT NULL,
        kind TEXT NOT NULL, settled_seq INTEGER, PRIMARY KEY(room_id, thread_id, seq))",
    "CREATE TABLE IF NOT EXISTS hosted_room_policy_transcript_state (
        room_id TEXT PRIMARY KEY, schema_version INTEGER NOT NULL)",
    "CREATE INDEX IF NOT EXISTS idx_hosted_room_user_thread
       ON hosted_room_events(room_id, json_extract(payload_json, '$.thread_id'), seq)
       WHERE kind='message.user'",
];

/// 建全部投影表（幂等）。
pub fn initialize(conn: &Connection) -> RoomResult<()> {
    for ddl in SCHEMA_DDL {
        conn.execute(ddl, []).map_err(|e| HostedRoomError(e.to_string()))?;
    }
    Ok(())
}

// ── 快照形状 ────────────────────────────────────────────────────────────────

/// 上游 `PolicySnapshot`：在一个持久化游标处的**有界**活跃策略输入。
#[derive(Debug, Clone, PartialEq)]
pub struct PolicySnapshot {
    pub through_seq: i64,
    pub stopped_through_seq: i64,
    /// 活跃讨论事件（受 `max_active_events` 约束）。
    pub events: Vec<Value>,
    /// `(thread_id, member_id) → seen_through_seq`
    pub watermarks: std::collections::BTreeMap<(String, String), i64>,
}

/// 上游 `_require_room`：房间必须存在（含已解散）。
pub fn require_room(conn: &Connection, room_id: &str) -> RoomResult<()> {
    let exists: Option<i64> = conn
        .query_row("SELECT 1 FROM hosted_rooms WHERE room_id=?1", [room_id], |row| {
            row.get(0)
        })
        .optional()?;
    if exists.is_none() {
        return Err(HostedRoomError("hosted room not found".into()));
    }
    Ok(())
}

// ── 游标 ────────────────────────────────────────────────────────────────────

/// 房间的投影游标（上游 `hosted_room_policy_cursors`）。
#[derive(Debug, Clone, PartialEq)]
pub struct PolicyCursor {
    pub through_seq: i64,
    pub stopped_through_seq: i64,
    pub updated_at: f64,
}

/// 读游标；无记录时返回 `(0, 0, 0.0)`（上游 DEFAULT 语义）。
pub fn read_cursor(conn: &Connection, room_id: &str) -> RoomResult<PolicyCursor> {
    let row: Option<(i64, i64, f64)> = conn
        .query_row(
            "SELECT through_seq, stopped_through_seq, updated_at FROM hosted_room_policy_cursors WHERE room_id=?1",
            [room_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    Ok(match row {
        Some((through_seq, stopped_through_seq, updated_at)) => PolicyCursor {
            through_seq,
            stopped_through_seq,
            updated_at,
        },
        None => PolicyCursor {
            through_seq: 0,
            stopped_through_seq: 0,
            updated_at: 0.0,
        },
    })
}

/// 写游标（upsert）。
pub fn write_cursor(
    conn: &Connection,
    room_id: &str,
    through_seq: i64,
    stopped_through_seq: i64,
    now: f64,
) -> RoomResult<()> {
    conn.execute(
        "INSERT INTO hosted_room_policy_cursors (room_id, through_seq, stopped_through_seq, updated_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(room_id) DO UPDATE SET
             through_seq=excluded.through_seq,
             stopped_through_seq=excluded.stopped_through_seq,
             updated_at=excluded.updated_at",
        rusqlite::params![room_id, through_seq, stopped_through_seq, now],
    )?;
    Ok(())
}

/// 容量行：`max_active_events`（单行 singleton=1）。
pub fn ensure_capacity(conn: &Connection, max_active_events: i64) -> RoomResult<()> {
    if max_active_events < 1 {
        return Err(HostedRoomError(
            "max_active_events must be a positive integer".into(),
        ));
    }
    conn.execute(
        "INSERT INTO hosted_room_policy_capacity (singleton, max_active_events) VALUES (1, ?1)
         ON CONFLICT(singleton) DO UPDATE SET max_active_events=excluded.max_active_events",
        [max_active_events],
    )?;
    Ok(())
}

/// 读容量上限。
pub fn read_capacity(conn: &Connection) -> RoomResult<Option<i64>> {
    Ok(conn
        .query_row(
            "SELECT max_active_events FROM hosted_room_policy_capacity WHERE singleton=1",
            [],
            |row| row.get(0),
        )
        .optional()?)
}

/// 读某房间的活跃讨论事件（受上限约束，按 seq 升序）。
pub fn read_active_events(conn: &Connection, room_id: &str, discussion_event_id: &str, limit: i64) -> RoomResult<Vec<Value>> {
    let mut stmt = conn.prepare(
        "SELECT event_json FROM hosted_room_policy_events
         WHERE room_id=?1 AND discussion_event_id=?2 ORDER BY seq ASC LIMIT ?3",
    )?;
    let rows = stmt.query_map(rusqlite::params![room_id, discussion_event_id, limit], |row| {
        row.get::<_, String>(0)
    })?;
    let mut events = Vec::new();
    for raw in rows {
        let raw = raw?;
        let parsed: Value = serde_json::from_str(&raw)
            .map_err(|e| HostedRoomError(format!("invalid policy event json: {e}")))?;
        events.push(parsed);
    }
    Ok(events)
}

/// 读某房间的 watermarks（`(thread, member) → seen_through_seq`）。
pub fn read_watermarks(
    conn: &Connection,
    room_id: &str,
) -> RoomResult<std::collections::BTreeMap<(String, String), i64>> {
    let mut stmt = conn.prepare(
        "SELECT thread_id, member_id, seen_through_seq FROM hosted_room_policy_watermarks WHERE room_id=?1",
    )?;
    let rows = stmt.query_map([room_id], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, i64>(2)?,
        ))
    })?;
    let mut map = std::collections::BTreeMap::new();
    for row in rows {
        let (thread_id, member_id, seq) = row?;
        map.insert((thread_id, member_id), seq);
    }
    Ok(map)
}

/// 待处理的 thread（上游 `idx_hosted_room_policy_pending` 的消费面）。
///
/// 返回 `(thread_id, latest_user_seq)`，只取未完成的，按 latest_user_seq 升序。
pub fn pending_threads(conn: &Connection, room_id: &str, limit: i64) -> RoomResult<Vec<(String, i64)>> {
    let mut stmt = conn.prepare(
        "SELECT thread_id, latest_user_seq FROM hosted_room_policy_threads
         WHERE room_id=?1 AND completed=0
         ORDER BY latest_user_seq ASC, thread_id ASC LIMIT ?2",
    )?;
    let rows = stmt.query_map(rusqlite::params![room_id, limit], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// transcript 的 schema 版本（需要重建时返回 `None`）。
pub fn transcript_schema_version(conn: &Connection, room_id: &str) -> RoomResult<Option<i64>> {
    Ok(conn
        .query_row(
            "SELECT schema_version FROM hosted_room_policy_transcript_state WHERE room_id=?1",
            [room_id],
            |row| row.get(0),
        )
        .optional()?)
}

/// 写 transcript schema 版本。
pub fn write_transcript_schema_version(conn: &Connection, room_id: &str, version: i64) -> RoomResult<()> {
    conn.execute(
        "INSERT INTO hosted_room_policy_transcript_state (room_id, schema_version) VALUES (?1, ?2)
         ON CONFLICT(room_id) DO UPDATE SET schema_version=excluded.schema_version",
        rusqlite::params![room_id, version],
    )?;
    Ok(())
}

/// 读某 thread 的 transcript 引用（seq 列表，按 seq 升序）。
///
/// 上游 `_TRANSCRIPT_EVENTS_SQL` 的简化版：只取引用，不 join 房间事件。
pub fn transcript_seqs(conn: &Connection, room_id: &str, thread_id: &str, limit: i64) -> RoomResult<Vec<i64>> {
    let mut stmt = conn.prepare(
        "SELECT seq FROM hosted_room_policy_transcript
         WHERE room_id=?1 AND thread_id=?2 ORDER BY seq ASC LIMIT ?3",
    )?;
    let rows = stmt.query_map(rusqlite::params![room_id, thread_id, limit], |row| row.get::<_, i64>(0))?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
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
        initialize(&conn).unwrap();
        conn
    }

    #[test]
    fn creates_all_projection_tables() {
        let conn = seeded();
        for table in [
            "hosted_room_policy_capacity",
            "hosted_room_policy_cursors",
            "hosted_room_policy_threads",
            "hosted_room_policy_events",
            "hosted_room_policy_watermarks",
            "hosted_room_policy_publications",
            "hosted_room_policy_transcript",
            "hosted_room_policy_transcript_state",
        ] {
            assert!(
                super::super::common::table_exists(&conn, table),
                "missing {table}"
            );
        }
    }

    #[test]
    fn cursor_defaults_to_zero() {
        let conn = seeded();
        let cursor = read_cursor(&conn, "room-1").unwrap();
        assert_eq!(cursor.through_seq, 0);
        assert_eq!(cursor.stopped_through_seq, 0);
        assert_eq!(cursor.updated_at, 0.0);
    }

    #[test]
    fn cursor_round_trips_and_upserts() {
        let conn = seeded();
        write_cursor(&conn, "room-1", 10, 5, 100.0).unwrap();
        let cursor = read_cursor(&conn, "room-1").unwrap();
        assert_eq!(cursor.through_seq, 10);
        assert_eq!(cursor.stopped_through_seq, 5);

        // upsert 覆盖
        write_cursor(&conn, "room-1", 20, 8, 200.0).unwrap();
        let cursor = read_cursor(&conn, "room-1").unwrap();
        assert_eq!(cursor.through_seq, 20);
        assert_eq!(cursor.stopped_through_seq, 8);
        assert_eq!(cursor.updated_at, 200.0);
    }

    #[test]
    fn capacity_round_trips() {
        let conn = seeded();
        assert_eq!(read_capacity(&conn).unwrap(), None);
        ensure_capacity(&conn, 64).unwrap();
        assert_eq!(read_capacity(&conn).unwrap(), Some(64));
        // upsert
        ensure_capacity(&conn, 128).unwrap();
        assert_eq!(read_capacity(&conn).unwrap(), Some(128));
    }

    #[test]
    fn capacity_rejects_non_positive() {
        let conn = seeded();
        assert!(ensure_capacity(&conn, 0).is_err());
        assert!(ensure_capacity(&conn, -1).is_err());
    }

    #[test]
    fn require_room_checks_existence() {
        let conn = seeded();
        require_room(&conn, "room-1").unwrap();
        assert_eq!(
            require_room(&conn, "room-missing").unwrap_err().0,
            "hosted room not found"
        );
    }

    #[test]
    fn active_events_read_in_seq_order() {
        let conn = seeded();
        for (seq, kind) in [(3, "turn.started"), (1, "message.user"), (2, "message.member")] {
            conn.execute(
                "INSERT INTO hosted_room_policy_events (room_id, thread_id, discussion_event_id, seq, event_json)
                 VALUES ('room-1', 'th-1', 'd-1', ?1, ?2)",
                rusqlite::params![seq, json!({"kind": kind}).to_string()],
            )
            .unwrap();
        }
        let events = read_active_events(&conn, "room-1", "d-1", 10).unwrap();
        assert_eq!(events.len(), 3);
        // 按 seq 升序：message.user / message.member / turn.started
        assert_eq!(events[0]["kind"], "message.user");
        assert_eq!(events[2]["kind"], "turn.started");
    }

    #[test]
    fn active_events_respect_limit() {
        let conn = seeded();
        for seq in 1..=5 {
            conn.execute(
                "INSERT INTO hosted_room_policy_events (room_id, thread_id, discussion_event_id, seq, event_json)
                 VALUES ('room-1', 'th-1', 'd-1', ?1, '{}')",
                [seq],
            )
            .unwrap();
        }
        assert_eq!(read_active_events(&conn, "room-1", "d-1", 2).unwrap().len(), 2);
    }

    #[test]
    fn watermarks_round_trip() {
        let conn = seeded();
        conn.execute(
            "INSERT INTO hosted_room_policy_watermarks (room_id, thread_id, member_id, seen_through_seq)
             VALUES ('room-1', 'th-1', 'm-ada', 5), ('room-1', 'th-1', 'm-linus', 3)",
            [],
        )
        .unwrap();
        let map = read_watermarks(&conn, "room-1").unwrap();
        assert_eq!(
            map.get(&("th-1".to_owned(), "m-ada".to_owned())),
            Some(&5)
        );
        assert_eq!(
            map.get(&("th-1".to_owned(), "m-linus".to_owned())),
            Some(&3)
        );
    }

    #[test]
    fn pending_threads_excludes_completed() {
        let conn = seeded();
        conn.execute(
            "INSERT INTO hosted_room_policy_threads (room_id, thread_id, discussion_event_id, latest_user_seq, completed)
             VALUES ('room-1','th-a','d1',3,0), ('room-1','th-b','d2',1,1), ('room-1','th-c','d3',2,0)",
            [],
        )
        .unwrap();
        let pending = pending_threads(&conn, "room-1", 10).unwrap();
        // th-b 已完成被排除；按 latest_user_seq 升序
        assert_eq!(
            pending,
            vec![("th-c".to_owned(), 2), ("th-a".to_owned(), 3)]
        );
    }

    #[test]
    fn transcript_schema_version_round_trips() {
        let conn = seeded();
        assert_eq!(transcript_schema_version(&conn, "room-1").unwrap(), None);
        write_transcript_schema_version(&conn, "room-1", TRANSCRIPT_SCHEMA_VERSION).unwrap();
        assert_eq!(
            transcript_schema_version(&conn, "room-1").unwrap(),
            Some(TRANSCRIPT_SCHEMA_VERSION)
        );
    }

    #[test]
    fn transcript_seqs_are_ordered() {
        let conn = seeded();
        for seq in [5, 1, 3] {
            conn.execute(
                "INSERT INTO hosted_room_policy_transcript (room_id, thread_id, seq, kind)
                 VALUES ('room-1','th-1',?1,'message.user')",
                [seq],
            )
            .unwrap();
        }
        assert_eq!(transcript_seqs(&conn, "room-1", "th-1", 10).unwrap(), vec![1, 3, 5]);
    }

    #[test]
    fn constants_match_upstream() {
        assert_eq!(MAX_ACTIVE_POLICY_EVENTS, 64);
        assert_eq!(MAX_ACTIVE_RETRY_RECEIPTS, 64);
        assert_eq!(MAX_THREAD_TRANSCRIPT_EVENTS, 24);
        assert_eq!(TRANSCRIPT_SCHEMA_VERSION, 5);
        assert_eq!(TERMINAL_KINDS.len(), 4);
    }
}
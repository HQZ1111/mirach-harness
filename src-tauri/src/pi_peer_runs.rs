//! lender 侧 `/v1/runs` 台账（hermes `api_server_run_idempotency.py` 的移植，2026-11-19）。
//!
//! 上游 RunIdempotencyStore 是 API server 的持久层；宿主没有 API server，但跨网关
//! 房间的成员轮次需要同一套语义：
//!
//! - 一次成员尝试 = `(scope, Idempotency-Key)` 唯一行；**内容相同重放**返回原状态
//!   （网络丢响应后的重试不重复执行），**内容不同冲突**（409
//!   `idempotency_key_conflict`）；
//! - `find_or_close` = Discard 的真相：该键已有运行 → 返回它；没有 → 落一个
//!   `fingerprint="closed"` 的墓碑，之后任何同键 admission 都按冲突处理；
//! - 状态行带 `owner_pid`/`owner_started`：进程重启后孤儿行按「中断」收口。
//!
//! 表在独立的 `peer-runs.db`（与房间库 state.db 分开，同上游把运行台账独立成库的
//! 形状）；`initialize` 幂等。

use std::path::PathBuf;

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

use crate::pi_paths;

/// 与上游 `TERMINAL_STATUSES` 同义。
pub const TERMINAL_STATUSES: &[&str] = &["completed", "failed", "cancelled", "interrupted"];
/// 与上游 `RunIdempotencyStore.RETENTION_SECONDS` 同值（24h）。
pub const RETENTION_SECONDS: f64 = 24.0 * 60.0 * 60.0;
pub const ACKNOWLEDGED_RETENTION_SECONDS: f64 = 24.0 * 60.0 * 60.0;
/// 被 `find_or_close` 关掉的键：没有请求体能哈希成它，永远不会重放。
pub const CLOSED_FINGERPRINT: &str = "closed";

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS peer_runs (
    scope TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    run_id TEXT NOT NULL,
    status_json TEXT NOT NULL,
    owner_pid INTEGER NOT NULL DEFAULT 0,
    owner_started INTEGER NOT NULL DEFAULT 0,
    retention_until REAL NOT NULL DEFAULT 0,
    acknowledged_at REAL,
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL,
    PRIMARY KEY (scope, idempotency_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS peer_runs_run_id ON peer_runs(run_id);
CREATE TABLE IF NOT EXISTS peer_room_sessions (
    room_id TEXT NOT NULL,
    member_id TEXT NOT NULL,
    target_profile TEXT NOT NULL,
    session_id TEXT NOT NULL,
    path TEXT NOT NULL,
    updated_at REAL NOT NULL,
    PRIMARY KEY (room_id, member_id, target_profile)
);
"#;

pub fn is_terminal(status: &str) -> bool {
    TERMINAL_STATUSES.contains(&status)
}

pub fn db_path() -> Result<PathBuf, String> {
    Ok(pi_paths::agent_dir()?.join("peer-runs.db"))
}

pub fn open() -> Result<Connection, String> {
    let path = db_path()?;
    let conn = Connection::open(&path).map_err(|e| format!("peer-runs 打开失败 {}: {e}", path.display()))?;
    conn.busy_timeout(std::time::Duration::from_secs(10))
        .map_err(|e| e.to_string())?;
    conn.execute_batch(SCHEMA).map_err(|e| e.to_string())?;
    Ok(conn)
}

fn status_of(encoded: &str) -> Value {
    serde_json::from_str::<Value>(encoded).unwrap_or(Value::Null)
}

/// 上游 `RunIdempotencyStore.lookup`：`missing` / `reused` / `conflict`。
pub fn lookup(conn: &Connection, scope: &str, key: &str, fingerprint: &str) -> Result<(String, Option<Value>), String> {
    prune(conn, now())?;
    let row: Option<(String, String)> = conn
        .query_row(
            "SELECT fingerprint, status_json FROM peer_runs WHERE scope=? AND idempotency_key=?",
            params![scope, key],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(match row {
        None => ("missing".into(), None),
        Some((stored, status)) => {
            if stored == fingerprint {
                ("reused".into(), Some(status_of(&status)))
            } else {
                ("conflict".into(), None)
            }
        }
    })
}

/// 上游 `RunIdempotencyStore.reserve`：原子占键。返回 `created` / `reused` / `conflict`。
pub fn reserve(
    conn: &Connection,
    scope: &str,
    key: &str,
    fingerprint: &str,
    run_id: &str,
    status: &Value,
) -> Result<(String, Option<Value>), String> {
    prune(conn, now())?;
    let existing: Option<(String, String)> = conn
        .query_row(
            "SELECT fingerprint, status_json FROM peer_runs WHERE scope=? AND idempotency_key=?",
            params![scope, key],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some((stored, status_json)) = existing {
        return Ok(if stored == fingerprint {
            ("reused".into(), Some(status_of(&status_json)))
        } else {
            ("conflict".into(), None)
        });
    }
    let timestamp = now();
    conn.execute(
        "INSERT INTO peer_runs(scope, idempotency_key, fingerprint, run_id, status_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)",
        params![
            scope,
            key,
            fingerprint,
            run_id,
            serde_json::to_string(status).unwrap_or_else(|_| "null".into()),
            timestamp,
            timestamp
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(("created".into(), Some(status.clone())))
}

/// 上游 `RunIdempotencyStore.find_or_close`：有记录返回 `("found", status)`；
/// 没有则落一张 closed 墓碑并返回 `("closed", None)`。
pub fn find_or_close(conn: &Connection, scope: &str, key: &str) -> Result<(String, Option<Value>), String> {
    prune(conn, now())?;
    let existing: Option<(String, String)> = conn
        .query_row(
            "SELECT fingerprint, status_json FROM peer_runs WHERE scope=? AND idempotency_key=?",
            params![scope, key],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    match existing {
        Some((stored, status)) if stored == CLOSED_FINGERPRINT => Ok(("closed".into(), None)),
        Some((_, status)) => Ok(("found".into(), Some(status_of(&status)))),
        None => {
            let timestamp = now();
            conn.execute(
                "INSERT INTO peer_runs(scope, idempotency_key, fingerprint, run_id, status_json, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?)",
                params![
                    scope,
                    key,
                    CLOSED_FINGERPRINT,
                    format!("closed_{}", uuid::Uuid::new_v4().simple()),
                    serde_json::to_string(&json!({"status": "cancelled"})).unwrap_or_default(),
                    timestamp,
                    timestamp
                ],
            )
            .map_err(|e| e.to_string())?;
            Ok(("closed".into(), None))
        }
    }
}

/// 持久化运行状态（keyed by run_id）。
pub fn update_status(conn: &Connection, run_id: &str, status: &Value) -> Result<(), String> {
    conn.execute(
        "UPDATE peer_runs SET status_json=?, updated_at=? WHERE run_id=?",
        params![
            serde_json::to_string(status).unwrap_or_else(|_| "null".into()),
            now(),
            run_id
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 上游 `status_for_run`：按认证 scope 读回运行状态。
pub fn status_for_run(conn: &Connection, scope: &str, run_id: &str) -> Result<Option<Value>, String> {
    let row: Option<String> = conn
        .query_row(
            "SELECT status_json FROM peer_runs WHERE scope=? AND run_id=?",
            params![scope, run_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(row.map(|status| status_of(&status)))
}

/// 上游 `request_owns_run`：仅当调用方 scope 持有该运行才放行控制端点。
pub fn owns_run(conn: &Connection, scope: &str, run_id: &str) -> Result<bool, String> {
    conn.query_row(
        "SELECT 1 FROM peer_runs WHERE scope=? AND run_id=?",
        params![scope, run_id],
        |_| Ok(true),
    )
    .optional()
    .map_err(|e| e.to_string())
    .map(|row| row.is_some())
}

/// 上游 `_prune_stale_terminal_locked`：只清理「已终局且过了保留期」的行。
fn prune(conn: &Connection, timestamp: f64) -> Result<(), String> {
    let mut stmt = conn
        .prepare(
            "SELECT scope, idempotency_key, status_json FROM peer_runs
              WHERE acknowledged_at <= ?
                 OR (retention_until > 0 AND retention_until <= ?)
                 OR (retention_until <= 0 AND updated_at < ?)",
        )
        .map_err(|e| e.to_string())?;
    let stale: Vec<(String, String)> = stmt
        .query_map(
            params![
                timestamp - ACKNOWLEDGED_RETENTION_SECONDS,
                timestamp,
                timestamp - RETENTION_SECONDS
            ],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    drop(stmt);
    for (scope, key) in stale {
        conn.execute(
            "DELETE FROM peer_runs WHERE scope=? AND idempotency_key=?",
            params![scope, key],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 上游 `RunIdempotencyStore.extend_retention`：把活跃 grant 的恢复horizon落库。
pub fn extend_retention(conn: &Connection, scope: &str, run_id: &str, until: f64) -> Result<bool, String> {
    if until <= 0.0 {
        return Ok(false);
    }
    let changed = conn
        .execute(
            "UPDATE peer_runs SET retention_until = MAX(retention_until, ?) WHERE scope=? AND run_id=?",
            params![until, scope, run_id],
        )
        .map_err(|e| e.to_string())?;
    Ok(changed == 1)
}

pub fn acknowledge(conn: &Connection, run_id: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE peer_runs SET acknowledged_at=? WHERE run_id=?",
        params![now(), run_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

// ── 房间 ↔ 泳道会话映射 ─────────────────────────────────────────────────────

/// 找到某成员在某房间在本机的泳道会话（room_id, member_id, profile）。
pub fn room_session(conn: &Connection, room_id: &str, member_id: &str, target_profile: &str) -> Result<Option<(String, String)>, String> {
    conn.query_row(
        "SELECT session_id, path FROM peer_room_sessions
          WHERE room_id=? AND member_id=? AND target_profile=?",
        params![room_id, member_id, target_profile],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
    )
    .optional()
    .map_err(|e| e.to_string())
}

pub fn save_room_session(conn: &Connection, room_id: &str, member_id: &str, target_profile: &str, session_id: &str, path: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO peer_room_sessions(room_id, member_id, target_profile, session_id, path, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(room_id, member_id, target_profile) DO UPDATE SET
             session_id=excluded.session_id, path=excluded.path, updated_at=excluded.updated_at",
        params![room_id, member_id, target_profile, session_id, path, now()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn now() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0.0, |d| d.as_secs_f64())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn memory() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        conn
    }

    #[test]
    fn reserve_lookup_roundtrip() {
        let conn = memory();
        let status = json!({"object": "hermes.run", "run_id": "run_1", "status": "queued"});
        assert_eq!(
            reserve(&conn, "s1", "room:r:m:1", "fp1", "run_1", &status).unwrap().0,
            "created"
        );
        let (outcome, stored) = lookup(&conn, "s1", "room:r:m:1", "fp1").unwrap();
        assert_eq!(outcome, "reused");
        assert_eq!(stored.unwrap()["run_id"], "run_1");
        assert_eq!(lookup(&conn, "s1", "room:r:m:1", "fp2").unwrap().0, "conflict");
        assert_eq!(lookup(&conn, "s1", "room:other", "fp1").unwrap().0, "missing");
        assert!(owns_run(&conn, "s1", "run_1").unwrap());
        assert!(!owns_run(&conn, "s2", "run_1").unwrap());
    }

    #[test]
    fn find_or_close_plants_tombstone() {
        let conn = memory();
        let status = json!({"run_id": "run_1", "status": "running"});
        reserve(&conn, "s1", "room:r:m:1", "fp1", "run_1", &status).unwrap();
        let (outcome, record) = find_or_close(&conn, "s1", "room:r:m:1").unwrap();
        assert_eq!(outcome, "found");
        assert_eq!(record.unwrap()["status"], "running");

        let (outcome, record) = find_or_close(&conn, "s1", "room:r:m:2").unwrap();
        assert_eq!(outcome, "closed");
        assert!(record.is_none());
        // 墓碑之后同键 admission = 指纹冲突（closed 永不复用）
        let (outcome, _) = reserve(
            &conn,
            "s1",
            "room:r:m:2",
            "fp1",
            "run_2",
            &json!({"status": "queued"}),
        )
        .unwrap();
        assert_eq!(outcome, "conflict");
    }

    #[test]
    fn room_session_roundtrip() {
        let conn = memory();
        assert!(room_session(&conn, "r1", "m1", "default").unwrap().is_none());
        save_room_session(&conn, "r1", "m1", "default", "room_abc", "/tmp/a.jsonl").unwrap();
        let (sid, path) = room_session(&conn, "r1", "m1", "default").unwrap().unwrap();
        assert_eq!(sid, "room_abc");
        assert_eq!(path, "/tmp/a.jsonl");
    }
}
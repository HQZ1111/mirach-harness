//! 适配层：把各模块的纯逻辑接到 SQL 上（hermes `hosted_rooms.py` 的 SQL 封装部分）。
//!
//! ## 为什么单独一个文件
//!
//! `store` / `driver` / `driver_ops` / `replicas` 已经实现了 schema 与核心语义；本文件只做
//! **薄封装**：把上游那些「读一行、写一行、算个 id」的函数补齐，不改任何业务规则。
//!
//! ## 已补齐（上游 `hosted_rooms.py`）
//!
//! - `user_event_id` — 客户端重试键 → 服务端事件名空间
//! - `grant_digest` — grant 的 sha256（不存原文，只存摘要）
//! - `request_room_stop` — 幂等停止栅栏
//! - `claim_authority` — CAS 换 authority epoch
//! - `probe_hosted_room` / `probe_peer_room_reservation` — 非阻塞探测
//! - `room_has_peer_obligations` — 是否还有 peer 义务
//! - `reserve/peer_room_is_reserved`、`room_grant_is_revoked` — peer 保留与撤销
//! - `upsert/drop/list/remote_run_receipt` — 远端执行回执
//! - link/grant-revoke 的 CRUD
//!
//! ## 移植边界
//!
//! 全部是 SQL 直译。上游用 `_transaction(db_path)` 开连接；这里签名收 `&mut Connection`
//! （宿主侧连接由调用方持有，与 `store` 的其余 API 一致）。

use rusqlite::{Connection, OptionalExtension};
use serde_json::{json, Value};

use super::common;
use super::store::{self, HostedRoomError, RoomResult};

// ── 事件 id 派生 ────────────────────────────────────────────────────────────

/// 上游 `user_event_id()`：把客户端重试键映射进服务端 user 事件名空间。
///
/// `user:<sha256(client_event_id)>`——所以客户端可以安全地重试（同键同 id）。
pub fn user_event_id(client_event_id: &str) -> String {
    let digest = sha256_hex(client_event_id.as_bytes());
    format!("user:{digest}")
}

/// 上游 `grant_digest()`：grant 的 sha256（**只存摘要，不存原文**）。
pub fn grant_digest(grant: &str) -> String {
    sha256_hex(grant.as_bytes())
}

/// 上游 `room_stop` 的事件 id：`room-stop:<sha256(cancel_id)[..32]>`。
pub fn room_stop_event_id(cancel_id: &str) -> String {
    let digest = sha256_hex(cancel_id.as_bytes());
    format!("room-stop:{}", &digest[..32])
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(64);
    for byte in digest {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}

// ── 停止 / 换权 ─────────────────────────────────────────────────────────────

/// 上游 `request_room_stop()`：追加一条幂等的停止栅栏，压过更早的用户 turn。
pub fn request_room_stop(
    conn: &mut Connection,
    room_id: &Value,
    cancel_id: &Value,
    expected_gateway_id: &str,
    expected_epoch: i64,
    now: Option<f64>,
) -> RoomResult<store::RoomEvent> {
    let cancel = cancel_id.as_str().unwrap_or("");
    if cancel.is_empty() {
        return Err(HostedRoomError("invalid cancel_id".into()));
    }
    let event_id = room_stop_event_id(cancel);

    store::append_event(
        conn,
        room_id,
        &Value::String(event_id),
        &Value::String("room.stop_requested".into()),
        &json!({"kind": "gateway", "id": expected_gateway_id}),
        &json!({"cancel_id": cancel}),
        &Value::String(expected_gateway_id.to_owned()),
        Some(expected_epoch),
        now,
        None,
        false,
    )
}

/// 上游 `claim_authority()`：用 CAS 换 authority epoch 来 fence 一次已验证的转移。
///
/// **它不决定「何时接管安全」**——上游注释：「does not decide *when* takeover is safe
/// (a replicated driver calls it only after its lease/quorum policy established that
/// the previous owner can no longer commit)」。
///
/// 返回新 epoch。
pub fn claim_authority(
    conn: &mut Connection,
    room_id: &Value,
    expected_gateway_id: &str,
    expected_epoch: i64,
    new_gateway_id: &str,
    event_id: &Value,
    now: Option<f64>,
) -> RoomResult<i64> {
    let room_id_str = store::validate_room_id_pub(room_id)?;
    let now = common::clock(now);
    let new_epoch = expected_epoch + 1;

    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;

    // CAS：只有当前 authority 与 epoch 都匹配才换
    let affected = tx.execute(
        "UPDATE hosted_rooms SET authority_gateway_id=?1, authority_epoch=?2, updated_at=?3
         WHERE room_id=?4 AND authority_gateway_id=?5 AND authority_epoch=?6 AND disbanded_at IS NULL",
        rusqlite::params![
            new_gateway_id,
            new_epoch,
            now,
            room_id_str,
            expected_gateway_id,
            expected_epoch
        ],
    )?;
    if affected != 1 {
        return Err(HostedRoomError(
            "hosted room authority changed before the claim".into(),
        ));
    }

    // 记 authority.claimed 事件（系统 actor）
    let payload = json!({
        "previous_gateway_id": expected_gateway_id,
        "authority_gateway_id": new_gateway_id,
        "authority_epoch": new_epoch,
    });
    tx.execute(
        "INSERT INTO hosted_room_events (room_id, seq, event_id, kind, actor_json, authority_epoch,
            payload_json, created_at)
         SELECT ?1, next_seq, ?2, 'authority.claimed', ?3, ?4, ?5, ?6
         FROM hosted_rooms WHERE room_id=?1",
        rusqlite::params![
            room_id_str,
            event_id.as_str().unwrap_or("authority-claim"),
            common::compact_json(&json!({"kind": "system", "id": "authority-control"}), true),
            new_epoch,
            common::compact_json(&payload, true),
            now
        ],
    )?;

    tx.commit()?;
    Ok(new_epoch)
}

// ── 探测 ────────────────────────────────────────────────────────────────────

/// 上游 `probe_hosted_room()`：非阻塞检查房间归属（不建库、不迁移）。
pub fn probe_hosted_room(conn: &Connection, room_id: &Value) -> RoomResult<bool> {
    let room_id_str = store::validate_room_id_pub(room_id)?;
    let found: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM hosted_rooms WHERE room_id=?1 AND disbanded_at IS NULL LIMIT 1",
            [room_id_str],
            |row| row.get(0),
        )
        .optional()?;
    Ok(found.is_some())
}

/// 上游 `probe_peer_room_reservation()`：检查 peer 保留是否活着。
pub fn probe_peer_room_reservation(
    conn: &Connection,
    room_id: &Value,
    target_profile: &str,
    now: f64,
) -> RoomResult<bool> {
    let room_id_str = store::validate_room_id_pub(room_id)?;
    let found: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM hosted_room_peer_reservations
             WHERE room_id=?1 AND target_profile=?2 AND expires_at>?3 AND revoked_at IS NULL LIMIT 1",
            rusqlite::params![room_id_str, target_profile, now],
            |row| row.get(0),
        )
        .optional()?;
    Ok(found.is_some())
}

/// 上游 `room_has_peer_obligations()`：房间是否还有未结的 peer 义务（未撤销的保留）。
pub fn room_has_peer_obligations(conn: &Connection, room_id: &Value, now: f64) -> RoomResult<bool> {
    let room_id_str = store::validate_room_id_pub(room_id)?;
    let found: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM hosted_room_peer_reservations
             WHERE room_id=?1 AND revoked_at IS NULL AND expires_at>?2 LIMIT 1",
            rusqlite::params![room_id_str, now],
            |row| row.get(0),
        )
        .optional()?;
    Ok(found.is_some())
}

// ── peer 保留 ───────────────────────────────────────────────────────────────

/// 一条 peer 房间保留（上游 `reserve_peer_room` 的输入）。
#[derive(Debug, Clone)]
pub struct PeerReservation<'a> {
    pub room_id: &'a str,
    pub member_id: &'a str,
    pub target_profile: &'a str,
    pub authority_gateway_id: &'a str,
    pub authority_epoch: i64,
    pub expires_at: f64,
}

/// 上游 `reserve_peer_room()`：登记/续期一条 peer 保留。
pub fn reserve_peer_room(conn: &mut Connection, reservation: &PeerReservation<'_>, now: f64) -> RoomResult<()> {
    if reservation.authority_epoch < 1 {
        return Err(HostedRoomError(
            "authority_epoch must be a positive integer".into(),
        ));
    }
    conn.execute(
        "INSERT INTO hosted_room_peer_reservations
            (room_id, member_id, target_profile, authority_gateway_id, authority_epoch,
             expires_at, revoked_at, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7, ?7)
         ON CONFLICT(room_id, member_id, target_profile) DO UPDATE SET
             authority_gateway_id=excluded.authority_gateway_id,
             authority_epoch=excluded.authority_epoch,
             expires_at=excluded.expires_at,
             revoked_at=NULL,
             updated_at=excluded.updated_at",
        rusqlite::params![
            reservation.room_id,
            reservation.member_id,
            reservation.target_profile,
            reservation.authority_gateway_id,
            reservation.authority_epoch,
            reservation.expires_at,
            now
        ],
    )?;
    Ok(())
}

/// 撤销一条 peer 保留。
pub fn revoke_peer_reservation(
    conn: &Connection,
    room_id: &str,
    member_id: &str,
    target_profile: &str,
    now: f64,
) -> RoomResult<bool> {
    let affected = conn.execute(
        "UPDATE hosted_room_peer_reservations SET revoked_at=?1, updated_at=?1
         WHERE room_id=?2 AND member_id=?3 AND target_profile=?4 AND revoked_at IS NULL",
        rusqlite::params![now, room_id, member_id, target_profile],
    )?;
    Ok(affected > 0)
}

/// 上游 `room_grant_is_revoked()`：该 grant 是否**早于**它自己 scope 的撤销栅栏。
///
/// 上游语义（关键，不是简单的“存在撤销记录”）：
/// ```text
/// row = SELECT revoked_before FROM hosted_room_revoked_grants
///       WHERE scope_key=? AND expires_at>?
/// return row is not None and issued_at <= row.revoked_before
/// ```
/// 即：撤销记录未过期，**且**该 grant 的签发时刻早于撤销时刻。
/// 所以撤销后**新签发**的 grant（issued_at 更新）不会被误杀。
pub fn room_grant_is_revoked(conn: &Connection, grant: &str, issued_at: f64, now: f64) -> RoomResult<bool> {
    let digest = grant_digest(grant);
    let revoked_before: Option<f64> = conn
        .query_row(
            "SELECT revoked_before FROM hosted_room_revoked_grants
             WHERE scope_key=?1 AND expires_at>?2",
            rusqlite::params![digest, now],
            |row| row.get(0),
        )
        .optional()?;
    Ok(revoked_before.is_some_and(|before| issued_at <= before))
}

/// 上游 `revoke_room_grant_scope()`：把某 grant 的 scope 记为已撤销。
pub fn revoke_room_grant_scope(conn: &Connection, grant: &str, expires_at: f64, now: f64) -> RoomResult<()> {
    let digest = grant_digest(grant);
    conn.execute(
        "INSERT INTO hosted_room_revoked_grants (scope_key, expires_at, revoked_before)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(scope_key) DO UPDATE SET
             expires_at=MAX(hosted_room_revoked_grants.expires_at, excluded.expires_at),
             revoked_before=MAX(hosted_room_revoked_grants.revoked_before, excluded.revoked_before)",
        rusqlite::params![digest, expires_at, now],
    )?;
    Ok(())
}

// ── 远端执行回执 ────────────────────────────────────────────────────────────

/// 一条远端执行回执的身份坐标（上游 `_REMOTE_RUN_IDENTITY_COLUMNS`）。
#[derive(Debug, Clone)]
pub struct RemoteRunKey<'a> {
    pub room_id: &'a str,
    pub home_install_id: &'a str,
    pub authority_gateway_id: &'a str,
    pub authority_epoch: i64,
    pub member_id: &'a str,
    pub task_id: &'a str,
    pub execution_generation: i64,
    pub target_install_id: &'a str,
    pub target_profile: &'a str,
}

/// 上游 `upsert_remote_run_receipt()`：登记一条远端执行回执。
pub fn upsert_remote_run_receipt(
    conn: &Connection,
    key: &RemoteRunKey<'_>,
    run_id: &str,
    session_id: &str,
    now: f64,
) -> RoomResult<()> {
    conn.execute(
        "INSERT INTO hosted_room_remote_runs
            (room_id, home_install_id, authority_gateway_id, authority_epoch, member_id, task_id,
             execution_generation, target_install_id, target_profile, run_id, session_id,
             created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12)
         ON CONFLICT DO UPDATE SET
             run_id=excluded.run_id, session_id=excluded.session_id, updated_at=excluded.updated_at",
        rusqlite::params![
            key.room_id,
            key.home_install_id,
            key.authority_gateway_id,
            key.authority_epoch,
            key.member_id,
            key.task_id,
            key.execution_generation,
            key.target_install_id,
            key.target_profile,
            run_id,
            session_id,
            now
        ],
    )?;
    Ok(())
}

/// 上游 `remote_run_receipt()`：读一条回执。
pub fn remote_run_receipt(conn: &Connection, key: &RemoteRunKey<'_>) -> RoomResult<Option<Value>> {
    let mut stmt = conn.prepare(
        "SELECT run_id, session_id, created_at, updated_at FROM hosted_room_remote_runs
         WHERE room_id=?1 AND home_install_id=?2 AND authority_gateway_id=?3 AND authority_epoch=?4
           AND member_id=?5 AND task_id=?6 AND execution_generation=?7
           AND target_install_id=?8 AND target_profile=?9",
    )?;
    let mut rows = stmt.query(rusqlite::params![
        key.room_id,
        key.home_install_id,
        key.authority_gateway_id,
        key.authority_epoch,
        key.member_id,
        key.task_id,
        key.execution_generation,
        key.target_install_id,
        key.target_profile
    ])?;
    match rows.next()? {
        Some(row) => Ok(Some(json!({
            "run_id": row.get::<_, String>(0)?,
            "session_id": row.get::<_, String>(1)?,
            "created_at": row.get::<_, f64>(2)?,
            "updated_at": row.get::<_, f64>(3)?,
        }))),
        None => Ok(None),
    }
}

/// 上游 `drop_remote_run_receipt()`：删一条回执（run_id 必须匹配）。
pub fn drop_remote_run_receipt(conn: &Connection, key: &RemoteRunKey<'_>, run_id: &str) -> RoomResult<bool> {
    let affected = conn.execute(
        "DELETE FROM hosted_room_remote_runs
         WHERE room_id=?1 AND home_install_id=?2 AND authority_gateway_id=?3 AND authority_epoch=?4
           AND member_id=?5 AND task_id=?6 AND execution_generation=?7
           AND target_install_id=?8 AND target_profile=?9 AND run_id=?10",
        rusqlite::params![
            key.room_id,
            key.home_install_id,
            key.authority_gateway_id,
            key.authority_epoch,
            key.member_id,
            key.task_id,
            key.execution_generation,
            key.target_install_id,
            key.target_profile,
            run_id
        ],
    )?;
    Ok(affected > 0)
}

/// 上游 `list_remote_run_receipts()`：列某房间的回执。
pub fn list_remote_run_receipts(conn: &Connection, room_id: &str, limit: i64) -> RoomResult<Vec<Value>> {
    let mut stmt = conn.prepare(
        "SELECT task_id, member_id, target_profile, run_id, session_id, execution_generation
         FROM hosted_room_remote_runs WHERE room_id=?1 ORDER BY task_id, execution_generation LIMIT ?2",
    )?;
    let rows = stmt.query_map(rusqlite::params![room_id, limit], |row| {
        Ok(json!({
            "task_id": row.get::<_, String>(0)?,
            "member_id": row.get::<_, String>(1)?,
            "target_profile": row.get::<_, String>(2)?,
            "run_id": row.get::<_, String>(3)?,
            "session_id": row.get::<_, String>(4)?,
            "execution_generation": row.get::<_, i64>(5)?,
        }))
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn seeded() -> Connection {
        let mut conn = store::open_in_memory().unwrap();
        store::create_room(
            &mut conn,
            &json!("room-1"),
            &json!("Room"),
            &json!([]),
            &json!("gw-1"),
            Some(1.0),
        )
        .unwrap();
        // driver 与 replica 表（peer 保留等需要）
        super::super::driver::initialize_driver_schema(&conn).unwrap();
        super::super::replicas::initialize_replica_schema(&conn).unwrap();
        conn
    }

    // ── 事件 id 派生 ──────────────────────────────────────────────────────

    #[test]
    fn user_event_id_is_deterministic_and_namespaced() {
        let a = user_event_id("client-key-1");
        let b = user_event_id("client-key-1");
        assert_eq!(a, b);
        assert!(a.starts_with("user:"));
        assert_eq!(a.len(), "user:".len() + 64);
        // 不同键不同 id
        assert_ne!(a, user_event_id("client-key-2"));
    }

    #[test]
    fn grant_digest_is_sha256_hex() {
        let digest = grant_digest("a-grant-token");
        assert_eq!(digest.len(), 64);
        assert!(digest.bytes().all(|b| b.is_ascii_hexdigit()));
        // 稳定
        assert_eq!(digest, grant_digest("a-grant-token"));
    }

    #[test]
    fn room_stop_event_id_uses_32_hex_chars() {
        let id = room_stop_event_id("cancel-1");
        assert!(id.starts_with("room-stop:"));
        assert_eq!(id.len(), "room-stop:".len() + 32);
    }

    // ── 停止 ──────────────────────────────────────────────────────────────

    #[test]
    fn request_room_stop_appends_gateway_event() {
        let mut conn = seeded();
        let event = request_room_stop(
            &mut conn,
            &json!("room-1"),
            &json!("cancel-1"),
            "gw-1",
            1,
            Some(10.0),
        )
        .unwrap();
        assert_eq!(event.kind, "room.stop_requested");
        assert_eq!(event.payload_json.contains("cancel-1"), true);
        assert_eq!(event.seq, 1);
    }

    #[test]
    fn request_room_stop_is_idempotent() {
        let mut conn = seeded();
        let a = request_room_stop(&mut conn, &json!("room-1"), &json!("c1"), "gw-1", 1, Some(10.0)).unwrap();
        let b = request_room_stop(&mut conn, &json!("room-1"), &json!("c1"), "gw-1", 1, Some(20.0)).unwrap();
        // 同 cancel_id → 同 event_id → 幂等返回原事件
        assert_eq!(a, b);
        let events = store::read_events(&conn, &json!("room-1"), 0, 10).unwrap();
        assert_eq!(events.len(), 1);
    }

    #[test]
    fn request_room_stop_rejects_empty_cancel_id() {
        let mut conn = seeded();
        assert!(request_room_stop(&mut conn, &json!("room-1"), &json!(""), "gw-1", 1, None).is_err());
    }

    // ── 换权 ──────────────────────────────────────────────────────────────

    #[test]
    fn claim_authority_bumps_epoch() {
        let mut conn = seeded();
        let new_epoch = claim_authority(
            &mut conn,
            &json!("room-1"),
            "gw-1",
            1,
            "gw-2",
            &json!("claim-1"),
            Some(100.0),
        )
        .unwrap();
        assert_eq!(new_epoch, 2);

        let room = store::room_state(&conn, &json!("room-1"), false).unwrap();
        assert_eq!(room.authority_gateway_id, "gw-2");
        assert_eq!(room.authority_epoch, 2);
    }

    #[test]
    fn claim_authority_cas_rejects_stale_epoch() {
        let mut conn = seeded();
        // 用错的期望 epoch → CAS 失败
        let err = claim_authority(
            &mut conn,
            &json!("room-1"),
            "gw-1",
            5, // 实际是 1
            "gw-2",
            &json!("claim-1"),
            Some(100.0),
        )
        .unwrap_err();
        assert!(err.0.contains("authority changed"));
    }

    #[test]
    fn claim_authority_cas_rejects_stale_gateway() {
        let mut conn = seeded();
        let err = claim_authority(
            &mut conn,
            &json!("room-1"),
            "gw-other",
            1,
            "gw-2",
            &json!("claim-1"),
            Some(100.0),
        )
        .unwrap_err();
        assert!(err.0.contains("authority changed"));
    }

    // ── 探测 ──────────────────────────────────────────────────────────────

    #[test]
    fn probe_hosted_room_detects_live_room() {
        let conn = seeded();
        assert!(probe_hosted_room(&conn, &json!("room-1")).unwrap());
        assert!(!probe_hosted_room(&conn, &json!("room-missing")).unwrap());
    }

    #[test]
    fn probe_hosted_room_excludes_disbanded() {
        let mut conn = seeded();
        store::disband_room(&mut conn, &json!("room-1"), Some(50.0)).unwrap();
        assert!(!probe_hosted_room(&conn, &json!("room-1")).unwrap());
    }

    // ── peer 保留 ─────────────────────────────────────────────────────────

    fn reservation<'a>() -> PeerReservation<'a> {
        PeerReservation {
            room_id: "room-1",
            member_id: "m-ada",
            target_profile: "alice",
            authority_gateway_id: "gw-1",
            authority_epoch: 1,
            expires_at: 500.0,
        }
    }

    #[test]
    fn reserve_and_probe_peer_room() {
        let mut conn = seeded();
        reserve_peer_room(&mut conn, &reservation(), 100.0).unwrap();
        assert!(probe_peer_room_reservation(&conn, &json!("room-1"), "alice", 200.0).unwrap());
        // 过期后不活
        assert!(!probe_peer_room_reservation(&conn, &json!("room-1"), "alice", 600.0).unwrap());
    }

    #[test]
    fn reserve_is_upsert() {
        let mut conn = seeded();
        reserve_peer_room(&mut conn, &reservation(), 100.0).unwrap();
        let mut updated = reservation();
        updated.expires_at = 900.0;
        reserve_peer_room(&mut conn, &updated, 200.0).unwrap();
        // 续期后 600 仍活着
        assert!(probe_peer_room_reservation(&conn, &json!("room-1"), "alice", 600.0).unwrap());
    }

    #[test]
    fn reserve_rejects_bad_epoch() {
        let mut conn = seeded();
        let mut bad = reservation();
        bad.authority_epoch = 0;
        assert!(reserve_peer_room(&mut conn, &bad, 100.0).is_err());
    }

    #[test]
    fn revoke_peer_reservation_clears_it() {
        let mut conn = seeded();
        reserve_peer_room(&mut conn, &reservation(), 100.0).unwrap();
        assert!(revoke_peer_reservation(&conn, "room-1", "m-ada", "alice", 150.0).unwrap());
        assert!(!probe_peer_room_reservation(&conn, &json!("room-1"), "alice", 200.0).unwrap());
    }

    #[test]
    fn room_has_peer_obligations_tracks_reservations() {
        let mut conn = seeded();
        assert!(!room_has_peer_obligations(&conn, &json!("room-1"), 100.0).unwrap());
        reserve_peer_room(&mut conn, &reservation(), 100.0).unwrap();
        assert!(room_has_peer_obligations(&conn, &json!("room-1"), 100.0).unwrap());
        revoke_peer_reservation(&conn, "room-1", "m-ada", "alice", 150.0).unwrap();
        assert!(!room_has_peer_obligations(&conn, &json!("room-1"), 200.0).unwrap());
    }

    // ── grant 撤销 ────────────────────────────────────────────────────────

    #[test]
    fn revoke_and_check_grant() {
        let conn = seeded();
        let grant = "some-bearer-token";
        assert!(!room_grant_is_revoked(&conn, grant, 50.0, 100.0).unwrap());
        revoke_room_grant_scope(&conn, grant, 500.0, 100.0).unwrap();
        assert!(room_grant_is_revoked(&conn, grant, 50.0, 200.0).unwrap());
        // 超过 expires_at 后不再算撤销
        assert!(!room_grant_is_revoked(&conn, grant, 50.0, 600.0).unwrap());
        // 撤销之后**新签发**的 grant 不被误杀
        assert!(!room_grant_is_revoked(&conn, grant, 150.0, 200.0).unwrap());
    }

    #[test]
    fn revoke_is_idempotent_and_extends() {
        let conn = seeded();
        let grant = "token";
        revoke_room_grant_scope(&conn, grant, 500.0, 100.0).unwrap();
        revoke_room_grant_scope(&conn, grant, 900.0, 200.0).unwrap();
        // 延长后 700 仍算撤销（issued_at=50 早于两次撤销）
        assert!(room_grant_is_revoked(&conn, grant, 50.0, 700.0).unwrap());
    }

    // ── 远端回执 ──────────────────────────────────────────────────────────

    fn run_key<'a>() -> RemoteRunKey<'a> {
        RemoteRunKey {
            room_id: "room-1",
            home_install_id: "home-1",
            authority_gateway_id: "gw-1",
            authority_epoch: 1,
            member_id: "m-ada",
            task_id: "task-1",
            execution_generation: 1,
            target_install_id: "target-1",
            target_profile: "alice",
        }
    }

    #[test]
    fn remote_run_receipt_round_trips() {
        let conn = seeded();
        let key = run_key();
        assert!(remote_run_receipt(&conn, &key).unwrap().is_none());

        upsert_remote_run_receipt(&conn, &key, "run-1", "session-1", 100.0).unwrap();
        let receipt = remote_run_receipt(&conn, &key).unwrap().unwrap();
        assert_eq!(receipt["run_id"], "run-1");
        assert_eq!(receipt["session_id"], "session-1");
    }

    #[test]
    fn upsert_updates_existing_receipt() {
        let conn = seeded();
        let key = run_key();
        upsert_remote_run_receipt(&conn, &key, "run-1", "session-1", 100.0).unwrap();
        upsert_remote_run_receipt(&conn, &key, "run-2", "session-2", 200.0).unwrap();
        let receipt = remote_run_receipt(&conn, &key).unwrap().unwrap();
        assert_eq!(receipt["run_id"], "run-2");
    }

    #[test]
    fn drop_receipt_requires_matching_run_id() {
        let conn = seeded();
        let key = run_key();
        upsert_remote_run_receipt(&conn, &key, "run-1", "session-1", 100.0).unwrap();
        // 错的 run_id → 不删
        assert!(!drop_remote_run_receipt(&conn, &key, "run-other").unwrap());
        assert!(remote_run_receipt(&conn, &key).unwrap().is_some());
        // 对的 → 删
        assert!(drop_remote_run_receipt(&conn, &key, "run-1").unwrap());
        assert!(remote_run_receipt(&conn, &key).unwrap().is_none());
    }

    #[test]
    fn list_receipts_orders_by_task() {
        let conn = seeded();
        for (task, gen) in [("task-b", 1), ("task-a", 1), ("task-a", 2)] {
            let mut key = run_key();
            key.task_id = task;
            key.execution_generation = gen;
            upsert_remote_run_receipt(&conn, &key, &format!("run-{task}-{gen}"), "s", 100.0).unwrap();
        }
        let receipts = list_remote_run_receipts(&conn, "room-1", 10).unwrap();
        assert_eq!(receipts.len(), 3);
        // task_id 升序，同 task 按代际
        assert_eq!(receipts[0]["task_id"], "task-a");
        assert_eq!(receipts[0]["execution_generation"], 1);
        assert_eq!(receipts[1]["execution_generation"], 2);
        assert_eq!(receipts[2]["task_id"], "task-b");
    }
}
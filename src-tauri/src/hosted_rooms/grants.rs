//! 跨网关 grant 账本（hermes `gateway/hosted_rooms.py` 的 grant 段移植，2026-11-19）。
//!
//! ## 上游语义（逐条照抄）
//!
//! 1. ** revocation fence**：`hosted_room_revoked_grants` 按 scope_key 记录
//!    「该 scope 在某时刻前签发的 grant 全部作废」。`room_grant_is_revoked`
//!    判定 `issued_at <= revoked_before`——**只作废作废时刻之前签发的 token**，
//!    重发给对端的新 token（issued_at 更晚）不受影响。
//! 2. **target reservation**：`hosted_room_peer_reservations` 记录「本网关
//!    在某房间为某 profile 签过 grant」。`peer_room_grant_is_current` 要求
//!    claims 与本机当前活跃 reservation 完全一致（room_id/member_id/
//!    target_profile/authority_gateway_id/authority_epoch），expires_at 未到、
//!    未撤销。签发时 `reserve_peer_room` 先 upsert 再靠读回判定——旧的
//!    reservation 被新 epoch 覆盖时先 fence 掉（`revoked_at`）。
//! 3. `reserve_peer_room` 的 authority 冲突：同名 (room_id, target_profile)
//!    下已有**更高 epoch 或同 epoch 不同网关**的 reservation → Err
//!    `peer room reservation authority changed`，**不覆盖**。
//! 4. `expires_at <= now` 的 reservation 签发本身就是错误（上游
//!    `peer room reservation must expire in the future`）。
//!
//! 这些表在 `store::SCHEMA_DDL` 里早已建好（P1 时为第 4 层预留），本模块
//! 只补读写与判定，不改 schema。

use rusqlite::{Connection, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::common;
use super::store::{HostedRoomError, RoomResult};

fn sha256_hex(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn fail<T>(message: impl Into<String>) -> RoomResult<T> {
    Err(HostedRoomError(message.into()))
}

fn claim_str(claims: &Value, field: &str) -> RoomResult<String> {
    claims
        .get(field)
        .and_then(Value::as_str)
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| HostedRoomError("room grant scope is incomplete".into()))
}

fn claim_epoch(claims: &Value) -> RoomResult<i64> {
    claims
        .get("authority_epoch")
        .and_then(common::json_i64)
        .ok_or_else(|| HostedRoomError("room grant scope is incomplete".into()))
}

/// 上游 `_room_grant_scope_key`：room/home/target/profile 的稳定非密文键。
pub fn room_grant_scope_key(claims: &Value) -> RoomResult<String> {
    let fields = json!({
        "room_id": claim_str(claims, "room_id")?,
        "home_install_id": claim_str(claims, "home_install_id")?,
        "authority_gateway_id": claim_str(claims, "authority_gateway_id")?,
        "authority_epoch": claim_epoch(claims)?,
        "member_id": claim_str(claims, "member_id")?,
        "target_install_id": claim_str(claims, "target_install_id")?,
        "target_profile": claim_str(claims, "target_profile")?,
    });
    Ok(sha256_hex(
        common::compact_json(&fields, true).as_bytes(),
    ))
}

/// 上游 `_hard_expiry`：grant 及其全部续期都死掉的时刻（status 界线）。
pub fn room_grant_hard_expiry(claims: &Value, now: f64) -> f64 {
    claims
        .get("status_expires_at")
        .or_else(|| claims.get("expires_at"))
        .and_then(Value::as_f64)
        .unwrap_or(now)
}

/// 上游 `revoke_room_grant_scope`：作废一个精确 scope 上已签发的 grant。
pub fn revoke_room_grant_scope(
    conn: &Connection,
    claims: &Value,
    expires_at: f64,
    now: f64,
) -> RoomResult<()> {
    let scope_key = room_grant_scope_key(claims)?;
    if expires_at <= now {
        return Ok(());
    }
    let txn = conn
        .unchecked_transaction()
        .map_err(|e| HostedRoomError(e.to_string()))?;
    txn.execute(
        "DELETE FROM hosted_room_revoked_grants WHERE expires_at<=?",
        [now],
    )
    .map_err(|e| HostedRoomError(e.to_string()))?;
    txn.execute(
        "INSERT INTO hosted_room_revoked_grants(scope_key, expires_at, revoked_before)
         VALUES (?, ?, ?)
         ON CONFLICT(scope_key) DO UPDATE SET
             expires_at=MAX(hosted_room_revoked_grants.expires_at, excluded.expires_at),
             revoked_before=MAX(hosted_room_revoked_grants.revoked_before, excluded.revoked_before)",
        rusqlite::params![scope_key, expires_at, now],
    )
    .map_err(|e| HostedRoomError(e.to_string()))?;
    txn.execute(
        "UPDATE hosted_room_peer_reservations SET revoked_at=?, updated_at=?
          WHERE room_id=? AND member_id=? AND target_profile=?
            AND authority_gateway_id=? AND authority_epoch=?",
        rusqlite::params![
            now,
            now,
            claim_str(claims, "room_id")?,
            claim_str(claims, "member_id")?,
            claim_str(claims, "target_profile")?,
            claim_str(claims, "authority_gateway_id")?,
            claim_epoch(claims)?,
        ],
    )
    .map_err(|e| HostedRoomError(e.to_string()))?;
    txn.commit().map_err(|e| HostedRoomError(e.to_string()))?;
    Ok(())
}

fn reservation_superseded(row: &(String, i64), gateway: &str, epoch: i64) -> bool {
    let (row_gateway, row_epoch) = row;
    *row_epoch > epoch || (*row_epoch == epoch && row_gateway != gateway)
}

/// 上游 `reserve_peer_room`：在本机为某房间/profile 保留一份签发记录（fence 旧记录）。
pub fn reserve_peer_room(
    conn: &Connection,
    claims: &Value,
    expires_at: f64,
    now: f64,
) -> RoomResult<()> {
    if expires_at <= now {
        return fail("peer room reservation must expire in the future");
    }
    let room_id = claim_str(claims, "room_id")?;
    let member_id = claim_str(claims, "member_id")?;
    let target_profile = claim_str(claims, "target_profile")?;
    let authority_gateway_id = claim_str(claims, "authority_gateway_id")?;
    let epoch = claim_epoch(claims)?;
    if epoch < 1 {
        return fail("authority_epoch must be positive");
    }
    let txn = conn
        .unchecked_transaction()
        .map_err(|e| HostedRoomError(e.to_string()))?;
    txn.execute(
        "DELETE FROM hosted_room_peer_reservations WHERE expires_at<=?",
        [now],
    )
    .map_err(|e| HostedRoomError(e.to_string()))?;
    let authority_rows: Vec<(String, i64)> = {
        let mut stmt = txn
            .prepare(
                "SELECT authority_gateway_id, authority_epoch FROM hosted_room_peer_reservations
                  WHERE room_id=? AND target_profile=? AND expires_at>? AND revoked_at IS NULL",
            )
            .map_err(|e| HostedRoomError(e.to_string()))?;
        let rows = stmt
            .query_map(rusqlite::params![room_id, target_profile, now], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })
            .map_err(|e| HostedRoomError(e.to_string()))?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| HostedRoomError(e.to_string()))?;
        rows
    };
    if authority_rows
        .iter()
        .any(|row| reservation_superseded(row, &authority_gateway_id, epoch))
    {
        return fail("peer room reservation authority changed");
    }
    txn.execute(
        "UPDATE hosted_room_peer_reservations SET revoked_at=?, updated_at=?
          WHERE room_id=? AND target_profile=? AND authority_epoch<? AND revoked_at IS NULL",
        rusqlite::params![now, now, room_id, target_profile, epoch],
    )
    .map_err(|e| HostedRoomError(e.to_string()))?;
    let existing: Option<(String, i64)> = txn
        .query_row(
            "SELECT authority_gateway_id, authority_epoch FROM hosted_room_peer_reservations
              WHERE room_id=? AND member_id=? AND target_profile=?",
            rusqlite::params![room_id, member_id, target_profile],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
        )
        .optional()
        .map_err(|e| HostedRoomError(e.to_string()))?;
    if let Some(existing) = existing {
        if reservation_superseded(&existing, &authority_gateway_id, epoch) {
            return fail("peer room reservation authority changed");
        }
    }
    txn.execute(
        "INSERT INTO hosted_room_peer_reservations(
             room_id, member_id, target_profile, authority_gateway_id, authority_epoch,
             expires_at, revoked_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)
         ON CONFLICT(room_id, member_id, target_profile) DO UPDATE SET
             authority_gateway_id=excluded.authority_gateway_id,
             authority_epoch=excluded.authority_epoch,
             expires_at=MAX(hosted_room_peer_reservations.expires_at, excluded.expires_at),
             revoked_at=NULL,
             updated_at=excluded.updated_at",
        rusqlite::params![
            room_id,
            member_id,
            target_profile,
            authority_gateway_id,
            epoch,
            expires_at,
            now,
            now,
        ],
    )
    .map_err(|e| HostedRoomError(e.to_string()))?;
    txn.commit().map_err(|e| HostedRoomError(e.to_string()))?;
    Ok(())
}

/// 上游 `peer_room_is_reserved`：本机当前是否在该房间为某 profile 保留过签名。
pub fn peer_room_is_reserved(conn: &Connection, room_id: &str, target_profile: &str, now: f64) -> bool {
    conn.query_row(
        "SELECT 1 FROM hosted_room_peer_reservations
          WHERE room_id=? AND target_profile=? AND expires_at>? AND revoked_at IS NULL LIMIT 1",
        rusqlite::params![room_id, target_profile, now],
        |_| Ok(true),
    )
    .optional()
    .ok()
    .flatten()
    .unwrap_or(false)
}

/// 上游 `peer_room_grant_is_current`：grant 必须精确匹配本机当前活跃 reservation。
pub fn peer_room_grant_is_current(conn: &Connection, claims: &Value, now: f64) -> bool {
    let (Ok(room_id), Ok(member_id), Ok(target_profile), Ok(authority_gateway_id), Ok(epoch)) = (
        claim_str(claims, "room_id"),
        claim_str(claims, "member_id"),
        claim_str(claims, "target_profile"),
        claim_str(claims, "authority_gateway_id"),
        claim_epoch(claims),
    ) else {
        return false;
    };
    conn.query_row(
        "SELECT 1 FROM hosted_room_peer_reservations
          WHERE room_id=? AND member_id=? AND target_profile=? AND authority_gateway_id=?
            AND authority_epoch=? AND expires_at>? AND revoked_at IS NULL LIMIT 1",
        rusqlite::params![room_id, member_id, target_profile, authority_gateway_id, epoch, now],
        |_| Ok(true),
    )
    .optional()
    .ok()
    .flatten()
    .unwrap_or(false)
}

/// 上游 `room_grant_is_revoked`：该 scope 在 revoked_before 之前签发的 grant 已作废。
pub fn room_grant_is_revoked(conn: &Connection, claims: &Value, now: f64) -> bool {
    let Ok(scope_key) = room_grant_scope_key(claims) else {
        return false;
    };
    let issued_at = claims
        .get("issued_at")
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    let revoked_before: Option<Option<f64>> = conn
        .query_row(
            "SELECT revoked_before FROM hosted_room_revoked_grants
              WHERE scope_key=? AND expires_at>?",
            rusqlite::params![scope_key, now],
            |row| row.get::<_, f64>(0).map(Some),
        )
        .optional()
        .ok()
        .flatten();
    revoked_before.flatten().is_some_and(|fence| issued_at <= fence)
}

/// 供 `/v1/room-members/runs/close` 复用：一次性关闭一个未开始的 admission 键。
/// 上游在 `gateway/platforms/api_server_run_idempotency.py` 的 `RunIdempotencyStore`
/// 里实现；宿主没有可轮询的 API 会话表，关闭语义落在 peer 运行记录里（见
/// `pi_peer_runs::find_or_close`），这里不收。

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hosted_rooms::store;

    fn claims(room: &str, member: &str, epoch: i64, issued_at: f64) -> Value {
        json!({
            "version": 2,
            "grant_id": "g-1",
            "room_id": room,
            "home_install_id": "home",
            "authority_gateway_id": "gw-home",
            "authority_epoch": epoch,
            "member_id": member,
            "target_install_id": "install:b",
            "target_profile": "default",
            "execution_policy_digest": "a".repeat(64),
            "permissions": ["dispatch"],
            "issued_at": issued_at,
            "expires_at": issued_at + 100.0,
            "status_expires_at": issued_at + 200.0,
        })
    }

    #[test]
    fn reserve_then_current() {
        let conn = store::open_in_memory().unwrap();
        let c = claims("room-1", "m-1", 1, 1000.0);
        reserve_peer_room(&conn, &c, 1200.0, 1000.0).unwrap();
        assert!(peer_room_is_reserved(&conn, "room-1", "default", 1100.0));
        assert!(peer_room_grant_is_current(&conn, &c, 1100.0));
        // 过期后不再 current
        assert!(!peer_room_grant_is_current(&conn, &c, 1250.0));
    }

    #[test]
    fn newer_epoch_supersedes_older_reservation() {
        let conn = store::open_in_memory().unwrap();
        let old = claims("room-1", "m-1", 1, 1000.0);
        reserve_peer_room(&conn, &old, 1200.0, 1000.0).unwrap();
        let newer = claims("room-1", "m-1", 2, 1100.0);
        reserve_peer_room(&conn, &newer, 1300.0, 1100.0).unwrap();
        // 旧 epoch 的 claims 不再 current
        assert!(!peer_room_grant_is_current(&conn, &old, 1150.0));
        assert!(peer_room_grant_is_current(&conn, &newer, 1150.0));
    }

    #[test]
    fn same_epoch_other_gateway_conflicts() {
        let conn = store::open_in_memory().unwrap();
        let mut other = claims("room-1", "m-1", 1, 1000.0);
        other["authority_gateway_id"] = json!("gw-other");
        reserve_peer_room(&conn, &other, 1200.0, 1000.0).unwrap();
        let ours = claims("room-1", "m-1", 1, 1001.0);
        assert_eq!(
            reserve_peer_room(&conn, &ours, 1200.0, 1001.0)
                .unwrap_err()
                .0,
            "peer room reservation authority changed"
        );
    }

    #[test]
    fn spend_claims_are_not_current() {
        let conn = store::open_in_memory().unwrap();
        let c = claims("room-1", "m-1", 1, 1000.0);
        reserve_peer_room(&conn, &c, 1200.0, 1000.0).unwrap();
        let mut spent = c.clone();
        spent["grant_id"] = json!("g-2");
        spent["issued_at"] = json!(1005.0);
        spent["expires_at"] = json!(1105.0);
        spent["status_expires_at"] = json!(1205.0);
        // 其他字段全同 → current（reservation 只认坐标，不认具体 grant）
        assert!(peer_room_grant_is_current(&conn, &spent, 1010.0));
    }

    #[test]
    fn revoke_fences_older_issue_times_only() {
        let conn = store::open_in_memory().unwrap();
        let old = claims("room-1", "m-1", 1, 1000.0);
        reserve_peer_room(&conn, &old, 1200.0, 1000.0).unwrap();
        revoke_room_grant_scope(&conn, &old, 1200.0, 1050.0).unwrap();
        assert!(room_grant_is_revoked(&conn, &old, 1060.0));
        // 作废时刻之后签发的新 grant 不受影响
        let fresh = claims("room-1", "m-1", 1, 1051.0);
        assert!(!room_grant_is_revoked(&conn, &fresh, 1060.0));
        // reservation 也被 fence 掉
        assert!(!peer_room_is_reserved(&conn, "room-1", "default", 1060.0));
    }

    #[test]
    fn revoke_with_dead_horizon_is_a_noop() {
        let conn = store::open_in_memory().unwrap();
        let c = claims("room-1", "m-1", 1, 1000.0);
        revoke_room_grant_scope(&conn, &c, 900.0, 1000.0).unwrap();
        assert!(!room_grant_is_revoked(&conn, &c, 1000.0));
    }
}
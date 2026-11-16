//! 证据投递与确认（hermes `hosted_room_work_records.py` 的 delivery 部分 +
//! `hosted_room_work_storage.py` 的 schema 加固）。
//!
//! ## 核心语义（上游注释）
//!
//! > Freeze a source view now; expose it only **after its history is acknowledged**.
//!
//! 投递是**两阶段**的：
//!
//! 1. `prepare_delivery` —— 冻结当前源视图，写进 pending 表，但**只在历史追平后
//!    才真正返回给调用方**（`record.history.seq <= through_seq`）
//! 2. `delivery_status` —— 目标方回 ACK 后把 pending 标成 `acked`
//!
//! ## 三条防坑设计
//!
//! 1. **已阻塞的投递不重复发**：同 `route_generation` 且状态在
//!    `BLOCKED_DELIVERY_STATUSES` 里 → 直接返回 `None`（不反复重试）
//! 2. **pending 未 ack 时重采集要校验源未变**：authority 与 roster 都必须一致，
//!    否则「pending work record source changed」
//! 3. **锚点必须持久化**：即使历史落后也要写 pending——否则繁忙群组会
//!    「每次重采都追不上移动的源尖」而被无限饿死
//!
//! ## `disposition` 四态（storage 层）
//!
//! `current` / `superseded_authority` / `historical` / `invalid`。
//! 换权后旧的未 ack pending 变 `superseded_authority`，已 ack 的变 `historical`。

use rusqlite::{Connection, OptionalExtension};
use serde_json::{json, Value};

use super::common;
use super::store::{HostedRoomError, RoomResult};
use super::work_capture::{self, roster_digest};
use super::work_records;

// ── 常量 ────────────────────────────────────────────────────────────────────

pub const PENDING_TABLE: &str = "hosted_room_work_records_pending";
pub const SOURCE_TABLE: &str = "hosted_room_work_records_source";

/// 会让投递被视为「已阻塞」的状态（上游 `BLOCKED_DELIVERY_STATUSES`）。
pub const BLOCKED_DELIVERY_STATUSES: &[&str] = &[
    "rejected",
    "needs_reauthorization",
    "invalid_ack",
    "unsupported_lineage",
    "invalid_work_evidence",
];

/// disposition 四态。
pub const DISPOSITIONS: &[&str] = &["current", "superseded_authority", "historical", "invalid"];

// ── pending 表（加固版 schema）──────────────────────────────────────────────
//
// 与 `work_capture` 里那个简化版**不同**：这里加上上游 storage 层的
// `disposition` / `route_generation` / `status` 三列，以及防篡改 CHECK。

const PENDING_HARDENED_DDL: &str = "CREATE TABLE IF NOT EXISTS hosted_room_work_records_pending (
            room_id TEXT NOT NULL,
            revision INTEGER NOT NULL,
            digest TEXT NOT NULL,
            record_json TEXT NOT NULL,
            producer_gateway_id TEXT NOT NULL,
            producer_epoch INTEGER NOT NULL,
            disposition TEXT NOT NULL CHECK(disposition IN ('current','superseded_authority','historical','invalid')),
            target_install_id TEXT NOT NULL,
            route_generation TEXT NOT NULL,
            status TEXT NOT NULL,
            PRIMARY KEY(room_id, producer_gateway_id, producer_epoch, target_install_id),
            FOREIGN KEY(room_id) REFERENCES hosted_rooms(room_id) ON DELETE CASCADE
        )";

/// 建加固版 pending 表。
///
/// 若已存在**旧形状**（缺 `producer_gateway_id` 列），则就地重建并保留行——
/// 上游 `_initialize_locked` 的 legacy 迁移语义。
pub fn initialize_delivery(conn: &Connection) -> RoomResult<()> {
    let existing = common::table_columns(conn, PENDING_TABLE);
    let is_legacy = !existing.is_empty() && !existing.contains("producer_gateway_id");

    if is_legacy {
        // 旧形状：只保留可辨认的字段，其余标 invalid（上游「不造假」原则）
        let mut stmt = conn.prepare(&format!(
            "SELECT room_id, revision, digest, record_json FROM {PENDING_TABLE}"
        ))?;
        let legacy_rows: Vec<(String, i64, String, String)> = stmt
            .query_map([], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(stmt);

        conn.execute(&format!("DROP TABLE {PENDING_TABLE}"), [])
            .map_err(|e| HostedRoomError(e.to_string()))?;
        conn.execute(PENDING_HARDENED_DDL, [])
            .map_err(|e| HostedRoomError(e.to_string()))?;

        // 能解析成合法 v1 记录的还原 producer；否则不造 producer（空串 + epoch 0 + invalid）
        for (room_id, revision, digest, record_json) in legacy_rows {
            let parsed = serde_json::from_str::<Value>(&record_json)
                .ok()
                .filter(|r| work_records::validate(r).is_ok())
                .filter(|r| {
                    r.get("version").and_then(common::json_i64) == Some(1)
                        && r.get("room_id").and_then(Value::as_str) == Some(room_id.as_str())
                        && r.get("revision").and_then(common::json_i64) == Some(revision)
                        && r.get("digest").and_then(Value::as_str) == Some(digest.as_str())
                });

            let (producer, epoch, disposition) = match &parsed {
                Some(record) => (
                    record
                        .get("home_install_id")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_owned(),
                    1i64,
                    "current",
                ),
                None => (String::new(), 0i64, "invalid"),
            };

            conn.execute(
                &format!(
                    "INSERT INTO {PENDING_TABLE}
                        (room_id, revision, digest, record_json, producer_gateway_id, producer_epoch,
                         disposition, target_install_id, route_generation, status)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, '', '', 'pending')"
                ),
                rusqlite::params![room_id, revision, digest, record_json, producer, epoch, disposition],
            )
            .map_err(|e| HostedRoomError(e.to_string()))?;
        }
        return Ok(());
    }

    conn.execute(PENDING_HARDENED_DDL, [])
        .map_err(|e| HostedRoomError(e.to_string()))?;
    Ok(())
}

/// 上游 `scope_disposition()`：只读的 authority 投影。
///
/// 当前 authority 与记录的 producer 一致 → 保持原 disposition；
/// 不一致时，pending 未 ack → `superseded_authority`，否则 `historical`。
pub fn scope_disposition(
    conn: &Connection,
    table: &str,
    room_id: &str,
    producer_gateway_id: &str,
    producer_epoch: i64,
    disposition: &str,
    status: &str,
) -> RoomResult<&'static str> {
    if disposition != "current" {
        // 非 current 原样返回（映射到静态生命周期）
        return Ok(match disposition {
            "superseded_authority" => "superseded_authority",
            "historical" => "historical",
            _ => "invalid",
        });
    }

    let current: Option<(String, i64)> = conn
        .query_row(
            "SELECT authority_gateway_id, authority_epoch FROM hosted_rooms WHERE room_id=?1",
            [room_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;

    match current {
        None => Ok("current"), // 房间没了 → 上游也返回 current
        Some((gateway, epoch)) if gateway == producer_gateway_id && epoch == producer_epoch => Ok("current"),
        Some(_) => {
            if table == PENDING_TABLE && status != "acked" {
                Ok("superseded_authority")
            } else {
                Ok("historical")
            }
        }
    }
}

// ── 投递状态 ────────────────────────────────────────────────────────────────

/// 读取一条 pending 行的最小信息。
#[derive(Debug, Clone, PartialEq)]
struct PendingRow {
    revision: i64,
    digest: String,
    record_json: String,
    disposition: String,
    route_generation: String,
    status: String,
}

fn load_pending(
    conn: &Connection,
    room_id: &str,
    target_install_id: &str,
    producer_gateway_id: &str,
    producer_epoch: i64,
) -> RoomResult<Option<PendingRow>> {
    Ok(conn
        .query_row(
            &format!(
                "SELECT revision, digest, record_json, disposition, route_generation, status
                 FROM {PENDING_TABLE}
                 WHERE room_id=?1 AND target_install_id=?2 AND producer_gateway_id=?3 AND producer_epoch=?4
                   AND disposition='current'"
            ),
            rusqlite::params![room_id, target_install_id, producer_gateway_id, producer_epoch],
            |row| {
                Ok(PendingRow {
                    revision: row.get(0)?,
                    digest: row.get(1)?,
                    record_json: row.get(2)?,
                    disposition: row.get(3)?,
                    route_generation: row.get(4)?,
                    status: row.get(5)?,
                })
            },
        )
        .optional()?)
}

/// 上游 `prepare_delivery_locked()`：冻结源视图，但**只在历史追平后**暴露。
///
/// 返回 `None` 的三种情况（都是「这次不发」，不是错误）：
/// 1. 已阻塞（同 route_generation 且状态在 BLOCKED 里）
/// 2. 已 ack 且内容没变（`revision, digest` 相同）
/// 3. 历史还没追平（`record.history.seq > through_seq`）—— 但**锚点已持久化**
#[allow(clippy::too_many_arguments)]
pub fn prepare_delivery(
    conn: &Connection,
    room_id: &str,
    target_install_id: &str,
    route_generation: &str,
    local_gateway_id: &str,
    through_seq: i64,
) -> RoomResult<Option<Value>> {
    initialize_delivery(conn)?;

    let current: Option<(String, i64, String)> = conn
        .query_row(
            "SELECT authority_gateway_id, authority_epoch, members_json FROM hosted_rooms WHERE room_id=?1",
            [room_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;

    let Some((authority_gateway_id, authority_epoch, members_json)) = current else {
        return Err(HostedRoomError("work record source is unavailable".into()));
    };
    if authority_gateway_id != local_gateway_id {
        return Err(HostedRoomError("work record source is unavailable".into()));
    }

    let old = load_pending(conn, room_id, target_install_id, &authority_gateway_id, authority_epoch)?;

    // pending 必须仍是 current
    if let Some(row) = &old {
        if row.disposition != "current" {
            return Err(HostedRoomError("pending work record is not current".into()));
        }
    }

    let record: Value = match &old {
        Some(row) if row.status != "acked" => {
            // 已阻塞 → 不重复发
            if row.route_generation == route_generation
                && BLOCKED_DELIVERY_STATUSES.contains(&row.status.as_str())
            {
                return Ok(None);
            }
            // 复用旧记录，但必须校验源未变（authority 与 roster）
            let existing: Value = serde_json::from_str(&row.record_json)
                .map_err(|_| HostedRoomError("stored work record is invalid".into()))?;
            let members: Value = serde_json::from_str(&members_json)
                .map_err(|_| HostedRoomError("invalid members json".into()))?;
            let same_home = existing.get("home_install_id").and_then(Value::as_str)
                == Some(local_gateway_id);
            let same_authority = existing
                .get("authority")
                .map(|a| {
                    a.get("gateway_id").and_then(Value::as_str) == Some(authority_gateway_id.as_str())
                        && a.get("epoch").and_then(common::json_i64) == Some(authority_epoch)
                })
                .unwrap_or(false);
            let same_roster = existing.get("roster_sha256").and_then(Value::as_str)
                == Some(roster_digest(&members)?.as_str());
            if !(same_home && same_authority && same_roster) {
                return Err(HostedRoomError("pending work record source changed".into()));
            }
            existing
        }
        _ => {
            // 重新采集
            let (record, _changed) = work_capture::build_capture(conn, room_id, local_gateway_id, None)?;
            // 已 ack 且内容没变 → 不发
            if let Some(row) = &old {
                let same = row.revision == record.get("revision").and_then(common::json_i64).unwrap_or(0)
                    && row.digest == record.get("digest").and_then(Value::as_str).unwrap_or("");
                if same {
                    return Ok(None);
                }
            }
            record
        }
    };

    // 写/更新 pending（锚点必须持久化，即使历史落后）
    let revision = record.get("revision").and_then(common::json_i64).unwrap_or(1);
    let digest = record.get("digest").and_then(Value::as_str).unwrap_or("");
    let record_json = work_records::encode(&record)?;

    let reuse = old.as_ref().is_some_and(|row| row.status != "acked");
    if reuse {
        conn.execute(
            &format!(
                "UPDATE {PENDING_TABLE} SET route_generation=?1, status='pending'
                 WHERE room_id=?2 AND producer_gateway_id=?3 AND producer_epoch=?4
                   AND target_install_id=?5 AND disposition='current'"
            ),
            rusqlite::params![
                route_generation,
                room_id,
                authority_gateway_id,
                authority_epoch,
                target_install_id
            ],
        )
        .map_err(|e| HostedRoomError(e.to_string()))?;
    } else {
        conn.execute(
            &format!(
                "INSERT INTO {PENDING_TABLE}
                    (room_id, revision, digest, record_json, producer_gateway_id, producer_epoch,
                     disposition, target_install_id, route_generation, status)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'current', ?7, ?8, 'pending')
                 ON CONFLICT(room_id, producer_gateway_id, producer_epoch, target_install_id) DO UPDATE SET
                     revision=excluded.revision, digest=excluded.digest, record_json=excluded.record_json,
                     route_generation=excluded.route_generation, status=excluded.status,
                     disposition='current'"
            ),
            rusqlite::params![
                room_id,
                revision,
                digest,
                record_json,
                authority_gateway_id,
                authority_epoch,
                target_install_id,
                route_generation
            ],
        )
        .map_err(|e| HostedRoomError(e.to_string()))?;
    }

    // 只在历史追平后才真正暴露
    let history_seq = record
        .get("history")
        .and_then(|h| h.get("seq"))
        .and_then(common::json_i64)
        .unwrap_or(0);
    Ok(if history_seq <= through_seq {
        Some(record)
    } else {
        None
    })
}

/// 上游 `delivery_status_locked()`：把 pending 标成某状态（fenced UPDATE）。
///
/// 只有记录内容仍与传入的 `record` 一致、且 revision/digest/route 全匹配才更新。
pub fn delivery_status(
    conn: &Connection,
    room_id: &str,
    target_install_id: &str,
    route_generation: &str,
    record: &Value,
    status: &str,
) -> RoomResult<bool> {
    initialize_delivery(conn)?;

    let authority = record.get("authority");
    let gateway_id = authority
        .and_then(|a| a.get("gateway_id"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let epoch = authority
        .and_then(|a| a.get("epoch"))
        .and_then(common::json_i64)
        .unwrap_or(0);

    let Some(row) = load_pending(conn, room_id, target_install_id, gateway_id, epoch)? else {
        return Ok(false);
    };

    // 记录内容必须与传入的一致
    let stored: Value = match serde_json::from_str(&row.record_json) {
        Ok(value) => value,
        Err(_) => return Ok(false),
    };
    if work_records::encode(&stored)? != work_records::encode(record)? {
        return Ok(false);
    }

    let revision = record.get("revision").and_then(common::json_i64).unwrap_or(0);
    let digest = record.get("digest").and_then(Value::as_str).unwrap_or("");

    let affected = conn
        .execute(
            &format!(
                "UPDATE {PENDING_TABLE} SET status=?1
                 WHERE room_id=?2 AND target_install_id=?3 AND route_generation=?4
                   AND revision=?5 AND digest=?6 AND producer_gateway_id=?7 AND producer_epoch=?8
                   AND disposition='current'"
            ),
            rusqlite::params![
                status,
                room_id,
                target_install_id,
                route_generation,
                revision,
                digest,
                gateway_id,
                epoch
            ],
        )
        .map_err(|e| HostedRoomError(e.to_string()))?;

    Ok(affected == 1)
}

/// 上游 `acknowledge_locked()`：校验 ACK 形状后标 acked。
///
/// ACK 必须**逐字节**等于 `acknowledgement(record)`，否则拒绝。
pub fn acknowledge(
    conn: &Connection,
    room_id: &str,
    target_install_id: &str,
    route_generation: &str,
    record: &Value,
    ack: &Value,
) -> RoomResult<bool> {
    let expected = work_capture::acknowledgement(record);
    if work_records::encode(ack)? != work_records::encode(&expected)? {
        return Ok(false);
    }
    delivery_status(conn, room_id, target_install_id, route_generation, record, "acked")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seeded() -> Connection {
        let mut conn = super::super::store::open_in_memory().unwrap();
        super::super::store::create_room(
            &mut conn,
            &json!("room-1"),
            &json!("Room"),
            &json!([{"member_id": "m1"}]),
            &json!("gw-1"),
            Some(1.0),
        )
        .unwrap();
        super::super::driver::initialize_driver_schema(&conn).unwrap();
        super::super::policy_checkpoint::initialize(&conn).unwrap();
        work_capture::initialize(&conn).unwrap();
        initialize_delivery(&conn).unwrap();
        conn
    }

    // ── schema ────────────────────────────────────────────────────────────

    #[test]
    fn creates_hardened_pending_table() {
        let conn = seeded();
        let columns = common::table_columns(&conn, PENDING_TABLE);
        // 加固版必须有这三列
        assert!(columns.contains("disposition"));
        assert!(columns.contains("route_generation"));
        assert!(columns.contains("status"));
        assert!(columns.contains("producer_gateway_id"));
        assert!(columns.contains("producer_epoch"));
    }

    #[test]
    fn initialize_is_idempotent() {
        let conn = seeded();
        initialize_delivery(&conn).unwrap();
        initialize_delivery(&conn).unwrap();
    }

    // ── scope_disposition ─────────────────────────────────────────────────

    #[test]
    fn disposition_keeps_current_for_matching_authority() {
        let conn = seeded();
        let d = scope_disposition(&conn, PENDING_TABLE, "room-1", "gw-1", 1, "current", "pending").unwrap();
        assert_eq!(d, "current");
    }

    #[test]
    fn disposition_marks_superseded_for_unacked_after_transfer() {
        let mut conn = seeded();
        super::super::adapters::claim_authority(
            &mut conn, &json!("room-1"), "gw-1", 1, "gw-2", &json!("c1"), Some(100.0),
        )
        .unwrap();
        // pending 未 ack → superseded_authority
        let d = scope_disposition(&conn, PENDING_TABLE, "room-1", "gw-1", 1, "current", "pending").unwrap();
        assert_eq!(d, "superseded_authority");
        // 已 ack → historical
        let d = scope_disposition(&conn, PENDING_TABLE, "room-1", "gw-1", 1, "current", "acked").unwrap();
        assert_eq!(d, "historical");
    }

    #[test]
    fn disposition_passes_through_non_current() {
        let conn = seeded();
        assert_eq!(
            scope_disposition(&conn, PENDING_TABLE, "room-1", "gw-1", 1, "historical", "acked").unwrap(),
            "historical"
        );
        assert_eq!(
            scope_disposition(&conn, PENDING_TABLE, "room-1", "gw-1", 1, "invalid", "").unwrap(),
            "invalid"
        );
    }

    // ── prepare_delivery ──────────────────────────────────────────────────

    #[test]
    fn prepare_delivery_returns_record_when_history_caught_up() {
        let conn = seeded();
        let record = prepare_delivery(&conn, "room-1", "target-1", "route-1", "gw-1", 100).unwrap();
        let record = record.expect("should deliver");
        assert_eq!(record["room_id"], "room-1");
        assert_eq!(record["revision"], 1);
    }

    #[test]
    fn prepare_delivery_is_none_when_history_behind() {
        let conn = seeded();
        // through_seq = -1 → 历史永远追不上
        let result = prepare_delivery(&conn, "room-1", "target-1", "route-1", "gw-1", -1).unwrap();
        assert!(result.is_none());
        // 但 pending 锚点已持久化（上游关键设计：避免饿死）
        let row = load_pending(&conn, "room-1", "target-1", "gw-1", 1).unwrap();
        assert!(row.is_some());
    }

    #[test]
    fn prepare_delivery_skips_blocked_route() {
        let conn = seeded();
        // 先投递一次
        let record = prepare_delivery(&conn, "room-1", "target-1", "route-1", "gw-1", 100)
            .unwrap()
            .unwrap();
        // 标成阻塞
        delivery_status(&conn, "room-1", "target-1", "route-1", &record, "rejected").unwrap();
        // 同 route_generation → 不再发
        let again = prepare_delivery(&conn, "room-1", "target-1", "route-1", "gw-1", 100).unwrap();
        assert!(again.is_none());
    }

    #[test]
    fn prepare_delivery_skips_acked_unchanged() {
        let conn = seeded();
        let record = prepare_delivery(&conn, "room-1", "target-1", "route-1", "gw-1", 100)
            .unwrap()
            .unwrap();
        let ack = work_capture::acknowledgement(&record);
        assert!(acknowledge(&conn, "room-1", "target-1", "route-1", &record, &ack).unwrap());
        // 内容没变 → 不发
        let again = prepare_delivery(&conn, "room-1", "target-1", "route-1", "gw-1", 100).unwrap();
        assert!(again.is_none());
    }

    #[test]
    fn prepare_delivery_rejects_wrong_gateway() {
        let conn = seeded();
        assert_eq!(
            prepare_delivery(&conn, "room-1", "target-1", "route-1", "gw-other", 100)
                .unwrap_err()
                .0,
            "work record source is unavailable"
        );
    }

    #[test]
    fn prepare_delivery_rejects_missing_room() {
        let conn = seeded();
        assert!(prepare_delivery(&conn, "room-missing", "target-1", "route-1", "gw-1", 100).is_err());
    }

    // ── delivery_status ───────────────────────────────────────────────────

    #[test]
    fn delivery_status_requires_matching_record() {
        let conn = seeded();
        let record = prepare_delivery(&conn, "room-1", "target-1", "route-1", "gw-1", 100)
            .unwrap()
            .unwrap();
        // 篡改 record → 不更新
        let mut tampered = record.clone();
        tampered["revision"] = json!(999);
        assert!(!delivery_status(&conn, "room-1", "target-1", "route-1", &tampered, "acked").unwrap());
        // 原 record → 更新
        assert!(delivery_status(&conn, "room-1", "target-1", "route-1", &record, "acked").unwrap());
    }

    #[test]
    fn delivery_status_requires_matching_route_generation() {
        let conn = seeded();
        let record = prepare_delivery(&conn, "room-1", "target-1", "route-1", "gw-1", 100)
            .unwrap()
            .unwrap();
        // 错 route → 不更新
        assert!(!delivery_status(&conn, "room-1", "target-1", "route-OTHER", &record, "acked").unwrap());
    }

    #[test]
    fn delivery_status_returns_false_without_pending() {
        let conn = seeded();
        let record = json!({"authority": {"gateway_id": "gw-1", "epoch": 1}});
        assert!(!delivery_status(&conn, "room-1", "target-1", "route-1", &record, "acked").unwrap());
    }

    // ── acknowledge ───────────────────────────────────────────────────────

    #[test]
    fn acknowledge_requires_exact_shape() {
        let conn = seeded();
        let record = prepare_delivery(&conn, "room-1", "target-1", "route-1", "gw-1", 100)
            .unwrap()
            .unwrap();
        // 错的 ACK → 拒
        assert!(!acknowledge(&conn, "room-1", "target-1", "route-1", &record, &json!({"passive": true}))
            .unwrap());
        // 正确 ACK → 接受
        let ack = work_capture::acknowledgement(&record);
        assert!(acknowledge(&conn, "room-1", "target-1", "route-1", &record, &ack).unwrap());

        // 已 acked
        let row = load_pending(&conn, "room-1", "target-1", "gw-1", 1).unwrap().unwrap();
        assert_eq!(row.status, "acked");
    }

    #[test]
    fn acknowledge_rejects_extra_fields() {
        let conn = seeded();
        let record = prepare_delivery(&conn, "room-1", "target-1", "route-1", "gw-1", 100)
            .unwrap()
            .unwrap();
        let mut ack = work_capture::acknowledgement(&record);
        ack["admitted"] = json!(true); // 额外的「准入」声明
        assert!(!acknowledge(&conn, "room-1", "target-1", "route-1", &record, &ack).unwrap());
    }

    // ── legacy 迁移 ───────────────────────────────────────────────────────

    #[test]
    fn migrates_legacy_pending_table() {
        let mut conn = super::super::store::open_in_memory().unwrap();
        super::super::store::create_room(
            &mut conn,
            &json!("room-1"),
            &json!("Room"),
            &json!([{"member_id": "m1"}]),
            &json!("gw-1"),
            Some(1.0),
        )
        .unwrap();

        // 造一个旧形状的 pending 表
        conn.execute(
            "CREATE TABLE hosted_room_work_records_pending (
                room_id TEXT NOT NULL, producer_gateway_id TEXT NOT NULL,
                producer_epoch INTEGER NOT NULL, target_install_id TEXT NOT NULL,
                revision INTEGER NOT NULL, digest TEXT NOT NULL, record_json TEXT NOT NULL,
                PRIMARY KEY (room_id, producer_gateway_id, producer_epoch, target_install_id))",
            [],
        )
        .unwrap();
        // 注意：这个是「旧形状」但恰好有 producer_gateway_id → 不算 legacy
        // 真正 legacy 是缺该列的，见下一个测试
        initialize_delivery(&conn).unwrap();
        assert!(common::table_exists(&conn, PENDING_TABLE));
    }

    #[test]
    fn migrates_truly_legacy_shape_marking_invalid() {
        let mut conn = super::super::store::open_in_memory().unwrap();
        super::super::store::create_room(
            &mut conn,
            &json!("room-1"),
            &json!("Room"),
            &json!([{"member_id": "m1"}]),
            &json!("gw-1"),
            Some(1.0),
        )
        .unwrap();

        // 真旧形状：缺 producer_gateway_id
        conn.execute(
            "CREATE TABLE hosted_room_work_records_pending (
                room_id TEXT NOT NULL, revision INTEGER NOT NULL, digest TEXT NOT NULL,
                record_json TEXT NOT NULL, target_install_id TEXT NOT NULL,
                route_generation TEXT NOT NULL, status TEXT NOT NULL,
                PRIMARY KEY (room_id, target_install_id))",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO hosted_room_work_records_pending VALUES ('room-1', 1, 'abc', 'not-json', 't1', 'r1', 'pending')",
            [],
        )
        .unwrap();

        initialize_delivery(&conn).unwrap();

        // 迁移后列集是加固版
        let columns = common::table_columns(&conn, PENDING_TABLE);
        assert!(columns.contains("disposition"));

        // 坏记录被标 invalid，且**不造 producer**（空串 + epoch 0）
        let (producer, epoch, disposition): (String, i64, String) = conn
            .query_row(
                &format!(
                    "SELECT producer_gateway_id, producer_epoch, disposition FROM {PENDING_TABLE} LIMIT 1"
                ),
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(producer, "");
        assert_eq!(epoch, 0);
        assert_eq!(disposition, "invalid");
    }

    #[test]
    fn constants_match_upstream() {
        assert_eq!(BLOCKED_DELIVERY_STATUSES.len(), 5);
        assert_eq!(DISPOSITIONS.len(), 4);
        assert!(BLOCKED_DELIVERY_STATUSES.contains(&"needs_reauthorization"));
        assert!(BLOCKED_DELIVERY_STATUSES.contains(&"invalid_ack"));
    }
}
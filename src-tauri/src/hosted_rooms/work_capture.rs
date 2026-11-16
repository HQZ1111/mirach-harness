//! 工作证据捕获编排 + 附件 blob 存储（hermes `hosted_room_work_records.py` 的
//! `capture*` 部分 + `hosted_room_attachments.py` 的存储部分）。
//!
//! ## work_records 的 capture 语义（上游注释）
//!
//! > Observe committed driver facts, **without making evidence an execution gate**.
//! > The caller's transaction owns both facts and evidence. A rejected evidence write
//! > rolls back **only its savepoint**; malformed retained bytes are classified in
//! > place, **never replaced with a fabricated current snapshot**.
//!
//! 三条必须保留的性质：
//!
//! 1. **证据不是执行闸门**：捕获失败不能阻止 driver 推进
//! 2. **savepoint 隔离**：证据写失败只回滚 savepoint，不回滚事实
//! 3. **不造假**：坏字节就地标为 invalid，**绝不**用「当前快照」顶替
//!
//! ## 捕获流程（`capture_locked`）
//!
//! 1. 房间必须存在、authority 匹配、未解散
//! 2. `seq = next_seq - 1`（已提交的最后一条）
//! 3. 采任务（含 bounds 判定）与回执
//! 4. 算 `history_anchor`（seq 为 0 时是空数组的 digest）
//! 5. `version = 1 if epoch == 1 else 2`（v2 多 lineage）
//! 6. digest 不变则**不写新 revision**（幂等）
//!
//! ## 附件 blob
//!
//! 内容寻址：`blob_<sha256[..32]>`，写时先写临时文件再 rename（原子）。
//! 大小与摘要不匹配一律拒。

use rusqlite::{Connection, OptionalExtension};
use serde_json::{json, Value};

use super::common;
use super::store::{HostedRoomError, RoomResult};
use super::work_records::{self, LIMITATIONS, MAX_BYTES, MAX_RECEIPTS, MAX_TASKS};

// ── 证据存储表（上游 storage.SOURCE_TABLE 等）────────────────────────────────

pub const SOURCE_TABLE: &str = "hosted_room_work_records_source";
pub const TARGET_TABLE: &str = "hosted_room_work_records_target";
pub const PENDING_TABLE: &str = "hosted_room_work_records_pending";
pub const INVALID_TABLE: &str = "hosted_room_work_records_invalid";

const SOURCE_DDL: &str = "CREATE TABLE IF NOT EXISTS hosted_room_work_records_source (
            room_id TEXT NOT NULL,
            producer_gateway_id TEXT NOT NULL,
            producer_epoch INTEGER NOT NULL,
            revision INTEGER NOT NULL,
            digest TEXT NOT NULL,
            record_json TEXT NOT NULL,
            PRIMARY KEY (room_id, producer_gateway_id, producer_epoch)
        )";

const TARGET_DDL: &str = "CREATE TABLE IF NOT EXISTS hosted_room_work_records_target (
            room_id TEXT NOT NULL,
            producer_gateway_id TEXT NOT NULL,
            producer_epoch INTEGER NOT NULL,
            target_install_id TEXT NOT NULL,
            revision INTEGER NOT NULL,
            digest TEXT NOT NULL,
            record_json TEXT NOT NULL,
            PRIMARY KEY (room_id, producer_gateway_id, producer_epoch, target_install_id)
        )";

// pending 表是**加固版**（含 disposition / route_generation / status）——由
// `delivery::initialize_delivery` 统一建。这里不再重复定义，避免两处 schema
// 不一致（`CREATE TABLE IF NOT EXISTS` 不会改已存在的表，谁先建谁赢）。

const INVALID_DDL: &str = "CREATE TABLE IF NOT EXISTS hosted_room_work_records_invalid (
            room_id TEXT NOT NULL,
            producer_gateway_id TEXT NOT NULL,
            producer_epoch INTEGER NOT NULL,
            table_name TEXT NOT NULL,
            reason TEXT NOT NULL,
            record_json TEXT NOT NULL,
            recorded_at REAL NOT NULL,
            PRIMARY KEY (room_id, producer_gateway_id, producer_epoch, table_name)
        )";

/// 建 4 张证据表（幂等）。
pub fn initialize(conn: &Connection) -> RoomResult<()> {
    for ddl in [SOURCE_DDL, TARGET_DDL, INVALID_DDL] {
        conn.execute(ddl, []).map_err(|e| HostedRoomError(e.to_string()))?;
    }
    // pending 表交给 delivery 模块建（加固版 schema，含 disposition/route_generation/status）
    super::delivery::initialize_delivery(conn)?;
    Ok(())
}

// ── roster_digest ───────────────────────────────────────────────────────────

/// 上游 `roster_digest()`：成员清单的 sha256。
pub fn roster_digest(members: &Value) -> RoomResult<String> {
    // 上游走 rooms._validate_members 再哈希 canonical JSON
    let Value::Array(items) = members else {
        return Err(HostedRoomError("members must be a list".into()));
    };
    if items.len() > 128 {
        return Err(HostedRoomError("too many room members".into()));
    }
    if !items.iter().all(Value::is_object) {
        return Err(HostedRoomError("each room member must be an object".into()));
    }
    let canonical = common::canonical_json(members, "members", 128 * 1024, true)?;
    Ok(sha256_hex(canonical.as_bytes()))
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

// ── history_anchor ──────────────────────────────────────────────────────────

/// 上游 `history_anchor()`：某 seq 处的事件锚。
///
/// `seq == 0` 时返回空数组的 digest（**不是**全零），这样空房间也有稳定锚。
/// 上游用 `[seq, event_id, kind, actor, authority_epoch, payload, created_at]` 七元组。
pub fn history_anchor(conn: &Connection, room_id: &str, seq: i64) -> RoomResult<String> {
    if seq == 0 {
        return Ok(work_records::digest(&json!([]))?);
    }

    let row: Option<(i64, String, String, String, Option<i64>, String, f64)> = conn
        .query_row(
            "SELECT seq, event_id, kind, actor_json, authority_epoch, payload_json, created_at
             FROM hosted_room_events WHERE room_id=?1 AND seq=?2",
            rusqlite::params![room_id, seq],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                ))
            },
        )
        .optional()?;

    let Some((seq, event_id, kind, actor_json, epoch, payload_json, created_at)) = row else {
        return Err(HostedRoomError(
            "work record history prefix is unavailable".into(),
        ));
    };

    let actor: Value =
        serde_json::from_str(&actor_json).map_err(|_| HostedRoomError("invalid actor json".into()))?;
    let payload: Value =
        serde_json::from_str(&payload_json).map_err(|_| HostedRoomError("invalid payload json".into()))?;

    work_records::digest(&json!([seq, event_id, kind, actor, epoch, payload, created_at])).map_err(Into::into)
}

// ── 捕获任务 ────────────────────────────────────────────────────────────────

/// 上游 `_capture_tasks()` 的返回：`(tasks, receipts, reason)`。
#[derive(Debug, Clone, PartialEq)]
pub struct CapturedTasks {
    pub tasks: Vec<Value>,
    pub receipts: Vec<Value>,
    /// `None` = 可用；否则 `task_store_missing` / `bounds_exceeded` / `unsupported_task`。
    pub reason: Option<String>,
}

/// 上游 `_capture_tasks()`：采driver 任务与远端回执。
///
/// 关键判据（上游注释）：
/// > Published terminal records already travel in canonical history. Keep outstanding
/// > tasks and **unacknowledged publications** within this small slice.
///
/// 所以已发布的终态任务被排除，只留未完成与未确认发布的。
pub fn capture_tasks(conn: &Connection, room_id: &str) -> RoomResult<CapturedTasks> {
    if !common::table_exists(conn, "hosted_room_driver_tasks") {
        return Ok(CapturedTasks {
            tasks: Vec::new(),
            receipts: Vec::new(),
            reason: Some("task_store_missing".into()),
        });
    }

    let has_publications = common::table_exists(conn, "hosted_room_policy_publications");

    // 已发布的终态任务应排除（它们已在 canonical history 里）
    let published_filter = if has_publications {
        " AND (status NOT IN ('settled','failed','cancelled') OR NOT EXISTS (
            SELECT 1 FROM hosted_room_policy_publications AS p
            WHERE p.room_id=t.room_id AND p.task_id=t.task_id
              AND p.kind IN ('turn.settled','turn.failed','turn.cancelled')))"
    } else {
        ""
    };

    let task_sql = format!(
        "SELECT task_id, thread_id, turn_id, source_event_seq, payload_json, payload_digest,
                status, execution_generation, cancel_generation, settlement_id, cancel_id
         FROM hosted_room_driver_tasks AS t
         WHERE room_id=?1{published_filter}
         ORDER BY task_id LIMIT ?2"
    );

    let mut stmt = conn.prepare(&task_sql)?;
    let rows = stmt.query_map(rusqlite::params![room_id, MAX_TASKS as i64 + 1], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, i64>(3)?,
            row.get::<_, String>(4)?,
            row.get::<_, String>(5)?,
            row.get::<_, String>(6)?,
            row.get::<_, i64>(7)?,
            row.get::<_, i64>(8)?,
            row.get::<_, Option<String>>(9)?,
            row.get::<_, Option<String>>(10)?,
        ))
    })?;

    let mut tasks = Vec::new();
    let mut overflow = false;
    for row in rows {
        let (task_id, thread_id, turn_id, source_seq, payload_json, payload_digest, status, exec_gen, cancel_gen, settlement_id, cancel_id) = row?;

        // payload 必须可重新规范化为**同一字节**，否则证据不可信
        let Ok(payload) = serde_json::from_str::<Value>(&payload_json) else {
            return Ok(CapturedTasks {
                tasks: Vec::new(),
                receipts: Vec::new(),
                reason: Some("unsupported_task".into()),
            });
        };
        let recomputed = common::compact_json(&payload, true);
        if recomputed != payload_json || sha256_hex(recomputed.as_bytes()) != payload_digest {
            return Ok(CapturedTasks {
                tasks: Vec::new(),
                receipts: Vec::new(),
                reason: Some("unsupported_task".into()),
            });
        }
        // source_event_seq 必须与 payload 里的一致
        if payload.get("source_event_seq").and_then(common::json_i64) != Some(source_seq) {
            return Ok(CapturedTasks {
                tasks: Vec::new(),
                receipts: Vec::new(),
                reason: Some("unsupported_task".into()),
            });
        }

        let profile = payload
            .get("target_profile")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        let member_id = payload
            .get("target_member_id")
            .and_then(Value::as_str)
            .unwrap_or(profile.as_str())
            .to_owned();

        tasks.push(json!({
            "task_id": task_id,
            "thread_id": thread_id,
            "turn_id": turn_id,
            "source_event_seq": source_seq,
            "payload_sha256": payload_digest,
            "member_id": member_id,
            "profile": profile,
            "execution_generation": exec_gen,
            "cancel_generation": cancel_gen,
            "phase": status,
            "settlement_id": settlement_id,
            "cancel_id": cancel_id,
        }));
        if tasks.len() > MAX_TASKS {
            overflow = true;
            break;
        }
    }

    if overflow {
        return Ok(CapturedTasks {
            tasks: Vec::new(),
            receipts: Vec::new(),
            reason: Some("bounds_exceeded".into()),
        });
    }

    // 回执
    let receipt_filter = if has_publications {
        " AND NOT EXISTS (
            SELECT 1 FROM hosted_room_policy_publications AS p
            WHERE p.room_id=t.room_id AND p.task_id=t.task_id
              AND p.kind IN ('turn.settled','turn.failed','turn.cancelled'))"
    } else {
        ""
    };
    let receipt_sql = format!(
        "SELECT room_id, home_install_id, authority_gateway_id, authority_epoch, member_id,
                target_install_id, target_profile, task_id, execution_generation, run_id, session_id
         FROM hosted_room_remote_runs AS t WHERE room_id=?1{receipt_filter}
         ORDER BY task_id, execution_generation, member_id LIMIT ?2"
    );
    let mut stmt = conn.prepare(&receipt_sql)?;
    let receipts: Vec<Value> = stmt
        .query_map(rusqlite::params![room_id, MAX_RECEIPTS as i64 + 1], |row| {
            Ok(json!({
                "room_id": row.get::<_, String>(0)?,
                "home_install_id": row.get::<_, String>(1)?,
                "authority_gateway_id": row.get::<_, String>(2)?,
                "authority_epoch": row.get::<_, i64>(3)?,
                "member_id": row.get::<_, String>(4)?,
                "target_install_id": row.get::<_, String>(5)?,
                "target_profile": row.get::<_, String>(6)?,
                "task_id": row.get::<_, String>(7)?,
                "execution_generation": row.get::<_, i64>(8)?,
                "run_id": row.get::<_, String>(9)?,
                "session_id": row.get::<_, String>(10)?,
            }))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    if receipts.len() > MAX_RECEIPTS {
        return Ok(CapturedTasks {
            tasks: Vec::new(),
            receipts: Vec::new(),
            reason: Some("bounds_exceeded".into()),
        });
    }

    Ok(CapturedTasks {
        tasks,
        receipts,
        reason: None,
    })
}

// ── capture ─────────────────────────────────────────────────────────────────

/// 上游 `capture_locked()` 的**内容组装**（不写库）。
///
/// 返回 `(record, changed)`：`changed == false` 表示与上一版 digest 相同、
/// 无需写新 revision。
pub fn build_capture(
    conn: &Connection,
    room_id: &str,
    local_gateway_id: &str,
    through_seq: Option<i64>,
) -> RoomResult<(Value, bool)> {
    initialize(conn)?;

    let room: Option<(String, i64, i64, String, Option<f64>)> = conn
        .query_row(
            "SELECT authority_gateway_id, authority_epoch, next_seq, members_json, disbanded_at
             FROM hosted_rooms WHERE room_id=?1",
            [room_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        )
        .optional()?;

    let Some((authority_gateway_id, authority_epoch, next_seq, members_json, disbanded_at)) = room else {
        return Err(HostedRoomError("work record source is unavailable".into()));
    };
    if authority_gateway_id != local_gateway_id || disbanded_at.is_some() {
        return Err(HostedRoomError("work record source is unavailable".into()));
    }

    let seq = next_seq - 1;
    if let Some(limit) = through_seq {
        if seq > limit {
            return Err(HostedRoomError(
                "history delivery must precede work records".into(),
            ));
        }
    }

    let captured = capture_tasks(conn, room_id)?;
    let members: Value =
        serde_json::from_str(&members_json).map_err(|_| HostedRoomError("invalid members json".into()))?;

    // stop 事实
    let stop: Option<(i64, String)> = conn
        .query_row(
            "SELECT seq, payload_json FROM hosted_room_events
             WHERE room_id=?1 AND kind='room.stop_requested' ORDER BY seq DESC LIMIT 1",
            [room_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let (stop_seq, stop_cancel) = match &stop {
        Some((seq, payload_json)) => {
            let payload: Value = serde_json::from_str(payload_json)
                .map_err(|_| HostedRoomError("invalid stop payload".into()))?;
            (
                *seq,
                payload.get("cancel_id").and_then(Value::as_str).map(str::to_owned),
            )
        }
        None => (0, None),
    };

    // 内容（version 1 for epoch 1, else 2）
    let mut content = json!({
        "version": if authority_epoch == 1 { 1 } else { 2 },
        "room_id": room_id,
        "home_install_id": local_gateway_id,
        "authority": {"gateway_id": local_gateway_id, "epoch": authority_epoch},
        "roster_sha256": roster_digest(&members)?,
        "history": {"seq": seq, "event_sha256": history_anchor(conn, room_id, seq)?},
        "availability": if captured.reason.is_none() { "available" } else { "unavailable" },
        "reason": captured.reason,
        "tasks": captured.tasks,
        "receipts": captured.receipts,
        "limitations": LIMITATIONS,
        "stop": {
            "closing": false,
            "revocation_complete": false,
            "seq": stop_seq,
            "cancel_id": stop_cancel,
        },
    });

    // v2 需要 lineage + incompleteness（本实现无 peer 撤销完成证明，fence 恒 None）
    if content["version"] == 2 {
        content["lineage_sha256"] = Value::String(sha256_hex(common::compact_json(&json!([]), true).as_bytes()));
        content["incompleteness"] = json!(["prior_authority_work_unknown"]);
    }

    let digest = work_records::digest(&content)?;

    // 上一版
    let previous: Option<(i64, String)> = conn
        .query_row(
            &format!(
                "SELECT revision, digest FROM {SOURCE_TABLE}
                 WHERE room_id=?1 AND producer_gateway_id=?2 AND producer_epoch=?3"
            ),
            rusqlite::params![room_id, local_gateway_id, authority_epoch],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;

    let revision = previous.as_ref().map(|(rev, _)| rev + 1).unwrap_or(1);
    let changed = previous.as_ref().map(|(_, d)| d != &digest).unwrap_or(true);

    let mut record = content.clone();
    record["revision"] = Value::from(revision);
    record["digest"] = Value::String(digest);

    // 字节上限：超了就降级成 unavailable/bounds_exceeded
    if work_records::encode(&record)?.len() > MAX_BYTES {
        content["tasks"] = json!([]);
        content["receipts"] = json!([]);
        content["availability"] = json!("unavailable");
        content["reason"] = json!("bounds_exceeded");
        let digest = work_records::digest(&content)?;
        record = content;
        record["revision"] = Value::from(revision);
        record["digest"] = Value::String(digest);
    }

    Ok((record, changed))
}

/// 上游 `save_locked()`：写一条源证据（同 scope 覆盖）。
pub fn save_source(conn: &Connection, record: &Value) -> RoomResult<()> {
    let room_id = record.get("room_id").and_then(Value::as_str).unwrap_or("");
    let producer = record
        .get("home_install_id")
        .and_then(Value::as_str)
        .unwrap_or("");
    let epoch = record
        .get("authority")
        .and_then(|a| a.get("epoch"))
        .and_then(common::json_i64)
        .unwrap_or(0);
    let revision = record.get("revision").and_then(common::json_i64).unwrap_or(0);
    let digest = record.get("digest").and_then(Value::as_str).unwrap_or("");
    let record_json = work_records::encode(record)?;

    conn.execute(
        &format!(
            "INSERT INTO {SOURCE_TABLE} (room_id, producer_gateway_id, producer_epoch, revision, digest, record_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(room_id, producer_gateway_id, producer_epoch) DO UPDATE SET
                 revision=excluded.revision, digest=excluded.digest, record_json=excluded.record_json"
        ),
        rusqlite::params![room_id, producer, epoch, revision, digest, record_json],
    )?;
    Ok(())
}

/// 上游 `acknowledgement()`：被动的 ACK 形状（**绝不是准入或执行回执**）。
pub fn acknowledgement(record: &Value) -> Value {
    json!({
        "room_id": record.get("room_id").cloned().unwrap_or(Value::Null),
        "revision": record.get("revision").cloned().unwrap_or(Value::Null),
        "digest": record.get("digest").cloned().unwrap_or(Value::Null),
        "passive": true,
    })
}

// ── 附件 blob 存储 ──────────────────────────────────────────────────────────

/// blob id：`blob_` + sha256 前 32 位 hex（内容寻址）。
pub fn blob_id_for(data: &[u8]) -> String {
    let digest = sha256_hex(data);
    format!("blob_{}", &digest[..32])
}

/// 上游 `_write_blob()`：**原子写**（先写临时文件再 rename）。
///
/// 这样进程在写一半死掉，不会留下半个 blob 被误认为完整。
pub fn write_blob(root: &std::path::Path, data: &[u8]) -> std::io::Result<String> {
    use std::io::Write as _;

    let blob_id = blob_id_for(data);
    std::fs::create_dir_all(root)?;
    let target = root.join(&blob_id);
    let temp = root.join(format!(".{blob_id}.tmp"));

    {
        let mut file = std::fs::File::create(&temp)?;
        file.write_all(data)?;
        file.sync_all()?;
    }
    // rename 是原子的（同一文件系统内）
    std::fs::rename(&temp, &target)?;
    Ok(blob_id)
}

/// 上游 `_read_blob()`：读回并校验大小与摘要。
///
/// **校验失败一律报错**，不返回可能是坏的字节。
pub fn read_blob(root: &std::path::Path, blob_id: &str, expected_size: usize, expected_sha256: &str) -> std::io::Result<Vec<u8>> {
    let data = std::fs::read(root.join(blob_id))?;
    if data.len() != expected_size {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "blob size does not match",
        ));
    }
    if sha256_hex(&data) != expected_sha256 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "blob digest does not match",
        ));
    }
    Ok(data)
}

/// 上游 `_blob_path()`。
pub fn blob_path(root: &std::path::Path, blob_id: &str) -> std::path::PathBuf {
    root.join(blob_id)
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
        initialize(&conn).unwrap();
        conn
    }

    // ── schema ────────────────────────────────────────────────────────────

    #[test]
    fn creates_evidence_tables() {
        let conn = seeded();
        for table in [SOURCE_TABLE, TARGET_TABLE, PENDING_TABLE, INVALID_TABLE] {
            assert!(common::table_exists(&conn, table), "missing {table}");
        }
    }

    // ── roster_digest ─────────────────────────────────────────────────────

    #[test]
    fn roster_digest_is_stable_sha256() {
        let members = json!([{"member_id": "m1"}, {"member_id": "m2"}]);
        let d1 = roster_digest(&members).unwrap();
        let d2 = roster_digest(&members).unwrap();
        assert_eq!(d1, d2);
        assert_eq!(d1.len(), 64);
    }

    #[test]
    fn roster_digest_changes_with_members() {
        let a = roster_digest(&json!([{"member_id": "m1"}])).unwrap();
        let b = roster_digest(&json!([{"member_id": "m2"}])).unwrap();
        assert_ne!(a, b);
    }

    #[test]
    fn roster_digest_rejects_bad_input() {
        assert!(roster_digest(&json!("nope")).is_err());
        assert!(roster_digest(&json!([1, 2])).is_err());
    }

    // ── history_anchor ────────────────────────────────────────────────────

    #[test]
    fn history_anchor_at_zero_is_empty_digest() {
        let conn = seeded();
        let anchor = history_anchor(&conn, "room-1", 0).unwrap();
        // 必须是空数组的 digest，不是全零
        assert_eq!(anchor, work_records::digest(&json!([])).unwrap());
        assert_ne!(anchor, "0".repeat(64));
    }

    #[test]
    fn history_anchor_reads_event() {
        let mut conn = seeded();
        super::super::store::append_event(
            &mut conn,
            &json!("room-1"),
            &json!("e1"),
            &json!("message.user"),
            &json!({"kind": "user", "id": "u1"}),
            &json!({"text": "hi", "thread_id": "t-1"}),
            &json!("gw-1"),
            Some(1),
            Some(10.0),
            None,
            false,
        )
        .unwrap();
        let anchor = history_anchor(&conn, "room-1", 1).unwrap();
        assert_eq!(anchor.len(), 64);
    }

    #[test]
    fn history_anchor_missing_seq_errors() {
        let conn = seeded();
        assert_eq!(
            history_anchor(&conn, "room-1", 99).unwrap_err().0,
            "work record history prefix is unavailable"
        );
    }

    // ── capture_tasks ─────────────────────────────────────────────────────

    #[test]
    fn capture_tasks_reports_missing_store() {
        // 没建 driver 表的库
        let conn = super::super::store::open_in_memory().unwrap();
        let captured = capture_tasks(&conn, "room-1").unwrap();
        assert_eq!(captured.reason.as_deref(), Some("task_store_missing"));
    }

    #[test]
    fn capture_tasks_returns_empty_for_fresh_room() {
        let conn = seeded();
        let captured = capture_tasks(&conn, "room-1").unwrap();
        assert!(captured.reason.is_none());
        assert!(captured.tasks.is_empty());
        assert!(captured.receipts.is_empty());
    }

    #[test]
    fn capture_tasks_picks_up_queued_task() {
        let mut conn = seeded();
        super::super::driver::create_task(
            &mut conn,
            "room-1",
            "task-1",
            "th-1",
            "tu-1",
            1,
            &json!({"target_profile": "alice", "prompt": "hi", "source_event_seq": 1}),
            10.0,
        )
        .unwrap();

        let captured = capture_tasks(&conn, "room-1").unwrap();
        assert!(captured.reason.is_none());
        assert_eq!(captured.tasks.len(), 1);
        assert_eq!(captured.tasks[0]["task_id"], "task-1");
        assert_eq!(captured.tasks[0]["phase"], "queued");
    }

    // ── build_capture ─────────────────────────────────────────────────────

    #[test]
    fn build_capture_produces_v1_for_epoch_one() {
        let conn = seeded();
        let (record, changed) = build_capture(&conn, "room-1", "gw-1", None).unwrap();
        assert!(changed);
        assert_eq!(record["version"], 1);
        assert_eq!(record["room_id"], "room-1");
        assert_eq!(record["revision"], 1);
        assert_eq!(record["availability"], "available");
        assert_eq!(record["limitations"], json!(LIMITATIONS));
        // v1 没有 lineage
        assert!(record.get("lineage_sha256").is_none());
    }

    #[test]
    fn build_capture_is_idempotent_when_nothing_changed() {
        let conn = seeded();
        let (record, changed) = build_capture(&conn, "room-1", "gw-1", None).unwrap();
        assert!(changed);
        // 写进去
        save_source(&conn, &record).unwrap();

        // 再采一次：内容没变 → changed=false
        let (again, changed_again) = build_capture(&conn, "room-1", "gw-1", None).unwrap();
        assert!(!changed_again);
        assert_eq!(again["digest"], record["digest"]);
    }

    #[test]
    fn build_capture_bumps_revision_after_change() {
        let conn = seeded();
        let (first, _) = build_capture(&conn, "room-1", "gw-1", None).unwrap();
        save_source(&conn, &first).unwrap();

        // 加任务 → 内容变了
        drop(conn);
        let mut conn = seeded();
        let (first, _) = build_capture(&conn, "room-1", "gw-1", None).unwrap();
        save_source(&conn, &first).unwrap();
        super::super::driver::create_task(
            &mut conn,
            "room-1",
            "task-1",
            "th-1",
            "tu-1",
            1,
            &json!({"target_profile": "alice", "prompt": "hi", "source_event_seq": 1}),
            10.0,
        )
        .unwrap();

        let (second, changed) = build_capture(&conn, "room-1", "gw-1", None).unwrap();
        assert!(changed);
        assert_eq!(second["revision"], 2);
        assert_ne!(second["digest"], first["digest"]);
    }

    #[test]
    fn build_capture_rejects_wrong_gateway() {
        let conn = seeded();
        let err = build_capture(&conn, "room-1", "gw-other", None).unwrap_err();
        assert_eq!(err.0, "work record source is unavailable");
    }

    #[test]
    fn build_capture_rejects_missing_room() {
        let conn = seeded();
        assert!(build_capture(&conn, "room-missing", "gw-1", None).is_err());
    }

    #[test]
    fn build_capture_rejects_disbanded_room() {
        let mut conn = seeded();
        super::super::store::disband_room(&mut conn, &json!("room-1"), Some(50.0)).unwrap();
        assert_eq!(
            build_capture(&conn, "room-1", "gw-1", None).unwrap_err().0,
            "work record source is unavailable"
        );
    }

    #[test]
    fn build_capture_respects_through_seq() {
        let mut conn = seeded();
        // 加一条事件 → next_seq=2 → seq=1
        super::super::store::append_event(
            &mut conn,
            &json!("room-1"),
            &json!("e1"),
            &json!("message.user"),
            &json!({"kind": "user", "id": "u1"}),
            &json!({"text": "hi", "thread_id": "t-1"}),
            &json!("gw-1"),
            Some(1),
            Some(10.0),
            None,
            false,
        )
        .unwrap();

        // through_seq=0 但 seq=1 → 拒
        assert_eq!(
            build_capture(&conn, "room-1", "gw-1", Some(0)).unwrap_err().0,
            "history delivery must precede work records"
        );
        // through_seq=1 → OK
        assert!(build_capture(&conn, "room-1", "gw-1", Some(1)).is_ok());
    }

    #[test]
    fn build_capture_v2_for_advanced_epoch() {
        let mut conn = seeded();
        super::super::adapters::claim_authority(
            &mut conn,
            &json!("room-1"),
            "gw-1",
            1,
            "gw-2",
            &json!("claim-1"),
            Some(100.0),
        )
        .unwrap();
        let (record, _) = build_capture(&conn, "room-1", "gw-2", None).unwrap();
        assert_eq!(record["version"], 2);
        assert!(record.get("lineage_sha256").is_some());
        assert_eq!(record["incompleteness"], json!(["prior_authority_work_unknown"]));
    }

    // ── acknowledgement ───────────────────────────────────────────────────

    #[test]
    fn acknowledgement_is_passive() {
        let record = json!({"room_id": "r", "revision": 3, "digest": "abc"});
        let ack = acknowledgement(&record);
        assert_eq!(ack["passive"], true);
        assert_eq!(ack["revision"], 3);
        assert_eq!(ack["digest"], "abc");
    }

    // ── blob 存储 ─────────────────────────────────────────────────────────

    #[test]
    fn blob_id_is_content_addressed() {
        let id = blob_id_for(b"hello");
        assert!(id.starts_with("blob_"));
        assert_eq!(id.len(), "blob_".len() + 32);
        // 同内容同 id
        assert_eq!(id, blob_id_for(b"hello"));
        // 不同内容不同 id
        assert_ne!(id, blob_id_for(b"world"));
    }

    #[test]
    fn write_and_read_blob_round_trips() {
        let dir = std::env::temp_dir().join(format!("mirach-blob-test-{}", std::process::id()));
        let data = b"some binary payload";
        let blob_id = write_blob(&dir, data).unwrap();

        let expected_sha = sha256_hex(data);
        let read = read_blob(&dir, &blob_id, data.len(), &expected_sha).unwrap();
        assert_eq!(read, data);

        // 清理
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_blob_is_atomic_no_temp_left() {
        let dir = std::env::temp_dir().join(format!("mirach-blob-atomic-{}", std::process::id()));
        write_blob(&dir, b"data").unwrap();
        // 目录里只有最终文件，没有 .tmp
        let entries: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(entries.len(), 1);
        assert!(!entries[0].ends_with(".tmp"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_blob_rejects_size_mismatch() {
        let dir = std::env::temp_dir().join(format!("mirach-blob-size-{}", std::process::id()));
        let data = b"payload";
        let blob_id = write_blob(&dir, data).unwrap();
        let sha = sha256_hex(data);
        let err = read_blob(&dir, &blob_id, data.len() + 1, &sha).unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::InvalidData);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_blob_rejects_digest_mismatch() {
        let dir = std::env::temp_dir().join(format!("mirach-blob-sha-{}", std::process::id()));
        let data = b"payload";
        let blob_id = write_blob(&dir, data).unwrap();
        let err = read_blob(&dir, &blob_id, data.len(), &"0".repeat(64)).unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::InvalidData);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
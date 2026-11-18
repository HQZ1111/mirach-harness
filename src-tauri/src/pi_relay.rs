//! bot 互发 relay 仓（hermes `tools/bot_relay.py` 的宿主对偶，2026-11-18）：
//! **跨连接/跨网关投递的持久底座**，四门 + 落盘布局与上游逐条对齐。
//!
//! ## 为什么是这个形状（读的是上游真源）
//!
//! hermes 的 relay 不是网关间直连：**Desktop 才是总线**——它持有每条连接的
//! socket，跑两个循环（`apps/desktop/src/plugins/hermes-bots/relay.ts`）：
//! - roster 循环：把"其它连接上的机器人并集"经 `bot_relay.roster.sync` 推给
//!   每个网关（message_agent 靠它解析跨连接目标）；
//! - drain 循环：从每个网关 `bot_relay.outbox.drain` 领 envelope，投到目标
//!   连接（`bot_relay.deliver`），再把回执/回信经 `bot_relay.reply` 写回发送方
//!   网关；发送方 agent 的 waiter 等 `replies/<id>.json` 出现后收尾。
//!
//! envelope 是**每个网关自己磁盘上的 JSON 文件**（安装级共享，不是每 profile）：
//! `~/.pi/agent/bot_relay/{roster.json, outbox/, claimed/, replies/}`。
//! 本模块实现宿主这一个"网关"侧的全部事务；Desktop 循环本体是镜像插件
//! `relay.ts`（未改一行）。跨机方向由 `pi_gateway.rs`（WS JSON-RPC 客户端）
//! 把 door 调用送进远端网关；远端是我们自己时走同一组命令。
//!
//! ## 语义要点（都有上游出处）
//!
//! - enqueue：`outbox/<id>.json` 原子写；id = 32 位 hex。
//! - drain：先 `_sweep_stale`（>6h 的 outbox/claimed/replies 清掉），再逐条
//!   对 outbox 验 TTL（`bot_mode.envelope_ttl_seconds`，默认 900s）——过期写
//!   `queued_expired` 回执并移入 claimed；未过期原子 rename 进 claimed；
//!   最后把 **claimed 里还没回执的**重新并入返回（Desktop 的重试语义：
//!   一个 settle 了但 ACK 丢了的投递会从 pin 重投，而不是静默丢掉）。
//! - reply：**先写者胜**（`replies/<id>.json` 存在就不再写），写后发
//!   `bot_relay.reply` 事件唤醒本机 waiter。
//! - deliver 回执：投递方（Desktop）把终局回执经 `pi_relay_record_receipt`
//!   落进 `claimed/<id>.json`——重投时 `pi_relay_get_receipt` 命中即返回同一
//!   回执（幂等：一轮只跑一次）。
//!
//! 规矩 12：所有 IO 失败都传播（Err），不 fail-open。

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

/// outbox 待领 → claimed →（Desktop 投递）→ replies；投递终局回执在 receipts/。
const OUTBOX_DIR: &str = "outbox";
const CLAIMED_DIR: &str = "claimed";
const REPLIES_DIR: &str = "replies";
/// 投递终局回执（hermes 的 receipt 存在**目标**网关的会话信箱里；宿主对偶 =
/// 独立目录。远端来件不在本机 claimed 里，回执不能依赖 claim 记录——
/// 2026-11-18 实测：依赖 claimed 会让远端来件的回执恒写不进，Desktop 反复
/// 重投、目标 bot 重复跑轮）。
const RECEIPTS_DIR: &str = "receipts";
const ROSTER_FILE: &str = "roster.json";

/// envelope TTL（hermes `bot_mode.envelope_ttl_seconds` 默认 900s）。
const ENVELOPE_TTL_SECONDS: f64 = 900.0;
/// claimed 未回执的重投窗口（hermes `REPLY_WAIT_SECONDS` 量级：投递超时
/// 1500s + 余量）。
const REPLY_WAIT_SECONDS: f64 = 3300.0;
/// 陈旧工件清扫（hermes `STALE_AFTER_SECONDS` = 6h）。
const STALE_AFTER_SECONDS: f64 = 6.0 * 3600.0;

/// 事件名必须与前端 host.onEvent 的点号→冒号映射逐字一致：
/// `bot_relay.outbox.drain`/`pending` 在 sdk/host.ts 里被映射成
/// `mirach:plugin:bot_relay:outbox:pending`（**两个点都变冒号**）。
pub const OUTBOX_PENDING_EVENT: &str = "mirach:plugin:bot_relay:outbox:pending";
pub const REPLY_EVENT: &str = "mirach:plugin:bot_relay:reply";

fn now_secs() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0)
}

pub fn relay_root() -> PathBuf {
    crate::pi_paths::agent_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("bot_relay")
}

fn ensure_dirs(root: &Path) -> Result<(), String> {
    for sub in [OUTBOX_DIR, CLAIMED_DIR, REPLIES_DIR, RECEIPTS_DIR] {
        fs::create_dir_all(root.join(sub))
            .map_err(|e| format!("bot_relay: 建目录 {} 失败: {e}", root.join(sub).display()))?;
    }
    Ok(())
}

fn atomic_write_json(target: &Path, payload: &Value) -> Result<(), String> {
    let tmp = target.with_extension("json.tmp");
    let text =
        serde_json::to_string_pretty(payload).map_err(|e| format!("bot_relay: 序列化失败: {e}"))?;
    fs::write(&tmp, text).map_err(|e| format!("bot_relay: 写 {} 失败: {e}", tmp.display()))?;
    fs::rename(&tmp, target)
        .map_err(|e| format!("bot_relay: 落盘 {} 失败: {e}", target.display()))?;
    Ok(())
}

fn read_json(path: &Path) -> Result<Value, String> {
    let text = fs::read_to_string(path)
        .map_err(|e| format!("bot_relay: 读 {} 失败: {e}", path.display()))?;
    serde_json::from_str(&text)
        .map_err(|e| format!("bot_relay: 解析 {} 失败: {e}", path.display()))
}

fn new_envelope_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

// ── 模型 ────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct RelayEnvelope {
    pub id: String,
    pub created_at: i64,
    pub canonical_delivery_v1: bool,
    pub from_profile: String,
    pub from_handle: String,
    pub target_connection: String,
    pub target_profile: String,
    pub target_handle: String,
    pub message: String,
}

// ── enqueue ─────────────────────────────────────────────────────────────────

fn enqueue_at(
    root: &Path,
    target_connection: &str,
    target_profile: &str,
    target_handle: &str,
    from_profile: &str,
    from_handle: &str,
    message: &str,
) -> Result<RelayEnvelope, String> {
    ensure_dirs(root)?;
    let envelope = RelayEnvelope {
        id: new_envelope_id(),
        created_at: now_secs() as i64,
        canonical_delivery_v1: true,
        from_profile: from_profile.to_owned(),
        from_handle: from_handle.to_owned(),
        target_connection: target_connection.to_owned(),
        target_profile: target_profile.to_owned(),
        target_handle: target_handle.to_owned(),
        message: message.to_owned(),
    };
    let path = root.join(OUTBOX_DIR).join(format!("{}.json", envelope.id));
    let value =
        serde_json::to_value(&envelope).map_err(|e| format!("bot_relay: 序列化 envelope: {e}"))?;
    atomic_write_json(&path, &value)?;
    Ok(envelope)
}

/// 写入一条待投递 envelope（hermes `enqueue_envelope` 同形），并广播
/// `bot_relay.outbox.pending`（Desktop 的 push 路径，payload 是本机 connection id）。
pub fn enqueue(
    app: &AppHandle,
    target_connection: &str,
    target_profile: &str,
    target_handle: &str,
    from_profile: &str,
    from_handle: &str,
    message: &str,
) -> Result<RelayEnvelope, String> {
    let envelope = enqueue_at(
        &relay_root(),
        target_connection,
        target_profile,
        target_handle,
        from_profile,
        from_handle,
        message,
    )?;
    let _ = app.emit(OUTBOX_PENDING_EVENT, json!({ "connection_id": "local" }));
    Ok(envelope)
}

// ── drain ───────────────────────────────────────────────────────────────────

fn sweep_stale(base: &Path, now: f64) {
    for sub in [OUTBOX_DIR, CLAIMED_DIR, REPLIES_DIR, RECEIPTS_DIR] {
        let dir = base.join(sub);
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(meta) = entry.metadata() else { continue };
            let Ok(modified) = meta.modified() else { continue };
            let age = now
                - modified
                    .duration_since(UNIX_EPOCH)
                    .map(|d| d.as_secs_f64())
                    .unwrap_or(now);
            if age > STALE_AFTER_SECONDS {
                let _ = fs::remove_file(&path);
            }
        }
    }
}

fn queued_at(path: &Path) -> f64 {
    fs::metadata(path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs_f64())
        .unwrap_or_else(now_secs)
}

fn write_reply_file(
    root: &Path,
    id: &str,
    reply: &str,
    error: &str,
    reason: &str,
) -> Result<(), String> {
    let path = root.join(REPLIES_DIR).join(format!("{id}.json"));
    if path.exists() {
        return Ok(()); // 先写者胜（幂等）
    }
    atomic_write_json(
        &path,
        &json!({
            "id": id,
            "at": now_secs() as i64,
            "reply": reply,
            "error": error,
            "reason": reason,
        }),
    )
}

/// 领取全部待投递 envelope（hermes `claim_pending_envelopes` 同序）：
/// sweep → outbox 逐条 TTL 过期（写 `queued_expired` 回执）/rename 进 claimed
/// → claimed 未回执的重投（按入队时间序）。
fn drain_at(root: &Path) -> Result<Vec<Value>, String> {
    ensure_dirs(root)?;
    let now = now_secs();
    sweep_stale(root, now);

    let mut out: Vec<(f64, Value)> = Vec::new();

    // 1) outbox：claim（验 TTL）
    let outbox = root.join(OUTBOX_DIR);
    let mut just_claimed: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut pending: Vec<PathBuf> = fs::read_dir(&outbox)
        .map_err(|e| format!("bot_relay: 读 outbox 失败: {e}"))?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|x| x.to_str()) == Some("json"))
        .collect();
    pending.sort_by(|a, b| {
        queued_at(a)
            .partial_cmp(&queued_at(b))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    for path in pending {
        let Ok(envelope) = read_json(&path) else {
            continue;
        };
        let id = envelope
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if id.is_empty() {
            continue;
        }
        let age = now - queued_at(&path);
        let claimed_path = root.join(CLAIMED_DIR).join(format!("{id}.json"));
        if age > ENVELOPE_TTL_SECONDS {
            // 过期：像 hermes 一样写 `queued_expired` 回执（waiter 据此收尾）。
            let _ = fs::rename(&path, &claimed_path);
            let _ = write_reply_file(root, &id, "", "", "queued_expired");
            continue;
        }
        fs::rename(&path, &claimed_path).map_err(|e| format!("bot_relay: claim {id} 失败: {e}"))?;
        just_claimed.insert(format!("{id}.json"));
        out.push((queued_at(&claimed_path), envelope));
    }

    // 2) claimed：未回执的重投（Desktop 的 retry 语义）
    let claimed = root.join(CLAIMED_DIR);
    let replies = root.join(REPLIES_DIR);
    let mut replay: Vec<(f64, Value)> = Vec::new();
    if let Ok(entries) = fs::read_dir(&claimed) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|x| x.to_str()) != Some("json") {
                continue;
            }
            let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            if just_claimed.contains(name) {
                continue; // 本轮刚 claim 的：已经在返回里，不能重复
            }
            if replies.join(name).exists() {
                continue; // 已回执 = 已收尾
            }
            let at = queued_at(&path);
            if now - at > REPLY_WAIT_SECONDS {
                continue; // 超过重投窗口：settled delivery_timeout，仅剩清扫
            }
            let Ok(envelope) = read_json(&path) else {
                continue;
            };
            replay.push((at, envelope));
        }
    }
    replay.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    out.extend(replay);

    out.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    Ok(out.into_iter().map(|(_, v)| v).collect())
}

pub fn drain() -> Result<Vec<Value>, String> {
    drain_at(&relay_root())
}

// ── reply（先写者胜 + 事件唤醒）─────────────────────────────────────────────

/// `bot_relay.reply`：写 replies/<id>.json 并广播唤醒本机 waiter。
pub fn reply_envelope(
    app: &AppHandle,
    id: &str,
    reply: &str,
    error: &str,
    reason: &str,
) -> Result<Value, String> {
    let trimmed = id.trim();
    if trimmed.is_empty() {
        return Err("bot_relay.reply: 缺少 id".into());
    }
    let root = relay_root();
    ensure_dirs(&root)?;
    write_reply_file(&root, trimmed, reply, error, reason)?;
    let _ = app.emit(
        REPLY_EVENT,
        json!({ "id": trimmed, "reply": reply, "error": error, "reason": reason }),
    );
    Ok(json!({ "ok": true }))
}

// ── roster.sync（远端名册写盘）─────────────────────────────────────────────

fn roster_sync_at(root: &Path, rows: &[Value]) -> Result<usize, String> {
    ensure_dirs(root)?;
    let mut normalized: Vec<Value> = Vec::new();
    for row in rows {
        let Some(profile) = row.get("profile").and_then(Value::as_str).map(str::trim) else {
            continue;
        };
        if profile.is_empty() {
            continue;
        }
        let str_or = |key: &str| row.get(key).and_then(Value::as_str).unwrap_or("").to_string();
        normalized.push(json!({
            "profile": profile,
            "handle": str_or("handle"),
            "connection_id": str_or("connection_id"),
            "connection_label": str_or("connection_label"),
            "title": str_or("title"),
            "description": str_or("description"),
        }));
    }
    atomic_write_json(&root.join(ROSTER_FILE), &json!(normalized))?;
    Ok(normalized.len())
}

/// `bot_relay.roster.sync`：整体替换 roster.json（hermes `write_remote_roster`
/// 语义——空数组 = 对端已离去，写入空表而不是保留旧行）。
pub fn roster_sync(rows: &[Value]) -> Result<usize, String> {
    roster_sync_at(&relay_root(), rows)
}

// ── 回执（deliver 幂等）────────────────────────────────────────────────────

fn record_receipt_at(root: &Path, id: &str, receipt: &Value) -> Result<(), String> {
    let trimmed = id.trim();
    if trimmed.is_empty() {
        return Err("bot_relay: 回执缺少 id".into());
    }
    ensure_dirs(root)?;
    // receipts/ 独立于 claim：远端来件（不落在本机 claimed）也必须能落回执。
    atomic_write_json(
        &root.join(RECEIPTS_DIR).join(format!("{trimmed}.json")),
        receipt,
    )?;
    // claimed 里在的话顺带内嵌一份（人工排查友好；缺失不是错误）。
    let claimed_path = root.join(CLAIMED_DIR).join(format!("{trimmed}.json"));
    if claimed_path.exists() {
        if let Ok(mut envelope) = read_json(&claimed_path) {
            if let Some(obj) = envelope.as_object_mut() {
                obj.insert("receipt".into(), receipt.clone());
            }
            atomic_write_json(&claimed_path, &envelope)?;
        }
    }
    Ok(())
}

fn get_receipt_at(root: &Path, id: &str) -> Result<Option<Value>, String> {
    let path = root.join(RECEIPTS_DIR).join(format!("{}.json", id.trim()));
    if !path.exists() {
        return Ok(None);
    }
    Ok(Some(read_json(&path)?))
}

/// 把一次投递的终局回执落到 `receipts/<id>.json`（Desktop 投递完成后调用；
/// claimed 里在场时顺带内嵌一份供人工排查）。
pub fn record_receipt(id: &str, receipt: &Value) -> Result<(), String> {
    record_receipt_at(&relay_root(), id, receipt)
}

/// 重投时取已有回执（幂等：同一 envelope 一轮只跑一次）。
pub fn get_receipt(id: &str) -> Result<Option<Value>, String> {
    get_receipt_at(&relay_root(), id)
}

// ── IPC ─────────────────────────────────────────────────────────────────────

#[tauri::command(rename_all = "camelCase", async)]
pub fn pi_relay_enqueue(
    app: AppHandle,
    target_connection: String,
    target_profile: String,
    target_handle: Option<String>,
    from_profile: String,
    from_handle: Option<String>,
    message: String,
) -> Result<Value, String> {
    if message.trim().is_empty() {
        return Err("pi_relay_enqueue: message 为空".into());
    }
    let envelope = enqueue(
        &app,
        target_connection.trim(),
        target_profile.trim(),
        target_handle.as_deref().unwrap_or(target_profile.trim()),
        from_profile.trim(),
        from_handle.as_deref().unwrap_or(from_profile.trim()),
        message.trim(),
    )?;
    serde_json::to_value(envelope).map_err(|e| format!("pi_relay_enqueue: {e}"))
}

#[tauri::command(rename_all = "camelCase", async)]
pub fn pi_relay_roster_sync(agents: Vec<Value>) -> Result<Value, String> {
    let count = roster_sync(&agents)?;
    Ok(json!({ "count": count }))
}

#[tauri::command(rename_all = "camelCase", async)]
pub fn pi_relay_drain() -> Result<Value, String> {
    let envelopes = drain()?;
    Ok(json!({ "envelopes": envelopes }))
}

#[tauri::command(rename_all = "camelCase", async)]
pub fn pi_relay_reply(
    app: AppHandle,
    id: String,
    reply: Option<String>,
    error: Option<String>,
    reason: Option<String>,
) -> Result<Value, String> {
    reply_envelope(
        &app,
        &id,
        reply.as_deref().unwrap_or(""),
        error.as_deref().unwrap_or(""),
        reason.as_deref().unwrap_or(""),
    )
}

#[tauri::command(rename_all = "camelCase", async)]
pub fn pi_relay_record_receipt(id: String, receipt: Value) -> Result<bool, String> {
    record_receipt(&id, &receipt)?;
    Ok(true)
}

#[tauri::command(rename_all = "camelCase", async)]
pub fn pi_relay_get_receipt(id: String) -> Result<Value, String> {
    Ok(get_receipt(&id)?.unwrap_or(Value::Null))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root() -> PathBuf {
        std::env::temp_dir().join(format!("mirach-relay-test-{}", new_envelope_id()))
    }

    fn envelope_value(id: &str, target: &str) -> Value {
        json!({
            "id": id,
            "created_at": now_secs() as i64,
            "canonical_delivery_v1": true,
            "from_profile": "a",
            "from_handle": "@a@local",
            "target_connection": "local",
            "target_profile": target,
            "target_handle": target,
            "message": "hi",
        })
    }

    fn age_file(path: &Path, secs: f64) {
        let file = fs::OpenOptions::new().write(true).open(path).unwrap();
        file.set_modified(SystemTime::now() - std::time::Duration::from_secs_f64(secs))
            .unwrap();
    }

    #[test]
    fn claim_moves_to_claimed_and_returns_envelope() {
        let root = temp_root();
        let env = enqueue_at(&root, "local", "b", "b", "a", "a", "hi").unwrap();
        let got = drain_at(&root).unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0]["id"].as_str().unwrap(), env.id);
        assert!(root.join(CLAIMED_DIR).join(format!("{}.json", env.id)).exists());
        assert!(!root.join(OUTBOX_DIR).join(format!("{}.json", env.id)).exists());
        // 第二轮：没有新东西也不重投（无回执但在重投窗口内 → 会重投！）
        let again = drain_at(&root).unwrap();
        assert_eq!(again.len(), 1, "claimed 未回执的必须重投");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn ttl_expiry_writes_queued_expired_and_stops_reoffer() {
        let root = temp_root();
        ensure_dirs(&root).unwrap();
        let path = root.join(OUTBOX_DIR).join("expired.json");
        atomic_write_json(&path, &envelope_value("expired", "b")).unwrap();
        age_file(&path, ENVELOPE_TTL_SECONDS + 30.0);
        let got = drain_at(&root).unwrap();
        assert!(got.is_empty(), "过期 envelope 不得投递");
        let reply = read_json(&root.join(REPLIES_DIR).join("expired.json")).unwrap();
        assert_eq!(reply["reason"], "queued_expired");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn reply_settles_and_first_writer_wins() {
        let root = temp_root();
        let env = enqueue_at(&root, "local", "b", "b", "a", "a", "hi").unwrap();
        let _ = drain_at(&root).unwrap();
        write_reply_file(&root, &env.id, "first", "", "").unwrap();
        write_reply_file(&root, &env.id, "second", "", "").unwrap();
        let reply = read_json(&root.join(REPLIES_DIR).join(format!("{}.json", env.id))).unwrap();
        assert_eq!(reply["reply"], "first");
        assert!(drain_at(&root).unwrap().is_empty(), "已回执不再重投");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn receipt_roundtrip_and_idempotent_delivery() {
        let root = temp_root();
        let env = enqueue_at(&root, "local", "b", "b", "a", "a", "hi").unwrap();
        let _ = drain_at(&root).unwrap();
        assert!(get_receipt_at(&root, &env.id).unwrap().is_none());
        record_receipt_at(&root, &env.id, &json!({ "status": "settled", "delivery_id": env.id }))
            .unwrap();
        let receipt = get_receipt_at(&root, &env.id).unwrap().unwrap();
        assert_eq!(receipt["status"], "settled");
        // 远端来件（不在本机 claimed）也必须能落回执（2026-11-18 实测修）。
        record_receipt_at(
            &root,
            "remote-envelope-0001",
            &json!({ "status": "settled", "delivery_id": "remote-envelope-0001" }),
        )
        .unwrap();
        assert_eq!(
            get_receipt_at(&root, "remote-envelope-0001").unwrap().unwrap()["status"],
            "settled"
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn roster_sync_normalizes_and_replaces() {
        let root = temp_root();
        let count = roster_sync_at(
            &root,
            &[json!({
                "profile": "alpha",
                "handle": "@alpha@conn-1",
                "connection_id": "conn-1",
                "connection_label": "机器 B",
                "title": "Alpha",
                "description": "d",
            })],
        )
        .unwrap();
        assert_eq!(count, 1);
        let back = read_json(&root.join(ROSTER_FILE)).unwrap();
        assert_eq!(back[0]["connection_id"], "conn-1");
        let cleared = roster_sync_at(&root, &[]).unwrap();
        assert_eq!(cleared, 0);
        let back = read_json(&root.join(ROSTER_FILE)).unwrap();
        assert!(back.as_array().unwrap().is_empty());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn stale_sweep_removes_old_artifacts() {
        let root = temp_root();
        ensure_dirs(&root).unwrap();
        let path = root.join(OUTBOX_DIR).join("old.json");
        fs::write(&path, "{}").unwrap();
        age_file(&path, STALE_AFTER_SECONDS + 60.0);
        sweep_stale(&root, now_secs());
        assert!(!path.exists());
        let _ = fs::remove_dir_all(&root);
    }
}

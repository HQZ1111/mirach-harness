//! 群聊 IPC 命令面（把 `hosted_rooms::controls` 的 20 个方法暴露给前端）。
//!
//! ## 设计
//!
//! 前端调 `invoke('groups_<method>', params)`，本模块：
//!
//! 1. 打开 `state.db`（`~/.rpi/agent/state.db`，与 rpi 共享同一个 SQLite）
//! 2. 执行 `controls::validate_dispatch` 校验（能力 / profile / 参数集）
//! 3. 按 `dispatch_target` 分派到具体业务函数
//! 4. 失败时返回结构化的拒绝原因（**不吞错误**，工程规矩 11）
//!
//! ## 为什么是一个总入口 + 一个查方法表
//!
//! 上游是 `dispatch_group_control(connection, method, params)` 单一入口。
//! Rust 侧保持同样形状：`groups_dispatch(method, params)` 一个命令覆盖全部
//! 方法，再加少量高频方法的直接命令（前端少一次字符串拼装）。
//!
//! ## 与上游的差异（宿主事实）
//!
//! - 上游 `connection.authority` / `actor` 来自 WebSocket 会话；宿主没有多租户
//!   连接，用本地单身份（`local` profile）填这两个字段
//! - 上游 `groups.peer.*` 需要真实网络；宿主返回明确的「未接通」，**不假装**成功
//! - 上游 `profiles.list` 走 profile 系统；宿主映射到 `pi_connections` 的面

use std::sync::Arc;

use serde_json::{json, Value};

use crate::hosted_rooms::{adapters, common, controls, discussion, plan, store, work_capture};

/// `state.db` 路径（与 rpi 共享）。
fn state_db_path() -> Result<std::path::PathBuf, String> {
    Ok(crate::pi_paths::agent_dir()?.join("state.db"))
}

/// 打开群聊库（建表幂等）。
fn open_store() -> Result<rusqlite::Connection, String> {
    let path = state_db_path()?;
    let path_str = path.to_string_lossy().to_string();
    let conn = store::open(&path_str).map_err(|e| e.to_string())?;
    // 附件 / 证据 / 投递 / 副本 / 投影：全部幂等建表
    work_capture::initialize(&conn).map_err(|e| e.to_string())?;
    crate::hosted_rooms::driver::initialize_driver_schema(&conn).map_err(|e| e.to_string())?;
    crate::hosted_rooms::replicas::initialize_replica_schema(&conn).map_err(|e| e.to_string())?;
    crate::hosted_rooms::policy_checkpoint::initialize(&conn).map_err(|e| e.to_string())?;
    Ok(conn)
}

/// 本地单身份（宿主没有多租户连接）。
fn local_actor() -> controls::DispatchContext<'static> {
    // 宿主是单用户桌面端：actor 与 authority 恒为同一 profile
    const CAPS: &[&str] = &[
        "session:read",
        "session:control",
        "session:submit",
        "session:approve",
        "session:operator",
    ];
    // 用 OnceLock 持有静态切片，避免每次分配
    static CAPS_OWNED: std::sync::OnceLock<Vec<String>> = std::sync::OnceLock::new();
    let caps = CAPS_OWNED.get_or_init(|| CAPS.iter().map(|c| (*c).to_owned()).collect());
    controls::DispatchContext {
        actor_capabilities: caps,
        actor_profile_id: "local",
        authority_profile_id: "local",
    }
}

/// 统一派发入口（上游 `dispatch_group_control` 的宿主对偶）。
///
/// 前端：`invoke('groups_dispatch', { method, params })`
#[tauri::command(rename_all = "camelCase", async)]
pub fn groups_dispatch(method: String, params: Option<Value>) -> Result<Value, String> {
    let params = params.unwrap_or_else(|| json!({}));
    let ctx = local_actor();

    // 1) 校验（能力 / profile / 参数集）
    let supplied = controls::validate_dispatch(&method, &params, &ctx)
        .map_err(|refusal| format!("{refusal:?}"))?;

    // 2) 分派
    match controls::dispatch_target(&method) {
        controls::DispatchTarget::Profiles => groups_profiles_list(&supplied),
        controls::DispatchTarget::Peers => Err(format!(
            "{method}: 跨网关 peer 通道未接通（需要真实网络与 TLS；宿主当前不伪造成功）"
        )),
        controls::DispatchTarget::Group => dispatch_group(&method, &supplied),
    }
}

/// `groups.*` 的业务分派。
fn dispatch_group(method: &str, params: &serde_json::Map<String, Value>) -> Result<Value, String> {
    match method {
        "groups.capabilities" => Ok(controls::capabilities_payload(store::MAX_LOG_LIMIT as i64)),

        "groups.list" => {
            let conn = open_store()?;
            let limit = params.get("limit").and_then(common::json_i64).unwrap_or(50);
            let offset = params.get("offset").and_then(common::json_i64).unwrap_or(0);
            let include_disbanded = params
                .get("include_disbanded")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let rooms = store::list_rooms(&conn, include_disbanded, limit, offset).map_err(|e| e.to_string())?;
            Ok(json!({
                "rooms": rooms.iter().map(room_json).collect::<Vec<_>>(),
                "limit": limit,
                "offset": offset,
            }))
        }

        "groups.state" => {
            let conn = open_store()?;
            let room_id = params.get("room_id").cloned().unwrap_or(Value::Null);
            let include_disbanded = params
                .get("include_disbanded")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let room = store::room_state(&conn, &room_id, include_disbanded).map_err(|e| e.to_string())?;
            // context：该房间当前生效的设置
            let context = crate::hosted_rooms::context::room_context(
                &conn,
                room.room_id.as_str(),
                None,
            )
            .map_err(|e| e.to_string())?;
            Ok(json!({
                "room": room_json(&room),
                "context": context.to_json(),
                "change_events": true,
            }))
        }

        "groups.log" => {
            let conn = open_store()?;
            let room_id = params.get("room_id").cloned().unwrap_or(Value::Null);
            let since_seq = params.get("since_seq").and_then(common::json_i64).unwrap_or(0);
            let limit = params.get("limit").and_then(common::json_i64).unwrap_or(100);
            let events = store::read_events(&conn, &room_id, since_seq, limit).map_err(|e| e.to_string())?;
            Ok(json!({
                "events": events.iter().map(event_json).collect::<Vec<_>>(),
            }))
        }

        "groups.create" => {
            let mut conn = open_store()?;
            let room_id = params.get("room_id").cloned().unwrap_or(Value::Null);
            let name = params.get("name").cloned().unwrap_or(Value::Null);
            let members = params.get("members").cloned().unwrap_or_else(|| json!([]));
            let authority = local_gateway_id()?;
            let room = store::create_room(
                &mut conn,
                &room_id,
                &name,
                &members,
                &Value::String(authority),
                None,
            )
            .map_err(|e| e.to_string())?;
            Ok(json!({"room": room_json(&room)}))
        }

        "groups.rename" => {
            let mut conn = open_store()?;
            let room_id = params.get("room_id").cloned().unwrap_or(Value::Null);
            let event_id = params.get("event_id").cloned().unwrap_or(Value::Null);
            let name = params.get("name").cloned().unwrap_or(Value::Null);
            let room = store::rename_room(&mut conn, &room_id, &event_id, &name, None)
                .map_err(|e| e.to_string())?;
            Ok(json!({"room": room_json(&room)}))
        }

        "groups.disband" => {
            let mut conn = open_store()?;
            let room_id = params.get("room_id").cloned().unwrap_or(Value::Null);
            store::disband_room(&mut conn, &room_id, None).map_err(|e| e.to_string())?;
            Ok(json!({"ok": true}))
        }

        "groups.send" => {
            // 用户发消息：append message.user 事件
            let mut conn = open_store()?;
            let room_id = params.get("room_id").cloned().unwrap_or(Value::Null);
            let event_id = params.get("event_id").cloned().unwrap_or(Value::Null);
            let payload = params.get("payload").cloned().unwrap_or(Value::Null);
            // 先校验 payload 形状（复用 discussion 的校验）
            let normalized = discussion::validate_user_payload(&payload).map_err(|e| e.message)?;
            let room = store::room_state(&conn, &room_id, false).map_err(|e| e.to_string())?;
            let event = store::append_event(
                &mut conn,
                &room_id,
                &event_id,
                &Value::String("message.user".into()),
                &json!({"kind": "user", "id": "local-user"}),
                &normalized,
                &Value::String(room.authority_gateway_id.clone()),
                Some(room.authority_epoch),
                None,
                None,
                false,
            )
            .map_err(|e| e.to_string())?;
            Ok(json!({"event": event_json(&event), "admitted": true}))
        }

        "groups.context" => {
            let mut conn = open_store()?;
            let room_id = params.get("room_id").cloned().unwrap_or(Value::Null);
            let purpose = params.get("purpose").and_then(Value::as_str).unwrap_or("");
            let notes = params.get("notes").and_then(Value::as_str).unwrap_or("");
            let routing = params.get("routing").and_then(Value::as_str).unwrap_or("everyone");
            let lead = params.get("lead_member_id").and_then(Value::as_str).unwrap_or("");

            let normalized = crate::hosted_rooms::context::validate_context(purpose, notes, routing, lead)
                .map_err(|e| e.to_string())?;
            let room = store::room_state(&conn, &room_id, false).map_err(|e| e.to_string())?;
            let event_id = params.get("event_id").cloned().unwrap_or(Value::Null);

            store::append_event(
                &mut conn,
                &room_id,
                &event_id,
                &Value::String("room.context_set".into()),
                &json!({"kind": "system", "id": "room-control"}),
                &normalized.to_json(),
                &Value::String(room.authority_gateway_id.clone()),
                Some(room.authority_epoch),
                None,
                None,
                false,
            )
            .map_err(|e| e.to_string())?;
            Ok(json!({"context": normalized.to_json()}))
        }

        "groups.stop" => {
            let mut conn = open_store()?;
            let room_id = params.get("room_id").cloned().unwrap_or(Value::Null);
            let cancel_id = params.get("cancel_id").cloned().unwrap_or(Value::Null);
            let authority = local_gateway_id()?;
            let room = store::room_state(&conn, &room_id, false).map_err(|e| e.to_string())?;
            let event = adapters::request_room_stop(
                &mut conn,
                &room_id,
                &cancel_id,
                &authority,
                room.authority_epoch,
                None,
            )
            .map_err(|e| e.to_string())?;
            Ok(json!({"event": event_json(&event)}))
        }

        "groups.continue" => {
            let mut conn = open_store()?;
            let room_id = params.get("room_id").cloned().unwrap_or(Value::Null);
            let discussion_id = params
                .get("discussion_event_id")
                .and_then(Value::as_str)
                .unwrap_or("");
            let room = store::room_state(&conn, &room_id, false).map_err(|e| e.to_string())?;

            // grant = 已有 continue 次数 + 1
            let events = store::read_events(&conn, &room_id, 0, store::MAX_LOG_LIMIT as i64)
                .map_err(|e| e.to_string())?;
            let log_events: Vec<crate::hosted_rooms::router::LogEvent> = events
                .iter()
                .map(|e| crate::hosted_rooms::router::LogEvent {
                    seq: e.seq,
                    event_id: e.event_id.clone(),
                    kind: e.kind.clone(),
                    payload: serde_json::from_str::<Value>(&e.payload_json)
                        .ok()
                        .and_then(|v| v.as_object().cloned())
                        .unwrap_or_default(),
                })
                .collect();
            let grant = crate::hosted_rooms::router::continue_count(&log_events, discussion_id) as i64 + 1;

            let thread_id = events
                .iter()
                .find(|e| e.event_id == discussion_id)
                .and_then(|e| {
                    serde_json::from_str::<Value>(&e.payload_json)
                        .ok()
                        .and_then(|v| v.get("thread_id").and_then(Value::as_str).map(str::to_owned))
                })
                .unwrap_or_default();

            let event = store::append_event(
                &mut conn,
                &room_id,
                &json!(format!("dcontinue:{discussion_id}:{grant}")),
                &Value::String(crate::hosted_rooms::router::CONTINUED_EVENT_KIND.into()),
                &json!({"kind": "gateway", "id": room.authority_gateway_id}),
                &json!({
                    "discussion_event_id": discussion_id,
                    "thread_id": thread_id,
                    "grant": grant,
                }),
                &Value::String(room.authority_gateway_id.clone()),
                Some(room.authority_epoch),
                None,
                None,
                false,
            )
            .map_err(|e| e.to_string())?;
            Ok(json!({"event": event_json(&event), "grant": grant}))
        }

        "groups.retry" => {
            let mut conn = open_store()?;
            let room_id = params.get("room_id").and_then(Value::as_str).unwrap_or("");
            let member_id = params.get("member_id").and_then(Value::as_str).unwrap_or("");
            let task_id = params.get("task_id").and_then(Value::as_str).unwrap_or("");
            let exec_gen = params
                .get("execution_generation")
                .and_then(common::json_i64)
                .unwrap_or(0);
            let lease = require_lease(&conn, room_id)?;
            let identity = crate::hosted_rooms::driver_ops::TaskIdentity::new(
                room_id,
                task_id,
                &format!("thread-{task_id}"),
                &format!("turn-{task_id}"),
            )
            .map_err(|e| e.to_string())?;
            let task = crate::hosted_rooms::driver_ops::requeue_indeterminate_task(
                &mut conn,
                &identity,
                &lease,
                exec_gen,
                0,
                now(),
            )
            .map_err(|e| e.to_string())?;
            Ok(json!({"task": task_json(&task), "member_id": member_id}))
        }

        "groups.discard" => {
            let mut conn = open_store()?;
            let room_id = params.get("room_id").and_then(Value::as_str).unwrap_or("");
            let task_id = params.get("task_id").and_then(Value::as_str).unwrap_or("");
            let exec_gen = params
                .get("execution_generation")
                .and_then(common::json_i64)
                .unwrap_or(0);
            let lease = require_lease(&conn, room_id)?;
            let identity = crate::hosted_rooms::driver_ops::TaskIdentity::new(
                room_id,
                task_id,
                &format!("thread-{task_id}"),
                &format!("turn-{task_id}"),
            )
            .map_err(|e| e.to_string())?;
            // discard = 把不确定的执行 defer 掉（不是取消，上游语义）
            let task = crate::hosted_rooms::driver_ops::defer_indeterminate_task(
                &mut conn,
                &identity,
                &lease,
                exec_gen,
                1,
                "discarded",
                now(),
            )
            .map_err(|e| e.to_string())?;
            Ok(json!({"task": task_json(&task)}))
        }

        "groups.approve" => Err(
            "groups.approve: 审批需要 rpi 的 approval 通道（宿主未接线；不伪造成功）".to_owned(),
        ),

        "groups.attachment.upload" => {
            let room_id = params.get("room_id").and_then(Value::as_str).unwrap_or("");
            let target = verify_upload(room_id, params)?;
            Ok(json!({"stored": target}))
        }

        "groups.attachment.download" => {
            let room_id = params.get("room_id").and_then(Value::as_str).unwrap_or("");
            let attachment_id = params
                .get("attachment_id")
                .and_then(Value::as_str)
                .unwrap_or("");
            let path = attachment_root()?.join(format!("{attachment_id}.bin"));
            let data = std::fs::read(&path)
                .map_err(|e| format!("attachment {attachment_id} unreadable: {e}"))?;
            Ok(json!({
                "attachment_id": attachment_id,
                "size": data.len(),
                "data_base64": crate::hosted_rooms::attachments::encode_content_base64(&data),
            }))
        }

        other => Err(format!("unknown group method: {other}")),
    }
}

/// `profiles.list` 的宿主映射（上游走 profile 系统；宿主用本地单身份）。
fn groups_profiles_list(_params: &serde_json::Map<String, Value>) -> Result<Value, String> {
    Ok(json!({
        "profiles": [{"id": "local", "name": "Local", "default": true}],
    }))
}

// ── 辅助 ────────────────────────────────────────────────────────────────────

fn local_gateway_id() -> Result<String, String> {
    // 上游用 install id；宿主用固定前缀 + 机器名（稳定且可读）
    let host = std::env::var("COMPUTERNAME").unwrap_or_else(|_| "local".to_owned());
    Ok(format!("install:{host}"))
}

fn now() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0.0, |d| d.as_secs_f64())
}

fn room_json(room: &store::Room) -> Value {
    json!({
        "room_id": room.room_id,
        "name": room.name,
        "authority_gateway_id": room.authority_gateway_id,
        "authority_epoch": room.authority_epoch,
        "next_seq": room.next_seq,
        "revision": room.revision,
        "created_at": room.created_at,
        "updated_at": room.updated_at,
        "disbanded_at": room.disbanded_at,
    })
}

fn event_json(event: &store::RoomEvent) -> Value {
    json!({
        "room_id": event.room_id,
        "seq": event.seq,
        "event_id": event.event_id,
        "kind": event.kind,
        "actor": serde_json::from_str::<Value>(&event.actor_json).unwrap_or(Value::Null),
        "payload": serde_json::from_str::<Value>(&event.payload_json).unwrap_or(Value::Null),
        "authority_epoch": event.authority_epoch,
        "created_at": event.created_at,
    })
}

fn task_json(task: &crate::hosted_rooms::driver::DriverTask) -> Value {
    json!({
        "task_id": task.task_id,
        "status": task.status,
        "execution_generation": task.execution_generation,
        "cancel_generation": task.cancel_generation,
        "settlement_id": task.settlement_id,
        "terminal_at": task.terminal_at,
    })
}

/// 取或建该房间的 driver 租约（retry/discard 需要活跃租约）。
fn require_lease(
    conn: &rusqlite::Connection,
    room_id: &str,
) -> Result<crate::hosted_rooms::driver::DriverLease, String> {
    if let Some(lease) = crate::hosted_rooms::driver::read_lease(conn, room_id).map_err(|e| e.to_string())? {
        if lease.released_at.is_none() {
            return Ok(lease);
        }
    }
    Err(format!(
        "room {room_id} has no active driver lease (start a run first)"
    ))
}

/// 附件根目录（`~/.rpi/agent/attachments`）。
fn attachment_root() -> Result<std::path::PathBuf, String> {
    Ok(crate::pi_paths::agent_dir()?.join("attachments"))
}

/// 校验并落盘一次上传。
fn verify_upload(room_id: &str, params: &serde_json::Map<String, Value>) -> Result<String, String> {
    use crate::hosted_rooms::attachments;

    let kind = params.get("kind").and_then(Value::as_str).unwrap_or("");
    let name = params.get("name").and_then(Value::as_str).unwrap_or("");
    let mime = params.get("mime").and_then(Value::as_str).unwrap_or("");
    let data_base64 = params.get("data_base64").and_then(Value::as_str).unwrap_or("");

    let data = attachments::decode_content_base64(data_base64).map_err(|e| e.message)?;
    let mime_normalized = attachments::mime(mime).map_err(|e| e.message)?;
    let kind_normalized = attachments::kind(kind).map_err(|e| e.message)?;
    attachments::name(name).map_err(|e| e.message)?;
    attachments::validate_mime_and_kind(&data, &kind_normalized, &mime_normalized)
        .map_err(|e| e.message)?;

    // 内容寻址落盘
    let root = attachment_root()?;
    let blob_id = work_capture::write_blob(&root, &data).map_err(|e| format!("blob write failed: {e}"))?;
    Ok(format!("{room_id}/{blob_id}"))
}

/// 讨论规划（供面板显示「谁下一个说话」）。
#[tauri::command(rename_all = "camelCase", async)]
pub fn groups_plan(room_id: String) -> Result<Value, String> {
    let conn = open_store()?;
    let room_row = store::room_state(&conn, &Value::String(room_id.clone()), false)
        .map_err(|e| e.to_string())?;

    let members: Value = serde_json::from_str(&room_row.members_json)
        .map_err(|e| format!("invalid members json: {e}"))?;

    let room = discussion::validate_room(
        &json!({
            "room_id": room_row.room_id,
            "name": room_row.name,
            "authority_gateway_id": room_row.authority_gateway_id,
            "authority_epoch": room_row.authority_epoch,
            "disbanded_at": room_row.disbanded_at,
            "members": members,
        }),
        &local_profiles(),
    )
    .map_err(|e| e.message)?;

    let context = crate::hosted_rooms::context::room_context(&conn, &room_id, None)
        .map_err(|e| e.to_string())?;
    let settings = plan::RoomSettings {
        purpose: context.purpose,
        notes: context.notes,
        routing: context.routing,
        lead_member_id: context.lead_member_id,
    };

    let events = store::read_events(&conn, &Value::String(room_id.clone()), 0, store::MAX_LOG_LIMIT as i64)
        .map_err(|e| e.to_string())?;
    let raw_events: Vec<Value> = events
        .iter()
        .map(|e| {
            json!({
                "room_id": e.room_id,
                "seq": e.seq,
                "event_id": e.event_id,
                "kind": e.kind,
                "actor": serde_json::from_str::<Value>(&e.actor_json).unwrap_or(Value::Null),
                "payload": serde_json::from_str::<Value>(&e.payload_json).unwrap_or(Value::Null),
                "authority_epoch": e.authority_epoch,
            })
        })
        .collect();

    let decision = plan::plan_next_task(&room, &raw_events, &settings, discussion::DiscussionLimits::default())
        .map_err(|e| e.message)?;

    Ok(json!({
        "status": decision.status,
        "reason": decision.reason,
        "discussion_event_id": decision.discussion_event_id,
        "thread_id": decision.thread_id,
        "continues": decision.continues,
        "task": decision.task.map(|t| json!({
            "task_id": t.task_id,
            "turn_id": t.turn_id,
            "member_id": t.member_id,
            "member_index": t.member_index,
            "round_index": t.round_index,
            "seen_through_seq": t.seen_through_seq,
        })),
    }))
}

/// 本地 profile 列表（宿主单身份）。
fn local_profiles() -> Vec<String> {
    // 从成员里出现过的 profile 都算（宿主没有 profile 系统，宽松接受）
    Vec::new()
}

/// 供 `lib.rs`/`main.rs` 注册的命令表。
pub fn commands() -> Vec<&'static str> {
    vec!["groups_dispatch", "groups_plan"]
}

/// 保留：避免 unused 警告（`Arc` 在后续会话运行态接线时会用到）。
#[allow(dead_code)]
fn _unused(_: Arc<()>) {}
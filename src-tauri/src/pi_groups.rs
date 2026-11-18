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
pub fn groups_dispatch(
    app: tauri::AppHandle,
    method: String,
    params: Option<Value>,
) -> Result<Value, String> {
    use tauri::Emitter;
    let params = params.unwrap_or_else(|| json!({}));
    let ctx = local_actor();

    // 1) 校验（能力 / profile / 参数集）
    let supplied = controls::validate_dispatch(&method, &params, &ctx)
        .map_err(|refusal| format!("{refusal:?}"))?;

    // 2) 分派
    let result = match controls::dispatch_target(&method) {
        controls::DispatchTarget::Profiles => groups_profiles_list(&supplied),
        // 2026-11-18：authority 侧的 peer 成员台账真落地（Desktop 驱动模式）；
        // 本机作为 lending 网关的 invite/RoomLink 仍需对外 HTTP 服务端，不伪造。
        controls::DispatchTarget::Peers => match method.as_str() {
            "groups.peer.register" | "groups.peer.revoke" => dispatch_peer(&method, &supplied),
            _ => Err(format!(
                "{method}: 跨网关 peer 通道未接通（本机不提供 RoomLink 服务端；authority 侧 register/revoke 已支持）"
            )),
        },
        controls::DispatchTarget::Group => dispatch_group(&method, &supplied),
    };

    // 3) `groups.changed` 生产者（hermes 网关 change_watcher 的同款推送）：
    //    变更类方法成功后广播 room_id，workspace 的 push 分支即刷（此前恒
    //    依赖 2s 轮询）。只对**成功**的变更发；读取类不发。
    let is_mutation = matches!(
        method.as_str(),
        "groups.create"
            | "groups.rename"
            | "groups.disband"
            | "groups.send"
            | "groups.context"
            | "groups.stop"
            | "groups.continue"
            | "groups.retry"
            | "groups.discard"
            | "groups.driver_append"
    ) || method.starts_with("groups.attachment.");
    if result.is_ok() && is_mutation {
        let room_id = params
            .get("room_id")
            .or_else(|| params.get("event").and_then(|e| e.get("room_id")))
            .cloned()
            .unwrap_or(Value::Null);
        let _ = app.emit("mirach:plugin:groups:changed", json!({ "room_id": room_id }));
    }

    result
}

// ── groups.peer.*（2026-11-18：authority 侧真落地，Desktop 驱动模式）─────────
//
// 宿主实现的是 **Desktop 驱动** peer 模式：成员轮次由前端 canonical driver 经
// WS（pi_gateway_call → prompt.submit）送到对端；RoomLink HTTP 的自治通道不做
// （那需要本机对外 HTTP 服务端）。register = 校验房间成员 pinned 值
// （installation_id / capability_digest / profile）与对端邀请回来的 catalog 一致，
// 把 link（target_url/grant）持久化；revoke = 按 grant 删除。invite = 本机作为
// lending 网关需要 RoomLink 服务端（没有），明确报错。

fn room_links_path() -> Result<std::path::PathBuf, String> {
    Ok(crate::pi_paths::agent_dir()?.join("room-links.json"))
}

fn read_room_links() -> Result<Vec<Value>, String> {
    let path = room_links_path()?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let text = std::fs::read_to_string(&path)
        .map_err(|e| format!("room-links 读取失败 {}: {e}", path.display()))?;
    if text.trim().is_empty() {
        return Ok(Vec::new());
    }
    serde_json::from_str(&text).map_err(|e| format!("room-links 解析失败: {e}"))
}

fn write_room_links(links: &[Value]) -> Result<(), String> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static WRITE_SEQ: AtomicU64 = AtomicU64::new(1);
    let path = room_links_path()?;
    let text = serde_json::to_string_pretty(links).map_err(|e| e.to_string())?;
    // 并发 seat（多个 peer 成员同时 register）不得共用同一个 .tmp——固定名会
    // 让后者的 rename 撞上已被前一个 rename 走的源文件（实测：第二个成员
    // registration_unconfirmed）。
    let tmp = path.with_extension(format!(
        "json.{}.{}.tmp",
        std::process::id(),
        WRITE_SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::write(&tmp, text).map_err(|e| format!("room-links 写入失败: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("room-links 替换失败: {e}"))
}

/// 进程内串行化 room-links 的读-改-写（并发 seat 不能丢更新）。
fn room_links_guard() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: std::sync::OnceLock<std::sync::Mutex<()>> = std::sync::OnceLock::new();
    LOCK.get_or_init(|| std::sync::Mutex::new(()))
        .lock()
        .expect("room-links lock poisoned")
}

fn dispatch_peer(method: &str, params: &serde_json::Map<String, Value>) -> Result<Value, String> {
    match method {
        "groups.peer.register" => {
            let conn = open_store()?;
            let text_field = |key: &str| -> String {
                params
                    .get(key)
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim()
                    .to_string()
            };
            let room_id = text_field("room_id");
            let member_id = text_field("member_id");
            let target_url = text_field("target_url");
            let target_profile = text_field("target_profile");
            let grant = text_field("grant");
            let catalog = params.get("catalog").cloned().unwrap_or(Value::Null);
            if room_id.is_empty()
                || member_id.is_empty()
                || grant.is_empty()
                || target_profile.is_empty()
            {
                return Err(
                    "groups.peer.register 缺少 room_id/member_id/grant/target_profile".into(),
                );
            }
            let parsed = reqwest::Url::parse(&target_url)
                .map_err(|e| format!("groups.peer.register target_url 非法: {e}"))?;
            let scheme = parsed.scheme();
            if scheme != "http" && scheme != "https" {
                return Err("groups.peer.register target_url 必须是 http(s)".into());
            }
            let host = parsed.host_str().unwrap_or("");
            let loopback = matches!(host, "127.0.0.1" | "localhost" | "::1");
            if scheme == "http" && !loopback {
                return Err(
                    "groups.peer.register 拒绝非回环的明文 target_url（须 https）".into(),
                );
            }

            let room = store::room_state(&conn, &Value::String(room_id.clone()), false)
                .map_err(|e| e.to_string())?;
            let members: Value =
                serde_json::from_str(&room.members_json).map_err(|e| e.to_string())?;
            let member = members
                .as_array()
                .and_then(|rows| {
                    rows.iter().find(|row| {
                        row.get("member_id").and_then(Value::as_str) == Some(member_id.as_str())
                    })
                })
                .cloned()
                .ok_or_else(|| format!("groups.peer.register: 房间里没有成员 {member_id}"))?;
            let target = member.get("target").cloned().unwrap_or(Value::Null);
            if target.get("kind").and_then(Value::as_str) != Some("peer") {
                return Err("groups.peer.register: 该成员不是 peer 目标".into());
            }
            let installation_id = target
                .get("installation_id")
                .and_then(Value::as_str)
                .unwrap_or("");
            let digest = target
                .get("capability_digest")
                .and_then(Value::as_str)
                .unwrap_or("");
            if catalog.get("installation_id").and_then(Value::as_str) != Some(installation_id) {
                return Err(
                    "groups.peer.register: catalog.installation_id 与成员 pinned 值不一致".into(),
                );
            }
            if catalog.get("catalog_digest").and_then(Value::as_str) != Some(digest) {
                return Err("groups.peer.register: catalog_digest 与成员 pinned 值不一致".into());
            }
            if member.get("profile").and_then(Value::as_str) != Some(target_profile.as_str()) {
                return Err("groups.peer.register: target_profile 与成员 profile 不一致".into());
            }

            let _guard = room_links_guard();
            let mut links = read_room_links()?;
            links.retain(|row| {
                !(row.get("room_id").and_then(Value::as_str) == Some(room_id.as_str())
                    && row.get("member_id").and_then(Value::as_str) == Some(member_id.as_str()))
            });
            links.push(json!({
                "room_id": room_id,
                "member_id": member_id,
                "target_url": target_url,
                "target_profile": target_profile,
                "grant": grant,
                "installation_id": installation_id,
                "capability_digest": digest,
                "registered_at": std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs())
                    .unwrap_or_default(),
                "status": "registered",
            }));
            write_room_links(&links)?;
            Ok(json!({
                "registered": true,
                "mode": "desktop",
                "transport_security": if scheme == "https" { "tls" } else { "loopback" },
                "target_install_id": installation_id,
                "target_profile": target_profile,
            }))
        }
        "groups.peer.revoke" => {
            let grant = params
                .get("grant")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim();
            if grant.is_empty() {
                return Err("groups.peer.revoke 缺少 grant".into());
            }
            let _guard = room_links_guard();
            let mut links = read_room_links()?;
            let before = links.len();
            links.retain(|row| row.get("grant").and_then(Value::as_str) != Some(grant));
            write_room_links(&links)?;
            Ok(json!({ "revoked": links.len() != before }))
        }
        other => Err(format!("{other}: 未知的 peer 方法")),
    }
}

/// `groups.*` 的业务分派。
fn dispatch_group(method: &str, params: &serde_json::Map<String, Value>) -> Result<Value, String> {
    match method {
        "groups.capabilities" => {
            // 宿主的 canonical 驱动 = **前端 canonical-group-driver**（见
            // src/components/panes/hub/canonical-group-driver.ts）：它在
            // `groups.send` 后按 groups_plan 的任务表逐成员跑 rpi 会话，
            // 结果经 `groups.driver_append` 写回房间日志。
            //   driver: true            → 插件判 canonical（可建房、canonical
            //                             workspace + driver_status 尽在其上）
            //   persistent_process:false → 驱动活在应用进程里，关应用即停
            //   methods                 → 如实列出宿主实现的方法（workspace
            //                             按它显隐控制项）
            let mut payload = controls::capabilities_payload(store::MAX_LOG_LIMIT as i64);
            payload["driver"] = json!(true);
            payload["persistent_process"] = json!(false);
            payload["methods"] = json!([
                "groups.capabilities",
                "groups.list",
                "groups.state",
                "groups.log",
                "groups.create",
                "groups.rename",
                "groups.disband",
                "groups.send",
                "groups.context",
                "groups.stop",
                "groups.continue",
                "groups.retry",
                "groups.discard",
                "groups.attachment.upload",
                "groups.attachment.download",
                "groups.driver_append",
            ]);
            payload["features"] = json!([]);
            Ok(payload)
        }

        "groups.list" => {
            let conn = open_store()?;
            let limit = params.get("limit").and_then(common::json_i64).unwrap_or(50);
            let offset = params.get("offset").and_then(common::json_i64).unwrap_or(0);
            let include_disbanded = params
                .get("include_disbanded")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let rooms = store::list_rooms(&conn, include_disbanded, limit, offset).map_err(|e| e.to_string())?;
            // 上游 `groups.list` 的分页游标：`next_offset: null` = 没有下一页。
            // 插件 `listCanonicalRooms` 以 `next_offset === null` 终止（undefined
            // 会抛 "Could not load the next group chats"——房间发现整块失败）。
            let next_offset = if rooms.len() as i64 >= limit {
                Some(offset + rooms.len() as i64)
            } else {
                None
            };
            Ok(json!({
                "rooms": rooms.iter().map(room_json).collect::<Vec<_>>(),
                "limit": limit,
                "offset": offset,
                "next_offset": next_offset,
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
                // `groups.changed` 推送已接（groups_dispatch 变更成功后广播）；
                // workspace 的 push 分支据此即时刷新，2s 轮询退为兜底。
                "change_events": true,
            }))
        }

        "groups.log" => {
            let conn = open_store()?;
            let room_id = params.get("room_id").cloned().unwrap_or(Value::Null);
            let since_seq = params.get("since_seq").and_then(common::json_i64).unwrap_or(0);
            let limit = params.get("limit").and_then(common::json_i64).unwrap_or(100);
            // 多读一条判 has_more（workspace 的分页收敛需要）。
            let mut events = store::read_events(&conn, &room_id, since_seq, limit.saturating_add(1))
                .map_err(|e| e.to_string())?;
            let has_more = events.len() as i64 > limit;
            if has_more {
                events.truncate(limit as usize);
            }
            Ok(json!({
                "events": events.iter().map(event_json).collect::<Vec<_>>(),
                "has_more": has_more,
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

        "groups.driver_append" => {
            // canonical 驱动的写回口：宿主前端 driver 把成员轮次的结果
            // （message.member / turn.settled / turn.failed / turn.cancelled /
            // room.activity）按事件词汇表写进房间日志。actor 与 payload 由
            // store::append_event 做 actor-kind 校验、规划层再校验一次形状。
            let mut conn = open_store()?;
            let room_id = params.get("room_id").cloned().unwrap_or(Value::Null);
            let event_id = params.get("event_id").cloned().unwrap_or(Value::Null);
            let kind = params.get("kind").cloned().unwrap_or(Value::Null);
            let actor = params.get("actor").cloned().unwrap_or(Value::Null);
            let payload = params.get("payload").cloned().unwrap_or(Value::Null);
            let room = store::room_state(&conn, &room_id, false).map_err(|e| e.to_string())?;
            let event = store::append_event(
                &mut conn,
                &room_id,
                &event_id,
                &kind,
                &actor,
                &payload,
                &Value::String(room.authority_gateway_id.clone()),
                Some(room.authority_epoch),
                None,
                None,
                false,
            )
            .map_err(|e| e.to_string())?;
            Ok(json!({ "event": event_json(&event) }))
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
            // 上游 `groups.send` 的受理回执：`client_event_id` 与请求的
            // event_id 一致、`accepted:true`——canonical workspace 的
            // confirmSend 用这两个字段证明"这次发送已被受理"。
            Ok(json!({
                "accepted": true,
                "client_event_id": event_id,
                "event": event_json(&event),
                "admitted": true,
            }))
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
    // members 直接回原始 roster 数组（上游 CanonicalRoom.members 的字段：
    // member_id/profile/handle/display_name/target）——canonical 群聊 UI 靠它
    // 渲染成员与路由。latest_seq = next_seq - 1（log 游标收敛用）。
    let members: Value = serde_json::from_str(&room.members_json).unwrap_or(Value::Null);
    json!({
        "room_id": room.room_id,
        "name": room.name,
        "members": members,
        "authority_gateway_id": room.authority_gateway_id,
        "authority_epoch": room.authority_epoch,
        "next_seq": room.next_seq,
        "latest_seq": room.next_seq.saturating_sub(1),
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
        &local_profiles(&members),
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
            "thread_id": t.thread_id,
            "member_id": t.member_id,
            "member_index": t.member_index,
            "round_index": t.round_index,
            "seen_through_seq": t.seen_through_seq,
            "source_event_seq": t.source_event_seq,
            // 成员轮次的完整 prompt（plan.rs 的 build_turn_prompt 产物）——
            // canonical 驱动把它原样交给该成员的 rpi 会话。
            "prompt": t.prompt,
        })),
    }))
}

/// 本地 profile 列表（宿主单身份）。
/// 本网关上的 profile 列表（上游 `local_profiles` 的宿主对偶）。
///
/// 宿主没有 hermes 那套 profile 系统，所以**从房间成员里取**：凡是 target.kind
/// 为 `local`（或无 target，默认 local）的成员，其 profile 就是本网关上的 profile。
///
/// 这与上游语义一致：上游校验的也是「该成员的 profile 是否属于本网关」。
/// 宿主单用户单身份，本网关能服务的 profile 就是成员里声明为 local 的那些。
fn local_profiles(members: &Value) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let Some(items) = members.as_array() else {
        return out;
    };
    for item in items {
        let Some(object) = item.as_object() else { continue };
        // target 缺失 = 默认 local（上游 `_validate_member_target` 的 None 分支）
        let is_local = match object.get("target") {
            None | Some(Value::Null) => true,
            Some(target) => target.get("kind").and_then(Value::as_str) == Some("local"),
        };
        if !is_local {
            continue;
        }
        if let Some(profile) = object.get("profile").and_then(Value::as_str) {
            let trimmed = profile.trim();
            if !trimmed.is_empty() && !out.iter().any(|p| p == trimmed) {
                out.push(trimmed.to_owned());
            }
        }
    }
    out
}

/// 供 `lib.rs`/`main.rs` 注册的命令表。
pub fn commands() -> Vec<&'static str> {
    vec!["groups_dispatch", "groups_plan"]
}

/// 保留：避免 unused 警告（`Arc` 在后续会话运行态接线时会用到）。
#[allow(dead_code)]
fn _unused(_: Arc<()>) {}
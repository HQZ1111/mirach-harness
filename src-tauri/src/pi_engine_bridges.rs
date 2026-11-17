//! 引擎侧宿主桥（2026-11-17）：把 rpi 的两个宿主门接到 mirach 前端 UI。
//!
//! - `message_agent` 工具（rpi-cli `message_agent`）：引擎把投递请求 emit
//!   给前端（`mirach://agent-message`），前端 ack（`pi_agent_message_ack`）
//!   后工具立即返回 queued；真正的投递/回信由前端完成（前端才知道 bot
//!   花名册与 canonical 会话）。
//! - 审批闸（rpi-cli `approval_gate`）：模式由前端（设置/输入框模式钮）
//!   经 `pi_set_approval_mode` 设置；命中询问时 emit
//!   `mirach://approval-request`，前端弹卡后 `pi_approval_decision` 回执。
//!
//! 超时语义：投递 ack 30s、审批 600s；超时按失败/拒绝处理（绝不 fail-open）。

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use async_trait::async_trait;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::sync::oneshot;

use rpi_cli::approval_gate::{ApprovalDecision, ApprovalHandler, ApprovalRequest};
use rpi_cli::message_agent::{
    MessageAgentAck, MessageAgentHandler, MessageAgentRequest,
};

pub const AGENT_MESSAGE_EVENT: &str = "mirach://agent-message";
pub const APPROVAL_EVENT: &str = "mirach://approval-request";

type PendingMap = Mutex<HashMap<String, oneshot::Sender<Value>>>;

fn pending_messages() -> &'static PendingMap {
    static CELL: OnceLock<PendingMap> = OnceLock::new();
    CELL.get_or_init(|| Mutex::new(HashMap::new()))
}

fn pending_approvals() -> &'static PendingMap {
    static CELL: OnceLock<PendingMap> = OnceLock::new();
    CELL.get_or_init(|| Mutex::new(HashMap::new()))
}

fn new_id(prefix: &str) -> String {
    format!("{prefix}-{}", uuid::Uuid::new_v4().simple())
}

fn resolve(map: &PendingMap, id: &str, value: Value) -> bool {
    let sender = map.lock().expect("bridge pending map poisoned").remove(id);
    match sender {
        Some(tx) => tx.send(value).is_ok(),
        None => false,
    }
}

struct HostMessageAgent {
    app: AppHandle,
}

#[async_trait]
impl MessageAgentHandler for HostMessageAgent {
    async fn dispatch(&self, request: MessageAgentRequest) -> Result<MessageAgentAck, String> {
        let id = new_id("delivery");
        let (tx, rx) = oneshot::channel();
        pending_messages()
            .lock()
            .expect("bridge pending map poisoned")
            .insert(id.clone(), tx);
        let payload = json!({
            "id": id,
            "source_session_id": request.source_session_id,
            "target": request.target,
            "message": request.message,
            "constraints": request.constraints,
            "expecting": request.expecting,
            "expects_reply": request.expects_reply,
        });
        self.app
            .emit(AGENT_MESSAGE_EVENT, payload)
            .map_err(|e| format!("message_agent: 前端事件发送失败: {e}"))?;
        match tokio::time::timeout(Duration::from_secs(30), rx).await {
            Ok(Ok(value)) => {
                if value.get("ok").and_then(Value::as_bool) == Some(true) {
                    Ok(MessageAgentAck {
                        delivery_id: value
                            .get("delivery_id")
                            .and_then(Value::as_str)
                            .map(str::to_owned)
                            .unwrap_or(id),
                        status: "queued".into(),
                    })
                } else {
                    Err(value
                        .get("error")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                        .unwrap_or_else(|| "message_agent: 前端拒绝投递".into()))
                }
            }
            Ok(Err(_)) => Err("message_agent: 前端回执通道断开".into()),
            Err(_) => {
                pending_messages()
                    .lock()
                    .expect("bridge pending map poisoned")
                    .remove(&id);
                Err("message_agent: 前端 30s 内未确认投递".into())
            }
        }
    }
}

struct HostApproval {
    app: AppHandle,
}

#[async_trait]
impl ApprovalHandler for HostApproval {
    async fn request(&self, request: ApprovalRequest) -> ApprovalDecision {
        let id = new_id("approval");
        let (tx, rx) = oneshot::channel();
        pending_approvals()
            .lock()
            .expect("bridge pending map poisoned")
            .insert(id.clone(), tx);
        let payload = json!({
            "id": id,
            "session_id": request.session_id,
            "tool": request.tool,
            "args": request.args,
        });
        if let Err(e) = self.app.emit(APPROVAL_EVENT, payload) {
            return ApprovalDecision::Deny {
                reason: Some(format!("审批事件发送失败: {e}")),
            };
        }
        match tokio::time::timeout(Duration::from_secs(600), rx).await {
            Ok(Ok(value)) => {
                if value.get("allow").and_then(Value::as_bool) == Some(true) {
                    ApprovalDecision::Allow
                } else {
                    ApprovalDecision::Deny {
                        reason: value
                            .get("reason")
                            .and_then(Value::as_str)
                            .map(str::to_owned),
                    }
                }
            }
            Ok(Err(_)) => ApprovalDecision::Deny {
                reason: Some("审批回执通道断开".into()),
            },
            Err(_) => {
                pending_approvals()
                    .lock()
                    .expect("bridge pending map poisoned")
                    .remove(&id);
                ApprovalDecision::Deny {
                    reason: Some("审批 10 分钟未答复（按拒绝处理）".into()),
                }
            }
        }
    }
}

/// 安装两个宿主门（幂等）。默认审批模式 = Yolo（旧行为），前端启动后按
/// 用户保存在 localStorage 的模式调用 `pi_set_approval_mode` 覆写。
pub fn install(app: &AppHandle) {
    static INSTALLED: OnceLock<()> = OnceLock::new();
    if INSTALLED.get().is_some() {
        return;
    }
    if !rpi_cli::message_agent::set_handler(std::sync::Arc::new(HostMessageAgent {
        app: app.clone(),
    })) {
        eprintln!("[engine-bridge] message_agent handler 已被安装（跳过）");
    }
    if !rpi_cli::approval_gate::set_handler(std::sync::Arc::new(HostApproval {
        app: app.clone(),
    })) {
        eprintln!("[engine-bridge] approval handler 已被安装（跳过）");
    }
    rpi_cli::approval_gate::set_mode(rpi_cli::approval_gate::ApprovalMode::Yolo);
    let _ = INSTALLED.set(());
}

/// 前端回执：message_agent 投递确认。
#[tauri::command(rename_all = "camelCase", async)]
pub fn pi_agent_message_ack(
    id: String,
    ok: bool,
    delivery_id: Option<String>,
    error: Option<String>,
) -> Result<bool, String> {
    Ok(resolve(
        pending_messages(),
        &id,
        json!({
            "ok": ok,
            "delivery_id": delivery_id,
            "error": error,
        }),
    ))
}

/// 前端回执：审批决定。
#[tauri::command(rename_all = "camelCase", async)]
pub fn pi_approval_decision(
    id: String,
    allow: bool,
    reason: Option<String>,
) -> Result<bool, String> {
    Ok(resolve(
        pending_approvals(),
        &id,
        json!({ "allow": allow, "reason": reason }),
    ))
}

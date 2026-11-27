//! L2 AG-UI 桥（docs/pi-integration.md §2/§7-2）：axum 双端点 +
//! per-thread 事件缓冲（sequence 单调）+ AgentEvent→AG-UI 映射器 +
//! 扩展 UI 对话框注册表（§4.4 审批/问题卡：rpi `UiDialogMailbox`
//! take → 投影行 → IPC 拉取 → 邮箱 respond/cancel；旧 oneshot 通道退役）。
//!
//! 端点（v2.2 定稿，两通道收口）：
//! - POST /ag-ui?token=…           起 run：{threadId, message} → {runId}
//! - GET  /ag-ui/stream?thread&lastEventId&token=…   常驻 SSE（唯一消费口）
//!
//! 映射：pi::AgentEvent → AG-UI 事件（§2.2 表）；ToolExecution* 走 CUSTOM
//! （执行维度与参数流维度分离）；AgentEnd → RUN_FINISHED/RUN_ERROR。

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};

use axum::{
    extract::{DefaultBodyLimit, Query, Request, State},
    http::{header, HeaderName, HeaderValue, Method, StatusCode},
    middleware,
    response::{IntoResponse, Sse},
    routing::{get, post},
    Json, Router,
};
use rpi_agent::AgentEvent;
use tokio_stream::wrappers::ReceiverStream;
use tower_http::cors::{AllowHeaders, AllowMethods, AllowOrigin, CorsLayer};

const BUFFER_CAP: usize = 2000;
const AGUI_VERSION: &str = "v0.4";
/// POST /ag-ui 请求体上限（默认 2MB 装不下 base64 图片；见 router 注释）
const AGUI_MAX_BODY_BYTES: usize = 64 * 1024 * 1024;

pub struct AguiState {
    pub engine: crate::pi_session::PiEngine,
    token: String,
    port: Mutex<Option<u16>>,
    /// 事件缓冲（handler 桥经 Arc 共享写同一份——扩展 UI 请求也进流）
    buffers: Arc<Mutex<ThreadBuffers>>,
    /// 扩展 UI 请求挂起注册表（§4.4：挂载时拉取 + 应答回灌）
    pub approvals: Arc<ApprovalRegistry>,
    /// ask 工具问题挂起注册表（交互卡；同款拉取 + 回灌）
    pub asks: Arc<AskRegistry>,
}

#[derive(Default)]
pub struct ThreadBuffers {
    counters: HashMap<String, u64>,
    events: HashMap<String, VecDeque<(u64, String)>>,
}

/// 缓冲写入（AguiState 与 handler 桥共用——单锁语义不变）
pub(crate) fn push_shared(
    b: &Mutex<ThreadBuffers>,
    thread: &str,
    json: serde_json::Value,
) -> u64 {
    let mut b = b.lock().expect("agui buffers poisoned");
    let counter = b.counters.entry(thread.to_string()).or_insert(0);
    *counter += 1;
    let seq = *counter;
    let dq = b.events.entry(thread.to_string()).or_default();
    dq.push_back((seq, json.to_string()));
    while dq.len() > BUFFER_CAP {
        dq.pop_front();
    }
    seq
}

/// 前端待应答的扩展 UI 请求（§4.4）。responder 桥回 pi 的 handler await。
pub struct PendingApproval {
    pub request: serde_json::Value,
    responder: tokio::sync::oneshot::Sender<UiAnswer>,
}

/// 前端对一条扩展 UI 请求的应答（ExtensionUiResponse 的传输形状）。
/// rpi 迁移后暂无读取方——扩展 UI 请求的产出面（engine 侧
/// extension_ui_handler）待 rpi 扩展生态接回，形状保留。
#[allow(dead_code)]
#[derive(Debug)]
pub struct UiAnswer {
    pub value: Option<serde_json::Value>,
    pub cancelled: bool,
}

/// 宿主侧已从 rpi `UiDialogMailbox` 取出的对话框。
///
/// 邮箱 `take_pending_filtered` 一旦取出，请求就从 pending 队列消失（仍留
/// 在 active 里等 `respond`/`cancel`），**没有枚举 active 的公开 API**——
/// 重复拉取只能由宿主回放。`ui` 保留插件原始载荷（应答时按
/// `options[].permission` 语义构造插件期望的 `values`），`row` 是给前端的
/// 投影（形状 = 前端 `PendingUiRequest`）。
struct UiDialogRow {
    ui: serde_json::Value,
    row: serde_json::Value,
}

#[derive(Default)]
pub struct ApprovalRegistry {
    pending: Mutex<HashMap<String, PendingApproval>>,
    /// rpi 邮箱取出的审批对话框（重复拉取回放 + 应答构造）。
    dialogs: Mutex<HashMap<String, UiDialogRow>>,
}

impl ApprovalRegistry {
    /// 引擎构造入口（rpi 竖链：PiEngine 持注册表，agui 共享同一 Arc）。
    pub(crate) fn new() -> Self {
        Self {
            pending: Mutex::new(HashMap::new()),
            dialogs: Mutex::new(HashMap::new()),
        }
    }

    /// 注册挂起审批——rpi 迁移后暂无调用方（引擎侧无 extension_ui_handler
    /// 产出面），respond/list 语义保留，待 rpi 扩展生态接回。
    #[allow(dead_code)]
    pub(crate) fn register(
        &self,
        id: String,
        request: serde_json::Value,
        responder: tokio::sync::oneshot::Sender<UiAnswer>,
    ) {
        self.pending
            .lock()
            .expect("approval registry poisoned")
            .insert(id, PendingApproval { request, responder });
    }

    /// 挂载/刷新时拉取（§4.4：pending_approvals 列表）：rpi 邮箱取出的
    /// 审批对话框 + 旧 oneshot 通道登记的请求（后者 rpi 迁移后无产出方，
    /// 语义位保留）。
    pub fn list(&self) -> Vec<serde_json::Value> {
        let mut out: Vec<serde_json::Value> = self
            .dialogs
            .lock()
            .expect("approval registry poisoned")
            .values()
            .map(|dialog| dialog.row.clone())
            .collect();
        out.sort_by(|a, b| {
            a["id"]
                .as_str()
                .unwrap_or("")
                .cmp(b["id"].as_str().unwrap_or(""))
        });
        out.extend(
            self.pending
                .lock()
                .expect("approval registry poisoned")
                .values()
                .map(|p| p.request.clone()),
        );
        out
    }

    /// 登记一条从 rpi 邮箱取出的审批对话框（引擎侧调用）。
    pub(crate) fn upsert_dialog(
        &self,
        id: String,
        ui: serde_json::Value,
        row: serde_json::Value,
    ) {
        self.dialogs
            .lock()
            .expect("approval registry poisoned")
            .insert(id, UiDialogRow { ui, row });
    }

    /// 该 id 的插件原始 ui 载荷（应答时构造插件期望形状）。
    pub(crate) fn dialog_ui(&self, id: &str) -> Option<serde_json::Value> {
        self.dialogs
            .lock()
            .expect("approval registry poisoned")
            .get(id)
            .map(|dialog| dialog.ui.clone())
    }

    /// 应答落账后移除（幂等；不存在 = no-op）。
    pub(crate) fn remove_dialog(&self, id: &str) {
        let _ = self
            .dialogs
            .lock()
            .expect("approval registry poisoned")
            .remove(id);
    }

    /// 剪掉已答/已取消/已超时的条目（邮箱 `is_pending` = 真相）。
    pub(crate) fn retain_dialogs(&self, keep: impl Fn(&str) -> bool) {
        self.dialogs
            .lock()
            .expect("approval registry poisoned")
            .retain(|id, _| keep(id));
    }

    /// 应答回灌；id 不存在 = 错误（错误即错误，不静默）。
    /// oneshot send 失败（对端 request_ui 已被丢弃——上游超时放弃/会话
    /// discard 中止扩展任务）也 = 错误（P1-3：不假装成功，前端可见）。
    ///
    /// rpi 迁移后没有产出方（旧 `ExtensionUiHandler` 通道退役），实际应答
    /// 走引擎的 `extension_ui_response`（邮箱 respond/cancel）；这里保留
    /// 注册表语义与测试。
    #[allow(dead_code)]
    pub fn respond(&self, id: &str, answer: UiAnswer) -> Result<(), String> {
        let pending = self
            .pending
            .lock()
            .expect("approval registry poisoned")
            .remove(id)
            .ok_or_else(|| format!("no pending approval with id {id}"))?;
        pending.responder.send(answer).map_err(|_| {
            format!("approval {id} responder gone (upstream timed out or session discarded)")
        })
    }

    /// 会话 discard/切换成功后清理挂起审批（P1-3 防鬼影卡片）：移除全部
    /// pending 项——oneshot Sender 析构后宿主桥的 request_ui 收到 Err，
    /// 按 cancelled 回灌 pi（§4.4 宿主桥故障语义）。rpi 邮箱取出的对话框
    /// 一并清空（引擎 install_live/discard 已先对旧邮箱 cancel_all）。
    pub fn cleanup(&self) {
        self.pending
            .lock()
            .expect("approval registry poisoned")
            .clear();
        self.dialogs
            .lock()
            .expect("approval registry poisoned")
            .clear();
    }
}

/// ask 工具注册表（rpi runtime action 17 的 ask 对话框投影）。
///
/// 真源 = 会话的 `UiDialogMailbox`；这里存**已取出**的请求（邮箱 take 后
/// pending 队列不再可见，重复拉取必须由宿主回放）。`row` 形状 =
/// 前端 `PendingAsk`（`{id, request:{questions:[…]}}`）。
#[derive(Default)]
pub struct AskRegistry {
    rows: Mutex<std::collections::BTreeMap<String, serde_json::Value>>,
}

impl AskRegistry {
    /// 引擎构造入口（同 ApprovalRegistry）。
    pub(crate) fn new() -> Self {
        Self {
            rows: Mutex::new(std::collections::BTreeMap::new()),
        }
    }

    /// 挂载/刷新时拉取挂起问题——已取出的 ask 请求（按 id 稳定排序）。
    pub fn list(&self) -> Vec<serde_json::Value> {
        self.rows
            .lock()
            .expect("ask registry poisoned")
            .values()
            .cloned()
            .collect()
    }

    /// 登记一条从 rpi 邮箱取出的 ask 请求（引擎侧调用）。
    pub(crate) fn upsert(&self, id: String, row: serde_json::Value) {
        self.rows
            .lock()
            .expect("ask registry poisoned")
            .insert(id, row);
    }

    /// 该 id 的前端投影（应答时判 selector/input 与 multi）。
    pub(crate) fn get(&self, id: &str) -> Option<serde_json::Value> {
        self.rows
            .lock()
            .expect("ask registry poisoned")
            .get(id)
            .cloned()
    }

    /// 应答落账后移除（幂等）。
    pub(crate) fn remove(&self, id: &str) {
        let _ = self
            .rows
            .lock()
            .expect("ask registry poisoned")
            .remove(id);
    }

    /// 剪掉已答/已取消/已超时的条目（邮箱 `is_pending` = 真相）。
    pub(crate) fn retain(&self, keep: impl Fn(&str) -> bool) {
        self.rows
            .lock()
            .expect("ask registry poisoned")
            .retain(|id, _| keep(id));
    }

    /// 会话 discard/切换后清理（防鬼影卡片）。
    pub fn cleanup(&self) {
        self.rows.lock().expect("ask registry poisoned").clear();
    }
}

impl AguiState {
    pub fn new() -> Self {
        // token：本地进程随机串（§0.2-3——localhost 威胁模型不需要 JWT）
        let token = format!(
            "agui-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system clock before Unix epoch")
                .subsec_nanos()
        );
        // P1-3：审批注册表由 PiEngine 持有（会话 discard/切换成功后由引擎
        // 侧清理挂起项）——这里共享同一 Arc，登记与清理一份真相。
        let engine = crate::pi_session::PiEngine::new();
        let approvals = engine.approvals();
        let asks = engine.asks();
        let buffers = Arc::new(Mutex::new(ThreadBuffers::default()));
        // 压缩进度 → 常驻 AG-UI 流（CUSTOM name=compaction）：引擎只往
        // HarnessEventBus 发 `CompactionProgress`，宿主必须自己桥进
        // thread 事件缓冲，否则前端永远没有「正在压缩上下文」提示。
        // 桥给的是**会话专属线程键**（`main:<id>`，bridge_compaction 捕获）
        // ——压缩进度落会话自己的桶，不串台。
        let buffers_for_sink = Arc::clone(&buffers);
        let _ = engine.set_compaction_sink(Arc::new(
            move |thread: &str, event: serde_json::Value| {
                push_shared(&buffers_for_sink, thread, event);
            },
        ));
        Self {
            engine,
            token,
            port: Mutex::new(None),
            buffers,
            approvals,
            asks,
        }
    }

    pub fn set_port(&self, port: u16) {
        *self.port.lock().expect("agui port poisoned") = Some(port);
    }

    /// 会话 UI 桥柄（POST 按需建会话与 pi_open_session/pi_new_session 复用）
    pub fn ui_bridge(&self, thread: &str) -> crate::pi_session::UiBridgeHandle {
        crate::pi_session::UiBridgeHandle {
            buffers: Arc::clone(&self.buffers),
            approvals: Arc::clone(&self.approvals),
            thread: thread.to_string(),
        }
    }

    pub fn endpoint(&self) -> serde_json::Value {
        serde_json::json!({
            "port": self.port.lock().expect("agui port poisoned").unwrap_or(0),
            "token": self.token,
            "version": AGUI_VERSION,
        })
    }

    fn check_token(&self, token: Option<&String>) -> bool {
        token.map(|t| t == &self.token).unwrap_or(false)
    }

    fn push(&self, thread: &str, json: serde_json::Value) -> u64 {
        push_shared(&self.buffers, thread, json)
    }

    fn drain(&self, thread: &str, after: u64) -> Vec<(u64, String)> {
        let b = self.buffers.lock().expect("agui buffers poisoned");
        b.events
            .get(thread)
            .map(|dq| {
                dq.iter()
                    .filter(|(s, _)| *s > after)
                    .take(200)
                    .cloned()
                    .collect()
            })
            .unwrap_or_default()
    }

    /// 当前缓冲最新 sequence（前端挂载时作为 EventSource 的
    /// lastEventId 起点——跳过历史重放，会话历史经 pi_get_messages 水合，
    /// 避免"重放混入其它会话的旧事件"）。
    pub fn latest_seq(&self, thread: &str) -> u64 {
        self.buffers
            .lock()
            .expect("agui buffers poisoned")
            .counters
            .get(thread)
            .copied()
            .unwrap_or(0)
    }
}

/// pi::AgentEvent → AG-UI 事件（§2.2 表；事件名以 ag-ui 协议为基准，
/// THINKING_* 事件名等 ag-ui crate 落地时对齐）。
fn map_agent_event(event: &AgentEvent) -> Vec<serde_json::Value> {
    use serde_json::json;
    match event {
        // RUN_STARTED 由 POST 处理器在起 run 时手动 push（runId 在那里才
        // 生成），AgentStart 不再重复发。
        AgentEvent::AgentStart => vec![],
        // 重试调度（可重试 provider 失败 + 退避）——旧映射无此事件，给一个
        // CUSTOM 观察名（前端未注册的名字自然忽略，不破坏协议）。
        AgentEvent::RetryScheduled { attempt, max_retries, delay_ms, error } => vec![json!({
            "type": "CUSTOM", "name": "provider_retry",
            "value": { "attempt": attempt, "maxRetries": max_retries, "delayMs": delay_ms, "error": error },
        })],
        AgentEvent::TurnStart => vec![],
        AgentEvent::MessageStart { .. } => vec![],
        AgentEvent::MessageUpdate {
            assistant_message_event,
            ..
        } => match assistant_message_event {
            rpi_ai::types::AssistantMessageEvent::TextDelta { delta, .. } => {
                vec![json!({ "type": "TEXT_MESSAGE_CONTENT", "delta": delta })]
            }
            rpi_ai::types::AssistantMessageEvent::ThinkingDelta { delta, .. } => {
                vec![json!({ "type": "THINKING_TEXT_MESSAGE_CONTENT", "delta": delta })]
            }
            rpi_ai::types::AssistantMessageEvent::ToolCallStart { .. } => {
                vec![json!({ "type": "TOOL_CALL_START" })]
            }
            rpi_ai::types::AssistantMessageEvent::ToolCallDelta { delta, .. } => {
                vec![json!({ "type": "TOOL_CALL_ARGS", "delta": delta })]
            }
            _ => vec![],
        },
        AgentEvent::MessageEnd { .. } => vec![json!({ "type": "TEXT_MESSAGE_END" })],
        AgentEvent::ToolExecutionStart {
            tool_call_id,
            tool_name,
            args,
        } => vec![json!({
            "type": "CUSTOM", "name": "tool_execution",
            "value": { "phase": "start", "toolCallId": tool_call_id, "toolName": tool_name, "args": args },
        })],
        AgentEvent::ToolExecutionUpdate {
            tool_call_id,
            partial_result,
            ..
        } => vec![json!({
            "type": "CUSTOM", "name": "tool_execution",
            "value": { "phase": "update", "toolCallId": tool_call_id, "partial": partial_result },
        })],
        AgentEvent::ToolExecutionEnd {
            tool_call_id,
            result,
            is_error,
            ..
        } => vec![json!({
            "type": "CUSTOM", "name": "tool_execution",
            "value": { "phase": "end", "toolCallId": tool_call_id, "result": result, "isError": is_error },
        })],
        AgentEvent::TurnEnd { .. } => vec![json!({ "type": "STEP_FINISHED" })],
        // run 总成本：AgentEnd.messages 是本 run 的全部新消息（多次工具迭代
        // 各带自己的 usage/cost），run 总成本 = Σ assistant.usage.cost.total。
        // rpi AgentEnd 无 error 字段——provider 失败经 prompt Err 走进程级
        // RUN_ERROR（竖链移植注：RUN_ERROR 语义由 POST 的 Err 分支承担）。
        AgentEvent::AgentEnd { messages } => {
            let cost_total: f64 = messages
                .iter()
                .filter_map(|m| match m {
                    rpi_agent::message::AgentMessage::Assistant(a) => Some(a.usage.cost.total),
                    _ => None,
                })
                .sum();
            // 用量快照（ContextDisplay 数据面）：取最后一条 assistant 消息的
            // usage（= 最终 turn 的上下文规模，input 已含历史）；
            // cacheWriteTokens/costUsd 为本轮增补字段
            let usage = messages.iter().rev().find_map(|m| match m {
                rpi_agent::message::AgentMessage::Assistant(a) => {
                    let mut o = serde_json::Map::new();
                    o.insert("inputTokens".into(), json!(a.usage.input));
                    o.insert("outputTokens".into(), json!(a.usage.output));
                    o.insert("cachedInputTokens".into(), json!(a.usage.cache_read));
                    o.insert("totalTokens".into(), json!(a.usage.total_tokens));
                    o.insert("cacheWriteTokens".into(), json!(a.usage.cache_write));
                    o.insert("costUsd".into(), json!(cost_total));
                    Some(serde_json::Value::Object(o))
                }
                _ => None,
            });
            vec![json!({
                "type": "RUN_FINISHED",
                "usage": usage,
            })]
        }
    }
}


/// POST body 的图片块（前端契约：`{threadId, message, images?: [{data,
/// mimeType}]}`；data = 不带 data: 前缀的纯 base64）。
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AguiImage {
    pub data: String,
    pub mime_type: String,
}

/// 图片 MIME 白名单（位图四域；SVG 非位图不收）。白名单外 POST 层 400
/// 拒绝——不静默丢（兜底禁令）。
const IMAGE_MIME_ALLOWLIST: &[&str] = &["image/png", "image/jpeg", "image/webp", "image/gif"];

/// 解析并校验 POST body 的 images 字段（缺省/Null = 无图；形状错/MIME
/// 越界/空 data = Err，调用方转 400）。
/// 图片条目校验（POST images[] 与 `pi_steer` 的 images 共用）：空 data /
/// 白名单外 MIME = Err（调用方转 400 / IPC Err，不静默丢）。
pub(crate) fn validate_images(images: &[AguiImage]) -> Result<(), String> {
    for img in images {
        if img.data.is_empty() {
            return Err("images[].data must be non-empty base64".into());
        }
        if !IMAGE_MIME_ALLOWLIST.contains(&img.mime_type.as_str()) {
            return Err(format!(
                "unsupported image mimeType {:?} (allowed: png/jpeg/webp/gif)",
                img.mime_type
            ));
        }
    }
    Ok(())
}

/// 把 provider 错误压成人可读的一行（去掉上游返回的 HTML 错误页）。
///
/// 为什么需要：模型服务前面常常有一层反向代理（nginx / Cloudflare）。代理
/// 返回 502/503/504 时 body 是一整页 HTML（`<html><head><title>502 Bad
/// Gateway</title>…`），而 pi-ai 把 `response.text()` **原样**放进 `AiError::Http`
/// 的 message（`rpi-ai/src/providers/*`）。前端直接把这条 message 显示给用户，
/// 于是会话里出现一大块 HTML（2026-11-27 用户实报）。
///
/// 这里只做**展示层清洗**，不改错误语义：
///   · HTML 文档 → 抽出 `<title>` 文本（`502 Bad Gateway` 本身就是最好的摘要），
///     没有 title 就退成 `HTTP 502（上游返回 HTML 错误页）`；
///   · 非 HTML 保持原样（JSON 错误体是有效信息，不能丢）。
pub fn humanize_provider_error(raw: &str) -> String {
    let trimmed = raw.trim();
    let looks_html = {
        let head = trimmed.get(..512).unwrap_or(trimmed).to_ascii_lowercase();
        head.contains("<!doctype html") || head.contains("<html") || head.contains("<head")
    };
    if !looks_html {
        return trimmed.to_string();
    }

    // 取 <title>…</title>（大小写不敏感）：nginx 的默认错误页正是这个形状。
    let lower = trimmed.to_ascii_lowercase();
    if let Some(start) = lower.find("<title") {
        if let Some(open_end) = lower[start..].find('>') {
            let body_start = start + open_end + 1;
            if let Some(close) = lower[body_start..].find("</title") {
                let title = trimmed[body_start..body_start + close].trim();
                if !title.is_empty() {
                    return format!("{title}（上游返回 HTML 错误页，非 JSON 响应）");
                }
            }
        }
    }

    // 从首行/首段里再试一次状态码，尽量给具体信息。
    let status_hint = lower
        .find("bad gateway")
        .map(|_| "502 Bad Gateway")
        .or_else(|| lower.find("service unavailable").map(|_| "503 Service Unavailable"))
        .or_else(|| lower.find("gateway timeout").map(|_| "504 Gateway Timeout"));
    match status_hint {
        Some(hint) => format!("{hint}（上游返回 HTML 错误页，非 JSON 响应）"),
        None => "上游返回 HTML 错误页（非 JSON 响应）".to_string(),
    }
}

fn parse_images(body: &serde_json::Value) -> Result<Vec<AguiImage>, String> {
    match body.get("images") {
        None | Some(serde_json::Value::Null) => Ok(vec![]),
        Some(v) => {
            let images: Vec<AguiImage> = serde_json::from_value(v.clone())
                .map_err(|e| format!("images parse failed: {e}"))?;
            validate_images(&images)?;
            Ok(images)
        }
    }
}

async fn agui_run(
    State(st): State<Arc<AguiState>>,
    Query(q): Query<HashMap<String, String>>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    if !st.check_token(q.get("token")) {
        return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error": "bad token"}))).into_response();
    }
    let thread = match body["threadId"].as_str() {
        Some(t) if !t.is_empty() => t.to_string(),
        // 错误即错误：缺 threadId 不静默默认（兜底禁令）
        _ => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": "threadId required" })),
            )
                .into_response();
        }
    };
    let message = body["message"].as_str().unwrap_or("").to_string();
    if message.is_empty() {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "empty message"}))).into_response();
    }
    // 图片块（可选）：形状/MIME 白名单在 POST 层校验，越界 400——不静默丢
    let images = match parse_images(&body) {
        Ok(v) => v,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": e })),
            )
                .into_response()
        }
    };
    // 目标会话文件（可选，v7.4 双对话分栏）：带 sessionPath = 该消息发给
    // 指定会话（分栏各自收发）。路由（v7.4 多柄）：
    // - thread == "main" → 主柄路径：sessionPath 在场 = 引擎切回工作区会话
    //   （open_session），否则 ensure 按需创建；
    // - thread != "main" → 分栏柄：side_open 按 sessionPath 取/建独立柄
    //   （每柄独立锁——与主柄/其他分栏**并行**，多 run 同时流式）。
    // flush/create 的深递归 future 不能在 tokio worker 栈上 block_on——
    // 16MiB 大栈线程承载（engine 经 Arc 共享）。
    let is_main_thread = thread == "main";
    let session_path = if is_main_thread {
        body["sessionPath"].as_str().map(String::from)
    } else {
        // 分栏消息必须有 sessionPath（无 path = 水合不可能，无法定位会话文件）
        match body["sessionPath"].as_str() {
            Some(p) if !p.is_empty() => Some(p.to_string()),
            _ => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({ "error": "sessionPath required for non-main thread" })),
                )
                    .into_response()
            }
        }
    };
    // 会话按需创建（§7-3）：已有活跃会话时原样复用（多轮上下文保持），
    // 无才创建——【关键】不能每次 POST 都 create（否则每条消息换新会话，
    // 上下文全丢）。flush/create 的深递归 future 不能在 tokio worker 栈上
    // block_on——16MiB 大栈线程承载（engine 经 Arc 共享，单会话不变量不破）。
    //
    // **多会话并存（2026-11-28 用户："切换会话时要不中断对话，像 hermes
    // 那样多标签并存、后台继续跑"）**：POST 同步等会话解析完成后，本 run
    // 的**全部事件**路由到 `main:<piSessionId>` 专属缓冲（不再共用 "main"）
    // ——切走后该 run 在 retired 句柄上继续跑，事件落自己的桶；切回时前端
    // 从自己的游标续放，投影无缝接上。响应带 `threadId` 供前端核对订阅键。
    // 解析失败 = HTTP 500 + JSON error（前端可见；不再往公共桶推 RUN_ERROR
    // ——旧路径的订阅方已不存在）。
    let st_create = st.clone();
    let thread_bridge = thread.clone();
    let create = tokio::task::spawn_blocking(move || {
        std::thread::Builder::new()
            .name("pi-create".into())
            .stack_size(16 * 1024 * 1024)
            .spawn(move || {
                if is_main_thread {
                    if let Some(path) = &session_path {
                        // 单写者租约：已在场的同一会话直接复用（每条消息都
                        // 重新 open 会撞 "writer lease is already held"——
                        // 前端每次 POST 都带 sessionPath，这是主路径）。
                        match st_create.engine.is_live_session(path) {
                            Ok(true) => st_create.engine.live_session_id(),
                            Ok(false) => st_create
                                .engine
                                .open_session(path, Some(st_create.ui_bridge(&thread_bridge))),
                            Err(e) => Err(e),
                        }
                    } else {
                        st_create
                            .engine
                            .ensure_session(Some(st_create.ui_bridge(&thread_bridge)))
                            .and_then(|()| st_create.engine.live_session_id())
                    }
                } else {
                    st_create.engine.side_open(
                        &thread_bridge,
                        session_path.as_deref().expect("sessionPath checked"),
                        st_create.ui_bridge(&thread_bridge),
                    )?;
                    Ok(thread_bridge.clone())
                }
            })
            .expect("spawn pi-create thread")
            .join()
            .map_err(|_| "pi-create thread panicked".to_string())
    })
    .await
    .map_err(|e| e.to_string())
    .and_then(|r| r);
    let resolved = match create {
        Ok(Ok(id_or_key)) => id_or_key,
        Ok(Err(e)) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": humanize_provider_error(&e) })),
            )
                .into_response()
        }
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": e.to_string() })),
            )
                .into_response()
        }
    };
    // 路由键：主会话 = `main:<piSessionId>`（每会话独立缓冲）；分栏 = 原
    // 窗格键（本就 per-thread）。
    let route_thread = if is_main_thread {
        format!("main:{resolved}")
    } else {
        thread.clone()
    };

    let run_id = format!(
        "run-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system clock before Unix epoch")
            .as_millis()
    );
    // P1-2：RUN_STARTED 不在 POST 里推——排队 run（前一个 run 未结束）的
    // STARTED 提前入缓冲 = §0.3-1 协议违例序列（streaming 中收到另一
    // runId 的 STARTED）。改经 on_start 回调在 PiEngine 拿到 handle mutex
    // 后、起跑前推送。POST 仍立即返回 runId（生成逻辑不动）。
    let run_id_for_start = run_id.clone();

    let st2 = st.clone();
    let thread2 = route_thread.clone();
    // pi 的 block_on 阻塞自己的线程（asupersync），专用大栈线程承载——
    // pi debug 构建的 session future 深递归 >2MiB 默认栈（pi .cargo/config.toml
    // 的 RUST_MIN_STACK=16MiB 同源教训：MutexGuard 跨 await 非 Send，
    // 只能靠调用线程自己的栈）；事件回调经映射器进缓冲，SSE 端轮询放出。
    // prompt 自身失败（会话锁中毒/重入拒绝等 pi 未走 AgentEnd(error) 的
    // 失败）以 RUN_ERROR 进缓冲——错误可观测，不吞。
    let sink = st2.clone();
    std::thread::Builder::new()
        .name("pi-prompt".into())
        .stack_size(16 * 1024 * 1024)
        .spawn(move || {
            let err_sink = sink.clone();
            let err_thread = thread2.clone();
            let start_sink = sink.clone();
            let start_thread = thread2.clone();
            let on_start: Box<dyn FnOnce() + Send> = Box::new(move || {
                start_sink.push(
                    &start_thread,
                    serde_json::json!({
                        "type": "RUN_STARTED",
                        "threadId": &start_thread,
                        "runId": &run_id_for_start,
                    }),
                );
            });
            let result = {
                let sink2 = sink.clone();
                let thread3 = thread2.clone();
                let on_event = move |event: AgentEvent| {
                    for v in map_agent_event(&event) {
                        sink2.push(&thread3, v);
                    }
                };
                // 多柄路由（v7.4）：thread != main → side_prompt（分栏独立柄，
                // 只锁自己柄——与主柄/其他分栏并行）；thread == main → 主柄
                // prompt（原路径不变）。无图 = 纯文本原路径；有图 =
                // prompt_with_content（同一锁/on_start/AbortSlot 内核）。
                if is_main_thread {
                    if images.is_empty() {
                        st2.engine.prompt(&message, on_event, on_start)
                    } else {
                        st2.engine.prompt_with_content(&message, &images, on_event, on_start)
                    }
                } else {
                    st2.engine.side_prompt(&thread2, &message, &images, on_event, on_start)
                }
            };
            if let Err(e) = result {
                err_sink.push(&err_thread, serde_json::json!({ "type": "RUN_ERROR", "message": humanize_provider_error(&e) }));
            }
        })
        .expect("spawn pi-prompt thread");
    // 响应带路由键：前端核对/换订 SSE 用（`main:<id>` ≠ 请求里的 "main"）。
    Json(serde_json::json!({ "runId": run_id, "threadId": route_thread })).into_response()
}


async fn agui_stream(
    State(st): State<Arc<AguiState>>,
    Query(q): Query<HashMap<String, String>>,
    headers: axum::http::HeaderMap,
) -> axum::response::Response {
    // P0-1：与 POST 同款 token 校验（§2.1——GET 流 token 走 query 参数，
    // EventSource 无法发自定义头，前端 URL 已带 token=…）
    if !st.check_token(q.get("token")) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "bad token" })),
        )
            .into_response();
    }
    // 错误即错误：缺 thread 不静默默认（兜底禁令）
    let thread = match q.get("thread") {
        Some(t) if !t.is_empty() => t.clone(),
        _ => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": "thread required" })),
            )
                .into_response();
        }
    };
    // P0-3：cursor 优先取 SSE 标准 Last-Event-ID 头（EventSource 原生重连
    // 自动携带——此前只读 query，原生重连会拿陈旧 query 全量重放）；无头
    // 或解析失败回退 query lastEventId；两者都有取 max（取更靠后的位置）。
    let header_cursor = headers
        .get("last-event-id")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse::<u64>().ok());
    let query_cursor = q.get("lastEventId").and_then(|s| s.parse::<u64>().ok());
    let mut cursor: u64 = header_cursor.max(query_cursor).unwrap_or(0);
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<axum::response::sse::Event, std::convert::Infallible>>(32);

    // 轮询放出（MVP：150ms 步进；per-thread 单消费，drain 后丢弃已送事件）
    tauri::async_runtime::spawn(async move {
        loop {
            for (seq, data) in st.drain(&thread, cursor) {
                cursor = seq;
                if tx
                    .send(Ok(axum::response::sse::Event::default()
                        .id(seq.to_string())
                        .data(data)))
                    .await
                    .is_err()
                {
                    return; // 客户端断开
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        }
    });

    Sse::new(ReceiverStream::new(rx)).keep_alive(
        axum::response::sse::KeepAlive::new()
            .interval(std::time::Duration::from_secs(15))
            .text("ping"),
    ).into_response()
}

async fn healthz() -> impl IntoResponse {
    "agui ok"
}

/// Host 校验（P0-2，§2.1 DNS rebinding 防线）：Host 头必须落在
/// 127.0.0.1:{port} / localhost:{port}，否则 403。浏览器发起的
/// fetch/EventSource 自动携带目标地址的真实 Host，不受影响。端口未
/// 就绪（serve 前物理上无请求可达）也 fail closed——500 拒绝，不敞门。
async fn enforce_host(
    State(st): State<Arc<AguiState>>,
    req: Request,
    next: middleware::Next,
) -> axum::response::Response {
    let port = *st.port.lock().expect("agui port poisoned");
    let Some(port) = port else {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "agui endpoint not ready" })),
        )
            .into_response();
    };
    let allowed = [format!("127.0.0.1:{port}"), format!("localhost:{port}")];
    let host_ok = req
        .headers()
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .map(|h| allowed.iter().any(|a| a.eq_ignore_ascii_case(h)))
        .unwrap_or(false);
    if !host_ok {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": "bad host" })),
        )
            .into_response();
    }
    next.run(req).await
}

pub fn router(state: Arc<AguiState>) -> Router {
    // P0-2：显式 CORS（替代 very_permissive）——白名单 = Tauri 生产源
    // （http://tauri.localhost / tauri://localhost）+ dev 源（1430 vite）；
    // 方法 GET/POST/OPTIONS；头 content-type（POST JSON）、authorization、
    // last-event-id（EventSource 原生重连携带，跨源重连需预检放行）。
    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::list([
            HeaderValue::from_static("http://tauri.localhost"),
            HeaderValue::from_static("tauri://localhost"),
            HeaderValue::from_static("http://127.0.0.1:1430"),
            HeaderValue::from_static("http://localhost:1430"),
        ]))
        .allow_methods(AllowMethods::list([
            Method::GET,
            Method::POST,
            Method::OPTIONS,
        ]))
        .allow_headers(AllowHeaders::list([
            header::CONTENT_TYPE,
            header::AUTHORIZATION,
            HeaderName::from_static("last-event-id"),
        ]));
    Router::new()
        .route("/ag-ui", post(agui_run))
        .route("/ag-ui/stream", get(agui_stream))
        .route("/healthz", get(healthz))
        // POST 体上限：axum `Json` 默认 2MB——一张普通截图（base64 后
        // 1.33 倍）就会撞 413，前端只看到"消息没发出去"（2026-11-15
        // 图片发的根因之一）。图片走 base64 原生通道，这里放宽到 64MB；
        // 前端 native 图片单张上限 24MB（attachments.ts），仍有充足余量。
        .layer(DefaultBodyLimit::max(AGUI_MAX_BODY_BYTES))
        .layer(cors)
        // 层序：后加的在外层最先执行——Host 校验先于 CORS；坏 Host 的
        // 403 不带 CORS 头也无所谓（rebinding 攻击请求本就不受 CORS 保护）。
        .layer(middleware::from_fn_with_state(
            state.clone(),
            enforce_host,
        ))
        .with_state(state)
}

#[cfg(test)]
mod tests {
    //! agui 单元测试（竖链移植后：**rpi-main AgentEvent 形状** + AG-UI 映射
    //! 语义保持——形状逐一对照 rpi-agent/src/events.rs + rpi-ai types.rs）。
    //! 与旧版（df701a4）的差异：AgentEnd 无 error 字段（RUN_ERROR 语义由
    //! prompt Err 的 POST 分支承担，用例 agent_end_error 随之退役）；
    //! AutoCompaction 变体退役（rpi 无对应，三条 compaction 用例随删，追平
    //! 后按 CUSTOM compaction 形状接回）；工具结果 = AgentToolResult
    //! （details 为 Value 直通——None→null 语义不变）。
    //! 全部同步断言（oneshot 用 try_recv，不依赖 tokio rt feature 进 dev）。

    use super::*;
    use rpi_ai::types::{Api, AssistantMessage, AssistantMessageEvent};
    use rpi_agent::message::AgentMessage;

    // ---------- provider 错误友好化 ----------

    #[test]
    fn humanize_extracts_title_from_nginx_error_page() {
        // 用户 2026-11-27 实报的原文（nginx 502 默认页）。
        let raw = "http error 502: <html> <head><title>502 Bad Gateway</title></head> \
                   <body> <center><h1>502 Bad Gateway</h1></center> <hr><center>nginx</center> \
                   </body> </html>";
        let out = humanize_provider_error(raw);
        assert!(out.starts_with("502 Bad Gateway"), "got: {out}");
        assert!(!out.contains('<'), "不应再出现 HTML 标签: {out}");
        assert!(!out.contains("<body>"), "不应再携带 body: {out}");
    }

    #[test]
    fn humanize_keeps_plain_and_json_errors_verbatim() {
        // 非 HTML（JSON 错误体 / 纯文本）是有效信息，一字不改。
        let json = r#"{"error":{"message":"rate limited"}}"#;
        assert_eq!(humanize_provider_error(json), json);
        let plain = "connection refused";
        assert_eq!(humanize_provider_error(plain), plain);
    }

    #[test]
    fn humanize_falls_back_to_status_hint_without_title() {
        let raw = "<html><body><h1>502 Bad Gateway</h1></body></html>";
        let out = humanize_provider_error(raw);
        assert!(out.contains("502 Bad Gateway"), "got: {out}");
        assert!(!out.contains('<'), "不应再出现 HTML 标签: {out}");
    }

    // ---------- 样本助手 ----------

    /// 最小合法 assistant 消息（rpi AssistantMessage::empty + zeroed usage）。
    fn sample_assistant() -> AssistantMessage {
        AssistantMessage::empty(Api::OpenaiCompletions, "test-provider", "test-model", 0)
    }

    fn partial() -> std::sync::Arc<AssistantMessage> {
        std::sync::Arc::new(sample_assistant())
    }

    fn msg_update(ev: AssistantMessageEvent) -> AgentEvent {
        AgentEvent::MessageUpdate {
            message_id: None,
            message: std::sync::Arc::new(sample_assistant()),
            assistant_message_event: ev,
        }
    }

    fn tool_out() -> rpi_agent::types::AgentToolResult {
        rpi_agent::types::AgentToolResult::default()
    }

    fn answer(value: Option<serde_json::Value>, cancelled: bool) -> UiAnswer {
        UiAnswer { value, cancelled }
    }

    fn empty_buffers() -> Mutex<ThreadBuffers> {
        Mutex::new(ThreadBuffers::default())
    }

    // ---------- 映射器（§2.2 逐行） ----------

    #[test]
    fn agent_start_maps_empty_run_started_is_manual() {
        // §2.2 行 1（AgentStart→RUN_STARTED）的有意偏差：RUN_STARTED 由
        // POST 处理器经 on_start 回调挂在真实 run 上推送（runId 在那里才
        // 生成），映射器对 AgentStart 不再重复发。
        let e = AgentEvent::AgentStart;
        assert!(map_agent_event(&e).is_empty());
    }

    #[test]
    fn text_delta_maps_text_message_content() {
        let e = msg_update(AssistantMessageEvent::TextDelta {
            content_index: 0,
            delta: "你好".into(),
            partial: partial(),
        });
        let v = map_agent_event(&e);
        assert_eq!(v.len(), 1);
        assert_eq!(v[0]["type"], "TEXT_MESSAGE_CONTENT");
        assert_eq!(v[0]["delta"], "你好");
    }

    #[test]
    fn thinking_delta_maps_thinking_text_message_content() {
        let e = msg_update(AssistantMessageEvent::ThinkingDelta {
            content_index: 1,
            delta: "推理中".into(),
            partial: partial(),
        });
        let v = map_agent_event(&e);
        assert_eq!(v.len(), 1);
        assert_eq!(v[0]["type"], "THINKING_TEXT_MESSAGE_CONTENT");
        assert_eq!(v[0]["delta"], "推理中");
    }

    #[test]
    fn tool_call_start_maps_tool_call_start() {
        let e = msg_update(AssistantMessageEvent::ToolCallStart {
            content_index: 2,
            partial: partial(),
        });
        let v = map_agent_event(&e);
        assert_eq!(v.len(), 1);
        assert_eq!(v[0]["type"], "TOOL_CALL_START");
    }

    #[test]
    fn tool_call_delta_maps_tool_call_args() {
        let e = msg_update(AssistantMessageEvent::ToolCallDelta {
            content_index: 2,
            delta: r#"{"path":"G:/x"}"#.into(),
            partial: partial(),
        });
        let v = map_agent_event(&e);
        assert_eq!(v.len(), 1);
        assert_eq!(v[0]["type"], "TOOL_CALL_ARGS");
        assert_eq!(v[0]["delta"], r#"{"path":"G:/x"}"#);
    }

    #[test]
    fn message_end_maps_text_message_end() {
        let e = AgentEvent::MessageEnd {
            message: AgentMessage::Assistant(Box::new(sample_assistant())),
            message_id: None,
        };
        let v = map_agent_event(&e);
        assert_eq!(v.len(), 1);
        assert_eq!(v[0]["type"], "TEXT_MESSAGE_END");
    }

    #[test]
    fn message_update_block_starts_and_ends_currently_unmapped() {
        // §2.2 表要求 MessageUpdate{TextStart/ThinkingStart}→*_MESSAGE_START、
        // {TextEnd/ThinkingEnd}→*_MESSAGE_END（contentIndex 配对）——当前
        // 映射器未实现（fall-through 空 vec）。前端 reducer 对这些事件名
        // 无分支（default 透传，turn-actor.ts），无运行期破损。本用例钉住
        // 现状作为将来补齐时的翻转点；本轮不改正事逻辑（§7-2 约束）。
        for ev in [
            AssistantMessageEvent::TextStart {
                content_index: 0,
                partial: partial(),
            },
            AssistantMessageEvent::TextEnd {
                content_index: 0,
                content: "done".into(),
                partial: partial(),
            },
            AssistantMessageEvent::ThinkingStart {
                content_index: 1,
                partial: partial(),
            },
            AssistantMessageEvent::ThinkingEnd {
                content_index: 1,
                content: "r".into(),
                partial: partial(),
            },
        ] {
            let e = msg_update(ev);
            assert!(
                map_agent_event(&e).is_empty(),
                "expected no events for {e:?}"
            );
        }
    }

    #[test]
    fn tool_call_end_currently_unmapped() {
        // §2.2 表要求 MessageUpdate{ToolCallEnd}→TOOL_CALL_END——当前未
        // 映射（工具调用的 result/isError 由 CUSTOM tool_execution end
        // 承载，§2.2 维度裁定；前端 TOOL_CALL_* 无 END 分支，现状无破损）。
        // rpi ToolCallEnd { content_index, tool_call, partial }。
        let e = msg_update(AssistantMessageEvent::ToolCallEnd {
            content_index: 2,
            tool_call: rpi_ai::types::ToolCall {
                kind: Default::default(),
                id: "tc-1".into(),
                name: "read".into(),
                arguments: serde_json::json!({ "path": "G:/x" }),
                thought_signature: None,
                namespace: None,
                recorded: None,
            },
            partial: partial(),
        });
        assert!(map_agent_event(&e).is_empty());
    }

    #[test]
    fn tool_execution_start_maps_custom_with_args() {
        let e = AgentEvent::ToolExecutionStart {
            tool_call_id: "tc-1".into(),
            tool_name: "read".into(),
            args: serde_json::json!({ "path": "G:/x" }),
        };
        let v = map_agent_event(&e);
        assert_eq!(v.len(), 1);
        assert_eq!(v[0]["type"], "CUSTOM");
        assert_eq!(v[0]["name"], "tool_execution");
        assert_eq!(v[0]["value"]["phase"], "start");
        assert_eq!(v[0]["value"]["toolCallId"], "tc-1");
        assert_eq!(v[0]["value"]["toolName"], "read");
        // args 取自 Start（§2.2 维度裁定：参数流维度在 MessageUpdate 侧，
        // 执行维度在 ToolExecution* 侧）
        assert_eq!(v[0]["value"]["args"]["path"], "G:/x");
    }

    #[test]
    fn tool_execution_update_maps_custom_with_partial() {
        let e = AgentEvent::ToolExecutionUpdate {
            tool_call_id: "tc-1".into(),
            tool_name: "bash".into(),
            args: serde_json::json!({}),
            partial_result: std::sync::Arc::new(tool_out()),
        };
        let v = map_agent_event(&e);
        assert_eq!(v.len(), 1);
        assert_eq!(v[0]["type"], "CUSTOM");
        assert_eq!(v[0]["name"], "tool_execution");
        assert_eq!(v[0]["value"]["phase"], "update");
        assert_eq!(v[0]["value"]["toolCallId"], "tc-1");
        // partial 是 rpi AgentToolResult 的序列化（content 数组 + details null）
        assert!(v[0]["value"]["partial"].is_object());
        assert_eq!(v[0]["value"]["partial"]["content"], serde_json::json!([]));
        assert!(v[0]["value"]["partial"]["details"].is_null());
    }

    #[test]
    fn tool_execution_end_maps_custom_with_result_and_error_flag() {
        let mut result = tool_out();
        result.details = serde_json::json!({ "marker": true });
        let e = AgentEvent::ToolExecutionEnd {
            tool_call_id: "tc-9".into(),
            tool_name: "read".into(),
            result,
            is_error: true,
        };
        let v = map_agent_event(&e);
        assert_eq!(v.len(), 1);
        assert_eq!(v[0]["type"], "CUSTOM");
        assert_eq!(v[0]["value"]["phase"], "end");
        assert_eq!(v[0]["value"]["toolCallId"], "tc-9");
        // end 带 result/isError（tool-error 元素数据源）
        assert_eq!(v[0]["value"]["isError"], true);
        assert_eq!(v[0]["value"]["result"]["details"]["marker"], true);
    }

    /// 带 details 的工具结果（活动面板数据面：todo/subagent/jobs 的
    /// schema payload 都走 AgentToolResult.details）。
    fn tool_out_with_details(details: serde_json::Value) -> rpi_agent::types::AgentToolResult {
        rpi_agent::types::AgentToolResult {
            content: vec![],
            details,
            usage: None,
            added_tool_names: vec![],
            terminate: false,
        }
    }

    /// details 端到端直通（防回归）：todo/subagent/jobs schema payload 经
    /// `tool_execution` update/end 的 partial/result 原样到前端——前端归约器
    /// 按 `value.partial.details.schema` 分派（turn-actor.ts）。若 mapper 哪天
    /// 改成只透 content，本测试立刻红。
    #[test]
    fn tool_execution_update_passes_details_through() {
        let details = serde_json::json!({
            "schema": "todo_list.v1",
            "phases": [{ "tasks": [{ "content": "写文档", "state": "in_progress" }] }],
        });
        let e = AgentEvent::ToolExecutionUpdate {
            tool_call_id: "tc-todo".into(),
            tool_name: "todo".into(),
            args: serde_json::json!({}),
            partial_result: std::sync::Arc::new(tool_out_with_details(details.clone())),
        };
        let v = map_agent_event(&e);
        assert_eq!(v[0]["value"]["partial"]["details"]["schema"], "todo_list.v1");
        assert_eq!(
            v[0]["value"]["partial"]["details"]["phases"][0]["tasks"][0]["content"],
            "写文档"
        );
        assert_eq!(v[0]["value"]["partial"]["details"], details);
    }

    #[test]
    fn tool_execution_end_passes_details_through() {
        let details = serde_json::json!({
            "schema": "pi.agent-hub.roster/v1",
            "children": [{ "id": "scout-1", "status": "running" }],
        });
        let e = AgentEvent::ToolExecutionEnd {
            tool_call_id: "tc-hub".into(),
            tool_name: "hub".into(),
            result: tool_out_with_details(details.clone()),
            is_error: false,
        };
        let v = map_agent_event(&e);
        assert_eq!(
            v[0]["value"]["result"]["details"]["schema"],
            "pi.agent-hub.roster/v1"
        );
        assert_eq!(v[0]["value"]["result"]["details"], details);
    }

    /// details 缺省时不注入空对象（Value::Null → JSON null，不是 `{}`）：前端据
    /// 「有无 details」区分「工具无结构化输出」与「空结构化输出」。
    #[test]
    fn tool_execution_without_details_omits_field() {
        let e = AgentEvent::ToolExecutionEnd {
            tool_call_id: "tc-plain".into(),
            tool_name: "read".into(),
            result: tool_out(),
            is_error: false,
        };
        let v = map_agent_event(&e);
        assert!(v[0]["value"]["result"]["details"].is_null());
    }

    #[test]
    fn turn_end_maps_step_finished() {
        let e = AgentEvent::TurnEnd {
            message: AgentMessage::Assistant(Box::new(sample_assistant())),
            tool_results: vec![],
            pending_messages: 0,
        };
        let v = map_agent_event(&e);
        assert_eq!(v.len(), 1);
        assert_eq!(v[0]["type"], "STEP_FINISHED");
        // 当前契约：用量不在 STEP_FINISHED 上——前端 turn-actor 只消费
        // RUN_FINISHED.usage（turn-actor.ts RUN_FINISHED 分支），§2.2 表
        // 的"STEP_FINISHED 带 usage"行由 RUN_FINISHED 承担。
        assert!(v[0].get("usage").is_none());
    }

    #[test]
    fn agent_end_success_maps_run_finished_with_usage() {
        let mut msg = sample_assistant();
        msg.usage.input = 1234;
        msg.usage.output = 567;
        msg.usage.cache_read = 89;
        msg.usage.total_tokens = 1801;
        let e = AgentEvent::AgentEnd {
            messages: vec![AgentMessage::Assistant(Box::new(msg))],
        };
        let v = map_agent_event(&e);
        assert_eq!(v.len(), 1);
        assert_eq!(v[0]["type"], "RUN_FINISHED");
        // usage 字段非空路径（ContextDisplay 唯一数据源）：取最后一条
        // assistant 消息的 usage，input/output/cachedRead/total 全带上
        assert!(v[0]["usage"].is_object());
        assert_eq!(v[0]["usage"]["inputTokens"], 1234);
        assert_eq!(v[0]["usage"]["outputTokens"], 567);
        assert_eq!(v[0]["usage"]["cachedInputTokens"], 89);
        assert_eq!(v[0]["usage"]["totalTokens"], 1801);
    }

    #[test]
    fn agent_end_without_assistant_messages_usage_null() {
        // 无 assistant 消息 → RUN_FINISHED 照发（不能没有 run 终态），
        // usage = null（前端 reducer 对缺字段保留旧值）
        let e = AgentEvent::AgentEnd { messages: vec![] };
        let v = map_agent_event(&e);
        assert_eq!(v.len(), 1);
        assert_eq!(v[0]["type"], "RUN_FINISHED");
        assert!(v[0]["usage"].is_null());
    }

    #[test]
    fn agent_end_usage_carries_cache_write_and_run_cost() {
        let mut msg = sample_assistant();
        msg.usage.cache_write = 400;
        msg.usage.cost.total = 0.0123;
        let e = AgentEvent::AgentEnd {
            messages: vec![AgentMessage::Assistant(Box::new(msg))],
        };
        let v = map_agent_event(&e);
        assert_eq!(v[0]["usage"]["cacheWriteTokens"], 400);
        assert_eq!(v[0]["usage"]["costUsd"], 0.0123);
    }

    // rpi AgentEnd 无 error 字段——RUN_ERROR 语义由 prompt Err 的 POST 分支
    // 承担（竖链移植注）；旧 agent_end_error_maps_run_error 用例随事件族
    // 变化退役，POST 分支的错误路径由实机冒烟覆盖。
    //
    // AutoCompaction 三条用例随旧 pi 事件族退役（rpi 无对应变体——压缩事件
    // 面 = rpi-main 待补能力，追平后按 CUSTOM compaction 形状接回）。

    #[test]
    fn turn_start_and_message_start_unmapped() {
        // rpi 新增 TurnStart/MessageStart——当前映射器不消费（§2.2 表无此
        // 二行；前端无分支）。钉住现状作为将来补齐时的翻转点。
        assert!(map_agent_event(&AgentEvent::TurnStart).is_empty());
        assert!(map_agent_event(&AgentEvent::MessageStart {
            message: AgentMessage::Assistant(Box::new(sample_assistant())),
            message_id: None,
        })
        .is_empty());
    }

    // ---------- parse_images（POST 层校验） ----------

    #[test]
    fn parse_images_rejects_non_allowlisted_mime_and_empty_data() {
        // POST 层白名单：越界 MIME / 空 data = Err（调用方转 400，不静默丢）
        let err = parse_images(&serde_json::json!({ "images": [
            { "data": "aGk=", "mimeType": "image/svg+xml" }
        ]}))
        .expect_err("svg must be rejected");
        assert!(err.contains("unsupported image mimeType"), "{err}");
        let err = parse_images(&serde_json::json!({ "images": [
            { "data": "", "mimeType": "image/png" }
        ]}))
        .expect_err("empty data must be rejected");
        assert!(err.contains("non-empty"), "{err}");
        let ok = parse_images(&serde_json::json!({ "images": [
            { "data": "aGk=", "mimeType": "image/png" },
            { "data": "eg==", "mimeType": "image/webp" }
        ]}))
        .expect("allowlisted images pass");
        assert_eq!(ok.len(), 2);
        assert_eq!(ok[0].mime_type, "image/png");
        // 缺省/Null = 无图
        assert!(parse_images(&serde_json::json!({})).unwrap().is_empty());
        assert!(
            parse_images(&serde_json::json!({ "images": null }))
                .unwrap()
                .is_empty()
        );
        // 形状错（非数组）= Err
        assert!(parse_images(&serde_json::json!({ "images": "nope" })).is_err());
    }

    // turn_start_and_message_start_unmapped 移到映射器测试段（rpi 形状版）。

    #[test]
    fn token_check_rejects_missing_or_wrong() {
        // POST/GET 同款 token 校验（另一代理刚修的 P0-1）
        let st = AguiState::new();
        let token = st.endpoint()["token"].as_str().expect("token").to_string();
        assert!(!st.check_token(None));
        assert!(!st.check_token(Some(&"wrong".to_string())));
        assert!(st.check_token(Some(&token)));
    }

    // ---------- 环形缓冲 ----------

    #[test]
    fn push_shared_seq_starts_at_one_monotonic() {
        let b = empty_buffers();
        assert_eq!(push_shared(&b, "t", serde_json::json!({ "e": 1 })), 1);
        assert_eq!(push_shared(&b, "t", serde_json::json!({ "e": 2 })), 2);
        assert_eq!(push_shared(&b, "t", serde_json::json!({ "e": 3 })), 3);
    }

    #[test]
    fn push_shared_seq_per_thread_isolated() {
        // per-thread 计数器：每个 thread 的 seq 各自从 1 起（§2.1 per-thread）
        let b = empty_buffers();
        assert_eq!(push_shared(&b, "a", serde_json::json!({})), 1);
        assert_eq!(push_shared(&b, "b", serde_json::json!({})), 1);
        assert_eq!(push_shared(&b, "a", serde_json::json!({})), 2);
    }

    #[test]
    fn buffer_cap_evicts_oldest_keeps_seq_continuity() {
        let b = empty_buffers();
        let last = 2500u64;
        for i in 1..=last {
            push_shared(&b, "t", serde_json::json!({ "i": i }));
        }
        let guard = b.lock().expect("buffers poisoned");
        let dq = guard.events.get("t").expect("thread events");
        assert_eq!(dq.len(), BUFFER_CAP);
        // 淘汰最旧后 seq 连续性保持：首条 = last - cap + 1，尾条 = last
        assert_eq!(dq.front().expect("non-empty").0, last - BUFFER_CAP as u64 + 1);
        assert_eq!(dq.back().expect("non-empty").0, last);
        // VecDeque 无 windows：相邻 zip 比对 seq 连续
        assert!(dq
            .iter()
            .zip(dq.iter().skip(1))
            .all(|(a, b)| a.0 + 1 == b.0));
    }

    #[test]
    fn push_shared_concurrent_single_lock_seq_monotonic() {
        // 共享单锁：并发写同一 thread，seq 仍唯一且严格递增（无丢失/重号）
        let b = Arc::new(empty_buffers());
        let handles: Vec<_> = (0..4)
            .map(|_| {
                let b = Arc::clone(&b);
                std::thread::spawn(move || {
                    for i in 0..250u64 {
                        push_shared(&b, "t", serde_json::json!({ "i": i }));
                    }
                })
            })
            .collect();
        for h in handles {
            h.join().expect("pusher thread panicked");
        }
        let guard = b.lock().expect("buffers poisoned");
        let dq = guard.events.get("t").expect("thread events");
        assert_eq!(dq.len(), 1000);
        assert_eq!(dq.front().expect("non-empty").0, 1);
        assert_eq!(dq.back().expect("non-empty").0, 1000);
        assert!(dq
            .iter()
            .zip(dq.iter().skip(1))
            .all(|(a, b)| a.0 + 1 == b.0));
    }

    #[test]
    fn drain_filters_after_seq_readonly() {
        let st = AguiState::new();
        for i in 1..=3 {
            st.push("t", serde_json::json!({ "e": i }));
        }
        let first = st.drain("t", 1);
        assert_eq!(
            first.iter().map(|(s, _)| *s).collect::<Vec<_>>(),
            vec![2, 3]
        );
        // 只读过滤不删：同 cursor 再 drain 结果不变（重放语义）
        assert_eq!(st.drain("t", 1), first);
        // 全消费后为空；未知 thread 空默认
        assert!(st.drain("t", 3).is_empty());
        assert!(st.drain("missing", 0).is_empty());
    }

    #[test]
    fn drain_batches_at_200() {
        // SSE 单次放出上限 200（per-thread 单消费的批上限）
        let st = AguiState::new();
        for i in 1..=250u64 {
            st.push("t", serde_json::json!({ "e": i }));
        }
        let batch = st.drain("t", 0);
        assert_eq!(batch.len(), 200);
        assert_eq!(batch.first().expect("non-empty").0, 1);
        let rest = st.drain("t", 200);
        assert_eq!(rest.len(), 50);
        assert_eq!(rest.last().expect("non-empty").0, 250);
    }

    #[test]
    fn latest_seq_tracks_counter() {
        let st = AguiState::new();
        assert_eq!(st.latest_seq("t"), 0);
        st.push("t", serde_json::json!({}));
        st.push("t", serde_json::json!({}));
        assert_eq!(st.latest_seq("t"), 2);
        // 未知 thread = 0（前端挂载时作 lastEventId 起点照常可用）
        assert_eq!(st.latest_seq("missing"), 0);
    }

    // ---------- 审批注册表（§4.4） ----------

    #[test]
    fn register_then_list_returns_request() {
        let reg = ApprovalRegistry::default();
        let (tx, _rx) = tokio::sync::oneshot::channel::<UiAnswer>();
        let request = serde_json::json!({ "id": "ap-1", "method": "confirm" });
        reg.register("ap-1".into(), request.clone(), tx);
        // 挂载/刷新拉取（§4.4 pending_approvals 列表）
        assert_eq!(reg.list(), vec![request]);
    }

    #[test]
    fn respond_resolves_oneshot_and_consumes_id() {
        let reg = ApprovalRegistry::default();
        let (tx, mut rx) = tokio::sync::oneshot::channel::<UiAnswer>();
        reg.register("ap-1".into(), serde_json::json!({ "id": "ap-1" }), tx);
        reg
            .respond("ap-1", answer(Some(serde_json::json!({ "allow": true })), false))
            .expect("respond should resolve");
        // oneshot 回灌到达宿主桥（§4.4）
        let got = rx.try_recv().expect("answer should arrive");
        assert!(got.value.is_some());
        assert!(!got.cancelled);
        // 应答即出列：list 空、重复 respond = Err（不假装成功）
        assert!(reg.list().is_empty());
        assert!(
            reg.respond("ap-1", answer(None, true)).is_err(),
            "responded id must be consumed"
        );
    }

    #[test]
    fn respond_unknown_id_is_err() {
        // 错误即错误：id 不存在必须 Err（兜底禁令）
        let reg = ApprovalRegistry::default();
        let err = reg
            .respond("nope", answer(None, false))
            .expect_err("unknown id must error");
        assert!(err.contains("no pending approval"));
    }

    #[test]
    fn respond_after_receiver_drop_is_err() {
        // 宿主桥侧 await 已被丢弃（上游超时放弃/会话 discard 中止扩展
        // 任务）——oneshot send 失败必须传播为 Err（P1-3：不假装成功）
        let reg = ApprovalRegistry::default();
        let (tx, rx) = tokio::sync::oneshot::channel::<UiAnswer>();
        reg.register("ap-1".into(), serde_json::json!({ "id": "ap-1" }), tx);
        drop(rx);
        let err = reg
            .respond("ap-1", answer(None, true))
            .expect_err("responder gone must error");
        assert!(err.contains("responder gone"));
    }

    #[test]
    fn cleanup_clears_pending_and_drops_responders() {
        // 会话 discard/切换成功后清理（P1-3 防鬼影卡片）：pending 清空，
        // 残留 oneshot 断开 = 宿主桥按 cancelled 回灌 pi（§4.4 故障语义）
        let reg = ApprovalRegistry::default();
        let (tx1, mut rx1) = tokio::sync::oneshot::channel::<UiAnswer>();
        let (tx2, mut rx2) = tokio::sync::oneshot::channel::<UiAnswer>();
        reg.register("ap-1".into(), serde_json::json!({ "id": "ap-1" }), tx1);
        reg.register("ap-2".into(), serde_json::json!({ "id": "ap-2" }), tx2);
        assert_eq!(reg.list().len(), 2);
        reg.cleanup();
        assert!(reg.list().is_empty());
        assert!(matches!(
            rx1.try_recv(),
            Err(tokio::sync::oneshot::error::TryRecvError::Closed)
        ));
        assert!(matches!(
            rx2.try_recv(),
            Err(tokio::sync::oneshot::error::TryRecvError::Closed)
        ));
        // 清理后 respond 同样 Err（id 已随 cleanup 移除）
        assert!(reg.respond("ap-1", answer(None, true)).is_err());
    }
}

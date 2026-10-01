//! L2 AG-UI 桥（docs/pi-integration.md §2/§7-2）：axum 双端点 +
//! per-thread 事件缓冲（sequence 单调）+ AgentEvent→AG-UI 映射器 +
//! ExtensionUiHandler 桥（§4.4 审批/问题卡：请求→缓冲 CUSTOM→前端卡→
//! IPC 应答→oneshot 回灌）。
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
    extract::{Query, Request, State},
    http::{header, HeaderName, HeaderValue, Method, StatusCode},
    middleware,
    response::{IntoResponse, Sse},
    routing::{get, post},
    Json, Router,
};
use pi::sdk::AgentEvent;
use tokio_stream::wrappers::ReceiverStream;
use tower_http::cors::{AllowHeaders, AllowMethods, AllowOrigin, CorsLayer};

const BUFFER_CAP: usize = 2000;
const AGUI_VERSION: &str = "v0.4";

pub struct AguiState {
    pub engine: crate::pi_session::PiEngine,
    token: String,
    port: Mutex<Option<u16>>,
    /// 事件缓冲（handler 桥经 Arc 共享写同一份——扩展 UI 请求也进流）
    buffers: Arc<Mutex<ThreadBuffers>>,
    /// 扩展 UI 请求挂起注册表（§4.4：挂载时拉取 + 应答回灌）
    pub approvals: Arc<ApprovalRegistry>,
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
#[derive(Debug)]
pub struct UiAnswer {
    pub value: Option<serde_json::Value>,
    pub cancelled: bool,
}

#[derive(Default)]
pub struct ApprovalRegistry {
    pending: Mutex<HashMap<String, PendingApproval>>,
}

impl ApprovalRegistry {
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

    /// 挂载/刷新时拉取（§4.4：pending_approvals 列表）
    pub fn list(&self) -> Vec<serde_json::Value> {
        self.pending
            .lock()
            .expect("approval registry poisoned")
            .values()
            .map(|p| p.request.clone())
            .collect()
    }

    /// 应答回灌；id 不存在 = 错误（错误即错误，不静默）。
    /// oneshot send 失败（对端 request_ui 已被丢弃——上游超时放弃/会话
    /// discard 中止扩展任务）也 = 错误（P1-3：不假装成功，前端可见）。
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
    /// 按 cancelled 回灌 pi（§4.4 宿主桥故障语义）。
    pub fn cleanup(&self) {
        self.pending
            .lock()
            .expect("approval registry poisoned")
            .clear();
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
        Self {
            engine,
            token,
            port: Mutex::new(None),
            buffers: Arc::new(Mutex::new(ThreadBuffers::default())),
            approvals,
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
        AgentEvent::AgentStart { .. } => vec![],
        AgentEvent::MessageUpdate {
            assistant_message_event,
            ..
        } => match assistant_message_event {
            pi::model::AssistantMessageEvent::TextDelta { delta, .. } => {
                vec![json!({ "type": "TEXT_MESSAGE_CONTENT", "delta": delta })]
            }
            pi::model::AssistantMessageEvent::ThinkingDelta { delta, .. } => {
                vec![json!({ "type": "THINKING_TEXT_MESSAGE_CONTENT", "delta": delta })]
            }
            pi::model::AssistantMessageEvent::ToolCallStart { .. } => {
                vec![json!({ "type": "TOOL_CALL_START" })]
            }
            pi::model::AssistantMessageEvent::ToolCallDelta { delta, .. } => {
                vec![json!({ "type": "TOOL_CALL_ARGS", "delta": delta })]
            }
            _ => vec![],
        },
        AgentEvent::MessageEnd { .. } => vec![json!({ "type": "TEXT_MESSAGE_END" })],
        AgentEvent::ToolExecutionStart {
            tool_call_id,
            tool_name,
            args,
            ..
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
        AgentEvent::AgentEnd { messages, error, .. } => match error {
            Some(err) => vec![json!({ "type": "RUN_ERROR", "message": err })],
            None => {
                // 用量快照（ContextDisplay 数据面）：取最后一条 assistant
                // 消息的 usage（= 最终 turn 的上下文规模，input 已含历史）
                let usage = messages.iter().rev().find_map(|m| match m {
                    pi::sdk::Message::Assistant(a) => Some(json!({
                        "inputTokens": a.usage.input,
                        "outputTokens": a.usage.output,
                        "cachedInputTokens": a.usage.cache_read,
                        "totalTokens": a.usage.total_tokens,
                    })),
                    _ => None,
                });
                vec![json!({
                    "type": "RUN_FINISHED",
                    "usage": usage,
                })]
            }
        },
        AgentEvent::AutoCompactionStart { reason } => vec![json!({
            "type": "CUSTOM", "name": "compaction", "value": { "phase": "start", "reason": reason },
        })],
        AgentEvent::AutoCompactionEnd { .. } => vec![json!({
            "type": "CUSTOM", "name": "compaction", "value": { "phase": "end" },
        })],
        _ => vec![],
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
    // 会话按需创建（§7-3）：已有活跃会话时原样复用（多轮上下文保持），
    // 无才创建——【关键】不能每次 POST 都 create（否则每条消息换新会话，
    // 上下文全丢）。flush/create 的深递归 future 不能在 tokio worker 栈上
    // block_on——16MiB 大栈线程承载（engine 经 Arc 共享，单会话不变量不破）。
    let st_create = st.clone();
    let thread_bridge = thread.clone();
    let create = tokio::task::spawn_blocking(move || {
        std::thread::Builder::new()
            .name("pi-create".into())
            .stack_size(16 * 1024 * 1024)
            .spawn(move || {
                st_create
                    .engine
                    .ensure_session(Some(st_create.ui_bridge(&thread_bridge)))
            })
            .expect("spawn pi-create thread")
            .join()
            .map_err(|_| "pi-create thread panicked".to_string())
    })
    .await
    .map_err(|e| e.to_string())
    .and_then(|r| r);
    let created = match create {
        Ok(res) => res,
        Err(e) => {
            // P2-1：失败路径只推 RUN_ERROR（payload 带错误信息）——不推无
            // runId 的 RUN_STARTED（前端会残留空消息段；§0.3-1：STARTED
            // 必须挂在真实 run 上）。
            st.push(&thread, serde_json::json!({ "type": "RUN_ERROR", "message": e }));
            return Json(serde_json::json!({ "runId": null, "error": e })).into_response();
        }
    };
    if let Err(e) = created {
        st.push(&thread, serde_json::json!({ "type": "RUN_ERROR", "message": e }));
        return Json(serde_json::json!({ "runId": null, "error": e })).into_response();
    }

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
    let thread2 = thread.clone();
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
            let result = st2.engine.prompt(&message, move |event: AgentEvent| {
                for v in map_agent_event(&event) {
                    sink.push(&thread2, v);
                }
            }, on_start);
            if let Err(e) = result {
                err_sink.push(&err_thread, serde_json::json!({ "type": "RUN_ERROR", "message": e }));
            }
        })
        .expect("spawn pi-prompt thread");
    Json(serde_json::json!({ "runId": run_id })).into_response()
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
    //! agui 单元测试（§7-2 欠债：§2.2 事件映射表逐行 + 环形缓冲语义 +
    //! 审批注册表）。pi 事件样本按上游真实形状构造（G:\pi_agent_rust-main
    //! 的 src/agent.rs AgentEvent、src/model.rs AssistantMessageEvent/
    //! Usage/ToolCall、src/tools.rs ToolOutput），只 import pi::sdk /
    //! pi::model / pi::tools 的事件类型面。全部同步断言（oneshot 用
    //! try_recv，不依赖 tokio rt feature 进 dev 依赖）。

    use super::*;
    use pi::model::{AssistantMessage, AssistantMessageEvent, Message, Usage};
    use pi::tools::ToolOutput;

    // ---------- 样本助手 ----------

    fn sess() -> Arc<str> {
        Arc::from("sess-test")
    }

    /// 流式事件携带的累积 assistant 快照（AssistantMessageEvent 全家族
    /// 变体都带 partial——映射器不读它，Default 即最小合法样本）。
    fn partial() -> Arc<AssistantMessage> {
        Arc::new(AssistantMessage::default())
    }

    fn msg_update(ev: AssistantMessageEvent) -> AgentEvent {
        AgentEvent::MessageUpdate {
            message: Message::assistant(AssistantMessage::default()),
            assistant_message_event: ev,
        }
    }

    fn tool_out() -> ToolOutput {
        ToolOutput {
            content: vec![],
            details: None,
            is_error: false,
        }
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
        let e = AgentEvent::AgentStart { session_id: sess() };
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
            message: Message::assistant(AssistantMessage::default()),
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
        // 同上：翻转点用例，本轮不改正事逻辑。
        let e = msg_update(AssistantMessageEvent::ToolCallEnd {
            content_index: 2,
            tool_call: pi::model::ToolCall {
                id: "tc-1".into(),
                name: "read".into(),
                arguments: serde_json::json!({ "path": "G:/x" }),
                thought_signature: None,
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
            partial_result: tool_out(),
        };
        let v = map_agent_event(&e);
        assert_eq!(v.len(), 1);
        assert_eq!(v[0]["type"], "CUSTOM");
        assert_eq!(v[0]["name"], "tool_execution");
        assert_eq!(v[0]["value"]["phase"], "update");
        assert_eq!(v[0]["value"]["toolCallId"], "tc-1");
        // partial 是 pi ToolOutput 的序列化（content 数组 + isError skip）
        assert!(v[0]["value"]["partial"].is_object());
        assert_eq!(v[0]["value"]["partial"]["content"], serde_json::json!([]));
    }

    #[test]
    fn tool_execution_end_maps_custom_with_result_and_error_flag() {
        let mut result = tool_out();
        result.is_error = true;
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
        assert_eq!(v[0]["value"]["result"]["isError"], true);
    }

    #[test]
    fn turn_end_maps_step_finished() {
        let e = AgentEvent::TurnEnd {
            session_id: sess(),
            turn_index: 0,
            message: Message::assistant(AssistantMessage::default()),
            tool_results: vec![],
            latency_breakdown: None,
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
        let e = AgentEvent::AgentEnd {
            session_id: sess(),
            messages: vec![Message::assistant(AssistantMessage {
                usage: Usage {
                    input: 1234,
                    output: 567,
                    cache_read: 89,
                    total_tokens: 1801,
                    ..Default::default()
                },
                ..Default::default()
            })],
            error: None,
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
        let e = AgentEvent::AgentEnd {
            session_id: sess(),
            messages: vec![],
            error: None,
        };
        let v = map_agent_event(&e);
        assert_eq!(v.len(), 1);
        assert_eq!(v[0]["type"], "RUN_FINISHED");
        assert!(v[0]["usage"].is_null());
    }

    #[test]
    fn agent_end_error_maps_run_error() {
        let e = AgentEvent::AgentEnd {
            session_id: sess(),
            messages: vec![],
            error: Some("provider down".into()),
        };
        let v = map_agent_event(&e);
        assert_eq!(v.len(), 1);
        assert_eq!(v[0]["type"], "RUN_ERROR");
        assert_eq!(v[0]["message"], "provider down");
    }

    #[test]
    fn auto_compaction_maps_custom() {
        let v = map_agent_event(&AgentEvent::AutoCompactionStart {
            reason: "context full".into(),
        });
        assert_eq!(v.len(), 1);
        assert_eq!(v[0]["type"], "CUSTOM");
        assert_eq!(v[0]["name"], "compaction");
        assert_eq!(v[0]["value"]["phase"], "start");
        assert_eq!(v[0]["value"]["reason"], "context full");

        let v = map_agent_event(&AgentEvent::AutoCompactionEnd {
            result: None,
            aborted: false,
            will_retry: false,
            error_message: None,
        });
        assert_eq!(v.len(), 1);
        assert_eq!(v[0]["type"], "CUSTOM");
        assert_eq!(v[0]["name"], "compaction");
        assert_eq!(v[0]["value"]["phase"], "end");
    }

    #[test]
    fn turn_start_and_message_start_unmapped() {
        // §2.2 行 2：TurnStart 内部计数不外发；MessageStart 无映射行。
        // 两者 fall-through 空 vec 是有意行为。
        let ts = AgentEvent::TurnStart {
            session_id: sess(),
            turn_index: 0,
            timestamp: 0,
        };
        assert!(map_agent_event(&ts).is_empty());
        let ms = AgentEvent::MessageStart {
            message: Message::assistant(AssistantMessage::default()),
        };
        assert!(map_agent_event(&ms).is_empty());
    }

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

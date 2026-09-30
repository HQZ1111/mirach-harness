//! L2 AG-UI 桥（docs/pi-integration.md §2/§7-2）：axum 双端点 +
//! per-thread 事件缓冲（sequence 单调）+ AgentEvent→AG-UI 映射器。
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
    extract::{Query, State},
    http::StatusCode,
    response::{ IntoResponse, Sse},
    routing::{get, post},
    Json, Router,
};
use pi::sdk::AgentEvent;
use tokio_stream::wrappers::ReceiverStream;
use tower_http::cors::CorsLayer;

const BUFFER_CAP: usize = 2000;
const AGUI_VERSION: &str = "v0.4";

pub struct AguiState {
    pub engine: crate::pi_session::PiEngine,
    token: String,
    port: Mutex<Option<u16>>,
    buffers: Mutex<ThreadBuffers>,
}

#[derive(Default)]
struct ThreadBuffers {
    counters: HashMap<String, u64>,
    events: HashMap<String, VecDeque<(u64, String)>>,
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
        Self {
            engine: crate::pi_session::PiEngine::new(),
            token,
            port: Mutex::new(None),
            buffers: Mutex::new(ThreadBuffers::default()),
        }
    }

    pub fn set_port(&self, port: u16) {
        *self.port.lock().expect("agui port poisoned") = Some(port);
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
        let mut b = self.buffers.lock().expect("agui buffers poisoned");
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
            ..
        } => vec![json!({
            "type": "CUSTOM", "name": "tool_execution",
            "value": { "phase": "start", "toolCallId": tool_call_id, "toolName": tool_name },
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
            is_error,
            ..
        } => vec![json!({
            "type": "CUSTOM", "name": "tool_execution",
            "value": { "phase": "end", "toolCallId": tool_call_id, "isError": is_error },
        })],
        AgentEvent::TurnEnd { .. } => vec![json!({ "type": "STEP_FINISHED" })],
        AgentEvent::AgentEnd { error, .. } => match error {
            Some(err) => vec![json!({ "type": "RUN_ERROR", "message": err })],
            None => vec![json!({ "type": "RUN_FINISHED" })],
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
    // 会话按需创建（§7-3 冒烟路径；无 API key 时错误以 RUN_ERROR 进缓冲可观测）。
    // create_session 的 future 同源深递归，不能在 tokio worker 栈上 block_on——
    // 挪 16MiB 大栈线程同步等结果（engine 经 Arc 共享，单会话不变量不破）。
    let st_create = st.clone();
    let create = tokio::task::spawn_blocking(move || {
        std::thread::Builder::new()
            .name("pi-create".into())
            .stack_size(16 * 1024 * 1024)
            .spawn(move || st_create.engine.create_session(None, None))
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
            st.push(&thread, serde_json::json!({ "type": "RUN_STARTED", "threadId": thread }));
            st.push(&thread, serde_json::json!({ "type": "RUN_ERROR", "message": e }));
            return Json(serde_json::json!({ "runId": null, "error": e })).into_response();
        }
    };
    if let Err(e) = created {
        st.push(&thread, serde_json::json!({ "type": "RUN_STARTED", "threadId": thread }));
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
    st.push(&thread, serde_json::json!({ "type": "RUN_STARTED", "threadId": thread, "runId": run_id }));

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
            let result = st2.engine.prompt(&message, move |event: AgentEvent| {
                for v in map_agent_event(&event) {
                    sink.push(&thread2, v);
                }
            });
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
) -> axum::response::Response {
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
    let mut cursor: u64 = q.get("lastEventId").and_then(|s| s.parse().ok()).unwrap_or(0);
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

pub fn router(state: Arc<AguiState>) -> Router {
    Router::new()
        .route("/ag-ui", post(agui_run))
        .route("/ag-ui/stream", get(agui_stream))
        .route("/healthz", get(healthz))
        .layer(CorsLayer::very_permissive())
        .with_state(state)
}

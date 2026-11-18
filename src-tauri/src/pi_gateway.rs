//! 跨网关传输（2026-11-18）：hermes Desktop 的 gateway transport 对偶。
//!
//! 上游事实（`apps/shared/src/json-rpc-gateway.ts` / `tui_gateway/ws.py`）：
//! **唯一**线上协议 = JSON-RPC 2.0 over 一条 WebSocket `GET /api/ws`，
//! `?token=<token>` 认证；accept 后第一帧必是 `gateway.ready` 通知
//! （`method:"event"`, `params.type:"gateway.ready"`, payload 带
//! `heartbeat/replay_epoch`）；服务端推送 = 无 id 的 `method:"event"` 通知；
//! 服务端→客户端请求 = **字符串 id** + method（clarify/approval），客户端答
//! `{jsonrpc,id,result|error}`；请求 id 客户端自造（r1, r2, …）。
//!
//! 本模块只做主机的**客户端**半边（连接注册表里 kind=remote/cloud/ssh 的
//! 连接）：`pi_gateway_call` 发 RPC、推送转 Tauri 事件（`mirach:plugin:<type>`，
//! 与 host.onEvent 的点号→冒号映射同源）。对端网关可以是 hermes 网关，
//! 也可以是另一个 mirach（同一组方法名）。
//!
//! 规矩 12：连接失败/超时/RPC 错误全部 Err，不静默降级；重连是显式策略
//! （2^n 退避到 30s），状态在 `pi_gateway_status` 可见。

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;

struct GatewayConn {
    tx: mpsc::UnboundedSender<String>,
    pending: Arc<Mutex<HashMap<String, oneshot::Sender<Result<Value, String>>>>>,
    status: Arc<Mutex<Value>>,
    alive: Arc<AtomicBool>,
}

fn registry() -> &'static Mutex<HashMap<String, GatewayConn>> {
    static CELL: OnceLock<Mutex<HashMap<String, GatewayConn>>> = OnceLock::new();
    CELL.get_or_init(|| Mutex::new(HashMap::new()))
}

fn next_request_id() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(1);
    format!("r{}", COUNTER.fetch_add(1, Ordering::SeqCst))
}

/// 连接 URL 归一化（hermes `buildGatewayWsUrl` 同判）：
/// `http(s)://host[:port][/prefix]` → `ws(s)://host[:port][/prefix]/api/ws?token=`。
/// 已是 ws(s) 的原样保留；token 用查询参数（远端连接的标准形态）。
pub fn gateway_ws_url(base: &str, token: Option<&str>) -> Result<String, String> {
    let raw = base.trim().trim_end_matches('/');
    if raw.is_empty() {
        return Err("连接 url 为空".into());
    }
    let with_scheme = if let Some(rest) = raw.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = raw.strip_prefix("http://") {
        format!("ws://{rest}")
    } else if raw.starts_with("wss://") || raw.starts_with("ws://") {
        raw.to_string()
    } else {
        return Err("连接 url 需要 http(s):// 或 ws(s):// 前缀".into());
    };
    let (scheme, rest) = with_scheme
        .split_once("://")
        .ok_or_else(|| "连接 url 不是合法 URL".to_string())?;
    let (host, path) = match rest.find('/') {
        Some(index) => (&rest[..index], &rest[index..]),
        None => (rest, ""),
    };
    if host.is_empty() {
        return Err("连接 url 缺少主机".into());
    }
    let path = if path.is_empty() || path == "/" {
        "/api/ws".to_string()
    } else if path.ends_with("/api/ws") {
        path.to_string()
    } else {
        format!("{}/api/ws", path.trim_end_matches('/'))
    };
    let mut out = format!("{scheme}://{host}{path}");
    if let Some(token) = token.map(str::trim).filter(|t| !t.is_empty()) {
        let encoded: String = token
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '~') {
                    c.to_string()
                } else {
                    format!("%{:02X}", c as u32 & 0xFF)
                }
            })
            .collect();
        out.push_str(if out.contains('?') { "&" } else { "?" });
        out.push_str("token=");
        out.push_str(&encoded);
    }
    Ok(out)
}

/// 一帧的解析结果（纯函数，便于单测）。
#[derive(Debug, PartialEq)]
pub enum FrameAction {
    /// 响应帧：{id, result|error}
    Response {
        id: String,
        result: Result<Value, String>,
    },
    /// 推送通知：{method:"event", params:{type, ...}} → 事件名 + 载荷
    Notification { event: String, payload: Value },
    /// 服务端→客户端请求（字符串 id + method）：本宿主一律答 -32601
    ServerRequest { id: Value },
    /// 不认识（心跳等）：忽略
    Ignore,
}

pub fn parse_frame(text: &str) -> FrameAction {
    let Ok(value) = serde_json::from_str::<Value>(text) else {
        return FrameAction::Ignore;
    };
    let method = value.get("method").and_then(Value::as_str);
    match (value.get("id"), method) {
        // 响应：有 id、没有 method
        (Some(id), None) => {
            if let Some(error) = value.get("error") {
                let message = error
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("gateway rpc error")
                    .to_string();
                return FrameAction::Response {
                    id: id.as_str().map(str::to_owned).unwrap_or_else(|| id.to_string()),
                    result: Err(message),
                };
            }
            FrameAction::Response {
                id: id.as_str().map(str::to_owned).unwrap_or_else(|| id.to_string()),
                result: Ok(value.get("result").cloned().unwrap_or(Value::Null)),
            }
        }
        // 推送通知
        (None, Some("event")) => {
            let Some(params) = value.get("params") else {
                return FrameAction::Ignore;
            };
            let Some(event_type) = params.get("type").and_then(Value::as_str) else {
                return FrameAction::Ignore;
            };
            let channel = format!("mirach:plugin:{}", event_type.replace(['.', '/'], ":"));
            FrameAction::Notification {
                event: channel,
                payload: params.clone(),
            }
        }
        // 服务端→客户端请求
        (Some(id), Some(_)) => FrameAction::ServerRequest { id: id.clone() },
        _ => FrameAction::Ignore,
    }
}

async fn supervise(
    app: AppHandle,
    connection_id: String,
    ws_url: String,
    mut out_rx: mpsc::UnboundedReceiver<String>,
    pending: Arc<Mutex<HashMap<String, oneshot::Sender<Result<Value, String>>>>>,
    status: Arc<Mutex<Value>>,
    alive: Arc<AtomicBool>,
) {
    let mut backoff_secs: u64 = 1;
    loop {
        if !alive.load(Ordering::SeqCst) {
            break;
        }
        let request = match ws_url.as_str().into_client_request() {
            Ok(request) => request,
            Err(e) => {
                *status.lock().expect("gateway status poisoned") =
                    json!({ "state": "closed", "error": format!("WS 请求构造失败: {e}") });
                return;
            }
        };
        match tokio_tungstenite::connect_async(request).await {
            Ok((socket, _)) => {
                backoff_secs = 1;
                *status.lock().expect("gateway status poisoned") =
                    json!({ "state": "open", "error": null });
                let (mut sink, mut stream) = socket.split();
                loop {
                    tokio::select! {
                        outgoing = out_rx.recv() => {
                            match outgoing {
                                Some(text) => {
                                    if let Err(e) = sink.send(Message::Text(text.into())).await {
                                        eprintln!("[gateway] {connection_id} 发送失败: {e}");
                                        break;
                                    }
                                }
                                None => {
                                    // 注册表条目被移除（pi_gateway_disconnect）
                                    let _ = sink.send(Message::Close(None)).await;
                                    *status.lock().expect("gateway status poisoned") =
                                        json!({ "state": "closed", "error": null });
                                    return;
                                }
                            }
                        }
                        incoming = stream.next() => {
                            match incoming {
                                Some(Ok(Message::Text(text))) => {
                                    handle_incoming(&app, &connection_id, &text, &pending, &mut sink).await;
                                }
                                Some(Ok(Message::Binary(bytes))) => {
                                    match String::from_utf8(bytes.to_vec()) {
                                        Ok(text) => handle_incoming(&app, &connection_id, &text, &pending, &mut sink).await,
                                        Err(e) => eprintln!("[gateway] {connection_id} 非 UTF-8 帧: {e}"),
                                    }
                                }
                                Some(Ok(Message::Close(_))) | None => break,
                                Some(Err(e)) => {
                                    eprintln!("[gateway] {connection_id} 读失败: {e}");
                                    break;
                                }
                                _ => {}
                            }
                        }
                    }
                }
                *status.lock().expect("gateway status poisoned") =
                    json!({ "state": "closed", "error": "连接断开" });
            }
            Err(e) => {
                *status.lock().expect("gateway status poisoned") =
                    json!({ "state": "closed", "error": format!("连接失败: {e}") });
                eprintln!("[gateway] {connection_id} 连接失败: {e}");
            }
        }
        if !alive.load(Ordering::SeqCst) {
            break;
        }
        tokio::time::sleep(Duration::from_secs(backoff_secs)).await;
        backoff_secs = (backoff_secs * 2).min(30);
    }
}

async fn handle_incoming(
    app: &AppHandle,
    connection_id: &str,
    text: &str,
    pending: &Arc<Mutex<HashMap<String, oneshot::Sender<Result<Value, String>>>>>,
    sink: &mut futures_util::stream::SplitSink<
        tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
        Message,
    >,
) {
    match parse_frame(text) {
        FrameAction::Response { id, result } => {
            let sender = pending.lock().expect("gateway pending poisoned").remove(&id);
            if let Some(sender) = sender {
                let _ = sender.send(result);
            }
        }
        FrameAction::Notification { event, mut payload } => {
            if let Some(object) = payload.as_object_mut() {
                object.insert("connectionId".into(), json!(connection_id));
            }
            if let Err(e) = app.emit(&event, payload) {
                eprintln!("[gateway] 事件 {event} 发送失败: {e}");
            }
        }
        FrameAction::ServerRequest { id } => {
            // 宿主暂不实现服务端请求（clarify/approval 走本机引擎桥）——
            // 按 JSON-RPC 规范答 -32601，让对端走各自降级分支。
            let reply = json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": { "code": -32601, "message": "host does not implement server requests over gateway transport" },
            });
            let _ = sink.send(Message::Text(reply.to_string().into())).await;
        }
        FrameAction::Ignore => {}
    }
}

/// 建连（幂等：已连接则先断开再连）。远端连接由 `pi_gateway_call` 按需触发。
pub fn connect(
    app: AppHandle,
    connection_id: &str,
    base_url: &str,
    token: Option<&str>,
) -> Result<Value, String> {
    let ws_url = gateway_ws_url(base_url, token)?;
    disconnect(connection_id);
    let (out_tx, out_rx) = mpsc::unbounded_channel::<String>();
    let pending: Arc<Mutex<HashMap<String, oneshot::Sender<Result<Value, String>>>>> =
        Arc::new(Mutex::new(HashMap::new()));
    let status = Arc::new(Mutex::new(json!({ "state": "connecting", "error": null })));
    let alive = Arc::new(AtomicBool::new(true));
    registry().lock().expect("gateway registry poisoned").insert(
        connection_id.to_owned(),
        GatewayConn {
            tx: out_tx,
            pending: Arc::clone(&pending),
            status: Arc::clone(&status),
            alive: Arc::clone(&alive),
        },
    );
    let app_for_task = app.clone();
    let cid = connection_id.to_owned();
    tauri::async_runtime::spawn(async move {
        supervise(app_for_task, cid, ws_url, out_rx, pending, status, alive).await;
    });
    Ok(json!({ "state": "connecting" }))
}

/// 断开（幂等）：置 alive=false + 移除注册表条目（发送通道随之关闭）。
pub fn disconnect(connection_id: &str) -> Value {
    if let Some(conn) = registry()
        .lock()
        .expect("gateway registry poisoned")
        .remove(connection_id)
    {
        conn.alive.store(false, Ordering::SeqCst);
        return json!({ "state": "closed" });
    }
    json!({ "state": "closed" })
}

pub fn status() -> Value {
    let mut out = serde_json::Map::new();
    let guard = registry().lock().expect("gateway registry poisoned");
    for (id, conn) in guard.iter() {
        out.insert(
            id.clone(),
            conn.status.lock().expect("gateway status poisoned").clone(),
        );
    }
    json!(out)
}

/// 发一次网关 RPC 并等响应（超时 default 30s；prompt.submit 由调用方给 30min）。
pub async fn call(
    connection_id: &str,
    method: &str,
    params: Value,
    timeout_ms: Option<u64>,
) -> Result<Value, String> {
    let (tx, pending, status) = {
        let guard = registry().lock().expect("gateway registry poisoned");
        let Some(conn) = guard.get(connection_id) else {
            return Err(format!("网关连接 {connection_id} 未建立（先 pi_gateway_connect）"));
        };
        let status = conn
            .status
            .lock()
            .expect("gateway status poisoned")
            .clone();
        (conn.tx.clone(), Arc::clone(&conn.pending), status)
    };
    if status.get("state").and_then(Value::as_str) != Some("open") {
        return Err(format!(
            "网关连接 {connection_id} 不可用：{}",
            status
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("未就绪")
        ));
    }
    let id = next_request_id();
    let (response_tx, response_rx) = oneshot::channel();
    pending
        .lock()
        .expect("gateway pending poisoned")
        .insert(id.clone(), response_tx);
    let frame = json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": method,
        "params": params,
    });
    tx.send(frame.to_string())
        .map_err(|_| format!("网关连接 {connection_id} 已关闭"))?;
    match tokio::time::timeout(
        Duration::from_millis(timeout_ms.unwrap_or(30_000)),
        response_rx,
    )
    .await
    {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err(format!("网关 {connection_id} 响应通道断开")),
        Err(_) => {
            pending
                .lock()
                .expect("gateway pending poisoned")
                .remove(&id);
            Err(format!("网关 {connection_id} 的 {method} 超时"))
        }
    }
}

/// 一次性探测远端网关：开 WS → 等首个 `gateway.ready` → 关闭。
/// 供连接注册表「测试」按钮使用（不注册长连接、不影响后台 supervisor）。
pub async fn probe(base_url: &str, token: Option<&str>, timeout_ms: u64) -> Result<Value, String> {
    let ws_url = gateway_ws_url(base_url, token)?;
    let request = ws_url
        .as_str()
        .into_client_request()
        .map_err(|e| format!("网关 URL 无效: {e}"))?;
    let timeout = Duration::from_millis(timeout_ms);
    let (mut socket, _) = tokio::time::timeout(timeout, tokio_tungstenite::connect_async(request))
        .await
        .map_err(|_| format!("连接网关超时（{timeout_ms}ms）"))?
        .map_err(|e| format!("连接网关失败: {e}"))?;
    let ready = tokio::time::timeout(timeout, async {
        loop {
            match socket.next().await {
                Some(Ok(Message::Text(text))) => {
                    let frame: Value = serde_json::from_str(text.as_str())
                        .map_err(|e| format!("网关首帧不是 JSON: {e}"))?;
                    let is_ready = frame.get("method").and_then(Value::as_str) == Some("event")
                        && frame
                            .get("params")
                            .and_then(|params| params.get("type"))
                            .and_then(Value::as_str)
                            == Some("gateway.ready");
                    if is_ready {
                        return Ok(frame.get("params").cloned().unwrap_or(Value::Null));
                    }
                }
                Some(Ok(Message::Close(_))) => {
                    return Err("网关在 gateway.ready 前关闭了连接".to_string())
                }
                Some(Ok(_)) => continue,
                Some(Err(e)) => return Err(format!("网关读取失败: {e}")),
                None => return Err("网关在 gateway.ready 前断开".to_string()),
            }
        }
    })
    .await
    .map_err(|_| format!("等待 gateway.ready 超时（{timeout_ms}ms）"))??;
    let _ = socket.close(None).await;
    Ok(ready)
}

// ── IPC ─────────────────────────────────────────────────────────────────────

#[tauri::command(rename_all = "camelCase", async)]
pub fn pi_gateway_connect(
    app: AppHandle,
    connection_id: String,
    url: String,
    token: Option<String>,
) -> Result<Value, String> {
    let connection_id = connection_id.trim();
    // token 未显式传入 = 用连接注册表 keyring 里存的那份（UI 从不回显 token）。
    let token = match token {
        Some(token) => Some(token),
        None => crate::pi_connections::connection_token(connection_id)?,
    };
    connect(app, connection_id, url.trim(), token.as_deref())
}

#[tauri::command(rename_all = "camelCase", async)]
pub fn pi_gateway_disconnect(connection_id: String) -> Result<Value, String> {
    Ok(disconnect(connection_id.trim()))
}

#[tauri::command(rename_all = "camelCase", async)]
pub fn pi_gateway_status() -> Result<Value, String> {
    Ok(status())
}

#[tauri::command(rename_all = "camelCase", async)]
pub async fn pi_gateway_call(
    connection_id: String,
    method: String,
    params: Option<Value>,
    timeout_ms: Option<u64>,
) -> Result<Value, String> {
    call(
        connection_id.trim(),
        method.trim(),
        params.unwrap_or_else(|| json!({})),
        timeout_ms,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ws_url_normalization() {
        assert_eq!(
            gateway_ws_url("http://127.0.0.1:9119", None).unwrap(),
            "ws://127.0.0.1:9119/api/ws"
        );
        assert_eq!(
            gateway_ws_url("https://gw.example.com/hermes/", Some("tok 1")).unwrap(),
            "wss://gw.example.com/hermes/api/ws?token=tok%201"
        );
        assert_eq!(
            gateway_ws_url("ws://host:1/custom/api/ws", Some("abc")).unwrap(),
            "ws://host:1/custom/api/ws?token=abc"
        );
        assert!(gateway_ws_url("", None).is_err());
        assert!(gateway_ws_url("host:9119", None).is_err());
        assert!(gateway_ws_url("ftp://host", None).is_err());
    }

    #[test]
    fn frame_parsing() {
        // 响应
        match parse_frame(r#"{"jsonrpc":"2.0","id":"r1","result":{"ok":true}}"#) {
            FrameAction::Response { id, result } => {
                assert_eq!(id, "r1");
                assert_eq!(result.unwrap()["ok"], true);
            }
            other => panic!("expected response, got {other:?}"),
        }
        // 错误响应
        match parse_frame(r#"{"jsonrpc":"2.0","id":"r2","error":{"code":-32601,"message":"no"}}"#) {
            FrameAction::Response { id, result } => {
                assert_eq!(id, "r2");
                assert!(result.is_err());
            }
            other => panic!("expected response, got {other:?}"),
        }
        // 推送
        match parse_frame(
            r#"{"jsonrpc":"2.0","method":"event","params":{"type":"message.delta","session_id":"s1"}}"#,
        ) {
            FrameAction::Notification { event, payload } => {
                assert_eq!(event, "mirach:plugin:message:delta");
                assert_eq!(payload["session_id"], "s1");
            }
            other => panic!("expected notification, got {other:?}"),
        }
        // 服务端请求（字符串 id）
        match parse_frame(r#"{"jsonrpc":"2.0","id":"srv-1","method":"clarify","params":{}}"#) {
            FrameAction::ServerRequest { id } => assert_eq!(id, "srv-1"),
            other => panic!("expected server request, got {other:?}"),
        }
        // 垃圾帧
        assert_eq!(parse_frame("not json"), FrameAction::Ignore);
    }
}

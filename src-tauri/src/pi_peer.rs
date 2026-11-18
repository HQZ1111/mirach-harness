//! 跨网关 hosted-room（peer lending）宿主服务（2026-11-18 第五波）。
//!
//! hermes 的 hosted-room peer 面是「网关 A 把 bot 借给网关 B 的房间」：B 侧
//! operator 发 grant，A 侧 register，随后 B 的 canonical driver 通过
//! **HTTP Runs 面**给 A 的 bot 会话投喂轮次。宿主没有 hermes 那套网关
//! WS 服务端，所以这里做 **mirach 原生 peer 面**（同一思路、最小面）：
//!
//! - 服务端（本机）：`127.0.0.1:9731`（`MIRACH_PEER_BIND` 可覆盖绑定地址，
//!   跨机部署时由操作者显式暴露），Bearer 配对令牌（OS 凭据管理器
//!   `mirach.peer/token`，首次启动生成）；
//! - 端点：`GET /v1/mirach/status`（探测，无鉴权）/ `GET /v1/mirach/bots`
//!   （公开名册，前端 publish）/ `POST /v1/mirach/sessions`（建 bot 泳道会话）/
//!   `GET /v1/mirach/sessions/:id`（running + transcript）/
//!   `POST .../prompt`、`.../interrupt`、`.../compact`；
//! - 客户端：连接名册里 kind=remote/cloud/ssh 且 `url` 指向 mirach 的条目由
//!   `pi_peer_connect` 探活并登记；`pi_gateway_call` 对已登记连接改走
//!   `pi_peer_call`，于是 canonical driver 的 remote 路由（session.create /
//!   resume / prompt.submit / interrupt / approval）原生跨机器工作。
//!
//! 规矩 12：未知方法、鉴权失败、对端不是 mirach、HTTP 错误全部 Err/4xx，
//! 不静默降级；会话 transcript 读文件失败同样传播。

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{json, Map, Value};
use tauri::AppHandle;

const TOKEN_SERVICE: &str = "mirach.peer";
const TOKEN_ENTRY: &str = "token";
const DEFAULT_PORT: u16 = 9731;

pub struct PeerServer {
    app: AppHandle,
    token: String,
    bots: Mutex<Vec<Value>>,
    port: u16,
}

static SERVER: OnceLock<Arc<PeerServer>> = OnceLock::new();

#[derive(Clone)]
struct PeerConn {
    connection_id: String,
    url: String,
    token: Option<String>,
}

fn peer_conns() -> &'static Mutex<HashMap<String, PeerConn>> {
    static CELL: OnceLock<Mutex<HashMap<String, PeerConn>>> = OnceLock::new();
    CELL.get_or_init(|| Mutex::new(HashMap::new()))
}

fn load_or_create_token() -> Result<String, String> {
    let entry = keyring::Entry::new(TOKEN_SERVICE, TOKEN_ENTRY)
        .map_err(|e| format!("peer 令牌读取失败: {e}"))?;
    match entry.get_password() {
        Ok(token) if token.trim().len() >= 32 => Ok(token.trim().to_string()),
        Ok(_) | Err(keyring::Error::NoEntry) => {
            let token = format!(
                "{}{}",
                uuid::Uuid::new_v4().simple(),
                uuid::Uuid::new_v4().simple()
            );
            entry
                .set_password(&token)
                .map_err(|e| format!("peer 令牌写入失败: {e}"))?;
            Ok(token)
        }
        Err(e) => Err(format!("peer 令牌读取失败: {e}")),
    }
}

fn bind_addr(port: u16) -> String {
    let host = std::env::var("MIRACH_PEER_BIND")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "127.0.0.1".into());
    format!("{host}:{port}")
}

fn peer_port() -> u16 {
    std::env::var("MIRACH_PEER_PORT")
        .ok()
        .and_then(|raw| raw.trim().parse::<u16>().ok())
        .unwrap_or(DEFAULT_PORT)
}

/// 启动 peer 服务（幂等：已在跑就直接返回）。失败原样 Err——调用方（setup）
/// 决定是否致命；这里不吞。
pub fn ensure_server(app: AppHandle) -> Result<Arc<PeerServer>, String> {
    if let Some(server) = SERVER.get() {
        return Ok(Arc::clone(server));
    }
    let token = load_or_create_token()?;
    let port = peer_port();
    let server = Arc::new(PeerServer {
        app,
        token,
        bots: Mutex::new(Vec::new()),
        port,
    });
    let _ = SERVER.set(Arc::clone(&server));
    let serving = Arc::clone(&server);
    tauri::async_runtime::spawn(async move {
        let addr = bind_addr(serving.port);
        let listener = match tokio::net::TcpListener::bind(&addr).await {
            Ok(listener) => listener,
            Err(e) => {
                eprintln!("[peer] 绑定 {addr} 失败: {e}");
                return;
            }
        };
        if let Err(e) = axum::serve(listener, router(Arc::clone(&serving))).await {
            eprintln!("[peer] 服务退出: {e}");
        }
    });
    Ok(server)
}

fn router(server: Arc<PeerServer>) -> Router {
    Router::new()
        .route("/v1/mirach/status", get(peer_status))
        .route("/v1/mirach/bots", get(peer_bots))
        .route("/v1/mirach/sessions", post(peer_create_session))
        .route("/v1/mirach/sessions/{id}", get(peer_session_state))
        .route("/v1/mirach/sessions/{id}/prompt", post(peer_prompt))
        .route("/v1/mirach/sessions/{id}/interrupt", post(peer_interrupt))
        .route("/v1/mirach/sessions/{id}/compact", post(peer_compact))
        .with_state(server)
}

fn unauthorized() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        Json(json!({"error": {"code": "invalid_token", "message": "peer 配对令牌无效"}})),
    )
        .into_response()
}

fn bearer_matches(header: Option<&str>, expected: &str) -> bool {
    header
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(|token| token.trim() == expected)
        .unwrap_or(false)
}

fn authorized(headers: &HeaderMap, server: &PeerServer) -> bool {
    bearer_matches(
        headers.get("authorization").and_then(|value| value.to_str().ok()),
        &server.token,
    )
}

async fn peer_status(State(server): State<Arc<PeerServer>>) -> Response {
    Json(json!({
        "app": "mirach",
        "peer": true,
        "version": env!("CARGO_PKG_VERSION"),
        "port": server.port,
    }))
    .into_response()
}

async fn peer_bots(State(server): State<Arc<PeerServer>>, headers: HeaderMap) -> Response {
    if !authorized(&headers, &server) {
        return unauthorized();
    }
    let bots = server.bots.lock().expect("peer bots poisoned").clone();
    Json(json!({"profiles": bots})).into_response()
}

async fn peer_create_session(
    State(server): State<Arc<PeerServer>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if !authorized(&headers, &server) {
        return unauthorized();
    }
    let profile = body
        .get("profile")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("default")
        .to_string();
    let title = body
        .get("title")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("Peer · {profile}"));
    let system_prompt = body
        .get("system_prompt")
        .and_then(Value::as_str)
        .map(str::to_string);
    let result = crate::pi_bot::pi_bot_create_session(
        title,
        system_prompt,
        None,
        None,
        None,
        None,
        Some(profile),
    );
    match result {
        Ok(state) => Json(json!({
            "session_id": state.get("sessionId").cloned().unwrap_or(Value::Null),
            "running": false,
        }))
        .into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": {"code": "session_create_failed", "message": e}})),
        )
            .into_response(),
    }
}

/// 读会话文件并投影当前分支的 message 列表（与 `pi_get_session_messages` 同规则：
/// 叶子 = 最后一条 message 条目，不是文件最后一行——rpi 在消息后追加 record）。
fn session_messages(path: &str) -> Result<Value, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("会话文件读取失败 {path}: {e}"))?;
    let mut entries: Vec<Value> = Vec::new();
    for line in text.lines() {
        let l = line.trim();
        if l.is_empty() {
            continue;
        }
        if let Ok(v) = serde_json::from_str::<Value>(l) {
            entries.push(v);
        }
    }
    let leaf_id = entries
        .iter()
        .rev()
        .find(|e| e.get("type").and_then(Value::as_str) == Some("message"))
        .and_then(|e| e.get("id"))
        .and_then(Value::as_str)
        .map(String::from);
    let mut by_id: HashMap<&str, usize> = HashMap::new();
    for (i, e) in entries.iter().enumerate() {
        if let Some(id) = e.get("id").and_then(Value::as_str) {
            by_id.insert(id, i);
        }
    }
    let mut chain: Vec<&Value> = Vec::new();
    let mut cur = leaf_id;
    while let Some(id) = cur {
        match by_id.get(id.as_str()) {
            Some(&i) => {
                let e = &entries[i];
                chain.push(e);
                cur = e.get("parentId").and_then(Value::as_str).map(String::from);
            }
            None => break,
        }
    }
    chain.reverse();
    Ok(Value::Array(
        chain
            .iter()
            .filter(|e| e.get("type").and_then(Value::as_str) == Some("message"))
            .filter_map(|e| e.get("message").cloned())
            .collect(),
    ))
}

/// 把原始 session message 投影成 canonical driver 认识的 transcript 行
/// `{role,text}`（content 为字符串或文本块数组时取文本）。
fn transcript_rows(path: &str) -> Result<Value, String> {
    let messages = session_messages(path)?;
    let rows: Vec<Value> = messages
        .as_array()
        .map(|items| {
            items
                .iter()
                .map(|message| {
                    let role = message
                        .get("role")
                        .and_then(Value::as_str)
                        .unwrap_or("assistant");
                    let text = match message.get("content") {
                        Some(Value::String(text)) => text.clone(),
                        Some(Value::Array(parts)) => parts
                            .iter()
                            .filter_map(|part| part.get("text").and_then(Value::as_str))
                            .collect::<Vec<_>>()
                            .join(""),
                        _ => String::new(),
                    };
                    json!({"role": role, "text": text})
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(Value::Array(rows))
}

async fn peer_session_state(
    State(server): State<Arc<PeerServer>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    if !authorized(&headers, &server) {
        return unauthorized();
    }
    let Ok(state) = crate::pi_bot::pi_bot_state(id.clone()) else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({"error": {"code": "session_not_found", "message": id}})),
        )
            .into_response();
    };
    let path = state
        .get("path")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if path.is_empty() {
        // 泳道注册表里没有 = 会话确实不存在（driver 据此新建）。
        return (
            StatusCode::NOT_FOUND,
            Json(json!({"error": {"code": "session_not_found", "message": "session not found"}})),
        )
            .into_response();
    }
    let messages = match transcript_rows(&path) {
        Ok(messages) => messages,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": {"code": "transcript_unreadable", "message": e}})),
            )
                .into_response()
        }
    };
    Json(json!({
        "session_id": id,
        "running": state.get("running").cloned().unwrap_or(json!(false)),
        "messages": messages,
        "pending_approval": state.get("pending_approval").cloned().unwrap_or(Value::Null),
    }))
    .into_response()
}

async fn peer_prompt(
    State(server): State<Arc<PeerServer>>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> Response {
    if !authorized(&headers, &server) {
        return unauthorized();
    }
    let text = body
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let profile = body.get("profile").and_then(Value::as_str).map(str::to_string);
    let system_prompt = body
        .get("system_prompt")
        .and_then(Value::as_str)
        .map(str::to_string);
    match crate::pi_bot::pi_bot_prompt(
        server.app.clone(),
        id,
        text,
        None,
        None,
        system_prompt,
        None,
        None,
        None,
        profile,
    ) {
        Ok(_) => Json(json!({"status": "submitted"})).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": {"code": "prompt_failed", "message": e}})),
        )
            .into_response(),
    }
}

async fn peer_interrupt(
    State(server): State<Arc<PeerServer>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    if !authorized(&headers, &server) {
        return unauthorized();
    }
    match crate::pi_bot::pi_bot_interrupt(id) {
        Ok(value) => Json(value).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": {"code": "interrupt_failed", "message": e}})),
        )
            .into_response(),
    }
}

async fn peer_compact(
    State(server): State<Arc<PeerServer>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    if !authorized(&headers, &server) {
        return unauthorized();
    }
    match crate::pi_bot::pi_bot_compact(id) {
        Ok(value) => Json(value).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": {"code": "compact_failed", "message": e}})),
        )
            .into_response(),
    }
}

// ── 客户端半边 ──────────────────────────────────────────────────────────────

fn http_client(timeout: std::time::Duration) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|e| format!("peer HTTP 客户端构建失败: {e}"))
}

/// IPC：探测 `url` 是否是 mirach peer 服务（GET /v1/mirach/status）。
#[tauri::command(rename_all = "camelCase", async)]
pub async fn pi_peer_probe(url: String) -> Result<Value, String> {
    let base = url.trim().trim_end_matches('/').to_string();
    if base.is_empty() {
        return Err("peer url 为空".into());
    }
    let endpoint = format!("{base}/v1/mirach/status");
    let response = http_client(std::time::Duration::from_secs(5))
        .map_err(|e| e)?
        .get(&endpoint)
        .send()
        .await
        .map_err(|e| format!("peer 探测失败 {endpoint}: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("peer 探测 HTTP {}", response.status().as_u16()));
    }
    response
        .json::<Value>()
        .await
        .map_err(|e| format!("peer 探测响应不是 JSON: {e}"))
}

/// IPC：把一条连接登记成 mirach peer（令牌走 OS 凭据管理器），并拉一次公开名册。
#[tauri::command(rename_all = "camelCase", async)]
pub async fn pi_peer_connect(connection_id: String, url: String) -> Result<Value, String> {
    let id = connection_id.trim().to_string();
    let base = url.trim().trim_end_matches('/').to_string();
    if id.is_empty() || base.is_empty() {
        return Err("peer 连接缺少 id/url".into());
    }
    let token = crate::pi_connections::connection_token(&id)?;
    let endpoint = format!("{base}/v1/mirach/bots");
    let mut request = http_client(std::time::Duration::from_secs(10))?
        .get(&endpoint);
    if let Some(token) = token.as_deref().filter(|value| !value.trim().is_empty()) {
        request = request.bearer_auth(token.trim());
    }
    let response = request
        .send()
        .await
        .map_err(|e| format!("peer 名册拉取失败 {endpoint}: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("peer 名册拉取 HTTP {}", response.status().as_u16()));
    }
    let value = response
        .json::<Value>()
        .await
        .map_err(|e| format!("peer 名册响应不是 JSON: {e}"))?;
    let profiles = value
        .get("profiles")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    peer_conns()
        .lock()
        .expect("peer connections poisoned")
        .insert(
            id.clone(),
            PeerConn {
                connection_id: id,
                url: base,
                token,
            },
        );
    Ok(json!({"app": "mirach", "profiles": profiles}))
}

/// 已登记 peer 连接的就绪快照（供 `pi_gateway_status` 合并）。
pub fn status_map() -> Map<String, Value> {
    peer_conns()
        .lock()
        .expect("peer connections poisoned")
        .values()
        .map(|conn| {
            (
                conn.connection_id.clone(),
                json!({"state": "open", "error": null}),
            )
        })
        .collect()
}

fn peer_base(connection_id: &str) -> Option<String> {
    peer_conns()
        .lock()
        .expect("peer connections poisoned")
        .get(connection_id)
        .map(|conn| conn.url.clone())
}

fn peer_token(connection_id: &str) -> Option<String> {
    peer_conns()
        .lock()
        .expect("peer connections poisoned")
        .get(connection_id)
        .and_then(|conn| conn.token.clone())
}

/// 把宿主 RPC 方法翻译成 peer HTTP 调用。未登记的连接返回 None（由调用方
/// 回落本机分发表）；已登记但方法不支持返回 Err。
pub async fn try_peer_call(
    connection_id: &str,
    method: &str,
    params: &Value,
) -> Option<Result<Value, String>> {
    let base = peer_base(connection_id)?;
    Some(call_peer(&base, peer_token(connection_id).as_deref(), method, params).await)
}

async fn call_peer(
    base: &str,
    token: Option<&str>,
    method: &str,
    params: &Value,
) -> Result<Value, String> {
    let request = match method {
        "profiles.list" => ("GET".to_string(), format!("{base}/v1/mirach/bots"), Value::Null),
        "session.create" => (
            "POST".to_string(),
            format!("{base}/v1/mirach/sessions"),
            params.clone(),
        ),
        "session.resume" => {
            let id = params.get("session_id").and_then(Value::as_str).unwrap_or("");
            if id.is_empty() {
                return Err("session.resume 缺少 session_id".into());
            }
            (
                "GET".to_string(),
                format!("{base}/v1/mirach/sessions/{}", urlencode(id)),
                Value::Null,
            )
        }
        "prompt.submit" => {
            let id = params.get("session_id").and_then(Value::as_str).unwrap_or("");
            if id.is_empty() {
                return Err("prompt.submit 缺少 session_id".into());
            }
            (
                "POST".to_string(),
                format!("{base}/v1/mirach/sessions/{}/prompt", urlencode(id)),
                json!({"text": params.get("text").cloned().unwrap_or(Value::Null),
                       "profile": params.get("profile").cloned().unwrap_or(Value::Null),
                       "system_prompt": params.get("system_prompt").cloned().unwrap_or(Value::Null)}),
            )
        }
        "session.interrupt" => {
            let id = params.get("session_id").and_then(Value::as_str).unwrap_or("");
            if id.is_empty() {
                return Err("session.interrupt 缺少 session_id".into());
            }
            (
                "POST".to_string(),
                format!("{base}/v1/mirach/sessions/{}/interrupt", urlencode(id)),
                Value::Null,
            )
        }
        "session.compress" => {
            let id = params.get("session_id").and_then(Value::as_str).unwrap_or("");
            if id.is_empty() {
                return Err("session.compress 缺少 session_id".into());
            }
            (
                "POST".to_string(),
                format!("{base}/v1/mirach/sessions/{}/compact", urlencode(id)),
                Value::Null,
            )
        }
        other => return Err(format!("{other}: peer 连接不支持的方法")),
    };
    let (http_method, endpoint, body) = request;
    let mut builder = http_client(std::time::Duration::from_secs(120))?
        .request(reqwest::Method::from_bytes(http_method.as_bytes()).unwrap(), &endpoint);
    if let Some(token) = token.filter(|value| !value.trim().is_empty()) {
        builder = builder.bearer_auth(token.trim());
    }
    let response = if body.is_null() {
        builder.send().await
    } else {
        builder.json(&body).send().await
    }
    .map_err(|e| format!("peer 调用失败 {endpoint}: {e}"))?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!(
            "peer 调用 HTTP {}: {}",
            status.as_u16(),
            text.chars().take(300).collect::<String>()
        ));
    }
    serde_json::from_str::<Value>(&text)
        .map_err(|e| format!("peer 调用响应不是 JSON: {e}"))
}

fn urlencode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char)
            }
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

/// IPC：发布本机名册（peer 名册的真相 = bots-store）。前端在加载/变更时调用。
#[tauri::command(rename_all = "camelCase", async)]
pub fn pi_peer_publish_bots(bots: Vec<Value>) -> Result<Value, String> {
    let rows: Vec<Value> = bots
        .into_iter()
        .filter_map(|bot| {
            let name = bot.get("name").and_then(Value::as_str)?.trim().to_string();
            if name.is_empty() {
                return None;
            }
            Some(json!({
                "name": name,
                "title": bot.get("title").and_then(Value::as_str).unwrap_or(""),
                "description": bot.get("description").and_then(Value::as_str).unwrap_or(""),
            }))
        })
        .collect();
    if let Some(server) = SERVER.get() {
        *server.bots.lock().expect("peer bots poisoned") = rows.clone();
    }
    Ok(json!({"bots": rows.len()}))
}

/// IPC：peer 服务配对信息（URL + 令牌）。令牌只应交给受信任的对端。
#[tauri::command(rename_all = "camelCase", async)]
pub fn pi_peer_info() -> Result<Value, String> {
    let token = load_or_create_token()?;
    let port = peer_port();
    Ok(json!({
        "url": format!("http://127.0.0.1:{port}"),
        "port": port,
        "token": token,
    }))
}

/// IPC：对已登记的 peer 连接发起一次会话调用（供 relay/调试面直接用）。
#[tauri::command(rename_all = "camelCase", async)]
pub async fn pi_peer_call(
    connection_id: String,
    method: String,
    params: Option<Value>,
) -> Result<Value, String> {
    let base = peer_base(&connection_id).ok_or_else(|| {
        format!("peer 连接 {connection_id} 未登记（先 pi_peer_connect）")
    })?;
    call_peer(
        &base,
        peer_token(&connection_id).as_deref(),
        &method,
        &params.unwrap_or_else(|| json!({})),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urlencode_keeps_safe_chars() {
        assert_eq!(urlencode("room-1_2.3~x"), "room-1_2.3~x");
        assert_eq!(urlencode("a b/中"), "a%20b%2F%E4%B8%AD");
    }

    #[test]
    fn bearer_auth_is_exact_and_trimmed() {
        assert!(bearer_matches(Some("Bearer abc"), "abc"));
        assert!(bearer_matches(Some("Bearer  abc "), "abc"));
        assert!(!bearer_matches(Some("Bearer abd"), "abc"));
        assert!(!bearer_matches(Some("abc"), "abc"));
        assert!(!bearer_matches(None, "abc"));
    }
}
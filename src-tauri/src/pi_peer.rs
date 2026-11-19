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

use axum::extract::rejection::JsonRejection;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
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
        .route("/v1/mirach/rooms/{id}/replicate", post(peer_room_replicate))
        // ── hermes peer lending wire（2026-11-19）────────────────────────────
        .route("/api/ws", get(peer_ws_upgrade))
        .route("/v1/room-members/capabilities", get(peer_room_capabilities))
        .route("/v1/room-members/invitations", post(peer_room_invitation))
        .route("/v1/room-members/grants/refresh", post(peer_room_grant_refresh))
        .route("/v1/room-members/grants/revoke", post(peer_room_grant_revoke))
        .route("/v1/room-members/runs/close", post(peer_room_run_close))
        .route("/v1/runs", post(peer_run_admit))
        .route("/v1/runs/{run_id}", get(peer_run_state))
        .route("/v1/runs/{run_id}/stop", post(peer_run_stop))
        .route("/v1/runs/{run_id}/approval", post(peer_run_approval))
        .route("/v1/runs/{run_id}/steer", post(peer_run_steer))
        .route("/v1/runs/{run_id}/resolve-unknown", post(peer_run_resolve_unknown))
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
        None,
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
        None,
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

/// HA replica 接收：peer 收到 authority 的房间事件页，ingest 进本地 replica 表。
async fn peer_room_replicate(
    State(server): State<Arc<PeerServer>>,
    headers: HeaderMap,
    Path(room_id): Path<String>,
    Json(body): Json<Value>,
) -> Response {
    if !authorized(&headers, &server) {
        return unauthorized();
    }
    let room_name = body
        .get("room_name")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let members_json = body
        .get("members")
        .map(|m| serde_json::to_string(m).unwrap_or_else(|_| "[]".into()))
        .unwrap_or_else(|| "[]".into());
    let raw_page = body.get("page").cloned().unwrap_or(Value::Null);
    let replica_page =
        match crate::hosted_rooms::replicas::validate_page(&raw_page) {
            Ok(page) => page,
            Err(e) => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(json!({"error": {"code": e.code, "message": e.message}})),
                )
                    .into_response()
            }
        };
    let db_path = match crate::pi_paths::agent_dir() {
        Ok(dir) => dir.join("state.db"),
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": {"code": "db_path_failed", "message": e}})),
            )
                .into_response()
        }
    };
    let mut conn = match rusqlite::Connection::open(&db_path) {
        Ok(conn) => conn,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": {"code": "db_open_failed", "message": e.to_string()}})),
            )
                .into_response()
        }
    };
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0);
    match crate::hosted_rooms::replicas::ingest_page(
        &mut conn,
        &room_id,
        &room_name,
        &members_json,
        &replica_page,
        now,
    ) {
        Ok(result) => Json(result).into_response(),
        Err(e) => (
            StatusCode::CONFLICT,
            Json(json!({"error": {"code": e.code, "message": e.message}})),
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

// ── hermes peer lending wire（2026-11-19）────────────────────────────────────
//
// 逐行对照 hermes `api_server_room_grants.py`（room-members 四条路由）与
// `api_server_runs.py` 的 admission / status / stop / resolve-unknown。
// 宿主是单身份桌面进程：profile 恒 `default`；成员轮次转进 bot 泳道执行。

#[derive(Deserialize)]
struct PeerWsQuery {
    token: Option<String>,
}

/// 本机 peer 服务对外 base URL。绑定地址是 `MIRACH_PEER_BIND`；跨机部署时
/// 由 `pi_gateway_peer::peer_endpoint` 的 `MIRACH_PEER_URL` 覆盖。
pub(crate) fn base_url() -> String {
    let host = std::env::var("MIRACH_PEER_BIND")
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "127.0.0.1".into());
    let host = match host.as_str() {
        "0.0.0.0" | "::" | "[::]" => "127.0.0.1".to_owned(),
        _ => host,
    };
    format!("http://{host}:{}", peer_port())
}

fn sha256_hex(data: &[u8]) -> String {
    use sha2::Digest as _;
    let digest = sha2::Sha256::digest(data);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn now_secs() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0.0, |d| d.as_secs_f64())
}

fn hermes_error(status: StatusCode, code: &str, message: &str) -> Response {
    (
        status,
        Json(json!({"error": {"message": message, "type": "gateway_auth_error", "code": code}})),
    )
        .into_response()
}

fn hermes_invalid_grant() -> Response {
    hermes_error(
        StatusCode::UNAUTHORIZED,
        "invalid_room_grant",
        "Room authorization is invalid or expired.",
    )
}

fn hermes_renewal_required() -> Response {
    hermes_error(
        StatusCode::FORBIDDEN,
        "room_reauthorization_required",
        "Room authorization needs to be renewed.",
    )
}

fn hermes_grant_token(headers: &HeaderMap) -> String {
    let raw = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    match raw.split_once(' ') {
        Some((scheme, token)) if scheme.eq_ignore_ascii_case("hermesroom") => token.trim().to_owned(),
        _ => String::new(),
    }
}

fn hermes_rooms_store() -> Result<rusqlite::Connection, Response> {
    crate::pi_groups::open_store().map_err(|_| {
        hermes_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "room_grant_store_unavailable",
            "Room grant store is unavailable.",
        )
    })
}

fn hermes_signing_secret() -> Result<Vec<u8>, Response> {
    crate::pi_gateway_peer::gateway_grant_secret().map_err(|_| {
        hermes_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "room_grant_store_unavailable",
            "Room grant secret is unavailable.",
        )
    })
}

fn hermes_local_target_matches(claims: &Value) -> bool {
    claims.get("target_profile").and_then(Value::as_str) == Some(crate::pi_gateway_peer::served_profile())
        && claims.get("target_install_id").and_then(Value::as_str)
            == Some(crate::pi_groups::installation_id().as_str())
}

/// 上游 `_room_grant_claims`：验签 + 本机坐标 + 撤销围栏 + reservation 现状。
fn hermes_room_claims(headers: &HeaderMap, permission: &str) -> Result<Value, Response> {
    let secret = hermes_signing_secret()?;
    let token = hermes_grant_token(headers);
    if token.is_empty() {
        return Err(hermes_invalid_grant());
    }
    let claims = crate::pi_gateway_peer::decode_room_grant(&secret, &token, permission, now_secs())
        .map_err(|_| hermes_invalid_grant())?;
    if !hermes_local_target_matches(&claims) {
        return Err(hermes_invalid_grant());
    }
    let conn = hermes_rooms_store()?;
    if crate::hosted_rooms::grants::room_grant_is_revoked(&conn, &claims, now_secs()) {
        return Err(hermes_renewal_required());
    }
    if !crate::hosted_rooms::grants::peer_room_grant_is_current(&conn, &claims, now_secs()) {
        return Err(hermes_renewal_required());
    }
    Ok(claims)
}

/// 上游 `_handle_room_member_invitation`：API-key 面签一份短时 grant 并登记 reservation。
async fn peer_room_invitation(
    State(server): State<Arc<PeerServer>>,
    headers: HeaderMap,
    body: Result<Json<Value>, JsonRejection>,
) -> Response {
    if !authorized(&headers, &server) {
        return unauthorized();
    }
    let Ok(Json(body)) = body else {
        return hermes_error(StatusCode::BAD_REQUEST, "invalid_room_invitation", "Invitation is missing required room authority fields.");
    };
    let Some(params) = body.as_object() else {
        return hermes_error(StatusCode::BAD_REQUEST, "invalid_room_invitation", "Invitation is missing required room authority fields.");
    };
    let secret = match hermes_signing_secret() {
        Ok(secret) => secret,
        Err(response) => return response,
    };
    let conn = match hermes_rooms_store() {
        Ok(conn) => conn,
        Err(response) => return response,
    };
    match crate::pi_gateway_peer::issue_invitation(
        &conn,
        &secret,
        &crate::pi_groups::installation_id(),
        crate::pi_gateway_peer::served_profile(),
        params,
        &crate::pi_gateway_peer::peer_endpoint(),
        now_secs(),
    ) {
        Ok(mut invitation) => {
            if let Some(object) = invitation.as_object_mut() {
                object.insert("object".into(), json!("hermes.room_member.invitation"));
            }
            (StatusCode::CREATED, Json(invitation)).into_response()
        }
        Err(message) => hermes_error(StatusCode::BAD_REQUEST, "invalid_room_invitation", &message),
    }
}

/// 上游 `_handle_room_member_capabilities`：验 grant 并回本机实时房间目录。
async fn peer_room_capabilities(headers: HeaderMap) -> Response {
    let claims = match hermes_room_claims(&headers, "status") {
        Ok(claims) => claims,
        Err(response) => return response,
    };
    let profile = crate::pi_gateway_peer::served_profile();
    let catalog = crate::pi_gateway_peer::catalog_for(
        &crate::pi_groups::installation_id(),
        profile,
        crate::pi_gateway_peer::peer_endpoint()
            .get("url")
            .and_then(Value::as_str)
            .unwrap_or(""),
        crate::pi_gateway_peer::peer_endpoint()
            .get("transport_security")
            .and_then(Value::as_str)
            .unwrap_or("loopback"),
    );
    let mut body = Map::new();
    body.insert("object".into(), json!("hermes.room_member.capabilities"));
    for field in [
        "room_id",
        "home_install_id",
        "authority_gateway_id",
        "authority_epoch",
        "member_id",
    ] {
        body.insert(field.into(), claims.get(field).cloned().unwrap_or(Value::Null));
    }
    body.insert("target_profile".into(), json!(profile));
    body.insert("catalog".into(), catalog);
    Json(Value::Object(body)).into_response()
}

/// 上游 `_handle_room_member_grant_refresh`：不改变冻结策略的前提下续期 dispatch 权限。
async fn peer_room_grant_refresh(headers: HeaderMap, body: Option<Json<Value>>) -> Response {
    let claims = match hermes_room_claims(&headers, "dispatch") {
        Ok(claims) => claims,
        Err(response) => return response,
    };
    let mut requested_ttl = None;
    if let Some(Json(body)) = body {
        if !body.is_null() {
            let Some(params) = body.as_object() else {
                return hermes_error(
                    StatusCode::BAD_REQUEST,
                    "invalid_room_grant_refresh",
                    "Grant refresh accepts only ttl_seconds.",
                );
            };
            if params.keys().any(|key| key != "ttl_seconds") {
                return hermes_error(
                    StatusCode::BAD_REQUEST,
                    "invalid_room_grant_refresh",
                    "Grant refresh accepts only ttl_seconds.",
                );
            }
            if let Some(ttl) = params.get("ttl_seconds") {
                match ttl.as_f64() {
                    Some(value) => requested_ttl = Some(value),
                    None => {
                        return hermes_error(
                            StatusCode::BAD_REQUEST,
                            "invalid_room_grant_refresh",
                            "Grant refresh accepts only ttl_seconds.",
                        )
                    }
                }
            }
        }
    }
    let secret = match hermes_signing_secret() {
        Ok(secret) => secret,
        Err(response) => return response,
    };
    match crate::pi_gateway_peer::refresh_room_grant(
        &secret,
        &claims,
        crate::pi_gateway_peer::served_profile(),
        requested_ttl,
        now_secs(),
    ) {
        Ok(mut refreshed) => {
            if let Some(object) = refreshed.as_object_mut() {
                object.insert("object".into(), json!("hermes.room_member.grant"));
            }
            Json(refreshed).into_response()
        }
        Err(message) => {
            if message.contains("policy changed") {
                hermes_error(
                    StatusCode::FORBIDDEN,
                    "room_execution_policy_changed",
                    "Room execution policy changed; reauthorization is required.",
                )
            } else if message.contains("horizon expired") {
                hermes_error(
                    StatusCode::FORBIDDEN,
                    "invalid_room_grant",
                    "Room authorization is invalid or expired.",
                )
            } else {
                hermes_error(
                    StatusCode::UNAUTHORIZED,
                    "invalid_room_grant",
                    "Room authorization is invalid or expired.",
                )
            }
        }
    }
}

/// 上游 `_handle_room_member_grant_revoke`：幂等地作废认证本次请求的 grant。
async fn peer_room_grant_revoke(headers: HeaderMap, body: Option<Json<Value>>) -> Response {
    if let Some(Json(body)) = &body {
        if body.as_object().is_some_and(|map| !map.is_empty()) {
            return hermes_error(
                StatusCode::BAD_REQUEST,
                "invalid_room_grant_revoke",
                "Grant revoke accepts no fields.",
            );
        }
        if !body.is_null() && body.as_object().is_none() {
            return hermes_error(
                StatusCode::BAD_REQUEST,
                "invalid_room_grant_revoke",
                "Grant revoke accepts no fields.",
            );
        }
    }
    let secret = match hermes_signing_secret() {
        Ok(secret) => secret,
        Err(response) => return response,
    };
    let token = hermes_grant_token(&headers);
    if token.is_empty() {
        return hermes_invalid_grant();
    }
    // 幂等：响应丢失的重试会拿刚被 deny 的 grant 再来，所以只验签名/坐标/时限。
    let claims = match crate::pi_gateway_peer::decode_room_grant(&secret, &token, "status", now_secs()) {
        Ok(claims) => claims,
        Err(_) => return hermes_invalid_grant(),
    };
    if !hermes_local_target_matches(&claims) {
        return hermes_invalid_grant();
    }
    let conn = match hermes_rooms_store() {
        Ok(conn) => conn,
        Err(response) => return response,
    };
    let expires = claims
        .get("status_expires_at")
        .or_else(|| claims.get("expires_at"))
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    if let Err(message) =
        crate::hosted_rooms::grants::revoke_room_grant_scope(&conn, &claims, expires, now_secs())
    {
        return hermes_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "room_grant_store_unavailable",
            &message.0,
        );
    }
    Json(json!({"object": "hermes.room_member.grant.revocation", "revoked": true})).into_response()
}

/// 上游 `_handle_room_member_run_close`：找到该键开始的运行，或关掉键让它永不开始。
async fn peer_room_run_close(headers: HeaderMap, body: Result<Json<Value>, JsonRejection>) -> Response {
    let claims = match hermes_room_claims(&headers, "stop") {
        Ok(claims) => claims,
        Err(response) => return response,
    };
    let Ok(Json(body)) = body else {
        return hermes_error(
            StatusCode::BAD_REQUEST,
            "invalid_room_run_close",
            "Run close takes task_id and execution_generation.",
        );
    };
    let Some(params) = body.as_object() else {
        return hermes_error(
            StatusCode::BAD_REQUEST,
            "invalid_room_run_close",
            "Run close takes task_id and execution_generation.",
        );
    };
    let task_id = params.get("task_id").and_then(Value::as_str).unwrap_or("");
    let generation = params.get("execution_generation").and_then(|value| value.as_i64()).unwrap_or(0);
    let exact = params.len() == 2 && params.contains_key("task_id") && params.contains_key("execution_generation");
    if !exact || task_id.is_empty() || generation < 1 {
        return hermes_error(
            StatusCode::BAD_REQUEST,
            "invalid_room_run_close",
            "Run close takes task_id and execution_generation.",
        );
    }
    let scope = crate::pi_gateway_peer::room_run_scope(&claims).unwrap_or_default();
    let conn = match crate::pi_peer_runs::open() {
        Ok(conn) => conn,
        Err(_) => {
            return hermes_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "run_store_unavailable",
                "Run store is unavailable.",
            )
        }
    };
    match crate::pi_peer_runs::find_or_close(&conn, &scope, &format!("room:{task_id}:{generation}")) {
        Ok((outcome, _record)) if outcome == "closed" => {
            Json(json!({"object": "hermes.room_member.run_close", "closed": true})).into_response()
        }
        Ok((_, Some(record))) => Json(json!({
            "object": "hermes.room_member.run_close",
            "closed": false,
            "run_id": record.get("run_id").cloned().unwrap_or(Value::Null),
        }))
        .into_response(),
        Ok((_, None)) => Json(json!({"object": "hermes.room_member.run_close", "closed": true})).into_response(),
        Err(message) => hermes_error(StatusCode::SERVICE_UNAVAILABLE, "run_store_unavailable", &message),
    }
}

fn dispatch_fingerprint(body: &Value) -> String {
    let payload = json!({"body": body, "gateway_session_key": ""});
    sha256_hex(crate::hosted_rooms::common::compact_json(&payload, false).as_bytes())
}

/// 确保某成员的房间会话（隐藏泳道）存在：先按存档懒装配，失败则重建。
/// 映射落在 peer 运行台账库（与 grant 台账的 state.db 分开）。
fn ensure_peer_room_session(
    room_id: &str,
    member_id: &str,
    profile: &str,
) -> Result<(String, String), String> {
    let store = crate::pi_peer_runs::open()?;
    if let Some((session_id, path)) =
        crate::pi_peer_runs::room_session(&store, room_id, member_id, profile)?
    {
        if std::path::Path::new(&path).exists()
            && crate::pi_bot::pi_bot_open(
                session_id.clone(),
                Some(path.clone()),
                None,
                None,
                None,
                None,
                Some(profile.to_owned()),
                None,
            )
            .is_ok()
        {
            return Ok((session_id, path));
        }
    }
    let created = crate::pi_bot::pi_bot_create_session(
        format!("Group: {room_id}"),
        None,
        None,
        None,
        None,
        None,
        Some(profile.to_owned()),
        None,
    )?;
    let session_id = created
        .get("sessionId")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    let path = created
        .get("path")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    if session_id.is_empty() {
        return Err("房间会话创建失败".into());
    }
    crate::pi_peer_runs::save_room_session(&store, room_id, member_id, profile, &session_id, &path)?;
    Ok((session_id, path))
}

/// 上游 `POST /v1/runs` 的房间准入路径：幂等 admission，成员轮次交给 bot 泳道。
async fn peer_run_admit(
    State(server): State<Arc<PeerServer>>,
    headers: HeaderMap,
    body: Result<Json<Value>, JsonRejection>,
) -> Response {
    let Ok(Json(body)) = body else {
        return hermes_error(
            StatusCode::FORBIDDEN,
            "invalid_room_dispatch",
            "Room dispatch accepts only input and hosted_room_dispatch.",
        );
    };
    let secret = match hermes_signing_secret() {
        Ok(secret) => secret,
        Err(response) => return response,
    };
    let token = hermes_grant_token(&headers);
    if token.is_empty() {
        return hermes_invalid_grant();
    }
    let claims = match crate::pi_gateway_peer::decode_room_grant(&secret, &token, "dispatch", now_secs()) {
        Ok(claims) => claims,
        Err(_) => return hermes_invalid_grant(),
    };
    let dispatch_error = |message: &str| hermes_error(StatusCode::FORBIDDEN, "invalid_room_dispatch", message);
    if !hermes_local_target_matches(&claims) {
        return dispatch_error("Room dispatch target does not match this profile.");
    }
    let Some(params) = body.as_object() else {
        return dispatch_error("Room dispatch accepts only input and hosted_room_dispatch.");
    };
    if params.keys().any(|key| key != "input" && key != "hosted_room_dispatch") {
        return dispatch_error("Room dispatch accepts only input and hosted_room_dispatch.");
    }
    let Some(dispatch_value) = params.get("hosted_room_dispatch") else {
        return dispatch_error("Room dispatch requires hosted_room_dispatch.");
    };
    let dispatch = match crate::pi_gateway_peer::MemberDispatch::from_mapping(dispatch_value) {
        Ok(dispatch) => dispatch,
        Err(message) => return dispatch_error(&message),
    };
    if let Err(message) = crate::pi_gateway_peer::verify_room_grant(&secret, &token, &dispatch, "dispatch", now_secs()) {
        return dispatch_error(&message);
    }
    let profile = crate::pi_gateway_peer::served_profile();
    let install_id = crate::pi_groups::installation_id();
    if dispatch.target_profile != profile || dispatch.target_install_id != install_id {
        return dispatch_error("Room dispatch target does not match this profile.");
    }
    let catalog = crate::pi_gateway_peer::catalog_for(
        &install_id,
        profile,
        crate::pi_gateway_peer::peer_endpoint()
            .get("url")
            .and_then(Value::as_str)
            .unwrap_or(""),
        crate::pi_gateway_peer::peer_endpoint()
            .get("transport_security")
            .and_then(Value::as_str)
            .unwrap_or("loopback"),
    );
    let policy = crate::pi_gateway_peer::execution_policy_for(profile);
    if policy.get("policy_digest").and_then(Value::as_str) != Some(dispatch.execution_policy_digest.as_str()) {
        return hermes_error(
            StatusCode::FORBIDDEN,
            "room_execution_policy_changed",
            "Room execution policy changed; reauthorization is required.",
        );
    }
    if catalog.get("catalog_digest").and_then(Value::as_str) != Some(dispatch.capability_digest.as_str()) {
        return hermes_error(
            StatusCode::FORBIDDEN,
            "room_capability_catalog_changed",
            "Room capability catalog changed; reauthorization is required.",
        );
    }
    let input_matches = match params.get("input") {
        None | Some(Value::Null) => true,
        Some(Value::String(text)) => text == &dispatch.prompt,
        Some(_) => false,
    };
    if !input_matches {
        return dispatch_error("Room dispatch input does not match its prompt.");
    }
    let expected_key = format!("room:{}:{}", dispatch.task_id, dispatch.execution_generation);
    let idempotency_key = headers
        .get("idempotency-key")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .trim()
        .to_owned();
    if idempotency_key != expected_key {
        return dispatch_error("Room dispatch idempotency key is invalid.");
    }
    let scope = match crate::pi_gateway_peer::room_run_scope(&claims) {
        Some(scope) => scope,
        None => return dispatch_error("Room grant scope is incomplete."),
    };
    let rooms_conn = match hermes_rooms_store() {
        Ok(conn) => conn,
        Err(response) => return response,
    };
    if !crate::hosted_rooms::grants::peer_room_grant_is_current(&rooms_conn, &claims, now_secs()) {
        return hermes_error(
            StatusCode::FORBIDDEN,
            "room_reauthorization_required",
            "Room authorization needs to be renewed.",
        );
    }
    // 房间必须先被 invite 预订过：没有 reservation 的 grant 不在这里执行。
    let (session_id, path) =
        match ensure_peer_room_session(&dispatch.room_id, &dispatch.member_id, &dispatch.target_profile) {
            Ok(session) => session,
            Err(message) => {
                return hermes_error(StatusCode::INTERNAL_SERVER_ERROR, "session_create_failed", &message)
            }
        };
    let run_id = format!("run_{}", uuid::Uuid::new_v4().simple());
    let mut status = json!({
        "object": "hermes.run",
        "run_id": run_id,
        "status": "queued",
        "session_id": session_id,
        "model": dispatch.target_profile,
        "created_at": now_secs(),
        "updated_at": now_secs(),
    });
    let store = match crate::pi_peer_runs::open() {
        Ok(store) => store,
        Err(message) => return hermes_error(StatusCode::SERVICE_UNAVAILABLE, "run_store_unavailable", &message),
    };
    let fingerprint = dispatch_fingerprint(&body);
    match crate::pi_peer_runs::reserve(&store, &scope, &expected_key, &fingerprint, &run_id, &status) {
        Ok((outcome, _)) if outcome == "conflict" => {
            return hermes_error(
                StatusCode::CONFLICT,
                "idempotency_key_conflict",
                "Idempotency-Key was already used with a different request payload",
            )
        }
        Ok((_, Some(record))) if record.get("run_id").and_then(Value::as_str) != Some(run_id.as_str()) => {
            return (
                StatusCode::ACCEPTED,
                Json(json!({
                    "run_id": record.get("run_id").cloned().unwrap_or(Value::Null),
                    "status": record.get("status").cloned().unwrap_or(json!("queued")),
                    "replayed": true,
                })),
            )
                .into_response();
        }
        Ok(_) => {}
        Err(message) => return hermes_error(StatusCode::SERVICE_UNAVAILABLE, "run_store_unavailable", &message),
    }
    let prompt_text = dispatch.prompt.clone();
    if let Err(message) = crate::pi_bot::pi_bot_prompt(
        server.app.clone(),
        session_id.clone(),
        prompt_text,
        None,
        Some(path.clone()),
        None,
        None,
        None,
        None,
        Some(dispatch.target_profile.clone()),
        None,
    ) {
        status["status"] = json!("failed");
        status["error"] = json!(message);
        status["updated_at"] = json!(now_secs());
        let _ = crate::pi_peer_runs::update_status(&store, &run_id, &status);
        return hermes_error(StatusCode::INTERNAL_SERVER_ERROR, "run_start_failed", &message);
    }
    spawn_peer_run_monitor(run_id.clone(), session_id, scope);
    (
        StatusCode::ACCEPTED,
        Json(json!({"run_id": run_id, "status": "started", "replayed": false})),
    )
        .into_response()
}

/// 轮次结束把 durable 状态收口（上游 `_execute_run` 的 finally 语义）。
fn spawn_peer_run_monitor(run_id: String, session_id: String, scope: String) {
    std::thread::Builder::new()
        .name(format!("mirach-peer-{run_id}"))
        .stack_size(512 * 1024)
        .spawn(move || {
            if let Ok(conn) = crate::pi_peer_runs::open() {
                if let Ok(Some(mut record)) =
                    crate::pi_peer_runs::status_for_run(&conn, &scope, &run_id)
                {
                    record["status"] = json!("running");
                    record["updated_at"] = json!(now_secs());
                    let _ = crate::pi_peer_runs::update_status(&conn, &run_id, &record);
                }
            }
            loop {
                std::thread::sleep(std::time::Duration::from_millis(200));
                let state = crate::pi_bot::pi_bot_state(session_id.clone()).unwrap_or(Value::Null);
                if state.get("running").and_then(Value::as_bool) == Some(true) {
                    continue;
                }
                let outcome = state
                    .get("last_status")
                    .and_then(Value::as_str)
                    .unwrap_or("failed")
                    .to_owned();
                let mut record = json!({
                    "object": "hermes.run",
                    "run_id": run_id,
                    "status": outcome,
                    "updated_at": now_secs(),
                });
                match outcome.as_str() {
                    "completed" => {
                        record["completed"] = json!(true);
                        record["partial"] = json!(false);
                        record["interrupted"] = json!(false);
                        record["output"] = state.get("last_output").cloned().unwrap_or(json!(""));
                    }
                    "cancelled" => {
                        record["completed"] = json!(false);
                        record["partial"] = json!(false);
                        record["interrupted"] = json!(true);
                    }
                    _ => {
                        record["completed"] = json!(false);
                        record["partial"] = json!(false);
                        record["interrupted"] = json!(false);
                        record["error"] = state
                            .get("last_error")
                            .cloned()
                            .unwrap_or(json!("agent run failed"));
                    }
                }
                if let Ok(conn) = crate::pi_peer_runs::open() {
                    let _ = crate::pi_peer_runs::update_status(&conn, &run_id, &record);
                }
                break;
            }
        })
        .ok();
}

fn peer_run_record(scope: &str, run_id: &str) -> Result<Option<Value>, Response> {
    let conn = crate::pi_peer_runs::open().map_err(|_| {
        hermes_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "run_store_unavailable",
            "Run store is unavailable.",
        )
    })?;
    crate::pi_peer_runs::status_for_run(&conn, scope, run_id.trim())
        .map_err(|_| hermes_error(StatusCode::INTERNAL_SERVER_ERROR, "run_store_unavailable", "Run store is unavailable."))
}

/// 上游 `_request_owns_run`：运行台账按认证 scope 隔离。
fn owns_run_scope(claims: &Value, scope: &str) -> bool {
    crate::pi_gateway_peer::room_run_scope(claims).as_deref() == Some(scope)
}

/// 上游 `GET /v1/runs/{id}`：可轮询状态（含等待审批的 prompt 投影）。
async fn peer_run_state(headers: HeaderMap, Path(run_id): Path<String>) -> Response {
    let claims = match hermes_room_claims(&headers, "status") {
        Ok(claims) => claims,
        Err(response) => return response,
    };
    let Some(scope) = crate::pi_gateway_peer::room_run_scope(&claims) else {
        return hermes_error(StatusCode::NOT_FOUND, "run_not_found", &format!("Run not found: {run_id}"));
    };
    let Some(mut record) = (match peer_run_record(&scope, &run_id) {
        Ok(record) => record,
        Err(response) => return response,
    }) else {
        return hermes_error(StatusCode::NOT_FOUND, "run_not_found", &format!("Run not found: {run_id}"));
    };
    if !owns_run_scope(&claims, &scope) {
        return hermes_error(StatusCode::NOT_FOUND, "run_not_found", &format!("Run not found: {run_id}"));
    }
    let status = record.get("status").and_then(Value::as_str).unwrap_or("").to_owned();
    let terminal = matches!(status.as_str(), "completed" | "failed" | "cancelled" | "interrupted");
    let session_id = record.get("session_id").and_then(Value::as_str).unwrap_or("").to_owned();
    if terminal || session_id.is_empty() {
        return Json(record).into_response();
    }
    let bot = crate::pi_bot::pi_bot_state(session_id.clone()).unwrap_or(Value::Null);
    let running = bot.get("running").and_then(Value::as_bool).unwrap_or(false);
    if running {
        let approval = bot.get("pending_approval").cloned().unwrap_or(Value::Null);
        if !approval.is_null() {
            record["status"] = json!("waiting_for_approval");
            record["approval"] = approval;
        } else if status != "stopping" {
            record["status"] = json!("running");
        }
        record["updated_at"] = json!(now_secs());
        return Json(record).into_response();
    }
    // 会话已不在跑且台账仍是活态 = 网关重启丢了进程内状态（上游 interrupted 语义）。
    record["status"] = json!("interrupted");
    record["error"] = json!("The gateway restarted before this run settled.");
    record["last_event"] = json!("run.interrupted");
    record["updated_at"] = json!(now_secs());
    if let Ok(conn) = crate::pi_peer_runs::open() {
        let _ = crate::pi_peer_runs::update_status(&conn, &run_id, &record);
    }
    Json(record).into_response()
}

async fn peer_run_stop(headers: HeaderMap, Path(run_id): Path<String>) -> Response {
    let claims = match hermes_room_claims(&headers, "stop") {
        Ok(claims) => claims,
        Err(response) => return response,
    };
    let Some(scope) = crate::pi_gateway_peer::room_run_scope(&claims) else {
        return hermes_error(StatusCode::NOT_FOUND, "run_not_found", &format!("Run not found: {run_id}"));
    };
    let Some(mut record) = (match peer_run_record(&scope, &run_id) {
        Ok(record) => record,
        Err(response) => return response,
    }) else {
        return hermes_error(StatusCode::NOT_FOUND, "run_not_found", &format!("Run not found: {run_id}"));
    };
    if !owns_run_scope(&claims, &scope) {
        return hermes_error(StatusCode::NOT_FOUND, "run_not_found", &format!("Run not found: {run_id}"));
    }
    let status = record.get("status").and_then(Value::as_str).unwrap_or("").to_owned();
    if matches!(status.as_str(), "completed" | "failed" | "cancelled" | "interrupted") {
        return Json(record).into_response();
    }
    let session_id = record.get("session_id").and_then(Value::as_str).unwrap_or("").to_owned();
    if session_id.is_empty() {
        return hermes_error(StatusCode::CONFLICT, "run_not_active", &format!("Run is not active in this gateway process: {run_id}"));
    }
    if let Err(message) = crate::pi_bot::pi_bot_interrupt(session_id) {
        eprintln!("[peer] run stop interrupt failed: {message}");
    }
    record["status"] = json!("stopping");
    record["last_event"] = json!("run.stopping");
    record["updated_at"] = json!(now_secs());
    if let Ok(conn) = crate::pi_peer_runs::open() {
        let _ = crate::pi_peer_runs::update_status(&conn, &run_id, &record);
    }
    Json(json!({"run_id": record["run_id"].clone(), "status": "stopping"})).into_response()
}

async fn peer_run_approval(headers: HeaderMap, Path(run_id): Path<String>, Json(body): Json<Value>) -> Response {
    let claims = match hermes_room_claims(&headers, "approve") {
        Ok(claims) => claims,
        Err(response) => return response,
    };
    let Some(scope) = crate::pi_gateway_peer::room_run_scope(&claims) else {
        return hermes_error(StatusCode::NOT_FOUND, "run_not_found", &format!("Run not found: {run_id}"));
    };
    let Some((scope, record)) = (match peer_run_record(&scope, &run_id) {
        Ok(record) => record.map(|record| (scope, record)),
        Err(response) => return response,
    }) else {
        return hermes_error(StatusCode::NOT_FOUND, "run_not_found", &format!("Run not found: {run_id}"));
    };
    if !owns_run_scope(&claims, &scope) {
        return hermes_error(StatusCode::NOT_FOUND, "run_not_found", &format!("Run not found: {run_id}"));
    }
    let Some(params) = body.as_object() else {
        return hermes_error(StatusCode::BAD_REQUEST, "invalid_approval", "Approval takes a choice.");
    };
    let choice = params.get("choice").and_then(Value::as_str).unwrap_or("");
    if !matches!(choice, "once" | "deny") {
        return hermes_error(StatusCode::BAD_REQUEST, "invalid_approval_choice", "Room approvals require once or deny");
    }
    let session_id = record.get("session_id").and_then(Value::as_str).unwrap_or("").to_owned();
    if session_id.is_empty() {
        return hermes_error(StatusCode::CONFLICT, "approval_not_pending", "Room approval is no longer pending");
    }
    let bot = crate::pi_bot::pi_bot_state(session_id.clone()).unwrap_or(Value::Null);
    let pending = bot.get("pending_approval").cloned().unwrap_or(Value::Null);
    let request_id = params
        .get("request_id")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .or_else(|| pending.get("request_id").and_then(Value::as_str).map(str::to_owned));
    let Some(request_id) = request_id else {
        return hermes_error(StatusCode::CONFLICT, "approval_not_pending", "Room approval is no longer pending");
    };
    if !pending.is_null()
        && pending.get("request_id").and_then(Value::as_str) != Some(request_id.as_str())
    {
        return hermes_error(StatusCode::CONFLICT, "approval_not_pending", "Room approval is no longer pending");
    }
    match crate::pi_bot::pi_bot_approval_respond(session_id, request_id.clone(), choice.to_owned()) {
        Ok(resolved) => {
            if let Ok(conn) = crate::pi_peer_runs::open() {
                let mut patched = record.clone();
                patched["status"] = json!("running");
                patched["last_event"] = json!("approval.responded");
                patched["updated_at"] = json!(now_secs());
                let _ = crate::pi_peer_runs::update_status(&conn, run_id.trim(), &patched);
            }
            Json(json!({
                "object": "hermes.run.approval_response",
                "run_id": run_id,
                "request_id": request_id,
                "choice": choice,
                "resolved": resolved,
            }))
            .into_response()
        }
        Err(message) => hermes_error(StatusCode::INTERNAL_SERVER_ERROR, "approval_failed", &message),
    }
}

async fn peer_run_steer(headers: HeaderMap, Path(run_id): Path<String>, Json(body): Json<Value>) -> Response {
    let claims = match hermes_room_claims(&headers, "status") {
        Ok(claims) => claims,
        Err(response) => return response,
    };
    let Some(scope) = crate::pi_gateway_peer::room_run_scope(&claims) else {
        return hermes_error(StatusCode::NOT_FOUND, "run_not_found", &format!("Run not found: {run_id}"));
    };
    let Some((scope, record)) = (match peer_run_record(&scope, &run_id) {
        Ok(record) => record.map(|record| (scope, record)),
        Err(response) => return response,
    }) else {
        return hermes_error(StatusCode::NOT_FOUND, "run_not_found", &format!("Run not found: {run_id}"));
    };
    if !owns_run_scope(&claims, &scope) {
        return hermes_error(StatusCode::NOT_FOUND, "run_not_found", &format!("Run not found: {run_id}"));
    }
    let status = record.get("status").and_then(Value::as_str).unwrap_or("");
    let Some(params) = body.as_object() else {
        return hermes_error(StatusCode::BAD_REQUEST, "invalid_steer_input", "Steer takes input, message or text.");
    };
    let steer_text = ["input", "message", "text"]
        .iter()
        .find_map(|key| params.get(*key).and_then(Value::as_str))
        .unwrap_or("")
        .trim()
        .to_owned();
    if status != "running" || steer_text.is_empty() {
        return hermes_error(
            StatusCode::CONFLICT,
            "run_not_accepting_steer",
            &format!("Run is not currently accepting steer input: {run_id}"),
        );
    }
    let session_id = record
        .get("session_id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    if session_id.is_empty() {
        return hermes_error(
            StatusCode::CONFLICT,
            "run_not_accepting_steer",
            &format!("Run is not currently accepting steer input: {run_id}"),
        );
    }
    match crate::pi_bot::pi_bot_steer(&session_id, &steer_text) {
        Ok(true) => {
            if let Ok(conn) = crate::pi_peer_runs::open() {
                let mut patched = record.clone();
                patched["last_event"] = json!("run.steered");
                patched["updated_at"] = json!(now_secs());
                let _ = crate::pi_peer_runs::update_status(&conn, &run_id, &patched);
            }
            Json(json!({"object": "hermes.run.steer", "run_id": run_id, "accepted": true})).into_response()
        }
        Ok(false) => hermes_error(
            StatusCode::CONFLICT,
            "steer_not_accepted",
            &format!("Run did not accept steer text: {run_id}"),
        ),
        Err(message) => hermes_error(StatusCode::INTERNAL_SERVER_ERROR, "steer_failed", &message),
    }
}

async fn peer_run_resolve_unknown(headers: HeaderMap, Path(run_id): Path<String>, Json(body): Json<Value>) -> Response {
    let claims = match hermes_room_claims(&headers, "stop") {
        Ok(claims) => claims,
        Err(response) => return response,
    };
    let Some(params) = body.as_object() else {
        return hermes_error(StatusCode::BAD_REQUEST, "invalid_room_dispatch", "Run resolve-unknown takes admission_id and execution_generation.");
    };
    let admission_id = params.get("admission_id").and_then(Value::as_str).unwrap_or("");
    let generation = params.get("execution_generation").and_then(|value| value.as_i64()).unwrap_or(0);
    if params.len() != 2 || admission_id != run_id.trim() || generation < 1 {
        return hermes_error(StatusCode::NOT_FOUND, "run_not_found", &format!("Run not found: {run_id}"));
    }
    let Some(scope) = crate::pi_gateway_peer::room_run_scope(&claims) else {
        return hermes_error(StatusCode::NOT_FOUND, "run_not_found", &format!("Run not found: {run_id}"));
    };
    let Some((scope, record)) = (match peer_run_record(&scope, &run_id) {
        Ok(record) => record.map(|record| (scope, record)),
        Err(response) => return response,
    }) else {
        return hermes_error(StatusCode::NOT_FOUND, "run_not_found", &format!("Run not found: {run_id}"));
    };
    if !owns_run_scope(&claims, &scope) {
        return hermes_error(StatusCode::NOT_FOUND, "run_not_found", &format!("Run not found: {run_id}"));
    }
    if let Some(session_id) = record.get("session_id").and_then(Value::as_str) {
        let _ = crate::pi_bot::pi_bot_interrupt(session_id.to_owned());
    }
    let mut settled = record;
    settled["status"] = json!("interrupted");
    settled["error"] = json!("member gateway restarted");
    settled["updated_at"] = json!(now_secs());
    if let Ok(conn) = crate::pi_peer_runs::open() {
        let _ = crate::pi_peer_runs::update_status(&conn, &run_id, &settled);
    }
    Json(settled).into_response()
}

fn is_response_frame(value: &Value) -> bool {
    value.get("result").is_some() || value.get("error").is_some()
}

fn rpc_result(id: Value, result: Value) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "result": result})
}

fn rpc_error(id: Value, code: i64, message: &str) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}})
}

fn peer_gateway_ready() -> Value {
    json!({
        "jsonrpc": "2.0",
        "method": "event",
        "params": {
            "type": "gateway.ready",
            "payload": {
                "skin": Value::Null,
                "change_events": true,
                "heartbeat": true,
                "replay_epoch": 1,
                "room_link": crate::pi_gateway_peer::served_room_link(),
            }
        }
    })
}

/// 一帧请求 → 一帧响应（上游 `tui_gateway.server.dispatch` 的 peer 子集）。
fn dispatch_peer_rpc(text: &str) -> Option<Value> {
    let Ok(request) = serde_json::from_str::<Value>(text) else {
        return Some(rpc_error(Value::Null, -32700, "parse error"));
    };
    if is_response_frame(&request) {
        return None;
    }
    let Some(method) = request.get("method").and_then(Value::as_str) else {
        return None;
    };
    let id = request.get("id").cloned().unwrap_or(Value::Null);
    let params = request.get("params").cloned().unwrap_or_else(|| json!({}));
    let params = match params.as_object() {
        Some(map) => map.clone(),
        None => return Some(rpc_error(id, 4000, "invalid_params")),
    };
    match method {
        "gateway.ping" => Some(rpc_result(id, json!({"ok": true}))),
        "profiles.list" => Some(rpc_result(id, json!({
            "profiles": [{
                "id": crate::pi_gateway_peer::served_profile(),
                "name": "mirach",
                "default": true,
            }],
        }))),
        "groups.capabilities" => {
            let link = crate::pi_gateway_peer::served_room_link();
            let mut capabilities = crate::hosted_rooms::controls::capabilities_payload(500);
            if let Some(map) = capabilities.as_object_mut() {
                // 本网关在 hermes wire 上只服务 peer lending 面，不充当 canonical room driver：
                // 群聊驱动仍在 mirach 自己的 canonical-group-driver 上（见 AGENTS.md）。
                map.insert("protocol_version".into(), json!(2));
                map.insert("driver".into(), json!(false));
                map.insert("persistent_process".into(), json!(false));
                map.insert("authority_gateway_id".into(), json!(crate::pi_groups::installation_id()));
                map.insert("room_link".into(), link);
                map.insert("features".into(), json!([
                    "authority_epoch", "coordinator_fencing", "room_identity", "monotonic_log",
                    "idempotent_send", "replayable_disband", "typed_events", "actor_identity",
                    "log_replication", "authority_takeover", "peer_renewal_horizon",
                ]));
                map.insert("methods".into(), json!([
                    "profiles.list", "groups.capabilities", "groups.peer.invite", "groups.peer.revoke",
                ]));
            }
            Some(rpc_result(id, capabilities))
        }
        "groups.peer.invite" | "groups.peer.revoke" => {
            let profile = params.get("profile").and_then(Value::as_str).unwrap_or("");
            if !profile.is_empty() && profile != crate::pi_gateway_peer::served_profile() {
                return Some(rpc_error(id, 4120, "peer_target_unsupported"));
            }
            let secret = match crate::pi_gateway_peer::gateway_grant_secret() {
                Ok(secret) => secret,
                Err(_) => return Some(rpc_error(id, 4120, "room_link_unavailable")),
            };
            let conn = match crate::pi_groups::open_store() {
                Ok(conn) => conn,
                Err(_) => return Some(rpc_error(id, 4120, "room_link_unavailable")),
            };
            if method == "groups.peer.invite" {
                match crate::pi_gateway_peer::issue_invitation(
                    &conn,
                    &secret,
                    &crate::pi_groups::installation_id(),
                    crate::pi_gateway_peer::served_profile(),
                    &params,
                    &crate::pi_gateway_peer::peer_endpoint(),
                    now_secs(),
                ) {
                    Ok(invitation) => Some(rpc_result(id, invitation)),
                    Err(message) => Some(rpc_error(id, 4120, &message)),
                }
            } else {
                let grant = params.get("grant").and_then(Value::as_str).unwrap_or("");
                match crate::pi_gateway_peer::decode_room_grant(&secret, grant, "status", now_secs()) {
                    Ok(claims) if hermes_local_target_matches(&claims) => {
                        let expires = claims
                            .get("status_expires_at")
                            .or_else(|| claims.get("expires_at"))
                            .and_then(Value::as_f64)
                            .unwrap_or(0.0);
                        match crate::hosted_rooms::grants::revoke_room_grant_scope(
                            &conn, &claims, expires, now_secs(),
                        ) {
                            Ok(()) => Some(rpc_result(id, json!({"revoked": true}))),
                            Err(message) => Some(rpc_error(id, 4122, &message.0)),
                        }
                    }
                    Ok(_) => Some(rpc_error(id, 4122, "permission_denied")),
                    Err(_) => Some(rpc_error(id, 4122, "invalid_room_grant")),
                }
            }
        }
        other => Some(rpc_error(id, -32601, &format!("unknown method: {other}"))),
    }
}

async fn peer_ws_upgrade(
    ws: WebSocketUpgrade,
    State(server): State<Arc<PeerServer>>,
    Query(query): Query<PeerWsQuery>,
) -> Response {
    if !server.token.is_empty() && query.token.as_deref() != Some(server.token.as_str()) {
        return unauthorized();
    }
    ws.on_upgrade(move |socket| peer_ws_session(socket))
}

async fn peer_ws_session(mut socket: WebSocket) {
    if socket.send(Message::Text(peer_gateway_ready().to_string().into())).await.is_err() {
        return;
    }
    while let Some(Ok(message)) = socket.recv().await {
        match message {
            Message::Text(text) => {
                let Some(reply) = dispatch_peer_rpc(text.as_str()) else {
                    continue;
                };
                if socket.send(Message::Text(reply.to_string().into())).await.is_err() {
                    break;
                }
            }
            Message::Close(_) => break,
            _ => {}
        }
    }
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
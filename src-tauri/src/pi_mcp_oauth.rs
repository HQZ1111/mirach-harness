//! MCP OAuth（宿主侧标准 DCR 流程，2026-11-17）。
//!
//! 上游 hermes 的 MCP OAuth 由 `mcp_oauth_manager` 做（discovery / DCR /
//! PKCE / token 刷新）。rpi 的 MCP 适配扩展只发**配置好的 headers**，没有
//! token 管理——所以宿主在这里实现一个标准流程：
//!
//! 1. RFC 9728 protected-resource metadata（`/.well-known/oauth-protected-resource`）
//!    → authorization server；
//! 2. RFC 8414 / OIDC discovery（`/.well-known/oauth-authorization-server` /
//!    `/.well-known/openid-configuration`）；
//! 3. Dynamic Client Registration（`registration_endpoint`，public client
//!    `token_endpoint_auth_method: none`）；
//! 4. PKCE S256 + 本机回环回调（同 pi_login 的 localhost 模式）；
//! 5. token 交换后落 `~/.rpi/agent/mcp-oauth/<server>.json`，并把
//!    `Authorization: Bearer <token>` 写进 mcp.json 的服务器 headers
//!    （rpi-mcp-adapter 会原样发送）。
//!
//! 限制（如实）：只覆盖支持 DCR 的厂商；不支持 DCR 的服务器报明确错误，
//! 需要用户在设置页手工配置 headers。token 刷新 = 过期前（或测试时）用
//! refresh_token 换新；token 存在用户目录（非 OS keyring——与 mcp.json 的
//! headers 同等可见性，文档已注明）。

use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::pi_paths;
use crate::pi_session::on_big_stack;

const CALLBACK_TIMEOUT_SECS: u64 = 300;
const HTTP_TIMEOUT_SECS: u64 = 30;

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn valid_server_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

fn token_path(server: &str) -> Result<PathBuf, String> {
    let dir = pi_paths::agent_dir()?.join("mcp-oauth");
    std::fs::create_dir_all(&dir).map_err(|e| format!("MCP OAuth 目录创建失败: {e}"))?;
    Ok(dir.join(format!("{server}.json")))
}

fn client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(HTTP_TIMEOUT_SECS))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| format!("HTTP client 构造失败: {e}"))
}

fn get_json(client: &reqwest::blocking::Client, url: &str) -> Result<Value, String> {
    let response = client.get(url).send().map_err(|e| format!("GET {url} 失败: {e}"))?;
    let status = response.status();
    let text = response.text().map_err(|e| format!("读取 {url} 失败: {e}"))?;
    if !status.is_success() {
        return Err(format!("GET {url} HTTP {status}: {}", text.chars().take(200).collect::<String>()));
    }
    serde_json::from_str::<Value>(&text).map_err(|e| format!("{url} 不是 JSON: {e}"))
}

fn urlencode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => out.push(byte as char),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// `scheme://host[:port]` 部分。
fn origin_of(url: &str) -> Result<String, String> {
    let Some(scheme_end) = url.find("://") else {
        return Err(format!("非法 URL: {url}"));
    };
    let scheme = &url[..scheme_end];
    let rest = &url[scheme_end + 3..];
    let host_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    if host_end == 0 {
        return Err(format!("非法 URL: {url}"));
    }
    Ok(format!("{scheme}://{}", &rest[..host_end]))
}

fn path_of(url: &str) -> String {
    let Some(scheme_end) = url.find("://") else {
        return String::new();
    };
    let rest = &url[scheme_end + 3..];
    match rest.find('/') {
        Some(index) => rest[index..].split(['?', '#']).next().unwrap_or("").to_owned(),
        None => String::new(),
    }
}

/// RFC 8414 的 well-known 拼接：issuer 带 path 时插在 path 之前。
fn well_known(issuer: &str, suffix: &str) -> String {
    let origin = origin_of(issuer).unwrap_or_else(|_| issuer.trim_end_matches('/').to_owned());
    let path = path_of(issuer).trim_end_matches('/').to_owned();
    format!("{origin}/.well-known/{suffix}{path}")
}

struct AuthServer {
    authorization_endpoint: String,
    token_endpoint: String,
    registration_endpoint: String,
    scopes_supported: Vec<String>,
}

fn discover_as(client: &reqwest::blocking::Client, server_url: &str) -> Result<AuthServer, String> {
    let origin = origin_of(server_url)?;
    let path = path_of(server_url);

    // 1) RFC 9728 protected-resource metadata → authorization_servers。
    let mut issuer: Option<String> = None;
    let mut resource_scopes: Vec<String> = Vec::new();
    let mut resource_meta = None;
    for candidate in [
        format!("{origin}/.well-known/oauth-protected-resource{path}"),
        format!("{origin}/.well-known/oauth-protected-resource"),
    ] {
        if let Ok(value) = get_json(client, &candidate) {
            resource_meta = Some(value);
            break;
        }
    }
    if let Some(meta) = &resource_meta {
        issuer = meta
            .get("authorization_servers")
            .and_then(Value::as_array)
            .and_then(|list| list.first())
            .and_then(Value::as_str)
            .map(str::to_owned);
        resource_scopes = meta
            .get("scopes_supported")
            .and_then(Value::as_array)
            .map(|list| list.iter().filter_map(Value::as_str).map(str::to_owned).collect())
            .unwrap_or_default();
    }

    // 2) AS metadata（issuer 已知 → 按 RFC 8414；否则把服务器 origin 当 issuer）。
    let issuers = match issuer {
        Some(issuer) => vec![issuer],
        None => vec![origin.clone()],
    };
    let mut last_error = String::new();
    for issuer in issuers {
        for suffix in ["oauth-authorization-server", "openid-configuration"] {
            let url = well_known(&issuer, suffix);
            match get_json(client, &url) {
                Ok(meta) => {
                    let authorization_endpoint = meta
                        .get("authorization_endpoint")
                        .and_then(Value::as_str)
                        .ok_or_else(|| format!("{url} 缺 authorization_endpoint"))?
                        .to_owned();
                    let token_endpoint = meta
                        .get("token_endpoint")
                        .and_then(Value::as_str)
                        .ok_or_else(|| format!("{url} 缺 token_endpoint"))?
                        .to_owned();
                    let registration_endpoint = meta
                        .get("registration_endpoint")
                        .and_then(Value::as_str)
                        .ok_or_else(|| {
                            "该授权服务器不支持 Dynamic Client Registration（缺 registration_endpoint）——请在设置页手工配置 Authorization header".to_owned()
                        })?
                        .to_owned();
                    let as_scopes: Vec<String> = meta
                        .get("scopes_supported")
                        .and_then(Value::as_array)
                        .map(|list| list.iter().filter_map(Value::as_str).map(str::to_owned).collect())
                        .unwrap_or_default();
                    let scopes_supported = if !resource_scopes.is_empty() {
                        resource_scopes
                    } else {
                        as_scopes
                    };
                    return Ok(AuthServer {
                        authorization_endpoint,
                        token_endpoint,
                        registration_endpoint,
                        scopes_supported,
                    });
                }
                Err(error) => last_error = error,
            }
        }
    }
    Err(format!("OAuth discovery 失败：{last_error}"))
}

fn register_client(
    client: &reqwest::blocking::Client,
    registration_endpoint: &str,
    redirect_uri: &str,
    scopes: &[String],
) -> Result<(String, Option<String>), String> {
    let mut body = json!({
        "client_name": "Mirach Harness",
        "redirect_uris": [redirect_uri],
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        "token_endpoint_auth_method": "none",
    });
    if !scopes.is_empty() {
        body["scope"] = Value::String(scopes.join(" "));
    }
    let response = client
        .post(registration_endpoint)
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .map_err(|e| format!("DCR 请求失败: {e}"))?;
    let status = response.status();
    let text = response.text().map_err(|e| format!("DCR 响应读取失败: {e}"))?;
    if !status.is_success() {
        return Err(format!(
            "DCR HTTP {status}: {}",
            text.chars().take(300).collect::<String>()
        ));
    }
    let value: Value = serde_json::from_str(&text).map_err(|e| format!("DCR 响应不是 JSON: {e}"))?;
    let client_id = value
        .get("client_id")
        .and_then(Value::as_str)
        .ok_or_else(|| "DCR 响应缺 client_id".to_owned())?
        .to_owned();
    let client_secret = value
        .get("client_secret")
        .and_then(Value::as_str)
        .map(str::to_owned);
    Ok((client_id, client_secret))
}

/// 启动本机回调监听，返回 (redirect_uri, receiver)。
fn start_callback_listener(
    expected_state: String,
) -> Result<(String, std::sync::mpsc::Receiver<Result<String, String>>), String> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| format!("回调端口绑定失败: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let redirect_uri = format!("http://127.0.0.1:{port}/callback");
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        listener
            .set_nonblocking(true)
            .expect("callback listener nonblocking");
        let deadline = std::time::Instant::now() + Duration::from_secs(CALLBACK_TIMEOUT_SECS);
        loop {
            if std::time::Instant::now() > deadline {
                let _ = tx.send(Err("OAuth 回调超时（5 分钟）".to_owned()));
                return;
            }
            match listener.accept() {
                Ok((mut stream, _)) => {
                    let mut buf = [0u8; 4096];
                    let n = stream.read(&mut buf).unwrap_or(0);
                    let request = String::from_utf8_lossy(&buf[..n]).to_string();
                    let first_line = request.lines().next().unwrap_or("");
                    // GET /callback?code=...&state=... HTTP/1.1
                    let target = first_line.split_whitespace().nth(1).unwrap_or("");
                    let query = target.split_once('?').map(|(_, q)| q).unwrap_or("");
                    let mut code = None;
                    let mut state = None;
                    let mut error = None;
                    for pair in query.split('&') {
                        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
                        let decoded = value.replace('+', " ");
                        let value = percent_decode(&decoded);
                        match key {
                            "code" => code = Some(value),
                            "state" => state = Some(value),
                            "error" => error = Some(value),
                            _ => {}
                        }
                    }
                    let body = if error.is_some() {
                        "Authorization failed. You can close this window."
                    } else {
                        "Authorization complete. You can close this window."
                    };
                    let _ = stream.write_all(
                        format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                            body.len()
                        )
                        .as_bytes(),
                    );
                    let result = if let Some(error) = error {
                        Err(format!("OAuth 授权被拒绝: {error}"))
                    } else if state.as_deref() != Some(expected_state.as_str()) {
                        Err("OAuth state 不匹配（可能的 CSRF/陈旧流程）".to_owned())
                    } else if let Some(code) = code {
                        Ok(code)
                    } else {
                        Err("OAuth 回调缺 code".to_owned())
                    };
                    let _ = tx.send(result);
                    return;
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(100));
                }
                Err(e) => {
                    let _ = tx.send(Err(format!("OAuth 回调监听失败: {e}")));
                    return;
                }
            }
        }
    });
    Ok((redirect_uri, rx))
}

fn percent_decode(value: &str) -> String {
    if !value.is_ascii() {
        return value.to_owned();
    }
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(hex) = u8::from_str_radix(&value[i + 1..i + 3], 16) {
                out.push(hex);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

fn pkce_pair() -> (String, String) {
    let verifier = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let digest = Sha256::digest(verifier.as_bytes());
    let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(digest);
    (verifier, challenge)
}

fn exchange_code(
    client: &reqwest::blocking::Client,
    token_endpoint: &str,
    code: &str,
    redirect_uri: &str,
    client_id: &str,
    client_secret: Option<&str>,
    verifier: &str,
) -> Result<Value, String> {
    let mut form = vec![
        ("grant_type".to_owned(), "authorization_code".to_owned()),
        ("code".to_owned(), code.to_owned()),
        ("redirect_uri".to_owned(), redirect_uri.to_owned()),
        ("client_id".to_owned(), client_id.to_owned()),
        ("code_verifier".to_owned(), verifier.to_owned()),
    ];
    if let Some(secret) = client_secret {
        form.push(("client_secret".to_owned(), secret.to_owned()));
    }
    let body = form
        .iter()
        .map(|(k, v)| format!("{}={}", urlencode(k), urlencode(v)))
        .collect::<Vec<_>>()
        .join("&");
    let response = client
        .post(token_endpoint)
        .header("content-type", "application/x-www-form-urlencoded")
        .body(body)
        .send()
        .map_err(|e| format!("token 交换请求失败: {e}"))?;
    let status = response.status();
    let text = response.text().map_err(|e| format!("token 响应读取失败: {e}"))?;
    if !status.is_success() {
        return Err(format!(
            "token 交换 HTTP {status}: {}",
            text.chars().take(300).collect::<String>()
        ));
    }
    serde_json::from_str::<Value>(&text).map_err(|e| format!("token 响应不是 JSON: {e}"))
}

fn save_tokens(server: &str, store: &Value) -> Result<(), String> {
    let path = token_path(server)?;
    std::fs::write(&path, serde_json::to_string_pretty(store).map_err(|e| e.to_string())?)
        .map_err(|e| format!("token 落盘失败 {}: {e}", path.display()))
}

fn load_tokens(server: &str) -> Result<Option<Value>, String> {
    let path = token_path(server)?;
    match std::fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str::<Value>(&text)
            .map(Some)
            .map_err(|e| format!("MCP OAuth token 文件损坏 {}: {e}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("token 读取失败 {}: {e}", path.display())),
    }
}

fn apply_access_token(server: &str, access_token: &str) -> Result<(), String> {
    let Some((_spec, path)) = crate::pi_mcp::server_entry_full(server)? else {
        return Err(format!("MCP 服务器不存在: {server}"));
    };
    crate::pi_mcp::write_server_header(
        &path,
        server,
        "Authorization",
        &format!("Bearer {access_token}"),
    )
}

/// `host.completeMcpOAuth` 的宿主实现：跑完整个 DCR + PKCE + 回调 + token
/// 交换 + headers 写回。阻塞直到浏览器授权完成（最多 5 分钟）。
#[tauri::command(rename_all = "camelCase", async)]
pub fn pi_mcp_oauth_complete(
    server_name: String,
    preset: Option<String>,
    dry_run: Option<bool>,
) -> Result<Value, String> {
    on_big_stack(move || complete_impl(&server_name, preset.as_deref(), dry_run.unwrap_or(false)))?
}

fn complete_impl(server: &str, preset: Option<&str>, dry_run: bool) -> Result<Value, String> {
    if !valid_server_name(server) {
        return Err(format!("非法服务器名: {server}"));
    }
    if crate::pi_mcp::server_entry_full(server)?.is_none() {
        match preset {
            Some(preset) if preset == server => {
                crate::pi_mcp_catalog::pi_mcp_install_preset(server.to_owned())?;
            }
            _ => return Err(format!("MCP 服务器未安装: {server}")),
        }
    }
    let (spec, _path) = crate::pi_mcp::server_entry_full(server)?
        .ok_or_else(|| format!("MCP 服务器未安装: {server}"))?;
    let server_url = spec
        .get("url")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("{server} 不是 HTTP MCP（没有 url）——OAuth 只支持 HTTP 传输"))?
        .to_owned();

    let client = client()?;
    let as_meta = discover_as(&client, &server_url)?;
    let (verifier, challenge) = pkce_pair();
    let state = uuid::Uuid::new_v4().simple().to_string();
    let (redirect_uri, callback) = start_callback_listener(state.clone())?;
    let (client_id, client_secret) = register_client(
        &client,
        &as_meta.registration_endpoint,
        &redirect_uri,
        &as_meta.scopes_supported,
    )?;

    let mut query = vec![
        ("response_type", "code".to_owned()),
        ("client_id", client_id.clone()),
        ("redirect_uri", redirect_uri.clone()),
        ("state", state.clone()),
        ("code_challenge", challenge),
        ("code_challenge_method", "S256".to_owned()),
        ("resource", server_url.clone()),
    ];
    if !as_meta.scopes_supported.is_empty() {
        query.push(("scope", as_meta.scopes_supported.join(" ")));
    }
    let auth_url = format!(
        "{}{}{}",
        as_meta.authorization_endpoint,
        if as_meta.authorization_endpoint.contains('?') { '&' } else { '?' },
        query
            .iter()
            .map(|(k, v)| format!("{}={}", urlencode(k), urlencode(v)))
            .collect::<Vec<_>>()
            .join("&")
    );
    if dry_run {
        // 诊断/测试：只验证 discovery + DCR + 授权 URL 组装（不开浏览器，
        // 不落盘）。
        return Ok(json!({
            "ok": true,
            "dryRun": true,
            "server": server,
            "authorizationEndpoint": as_meta.authorization_endpoint,
            "tokenEndpoint": as_meta.token_endpoint,
            "registrationEndpoint": as_meta.registration_endpoint,
            "clientId": client_id,
            "redirectUri": redirect_uri,
            "authUrlLength": auth_url.len(),
        }));
    }
    open::that(&auth_url).map_err(|e| format!("打开浏览器失败: {e}"))?;
    let code = callback
        .recv_timeout(Duration::from_secs(CALLBACK_TIMEOUT_SECS + 5))
        .map_err(|_| "OAuth 回调等待超时".to_owned())??;
    let tokens = exchange_code(
        &client,
        &as_meta.token_endpoint,
        &code,
        &redirect_uri,
        &client_id,
        client_secret.as_deref(),
        &verifier,
    )?;
    let access_token = tokens
        .get("access_token")
        .and_then(Value::as_str)
        .ok_or_else(|| "token 响应缺 access_token".to_owned())?
        .to_owned();
    let expires_in = tokens.get("expires_in").and_then(Value::as_i64).unwrap_or(3600);
    let store = json!({
        "access_token": access_token,
        "refresh_token": tokens.get("refresh_token").cloned().unwrap_or(Value::Null),
        "token_type": tokens.get("token_type").cloned().unwrap_or_else(|| json!("Bearer")),
        "scope": tokens.get("scope").cloned().unwrap_or(Value::Null),
        "expires_at": now_secs() + expires_in,
        "token_endpoint": as_meta.token_endpoint,
        "client_id": client_id,
        "client_secret": client_secret,
        "resource": server_url,
    });
    save_tokens(server, &store)?;
    apply_access_token(server, &access_token)?;
    Ok(json!({ "ok": true, "server": server }))
}

/// 用 refresh_token 换新 access_token，并更新 mcp.json 的 Authorization。
#[tauri::command(rename_all = "camelCase", async)]
pub fn pi_mcp_oauth_refresh(server_name: String) -> Result<Value, String> {
    on_big_stack(move || refresh_impl(&server_name))?
}

fn refresh_impl(server: &str) -> Result<Value, String> {
    let store = load_tokens(server)?.ok_or_else(|| format!("{server} 没有 OAuth token（先授权）"))?;
    let refresh_token = store
        .get("refresh_token")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("{server} 没有 refresh_token（重新授权）"))?
        .to_owned();
    let token_endpoint = store
        .get("token_endpoint")
        .and_then(Value::as_str)
        .ok_or_else(|| "token 文件缺 token_endpoint".to_owned())?
        .to_owned();
    let client_id = store
        .get("client_id")
        .and_then(Value::as_str)
        .ok_or_else(|| "token 文件缺 client_id".to_owned())?
        .to_owned();
    let client_secret = store.get("client_secret").and_then(Value::as_str);
    let mut form = vec![
        ("grant_type".to_owned(), "refresh_token".to_owned()),
        ("refresh_token".to_owned(), refresh_token),
        ("client_id".to_owned(), client_id.clone()),
    ];
    if let Some(secret) = client_secret {
        form.push(("client_secret".to_owned(), secret.to_owned()));
    }
    let body = form
        .iter()
        .map(|(k, v)| format!("{}={}", urlencode(k), urlencode(v)))
        .collect::<Vec<_>>()
        .join("&");
    let response = client()?
        .post(&token_endpoint)
        .header("content-type", "application/x-www-form-urlencoded")
        .body(body)
        .send()
        .map_err(|e| format!("refresh 请求失败: {e}"))?;
    let status = response.status();
    let text = response.text().map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!(
            "refresh HTTP {status}: {}",
            text.chars().take(300).collect::<String>()
        ));
    }
    let tokens: Value = serde_json::from_str(&text).map_err(|e| format!("refresh 响应不是 JSON: {e}"))?;
    let access_token = tokens
        .get("access_token")
        .and_then(Value::as_str)
        .ok_or_else(|| "refresh 响应缺 access_token".to_owned())?
        .to_owned();
    let mut store = store;
    store["access_token"] = Value::String(access_token.clone());
    if let Some(refresh) = tokens.get("refresh_token") {
        store["refresh_token"] = refresh.clone();
    }
    let expires_in = tokens.get("expires_in").and_then(Value::as_i64).unwrap_or(3600);
    store["expires_at"] = json!(now_secs() + expires_in);
    save_tokens(server, &store)?;
    apply_access_token(server, &access_token)?;
    Ok(json!({ "ok": true, "server": server }))
}

/// token 快过期（60s 内）时自动刷新；没有 token = 无事可做。
pub(crate) fn ensure_fresh(server: &str) -> Result<(), String> {
    let Some(store) = load_tokens(server)? else {
        return Ok(());
    };
    let expires_at = store.get("expires_at").and_then(Value::as_i64).unwrap_or(0);
    if expires_at > now_secs() + 60 {
        return Ok(());
    }
    if store.get("refresh_token").and_then(Value::as_str).is_some() {
        refresh_impl(server)?;
    }
    Ok(())
}

/// 启动时的批量刷新：10 分钟内到期的 token 全部换新。单个失败不影响其它
/// （失败清单如实返回，前端 console 可见）。
#[tauri::command(rename_all = "camelCase", async)]
pub fn pi_mcp_oauth_refresh_all() -> Result<Value, String> {
    on_big_stack(refresh_all_impl)?
}

fn refresh_all_impl() -> Result<Value, String> {
    let dir = pi_paths::agent_dir()?.join("mcp-oauth");
    if !dir.is_dir() {
        return Ok(json!({ "refreshed": [], "failed": [] }));
    }
    let mut refreshed = Vec::new();
    let mut failed = Vec::new();
    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Some(name) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        let store = match load_tokens(name) {
            Ok(Some(store)) => store,
            Ok(None) => continue,
            Err(error) => {
                failed.push(json!({ "name": name, "error": error }));
                continue;
            }
        };
        let expires_at = store.get("expires_at").and_then(Value::as_i64).unwrap_or(0);
        if expires_at > now_secs() + 600 {
            continue;
        }
        if store.get("refresh_token").and_then(Value::as_str).is_none() {
            continue;
        }
        match refresh_impl(name) {
            Ok(_) => refreshed.push(json!(name)),
            Err(error) => failed.push(json!({ "name": name, "error": error })),
        }
    }
    Ok(json!({ "refreshed": refreshed, "failed": failed }))
}

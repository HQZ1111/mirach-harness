//! MOSS Live 桥（模思智能 platform.moss.cn 的实时语音 WSS，2026-11-12；
//! 用户："复制hermes把moss live等双全工做个桥接层，能连接api"——hermes 里
//! 没有 moss live（全树唯一命中是宠物生成的示例词），真正的产品 =
//! 模思智能（www.moss.cn，复旦 OpenMOSS 团队孵化）开放平台的
//! `moss-live-1.0`）。
//!
//! 协议（platform.moss.cn/docs/reference/moss-live）：
//! - `wss://api.mosi.cn/v1/realtime?model=moss-live-1.0`，握手头
//!   `Authorization: Bearer $MOSS_API_KEY`——**浏览器无法设 WS 握手头**，
//!   官网要求 key 留服务端：本桥代持（前端只见事件流，key 永不下发）；
//! - 文本帧 = `{"action": …}` JSON；上行音频 = `0x00` + 16kHz S16LE PCM；
//!   下行音频 = 48kHz S16LE PCM 裸帧（tagged-v1）；
//! - 会话 = `attach_session`（`delegation:{type:"client"}`）→
//!   `session_attached`；委托回报 = `session.thinking/commentary.append`
//!   （≤2000 字，`delegation_id` 关联）——与宿主已建的委托回路同构。
//!
//! key 链：settings `voice.moss_live.api_key` → `MOSS_API_KEY` 环境变量。
//! 传输层：tokio-tungstenite（独立 tokio 线程持活；事件经 app emit 广播，
//! 前端 `listen("moss-live://event")` / `listen("moss-live://audio")` 消费）。

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{LazyLock, Mutex};

use base64::Engine as _;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::{Message as WsMessage};
use tokio::sync::mpsc::UnboundedSender;

const DEFAULT_MOSS_WSS: &str = "wss://api.mosi.cn/v1/realtime";
const DEFAULT_MOSS_MODEL: &str = "moss-live-1.0";

/// key 链（同 GPT-Live 桥的凭据链形态）：settings `voice.moss_live.api_key`
/// → `MOSS_API_KEY` 环境变量。base/model 可被 settings 覆盖（默认官方端点）。
/// base 无 path（host 后直接 `?` 或结束）时补 `/`：tungstenite 的 request
/// line 原样用 path_and_query，`GET ?…` 是非法 HTTP（Node/官网解析器都会
/// 自动补 `/`，实测 tungstenite 不补 → 400 Bad Request，2026-11-13 工具面
/// E2E 实锤）。
fn normalize_base_url(base: &str) -> String {
    let (authority_and_path, query) = match base.split_once('?') {
        Some((a, q)) => (a, Some(q)),
        None => (base, None),
    };
    let scheme_end = authority_and_path
        .find("://")
        .map(|i| i + 3)
        .unwrap_or(0);
    let has_path = authority_and_path[scheme_end..].contains('/');
    let fixed = if has_path {
        authority_and_path.to_string()
    } else {
        format!("{authority_and_path}/")
    };
    match query {
        Some(q) => format!("{fixed}?{q}"),
        None => fixed,
    }
}

fn moss_config() -> Result<(String, String, String), String> {
    let settings = crate::pi_settings::pi_get_settings()?.unwrap_or(json!({}));
    let live = settings
        .get("voice")
        .and_then(|v| v.get("moss_live"))
        .cloned()
        .unwrap_or(json!({}));
    let key = live
        .get("api_key")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
        .or_else(|| {
            std::env::var("MOSS_API_KEY")
                .ok()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
        })
        .ok_or("MOSS Live needs an API key (set MOSS_API_KEY or voice.moss_live.api_key)")?;
    let base = live
        .get("base_url")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(DEFAULT_MOSS_WSS)
        .to_string();
    let model = live
        .get("model")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(DEFAULT_MOSS_MODEL)
        .to_string();
    Ok((base, key, model))
}

/// 就绪判定（设置页「语音」节消费）：key 能解析即 available。
pub fn moss_status() -> Value {
    match moss_config() {
        Ok((_base, _key, model)) => json!({
            "mossAvailable": true,
            "mossModel": model,
            "mossReason": Value::Null,
        }),
        Err(reason) => json!({
            "mossAvailable": false,
            "mossModel": DEFAULT_MOSS_MODEL,
            "mossReason": reason,
        }),
    }
}

// ── 会话注册表 ────────────────────────────────────────────────────────────

enum OutMsg {
    Text(String),
    Audio(Vec<u8>),
    Close,
}

struct MossHandle {
    tx: UnboundedSender<OutMsg>,
}

static SESSIONS: LazyLock<Mutex<HashMap<u32, MossHandle>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static NEXT_HANDLE: AtomicU32 = AtomicU32::new(1);

fn sessions_mut() -> std::sync::MutexGuard<'static, HashMap<u32, MossHandle>> {
    // 锁中毒 = 前一线程 panic，会话表已不可信——直接 poison 到空表（规矩
    // 12：不静默兜底，后续 open 会重建条目）
    SESSIONS.lock().unwrap_or_else(|p| p.into_inner())
}

fn emit(app: &tauri::AppHandle, event: &str, payload: Value) {
    use tauri::Emitter;
    if let Err(e) = app.emit(event, payload) {
        eprintln!("[moss-live] emit {event} 失败: {e}");
    }
}

/// 打开 WSS 会话（返回句柄；事件/音频经 app emit 广播给前端）。
/// 事件通道：`moss-live://event`（text JSON）、`moss-live://audio`
/// （base64 PCM16 48k 裸帧）、`moss-live://closed`（{handle, reason}）。
#[tauri::command(async)]
pub fn pi_voice_moss_open(app: tauri::AppHandle) -> Result<Value, String> {
    let (base, key, model) = moss_config()?;
    let base = normalize_base_url(&base);
    let url = if base.contains('?') {
        base.clone()
    } else {
        format!("{base}?model={model}")
    };
    let mut request = url
        .as_str()
        .into_client_request()
        .map_err(|e| format!("WSS 请求构造失败: {e}"))?;
    request.headers_mut().insert(
        "Authorization",
        http_header_value(&format!("Bearer {key}"))?,
    );

    let handle_id = NEXT_HANDLE.fetch_add(1, Ordering::SeqCst);
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<OutMsg>();
    sessions_mut().insert(handle_id, MossHandle { tx });

    let app_cl = app.clone();
    let handle_url = url.clone();
    std::thread::Builder::new()
        .name("moss-live-ws".into())
        .spawn(move || {
            let rt = match tokio::runtime::Runtime::new() {
                Ok(rt) => rt,
                Err(e) => {
                    emit(&app_cl, "moss-live://closed", json!({"handle": handle_id, "reason": format!("tokio runtime: {e}")}));
                    sessions_mut().remove(&handle_id);
                    return;
                }
            };
            rt.block_on(async move {
                let ws = match tokio_tungstenite::connect_async(request).await {
                    Ok((ws, _resp)) => ws,
                    Err(e) => {
                        emit(&app_cl, "moss-live://closed", json!({"handle": handle_id, "reason": format!("WSS 连接失败: {}", describe_handshake_error(&e))}));
                        sessions_mut().remove(&handle_id);
                        return;
                    }
                };
                println!("[moss-live] connected: {handle_url}");
                let (mut sink, mut stream) = ws.split();

                // 写半边：rx（文本/音频/关闭）→ sink
                let write = async move {
                    while let Some(msg) = rx.recv().await {
                        let out = match msg {
                            OutMsg::Text(t) => WsMessage::Text(t.into()),
                            OutMsg::Audio(b) => WsMessage::Binary(b.into()),
                            OutMsg::Close => {
                                let _ = sink.send(WsMessage::Close(None)).await;
                                let _ = sink.flush().await;
                                return;
                            }
                        };
                        if sink.send(out).await.is_err() {
                            return;
                        }
                    }
                };
                let write_task = tokio::spawn(write);

                // 读半边：vendor 事件/音频 → emit
                while let Some(msg) = stream.next().await {
                    match msg {
                        Ok(WsMessage::Text(t)) => {
                            let text = t.to_string();
                            emit(&app_cl, "moss-live://event", json!({"handle": handle_id, "text": text}));
                        }
                        Ok(WsMessage::Binary(b)) => {
                            // tagged-v1 下行是裸 PCM（无前缀）；base64 后广播
                            let b64 = base64::engine::general_purpose::STANDARD.encode(&b);
                            emit(&app_cl, "moss-live://audio", json!({"handle": handle_id, "audio": b64}));
                        }
                        Ok(WsMessage::Close(_)) => {
                            emit(&app_cl, "moss-live://closed", json!({"handle": handle_id, "reason": "closed"}));
                            break;
                        }
                        Ok(_) => {}
                        Err(e) => {
                            emit(&app_cl, "moss-live://closed", json!({"handle": handle_id, "reason": format!("transport: {e}")}));
                            break;
                        }
                    }
                }
                // 拆写半边（Close 消息让 writer 返回）
                let _ = write_task.await;
                sessions_mut().remove(&handle_id);
                emit(&app_cl, "moss-live://closed", json!({"handle": handle_id, "reason": "session ended"}));
            });
        })
        .map_err(|e| format!("moss-live 线程启动失败: {e}"))?;

    Ok(json!({ "handle": handle_id, "model": model }))
}

fn http_header_value(v: &str) -> Result<tokio_tungstenite::tungstenite::http::HeaderValue, String> {
    tokio_tungstenite::tungstenite::http::HeaderValue::from_str(v)
        .map_err(|e| format!("头构造失败: {e}"))
}

/// 握手失败的可读描述：tungstenite 的 Display 只有 `HTTP error: 402 Payment
/// Required`，不含 vendor 的响应体——而计费/鉴权类拒绝的**原因全在 body 里**
/// （实测 402 body = `insufficient_credits`，403 body = `iam api key auth
/// failed`）。能解出 OpenAI 风格错误体就附在括号里，解不出原样返回。
fn describe_handshake_error(e: &tokio_tungstenite::tungstenite::Error) -> String {
    use tokio_tungstenite::tungstenite::Error as WsError;
    if let WsError::Http(resp) = e {
        let detail = resp
            .body()
            .as_ref()
            .map(|bytes| {
                serde_json::from_slice::<serde_json::Value>(bytes)
                    .ok()
                    .and_then(|v| {
                        let err = v.get("error")?;
                        let code = err.get("code").and_then(|c| c.as_str()).unwrap_or("");
                        let message = err.get("message").and_then(|m| m.as_str()).unwrap_or("");
                        if code.is_empty() && message.is_empty() {
                            None
                        } else if code.is_empty() {
                            Some(message.to_owned())
                        } else {
                            Some(format!("{code}: {message}"))
                        }
                    })
                    .unwrap_or_else(|| {
                        let text = String::from_utf8_lossy(bytes);
                        text.trim().chars().take(200).collect::<String>()
                    })
            })
            .unwrap_or_default();
        if detail.is_empty() {
            return e.to_string();
        }
        return format!("{e}（{detail}）");
    }
    e.to_string()
}

fn send_to(handle: u32, msg: OutMsg) -> Result<(), String> {
    // 守卫先落绑定（链式临时在 `?` 前就 drop 会借用悬挂）
    let guard = sessions_mut();
    let h = guard
        .get(&handle)
        .ok_or_else(|| format!("moss-live 会话不存在: {handle}"))?;
    h.tx.send(msg).map_err(|_| "moss-live 会话已关闭".to_string())
}

/// 发送一个文本事件（前端拼 `{"action": …}` JSON 后整帧下发）。
#[tauri::command(async)]
pub fn pi_voice_moss_send_text(handle: u32, text: String) -> Result<(), String> {
    send_to(handle, OutMsg::Text(text))
}

/// 发送一帧上行音频（前端 base64 传入 16kHz S16LE PCM；桥加 0x00 前缀）。
#[tauri::command(async)]
pub fn pi_voice_moss_send_audio(handle: u32, audio: String) -> Result<(), String> {
    let raw = base64::engine::general_purpose::STANDARD
        .decode(&audio)
        .map_err(|e| format!("音频帧解码失败: {e}"))?;
    let mut frame = Vec::with_capacity(raw.len() + 1);
    frame.push(0x00);
    frame.extend_from_slice(&raw);
    send_to(handle, OutMsg::Audio(frame))
}

/// 关闭会话（协议：关 WSS 即拆除；vendor 发 `session.closing` 收尾）。
#[tauri::command(async)]
pub fn pi_voice_moss_close(handle: u32) -> Result<(), String> {
    send_to(handle, OutMsg::Close)
}

#[cfg(test)]
mod tests {
    use super::normalize_base_url;

    #[test]
    fn official_endpoint_untouched() {
        assert_eq!(
            normalize_base_url("wss://api.mosi.cn/v1/realtime"),
            "wss://api.mosi.cn/v1/realtime"
        );
    }

    #[test]
    fn pathless_base_gets_slash() {
        // 2026-11-13 E2E 实锤：无 path 的 base → request line `GET ?…` 非法
        // HTTP（Node 解析器回 400）——必须补 `/`
        assert_eq!(
            normalize_base_url("ws://127.0.0.1:18779"),
            "ws://127.0.0.1:18779/"
        );
        assert_eq!(
            normalize_base_url("ws://127.0.0.1:18779?model=moss-live-1.0"),
            "ws://127.0.0.1:18779/?model=moss-live-1.0"
        );
    }

    #[test]
    fn existing_path_and_query_untouched() {
        assert_eq!(
            normalize_base_url("wss://api.mosi.cn/v1/realtime?model=moss-live-1.0"),
            "wss://api.mosi.cn/v1/realtime?model=moss-live-1.0"
        );
    }

    #[test]
    fn pathless_with_query_and_trailing_slash_variants() {
        assert_eq!(
            normalize_base_url("wss://api.mosi.cn?model=m1"),
            "wss://api.mosi.cn/?model=m1"
        );
        assert_eq!(normalize_base_url("wss://api.mosi.cn/"), "wss://api.mosi.cn/");
    }

    #[test]
    fn handshake_error_includes_vendor_body() {
        use super::describe_handshake_error;
        use tokio_tungstenite::tungstenite::Error as WsError;
        // 2026-11-19 实测体：402 insufficient_credits（余额）/ 403 iam auth（key 错）——
        // 只报 "HTTP error: 402" 用户看不出是计费问题；body 必须进 reason。
        let resp = tokio_tungstenite::tungstenite::http::Response::builder()
            .status(402)
            .body(Some(
                b"{\"error\":{\"message\":\"billing error\",\"type\":\"billing_error\",\"param\":null,\"code\":\"insufficient_credits\"}}".to_vec(),
            ))
            .unwrap();
        let text = describe_handshake_error(&WsError::Http(Box::new(resp)));
        assert!(text.contains("402"), "{text}");
        assert!(text.contains("insufficient_credits"), "{text}");
        // 非 HTTP 错误原样透传
        assert_eq!(
            describe_handshake_error(&WsError::ConnectionClosed),
            "Connection closed normally"
        );
    }
}

//! GPT-Live 全双工语音桥（hermes tools/voice_live.py 的宿主 Rust 等价面，
//! 2026-11-11 用户："复制hermes把moss live等双全工做个桥接层，能连接api"）。
//!
//! 三分职（hermes 同构，tools/voice_live.py 模块头原文）：
//! - **前端**（`src/lib/voice-live.ts`）持 WebRTC 媒体会话（mic 入、语音出）
//!   与 `oai-events` 数据通道（transcript / thinking / commentary / mute）；
//! - **本模块做唯一的服务端一步**：把浏览器的 SDP offer 换成 vendor answer
//!   （`POST {base}/live/sessions`，Bearer key）——**key 永不进前端**；
//! - 会话内的 delegation / commentary 由前端桥接层与 agent 会话驱动（hermes
//!   use-voice-live-conversation 的宿主对接，后续轮）。
//!
//! 凭据链（hermes `_resolve_credentials` 同款）：settings.json 的
//! `voice.gpt_live.api_key` → `OPENAI_API_KEY` 环境变量。无 key =
//! `available:false` + reason 可见；status **永不返回 key 本身**。
//!
//! Vendor contract: https://developers.openai.com/api/docs/guides/live
//! （+ live-delegation / voice-webrtc）。计费在 OpenAI key 上，与 agent
//! turn 分离（$0.05/min）。

use serde_json::{json, Value};

use crate::pi_session::on_big_stack;

const GPT_LIVE_MODE: &str = "gpt-live";
const CHAINED_MODE: &str = "chained";
/// MOSS Live（模思智能 moss.cn 的 WSS 全双工语音，pi_voice_moss.rs 承载）。
const MOSS_LIVE_MODE: &str = "moss-live";
const DEFAULT_LIVE_MODEL: &str = "gpt-live-1";
const DEFAULT_LIVE_VOICE: &str = "marin";
const DEFAULT_LIVE_BASE_URL: &str = "https://api.openai.com/v1";

/// Persona（hermes LIVE_PERSONA 逐字——短是有意的：live 模型上下文窗口小，
/// vendor guide 要求 role + style + 有标注的 delegation policy；真正的
/// 指令/工具/记忆在 agent 会话里）。
const LIVE_PERSONA: &str = "You are Hermes, a calm and friendly voice assistant. Speak naturally at an unhurried pace. Be clear and direct, not overly cheerful. If the user is frustrated, acknowledge it briefly and focus on the next helpful step.\n\nBackchannel policy: Use moderate backchannels. Acknowledge naturally without competing with the main response.\n\nInterruption policy: Stop speaking when the user interrupts. Listen to what they say.\n\nDelegation policy:\nBackend tools:\n- Hermes agent: a full AI agent with tools — it can run commands, read and edit files, browse the web, search, remember things across sessions, schedule tasks, and reason carefully about anything. It is the one who actually does work and knows facts.\n\nDelegate to the backend when:\n- The user asks a question that needs facts, current information, or careful reasoning.\n- The user asks you to do, check, find, make, fix, run or remember anything.\n- A correction changes work already requested.\n\nDo not delegate to the backend when:\n- The user greets you, makes small talk, or asks you to repeat a result already provided.\n- You need a brief clarification to understand the request.\n\nDelegate before giving an answer that depends on backend work. Do not guess the result while waiting; say briefly that you are checking, then wait for the result.";

fn voice_section(settings: &Value) -> Value {
    settings.get("voice").cloned().unwrap_or(Value::Null)
}

fn live_section(settings: &Value) -> Value {
    voice_section(settings)
        .get("gpt_live")
        .cloned()
        .unwrap_or(Value::Null)
}

/// `voice.voice_chat_mode`：`chained`（默认）或 `gpt-live`（容忍下划线拼法，
/// hermes voice_chat_mode :107-111 同规则）。
fn voice_chat_mode(settings: &Value) -> &'static str {
    let raw = voice_section(settings)
        .get("voice_chat_mode")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_lowercase()
        .replace('_', "-");
    if raw == GPT_LIVE_MODE || raw == "gptlive" || raw == "live" {
        GPT_LIVE_MODE
    } else if raw == MOSS_LIVE_MODE || raw == "moss" {
        MOSS_LIVE_MODE
    } else {
        CHAINED_MODE
    }
}

/// `(api_key, base_url)`：`voice.gpt_live.api_key` 优先，否则 `OPENAI_API_KEY`
/// 环境变量（hermes 的 VOICE_TOOLS_OPENAI_KEY 链是它 gateway 的音频工具链；
/// 宿主无该链，取 settings → 环境变量两级）。
fn resolve_credentials(live: &Value) -> (Option<String>, String) {
    let from_settings = live
        .get("api_key")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from);
    let api_key = from_settings.or_else(|| {
        std::env::var("OPENAI_API_KEY")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    });
    let base_url = live
        .get("base_url")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(DEFAULT_LIVE_BASE_URL)
        .trim_end_matches('/')
        .to_string();
    (api_key, base_url)
}

fn live_instructions(live: &Value) -> String {
    let extra = live
        .get("instructions")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .unwrap_or("");
    if extra.is_empty() {
        LIVE_PERSONA.to_string()
    } else {
        format!("{LIVE_PERSONA}\n\n{extra}")
    }
}

/// 客户端可读的就绪判定：选中的模式 + GPT-Live 能否启动（key 能解析到）。
/// **永不返回 key**（hermes resolve_gpt_live_status :131-144 同款）。
pub fn voice_live_status() -> Result<Value, String> {
    let settings = crate::pi_settings::pi_get_settings()?.unwrap_or(json!({}));
    let mode = voice_chat_mode(&settings);
    let live = live_section(&settings);
    let (api_key, _base) = resolve_credentials(&live);
    // MOSS Live 就绪独立判定（模思 key 链：voice.moss_live.api_key →
    // MOSS_API_KEY——与 OpenAI 链互不干扰）
    let moss = crate::pi_voice_moss::moss_status();
    Ok(json!({
        "mode": mode,
        "available": api_key.is_some(),
        "reason": if api_key.is_some() {
            None
        } else {
            Some("no OpenAI API key (set OPENAI_API_KEY or voice.gpt_live.api_key)")
        },
        "model": live.get("model").and_then(|v| v.as_str()).filter(|s| !s.trim().is_empty()).unwrap_or(DEFAULT_LIVE_MODEL),
        "voice": live.get("voice").and_then(|v| v.as_str()).filter(|s| !s.trim().is_empty()).unwrap_or(DEFAULT_LIVE_VOICE),
        "mossAvailable": moss.get("mossAvailable"),
        "mossModel": moss.get("mossModel"),
        "mossReason": moss.get("mossReason"),
    }))
}

/// `POST /v1/live/sessions` 的 `session` 对象（client delegation；WebRTC
/// 传输自行协商音频格式，所以不设 format——hermes build_session_config
/// :147-159 同款）。history = 文本 turn 种子（toLiveHistory 前端产物）。
fn build_session_config(live: &Value, history: Option<&Vec<Value>>) -> Value {
    let mut config = json!({
        "model": live.get("model").and_then(|v| v.as_str()).filter(|s| !s.trim().is_empty()).unwrap_or(DEFAULT_LIVE_MODEL),
        "instructions": live_instructions(live),
        "audio": { "output": { "voice": live.get("voice").and_then(|v| v.as_str()).filter(|s| !s.trim().is_empty()).unwrap_or(DEFAULT_LIVE_VOICE) } },
        "delegation": { "type": "client" },
    });
    if let Some(history) = history.filter(|h| !h.is_empty()) {
        config["input"] = json!(history);
    }
    config
}

/// 把渲染层的 SDP offer 换成 Live session answer（hermes create_webrtc_session
/// :162-187 逐语义）。缺 key = Err（明说）；vendor 拒绝 = Err（带状态码与
/// 响应片段）。返回 vendor 原样 `{session, transport}` 包一层 ok。
pub fn create_webrtc_session(sdp_offer: &str, history: Option<Vec<Value>>) -> Result<Value, String> {
    // fail-fast：SDP 形状先于凭据检查（缺 offer 连 key 读取都不必做）。
    if sdp_offer.trim().is_empty() {
        return Err("missing SDP offer".into());
    }
    let settings = crate::pi_settings::pi_get_settings()?.unwrap_or(json!({}));
    let live = live_section(&settings);
    let (api_key, base_url) = resolve_credentials(&live);
    let Some(api_key) = api_key else {
        return Err(
            "GPT-Live needs an OpenAI API key (OPENAI_API_KEY or voice.gpt_live.api_key)".into(),
        );
    };
    let body = json!({
        "session": build_session_config(&live, history.as_ref()),
        "transport": { "type": "webrtc", "sdp": sdp_offer },
    });
    let url = format!("{base_url}/live/sessions");
    let payload = serde_json::to_vec(&body).map_err(|e| format!("请求体序列化失败: {e}"))?;

    let client = reqwest::blocking::Client::new();
    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json")
        .body(payload)
        .timeout(std::time::Duration::from_secs(45))
        .send()
        .map_err(|e| format!("GPT-Live 会话请求失败: {e}"))?;
    let status = resp.status();
    let text = resp.text().map_err(|e| format!("响应读取失败: {e}"))?;
    if status.as_u16() != 200 && status.as_u16() != 201 {
        let detail: String = text.chars().take(600).collect();
        return Err(format!("GPT-Live session creation failed ({status}): {detail}"));
    }
    let parsed: Value =
        serde_json::from_str(&text).map_err(|e| format!("响应不是 JSON: {e}"))?;
    if parsed.get("transport").and_then(|t| t.get("sdp")).is_none() {
        return Err("GPT-Live session creation failed: vendor response missing transport.sdp".into());
    }
    Ok(json!({ "ok": true, "session": parsed.get("session"), "transport": parsed.get("transport") }))
}

// ── IPC（宿主桥接层对前端的三个口） ──────────────────────────────────────

/// 状态面（available/mode/model/voice/reason——**永不返回 key**）。
#[tauri::command(async)]
pub fn pi_voice_live_status() -> Result<Value, String> {
    voice_live_status()
}

/// 配置写入（设置页「语音」节）：settings.json `voice` 段读-改-写（同
/// persist_default_model 通道，保留其余字段）。`api_key` **只写不读**——
/// status 永不回显 key 本身，UI 只报已配置/未配置；空串 = 清除该项。
#[tauri::command(rename_all = "camelCase", async)]
pub fn pi_voice_live_set_config(
    api_key: Option<String>,
    mode: Option<String>,
    model: Option<String>,
    voice: Option<String>,
    moss_api_key: Option<String>,
) -> Result<Value, String> {
    crate::pi_settings::persist_voice_live_config(api_key, mode, model, voice, moss_api_key)
}

/// SDP 交换（浏览器 offer → vendor answer）。key 只在本步使用、只落服务端
/// 内存；45s 超时语义由 pi::http 请求超时承担（hermes timeoutMs 45_000 同域）。
#[tauri::command(async)]
pub fn pi_voice_live_session(sdp: String, history: Option<Vec<Value>>) -> Result<Value, String> {
    // on_big_stack 外层是 spawn/join 错误、内层是 create_webrtc_session 的
    // 业务错误——and_then 拍平成一层（错误信息可区分，规矩 12 如实传播）。
    on_big_stack(move || create_webrtc_session(&sdp, history)).and_then(|inner| inner)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mode_parsing_accepts_underscore_and_live_spellings() {
        let chained = json!({"voice": {"voice_chat_mode": "chained"}});
        let live = json!({"voice": {"voice_chat_mode": "gpt-live"}});
        let underscore = json!({"voice": {"voice_chat_mode": "gpt_live"}});
        let bare = json!({"voice": {"voice_chat_mode": "live"}});
        let junk = json!({"voice": {"voice_chat_mode": "whatever"}});
        let missing = json!({});
        assert_eq!(voice_chat_mode(&chained), CHAINED_MODE);
        assert_eq!(voice_chat_mode(&live), GPT_LIVE_MODE);
        assert_eq!(voice_chat_mode(&underscore), GPT_LIVE_MODE);
        assert_eq!(voice_chat_mode(&bare), GPT_LIVE_MODE);
        assert_eq!(voice_chat_mode(&junk), CHAINED_MODE);
        assert_eq!(voice_chat_mode(&missing), CHAINED_MODE);
    }

    #[test]
    fn status_never_contains_the_key() {
        let settings = json!({
            "voice": { "voice_chat_mode": "gpt-live", "gpt_live": { "api_key": "sk-secret" } }
        });
        let status = voice_live_status_with(&settings).expect("status");
        assert_eq!(status["available"], json!(true));
        assert_eq!(status["mode"], json!(GPT_LIVE_MODE));
        let text = status.to_string();
        assert!(!text.contains("sk-secret"), "key leaked into status: {text}");
    }

    #[test]
    fn status_without_key_reports_reason() {
        let status = voice_live_status_with(&json!({})).expect("status");
        assert_eq!(status["available"], json!(false));
        let reason = status["reason"].as_str().expect("reason present");
        assert!(reason.contains("OPENAI_API_KEY"));
    }

    #[test]
    fn session_config_carries_delegation_and_history() {
        let live = json!({"voice": {"gpt_live": {"voice": "cedar"}}});
        let config = build_session_config(&live_section(&live), None);
        assert_eq!(config["model"], json!(DEFAULT_LIVE_MODEL));
        assert_eq!(config["audio"]["output"]["voice"], json!("cedar"));
        assert_eq!(config["delegation"]["type"], json!("client"));
        assert!(config.get("input").is_none());

        let history = vec![json!({
            "type": "message",
            "role": "user",
            "content": [{"type": "input_text", "text": "hi"}]
        })];
        let with_input = build_session_config(&live_section(&live), Some(&history));
        assert_eq!(with_input["input"], json!(history));
    }

    #[test]
    fn create_webrtc_session_refuses_blank_sdp() {
        // fail-fast：缺 offer 在凭据检查之前（不读 key、不发网络）。
        let err = create_webrtc_session("  ", None).unwrap_err();
        assert!(err.contains("SDP"), "unexpected: {err}");
    }

    #[test]
    fn credentials_prefer_settings_and_trim_base_url() {
        let live = json!({"gpt_live": {"api_key": " sk-x ", "base_url": "https://proxy.example/v1/"}});
        let (key, base) = resolve_credentials(&live_section(&json!({"voice": live})));
        assert_eq!(key.as_deref(), Some("sk-x"));
        assert_eq!(base, "https://proxy.example/v1");
        // 空串 settings key → 视为未配置（回落环境变量链，不在本断言内）。
        let empty = json!({"voice": {"gpt_live": {"api_key": "   "}}});
        let (key2, _) = resolve_credentials(&live_section(&empty));
        // 环境变量可能恰有 OPENAI_API_KEY——只断言"settings 空串被忽略"。
        assert_ne!(key2.as_deref(), Some("   "));
    }

    // voice_live_status_with：同 voice_live_status 但吃显式 settings（测试
    // 隔离——真实版读 pi_get_settings + 环境变量，测试不污染全局文档）。
    fn voice_live_status_with(settings: &Value) -> Result<Value, String> {
        let mode = voice_chat_mode(settings);
        let live = live_section(settings);
        let (api_key, _base) = resolve_credentials(&live);
        Ok(json!({
            "mode": mode,
            "available": api_key.is_some(),
            "reason": if api_key.is_some() { None } else { Some("no OpenAI API key (set OPENAI_API_KEY or voice.gpt_live.api_key)") },
            "model": live.get("model").and_then(|v| v.as_str()).filter(|s| !s.trim().is_empty()).unwrap_or(DEFAULT_LIVE_MODEL),
            "voice": live.get("voice").and_then(|v| v.as_str()).filter(|s| !s.trim().is_empty()).unwrap_or(DEFAULT_LIVE_VOICE),
        }))
    }
}

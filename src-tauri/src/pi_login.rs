//! OAuth 登录 / 端点测试 / vault 外部管理器探测（2026-10-24）。
//!
//! pi 把完整 OAuth 流程公开在 `pi::auth`（start → 本机回调服务器 →
//! complete → AuthCredential），本模块把它接成设置页可用的 IPC：
//!
//! - `pi_oauth_providers`：pi 支持的 OAuth 提供方清单（四家 localhost
//!   回调流：anthropic / openai-codex / google / google-antigravity；
//!   kimi/copilot/gitlab 是设备码·浏览器流，接线面不同——不列假入口）。
//! - `pi_oauth_start`：起流程（生成授权 URL + PKCE verifier + 本机回调
//!   监听线程），打开系统浏览器；回调线程收到 code 后跑 complete、把
//!   AuthCredential 存进 pi 的 auth.json。状态存全局表供 `pi_oauth_status`
//!   轮询（pending → ok / err）。
//! - `pi_oauth_status`：读流程状态。
//! - `pi_endpoint_validate`：自定义端点测试（GET {base}/models +
//!   Bearer；pi 的 http client，与提供方请求同一栈）。
//! - `pi_vault_sources`：外部密码管理器 CLI 探测（bw / op 在不在
//!   PATH，真实 spawn --version；hermes vault.sources 的本地等价面——
//!   解锁/列条目需要会话令牌管理，是下一轮，不伪造）。
//!
//! 纪律：流程失败可见（status err / Err），不静默；verifier 只存内存
//! （进程重启 = 流程作废，重新点按钮即可）。

use std::collections::HashMap;
use std::sync::Mutex;

use pi::auth::{self, AuthCredential, AuthStorage, OAuthStartInfo};

use crate::pi_session::on_big_stack;

/// OAuth 提供方清单（id → 展示名）。四家都是 localhost 回调流。
const OAUTH_PROVIDERS: &[(&str, &str)] = &[
    ("anthropic", "Anthropic"),
    ("openai-codex", "OpenAI Codex"),
    ("google", "Google Gemini CLI"),
    ("google-antigravity", "Google Antigravity"),
];

/// 流程状态表（provider → state/message）。state: pending|ok|err。
static OAUTH_STATE: Mutex<Option<HashMap<String, (String, String)>>> = Mutex::new(None);

fn set_state(provider: &str, state: &str, message: String) {
    let mut guard = OAUTH_STATE.lock().expect("oauth state poisoned");
    guard
        .get_or_insert_with(HashMap::new)
        .insert(provider.to_string(), (state.to_string(), message));
}

/// 提供方支持的 OAuth 清单（设置页渲染登录按钮的真相源）。
#[tauri::command]
pub fn pi_oauth_providers() -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "providers": OAUTH_PROVIDERS
            .iter()
            .map(|(id, label)| serde_json::json!({ "id": id, "label": label }))
            .collect::<Vec<_>>(),
    }))
}

fn start_flow(provider: &str) -> Result<OAuthStartInfo, String> {
    match provider {
        "anthropic" => auth::start_anthropic_oauth(),
        "openai-codex" => auth::start_openai_codex_oauth(),
        "google" => auth::start_google_gemini_cli_oauth(),
        "google-antigravity" => auth::start_google_antigravity_oauth(),
        other => return Err(format!("未知 OAuth 提供方: {other}")),
    }
    .map_err(|e| format!("OAuth 流程启动失败: {e}"))
}

async fn complete_flow(provider: &str, code: &str, verifier: &str) -> Result<AuthCredential, String> {
    match provider {
        "anthropic" => auth::complete_anthropic_oauth(code, verifier).await,
        "openai-codex" => auth::complete_openai_codex_oauth(code, verifier).await,
        "google" => auth::complete_google_gemini_cli_oauth(code, verifier).await,
        "google-antigravity" => auth::complete_google_antigravity_oauth(code, verifier).await,
        other => return Err(format!("未知 OAuth 提供方: {other}")),
    }
    .map_err(|e| format!("OAuth 令牌交换失败: {e}"))
}

/// 存凭据进 pi 的 auth.json（AuthStorage 语义：per-provider typed 条目，
/// 其余条目原样保留）。
fn save_credential(provider: &str, cred: AuthCredential) -> Result<(), String> {
    let mut storage = AuthStorage::load(pi::config::Config::auth_path())
        .map_err(|e| format!("auth.json 读取失败: {e}"))?;
    storage.set(provider, cred);
    storage.save().map_err(|e| format!("auth.json 写入失败: {e}"))
}

/// 后台回调线程里跑 pi 的 async complete（asupersync current_thread 运行时，
/// 与 pi_session 的 PiRuntime 同一构造方式——pi 的 future 不能进 tokio）。
/// 成功即存凭据（一步完成，避免凭据只存活在线程局部）。
fn block_on_complete_and_save(provider: String, code: String, verifier: String) -> Result<(), String> {
    let reactor = asupersync::runtime::reactor::create_reactor().map_err(|e| e.to_string())?;
    let runtime = asupersync::runtime::RuntimeBuilder::current_thread()
        .with_reactor(reactor)
        .build()
        .map_err(|e| e.to_string())?;
    let provider = provider.as_str();
    let code = code.as_str();
    let verifier = verifier.as_str();
    runtime.block_on(async move {
        let cred = complete_flow(provider, code, verifier).await?;
        save_credential(provider, cred)
    })
}

/// 启动 OAuth 登录：开本机回调监听 + 打开浏览器。UI 轮询
/// `pi_oauth_status`；成功后 auth.json 出现该提供方条目（凭据页刷新可见）。
#[tauri::command(async)]
pub fn pi_oauth_start(provider: String) -> Result<serde_json::Value, String> {
    on_big_stack(move || {
        let info = start_flow(&provider)?;
        let redirect = info
            .redirect_uri
            .clone()
            .unwrap_or_default();
        let verifier = info.verifier.clone();
        let url = info.url.clone();

        set_state(&provider, "pending", "等待浏览器回调…".into());

        // 回调服务器：pi 自带的 localhost 监听（单连接、取 code）。
        // 已有预绑服务器的提供方（copilot/gitlab 一类）不在四家清单里，
        // 这里统一走 start_oauth_callback_server。
        let server = auth::start_oauth_callback_server(&redirect)
            .map_err(|e| format!("本机回调监听启动失败（{redirect}）: {e}"))?;

        let prov = provider.clone();
        std::thread::spawn(move || {
            // 等 5 分钟；超时/断连 → err 可见。
            let Ok(callback) = server.rx.recv_timeout(std::time::Duration::from_secs(300)) else {
                set_state(&prov, "err", "回调超时（5 分钟）——重新点击登录重试".into());
                return;
            };
            // callback = "/path?code=...&state=..."；complete 的 code_input
            // 接受完整回调 URL 或裸 code（pi parse_oauth_code_input）。
            let full = format!("http://localhost{}", callback);
            match block_on_complete_and_save(prov.clone(), full, verifier.clone()) {
                Ok(()) => set_state(&prov, "ok", "登录成功——凭据已写入 auth.json".into()),
                Err(e) => set_state(&prov, "err", e),
            }
        });

        // 打开系统浏览器（与 terminal_open_url 同一 open crate）。
        if let Err(e) = open::that(&url) {
            // 浏览器打开失败不是流程失败（URL 已返回，用户可手贴）——可见即可。
            eprintln!("[oauth] 系统浏览器打开失败（{e}）——URL 已返回给设置页");
        }

        Ok(serde_json::json!({
            "url": url,
            "redirectUri": redirect,
            "instructions": info.instructions,
        }))
    })?
}

/// 查询 OAuth 流程状态（UI 轮询）。无流程 = idle。
#[tauri::command]
pub fn pi_oauth_status(provider: String) -> Result<serde_json::Value, String> {
    let guard = OAUTH_STATE.lock().expect("oauth state poisoned");
    let Some(map) = guard.as_ref() else {
        return Ok(serde_json::json!({ "state": "idle", "message": "" }));
    };
    let Some((state, message)) = map.get(&provider) else {
        return Ok(serde_json::json!({ "state": "idle", "message": "" }));
    };
    Ok(serde_json::json!({ "state": state, "message": message }))
}

/// 自定义端点测试（hermes validate 的本地等价面）：GET {base}/models +
/// Bearer。200 且能解出模型列表 = ok；非 200 / 网络失败如实返回。
#[tauri::command(async)]
pub fn pi_endpoint_validate(
    base_url: String,
    api_key: Option<String>,
) -> Result<serde_json::Value, String> {
    on_big_stack(move || {
        let base = base_url.trim_end_matches('/');
        let url = format!("{base}/models");
        let reactor = asupersync::runtime::reactor::create_reactor().map_err(|e| e.to_string())?;
        let runtime = asupersync::runtime::RuntimeBuilder::current_thread()
            .with_reactor(reactor)
            .build()
            .map_err(|e| e.to_string())?;
        let key = api_key.clone();
        runtime
            .block_on(async move {
                let client = pi::http::client::Client::new();
                let mut req = client.get(&url);
                if let Some(k) = key.as_deref().filter(|k| !k.trim().is_empty()) {
                    req = req.header("Authorization", format!("Bearer {}", k.trim()));
                }
                let resp = req
                    .send()
                    .await
                    .map_err(|e| format!("请求失败: {e}"))?;
                let status = resp.status();
                let body = resp.text().await.map_err(|e| format!("响应读取失败: {e}"))?;
                if status != 200 {
                    return Ok(serde_json::json!({
                        "ok": false,
                        "status": status,
                        "models": [],
                        "message": format!("HTTP {status}——端点可达但拒绝请求（{base}）"),
                    }));
                }
                // OpenAI 兼容：{"data":[{"id":...}]}；也兼容 {"models":[...]}
                let parsed: serde_json::Value = serde_json::from_str(&body)
                    .map_err(|e| format!("响应不是 JSON（可能是网页/网关页）: {e}"))?;
                let ids: Vec<String> = parsed
                    .get("data")
                    .and_then(|d| d.as_array())
                    .or_else(|| parsed.get("models").and_then(|m| m.as_array()))
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|m| {
                                m.get("id")
                                    .and_then(|i| i.as_str())
                                    .map(String::from)
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                let count = ids.len();
                Ok(serde_json::json!({
                    "ok": true,
                    "status": status,
                    "models": ids,
                    "message": format!("端点可连接，发现 {count} 个模型"),
                }))
            })
            .map_err(|e: String| e)
    })?
}

/// 外部密码管理器 CLI 探测（hermes vault.sources 的本地等价面）：
/// spawn `<cli> --version` 探测安装。解锁/列条目需要会话令牌管理
/// （下一轮）——rows 如实报 installed，不伪造 enabled/unlocked。
#[tauri::command(async)]
pub fn pi_vault_sources() -> Result<serde_json::Value, String> {
    on_big_stack(move || {
        let probe = |cmd: &str| -> bool {
            std::process::Command::new(cmd)
                .arg("--version")
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .is_ok_and(|s| s.success())
        };
        let bitwarden = probe("bw");
        let onepassword = probe("op");
        let rows = vec![
            serde_json::json!({
                "name": "local",
                "displayName": "本机（OS 凭据管理器）",
                "installed": true,
                "enabled": true,
                "needsUnlock": false,
                "unlocked": true,
            }),
            serde_json::json!({
                "name": "bitwarden",
                "displayName": "Bitwarden",
                "installed": bitwarden,
                "enabled": false,
                "needsUnlock": true,
                "unlocked": false,
            }),
            serde_json::json!({
                "name": "onepassword",
                "displayName": "1Password",
                "installed": onepassword,
                "enabled": false,
                "needsUnlock": true,
                "unlocked": false,
            }),
        ];
        Ok(serde_json::json!({ "sources": rows }))
    })?
}

//! OAuth 登录 / 端点测试 / 密码管理器 CLI 探测。
//!
//! - **OAuth 启动流**无宿主可用嵌入 API（如实 Err）。实证（2026-11-14）：
//!   rpi v0.24 的 OAuth 由 **provider 扩展包**实现，宿主侧桥在
//!   `rpi-extensions/src/oauth.rs`（`request_oauth(snapshot, provider,
//!   action, input)`，action = begin/exchange/refresh/revoke），输入是
//!   **已加载扩展的 RegistrySnapshot**；`rpi-cli/src/auth.rs` 只是该桥的
//!   CLI 包装（`rpi auth login` 交互式 TUI：`run_oauth_login`）。mirach
//!   宿主不加载扩展注册表（Cargo 依赖也没有 rpi-extensions），因此没有
//!   可嵌入的 start/complete/poll。凭据可直接配 env key
//!   （ANTHROPIC_API_KEY 等）或 models.json apiKey——设置页凭据写入
//!   （pi_keys.rs）已覆盖。
//! - **端点校验**（`pi_endpoint_validate`）= 纯 HTTP 探测，与引擎无关：
//!   GET `{base_url}/models`（OpenAI 兼容形状），可选 Bearer。
//!   语义：**HTTP 层面的成败是测试结论**（ok/status/message 如实返回，
//!   不抛 Err）；只有输入本身非法（空 URL / 非 http(s)）才 Err——
//!   调用方传错参数是错误，端点不可达是测试结果（规矩 12 的分界）。
//! - **vault 来源**（`pi_vault_sources`）= 纯 `spawn <cli> --version`
//!   安装探测，与引擎无关（旧 pi 实现即如此，原样移植）。

use std::time::Duration;

use serde_json::{json, Value};

use crate::pi_session::on_big_stack;

/// OAuth 提供方列表（无宿主可用来源——空清单，前端无入口可点）。
///
/// 为什么空：rpi 的 OAuth provider 是**扩展包**注册的（`rpi-extensions` 的
/// `OAuthProviderInfo` / `oauth::list(snapshot)`），本宿主不加载扩展注册表，
/// 无法枚举。**不伪造四家旧清单**（旧 pi 内置 anthropic / openai-codex /
/// google 等，rpi 已把实现移到 provider 扩展）。
///
/// **wire 形状必须是 `{ providers: [...] }`**：前端 providers-settings.tsx
/// 的账号区读 `r.providers` 再 `.map`；此前降级版错发裸数组 `[]`，导致
/// `r.providers === undefined` → 设置窗口整体白屏（2026-11-14 实锤）。
#[tauri::command(async)]
pub fn pi_oauth_providers() -> Result<Value, String> {
    Ok(json!({ "providers": [] }))
}

/// 启动 OAuth 登录。宿主无嵌入 API：如实 Err + 替代路径。
///
/// 实证：rpi OAuth 的 begin/exchange 由 provider 扩展包执行
/// （`rpi-extensions/src/oauth.rs::request_oauth`，需要已加载扩展的
/// `RegistrySnapshot`）；`rpi-cli/src/auth.rs::run_oauth_login` 是它的
/// 交互式 CLI 包装。mirach 宿主未加载扩展注册表，无从调用。
#[tauri::command(async)]
pub fn pi_oauth_start(_provider: String) -> Result<Value, String> {
    Err(
        "rpi OAuth 仅交互式 TUI（rpi auth）或由 provider 扩展包提供，宿主未加载扩展注册表、\
         无嵌入 OAuth API；凭据可走 env key（如 ANTHROPIC_API_KEY）或 models.json apiKey"
            .into(),
    )
}

/// 查询 OAuth 流程状态。没有流程可查（同上：宿主无嵌入 OAuth）。
#[tauri::command(async)]
pub fn pi_oauth_status(_provider: String) -> Result<Value, String> {
    Err(
        "rpi OAuth 状态不可查：宿主未加载扩展注册表，没有可轮询的 OAuth 流程；\
         交互式登录请用 rpi auth（TUI），凭据可走 env key 或 models.json apiKey"
            .into(),
    )
}

/// 端点探测：GET `{base_url}/models`（去尾斜杠），可选 Bearer 密钥。
/// 返回 `{ ok, status, models, message }`——与前端「测试」按钮的消费形状
/// 一致（providers-settings.tsx handleTest：ok && models.length>0 时追加
/// 模型预览）。message 只描述请求本身，模型列表由前端拼。
#[tauri::command(async)]
pub fn pi_endpoint_validate(base_url: String, api_key: Option<String>) -> Result<Value, String> {
    on_big_stack(move || probe_models(&base_url, api_key.as_deref()))?
}

/// 模型发现（保存时「发现模型」用）：GET `{base_url}/models`。
///
/// 与 [`pi_endpoint_validate`] 的区别：`api_key` 留空时**从 models.json 的
/// `provider.apiKey` 借用已存密钥**——编辑已有端点时表单「留空保留当前
/// 密钥」（密钥只写不读），但发现探测仍需鉴权；密钥读不到就按无凭据探测
/// （端点公开则成功、需鉴权则 401 如实报，不假装）。
#[tauri::command(async)]
pub fn pi_discover_models(
    provider_id: String,
    base_url: String,
    api_key: Option<String>,
) -> Result<Value, String> {
    on_big_stack(move || {
        let key = match api_key.as_deref().map(str::trim).filter(|k| !k.is_empty()) {
            Some(k) => Some(k.to_string()),
            None => stored_api_key(&provider_id)?,
        };
        probe_models(&base_url, key.as_deref())
    })?
}

/// 从 models.json 读 provider 的已存 apiKey（编辑态发现探测的凭据回退）。
/// 文件不存在 = 没有已存密钥（Ok(None)，正常态）；坏文件/坏 JSON = Err。
fn stored_api_key(provider_id: &str) -> Result<Option<String>, String> {
    let path = crate::pi_paths::models_path()?;
    let raw = match std::fs::read_to_string(&path) {
        Ok(r) => r,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => {
            return Err(format!("models.json 读取失败 {}: {e}", path.display()))
        }
    };
    let doc: Value =
        serde_json::from_str(&raw).map_err(|e| format!("models.json 解析失败: {e}"))?;
    // JSON Pointer 转义：~ → ~0，/ → ~1（provider id 可能含 '/' 的极端形态）
    let ptr = format!(
        "/providers/{}/apiKey",
        provider_id.replace('~', "~0").replace('/', "~1")
    );
    Ok(doc.pointer(&ptr).and_then(Value::as_str).map(str::to_string))
}

/// GET `{base}/models` 探测（两个命令共用）。HTTP 成败 = 探测结论。
fn probe_models(base_url: &str, api_key: Option<&str>) -> Result<Value, String> {
    let base = base_url.trim().trim_end_matches('/');
    if base.is_empty() {
        return Err("端点 URL 为空".to_string());
    }
    let url = format!("{base}/models");
    let parsed = reqwest::Url::parse(&url).map_err(|e| format!("端点 URL 非法: {e}"))?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err(format!("端点协议必须是 http/https: {}", parsed.scheme()));
    }
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| format!("HTTP 客户端构建失败: {e}"))?;
    let mut request = client.get(parsed);
    if let Some(key) = api_key.map(str::trim).filter(|k| !k.is_empty()) {
        request = request.bearer_auth(key);
    }
    match request.send() {
        Ok(resp) => {
            let status = resp.status();
            let body = resp.text().unwrap_or_default();
            if status.is_success() {
                let models = parse_model_ids(&body);
                Ok(json!({
                    "ok": true,
                    "status": status.as_u16(),
                    "models": models,
                    "message": format!("GET {url} → {}", status),
                }))
            } else {
                Ok(json!({
                    "ok": false,
                    "status": status.as_u16(),
                    "models": [],
                    "message": format!("GET {url} → {}: {}", status, truncate_body(&body)),
                }))
            }
        }
        Err(e) => Ok(json!({
            "ok": false,
            "status": 0,
            "models": [],
            "message": format!("请求失败: {e}"),
        })),
    }
}

/// 从 `/models` 响应体提取模型 id（兼容三种形状）：
/// OpenAI `{"data":[{"id":"…"}]}`、部分实现 `{"models":[{"id":"…"}]}`、
/// 裸数组 `{"models":["…"]}`。解析失败 = 空列表（消息里仍有 HTTP 状态，
/// 不算错误）。
fn parse_model_ids(body: &str) -> Vec<String> {
    let Ok(value) = serde_json::from_str::<Value>(body) else {
        return Vec::new();
    };
    let list = value
        .get("data")
        .and_then(Value::as_array)
        .or_else(|| value.get("models").and_then(Value::as_array));
    let Some(list) = list else {
        return Vec::new();
    };
    list.iter()
        .filter_map(|item| {
            item.as_str()
                .map(str::to_string)
                .or_else(|| item.get("id").and_then(Value::as_str).map(str::to_string))
        })
        .collect()
}

/// 错误响应体截断（错误消息要可见但不能刷屏）。
fn truncate_body(body: &str) -> String {
    let trimmed = body.trim();
    if trimmed.chars().count() <= 200 {
        trimmed.to_string()
    } else {
        let cut: String = trimmed.chars().take(200).collect();
        format!("{cut}…")
    }
}

/// 外部密码管理器 CLI 探测（旧 pi `pi_vault_sources` 的本地等价面，原样移植）。
///
/// `installed` = CLI 真的在 PATH 上且 `--version` 成功退出（**spawn 真探测**，
/// 不是读配置猜）。解锁 / 列条目需要会话令牌管理，是下一轮的事，本面不伪造
/// （`enabled` / `unlocked` 只有 local 源为 true）——与前端
/// settings-overlay.tsx 的 `VaultSourceRow` 消费形状一致。
///
/// spawn 失败 = 该 CLI 未安装（探测结论，不是错误）；只有探测线程
/// spawn/panic 才由 [`on_big_stack`] 转成 Err。
#[tauri::command(async)]
pub fn pi_vault_sources() -> Result<Value, String> {
    Ok(on_big_stack(probe_vault_sources)?)
}

fn probe_vault_sources() -> Value {
    let probe = |cmd: &str| -> bool {
        std::process::Command::new(cmd)
            .arg("--version")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
    };
    let bitwarden = probe("bw");
    let onepassword = probe("op");
    json!({
        "sources": [
            {
                "name": "local",
                "displayName": "本机（OS 凭据管理器）",
                "installed": true,
                "enabled": true,
                "needsUnlock": false,
                "unlocked": true,
            },
            {
                "name": "bitwarden",
                "displayName": "Bitwarden",
                "installed": bitwarden,
                "enabled": false,
                "needsUnlock": true,
                "unlocked": false,
            },
            {
                "name": "onepassword",
                "displayName": "1Password",
                "installed": onepassword,
                "enabled": false,
                "needsUnlock": true,
                "unlocked": false,
            },
        ]
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_model_ids_handles_openai_data_and_models_shapes() {
        assert_eq!(
            parse_model_ids(r#"{"data":[{"id":"gpt-4o"},{"id":"o3"}]}"#),
            vec!["gpt-4o", "o3"]
        );
        assert_eq!(
            parse_model_ids(r#"{"models":[{"id":"a"},{"id":"b"}]}"#),
            vec!["a", "b"]
        );
        assert_eq!(parse_model_ids(r#"{"models":["x","y"]}"#), vec!["x", "y"]);
        assert_eq!(parse_model_ids("not json"), Vec::<String>::new());
        assert_eq!(parse_model_ids(r#"{"data":[]}"#), Vec::<String>::new());
    }

    #[test]
    fn truncate_body_caps_at_200_chars() {
        assert_eq!(truncate_body("  short  "), "short");
        let long = "x".repeat(250);
        let cut = truncate_body(&long);
        assert!(cut.ends_with('…'));
        assert_eq!(cut.chars().count(), 201);
    }
}

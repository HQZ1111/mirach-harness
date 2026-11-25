//! `image.generate` 后端（2026-11-18）：hermes 图像生成 RPC 的宿主实现。
//!
//! 宿主没有独立的图像模型目录，走**OpenAI 兼容**的 images 端点：
//! - provider = settings.json 的 `image.provider`，否则 `default_provider`，
//!   否则 models.json 里第一个能解析出凭据的 provider；
//! - baseUrl / apiKey 来自 models.json 的 provider 条目（apiKey 支持字面量 /
//!   `env:VAR` / 裸大写环境变量名），auth.json 的 `{type:"api_key", key}`
//!   与 provider 环境变量按 pi 的 resolve 链兜底；
//! - probe = GET `{base}/models`，从模型目录里挑图像型模型
//!   （image / dall-e / imagen / flux / stable-diffusion / sdxl / seedream）；
//!   找不到 → `available:false`（插件隐藏生成入口，不造假）；
//! - 生成 = POST `{base}/images/generations`（b64_json；不支持时退 url）。
//!
//! 规矩 12：缺配置 / HTTP 错误 / 空响应全部走契约的 `error` 字段或 Err，
//! 不静默降级。`settings.image.model` 可显式指定模型（覆盖 probe 结果）。

use std::time::Duration;

use serde_json::{json, Value};

use crate::pi_session::on_big_stack;

const IMAGE_MODEL_HINTS: &[&str] = &[
    "image",
    "dall-e",
    "dalle",
    "imagen",
    "flux",
    "stable-diffusion",
    "sdxl",
    "seedream",
];

fn settings_doc(home: &rpi_cli::config::AgentHome) -> Result<Option<Value>, String> {
    let path = home
        .settings_path()
        .map_err(|e| format!("settings.json 路径解析失败: {e}"))?;
    crate::pi_settings::read_json_document(&path)
}

fn models_doc(home: &rpi_cli::config::AgentHome) -> Result<Option<Value>, String> {
    let path = home
        .models_path()
        .map_err(|e| format!("models.json 路径解析失败: {e}"))?;
    crate::pi_settings::read_json_document(&path)
}

fn auth_doc(home: &rpi_cli::config::AgentHome) -> Result<Option<Value>, String> {
    let path = home
        .auth_path()
        .map_err(|e| format!("auth.json 路径解析失败: {e}"))?;
    crate::pi_settings::read_json_document(&path)
}

fn provider_env_key(provider: &str) -> Option<&'static str> {
    match provider {
        "openai" | "openai-completions" | "openai-responses" => Some("OPENAI_API_KEY"),
        "openrouter" => Some("OPENROUTER_API_KEY"),
        "deepseek" => Some("DEEPSEEK_API_KEY"),
        "google" | "gemini" => Some("GEMINI_API_KEY"),
        "xai" => Some("XAI_API_KEY"),
        _ => None,
    }
}

/// models.json apiKey 引用求值（pi resolve 链的宿主子集：字面量 / env:VAR /
/// 裸大写环境变量名；命令与文件引用不支持 → 明确报错，不猜）。
fn resolve_key_reference(raw: &str) -> Result<Option<String>, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Ok(None);
    }
    if let Some(var) = raw.strip_prefix("env:") {
        return std::env::var(var)
            .map(Some)
            .map_err(|_| format!("图片生成：环境变量 {var} 未设置"));
    }
    if raw.starts_with('!') || raw.starts_with("file:") {
        return Err("图片生成：命令/文件型 apiKey 引用暂不支持".into());
    }
    let looks_like_env = raw
        .chars()
        .next()
        .is_some_and(|c| c.is_ascii_uppercase())
        && raw.contains('_')
        && raw
            .chars()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_');
    if looks_like_env {
        return std::env::var(raw)
            .map(Some)
            .map_err(|_| format!("图片生成：环境变量 {raw} 未设置"));
    }
    Ok(Some(raw.to_string()))
}

struct ImageProvider {
    provider: String,
    base_url: String,
    api_key: Option<String>,
}

fn provider_from_models(
    models: &Value,
    provider: &str,
) -> Result<Option<(String, Option<String>)>, String> {
    let Some(cfg) = models
        .get("providers")
        .and_then(|p| p.get(provider))
        .and_then(Value::as_object)
    else {
        return Ok(None);
    };
    let base_url = cfg
        .get("baseUrl")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|u| !u.is_empty())
        .map(str::to_string);
    let Some(base_url) = base_url else {
        return Ok(None);
    };
    let key = match cfg.get("apiKey").and_then(Value::as_str) {
        Some(raw) => resolve_key_reference(raw)?,
        None => None,
    };
    Ok(Some((base_url, key)))
}

fn provider_key_from_auth(auth: &Value, provider: &str) -> Option<String> {
    let cred = auth.get(provider)?;
    if cred.get("type").and_then(Value::as_str) != Some("api_key") {
        return None;
    }
    cred.get("key")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|k| !k.is_empty())
        .map(str::to_string)
}

fn resolve_provider(home: &rpi_cli::config::AgentHome) -> Result<ImageProvider, String> {
    let settings = settings_doc(home)?.unwrap_or_else(|| json!({}));
    let models = models_doc(home)?.unwrap_or_else(|| json!({ "providers": {} }));
    let auth = auth_doc(home)?.unwrap_or_else(|| json!({}));

    let explicit = settings
        .get("image")
        .and_then(|i| i.get("provider"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|p| !p.is_empty());
    let default_provider = settings
        .get("default_provider")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|p| !p.is_empty());

    let mut candidates: Vec<String> = Vec::new();
    if let Some(p) = explicit {
        candidates.push(p.to_string());
    }
    if let Some(p) = default_provider {
        candidates.push(p.to_string());
    }
    if let Some(providers) = models.get("providers").and_then(Value::as_object) {
        for name in providers.keys() {
            candidates.push(name.clone());
        }
    }
    candidates.dedup();

    for provider in candidates {
        let Some((base_url, models_key)) = provider_from_models(&models, &provider)? else {
            continue;
        };
        let api_key = models_key
            .or_else(|| provider_key_from_auth(&auth, &provider))
            .or_else(|| {
                provider_env_key(&provider)
                    .and_then(|name| std::env::var(name).ok())
                    .map(|v| v.trim().to_string())
                    .filter(|v| !v.is_empty())
            });
        // 显式选中的 provider 即使缺 key 也返回（让 probe/生成如实报错）。
        if explicit == Some(provider.as_str()) || api_key.is_some() {
            return Ok(ImageProvider {
                provider,
                base_url,
                api_key,
            });
        }
    }
    Err("图片生成：没有可用的 provider（models.json 需有 baseUrl + 凭据）".into())
}

/// `{base}/images/generations` / `{base}/models`：base 已带 /v1 时直接接，
/// 否则补 /v1。
fn api_url(base_url: &str, endpoint: &str) -> String {
    let base = base_url.trim().trim_end_matches('/');
    if base.ends_with("/v1") {
        format!("{base}/{endpoint}")
    } else {
        format!("{base}/v1/{endpoint}")
    }
}

fn parse_model_ids(body: &str) -> Vec<String> {
    let Ok(value) = serde_json::from_str::<Value>(body) else {
        return Vec::new();
    };
    let rows = value
        .get("data")
        .and_then(Value::as_array)
        .or_else(|| value.get("models").and_then(Value::as_array))
        .or_else(|| value.as_array());
    let Some(rows) = rows else {
        return Vec::new();
    };
    rows.iter()
        .filter_map(|row| {
            row.get("id")
                .and_then(Value::as_str)
                .or_else(|| row.as_str())
                .map(str::to_string)
        })
        .collect()
}

fn is_image_model(id: &str) -> bool {
    let lower = id.to_lowercase();
    if lower.contains("embed") {
        return false;
    }
    IMAGE_MODEL_HINTS.iter().any(|hint| lower.contains(hint))
}

fn truncate_body(body: &str) -> String {
    let trimmed = body.trim();
    if trimmed.chars().count() <= 300 {
        trimmed.to_string()
    } else {
        let head: String = trimmed.chars().take(300).collect();
        format!("{head}…")
    }
}

fn client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(85))
        .build()
        .map_err(|e| format!("图片生成：HTTP 客户端构建失败: {e}"))
}

/// GET `{base}/models`，挑第一个图像型模型 id。
fn probe_image_model(provider: &ImageProvider) -> Result<Option<String>, String> {
    let url = api_url(&provider.base_url, "models");
    let parsed = reqwest::Url::parse(&url).map_err(|e| format!("图片生成：端点 URL 非法: {e}"))?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err(format!("图片生成：端点协议必须是 http/https: {}", parsed.scheme()));
    }
    let mut request = client()?.get(parsed);
    if let Some(key) = provider.api_key.as_deref() {
        request = request.bearer_auth(key);
    }
    let response = request
        .send()
        .map_err(|e| format!("图片生成：GET {url} 失败: {e}"))?;
    let status = response.status();
    let body = response.text().unwrap_or_default();
    if !status.is_success() {
        return Err(format!(
            "图片生成：GET {url} → {status}: {}",
            truncate_body(&body)
        ));
    }
    Ok(parse_model_ids(&body)
        .into_iter()
        .find(|id| is_image_model(id)))
}

fn image_size(aspect_ratio: Option<&str>) -> &'static str {
    match aspect_ratio.unwrap_or("square") {
        "portrait" | "tall" => "1024x1536",
        "landscape" | "wide" => "1536x1024",
        _ => "1024x1024",
    }
}

fn extract_image(body: &Value) -> Option<(Option<String>, Option<String>)> {
    let entry = body
        .get("data")
        .and_then(Value::as_array)
        .and_then(|rows| rows.first())?;
    let b64 = entry.get("b64_json").and_then(Value::as_str);
    let url = entry.get("url").and_then(Value::as_str);
    if b64.is_none() && url.is_none() {
        return None;
    }
    let data_url = b64.map(|data| format!("data:image/png;base64,{data}"));
    Some((data_url, url.map(str::to_string)))
}

fn generate(
    home: &rpi_cli::config::AgentHome,
    provider: &ImageProvider,
    prompt: &str,
    aspect_ratio: Option<&str>,
) -> Result<Value, String> {
    let model = match configured_model(home)? {
        Some(model) => model,
        None => probe_image_model(provider)?.ok_or_else(|| {
            format!(
                "图片生成：provider {} 的模型目录里没有图像模型（可在 settings.json 设 image.model）",
                provider.provider
            )
        })?,
    };
    let url = api_url(&provider.base_url, "images/generations");
    let payload = json!({
        "model": model,
        "prompt": prompt,
        "n": 1,
        "size": image_size(aspect_ratio),
        "response_format": "b64_json",
    });
    let mut request = client()?.post(&url).json(&payload);
    if let Some(key) = provider.api_key.as_deref() {
        request = request.bearer_auth(key);
    }
    let response = request
        .send()
        .map_err(|e| format!("图片生成：POST {url} 失败: {e}"))?;
    let status = response.status();
    let body = response.text().unwrap_or_default();
    let parsed: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
    if !status.is_success() {
        return Ok(json!({
            "available": true,
            "success": false,
            "error": format!("POST {url} → {status}: {}", truncate_body(&body)),
        }));
    }
    match extract_image(&parsed) {
        Some((Some(data_url), _)) => Ok(json!({
            "available": true,
            "success": true,
            "image_data": data_url,
        })),
        Some((None, Some(image_url))) => Ok(json!({
            "available": true,
            "success": true,
            "image": image_url,
        })),
        _ => Ok(json!({
            "available": true,
            "success": false,
            "error": format!("图片生成：响应里没有图片数据: {}", truncate_body(&body)),
        })),
    }
}

/// IPC：probe=true 只报可用性；否则按 prompt 真生成。
/// 形状 = hermes `ImageGenerateResult`（available/success/image/image_data/error）。
/// 配置面（settings/models/auth）按**活动环境 home** 读取（配置绑定
/// 2026-11-25：切环境后图像生成也用那个环境的凭据）。
#[tauri::command(rename_all = "camelCase", async)]
pub fn pi_image_generate(
    state: tauri::State<'_, std::sync::Arc<crate::agui::AguiState>>,
    prompt: Option<String>,
    aspect_ratio: Option<String>,
    probe: Option<bool>,
) -> Result<Value, String> {
    let home = crate::pi_profiles::active_home(&state.engine)?;
    on_big_stack(move || {
        if probe == Some(true) {
            let provider = match resolve_provider(&home) {
                Ok(provider) => provider,
                Err(error) => return Ok(json!({ "available": false, "error": error })),
            };
            let configured = match configured_model(&home) {
                Ok(configured) => configured,
                Err(error) => return Ok(json!({ "available": false, "error": error })),
            };
            if let Some(model) = configured {
                return Ok(json!({
                    "available": true,
                    "model": model,
                    "provider": provider.provider,
                }));
            }
            return match probe_image_model(&provider) {
                Ok(Some(model)) => Ok(json!({
                    "available": true,
                    "model": model,
                    "provider": provider.provider,
                })),
                Ok(None) => Ok(json!({
                    "available": false,
                    "provider": provider.provider,
                    "error": "provider 的模型目录里没有图像模型",
                })),
                Err(error) => Ok(json!({
                    "available": false,
                    "provider": provider.provider,
                    "error": error,
                })),
            };
        }
        let prompt = prompt
            .as_deref()
            .map(str::trim)
            .filter(|p| !p.is_empty())
            .ok_or_else(|| "image.generate: prompt 不能为空".to_string())?;
        let provider = resolve_provider(&home)?;
        generate(&home, &provider, prompt, aspect_ratio.as_deref())
    })?
}

/// 设置覆盖：`settings.image.model`（可选）——显式指定时跳过模型目录探测。
fn configured_model(home: &rpi_cli::config::AgentHome) -> Result<Option<String>, String> {
    Ok(settings_doc(home)?
        .and_then(|s| {
            s.get("image")
                .and_then(|i| i.get("model"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|m| !m.is_empty())
                .map(str::to_string)
        }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn api_url_appends_v1_only_when_missing() {
        assert_eq!(
            api_url("https://gw.example.com/v1", "images/generations"),
            "https://gw.example.com/v1/images/generations"
        );
        assert_eq!(
            api_url("https://gw.example.com/v1/", "models"),
            "https://gw.example.com/v1/models"
        );
        assert_eq!(
            api_url("https://gw.example.com", "models"),
            "https://gw.example.com/v1/models"
        );
    }

    #[test]
    fn image_model_detection() {
        assert!(is_image_model("gpt-image-1"));
        assert!(is_image_model("dall-e-3"));
        assert!(is_image_model("flux.1-schnell"));
        assert!(is_image_model("imagen-3.0"));
        assert!(!is_image_model("gpt-4o"));
        assert!(!is_image_model("text-embedding-3-large"));
    }

    #[test]
    fn model_id_parsing_shapes() {
        assert_eq!(
            parse_model_ids(r#"{"data":[{"id":"gpt-image-1"}]}"#),
            vec!["gpt-image-1".to_string()]
        );
        assert_eq!(
            parse_model_ids(r#"{"models":[{"id":"flux-1"}]}"#),
            vec!["flux-1".to_string()]
        );
        assert_eq!(parse_model_ids("not json"), Vec::<String>::new());
    }

    #[test]
    fn size_mapping() {
        assert_eq!(image_size(None), "1024x1024");
        assert_eq!(image_size(Some("square")), "1024x1024");
        assert_eq!(image_size(Some("portrait")), "1024x1536");
        assert_eq!(image_size(Some("landscape")), "1536x1024");
    }

    #[test]
    fn image_extraction_prefers_b64() {
        let body = json!({"data":[{"b64_json":"AAAA","url":"https://img"}]});
        let (data, url) = extract_image(&body).unwrap();
        assert_eq!(data.as_deref(), Some("data:image/png;base64,AAAA"));
        assert_eq!(url.as_deref(), Some("https://img"));
    }
}

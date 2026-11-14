//! OAuth 登录 / 端点测试（竖链移植降级：rpi-cli auth.rs = 交互式 TUI
//! 流程（非嵌入库 API）；rpi-runtime credentials = 凭据解析非 OAuth 启动。
//! 凭据可直接配 env key（ANTHROPIC_API_KEY 等）或 models.json apiKey——
//! 设置页凭据写入（pi_keys.rs）已覆盖。OAuth 启动流待 rpi-main 暴露
//! 可嵌入 API 后接回；旧实现存档于 git df701a4。

use serde_json::{json, Value};

/// OAuth 提供方列表（降级：rpi 无 OAuth 启动流——空列表，前端无入口可点）。
#[tauri::command(async)]
pub fn pi_oauth_providers() -> Result<Value, String> {
    Ok(json!([]))
}

#[tauri::command(async)]
pub fn pi_oauth_start(_provider: String) -> Result<Value, String> {
    Err("rpi 引擎待接：OAuth 登录（可先在设置页直接配 env key）".into())
}

#[tauri::command(async)]
pub fn pi_oauth_status(_provider: String) -> Result<Value, String> {
    Err("rpi 引擎待接：OAuth 状态".into())
}

#[tauri::command(async)]
pub fn pi_endpoint_validate(_base_url: String, _api_key: Option<String>) -> Result<Value, String> {
    Err("rpi 引擎待接：端点校验".into())
}

#[tauri::command(async)]
pub fn pi_vault_sources() -> Result<Value, String> {
    Err("rpi 引擎待接：vault 来源列表".into())
}

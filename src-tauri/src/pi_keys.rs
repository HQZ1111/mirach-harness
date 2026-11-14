//! pi 凭据写入 + 引擎版本 + OS 通知测试面（设置页「密码与登录 / 版本与更新 /
//! 通知」的数据面；hermes keys-settings / about-settings /
//! notifications-settings 的移植接驳层，2026-10-24）。
//!
//! ## auth.json 写入语义（pi 源码实锤）
//!
//! auth.json = JSON object，provider → typed 凭据。api_key 型的形状是
//! `{"type":"api_key","key":...}`（vendor auth.rs 测试 8501：`{"anthropic":
//! {"type":"api_key","key":"sk-test-abc"}}`）。宿主写入即按该形状落盘；
//! 文档里既有的其它 provider / OAuth 条目原样保留（读为 Value、改单键、
//! 整体写回）。
//!
//! **绝不返回 key 内容**（§7-7 既有纪律）：写入口令只在请求里出现一次，
//! 落盘后读回仅报存在性。
//!
//! 纪律：禁止兜底——损坏的 auth.json 写入时报错不覆盖（坏文件不得被
//! "修复"成空目录）。

use std::path::PathBuf;

use crate::pi_paths;
use crate::pi_session::on_big_stack;
use crate::pi_settings::read_json_document;

/// auth.json 实际路径（pi Config::auth_path = `~/.pi/agent/auth.json`，
/// PI_CONFIG_PATH 覆盖时 pi 读的也是覆盖路径——与 pi_settings 同语义）。
fn auth_path() -> PathBuf {
    pi_paths::auth_path().unwrap_or_else(|_| PathBuf::from("."))
}

/// provider 名合法性：非空、无路径分隔/控制字符（auth.json 的键是
/// provider id，不是路径；同名文件安全）。
fn validate_provider(provider: &str) -> Result<(), String> {
    if provider.trim().is_empty() {
        return Err("provider 名不能为空".into());
    }
    if provider.chars().any(|c| c.is_control() || c == '/' || c == '\\') {
        return Err("provider 名含非法字符".into());
    }
    Ok(())
}

/// 写入/覆盖一个 provider 的 api_key 凭据（hermes keys-settings 的
/// 「set key」等价面）。auth.json 不存在时创建只含该条目的新文档。
#[tauri::command(async)]
pub fn pi_set_provider_key(provider: String, key: String) -> Result<(), String> {
    validate_provider(&provider)?;
    if key.trim().is_empty() {
        return Err("key 不能为空".into());
    }
    on_big_stack(move || {
        let path = auth_path();
        let existing = read_json_document(&path)?;
        let mut doc = match existing {
            Some(v) => v,
            None => serde_json::json!({}),
        };
        let Some(obj) = doc.as_object_mut() else {
            return Err(format!(
                "auth.json 不是 JSON object: {}",
                path.display()
            ));
        };
        obj.insert(
            provider.clone(),
            serde_json::json!({ "type": "api_key", "key": key }),
        );
        crate::pi_settings::write_json_document_public(&path, &doc, |v| {
            if !v.is_object() {
                return Err("auth 文档必须是 JSON object".into());
            }
            Ok(())
        })
    })?
}

/// 删除一个 provider 的全部凭据（hermes disconnect 等价面；OAuth 条目也
/// 一并删除——auth.json 里该 provider 键整体移除）。键不存在 → Ok(false)
/// （真实状态：幂等删除）。
#[tauri::command(async)]
pub fn pi_delete_provider_key(provider: String) -> Result<bool, String> {
    validate_provider(&provider)?;
    on_big_stack(move || {
        let path = auth_path();
        let existing = read_json_document(&path)?;
        let Some(mut doc) = existing else {
            return Ok(false);
        };
        let Some(obj) = doc.as_object_mut() else {
            return Err(format!(
                "auth.json 不是 JSON object: {}",
                path.display()
            ));
        };
        let removed = obj.remove(&provider).is_some();
        if removed {
            crate::pi_settings::write_json_document_public(&path, &doc, |v| {
                if !v.is_object() {
                    return Err("auth 文档必须是 JSON object".into());
                }
                Ok(())
            })?;
        }
        Ok(removed)
    })?
}

/// 引擎（rpi-main，rpi-cli = SDK 门面）版本：编译期从 rpi 工作区根
/// Cargo.toml 取（构建期真值，与实际链接的代码同源——path-dep 直指引擎
/// 工作区；rpi-cli 的 version 是 `version.workspace = true`，真值在工作区
/// 根的 `[workspace.package]`）。hermes about-settings 的「版本英雄区」
/// 移植（2026-10-24）。
#[tauri::command]
pub fn pi_engine_version() -> Result<String, String> {
    const MANIFEST: &str = include_str!("../../../pi-rust-main/Cargo.toml");
    let mut in_package = false;
    for line in MANIFEST.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') {
            in_package = trimmed == "[package]" || trimmed == "[workspace.package]";
            continue;
        }
        if in_package && trimmed.starts_with("version") {
            let value = trimmed
                .split_once('=')
                .map(|(_, v)| v.trim().trim_matches('"'))
                .unwrap_or_default();
            return Ok(value.to_string());
        }
    }
    Err("vendored Cargo.toml 缺 [package] version".into())
}

/// OS 通知测试（hermes notifications-settings 的「测试通知」等价面：
/// sendTestNativeNotification → window.hermesDesktop.notify）。绕过全部
/// 偏好/门控直发一条系统通知——它测的就是 OS 通道本身。返回投递结果
/// （hermes 同语义：false = 桥不存在或 OS 拒绝）。
#[tauri::command(async)]
pub fn pi_notify_test(title: String, body: String) -> Result<bool, String> {
    on_big_stack(move || {
        notify_rust::Notification::new()
            .summary(&title)
            .body(&body)
            .show()
            .map(|_| true)
            .map_err(|e| format!("系统通知发送失败: {e}"))
    })?
}

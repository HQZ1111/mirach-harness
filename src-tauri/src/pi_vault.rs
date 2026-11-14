//! 密码与登录（hermes vault-settings 的移植，2026-10-24）。
//!
//! hermes 的 vault 是它网关后端的加密存储服务（`vault.list/add/remove/
//! sources/lock/unlock` RPC，local + bitwarden + 1password 三源）。pi 没有
//! 该服务——本模块实现 **local 源**的最小全链路：
//!
//! - **元数据**（非敏感）：`app_data_dir/vault-items.json` =
//!   `[{id, kind, label, origin, created_at}]`，明文 JSON（密码管理器的
//!   常规做法：标签/来源可检索，密文才加密）。
//! - **密文**：每条目的 secret JSON 进 OS 凭据管理器（`keyring` crate，
//!   Windows = Credential Manager），service = `mirach.vault`、
//!   account = 条目 id。本机加密，无主密码（与 hermes local 源默认
//!   unlocked 同语义）。
//! - **来源**：只有 local。bitwarden/1password 是对外部管理器的探测集成，
//!   宿主没有该层——来源行如实只报 local。
//!
//! ## 诚实的边界
//!
//! hermes vault 的价值主张是"代理代你登入"（模型让浏览器代填登录表）。
//! pi 0.8.0 没有凭据代填机制——本存储真实可用（增删查 + 加密），
//! `pi_vault_reveal` 是给未来浏览器控制扩展预留的显式取用口，但"代理
//! 代填"那一环需要单独一轮（pi 扩展）。UI 上如实注明。
//!
//! 纪律：secret 永不进日志、永不回显在列表里（列表只有元数据）；
//! 元数据损坏 → Err 可见（不静默重置）。

use std::path::PathBuf;

use tauri::Manager;

use crate::pi_session::on_big_stack;

const SERVICE: &str = "mirach.vault";
const KINDS: &[&str] = &["login", "payment", "address"];

#[derive(serde::Serialize, serde::Deserialize, Clone)]
struct VaultItemMeta {
    id: String,
    kind: String,
    label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    origin: Option<String>,
    created_at: String,
}

fn vault_meta_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir 解析失败: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("vault 目录创建失败: {e}"))?;
    Ok(dir.join("vault-items.json"))
}

fn read_meta(path: &PathBuf) -> Result<Vec<VaultItemMeta>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let content =
        std::fs::read_to_string(path).map_err(|e| format!("密码库元数据读取失败: {e}"))?;
    if content.trim().is_empty() {
        return Ok(Vec::new());
    }
    serde_json::from_str(&content).map_err(|e| format!("密码库元数据解析失败: {e}"))
}

fn write_meta(path: &PathBuf, items: &[VaultItemMeta]) -> Result<(), String> {
    let json =
        serde_json::to_string_pretty(items).map_err(|e| format!("密码库元数据序列化失败: {e}"))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| format!("密码库元数据写入失败: {e}"))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("密码库元数据替换失败: {e}"))
}

fn keyring_entry(id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, id).map_err(|e| format!("凭据管理器不可用: {e}"))
}

/// 列出条目（只有元数据——secret 永不出现在列表里）。
#[tauri::command(async)]
pub fn pi_vault_list(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    on_big_stack(move || {
        let path = vault_meta_path(&app)?;
        let items = read_meta(&path)?;
        Ok(serde_json::json!({ "items": items }))
    })?
}

/// 新增条目。secret = 按 kind 的字段表（login: identifier/password/…；
/// payment: card_number/…；address: line1/…），整体加密进 OS 凭据管理器。
#[tauri::command(async)]
pub fn pi_vault_add(
    app: tauri::AppHandle,
    kind: String,
    label: String,
    origin: Option<String>,
    secret: serde_json::Value,
) -> Result<String, String> {
    on_big_stack(move || {
        if !KINDS.contains(&kind.as_str()) {
            return Err(format!("未知条目类型: {kind}"));
        }
        if label.trim().is_empty() {
            return Err("标签不能为空".into());
        }
        if let Some(o) = &origin {
            if !o.starts_with("http://") && !o.starts_with("https://") {
                return Err("来源必须是 http(s) URL".into());
            }
        }
        if !secret.is_object() || secret.as_object().is_some_and(|o| o.is_empty()) {
            return Err("secret 内容为空".into());
        }
        let path = vault_meta_path(&app)?;
        let mut items = read_meta(&path)?;
        let id = format!(
            "v-{}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0),
            items.len()
        );
        let entry = keyring_entry(&id)?;
        entry
            .set_password(&serde_json::to_string(&secret).map_err(|e| e.to_string())?)
            .map_err(|e| format!("密文写入凭据管理器失败: {e}"))?;
        items.push(VaultItemMeta {
            id: id.clone(),
            kind,
            label: label.trim().to_string(),
            origin,
            created_at: chrono_now(),
        });
        write_meta(&path, &items)?;
        Ok(id)
    })?
}

/// 删除条目（元数据 + 密文；密文缺失按已删处理——幂等）。
#[tauri::command(async)]
pub fn pi_vault_remove(app: tauri::AppHandle, id: String) -> Result<bool, String> {
    on_big_stack(move || {
        let path = vault_meta_path(&app)?;
        let mut items = read_meta(&path)?;
        let before = items.len();
        items.retain(|it| it.id != id);
        if items.len() == before {
            return Ok(false);
        }
        // 密文删除：条目不存在不算错（OS 凭据管理器可能已被用户手清）
        if let Ok(entry) = keyring_entry(&id) {
            let _ = entry.delete_credential();
        }
        write_meta(&path, &items)?;
        Ok(true)
    })?
}

/// 显式取回一条密文（**永不进列表/日志**）。这是给未来浏览器控制扩展
/// （代理代填）预留的取用口——当前没有消费者，UI 不调用。
#[tauri::command(async)]
pub fn pi_vault_reveal(id: String) -> Result<serde_json::Value, String> {
    on_big_stack(move || {
        let entry = keyring_entry(&id)?;
        let password = entry
            .get_password()
            .map_err(|e| format!("密文读取失败: {e}"))?;
        serde_json::from_str(&password).map_err(|e| format!("密文解析失败: {e}"))
    })?
}

/// 时间戳（UTC ISO；hermes created_at 同形态）。chrono 不在依赖树里，
/// 手工拼 UTC（密码库的时间戳只用于展示，精度到秒足够）。
fn chrono_now() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let days = now / 86_400;
    let secs = now % 86_400;
    // 1970-01-01 起的民用日期（简化历法：足够到 2100 年不出错）
    let (y, m, d) = civil_from_days(days as i64);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        secs / 3600,
        (secs % 3600) / 60,
        secs % 60
    )
}

/// 天数 → (年, 月, 日)（Howard Hinnant 的 civil_from_days 算法）。
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

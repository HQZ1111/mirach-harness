//! 数据目录（agent home）可配置（2026-11-27 用户："默认到 c 盘了固定位置了，
//! 安装到其他盘怎么办"）。
//!
//! 事实：pi 的数据根默认永远是 `~/.rpi/agent`（用户目录在 C 盘），与安装盘
//! 无关——这是 hermes/pi 的既有语义（升级、多用户、多安装共存都靠它）。
//! 宿主因此提供**可配置覆盖**：设置页「版本与更新 → 运行信息」里可选一个
//! 目录，写进本文件，下次启动时在**引擎初始化之前**设置
//! `RPI_CODING_AGENT_DIR`，整棵数据树（技能/插件/会话/配置）落到用户指定
//! 的盘。不选 = 保持默认。
//!
//! ## 存储位置不能跟着数据目录走
//!
//! 本文件本身必须存在一个**与 agent home 无关**的固定位置，否则"改回默认"
//! 在自定义目录不可用时读不到。落点 = Tauri 的 app 配置目录
//! `%APPDATA%\com.mirach.harness\data-dir.json`（与 app-prefs.json 同根，
//! 但 app-prefs 经 AppHandle 解析，本文件要在 Tauri 启动前读——所以这里自己
//! 拼 `%APPDATA%`，两者结果一致）。
//!
//! ## 校验纪律（规矩 12）
//!
//! · 相对路径、非法 JSON、空白目录名 → **Err**（启动时 Message Box 明示路径
//!   与原因后退出，绝不静默落回默认——那会让用户以为数据在这个盘、实际在 C 盘）；
//! · 目录不存在 → 由 `set` 时创建；启动时若目录消失 → 重新创建（数据根本来就
//!   是"目录可缺、文件缺即默认"的语义）；
//! · 显式环境变量 `RPI_CODING_AGENT_DIR` 优先（开发者/CI 场景），此时应用内
//!   设置不生效并在界面上如实标注。

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::pi_paths;

const APP_DIR_NAME: &str = "com.mirach.harness";
const CONFIG_FILE: &str = "data-dir.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DataDirConfig {
    /// 自定义 agent home 的绝对路径。空 = 使用默认（`~/.rpi/agent`）。
    agent_dir: Option<String>,
}

fn config_path() -> Result<PathBuf, String> {
    let appdata = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("LOCALAPPDATA").map(PathBuf::from))
        .ok_or("无法定位 %APPDATA%（用户 Roaming 目录）")?;
    Ok(appdata.join(APP_DIR_NAME).join(CONFIG_FILE))
}

fn read_config() -> Result<Option<DataDirConfig>, String> {
    let path = config_path()?;
    match std::fs::read_to_string(&path) {
        Ok(raw) if raw.trim().is_empty() => Ok(None),
        Ok(raw) => serde_json::from_str(&raw)
            .map(Some)
            .map_err(|e| format!("数据目录配置解析失败 {}: {e}；请修复或删除该文件", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("数据目录配置读取失败 {}: {e}", path.display())),
    }
}

fn write_config(config: &DataDirConfig) -> Result<(), String> {
    let path = config_path()?;
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(parent)
        .map_err(|e| format!("数据目录配置目录创建失败 {}: {e}", parent.display()))?;
    let mut contents = serde_json::to_string_pretty(config)
        .map_err(|e| format!("数据目录配置序列化失败: {e}"))?;
    contents.push('\n');
    let tmp = parent.join(format!("{CONFIG_FILE}.tmp-{}", std::process::id()));
    std::fs::write(&tmp, contents.as_bytes())
        .map_err(|e| format!("数据目录配置写入失败 {}: {e}", path.display()))?;
    std::fs::rename(&tmp, &path)
        .map_err(|e| format!("数据目录配置替换失败 {}: {e}", path.display()))
        .inspect_err(|_| {
            let _ = std::fs::remove_file(&tmp);
        })
}

fn validate_absolute(raw: &str) -> Result<PathBuf, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("数据目录不能为空".to_string());
    }
    let path = PathBuf::from(trimmed);
    if !path.is_absolute() {
        return Err(format!("数据目录必须是绝对路径：{trimmed}"));
    }
    Ok(path)
}

/// 启动最早期调用（`main()` 进入 Tauri 之前）：读覆盖并设环境变量。
///
/// 显式 `RPI_CODING_AGENT_DIR` 已设置时跳过（开发者/CI 优先），返回
/// `Ok(Some(env_override))` 供界面标注；否则设置后返回 `Ok(Some(dir))`；
/// 没有配置返回 `Ok(None)`。
pub fn apply_early() -> Result<Option<PathBuf>, String> {
    if let Some(existing) = std::env::var_os("RPI_CODING_AGENT_DIR") {
        let path = PathBuf::from(&existing);
        if !path.is_absolute() {
            return Err(format!(
                "环境变量 RPI_CODING_AGENT_DIR 必须是绝对路径：{}",
                existing.to_string_lossy()
            ));
        }
        eprintln!(
            "[data-dir] RPI_CODING_AGENT_DIR 环境变量生效，忽略应用内数据目录设置：{}",
            path.display()
        );
        return Ok(Some(path));
    }
    let Some(config) = read_config()? else {
        return Ok(None);
    };
    let Some(raw) = config.agent_dir.filter(|s| !s.trim().is_empty()) else {
        return Ok(None);
    };
    let path = validate_absolute(&raw)?;
    // 目录缺失即重建（数据根本身是"文件缺即默认"的语义；目录建不出来属于
    // 配置坏了，直接报错让用户看到）。
    std::fs::create_dir_all(&path)
        .map_err(|e| format!("数据目录创建失败 {}: {e}", path.display()))?;
    std::env::set_var("RPI_CODING_AGENT_DIR", &path);
    eprintln!("[data-dir] 使用自定义数据目录：{}", path.display());
    Ok(Some(path))
}

/// IPC 读面：当前生效目录 / 是否来自环境变量 / 默认目录。
#[tauri::command]
pub fn pi_data_dir_get() -> Result<serde_json::Value, String> {
    let current = pi_paths::agent_dir()?;
    let env_override = std::env::var_os("RPI_CODING_AGENT_DIR").map(PathBuf::from);
    let default_dir = {
        let home = std::env::var_os("USERPROFILE")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(PathBuf::from))
            .ok_or("无法定位用户主目录")?;
        home.join(".rpi").join("agent")
    };
    let configured = read_config()?.and_then(|c| c.agent_dir);
    Ok(serde_json::json!({
        "current": current.display().to_string(),
        "defaultDir": default_dir.display().to_string(),
        "configured": configured,
        // 环境变量压过应用内设置：界面要如实标注，而不是显示一个假的"已生效"。
        "envOverride": env_override.map(|p| p.display().to_string()),
    }))
}

/// IPC 写面：设置 / 清除自定义数据目录（下次启动生效，不移动现有数据）。
#[tauri::command(rename_all = "camelCase")]
pub fn pi_data_dir_set(agent_dir: Option<String>) -> Result<(), String> {
    match agent_dir.filter(|s| !s.trim().is_empty()) {
        Some(raw) => {
            let path = validate_absolute(&raw)?;
            std::fs::create_dir_all(&path)
                .map_err(|e| format!("数据目录创建失败 {}: {e}", path.display()))?;
            write_config(&DataDirConfig {
                agent_dir: Some(path.display().to_string()),
            })
        }
        None => write_config(&DataDirConfig { agent_dir: None }),
    }
}

/// 在资源管理器里打开当前数据目录（数据可能很大，给用户一个出口去看）。
#[tauri::command]
pub fn pi_data_dir_reveal() -> Result<(), String> {
    let dir = pi_paths::agent_dir()?;
    #[cfg(windows)]
    {
        std::process::Command::new("explorer")
            .arg(&dir)
            .spawn()
            .map_err(|e| format!("打开数据目录失败 {}: {e}", dir.display()))?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        Err(format!("当前平台不支持在文件管理器中打开：{}", dir.display()))
    }
}

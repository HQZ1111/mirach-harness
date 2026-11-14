//! rpi 配置路径（替代旧 pi::config::Config 的路径工具——2026-11-14 删除
//! pi_agent_rust 依赖轮）。路径语义照抄 rpi-cli/src/config.rs：
//! `~/.rpi/agent/`（RPI_CODING_AGENT_DIR 绝对路径覆盖；相对值拒绝——
//! 与 rpi 逐字节一致）。settings/models/auth 三件套 = rpi 原生格式，
//! mirach 设置页直接读写它们（不再经旧 pi Config::load）。

use std::path::PathBuf;

const CONFIG_DIR_ENV: &str = "RPI_CODING_AGENT_DIR";
const CONFIG_DIR_NAME: &str = ".rpi";

/// `~/.rpi/agent/`（RPI_CODING_AGENT_DIR 绝对路径覆盖；相对值拒绝——
/// 与 rpi-cli config.rs 逐语义一致）。
pub fn agent_dir() -> Result<PathBuf, String> {
    if let Some(val) = std::env::var_os(CONFIG_DIR_ENV) {
        let p = PathBuf::from(&val);
        if !p.is_absolute() {
            return Err(format!(
                "{CONFIG_DIR_ENV} 覆盖必须是绝对路径: {}",
                val.to_string_lossy()
            ));
        }
        return Ok(p);
    }
    let home = std::env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(PathBuf::from))
        .ok_or("无法定位用户主目录")?;
    Ok(home.join(CONFIG_DIR_NAME).join("agent"))
}

/// `~/.rpi/agent/settings.json`。
pub fn settings_path() -> Result<PathBuf, String> {
    Ok(agent_dir()?.join("settings.json"))
}

/// `~/.rpi/agent/models.json`。
pub fn models_path() -> Result<PathBuf, String> {
    Ok(agent_dir()?.join("models.json"))
}

/// `~/.rpi/agent/auth.json`。
pub fn auth_path() -> Result<PathBuf, String> {
    Ok(agent_dir()?.join("auth.json"))
}

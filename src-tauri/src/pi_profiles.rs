//! 环境（profile）隔离——hermes `~/.hermes/profiles/<name>/` 的宿主对偶
//! （2026-11-22 用户定稿："本地 bot 每个就是一个环境配置，切换的时候左侧栏
//! 的会话会变……每个环境只启用自己的配置和会话，能减少开销"）。
//!
//! hermes 侧事实（`agent/hermes_constants.py`）：默认 home = `~/.hermes`，
//! 具名 profile = `~/.hermes/profiles/<name>`，**每个 profile 是一个完整
//! home**（自己的 sessions/state/config）；HERMES_HOME 指向哪个 home，
//! 网关就只加载哪个环境的会话与配置。
//!
//! 宿主对偶：
//! - 本体（default）= `~/.rpi/agent`（既有全局会话/配置，行为不变）；
//! - 具名环境 = `~/.rpi/agent/profiles/<name>/`，会话落
//!   `<home>/sessions/<encoded-cwd>/…`（rpi `Args.session_dir` 面，
//!   引擎原生支持——不是前端过滤）。
//!
//! 引擎侧只认 `session_dir`：新会话建在该目录下；`list_sessions` /
//! `index_sessions` 只扫当前活动环境（其余环境零扫描 = hermes 的
//! "只启用自己的会话" 开销对偶）。

use std::path::PathBuf;

use crate::pi_paths;

/// 环境名 → 规范化名字（空 / `default` = 本体，返回 None）。
///
/// 拒绝路径分隔符与 `.`/`..`：环境名最终拼进文件系统路径，绝不能越界
/// （hermes 侧 profile 名同样禁止路径形状）。
pub fn normalize_profile(name: Option<&str>) -> Result<Option<String>, String> {
    let Some(raw) = name else { return Ok(None) };
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("default") {
        return Ok(None);
    }
    if trimmed.contains('/')
        || trimmed.contains('\\')
        || trimmed == "."
        || trimmed == ".."
        || trimmed.contains("..")
    {
        return Err(format!("非法的环境名：{trimmed}"));
    }
    Ok(Some(trimmed.to_owned()))
}

/// 环境 home（本体 = agent 目录；具名 = `agent/profiles/<name>`）。
/// 不创建目录（读面用；写面显式 `ensure_profile_dirs`）。
pub fn profile_home(name: Option<&str>) -> Result<PathBuf, String> {
    let agent = pi_paths::agent_dir()?;
    match normalize_profile(name)? {
        None => Ok(agent),
        Some(n) => Ok(agent.join("profiles").join(n)),
    }
}

/// 环境会话根：本体 = None（走 rpi 默认解析——settings.sessionDir /
/// `<cwd>/.rpi/sessions`，既有会话不动）；具名 = `<home>/sessions`。
pub fn profile_sessions_dir(name: Option<&str>) -> Result<Option<PathBuf>, String> {
    match normalize_profile(name)? {
        None => Ok(None),
        Some(n) => Ok(Some(profile_home(Some(&n))?.join("sessions"))),
    }
}

/// 写面：确保具名环境的 home/sessions 目录存在（建会话前调用）。
pub fn ensure_profile_dirs(name: Option<&str>) -> Result<Option<PathBuf>, String> {
    let Some(dir) = profile_sessions_dir(name)? else {
        return Ok(None);
    };
    std::fs::create_dir_all(&dir).map_err(|e| format!("环境目录创建失败 {}: {e}", dir.display()))?;
    if let Some(n) = normalize_profile(name)? {
        seed_profile_home_config(&n)?;
    }
    Ok(Some(dir))
}

/// 具名环境 home 的配置四件套缺失时，从**本体 home 克隆**一份
/// （hermes `hermes profile create --clone-all` 的宿主对偶；2026-11-25 配置
/// 绑定）。没有它们，切到该环境后 provider/model 解析拿不到凭据——
/// 现存 bot 是隔离前建的，home 里只有 sessions/。
///
/// **只补缺**：已存在的文件（哪怕空文件）不覆盖，用户在该环境里的修改不会被
/// 回滚；本体也没有的文件跳过（首次写入时引擎/设置页自然生成）。
pub fn seed_profile_home_config(name: &str) -> Result<(), String> {
    let Some(normalized) = normalize_profile(Some(name))? else {
        return Ok(());
    };
    let home = profile_home(Some(&normalized))?;
    let default_home = profile_home(None)?;
    if home == default_home {
        return Ok(());
    }
    std::fs::create_dir_all(&home)
        .map_err(|e| format!("环境 home 创建失败 {}: {e}", home.display()))?;
    for file in ["auth.json", "models.json", "settings.json", "trust.json"] {
        let dst = home.join(file);
        if dst.exists() {
            continue;
        }
        let src = default_home.join(file);
        match std::fs::copy(&src, &dst) {
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => {
                return Err(format!(
                    "环境配置克隆失败 {} → {}: {e}",
                    src.display(),
                    dst.display()
                ))
            }
        }
    }
    Ok(())
}

/// 环境名 → rpi `AgentHome`（**配置绑定** 2026-11-25：会话构建与资源解析
/// ——技能/扩展/SYSTEM.md/settings/trust——都按这个 home 走；AgentHome 是
/// 上游 PR #409 注入面，同一进程可为不同会话用不同 home）。
///
/// 本体 = `AgentHome::process()`（进程 agent 目录，行为与升级前一致）；
/// 具名 = `<agent>/profiles/<name>`（hermes「每个 profile 一个完整 home」
/// 的宿主对偶）。目录不创建（读面）。
pub fn home_for_profile(name: Option<&str>) -> Result<rpi_cli::config::AgentHome, String> {
    match normalize_profile(name)? {
        None => Ok(rpi_cli::config::AgentHome::process()),
        Some(n) => rpi_cli::config::AgentHome::from_option(Some(profile_home(Some(&n))?))
            .map_err(|e| format!("环境 home 解析失败（{n}）：{e}")),
    }
}

/// 引擎**当前活动环境**的 home（设置页/能力面 IPC 的配置绑定入口）。
pub fn active_home(
    engine: &crate::pi_session::PiEngine,
) -> Result<rpi_cli::config::AgentHome, String> {
    home_for_profile(engine.active_profile()?.as_deref())
}

/// 会话文件路径 → 所属环境：`<agent>/profiles/<name>/sessions/...` →
/// `Some(name)`。其余路径（本体 home 的会话 / 工作区 `<cwd>/.rpi/sessions`
/// / 自定义根）= `None`（本体口径）——**打开会话即绑定文件自己所在环境的
/// 配置**（跨环境打开不会拿错技能/插件面）。
pub fn profile_from_session_path(path: &std::path::Path) -> Option<String> {
    let root = pi_paths::agent_dir().ok()?;
    let rel = path.strip_prefix(root.join("profiles")).ok()?;
    let mut components = rel.components();
    let name = components.next()?.as_os_str().to_str()?;
    normalize_profile(Some(name)).ok().flatten()
}

/// 删除具名环境的整个 home（hermes profile 删除的宿主对偶；2026-11-23）。
///
/// 只删 `<agent_dir>/profiles/<name>`，`default` 永远拒绝。目录不存在
/// 返回 `removed=false`（幂等，调用方据此区分"本来就没有"）；符号链接
/// 直接拒绝，避免 profile 名下的链接把删除带到别处。
#[derive(serde::Serialize)]
pub struct ProfileDeleteOutcome {
    pub removed: bool,
}

pub fn delete_profile_home(name: &str) -> Result<ProfileDeleteOutcome, String> {
    let Some(normalized) = normalize_profile(Some(name))? else {
        return Err("默认环境不可删除".to_owned());
    };
    let home = profile_home(Some(&normalized))?;
    let profiles_root = pi_paths::agent_dir()?.join("profiles");
    if !home.starts_with(&profiles_root) {
        return Err(format!("拒绝删除 profile 目录之外的路径：{}", home.display()));
    }
    match std::fs::symlink_metadata(&home) {
        Ok(meta) if meta.file_type().is_symlink() => {
            return Err(format!("拒绝删除符号链接环境目录：{}", home.display()));
        }
        Ok(_) => {
            std::fs::remove_dir_all(&home)
                .map_err(|e| format!("环境目录删除失败 {}: {e}", home.display()))?;
            Ok(ProfileDeleteOutcome { removed: true })
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            Ok(ProfileDeleteOutcome { removed: false })
        }
        Err(e) => Err(format!("环境目录读取失败 {}: {e}", home.display())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn normalize_defaults_and_rejects_escapes() {
        assert_eq!(normalize_profile(None).unwrap(), None);
        assert_eq!(normalize_profile(Some("")).unwrap(), None);
        assert_eq!(normalize_profile(Some("default")).unwrap(), None);
        assert_eq!(normalize_profile(Some(" DEFAULT ")).unwrap(), None);
        assert_eq!(normalize_profile(Some("微软")).unwrap().as_deref(), Some("微软"));
        assert!(normalize_profile(Some("../x")).is_err());
        assert!(normalize_profile(Some("a/b")).is_err());
        assert!(normalize_profile(Some("a\\b")).is_err());
    }

    #[test]
    fn default_has_no_override_dir() {
        assert_eq!(profile_sessions_dir(None).unwrap(), None);
        assert_eq!(profile_sessions_dir(Some("default")).unwrap(), None);
    }

    #[test]
    fn named_profile_sessions_dir_shape() {
        let dir = profile_sessions_dir(Some("bot-x")).unwrap().unwrap();
        assert!(dir.ends_with(Path::new("profiles").join("bot-x").join("sessions")), "{}", dir.display());
    }

    #[test]
    fn delete_refuses_default_and_unescaped_names() {
        assert!(delete_profile_home("default").is_err());
        assert!(delete_profile_home("../x").is_err());
        assert!(delete_profile_home("a/b").is_err());
    }
}

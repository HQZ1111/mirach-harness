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
    Ok(Some(dir))
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

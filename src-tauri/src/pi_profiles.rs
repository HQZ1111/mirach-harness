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
use crate::win_proc::HideConsole;

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
    // 技能 / 原生扩展 / 原生包登记表：hermes `profile create --clone-all`
    // 同语义，只补缺不覆盖。没有它们，具名环境的新会话拿不到全局技能，
    // 也加载不到任何原生插件（2026-11-26 用户："目录还要啊……bots 和
    // 收音机是插件"——插件列表按环境 home 解析，空目录不是"没有插件"）。
    for dir in ["skills", "extensions"] {
        copy_dir_missing(&default_home.join(dir), &home.join(dir))?;
    }
    let registry_src = default_home.join("native-packages.json");
    let registry_dst = home.join("native-packages.json");
    if !registry_dst.exists() && registry_src.is_file() {
        std::fs::copy(&registry_src, &registry_dst).map_err(|e| {
            format!(
                "环境原生包登记表克隆失败 {} → {}: {e}",
                registry_src.display(),
                registry_dst.display()
            )
        })?;
    }
    Ok(())
}

/// 只补缺的递归目录复制（同名文件/目录已存在就跳过；符号链接跳过，
/// 不把链接目标带进别的 home）。
fn copy_dir_missing(src: &std::path::Path, dst: &std::path::Path) -> Result<(), String> {
    let entries = match std::fs::read_dir(src) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(format!("环境资源目录读取失败 {}: {e}", src.display())),
    };
    std::fs::create_dir_all(dst)
        .map_err(|e| format!("环境资源目录创建失败 {}: {e}", dst.display()))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("环境资源目录项读取失败 {}: {e}", src.display()))?;
        let file_type = entry
            .file_type()
            .map_err(|e| format!("环境资源目录项类型读取失败 {}: {e}", src.display()))?;
        if file_type.is_symlink() {
            continue;
        }
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if file_type.is_dir() {
            copy_dir_missing(&from, &to)?;
        } else if file_type.is_file() && !to.exists() {
            std::fs::copy(&from, &to).map_err(|e| {
                format!(
                    "环境资源克隆失败 {} → {}: {e}",
                    from.display(),
                    to.display()
                )
            })?;
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

/// 全部具名环境名（`<agent>/profiles/*` 的目录项；名字过 `normalize_profile`
/// 校验，非法形状跳过不报错——它们本来就进不了 profile_home）。
///
/// 读面：跨环境聚合（侧栏「网关与配置」的候选清单）用。目录不存在 = 空
/// 列表（还没建过环境是正常态）；根目录读不了 = Err（坏环境不能当成没有）。
pub fn list_profile_names() -> Result<Vec<String>, String> {
    let root = pi_paths::agent_dir()?.join("profiles");
    let entries = match std::fs::read_dir(&root) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("环境目录读取失败 {}: {e}", root.display())),
    };
    let mut names = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| format!("环境目录项读取失败: {e}"))?;
        let file_type = entry
            .file_type()
            .map_err(|e| format!("环境目录项类型读取失败: {e}"))?;
        if !file_type.is_dir() {
            continue;
        }
        if let Some(name) = entry
            .file_name()
            .to_str()
            .and_then(|n| normalize_profile(Some(n)).ok().flatten())
        {
            names.push(name);
        }
    }
    names.sort();
    Ok(names)
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

/// 重命名具名环境（hermes `profiles.rename` 的宿主对偶，2026-11-26）：
/// 改 `<agent>/profiles/<name>` 目录名。默认环境拒绝、目标已存在拒绝、
/// 符号链接拒绝；名字相同 = `renamed:false` 幂等。
///
/// **活动环境由调用方先切走**：live 会话的路径/句柄还指在旧目录里，
/// 原地改名会让引擎持有悬空路径——命令层（main.rs）对活动环境直接拒绝。
#[derive(serde::Serialize)]
pub struct ProfileRenameOutcome {
    pub renamed: bool,
    pub name: String,
}

pub fn rename_profile_home(
    from: &str,
    to: &str,
) -> Result<ProfileRenameOutcome, String> {
    let Some(from_name) = normalize_profile(Some(from))? else {
        return Err("默认环境不可重命名".to_owned());
    };
    let Some(to_name) = normalize_profile(Some(to))? else {
        return Err("目标名字非法（不能为空或 default）".to_owned());
    };
    if from_name == to_name {
        return Ok(ProfileRenameOutcome {
            renamed: false,
            name: from_name,
        });
    }
    let source = profile_home(Some(&from_name))?;
    let target = profile_home(Some(&to_name))?;
    let profiles_root = pi_paths::agent_dir()?.join("profiles");
    if !source.starts_with(&profiles_root) || !target.starts_with(&profiles_root) {
        return Err(format!(
            "拒绝重命名 profile 目录之外的路径：{} → {}",
            source.display(),
            target.display()
        ));
    }
    match std::fs::symlink_metadata(&source) {
        Ok(meta) if meta.file_type().is_symlink() => {
            return Err(format!("拒绝重命名符号链接环境目录：{}", source.display()));
        }
        Ok(meta) if !meta.is_dir() => {
            return Err(format!("环境路径不是目录：{}", source.display()));
        }
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(format!("环境不存在：{from_name}"));
        }
        Err(e) => {
            return Err(format!("环境目录读取失败 {}: {e}", source.display()));
        }
    }
    if target.exists() {
        return Err(format!("同名环境已存在：{to_name}"));
    }
    std::fs::rename(&source, &target)
        .map_err(|e| format!("环境目录重命名失败 {} → {}: {e}", source.display(), target.display()))?;
    Ok(ProfileRenameOutcome {
        renamed: true,
        name: to_name,
    })
}

/// 导出具名环境为 `.tar.gz`（hermes `profiles.export` 的宿主对偶；2026-11-26）。
///
/// 归档 = 该环境 home 的整棵目录（配置/技能/扩展/会话），排除 `*.lock`
/// 运行锁。默认环境拒绝（它是 agent 根，包含所有 profile，导出会递归
/// 套娃且泄露全部环境）。输出缺省 = `<agent>/exports/<name>-<时间>.tar.gz`。
pub fn export_profile_home(
    name: &str,
    output: Option<&str>,
) -> Result<PathBuf, String> {
    let Some(normalized) = normalize_profile(Some(name))? else {
        return Err("默认环境不可导出".to_owned());
    };
    let home = profile_home(Some(&normalized))?;
    if !home.is_dir() {
        return Err(format!("环境不存在：{normalized}"));
    }
    let archive = match output.map(str::trim).filter(|value| !value.is_empty()) {
        Some(path) => PathBuf::from(path),
        None => {
            let stamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            pi_paths::agent_dir()?
                .join("exports")
                .join(format!("{normalized}-{stamp}.tar.gz"))
        }
    };
    if let Some(parent) = archive.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("导出目录创建失败 {}: {e}", parent.display()))?;
    }
    let status = std::process::Command::new("tar")
        .arg("-czf")
        .arg(&archive)
        .arg("-C")
        .arg(&home)
        .arg("--exclude=*.lock")
        .arg(".")
        .hide_console()
        .status()
        .map_err(|e| format!("tar 启动失败（导出配置档案）：{e}"))?;
    if !status.success() {
        return Err(format!("tar 导出失败（退出码 {:?}）", status.code()));
    }
    Ok(archive)
}

/// 导入 `.tar.gz` 为新的具名环境（hermes `profiles/import` 的宿主对偶）。
///
/// 先解到 `<agent>/imports/` 临时目录并做安全校验（绝对路径 / `..` /
/// 符号链接一律拒绝），再整体搬到 `<agent>/profiles/<name>`。目标已存在
/// 直接拒绝；名字缺省取归档文件名。
pub fn import_profile_home(
    archive: &str,
    name: Option<&str>,
) -> Result<(String, PathBuf), String> {
    let archive_path = PathBuf::from(archive);
    if !archive_path.is_file() {
        return Err(format!("归档不存在：{archive}"));
    }
    let fallback = archive_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .trim_end_matches(".tar.gz")
        .trim_end_matches(".tgz")
        .to_owned();
    let requested = name.map(str::trim).filter(|value| !value.is_empty()).unwrap_or(&fallback);
    let Some(normalized) = normalize_profile(Some(requested))? else {
        return Err("导入目标不能是 default；请提供新的环境名".to_owned());
    };
    let target = profile_home(Some(&normalized))?;
    if target.exists() {
        return Err(format!("同名环境已存在：{normalized}"));
    }

    // 归档条目安全校验：绝对路径 / 盘符开头 / `..` 组件 / 反斜杠越界。
    let listing = std::process::Command::new("tar")
        .arg("-tzf")
        .arg(&archive_path)
        .hide_console()
        .output()
        .map_err(|e| format!("tar 启动失败（读取归档清单）：{e}"))?;
    if !listing.status.success() {
        return Err(format!(
            "归档清单读取失败（退出码 {:?}）：{}",
            listing.status.code(),
            String::from_utf8_lossy(&listing.stderr).trim()
        ));
    }
    let text = String::from_utf8_lossy(&listing.stdout);
    for entry in text.lines() {
        let trimmed = entry.trim();
        if trimmed.is_empty() {
            continue;
        }
        let has_drive = trimmed.as_bytes().get(1) == Some(&b':');
        if trimmed.starts_with('/') || trimmed.starts_with('\\') || has_drive {
            return Err(format!("归档包含绝对路径条目，拒绝导入：{trimmed}"));
        }
        if trimmed.split(['/', '\\']).any(|part| part == "..") {
            return Err(format!("归档包含越界路径条目，拒绝导入：{trimmed}"));
        }
    }

    let imports_root = pi_paths::agent_dir()?.join("imports");
    std::fs::create_dir_all(&imports_root)
        .map_err(|e| format!("导入临时目录创建失败 {}: {e}", imports_root.display()))?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let staging = imports_root.join(format!(".import-{}-{stamp}", std::process::id()));
    if staging.exists() {
        std::fs::remove_dir_all(&staging)
            .map_err(|e| format!("旧导入临时目录清理失败 {}: {e}", staging.display()))?;
    }
    std::fs::create_dir_all(&staging)
        .map_err(|e| format!("导入临时目录创建失败 {}: {e}", staging.display()))?;

    let extract = std::process::Command::new("tar")
        .arg("-xzf")
        .arg(&archive_path)
        .arg("-C")
        .arg(&staging)
        .hide_console()
        .status()
        .map_err(|e| format!("tar 启动失败（解包配置档案）：{e}"))?;
    if !extract.success() {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(format!("归档解包失败（退出码 {:?}）", extract.code()));
    }
    if contains_symlink(&staging) {
        let _ = std::fs::remove_dir_all(&staging);
        return Err("归档包含符号链接，拒绝导入".to_owned());
    }

    // 兼容"单层目录包"：归档里只有一个顶层目录且没有顶层文件时，把它当内容根。
    let entries = std::fs::read_dir(&staging)
        .map_err(|e| format!("导入临时目录读取失败 {}: {e}", staging.display()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("导入临时目录项读取失败：{e}"))?;
    let content_root = if entries.len() == 1 && entries[0].path().is_dir() {
        entries[0].path()
    } else {
        staging.clone()
    };

    let profiles_root = pi_paths::agent_dir()?.join("profiles");
    std::fs::create_dir_all(&profiles_root)
        .map_err(|e| format!("环境根目录创建失败 {}: {e}", profiles_root.display()))?;
    std::fs::rename(&content_root, &target).map_err(|e| {
        let _ = std::fs::remove_dir_all(&staging);
        format!(
            "导入落盘失败 {} → {}: {e}",
            content_root.display(),
            target.display()
        )
    })?;
    if content_root != staging {
        let _ = std::fs::remove_dir_all(&staging);
    }
    Ok((normalized, target))
}

fn contains_symlink(root: &std::path::Path) -> bool {
    let Ok(entries) = std::fs::read_dir(root) else {
        return true;
    };
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            return true;
        };
        if file_type.is_symlink() {
            return true;
        }
        if file_type.is_dir() && contains_symlink(&entry.path()) {
            return true;
        }
    }
    false
}

/// 单环境信息（配置档案管理页的详情面；hermes `ProfileInfo` 的宿主子集：
/// path / skills 计数；model 由 BotPreset 提供，不在引擎层重复）。
#[derive(serde::Serialize)]
pub struct ProfileInfoOutcome {
    pub name: String,
    pub path: String,
    pub exists: bool,
    pub skills: u32,
}

pub fn profile_info(name: &str) -> Result<ProfileInfoOutcome, String> {
    let normalized = normalize_profile(Some(name))?;
    let home = profile_home(normalized.as_deref())?;
    let skills = count_profile_skills(&home);
    Ok(ProfileInfoOutcome {
        name: normalized.unwrap_or_else(|| "default".to_owned()),
        path: home.to_string_lossy().into_owned(),
        exists: home.is_dir(),
        skills,
    })
}

/// `<home>/skills/*/SKILL.md` 的技能数（管理页的 skill_count 对偶；目录
/// 读不了 = 0，缺目录是正常态）。
fn count_profile_skills(home: &std::path::Path) -> u32 {
    let dir = home.join("skills");
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return 0;
    };
    let mut count = 0;
    for entry in entries.flatten() {
        if entry.path().join("SKILL.md").is_file() {
            count += 1;
        }
    }
    count
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

    #[test]
    fn rename_refuses_default_null_and_unescaped_names() {
        assert!(rename_profile_home("default", "x").is_err());
        assert!(rename_profile_home("x", "default").is_err());
        assert!(rename_profile_home("../x", "y").is_err());
        assert!(rename_profile_home("x", "a/b").is_err());
    }

    #[test]
    fn list_profile_names_returns_empty_when_root_missing() {
        // 目录不存在（或没建过环境）→ 空列表，不是错误。
        // 本机真目录里可能有环境——只断言不报错与形状（全为规范化名字）。
        let names = list_profile_names().expect("list must not fail");
        for name in &names {
            assert!(!name.contains('/') && !name.contains('\\') && !name.contains(".."));
        }
    }
}

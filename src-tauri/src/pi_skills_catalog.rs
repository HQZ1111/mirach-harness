//! 本地技能目录（hermes `optional-skills/` 的宿主复制，2026-11-17）。
//!
//! hermes 的技能市场（Hub）在本宿主没有后端；但上游源码树自带 **22 分类 /
//! 139 个技能**（`optional-skills/<category>/<skill>/SKILL.md` + 附加脚本/
//! 资源，共 819 文件 / 10.8MB）。本模块把它们做成宿主可搜索、可安装的目录：
//!
//! - 目录根：打包资源 `skills-catalog/`（tauri bundle.resources）；开发树
//!   回落到 `CARGO_MANIFEST_DIR/skills-catalog`。
//! - 安装 = 把 `<category>/<skill>` 整目录复制到
//!   `~/.rpi/agent/skills/<skill>/`（rpi 的技能发现目录；下次会话/技能刷新
//!   生效，与 `pi_capabilities` 的读取同源）。
//! - 只读技能名（`[A-Za-z0-9._-]`）防路径穿越；复制失败原样传播（规矩 12）。

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use tauri::Manager;

#[derive(Clone)]
struct SkillEntry {
    name: String,
    description: String,
    category: String,
    source: PathBuf,
}

fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.chars().count() <= 128
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// 技能目录根：打包资源优先，开发树回落。
fn catalog_root(app: &tauri::AppHandle) -> PathBuf {
    if let Ok(resource_dir) = app.path().resource_dir() {
        let bundled = resource_dir.join("skills-catalog");
        if bundled.is_dir() {
            return bundled;
        }
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("skills-catalog")
}

/// 读 SKILL.md 的 frontmatter（只取 name / description；其余字段忽略）。
fn parse_frontmatter(text: &str) -> (Option<String>, Option<String>) {
    let trimmed = text.trim_start();
    if !trimmed.starts_with("---") {
        return (None, None);
    }
    let mut name = None;
    let mut description = None;
    for line in trimmed.lines().skip(1) {
        let line = line.trim();
        if line == "---" {
            break;
        }
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let key = key.trim();
        let mut value = value.trim().to_owned();
        if value.len() >= 2
            && ((value.starts_with('"') && value.ends_with('"'))
                || (value.starts_with('\'') && value.ends_with('\'')))
        {
            value = value[1..value.len() - 1].to_owned();
        }
        match key {
            "name" => name = Some(value),
            "description" => description = Some(value),
            _ => {}
        }
    }
    (name, description)
}

fn scan(root: &Path) -> Result<Vec<SkillEntry>, String> {
    let mut out = Vec::new();
    let categories = fs::read_dir(root).map_err(|e| format!("技能目录读取失败 {}: {e}", root.display()))?;
    for category in categories {
        let category = category.map_err(|e| e.to_string())?;
        if !category.file_type().map_err(|e| e.to_string())?.is_dir() {
            continue;
        }
        let category_name = category.file_name().to_string_lossy().to_string();
        let items = fs::read_dir(category.path()).map_err(|e| e.to_string())?;
        for item in items {
            let item = item.map_err(|e| e.to_string())?;
            if !item.file_type().map_err(|e| e.to_string())?.is_dir() {
                continue;
            }
            let skill_md = item.path().join("SKILL.md");
            if !skill_md.is_file() {
                continue;
            }
            let text = fs::read_to_string(&skill_md).unwrap_or_default();
            let (name, description) = parse_frontmatter(&text);
            let dir_name = item.file_name().to_string_lossy().to_string();
            out.push(SkillEntry {
                name: name.filter(|n| valid_name(n)).unwrap_or(dir_name),
                description: description.unwrap_or_default(),
                category: category_name.clone(),
                source: item.path(),
            });
        }
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(out)
}

fn installed_root() -> Result<PathBuf, String> {
    let dir = crate::pi_paths::agent_dir()?.join("skills");
    fs::create_dir_all(&dir).map_err(|e| format!("技能目录创建失败 {}: {e}", dir.display()))?;
    Ok(dir)
}

fn copy_tree(from: &Path, to: &Path) -> Result<(), String> {
    fs::create_dir_all(to).map_err(|e| format!("创建目录失败 {}: {e}", to.display()))?;
    for entry in fs::read_dir(from).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let target = to.join(entry.file_name());
        let file_type = entry.file_type().map_err(|e| e.to_string())?;
        if file_type.is_dir() {
            copy_tree(&entry.path(), &target)?;
        } else if file_type.is_file() {
            fs::copy(entry.path(), &target)
                .map_err(|e| format!("复制文件失败 {} → {}: {e}", entry.path().display(), target.display()))?;
        }
        // symlink 等不复制（技能目录应为普通文件树）。
    }
    Ok(())
}

/// `skills.manage action=search` 的宿主实现：本地技能目录检索。
#[tauri::command(rename_all = "camelCase", async)]
pub fn pi_skills_search(app: tauri::AppHandle, query: Option<String>) -> Result<Value, String> {
    let root = catalog_root(&app);
    let installed = installed_root()?;
    let needle = query.unwrap_or_default().trim().to_lowercase();
    let entries = scan(&root)?;
    let rows: Vec<Value> = entries
        .iter()
        .filter(|entry| {
            needle.is_empty()
                || entry.name.to_lowercase().contains(&needle)
                || entry.description.to_lowercase().contains(&needle)
                || entry.category.to_lowercase().contains(&needle)
        })
        .map(|entry| {
            json!({
                "name": entry.name,
                "description": entry.description,
                "category": entry.category,
                "installed": installed.join(&entry.name).is_dir(),
            })
        })
        .collect();
    Ok(json!({ "entries": rows }))
}

/// 安装一个技能（整目录复制到 `~/.rpi/agent/skills/<name>`）。
#[tauri::command(rename_all = "camelCase", async)]
pub fn pi_skill_install(app: tauri::AppHandle, name: String) -> Result<Value, String> {
    let name = name.trim();
    if !valid_name(name) {
        return Err(format!("非法技能名: {name}"));
    }
    let root = catalog_root(&app);
    let entry = scan(&root)?
        .into_iter()
        .find(|entry| entry.name == name)
        .ok_or_else(|| format!("技能目录里没有「{name}」"))?;
    let dest = installed_root()?.join(name);
    if dest.is_dir() {
        // 升级：整目录覆盖（先清后拷，避免旧文件残留）。
        fs::remove_dir_all(&dest).map_err(|e| format!("清理旧技能失败 {}: {e}", dest.display()))?;
    }
    copy_tree(&entry.source, &dest)?;
    Ok(json!({ "installed": true, "name": name, "path": dest.display().to_string() }))
}

/// 删除一个已安装技能。
#[tauri::command(rename_all = "camelCase", async)]
pub fn pi_skill_remove(name: String) -> Result<Value, String> {
    let name = name.trim();
    if !valid_name(name) {
        return Err(format!("非法技能名: {name}"));
    }
    let dest = installed_root()?.join(name);
    if dest.is_dir() {
        fs::remove_dir_all(&dest).map_err(|e| format!("删除技能失败 {}: {e}", dest.display()))?;
        return Ok(json!({ "removed": true, "name": name }));
    }
    Ok(json!({ "removed": false, "name": name }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn valid_name_allows_slugs_and_rejects_paths() {
        assert!(valid_name("agent-merge-conflict-arbiter"));
        assert!(valid_name("a.b_c-1"));
        assert!(!valid_name(""));
        assert!(!valid_name("../escape"));
        assert!(!valid_name("a/b"));
        assert!(!valid_name("技能"));
    }

    #[test]
    fn parse_frontmatter_reads_name_and_description() {
        let text = "---\nname: demo\ndescription: \"A demo skill.\"\nversion: 1\n---\n\n# Demo\n";
        let (name, description) = parse_frontmatter(text);
        assert_eq!(name.as_deref(), Some("demo"));
        assert_eq!(description.as_deref(), Some("A demo skill."));
    }

    #[test]
    fn parse_frontmatter_without_block_is_empty() {
        assert_eq!(parse_frontmatter("# no frontmatter"), (None, None));
    }
}

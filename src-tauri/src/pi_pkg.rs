//! pi 包管理 IPC（多环境插件 `mirach-pkg` 的数据面，2026-11-07）：
//! 直调 vendored `PackageManager` 的 **blocking** 变体（install/remove/
//! update_source/list_packages/add_package_source/remove_package_source），
//! npm/git 子进程在大栈线程跑（16MiB 纪律，spawn 子进程不走 tokio）。
//!
//! **禁止自己读写 settings.json**：源列表持久化只走上游
//! `add_package_source_blocking` / `remove_package_source_blocking`
//! （package_manager.rs:881-926，内部改全局/项目 settings.json 的 packages
//! 数组并维护 lockfile）。真相比界面重要：lockfile（pi.package_lock.v1）
//! 的哈希与信任审计由上游维护，宿主只读投影。
//!
//! 失败语义：Err 传播（规矩 12），npm/git 失败原文上抛。

use std::path::PathBuf;

use pi::package_manager::{PackageEntry, PackageManager, PackageScope};

use crate::pi_session::on_big_stack;

/// scope 字符串 → PackageScope（"user" | "project" | "temporary"；未知 Err）。
fn scope_of(value: &str) -> Result<PackageScope, String> {
    match value {
        "user" => Ok(PackageScope::User),
        "project" => Ok(PackageScope::Project),
        "temporary" => Ok(PackageScope::Temporary),
        other => Err(format!("未知 scope「{other}」——应为 user/project/temporary")),
    }
}

fn scope_label(scope: PackageScope) -> &'static str {
    match scope {
        PackageScope::User => "user",
        PackageScope::Project => "project",
        PackageScope::Temporary => "temporary",
    }
}

fn manager_with(cwd: &std::path::Path, project_trusted: bool) -> PackageManager {
    PackageManager::new(cwd.to_path_buf()).with_project_trust(project_trusted)
}

/// PackageEntry → JSON 投影（filter 由上游 serde 序列化；无 Serialize 时逐键
/// 手拼——PackageFilter 字段全是 Option<Vec<String>>，手拼形状稳定）。
fn entry_to_json(entry: &PackageEntry) -> serde_json::Value {
    let filter = entry.filter.as_ref().map(|f| {
        serde_json::json!({
            "extensions": f.extensions,
            "skills": f.skills,
            "prompts": f.prompts,
            "themes": f.themes,
        })
    });
    serde_json::json!({
        "scope": scope_label(entry.scope),
        "source": entry.source,
        "filter": filter,
    })
}

/// 列出已声明包（全局 + 项目 settings 的 packages 数组）。
#[tauri::command(rename_all = "camelCase", async)]
pub fn pi_pkg_list(cwd: Option<String>) -> Result<serde_json::Value, String> {
    let cwd = cwd
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_default());
    let trusted = cwd.exists();
    on_big_stack(move || {
        let manager = manager_with(&cwd, trusted);
        let entries = manager
            .list_packages_blocking()
            .map_err(|e| format!("包清单读取失败: {e}"))?;
        Ok(serde_json::json!({
            "packages": entries.iter().map(entry_to_json).collect::<Vec<_>>(),
        }))
    })?
}

/// 安装包（source = npm:pkg / git:url / 本地路径；scope 决定写哪个 settings）。
#[tauri::command(rename_all = "camelCase", async)]
pub fn pi_pkg_install(cwd: Option<String>, source: String, scope: String) -> Result<serde_json::Value, String> {
    let cwd = cwd
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_default());
    let trusted = cwd.exists();
    let package_scope = scope_of(&scope)?;
    on_big_stack(move || {
        let manager = manager_with(&cwd, trusted);
        manager
            .install_blocking(&source, package_scope)
            .map_err(|e| format!("包安装失败: {e}"))?;
        // 安装成功后源列表同步落 settings（Temporary 不持久化，上游同语义）
        if package_scope != PackageScope::Temporary {
            manager
                .add_package_source_blocking(&source, package_scope)
                .map_err(|e| format!("源列表写入失败（包已安装）: {e}"))?;
        }
        let entries = manager
            .list_packages_blocking()
            .map_err(|e| format!("包清单读取失败: {e}"))?;
        Ok(serde_json::json!({
            "packages": entries.iter().map(entry_to_json).collect::<Vec<_>>(),
        }))
    })?
}

/// 移除包（卸载 + 从源列表删）。
#[tauri::command(rename_all = "camelCase", async)]
pub fn pi_pkg_remove(cwd: Option<String>, source: String, scope: String) -> Result<serde_json::Value, String> {
    let cwd = cwd
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_default());
    let trusted = cwd.exists();
    let package_scope = scope_of(&scope)?;
    on_big_stack(move || {
        let manager = manager_with(&cwd, trusted);
        manager
            .remove_blocking(&source, package_scope)
            .map_err(|e| format!("包移除失败: {e}"))?;
        if package_scope != PackageScope::Temporary {
            manager
                .remove_package_source_blocking(&source, package_scope)
                .map_err(|e| format!("源列表更新失败（包已卸载）: {e}"))?;
        }
        let entries = manager
            .list_packages_blocking()
            .map_err(|e| format!("包清单读取失败: {e}"))?;
        Ok(serde_json::json!({
            "packages": entries.iter().map(entry_to_json).collect::<Vec<_>>(),
        }))
    })?
}

/// 更新包（git fetch --prune + reset --hard @{upstream}；npm 走重装）。
#[tauri::command(rename_all = "camelCase", async)]
pub fn pi_pkg_update(cwd: Option<String>, source: String, scope: String) -> Result<serde_json::Value, String> {
    let cwd = cwd
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_default());
    let trusted = cwd.exists();
    let package_scope = scope_of(&scope)?;
    on_big_stack(move || {
        let manager = manager_with(&cwd, trusted);
        manager
            .update_source_blocking(&source, package_scope)
            .map_err(|e| format!("包更新失败: {e}"))?;
        let entries = manager
            .list_packages_blocking()
            .map_err(|e| format!("包清单读取失败: {e}"))?;
        Ok(serde_json::json!({
            "packages": entries.iter().map(entry_to_json).collect::<Vec<_>>(),
        }))
    })?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scope_parsing_is_strict() {
        assert!(matches!(scope_of("user"), Ok(PackageScope::User)));
        assert!(matches!(scope_of("project"), Ok(PackageScope::Project)));
        assert!(matches!(scope_of("temporary"), Ok(PackageScope::Temporary)));
        assert!(scope_of("global").is_err());
        assert!(scope_of("").is_err());
    }
}

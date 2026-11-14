//! 包管理页 IPC（2026-11-14 竖链回填：`pi_pkg_list` 真实现，其余三命令
//! 保留 Err 并给出正确的下一步）。
//!
//! ## 列表真相 = 两张登记表
//!
//! rpi 有两套互相独立的包登记，宿主**只读投影**，不合并成一套假模型：
//!
//! | 层 | 文件 | 结构 |
//! |---|---|---|
//! | 全局原生扩展 | `<agent_dir>/native-packages.json` | `Vec<InstalledNativePackage>`（rpi-cli/src/install.rs:32） |
//! | 项目包 | `<cwd>/.rpi/packages.json` | `{ "packages": [ProjectPackage] }`（rpi-cli/src/packages.rs:12/15-22） |
//!
//! 项目包登记表路径**实查上游**：`packages.rs:793` `cwd.join(".rpi").join(REGISTRY)`、
//! `:830` 同款写路径、`:864` 报错文案 `.rpi/packages.json`——不是
//! `.rpi/packages/packages.json`（后者全仓零引用；`.rpi/packages/<name>/` 是
//! 包产物目录，不是登记表目录，见 `packages.rs:207/618/872`）。
//!
//! 反序列化直接用上游类型（`rpi_cli::install::InstalledNativePackage`、
//! `rpi_cli::packages::ProjectPackage`），schema 零漂移；`ProjectPackage` 上游
//! 带 `deny_unknown_fields`，宿主与引擎对同一份文件给出同样的判断。路径权威
//! 用宿主的 `pi_paths::agent_dir()`。
//!
//! 缺文件 = 没装过（正常态，空列表）；损坏/读不了 = **Err**（规矩 12）。
//! 登记了但产物 dll 不在 → 行里 `missingArtifacts` 如实列出（列表其余部分
//! 仍可用，UI 可见），不假装装好了。
//!
//! ## 为什么 install / remove / update 仍是 Err
//!
//! rpi 的安装面是**引擎侧 CLI**：`rpi install <crate>`（预编译件下载 +
//! sha256 校验 + 产物落盘 + `native-packages.json` 事务 + resource lease）、
//! `rpi uninstall <crate>`、`rpi extension update [name]`
//! （`rpi-cli/src/args.rs:733-736` 命令面；install.rs/packages.rs 是唯一实现）。
//!
//! 宿主自行安装/卸载意味着复制这些步骤（拷 dll、改登记表、维护 lock 与
//! 审计字段），等于绕开引擎的信任边界；而 in-process 调
//! `rpi_cli::install::uninstall()` 只能拿 exit code——失败原文走
//! stdout/stderr（Tauri 应用没有控制台），IPC 里只能编造错误信息，违反
//! 规矩 12 的"失败必须可见"。所以三命令保留 Err，错误信息给出**准确命令**；
//! 不代跑外部进程（旧 pi 时代的 in-process PackageManager 通道随
//! pi_agent_rust 删除，前端也没有依赖）。
//!
//! `scope` 参数只在 Err 文案里用（`user` → `rpi install` / `rpi uninstall`；
//! `project` → `rpi package link` / `rpi package unlink`），未知值 Err——
//! 三个命令都不执行任何写入，也没有可静默采纳的默认作用域。

use std::path::{Path, PathBuf};

use rpi_cli::install::InstalledNativePackage;
use rpi_cli::packages::ProjectPackage;
use serde::{Deserialize, Serialize};

use crate::pi_paths;

/// 全局扩展库目录名（`rpi-cli/src/install.rs:450` 同值）。
const EXTENSIONS_DIR: &str = "extensions";
/// 原生扩展登记表（`rpi-cli/src/install.rs:21`）。
const NATIVE_PACKAGES_FILE: &str = "native-packages.json";
/// 项目包登记表（`rpi-cli/src/packages.rs:12` `REGISTRY`）。
const PROJECT_REGISTRY_FILE: &str = "packages.json";

/// 项目包登记表的顶层包装（上游 `PackageRegistry` 是私有的，形状照抄：
/// 只有 `packages` 一个字段，`#[serde(default)]`）。
#[derive(Debug, Default, Deserialize)]
struct ProjectPackageRegistry {
    #[serde(default)]
    packages: Vec<ProjectPackage>,
}

/// 包行。`scope`/`source` 沿用旧前端 wire 的语义（`source` 从"安装源字符串"
/// 改为"来源/出处"，可能为 null——cargo registry 构建上游不写 source）；
/// 其余字段是新世界的真实元数据。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PackageRow {
    /// `user`（全局原生扩展）/ `project`（`.rpi/packages.json`）。
    scope: &'static str,
    /// `native` / `project`——两套登记表的世界不同，UI 分开渲染。
    kind: &'static str,
    name: String,
    version: String,
    source: Option<String>,
    repository: Option<String>,
    target: Option<String>,
    abi: Option<u32>,
    /// 项目包才有（`ProjectPackage.cargo_package`）。
    cargo_package: Option<String>,
    artifacts: Vec<String>,
    /// 登记了但磁盘上不存在的产物（空数组 = 产物齐全）。
    missing_artifacts: Vec<String>,
}

fn project_registry_path(cwd: &Path) -> PathBuf {
    cwd.join(".rpi").join(PROJECT_REGISTRY_FILE)
}

/// 读全局原生扩展登记表。`Ok(None)` = 文件不存在（没装过，正常态）。
fn read_native_registry(agent_dir: &Path) -> Result<Option<Vec<InstalledNativePackage>>, String> {
    let path = agent_dir.join(NATIVE_PACKAGES_FILE);
    let data = match std::fs::read(&path) {
        Ok(data) => data,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("无法读取全局包登记表 {}：{error}", path.display())),
    };
    serde_json::from_slice::<Vec<InstalledNativePackage>>(&data)
        .map(Some)
        .map_err(|error| format!("全局包登记表损坏 {}：{error}", path.display()))
}

/// 读项目包登记表。`Ok(None)` = 文件不存在（项目里没链过包，正常态）。
fn read_project_registry(cwd: &Path) -> Result<Option<Vec<ProjectPackage>>, String> {
    let path = project_registry_path(cwd);
    let data = match std::fs::read(&path) {
        Ok(data) => data,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("无法读取项目包登记表 {}：{error}", path.display())),
    };
    serde_json::from_slice::<ProjectPackageRegistry>(&data)
        .map(|registry| Some(registry.packages))
        .map_err(|error| format!("项目包登记表损坏 {}：{error}", path.display()))
}

/// 列出一个包声明的产物里，磁盘上不存在的那些（相对 `dir`）。
fn missing_artifacts(dir: &Path, artifacts: &[String]) -> Result<Vec<String>, String> {
    let mut missing = Vec::new();
    for artifact in artifacts {
        let path = dir.join(artifact);
        match std::fs::metadata(&path) {
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                missing.push(artifact.clone());
            }
            Err(error) => {
                return Err(format!(
                    "无法读取包产物元数据 {}：{error}",
                    path.display()
                ))
            }
        }
    }
    Ok(missing)
}

fn native_rows(
    records: &[InstalledNativePackage],
    extensions_dir: &Path,
) -> Result<Vec<PackageRow>, String> {
    let mut rows = Vec::new();
    for record in records {
        let prebuilt = record.prebuilt.as_ref();
        rows.push(PackageRow {
            scope: "user",
            kind: "native",
            name: record.name.clone(),
            version: record.version.clone(),
            source: record.source.clone(),
            repository: prebuilt.map(|prebuilt| prebuilt.repository.clone()),
            target: prebuilt.map(|prebuilt| prebuilt.target.clone()),
            abi: prebuilt.map(|prebuilt| prebuilt.plugin_abi),
            cargo_package: None,
            artifacts: record.artifacts.clone(),
            missing_artifacts: missing_artifacts(extensions_dir, &record.artifacts)?,
        });
    }
    Ok(rows)
}

fn project_rows(
    packages: &[ProjectPackage],
    cwd: &Path,
) -> Result<Vec<PackageRow>, String> {
    let mut rows = Vec::new();
    for package in packages {
        // 项目包产物目录 = `<cwd>/.rpi/packages/<name>/`（packages.rs:207/618/872）。
        let dir = cwd.join(".rpi").join("packages").join(&package.name);
        rows.push(PackageRow {
            scope: "project",
            kind: "project",
            name: package.name.clone(),
            version: package.version.clone(),
            source: Some(package.source.clone()),
            repository: None,
            target: None,
            abi: None,
            cargo_package: Some(package.cargo_package.clone()),
            artifacts: package.artifacts.clone(),
            missing_artifacts: missing_artifacts(&dir, &package.artifacts)?,
        });
    }
    Ok(rows)
}

/// 已安装包列表（全局原生扩展 + 项目包，两张登记表各自投影）。
#[tauri::command(async)]
pub fn pi_pkg_list(cwd: Option<String>) -> Result<serde_json::Value, String> {
    let agent_dir = pi_paths::agent_dir()?;
    let cwd = match cwd {
        Some(value) if !value.trim().is_empty() => PathBuf::from(value.trim()),
        // 没有会话工作区 ≠ 编一个目录：用进程当前目录（旧实现同语义），
        // 拿不到就 Err。
        _ => std::env::current_dir().map_err(|error| format!("无法解析当前工作目录：{error}"))?,
    };

    let native = read_native_registry(&agent_dir)?.unwrap_or_default();
    let project = read_project_registry(&cwd)?;
    let project_present = project.is_some();

    let mut packages = native_rows(&native, &agent_dir.join(EXTENSIONS_DIR))?;
    packages.extend(project_rows(&project.unwrap_or_default(), &cwd)?);
    // 全局在前、项目在后（按 kind 排，不按 scope 字典序——"project" 会排到
    // "user" 前面），各自按名字排序（稳定输出，前端 key 不抖）。
    let kind_rank = |row: &PackageRow| match row.kind {
        "native" => 0,
        _ => 1,
    };
    packages.sort_by(|a, b| {
        kind_rank(a)
            .cmp(&kind_rank(b))
            .then_with(|| a.name.cmp(&b.name))
            .then_with(|| a.version.cmp(&b.version))
    });

    Ok(serde_json::json!({
        "packages": packages,
        "agentDir": agent_dir.display().to_string(),
        "agentRegistry": agent_dir.join(NATIVE_PACKAGES_FILE).display().to_string(),
        "projectRegistry": {
            "path": project_registry_path(&cwd).display().to_string(),
            "present": project_present,
        },
    }))
}

/// 宿主只读的边界说明（三条 Err 共用）。
const HOST_IS_READ_ONLY: &str = "宿主只读：包的安装/卸载/更新由 rpi 引擎侧 CLI 执行（预编译件下载、cargo 构建、sha256 校验、登记表事务与 resource lease 都在 rpi-cli 里，宿主不复制这些步骤、不代跑外部进程）";

fn engine_only(command: String) -> String {
    format!("{HOST_IS_READ_ONLY}；请运行 `{command}`，完成后刷新本页。")
}

/// 作用域：rpi 只有"全局原生扩展"与"项目包"两层（旧 pi 的 temporary 随
/// npm 包模型一起消失）。未知值 Err——不拿默认值糊过去。
#[derive(Clone, Copy, PartialEq, Eq)]
enum Scope {
    User,
    Project,
}

fn parse_scope(value: &str) -> Result<Scope, String> {
    match value.trim() {
        "user" => Ok(Scope::User),
        "project" => Ok(Scope::Project),
        other => Err(format!(
            "未知 scope「{other}」——rpi 只有 user（全局原生扩展）/ project（.rpi/packages.json）两个作用域"
        )),
    }
}

/// 空参数只影响提示文案的占位符，不伪造任何数据。
fn hint_arg(value: &str, placeholder: &str) -> String {
    let value = value.trim();
    if value.is_empty() {
        placeholder.to_string()
    } else {
        value.to_string()
    }
}

/// 安装包——宿主不执行（见模块文档的取舍）。
///
/// `source` 按 scope 解释：user = crate 名（`rpi install` 从 crates.io 解析
/// 预编译件）；project = 本地扩展源码目录（`rpi package link --path`）。
#[tauri::command(async)]
pub fn pi_pkg_install(
    _cwd: Option<String>,
    source: String,
    scope: String,
) -> Result<serde_json::Value, String> {
    let command = match parse_scope(&scope)? {
        Scope::User => format!("rpi install {}", hint_arg(&source, "<crate>")),
        Scope::Project => format!("rpi package link --path {}", hint_arg(&source, "<dir>")),
    };
    Err(engine_only(command))
}

/// 卸载包——宿主不执行（见模块文档的取舍）。
///
/// 两个作用域的卸载命令不同：全局 = `rpi uninstall`（删 dll + 登记表条目）；
/// 项目 = `rpi package unlink`（删 `.rpi/packages/<name>` + 登记表条目）。
#[tauri::command(async)]
pub fn pi_pkg_remove(
    _cwd: Option<String>,
    source: String,
    scope: String,
) -> Result<serde_json::Value, String> {
    let arg = hint_arg(&source, "<name>");
    let command = match parse_scope(&scope)? {
        Scope::User => format!("rpi uninstall {arg}"),
        Scope::Project => format!("rpi package unlink {arg}"),
    };
    Err(engine_only(command))
}

/// 更新包——宿主不执行（见模块文档的取舍）。
///
/// `rpi extension update [name]` 一处覆盖两层（上游 packages.rs:902：
/// "Update project and global installed extensions"）。
#[tauri::command(async)]
pub fn pi_pkg_update(
    _cwd: Option<String>,
    source: String,
    scope: String,
) -> Result<serde_json::Value, String> {
    parse_scope(&scope)?;
    Err(engine_only(format!(
        "rpi extension update {}",
        hint_arg(&source, "<name>")
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir()
                .join(format!("mirach-pkg-{tag}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).expect("create temp dir");
            Self(dir)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// 项目登记表路径是 `.rpi/packages.json`（packages.rs:793）——不是
    /// `.rpi/packages/packages.json`。锁住它，防止按目录直觉再漂一次。
    #[test]
    fn project_registry_path_matches_upstream() {
        let cwd = PathBuf::from("C:/work/project");
        assert_eq!(
            project_registry_path(&cwd),
            cwd.join(".rpi").join("packages.json")
        );
    }

    /// 上游 `ProjectPackage` 带 `deny_unknown_fields`：多一个字段宿主与引擎
    /// 同样报错（不静默吞掉拼写错误）。
    #[test]
    fn project_registry_rejects_unknown_fields() {
        let ok = br#"{"packages":[{"name":"a","version":"0.1.0","source":"path:G:/a","cargo_package":"a-ext","artifacts":["a.dll"]}]}"#;
        let registry: ProjectPackageRegistry = serde_json::from_slice(ok).unwrap();
        assert_eq!(registry.packages.len(), 1);
        assert_eq!(registry.packages[0].cargo_package, "a-ext");

        let bad = br#"{"packages":[{"name":"a","version":"0.1.0","source":"x","cargo_package":"a-ext","artifacts":[],"bogus":1}]}"#;
        assert!(serde_json::from_slice::<ProjectPackageRegistry>(bad).is_err());

        // 空文件/坏 JSON 也必须是 Err（列表命令会把它翻成可见错误）。
        assert!(serde_json::from_slice::<ProjectPackageRegistry>(b"{").is_err());
    }

    /// 全局行保留来源/ABI，并且产物缺失要如实标出（不假装装好了）。
    #[test]
    fn native_rows_report_provenance_and_missing_artifacts() {
        let temp = TempDir::new("native");
        std::fs::write(temp.0.join("rpi_todo.dll"), b"x").unwrap();
        let records = vec![InstalledNativePackage {
            name: "rpi-todo".to_string(),
            version: "0.3.4".to_string(),
            source: Some("prebuilt:https://github.com/pi-rust/rpi-package".to_string()),
            prebuilt: Some(rpi_cli::prebuilt_extensions::PrebuiltRecord {
                repository: "https://github.com/pi-rust/rpi-package".to_string(),
                target: "x86_64-pc-windows-msvc".to_string(),
                manifest_sha256: String::new(),
                source_commit: String::new(),
                sdk_version: "0.3.20".to_string(),
                plugin_abi: 4,
                archive_sha256: String::new(),
                library_sha256: String::new(),
                custom_repository: false,
                assets: Vec::new(),
            }),
            artifacts: vec!["rpi_todo.dll".to_string(), "rpi_todo_extra.dll".to_string()],
        }];

        let rows = native_rows(&records, &temp.0).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].scope, "user");
        assert_eq!(rows[0].kind, "native");
        assert_eq!(rows[0].abi, Some(4));
        assert_eq!(rows[0].missing_artifacts, vec!["rpi_todo_extra.dll"]);
        assert_eq!(rows[0].cargo_package, None);
    }

    /// 项目行：名字/版本/出处/cargo 包名都来自登记表，产物按
    /// `.rpi/packages/<name>/` 对账。
    #[test]
    fn project_rows_read_registry_and_check_package_dir() {
        let temp = TempDir::new("project");
        let pkg_dir = temp.0.join(".rpi").join("packages").join("a");
        std::fs::create_dir_all(&pkg_dir).unwrap();
        std::fs::write(pkg_dir.join("a.dll"), b"x").unwrap();
        let packages = vec![ProjectPackage {
            name: "a".to_string(),
            version: "0.1.0".to_string(),
            source: "path:G:/a".to_string(),
            cargo_package: "a-ext".to_string(),
            artifacts: vec!["a.dll".to_string(), "b.dll".to_string()],
        }];

        let rows = project_rows(&packages, &temp.0).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].scope, "project");
        assert_eq!(rows[0].kind, "project");
        assert_eq!(rows[0].source.as_deref(), Some("path:G:/a"));
        assert_eq!(rows[0].cargo_package.as_deref(), Some("a-ext"));
        assert_eq!(rows[0].missing_artifacts, vec!["b.dll"]);
    }

    /// 三命令的 Err 必须点名正确 CLI（不能让用户去点一个不存在的按钮）：
    /// 全局与项目作用域的命令不同，未知 scope 直接 Err（不默认成 user）。
    #[test]
    fn mutation_errors_name_the_engine_command() {
        let install = pi_pkg_install(None, "rpi-todo".into(), "user".into()).unwrap_err();
        assert!(install.contains("rpi install rpi-todo"));
        let install_project =
            pi_pkg_install(None, "G:/ext".into(), "project".into()).unwrap_err();
        assert!(install_project.contains("rpi package link --path G:/ext"));

        let remove = pi_pkg_remove(None, "rpi-todo".into(), "user".into()).unwrap_err();
        assert!(remove.contains("rpi uninstall rpi-todo"));
        let remove_project = pi_pkg_remove(None, "my-ext".into(), "project".into()).unwrap_err();
        assert!(remove_project.contains("rpi package unlink my-ext"));

        let update = pi_pkg_update(None, "rpi-todo".into(), "user".into()).unwrap_err();
        assert!(update.contains("rpi extension update rpi-todo"));
        assert!(update.contains("宿主只读"));

        let bogus = pi_pkg_remove(None, "rpi-todo".into(), "temporary".into()).unwrap_err();
        assert!(bogus.contains("未知 scope"));
        assert!(!bogus.contains("rpi uninstall"));
    }
}

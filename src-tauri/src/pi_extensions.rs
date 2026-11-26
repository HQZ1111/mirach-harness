//! rpi 原生扩展列表 IPC（2026-11-14 竖链回填：替换"rpi 引擎待接"降级）。
//!
//! ## 数据面：文件 + 登记表，两半都是磁盘真相
//!
//! rpi 的扩展 = Rust `cdylib` 插件（ABI v4，导出 `rpi_plugin_register`），
//! **没有**旧 pi 那种 manifest 目录（extension.json 的 id/name/version/
//! capabilities/runtime）。所以列表由两半拼成，缺一半时如实留空：
//!
//! - **文件半**：`<agent_dir>/extensions/*.dll`（用户机器上 = `~/.rpi/agent/
//!   extensions`）。`read_dir` 只扫直接子级、不递归——与 rpi 自己的启动扫描
//!   同层（`rpi-cli/src/install.rs:668` `active_global_native_package_artifacts_at`
//!   与 `:726` `unregistered_global_native_package_artifacts_at` 都是
//!   `read_dir(&agent_dir.join("extensions"))`）。
//! - **登记半**：`<agent_dir>/native-packages.json`（`rpi-cli/src/install.rs:21`
//!   `NATIVE_PACKAGES_FILE`）。条目直接反序列化成上游类型
//!   [`rpi_cli::install::InstalledNativePackage`]（`pub mod install`），schema
//!   零漂移：`name/version/source/prebuilt{repository,target,plugin_abi,…}/artifacts`。
//!   路径用环境 home（`AgentHome::root()`，配置绑定 2026-11-25——本体 =
//!   `~/.rpi/agent`；具名环境 = `<agent>/profiles/<name>`；与 `rpi-cli/src/config.rs:71`
//!   同语义：`~/.rpi/agent` + `RPI_CODING_AGENT_DIR` 绝对路径覆盖），
//!   路径权威留在宿主一侧。
//!
//! ## 为什么不加载 dll
//!
//! 加载器在引擎侧（`rpi-extensions` 的 `rpi_plugin_register` 符号解析 + ABI
//! 版本校验 + 工具/命令注册）。宿主进程里 `LoadLibrary` 一个插件会二次初始化
//! 全局状态、绕开引擎的信任与策略面，而且列表页只需要元数据。**本模块不链
//! 加载器、不解析导出表**——目录里有什么就报什么。
//!
//! ## 失败语义（规矩 12）
//!
//! - 扩展目录不存在 = **空列表**（`rpi install` 还没跑过，正常态）。
//! - 登记表缺失 = **空登记**（同上，`NativePackageRegistry::Missing` 语义）。
//! - 登记表损坏 / 读不了 = **Err**（坏元数据不能当成"没装"）。
//! - 登记了但产物文件不在 = `diagnostics` 一条（列表其余部分照常可用，
//!   坏条目在 UI 错误条可见——旧 wire 的 diagnostics 形状，前端原样显示）。
//! - 手放进目录、登记表里没有的 dll = 照实列出，`registered:false`，
//!   `version` 留空、`abi` 为 null（**未知**，不编造）。
//!
//! `cwd` 参数保留只为命令签名兼容：rpi 的扩展面只有全局一层，项目级产物是
//! `.rpi/packages/<name>/` 下的包（由 `pi_pkg_*` 面暴露），不在本命令里。

use std::path::Path;

use rpi_cli::install::InstalledNativePackage;
use serde::Serialize;

/// 全局扩展库目录名（`rpi-cli/src/install.rs:450` 同值）。
const EXTENSIONS_DIR: &str = "extensions";
/// 原生扩展登记表文件名（`rpi-cli/src/install.rs:21` 同值）。
const NATIVE_PACKAGES_FILE: &str = "native-packages.json";

/// 扩展行。前 8 个字段沿用旧 `pi_mcp::pi_extensions` 的 wire（前端
/// `PiExtensionRow` 原样消费，不因引擎换代改前端）；后面是新世界的真实元数据。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExtensionRow {
    /// 稳定键：登记名；未登记的 dll 用文件主名。
    extension_id: String,
    name: String,
    version: String,
    /// rpi 的 cdylib 扩展没有 manifest，描述不可得——空串，不编造。
    description: String,
    /// 运行时标签：`native-cdylib`（旧世界是 js / native-rust）。
    runtime: String,
    /// 入口文件绝对路径。
    entry: String,
    /// 扩展库目录。
    root: String,
    /// 清单能力：ABI 世界没有清单声明——空数组，不编造。
    capabilities: Vec<String>,
    /// 文件名（登记表的 `artifacts` 用这个名字对账）。
    file: String,
    size_bytes: u64,
    modified_ms: u64,
    /// ABI 版本（登记表 `prebuilt.plugin_abi`；老式 cargo/本地构建无 prebuilt
    /// 记录 → null）。
    abi: Option<u32>,
    repository: Option<String>,
    target: Option<String>,
    /// 安装来源（`prebuilt:…` / 本地路径；cargo registry 构建上游不写）。
    source: Option<String>,
    /// 是否在 `native-packages.json` 里有登记（false = 手工放进目录的文件）。
    registered: bool,
}

#[derive(Debug, Serialize)]
struct Diagnostic {
    path: String,
    message: String,
}

/// `rpi-cli/src/install.rs:2130` 的同一判据（上游为 pub(crate)，跨 crate 不可见，
/// 逐字照抄；`.pyd` 是上游现状）。
fn is_dynamic_library(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|extension| extension.to_str())
            .map(|extension| extension.to_ascii_lowercase())
            .as_deref(),
        Some("dll" | "so" | "dylib" | "pyd")
    )
}

/// 上游 `normalize_name`（install.rs:2104）：`-`→`_` 后小写。
fn normalize_name(name: &str) -> String {
    name.replace('-', "_").to_ascii_lowercase()
}

/// 读 `native-packages.json`。`Ok(None)` = 文件不存在（正常态）。
fn read_native_registry(agent_dir: &Path) -> Result<Option<Vec<InstalledNativePackage>>, String> {
    let path = agent_dir.join(NATIVE_PACKAGES_FILE);
    let data = match std::fs::read(&path) {
        Ok(data) => data,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(format!(
                "无法读取扩展登记表 {}：{error}",
                path.display()
            ))
        }
    };
    parse_native_registry(&data)
        .map(Some)
        .map_err(|error| format!("扩展登记表损坏 {}：{error}", path.display()))
}

/// 登记表反序列化（与上游同型：`serde_json::from_slice::<Vec<InstalledNativePackage>>`）。
fn parse_native_registry(data: &[u8]) -> Result<Vec<InstalledNativePackage>, String> {
    serde_json::from_slice::<Vec<InstalledNativePackage>>(data).map_err(|error| error.to_string())
}

/// 扫描扩展目录 → 行 + 诊断。
///
/// 目录不存在 → 空集（正常态）；`read_dir` 的其他 IO 错误 → Err。
fn scan_extensions(
    dir: &Path,
    records: &[InstalledNativePackage],
) -> Result<(Vec<ExtensionRow>, Vec<Diagnostic>), String> {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            // 没有扩展目录 = 没装过扩展（`rpi install` 才会创建它）。
            return Ok((Vec::new(), Vec::new()));
        }
        Err(error) => return Err(format!("无法读取扩展目录 {}：{error}", dir.display())),
    };

    // artifacts 文件名（小写）→ 登记条目。一个 dll 只可能属于一条记录。
    let mut by_artifact: Vec<(String, &InstalledNativePackage)> = Vec::new();
    for record in records {
        for artifact in &record.artifacts {
            by_artifact.push((artifact.to_ascii_lowercase(), record));
        }
    }

    let root = dir.display().to_string();
    let mut rows = Vec::new();
    // 对账用：命中的产物文件名（小写）与老式记录名（无 artifacts 的兼容路径）。
    let mut matched_artifacts: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut matched_legacy: std::collections::HashSet<&str> = std::collections::HashSet::new();

    for entry in entries {
        let entry = entry
            .map_err(|error| format!("无法读取扩展目录条目（{}）：{error}", dir.display()))?;
        let path = entry.path();
        if !is_dynamic_library(&path) {
            continue;
        }
        // 跟随符号链接取真实元数据（符号链接也是引擎会加载的文件）。
        let metadata = std::fs::metadata(&path)
            .map_err(|error| format!("无法读取扩展文件元数据 {}：{error}", path.display()))?;
        if !metadata.is_file() {
            continue;
        }
        let file_name = path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .ok_or_else(|| format!("扩展文件没有文件名：{}", path.display()))?;
        let stem = path
            .file_stem()
            .map(|stem| stem.to_string_lossy().into_owned())
            .unwrap_or_else(|| file_name.clone());
        let modified = metadata
            .modified()
            .map_err(|error| format!("无法读取扩展修改时间 {}：{error}", path.display()))?
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|error| format!("扩展修改时间早于 Unix 纪元 {}：{error}", path.display()))?
            .as_millis() as u64;

        // 登记匹配：先按 artifacts 文件名（当前 rpi 的写法），再按 name 归一化
        // 对文件主名（老登记没有 artifacts 的兼容路径，与上游 uninstall 的
        // legacy fallback 同语义）。
        let lower_file = file_name.to_ascii_lowercase();
        let by_artifact_hit = by_artifact
            .iter()
            .find(|(artifact, _)| artifact == &lower_file)
            .map(|(artifact, record)| (artifact.clone(), *record));
        let legacy_hit = if by_artifact_hit.is_none() {
            let wanted = normalize_name(stem.trim_start_matches("lib"));
            records.iter().find(|record| {
                record.artifacts.is_empty() && normalize_name(&record.name) == wanted
            })
        } else {
            None
        };
        let record = by_artifact_hit
            .as_ref()
            .map(|(_, record)| *record)
            .or(legacy_hit);

        match (&by_artifact_hit, legacy_hit) {
            (Some((artifact, _)), _) => {
                matched_artifacts.insert(artifact.clone());
            }
            (None, Some(record)) => {
                matched_legacy.insert(record.name.as_str());
            }
            (None, None) => {}
        }
        let prebuilt = record.and_then(|record| record.prebuilt.as_ref());
        rows.push(ExtensionRow {
            extension_id: record
                .map(|record| record.name.clone())
                .unwrap_or_else(|| stem.clone()),
            name: record
                .map(|record| record.name.clone())
                .unwrap_or_else(|| stem.clone()),
            version: record
                .map(|record| record.version.clone())
                .unwrap_or_default(),
            description: String::new(),
            runtime: "native-cdylib".to_string(),
            entry: path.display().to_string(),
            root: root.clone(),
            capabilities: Vec::new(),
            file: file_name,
            size_bytes: metadata.len(),
            modified_ms: modified,
            abi: prebuilt.map(|prebuilt| prebuilt.plugin_abi),
            repository: prebuilt.map(|prebuilt| prebuilt.repository.clone()),
            target: prebuilt.map(|prebuilt| prebuilt.target.clone()),
            source: record.and_then(|record| record.source.clone()),
            registered: record.is_some(),
        });
    }

    // 登记了但文件不在：安装状态与磁盘不一致，必须可见（规矩 12）。
    let mut diagnostics = Vec::new();
    for record in records {
        if record.artifacts.is_empty() {
            // 老式记录没有产物清单，只能按名字判断（上游 uninstall 同语义）。
            if !matched_legacy.contains(record.name.as_str()) {
                diagnostics.push(Diagnostic {
                    path: dir.display().to_string(),
                    message: format!(
                        "登记表记录了扩展 `{}`（老式记录，无产物清单），但扩展目录里找不到对应库",
                        record.name
                    ),
                });
            }
            continue;
        }
        for artifact in &record.artifacts {
            if matched_artifacts.contains(&artifact.to_ascii_lowercase()) {
                continue;
            }
            let path = dir.join(artifact);
            match std::fs::metadata(&path) {
                // 文件在但不被扫描收进列表（例如被过滤掉的非常规文件）——
                // 不是"缺失"，不报假诊断。
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    diagnostics.push(Diagnostic {
                        path: path.display().to_string(),
                        message: format!(
                            "登记表声明了扩展 `{}` 的产物，但扩展目录里没有这个文件",
                            record.name
                        ),
                    });
                }
                Err(error) => {
                    return Err(format!(
                        "无法读取扩展文件元数据 {}：{error}",
                        path.display()
                    ))
                }
            }
        }
    }

    rows.sort_by(|a, b| a.name.cmp(&b.name).then_with(|| a.file.cmp(&b.file)));
    Ok((rows, diagnostics))
}

/// 扩展列表（只读投影：文件 + 登记表，不含加载动作）。目录按**活动环境
/// home** 解析（配置绑定 2026-11-25：切 bot 后列表 = 该环境自己的
/// `<home>/extensions`，与引擎给该环境会话装载的扩展同源）。
#[tauri::command(async)]
pub fn pi_extensions(
    state: tauri::State<'_, std::sync::Arc<crate::agui::AguiState>>,
    _cwd: Option<String>,
) -> Result<serde_json::Value, String> {
    let profile = state.engine.active_profile()?;
    // 读面顺带补种 skills/extensions（同 pi_capabilities）：具名环境第一次
    // 打开时从本体克隆缺失的原生扩展，插件目录不会平白是空的。
    crate::pi_profiles::ensure_profile_dirs(profile.as_deref())?;
    let home = crate::pi_profiles::home_for_profile(profile.as_deref())?;
    let agent_dir = home
        .root()
        .map_err(|e| format!("环境 home 解析失败: {e}"))?;
    let dir = agent_dir.join(EXTENSIONS_DIR);
    let records = read_native_registry(&agent_dir)?.unwrap_or_default();
    let (extensions, diagnostics) = scan_extensions(&dir, &records)?;
    Ok(serde_json::json!({
        "extensions": extensions,
        "diagnostics": diagnostics,
        "dir": dir.display().to_string(),
        "registry": agent_dir.join(NATIVE_PACKAGES_FILE).display().to_string(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir()
                .join(format!("mirach-ext-{tag}-{}", std::process::id()));
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

    fn record(name: &str, version: &str, artifact: &str, abi: u32) -> InstalledNativePackage {
        InstalledNativePackage {
            name: name.to_string(),
            version: version.to_string(),
            source: Some("prebuilt:https://github.com/pi-rust/rpi-package".to_string()),
            prebuilt: Some(rpi_cli::prebuilt_extensions::PrebuiltRecord {
                repository: "https://github.com/pi-rust/rpi-package".to_string(),
                target: "x86_64-pc-windows-msvc".to_string(),
                manifest_sha256: String::new(),
                source_commit: String::new(),
                sdk_version: "0.3.20".to_string(),
                plugin_abi: abi,
                archive_sha256: String::new(),
                library_sha256: String::new(),
                custom_repository: false,
                assets: Vec::new(),
            }),
            artifacts: vec![artifact.to_string()],
        }
    }

    /// 未登记的手放 dll：照实列出，但 version 必须空、abi 必须 None——
    /// 不能拿文件名冒充版本号。
    #[test]
    fn unregistered_library_is_listed_without_invented_metadata() {
        let temp = TempDir::new("unregistered");
        let payload = b"not a real dll";
        std::fs::write(temp.0.join("my_plugin.dll"), payload).unwrap();

        let (rows, diagnostics) = scan_extensions(&temp.0, &[]).unwrap();
        assert!(diagnostics.is_empty());
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].name, "my_plugin");
        assert_eq!(rows[0].extension_id, "my_plugin");
        assert!(rows[0].version.is_empty());
        assert_eq!(rows[0].abi, None);
        assert!(!rows[0].registered);
        assert_eq!(rows[0].size_bytes, payload.len() as u64);
    }

    /// 登记条目合入 name/version/abi/来源：artifacts 文件名对账（大小写不敏感，
    /// 与 Windows 文件系统一致）。
    #[test]
    fn registered_artifact_merges_registry_metadata() {
        let temp = TempDir::new("registered");
        std::fs::write(temp.0.join("rpi_todo.dll"), b"x").unwrap();
        let records = vec![record("rpi-todo", "0.3.4", "RPI_TODO.DLL", 4)];

        let (rows, diagnostics) = scan_extensions(&temp.0, &records).unwrap();
        assert!(diagnostics.is_empty());
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].name, "rpi-todo");
        assert_eq!(rows[0].extension_id, "rpi-todo");
        assert_eq!(rows[0].version, "0.3.4");
        assert_eq!(rows[0].abi, Some(4));
        assert_eq!(
            rows[0].repository.as_deref(),
            Some("https://github.com/pi-rust/rpi-package")
        );
        assert!(rows[0].registered);
    }

    /// 登记了但文件丢了 → diagnostics 一条（可见），列表不因此失败。
    #[test]
    fn missing_registered_artifact_is_a_diagnostic() {
        let temp = TempDir::new("missing");
        let records = vec![record("rpi-todo", "0.3.4", "rpi_todo.dll", 4)];

        let (rows, diagnostics) = scan_extensions(&temp.0, &records).unwrap();
        assert!(rows.is_empty());
        assert_eq!(diagnostics.len(), 1);
        assert!(diagnostics[0].path.ends_with("rpi_todo.dll"));
        assert!(diagnostics[0].message.contains("rpi-todo"));
    }

    /// 非动态库文件（json/txt）不进列表。
    #[test]
    fn non_library_files_are_ignored() {
        let temp = TempDir::new("nonlib");
        std::fs::write(temp.0.join("notes.txt"), b"x").unwrap();
        std::fs::write(temp.0.join("runtime-assets.json"), b"{}").unwrap();

        let (rows, diagnostics) = scan_extensions(&temp.0, &[]).unwrap();
        assert!(rows.is_empty());
        assert!(diagnostics.is_empty());
    }

    /// 目录不存在 = 空列表，不是错误（正常态）。
    #[test]
    fn absent_directory_is_an_empty_list() {
        let temp = TempDir::new("absent");
        let (rows, diagnostics) = scan_extensions(&temp.0.join("extensions"), &[]).unwrap();
        assert!(rows.is_empty());
        assert!(diagnostics.is_empty());
    }

    /// 登记表坏了必须报错（不能当成"没装"）——同时锁住上游 schema 兼容：
    /// 真实登记表形状（prebuilt + artifacts）能解析。
    #[test]
    fn registry_parsing_is_strict_and_schema_compatible() {
        assert!(parse_native_registry(b"{ not json").is_err());
        assert!(parse_native_registry(br#"{"name":"rpi-todo"}"#).is_err());

        let data = br#"[{"name":"rpi-todo","version":"0.3.4","source":"prebuilt:https://x","prebuilt":{"repository":"https://x","target":"x86_64-pc-windows-msvc","manifest_sha256":"","source_commit":"","sdk_version":"0.3.20","plugin_abi":4,"archive_sha256":"","library_sha256":"","custom_repository":false},"artifacts":["rpi_todo.dll"]}]"#;
        let records = parse_native_registry(data).expect("upstream schema");
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].version, "0.3.4");
        assert_eq!(records[0].prebuilt.as_ref().map(|p| p.plugin_abi), Some(4));
    }

    /// 老登记没有 artifacts：按 name 归一化对文件主名合入（上游 uninstall 的
    /// legacy fallback 同语义），不能把 `rpi-todo` 认成未登记。
    #[test]
    fn legacy_record_without_artifacts_matches_by_name() {
        let temp = TempDir::new("legacy");
        std::fs::write(temp.0.join("RPI_TODO.dll"), b"x").unwrap();
        let mut legacy = record("rpi-todo", "0.2.0", "unused.dll", 4);
        legacy.artifacts.clear();

        let (rows, _) = scan_extensions(&temp.0, &[legacy]).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].name, "rpi-todo");
        assert_eq!(rows[0].version, "0.2.0");
        assert!(rows[0].registered);
    }
}

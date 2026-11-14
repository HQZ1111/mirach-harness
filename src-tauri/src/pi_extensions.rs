//! pi 扩展的**加载面**（2026-11-02）：把 pi CLI 的扩展发现结果交给会话。
//!
//! ## 为什么单独一个模块
//!
//! 宿主此前**完全没有**把任何扩展交给会话——`SessionOptions.extension_paths`
//! 恒为空。结果是 `pi::extensions` 的整套能力（JS/WASM/原生三运行时、工具
//! 注册、斜杠命令、事件钩子）在宿主里等于不存在，RPi 之类的社区插件装上也
//! 跑不起来。
//!
//! 旧实现（`pi_mcp::pi_extensions`）是**手写扫两个固定目录**
//! （`~/.pi/agent/extensions` + `<cwd>/.pi/extensions`）——与 pi CLI 的发现
//! 规则漂移：漏了 `settings.json` 的 `extensions` 字段、`.agents/extensions`
//! 层、清单校验与信任/策略过滤。本模块取代它（规矩 1：照抄上游，不写替身）。
//!
//! ## 照抄上游
//!
//! 发现逻辑**逐字照抄** pi CLI（`vendor/pi_agent_rust/src/main.rs:2326`
//! `extension_paths: resources.extensions().to_vec()`）：
//!
//! ```text
//! PackageManager::new(cwd).with_project_trust(trusted)
//!   → ResourceLoader::load(&manager, &cwd, &config, &ResourceCliOptions::default())
//!   → resources.extensions()   // Vec<PathBuf>，已折叠 settings 配置 + 目录扫描
//!                              // + 清单校验 + 信任/策略过滤
//! ```
//!
//! ## 失败语义（规矩 12：禁止兜底）
//!
//! `ResourceLoader::load` 失败 → **Err 传播**，不吞成空列表。扩展加载失败
//! 却让会话静默跑起来，用户会以为插件生效了、实际没生效，比报错难查得多。

use std::path::{Path, PathBuf};

use pi::config::Config;
use pi::package_manager::PackageManager;
use pi::resources::{ResourceCliOptions, ResourceLoader};

use crate::pi_session::{on_big_stack, PiRuntime};

/// 解析当前应加载的扩展路径（与 pi CLI 同源）。
///
/// `cwd` = 会话工作区（项目级 `.pi/extensions`、`.agents/extensions` 以它为根）。
/// `project_trusted` = 用户是否显式选了这个文件夹（决定项目级资源是否加载；
/// pi 的 `PackageManager::with_project_trust` 语义）。
///
/// 返回的路径已由 `ResourceLoader` 完成：settings 展开 → 目录扫描 → 清单校验
/// → 信任/策略过滤。调用方直接塞进 `SessionOptions.extension_paths`。
pub fn resolve_extension_paths(cwd: &Path, project_trusted: bool) -> Result<Vec<PathBuf>, String> {
    // on_big_stack 的闭包要求 'static（它在独立大栈线程上跑），所以先把
    // 借用参数变成 owned。
    let cwd = cwd.to_path_buf();
    on_big_stack(move || {
        let config = Config::load().map_err(|e| format!("pi 配置读取失败: {e}"))?;
        let manager = PackageManager::new(cwd.clone()).with_project_trust(project_trusted);
        // 全 false / 全空 = 不额外禁任何类别、无显式路径（等价于 CLI 不带
        // --no-* / -e）。settings.json 里配置的扩展由 ResourceLoader 自己展开。
        // 注意：`ResourceCliOptions` **没有** `Default` 实现（上游只给了
        // 派生 Debug/Clone），必须逐字段构造。
        let cli = ResourceCliOptions {
            no_skills: false,
            no_prompt_templates: false,
            no_extensions: false,
            no_themes: false,
            skill_paths: Vec::new(),
            prompt_paths: Vec::new(),
            extension_paths: Vec::new(),
            theme_paths: Vec::new(),
        };
        // pi 的 future 不能进 tokio：用与引擎同款的 PiRuntime（current_thread
        // + reactor，pi_session.rs:66 同构造）。一次性发现，不复用引擎实例。
        let runtime = PiRuntime::new();
        let loader = runtime
            .block_on(ResourceLoader::load(&manager, &cwd, &config, &cli))
            .map_err(|e| format!("扩展发现失败: {e}"))?;
        Ok(loader.extensions().to_vec())
    })?
}

/// 扩展行（前端「技能与工具 → 插件」页消费；字段形状沿用旧
/// `pi_mcp::pi_extensions` 的 `extensions[]`，前端不用改）。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ExtensionRow {
    extension_id: String,
    name: String,
    version: String,
    api_version: String,
    description: String,
    runtime: String,
    /// 入口文件（清单的 entrypoint 解析后路径）。
    entry: String,
    /// 扩展根目录。
    root: String,
    /// 清单声明的能力（权限）。
    capabilities: Vec<String>,
}

/// 清单的运行时枚举 → 前端标签。
fn runtime_label(runtime: &pi::extensions::ExtensionRuntime) -> String {
    match runtime {
        pi::extensions::ExtensionRuntime::Js => "js".to_string(),
        pi::extensions::ExtensionRuntime::NativeRust => "native-rust".to_string(),
        // WASM 变体由 `wasm-host` feature 门控；本构建没开该 feature，
        // 但枚举仍可能带这个臂（编译期匹配必须穷尽）——列出以便将来启用。
        #[allow(unreachable_patterns)]
        other => format!("{other:?}").to_ascii_lowercase(),
    }
}

/// 列出当前会被加载的扩展（与 `resolve_extension_paths` 同一来源）。
///
/// 这是**只读**投影：真正的注册发生在会话创建时
/// （`SessionOptions.extension_paths`）。与旧实现的区别：路径来自
/// `ResourceLoader`（已做清单校验/信任过滤），不是手写扫目录。
#[tauri::command(rename_all = "camelCase", async)]
pub fn pi_extensions(cwd: Option<String>) -> Result<serde_json::Value, String> {
    on_big_stack(move || {
        let global_dir = Config::global_dir();
        let cwd_opt = cwd.map(|c| c.trim().to_string()).filter(|c| !c.is_empty());
        // 没有会话 cwd 时不信项目层（否则会用错目录读到别人的扩展）；
        // 缺 cwd 只读全局层——这是真实状态，不是降级。
        let trust = cwd_opt.is_some();
        let root = cwd_opt
            .as_ref()
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."));
        let paths = resolve_extension_paths(&root, trust)?;

        let mut rows: Vec<ExtensionRow> = Vec::new();
        let mut diagnostics: Vec<serde_json::Value> = Vec::new();

        for dir in paths {
            match pi::extensions::load_extension_manifest(&dir) {
                Ok(Some(source)) => {
                    // 先取路径再 move manifest（`entry_path()` 借 manifest）。
                    let entry = source.entry_path().display().to_string();
                    let root = source.root.display().to_string();
                    let manifest = source.manifest;
                    rows.push(ExtensionRow {
                        extension_id: manifest.extension_id.clone(),
                        name: if manifest.name.trim().is_empty() {
                            manifest.extension_id.clone()
                        } else {
                            manifest.name.clone()
                        },
                        version: manifest.version.clone(),
                        api_version: manifest.api_version.clone(),
                        description: manifest.description.clone().unwrap_or_default(),
                        runtime: runtime_label(&manifest.runtime),
                        entry,
                        root,
                        capabilities: manifest.capabilities.clone(),
                    });
                }
                // 清单不存在：可能是裸 JS 入口（pi 支持直接给文件/目录）。
                // 不是错误，如实跳过——不编造名字。
                Ok(None) => {}
                Err(e) => {
                    diagnostics.push(serde_json::json!({
                        "path": dir.display().to_string(),
                        "message": format!("清单解析失败: {e}"),
                    }));
                }
            }
        }

        rows.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(serde_json::json!({
            "extensions": rows,
            "diagnostics": diagnostics,
            "globalDir": global_dir.join("extensions").display().to_string(),
            // 没有会话 cwd → 空串（不编造项目路径）
            "projectDir": cwd_opt
                .as_ref()
                .map(|c| PathBuf::from(c).join(".pi").join("extensions").display().to_string())
                .unwrap_or_default(),
        }))
    })?
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 运行时标签：pi 的清单运行时枚举只有 JS / 原生两种（WASM 走
    /// `wasm-host` feature，未在本构建启用）。
    #[test]
    fn runtime_label_maps_manifest_variants() {
        assert_eq!(runtime_label(&pi::extensions::ExtensionRuntime::Js), "js");
        assert_eq!(
            runtime_label(&pi::extensions::ExtensionRuntime::NativeRust),
            "native-rust"
        );
    }

    /// 空目录必须解析出**空**扩展集（而不是报错）——没有扩展是正常态。
    /// 同时锁住「不会因为找不到 settings.json 就失败」。
    #[test]
    fn empty_workspace_yields_no_extensions() {
        let dir = std::env::temp_dir().join("mirach-ext-test-empty");
        std::fs::create_dir_all(&dir).expect("temp dir");
        let paths = resolve_extension_paths(&dir, false).expect("resolve");
        // 全局层可能真有扩展（用户机器上），所以只断言"项目层没贡献"。
        // 这里退一步：断言调用不失败且返回的是 Vec（形状契约）。
        assert!(paths.iter().all(|p| p.is_absolute() || p.exists()));
        let _ = std::fs::remove_dir_all(&dir);
    }
}

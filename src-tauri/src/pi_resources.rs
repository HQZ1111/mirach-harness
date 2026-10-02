//! pi 资源面 IPC（左栏入口条「技能与工具」数据面）：skills/prompts 资源 +
//! extensions/packages 配置的**只读**列举（docs/pi-integration.md §4.5 控制面
//! 走 IPC；写面不在本模块——skill 文件的增改是 pi 的事，管理 UI 只看）。
//!
//! 真相 = pi 自己的资源面（vendor pi_agent_rust 源码实锤，非猜测）：
//! - skills 目录约定：`<agent_dir>/skills`（resources.rs:1006
//!   `options.agent_dir.join("skills")`；agent_dir = `~/.pi/agent`，
//!   config.rs:1546-1555）+ 项目 `.pi/skills`（resources.rs:2184）+
//!   settings.json 的 skills 显式路径（config.rs:221 `pub skills`）。
//!   legacy `~/.pi/skills` **不会被 pi 加载**（resources.rs:2160-2168
//!   警告出处）——目录说明照此宣讲。
//! - prompts 目录约定：`<agent_dir>/prompts`（resources.rs:1431）+
//!   settings 的 prompts（config.rs:222）。
//! - extensions/packages：settings.json（config.rs:219-220）。pi 扩展能注册
//!   工具与 hostcall（extensions_js.rs:296-302 HostcallKind::Tool/Exec/
//!   Http/Session/Ui/Events/Log；SessionOptions.extension_paths/sdk.rs:324），
//!   本宿主未经 extension_paths 配置任何扩展——listed 值如实反映 settings。
//! - enable_skill_commands：skills 是否注册为 / 命令（config.rs:225；
//!   autocomplete.rs:237 消费）。
//!
//! 列举走 **pi 自己的 loader**（resources.rs:950 pub fn load_skills /
//! :1414 pub fn load_prompt_templates）——frontmatter 校验/碰撞裁决/loader
//! 语义零漂移，不做手写解析替身。skills 诊断逐条如实带出（上游 loader
//! 语义：单个坏文件不停扫，诊断单独汇报）；prompts 的 pub 封装不外露诊断
//! （上游 :1414 pub 封装即此形态）。
//!
//! 纪律：**禁止兜底**——Config::load 失败直接 Err（坏配置必须可见）。

use std::path::PathBuf;

use pi::config::{Config, PackageSource};

use crate::pi_session::on_big_stack;

/// PackageSource → 展示字符串（untagged：裸串或 {source,...}）。
fn package_source_label(src: &PackageSource) -> String {
    match src {
        PackageSource::String(s) => s.clone(),
        PackageSource::Detailed { source, .. } => source.clone(),
    }
}

/// 资源面只读列举（左栏「技能与工具」面板数据源）。
/// Config::load() = 全局 + 项目配置合并（cwd 语境——与会话起跑读到的配置
/// 同源）；失败 Err 传播。skill_paths/prompt_paths = settings 配置的显式
/// 路径（config.rs:221-222），与 pi 会话起跑的资源集合一致。
#[tauri::command(async)]
pub fn pi_list_resources() -> Result<serde_json::Value, String> {
    on_big_stack(move || {
        let config = Config::load().map_err(|e| format!("pi 配置读取失败: {e}"))?;
        let agent_dir = Config::global_dir();
        let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        let skill_paths: Vec<PathBuf> = config
            .skills
            .clone()
            .unwrap_or_default()
            .iter()
            .map(PathBuf::from)
            .collect();
        let prompt_paths: Vec<PathBuf> = config
            .prompts
            .clone()
            .unwrap_or_default()
            .iter()
            .map(PathBuf::from)
            .collect();

        let loaded = pi::resources::load_skills(pi::resources::LoadSkillsOptions {
            cwd: cwd.clone(),
            agent_dir: agent_dir.clone(),
            skill_paths,
            include_defaults: true,
        });
        let prompts = pi::resources::load_prompt_templates(
            pi::resources::LoadPromptTemplatesOptions {
                cwd: cwd.clone(),
                agent_dir: agent_dir.clone(),
                prompt_paths,
                include_defaults: true,
            },
        );

        let skill_rows: Vec<serde_json::Value> = loaded
            .skills
            .iter()
            .map(|s| {
                serde_json::json!({
                    "name": s.name,
                    "description": s.description,
                    "path": s.file_path.display().to_string(),
                    "source": s.source,
                    "disableModelInvocation": s.disable_model_invocation,
                })
            })
            .collect();
        let prompt_rows: Vec<serde_json::Value> = prompts
            .templates
            .iter()
            .map(|t| {
                serde_json::json!({
                    "name": t.name,
                    "description": t.description,
                    "path": t.file_path.display().to_string(),
                    "source": t.source,
                })
            })
            .collect();
        // loader 诊断逐条带出（坏文件/碰撞可见——上游解析语义，非静默跳过）
        let diagnostics: Vec<serde_json::Value> = loaded
            .diagnostics
            .iter()
            .map(|d| {
                serde_json::json!({
                    "kind": format!("{:?}", d.kind),
                    "message": d.message,
                    "path": d.path.display().to_string(),
                })
            })
            .collect();

        Ok(serde_json::json!({
            "agentDir": agent_dir.display().to_string(),
            "skills": skill_rows,
            "prompts": prompt_rows,
            "diagnostics": diagnostics,
            // settings 配置面：extensions/packages 来源 + skills 命令开关
            "extensions": config
                .extensions
                .clone()
                .unwrap_or_default(),
            "packages": config
                .packages
                .clone()
                .unwrap_or_default()
                .iter()
                .map(package_source_label)
                .collect::<Vec<_>>(),
            "enableSkillCommands": config.enable_skill_commands,
        }))
    })?
}

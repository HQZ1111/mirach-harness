//! rpi 资源面 IPC（skills/prompts 资源的**只读**列举——左栏入口条
//! 「技能与工具」数据面的旧 accompaniment）。
//!
//! 真相 = rpi 自己的资源面（rpi-harness 源码，非猜测）：
//! - skills 目录约定：`<agent_dir>/skills`（= `~/.rpi/agent/skills`）+
//!   项目 `.rpi/skills`（pi_capabilities.rs 的 skill_dirs 同源）。
//!   legacy `~/.pi/skills` **不会被 rpi 加载**——目录说明照此宣讲。
//! - prompts 目录约定：`<agent_dir>/prompts`（rpi-harness
//!   prompt_templates.rs 的 loader 语义：目录取直接子级 `.md` 不递归）。
//! - 旧 pi settings.json 的 extensions/packages/enableSkillCommands 字段
//!   **rpi schema 里没有**（rpi 的扩展面 = cdylib 插件 ABI，无 settings
//!   路径清单）——如实去掉，不再伪造空列表。
//!
//! 列举走 **rpi 自己的 loader**（`skills::load_skills` /
//! `prompt_templates::load_prompt_templates`）——frontmatter 校验/碰撞
//! 裁决/loader 语义零漂移，不做手写解析替身。诊断逐条如实带出（上游
//! loader 语义：单个坏文件不停扫，诊断单独汇报）。
//!
//! 纪律：**禁止兜底**——路径解析失败直接 Err（坏配置必须可见）。

use std::path::PathBuf;
use std::sync::Arc;

use rpi_harness::prompt_templates;
use rpi_harness::skills;
use rpi_tools::os_env::OsExecutionEnv;

use crate::pi_paths;
use crate::pi_session::{list_runtime, on_big_stack};

/// 资源装载所需的 ExecutionEnv（rpi-harness loader 的 env 参数）。
fn resources_env() -> Arc<dyn rpi_tools::ExecutionEnv> {
    Arc::new(OsExecutionEnv::with_cwd(std::env::current_dir().unwrap_or_else(
        |_| PathBuf::from("."),
    )))
}

/// 资源面只读列举。
#[tauri::command(async)]
pub fn pi_list_resources() -> Result<serde_json::Value, String> {
    on_big_stack(move || {
        let agent_dir = pi_paths::agent_dir()?;
        let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        let env = resources_env();
        let skill_dirs = vec![
            cwd.join(".rpi")
                .join("skills")
                .to_string_lossy()
                .to_string(),
            agent_dir
                .join("skills")
                .to_string_lossy()
                .to_string(),
        ];
        let prompt_dirs = vec![agent_dir
            .join("prompts")
            .to_string_lossy()
            .to_string()];

        let (loaded, prompts) = list_runtime().block_on(async {
            let s = skills::load_skills(&env, &skill_dirs).await;
            let p = prompt_templates::load_prompt_templates(&env, &prompt_dirs).await;
            (s, p)
        });

        let skill_rows: Vec<serde_json::Value> = loaded
            .skills
            .iter()
            .map(|s| {
                // rpi Skill 无 source 字段——source 从 file_path 推导
                // （pi_capabilities.rs 的 skill_rows 同款约定）。
                let source = if s.file_path.contains(".rpi") { "global" } else { "project" };
                serde_json::json!({
                    "name": s.name,
                    "description": s.description,
                    "path": s.file_path,
                    "source": source,
                    "disableModelInvocation": s.disable_model_invocation,
                })
            })
            .collect();
        let prompt_rows: Vec<serde_json::Value> = prompts
            .prompt_templates
            .iter()
            .map(|t| {
                serde_json::json!({
                    "name": t.name,
                    "description": t.description,
                })
            })
            .collect();
        // loader 诊断逐条带出（坏文件/碰撞可见——上游解析语义，非静默跳过）
        let diagnostics: Vec<serde_json::Value> = loaded
            .diagnostics
            .iter()
            .map(|d| {
                serde_json::json!({
                    "kind": d.code.as_str(),
                    "message": d.message.clone(),
                    "path": d.path.clone(),
                })
            })
            .chain(prompts.diagnostics.iter().map(|d| {
                serde_json::json!({
                    "kind": d.code.as_str(),
                    "message": d.message.clone(),
                    "path": d.path.clone(),
                })
            }))
            .collect();

        Ok(serde_json::json!({
            "agentDir": agent_dir.display().to_string(),
            "skills": skill_rows,
            "prompts": prompt_rows,
            "diagnostics": diagnostics,
        }))
    })?
}

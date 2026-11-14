//! MCP 服务器与扩展的**管理面**（左栏「技能与工具」页的连接器 / 插件 tab）。
//!
//! ## 先查事实（2026-10-27 用户纠正："引擎侧有插件系统和 mcp 啊"）
//!
//! 我之前只看了 `pi_capabilities.rs` 就写下"宿主暂无插件系统 / 连接器后端"，
//! 那是错的。pi **有**：
//!
//! - **MCP**：`pi::mcp::config::McpDiscovery::discover`（分层读 `.pi/mcp.json`
//!   / `.agents/mcp.json` / `~/.pi/agent/mcp.json` / 外来文件）、
//!   `pi::mcp::McpManager`（`list` / `trust` / `deny` / `test` /
//!   `mounted_tool_metas`）、`mcp::config::write_project_config`（写回）。
//!   宿主会话侧**已经在用**：`pi_session.rs` 每轮调
//!   `handle.sync_extension_mcp_registrations()`。
//! - **扩展**：`pi::extensions`（JS / WASM / 原生三运行时 + 清单 +
//!   权限策略 + 工具 / 斜杠命令 / 事件钩子），`load_extension_manifest`
//!   读清单，`ExtensionManager` 注册与派发。宿主会话侧**已经在用**：
//!   `SessionOptions.extension_ui_handler` 接了 `HostUiBridge`。
//!
//! 所以这两个 tab 不是"没有后端"，是**缺管理 UI**。本文件补上数据面：
//! 读配置、增删改服务器、测试连通、列出扩展清单。
//!
//! ## 纪律
//!
//! - 一律不吞错：读配置的 warning 如实透出（不静默丢弃畸形条目）。
//! - 写回走 pi 自己的 `write_project_config`（read-modify-write，保留无关内容）。
//! - 信任决策（`trust`/`deny`）由 pi 的 `McpManager` 落盘，宿主不自己发明。

use std::path::{Path, PathBuf};

use pi::config::Config;
use serde::Serialize;

use crate::pi_session::on_big_stack;

/// 一个 MCP 服务器（`ConfiguredServer` 的前端投影）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerRow {
    name: String,
    /// stdio 传输的启动命令。
    command: Option<String>,
    args: Vec<String>,
    /// HTTP 传输的端点。
    url: Option<String>,
    /// `stdio` / `http` / `sse`（配置显式声明，或由 url 推断）。
    transport: String,
    /// 定义来源：`cli` / `project-pi` / `project-agents` / `global-pi` / `foreign`。
    provenance: String,
    source_file: String,
    /// 环境变量键（值可能是 `$ENV:` / `$CMD:` 引用，不回显明文）。
    env_keys: Vec<String>,
}

/// 配置加载的一条非致命问题（畸形条目/文件）——如实透出，不吞。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpConfigWarning {
    source_file: String,
    entry: String,
    reason: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpSnapshot {
    servers: Vec<McpServerRow>,
    warnings: Vec<McpConfigWarning>,
    /// 全局配置落点（`~/.pi/agent/mcp.json`）——UI 的"在这里编辑"提示用。
    global_config: String,
    /// 项目配置落点（`<cwd>/.pi/mcp.json`）。
    project_config: String,
}

fn transport_of(server: &pi::mcp::config::ConfiguredServer) -> String {
    if let Some(hint) = server.transport_hint.as_deref() {
        return hint.to_string();
    }
    if server.url.is_some() {
        return "http".to_string();
    }
    "stdio".to_string()
}

/// 读 MCP 配置（分层合并，与 pi 自己的发现顺序一致）。
///
/// `cwd` = 活动会话的工作区（项目级 `.pi/mcp.json` 以它为根）。
/// `project_trusted` = 是否信任项目级配置——**由调用方显式给**（pi 的
/// `discover` 把这个决策做成必填参数，宿主不替用户猜）。
///
/// **cwd 缺失时不回落到进程 cwd**：进程 cwd 是 `src-tauri/`（tauri dev 的
/// 工作目录），会把项目配置指到错误的地方。缺 cwd 就只读全局层——这是
/// 真实状态（没有会话 = 没有项目上下文），不是降级。
#[tauri::command(rename_all = "camelCase", async)]
pub fn pi_mcp_servers(cwd: Option<String>, project_trusted: bool) -> Result<McpSnapshot, String> {
    on_big_stack(move || {
        let global_dir = Config::global_dir();
        let cwd_opt = cwd
            .map(|c| c.trim().to_string())
            .filter(|c| !c.is_empty());
        let cwd = cwd_opt
            .as_ref()
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."));
        // 没有会话 cwd 时不信项目层（否则会用错目录读到别人的配置）
        let trust_project = project_trusted && cwd_opt.is_some();

        let discovery = pi::mcp::config::discover(&cwd, &global_dir, &[], trust_project);

        let servers: Vec<McpServerRow> = discovery
            .servers
            .iter()
            .map(|server| McpServerRow {
                name: server.name.clone(),
                command: server.command.clone(),
                args: server.args.clone(),
                url: server.url.clone(),
                transport: transport_of(server),
                provenance: server.provenance.label().to_string(),
                source_file: server.source_file.display().to_string(),
                // 只回键名：值是 `$ENV:`/`$CMD:` 引用或密钥，不回显。
                env_keys: server.env.iter().map(|(k, _)| k.clone()).collect(),
            })
            .collect();

        let warnings: Vec<McpConfigWarning> = discovery
            .warnings
            .iter()
            .map(|w| McpConfigWarning {
                source_file: w.source_file.display().to_string(),
                entry: w.entry.clone(),
                reason: w.reason.clone(),
            })
            .collect();

        Ok(McpSnapshot {
            servers,
            warnings,
            global_config: global_dir.join("mcp.json").display().to_string(),
            // 没有会话 cwd → 不编造一个项目路径
            project_config: cwd_opt
                .as_ref()
                .map(|c| PathBuf::from(c).join(".pi").join("mcp.json").display().to_string())
                .unwrap_or_default(),
        })
    })?
}

/// 写一个 MCP 服务器到**项目**配置（`.pi/mcp.json`），read-modify-write。
///
/// `spec` = 单个服务器的 JSON 对象（`{command, args, env}` 或 `{url, headers}`），
/// 形状与 pi 的 `mcpServers.<name>` 条目一致。
#[tauri::command(rename_all = "camelCase", async)]
pub fn pi_mcp_upsert_server(
    cwd: String,
    name: String,
    spec: serde_json::Value,
) -> Result<(), String> {
    on_big_stack(move || {
        let trimmed_name = name.trim();
        if trimmed_name.is_empty() {
            return Err("服务器名为空".to_string());
        }
        if !spec.is_object() {
            return Err("服务器定义必须是 JSON 对象".to_string());
        }
        let cwd_path = PathBuf::from(cwd.trim());
        let path = cwd_path.join(".pi").join("mcp.json");

        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("MCP 配置目录创建失败 {}: {e}", parent.display()))?;
        }

        let mut doc = pi::mcp::config::read_project_config(&path)
            .map_err(|e| format!("MCP 配置读取失败 {}: {e}", path.display()))?;

        // 顶层是 `{ "mcpServers": { ... } }`；缺失就建。
        let root = doc
            .as_object_mut()
            .ok_or_else(|| "MCP 配置顶层不是对象".to_string())?;
        let servers = root
            .entry("mcpServers".to_string())
            .or_insert_with(|| serde_json::json!({}));
        let map = servers
            .as_object_mut()
            .ok_or_else(|| "MCP 配置的 mcpServers 不是对象".to_string())?;
        map.insert(trimmed_name.to_string(), spec);

        pi::mcp::config::write_project_config(&path, &doc)
            .map_err(|e| format!("MCP 配置写入失败 {}: {e}", path.display()))
    })?
}

/// 从**项目**配置删一个 MCP 服务器。
#[tauri::command(rename_all = "camelCase", async)]
pub fn pi_mcp_remove_server(cwd: String, name: String) -> Result<bool, String> {
    on_big_stack(move || {
        let path = PathBuf::from(cwd.trim()).join(".pi").join("mcp.json");
        if !path.exists() {
            return Ok(false);
        }
        let mut doc = pi::mcp::config::read_project_config(&path)
            .map_err(|e| format!("MCP 配置读取失败 {}: {e}", path.display()))?;
        let removed = pi::mcp::config::remove_project_server(&mut doc, name.trim());
        if removed {
            pi::mcp::config::write_project_config(&path, &doc)
                .map_err(|e| format!("MCP 配置写入失败 {}: {e}", path.display()))?;
        }
        Ok(removed)
    })?
}

/// 测试一个 MCP 服务器能否连上并列出工具（pi 的 `McpManager::test`）。
///
/// 会**真的启动进程 / 发 HTTP 请求**——UI 上要如实说明这是真连接测试。
#[tauri::command(rename_all = "camelCase", async)]
pub fn pi_mcp_test_server(cwd: String, name: String, project_trusted: bool) -> Result<serde_json::Value, String> {
    on_big_stack(move || {
        let global_dir = Config::global_dir();
        let cwd_path = PathBuf::from(cwd.trim());
        let discovery = pi::mcp::config::discover(&cwd_path, &global_dir, &[], project_trusted);
        let manager = std::sync::Arc::new(pi::mcp::McpManager::new(
            &cwd_path,
            &global_dir,
            discovery,
        ));

        // `test` 是 async：在独立 current_thread 运行时里跑（pi 的 future 不能
        // 进 tokio；构造方式与 pi_session.rs 的 PiRuntime 同款——
        // `RuntimeBuilder::current_thread().with_reactor(create_reactor())`）。
        let reactor = asupersync::runtime::reactor::create_reactor()
            .map_err(|e| format!("运行时 reactor 创建失败: {e}"))?;
        let rt = asupersync::runtime::RuntimeBuilder::current_thread()
            .with_reactor(reactor)
            .build()
            .map_err(|e| format!("运行时构建失败: {e}"))?;
        let name_owned = name.trim().to_string();
        let tools = rt
            .block_on(async move { manager.test(&name_owned).await })
            .map_err(|e| format!("MCP 连接测试失败: {e}"))?;

        let rows: Vec<serde_json::Value> = tools
            .iter()
            .map(|t| serde_json::json!({ "name": t.name, "description": t.description }))
            .collect();
        Ok(serde_json::json!({ "ok": true, "tools": rows }))
    })?
}

//! MCP 服务器**管理面**（左栏「技能与工具」→ 连接器的数据源）。
//!
//! ## 事实来源（2026-11-14 重接）
//!
//! rpi-main 本身没有 MCP 模块，能力由官方插件 **rpi-mcp-adapter** 提供
//! （`~/.rpi/agent/extensions/rpi_mcp_adapter.dll`，ABI v4）。插件在**会话内**
//! 暴露 `mcp_list` / `mcp_call` / `mcp_request` / `mcp_resource` 四个工具，
//! 调用时用 `configPath` 指向一个 JSON 配置；宿主不参与工具派发。
//!
//! 配置文件形状（插件 README 原文，不是猜测）：
//!
//! ```json
//! { "mcpServers": {
//!     "local":  { "command": "node", "args": ["server.js"], "timeout": 60 },
//!     "remote": { "url": "http://localhost:8931/mcp", "headers": {} }
//! } }
//! ```
//!
//! - 顶层键是 `mcpServers`（**不是** `servers`）。读错键 = 插件看不到任何服务器，
//!   所以文件里出现 `servers` 时如实出一条 warning，不静默当空表。
//! - 全局配置 = `~/.rpi/agent/mcp.json`（经 [`crate::pi_paths::agent_dir`]，
//!   `RPI_CODING_AGENT_DIR` 覆盖同样生效）。宿主的增删改只写这一份。
//! - 项目配置 = `<cwd>/.rpi/mcp.json`，**只读**参与列表（合并展示），
//!   宿主不写它——写路径单一，避免"两处都改一半"。
//!
//! ## 纪律
//!
//! - 文件不存在 = 空表（真实状态，插件没配置过）；解析失败 = `Err`（坏文件
//!   必须可见，且**拒绝覆盖**——读不出来就不写）。
//! - 写入 = read-modify-write，只动目标键；顶层其它键与其它服务器条目原样
//!   保留；落盘走 `pi_settings` 同款「临时文件 + rename」原子替换。
//! - `pi_mcp_test_server` **不假装连上了**：宿主进程无法驱动引擎侧适配器，
//!   这里只做配置合法性校验（stdio 解析 command、HTTP 校验 URL 语法），
//!   结果以 `ok:false + error` 如实返回并在文案里写明"未做真实连接"。

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{json, Map, Value};

use crate::pi_paths;
use crate::pi_settings::{read_json_document, write_json_document_public};

/// 插件读取的顶层容器键（README 原文：`mcpServers`）。
const SERVERS_KEY: &str = "mcpServers";

/// 全局配置落点：`~/.rpi/agent/mcp.json`。
fn global_config_path() -> Result<PathBuf, String> {
    Ok(pi_paths::agent_dir()?.join("mcp.json"))
}

/// 项目配置落点：`<cwd>/.rpi/mcp.json`。`cwd` 为空 = 没有项目上下文（None），
/// **不回落到进程 cwd**——那会把项目配置指到 `src-tauri/`。
fn project_config_path(cwd: &str) -> Option<PathBuf> {
    let trimmed = cwd.trim();
    (!trimmed.is_empty()).then(|| PathBuf::from(trimmed).join(".rpi").join("mcp.json"))
}

// ── wire 形状（与 df701a4 的 pi 时代实现兼容；前端 hermes-shim 按此解码）────

/// 一行 MCP 服务器。`command`/`url` 为 null 表示该传输不适用（与旧 wire
/// 一致：序列化成显式 null，前端用 `!== null` 判断）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerRow {
    name: String,
    command: Option<String>,
    args: Vec<String>,
    url: Option<String>,
    /// 显式 `transport`/`type`，否则由 command/url 推断；两者都缺 = "unknown"。
    transport: String,
    /// `global`（`~/.rpi/agent/mcp.json`）或 `project`（`<cwd>/.rpi/mcp.json`）。
    provenance: String,
    source_file: String,
    /// 只回 env 的键名——值可能是密钥，不回显。
    env_keys: Vec<String>,
}

/// 配置加载的一条非致命问题（畸形条目 / 认错的键）——如实透出，不吞。
#[derive(Debug, Serialize)]
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
    /// 全局配置落点（"在这里编辑"提示用）。
    global_config: String,
    /// 项目配置落点；没有 cwd 时为空串（不编造路径）。
    project_config: String,
}

// ── 读 ─────────────────────────────────────────────────────────────────────

/// 读一个配置文件里的 `mcpServers` 表。
///
/// - 文件不存在 / 空文件 → 空表（`read_json_document` 同语义）；
/// - JSON 解析失败、顶层非 object、`mcpServers` 非 object → `Err`；
/// - 条目本身畸形不阻断整表读取（逐条 warning，列表里跳过该条）。
fn read_server_entries(
    path: &Path,
) -> Result<(BTreeMap<String, Value>, Vec<McpConfigWarning>), String> {
    let Some(doc) = read_json_document(path)? else {
        return Ok((BTreeMap::new(), Vec::new()));
    };
    let mut warnings = Vec::new();
    let root = doc
        .as_object()
        .ok_or_else(|| format!("MCP 配置顶层必须是 JSON object: {}", path.display()))?;

    if !root.contains_key(SERVERS_KEY) {
        if let Some(other) = root.get("servers") {
            if !other.is_null() {
                warnings.push(McpConfigWarning {
                    source_file: path.display().to_string(),
                    entry: "servers".into(),
                    reason: "未识别的顶层键 `servers`——rpi-mcp-adapter 只读 `mcpServers`".into(),
                });
            }
        }
    }

    let entries = match root.get(SERVERS_KEY) {
        None => BTreeMap::new(),
        Some(Value::Object(map)) => map
            .iter()
            .map(|(name, value)| (name.clone(), value.clone()))
            .collect(),
        Some(_) => {
            return Err(format!(
                "MCP 配置的 `{}` 必须是 object: {}",
                SERVERS_KEY,
                path.display()
            ))
        }
    };
    Ok((entries, warnings))
}

/// 合并后的条目：原始值 + 来源（同名时项目级覆盖全局，并在 warnings 里说明）。
struct MergedEntry {
    value: Value,
    provenance: &'static str,
    source_file: PathBuf,
}

/// 全局 + 可选项目层的合并视图。同名以项目级为准（与 rpi 的分层配置直觉
/// 一致：越靠近项目越具体），覆盖事实以 warning 透出。
fn merged_entries(
    global_path: &Path,
    project_path: Option<&Path>,
) -> Result<(BTreeMap<String, MergedEntry>, Vec<McpConfigWarning>), String> {
    let (global, mut warnings) = read_server_entries(global_path)?;
    let mut merged: BTreeMap<String, MergedEntry> = global
        .into_iter()
        .map(|(name, value)| {
            (
                name,
                MergedEntry {
                    value,
                    provenance: "global",
                    source_file: global_path.to_path_buf(),
                },
            )
        })
        .collect();

    if let Some(project_path) = project_path {
        let (project, project_warnings) = read_server_entries(project_path)?;
        warnings.extend(project_warnings);
        for (name, value) in project {
            if let Some(previous) = merged.insert(
                name.clone(),
                MergedEntry {
                    value,
                    provenance: "project",
                    source_file: project_path.to_path_buf(),
                },
            ) {
                warnings.push(McpConfigWarning {
                    source_file: project_path.display().to_string(),
                    entry: name,
                    reason: format!(
                        "项目级条目覆盖了全局定义（{}）",
                        previous.source_file.display()
                    ),
                });
            }
        }
    }

    Ok((merged, warnings))
}

/// 把原始条目投影成 wire 行；畸形字段逐条出 warning（不静默丢弃）。
fn row_from_entry(
    name: &str,
    value: &Value,
    provenance: &str,
    source_file: &Path,
) -> (Option<McpServerRow>, Vec<McpConfigWarning>) {
    let mut warnings = Vec::new();
    let mut warn = |reason: String| {
        warnings.push(McpConfigWarning {
            source_file: source_file.display().to_string(),
            entry: name.to_string(),
            reason,
        })
    };

    let Some(obj) = value.as_object() else {
        warn("条目必须是 JSON object".into());
        return (None, warnings);
    };

    let command = match obj.get("command") {
        None => None,
        Some(Value::String(s)) if !s.trim().is_empty() => Some(s.clone()),
        Some(Value::String(_)) => {
            warn("command 为空字符串".into());
            None
        }
        Some(_) => {
            warn("command 必须是字符串".into());
            None
        }
    };

    let url = match obj.get("url") {
        None => None,
        Some(Value::String(s)) if !s.trim().is_empty() => Some(s.clone()),
        Some(Value::String(_)) => {
            warn("url 为空字符串".into());
            None
        }
        Some(_) => {
            warn("url 必须是字符串".into());
            None
        }
    };

    let args = match obj.get("args") {
        None => Vec::new(),
        Some(Value::Array(items)) => {
            let mut out = Vec::with_capacity(items.len());
            for item in items {
                match item.as_str() {
                    Some(s) => out.push(s.to_string()),
                    None => warn("args 含非字符串元素（已忽略该元素）".into()),
                }
            }
            out
        }
        Some(_) => {
            warn("args 必须是字符串数组".into());
            Vec::new()
        }
    };

    let env_keys = match obj.get("env") {
        None => Vec::new(),
        Some(Value::Object(map)) => map.keys().cloned().collect(),
        Some(_) => {
            warn("env 必须是 object".into());
            Vec::new()
        }
    };

    let explicit = match obj.get("transport").or_else(|| obj.get("type")) {
        None => None,
        Some(Value::String(s)) if !s.trim().is_empty() => Some(s.clone()),
        Some(Value::String(_)) => None,
        Some(_) => {
            warn("transport/type 必须是字符串".into());
            None
        }
    };

    if command.is_some() && url.is_some() {
        warn("同时声明了 command 与 url（适配器按传输类型二选一，需确认）".into());
    } else if command.is_none() && url.is_none() {
        warn("缺少 command 或 url——适配器不会挂载此条目".into());
    }

    let transport = match explicit {
        Some(value) => value,
        None if url.is_some() => "http".to_string(),
        None if command.is_some() => "stdio".to_string(),
        None => "unknown".to_string(),
    };

    let row = McpServerRow {
        name: name.to_string(),
        command,
        args,
        url,
        transport,
        provenance: provenance.to_string(),
        source_file: source_file.display().to_string(),
        env_keys,
    };
    (Some(row), warnings)
}

/// 合并视图 → wire 行 + warnings。
fn snapshot_rows(
    global_path: &Path,
    project_path: Option<&Path>,
) -> Result<(Vec<McpServerRow>, Vec<McpConfigWarning>), String> {
    let (merged, mut warnings) = merged_entries(global_path, project_path)?;
    let mut rows = Vec::with_capacity(merged.len());
    for (name, entry) in merged {
        let (row, row_warnings) = row_from_entry(
            &name,
            &entry.value,
            entry.provenance,
            &entry.source_file,
        );
        warnings.extend(row_warnings);
        if let Some(row) = row {
            rows.push(row);
        }
    }
    Ok((rows, warnings))
}

// ── 写 ─────────────────────────────────────────────────────────────────────

/// 写盘前的文档级校验：顶层必须是 object；`mcpServers` 若存在必须是 object。
/// 条目的语义校验在 [`validate_server_spec`]（upsert 的输入侧）——不因文件里
/// 别人的畸形条目阻断本次编辑（列表已用 warning 标出）。
fn validate_mcp_document(value: &Value) -> Result<(), String> {
    let root = value
        .as_object()
        .ok_or("MCP 配置顶层必须是 JSON object")?;
    match root.get(SERVERS_KEY) {
        None | Some(Value::Object(_)) => Ok(()),
        Some(_) => Err(format!("MCP 配置的 `{SERVERS_KEY}` 必须是 object")),
    }
}

/// 单个服务器定义（`mcpServers.<name>`）的形状校验：必须有非空 command 或
/// url；已知字段的类型必须与插件读取方式一致。未知字段原样保留。
fn validate_server_spec(spec: &Value) -> Result<(), String> {
    let obj = spec
        .as_object()
        .ok_or("服务器定义必须是 JSON object")?;

    let has_command = match obj.get("command") {
        None => false,
        Some(Value::String(s)) if !s.trim().is_empty() => true,
        Some(Value::String(_)) => return Err("command 不能是空字符串".into()),
        Some(_) => return Err("command 必须是字符串".into()),
    };
    let has_url = match obj.get("url") {
        None => false,
        Some(Value::String(s)) if !s.trim().is_empty() => true,
        Some(Value::String(_)) => return Err("url 不能是空字符串".into()),
        Some(_) => return Err("url 必须是字符串".into()),
    };
    if !has_command && !has_url {
        return Err("服务器定义必须包含非空的 command（stdio）或 url（HTTP）".into());
    }

    if let Some(args) = obj.get("args") {
        let items = args.as_array().ok_or("args 必须是字符串数组")?;
        if items.iter().any(|item| !item.is_string()) {
            return Err("args 必须是字符串数组".into());
        }
    }
    if let Some(env) = obj.get("env") {
        if !env.is_object() {
            return Err("env 必须是 object".into());
        }
    }
    if let Some(headers) = obj.get("headers") {
        if !headers.is_object() {
            return Err("headers 必须是 object".into());
        }
    }
    for key in ["transport", "type"] {
        if let Some(value) = obj.get(key) {
            if !value.is_string() {
                return Err(format!("{key} 必须是字符串"));
            }
        }
    }
    if let Some(timeout) = obj.get("timeout") {
        if !timeout.is_number() {
            return Err("timeout 必须是数字".into());
        }
    }
    Ok(())
}

/// 读-改-写全局配置：只插入/替换目标键，其它键与条目原样保留。
/// 坏文件（解析失败 / 顶层或 `mcpServers` 类型不对）在读取阶段就 `Err`，
/// 因此永远不会覆盖读不出来的内容。
fn upsert_server_at(path: &Path, name: &str, spec: &Value) -> Result<(), String> {
    validate_server_spec(spec)?;

    let mut doc = match read_json_document(path)? {
        Some(value) => value,
        None => Value::Object(Map::new()),
    };
    let root = doc
        .as_object_mut()
        .ok_or_else(|| format!("MCP 配置顶层必须是 JSON object: {}", path.display()))?;
    let servers = root
        .entry(SERVERS_KEY.to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    let map = servers.as_object_mut().ok_or_else(|| {
        format!(
            "MCP 配置的 `{}` 必须是 object: {}",
            SERVERS_KEY,
            path.display()
        )
    })?;
    map.insert(name.to_string(), spec.clone());

    write_json_document_public(path, &doc, validate_mcp_document)
}

/// 从全局配置删一个条目。文件不存在 / 条目不存在 → `Ok(false)`（与
/// df701a4 旧实现语义一致：删除不存在的键不是错误）。
fn remove_server_at(path: &Path, name: &str) -> Result<bool, String> {
    let Some(mut doc) = read_json_document(path)? else {
        return Ok(false);
    };
    let root = doc
        .as_object_mut()
        .ok_or_else(|| format!("MCP 配置顶层必须是 JSON object: {}", path.display()))?;
    let servers = match root.get_mut(SERVERS_KEY) {
        None => return Ok(false),
        Some(Value::Object(map)) => map,
        Some(_) => {
            return Err(format!(
                "MCP 配置的 `{}` 必须是 object: {}",
                SERVERS_KEY,
                path.display()
            ))
        }
    };
    if servers.remove(name).is_none() {
        return Ok(false);
    }
    write_json_document_public(path, &doc, validate_mcp_document)?;
    Ok(true)
}

// ── IPC 命令（注册在 main.rs invoke_handler；参数名必须与前端 invoke 一致）──

/// 读全部 MCP 服务器（全局 + 项目级只读合并）。
///
/// `project_trusted` 保留以兼容旧 wire 的调用签名：项目级在这里只是
/// **展示层**信息，宿主从不执行/启动项目条目（写路径也只有全局），所以
/// 信任与否不改变列表内容；真正决定项目配置是否生效的是会话侧把哪个
/// `configPath` 交给 rpi-mcp-adapter。
#[tauri::command(rename_all = "camelCase", async)]
pub fn pi_mcp_servers(cwd: Option<String>, project_trusted: bool) -> Result<McpSnapshot, String> {
    let _ = project_trusted;
    let global_path = global_config_path()?;
    let project_path = cwd.as_deref().and_then(project_config_path);
    let (servers, warnings) = snapshot_rows(&global_path, project_path.as_deref())?;
    Ok(McpSnapshot {
        servers,
        warnings,
        global_config: global_path.display().to_string(),
        project_config: project_path
            .map(|path| path.display().to_string())
            .unwrap_or_default(),
    })
}

/// 已配置服务器名（合并视图；供 MCP 目录做 installed 标记）。
pub(crate) fn installed_names() -> Result<Vec<String>, String> {
    Ok(pi_mcp_servers(None, false)?
        .servers
        .into_iter()
        .map(|row| row.name)
        .collect())
}

/// 单个已配置服务器的原始 spec + 所在文件（OAuth 写回 headers 要用）。
pub(crate) fn server_entry_full(name: &str) -> Result<Option<(Value, PathBuf)>, String> {
    let global = global_config_path()?;
    let (merged, _) = merged_entries(&global, None)?;
    Ok(merged.get(name).map(|entry| (entry.value.clone(), entry.source_file.clone())))
}

/// 改写某个服务器条目的一个 header（RMW，其它键保留）。
pub(crate) fn write_server_header(
    path: &Path,
    name: &str,
    header: &str,
    value: &str,
) -> Result<(), String> {
    let mut doc = read_json_document(path)?
        .ok_or_else(|| format!("MCP 配置不存在: {}", path.display()))?;
    let root = doc
        .as_object_mut()
        .ok_or_else(|| format!("MCP 配置顶层必须是 JSON object: {}", path.display()))?;
    let servers = root
        .get_mut(SERVERS_KEY)
        .and_then(Value::as_object_mut)
        .ok_or_else(|| format!("MCP 配置的 `{SERVERS_KEY}` 必须是 object: {}", path.display()))?;
    let server = servers
        .get_mut(name)
        .ok_or_else(|| format!("MCP 服务器不存在: {name}"))?
        .as_object_mut()
        .ok_or_else(|| format!("MCP 服务器条目必须是 object: {name}"))?;
    let headers = server
        .entry("headers".to_string())
        .or_insert_with(|| Value::Object(Map::new()))
        .as_object_mut()
        .ok_or_else(|| format!("MCP 服务器 {name} 的 headers 必须是 object"))?;
    headers.insert(header.to_string(), Value::String(value.to_string()));
    write_json_document_public(path, &doc, validate_mcp_document)
}

/// 写入一个 MCP 服务器到**全局**配置（`~/.rpi/agent/mcp.json`）。
///
/// `cwd` 保留以兼容前端/注册签名；写路径固定全局（见文件头：项目级只读）。
#[tauri::command(rename_all = "camelCase", async)]
pub fn pi_mcp_upsert_server(cwd: String, name: String, spec: Value) -> Result<(), String> {
    let _ = cwd;
    let name = name.trim();
    if name.is_empty() {
        return Err("服务器名为空".into());
    }
    upsert_server_at(&global_config_path()?, name, &spec)
}

/// 从**全局**配置删一个 MCP 服务器（文件/条目不存在 → `false`，不报错）。
#[tauri::command(rename_all = "camelCase", async)]
pub fn pi_mcp_remove_server(cwd: String, name: String) -> Result<bool, String> {
    let _ = cwd;
    let name = name.trim();
    if name.is_empty() {
        return Err("服务器名为空".into());
    }
    remove_server_at(&global_config_path()?, name)
}

/// 给已安装的 MCP 服务器写一个 env 变量（插件 `mcp.servers.set_api_key`
/// 的宿主对偶；hermes 写 `.env`，宿主写 `mcpServers.<name>.env`——rpi
/// adapter 在启动 stdio 子进程时读这个表）。
///
/// - 服务器必须已在全局配置里（不存在 → Err，不偷偷新建半截条目）；
/// - 变量名按 `[A-Za-z_][A-Za-z0-9_]*` 校验；
/// - 空值 = 删除该键（显式清除）。
#[tauri::command(rename_all = "camelCase", async)]
pub fn pi_mcp_set_api_key(
    cwd: String,
    name: String,
    env_var: String,
    value: String,
) -> Result<(), String> {
    let _ = cwd;
    let name = name.trim();
    if name.is_empty() {
        return Err("服务器名为空".into());
    }
    let env_var = env_var.trim();
    let valid = !env_var.is_empty()
        && env_var
            .chars()
            .enumerate()
            .all(|(i, c)| c == '_' || c.is_ascii_alphabetic() || (i > 0 && c.is_ascii_digit()));
    if !valid {
        return Err(format!("非法 env 变量名: {env_var}"));
    }

    let path = global_config_path()?;
    let mut doc = read_json_document(&path)?
        .ok_or_else(|| format!("MCP 配置不存在: {}", path.display()))?;
    let root = doc
        .as_object_mut()
        .ok_or_else(|| format!("MCP 配置顶层必须是 JSON object: {}", path.display()))?;
    let servers = root
        .get_mut(SERVERS_KEY)
        .and_then(Value::as_object_mut)
        .ok_or_else(|| format!("MCP 配置的 `{SERVERS_KEY}` 必须是 object: {}", path.display()))?;
    let server = servers
        .get_mut(name)
        .ok_or_else(|| format!("MCP 服务器不存在: {name}"))?
        .as_object_mut()
        .ok_or_else(|| format!("MCP 服务器条目必须是 object: {name}"))?;
    let env = server
        .entry("env".to_string())
        .or_insert_with(|| Value::Object(Map::new()))
        .as_object_mut()
        .ok_or_else(|| format!("MCP 服务器 {name} 的 env 必须是 object"))?;
    if value.is_empty() {
        env.remove(env_var);
    } else {
        env.insert(env_var.to_string(), Value::String(value));
    }
    write_json_document_public(&path, &doc, validate_mcp_document)
}

// ── 测试 ───────────────────────────────────────────────────────────────────

/// 命令解析：返回可执行文件的绝对路径（或调用方显式给的路径）。
fn resolve_command(command: &str) -> Result<PathBuf, String> {
    let command = command.trim();
    if command.is_empty() {
        return Err("command 为空".into());
    }
    let path = Path::new(command);
    let explicit = path.is_absolute() || command.contains('/') || command.contains('\\');
    if explicit {
        return if is_executable_file(path) {
            Ok(path.to_path_buf())
        } else {
            Err(format!("command 指向的文件不存在或不可执行: {}", path.display()))
        };
    }

    let path_var = std::env::var_os("PATH")
        .ok_or("PATH 未设置，无法把裸命令解析成可执行文件")?;
    for dir in std::env::split_paths(&path_var) {
        // 先试调用方写的原名（Unix 可执行、Windows 已带扩展名的情况），
        // 再按 PATHEXT 补扩展名。
        let exact = dir.join(command);
        if is_executable_file(&exact) {
            return Ok(exact);
        }
        for candidate in command_candidates(&dir, command)? {
            if is_executable_file(&candidate) {
                return Ok(candidate);
            }
        }
    }
    Err(format!("PATH 中找不到可执行命令: {command}"))
}

fn is_executable_file(path: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    if !meta.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if meta.permissions().mode() & 0o111 == 0 {
            return false;
        }
    }
    true
}

/// PATH 里的候选文件名（不含原名——原名由调用方先试）。
/// Windows 按 PATHEXT 补扩展名（`node` → `node.exe`）；PATHEXT 读不到时
/// **传播错误**而不是拿默认列表兜底（Windows 正常环境必有）。
#[cfg(windows)]
fn command_candidates(dir: &Path, name: &str) -> Result<Vec<PathBuf>, String> {
    let pathext = std::env::var("PATHEXT").map_err(|e| format!("PATHEXT 读取失败: {e}"))?;
    let mut candidates = Vec::new();
    for ext in pathext.split(';').filter(|ext| !ext.trim().is_empty()) {
        candidates.push(dir.join(format!("{name}{ext}")));
        candidates.push(dir.join(format!("{name}{}", ext.to_ascii_lowercase())));
    }
    Ok(candidates)
}

#[cfg(not(windows))]
fn command_candidates(_dir: &Path, _name: &str) -> Result<Vec<PathBuf>, String> {
    // Unix 没有扩展名机制，原名就是唯一候选（调用方已试过）。
    Ok(Vec::new())
}

/// 校验 URL 语法（不发起网络请求）。`http`/`https` 且 host 非空才算合法。
fn validate_http_url(url: &str) -> Result<String, String> {
    let parsed = reqwest::Url::parse(url).map_err(|e| format!("URL 解析失败: {e}"))?;
    match parsed.scheme() {
        "http" | "https" => {}
        other => return Err(format!("不支持的 URL scheme: {other}（只支持 http/https）")),
    }
    if parsed.host_str().map(str::is_empty).unwrap_or(true) {
        return Err("URL 缺少 host".into());
    }
    Ok(parsed.to_string())
}

/// 校验一条服务器定义，返回可读的校验说明。
fn validate_probe_target(entry: &MergedEntry) -> (String, Result<String, String>) {
    let Some(obj) = entry.value.as_object() else {
        return (
            "unknown".into(),
            Err("条目不是 JSON object".into()),
        );
    };
    let command = obj
        .get("command")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let url = obj
        .get("url")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());

    match (command, url) {
        (Some(_), Some(_)) => (
            "unknown".into(),
            Err("同时声明了 command 与 url，无法判断传输类型".into()),
        ),
        (Some(command), None) => match resolve_command(command) {
            Ok(resolved) => (
                "stdio".into(),
                Ok(format!(
                    "stdio command `{command}` 可解析（{}）",
                    resolved.display()
                )),
            ),
            Err(reason) => ("stdio".into(), Err(reason)),
        },
        (None, Some(url)) => match validate_http_url(url) {
            Ok(normalized) => (
                "http".into(),
                Ok(format!("HTTP URL 语法有效（{normalized}）")),
            ),
            Err(reason) => ("http".into(), Err(reason)),
        },
        (None, None) => (
            "unknown".into(),
            Err("缺少 command（stdio）或 url（HTTP）".into()),
        ),
    }
}

/// 测试一个 MCP 服务器。
///
/// **HTTP 条目做真实探测**（2026-11-17）：Streamable HTTP 的
/// `initialize` → `notifications/initialized` → `tools/list` 三步，
/// 返回真实工具表与 serverInfo（no-auth / 配置了 headers 的条目都可测）。
///
/// **stdio 条目只做配置校验**：MCP 能力在引擎侧插件（rpi-mcp-adapter）里，
/// 宿主进程没有它的句柄；真实连接只能在会话内用 `mcp_list` / `mcp_call`。
/// 结果如实返回 `ok:false` + 说明，绝不假装探测成功。
#[tauri::command(rename_all = "camelCase", async)]
pub fn pi_mcp_test_server(
    cwd: String,
    name: String,
    project_trusted: bool,
) -> Result<Value, String> {
    let _ = project_trusted;
    let name = name.trim();
    if name.is_empty() {
        return Err("服务器名为空".into());
    }

    let global_path = global_config_path()?;
    let project_path = project_config_path(&cwd);
    let (merged, _) = merged_entries(&global_path, project_path.as_deref())?;
    let entry = merged.get(name).ok_or_else(|| {
        let searched = match project_path.as_deref() {
            Some(path) => format!(
                "{}, {}",
                global_path.display(),
                path.display()
            ),
            None => global_path.display().to_string(),
        };
        format!("找不到 MCP 服务器「{name}」（已查 {searched}）")
    })?;

    let (kind, validation) = validate_probe_target(entry);

    if kind == "http" {
        if let Some(url) = entry.value.get("url").and_then(Value::as_str) {
            // OAuth 服务器：token 快过期先刷新（刷新失败原样传播——测试结果
            // 必须反映真实可用性）。
            let oauth_managed = entry.value.get("headers").is_some();
            if oauth_managed {
                crate::pi_mcp_oauth::ensure_fresh(name)?;
            }
            // 刷新可能改写 headers（token 轮换），重新读一次条目。
            let (refreshed, _) = merged_entries(&global_path, project_path.as_deref())?
                .0
                .get(name)
                .map(|entry| (entry.value.clone(), ()))
                .unwrap_or((entry.value.clone(), ()));
            let headers: Vec<(String, String)> = refreshed
                .get("headers")
                .and_then(Value::as_object)
                .map(|map| {
                    map.iter()
                        .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_owned())))
                        .collect()
                })
                .unwrap_or_default();
            let url_owned = url.to_owned();
            let source_file = entry.source_file.display().to_string();
            let provenance = entry.provenance;
            let probe = std::thread::spawn(move || probe_http_mcp(&url_owned, &headers))
                .join()
                .map_err(|_| "MCP 探测线程崩溃".to_string())?;
            return Ok(match probe {
                Ok((info, tools)) => json!({
                    "ok": true,
                    "serverInfo": info,
                    "tools": tools,
                    "kind": "http",
                    "configPath": source_file,
                    "provenance": provenance,
                }),
                Err(error) => json!({
                    "ok": false,
                    "error": format!("真实连接失败：{error}"),
                    "tools": [],
                    "kind": "http",
                    "configPath": source_file,
                    "provenance": provenance,
                }),
            });
        }
    }

    let error = match validation {
        Ok(detail) => format!(
            "未连接：宿主进程无法驱动引擎侧 rpi-mcp-adapter，不能做真实连接/工具枚举。\
             配置校验通过（{detail}）。真实连通性与工具表请在本机会话内用 mcp_list / mcp_call 验证。"
        ),
        Err(reason) => format!(
            "未连接：宿主进程无法驱动引擎侧 rpi-mcp-adapter。配置校验失败：{reason}。\
             修复配置后可在本机会话内用 mcp_list / mcp_call 验证真实连通性。"
        ),
    };

    Ok(serde_json::json!({
        "ok": false,
        "error": error,
        "tools": [],
        "kind": kind,
        "configPath": entry.source_file.display().to_string(),
        "provenance": entry.provenance,
    }))
}

// ── Streamable HTTP MCP 真实探测（initialize → initialized → tools/list）──

fn json_rpc_body(id: Option<u64>, method: &str, params: Value) -> Value {
    let mut body = Map::new();
    body.insert("jsonrpc".to_owned(), Value::String("2.0".to_owned()));
    if let Some(id) = id {
        body.insert("id".to_owned(), json!(id));
    }
    body.insert("method".to_owned(), Value::String(method.to_owned()));
    if !params.is_null() {
        body.insert("params".to_owned(), params);
    }
    Value::Object(body)
}

/// 解析 MCP 的响应体：普通 JSON，或 `text/event-stream` 里最后一条 data JSON。
fn parse_rpc_response(text: &str, content_type: &str) -> Result<Value, String> {
    if content_type.contains("text/event-stream") {
        let mut found: Option<Value> = None;
        for line in text.lines() {
            let trimmed = line.trim_start();
            if let Some(rest) = trimmed.strip_prefix("data:") {
                if let Ok(value) = serde_json::from_str::<Value>(rest.trim()) {
                    found = Some(value);
                }
            }
        }
        return found.ok_or_else(|| "SSE 响应里没有 data JSON".to_owned());
    }
    serde_json::from_str::<Value>(text).map_err(|e| {
        format!(
            "响应不是 JSON（{e}）；body 前 200 字符：{}",
            text.chars().take(200).collect::<String>()
        )
    })
}

fn probe_http_mcp(
    url: &str,
    headers: &[(String, String)],
) -> Result<(Value, Vec<Value>), String> {
    use std::time::Duration;

    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| format!("HTTP client 构造失败: {e}"))?;

    let post = |body: &Value, session: Option<&str>| -> Result<(reqwest::StatusCode, String, Option<String>, String), String> {
        let mut request = client
            .post(url)
            .header("content-type", "application/json")
            .header("accept", "application/json, text/event-stream");
        for (key, value) in headers {
            request = request.header(key.as_str(), value.as_str());
        }
        if let Some(session) = session {
            request = request.header("mcp-session-id", session);
        }
        let response = request
            .json(body)
            .send()
            .map_err(|e| format!("请求失败: {e}"))?;
        let status = response.status();
        let session = response
            .headers()
            .get("mcp-session-id")
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned);
        let content_type = response
            .headers()
            .get("content-type")
            .and_then(|value| value.to_str().ok())
            .unwrap_or("application/json")
            .to_owned();
        let text = response
            .text()
            .map_err(|e| format!("读取响应失败: {e}"))?;
        Ok((status, text, session, content_type))
    };

    let initialize = json_rpc_body(
        Some(1),
        "initialize",
        json!({
            "protocolVersion": "2025-03-26",
            "capabilities": {},
            "clientInfo": { "name": "mirach-harness", "version": "0" },
        }),
    );
    let (status, text, session, content_type) = post(&initialize, None)?;
    if !status.is_success() {
        return Err(format!(
            "initialize HTTP {status}：{}",
            text.chars().take(300).collect::<String>()
        ));
    }
    let init = parse_rpc_response(&text, &content_type)?;
    if let Some(error) = init.get("error") {
        return Err(format!("initialize 返回错误：{error}"));
    }
    let server_info = init
        .pointer("/result/serverInfo")
        .cloned()
        .unwrap_or(Value::Null);

    let initialized = json_rpc_body(None, "notifications/initialized", Value::Null);
    let (status, text, _, _) = post(&initialized, session.as_deref())?;
    if !status.is_success() {
        return Err(format!(
            "notifications/initialized HTTP {status}：{}",
            text.chars().take(200).collect::<String>()
        ));
    }

    let list = json_rpc_body(Some(2), "tools/list", json!({}));
    let (status, text, _, content_type) = post(&list, session.as_deref())?;
    if !status.is_success() {
        return Err(format!(
            "tools/list HTTP {status}：{}",
            text.chars().take(300).collect::<String>()
        ));
    }
    let list_response = parse_rpc_response(&text, &content_type)?;
    if let Some(error) = list_response.get("error") {
        return Err(format!("tools/list 返回错误：{error}"));
    }
    let tools = list_response
        .pointer("/result/tools")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    Ok((server_info, tools))
}

/// per-bot MCP 配置文件（2026-11-18）：从全局 `mcp.json` 的 `mcpServers`
/// 过滤出所选服务器，写到 `~/.rpi/agent/bot-mcp/<bot>.json`，返回绝对路径。
/// rpi-mcp-adapter 的 `mcp_list/mcp_call/mcp_resource` 接受 `configPath`，
/// bot-launch 把路径注入 system prompt —— per-bot MCP 由此真生效。
///
/// 规矩 12：全局配置读不出 / 所选名字不存在 → Err（不静默写空配置）。
#[tauri::command(rename_all = "camelCase", async)]
pub fn pi_bot_mcp_config(bot_name: String, servers: Vec<String>) -> Result<Value, String> {
    let bot = bot_name.trim();
    if bot.is_empty() {
        return Err("pi_bot_mcp_config: bot 名为空".into());
    }
    let selected_names: Vec<String> = servers
        .iter()
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty())
        .collect();
    if selected_names.is_empty() {
        return Err("pi_bot_mcp_config: 未选择 MCP 服务器".into());
    }
    let doc = read_json_document(&global_config_path()?)?.unwrap_or_else(|| json!({}));
    let all = doc
        .get(SERVERS_KEY)
        .and_then(Value::as_object)
        .ok_or_else(|| "pi_bot_mcp_config: 全局 mcp.json 缺 mcpServers 表".to_string())?;
    let mut selected = Map::new();
    let mut missing: Vec<String> = Vec::new();
    for name in &selected_names {
        match all.get(name) {
            Some(spec) => {
                selected.insert(name.clone(), spec.clone());
            }
            None => missing.push(name.clone()),
        }
    }
    if !missing.is_empty() {
        return Err(format!(
            "pi_bot_mcp_config: 全局 mcp.json 里没有这些服务器: {}",
            missing.join(", ")
        ));
    }
    let safe_name: String = bot
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let dir = pi_paths::agent_dir()?.join("bot-mcp");
    std::fs::create_dir_all(&dir).map_err(|e| format!("bot-mcp 目录创建失败: {e}"))?;
    let path = dir.join(format!("{safe_name}.json"));
    let text = serde_json::to_string_pretty(&json!({ SERVERS_KEY: selected }))
        .map_err(|e| format!("per-bot mcp 序列化失败: {e}"))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text).map_err(|e| format!("per-bot mcp 写入失败: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("per-bot mcp 替换失败: {e}"))?;
    Ok(json!({
        "path": path.to_string_lossy(),
        "servers": selected_names,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn temp_dir(label: &str) -> PathBuf {
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "mirach-pi-mcp-{label}-{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    fn write_doc(path: &Path, text: &str) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("create parent");
        }
        std::fs::write(path, text).expect("write fixture");
    }

    #[test]
    fn missing_file_is_empty_not_error() {
        let dir = temp_dir("missing");
        let (rows, warnings) =
            snapshot_rows(&dir.join("nope.json"), None).expect("missing file is empty");
        assert!(rows.is_empty());
        assert!(warnings.is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn parses_rows_and_warns_on_bad_entries() {
        let dir = temp_dir("read");
        let global = dir.join("global.json");
        write_doc(
            &global,
            r#"{
              "mcpServers": {
                "local": {"command": "node", "args": ["server.js"], "env": {"TOKEN": "x"}, "timeout": 60},
                "remote": {"url": "http://localhost:8931/mcp", "type": "http"},
                "broken": "not-an-object",
                "empty": {}
              },
              "other": {"keep": true}
            }"#,
        );

        let (rows, warnings) = snapshot_rows(&global, None).expect("read");
        assert_eq!(rows.len(), 3);
        let local = rows.iter().find(|row| row.name == "local").expect("local");
        assert_eq!(local.transport, "stdio");
        assert_eq!(local.command.as_deref(), Some("node"));
        assert_eq!(local.args, vec!["server.js"]);
        assert_eq!(local.env_keys, vec!["TOKEN"]);
        assert_eq!(local.provenance, "global");
        let remote = rows.iter().find(|row| row.name == "remote").expect("remote");
        assert_eq!(remote.transport, "http");
        assert_eq!(remote.url.as_deref(), Some("http://localhost:8931/mcp"));

        assert!(warnings.iter().any(|w| w.entry == "broken"));
        assert!(warnings.iter().any(|w| w.entry == "empty"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn project_layer_overrides_global_and_is_marked() {
        let dir = temp_dir("merge");
        let global = dir.join("global.json");
        let project = dir.join("cwd/.rpi/mcp.json");
        write_doc(&global, r#"{"mcpServers": {"shared": {"command": "old"}}}"#);
        write_doc(&project, r#"{"mcpServers": {"shared": {"command": "new"}, "only": {"url": "https://example.test/mcp"}}}"#);

        let (rows, warnings) = snapshot_rows(&global, Some(&project)).expect("read");
        assert_eq!(rows.len(), 2);
        let shared = rows.iter().find(|row| row.name == "shared").expect("shared");
        assert_eq!(shared.command.as_deref(), Some("new"));
        assert_eq!(shared.provenance, "project");
        assert!(warnings.iter().any(|w| w.entry == "shared"
            && w.reason.contains("覆盖了全局定义")));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn malformed_json_is_an_error() {
        let dir = temp_dir("bad-json");
        let global = dir.join("global.json");
        write_doc(&global, "{ not json");
        let err = snapshot_rows(&global, None).expect_err("bad json must be visible");
        assert!(err.contains("解析失败"), "{err}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn upsert_preserves_other_keys_and_servers() {
        let dir = temp_dir("upsert");
        let global = dir.join("global.json");
        write_doc(
            &global,
            r#"{"mcpServers": {"keep": {"command": "keep"}}, "unknownTop": [1, 2]}"#,
        );

        let spec = serde_json::json!({"command": "node", "args": ["server.js"]});
        upsert_server_at(&global, "added", &spec).expect("upsert");
        upsert_server_at(&global, "keep", &serde_json::json!({"url": "http://x.test/mcp"}))
            .expect("replace");

        let doc: Value =
            serde_json::from_str(&std::fs::read_to_string(&global).expect("read")).expect("json");
        assert_eq!(doc["unknownTop"], serde_json::json!([1, 2]));
        assert_eq!(doc["mcpServers"]["added"]["command"], "node");
        assert_eq!(doc["mcpServers"]["keep"]["url"], "http://x.test/mcp");
        // 落盘格式与 pi_settings 一致（pretty + 尾随换行）
        let text = std::fs::read_to_string(&global).expect("read text");
        assert!(text.ends_with("}\n"), "missing trailing newline");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn upsert_refuses_bad_spec_and_bad_file() {
        let dir = temp_dir("upsert-bad");
        let global = dir.join("global.json");

        let err = upsert_server_at(&global, "x", &serde_json::json!({"args": []}))
            .expect_err("spec without command/url must fail");
        assert!(err.contains("command"), "{err}");
        assert!(!global.exists(), "invalid spec must not create the file");

        write_doc(&global, "[1, 2, 3]");
        let err = upsert_server_at(&global, "x", &serde_json::json!({"command": "node"}))
            .expect_err("non-object document must be refused");
        assert!(err.contains("JSON object"), "{err}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn remove_missing_file_or_name_is_false() {
        let dir = temp_dir("remove");
        let global = dir.join("global.json");
        assert!(!remove_server_at(&global, "x").expect("missing file"));

        write_doc(&global, r#"{"mcpServers": {"a": {"command": "a"}}}"#);
        assert!(!remove_server_at(&global, "nope").expect("missing name"));
        assert!(remove_server_at(&global, "a").expect("remove"));
        let doc: Value =
            serde_json::from_str(&std::fs::read_to_string(&global).expect("read")).expect("json");
        assert!(doc["mcpServers"].as_object().expect("map").is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn command_resolution_checks_explicit_path() {
        let exe = std::env::current_exe().expect("current exe");
        assert!(resolve_command(&exe.display().to_string()).is_ok());
        let err = resolve_command("definitely-not-a-real-command-xyz")
            .expect_err("unknown bare command must fail");
        assert!(err.contains("PATH"), "{err}");
    }

    #[test]
    fn url_validation_accepts_http_and_rejects_junk() {
        assert!(validate_http_url("http://localhost:8931/mcp").is_ok());
        assert!(validate_http_url("https://example.test/x").is_ok());
        assert!(validate_http_url("not a url").is_err());
        assert!(validate_http_url("ftp://example.test/x").is_err());
        assert!(validate_http_url("http://").is_err());
    }
}

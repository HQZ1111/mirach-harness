//! 迁移数据（2026-11-23）：ZCode「数据同步 → 迁移数据」的宿主数据面。
//!
//! ZCode 的迁移向导（onboarding/OnboardingDialog）从 **Claude Code** 迁移：
//! 会话、Skills、MCP 服务器、命令、`CLAUDE.md` → `AGENTS.md`。
//!
//! 宿主可落地的部分：
//! - Skills：`~/.claude/skills/<name>` → `~/.rpi/agent/skills/<name>`（目录复制，
//!   同名跳过，不覆盖本机已有技能）；
//! - MCP：`~/.claude.json` / `~/.claude/settings.json` 的 `mcpServers` → 合并进
//!   `~/.rpi/agent/mcp.json`（只补缺失名字，保留本机与远端独有）；
//! - AGENTS.md：`~/.claude/CLAUDE.md` → `~/.rpi/agent/SYSTEM.md`（宿主系统提示
//!   文件，ZCode 目标 `~/.zcode/AGENTS.md` 的对偶）；
//! - 命令：宿主没有命令目录/消费面，扫描只报数量，导入会明确拒绝；
//! - Claude 会话：宿主 pi 引擎没有 Claude JSONL 导入器（无 `session.foreign.*`
//!   实现），扫描只报数量与工作区，**不假装能导入**。
//!
//! 规矩 12：读取失败 / 复制失败逐条返回 failed，不静默跳过。

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use rpi_agent::message::AgentMessage;
use rpi_ai::types::{
    Api, AssistantMessage, Content, StopReason, ToolResultMessage, ToolResultRole, UserMessage,
};
use serde_json::{json, Map, Value};

fn home_dir() -> Result<PathBuf, String> {
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map(PathBuf::from)
        .map_err(|_| "无法定位用户主目录".to_string())
}

fn claude_root() -> Result<PathBuf, String> {
    Ok(home_dir()?.join(".claude"))
}

fn host_agent_dir() -> Result<PathBuf, String> {
    crate::pi_paths::agent_dir()
}

fn list_dir_names(path: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(path)
        .map(|it| {
            it.filter_map(Result::ok)
                .filter(|entry| entry.path().is_dir())
                .map(|entry| entry.file_name().to_string_lossy().to_string())
                .collect()
        })
        .unwrap_or_default();
    names.sort();
    names
}

fn list_files_recursive(root: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        if path.is_dir() {
            list_files_recursive(&path, out);
        } else {
            out.push(path);
        }
    }
}

fn claude_mcp_configs() -> Vec<PathBuf> {
    let Ok(home) = home_dir() else {
        return Vec::new();
    };
    let mut paths = Vec::new();
    for candidate in [
        home.join(".claude.json"),
        home.join(".claude").join("settings.json"),
        home.join(".claude").join("mcp.json"),
    ] {
        if candidate.is_file() {
            paths.push(candidate);
        }
    }
    paths
}

fn read_mcp_servers_from(path: &Path) -> Result<Map<String, Value>, String> {
    let Some(doc) = crate::pi_settings::read_json_document(path)? else {
        return Ok(Map::new());
    };
    let servers = doc.get("mcpServers").and_then(Value::as_object).cloned();
    Ok(servers.unwrap_or_default())
}

fn parse_timestamp(value: Option<&Value>) -> i64 {
    let Some(value) = value else { return 0 };
    if let Some(ms) = value.as_i64() {
        return if ms < 10_000_000_000 { ms * 1000 } else { ms };
    }
    let Some(text) = value.as_str() else { return 0 };
    chrono::DateTime::parse_from_rfc3339(text)
        .map(|dt| dt.timestamp_millis())
        .unwrap_or(0)
}

/// 解析 Claude Code 的 JSONL 会话 → pi AgentMessage 序列。
/// 返回 (cwd, 标题, 消息, 跳过的行数)。不支持的行（system/summary 等）跳过并计数。
pub(crate) fn parse_claude_session(
    text: &str,
) -> Result<(String, Option<String>, Vec<AgentMessage>, usize), String> {
    let mut cwd = String::new();
    let mut title: Option<String> = None;
    let mut messages: Vec<AgentMessage> = Vec::new();
    let mut skipped = 0usize;
    let mut tool_names: HashMap<String, String> = HashMap::new();

    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(doc) = serde_json::from_str::<Value>(line) else {
            skipped += 1;
            continue;
        };
        if let Some(found) = doc.get("cwd").and_then(Value::as_str) {
            if cwd.is_empty() {
                cwd = found.to_string();
            }
        }
        let kind = doc.get("type").and_then(Value::as_str).unwrap_or("");
        let timestamp = parse_timestamp(doc.get("timestamp"));
        let Some(message) = doc.get("message") else {
            skipped += 1;
            continue;
        };
        match kind {
            "user" => {
                let content = message.get("content");
                match content {
                    Some(Value::String(text)) => {
                        if !text.trim().is_empty() {
                            if title.is_none() {
                                title = Some(text.chars().take(80).collect());
                            }
                            messages.push(AgentMessage::User(UserMessage::new(
                                text.as_str(),
                                timestamp,
                            )));
                        }
                    }
                    Some(Value::Array(blocks)) => {
                        let mut user_text = String::new();
                        for block in blocks {
                            let block_type = block.get("type").and_then(Value::as_str).unwrap_or("");
                            match block_type {
                                "text" => {
                                    if let Some(text) = block.get("text").and_then(Value::as_str) {
                                        if !user_text.is_empty() {
                                            user_text.push('\n');
                                        }
                                        user_text.push_str(text);
                                    }
                                }
                                "tool_result" => {
                                    let tool_call_id = block
                                        .get("tool_use_id")
                                        .and_then(Value::as_str)
                                        .unwrap_or("")
                                        .to_string();
                                    let tool_name = tool_names
                                        .get(&tool_call_id)
                                        .cloned()
                                        .unwrap_or_else(|| "tool".to_string());
                                    let result_text = match block.get("content") {
                                        Some(Value::String(text)) => text.clone(),
                                        Some(Value::Array(items)) => items
                                            .iter()
                                            .filter_map(|item| {
                                                item.get("text").and_then(Value::as_str)
                                            })
                                            .collect::<Vec<_>>()
                                            .join("\n"),
                                        _ => String::new(),
                                    };
                                    messages.push(AgentMessage::ToolResult(Box::new(
                                        ToolResultMessage {
                                            role: ToolResultRole,
                                            tool_call_id,
                                            tool_name,
                                            content: vec![Content::text(result_text)],
                                            details: None,
                                            usage: None,
                                            added_tool_names: Vec::new(),
                                            is_error: block
                                                .get("is_error")
                                                .and_then(Value::as_bool)
                                                .unwrap_or(false),
                                            timestamp,
                                        },
                                    )));
                                }
                                _ => skipped += 1,
                            }
                        }
                        if !user_text.trim().is_empty() {
                            if title.is_none() {
                                title = Some(user_text.chars().take(80).collect());
                            }
                            messages.push(AgentMessage::User(UserMessage::new(
                                user_text,
                                timestamp,
                            )));
                        }
                    }
                    _ => skipped += 1,
                }
            }
            "assistant" => {
                let blocks = message
                    .get("content")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                let model = message
                    .get("model")
                    .and_then(Value::as_str)
                    .unwrap_or("claude")
                    .to_string();
                let mut assistant =
                    AssistantMessage::empty(Api::AnthropicMessages, "claude-code", model, timestamp);
                let mut has_tool_call = false;
                for block in &blocks {
                    match block.get("type").and_then(Value::as_str).unwrap_or("") {
                        "text" => {
                            if let Some(text) = block.get("text").and_then(Value::as_str) {
                                assistant.content.push(Content::text(text));
                            }
                        }
                        "thinking" => {
                            if let Some(text) = block.get("thinking").and_then(Value::as_str) {
                                assistant.content.push(Content::thinking(text));
                            }
                        }
                        "tool_use" => {
                            let id = block
                                .get("id")
                                .and_then(Value::as_str)
                                .unwrap_or("")
                                .to_string();
                            let name = block
                                .get("name")
                                .and_then(Value::as_str)
                                .unwrap_or("tool")
                                .to_string();
                            tool_names.insert(id.clone(), name.clone());
                            has_tool_call = true;
                            assistant.content.push(Content::tool_call(
                                id,
                                name,
                                block.get("input").cloned().unwrap_or_else(|| json!({})),
                            ));
                        }
                        _ => skipped += 1,
                    }
                }
                assistant.stop_reason = if has_tool_call {
                    StopReason::ToolUse
                } else {
                    StopReason::Stop
                };
                if !assistant.content.is_empty() {
                    messages.push(AgentMessage::Assistant(Box::new(assistant)));
                }
            }
            _ => skipped += 1,
        }
    }

    if cwd.is_empty() {
        return Err("Claude 会话缺少 cwd 字段".into());
    }
    Ok((cwd, title, messages, skipped))
}

/// 扫描可迁移项（Claude Code → 宿主）。
#[tauri::command(rename_all = "camelCase", async)]
pub fn pi_migration_scan() -> Result<Value, String> {
    crate::pi_session::on_big_stack(move || {
        let root = claude_root()?;
        // Claude 会话：现代布局在 ~/.claude/projects/**/*.jsonl，旧布局 sessions/。
        let mut session_files = Vec::new();
        list_files_recursive(&root.join("projects"), &mut session_files);
        list_files_recursive(&root.join("sessions"), &mut session_files);
        session_files.retain(|path| path.extension().and_then(|e| e.to_str()) == Some("jsonl"));
        let mut session_rows: Vec<Value> = Vec::new();
        let mut workspaces: Vec<String> = Vec::new();
        for path in &session_files {
            let text = std::fs::read_to_string(path).unwrap_or_default();
            let parsed = parse_claude_session(&text);
            let (cwd, title, count) = match parsed {
                Ok((cwd, title, messages, _)) => {
                    let count = messages
                        .iter()
                        .filter(|message| {
                            matches!(
                                message,
                                AgentMessage::User(_) | AgentMessage::Assistant(_)
                            )
                        })
                        .count();
                    (cwd, title, count)
                }
                Err(_) => (String::new(), None, 0),
            };
            if !cwd.is_empty() && !workspaces.contains(&cwd) {
                workspaces.push(cwd.clone());
            }
            session_rows.push(json!({
                "path": path.display().to_string(),
                "workspace": cwd,
                "title": title,
                "messageCount": count,
            }));
        }
        workspaces.sort();

        let skills_root = root.join("skills");
        let skills: Vec<Value> = list_dir_names(&skills_root)
            .into_iter()
            .map(|name| json!({ "name": name, "path": skills_root.join(&name).display().to_string() }))
            .collect();

        let mut mcp_names: Vec<String> = Vec::new();
        for path in claude_mcp_configs() {
            let servers = read_mcp_servers_from(&path)?;
            mcp_names.extend(servers.keys().cloned());
        }
        mcp_names.sort();
        mcp_names.dedup();
        let mcp: Vec<Value> = mcp_names
            .into_iter()
            .map(|name| json!({ "name": name }))
            .collect();

        let mut command_files = Vec::new();
        list_files_recursive(&root.join("commands"), &mut command_files);
        command_files.retain(|path| path.extension().and_then(|e| e.to_str()) == Some("md"));
        let commands: Vec<Value> = command_files
            .iter()
            .filter_map(|path| {
                let name = path.file_stem()?.to_string_lossy().to_string();
                Some(json!({ "name": name, "path": path.display().to_string() }))
            })
            .collect();

        let claude_md = root.join("CLAUDE.md");
        let target = host_agent_dir()?.join("SYSTEM.md");
        Ok(json!({
            "sessions": {
                "count": session_rows.len(),
                "sessions": session_rows,
                "workspaces": workspaces,
                "supported": true,
                "reason": "",
            },
            "skills": skills,
            "mcp": mcp,
            "commands": commands,
            "commandsSupported": false,
            "commandsReason": "宿主没有命令目录/命令消费面，导入命令不会生效",
            "agentsFile": {
                "source": claude_md.display().to_string(),
                "target": target.display().to_string(),
                "exists": claude_md.is_file(),
            },
        }))
    })?
}

fn copy_dir_recursive(from: &Path, to: &Path) -> Result<(), String> {
    std::fs::create_dir_all(to).map_err(|e| format!("创建 {} 失败: {e}", to.display()))?;
    for entry in std::fs::read_dir(from)
        .map_err(|e| format!("读取 {} 失败: {e}", from.display()))?
        .filter_map(Result::ok)
    {
        let source = entry.path();
        let target = to.join(entry.file_name());
        if source.is_dir() {
            copy_dir_recursive(&source, &target)?;
        } else {
            std::fs::copy(&source, &target)
                .map_err(|e| format!("复制 {} 失败: {e}", source.display()))?;
        }
    }
    Ok(())
}

fn merge_mcp(selected: &[String]) -> Result<Vec<String>, String> {
    let agent = host_agent_dir()?;
    let host_path = agent.join("mcp.json");
    let mut host_doc = crate::pi_settings::read_json_document(&host_path)?
        .unwrap_or_else(|| json!({ "mcpServers": {} }));
    let host_servers = host_doc
        .as_object_mut()
        .ok_or_else(|| "宿主 mcp.json 顶层不是 object".to_string())?
        .entry("mcpServers".to_string())
        .or_insert_with(|| json!({}));
    let host_map = host_servers
        .as_object_mut()
        .ok_or_else(|| "宿主 mcp.json 的 mcpServers 不是 object".to_string())?;
    let mut imported = Vec::new();
    for path in claude_mcp_configs() {
        let servers = read_mcp_servers_from(&path)?;
        for name in selected {
            if host_map.contains_key(name) {
                continue;
            }
            if let Some(spec) = servers.get(name) {
                host_map.insert(name.clone(), spec.clone());
                imported.push(name.clone());
            }
        }
    }
    if !imported.is_empty() {
        crate::pi_settings::atomic_write_json(&host_path, &host_doc)?;
    }
    Ok(imported)
}

/// 导入选中的 Claude 会话（JSONL → pi 会话文件）。
#[tauri::command(rename_all = "camelCase", async)]
pub fn pi_migration_import_sessions(
    state: tauri::State<'_, std::sync::Arc<crate::agui::AguiState>>,
    paths: Vec<String>,
) -> Result<Value, String> {
    let engine = state.inner().clone();
    crate::pi_session::on_big_stack(move || {
        let mut imported: Vec<Value> = Vec::new();
        let mut failed: Vec<Value> = Vec::new();
        for path in paths {
            let text = match std::fs::read_to_string(&path) {
                Ok(text) => text,
                Err(e) => {
                    failed.push(json!({ "path": path, "error": format!("读取失败: {e}") }));
                    continue;
                }
            };
            let parsed = match parse_claude_session(&text) {
                Ok(parsed) => parsed,
                Err(e) => {
                    failed.push(json!({ "path": path, "error": e }));
                    continue;
                }
            };
            let (cwd, title, messages, skipped) = parsed;
            let message_count = messages.len();
            match engine.engine.import_agent_session(&cwd, title.as_deref(), messages) {
                Ok(session_id) => imported.push(json!({
                    "path": path,
                    "sessionId": session_id,
                    "cwd": cwd,
                    "title": title,
                    "messageCount": message_count,
                    "skippedLines": skipped,
                })),
                Err(e) => failed.push(json!({ "path": path, "error": e })),
            }
        }
        Ok(json!({ "imported": imported, "failed": failed }))
    })?
}

/// 执行迁移（仅 Support 的分类）。`skills`/`mcp` 是勾选的名字；
/// `agentsFile` = 是否复制 CLAUDE.md → SYSTEM.md。
#[tauri::command(rename_all = "camelCase", async)]
pub fn pi_migration_import(
    skills: Option<Vec<String>>,
    mcp: Option<Vec<String>>,
    agents_file: Option<bool>,
) -> Result<Value, String> {
    crate::pi_session::on_big_stack(move || {
        let root = claude_root()?;
        let agent = host_agent_dir()?;
        let mut imported_skills: Vec<String> = Vec::new();
        let mut skipped_skills: Vec<String> = Vec::new();
        let mut failed: Vec<Value> = Vec::new();

        for name in skills.unwrap_or_default() {
            let source = root.join("skills").join(&name);
            let target = agent.join("skills").join(&name);
            if !source.is_dir() {
                failed.push(json!({ "kind": "skills", "name": name, "error": "源目录不存在" }));
                continue;
            }
            if target.exists() {
                skipped_skills.push(name);
                continue;
            }
            match copy_dir_recursive(&source, &target) {
                Ok(()) => imported_skills.push(name),
                Err(e) => failed.push(json!({ "kind": "skills", "name": name, "error": e })),
            }
        }

        let imported_mcp = merge_mcp(&mcp.unwrap_or_default())?;

        let mut agents_file_imported = false;
        if agents_file.unwrap_or(false) {
            let source = root.join("CLAUDE.md");
            let target = agent.join("SYSTEM.md");
            if !source.is_file() {
                failed.push(json!({ "kind": "agentsFile", "name": "CLAUDE.md", "error": "源文件不存在" }));
            } else {
                std::fs::copy(&source, &target)
                    .map_err(|e| format!("复制 CLAUDE.md → SYSTEM.md 失败: {e}"))?;
                agents_file_imported = true;
            }
        }

        Ok(json!({
            "imported": {
                "skills": imported_skills,
                "mcp": imported_mcp,
                "agentsFile": agents_file_imported,
            },
            "skipped": { "skills": skipped_skills },
            "failed": failed,
        }))
    })?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn parses_claude_jsonl_into_agent_messages() {
        let text = r#"
{"type":"user","cwd":"/work/demo","timestamp":"2026-01-01T00:00:00Z","message":{"role":"user","content":"hello"}}
{"type":"assistant","cwd":"/work/demo","timestamp":"2026-01-01T00:00:01Z","message":{"role":"assistant","model":"claude-x","content":[{"type":"text","text":"hi"},{"type":"tool_use","id":"t1","name":"read","input":{"path":"a"}}]}}
{"type":"user","cwd":"/work/demo","timestamp":"2026-01-01T00:00:02Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"data","is_error":false}]}}
{"type":"summary","summary":"ignored"}
"#;
        let (cwd, title, messages, skipped) = parse_claude_session(text).unwrap();
        assert_eq!(cwd, "/work/demo");
        assert_eq!(title.as_deref(), Some("hello"));
        assert_eq!(messages.len(), 3);
        assert!(matches!(messages[0], AgentMessage::User(_)));
        assert!(matches!(messages[1], AgentMessage::Assistant(_)));
        match &messages[2] {
            AgentMessage::ToolResult(result) => {
                assert_eq!(result.tool_call_id, "t1");
                assert_eq!(result.tool_name, "read");
            }
            other => panic!("expected tool result, got {other:?}"),
        }
        assert_eq!(skipped, 1);
    }

    #[test]
    fn writes_imported_messages_as_jsonl_session() {
        use rpi_harness::session::jsonl::{
            JsonlSessionCreateOptions, JsonlSessionListOptions, JsonlSessionRepo,
            JsonlSessionRepoOptions,
        };
        use rpi_harness::session::{DefaultIdGenerator, Session, SystemClock};

        let dir = std::env::temp_dir().join(format!(
            "mirach-import-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or_default()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("temp dir");
        let dir_text = dir.to_string_lossy().into_owned();
        let fs: Arc<dyn rpi_tools::FileSystem> =
            Arc::new(rpi_tools::OsExecutionEnv::with_cwd(dir.clone()));
        let repo = JsonlSessionRepo::new(
            JsonlSessionRepoOptions {
                fs,
                sessions_root: dir_text.clone(),
                clock: Arc::new(SystemClock),
                ids: Arc::new(DefaultIdGenerator::new()),
            },
            dir_text.clone(),
        );
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        let id = rt.block_on(async {
            let storage = repo
                .create_typed(&JsonlSessionCreateOptions {
                    id: None,
                    parent_session_id: None,
                    cwd: dir_text.clone(),
                    metadata: None,
                })
                .await
                .expect("create session");
            let session = Session::new(
                Arc::new(storage) as Arc<dyn rpi_harness::session::types::SessionStorage>,
                None,
            );
            session
                .append_message(AgentMessage::User(UserMessage::new("hello", 1)))
                .await
                .expect("append user");
            session
                .append_message(AgentMessage::Assistant(Box::new(AssistantMessage::empty(
                    Api::AnthropicMessages,
                    "claude-code",
                    "claude-test",
                    2,
                ))))
                .await
                .expect("append assistant");
            session.set_name(Some("imported")).await.expect("set name");
            session.get_metadata().await.expect("metadata").id
        });
        let listed = rt
            .block_on(repo.list_typed(&JsonlSessionListOptions { cwd: None }))
            .expect("list");
        assert!(listed.iter().any(|meta| meta.id == id));
        let _ = std::fs::remove_dir_all(&dir);
    }
}

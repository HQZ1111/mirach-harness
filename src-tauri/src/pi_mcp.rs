//! MCP 管理页（竖链移植降级：rpi-main v0.24.0 无 MCP 模块——待 rpi-main
//! 长出 MCP 能力后按 pi::mcp 同形状接回；旧实现存档于 git df701a4）。
//!
//! 旧实现（df701a4）：分层读 .pi/mcp.json → McpDiscovery::discover（旧 pi
//! crate 的 mcp 模块）+ McpManager::test 真起进程 + read/write_project_config
//! RMW。rpi 工作区无 MCP 对应物——全部如实降级 Err。

use serde_json::Value;

/// MCP 服务器列表（rpi 无 MCP 模块——如实降级）。
#[tauri::command(async)]
pub fn pi_mcp_servers(_cwd: Option<String>, _project_trusted: bool) -> Result<Value, String> {
    Err("rpi 引擎待接：MCP 管理（rpi-main v0.24.0 尚无 MCP 模块）".into())
}

#[tauri::command(async)]
pub fn pi_mcp_upsert_server(_cwd: String, _name: String, _spec: Value) -> Result<Value, String> {
    Err("rpi 引擎待接：MCP 管理".into())
}

#[tauri::command(async)]
pub fn pi_mcp_remove_server(_cwd: String, _name: String) -> Result<Value, String> {
    Err("rpi 引擎待接：MCP 管理".into())
}

#[tauri::command(async)]
pub fn pi_mcp_test_server(_cwd: String, _name: String, _project_trusted: bool) -> Result<Value, String> {
    Err("rpi 引擎待接：MCP 测试".into())
}

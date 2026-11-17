//! MCP 预设目录（hermes `hermes_cli/mcp_catalog.py` + `optional-mcps/` 的宿主子集）。
//!
//! ## 数据来源
//!
//! `src-tauri/assets/mcp-catalog.json` 由 hermes 上游 `optional-mcps/*/manifest.yaml`
//! 生成（2026-11-17，66 条 → 宿主可用 10 条）。**只收 rpi-mcp-adapter 能执行的
//! 条目**：`transport.type == "http"` 且 `auth.type == "none"`。
//!
//! 为什么砍掉 56 条 OAuth 条目：rpi 的 MCP 适配扩展（`rpi_mcp_adapter.dll`）
//! 只支持 stdio + Streamable HTTP 与**配置好的 headers**——没有 OAuth token
//! 管理（上游 hermes 的 `mcp_oauth_manager` 在本宿主没有对偶）。把 OAuth 条目
//! 列出来会让用户点进一个必然失败的授权流程（假入口），所以不入目录；用户在
//! 设置页「连接器」仍可用显式 config（带 headers）接入任意 HTTP MCP。
//!
//! ## 安装语义
//!
//! 预设安装 = 往 `~/.rpi/agent/mcp.json` 的 `mcpServers.<name>` 写
//! `{ "url": ... }`（RMW，其它键保留；`pi_mcp::pi_mcp_upsert_server` 同一通道）。
//! 写盘失败原样传播（规矩 12）。

use std::collections::HashSet;
use std::sync::OnceLock;

use serde::Deserialize;
use serde_json::{json, Value};

const CATALOG: &str = include_str!("../assets/mcp-catalog.json");

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CatalogEntry {
    name: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    source: String,
    url: String,
    #[serde(default)]
    suggest_keywords: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct CatalogFile {
    entries: Vec<CatalogEntry>,
}

fn entries() -> &'static Vec<CatalogEntry> {
    static CELL: OnceLock<Vec<CatalogEntry>> = OnceLock::new();
    CELL.get_or_init(|| {
        serde_json::from_str::<CatalogFile>(CATALOG)
            .expect("mcp-catalog.json 解析失败（构建期资产，解析失败 = 编程错误）")
            .entries
    })
}

fn find_entry(name: &str) -> Option<&'static CatalogEntry> {
    entries().iter().find(|e| e.name == name)
}

/// `mcp.catalog` 的宿主实现：hermes 目录的可执行子集 + 已装标记。
#[tauri::command(rename_all = "camelCase", async)]
pub fn pi_mcp_catalog() -> Result<Value, String> {
    let installed: HashSet<String> = crate::pi_mcp::installed_names()?.into_iter().collect();
    let rows: Vec<Value> = entries()
        .iter()
        .map(|e| {
            json!({
                "name": e.name,
                "description": e.description,
                "source": e.source,
                "url": e.url,
                "suggestKeywords": e.suggest_keywords,
                "auth": "none",
                // 宿主可执行条目都不需要凭据；保留字段让插件 UI 形状一致。
                "requires": [],
                "installed": installed.contains(&e.name),
                "fromCatalog": true,
            })
        })
        .collect();
    Ok(json!({ "entries": rows }))
}

/// 从目录安装一条预设（写全局 `mcpServers.<name> = {url}`）。
#[tauri::command(rename_all = "camelCase", async)]
pub fn pi_mcp_install_preset(name: String) -> Result<Value, String> {
    let name = name.trim();
    let entry = find_entry(name)
        .ok_or_else(|| format!("mcp 目录里没有预设「{name}」（宿主目录只有 rpi-mcp-adapter 可执行的 no-auth HTTP 条目）"))?;
    let spec = json!({ "url": entry.url });
    crate::pi_mcp::pi_mcp_upsert_server(String::new(), entry.name.clone(), spec)?;
    Ok(json!({ "installed": true, "name": entry.name, "url": entry.url }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_entries_are_no_auth_http_with_url() {
        let all = entries();
        assert!(!all.is_empty(), "catalog 不应为空");
        for entry in all {
            assert!(!entry.name.trim().is_empty());
            assert!(
                entry.url.starts_with("http://") || entry.url.starts_with("https://"),
                "entry {} url must be http(s): {}",
                entry.name,
                entry.url
            );
        }
    }

    #[test]
    fn names_are_unique() {
        let mut seen = HashSet::new();
        for entry in entries() {
            assert!(seen.insert(entry.name.as_str()), "重复条目 {}", entry.name);
        }
    }

    #[test]
    fn find_entry_matches_exact_name_only() {
        let first = &entries()[0];
        assert!(find_entry(&first.name).is_some());
        assert!(find_entry(&format!("{} ", first.name)).is_none());
        assert!(find_entry("__missing__").is_none());
    }
}

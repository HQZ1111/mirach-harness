//! 会话管理元数据的**持久化真相层**（生产级，hermes 后端模式对齐——
//! hermes 的 pinned/archived/unread 存后端 session 索引；pi 无此后端，
//! 由 harness 宿主承载）。前端 sessionCatalog 是投影：启动经
//! `session_meta_get` 水合、变更经 `session_meta_set` 全量写穿。
//!
//! 存储文件：`<app_data_dir>/session-meta.json`（原子写：tmp + rename，
//! 防半写文档——生产级纪律，与 pi_settings 的落盘同形）。
//!
//! 字段（camelCase 与前端 SessionCatalogState 管理维度一一对应）：
//! pinned / manualOrder / archived / seen / markers / groupsCollapsed。
//!
//! 旧 localStorage 键的一次性迁移在前端 hydrate 完成（此处只管文件）。

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::Manager;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SessionMetaStore {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub pinned: Vec<String>,
    #[serde(default, skip_serializing_if = "std::collections::HashMap::is_empty")]
    pub manual_order: std::collections::HashMap<String, i64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub archived: Vec<String>,
    #[serde(default, skip_serializing_if = "std::collections::HashMap::is_empty")]
    pub seen: std::collections::HashMap<String, i64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub markers: Vec<String>,
    #[serde(default, skip_serializing_if = "std::collections::HashMap::is_empty")]
    pub groups_collapsed: std::collections::HashMap<String, bool>,
    /// 页签条隐藏开关（region → hidden；用户「切换标签」的选择持久化——
    /// boot sync 依此区分「用户主动隐藏」与「竖轨残留」，后者才修）。
    #[serde(default, skip_serializing_if = "std::collections::HashMap::is_empty")]
    pub strip_hidden: std::collections::HashMap<String, bool>,
}

fn store_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir 解析失败: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("app_data_dir 创建失败: {e}"))?;
    Ok(dir.join("session-meta.json"))
}

fn read_store(path: &PathBuf) -> Result<SessionMetaStore, String> {
    if !path.exists() {
        return Ok(SessionMetaStore::default());
    }
    let content = std::fs::read_to_string(path)
        .map_err(|e| format!("session-meta.json 读取失败: {e}"))?;
    if content.trim().is_empty() {
        return Ok(SessionMetaStore::default());
    }
    serde_json::from_str(&content).map_err(|e| format!("session-meta.json 形状非法: {e}"))
}

/// 原子写：先写同目录 tmp，再 rename 覆盖（半写文档不会出现）。
fn write_store(path: &PathBuf, store: &SessionMetaStore) -> Result<(), String> {
    let json = serde_json::to_string_pretty(store)
        .map_err(|e| format!("session-meta.json 序列化失败: {e}"))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| format!("session-meta.json.tmp 写入失败: {e}"))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("session-meta.json 原子替换失败: {e}"))?;
    Ok(())
}

pub struct SessionMetaPath(pub Mutex<Option<PathBuf>>);

#[tauri::command]
pub fn session_meta_get(
    app: tauri::AppHandle,
    state: tauri::State<'_, SessionMetaPath>,
) -> Result<SessionMetaStore, String> {
    let mut guard = state.0.lock().map_err(|_| "session-meta 锁中毒")?;
    if guard.is_none() {
        *guard = Some(store_path(&app)?);
    }
    read_store(guard.as_ref().expect("刚初始化"))
}

#[tauri::command]
pub fn session_meta_set(
    app: tauri::AppHandle,
    state: tauri::State<'_, SessionMetaPath>,
    store: SessionMetaStore,
) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|_| "session-meta 锁中毒")?;
    if guard.is_none() {
        *guard = Some(store_path(&app)?);
    }
    write_store(guard.as_ref().expect("刚初始化"), &store)
}

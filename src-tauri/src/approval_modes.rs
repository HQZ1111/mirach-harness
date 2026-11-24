//! 会话级审批模式持久化（full access 的宿主侧真相）。
//!
//! 引擎 `approval_gate` 的审批模式原本是进程级；桌面宿主把它改成
//! **按会话 pin**（引擎侧 `set_session_mode`）。本模块负责让 pin 跨重启
//! 保留：`<agent_dir>/approval-modes.json`，键 = 引擎会话 id，值 =
//! `always-ask` / `write` / `yolo`。
//!
//! 写入 = tmp + rename（与 app-prefs / session-meta 同款）；读取失败 /
//! 未知值不静默吞：返回 Err，调用方决定（安装会话时记 stderr 并继续用
//! 默认审批，不阻断会话打开）。
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use rpi_cli::approval_gate::ApprovalMode;

static CACHE: OnceLock<Mutex<Option<HashMap<String, String>>>> = OnceLock::new();

fn cache() -> &'static Mutex<Option<HashMap<String, String>>> {
    CACHE.get_or_init(|| Mutex::new(None))
}

fn store_path() -> Result<PathBuf, String> {
    let dir = crate::pi_paths::agent_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("approval-modes 目录创建失败: {e}"))?;
    Ok(dir.join("approval-modes.json"))
}

fn load_from_disk() -> Result<HashMap<String, String>, String> {
    let path = store_path()?;
    match std::fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text)
            .map_err(|e| format!("approval-modes.json 解析失败（{}）：{e}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(HashMap::new()),
        Err(e) => Err(format!(
            "approval-modes.json 读取失败（{}）：{e}",
            path.display()
        )),
    }
}

fn write_to_disk(map: &HashMap<String, String>) -> Result<(), String> {
    let path = store_path()?;
    let tmp = path.with_extension("json.tmp");
    let text = serde_json::to_string_pretty(map)
        .map_err(|e| format!("approval-modes.json 序列化失败: {e}"))?;
    std::fs::write(&tmp, text)
        .map_err(|e| format!("approval-modes.json 写入失败（{}）：{e}", tmp.display()))?;
    std::fs::rename(&tmp, &path)
        .map_err(|e| format!("approval-modes.json 落盘失败（{}）：{e}", path.display()))
}

fn with_map<R>(f: impl FnOnce(&mut HashMap<String, String>) -> Result<R, String>) -> Result<R, String> {
    let mut guard = cache()
        .lock()
        .map_err(|_| "approval-modes 缓存锁中毒".to_string())?;
    if guard.is_none() {
        *guard = Some(load_from_disk()?);
    }
    let map = guard.as_mut().expect("cache initialized");
    let before = map.clone();
    let result = f(map)?;
    if *map != before {
        write_to_disk(map)?;
    }
    Ok(result)
}

/// 该会话 pin 的审批模式；没有 pin = None（引擎回退到进程默认）。
pub fn mode_for(session_id: &str) -> Result<Option<ApprovalMode>, String> {
    let id = session_id.trim();
    if id.is_empty() {
        return Ok(None);
    }
    with_map(|map| match map.get(id) {
        None => Ok(None),
        Some(raw) => ApprovalMode::parse(raw)
            .map(Some)
            .ok_or_else(|| format!("approval-modes.json 里会话 {id} 的模式未知：{raw}")),
    })
}

/// 写入/覆盖一个会话的 pin。
///
/// `Planning` **拒绝落盘**：计划态是 rpi-plan-mode 的运行期 static，
/// 进程重启后插件不恢复 active；写进文件会在重启后留下假的计划态。
pub fn set_mode(session_id: &str, mode: ApprovalMode) -> Result<(), String> {
    let id = session_id.trim();
    if id.is_empty() {
        return Err("会话 id 为空，无法持久化审批模式".into());
    }
    if mode == ApprovalMode::Planning {
        return Err("planning 是运行期计划态，不能持久化到 approval-modes.json".into());
    }
    with_map(|map| {
        map.insert(id.to_owned(), mode.as_wire().to_owned());
        Ok(())
    })
}

/// 删除一个会话的 pin（删会话时清理；未知 id 幂等）。
pub fn clear_mode(session_id: &str) -> Result<(), String> {
    let id = session_id.trim();
    if id.is_empty() {
        return Ok(());
    }
    with_map(|map| {
        map.remove(id);
        Ok(())
    })
}

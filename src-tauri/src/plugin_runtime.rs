//! Desktop plugin runtime — the host side of hot-pluggable plugins.
//!
//! Upstream hermes loads runtime plugins from `<hermes home>/desktop-plugins/<name>/plugin.js`
//! (plain ESM, evaluated in the renderer with the SDK injected). The Mirach host
//! keeps the same door but under its app-data dir:
//!
//!   <app_data_dir>/desktop-plugins/<name>/plugin.js
//!
//! The renderer (`src/hermes-shim/contrib/runtime-loader.ts`) scans, imports,
//! registers and reloads these files; this module only owns the filesystem
//! primitives. No watcher here: the loader polls mtime (cheap, and works on
//! every platform without an extra crate) so a saved file hot-reloads in place.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::Manager;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginFile {
    pub id: String,
    pub name: String,
    pub path: String,
    pub mtime_ms: u64,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginSource {
    pub id: String,
    pub source: String,
    pub mtime_ms: u64,
}

fn root_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app data dir unavailable: {e}"))?
        .join("desktop-plugins");
    fs::create_dir_all(&dir).map_err(|e| format!("create {} failed: {e}", dir.display()))?;
    Ok(dir)
}

/// Plugin ids become directory names: reject separators / dot-dot outright.
fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id != "."
        && id != ".."
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

fn mtime_ms(meta: &fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn plugin_js(dir: &Path) -> PathBuf {
    dir.join("plugin.js")
}

#[tauri::command]
pub fn plugin_runtime_root(app: tauri::AppHandle) -> Result<String, String> {
    Ok(root_dir(&app)?.to_string_lossy().to_string())
}

#[tauri::command]
pub fn plugin_runtime_scan(app: tauri::AppHandle) -> Result<Vec<PluginFile>, String> {
    let root = root_dir(&app)?;
    let mut out = Vec::new();
    let entries = fs::read_dir(&root).map_err(|e| format!("read {} failed: {e}", root.display()))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("read dir entry failed: {e}"))?;
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let Some(id) = dir.file_name().and_then(|n| n.to_str()).map(str::to_owned) else {
            continue;
        };
        if !valid_id(&id) {
            continue;
        }
        let file = plugin_js(&dir);
        let Ok(meta) = fs::metadata(&file) else {
            continue;
        };
        if !meta.is_file() {
            continue;
        }
        let name = fs::read_to_string(dir.join("name.txt"))
            .ok()
            .map(|s| s.trim().to_owned())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| id.clone());
        out.push(PluginFile {
            id,
            name,
            path: file.to_string_lossy().to_string(),
            mtime_ms: mtime_ms(&meta),
            size: meta.len(),
        });
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(out)
}

#[tauri::command]
pub fn plugin_runtime_read(app: tauri::AppHandle, id: String) -> Result<PluginSource, String> {
    if !valid_id(&id) {
        return Err(format!("invalid plugin id: {id}"));
    }
    let file = plugin_js(&root_dir(&app)?.join(&id));
    let meta = fs::metadata(&file).map_err(|e| format!("read {} failed: {e}", file.display()))?;
    if !meta.is_file() {
        return Err(format!("not a file: {}", file.display()));
    }
    let source =
        fs::read_to_string(&file).map_err(|e| format!("read {} failed: {e}", file.display()))?;
    Ok(PluginSource {
        id,
        source,
        mtime_ms: mtime_ms(&meta),
    })
}

/// Create/overwrite `<root>/<id>/plugin.js` (the install door for hot-plug).
#[tauri::command]
pub fn plugin_runtime_write(
    app: tauri::AppHandle,
    id: String,
    source: String,
    name: Option<String>,
) -> Result<String, String> {
    if !valid_id(&id) {
        return Err(format!("invalid plugin id: {id}"));
    }
    let dir = root_dir(&app)?.join(&id);
    fs::create_dir_all(&dir).map_err(|e| format!("create {} failed: {e}", dir.display()))?;
    let file = plugin_js(&dir);
    fs::write(&file, source).map_err(|e| format!("write {} failed: {e}", file.display()))?;
    if let Some(name) = name.filter(|n| !n.trim().is_empty()) {
        fs::write(dir.join("name.txt"), name.trim())
            .map_err(|e| format!("write name.txt failed: {e}"))?;
    }
    Ok(file.to_string_lossy().to_string())
}

#[tauri::command]
pub fn plugin_runtime_uninstall(app: tauri::AppHandle, id: String) -> Result<(), String> {
    if !valid_id(&id) {
        return Err(format!("invalid plugin id: {id}"));
    }
    let dir = root_dir(&app)?.join(&id);
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|e| format!("remove {} failed: {e}", dir.display()))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::valid_id;

    #[test]
    fn ids_reject_path_traversal() {
        for bad in ["", ".", "..", "a/b", "a\\b", "../x"] {
            assert!(!valid_id(bad), "{bad:?} must be rejected");
        }
        for good in ["bots", "my-plugin", "a.b_c-1"] {
            assert!(valid_id(good), "{good:?} must be accepted");
        }
    }
}

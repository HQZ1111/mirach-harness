//! Local filesystem bridge — the port's counterpart of hermes' Electron main
//! handlers (`electron/fs-ipc.ts`'s `hermes:fs:readDir` / `hermes:fs:gitRoot`
//! and the `readFileDataUrl` handler behind `hermes:fs:readDataUrl`).
//!
//! The renderer keeps hermes' call shape: `lib/desktop-fs.ts` still calls
//! `readDir(path) -> { entries, error? }`, `gitRoot(path) -> string | null`
//! and `readFileDataUrl(path) -> string`. Only the transport changed —
//! `ipcRenderer.invoke('hermes:fs:readDir', …)` became
//! `invoke('fs_list', …)` (see `src/mock/desktop-bridge.ts`).
//!
//! Semantics copied from `electron/fs-read-dir.ts` / `electron/git-root.ts`:
//! entries are `{ name, path, isDirectory }`, directories sort first and names
//! alphabetically, unreadable paths return an error CODE instead of throwing,
//! and the always-hidden noise set is filtered before the renderer sees it.

use std::fs;
use std::path::{Path, PathBuf};

use base64::Engine;
use serde::Serialize;

/// `FS_READDIR_HIDDEN` — hermes hides these at the Electron layer, before the
/// renderer's own `ALWAYS_EXCLUDED` pass (which is a superset).
const READDIR_HIDDEN: &[&str] = &[
    ".git",
    ".hg",
    ".svn",
    ".cache",
    ".next",
    ".turbo",
    ".venv",
    "__pycache__",
    "build",
    "dist",
    "node_modules",
    "target",
    "venv",
];

/// A directory listing is bounded so one enormous file can't be pulled into the
/// webview as a data URL (hermes' `readFileDataUrl` is capped the same way).
const DATA_URL_MAX_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Serialize)]
pub struct FsEntry {
    name: String,
    path: String,
    #[serde(rename = "isDirectory")]
    is_directory: bool,
}

/// hermes' `HermesReadDirResult`: `error` is omitted on success.
#[derive(Serialize)]
pub struct FsListResult {
    entries: Vec<FsEntry>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

fn ok(entries: Vec<FsEntry>) -> FsListResult {
    FsListResult {
        entries,
        error: None,
    }
}

fn failed(code: &str) -> FsListResult {
    FsListResult {
        entries: Vec::new(),
        error: Some(code.to_string()),
    }
}

/// Node-style error code, which is what the renderer prints in its
/// "Could not read this folder (…)" copy.
fn error_code(error: &std::io::Error) -> &'static str {
    match error.kind() {
        std::io::ErrorKind::NotFound => "ENOENT",
        std::io::ErrorKind::PermissionDenied => "EACCES",
        std::io::ErrorKind::NotADirectory => "ENOTDIR",
        _ => "read-error",
    }
}

/// `hermes:fs:readDir` — `readDirForIpc(dirPath)`.
#[tauri::command]
pub fn fs_list(path: String) -> FsListResult {
    let trimmed = path.trim();

    if trimmed.is_empty() {
        return failed("invalid-path");
    }

    let dir = PathBuf::from(trimmed);
    let read = match fs::read_dir(&dir) {
        Ok(read) => read,
        Err(error) => return failed(error_code(&error)),
    };

    let mut entries = Vec::new();

    for entry in read.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();

        if READDIR_HIDDEN.contains(&name.as_str()) {
            continue;
        }

        let full = entry.path();
        // `metadata` follows symlinks, so a symlink to a directory reads as a
        // directory (hermes stats symlinks and unknown entries for the same
        // reason). An entry we can't stat stays a leaf rather than dropping the
        // whole listing.
        let is_directory = fs::metadata(&full).map(|meta| meta.is_dir()).unwrap_or(false);

        entries.push(FsEntry {
            name,
            path: full.to_string_lossy().into_owned(),
            is_directory,
        });
    }

    // Directories before files, then by name (case-insensitive with a
    // case-sensitive tiebreak, the closest match to the renderer's
    // `localeCompare` ordering that stays locale-free).
    entries.sort_by(|a, b| {
        b.is_directory
            .cmp(&a.is_directory)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            .then_with(|| a.name.cmp(&b.name))
    });

    ok(entries)
}

/// `hermes:fs:gitRoot` — `gitRootForIpc(startPath)`: walk up from `start`
/// looking for a `.git` entry, at most 50 levels (hermes' own bound).
#[tauri::command]
pub fn fs_git_root(path: String) -> Option<String> {
    let trimmed = path.trim();

    if trimmed.is_empty() {
        return None;
    }

    let resolved = PathBuf::from(trimmed);

    // A file (or a path that no longer exists) starts the walk at its parent.
    let start = match fs::metadata(&resolved) {
        Ok(meta) if meta.is_dir() => resolved,
        Ok(_) => resolved.parent().map(Path::to_path_buf).unwrap_or(resolved),
        Err(_) => resolved,
    };

    let mut dir = start;

    for _ in 0..50 {
        if dir.join(".git").exists() {
            return Some(dir.to_string_lossy().into_owned());
        }

        match dir.parent() {
            Some(parent) => dir = parent.to_path_buf(),
            None => return None,
        }
    }

    None
}

/// Minimal extension → MIME map for the data URLs the renderer decodes (the
/// project tree only ever reads `.gitignore`; previews read images and text).
fn mime_for(path: &Path) -> &'static str {
    // A dotfile (`.gitignore`) has no `extension()` in Rust's terms.
    if path
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.starts_with('.') && !name[1..].contains('.'))
    {
        return "text/plain";
    }

    match path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
        .as_deref()
    {
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("svg") => "image/svg+xml",
        Some("ico") => "image/x-icon",
        Some("bmp") => "image/bmp",
        Some("pdf") => "application/pdf",
        Some("json") => "application/json",
        Some("js") | Some("mjs") | Some("cjs") => "text/javascript",
        Some("css") => "text/css",
        Some("html") | Some("htm") => "text/html",
        Some("md") | Some("markdown") => "text/markdown",
        Some("yml") | Some("yaml") => "text/yaml",
        Some("xml") => "text/xml",
        Some("ts") | Some("tsx") => "text/plain",
        Some("txt") | Some("log") | Some("gitignore") | Some("env") => "text/plain",
        _ => "application/octet-stream",
    }
}

/// The `readFileDataUrl` half of hermes' bridge: `data:<mime>;base64,<bytes>`.
#[tauri::command]
pub fn fs_read_data_url(path: String) -> Result<String, String> {
    let trimmed = path.trim();

    if trimmed.is_empty() {
        return Err("invalid-path".to_string());
    }

    let file = PathBuf::from(trimmed);
    let meta = fs::metadata(&file).map_err(|error| error_code(&error).to_string())?;

    if meta.len() > DATA_URL_MAX_BYTES {
        return Err("too-large".to_string());
    }

    let bytes = fs::read(&file).map_err(|error| error_code(&error).to_string())?;
    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);

    Ok(format!("data:{};base64,{}", mime_for(&file), encoded))
}

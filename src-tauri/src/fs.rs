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
    /// 入口本身是符号链接/junction（不跟随也成立的标记）。文件树的空目录链
    /// 自动展开靠它跳过软链接目录，避免 junction 指向祖先时无限递归加载。
    #[serde(rename = "isSymlink")]
    is_symlink: bool,
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
        // `symlink_metadata` 不跟随链接：入口自己是 symlink/junction 时为 true。
        let is_symlink = fs::symlink_metadata(&full)
            .map(|meta| meta.file_type().is_symlink())
            .unwrap_or(false);

        entries.push(FsEntry {
            name,
            path: full.to_string_lossy().into_owned(),
            is_directory,
            is_symlink,
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

/// 导出落盘（hermes row.export 的写半边：save 对话框给出目标路径后由
/// 宿主写文件——Electron 里走 Blob 下载，Tauri 无下载通道）。UTF-8 直写；
/// 路径非法/写失败一律 Err 传播（禁止兜底），不创建缺失的父目录。
#[tauri::command(rename_all = "camelCase")]
pub fn fs_write_text_file(path: String, contents: String) -> Result<(), String> {
    let trimmed = path.trim();

    if trimmed.is_empty() {
        return Err("invalid-path".to_string());
    }

    fs::write(PathBuf::from(trimmed), contents.into_bytes())
        .map_err(|error| error_code(&error).to_string())
}

// ── Git 变更统计（活动面板「环境」分区，docs/engine-gaps.md G6）─────────

/// 工作区变更统计（活动面板 Environment 分区数据面）：跑
/// `git -C <dir> diff --numstat HEAD` + `git -C <dir> status --porcelain`
/// 汇总为 `{isRepository, added, removed, changedFiles, branch}`。
///
/// **语义（对齐 ZCode 的诚实口径）**：这是**工作区当前状态**（相对 HEAD 的
/// 未提交变更），不是"本会话改动"——用户手动改的文件也算。要精确到"本会话"
/// 需 ZCode 那种 taskChangeSummary 概念（pi 无，见 G6）。
///
/// - 非仓库 / git 不可用 → `isRepository:false`（渲染层隐藏分区，不报错）。
/// - `--numstat` 输出 `added\tremoved\tpath`（二进制文件为 `-\t-\tpath`，
///   计为 0/0 但计入 changedFiles）。
/// - git 命令失败（非仓库以外，如权限）→ Err 传播（不静默降级为 0）。
#[tauri::command]
pub fn fs_git_diff_stat(path: String) -> Result<GitDiffStat, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("invalid-path".to_string());
    }
    let dir = PathBuf::from(trimmed);
    let root = match fs_git_root(trimmed.to_string()) {
        Some(r) => r,
        None => return Ok(GitDiffStat::not_a_repo()),
    };

    let numstat = git_output(&dir, &["diff", "--numstat", "HEAD"])?;
    let status = git_output(&dir, &["status", "--porcelain"])?;
    let branch = git_output(&dir, &["rev-parse", "--abbrev-ref", "HEAD"])
        .map(|s| s.trim().to_string())
        .ok();

    let (added, removed, changed) = parse_numstat(&numstat);
    let changed_files = changed.max(parse_porcelain_changed(&status));

    Ok(GitDiffStat {
        is_repository: true,
        root,
        branch,
        added,
        removed,
        changed_files,
    })
}

/// `git -C <dir> <args>` 的 stdout；退出码非 0 → Err（含 stderr 摘要）。
fn git_output(dir: &Path, args: &[&str]) -> Result<String, String> {
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .map_err(|e| format!("git 不可用: {e}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!("git {:?} 失败: {}", args, stderr.trim()));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// 解析 `git diff --numstat HEAD`：每行 `added\tremoved\tpath`（二进制为
/// `-\t-`）。返回 (added, removed, 文件数)。空行/畸形行跳过（不 panic）。
fn parse_numstat(raw: &str) -> (u64, u64, usize) {
    let mut added = 0u64;
    let mut removed = 0u64;
    let mut files = 0usize;
    for line in raw.lines() {
        let line = line.trim_end();
        if line.is_empty() {
            continue;
        }
        let mut parts = line.splitn(3, '\t');
        let (Some(a), Some(r)) = (parts.next(), parts.next()) else {
            continue;
        };
        if parts.next().is_none() {
            continue; // 缺路径列的畸形行
        }
        // 二进制文件是 "-"：计文件数，不计行数
        added += a.parse::<u64>().unwrap_or(0);
        removed += r.parse::<u64>().unwrap_or(0);
        files += 1;
    }
    (added, removed, files)
}

/// 解析 `git status --porcelain` 的变更条目数（含未跟踪 `??`；`!!` 忽略项
/// 不计）。
fn parse_porcelain_changed(raw: &str) -> usize {
    raw.lines()
        .filter(|l| {
            let l = l.trim_end();
            !l.is_empty() && !l.starts_with("!!")
        })
        .count()
}

/// 工作区变更统计（`fs_git_diff_stat` 返回体；serde camelCase）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffStat {
    #[serde(rename = "isRepository")]
    is_repository: bool,
    /// 仓库根（非仓库时为空串）
    root: String,
    /// 当前分支（detached 时 = "HEAD"；非仓库/查询失败 = null）
    branch: Option<String>,
    added: u64,
    removed: u64,
    changed_files: usize,
}

impl GitDiffStat {
    fn not_a_repo() -> Self {
        Self {
            is_repository: false,
            root: String::new(),
            branch: None,
            added: 0,
            removed: 0,
            changed_files: 0,
        }
    }
}

#[cfg(test)]
mod git_stat_tests {
    //! `fs_git_diff_stat` 的纯解析单测（不跑 git——git 调用是端到端行为，
    //! 留冒烟）。覆盖 numstat（普通/二进制/空/畸形）与 porcelain 计数
    //! （含未跟踪、忽略项排除）。

    use super::*;

    #[test]
    fn numstat_sums_normal_lines() {
        let raw = "10\t2\tsrc/a.rs\n3\t0\tsrc/b.rs\n";
        assert_eq!(parse_numstat(raw), (13, 2, 2));
    }

    #[test]
    fn numstat_counts_binary_as_file_only() {
        // 二进制："-\t-\tpath" — 计文件数，行数不计
        let raw = "-\t-\tassets/logo.png\n5\t1\tsrc/x.rs\n";
        assert_eq!(parse_numstat(raw), (5, 1, 2));
    }

    #[test]
    fn numstat_empty_and_malformed_skipped() {
        let raw = "\n\nbogus\n1\t2\n";
        // "bogus" 无制表符、"1\t2" 缺路径列 → 都跳过；结果零
        assert_eq!(parse_numstat(raw), (0, 0, 0));
    }

    #[test]
    fn porcelain_counts_entries_excludes_ignored() {
        let raw = " M src/a.rs\n?? new.txt\n!! ignored.log\n M src/b.rs\n";
        assert_eq!(parse_porcelain_changed(raw), 3);
    }

    #[test]
    fn porcelain_empty_is_zero() {
        assert_eq!(parse_porcelain_changed(""), 0);
    }

    #[test]
    fn not_a_repo_shape() {
        let s = GitDiffStat::not_a_repo();
        assert!(!s.is_repository);
        assert_eq!(s.added, 0);
        assert_eq!(s.changed_files, 0);
        assert!(s.branch.is_none());
    }
}

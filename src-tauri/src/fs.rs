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
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};

use base64::Engine;
use serde::Serialize;

use crate::win_proc::HideConsole;

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
        Some("heic") => "image/heic",
        Some("avif") => "image/avif",
        Some("pdf") => "application/pdf",
        Some("doc") => "application/msword",
        Some("docx") => {
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        }
        Some("xls") => "application/vnd.ms-excel",
        Some("xlsx") => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        Some("ppt") => "application/vnd.ms-powerpoint",
        Some("pptx") => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        Some("mp4") => "video/mp4",
        Some("webm") => "video/webm",
        Some("mov") => "video/quicktime",
        Some("m4v") => "video/x-m4v",
        Some("mkv") => "video/x-matroska",
        Some("avi") => "video/x-msvideo",
        Some("mp3") => "audio/mpeg",
        Some("wav") => "audio/wav",
        Some("m4a") => "audio/mp4",
        Some("aac") => "audio/aac",
        Some("ogg") | Some("oga") => "audio/ogg",
        Some("opus") => "audio/opus",
        Some("flac") => "audio/flac",
        Some("csv") => "text/csv",
        Some("tsv") => "text/tab-separated-values",
        Some("rtf") => "application/rtf",
        Some("epub") => "application/epub+zip",
        Some("json") => "application/json",
        Some("jsonl") => "application/jsonl",
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

/// 附件选择器的单文件元数据（attachments.ts `pickAttachmentFiles` 消费）：
/// 名字 / 绝对路径 / 字节数 / 推断 MIME。文件不存在或不可读一律 Err。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsStat {
    name: String,
    path: String,
    size: u64,
    mime: String,
}

#[tauri::command]
pub fn fs_stat(path: String) -> Result<FsStat, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("invalid-path".to_string());
    }
    let file = PathBuf::from(trimmed);
    let meta = fs::metadata(&file).map_err(|error| error_code(&error).to_string())?;
    if !meta.is_file() {
        return Err("not-a-file".to_string());
    }
    let name = file
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(trimmed)
        .to_string();
    Ok(FsStat {
        name,
        path: file.to_string_lossy().into_owned(),
        size: meta.len(),
        mime: mime_for(&file).to_string(),
    })
}

/// 拖放附件落临时文件的上限（attachments.ts STAGE_MAX_BYTES 同源）。
const ATTACHMENT_STAGE_MAX_BYTES: usize = 48 * 1024 * 1024;

/// 拖放的非图片附件 → 宿主临时文件，返回绝对路径。
///
/// 为什么需要：Tauri 窗口 `dragDropEnabled:false` 时 OS 拖放走 HTML5
/// File（只有字节、没有路径）；而视频/音频/文档的发送契约是"绝对路径让
/// 模型用工具读"。这里把字节落盘到 `%TEMP%/mirach-attachments/`，路径随
/// prompt 引用块发给引擎。文件名只保留可打印安全字符（防路径穿越）。
#[tauri::command(rename_all = "camelCase")]
pub fn attachment_stage(name: String, data_base64: String) -> Result<String, String> {
    if data_base64.is_empty() {
        return Err("empty attachment".to_string());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64.as_bytes())
        .map_err(|error| format!("invalid base64: {error}"))?;
    if bytes.is_empty() {
        return Err("empty attachment".to_string());
    }
    if bytes.len() > ATTACHMENT_STAGE_MAX_BYTES {
        return Err(format!(
            "too-large: {} bytes (max {ATTACHMENT_STAGE_MAX_BYTES})",
            bytes.len()
        ));
    }
    // 安全文件名：只留字母数字与 . - _ 空格；去掉前导点/分隔符（防 ../）
    let safe: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | ' ') {
                c
            } else {
                '_'
            }
        })
        .collect();
    let safe = safe.trim().trim_start_matches('.').trim().to_string();
    let safe = if safe.is_empty() { "attachment".to_string() } else { safe };

    let dir = std::env::temp_dir().join("mirach-attachments");
    fs::create_dir_all(&dir).map_err(|error| format!("create temp dir failed: {error}"))?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| format!("system clock: {error}"))?
        .as_nanos();
    let path = dir.join(format!("{stamp}-{safe}"));
    fs::write(&path, bytes).map_err(|error| format!("write staged file failed: {error}"))?;
    Ok(path.to_string_lossy().into_owned())
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

/// 批量路径存在性（设置页「项目 → 未使用检测」的根目录缺失判定，ZCode
/// `primaryRootStatus === "missing"` 的宿主等价物）。只读探测：空路径 = false；
/// 其它按 `Path::exists`（不存在与探测失败同为 false——"现在用不了"是本页
/// 要展示的事实，不区分原因）。
#[tauri::command(rename_all = "camelCase")]
pub fn fs_paths_exist(paths: Vec<String>) -> Vec<bool> {
    paths
        .iter()
        .map(|path| {
            let trimmed = path.trim();
            !trimmed.is_empty() && std::path::Path::new(trimmed).exists()
        })
        .collect()
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
        .hide_console()
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

// ── git 审查面（hermes 桌面 review 桥的 Rust 对应物，2026-10-26）─────────
//
// hermes 的审查数据面是桌面宿主桥（`lib/desktop-git.ts` 的
// `review.list / diff / stage / unstage / revert / commit / push / shipInfo`），
// 后端处理进程不在 mirach 仓库里——这里按同一语义用 `git` 子进程直接实现。
// 语义对齐点：
// - 列表 = 未提交范围（工作树 + 暂存区）：per-file {path, added, removed,
//   status, staged}（`HermesReviewFile` 形状逐字段一致）；
// - diff：staged 文件读 `git diff --cached`，未暂存读 `git diff`，未跟踪
//   文件用 `git diff --no-index`（git 对 untracked 不出 diff）；
// - revert 破坏性：tracked 走 `git checkout HEAD --`，untracked 只删该文件
//   （`git clean -fd` 会连 ignored 一起清——不做）。
//
// 纪律：git 缺失 / 非仓库 / 命令失败一律 Err 传播（规矩 12）。

/// 一条变更文件（hermes `HermesReviewFile` 逐字段）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitReviewFile {
    /// 仓库相对路径（正斜杠——git 输出原样，前端统一比较用）。
    pub path: String,
    pub added: u64,
    pub removed: u64,
    /// git porcelain 状态字母：M/A/D/R/C/U/?
    pub status: String,
    /// 该文件的变更是否已全部暂存（决定 diff 读 cached 还是工作树）。
    pub staged: bool,
}

/// porcelain 一行 → (status, path)。Rename/Copy 的 `R  old -> new` 取 new。
///
/// `status` 保留 porcelain 的两字符原样（`" M"` / `"M "` / `"??"`）——下游
/// 需要区分 index 与 worktree 两列（`is_staged` 判定与 `status_letter`
/// 归约都要看两列）。**不要**在这里压成单字母。
fn parse_porcelain_line(line: &str) -> Option<(String, String)> {
    if line.len() < 4 {
        return None;
    }
    let status = line[..2].to_string();
    let mut rest = &line[3..];
    // rename/copy："R  old -> new"（带引号的路径 git 会在两端加 "）
    if let Some(idx) = rest.rfind(" -> ") {
        rest = &rest[idx + 4..];
    }
    let path = rest.trim_matches('"').replace('\\', "/");
    Some((status, path))
}

/// porcelain 两字符 → 单字母分类（上游 `statusLetter` 逐条）：
/// untracked 优先（两列都是 `?`），否则优先 index 码，再退 worktree 码，
/// 都空则 `M`。
fn status_letter(status: &str) -> String {
    let mut chars = status.chars();
    let index = chars.next().unwrap_or(' ');
    let worktree = chars.next().unwrap_or(' ');
    if index == '?' || worktree == '?' {
        return "?".to_string();
    }
    let code = if index != ' ' { index } else { worktree };
    if code == ' ' {
        "M".to_string()
    } else {
        code.to_ascii_uppercase().to_string()
    }
}

/// 该行是否已暂存（上游 `isStaged`）：index 列有内容且不是 `?`/空格。
fn is_staged(status: &str) -> bool {
    let index = status.chars().next().unwrap_or(' ');
    index != ' ' && index != '?'
}

/// 审查列表：按 scope 取变更文件。
///
/// scope 语义逐条照抄 hermes `electron/git-review-ops.ts` 的 `reviewList`：
/// - `uncommitted`（默认）= 工作树 + 暂存区 + 未跟踪；
/// - `branch` = `git diff <merge-base(HEAD, trunk)>...HEAD`（已提交的工作）；
/// - `lastTurn` = `git diff <baseRef>`（本轮开始时的 HEAD）+ 之后新建的未跟踪。
///
/// 行数来源（与 hermes 的 numstat 语义一致）：
/// - 未暂存变更 = `git diff --numstat`；
/// - 已暂存变更 = `git diff --cached --numstat`；
/// - 未跟踪文件 = `git ls-files --others --exclude-standard`，added = 文件
///   行数（`git diff` 不含 untracked）。
///
/// **staged 判定**：文件在 cached numstat 里 且 不在（工作树 diff ∪ untracked）
/// 里 → 全部已暂存；两者都有 → staged=false（diff 默认读工作树——hermes 的
/// `file.staged` 只决定读哪个 diff，同一文件两处有变更时工作树是"还差的部分"）。
///
/// 返回 `{ files, base }`：`base` 是本次读取实际用的基线（branch 的
/// merge-base 或 lastTurn 的 baseRef；uncommitted 为 null）——上游
/// `HermesReviewList.base` 同字段，前端不用它做判断，但保留形状。
#[tauri::command(rename_all = "camelCase", async)]
pub fn fs_git_review_list(
    path: String,
    scope: Option<String>,
    base_ref: Option<String>,
) -> Result<serde_json::Value, String> {
    let dir = PathBuf::from(path.trim());
    if fs_git_root(dir.to_string_lossy().into_owned()).is_none() {
        return Err("不是 git 仓库".to_string());
    }

    let scope = scope.unwrap_or_else(|| "uncommitted".to_string());
    if scope == "branch" || scope == "lastTurn" {
        return review_list_ranged(&dir, &scope, base_ref);
    }

    // porcelain：状态 + 路径（保持 git 输出序——hermes 前端不再排序，树模式
    // 自己按路径建树）
    let status_raw = git_output(&dir, &["status", "--porcelain"])?;
    let mut entries: Vec<(String, String)> = Vec::new();
    for line in status_raw.lines() {
        if line.trim().is_empty() {
            continue;
        }
        if let Some((status, path)) = parse_porcelain_line(line) {
            entries.push((status, path));
        }
    }

    // 两组 numstat：key = 路径 → (added, removed)
    let unstaged_raw = git_output(&dir, &["diff", "--numstat"]).unwrap_or_default();
    let staged_raw = git_output(&dir, &["diff", "--cached", "--numstat"]).unwrap_or_default();

    let mut rows: Vec<GitReviewFile> = Vec::new();
    for (status, path) in &entries {
        let untracked = status == "??";
        let (added, removed) = if untracked {
            // untracked：行数 = 文件行数（removed = 0）
            let full = dir.join(path);
            let lines = std::fs::read_to_string(&full)
                .map(|c| c.lines().count() as u64)
                .unwrap_or(0);
            (lines, 0)
        } else {
            let mut a = 0u64;
            let mut r = 0u64;
            for (nums, is_cached) in [(&unstaged_raw, false), (&staged_raw, true)] {
                for line in nums.lines() {
                    let mut parts = line.splitn(3, '\t');
                    let (Some(add), Some(rem)) = (parts.next(), parts.next()) else {
                        continue;
                    };
                    let Some(file) = parts.next() else { continue };
                    if file.trim_matches('"').replace('\\', "/") != *path {
                        continue;
                    }
                    let na = add.parse::<u64>().unwrap_or(0);
                    let nr = rem.parse::<u64>().unwrap_or(0);
                    if is_cached {
                        a += na;
                        r += nr;
                    } else {
                        // 工作树 numstat 是"相对 HEAD 的剩余变更"（含已暂存
                        // 部分）——减去 cached 才是"未暂存的那部分"。显示口径
                        // 与 hermes 一致：总行数（两处之和）。
                        a = a.max(na);
                        r = r.max(nr);
                    }
                }
            }
            (a, r)
        };

        // staged 判定：**上游 `isStaged` 的语义**——index 列有内容（非空格、
        // 非 `?`）即已暂存。注意这与"文件是否还有未暂存改动"是两件事：
        // 一个文件可以既暂存了一部分又在工作树里继续改（porcelain 的 `MM`），
        // 此时 staged=true（diff 读 cached），工作树那部分由 `git diff HEAD`
        // 在未暂存视图里体现——上游同款。
        rows.push(GitReviewFile {
            path: path.clone(),
            added,
            removed,
            status: status_letter(status),
            staged: is_staged(status),
        });
    }

    Ok(serde_json::json!({ "files": rows, "base": serde_json::Value::Null }))
}

/// `branch` / `lastTurn` 两个只读 scope 的列表（上游 `reviewList` 同分支）。
///
/// - `branch`：基线 = `merge-base(HEAD, trunk)`，取法照抄上游 `branchBase`：
///   先 `origin/HEAD` 指向的分支，再依次试 origin/main、origin/master、
///   main、master；全都解析不出 → 空列表 + base null（不是错误：新仓库没有
///   主干分支是真实状态）。
/// - `lastTurn`：基线 = 调用方传的 baseRef（本轮开始时的 HEAD sha）。baseRef
///   缺失 → 空列表（面板显示"无变更"，与上游一致）。
/// 两个 scope 的行数都来自 `git diff --numstat <range>`；lastTurn 额外把
/// 基线之后新建的未跟踪文件补进来（`git status --porcelain` 的 `??`）。
fn review_list_ranged(
    dir: &Path,
    scope: &str,
    base_ref: Option<String>,
) -> Result<serde_json::Value, String> {
    let base = if scope == "branch" {
        branch_base(dir)
    } else {
        base_ref.filter(|s| !s.trim().is_empty())
    };
    let Some(base) = base else {
        return Ok(serde_json::json!({ "files": Vec::<GitReviewFile>::new(), "base": serde_json::Value::Null }));
    };

    let range = if scope == "branch" {
        format!("{base}...HEAD")
    } else {
        base.clone()
    };
    let numstat = git_output(dir, &["diff", "--numstat", &range])?;

    let mut rows: Vec<GitReviewFile> = Vec::new();
    for line in numstat.lines() {
        let mut parts = line.splitn(3, '\t');
        let (Some(add), Some(rem), Some(file)) = (parts.next(), parts.next(), parts.next()) else {
            continue;
        };
        rows.push(GitReviewFile {
            path: file.trim_matches('"').replace('\\', "/"),
            // 二进制文件 numstat 是 "-"（parse 失败即 0，与上游 binary→0 同）
            added: add.parse::<u64>().unwrap_or(0),
            removed: rem.parse::<u64>().unwrap_or(0),
            status: "M".to_string(),
            staged: false,
        });
    }

    // lastTurn 还要把基线之后新建的未跟踪文件补进来（它们不在 diff 里）。
    if scope == "lastTurn" {
        let known: std::collections::HashSet<String> = rows.iter().map(|r| r.path.clone()).collect();
        if let Ok(status_raw) = git_output(dir, &["status", "--porcelain"]) {
            for line in status_raw.lines() {
                let Some((status, path)) = parse_porcelain_line(line) else {
                    continue;
                };
                if status != "??" || known.contains(&path) {
                    continue;
                }
                let lines = std::fs::read_to_string(dir.join(&path))
                    .map(|c| c.lines().count() as u64)
                    .unwrap_or(0);
                rows.push(GitReviewFile {
                    path,
                    added: lines,
                    removed: 0,
                    status: "?".to_string(),
                    staged: false,
                });
            }
        }
    }

    rows.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(serde_json::json!({ "files": rows, "base": base }))
}

/// 主干合并基线（上游 `branchBase` 逐条）：先 `origin/HEAD` 指向的分支，
/// 再试常见主干名；都解析不出 → None。
fn branch_base(dir: &Path) -> Option<String> {
    let mut candidates: Vec<String> = Vec::new();
    if let Ok(raw) = git_output(dir, &["rev-parse", "--abbrev-ref", "origin/HEAD"]) {
        let head = raw.trim();
        if !head.is_empty() {
            candidates.push(head.to_string());
        }
    }
    for name in ["origin/main", "origin/master", "main", "master"] {
        candidates.push(name.to_string());
    }
    for ref_name in candidates {
        if let Ok(raw) = git_output(dir, &["merge-base", "HEAD", &ref_name]) {
            let base = raw.trim();
            if !base.is_empty() {
                return Some(base.to_string());
            }
        }
    }
    None
}

/// 单文件 diff，按 scope 取。
///
/// - `branch`：`git diff <merge-base>...HEAD -- <file>`；
/// - `lastTurn`：`git diff <baseRef> -- <file>`；
/// - `uncommitted` + staged：`git diff --cached -- <file>`；
/// - `uncommitted` + 未暂存：`git diff HEAD -- <file>`（含暂存 + 工作树），
///   为空时若是未跟踪文件则用 `--no-index` 合成全加 diff（上游同款）。
#[tauri::command(rename_all = "camelCase", async)]
pub fn fs_git_review_diff(
    path: String,
    file: String,
    scope: Option<String>,
    base_ref: Option<String>,
    staged: bool,
) -> Result<String, String> {
    let dir = PathBuf::from(path.trim());
    let scope = scope.unwrap_or_else(|| "uncommitted".to_string());

    if scope == "branch" {
        let Some(base) = branch_base(&dir) else {
            return Ok(String::new());
        };
        return git_output(&dir, &["diff", &format!("{base}...HEAD"), "--", &file]);
    }
    if scope == "lastTurn" {
        let Some(base) = base_ref.filter(|s| !s.trim().is_empty()) else {
            return Ok(String::new());
        };
        return git_output(&dir, &["diff", &base, "--", &file]);
    }

    let is_untracked = git_output(&dir, &["status", "--porcelain", "--", &file])
        .map(|raw| raw.lines().any(|l| l.starts_with("??")))
        .unwrap_or(false);
    if is_untracked {
        return git_output(
            &dir,
            &["diff", "--no-index", "--", "/dev/null", &file],
        )
        .or_else(|e| {
            // --no-index 对有差异的文件退出码 1——git_output 会把它当失败。
            // 退出码 1 且 stdout 非空 = 正常 diff，不报错。
            let out = std::process::Command::new("git")
                .arg("-C")
                .arg(&dir)
                .args(["diff", "--no-index", "--", "/dev/null", &file])
                .hide_console()
                .output()
                .map_err(|e| format!("git 不可用 {e}"))?;
            if out.status.code() == Some(1) && !out.stdout.is_empty() {
                return Ok(String::from_utf8_lossy(&out.stdout).into_owned());
            }
            Err(e)
        });
    }
    if staged {
        git_output(&dir, &["diff", "--cached", "--", &file])
    } else {
        git_output(&dir, &["diff", "HEAD", "--", &file])
    }
}

/// ref → sha（lastTurn 的轮次基线捕获；解析不出返回 null，不是错误）。
#[tauri::command(rename_all = "camelCase", async)]
pub fn fs_git_rev_parse(path: String, ref_name: Option<String>) -> Result<Option<String>, String> {
    let dir = PathBuf::from(path.trim());
    let target = ref_name.unwrap_or_else(|| "HEAD".to_string());
    match git_output(&dir, &["rev-parse", &target]) {
        Ok(raw) => {
            let sha = raw.trim().to_string();
            Ok(if sha.is_empty() { None } else { Some(sha) })
        }
        // 无提交 / 非仓库：上游同样返回 null（best-effort 捕获）。
        Err(_) => Ok(None),
    }
}

/// 生成提交信息所需的上下文（上游 `reviewCommitContext` 逐条）：
/// 将要提交的 diff（有暂存 → `--cached`，否则 `HEAD`）、未跟踪文件名清单、
/// 最近 10 条提交标题。diff 上限 120k 字符。
#[tauri::command(rename_all = "camelCase", async)]
pub fn fs_git_commit_context(path: String) -> Result<serde_json::Value, String> {
    let dir = PathBuf::from(path.trim());
    const DIFF_MAX_CHARS: usize = 120_000;
    const UNTRACKED_MAX: usize = 80;

    let status_raw = git_output(&dir, &["status", "--porcelain"]).unwrap_or_default();
    let has_staged = status_raw
        .lines()
        .filter_map(parse_porcelain_line)
        .any(|(status, _)| {
            let index = status.chars().next().unwrap_or(' ');
            index != ' ' && index != '?'
        });

    let mut diff = if has_staged {
        git_output(&dir, &["diff", "--cached"]).unwrap_or_default()
    } else {
        git_output(&dir, &["diff", "HEAD"]).unwrap_or_default()
    };

    if diff.chars().count() > DIFF_MAX_CHARS {
        let kept: String = diff.chars().take(DIFF_MAX_CHARS).collect();
        let omitted = diff.chars().count() - DIFF_MAX_CHARS;
        diff = format!("{kept}\n# diff truncated for commit-message generation: {omitted} chars omitted\n");
    }

    let untracked: Vec<String> = status_raw
        .lines()
        .filter_map(parse_porcelain_line)
        .filter(|(status, _)| status == "??")
        .map(|(_, path)| path)
        .collect();

    if !untracked.is_empty() {
        let visible: Vec<&String> = untracked.iter().take(UNTRACKED_MAX).collect();
        let omitted = untracked.len() - visible.len();
        let mut note = format!(
            "\n# New (untracked) files:\n{}\n",
            visible
                .iter()
                .map(|p| format!("#   {p}"))
                .collect::<Vec<_>>()
                .join("\n")
        );
        if omitted > 0 {
            note.push_str(&format!("#   ... {omitted} more omitted\n"));
        }
        diff = if diff.is_empty() { note } else { format!("{diff}{note}") };
    }

    let recent = git_output(&dir, &["log", "-n", "10", "--pretty=format:%s"]).unwrap_or_default();

    Ok(serde_json::json!({ "diff": diff, "recent": recent.trim() }))
}

/// 暂存（file = None → 全部，`git add -A`）。
#[tauri::command(rename_all = "camelCase", async)]
pub fn fs_git_stage(path: String, file: Option<String>) -> Result<(), String> {
    let dir = PathBuf::from(path.trim());
    match file {
        Some(f) => git_output(&dir, &["add", "--", &f]).map(|_| ()),
        None => git_output(&dir, &["add", "-A"]).map(|_| ()),
    }
}

/// 取消暂存。
#[tauri::command(rename_all = "camelCase", async)]
pub fn fs_git_unstage(path: String, file: Option<String>) -> Result<(), String> {
    let dir = PathBuf::from(path.trim());
    match file {
        Some(f) => git_output(&dir, &["reset", "HEAD", "--", &f]).map(|_| ()),
        None => git_output(&dir, &["reset", "HEAD"]).map(|_| ()),
    }
}

/// 丢弃变更（破坏性——前端必须二次确认）。
///
/// tracked = `git checkout HEAD --`；untracked = 直接删文件（它不在 HEAD
/// 里，checkout 无法还原）；全部 = checkout 整个工作树 + 逐个删 untracked。
#[tauri::command(rename_all = "camelCase", async)]
pub fn fs_git_revert(path: String, file: Option<String>) -> Result<(), String> {
    let dir = PathBuf::from(path.trim());
    match file {
        Some(f) => {
            let untracked = git_output(&dir, &["status", "--porcelain", "--", &f])
                .map(|raw| raw.lines().any(|l| l.starts_with("??")))
                .unwrap_or(false);
            if untracked {
                std::fs::remove_file(dir.join(&f))
                    .map_err(|e| format!("删除未跟踪文件失败 {f}: {e}"))
            } else {
                git_output(&dir, &["checkout", "HEAD", "--", &f]).map(|_| ())
            }
        }
        None => {
            // 全部：先还原 tracked，再删列表里的 untracked
            git_output(&dir, &["checkout", "HEAD", "--", "."])?;
            let status = git_output(&dir, &["status", "--porcelain"])?;
            for line in status.lines() {
                if let Some((status, path)) = parse_porcelain_line(line) {
                    if status == "??" {
                        let _ = std::fs::remove_file(dir.join(&path));
                    }
                }
            }
            Ok(())
        }
    }
}

/// 提交（push = 提交后顺带推送）。
///
/// 与上游 `reviewCommit` 同语义：**没暂存任何东西时先 `add -A`**（VS Code 的
/// "提交全部"），再 commit。推送时若分支没有上游（`rev-parse --abbrev-ref
/// @{upstream}` 失败）→ `push -u origin <branch>`，否则 `push`。
#[tauri::command(rename_all = "camelCase", async)]
pub fn fs_git_commit(path: String, message: String, push: bool) -> Result<(), String> {
    let dir = PathBuf::from(path.trim());
    if message.trim().is_empty() {
        return Err("提交信息为空".to_string());
    }
    let status_raw = git_output(&dir, &["status", "--porcelain"]).unwrap_or_default();
    let has_staged = status_raw
        .lines()
        .filter_map(parse_porcelain_line)
        .any(|(status, _)| {
            let index = status.chars().next().unwrap_or(' ');
            index != ' ' && index != '?'
        });
    if !has_staged {
        git_output(&dir, &["add", "-A"])?;
    }
    git_output(&dir, &["commit", "-m", &message])?;
    if push {
        push_with_upstream(&dir)?;
    }
    Ok(())
}

/// 推送：有上游走 `push`，否则 `push -u origin <当前分支>`（上游同款）。
fn push_with_upstream(dir: &Path) -> Result<(), String> {
    if git_output(dir, &["rev-parse", "--abbrev-ref", "@{upstream}"]).is_ok() {
        return git_output(dir, &["push"]).map(|_| ());
    }
    let branch = git_output(dir, &["rev-parse", "--abbrev-ref", "HEAD"])?;
    let branch = branch.trim();
    if branch.is_empty() || branch == "HEAD" {
        return Err("当前处于分离头指针，无法推送".to_string());
    }
    git_output(dir, &["push", "-u", "origin", branch]).map(|_| ())
}

/// 推送。
#[tauri::command(rename_all = "camelCase", async)]
pub fn fs_git_push(path: String) -> Result<(), String> {
    push_with_upstream(&PathBuf::from(path.trim()))
}

// ── 分支切换（活动面板「Git 工具」分区切换器，2026-11-01 ZCode 全链路）──
// ZCode 的 GitBranchSwitcher 数据面（列出本地分支 + checkout）。提交/推送
// 不在此重复——宿主的审查面板（fs_git_commit / fs_git_push）承担。

/// 一条本地分支。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBranchEntry {
    pub name: String,
    pub is_current: bool,
}

/// 本地分支列表（`git branch --format=%(refname:short)`）+ 当前分支标记
/// （`rev-parse --abbrev-ref HEAD`，失败不致命——标记缺省全 false）。
#[tauri::command(rename_all = "camelCase", async)]
pub fn fs_git_branches(path: String) -> Result<Vec<GitBranchEntry>, String> {
    let dir = PathBuf::from(path.trim());
    let out = git_output(&dir, &["branch", "--format=%(refname:short)"])?;
    let current = git_output(&dir, &["rev-parse", "--abbrev-ref", "HEAD"])
        .map(|s| s.trim().to_string())
        .ok();
    Ok(out
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .map(|name| GitBranchEntry {
            is_current: current.as_deref() == Some(name.as_str()),
            name,
        })
        .collect())
}

/// 切换分支（`git checkout <name>`）。脏工作区冲突 / 分支不存在 → Err 传播
/// （前端展示原错误，不静默）。分支名过一遍字符白名单（防参数注入：
/// git 分支名不含空白、不以 - 开头）。
#[tauri::command(rename_all = "camelCase", async)]
pub fn fs_git_checkout(path: String, branch: String) -> Result<(), String> {
    let dir = PathBuf::from(path.trim());
    let branch = branch.trim().to_string();
    if branch.is_empty() || branch.starts_with('-') || branch.split_whitespace().count() != 1 {
        return Err(format!("非法分支名：{branch}"));
    }
    git_output(&dir, &["checkout", &branch]).map(|_| ())
}

/// ship 信息：gh CLI 可用性 + 当前分支的 PR（hermes `HermesReviewShipInfo`）。
///
/// 与上游 `reviewShipInfo` 同语义：**`ghReady` = gh 存在且已认证**
/// （`gh auth status` 成功）——只装了 gh 但没登录时 PR 动作跑不起来，
/// 上游就按 not ready 处理。PR = `gh pr view --json url,state,number`
/// （无 PR 时 gh 退出码非 0，这是真实状态不是错误）。
#[tauri::command(rename_all = "camelCase", async)]
pub fn fs_git_ship_info(path: String) -> Result<serde_json::Value, String> {
    let dir = PathBuf::from(path.trim());
    let authed = std::process::Command::new("gh")
        .current_dir(&dir)
        .args(["auth", "status"])
        .hide_console()
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    if !authed {
        return Ok(serde_json::json!({ "ghReady": false, "pr": serde_json::Value::Null }));
    }
    let mut pr = serde_json::Value::Null;
    if let Ok(out) = std::process::Command::new("gh")
        .current_dir(&dir)
        .args(["pr", "view", "--json", "url,state,number"])
        .hide_console()
        .output()
    {
        if out.status.success() {
            if let Ok(v) = serde_json::from_slice::<serde_json::Value>(&out.stdout) {
                if v.get("url").and_then(|u| u.as_str()).is_some() {
                    pr = v;
                }
            }
        }
    }
    Ok(serde_json::json!({ "ghReady": true, "pr": pr }))
}

/// 用系统默认程序打开一个 URL（hermes `window.hermesDesktop.openExternal` 的
/// 宿主对应物——没有 opener 插件，走 `cmd /c start`）。
#[tauri::command(rename_all = "camelCase", async)]
pub fn fs_open_url(url: String) -> Result<(), String> {
    // 基本白名单：只放 http/https（防任意协议注入）。
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err(format!("不支持的 URL 协议：{url}"));
    }
    // `cmd /c start`（CREATE_NO_WINDOW）。Windows-only 的 CommandExt——
    // 本宿主是 Windows-only（AGENTS.md 技术栈），不加 cfg 门。
    std::process::Command::new("cmd")
        .args(["/c", "start", "", &url])
        .creation_flags(0x0800_0000)
        .spawn()
        .map_err(|e| format!("打开 URL 失败: {e}"))?;
    Ok(())
}

/// 为当前分支创建 PR（先推送让 gh 有远端 ref），返回新 PR 的 url。
/// 上游 `reviewCreatePr` 同语义：`gh pr create --fill`（标题/正文由提交
/// 自动填充）。gh 失败时把 **gh 自己的 stderr** 抛出去——通用的兜底文案
/// 会在 gh 本身正常时报假原因。
#[tauri::command(rename_all = "camelCase", async)]
pub fn fs_git_create_pr(path: String) -> Result<serde_json::Value, String> {
    let dir = PathBuf::from(path.trim());
    // 先推：gh 需要一个远端 ref 才能开 PR。推失败不阻断创建（上游同样
    // `.catch(() => undefined)`）——没有新提交时 push 会失败，但 PR 仍可开。
    let _ = push_with_upstream(&dir);

    let out = std::process::Command::new("gh")
        .current_dir(&dir)
        .args(["pr", "create", "--fill"])
        .hide_console()
        .output()
        .map_err(|e| format!("gh 不可用: {e}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        let reason = stderr.trim();
        return Err(format!(
            "gh pr create 失败: {}",
            if reason.is_empty() { "gh 是否已安装并登录？" } else { reason }
        ));
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    let url = stdout.lines().filter(|l| !l.trim().is_empty()).next_back().unwrap_or("").trim().to_string();
    Ok(serde_json::json!({ "url": url }))
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

    // ── 审查行的状态归约（上游 statusLetter / isStaged 语义）──────────────

    /// 上游 `statusLetter`：untracked 优先，否则优先 index 码，再退 worktree，
    /// 都空则 M。**返回单字母**——前端 STATUS_GLYPH 按单字母查表。
    #[test]
    fn status_letter_matches_upstream() {
        assert_eq!(status_letter(" M"), "M"); // 仅工作树改动
        assert_eq!(status_letter("M "), "M"); // 仅暂存
        assert_eq!(status_letter("MM"), "M"); // 两处都有
        assert_eq!(status_letter("A "), "A");
        assert_eq!(status_letter("D "), "D");
        assert_eq!(status_letter(" R"), "R");
        assert_eq!(status_letter("??"), "?"); // untracked 优先
        assert_eq!(status_letter("UU"), "U");
        assert_eq!(status_letter("  "), "M"); // 畸形兜底
    }

    /// 上游 `isStaged`：index 列有内容且不是 `?`/空格。
    #[test]
    fn is_staged_matches_upstream() {
        assert!(is_staged("M "));
        assert!(is_staged("MM"), "部分暂存也算 staged（diff 读 cached）");
        assert!(is_staged("A "));
        assert!(!is_staged(" M"), "只有工作树改动 = 未暂存");
        assert!(!is_staged("??"), "untracked 不是已暂存");
    }

    /// porcelain 两列必须原样保留（下游靠两列判 staged），不能在这里压成单字母。
    #[test]
    fn parse_porcelain_keeps_two_columns() {
        assert_eq!(parse_porcelain_line(" M src/a.rs"), Some((" M".into(), "src/a.rs".into())));
        assert_eq!(parse_porcelain_line("MM src/b.rs"), Some(("MM".into(), "src/b.rs".into())));
        assert_eq!(parse_porcelain_line("?? new.txt"), Some(("??".into(), "new.txt".into())));
        // rename：取新路径
        assert_eq!(
            parse_porcelain_line("R  old/a.rs -> new/a.rs"),
            Some(("R ".into(), "new/a.rs".into()))
        );
    }
}

#[cfg(test)]
mod paths_exist_tests {
    use super::fs_paths_exist;

    /// 存在 / 不存在 / 空白路径逐项如实（项目「根目录缺失」判定的数据面）。
    #[test]
    fn probes_existing_missing_and_empty_paths() {
        let existing = std::env::temp_dir();
        let flags = fs_paths_exist(vec![
            existing.to_string_lossy().into_owned(),
            "Z:/definitely-missing-mirach-probe/x".to_string(),
            "   ".to_string(),
        ]);
        assert_eq!(flags, vec![true, false, false]);
    }
}

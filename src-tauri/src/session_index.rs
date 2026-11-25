//! 跨工作区会话索引（设置页 / 会话管理 P0 数据面）。
//!
//! ## 为什么需要
//!
//! `pi_list_sessions`（pi_session.rs）只扫**启动 cwd** 的会话根；用户在其它
//! 工作区建的会话只能靠前端 `workspace-session-registry.ts` 的补丁登记。
//! 本模块是纯宿主实现（不改引擎 G:\pi-rust-main）：一次扫描三类根，
//! 产出统一索引：
//!
//! 1. `<rpi settings.sessionDir>`（配置覆盖根；相对路径相对启动 cwd）
//! 2. 每个**已登记项目根**的默认会话根 `<root>/.rpi/sessions`
//!    （走 `rpi_cli::session::default_session_dir`，因此也尊重
//!    `RPI_CODING_AGENT_SESSION_DIR`；与引擎写会话的位置同源）
//! 3. 当前 cwd 的默认会话根
//!
//! 根按**规范化路径**去重（Windows 大小写不敏感、`/` 与 `\` 等价）。
//! 同一文件被两个根重复发现时只保留第一次（根顺序：sessionDir → 项目根 →
//! 当前 cwd，先到先得）。
//!
//! ## 坏会话可见（规矩 12）
//!
//! 任何读不出来的 jsonl 都进 `skipped: [{path, root, reason}]`，不静默丢；
//! 整个根不可读（权限/断开的盘）进 `roots[].error`，其余根照常扫描。
//! 只有 rpi settings 本身读不出来才会整命令 Err——那是全局配置错误，
//! 悄悄退回默认根会让「为什么列表里没有某工作区」无从诊断。
//!
//! ## `pi_sessions_index` wire 形状
//!
//! ```json
//! {
//!   "sessions": [{
//!     "id": "01a1b2c3",
//!     "path": "C:\\work\\proj\\.rpi\\sessions\\--C--work-proj--\\x.jsonl",
//!     "cwd": "C:\\work\\proj",
//!     "name": "自定义会话名" | null,
//!     "messageCount": 42,
//!     "lastModified": 1760000000000,
//!     "createdAt": 1760000000000,
//!     "parentSessionId": "01a1..." | null,
//!     "projectId": "proj-uuid" | null,
//!     "profile": "二万人" | null,
//!     "sourceRoot": "C:\\work\\proj\\.rpi\\sessions",
//!     "source": "sessionDir" | "projectRoot" | "workspace" | "profile"
//!   }],
//!   "skipped": [{ "path": "...", "root": "...", "reason": "会话文件损坏：..." }],
//!   "roots": [{
//!     "path": "C:\\work\\proj\\.rpi\\sessions",
//!     "kind": "projectRoot",
//!     "profile": null,
//!     "exists": true,
//!     "error": null
//!   }]
//! }
//! ```
//!
//! `lastModified` 是 Unix 毫秒（与 `pi_list_sessions.lastModifiedMs` 同源）；
//! `createdAt` 来自 header 的 `createdAt`（旧 header 缺省 0，前端按「未知」处理）；
//! `name`/`parentSessionId`/`projectId` 缺省为 null（前端可直接 `??`）。
//! `sourceRoot` / `source` 是诊断字段：前端可以不做展示。
//!
//! ## 解析复用
//!
//! 首行 header 的校验（`kind == "header"`、id/cwd 必须存在）只在这里实现；
//! pi_session.rs 的 `preflight_session_file` 委托本模块，避免两份解析逻辑
//! 漂移。

use serde::Serialize;
use std::path::{Path, PathBuf};

/// 根的类型（wire 里是 camelCase 字符串）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RootKind {
    /// rpi settings 的 `sessionDir` 覆盖根。
    SessionDir,
    /// 已登记项目根的默认会话根。
    ProjectRoot,
    /// 当前启动 cwd 的默认会话根。
    Workspace,
    /// 具名环境 home 的会话根（`<agent>/profiles/<name>/sessions`；
    /// 跨环境聚合，2026-11-25）。
    Profile,
}

/// 一个待扫描的会话根。
#[derive(Debug, Clone)]
pub struct ScanRoot {
    pub path: String,
    pub kind: RootKind,
    /// 根所属环境（`None` = 本体环境；具名环境 = `<home>/sessions` 根）。
    /// 记录沿根继承该值——侧栏「按配置档案分组」的身份来源。
    pub profile: Option<String>,
}

/// 根扫描报告（wire 形状见模块头）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RootReport {
    pub path: String,
    pub kind: RootKind,
    pub profile: Option<String>,
    pub exists: bool,
    pub error: Option<String>,
}

/// 被跳过的会话文件 / 目录项（诊断用）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkippedSession {
    pub path: String,
    pub root: String,
    pub reason: String,
}

/// 单条跨根会话记录。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRecord {
    pub id: String,
    pub path: String,
    pub cwd: String,
    pub name: Option<String>,
    pub message_count: u64,
    /// Unix 毫秒。
    pub last_modified: u64,
    /// header.createdAt 的 Unix 毫秒（0 = 旧 header 没写创建时间）。
    pub created_at: u64,
    pub parent_session_id: Option<String>,
    /// 由命令层按 sessionProjects / cwd 归属推断后填入。
    pub project_id: Option<String>,
    /// 会话所属环境（None = 本体；由扫描根继承——`profiles/<name>/sessions`
    /// 根下的记录带名字。跨环境聚合的身份标签，2026-11-25）。
    pub profile: Option<String>,
    pub source_root: String,
    pub source: RootKind,
}

/// 一次跨根索引的完整结果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexScan {
    pub sessions: Vec<SessionRecord>,
    pub skipped: Vec<SkippedSession>,
    pub roots: Vec<RootReport>,
}

/// header 里索引需要的字段。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionHeader {
    pub id: String,
    pub cwd: String,
    /// header.createdAt 的 Unix 毫秒；旧文件缺失时 0（不伪造创建时间）。
    pub created_at: u64,
    pub parent_session_id: Option<String>,
}

/// 会话文件首行 header 解析（**唯一实现**；preflight 也走这里）。
///
/// 错误文案保留「损坏 / 缺少 header」锚点——UI 红条与既有测试按这些词
/// 区分「文件坏了」与「路径不对」。
pub fn read_session_header(path: &Path) -> Result<SessionHeader, String> {
    use std::io::BufRead;
    let display = path.display();
    let file = std::fs::File::open(path)
        .map_err(|e| format!("会话文件无法打开（{display}）：{e}"))?;
    let mut first = String::new();
    std::io::BufReader::new(file)
        .read_line(&mut first)
        .map_err(|e| format!("会话文件读取失败（{display}）：{e}"))?;
    let line = first.trim();
    if line.is_empty() {
        return Err(format!("会话文件为空，缺少 header（{display}）"));
    }
    let value: serde_json::Value = serde_json::from_str(line)
        .map_err(|e| format!("会话文件首行不是合法 JSON——文件已损坏（{display}）：{e}"))?;
    if value.get("kind").and_then(|v| v.as_str()) != Some("header") {
        return Err(format!(
            "会话文件损坏：首行不是 rpi session header（kind={:?}，{display}）。\
             文件不再可恢复，请新建会话或删除该文件。",
            value.get("kind")
        ));
    }
    // id/cwd 与 pi_list_sessions 同判据：字段缺失/非字符串按空串处理
    // （header 本身仍是可解析的；rpi 的 decode_header 只校验类型，不校验
    // 非空）。这样 preflight 的接受面与重构前逐字一致，索引也不会因一个
    // 空字段把整条会话丢掉。
    let id = value.get("id").and_then(|v| v.as_str()).unwrap_or("");
    let cwd = value.get("cwd").and_then(|v| v.as_str()).unwrap_or("");
    let parent = value
        .get("parentSessionId")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_owned);
    let created_at = value.get("createdAt").and_then(|v| v.as_u64()).unwrap_or(0);
    Ok(SessionHeader {
        id: id.to_owned(),
        cwd: cwd.to_owned(),
        created_at,
        parent_session_id: parent,
    })
}

/// 相对路径按启动 cwd 解析（与 rpi `configured_session_dir` 同语义：
/// 只有「相对且无根」才拼 cwd；`C:foo` 这类带盘符的相对路径原样保留）。
pub fn resolve_session_path(path: &Path, cwd: &Path) -> PathBuf {
    if path.is_relative() && !path.has_root() {
        cwd.join(path)
    } else {
        path.to_path_buf()
    }
}

/// 路径比较键：统一分隔符、去掉 Windows 扩展前缀、去尾分隔符、Windows
/// 下转小写。**不访问文件系统**（断开的项目根也要能参与比较）。
pub fn path_key(path: &Path) -> String {
    let raw = path.to_string_lossy().replace('/', "\\");
    let trimmed = raw.strip_prefix(r"\\?\").unwrap_or(&raw);
    let trimmed = if trimmed.len() > 3 {
        trimmed.trim_end_matches('\\')
    } else {
        trimmed
    };
    if cfg!(windows) {
        trimmed.to_ascii_lowercase()
    } else {
        trimmed.to_owned()
    }
}

/// 去重键：能 canonicalize 就用规范路径（消掉 `..` 与大小写差异），
/// 失败时退回纯字符串键。只用于「同一个文件的重复发现」。
pub fn dedup_key(path: &Path) -> String {
    let canonical = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    path_key(&canonical)
}

/// 追加根并按路径去重（先到先得；重复根的 kind/profile 保持第一次的）。
pub fn push_root(
    roots: &mut Vec<ScanRoot>,
    path: PathBuf,
    kind: RootKind,
    profile: Option<String>,
) {
    let key = dedup_key(&path);
    if roots.iter().any(|r| dedup_key(Path::new(&r.path)) == key) {
        return;
    }
    roots.push(ScanRoot {
        path: path.to_string_lossy().into_owned(),
        kind,
        profile,
    });
}

/// 一个根的单次扫描结果：报告 + 会话文件 + 诊断项。
#[derive(Debug, Clone)]
pub struct RootScan {
    pub report: RootReport,
    pub files: Vec<PathBuf>,
    pub problems: Vec<SkippedSession>,
}

/// 递归扫描深度上限（rpi 布局是 `<root>/<encoded-cwd>/*.jsonl`；给自定义
/// sessionDir 留两层余量，超过的目录记为诊断项而不是静默忽略）。
const MAX_SCAN_DEPTH: usize = 4;

fn is_session_file(path: &Path) -> bool {
    if path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
        return false;
    }
    // `<session>.jsonl.progress.jsonl` 是进度边车，不是会话（与
    // pi_list_sessions 同判据）。
    !path
        .file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.ends_with(".progress.jsonl"))
}

/// 扫描一个根。**不返回 Err**：根/子目录/目录项的错误全部落到
/// `report.error` 或 `problems`（其余根与文件继续），保证一个断开的盘
/// 不会让整个索引命令失败。
pub fn scan_root(root: &ScanRoot) -> RootScan {
    let root_path = Path::new(&root.path);
    let mut out = RootScan {
        report: RootReport {
            path: root.path.clone(),
            kind: root.kind,
            profile: root.profile.clone(),
            exists: false,
            error: None,
        },
        files: Vec::new(),
        problems: Vec::new(),
    };
    let meta = match std::fs::metadata(root_path) {
        Ok(meta) => meta,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return out,
        Err(e) => {
            out.report.error = Some(format!("会话根不可访问: {e}"));
            return out;
        }
    };
    out.report.exists = true;
    if !meta.is_dir() {
        out.report.error = Some("会话根不是目录".into());
        return out;
    }
    if let Err(e) = walk_dir(root_path, root, 0, &mut out.files, &mut out.problems) {
        out.report.error = Some(e);
    }
    out.files.sort();
    out
}

fn walk_dir(
    dir: &Path,
    root: &ScanRoot,
    depth: usize,
    files: &mut Vec<PathBuf>,
    problems: &mut Vec<SkippedSession>,
) -> Result<(), String> {
    let entries = std::fs::read_dir(dir)
        .map_err(|e| format!("会话目录读取失败 {}: {e}", dir.display()))?;
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(e) => {
                problems.push(SkippedSession {
                    path: dir.to_string_lossy().into_owned(),
                    root: root.path.clone(),
                    reason: format!("目录项读取失败: {e}"),
                });
                continue;
            }
        };
        let path = entry.path();
        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(e) => {
                problems.push(SkippedSession {
                    path: path.to_string_lossy().into_owned(),
                    root: root.path.clone(),
                    reason: format!("条目类型读取失败: {e}"),
                });
                continue;
            }
        };
        if file_type.is_file() {
            if is_session_file(&path) {
                files.push(path);
            }
        } else if file_type.is_dir() {
            if depth + 1 >= MAX_SCAN_DEPTH {
                problems.push(SkippedSession {
                    path: path.to_string_lossy().into_owned(),
                    root: root.path.clone(),
                    reason: format!("目录超过扫描深度 {MAX_SCAN_DEPTH}，未继续"),
                });
                continue;
            }
            if let Err(e) = walk_dir(&path, root, depth + 1, files, problems) {
                // 子目录不可读 = 诊断项；根目录不可读由调用方写 report.error。
                problems.push(SkippedSession {
                    path: path.to_string_lossy().into_owned(),
                    root: root.path.clone(),
                    reason: e,
                });
            }
        }
    }
    Ok(())
}

/// 会话的 cwd 是否落在项目根内（含根本身，Windows 大小写不敏感）。
pub fn cwd_is_within_project(cwd: &str, project_root: &str) -> bool {
    let cwd = path_key(Path::new(cwd));
    let root = path_key(Path::new(project_root));
    if cwd == root {
        return true;
    }
    if root.ends_with('\\') {
        // 盘根（`c:\`）：前缀直接比较。
        return cwd.starts_with(&root);
    }
    cwd.starts_with(&format!("{root}\\"))
}

/// 会话 → 项目归属。
///
/// 优先级：**显式 `sessionProjects` 映射永远优先**（哪怕项目已软删；
/// 映射到不存在的项目 id 也原样返回，便于诊断——不静默改写）。没有
/// 显式映射时按 cwd 落在哪个项目根里推断；多个项目共享同一 cwd 时取
/// `order` 最小者（再按 id 字典序），保证结果稳定。
pub fn project_for_session(
    projects: &[crate::session_meta::Project],
    explicit: &std::collections::HashMap<String, String>,
    session_id: &str,
    cwd: &str,
) -> Option<String> {
    if let Some(project_id) = explicit.get(session_id) {
        return Some(project_id.clone());
    }
    let mut matches: Vec<&crate::session_meta::Project> = projects
        .iter()
        .filter(|project| {
            project
                .roots
                .iter()
                .any(|root| cwd_is_within_project(cwd, root))
        })
        .collect();
    matches.sort_by(|a, b| a.order.cmp(&b.order).then_with(|| a.id.cmp(&b.id)));
    matches.first().map(|project| project.id.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "mirach-session-index-{tag}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_session(path: &Path, id: &str, cwd: &str) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        let mut file = std::fs::File::create(path).unwrap();
        writeln!(
            file,
            r#"{{"kind":"header","version":4,"id":"{id}","createdAt":1,"cwd":"{cwd}"}}"#
        )
        .unwrap();
        writeln!(file, r#"{{"kind":"entry","seq":1}}"#).unwrap();
    }

    #[test]
    fn cross_root_scan_collects_both_roots_and_reports_bad_files() {
        let base = temp_dir("cross-root");
        let root_a = base.join("a").join(".rpi").join("sessions");
        let root_b = base.join("b").join(".rpi").join("sessions");
        write_session(&root_a.join("--a--").join("s1.jsonl"), "s1", r"C:\\a");
        write_session(&root_b.join("--b--").join("s2.jsonl"), "s2", r"C:\\b");
        // 坏文件：首行是 entry 不是 header。
        let broken = root_b.join("--b--").join("broken.jsonl");
        std::fs::write(&broken, "{\"kind\":\"entry\",\"seq\":9}\n").unwrap();
        // 空文件：缺 header。
        let empty = root_b.join("--b--").join("empty.jsonl");
        std::fs::File::create(&empty).unwrap();
        // 进度边车：不是会话，不应被收集。
        write_session(&root_b.join("--b--").join("s2.jsonl.progress.jsonl"), "x", r"C:\\b");

        let mut ids = Vec::new();
        let mut reasons = Vec::new();
        for root_dir in [&root_a, &root_b] {
            let root = ScanRoot {
                path: root_dir.to_string_lossy().into_owned(),
                kind: RootKind::ProjectRoot,
                profile: None,
            };
            let scan = scan_root(&root);
            assert!(scan.report.exists);
            assert!(scan.report.error.is_none());
            assert!(!scan
                .files
                .iter()
                .any(|p| p.to_string_lossy().ends_with(".progress.jsonl")));
            for file in &scan.files {
                match read_session_header(file) {
                    Ok(header) => ids.push(header.id),
                    Err(reason) => reasons.push(reason),
                }
            }
        }
        ids.sort();
        assert_eq!(ids, vec!["s1".to_string(), "s2".to_string()]);
        assert_eq!(reasons.len(), 2, "{reasons:?}");
        assert!(reasons.iter().any(|r| r.contains("不是 rpi session header")));
        assert!(reasons.iter().any(|r| r.contains("缺少 header")));

        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn scan_root_reports_missing_root_without_failing() {
        let base = temp_dir("missing");
        let root = ScanRoot {
            path: base.join("nope").to_string_lossy().into_owned(),
            kind: RootKind::SessionDir,
            profile: None,
        };
        let scan = scan_root(&root);
        assert!(!scan.report.exists);
        assert!(scan.report.error.is_none());
        assert!(scan.files.is_empty());
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn relative_session_dir_resolves_against_cwd() {
        let cwd = Path::new(r"C:\work\proj");
        assert_eq!(
            resolve_session_path(Path::new("sessions"), cwd),
            PathBuf::from(r"C:\work\proj\sessions")
        );
        assert_eq!(
            resolve_session_path(Path::new(r"D:\abs\sessions"), cwd),
            PathBuf::from(r"D:\abs\sessions")
        );
    }

    #[test]
    fn push_root_dedups_equivalent_paths() {
        let base = temp_dir("dedup");
        let a = base.join("sessions");
        std::fs::create_dir_all(&a).unwrap();
        let mut roots = Vec::new();
        push_root(&mut roots, a.clone(), RootKind::SessionDir, None);
        push_root(
            &mut roots,
            PathBuf::from(format!("{}\\", a.to_string_lossy())),
            RootKind::ProjectRoot,
            Some("bot-x".to_string()),
        );
        assert_eq!(roots.len(), 1);
        assert_eq!(roots[0].kind, RootKind::SessionDir);
        // 去重先到先得：重复根的 profile 保持第一次的（本体）。
        assert_eq!(roots[0].profile, None);
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn project_assignment_prefers_explicit_then_lowest_order() {
        use crate::session_meta::Project;
        use std::collections::HashMap;

        let project = |id: &str, root: &str, order: i64| Project {
            id: id.into(),
            name: id.into(),
            roots: vec![root.into()],
            pinned: false,
            order,
            deleted_at: None,
            created_at: 1,
        };
        // 同一个 cwd 登记了两个项目：order 小的胜出（同 order 再按 id 字典序）。
        let projects = vec![
            project("p2", r"C:\work", 2),
            project("p1", r"c:\work", 1),
            project("p3", r"D:\other", 0),
        ];

        assert_eq!(
            project_for_session(&projects, &HashMap::new(), "s1", r"C:\work\sub"),
            Some("p1".to_string())
        );
        // 显式 sessionProjects 永远优先，即使 cwd 落在别的项目里。
        let explicit = HashMap::from([("s1".to_string(), "p3".to_string())]);
        assert_eq!(
            project_for_session(&projects, &explicit, "s1", r"C:\work"),
            Some("p3".to_string())
        );
        // 映射指向已不存在的项目：原样返回（可诊断，不静默改写）。
        let ghost = HashMap::from([("s2".to_string(), "ghost".to_string())]);
        assert_eq!(
            project_for_session(&projects, &ghost, "s2", r"C:\work"),
            Some("ghost".to_string())
        );
        // 没有根命中、没有显式映射 → None。
        assert_eq!(
            project_for_session(&projects, &HashMap::new(), "s3", r"E:\elsewhere"),
            None
        );
    }
}

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
//! ## 项目注册表（2026-11-15，设置页/会话管理 P0 数据面）
//!
//! 同一文件还承载跨工作区项目：
//!
//! ```json
//! {
//!   "projects": [{
//!     "id": "uuid", "name": "项目名", "roots": ["C:\\work\\proj"],
//!     "pinned": false, "order": 0, "createdAt": 1760000000000,
//!     "deletedAt": 1760000000000
//!   }],
//!   "sessionProjects": { "<sessionId>": "<projectId>" }
//! }
//! ```
//!
//! **兼容性关键**：前端 `session_meta_set` 目前只发旧六个字段（
//! session-catalog.ts:234-242）。因此 projects / sessionProjects 用
//! `Option` 承载，写穿时 **None = 保留旧值**（`merge_compat`）——否则前端
//! 每做一次置顶/归档就会把项目注册表整段抹掉。这是切片合并，不是兜底：
//! 真正读取的文件错误仍然 Err。
//!
//! `pi_projects_*` 命令是项目注册表的唯一写面（原子读-改-写），
//! `sessionProjects` 由前端经 `session_meta_set` 全量携带（该字段随
//! SessionMetaStore 一起水合），亦可将来单独扩展命令。
//!
//! 旧 localStorage 键的一次性迁移在前端 hydrate 完成（此处只管文件）。

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::Manager;

/// 一个项目（注册表条目）。`deletedAt` = 软删时间戳（None = 活跃）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Project {
    pub id: String,
    pub name: String,
    /// 工作区根（可多个）；相对路径在扫描时相对启动 cwd 解析。
    pub roots: Vec<String>,
    pub pinned: bool,
    pub order: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deleted_at: Option<i64>,
    pub created_at: i64,
}

/// `pi_projects_save` 的入参（id 缺省 = 新建，由宿主生成 uuid）。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ProjectInput {
    pub id: Option<String>,
    pub name: String,
    pub roots: Vec<String>,
    pub pinned: Option<bool>,
    pub order: Option<i64>,
}

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
    /// 项目注册表。None 只在「旧前端写穿」时出现，见模块头兼容性说明。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub projects: Option<Vec<Project>>,
    /// 会话 → 项目显式归属（优先于按 cwd 推断）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_projects: Option<HashMap<String, String>>,
}

impl SessionMetaStore {
    /// 项目快照（未设置 = 空表）。
    pub fn projects(&self) -> Vec<Project> {
        self.projects.clone().unwrap_or_default()
    }

    /// 会话 → 项目映射快照。
    pub fn session_projects_map(&self) -> HashMap<String, String> {
        self.session_projects.clone().unwrap_or_default()
    }

    /// 按 order / createdAt / id 稳定排序；`include_deleted` 控制软删条目。
    pub fn projects_sorted(&self, include_deleted: bool) -> Vec<Project> {
        let mut list: Vec<Project> = self
            .projects()
            .into_iter()
            .filter(|project| include_deleted || project.deleted_at.is_none())
            .collect();
        list.sort_by(|a, b| {
            a.order
                .cmp(&b.order)
                .then_with(|| a.created_at.cmp(&b.created_at))
                .then_with(|| a.id.cmp(&b.id))
        });
        list
    }

    fn projects_mut(&mut self) -> &mut Vec<Project> {
        self.projects.get_or_insert_with(Vec::new)
    }
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

/// 旧前端（只发六个字段）写穿时保留项目切片。
fn merge_compat(existing: SessionMetaStore, mut incoming: SessionMetaStore) -> SessionMetaStore {
    if incoming.projects.is_none() {
        incoming.projects = existing.projects;
    }
    if incoming.session_projects.is_none() {
        incoming.session_projects = existing.session_projects;
    }
    incoming
}

pub struct SessionMetaPath(pub Mutex<Option<PathBuf>>);

/// 持锁执行（路径只初始化一次；读-改-写在同一把锁内完成）。
fn with_store<R>(
    app: &tauri::AppHandle,
    state: &SessionMetaPath,
    f: impl FnOnce(&PathBuf) -> Result<R, String>,
) -> Result<R, String> {
    let mut guard = state.0.lock().map_err(|_| "session-meta 锁中毒")?;
    if guard.is_none() {
        *guard = Some(store_path(app)?);
    }
    f(guard.as_ref().expect("刚初始化"))
}

/// 读当前 store（`pi_sessions_index` 等项目过滤命令复用）。
pub(crate) fn read_for(
    app: &tauri::AppHandle,
    state: &SessionMetaPath,
) -> Result<SessionMetaStore, String> {
    with_store(app, state, read_store)
}

/// 原子读-改-写（项目 CRUD 共用；闭包 Err 时不落盘）。
fn update_for<R>(
    app: &tauri::AppHandle,
    state: &SessionMetaPath,
    f: impl FnOnce(&mut SessionMetaStore) -> Result<R, String>,
) -> Result<R, String> {
    with_store(app, state, |path| {
        let mut store = read_store(path)?;
        let result = f(&mut store)?;
        write_store(path, &store)?;
        Ok(result)
    })
}

/// 去空白 / 去空项 / 按规范化路径去重（保留第一次出现的原始写法）。
fn normalize_roots(roots: &[String]) -> Vec<String> {
    let mut seen: HashSet<String> = HashSet::new();
    roots
        .iter()
        .filter_map(|root| {
            let trimmed = root.trim();
            if trimmed.is_empty() {
                return None;
            }
            let key = crate::session_index::path_key(std::path::Path::new(trimmed));
            seen.insert(key).then(|| trimmed.to_string())
        })
        .collect()
}

/// 新建或更新项目（纯函数，命令层负责落盘）。
fn upsert_project<F: FnOnce() -> String>(
    store: &mut SessionMetaStore,
    input: ProjectInput,
    now_ms: i64,
    generate_id: F,
) -> Result<Project, String> {
    let name = input.name.trim();
    if name.is_empty() {
        return Err("项目名不能为空".into());
    }
    let roots = normalize_roots(&input.roots);
    let requested_id = input
        .id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty());

    let list = store.projects_mut();
    match requested_id {
        Some(id) => {
            let project = list
                .iter_mut()
                .find(|project| project.id == id)
                .ok_or_else(|| format!("项目 {id} 不存在"))?;
            if project.deleted_at.is_some() {
                return Err(format!("项目 {id} 已删除，先恢复再修改"));
            }
            project.name = name.to_string();
            project.roots = roots;
            if let Some(pinned) = input.pinned {
                project.pinned = pinned;
            }
            if let Some(order) = input.order {
                project.order = order;
            }
            Ok(project.clone())
        }
        None => {
            let order = input.order.unwrap_or_else(|| {
                list.iter()
                    .map(|project| project.order)
                    .max()
                    .map(|max| max + 1)
                    .unwrap_or(0)
            });
            let project = Project {
                id: generate_id(),
                name: name.to_string(),
                roots,
                pinned: input.pinned.unwrap_or(false),
                order,
                deleted_at: None,
                created_at: now_ms,
            };
            list.push(project.clone());
            Ok(project)
        }
    }
}

/// 软删（`deletedAt` = now；已删除 = Err，不静默重复）。
fn delete_project(
    store: &mut SessionMetaStore,
    id: &str,
    now_ms: i64,
) -> Result<Project, String> {
    let project = store
        .projects_mut()
        .iter_mut()
        .find(|project| project.id == id)
        .ok_or_else(|| format!("项目 {id} 不存在"))?;
    if project.deleted_at.is_some() {
        return Err(format!("项目 {id} 已删除"));
    }
    project.deleted_at = Some(now_ms);
    Ok(project.clone())
}

/// 恢复软删（未删除 = Err，让调用方知道状态不符）。
fn restore_project(store: &mut SessionMetaStore, id: &str) -> Result<Project, String> {
    let project = store
        .projects_mut()
        .iter_mut()
        .find(|project| project.id == id)
        .ok_or_else(|| format!("项目 {id} 不存在"))?;
    if project.deleted_at.is_none() {
        return Err(format!("项目 {id} 未删除，无需恢复"));
    }
    project.deleted_at = None;
    Ok(project.clone())
}

/// 重排：`ids` 依次获得 0..n；未列出的活跃项目顺延到其后并保持相对顺序。
/// 重复 id / 未知 id / 软删项目 = Err（不静默忽略）。
fn reorder_projects(
    store: &mut SessionMetaStore,
    ids: &[String],
) -> Result<Vec<Project>, String> {
    if ids.is_empty() {
        return Err("重排至少需要一个项目 id".into());
    }
    let mut given: HashSet<String> = HashSet::new();
    for id in ids {
        if !given.insert(id.clone()) {
            return Err(format!("项目 id 重复: {id}"));
        }
        let project = store
            .projects_mut()
            .iter()
            .find(|project| project.id == *id)
            .ok_or_else(|| format!("项目 {id} 不存在"))?;
        if project.deleted_at.is_some() {
            return Err(format!("项目 {id} 已删除，不能参与排序"));
        }
    }
    for (index, id) in ids.iter().enumerate() {
        if let Some(project) = store
            .projects_mut()
            .iter_mut()
            .find(|project| project.id == *id)
        {
            project.order = index as i64;
        }
    }
    // 未列出的活跃项目：按原 order 排在给定序列之后。
    let mut rest: Vec<Project> = store
        .projects()
        .into_iter()
        .filter(|project| project.deleted_at.is_none() && !given.contains(&project.id))
        .collect();
    rest.sort_by(|a, b| a.order.cmp(&b.order).then_with(|| a.id.cmp(&b.id)));
    let base = ids.len() as i64;
    for (offset, project) in rest.into_iter().enumerate() {
        if let Some(target) = store
            .projects_mut()
            .iter_mut()
            .find(|candidate| candidate.id == project.id)
        {
            target.order = base + offset as i64;
        }
    }
    Ok(store.projects_sorted(false))
}

#[tauri::command]
pub fn session_meta_get(
    app: tauri::AppHandle,
    state: tauri::State<'_, SessionMetaPath>,
) -> Result<SessionMetaStore, String> {
    read_for(&app, &state)
}

#[tauri::command]
pub fn session_meta_set(
    app: tauri::AppHandle,
    state: tauri::State<'_, SessionMetaPath>,
    store: SessionMetaStore,
) -> Result<(), String> {
    with_store(&app, &state, |path| {
        let existing = read_store(path)?;
        write_store(path, &merge_compat(existing, store))
    })
}

/// 项目列表（默认隐藏软删；`includeDeleted: true` 带出回收站条目）。
#[tauri::command(rename_all = "camelCase")]
pub fn pi_projects_list(
    app: tauri::AppHandle,
    state: tauri::State<'_, SessionMetaPath>,
    include_deleted: Option<bool>,
) -> Result<Vec<Project>, String> {
    let store = read_for(&app, &state)?;
    Ok(store.projects_sorted(include_deleted.unwrap_or(false)))
}

/// 新建 / 更新项目。wire 入参：`{ project: { id?, name, roots, pinned?, order? } }`；
/// id 缺省 = 新建（宿主生成 uuid，order 缺省 = 当前最大值 + 1）。
#[tauri::command(rename_all = "camelCase")]
pub fn pi_projects_save(
    app: tauri::AppHandle,
    state: tauri::State<'_, SessionMetaPath>,
    project: ProjectInput,
) -> Result<Project, String> {
    let now = chrono::Utc::now().timestamp_millis();
    update_for(&app, &state, |store| {
        upsert_project(store, project, now, || uuid::Uuid::new_v4().to_string())
    })
}

/// 软删项目（保留 `sessionProjects` 指向，恢复后归属不变）。
#[tauri::command(rename_all = "camelCase")]
pub fn pi_projects_delete(
    app: tauri::AppHandle,
    state: tauri::State<'_, SessionMetaPath>,
    id: String,
) -> Result<Project, String> {
    let now = chrono::Utc::now().timestamp_millis();
    update_for(&app, &state, |store| delete_project(store, &id, now))
}

/// 从回收站恢复项目。
#[tauri::command(rename_all = "camelCase")]
pub fn pi_projects_restore(
    app: tauri::AppHandle,
    state: tauri::State<'_, SessionMetaPath>,
    id: String,
) -> Result<Project, String> {
    update_for(&app, &state, |store| restore_project(store, &id))
}

/// 重排项目：wire 入参 `{ ids: ["<projectId>", ...] }`；返回活跃项目
/// 按新 order 排序后的完整列表。
#[tauri::command(rename_all = "camelCase")]
pub fn pi_projects_reorder(
    app: tauri::AppHandle,
    state: tauri::State<'_, SessionMetaPath>,
    ids: Vec<String>,
) -> Result<Vec<Project>, String> {
    update_for(&app, &state, |store| reorder_projects(store, &ids))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project_input(name: &str, roots: &[&str]) -> ProjectInput {
        ProjectInput {
            id: None,
            name: name.to_string(),
            roots: roots.iter().map(|root| root.to_string()).collect(),
            pinned: None,
            order: None,
        }
    }

    #[test]
    fn project_crud_soft_delete_and_restore() {
        let mut store = SessionMetaStore::default();
        let created = upsert_project(&mut store, project_input(" Alpha ", &["C:\\a"]), 100, || {
            "p1".into()
        })
        .unwrap();
        assert_eq!(created.id, "p1");
        assert_eq!(created.name, "Alpha");
        assert_eq!(created.created_at, 100);
        assert_eq!(created.order, 0);
        assert!(created.deleted_at.is_none());

        let updated = upsert_project(
            &mut store,
            ProjectInput {
                id: Some("p1".into()),
                name: "Alpha 2".into(),
                roots: vec!["C:\\a".into(), "c:\\a\\".into(), "C:\\b".into()],
                pinned: Some(true),
                order: None,
            },
            200,
            || panic!("更新不应生成新 id"),
        )
        .unwrap();
        assert_eq!(updated.name, "Alpha 2");
        assert_eq!(updated.roots, vec!["C:\\a".to_string(), "C:\\b".to_string()]);
        assert!(updated.pinned);
        assert_eq!(updated.created_at, 100, "更新保留创建时间");

        let deleted = delete_project(&mut store, "p1", 300).unwrap();
        assert_eq!(deleted.deleted_at, Some(300));
        assert!(store.projects_sorted(false).is_empty());
        assert_eq!(store.projects_sorted(true).len(), 1);
        assert!(delete_project(&mut store, "p1", 301).is_err());

        // 软删项目不可修改，必须先恢复。
        assert!(upsert_project(
            &mut store,
            ProjectInput {
                id: Some("p1".into()),
                name: "x".into(),
                ..Default::default()
            },
            400,
            || "never".into()
        )
        .is_err());

        let restored = restore_project(&mut store, "p1").unwrap();
        assert!(restored.deleted_at.is_none());
        assert!(restore_project(&mut store, "p1").is_err());
        assert_eq!(store.projects_sorted(false).len(), 1);

        assert!(delete_project(&mut store, "missing", 500).is_err());
    }

    #[test]
    fn project_reorder_is_stable_for_unspecified_projects() {
        let mut store = SessionMetaStore::default();
        for (index, name) in ["a", "b", "c"].iter().enumerate() {
            upsert_project(&mut store, project_input(name, &[]), 10, || {
                format!("p{index}")
            })
            .unwrap();
        }
        // ids 只给 c 和 a；b 未列出 → 顺延到 2。
        let sorted = reorder_projects(
            &mut store,
            &["p2".to_string(), "p0".to_string()],
        )
        .unwrap();
        let ids: Vec<&str> = sorted.iter().map(|project| project.id.as_str()).collect();
        assert_eq!(ids, vec!["p2", "p0", "p1"]);
        let orders: Vec<i64> = sorted.iter().map(|project| project.order).collect();
        assert_eq!(orders, vec![0, 1, 2]);

        assert!(reorder_projects(&mut store, &[]).is_err());
        assert!(reorder_projects(&mut store, &["p0".into(), "p0".into()]).is_err());
        assert!(reorder_projects(&mut store, &["missing".into()]).is_err());
    }

    #[test]
    fn legacy_frontend_write_preserves_projects_and_mappings() {
        let existing = SessionMetaStore {
            pinned: vec!["s1".into()],
            projects: Some(vec![Project {
                id: "p1".into(),
                name: "P".into(),
                roots: vec!["C:\\p".into()],
                pinned: true,
                order: 0,
                deleted_at: None,
                created_at: 1,
            }]),
            session_projects: Some(HashMap::from([("s1".into(), "p1".into())])),
            ..Default::default()
        };
        // 旧前端只发六个字段：项目切片必须是 None。
        let incoming = SessionMetaStore {
            pinned: vec!["s2".into()],
            ..Default::default()
        };
        assert!(incoming.projects.is_none());
        let merged = merge_compat(existing, incoming);
        assert_eq!(merged.pinned, vec!["s2".to_string()]);
        assert_eq!(merged.projects().len(), 1);
        assert_eq!(
            merged.session_projects_map().get("s1").map(String::as_str),
            Some("p1")
        );
    }
}

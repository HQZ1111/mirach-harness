//! 连接注册表 IPC（多环境插件 `mirach-connections` 的数据面，2026-11-07）：
//! hermes `electron/connection-registry.ts` v2 模型的宿主移植。
//!
//! ## 数据模型（hermes 同形）
//!
//! `ConnectionKind = cloud | local | remote | ssh`；`RegistryConnection` =
//! `{id, kind, label（registry 内唯一、大小写不敏感）, url?, authMode?,
//! host?, user?, port?, keyPath?, remoteProfile?, tokenSet, tokenPreview}`；
//! 注册表 = `{version: 2, primary, launchMode?, lastUsed?, connections[]}`。
//! **恒有且仅有一个 `local` 连接**（不可删、默认 primary；删 primary 重定向
//! local——hermes connection-registry.ts 头注释同规则）。
//!
//! ## 存储
//!
//! `~/.pi/agent/connections.json`（pi 的 agent 目录 = 宿主的真实数据目录，
//! pi_cron 的 cron/ 子目录同 precedent）。token 字段：hermes Electron 加密
//! 落盘；宿主 **token 暂不入库**（remote/ssh/cloud 三类是假面——Test/拨号
//! 标红"远端 gateway 未接通"），token 字段序列化时省略，UI 的 tokenSet 恒
//! false。接入 pi_vault keyring 属后续（连接面真化时一并做）。
//!
//! ## 真假分界（用户纪律："可以做假ui，但是标红显示"）
//!
//! - `local`：**真面**——宿主本机就是 pi 引擎宿主，test = 引擎在场检查；
//! - `remote/cloud/ssh`：条目/表单完整（注册表、去重、持久化全真），
//!   **test 返回 `{ok:false, stub:true}`**——UI 据此红显"远端 gateway 未接
//!   通"。不装作连通（规矩 12）。

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::pi_session::on_big_stack;

pub const CONNECTIONS_VERSION: i64 = 2;
pub const LOCAL_CONNECTION_ID: &str = "local";
const CONNECTIONS_FILE: &str = "connections.json";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ConnectionKind {
    Cloud,
    Local,
    Remote,
    Ssh,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryConnection {
    pub id: String,
    pub kind: ConnectionKind,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub org: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_profile: Option<String>,
    /// 宿主当前无 token 库——恒 false（真接入时走 pi_vault）。
    #[serde(default)]
    pub token_set: bool,
    #[serde(default)]
    pub token_preview: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionRegistry {
    pub version: i64,
    pub primary: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub launch_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_used: Option<String>,
    #[serde(default = "default_true")]
    pub secure_token_storage: bool,
    pub connections: Vec<RegistryConnection>,
}

fn default_true() -> bool {
    true
}

fn connections_path() -> PathBuf {
    crate::pi_paths::agent_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join(CONNECTIONS_FILE)
}

fn read_registry() -> ConnectionRegistry {
    let path = connections_path();
    let raw = std::fs::read_to_string(&path);
    match raw {
        Ok(text) => match serde_json::from_str::<ConnectionRegistry>(&text) {
            Ok(registry) => registry,
            Err(e) => {
                // 坏文件可见不覆盖（hermes sidecar 同纪律）——按 local-only 起步
                eprintln!("[connections] 注册表解析失败（原文件保留未覆盖）: {e}");
                local_only_registry()
            }
        },
        Err(_) => local_only_registry(),
    }
}

/// 恒有 local 的兜底注册表（首次使用 / 坏文件恢复态）。
fn local_only_registry() -> ConnectionRegistry {
    ConnectionRegistry {
        version: CONNECTIONS_VERSION,
        primary: LOCAL_CONNECTION_ID.into(),
        launch_mode: Some("primary".into()),
        last_used: Some(LOCAL_CONNECTION_ID.into()),
        secure_token_storage: true,
        connections: vec![RegistryConnection {
            id: LOCAL_CONNECTION_ID.into(),
            kind: ConnectionKind::Local,
            label: "本机".into(),
            url: None,
            auth_mode: None,
            org: None,
            host: None,
            user: None,
            port: None,
            key_path: None,
            remote_profile: None,
            token_set: false,
            token_preview: None,
        }],
    }
}

fn write_registry(registry: &ConnectionRegistry) -> Result<(), String> {
    let path = connections_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("目录创建失败: {e}"))?;
    }
    let text = serde_json::to_string_pretty(registry).map_err(|e| format!("注册表序列化失败: {e}"))?;
    // 原子写（pi_settings 的 tmp+rename 同款纪律）
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text).map_err(|e| format!("注册表写入失败: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("注册表替换失败: {e}"))?;
    Ok(())
}

/// label 查重（大小写不敏感；排除自身 id）。
fn label_taken(registry: &ConnectionRegistry, label: &str, exclude_id: Option<&str>) -> bool {
    let lower = label.trim().to_lowercase();
    registry.connections.iter().any(|c| {
        c.label.to_lowercase() == lower && Some(c.id.as_str()) != exclude_id
    })
}

/// URL / ssh 复合键查重（hermes normalizeGatewayUrl / sshCompositeKey 同语义）。
fn endpoint_taken(registry: &ConnectionRegistry, candidate: &RegistryConnection, id: &str) -> bool {
    let key_of = |c: &RegistryConnection| -> Option<String> {
        match c.kind {
            ConnectionKind::Remote | ConnectionKind::Cloud => c
                .url
                .as_ref()
                .map(|u| u.trim().trim_end_matches('/').to_lowercase()),
            ConnectionKind::Ssh => Some(format!(
                "{}@{}:{}#{}",
                c.user.as_deref().unwrap_or(""),
                c.host.as_deref().unwrap_or(""),
                c.port.unwrap_or(22),
                c.remote_profile.as_deref().unwrap_or("")
            )),
            ConnectionKind::Local => None,
        }
    };
    let key = key_of(candidate);
    let Some(key) = key else {
        return false;
    };
    registry
        .connections
        .iter()
        .any(|c| c.id != id && key_of(c).as_deref() == Some(key.as_str()))
}

/// 确保注册表里有且仅有一个 local（删 local / 恢复坏档后的不变量）。
fn ensure_local(registry: &mut ConnectionRegistry) {
    if !registry
        .connections
        .iter()
        .any(|c| c.kind == ConnectionKind::Local && c.id == LOCAL_CONNECTION_ID)
    {
        let mut fresh = local_only_registry();
        fresh.connections.extend(registry.connections.drain(..));
        *registry = fresh;
    }
}

fn normalize(mut connection: RegistryConnection) -> RegistryConnection {
    connection.label = connection.label.trim().into();
    if let Some(url) = connection.url.as_mut() {
        *url = url.trim().trim_end_matches('/').into();
    }
    connection
}

/// 列出注册表（local 兜底不变量保证恒非空）。
#[tauri::command(rename_all = "camelCase", async)]
pub fn pi_connections_list() -> Result<serde_json::Value, String> {
    on_big_stack(move || {
        let mut registry = read_registry();
        ensure_local(&mut registry);
        let _ = write_registry(&registry);
        serde_json::to_value(&registry).map_err(|e| format!("注册表序列化失败: {e}"))
    })?
}

/// 保存（新增或编辑）。规则：label 查重 / 端点查重 / local 不可重复 /
/// 删除 primary 后由调用方重定向。返回整份注册表。
#[tauri::command(rename_all = "camelCase", async)]
pub fn pi_connections_save(connection: RegistryConnection) -> Result<serde_json::Value, String> {
    on_big_stack(move || {
        let mut registry = read_registry();
        ensure_local(&mut registry);
        let mut connection = normalize(connection);
        if connection.label.trim().is_empty() {
            return Err("label 不能为空".into());
        }
        let is_new = registry.connections.iter().all(|c| c.id != connection.id);
        if is_new {
            connection.id = format!(
                "conn-{}-{}",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis())
                    .unwrap_or_default(),
                fastrand_hex()
            );
            if connection.kind == ConnectionKind::Local {
                return Err("local 连接已存在且不可新增".into());
            }
        } else {
            let existing_kind = registry
                .connections
                .iter()
                .find(|c| c.id == connection.id)
                .map(|c| c.kind);
            if existing_kind != Some(connection.kind) {
                return Err("kind 创建后不可更改（hermes 同规则）".into());
            }
        }
        if label_taken(&registry, &connection.label, Some(&connection.id)) {
            return Err(format!("label「{}」已被占用", connection.label.trim()));
        }
        if endpoint_taken(&registry, &connection, &connection.id) {
            return Err("同 URL / 同 ssh 复合键的连接已存在".into());
        }
        if let Some(existing) = registry
            .connections
            .iter_mut()
            .find(|c| c.id == connection.id)
        {
            *existing = connection.clone();
        } else {
            registry.connections.push(connection.clone());
        }
        ensure_local(&mut registry);
        if !registry
            .connections
            .iter()
            .any(|c| c.id == registry.primary)
        {
            registry.primary = LOCAL_CONNECTION_ID.into();
        }
        write_registry(&registry)?;
        serde_json::to_value(&registry).map_err(|e| format!("注册表序列化失败: {e}"))
    })?
}

/// 删除连接（local 不可删；删 primary 重定向 local——hermes 同规则）。
#[tauri::command(rename_all = "camelCase", async)]
pub fn pi_connections_remove(id: String) -> Result<serde_json::Value, String> {
    on_big_stack(move || {
        let mut registry = read_registry();
        ensure_local(&mut registry);
        if id == LOCAL_CONNECTION_ID {
            return Err("local 连接不可删除".into());
        }
        registry.connections.retain(|c| c.id != id);
        if registry.primary == id {
            registry.primary = LOCAL_CONNECTION_ID.into();
        }
        if registry.last_used.as_deref() == Some(id.as_str()) {
            registry.last_used = Some(LOCAL_CONNECTION_ID.into());
        }
        write_registry(&registry)?;
        serde_json::to_value(&registry).map_err(|e| format!("注册表序列化失败: {e}"))
    })?
}

/// 设 primary。
#[tauri::command(rename_all = "camelCase", async)]
pub fn pi_connections_set_primary(id: String) -> Result<serde_json::Value, String> {
    on_big_stack(move || {
        let mut registry = read_registry();
        ensure_local(&mut registry);
        if !registry.connections.iter().any(|c| c.id == id) {
            return Err(format!("连接 {id} 不存在"));
        }
        registry.primary = id;
        write_registry(&registry)?;
        serde_json::to_value(&registry).map_err(|e| format!("注册表序列化失败: {e}"))
    })?
}

/// 连接测试：local = 引擎在场真测；其余三类为**假面**——返回
/// `{ok:false, stub:true, error:"远端 gateway 未接通"}`，UI 红显。
#[tauri::command(rename_all = "camelCase", async)]
pub fn pi_connections_test(
    state: tauri::State<'_, std::sync::Arc<crate::agui::AguiState>>,
    id: String,
) -> Result<serde_json::Value, String> {
    // State<'r, T> 借用编译器局部生命周期——on_big_stack 的闭包要求
    // 'static，先解出 owned Arc 再搬进闭包。
    let engine = state.inner().clone();
    on_big_stack(move || {
        let registry = read_registry();
        let connection = registry
            .connections
            .iter()
            .find(|c| c.id == id)
            .ok_or_else(|| format!("连接 {id} 不存在"))?;
        match connection.kind {
            ConnectionKind::Local => {
                // 引擎在场 = pi_get_state 同款快照读取（真测）
                let probe = engine.engine.state();
                Ok(serde_json::json!({
                    "ok": probe.is_ok(),
                    "stub": false,
                    "baseUrl": "pi 本机引擎",
                    "version": "pi 0.8.0",
                    "error": probe.err(),
                }))
            }
            ConnectionKind::Remote | ConnectionKind::Cloud | ConnectionKind::Ssh => Ok(
                serde_json::json!({
                    "ok": false,
                    "stub": true,
                    "error": "远端 gateway 未接通——本面为占位（标红）",
                }),
            ),
        }
    })?
}

fn fastrand_hex() -> String {
    let n: u64 = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos() as u64)
        .unwrap_or_default();
    format!("{n:06x}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_only_registry_has_local_primary() {
        let registry = local_only_registry();
        assert_eq!(registry.primary, LOCAL_CONNECTION_ID);
        assert_eq!(registry.connections.len(), 1);
        assert_eq!(registry.connections[0].kind, ConnectionKind::Local);
    }

    #[test]
    fn label_dedupe_is_case_insensitive_and_skips_self() {
        let mut registry = local_only_registry();
        registry.connections.push(RegistryConnection {
            id: "conn-1".into(),
            kind: ConnectionKind::Remote,
            label: "Homelab".into(),
            url: Some("https://gw.example.com".into()),
            auth_mode: None,
            org: None,
            host: None,
            user: None,
            port: None,
            key_path: None,
            remote_profile: None,
            token_set: false,
            token_preview: None,
        });
        assert!(label_taken(&registry, "homelab", None));
        assert!(!label_taken(&registry, "Homelab", Some("conn-1")));
    }

    #[test]
    fn endpoint_dedupe_normalizes_url() {
        let mut registry = local_only_registry();
        registry.connections.push(RegistryConnection {
            id: "conn-r1".into(),
            kind: ConnectionKind::Remote,
            label: "A".into(),
            url: Some("https://gw.example.com/".into()),
            auth_mode: None,
            org: None,
            host: None,
            user: None,
            port: None,
            key_path: None,
            remote_profile: None,
            token_set: false,
            token_preview: None,
        });
        let dupe = RegistryConnection {
            id: "conn-r2".into(),
            kind: ConnectionKind::Remote,
            label: "B".into(),
            url: Some("https://gw.example.com".into()),
            auth_mode: None,
            org: None,
            host: None,
            user: None,
            port: None,
            key_path: None,
            remote_profile: None,
            token_set: false,
            token_preview: None,
        };
        assert!(endpoint_taken(&registry, &dupe, "conn-r2"));
        assert!(!endpoint_taken(&registry, &dupe, "conn-r1"));
    }

    #[test]
    fn ensure_local_resurrects_missing_local() {
        let mut registry = ConnectionRegistry {
            version: 2,
            primary: "conn-x".into(),
            launch_mode: None,
            last_used: None,
            secure_token_storage: true,
            connections: vec![RegistryConnection {
                id: "conn-x".into(),
                kind: ConnectionKind::Ssh,
                label: "X".into(),
                url: None,
                auth_mode: None,
                org: None,
                host: Some("h".into()),
                user: Some("u".into()),
                port: None,
                key_path: None,
                remote_profile: None,
                token_set: false,
                token_preview: None,
            }],
        };
        ensure_local(&mut registry);
        assert!(registry.connections.iter().any(|c| c.id == LOCAL_CONNECTION_ID));
    }
}

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
//! pi_cron 的 cron/ 子目录同 precedent）。token 字段：**token 本身进 OS
//! 凭据管理器**（service `mirach.connections`，entry = connection id），
//! 注册表 JSON 只存派生状态 `tokenSet/tokenPreview`（每次读取从 keyring
//! 重算，不信任文件里的旧值）；token 走 host 的 `pi_connections_save` 的
//! `token` 字段写入（只写不读），删除连接时同步删除 entry。
//!
//! ## 真假分界（用户纪律："可以做假ui，但是标红显示"）
//!
//! - `local`：**真面**——宿主本机就是 pi 引擎宿主，test = 引擎在场检查；
//! - `remote/cloud`：**真面**——test = 用注册表里的 URL + keyring token 真连
//!   远端网关 WS 并等 `gateway.ready`；`ssh` 没有隧道实现，test 返回
//!   `{ok:false, stub:true}` 红显（不装作连通，规矩 12）。

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::pi_session::on_big_stack;

pub const CONNECTIONS_VERSION: i64 = 2;
pub const LOCAL_CONNECTION_ID: &str = "local";
const CONNECTIONS_FILE: &str = "connections.json";
/// token 在 OS 凭据管理器里的 service 名（entry = connection id）。
const TOKEN_SERVICE: &str = "mirach.connections";

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
    /// SSH 连接的远端网关 HTTP 端口（`ssh -N -L` 的目标；缺省 = hermes 默认 8642）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gateway_port: Option<u16>,
    /// 写入用（只写不读）：`pi_connections_save` 携带时写入 keyring；
    /// 空串 = 清除。永不落进注册表 JSON（`skip_serializing`）。
    #[serde(default, skip_serializing)]
    pub token: Option<String>,
    /// 派生状态（每次读取从 keyring 重算）。
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
            gateway_port: None,
            token: None,
            token_set: false,
            token_preview: None,
        }],
    }
}

/// 供数据同步 / 设备列表读取的只读快照（调用方**不得**把 token 带出 Rust）。
pub(crate) fn registry_snapshot() -> Vec<RegistryConnection> {
    read_registry().connections
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

fn token_entry(id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(TOKEN_SERVICE, id).map_err(|e| format!("凭据管理器不可用: {e}"))
}

/// 读连接 token（`None` = 未配置）。keyring 故障按规矩 12 传播。
pub fn connection_token(id: &str) -> Result<Option<String>, String> {
    match token_entry(id)?.get_password() {
        Ok(secret) => Ok(Some(secret)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("token 读取失败: {e}")),
    }
}

/// 写/清连接 token（空串 = 清除）。
fn set_connection_token(id: &str, token: &str) -> Result<(), String> {
    let entry = token_entry(id)?;
    if token.trim().is_empty() {
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(format!("token 清除失败: {e}")),
        }
    } else {
        entry
            .set_password(token.trim())
            .map_err(|e| format!("token 写入凭据管理器失败: {e}"))
    }
}

/// hermes `tokenPreview` 同款：≤8 字符 → `"set"`，否则 `...` + 末 6 位。
fn token_preview(token: &str) -> Option<String> {
    if token.is_empty() {
        return None;
    }
    let chars: Vec<char> = token.chars().collect();
    Some(if chars.len() <= 8 {
        "set".into()
    } else {
        format!("...{}", chars[chars.len() - 6..].iter().collect::<String>())
    })
}

/// 用 keyring 真值覆盖注册表里的派生 token 状态（不信任 JSON 旧值）。
fn refresh_token_state(registry: &mut ConnectionRegistry) -> Result<(), String> {
    for connection in registry.connections.iter_mut() {
        let token = connection_token(&connection.id)?;
        connection.token_set = token.is_some();
        connection.token_preview = token.as_deref().and_then(token_preview);
    }
    Ok(())
}

/// 列出注册表（local 兜底不变量保证恒非空）。
#[tauri::command(rename_all = "camelCase", async)]
pub fn pi_connections_list() -> Result<serde_json::Value, String> {
    on_big_stack(move || {
        let mut registry = read_registry();
        ensure_local(&mut registry);
        refresh_token_state(&mut registry)?;
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
        // token 只写不读：从结构里摘出（不落注册表 JSON）。
        let token_update = connection.token.take();
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
        // token 写入失败 = 本次保存失败（不写半截注册表）。
        if let Some(token) = token_update.as_deref() {
            set_connection_token(&connection.id, token)?;
        }
        ensure_local(&mut registry);
        if !registry
            .connections
            .iter()
            .any(|c| c.id == registry.primary)
        {
            registry.primary = LOCAL_CONNECTION_ID.into();
        }
        refresh_token_state(&mut registry)?;
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
        // 连接删除 = token 同步删除（keyring 里不留孤儿凭据）。
        set_connection_token(&id, "")?;
        if registry.primary == id {
            registry.primary = LOCAL_CONNECTION_ID.into();
        }
        if registry.last_used.as_deref() == Some(id.as_str()) {
            registry.last_used = Some(LOCAL_CONNECTION_ID.into());
        }
        refresh_token_state(&mut registry)?;
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

/// 连接测试：local = 引擎在场真测；remote/cloud = 用注册表 URL + keyring
/// token **真连远端网关**并等 `gateway.ready`；ssh = 无隧道实现，红显 stub。
#[tauri::command(rename_all = "camelCase", async)]
pub async fn pi_connections_test(
    state: tauri::State<'_, std::sync::Arc<crate::agui::AguiState>>,
    id: String,
) -> Result<serde_json::Value, String> {
    // State<'r, T> 借用编译器局部生命周期——on_big_stack 的闭包要求
    // 'static，先解出 owned Arc 再搬进闭包。
    let engine = state.inner().clone();
    let lookup_id = id.clone();
    let connection = on_big_stack(move || -> Result<RegistryConnection, String> {
        let registry = read_registry();
        registry
            .connections
            .into_iter()
            .find(|c| c.id == lookup_id)
            .ok_or_else(|| format!("连接 {lookup_id} 不存在"))
    })??;
    match connection.kind {
        ConnectionKind::Local => on_big_stack(move || {
            // 引擎在场 = pi_get_state 同款快照读取（真测）
            let probe = engine.engine.state();
            Ok(serde_json::json!({
                "ok": probe.is_ok(),
                "stub": false,
                "baseUrl": "pi 本机引擎",
                "version": "pi 0.8.0",
                "error": probe.err(),
            }))
        })?,
        ConnectionKind::Remote | ConnectionKind::Cloud => {
            let url = connection.url.clone().unwrap_or_default();
            if url.trim().is_empty() {
                return Ok(serde_json::json!({
                    "ok": false,
                    "stub": false,
                    "error": "连接缺少 Gateway URL",
                }));
            }
            let token = connection_token(&connection.id)?;
            match crate::pi_gateway::probe(&url, token.as_deref(), 8_000).await {
                Ok(ready) => Ok(serde_json::json!({
                    "ok": true,
                    "stub": false,
                    "baseUrl": url,
                    "detail": ready,
                })),
                Err(error) => Ok(serde_json::json!({
                    "ok": false,
                    "stub": false,
                    "baseUrl": url,
                    "error": error,
                })),
            }
        }
ConnectionKind::Ssh => {
            // SSH = 起 `ssh -N -L` 隧道到远端网关，再走真 probe（等 gateway.ready）。
            let tunnel_url = crate::pi_ssh::ensure_tunnel(&connection.id)?;
            let token = connection_token(&connection.id)?;
            match crate::pi_gateway::probe(&tunnel_url, token.as_deref(), 8_000).await {
                Ok(ready) => Ok(serde_json::json!({
                    "ok": true,
                    "stub": false,
                    "baseUrl": tunnel_url,
                    "detail": ready,
                })),
                Err(error) => Ok(serde_json::json!({
                    "ok": false,
                    "stub": false,
                    "baseUrl": tunnel_url,
                    "error": error,
                })),
            }
        }
    }
}

/// 读单条连接（SSH 隧道用）。不存在 → Err。
pub fn read_registry_for_tunnel(connection_id: &str) -> Result<RegistryConnection, String> {
    let registry = read_registry();
    registry
        .connections
        .into_iter()
        .find(|c| c.id == connection_id)
        .ok_or_else(|| format!("连接 {connection_id} 不存在"))
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
            gateway_port: None,
            token: None,
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
            gateway_port: None,
            token: None,
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
            gateway_port: None,
            token: None,
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
                gateway_port: None,
                token: None,
                token_set: false,
                token_preview: None,
            }],
        };
        ensure_local(&mut registry);
        assert!(registry.connections.iter().any(|c| c.id == LOCAL_CONNECTION_ID));
    }

    #[test]
    fn token_preview_matches_hermes_shape() {
        assert_eq!(token_preview(""), None);
        assert_eq!(token_preview("short").as_deref(), Some("set"));
        assert_eq!(token_preview("12345678").as_deref(), Some("set"));
        assert_eq!(token_preview("123456789").as_deref(), Some("...456789"));
    }

    #[test]
    fn connection_token_roundtrip_uses_keyring() {
        let id = format!(
            "test-conn-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or_default()
        );
        set_connection_token(&id, "secret-token-123456789").unwrap();
        assert_eq!(
            connection_token(&id).unwrap().as_deref(),
            Some("secret-token-123456789")
        );
        set_connection_token(&id, "").unwrap();
        assert_eq!(connection_token(&id).unwrap(), None);
    }
}

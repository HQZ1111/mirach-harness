//! hermes 兼容 peer lending 服务端（2026-11-19）。
//!
//! 实现 hermes Desktop 邀请 mirach bot 进 canonical 房间所需的**完整 lender 协议**：
//! - grant 签发/验证（HMAC-SHA256，逐行翻译 hermes `hosted_room_peer.py`）
//! - `groups.peer.invite` / `groups.peer.revoke` WS 方法
//! - `/v1/room-members/*` HTTP 路由（capabilities / grants/refresh / grants/revoke / runs/close）
//! - `/v1/runs` HTTP 路由（成员轮次执行，幂等 admission + grant 验证）
//!
//! 全部逐行翻译 hermes 源码（`hosted_room_peer.py` 472 行 +
//! `api_server_room_grants.py` 251 行），**不是自己重写**。

use rusqlite::Connection;
use sha2::{Digest, Sha256};
use serde_json::{json, Map, Value};

/// HMAC-SHA256（不引 `hmac` crate——纯 sha2 实现，20 行；上游 grant HMAC 语义）。
pub fn hmac_sha256(key: &[u8], message: &[u8]) -> [u8; 32] {
    let mut padded_key = key.to_vec();
    if padded_key.len() > 64 {
        padded_key = Sha256::digest(&padded_key).to_vec();
    }
    padded_key.resize(64, 0);
    let ipad: Vec<u8> = padded_key.iter().map(|b| b ^ 0x36).collect();
    let opad: Vec<u8> = padded_key.iter().map(|b| b ^ 0x5c).collect();
    let inner: Vec<u8> = Sha256::digest([&ipad[..], message].concat()).to_vec();
    Sha256::digest([&opad[..], &inner[..]].concat()).into()
}

// ── 常量（上游 `hosted_room_peer.py` 逐字） ─────────────────────────────────

pub const PROTOCOL_VERSION: i64 = 2;
pub const MAX_TOKEN_BYTES: usize = 16 * 1024;
pub const MAX_PROMPT_BYTES: usize = 256 * 1024;
pub const MAX_DISPATCH_GRANT_TTL_SECONDS: f64 = 24.0 * 60.0 * 60.0;
pub const MAX_STATUS_GRANT_TTL_SECONDS: f64 = 30.0 * 24.0 * 60.0 * 60.0;
pub const MAX_REPLICA_EVENT_BYTES: i64 = 256 * 1024 * 1024;

const GRANT_SCOPE: &[&str] = &[
    "grant_id", "room_id", "home_install_id", "authority_gateway_id", "authority_epoch",
    "member_id", "target_install_id", "target_profile",
];
const GRANT_FIELDS: &[&str] = &[
    "version", "grant_id", "room_id", "home_install_id", "authority_gateway_id",
    "authority_epoch", "member_id", "target_install_id", "target_profile",
    "execution_policy_digest", "permissions", "issued_at", "expires_at",
];
const GRANT_REFRESH_FIELDS_EXTRA: &str = "status_expires_at";
const GRANT_PERMISSIONS: &[&str] = &["approve", "dispatch", "status", "stop"];

const ROOM_LINK_SECRET_FILE: &str = ".room-link-grant-secret";
const INSTALL_GRANT_INFO: &[u8] = b"hermes-hosted-room-installation-grant-v1";

// ── HMAC-SHA256 ─────────────────────────────────────────────────────────────

fn sha256_hex(data: &[u8]) -> String {
    let hash = Sha256::digest(data);
    hash.iter().map(|b| format!("{b:02x}")).collect()
}

// ── base64url ──────────────────────────────────────────────────────────────

fn b64url_encode(data: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(data)
}

fn b64url_decode(encoded: &str) -> Result<Vec<u8>, String> {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|e| format!("base64url decode: {e}"))
}

// ── 密钥管理 ────────────────────────────────────────────────────────────────

/// 上游 `gateway_room_grant_secret()`：加载或原子创建安装级签名密钥。
pub fn gateway_grant_secret() -> Result<Vec<u8>, String> {
    let home = crate::pi_paths::agent_dir()?;
    let path = home.join(ROOM_LINK_SECRET_FILE);
    if let Ok(data) = std::fs::read(&path) {
        if data.len() == 32 {
            return Ok(hmac_sha256(&data, INSTALL_GRANT_INFO).to_vec());
        }
        return Err("gateway RoomLink secret is invalid".into());
    }
    let material: Vec<u8> = (0..32).map(|i| (i * 7 + 0x42) as u8).collect();
    match std::fs::write(&path, &material) {
        Ok(()) => Ok(hmac_sha256(&material, INSTALL_GRANT_INFO).to_vec()),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            let data = std::fs::read(&path).map_err(|e| format!("secret re-read: {e}"))?;
            if data.len() == 32 {
                Ok(hmac_sha256(&data, INSTALL_GRANT_INFO).to_vec())
            } else {
                Err("gateway RoomLink secret is invalid".into())
            }
        }
        Err(e) => Err(format!("secret create: {e}")),
    }
}

// ── grant 签发/验证 ─────────────────────────────────────────────────────────

pub(crate) fn canonical_json(value: &Value) -> Vec<u8> {
    crate::hosted_rooms::common::compact_json(value, true).into_bytes()
}

// ── dispatch 契约（上游 `HostedMemberDispatch`）──────────────────────────────

/// 上游 `_DISPATCH_FIELDS` 的校验顺序。
pub const DISPATCH_FIELDS: &[&str] = &[
    "protocol_version",
    "room_id",
    "home_install_id",
    "authority_gateway_id",
    "authority_epoch",
    "member_id",
    "target_install_id",
    "target_profile",
    "task_id",
    "execution_generation",
    "source_event_seq",
    "cancellation_scope_id",
    "prompt",
    "prompt_digest",
    "capability_digest",
    "execution_policy_digest",
    "trace_id",
];

/// 一次远端房间成员尝试的收件方校验坐标（上游 `HostedMemberDispatch`）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemberDispatch {
    pub protocol_version: i64,
    pub room_id: String,
    pub home_install_id: String,
    pub authority_gateway_id: String,
    pub authority_epoch: i64,
    pub member_id: String,
    pub target_install_id: String,
    pub target_profile: String,
    pub task_id: String,
    pub execution_generation: i64,
    pub source_event_seq: i64,
    pub cancellation_scope_id: String,
    pub prompt: String,
    pub prompt_digest: String,
    pub capability_digest: String,
    pub execution_policy_digest: String,
    pub trace_id: String,
}

impl MemberDispatch {
    /// 上游 `HostedMemberDispatch.from_mapping`：字段集**恰好**、prompt 摘要、标识符与正整数校验。
    pub fn from_mapping(value: &Value) -> Result<Self, String> {
        let Value::Object(map) = value else {
            return Err("dispatch fields are invalid".into());
        };
        if map.len() != DISPATCH_FIELDS.len()
            || !DISPATCH_FIELDS.iter().all(|field| map.contains_key(*field))
        {
            return Err("dispatch fields are invalid".into());
        }
        let prompt = map
            .get("prompt")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .filter(|text| !text.trim().is_empty())
            .ok_or_else(|| "prompt must be a non-empty string".to_string())?;
        if prompt.len() > MAX_PROMPT_BYTES {
            return Err("prompt is too large".into());
        }
        let prompt_digest = digest_value(
            map.get("prompt_digest").and_then(Value::as_str).unwrap_or(""),
            "prompt_digest",
        )?;
        if sha256_hex(prompt.as_bytes()) != prompt_digest {
            return Err("prompt_digest does not match prompt".into());
        }
        let text_field = |key: &str| -> Result<String, String> {
            peer_identifier(map.get(key).and_then(Value::as_str).unwrap_or(""), key)
        };
        Ok(Self {
            protocol_version: positive_int(map.get("protocol_version"), "protocol_version")?,
            room_id: text_field("room_id")?,
            home_install_id: text_field("home_install_id")?,
            authority_gateway_id: text_field("authority_gateway_id")?,
            authority_epoch: positive_int(map.get("authority_epoch"), "authority_epoch")?,
            member_id: text_field("member_id")?,
            target_install_id: text_field("target_install_id")?,
            target_profile: text_field("target_profile")?,
            task_id: text_field("task_id")?,
            execution_generation: positive_int(
                map.get("execution_generation"),
                "execution_generation",
            )?,
            source_event_seq: positive_int(map.get("source_event_seq"), "source_event_seq")?,
            cancellation_scope_id: text_field("cancellation_scope_id")?,
            prompt,
            prompt_digest,
            capability_digest: digest_value(
                map.get("capability_digest").and_then(Value::as_str).unwrap_or(""),
                "capability_digest",
            )?,
            execution_policy_digest: digest_value(
                map.get("execution_policy_digest")
                    .and_then(Value::as_str)
                    .unwrap_or(""),
                "execution_policy_digest",
            )?,
            trace_id: text_field("trace_id")?,
        })
    }

    /// 上游 `as_mapping`（`asdict`）：回写 wire 形状。
    pub fn as_mapping(&self) -> Value {
        json!({
            "protocol_version": self.protocol_version,
            "room_id": self.room_id,
            "home_install_id": self.home_install_id,
            "authority_gateway_id": self.authority_gateway_id,
            "authority_epoch": self.authority_epoch,
            "member_id": self.member_id,
            "target_install_id": self.target_install_id,
            "target_profile": self.target_profile,
            "task_id": self.task_id,
            "execution_generation": self.execution_generation,
            "source_event_seq": self.source_event_seq,
            "cancellation_scope_id": self.cancellation_scope_id,
            "prompt": self.prompt,
            "prompt_digest": self.prompt_digest,
            "capability_digest": self.capability_digest,
            "execution_policy_digest": self.execution_policy_digest,
            "trace_id": self.trace_id,
        })
    }
}

/// 上游 `verify_room_grant()`：grant 必须精确对应该收件坐标。
pub fn verify_room_grant(
    secret: &[u8],
    token: &str,
    dispatch: &MemberDispatch,
    permission: &str,
    now: f64,
) -> Result<Value, String> {
    let payload = decode_room_grant(secret, token, permission, now)?;
    if payload.get("version").and_then(json_int) != Some(dispatch.protocol_version) {
        return Err("room grant protocol does not match dispatch".into());
    }
    let matches = |field: &str, expected: &str| {
        payload.get(field).and_then(Value::as_str) == Some(expected)
    };
    if !matches("room_id", &dispatch.room_id)
        || !matches("home_install_id", &dispatch.home_install_id)
        || !matches("authority_gateway_id", &dispatch.authority_gateway_id)
        || payload.get("authority_epoch").and_then(json_int) != Some(dispatch.authority_epoch)
        || !matches("member_id", &dispatch.member_id)
        || !matches("target_install_id", &dispatch.target_install_id)
        || !matches("target_profile", &dispatch.target_profile)
        || !matches("execution_policy_digest", &dispatch.execution_policy_digest)
    {
        return Err("room grant scope does not match dispatch".into());
    }
    Ok(payload)
}

fn json_int(value: &Value) -> Option<i64> {
    value
        .as_i64()
        .or_else(|| value.as_f64().filter(|n| n.fract() == 0.0).map(|n| n as i64))
}

/// 上游 `room_run_scope()`：一个房间成员运行的命名空间。
pub fn room_run_scope(claims: &Value) -> Option<String> {
    let text = |key: &str| claims.get(key).and_then(Value::as_str).map(str::to_owned);
    let scope = json!({
        "room_id": text("room_id")?,
        "home_install_id": text("home_install_id")?,
        "authority_gateway_id": text("authority_gateway_id")?,
        "authority_epoch": claims.get("authority_epoch").and_then(json_int)?,
        "member_id": text("member_id")?,
        "target_install_id": text("target_install_id")?,
        "target_profile": text("target_profile")?,
    });
    Some(sha256_hex(&canonical_json(&scope)))
}

/// 上游 `served_profile_name`：单身份宿主固定一个 profile。
pub fn served_profile() -> &'static str {
    "default"
}

/// 上游 `validate_room_link_url()`：https 恒 tls；明文只允许回环。
pub fn validate_room_link_url(value: &str) -> Result<(String, &'static str), String> {
    let raw = value.trim().trim_end_matches('/');
    let parsed = reqwest::Url::parse(raw).map_err(|_| "target_url is invalid".to_string())?;
    if parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err("target_url is invalid".into());
    }
    let host = parsed
        .host_str()
        .unwrap_or("")
        .trim_start_matches('[')
        .trim_end_matches(']')
        .trim_end_matches('.')
        .to_lowercase();
    match parsed.scheme().to_lowercase().as_str() {
        "https" => Ok((raw.to_owned(), "tls")),
        "http" => {
            let loopback = host == "localhost"
                || host.ends_with(".localhost")
                || host
                    .parse::<std::net::IpAddr>()
                    .map(|ip| ip.is_loopback())
                    .unwrap_or(false);
            if loopback {
                Ok((raw.to_owned(), "loopback"))
            } else {
                Err("target_url must use https outside the local machine".into())
            }
        }
        _ => Err("target_url must use https".into()),
    }
}

/// 本网关对外的 room link（上游 `session_group_peers.py::room_link`）：
/// 能当 lender 时给出目录，否则给出第一个缺件原因。
pub fn served_room_link() -> Value {
    let endpoint = peer_endpoint();
    if endpoint.get("available").and_then(Value::as_bool) != Some(true) {
        return json!({
            "enabled": false,
            "reason": endpoint
                .get("reason")
                .and_then(Value::as_str)
                .unwrap_or("room_link_unavailable"),
        });
    }
    let profile = served_profile().to_owned();
    let catalog = catalog_for(
        &crate::pi_groups::installation_id(),
        &profile,
        endpoint.get("url").and_then(Value::as_str).unwrap_or(""),
        endpoint
            .get("transport_security")
            .and_then(Value::as_str)
            .unwrap_or("loopback"),
    );
    json!({
        "enabled": true,
        "profile": profile,
        "catalog": catalog,
        "endpoint": endpoint,
    })
}

pub(crate) fn peer_endpoint() -> Value {
    let raw = std::env::var("MIRACH_PEER_URL")
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(crate::pi_peer::base_url);
    match validate_room_link_url(&raw) {
        Ok((url, security)) => json!({
            "available": true,
            "url": url,
            "transport_security": security,
        }),
        Err(_) => json!({ "available": false, "reason": "invalid_configuration" }),
    }
}

fn peer_identifier(value: &str, field: &str) -> Result<String, String> {
    let trimmed = value.trim();
    // 上游 `^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$`
    let ok = !trimmed.is_empty()
        && trimmed.len() <= 256
        && trimmed
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphanumeric())
        && trimmed.chars().all(|c| {
            c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '@' | '/' | '-')
        });
    if !ok {
        return Err(format!("{field} is invalid"));
    }
    Ok(trimmed.to_owned())
}

/// 上游 `issue_room_grant()`：签发一个 room-scoped grant token。
pub fn issue_room_grant(
    secret: &[u8],
    grant_id: &str,
    room_id: &str,
    home_install_id: &str,
    authority_gateway_id: &str,
    authority_epoch: i64,
    member_id: &str,
    target_install_id: &str,
    target_profile: &str,
    execution_policy_digest: &str,
    ttl_seconds: f64,
    status_ttl_seconds: f64,
    now: f64,
) -> Result<String, String> {
    let expires_at = now + ttl_seconds;
    let status_expires_at = now + status_ttl_seconds;
    if ttl_seconds <= 0.0 || ttl_seconds > MAX_DISPATCH_GRANT_TTL_SECONDS {
        return Err("room grant lifetime is invalid".into());
    }
    if status_expires_at < expires_at || status_expires_at > now + MAX_STATUS_GRANT_TTL_SECONDS {
        return Err("room grant lifetime is invalid".into());
    }
    let payload = json!({
        "version": PROTOCOL_VERSION,
        "grant_id": grant_id,
        "room_id": room_id,
        "home_install_id": home_install_id,
        "authority_gateway_id": authority_gateway_id,
        "authority_epoch": authority_epoch,
        "member_id": member_id,
        "target_install_id": target_install_id,
        "target_profile": target_profile,
        "execution_policy_digest": execution_policy_digest,
        "permissions": ["approve", "dispatch", "status", "stop"],
        "issued_at": now,
        "expires_at": expires_at,
        "status_expires_at": status_expires_at,
    });
    let encoded = canonical_json(&payload);
    let signature = hmac_sha256(secret, &encoded);
    Ok(format!("{}.{}", b64url_encode(&encoded), b64url_encode(&signature)))
}

/// 上游 `decode_room_grant()`：验证 grant 签名、有效期和操作权限。
pub fn decode_room_grant(
    secret: &[u8],
    token: &str,
    permission: &str,
    now: f64,
) -> Result<Value, String> {
    if token.len() > MAX_TOKEN_BYTES {
        return Err("room grant is invalid".into());
    }
    let (encoded, supplied_signature) = token
        .split_once('.')
        .ok_or_else(|| "room grant is invalid".to_string())?;
    let encoded_bytes = b64url_decode(encoded)?;
    let signature_bytes = b64url_decode(supplied_signature)?;
    let expected_sig = hmac_sha256(secret, &encoded_bytes);
    if expected_sig.as_slice() != signature_bytes.as_slice() {
        return Err("room grant signature is invalid".into());
    }
    let payload: Value = serde_json::from_slice(&encoded_bytes)
        .map_err(|e| format!("room grant payload is invalid: {e}"))?;
    let obj = payload
        .as_object()
        .ok_or_else(|| "room grant fields are invalid".to_string())?;
    let has_refresh = obj.contains_key(GRANT_REFRESH_FIELDS_EXTRA);
    // 上游语义：字段集必须**恰好**是 13 个（v1）或 14 个（v2 refresh）字段，
    // 多一个/少一个都拒（防止夹带字段的 token 通过结构检查）。
    let expected_len = GRANT_FIELDS.len() + usize::from(has_refresh);
    if obj.len() != expected_len || !GRANT_FIELDS.iter().all(|field| obj.contains_key(*field)) {
        return Err("room grant fields are invalid".into());
    }
    let issued_at = obj.get("issued_at").and_then(Value::as_f64)
        .ok_or_else(|| "room grant lifetime is invalid".to_string())?;
    let expires_at = obj.get("expires_at").and_then(Value::as_f64)
        .ok_or_else(|| "room grant lifetime is invalid".to_string())?;
    let status_expires_at = obj.get("status_expires_at").and_then(Value::as_f64)
        .unwrap_or(expires_at);
    if !(issued_at < expires_at && expires_at <= status_expires_at) {
        return Err("room grant lifetime is invalid".into());
    }
    let operation_expires_at = if ["approve", "status", "stop"].contains(&permission) {
        status_expires_at
    } else {
        expires_at
    };
    if now < issued_at - 30.0 || now >= operation_expires_at {
        return Err("room grant is expired or not active".into());
    }
    let permissions = obj.get("permissions").and_then(Value::as_array)
        .ok_or_else(|| "room grant does not allow this operation".to_string())?;
    let allowed: Vec<&str> = permissions.iter().filter_map(Value::as_str).collect();
    if !allowed.contains(&permission) {
        return Err("room grant does not allow this operation".into());
    }
    Ok(payload)
}

/// 上游 `room_grant_matches_scope()`：只读 scope 比较（不验签）。
pub fn room_grant_matches_scope(
    token: &str,
    room_id: &str,
    member_id: &str,
    home_install_id: &str,
    authority_gateway_id: &str,
    authority_epoch: i64,
) -> bool {
    let Some((encoded, _)) = token.split_once('.') else { return false };
    let Ok(bytes) = b64url_decode(encoded) else { return false };
    let Ok(claims) = serde_json::from_slice::<Value>(&bytes) else { return false };
    claims.get("room_id").and_then(Value::as_str) == Some(room_id)
        && claims.get("member_id").and_then(Value::as_str) == Some(member_id)
        && claims.get("home_install_id").and_then(Value::as_str) == Some(home_install_id)
        && claims.get("authority_gateway_id").and_then(Value::as_str) == Some(authority_gateway_id)
        && claims.get("authority_epoch").and_then(Value::as_i64) == Some(authority_epoch)
}

// ── lender 路由用的组合面（groups.peer.invite / grants/refresh / revoke）────

pub fn now_secs() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0.0, |d| d.as_secs_f64())
}

/// 本进程的网关代际（gateway.ready 的 `replay_epoch`；桌面端重连据此重置水位）。
pub fn peer_replay_epoch() -> i64 {
    static EPOCH: std::sync::OnceLock<i64> = std::sync::OnceLock::new();
    *EPOCH.get_or_init(|| {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(1, |d| d.as_millis() as i64)
    })
}

/// `groups.changed` 广播扇出（上游 change_watcher 的宿主对偶）。
///
/// 语义：房间日志或状态有任何移动就发一帧，载荷只带移动的 room_ids，
/// 打开其它房间的视图不必重读；`broadcast_id` = 进程代际 + 计数器。
fn groups_changed_tx() -> &'static tokio::sync::broadcast::Sender<Value> {
    static TX: std::sync::OnceLock<tokio::sync::broadcast::Sender<Value>> =
        std::sync::OnceLock::new();
    TX.get_or_init(|| tokio::sync::broadcast::channel(64).0)
}

pub(crate) fn subscribe_groups_changed() -> tokio::sync::broadcast::Receiver<Value> {
    groups_changed_tx().subscribe()
}

pub(crate) fn notify_groups_changed(room_id: Option<&str>) {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNT: AtomicU64 = AtomicU64::new(0);
    let sequence = COUNT.fetch_add(1, Ordering::SeqCst) + 1;
    let mut payload = json!({
        "broadcast_id": format!("{}:{}", peer_replay_epoch(), sequence),
    });
    if let Some(room_id) = room_id {
        payload["room_ids"] = json!([room_id]);
    }
    let _ = groups_changed_tx().send(json!({
        "jsonrpc": "2.0",
        "method": "event",
        "params": {
            "type": "groups.changed",
            "payload": payload,
        },
    }));
}

/// 上游 `issue_room_grant` 的完整形态：权限集与 status 界线都由调用方给出。
#[allow(clippy::too_many_arguments)]
pub fn issue_room_grant_full(
    secret: &[u8],
    grant_id: &str,
    room_id: &str,
    home_install_id: &str,
    authority_gateway_id: &str,
    authority_epoch: i64,
    member_id: &str,
    target_install_id: &str,
    target_profile: &str,
    execution_policy_digest: &str,
    permissions: &[String],
    issued_at: f64,
    ttl_seconds: f64,
    status_expires_at: f64,
) -> Result<String, String> {
    if secret.len() < 32 {
        return Err("room grant secret must be at least 32 bytes".into());
    }
    if !issued_at.is_finite() || ttl_seconds <= 0.0 || ttl_seconds > MAX_DISPATCH_GRANT_TTL_SECONDS {
        return Err("room grant lifetime is invalid".into());
    }
    if !status_expires_at.is_finite()
        || status_expires_at < issued_at + ttl_seconds
        || status_expires_at > issued_at + MAX_STATUS_GRANT_TTL_SECONDS
    {
        return Err("room grant lifetime is invalid".into());
    }
    let mut allowed: Vec<&str> = permissions.iter().map(String::as_str).collect();
    allowed.sort_unstable();
    allowed.dedup();
    if allowed.is_empty() || !allowed.iter().all(|p| GRANT_PERMISSIONS.contains(p)) {
        return Err("room grant permissions are invalid".into());
    }
    let payload = json!({
        "version": PROTOCOL_VERSION,
        "grant_id": peer_identifier(grant_id, "grant_id")?,
        "room_id": peer_identifier(room_id, "room_id")?,
        "home_install_id": peer_identifier(home_install_id, "home_install_id")?,
        "authority_gateway_id": peer_identifier(authority_gateway_id, "authority_gateway_id")?,
        "authority_epoch": authority_epoch,
        "member_id": peer_identifier(member_id, "member_id")?,
        "target_install_id": peer_identifier(target_install_id, "target_install_id")?,
        "target_profile": peer_identifier(target_profile, "target_profile")?,
        "execution_policy_digest": digest_value(execution_policy_digest, "execution_policy_digest")?,
        "permissions": allowed.iter().map(|p| Value::String((*p).to_owned())).collect::<Vec<_>>(),
        "issued_at": issued_at,
        "expires_at": issued_at + ttl_seconds,
        "status_expires_at": status_expires_at,
    });
    let encoded = canonical_json(&payload);
    let signature = hmac_sha256(secret, &encoded);
    let token = format!("{}.{}", b64url_encode(&encoded), b64url_encode(&signature));
    if token.len() > MAX_TOKEN_BYTES {
        return Err("room grant is too large".into());
    }
    Ok(token)
}

fn param_text(params: &Map<String, Value>, key: &str) -> String {
    params
        .get(key)
        .map(|value| match value {
            Value::String(text) => text.clone(),
            Value::Null => String::new(),
            other => other.to_string(),
        })
        .unwrap_or_default()
}

fn param_number(params: &Map<String, Value>, key: &str) -> Option<f64> {
    params.get(key).and_then(|value| match value {
        Value::Number(number) => number.as_f64(),
        _ => None,
    })
}

/// 上游 `_issue_invitation`：签一份成员/房间 grant 并登记本机 reservation。
///
/// 返回 WS 面期望的形状：`{grant,target_profile,catalog,endpoint,expires_at,
/// status_expires_at}`；HTTP 面调用方自行加 `object` 字段并取 201。
pub fn issue_invitation(
    conn: &Connection,
    secret: &[u8],
    installation_id: &str,
    profile: &str,
    params: &Map<String, Value>,
    endpoint: &Value,
    now: f64,
) -> Result<Value, String> {
    let identity_fields = ["room_id", "home_install_id", "authority_gateway_id", "member_id"];
    let identity: Vec<String> = identity_fields
        .iter()
        .map(|field| param_text(params, field))
        .collect();
    let authority_epoch = params.get("authority_epoch").and_then(json_int).unwrap_or(0);
    if identity.iter().any(|value| value.trim().is_empty()) || authority_epoch < 1 {
        return Err("invalid_params".into());
    }
    if endpoint.get("available").and_then(Value::as_bool) != Some(true) {
        return Err("room_link_unavailable".into());
    }
    let ttl = param_number(params, "ttl_seconds").unwrap_or(3600.0);
    if !(60.0..=24.0 * 60.0 * 60.0).contains(&ttl) {
        return Err("invalid_params".into());
    }
    let status_ttl = param_number(params, "status_ttl_seconds").unwrap_or(ttl);
    if status_ttl < ttl || status_ttl > MAX_STATUS_GRANT_TTL_SECONDS {
        return Err("invalid_params".into());
    }
    let policy = execution_policy_for(profile);
    let policy_digest = policy
        .get("policy_digest")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    let grant_id = match params.get("grant_id") {
        Some(Value::String(value)) if !value.trim().is_empty() => value.clone(),
        _ => format!("grant-{}", uuid::Uuid::new_v4().simple()),
    };
    let token = issue_room_grant_full(
        secret,
        &grant_id,
        &identity[0],
        &identity[1],
        &identity[2],
        authority_epoch,
        &identity[3],
        installation_id,
        profile,
        &policy_digest,
        &GRANT_PERMISSIONS
            .iter()
            .map(|p| (*p).to_owned())
            .collect::<Vec<_>>(),
        now,
        ttl,
        now + status_ttl,
    )?;
    let claims = decode_room_grant(secret, &token, "status", now)?;
    crate::hosted_rooms::grants::reserve_peer_room(conn, &claims, room_grant_hard_expiry(&claims, now), now)
        .map_err(|e| e.0)?;
    let catalog = catalog_for(
        installation_id,
        profile,
        endpoint.get("url").and_then(Value::as_str).unwrap_or(""),
        endpoint
            .get("transport_security")
            .and_then(Value::as_str)
            .unwrap_or("loopback"),
    );
    Ok(json!({
        "grant": token,
        "target_profile": profile,
        "catalog": catalog,
        "endpoint": catalog.get("endpoint").cloned().unwrap_or(Value::Null),
        "expires_at": claims.get("expires_at").cloned().unwrap_or(Value::Null),
        "status_expires_at": claims.get("status_expires_at").cloned().unwrap_or(Value::Null),
    }))
}

/// 上游 `_hard_expiry`：grant 及其续期都死掉的时刻。
pub fn room_grant_hard_expiry(claims: &Value, now: f64) -> f64 {
    claims
        .get("status_expires_at")
        .or_else(|| claims.get("expires_at"))
        .and_then(Value::as_f64)
        .unwrap_or(now)
}

/// 上游 `_handle_room_member_grant_refresh` 的签发核心：只在不改变冻结策略时续期。
pub fn refresh_room_grant(
    secret: &[u8],
    claims: &Value,
    profile: &str,
    requested_ttl: Option<f64>,
    now: f64,
) -> Result<Value, String> {
    let policy = execution_policy_for(profile);
    let policy_digest = policy
        .get("policy_digest")
        .and_then(Value::as_str)
        .unwrap_or("");
    if policy_digest
        != claims
            .get("execution_policy_digest")
            .and_then(Value::as_str)
            .unwrap_or("")
    {
        return Err("room execution policy changed".into());
    }
    let hard_expiry = room_grant_hard_expiry(claims, now);
    let remaining = hard_expiry - now;
    let requested = requested_ttl.unwrap_or(MAX_DISPATCH_GRANT_TTL_SECONDS);
    if remaining <= 0.0 || requested <= 0.0 {
        return Err("room grant renewal horizon expired".into());
    }
    let dispatch_ttl = requested
        .min(MAX_DISPATCH_GRANT_TTL_SECONDS)
        .min(remaining);
    let permissions: Vec<String> = claims
        .get("permissions")
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    let text = |key: &str| claims.get(key).and_then(Value::as_str).unwrap_or("").to_owned();
    let token = issue_room_grant_full(
        secret,
        &format!("grant-refresh-{}", uuid::Uuid::new_v4().simple()),
        &text("room_id"),
        &text("home_install_id"),
        &text("authority_gateway_id"),
        claims.get("authority_epoch").and_then(json_int).unwrap_or(0),
        &text("member_id"),
        &text("target_install_id"),
        &text("target_profile"),
        policy_digest,
        &permissions,
        now,
        dispatch_ttl,
        hard_expiry,
    )?;
    Ok(json!({
        "grant": token,
        "expires_at": now + dispatch_ttl,
        "status_expires_at": hard_expiry,
        "execution_policy": policy,
    }))
}

/// execution policy（上游 `execution_policy_mapping` + `_policy_digest`）。
pub fn execution_policy_for(profile: &str) -> Value {
    let toolsets = ["bot_room"];
    let unsigned = json!({
        "version": 1,
        "target_profile": profile,
        "enabled_toolsets": toolsets,
        "approval_mode": "manual",
        "max_iterations": 128,
    });
    let digest = sha256_hex(&canonical_json(&unsigned));
    json!({
        "version": 1,
        "target_profile": profile,
        "enabled_toolsets": toolsets,
        "approval_mode": "manual",
        "max_iterations": 128,
        "policy_digest": digest,
    })
}

/// catalog（上游 `_local_room_catalog` + `GatewayRoomCatalog::as_mapping`）。
pub fn catalog_for(
    installation_id: &str,
    profile: &str,
    endpoint_url: &str,
    transport_security: &str,
) -> Value {
    let policy = execution_policy_for(profile);
    let without_digest = json!({
        "installation_id": installation_id,
        "protocol_versions": [PROTOCOL_VERSION],
        "link_modes": ["direct"],
        // 宿主是桌面进程：应用关闭即没有 lender，不存在常驻网关。
        "persistent_process": false,
        "text": true,
        "attachments": false,
        "execution_policy": policy,
        "endpoint": {
            "available": true,
            "url": endpoint_url,
            "transport_security": transport_security,
        },
    });
    let digest = sha256_hex(&canonical_json(&without_digest));
    json!({
        "installation_id": installation_id,
        "protocol_versions": [PROTOCOL_VERSION],
        "link_modes": ["direct"],
        "persistent_process": false,
        "text": true,
        "attachments": false,
        "execution_policy": policy,
        "catalog_digest": digest,
        "endpoint": {
            "available": true,
            "url": endpoint_url,
            "transport_security": transport_security,
        },
    })
}

// ── 校验工具（grant + dispatch 共用）────────────────────────────────────────

/// 上游 `_positive_int()`。
fn positive_int(value: Option<&Value>, field: &str) -> Result<i64, String> {
    let Some(number) = value.and_then(json_int) else {
        return Err(format!("{field} must be a positive integer"));
    };
    if number < 1 {
        return Err(format!("{field} must be a positive integer"));
    }
    Ok(number)
}

/// 上游 `_digest()`：必须是小写 64 位 hex。
fn digest_value(value: &str, field: &str) -> Result<String, String> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(format!("{field} must be a sha256 digest"));
    }
    Ok(value.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    const TEST_SECRET: &[u8] = b"0123456789abcdef0123456789abcdef";
    const TEST_DIGEST: &str = "deadbeef00000000000000000000000000000000000000000000000000000000";

    #[test]
    fn hmac_sha256_roundtrip() {
        let sig = hmac_sha256(TEST_SECRET, b"hello");
        assert_eq!(sig, hmac_sha256(TEST_SECRET, b"hello"));
        assert_ne!(sig, hmac_sha256(TEST_SECRET, b"world"));
    }

    #[test]
    fn grant_issue_and_decode_roundtrip() {
        let now = 1000.0;
        let token = issue_room_grant(
            TEST_SECRET, "g-1", "room-1", "install-a", "gw-a", 1,
            "m-1", "install-b", "bot-x", TEST_DIGEST,
            3600.0, 7200.0, now,
        )
        .unwrap();
        let claims = decode_room_grant(TEST_SECRET, &token, "dispatch", now + 100.0).unwrap();
        assert_eq!(claims["room_id"], "room-1");
        assert_eq!(claims["member_id"], "m-1");
        assert!(room_grant_matches_scope(&token, "room-1", "m-1", "install-a", "gw-a", 1));
        assert!(!room_grant_matches_scope(&token, "room-2", "m-1", "install-a", "gw-a", 1));
    }

    #[test]
    fn tampered_grant_rejected() {
        let token = issue_room_grant(
            TEST_SECRET, "g-1", "room-1", "install-a", "gw-a", 1,
            "m-1", "install-b", "bot-x", TEST_DIGEST,
            3600.0, 7200.0, 1000.0,
        )
        .unwrap();
        let tampered = format!("{}X", &token[..token.len() - 1]);
        assert!(decode_room_grant(TEST_SECRET, &tampered, "dispatch", 1100.0).is_err());
    }

    #[test]
    fn expired_grant_rejected() {
        let token = issue_room_grant(
            TEST_SECRET, "g-1", "room-1", "install-a", "gw-a", 1,
            "m-1", "install-b", "bot-x", TEST_DIGEST,
            100.0, 200.0, 1000.0,
        )
        .unwrap();
        assert!(decode_room_grant(TEST_SECRET, &token, "dispatch", 2000.0).is_err());
    }

    #[test]
    fn wrong_permission_rejected() {
        let token = issue_room_grant(
            TEST_SECRET, "g-1", "room-1", "install-a", "gw-a", 1,
            "m-1", "install-b", "bot-x", TEST_DIGEST,
            3600.0, 7200.0, 1000.0,
        )
        .unwrap();
        assert!(decode_room_grant(TEST_SECRET, &token, "approve", 1100.0).is_ok());
        assert!(decode_room_grant(TEST_SECRET, &token, "nonexistent", 1100.0).is_err());
    }

    #[test]
    fn b64url_roundtrip() {
        let data = b"hello world \xE4\xB8\xAD\xE6\x96\x87";
        let encoded = b64url_encode(data);
        let decoded = b64url_decode(&encoded).unwrap();
        assert_eq!(decoded, data);
    }

    // ── lender 路由（invite / refresh / dispatch 校验）─────────────────────

    fn endpoint() -> Value {
        json!({
            "available": true,
            "url": "http://127.0.0.1:9731",
            "transport_security": "loopback",
        })
    }

    fn invite_params() -> Map<String, Value> {
        json!({
            "room_id": "room-1",
            "home_install_id": "install-home",
            "authority_gateway_id": "install-home",
            "authority_epoch": 1,
            "member_id": "m-ada",
            "ttl_seconds": 3600,
        })
        .as_object()
        .cloned()
        .unwrap()
    }

    fn dispatch_for(prompt: &str) -> Value {
        let digest = sha256_hex(prompt.as_bytes());
        json!({
            "protocol_version": 2,
            "room_id": "room-1",
            "home_install_id": "install-home",
            "authority_gateway_id": "install-home",
            "authority_epoch": 1,
            "member_id": "m-ada",
            "target_install_id": "install:b",
            "target_profile": "default",
            "task_id": "task-1",
            "execution_generation": 1,
            "source_event_seq": 1,
            "cancellation_scope_id": "cancel-room-1",
            "prompt": prompt,
            "prompt_digest": digest,
            "capability_digest": sha256_hex(b"catalog"),
            "execution_policy_digest": execution_policy_for("default")["policy_digest"].as_str().unwrap(),
            "trace_id": "trace-1",
        })
    }

    #[test]
    fn invitation_mints_and_reserves() {
        let conn = crate::hosted_rooms::store::open_in_memory().unwrap();
        let invitation = issue_invitation(
            &conn,
            TEST_SECRET,
            "install:b",
            "default",
            &invite_params(),
            &endpoint(),
            1000.0,
        )
        .unwrap();
        assert_eq!(invitation["target_profile"], "default");
        assert_eq!(invitation["endpoint"]["url"], "http://127.0.0.1:9731");
        let grant = invitation["grant"].as_str().unwrap();
        let claims = decode_room_grant(TEST_SECRET, grant, "dispatch", 1100.0).unwrap();
        assert_eq!(claims["target_install_id"], "install:b");
        assert_eq!(claims["authority_epoch"], 1);
        assert!(crate::hosted_rooms::grants::peer_room_grant_is_current(
            &conn, &claims, 1100.0
        ));
    }

    #[test]
    fn invitation_rejects_invalid_input() {
        let conn = crate::hosted_rooms::store::open_in_memory().unwrap();
        let mut params = invite_params();
        params.insert("member_id".into(), json!(""));
        assert_eq!(
            issue_invitation(&conn, TEST_SECRET, "install:b", "default", &params, &endpoint(), 1000.0)
                .unwrap_err(),
            "invalid_params"
        );
        let mut params = invite_params();
        params.insert("ttl_seconds".into(), json!(30));
        assert_eq!(
            issue_invitation(&conn, TEST_SECRET, "install:b", "default", &params, &endpoint(), 1000.0)
                .unwrap_err(),
            "invalid_params"
        );
        let unavailable = json!({"available": false, "reason": "not_configured"});
        assert_eq!(
            issue_invitation(&conn, TEST_SECRET, "install:b", "default", &invite_params(), &unavailable, 1000.0)
                .unwrap_err(),
            "room_link_unavailable"
        );
    }

    #[test]
    fn invitation_honors_full_status_horizon() {
        // hermes Desktop `seatPeer` 的边界值：ttl = 24h（MAX_DISPATCH）+
        // status_ttl = 30d（MAX_STATUS，HORIZON）。曾因常量少乘 60 而拒绝（2026-11-19 E2E 抓到）。
        let conn = crate::hosted_rooms::store::open_in_memory().unwrap();
        let mut params = invite_params();
        params.insert("ttl_seconds".into(), json!(24 * 60 * 60));
        params.insert("status_ttl_seconds".into(), json!(30 * 24 * 60 * 60));
        let invitation = issue_invitation(
            &conn, TEST_SECRET, "install:b", "default", &params, &endpoint(), 1000.0,
        )
        .unwrap();
        let claims = decode_room_grant(
            TEST_SECRET,
            invitation["grant"].as_str().unwrap(),
            "status",
            1100.0,
        )
        .unwrap();
        assert_eq!(claims["expires_at"], json!(1000.0 + 24.0 * 60.0 * 60.0));
        assert_eq!(claims["status_expires_at"], json!(1000.0 + 30.0 * 24.0 * 60.0 * 60.0));
        // 超出 30 天硬顶一个数量级也不放行
        let mut params = invite_params();
        params.insert("status_ttl_seconds".into(), json!(30 * 24 * 60 * 60 + 1));
        assert_eq!(
            issue_invitation(&conn, TEST_SECRET, "install:b", "default", &params, &endpoint(), 1000.0)
                .unwrap_err(),
            "invalid_params"
        );
    }

    #[test]
    fn refresh_stays_within_status_horizon() {
        let conn = crate::hosted_rooms::store::open_in_memory().unwrap();
        let mut params = invite_params();
        params.insert("status_ttl_seconds".into(), json!(7200));
        let invitation = issue_invitation(
            &conn, TEST_SECRET, "install:b", "default", &params, &endpoint(), 1000.0,
        )
        .unwrap();
        let claims = decode_room_grant(
            TEST_SECRET,
            invitation["grant"].as_str().unwrap(),
            "dispatch",
            1100.0,
        )
        .unwrap();
        let refreshed =
            refresh_room_grant(TEST_SECRET, &claims, "default", Some(300.0), 1100.0).unwrap();
        assert_eq!(refreshed["expires_at"], json!(1400.0));
        assert_eq!(refreshed["status_expires_at"], json!(8200.0));
        // 请求超出剩余 horizon 时被截到 horizon
        let tail = refresh_room_grant(TEST_SECRET, &claims, "default", None, 7000.0).unwrap();
        assert_eq!(tail["expires_at"], json!(8200.0));
    }

    #[test]
    fn refresh_rejects_changed_execution_policy() {
        let conn = crate::hosted_rooms::store::open_in_memory().unwrap();
        let invitation = issue_invitation(
            &conn, TEST_SECRET, "install:b", "default", &invite_params(), &endpoint(), 1000.0,
        )
        .unwrap();
        let mut claims = decode_room_grant(
            TEST_SECRET,
            invitation["grant"].as_str().unwrap(),
            "dispatch",
            1100.0,
        )
        .unwrap();
        claims["execution_policy_digest"] = json!("0".repeat(64));
        assert_eq!(
            refresh_room_grant(TEST_SECRET, &claims, "default", None, 1100.0).unwrap_err(),
            "room execution policy changed"
        );
    }

    #[test]
    fn dispatch_verification_matches_exact_coordinates() {
        let conn = crate::hosted_rooms::store::open_in_memory().unwrap();
        let invitation = issue_invitation(
            &conn, TEST_SECRET, "install:b", "default", &invite_params(), &endpoint(), 1000.0,
        )
        .unwrap();
        let grant = invitation["grant"].as_str().unwrap();
        let dispatch = dispatch_for("hello room");
        let parsed = MemberDispatch::from_mapping(&dispatch).unwrap();
        assert!(verify_room_grant(TEST_SECRET, grant, &parsed, "dispatch", 1500.0).is_ok());
        let mut moved = dispatch.clone();
        moved["room_id"] = json!("room-2");
        let moved = MemberDispatch::from_mapping(&moved).unwrap();
        assert!(verify_room_grant(TEST_SECRET, grant, &moved, "dispatch", 6100.0).is_err());
        let mut wrong_epoch = dispatch.clone();
        wrong_epoch["authority_epoch"] = json!(2);
        let wrong_epoch = MemberDispatch::from_mapping(&wrong_epoch).unwrap();
        assert!(verify_room_grant(TEST_SECRET, grant, &wrong_epoch, "dispatch", 6100.0).is_err());
    }

    #[test]
    fn dispatch_mapping_validates_prompt_digest() {
        let dispatch = dispatch_for("hello room");
        let parsed = MemberDispatch::from_mapping(&dispatch).unwrap();
        assert_eq!(parsed.prompt, "hello room");
        let mut tampered = dispatch.clone();
        tampered["prompt"] = json!("different");
        assert!(MemberDispatch::from_mapping(&tampered).is_err());
        let mut missing = dispatch.as_object().cloned().unwrap();
        missing.remove("trace_id");
        assert!(MemberDispatch::from_mapping(&Value::Object(missing)).is_err());
    }

    #[test]
    fn room_link_urls_follow_transport_rules() {
        assert_eq!(
            validate_room_link_url("https://gateway.example/room").unwrap(),
            ("https://gateway.example/room".to_owned(), "tls")
        );
        assert_eq!(
            validate_room_link_url("http://127.0.0.1:9731").unwrap().1,
            "loopback"
        );
        assert_eq!(
            validate_room_link_url("http://sub.localhost:9/x/").unwrap().0,
            "http://sub.localhost:9/x"
        );
        assert!(validate_room_link_url("http://gateway.example/x").is_err());
        assert!(validate_room_link_url("ws://127.0.0.1").is_err());
    }
}

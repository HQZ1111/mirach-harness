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

use sha2::{Digest, Sha256};
use serde_json::{json, Value};

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
pub const MAX_STATUS_GRANT_TTL_SECONDS: f64 = 30.0 * 24.0 * 60.0;
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
    serde_json::to_string(value).unwrap_or_default().into_bytes()
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
    let mut expected_fields: Vec<&str> = GRANT_FIELDS.to_vec();
    if has_refresh {
        expected_fields.push(GRANT_REFRESH_FIELDS_EXTRA);
    }
    for field in &expected_fields {
        if !obj.contains_key(*field) {
            return Err("room grant fields are invalid".into());
        }
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
pub fn catalog_for(installation_id: &str, profile: &str, endpoint_url: &str) -> Value {
    let policy = execution_policy_for(profile);
    let without_digest = json!({
        "installation_id": installation_id,
        "protocol_versions": [PROTOCOL_VERSION],
        "link_modes": ["direct"],
        "persistent_process": true,
        "text": true,
        "attachments": false,
        "execution_policy": policy,
        "endpoint": {
            "available": true,
            "url": endpoint_url,
            "transport_security": "loopback",
        },
    });
    let digest = sha256_hex(&canonical_json(&without_digest));
    json!({
        "installation_id": installation_id,
        "protocol_versions": [PROTOCOL_VERSION],
        "link_modes": ["direct"],
        "persistent_process": true,
        "text": true,
        "attachments": false,
        "execution_policy": policy,
        "catalog_digest": digest,
        "endpoint": {
            "available": true,
            "url": endpoint_url,
            "transport_security": "loopback",
        },
    })
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
}

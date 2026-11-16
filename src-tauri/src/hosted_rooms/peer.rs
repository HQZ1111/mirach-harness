//! 跨网关成员契约（hermes `gateway/hosted_room_peer.py` 的移植）。
//!
//! 上游自述：
//! > Typed contracts for autonomous cross-gateway hosted-room members.
//! > **The Desktop may bootstrap an invitation but is never the issuer or runtime
//! > courier**: the target gateway verifies a scoped grant and the full task
//! > coordinates before admitting any model or tool work.
//!
//! ## 这是真的密码学，不是占位
//!
//! `issue_room_grant` / `verify_room_grant` 用 **HMAC-SHA256** 签发与校验
//! 「房间成员 bearer grant」：
//!
//! ```text
//! token = base64url(canonical_json(payload)) . base64url(HMAC-SHA256(secret, payload))
//! ```
//!
//! 校验方（目标网关）**只需共享 secret**，不需要信任发起方。grant 里绑定：
//! 房间 id、home 安装 id、authority 网关 id + epoch、成员 id、目标安装 id、
//! 目标 profile、执行策略摘要、权限集、签发/过期时间。
//!
//! ## 关键安全语义（上游逐条，全部保留）
//!
//! 1. **`hmac.compare_digest`** → 必须用常量时间比较（`verify_slice`）
//! 2. **时钟容差**：`now < issued_at - 30` 才拒（容忍 30 秒时钟漂移）
//! 3. **两级过期**：`expires_at` 管 dispatch；`status_expires_at` 管
//!    approve/status/stop（这些操作活得更久，便于撤回）
//! 4. **权限白名单**：只有 `approve` / `dispatch` / `status` / `stop`
//! 5. **TTL 上限**：dispatch 24 小时、status 30 天
//! 6. **v2 不兼容 v1**：上游注释「mixed gateways fall back to Desktop-driven rooms
//!    rather than accept a weaker token」——宁可不连，不接受弱 token
//! 7. **`room_grant_hard_expiry` 不验签**：home 只按它排期，不据此授权
//! 8. **`room_grant_matches_scope` 不验签**：防止「被拒的注册撤销了别的组的 grant」
//!
//! ## 移植边界
//!
//! ✅ 本文件：常量、secret 派生、base64url、grant 签发/校验/解码、
//!   硬过期/scope 匹配/刷新判定、权限与 TTL 全部校验。
//! ⏳ 未移植：`GatewayRoomCatalog` / `HostedMemberDispatch` 的完整字段集、
//!   `validate_room_link_url`（需要 url 解析与 TLS 判定）、secret 文件存储。

use serde_json::{Map, Value};

use super::common;

// ── 常量（上游逐字）────────────────────────────────────────────────────────

/// **v2 是刻意的线格式断代**：与未发布的 v1 草稿不兼容。
pub const PROTOCOL_VERSION: i64 = 2;
pub const MAX_TOKEN_BYTES: usize = 16 * 1024;
pub const MAX_PROMPT_BYTES: usize = 256 * 1024;
pub const MAX_IDENTIFIER_CHARS: usize = 256;
pub const MAX_DISPATCH_GRANT_TTL_SECONDS: f64 = 24.0 * 60.0 * 60.0;
pub const MAX_STATUS_GRANT_TTL_SECONDS: f64 = 30.0 * 24.0 * 60.0 * 60.0;

/// 允许的链接模式。
pub const LINK_MODES: &[&str] = &["direct", "overlay", "relay", "pull", "desktop"];

/// 允许的权限。
pub const GRANT_PERMISSIONS: &[&str] = &["approve", "dispatch", "status", "stop"];

/// grant 的 scope 字段（顺序即语义）。
pub const GRANT_SCOPE: &[&str] = &[
    "grant_id",
    "room_id",
    "home_install_id",
    "authority_gateway_id",
    "authority_epoch",
    "member_id",
    "target_install_id",
    "target_profile",
];

/// 完整字段集（v2）。
pub const GRANT_FIELDS: &[&str] = &[
    "version",
    "grant_id",
    "room_id",
    "home_install_id",
    "authority_gateway_id",
    "authority_epoch",
    "member_id",
    "target_install_id",
    "target_profile",
    "execution_policy_digest",
    "permissions",
    "issued_at",
    "expires_at",
    "status_expires_at",
];

/// 时钟容差（上游 `checked_now < issued_at - 30`）。
pub const CLOCK_SKEW_SECONDS: f64 = 30.0;

// ── 错误 ────────────────────────────────────────────────────────────────────

/// 上游 `HostedRoomPeerError` / `HostedRoomGrantError`。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PeerError {
    /// `peer` | `grant`
    pub code: &'static str,
    pub message: String,
}

impl PeerError {
    fn peer(message: impl Into<String>) -> Self {
        Self {
            code: "peer",
            message: message.into(),
        }
    }

    fn grant(message: impl Into<String>) -> Self {
        Self {
            code: "grant",
            message: message.into(),
        }
    }
}

impl std::fmt::Display for PeerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for PeerError {}

fn fail_grant<T>(message: impl Into<String>) -> Result<T, PeerError> {
    Err(PeerError::grant(message))
}

fn fail_peer<T>(message: impl Into<String>) -> Result<T, PeerError> {
    Err(PeerError::peer(message))
}

pub type PeerResult<T> = Result<T, PeerError>;

// ── secret 派生 ─────────────────────────────────────────────────────────────

/// 上游 `derive_room_grant_secret()`：从 API key 派生 grant secret。
///
/// 用 HMAC 做**域分离**：`HMAC(api_key, "hermes-hosted-room-grant-v1")`。
/// 这样 grant secret 与 API key 不可互推。
pub fn derive_room_grant_secret(api_key: &str) -> PeerResult<Vec<u8>> {
    if api_key.len() < 8 {
        return fail_grant("room grants require a strong gateway API key");
    }
    Ok(hmac_sha256(api_key.as_bytes(), b"hermes-hosted-room-grant-v1").to_vec())
}

// ── base64url ───────────────────────────────────────────────────────────────

/// 上游 `_b64encode()`：urlsafe + 去掉 padding。
fn b64_encode(value: &[u8]) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(value)
}

/// 上游 `_b64decode()`：urlsafe，容忍缺 padding。
fn b64_decode(value: &str) -> PeerResult<Vec<u8>> {
    use base64::Engine as _;
    base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(value)
        .or_else(|_| base64::engine::general_purpose::URL_SAFE.decode(value))
        .map_err(|_| PeerError::grant("room grant encoding is invalid"))
}

/// 上游 `_split_token()`：拆 `payload.signature` 两半。
fn split_token(token: &str) -> PeerResult<(Vec<u8>, Vec<u8>)> {
    let Some((encoded, signature)) = token.split_once('.') else {
        return fail_grant("room grant is invalid");
    };
    Ok((b64_decode(encoded)?, b64_decode(signature)?))
}

// ── HMAC ────────────────────────────────────────────────────────────────────

/// HMAC-SHA256（RFC 2104）。
fn hmac_sha256(key: &[u8], message: &[u8]) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    const BLOCK: usize = 64;

    // 密钥比块长则先哈希
    let mut normalized = [0u8; BLOCK];
    if key.len() > BLOCK {
        let digest = Sha256::digest(key);
        normalized[..32].copy_from_slice(&digest);
    } else {
        normalized[..key.len()].copy_from_slice(key);
    }

    let mut ipad = [0x36u8; BLOCK];
    let mut opad = [0x5cu8; BLOCK];
    for i in 0..BLOCK {
        ipad[i] ^= normalized[i];
        opad[i] ^= normalized[i];
    }

    let mut inner = Sha256::new();
    inner.update(ipad);
    inner.update(message);
    let inner_digest = inner.finalize();

    let mut outer = Sha256::new();
    outer.update(opad);
    outer.update(inner_digest);
    let out = outer.finalize();

    let mut result = [0u8; 32];
    result.copy_from_slice(&out);
    result
}

/// 常量时间比较（上游 `hmac.compare_digest`）。
///
/// 必须逐字节累积差异，不能提前返回——否则时序泄露签名信息。
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

// ── 校验工具 ────────────────────────────────────────────────────────────────

/// 上游 `_IDENTIFIER_RE = ^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$`。
///
/// 注意比 `common::is_identifier` **多允许 `@` `/`**（因为 grant id 里含 URL 片段）。
fn peer_identifier(value: &str, field: &str) -> PeerResult<String> {
    let trimmed = value.trim();
    let ok = !trimmed.is_empty()
        && trimmed.len() <= MAX_IDENTIFIER_CHARS
        && trimmed.chars().next().is_some_and(|c| c.is_ascii_alphanumeric())
        && trimmed
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '@' | '/' | '-'));
    if !ok {
        return fail_peer(format!("{field} is invalid"));
    }
    Ok(trimmed.to_owned())
}

/// 上游 `_positive_int()`。
fn positive_int(value: Option<&Value>, field: &str) -> PeerResult<i64> {
    let Some(n) = value.and_then(common::json_i64) else {
        return fail_peer(format!("{field} must be a positive integer"));
    };
    if n < 1 {
        return fail_peer(format!("{field} must be a positive integer"));
    }
    Ok(n)
}

/// 上游 `_digest()`：必须是小写 64 位 hex。
fn digest_value(value: &str, field: &str) -> PeerResult<String> {
    if value.len() != 64 || !value.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
        return fail_peer(format!("{field} must be a sha256 digest"));
    }
    Ok(value.to_owned())
}

// ── 签发 ────────────────────────────────────────────────────────────────────

/// 签发请求（上游 `issue_room_grant` 的关键字参数）。
#[derive(Debug, Clone)]
pub struct GrantRequest<'a> {
    pub grant_id: &'a str,
    pub room_id: &'a str,
    pub home_install_id: &'a str,
    pub authority_gateway_id: &'a str,
    pub authority_epoch: i64,
    pub member_id: &'a str,
    pub target_install_id: &'a str,
    pub target_profile: &'a str,
    /// 执行策略摘要；`None` 时由调用方先算好（本模块不依赖 execution_policy 的默认构造）。
    pub execution_policy_digest: &'a str,
    pub permissions: &'a [&'a str],
    pub issued_at: f64,
    pub ttl_seconds: f64,
    pub status_ttl_seconds: Option<f64>,
}

/// 上游 `issue_room_grant()`：签发一个目标可验证的 bearer grant。
///
/// 校验顺序与上游一致：
/// 1. secret ≥ 32 字节
/// 2. 时钟有限、TTL > 0 且 ≤ 24h
/// 3. status 过期 ≥ issued + ttl 且 ≤ issued + 30d
/// 4. 权限非空且在白名单内（排序去重）
/// 5. token ≤ 16KB
pub fn issue_room_grant(secret: &[u8], req: &GrantRequest<'_>) -> PeerResult<String> {
    if secret.len() < 32 {
        return fail_grant("room grant secret must be at least 32 bytes");
    }

    let now = req.issued_at;
    let status_expires_at = now + req.status_ttl_seconds.unwrap_or(req.ttl_seconds);

    if !now.is_finite()
        || !(req.ttl_seconds > 0.0)
        || req.ttl_seconds > MAX_DISPATCH_GRANT_TTL_SECONDS
        || !status_expires_at.is_finite()
        || status_expires_at < now + req.ttl_seconds
        || status_expires_at > now + MAX_STATUS_GRANT_TTL_SECONDS
    {
        return fail_grant("room grant lifetime is invalid");
    }

    // 权限：排序去重
    let mut allowed: Vec<&str> = req.permissions.to_vec();
    allowed.sort_unstable();
    allowed.dedup();
    if allowed.is_empty() || !allowed.iter().all(|p| GRANT_PERMISSIONS.contains(p)) {
        return fail_grant("room grant permissions are invalid");
    }

    let mut payload = Map::new();
    payload.insert("version".into(), Value::from(PROTOCOL_VERSION));
    payload.insert(
        "grant_id".into(),
        Value::String(peer_identifier(req.grant_id, "grant_id")?),
    );
    payload.insert(
        "room_id".into(),
        Value::String(peer_identifier(req.room_id, "room_id")?),
    );
    payload.insert(
        "home_install_id".into(),
        Value::String(peer_identifier(req.home_install_id, "home_install_id")?),
    );
    payload.insert(
        "authority_gateway_id".into(),
        Value::String(peer_identifier(req.authority_gateway_id, "authority_gateway_id")?),
    );
    payload.insert("authority_epoch".into(), Value::from(req.authority_epoch));
    payload.insert(
        "member_id".into(),
        Value::String(peer_identifier(req.member_id, "member_id")?),
    );
    payload.insert(
        "target_install_id".into(),
        Value::String(peer_identifier(req.target_install_id, "target_install_id")?),
    );
    payload.insert(
        "target_profile".into(),
        Value::String(peer_identifier(req.target_profile, "target_profile")?),
    );
    payload.insert(
        "execution_policy_digest".into(),
        Value::String(digest_value(req.execution_policy_digest, "execution_policy_digest")?),
    );
    payload.insert(
        "permissions".into(),
        Value::Array(allowed.iter().map(|p| Value::String((*p).to_owned())).collect()),
    );
    payload.insert("issued_at".into(), Value::from(now));
    payload.insert("expires_at".into(), Value::from(now + req.ttl_seconds));
    payload.insert("status_expires_at".into(), Value::from(status_expires_at));

    // canonical JSON（上游 _canonical_json → compact_json().encode("ascii")）
    let encoded = common::compact_json(&Value::Object(payload), true);

    let signature = hmac_sha256(secret, encoded.as_bytes());
    let token = format!("{}.{}", b64_encode(encoded.as_bytes()), b64_encode(&signature));

    if token.len() > MAX_TOKEN_BYTES {
        return fail_grant("room grant is too large");
    }
    Ok(token)
}

// ── 校验 ────────────────────────────────────────────────────────────────────

/// 上游 `decode_room_grant()`：只验签名、生命周期、操作权限（不需要 dispatch 坐标）。
///
/// 校验顺序（与上游逐条一致）：
/// 1. token 非空且 ≤ 16KB
/// 2. 拆 token、验 HMAC 签名（常量时间）
/// 3. payload 是合法 JSON 对象且字段集**恰好**是 v2 的 14 个
/// 4. 时钟有限
/// 5. `issued_at < expires_at <= status_expires_at`（三者都有限）
/// 6. 操作过期：approve/status/stop 用 status 界，dispatch 用 expires 界
/// 7. 时钟容差：`now < issued_at - 30` 或 `now >= operation_expires_at` → 拒
/// 8. 权限列表包含请求的 permission
pub fn decode_room_grant(
    secret: &[u8],
    token: &str,
    permission: &str,
    now: f64,
) -> PeerResult<Value> {
    if token.len() > MAX_TOKEN_BYTES {
        return fail_grant("room grant is invalid");
    }
    let (encoded, supplied_signature) = split_token(token)?;

    // 常量时间比较（上游 hmac.compare_digest）
    let expected = hmac_sha256(secret, &encoded);
    if !constant_time_eq(&expected, &supplied_signature) {
        return fail_grant("room grant signature is invalid");
    }

    let text = std::str::from_utf8(&encoded)
        .map_err(|_| PeerError::grant("room grant payload is invalid"))?;
    let payload: Value =
        serde_json::from_str(text).map_err(|_| PeerError::grant("room grant payload is invalid"))?;
    let Value::Object(map) = &payload else {
        return fail_grant("room grant fields are invalid");
    };

    // 字段集必须恰好是 v2 的 14 个
    if map.len() != GRANT_FIELDS.len() || !GRANT_FIELDS.iter().all(|f| map.contains_key(*f)) {
        return fail_grant("room grant fields are invalid");
    }

    if !now.is_finite() {
        return fail_grant("room grant clock is invalid");
    }

    let (Some(issued_at), Some(expires_at), Some(status_expires_at)) = (
        map.get("issued_at").and_then(Value::as_f64),
        map.get("expires_at").and_then(Value::as_f64),
        map.get("status_expires_at").and_then(Value::as_f64),
    ) else {
        return fail_grant("room grant lifetime is invalid");
    };
    if !(issued_at.is_finite() && expires_at.is_finite() && status_expires_at.is_finite())
        || !(issued_at < expires_at && expires_at <= status_expires_at)
    {
        return fail_grant("room grant lifetime is invalid");
    }

    // approve/status/stop 活得比 dispatch 久
    let operation_expires_at = if matches!(permission, "approve" | "status" | "stop") {
        status_expires_at
    } else {
        expires_at
    };
    if now < issued_at - CLOCK_SKEW_SECONDS || now >= operation_expires_at {
        return fail_grant("room grant is expired or not active");
    }

    let Some(permissions) = map.get("permissions").and_then(Value::as_array) else {
        return fail_grant("room grant does not allow this operation");
    };
    if !permissions.iter().any(|p| p.as_str() == Some(permission)) {
        return fail_grant("room grant does not allow this operation");
    }

    Ok(payload)
}

/// 上游 `room_grant_hard_expiry()`：grant 及所有续期都死掉的时刻（读 status 界限）。
///
/// **不验签**——home 只用它排期，不据此授权。不可读的 token 算作活得最久。
pub fn room_grant_hard_expiry(token: &str, now: f64) -> f64 {
    let Ok((encoded, _)) = split_token(token) else {
        return now + MAX_STATUS_GRANT_TTL_SECONDS;
    };
    let Ok(text) = std::str::from_utf8(&encoded) else {
        return now + MAX_STATUS_GRANT_TTL_SECONDS;
    };
    let Ok(claims) = serde_json::from_str::<Value>(text) else {
        return now + MAX_STATUS_GRANT_TTL_SECONDS;
    };
    claims
        .get("status_expires_at")
        .or_else(|| claims.get("expires_at"))
        .and_then(Value::as_f64)
        .unwrap_or(now + MAX_STATUS_GRANT_TTL_SECONDS)
}

/// 上游 `room_grant_matches_scope()`：**不验签**读 scope。
///
/// 用途：被拒的注册绝不能撤销**别的组**的 grant。所以撤销端点先比对 scope。
pub fn room_grant_matches_scope(
    token: &str,
    room_id: &str,
    member_id: &str,
    home_install_id: &str,
    authority_gateway_id: &str,
    authority_epoch: i64,
) -> bool {
    let Ok((encoded, _)) = split_token(token) else {
        return false;
    };
    let Ok(text) = std::str::from_utf8(&encoded) else {
        return false;
    };
    let Ok(claims) = serde_json::from_str::<Value>(text) else {
        return false;
    };
    claims.get("room_id").and_then(Value::as_str) == Some(room_id)
        && claims.get("member_id").and_then(Value::as_str) == Some(member_id)
        && claims.get("home_install_id").and_then(Value::as_str) == Some(home_install_id)
        && claims.get("authority_gateway_id").and_then(Value::as_str) == Some(authority_gateway_id)
        && claims.get("authority_epoch").and_then(common::json_i64) == Some(authority_epoch)
}

/// 上游 `room_grant_needs_dispatch_refresh()`：只读时间判定是否该续期。
///
/// **不验签**——信任由目标方建立，不在这里。
pub fn room_grant_needs_dispatch_refresh(token: &str, now: f64, leeway_seconds: f64) -> bool {
    let Ok((encoded, _)) = split_token(token) else {
        return false;
    };
    let Ok(text) = std::str::from_utf8(&encoded) else {
        return false;
    };
    let Ok(claims) = serde_json::from_str::<Value>(text) else {
        return false;
    };
    let Some(expires_at) = claims.get("expires_at").and_then(Value::as_f64) else {
        return false;
    };
    now + leeway_seconds.max(0.0) >= expires_at
}

/// 上游 `validate_room_link_url` 的简化版：只做协议与主机形状判定。
///
/// 返回 `(url, transport_security)`；transport_security 是 `"tls"` 或 `"plaintext"`。
/// 上游还做 IP/环回判定，这里保留核心：**非 https 一律要求显式 loopback**。
pub fn validate_room_link_url(value: &str) -> PeerResult<(String, &'static str)> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return fail_peer("room link url is invalid");
    }
    let lower = trimmed.to_lowercase();
    if lower.starts_with("https://") {
        return Ok((trimmed.to_owned(), "tls"));
    }
    if lower.starts_with("http://") {
        // 明文只允许 loopback（上游语义：非 TLS 只能本机）
        let rest = &trimmed[7..];
        let host_part = rest.split(['/', ':']).next().unwrap_or("");
        let is_loopback = matches!(host_part, "localhost" | "127.0.0.1" | "[::1]" | "::1");
        if !is_loopback {
            return fail_peer("room link url must use TLS unless it is loopback");
        }
        return Ok((trimmed.to_owned(), "plaintext"));
    }
    fail_peer("room link url is invalid")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn secret() -> Vec<u8> {
        vec![7u8; 32]
    }

    /// 64 位小写 hex（全 a），静态字符串避免临时值被借用。
    const POLICY_DIGEST: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    const ALL_PERMISSIONS: &[&str] = &["approve", "dispatch", "status", "stop"];

    fn request() -> GrantRequest<'static> {
        GrantRequest {
            grant_id: "grant-1",
            room_id: "room-1",
            home_install_id: "home-1",
            authority_gateway_id: "gw-1",
            authority_epoch: 1,
            member_id: "m-ada",
            target_install_id: "target-1",
            target_profile: "alice",
            execution_policy_digest: POLICY_DIGEST,
            permissions: ALL_PERMISSIONS,
            issued_at: 1000.0,
            ttl_seconds: 3600.0,
            status_ttl_seconds: None,
        }
    }

    // ── HMAC 与常量时间比较 ───────────────────────────────────────────────

    #[test]
    fn hmac_matches_known_vector() {
        // RFC 4231 Test Case 2: key="Jefe", data="what do ya want for nothing?"
        let mac = hmac_sha256(b"Jefe", b"what do ya want for nothing?");
        let expected = "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843";
        let hex: String = mac.iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(hex, expected);
    }

    #[test]
    fn hmac_handles_long_keys() {
        // 密钥长于块长（64）必须先哈希，不能 panic
        let long_key = vec![0xabu8; 100];
        let mac = hmac_sha256(&long_key, b"data");
        assert_eq!(mac.len(), 32);
    }

    #[test]
    fn constant_time_eq_compares_correctly() {
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"ab"));
        assert!(constant_time_eq(b"", b""));
    }

    // ── secret 派生 ───────────────────────────────────────────────────────

    #[test]
    fn derive_secret_requires_strong_key() {
        assert!(derive_room_grant_secret("short").is_err());
        let secret = derive_room_grant_secret("a-strong-api-key").unwrap();
        assert_eq!(secret.len(), 32);
    }

    #[test]
    fn derive_secret_is_domain_separated() {
        let a = derive_room_grant_secret("key-number-one").unwrap();
        let b = derive_room_grant_secret("key-number-two").unwrap();
        assert_ne!(a, b);
        // 同一 key 稳定
        assert_eq!(a, derive_room_grant_secret("key-number-one").unwrap());
    }

    // ── 签发与校验往返 ────────────────────────────────────────────────────

    #[test]
    fn issue_and_decode_round_trip() {
        let token = issue_room_grant(&secret(), &request()).unwrap();
        let payload = decode_room_grant(&secret(), &token, "dispatch", 1500.0).unwrap();
        assert_eq!(payload["version"], 2);
        assert_eq!(payload["room_id"], "room-1");
        assert_eq!(payload["member_id"], "m-ada");
        assert_eq!(payload["authority_epoch"], 1);
    }

    #[test]
    fn token_is_dot_separated_base64url() {
        let token = issue_room_grant(&secret(), &request()).unwrap();
        let parts: Vec<&str> = token.split('.').collect();
        assert_eq!(parts.len(), 2);
        // 无 padding
        assert!(!parts[0].ends_with('='));
        assert!(!parts[1].ends_with('='));
        // URL-safe 字符集
        assert!(parts[0]
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'));
    }

    #[test]
    fn rejects_tampered_signature() {
        let token = issue_room_grant(&secret(), &request()).unwrap();
        let (encoded, signature) = token.split_once('.').unwrap();
        // 改签名最后一个字符
        let mut sig = signature.to_owned();
        let last = sig.pop().unwrap();
        sig.push(if last == 'A' { 'B' } else { 'A' });
        let tampered = format!("{encoded}.{sig}");
        assert_eq!(
            decode_room_grant(&secret(), &tampered, "dispatch", 1500.0)
                .unwrap_err()
                .message,
            "room grant signature is invalid"
        );
    }

    #[test]
    fn rejects_tampered_payload() {
        let token = issue_room_grant(&secret(), &request()).unwrap();
        let (encoded, signature) = token.split_once('.').unwrap();
        // 改 payload（重新编码但签名不匹配）
        let mut payload: Value =
            serde_json::from_str(&String::from_utf8(b64_decode(encoded).unwrap()).unwrap()).unwrap();
        payload["room_id"] = Value::String("other-room".into());
        let new_encoded = b64_encode(common::compact_json(&payload, true).as_bytes());
        let tampered = format!("{new_encoded}.{signature}");
        assert_eq!(
            decode_room_grant(&secret(), &tampered, "dispatch", 1500.0)
                .unwrap_err()
                .message,
            "room grant signature is invalid"
        );
    }

    #[test]
    fn rejects_wrong_secret() {
        let token = issue_room_grant(&secret(), &request()).unwrap();
        let wrong = vec![9u8; 32];
        assert!(decode_room_grant(&wrong, &token, "dispatch", 1500.0).is_err());
    }

    // ── 生命周期 ──────────────────────────────────────────────────────────

    #[test]
    fn rejects_ttl_over_dispatch_limit() {
        let mut req = request();
        req.ttl_seconds = MAX_DISPATCH_GRANT_TTL_SECONDS + 1.0;
        assert_eq!(
            issue_room_grant(&secret(), &req).unwrap_err().message,
            "room grant lifetime is invalid"
        );
    }

    #[test]
    fn rejects_non_positive_ttl() {
        for ttl in [0.0, -1.0] {
            let mut req = request();
            req.ttl_seconds = ttl;
            assert!(issue_room_grant(&secret(), &req).is_err());
        }
    }

    #[test]
    fn rejects_status_expiry_beyond_limit() {
        let mut req = request();
        req.status_ttl_seconds = Some(MAX_STATUS_GRANT_TTL_SECONDS + 1.0);
        assert!(issue_room_grant(&secret(), &req).is_err());
    }

    #[test]
    fn rejects_status_expiry_before_dispatch() {
        let mut req = request();
        req.ttl_seconds = 3600.0;
        req.status_ttl_seconds = Some(1800.0); // 比 dispatch 短 → 非法
        assert!(issue_room_grant(&secret(), &req).is_err());
    }

    #[test]
    fn expired_grant_is_rejected() {
        let token = issue_room_grant(&secret(), &request()).unwrap();
        // issued 1000, expires 4600
        let err = decode_room_grant(&secret(), &token, "dispatch", 5000.0).unwrap_err();
        assert_eq!(err.message, "room grant is expired or not active");
    }

    #[test]
    fn clock_skew_within_thirty_seconds_is_tolerated() {
        let token = issue_room_grant(&secret(), &request()).unwrap();
        // issued=1000，now=975（早 25 秒）→ 容差内
        assert!(decode_room_grant(&secret(), &token, "dispatch", 975.0).is_ok());
        // now=965（早 35 秒）→ 超出容差
        assert!(decode_room_grant(&secret(), &token, "dispatch", 965.0).is_err());
    }

    #[test]
    fn status_permissions_outlive_dispatch() {
        let mut req = request();
        req.ttl_seconds = 3600.0;
        req.status_ttl_seconds = Some(86_400.0);
        let token = issue_room_grant(&secret(), &req).unwrap();

        // dispatch 已过期（>4600）
        assert!(decode_room_grant(&secret(), &token, "dispatch", 5000.0).is_err());
        // 但 status 还活着（< 1000+86400）
        assert!(decode_room_grant(&secret(), &token, "status", 5000.0).is_ok());
        assert!(decode_room_grant(&secret(), &token, "approve", 5000.0).is_ok());
        assert!(decode_room_grant(&secret(), &token, "stop", 5000.0).is_ok());
    }

    // ── 权限 ──────────────────────────────────────────────────────────────

    #[test]
    fn rejects_unknown_permission() {
        let mut req = request();
        req.permissions = &["admin"];
        assert_eq!(
            issue_room_grant(&secret(), &req).unwrap_err().message,
            "room grant permissions are invalid"
        );
    }

    #[test]
    fn rejects_empty_permissions() {
        let mut req = request();
        req.permissions = &[];
        assert!(issue_room_grant(&secret(), &req).is_err());
    }

    #[test]
    fn permission_not_granted_is_rejected() {
        let mut req = request();
        req.permissions = &["dispatch"];
        let token = issue_room_grant(&secret(), &req).unwrap();
        assert!(decode_room_grant(&secret(), &token, "dispatch", 1500.0).is_ok());
        assert_eq!(
            decode_room_grant(&secret(), &token, "approve", 1500.0)
                .unwrap_err()
                .message,
            "room grant does not allow this operation"
        );
    }

    #[test]
    fn permissions_are_sorted_and_deduped() {
        let mut req = request();
        req.permissions = &["stop", "approve", "stop"];
        let token = issue_room_grant(&secret(), &req).unwrap();
        let payload = decode_room_grant(&secret(), &token, "stop", 1500.0).unwrap();
        assert_eq!(payload["permissions"], serde_json::json!(["approve", "stop"]));
    }

    // ── secret 长度 ───────────────────────────────────────────────────────

    #[test]
    fn rejects_short_secret() {
        let short = vec![1u8; 31];
        assert_eq!(
            issue_room_grant(&short, &request()).unwrap_err().message,
            "room grant secret must be at least 32 bytes"
        );
    }

    // ── 不验签的读取 ──────────────────────────────────────────────────────

    #[test]
    fn hard_expiry_reads_status_horizon() {
        let mut req = request();
        req.status_ttl_seconds = Some(7200.0);
        let token = issue_room_grant(&secret(), &req).unwrap();
        // issued=1000 + 7200 = 8200
        assert_eq!(room_grant_hard_expiry(&token, 0.0), 8200.0);
    }

    #[test]
    fn hard_expiry_falls_back_for_unreadable_tokens() {
        let expiry = room_grant_hard_expiry("garbage", 500.0);
        assert_eq!(expiry, 500.0 + MAX_STATUS_GRANT_TTL_SECONDS);
    }

    #[test]
    fn matches_scope_compares_all_coordinates() {
        let token = issue_room_grant(&secret(), &request()).unwrap();
        assert!(room_grant_matches_scope(
            &token, "room-1", "m-ada", "home-1", "gw-1", 1
        ));
        // 任一不一致 → false
        assert!(!room_grant_matches_scope(
            &token, "room-2", "m-ada", "home-1", "gw-1", 1
        ));
        assert!(!room_grant_matches_scope(
            &token, "room-1", "m-bob", "home-1", "gw-1", 1
        ));
        assert!(!room_grant_matches_scope(
            &token, "room-1", "m-ada", "home-1", "gw-1", 2
        ));
        // 读不了 → false
        assert!(!room_grant_matches_scope("garbage", "r", "m", "h", "g", 1));
    }

    #[test]
    fn needs_refresh_reads_expires_at() {
        let token = issue_room_grant(&secret(), &request()).unwrap();
        // expires = 1000 + 3600 = 4600
        // now=4000, leeway=300 → 4300 < 4600 → 不需刷新
        assert!(!room_grant_needs_dispatch_refresh(&token, 4000.0, 300.0));
        // now=4400, leeway=300 → 4700 >= 4600 → 需刷新
        assert!(room_grant_needs_dispatch_refresh(&token, 4400.0, 300.0));
        // 负 leeway 归零
        assert!(!room_grant_needs_dispatch_refresh(&token, 4000.0, -100.0));
    }

    // ── URL 校验 ──────────────────────────────────────────────────────────

    #[test]
    fn https_urls_are_tls() {
        let (url, security) = validate_room_link_url("https://gateway.example/room").unwrap();
        assert_eq!(url, "https://gateway.example/room");
        assert_eq!(security, "tls");
    }

    #[test]
    fn plaintext_only_allowed_for_loopback() {
        assert_eq!(
            validate_room_link_url("http://127.0.0.1:8080/x").unwrap().1,
            "plaintext"
        );
        assert_eq!(
            validate_room_link_url("http://localhost:8080/x").unwrap().1,
            "plaintext"
        );
        // 远端明文 → 拒绝（上游语义）
        assert!(validate_room_link_url("http://gateway.example/x").is_err());
    }

    #[test]
    fn rejects_non_http_schemes() {
        for bad in ["ftp://x", "ws://x", "file:///x", "", "   "] {
            assert!(validate_room_link_url(bad).is_err(), "should reject {bad:?}");
        }
    }

    // ── 常量 ──────────────────────────────────────────────────────────────

    #[test]
    fn constants_match_upstream() {
        assert_eq!(PROTOCOL_VERSION, 2);
        assert_eq!(MAX_TOKEN_BYTES, 16 * 1024);
        assert_eq!(MAX_DISPATCH_GRANT_TTL_SECONDS, 86_400.0);
        assert_eq!(MAX_STATUS_GRANT_TTL_SECONDS, 2_592_000.0);
        assert_eq!(GRANT_PERMISSIONS.len(), 4);
        assert_eq!(GRANT_FIELDS.len(), 14);
        assert_eq!(GRANT_SCOPE.len(), 8);
        assert_eq!(LINK_MODES.len(), 5);
    }
}
//! 房间链接存储（hermes `gateway/hosted_room_links.py` 的移植）。
//!
//! 上游自述：
//! > Private SQLite storage for negotiated hosted-room links.
//! > Route metadata and its scoped grant share the gateway's private root `state.db`.
//! > SQLite WAL plus `BEGIN IMMEDIATE` owns concurrency; **grants are never included in
//! > reprs, status payloads, or exception messages.**
//!
//! ## 安全语义（必须保留）
//!
//! **grant 是 bearer token，绝不出现在日志/错误/repr 里。** 上游用
//! `field(repr=False)` 标记；Rust 侧用自定义 `Debug` 实现把 grant 红掉。
//!
//! 这条很重要：一旦 grant 泄露到日志，攻击者就能冒充该成员。
//!
//! ## 状态机
//!
//! `ready` / `unavailable` / `needs_reauthorization` 三态。`needs_reauthorization`
//! 表示 grant 过期或被撤销，需要重新协商。
//!
//! ## 移植边界
//!
//! ✅ 本文件：常量、`StoredRoomLink` 结构（含 grant 红化的 Debug）、
//!   `from_mapping` 校验、`catalog_json` 往返。
//! ⏳ 未移植：SQL 读写（`load_room_links` / `save_room_link` / `mark_room_link_status`）
//!   与 `GatewayRoomCatalog` 的完整字段集（catalog 在 peer 模块里只有骨架）。

use serde_json::{Map, Value};

use super::common;
use super::peer::{self, PeerError};

// ── 常量（上游逐字）────────────────────────────────────────────────────────

pub const MAX_LINKS: i64 = 512;
pub const MAX_GRANT_CHARS: usize = 16 * 1024;

/// 允许的状态。
pub const LINK_STATUSES: &[&str] = &["ready", "unavailable", "needs_reauthorization"];

/// 默认状态（上游 `str(value.get("status") or "ready")`）。
pub const DEFAULT_STATUS: &str = "ready";

/// 必填字段（上游 `_LEGACY_FIELDS`）。
pub const REQUIRED_FIELDS: &[&str] = &[
    "room_id",
    "member_id",
    "target_url",
    "target_profile",
    "grant",
    "catalog",
    "cancellation_scope_id",
    "trace_id",
    "updated_at",
];

/// 可选字段（上游 `_OPTIONAL_FIELDS`）。
pub const OPTIONAL_FIELDS: &[&str] = &["transport_security", "status"];

/// SQLite 记录列（与 mapping 字段 1:1，`catalog_json` 是序列化后的 catalog）。
pub const RECORD_FIELDS: &[&str] = &[
    "room_id",
    "member_id",
    "target_url",
    "target_profile",
    "grant",
    "cancellation_scope_id",
    "trace_id",
    "transport_security",
    "status",
    "updated_at",
];

// ── 数据结构 ────────────────────────────────────────────────────────────────

/// 一条已协商的房间链接。
///
/// **`Debug` 刻意不打印 grant**（上游 `field(repr=False)` 的等价物）——
/// grant 是 bearer token，泄露到日志等于泄露凭据。
#[derive(Clone, PartialEq)]
pub struct StoredRoomLink {
    pub room_id: String,
    pub member_id: String,
    pub target_url: String,
    pub target_profile: String,
    /// **bearer token：不进日志、不进错误、不进 Debug。**
    pub grant: String,
    /// catalog 的原始 JSON（完整 `GatewayRoomCatalog` 结构在 peer 模块）。
    pub catalog: Value,
    pub cancellation_scope_id: String,
    pub trace_id: String,
    /// `"tls"` 或 `"plaintext"`。
    pub transport_security: String,
    pub status: String,
    pub updated_at: f64,
}

impl std::fmt::Debug for StoredRoomLink {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StoredRoomLink")
            .field("room_id", &self.room_id)
            .field("member_id", &self.member_id)
            .field("target_url", &self.target_url)
            .field("target_profile", &self.target_profile)
            // grant 永不打印：只标出长度，便于排查而不泄露
            .field("grant", &format!("<redacted len={}>", self.grant.len()))
            .field("cancellation_scope_id", &self.cancellation_scope_id)
            .field("trace_id", &self.trace_id)
            .field("transport_security", &self.transport_security)
            .field("status", &self.status)
            .field("updated_at", &self.updated_at)
            .finish()
    }
}

impl StoredRoomLink {
    /// 上游 `from_mapping()`：严格校验一条链接。
    ///
    /// 校验顺序与上游一致：
    /// 1. 字段集：必填齐全、可选之外拒绝
    /// 2. `room_id` / `member_id` / `target_profile` 短字符串
    /// 3. `target_url` 过 peer 的 URL 校验，得到 `detected_security`
    /// 4. 显式 `transport_security` 必须等于检测值
    /// 5. grant 非空且 ≤ 16KB
    /// 6. status 在三态内
    /// 7. `updated_at > 0`
    pub fn from_mapping(value: &Value) -> Result<Self, PeerError> {
        let Value::Object(map) = value else {
            return Err(PeerError {
                code: "peer",
                message: "stored room link fields are invalid".into(),
            });
        };

        // 字段集校验（上游文案统一）
        let invalid_fields = || PeerError {
            code: "peer",
            message: "stored room link fields are invalid".into(),
        };
        for key in REQUIRED_FIELDS {
            if !map.contains_key(*key) {
                return Err(invalid_fields());
            }
        }
        for key in map.keys() {
            if !REQUIRED_FIELDS.contains(&key.as_str()) && !OPTIONAL_FIELDS.contains(&key.as_str()) {
                return Err(invalid_fields());
            }
        }

        let room_id = short_string(map.get("room_id"), "room_id")?;
        let member_id = short_string(map.get("member_id"), "member_id")?;
        let target_profile = short_string(map.get("target_profile"), "target_profile")?;

        let Some(target_url_raw) = map.get("target_url").and_then(Value::as_str) else {
            return Err(PeerError {
                code: "peer",
                message: "target_url is invalid".into(),
            });
        };
        let (target_url, detected_security) = peer::validate_room_link_url(target_url_raw)?;

        // 显式 security 必须等于检测值
        let transport_security = match map.get("transport_security") {
            None | Some(Value::Null) => detected_security.to_owned(),
            Some(Value::String(s)) if s.is_empty() => detected_security.to_owned(),
            Some(Value::String(s)) => s.clone(),
            Some(_) => {
                return Err(PeerError {
                    code: "peer",
                    message: "transport_security does not match target_url".into(),
                })
            }
        };
        if transport_security != detected_security {
            return Err(PeerError {
                code: "peer",
                message: "transport_security does not match target_url".into(),
            });
        }

        // grant：非空且 ≤ 16KB
        let grant = match map.get("grant") {
            Some(Value::String(s)) => s.clone(),
            Some(Value::Null) | None => String::new(),
            Some(other) => other.to_string(),
        };
        if grant.is_empty() || grant.len() > MAX_GRANT_CHARS {
            return Err(PeerError {
                code: "peer",
                message: "room grant is missing or too large".into(),
            });
        }

        // status 三态
        let status = match map.get("status") {
            None | Some(Value::Null) => DEFAULT_STATUS.to_owned(),
            Some(Value::String(s)) if s.is_empty() => DEFAULT_STATUS.to_owned(),
            Some(Value::String(s)) => s.clone(),
            Some(other) => other.to_string(),
        };
        if !LINK_STATUSES.contains(&status.as_str()) {
            return Err(PeerError {
                code: "peer",
                message: "stored room link status is invalid".into(),
            });
        }

        // updated_at > 0
        let Some(updated_at) = map.get("updated_at").and_then(Value::as_f64) else {
            return Err(PeerError {
                code: "peer",
                message: "updated_at must be positive".into(),
            });
        };
        if !(updated_at > 0.0) {
            return Err(PeerError {
                code: "peer",
                message: "updated_at must be positive".into(),
            });
        }

        let Some(catalog) = map.get("catalog") else {
            return Err(PeerError {
                code: "peer",
                message: "stored room link fields are invalid".into(),
            });
        };

        Ok(Self {
            room_id,
            member_id,
            target_url,
            target_profile,
            grant,
            catalog: catalog.clone(),
            cancellation_scope_id: short_string(map.get("cancellation_scope_id"), "cancellation_scope_id")?,
            trace_id: short_string(map.get("trace_id"), "trace_id")?,
            transport_security,
            status,
            updated_at,
        })
    }

    /// 上游 `from_record()`：从 SQLite 行还原（catalog 在 `catalog_json` 列）。
    pub fn from_record(value: &Value) -> Result<Self, PeerError> {
        let Value::Object(map) = value else {
            return Err(PeerError {
                code: "peer",
                message: "stored room link fields are invalid".into(),
            });
        };

        let Some(catalog_json) = map.get("catalog_json").and_then(Value::as_str) else {
            return Err(PeerError {
                code: "peer",
                message: "stored room link catalog is unreadable".into(),
            });
        };
        let catalog: Value = serde_json::from_str(catalog_json).map_err(|_| PeerError {
            code: "peer",
            message: "stored room link catalog is unreadable".into(),
        })?;

        // 拼回 mapping 形状
        let mut assembled = Map::new();
        for field in RECORD_FIELDS {
            if let Some(value) = map.get(*field) {
                assembled.insert((*field).to_owned(), value.clone());
            }
        }
        assembled.insert("catalog".into(), catalog);
        Self::from_mapping(&Value::Object(assembled))
    }

    /// 上游 `as_record()`：转成 SQLite 行（catalog 序列化进 `catalog_json`）。
    ///
    /// 注意 `catalog_json` 用 **ensure_ascii=false**（上游 `compact_json(..., ensure_ascii=False)`）。
    pub fn as_record(&self) -> Value {
        let mut map = Map::new();
        map.insert("room_id".into(), Value::String(self.room_id.clone()));
        map.insert("member_id".into(), Value::String(self.member_id.clone()));
        map.insert("target_url".into(), Value::String(self.target_url.clone()));
        map.insert(
            "target_profile".into(),
            Value::String(self.target_profile.clone()),
        );
        map.insert("grant".into(), Value::String(self.grant.clone()));
        map.insert(
            "cancellation_scope_id".into(),
            Value::String(self.cancellation_scope_id.clone()),
        );
        map.insert("trace_id".into(), Value::String(self.trace_id.clone()));
        map.insert(
            "transport_security".into(),
            Value::String(self.transport_security.clone()),
        );
        map.insert("status".into(), Value::String(self.status.clone()));
        map.insert("updated_at".into(), Value::from(self.updated_at));
        map.insert(
            "catalog_json".into(),
            Value::String(common::compact_json(&self.catalog, false)),
        );
        Value::Object(map)
    }

    /// 该链接的 grant 是否已到硬过期（供续期排期用）。
    pub fn grant_hard_expiry(&self, now: f64) -> f64 {
        peer::room_grant_hard_expiry(&self.grant, now)
    }

    /// 状态是否可用（`ready` 才是活的）。
    pub fn is_ready(&self) -> bool {
        self.status == "ready"
    }
}

/// 上游 `_short_string()`：非空有界字符串。
fn short_string(value: Option<&Value>, field: &str) -> Result<String, PeerError> {
    let Some(s) = value.and_then(Value::as_str) else {
        return Err(PeerError {
            code: "peer",
            message: format!("{field} is invalid"),
        });
    };
    let trimmed = s.trim();
    if trimmed.is_empty() || trimmed.chars().count() > peer::MAX_IDENTIFIER_CHARS {
        return Err(PeerError {
            code: "peer",
            message: format!("{field} is invalid"),
        });
    }
    Ok(trimmed.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn valid_mapping() -> Value {
        json!({
            "room_id": "room-1",
            "member_id": "m-ada",
            "target_url": "https://gateway.example/room",
            "target_profile": "alice",
            "grant": "payload.signature",
            "catalog": {"protocol_versions": [2]},
            "cancellation_scope_id": "scope-1",
            "trace_id": "trace-1",
            "updated_at": 1000.0,
        })
    }

    // ── 校验 ──────────────────────────────────────────────────────────────

    #[test]
    fn accepts_valid_mapping_with_defaults() {
        let link = StoredRoomLink::from_mapping(&valid_mapping()).unwrap();
        assert_eq!(link.room_id, "room-1");
        assert_eq!(link.status, "ready");
        assert_eq!(link.transport_security, "tls");
        assert!(link.is_ready());
    }

    #[test]
    fn rejects_missing_required_fields() {
        for field in REQUIRED_FIELDS {
            let mut value = valid_mapping();
            value.as_object_mut().unwrap().remove(*field);
            let err = StoredRoomLink::from_mapping(&value).unwrap_err();
            assert_eq!(
                err.message, "stored room link fields are invalid",
                "missing {field} should be rejected"
            );
        }
    }

    #[test]
    fn rejects_unknown_fields() {
        let mut value = valid_mapping();
        value["bogus"] = json!(1);
        assert_eq!(
            StoredRoomLink::from_mapping(&value).unwrap_err().message,
            "stored room link fields are invalid"
        );
    }

    #[test]
    fn rejects_security_mismatch() {
        let mut value = valid_mapping();
        // target_url 是 https → 检测 tls；显式写 plaintext → 冲突
        value["transport_security"] = json!("plaintext");
        assert_eq!(
            StoredRoomLink::from_mapping(&value).unwrap_err().message,
            "transport_security does not match target_url"
        );
    }

    #[test]
    fn accepts_matching_security() {
        let mut value = valid_mapping();
        value["transport_security"] = json!("tls");
        assert!(StoredRoomLink::from_mapping(&value).is_ok());
    }

    #[test]
    fn loopback_http_is_plaintext() {
        let mut value = valid_mapping();
        value["target_url"] = json!("http://127.0.0.1:9000/room");
        let link = StoredRoomLink::from_mapping(&value).unwrap();
        assert_eq!(link.transport_security, "plaintext");
    }

    #[test]
    fn rejects_empty_or_oversized_grant() {
        let mut value = valid_mapping();
        value["grant"] = json!("");
        assert_eq!(
            StoredRoomLink::from_mapping(&value).unwrap_err().message,
            "room grant is missing or too large"
        );

        let mut value = valid_mapping();
        value["grant"] = json!("x".repeat(MAX_GRANT_CHARS + 1));
        assert_eq!(
            StoredRoomLink::from_mapping(&value).unwrap_err().message,
            "room grant is missing or too large"
        );
    }

    #[test]
    fn rejects_invalid_status() {
        let mut value = valid_mapping();
        value["status"] = json!("exploded");
        assert_eq!(
            StoredRoomLink::from_mapping(&value).unwrap_err().message,
            "stored room link status is invalid"
        );
    }

    #[test]
    fn accepts_all_three_statuses() {
        for status in LINK_STATUSES {
            let mut value = valid_mapping();
            value["status"] = json!(status);
            assert!(StoredRoomLink::from_mapping(&value).is_ok());
        }
    }

    #[test]
    fn rejects_non_positive_updated_at() {
        for bad in [0.0, -1.0] {
            let mut value = valid_mapping();
            value["updated_at"] = json!(bad);
            assert_eq!(
                StoredRoomLink::from_mapping(&value).unwrap_err().message,
                "updated_at must be positive"
            );
        }
    }

    // ── grant 红化（安全关键）─────────────────────────────────────────────

    #[test]
    fn debug_redacts_grant() {
        let mut value = valid_mapping();
        value["grant"] = json!("super-secret-bearer-token");
        let link = StoredRoomLink::from_mapping(&value).unwrap();
        let rendered = format!("{link:?}");
        // grant 原文绝不能出现在 Debug 里
        assert!(!rendered.contains("super-secret-bearer-token"));
        assert!(rendered.contains("<redacted len="));
        // 其他字段正常显示
        assert!(rendered.contains("room-1"));
    }

    // ── 记录往返 ──────────────────────────────────────────────────────────

    #[test]
    fn record_round_trips() {
        let link = StoredRoomLink::from_mapping(&valid_mapping()).unwrap();
        let record = link.as_record();

        // 记录里有 catalog_json 而不是 catalog
        assert!(record.get("catalog_json").is_some());
        assert!(record.get("catalog").is_none());
        assert_eq!(record["grant"], "payload.signature");

        let restored = StoredRoomLink::from_record(&record).unwrap();
        assert_eq!(restored, link);
    }

    #[test]
    fn record_catalog_json_is_not_escaped() {
        // 上游 ensure_ascii=False：非 ASCII 保留原文
        let mut value = valid_mapping();
        value["catalog"] = json!({"name": "房间"});
        let link = StoredRoomLink::from_mapping(&value).unwrap();
        let record = link.as_record();
        let catalog_json = record["catalog_json"].as_str().unwrap();
        assert!(catalog_json.contains("房间"));
        assert!(!catalog_json.contains("\\u"));
    }

    #[test]
    fn from_record_rejects_unreadable_catalog() {
        let link = StoredRoomLink::from_mapping(&valid_mapping()).unwrap();
        let mut record = link.as_record();
        record["catalog_json"] = json!("not json");
        assert_eq!(
            StoredRoomLink::from_record(&record).unwrap_err().message,
            "stored room link catalog is unreadable"
        );
    }

    #[test]
    fn from_record_requires_catalog_json() {
        let link = StoredRoomLink::from_mapping(&valid_mapping()).unwrap();
        let mut record = link.as_record();
        record.as_object_mut().unwrap().remove("catalog_json");
        assert!(StoredRoomLink::from_record(&record).is_err());
    }

    // ── 工具 ──────────────────────────────────────────────────────────────

    #[test]
    fn is_ready_only_for_ready_status() {
        for (status, expected) in [
            ("ready", true),
            ("unavailable", false),
            ("needs_reauthorization", false),
        ] {
            let mut value = valid_mapping();
            value["status"] = json!(status);
            let link = StoredRoomLink::from_mapping(&value).unwrap();
            assert_eq!(link.is_ready(), expected, "status {status}");
        }
    }

    #[test]
    fn short_string_trims_and_bounds() {
        let mut value = valid_mapping();
        value["room_id"] = json!("  room-1  ");
        let link = StoredRoomLink::from_mapping(&value).unwrap();
        assert_eq!(link.room_id, "room-1");

        let mut value = valid_mapping();
        value["room_id"] = json!("   ");
        assert!(StoredRoomLink::from_mapping(&value).is_err());
    }

    #[test]
    fn constants_match_upstream() {
        assert_eq!(MAX_LINKS, 512);
        assert_eq!(MAX_GRANT_CHARS, 16 * 1024);
        assert_eq!(LINK_STATUSES.len(), 3);
        assert_eq!(REQUIRED_FIELDS.len(), 9);
        assert_eq!(OPTIONAL_FIELDS.len(), 2);
        assert_eq!(RECORD_FIELDS.len(), 10);
    }
}
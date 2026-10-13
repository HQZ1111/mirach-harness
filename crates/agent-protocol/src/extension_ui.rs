//! ExtensionUi 请求/应答（§9：protocolVersion 随往返校验）。
//!
//! serde 形状（camelCase，与 L1 TypeScript mirror 对齐）：
//! ```json
//! {
//!   "id": "req-1",
//!   "method": "confirm",
//!   "payload": {},
//!   "protocolVersion": 1
//! }
//! ```

use serde::{Deserialize, Serialize};

/// 当前协议版本（前端/后端同步升级；protocolVersion 不匹配 = 显式错误）。
pub const PROTOCOL_VERSION: u32 = 1;

/// ExtensionUi 请求（host → UI surface）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionUiRequest {
    /// 请求 id（应答必须携带同一 id）。
    pub id: String,
    /// 固定枚举：confirm/select/input/editor/notify（pi 上游语义）。
    pub method: String,
    /// 方法特定的参数（confirm: { message }, select: { options }, …）。
    pub payload: serde_json::Value,
    /// 协议版本（前后端漂移 = 显式错误）。
    pub protocol_version: u32,
}

/// ExtensionUi 应答（UI surface → host）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionUiResponse {
    /// 对应请求的 id。
    pub id: String,
    /// 用户选择/输入的值（cancelled 时通常为 None）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<serde_json::Value>,
    /// 用户取消（vs 确认）。
    pub cancelled: bool,
    /// 协议版本（必须与请求一致，否则 ApprovalRegistry 拒绝）。
    pub protocol_version: u32,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_roundtrip() {
        let req = ExtensionUiRequest {
            id: "req-1".to_string(),
            method: "confirm".to_string(),
            payload: serde_json::json!({"message": "确定？"}),
            protocol_version: PROTOCOL_VERSION,
        };
        let json = serde_json::to_value(&req).unwrap();
        assert_eq!(json["id"], "req-1");
        assert_eq!(json["method"], "confirm");
        assert_eq!(json["protocolVersion"], 1);
        let back: ExtensionUiRequest = serde_json::from_value(json).unwrap();
        assert_eq!(req, back);
    }

    #[test]
    fn response_roundtrip_with_value() {
        let resp = ExtensionUiResponse {
            id: "req-1".to_string(),
            value: Some(serde_json::json!({"ok": true})),
            cancelled: false,
            protocol_version: PROTOCOL_VERSION,
        };
        let json = serde_json::to_value(&resp).unwrap();
        assert_eq!(json["value"]["ok"], true);
        assert_eq!(json["cancelled"], false);
        let back: ExtensionUiResponse = serde_json::from_value(json).unwrap();
        assert_eq!(resp, back);
    }

    #[test]
    fn response_cancelled_omits_value() {
        let resp = ExtensionUiResponse {
            id: "req-1".to_string(),
            value: None,
            cancelled: true,
            protocol_version: PROTOCOL_VERSION,
        };
        let json = serde_json::to_value(&resp).unwrap();
        assert!(json.get("value").is_none());
        assert_eq!(json["cancelled"], true);
        let back: ExtensionUiResponse = serde_json::from_value(json).unwrap();
        assert_eq!(resp, back);
    }

    #[test]
    fn protocol_version_mismatch_detected() {
        let resp = ExtensionUiResponse {
            id: "r1".to_string(),
            value: None,
            cancelled: true,
            protocol_version: 999,
        };
        assert_ne!(resp.protocol_version, PROTOCOL_VERSION);
    }
}
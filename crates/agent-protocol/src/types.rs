//! 基础标量类型（Rust serde 序列化为裸字符串/数字，无 newtype 包装）。

use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// 运行（轮次）唯一标识（格式：`run-{timestamp_millis}`，与 agui.rs 生成逻辑对齐）。
///
/// 前端 mirror 类型：`RunId = string`。
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct RunId(String);

impl RunId {
    /// 从字符串构造（允许解析前端生成的 runId）。
    pub fn new(s: String) -> Self {
        Self(s)
    }

    /// 从 Unix 时间戳毫秒生成（与 agui.rs run_id 生成逻辑一致）。
    pub fn from_now() -> Self {
        let millis = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system clock before Unix epoch")
            .as_millis();
        Self(format!("run-{}", millis))
    }

    /// 获取裸字符串（供内部使用，如日志/调试）。
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// 工具调用唯一标识（与 pi::sdk::AgentEvent::ToolCallStart 的 tool_call_id 一致）。
///
/// 前端 mirror 类型：`ToolCallId = string`。
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ToolCallId(String);

impl ToolCallId {
    /// 从字符串构造。
    pub fn new(s: String) -> Self {
        Self(s)
    }

    /// 生成随机 UUID（前端/后端都用，保持一致性）。
    pub fn generate() -> Self {
        Self(Uuid::new_v4().to_string())
    }

    /// 获取裸字符串。
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// 事件序号（per-run 单调递增，从 1 起）。
///
/// 前端 mirror 类型：`Seq = number`。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct Seq(u64);

impl Seq {
    /// 新建序号（从 1 起步，避免 0 导致 JSON 序列化丢失）。
    pub fn new() -> Self {
        Self(1)
    }

    /// 自增（返回新序号）。
    pub fn increment(self) -> Self {
        Self(self.0 + 1)
    }

    /// 获取裸值（供 Rust 内部使用）。
    pub fn as_u64(self) -> u64 {
        self.0
    }

    /// 从原始 u64 创建（主要用于测试/反序列化场景；正常流用
    /// `Seq::new()` + `increment()` 链，§9 铁律 2 保证从 1 起）。
    pub fn from_raw(v: u64) -> Self {
        Self(v)
    }
}

impl Default for Seq {
    fn default() -> Self {
        Self::new()
    }
}

/// 平台能力标志——移动端差异在协议层表达（§9 铁律 4）。
///
/// 前端 mirror 类型：`CapabilityFlags { replayable: boolean; maxSnapshotsPerSession: number | null }`。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityFlags {
    /// 桌面 ChannelSink：EventSink+SnapshotSource+Replayable 全 impl；
    /// 移动端 MobileSink 不 impl Replayable（类型约束）。
    pub replayable: bool,
    /// 快照缓存上限（桌面 None=无上限；移动端 Some(3)）。
    pub max_snapshots_per_session: Option<u32>,
}

impl CapabilityFlags {
    /// 桌面端：全能力。
    pub fn desktop() -> Self {
        Self {
            replayable: true,
            max_snapshots_per_session: None,
        }
    }

    /// 移动端：无重放、每会话 ≤3 快照。
    pub fn mobile() -> Self {
        Self {
            replayable: false,
            max_snapshots_per_session: Some(3),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn run_id_from_now() {
        let rid = RunId::from_now();
        assert!(rid.as_str().starts_with("run-"));
        assert!(rid.as_str().len() > 5);
    }

    #[test]
    fn run_id_roundtrip() {
        let original = RunId::new("run-123456".to_string());
        let json = serde_json::to_string(&original).unwrap();
        let deserialized: RunId = serde_json::from_str(&json).unwrap();
        assert_eq!(original, deserialized);
    }

    #[test]
    fn tool_call_id_generate() {
        let id = ToolCallId::generate();
        assert!(id.as_str().contains('-'));
        assert_eq!(id.as_str().len(), 36); // UUID v4 格式
    }

    #[test]
    fn tool_call_id_roundtrip() {
        let original = ToolCallId::new("tc_123".to_string());
        let json = serde_json::to_string(&original).unwrap();
        let deserialized: ToolCallId = serde_json::from_str(&json).unwrap();
        assert_eq!(original, deserialized);
    }

    #[test]
    fn seq_from_one() {
        let s = Seq::new();
        assert_eq!(s.as_u64(), 1);
    }

    #[test]
    fn seq_increment() {
        let s1 = Seq::new();
        let s2 = s1.increment();
        assert_eq!(s1.as_u64(), 1);
        assert_eq!(s2.as_u64(), 2);
    }

    #[test]
    fn seq_roundtrip() {
        let original = Seq::new();
        let json = serde_json::to_string(&original).unwrap();
        let deserialized: Seq = serde_json::from_str(&json).unwrap();
        assert_eq!(original, deserialized);
    }

    #[test]
    fn capability_flags_desktop_roundtrip() {
        let flags = CapabilityFlags::desktop();
        let json = serde_json::to_value(&flags).unwrap();
        assert_eq!(json["replayable"], true);
        // 桌面无上限 → 显式 null（对应 TS `number | null`，不是缺字段）
        assert!(json["maxSnapshotsPerSession"].is_null());
        let back: CapabilityFlags = serde_json::from_value(json).unwrap();
        assert_eq!(flags, back);
    }

    #[test]
    fn capability_flags_mobile_roundtrip() {
        let flags = CapabilityFlags::mobile();
        let json = serde_json::to_value(&flags).unwrap();
        assert_eq!(json["replayable"], false);
        assert_eq!(json["maxSnapshotsPerSession"], 3);
        let back: CapabilityFlags = serde_json::from_value(json).unwrap();
        assert_eq!(flags, back);
    }
}

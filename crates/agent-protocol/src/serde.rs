//! 序列化辅助（§9 铁律 5：serde 序列化形状 = L1 TypeScript 镜像类型的唯一依据）。
//!
//! 本模块提供手写 serde 实现所需的自定义属性与辅助宏，
//! 以及一个测试工具：验证序列化的 JSON 键名与预期一致。

/// 断言一个类型可以 JSON 往返（用于编译期检查 serde 实现完整性）。
///
/// ```rust
/// use agent_protocol::{AgentEvent, AgentEventKind, RunId, Seq};
/// use agent_protocol::serde_util::assert_json_roundtrip;
///
/// let ev = AgentEvent {
///     run_id: RunId::new("run-1".into()),
///     seq: Seq::new(),
///     kind: AgentEventKind::RunAborted,
/// };
/// assert_json_roundtrip(&ev);
/// ```
#[cfg(test)]
pub fn assert_json_roundtrip<T>(value: &T)
where
    T: ::serde::Serialize + ::serde::de::DeserializeOwned + PartialEq + std::fmt::Debug,
{
    let json = serde_json::to_string(value).unwrap();
    let back: T = serde_json::from_str(&json).unwrap();
    assert_eq!(*value, back, "roundtrip failed for {json}");
}

#[cfg(test)]
mod tests {
    use crate::event::{AgentEvent, AgentEventKind, TurnUsage};
    use crate::extension_ui::{ExtensionUiRequest, ExtensionUiResponse};
    use crate::resume::ResumeOutcome;
    use crate::types::{CapabilityFlags, RunId, Seq, ToolCallId};

    use super::assert_json_roundtrip;

    #[test]
    fn assert_util_works() {
        let ev = AgentEvent {
            run_id: RunId::new("run-1".into()),
            seq: Seq::new(),
            kind: AgentEventKind::RunAborted,
        };
        assert_json_roundtrip(&ev);
        assert_json_roundtrip(&CapabilityFlags::desktop());
        assert_json_roundtrip(&ResumeOutcome::RunGone);
        assert_json_roundtrip(&ToolCallId::new("t1".into()));
    }

    #[test]
    fn deep_nested_roundtrip() {
        let ev = AgentEvent {
            run_id: RunId::from_now(),
            seq: Seq::new().increment().increment(),
            kind: AgentEventKind::ToolOutput {
                tool_call_id: ToolCallId::generate(),
                delta: "{\"path\":\"G:/x\"}".into(),
            },
        };
        assert_json_roundtrip(&ev);
    }

    #[test]
    fn usage_and_extension_ui_roundtrip() {
        assert_json_roundtrip(&TurnUsage::default());
        assert_json_roundtrip(&ExtensionUiRequest {
            id: "r".into(),
            method: "confirm".into(),
            payload: serde_json::Value::Null,
            protocol_version: 1,
        });
        assert_json_roundtrip(&ExtensionUiResponse {
            id: "r".into(),
            value: None,
            cancelled: true,
            protocol_version: 1,
        });
    }
}
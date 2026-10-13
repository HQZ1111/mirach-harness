//! AgentEvent — Agent 引擎逐事件推给前端的唯一数据面（§9 铁律）。
//!
//! 类型系统强制：
//! - `AssistantOutput { delta }` 无 `tool_call_id`——编译期保证不会张冠李戴
//! - `ToolOutput { tool_call_id, delta }` 必有 `tool_call_id` ⭐——编译期强制
//!
//! serde 形状（camelCase，与 L1 TypeScript mirror 对齐）：
//! ```json
//! { "runId": "run-123", "seq": 1, "kind": { "type": "assistant_output", "delta": "hi" } }
//! ```

use serde::{Deserialize, Serialize};

use crate::types::{RunId, Seq, ToolCallId};

/// 用量快照（`RUN_FINISHED` 附带；与 L1 `TurnUsage` 形状对齐）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TurnUsage {
    /// 输入 token 数（pi Usage.input）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_tokens: Option<u64>,
    /// 输出 token 数（pi Usage.output）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_tokens: Option<u64>,
    /// 缓存命中读取 token 数（pi Usage.cache_read）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cached_input_tokens: Option<u64>,
    /// 缓存写入 token 数（pi Usage.cache_write）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_write_tokens: Option<u64>,
    /// 总 token 数（pi Usage.total_tokens）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_tokens: Option<u64>,
    /// 本 run 总花费（美元；多次工具迭代 Σ assistant.usage.cost.total）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cost_usd: Option<f64>,
}

/// 事件种类判别联合——序列化后带 `type` 判别字段（snake_case）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum AgentEventKind {
    // ── 数据面 ────────────────────────────────────────────────────────────
    /// 模型文本输出（无 tool_call_id ⭐——类型系统强制）。
    #[serde(rename_all = "camelCase")]
    AssistantOutput {
        /// 增量文本片段。
        delta: String,
    },

    /// 工具流式输出（必有 tool_call_id ⭐——编译期强制）。
    #[serde(rename_all = "camelCase")]
    ToolOutput {
        /// 工具调用 id（pi ToolCall.id）——缺失即编译错误。
        tool_call_id: ToolCallId,
        /// 增量输出片段。
        delta: String,
    },

    // ── run 生命周期控制帧 ─────────────────────────────────────────────────
    /// run 开始（source: user | delegate）。
    #[serde(rename_all = "camelCase")]
    RunStarted {
        /// 触发来源：`user`（用户提交）或 `delegate`（AgentDelegate 队列）。
        source: Option<String>,
    },

    /// run 正常完成（usage 可选）。
    #[serde(rename_all = "camelCase")]
    RunFinished {
        /// 本 run 用量快照；None = 引擎未上报用量。
        usage: Option<TurnUsage>,
    },

    /// run 被中止（用户 interrupt）。
    RunAborted,

    /// run 出错（message 必带）。
    #[serde(rename_all = "camelCase")]
    RunError {
        /// 错误信息（pi AgentEnd.error 的投影）。
        message: String,
    },

    // ── 恢复/结束控制帧 ───────────────────────────────────────────────────
    /// 快照恢复完成（Rust 侧 SnapshotSource 命中或从 JSONL 重建）。
    SnapshotRestored,

    /// run 结束确认（L1 清理 Store 后显式 ack，Rust 据此释放 Channel）。
    RunEndedAck,

    /// run 已不存在（跨进程重启/会话切换/游标过旧）。
    RunGone,
}

/// Agent 事件（唯一数据面）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEvent {
    /// 本事件所属的 run（truth 在 Rust 的 Channel 句柄表）。
    pub run_id: RunId,
    /// per-run 单调序号（从 1 起）。
    pub seq: Seq,
    /// 事件种类。
    pub kind: AgentEventKind,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn assistant_output_no_tool_call_id() {
        let ev = AgentEvent {
            run_id: RunId::new("run-1".to_string()),
            seq: Seq::new(),
            kind: AgentEventKind::AssistantOutput {
                delta: "hello".to_string(),
            },
        };
        let json = serde_json::to_value(&ev).unwrap();
        assert_eq!(json["kind"]["type"], "assistant_output");
        assert_eq!(json["kind"]["delta"], "hello");
        assert!(json["kind"].get("toolCallId").is_none());
    }

    #[test]
    fn tool_output_requires_tool_call_id() {
        let ev = AgentEvent {
            run_id: RunId::new("run-1".to_string()),
            seq: Seq::new(),
            kind: AgentEventKind::ToolOutput {
                tool_call_id: ToolCallId::new("tc_1".to_string()),
                delta: "partial".to_string(),
            },
        };
        let json = serde_json::to_value(&ev).unwrap();
        assert_eq!(json["kind"]["type"], "tool_output");
        assert_eq!(json["kind"]["toolCallId"], "tc_1");
        assert_eq!(json["kind"]["delta"], "partial");
    }

    #[test]
    fn roundtrip_assistant_output() {
        let ev = AgentEvent {
            run_id: RunId::new("run-42".to_string()),
            seq: Seq::new(),
            kind: AgentEventKind::AssistantOutput {
                delta: "world".to_string(),
            },
        };
        let json = serde_json::to_string(&ev).unwrap();
        let back: AgentEvent = serde_json::from_str(&json).unwrap();
        assert_eq!(ev, back);
    }

    #[test]
    fn roundtrip_run_finished_with_usage() {
        let ev = AgentEvent {
            run_id: RunId::new("run-1".to_string()),
            seq: Seq::new(),
            kind: AgentEventKind::RunFinished {
                usage: Some(TurnUsage {
                    input_tokens: Some(10),
                    output_tokens: Some(5),
                    total_tokens: Some(15),
                    cost_usd: Some(0.001),
                    ..Default::default()
                }),
            },
        };
        let json = serde_json::to_value(&ev).unwrap();
        assert_eq!(json["kind"]["type"], "run_finished");
        assert_eq!(json["kind"]["usage"]["inputTokens"], 10);
        assert_eq!(json["kind"]["usage"]["costUsd"], 0.001);
        let back: AgentEvent = serde_json::from_value(json).unwrap();
        assert_eq!(ev, back);
    }

    #[test]
    fn all_variants_have_snake_case_tags() {
        let variants = vec![
            AgentEventKind::AssistantOutput {
                delta: "x".into(),
            },
            AgentEventKind::ToolOutput {
                tool_call_id: ToolCallId::new("t".into()),
                delta: "x".into(),
            },
            AgentEventKind::RunStarted {
                source: Some("user".into()),
            },
            AgentEventKind::RunFinished { usage: None },
            AgentEventKind::RunAborted,
            AgentEventKind::RunError {
                message: "boom".into(),
            },
            AgentEventKind::SnapshotRestored,
            AgentEventKind::RunEndedAck,
            AgentEventKind::RunGone,
        ];
        for v in variants {
            let json = serde_json::to_value(v).unwrap();
            assert!(json["type"].is_string());
        }
    }

    #[test]
    fn roundtrip_control_frames() {
        for v in [
            AgentEventKind::RunAborted,
            AgentEventKind::SnapshotRestored,
            AgentEventKind::RunEndedAck,
            AgentEventKind::RunGone,
        ] {
            let ev = AgentEvent {
                run_id: RunId::new("run-1".into()),
                seq: Seq::new(),
                kind: v.clone(),
            };
            let json = serde_json::to_string(&ev).unwrap();
            let back: AgentEvent = serde_json::from_str(&json).unwrap();
            assert_eq!(ev.kind, back.kind);
        }
    }
}
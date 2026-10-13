//! agent-protocol 集成测试（§14 N1 验证面）：seq / tool_call_id / serde 往返。
//!
//! 本文件从**外部**消费 crate（只用公开 API），因此同时充当"导出面是否够用"
//! 的验收：协议层被 L3（Rust）与 L1（TS mirror）两端消费，缺一个 pub 就红。
//!
//! 形状锁（§9 铁律 5）：下列断言逐字钉死 JSON 形状——与
//! `src/lib/agent-protocol.ts` + `src/lib/agent-protocol.test.ts` 互为锁，
//! 任一侧改字段名/判别 tag，此处即失配（改协议必须同时改两侧）。

#![allow(missing_docs)] // 测试文件无公开文档面

use agent_protocol::{
    AgentEvent, AgentEventKind, CapabilityFlags, ExtensionUiRequest, ExtensionUiResponse,
    ResumeOutcome, RunId, Seq, ToolCallId, TurnUsage, PROTOCOL_VERSION,
};

// 样本助手

fn run_id() -> RunId {
    RunId::new("run-1".to_string())
}

fn event(seq: u64, kind: AgentEventKind) -> AgentEvent {
    AgentEvent {
        run_id: run_id(),
        seq: Seq::from_raw(seq),
        kind,
    }
}

// seq：从 1 起、单调、往返不丢

#[test]
fn seq_starts_at_one_and_increments_monotonically() {
    let mut seq = Seq::new();
    assert_eq!(seq.as_u64(), 1, "seq 从 1 起（铁律 2）");
    for expected in 2..=10 {
        seq = seq.increment();
        assert_eq!(seq.as_u64(), expected);
    }
}

#[test]
fn seq_serializes_as_bare_number_not_object() {
    // 前端 mirror 类型 `Seq = number`——必须序列化为裸数字（transparent/newtype）
    let json = serde_json::to_value(Seq::from_raw(7)).unwrap();
    assert!(json.is_number(), "Seq 必须是裸数字，得到 {json}");
    assert_eq!(json, serde_json::json!(7));
}

#[test]
fn seq_roundtrip_preserves_every_value_including_boundaries() {
    for raw in [1_u64, 2, 42, u32::MAX as u64, u64::MAX - 1, u64::MAX] {
        let original = Seq::from_raw(raw);
        let json = serde_json::to_string(&original).unwrap();
        let back: Seq = serde_json::from_str(&json).unwrap();
        assert_eq!(original, back, "seq={raw} 往返丢值");
        assert_eq!(back.as_u64(), raw);
    }
}

#[test]
fn seq_ordering_is_total_and_matches_numeric_order() {
    let a = Seq::from_raw(1);
    let b = Seq::from_raw(2);
    let c = Seq::from_raw(10);
    assert!(a < b && b < c);
    assert_eq!([c, a, b].iter().copied().min(), Some(a));
    assert_eq!([c, a, b].iter().copied().max(), Some(c));
}

#[test]
fn event_seq_keeps_position_in_wire_object() {
    // seq 是事件流的排序依据（§8 唯一真相源表：传输序的权威 = seq）
    let json = serde_json::to_value(event(
        1,
        AgentEventKind::AssistantOutput {
            delta: "x".to_string(),
        },
    ))
    .unwrap();
    assert_eq!(json["seq"], 1);
    assert!(json["seq"].is_number());
}

// tool_call_id：类型系统强制

#[test]
fn assistant_output_has_no_tool_call_id_field() {
    // 反向保证：AssistantOutput 序列化后不得出现 toolCallId 键
    let json = serde_json::to_value(AgentEventKind::AssistantOutput {
        delta: "你好".to_string(),
    })
    .unwrap();
    assert_eq!(json["type"], "assistant_output");
    assert_eq!(json["delta"], "你好");
    assert!(
        json.get("toolCallId").is_none() && json.get("tool_call_id").is_none(),
        "AssistantOutput 不得携带 tool_call_id：{json}"
    );
    // 形状 = {type, delta} 恰两个键
    assert_eq!(json.as_object().unwrap().len(), 2);
}

#[test]
fn tool_output_always_carries_tool_call_id() {
    // 正向保证：ToolOutput 的 wire 形状必带 toolCallId
    let tool_call_id = ToolCallId::new("tc_abc".to_string());
    let json = serde_json::to_value(AgentEventKind::ToolOutput {
        tool_call_id: tool_call_id.clone(),
        delta: "stdout…".to_string(),
    })
    .unwrap();
    assert_eq!(json["type"], "tool_output");
    assert_eq!(json["toolCallId"], "tc_abc");
    assert_eq!(json["delta"], "stdout…");
    assert_eq!(json.as_object().unwrap().len(), 3);
}

#[test]
fn tool_output_deserialize_without_tool_call_id_is_error() {
    // 缺 tool_call_id 的反序列化必须报错（不是静默补默认值——兜底禁令）
    let bad = serde_json::json!({ "type": "tool_output", "delta": "x" });
    let err = serde_json::from_value::<AgentEventKind>(bad).unwrap_err();
    assert!(
        err.to_string().contains("toolCallId") || err.to_string().contains("tool_call_id"),
        "错误信息应指向缺失字段，得到：{err}"
    );
}

#[test]
fn assistant_output_rejects_stray_tool_call_id() {
    // 张冠李戴的 wire 数据必须被拒（serde 默认容忍未知字段——这里显式钉住
    // 行为：Rust 侧拒收，防止上游 adapter 写错维度）
    let stray = serde_json::json!({
        "type": "assistant_output", "delta": "x", "toolCallId": "tc_1"
    });
    let parsed: Result<AgentEventKind, _> = serde_json::from_value(stray);
    assert!(
        parsed.is_err(),
        "带 toolCallId 的 assistant_output 必须显式报错（deny_unknown_fields 语义）"
    );
}

#[test]
fn tool_call_id_roundtrip_and_generation() {
    let explicit = ToolCallId::new("call_1".to_string());
    let json = serde_json::to_string(&explicit).unwrap();
    assert_eq!(json, "\"call_1\"", "ToolCallId 是裸字符串（TS `ToolCallId = string`）");
    assert_eq!(serde_json::from_str::<ToolCallId>(&json).unwrap(), explicit);

    let generated = ToolCallId::generate();
    assert_eq!(generated.as_str().len(), 36, "生成的 id 是 UUID v4");
    assert_ne!(generated, ToolCallId::generate());
}

#[test]
fn two_tool_outputs_keep_distinct_ids_through_roundtrip() {
    // TokenStream 按 toolCallId 索引（§11.1）——多工具并发不得串味
    let a = ToolCallId::new("tc_a".to_string());
    let b = ToolCallId::new("tc_b".to_string());
    let events = vec![
        event(
            1,
            AgentEventKind::ToolOutput {
                tool_call_id: a.clone(),
                delta: "a1".to_string(),
            },
        ),
        event(
            2,
            AgentEventKind::ToolOutput {
                tool_call_id: b.clone(),
                delta: "b1".to_string(),
            },
        ),
        event(
            3,
            AgentEventKind::ToolOutput {
                tool_call_id: a,
                delta: "a2".to_string(),
            },
        ),
    ];
    let json = serde_json::to_string(&events).unwrap();
    let back: Vec<AgentEvent> = serde_json::from_str(&json).unwrap();
    assert_eq!(back, events);
    let ids: Vec<&str> = back
        .iter()
        .filter_map(|e| match &e.kind {
            AgentEventKind::ToolOutput { tool_call_id, .. } => Some(tool_call_id.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(ids, vec!["tc_a", "tc_b", "tc_a"]);
}

// AgentEvent 往返（全 kind 家族）

fn all_kinds() -> Vec<AgentEventKind> {
    vec![
        AgentEventKind::AssistantOutput {
            delta: "hello 世界".to_string(),
        },
        AgentEventKind::ToolOutput {
            tool_call_id: ToolCallId::new("tc_1".to_string()),
            delta: "line\n\"quoted\"".to_string(),
        },
        AgentEventKind::RunStarted {
            source: Some("user".to_string()),
        },
        AgentEventKind::RunStarted { source: None },
        AgentEventKind::RunFinished {
            usage: Some(TurnUsage {
                input_tokens: Some(1200),
                output_tokens: Some(340),
                cached_input_tokens: Some(900),
                cache_write_tokens: Some(0),
                total_tokens: Some(1540),
                cost_usd: Some(0.0123),
            }),
        },
        AgentEventKind::RunFinished { usage: None },
        AgentEventKind::RunAborted,
        AgentEventKind::RunError {
            message: "provider 500".to_string(),
        },
        AgentEventKind::SnapshotRestored,
        AgentEventKind::RunEndedAck,
        AgentEventKind::RunGone,
    ]
}

#[test]
fn every_kind_roundtrips_through_json_string() {
    for (i, kind) in all_kinds().into_iter().enumerate() {
        let original = event(i as u64 + 1, kind.clone());
        let json = serde_json::to_string(&original).unwrap();
        let back: AgentEvent = serde_json::from_str(&json).unwrap();
        assert_eq!(original, back, "kind 往返失配：{json}");
    }
}

#[test]
fn every_kind_roundtrips_through_value() {
    for (i, kind) in all_kinds().into_iter().enumerate() {
        let original = event(i as u64 + 1, kind);
        let value = serde_json::to_value(&original).unwrap();
        let back: AgentEvent = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(original, back, "kind 往返失配：{value}");
    }
}

#[test]
fn discriminant_tags_are_exactly_the_ts_mirror_set() {
    // 与 src/lib/agent-protocol.ts 的 AgentEventKind 联合逐字对应
    let expected = [
        "assistant_output",
        "tool_output",
        "run_started",
        "run_finished",
        "run_aborted",
        "run_error",
        "snapshot_restored",
        "run_ended_ack",
        "run_gone",
    ];
    let mut seen: Vec<String> = Vec::new();
    for kind in all_kinds() {
        let json = serde_json::to_value(&kind).unwrap();
        let tag = json["type"].as_str().unwrap().to_string();
        if !seen.contains(&tag) {
            seen.push(tag);
        }
    }
    assert_eq!(
        seen,
        expected.to_vec(),
        "判别 tag 全集漂移——Rust 与 TS mirror 必须同步"
    );
}

#[test]
fn event_top_level_keys_are_run_id_seq_kind() {
    let json = serde_json::to_value(event(
        3,
        AgentEventKind::RunAborted,
    ))
    .unwrap();
    let obj = json.as_object().unwrap();
    assert_eq!(obj.len(), 3);
    assert_eq!(json["runId"], "run-1");
    assert_eq!(json["seq"], 3);
    assert_eq!(json["kind"]["type"], "run_aborted");
}

#[test]
fn run_id_is_bare_string_on_the_wire() {
    let json = serde_json::to_value(run_id()).unwrap();
    assert!(json.is_string(), "RunId 序列化为裸字符串（TS `RunId = string`）");
    assert_eq!(json, "run-1");
    assert_eq!(
        serde_json::from_str::<RunId>("\"run-99\"").unwrap().as_str(),
        "run-99"
    );
}

#[test]
fn run_finished_usage_is_camel_case_and_optional_keys_are_skipped() {
    let json = serde_json::to_value(AgentEventKind::RunFinished {
        usage: Some(TurnUsage {
            input_tokens: Some(10),
            total_tokens: Some(15),
            ..Default::default()
        }),
    })
    .unwrap();
    assert_eq!(json["usage"]["inputTokens"], 10);
    assert_eq!(json["usage"]["totalTokens"], 15);
    assert!(
        json["usage"].get("costUsd").is_none(),
        "未上报的用量字段不出现（不是 0）"
    );
    assert!(json["usage"].get("cacheWriteTokens").is_none());
}

#[test]
fn run_error_message_is_mandatory() {
    let bad = serde_json::json!({ "type": "run_error" });
    assert!(serde_json::from_value::<AgentEventKind>(bad).is_err());
}

#[test]
fn unknown_discriminant_is_an_explicit_error_not_a_silent_default() {
    // 兜底禁令：未知 tag 必须报错（前后端协议漂移 = 显式失败）
    let unknown = serde_json::json!({ "type": "some_future_frame", "delta": "x" });
    let err = serde_json::from_value::<AgentEventKind>(unknown).unwrap_err();
    assert!(
        err.to_string().contains("some_future_frame"),
        "错误信息应包含未知 tag，得到：{err}"
    );
}

#[test]
fn unicode_and_control_chars_survive_roundtrip() {
    let payloads = [
        "中文 · emoji 🎯 · 日本語",
        "line1\nline2\ttabbed",
        "quote\"backslash\\slash",
        "{\"nested\":\"json\"}",
        "",
    ];
    for p in payloads {
        let original = event(
            1,
            AgentEventKind::AssistantOutput {
                delta: p.to_string(),
            },
        );
        let json = serde_json::to_string(&original).unwrap();
        let back: AgentEvent = serde_json::from_str(&json).unwrap();
        assert_eq!(original, back, "payload 往返失配：{p:?}");
    }
}

#[test]
fn long_stream_of_events_roundtrips_in_order() {
    // 模拟一次真实 run：文本 -> 工具 -> 文本 -> finish，seq 连续
    let mut seq = Seq::new();
    let tc = ToolCallId::new("tc_run".to_string());
    let mut stream = vec![event(
        seq.as_u64(),
        AgentEventKind::RunStarted {
            source: Some("user".to_string()),
        },
    )];
    for chunk in ["首", "段"] {
        seq = seq.increment();
        stream.push(event(
            seq.as_u64(),
            AgentEventKind::AssistantOutput {
                delta: chunk.to_string(),
            },
        ));
    }
    for chunk in ["out-1", "out-2"] {
        seq = seq.increment();
        stream.push(event(
            seq.as_u64(),
            AgentEventKind::ToolOutput {
                tool_call_id: tc.clone(),
                delta: chunk.to_string(),
            },
        ));
    }
    seq = seq.increment();
    stream.push(event(seq.as_u64(), AgentEventKind::RunFinished { usage: None }));

    let json = serde_json::to_string(&stream).unwrap();
    let back: Vec<AgentEvent> = serde_json::from_str(&json).unwrap();
    assert_eq!(back, stream);
    // seq 连续且严格递增（SeqTracker 的连续性前提，§11.2）
    let seqs: Vec<u64> = back.iter().map(|e| e.seq.as_u64()).collect();
    assert_eq!(seqs, vec![1, 2, 3, 4, 5, 6]);
}

// ResumeOutcome（§11.3 第 3 步三分支）

#[test]
fn resume_outcome_covers_three_branches_with_snake_case_tags() {
    let cases = [
        (ResumeOutcome::Replayed, "replayed"),
        (ResumeOutcome::SnapshotRequired, "snapshot_required"),
        (ResumeOutcome::RunGone, "run_gone"),
    ];
    for (outcome, tag) in cases {
        let json = serde_json::to_value(&outcome).unwrap();
        assert_eq!(json, serde_json::json!({ "type": tag }));
        let back: ResumeOutcome = serde_json::from_value(json).unwrap();
        assert_eq!(back, outcome);
    }
}

// ExtensionUi + protocolVersion（§9 铁律 3）

#[test]
fn extension_ui_request_roundtrip_carries_protocol_version() {
    let req = ExtensionUiRequest {
        id: "req-1".to_string(),
        method: "confirm".to_string(),
        payload: serde_json::json!({ "message": "允许写入？" }),
        protocol_version: PROTOCOL_VERSION,
    };
    let json = serde_json::to_value(&req).unwrap();
    assert_eq!(json["protocolVersion"], PROTOCOL_VERSION);
    assert_eq!(json["id"], "req-1");
    assert_eq!(json["method"], "confirm");
    let back: ExtensionUiRequest = serde_json::from_value(json).unwrap();
    assert_eq!(req, back);
}

#[test]
fn extension_ui_response_roundtrip_both_outcomes() {
    let confirmed = ExtensionUiResponse {
        id: "req-1".to_string(),
        value: Some(serde_json::json!({ "ok": true })),
        cancelled: false,
        protocol_version: PROTOCOL_VERSION,
    };
    let json = serde_json::to_value(&confirmed).unwrap();
    assert_eq!(json["protocolVersion"], PROTOCOL_VERSION);
    assert_eq!(json["cancelled"], false);
    assert_eq!(json["value"]["ok"], true);
    assert_eq!(
        serde_json::from_value::<ExtensionUiResponse>(json).unwrap(),
        confirmed
    );

    let cancelled = ExtensionUiResponse {
        id: "req-2".to_string(),
        value: None,
        cancelled: true,
        protocol_version: PROTOCOL_VERSION,
    };
    let json = serde_json::to_value(&cancelled).unwrap();
    assert_eq!(json["cancelled"], true);
    assert!(json.get("value").is_none(), "取消应答不携带 value 键");
    assert_eq!(
        serde_json::from_value::<ExtensionUiResponse>(json).unwrap(),
        cancelled
    );
}

#[test]
fn extension_ui_protocol_version_mismatch_is_detectable() {
    // 版本漂移 = 显式错误（ApprovalRegistry.resolve 的第一道闸，§10.4）
    let stale = serde_json::json!({
        "id": "req-1",
        "value": null,
        "cancelled": false,
        "protocolVersion": PROTOCOL_VERSION + 99
    });
    let resp: ExtensionUiResponse = serde_json::from_value(stale).unwrap();
    assert_ne!(
        resp.protocol_version, PROTOCOL_VERSION,
        "旧版本应答必须能被识别（而非被静默接受）"
    );
}

// CapabilityFlags（§9 铁律 4：移动端差异协议层表达）

#[test]
fn capability_flags_express_desktop_vs_mobile_in_the_protocol() {
    let desktop = CapabilityFlags::desktop();
    let mobile = CapabilityFlags::mobile();

    // 桌面：Replayable 全 impl；移动端：不 impl Replayable（§10.4/§13）
    assert!(desktop.replayable);
    assert!(!mobile.replayable);
    // 移动端每会话 <=3 快照；桌面无上限
    assert_eq!(desktop.max_snapshots_per_session, None);
    assert_eq!(mobile.max_snapshots_per_session, Some(3));

    for flags in [desktop, mobile] {
        let json = serde_json::to_value(&flags).unwrap();
        assert!(json["replayable"].is_boolean());
        assert!(json.get("maxSnapshotsPerSession").is_some());
        let back: CapabilityFlags = serde_json::from_value(json).unwrap();
        assert_eq!(flags, back);
    }
}

// 端到端：一次真实会话片段的 wire 快照

#[test]
fn wire_snapshot_is_stable() {
    // 逐字钉死一条事件的 JSON——最严的形状锁（字段名/顺序无关但键集与值固定）
    let ev = AgentEvent {
        run_id: RunId::new("run-1712345678901".to_string()),
        seq: Seq::from_raw(2),
        kind: AgentEventKind::ToolOutput {
            tool_call_id: ToolCallId::new("tc_1".to_string()),
            delta: "ok".to_string(),
        },
    };
    let json = serde_json::to_string(&ev).unwrap();
    assert_eq!(
        json,
        r#"{"runId":"run-1712345678901","seq":2,"kind":{"type":"tool_output","toolCallId":"tc_1","delta":"ok"}}"#
    );

    let assistant = serde_json::to_string(&AgentEvent {
        run_id: RunId::new("run-1".to_string()),
        seq: Seq::from_raw(1),
        kind: AgentEventKind::AssistantOutput {
            delta: "hi".to_string(),
        },
    })
    .unwrap();
    assert_eq!(
        assistant,
        r#"{"runId":"run-1","seq":1,"kind":{"type":"assistant_output","delta":"hi"}}"#
    );
}
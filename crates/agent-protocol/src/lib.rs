//! L3.5 协议层：前后端事件契约的单一来源（docs/architecture.md §9）。
//!
//! 职责：纯类型 + 序列化。**零 IO**（可单测）、**不引用 pi**
//! （nightly 污染不外泄，pi-adapter 做转换）。
//!
//! 铁律（§9）：
//! 1. `ToolOutput` 必带 `tool_call_id`——构造时无 id 编译不过；
//!    `AssistantOutput` 无 `tool_call_id`——类型系统保证不张冠李戴。
//! 2. `seq` per-run 单调递增，从 1 起。
//! 3. `protocol_version` 随 ExtensionUi 往返校验。
//! 4. 移动端能力差异用 capability flag 表达，不做 cfg 散布。
//! 5. serde 序列化形状 = L1 TypeScript 镜像类型的唯一依据
//!    （`src/lib/agent-protocol.ts`，互锁测试防漂移）。

// 注意：模块名 `serde` 与外部 crate `serde` 同名。Rust 2018 下
// `use serde::X` 在本 crate 内会解析到外部 crate（模块路径需 `crate::serde::`
// 或 `self::`），为免歧义，本文件与各模块一律用 `::serde::` 全路径引用。
pub mod event;
pub mod extension_ui;
pub mod resume;
pub mod serde;
pub mod types;

// 关键导出（前端/XState/Rust 消费的协议面）。
pub use event::{AgentEvent, AgentEventKind, TurnUsage};
pub use extension_ui::{ExtensionUiRequest, ExtensionUiResponse, PROTOCOL_VERSION};
pub use resume::ResumeOutcome;
pub use types::{CapabilityFlags, RunId, Seq, ToolCallId};
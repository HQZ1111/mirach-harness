//! pi SDK 集成第 1 步（docs/pi-integration.md §7-1）：进程内会话骨架。
//!
//! 纪律（docs/pi-integration.md §0.1/§4.1）：
//! - pi 不是 tokio——pi 的 future 禁止进 tauri::async_runtime，asupersync
//!   运行时由 PiRuntime 持有（'static 泄漏一次，进程生命周期内复用）；
//! - AgentSessionHandle 被 Mutex 串行——同一时刻只有一个 prompt；
//! - 消费面只准 import pi::sdk / pi::model（SemVer 稳定面）。

use std::sync::{Arc, Mutex};

use pi::sdk::{AgentEvent, AgentSessionHandle, SessionOptions, create_agent_session};

/// asupersync 运行时宿主（'static，驱动 pi 的全部 future）。
pub struct PiRuntime {
    runtime: &'static asupersync::runtime::Runtime,
}

impl PiRuntime {
    pub fn new() -> Self {
        let reactor = asupersync::runtime::reactor::create_reactor().expect("pi reactor");
        let runtime = asupersync::runtime::RuntimeBuilder::current_thread()
            .with_reactor(reactor)
            .build()
            .expect("pi runtime");
        Self {
            runtime: Box::leak(Box::new(runtime)),
        }
    }

    pub fn block_on<F: std::future::Future>(&self, fut: F) -> F::Output {
        self.runtime.block_on(fut)
    }
}

/// pi 会话引擎（AppState 成员；Mutex 串行化 prompt）。
pub struct PiEngine {
    runtime: PiRuntime,
    handle: Mutex<Option<AgentSessionHandle>>,
}

impl PiEngine {
    pub fn new() -> Self {
        Self {
            runtime: PiRuntime::new(),
            handle: Mutex::new(None),
        }
    }

    /// 创建进程内会话（ephemeral；provider/model 缺省读 ~/.pi settings）。
    /// 返回选定的 provider/model 标识。
    pub fn create_session(
        &self,
        provider: Option<String>,
        model: Option<String>,
    ) -> Result<String, String> {
        let options = SessionOptions {
            provider,
            model,
            no_session: true,
            ..SessionOptions::default()
        };
        let handle: AgentSessionHandle = self
            .runtime
            .block_on(async { create_agent_session(options).await })
            .map_err(|e| e.to_string())?;
        let (provider, model_id) = handle.model();
        *self.handle.lock().expect("pi engine poisoned") = Some(handle);
        Ok(format!("{provider}/{model_id}"))
    }

    /// 发送一条 prompt（Mutex 串行），收集 AgentEvent 轨迹 + 最终消息。
    /// 事件→AG-UI 的流式映射在 §7-2 拆出；此处先返回归并轨迹供冒烟。
    pub fn prompt(&self, text: &str) -> Result<Vec<String>, String> {
        let mut guard = self.handle.lock().expect("pi engine poisoned");
        let handle = match guard.as_mut() {
            Some(h) => h,
            None => return Err("no active session".into()),
        };
        let events: Arc<Mutex<Vec<String>>> = Default::default();
        let sink = events.clone();
        let assistant = self
            .runtime
            .block_on(handle.prompt(text, move |event: AgentEvent| {
                let line = match &event {
                    AgentEvent::MessageUpdate {
                        assistant_message_event,
                        ..
                    } => format!("update: {assistant_message_event:?}"),
                    other => format!("{other:?}"),
                };
                sink.lock().expect("event sink poisoned").push(line);
            }))
            .map_err(|e| e.to_string())?;
        let mut all = events.lock().expect("event sink poisoned").clone();
        all.push(format!("final: {assistant:#?}"));
        Ok(all)
    }

    /// 会话状态快照（provider/model/message_count）。
    pub fn state(&self) -> Result<String, String> {
        let mut guard = self.handle.lock().expect("pi engine poisoned");
        let handle = match guard.as_mut() {
            Some(h) => h,
            None => return Err("no active session".into()),
        };
        let state = self
            .runtime
            .block_on(handle.state())
            .map_err(|e| e.to_string())?;
        Ok(format!(
            "provider={} model={} messages={}",
            state.provider, state.model_id, state.message_count
        ))
    }
}

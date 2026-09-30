//! pi SDK 集成（docs/pi-integration.md §7-1/§7-4）：进程内会话引擎。
//!
//! 纪律（docs/pi-integration.md §0.1/§4.1）：
//! - pi 不是 tokio——pi 的 future 禁止进 tauri::async_runtime，asupersync
//!   运行时由 PiRuntime 持有（'static 泄漏一次，进程生命周期内复用）；
//! - AgentSessionHandle 被 Mutex 串行——同一时刻只有一个 prompt；
//! - 消费面只准 import pi::sdk / pi::model（SemVer 稳定面）；
//! - **一切 block_on 都在 16MiB 大栈线程上**（E2E 实测：pi debug 构建的
//!   session future 深递归 >2MiB 默认栈，tokio worker / 裸 spawn 必爆栈；
//!   MutexGuard 跨 await 非 Send，不能挪 reserved thread——pi
//!   .cargo/config.toml RUST_MIN_STACK=16MiB 同源教训）。实现形态：共享态
//!   全在 Arc<EngineShared> 里，大栈线程 move Arc 进去、锁在线程内拿，
//!   闭包满足 'static；串行语义不变。

use std::sync::{Arc, Mutex};

use pi::sdk::{AgentEvent, AgentSessionHandle, SessionOptions, create_agent_session};

/// block_on 的固定执行栈：16MiB（虚拟预留，惰性提交）。
const PI_STACK_BYTES: usize = 16 * 1024 * 1024;

/// 在 16MiB 大栈线程上同步跑一个闭包并取回结果（'static）。
pub(crate) fn on_big_stack<T: Send + 'static>(
    f: impl FnOnce() -> T + Send + 'static,
) -> Result<T, String> {
    std::thread::Builder::new()
        .name("pi-block-on".into())
        .stack_size(PI_STACK_BYTES)
        .spawn(f)
        .map_err(|e| format!("spawn pi-block-on: {e}"))?
        .join()
        .map_err(|_| "pi-block-on thread panicked".to_string())
}

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

/// 跨线程共享的引擎态（PiEngine 的全部字段；大栈线程经 Arc 访问）。
struct EngineShared {
    runtime: PiRuntime,
    handle: Mutex<Option<AgentSessionHandle>>,
    /// 最近一次 prompt 的 abort 句柄（pi_interrupt 置 abort；run 结束清理）。
    abort: Mutex<Option<pi::sdk::AbortHandle>>,
}

/// pi 会话引擎（AppState 成员；内部 Arc 共享，Clone 便宜且共享单会话）。
#[derive(Clone)]
pub struct PiEngine {
    shared: Arc<EngineShared>,
}

impl PiEngine {
    pub fn new() -> Self {
        Self {
            shared: Arc::new(EngineShared {
                runtime: PiRuntime::new(),
                handle: Mutex::new(None),
                abort: Mutex::new(None),
            }),
        }
    }

    /// 创建进程内会话（ephemeral；provider/model 缺省读 ~/.pi settings）。
    /// 返回选定的 provider/model 标识。
    pub fn create_session(
        &self,
        provider: Option<String>,
        model: Option<String>,
    ) -> Result<String, String> {
        let shared = Arc::clone(&self.shared);
        let options = SessionOptions {
            provider,
            model,
            no_session: true,
            ..SessionOptions::default()
        };
        let handle: AgentSessionHandle = on_big_stack(move || {
            shared.runtime.block_on(async { create_agent_session(options).await })
        })?
        .map_err(|e| e.to_string())?;
        let (provider, model_id) = handle.model();
        *self
            .shared
            .handle
            .lock()
            .map_err(|_| "pi engine poisoned".to_string())? = Some(handle);
        Ok(format!("{provider}/{model_id}"))
    }

    /// 发送一条 prompt（SDK 二参签名：text + on_event；Mutex 串行）。
    /// 同时登记 abort 句柄（pi_interrupt 可中断；prompt 返回后清理）。
    pub fn prompt(
        &self,
        text: &str,
        on_event: impl Fn(AgentEvent) + Send + Sync + 'static,
    ) -> Result<(), String> {
        let (abort_handle, abort_signal) = pi::sdk::AbortHandle::new();
        *self
            .shared
            .abort
            .lock()
            .map_err(|_| "pi abort poisoned".to_string())? = Some(abort_handle);
        let result = self.prompt_inner(text, on_event, Some(abort_signal));
        *self
            .shared
            .abort
            .lock()
            .map_err(|_| "pi abort poisoned".to_string())? = None;
        result
    }

    fn prompt_inner(
        &self,
        text: &str,
        on_event: impl Fn(AgentEvent) + Send + Sync + 'static,
        abort_signal: Option<pi::sdk::AbortSignal>,
    ) -> Result<(), String> {
        let shared = Arc::clone(&self.shared);
        let text = text.to_string();
        on_big_stack(move || {
            // 锁在大栈线程内拿并跨 block_on 持有——MutexGuard 不出线程，
            // 串行不变量靠 std Mutex 保证（其他 prompt 调用在此排队）。
            let mut guard = shared.handle.lock().expect("pi engine poisoned");
            let handle = guard.as_mut().ok_or("no active session")?;
            let result = shared.runtime.block_on(async move {
                match abort_signal {
                    Some(sig) => handle.prompt_with_abort(text, sig, on_event).await,
                    None => handle.prompt(text, on_event).await,
                }
            });
            result.map(|_| ()).map_err(|e| e.to_string())
        })?
    }

    /// 中断当前 run（§4.5：abort 是控制操作走 IPC）。置 abort 信号；
    /// 阻塞中的 prompt_with_abort 观察到后尽快收尾返回。
    pub fn interrupt(&self) -> Result<(), String> {
        let guard = self
            .shared
            .abort
            .lock()
            .map_err(|_| "pi abort poisoned".to_string())?;
        match guard.as_ref() {
            Some(h) => {
                h.abort();
                Ok(())
            }
            None => Err("no active run".into()),
        }
    }

    /// 会话状态快照（session_id/provider/model/thinking/message_count）。
    pub fn state(&self) -> Result<serde_json::Value, String> {
        let shared = Arc::clone(&self.shared);
        let state = on_big_stack(move || {
            let mut guard = shared.handle.lock().expect("pi engine poisoned");
            let handle = guard.as_mut().ok_or("no active session")?;
            shared
                .runtime
                .block_on(handle.state())
                .map_err(|e| e.to_string())
        })??;
        Ok(serde_json::json!({
            "sessionId": state.session_id,
            "provider": state.provider,
            "modelId": state.model_id,
            "thinkingLevel": state.thinking_level.map(|l| l.to_string()),
            "messageCount": state.message_count,
        }))
    }

    /// 会话消息历史（pi Message 序列化；camelCase tag=role）。
    pub fn messages(&self) -> Result<serde_json::Value, String> {
        let shared = Arc::clone(&self.shared);
        let msgs = on_big_stack(move || {
            let guard = shared.handle.lock().expect("pi engine poisoned");
            let handle = guard.as_ref().ok_or("no active session")?;
            // AgentSessionHandle 内部是共享态（session Arc），借引足矣；
            // block_on 借 &handle 合法（运行时在线程内）。
            shared
                .runtime
                .block_on(handle.messages())
                .map_err(|e| e.to_string())
        })??;
        serde_json::to_value(&msgs).map_err(|e| e.to_string())
    }

    /// 切换 provider/model（ModelSelector 数据面）。
    pub fn set_model(&self, provider: &str, model_id: &str) -> Result<(), String> {
        let shared = Arc::clone(&self.shared);
        let provider = provider.to_string();
        let model_id = model_id.to_string();
        on_big_stack(move || {
            let mut guard = shared.handle.lock().expect("pi engine poisoned");
            let handle = guard.as_mut().ok_or("no active session")?;
            shared
                .runtime
                .block_on(handle.set_model(&provider, &model_id))
                .map_err(|e| e.to_string())
        })?
    }

    /// 设置思考预算档位（off/minimal/low/medium/high/xhigh/max）。
    pub fn set_thinking_level(&self, level: &str) -> Result<(), String> {
        let shared = Arc::clone(&self.shared);
        let parsed: pi::sdk::ThinkingLevel = level.parse().map_err(|e: String| e)?;
        on_big_stack(move || {
            let mut guard = shared.handle.lock().expect("pi engine poisoned");
            let handle = guard.as_mut().ok_or("no active session")?;
            shared
                .runtime
                .block_on(handle.set_thinking_level(parsed))
                .map_err(|e| e.to_string())
        })?
    }

    /// 模型目录（ModelSelector 数据面）：内置目录 + models.json 覆盖，
    /// 只列凭据就绪的条目（model_entry_is_ready 语义）。纯同步（无 pi
    /// future），走大栈线程统一阻塞语义。
    /// 注：AuthStorage/Config 未进 pi::sdk re-export，但 load_for_listing
    /// （sdk 稳定面）的签名要求它们——走 pub mod 是上游 sdk 内部同款用法
    /// （sdk.rs: `AuthStorage::load_async(Config::auth_path())`），最小例外
    /// 记录在案；上游收口后一行切换。
    pub fn list_models(&self) -> Result<serde_json::Value, String> {
        on_big_stack(move || {
            let auth = pi::auth::AuthStorage::load(pi::config::Config::auth_path())
                .unwrap_or_else(|_| pi::auth::AuthStorage::empty_at(pi::config::Config::auth_path()));
            let registry = pi::sdk::ModelRegistry::load_for_listing(&auth, None);
            let models: Vec<serde_json::Value> = registry
                .get_available()
                .iter()
                .map(|e| {
                    let m = &e.model;
                    serde_json::json!({
                        "provider": m.provider,
                        "id": m.id,
                        "name": m.name,
                        "contextWindow": m.context_window,
                        "maxTokens": m.max_tokens,
                        "reasoning": m.reasoning,
                    })
                })
                .collect();
            Ok(serde_json::json!({ "models": models }))
        })?
    }
}

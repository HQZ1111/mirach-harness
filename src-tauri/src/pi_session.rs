//! pi SDK 集成（docs/pi-integration.md §7-1/§7-4）：进程内会话引擎。
//!
//! 纪律（docs/pi-integration.md §0.1/§4.1）：
//! - pi 不是 tokio——pi 的 future 禁止进 tauri::async_runtime，asupersync
//!   运行时由 PiRuntime 持有（'static 泄漏一次，进程生命周期内复用）；
//! - AgentSessionHandle 被 Mutex 串行——同一时刻只有一个 prompt；
//! - 消费面只准 import pi::sdk / pi::model（SemVer 稳定面）；
//! - **禁止兜底（2026-10-01 用户定稿）**：错误就是错误——失败一律传播
//!   （Err），不降级、不用默认值替代、不假装成功；
//! - **一切 block_on 都在 16MiB 大栈线程上**（E2E 实测：pi debug 构建的
//!   session future 深递归 >2MiB 默认栈，tokio worker / 裸 spawn 必爆栈；
//!   MutexGuard 跨 await 非 Send，不能挪 reserved thread——pi
//!   .cargo/config.toml RUST_MIN_STACK=16MiB 同源教训）。实现形态：共享态
//!   全在 Arc<EngineShared> 里，大栈线程 move Arc 进去、锁在线程内拿，
//!   闭包满足 'static；串行语义不变。
//! - **current_thread 运行时跨线程 block_on 是 asupersync 设计内行为**：
//!   Runtime::block_on 文档（builder.rs）明说 "the calling thread borrows
//!   the runtime's single worker for the life of the call"；worker 借不到
//!   时（并发调用/任务 poll 内嵌套/shutdown）driver 把 future 原样退回走
//!   caller-polled 路径，不 panic 不 UB（loan 协议，WorkerSlot::Loaned）。
//!   签名 block_on<F: Future> 无 'static 约束，故 messages() 可借 &handle。

use std::sync::{Arc, Mutex};

use pi::sdk::{AgentEvent, AgentSessionHandle, SessionOptions, create_agent_session};

/// block_on 的固定执行栈：16MiB（虚拟预留，惰性提交）。
const PI_STACK_BYTES: usize = 16 * 1024 * 1024;

/// 在 16MiB 大栈线程上同步跑一个闭包并取回结果（'static）。
/// 外层错误统一 "pi-block-on: " 前缀（spawn/panic），与内层 pi 业务错误可区分。
pub(crate) fn on_big_stack<T: Send + 'static>(
    f: impl FnOnce() -> T + Send + 'static,
) -> Result<T, String> {
    std::thread::Builder::new()
        .name("pi-block-on".into())
        .stack_size(PI_STACK_BYTES)
        .spawn(f)
        .map_err(|e| format!("pi-block-on: spawn failed: {e}"))?
        .join()
        .map_err(|payload| {
            let msg = payload
                .downcast_ref::<&str>()
                .map(|s| (*s).to_string())
                .or_else(|| payload.downcast_ref::<String>().cloned())
                .unwrap_or_else(|| "unknown panic payload".into());
            format!("pi-block-on: thread panicked: {msg}")
        })
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
    /// 最近一次 prompt 的 abort 句柄（pi_interrupt 置 abort；guard 清场）。
    abort: Mutex<Option<pi::sdk::AbortHandle>>,
}

/// prompt 期间的清场守卫。Drop 无法传播错误——这里的锁失败只能忽略：
/// abort 槽位残留的最坏后果是 interrupt() 对已结束 run 置位（无害），
/// 是资源清场的物理边界，不是业务兜底。
struct PromptGuard<'a> {
    abort: &'a Mutex<Option<pi::sdk::AbortHandle>>,
}
impl Drop for PromptGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut slot) = self.abort.lock() {
            *slot = None;
        }
    }
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
    /// 返回 "provider/model" 标识（与 handle.model() 的 (String, String) 对应，
    /// 仅供日志；消费方不解析——单会话引擎下 provider/model 经 pi_get_state
    /// 结构化获取）。
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
            .map_err(|_| "pi handle mutex poisoned".to_string())? = Some(handle);
        Ok(format!("{provider}/{model_id}"))
    }

    /// 发送一条 prompt（SDK 二参签名：text + on_event；Mutex 串行）。
    /// 同时登记 abort 句柄（pi_interrupt 可中断；PromptGuard 清场）。
    pub fn prompt(
        &self,
        text: &str,
        on_event: impl Fn(AgentEvent) + Send + Sync + 'static,
    ) -> Result<(), String> {
        // 重入防护：on_event 回调运行在 block_on 的 poll 里，asupersync 的
        // ScopedRuntimeHandle 是 thread-local——此刻 current_handle() 必
        // Some；而外部线程（tokio worker/IPC）新起的 prompt 拿不到。拿到 =
        // 正在另一个 prompt 的 poll 链上 = 再 lock handle 必死锁（std Mutex
        // 不可重入），显式报错而不是挂死。
        if asupersync::runtime::Runtime::current_handle().is_some() {
            return Err(
                "re-entrant prompt rejected: on_event 回调里禁止发起新 prompt（会死锁）".into(),
            );
        }
        let (abort_handle, abort_signal) = pi::sdk::AbortHandle::new();
        *self
            .shared
            .abort
            .lock()
            .map_err(|_| "pi abort mutex poisoned".to_string())? = Some(abort_handle);
        let _guard = PromptGuard {
            abort: &self.shared.abort,
        };
        self.prompt_inner(text, on_event, Some(abort_signal))
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
            let mut guard = shared
                .handle
                .lock()
                .map_err(|_| "pi handle mutex poisoned".to_string())?;
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
            .map_err(|_| "pi abort mutex poisoned".to_string())?;
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
            let mut guard = shared
                .handle
                .lock()
                .map_err(|_| "pi handle mutex poisoned".to_string())?;
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
            let guard = shared
                .handle
                .lock()
                .map_err(|_| "pi handle mutex poisoned".to_string())?;
            let handle = guard.as_ref().ok_or("no active session")?;
            // block_on<F: Future> 无 'static 约束，借 &handle 合法（future
            // 在本线程 caller-polled 或经 loan 协议驱动，见模块头注释）。
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
            let mut guard = shared
                .handle
                .lock()
                .map_err(|_| "pi handle mutex poisoned".to_string())?;
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
        // ThinkingLevel::FromStr 的 Err 就是 String（上游定义），解析为纯
        // 字符串匹配（无深递归），主线程做安全。
        let parsed: pi::sdk::ThinkingLevel = level.parse().map_err(|e: String| e)?;
        on_big_stack(move || {
            let mut guard = shared
                .handle
                .lock()
                .map_err(|_| "pi handle mutex poisoned".to_string())?;
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
            // 错误即错误：auth.json 读取失败直接报错，不降级为空凭据目录。
            let auth = pi::auth::AuthStorage::load(pi::config::Config::auth_path())
                .map_err(|e| format!("auth.json 读取失败: {e}"))?;
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

//! pi SDK 集成（docs/pi-integration.md §7-1/§7-4）：进程内会话引擎。
//!
//! 纪律（docs/pi-integration.md §0.1/§4.1）：
//! - pi 不是 tokio——pi 的 future 禁止进 tauri::async_runtime，asupersync
//!   运行时由 PiRuntime 持有（'static 泄漏一次，进程生命周期内复用）；
//! - AgentSessionHandle 被 Mutex 串行——同一时刻只有一个 prompt；
//! - 消费面只准 import pi::sdk / pi::model（SemVer 稳定面）与 pub 模块：
//!   pi::checkpoint（checkpoint/rewind/retry，2026-10-01 起）+
//!   pi::agent_cx::AgentCx（Mutex<Session> 内层锁需要 Cx，for_request 是
//!   上游顶层入口的规范构造）+ pi::session::SessionEntry（checkpoint 条目
//!   枚举，上游无现成列举 API）——pub 模块最小例外，逐一记录在案；
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

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use pi::model::{ContentBlock, ImageContent, TextContent, UserContent};
use pi::sdk::{AgentEvent, AgentSessionHandle, SessionOptions, create_agent_session};

use crate::agui::{AguiImage, ApprovalRegistry, AskRegistry, ThreadBuffers, UiAnswer};

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

/// abort 槽位条目：句柄 + 所属 run 代号。代号供 PromptGuard 清场时做
/// 身份比对——并发排队时后一个 run 已写入自己的槽位，前一个 run 的
/// Drop 不得抹掉后者的句柄（否则 interrupt 失灵）。
struct AbortSlot {
    run: u64,
    handle: pi::sdk::AbortHandle,
}

/// 跨线程共享的引擎态（PiEngine 的全部字段；大栈线程经 Arc 访问）。
struct EngineShared {
    runtime: PiRuntime,
    handle: Mutex<Option<AgentSessionHandle>>,
    /// 最近一次 prompt 的 abort 句柄（pi_interrupt 置 abort；guard 按身份清场）。
    abort: Mutex<Option<AbortSlot>>,
    /// run 代号发生器（abort 槽位身份比对用，单调递增）。
    run_counter: AtomicU64,
    /// 审批注册表（§4.4）——与 AguiState 共享同一 Arc：登记在
    /// UiBridgeHandle（handler 桥），会话 discard/切换成功后由引擎侧
    /// 清理挂起项（P1-3 防鬼影卡片）。
    approvals: Arc<ApprovalRegistry>,
    /// ask 工具问题注册表（交互卡）——同款共享：channel UI 的请求经
    /// 本表登记 + 进 AG-UI 流，前端应答经 `pi_ask_response` 回灌。
    asks: Arc<AskRegistry>,
    /// 工具审批策略（pi `ApprovalState`，进程级共享；SessionOptions.
    /// approval_state 挂同一 Arc——`set_mode` 即时作用于运行中的会话）。
    /// 模式切换钮（2026-11-01）的数据面：计划模式 = plan gate、
    /// 文件内修改 = Write、完全访问 = Yolo（语义见 approval.rs 头注）。
    approval: Arc<pi::approval::ApprovalState>,
}

/// prompt 期间的清场守卫。Drop 无法传播错误——这里的锁失败只能忽略：
/// abort 槽位残留的最坏后果是 interrupt() 对已结束 run 置位（无害），
/// 是资源清场的物理边界，不是业务兜底。
/// 清场按 run 代号做身份比对：并发排队时后一个 run 已写入自己的槽位，
/// 前一个 run 的 Drop 不得抹掉后者的句柄（P1-2 竞态修复的另一半）。
struct PromptGuard<'a> {
    abort: &'a Mutex<Option<AbortSlot>>,
    run: u64,
}
impl Drop for PromptGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut slot) = self.abort.lock() {
            if slot.as_ref().map(|s| s.run) == Some(self.run) {
                *slot = None;
            }
        }
    }
}

/// pi 会话引擎（AppState 成员；内部 Arc 共享，Clone 便宜且共享单会话）。
#[derive(Clone)]
pub struct PiEngine {
    shared: Arc<EngineShared>,
    /// 会话分栏的独立柄（v7.4 多柄并发）：key = 分栏线程键（sessionId）。
    /// 每柄独立锁——分栏 prompt 只锁自己的柄，与主柄/其他分栏并行；
    /// 同一路径全引擎只能有一个柄（主柄或子柄，open 时互斥驱逐）。
    side_engines: Arc<Mutex<HashMap<String, Arc<SideEngine>>>>,
}

/// 分栏独立柄：打开时从 session_path 装填，自己的 abort 槽/run 代号。
struct SideEngine {
    path: String,
    handle: Mutex<AgentSessionHandle>,
    abort: Mutex<Option<AbortSlot>>,
    run_counter: AtomicU64,
}

/// 扩展 UI 请求的宿主桥柄（§4.4）：handler 收到请求时先登记再推
/// CUSTOM 进 AG-UI 缓冲（SSE 唯一消费口照常到达），前端经 IPC 应答回灌。
#[derive(Clone)]
pub struct UiBridgeHandle {
    pub buffers: Arc<Mutex<ThreadBuffers>>,
    pub approvals: Arc<ApprovalRegistry>,
    pub thread: String,
}

/// ExtensionUiHandler 实现：请求 → [registry 登记 → CUSTOM 进缓冲] →
/// oneshot 等前端 IPC 应答。fail-closed 是上游默认（无 handler 时能力
/// 提示直接 deny）——有 handler 后，宿主桥故障（registry 清空）按
/// cancelled 回灌，让扩展得到明确"用户取消"而不是永久挂起。
/// 上游 trait 是 #[async_trait]（dyn-compatible 反反 Sugar），impl 必须同宏。
struct HostUiBridge {
    handle: UiBridgeHandle,
}

#[async_trait::async_trait]
impl pi::sdk::ExtensionUiHandler for HostUiBridge {
    async fn request_ui(
        &self,
        request: pi::sdk::ExtensionUiRequest,
    ) -> pi::sdk::Result<Option<pi::sdk::ExtensionUiResponse>> {
        let (tx, rx) = tokio::sync::oneshot::channel::<UiAnswer>();
        // 先登记再推流——前端拉取/秒应答不会撞空注册表
        self.handle.approvals.register(
            request.id.clone(),
            serde_json::json!({
                "id": request.id,
                "method": request.method,
                "payload": request.payload,
                "timeoutMs": request.timeout_ms,
                "extensionId": request.extension_id,
            }),
            tx,
        );
        crate::agui::push_shared(
            &self.handle.buffers,
            &self.handle.thread,
            serde_json::json!({
                "type": "CUSTOM",
                "name": "extension_ui_request",
                "value": { "id": request.id },
            }),
        );
        // 应答到达（或注册表被整体清理）前，pi 的扩展任务在此挂起
        let answer = match rx.await {
            Ok(a) => a,
            Err(_) => UiAnswer { value: None, cancelled: true },
        };
        Ok(Some(pi::sdk::ExtensionUiResponse {
            id: request.id,
            value: answer.value,
            cancelled: answer.cancelled,
        }))
    }
}

impl PiEngine {
    pub fn new() -> Self {
        Self {
            shared: Arc::new(EngineShared {
                runtime: PiRuntime::new(),
                handle: Mutex::new(None),
                abort: Mutex::new(None),
                run_counter: AtomicU64::new(0),
                approvals: Arc::new(ApprovalRegistry::default()),
                asks: Arc::new(AskRegistry::default()),
                approval: Arc::new(pi::approval::ApprovalState::default()),
            }),
            side_engines: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// 审批注册表共享柄（AguiState 与 PiEngine 持同一份真相——登记在
    /// UiBridgeHandle，清理在会话切换路径，同一 Arc 才能对上）。
    pub fn approvals(&self) -> Arc<ApprovalRegistry> {
        Arc::clone(&self.shared.approvals)
    }

    /// ask 问题注册表共享柄（AguiState 与 PiEngine 同一份真相）。
    pub fn asks(&self) -> Arc<AskRegistry> {
        Arc::clone(&self.shared.asks)
    }

    // ── 模式切换（2026-11-01 用户："输入框的加号右边加个zcode的切换模式
    //    按钮，计划模式，文件内修改，完全访问"）──
    // 三态全部映射 pi 原生能力，零自创语义：
    // - 计划模式 = plan gate（plan.rs：Planning 态下工具执行器拒绝
    //   变更/进程类工具，模型经 submit_plan 提交、宿主审批后放行）；
    // - 文件内修改 = ApprovalMode::Write（写文件自动批、其余照问——
    //   approval.rs evaluate 的 Write 分支）；
    // - 完全访问 = Yolo（全部自动批，硬策略闸/双确认类除外）。
    // 审批卡经 approval_handler_via_ask 自动桥到 ask 面 = 宿主现有
    // AskRegistry → AskCards，无需新卡通道。

    /// 模式快照（切换钮初装 + 轮询；planPending 非空 = 有待审计划卡片）。
    pub fn mode_state(&self) -> Result<serde_json::Value, String> {
        let approval_mode = self.shared.approval.mode().as_str().to_string();
        let guard = self
            .shared
            .handle
            .lock()
            .map_err(|_| "pi handle mutex poisoned".to_string())?;
        let Some(handle) = guard.as_ref() else {
            return Ok(serde_json::json!({
                "approvalMode": approval_mode,
                "planMode": pi::plan::PlanMode::Off.as_str(),
                "planPending": serde_json::Value::Null,
            }));
        };
        let plan = handle.session().agent.plan_state();
        let pending = plan.pending_review().map(|r| r.text().to_string());
        Ok(serde_json::json!({
            "approvalMode": approval_mode,
            "planMode": plan.mode().as_str(),
            "planPending": pending,
        }))
    }

    /// 切工具审批模式（"always-ask" | "write" | "yolo"；未知值 Err——不猜）。
    /// 会话在场时按上游 CLI `/approval` 同款落审计条目（重放可见）。
    ///
    /// **持久化必须走 `save_and_index()`**（引擎统一的官方通道）：直接对
    /// store 调 `Session::save()` 会绕过 generation 协议，实测把 append 句柄
    /// 打进坏态——此后所有 flush 永败 `os error 1`（ERROR_INVALID_FUNCTION），
    /// 会话列表随之清空（2026-11-01 实锤，4 个会话集体消失）。条目只 append
    /// 不就地 save，落盘交给下方统一通道。
    pub fn set_approval_mode(&self, mode: &str) -> Result<(), String> {
        let m = match mode {
            "always-ask" => pi::approval::ApprovalMode::AlwaysAsk,
            "write" => pi::approval::ApprovalMode::Write,
            "yolo" => pi::approval::ApprovalMode::Yolo,
            other => return Err(format!("未知审批模式：{other}")),
        };
        self.shared.approval.set_mode(m);
        let shared = Arc::clone(&self.shared);
        on_big_stack(move || {
            shared.runtime.block_on(async {
                let cx = pi::agent_cx::AgentCx::for_request();
                let mut guard = shared
                    .handle
                    .lock()
                    .map_err(|_| "pi handle mutex poisoned".to_string())?;
                let Some(handle) = guard.as_mut() else {
                    return Ok(());
                };
                {
                    let agent_session = handle.session_mut();
                    let store = Arc::clone(&agent_session.session);
                    let mut inner = store
                        .lock(cx.cx())
                        .await
                        .map_err(|e| format!("session lock failed: {e}"))?;
                    inner.append_custom_entry(
                        "approval_mode".to_string(),
                        Some(serde_json::json!({ "mode": m.as_str() })),
                    );
                }
                handle
                    .session_mut()
                    .save_and_index()
                    .await
                    .map_err(|e| format!("审批模式审计条目落盘失败: {e}"))?;
                Ok(())
            })
        })?
    }

    /// 进入/退出计划模式（plan gate；会话忙时上游返回 PLAN_SESSION_BUSY，
    /// 错误原样传播给前端展示）。
    pub fn set_plan_mode(&self, enabled: bool) -> Result<(), String> {
        let shared = Arc::clone(&self.shared);
        on_big_stack(move || {
            shared.runtime.block_on(async {
                let cx = pi::agent_cx::AgentCx::for_request();
                let mut guard = shared
                    .handle
                    .lock()
                    .map_err(|_| "pi handle mutex poisoned".to_string())?;
                let handle = guard.as_mut().ok_or_else(|| "no active session".to_string())?;
                let change = if enabled {
                    handle
                        .enter_plan_mode(&cx)
                        .await
                        .map_err(|e| e.to_string())?
                } else {
                    handle.exit_plan_mode(&cx).await.map_err(|e| e.to_string())?
                };
                let _ = change;
                Ok(())
            })
        })?
    }

    /// 计划裁决（模型 submit_plan 后宿主批准/驳回；无待审计划 Err）。
    pub fn decide_plan(&self, approve: bool) -> Result<(), String> {
        let shared = Arc::clone(&self.shared);
        on_big_stack(move || {
            shared.runtime.block_on(async {
                let cx = pi::agent_cx::AgentCx::for_request();
                let mut guard = shared
                    .handle
                    .lock()
                    .map_err(|_| "pi handle mutex poisoned".to_string())?;
                let handle = guard.as_mut().ok_or_else(|| "no active session".to_string())?;
                let review = handle
                    .pending_plan_review()
                    .map_err(|e| e.to_string())?;
                let Some(review) = review else {
                    return Err("no pending plan review".to_string());
                };
                if approve {
                    handle
                        .approve_plan_review(&cx, &review)
                        .await
                        .map_err(|e| e.to_string())?;
                } else {
                    handle
                        .reject_plan_review(&cx, &review)
                        .await
                        .map_err(|e| e.to_string())?;
                }
                Ok(())
            })
        })?
    }

    /// 创建/打开进程内会话（provider/model 缺省读 ~/.pi settings；
    /// no_session:false = 会话持久化到 ~/.pi/agent/sessions 并自动进索引，
    /// 对话真相在 pi（§5）；session_path 打开历史会话时上游自动装填；
    /// working_directory = 会话工作区（SessionOptions.working_directory，
    /// sdk.rs:311——header.cwd 与项目本地配置加载都从它推导，前端
    /// 「选择工作区」入口经 pi_new_session 到此）。
    /// system_prompt = 会话系统提示（SessionOptions.system_prompt，
    /// sdk.rs:308——机器人预设的 pi 侧承载，pi_create_bot_session 传入；
    /// None 时 SessionOptions::default 同形，上游无缺省注入）。
    /// ui_bridge：扩展 UI 请求桥（§4.4 审批/问题卡）——None 时保持上游
    /// fail-closed（能力提示直接 deny）。
    /// 返回 "provider/model" 标识（仅供日志；消费方经 pi_get_state 结构化获取）。
    fn create_session_opts(
        &self,
        provider: Option<String>,
        model: Option<String>,
        system_prompt: Option<String>,
        ui_bridge: Option<UiBridgeHandle>,
        session_path: Option<std::path::PathBuf>,
        working_directory: Option<std::path::PathBuf>,
        bot_enabled_tools: Option<Vec<String>>,
    ) -> Result<String, String> {
        // 先 flush 旧会话（失败即中止——handle 未换、消息不丢，用户可重试；
        // 也避免 flush 失败后重试堆积空会话文件）
        self.flush_active_session()?;
        let shared = Arc::clone(&self.shared);
        // 个性（SOUL.md）注入：用户在「设置 → 个性」写的内容作为
        // append_system_prompt 拼在 pi 的内置系统提示之后（不覆盖内置——
        // 覆盖会丢掉工具使用契约，模型会开始"只说话不干活"）。
        //
        // 读失败必须传播（规矩 12）：用户以为个性生效了、实际没生效，
        // 比报错难查得多。文件不存在是正常态（从没打开过个性页）→ None。
        let persona_prompt = crate::pi_persona::persona_prompt_for_session()?;
        // 技能提示（2026-10-26）：pi 的 `SessionOptions.skills_prompt` 是
        // **宿主提供的字符串**——pi 自己不扫 skills 目录（`sdk.rs:399`；
        // ACP 路径同样由调用方渲染，`acp.rs:1825`）。所以"技能开关"只能
        // 在宿主侧实现：装载 → 按禁用集过滤 → 渲染 `<available_skills>`。
        let skills_prompt = crate::pi_capabilities::skills_prompt_for_session()?;
        // 工具集开关 → enabled_tools。bot 级显式传入优先（per-bot 能力面，
        // 2026-11-10：机器人预设的工具集选择经 pi_create_bot_session 传入）；
        // `None` = 走全局偏好，用户没动过任何开关时是 pi 默认集（升级加了
        // 新默认工具时能自动拿到）。
        let enabled_tools = match bot_enabled_tools {
            Some(tools) => Some(tools),
            None => crate::pi_capabilities::enabled_tools_for_session()?,
        };
        // 扩展（2026-11-02）：**照 pi CLI 的做法**取 ResourceLoader 的
        // 扩展集合（main.rs:2326 `extension_paths: resources.extensions()`）。
        // 宿主此前恒空——`pi::extensions` 的整套能力在宿主里等于不存在，
        // RPi 之类的社区插件装上跑不起来。发现失败必须传播（规矩 12）：
        // 静默吞成空列表会让用户以为插件生效了、实际没生效。
        //
        // cwd / 信任决定与 workspace_trusted 同源（同一个用户选择）。
        let workspace_trusted = working_directory.is_some();
        let extension_paths = {
            let cwd = working_directory
                .clone()
                .unwrap_or_else(|| std::env::current_dir().unwrap_or_default());
            crate::pi_extensions::resolve_extension_paths(&cwd, workspace_trusted)?
        };
        let options = SessionOptions {
            provider,
            model,
            // 机器人预设的系统提示（sdk.rs:308 SessionOptions.system_prompt）
            system_prompt,
            // 个性（SOUL.md）→ 追加段（sdk.rs:369 append_system_prompt）
            append_system_prompt: persona_prompt,
            // 技能目录（sdk.rs:399）——宿主渲染的 `<available_skills>` 块
            skills_prompt,
            // 工具集开关（sdk.rs:378）——None 保持 pi 默认
            enabled_tools,
            // 工具审批策略（sdk.rs「SessionOptions.approval_state」）：进程级
            // 共享态挂进会话——模式切换钮（mode-store）经 `set_mode` 即时生效。
            // 默认 AlwaysAsk（变更前确认）＝ ZCode build 的默认语义。
            // ApprovalState 内部全是 Arc 字段（Clone 便宜），直接给值。
            approval_state: Some((*Arc::clone(&self.shared.approval)).clone()),
            // 会话持久化（对话真相在 pi，§5）；session_path 打开历史会话时
            // 上游自动装填该文件。
            // 【2026-10-01 修复记录】此前 no_session:false 实测"flush 永败
            // os error 5"非本仓库问题——是 pi 上游 v0.5.x 的 generation
            // counter append-only 句柄 + LockFileEx 缺陷（gh #239，v0.6.0
            // 官方修复：open read + append）。已将同款修复打到本地
            // pi_agent_rust-main（session_index.rs note_session_namespace_
            // change），实测恢复后见下方冒烟记录。
            no_session: false,
            session_path,
            // 工作区信任决定（sdk.rs:312-315 上游注释：程序化调用方默认
            // fail-closed；CLI 宿主传 workspace_trust::establish 的决定）。
            // 本宿主的信任决定 = 用户在目录对话框里显式选了这个文件夹——
            // 有 working_directory 即 trusted；未选（cwd 继承进程目录）维持
            // 上游默认 false，项目本地配置不加载。
            workspace_trusted,
            working_directory,
            // 扩展路径（与 pi CLI 同源；见上方 resolve_extension_paths）
            extension_paths,
            // handler 仅在加载了扩展时被咨询；挂上桥后能力提示/扩展 UI
            // 请求经 CUSTOM 事件到前端卡片（§4.4）
            extension_ui_handler: ui_bridge.map(|h| {
                Arc::new(HostUiBridge { handle: h })
                    as Arc<dyn pi::sdk::ExtensionUiHandler>
            }),
            // §4.4 裁定：许可决定不写 ~/.pi/extension-permissions.json，
            // 全部会话级（决定权在 mirach）——"仅本次"按钮因此无意义
            persist_extension_permissions: false,
            ..SessionOptions::default()
        };
        let handle: AgentSessionHandle = on_big_stack(move || {
            shared.runtime.block_on(async { create_agent_session(options).await })
        })?
        .map_err(|e| e.to_string())?;
        let (provider, model_id) = handle.model();
        // ask 交互卡桥（docs/pi-coverage.md）：把 AskTool 的 picker 换成
        // channel UI——请求经 mpsc 流出，本任务登记到 asks 注册表 + 往
        // AG-UI 常驻流推 CUSTOM name=ask_request（只带 id 作信号，详情
        // 以注册表为真相——与审批卡片同款语义）。无 picker 时 AskTool 走
        // ask_policy 自动回答（默认 recommended），行为不变。
        if let Some(ask_tool) = handle.ask_tool() {
            let asks = Arc::clone(&self.shared.asks);
            let ask_for_task = ask_tool.clone();
            let (tx, mut rx) = asupersync::channel::mpsc::channel::<pi::ask::AskUiRequest>(8);
            ask_tool.install_channel_ui(tx);
            // PiRuntime 是 current_thread 运行时（无 spawn），故用独立
            // std 线程消费：每轮 block_on(rx.recv()) 等一条请求，登记到
            // 注册表（详情真相）——前端经 pi_ask_pending 拉取、经
            // pi_ask_response → AskTool::respond_ui 回灌。
            let runtime = self.shared.runtime.runtime;
            std::thread::Builder::new()
                .name("pi-ask-bridge".into())
                .spawn(move || {
                    loop {
                        let cx = pi::agent_cx::AgentCx::for_request();
                        let next = runtime.block_on(rx.recv(cx.cx()));
                        let Ok(req) = next else {
                            // 通道关闭（会话销毁 / picker 关闭）= 正常退出
                            break;
                        };
                        match serde_json::to_value(&req.request) {
                            Ok(v) => asks.register(req.id, v, ask_for_task.clone()),
                            Err(e) => eprintln!("[ask] 请求序列化失败: {e}"),
                        }
                    }
                })
                .map_err(|e| format!("ask bridge 线程启动失败: {e}"))?;
        }
        *self
            .shared
            .handle
            .lock()
            .map_err(|_| "pi handle mutex poisoned".to_string())? = Some(handle);
        // P1-3：会话切换成功后清理上一会话的挂起审批（防鬼影卡片）。
        // 失败路径不清理——此时旧会话仍在位，其审批仍有效。
        self.shared.approvals.cleanup();
        // ask 问题卡片同款清理（旧会话的 picker 已随会话销毁，卡片失效）
        self.shared.asks.cleanup();
        Ok(format!("{provider}/{model_id}"))
    }

    /// 新建（空）会话——替换 handle，后续消息历史/状态都指向新会话。
    pub fn create_session(
        &self,
        provider: Option<String>,
        model: Option<String>,
        ui_bridge: Option<UiBridgeHandle>,
    ) -> Result<String, String> {
        self.create_session_opts(provider, model, None, ui_bridge, None, None, None)
    }

    /// 在指定工作区新建（空）会话（前端「选择工作区」入口）：working_directory
    /// 透传 SessionOptions（header.cwd = 该目录，侧栏按工作区分组的数据源），
    /// workspace_trusted = true（用户显式选择 = 信任决定，见 create_session_opts
    /// 注释）。与 New Chat（discard 延迟建会话）不同——用户点名了工作区，
    /// 立即建会话文件。返回 "provider/model"。
    pub fn new_session_with_cwd(
        &self,
        cwd: &str,
        ui_bridge: Option<UiBridgeHandle>,
    ) -> Result<String, String> {
        self.create_session_opts(
            None,
            None,
            None,
            ui_bridge,
            None,
            Some(std::path::PathBuf::from(cwd)),
            None,
        )
    }

    /// 机器人预设会话（左栏「机器人」窗格启动钮）：system_prompt + model +
    /// working_directory 一次性给足（SessionOptions.system_prompt sdk.rs:308 /
    /// model :305 / working_directory :311）。enabled_tools = per-bot 工具集
    /// 选择（2026-11-10；None = 全局偏好/默认集）。workspace_trusted = 选了
    /// 工作区即信任（new_session_with_cwd 同款语义）。调用方
    /// （pi_create_bot_session）随后以 bot 名重命名该会话（rename_session
    /// 只作用当前会话——刚建即当前）。返回 "provider/model"。
    pub fn create_bot_session(
        &self,
        provider: Option<String>,
        model: Option<String>,
        system_prompt: Option<String>,
        cwd: Option<String>,
        enabled_tools: Option<Vec<String>>,
        ui_bridge: Option<UiBridgeHandle>,
    ) -> Result<String, String> {
        self.create_session_opts(
            provider,
            model,
            system_prompt,
            ui_bridge,
            None,
            cwd.map(std::path::PathBuf::from),
            enabled_tools,
        )
    }

    /// 确保有活跃会话：已有则原样复用（多轮对话上下文保持），
    /// 没有才创建——POST 路径按需创建的唯一入口。
    pub fn ensure_session(&self, ui_bridge: Option<UiBridgeHandle>) -> Result<(), String> {
        {
            let guard = self
                .shared
                .handle
                .lock()
                .map_err(|_| "pi handle mutex poisoned".to_string())?;
            if guard.is_some() {
                return Ok(());
            }
        }
        self.create_session(None, None, ui_bridge)?;
        Ok(())
    }

    /// 丢弃当前会话（New Chat 语义）：先 flush 落盘（消息进索引可再打开），
    /// 再清空 handle——下一次 POST 按需创建全新会话。
    pub fn discard_session(&self) -> Result<(), String> {
        self.flush_active_session()?;
        *self
            .shared
            .handle
            .lock()
            .map_err(|_| "pi handle mutex poisoned".to_string())? = None;
        // P1-3：会话已丢弃——挂起审批随之失效，清掉防鬼影卡片。
        self.shared.approvals.cleanup();
        Ok(())
    }

    /// 打开历史会话（session_path 指向 pi 会话文件）。
    pub fn open_session(
        &self,
        path: &str,
        ui_bridge: Option<UiBridgeHandle>,
    ) -> Result<String, String> {
        // 同路径子柄驱逐（v7.4 多柄）：工作区切换到某会话 → 该路径的分栏
        // 柄必须先 flush+移除（同一路径全引擎只能有一个柄——双柄双写同
        // jsonl = 追加交错损坏）。分栏侧的流连接由前端 unmount 关闭。
        {
            let mut map = self
                .side_engines
                .lock()
                .map_err(|_| "pi side engines mutex poisoned".to_string())?;
            let evict: Vec<String> = map
                .iter()
                .filter(|(_, se)| se.path == path)
                .map(|(k, _)| k.clone())
                .collect();
            for key in evict {
                if let Some(se) = map.remove(&key) {
                    let flush = se.handle.lock().map_err(|_| "pi side handle mutex poisoned".to_string());
                    match flush {
                        Ok(mut guard) => {
                            let _ = self
                                .shared
                                .runtime
                                .block_on(async { guard.session_mut().save_and_index().await });
                        }
                        Err(_) => return Err("pi side handle mutex poisoned".to_string()),
                    }
                }
            }
        }
        self.create_session_opts(
            None,
            None,
            None,
            ui_bridge,
            Some(std::path::PathBuf::from(path)),
            None,
            None,
        )
    }

    /// 当前会话的 fork 谱系：SessionHeader.parent_session（serde 名
    /// branchedFrom）——fork 子会话指向父会话文件路径；线性会话 = None。
    /// "no active session" 是前端认得的域态（branch-store 静默清投影）。
    pub fn session_lineage(&self) -> Result<Option<String>, String> {
        let shared = Arc::clone(&self.shared);
        on_big_stack(move || {
            let guard = shared
                .handle
                .lock()
                .map_err(|_| "pi handle mutex poisoned".to_string())?;
            let handle = guard
                .as_ref()
                .ok_or_else(|| "no active session".to_string())?;
            shared.runtime.block_on(async {
                // with_session 是 async + SDK PiResult；闭包直接返回
                // Option<String>（R=Option<String>），map_err 一层即得
                handle
                    .with_session(|s| s.header.parent_session.clone())
                    .await
                    .map_err(|e| format!("会话谱系读取失败: {e}"))
            })
        })
        // on_big_stack 自带 spawn/join 错误层（Result<T,String>）——闭包内层
        // 也是 Result，此处拍平（工程惯例，与 retry_edit/checkpoint 同款）
        .and_then(|inner| inner)
    }

    /// 替换 handle 前对旧会话显式 flush（save_and_index = 官方 pub 通道：
    /// flush_autosave(Periodic) + 进索引）。pi 的 SDK 路径没有 Periodic
    /// 驱动、Session 无 Drop flush——不显式 flush，切换/新建时未落盘的
    /// mutations 全部丢失（实测：会话文件只有 .lock，jsonl 空）。
    fn flush_active_session(&self) -> Result<(), String> {
        let shared = Arc::clone(&self.shared);
        on_big_stack(move || {
            let mut guard = shared
                .handle
                .lock()
                .map_err(|_| "pi handle mutex poisoned".to_string())?;
            let handle = match guard.as_mut() {
                Some(h) => h,
                None => return Ok(()), // 无会话即无事可刷（非兜底）
            };
            shared
                .runtime
                .block_on(async { handle.session_mut().save_and_index().await })
                .map_err(|e| format!("会话 flush 失败: {e}"))
        })?
    }

    // ── 会话分栏独立柄（v7.4 多柄并发）────────────────────────────────────
    // 每个分栏线程键一个 SideEngine：自己的柄/锁/abort 槽。分栏 prompt 只
    // 锁自己的柄——与主柄、与其他分栏**并行**（hermes 会话瓦片语义）。

    /// 取或建分栏柄（on_big_stack：create 深递归）。同线程键换绑不同路径
    /// → flush 旧柄后替换；同路径已开 → 幂等 Ok。同一路径全引擎唯一：
    /// 工作区 open_session 会驱逐同路径子柄。
    pub fn side_open(
        &self,
        thread: &str,
        path: &str,
        ui_bridge: UiBridgeHandle,
    ) -> Result<(), String> {
        let thread = thread.to_string();
        let path = path.to_string();
        let side_engines = Arc::clone(&self.side_engines);
        let shared_outer = Arc::clone(&self.shared);
        on_big_stack(move || {
            let mut map = side_engines
                .lock()
                .map_err(|_| "pi side engines mutex poisoned".to_string())?;
            // 旧柄检查：Arc 克隆出条目（不留 map 借用——flush 后要 remove）
            let existing = map.get(&thread).map(Arc::clone);
            match existing {
                Some(se) if se.path == path => return Ok(()), // 幂等：已按此路径打开
                Some(se) => {
                    // 换绑：flush 旧柄（落盘）后移除
                    let mut guard = se
                        .handle
                        .lock()
                        .map_err(|_| "pi side handle mutex poisoned".to_string())?;
                    let _ = shared_outer
                        .runtime
                        .block_on(async { guard.session_mut().save_and_index().await });
                    map.remove(&thread);
                }
                None => {}
            }
            let session_path = Some(std::path::PathBuf::from(&path));
            let options = SessionOptions {
                provider: None,
                model: None,
                system_prompt: None,
                extension_ui_handler: Some(Arc::new(HostUiBridge { handle: ui_bridge })
                    as Arc<dyn pi::sdk::ExtensionUiHandler>),
                no_session: false,
                session_path,
                workspace_trusted: false,
                working_directory: None,
                persist_extension_permissions: false,
                ..SessionOptions::default()
            };
            let handle: AgentSessionHandle = on_big_stack(move || {
                shared_outer.runtime.block_on(async { create_agent_session(options).await })
            })?
            .map_err(|e| e.to_string())?;
            map.insert(
                thread,
                Arc::new(SideEngine {
                    path,
                    handle: Mutex::new(handle),
                    abort: Mutex::new(None),
                    run_counter: AtomicU64::new(0),
                }),
            );
            Ok(())
        })?
    }

pub fn side_prompt(
        &self,
        thread: &str,
        text: &str,
        images: &[AguiImage],
        on_event: impl Fn(AgentEvent) + Send + Sync + 'static,
        on_start: Box<dyn FnOnce() + Send>,
    ) -> Result<(), String> {
        if asupersync::runtime::Runtime::current_handle().is_some() {
            return Err(
                "re-entrant prompt rejected: on_event 回调里禁止发起新 prompt（会死锁）".into(),
            );
        }
        let shared = Arc::clone(&self.shared);
        let side_engines = Arc::clone(&self.side_engines);
        let thread = thread.to_string();
        let text = text.to_string();
        let images = images.to_vec();
        on_big_stack(move || {
            let se = {
                let map = side_engines
                    .lock()
                    .map_err(|_| "pi side engines mutex poisoned".to_string())?;
                Arc::clone(map.get(&thread).ok_or("no side session for thread")?)
            };
            // 只锁自己柄（与其他分栏/主柄并行）；guard 持锁跨 block_on 同主柄语义
            let mut guard = se
                .handle
                .lock()
                .map_err(|_| "pi side handle mutex poisoned".to_string())?;
            let handle = &mut *guard;
            let run = se.run_counter.fetch_add(1, Ordering::SeqCst);
            let (abort_handle, abort_signal) = pi::sdk::AbortHandle::new();
            *se
                .abort
                .lock()
                .map_err(|_| "pi side abort mutex poisoned".to_string())? =
                Some(AbortSlot { run, handle: abort_handle });
            on_start();
            // 内容块组装：Text 在前、Image 随后（上游同序；mime 白名单在
            // POST 层校验过）
            let mut content = Vec::with_capacity(images.len() + 1);
            if !text.is_empty() {
                content.push(ContentBlock::Text(TextContent::new(text.clone())));
            }
            for img in &images {
                content.push(ContentBlock::Image(ImageContent {
                    data: img.data.clone(),
                    mime_type: img.mime_type.clone(),
                }));
            }
            let has_images = !images.is_empty();
            if has_images {
                shared
                    .runtime
                    .block_on(async { handle.sync_extension_mcp_registrations().await });
            }
            let result = shared.runtime.block_on(async move {
                if has_images {
                    let session = handle.session_mut();
                    session
                        .run_with_content_with_abort(content, Some(abort_signal), on_event)
                        .await
                } else {
                    handle
                        .prompt_with_abort(text, abort_signal, on_event)
                        .await
                }
            });
            // run 收尾 flush（per-handle save_and_index——分栏不切会话，
            // 不 flush 则本会话的流式消息永远不落盘/不进索引）
            let handle2 = &mut *guard;
            if let Err(e) = shared
                .runtime
                .block_on(async { handle2.session_mut().save_and_index().await })
            {
                let _ = e; // flush 失败不吞 run 结果——错误经下一次 flush 补救
            }
            result.map(|_| ()).map_err(|e| e.to_string())
        })?
    }

    /// 定向中断：thread 键下的分栏 run 置 abort（不打断主柄/其他分栏）。
    pub fn side_interrupt(&self, thread: &str) -> Result<(), String> {
        let map = self
            .side_engines
            .lock()
            .map_err(|_| "pi side engines mutex poisoned".to_string())?;
        let se = map.get(thread).ok_or("no side session for thread")?;
        let guard = se
            .abort
            .lock()
            .map_err(|_| "pi side abort mutex poisoned".to_string())?;
        match guard.as_ref() {
            Some(h) => {
                h.handle.abort();
                Ok(())
            }
            None => Err("no active run".into()),
        }
    }

    /// 列出会话（pi SessionIndex sqlite 索引，`~/.pi/agent/sessions/`）。
    /// 读前先 flush 当前会话——列表即新鲜真相（flush 是写副作用，注释
    /// 说明；pi autosave 无 Periodic 驱动，不 flush 则当前会话永远不在列）。
    /// 注：SessionIndex 是 pi 原生模块非 sdk re-export（同 auth/config
    /// 先例的最小例外）；SDK 无列举 API。SessionMeta 无 Serialize（上游
    /// 未派生）——手动映射，字段名对齐上游 snake_case。
    pub fn list_sessions(&self) -> Result<serde_json::Value, String> {
        self.flush_active_session()?;
        on_big_stack(move || {
            let index = pi::session_index::SessionIndex::new();
            let metas = index
                .list_sessions(None)
                .map_err(|e| format!("会话索引读取失败: {e}"))?;
            let rows: Vec<serde_json::Value> = metas
                .iter()
                .map(|m| {
                    serde_json::json!({
                        "path": m.path,
                        "id": m.id,
                        "cwd": m.cwd,
                        "timestamp": m.timestamp,
                        "messageCount": m.message_count,
                        "lastModifiedMs": m.last_modified_ms,
                        "sizeBytes": m.size_bytes,
                        "name": m.name,
                    })
                })
                .collect();
            Ok(serde_json::Value::Array(rows))
        })?
    }

    /// 每会话 tokens/cost 汇总（侧栏 rowMeta「Tokens/成本」数据源）。
    /// pi 官方面 = stats 模块（lib.rs:310 pub mod stats）：`aggregate` 逐行
    /// 流式解析会话 JSONL 的 assistant usage（有界内存），本命令对每个请求
    /// 的会话文件各跑一次单文件聚合。调用前先 flush 当前会话（list_sessions
    /// 同款：读面即新鲜真相）。返回 {path: {totalTokens, costUsd}}——
    /// 缺失/损坏的文件不静默跳过：aggregate 对坏行跳过是上游解析语义，
    /// 文件级读失败（aggregate 不报错）如实产出 0 值（stats 语义：没有
    /// 可入账条目），调用方的缓存键带 messageCount，文件变化会重取。
    pub fn sessions_usage(&self, paths: &[String]) -> Result<serde_json::Value, String> {
        self.flush_active_session()?;
        let paths = paths.to_vec();
        on_big_stack(move || {
            let mut out = serde_json::Map::new();
            for p in &paths {
                let report = pi::stats::aggregate(
                    &[std::path::PathBuf::from(p)],
                    &pi::stats::StatsFilter::default(),
                );
                out.insert(
                    p.clone(),
                    serde_json::json!({
                        "totalTokens": report.tokens.total,
                        "costUsd": report.cost.total,
                    }),
                );
            }
            Ok(serde_json::Value::Object(out))
        })?
    }

    /// 导出会话为独立 HTML 文档（hermes row.export 数据面的 pi 实现）。
    /// 上游能力：Session::to_html()（session.rs:5235 render_session_html），
    /// 非活跃会话可经 Session::open(path) 独立装载——不动活动 handle。
    /// 请求的是当前活动会话 → 走 export_snapshot()（轻量快照，上游注释
    /// 推荐的导出通道；flush 已在此前完成）；否则独立 open（strict 持久化
    /// 下磁盘即真相）。返回完整 HTML 文本；落盘由前端
    /// （save 对话框 + fs_write_text_file）负责。
    pub fn export_session_html(&self, path: &str) -> Result<String, String> {
        self.flush_active_session()?;
        let shared = Arc::clone(&self.shared);
        let path = path.to_string();
        on_big_stack(move || {
            // 活动会话路径比对（fork_session 同款 inner.path 读取；.await 的
            // 内层锁必须住在 block_on 里）。
            let is_active = {
                let mut guard = shared
                    .handle
                    .lock()
                    .map_err(|_| "pi handle mutex poisoned".to_string())?;
                match guard.as_mut() {
                    // 无活动会话 = 目标必非活动（域状态，不是错误）
                    None => false,
                    Some(handle) => {
                        shared.runtime.block_on(async {
                            let cx = pi::agent_cx::AgentCx::for_request();
                            let agent_session = handle.session_mut();
                            let store = Arc::clone(&agent_session.session);
                            let inner = store
                                .lock(cx.cx())
                                .await
                                .map_err(|e| format!("session lock failed: {e}"))?;
                            // 尾部显式标注（E0283：async 块的错误侧推不出来）
                            Ok::<bool, String>(inner
                                .path
                                .as_ref()
                                .map(|p| p.display().to_string())
                                .as_deref()
                                == Some(path.as_str()))
                        })?
                    }
                }
            };
            let html: String = if is_active {
                let mut guard = shared
                    .handle
                    .lock()
                    .map_err(|_| "pi handle mutex poisoned".to_string())?;
                let handle = guard
                    .as_mut()
                    .ok_or_else(|| "no active session".to_string())?;
                shared.runtime.block_on(async {
                    let cx = pi::agent_cx::AgentCx::for_request();
                    let agent_session = handle.session_mut();
                    let store = Arc::clone(&agent_session.session);
                    let inner = store
                        .lock(cx.cx())
                        .await
                        .map_err(|e| format!("session lock failed: {e}"))?;
                    Ok::<String, String>(inner.export_snapshot().to_html())
                })?
            } else {
                shared.runtime.block_on(async {
                    let session = pi::session::Session::open(&path)
                        .await
                        .map_err(|e| format!("会话文件打开失败: {e}"))?;
                    Ok::<String, String>(session.to_html())
                })?
            };
            Ok(html)
        })?
    }

    /// 重命名当前活跃会话（SDK 语义：set_session_name 只作用于当前会话；
    /// 非活跃会话重命名不被支持——错误即错误）。
    pub fn rename_session(&self, name: &str) -> Result<(), String> {
        let shared = Arc::clone(&self.shared);
        let name = name.to_string();
        on_big_stack(move || {
            let mut guard = shared
                .handle
                .lock()
                .map_err(|_| "pi handle mutex poisoned".to_string())?;
            let handle = guard.as_mut().ok_or("no active session")?;
            shared
                .runtime
                .block_on(handle.set_session_name(name))
                .map_err(|e| e.to_string())
        })?
    }

    /// 删除会话（pi 索引行 + 文件本体）。活跃会话拒绝删除——错误即错误。
    pub fn delete_session(&self, path: &str) -> Result<(), String> {
        // 活跃性判定：SessionMeta.id 与当前 state.sessionId 同源（上游索引），
        // 比对命中即活跃会话。
        let active_id = self.state()?["sessionId"]
            .as_str()
            .map(|s| s.to_string())
            .unwrap_or_default();
        let metas = self.list_sessions()?;
        let meta = metas
            .as_array()
            .and_then(|arr| arr.iter().find(|m| m["path"] == serde_json::json!(path)))
            .ok_or_else(|| format!("no session at {path}"))?;
        if !active_id.is_empty() && meta["id"] == serde_json::json!(active_id) {
            return Err("cannot delete the active session".into());
        }
        let path = path.to_string();
        on_big_stack(move || {
            let index = pi::session_index::SessionIndex::new();
            index
                .delete_session_path(std::path::Path::new(&path))
                .map_err(|e| format!("会话删除失败: {e}"))?;
            let file = std::path::Path::new(&path);
            if file.exists() {
                std::fs::remove_file(file).map_err(|e| format!("会话文件删除失败: {e}"))?;
            }
            Ok(())
        })?
    }

    // ── checkpoint / rewind / retry（pi::checkpoint pub 面；会话树
    //    append-only，编辑只作用于 active context。上游先例：rpc.rs 的
    //    checkpoint/rewind 命令与 interactive/perf.rs 的 /rewind——同一组
    //    API 的宿主集成形态）。
    //
    //    &mut Session 的获取路径：AgentSessionHandle::session_mut()
    //    （sdk.rs:2211 → &mut AgentSession）→ AgentSession.session（pub
    //    Arc<asupersync Mutex<Session>>，agent.rs:5413）→ Arc clone 后
    //    .lock(cx.cx()).await。Cx 经 AgentCx::for_request()（agent_cx
    //    pub 面，顶层请求入口的规范构造）。
    //
    //    时序约定：四个方法都要拿 handle mutex——prompt 在跑时（isRunning）
    //    会阻塞到该 run 结束（std Mutex 串行不变量），与所有 pi_* 控制面
    //    命令同款；前端负责先 pi_interrupt 再调用（pi_interrupt 本身不拿
    //    锁、只置 abort 信号，是唯一的例外）。调用前先 flush_active_session：
    //    树状态即新鲜真相（strict 持久化下近乎 no-op，保留以防模式回退）。──

    /// 编辑重跑准备（/retry 语义）：把 leaf 移到最后一个可重试 user turn
    /// 的父级。**本命令只准备分支**——重发由前端下一次 POST 完成（新 turn
    /// 落为兄弟分支，被放弃的 turn 及其回复保留在会话树里）。无可重试
    /// turn = 明确 Err。返回 {text, abandonedEntryId}（text 供前端回填
    /// composer 重发）。
    pub fn retry_edit(&self) -> Result<serde_json::Value, String> {
        self.flush_active_session()?;
        let shared = Arc::clone(&self.shared);
        on_big_stack(move || {
            let mut guard = shared
                .handle
                .lock()
                .map_err(|_| "pi handle mutex poisoned".to_string())?;
            let handle = guard.as_mut().ok_or("no active session")?;
            shared.runtime.block_on(async {
                let cx = pi::agent_cx::AgentCx::for_request();
                let agent_session = handle.session_mut();
                let store = Arc::clone(&agent_session.session);
                let preparation = {
                    let mut inner = store
                        .lock(cx.cx())
                        .await
                        .map_err(|e| format!("session lock failed: {e}"))?;
                    pi::checkpoint::prepare_retry_branch(&mut inner)
                };
                match preparation {
                    None => Err("no retryable user turn".to_string()),
                    Some(p) => {
                        agent_session
                            .persist_session()
                            .await
                            .map_err(|e| format!("会话持久化失败: {e}"))?;
                        Ok(serde_json::json!({
                            "text": p.text,
                            "abandonedEntryId": p.abandoned_entry_id,
                        }))
                    }
                }
            })
        })?
    }

    /// 在当前 leaf 打 checkpoint（label 空/缺省 = "checkpoint"）。返回完整
    /// checkpoint JSON（手工带 entryId——上游 Checkpoint.entry_id 是
    /// skip_serializing，序列化体里没有）。
    pub fn mark_checkpoint(&self, label: Option<String>) -> Result<serde_json::Value, String> {
        self.flush_active_session()?;
        let shared = Arc::clone(&self.shared);
        on_big_stack(move || {
            let mut guard = shared
                .handle
                .lock()
                .map_err(|_| "pi handle mutex poisoned".to_string())?;
            let handle = guard.as_mut().ok_or("no active session")?;
            shared.runtime.block_on(async {
                let cx = pi::agent_cx::AgentCx::for_request();
                let agent_session = handle.session_mut();
                // active_messages 快照（rewind 边界 = 打点时的活动消息数）；
                // rpc checkpoint 命令同款顺序：先取 agent.messages() 再锁
                // 内层会话树。
                let messages = agent_session.agent.messages().to_vec();
                let store = Arc::clone(&agent_session.session);
                let checkpoint = {
                    let mut inner = store
                        .lock(cx.cx())
                        .await
                        .map_err(|e| format!("session lock failed: {e}"))?;
                    pi::checkpoint::mark_checkpoint(
                        &mut inner,
                        label.as_deref().unwrap_or("checkpoint"),
                        None,
                        &messages,
                    )
                };
                agent_session
                    .persist_session()
                    .await
                    .map_err(|e| format!("会话持久化失败: {e}"))?;
                let mut value = serde_json::to_value(&checkpoint)
                    .map_err(|e| format!("checkpoint 序列化失败: {e}"))?;
                if let Some(id) = &checkpoint.entry_id {
                    value["entryId"] = serde_json::json!(id);
                }
                Ok(value)
            })
        })?
    }

    /// 列出当前会话活动路径上的 checkpoint。上游 checkpoint 模块只有按
    /// name 查找（find_checkpoint），无枚举 API——诚实实现：枚举活动路径
    /// 的 Custom "checkpoint" 条目（session.rs PathRebuildState 重放逻辑
    /// 同款形状）。data 缺失的条目跳过（上游 mark_checkpoint 序列化失败
    /// 会写 Null 死条目，find_checkpoint 的 `.ok()?` 同语义——该条目从未
    /// 可用）；data 存在但解析失败 = Err（错误即错误，不静默吞）。
    pub fn list_checkpoints(&self) -> Result<serde_json::Value, String> {
        self.flush_active_session()?;
        let shared = Arc::clone(&self.shared);
        on_big_stack(move || {
            let mut guard = shared
                .handle
                .lock()
                .map_err(|_| "pi handle mutex poisoned".to_string())?;
            let handle = guard.as_mut().ok_or("no active session")?;
            shared.runtime.block_on(async {
                let cx = pi::agent_cx::AgentCx::for_request();
                let agent_session = handle.session_mut();
                let store = Arc::clone(&agent_session.session);
                let inner = store
                    .lock(cx.cx())
                    .await
                    .map_err(|e| format!("session lock failed: {e}"))?;
                let mut rows: Vec<serde_json::Value> = Vec::new();
                for entry in inner.entries_for_current_path() {
                    let pi::session::SessionEntry::Custom(custom) = entry else {
                        continue;
                    };
                    if custom.custom_type != "checkpoint" {
                        continue;
                    }
                    let Some(data) = &custom.data else {
                        continue;
                    };
                    let mut checkpoint: pi::checkpoint::Checkpoint =
                        serde_json::from_value(data.clone()).map_err(|e| {
                            format!(
                                "checkpoint 条目损坏（entryId={:?}）: {e}",
                                custom.base.id.as_deref().unwrap_or("?")
                            )
                        })?;
                    checkpoint.entry_id.clone_from(&custom.base.id);
                    rows.push(serde_json::json!({
                        "entryId": checkpoint.entry_id,
                        "name": checkpoint.name,
                        "note": checkpoint.note,
                        "tokenEstimate": checkpoint.token_estimate,
                        "messageCount": checkpoint.message_count,
                        "atMs": checkpoint.at_ms,
                    }));
                }
                Ok(serde_json::Value::Array(rows))
            })
        })?
    }

    /// 待办状态（活动面板 Todo 分区拉取面，docs/engine-gaps.md G2 过渡方案）：
    /// 重放会话活动路径上的 Custom `todo_list.v1` 条目——与 pi 内部
    /// `todo::latest_from_entries` 同逻辑（枚举 Custom 条目、取最新一条
    /// 反序列化），**不需要上游暴露 Agent 上的 plan_state**。
    /// 真相在 pi 会话树（todo 工具每次变更 append 一条 Custom 条目）；
    /// 本方法只重放投影。返回 `{schema, list, summary}`（无 todo 时
    /// schema=null + list 空 + summary=null——诚实空态，不编造）。
    /// 损坏条目：`latest_from_entries` 的 `.ok()` 语义 = 跳过（上游同款——
    /// 坏条目从未可用）。
    pub fn todo_state(&self) -> Result<serde_json::Value, String> {
        self.flush_active_session()?;
        let shared = Arc::clone(&self.shared);
        on_big_stack(move || {
            let mut guard = shared
                .handle
                .lock()
                .map_err(|_| "pi handle mutex poisoned".to_string())?;
            let handle = guard.as_mut().ok_or("no active session")?;
            shared.runtime.block_on(async {
                let cx = pi::agent_cx::AgentCx::for_request();
                let agent_session = handle.session_mut();
                let store = Arc::clone(&agent_session.session);
                let inner = store
                    .lock(cx.cx())
                    .await
                    .map_err(|e| format!("session lock failed: {e}"))?;
                let entries = inner.entries_for_current_path();
                let has_todo = entries.iter().any(|e| {
                    matches!(e, pi::session::SessionEntry::Custom(c)
                        if c.custom_type == pi::todo::TODO_LIST_SCHEMA)
                });
                let list = pi::todo::latest_from_entries(entries.iter().copied());
                let summary = list.summary_line();
                let list_val = if has_todo {
                    serde_json::to_value(&list)
                        .map_err(|e| format!("todo 状态序列化失败: {e}"))?
                } else {
                    // 无 todo 条目 = 诚实空态（区分"没建过"与"建过空的"）
                    serde_json::Value::Null
                };
                Ok(serde_json::json!({
                    "schema": if has_todo { Some(pi::todo::TODO_LIST_SCHEMA) } else { None },
                    "list": list_val,
                    "summary": summary,
                }))
            })
        })?
    }

    /// 终止一个子代理（活动面板 Agent 分区 Stop 按钮，docs/engine-gaps.md
    /// G5）：`agent_hub::registry().mark_killed(id)`——与模型调 `hub agent
    /// kill` 同一操作（tools.rs dispatch_agent "kill"）。id 不存在 → Err
    /// （不静默成功）。registry 是进程级单例，锁中毒 = Err 传播。
    pub fn hub_kill(&self, agent_id: &str) -> Result<serde_json::Value, String> {
        let mut registry = pi::agent_hub::registry()
            .lock()
            .map_err(|_| "agent_hub registry mutex poisoned".to_string())?;
        if registry.get(agent_id).is_none() {
            return Err(format!("no subagent with id '{agent_id}'"));
        }
        registry.mark_killed(agent_id);
        let entry = registry
            .get(agent_id)
            .ok_or_else(|| format!("subagent '{agent_id}' 消失于终止后"))?;
        serde_json::to_value(entry).map_err(|e| format!("子代理条目序列化失败: {e}"))
    }

    /// 取消一个后台 bash 任务（活动面板 Terminal 分区 Stop 按钮，G5）：
    /// `jobs::cancel_async(ownerSessionId, id)`——等结算（上限 10s，pi 内部
    /// 超时即 Err，不假装成功）。owner session id 从活动会话取；无活动
    /// 会话 = Err（任务无从归属）。
    pub fn job_cancel(&self, job_id: &str) -> Result<serde_json::Value, String> {
        let shared = Arc::clone(&self.shared);
        let session_id = on_big_stack({
            let shared = Arc::clone(&shared);
            move || {
                let mut guard = shared
                    .handle
                    .lock()
                    .map_err(|_| "pi handle mutex poisoned".to_string())?;
                let handle = guard.as_mut().ok_or("no active session")?;
                shared
                    .runtime
                    .block_on(handle.state())
                    .map_err(|e| e.to_string())
            }
        })??.session_id;
        let owner = session_id
            .filter(|s| !s.is_empty())
            .ok_or("no active session（后台任务无从归属）")?;
        let snapshot = shared
            .runtime
            .block_on(pi::jobs::cancel_async(&owner, job_id))
            .map_err(|e| format!("后台任务取消失败: {e}"))?;
        serde_json::to_value(snapshot).map_err(|e| format!("任务快照序列化失败: {e}"))
    }

    /// 手动压缩（docs/pi-coverage.md 缺口：pi 有 `compact` 能力但宿主无入口）。
    /// 调 `AgentSessionHandle::compact(on_event)`：pi 内部执行一次压缩并实时
    /// 回调 AgentEvent——本方法把事件**丢弃**（压缩进度已由常驻 AG-UI 流经
    /// CUSTOM name=compaction 到达前端，这里再发就是重复）。返回压缩是否
    /// 触发（`compact` 内部在不可压缩时也会正常返回——不假装压缩了东西）。
    pub fn compact(&self) -> Result<serde_json::Value, String> {
        let shared = Arc::clone(&self.shared);
        on_big_stack(move || {
            let mut guard = shared
                .handle
                .lock()
                .map_err(|_| "pi handle mutex poisoned".to_string())?;
            let handle = guard.as_mut().ok_or("no active session")?;
            shared
                .runtime
                .block_on(handle.compact(|_event| {
                    // 事件走常驻流（AG-UI 缓冲），此处无需转发；丢弃是
                    // 有意为之（避免重复通道，§0.2-1 通道归零）。
                }))
                .map_err(|e| format!("手动压缩失败: {e}"))?;
            Ok(serde_json::json!({ "ok": true }))
        })?
    }

    /// 子代理 transcript（活动面板 TaskCard 展开）：`agent_hub::registry()
    /// .transcript_page(id)`——子进程逐帧写出的 JSONL 片段（已脱敏）。
    /// 未知 id = Err（不返回空串冒充"还没输出"）。
    pub fn hub_transcript(&self, agent_id: &str) -> Result<serde_json::Value, String> {
        let registry = pi::agent_hub::registry()
            .lock()
            .map_err(|_| "agent_hub registry mutex poisoned".to_string())?;
        let page = registry
            .transcript_page(agent_id)
            .map_err(|e| e.to_string())?;
        Ok(serde_json::json!({ "id": agent_id, "transcript": page }))
    }

    /// 给子代理发消息（steer / bus send）：`registry.steer(id, from, body)`。
    /// 返回 BusMessage（含 seq/from/to/body/sentMs）。
    pub fn hub_send(&self, agent_id: &str, body: &str) -> Result<serde_json::Value, String> {
        let mut registry = pi::agent_hub::registry()
            .lock()
            .map_err(|_| "agent_hub registry mutex poisoned".to_string())?;
        let msg = registry
            .steer(agent_id, "host", body)
            .map_err(|e| e.to_string())?;
        serde_json::to_value(msg).map_err(|e| format!("消息序列化失败: {e}"))
    }

    /// 子代理收到的消息（operator→child 的 inbox）。
    pub fn hub_inbox(&self, agent_id: &str) -> Result<serde_json::Value, String> {
        let registry = pi::agent_hub::registry()
            .lock()
            .map_err(|_| "agent_hub registry mutex poisoned".to_string())?;
        let msgs = registry.inbox(agent_id);
        serde_json::to_value(msgs).map_err(|e| format!("inbox 序列化失败: {e}"))
    }

    /// 撤销 / 重做（docs/pi-coverage.md 缺口 G7）：pi 的会话级
    /// `FileMutationRecorder`（`create_agent_session` 默认路径已挂，
    /// `ToolRegistry::with_mutation_recorder`）记录每次文件写入前的快照。
    /// `kind` = "undo" | "redo"；`n` = 步数（≥1）；`force` = 有冲突时是否
    /// 强制覆盖（pi 语义：false 时冲突单元跳过并在 outcome 里报告）。
    /// 返回 `UndoOutcome` JSON（restored/applied/skipped/...），前端据此
    /// 显示结果——**不假装成功**（outcome 里 skipped > 0 是真实情况）。
    pub fn undo_redo(
        &self,
        kind: &str,
        n: usize,
        force: bool,
    ) -> Result<serde_json::Value, String> {
        if kind != "undo" && kind != "redo" {
            return Err(format!("undo_redo: kind 必须是 undo/redo（收到 {kind}）"));
        }
        if n == 0 {
            return Err("undo_redo: n 必须 >= 1".to_string());
        }
        let shared = Arc::clone(&self.shared);
        let kind = kind.to_string();
        on_big_stack(move || {
            let mut guard = shared
                .handle
                .lock()
                .map_err(|_| "pi handle mutex poisoned".to_string())?;
            let handle = guard.as_mut().ok_or("no active session")?;
            let agent_session = handle.session_mut();
            let recorder = agent_session.agent.mutation_recorder().ok_or(
                "本会话没有 mutation recorder（undo/redo 不可用）",
            )?;
            let outcome = if kind == "undo" {
                recorder.undo(n, force)
            } else {
                recorder.redo(n, force)
            };
            serde_json::to_value(&outcome).map_err(|e| format!("undo outcome 序列化失败: {e}"))
        })?
    }

    /// 撤销历史（前端显示"可撤销 N 步"）：`FileMutationRecorder::history()`
    /// → `UnitSummary[]`。无 recorder = 空数组（诚实空态）。
    pub fn undo_history(&self) -> Result<serde_json::Value, String> {
        let shared = Arc::clone(&self.shared);
        on_big_stack(move || {
            let mut guard = shared
                .handle
                .lock()
                .map_err(|_| "pi handle mutex poisoned".to_string())?;
            let handle = guard.as_mut().ok_or("no active session")?;
            let agent_session = handle.session_mut();
            let Some(recorder) = agent_session.agent.mutation_recorder() else {
                return Ok(serde_json::Value::Array(vec![]));
            };
            let history = recorder.history();
            let stats = recorder.stats();
            Ok(serde_json::json!({
                "units": history,
                "stats": stats,
            }))
        })?
    }

    /// 回退到 checkpoint：active context 截断到该 checkpoint 边界（内部
    /// 对齐到 user-turn 起点，防 trailing tool_use 悬空），checkpoint 之后
    /// 的 span 折叠为一条摘要报告消息；会话树完整保留（append-only，
    /// 重启重放按 rewind 条目的 checkpointEntryId 复原折叠）。返回
    /// RewindOutcome JSON（collapsedMessages/summary/summaryTokensEstimate/...）。
    /// checkpointId = checkpoint **名称**（pi find_checkpoint 的匹配键：
    /// 反向扫活动路径取最新同名；entryId 不是查找键——上游 CLI/rpc 同为
    /// name 语义）。
    /// 摘要失败 = Err 传播（mirach 兜底禁令；上游 rpc 在此降级为
    /// "(summarization failed…)" 文本注记，我们不降级——回退半途而废比
    /// 明确失败更糟）。
    pub fn rewind(&self, checkpoint_id: &str) -> Result<serde_json::Value, String> {        self.flush_active_session()?;
        let shared = Arc::clone(&self.shared);
        let checkpoint_id = checkpoint_id.to_string();
        on_big_stack(move || {
            let mut guard = shared
                .handle
                .lock()
                .map_err(|_| "pi handle mutex poisoned".to_string())?;
            let handle = guard.as_mut().ok_or("no active session")?;
            shared.runtime.block_on(async {
                let cx = pi::agent_cx::AgentCx::for_request();
                let agent_session = handle.session_mut();
                let store = Arc::clone(&agent_session.session);
                let checkpoint = {
                    let inner = store
                        .lock(cx.cx())
                        .await
                        .map_err(|e| format!("session lock failed: {e}"))?;
                    pi::checkpoint::find_checkpoint(&inner, Some(&checkpoint_id))
                        .ok_or_else(|| format!("no checkpoint named '{checkpoint_id}'"))?
                };
                // 与 rpc rewind 同流程：span 快照 → summarize → 截断。
                let messages = agent_session.agent.messages().to_vec();
                let span: Vec<pi::model::Message> =
                    messages[checkpoint.message_count.min(messages.len())..].to_vec();
                if span.is_empty() {
                    // 与 rpc rewind 同款诚实结果：上下文已在该 checkpoint，
                    // 无事可做（不是错误，也不假装折叠了东西）。
                    return Ok(serde_json::json!({
                        "checkpoint": checkpoint.name,
                        "collapsedMessages": 0,
                        "note": "active context already at checkpoint",
                    }));
                }
                let provider = agent_session.agent.provider();
                // pi 0.8.0：summarize_span 第三参从 &api_key 变为 &StreamOptions
                // （秘钥筛选覆盖整个 provider 请求），并新增第五参
                // &CompactionPrivacy（写法照抄上游 sdk.rs rewind 路径）。
                let privacy = agent_session.agent.compaction_privacy();
                let summary = pi::checkpoint::summarize_span(
                    &span,
                    provider,
                    agent_session.agent.stream_options(),
                    agent_session.compaction_settings(),
                    &privacy,
                )
                .await
                .map_err(|e| format!("rewind 摘要失败: {e}"))?;
                let outcome = pi::checkpoint::apply_rewind_to_active(
                    &mut agent_session.agent,
                    &checkpoint,
                    summary,
                );
                // 持久化 rewind 条目：重启重放的折叠依据（session.rs
                // PathRebuildState.apply_rewind 按 checkpointEntryId 复原）。
                {
                    let mut inner = store
                        .lock(cx.cx())
                        .await
                        .map_err(|e| format!("session lock failed: {e}"))?;
                    let payload = serde_json::to_value(&outcome)
                        .map_err(|e| format!("rewind outcome 序列化失败: {e}"))?;
                    inner.append_custom_entry("rewind".to_string(), Some(payload));
                }
                agent_session
                    .persist_session()
                    .await
                    .map_err(|e| format!("会话持久化失败: {e}"))?;
                serde_json::to_value(&outcome)
                    .map_err(|e| format!("rewind outcome 序列化失败: {e}"))
            })
        })?
    }


    // ── 会话 fork / 分支导航（pi Session 树原生能力。上游先例：rpc.rs 的
    //    fork / get_fork_messages 命令与 interactive/tree_ui.rs 的
    //    stage_and_commit_tree_navigation——**Session 是 durable authority，
    //    Agent 只是内存投影**（rpc.rs:303-308）：改会话历史必须落 Session
    //    并持久化，Agent 消息面靠 replace_messages 重投影；只改 Agent 的
    //    历史会被下一次 run 前的重水合冲掉）。──
    //
    //    &mut Session 的获取路径与上一批 checkpoint 命令同款：session_mut()
    //    → AgentSession.session（pub Arc<asupersync Mutex<Session>>）→
    //    Arc clone 后 .lock(cx.cx()).await。
    //
    //    run 进行中的 fork/switch 一律拒绝（reject_if_run_in_progress，
    //    对齐上游 rpc fork 的 session transition blocker 语义：流式期间
    //    拒绝结构性会话切换）；读命令（fork 点清单/兄弟分支）与全部既有
    //    控制面命令一样串行等锁。判定源 = abort 槽位（prompt 拿到 handle
    //    锁后登记、PromptGuard 收尾清除——非 None 即有 run 在跑；排队未
    //    起跑的 run 不占槽位，随后被 handle 锁自然串行）。──

    /// run 进行中 → Err（fork/switch 专用前置）。
    fn reject_if_run_in_progress(&self) -> Result<(), String> {
        let guard = self
            .shared
            .abort
            .lock()
            .map_err(|_| "pi abort mutex poisoned".to_string())?;
        if guard.is_some() {
            return Err(
                "run in progress: interrupt the active run before forking/switching the session"
                    .into(),
            );
        }
        Ok(())
    }

    /// 从指定 user 消息 fork 新会话（上游 rpc fork 语义，rpc.rs:4306-4503）：
    /// 新会话的叶 = 选中消息的**父级**（选中的 user 消息不进新文件——前端
    /// 把 selectedText 预填 composer 重新提交，新 turn 即落为兄弟分支）；
    /// entries 复制到父级为止。header 克隆 provider/model_id/thinking_level
    /// 三项 + branchedFrom 指回源文件（rpc.rs:4343-4356 同款直写）。
    /// 新文件落盘后**复用 open_session 链换装**（create_session_opts：
    /// flush 旧会话 → create_agent_session(session_path=新文件) → 换
    /// handle → 挂起审批清理）——AG-UI/侧栏切换全现成，前端随后重拉
    /// pi_get_messages 水合新会话。返回 {path, sessionId, selectedText}；
    /// sessionId = 新会话 header.id（与 pi_list_sessions 的 id 同源——索引
    /// 行 id 即文件 header id）。
    pub fn fork_session(
        &self,
        entry_id: &str,
        ui_bridge: Option<UiBridgeHandle>,
    ) -> Result<serde_json::Value, String> {
        self.reject_if_run_in_progress()?;
        self.flush_active_session()?;
        let shared = Arc::clone(&self.shared);
        let entry_id = entry_id.to_string();
        // Phase 1+2 在一个大栈闭包内完成（fork 计划/条目数据不出线程，
        // 免去 pi 数据结构跨线程 Send 的耦合）；handle 锁在 Phase 1 块尾
        // 释放，Phase 2 无锁（上游 rpc 同构：Phase 2 注释 "without holding
        // any lock"）。
        let (path, session_id, selected_text) = on_big_stack(move || {
            let (fork_plan, source_path, session_dir, header) = {
                let mut guard = shared
                    .handle
                    .lock()
                    .map_err(|_| "pi handle mutex poisoned".to_string())?;
                let handle = guard.as_mut().ok_or("no active session")?;
                shared.runtime.block_on(async {
                    let cx = pi::agent_cx::AgentCx::for_request();
                    let agent_session = handle.session_mut();
                    let store = Arc::clone(&agent_session.session);
                    let inner = store
                        .lock(cx.cx())
                        .await
                        .map_err(|e| format!("session lock failed: {e}"))?;
                    let plan = inner
                        .plan_fork_from_user_message(&entry_id)
                        .map_err(|e| format!("fork 计划失败: {e}"))?;
                    let source_path = inner.path.as_ref().map(|p| p.display().to_string());
                    let session_dir = inner.session_dir.clone();
                    let header = inner.header.clone();
                    Ok::<_, String>((plan, source_path, session_dir, header))
                })?
            };
            let selected_text = fork_plan.selected_text.clone();
            let mut new_session = pi::session::Session::create_with_dir(session_dir);
            new_session.header.parent_session = source_path;
            new_session.header.provider.clone_from(&header.provider);
            new_session.header.model_id.clone_from(&header.model_id);
            new_session
                .header
                .thinking_level
                .clone_from(&header.thinking_level);
            new_session.init_from_fork_plan(fork_plan);
            let session_id = new_session.header.id.clone();
            shared
                .runtime
                .block_on(new_session.save())
                .map_err(|e| format!("fork 会话保存失败: {e}"))?;
            // save() 成功后 path 必已赋值（save_inner 对 path=None 的会话
            // 先建文件名再写盘）；None = 内部不变量被破坏，明确报错不兜底。
            let path = new_session
                .path
                .as_ref()
                .map(|p| p.display().to_string())
                .ok_or_else(|| "fork 会话保存成功但没有文件路径".to_string())?;
            // 尾部显式标注（E0283：on_big_stack 只约束 T: Send，闭包
            // 返回的 Result 错误侧推不出来）。
            Ok::<(String, String, String), String>((path, session_id, selected_text))
        })??;
        // Phase 3：复用 open_session 链换装（内部再 flush 一次源会话——
        // Phase 1 后无新 mutations，strict 持久化下近似 no-op）。
        self.open_session(&path, ui_bridge)?;
        Ok(serde_json::json!({
            "path": path,
            "sessionId": session_id,
            "selectedText": selected_text,
        }))
    }

    /// 枚举当前活动路径上的 user 消息（fork 点清单；上游 get_fork_messages
    /// 语义照抄——fork_messages_from_entries + extract_user_text，
    /// rpc.rs:12317-12349：entryId 缺失给空串、text 取首个 Text 块）。
    pub fn get_fork_points(&self) -> Result<serde_json::Value, String> {
        self.flush_active_session()?;
        let shared = Arc::clone(&self.shared);
        on_big_stack(move || {
            let mut guard = shared
                .handle
                .lock()
                .map_err(|_| "pi handle mutex poisoned".to_string())?;
            let handle = guard.as_mut().ok_or("no active session")?;
            shared.runtime.block_on(async {
                let cx = pi::agent_cx::AgentCx::for_request();
                let agent_session = handle.session_mut();
                let store = Arc::clone(&agent_session.session);
                let inner = store
                    .lock(cx.cx())
                    .await
                    .map_err(|e| format!("session lock failed: {e}"))?;
                Ok(serde_json::Value::Array(fork_points_json(&inner)))
            })
        })?
    }

    /// 最近分叉点的兄弟分支（上游 Session::sibling_branches 序列化）。
    /// 无分叉 → null；有 → {forkPointId（根分叉点为 null）, branches:
    /// [{rootId, leafId, preview, messageCount, isCurrent}]}。SiblingBranch
    /// 无 Serialize（上游未派生）——手工映射，字段 camelCase。
    pub fn list_sibling_branches(&self) -> Result<serde_json::Value, String> {
        self.flush_active_session()?;
        let shared = Arc::clone(&self.shared);
        on_big_stack(move || {
            let mut guard = shared
                .handle
                .lock()
                .map_err(|_| "pi handle mutex poisoned".to_string())?;
            let handle = guard.as_mut().ok_or("no active session")?;
            shared.runtime.block_on(async {
                let cx = pi::agent_cx::AgentCx::for_request();
                let agent_session = handle.session_mut();
                let store = Arc::clone(&agent_session.session);
                let inner = store
                    .lock(cx.cx())
                    .await
                    .map_err(|e| format!("session lock failed: {e}"))?;
                Ok(sibling_branches_json(&inner))
            })
        })?
    }

    /// 切换到指定叶（分支导航；interactive/tree_ui.rs:58-146
    /// stage_and_commit_tree_navigation 配方：候选克隆 → navigate_to →
    /// save → to_messages_for_current_path → *live = candidate 原子换回 →
    /// agent.replace_messages 重投影 → persist_session）。候选落盘失败时
    /// 活动会话原地不动（上游同语义："the active in-memory session was
    /// left unchanged"）。返回 {leafId}；前端之后重拉 pi_get_messages
    /// 重水合当前分支。
    pub fn switch_branch(&self, leaf_id: &str) -> Result<serde_json::Value, String> {
        self.reject_if_run_in_progress()?;
        self.flush_active_session()?;
        let shared = Arc::clone(&self.shared);
        let leaf_id = leaf_id.to_string();
        on_big_stack(move || {
            let mut guard = shared
                .handle
                .lock()
                .map_err(|_| "pi handle mutex poisoned".to_string())?;
            let handle = guard.as_mut().ok_or("no active session")?;
            shared.runtime.block_on(async {
                let cx = pi::agent_cx::AgentCx::for_request();
                let agent_session = handle.session_mut();
                let store = Arc::clone(&agent_session.session);
                let mut inner = store
                    .lock(cx.cx())
                    .await
                    .map_err(|e| format!("session lock failed: {e}"))?;
                let mut candidate = inner.clone();
                if !candidate.navigate_to(&leaf_id) {
                    return Err(format!("branch leaf not found: {leaf_id}"));
                }
                candidate
                    .save()
                    .await
                    .map_err(|e| format!("分支切换保存失败: {e}"))?;
                let messages = candidate.to_messages_for_current_path();
                *inner = candidate;
                drop(inner);
                // Agent 只是投影：历史真相已落 Session，这里重投影内存面。
                agent_session.agent.replace_messages(messages);
                agent_session
                    .persist_session()
                    .await
                    .map_err(|e| format!("会话持久化失败: {e}"))?;
                Ok(serde_json::json!({ "leafId": leaf_id }))
            })
        })?
    }

    /// 发送一条 prompt（SDK 二参签名：text + on_event；Mutex 串行）。
    /// prompt_with_content 的 Text-only 特例——同一把锁/同一套 on_start
    /// RUN_STARTED 推送/同一套 AbortSlot 语义（内核 prompt_inner 共用）。
    /// on_start：拿到 handle mutex 之后、起跑前调用的回调（P1-2——POST
    /// 的 RUN_STARTED 经它推送，排队 run 不再提前入缓冲制造 §0.3-1 的
    /// 协议违例序列）。
    /// abort 句柄在拿到锁之后才登记（P1-2——此前拿锁前写入全局单槽：
    /// 并发 prompt 时 interrupt 错杀排队 run、guard 清场抹掉后者句柄）；
    /// PromptGuard 清场按 run 代号身份比对。
    pub fn prompt(
        &self,
        text: &str,
        on_event: impl Fn(AgentEvent) + Send + Sync + 'static,
        on_start: Box<dyn FnOnce() + Send>,
    ) -> Result<(), String> {
        self.prompt_with_content(text, &[], on_event, on_start)
    }

    /// 发送一条带内容块的 prompt（文本 + 图片；图片端到端）。空 images =
    /// 纯文本（与 prompt(text) 走完全相同的 SDK 包装路径）。重入防护、
    /// run 代号、PromptGuard 与 prompt 同源——公共内核 prompt_inner。
    pub fn prompt_with_content(
        &self,
        text: &str,
        images: &[AguiImage],
        on_event: impl Fn(AgentEvent) + Send + Sync + 'static,
        on_start: Box<dyn FnOnce() + Send>,
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
        let run = self.shared.run_counter.fetch_add(1, Ordering::SeqCst);
        let _guard = PromptGuard {
            abort: &self.shared.abort,
            run,
        };
        // 内容块组装：Text 在前、Image 随后（上游 build_content_blocks_for_input
        // 同序）。mime 白名单在 POST 层校验（400 拒绝），这里只组装。
        let mut content = Vec::with_capacity(images.len() + 1);
        if !text.is_empty() {
            content.push(ContentBlock::Text(TextContent::new(text)));
        }
        for img in images {
            content.push(ContentBlock::Image(ImageContent {
                data: img.data.clone(),
                mime_type: img.mime_type.clone(),
            }));
        }
        self.prompt_inner(content, text.to_string(), on_event, on_start, run)
    }

    fn prompt_inner(
        &self,
        content: Vec<ContentBlock>,
        text: String,
        on_event: impl Fn(AgentEvent) + Send + Sync + 'static,
        on_start: Box<dyn FnOnce() + Send>,
        run: u64,
    ) -> Result<(), String> {
        let shared = Arc::clone(&self.shared);
        on_big_stack(move || {
            // 锁在大栈线程内拿并跨 block_on 持有——MutexGuard 不出线程，
            // 串行不变量靠 std Mutex 保证（其他 prompt 调用在此排队）。
            let mut guard = shared
                .handle
                .lock()
                .map_err(|_| "pi handle mutex poisoned".to_string())?;
            let handle = guard.as_mut().ok_or("no active session")?;
            // P1-2：拿到锁之后才登记 abort；登记先于 on_start——前端看到
            // RUN_STARTED 时 interrupt 已可用。run 代号保证 guard 清场只清
            // 自己这次的槽位。
            let (abort_handle, abort_signal) = pi::sdk::AbortHandle::new();
            *shared
                .abort
                .lock()
                .map_err(|_| "pi abort mutex poisoned".to_string())? =
                Some(AbortSlot { run, handle: abort_handle });
            // P1-2：启动信号（RUN_STARTED 等）在真正起跑前才发出。
            on_start();
            // 纯文本走 SDK prompt_with_abort（make_combined_callback 的扩展
            // 事件合并扇出 + retry 策略语义完整保留，与历史路径逐字节一致）；
            // 带图走 session_mut() 直达 AgentSession::run_with_content_with_
            // abort（abort 变体）——上游 SDK 没有内容块 prompt 包装
            // （make_combined_callback 是 sdk 私有），带图路径的 message_*/
            // tool_execution_* 扩展观察扇出缺席，与 ACP 等 AgentSession 直连
            // 宿主同款取舍（agent.rs:12493 上游注释明示该形态是受支持的宿主
            // 用法）；retry 策略本引擎未配置（SessionOptions 默认 None），
            // apply_retry_policy 跳过无策略差异。
            let has_images = content
                .iter()
                .any(|b| matches!(b, ContentBlock::Image(_)));
            let result = shared.runtime.block_on(async move {
                if has_images {
                    // 与 SDK prompt_with_abort 同序：先同步扩展 MCP 注册，再起跑
                    handle.sync_extension_mcp_registrations().await;
                    let session = handle.session_mut();
                    session
                        .run_with_content_with_abort(content, Some(abort_signal), on_event)
                        .await
                } else {
                    handle
                        .prompt_with_abort(text, abort_signal, on_event)
                        .await
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
                h.handle.abort();
                Ok(())
            }
            None => Err("no active run".into()),
        }
    }

    /// 会话状态快照（session_id/provider/model/thinking/message_count）。
    pub fn state(&self) -> Result<serde_json::Value, String> {
        let shared = Arc::clone(&self.shared);
        on_big_stack(move || {
            let mut guard = shared
                .handle
                .lock()
                .map_err(|_| "pi handle mutex poisoned".to_string())?;
            let handle = guard.as_mut().ok_or("no active session")?;
            // 扩展是否真的注册进了**这个**会话（`sdk.rs:2466` pub const
            // fn has_extensions = session.extensions.is_some()）。
            // `pi_extensions` 只证明"发现到了什么"，不证明"会话加载了什么"
            // ——两者的差别正是本字段存在的理由。
            let has_extensions = handle.has_extensions();
            let state = shared
                .runtime
                .block_on(handle.state())
                .map_err(|e| e.to_string())?;
            Ok(serde_json::json!({
                "sessionId": state.session_id,
                "provider": state.provider,
                "modelId": state.model_id,
                "thinkingLevel": state.thinking_level.map(|l| l.to_string()),
                "messageCount": state.message_count,
                "hasExtensions": has_extensions,
            }))
        })?
    }

    /// 子代理名册（活动面板 Agent 分区数据面）：读 pi 进程级
    /// `agent_hub::registry().roster()`——`ChildEntry[]`（id/name/kind/task/
    /// pid/status/startedMs/finishedMs/outputBytes/transcriptPath/steerPath/
    /// revivedFrom）。registry 是进程级单例（`docs/engine-gaps.md` §1），
    /// 宿主直接拉，不依赖模型调 `hub` 工具。**无活动会话 = 空名册**（不是
    /// 错误：registry 与会话解耦，新会话前空数组是诚实值）；锁中毒 = Err
    /// 传播（兜底禁令）。
    pub fn hub_roster(&self) -> Result<serde_json::Value, String> {
        let registry = pi::agent_hub::registry()
            .lock()
            .map_err(|_| "agent_hub registry mutex poisoned".to_string())?;
        let entries = registry.roster();
        serde_json::to_value(entries).map_err(|e| format!("子代理名册序列化失败: {e}"))
    }

    /// 后台 bash 任务列表（活动面板 Terminal 分区数据面）：pi
    /// `jobs::list(owner_session_id)`——按 owner session 过滤的
    /// `JobSnapshot[]`（id/command/startedAtMs/status/exitCode/pid/
    /// artifactPath/outputTail/...）。owner session id 从活动会话取
    /// （`handle.state().session_id`）；无活动会话 = 空列表（诚实空态——
    /// job 无从归属，不返回全量冒充）。
    pub fn job_list(&self) -> Result<serde_json::Value, String> {
        let shared = Arc::clone(&self.shared);
        let state = on_big_stack(move || {
            let mut guard = shared
                .handle
                .lock()
                .map_err(|_| "pi handle mutex poisoned".to_string())?;
            // 无活动会话 = 空列表（与 hub_roster 同语义：无会话即无从归属，
            // 诚实空态而非错误——面板挂载时首启/New Chat 都会到这里）。
            let Some(handle) = guard.as_mut() else {
                return Ok::<_, String>(None);
            };
            let state = shared
                .runtime
                .block_on(handle.state())
                .map_err(|e| e.to_string())?;
            Ok(Some(state.session_id))
        })??;
        // 无 session_id = 无活动会话的诚实空列表（job 无从归属；与
        // hub_roster 同语义——不冒充、不降级成全量）。
        let Some(owner) = state.flatten().filter(|s| !s.is_empty()) else {
            return Ok(serde_json::Value::Array(vec![]));
        };
        let jobs = pi::jobs::list(&owner).map_err(|e| format!("后台任务清单拉取失败: {e}"))?;
        serde_json::to_value(jobs).map_err(|e| format!("后台任务清单序列化失败: {e}"))
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

    /// 会话时间线标记（ZCode `timelineMarkerRow` 的宿主投影，2026-11-02）。
    ///
    /// 返回当前分支上的 `model_change` / `compaction` 条目，附带**它们出现
    /// 在第几条消息之前**（`beforeMessageIndex`）——渲染层据此把分隔线插进
    /// 消息流，而不是自造一个"切换发生在哪一轮"的判断。
    ///
    /// ## 为什么必须从会话条目取
    ///
    /// 模型切换的真相是 pi 的 `SessionEntry::ModelChange`（session.rs:6963，
    /// `append_model_change` 写入）。`pi_get_messages` 只投影 message 条目，
    /// 拿不到切换点；从设置页的"当前模型"反推则会漏掉历史切换（旧会话里
    /// 换过好几次模型）。**读条目是唯一准确来源。**
    ///
    /// ## 索引语义
    ///
    /// 沿 `entries_for_current_path()` 顺序扫描，每遇到一条 message 条目
    /// 就把计数器 +1；标记的 `beforeMessageIndex` = 扫到它时的计数器值。
    /// 于是 `beforeMessageIndex === 0` 表示"在第一条消息之前"（会话开头
    /// 的模型选择），等于 N 表示"在第 N 条消息之后、第 N+1 条之前"。
    ///
    /// 消息索引与前端 `pi_get_messages` 的顺序一致（同一个
    /// `entries_for_current_path()` + 同一条 message 过滤），所以前端可以
    /// 直接拿它跟 `thread.messages` 下标对齐。
    ///
    /// **计数口径（2026-11-03 修）**：只数 `role == user | assistant` 的
    /// message 条目。前端的 `hydratePiMessages` 把 `toolResult` **并进前一条
    /// assistant 的部件**（不产生独立消息），若按"全部 message 条目"计数，
    /// 标记索引会系统性偏大，尾部标记永远挂不上。与本水合逻辑同口径计数，
    /// 两边才能对齐。
    pub fn timeline_markers(&self) -> Result<serde_json::Value, String> {
        let shared = Arc::clone(&self.shared);
        let markers = on_big_stack(move || {
            let guard = shared
                .handle
                .lock()
                .map_err(|_| "pi handle mutex poisoned".to_string())?;
            let handle = guard.as_ref().ok_or("no active session")?;
            shared
                .runtime
                .block_on(handle.with_session(|session| {
                    let mut out: Vec<serde_json::Value> = Vec::new();
                    let mut message_index: usize = 0;
                    for entry in session.entries_for_current_path() {
                        match entry {
                            pi::session::SessionEntry::Message(msg) => {
                                // **与前端的 hydrate 同口径计数**：只有
                                // user / assistant 产生独立消息。toolResult
                                // 并进 assistant 部件；custom /
                                // bash_execution / branch_summary 前端直接
                                // 跳过——计进去索引就系统性偏大。
                                if matches!(
                                    msg.message,
                                    pi::session::SessionMessage::User { .. }
                                        | pi::session::SessionMessage::Assistant { .. }
                                ) {
                                    message_index += 1;
                                }
                            }
                            pi::session::SessionEntry::ModelChange(change) => {
                                // failover 角色是引擎自动降级，不是用户切换
                                // ——ZCode 的 modelChange 只表达用户可见的
                                // 模型身份变化，降级另有渠道。这里如实跳过，
                                // 避免把自动降级画成"你换了模型"。
                                if change.role.as_deref() == Some("failover") {
                                    continue;
                                }
                                out.push(serde_json::json!({
                                    "kind": "modelChange",
                                    "beforeMessageIndex": message_index,
                                    "provider": change.provider,
                                    "modelId": change.model_id,
                                }));
                            }
                            pi::session::SessionEntry::Compaction(_) => {
                                out.push(serde_json::json!({
                                    "kind": "compact",
                                    "beforeMessageIndex": message_index,
                                }));
                            }
                            _ => {}
                        }
                    }
                    out
                }))
                .map_err(|e| e.to_string())
        })??;
        Ok(serde_json::Value::Array(markers))
    }

    /// 切换 provider/model（ModelSelector 数据面）。
    ///
    /// **同时写回 settings.json 的默认值**（2026-10-26 用户报："模型选择是
    /// 假的，无论选哪个用的都是之前设置的，甚至不在模型选择器里的模型"）。
    ///
    /// 根因：上游 `AgentSession::set_provider_model` 只换**当前会话**的
    /// provider 实现 + 会话头元数据。新建会话走 `create_agent_session`，
    /// 它按 `settings.json` 的 `default_provider/default_model` 选模型——
    /// 不写回的话，用户选的模型只活到这次会话结束，下一条新会话又回到
    /// 那个（可能已失效的）默认值，而失效默认值会被 pi 回落到内置目录第一
    /// 项——于是"选哪个都用之前那个，甚至不在选择器里"。
    ///
    /// 写回用 pi 自己的 Config 类型（不手拼 JSON：别名/未知键/字段顺序都
    /// 由上游 serde 决定），写完原子替换，失败**传播**（规矩 12）——
    /// 会话内切换已成功时不回滚（会话状态已变），但错误必须让调用方看到。
    pub fn set_model(&self, provider: &str, model_id: &str) -> Result<(), String> {
        let shared = Arc::clone(&self.shared);
        let provider = provider.to_string();
        let model_id = model_id.to_string();
        let (p, m) = (provider.clone(), model_id.clone());
        let switched = on_big_stack(move || {
            let mut guard = shared
                .handle
                .lock()
                .map_err(|_| "pi handle mutex poisoned".to_string())?;
            // **无活动会话不是错误**（首条消息前是正常态）：此时没有运行时
            // 可切换，但用户的意图仍然有效——写回默认值，下一次建会话就按
            // 它起跑。这里不是兜底：切换失败（有会话但切不动）照样 Err。
            let Some(handle) = guard.as_mut() else {
                return Ok::<bool, String>(false);
            };
            shared
                .runtime
                .block_on(handle.set_model(&p, &m))
                .map_err(|e| e.to_string())?;
            Ok(true)
        })??;
        let _ = switched;
        // 会话已切成功（或无会话待建）→ 同步默认值（新会话从这里起跑）
        crate::pi_settings::persist_default_model(&provider, &model_id)
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
            // **必须把 models.json 路径喂进去**（2026-10-26 修复）：此前传
            // None = 只列内置目录，用户在设置页自定义的 provider（写进
            // models.json 的 providers 表）在模型选择器里根本看不到——用户
            // 报"选的模型甚至不在模型选择器里"的一半成因在这里。
            // 路径与 pi_settings 同源（default_models_path(&global_dir)，
            // 上游 models.rs:3994 / pi main.rs:887 同款）。
            let models_path = pi::models::default_models_path(&pi::config::Config::global_dir());
            let registry = pi::sdk::ModelRegistry::load_for_listing(&auth, Some(models_path));
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

// ── fork/分支的纯序列化助手（与引擎锁逻辑分离，可对 in_memory Session
//    单测；语义逐条照抄上游 rpc.rs:12317-12349 / session.rs:5838-6018）──

/// 当前路径 user 消息 → [{entryId, text}]（上游 fork_messages_from_entries
/// 逐行同构：entryId 缺失给空串、text 取首个 Text 块、无 Text 块为 null）。
fn fork_points_json(session: &pi::session::Session) -> Vec<serde_json::Value> {
    session
        .entries_for_current_path()
        .into_iter()
        .filter_map(|entry| {
            let pi::session::SessionEntry::Message(m) = entry else {
                return None;
            };
            let pi::session::SessionMessage::User { content, .. } = &m.message else {
                return None;
            };
            let entry_id = m.base.id.clone().unwrap_or_default();
            let text = extract_user_text(content);
            Some(serde_json::json!({
                "entryId": entry_id,
                "text": text,
            }))
        })
        .collect()
}

/// user 消息内容的文本提取（上游 rpc.rs:12338 extract_user_text 逐行照抄）。
fn extract_user_text(content: &UserContent) -> Option<String> {
    match content {
        UserContent::Text(text) => Some(text.clone()),
        UserContent::Blocks(blocks) => blocks.iter().find_map(|b| {
            if let ContentBlock::Text(t) = b {
                Some(t.text.clone())
            } else {
                None
            }
        }),
    }
}

/// 兄弟分支 → null | {forkPointId, branches: [...]}（SiblingBranch 无
/// Serialize——手工组装，camelCase 对齐其余 pi_* 命令的 JSON 面）。
fn sibling_branches_json(session: &pi::session::Session) -> serde_json::Value {
    match session.sibling_branches() {
        None => serde_json::Value::Null,
        Some((fork_point_id, branches)) => serde_json::json!({
            "forkPointId": fork_point_id,
            "branches": branches
                .iter()
                .map(|b| {
                    serde_json::json!({
                        "rootId": b.root_id,
                        "leafId": b.leaf_id,
                        "preview": b.preview,
                        "messageCount": b.message_count,
                        "isCurrent": b.is_current,
                    })
                })
                .collect::<Vec<_>>(),
        }),
    }
}

#[cfg(test)]
mod fork_tests {
    //! fork/分支纯逻辑单测：in_memory Session + append 家族（全 pub）构造
    //! 会话树，验证 fork 点枚举的路径过滤与兄弟分支序列化形状、ForkPlan
    //! 的"选中消息不进新文件"语义。fork/switch 的文件落盘与 agent 换装
    //! 是端到端行为（真实 handle + provider），留冒烟验证。

    use super::*;
    use pi::model::{AssistantMessage, Message, UserMessage};

    fn user_msg(text: &str) -> Message {
        Message::User(UserMessage {
            content: UserContent::Text(text.to_string()),
            timestamp: 0,
        })
    }

    fn assistant_msg(text: &str) -> Message {
        Message::assistant(AssistantMessage {
            content: vec![ContentBlock::Text(TextContent::new(text))],
            ..AssistantMessage::default()
        })
    }

    #[test]
    fn fork_points_lists_user_messages_on_current_path() {
        let mut s = pi::session::Session::in_memory();
        let u1 = s.append_model_message(user_msg("第一条"));
        let _a1 = s.append_model_message(assistant_msg("回复"));
        let u2 = s.append_model_message(user_msg("第二条"));
        let rows = fork_points_json(&s);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0]["entryId"], serde_json::json!(u1));
        assert_eq!(rows[0]["text"], serde_json::json!("第一条"));
        assert_eq!(rows[1]["entryId"], serde_json::json!(u2));
        assert_eq!(rows[1]["text"], serde_json::json!("第二条"));

        // 分叉后路径过滤：导航回 u1 再追加（兄弟分支），旧分支的
        // 助手回复/第二条消息不在当前路径
        assert!(s.navigate_to(&u1));
        let u3 = s.append_model_message(user_msg("分支乙"));
        let rows = fork_points_json(&s);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0]["entryId"], serde_json::json!(u1));
        assert_eq!(rows[1]["entryId"], serde_json::json!(u3));
        assert_eq!(rows[1]["text"], serde_json::json!("分支乙"));
    }

    #[test]
    fn fork_points_skips_non_user_entries() {
        let mut s = pi::session::Session::in_memory();
        let _a = s.append_model_message(assistant_msg("只有助手消息"));
        let rows = fork_points_json(&s);
        assert!(rows.is_empty());
    }

    #[test]
    fn sibling_branches_reports_fork_point_and_leaves() {
        let mut s = pi::session::Session::in_memory();
        let u1 = s.append_model_message(user_msg("根问题"));
        let a1 = s.append_model_message(assistant_msg("回答甲"));
        let _u2 = s.append_model_message(user_msg("分支甲")); // 甲叶 = a1 的子链
        assert!(s.navigate_to(&u1));
        let u3 = s.append_model_message(user_msg("分支乙")); // u1 现在有两个孩子 = 分叉点

        let v = sibling_branches_json(&s);
        assert!(v.is_object());
        assert_eq!(v["forkPointId"], serde_json::json!(u1));
        let branches = v["branches"].as_array().expect("branches array");
        assert_eq!(branches.len(), 2);
        // 分支甲（先追加，排前）：root = a1，叶 = a1 的最深首子链 _u2，
        // 消息数 = 路径上全部消息条目。preview = 路径上离根最近的 user
        // 文本——上游 path_preview_and_message_count 从叶向根走、每条
        // 非空 user 文本都覆盖 preview（session.rs:5922-5935 无 is_none
        // 守卫），两条分支共用同一根前缀 → 预览同为 "根问题"。
        assert_eq!(branches[0]["rootId"], serde_json::json!(a1));
        assert_eq!(branches[0]["preview"], serde_json::json!("根问题"));
        assert_eq!(branches[0]["messageCount"], serde_json::json!(3));
        assert_eq!(branches[0]["isCurrent"], serde_json::json!(false));
        // 分支乙：root 即叶（无孩子），当前分支
        assert_eq!(branches[1]["rootId"], serde_json::json!(u3));
        assert_eq!(branches[1]["leafId"], serde_json::json!(u3));
        assert_eq!(branches[1]["preview"], serde_json::json!("根问题"));
        assert_eq!(branches[1]["messageCount"], serde_json::json!(2));
        assert_eq!(branches[1]["isCurrent"], serde_json::json!(true));
    }

    #[test]
    fn sibling_branches_null_without_fork() {
        let mut s = pi::session::Session::in_memory();
        let _u = s.append_model_message(user_msg("线性会话"));
        assert!(sibling_branches_json(&s).is_null());
    }

    #[test]
    fn fork_plan_leaf_stops_at_parent_of_selected_message() {
        // fork 语义的核心：选中 user 消息不进新文件，叶停其父级——
        // 前端预填 selectedText 重新提交即新分支（不会出现连续两条 user）
        let mut s = pi::session::Session::in_memory();
        let u1 = s.append_model_message(user_msg("第一条"));
        let a1 = s.append_model_message(assistant_msg("回复"));
        let u2 = s.append_model_message(user_msg("重新表述"));
        let plan = s
            .plan_fork_from_user_message(&u2)
            .expect("fork plan for user message");
        assert_eq!(plan.leaf_id.as_deref(), Some(a1.as_str()));
        assert_eq!(plan.selected_text, "重新表述");
        assert_eq!(plan.entries.len(), 2);
        assert!(plan.entries.iter().all(|e| e.base_id() != Some(&u2)));
        assert_eq!(plan.entries.last().and_then(|e| e.base_id()), Some(&a1));
        // 根消息 fork：叶 = None（无父级），entries 为空
        let root_plan = s.plan_fork_from_user_message(&u1).expect("root plan");
        assert_eq!(root_plan.leaf_id, None);
        assert!(root_plan.entries.is_empty());
        assert_eq!(root_plan.selected_text, "第一条");
    }
}

#[cfg(test)]
mod todo_state_tests {
    //! 待办重放纯逻辑单测（活动面板 Todo 分区拉取面，docs/engine-gaps.md
    //! G2）：in-memory Session + `append_custom_entry(TODO_LIST_SCHEMA, ...)`
    //! 构造定制条目树，验证 `pi::todo::latest_from_entries` 的"取最新"
    //! 语义与我们的 JSON 形状。`todo_state()` 方法本身需要真实 handle
    //! （session_mut + runtime），留冒烟验证。

    use super::*;

    /// 构造一条 `todo_list.v1` 定制条目的 data（pi TodoList serde 形状：
    /// phases[].tasks[] = { content, state }，state 为 tag="state" snake_case）。
    fn todo_data(tasks: &[(&str, &str)]) -> serde_json::Value {
        serde_json::json!({
            "phases": [{
                "tasks": tasks.iter().map(|(c, s)| serde_json::json!({
                    "content": c, "state": s
                })).collect::<Vec<_>>()
            }]
        })
    }

    #[test]
    fn latest_from_entries_picks_newest_todo_entry() {
        let mut s = pi::session::Session::in_memory();
        s.append_custom_entry(
            pi::todo::TODO_LIST_SCHEMA.to_string(),
            Some(todo_data(&[("第一步", "open"), ("第二步", "open")])),
        );
        // 第二次变更（模拟 start 第二步）：再 append 一条，应取这条
        s.append_custom_entry(
            pi::todo::TODO_LIST_SCHEMA.to_string(),
            Some(todo_data(&[("第一步", "done"), ("第二步", "in_progress")])),
        );
        let entries = s.entries_for_current_path();
        let list = pi::todo::latest_from_entries(entries.iter().copied());
        let v = serde_json::to_value(&list).expect("serialize");
        let tasks = v["phases"][0]["tasks"].as_array().expect("tasks");
        assert_eq!(tasks.len(), 2);
        assert_eq!(tasks[0]["content"], "第一步");
        assert_eq!(tasks[0]["state"], "done");
        assert_eq!(tasks[1]["state"], "in_progress");
    }

    #[test]
    fn latest_from_entries_empty_without_todo_entries() {
        let mut s = pi::session::Session::in_memory();
        s.append_custom_entry("checkpoint".to_string(), Some(serde_json::json!({})));
        let entries = s.entries_for_current_path();
        let list = pi::todo::latest_from_entries(entries.iter().copied());
        assert!(list.is_empty());
        assert!(list.summary_line().is_none());
    }

    #[test]
    fn latest_from_entries_skips_corrupt_entry() {
        // 坏 data（缺 phases）→ serde 失败 → .ok() 跳过（上游同款：
        // 坏条目从未可用），回落到上一条合法条目
        let mut s = pi::session::Session::in_memory();
        s.append_custom_entry(
            pi::todo::TODO_LIST_SCHEMA.to_string(),
            Some(todo_data(&[("好任务", "open")])),
        );
        s.append_custom_entry(
            pi::todo::TODO_LIST_SCHEMA.to_string(),
            Some(serde_json::json!({ "bogus": true })),
        );
        let entries = s.entries_for_current_path();
        let list = pi::todo::latest_from_entries(entries.iter().copied());
        assert_eq!(list.phases.len(), 1);
        assert_eq!(list.phases[0].tasks[0].content, "好任务");
    }

    #[test]
    fn summary_line_has_settled_over_total_and_current() {
        let mut s = pi::session::Session::in_memory();
        s.append_custom_entry(
            pi::todo::TODO_LIST_SCHEMA.to_string(),
            Some(todo_data(&[("甲", "done"), ("乙", "in_progress"), ("丙", "open")])),
        );
        let entries = s.entries_for_current_path();
        let list = pi::todo::latest_from_entries(entries.iter().copied());
        let summary = list.summary_line().expect("summary");
        assert!(summary.starts_with("1/3"));
        assert!(summary.contains("乙"));
    }
}

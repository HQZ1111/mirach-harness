//! PiEngine —— **rpi-main 引擎**（2026-11-14 竖链移植，用户定稿"核心换成
//! G:\pi-rust-main，不用 pi agent rust 了"）。旧实现存档于 git df701a4。
//!
//! ## 移植边界（竖链优先，用户选定策略 1）
//!
//! - **对话面走 rpi**（真实现）：ensure/open/discard（会话生命周期）、
//!   prompt/prompt_with_content（流式）、interrupt（abort）、state、
//!   list_sessions（rpi 会话目录扫描）、rename/delete（set_name/删文件）、
//!   new_session_with_cwd（指定工作区新建）、模型目录/切换/思考档位
//!   （models.json 已配置集 → `AgentLane::set_model`/`set_thinking_level`，
//!   2026-11-14 接真，见「模型 / 思考档位面」段）。
//! - **旧 pi 独有面**：能对上 rpi 公开能力的已接真（2026-11-14 第二轮：
//!   消息重放 / 手动压缩 / 会话用量 / HTML 导出 / fork·fork 点·兄弟分支·
//!   分支切换 / retry 编辑 / 时间线标记）；**插件状态投影**（2026-11-15：
//!   rpi-todo / rpi-plan-mode 的会话条目 → 旧 wire，见 pi_plugin_state.rs）；
//!   确无对应能力的继续如实降级（Err 文案写明缺什么，标红纪律，不静默不
//!   造假）：审批模式开关 / plan 审批决定 / 会话检查点与 rewind / 文件改动
//!   undo-redo / hub 花名册五面（插件只存进程内存）/ job 面（插件未安装且
//!   快照缺字段）/ bot 会话。
//! - **AG-UI 协议面不变**：agui.rs 只换 map_agent_event 的变体来源 +
//!   图片转换，前端零改动。
//! - **分栏（side_*）暂不支持**：rpi v1 非 main lane 拒绝 run 操作
//!   （InvalidLane）——如实 Err，前端分栏可见错误。
//! - **审批 / ask（rpi runtime action 17）已接真（2026-11-15）**：
//!   `session::build` 返回的 `ReloadContext.ui_dialog` 是会话级
//!   `UiDialogMailbox`，宿主 build 后立即 `attach`（没有交互 UI 时上游拒绝
//!   "ask_user requires an interactive UI"）；插件的 ask / permission
//!   对话框经 `take_pending_filtered` 取出并投影成前端卡片，应答经
//!   `respond`/`cancel` 回灌。旧 pi 的 before_tool_call ApprovalRegistry
//!   oneshot 通道已被邮箱取代（注册表保留语义位与测试）。
//!
//! ## 引擎形态（照 egui 试验田验证过的嵌入法）
//!
//! - **tokio multi-thread 运行时**（rpi 用 tokio，不是旧 pi 的 asupersync
//!   ——16MiB 大栈/深递归/AbortHandle 那套机制随之退役）；
//! - harness 装配 = **rpi-cli 当 SDK 库**：`provider::resolve`（models.json +
//!   env key）→ `session::build(&resolved, &args, &cwd, false)`（文档原话
//!   "v1 equivalent of TS createAgentSession"）——env/tools/会话存储/系统
//!   提示词/选项装配全由它承担，Args 精确控制（session=恢复路径/tools）；
//! - 流式 = AgentHarnessOptions 的 BroadcastEmitter → build 返回的
//!   broadcast Receiver → **每轮 resubscribe** 排水任务转 on_event
//!   （Receiver 不可 Clone）；
//! - prompt = `AgentHarness::prompt_text(&self, text, images)`（AgentLane
//!   trait 方法——**须 use rpi_harness::agent_harness::AgentLane**）；
//! - 中断 = `AgentLane::abort(&self)`（无 AbortHandle——Arc 共享即可调）；
//! - 会话写 `<workspace>/.rpi/sessions/`（rpi durable JSONL）。**旧 pi 会话
//!   历史不再列出**（迁移语义如实；文件不删）。cron（pi_cron.rs）仍用
//!   vendored pi SDK 自开会话——两引擎并存至迁移完成。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use rpi_agent::AgentEvent;
use rpi_harness::agent_harness::{AgentHarness, AgentLane, CompactionOutcome, NavigationOutcome};
use rpi_harness::session::jsonl::{
    JsonlSessionCreateOptions, JsonlSessionListOptions, JsonlSessionMetadata, JsonlSessionRepo,
    JsonlSessionRepoOptions, JsonlSessionStorage,
};
use rpi_harness::session::types::{
    BranchBounds, Entry, EntryOrder, EntryQuery, ForkOptions, ForkPosition, SessionStats,
};
use rpi_harness::session::{DefaultIdGenerator, Session, SystemClock};
use rpi_ai::types::{ImageContent, UserContent};
use rpi_cli::session::ReloadContext;

use crate::agui::{AguiImage, AskRegistry, ApprovalRegistry, ThreadBuffers};

/// 无活动会话的固定文案。前端多处按英文锚点 "no active session" 区分
/// "首启/New Chat 的预期域状态" 与真错误（见 `live()`）。
const NO_ACTIVE_SESSION: &str = "无活动会话（no active session）";

/// block_on 的固定执行栈：16MiB（虚拟预留，惰性提交）。旧 pi 消费面
/// （settings/vault/login/usage/capabilities 等 12 模块）的深递归解析仍靠
/// 它——rpi 侧的对话面已不需要（tokio），并存至旧消费面迁移完成。
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

// ── UiBridgeHandle（形状不变——agui.rs/main.rs 继续构造传递）────────────────
// rpi 迁移后字段暂无读取方：事件转发（broadcast → ThreadBuffers）待接；
// 审批/ask 已改走 `ReloadContext.ui_dialog` 邮箱（不经过这里），字段保留以
// 保调用点签名。

#[allow(dead_code)] // 字段暂无读取方——事件转发待 rpi 面接回
pub struct UiBridgeHandle {
    pub buffers: Arc<Mutex<ThreadBuffers>>,
    pub approvals: Arc<ApprovalRegistry>,
    pub thread: String,
}

// ── 运行时 ──────────────────────────────────────────────────────────────────

/// tokio multi-thread 运行时（rpi 栈；harness 内部任务需要）。
pub struct PiRuntime {
    rt: tokio::runtime::Runtime,
}

impl PiRuntime {
    pub fn new() -> Self {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("tokio runtime 构建失败");
        Self { rt }
    }

    /// 在引擎运行时上驱动 future。
    ///
    /// **嵌套防护（2026-11-14 实锤）**：调用线程若已在某个 tokio runtime
    /// 里（tauri 的 async 命令就跑在它的 rt worker 上），直接 `block_on`
    /// 会 panic ——tokio 原文 "Cannot start a runtime from within a
    /// runtime"，命令的 promise 永不 resolve（前端表现为点了没反应/挂起；
    /// pi_new_session / pi_open_session 实测此状）。此时把 future 搬到
    /// **独立线程（16MiB 栈，与 agui 的 pi-create 线程同规格）** 上再
    /// block_on：干净线程无运行时上下文，合法。std::thread::scope 让
    /// future 保持借用（无需 'static）。
    pub fn block_on<F>(&self, fut: F) -> F::Output
    where
        F: std::future::Future + Send,
        F::Output: Send,
    {
        if tokio::runtime::Handle::try_current().is_ok() {
            std::thread::scope(|scope| {
                std::thread::Builder::new()
                    .name("pi-engine-call".into())
                    .stack_size(16 * 1024 * 1024)
                    .spawn_scoped(scope, || self.rt.block_on(fut))
                    .expect("pi-engine-call 线程启动失败")
                    .join()
                    .unwrap_or_else(|e| std::panic::resume_unwind(e))
            })
        } else {
            self.rt.block_on(fut)
        }
    }
}

/// 共享的**资源列举**运行时（skills/prompts 装载用——pi_capabilities /
/// pi_resources 的 UI 列举调用，与 PiEngine 的会话运行时分开，避免锁耦合；
/// tokio Runtime 本身 Send + Sync）。
pub(crate) fn list_runtime() -> &'static PiRuntime {
    static RT: std::sync::OnceLock<PiRuntime> = std::sync::OnceLock::new();
    RT.get_or_init(PiRuntime::new)
}

// ── 引擎 ────────────────────────────────────────────────────────────────────

struct EngineShared {
    rt: PiRuntime,
    cwd: PathBuf,
    /// 会话在场态（None = 未创建/已 discard）
    live: Mutex<Option<Arc<HarnessLive>>>,
    /// 切走/丢弃但**仍持有 writer lease** 的会话（2026-11-15）。
    ///
    /// rpi 的 JSONL storage 在 acquire_writer_lease 后，即使 HarnessLive 被
    /// 替换也仍被引擎内部任务引用（实测：切到 B 再切回 A 必撞 "writer lease
    /// is already held"）。TUI 用 set_session 原地换会话规避；宿主重建
    /// harness 的路径无法释放旧 lease，故把旧 HarnessLive 留在本表里复用：
    /// 再次打开同一路径时直接重新激活，不重新 acquire。进程退出时随 OS
    /// 句柄一起释放。
    retired: Mutex<HashMap<PathBuf, Arc<HarnessLive>>>,
    model_line: Mutex<String>,
}

struct HarnessLive {
    harness: Arc<AgentHarness>,
    events: tokio::sync::broadcast::Receiver<AgentEvent>,
    /// `rpi_cli::session::build` 的第三个返回值。目前只用 `ui_dialog`
    /// （runtime action 17 的会话级邮箱，插件 ask/permission 的宿主侧入口）；
    /// 其余字段是 `/reload` 面，随上下文一并保留供后续接。
    reload: ReloadContext,
    session_path: Option<PathBuf>,
    /// 该会话的 rpi 会话根（`<cwd>/.rpi/sessions` 或 settings 覆盖值，见
    /// `session_root`）。不能统一用 `EngineShared::cwd` 现算：
    /// `new_session_with_cwd` 以用户选定工作区建会话，根随该工作区。
    sessions_root: PathBuf,
    provider: String,
    model_id: String,
}

pub struct PiEngine {
    shared: Arc<EngineShared>,
    approvals: Arc<ApprovalRegistry>,
    asks: Arc<AskRegistry>,
}

/// 工作区根（Phase 1 默认 = 用户主目录；工作区选择面后续接列头）。
fn default_workspace() -> PathBuf {
    std::env::var("USERPROFILE")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
}

/// 会话文件路径 → 它的工作区根。
///
/// rpi 的会话布局：`<cwd>/.rpi/sessions/<encoded-cwd>/<ts>_<id>.jsonl`。
/// 侧栏「选择文件夹」建的会话落在所选 cwd 的会话根里，而 `open_session`
/// 原先始终用**活动会话的 cwd** 去查——跨工作区切换必然 "No session
/// found"。形状不符（自定义 sessionDir、旧布局、直接放在根下）→ None，
/// 调用方沿用活动 cwd（不猜）。
fn workspace_from_session_path(path: &Path) -> Option<PathBuf> {
    let sessions = path.parent()?.parent()?; // .../<cwd>/.rpi/sessions
    if sessions.file_name()? != "sessions" {
        return None;
    }
    let agent_dir = sessions.parent()?;
    if agent_dir.file_name()? != ".rpi" {
        return None;
    }
    agent_dir.parent().map(Path::to_path_buf)
}

/// retired 缓存的键：规范化为绝对路径，避免 `C:/x` 与 `C:\x` 被当成两个
/// 会话。canonicalize 失败（文件刚被删）时保留原样——查不到即未命中。
fn session_cache_key(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

/// 打开前预检：会话文件必须存在且**首行是 rpi header**。
///
/// 2026-11-15 实锤：`G:\pi_agent_rust-main` 那个会话在用户让它"删除自己的
/// 工作区"后被写坏——文件只剩两条 entry（首行是 tool_result，seq 26），
/// header 丢失。rpi 的 `find_session_metadata` 只收录能解析出 header 的
/// 文件，于是报 "No session found for session <path>"，看起来像"切工作区
/// 失败"，实际是文件损坏。预检把真实原因带出来（UI 红条可见）。
/// rpi-permission-gate 的启用面（扩展 README：`--permission-gate` 或
/// `RPI_PERMISSION_GATE=1`；`--bypass` 优先）。宿主只读 env：本进程内扩展
/// 读的是同一份环境变量，因此可用于「当前模式」展示。
///
/// **只读**：gate 在扩展/会话构建时读 env，宿主没有运行时切换面
/// （`set_approval_mode` 恒 Err）；把它当成可切换开关就是假入口。
fn permission_gate_enabled() -> bool {
    match std::env::var("RPI_PERMISSION_GATE") {
        Ok(value) => {
            let value = value.trim();
            value == "1"
                || value.eq_ignore_ascii_case("true")
                || value.eq_ignore_ascii_case("yes")
        }
        Err(_) => false,
    }
}

fn preflight_session_file(path: &str) -> Result<(), String> {
    // 解析逻辑唯一实现在 session_index.rs（跨根索引复用同一份；错误文案
    // 保持「损坏 / 缺少 header」锚点）。
    crate::session_index::read_session_header(Path::new(path)).map(|_| ())
}

impl PiEngine {
    pub fn new() -> Self {
        let approvals = Arc::new(ApprovalRegistry::new());
        let asks = Arc::new(AskRegistry::new());
        Self {
            shared: Arc::new(EngineShared {
                rt: PiRuntime::new(),
                cwd: default_workspace(),
                live: Mutex::new(None),
                retired: Mutex::new(HashMap::new()),
                model_line: Mutex::new("引擎待启动".into()),
            }),
            approvals,
            asks,
        }
    }

    pub fn approvals(&self) -> Arc<ApprovalRegistry> {
        Arc::clone(&self.approvals)
    }

    /// 启动工作区根（相对路径的解析基准；与引擎会话根同源）。
    pub fn workspace_cwd(&self) -> PathBuf {
        self.shared.cwd.clone()
    }

    pub fn asks(&self) -> Arc<AskRegistry> {
        Arc::clone(&self.asks)
    }

    /// Harness 装配（resolve → build）。`session_path` = Some 时走恢复路径
    /// （args.session + allow_existing 由 CLI build 自动接管）。
    ///
    /// 返回的 `HarnessLive::session_path` **恒为 Some**：新建会话由 rpi 在
    /// build 内部落盘（`<root>/<encoded-cwd>/<ts>_<id>.jsonl`）但不回报路径，
    /// 这里按会话 id 反查会话目录补齐——删除保护、fork、导出、静态面板都靠
    /// 路径定位；拿不到路径 = Err（不静默留 None）。
    fn build_harness(&self, cwd: &Path, session_path: Option<&str>) -> Result<HarnessLive, String> {
        self.build_harness_with(cwd, session_path, None, None)
    }

    /// 同 [`Self::build_harness`]，但允许指定 provider/model 覆盖（bot 会话
    /// 与 cron 之外的按需覆盖场景；None = 走 settings/内置默认解析）。
    fn build_harness_with(
        &self,
        cwd: &Path,
        session_path: Option<&str>,
        provider: Option<&str>,
        model: Option<&str>,
    ) -> Result<HarnessLive, String> {
        let (harness, events, reload, resolved_provider, model_id, id) = self.shared.rt.block_on(async {
            let mut resolved = rpi_cli::provider::resolve(provider, model, None, None, None)
                .map_err(|e| format!("模型解析失败: {e}"))?;
            // 宿主侧模型目录：models.json 缺 contextWindow（0）时用
            // models.dev 的值补进**本次会话的 model**——引擎的压缩阈值
            // （should_compact 只看 >0）也吃到真实窗口；不写用户配置。
            if resolved.model.context_window == 0 {
                if let Some(context_window) = crate::model_registry::lookup(&resolved.model.id) {
                    resolved.model.context_window = context_window;
                }
            }
            let mut args = rpi_cli::args::Args::default();
            if let Some(p) = session_path {
                args.session = Some(p.to_string());
            }
            let (harness, events, reload) = rpi_cli::session::build(&resolved, &args, cwd, false)
                .await
                .map_err(|e| format!("Harness 构建失败: {e}"))?;
            // 宿主就是那个"交互 UI"：上游语义是没有客户端 attach 时插件拒绝
            // 弹 UI（rpi-extensions actions.rs `handle` 的 open 分支原文
            // "ask_user requires an interactive UI"）。`build` 的
            // ReloadContext 里就是初始 ActionBridge / before_tool_call 钩子
            // 共用的会话级邮箱，拿到立即 attach；每次重建 harness 都重新
            // attach（generation 自增，旧桥失效）。attach 失败（锁中毒 /
            // generation 耗尽）必须传播——静默不 attach 会让插件 UI 全部
            // fail-closed 而无人知晓（规矩 12；上游 TUI 同样拒绝启动）。
            if reload.ui_dialog.try_attach_with_generation().is_none() {
                return Err("扩展 UI 邮箱 attach 失败（mailbox 状态锁中毒或 generation 耗尽）".into());
            }
            let provider = resolved.model.provider.clone();
            let model_id = resolved.model.id.clone();
            let id = harness
                .session()
                .get_metadata()
                .await
                .map(|m| m.id)
                .map_err(|e| format!("会话元数据读取失败: {e}"))?;
            Ok::<_, String>((harness, events, reload, provider, model_id, id))
        })?;
        let sessions_root = self.session_root(cwd);
        let session_path = match session_path {
            Some(p) => PathBuf::from(p),
            None => PathBuf::from(self.session_metadata_in(&sessions_root, &id)?.path),
        };
        Ok(HarnessLive {
            harness: Arc::new(harness),
            events,
            reload,
            session_path: Some(session_path),
            sessions_root,
            provider: resolved_provider,
            model_id,
        })
    }

    /// 会话根目录：与 rpi-cli `configured_session_dir`（session.rs:322-339）
    /// 同优先级——`settings.json` 的 sessionDir 优先，其次默认
    /// `<cwd>/.rpi/sessions`（`RPI_CODING_AGENT_SESSION_DIR` 由
    /// `default_session_dir` 处理）；相对路径相对启动项目解析。
    /// **必须与 build 的 `cwd` 同源**：根不一致会让新建会话的路径反查直接
    /// 失败（`new_session_with_cwd` 以用户选定工作区建会话）。
    fn session_root(&self, cwd: &Path) -> PathBuf {
        // 与引擎同语义：`configured_session_dir` 对 settings 读取失败用
        // `.ok()` 吞掉并退回默认根。这里跟随（否则宿主与引擎的会话根会分
        // 叉，新建会话反查必失败），但保持可见——失败不静默。
        let settings = match rpi_cli::settings::load_settings() {
            Ok(settings) => settings,
            Err(e) => {
                eprintln!("[pi] 读 rpi 设置失败，会话根退回默认: {e}");
                rpi_cli::settings::Settings::default()
            }
        };
        let dir = settings
            .session_dir
            .unwrap_or_else(|| rpi_cli::session::default_session_dir(cwd));
        if dir.is_relative() && !dir.has_root() {
            cwd.join(dir)
        } else {
            dir
        }
    }

    /// 会话根的 JSONL repo（列表/反查/fork 共用）。
    fn jsonl_repo(&self, root: &Path) -> JsonlSessionRepo {
        let fs: Arc<dyn rpi_tools::FileSystem> =
            Arc::new(rpi_tools::OsExecutionEnv::with_cwd(root.to_path_buf()));
        JsonlSessionRepo::with_env_cwd(JsonlSessionRepoOptions {
            fs,
            sessions_root: root.to_string_lossy().into_owned(),
            clock: Arc::new(SystemClock),
            ids: Arc::new(DefaultIdGenerator::new()),
        })
    }

    /// 按会话 id 在会话根里反查磁盘元数据（rpi 不向宿主回报新建会话的
    /// 文件路径，只能用 repo 的公开 list 面反查；找不到 = Err）。
    fn session_metadata_in(&self, root: &Path, id: &str) -> Result<JsonlSessionMetadata, String> {
        let repo = self.jsonl_repo(root);
        let metas = self
            .shared
            .rt
            .block_on(repo.list_typed(&JsonlSessionListOptions { cwd: None }))
            .map_err(|e| format!("会话目录扫描失败 {}: {e}", root.display()))?;
        metas.into_iter().find(|m| m.id == id).ok_or_else(|| {
            format!(
                "会话 {id} 不在会话目录 {} 中（文件未落盘或不在会话目录）",
                root.display()
            )
        })
    }

    fn live(&self) -> Result<Arc<HarnessLive>, String> {
        self.live_opt()?.ok_or_else(|| NO_ACTIVE_SESSION.to_string())
    }

    /// 活动会话句柄（None = 首启/New Chat 的预期态，不是错误；锁中毒才 Err）。
    fn live_opt(&self) -> Result<Option<Arc<HarnessLive>>, String> {
        Ok(self
            .shared
            .live
            .lock()
            .map_err(|_| "引擎状态锁中毒".to_string())?
            .as_ref()
            .map(Arc::clone))
    }

    /// 换装活动会话（ensure/open/new 共用）。
    ///
    /// 旧会话的挂起对话框一律 `cancel_all`：插件侧 poll 立刻看到 cancelled
    /// （不留到超时），宿主侧已取出的卡片随注册表清空（防鬼影卡片）。
    fn install_live(&self, live: HarnessLive) -> Result<(), String> {
        let previous = self
            .shared
            .live
            .lock()
            .map_err(|_| "锁中毒".to_string())?
            .replace(Arc::new(live));
        self.retire_previous(previous)?;
        self.approvals.cleanup();
        self.asks.cleanup();
        Ok(())
    }

    /// 把活动会话移入 retired 缓存（不 drop：见 EngineShared::retired 注释）。
    /// 没有 session_path 的在场态（不应存在）直接丢弃。
    fn retire_previous(&self, previous: Option<Arc<HarnessLive>>) -> Result<(), String> {
        let Some(previous) = previous else {
            return Ok(());
        };
        previous.reload.ui_dialog.cancel_all();
        let Some(path) = previous.session_path.clone() else {
            return Ok(());
        };
        let key = session_cache_key(&path);
        self.shared
            .retired
            .lock()
            .map_err(|_| "retired 会话表锁中毒".to_string())?
            .insert(key, previous);
        Ok(())
    }

    /// 当前分支上的 message 条目（seq 升序；水合/重放/fork 点/retry 共用）。
    fn branch_message_entries(&self, live: &HarnessLive) -> Result<Vec<Entry>, String> {
        self.shared.rt.block_on(async {
            live.harness
                .session()
                .find_entries_on_branch(
                    &EntryQuery {
                        entry_type: Some("message"),
                        order: Some(EntryOrder::OldestFirst),
                        ..Default::default()
                    },
                    &BranchBounds::default(),
                )
                .await
                .map_err(|e| format!("会话消息读取失败: {e}"))
        })
    }

    /// 当前分支上**最新**一条插件自定义条目的 `data`（rpi 插件经
    /// `runtime_action(AppendEntry)` 落盘的状态快照，见 pi_plugin_state.rs）。
    ///
    /// 取法照插件自己的 `restore_state`/`restore_from_branch`：筛
    /// `entry_type="custom"` + `customType=<type>`，取 **seq 最大**的那条
    /// （不依赖存储层返回顺序/NewestFirst+limit 的游标细节）。
    /// 无条目 = `Ok(None)`（诚实空态）；最新条目缺 data / 类型不符 = Err
    /// （条目损坏，不静默回退到更旧快照——插件对坏快照同样 Blocked）。
    fn latest_plugin_entry(
        &self,
        live: &HarnessLive,
        custom_type: &str,
    ) -> Result<Option<serde_json::Value>, String> {
        let entries = self.shared.rt.block_on(async {
            live.harness
                .session()
                .find_entries_on_branch(
                    &EntryQuery {
                        entry_type: Some("custom"),
                        custom_type: Some(custom_type.to_string()),
                        ..Default::default()
                    },
                    &BranchBounds::default(),
                )
                .await
                .map_err(|e| format!("会话条目读取失败（{custom_type}）: {e}"))
        })?;
        let mut latest: Option<(u64, serde_json::Value)> = None;
        for entry in entries {
            match entry {
                Entry::Custom(entry) if entry.custom_type == custom_type => {
                    let data = entry.data.ok_or_else(|| {
                        format!("{custom_type} 条目缺少 data（条目损坏：{}）", entry.base.id)
                    })?;
                    if latest
                        .as_ref()
                        .map(|(seq, _)| entry.base.seq > *seq)
                        .unwrap_or(true)
                    {
                        latest = Some((entry.base.seq, data));
                    }
                }
                Entry::Custom(entry) => {
                    return Err(format!(
                        "会话条目查询返回了 {}, 期望 {custom_type}",
                        entry.custom_type
                    ));
                }
                other => {
                    return Err(format!(
                        "会话条目查询返回了 {} 类型, 期望 custom",
                        other.entry_type()
                    ));
                }
            }
        }
        Ok(latest.map(|(_, data)| data))
    }

    // ── 会话生命周期 ────────────────────────────────────────────────────────

    /// 会话按需创建（§7-3 语义保持）：已有 = 原样复用；无 = 新建。
    pub fn ensure_session(&self, _ui_bridge: Option<UiBridgeHandle>) -> Result<(), String> {
        if self
            .shared
            .live
            .lock()
            .map_err(|_| "锁中毒".to_string())?
            .is_some()
        {
            return Ok(());
        }
        let live = self.build_harness(&self.shared.cwd, None)?;
        *self
            .shared
            .model_line
            .lock()
            .map_err(|_| "锁中毒".to_string())? = format!("{}/{}", live.provider, live.model_id);
        self.install_live(live)
    }

    /// 该路径是否就是当前活动会话。
    ///
    /// agui_run 的重开守卫：rpi 会话是**单写者**（writer lease 独占），
    /// 同一文件二次 open 必然 "writer lease is already held"。发消息的
    /// POST 带 sessionPath 时若已开着就复用，不重建 harness。
    pub fn is_live_session(&self, path: &str) -> Result<bool, String> {
        let guard = self
            .shared
            .live
            .lock()
            .map_err(|_| "引擎状态锁中毒".to_string())?;
        Ok(guard
            .as_ref()
            .and_then(|live| live.session_path.as_ref())
            .is_some_and(|p| p.to_string_lossy() == path))
    }

    /// 打开指定会话文件（rpi 恢复路径：args.session + allow_existing）。
    /// 返回会话 id（前端锚定用）。
    pub fn open_session(
        &self,
        path: &str,
        _ui_bridge: Option<UiBridgeHandle>,
    ) -> Result<String, String> {
        // 单写者租约守卫（与 agui 主柄同语义，但下沉到引擎层让所有调用方
        // 受益——IPC 的 pi_open_session / 前端切页签 / bot-launch 都走这里）：
        // 同一文件已是活动会话 = 直接复用；二次 build 必撞
        // "writer lease is already held"。
        if self.is_live_session(path)? {
            let live = self.live()?;
            return self.shared.rt.block_on(async {
                match live.harness.session().get_metadata().await {
                    Ok(m) => Ok(m.id),
                    Err(e) => Err(format!("会话元数据读取失败: {e}")),
                }
            });
        }
        // 之前切走/丢弃的同一会话：重新激活缓存的在场态（lease 仍在我们
        // 手里，重建会撞 "writer lease is already held"——见 retired 注释）。
        let cached = self
            .shared
            .retired
            .lock()
            .map_err(|_| "retired 会话表锁中毒".to_string())?
            .remove(&session_cache_key(Path::new(path)));
        if let Some(cached) = cached {
            let id = self.shared.rt.block_on(async {
                cached
                    .harness
                    .session()
                    .get_metadata()
                    .await
                    .map(|m| m.id)
                    .map_err(|e| format!("会话元数据读取失败: {e}"))
            })?;
            *self
                .shared
                .model_line
                .lock()
                .map_err(|_| "锁中毒".to_string())? =
                format!("{}/{}", cached.provider, cached.model_id);
            // 当前活动会话也要进 retired——否则它被直接 drop，lease 泄漏，
            // 下次切回它必撞 "already held"（实测切换链 A→B→A→B）。
            let previous = self
                .shared
                .live
                .lock()
                .map_err(|_| "锁中毒".to_string())?
                .replace(cached);
            self.retire_previous(previous)?;
            self.approvals.cleanup();
            self.asks.cleanup();
            return Ok(id);
        }
        // 文件损坏（header 丢失）→ 明确报错，不要让 rpi 报误导性的
        // "No session found"（见 preflight_session_file 注释）。
        preflight_session_file(path)?;
        // 跨工作区打开（2026-11-15 侧栏「选择文件夹」会话）：rpi 的
        // `--session <id>` 只在 `default_session_dir(cwd)` 里查找——用活动
        // 会话的 cwd 去开别的工作区的文件必然 "No session found"。
        // 会话文件形状 = `<cwd>/.rpi/sessions/<encoded-cwd>/<ts>_<id>.jsonl`，
        // 反推出它自己的工作区再 build。形状不符（自定义 sessionDir /
        // 旧布局）→ 继续用活动 cwd（旧行为，错误仍会由引擎传播）。
        let cwd = workspace_from_session_path(Path::new(path))
            .unwrap_or_else(|| self.shared.cwd.clone());
        let live = self.build_harness(&cwd, Some(path))?;
        let id = self.shared.rt.block_on(async {
            match live.harness.session().get_metadata().await {
                Ok(m) => m.id,
                Err(e) => format!("unknown({e})"),
            }
        });
        *self
            .shared
            .model_line
            .lock()
            .map_err(|_| "锁中毒".to_string())? = format!("{}/{}", live.provider, live.model_id);
        self.install_live(live)?;
        Ok(id)
    }

    /// New Chat 语义（§7-3 保持）：丢柄（会话文件已持久化在 rpi 侧）。
    pub fn discard_session(&self) -> Result<(), String> {
        let previous = self
            .shared
            .live
            .lock()
            .map_err(|_| "锁中毒".to_string())?
            .take();
        // 不 drop：同进程内再次打开该会话必须复用（lease 释放在引擎侧不可
        // 达），见 EngineShared::retired。
        self.retire_previous(previous)?;
        self.approvals.cleanup();
        self.asks.cleanup();
        Ok(())
    }

    /// 指定工作区新建（空）会话（侧栏「选择工作区」入口）。
    pub fn new_session_with_cwd(
        &self,
        cwd: &str,
        _ui_bridge: Option<UiBridgeHandle>,
    ) -> Result<String, String> {
        let live = self.build_harness(&PathBuf::from(cwd), None)?;
        let id = self.shared.rt.block_on(async {
            match live.harness.session().get_metadata().await {
                Ok(m) => m.id,
                Err(e) => format!("unknown({e})"),
            }
        });
        *self
            .shared
            .model_line
            .lock()
            .map_err(|_| "锁中毒".to_string())? = format!("{}/{}", live.provider, live.model_id);
        self.install_live(live)?;
        Ok(id)
    }

    // ── 对话 ────────────────────────────────────────────────────────────────

    /// 发一轮（纯文本）。on_event = rpi AgentEvent 流（agui.rs 映射到
    /// AG-UI 协议）；on_start = 拿到执行权、起跑前触发（RUN_STARTED 时点）。
    pub fn prompt(
        &self,
        text: &str,
        on_event: impl Fn(AgentEvent) + Send + Sync + 'static,
        on_start: Box<dyn FnOnce() + Send>,
    ) -> Result<(), String> {
        self.prompt_inner(text, Vec::new(), on_event, on_start)
    }

    /// 带图发一轮（AguiImage → rpi ImageContent；prompt_text 内部把
    /// text+images 组成 UserContent::Blocks）。
    pub fn prompt_with_content(
        &self,
        text: &str,
        images: &[AguiImage],
        on_event: impl Fn(AgentEvent) + Send + Sync + 'static,
        on_start: Box<dyn FnOnce() + Send>,
    ) -> Result<(), String> {
        let converted: Vec<ImageContent> = images
            .iter()
            .map(|img| ImageContent {
                kind: Default::default(),
                data: std::sync::Arc::from(img.data.as_str()),
                mime_type: img.mime_type.clone(),
            })
            .collect();
        self.prompt_inner(text, converted, on_event, on_start)
    }

    fn prompt_inner(
        &self,
        text: &str,
        images: Vec<ImageContent>,
        on_event: impl Fn(AgentEvent) + Send + Sync + 'static,
        on_start: Box<dyn FnOnce() + Send>,
    ) -> Result<(), String> {
        let live = self.live()?;
        let harness = Arc::clone(&live.harness);
        // 每轮 resubscribe（broadcast Receiver 不可 Clone——从本体重订尾部）
        let mut rx = live.events.resubscribe();
        on_start();
        self.shared.rt.block_on(async move {
            // 排水任务：broadcast 事件并发转发到 on_event。
            //
            // **必须显式停（2026-11-15 实锤：回复文本重复/穿插）**：旧实现
            // `drain.await` 等 sender 关闭，但 rpi 的 broadcast sender 在 run
            // 结束后并不保证关闭——任务永久挂起并继续订阅**后续 run** 的
            // 事件，每跑一轮多一个订阅者，于是同一 delta 被推送 N 次（实测
            // buffer 里相邻同 delta 对 314 组、UI 出现"这是这是这是这是…"）。
            // prompt 返回后给尾部事件一个短窗口，然后发停止信号并排空队列。
            let (stop_tx, mut stop_rx) = tokio::sync::watch::channel(false);
            let drain = tokio::spawn(async move {
                loop {
                    tokio::select! {
                        ev = rx.recv() => match ev {
                            Ok(ev) => on_event(ev),
                            Err(_) => break,
                        },
                        _ = stop_rx.changed() => {
                            // 停止：把已经进 broadcast 队列的事件排空再退出
                            while let Ok(ev) = rx.try_recv() {
                                on_event(ev);
                            }
                            break;
                        }
                    }
                }
            });
            let result = AgentLane::prompt_text(harness.as_ref(), text, images).await;
            // TURN_END/AGENT_END 在 prompt 返回前已 emit；30ms 让广播线程把
            // 尾部事件交付完，再停 drain（绝不 await 到 sender 关闭）。
            tokio::time::sleep(std::time::Duration::from_millis(30)).await;
            let _ = stop_tx.send(true);
            let _ = drain.await;
            result.map(|_| ()).map_err(|e| e.to_string())
        })
    }

    /// 中断当前 run（AgentLane::abort——rpi 无 AbortHandle，&self 可调）。
    pub fn interrupt(&self) -> Result<(), String> {
        let live = self.live()?;
        self.shared.rt.block_on(async {
            AgentLane::abort(live.harness.as_ref())
                .await
                .map(|_| ())
                .map_err(|e| e.to_string())
        })
    }

    // ── 扩展 UI 对话框（rpi runtime action 17：ask / permission）──────────────
    //
    // 真源 = 会话级 `UiDialogMailbox`（`HarnessLive::reload.ui_dialog`，
    // build 时已 attach——宿主就是那个"交互 UI"）。插件（rpi-ask-user /
    // rpi-permission-gate）经 ActionBridge 把请求投进邮箱，宿主取出、投影成
    // 前端卡片、应答经 `respond`/`cancel` 回灌；插件自己 poll 取答案。
    //
    // **取用策略**：`take_pending_filtered` 只取本命令认识的形状，不匹配的
    // 请求放回队尾（actions.rs:340）——ask 与审批共用一条队列，谁也不能把
    // 对方的请求吃掉。取出后请求离开 pending（仍在 active 里等应答），邮箱
    // 没有枚举 active 的 API，故宿主注册表负责回放重复拉取，并用
    // `is_pending` 剪掉已答/已取消/已超时的鬼影卡片。

    /// 把邮箱里新到的 ask 请求投影进 `AskRegistry`（前端 ask-bridge 的
    /// `PendingAsk[]` 数据面；命令层随后 `list()` 返回）。
    /// 无活动会话 = 空注册表（首启/New Chat 的预期态）。
    pub fn refresh_ask_pending(&self) -> Result<(), String> {
        let Some(live) = self.live_opt()? else {
            self.asks.cleanup();
            return Ok(());
        };
        let mailbox = live.reload.ui_dialog.clone();
        while let Some(request) =
            mailbox.take_pending_filtered(|r| ask_row(&r.ui, &r.request_id).is_some())
        {
            if let Some(row) = ask_row(&request.ui, &request.request_id) {
                self.asks.upsert(request.request_id, row);
            }
        }
        self.asks.retain(|id| mailbox.is_pending(id));
        Ok(())
    }

    /// 应答 ask 问题。`dismissed = true` → 取消（插件 ask_user 按
    /// "ask cancelled" 失败，与 TUI Esc 同语义）；否则把前端逐题应答映射成
    /// 插件 `answer_values` 认识的形状（`values` / `value` / `text`，
    /// 见 rpi-ask-user 的 answer_values 与 TUI 的应答块
    /// `rpi-cli/src/interactive_tui/extensions.rs:1000-1008`）。
    pub fn ask_response(
        &self,
        id: &str,
        answers: &[AskAnswerWire],
        dismissed: bool,
    ) -> Result<(), String> {
        let Some(live) = self.live_opt()? else {
            return Err(NO_ACTIVE_SESSION.to_string());
        };
        let mailbox = live.reload.ui_dialog.clone();
        if dismissed {
            mailbox
                .cancel(id)
                .map_err(|e| format!("取消 ask 请求失败: {e}"))?;
            self.asks.remove(id);
            return Ok(());
        }
        let row = self
            .asks
            .get(id)
            .ok_or_else(|| format!("没有挂起的 ask 请求 {id}"))?;
        let answer = ask_answer_value(&row, answers)?;
        mailbox
            .respond(id, answer)
            .map_err(|e| format!("ask 应答失败: {e}"))?;
        self.asks.remove(id);
        Ok(())
    }

    /// 挂起的审批/确认对话框（前端 approval-bridge 的 `PendingUiRequest[]`）。
    /// 无活动会话 = 空数组。
    pub fn pending_approvals(&self) -> Result<Vec<serde_json::Value>, String> {
        let Some(live) = self.live_opt()? else {
            self.approvals.cleanup();
            return Ok(Vec::new());
        };
        let mailbox = live.reload.ui_dialog.clone();
        while let Some(request) =
            mailbox.take_pending_filtered(|r| approval_row(&r.ui, &r.request_id).is_some())
        {
            if let Some(row) = approval_row(&request.ui, &request.request_id) {
                self.approvals
                    .upsert_dialog(request.request_id, request.ui.clone(), row);
            }
        }
        self.approvals.retain_dialogs(|id| mailbox.is_pending(id));
        Ok(self.approvals.list())
    }

    /// 应答审批/确认对话框。`cancelled = true` → 取消；否则按插件权限
    /// 语义把布尔决定映射成选项**标题**（rpi-permission-gate 只认第一个
    /// answer value 是否等于 "Yes"，且插件按 `options[].permission`
    /// 声明 allow_once / reject_once）。
    pub fn extension_ui_response(
        &self,
        id: &str,
        value: Option<serde_json::Value>,
        cancelled: bool,
    ) -> Result<(), String> {
        let Some(live) = self.live_opt()? else {
            return Err(NO_ACTIVE_SESSION.to_string());
        };
        let mailbox = live.reload.ui_dialog.clone();
        if cancelled {
            mailbox
                .cancel(id)
                .map_err(|e| format!("取消扩展 UI 请求失败: {e}"))?;
            self.approvals.remove_dialog(id);
            return Ok(());
        }
        let ui = self
            .approvals
            .dialog_ui(id)
            .ok_or_else(|| format!("没有挂起的扩展 UI 请求 {id}"))?;
        let answer = approval_answer_value(&ui, value.as_ref())?;
        mailbox
            .respond(id, answer)
            .map_err(|e| format!("扩展 UI 应答失败: {e}"))?;
        self.approvals.remove_dialog(id);
        Ok(())
    }

    // ── 会话管理面 ──────────────────────────────────────────────────────────

    /// 会话列表（rpi 会话根扫描：`<sessions_root>/**/*.jsonl`）。
    ///
    /// - **会话根与引擎同源**（`session_root`：settings.sessionDir 优先，
    ///   其次 `<workspace>/.rpi/sessions`）——原来硬编码 HOME 路径，改过
    ///   sessionDir 后列表与实际会话分叉。
    /// - **跳过 `*.jsonl.progress.jsonl` 边车文件**（进度镜像不是会话，
    ///   原实现把它当会话列出：空 id/空 cwd 的幽灵行）。
    /// - **name / messageCount 走 rpi 只读快照**（`JsonlSessionStorage::
    ///   read_snapshot` + `Session::get_name/get_stats`）：不抢写者租约，
    ///   语义与引擎 reducer 同源——原来只读首行，set_name 是 fact 条目
    ///   不在 header 里，重启后自定义名/消息数全丢。
    pub fn list_sessions(&self) -> Result<serde_json::Value, String> {
        let base = self.session_root(&self.shared.cwd);
        let mut rows: Vec<serde_json::Value> = Vec::new();
        // 会话目录还不存在 = 从没跑过会话（正常态：空列表，不是错误——
        // 与 cron jobs "文件不存在 = 空表" 同语义）。其它 IO 错误传播。
        let dirs = match std::fs::read_dir(&base) {
            Ok(d) => d,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Ok(serde_json::Value::Array(Vec::new()));
            }
            Err(e) => {
                return Err(format!("会话目录读取失败 {}: {e}", base.display()))
            }
        };
        let mut files_to_scan: Vec<(PathBuf, std::fs::Metadata)> = Vec::new();
        for d in dirs.flatten() {
            if !d.path().is_dir() {
                continue;
            }
            let files = match std::fs::read_dir(d.path()) {
                Ok(f) => f,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(e) => {
                    return Err(format!(
                        "会话子目录读取失败 {}: {e}",
                        d.path().display()
                    ))
                }
            };
            for f in files.flatten() {
                let path = f.path();
                if path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
                    continue;
                }
                // 进度边车（`<session>.jsonl.progress.jsonl`）不是会话。
                if path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n.ends_with(".progress.jsonl"))
                {
                    continue;
                }
                let meta = f.metadata().map_err(|e| e.to_string())?;
                files_to_scan.push((path, meta));
            }
        }
        if files_to_scan.is_empty() {
            return Ok(serde_json::Value::Array(Vec::new()));
        }
        // 只读快照：不抢 writer lease（活动会话也能列出），reducer 与引擎同源。
        let fs: Arc<dyn rpi_tools::FileSystem> = Arc::new(
            rpi_tools::os_env::OsExecutionEnv::with_cwd(self.shared.cwd.clone()),
        );
        let facts = self.shared.rt.block_on(async {
            let mut out = Vec::with_capacity(files_to_scan.len());
            for (path, meta) in &files_to_scan {
                let storage = match JsonlSessionStorage::read_snapshot(
                    fs.clone(),
                    &path.to_string_lossy(),
                    Arc::new(SystemClock),
                    Arc::new(DefaultIdGenerator::new()),
                )
                .await
                {
                    Ok(s) => s,
                    // 坏文件/半写：跳过该行但必须可见（不静默丢弃整表）
                    Err(e) => {
                        eprintln!("[pi] 会话快照读取失败 {}: {e}", path.display());
                        continue;
                    }
                };
                let session = Session::new(
                    Arc::new(storage) as Arc<dyn rpi_harness::session::types::SessionStorage>,
                    None,
                );
                let name = session.get_name().await.ok();
                let stats = session.get_stats().await.ok();
                out.push((path.clone(), meta.clone(), name, stats));
            }
            out
        });
        for (path, meta, name, stats) in facts {
            // 头信息（id/cwd）从首行取：只读一次小文件，不重放整棵树。
            let first = std::fs::read_to_string(&path)
                .ok()
                .and_then(|t| t.lines().next().map(String::from))
                .and_then(|l| serde_json::from_str::<serde_json::Value>(&l).ok());
            let (id, cwd) = match &first {
                Some(h) => (
                    h.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                    h.get("cwd").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                ),
                None => (String::new(), String::new()),
            };
            rows.push(serde_json::json!({
                "path": path.to_string_lossy(),
                "id": id,
                "cwd": cwd,
                "timestamp": "",
                "messageCount": stats.as_ref().map(|s| s.message_count),
                "lastModifiedMs": meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0),
                "sizeBytes": meta.len(),
                "name": name,
            }));
        }
        rows.sort_by(|a, b| {
            let av = a["lastModifiedMs"].as_u64().unwrap_or(0);
            let bv = b["lastModifiedMs"].as_u64().unwrap_or(0);
            bv.cmp(&av)
        });
        Ok(serde_json::Value::Array(rows))
    }

    /// 跨根会话索引（`pi_sessions_index` 的宿主侧实现，wire 形状见
    /// `session_index.rs` 模块头）。
    ///
    /// 与 `list_sessions` 的关系：后者只扫当前 cwd 的会话根且 wire 形状被
    /// 旧调用方钉死，**行为不变**；本方法额外扫 rpi settings 的 sessionDir
    /// 与每个已登记项目根的默认会话根，并为每条记录带出
    /// `parentSessionId` / `sourceRoot` / `skipped` 诊断。
    ///
    /// - 坏文件（缺 header / 半写 / 快照读失败）进 `skipped`，其余照常。
    /// - 同一个文件被多个根发现时按规范化路径去重（先到先得）。
    /// - `name` / `messageCount` 与 `list_sessions` 同源：只读快照
    ///   （`JsonlSessionStorage::read_snapshot` + `Session::get_name/get_stats`），
    ///   不抢 writer 租约。
    /// - settings.json 本身读不出来 = 整命令 Err（全局配置错误，不退回
    ///   默认根——否则「列表少了某个工作区」无法诊断）。
    pub fn index_sessions(
        &self,
        project_roots: &[String],
    ) -> Result<crate::session_index::IndexScan, String> {
        use crate::session_index as si;
        use std::collections::HashSet;

        let cwd = self.shared.cwd.clone();
        let settings = rpi_cli::settings::load_settings()
            .map_err(|e| format!("读 rpi 设置失败，无法确定 sessionDir: {e}"))?;

        let mut roots: Vec<si::ScanRoot> = Vec::new();
        if let Some(dir) = settings.session_dir.as_ref() {
            si::push_root(
                &mut roots,
                si::resolve_session_path(dir, &cwd),
                si::RootKind::SessionDir,
            );
        }
        for root in project_roots {
            let resolved = si::resolve_session_path(Path::new(root), &cwd);
            // 与 `session_root` 同语义：`default_session_dir` 可能返回
            // RPI_CODING_AGENT_SESSION_DIR 的相对值，必须相对该工作区解析。
            let default_dir = rpi_cli::session::default_session_dir(&resolved);
            si::push_root(
                &mut roots,
                si::resolve_session_path(&default_dir, &resolved),
                si::RootKind::ProjectRoot,
            );
        }
        let workspace_default = rpi_cli::session::default_session_dir(&cwd);
        si::push_root(
            &mut roots,
            si::resolve_session_path(&workspace_default, &cwd),
            si::RootKind::Workspace,
        );

        struct Candidate {
            path: PathBuf,
            source_root: String,
            source: si::RootKind,
            header: si::SessionHeader,
            modified: u64,
        }

        let mut skipped: Vec<si::SkippedSession> = Vec::new();
        let mut root_reports: Vec<si::RootReport> = Vec::new();
        let mut candidates: Vec<Candidate> = Vec::new();
        let mut seen: HashSet<String> = HashSet::new();

        for root in &roots {
            let scan = si::scan_root(root);
            skipped.extend(scan.problems);
            root_reports.push(scan.report);
            for path in scan.files {
                if !seen.insert(si::dedup_key(&path)) {
                    continue; // 同一个文件被前一个根发现过（根有重叠）
                }
                let header = match si::read_session_header(&path) {
                    Ok(header) => header,
                    Err(reason) => {
                        skipped.push(si::SkippedSession {
                            path: path.to_string_lossy().into_owned(),
                            root: root.path.clone(),
                            reason,
                        });
                        continue;
                    }
                };
                let metadata = match std::fs::metadata(&path) {
                    Ok(metadata) => metadata,
                    Err(e) => {
                        skipped.push(si::SkippedSession {
                            path: path.to_string_lossy().into_owned(),
                            root: root.path.clone(),
                            reason: format!("会话文件元数据读取失败: {e}"),
                        });
                        continue;
                    }
                };
                let modified = match metadata.modified() {
                    Ok(time) => match time.duration_since(std::time::UNIX_EPOCH) {
                        Ok(delta) => delta.as_millis() as u64,
                        Err(e) => {
                            skipped.push(si::SkippedSession {
                                path: path.to_string_lossy().into_owned(),
                                root: root.path.clone(),
                                reason: format!("会话文件修改时间早于 Unix 纪元: {e}"),
                            });
                            continue;
                        }
                    },
                    Err(e) => {
                        skipped.push(si::SkippedSession {
                            path: path.to_string_lossy().into_owned(),
                            root: root.path.clone(),
                            reason: format!("会话文件修改时间读取失败: {e}"),
                        });
                        continue;
                    }
                };
                candidates.push(Candidate {
                    path,
                    source_root: root.path.clone(),
                    source: root.kind,
                    header,
                    modified,
                });
            }
        }

        // 快照读取（name / messageCount）走引擎运行时；逐项结果带出来，
        // 错误在 await 之外落 skipped（避免跨 await 的 &mut 借用）。
        let fs: Arc<dyn rpi_tools::FileSystem> = Arc::new(
            rpi_tools::os_env::OsExecutionEnv::with_cwd(cwd.clone()),
        );
        let enriched = self.shared.rt.block_on(async {
            let mut out = Vec::with_capacity(candidates.len());
            for candidate in candidates {
                let storage = JsonlSessionStorage::read_snapshot(
                    fs.clone(),
                    &candidate.path.to_string_lossy(),
                    Arc::new(SystemClock),
                    Arc::new(DefaultIdGenerator::new()),
                )
                .await;
                let result = match storage {
                    Ok(storage) => {
                        let session = Session::new(
                            Arc::new(storage)
                                as Arc<dyn rpi_harness::session::types::SessionStorage>,
                            None,
                        );
                        let name = session.get_name().await.ok().flatten();
                        match session.get_stats().await {
                            Ok(stats) => Ok((name, stats.message_count)),
                            Err(e) => Err(format!("会话统计读取失败: {e}")),
                        }
                    }
                    Err(e) => Err(format!("会话快照读取失败: {e}")),
                };
                out.push((candidate, result));
            }
            out
        });

        let mut records: Vec<si::SessionRecord> = Vec::with_capacity(enriched.len());
        for (candidate, result) in enriched {
            match result {
                Ok((name, message_count)) => records.push(si::SessionRecord {
                    id: candidate.header.id,
                    path: candidate.path.to_string_lossy().into_owned(),
                    cwd: candidate.header.cwd,
                    name,
                    message_count,
                    last_modified: candidate.modified,
                    parent_session_id: candidate.header.parent_session_id,
                    project_id: None,
                    source_root: candidate.source_root,
                    source: candidate.source,
                }),
                Err(reason) => skipped.push(si::SkippedSession {
                    path: candidate.path.to_string_lossy().into_owned(),
                    root: candidate.source_root,
                    reason,
                }),
            }
        }
        records.sort_by(|a, b| {
            b.last_modified
                .cmp(&a.last_modified)
                .then_with(|| a.id.cmp(&b.id))
        });

        Ok(crate::session_index::IndexScan {
            sessions: records,
            skipped,
            roots: root_reports,
        })
    }

    /// 会话名持久化（rpi set_name fact）。
    pub fn rename_session(&self, name: &str) -> Result<(), String> {
        let live = self.live()?;
        let trimmed = name.trim();
        let name = if trimmed.is_empty() { None } else { Some(trimmed.to_string()) };
        self.shared.rt.block_on(async {
            live.harness
                .session()
                .set_name(name.as_deref())
                .await
                .map_err(|e| e.to_string())
        })
    }

    /// 删除会话文件（活动会话拒绝——与旧语义一致：先切走再删）。
    pub fn delete_session(&self, path: &str) -> Result<(), String> {
        let active_is_target = self
            .shared
            .live
            .lock()
            .map_err(|_| "锁中毒".to_string())?
            .as_ref()
            .and_then(|l| l.session_path.as_ref())
            .map(|p| p.to_string_lossy() == path)
            .unwrap_or(false);
        if active_is_target {
            return Err("活动会话不可删除（先切走）".into());
        }
        std::fs::remove_file(path).map_err(|e| format!("删除失败: {e}"))
    }

    /// 会话状态快照（形状与旧 pi_get_state 对齐）。
    ///
    /// model / thinkingLevel 读 **harness 真值**（AgentLane::get_model /
    /// get_thinking_level）：`HarnessLive` 的 provider/model_id 是构建时
    /// 快照，set_model 之后即过期——拿它回读会让模型选择器跳回旧模型
    /// （"切换看起来没生效"）。切换后的真值只有 harness 有。
    /// messageCount = `AgentHarness::get_stats().message_count`（会话级
    /// 累计，与新 wire 的消耗面同源）。
    pub fn state(&self) -> Result<serde_json::Value, String> {
        let live = self.live()?;
        let _model_line = self
            .shared
            .model_line
            .lock()
            .map_err(|_| "锁中毒".to_string())?
            .clone();
        let (model, thinking, session_id) = self.shared.rt.block_on(async {
            let model = AgentLane::get_model(live.harness.as_ref())
                .await
                .map_err(|e| format!("读当前模型失败: {e}"))?;
            let thinking = AgentLane::get_thinking_level(live.harness.as_ref())
                .await
                .map_err(|e| format!("读当前思考档位失败: {e}"))?;
            // sessionId = 会话 header id（与 pi_list_sessions 的 id、侧栏
            // threadId 同源）。**不是文件路径**——前端把 pi_get_state 的
            // sessionId 当 currentThreadId 用（fork/回父会话/成本入账）。
            let session_id = live
                .harness
                .session()
                .get_metadata()
                .await
                .map(|m| m.id)
                .map_err(|e| format!("读会话元数据失败: {e}"))?;
            Ok::<_, String>((model, thinking, session_id))
        })?;
        // messageCount 走会话文件的真值（与 pi_list_sessions 同源）。
        // harness.get_stats() 在**恢复出来的**会话上实测恒 0（usage/count
        // 聚合只覆盖运行态），不能拿来回报。
        let message_count = match live.session_path.as_deref() {
            Some(p) => self.snapshot_stats(&p.to_string_lossy())?.message_count,
            None => 0,
        };
        // ThinkingLevel 的 serde 拼法 = 上游 wire 拼法（off/minimal/…/xhigh/
        // max，rpi-ai types.rs 的 rename_all="lowercase"）——前端
        // composer-wired 按字符串回填档位。
        let thinking_level = serde_json::to_value(thinking)
            .map_err(|e| format!("思考档位序列化失败: {e}"))?;
        Ok(serde_json::json!({
            "sessionId": session_id,
            "provider": model.provider,
            "modelId": model.id,
            "thinkingLevel": thinking_level,
            "messageCount": message_count,
            "hasExtensions": false,
        }))
    }

    // ── 模型 / 思考档位面（2026-11-14 接 rpi 真能力）────────────────────────

    /// 模型目录（wire 形状 = 前端 `pi_list_models` 期望的
    /// `{ "models": [{ provider, id, name }] }`，消费方 =
    /// src/hermes-shim/hermes.ts 的 getGlobalModelOptions）。
    ///
    /// 真源 = `~/.rpi/agent/models.json`（= **用户已配置集**；前端注释同义：
    /// "pi 的 models.json 就是已配置集"，所以不混入内置目录、不做凭据过滤）。
    /// 空配置 → 空数组（真实状态，不是兜底）。provider 的 api 协议无法识别
    /// → Err：静默跳过会让目录整整少一个 provider 而无人知晓（规矩 12）。
    pub fn list_models(&self) -> Result<serde_json::Value, String> {
        let cfg = rpi_cli::config::load_models_config()
            .map_err(|e| format!("读 models.json 失败: {e}"))?;
        let mut rows: Vec<serde_json::Value> = Vec::new();
        for (provider_id, provider_cfg) in &cfg.providers {
            let models = rpi_cli::config::provider_to_models(provider_id, provider_cfg)
                .ok_or_else(|| {
                    format!(
                        "模型目录读取失败：provider {provider_id:?} 的 api 协议无法识别\
                         （{:?}；支持 anthropic-messages / openai-completions / \
                         openai-responses）",
                        provider_cfg.api
                    )
                })?;
            for m in models {
                // provider_to_models 已把缺省 name 落成 id（上游语义），这里照搬。
                // contextWindow：models.json 显式值优先；缺省 0 时用宿主侧
                // models.dev 目录回填（rpi 没有内置 registry）。
                let context_window = if m.context_window > 0 {
                    m.context_window
                } else {
                    crate::model_registry::lookup(&m.id).unwrap_or(0)
                };
                rows.push(serde_json::json!({
                    "provider": m.provider,
                    "id": m.id,
                    "name": m.name,
                    // 设置页默认模型列表要显示上下文窗口（模型选择器同用）。
                    // 2026-11-15 白屏根因：这里漏了该字段 → 前端
                    // `m.contextWindow.toLocaleString()` 抛 TypeError，
                    // 整个设置浮层被 React 卸成白屏。
                    "contextWindow": context_window,
                }));
            }
        }
        Ok(serde_json::json!({ "models": rows }))
    }

    /// 模型切换（§4.5 控制面）：在 models.json 已配置集里按 (provider, id)
    /// 精确取 `rpi_ai::Model`，交给 `AgentLane::set_model`（改 harness 的
    /// inner.model，下一轮 snapshot_config 起生效；跨 provider 靠 build 时
    /// 注册的全部已认证 provider 按 id 惰性路由）。
    ///
    /// 顺序 = **先 set 后写盘**（写盘 = pi_settings::persist_default_model 的
    /// settings.json 默认模型）。理由：set 成功后当前会话已按新模型跑，
    /// 写盘失败的双态是"当前会话新 / 下一条新会话旧"——用户重试即幂等收敛；
    /// 反序（先写盘）失败的双态是"默认已换 / 当前会话没换"，而前端选择器
    /// 只在命令成功后更新，界面上完全看不到变化，更难察觉。两条路径的失败
    /// 都 Err 传播（规矩 12），绝不假装成功。
    pub fn set_model(&self, provider: &str, model_id: &str) -> Result<(), String> {
        let live = self.live()?;
        let cfg = rpi_cli::config::load_models_config()
            .map_err(|e| format!("读 models.json 失败: {e}"))?;
        let provider_cfg = cfg.providers.get(provider).ok_or_else(|| {
            format!(
                "模型切换失败：models.json 没有 provider {provider:?}（已配置：{}）",
                cfg.providers.keys().cloned().collect::<Vec<_>>().join(", ")
            )
        })?;
        let models = rpi_cli::config::provider_to_models(provider, provider_cfg).ok_or_else(|| {
            format!(
                "模型切换失败：provider {provider:?} 的 api 协议无法识别\
                 （{:?}；支持 anthropic-messages / openai-completions / \
                 openai-responses）",
                provider_cfg.api
            )
        })?;
        let available: String = models
            .iter()
            .map(|m| m.id.as_str())
            .collect::<Vec<_>>()
            .join(", ");
        let model = models
            .into_iter()
            .find(|m| m.id == model_id)
            .ok_or_else(|| {
                format!(
                    "模型切换失败：provider {provider:?} 下没有模型 {model_id:?}\
                     （已配置：{available}）"
                )
            })?;
        self.shared.rt.block_on(async {
            AgentLane::set_model(live.harness.as_ref(), model)
                .await
                .map_err(|e| format!("切换模型失败: {e}"))
        })?;
        // 默认值写回：不写 → 新会话回旧默认（2026-10-26 历史坑："选哪个都用
        // 之前那个"）。失败必须传播——当前会话已切但默认未落，调用方要看得见。
        crate::pi_settings::persist_default_model(provider, model_id)?;
        *self
            .shared
            .model_line
            .lock()
            .map_err(|_| "锁中毒".to_string())? = format!("{provider}/{model_id}");
        Ok(())
    }

    /// 思考档位切换（§4.5 控制面）：字符串 → rpi 的 ThinkingLevel（合法值
    /// 用上游同一张表），经 `AgentLane::set_thinking_level` 落到 harness。
    ///
    /// 本轮**不写盘**：rpi 的 settings.json 有 default_thinking_level，但唯一
    /// 写入口 `rpi_cli::settings::save_settings` 要求传完整的 `Settings`——它
    /// 会把未覆盖的已知字段按 None 删除（defaultProvider/defaultModel/theme
    /// 等一起清掉），而 pi_settings 还没有同款"读-改-写"入口。故只改会话
    /// 真值；新会话仍按 settings.json / 模型 clamp 起跑，持久化待设置页接。
    pub fn set_thinking_level(&self, level: &str) -> Result<(), String> {
        let parsed = rpi_cli::args::parse_thinking_level(level).ok_or_else(|| {
            format!(
                "非法思考档位 {level:?}（合法值：{}）",
                rpi_cli::args::VALID_THINKING_LEVELS.join(", ")
            )
        })?;
        let live = self.live()?;
        self.shared.rt.block_on(async {
            AgentLane::set_thinking_level(live.harness.as_ref(), parsed)
                .await
                .map_err(|e| format!("设置思考档位失败: {e}"))
        })
    }

    // ── 旧 pi 独有面：如实降级（规矩 12——不静默不造假）────────────────────

    fn unavailable(name: &str) -> String {
        format!("rpi 引擎待接：{name}（rpi-main v0.24.0 尚无对应能力）")
    }

    /// 模式快照（前端 mode-store 每 2s 拉一次）：**只投影 rpi-plan-mode 的
    /// 会话条目**（customType `plan-mode`，data `{active, plan}`，见
    /// pi_plugin_state.rs）。
    ///
    /// - `active=true` → `planMode:"planning"`；false / 无条目 → `"off"`；
    /// - `planPending` 恒 null：rpi 插件没有宿主审批闸（`plan_mode_complete`
    ///   只存计划并退出），编一个 pending 卡只会得到必被 `pi_decide_plan`
    ///   Err 打回的按钮；
    /// - `approvalMode` 恒 null：rpi 没有 always-ask/write/yolo 概念（权限由
    ///   rpi-permissions 规则 + ask 对话框承担），不冒充任何模式。
    ///
    /// 无活动会话 = 默认快照（不是错误：mode-switch 挂载即轮询，首启时没有
    /// 会话是预期态）。
    pub fn mode_state(&self) -> Result<serde_json::Value, String> {
        // rpi 的「模式」= plan-mode 插件态 + 启动期权限闸开关
        // （permissionGate，RPI_PERMISSION_GATE=1 → bash/write/edit 每次确认）。
        // 该开关**只读**：扩展在会话构建时读 env，宿主没有运行时切换面。
        let gate = permission_gate_enabled();
        let mut wire = match self.live_opt()? {
            None => crate::pi_plugin_state::mode_wire(None)?,
            Some(live) => {
                let data = self.latest_plugin_entry(&live, crate::pi_plugin_state::PLAN_ENTRY)?;
                crate::pi_plugin_state::mode_wire(data.as_ref())?
            }
        };
        // **进程级真值**：rpi-plan-mode 的 active 是插件里的 static（不是会话
        // 条目；切会话时不落新条目，`activate()` 只做 false→true 的持久化）。
        // 只看会话条目会在"计划态切到另一个会话"时显示 off，而工具实际仍被
        // veto——用 `/plan status` 的 "Plan · Planning" 覆盖条目判断。
        if let Ok(status) = self.run_command("/plan", "status") {
            if let Some(text) = status.get("text").and_then(|v| v.as_str()) {
                if text.contains("Plan · Planning") {
                    wire["planMode"] = serde_json::json!("planning");
                } else if wire["planMode"] == serde_json::json!("planning") {
                    wire["planMode"] = serde_json::json!("off");
                }
            }
        }
        wire["permissionGate"] = serde_json::json!(gate);
        Ok(wire)
    }

    /// 目标态（活动面板「目标」分区）：rpi-goal 把状态存成当前分支的
    /// `goal-state` custom 条目（data = `{active, archived}`，见
    /// rpi-package/rpi-goal/src/lib.rs）。无条目 = Null（诚实空态）。
    pub fn goal_state(&self) -> Result<serde_json::Value, String> {
        let Some(live) = self.live_opt()? else {
            return Ok(serde_json::Value::Null);
        };
        Ok(self
            .latest_plugin_entry(&live, "goal-state")?
            .unwrap_or(serde_json::Value::Null))
    }

    pub fn set_approval_mode(&self, _mode: &str) -> Result<(), String> {
        Err("审批模式切换不可用：rpi 无 always-ask/write/yolo 三态概念（权限由 rpi-permissions / rpi-permission-gate 的规则文件与 ask 对话框承担），插件未暴露切换面".into())
    }

    /// 执行已注册的扩展 slash command（与 rpi-cli RPC `execute_command` 同一
    /// 套 handler 契约）：宿主用它触发 `/plan start|exit` 等扩展命令。
    ///
    /// 没有加载扩展 / 命令未知 / handler 返回非 JSON = Err（不静默）。
    pub fn run_command(&self, command: &str, args: &str) -> Result<serde_json::Value, String> {
        let live = self.live()?;
        let snapshot = {
            let session = live
                .reload
                .extension_session
                .lock()
                .map_err(|_| "扩展会话锁中毒".to_string())?;
            session.snapshot_arc()
        }
        .ok_or_else(|| format!("扩展命令不可用：当前会话没有加载扩展（{command}）"))?;
        let cmd = snapshot
            .commands()
            .iter()
            .find(|c| c.name.trim_start_matches('/') == command.trim_start_matches('/'))
            .ok_or_else(|| format!("未知扩展命令：{command}"))?;
        let input = serde_json::json!({ "command": command, "args": args }).to_string();
        let handler = cmd.handler;
        let user_data = cmd.user_data;
        let name = cmd.name.clone();
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let mut out = rpi_plugin_sdk::StbString::empty();
            let rc = handler(
                rpi_plugin_sdk::StbStringRef::from_str(&input),
                &mut out,
                user_data,
            );
            // SAFETY: the callback transfers its output using the host
            // allocator — same contract as rpi-cli's rpc_execute_command and
            // the TUI command invocation.
            let out = unsafe {
                rpi_plugin_sdk::callbacks::OwnedString::from_raw(
                    out,
                    Some(rpi_extensions::host_free_string),
                )
            };
            if rc != 0 {
                return Err(format!("扩展命令失败：{name}（code {rc}）"));
            }
            serde_json::from_str(&out.to_string_lossy())
                .map_err(|_| format!("扩展命令返回非 JSON：{name}"))
        }))
        .unwrap_or_else(|_| Err(format!("扩展命令 panic：{name}")))
    }

    pub fn set_plan_mode(&self, _enabled: bool) -> Result<(), String> {
        Err("plan 模式切换不可用：rpi-plan-mode 只注册 `/plan` 命令与 plan_mode_start / plan_mode_complete 工具，进入退出由插件自身完成；宿主只有读取面（pi_mode_state）".into())
    }

    pub fn decide_plan(&self, _approve: bool) -> Result<(), String> {
        Err("plan 审批决定不可用：rpi-plan-mode 没有宿主审批闸（plan_mode_complete 直接存盘并退出），不存在待审计划".into())
    }

    /// 待办状态（活动面板 Todo 分区拉取面）：重放当前分支上 rpi-todo 的
    /// 最新 `todo-state` 会话条目（插件每次变更经 AppendEntry 写一条自包含
    /// 快照），投影成旧 wire `{schema, list, summary}`（前端 todo-store）。
    ///
    /// 无活动会话 / 有会话但无条目 = 空态（schema null）；最新条目损坏 = Err
    /// （不把整表静默当空——与插件自身恢复失败 Blocked 同语义）。
    pub fn todo_state(&self) -> Result<serde_json::Value, String> {
        let Some(live) = self.live_opt()? else {
            return crate::pi_plugin_state::todo_wire(None);
        };
        let data = self.latest_plugin_entry(&live, crate::pi_plugin_state::TODO_ENTRY)?;
        crate::pi_plugin_state::todo_wire(data.as_ref())
    }

    /// 子代理名册：**不可投影**。rpi-subagents 的子代理是 `ChildAgent`
    /// runtime action（24）拉起的子进程，rpi-orchestrator 的 DAG 只在本进程
    /// 内存里；两者都不 AppendEntry、也不写 `SetStatus` 状态邮箱（源码证据
    /// 见 pi_plugin_state.rs 模块头）。宿主没有读取面——如实 Err，不拿工具
    /// 事件流拼一个假名册。
    pub fn hub_roster(&self) -> Result<serde_json::Value, String> {
        Err("hub 花名册不可用：rpi-subagents / rpi-orchestrator 的子代理运行态只存在于插件进程内存（ChildAgent runtime action 24 与进程内 DAG），不写会话条目、不写扩展状态邮箱——宿主无读取面".into())
    }

    pub fn hub_kill(&self, _agent_id: &str) -> Result<serde_json::Value, String> {
        Err("hub 终止子代理不可用：rpi-subagents 的 delegate_task 是同步子进程调用、rpi-orchestrator 的 dispatch 在插件进程内完成；两者都不暴露按子代理 id 终止的宿主面（rpi 无 agent_hub registry）".into())
    }

    pub fn hub_send(&self, _agent_id: &str, _body: &str) -> Result<serde_json::Value, String> {
        Err("hub 发送不可用：rpi-subagents / rpi-orchestrator 没有子代理收件箱（rpi 无 agent_hub），插件未暴露 steer/发送面".into())
    }

    pub fn hub_inbox(&self, _agent_id: &str) -> Result<serde_json::Value, String> {
        Err("hub 收件箱不可用：rpi-subagents / rpi-orchestrator 没有子代理收件箱（rpi 无 agent_hub），插件未暴露读取面".into())
    }

    pub fn hub_transcript(&self, _agent_id: &str) -> Result<serde_json::Value, String> {
        Err("hub 转写不可用：rpi-subagents 的子进程输出直接作为工具结果返回、rpi-orchestrator 的 DAG 只在插件进程内存；插件未暴露按 id 读取转写的宿主面".into())
    }

    /// 后台任务列表：rpi-background-tasks 插件未安装（`~/.rpi/agent/extensions`
    /// 无该 cdylib）；即便安装，它的 `background-tasks` 快照条目只有
    /// id/kind/label/command/status/pid/exitCode/startedAt，缺前端 Terminal
    /// 分区 wire 的 schema/artifactPath/artifactTruncated/outputTail/
    /// outputComplete 与 startedAtMs——投影只能靠编默认值（规矩 12 禁止），
    /// 故如实 Err。
    pub fn job_list(&self) -> Result<serde_json::Value, String> {
        Err("后台任务列表不可用：rpi-background-tasks 插件未安装（~/.rpi/agent/extensions 无该 cdylib），且其 background-tasks 快照条目只有 id/kind/label/command/status/pid/exitCode/startedAt，缺 Terminal 分区所需的 schema/artifactPath/outputTail/startedAtMs 字段".into())
    }

    pub fn job_cancel(&self, _job_id: &str) -> Result<serde_json::Value, String> {
        Err("后台任务取消不可用：宿主未安装 rpi-background-tasks 插件，没有任务表可取消".into())
    }

    /// 手动压缩（`AgentLane::compact(None)`）——rpi 在会话树上追加一条
    /// Compaction 条目（摘要 + retainedTail），压缩进度走常驻 AG-UI 流的
    /// CUSTOM name=compaction 到达前端，本命令只触发、不重复转发事件。
    /// 返回 `{ok:true}`（与旧 wire 一致）；Declined = 无事可压（上游正常
    /// 语义，不是失败）；Failed/Aborted 传播为 Err（规矩 12）。
    pub fn compact(&self) -> Result<serde_json::Value, String> {
        let live = self.live()?;
        let result = self.shared.rt.block_on(async {
            AgentLane::compact(live.harness.as_ref(), None)
                .await
                .map_err(|e| format!("手动压缩失败: {e}"))
        })?;
        match result.outcome {
            CompactionOutcome::Completed { .. } | CompactionOutcome::Declined { .. } => {
                Ok(serde_json::json!({ "ok": true }))
            }
            CompactionOutcome::Aborted { .. } => Err("手动压缩被中止（运行中 abort）".into()),
            CompactionOutcome::Failed { error, .. } => {
                Err(format!("手动压缩失败: {}", error.message))
            }
        }
    }

    /// 文件改动撤销 / 重做：**rpi-main v0.24.0 无对应能力**——旧 pi 的会话级
    /// FileMutationRecorder（记录每次 edit/write 的前后内容）在 rpi 里没有
    /// 任何等价实现（rpi-durable 的日志是运行/工具执行恢复用的，不含文件
    /// 内容快照），故如实 Err。
    pub fn undo_redo(&self, _kind: &str, _n: usize, _force: bool) -> Result<serde_json::Value, String> {
        Err("undo/redo 不可用：rpi-main v0.24.0 无会话级 FileMutationRecorder（文件改动前后快照），rpi-durable 仅记录运行/工具执行恢复日志".into())
    }

    pub fn undo_history(&self) -> Result<serde_json::Value, String> {
        Err("undo 历史不可用：rpi-main v0.24.0 无会话级 FileMutationRecorder（无可撤销单元清单）".into())
    }

    /// 回退到检查点：**rpi-main v0.24.0 无用户会话检查点/rewind 语义**。
    /// `navigate_tree` 只能移动分支叶（不截断 active context、不折叠摘要）；
    /// rpi-durable 的 RunCheckpoint/ToolCheckpoint 是崩溃恢复用的执行日志，
    /// 与"用户打点后回退对话上下文"不是同一回事，故如实 Err。
    pub fn rewind(&self, _checkpoint_id: &str) -> Result<serde_json::Value, String> {
        Err("rewind 不可用：rpi-main v0.24.0 无用户会话检查点与上下文截断/摘要折叠（rpi-durable 的 RunCheckpoint 是崩溃恢复执行日志，非对话检查点）".into())
    }

    /// 检查点标记：**保持 Err**。rpi 只有条目级 label（`SessionTree::
    /// get_label/set_label`，自由字符串）与 Custom 条目，但 checkpoint 的
    /// 语义内核（rewind 截断 active context + 摘要折叠）在 rpi 不存在——
    /// 只打点不能回退等于假功能，故与 rewind 一并如实降级。
    pub fn mark_checkpoint(&self, _label: Option<String>) -> Result<serde_json::Value, String> {
        Err("检查点不可用：rpi-main v0.24.0 无检查点/rewind 语义（只有条目级 label，不能截断上下文回退）".into())
    }

    pub fn list_checkpoints(&self) -> Result<serde_json::Value, String> {
        Err("检查点清单不可用：rpi-main v0.24.0 无用户会话检查点（rpi 的 label API 是树节点自由标签，不是可回退检查点）".into())
    }

    /// 编辑重跑准备（/retry 语义）：与旧 pi `prepare_retry_branch` 同义——
    /// 把分支叶移到**最后一个 user 消息的父级**（被放弃的 turn 及其回复保留
    /// 在会话树里，前端下一次 POST 把重发落成兄弟分支）。返回
    /// `{text, abandonedEntryId}`（text 供 composer 回填）。
    ///
    /// rpi 的公开面只有 `AgentLane::navigate_tree`（v1 只做叶移动，不做
    /// 分支摘要），正好覆盖本命令需要的动作；run 进行中由 navigate_tree
    /// 返回 lane_busy（前端先 interrupt，同旧语义）。
    pub fn retry_edit(&self) -> Result<serde_json::Value, String> {
        let live = self.live()?;
        let entries = self.branch_message_entries(&live)?;
        let mut target = None;
        for entry in &entries {
            let Entry::Message(message) = entry else {
                continue;
            };
            let rpi_agent::message::AgentMessage::User(user) = &message.message else {
                continue;
            };
            target = Some((
                extract_user_text(&user.content).unwrap_or_default(),
                message.base.id.clone(),
                message.base.parent_id.clone(),
            ));
        }
        let Some((text, abandoned_entry_id, parent_id)) = target else {
            return Err("no retryable user turn".into());
        };
        let outcome = self.shared.rt.block_on(async {
            AgentLane::navigate_tree(live.harness.as_ref(), parent_id.as_deref(), false, None, None)
                .await
                .map_err(|e| format!("retry 分支准备失败: {e}"))
        })?;
        navigation_ok(outcome.outcome).map_err(|e| format!("retry 分支准备失败: {e}"))?;
        Ok(serde_json::json!({
            "text": text,
            "abandonedEntryId": abandoned_entry_id,
        }))
    }

    /// 从指定 user 消息 fork 新会话（旧 wire：`{path, sessionId,
    /// selectedText}`）：新会话叶 = 选中消息的**父级**（选中消息不进新文件，
    /// 前端把 selectedText 预填 composer 重新提交即新分支）。
    ///
    /// rpi 的公开面 = `JsonlSessionRepo::fork_typed` + `ForkOptions::Branch
    /// { entry_id, position: Before }`（repo.rs:347 / state.rs:346-351：
    /// Before 的叶取 `entry.parent_id`），随后复用 `open_session` 换装
    /// （rpi 写者租约单写者——fork 出来的 storage 先显式释放租约再重开）。
    pub fn fork_session(
        &self,
        entry_id: &str,
        ui_bridge: Option<UiBridgeHandle>,
    ) -> Result<serde_json::Value, String> {
        let live = self.live()?;
        // 旧 pi fork 的 reject_if_run_in_progress 同款守卫：run 在飞时复制
        // 会话文件会拿到半轮写入。前端已先 interrupt，这里再兜一道（错误
        // 可见，不静默继续）。snapshot() 的 active 是公开读模型。
        let snapshot = self
            .shared
            .rt
            .block_on(live.harness.snapshot())
            .map_err(|e| format!("会话状态读取失败: {e}"))?;
        if let Some(active) = snapshot.active {
            return Err(format!(
                "run in progress: interrupt the active run before forking the session (run {})",
                active.run_id
            ));
        }
        // fork 点必须**在当前分支上**且是 user 消息（旧 pi plan_fork 同款校验）。
        let (selected_text, source_id) = self.shared.rt.block_on(async {
            let session = live.harness.session();
            let entries = session
                .find_entries_on_branch(
                    &EntryQuery {
                        entry_id: Some(entry_id.to_string()),
                        order: Some(EntryOrder::OldestFirst),
                        ..Default::default()
                    },
                    &BranchBounds::default(),
                )
                .await
                .map_err(|e| format!("fork 点校验失败: {e}"))?;
            let Some(Entry::Message(message)) = entries.into_iter().next() else {
                return Err(format!("fork 点 {entry_id:?} 不在当前分支上"));
            };
            let rpi_agent::message::AgentMessage::User(user) = &message.message else {
                return Err(format!("fork 点 {entry_id:?} 不是 user 消息"));
            };
            let text = extract_user_text(&user.content).unwrap_or_default();
            let id = session
                .get_metadata()
                .await
                .map(|m| m.id)
                .map_err(|e| format!("读会话元数据失败: {e}"))?;
            Ok::<_, String>((text, id))
        })?;
        let source = self.session_metadata_in(&live.sessions_root, &source_id)?;
        let repo = self.jsonl_repo(&live.sessions_root);
        let storage = self
            .shared
            .rt
            .block_on(repo.fork_typed(
                &source,
                &JsonlSessionCreateOptions {
                    id: None,
                    parent_session_id: Some(source.id.clone()),
                    cwd: source.cwd.clone(),
                    metadata: None,
                },
                &ForkOptions::Branch {
                    entry_id: Some(entry_id.to_string()),
                    position: Some(ForkPosition::Before),
                },
            ))
            .map_err(|e| format!("fork 会话创建失败: {e}"))?;
        let forked = storage.jsonl_metadata();
        // fork 出来的 storage 持有新文件的写者租约；open_session 要重新拿同一
        // 租约——先显式释放再丢弃绑定，否则 "writer lease is already held"。
        storage.release_writer_lease();
        drop(storage);
        let forked_path = forked.path.clone();
        self.open_session(&forked_path, ui_bridge)?;
        Ok(serde_json::json!({
            "path": forked_path,
            "sessionId": forked.id,
            "selectedText": selected_text,
        }))
    }

    /// fork 点清单 = 当前分支上的 user 消息（旧 wire `[{entryId, text}]`，
    /// 顺序与前端 thread 的 user 消息一一对应）。无文本块（纯图片消息）时
    /// text = null——与旧 pi `extract_user_text` 同语义（前端会把该清单整份
    /// 丢弃，诚实禁用 fork 钮，不做错位映射）。
    pub fn get_fork_points(&self) -> Result<serde_json::Value, String> {
        let live = self.live()?;
        let entries = self.branch_message_entries(&live)?;
        let rows: Vec<serde_json::Value> = entries
            .iter()
            .filter_map(|entry| {
                let Entry::Message(message) = entry else {
                    return None;
                };
                let rpi_agent::message::AgentMessage::User(user) = &message.message else {
                    return None;
                };
                Some(serde_json::json!({
                    "entryId": message.base.id,
                    "text": extract_user_text(&user.content),
                }))
            })
            .collect();
        Ok(serde_json::Value::Array(rows))
    }

    /// 最近分叉点的兄弟分支（旧 wire：null | `{forkPointId, branches:
    /// [{rootId, leafId, preview, messageCount, isCurrent}]}`）。
    ///
    /// rpi 没有现成 `sibling_branches` API，但会话树就是条目集（id/parentId
    /// 成链）——按旧 pi 语义自行投影：最近分叉点 = 当前叶向根走第一个孩子
    /// 数 >= 2 的节点；每条分支 leaf = 首子链末端；preview = 该路径上**最靠
    /// 根**的非空 user 文本；messageCount = 叶到会话根的 message 条目数；
    /// isCurrent = 该分支的 root 是当前叶路径上分叉点的那个孩子。
    pub fn list_sibling_branches(&self) -> Result<serde_json::Value, String> {
        let live = self.live()?;
        let (entries, leaf) = self.shared.rt.block_on(async {
            let session = live.harness.session();
            let entries = session
                .find_entries(&EntryQuery {
                    order: Some(EntryOrder::OldestFirst),
                    ..Default::default()
                })
                .await
                .map_err(|e| format!("会话树读取失败: {e}"))?;
            let leaf = session
                .get_leaf_id()
                .await
                .map_err(|e| format!("读当前叶失败: {e}"))?;
            Ok::<_, String>((entries, leaf))
        })?;
        Ok(sibling_branches_json(&entries, leaf.as_deref()))
    }

    /// 切换到指定叶（分支导航）。`AgentLane::navigate_tree` 是 rpi 公开的
    /// 会话树移动面（v1 只移动 lane 叶，不做分支摘要——本命令正好只需要
    /// 移动）；返回旧 wire `{leafId}`，前端随后重拉 pi_get_messages 水合。
    pub fn switch_branch(&self, leaf_id: &str) -> Result<serde_json::Value, String> {
        let live = self.live()?;
        let outcome = self.shared.rt.block_on(async {
            AgentLane::navigate_tree(live.harness.as_ref(), Some(leaf_id), false, None, None)
                .await
                .map_err(|e| format!("分支切换失败: {e}"))
        })?;
        navigation_ok(outcome.outcome).map_err(|e| format!("分支切换失败: {e}"))?;
        Ok(serde_json::json!({ "leafId": leaf_id }))
    }

    /// 当前会话的 fork 谱系（旧 wire = 父会话**文件路径**或 null；前端拿它
    /// 渲染会话线并「回到父会话」→ pi_open_session）。
    ///
    /// rpi 的 fork 在 v4 header 里写 `parentSessionId`（repo.rs:407-411），
    /// 旧 wire 要的是路径——按 id 在会话根里反查一次（`find_session_metadata`
    /// 本来就同时接受 id/path，路径更贴合前端消费面）。无父会话 = Ok(None)。
    pub fn session_lineage(&self) -> Result<Option<String>, String> {
        let live = self.live()?;
        let parent_id = self
            .shared
            .rt
            .block_on(live.harness.session().get_metadata())
            .map_err(|e| format!("读会话元数据失败: {e}"))?
            .parent_session_id;
        match parent_id {
            None => Ok(None),
            Some(parent_id) => Ok(Some(
                self.session_metadata_in(&live.sessions_root, &parent_id)?.path,
            )),
        }
    }

    /// 每会话 tokens/cost 汇总（侧栏 rowMeta 数据源）：旧 wire
    /// `{path: {totalTokens, costUsd}}`。
    ///
    /// 数据面 = **会话文件本身**（每行的 assistant `usage` 记录）。活动与
    /// 非活动会话统一走 `snapshot_stats` 的只读行扫描：`AgentHarness::
    /// get_stats()` 在恢复出来的会话上实测恒 0（usage 聚合只有运行态），
    /// 拿它当权威会让重启后的历史会话显示 0 用量。文件是持久真相，扫描
    /// 规则与 pi_usage.rs 同源。单个文件失败 = 整个命令 Err（不静默补 0）。
    pub fn sessions_usage(&self, paths: &[String]) -> Result<serde_json::Value, String> {
        let mut out = serde_json::Map::new();
        for path in paths {
            let stats = self.snapshot_stats(path)?;
            out.insert(
                path.clone(),
                serde_json::json!({
                    "totalTokens": stats.total_tokens,
                    "costUsd": stats.cost_total,
                }),
            );
        }
        Ok(serde_json::Value::Object(out))
    }

    /// 非活动会话文件的只读用量（不抢写者租约、不修文件）。
    ///
    /// **实测（2026-11-14）**：`read_snapshot` 出来的只读快照上
    /// `Session::get_stats()` 恒返回 0——usage 聚合是 harness 运行态的面，
    /// 冷重放不重建它。这里按行扫描 assistant `usage`（规则与 pi_usage.rs
    /// 的会话聚合同源：totalTokens / cacheRead / input / cost.total）。
    fn snapshot_stats(&self, path: &str) -> Result<SessionStats, String> {
        let raw = std::fs::read_to_string(path)
            .map_err(|e| format!("会话文件读取失败 {path}: {e}"))?;
        let mut stats = SessionStats::default();
        // 半行/撕裂缝容错：只跳过无法解析的行（append-only 日志的合法尾部），
        // 文件级 IO 失败上面已传播。
        for line in raw.lines() {
            let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
                continue;
            };
            if v.get("kind").and_then(|k| k.as_str()) != Some("entry") {
                continue;
            }
            let Some(msg) = v.get("message") else { continue };
            match msg.get("role").and_then(|r| r.as_str()) {
                Some("user") | Some("assistant") => stats.message_count += 1,
                _ => continue,
            }
            if msg.get("role").and_then(|r| r.as_str()) != Some("assistant") {
                continue;
            }
            let Some(usage) = msg.get("usage") else { continue };
            let num = |v: Option<&serde_json::Value>| v.and_then(|x| x.as_i64()).unwrap_or(0);
            stats.total_tokens += num(usage.get("totalTokens"));
            stats.cached_tokens += num(usage.get("cacheRead"));
            stats.uncached_tokens += num(usage.get("input"));
            stats.cost_total += usage
                .get("cost")
                .and_then(|c| c.get("total"))
                .and_then(|t| t.as_f64())
                .unwrap_or(0.0);
        }
        Ok(stats)
    }

    /// 导出会话为独立 HTML 文档（旧 wire = **完整 HTML 文本**，落盘由前端
    /// save 对话框 + fs_write_text_file 完成）。
    ///
    /// 渲染面 = `rpi_cli::export`（pub）：活动会话走 `export_session`
    /// （harness 真值 + unsaved 恢复副本）；非活动会话走 `export_file`
    /// （直接解析 v4 JSONL，不打开会话、不抢租约）。两者都写文件而不是返回
    /// String，故导出到系统临时目录 → 读回 → 删除（清理失败仅 stderr 可见，
    /// 不影响已成功的导出）。
    pub fn export_session_html(&self, path: &str) -> Result<String, String> {
        let is_active = {
            let guard = self
                .shared
                .live
                .lock()
                .map_err(|_| "引擎状态锁中毒".to_string())?;
            guard
                .as_ref()
                .and_then(|live| live.session_path.as_ref())
                .is_some_and(|p| p.to_string_lossy() == path)
        };
        let tmp = std::env::temp_dir().join(format!(
            "mirach-session-export-{}.html",
            uuid::Uuid::new_v4()
        ));
        let exported = if is_active {
            let live = self.live()?;
            self.shared.rt.block_on(rpi_cli::export::export_session(
                live.harness.as_ref(),
                rpi_cli::export::ExportFormat::Html,
                &tmp,
            ))
        } else {
            rpi_cli::export::export_file(Path::new(path), &tmp)
        };
        if let Err(e) = exported {
            let _ = std::fs::remove_file(&tmp);
            return Err(format!("会话 HTML 导出失败: {e}"));
        }
        let html = match std::fs::read_to_string(&tmp) {
            Ok(html) => html,
            Err(e) => {
                let _ = std::fs::remove_file(&tmp);
                return Err(format!("导出结果读取失败 {}: {e}", tmp.display()));
            }
        };
        if let Err(e) = std::fs::remove_file(&tmp) {
            eprintln!("[pi] 导出临时文件清理失败 {}: {e}", tmp.display());
        }
        Ok(html)
    }

    /// 会话时间线标记（旧 wire `[{kind:'modelChange'|'compact',
    /// beforeMessageIndex, provider?, modelId?}]`，索引与 pi_get_messages 的
    /// 消息下标对齐）。真源 = rpi 会话条目 `Entry::ModelChange` /
    /// `Entry::Compaction`（types.rs:249/274），沿当前分支扫描；计数口径与
    /// 水合同口径——只数 user/assistant（toolResult 并进 assistant 部件，
    /// 计进去索引会系统性偏大）。
    pub fn timeline_markers(&self) -> Result<serde_json::Value, String> {
        let live = self.live()?;
        let entries = self.shared.rt.block_on(async {
            live.harness
                .session()
                .find_entries_on_branch(
                    &EntryQuery {
                        order: Some(EntryOrder::OldestFirst),
                        ..Default::default()
                    },
                    &BranchBounds::default(),
                )
                .await
                .map_err(|e| format!("会话条目读取失败: {e}"))
        })?;
        let mut markers: Vec<serde_json::Value> = Vec::new();
        let mut message_index: usize = 0;
        for entry in &entries {
            match entry {
                Entry::Message(message) => {
                    if matches!(
                        message.message,
                        rpi_agent::message::AgentMessage::User(_)
                            | rpi_agent::message::AgentMessage::Assistant(_)
                    ) {
                        message_index += 1;
                    }
                }
                Entry::ModelChange(change) => markers.push(serde_json::json!({
                    "kind": "modelChange",
                    "beforeMessageIndex": message_index,
                    "provider": change.provider,
                    "modelId": change.model_id,
                })),
                Entry::Compaction(_) => markers.push(serde_json::json!({
                    "kind": "compact",
                    "beforeMessageIndex": message_index,
                })),
                _ => {}
            }
        }
        Ok(serde_json::Value::Array(markers))
    }

    /// 会话消息历史（水合面）：旧 wire = pi `Message` 序列化数组
    /// （`{role:'user'|'assistant'|'toolResult', content, timestamp, …}`），
    /// 消费方 = `src/components/assistant-ui/pi-hydrate.ts` 的
    /// hydratePiMessages（user 内容块 / assistant 的 text·thinking·image·
    /// toolCall / toolResult 按 toolCallId 归并）。
    ///
    /// 真源 = 当前分支上的 message 条目，按 seq 升序；序列化形状即 rpi 落盘
    /// 的 `AgentMessage`（多一个 `kind` 判别字段——与 main.rs 的
    /// `pi_get_session_messages` 静态面板输出同形，前端忽略该字段）。
    /// 不投影 Compaction 摘要：UI 展示完整对话历史（与静态面板/时间线标记
    /// 的条目口径一致），压缩摘要消息不是用户可见回合。
    pub fn messages(&self) -> Result<serde_json::Value, String> {
        let live = self.live()?;
        let entries = self.branch_message_entries(&live)?;
        let mut out = Vec::with_capacity(entries.len());
        for entry in entries {
            let Entry::Message(message) = entry else {
                continue;
            };
            out.push(
                serde_json::to_value(&message.message)
                    .map_err(|e| format!("消息序列化失败: {e}"))?,
            );
        }
        Ok(serde_json::Value::Array(out))
    }

    pub fn create_bot_session(
        &self,
        provider: Option<String>,
        model: Option<String>,
        system_prompt: Option<String>,
        cwd: Option<String>,
        enabled_tools: Option<Vec<String>>,
        _ui_bridge: Option<UiBridgeHandle>,
    ) -> Result<String, String> {
        // hermes/旧 pi 的 bot 会话 = **带 system_prompt 与（可选）模型覆盖的
        // 新会话**（不是普通会话加壳）：机器人自己的 SOUL 提示就是它的身份。
        // rpi 侧等价面：resolve 带 provider/model 覆盖 → build → set_system_prompt
        // → set_active_tools → 作为活动会话。cwd 缺省 = 默认工作区。
        let cwd = cwd
            .map(PathBuf::from)
            .unwrap_or_else(|| self.shared.cwd.clone());
        let live = self.build_harness_with(
            &cwd,
            None,
            provider.as_deref(),
            model.as_deref(),
        )?;
        if let Some(prompt) = system_prompt {
            self.shared
                .rt
                .block_on(live.harness.set_system_prompt(Some(prompt)))
                .map_err(|e| format!("bot 会话系统提示设置失败: {e}"))?;
        }
        if let Some(tools) = enabled_tools {
            self.shared
                .rt
                .block_on(AgentLane::set_active_tools(live.harness.as_ref(), tools))
                .map_err(|e| format!("bot 会话工具集设置失败: {e}"))?;
        }
        let id = self.shared.rt.block_on(async {
            live.harness
                .session()
                .get_metadata()
                .await
                .map(|m| m.id)
                .map_err(|e| format!("bot 会话元数据读取失败: {e}"))
        })?;
        *self
            .shared
            .model_line
            .lock()
            .map_err(|_| "锁中毒".to_string())? = format!("{}/{}", live.provider, live.model_id);
        // 走 install_live：旧活动会话进 retired（保住 writer lease），
        // 否则 bot 会话建立后切回旧会话必撞 lease。
        self.install_live(live)?;
        Ok(id)
    }

    // ── 分栏（v7.4 多柄）——rpi v1 非 main lane 拒绝 run 操作 ────────────────

    pub fn side_open(
        &self,
        _thread: &str,
        _path: &str,
        _ui_bridge: UiBridgeHandle,
    ) -> Result<(), String> {
        Err(Self::unavailable("分栏（rpi 非 main lane 只读）"))
    }

    pub fn side_prompt(
        &self,
        _thread: &str,
        _text: &str,
        _images: &[AguiImage],
        _on_event: impl Fn(AgentEvent) + Send + Sync + 'static,
        _on_start: Box<dyn FnOnce() + Send>,
    ) -> Result<(), String> {
        Err(Self::unavailable("分栏 prompt（rpi 非 main lane 只读）"))
    }

    pub fn side_interrupt(&self, _thread: &str) -> Result<(), String> {
        Err(Self::unavailable("分栏中断（rpi 非 main lane 只读）"))
    }

    // ── flush（旧调用点兼容）──────────────────────────────────────────────

    // rpi 的 durable session 逐条落盘，旧链路的 flush_active_session 无操作
    // 且已无调用点——随 pi_agent_rust 删除轮一并移除。
}

// ── 扩展 UI 载荷映射（纯函数，可单测）──────────────────────────────────────

/// 前端 `pi_ask_response` 的逐题应答（src/components/assistant-ui/
/// ask-bridge.ts 的 `AskAnswer` 同形，camelCase）。
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AskAnswerWire {
    /// 前端带回的题目 id。rpi 的 ask_user 一次请求只有一个问题、应答只读
    /// values/text，故宿主不消费它——保留纯为 wire 形状兼容。
    #[allow(dead_code)]
    #[serde(default)]
    pub question_id: Option<String>,
    #[serde(default)]
    pub selected: Vec<String>,
    #[serde(default)]
    pub other: Option<String>,
}

/// JSON 字符串字段：首个非空（trim 后）值。与 rpi TUI 的 `ask_user_str`
/// 同语义（rpi-cli/src/interactive_tui/extensions.rs:699-708）。
fn json_str(value: &serde_json::Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        value
            .get(*key)
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .map(str::to_string)
    })
}

fn json_bool(value: &serde_json::Value, keys: &[&str]) -> Option<bool> {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(serde_json::Value::as_bool))
}

/// 选项 → 前端 `AskOption`（`{label, description?}`）。
///
/// rpi-ask-user 的选项是 `{"title": …, "description"?: …}`；兼容裸字符串与
/// 旧 label/text 键（rpi TUI `ask_user_options` 的键表，extensions.rs:731）。
fn option_rows(value: &serde_json::Value) -> Vec<serde_json::Value> {
    let Some(items) = value.get("options").and_then(serde_json::Value::as_array) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for item in items {
        if let Some(title) = item.as_str() {
            let title = title.trim();
            if !title.is_empty() {
                out.push(serde_json::json!({ "label": title }));
            }
            continue;
        }
        let Some(label) = json_str(item, &["title", "label", "text", "value", "name"]) else {
            continue;
        };
        let mut row = serde_json::json!({ "label": label });
        if let Some(description) = json_str(item, &["description"]) {
            row["description"] = serde_json::json!(description);
        }
        out.push(row);
    }
    out
}

/// permission-gate 的对话框（rpi-plugin-sdk dialogs.rs 契约）：
/// `purpose:"permission"`；兼容老的「kind=confirm + options[].permission」。
fn is_permission_ui(ui: &serde_json::Value) -> bool {
    if ui.get("purpose").and_then(serde_json::Value::as_str) == Some("permission") {
        return true;
    }
    ui.get("kind").and_then(serde_json::Value::as_str) == Some("confirm")
        && ui
            .get("options")
            .and_then(serde_json::Value::as_array)
            .is_some_and(|options| {
                options
                    .iter()
                    .any(|option| option.get("permission").and_then(serde_json::Value::as_str).is_some())
            })
}

/// ask 请求 → 前端 `PendingAsk`（`{id, request:{questions:[AskQuestion]}}`）。
///
/// rpi-ask-user 每次请求一个问题（`ui` 是扁平 question：kind/question/
/// options/allowMultiple/…，见其 `to_ui`）；同时接受批量的 `questions[]`
/// 形状（只影响映射，不影响应答——应答仍是整条请求一组 values）。
/// 非 ask 形状（permission）或没有题目文本 = None：谓词不放行，
/// 请求留在邮箱里给审批命令。
fn ask_row(ui: &serde_json::Value, request_id: &str) -> Option<serde_json::Value> {
    if is_permission_ui(ui) {
        return None;
    }
    let kind = ui
        .get("kind")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("selector");
    let items: Vec<&serde_json::Value> = match ui.get("questions").and_then(serde_json::Value::as_array) {
        Some(items) => items.iter().collect(),
        None => vec![ui],
    };
    let mut questions: Vec<serde_json::Value> = Vec::new();
    for item in items {
        let Some(question) = json_str(item, &["question", "summary", "title"]) else {
            continue;
        };
        let mut row = serde_json::json!({
            "question": question,
            "options": option_rows(item),
            // confirm 语义恒单选（rpi TUI 同款：kind=="confirm" 强制单选，
            // extensions.rs:856）。
            "multi": kind != "confirm"
                && json_bool(item, &["allowMultiple", "allow_multiple", "multiple"])
                    .unwrap_or(false),
        });
        if let Some(id) = json_str(item, &["id", "questionId"]) {
            row["id"] = serde_json::json!(id);
        }
        if let Some(header) = json_str(item, &["header"]) {
            row["header"] = serde_json::json!(header);
        }
        questions.push(row);
    }
    if questions.is_empty() {
        return None;
    }
    Some(serde_json::json!({
        "id": request_id,
        "request": { "questions": questions },
    }))
}

/// 审批对话框 → 前端 `PendingUiRequest`
/// （`{id, method, payload, extensionId}`）。
fn approval_row(ui: &serde_json::Value, request_id: &str) -> Option<serde_json::Value> {
    if !is_permission_ui(ui) {
        return None;
    }
    // approval-cards 只对 method === "confirm" 画批准/拒绝；permission-gate
    // 的 kind 就是 confirm。其它 kind（selector 形状的权限请求）保持原样
    // ——卡片只给取消，不猜 UI。
    let method = ui
        .get("kind")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("confirm");
    Some(serde_json::json!({
        "id": request_id,
        "method": method,
        "payload": ui,
        // rpi runtime action 信封（UiDialogRequest.raw）不带扩展标识——不编造。
        "extensionId": serde_json::Value::Null,
    }))
}

/// 前端逐题应答 → 插件 `answer_values` 认识的回答。
///
/// 插件侧（rpi-ask-user `answer_values`）：先读 `values`（字符串数组），
/// 否则读 `value`（字符串）；`text` 独立读（自由输入）。TUI 的选择器应答
/// = `{"values":[…],"kind":"selector"}`，输入应答 =
/// `{"values":[text],"value":text,"text":text,"kind":"input"}`
/// （rpi-cli/src/interactive_tui/extensions.rs:914-921 / 999-1008）。
fn ask_answer_value(
    row: &serde_json::Value,
    answers: &[AskAnswerWire],
) -> Result<serde_json::Value, String> {
    let mut values: Vec<String> = Vec::new();
    let mut text: Option<String> = None;
    for answer in answers {
        for selected in &answer.selected {
            let selected = selected.trim();
            if !selected.is_empty() {
                values.push(selected.to_string());
            }
        }
        if let Some(other) = answer
            .other
            .as_deref()
            .map(str::trim)
            .filter(|other| !other.is_empty())
        {
            text = Some(other.to_string());
        }
    }
    if values.is_empty() {
        // 自由输入：没有选中项时把文本放进 values（插件优先读 values）。
        if let Some(text) = &text {
            values.push(text.clone());
        }
    }
    if values.is_empty() {
        return Err("ask 应答为空：既没有选中项也没有自由输入".into());
    }
    let question = &row["request"]["questions"][0];
    let has_options = question["options"]
        .as_array()
        .is_some_and(|options| !options.is_empty());
    let kind = if has_options { "selector" } else { "input" };
    let mut answer = serde_json::json!({ "values": values, "kind": kind });
    if let Some(text) = text {
        answer["value"] = serde_json::json!(text);
        answer["text"] = serde_json::json!(text);
    }
    Ok(answer)
}

/// 审批应答值 → 插件期望的选项标题。
///
/// rpi-permission-gate 只检查 `answer_values(answer).first()` 是否等于
/// "yes"（大小写不敏感），所以宿主必须回标题（"Yes"/"No"），不能回布尔。
/// 无 options 的 confirm 按上游 TUI 的默认 Yes/No 语义
/// （rpi-cli/src/interactive_tui/extensions.rs:777-779）。
fn approval_answer_value(
    ui: &serde_json::Value,
    value: Option<&serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let kind = ui
        .get("kind")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("confirm");
    match value {
        Some(serde_json::Value::Bool(allow)) => {
            let wanted = if *allow { "allow" } else { "reject" };
            let options = ui.get("options").and_then(serde_json::Value::as_array);
            if options.map_or(true, |options| options.is_empty()) {
                return Ok(serde_json::json!({
                    "values": [if *allow { "Yes" } else { "No" }],
                    "kind": kind,
                }));
            }
            let title = options
                .and_then(|options| {
                    options.iter().find_map(|option| {
                        option
                            .get("permission")
                            .and_then(serde_json::Value::as_str)
                            .filter(|permission| permission.starts_with(wanted))
                            .and_then(|_| option.get("title").and_then(serde_json::Value::as_str))
                    })
                })
                .ok_or_else(|| {
                    format!("审批对话框没有 {wanted} 选项（options 缺 permission 语义）")
                })?;
            Ok(serde_json::json!({ "values": [title], "kind": kind }))
        }
        Some(serde_json::Value::String(text)) if !text.trim().is_empty() => {
            Ok(serde_json::json!({ "values": [text.trim()], "kind": kind }))
        }
        _ => Err("扩展 UI 应答值非法：permission/confirm 需要 true 或 false".into()),
    }
}

// ── 会话树投影助手（纯函数，与引擎锁/异步面分离）──────────────────────────
/// user 消息文本提取（旧 pi `extract_user_text` 同语义：纯文本直接取；
/// 块数组取**第一个** Text 块；无 Text 块 = None，不编造空串）。
fn extract_user_text(content: &UserContent) -> Option<String> {
    match content {
        UserContent::Text(text) => Some(text.clone()),
        UserContent::Blocks(blocks) => blocks.iter().find_map(|block| match block {
            rpi_ai::types::Content::Text(text) => Some(text.text.clone()),
            _ => None,
        }),
    }
}

/// 导航结果 → `Ok/Err`。`Declined` 是 rpi 的 no-op 语义（目标叶 = 当前叶），
/// 后置条件已成立，按成功处理；`Aborted`/`Failed` 传播（规矩 12）。
fn navigation_ok(outcome: NavigationOutcome) -> Result<(), String> {
    match outcome {
        NavigationOutcome::Completed { .. } | NavigationOutcome::Declined { .. } => Ok(()),
        NavigationOutcome::Aborted { leaf_id } => {
            Err(format!("会话树导航被中止（叶 {leaf_id:?}）"))
        }
        NavigationOutcome::Failed { error, .. } => Err(error.message),
    }
}

/// 条目树上的一个节点（兄弟分支投影用）。
struct TreeNode {
    parent: Option<String>,
    is_message: bool,
    user_text: Option<String>,
}

/// 最近分叉点的兄弟分支投影（旧 pi `Session::sibling_branches` 语义，
/// 见 session.rs:5838-6018 的 `path_preview_and_message_count`）：
/// - 分叉点 = 当前叶向根走**第一个**孩子数 >= 2 的节点（虚拟根用 None 表示
///   ——wire 里 `forkPointId: null`）；
/// - 每条分支 leaf = 该 root 的首子链末端；
/// - preview = 叶→根路径上**最靠根**的非空 user 文本（每个非空文本都覆盖，
///   与上游无 is_none 守卫同构）；
/// - messageCount = 叶→会话根路径上的 message 条目数（含分叉点祖先）；
/// - isCurrent = 该分支 root 是当前叶路径上分叉点的那个孩子。
/// 无叶 / 叶不在条目集 / 无分叉 = `Value::Null`（前端不渲染分支条）。
fn sibling_branches_json(entries: &[Entry], leaf: Option<&str>) -> serde_json::Value {
    let Some(leaf) = leaf else {
        return serde_json::Value::Null;
    };
    let mut nodes: HashMap<String, TreeNode> = HashMap::new();
    let mut children: HashMap<Option<String>, Vec<String>> = HashMap::new();
    for entry in entries {
        let id = entry.id().to_string();
        let parent = entry.parent_id().map(str::to_string);
        let (is_message, user_text) = match entry {
            Entry::Message(message) => match &message.message {
                rpi_agent::message::AgentMessage::User(user) => {
                    (true, extract_user_text(&user.content))
                }
                _ => (true, None),
            },
            _ => (false, None),
        };
        children.entry(parent.clone()).or_default().push(id.clone());
        nodes.insert(
            id,
            TreeNode {
                parent,
                is_message,
                user_text,
            },
        );
    }
    // 当前叶 → 根（叶不在条目集 = 视图与树不一致，如实无分支）
    let mut current_path: Vec<String> = Vec::new();
    let mut cursor = Some(leaf.to_string());
    while let Some(id) = cursor {
        let Some(node) = nodes.get(&id) else {
            return serde_json::Value::Null;
        };
        current_path.push(id.clone());
        cursor = node.parent.clone();
    }
    let mut fork_point: Option<Option<String>> = None;
    for id in &current_path {
        let count = children
            .get(&Some(id.clone()))
            .map(|kids| kids.len())
            .unwrap_or(0);
        if count >= 2 {
            fork_point = Some(Some(id.clone()));
            break;
        }
    }
    if fork_point.is_none()
        && children
            .get(&None)
            .map(|kids| kids.len())
            .unwrap_or(0)
            >= 2
    {
        fork_point = Some(None);
    }
    let Some(fork_point) = fork_point else {
        return serde_json::Value::Null;
    };
    let roots: Vec<String> = children.get(&fork_point).cloned().unwrap_or_default();
    // 当前分支的 root = 当前叶 → 分叉点路径上、父级为分叉点的节点
    let current_root: Option<String> = {
        let mut cursor = Some(leaf.to_string());
        let mut found = None;
        while let Some(id) = cursor {
            let Some(node) = nodes.get(&id) else {
                break;
            };
            if node.parent == fork_point {
                found = Some(id);
                break;
            }
            cursor = node.parent.clone();
        }
        found
    };
    let branches: Vec<serde_json::Value> = roots
        .iter()
        .map(|root| {
            let mut branch_leaf = root.clone();
            loop {
                let kids = children
                    .get(&Some(branch_leaf.clone()))
                    .cloned()
                    .unwrap_or_default();
                match kids.first() {
                    Some(next) => branch_leaf = next.clone(),
                    None => break,
                }
            }
            let mut preview = String::new();
            let mut message_count: u64 = 0;
            let mut cursor = Some(branch_leaf.clone());
            while let Some(id) = cursor {
                let Some(node) = nodes.get(&id) else {
                    break;
                };
                if node.is_message {
                    message_count += 1;
                }
                if let Some(text) = &node.user_text {
                    if !text.is_empty() {
                        preview.clone_from(text);
                    }
                }
                cursor = node.parent.clone();
            }
            serde_json::json!({
                "rootId": root,
                "leafId": branch_leaf,
                "preview": preview,
                "messageCount": message_count,
                "isCurrent": current_root.as_deref() == Some(root.as_str()),
            })
        })
        .collect();
    serde_json::json!({
        "forkPointId": fork_point,
        "branches": branches,
    })
}

#[cfg(test)]
mod tests {
    //! 纯函数单测（兄弟分支投影 / user 文本提取）——语义逐条照旧 pi 的
    //! `sibling_branches` 测试（df701a4 pi_session.rs:2292-2327）。

    use super::*;
    use rpi_ai::types::{Api, AssistantMessage, Content, UserMessage};
    use rpi_harness::session::types::{EntryBase, MessageEntry};

    fn entry_base(id: &str, parent: Option<&str>) -> EntryBase {
        EntryBase {
            entry_type: "message".into(),
            id: id.into(),
            seq: 0,
            parent_id: parent.map(str::to_string),
            timestamp: 0,
        }
    }

    fn user_entry(id: &str, parent: Option<&str>, text: &str) -> Entry {
        Entry::Message(MessageEntry {
            base: entry_base(id, parent),
            message: rpi_agent::message::AgentMessage::User(UserMessage::new(text, 0)),
            terminate: None,
        })
    }

    fn assistant_entry(id: &str, parent: Option<&str>, text: &str) -> Entry {
        let mut message = AssistantMessage::empty(Api::Faux, "test", "test", 0);
        message.content = vec![Content::text(text)];
        Entry::Message(MessageEntry {
            base: entry_base(id, parent),
            message: rpi_agent::message::AgentMessage::Assistant(Box::new(message)),
            terminate: None,
        })
    }

    #[test]
    fn sibling_branches_reports_fork_point_and_leaves() {
        // u1 在两条分支上共用：a1 → u2（分支甲）、u3（分支乙）
        let entries = vec![
            user_entry("u1", None, "根问题"),
            assistant_entry("a1", Some("u1"), "回答甲"),
            user_entry("u2", Some("a1"), "分支甲"),
            user_entry("u3", Some("u1"), "分支乙"),
        ];
        let value = sibling_branches_json(&entries, Some("u3"));
        assert_eq!(value["forkPointId"], serde_json::json!("u1"));
        let branches = value["branches"].as_array().expect("branches array");
        assert_eq!(branches.len(), 2);
        // 分支甲：root = a1，叶 = 首子链末端 u2，消息数 = 叶→根的 message 条目
        assert_eq!(branches[0]["rootId"], serde_json::json!("a1"));
        assert_eq!(branches[0]["leafId"], serde_json::json!("u2"));
        assert_eq!(branches[0]["preview"], serde_json::json!("根问题"));
        assert_eq!(branches[0]["messageCount"], serde_json::json!(3));
        assert_eq!(branches[0]["isCurrent"], serde_json::json!(false));
        // 分支乙：root 即叶，当前分支
        assert_eq!(branches[1]["rootId"], serde_json::json!("u3"));
        assert_eq!(branches[1]["leafId"], serde_json::json!("u3"));
        assert_eq!(branches[1]["preview"], serde_json::json!("根问题"));
        assert_eq!(branches[1]["messageCount"], serde_json::json!(2));
        assert_eq!(branches[1]["isCurrent"], serde_json::json!(true));
    }

    #[test]
    fn sibling_branches_null_without_fork() {
        let entries = vec![user_entry("u1", None, "线性会话")];
        assert!(sibling_branches_json(&entries, Some("u1")).is_null());
        // 无叶（空会话）= null，不是错误
        assert!(sibling_branches_json(&entries, None).is_null());
    }

    #[test]
    fn extract_user_text_takes_first_text_block_and_null_without_text() {
        assert_eq!(
            extract_user_text(&UserContent::Text("hi".into())),
            Some("hi".into())
        );
        let blocks = vec![
            Content::Image(rpi_ai::types::ImageContent {
                kind: Default::default(),
                data: std::sync::Arc::from("Zm9v"),
                mime_type: "image/png".into(),
            }),
            Content::text("a"),
            Content::text("b"),
        ];
        assert_eq!(
            extract_user_text(&UserContent::Blocks(blocks)),
            Some("a".into())
        );
        let images_only = vec![Content::Image(rpi_ai::types::ImageContent {
            kind: Default::default(),
            data: std::sync::Arc::from("Zm9v"),
            mime_type: "image/png".into(),
        })];
        assert_eq!(extract_user_text(&UserContent::Blocks(images_only)), None);
    }

    // ---- 扩展 UI 载荷映射（rpi runtime action 17 → 前端卡片） ----

    /// rpi-ask-user 的扁平 question（其 `to_ui` 实测键：kind/id/header/
    /// question/context/options/allowMultiple/allowFreeform/…）。
    fn rpi_ask_ui() -> serde_json::Value {
        serde_json::json!({
            "kind": "selector",
            "id": "q1",
            "header": "技术栈",
            "question": "用哪个语言？",
            "context": null,
            "options": [
                { "title": "Rust", "description": "内存安全" },
                { "title": "Python" }
            ],
            "allowMultiple": true,
            "allowFreeform": false,
            "allowComment": false,
            "suggest": null,
            "displayMode": null,
            "timeout": 0
        })
    }

    #[test]
    fn ask_row_maps_flat_rpi_question_to_frontend_row() {
        let row = ask_row(&rpi_ask_ui(), "req-1").expect("ask row");
        assert_eq!(row["id"], serde_json::json!("req-1"));
        let questions = row["request"]["questions"].as_array().expect("questions");
        assert_eq!(questions.len(), 1);
        assert_eq!(questions[0]["id"], serde_json::json!("q1"));
        assert_eq!(questions[0]["header"], serde_json::json!("技术栈"));
        assert_eq!(questions[0]["question"], serde_json::json!("用哪个语言？"));
        assert_eq!(questions[0]["multi"], serde_json::json!(true));
        assert_eq!(
            questions[0]["options"],
            serde_json::json!([
                { "label": "Rust", "description": "内存安全" },
                { "label": "Python" }
            ])
        );
    }

    #[test]
    fn ask_row_accepts_batched_questions_and_confirm_is_single_choice() {
        // 兼容 `questions[]` 批量形状（rpi 自身一次一个问题，但宿主契约
        // 接受批量）；confirm 语义恒单选（TUI 同款强制）。
        let ui = serde_json::json!({
            "kind": "confirm",
            "summary": "继续执行？",
            "questions": [
                { "id": "a", "question": "继续执行？", "allowMultiple": true },
                { "question": "要备份吗？", "options": ["是", "否"] }
            ]
        });
        let row = ask_row(&ui, "req-2").expect("ask row");
        let questions = row["request"]["questions"].as_array().expect("questions");
        assert_eq!(questions.len(), 2);
        assert_eq!(questions[0]["multi"], serde_json::json!(false));
        assert_eq!(
            questions[1]["options"],
            serde_json::json!([{ "label": "是" }, { "label": "否" }])
        );
        // 没有题目文本 = 不认（请求留在邮箱里，不吞掉）
        assert!(ask_row(&serde_json::json!({ "kind": "selector" }), "req-3").is_none());
    }

    #[test]
    fn permission_dialog_is_not_an_ask_row() {
        // permission-gate 的 ui（purpose=permission、options[].permission）
        // 必须留给审批命令——ask 取用谓词不能吃它。
        let ui = serde_json::json!({
            "kind": "confirm",
            "purpose": "permission",
            "id": "permission-gate",
            "question": "Allow bash?",
            "message": "rm -rf build",
            "options": [
                { "title": "Yes", "permission": "allow_once" },
                { "title": "No", "permission": "reject_once" }
            ]
        });
        assert!(ask_row(&ui, "req-1").is_none());
        let row = approval_row(&ui, "req-1").expect("approval row");
        assert_eq!(row["id"], serde_json::json!("req-1"));
        assert_eq!(row["method"], serde_json::json!("confirm"));
        assert_eq!(row["extensionId"], serde_json::Value::Null);
        assert_eq!(row["payload"]["question"], serde_json::json!("Allow bash?"));
    }

    #[test]
    fn ask_answer_value_matches_plugin_answer_values_contract() {
        let row = ask_row(&rpi_ask_ui(), "req-1").expect("ask row");
        // 选择器：选中项进 values（TUI 同款 {"values":[…],"kind":"selector"}）
        let selected = ask_answer_value(
            &row,
            &[AskAnswerWire {
                question_id: Some("q1".into()),
                selected: vec!["Rust".into()],
                other: None,
            }],
        )
        .expect("answer");
        assert_eq!(
            selected,
            serde_json::json!({ "values": ["Rust"], "kind": "selector" })
        );
        // 自由输入：没有选中项时文本同时进 values/value/text
        let freeform = ask_answer_value(
            &row,
            &[AskAnswerWire {
                question_id: Some("q1".into()),
                selected: vec![],
                other: Some("  Kotlin  ".into()),
            }],
        )
        .expect("answer");
        assert_eq!(
            freeform,
            serde_json::json!({
                "values": ["Kotlin"],
                "kind": "selector",
                "value": "Kotlin",
                "text": "Kotlin",
            })
        );
        // 空应答 = Err（不编造 "yes"/空串）
        assert!(ask_answer_value(
            &row,
            &[AskAnswerWire {
                question_id: None,
                selected: vec![],
                other: Some("   ".into()),
            }]
        )
        .is_err());
    }

    #[test]
    fn approval_answer_value_uses_option_titles_and_fails_closed() {
        let ui = serde_json::json!({
            "kind": "confirm",
            "purpose": "permission",
            "options": [
                { "title": "Yes", "permission": "allow_once" },
                { "title": "No", "permission": "reject_once" }
            ]
        });
        assert_eq!(
            approval_answer_value(&ui, Some(&serde_json::json!(true))).unwrap(),
            serde_json::json!({ "values": ["Yes"], "kind": "confirm" })
        );
        assert_eq!(
            approval_answer_value(&ui, Some(&serde_json::json!(false))).unwrap(),
            serde_json::json!({ "values": ["No"], "kind": "confirm" })
        );
        // 无 options 的 confirm 按上游 TUI 默认 Yes/No
        let bare = serde_json::json!({ "kind": "confirm", "purpose": "permission" });
        assert_eq!(
            approval_answer_value(&bare, Some(&serde_json::json!(true))).unwrap(),
            serde_json::json!({ "values": ["Yes"], "kind": "confirm" })
        );
        // 缺 permission 语义的 options = Err（不猜哪个是允许）
        let no_semantics = serde_json::json!({
            "kind": "confirm",
            "options": [{ "title": "OK" }, { "title": "Cancel" }]
        });
        assert!(approval_answer_value(&no_semantics, Some(&serde_json::json!(true))).is_err());
        // null 值 = Err（前端只会在 cancelled=true 时省略 value）
        assert!(approval_answer_value(&ui, None).is_err());
        assert!(approval_answer_value(&ui, Some(&serde_json::json!("Yes"))).is_ok());
    }

    #[test]
    fn workspace_from_session_path_matches_rpi_layout() {
        let p = Path::new(
            r"C:\work\proj\.rpi\sessions\--C--work-proj--\2026-01-01T00-00-00-000Z_id.jsonl",
        );
        assert_eq!(
            workspace_from_session_path(p),
            Some(PathBuf::from(r"C:\work\proj"))
        );
    }

    #[test]
    fn workspace_from_session_path_accepts_home_root() {
        let p = Path::new(r"C:\Users\a\.rpi\sessions\--C--Users-a--\x.jsonl");
        assert_eq!(
            workspace_from_session_path(p),
            Some(PathBuf::from(r"C:\Users\a"))
        );
    }

    #[test]
    fn workspace_from_session_path_rejects_other_layouts() {
        // 不是 .rpi/sessions 布局：不猜 cwd（调用方沿用活动 cwd）。
        assert_eq!(workspace_from_session_path(Path::new(r"C:\tmp\x.jsonl")), None);
        assert_eq!(
            workspace_from_session_path(Path::new(r"C:\custom\sessions\--x--\x.jsonl")),
            None
        );
        assert_eq!(
            workspace_from_session_path(Path::new(r"C:\w\.rpi\sessions\x.jsonl")),
            None
        );
    }

    #[test]
    fn preflight_accepts_a_header_and_rejects_corruption() {
        use std::io::Write;
        let dir = std::env::temp_dir().join(format!("mirach-preflight-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();

        let ok = dir.join("ok.jsonl");
        let mut f = std::fs::File::create(&ok).unwrap();
        writeln!(
            f,
            r#"{{"kind":"header","version":4,"id":"01a1","createdAt":1,"cwd":"C:\\\\x"}}"#
        )
        .unwrap();
        writeln!(f, r#"{{"kind":"entry"}}"#).unwrap();
        drop(f);
        assert!(preflight_session_file(&ok.to_string_lossy()).is_ok());

        let broken = dir.join("broken.jsonl");
        let mut f = std::fs::File::create(&broken).unwrap();
        writeln!(f, r#"{{"kind":"entry","lane":"main","seq":26}}"#).unwrap();
        drop(f);
        let err = preflight_session_file(&broken.to_string_lossy()).unwrap_err();
        assert!(err.contains("会话文件损坏"), "{err}");

        let empty = dir.join("empty.jsonl");
        std::fs::File::create(&empty).unwrap();
        let err = preflight_session_file(&empty.to_string_lossy()).unwrap_err();
        assert!(err.contains("缺少 header"), "{err}");

        std::fs::remove_dir_all(&dir).ok();
    }
}

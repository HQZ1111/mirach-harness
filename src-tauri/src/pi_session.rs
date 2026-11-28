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
//! - **并列窗格（side_*）已接真（2026-11-19）**：每个窗格一棵独立会话句柄
//!   （自己的 harness / lane / writer lease / 事件流），`side_prompt` 只锁
//!   自己的句柄，因此两个窗格能在同一进程内并行收发；`side_interrupt` 定向
//!   abort，不影响前台与其它窗格。单写者约束由 `live` / `side` / `retired`
//!   三张归属表兜住：同一会话文件不允许在主柄与窗格、或两个窗格同时在场
//!   （rpi storage 的 "writer lease is already held"）。
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

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use rpi_agent::AgentEvent;
use rpi_harness::agent_harness::{
    AgentHarness, AgentLane, CompactionOutcome, HarnessRunOutcome, NavigationOutcome,
};
use rpi_harness::session::jsonl::{
    JsonlSessionCreateOptions, JsonlSessionListOptions, JsonlSessionMetadata, JsonlSessionRepo,
    JsonlSessionRepoOptions, JsonlSessionStorage,
};
use rpi_harness::session::types::{
    BranchBounds, Entry, EntryOrder, EntryQuery, ForkOptions, ForkPosition, SessionStats,
    SessionTree, TranscriptPageQuery,
};
use rpi_harness::session::{DefaultIdGenerator, Session, SystemClock};
use rpi_ai::types::{Content, ImageContent, UserContent, UserMessage};
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

/// `/goal` 命令调用面（`PiEngine::run_command` 的自由函数形态）——校验任务在
/// 引擎运行时上跑，借不到 `&PiEngine`，只能拿 `Arc<EngineShared>` + 这个入口。
pub(crate) fn run_goal_command(
    shared: &EngineShared,
    command: &str,
    args: &str,
) -> Result<serde_json::Value, String> {
    let live = shared
        .live
        .lock()
        .map_err(|_| "锁中毒".to_string())?
        .clone()
        .ok_or_else(|| NO_ACTIVE_SESSION.to_string())?;
    run_plugin_command(&live, command, args)
}

/// 在一个指定 harness 上执行扩展 slash command。`/plan start|exit` 的
/// **会话级**入口：并列窗格/非活动会话也能按自己的扩展实例执行（计划模式
/// 插件每会话一份——见 rpi-extensions 的 per-session copy）。
pub(crate) fn run_plugin_command(
    live: &HarnessLive,
    command: &str,
    args: &str,
) -> Result<serde_json::Value, String> {
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
        // SAFETY: the callback transfers its output using the host allocator —
        // same contract as rpi-cli's rpc_execute_command and the TUI command
        // invocation.
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

/// 「本轮结束后校验目标」的宿主入口（ZCode `verifyBeforeFirstContinue` 对偶）。
///
/// 非阻塞：把校验任务 spawn 到引擎运行时；真正的闸门（无目标 / 非 active /
/// 后台作业在跑 / 已有校验在途 / 会话已切换）都在 `pi_goal_verify::run_verification`
/// 里判定并静默跳过——这里只负责取桥、拼「会话仍是当前会话」的守卫、起任务。
/// 桥缺失（无扩展）= 目标系统根本不在场，不报错也不重试。
fn spawn_goal_verification(
    shared: Arc<EngineShared>,
    live: Arc<HarnessLive>,
    verifier: Arc<crate::pi_goal_verify::GoalVerifier>,
) {
    let host = match live
        .reload
        .action_bridge
        .lock()
        .map_err(|_| "扩展桥锁中毒".to_string())
        .and_then(|guard| {
            guard
                .clone()
                .ok_or_else(|| "当前会话没有扩展桥".to_string())
        }) {
        Ok(bridge) => bridge.clone_host(),
        Err(_) => return,
    };
    let harness = Arc::clone(&live.harness);
    let is_current: Arc<dyn Fn() -> bool + Send + Sync> = {
        let shared = Arc::clone(&shared);
        let live = Arc::clone(&live);
        Arc::new(move || {
            shared
                .live
                .lock()
                .ok()
                .and_then(|guard| {
                    guard
                        .as_ref()
                        .map(|current| Arc::ptr_eq(current, &live))
                })
                .unwrap_or(false)
        })
    };
    let command: crate::pi_goal_verify::GoalCommand = {
        let shared = Arc::clone(&shared);
        Arc::new(move |command, args| run_goal_command(&shared, command, args))
    };
    shared.rt.spawn(async move {
        if let Err(error) =
            crate::pi_goal_verify::run_verification(harness, host, verifier, is_current, command)
                .await
        {
            eprintln!("[goal-verify] {error}");
        }
    });
}

/// 会话上台时的孤儿校验修复（应用退出/会话切走留下的 `verifying` 状态）。
fn repair_orphaned_goal_verification(
    shared: Arc<EngineShared>,
    live: Arc<HarnessLive>,
    verifier: Arc<crate::pi_goal_verify::GoalVerifier>,
) {
    let is_current: Arc<dyn Fn() -> bool + Send + Sync> = {
        let shared = Arc::clone(&shared);
        let live = Arc::clone(&live);
        Arc::new(move || {
            shared
                .live
                .lock()
                .ok()
                .and_then(|guard| {
                    guard
                        .as_ref()
                        .map(|current| Arc::ptr_eq(current, &live))
                })
                .unwrap_or(false)
        })
    };
    let command: crate::pi_goal_verify::GoalCommand = {
        let shared = Arc::clone(&shared);
        Arc::new(move |command, args| run_goal_command(&shared, command, args))
    };
    let harness = Arc::clone(&live.harness);
    shared.rt.spawn(async move {
        if !is_current() {
            return;
        }
        if let Err(error) =
            crate::pi_goal_verify::repair_orphaned_verification(&harness, &verifier, &command).await
        {
            eprintln!("[goal-verify] 孤儿修复失败：{error}");
        }
    });
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

    /// 在引擎运行时上 spawn 一个后台任务（立即返回，不阻塞调用线程）。
    /// 目标校验器用它把「本轮之后的校验」放到后台（不能挡住本轮返回）。
    pub fn spawn<F>(&self, future: F)
    where
        F: std::future::Future<Output = ()> + Send + 'static,
    {
        self.rt.spawn(future);
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

/// 会话派生面缓存条目：`messages()` / `timeline_markers()` 的序列化结果。
///
/// 为什么要缓存（2026-11-19 性能轮实测）：冷 replay 一个 11MB/2036 条条目的
/// 会话文件，`pi_get_messages` ≈ 3.9s（热 1.4~2.1s）、
/// `pi_get_timeline_markers` ≈ 0.9s、`pi_get_state`（内部走
/// `snapshot_stats` 全文件重扫）≈ 0.3s。切换页签 / 轮询会反复付这笔账，
/// 而文件是 append-only：只要 stat 没变结果就不变。
///
/// **键必须含 leaf**：切分支（rewind / fork 回到兄弟叶）只改会话叶，不改
/// 文件 stat——只按 stat 缓存会把旧分支的消息面发出去（错误数据，不是
/// 性能问题）。`path` 一并入键，活动会话切换即自然失效。
struct DerivedCache {
    path: PathBuf,
    len: u64,
    mtime_ms: u64,
    leaf: Option<String>,
    value: Arc<serde_json::Value>,
}

/// `pi_list_sessions` / `pi_sessions_index` 的单文件事实（header id/cwd 之外的
/// name / messageCount），stat 不变即整行复用。会话文件 append-only，rename 也会
/// 追加条目 → mtime 变。
struct SessionFactsCache {
    len: u64,
    mtime_ms: u64,
    name: Option<String>,
    message_count: u64,
    row: serde_json::Value,
}

/// 文件 stat 指纹（len + mtime 毫秒）。读元数据失败传播（规矩 12）。
fn file_stamp(path: &Path) -> Result<(u64, u64), String> {
    let meta = std::fs::metadata(path)
        .map_err(|e| format!("会话文件状态读取失败 {}: {e}", path.display()))?;
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    Ok((meta.len(), mtime_ms))
}

/// 只读首行（header），不整文件 read_to_string——巨文件上一条 header 读取
/// 曾把整个 11MB 读进内存。
fn read_first_line(path: &Path) -> Option<String> {
    use std::io::BufRead;
    let file = std::fs::File::open(path).ok()?;
    let mut line = String::new();
    std::io::BufReader::new(file).read_line(&mut line).ok()?;
    if line.is_empty() {
        None
    } else {
        Some(line)
    }
}

/// 把引擎 transcript 条目里的 message 值序列化成 wire 数组（entryIds 与
/// messages 逐条对应，非 message 条目跳过——与旧 messages() 口径一致）。
fn push_message_entries(
    entries: Vec<Entry>,
    messages: &mut Vec<serde_json::Value>,
    entry_ids: &mut Vec<String>,
) -> Result<(), String> {
    for entry in entries {
        let Entry::Message(message) = entry else {
            continue;
        };
        entry_ids.push(message.base.id.clone());
        messages.push(
            serde_json::to_value(&message.message).map_err(|e| format!("消息序列化失败: {e}"))?,
        );
    }
    Ok(())
}

/// **不打开引擎**的会话尾部预览（大会话秒开的第二步）：
/// 直接从 JSONL 文件尾回扫 `limit` 条 message 条目（块读 + 只解析命中的
/// 尾部行），沿 `parentId` 回溯出当前叶分支，末尾裁到最近一条 user 消息
/// 起的轮。返回 wire `{sessionId, messages, entryIds, hasMore, leafId}`。
///
/// 存在的意义：引擎 `pi_open_session` 对 11MB 会话要整树 replay ~5s；
/// 用户点开行时先用本函数 <~0.2s 把尾部画出来，再后台等引擎打开做对齐
/// （见前端 `peekTranscriptTail` 流程）。`hasMore` 为保守值：只要尾部窗口
/// 没覆盖到文件头就为 true（引擎对齐后会纠正）。
pub(crate) fn peek_session_tail(path: &str, limit: usize) -> Result<serde_json::Value, String> {
    use std::io::{Read, Seek, SeekFrom};

    const CHUNK_START: u64 = 256 * 1024;
    let limit = limit.max(1);
    let p = Path::new(path);
    let len = std::fs::metadata(p)
        .map_err(|e| format!("会话文件状态读取失败 {path}: {e}"))?
        .len();
    let session_id = read_first_line(p)
        .and_then(|l| serde_json::from_str::<serde_json::Value>(&l).ok())
        .and_then(|h| {
            h.get("id")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
        });
    if len == 0 {
        return Ok(serde_json::json!({
            "sessionId": session_id,
            "messages": [],
            "entryIds": [],
            "hasMore": false,
            "leafId": serde_json::Value::Null,
        }));
    }

    // 从尾部按块回扫，凑够 limit 条 message 行（content 里的引号都是转义过的，
    // 裸 "type":"message" 不会误命中正文）。
    let want = limit.saturating_add(32);
    let mut window = CHUNK_START.min(len);
    let (entries, reached_start): (Vec<serde_json::Value>, bool) = loop {
        let start = len - window;
        let mut f = std::fs::File::open(p)
            .map_err(|e| format!("会话文件读取失败 {path}: {e}"))?;
        f.seek(SeekFrom::Start(start))
            .map_err(|e| format!("会话文件定位失败 {path}: {e}"))?;
        let mut buf = vec![0u8; window as usize];
        f.read_exact(&mut buf)
            .map_err(|e| format!("会话文件读取失败 {path}: {e}"))?;
        let text = String::from_utf8_lossy(&buf);
        let mut lines: Vec<&str> = text
            .split('\n')
            .map(|l| l.trim())
            .filter(|l| !l.is_empty())
            .collect();
        // 块首行可能被截断（start>0 时），丢弃
        if start > 0 && !lines.is_empty() {
            lines.remove(0);
        }
        let msg_count = lines
            .iter()
            .filter(|l| l.contains("\"type\":\"message\""))
            .count();
        if msg_count >= want || start == 0 {
            // 只解析尾部需要的那一段
            let mut keep_from = 0usize;
            let mut seen = 0usize;
            for (idx, line) in lines.iter().enumerate().rev() {
                if line.contains("\"type\":\"message\"") {
                    seen += 1;
                    if seen >= want {
                        keep_from = idx;
                        break;
                    }
                }
            }
            let entries: Vec<serde_json::Value> = lines[keep_from..]
                .iter()
                .filter_map(|l| serde_json::from_str(l).ok())
                .collect();
            break (entries, start == 0);
        }
        // 尾部窗口不够：指数扩大（下一轮 start 更小）
        window = window.saturating_mul(8).max(window + CHUNK_START).min(len);
    };

    // 叶子 = 最后一条 message 条目（record 条目不带 message 链，见
    // pi_get_session_messages 注释）
    let leaf_id = entries
        .iter()
        .rev()
        .find(|e| e.get("type").and_then(|v| v.as_str()) == Some("message"))
        .and_then(|e| e.get("id"))
        .and_then(|v| v.as_str())
        .map(String::from);
    let mut by_id: std::collections::HashMap<&str, usize> = std::collections::HashMap::new();
    for (i, e) in entries.iter().enumerate() {
        if let Some(id) = e.get("id").and_then(|v| v.as_str()) {
            by_id.insert(id, i);
        }
    }
    let mut chain: Vec<&serde_json::Value> = Vec::new();
    let mut cur = leaf_id.clone();
    let mut chain_broken = false;
    while let Some(id) = cur {
        match by_id.get(id.as_str()) {
            Some(&i) => {
                let e = &entries[i];
                chain.push(e);
                cur = e.get("parentId").and_then(|v| v.as_str()).map(String::from);
            }
            None => {
                // 父条目落在窗口之外（文件还有更早内容）= 链被窗口截断
                chain_broken = true;
                break;
            }
        }
    }
    chain.reverse();
    // 只保留 message 条目并裁到最近一条 user 消息起的轮
    let mut messages: Vec<serde_json::Value> = Vec::new();
    let mut entry_ids: Vec<String> = Vec::new();
    for e in &chain {
        if e.get("type").and_then(|v| v.as_str()) != Some("message") {
            continue;
        }
        if let Some(msg) = e.get("message").cloned() {
            messages.push(msg);
            if let Some(id) = e.get("id").and_then(|v| v.as_str()) {
                entry_ids.push(id.to_string());
            }
        }
    }
    let first_user = messages
        .iter()
        .position(|m| m.get("role").and_then(|r| r.as_str()) == Some("user"));
    if let Some(idx) = first_user {
        if idx > 0 {
            messages.drain(0..idx);
            entry_ids.drain(0..idx);
        }
    } else if messages.len() > limit {
        let keep = messages.len() - limit;
        messages.drain(0..keep);
        entry_ids.drain(0..keep);
    }
    let has_more = chain_broken || !reached_start;
    Ok(serde_json::json!({
        "sessionId": session_id,
        "messages": messages,
        "entryIds": entry_ids,
        "hasMore": has_more,
        "leafId": leaf_id,
    }))
}

/// 退役会话的保留上限（最近 N 个）。切回这些会话仍免重建；更老的淘汰。
/// retired 句柄上限（多会话并存 2026-11-28：4→12，对齐前端 actor 注册表
/// ACTOR_CAP=12——每个后台 run 都需要一个 retired 句柄来保住写者租约与
/// 邮箱；被逐的句柄释放租约，对应 run 的后台继续跑即终止）。
const RETIRED_HARNESS_CAP: usize = 12;

/// 退役会话表：`HashMap` + 进入顺序。
///
/// 淘汰必须 **显式 release writer lease 再 drop**：rpi 的 JSONL storage
/// 在 `release_writer_lease()`（`rpi-harness/session/jsonl/storage.rs:315`）
/// 里才会放下 OS 租约；直接 drop 时引擎内部任务仍引用着它，租约悬空
/// （下一次重建撞 "writer lease is already held"）。调用面与 TUI 切会话
/// 的收尾同款（`harness.session().storage().release_writer_lease()`）。
#[derive(Default)]
struct RetiredSessions {
    map: HashMap<PathBuf, Arc<HarnessLive>>,
    /// 进入顺序（oldest → newest）。只增不删地留 stale 条目会白白吃内存，
    /// 但条目本身只是 PathBuf，淘汰时按"不在 map 就跳过"处理即可。
    order: VecDeque<PathBuf>,
}

impl RetiredSessions {
    fn insert(&mut self, key: PathBuf, live: Arc<HarnessLive>) {
        // 同路径重复退役：旧的先按正式口释放，再换新的（正常不会发生，
        // 同一会话文件不可能同时有两份 harness 持有租约）。
        if let Some(old) = self.map.insert(key.clone(), live) {
            release_retired_harness(&old);
            return;
        }
        self.order.push_back(key);
        while self.map.len() > RETIRED_HARNESS_CAP {
            let Some(oldest) = self.order.pop_front() else { break };
            if let Some(old) = self.map.remove(&oldest) {
                release_retired_harness(&old);
            }
        }
        // 剃掉队首 stale（已被 take 走的键）
        while let Some(front) = self.order.front() {
            if self.map.contains_key(front) { break }
            self.order.pop_front();
        }
    }

    fn take(&mut self, key: &Path) -> Option<Arc<HarnessLive>> {
        self.map.remove(key)
    }
}

/// 释放一个退役 harness：取消插件 ask 邮箱 + 显式释放 JSONL writer lease。
fn release_retired_harness(live: &HarnessLive) {
    live.reload.ui_dialog.cancel_all();
    live.harness.session().storage().release_writer_lease();
}

pub(crate) struct EngineShared {
    rt: PiRuntime,
    cwd: PathBuf,
    /// 前台（thread "main"，即工作区窗格）会话句柄。
    live: Mutex<Option<Arc<HarnessLive>>>,
    /// 切走/丢弃但**仍持有 writer lease** 的会话（2026-11-15）。
    ///
    /// rpi 的 JSONL storage 在 `acquire_writer_lease` 后，即使 `HarnessLive` 被
    /// 替换也仍被引擎内部任务引用（实测：切到 B 再切回 A 必撞 "writer lease
    /// is already held"）。TUI 用 `set_session` 原地换会话规避；宿主重建
    /// harness 的路径无法释放旧 lease，故把旧 `HarnessLive` 留在本表里复用：
    /// 再次打开同一路径时直接重新激活，不重新 acquire。
    ///
    /// **2026-11-21 收紧**：表从"永久保留"改为**最近 N 份**（见
    /// `RETIRED_HARNESS_CAP`）。超出时按进入顺序淘汰最老的：先显式
    /// `release_writer_lease()`（引擎提供的正式释放口，drop 本身不释放），
    /// 再 drop —— 否则每切一个会话就永久占一份 harness（含会话内存态），
    /// 宿主内存无界增长（实测 25 分钟 39MB→87MB 私有）。被淘汰的会话再次
    /// 打开时走正常重建路径（lease 已释放，不会撞 already held）。
    retired: Mutex<RetiredSessions>,
    /// 并列窗格会话表（hermes `_sessions` 多会话对偶）：窗格线程键 →
    /// 独立 harness 句柄。每个窗格一棵会话、各自 lane/锁/事件流，所以两个
    /// 窗格可以在同一进程内**并行收发**；与前台 `live` 互斥同一个会话文件
    /// （单写者约束，见 `side_open` 的占用检查）。
    side: Mutex<HashMap<String, Arc<HarnessLive>>>,
    model_line: Mutex<String>,
    /// 活动会话消息历史缓存（键 = path + stat + leaf，见 `DerivedCache`）。
    messages_cache: Mutex<Option<DerivedCache>>,
    /// 活动会话时间线标记缓存（同上键）。
    markers_cache: Mutex<Option<DerivedCache>>,
    /// `pi_list_sessions` 每文件事实缓存（键 = path，stat 校验）。
    session_facts_cache: Mutex<HashMap<PathBuf, SessionFactsCache>>,
    /// 活动会话 stat → SessionStats 缓存（`state()` 高频调用；文件不变即复用）。
    stats_cache: Mutex<Option<(PathBuf, u64, u64, SessionStats)>>,
    /// 当前活动环境（profile）名（`pi_profiles`；None = 本体）。
    ///
    /// 写入面只有 `pi_set_active_profile`（用户切换环境时）；读面 = 新会话
    /// 落点（`build_harness_with` 的 session_dir）、`list_sessions` /
    /// `index_sessions` 的扫描根。**只加载当前环境的会话**——hermes
    /// "切换时左侧栏会话会变、其余环境零开销" 的宿主对偶。
    active_profile: Mutex<Option<String>>,
    /// New Chat 尚未落会话时选择的审批模式（full access）：下一次主会话
    /// 创建时消费并 pin 到该会话；打开已有会话不消费（dsh 的 preset 只在
    /// 新会话落地）。None = 用默认 always-ask。
    pending_approval_mode: Mutex<Option<rpi_cli::approval_gate::ApprovalMode>>,
    /// New Chat 尚未落会话时选择的计划模式：第一份主会话创建后消费并执行
    /// `/plan start`。打开已有会话不消费（New Chat 的暂存丢弃）。
    pending_plan_mode: Mutex<bool>,
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
    /// 该会话所属环境（配置绑定）：会话级设置（set_model 等）写回**这个**
    /// 环境的 home，而不是引擎当前活动环境——bot 聊天跨环境打开时不能把
    /// 默认模型写进别人的 settings.json。
    profile: Option<String>,
}

pub struct PiEngine {
    shared: Arc<EngineShared>,
    approvals: Arc<ApprovalRegistry>,
    asks: Arc<AskRegistry>,
    /// 目标完成校验器（ZCode goal verifier 的宿主对偶；在途态 + 单槽门）。
    verifier: Arc<crate::pi_goal_verify::GoalVerifier>,
    /// 压缩进度出口（AG-UI 的 CUSTOM name=compaction）。
    ///
    /// 为什么需要：引擎在每次压缩前后通过 `HarnessEventBus` 发
    /// `HarnessEvent::CompactionProgress`（rpi-harness/src/events.rs 的
    /// `CompactionProgressGuard`），但**宿主从未订阅这个总线**，于是前端
    /// turn-actor 里的 compaction 归约分支永远等不到事件——用户只看到
    /// “上下文消失了”而没有任何「正在压缩」提示（2026-11-27 实报）。
    /// 这里由装配方（main.rs）注入一个推送函数，换会话时由 install_live
    /// 把该会话的 bus 接上。
    compaction_sink: Mutex<Option<Arc<dyn Fn(&str, serde_json::Value) + Send + Sync>>>,
}

// ── harness 装配（PiEngine 与后台 bot 泳道共用）───────────────────────────
//
// 2026-11-17（bots 群聊接线）：把 build_harness_with / session_root /
// session_metadata_in 的正文抽成自由函数，`pi_bot.rs` 的后台泳道用同一套
// 装配语义（provider 解析、models.dev 窗口回填、ui_dialog attach、路径反查），
// 避免两份实现漂移。PiEngine 的行为零变化（方法只做转发）。

/// `rpi_cli::session::build` 的宿主装配结果（两处消费：前台 PiEngine、后台 bot 泳道）。
pub(crate) struct BuiltHarness {
    pub harness: Arc<AgentHarness>,
    pub events: tokio::sync::broadcast::Receiver<AgentEvent>,
    pub reload: ReloadContext,
    pub provider: String,
    pub model_id: String,
    pub id: String,
    pub path: PathBuf,
    pub sessions_root: PathBuf,
}

/// 会话根解析（与 `PiEngine::session_root` 同体，抽自由函数供 bot 泳道复用）。
pub(crate) fn resolve_session_root(cwd: &Path) -> PathBuf {
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
pub(crate) fn jsonl_repo_for(root: &Path) -> JsonlSessionRepo {
    let fs: Arc<dyn rpi_tools::FileSystem> =
        Arc::new(rpi_tools::OsExecutionEnv::with_cwd(root.to_path_buf()));
    JsonlSessionRepo::with_env_cwd(JsonlSessionRepoOptions {
        fs,
        sessions_root: root.to_string_lossy().into_owned(),
        clock: Arc::new(SystemClock),
        ids: Arc::new(DefaultIdGenerator::new()),
    })
}

/// 按会话 id 在会话根里反查磁盘元数据。
pub(crate) fn session_meta_in(
    rt: &PiRuntime,
    root: &Path,
    id: &str,
) -> Result<JsonlSessionMetadata, String> {
    let repo = jsonl_repo_for(root);
    let metas = rt
        .block_on(repo.list_typed(&JsonlSessionListOptions { cwd: None }))
        .map_err(|e| format!("会话目录扫描失败 {}: {e}", root.display()))?;
    metas.into_iter().find(|m| m.id == id).ok_or_else(|| {
        format!(
            "会话 {id} 不在会话目录 {} 中（文件未落盘或不在会话目录）",
            root.display()
        )
    })
}

/// 装配一个 harness（含 provider 解析、contextWindow 回填、ui_dialog attach、
/// 新建会话的路径反查）。`session_path = Some` 走恢复路径。
///
/// `session_dir` = 环境（profile）隔离面（2026-11-22）：Some 时新会话落
/// 该目录（rpi `Args.session_dir` 原生支持，见 `pi_profiles`）；None =
/// 本体/默认解析（settings.sessionDir / `<cwd>/.rpi/sessions`）。
pub(crate) fn build_harness_impl(
    home: &rpi_cli::config::AgentHome,
    rt: &PiRuntime,
    cwd: &Path,
    session_path: Option<&str>,
    provider: Option<&str>,
    model: Option<&str>,
    extension_filter: Option<&[String]>,
    session_dir: Option<&Path>,
) -> Result<BuiltHarness, String> {
    // 能力开关（设置/主区页的技能与工具开关）落在这个 home 的
    // harness-capabilities.json；建会话时转成引擎策略：禁用技能经
    // Args.exclude_skills 从提示/注册表剔除，禁用工具集展开成
    // Args.exclude_tools denylist。只影响**新会话**（旧会话的提示已定）。
    let skill_exclusions = crate::pi_capabilities::skill_exclusions_for(home)?;
    let tool_exclusions = crate::pi_capabilities::toolset_exclusions_for(home)?;
    let (harness, events, reload, resolved_provider, model_id, id) = rt.block_on(async {
        let t_open = std::time::Instant::now();
        // 配置绑定（2026-11-25）：provider/model 解析读的是**这个 home** 的
        // settings/auth/models——不是进程级配置。跨环境打开会话不会拿错
        // provider 凭据。
        let mut resolved = rpi_cli::provider::resolve(home, provider, model, None, None, None)
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
        if !skill_exclusions.is_empty() {
            args.exclude_skills = skill_exclusions.clone();
        }
        if !tool_exclusions.is_empty() {
            args.exclude_tools = Some(tool_exclusions.clone());
        }
        if let Some(p) = session_path {
            args.session = Some(p.to_string());
        }
        // 环境隔离：具名 profile 的新会话落 `<home>/sessions`（rpi 的
        // session_dir 优先级 = args > settings.sessionDir > 默认）。
        if let Some(dir) = session_dir {
            args.session_dir = Some(dir.to_path_buf());
        }
        // per-bot 扩展白名单：`dev_local_only=true` 阻止模式分支扫全局目录，
        // 再逐文件加载白名单内的 DLL（Args.extension = 显式文件路径）。
        // None = 默认行为（扫描全局 extensions/ 目录）。
        if let Some(whitelist) = extension_filter {
            args.dev_local_only = true;
            args.extensions_dir.clear();
            // per-bot 扩展白名单从**会话 home** 的 extensions/ 里挑（配置绑定：
            // 具名环境的插件面是自己的；本体 = 进程 agent 目录，行为不变）。
            let ext_dir = home
                .global_dir("extensions")
                .ok_or_else(|| "会话 home 的 extensions 目录不可解析".to_string())?;
            if let Ok(entries) = std::fs::read_dir(&ext_dir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    let Some(name) = path.file_stem().and_then(|s| s.to_str()) else { continue };
                    if whitelist.iter().any(|w| w.trim().eq_ignore_ascii_case(name)) {
                        args.extension.push(path);
                    }
                }
            }
        }
        let t_prep = t_open.elapsed();
        // 诊断拆分（MIRACH_OPEN_TIMING）：纯存储只读重放的成本（不含 harness/
        // 插件装配）——用于区分「引擎 replay 地板」与「插件钩子开销」。
        if std::env::var_os("MIRACH_OPEN_TIMING").is_some() {
            if let Some(p) = session_path {
                let t_snap = std::time::Instant::now();
                let fs: Arc<dyn rpi_tools::FileSystem> =
                    Arc::new(rpi_tools::os_env::OsExecutionEnv::with_cwd(cwd.to_path_buf()));
                match JsonlSessionStorage::read_snapshot(
                    fs,
                    p,
                    Arc::new(SystemClock),
                    Arc::new(DefaultIdGenerator::new()),
                )
                .await
                {
                    Ok(_) => eprintln!("[open-timing] storage-only={:?}", t_snap.elapsed()),
                    Err(e) => eprintln!("[open-timing] storage-only failed: {e}"),
                }
            }
        }
        let (harness, events, reload) = rpi_cli::session::build(home, &resolved, &args, cwd, false)
            .await
            .map_err(|e| format!("Harness 构建失败: {e}"))?;
        let t_build = t_open.elapsed();
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
        if std::env::var_os("MIRACH_OPEN_TIMING").is_some() {
            eprintln!(
                "[open-timing] prep={:?} build={:?} total={:?}",
                t_prep,
                t_build - t_prep,
                t_open.elapsed()
            );
        }
        Ok::<_, String>((harness, events, reload, provider, model_id, id))
    })?;
    // 会话根的真相与 build 的 `Args.session_dir` 同源：具名环境用环境目录，
    // 否则走 settings/默认解析。新建会话的反查必须在这个根里找——用默认根
    // 会找不到刚落盘的具名环境会话。
    let sessions_root = session_dir
        .map(Path::to_path_buf)
        .unwrap_or_else(|| resolve_session_root(cwd));
    let path = match session_path {
        Some(p) => PathBuf::from(p),
        None => PathBuf::from(session_meta_in(rt, &sessions_root, &id)?.path),
    };
    Ok(BuiltHarness {
        harness: Arc::new(harness),
        events,
        reload,
        provider: resolved_provider,
        model_id,
        id,
        path,
        sessions_root,
    })
}

/// 工作区根（Phase 1 默认 = 用户主目录；工作区选择面后续接列头）。
pub(crate) fn default_workspace() -> PathBuf {
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
pub(crate) fn workspace_from_session_path(path: &Path) -> Option<PathBuf> {
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
                retired: Mutex::new(RetiredSessions::default()),
                side: Mutex::new(HashMap::new()),
                model_line: Mutex::new("引擎待启动".into()),
                messages_cache: Mutex::new(None),
                markers_cache: Mutex::new(None),
                session_facts_cache: Mutex::new(HashMap::new()),
                stats_cache: Mutex::new(None),
                active_profile: Mutex::new(None),
                pending_approval_mode: Mutex::new(None),
                pending_plan_mode: Mutex::new(false),
            }),
            approvals,
            asks,
            verifier: crate::pi_goal_verify::GoalVerifier::new(),
            compaction_sink: Mutex::new(None),
        }
    }

    /// 注入压缩进度出口（装配方调用一次，把事件推到 AG-UI 常驻流）。
    /// 参数 = (thread 键, 事件)——压缩属于**具体会话**，桥按会话键入桶
    /// （多会话并存：切走后压缩进度落自己的桶，不串台）。
    pub fn set_compaction_sink(
        &self,
        sink: Arc<dyn Fn(&str, serde_json::Value) + Send + Sync>,
    ) -> Result<(), String> {
        let mut slot = self
            .compaction_sink
            .lock()
            .map_err(|_| "compaction sink 锁中毒".to_string())?;
        *slot = Some(sink);
        Ok(())
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

    // ── 环境（profile）隔离（pi_profiles；2026-11-22）─────────────────────

    /// 当前活动环境名（None = 本体）。名字在 `set_active_profile` 已规范化。
    pub fn active_profile(&self) -> Result<Option<String>, String> {
        Ok(self
            .shared
            .active_profile
            .lock()
            .map_err(|_| "环境状态锁中毒".to_string())?
            .clone())
    }

    /// 切换活动环境（`pi_set_active_profile` 的实现）。返回规范化后的名字
    /// （None = 本体）。调用方负责随后的会话列表刷新/运行态复位。
    pub fn set_active_profile(&self, name: Option<&str>) -> Result<Option<String>, String> {
        let normalized = crate::pi_profiles::normalize_profile(name)?;
        *self
            .shared
            .active_profile
            .lock()
            .map_err(|_| "环境状态锁中毒".to_string())? = normalized.clone();
        Ok(normalized)
    }

    /// 活动环境的会话目录（写面；具名环境确保目录存在）。本体 = None。
    fn active_profile_sessions_dir(&self) -> Result<Option<PathBuf>, String> {
        let name = self.active_profile()?;
        match name.as_deref() {
            None => Ok(None),
            Some(n) => crate::pi_profiles::ensure_profile_dirs(Some(n)),
        }
    }

    /// Harness 装配（resolve → build）。`session_path` = Some 时走恢复路径
    /// （args.session + allow_existing 由 CLI build 自动接管）。
    ///
    /// **环境隔离**：新会话落点取当前活动 profile 的 session_dir（本体 =
    /// None → rpi 默认解析）；打开既有路径时 session_dir 只影响 `/reload`
    /// 的默认目录，不改该文件身份。
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
        self.build_harness_for_profile(cwd, session_path, provider, model, None)
    }

    /// 同 [`Self::build_harness_with`]，但允许显式指定**会话所属环境**。
    ///
    /// 配置绑定（2026-11-25 用户："会话本身没有成功绑定配置"；复刻 hermes 的
    /// profile = 完整 home）：home 与会话根同源——
    ///   · 显式 `profile`（bot 会话/后台泳道）→ 该环境 home（**不抢**引擎的
    ///     活动环境：bot 聊天落自己的 home，活动环境保持原样）；
    ///   · 打开既有会话（有路径）→ **文件所属环境**（`profiles/<name>/sessions/…`
    ///     路径即身份；本体/工作区文件 → None = 本体 home）；
    ///   · 新建会话（无路径、无 profile）→ 当前活动环境。
    /// home 决定技能/扩展/SYSTEM.md/settings/auth 的解析面（AgentHome 注入）。
    fn build_harness_for_profile(
        &self,
        cwd: &Path,
        session_path: Option<&str>,
        provider: Option<&str>,
        model: Option<&str>,
        profile: Option<&str>,
    ) -> Result<HarnessLive, String> {
        let (session_profile, profile_dir) = match profile {
            // 显式环境（bot）：home + 会话根都归它；具名环境确保目录存在。
            Some(name) => (
                crate::pi_profiles::normalize_profile(Some(name))?,
                crate::pi_profiles::ensure_profile_dirs(Some(name))?,
            ),
            None => match session_path {
                // 打开既有会话：绑定文件所属环境（本体/工作区 → None）。
                // **具名环境走 ensure_profile_dirs**：隔离前建的 bot home 只有
                // sessions/，补种子四件套（auth/models/settings/trust
                // copy-if-missing）否则解析不到模型（实测打开 remote-bot 会话
                // 报 "No API key" —— 纯读面 profile_sessions_dir 不够）。
                Some(p) => {
                    let scoped = crate::pi_profiles::profile_from_session_path(Path::new(p));
                    let dir = crate::pi_profiles::ensure_profile_dirs(scoped.as_deref())?;
                    (scoped, dir)
                }
                // 新建：当前活动环境（具名时确保目录存在）。
                None => (self.active_profile()?, self.active_profile_sessions_dir()?),
            },
        };
        let home = crate::pi_profiles::home_for_profile(session_profile.as_deref())?;
        let built = build_harness_impl(
            &home,
            &self.shared.rt,
            cwd,
            session_path,
            provider,
            model,
            None,
            profile_dir.as_deref(),
        )?;
        Ok(HarnessLive {
            harness: built.harness,
            events: built.events,
            reload: built.reload,
            session_path: Some(built.path),
            sessions_root: built.sessions_root,
            provider: built.provider,
            model_id: built.model_id,
            profile: session_profile,
        })
    }

    /// 会话根目录：与 rpi-cli `configured_session_dir`（session.rs:322-339）
    /// 同优先级——`settings.json` 的 sessionDir 优先，其次默认
    /// `<cwd>/.rpi/sessions`（`RPI_CODING_AGENT_SESSION_DIR` 由
    /// `default_session_dir` 处理）；相对路径相对启动项目解析。
    /// **必须与 build 的 `cwd` 同源**：根不一致会让新建会话的路径反查直接
    /// 失败（`new_session_with_cwd` 以用户选定工作区建会话）。
    ///
    /// **环境隔离（2026-11-22）**：具名 profile 在场时根 = 该环境的
    /// `<home>/sessions`（与 build 的 `Args.session_dir` 同一个来源）——
    /// 列表/反查/新会话三处同源，切换环境即切换整张会话面。
    fn session_root(&self, cwd: &Path) -> PathBuf {
        match crate::pi_profiles::normalize_profile(self.active_profile().ok().flatten().as_deref())
        {
            Ok(Some(name)) => match crate::pi_profiles::profile_sessions_dir(Some(&name)) {
                Ok(Some(dir)) => dir,
                Ok(None) => resolve_session_root(cwd),
                Err(e) => {
                    eprintln!("[profile] 环境 {name} 会话目录解析失败: {e}——按本体根列出");
                    resolve_session_root(cwd)
                }
            },
            _ => resolve_session_root(cwd),
        }
    }

    /// 会话根的 JSONL repo（列表/反查/fork 共用）。
    fn jsonl_repo(&self, root: &Path) -> JsonlSessionRepo {
        jsonl_repo_for(root)
    }

    /// 按会话 id 在会话根里反查磁盘元数据（rpi 不向宿主回报新建会话的
    /// 文件路径，只能用 repo 的公开 list 面反查；找不到 = Err）。
    fn session_metadata_in(&self, root: &Path, id: &str) -> Result<JsonlSessionMetadata, String> {
        session_meta_in(&self.shared.rt, root, id)
    }

    fn live(&self) -> Result<Arc<HarnessLive>, String> {
        self.live_opt()?.ok_or_else(|| NO_ACTIVE_SESSION.to_string())
    }

    /// 活动主会话的 pi session id（多会话事件路由用：`main:<id>` 线程键）。
    /// 无活动会话 = Err（调用方在 ensure/open 之后调，不该发生）。
    pub fn live_session_id(&self) -> Result<String, String> {
        let live = self.live()?;
        self.shared.rt.block_on(async {
            live.harness
                .session()
                .get_metadata()
                .await
                .map(|m| m.id)
                .map_err(|e| format!("会话元数据读取失败: {e}"))
        })
    }

    /// 活动主会话的文件路径（None = 尚未落盘 / 无会话）。
    pub fn live_session_path(&self) -> Option<std::path::PathBuf> {
        self.live_opt().ok()?.and_then(|live| live.session_path.clone())
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
    /// 取一个 harness 的会话 id（引擎元数据 = approval_gate 的 pin 键）。
    fn session_id_of(&self, live: &HarnessLive) -> Result<String, String> {
        self.shared.rt.block_on(async {
            live.harness
                .session()
                .get_metadata()
                .await
                .map(|m| m.id)
                .map_err(|e| format!("会话 id 读取失败: {e}"))
        })
    }

    /// 当前主柄会话 id（无 live = None）。
    fn current_session_id(&self) -> Result<Option<String>, String> {
        match self.live_opt()? {
            Some(live) => Ok(Some(self.session_id_of(&live)?)),
            None => Ok(None),
        }
    }

    /// 安装/切换 live 前应用该会话持久化的审批模式（跨重启保持 full access）。
    /// 读取失败只记 stderr、用默认审批——不阻断会话打开（偏好文件损坏不该
    /// 让用户丢会话），但失败可见。
    fn apply_persisted_approval_mode(&self, live: &HarnessLive) {
        let id = match self.session_id_of(live) {
            Ok(id) => id,
            Err(e) => {
                eprintln!("[approval] {e}");
                return;
            }
        };
        // 计划态是**运行期**状态：rpi-plan-mode 的 active 在插件 static，
        // 进程重启后条目虽在但插件不恢复 active（2026-11-23 实测）。
        // 因此内存里已有的 Planning pin 优先，不能被持久化文件覆盖；文件
        // 里若残留旧版写下的 planning，按 always-ask 处理并清掉。
        if rpi_cli::approval_gate::session_mode(&id) == rpi_cli::approval_gate::ApprovalMode::Planning
        {
            return;
        }
        match crate::approval_modes::mode_for(&id) {
            Ok(Some(persisted)) => {
                let mode = if persisted == rpi_cli::approval_gate::ApprovalMode::Planning {
                    rpi_cli::approval_gate::ApprovalMode::AlwaysAsk
                } else {
                    persisted
                };
                rpi_cli::approval_gate::set_session_mode(&id, mode);
                if mode != persisted {
                    if let Err(e) = crate::approval_modes::set_mode(&id, mode) {
                        eprintln!("[approval] 会话 {id} 计划残留清理落盘失败：{e}");
                    }
                }
            }
            Ok(None) => {}
            Err(e) => eprintln!("[approval] 会话 {id} 的审批模式读取失败：{e}"),
        }
    }

    /// 主会话（New Chat / 选文件夹 / 打开已有）落初始审批模式：
    /// - 新会话：优先消费 New Chat 里选的 pending（full access），否则用持久化
    ///   值，再否则 **always-ask**（默认不再全局 yolo）；
    /// - 打开已有会话：不消费 pending（New Chat 的暂存丢弃），用持久化值；
    /// - 已有 pin 的会话说 set_session_mode 覆盖即可（幂等）。
    fn pin_main_session_approval_mode(
        &self,
        session_id: &str,
        consume_pending: bool,
    ) -> Result<(), String> {
        if session_id.trim().is_empty() || session_id.starts_with("unknown(") {
            return Ok(());
        }
        let pending = self
            .shared
            .pending_approval_mode
            .lock()
            .map_err(|_| "审批模式 pending 锁中毒".to_string())?
            .take();
        let pending = if consume_pending { pending } else { None };
        let persisted = match crate::approval_modes::mode_for(session_id) {
            Ok(mode) => mode,
            Err(e) => {
                eprintln!("[approval] 会话 {session_id} 的审批模式读取失败：{e}");
                None
            }
        };
        // 旧版宿主可能把 planning 写进文件（现已禁止落盘）。计划态不跨
        // 进程重启，按 always-ask 处理并清掉残留。
        let persisted = match persisted {
            Some(rpi_cli::approval_gate::ApprovalMode::Planning) => {
                if let Err(e) = crate::approval_modes::set_mode(
                    session_id,
                    rpi_cli::approval_gate::ApprovalMode::AlwaysAsk,
                ) {
                    eprintln!("[approval] 会话 {session_id} 计划残留清理落盘失败：{e}");
                }
                Some(rpi_cli::approval_gate::ApprovalMode::AlwaysAsk)
            }
            other => other,
        };
        match pending.or(persisted) {
            Some(mode) => {
                rpi_cli::approval_gate::set_session_mode(session_id, mode);
                if pending.is_some() {
                    // 持久化失败不阻断建会话（内存 pin 已生效），但可见。
                    if let Err(e) = crate::approval_modes::set_mode(session_id, mode) {
                        eprintln!("[approval] 会话 {session_id} 的审批模式落盘失败：{e}");
                    }
                }
            }
            None => {
                rpi_cli::approval_gate::set_session_mode(
                    session_id,
                    rpi_cli::approval_gate::ApprovalMode::AlwaysAsk,
                );
            }
        }
        Ok(())
    }

    /// 新主会话落定后消费 New Chat 选择的计划模式（有则 `/plan start`）。
    /// 失败只记 stderr：会话已经建好，不能因计划启动失败把它丢掉。
    fn apply_pending_plan_mode(&self) {
        let enabled = match self.shared.pending_plan_mode.lock() {
            Ok(mut guard) => std::mem::replace(&mut *guard, false),
            Err(_) => {
                eprintln!("[plan] pending 计划模式锁中毒");
                false
            }
        };
        if !enabled {
            return;
        }
        match self.live_opt() {
            Ok(Some(live)) => {
                if let Err(e) = run_plugin_command(&live, "/plan", "start") {
                    eprintln!("[plan] 新会话启动计划模式失败：{e}");
                    return;
                }
                if let Ok(id) = self.session_id_of(&live) {
                    // 计划态的审批 pin = Planning（确定性拦截变更工具），
                    // 不是 Yolo：运行中的工具目录是 run 开始时快照的，只有
                    // 这层 gate 能让"对话中切计划"对当前 run 立即生效。
                    // **只设内存 pin，不落盘**：计划态不跨进程重启。
                    rpi_cli::approval_gate::set_session_mode(
                        &id,
                        rpi_cli::approval_gate::ApprovalMode::Planning,
                    );
                }
            }
            Ok(None) => eprintln!("[plan] 新会话计划模式 pending：没有活动 harness"),
            Err(e) => eprintln!("[plan] 新会话计划模式 pending 读取失败：{e}"),
        }
    }

    fn install_live(&self, live: HarnessLive) -> Result<(), String> {
        self.apply_persisted_approval_mode(&live);
        let installed = Arc::new(live);
        // 目标校验的触发源 = **本会话每一次 run 结束**（AgentEnd），不是
        // 「宿主 prompt 返回」——目标的首个工作轮由 rpi-goal 经
        // SendUserMessage 直接驱动引擎，不经过 PiEngine::prompt；只在
        // prompt_inner 挂钩会漏掉这类 run（2026-11-18 实机踩中：goal 首轮
        // 结束后无任何校验发生）。常驻订阅本会话事件流，每个会话一个。
        self.watch_runs(Arc::clone(&installed));
        // 压缩进度桥：把本会话的 HarnessEvent::CompactionProgress 映射成
        // AG-UI 的 CUSTOM name=compaction（前端 LiveCompactionRow 消费）。
        // 订阅挂在 bus 上、生命周期跟随 bus（会话被 retire 时 bus 也随之
        // 消亡，不会泄漏到下一个会话）。
        self.bridge_compaction(Arc::clone(&installed));
        let previous = self
            .shared
            .live
            .lock()
            .map_err(|_| "锁中毒".to_string())?
            .replace(installed);
        self.retire_previous(previous)?;
        // Arm the plugin-side completion bridge for this session: while armed,
        // the goal worker withholds its settled-boundary continuation until the
        // host reports a verdict (`_verify-start`/`_verify-result`). Idempotent;
        // a session without rpi-goal just logs and moves on.
        crate::pi_goal_verify::arm_goal_verification(&self.shared);
        // **不 cleanup**（多会话并存 2026-11-28）：install_live 换装时不清
        // 全局审批/ask 注册表——后台会话的挂起审批必须存活。旧会话的孤儿
        // 条目由删除会话（dropActor 路径）和 retired 驱逐（cancel_all +
        // responder 断）清理。
        Ok(())
    }

    /// 压缩进度桥：把 `HarnessEvent::CompactionProgress`（引擎在压缩前后各发
    /// 一次，`active=true/false`）映射成前端约定的 `CUSTOM name=compaction`
    /// 形状（`phase: start|end`）。
    ///
    /// 引擎事件不带 token 计数（`CompactionProgressEvent` 只有 lane/manual/
    /// active），所以不伪造 tokensBefore/After——前端 `compactionRowView`
    /// 对缺字段本来就会退成不带计数的文案。
    fn bridge_compaction(&self, live: Arc<HarnessLive>) {
        let sink = match self.compaction_sink.lock() {
            Ok(slot) => slot.clone(),
            Err(_) => {
                eprintln!("[pi] compaction sink 锁中毒——压缩进度不上报");
                return;
            }
        };
        let Some(sink) = sink else {
            // 装配方未注入（如 cargo test/后台 bot 泳道）——不是错误，静默跳过。
            return;
        };
        // 会话键：压缩发生在**本会话**，事件落 `main:<id>` 自己的桶
        // （多会话并存：切走后压缩进度也能在切回时从缓冲续放）。
        let Ok(session_id) = self.shared.rt.block_on(async {
            live.harness
                .session()
                .get_metadata()
                .await
                .map(|m| m.id)
                .map_err(|e| format!("会话元数据读取失败: {e}"))
        }) else {
            eprintln!("[pi] 压缩桥会话 id 读取失败——压缩进度不上报");
            return;
        };
        let thread_key = format!("main:{session_id}");
        use std::sync::Arc as StdArc;
        use rpi_harness::events::{CompactionProgressEvent, HarnessEvent};
        use rpi_harness::events::WatchListener;
        // `watch` 是接收**所有** HarnessEvent 的通用入口（引擎没给
        // CompactionProgressEvent 实现 HarnessEventOf，无法用 on_lifetime<T>）。
        // start() 后 watch 进入有效期，且句柄本身会被 bus 强引用保留。
        let mut handle = live.harness.events().watch(|| ());
        let listener: WatchListener = Arc::new(move |event: &HarnessEvent| {
            let HarnessEvent::CompactionProgress(CompactionProgressEvent {
                active, manual, ..
            }) = event
            else {
                return;
            };
            let mut value = serde_json::json!({
                "phase": if *active { "start" } else { "end" },
            });
            // reason 用 manual 区分手动/自动，前端文案会带上。
            if let Some(obj) = value.as_object_mut() {
                obj.insert(
                    "reason".into(),
                    serde_json::Value::String(
                        if *manual { "手动压缩" } else { "上下文接近上限" }.into(),
                    ),
                );
            }
            sink(&thread_key, serde_json::json!({
                "type": "CUSTOM",
                "name": "compaction",
                "value": value,
            }));
        });
        handle.start(listener);
    }

    /// 常驻 run 事件观察者：收到 `AgentEnd`（一次 run 收尾）就触发目标校验
    /// （闸门/去重都在 `pi_goal_verify::run_verification` 里）。上台时先跑一次
    /// 孤儿校验修复（应用退出/切走留下的 `verifying`）。
    fn watch_runs(&self, live: Arc<HarnessLive>) {
        repair_orphaned_goal_verification(
            Arc::clone(&self.shared),
            Arc::clone(&live),
            Arc::clone(&self.verifier),
        );
        let mut rx = live.events.resubscribe();
        let shared = Arc::clone(&self.shared);
        let verifier = Arc::clone(&self.verifier);
        let watcher_shared = Arc::clone(&shared);
        let watcher_verifier = Arc::clone(&verifier);
        shared.rt.spawn(async move {
            loop {
                match rx.recv().await {
                    Ok(AgentEvent::AgentEnd { .. }) => {
                        spawn_goal_verification(
                            Arc::clone(&watcher_shared),
                            Arc::clone(&live),
                            Arc::clone(&watcher_verifier),
                        );
                    }
                    Ok(_) => {}
                    // 广播滞后只丢事件不丢订阅（下一次 AgentEnd 仍会触发）。
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
        });
    }

    /// 把活动会话移入 retired 缓存（不 drop：见 EngineShared::retired 注释）。
    /// 没有 session_path 的在场态（不应存在）直接丢弃。
    ///
    /// **不 cancel ui_dialog**（多会话并存 2026-11-28）：切走时后台 run 的
    /// 挂起审批/ask 保留——切回来时邮箱轮询恢复、卡片继续可答（hermes 同
    /// 语义："switching never cancels a turn"）。真正的取消只发生在
    /// `release_retired_harness`（retired 容量驱逐，句柄真正消失时）。
    fn retire_previous(&self, previous: Option<Arc<HarnessLive>>) -> Result<(), String> {
        let Some(previous) = previous else {
            return Ok(());
        };
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

    /// 当前分支上**全部**插件自定义条目的 `data`（按 seq 升序）。
    ///
    /// `latest_plugin_entry` 的实现底座；目标校验结论（`goal-verification`）
    /// 需要全量列表（逐轮累积），故暴露为一个口。
    fn plugin_entries(
        &self,
        live: &HarnessLive,
        custom_type: &str,
    ) -> Result<Vec<serde_json::Value>, String> {
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
        let mut rows: Vec<(u64, serde_json::Value)> = Vec::new();
        for entry in entries {
            match entry {
                Entry::Custom(entry) if entry.custom_type == custom_type => {
                    let data = entry.data.ok_or_else(|| {
                        format!("{custom_type} 条目缺少 data（条目损坏：{}）", entry.base.id)
                    })?;
                    rows.push((entry.base.seq, data));
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
        rows.sort_by_key(|(seq, _)| *seq);
        Ok(rows.into_iter().map(|(_, data)| data).collect())
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
        Ok(self.plugin_entries(live, custom_type)?.pop())
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
        let id = self.session_id_of(&live)?;
        self.pin_main_session_approval_mode(&id, true)?;
        *self
            .shared
            .model_line
            .lock()
            .map_err(|_| "锁中毒".to_string())? = format!("{}/{}", live.provider, live.model_id);
        self.install_live(live)?;
        self.apply_pending_plan_mode();
        Ok(())
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
        let target_key = session_cache_key(Path::new(path));
        // 并列窗格里开着的同一会话：直接上台复用（不能重建出第二个写者）。
        // 窗格键随句柄一起交出，句柄离开窗格表后窗格侧下次 side_open 会重
        // 新按路径复用同一祖先句柄的替身——这里只取走句柄本身。
        let from_side = {
            let mut side = self
                .shared
                .side
                .lock()
                .map_err(|_| "窗格会话表锁中毒".to_string())?;
            let key = side.iter().find_map(|(thread_key, session)| {
                session
                    .session_path
                    .as_ref()
                    .map(|p| session_cache_key(p))
                    .filter(|p| p == &target_key)
                    .map(|_| thread_key.clone())
            });
            key.and_then(|key| side.remove(&key))
        };
        let cached = match from_side {
            Some(handle) => Some(handle),
            None => self
                .shared
                .retired
                .lock()
                .map_err(|_| "retired 会话表锁中毒".to_string())?
                .take(&target_key),
        };
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
            // 不 cleanup（多会话并存：后台会话的审批/ask 保留）
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
        self.pin_main_session_approval_mode(&id, false)?;
        // 打开已有会话 = 离开 New Chat：暂存的计划选择不消费。
        if let Ok(mut pending) = self.shared.pending_plan_mode.lock() {
            *pending = false;
        }
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
        // New Chat 的审批暂存随旧会话一起丢弃：下一个真实会话重新按默认/
        // 持久化值落 pin，不继承上一个会话的 full access。
        if let Ok(mut pending) = self.shared.pending_approval_mode.lock() {
            *pending = None;
        }
        if let Ok(mut pending) = self.shared.pending_plan_mode.lock() {
            *pending = false;
        }
        // 不 cleanup（多会话并存：discard 退 retired，后台 run 的审批保留）
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
        self.pin_main_session_approval_mode(&id, true)?;
        self.install_live(live)?;
        self.apply_pending_plan_mode();
        Ok(id)
    }

    // ── 对话 ────────────────────────────────────────────────────────────────

    /// 把外部（Claude Code）会话转成 pi 会话落盘（迁移向导用）。
    /// `cwd` 决定会话根（与 build 的 session_dir 同源），`title` 写入会话名。
    pub(crate) fn import_agent_session(
        &self,
        cwd: &str,
        title: Option<&str>,
        messages: Vec<rpi_agent::message::AgentMessage>,
    ) -> Result<String, String> {
        let root = self.session_root(&PathBuf::from(cwd));
        let repo = jsonl_repo_for(&root);
        let options = JsonlSessionCreateOptions {
            id: None,
            parent_session_id: None,
            cwd: cwd.to_string(),
            metadata: None,
        };
        let title = title.map(str::to_string);
        self.shared.rt.block_on(async move {
            let storage = repo
                .create_typed(&options)
                .await
                .map_err(|e| format!("创建导入会话失败: {e}"))?;
            let session = Session::new(
                Arc::new(storage) as Arc<dyn rpi_harness::session::types::SessionStorage>,
                None,
            );
            for message in messages {
                session
                    .append_message(message)
                    .await
                    .map_err(|e| format!("写入导入消息失败: {e}"))?;
            }
            if let Some(title) = title {
                session
                    .set_name(Some(&title))
                    .await
                    .map_err(|e| format!("设置导入会话名失败: {e}"))?;
            }
            let metadata = session
                .get_metadata()
                .await
                .map_err(|e| format!("读取导入会话元数据失败: {e}"))?;
            Ok(metadata.id)
        })
    }

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
        self.run_prompt_on(live, text.to_owned(), images, on_event, on_start)
    }

    /// 在一个具体 harness 句柄上跑一轮（前台与并列窗格共用；句柄各自独立，
    /// 因此两个窗格可并行跑）。
    fn run_prompt_on(
        &self,
        live: Arc<HarnessLive>,
        text: String,
        images: Vec<ImageContent>,
        on_event: impl Fn(AgentEvent) + Send + Sync + 'static,
        on_start: Box<dyn FnOnce() + Send>,
    ) -> Result<(), String> {
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
            let result = AgentLane::prompt_text(harness.as_ref(), &text, images).await;
            // TURN_END/AGENT_END 在 prompt 返回前已 emit；30ms 让广播线程把
            // 尾部事件交付完，再停 drain（绝不 await 到 sender 关闭）。
            tokio::time::sleep(std::time::Duration::from_millis(30)).await;
            let _ = stop_tx.send(true);
            let _ = drain.await;
            // **RunResult.outcome = Failed 也是失败**（2026-11-25 实锤）：
            // rpi 对 provider 连接失败/重试耗尽不发 AgentEnd(error)，而是
            // 发一个 StopReason::Error 的 assistant 消息 + AgentEnd，并让
            // prompt 返回 Ok(RunResult { outcome: Failed { error } })。
            // 旧实现 `result.map(|_| ())` 把这种 Ok 当成功 → agui 只推
            // RUN_FINISHED、不推 RUN_ERROR；空 assistant 消息又被前端隐藏，
            // 用户看到的就是"发了消息，AI 没回复，也没错误"。
            // 这里把 Failed 转成 Err，让 agui 的 Err 分支推 RUN_ERROR。
            // Aborted（用户中断）是正常收尾，不是错误，保持 Ok。
            match result {
                Ok(run) => match run.outcome {
                    HarnessRunOutcome::Failed { error, .. } => {
                        if error.message.trim().is_empty() {
                            Err(format!("运行失败（{}）", error.code))
                        } else {
                            Err(error.message)
                        }
                    }
                    _ => Ok(()),
                },
                Err(e) => Err(e.to_string()),
            }
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

    /// 运行中注入用户引导（设置页「行为与工具 → 交互行为 = 引导」的宿主桥）。
    ///
    /// `AgentLane::steer` 把消息放进 steer 队列，引擎在当前 run 的**下一次
    /// 工具调用批后**注入（rpi-agent getSteeringMessages 同语义；ZCode
    /// 「引导至下一轮工具调用后运行」）。带图与 prompt 同构
    /// （`UserContent::Blocks`）；图片校验复用 POST 的白名单（不静默丢）。
    /// 无活动会话/无活跃 run 时上游返回错误——原样传播（前端只在 lane
    /// busy + streaming 时调用；错误即错误，不吞）。
    pub fn steer(&self, text: &str, images: &[AguiImage]) -> Result<(), String> {
        let text = text.trim();
        if text.is_empty() && images.is_empty() {
            return Err("steer: text 与 images 不能同时为空".into());
        }
        crate::agui::validate_images(images)?;
        let content = if images.is_empty() {
            UserContent::Text(text.to_owned())
        } else {
            let mut blocks: Vec<Content> = Vec::new();
            if !text.is_empty() {
                blocks.push(Content::text(text));
            }
            blocks.extend(images.iter().map(|img| {
                Content::Image(ImageContent {
                    kind: Default::default(),
                    data: std::sync::Arc::from(img.data.as_str()),
                    mime_type: img.mime_type.clone(),
                })
            }));
            UserContent::Blocks(blocks)
        };
        let message = rpi_agent::message::AgentMessage::User(UserMessage::new(
            content,
            chrono::Utc::now().timestamp_millis(),
        ));
        let live = self.live()?;
        self.shared.rt.block_on(async {
            AgentLane::steer(live.harness.as_ref(), message)
                .await
                .map(|_| ())
                .map_err(|e| e.to_string())
        })
    }

    /// main lane 是否仍有活动 run。
    ///
    /// RUN_FINISHED 事件到达 ≠ prompt 返回：引擎在收尾（落盘/广播排空）期间
    /// lane 仍是 busy，此时再 POST 会得到 "Lane main already has an active
    /// run operation"（2026-11-15 用户实报）。前端在提交与队列 drain 前先
    /// 查这个（`AgentHarness::snapshot().active`），把消息留在本地队列，
    /// 等 lane 真正空闲再发。
    pub fn lane_busy(&self) -> Result<bool, String> {
        // 无活动会话 = 没有 lane 可忙（New Chat 首条消息前）——这不是
        // 错误降级，是"没有运行"的定义；真正的 harness 错误仍传播。
        let live = match self.live() {
            Ok(live) => live,
            Err(_) => return Ok(false),
        };
        self.shared.rt.block_on(async {
            let snapshot = live
                .harness
                .snapshot()
                .await
                .map_err(|e| e.to_string())?;
            Ok(snapshot.active.is_some())
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
        // 事实缓存（2026-11-19 性能轮）：会话文件 append-only，stat 不变 →
        // header/name/messageCount 整行复用。巨会话（11MB/2036 条）每次
        // read_snapshot 重放约数秒，侧栏刷新 / run 收尾都会反复触发。
        let mut rows: Vec<serde_json::Value> = Vec::new();
        let mut pending: Vec<(PathBuf, u64, u64)> = Vec::new();
        {
            let cache = self
                .shared
                .session_facts_cache
                .lock()
                .map_err(|_| "会话事实缓存锁中毒".to_string())?;
            for (path, meta) in &files_to_scan {
                let mtime_ms = meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0);
                match cache.get(path) {
                    // row 只有 list_sessions 自己填；index_sessions 写入的缓存行
                    // row=Null，list 面遇到要按 miss 重新投影（不吐空行）。
                    Some(c) if c.len == meta.len() && c.mtime_ms == mtime_ms && c.row.is_object() => {
                        rows.push(c.row.clone());
                    }
                    _ => pending.push((path.clone(), meta.len(), mtime_ms)),
                }
            }
        }
        if !pending.is_empty() {
            // 只读快照：不抢 writer lease（活动会话也能列出），reducer 与引擎同源。
            let fs: Arc<dyn rpi_tools::FileSystem> = Arc::new(
                rpi_tools::os_env::OsExecutionEnv::with_cwd(self.shared.cwd.clone()),
            );
            let facts = self.shared.rt.block_on(async {
                let mut out = Vec::with_capacity(pending.len());
                for (path, len, mtime_ms) in &pending {
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
                    out.push((path.clone(), *len, *mtime_ms, name, stats));
                }
                out
            });
            let mut cache = self
                .shared
                .session_facts_cache
                .lock()
                .map_err(|_| "会话事实缓存锁中毒".to_string())?;
            for (path, len, mtime_ms, name, stats) in facts {
                // 头信息（id/cwd）从首行取：只读首行，不整文件读、不重放整棵树。
                let first = read_first_line(&path)
                    .and_then(|l| serde_json::from_str::<serde_json::Value>(&l).ok());
                let (id, cwd) = match &first {
                    Some(h) => (
                        h.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                        h.get("cwd").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                    ),
                    None => (String::new(), String::new()),
                };
                let message_count = stats.as_ref().map(|s| s.message_count).unwrap_or(0);
                let row = serde_json::json!({
                    "path": path.to_string_lossy(),
                    "id": id,
                    "cwd": cwd,
                    "timestamp": "",
                    "messageCount": stats.as_ref().map(|s| s.message_count),
                    "lastModifiedMs": mtime_ms,
                    "sizeBytes": len,
                    "name": name.clone(),
                });
                rows.push(row.clone());
                cache.insert(
                    path,
                    SessionFactsCache {
                        len,
                        mtime_ms,
                        name: name.clone().flatten(),
                        message_count,
                        row,
                    },
                );
            }
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
    /// **跨环境聚合（2026-11-25，hermes 侧栏「网关与配置」语义）**：本体
    /// 环境的既有根之外，再扫**每个具名环境**的 `<home>/sessions`，记录带
    /// `profile` 标签——侧栏一个列表看全部环境的会话，按配置分组/筛选用这个
    /// 标签（切环境只影响新建会话落点与资源解析，不再让列表整体换源）。
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

        let cwd = self.shared.cwd.clone();
        let mut roots: Vec<si::ScanRoot> = Vec::new();

        // 本体环境（既有行为不变）：settings.sessionDir → 项目根 → 当前 cwd。
        let settings = rpi_cli::settings::load_settings()
            .map_err(|e| format!("读 rpi 设置失败，无法确定 sessionDir: {e}"))?;

        if let Some(dir) = settings.session_dir.as_ref() {
            si::push_root(
                &mut roots,
                si::resolve_session_path(dir, &cwd),
                si::RootKind::SessionDir,
                None,
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
                None,
            );
        }
        let workspace_default = rpi_cli::session::default_session_dir(&cwd);
        si::push_root(
            &mut roots,
            si::resolve_session_path(&workspace_default, &cwd),
            si::RootKind::Workspace,
            None,
        );

        // 每个具名环境的 home 会话根（跨环境聚合）。环境目录读不了 = Err，
        // 不把"坏环境"静默当成"没有环境"。
        for name in crate::pi_profiles::list_profile_names()? {
            if let Some(dir) = crate::pi_profiles::profile_sessions_dir(Some(&name))? {
                si::push_root(&mut roots, dir, si::RootKind::Profile, Some(name));
            }
        }

        self.index_sessions_from_roots(roots)
    }

    /// `index_sessions` 的共享扫描体：根已解析后的候选收集/project 归属/
    /// 排序/统计（本体与具名环境同一条路，防止两份实现漂移）。
    fn index_sessions_from_roots(
        &self,
        roots: Vec<crate::session_index::ScanRoot>,
    ) -> Result<crate::session_index::IndexScan, String> {
        use crate::session_index as si;
        use std::collections::HashSet;

        let cwd = self.shared.cwd.clone();

        struct Candidate {
            path: PathBuf,
            source_root: String,
            source: si::RootKind,
            /// 根所属环境（记录沿根继承——侧栏按配置分组/筛选的标签）。
            profile: Option<String>,
            header: si::SessionHeader,
            modified: u64,
            size: u64,
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
                    profile: root.profile.clone(),
                    header,
                    modified,
                    size: metadata.len(),
                });
            }
        }

        // 快照读取（name / messageCount）走引擎运行时；逐项结果带出来，
        // 错误在 await 之外落 skipped（避免跨 await 的 &mut 借用）。
        // **stat 未变（append-only）→ 复用 list_sessions 填过的事实缓存**，
        // 不再对每个会话整树重放——40+ 会话（含 11MB 巨文件）实测 ~8s → ms。
        let fs: Arc<dyn rpi_tools::FileSystem> = Arc::new(
            rpi_tools::os_env::OsExecutionEnv::with_cwd(cwd.clone()),
        );
        let mut facts: Vec<Option<Result<(Option<String>, u64), String>>> =
            vec![None; candidates.len()];
        let mut misses: Vec<usize> = Vec::new();
        {
            let cache = self
                .shared
                .session_facts_cache
                .lock()
                .map_err(|_| "会话事实缓存锁中毒".to_string())?;
            for (index, candidate) in candidates.iter().enumerate() {
                match cache.get(&candidate.path) {
                    Some(cached)
                        if cached.len == candidate.size && cached.mtime_ms == candidate.modified =>
                    {
                        facts[index] = Some(Ok((cached.name.clone(), cached.message_count)));
                    }
                    _ => misses.push(index),
                }
            }
        }
        if !misses.is_empty() {
            let fetched = self.shared.rt.block_on(async {
                let mut out = Vec::with_capacity(misses.len());
                for index in misses {
                    let candidate = &candidates[index];
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
                    out.push((index, result));
                }
                out
            });
            let mut cache = self
                .shared
                .session_facts_cache
                .lock()
                .map_err(|_| "会话事实缓存锁中毒".to_string())?;
            for (index, result) in fetched {
                if let Ok((name, message_count)) = &result {
                    let candidate = &candidates[index];
                    cache.insert(
                        candidate.path.clone(),
                        SessionFactsCache {
                            len: candidate.size,
                            mtime_ms: candidate.modified,
                            name: name.clone(),
                            message_count: *message_count,
                            row: serde_json::Value::Null,
                        },
                    );
                }
                facts[index] = Some(result);
            }
        }

        let mut records: Vec<si::SessionRecord> = Vec::with_capacity(candidates.len());
        for (candidate, fact) in candidates.into_iter().zip(facts) {
            match fact {
                Some(Ok((name, message_count))) => records.push(si::SessionRecord {
                    id: candidate.header.id,
                    path: candidate.path.to_string_lossy().into_owned(),
                    cwd: candidate.header.cwd,
                    name,
                    message_count,
                    last_modified: candidate.modified,
                    created_at: candidate.header.created_at,
                    parent_session_id: candidate.header.parent_session_id,
                    project_id: None,
                    profile: candidate.profile,
                    source_root: candidate.source_root,
                    source: candidate.source,
                }),
                Some(Err(reason)) => skipped.push(si::SkippedSession {
                    path: candidate.path.to_string_lossy().into_owned(),
                    root: candidate.source_root,
                    reason,
                }),
                None => skipped.push(si::SkippedSession {
                    path: candidate.path.to_string_lossy().into_owned(),
                    root: candidate.source_root,
                    reason: "会话事实缺失（未扫到统计）".into(),
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
        // 并列窗格里开着的会话同样不可删：删文件后窗格里的句柄仍持
        // writer lease（Windows 下文件可删但重开会读到损坏/空会话）。
        let side_is_target = self
            .shared
            .side
            .lock()
            .map_err(|_| "窗格会话表锁中毒".to_string())?
            .values()
            .any(|session| {
                session
                    .session_path
                    .as_ref()
                    .map(|p| p.to_string_lossy() == path)
                    .unwrap_or(false)
            });
        if side_is_target {
            return Err("该会话正在窗格中打开（先关闭窗格）".into());
        }
        std::fs::remove_file(path).map_err(|e| format!("删除失败: {e}"))?;
        // rpi 会话带两个伴生文件：`<path>.lock` 与 `<path>.progress.jsonl`。
        // 主文件删掉后一并清理，否则「0 消息不落盘」的清扫会留下孤儿文件
        //（索引扫描会跳过它们，但磁盘上仍是残留）。伴生文件不存在是正常
        // 态；清理失败只记 stderr——主文件已删，不能把整体结果谎报成失败。
        for suffix in [".lock", ".progress.jsonl"] {
            let companion = std::path::PathBuf::from(format!("{path}{suffix}"));
            match std::fs::remove_file(&companion) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => {
                    eprintln!(
                        "会话主文件已删除，但伴生文件清理失败（{}）：{e}",
                        companion.display()
                    );
                }
            }
        }
        Ok(())
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
        // `snapshot_stats` 会整文件重扫（巨文件 ~0.3s）；文件 stat 不变即复用
        // 上次结果（append-only，2026-11-19 性能轮）。
        let message_count = match live.session_path.as_deref() {
            Some(p) => self.snapshot_stats_cached(&p.to_string_lossy())?.message_count,
            None => 0,
        };
        // ThinkingLevel 的 serde 拼法 = 上游 wire 拼法（off/minimal/…/xhigh/
        // max，rpi-ai types.rs 的 rename_all="lowercase"）——前端
        // composer-wired 按字符串回填档位。
        let thinking_level = serde_json::to_value(thinking)
            .map_err(|e| format!("思考档位序列化失败: {e}"))?;
        // 扩展装载真值（此前硬编码 false：rpi 插件实际已加载，扩展 slash
        // 命令可用——假值会误导前端做能力判断）。
        let has_extensions = live
            .reload
            .extension_session
            .lock()
            .map(|session| !session.is_empty())
            .map_err(|_| "扩展会话锁中毒".to_string())?;
        Ok(serde_json::json!({
            "sessionId": session_id,
            "provider": model.provider,
            "modelId": model.id,
            "thinkingLevel": thinking_level,
            "messageCount": message_count,
            "hasExtensions": has_extensions,
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
        // 配置绑定：模型目录 = **活动环境** home 的 models.json（切 bot 后
        // 设置页/模型选择器看到的是那个环境自己的已配置集）。
        let home = crate::pi_profiles::home_for_profile(self.active_profile()?.as_deref())?;
        let cfg = home
            .models_config()
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
        // 配置绑定：校验与默认值写回都按**该会话所属环境**的 home——
        // bot 聊天跨环境打开时不能拿活动环境的 models.json 校验，也不能把
        // 默认模型写进别人的 settings.json。
        let home = crate::pi_profiles::home_for_profile(live.profile.as_deref())?;
        let cfg = home
            .models_config()
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
        crate::pi_settings::persist_default_model(&home, provider, model_id)?;
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

    /// 模式快照（前端 mode-chip 每 2s 拉一次）：**会话级**。
    ///
    /// - `planMode` = 该会话 rpi-plan-mode 的激活态（插件每会话一份实例；
    ///   `plan-mode` 条目 + 主柄 `/plan status` 校验）；
    /// - `planPending` 恒 null：rpi 插件没有 dsh `exit_plan_mode` 那种宿主审批闸
    ///   （`plan_mode_complete` 只存计划并退出），不造假 pending 卡；
    /// - `approvalMode` = 该会话的审批 pin（always-ask/write/yolo；引擎
    ///   `approval_gate::session_mode`，宿主持久化 approval-modes.json）。
    ///
    /// 无活动会话 = 默认快照（New Chat：pending 计划/审批可读；否则
    /// always-ask / plan off——不是错误）。
    pub fn mode_state_for(&self, session_id: Option<&str>) -> Result<serde_json::Value, String> {
        // rpi 的「模式」= plan-mode 插件态 + 启动期权限闸开关
        // （permissionGate，RPI_PERMISSION_GATE=1 → bash/write/edit 每次确认）。
        // 该开关**只读**：扩展在会话构建时读 env，宿主没有运行时切换面。
        let gate = permission_gate_enabled();
        let live = self.live_opt()?;
        let live_id = match live.as_deref() {
            Some(live) => Some(self.session_id_of(live)?),
            None => None,
        };
        let requested = session_id
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .map(str::to_owned);
        let target = requested.clone().or_else(|| live_id.clone());
        let target_live = match &requested {
            Some(id) => self.session_harness(id)?,
            None => live.clone(),
        };
        let mut wire = match target_live.as_deref() {
            None => crate::pi_plugin_state::mode_wire(None)?,
            Some(target_live) => {
                let data = self.latest_plugin_entry(target_live, crate::pi_plugin_state::PLAN_ENTRY)?;
                crate::pi_plugin_state::mode_wire(data.as_ref())?
            }
        };
        // **插件 static 的覆盖**：rpi-plan-mode 的 active 在模块级 static；
        // 现在 loader 为每个会话加载独立副本，SessionStart/Tree 会从该会话
        // 的 plan-mode 条目恢复。主柄再补一次 `/plan status` 真值覆盖，防止
        // 条目与运行态短暂不同步（窗格没有主柄命令面，只读条目）。
        if requested.is_none() || requested == live_id {
            if let Ok(status) = self.run_command("/plan", "status") {
                if let Some(text) = status.get("text").and_then(|v| v.as_str()) {
                    if text.contains("Plan · Planning") {
                        wire["planMode"] = serde_json::json!("planning");
                    } else if wire["planMode"] == serde_json::json!("planning") {
                        wire["planMode"] = serde_json::json!("off");
                    }
                }
            }
        }
        wire["permissionGate"] = serde_json::json!(gate);
        if target.is_none() {
            let pending_plan = self
                .shared
                .pending_plan_mode
                .lock()
                .map_err(|_| "计划模式 pending 锁中毒".to_string())?;
            if *pending_plan {
                wire["planMode"] = serde_json::json!("planning");
            }
        }
        // 计划 pin 与插件态对账：rpi-plan-mode 的 `plan_mode_complete` 是
        // 存盘即退出，插件自己把 active 置 false，但 approval pin 还停在
        // Planning——不校正的话后续轮次的变更工具会被 gate 无由拦截。
        // 反向同理（计划态恢复但 pin 丢了）也要补。**只改内存 pin**：计划
        // 态不跨进程重启，落盘会在重启后留下假的 planning。这个读口每 2s
        // 被 UI 轮询，顺带做幂等对账。
        if let (Some(id), Some(_)) = (target.as_deref(), target_live.as_deref()) {
            let plan_active = wire["planMode"] == serde_json::json!("planning");
            let pinned = rpi_cli::approval_gate::session_mode(id);
            if plan_active && pinned != rpi_cli::approval_gate::ApprovalMode::Planning {
                rpi_cli::approval_gate::set_session_mode(
                    id,
                    rpi_cli::approval_gate::ApprovalMode::Planning,
                );
            } else if !plan_active && pinned == rpi_cli::approval_gate::ApprovalMode::Planning {
                rpi_cli::approval_gate::set_session_mode(
                    id,
                    rpi_cli::approval_gate::ApprovalMode::AlwaysAsk,
                );
            }
        }
        // 会话级审批模式：有 sessionId 读该会话 pin；New Chat（无 live）读
        // pending；再回退进程默认（bot/侧栏仍走默认）。
        let approval = match &target {
            Some(id) => rpi_cli::approval_gate::session_mode(id),
            None => self
                .shared
                .pending_approval_mode
                .lock()
                .map_err(|_| "审批模式 pending 锁中毒".to_string())?
                .unwrap_or(rpi_cli::approval_gate::ApprovalMode::AlwaysAsk),
        };
        wire["approvalMode"] = serde_json::json!(approval.as_wire());
        Ok(wire)
    }

    pub fn mode_state(&self) -> Result<serde_json::Value, String> {
        self.mode_state_for(None)
    }

    /// 目标态（活动面板「目标」分区）：rpi-goal 把状态存成当前分支的
    /// `goal-state` custom 条目（data = `{active, archived}`）。无条目 =
    /// Null（诚实空态）。
    ///
    /// **状态真源就是插件**（vendored fork）：`active` 里带 goal v2 的
    /// `status`（active / verifying / paused / blocked / waiting /
    /// usage_limited / budget_limited / complete）、`iteration`、
    /// `iterations[]`、`verifications[]`，由宿主校验流程经 `/goal _verify-*`
    /// 驱动（见 `pi_goal_verify.rs`）。宿主不再另写条目、也不再合成
    /// `verifying`——面板拿到的每个字段都是插件持久化的真值。
    pub fn goal_state(&self) -> Result<serde_json::Value, String> {
        let Some(live) = self.live_opt()? else {
            return Ok(serde_json::Value::Null);
        };
        Ok(self
            .latest_plugin_entry(&live, "goal-state")?
            .unwrap_or(serde_json::Value::Null))
    }

    /// 会话计划目录（活动面板「会话计划」分区）：rpi-plan-mode 每次
    /// `plan_mode_complete` 都 AppendEntry 一条 `plan-mode` 条目
    /// （customType `plan-mode`，data `{active, plan}`，plan = 完整 markdown，
    /// 见 pi_plugin_state.rs 模块头证据）。沿当前分支枚举**有 plan 文本**的
    /// 条目（= 已完成计划；active 条目 plan 为 null 不算），按 seq 降序 —
    /// 上游 sessionPlans 目录同序（最新在前）。
    ///
    /// 返回 `[{entryId, seq, timestamp, plan}]`；无条目 = 空数组（诚实空态）。
    /// 条目缺 data / plan 非字符串 = Err（条目损坏，不静默丢行）。
    pub fn plan_entries(&self) -> Result<serde_json::Value, String> {
        let Some(live) = self.live_opt()? else {
            return Ok(serde_json::Value::Array(Vec::new()));
        };
        let entries = self.shared.rt.block_on(async {
            live.harness
                .session()
                .find_entries_on_branch(
                    &EntryQuery {
                        entry_type: Some("custom"),
                        custom_type: Some(crate::pi_plugin_state::PLAN_ENTRY.to_string()),
                        ..Default::default()
                    },
                    &BranchBounds::default(),
                )
                .await
                .map_err(|e| format!("会话条目读取失败（plan-mode）: {e}"))
        })?;
        let mut rows: Vec<(u64, serde_json::Value)> = Vec::new();
        for entry in entries {
            let Entry::Custom(custom) = entry else {
                continue;
            };
            if custom.custom_type != crate::pi_plugin_state::PLAN_ENTRY {
                continue;
            }
            let data = custom.data.as_ref().ok_or_else(|| {
                format!(
                    "plan-mode 条目缺少 data（条目损坏：{}）",
                    custom.base.id
                )
            })?;
            match data.get("plan") {
                // 进入/未完成态：plan 尚未产出（attached 为 null）。
                None | Some(serde_json::Value::Null) => {}
                Some(serde_json::Value::String(text)) => {
                    if !text.trim().is_empty() {
                        rows.push((
                            custom.base.seq,
                            serde_json::json!({
                                "entryId": custom.base.id,
                                "seq": custom.base.seq,
                                "timestamp": custom.base.timestamp,
                                "plan": text,
                            }),
                        ));
                    }
                }
                Some(_) => {
                    return Err(format!(
                        "plan-mode 条目 data.plan 不是字符串（条目损坏：{}）",
                        custom.base.id
                    ))
                }
            }
        }
        rows.sort_by(|a, b| b.0.cmp(&a.0));
        Ok(serde_json::Value::Array(
            rows.into_iter().map(|(_, row)| row).collect(),
        ))
    }

    /// 该 id 是否是并列窗格会话（审批卡只在前台窗口渲染；窗格里切到
    /// always-ask 会让工具调用等一个永远不会出现的审批卡）。
    fn is_side_session_id(&self, session_id: &str) -> Result<bool, String> {
        let handles: Vec<Arc<HarnessLive>> = self
            .shared
            .side
            .lock()
            .map_err(|_| "窗格会话表锁中毒".to_string())?
            .values()
            .cloned()
            .collect();
        for handle in handles {
            if self.session_id_of(&handle).ok().as_deref() == Some(session_id) {
                return Ok(true);
            }
        }
        Ok(false)
    }

    pub fn set_approval_mode_for(
        &self,
        session_id: Option<&str>,
        mode: &str,
    ) -> Result<(), String> {
        let parsed = rpi_cli::approval_gate::ApprovalMode::parse(mode).ok_or_else(|| {
            format!(
                "未知审批模式 `{mode}`（可用：always-ask / write / yolo）"
            )
        })?;
        // Planning 是计划模式的内部 pin，必须与插件的 `/plan start|exit`
        // 同步；走审批 IPC 单独设置会造出"gate 拦变更但插件没进计划"的
        // 半态。计划模式入口只有 `pi_set_plan_mode`。
        if parsed == rpi_cli::approval_gate::ApprovalMode::Planning {
            return Err(
                "planning 不能经审批接口设置：计划模式请用 pi_set_plan_mode（它会同步插件态）"
                    .into(),
            );
        }
        let requested = session_id
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .map(str::to_owned);
        let live_id = match self.live_opt()? {
            Some(live) => Some(self.session_id_of(&live)?),
            None => None,
        };
        let target = match requested {
            Some(id) => Some(id),
            None => live_id.clone(),
        };
        // 并列窗格的审批卡没有渲染面：只允许保持完全访问，不允许切到
        // 会等待审批的档位（错误可见，不静默挂起工具调用）。
        if let (Some(id), Some(live_id)) = (target.as_deref(), live_id.as_deref()) {
            if id != live_id && parsed != rpi_cli::approval_gate::ApprovalMode::Yolo {
                if self.is_side_session_id(id)? {
                    return Err(
                        "并列窗格暂不支持逐次审批（审批卡只在前台渲染）；请保持完全访问"
                            .into(),
                    );
                }
            }
        }
        match target {
            Some(id) => {
                rpi_cli::approval_gate::set_session_mode(&id, parsed);
                crate::approval_modes::set_mode(&id, parsed)?;
            }
            None => {
                // New Chat：暂存到下一次主会话创建；不污染进程默认（bot/
                // 侧栏仍按默认审批）。审批与计划互斥：清掉 pending 计划。
                *self
                    .shared
                    .pending_approval_mode
                    .lock()
                    .map_err(|_| "审批模式 pending 锁中毒".to_string())? = Some(parsed);
                if let Ok(mut pending) = self.shared.pending_plan_mode.lock() {
                    *pending = false;
                }
            }
        }
        Ok(())
    }

    pub fn set_approval_mode(&self, mode: &str) -> Result<(), String> {
        self.set_approval_mode_for(None, mode)
    }

    /// 删会话时清掉该会话的审批 pin（内存 + 持久化）。
    pub fn clear_approval_mode(&self, session_id: &str) -> Result<(), String> {
        rpi_cli::approval_gate::clear_session_mode(session_id);
        crate::approval_modes::clear_mode(session_id)
    }

    /// 指定会话（主柄或并列窗格）的 harness；不存在 = None（不假装在场）。
    fn session_harness(&self, session_id: &str) -> Result<Option<Arc<HarnessLive>>, String> {
        let id = session_id.trim();
        if id.is_empty() {
            return Ok(None);
        }
        if let Some(live) = self.live_opt()? {
            if self.session_id_of(&live)? == id {
                return Ok(Some(live));
            }
        }
        let handles: Vec<Arc<HarnessLive>> = self
            .shared
            .side
            .lock()
            .map_err(|_| "窗格会话表锁中毒".to_string())?
            .values()
            .cloned()
            .collect();
        for handle in handles {
            if self.session_id_of(&handle)? == id {
                return Ok(Some(handle));
            }
        }
        Ok(None)
    }

    /// 指定会话当前的活动工具名（诊断/测试面：计划模式应只剩
    /// read/bash/docs/plan_mode_complete；完全访问不改变工具目录）。
    pub fn active_tools_for(&self, session_id: Option<&str>) -> Result<Vec<String>, String> {
        let target = match session_id.map(str::trim).filter(|id| !id.is_empty()) {
            Some(id) => self
                .session_harness(id)?
                .ok_or_else(|| format!("会话 {id} 不在场，无法读取工具集"))?,
            None => self.live()?,
        };
        self.shared
            .rt
            .block_on(AgentLane::get_active_tools(target.harness.as_ref()))
            .map_err(|e| format!("读取活动工具失败: {e}"))
    }

    /// 执行已注册的扩展 slash command（与 rpi-cli RPC `execute_command` 同一
    /// 套 handler 契约）：宿主用它触发 `/plan start|exit` 等扩展命令。
    ///
    /// 没有加载扩展 / 命令未知 / handler 返回非 JSON = Err（不静默）。
    pub fn run_command(&self, command: &str, args: &str) -> Result<serde_json::Value, String> {
        self.run_command_for(None, command, args)
    }

    /// 会话版 slash command：`sessionId` 指定时在该会话自己的扩展实例上执行
    /// （计划模式插件每会话一份；窗格也能各自进出计划态），缺省 = 主柄。
    pub fn run_command_for(
        &self,
        session_id: Option<&str>,
        command: &str,
        args: &str,
    ) -> Result<serde_json::Value, String> {
        let target = match session_id.map(str::trim).filter(|id| !id.is_empty()) {
            Some(id) => self
                .session_harness(id)?
                .ok_or_else(|| format!("会话 {id} 不在场，无法执行 {command}"))?,
            None => self.live()?,
        };
        run_plugin_command(&target, command, args)
    }

    pub fn set_plan_mode(&self, enabled: bool) -> Result<(), String> {
        self.set_plan_mode_for(None, enabled)
    }

    pub fn set_plan_mode_for(
        &self,
        session_id: Option<&str>,
        enabled: bool,
    ) -> Result<(), String> {
        let requested = session_id
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .map(str::to_owned);
        let target = match requested {
            Some(id) => Some(id),
            None => self.current_session_id()?,
        };
        match target {
            Some(id) => {
                self.run_command_for(Some(&id), "/plan", if enabled { "start" } else { "exit" })?;
                // 计划态的审批 pin = Planning，不是 Yolo：除了插件把工具目录
                // 收窄到 read/bash/docs/plan_mode_complete（下一次 run 才换
                // 目录），approval_gate 还会对**当前 run** 的变更工具就地
                // 拦截——run 开始时工具目录已快照，光靠插件对进行中的轮次无效。
                // 退出计划回默认 always-ask；UI 的两个模式互斥，不保留进入前
                // 的 full access（用户重新开即可）。
                let plan_approval = if enabled {
                    rpi_cli::approval_gate::ApprovalMode::Planning
                } else {
                    rpi_cli::approval_gate::ApprovalMode::AlwaysAsk
                };
                // 只设内存 pin：计划态不跨进程重启（插件重启后 active=false），
                // 落盘会在重启后留下假的 planning。full access 才持久化。
                rpi_cli::approval_gate::set_session_mode(&id, plan_approval);
                Ok(())
            }
            None => {
                // New Chat：暂存计划选择，第一份主会话创建后消费。
                *self
                    .shared
                    .pending_plan_mode
                    .lock()
                    .map_err(|_| "计划模式 pending 锁中毒".to_string())? = enabled;
                if enabled {
                    *self
                        .shared
                        .pending_approval_mode
                        .lock()
                        .map_err(|_| "审批模式 pending 锁中毒".to_string())? = None;
                }
                Ok(())
            }
        }
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

    /// 后台任务列表：真源 = rpi-background-tasks 插件每次作业状态变化追加的
    /// `background-tasks` 会话条目（`data.jobs` 全表，只含本会话的行）。插件
    /// 未安装 = 没有条目 = 空列表（诚实空态，不是兜底）。
    pub fn job_list(&self) -> Result<serde_json::Value, String> {
        let Some(live) = self.live_opt()? else {
            return Ok(serde_json::Value::Array(Vec::new()));
        };
        let data =
            self.latest_plugin_entry(&live, crate::pi_plugin_state::BACKGROUND_TASKS_ENTRY)?;
        crate::pi_plugin_state::background_tasks_wire(data.as_ref())
    }

    /// 取消一个后台作业：宿主没有进程树句柄，但插件（rpi-background-tasks）注册了
    /// 斜杠命令 `/jobs kill <id>` —— 走引擎的 command 面转发即可，真正的
    /// Job Object 终止在插件进程内完成，状态由插件的下次快照如实回写。
    pub fn job_cancel(&self, job_id: &str) -> Result<serde_json::Value, String> {
        let trimmed = job_id.trim();
        if trimmed.is_empty() {
            return Err("job_cancel 需要 jobId".into());
        }
        self.run_command("/jobs", &format!("kill {trimmed}"))
    }

    /// 子代理名册（活动面板「智能体」分区）：真源 = 引擎 host 持有的
    /// `ChildAgents` registry（delegate_task 的 in-memory 子会话）。
    /// 每行 {childId,status,turns,startedMs,finishedMs,role,taskPreview,error}。
    /// 无活动会话 = 空名册（registry 属于会话的 host）。
    pub fn child_agent_roster(&self) -> Result<serde_json::Value, String> {
        let Some(live) = self.live_opt()? else {
            return Ok(serde_json::Value::Array(Vec::new()));
        };
        Ok(serde_json::Value::Array(self.child_host(&live)?.child_agent_roster()))
    }

    /// 停止一个运行中的子代理（活动面板「智能体」行的 Stop）：引擎 host
    /// 按 id 找到 ChildAgents 里的 job 并取消（真实终止，不静默成功）。
    pub fn child_agent_stop(&self, child_id: &str) -> Result<serde_json::Value, String> {
        let trimmed = child_id.trim();
        if trimmed.is_empty() {
            return Err("child_agent_stop 需要 childId".into());
        }
        let live = self.live()?;
        let host = self.child_host(&live)?;
        host.stop_child_agent(trimmed)
    }

    /// 当前会话 host 的 RuntimeActionHost 视图（扩展桥 clone_host）。
    /// 桥尚未建立（无扩展）= 明确 Err，不拿空名册冒充成功。
    fn child_host(
        &self,
        live: &HarnessLive,
    ) -> Result<Arc<dyn rpi_extensions::RuntimeActionHost>, String> {
        let bridge = live
            .reload
            .action_bridge
            .lock()
            .map_err(|_| "扩展桥锁中毒".to_string())?
            .clone()
            .ok_or_else(|| "当前会话没有扩展桥（无法查询子代理）".to_string())?;
        Ok(bridge.clone_host())
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
    ///
    /// **例外**：跨根索引的死会话（工作区已删/文件已清）会反复触发
    /// NotFound——跳过（不入结果集，侧栏 rowMeta 留空 = 真实状态），
    /// 不让一个死文件让整批 usage 查询都 Err（否则 console 每秒刷一条）。
    pub fn sessions_usage(&self, paths: &[String]) -> Result<serde_json::Value, String> {
        let mut out = serde_json::Map::new();
        for path in paths {
            let p = PathBuf::from(path);
            if !p.exists() {
                // 文件不存在 = 死会话（跨根索引残留）——跳过，不报错不污染
                continue;
            }
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

    /// `snapshot_stats` 的 stat 校验缓存版（活动会话文件 append-only）。
    ///
    /// IO 失败照常传播；只有「读到 stats」才落缓存。文件被替换/追加 →
    /// len/mtime 变 → 重扫。缓存只放最近一份（当前会话），不会随会话数增长。
    fn snapshot_stats_cached(&self, path: &str) -> Result<SessionStats, String> {
        let p = PathBuf::from(path);
        let (len, mtime_ms) = file_stamp(&p)?;
        {
            let cache = self
                .shared
                .stats_cache
                .lock()
                .map_err(|_| "会话统计缓存锁中毒".to_string())?;
            if let Some((cached_path, cached_len, cached_mtime, stats)) = cache.as_ref() {
                if *cached_path == p && *cached_len == len && *cached_mtime == mtime_ms {
                    return Ok(stats.clone());
                }
            }
        }
        let stats = self.snapshot_stats(path)?;
        *self
            .shared
            .stats_cache
            .lock()
            .map_err(|_| "会话统计缓存锁中毒".to_string())? =
            Some((p, len, mtime_ms, stats.clone()));
        Ok(stats)
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

    /// 派生面缓存键：活动会话文件的 stat 指纹 + 当前叶 id。
    ///
    /// **leaf 必须入键**：切分支（rewind / 回到兄弟叶）只改会话叶、不改文件
    /// stat——只按 stat 缓存会把旧分支的消息面发出去。文件未落盘（全新会话）
    /// 返回 None：此时结果只取决于内存 runtime，缓存无意义。
    fn derived_cache_key(
        &self,
        live: &HarnessLive,
    ) -> Result<Option<(PathBuf, u64, u64, Option<String>)>, String> {
        let Some(path) = live.session_path.clone() else {
            return Ok(None);
        };
        let (len, mtime_ms) = file_stamp(&path)?;
        let leaf = self
            .shared
            .rt
            .block_on(live.harness.session().get_leaf_id())
            .map_err(|e| format!("会话叶读取失败: {e}"))?;
        Ok(Some((path, len, mtime_ms, leaf)))
    }

    /// 会话时间线标记（旧 wire `[{kind:'modelChange'|'compact',
    /// beforeMessageIndex, provider?, modelId?}]`，索引与 pi_get_messages 的
    /// 消息下标对齐）。真源 = rpi 会话条目 `Entry::ModelChange` /
    /// `Entry::Compaction`（types.rs:249/274），沿当前分支扫描；计数口径与
    /// 水合同口径——只数 user/assistant（toolResult 并进 assistant 部件，
    /// 计进去索引会系统性偏大）。
    ///
    /// 结果按文件 stat + 当前叶缓存（见 `derived_cache_key`）。
    pub fn timeline_markers(&self) -> Result<serde_json::Value, String> {
        let live = self.live()?;
        let key = self.derived_cache_key(&live)?;
        if let Some((path, len, mtime_ms, leaf)) = key.as_ref() {
            let cache = self
                .shared
                .markers_cache
                .lock()
                .map_err(|_| "时间线缓存锁中毒".to_string())?;
            if let Some(c) = cache.as_ref() {
                if c.path == *path && c.len == *len && c.mtime_ms == *mtime_ms && c.leaf == *leaf
                {
                    return Ok((*c.value).clone());
                }
            }
        }
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
        let mut markers: Vec<(usize, serde_json::Value)> = Vec::new();
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
                Entry::ModelChange(change) => markers.push((
                    message_index,
                    serde_json::json!({
                        "kind": "modelChange",
                        "beforeMessageIndex": message_index,
                        "provider": change.provider,
                        "modelId": change.model_id,
                    }),
                )),
                Entry::Compaction(_) => markers.push((
                    message_index,
                    serde_json::json!({
                        "kind": "compact",
                        "beforeMessageIndex": message_index,
                    }),
                )),
                _ => {}
            }
        }
        // **尾部相对下标**（2026-11-19 分页水合配套）：前端只水合分支尾部一页，
        // 绝对 `beforeMessageIndex` 落不进已加载窗口。`beforeMessageIndexFromEnd`
        // = 该标记之后仍有多少条 user/assistant 消息——前端用
        // `localIndex = loadedCount - fromEnd` 定位（与窗口实际加载长度无关）。
        let total_messages = message_index;
        let markers: Vec<serde_json::Value> = markers
            .into_iter()
            .map(|(idx, mut value)| {
                value["beforeMessageIndexFromEnd"] = serde_json::json!(total_messages - idx);
                value
            })
            .collect();
        let value = Arc::new(serde_json::Value::Array(markers));
        if let Some((path, len, mtime_ms, leaf)) = key {
            *self
                .shared
                .markers_cache
                .lock()
                .map_err(|_| "时间线缓存锁中毒".to_string())? = Some(DerivedCache {
                path,
                len,
                mtime_ms,
                leaf,
                value: Arc::clone(&value),
            });
        }
        Ok((*value).clone())
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
        // 巨会话（11MB/2036 条）水合一次 ~1.4s；文件不变 + 叶不变即复用
        // 上次序列化结果（append-only；切分支只改 leaf，已入键）。
        let key = self.derived_cache_key(&live)?;
        if let Some((path, len, mtime_ms, leaf)) = key.as_ref() {
            let cache = self
                .shared
                .messages_cache
                .lock()
                .map_err(|_| "消息缓存锁中毒".to_string())?;
            if let Some(c) = cache.as_ref() {
                if c.path == *path && c.len == *len && c.mtime_ms == *mtime_ms && c.leaf == *leaf
                {
                    return Ok((*c.value).clone());
                }
            }
        }
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
        let value = Arc::new(serde_json::Value::Array(out));
        if let Some((path, len, mtime_ms, leaf)) = key {
            *self
                .shared
                .messages_cache
                .lock()
                .map_err(|_| "消息缓存锁中毒".to_string())? = Some(DerivedCache {
                path,
                len,
                mtime_ms,
                leaf,
                value: Arc::clone(&value),
            });
        }
        Ok((*value).clone())
    }

    /// 分页消息面（hermes transcript tail-hydration 的宿主对偶）：从当前分支
    /// **尾部**往回取一页原始消息条目（引擎 `SessionTree::transcript_page`，
    /// bounded read——不为整棵树做 payload 重放）。`before` = 上一页最老条目
    /// id（None = 最新一页）。wire = `{messages, entryIds, hasMore, leafId}`：
    /// - `messages` 与 `pi_get_messages` 同形（可直接喂 hydratePiMessages）；
    /// - `entryIds` 逐条对应，前端拿最后一页的 `entryIds[0]` 作为下一页
    ///   `before`，并可作为稳定行 id（跨页 prepend 不换 key）。
    ///
    /// **轮边界回退**：一页 256 条会在轮中间切断（页首是 assistant/toolResult，
    /// 水合后 toolResult 找不到宿主部件 = 丢工具卡）。因此页首不是 user 消息
    /// 时，向后回看最多 2 页，把上一页「最后一条 user 起」的后缀并进来，
    /// 保证每个返回页都从轮首开始；`hasMore` 相应扣减被并入的部分。
    pub fn messages_page(
        &self,
        before: Option<String>,
        limit: usize,
    ) -> Result<serde_json::Value, String> {
        let live = self.live()?;
        let page_size = limit.max(1);
        let fetch = |before_id: Option<String>| {
            let session = live.harness.session();
            self.shared
                .rt
                .block_on(session.transcript_page(&TranscriptPageQuery {
                    limit: page_size,
                    before_id,
                }))
                .map_err(|e| format!("会话消息分页读取失败: {e}"))
        };
        let Some(page) = fetch(before)? else {
            return Ok(serde_json::json!({
                "messages": [],
                "entryIds": [],
                "hasMore": false,
                "leafId": serde_json::Value::Null,
            }));
        };
        let leaf_id = page.leaf_id.clone();
        let mut has_more = page.has_more;
        let mut messages: Vec<serde_json::Value> = Vec::with_capacity(page.entries.len());
        let mut entry_ids: Vec<String> = Vec::with_capacity(page.entries.len());
        push_message_entries(page.entries, &mut messages, &mut entry_ids)?;
        let is_user = |m: &serde_json::Value| {
            m.get("role").and_then(|r| r.as_str()) == Some("user")
        };
        let mut boundary = entry_ids.first().cloned();
        let mut lookback = 0;
        while lookback < 2
            && has_more
            && messages.first().is_some_and(|m| !is_user(m))
        {
            let Some(cursor) = boundary.clone() else { break };
            let Some(older) = fetch(Some(cursor))? else { break };
            has_more = older.has_more;
            let mut older_messages = Vec::with_capacity(older.entries.len());
            let mut older_ids = Vec::with_capacity(older.entries.len());
            push_message_entries(older.entries, &mut older_messages, &mut older_ids)?;
            // 上一页最后一条 user 消息之后的部分属于同一轮：整段并入。
            let last_user = older_messages
                .iter()
                .rposition(|m| m.get("role").and_then(|r| r.as_str()) == Some("user"));
            match last_user {
                Some(idx) => {
                    has_more = has_more || idx > 0;
                    boundary = older_ids.first().cloned();
                    let mut head_messages = older_messages.split_off(idx);
                    let mut head_ids = older_ids.split_off(idx);
                    head_messages.append(&mut messages);
                    head_ids.append(&mut entry_ids);
                    messages = head_messages;
                    entry_ids = head_ids;
                    // 并进来的后缀已让页首落在轮首，停止回看。
                    break;
                }
                None => {
                    // 整页都没有 user（巨轮内部）：整页并入继续回看。
                    boundary = older_ids.first().cloned();
                    let mut head_messages = older_messages;
                    let mut head_ids = older_ids;
                    head_messages.append(&mut messages);
                    head_ids.append(&mut entry_ids);
                    messages = head_messages;
                    entry_ids = head_ids;
                }
            }
            lookback += 1;
        }
        Ok(serde_json::json!({
            "messages": messages,
            "entryIds": entry_ids,
            "hasMore": has_more,
            "leafId": leaf_id,
        }))
    }

    pub fn create_bot_session(
        &self,
        provider: Option<String>,
        model: Option<String>,
        system_prompt: Option<String>,
        cwd: Option<String>,
        enabled_tools: Option<Vec<String>>,
        // bot 所属环境（她的 profile home：会话落点 + 技能/扩展/settings 解析面）。
        // None = 当前活动环境（普通新聊天）；**不切**引擎活动环境。
        profile: Option<String>,
        _ui_bridge: Option<UiBridgeHandle>,
    ) -> Result<String, String> {
        // hermes/旧 pi 的 bot 会话 = **带 system_prompt 与（可选）模型覆盖的
        // 新会话**（不是普通会话加壳）：机器人自己的 SOUL 提示就是它的身份。
        // rpi 侧等价面：resolve 带 provider/model 覆盖 → build → set_system_prompt
        // → set_active_tools → 作为活动会话。cwd 缺省 = 默认工作区。
        let cwd = cwd
            .map(PathBuf::from)
            .unwrap_or_else(|| self.shared.cwd.clone());
        let live = self.build_harness_for_profile(
            &cwd,
            None,
            provider.as_deref(),
            model.as_deref(),
            profile.as_deref(),
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

    // ── 并列窗格（hermes `_sessions` 多会话对偶）─────────────────────────────
    //
    // 每个窗格一棵**独立会话句柄**（自己的 harness / lane / writer lease /
    // 事件流），prompt 只锁自己的句柄——两个窗格可以在同一进程里并行收发。
    // 单写者约束：同一会话文件同一时刻只允许一个句柄，由 `live` / `side` /
    // `retired` 三张表的归属检查兜住（重建一个已在场的会话必撞
    // "writer lease is already held"）。

    /// 取/建并列窗格的会话句柄。同一窗格键 + 同一路径 = 幂等复用；
    /// 换会话（同窗格键、不同路径）→ 旧句柄退役（保租约）后新建。
    /// 目标路径已在**主窗格**或**其它窗格**在场 → Err（不可双写）。
    pub fn side_open(&self, thread: &str, path: &str, _ui_bridge: UiBridgeHandle) -> Result<(), String> {
        let thread = thread.trim();
        if thread.is_empty() {
            return Err("窗格键为空".into());
        }
        if thread == "main" || thread.starts_with("main:") {
            // `main:` 前缀是主窗会话专属键（agui.rs 归主柄路径）——误到此
            // 说明上游路由把主窗 POST 当成了分栏，直接拒绝防双写。
            return Err("窗格键不能是 main（前台走主柄）".into());
        }
        let target = session_cache_key(Path::new(path));
        if let Some(live) = self.live_opt()? {
            if live.session_path.as_ref().map(|p| session_cache_key(p)).as_ref() == Some(&target) {
                return Err("该会话已在主窗格打开（同一会话不能双开）".into());
            }
        }
        {
            let side = self
                .shared
                .side
                .lock()
                .map_err(|_| "窗格会话表锁中毒".to_string())?;
            if let Some(existing) = side.get(thread) {
                if existing.session_path.as_ref().map(|p| session_cache_key(p)).as_ref() == Some(&target) {
                    return Ok(());
                }
            }
            let occupied_by_other = side.iter().any(|(key, session)| {
                key != thread
                    && session.session_path.as_ref().map(|p| session_cache_key(p)).as_ref() == Some(&target)
            });
            if occupied_by_other {
                return Err("该会话已在另一个窗格打开（同一会话不能双开）".into());
            }
        }
        // 之前退役的同一会话：直接复活（lease 仍归我们，重建必撞 already held）。
        let cached = self
            .shared
            .retired
            .lock()
            .map_err(|_| "retired 会话表锁中毒".to_string())?
            .take(&target);
        let handle = match cached {
            Some(handle) => handle,
            None => {
                preflight_session_file(path)?;
                let cwd = workspace_from_session_path(Path::new(path))
                    .unwrap_or_else(|| self.shared.cwd.clone());
                let handle = Arc::new(self.build_harness(&cwd, Some(path))?);
                // 目标校验（AgentEnd → 校验器）对新建的窗格会话生效；
                // 复用句柄的订阅在它初次构建时已经挂过，不重复挂。
                self.watch_runs(Arc::clone(&handle));
                handle
            }
        };
        let previous = self
            .shared
            .side
            .lock()
            .map_err(|_| "窗格会话表锁中毒".to_string())?
            .insert(thread.to_owned(), handle);
        if let Some(previous) = previous {
            previous.reload.ui_dialog.cancel_all();
            if let Some(path) = previous.session_path.clone() {
                self.shared
                    .retired
                    .lock()
                    .map_err(|_| "retired 会话表锁中毒".to_string())?
                    .insert(session_cache_key(&path), previous);
            }
        }
        Ok(())
    }

    /// 在指定窗格的句柄上跑一轮（窗格未打开 = 可见 Err，不静默落到主柄）。
    pub fn side_prompt(
        &self,
        thread: &str,
        text: &str,
        images: &[AguiImage],
        on_event: impl Fn(AgentEvent) + Send + Sync + 'static,
        on_start: Box<dyn FnOnce() + Send>,
    ) -> Result<(), String> {
        let handle = {
            self.shared
                .side
                .lock()
                .map_err(|_| "窗格会话表锁中毒".to_string())?
                .get(thread)
                .map(Arc::clone)
        }
        .ok_or_else(|| format!("窗格 {thread} 尚未打开会话"))?;
        let converted: Vec<ImageContent> = images
            .iter()
            .map(|img| ImageContent {
                kind: Default::default(),
                data: std::sync::Arc::from(img.data.as_str()),
                mime_type: img.mime_type.clone(),
            })
            .collect();
        self.run_prompt_on(handle, text.to_owned(), converted, on_event, on_start)
    }

    /// 中断指定窗格的 run（不动主柄与其它窗格）。
    pub fn side_interrupt(&self, thread: &str) -> Result<(), String> {
        let handle = {
            self.shared
                .side
                .lock()
                .map_err(|_| "窗格会话表锁中毒".to_string())?
                .get(thread)
                .map(Arc::clone)
        }
        .ok_or_else(|| format!("窗格 {thread} 尚未打开会话"))?;
        self.shared.rt.block_on(async {
            AgentLane::abort(handle.harness.as_ref())
                .await
                .map(|_| ())
                .map_err(|e| e.to_string())
        })
    }

    /// 该窗格是否仍在跑（`pi_lane_busy` 的窗格面）。
    pub fn side_lane_busy(&self, thread: &str) -> Result<bool, String> {
        let handle = {
            self.shared
                .side
                .lock()
                .map_err(|_| "窗格会话表锁中毒".to_string())?
                .get(thread)
                .map(Arc::clone)
        };
        let Some(handle) = handle else {
            return Ok(false);
        };
        self.shared.rt.block_on(async {
            let snapshot = handle
                .harness
                .snapshot()
                .await
                .map_err(|e| e.to_string())?;
            Ok(snapshot.active.is_some())
        })
    }

    /// 关闭一个窗格会话：先中止在途 run，再退役句柄（保 writer lease，
    /// 再次打开同一路径时复活而不是重建）。
    pub fn side_close(&self, thread: &str) -> Result<(), String> {
        let Some(handle) = self
            .shared
            .side
            .lock()
            .map_err(|_| "窗格会话表锁中毒".to_string())?
            .remove(thread)
        else {
            return Ok(());
        };
        handle.reload.ui_dialog.cancel_all();
        // abort 失败不阻断关闭（句柄必须离开表），但留下可见记录。
        if let Err(e) = self.shared.rt.block_on(async {
            AgentLane::abort(handle.harness.as_ref()).await
        }) {
            eprintln!("[side] abort 窗格 {thread} 失败: {e}");
        }
        if let Some(path) = handle.session_path.clone() {
            self.shared
                .retired
                .lock()
                .map_err(|_| "retired 会话表锁中毒".to_string())?
                .insert(session_cache_key(&path), handle);
        }
        Ok(())
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
pub(crate) fn json_str(value: &serde_json::Value, keys: &[&str]) -> Option<String> {
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
pub(crate) fn ask_row(ui: &serde_json::Value, request_id: &str) -> Option<serde_json::Value> {
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
pub(crate) fn approval_row(ui: &serde_json::Value, request_id: &str) -> Option<serde_json::Value> {
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
pub(crate) fn ask_answer_value(
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
pub(crate) fn approval_answer_value(
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

#[cfg(test)]
mod peek_session_tail_tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn peek_tail_reads_chronological_chain_and_trims_to_user_turn() {
        let dir = std::env::temp_dir().join(format!("mirach-peek-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("s1.jsonl");
        let mut f = std::fs::File::create(&path).unwrap();
        writeln!(f, r#"{{"kind":"header","version":4,"id":"sess-1","createdAt":1}}"#).unwrap();
        let mut parent: Option<String> = None;
        let mut seq = 0i32;
        for i in 0..60 {
            let role = if i % 2 == 0 { "user" } else { "assistant" };
            let id = format!("e{i}");
            let parent_json = match &parent {
                Some(p) => format!(r#""{p}""#),
                None => "null".to_string(),
            };
            writeln!(
                f,
                r#"{{"kind":"entry","id":"{id}","parentId":{parent_json},"seq":{seq},"type":"message","message":{{"role":"{role}","content":"m{i}"}}}}"#
            )
            .unwrap();
            parent = Some(id);
            seq += 1;
            if i == 10 {
                writeln!(
                    f,
                    r#"{{"kind":"entry","lane":"main","seq":{seq},"type":"record","id":"rec"}}"#
                )
                .unwrap();
                seq += 1;
            }
        }
        drop(f);
        let page = peek_session_tail(path.to_str().unwrap(), 5).unwrap();
        assert_eq!(page["sessionId"], serde_json::json!("sess-1"));
        let msgs = page["messages"].as_array().unwrap();
        assert!(!msgs.is_empty());
        assert_eq!(msgs.first().unwrap()["role"], serde_json::json!("user"));
        assert_eq!(msgs.last().unwrap()["role"], serde_json::json!("assistant"));
        assert_eq!(msgs.last().unwrap()["content"], serde_json::json!("m59"));
        let ids = page["entryIds"].as_array().unwrap();
        assert_eq!(ids.len(), msgs.len());
        assert_eq!(page["hasMore"], serde_json::json!(true));
        std::fs::remove_dir_all(&dir).ok();
    }
}

#[test]
#[ignore = "diagnostics: run with --ignored --nocapture"]
fn timing_storage_only_giant() {
    let path = r"C:\\Users\\Administrator\\.rpi\\sessions\\--C--Users-Administrator--\\2026-11-15T12-13-00-771Z_01a1df20-07dd-743f-925e-1c6a98ea0c49.jsonl";
    if !std::path::Path::new(path).exists() { eprintln!("fixture missing; skip"); return; }
    let rt = tokio::runtime::Runtime::new().unwrap();
    let t = std::time::Instant::now();
    rt.block_on(async {
        let fs: Arc<dyn rpi_tools::FileSystem> = Arc::new(rpi_tools::os_env::OsExecutionEnv::with_cwd(std::env::temp_dir()));
        let snapshot = JsonlSessionStorage::read_snapshot(
            fs, path, Arc::new(SystemClock), Arc::new(DefaultIdGenerator::new()),
        ).await;
        eprintln!("storage-only result ok={} elapsed={:?}", snapshot.is_ok(), t.elapsed());
    });
}

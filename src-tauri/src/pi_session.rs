//! PiEngine —— **rpi-main 引擎**（2026-11-14 竖链移植，用户定稿"核心换成
//! G:\pi-rust-main，不用 pi agent rust 了"）。旧实现存档于 git df701a4。
//!
//! ## 移植边界（竖链优先，用户选定策略 1）
//!
//! - **对话面走 rpi**（真实现）：ensure/open/discard（会话生命周期）、
//!   prompt/prompt_with_content（流式）、interrupt（abort）、state、
//!   list_sessions（rpi 会话目录扫描）、rename/delete（set_name/删文件）、
//!   new_session_with_cwd（指定工作区新建）。
//! - **旧 pi 独有面如实降级**（Err("rpi 引擎待接：…")——标红纪律，不静默
//!   不造假）：hub 花名册五面 / todo 重放 / usage 聚合 / 分支线系 / 检查点 /
//!   rewind / undo / retry_edit / compact / export / timeline / job 面 /
//!   bot 会话 / 模型切换 / plan-审批模式。rpi-main v0.24.0 尚无对应能力，
//!   追平后逐项接回。
//! - **AG-UI 协议面不变**：agui.rs 只换 map_agent_event 的变体来源 +
//!   图片转换，前端零改动。
//! - **分栏（side_*）暂不支持**：rpi v1 非 main lane 拒绝 run 操作
//!   （InvalidLane）——如实 Err，前端分栏可见错误。
//! - **审批（变更前确认）下一轮**：rpi 侧经 before_tool_call 钩子接回
//!   ApprovalRegistry；本轮工具直接执行（审批卡不出现——已记降级）。
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

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use rpi_agent::AgentEvent;
use rpi_harness::agent_harness::{AgentHarness, AgentLane};
use rpi_ai::types::ImageContent;

use crate::agui::{AguiImage, AskRegistry, ApprovalRegistry, ThreadBuffers};

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
// rpi 阶段 1 引擎不消费它（审批桥下一轮经 before_tool_call 接回），参数
// 保留以保调用点签名。

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

    pub fn block_on<F: std::future::Future>(&self, fut: F) -> F::Output {
        self.rt.block_on(fut)
    }
}

// ── 引擎 ────────────────────────────────────────────────────────────────────

struct EngineShared {
    rt: PiRuntime,
    cwd: PathBuf,
    /// 会话在场态（None = 未创建/已 discard）
    live: Mutex<Option<Arc<HarnessLive>>>,
    model_line: Mutex<String>,
}

struct HarnessLive {
    harness: Arc<AgentHarness>,
    events: tokio::sync::broadcast::Receiver<AgentEvent>,
    session_path: Option<PathBuf>,
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

impl PiEngine {
    pub fn new() -> Self {
        let approvals = Arc::new(ApprovalRegistry::new());
        let asks = Arc::new(AskRegistry::new());
        Self {
            shared: Arc::new(EngineShared {
                rt: PiRuntime::new(),
                cwd: default_workspace(),
                live: Mutex::new(None),
                model_line: Mutex::new("引擎待启动".into()),
            }),
            approvals,
            asks,
        }
    }

    pub fn approvals(&self) -> Arc<ApprovalRegistry> {
        Arc::clone(&self.approvals)
    }

    pub fn asks(&self) -> Arc<AskRegistry> {
        Arc::clone(&self.asks)
    }

    /// Harness 装配（resolve → build）。`session_path` = Some 时走恢复路径
    /// （args.session + allow_existing 由 CLI build 自动接管）。
    fn build_harness(
        &self,
        cwd: &Path,
        session_path: Option<&str>,
    ) -> Result<HarnessLive, String> {
        self.shared.rt.block_on(async {
            let resolved = rpi_cli::provider::resolve(None, None, None, None, None)
                .map_err(|e| format!("模型解析失败: {e}"))?;
            let mut args = rpi_cli::args::Args::default();
            if let Some(p) = session_path {
                args.session = Some(p.to_string());
            }
            let (harness, events, _reload) = rpi_cli::session::build(&resolved, &args, cwd, false)
                .await
                .map_err(|e| format!("Harness 构建失败: {e}"))?;
            let provider = resolved.model.provider.clone();
            let model_id = resolved.model.id.clone();
            Ok(HarnessLive {
                harness: Arc::new(harness),
                events,
                session_path: session_path.map(PathBuf::from),
                provider,
                model_id,
            })
        })
    }

    fn live(&self) -> Result<Arc<HarnessLive>, String> {
        self.shared
            .live
            .lock()
            .map_err(|_| "引擎状态锁中毒".to_string())?
            .as_ref()
            .map(Arc::clone)
            .ok_or_else(|| "无活动会话".to_string())
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
        *self.shared.live.lock().map_err(|_| "锁中毒".to_string())? = Some(Arc::new(live));
        Ok(())
    }

    /// 打开指定会话文件（rpi 恢复路径：args.session + allow_existing）。
    /// 返回会话 id（前端锚定用）。
    pub fn open_session(
        &self,
        path: &str,
        _ui_bridge: Option<UiBridgeHandle>,
    ) -> Result<String, String> {
        let live = self.build_harness(&self.shared.cwd, Some(path))?;
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
        *self.shared.live.lock().map_err(|_| "锁中毒".to_string())? = Some(Arc::new(live));
        Ok(id)
    }

    /// New Chat 语义（§7-3 保持）：丢柄（会话文件已持久化在 rpi 侧）。
    pub fn discard_session(&self) -> Result<(), String> {
        *self.shared.live.lock().map_err(|_| "锁中毒".to_string())? = None;
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
        *self.shared.live.lock().map_err(|_| "锁中毒".to_string())? = Some(Arc::new(live));
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
            // 排水任务：broadcast 事件并发转发到 on_event（prompt_text await
            // 到整轮结束；结束后 sender 关闭、任务自然退出）
            let drain = tokio::spawn(async move {
                while let Ok(ev) = rx.recv().await {
                    on_event(ev);
                }
            });
            let result = AgentLane::prompt_text(harness.as_ref(), text, images).await;
            // 尾部事件泵完再返回（TURN_END/AGENT_END 已在流里）
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

    // ── 会话管理面 ──────────────────────────────────────────────────────────

    /// 会话列表（rpi 会话目录扫描：<workspace>/.rpi/sessions/**/*.jsonl）。
    /// wire 形状与旧 pi_list_sessions 一致（path/id/cwd/timestamp/
    /// messageCount/lastModifiedMs/sizeBytes/name）；messageCount 待重放面
    /// （诚实 null）。旧 pi 存储的历史不再列出（迁移语义如实；文件不删）。
    pub fn list_sessions(&self) -> Result<serde_json::Value, String> {
        let base = default_workspace().join(".rpi").join("sessions");
        let mut rows: Vec<serde_json::Value> = Vec::new();
        let dirs = std::fs::read_dir(&base).map_err(|e| e.to_string())?;
        for d in dirs.flatten() {
            if !d.path().is_dir() {
                continue;
            }
            let files = std::fs::read_dir(d.path()).map_err(|e| e.to_string())?;
            for f in files.flatten() {
                let path = f.path();
                if path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
                    continue;
                }
                let meta = f.metadata().map_err(|e| e.to_string())?;
                // 首行 = 会话头（id/cwd/timestamp/name）
                let first = std::fs::read_to_string(&path)
                    .ok()
                    .and_then(|t| t.lines().next().map(String::from))
                    .and_then(|l| serde_json::from_str::<serde_json::Value>(&l).ok());
                let (id, cwd, timestamp, name) = match &first {
                    Some(h) => (
                        h.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                        h.get("cwd").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                        h.get("timestamp").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                        h.get("name").and_then(|v| v.as_str()).map(String::from),
                    ),
                    None => (String::new(), String::new(), String::new(), None),
                };
                rows.push(serde_json::json!({
                    "path": path.to_string_lossy(),
                    "id": id,
                    "cwd": cwd,
                    "timestamp": timestamp,
                    "messageCount": serde_json::Value::Null,
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
        }
        rows.sort_by(|a, b| {
            let av = a["lastModifiedMs"].as_u64().unwrap_or(0);
            let bv = b["lastModifiedMs"].as_u64().unwrap_or(0);
            bv.cmp(&av)
        });
        Ok(serde_json::Value::Array(rows))
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

    /// 会话状态快照（形状与旧 pi_get_state 对齐；messageCount 待重放面）。
    pub fn state(&self) -> Result<serde_json::Value, String> {
        let live = self.live()?;
        let _model_line = self
            .shared
            .model_line
            .lock()
            .map_err(|_| "锁中毒".to_string())?
            .clone();
        Ok(serde_json::json!({
            "sessionId": live.session_path.as_ref().map(|p| p.to_string_lossy()).unwrap_or_default(),
            "provider": live.provider,
            "modelId": live.model_id,
            "thinkingLevel": serde_json::Value::Null,
            "messageCount": serde_json::Value::Null,
            "hasExtensions": false,
        }))
    }

    // ── 旧 pi 独有面：如实降级（规矩 12——不静默不造假）────────────────────

    fn unavailable(name: &str) -> String {
        format!("rpi 引擎待接：{name}（rpi-main v0.24.0 尚无对应能力）")
    }

    pub fn mode_state(&self) -> Result<serde_json::Value, String> {
        Err(Self::unavailable("plan/审批模式"))
    }

    pub fn set_approval_mode(&self, _mode: &str) -> Result<(), String> {
        Err(Self::unavailable("审批模式切换"))
    }

    pub fn set_plan_mode(&self, _enabled: bool) -> Result<(), String> {
        Err(Self::unavailable("plan 模式"))
    }

    pub fn decide_plan(&self, _approve: bool) -> Result<(), String> {
        Err(Self::unavailable("plan 审批决定"))
    }

    pub fn set_model(&self, _provider: &str, _model_id: &str) -> Result<(), String> {
        Err(Self::unavailable("模型切换（重建 harness）"))
    }

    pub fn set_thinking_level(&self, _level: &str) -> Result<(), String> {
        Err(Self::unavailable("思考档位"))
    }

    pub fn list_models(&self) -> Result<serde_json::Value, String> {
        Err(Self::unavailable("模型目录"))
    }

    pub fn todo_state(&self) -> Result<serde_json::Value, String> {
        Err(Self::unavailable("todo 重放"))
    }

    pub fn hub_roster(&self) -> Result<serde_json::Value, String> {
        Err(Self::unavailable("hub 花名册"))
    }

    pub fn hub_kill(&self, _agent_id: &str) -> Result<serde_json::Value, String> {
        Err(Self::unavailable("hub 终止子代理"))
    }

    pub fn hub_send(&self, _agent_id: &str, _body: &str) -> Result<serde_json::Value, String> {
        Err(Self::unavailable("hub 发送"))
    }

    pub fn hub_inbox(&self, _agent_id: &str) -> Result<serde_json::Value, String> {
        Err(Self::unavailable("hub 收件箱"))
    }

    pub fn hub_transcript(&self, _agent_id: &str) -> Result<serde_json::Value, String> {
        Err(Self::unavailable("hub 转写"))
    }

    pub fn job_list(&self) -> Result<serde_json::Value, String> {
        Err(Self::unavailable("后台任务列表"))
    }

    pub fn job_cancel(&self, _job_id: &str) -> Result<serde_json::Value, String> {
        Err(Self::unavailable("后台任务取消"))
    }

    pub fn compact(&self) -> Result<serde_json::Value, String> {
        Err(Self::unavailable("手动压缩"))
    }

    pub fn undo_redo(&self, _kind: &str, _n: usize, _force: bool) -> Result<serde_json::Value, String> {
        Err(Self::unavailable("undo/redo"))
    }

    pub fn undo_history(&self) -> Result<serde_json::Value, String> {
        Err(Self::unavailable("undo 历史"))
    }

    pub fn rewind(&self, _checkpoint_id: &str) -> Result<serde_json::Value, String> {
        Err(Self::unavailable("rewind"))
    }

    pub fn mark_checkpoint(&self, _label: Option<String>) -> Result<serde_json::Value, String> {
        Err(Self::unavailable("检查点标记"))
    }

    pub fn list_checkpoints(&self) -> Result<serde_json::Value, String> {
        Err(Self::unavailable("检查点列表"))
    }

    pub fn retry_edit(&self) -> Result<serde_json::Value, String> {
        Err(Self::unavailable("retry 编辑"))
    }

    pub fn fork_session(
        &self,
        _entry_id: &str,
        _ui_bridge: Option<UiBridgeHandle>,
    ) -> Result<serde_json::Value, String> {
        Err(Self::unavailable("fork"))
    }

    pub fn get_fork_points(&self) -> Result<serde_json::Value, String> {
        Err(Self::unavailable("fork 点"))
    }

    pub fn list_sibling_branches(&self) -> Result<serde_json::Value, String> {
        Err(Self::unavailable("兄弟分支"))
    }

    pub fn switch_branch(&self, _leaf_id: &str) -> Result<serde_json::Value, String> {
        Err(Self::unavailable("分支切换"))
    }

    pub fn session_lineage(&self) -> Result<Option<String>, String> {
        // 线系条 = rpi 无分支概念 → Ok(None)（前端不渲染线系条，非错误）
        Ok(None)
    }

    pub fn sessions_usage(&self, _paths: &[String]) -> Result<serde_json::Value, String> {
        Err(Self::unavailable("会话用量聚合"))
    }

    pub fn export_session_html(&self, _path: &str) -> Result<String, String> {
        Err(Self::unavailable("会话 HTML 导出"))
    }

    pub fn timeline_markers(&self) -> Result<serde_json::Value, String> {
        Err(Self::unavailable("时间线标记"))
    }

    pub fn messages(&self) -> Result<serde_json::Value, String> {
        Err(Self::unavailable("消息重放（水合）"))
    }

    pub fn create_bot_session(
        &self,
        _provider: Option<String>,
        _model: Option<String>,
        _system_prompt: Option<String>,
        _cwd: Option<String>,
        _enabled_tools: Option<Vec<String>>,
        _ui_bridge: Option<UiBridgeHandle>,
    ) -> Result<String, String> {
        Err(Self::unavailable("bot 会话"))
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

    // ── flush（旧调用点兼容——rpi 每轮落盘，无需 flush）────────────────────

    /// 旧链路的 flush 调用点（usage/list 前 flush）——rpi 每轮已持久化，
    /// 无操作保留签名。
    fn flush_active_session(&self) -> Result<(), String> {
        Ok(())
    }
}

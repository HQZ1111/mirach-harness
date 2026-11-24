//! 后台 bot 会话泳道（2026-11-17，bots 群聊成员轮次接线）。
//!
//! ## 为什么需要它
//!
//! hermes-bots 的群聊（Desktop 驱动模式）把每个成员的一轮对话发给该成员
//! **自己的隐藏会话**：`prompt.submit {session_id, text}` 提交、`session.resume`
//! 轮询快照。宿主（mirach）的 `PiEngine` 只有一个活动会话（前台聊天），
//! 把成员会话装成活动会话会抢走用户正在看的会话——AG-UI 的 `main` 线程
//! 缓冲也会混入成员事件。所以成员轮次必须跑在**独立的 harness 泳道**：
//!
//! - 每个成员会话一个 `BotSession`（`rpi_cli::session::build` 装配，writer
//!   lease 由本模块持有——同一会话不会与前台引擎争写）；
//! - 轮次提交 = admission 语义（立即返回，后台线程跑 `AgentLane::prompt_text`）；
//! - 完成/失败经 Tauri 事件通知（`mirach:plugin:message:complete` /
//!   `mirach:plugin:error`，插件 `group-turns.ts` 用它加速轮询）；
//! - ask / 审批对话框经会话级 `UiDialogMailbox` 取出（与前台同机制），
//!   `session.resume` 快照投影为 `open_requests` / `pending_approval`，
//!   `clarify.lock` / `approval.respond` 回灌。
//!
//! ## 与 cron 的区别
//!
//! cron（`pi_cron.rs`）每次跑**新会话**、无人值守、不接 UI 对话框；本模块
//! 复用**已存在的会话**（群成员会话跨轮次、跨重启存活），必须接 ask/审批
//! （群聊有 clarify/approval 卡片），并按会话 id 维护 running/inflight 快照。
//!
//! ## 有意不做
//!
//! - `display.*`（宿主无 Bot Desktop）——事件无生产者，见 `docs/bots-port-gaps.md`。
//! - 多网关/多连接（宿主单身份）——`requestProfile` 与 bot relay 天然休眠。

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use rpi_ai::types::{Content, ImageContent};
use rpi_harness::agent_harness::{AgentHarness, AgentLane};

use crate::pi_session::{
    self, ask_answer_value, ask_row, approval_answer_value, approval_row, AskAnswerWire, PiRuntime,
};

// ── 会话状态 ────────────────────────────────────────────────────────────────

/// 一次轮次的状态（`session.resume` 的 running / inflight / turn_started_at
/// 数据面）。`last_error` 是**保留的失败**（上游 `_fail_inflight_turn` 语义）：
/// 直到下一次提交成功前都保留，供重连面板重建错误气泡；不是活工作。
#[derive(Default)]
struct BotRunState {
    running: bool,
    started_at: Option<f64>,
    last_error: Option<String>,
    last_finished_at: Option<f64>,
    /// 最近一轮的终局分类（completed / failed / cancelled）——peer lender 面
    /// 的 `/v1/runs` 轮询需要可持久化的终局状态。
    last_status: Option<String>,
    /// 最近一轮的最终 assistant 文本（peer `/v1/runs` 的 `output`）。
    last_output: Option<String>,
    /// 终局计数器（每次轮次收尾 +1，与 running=false / last_status 同临界区写入）。
    /// peer run monitor 用「seq 变了」判定**本次**轮次已收尾——冷启动窗口里
    /// running 仍是 false，不能拿来当终局信号（2026-11-19 E2E 实测假 interrupted）。
    last_turn_seq: u64,
    /// 引擎任务租约（rpi-harness task_lease）：轮次身份 + fencing token。
    current_task: Option<CurrentTask>,
    /// 任务身份代际（每次提交 +1；fencing/重试都用它）。
    next_generation: u64,
    /// 启动时 recover 出的 indeterminate 任务（等前端读取后清）。
    recovered: Vec<Value>,
}

#[derive(Clone)]
struct CurrentTask {
    task_id: String,
    generation: u64,
    lease_id: String,
}

struct BotSession {
    id: String,
    path: PathBuf,
    #[allow(dead_code)]
    sessions_root: PathBuf,
    #[allow(dead_code)]
    provider: String,
    #[allow(dead_code)]
    model_id: String,
    profile: String,
    harness: Arc<AgentHarness>,
    events: Mutex<tokio::sync::broadcast::Receiver<rpi_agent::AgentEvent>>,
    reload: rpi_cli::session::ReloadContext,
    state: Mutex<BotRunState>,
    /// `image.attach_bytes` 暂存的图片（下一次 prompt 随文本提交）。
    pending_images: Mutex<Vec<ImageContent>>,
    /// ask 请求投影（`ask_row` 形状，request_id → row）。
    asks: Mutex<BTreeMap<String, Value>>,
    /// 审批对话框（request_id → (插件原始 ui, approval_row 投影)）。
    approvals: Mutex<BTreeMap<String, (Value, Value)>>,
    /// clarify 逐题应答暂存（request_id → question_id → answer）。
    clarify_answers: Mutex<HashMap<String, BTreeMap<String, Option<String>>>>,
}

pub struct BotLane {
    rt: PiRuntime,
    sessions: Mutex<HashMap<String, Arc<BotSession>>>,
}

static LANE: OnceLock<BotLane> = OnceLock::new();

fn lane() -> &'static BotLane {
    LANE.get_or_init(|| BotLane {
        rt: PiRuntime::new(),
        sessions: Mutex::new(HashMap::new()),
    })
}

fn now_secs() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0.0, |d| d.as_secs_f64())
}

// ── 会话装配 / 查询 ─────────────────────────────────────────────────────────

#[derive(Default)]
struct BotConfig {
    system_prompt: Option<String>,
    provider: Option<String>,
    model_id: Option<String>,
    enabled_tools: Option<Vec<String>>,
    profile: Option<String>,
    extension_filter: Option<Vec<String>>,
}

fn apply_config(session: &BotSession, config: &BotConfig) -> Result<(), String> {
    let rt = &lane().rt;
    if let Some(prompt) = &config.system_prompt {
        rt.block_on(session.harness.set_system_prompt(Some(prompt.clone())))
            .map_err(|e| format!("bot 会话系统提示设置失败: {e}"))?;
    }
    if let Some(tools) = &config.enabled_tools {
        rt.block_on(AgentLane::set_active_tools(
            session.harness.as_ref(),
            tools.clone(),
        ))
        .map_err(|e| format!("bot 会话工具集设置失败: {e}"))?;
    }
    Ok(())
}

fn make_session(built: pi_session::BuiltHarness, config: &BotConfig) -> Arc<BotSession> {
    Arc::new(BotSession {
        id: built.id.clone(),
        path: built.path.clone(),
        sessions_root: built.sessions_root,
        provider: built.provider,
        model_id: built.model_id,
        profile: config.profile.clone().unwrap_or_default(),
        harness: built.harness,
        events: Mutex::new(built.events),
        reload: built.reload,
        state: Mutex::new(BotRunState::default()),
        pending_images: Mutex::new(Vec::new()),
        asks: Mutex::new(BTreeMap::new()),
        approvals: Mutex::new(BTreeMap::new()),
        clarify_answers: Mutex::new(HashMap::new()),
    })
}

fn insert_session(session: Arc<BotSession>) -> Arc<BotSession> {
    lane()
        .sessions
        .lock()
        .expect("bot sessions poisoned")
        .insert(session.id.clone(), Arc::clone(&session));
    session
}

/// 启动时把过期运行中的任务标成 indeterminate（引擎 task_lease），存入
/// state.recovered 等前端读取。错误可见（stderr）但不阻断会话打开。
fn recover_tasks(session: &BotSession) {
    match rpi_harness::task_lease::recover(&session.path) {
        Ok(records) if !records.is_empty() => {
            let rows: Vec<Value> = records
                .iter()
                .filter_map(|record| serde_json::to_value(record).ok())
                .collect();
            if let Ok(mut state) = session.state.lock() {
                state.recovered.extend(rows);
            }
        }
        Ok(_) => {}
        Err(error) => eprintln!("[bot] task_lease recover 失败 {}: {error}", session.path.display()),
    }
}

fn find_session(session_id: &str) -> Option<Arc<BotSession>> {
    lane()
        .sessions
        .lock()
        .expect("bot sessions poisoned")
        .get(session_id)
        .map(Arc::clone)
}

/// 该会话是否已装进 bot 泳道（peer `/v1/runs` 的 session_id 复用判定）。
pub(crate) fn pi_bot_has_session(session_id: &str) -> bool {
    find_session(session_id).is_some()
}

/// peer clarify 回执：一题一次性回灌（题目 id 缺省取第一个问题）。
pub(crate) fn pi_bot_answer_clarify(
    session_id: &str,
    request_id: &str,
    answer: &str,
) -> Result<usize, String> {
    let Some(session) = find_session(session_id) else {
        return Err(format!("bot 会话 {session_id} 不在泳道注册表"));
    };
    let (resolved_id, question_id) = {
        let asks = session.asks.lock().expect("bot asks poisoned");
        let id = if request_id.trim().is_empty() {
            asks.keys().next().cloned()
        } else {
            Some(request_id.trim().to_owned())
        };
        let id = id.ok_or_else(|| "没有挂起的 clarify 请求".to_string())?;
        let row = asks
            .get(&id)
            .cloned()
            .ok_or_else(|| format!("没有挂起的 clarify 请求 {id}"))?;
        let question_id = row["request"]["questions"][0]["id"]
            .as_str()
            .unwrap_or("q0")
            .to_owned();
        (id, question_id)
    };
    pi_bot_clarify_lock(
        Some(session_id.to_owned()),
        resolved_id,
        question_id,
        Some(answer.to_owned()),
    )?;
    Ok(1)
}

/// 取会话；不在注册表时按 `path` 懒装配（应用重启后群成员会话仍可用——
/// 插件持久化的是 stored id，第一次提交时按 id 找路径重开）。
fn ensure_session(
    session_id: &str,
    path: Option<&str>,
    config: &BotConfig,
) -> Result<Arc<BotSession>, String> {
    if let Some(session) = find_session(session_id) {
        return Ok(session);
    }
    let Some(path) = path.map(str::to_string) else {
        return Err(format!(
            "bot 会话 {session_id} 不在泳道注册表（缺少 path——请先 session.resume）"
        ));
    };
    let path_ref = Path::new(&path);
    if !path_ref.exists() {
        return Err(format!("bot 会话文件不存在：{path}"));
    }
    let cwd = pi_session::workspace_from_session_path(path_ref)
        .unwrap_or_else(pi_session::default_workspace);
    // 环境隔离：成员会话属于它自己的 profile home（hermes profile 的
    // sessions 目录对偶；config.profile 为 None/ default = 本体）。
    let session_dir = crate::pi_profiles::ensure_profile_dirs(config.profile.as_deref())?;
    let built = pi_session::build_harness_impl(
        &lane().rt,
        &cwd,
        Some(&path),
        config.provider.as_deref(),
        config.model_id.as_deref(),
        config.extension_filter.as_deref(),
        session_dir.as_deref(),
    )?;
    if built.id != session_id {
        return Err(format!(
            "bot 会话身份不符：请求 {session_id}，文件实际 {} ({path})",
            built.id
        ));
    }
    let session = make_session(built, config);
    apply_config(&session, config)?;
    recover_tasks(&session);
    Ok(insert_session(session))
}

// ── 命令：懒重开（attach 面）────────────────────────────────────────────────

/// 把已存在的成员会话装进泳道（应用重启后第一次 `file.attach` /
/// `image.attach_bytes` 用；prompt.submit 自带懒重开，此命令只为附件面补齐
/// 同样的入口，避免"先附件后提交"的顺序把附件丢掉）。
#[tauri::command(rename_all = "camelCase", async)]
pub fn pi_bot_open(
    session_id: String,
    path: Option<String>,
    system_prompt: Option<String>,
    provider: Option<String>,
    model_id: Option<String>,
    enabled_tools: Option<Vec<String>>,
    profile: Option<String>,
    extension_filter: Option<Vec<String>>,
) -> Result<Value, String> {
    let config = BotConfig {
        system_prompt,
        provider,
        model_id,
        enabled_tools,
        profile,
        extension_filter,
    };
    let session = ensure_session(&session_id, path.as_deref(), &config)?;
    Ok(json!({
        "session_id": session.id,
        "path": session.path.to_string_lossy(),
    }))
}

// ── ask / 审批投影 ──────────────────────────────────────────────────────────

fn collect_dialogs(session: &BotSession) {
    let mailbox = &session.reload.ui_dialog;
    {
        let mut asks = session.asks.lock().expect("bot asks poisoned");
        while let Some(request) =
            mailbox.take_pending_filtered(|r| ask_row(&r.ui, &r.request_id).is_some())
        {
            if let Some(row) = ask_row(&request.ui, &request.request_id) {
                asks.insert(request.request_id, row);
            }
        }
        asks.retain(|id, _| mailbox.is_pending(id));
    }
    {
        let mut approvals = session.approvals.lock().expect("bot approvals poisoned");
        while let Some(request) =
            mailbox.take_pending_filtered(|r| approval_row(&r.ui, &r.request_id).is_some())
        {
            if let Some(row) = approval_row(&request.ui, &request.request_id) {
                approvals.insert(request.request_id, (request.ui, row));
            }
        }
        approvals.retain(|id, _| mailbox.is_pending(id));
    }
}

/// ask 请求 → 上游 `open_requests` 形状：
/// `{id, method:'clarify', params:{questions:[{qid, question, choices?, multi_select?}]}}`。
fn open_requests(session: &BotSession) -> Vec<Value> {
    let asks = session.asks.lock().expect("bot asks poisoned");
    asks.iter()
        .map(|(id, row)| {
            let questions = row["request"]["questions"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            let qs: Vec<Value> = questions
                .iter()
                .enumerate()
                .map(|(index, q)| {
                    let qid = q
                        .get("id")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                        .unwrap_or_else(|| format!("q{index}"));
                    let mut out = json!({
                        "qid": qid,
                        "question": q.get("question").cloned().unwrap_or_else(|| json!("")),
                    });
                    if let Some(options) = q.get("options").and_then(Value::as_array) {
                        let labels: Vec<Value> = options
                            .iter()
                            .filter_map(|o| o.get("label").and_then(Value::as_str))
                            .map(|label| json!(label))
                            .collect();
                        out["choices"] = Value::Array(labels);
                    }
                    if q.get("multi").and_then(Value::as_bool) == Some(true) {
                        out["multi_select"] = json!(true);
                    }
                    out
                })
                .collect();
            json!({
                "id": id,
                "method": "clarify",
                "params": { "questions": qs },
            })
        })
        .collect()
}

fn permission_choices(ui: &Value) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    let Some(options) = ui.get("options").and_then(Value::as_array) else {
        return out;
    };
    for option in options {
        let permission = option
            .get("permission")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let key = if permission.starts_with("allow") {
            if permission.contains("always") {
                "always"
            } else if permission.contains("session") {
                "session"
            } else {
                "once"
            }
        } else if permission.starts_with("reject") || permission.starts_with("deny") {
            "deny"
        } else {
            continue;
        };
        if !out.iter().any(|v| v.as_str() == Some(key)) {
            out.push(json!(key));
        }
    }
    out
}

/// 审批对话框 → 上游 `pending_approval` 形状。
fn pending_approval(session: &BotSession) -> Value {
    let approvals = session.approvals.lock().expect("bot approvals poisoned");
    let Some((id, (ui, _row))) = approvals.iter().next() else {
        return Value::Null;
    };
    let description = ["title", "message", "summary", "question", "description"]
        .iter()
        .find_map(|key| ui.get(*key).and_then(Value::as_str))
        .unwrap_or("");
    let command = ui
        .get("command")
        .and_then(Value::as_str)
        .or_else(|| {
            ui.get("args")
                .and_then(|args| args.get("command"))
                .and_then(Value::as_str)
        })
        .unwrap_or("");
    let mut choices = permission_choices(ui);
    if choices.is_empty() {
        choices = vec![json!("once"), json!("deny")];
    }
    json!({
        "request_id": id,
        "description": description,
        "command": command,
        "choices": choices,
    })
}

// ── 命令：会话创建 / 提交 / 状态 ────────────────────────────────────────────

/// 建一个后台 bot 会话（不抢前台活动会话）。返回 `{sessionId, path}`。
///
/// 群聊成员的 `session.create`（`room_plumbing: true`）走这里；1:1 Bot Chat
/// 仍走 `pi_create_bot_session`（用户要打开它聊天，必须装成活动会话）。
#[tauri::command(rename_all = "camelCase", async)]
pub fn pi_bot_create_session(
    name: String,
    system_prompt: Option<String>,
    provider: Option<String>,
    model_id: Option<String>,
    cwd: Option<String>,
    enabled_tools: Option<Vec<String>>,
    profile: Option<String>,
    extension_filter: Option<Vec<String>>,
) -> Result<Value, String> {
    let cwd = cwd
        .map(PathBuf::from)
        .unwrap_or_else(pi_session::default_workspace);
    let config = BotConfig {
        system_prompt,
        provider: provider.clone(),
        model_id: model_id.clone(),
        enabled_tools,
        profile,
        extension_filter,
    };
    // 先建（未命名）→ 设置人格/工具 → 命名（set_name 是 fact 条目）。
    // 环境隔离：新成员会话落其 profile home 的 sessions 目录。
    let session_dir = crate::pi_profiles::ensure_profile_dirs(config.profile.as_deref())?;
    let built = pi_session::build_harness_impl(
        &lane().rt,
        &cwd,
        None,
        provider.as_deref(),
        model_id.as_deref(),
        config.extension_filter.as_deref(),
        session_dir.as_deref(),
    )?;
    let session = make_session(built, &config);
    apply_config(&session, &config)?;
    lane().rt.block_on(async {
        session
            .harness
            .session()
            .set_name(Some(name.as_str()))
            .await
            .map_err(|e| format!("bot 会话命名失败: {e}"))
    })?;
    insert_session(Arc::clone(&session));
    Ok(json!({
        "sessionId": session.id,
        "path": session.path.to_string_lossy(),
    }))
}

/// 提交一轮（admission 语义：立即返回，后台跑）。`path` 只在应用重启后
/// 首次提交时用于懒重开；`systemPrompt/provider/modelId/enabledTools` 是
/// `follow_profile_config` 的重建参数。
#[tauri::command(rename_all = "camelCase", async)]
pub fn pi_bot_prompt(
    app: AppHandle,
    session_id: String,
    text: String,
    task_meta: Option<Value>,
    path: Option<String>,
    system_prompt: Option<String>,
    provider: Option<String>,
    model_id: Option<String>,
    enabled_tools: Option<Vec<String>>,
    profile: Option<String>,
    extension_filter: Option<Vec<String>>,
) -> Result<Value, String> {
    let config = BotConfig {
        system_prompt,
        provider,
        model_id,
        enabled_tools,
        profile,
        extension_filter,
    };
    let session = ensure_session(&session_id, path.as_deref(), &config)?;
    if text.trim().is_empty() {
        return Err("prompt.submit: text 为空".into());
    }
    let images = std::mem::take(
        &mut *session
            .pending_images
            .lock()
            .expect("bot pending_images poisoned"),
    );
    // 引擎任务租约（rpi-harness task_lease）：一次提交 = 一个 task 身份 +
    // fencing token；并发/陈旧提交在这里被拒（不静默排队）。
    let (identity, lease_id) = {
        let mut state = session.state.lock().expect("bot state poisoned");
        if state.running {
            return Err(format!(
                "bot 会话 {session_id} 正在运行（本宿主不做忙时排队——群聊引擎不会并发提交）"
            ));
        }
        state.next_generation += 1;
        (
            rpi_harness::task_lease::TaskIdentity::new(
                format!("task-{}", uuid::Uuid::new_v4().simple()),
                state.next_generation,
            ),
            format!("lease-{}", uuid::Uuid::new_v4().simple()),
        )
    };
    rpi_harness::task_lease::acquire_with_meta(
        &session.path,
        &identity,
        &lease_id,
        3600.0,
        task_meta,
    )
    .map_err(|e| format!("prompt.submit: 任务租约获取失败: {e}"))?;
    {
        let mut state = session.state.lock().expect("bot state poisoned");
        state.running = true;
        state.started_at = Some(now_secs());
        state.last_error = None;
        state.current_task = Some(CurrentTask {
            task_id: identity.task_id.clone(),
            generation: identity.execution_generation,
            lease_id: lease_id.clone(),
        });
    }
    spawn_turn(
        app,
        Arc::clone(&session),
        text,
        images,
        identity,
        lease_id,
    )?;
    Ok(json!({ "status": "streaming", "session_id": session.id }))
}

fn spawn_turn(
    app: AppHandle,
    session: Arc<BotSession>,
    text: String,
    images: Vec<ImageContent>,
    identity: rpi_harness::task_lease::TaskIdentity,
    lease_id: String,
) -> Result<(), String> {
    let session_for_thread = Arc::clone(&session);
    let identity_for_thread = identity.clone();
    let lease_for_thread = lease_id.clone();
    std::thread::Builder::new()
        .name("mirach-bot-turn".into())
        .stack_size(16 * 1024 * 1024)
        .spawn(move || {
            let rt = &lane().rt;
            rt.block_on(async move {
                let pump_session = Arc::clone(&session_for_thread);
                let pump = tokio::spawn(async move {
                    loop {
                        collect_dialogs(&pump_session);
                        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                    }
                });
                // `tool.start` 生产者（screen-autoraise 的触发面；hermes 网关
                // change_watcher 推送的同款语义）：bot 泳道此前没有任何事件
                // drain，屏幕自动抬起永远收不到唤醒（2026-11-18 审计实锤修）。
                // 只发工具名——插件自己筛 `computer_use` / `browser_*`。
                let tool_pump = {
                    let mut rx = {
                        let guard =
                            session_for_thread.events.lock().expect("bot events poisoned");
                        guard.resubscribe()
                    };
                    let app_for_events = app.clone();
                    let tool_session_id = session_for_thread.id.clone();
                    let tool_profile = session_for_thread.profile.clone();
                    tokio::spawn(async move {
                        loop {
                            match rx.recv().await {
                                Ok(rpi_agent::AgentEvent::ToolExecutionStart {
                                    tool_name, ..
                                }) => emit(
                                    &app_for_events,
                                    "tool.start",
                                    json!({
                                        "session_id": tool_session_id,
                                        "profile": tool_profile,
                                        "name": tool_name,
                                    }),
                                ),
                                Ok(_) => {}
                                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                                    continue;
                                }
                                Err(_) => break,
                            }
                        }
                    })
                };
                let result =
                    AgentLane::prompt_text(session_for_thread.harness.as_ref(), &text, images)
                        .await;
                // 尾部事件窗口（与 PiEngine::prompt_inner 同款 30ms 纪律；
                // 本泳道没有事件 drain，仅让 rpi 内部落盘/广播收尾）。
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                pump.abort();
                tool_pump.abort();
                collect_dialogs(&session_for_thread);
                let (terminal_status, terminal_output) = match &result {
                    Ok(run) => match &run.outcome {
                        rpi_harness::agent_harness::HarnessRunOutcome::Completed {
                            final_message, ..
                        } => ("completed".to_owned(), assistant_text(final_message)),
                        rpi_harness::agent_harness::HarnessRunOutcome::Aborted {
                            final_message, ..
                        } => ("cancelled".to_owned(), assistant_text(final_message)),
                        rpi_harness::agent_harness::HarnessRunOutcome::Failed {
                            final_message, ..
                        } => (
                            "failed".to_owned(),
                            final_message.as_ref().map(assistant_text).unwrap_or_default(),
                        ),
                        rpi_harness::agent_harness::HarnessRunOutcome::Suspended { .. } => {
                            ("failed".to_owned(), String::new())
                        }
                    },
                    Err(_) => ("failed".to_owned(), String::new()),
                };
                let error = result.as_ref().err().map(|e| e.to_string());
                // 引擎终局回执：run outcome 映射任务状态（aborted→cancelled）。
                let (status, receipt) = match &result {
                    Ok(run) => match &run.outcome {
                        rpi_harness::agent_harness::HarnessRunOutcome::Completed {
                            final_entry_id,
                            ..
                        } => (
                            rpi_harness::task_lease::TaskStatus::Settled,
                            Some(format!("{}:{final_entry_id}", run.run_id)),
                        ),
                        rpi_harness::agent_harness::HarnessRunOutcome::Aborted {
                            final_entry_id,
                            ..
                        } => (
                            rpi_harness::task_lease::TaskStatus::Cancelled,
                            Some(format!("{}:{final_entry_id}", run.run_id)),
                        ),
                        rpi_harness::agent_harness::HarnessRunOutcome::Failed { error, .. } => (
                            rpi_harness::task_lease::TaskStatus::Failed,
                            Some(format!("{}:{}", run.run_id, error.code)),
                        ),
                        rpi_harness::agent_harness::HarnessRunOutcome::Suspended { .. } => (
                            rpi_harness::task_lease::TaskStatus::Failed,
                            Some(format!("{}:suspended", run.run_id)),
                        ),
                    },
                    Err(_) => (rpi_harness::task_lease::TaskStatus::Failed, None),
                };
                if let Err(e) = rpi_harness::task_lease::finish(
                    &session_for_thread.path,
                    &identity_for_thread,
                    &lease_for_thread,
                    status,
                    error.as_deref(),
                    receipt.as_deref(),
                ) {
                    eprintln!(
                        "[bot] task_lease finish 失败 {}: {e}",
                        session_for_thread.path.display()
                    );
                }
                {
                    let mut state = session_for_thread
                        .state
                        .lock()
                        .expect("bot state poisoned");
                    state.running = false;
                    state.last_finished_at = Some(now_secs());
                    state.last_error = error.clone();
                    state.last_status = Some(terminal_status);
                    state.last_output = if terminal_output.is_empty() {
                        None
                    } else {
                        Some(terminal_output)
                    };
                    state.current_task = None;
                    state.last_turn_seq = state.last_turn_seq.saturating_add(1);
                }
                let payload = json!({
                    "session_id": session_for_thread.id,
                    "profile": session_for_thread.profile,
                });
                match error {
                    Some(message) => {
                        let mut payload = payload;
                        payload["error"] = json!(message);
                        emit(&app, "error", payload);
                    }
                    None => emit(&app, "message.complete", payload),
                }
            });
        })
        .map_err(|e| {
            let _ = rpi_harness::task_lease::finish(
                &session.path,
                &identity,
                &lease_id,
                rpi_harness::task_lease::TaskStatus::Failed,
                Some("bot 轮次线程启动失败"),
                None,
            );
            let mut state = session.state.lock().expect("bot state poisoned");
            state.running = false;
            state.current_task = None;
            state.last_error = Some(format!("bot 轮次线程启动失败: {e}"));
            state.last_turn_seq = state.last_turn_seq.saturating_add(1);
            format!("bot 轮次线程启动失败: {e}")
        })?;
    Ok(())
}

fn emit(app: &AppHandle, name: &str, payload: Value) {
    let channel = format!("mirach:plugin:{}", name.replace(['.', '/'], ":"));
    if let Err(e) = app.emit(&channel, payload) {
        eprintln!("[pi_bot] 事件 {channel} 发送失败: {e}");
    }
}

/// assistant 消息中的文本块拼接（peer `/v1/runs` 的 `output`）。
fn assistant_text(message: &rpi_ai::types::AssistantMessage) -> String {
    message
        .content
        .iter()
        .filter_map(|part| match part {
            Content::Text(text) => Some(text.text.clone()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("")
}

/// `session.resume` 需要的运行态快照（消息面由前端按会话文件读）。
#[tauri::command(rename_all = "camelCase", async)]
pub fn pi_bot_state(session_id: String) -> Result<Value, String> {
    let Some(session) = find_session(&session_id) else {
        // 未注册 = 没跑过（应用重启后第一次 resume）：如实空态，由前端
        // 按文件读消息；不是错误（插件把 4007 用于"会话不存在"判定）。
        return Ok(json!({
            "session_id": session_id,
            "running": false,
            "inflight": Value::Null,
            "turn_started_at": Value::Null,
            "open_requests": [],
            "pending_approval": Value::Null,
        }));
    };
    let state = session.state.lock().expect("bot state poisoned");
    Ok(json!({
        "session_id": session.id,
        "running": state.running,
        "inflight": match &state.last_error {
            Some(error) => json!({ "status": "error", "error": error }),
            None => Value::Null,
        },
        "turn_started_at": state.started_at,
        "path": session.path.to_string_lossy(),
        "open_requests": open_requests(&session),
        "pending_approval": pending_approval(&session),
        "last_status": state.last_status.clone(),
        "last_output": state.last_output.clone(),
        // 终局计数器：peer monitor 据此判定「本次」轮次收尾（见 BotRunState 注释）。
        "last_turn_seq": state.last_turn_seq,
        // 引擎任务租约快照（canonical driver 用 task 身份做 fencing/重试）。
        "task": state.current_task.as_ref().map(|task| json!({
            "task_id": task.task_id,
            "execution_generation": task.generation,
        })),
        "tasks": rpi_harness::task_lease::list(&session.path)
            .map(|records| serde_json::to_value(records).unwrap_or(Value::Null))
            .unwrap_or(Value::Null),
        "recovered_tasks": state.recovered,
    }))
}

/// 取走启动时 recover 出来的 indeterminate 任务记录（读取后清空）。
#[tauri::command(rename_all = "camelCase", async)]
pub fn pi_bot_take_recovered(session_id: String) -> Result<Value, String> {
    let Some(session) = find_session(&session_id) else {
        return Ok(json!({ "tasks": [] }));
    };
    let mut state = session.state.lock().expect("bot state poisoned");
    let tasks = std::mem::take(&mut state.recovered);
    Ok(json!({ "tasks": tasks }))
}

/// 带 fencing 的中断：只有 task_id + generation 精确匹配当前运行时才 abort
/// （陈旧 token 拒绝，绝不作用到另一轮）。成功后把任务标成 cancelled。
#[tauri::command(rename_all = "camelCase", async)]
pub fn pi_bot_interrupt_task(
    session_id: String,
    task_id: String,
    execution_generation: u64,
) -> Result<Value, String> {
    let Some(session) = find_session(&session_id) else {
        return Err(format!("bot 会话 {session_id} 不在泳道注册表"));
    };
    let identity =
        rpi_harness::task_lease::TaskIdentity::new(task_id.clone(), execution_generation);
    let record = rpi_harness::task_lease::ensure_live(&session.path, &identity, None)
        .map_err(|e| format!("task.interrupt 被拒绝: {e}"))?;
    lane().rt.block_on(async {
        AgentLane::abort(session.harness.as_ref())
            .await
            .map_err(|e| format!("bot 会话中断失败: {e}"))
    })?;
    let lease = record
        .lease
        .as_ref()
        .map(|lease| lease.lease_id.clone())
        .ok_or_else(|| "task.interrupt: 当前任务没有租约".to_string())?;
    rpi_harness::task_lease::finish(
        &session.path,
        &identity,
        &lease,
        rpi_harness::task_lease::TaskStatus::Cancelled,
        Some("interrupted"),
        None,
    )
    .map_err(|e| format!("task.interrupt 终局落盘失败: {e}"))?;
    Ok(json!({ "status": "interrupted", "session_id": session_id, "task_id": task_id }))
}

/// peer steer：向运行中的泳道注入用户指导（上游 `AgentHarness::steer` 的对偶）。
pub(crate) fn pi_bot_steer(session_id: &str, text: &str) -> Result<bool, String> {
    let text = text.trim();
    if text.is_empty() {
        return Err("steer text 为空".into());
    }
    let Some(session) = find_session(session_id) else {
        return Err(format!("bot 会话 {session_id} 不在泳道注册表"));
    };
    let message = rpi_agent::message::AgentMessage::User(rpi_ai::types::UserMessage::new(
        rpi_ai::types::UserContent::Text(text.to_owned()),
        now_secs() as i64 * 1000,
    ));
    lane().rt.block_on(async {
        session
            .harness
            .steer(message)
            .await
            .map(|_| true)
            .map_err(|e| format!("bot 会话 steer 失败: {e}"))
    })
}

#[tauri::command(rename_all = "camelCase", async)]
pub fn pi_bot_interrupt(session_id: String) -> Result<Value, String> {
    let Some(session) = find_session(&session_id) else {
        // 未跑过 = 没有可中断的轮次（上游 `not_interrupted` 语义，不是错误）。
        return Ok(json!({ "status": "not_interrupted", "session_id": session_id }));
    };
    lane().rt.block_on(async {
        AgentLane::abort(session.harness.as_ref())
            .await
            .map(|_| ())
            .map_err(|e| format!("bot 会话中断失败: {e}"))
    })?;
    Ok(json!({ "status": "interrupted", "session_id": session_id }))
}

/// 群聊「压缩历史」：`session.compress` 的宿主对偶。
#[tauri::command(rename_all = "camelCase", async)]
pub fn pi_bot_compact(session_id: String) -> Result<Value, String> {
    let Some(session) = find_session(&session_id) else {
        return Err(format!("bot 会话 {session_id} 不在泳道注册表"));
    };
    let outcome = lane().rt.block_on(async {
        AgentLane::compact(session.harness.as_ref(), None)
            .await
            .map_err(|e| format!("bot 会话压缩失败: {e}"))
    })?;
    use rpi_harness::agent_harness::CompactionOutcome;
    match outcome.outcome {
        CompactionOutcome::Completed { .. } => Ok(json!({ "compressed": true, "status": "done" })),
        CompactionOutcome::Declined { .. } => Ok(json!({ "compressed": false, "status": "skipped" })),
        CompactionOutcome::Aborted { .. } => Err("bot 会话压缩被中止".into()),
        CompactionOutcome::Failed { error, .. } => {
            Err(format!("bot 会话压缩失败: {}", error.message))
        }
    }
}

// ── 命令：附件 ──────────────────────────────────────────────────────────────

fn decode_data_url(data_url: &str) -> Result<(Option<String>, Vec<u8>), String> {
    use base64::Engine;
    let (mime, payload) = match data_url.split_once(',') {
        Some((head, payload)) if head.starts_with("data:") => {
            let mime = head
                .trim_start_matches("data:")
                .split(';')
                .next()
                .map(str::to_string)
                .filter(|m| !m.is_empty());
            (mime, payload)
        }
        _ => (None, data_url),
    };
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(payload.trim())
        .map_err(|e| format!("附件 base64 解码失败: {e}"))?;
    Ok((mime, bytes))
}

fn mime_from_name(name: &str) -> String {
    let ext = Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    match ext.as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "png" => "image/png",
        _ => "image/png",
    }
    .to_string()
}

/// `image.attach_bytes`：把图片暂存到该会话，下一次 `prompt.submit` 随文本
/// 一起提交（rpi 的 `prompt_text(text, images)` 原生支持图片块）。
#[tauri::command(rename_all = "camelCase", async)]
pub fn pi_bot_attach_image(
    session_id: String,
    content_base64: String,
    filename: Option<String>,
) -> Result<Value, String> {
    let Some(session) = find_session(&session_id) else {
        return Err(format!("bot 会话 {session_id} 不在泳道注册表"));
    };
    use base64::Engine;
    let (data_url_mime, payload) = match content_base64.split_once(',') {
        Some((head, payload)) if head.starts_with("data:") => (
            head.trim_start_matches("data:")
                .split(';')
                .next()
                .map(str::to_string)
                .filter(|m| !m.is_empty()),
            payload,
        ),
        _ => (None, content_base64.as_str()),
    };
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(payload.trim())
        .map_err(|e| format!("图片 base64 解码失败: {e}"))?;
    // 只做完整性校验（空图拒绝）；mime 按文件名/数据头推断，不改写内容。
    if bytes.is_empty() {
        return Err("图片内容为空".into());
    }
    let mime = data_url_mime
        .unwrap_or_else(|| filename.as_deref().map(mime_from_name).unwrap_or_else(|| "image/png".into()));
    session
        .pending_images
        .lock()
        .expect("bot pending_images poisoned")
        .push(ImageContent {
            kind: Default::default(),
            data: Arc::from(
                base64::engine::general_purpose::STANDARD
                    .encode(&bytes)
                    .as_str(),
            ),
            mime_type: mime,
        });
    Ok(json!({ "attached": true }))
}

/// `file.attach`：把文件落盘到宿主附件目录，返回插件拼进提示词的
/// `ref_text`（绝对路径，bot 的 file 工具可直接读）。
#[tauri::command(rename_all = "camelCase", async)]
pub fn pi_bot_attach_file(
    session_id: String,
    data_url: String,
    name: String,
) -> Result<Value, String> {
    if find_session(&session_id).is_none() {
        return Err(format!("bot 会话 {session_id} 不在泳道注册表"));
    }
    let (_, bytes) = decode_data_url(&data_url)?;
    let safe_name = Path::new(&name)
        .file_name()
        .and_then(|n| n.to_str())
        .filter(|n| !n.trim().is_empty())
        .unwrap_or("attachment");
    let dir = crate::pi_paths::agent_dir()?
        .join("bot-attachments")
        .join(&session_id);
    std::fs::create_dir_all(&dir).map_err(|e| format!("附件目录创建失败 {}: {e}", dir.display()))?;
    let stamped = format!(
        "{}_{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0),
        safe_name
    );
    let path = dir.join(stamped);
    std::fs::write(&path, &bytes).map_err(|e| format!("附件写入失败 {}: {e}", path.display()))?;
    let ref_text = path.to_string_lossy().to_string();
    Ok(json!({
        "attached": true,
        "name": name,
        "path": ref_text,
        "ref_text": ref_text,
    }))
}

// ── 命令：clarify / 审批应答 ────────────────────────────────────────────────

/// `clarify.lock`：逐题应答；全部题目答完时一次性 `respond`（rpi ask 请求
/// 的应答是整条请求一组 values，逐题锁只是上游 wire 的节奏）。
///
/// **调用点不带 session_id**（`group-turns.ts::answerGroupClarify` 的 clarify
/// 分支只传 request_id/question_id/answer）——按 request_id 在注册表里找
/// 持有该请求的会话；显式给了 session_id 就按它定位（更严）。
#[tauri::command(rename_all = "camelCase", async)]
pub fn pi_bot_clarify_lock(
    session_id: Option<String>,
    request_id: String,
    question_id: String,
    answer: Option<String>,
) -> Result<Value, String> {
    let session = match session_id.and_then(|id| find_session(&id)) {
        Some(session) => session,
        None => {
            let found = lane()
                .sessions
                .lock()
                .expect("bot sessions poisoned")
                .values()
                .find(|s| {
                    s.asks
                        .lock()
                        .expect("bot asks poisoned")
                        .contains_key(&request_id)
                })
                .map(Arc::clone);
            found.ok_or_else(|| {
                format!("没有挂起的 clarify 请求 {request_id}（不在任何 bot 会话）")
            })?
        }
    };
    let row = session
        .asks
        .lock()
        .expect("bot asks poisoned")
        .get(&request_id)
        .cloned()
        .ok_or_else(|| format!("没有挂起的 clarify 请求 {request_id}"))?;
    {
        let mut all = session
            .clarify_answers
            .lock()
            .expect("bot clarify answers poisoned");
        all.entry(request_id.clone())
            .or_default()
            .insert(question_id, answer);
    }
    let questions = row["request"]["questions"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let qids: Vec<String> = questions
        .iter()
        .enumerate()
        .map(|(index, q)| {
            q.get("id")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| format!("q{index}"))
        })
        .collect();
    let collected = session
        .clarify_answers
        .lock()
        .expect("bot clarify answers poisoned")
        .get(&request_id)
        .cloned()
        .unwrap_or_default();
    let remaining: Vec<String> = qids
        .iter()
        .filter(|qid| !collected.contains_key(*qid))
        .cloned()
        .collect();
    if !remaining.is_empty() {
        return Ok(json!({ "status": "ok", "remaining": remaining }));
    }
    let wires: Vec<AskAnswerWire> = qids
        .iter()
        .map(|qid| {
            let answer = collected.get(qid).cloned().flatten();
            AskAnswerWire {
                question_id: Some(qid.clone()),
                selected: answer.clone().map(|value| vec![value]).unwrap_or_default(),
                other: answer,
            }
        })
        .collect();
    let value = ask_answer_value(&row, &wires)?;
    session
        .reload
        .ui_dialog
        .respond(&request_id, value)
        .map_err(|e| format!("clarify 应答失败: {e}"))?;
    session
        .asks
        .lock()
        .expect("bot asks poisoned")
        .remove(&request_id);
    session
        .clarify_answers
        .lock()
        .expect("bot clarify answers poisoned")
        .remove(&request_id);
    Ok(json!({ "status": "ok" }))
}

/// `approval.respond`：choice（once/session/always/deny）→ 插件选项标题。
#[tauri::command(rename_all = "camelCase", async)]
pub fn pi_bot_approval_respond(
    session_id: String,
    request_id: String,
    choice: String,
) -> Result<Value, String> {
    let Some(session) = find_session(&session_id) else {
        return Err(format!("bot 会话 {session_id} 不在泳道注册表"));
    };
    let ui = session
        .approvals
        .lock()
        .expect("bot approvals poisoned")
        .get(&request_id)
        .map(|(ui, _)| ui.clone())
        .ok_or_else(|| format!("没有挂起的审批请求 {request_id}"))?;
    let wanted = match choice.as_str() {
        "deny" => "reject",
        "always" => "allow_always",
        "session" => "allow_session",
        _ => "allow_once",
    };
    let options = ui
        .get("options")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let title = options
        .iter()
        .find_map(|option| {
            option
                .get("permission")
                .and_then(Value::as_str)
                .filter(|permission| *permission == wanted)
                .and_then(|_| option.get("title").and_then(Value::as_str))
                .map(str::to_string)
        })
        .or_else(|| {
            // 退化到同族（allow_* / reject_*）的第一个选项——仍是插件声明的
            // 真实选项，不是编造。
            let prefix = if wanted.starts_with("allow") { "allow" } else { "reject" };
            options.iter().find_map(|option| {
                option
                    .get("permission")
                    .and_then(Value::as_str)
                    .filter(|permission| permission.starts_with(prefix))
                    .and_then(|_| option.get("title").and_then(Value::as_str))
                    .map(str::to_string)
            })
        });
    let value = match title {
        Some(title) => json!({ "values": [title], "kind": "confirm" }),
        None => approval_answer_value(&ui, Some(&json!(choice != "deny")))?,
    };
    session
        .reload
        .ui_dialog
        .respond(&request_id, value)
        .map_err(|e| format!("审批应答失败: {e}"))?;
    session
        .approvals
        .lock()
        .expect("bot approvals poisoned")
        .remove(&request_id);
    Ok(json!({ "resolved": 1 }))
}

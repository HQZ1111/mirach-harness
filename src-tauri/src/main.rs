// mirach-harness 的 Tauri 壳：开窗指向 vite dev（1430）+ 系统托盘。
// 托盘语义照抄 ZCode desktopTray.ts（Electron）：左键/双击托盘=显示主窗，
// 右键菜单=显示/退出；Windows 下点 ✕ = 隐藏到托盘（closeToTrayOnWindows），
// 真退出只走托盘菜单「退出」。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// 本地文件系统桥（自 G:/MIRACH 主工程逐字移植）：fs_list / fs_git_root /
// fs_read_data_url——文件树窗格的数据源
mod fs;

// pi SDK 集成第 1 步（docs/pi-integration.md §7-1）：会话骨架
mod pi_session;
mod agui;

// pi 设置页配置面（docs/pi-integration.md §7-7/§4.5）：settings/models/
// auth 三个配置文件的读改命令——配置真相 = pi 自己的配置文件（§5）
mod pi_settings;

// pi 资源面 IPC（左栏入口条「技能与工具」）：skills/prompts/extensions/
// packages 只读列举——走 pi 自己的 loader（pi_resources.rs 模块头有出处）
mod pi_resources;

// 终端 PTY 桥（terminal.rs 模块头有事件通道裁定）：终端是系统设施不是
// Agent 数据——输出/退出走 Tauri Event，控制走 IPC invoke
mod terminal;

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, WindowEvent,
};

/// 设计初始尺寸（逻辑像素，与 tauri.conf 一致）
const DESIGN_W: f64 = 1800.0;
const DESIGN_H: f64 = 1000.0;
/// 任务栏预留（逻辑像素）
const TASKBAR_H: f64 = 48.0;
/// 屏幕边缘预留（逻辑像素）
const EDGE: f64 = 16.0;

/// 显示主窗并聚焦（托盘左键与菜单「显示主窗口」共用）
fn show_main(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        #[cfg(windows)]
        if let Ok(h) = window.hwnd() {
            // tao 的 set_visible 在 transparent 窗口上会失效（Ok 但不生效，
            // 实测 2026-09-25）——Win32 SW_SHOW 兜底
            raw_show_window(h.0 as isize, SW_SHOW);
        }
    }
}

#[cfg(windows)]
const SW_HIDE: i32 = 0;
#[cfg(windows)]
const SW_SHOW: i32 = 5;

// user32 ShowWindow 的裸 FFI（绕开 tao set_visible 在 transparent 窗上的失效）
#[cfg(windows)]
#[link(name = "user32")]
extern "system" {
    fn ShowWindow(hWnd: isize, nCmdShow: i32) -> i32;
}

#[cfg(windows)]
fn raw_show_window(hwnd: isize, cmd: i32) {
    unsafe { ShowWindow(hwnd, cmd) };
}

/// tao hide 失效的兜底：直接 Win32 SW_HIDE
#[cfg(windows)]
fn force_hide(window: &tauri::WebviewWindow) {
    if let Ok(h) = window.hwnd() {
        raw_show_window(h.0 as isize, SW_HIDE);
    }
}

/// 双屏分辨率不一致：窗口落到装不下它的屏幕时，把尺寸钳制到该屏工作区。
/// 不强制最大化——用户把窗口拖到小屏可能只是临时放一下。
fn fit_to_monitor(window: &tauri::WebviewWindow) {
    let monitor = match window.current_monitor() {
        Ok(Some(m)) => m,
        _ => return,
    };
    let scale = monitor.scale_factor();
    let work_w = monitor.size().width as f64 / scale - EDGE;
    let work_h = monitor.size().height as f64 / scale - TASKBAR_H - EDGE;
    let Ok(inner) = window.inner_size() else { return };
    let cur_w = inner.width as f64 / scale;
    let cur_h = inner.height as f64 / scale;
    if cur_w > work_w || cur_h > work_h {
        let _ = window.set_size(tauri::LogicalSize::new(cur_w.min(work_w), cur_h.min(work_h)));
    }
}

/// AG-UI 端点发现（端口+token；前端主动拉取，§2.1）
#[tauri::command]
fn get_agui_endpoint(
    state: tauri::State<std::sync::Arc<agui::AguiState>>,
) -> serde_json::Value {
    state.endpoint()
}

// ── pi 控制面 IPC（docs/pi-integration.md §4.5：HTTP 只管事件流，
//    其余一切控制走 IPC）——pi_* 命令带 (async)：同步 fn 走 Tauri
//    线程池而非 WebView2 UI 线程（P1-1——流式期间 IPC 调用不再冻窗；
//    引擎内部仍按 16MiB 大栈纪律处理，on_big_stack 形态不动）。──

#[tauri::command(async)]
fn pi_get_state(
    state: tauri::State<std::sync::Arc<agui::AguiState>>,
) -> Result<serde_json::Value, String> {
    state.engine.state()
}

#[tauri::command(async)]
fn pi_get_messages(
    state: tauri::State<std::sync::Arc<agui::AguiState>>,
) -> Result<serde_json::Value, String> {
    state.engine.messages()
}

/// 机器人预设会话（左栏「机器人」窗格启动钮）：system_prompt + model +
/// working_directory 一次性透传 SessionOptions（pi_session.rs
/// create_bot_session）。创建成功后以 bot 名重命名该会话（rename_session
/// 只作用当前会话——刚建即当前，侧栏行名即机器人名）。返回 pi_get_state
/// 快照（sessionId 供前端直接采纳）。
#[tauri::command(rename_all = "camelCase", async)]
fn pi_create_bot_session(
    state: tauri::State<std::sync::Arc<agui::AguiState>>,
    name: String,
    system_prompt: Option<String>,
    provider: Option<String>,
    model_id: Option<String>,
    cwd: Option<String>,
) -> Result<serde_json::Value, String> {
    state.engine.create_bot_session(
        provider,
        model_id,
        system_prompt,
        cwd,
        Some(state.ui_bridge("main")),
    )?;
    state.engine.rename_session(&name)?;
    state.engine.state()
}

// 参数命名显式 camelCase（Tauri v2 默认即此，写明防签名漂移——前端
// invoke 以 modelId 调用，静默错名会变成"参数缺失"错误）
#[tauri::command(rename_all = "camelCase", async)]
fn pi_set_model(
    state: tauri::State<std::sync::Arc<agui::AguiState>>,
    provider: String,
    model_id: String,
) -> Result<(), String> {
    state.engine.set_model(&provider, &model_id)
}

#[tauri::command(async)]
fn pi_set_thinking_level(
    state: tauri::State<std::sync::Arc<agui::AguiState>>,
    level: String,
) -> Result<(), String> {
    state.engine.set_thinking_level(&level)
}

#[tauri::command(async)]
fn pi_interrupt(state: tauri::State<std::sync::Arc<agui::AguiState>>) -> Result<(), String> {
    state.engine.interrupt()
}

#[tauri::command(async)]
fn pi_list_models(
    state: tauri::State<std::sync::Arc<agui::AguiState>>,
) -> Result<serde_json::Value, String> {
    state.engine.list_models()
}

// ── 扩展 UI 请求（§4.4 审批/问题卡）：请求经 SSE CUSTOM 到前端卡，
//    应答走 IPC 回灌 oneshot。──

#[tauri::command(async)]
fn pi_pending_approvals(
    state: tauri::State<std::sync::Arc<agui::AguiState>>,
) -> Result<Vec<serde_json::Value>, String> {
    Ok(state.approvals.list())
}

#[tauri::command(rename_all = "camelCase", async)]
fn pi_extension_ui_response(
    state: tauri::State<std::sync::Arc<agui::AguiState>>,
    id: String,
    value: Option<serde_json::Value>,
    cancelled: bool,
) -> Result<(), String> {
    state
        .approvals
        .respond(&id, agui::UiAnswer { value, cancelled })
}

// ── 会话持久化（§7-4 侧栏 sessions：对话真相在 pi，前端只持镜像）──

#[tauri::command(async)]
fn pi_list_sessions(
    state: tauri::State<std::sync::Arc<agui::AguiState>>,
) -> Result<serde_json::Value, String> {
    state.engine.list_sessions()
}

/// New Chat 语义：flush 旧会话落盘 + 清空 handle；下一次 POST 按需建新会话
/// （不立即创建，避免弃用的空会话文件堆积）。
#[tauri::command(async)]
fn pi_discard_session(
    state: tauri::State<std::sync::Arc<agui::AguiState>>,
) -> Result<(), String> {
    state.engine.discard_session()
}

/// 在指定工作区新建（空）会话（侧栏「选择工作区」入口）：working_directory
/// 透传 SessionOptions（header.cwd = 该目录——侧栏按工作区分组的数据源；
/// workspace_trusted = 用户显式选择即信任决定）。返回 pi_get_state 快照
/// （sessionId 供前端直接采纳，省一次往返）。
#[tauri::command(rename_all = "camelCase", async)]
fn pi_new_session(
    state: tauri::State<std::sync::Arc<agui::AguiState>>,
    cwd: String,
) -> Result<serde_json::Value, String> {
    state
        .engine
        .new_session_with_cwd(&cwd, Some(state.ui_bridge("main")))?;
    state.engine.state()
}

/// 每会话 tokens/cost 汇总（侧栏 rowMeta「Tokens/成本」）：paths = 需要的
/// 会话文件，逐文件走 pi stats 聚合。返回 {path: {totalTokens, costUsd}}。
#[tauri::command(rename_all = "camelCase", async)]
fn pi_sessions_usage(
    state: tauri::State<std::sync::Arc<agui::AguiState>>,
    paths: Vec<String>,
) -> Result<serde_json::Value, String> {
    state.engine.sessions_usage(&paths)
}

/// 导出会话为独立 HTML 文档（hermes row.export 的 pi 实现：
/// Session::to_html / export_snapshot）。返回 HTML 文本；落盘由前端
/// save 对话框 + fs_write_text_file 完成。
#[tauri::command(rename_all = "camelCase", async)]
fn pi_export_session_html(
    state: tauri::State<std::sync::Arc<agui::AguiState>>,
    path: String,
) -> Result<String, String> {
    state.engine.export_session_html(&path)
}

/// 前端挂载时取缓冲最新 seq 作为 EventSource 的 lastEventId 起点
/// （跳过历史重放——会话历史经 pi_get_messages 水合）。
#[tauri::command(async)]
fn pi_stream_cursor(
    state: tauri::State<std::sync::Arc<agui::AguiState>>,
) -> Result<u64, String> {
    Ok(state.latest_seq("main"))
}

#[tauri::command(rename_all = "camelCase", async)]
fn pi_open_session(
    state: tauri::State<std::sync::Arc<agui::AguiState>>,
    path: String,
) -> Result<String, String> {
    // 返回新活动会话 id（create_session_opts 的返回值）——会话线「回到父
    // 会话」等按路径切换的调用方需要它更新 currentThreadId。
    state
        .engine
        .open_session(&path, Some(state.ui_bridge("main")))
}

/// 当前会话的 fork 谱系（branchedFrom = 父会话文件路径；线性会话 = null）。
#[tauri::command(async)]
fn pi_get_session_lineage(
    state: tauri::State<std::sync::Arc<agui::AguiState>>,
) -> Result<Option<String>, String> {
    state.engine.session_lineage()
}

#[tauri::command(rename_all = "camelCase", async)]
fn pi_rename_session(
    state: tauri::State<std::sync::Arc<agui::AguiState>>,
    name: String,
) -> Result<(), String> {
    state.engine.rename_session(&name)
}

#[tauri::command(rename_all = "camelCase", async)]
fn pi_delete_session(
    state: tauri::State<std::sync::Arc<agui::AguiState>>,
    path: String,
) -> Result<(), String> {
    state.engine.delete_session(&path)
}

// ── checkpoint / rewind / retry（pi::checkpoint pub 面，对话历史编辑）。
//    时序约定：四个命令都要拿 handle mutex——prompt 在跑时（isRunning）会
//    阻塞到该 run 结束，前端负责先 pi_interrupt 再调用。──

/// 编辑重跑准备（/retry 语义）：leaf 移到最后一个可重试 user turn 的父级。
/// **只准备分支**——重发由前端下一次 POST 完成（新 turn 落为兄弟分支，旧
/// 分支及其回复保留在会话树里）。无可重试 turn = 明确 Err。返回
/// {text, abandonedEntryId}（text 供前端回填 composer 重发）。
#[tauri::command(async)]
fn pi_retry_edit(
    state: tauri::State<std::sync::Arc<agui::AguiState>>,
) -> Result<serde_json::Value, String> {
    state.engine.retry_edit()
}

/// 在当前 leaf 打 checkpoint（label 空/缺省 = "checkpoint"）。返回完整
/// checkpoint JSON（含 entryId/name——name 是 pi_rewind 的查找键）。
#[tauri::command(rename_all = "camelCase", async)]
fn pi_mark_checkpoint(
    state: tauri::State<std::sync::Arc<agui::AguiState>>,
    label: Option<String>,
) -> Result<serde_json::Value, String> {
    state.engine.mark_checkpoint(label)
}

/// 列出当前会话活动路径上的 checkpoint（JSONL Custom 条目枚举——上游无
/// 枚举 API）。entryId = 会话树条目 id；name = rewind 的查找键。
#[tauri::command(async)]
fn pi_list_checkpoints(
    state: tauri::State<std::sync::Arc<agui::AguiState>>,
) -> Result<serde_json::Value, String> {
    state.engine.list_checkpoints()
}

/// 回退到 checkpoint：active context 截断到该 checkpoint 边界（user-turn
/// 对齐），span 折叠为一条摘要报告；会话树完整保留。checkpointId =
/// checkpoint **名称**（pi find_checkpoint 的匹配键）。摘要失败 = Err。
#[tauri::command(rename_all = "camelCase", async)]
fn pi_rewind(
    state: tauri::State<std::sync::Arc<agui::AguiState>>,
    checkpoint_id: String,
) -> Result<serde_json::Value, String> {
    state.engine.rewind(&checkpoint_id)
}

// ── 会话 fork / 分支（pi Session 树原生能力；上游先例 rpc fork/
//    get_fork_messages 与 interactive/tree_ui 的 stage_and_commit——
//    Session 是 durable authority，Agent 只是投影）。fork/switch 在 run
//    进行中一律 Err（上游 session transition blocker 语义），前端先
//    pi_interrupt。──

/// 从指定 user 消息 fork 新会话：新会话叶 = 选中消息父级（选中消息不进
/// 新文件——selectedText 预填 composer 重新提交即新分支）。返回
/// {path, sessionId, selectedText}；换装走 open_session 链（审批清理/
/// AG-UI/侧栏现成），前端随后重拉 pi_get_messages 水合新会话。
#[tauri::command(rename_all = "camelCase", async)]
fn pi_fork_session(
    state: tauri::State<std::sync::Arc<agui::AguiState>>,
    entry_id: String,
) -> Result<serde_json::Value, String> {
    state
        .engine
        .fork_session(&entry_id, Some(state.ui_bridge("main")))
}

/// 枚举当前活动路径上的 user 消息（fork 点清单；上游 get_fork_messages
/// 同语义）。[{entryId, text}]
#[tauri::command(async)]
fn pi_get_fork_points(
    state: tauri::State<std::sync::Arc<agui::AguiState>>,
) -> Result<serde_json::Value, String> {
    state.engine.get_fork_points()
}

/// 最近分叉点的兄弟分支（null = 当前路径无分叉）。形状：
/// {forkPointId, branches: [{rootId, leafId, preview, messageCount,
/// isCurrent}]}。
#[tauri::command(async)]
fn pi_list_sibling_branches(
    state: tauri::State<std::sync::Arc<agui::AguiState>>,
) -> Result<serde_json::Value, String> {
    state.engine.list_sibling_branches()
}

/// 切换到指定叶（分支导航）。返回 {leafId}；前端之后重拉 pi_get_messages
/// 重水合当前分支。
#[tauri::command(rename_all = "camelCase", async)]
fn pi_switch_branch(
    state: tauri::State<std::sync::Arc<agui::AguiState>>,
    leaf_id: String,
) -> Result<serde_json::Value, String> {
    state.engine.switch_branch(&leaf_id)
}

fn main() {
    // pi 会话持久化：strict = 每条消息即时落盘并进索引（会话列表/重命名/
    // 删除立即可见；默认 balanced 是定时 autosave，列表会延迟出现且
    // rename 可能撞未落盘文件的锁）。桌面壳本地 JSONL append 开销可忽略。
    std::env::set_var("PI_SESSION_DURABILITY_MODE", "strict");

    tauri::Builder::default()
        .setup(|app| {
            let window = app.get_webview_window("main").expect("main window");
            // 初始尺寸跟随屏幕：工作区装得下 1800×1000 → 保持设计尺寸居中；
            // 装不下 → 最大化（跟随屏幕，任务栏由系统排除）。
            let monitor = window
                .current_monitor()
                .ok()
                .flatten()
                .or_else(|| window.primary_monitor().ok().flatten());
            if let Some(m) = &monitor {
                let scale = m.scale_factor();
                let screen_w = m.size().width as f64 / scale;
                let screen_h = m.size().height as f64 / scale;
                let fits = screen_w >= DESIGN_W + EDGE && screen_h >= DESIGN_H + TASKBAR_H + EDGE;
                if !fits {
                    let _ = window.maximize();
                }
            }
            // 窗口事件：✕ 隐藏到托盘（ZCode closeToTrayOnWindows 语义）；
            // 双屏分辨率不一致：窗口 Moved/缩放变化（跨屏拖动）后 250ms 防抖，
            // 落点屏幕装不下当前尺寸 → 钳制到该屏工作区。
            let win = window.clone();
            window.on_window_event(move |event| match event {
                WindowEvent::CloseRequested { api, .. } => {
                    eprintln!("[close-tray] CloseRequested fired, preventing + hiding");
                    api.prevent_close();
                    match win.hide() {
                        Ok(_) => eprintln!("[close-tray] tao hide ok"),
                        Err(e) => eprintln!("[close-tray] tao hide ERR: {e}"),
                    }
                    // tao hide 在 transparent 窗口上不生效（实测），Win32 兜底
                    #[cfg(windows)]
                    force_hide(&win);
                }
                WindowEvent::Moved(_) | WindowEvent::ScaleFactorChanged { .. } => {
                    let w = win.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_millis(250));
                        fit_to_monitor(&w);
                    });
                }
                _ => {}
            });

            // 系统托盘（hermes 无此物；ZCode desktopTray.ts 语义的 Tauri 版）
            let show_item = MenuItem::with_id(app, "tray-open", "显示主窗口", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "tray-quit", "退出", true, None::<&str>)?;
            let tray_menu = Menu::with_items(app, &[&show_item, &quit_item])?;
            TrayIconBuilder::with_id("mirach-tray")
                .icon(app.default_window_icon().expect("bundle icon").clone())
                .tooltip("Mirach Harness")
                .menu(&tray_menu)
                // 左键不弹菜单（ZCode：左键=显示主窗），菜单走右键
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "tray-open" => show_main(app),
                    "tray-quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main(tray.app_handle());
                    }
                })
                .build(app)?;

            // L2 AG-UI 桥（docs/pi-integration.md §7-2）：127.0.0.1:0 + token，
            // 端点经 get_agui_endpoint 主动拉取（避免启动竞态）。
            let agui_state = std::sync::Arc::new(agui::AguiState::new());
            let agui_router = agui::router(agui_state.clone());
            let agui_for_server = agui_state.clone();
            tauri::async_runtime::spawn(async move {
                match tokio::net::TcpListener::bind("127.0.0.1:0").await {
                    Ok(listener) => {
                        let port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
                        agui_for_server.set_port(port);
                        eprintln!("[agui] listening on 127.0.0.1:{port}");
                        let _ = axum::serve(listener, agui_router).await;
                    }
                    Err(e) => eprintln!("[agui] bind ERR: {e}"),
                }
            });
            app.manage(agui_state);

            // 终端会话注册表（terminal.rs）：PTY 会话句柄 + 输出泵线程
            app.manage(std::sync::Arc::new(terminal::TerminalRegistry::new()));
            Ok(())
        })
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            get_agui_endpoint,
            pi_get_state,
            pi_get_messages,
            pi_set_model,
            pi_set_thinking_level,
            pi_interrupt,
            pi_list_models,
            pi_pending_approvals,
            pi_extension_ui_response,
            pi_list_sessions,
            pi_discard_session,
            pi_new_session,
            pi_create_bot_session,
            pi_sessions_usage,
            pi_export_session_html,
            pi_stream_cursor,
            pi_open_session,
            pi_get_session_lineage,
            pi_rename_session,
            pi_delete_session,
            pi_retry_edit,
            pi_mark_checkpoint,
            pi_list_checkpoints,
            pi_rewind,
            pi_fork_session,
            pi_get_fork_points,
            pi_list_sibling_branches,
            pi_switch_branch,
            pi_settings::pi_get_settings,
            pi_settings::pi_set_settings,
            pi_settings::pi_get_models_config,
            pi_settings::pi_set_models_config,
            pi_settings::pi_auth_status,
            pi_resources::pi_list_resources,
            fs::fs_list,
            fs::fs_git_root,
            fs::fs_read_data_url,
            fs::fs_write_text_file,
            terminal::terminal_spawn,
            terminal::terminal_write,
            terminal::terminal_resize,
            terminal::terminal_kill,
            terminal::terminal_open_url
        ])
        .run(tauri::generate_context!())
        .expect("error while running mirach-harness");
}

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
) -> Result<(), String> {
    state
        .engine
        .open_session(&path, Some(state.ui_bridge("main")))?;
    Ok(())
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
            pi_stream_cursor,
            pi_open_session,
            pi_rename_session,
            pi_delete_session,
            pi_settings::pi_get_settings,
            pi_settings::pi_set_settings,
            pi_settings::pi_get_models_config,
            pi_settings::pi_set_models_config,
            pi_settings::pi_auth_status,
            fs::fs_list,
            fs::fs_git_root,
            fs::fs_read_data_url
        ])
        .run(tauri::generate_context!())
        .expect("error while running mirach-harness");
}

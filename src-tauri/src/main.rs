// mirach-harness 的 Tauri 壳：开窗指向 vite dev（1430）+ 系统托盘。
// 托盘语义照抄 ZCode desktopTray.ts（Electron）：左键/双击托盘=显示主窗，
// 右键菜单=显示/退出；Windows 下点 ✕ = 隐藏到托盘（closeToTrayOnWindows），
// 真退出只走托盘菜单「退出」。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

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

fn main() {
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
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running mirach-harness");
}

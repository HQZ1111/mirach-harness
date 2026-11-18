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
mod pi_bot;
// rpi 插件状态只读投影（rpi-todo / rpi-plan-mode 的 AppendEntry 条目 → 旧
// wire）：pi_session.rs 的 todo_state / mode_state 消费
mod pi_plugin_state;

// 目标完成校验器（ZCode goal verifier 的宿主对偶，2026-11-18 第五波续）：
// 每轮 run 结束后用 rpi side-question 原语校验目标，结论落
// `goal-verification` 条目（pi_goal_state 并入 active.verifications）
mod pi_goal_verify;
mod agui;
mod pi_paths;

// pi 设置页配置面（docs/pi-integration.md §7-7/§4.5）：settings/models/
// auth 三个配置文件的读改命令——配置真相 = pi 自己的配置文件（§5）
mod pi_settings;

// pi 凭据写入 + 引擎版本 + OS 通知测试（设置页「密码与登录 / 版本与更新 /
// 通知」数据面，2026-10-24 hermes 设置移植）
mod pi_keys;

// 密码与登录（hermes vault 的 local 源移植）：本机加密存储 CRUD——
// 元数据 JSON + 条目密文进 OS 凭据管理器（keyring）
mod pi_vault;

// OAuth 登录 / 端点测试 / vault 外部管理器探测（pi::auth 公开面接线）
mod pi_login;

// pi 资源面 IPC（左栏入口条「技能与工具」）：skills/prompts/extensions/
// packages 只读列举——走 pi 自己的 loader（pi_resources.rs 模块头有出处）
mod pi_resources;

// 个性配置面（OpenHuman「设置 → 个性」移植）：SOUL.md 读写/重置 + 会话注入
// （pi_persona.rs 模块头有上游对照与宿主映射）
mod pi_persona;

// 用量统计（ZCode「设置 → 用量」的 App Usage tab 移植）：本地 session 聚合
// （pi_usage.rs 模块头有字段映射表与"哪些字段不可得"）
mod pi_usage;

// 技能与工具集的写面（左栏「技能与工具」独立页面，hermes SkillsPage 移植）：
// 技能开关/CRUD + 工具集启停 + 会话注入（pi_capabilities.rs 模块头有
// pi 语义对照与"为什么技能提示由宿主渲染"）
mod pi_capabilities;
// MCP 服务器与扩展的管理面（连接器 / 插件 tab 的数据源）。
// pi **有**这两套系统（`pi::mcp` + `pi::extensions`），宿主会话侧也已经在用
// （`sync_extension_mcp_registrations` / `extension_ui_handler`）；此前缺的
// 只是管理 UI，不是能力。
// 引擎侧宿主桥（message_agent 投递 / 审批询问 → 前端 UI 回执）。
mod pi_engine_bridges;
// 本机屏幕（display.* 的宿主对偶：GDI 截屏 + 最小 RFB WS 服务）。
mod pi_display;
// bot 互发 relay 仓（hermes tools/bot_relay.py 的宿主对偶：跨连接/跨网关
// 投递的持久 envelope 底座，四门 + outbox/claimed/replies 落盘）。
mod pi_relay;
// 跨网关传输（hermes Desktop 的 gateway 客户端对偶：JSON-RPC 2.0 over WS
// /api/ws；remote/cloud/ssh 连接经它拉名册/发 RPC/收事件）。
mod pi_gateway;
// 图像生成（hermes image.generate 的宿主对偶：OpenAI 兼容 images 端点，
// provider/baseUrl/key 走 settings.json + models.json + auth.json）。
mod pi_image;
// petdex 画廊 + 首帧缩略图（hermes pet.gallery / pet.thumb 的宿主对偶）。
mod pi_pet;
mod pi_mcp;
// MCP 预设目录（hermes `optional-mcps/` 的宿主可执行子集；见 pi_mcp_catalog.rs
// 头注：rpi-mcp-adapter 不支持 OAuth，只收 no-auth HTTP 条目）。
mod pi_mcp_catalog;
// MCP OAuth（标准 DCR + PKCE；宿主对偶 hermes mcp_oauth_manager）。
mod pi_mcp_oauth;
// 本地技能目录（hermes optional-skills 的宿主复制；skills.manage 的搜索/安装面）。
mod pi_skills_catalog;
// pi 扩展的加载面（2026-11-02）：照 pi CLI 的做法用 ResourceLoader 解析
// 扩展路径并交给会话。此前宿主恒传空 extension_paths，pi::extensions 的
// 整套能力（工具注册/斜杠命令/事件钩子）在宿主里等于不存在。
mod pi_extensions;
// 定时任务（cron）——**自包含模块**：存储 / 调度解析 / tick 循环 / 执行 /
// IPC 面全在 pi_cron.rs 里，不散进既有模块（可整体摘除）。模块头有
// "为什么不是 pi 扩展"的事实核查与对 hermes cron/ 的语义对照表。
mod pi_connections;
// 定时任务（cron）——**自包含模块**：存储 / 调度解析 / tick 循环 / 执行 /
// IPC 面全在 pi_cron.rs 里，不散进既有模块（可整体摘除）。模块头有
// "为什么不是 pi 扩展"的事实核查与对 hermes cron/ 的语义对照表。
mod pi_cron;

// pi 包管理 IPC（多环境插件 mirach-pkg 的数据面）：直调 vendored
// PackageManager 的 blocking 面（install/remove/update/list）。
mod pi_pkg;
// GPT-Live 全双工语音桥（hermes tools/voice_live.py 等价面）：status + SDP
// 交换端点——key 永不进前端（2026-11-11，用户"复制hermes moss live 桥接层"）
mod pi_voice_live;
// MOSS Live 桥（模思智能 moss.cn 的 WSS 实时语音——wss://api.mosi.cn/
// v1/realtime，握手头持 key；事件/音频经 emit 广播，2026-11-12）
mod pi_voice_moss;

// 宿主侧模型目录（models.dev 镜像）：rpi 没有内置 registry，contextWindow
// 只来自 models.json；这里补一份公开目录，list_models/会话构建时回填 0。
mod model_registry;

// 会话管理元数据持久化真相层（session_meta.rs 模块头有生产级裁定）：
// pinned/archived/水位/折叠存 app_data_dir/session-meta.json（原子写）
mod session_meta;

// 跨工作区会话索引（项目/设置页 P0 数据面）：扫描 settings.sessionDir +
// 已登记项目根 + 当前 cwd，坏文件进 skipped 可见（session_index.rs 模块头
// 有 wire 形状与去重/边界裁定）。纯宿主实现，不改引擎。
mod session_index;

// 终端 PTY 桥（terminal.rs 模块头有事件通道裁定）：终端是系统设施不是
// Agent 数据——输出/退出走 Tauri Event，控制走 IPC invoke
mod terminal;

// 窗口几何存档（window-state.json，hermes 语义：尺寸/位置/最大化记忆）
mod window_state;

// 应用级偏好（2026-11-15）：设置页「常规」里不属于引擎配置的开关——
// 关窗→托盘 / 保持唤醒 / 启动恢复 / 最大步数。真相在进程内（关窗回调
// 要同步读），文件 = app_data_dir/app-prefs.json
mod app_prefs;

// 托管群聊后端（hermes gateway/hosted_room_*.py 的 Rust 移植，2026-11-15）。
// P1 = common（叶子工具）+ store（9 张表 + append-only 事件日志）。
// 分期与边界见 hosted_rooms/mod.rs 头注释；计划见 docs/bots-rust-port-plan.md。
mod hosted_rooms;

// 群聊 IPC 命令面（groups.* 20 个方法 + 讨论规划）。
mod pi_groups;

// 桌面插件运行时（热拔插）：扫描 / 读取 / 写入 / 卸载
// `<app_data_dir>/desktop-plugins/<id>/plugin.js`。渲染层负责 import + 注册。
mod plugin_runtime;

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, WindowEvent,
};

// ── 窗口首屏几何（2026-10-22 照搬 hermes，用户定稿）─────────────────────────
//
// hermes（`apps/desktop/electron/window-state.ts:121-141`）的做法是：窗口
// 尺寸**不是常量**，而是「屏幕工作区 × share，再夹进 [min, max]」：
//   normal:  share 0.88×0.88 · min 1280×820 · max 1760×1100
// 这样 1080p 出 1690×915、1440p 以上撞上限固定 1760×1100、窄屏不会撑出屏。
// 早先这里写死 1800×1000 并在装不下时最大化——那等于把"设计尺寸"当真理，
// 1280 屏幕上干脆吃掉整个工作区，与 hermes 的观感不一致。
//
// 夹取顺序与 hermes 一致：先按 share 算，再 clamp 到 [min, max]，最后再
// `min(…, work_area)` 兜一层（工作区本身比 min 还小时以工作区为准）。
const WINDOW_SHARE_W: f64 = 0.88;
const WINDOW_SHARE_H: f64 = 0.88;
const WINDOW_MIN_W: f64 = 1280.0;
const WINDOW_MIN_H: f64 = 820.0;
const WINDOW_MAX_W: f64 = 1760.0;
const WINDOW_MAX_H: f64 = 1100.0;

/// 任务栏预留（逻辑像素）——`Monitor::work_area` 不可用时的退化估计
const TASKBAR_H: f64 = 48.0;

/// 按 hermes 公式算窗口尺寸（逻辑像素）。`work_w/work_h` = 该屏工作区。
///
/// `min(…, work_area)` 是最后一道：工作区比下限还窄时（极端分辨率/缩放），
/// 按工作区给，不撑出屏幕。
fn hermes_window_size(work_w: f64, work_h: f64) -> (f64, f64) {
    let clamp = |v: f64, lo: f64, hi: f64| v.max(lo).min(hi);
    let w = clamp((work_w * WINDOW_SHARE_W).round(), WINDOW_MIN_W, WINDOW_MAX_W).min(work_w);
    let h = clamp((work_h * WINDOW_SHARE_H).round(), WINDOW_MIN_H, WINDOW_MAX_H).min(work_h);
    (w, h)
}

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
        // 托盘恢复路径显式重设圆角区域（Resized 兜底之外的双保险）
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

/// 窗口外观微调：**直角 + 无描边**，保留系统投影。
///
/// `tauri.conf.json` 的 `decorations: false` + `shadow: true` 会让 Windows 11
/// 给窗口画**系统圆角（约 8px）+ 系统投影 + 1px 描边**。用户的定稿：
///
///   · 圆角不要（"DWM 圆角也不要了，纯原生"）→ `DWMWCP_DONOTROUND`；
///   · 描边不要（"壳的描边去掉"）→ `DWMWA_BORDER_COLOR = COLOR_NONE`；
///   · 投影要（"换回 tauri3 的原生壳 + 阴影"）→ 什么都不做，DWM 照画。
///
/// **`NCRENDERING` 不要动**：改成 `DWMNCRP_DISABLED` 会让渲染退回经典 GDI
/// 路径，系统把 `WS_CAPTION | WS_THICKFRAME` 的完整边框画回来（2026-10-24
/// 实测回归，用户原话"外面怎么套了一个窗口"）。
///
/// 描边实测（2026-10-23）：Win11 给每个顶层窗口画一圈 1px 深灰线
/// （`47,47,47`），**永远按窗口矩形直角走**，压在壳底色 `233,238,239` 之上。
/// 写 `COLOR_NONE` 后同一位置立刻变回壳底色。该属性只写不读
/// （`DwmGetWindowAttribute(34)` 恒返回 `E_INVALIDARG`），所以直接写。
///
/// CSS 侧 `--radius-shell` 已归零（tokens.css），两边一致。
/// Win10 没有这两个属性（设置失败即跳过：那里本来就没有 DWM 圆角/描边）。
#[cfg(windows)]
fn apply_window_chrome(window: &tauri::WebviewWindow) {
    #[link(name = "dwmapi")]
    extern "system" {
        fn DwmSetWindowAttribute(hwnd: isize, attr: u32, value: *const i32, size: u32) -> i32;
    }
    const DWMWA_WINDOW_CORNER_PREFERENCE: u32 = 33;
    const DWMWA_BORDER_COLOR: u32 = 34;
    const DWMWCP_DONOTROUND: i32 = 1;
    /// `DWMWA_COLOR_NONE`（0xFFFFFFFE）：语义正是"不要描边"。
    const COLOR_NONE: i32 = -2;

    let Ok(h) = window.hwnd() else { return };
    let hwnd = h.0 as isize;

    // ① 直角
    let corner = DWMWCP_DONOTROUND;
    if unsafe { DwmSetWindowAttribute(hwnd, DWMWA_WINDOW_CORNER_PREFERENCE, &corner, 4) } != 0 {
        static WARNED: std::sync::Once = std::sync::Once::new();
        WARNED.call_once(|| {
            eprintln!("[win_chrome] DWMWA_WINDOW_CORNER_PREFERENCE 不支持（Win10？）——窗口本来直角");
        });
    }

    // ② 去掉 1px 描边
    let none = COLOR_NONE;
    if unsafe { DwmSetWindowAttribute(hwnd, DWMWA_BORDER_COLOR, &none, 4) } != 0 {
        static WARNED_BORDER: std::sync::Once = std::sync::Once::new();
        WARNED_BORDER.call_once(|| {
            eprintln!("[win_chrome] DWMWA_BORDER_COLOR 不支持（Win10？）——无描边可去");
        });
    }
}

#[cfg(not(windows))]
fn apply_window_chrome(_window: &tauri::WebviewWindow) {}

/// 抹掉窗口顶部那条 1px 深灰线（2026-10-25 用户报"顶部怎么有一条黑线"）。
///
/// ## 现象与归因
///
/// 逐像素实测（`CopyFromScreen`，含 DWM 合成层）：窗口矩形 **T+0 那一行
/// 横贯全宽都是 `32,32,32`**，T+1 起就是壳底色 `233,238,239`；左右下三边
/// 都没有这条线。最大化态同样存在。
///
/// 这是 tao 给 undecorated 窗口做 `WM_NCCALCSIZE` 时的已知副作用：它把
/// 客户区设为窗口矩形，但 DWM 仍会在顶部保留 1px 的框架绘制（`WS_CAPTION`
/// 族样式位在 tao 里是无条件写入的，见 `to_window_styles()`）。
/// `DWMWA_BORDER_COLOR = COLOR_NONE` 管不到它（那是另一套绘制路径）。
///
/// ## 修法
///
/// 子类化 wndproc，在 `WM_NCCALCSIZE` 里把 `rgrc[0].top` **上移 1 个物理
/// 像素**——客户区多吃掉那一行，webview 画布覆盖它，线就看不见了。
/// 其余边不动（它们没有线，多吃会露出画布外的空白）。
///
/// 最大化态额外处理：仍要让出任务栏（沿用 tao 的 `rcWork` 语义）。
#[cfg(windows)]
mod top_line {
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};

    type WndProc = unsafe extern "system" fn(isize, u32, usize, isize) -> isize;

    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    struct Rect {
        left: i32,
        top: i32,
        right: i32,
        bottom: i32,
    }

    #[repr(C)]
    struct NcCalcSizeParams {
        rgrc: [Rect; 3],
        lppos: *mut std::ffi::c_void,
    }

    #[link(name = "user32")]
    extern "system" {
        fn SetWindowLongPtrW(hwnd: isize, index: i32, value: isize) -> isize;
        fn GetWindowLongPtrW(hwnd: isize, index: i32) -> isize;
        fn CallWindowProcW(prev: isize, hwnd: isize, msg: u32, wparam: usize, lparam: isize)
            -> isize;
        fn IsZoomed(hwnd: isize) -> i32;
    }

    const GWLP_WNDPROC: i32 = -4;
    const WM_NCCALCSIZE: u32 = 0x0083;

    /// 每个窗口的原始 wndproc（**按 hwnd 存**，多窗口共用一个槽会互相踩）。
    static ORIGINALS: OnceLock<Mutex<HashMap<isize, isize>>> = OnceLock::new();

    fn originals() -> &'static Mutex<HashMap<isize, isize>> {
        ORIGINALS.get_or_init(|| Mutex::new(HashMap::new()))
    }

    fn original_of(hwnd: isize) -> isize {
        match originals().lock() {
            Ok(g) => g.get(&hwnd).copied().unwrap_or(0),
            Err(e) => {
                eprintln!("[top_line] wndproc 表锁中毒：{e}——本窗口按未安装处理");
                0
            }
        }
    }

    unsafe extern "system" fn hook(hwnd: isize, msg: u32, wparam: usize, lparam: isize) -> isize {
        if msg == WM_NCCALCSIZE && wparam != 0 {
            // 先让 tao 算完（它负责最大化时的任务栏让位）
            let prev = original_of(hwnd);
            let result = if prev == 0 {
                0
            } else {
                CallWindowProcW(prev, hwnd, msg, wparam, lparam)
            };
            // 再把客户区上沿多吃 1px，盖掉 DWM 顶部那条框架线。
            // 最大化态不吃（贴屏边不该有偏移，且那里没有这条线）。
            if IsZoomed(hwnd) == 0 {
                let params = &mut *(lparam as *mut NcCalcSizeParams);
                params.rgrc[0].top -= 1;
            }
            return result;
        }
        let prev = original_of(hwnd);
        if prev == 0 {
            return 0;
        }
        CallWindowProcW(prev, hwnd, msg, wparam, lparam)
    }

    /// 安装（按窗口幂等）。
    pub fn install(hwnd: isize) {
        if original_of(hwnd) != 0 {
            return;
        }
        let hook_ptr: WndProc = hook;
        let prev = unsafe { SetWindowLongPtrW(hwnd, GWLP_WNDPROC, hook_ptr as isize) };
        if prev == 0 {
            eprintln!("[top_line] SetWindowLongPtrW 失败——顶部 1px 线会残留");
            return;
        }
        match originals().lock() {
            Ok(mut g) => {
                g.insert(hwnd, prev);
            }
            Err(e) => {
                eprintln!("[top_line] wndproc 表锁中毒：{e}——已装但无法记录原过程");
            }
        }
        let now = unsafe { GetWindowLongPtrW(hwnd, GWLP_WNDPROC) };
        if now != hook_ptr as isize {
            eprintln!("[top_line] 子类化未生效（wndproc=0x{now:X}）——顶部 1px 线会残留");
        }
    }
}

/// 双屏分辨率不一致：窗口落到装不下它的屏幕时，把尺寸钳制到该屏工作区。
/// 不强制最大化——用户把窗口拖到小屏可能只是临时放一下。
///
/// **最大化态守卫（2026-10-14 实锤修复）**：最大化窗口尺寸 ≈ 工作区
/// （屏高-任务栏），恒大于阈值 → 旧逻辑在最大化后 250ms 防抖触发
/// set_size 把窗口缩小 = 用户看到的"最大化后闪烁回来"。最大化态直接跳过
/// 钳制（它不是"放不下"，它就是工作区本身）。
///
/// 工作区取 `Monitor::work_area()`（系统给的、已排除任务栏）；取不到才退化
/// 到 `size - TASKBAR_H`（hermes 只用 size 减估，我们这里优先用系统值）。
fn monitor_work_area(monitor: &tauri::Monitor) -> (f64, f64) {
    let scale = monitor.scale_factor();
    let area = monitor.work_area();
    let w = area.size.width as f64 / scale;
    let h = area.size.height as f64 / scale;
    if w > 0.0 && h > 0.0 {
        return (w, h);
    }
    let size = monitor.size();
    let w = size.width as f64 / scale;
    let h = size.height as f64 / scale - TASKBAR_H;
    if w <= 0.0 || h <= 0.0 {
        eprintln!("[window] 工作区丈量异常（w={w} h={h}）——跳过钳制");
        return (0.0, 0.0);
    }
    (w, h)
}

fn fit_to_monitor(window: &tauri::WebviewWindow) {
    if window.is_maximized().unwrap_or(false) {
        return;
    }
    let monitor = match window.current_monitor() {
        Ok(Some(m)) => m,
        _ => return,
    };
    let (work_w, work_h) = monitor_work_area(&monitor);
    if work_w <= 0.0 || work_h <= 0.0 {
        return;
    }
    let scale = monitor.scale_factor();
    let Ok(inner) = window.inner_size() else { return };
    let cur_w = inner.width as f64 / scale;
    let cur_h = inner.height as f64 / scale;
    if cur_w > work_w || cur_h > work_h {
        let _ = window.set_size(tauri::LogicalSize::new(cur_w.min(work_w), cur_h.min(work_h)));
    }
}

/// 窗口关闭时的行为。
#[derive(Clone, Copy, PartialEq, Eq)]
enum CloseAction {
    /// 主窗：✕ = 隐藏到托盘（ZCode `closeToTrayOnWindows` 语义）。
    HideToTray,
    /// 设置窗：✕ = 真正销毁（下次从主窗入口重开，不占内存/不出现在 alt-tab）。
    Destroy,
}

/// 窗口通用装配（2026-10-23 多窗口改造：主窗与设置窗共用）。
///
/// 做的事：
///   ① 事件订阅：Resized → 几何落盘；Moved → 跨屏钳制 + 落盘；
///      ScaleFactorChanged → DPI 重算；CloseRequested → 按 `close_action`
///   ② 首屏几何主动落盘（set_size 发生在订阅之前，不会触发回调）
///
/// 窗口外观（无边框 + 系统圆角 + 系统投影）全部由 `tauri.conf.json` 的
/// `decorations: false` / `shadow: true` 决定，Rust 侧不再做任何 DWM 调整
/// （2026-10-25 用户定稿：回到 Tauri 原生壳）。
fn wire_window(app: &tauri::AppHandle, window: &tauri::WebviewWindow, close_action: CloseAction) {
    // 直角 + 无描边，系统投影保留。每个顶层窗口都要调。
    apply_window_chrome(window);
    // 顶部 1px 框架线：客户区上沿多吃 1px 盖掉（见 top_line 模块）。
    #[cfg(windows)]
    if let Ok(h) = window.hwnd() {
        top_line::install(h.0 as isize);
    }

    let win = window.clone();
    let app_for_state = app.clone();
    // 关窗时读应用级偏好（closeToTray）。必须在 setup 里先 manage
    // AppPrefsState，否则这里会拿到 Err——见 setup 开头。
    let app_for_close = app.clone();
    let state_gen = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
    // 用 Arc 包住（`on_window_event` 的回调是 Fn，会被多次调用；直接
    // clone 一个闭包值在 Fn 里是 move-out，E0507）
    let persist: std::sync::Arc<dyn Fn() + Send + Sync> = {
        let win = win.clone();
        let app = app_for_state.clone();
        std::sync::Arc::new(move || persist_window_state(&app, &win))
    };
    let schedule_persist: std::sync::Arc<dyn Fn() + Send + Sync> = {
        let persist = persist.clone();
        let gen = state_gen.clone();
        std::sync::Arc::new(move || {
            let mine = gen.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
            let gen = gen.clone();
            let persist = persist.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(400));
                // 期间又变过 → 让最后一次的定时器去写
                if gen.load(std::sync::atomic::Ordering::SeqCst) != mine {
                    return;
                }
                persist();
            });
        })
    };
    let persist_initial = persist.clone();
    window.on_window_event(move |event| match event {
        WindowEvent::CloseRequested { api, .. } => match close_action {
            CloseAction::HideToTray => {
                // 设置页「常规 / 关闭窗口时隐藏到托盘」的运行时读取点。
                // 偏好缺失（极早关窗竞态）时按既有行为隐藏，但必须留痕——
                // 不静默改行为。
                let to_tray = match app_prefs::close_to_tray(&app_for_close) {
                    Ok(v) => v,
                    Err(e) => {
                        eprintln!("[close-tray] 偏好读取失败，按默认隐藏处理：{e}");
                        true
                    }
                };
                if !to_tray {
                    eprintln!("[close-tray] closeToTray=false → 退出应用");
                    persist();
                    app_for_close.exit(0);
                    return;
                }
                eprintln!("[close-tray] CloseRequested fired, preventing + hiding");
                api.prevent_close();
                // 立即刷存档（防抖窗口内退出不丢几何）
                persist();
                match win.hide() {
                    Ok(_) => eprintln!("[close-tray] tao hide ok"),
                    Err(e) => eprintln!("[close-tray] tao hide ERR: {e}"),
                }
                // tao hide 在 transparent 窗口上不生效（实测），Win32 兜底
                #[cfg(windows)]
                force_hide(&win);
            }
            CloseAction::Destroy => {
                // 设置窗：真关。先刷几何（下次重开还原到同一位置），
                // 然后放行——不 prevent_close，tao 会销毁窗口。
                persist();
            }
        },
        WindowEvent::Resized(_) => {
            // DWM 属性幂等重设：最大化/还原切换、以及系统在尺寸变化后
            // 重算非客户区时，描边与圆角可能被重置回默认（实测失活/激活
            // 会重画）。每次 Resized 重设一遍，微秒级。
            apply_window_chrome(&win);
            schedule_persist();
        }
        WindowEvent::Moved(_) => {
            schedule_persist();
            let w = win.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(250));
                fit_to_monitor(&w);
            });
        }
        WindowEvent::ScaleFactorChanged { .. } => {
            let w = win.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(250));
                fit_to_monitor(&w);
                // DPI 变了 → DWM 属性按新窗口态重设一次（Resized 先到时
                // scale_factor 可能还是旧值，此延迟调用兜底）
                apply_window_chrome(&w);
            });
            schedule_persist();
        }
        _ => {}
    });

    // 首屏几何落盘（2026-10-22）：set_size/set_position 发生在订阅**之前**，
    // 那些变化不会触发 Resized/Moved 回调——首次启动就永远不会有存档
    // （实测）。这里延后一拍主动写一次。
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(600));
        persist_initial();
    });
}

/// 把当前窗口几何写进该窗口的存档（hermes `persistWindowState` 语义）。
///
/// **按窗口 label 分文件**（2026-10-23 多窗口改造）：设置窗与主窗各存各的，
/// 否则关设置窗会把主窗几何覆盖掉。文件名规则见 `window_state::state_path`。
///
/// **最大化/最小化时不存当前 bounds**：最大化尺寸 ≈ 工作区，存下来下次
/// "还原"就变成一个贴满屏的普通窗口；最小化时尺寸是 160×28 这类退化值
/// （Windows 的既有行为）。两种态都只更新 `isMaximized` 标志，尺寸/位置
/// 沿用文件里已有的那份（那是用户最后一次手工调整的形态）。
fn persist_window_state(app: &tauri::AppHandle, window: &tauri::WebviewWindow) {
    let label = window.label();
    let maximized = window.is_maximized().unwrap_or(false);
    let minimized = window.is_minimized().unwrap_or(false);
    let scale = window.scale_factor().unwrap_or(1.0);

    if maximized || minimized {
        // 保留既有几何，只翻标志位
        let mut state = window_state::read_state(app, label).unwrap_or(window_state::WindowState {
            width: window_state::MIN_W,
            height: window_state::MIN_H,
            x: None,
            y: None,
            is_maximized: maximized,
        });
        state.is_maximized = maximized;
        if let Err(e) = window_state::write_state(app, label, &state) {
            eprintln!("[window-state] {label} 写入失败：{e}");
        }
        return;
    }

    let (Ok(size), Ok(pos)) = (window.inner_size(), window.outer_position()) else {
        eprintln!("[window-state] {label} 取窗口几何失败——本次不写");
        return;
    };
    let state = window_state::WindowState {
        width: size.width as f64 / scale,
        height: size.height as f64 / scale,
        x: Some(pos.x as f64 / scale),
        y: Some(pos.y as f64 / scale),
        is_maximized: false,
    };
    if let Err(e) = window_state::write_state(app, label, &state) {
        eprintln!("[window-state] {label} 写入失败：{e}");
    }
}

/// AG-UI 端点发现（端口+token；前端主动拉取，§2.1）
#[tauri::command]
fn get_agui_endpoint(
    state: tauri::State<std::sync::Arc<agui::AguiState>>,
) -> serde_json::Value {
    state.endpoint()
}

// ── 设置独立窗口（2026-10-23，用户："设置页能做成像 ps 一样的，能拖出壳的
//    窗口吗"）─────────────────────────────────────────────────────────────
//
// **为什么是独立顶层窗口而不是浮层**：浮层只能在主窗内浮动，拖不出壳。
// 独立窗口能拖到另一块显示器、alt-tab、独立缩放——这是"像 PS 一样"的全部
// 含义。
//
// **为什么用 Rust 建窗而不是前端 `window.open`**：`window.open` 在 WebView2
// 里会走 Tauri 的 `new_window_req_handler`，弹出来的是不受 Tauri 管理的裸
// WebView2 窗口（没有 IPC、没有 DWM 四步、没有 capabilities）——用不了。
//
// 三个必须做对的地方（每处都是"不做就出 bug"，不是"不做也能跑"）：
//   ① `wire_window`：新窗口要重跑 DWM 四步 + 子类化，否则 Win11 描边黑线
//      回来、画布留边、尺寸逐轮膨胀（这三件事都按窗口生效，无全局开关）；
//   ② `capabilities` 必须放行 `settings` label，否则窗内 `getCurrentWindow()`
//      全报 "not allowed"；
//   ③ `CloseAction::Destroy`：设置窗 ✕ 是真关（不像主窗隐藏到托盘）。
const SETTINGS_LABEL: &str = "settings";

/// 设置窗默认尺寸（逻辑像素）。比弹层（840×70vh）宽一点——独立窗口没有
/// 主窗内容抢焦点，可以给正文更多横向空间；高度用固定值而非 vh（窗口自身
/// 高度就是 vh，用比例会自指）。
const SETTINGS_W: f64 = 960.0;
const SETTINGS_H: f64 = 720.0;
const SETTINGS_MIN_W: f64 = 720.0;
const SETTINGS_MIN_H: f64 = 520.0;

/// 打开（或聚焦）设置独立窗口。
///
/// 已存在则 `show + unminimize + set_focus`（幂等，连点不会开出第二个）——
/// label 唯一是 tauri 的约束，重复 `build()` 会返回 "window already exists"，
/// 这里显式走聚焦分支而不是把那个错误抛给用户。
///
/// `section`（2026-11-18）：深链节（`host.navigate('/settings?tab=gateway')`
/// 的落点）。新窗走 URL 参数；已开着的窗经 `mirach:settings:section` 事件切节
/// （改 URL 会触发整页重载，不可取）。
#[tauri::command(async)]
fn pi_open_settings_window(app: tauri::AppHandle, section: Option<String>) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window(SETTINGS_LABEL) {
        existing.show().map_err(|e| format!("设置窗显示失败：{e}"))?;
        let _ = existing.unminimize();
        existing.set_focus().map_err(|e| format!("设置窗聚焦失败：{e}"))?;
        if let Some(section) = section.as_deref().filter(|s| !s.trim().is_empty()) {
            use tauri::Emitter;
            let _ = app.emit_to(
                SETTINGS_LABEL,
                "mirach:settings:section",
                serde_json::json!({ "section": section.trim() }),
            );
        }
        return Ok(());
    }

    // 深链参数只放行安全字符（节 id 词汇表），避免把任意串塞进 URL。
    let url = match section.as_deref().map(str::trim).filter(|s| {
        !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
    }) {
        Some(section) => format!("index.html?win=settings&section={section}"),
        None => "index.html?win=settings".to_string(),
    };

    let mut builder = tauri::WebviewWindowBuilder::new(
        &app,
        SETTINGS_LABEL,
        tauri::WebviewUrl::App(url.into()),
    )
    .title("设置")
    .inner_size(SETTINGS_W, SETTINGS_H)
    .min_inner_size(SETTINGS_MIN_W, SETTINGS_MIN_H)
    .decorations(false)
    // 与主窗同一套原生外观（2026-10-25 用户定稿）：无标题栏 + 系统圆角
    // 与投影，全部交给 tao/DWM（主窗的对应开关在 tauri.conf.json）。
    .transparent(false)
    .shadow(true)
    // **创建时不显示**（2026-10-26 修"设置页还是跳动"）：builder 的
    // `.inner_size()` 在子类化装好之前执行，必然偏大 14×9；后面还要按存档
    // 重设尺寸/位置。先显示再改 = 用户看到"先闪一个小窗再跳成目标尺寸"。
    // 与主窗同一修法（tauri.conf.json 的 `visible: false`）。
    .visible(false)
    .center();

    // ── browser args 必须与主窗**完全一致**（2026-10-23 实锤）──
    //
    // 不加这段，`build()` 直接失败：
    //   `HRESULT(0x8007139F)` = ERROR_INVALID_STATE（"组或资源的状态不是执行
    //   请求操作的正确状态"）。
    //
    // 根因在 tauri 自己的文档（`webview_window.rs:1098` 原文）：
    //   "Webview instances with different browser arguments must also have
    //    different data directories."
    // 主窗带 `--remote-debugging-port=9223`（tauri.conf.json 的
    // `additionalBrowserArgs`），设置窗不带 → args 不同、data directory 相同
    // （都落 `%LOCALAPPDATA%\com.mirach.harness\EBWebView`）→ WebView2 拒绝。
    //
    // **从主窗的配置读，不在这里硬编码**：硬编码会和 tauri.conf.json 漂移
    // （改一处忘一处 → 又变成"args 不同"的同一个 bug）。
    if let Some(main) = app.get_webview_window("main") {
        if let Some(cfg) = main
            .config()
            .app
            .windows
            .iter()
            .find(|w| w.label == "main")
        {
            if let Some(args) = &cfg.additional_browser_args {
                builder = builder.additional_browser_args(args);
            }
        }
    }

    let window = builder.build().map_err(|e| format!("设置窗创建失败：{e}"))?;

    // ⓪ **DWM + 子类化必须先于任何 set_size**（2026-10-23 实锤：顺序错了
    //    窗口会大一圈）。tao 的 `set_inner_size` 对 undecorated-with-shadow
    //    窗口会加 `window_rect − client_rect` 偏移（`window.rs:249-262`）；
    //    子类化没装时该偏移 = 每边 7-8px，`set_size(960,720)` 实际撑成
    //    976×729（实测）。装完子类化偏移恒为 0，`set_size` 才"设多少是
    //    多少"。主窗 setup 里的 ⓪ 段是同一条纪律。

    // 几何：存档优先（用户拖过的大小/位置要记住），无档则**在这里**显式设
    // 默认尺寸。
    //
    // **为什么无档也要再设一次**：builder 的 `.inner_size(960,720)` 是在
    // `build()` 内部执行的，那时子类化还没装 → tao 带 14×9 偏移 → 实际
    // 976×729（实测）。装完子类化偏移归零，所以必须**重设**才能得到准确的
    // 960×720。这不是冗余，是"builder 那次必然偏大"的补偿。
    let monitor = window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| window.primary_monitor().ok().flatten());
    let work = monitor.as_ref().map(monitor_work_area).unwrap_or((0.0, 0.0));
    let saved = window_state::read_state(&app, SETTINGS_LABEL);
    match &saved {
        Some(state) => {
            let monitors: Vec<(f64, f64, f64, f64)> = window
                .available_monitors()
                .unwrap_or_default()
                .iter()
                .map(|m| {
                    let s = m.scale_factor();
                    let a = m.work_area();
                    (
                        a.position.x as f64 / s,
                        a.position.y as f64 / s,
                        a.size.width as f64 / s,
                        a.size.height as f64 / s,
                    )
                })
                .collect();
            let (w, h, x, y) = window_state::clamp_to_work_area(state, work, &monitors);
            if let Err(e) = window.set_size(tauri::LogicalSize::new(w, h)) {
                eprintln!("[settings-window] 存档尺寸设置失败：{e}");
            }
            if let (Some(x), Some(y)) = (x, y) {
                if let Err(e) = window.set_position(tauri::LogicalPosition::new(x, y)) {
                    eprintln!("[settings-window] 存档位置设置失败：{e}");
                }
            }
        }
        None => {
            if let Err(e) = window.set_size(tauri::LogicalSize::new(SETTINGS_W, SETTINGS_H)) {
                eprintln!("[settings-window] 默认尺寸设置失败：{e}");
            }
            if let Err(e) = window.center() {
                eprintln!("[settings-window] 居中失败：{e}");
            }
        }
    }

    // 事件订阅 + 自检 + 首屏落盘（与主窗同一套，见 wire_window 注释）
    wire_window(&app, &window, CloseAction::Destroy);
    // 几何定好后才显示（见 builder 的 `.visible(false)` 注释）
    window.show().map_err(|e| format!("设置窗显示失败：{e}"))?;
    Ok(())
}

/// 关闭设置窗（前端 ✕ 按钮用）。**真关**，不是隐藏——见 `CloseAction`。
#[tauri::command(async)]
fn pi_close_settings_window(app: tauri::AppHandle) -> Result<(), String> {
    match app.get_webview_window(SETTINGS_LABEL) {
        Some(w) => w.close().map_err(|e| format!("设置窗关闭失败：{e}")),
        // 已关 = 目标态已达成，不是错误
        None => Ok(()),
    }
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

/// 会话时间线标记（模型切换 / 压缩点）：`[{kind, beforeMessageIndex, …}]`，
/// 索引与 `pi_get_messages` 的消息下标对齐。渲染层据此插分隔线
/// （ZCode `timelineMarkerRow` 的宿主投影，见 `PiEngine::timeline_markers`）。
#[tauri::command(async)]
fn pi_get_timeline_markers(
    state: tauri::State<std::sync::Arc<agui::AguiState>>,
) -> Result<serde_json::Value, String> {
    state.engine.timeline_markers()
}

/// 按会话文件路径读历史（**不切活动会话**——双对话分栏的静态投影面板用，
/// 并排各显各的会话）。pi 会话文件 = 追加式 JSONL：条目带 id/parentId 成
/// 链，当前叶 = 最新条目（pi 只在叶后追加）。沿叶回溯取当前分支上
/// type=="message" 条目的 message 值——形状与 pi_get_messages 一致（前端
/// hydratePiMessages 直用）。活动会话的文件可能带锁（SessionPersistence），
/// 读失败原样报错（错误可见，规矩 12）——静态面板只展示非活动会话，正常
/// 不触锁。
#[tauri::command(rename_all = "camelCase", async)]
fn pi_get_session_messages(path: String) -> Result<serde_json::Value, String> {
    let text = std::fs::read_to_string(&path).map_err(|e| format!("会话文件读取失败 {path}: {e}"))?;
    let mut entries: Vec<serde_json::Value> = Vec::new();
    for line in text.lines() {
        let l = line.trim();
        if l.is_empty() {
            continue;
        }
        // 半行（崩溃尾）跳过——append-only 日志的合法尾部形态
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(l) {
            entries.push(v);
        }
    }
    // 叶子 = 最后一条 **message** 条目，不是文件最后一行：rpi 会话在消息
    // 之后追加 record 条目（assistant_frame / operation_started /
    // operation_finished，都不带 message.parentId 链）。以前取"最后一行"
    // 当叶子 → 链只走到那条 record → 投影出空数组（实测：群聊成员轮次
    // 跑完后 session.resume 读不到任何消息，房间读成"超时静默"）。
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
    let mut cur = leaf_id;
    while let Some(id) = cur {
        match by_id.get(id.as_str()) {
            Some(&i) => {
                let e = &entries[i];
                chain.push(e);
                cur = e.get("parentId").and_then(|v| v.as_str()).map(String::from);
            }
            None => break,
        }
    }
    chain.reverse();
    let msgs: Vec<serde_json::Value> = chain
        .iter()
        .filter(|e| e.get("type").and_then(|v| v.as_str()) == Some("message"))
        .filter_map(|e| e.get("message").cloned())
        .collect();
    Ok(serde_json::Value::Array(msgs))
}

/// 机器人预设会话（左栏「机器人」窗格启动钮）：system_prompt + model +
/// working_directory + enabled_tools 一次性透传 SessionOptions
/// （pi_session.rs create_bot_session；enabledTools = per-bot 工具集选择
/// 的工具名并集——前端从 pi_capabilities 的 toolsets 映射，None = 全局
/// 偏好/默认集）。创建成功后以 bot 名重命名该会话（rename_session
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
    enabled_tools: Option<Vec<String>>,
) -> Result<serde_json::Value, String> {
    state.engine.create_bot_session(
        provider,
        model_id,
        system_prompt,
        cwd,
        enabled_tools,
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

/// 中断 run（thread 可选）：缺省 "main"（工作区 run）；会话分栏传自己的
/// 线程键——side_interrupt 定向 abort 该分栏的 run（不打断主柄/其他分栏）。
#[tauri::command(async)]
fn pi_interrupt(
    state: tauri::State<std::sync::Arc<agui::AguiState>>,
    thread: Option<String>,
) -> Result<(), String> {
    let thread = thread.as_deref().unwrap_or("main");
    if thread == "main" {
        state.engine.interrupt()
    } else {
        state.engine.side_interrupt(thread)
    }
}

/// main lane 是否仍有活动 run（含 RUN_FINISHED 后的收尾窗口）。前端提交
/// 与队列 drain 前先查，busy 就留在本地队列，避免撞
/// "Lane main already has an active run operation"。
#[tauri::command(async)]
fn pi_lane_busy(
    state: tauri::State<std::sync::Arc<agui::AguiState>>,
    thread: Option<String>,
) -> Result<bool, String> {
    // rpi 非 main lane 只读（side_* 全部 unavailable），不作 run 判断。
    if thread.as_deref().is_some_and(|t| t != "main") {
        return Ok(false);
    }
    state.engine.lane_busy()
}

#[tauri::command(async)]
fn pi_list_models(
    state: tauri::State<std::sync::Arc<agui::AguiState>>,
) -> Result<serde_json::Value, String> {
    state.engine.list_models()
}

/// 强制刷新宿主侧模型目录（models.dev）。返回 {count, fetchedAt}；
/// 网络失败 = Err（错误可见，不清空已有缓存）。
#[tauri::command(async)]
async fn pi_refresh_model_registry(
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let count = model_registry::refresh(&app, true).await?;
    let (fetched_at, cached) = model_registry::status();
    Ok(serde_json::json!({
        "count": count,
        "cached": cached,
        "fetchedAt": fetched_at,
    }))
}

// ── 扩展 UI 请求（§4.4 审批/问题卡）：请求经 SSE CUSTOM 到前端卡，
//    应答走 IPC 回灌 oneshot。──

#[tauri::command(async)]
fn pi_pending_approvals(
    state: tauri::State<std::sync::Arc<agui::AguiState>>,
) -> Result<Vec<serde_json::Value>, String> {
    state.engine.pending_approvals()
}

#[tauri::command(rename_all = "camelCase", async)]
fn pi_extension_ui_response(
    state: tauri::State<std::sync::Arc<agui::AguiState>>,
    id: String,
    value: Option<serde_json::Value>,
    cancelled: bool,
) -> Result<(), String> {
    state.engine.extension_ui_response(&id, value, cancelled)
}

// ── 模式切换（2026-11-01 用户："输入框的加号右边加个zcode的切换模式按钮"）──
// 数据面 = pi 原生：ApprovalMode（always-ask/write/yolo）+ plan gate
// （Planning 态拒变更、submit_plan 提交、宿主批准/驳回）。语义见
// pi_session.rs「模式切换」段注释。

#[tauri::command(async)]
fn pi_mode_state(
    state: tauri::State<std::sync::Arc<agui::AguiState>>,
) -> Result<serde_json::Value, String> {
    state.engine.mode_state()
}

/// 目标态（活动面板「目标」分区）：rpi-goal 的 `goal-state` 会话条目。
#[tauri::command(async)]
fn pi_goal_state(
    state: tauri::State<std::sync::Arc<agui::AguiState>>,
) -> Result<serde_json::Value, String> {
    state.engine.goal_state()
}

/// 会话计划目录（活动面板「会话计划」分区）：当前分支上有 plan 文本的
/// `plan-mode` 条目（rpi-plan-mode 每次 plan_mode_complete 追加一条，
/// plan = 完整 markdown）。按 seq 降序返回 `[{entryId, seq, timestamp, plan}]`。
#[tauri::command(async)]
fn pi_plan_entries(
    state: tauri::State<std::sync::Arc<agui::AguiState>>,
) -> Result<serde_json::Value, String> {
    state.engine.plan_entries()
}

/// 执行扩展 slash command（`/plan start|exit` 等）——与 rpi-cli RPC 的
/// `execute_command` 同一 handler 契约；模式芯片据此真的进入/退出计划模式
/// （计划态下插件只放行 read/bash/docs/plan_mode_complete，write/edit 被拒）。
#[tauri::command(rename_all = "camelCase", async)]
fn pi_run_command(
    state: tauri::State<std::sync::Arc<agui::AguiState>>,
    command: String,
    args: Option<String>,
) -> Result<serde_json::Value, String> {
    state
        .engine
        .run_command(&command, args.as_deref().unwrap_or(""))
}

#[tauri::command(rename_all = "camelCase", async)]
fn pi_set_approval_mode(
    state: tauri::State<std::sync::Arc<agui::AguiState>>,
    mode: String,
) -> Result<(), String> {
    state.engine.set_approval_mode(&mode)
}

#[tauri::command(rename_all = "camelCase", async)]
fn pi_set_plan_mode(
    state: tauri::State<std::sync::Arc<agui::AguiState>>,
    enabled: bool,
) -> Result<(), String> {
    state.engine.set_plan_mode(enabled)
}

#[tauri::command(rename_all = "camelCase", async)]
fn pi_decide_plan(
    state: tauri::State<std::sync::Arc<agui::AguiState>>,
    approve: bool,
) -> Result<(), String> {
    state.engine.decide_plan(approve)
}

// ── 会话持久化（§7-4 侧栏 sessions：对话真相在 pi，前端只持镜像）──

#[tauri::command(async)]
fn pi_list_sessions(
    state: tauri::State<std::sync::Arc<agui::AguiState>>,
) -> Result<serde_json::Value, String> {
    state.engine.list_sessions()
}

/// 跨根会话索引（设置页 / 会话管理的 P0 数据面）。
///
/// 扫描根 = `settings.sessionDir` + 每个**未软删项目**的
/// `<root>/.rpi/sessions` + 当前 cwd 的默认会话根（去重见 session_index.rs）。
/// 与 `pi_list_sessions` 并存：后者行为/形状不变，旧调用方零影响。
///
/// 入参（camelCase，均可选）：
/// - `projectId`: 只返回归属该项目的会话（显式 sessionProjects 优先，否则
///   按 cwd 落在项目根内推断；项目不存在 → Err）
/// - `archived`: `true` 只返回 `session_meta.archived` 里的会话；`false`
///   排除归档；缺省 = 不过滤（前端可自行决定）
///
/// 返回形状（完整注释见 `session_index.rs` 模块头）：
/// `{ sessions: [{id,path,cwd,name,messageCount,lastModified,
///   parentSessionId,projectId,sourceRoot,source}],
///   skipped: [{path,root,reason}], roots: [{path,kind,exists,error?}] }`
#[tauri::command(rename_all = "camelCase", async)]
fn pi_sessions_index(
    app: tauri::AppHandle,
    state: tauri::State<'_, std::sync::Arc<agui::AguiState>>,
    meta_state: tauri::State<'_, session_meta::SessionMetaPath>,
    project_id: Option<String>,
    archived: Option<bool>,
) -> Result<serde_json::Value, String> {
    use std::collections::HashSet;

    let meta = session_meta::read_for(&app, &meta_state)?;
    let projects = meta.projects();
    if let Some(id) = project_id.as_deref() {
        if !projects.iter().any(|project| project.id == id) {
            return Err(format!("项目 {id} 不存在"));
        }
    }
    // 只有活跃项目的根参与扫描；软删项目的会话仍可通过显式映射/全部列表
    // 看到，但不再「顺着根」被重新发现（回收站语义）。
    let project_roots: Vec<String> = projects
        .iter()
        .filter(|project| project.deleted_at.is_none())
        .flat_map(|project| project.roots.iter().cloned())
        .collect();

    let scan = state.engine.index_sessions(&project_roots)?;
    let explicit = meta.session_projects_map();
    let archived_ids: HashSet<&str> = meta.archived.iter().map(String::as_str).collect();
    // cwd 归属推断用解析后的绝对根（注册表允许相对路径；扫描侧也按同一
    // 基准解析，否则相对根永远匹配不上会话 header 里的绝对 cwd）。
    let cwd = state.engine.workspace_cwd();
    let resolved_projects: Vec<session_meta::Project> = projects
        .iter()
        .map(|project| {
            let mut project = project.clone();
            project.roots = project
                .roots
                .iter()
                .map(|root| {
                    session_index::resolve_session_path(
                        std::path::Path::new(root),
                        &cwd,
                    )
                    .to_string_lossy()
                    .into_owned()
                })
                .collect();
            project
        })
        .collect();
    let session_index::IndexScan {
        sessions: records,
        skipped,
        roots,
    } = scan;

    let mut sessions = Vec::new();
    for mut record in records {
        let project = session_index::project_for_session(
            &resolved_projects,
            &explicit,
            &record.id,
            &record.cwd,
        );
        if let Some(filter) = project_id.as_deref() {
            if project.as_deref() != Some(filter) {
                continue;
            }
        }
        let is_archived = archived_ids.contains(record.id.as_str());
        match archived {
            Some(true) if !is_archived => continue,
            Some(false) if is_archived => continue,
            _ => {}
        }
        record.project_id = project;
        sessions.push(record);
    }

    serde_json::to_value(session_index::IndexScan {
        sessions,
        skipped,
        roots,
    })
    .map_err(|e| format!("会话索引序列化失败: {e}"))
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
/// （跳过历史重放——会话历史经 pi_get_messages 水合）。thread 可选：
/// 缺省 "main"（工作区流）；会话分栏按自己的线程键查（v7.4 双对话分栏）。
#[tauri::command(async)]
fn pi_stream_cursor(
    state: tauri::State<std::sync::Arc<agui::AguiState>>,
    thread: Option<String>,
) -> Result<u64, String> {
    Ok(state.latest_seq(thread.as_deref().unwrap_or("main")))
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
    app: tauri::AppHandle,
    state: tauri::State<std::sync::Arc<agui::AguiState>>,
    path: String,
) -> Result<(), String> {
    use tauri::Emitter;
    // `session.reclaimed` 生产者：删除 = 该运行时会话确实不存在了。插件
    // （hermes-bots plugin.tsx）据此刷新打开的 bot canonical chat。先按
    // path 在索引里定位 stored id（发的必须是插件认识的 id，不猜）。
    let stored_id = state.engine.list_sessions().ok().and_then(|value| {
        value.as_array().and_then(|rows| {
            rows.iter()
                .find(|row| row.get("path").and_then(|p| p.as_str()) == Some(path.as_str()))
                .and_then(|row| row.get("id").and_then(|id| id.as_str()).map(str::to_string))
        })
    });
    state.engine.delete_session(&path)?;
    match stored_id {
        Some(stored_session_id) => {
            let _ = app.emit(
                "mirach:plugin:session:reclaimed",
                serde_json::json!({
                    "stored_session_id": stored_session_id,
                    "path": path,
                    "reason": "deleted",
                }),
            );
        }
        None => eprintln!(
            "[sessions] delete {path}: 索引里定位不到 stored id——session.reclaimed 未发（如实，不编 id）"
        ),
    }
    Ok(())
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

// ── 活动面板数据面（对话栏右上角 ConversationStatusPanel）──────────────
// 子代理名册与后台任务列表：pi 进程级 registry 直接拉（不依赖模型调
// hub/jobs 工具）。缺 data 概念（workflow run / goal）见 docs/engine-gaps.md。

/// 子代理名册：`agent_hub::registry().roster()` → `ChildEntry[]`
/// （id/name/kind/task/pid/status/startedMs/finishedMs/outputBytes/...）。
/// 无活动会话 = 空名册（registry 与会话解耦）。
#[tauri::command(async)]
fn pi_hub_roster(
    state: tauri::State<std::sync::Arc<agui::AguiState>>,
) -> Result<serde_json::Value, String> {
    state.engine.hub_roster()
}

/// 后台 bash 任务列表：`jobs::list(ownerSessionId)` → `JobSnapshot[]`。
/// 无活动会话 = 空列表（任务无从归属）。
#[tauri::command(async)]
fn pi_job_list(
    state: tauri::State<std::sync::Arc<agui::AguiState>>,
) -> Result<serde_json::Value, String> {
    state.engine.job_list()
}

/// 子代理名册（活动面板「智能体」分区真值）：引擎 host 的 ChildAgents
/// registry（delegate_task 的 in-memory 子会话），行 = childId/status/
/// turns/startedMs/finishedMs/role/taskPreview/error。
#[tauri::command(async)]
fn pi_child_agents(
    state: tauri::State<std::sync::Arc<agui::AguiState>>,
) -> Result<serde_json::Value, String> {
    state.engine.child_agent_roster()
}

/// 停止一个运行中的子代理（面板「智能体」行的 Stop）。
#[tauri::command(rename_all = "camelCase", async)]
fn pi_child_agent_stop(
    state: tauri::State<std::sync::Arc<agui::AguiState>>,
    child_id: String,
) -> Result<serde_json::Value, String> {
    state.engine.child_agent_stop(&child_id)
}

/// 待办状态（活动面板 Todo 分区拉取面）：重放会话 Custom `todo_list.v1`
/// 条目（docs/engine-gaps.md G2 过渡方案——不需要上游暴露 Agent 上的
/// plan_state）。返回 `{schema, list, summary}`；无 todo = schema null。
#[tauri::command(async)]
fn pi_todo_state(
    state: tauri::State<std::sync::Arc<agui::AguiState>>,
) -> Result<serde_json::Value, String> {
    state.engine.todo_state()
}

/// 终止一个子代理（活动面板 Stop）：`agent_hub::registry().mark_killed(id)`。
/// id 不存在 = Err（不静默成功）。
#[tauri::command(rename_all = "camelCase", async)]
fn pi_hub_kill(
    state: tauri::State<std::sync::Arc<agui::AguiState>>,
    agent_id: String,
) -> Result<serde_json::Value, String> {
    state.engine.hub_kill(&agent_id)
}

/// 取消一个后台 bash 任务（活动面板 Stop）：`jobs::cancel_async(owner, id)`
/// （等结算，pi 内部超时即 Err）。
#[tauri::command(rename_all = "camelCase", async)]
fn pi_job_cancel(
    state: tauri::State<std::sync::Arc<agui::AguiState>>,
    job_id: String,
) -> Result<serde_json::Value, String> {
    state.engine.job_cancel(&job_id)
}

/// 手动压缩（pi `AgentSessionHandle::compact`）。压缩进度经常驻 AG-UI
/// 流的 CUSTOM name=compaction 到达前端——本命令只触发，不转发事件。
#[tauri::command(async)]
fn pi_compact(
    state: tauri::State<std::sync::Arc<agui::AguiState>>,
) -> Result<serde_json::Value, String> {
    state.engine.compact()
}

/// 撤销 / 重做文件改动（pi 会话级 FileMutationRecorder）。
/// kind = "undo" | "redo"；n = 步数；force = 冲突时强制覆盖。
#[tauri::command(rename_all = "camelCase", async)]
fn pi_undo_redo(
    state: tauri::State<std::sync::Arc<agui::AguiState>>,
    kind: String,
    n: usize,
    force: bool,
) -> Result<serde_json::Value, String> {
    state.engine.undo_redo(&kind, n, force)
}

/// 撤销历史（可撤销单元清单 + 统计）。
#[tauri::command(async)]
fn pi_undo_history(
    state: tauri::State<std::sync::Arc<agui::AguiState>>,
) -> Result<serde_json::Value, String> {
    state.engine.undo_history()
}

/// ask 工具的挂起问题（交互卡）。形状：`[{id, questions:[{id?,question,
/// header?,options:[{label,description?}],recommended?,multi}]}]`——与审批卡片
/// 同款：详情以 Rust 注册表为真相，流上只有 id 信号。
#[tauri::command(async)]
fn pi_ask_pending(
    state: tauri::State<std::sync::Arc<agui::AguiState>>,
) -> Result<serde_json::Value, String> {
    state.engine.refresh_ask_pending()?;
    Ok(serde_json::Value::Array(state.asks.list()))
}

/// 应答 ask 问题。
///
/// rpi 的提问能力来自插件 `rpi-ask-user` 的工具 `ask_user`（本机已装：
/// `~/.rpi/agent/extensions/rpi_ask_user.dll`）。实现 = `rpi-extensions`
/// 的 `UiDialogMailbox`（runtime action 17）：`session::build` 的
/// `ReloadContext.ui_dialog` 就是会话级邮箱，宿主 build 后立即 attach
/// （没有交互 UI 时上游拒绝 "ask_user requires an interactive UI"）。
/// 本命令把前端逐题应答映射成插件 `answer_values` 认识的
/// `{values|value|text}` 形状后 `respond`；dismissed → `cancel`。
#[tauri::command(rename_all = "camelCase", async)]
fn pi_ask_response(
    state: tauri::State<std::sync::Arc<agui::AguiState>>,
    id: String,
    answers: Vec<pi_session::AskAnswerWire>,
    dismissed: bool,
) -> Result<(), String> {
    state.engine.ask_response(&id, &answers, dismissed)
}

/// 子代理 transcript（活动面板 TaskCard 展开）：pi `transcript_page`。
#[tauri::command(rename_all = "camelCase", async)]
fn pi_hub_transcript(
    state: tauri::State<std::sync::Arc<agui::AguiState>>,
    agent_id: String,
) -> Result<serde_json::Value, String> {
    state.engine.hub_transcript(&agent_id)
}

/// 给子代理发消息（steer）：pi `registry.steer`。
#[tauri::command(rename_all = "camelCase", async)]
fn pi_hub_send(
    state: tauri::State<std::sync::Arc<agui::AguiState>>,
    agent_id: String,
    body: String,
) -> Result<serde_json::Value, String> {
    state.engine.hub_send(&agent_id, &body)
}

/// 子代理 inbox（operator→child 消息队列）。
#[tauri::command(rename_all = "camelCase", async)]
fn pi_hub_inbox(
    state: tauri::State<std::sync::Arc<agui::AguiState>>,
    agent_id: String,
) -> Result<serde_json::Value, String> {
    state.engine.hub_inbox(&agent_id)
}

fn main() {
    // pi 会话持久化：strict = 每条消息即时落盘并进索引（会话列表/重命名/
    // 删除立即可见；默认 balanced 是定时 autosave，列表会延迟出现且
    // rename 可能撞未落盘文件的锁）。桌面壳本地 JSONL append 开销可忽略。
    std::env::set_var("PI_SESSION_DURABILITY_MODE", "strict");

    tauri::Builder::default()
        .setup(|app| {
            let window = app.get_webview_window("main").expect("main window");
            // ── 应用级偏好最先进状态 ──
            // 关窗回调（wire_window）要同步读 closeToTray；保持唤醒的专用
            // 线程也在这里起步。文件损坏 → setup 失败（不静默重置）。
            app.manage(app_prefs::init(app.handle())?);
            // 引擎侧宿主桥：message_agent 投递门 + 审批闸门（先装门，再建会话）。
            pi_engine_bridges::install(app.handle());
            // 本机屏幕 RFB 服务（随机端口；前端经 pi_display_ws_port 读）。
            pi_display::start_server();
            // `gateway.ready` 的生产者（本地网关恒就绪）：canonical workspace 在
            // 该事件上重拉 rooms 状态（hermes 网关 accept 后必发同款帧）。
            let _ = app
                .handle()
                .emit("mirach:plugin:gateway:ready", serde_json::json!({ "connectionId": "local" }));
            // 宿主侧模型目录：先同步载入磁盘缓存（不阻塞 UI），再后台拉取
            // models.dev（TTL 24h；失败只记日志，沿用缓存/空目录）。
            model_registry::init(app.handle());
            {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = model_registry::refresh(&handle, false).await {
                        eprintln!("[model-registry] 刷新失败（沿用缓存）: {e}");
                    }
                });
            }
            // ── ⓪ **最先**设 DWM 外观，再动几何 ──
            //
            // `apply_window_chrome`（直角 + 无描边）必须**尽早**调用：
            // 窗口创建时 DWM 已经按系统默认画上圆角与描边，晚一帧设置就会
            // 出现"先看到圆角、再跳成直角"的视觉跳变（2026-10-26 用户报）。
            // 这里在 setup 的第一行调用，配合 `tauri.conf.json` 的
            // `visible: false`，用户看到的第一帧就是最终形态。
            //
            // 顺序要求（2026-10-23 实测的累积膨胀 bug）：tao 的
            // `set_inner_size` 对 undecorated-with-shadow 窗口会加上
            // `window_rect − client_rect` 的偏移（`window.rs:249-262`）。
            // 子类化没装时这个偏移 = 每边 7-8px（14×9）；`set_size` 于是
            // 把窗口撑大一圈，而 `inner_size()` 读的又是撑大后的客户区 →
            // 存档每轮 +16×9（实测 1760 → 1824 → 1872）。
            // 装完子类化后 client == window_rect，偏移恒为 0，`set_size`
            // 才是"设多少就是多少"。所以这里必须早于下面的 set_size。
            apply_window_chrome(&window);
            #[cfg(windows)]
            if let Ok(h) = window.hwnd() {
                top_line::install(h.0 as isize);
            }
            // ── 首屏几何：**存档优先，公式兜底**（hermes window-state 语义）──
            // 有 window-state.json 就用上次的尺寸/位置/最大化态（用户拖过的
            // 大小要记住）；没有 / 坏档 / 坐标已不在任何屏幕上，才回落到
            // "工作区 × 0.88 夹到 1280×820~1760×1100" 的比例公式。
            let monitor = window
                .current_monitor()
                .ok()
                .flatten()
                .or_else(|| window.primary_monitor().ok().flatten());
            let work = monitor.as_ref().map(monitor_work_area).unwrap_or((0.0, 0.0));
            let saved = window_state::read_state(app.handle(), window.label());
            let mut restored_maximized = false;
            if let Some(state) = &saved {
                let monitors: Vec<(f64, f64, f64, f64)> = window
                    .available_monitors()
                    .unwrap_or_default()
                    .iter()
                    .map(|m| {
                        let s = m.scale_factor();
                        let a = m.work_area();
                        (
                            a.position.x as f64 / s,
                            a.position.y as f64 / s,
                            a.size.width as f64 / s,
                            a.size.height as f64 / s,
                        )
                    })
                    .collect();
                let (w, h, x, y) = window_state::clamp_to_work_area(state, work, &monitors);
                if let Err(e) = window.set_size(tauri::LogicalSize::new(w, h)) {
                    eprintln!("[window] 存档尺寸设置失败：{e}");
                }
                match (x, y) {
                    (Some(x), Some(y)) => {
                        if let Err(e) = window.set_position(tauri::LogicalPosition::new(x, y)) {
                            eprintln!("[window] 存档位置设置失败：{e}");
                        }
                    }
                    _ => {
                        // 坐标不可用（首次启动 / 屏幕变了）→ 居中
                        if let Err(e) = window.center() {
                            eprintln!("[window] 首屏居中失败：{e}");
                        }
                    }
                }
                restored_maximized = state.is_maximized;
            } else if work.0 > 0.0 && work.1 > 0.0 {
                let (w, h) = hermes_window_size(work.0, work.1);
                if let Err(e) = window.set_size(tauri::LogicalSize::new(w, h)) {
                    eprintln!("[window] 首屏尺寸设置失败：{e}");
                }
                // 尺寸变了要重新居中（conf 的 center 是在旧尺寸下算的）
                if let Err(e) = window.center() {
                    eprintln!("[window] 首屏居中失败：{e}");
                }
            }
            // 最大化态最后恢复（要在尺寸/位置定好之后，否则会被 set_size 抹掉）
            if restored_maximized {
                if let Err(e) = window.maximize() {
                    eprintln!("[window] 恢复最大化失败：{e}");
                }
            }
            // 圆角区域再设一次：`maximize()` 会改 NC 状态，上面 ⓪ 那次是
            // 几何设定前的（见该处注释）。两处都幂等。
            //
            // 之后的事件订阅 + 自检 + 首屏落盘统一走 wire_window——设置窗
            // 复用同一套（**每个新顶层窗口都必须调它**，否则黑线与尺寸膨胀
            // 会在新窗口上原样复现，见该函数注释）。
            wire_window(app.handle(), &window, CloseAction::HideToTray);

            // **最后才显示窗口**（2026-10-26 修"启动先小后大跳一下"）：
            // `tauri.conf.json` 里 `visible: false` —— 窗口以 1280×820 创建
            // 但不显示；上面按存档/公式定好尺寸与位置后才 show，用户看到
            // 的第一帧就是最终几何。不设 visible:false 时会先闪一个 1280×820
            // 的小窗再跳到目标尺寸（用户报的"跳跃"）。
            window.show().map_err(|e| format!("主窗显示失败：{e}"))?;

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

            // 定时任务 ticker（pi_cron.rs）：60s 一轮，独立 std 线程
            // （pi 的 future 不能进 tokio——pi_session.rs:4 纪律）。
            // 幂等：已在跑则返回 false，不启第二个。
            if !pi_cron::init_ticker() {
                eprintln!("[cron] ticker 已在运行，跳过重复启动");
            }
            Ok(())
        })
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            get_agui_endpoint,
            app_prefs::app_prefs_get,
            app_prefs::app_prefs_set,
            app_prefs::app_keep_awake_run,
            pi_open_settings_window,
            pi_close_settings_window,
            pi_get_state,
            pi_get_messages,
            pi_get_timeline_markers,
            pi_get_session_messages,
            pi_connections::pi_connections_list,
            pi_connections::pi_connections_save,
            pi_connections::pi_connections_remove,
            pi_connections::pi_connections_set_primary,
            pi_connections::pi_connections_test,
            pi_pkg::pi_pkg_list,
            pi_pkg::pi_pkg_install,
            pi_pkg::pi_pkg_remove,
            pi_pkg::pi_pkg_update,
            pi_voice_live::pi_voice_live_status,
            pi_voice_live::pi_voice_live_session,
            pi_voice_live::pi_voice_live_set_config,
            pi_voice_moss::pi_voice_moss_open,
            pi_voice_moss::pi_voice_moss_send_text,
            pi_voice_moss::pi_voice_moss_send_audio,
            pi_voice_moss::pi_voice_moss_close,
            pi_set_model,
            pi_set_thinking_level,
            pi_interrupt,
            pi_lane_busy,
            plugin_runtime::plugin_runtime_root,
            plugin_runtime::plugin_runtime_scan,
            plugin_runtime::plugin_runtime_read,
            plugin_runtime::plugin_runtime_write,
            plugin_runtime::plugin_runtime_uninstall,
            pi_list_models,
            pi_refresh_model_registry,
            pi_pending_approvals,
            pi_extension_ui_response,
            pi_mode_state,
            pi_goal_state,
            pi_plan_entries,
            pi_run_command,

            pi_groups::groups_dispatch,

            pi_groups::groups_plan,
            pi_set_approval_mode,
            pi_set_plan_mode,
            pi_decide_plan,
            pi_list_sessions,
            pi_sessions_index,
            pi_discard_session,
            pi_new_session,
            pi_create_bot_session,
            pi_bot::pi_bot_create_session,
            pi_bot::pi_bot_open,
            pi_bot::pi_bot_prompt,
            pi_bot::pi_bot_state,
            pi_bot::pi_bot_interrupt,
            pi_bot::pi_bot_interrupt_task,
            pi_bot::pi_bot_take_recovered,
            pi_bot::pi_bot_compact,
            pi_bot::pi_bot_attach_image,
            pi_bot::pi_bot_attach_file,
            pi_bot::pi_bot_clarify_lock,
            pi_bot::pi_bot_approval_respond,
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
            pi_hub_roster,
            pi_job_list,
            pi_child_agents,
            pi_child_agent_stop,
            pi_todo_state,
            pi_hub_kill,
            pi_job_cancel,
            pi_compact,
            pi_undo_redo,
            pi_undo_history,
            pi_ask_pending,
            pi_ask_response,
            pi_hub_transcript,
            pi_hub_send,
            pi_hub_inbox,
            pi_settings::pi_get_settings,
            pi_settings::pi_set_settings,
            pi_settings::pi_get_models_config,
            pi_settings::pi_set_models_config,
            pi_settings::pi_auth_status,
            pi_keys::pi_set_provider_key,
            pi_keys::pi_delete_provider_key,
            pi_keys::pi_engine_version,
            pi_keys::pi_notify_test,
            pi_vault::pi_vault_list,
            pi_vault::pi_vault_add,
            pi_vault::pi_vault_remove,
            pi_vault::pi_vault_reveal,
            pi_login::pi_oauth_providers,
            pi_login::pi_oauth_start,
            pi_login::pi_oauth_status,
            pi_login::pi_endpoint_validate,
            pi_login::pi_discover_models,
            pi_login::pi_vault_sources,
            pi_resources::pi_list_resources,
            pi_persona::pi_persona_read,
            pi_persona::pi_persona_write,
            pi_persona::pi_persona_reset,
            pi_usage::pi_usage_snapshot,
            pi_capabilities::pi_capabilities,
            pi_capabilities::pi_set_skill_enabled,
            pi_capabilities::pi_set_toolset_enabled,
            pi_capabilities::pi_read_skill,
            pi_capabilities::pi_write_skill,
            pi_capabilities::pi_delete_skill,
            pi_capabilities::pi_validate_skill,
            pi_mcp::pi_mcp_servers,
            pi_mcp::pi_mcp_upsert_server,
            pi_mcp::pi_mcp_remove_server,
            pi_mcp::pi_mcp_test_server,
            pi_mcp::pi_mcp_set_api_key,
            pi_mcp::pi_bot_mcp_config,
            pi_mcp_catalog::pi_mcp_catalog,
            pi_mcp_catalog::pi_mcp_install_preset,
            pi_mcp_oauth::pi_mcp_oauth_complete,
            pi_mcp_oauth::pi_mcp_oauth_refresh,
            pi_mcp_oauth::pi_mcp_oauth_refresh_all,
            pi_engine_bridges::pi_agent_message_ack,
            pi_engine_bridges::pi_approval_decision,
            pi_display::pi_display_status,
            pi_display::pi_display_ws_port,
            pi_display::pi_display_thumbnail,
            pi_display::pi_display_observe,
            pi_display::pi_display_start,
            pi_display::pi_display_lease_acquire,
            pi_display::pi_display_lease_release,
            pi_relay::pi_relay_enqueue,
            pi_relay::pi_relay_roster_sync,
            pi_relay::pi_relay_drain,
            pi_relay::pi_relay_reply,
            pi_relay::pi_relay_record_receipt,
            pi_relay::pi_relay_get_receipt,
            pi_gateway::pi_gateway_connect,
            pi_gateway::pi_gateway_disconnect,
            pi_gateway::pi_gateway_status,
            pi_gateway::pi_gateway_call,
            pi_image::pi_image_generate,
            pi_pet::pi_pet_gallery,
            pi_pet::pi_pet_thumb,
            pi_skills_catalog::pi_skills_search,
            pi_skills_catalog::pi_skill_install,
            pi_skills_catalog::pi_skill_remove,
            pi_extensions::pi_extensions,
            pi_cron::pi_cron_jobs,
            pi_cron::pi_cron_job,
            pi_cron::pi_cron_create,
            pi_cron::pi_cron_update,
            pi_cron::pi_cron_pause,
            pi_cron::pi_cron_resume,
            pi_cron::pi_cron_trigger,
            pi_cron::pi_cron_delete,
            pi_cron::pi_cron_blueprints,
            pi_cron::pi_cron_instantiate_blueprint,
            fs::fs_list,
            fs::fs_git_root,
            fs::fs_git_diff_stat,
            fs::fs_git_review_list,
            fs::fs_git_review_diff,
            fs::fs_git_stage,
            fs::fs_git_unstage,
            fs::fs_git_revert,
            fs::fs_git_commit,
            fs::fs_git_push,
            fs::fs_git_branches,
            fs::fs_git_checkout,
            fs::fs_git_ship_info,
            fs::fs_git_rev_parse,
            fs::fs_git_commit_context,
            fs::fs_git_create_pr,
            fs::fs_read_data_url,
            fs::fs_stat,
            fs::attachment_stage,
            fs::fs_write_text_file,
            fs::fs_open_url,
            terminal::terminal_spawn,
            terminal::terminal_reap,
            terminal::terminal_attach,
            terminal::terminal_write,
            terminal::terminal_resize,
            terminal::terminal_kill,
            terminal::terminal_open_url,
            session_meta::session_meta_get,
            session_meta::session_meta_set,
            session_meta::pi_projects_list,
            session_meta::pi_projects_save,
            session_meta::pi_projects_delete,
            session_meta::pi_projects_restore,
            session_meta::pi_projects_reorder
        ])
        .manage(session_meta::SessionMetaPath(std::sync::Mutex::new(None)))
        // 运行时 = wry（WebView2）。CDP 端口不在这里配：wry 走
        // `additionalBrowserArgs`（tauri.conf.json 的
        // `--remote-debugging-port=9223`），dev 冒烟/E2E 用同一端口。
        .runtime(tauri_runtime_wry::Wry::default())
        .build(tauri::generate_context!())
        .expect("error while building mirach-harness")
        .run(|_app, event| {
            // 退出时停 ticker：进程退出会连带杀掉 std 线程，但显式 stop 让
            // "正在跑的 run 有机会走完当前作业的台账写入"这一步更可预期。
            if let tauri::RunEvent::Exit = event {
                pi_cron::shutdown_ticker();
            }
        });
}

#[cfg(test)]
mod window_geometry_tests {
    use super::hermes_window_size;

    // 惯例与她的 hermes 一致：先 share，再 clamp [min,max]，最后 min(工作区)

    #[test]
    fn large_work_area_hits_maximum() {
        // 2560×1440 工作区：0.88 → 2253×1267，都撞上限
        assert_eq!(hermes_window_size(2560.0, 1440.0), (1760.0, 1100.0));
    }

    #[test]
    fn middling_work_area_uses_share() {
        // 1920×1040（1080p 减任务栏）：0.88 → 1690×915，落在 [min,max] 内
        assert_eq!(hermes_window_size(1920.0, 1040.0), (1690.0, 915.0));
    }

    #[test]
    fn small_work_area_hits_minimum() {
        // 1366×728：0.88 → 1202×641，都低于下限 → 抬到 1280×820
        // 但 1280 > 1366? no；820 > 728 → 最后一层 min(工作区) 把高收成 728
        assert_eq!(hermes_window_size(1366.0, 728.0), (1280.0, 728.0));
    }

    #[test]
    fn work_area_below_min_wins() {
        // 1024×600：上下限都撑不住 → 最终以工作区为准，不撑出屏幕
        assert_eq!(hermes_window_size(1024.0, 600.0), (1024.0, 600.0));
    }

    #[test]
    fn exact_min_work_area() {
        // 工作区正好等于下限：0.88 更小 → 抬到下限，且未被 min(工作区) 削
        assert_eq!(hermes_window_size(1280.0, 820.0), (1280.0, 820.0));
    }

    #[test]
    fn share_rounds_to_nearest() {
        // 1601×0.88 = 1408.88 → 1409（.round() 而非截断）
        let (w, _) = hermes_window_size(1601.0, 1000.0);
        assert_eq!(w, 1409.0);
    }
}

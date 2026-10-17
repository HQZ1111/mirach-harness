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

// 会话管理元数据持久化真相层（session_meta.rs 模块头有生产级裁定）：
// pinned/archived/水位/折叠存 app_data_dir/session-meta.json（原子写）
mod session_meta;

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
        // 托盘恢复路径显式重设圆角区域（Resized 兜底之外的双保险）
        #[cfg(windows)]
        win_shape::sync_round_region(&window);
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

/// 窗口圆角物理裁剪（用户 2026-10-15 定稿："tauri壳圆角的地方有黑色的角"
/// + "最底层有个黑的页面"）。根因实锤：CEF windowed 不支持透明绘制
/// （tauri-runtime-cef webview.rs:161 原文——transparent painting exists
/// only in off-screen rendering），页面画布恒不透明、基色 #1F1F1F（实测
/// 四角像素 31,31,31；品红实验证明角落随 html/body 背景走 = 就是页面画布
/// 本身，不是桌面也不是别的窗口）。html/body 必须透明（圆角技巧的前提，
/// base.css 注释有史），所以这块黑永远垫在 .app-shell 底下从圆角外露出。
/// 修复 = SetWindowRgn 物理裁圆（实测四角 31,31,31 → 桌面透出，移除即
/// 复现）；区域必须跟随 resize/DPI；最大化清空（触屏边圆角无意义且会在
/// 屏边露桌面角）；退化尺寸（最小化陷阱 160×28）清空。
#[cfg(windows)]
mod win_shape {
    #[repr(C)]
    struct Rect {
        left: i32,
        top: i32,
        right: i32,
        bottom: i32,
    }

    #[link(name = "user32")]
    extern "system" {
        fn GetWindowRect(hwnd: isize, rect: *mut Rect) -> i32;
        fn SetWindowRgn(hwnd: isize, rgn: isize, redraw: i32) -> i32;
    }

    #[link(name = "gdi32")]
    extern "system" {
        fn CreateRoundRectRgn(l: i32, t: i32, r: i32, b: i32, ew: i32, eh: i32) -> isize;
        fn DeleteObject(obj: isize) -> i32;
    }

    /// 逻辑圆角半径——必须与 base.css `.app-shell { border-radius: 56px }`
    /// 同值（CSS px = 窗口逻辑像素，1:1）。**双处同步**：改这里必须同时改
    /// tokens.css 的 --scale-radius-shell（2026-10-16 阶段 7 由 40 → 56，
    /// 配合内容 inset 8 / 内层 48 的同心几何）。
    const RADIUS_LOGICAL: f64 = 56.0;

    fn clear_region(hwnd: isize) {
        unsafe {
            SetWindowRgn(hwnd, 0, 1);
        }
    }

    /// 依当前窗口态重设圆角区域（幂等）：Resized / DPI 变化 / 托盘恢复均调。
    pub fn sync_round_region(window: &tauri::WebviewWindow) {
        let Ok(h) = window.hwnd() else { return };
        let hwnd = h.0 as isize;
        if window.is_maximized().unwrap_or(false) {
            clear_region(hwnd);
            return;
        }
        let mut r = Rect { left: 0, top: 0, right: 0, bottom: 0 };
        if unsafe { GetWindowRect(hwnd, &mut r) } == 0 {
            return;
        }
        let w = r.right - r.left;
        let h = r.bottom - r.top;
        let scale = window.scale_factor().unwrap_or(1.0);
        let dia = (RADIUS_LOGICAL * 2.0 * scale).round() as i32;
        if w <= dia || h <= dia {
            // 退化尺寸（最小化 160×28 陷阱等）——不裁，恢复尺寸时 Resized 重来
            clear_region(hwnd);
            return;
        }
        let rgn = unsafe { CreateRoundRectRgn(0, 0, w + 1, h + 1, dia, dia) };
        if rgn == 0 {
            return;
        }
        if unsafe { SetWindowRgn(hwnd, rgn, 1) } == 0 {
            // 失败：区域所有权未转移，自行释放；成功则系统接管（勿删）
            unsafe {
                DeleteObject(rgn);
            }
        }
    }
}

/// 双屏分辨率不一致：窗口落到装不下它的屏幕时，把尺寸钳制到该屏工作区。
/// 不强制最大化——用户把窗口拖到小屏可能只是临时放一下。
///
/// **最大化态守卫（2026-10-14 实锤修复）**：最大化窗口尺寸 ≈ 工作区
/// （屏高-任务栏），恒大于 `工作区 - EDGE` 阈值 → 旧逻辑在最大化后
/// 250ms 防抖触发 set_size 把窗口缩小 = 用户看到的"最大化后闪烁回来"。
/// 最大化态直接跳过钳制（它不是"放不下"，它就是工作区本身）；同时
/// 校准阈值 = 工作区本身，普通窗口仅在工作区外才钳。
fn fit_to_monitor(window: &tauri::WebviewWindow) {
    if window.is_maximized().unwrap_or(false) {
        return;
    }
    let monitor = match window.current_monitor() {
        Ok(Some(m)) => m,
        _ => return,
    };
    let scale = monitor.scale_factor();
    let work_w = monitor.size().width as f64 / scale;
    let work_h = monitor.size().height as f64 / scale - TASKBAR_H;
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
    let leaf_id = entries
        .last()
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

#[tauri_runtime_cef::cef_entry_point]
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
            // 圆角区域初设（早于首次 show；最大化态由函数内守卫清空）
            #[cfg(windows)]
            win_shape::sync_round_region(&window);
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
                WindowEvent::Resized(_) => {
                    // 圆角区域跟尺寸（同步，微秒级；统一入口处理最大化/退化尺寸）
                    #[cfg(windows)]
                    win_shape::sync_round_region(&win);
                }
                WindowEvent::Moved(_) => {
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
                        // DPI 变了——圆角直径须跟新 scale 重算（Resized 先到
                        // 时 scale_factor 可能还是旧值，此延迟调用兜底）
                        #[cfg(windows)]
                        win_shape::sync_round_region(&w);
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
            pi_get_session_messages,
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
            pi_hub_roster,
            pi_job_list,
            pi_todo_state,
            pi_hub_kill,
            pi_job_cancel,
            pi_compact,
            pi_undo_redo,
            pi_undo_history,
            pi_settings::pi_get_settings,
            pi_settings::pi_set_settings,
            pi_settings::pi_get_models_config,
            pi_settings::pi_set_models_config,
            pi_settings::pi_auth_status,
            pi_resources::pi_list_resources,
            fs::fs_list,
            fs::fs_git_root,
            fs::fs_git_diff_stat,
            fs::fs_read_data_url,
            fs::fs_write_text_file,
            terminal::terminal_spawn,
            terminal::terminal_write,
            terminal::terminal_resize,
            terminal::terminal_kill,
            terminal::terminal_open_url,
            session_meta::session_meta_get,
            session_meta::session_meta_set
        ])
        .manage(session_meta::SessionMetaPath(std::sync::Mutex::new(None)))
        // CEF 运行时（用户定稿目标）：.runtime 参数与 wry 对称。
        //
        // CDP 9223：**必须走 Cef::remote_debugging(RemoteDebugging::Port)**，
        // 只传 `command_line_arg("remote-debugging-port", …)` 在 release 下
        // 无效——CEF 的 RemoteDebugging 默认 Disabled 且会把
        // `devtools.remote_debugging.allowed` preference 一并钉死，命令行
        // 开关被拒（2026-10-14 实锤：dev 开、release 关）。allowed_origins
        // 留空 = 只允许 localhost（本机冒烟足够）。
        // dev/released 均开：M4 验收后按需收紧（生产要收就删这段）。
        .runtime({
            tauri_runtime_cef::Cef::default().remote_debugging(
                tauri_runtime_cef::RemoteDebugging::Port {
                    port: 9223,
                    allowed_origins: vec![],
                },
            )
        })
        .run(tauri::generate_context!())
        .expect("error while running mirach-harness");
}

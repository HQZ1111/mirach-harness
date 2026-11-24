//! 本机屏幕（Bot Desktop / display.* 的宿主对偶，2026-11-17）。
//!
//! hermes 的 display 是网关侧的虚拟桌面 + RFB 流（`tools/bot_desktop/`）。
//! 宿主没有虚拟桌面，但可以让屏幕面板真实可用：**捕获本机桌面**并经一个
//! 最小 RFB 3.8 服务（WebSocket `/api/display/ws`，ticket 鉴权）推给插件的
//! noVNC 客户端。语义如实标注：这是"本机屏幕"而不是按 profile 隔离的虚拟屏。
//!
//! - `display.status` / `observe` / `thumbnail` / `start` /
//!   `lease.acquire` / `lease.release` 全部真实现（GDI 截屏 + 内存租约）；
//! - ticket 单次使用、30s 过期；lease holder = 首个 acquire 的 viewer_hash，
//!   release 必须带同一 viewer（`force` 可强制回收）；
//! - `display.install*` 无安装流程（宿主不装远程桌面服务）→ 明确报错。
//!
//! 非 Windows 平台：capture 返回 Err，status 如实 supported:false。

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine;
use serde_json::{json, Value};

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn new_id(prefix: &str) -> String {
    format!("{prefix}-{}", uuid::Uuid::new_v4().simple())
}

/// `viewer_hash` = sha256(viewer_id) 的前 12 hex（插件同款）。
fn viewer_hash(viewer_id: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(viewer_id.as_bytes());
    let hex = digest
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    hex.chars().take(12).collect()
}

#[derive(Debug, Clone)]
struct Lease {
    holder: String,
    viewer_hash: String,
    lease_id: String,
    since: i64,
    expires_at: i64,
    epoch: i64,
}

#[derive(Debug, Clone)]
struct Ticket {
    viewer_id: String,
    profile: String,
    expires_at: i64,
}

#[derive(Default)]
struct DisplayState {
    leases: Mutex<HashMap<String, Lease>>,
    tickets: Mutex<HashMap<String, Ticket>>,
    /// 每 profile 的租约序号（单调递增，跨 acquire/release 不重置）——
    /// 上游 DisplayLease.epoch 的语义：客户端用 epoch 丢弃"迟到的旧回复"，
    /// 释放后的 agent 占位租约必须比刚释放的租约 epoch 更大。
    epochs: Mutex<HashMap<String, i64>>,
}

fn state() -> &'static DisplayState {
    static CELL: OnceLock<DisplayState> = OnceLock::new();
    CELL.get_or_init(DisplayState::default)
}

fn next_epoch(profile: &str) -> i64 {
    let mut epochs = state().epochs.lock().expect("display epochs poisoned");
    let next = epochs.get(profile).copied().unwrap_or(0) + 1;
    epochs.insert(profile.to_owned(), next);
    next
}

fn current_lease(profile: &str) -> (Option<Lease>, i64) {
    let leases = state().leases.lock().expect("display leases poisoned");
    let epochs = state().epochs.lock().expect("display epochs poisoned");
    (
        leases.get(profile).cloned(),
        epochs.get(profile).copied().unwrap_or(0),
    )
}

/// 上游契约（gateway-contract DisplayLease）：`lease` 恒为对象，无人持有 =
/// `holder: "agent"`。早前返回 null 会让 screen-pane 的 setScreenLease 在
/// 释放路径上读 `null.epoch` 抛错（UI 卡在"你正在控制"）——2026-11-18 实测修。
fn lease_json(lease: Option<&Lease>, epoch: i64) -> Value {
    match lease {
        Some(lease) => json!({
            "leaseId": lease.lease_id,
            "holder": lease.holder,
            "viewer_id": Value::Null,
            "viewer_hash": lease.viewer_hash,
            "since": lease.since,
            "expiresAt": lease.expires_at,
            "epoch": lease.epoch,
        }),
        None => json!({
            "leaseId": Value::Null,
            "holder": "agent",
            "viewer_id": Value::Null,
            "viewer_hash": Value::Null,
            "since": now_secs(),
            "expiresAt": Value::Null,
            "epoch": epoch,
        }),
    }
}

fn hostname() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "this-device".into())
}

/// 本机 bot 是否有"机器人屏幕"。
///
/// hermes 的 Bot Screen 是 **Linux 网关主机上的 headless Xfce 虚拟屏**
/// （`tools/bot_desktop/`）；Windows 本机网关没有这块屏，按钮打开后是
/// "此主机没有机器人屏幕 / 此机器人使用主机自身的显示器"。宿主此前把
/// **用户自己的 Windows 桌面**经 GDI 截屏冒充 bot 屏幕，这不是移植语义
/// （用户 2026-11-21 对照 hermes 本机行为后裁定对齐）。默认关闭；保留
/// `MIRACH_HOST_SCREEN=1` 供显式自测，不再作为默认产品面。
fn host_screen_enabled() -> bool {
    std::env::var("MIRACH_HOST_SCREEN")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false)
}

fn status_json(profile: &str) -> Value {
    let (width, height, supported) = if host_screen_enabled() {
        screen_geometry()
    } else {
        (0, 0, false)
    };
    let (lease, epoch) = current_lease(profile);
    json!({
        "profile": profile,
        "supported": supported,
        "available": supported,
        "installed": supported,
        "ready": supported,
        // 本机镜像的"屏幕"恒在运行：RFB 服务在应用启动时已起（无 stop 面）。
        // hermes 的 running 语义 = bot 桌面进程在跑；宿主对偶 = 捕获能力可用
        // 即可看。曾硬编码 false，导致屏幕面板永远停在"已关闭/启动"态
        // （2026-11-18 实测修）。
        "running": supported,
        "kind": "local-screen",
        "label": hostname(),
        "blocker": if supported { Value::Null } else { json!("此主机没有机器人屏幕：机器人屏幕运行在 Linux 网关主机上") },
        "display": Value::Null,
        "missing": [],
        "detail": if supported {
            json!("本机桌面镜像（非按 profile 隔离的虚拟屏，MIRACH_HOST_SCREEN=1 显式启用）")
        } else {
            json!("机器人屏幕在 Linux 网关上运行；本机 bot 使用主机自身的显示器")
        },
        // 上游契约 geometry = 字符串（面板头部 `{display} · {geometry}`）。
        "geometry": if supported { json!(format!("{width}x{height}")) } else { Value::Null },
        "counts": { "online": if supported { 1 } else { 0 }, "total": 1 },
        "elapsedS": 0,
        "image_switch": Value::Null,
        // 上游契约：lease 恒为对象（无人持有 = holder:"agent"）。
        "lease": lease_json(lease.as_ref(), epoch),
        "profile_key": profile,
    })
}

// ── 截屏（Windows GDI）──────────────────────────────────────────────────────

/// 返回（宽, 高, 是否支持）。virtual screen 尺寸。
fn screen_geometry() -> (u32, u32, bool) {
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN,
        };
        let w = GetSystemMetrics(SM_CXVIRTUALSCREEN);
        let h = GetSystemMetrics(SM_CYVIRTUALSCREEN);
        if w > 0 && h > 0 {
            return (w as u32, h as u32, true);
        }
    }
    (0, 0, false)
}

/// 捕获本机桌面并缩放到 `max_width` 以内。返回 BGRA（顶行在前）。
#[cfg(windows)]
fn capture(max_width: Option<u32>) -> Result<(u32, u32, Vec<u8>), String> {
    use std::ffi::c_void;
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::Graphics::Gdi::{
        CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits,
        ReleaseDC, SelectObject, SetStretchBltMode, StretchBlt, BITMAPINFO, BITMAPINFOHEADER,
        BI_RGB, CAPTUREBLT, DIB_RGB_COLORS, HALFTONE, HGDIOBJ, SRCCOPY,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetDesktopWindow, GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN,
        SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN,
    };

    unsafe {
        let screen_w = GetSystemMetrics(SM_CXVIRTUALSCREEN);
        let screen_h = GetSystemMetrics(SM_CYVIRTUALSCREEN);
        let screen_x = GetSystemMetrics(SM_XVIRTUALSCREEN);
        let screen_y = GetSystemMetrics(SM_YVIRTUALSCREEN);
        if screen_w <= 0 || screen_h <= 0 {
            return Err("屏幕尺寸读取失败".into());
        }
        let limit = max_width.unwrap_or(1280).max(64) as f64;
        let scale = (limit / screen_w as f64).min(1.0);
        let out_w = ((screen_w as f64 * scale).round() as i32).max(1);
        let out_h = ((screen_h as f64 * scale).round() as i32).max(1);

        let desktop: HWND = GetDesktopWindow();
        let screen_dc = GetDC(desktop);
        if screen_dc.is_null() {
            return Err("GetDC 失败".into());
        }
        let mem_dc = CreateCompatibleDC(screen_dc);
        let bitmap = CreateCompatibleBitmap(screen_dc, out_w, out_h);
        let old = SelectObject(mem_dc, bitmap as HGDIOBJ);
        SetStretchBltMode(mem_dc, HALFTONE);
        let ok = StretchBlt(
            mem_dc,
            0,
            0,
            out_w,
            out_h,
            screen_dc,
            screen_x,
            screen_y,
            screen_w,
            screen_h,
            SRCCOPY | CAPTUREBLT,
        );
        if ok == 0 {
            // HALFTONE 需要预设；失败时退普通模式重试一次。
            SetStretchBltMode(mem_dc, 3 /* COLORONCOLOR */);
            let _ = StretchBlt(
                mem_dc,
                0,
                0,
                out_w,
                out_h,
                screen_dc,
                screen_x,
                screen_y,
                screen_w,
                screen_h,
                SRCCOPY | CAPTUREBLT,
            );
        }
        let mut info: BITMAPINFO = std::mem::zeroed();
        info.bmiHeader = BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: out_w,
            biHeight: -out_h, // top-down
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB,
            ..std::mem::zeroed()
        };
        let mut buffer = vec![0u8; (out_w * out_h * 4) as usize];
        let lines = GetDIBits(
            mem_dc,
            bitmap,
            0,
            out_h as u32,
            buffer.as_mut_ptr() as *mut c_void,
            &mut info,
            DIB_RGB_COLORS,
        );
        SelectObject(mem_dc, old);
        DeleteObject(bitmap as HGDIOBJ);
        DeleteDC(mem_dc);
        ReleaseDC(desktop, screen_dc);
        if lines == 0 {
            return Err("GetDIBits 失败".into());
        }
        Ok((out_w as u32, out_h as u32, buffer))
    }
}

#[cfg(not(windows))]
fn capture(_max_width: Option<u32>) -> Result<(u32, u32, Vec<u8>), String> {
    Err("本平台不支持屏幕捕获（仅 Windows）".into())
}

fn encode_image(media: &str, width: u32, height: u32, bgra: &[u8]) -> Result<String, String> {
    let mut bytes: Vec<u8> = Vec::new();
    let mut cursor = std::io::Cursor::new(&mut bytes);
    if media == "image/png" {
        let mut rgba = Vec::with_capacity(bgra.len());
        for pixel in bgra.chunks_exact(4) {
            rgba.push(pixel[2]);
            rgba.push(pixel[1]);
            rgba.push(pixel[0]);
            rgba.push(255);
        }
        let image = image::RgbaImage::from_raw(width, height, rgba)
            .ok_or_else(|| "帧缓冲尺寸不匹配".to_string())?;
        image
            .write_to(&mut cursor, image::ImageFormat::Png)
            .map_err(|e| format!("帧编码失败: {e}"))?;
    } else {
        // JPEG 编码器只接受 RGB8（Rgba8 会报 unsupported color type）。
        let mut rgb = Vec::with_capacity((width * height * 3) as usize);
        for pixel in bgra.chunks_exact(4) {
            rgb.push(pixel[2]);
            rgb.push(pixel[1]);
            rgb.push(pixel[0]);
        }
        let image = image::RgbImage::from_raw(width, height, rgb)
            .ok_or_else(|| "帧缓冲尺寸不匹配".to_string())?;
        image
            .write_to(&mut cursor, image::ImageFormat::Jpeg)
            .map_err(|e| format!("帧编码失败: {e}"))?;
    }
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:{media};base64,{b64}"))
}

// ── RFB WebSocket 服务 ──────────────────────────────────────────────────────

static WS_PORT: OnceLock<u16> = OnceLock::new();

/// 启动 display WS 服务（幂等）。端口随机，前端经 `pi_display_ws_port` 读取。
pub fn start_server() {
    // 默认关闭本机桌面镜像（见 host_screen_enabled）。显式启用才起 RFB。
    if !host_screen_enabled() {
        eprintln!("[display] 本机 bot 无机器人屏幕（Linux 网关专属能力）；RFB 未启动");

        return;
    }
    static STARTED: OnceLock<()> = OnceLock::new();
    if STARTED.get().is_some() {
        return;
    }
    let _ = STARTED.set(());
    tauri::async_runtime::spawn(async move {
        let listener = match tokio::net::TcpListener::bind("127.0.0.1:0").await {
            Ok(listener) => listener,
            Err(e) => {
                eprintln!("[display] 屏幕服务绑定失败: {e}");
                return;
            }
        };
        if let Ok(addr) = listener.local_addr() {
            let _ = WS_PORT.set(addr.port());
            eprintln!("[display] 本机屏幕 RFB 服务 127.0.0.1:{}", addr.port());
        }
        loop {
            match listener.accept().await {
                Ok((stream, _)) => {
                    tokio::spawn(async move {
                        if let Err(e) = serve_rfb(stream).await {
                            eprintln!("[display] RFB 会话结束: {e}");
                        }
                    });
                }
                Err(e) => {
                    eprintln!("[display] accept 失败: {e}");
                    tokio::time::sleep(Duration::from_millis(500)).await;
                }
            }
        }
    });
}

#[tauri::command(rename_all = "camelCase", async)]
pub fn pi_display_ws_port() -> Result<Value, String> {
    Ok(json!({ "port": WS_PORT.get().copied() }))
}

async fn serve_rfb(stream: tokio::net::TcpStream) -> Result<(), String> {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;

    // HTTP upgrade 里的 display_ticket：accept 只做握手，业务鉴权在之前用
    // peek 读请求行（peek 不消费字节，握手不受影响）。
    let mut peek = [0u8; 2048];
    let n = stream
        .peek(&mut peek)
        .await
        .map_err(|e| format!("peek 失败: {e}"))?;
    let head = String::from_utf8_lossy(&peek[..n]).to_string();
    let ticket = head
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|target| {
            target
                .split_once("display_ticket=")
                .map(|(_, t)| t.split('&').next().unwrap_or("").to_string())
        })
        .unwrap_or_default();
    let profile = {
        let tickets = state().tickets.lock().expect("display tickets poisoned");
        match tickets.get(&ticket) {
            Some(entry) if entry.expires_at > now_secs() => entry.profile.clone(),
            _ => return Err("display ticket 无效或已过期".into()),
        }
    };
    // 单次使用：消费掉 ticket。
    state()
        .tickets
        .lock()
        .expect("display tickets poisoned")
        .remove(&ticket);

    let mut ws = tokio_tungstenite::accept_async(stream)
        .await
        .map_err(|e| format!("WS 握手失败: {e}"))?;
    let mut inbox: Vec<u8> = Vec::new();

    async fn read_n(
        ws: &mut tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>,
        inbox: &mut Vec<u8>,
        n: usize,
    ) -> Result<Vec<u8>, String> {
        use futures_util::StreamExt;
        use tokio_tungstenite::tungstenite::Message;
        while inbox.len() < n {
            let Some(message) = ws.next().await else {
                return Err("客户端断开".into());
            };
            match message.map_err(|e| e.to_string())? {
                Message::Binary(data) => inbox.extend_from_slice(&data),
                Message::Text(text) => inbox.extend_from_slice(text.as_bytes()),
                Message::Close(_) => return Err("客户端关闭".into()),
                _ => {}
            }
        }
        Ok(inbox.drain(..n).collect())
    }

    // 1) 版本
    ws.send(Message::binary(b"RFB 003.008\n".to_vec()))
        .await
        .map_err(|e| e.to_string())?;
    let _version = read_n(&mut ws, &mut inbox, 12).await?;
    // 2) 安全类型：只提供 None(1)
    ws.send(Message::binary(vec![1u8, 1u8]))
        .await
        .map_err(|e| e.to_string())?;
    let _choice = read_n(&mut ws, &mut inbox, 1).await?;
    ws.send(Message::binary(vec![0u8, 0, 0, 0]))
        .await
        .map_err(|e| e.to_string())?;
    // 3) ClientInit
    let _shared = read_n(&mut ws, &mut inbox, 1).await?;
    let (width, height, frame) = capture(Some(1280))?;
    let mut server_init = Vec::with_capacity(24 + 16);
    server_init.extend_from_slice(&(width as u16).to_be_bytes());
    server_init.extend_from_slice(&(height as u16).to_be_bytes());
    // pixel format: 32bpp/depth24/little-endian/true-colour，BGRA 字节序
    server_init.extend_from_slice(&[32, 24, 0, 1]);
    server_init.extend_from_slice(&255u16.to_be_bytes());
    server_init.extend_from_slice(&255u16.to_be_bytes());
    server_init.extend_from_slice(&255u16.to_be_bytes());
    server_init.push(16);
    server_init.push(8);
    server_init.push(0);
    server_init.extend_from_slice(&[0u8, 0, 0]);
    let name = format!("Mirach 本机屏幕 ({profile})");
    server_init.extend_from_slice(&(name.len() as u32).to_be_bytes());
    server_init.extend_from_slice(name.as_bytes());
    ws.send(Message::binary(server_init))
        .await
        .map_err(|e| e.to_string())?;

    let mut last_frame = frame;
    let mut last_at = std::time::Instant::now();
    loop {
        let header = read_n(&mut ws, &mut inbox, 1).await?;
        match header[0] {
            0 => {
                let _ = read_n(&mut ws, &mut inbox, 19).await?; // SetPixelFormat
            }
            2 => {
                let count = read_n(&mut ws, &mut inbox, 3).await?;
                let n = u16::from_be_bytes([count[1], count[2]]) as usize;
                let _ = read_n(&mut ws, &mut inbox, n * 4).await?; // SetEncodings
            }
            3 => {
                let _ = read_n(&mut ws, &mut inbox, 9).await?; // FramebufferUpdateRequest
                if last_at.elapsed() > Duration::from_millis(350) {
                    if let Ok((w, h, frame)) = capture(Some(1280)) {
                        if w == width && h == height {
                            last_frame = frame;
                        }
                    }
                    last_at = std::time::Instant::now();
                }
                let mut update = Vec::with_capacity(16 + last_frame.len());
                update.extend_from_slice(&[0u8, 0, 0, 1]); // type, pad, rects=1
                update.extend_from_slice(&0u16.to_be_bytes());
                update.extend_from_slice(&0u16.to_be_bytes());
                update.extend_from_slice(&(width as u16).to_be_bytes());
                update.extend_from_slice(&(height as u16).to_be_bytes());
                update.extend_from_slice(&0i32.to_be_bytes()); // Raw encoding
                update.extend_from_slice(&last_frame);
                ws.send(Message::binary(update))
                    .await
                    .map_err(|e| e.to_string())?;
            }
            4 => {
                let _ = read_n(&mut ws, &mut inbox, 7).await?; // KeyEvent（忽略：只读镜像）
            }
            5 => {
                let _ = read_n(&mut ws, &mut inbox, 5).await?; // PointerEvent（忽略）
            }
            6 => {
                let len = read_n(&mut ws, &mut inbox, 7).await?;
                let n = u32::from_be_bytes([len[3], len[4], len[5], len[6]]) as usize;
                let _ = read_n(&mut ws, &mut inbox, n).await?;
            }
            other => {
                return Err(format!("未知 RFB 消息类型 {other}"));
            }
        }
    }
}

// ── IPC ─────────────────────────────────────────────────────────────────────

#[tauri::command(rename_all = "camelCase", async)]
pub fn pi_display_status(profile: Option<String>) -> Result<Value, String> {
    Ok(status_json(profile.as_deref().unwrap_or("local")))
}

#[tauri::command(rename_all = "camelCase", async)]
pub fn pi_display_thumbnail(profile: Option<String>) -> Result<Value, String> {
    if !host_screen_enabled() {
        return Err("此主机没有机器人屏幕（Linux 网关专属能力）".into());
    }
    let profile = profile.unwrap_or_else(|| "local".into());
    // 契约（gateway-contract DisplayThumbnailResult）：`{data_url, suppressed}`。
    // 人持租约时缩略图被抑制（frame 可能拍到正在输入的内容）——data_url 置
    // null + suppressed 说明原因，与上游 tools/bot_desktop/runtime.py 同判。
    let (lease, _) = current_lease(&profile);
    if lease.map(|l| l.holder == "human").unwrap_or(false) {
        return Ok(json!({ "data_url": Value::Null, "suppressed": "human" }));
    }
    let (width, height, frame) = capture(Some(480))?;
    let thumbnail = encode_image("image/jpeg", width, height, &frame)?;
    Ok(json!({ "data_url": thumbnail, "suppressed": Value::Null }))
}

#[tauri::command(rename_all = "camelCase", async)]
pub fn pi_display_observe(
    profile: Option<String>,
    viewer_id: Option<String>,
) -> Result<Value, String> {
    if !host_screen_enabled() || !screen_geometry().2 {
        return Err("本机屏幕捕获不可用".into());
    }
    let profile = profile.unwrap_or_else(|| "local".into());
    let viewer_id = viewer_id
        .map(|id| id.trim().to_owned())
        .filter(|id| !id.is_empty())
        .unwrap_or_else(|| new_id("viewer"));
    let ticket = new_id("ticket");
    state()
        .tickets
        .lock()
        .expect("display tickets poisoned")
        .insert(
            ticket.clone(),
            Ticket {
                viewer_id: viewer_id.clone(),
                profile: profile.clone(),
                expires_at: now_secs() + 30,
            },
        );
    // 契约（DisplayObserveResult）= **展平的状态对象** + ticket/path/viewer_id。
    // 此前返回 `{viewer_id, ticket, lease, status:{…}}` 的嵌套形状：面板
    // `setScreenStatus(bot, observe)` 把包封当状态存 → `running` 读不到，
    // 渲染态会闪"已关闭"（2026-11-18 审计实锤修）。
    let mut status = status_json(&profile);
    if let Some(obj) = status.as_object_mut() {
        obj.insert("viewer_id".into(), json!(viewer_id));
        obj.insert("ticket".into(), json!(ticket));
        obj.insert("path".into(), json!("/api/display/ws"));
    }
    Ok(status)
}

#[tauri::command(rename_all = "camelCase", async)]
pub fn pi_display_start(profile: Option<String>) -> Result<Value, String> {
    let profile = profile.unwrap_or_else(|| "local".into());
    // "start" 在宿主语义 = 确保屏幕可观察（本机屏幕恒在，无需启动服务）。
    // 返回**展平状态**（screen-pane 的 `displayRequest<DisplayStatus>` 直接
    // setScreenStatus——包封形状会同 observe 一样读不到 running）。
    if !host_screen_enabled() || !screen_geometry().2 {
        return Err("本机屏幕捕获不可用".into());
    }
    Ok(status_json(&profile))
}

#[tauri::command(rename_all = "camelCase", async)]
pub fn pi_display_lease_acquire(
    app: tauri::AppHandle,
    profile: Option<String>,
    viewer_id: String,
) -> Result<Value, String> {
    use tauri::Emitter;
    let profile = profile.unwrap_or_else(|| "local".into());
    let viewer_id = viewer_id.trim();
    if viewer_id.is_empty() {
        return Err("display.lease.acquire 缺少 viewer_id".into());
    }
    let mut leases = state().leases.lock().expect("display leases poisoned");
    let epoch = next_epoch(&profile);
    let lease = Lease {
        holder: "human".into(),
        viewer_hash: viewer_hash(viewer_id),
        lease_id: new_id("lease"),
        since: now_secs(),
        expires_at: now_secs() + 3600,
        epoch,
    };
    leases.insert(profile.clone(), lease.clone());
    drop(leases);
    // 上游 `display.lease` 事件（订阅方：screen-pane / screen-portal 的状态条）。
    let _ = app.emit(
        "mirach:plugin:display:lease",
        json!({ "profile_key": profile, "lease": lease_json(Some(&lease), epoch) }),
    );
    Ok(json!({ "lease": lease_json(Some(&lease), epoch) }))
}

#[tauri::command(rename_all = "camelCase", async)]
pub fn pi_display_lease_release(
    app: tauri::AppHandle,
    profile: Option<String>,
    viewer_id: Option<String>,
    force: Option<bool>,
) -> Result<Value, String> {
    use tauri::Emitter;
    let profile = profile.unwrap_or_else(|| "local".into());
    let mut leases = state().leases.lock().expect("display leases poisoned");
    if let Some(lease) = leases.get(&profile).cloned() {
        let matches = viewer_id
            .as_deref()
            .map(|id| viewer_hash(id.trim()) == lease.viewer_hash)
            .unwrap_or(false);
        if !matches && force != Some(true) {
            return Err("display.lease.release: 只有租约持有者可以释放（force=true 可强制）".into());
        }
        leases.remove(&profile);
    }
    drop(leases);
    // 释放后的占位租约 = holder:"agent"（契约对象，非 null），epoch 仍单调
    // 递增，让客户端把"你正在控制"正确翻回"机器人正在控制"（2026-11-18）。
    let epoch = next_epoch(&profile);
    let agent = lease_json(None, epoch);
    let _ = app.emit(
        "mirach:plugin:display:lease",
        json!({ "profile_key": profile, "lease": agent.clone() }),
    );
    Ok(json!({ "lease": agent }))
}

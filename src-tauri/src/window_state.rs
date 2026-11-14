//! 窗口几何存档（照搬 hermes `apps/desktop/electron/window-state.ts` 的语义）。
//!
//! 为什么需要：窗口尺寸按工作区比例算只决定**首屏**。用户拖过窗口大小之后
//! 期望下次还是那个大小——hermes 为此把 x/y/width/height/isMaximized 写进
//! `window-state.json`，下次启动优先读它（读不到/坏档/越界才回落到比例公式）。
//!
//! 存储：`<app_data_dir>/window-state.json`（主窗）与
//! `<app_data_dir>/window-state.<label>.json`（其余窗口）。原子写：tmp +
//! rename，与 session_meta 同形，半写文档不会出现。
//!
//! **按 label 分文件**（2026-10-23 多窗口改造）：设置窗是第二个顶层窗口，
//! 共用一份存档会让两边互相覆盖——设置窗一关就把主窗的几何写没了。
//! 主窗沿用无后缀的历史文件名，避免既有用户的窗口记忆失效。
//!
//! 校验纪律（每条都对应 hermes 里的一段真实防御）：
//!   - width/height 必须有限且 > 0，否则整份存档判废（回落到比例公式）；
//!   - 尺寸夹进 [MIN_W, MIN_H] 与显示器工作区，避免存档里的小尺寸把窗口
//!     锁成一条缝；
//!   - x/y 只在**与某块屏有足够重叠**时才沿用（hermes: MIN_VISIBLE = 48）。
//!     显示器拔掉后旧的坐标会把窗口放到看不见的地方——此时丢弃 x/y 让系统
//!     居中，而不是把窗口"藏"起来。
//!
//! 不做的事：不记录 fullscreen 的 stale bounds 恢复启发式（hermes 那套
//! `boundsCapturedFullScreen` 是为它自己的 Electron 全屏 bug 打的补丁，我们
//! 用 tauri 的 is_maximized 单一布尔就够）。

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::Manager;

/// 窗口最小尺寸（与 tauri.conf.json 的 minWidth/minHeight 同值）。
pub const MIN_W: f64 = 600.0;
pub const MIN_H: f64 = 600.0;

/// 至少要留在屏幕工作区内的像素（否则视为离屏坐标，丢弃）。
const MIN_VISIBLE: f64 = 48.0;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowState {
    pub width: f64,
    pub height: f64,
    #[serde(default)]
    pub x: Option<f64>,
    #[serde(default)]
    pub y: Option<f64>,
    #[serde(default)]
    pub is_maximized: bool,
}

/// 主窗 label（存档文件名不带后缀，兼容旧档）。
pub const MAIN_LABEL: &str = "main";

/// 按窗口 label 算存档路径。
///
/// `main` → `window-state.json`（历史文件名，不能改——老用户的窗口记忆
/// 就存在这里）；其余 → `window-state.<label>.json`。
fn state_path(app: &tauri::AppHandle, label: &str) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir 解析失败: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("app_data_dir 创建失败: {e}"))?;
    let name = if label == MAIN_LABEL {
        "window-state.json".to_string()
    } else {
        format!("window-state.{label}.json")
    };
    Ok(dir.join(name))
}

/// 读存档。**任何异常都返回 None 并打印原因**——坏档不能静默当成"没有存档"
/// （那样用户永远不知道自己的窗口记忆为什么失效），但也不能因为坏档就崩。
pub fn read_state(app: &tauri::AppHandle, label: &str) -> Option<WindowState> {
    let path = match state_path(app, label) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("[window-state] 路径解析失败：{e}");
            return None;
        }
    };
    let content = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(e) => {
            // 首次启动没有这个文件是正常态，不算错误
            if e.kind() != std::io::ErrorKind::NotFound {
                eprintln!("[window-state] 读取失败 {}: {e}", path.display());
            }
            return None;
        }
    };
    if content.trim().is_empty() {
        eprintln!("[window-state] 存档为空——忽略 {}", path.display());
        return None;
    }
    match serde_json::from_str::<WindowState>(&content) {
        Ok(state) => {
            if !state.width.is_finite() || !state.height.is_finite() || state.width <= 0.0 || state.height <= 0.0 {
                eprintln!(
                    "[window-state] 存档尺寸非法（{}×{}）——忽略",
                    state.width, state.height
                );
                return None;
            }
            Some(state)
        }
        Err(e) => {
            eprintln!("[window-state] 存档形状非法——忽略：{e}");
            None
        }
    }
}

/// 原子写存档。
pub fn write_state(app: &tauri::AppHandle, label: &str, state: &WindowState) -> Result<(), String> {
    let path = state_path(app, label)?;
    let json = serde_json::to_string_pretty(state).map_err(|e| format!("window-state 序列化失败: {e}"))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| format!("window-state.tmp 写入失败: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("window-state 原子替换失败: {e}"))?;
    Ok(())
}

/// 把存档夹进当前显示器的可用范围（hermes `computeWindowOptions` 的语义）。
///
/// 返回 `(width, height, x, y)`；`x/y` 为 None 表示"沿用不了旧坐标，交给
/// 系统居中"。
pub fn clamp_to_work_area(
    state: &WindowState,
    work: (f64, f64),
    monitors: &[(f64, f64, f64, f64)], // (x, y, w, h) 逻辑像素
) -> (f64, f64, Option<f64>, Option<f64>) {
    let (work_w, work_h) = work;
    let width = state.width.max(MIN_W).min(work_w.max(MIN_W));
    let height = state.height.max(MIN_H).min(work_h.max(MIN_H));

    let (Some(x), Some(y)) = (state.x, state.y) else {
        return (width, height, None, None);
    };
    if !x.is_finite() || !y.is_finite() {
        return (width, height, None, None);
    }

    // 与任一块屏的重叠是否够"抓得住标题栏"（hermes MIN_VISIBLE 语义）
    let visible = monitors.iter().any(|&(mx, my, mw, mh)| {
        let overlap_w = (x + width).min(mx + mw) - x.max(mx);
        let overlap_h = (y + height).min(my + mh) - y.max(my);
        overlap_w >= MIN_VISIBLE && overlap_h >= MIN_VISIBLE
    });
    if visible {
        (width, height, Some(x), Some(y))
    } else {
        eprintln!("[window-state] 存档坐标 ({x},{y}) 已不在任何屏幕上——改为居中");
        (width, height, None, None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn st(width: f64, height: f64, x: Option<f64>, y: Option<f64>) -> WindowState {
        WindowState { width, height, x, y, is_maximized: false }
    }

    const MON: &[(f64, f64, f64, f64)] = &[(0.0, 0.0, 2560.0, 1392.0)];

    #[test]
    fn keeps_valid_size_and_position() {
        let (w, h, x, y) = clamp_to_work_area(&st(1400.0, 900.0, Some(200.0), Some(150.0)), (2560.0, 1392.0), MON);
        assert_eq!((w, h), (1400.0, 900.0));
        assert_eq!((x, y), (Some(200.0), Some(150.0)));
    }

    #[test]
    fn clamps_oversized_to_work_area() {
        let (w, h, _, _) = clamp_to_work_area(&st(4000.0, 3000.0, None, None), (2560.0, 1392.0), MON);
        assert_eq!((w, h), (2560.0, 1392.0));
    }

    #[test]
    fn raises_tiny_to_minimum() {
        let (w, h, _, _) = clamp_to_work_area(&st(120.0, 90.0, None, None), (2560.0, 1392.0), MON);
        assert_eq!((w, h), (MIN_W, MIN_H));
    }

    #[test]
    fn drops_offscreen_position_but_keeps_size() {
        // 旧的第二屏坐标（那块屏已拔掉）
        let (w, h, x, y) = clamp_to_work_area(&st(1400.0, 900.0, Some(5000.0), Some(200.0)), (2560.0, 1392.0), MON);
        assert_eq!((w, h), (1400.0, 900.0));
        assert_eq!((x, y), (None, None));
    }

    #[test]
    fn keeps_partially_visible_position() {
        // 只有 60px 露在屏内——仍抓得住（>= MIN_VISIBLE）
        let (_, _, x, y) = clamp_to_work_area(&st(1400.0, 900.0, Some(2500.0), Some(1300.0)), (2560.0, 1392.0), MON);
        assert_eq!((x, y), (Some(2500.0), Some(1300.0)));
    }

    #[test]
    fn drops_position_with_too_little_overlap() {
        // 只露 10px —— 抓不住
        let (_, _, x, y) = clamp_to_work_area(&st(1400.0, 900.0, Some(2550.0), Some(1380.0)), (2560.0, 1392.0), MON);
        assert_eq!((x, y), (None, None));
    }

    #[test]
    fn non_finite_position_dropped() {
        let (_, _, x, y) = clamp_to_work_area(&st(1400.0, 900.0, Some(f64::NAN), Some(10.0)), (2560.0, 1392.0), MON);
        assert_eq!((x, y), (None, None));
    }

    #[test]
    fn multi_monitor_keeps_position_on_second_screen() {
        let monitors = [(0.0, 0.0, 2560.0, 1392.0), (2560.0, 0.0, 1920.0, 1080.0)];
        let (_, _, x, y) = clamp_to_work_area(&st(1400.0, 900.0, Some(3000.0), Some(100.0)), (2560.0, 1392.0), &monitors);
        assert_eq!((x, y), (Some(3000.0), Some(100.0)));
    }
}

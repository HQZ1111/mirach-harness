/**
 * 窗口首屏尺寸（照搬 hermes，2026-10-22 用户定稿）。
 *
 * 参考实现：hermes `apps/desktop/electron/window-state.ts:121-141` ——窗口
 * 尺寸不是常量，而是**按屏幕工作区比例算 + 夹取**：
 *
 *   normal: share 0.88×0.88 · min 1280×820 · max 1760×1100
 *
 * 夹取顺序（hermes 原序）：先按 share 算，再 clamp 到 [min, max]，最后
 * `min(…, work_area)` 兜一层（工作区比下限还小时以工作区为准）。
 *
 * Rust 侧 `main.rs` 的 `hermes_window_size` 是同一公式（首屏设置在那里做）；
 * 本模块是**前端侧的同源实现**——「默认布局」要把窗口复位时得重算一次，
 * 不能再用写死的 1800×1000。两处常量必须同值，改一处必须改两处。
 *
 * 纯函数 + 无 DOM 依赖（工作区由调用方传入 `screen.availWidth/Height`）。
 */

/** 占用的工作区比例（宽、高） */
export const WINDOW_SHARE_W = 0.88
export const WINDOW_SHARE_H = 0.88
/** 夹取下限 */
export const WINDOW_MIN_W = 1280
export const WINDOW_MIN_H = 820
/** 夹取上限 */
export const WINDOW_MAX_W = 1760
export const WINDOW_MAX_H = 1100

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v))

/**
 * 按 hermes 公式算窗口逻辑尺寸。
 *
 * `work_w`/`work_h` 非法（0 / NaN / 负数——拿不到屏幕信息）不能假装算过：
 * 回落到 `[min, max]` 的中点既不是 hermes 语义也不是任何实测值，故显式报错
 * 并给出**下限**（最小值是唯一有意义的"小屏幕"答案，且不会撑破任何屏幕）。
 */
export const hermesWindowSize = (work_w: number, work_h: number): { width: number; height: number } => {
  const usable = (v: number) => Number.isFinite(v) && v > 0
  if (!usable(work_w) || !usable(work_h)) {
    console.error('[window-metrics] 工作区不可用——按下限计算窗口尺寸', { work_w, work_h })
    return { width: WINDOW_MIN_W, height: WINDOW_MIN_H }
  }
  return {
    width: Math.min(clamp(Math.round(work_w * WINDOW_SHARE_W), WINDOW_MIN_W, WINDOW_MAX_W), work_w),
    height: Math.min(clamp(Math.round(work_h * WINDOW_SHARE_H), WINDOW_MIN_H, WINDOW_MAX_H), work_h),
  }
}

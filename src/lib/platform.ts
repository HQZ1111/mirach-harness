/**
 * 平台判定（2026-10-23，为设置入口的两形态分叉而建）。
 *
 * ## 为什么不用 `@tauri-apps/plugin-os` 的 `platform()`
 *
 * 那个是**异步**的（`await platform()`），而调用点在同步的
 * `openSettingsOverlay()` 里；为了一个同步分叉去引一个新插件（还要加
 * capabilities 权限）不划算。
 *
 * 这里读 `navigator.userAgent`——判断"是不是移动端"这个粗粒度足够：
 *   · 只用于**选 UI 形态**（窗口 vs 浮层），不用于任何能力/权限判定；
 *   · 判错的后果 = 在平板上用了浮层（可接受），不是安全或数据问题。
 *
 * 精确的"能不能开多窗口"由 tauri 的 `supportsMultipleWindows()` 回答
 * （运行时探测，Android 12L+/iPad 才 true），本函数只用来**省掉桌面端那次
 * IPC 往返**。
 */

/** 是否移动端（Android / iOS / iPadOS）。桌面与浏览器直开都返回 false。 */
export function isMobilePlatform(): boolean {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent
  // Android：手机与平板都是 "Android"；iOS：iPhone/iPad/iPod。
  // iPadOS 13+ 默认伪装成 macOS 桌面 UA，靠触摸点数补判（同 tauri 官方
  // 文档里的常见做法）。
  if (/Android|iPhone|iPad|iPod/i.test(ua)) return true
  const touchPoints =
    typeof navigator.maxTouchPoints === 'number' ? navigator.maxTouchPoints : 0
  return /Macintosh/.test(ua) && touchPoints > 1
}

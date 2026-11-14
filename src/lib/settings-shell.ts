/**
 * 设置入口的形态决策（纯函数，2026-10-23）。
 *
 * 抽出来的理由：`openSettingsOverlay` 有三条分支（浏览器 / 桌面 / 移动端
 * 多窗口探测），其中两条**在这台机器上无法实机验证**（没有 Android/iOS
 * 构建，也没有 web 部署）。把它做成纯函数 + 单测，是唯一能锁住行为的办法
 * ——否则将来有人改一行，平板上的设置入口会静默失效而无人发现。
 *
 * ## 三形态
 *
 *   · `overlay` —— 壳内浮层（遮罩 + 居中卡片）。浏览器直开、iPhone、
 *     旧 Android 用。
 *   · `window`  —— 独立顶层窗口（能拖出壳）。桌面用。
 *   · `probe`   —— 先问 tauri `supportsMultipleWindows()` 再决定。
 *     Android 12L+ / iPad 支持多窗口，但**必须运行时问**（同一份 APK 在
 *     不同设备上答案不同）。
 */

export type SettingsShell = 'overlay' | 'window' | 'probe'

export interface SettingsShellInput {
  /** `lib/tauri-window.ts` 的 `inTauri`（`__TAURI_INTERNALS__` 是否存在）。 */
  inTauri: boolean
  /** `lib/platform.ts` 的 `isMobilePlatform()`。 */
  isMobile: boolean
}

/**
 * 选形态。
 *
 * **浏览器直开必须走 overlay 而不是 window**：`window` 分支要
 * `invoke('pi_open_settings_window')`，而 `@tauri-apps/api/core.js:328`
 * 直接读 `window.__TAURI_INTERNALS__.invoke` —— 浏览器里它是 undefined，
 * 抛 TypeError。此前这里无脑 invoke，被 `.catch()` 吞成一行 console，
 * 用户点齿轮**什么都不会发生**。
 *
 * **桌面跳过探测**：`supportsMultipleWindows()` 在桌面恒 true（官方文档），
 * 问它只是多一次 IPC 往返。
 */
export function settingsShellFor(input: SettingsShellInput): SettingsShell {
  if (!input.inTauri) return 'overlay'
  if (!input.isMobile) return 'window'
  return 'probe'
}

/**
 * 探测结果 → 最终形态。
 *
 * 探测**失败**（权限没放行、IPC 异常）时按"不支持"处理走 overlay：
 * 这是唯一不会让用户点了没反应的选项，且失败原因由调用方打日志
 * （铁律 12：可见，但不阻断功能）。
 */
export function settingsShellFromProbe(supported: boolean): SettingsShell {
  return supported ? 'window' : 'overlay'
}

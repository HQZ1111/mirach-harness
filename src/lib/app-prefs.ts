/**
 * 应用级偏好（2026-11-15）：设置页「常规」的持久化面。
 *
 * 真相在 Rust（`src-tauri/src/app_prefs.rs` 的 AppPrefsState + app-prefs.json）：
 *   · 关窗→托盘 / 保持唤醒必须由窗口事件与 OS 直接消费；
 *   · F12 拦截 / 外链外部打开 / 启动恢复由渲染层消费，但同源读写，
 *     避免两套文件互相漂移。
 *
 * 这里只是**同一份真相的渲染层投影 + 订阅**：`loadAppPrefs` 首次拉取，
 * `updateAppPrefs` 合并写（Rust 返回落盘后的完整对象），订阅者拿到的是
 * 真值而不是乐观更新——写失败时缓存不变，错误原样抛给调用方（铁律 12）。
 */

import { invoke } from '@tauri-apps/api/core'

export type KeepAwakeMode = 'off' | 'run' | 'always'

export interface AppPrefs {
  /** 启动时恢复上次会话。 */
  restoreLastSession: boolean
  /** 关主窗 = 隐藏到托盘（false = 退出应用）。 */
  closeToTray: boolean
  /** 保持电脑唤醒：关闭 / 运行期间 / 始终。 */
  keepAwake: KeepAwakeMode
  /** 拦截 F12（开发构建下的页面级快捷键）。 */
  disableF12: boolean
  /** http(s) 链接一律交系统默认浏览器打开。 */
  openLinksExternally: boolean
  /** 单次 run 的最大智能体步数；0 = 不设上限。 */
  maxAgentSteps: number
  /** 上次打开的会话文件绝对路径（启动恢复用）。 */
  lastSessionPath: string | null
}

let cache: AppPrefs | null = null
const listeners = new Set<(prefs: AppPrefs) => void>()

function publish(next: AppPrefs): void {
  cache = next
  for (const fn of listeners) fn(next)
}

/** 首次拉取（启动守卫 / 设置页挂载时调用）。 */
export async function loadAppPrefs(): Promise<AppPrefs> {
  const prefs = await invoke<AppPrefs>('app_prefs_get')
  publish(prefs)
  return prefs
}

/** 已加载的缓存（未加载过 = null；组件不允许拿它当默认值兜底）。 */
export function cachedAppPrefs(): AppPrefs | null {
  return cache
}

/** 合并写：只传变化的字段。返回落盘后的完整偏好。 */
export async function updateAppPrefs(patch: Partial<AppPrefs>): Promise<AppPrefs> {
  const prefs = await invoke<AppPrefs>('app_prefs_set', { patch })
  publish(prefs)
  return prefs
}

/** 订阅偏好变化（守卫 / 设置页各自保持最新）。返回取消函数。 */
export function subscribeAppPrefs(fn: (prefs: AppPrefs) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** 「运行期间」保持唤醒的 run 活动信号（runtime 在 run 开始/结束时发）。 */
export async function setRunActive(active: boolean): Promise<void> {
  await invoke('app_keep_awake_run', { active })
}

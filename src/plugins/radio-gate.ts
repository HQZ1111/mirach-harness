/**
 * 电台功能门（2026-11-26 用户："技能与工具里的内置插件怎么没有开关按钮？"）。
 *
 * 电台是 hermes radio 插件的宿主窗格形态，不是 bundled 插件记录；这里给它
 * 一个真实的启用决策（`$pluginDecisions['hermes-radio']`，默认开）：
 * - 关闭时打开页/标签条「+」菜单不再列电台，已开的电台窗格由 DockviewShell
 *   监听本门移除；
 * - 没有插件运行时需要 dispose，所以 `setPluginEnabled` 只落决策（无 handle
 *   时它本来就只保存，见 plugins-store）。
 */
import { useStore } from '@nanostores/react'

import { $pluginDecisions, pluginActive } from '@/hermes-shim/contrib/plugins-store'

export const RADIO_FEATURE_ID = 'hermes-radio'

/** 供模块级流程（hydrate 剪面板等）读的即时值。 */
export function radioFeatureEnabledNow(): boolean {
  return pluginActive(RADIO_FEATURE_ID)
}

/** React 订阅（打开页 / 标签条 / 技能与工具开关）。 */
export function useRadioFeatureEnabled(): boolean {
  useStore($pluginDecisions)
  return pluginActive(RADIO_FEATURE_ID)
}

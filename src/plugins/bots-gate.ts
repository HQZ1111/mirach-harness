/**
 * bots 功能总门（2026-11-22）。
 *
 * bots 是 hermes-bots **插件**；宿主侧所有配套（左栏开合、bots 面板、群聊
 * 后台驱动、Bot Chat 隐藏、定时任务的 bot 绑定）都必须以它为准，否则
 * 「关闭插件」只关掉插件贡献，原生半成品还在——这正是用户点名的
 * 「关闭插件能不能关干净」。
 *
 * 判定 = 用户显式启用（plugins-store 的 `pluginActive`）+ 插件注册成功
 * （record.status === 'loaded'）。插件加载前/注册失败/被禁用一律 false；
 * 订阅方用 `useBotsFeatureEnabled()`，模块级流程用 `botsFeatureEnabledNow()`。
 */
import { atom } from 'nanostores'
import { useStore } from '@nanostores/react'

import { $pluginDecisions, pluginActive } from '@/hermes-shim/contrib/plugins-store'

export const BOTS_PLUGIN_ID = 'hermes-bots'

/** 插件注册成功的运行时标志（由 bundled.ts 写入）。
 *  不用 `$pluginRecords`：runtime-loader 的周期性 refresh 会 drop 非它管理的
 *  记录（bundled 记录会被误清），状态会闪回 false。 */
export const $botsRuntimeLoaded = atom(false)

export function setBotsRuntimeLoaded(loaded: boolean): void {
  $botsRuntimeLoaded.set(loaded)
}

/** 用户是否启用（不看注册状态——启动早期注册可能尚未完成）。 */
export function botsFeatureDesiredNow(): boolean {
  return pluginActive(BOTS_PLUGIN_ID)
}

export function useBotsFeatureDesired(): boolean {
  useStore($pluginDecisions)
  return pluginActive(BOTS_PLUGIN_ID)
}

/** 真正可用 = 用户启用 + 插件注册成功。 */
export function botsFeatureEnabledNow(): boolean {
  if (!pluginActive(BOTS_PLUGIN_ID)) return false
  return $botsRuntimeLoaded.get()
}

export function useBotsFeatureEnabled(): boolean {
  const loaded = useStore($botsRuntimeLoaded)
  return pluginActive(BOTS_PLUGIN_ID) && loaded
}

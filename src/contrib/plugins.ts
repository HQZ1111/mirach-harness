/**
 * 插件注册表——hermes `contrib/plugins.ts` 的宿主对偶：bundled 插件静态
 * import。挂载 = activatePlugin 的贡献表按 area 消费（settings-overlay
 * 消费 settings.page 区）。
 *
 * 2026-11-24 用户："插件集成里面的核心和包是什么，删除"——mirach-pkg 的
 * 「包」页整页删除并退出 bundled 列表；mirach-connections 只保留
 * bots.roster.grouping（「连接」设置页也删了）。
 */
import type { Contribution, ContributionArea } from './types'
import { activatePlugin } from './context'

import ConnectionsPlugin from './mirach-connections/plugin'

// 静态 import（hermes 的 import.meta.glob eager 同语义）
const BUNDLED = [ConnectionsPlugin]

export interface ActivatedPlugins {
  contributions: Record<ContributionArea, Contribution[]>
}

let activated: ActivatedPlugins | null = null

/** 激活全部 bundled 插件（幂等——重复调用返回同一份贡献表）。 */
export function activateBundledPlugins(): ActivatedPlugins {
  if (activated) return activated
  const contributions: Record<ContributionArea, Contribution[]> = {
    'settings.page': [],
    'bots.roster.grouping': [],
  }
  for (const plugin of BUNDLED) {
    try {
      const byArea = activatePlugin(plugin)
      for (const area of Object.keys(byArea) as ContributionArea[]) {
        contributions[area]!.push(...byArea[area]!)
      }
    } catch (e) {
      // 插件注册失败 = 该插件的贡献缺席（错误隔离，hermes runtime-loader
      // 同语义——不是能力边界），console 可见不炸宿主
      console.error(`[contrib] 插件 ${plugin.id} 注册失败——贡献缺席`, e)
    }
  }
  activated = { contributions }
  return activated
}

export function usePluginContributions(): Record<ContributionArea, Contribution[]> {
  return activateBundledPlugins().contributions
}

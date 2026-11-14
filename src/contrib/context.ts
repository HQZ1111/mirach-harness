/**
 * 插件上下文工厂——hermes `contrib/plugin.ts:348-375` 的最小复刻：
 * 每个贡献 id 自动加 `plugin:<id>:` 命名空间（禁用/卸载时按前缀整体回收），
 * source 印上 `plugin:<id>`（溯源 + 未来能力闸）。
 */
import type { Contribution, ContributionArea, HarnessPlugin, PluginContext } from './types'

const ns = (pluginId: string, id: string) => `plugin:${pluginId}:${id}`

export function createPluginContext(
  plugin: HarnessPlugin,
  sink: (contribution: Contribution) => () => void,
): PluginContext {
  return {
    register: (contribution: Contribution) => {
      const namespaced: Contribution = {
        ...contribution,
        id: ns(plugin.id, contribution.id),
        source: plugin.id,
      }
      return sink(namespaced)
    },
    storage: {
      get: (key) => {
        try {
          return localStorage.getItem(`mirach.plugin.${plugin.id}.${key}`)
        } catch {
          return null
        }
      },
      set: (key, value) => {
        try {
          localStorage.setItem(`mirach.plugin.${plugin.id}.${key}`, value)
        } catch (e) {
          console.error(`[plugin:${plugin.id}] storage 写入失败`, e)
        }
      },
      remove: (key) => {
        try {
          localStorage.removeItem(`mirach.plugin.${plugin.id}.${key}`)
        } catch (e) {
          console.error(`[plugin:${plugin.id}] storage 移除失败`, e)
        }
      },
    },
    onDispose: (fn) => {
      // 首批无运行时卸载场景（bundled 常开）——预留接口，收 disposer 不消费
      void fn
    },
  }
}

/** 插件注册入口：跑 register，返回按 area 索引的贡献表。 */
export function activatePlugin(
  plugin: HarnessPlugin,
): Record<ContributionArea, Contribution[]> {
  const byArea: Record<ContributionArea, Contribution[]> = {
    'settings.page': [],
    'bots.roster.grouping': [],
  }
  const ctx = createPluginContext(plugin, (contribution) => {
    const list = byArea[contribution.area]
    if (!list) {
      console.error(`[contrib] 未知贡献区 ${String(contribution.area)}（插件 ${plugin.id}）——丢弃`)
      return () => {}
    }
    list.push(contribution)
    return () => {
      const idx = list.indexOf(contribution)
      if (idx >= 0) list.splice(idx, 1)
    }
  })
  plugin.register(ctx)
  return byArea
}

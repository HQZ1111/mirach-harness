/**
 * 内置（bundled）插件启动器 —— hermes 的 `discoverBundledPlugins()`
 * （`contrib/plugins.ts`）在宿主的对偶。
 *
 * ## 为什么内置插件不走磁盘门
 *
 * 运行时热拔插门（`runtime-loader.ts`）只接受**单文件 plugin.js**：它把源码
 * 用 blob 求值，import 重写成 SDK shim。hermes-bots 是 121 个文件 / 4.2 万行
 * 的 TSX 工程，单文件化需要独立打包器；而它本来就是"随应用发布"的插件
 * （上游 `description` 原文："Ships with the app"）。
 *
 * 所以内置插件走 **vite 打包 + 本文件注册**：与上游 bundled 插件同一条
 * 生命周期（`pluginActive` / 设置页开关 / `ctx.onDispose`），只是模块图由
 * 构建器解析而不是 blob。
 *
 * ## 失败语义
 *
 * 注册失败只把插件记录标 `error`（设置页可见），绝不打白应用壳——与运行时
 * 门的错误隔离一致。**不要**吞掉错误：`publishPlugin` 的 error 字段就是
 * 用户可见面。
 */

import type { PluginContext } from '@/sdk/types'

import { createContext } from '@/hermes-shim/contrib/runtime-loader'
import {
  patchPlugin,
  pluginActive,
  publishPlugin,
} from '@/hermes-shim/contrib/plugins-store'

/** 与上游 `HermesPlugin` 的结构子集（只取内置启动需要的字段）。 */
interface BundledPlugin {
  id: string
  name?: string
  description?: string
  defaultEnabled?: boolean
  register: (ctx: PluginContext) => Promise<void> | void
}

interface LoadedBundled {
  disposers: (() => void)[]
  plugin: BundledPlugin
}

const loaded = new Map<string, LoadedBundled>()
const started = new Set<string>()

function disposeOf(entry: LoadedBundled): void {
  for (const fn of [...entry.disposers].reverse()) {
    try {
      fn()
    } catch (e) {
      console.error(`[plugins] ${entry.plugin.id} disposer 抛错（继续清理）`, e)
    }
  }
  entry.disposers.length = 0
}

async function registerBundled(plugin: BundledPlugin): Promise<void> {
  const existing = loaded.get(plugin.id)
  if (existing) disposeOf(existing)

  const disposers: (() => void)[] = []
  const entry: LoadedBundled = { disposers, plugin }
  loaded.set(plugin.id, entry)

  if (!pluginActive(plugin.id, plugin.defaultEnabled !== false)) {
    publishPlugin(
      {
        id: plugin.id,
        name: plugin.name ?? plugin.id,
        kind: 'bundled',
        status: 'disabled',
        ...(plugin.description !== undefined ? { description: plugin.description } : {}),
      },
      {
        activate: () => registerBundled(plugin),
        deactivate: () => {
          disposeOf(loaded.get(plugin.id) ?? entry)
          patchPlugin(plugin.id, { status: 'disabled' })
        },
      },
    )
    return
  }

  try {
    const ctx = createContext(plugin.id, disposers) as unknown as PluginContext
    await plugin.register(ctx)
    publishPlugin(
      {
        id: plugin.id,
        name: plugin.name ?? plugin.id,
        kind: 'bundled',
        status: 'loaded',
        ...(plugin.description !== undefined ? { description: plugin.description } : {}),
      },
      {
        activate: () => registerBundled(plugin),
        deactivate: () => {
          disposeOf(loaded.get(plugin.id) ?? entry)
          patchPlugin(plugin.id, { status: 'disabled' })
        },
      },
    )
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    console.error(`[plugins] 内置插件 ${plugin.id} 注册失败`, e)
    publishPlugin({
      id: plugin.id,
      name: plugin.name ?? plugin.id,
      kind: 'bundled',
      status: 'error',
      error: message,
      ...(plugin.description !== undefined ? { description: plugin.description } : {}),
    })
  }
}

/** 启动内置插件。幂等（重复调用只注册一次）。 */
export async function startBundledPlugins(): Promise<void> {
  if (started.has('hermes-bots')) return
  started.add('hermes-bots')
  try {
    const mod = (await import('@/hermes-mirror/plugins/hermes-bots/plugin')) as {
      default: BundledPlugin
    }
    await registerBundled(mod.default)
    // canonical 群聊驱动的启动恢复扫描（应用重启后在途讨论重新驱动）；
    // 驱动本身不依赖插件注册，但它只服务 bots 面，放这里一处启动。
    void import('@/components/panes/hub/canonical-group-driver')
      .then((driver) => driver.startCanonicalGroupDriver())
      .catch((e) => console.error('[canonical-driver] 启动失败', e))
    if (import.meta.env.DEV) {
      // E2E 调试句柄（`__dvApi` 同惯例）：Bot Mode 的选择/焦点/名册原子。
      // 只在 DEV 暴露；CDP 探针用它核对 UI 背后的真实 store 值，不猜 DOM。
      // 动态 import 与插件同一模块实例（同一 vite 模块图，无 ?t= 变体）。
      void Promise.all([
        import('@/hermes-mirror/plugins/hermes-bots/bot-state'),
        import('@/hermes-mirror/plugins/hermes-bots/data'),
      ])
        .then(([state, data]) => {
          ;(globalThis as Record<string, unknown>).__botsDebug = {
            $botsPaneVisible: state.$botsPaneVisible,
            $botChatFocused: state.$botChatFocused,
            $focusedBotOwner: state.$focusedBotOwner,
            $lastRoster: data.$lastRoster,
            $openBotChat: state.$openBotChat,
            $selectedBot: state.$selectedBot,
            $selectedRosterKey: state.$selectedRosterKey,
            botRosterKey: data.botRosterKey,
            botSelectionKey: data.botSelectionKey,
          }
        })
        .catch((e) => console.error('[plugins] bots 调试句柄注册失败', e))
    }
  } catch (e) {
    // 动态 import 失败（模块图断链）：设置页要看得见，壳不受影响。
    console.error('[plugins] 内置插件 hermes-bots 加载失败', e)
    publishPlugin({
      id: 'hermes-bots',
      name: 'Bots',
      kind: 'bundled',
      status: 'error',
      error: e instanceof Error ? e.message : String(e),
    })
  }
}

/**
 * Desktop plugin runtime — 热拔插（hermes `contrib/runtime-loader.ts` 的宿主实现）。
 *
 * ## 热拔插做到什么
 *
 * - 插件源 = `<app_data_dir>/desktop-plugins/<id>/plugin.js`（Rust
 *   `plugin_runtime_*` 负责扫描/读写/卸载）。
 * - 启动扫描一次；之后每 1.5s 比对 mtime：文件一保存就 dispose 旧注册并重新
 *   import/register（"agent 重写插件文件 → 干净重载"）；文件消失 → dispose +
 *   从清单移除。
 * - 设置页 Plugins 的开关走 `plugins-store` 的 handles：**不重启**即可
 *   activate/deactivate（`setPluginEnabled` 已在 store 层实现）。
 * - 失败隔离：单个插件的语法错误/超时/注册异常只把该行标成 error，绝不炸壳
 *   （`plugin.js` 在 renderer realm 有完整权限，这是错误隔离不是能力边界，
 *   与上游安全说明一致）。
 *
 * ## import 面
 *
 * 只允许 `@hermes/plugin-sdk` / `react` / `react/jsx-runtime` /
 * `react/jsx-dev-runtime`（重写成 `sdk/runtime.ts` 的 blob shim，复用宿主
 * React 单例与 SDK 活命名空间）。相对导入（多文件插件）暂不支持——单文件
 * `plugin.js` 是磁盘门的最小契约，遇到会明确报错而不是静默失败。
 */

import { createPluginI18n } from '@/hermes-mirror/i18n'

import { registry } from './registry'
import {
  $pluginRecords,
  dropPlugin,
  patchPlugin,
  pluginActive,
  publishPlugin,
  type PluginRecord,
} from './plugins-store'
import { settingsPageContribution } from './settings-pages'
import { host } from '@/sdk/host'
import { sdkImportMap } from '@/sdk/runtime'

const IMPORT_TIMEOUT_MS = 10_000
const POLL_INTERVAL_MS = 1_500

interface PluginFile {
  id: string
  name: string
  path: string
  mtimeMs: number
  size: number
}

interface PluginSource {
  id: string
  source: string
  mtimeMs: number
}

/** The authoring contract we validate (superset of upstream's minimum). */
interface RuntimePlugin {
  id: string
  name?: string
  description?: string
  defaultEnabled?: boolean
  capabilities?: readonly string[]
  register: (ctx: RuntimePluginContext) => void | Promise<void>
}

/** Structural subset of upstream's PluginContext; unsupported doors are omitted
 *  (plugins feature-detect them) or throw with a clear message. */
interface RuntimePluginContext {
  readonly source: string
  register: (contribution: unknown) => () => void
  registerMany: (contributions: unknown[]) => () => void
  registerSettingsPage: (page: unknown) => () => void
  onDispose: (fn: () => void) => void
  onEvent: (type: string, listener: (payload: unknown) => void) => () => void
  setTimeout: (fn: () => void, ms: number) => () => void
  setInterval: (fn: () => void, ms: number) => () => void
  addEventListener: (
    target: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: AddEventListenerOptions | boolean,
  ) => () => void
  rest: <T>(path: string, opts?: unknown) => Promise<T>
  socket: (path: string, onMessage: (data: unknown) => void) => () => void
  os: {
    notify: (input: { kind?: string; message: string }) => void
    notifyError: (message: string) => void
    openExternal: (url: string) => void
  }
  runAction: (id: string) => { ok: boolean; error?: string }
  listActions: () => unknown[]
  storage: {
    get: (key: string, fallback: string) => string
    set: (key: string, value: string) => void
    delete: (key: string) => void
  }
  i18n: {
    t: (key: string, ...args: unknown[]) => string
    register: (bundles: never) => () => void
    onLocaleChange?: (listener: () => void) => () => void
    registerAppLocale?: (id: string, registration: never) => () => void
  }
}

interface LoadedPlugin {
  mtimeMs: number
  dispose: (() => void) | null
}

const loaded = new Map<string, LoadedPlugin>()
let pollTimer: number | null = null
let discovering = false

async function invokeIpc<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<T>(cmd, args)
}

/** Rewrite allowlisted bare specifiers to the SDK shim blob URLs. */
function rewriteImports(source: string): string {
  const map = sdkImportMap()
  const swap = (spec: string): string => {
    const shim = map[spec]
    if (shim) return shim
    if (spec.startsWith('.') || spec.startsWith('/')) {
      throw new Error(`plugin import '${spec}' 不支持多文件插件（单文件 plugin.js）`)
    }
    throw new Error(`plugin import '${spec}' 不在允许清单（@hermes/plugin-sdk / react*）`)
  }
  return source
    .replace(
      /(\bfrom\s*)(['"])([^'"\n]+)\2/g,
      (_m, pre: string, q: string, spec: string) => pre + q + swap(spec) + q,
    )
    .replace(
      /(\bimport\s*\(\s*)(['"])([^'"\n]+)\2(\s*\))/g,
      (_m, pre: string, q: string, spec: string, post: string) =>
        pre + q + swap(spec) + q + post,
    )
    .replace(
      /(\bimport\s+)(['"])([^'"\n]+)\2/g,
      (_m, pre: string, q: string, spec: string) => pre + q + swap(spec) + q,
    )
}

/** Evaluate one plugin source in the renderer realm with a hard timeout. */
async function importPlugin(source: string): Promise<RuntimePlugin> {
  const rewritten = rewriteImports(source)
  const url = URL.createObjectURL(new Blob([rewritten], { type: 'text/javascript' }))
  let timer: number | null = null
  try {
    const mod = (await Promise.race([
      import(/* @vite-ignore */ url),
      new Promise<never>((_resolve, reject) => {
        timer = window.setTimeout(
          () => reject(new Error(`plugin import timed out after ${IMPORT_TIMEOUT_MS}ms`)),
          IMPORT_TIMEOUT_MS,
        )
      }),
    ])) as { default?: RuntimePlugin; plugin?: RuntimePlugin }
    const plugin = mod.default ?? mod.plugin
    if (!plugin || typeof plugin !== 'object') {
      throw new Error('plugin.js 必须 default export 一个 HermesPlugin 对象')
    }
    if (typeof plugin.id !== 'string' || plugin.id.trim() === '') {
      throw new Error('HermesPlugin.id 必须是非空字符串')
    }
    if (typeof plugin.register !== 'function') {
      throw new Error('HermesPlugin.register 必须是函数')
    }
    return plugin
  } finally {
    if (timer !== null) window.clearTimeout(timer)
    URL.revokeObjectURL(url)
  }
}

/** Build a plugin's context (bundled plugins reuse it; runtime plugins get it
 *  from `loadOne`). Exported so `plugins/bundled.ts` runs the same contract. */
export function createContext(pluginId: string, disposers: (() => void)[]): RuntimePluginContext {
  const source = `plugin:${pluginId}`
  const add = (fn: () => void) => disposers.push(fn)
  const storagePrefix = `mirach.plugin.${pluginId}.`

  // 上游 `ctx.i18n.register(bundles)` 是**一个参数**（`PluginLocaleBundles`），
  // 之前这里手写的是 `(locale, bundle)` 两参——bots 插件调用
  // `ctx.i18n.register(BOTS_LOCALES)` 时 bundle=undefined，注册静默变空。
  // 直接接镜像树的 createPluginI18n（usePluginI18n 读的是同一注册表）。
  // 插件卸载时要连带注销 i18n 注册——createPluginI18n 的 track 回调要求
  // （dispose) => () => void 形状，add 返回的是 length，包一层。
  const i18n = createPluginI18n(pluginId, (dispose) => {
    add(dispose)
    return () => {}
  })

  return {
    source,
    register: (contribution) => {
      // 上游契约：插件写普通 id，宿主自动命名空间化（`<id>:<localId>`）并
      // 打来源标签。bots 自己按 `host.paneVisibility('hermes-bots:pane')`
      // 探测，不前缀就永远探不到自己的窗格。
      const c = contribution as { id?: unknown }
      const scoped = {
        ...(contribution as object),
        id: `${pluginId}:${String(c.id ?? '')}`,
        source,
      }
      const dispose = registry.register(scoped as never)
      add(dispose)
      return dispose
    },
    registerMany: (contributions) => {
      const scoped = contributions.map((c) => {
        const item = c as { id?: unknown }
        return {
          ...(c as object),
          id: `${pluginId}:${String(item.id ?? '')}`,
          source,
        }
      })
      const dispose = registry.registerMany(scoped as never[])
      add(dispose)
      return dispose
    },
    registerSettingsPage: (page) => {
      const dispose = registry.register({
        ...settingsPageContribution(page as never),
        source,
      })
      add(dispose)
      return dispose
    },
    onDispose: add,
    onEvent: (type, listener) => {
      const dispose = host.onEvent(type, listener)
      add(dispose)
      return dispose
    },
    setTimeout: (fn, ms) => {
      const handle = window.setTimeout(fn, ms)
      const dispose = () => window.clearTimeout(handle)
      add(dispose)
      return dispose
    },
    setInterval: (fn, ms) => {
      const handle = window.setInterval(fn, ms)
      const dispose = () => window.clearInterval(handle)
      add(dispose)
      return dispose
    },
    addEventListener: (target, type, listener, options) => {
      target.addEventListener(type, listener, options)
      const dispose = () => target.removeEventListener(type, listener, options)
      add(dispose)
      return dispose
    },
    rest: async () => {
      throw new Error('ctx.rest: 宿主没有插件 HTTP 命名空间（plugin_api.py）')
    },
    socket: () => {
      throw new Error('ctx.socket: 宿主没有插件 WebSocket 门')
    },
    os: {
      notify: host.notify,
      notifyError: host.notifyError,
      openExternal: (url) => {
        window.open(url, '_blank', 'noopener,noreferrer')
      },
    },
    runAction: (id) => ({ ok: false, error: `host 未接线 runAction(${id})` }),
    listActions: () => [],
    storage: {
      get: (key, fallback) => {
        try {
          return window.localStorage.getItem(storagePrefix + key) ?? fallback
        } catch {
          return fallback
        }
      },
      set: (key, value) => {
        try {
          window.localStorage.setItem(storagePrefix + key, value)
        } catch (e) {
          console.error(`[plugins] ${pluginId} storage.set 失败`, e)
        }
      },
      delete: (key) => {
        try {
          window.localStorage.removeItem(storagePrefix + key)
        } catch {
          /* nonfatal */
        }
      },
    },
    i18n: {
      // RuntimePluginContext 的旧形状（t/register）保留；上游插件拿到的
      // 是这个对象的结构子集（额外字段无害）。
      t: i18n.t,
      register: i18n.register,
      onLocaleChange: i18n.onLocaleChange,
      registerAppLocale: i18n.registerAppLocale,
    },
  }
}

function unload(id: string): void {
  const entry = loaded.get(id)
  if (!entry) return
  loaded.delete(id)
  entry.dispose?.()
}

/** Load/reload one scanned plugin; errors are isolated to its inventory row. */
async function loadOne(file: PluginFile): Promise<void> {
  const previous = loaded.get(file.id)
  if (previous && previous.mtimeMs === file.mtimeMs) return
  unload(file.id)

  let plugin: RuntimePlugin | null = null
  try {
    const read = await invokeIpc<PluginSource>('plugin_runtime_read', { id: file.id })
    plugin = await importPlugin(read.source)
    const id = plugin.id
    const active = pluginActive(id, plugin.defaultEnabled !== false)

    const baseRecord: PluginRecord = {
      id,
      name: plugin.name ?? file.name,
      kind: 'disk',
      status: active ? 'loaded' : 'disabled',
      ...(plugin.description !== undefined ? { description: plugin.description } : {}),
      file: file.path,
    }

    if (active) {
      const disposers: (() => void)[] = []
      await plugin.register(createContext(id, disposers))
      const dispose = () => {
        for (const fn of [...disposers].reverse()) {
          try {
            fn()
          } catch (e) {
            console.error(`[plugins] ${id} disposer 抛错（继续清理）`, e)
          }
        }
        disposers.length = 0
      }
      loaded.set(id, { mtimeMs: read.mtimeMs, dispose })
      publishPlugin(baseRecord, {
        activate: () => loadOne({ ...file, mtimeMs: 0 }),
        deactivate: () => {
          unload(id)
          patchPlugin(id, { status: 'disabled' })
        },
      })
    } else {
      loaded.set(id, { mtimeMs: read.mtimeMs, dispose: null })
      publishPlugin(baseRecord, {
        activate: () => loadOne({ ...file, mtimeMs: 0 }),
        deactivate: () => {
          unload(id)
          patchPlugin(id, { status: 'disabled' })
        },
      })
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    console.error(`[plugins] ${file.id} 加载失败`, e)
    publishPlugin({
      id: plugin?.id ?? file.id,
      name: plugin?.name ?? file.name,
      kind: 'disk',
      status: 'error',
      error: message,
      file: file.path,
    })
  }
}

/** Scan the disk door and load/reload/remove plugins so the inventory is live. */
export async function discoverRuntimePlugins(): Promise<void> {
  if (discovering) return
  discovering = true
  try {
    const files = await invokeIpc<PluginFile[]>('plugin_runtime_scan')
    const seen = new Set<string>()
    for (const file of files) {
      seen.add(file.id)
      await loadOne(file)
    }
    // File removed on disk → dispose + drop from inventory.
    for (const id of [...loaded.keys()]) {
      if (!seen.has(id)) {
        unload(id)
        dropPlugin(id)
      }
    }
    for (const id of Object.keys($pluginRecords.get())) {
      if (!seen.has(id) && !loaded.has(id)) dropPlugin(id)
    }
  } catch (e) {
    // The owner may be a plain browser (no IPC): keep the app alive, log once.
    console.error('[plugins] 扫描运行时插件失败', e)
  } finally {
    discovering = false
  }
}

/** Poll mtime so a saved plugin.js hot-reloads without a restart. */
export function startRuntimePluginWatch(): void {
  if (pollTimer !== null) return
  pollTimer = window.setInterval(() => {
    void discoverRuntimePlugins()
  }, POLL_INTERVAL_MS)
}

export async function stopRuntimePluginWatch(): Promise<void> {
  if (pollTimer !== null) {
    window.clearInterval(pollTimer)
    pollTimer = null
  }
}

/** Install a plugin source into the disk door and hot-load it immediately. */
export async function installRuntimePlugin(
  id: string,
  source: string,
  name?: string,
): Promise<void> {
  await invokeIpc<string>('plugin_runtime_write', { id, source, name })
  await discoverRuntimePlugins()
}

/** Uninstall (remove the plugin folder) + dispose in-memory registrations. */
export async function uninstallDiskPlugin(
  pluginId: string,
): Promise<{ error?: string; ok: boolean }> {
  try {
    unload(pluginId)
    await invokeIpc('plugin_runtime_uninstall', { id: pluginId })
    dropPlugin(pluginId)
    return { ok: true }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e), ok: false }
  }
}

/** Folder the user/agent drops `plugin.js` into (for the inventory "reveal"). */
export async function pluginRuntimeRoot(): Promise<string> {
  return invokeIpc<string>('plugin_runtime_root')
}

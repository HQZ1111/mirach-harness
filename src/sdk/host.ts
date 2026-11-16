/**
 * `@hermes/plugin-sdk` 的宿主对偶 —— `host` 数据面。
 *
 * ## 上游是什么
 *
 * 上游 `host` 是插件访问宿主能力的**唯一门**（`apps/desktop/src/sdk/index.ts:559`
 * 起，1,000+ 行）。它把 30+ 个方法收敛成一个对象，插件不直接碰 store 或 REST。
 *
 * ## 宿主（Mirach）怎么对偶
 *
 * Mirach 是单用户桌面端 + 单引擎（rpi），没有 hermes 的多 profile / 多连接 /
 * WebSocket 网关。所以这份实现的原则是：
 *
 * 1. **有的照实接线**：`state` 的 8 个字段接宿主真实 atom；`request` 接 IPC
 * 2. **没有的给安全默认 + 明确注释**：不编造行为，不假成功
 * 3. **插件生命周期类方法是空实现 + 注释**：宿主不需要 warm/retain/ensure
 *    （没有远程 profile 要预热）
 *
 * ## 为什么这些"空实现"不是偷懒
 *
 * 上游那些方法（`warmProfile` / `retainProfileSocket` / `dropLeftoverProfilePrefs`）
 * 存在的理由是**hermes 有多台网关、多个 profile、需要预热 socket**。Mirach 只有
 * 一个进程内引擎，这些概念不存在。给空实现比伪造行为更诚实。
 *
 * 凡是**语义上应该有**但宿主确实没有的（如 `profileRoutes`），返回空数组而不是
 * 假数据，让上游代码自然走"没有对端"的分支。
 */

import { atom, type Atom } from 'nanostores'

import { queryClient } from '@/hermes-shim/lib/query-client'
import { $pluginDecisions } from '@/hermes-shim/contrib/plugins-store'
import type { RpcEvent } from './types'

/** 上游 `host.agents()` 的 UnionRoster 形状（单机 = 一个 local source）。 */
interface HostRosterSource {
  id?: string
  kind: 'local' | 'remote'
  label?: string
}

interface HostRosterAgent {
  connectionId: string
  connectionKind: 'local' | 'remote'
  connectionLabel?: string
  profile: string
  targetProfile?: string
  [key: string]: unknown
}

interface HostRoster {
  sources: HostRosterSource[]
  agents: HostRosterAgent[]
}

interface HostProfileRoute {
  connectionId: string
  mode: 'local' | 'remote'
  profile: string
  targetProfile: string
  primary?: true
}

// ── host.state：8 个字段（bots 实际用到的）──────────────────────────────────

/**
 * 当前活动会话的运行时 id（宿主草稿态为 null）。
 *
 * 宿主对应：`sessionCatalog` 的活动会话。为避免把 zustand store 拖进来，
 * 这里用独立 atom，由面板挂载时同步。
 */
export const $hostActiveSessionId = atom<null | string>(null)

/** 聚焦会话的存储 id（用于会话列表匹配）。 */
export const $hostFocusedStoredSessionId = atom<null | string>(null)

/** 聚焦会话的 owner profile（宿主单身份，恒 'local'）。 */
export const $hostFocusedSessionProfile = atom<string>('local')

/** 聚焦会话的完整 owner（连接限定；宿主无多连接，故 id 与 profile 同源）。 */
export const $hostFocusedSessionOwner = atom<null | { connectionId: string; profile: string }>(null)

/** 活动连接 id（宿主单引擎，恒 'local'）。 */
export const $hostConnectionId = atom<null | string>('local')

/** 活动 gateway 状态（宿主无 gateway socket，恒 'open' 表示引擎可用）。 */
export const $hostGatewayState = atom<string>('open')

/** 聚焦会话是否在忙。 */
export const $hostBusy = atom<boolean>(false)

/** 当前 profile（宿主单身份）。 */
export const $hostProfile = atom<string>('local')

// ── host 对象 ───────────────────────────────────────────────────────────────

/** paneId → live 可见性 atom（MutationObserver 驱动；同 id 复用）。 */
const paneAtoms = new Map<string, { atom: Atom<boolean>; update: () => void }>()
let paneObserver: MutationObserver | null = null

function paneVisibilityAtom(paneId: string): Atom<boolean> {
  const existing = paneAtoms.get(paneId)
  if (existing) return existing.atom

  const selector = `[data-panel-id="${paneId}"]`
  const atomRef = atom(false)
  const update = () => atomRef.set(Boolean(document.querySelector(selector)))
  update()
  paneAtoms.set(paneId, { atom: atomRef, update })

  if (typeof MutationObserver !== 'undefined') {
    paneObserver ??= new MutationObserver(() => {
      for (const entry of paneAtoms.values()) entry.update()
    })
    paneObserver.observe(document.documentElement, { childList: true, subtree: true })
  }

  return atomRef
}

export const host = {
  /** 上行状态面（8 个字段，全部接宿主真实 atom）。 */
  state: {
    activeSessionId: $hostActiveSessionId,
    busy: $hostBusy,
    connectionId: $hostConnectionId,
    focusedSessionOwner: $hostFocusedSessionOwner,
    focusedSessionProfile: $hostFocusedSessionProfile,
    focusedStoredSessionId: $hostFocusedStoredSessionId,
    gateway: $hostGatewayState,
    profile: $hostProfile,
  },

  /** 活动连接 id。 */
  activeConnectionId: (): null | string => $hostConnectionId.get(),

  /**
   * 已注册的连接列表。
   *
   * 宿主对应：`pi_connections_*`（多 provider 连接）。这里返回**宿主真实数据**。
   */
  connections: async (): Promise<{ connections: unknown[] }> => {
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const list = await invoke<unknown[]>('pi_connections_list')
      return { connections: Array.isArray(list) ? list : [] }
    } catch {
      return { connections: [] }
    }
  },

  /**
   * Agent（机器人）名册。
   *
   * 宿主对应：`pi_hub_roster`。返回空数组时上游会自然走"无名册"分支。
   */
  agents: async (): Promise<HostRoster> => {
    // 单机引擎：一个 local source。subagent 的 `pi_hub_roster` 不是 profile
    // 名册（见上游 UnionRoster 语义），不能混用；robots 的行来自
    // `profiles.list`，这里只需给出"唯一本地 source"的拓扑。
    return {
      sources: [{ id: 'local', kind: 'local', label: '本机' }],
      agents: [],
    }
  },

  /**
   * profile 路由表。
   *
   * **宿主没有多网关 profile 路由**，返回空数组：上游 `_roster_siblings()`
   * 拿到空表会自然走单机分支。
   */
  profileRoutes: async (): Promise<HostProfileRoute[]> => [],

  /**
   * 面板可见性。宿主读实际 DOM 存在性（含已关闭的栏）。
   *
   * 窗格宿主（`PluginPane`）给根节点打 `data-panel-id="<plugin>:<pane>"`；
   * 这里用 MutationObserver 维护 live atom——`computed(atom(0), …)` 会在
   * 首次求值后永久缓存，上游 `.listen()` 永远收不到翻转（例程窗格就永远
   * 注册不上）。
   */
  paneVisibility: (paneId: string) => paneVisibilityAtom(paneId),

  /** 系统通知（原生）。宿主走 Tauri notification 或退化为 in-app toast。 */
  notify: (input: { kind?: string; message: string }) => {
    // 宿主暂无统一 toast store，走 console + 原生通知（若可用）
    const level = input.kind === 'error' ? 'error' : 'info'
    console[level === 'error' ? 'error' : 'log'](`[bots] ${input.message}`)
    if (typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'granted') {
      new Notification('Mirach', { body: input.message })
    }
  },

  /**
   * 错误通知（上游**双参**：错误对象 + 人读文案）。
   *
   * 上游签名 `notifyError(error, message)`——两个参数都要：UI 显示 message，
   * 日志留 error 栈。只收一个参数会让上游 20+ 个调用点报 "Expected 1
   * arguments, but got 2"。
   */
  notifyError: (error: unknown, message?: string) => {
    const text = message ?? (error instanceof Error ? error.message : String(error))
    console.error(`[bots] ${text}`, error)
  },

  /**
   * 订阅宿主事件。
   *
   * 宿主对应：Tauri 的 `listen`。返回退订函数。
   */
  /**
   * 订阅网关 RPC 事件。
   *
   * **回调参数是 RpcEvent 而不是裸 payload**（上游  的
   * socket 事件形状：）。上游 20+ 个
   * 调用点写成 ，收窄成 unknown 会让它们全报错。
   */
  onEvent: (name: string, handler: (event: RpcEvent) => void): (() => void) => {
    // Tauri 的 listen 只接受 [A-Za-z0-9_:/‑] 事件名；上游网关事件名带点
    // （`tool.start` / `session.reclaimed`）。映射成 `mirach:plugin:tool:start`，
    // 宿主侧没有生产者时订阅是空操作（不报错），有生产者时按同名通道发。
    const channel = `mirach:plugin:${name.replace(/[^A-Za-z0-9_:\/-]/g, ':')}`
    let unlisten: (() => void) | null = null
    let cancelled = false
    void (async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event')
        const off = await listen(channel, (event) =>
          handler({ type: name, payload: event.payload } as RpcEvent)
        )
        if (cancelled) off()
        else unlisten = off
      } catch (e) {
        console.error(`[bots] onEvent(${name}) 订阅失败`, e)
      }
    })()
    return () => {
      cancelled = true
      unlisten?.()
    }
  },

  /**
   * 网关 RPC。**这是宿主最重要的对偶**。
   *
   * 上游：`gateway.request(method, params)` → hermes Python 后端。
   * 宿主：`host-rpc.ts` 的分发表（profiles/session/cron/skills/cli/groups）。
   * 未接线的方法**明确 throw**（规矩 12），上游按自己的 feature-detect 走
   * "旧网关"分支。
   */
  request: async <T>(method: string, params: Record<string, unknown> = {}, _timeoutMs?: number): Promise<T> => {
    const { dispatchHostRequest } = await import('./host-rpc')
    return dispatchHostRequest<T>(method, params)
  },

  /**
   * 定向到某 profile 的 RPC。
   *
   * 宿主单身份（全部 bot 都是本机 profile），等价于 `request`；route 的
   * profile 语义已由调用方塞进 params（routing.ts 的 scopedBotParams）。
   */
  requestProfile: async <T>(_route: unknown, method: string, params: Record<string, unknown> = {}): Promise<T> => {
    const { dispatchHostRequest } = await import('./host-rpc')
    return dispatchHostRequest<T>(method, params)
  },

  /** 当前活跃的 gateway 实例（宿主无 gateway 对象，返回 null）。 */
  getGateway: (): null => null,

  /** 打开一个已存储的会话（宿主走 runtime 的会话切换桥）。 */
  openSession: async (storedSessionId: string, _options?: unknown): Promise<void> => {
    const { openStoredSessionBridge } = await import(
      '@/components/panes/session-manage/session-tab-bridge'
    )
    openStoredSessionBridge(storedSessionId)
  },

  /** 新建聊天。`profile` 在上游是 route 描述符或 profile 名——宿主按 bot 名
   *  解析（有 bot 预设就带人格/模型开一条新会话，否则普通新会话）。 */
  newChat: (profile?: null | string | { profile?: string; targetProfile?: string }, options: Record<string, unknown> = {}): void => {
    const name =
      typeof profile === 'string'
        ? profile
        : String(profile?.targetProfile ?? profile?.profile ?? '')
    void (async () => {
      try {
        const { dispatchHostRequest } = await import('./host-rpc')
        const created = await dispatchHostRequest<{ stored_session_id: string }>('session.create', {
          profile: name || 'default',
          title: typeof options.tabTitle === 'string' ? options.tabTitle : '',
        })
        const { openStoredSessionBridge } = await import(
          '@/components/panes/session-manage/session-tab-bridge'
        )
        openStoredSessionBridge(created.stored_session_id)
      } catch (e) {
        console.error('[host] newChat 失败', e)
      }
    })()
  },

  /** 打开工作区。 */
  openWorkspace: (id: string, options?: Record<string, unknown>): void => {
    window.dispatchEvent(new CustomEvent('mirach:open-workspace', { detail: { id, ...options } }))
  },

  /** 打开面板（宿主 dockview）。 */
  revealPane: (paneId: string): void => {
    window.dispatchEvent(new CustomEvent('mirach:reveal-pane', { detail: paneId }))
  },

  /** 取消面板的持久化关闭状态。 */
  undismissPane: (paneId: string): void => {
    window.dispatchEvent(new CustomEvent('mirach:undismiss-pane', { detail: paneId }))
  },

  /** 导航（宿主路由）。 */
  navigate: (target: string): void => {
    window.dispatchEvent(new CustomEvent('mirach:navigate', { detail: target }))
  },

  /**
   * 列出已持久化的会话（上游扫描面：`{ sessions: [...] }`）。
   *
   * 形状对齐 `session.list`：插件按 `storedSessionId` / `title` 读。
   */
  listPersistedSessions: async (_route?: unknown, options?: { limit?: number }): Promise<{ sessions: unknown[] }> => {
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const list = await invoke<{ id: string; name: null | string; path: string }[]>('pi_list_sessions')
      const limit = options?.limit && options.limit > 0 ? options.limit : undefined
      const rows = (Array.isArray(list) ? list : []).slice(0, limit)
      return {
        sessions: rows.map((row) => ({
          id: row.id,
          storedSessionId: row.id,
          title: row.name ?? '',
          name: row.name ?? '',
          path: row.path,
        })),
      }
    } catch (e) {
      // 读取失败要可见（规矩 12）——上游扫描据此决定隐藏集合，静默空表会
      // 让 Bot Mode 会话在侧栏露出来。
      console.error('[host] listPersistedSessions 失败', e)
      throw e
    }
  },

  /** 把会话标记为持久隐藏。宿主没有 hidden 会话面：canonical Bot Chat 由
   *  `session.create` 记双锚进 bots-store，侧栏按路径集过滤；这里接住上游
   *  的扫描调用，未识别的 id 不做假动作（不写任何"已隐藏"的谎）。 */
  setPersistedSessionHidden: (_route: unknown, args?: { hidden?: boolean; sessionId?: string }): void => {
    if (args?.hidden === false) return
    // 双锚已在 create 时记录；这里只处理"同一 bot 的另一条会话"——
    // 宿主侧没有通用隐藏面，故不冒充已隐藏。
    console.debug('[host] setPersistedSessionHidden 忽略（宿主无双锚外隐藏面）', args?.sessionId)
  },

  /** 聚焦一个已打开的工作区会话。 */
  focusOpenWorkspaceSession: (_args: unknown): void => {},

  /** 换工作区作用域。 */
  setWorkspaceScope: (_args: unknown): void => {},

  /** 设置工作区 owner 标签。 */
  setWorkspaceOwnerLabel: (_args: unknown): void => {},

  // ── 以下方法在宿主没有对应概念，全部空实现 + 注释 ──────────────────────────
  //
  // 上游这些方法的共同前提是「多台网关 + 远程 profile 需要预热/保活/清理」。
  // Mirach 是单进程单引擎，profile 是本地概念、socket 不存在、也没有"遗留偏好"
  // 这类跨设备状态。空实现是这里最诚实的处理：调用方拿到 undefined 继续跑，
  // 不会因为等待一个永远不会发生的事件而挂起。

  /** 预热 profile（宿主无远程 profile）。上游签名 。 */
  warmProfile: (_connectionId?: unknown, _profile?: unknown): void => {},
  /** 预热 agent（同上）。上游签名 。 */
  warmAgent: (_connectionId?: unknown, _name?: unknown): void => {},
  /** 确保 agent 存在（同上）。上游签名 。 */
  ensureAgent: (_connectionId?: unknown, _name?: unknown): void => {},
  /** 保有 profile 引用计数（宿主无此生命周期）。上游签名 。 */
  retainProfile: (_connectionId?: unknown, _profile?: unknown): void => {},
  /** 保有 profile socket（宿主无 socket）：仍然返回释放函数，调用方会
   *  `release()`，返回 void 会在运行时炸。 */
  retainProfileSocket: (_connectionId?: unknown, _profile?: unknown): (() => void) => () => {},
  /** 删除 profile（宿主 profile 由设置页管理）。 */
  deleteProfile: async (_profile: unknown): Promise<void> => {
    throw new Error('host.deleteProfile: 宿主 profile 由设置页管理，插件不可删')
  },
  /** 清理遗留 profile 偏好（宿主无跨设备遗留态）。 */
  dropLeftoverProfilePrefs: (_args: unknown): void => {},
  /** 完成 MCP OAuth（宿主走设置页）。 */
  completeMcpOAuth: async (_args: unknown): Promise<void> => {
    throw new Error('host.completeMcpOAuth: 宿主 MCP OAuth 在设置页完成')
  },
  /** 插件开关决策。上游是 atom（`host.pluginDecisions.get()` / 订阅）；
   *  这里直接接宿主 plugins-store 的同一 atom（设置页开关即生效）。 */
  pluginDecisions: $pluginDecisions,
  /** 身份变更追踪（诊断用，宿主写 console）。 */
  traceIdentityChange: (category: string, tag: string, detail?: string): void => {
    console.debug(`[bots] ${category} ${tag} ${detail ?? ''}`)
  },
} as const
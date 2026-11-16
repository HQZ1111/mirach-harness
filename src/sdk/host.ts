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
import type { ReactNode } from 'react'

import { queryClient } from '@/hermes-shim/lib/query-client'
import { $pluginDecisions } from '@/hermes-shim/contrib/plugins-store'
import { openPluginWorkspace } from '@/components/layout/plugin-workspaces'
import type { RpcEvent } from './types'

/** 上游 `host.agents()` 的 UnionRoster 形状（单机 = 一个 local source）。
 *  source 字段名与上游一致：`connectionId`（插件按它建源索引）。 */
interface HostRosterSource {
  connectionId: string
  kind: 'local' | 'remote'
  label?: string
  reachable?: boolean
  [key: string]: unknown
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
   * 上游 = 所有连接上的 (connectionId, profile) 并集；宿主单连接，agent
   * 就是本地 bots-store 的行（profiles.list 的**同一份真相**）。返回真实
   * 行而不是空表：上游 roster 构建（data.ts buildUnionRoster）用这张表给
   * profiles.list 的行**标注 route/sourceScoped**——requestForBot 之后才会
   * 走 `host.requestProfile(route, …)`，宿主才能从 route 里拿到成员
   * profile（群聊 prompt.submit 的成员身份就靠它）。空表会让所有行停留
   * not_scoped，成员身份在 RPC 参数里彻底丢失。
   */
  agents: async (): Promise<HostRoster> => {
    try {
      const { botsStore } = await import('@/components/panes/hub/bots-store')
      if (!botsStore.getState().bots.length) botsStore.getState().load()
      const agents = botsStore.getState().bots.map((bot) => ({
        connectionId: 'local',
        connectionKind: 'local' as const,
        connectionLabel: '本机',
        profile: bot.name,
        targetProfile: bot.name,
        handle: bot.name,
        title: bot.title,
      }))
      // sources 形状照上游（`{ connectionId, kind, label, reachable }`）——
      // 插件用 `sourceByConnection(sources)` 按 **connectionId** 建索引做
      // 源健康标注（`annotateBotSource`）；写成 `{id}` 会让索引恒空，
      // 所有 sourceScoped 行被标成"网关已移除"（实测：机器人群聊里
      // 2 个中 0 个可用 + 行尾红字）。
      return {
        sources: [{ connectionId: 'local', kind: 'local' as const, label: '本机', reachable: true }],
        agents,
      }
    } catch (e) {
      console.error('[host] agents() 读取 bot 名册失败', e)
      throw e
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
    //
    // 信封字段：上游把 `session_id` / `connectionId` / `profile` 打在
    // **envelope** 上（不在 payload 里），订阅方按 `event.session_id` 筛
    // 自己的会话（group-turns 的 waitForTurnSignal / screen-autoraise 的
    // 归属判定）。宿主的生产者（pi_bot 泳道）把这三个键放在 payload 里，
    // 这里原样提升到信封（副键保留在 payload 中，两处都能读到）。
    const channel = `mirach:plugin:${name.replace(/[^A-Za-z0-9_:\/-]/g, ':')}`
    let unlisten: (() => void) | null = null
    let cancelled = false
    void (async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event')
        const off = await listen(channel, (event) => {
          const raw = event.payload
          const payload =
            raw !== null && typeof raw === 'object' && !Array.isArray(raw)
              ? (raw as Record<string, unknown>)
              : undefined
          handler({
            type: name,
            payload: raw,
            ...(typeof payload?.session_id === 'string' ? { session_id: payload.session_id } : {}),
            ...(typeof payload?.connectionId === 'string' ? { connectionId: payload.connectionId } : {}),
            ...(typeof payload?.profile === 'string' ? { profile: payload.profile } : {}),
          } as RpcEvent)
        })
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
   * 宿主单身份（全部 bot 都是本机 profile），落同一个分发表；但 **route 的
   * profile 必须并进 params**——上游 requestForBot 对 sourceScoped 行只传
   * route，不带 `profile` 参数（scopedBotParams 仅在 params 已有该键时改写）。
   * 群聊成员轮次的 prompt.submit / 附件 / 审批都要靠这个 profile 找到 bot
   * 预设（人格/模型/工具集）。route 缺 profile 时原样透传（不猜）。
   */
  requestProfile: async <T>(route: unknown, method: string, params: Record<string, unknown> = {}): Promise<T> => {
    const { dispatchHostRequest } = await import('./host-rpc')
    const r = route as null | { profile?: unknown; targetProfile?: unknown }
    const profile =
      typeof r?.targetProfile === 'string' && r.targetProfile
        ? r.targetProfile
        : typeof r?.profile === 'string'
          ? r.profile
          : ''
    const merged = profile && params.profile === undefined ? { ...params, profile } : params
    return dispatchHostRequest<T>(method, merged)
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

  /**
   * 打开工作区（上游 `host.openWorkspace`：主区标签页 + **返回关闭函数**）。
   *
   * 上游返回契约是 close：`const close = host.openWorkspace(id, {...})`，
   * 插件把它存进 main-tab 记录用于程序化关闭（hermes-bots 的群聊房间即此
   * 门——`group-chat-view.tsx::openGroupChat`）。宿主实现 = 主区 dockview
   * 面板（`plugin-workspaces.ts`），不用再派发无人监听的自定义事件。
   */
  openWorkspace: (id: string, options?: Record<string, unknown>): (() => void) => {
    return openPluginWorkspace(id, {
      title: typeof options?.title === 'string' ? options.title : undefined,
      render: typeof options?.render === 'function' ? (options.render as () => ReactNode) : undefined,
      onClose: typeof options?.onClose === 'function' ? (options.onClose as () => void) : undefined,
      minWidth: typeof options?.minWidth === 'string' ? options.minWidth : undefined,
    })
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
      const list = await invoke<
        { id: string; name: null | string; path: string; lastModifiedMs?: number }[]
      >('pi_list_sessions')
      const limit = options?.limit && options.limit > 0 ? options.limit : undefined
      const rows = (Array.isArray(list) ? list : []).slice(0, limit)
      return {
        sessions: rows.map((row) => ({
          id: row.id,
          storedSessionId: row.id,
          title: row.name ?? '',
          name: row.name ?? '',
          path: row.path,
          // 秒级启动时间（上游 session.list 的 started_at 口径）——Bot Mode
          // 的标题清扫（session-sweep.ts 的 isBotModeSweepCandidate）用它做
          // 5 分钟宽限判定；缺字段会被 fail-closed 跳过（等于永不清扫）。
          started_at:
            typeof row.lastModifiedMs === 'number' && row.lastModifiedMs > 0
              ? Math.floor(row.lastModifiedMs / 1000)
              : undefined,
        })),
      }
    } catch (e) {
      // 读取失败要可见（规矩 12）——上游扫描据此决定隐藏集合，静默空表会
      // 让 Bot Mode 会话在侧栏露出来。
      console.error('[host] listPersistedSessions 失败', e)
      throw e
    }
  },

  /** 把会话标记为持久隐藏（写入宿主 hidden-sessions 路径集，侧栏过滤）。
   *  会话 id → 路径经 pi_list_sessions 解析；解析不到（id 在别的工作区）时
   *  用 pi_sessions_index 兜一道，仍找不到 = console.error（不静默假装已藏）。 */
  setPersistedSessionHidden: (_route: unknown, args?: { hidden?: boolean; sessionId?: string }): void => {
    const sessionId = typeof args?.sessionId === 'string' ? args.sessionId.trim() : ''
    if (!sessionId) return
    void (async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        const merged = new Map<string, { id: string; path: string }>()
        const index = await invoke<{ sessions?: { id: string; path: string }[] }>('pi_sessions_index')
        for (const row of index?.sessions ?? []) {
          if (row?.id && row?.path) merged.set(row.id, row)
        }
        if (!merged.has(sessionId)) {
          const list = await invoke<{ id: string; path: string }[]>('pi_list_sessions')
          for (const row of list ?? []) {
            if (row?.id && row?.path && !merged.has(row.id)) merged.set(row.id, row)
          }
        }
        const row = merged.get(sessionId)
        if (!row) {
          console.error(`[host] setPersistedSessionHidden: 会话 ${sessionId} 不在任何会话根——未隐藏`)
          return
        }
        const { hiddenSessionsStore } = await import('@/components/panes/hub/hidden-sessions')
        if (args?.hidden === false) hiddenSessionsStore.getState().show(row.path)
        else hiddenSessionsStore.getState().hide(row.path)
      } catch (e) {
        console.error('[host] setPersistedSessionHidden 失败', e)
      }
    })()
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
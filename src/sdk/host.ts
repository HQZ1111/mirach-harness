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

// ── 远程连接名册（跨网关，2026-11-18）───────────────────────────────────────
//
// 注册表里 kind=remote/cloud/ssh 且带 url 的连接 = 远端网关。按需建连
// （pi_gateway_*，JSON-RPC over WS /api/ws），拉 profiles.list 供 roster /
// profileRoutes 合并。缓存 30s；瞬时失败沿用旧值（hermes relay.ts 的同款
// 纪律——否则一次 RPC 抖动会把活着的机器报成离线）。

interface RemoteRosterProfile {
  name: string
  title: string
  description: string
}

interface RemoteRoster {
  connectionId: string
  label: string
  kind: 'remote'
  profiles: RemoteRosterProfile[]
  /** 对端网关的 `/api/status` install_id（peer 成员的 pinned 身份）。 */
  installId?: string
  /** 连接 URL（hermes 网关 WS / mirach peer HTTP 共用这个入口）。 */
  url?: string
  fetchedAt: number
}

const remoteRosterCache = new Map<string, RemoteRoster>()
const REMOTE_ROSTER_TTL_MS = 30_000
/** 已确认走 mirach peer 原生 HTTP 面的连接（connectionId → url）。 */
const peerTransports = new Map<string, string>()

async function tauriCore() {
  return import('@tauri-apps/api/core')
}

/** 远端调用：先按 hermes 网关 WS 发；失败且知道 url 时探一次 peer 面并改用
 *  peer HTTP（对端若是 mirach，profiles.list 在 WS 侧永远不是 hermes 帧）。
 *  两边都失败时抛原始网关错误，信息不丢（规矩 12）。 */
async function remoteInvoke<T>(
  connectionId: string,
  url: null | string | undefined,
  method: string,
  params: Record<string, unknown>,
  timeoutMs: number,
): Promise<T> {
  const { invoke } = await tauriCore()
  const peerUrl = peerTransports.get(connectionId)
  if (peerUrl) {
    return invoke<T>('pi_peer_call', { connectionId, method, params, timeoutMs })
  }
  try {
    return await invoke<T>('pi_gateway_call', { connectionId, method, params, timeoutMs })
  } catch (error) {
    if (!url) throw error
    try {
      await invoke('pi_peer_connect', { connectionId, url })
    } catch {
      throw error
    }
    peerTransports.set(connectionId, url)
    return invoke<T>('pi_peer_call', { connectionId, method, params, timeoutMs })
  }
}

async function remoteConnections(): Promise<
  Array<{ id: string; label?: string; kind?: string; url?: string }>
> {
  try {
    const { invoke } = await tauriCore()
    const registry = await invoke<{ primary?: string; connections?: unknown }>('pi_connections_list')
    const rows = Array.isArray(registry?.connections) ? registry.connections : []
    return rows
      .map((row) => row as Record<string, unknown>)
      .filter(
        (row) =>
          typeof row.id === 'string' &&
          row.id !== 'local' &&
          typeof row.url === 'string' &&
          String(row.url).trim() !== '' &&
          (row.kind === 'remote' || row.kind === 'cloud' || row.kind === 'ssh'),
      )
      .map((row) => ({
        id: String(row.id),
        label: typeof row.label === 'string' ? row.label : undefined,
        kind: typeof row.kind === 'string' ? row.kind : undefined,
        url: typeof row.url === 'string' ? row.url : undefined,
      }))
  } catch (e) {
    console.error('[host] 读取远程连接失败', e)
    return []
  }
}

async function refreshRemoteRosters(force = false): Promise<RemoteRoster[]> {
  const connections = await remoteConnections()
  const out: RemoteRoster[] = []
  for (const connection of connections) {
    const cached = remoteRosterCache.get(connection.id)
    if (!force && cached && Date.now() - cached.fetchedAt < REMOTE_ROSTER_TTL_MS) {
      out.push(cached)
      continue
    }
    try {
      const { invoke } = await tauriCore()
      let statusMap = await invoke<Record<string, { state?: string }>>('pi_gateway_status')
      if (statusMap?.[connection.id]?.state !== 'open') {
        // token: null = 由 Rust 侧取该连接在 OS 凭据管理器里存的 token
        // （连接页可录入/清除；token 永不回显到前端）。
        try {
          await invoke('pi_gateway_connect', {
            connectionId: connection.id,
            url: connection.url,
            token: null,
          })
          // gateway.ready 之前 profiles.list 会被拒；等就绪（≤10s）。
          for (let i = 0; i < 50; i += 1) {
            await new Promise((resolve) => setTimeout(resolve, 200))
            statusMap = await invoke<Record<string, { state?: string }>>('pi_gateway_status')
            if (statusMap?.[connection.id]?.state === 'open') break
          }
        } catch (e) {
          // 对端可能不是 hermes 网关而是 mirach peer：交给 remoteInvoke
          // 探 peer 面（探不到时抛原始网关错误）。
          console.error(`[host] 远程网关 ${connection.id} WS 连接失败，尝试 peer 面`, e)
        }
      }
      const res = await remoteInvoke<{ profiles?: Array<Record<string, unknown>>; install_id?: unknown }>(
        connection.id,
        connection.url,
        'profiles.list',
        { include_sessions: false },
        15_000,
      )
      const profiles: RemoteRosterProfile[] = []
      for (const profile of res?.profiles ?? []) {
        const name = typeof profile?.name === 'string' ? profile.name : ''
        if (!name) continue
        profiles.push({
          name,
          title:
            typeof profile?.display_name === 'string'
              ? profile.display_name
              : typeof profile?.title === 'string'
                ? profile.title
                : '',
          description: typeof profile?.description === 'string' ? profile.description : '',
        })
      }
      const roster: RemoteRoster = {
        connectionId: connection.id,
        label: connection.label || connection.id,
        kind: 'remote',
        profiles,
        ...(typeof res?.install_id === 'string' && res.install_id ? { installId: res.install_id } : {}),
        ...(connection.url ? { url: connection.url } : {}),
        fetchedAt: Date.now(),
      }
      remoteRosterCache.set(connection.id, roster)
      out.push(roster)
    } catch (e) {
      console.error(`[host] 远程网关 ${connection.id} 名册拉取失败（沿用上次快照）`, e)
      if (cached) out.push(cached)
    }
  }
  const live = new Set(connections.map((connection) => connection.id))
  for (const id of [...remoteRosterCache.keys()]) {
    if (!live.has(id)) remoteRosterCache.delete(id)
  }
  return out
}

/** 把本机名册发布给 peer 服务（对端拉 profiles.list 时看到的就是它）。 */
async function publishPeerBots(agents: ReadonlyArray<HostRosterAgent>): Promise<void> {
  try {
    const { invoke } = await tauriCore()
    await invoke('pi_peer_publish_bots', {
      bots: agents.map((agent) => ({
        name: agent.profile,
        title: agent.title ?? '',
        description: '',
      })),
    })
  } catch (e) {
    console.error('[host] peer 名册发布失败（对端将看不到本机 bot）', e)
  }
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
   * 宿主对应：`pi_connections_*` 注册表（hermes electron connection-registry
   * v2 同形）。**契约是裸数组**（relay.ts `connectionLabels()` 直接
   * `Array.isArray(rows)`；create-dialog 也接受注册表包封形状）。此前这里把
   * Rust 返回的 `{version,primary,connections}` 当数组读 → 恒空表，
   * relay 的查看/推送全部静默停摆（2026-11-18 审计实锤修）。
   */
  connections: async (): Promise<
    Array<{ id: string; label?: string; primary?: boolean; kind?: string; url?: string }>
  > => {
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const registry = await invoke<{ primary?: string; connections?: unknown }>(
        'pi_connections_list',
      )
      const rows = Array.isArray(registry?.connections) ? registry.connections : []
      const out: Array<{ id: string; label?: string; primary?: boolean; kind?: string; url?: string }> = []
      for (const row of rows) {
        if (!row || typeof row !== 'object') continue
        const record = row as Record<string, unknown>
        const id = String(record.id ?? '').trim()
        if (!id) continue
        out.push({
          id,
          ...(typeof record.label === 'string' && record.label.trim()
            ? { label: record.label }
            : {}),
          ...(id === (registry?.primary ?? 'local') ? { primary: true } : {}),
          ...(typeof record.kind === 'string' ? { kind: record.kind } : {}),
          ...(typeof record.url === 'string' ? { url: record.url } : {}),
        })
      }
      return out
    } catch (e) {
      console.error('[host] connections() 读取连接注册表失败', e)
      return []
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
      const agents: HostRosterAgent[] = botsStore.getState().bots.map((bot) => ({
        connectionId: 'local',
        connectionKind: 'local' as const,
        connectionLabel: '本机',
        profile: bot.name,
        targetProfile: bot.name,
        handle: bot.name,
        title: bot.title,
        // 上游 buildUnionRoster 的行形状：没有 sourceScoped/route 的行在插件里
        // 恒 not_scoped（peer 成员/群聊成员身份都依赖它）。
        sourceScoped: true,
        sourceReachable: true,
        remoteSource: false,
        route: { connectionId: 'local', mode: 'local' as const, profile: bot.name, targetProfile: bot.name },
      }))
      // 跨网关并集（2026-11-18）：远端网关的 profiles.list 行并入同一张
      // 名册——上游 buildUnionRoster 的 (connectionId, profile) 并集语义。
      const remotes = await refreshRemoteRosters()
      for (const remote of remotes) {
        for (const profile of remote.profiles) {
          agents.push({
            connectionId: remote.connectionId,
            connectionKind: 'remote' as const,
            connectionLabel: remote.label,
            profile: profile.name,
            targetProfile: profile.name,
            handle: profile.name,
            title: profile.title,
            sourceScoped: true,
            sourceReachable: true,
            remoteSource: true,
            ...(remote.installId ? { installId: remote.installId } : {}),
            route: {
              connectionId: remote.connectionId,
              mode: 'remote' as const,
              profile: profile.name,
              targetProfile: profile.name,
            },
          })
        }
      }
      // sources 形状照上游（`{ connectionId, kind, label, reachable }`）——
      // 插件用 `sourceByConnection(sources)` 按 **connectionId** 建索引做
      // 源健康标注（`annotateBotSource`）；写成 `{id}` 会让索引恒空，
      // 所有 sourceScoped 行被标成"网关已移除"（实测：机器人群聊里
      // 2 个中 0 个可用 + 行尾红字）。
      // 本机名册发布给 peer 面（对端 canonical 房间拉 profiles.list 才能看到它们）。
      void publishPeerBots(agents)
      return {
        sources: [
          { connectionId: 'local', kind: 'local' as const, label: '本机', reachable: true },
          ...remotes.map((remote) => ({
            connectionId: remote.connectionId,
            kind: 'remote' as const,
            label: remote.label,
            reachable: true,
          })),
        ],
        agents,
      }
    } catch (e) {
      console.error('[host] agents() 读取 bot 名册失败', e)
      throw e
    }
  },

  /**
   * profile 路由表（hermes `buildRegistryProfileRoutes` 的宿主对偶：
   * 每个 (connectionId, profile) 名册行一条路由）。
   *
   * 本地连接 `local` 是注册表 primary，每只机器人一个 profile；relay.ts 用它
   * 建 peer 集合、drain/投递/推送名册。远程连接的路由在 transport
   * （`pi_gateway_*`）接通后从这里追加——**跨网关是 bots 的核心**，
   * 见 docs/bots-port-gaps.md。
   */
  profileRoutes: async (): Promise<HostProfileRoute[]> => {
    try {
      const { botsStore } = await import('@/components/panes/hub/bots-store')
      if (!botsStore.getState().bots.length) botsStore.getState().load()
      const routes: HostProfileRoute[] = botsStore.getState().bots.map((bot) => ({
        connectionId: 'local',
        mode: 'local' as const,
        primary: true as const,
        profile: bot.name,
        targetProfile: bot.name,
      }))
      // 远端网关的 profile 各一条 remote 路由（跨网关 relay / 会话路由）。
      const remotes = await refreshRemoteRosters()
      for (const remote of remotes) {
        for (const profile of remote.profiles) {
          routes.push({
            connectionId: remote.connectionId,
            mode: 'remote' as const,
            profile: profile.name,
            targetProfile: profile.name,
          })
        }
      }
      return routes
    } catch (e) {
      console.error('[host] profileRoutes() 读取 bot 名册失败', e)
      return []
    }
  },

  /**
   * 面板可见性。宿主读实际 DOM 存在性（含已关闭的栏）。
   *
   * 窗格宿主（`PluginPane`）给根节点打 `data-panel-id="<plugin>:<pane>"`；
   * 这里用 MutationObserver 维护 live atom——`computed(atom(0), …)` 会在
   * 首次求值后永久缓存，上游 `.listen()` 永远收不到翻转（例程窗格就永远
   * 注册不上）。
   */
  paneVisibility: (paneId: string) => paneVisibilityAtom(paneId),

  /**
   * 系统通知。宿主面 = **应用内 toast**（ToastHost，2026-11-18）+ console；
   * 权限允许时再叠一层系统 Notification。此前只落 console（或权限允许的
   * 浏览器通知）——"点了没反应"的主要来源之一（审计实锤）。
   */
  notify: (input: { kind?: string; message: string; title?: string; detail?: string; persistent?: boolean }) => {
    const level = input.kind === 'error' ? 'error' : 'info'
    console[level === 'error' ? 'error' : 'log'](`[bots] ${input.message}`)
    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('mirach:toast', {
          detail: {
            kind: input.kind,
            title: input.title,
            message: input.message,
            detail: input.detail,
            persistent: input.persistent,
          },
        }),
      )
    }
    if (typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'granted') {
      new Notification(input.title || 'Mirach', { body: input.message })
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
    if (typeof window !== 'undefined' && text) {
      window.dispatchEvent(
        new CustomEvent('mirach:toast', { detail: { kind: 'error', message: text } }),
      )
    }
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
   * 宿主单身份时全部 bot 都是本机 profile，落同一个分发表；但 **route 的
   * profile 必须并进 params**——上游 requestForBot 对 sourceScoped 行只传
   * route，不带 `profile` 参数。群聊成员轮次的 prompt.submit / 附件 / 审批
   * 都要靠这个 profile 找到 bot 预设。
   *
   * **跨网关（2026-11-18）**：`mode:'remote'` 且 connectionId ≠ local 的
   * 路由走 `pi_gateway_call`（JSON-RPC over WS `/api/ws`，hermes 桌面端同
   * 款传输）；本机路由仍落本地分发表。prompt.submit 的超时按上游给足
   * （30 分钟——目标网关一轮可能很久）。
   */
  requestProfile: async <T>(
    route: unknown,
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs?: number,
  ): Promise<T> => {
    const r = route as null | {
      connectionId?: unknown
      mode?: unknown
      profile?: unknown
      targetProfile?: unknown
    }
    const profile =
      typeof r?.targetProfile === 'string' && r.targetProfile
        ? r.targetProfile
        : typeof r?.profile === 'string'
          ? r.profile
          : ''
    const merged = profile && params.profile === undefined ? { ...params, profile } : params
    const connectionId = typeof r?.connectionId === 'string' ? r.connectionId : ''
    if (r?.mode === 'remote' && connectionId && connectionId !== 'local') {
      const budget =
        typeof timeoutMs === 'number' && timeoutMs > 0
          ? timeoutMs
          : method === 'prompt.submit'
            ? 1_800_000
            : method === 'bot_relay.deliver'
              ? 1_500_000
              : 30_000
      // hermes 网关走 WS；mirach peer 走原生 HTTP（remoteInvoke 自动探测并记住）。
      return remoteInvoke<T>(
        connectionId,
        remoteRosterCache.get(connectionId)?.url,
        method,
        merged,
        budget,
      )
    }
    const { dispatchHostRequest } = await import('./host-rpc')
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

  /**
   * 导航（宿主路由，2026-11-18 接真面）。
   *
   * hermes Desktop 的插件路由是 `/settings?tab=<x>`（bot 打开失败卡片的
   * "打开网关设置" CTA：`/settings?tab=gateway`）。宿主无路由表，映射 =
   * 打开设置**窗口**并把 tab 深链成宿主节 id（gateway → core-connection）
   * ——设置窗已开时 Rust 侧走 `mirach:settings:section` 事件切节。
   * 其它目标仍走 `mirach:navigate` 事件（保留扩展点）。
   */
  navigate: (target: string): void => {
    const raw = String(target ?? '')
    if (raw.startsWith('/settings')) {
      let section: string | null = null
      try {
        const url = new URL(raw, 'mirach://app')
        section = url.searchParams.get('tab')
      } catch (e) {
        console.error('[host] navigate: 解析设置路由失败', raw, e)
      }
      void (async () => {
        try {
          const { invoke } = await import('@tauri-apps/api/core')
          await invoke('pi_open_settings_window', { section: section ?? null })
        } catch (e) {
          console.error('[host] navigate: 打开设置窗失败', e)
        }
      })()
      return
    }
    window.dispatchEvent(new CustomEvent('mirach:navigate', { detail: raw }))
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
  /**
   * 删除机器人（profile-ops.deleteBot 的入口；参数是 route 对象或名字）。
   *
   * 宿主对偶 = 删掉 bots-store 预设（与 `cli.exec profile delete` 同一底层
   * 操作）。此前显式抛"插件不可删"——那是初版的错误假设：花名册行删除是
   * bots 的核心动作，抛出会让插件侧删除恒失败（2026-11-18 审计实锤修）。
   */
  deleteProfile: async (profile: unknown): Promise<void> => {
    const name =
      typeof profile === 'string'
        ? profile
        : profile && typeof profile === 'object'
          ? String(
              (profile as { targetProfile?: unknown }).targetProfile ??
                (profile as { profile?: unknown }).profile ??
                '',
            )
          : ''
    const trimmed = name.trim()
    if (!trimmed) throw new Error('host.deleteProfile: 缺少 profile 名')
    const { botsStore } = await import('@/components/panes/hub/bots-store')
    if (!botsStore.getState().bots.length) botsStore.getState().load()
    const bot = botsStore.getState().bots.find((row) => row.name === trimmed)
    if (!bot) throw new Error(`host.deleteProfile: 找不到机器人「${trimmed}」`)
    botsStore.getState().remove(trimmed)
  },
  /** 清理遗留 profile 偏好（宿主无跨设备遗留态）。 */
  dropLeftoverProfilePrefs: (_args: unknown): void => {},
  /** 完成 MCP OAuth（宿主走设置页）。 */
  /**
   * MCP OAuth（`McpSetupButton` 的 OAuth 分支）。
   *
   * 宿主实现 = Rust `pi_mcp_oauth_complete`：RFC 9728/8414 discovery + DCR +
   * PKCE S256 + 本机回调 + token 交换 + 把 `Authorization` 写进 mcp.json 的
   * headers（rpi-mcp-adapter 原样发送）。只覆盖支持 DCR 的厂商；不支持时
   * 明确报错（无异味降级）。
   */
  completeMcpOAuth: async (args: unknown): Promise<void> => {
    const input = (args ?? {}) as { serverName?: unknown; catalogPreset?: unknown }
    const serverName = typeof input.serverName === 'string' ? input.serverName.trim() : ''
    if (!serverName) throw new Error('host.completeMcpOAuth: 缺少 serverName')
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('pi_mcp_oauth_complete', {
      serverName,
      preset: typeof input.catalogPreset === 'string' ? input.catalogPreset : undefined,
    })
  },
  /** 插件开关决策。上游是 atom（`host.pluginDecisions.get()` / 订阅）；
   *  这里直接接宿主 plugins-store 的同一 atom（设置页开关即生效）。 */
  pluginDecisions: $pluginDecisions,
  /** 身份变更追踪（诊断用，宿主写 console）。 */
  traceIdentityChange: (category: string, tag: string, detail?: string): void => {
    console.debug(`[bots] ${category} ${tag} ${detail ?? ''}`)
  },
} as const
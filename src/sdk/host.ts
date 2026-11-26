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
 * Mirach 是单用户桌面端 + **一个本机引擎**（rpi，进程内）；但
 * **多配置档案（profile）与多网关都已存在**（2026-11-25 校正——此前的
 * "单 profile" 前提已过时）：每个 bot = 一个具名 profile（`~/.rpi/agent/
 * profiles/<name>` 完整 home），远程连接（remote/cloud/ssh）是真正的
 * 外部网关（`pi_gateway_*` 的 WS JSON-RPC，或 mirach peer HTTP）。所以这
 * 份实现的原则是：
 *
 * 1. **有的照实接线**：`state` 的 8 个字段接宿主真实 atom；`request` 接 IPC
 * 2. **多档案/多网关语义按宿主真实机制实现**：warm = 备好本机 profile home
 *    的目录与种子配置（`pi_profile_ensure`）；远程 route 的 warm = 保证连接
 *    在场（socket 缓存在 Rust 连接注册表，按连接而非 profile）
 * 3. **没有的给安全默认 + 明确注释**：不编造行为，不假成功
 *
 * ## 为什么部分方法仍是空实现（不是偷懒）
 *
 * 上游的 `warmAgent` / `ensureAgent` / `retainProfile` 面向的是
 * **agent 进程池**（每个 agent 一个可冷启动的后端进程 + 每 profile 的
 * socket 引用计数）。宿主没有进程池：本机 profile 没有独立进程可预热，
 * 远程网关连接由 Rust 注册表常驻、按调用自动建连——**引用计数与进程池
 * 保活没有对象可挂**。给空实现比伪造行为更诚实。
 *
 * 凡是**语义上应该有**但宿主确实没有的（如 `profileRoutes` 的跨网关
 * 路由表——宿主只有一个本机引擎 + 连接注册表），返回空数组/安全默认而
 * 不是假数据，让上游代码自然走"没有对端"的分支。
 */

import { atom, type Atom } from 'nanostores'
import type { ReactNode } from 'react'

import { queryClient } from '@/hermes-shim/lib/query-client'
import { $pluginDecisions } from '@/hermes-shim/contrib/plugins-store'
import { openPluginWorkspace } from '@/components/layout/plugin-workspaces'
import { pendingBotChatStore } from '@/lib/pending-bot-chat'
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
          (row.kind === 'remote' || row.kind === 'cloud' ||
            // ssh 连接：url 可以为空（pi_gateway_connect 自动起隧道）。
            row.kind === 'ssh'),
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

// ── profile 预热（warmProfile / warmAgent / retainProfileSocket 的底座）────

/** 已预热的**本机** profile（悬停扫过花名册不重复发 IPC；失败回退可重试）。 */
const warmedLocalProfiles = new Set<string>()
/** 已预拨的**远程** (connection, profile)（socket 是连接级常驻，成功即长期有效）。 */
const warmedRemoteAgents = new Set<string>()

/** 本机 profile 预热：备好 `<home>` 目录 + 种子配置（幂等，不抢活动环境）。 */
function warmLocalProfileHome(raw: string): void {
  const name = raw.trim()
  if (!name) return
  // 'default' = 本体：进程默认 home 已就绪（每次会话构建都在用），无需预热。
  if (name === 'default') return
  if (warmedLocalProfiles.has(name)) return
  warmedLocalProfiles.add(name)
  void (async () => {
    try {
      const { invoke } = await tauriCore()
      await invoke('pi_profile_ensure', { name })
    } catch (e) {
      warmedLocalProfiles.delete(name) // 失败允许下次悬停重试
      console.error(`[host] warmProfile(${name}) 失败——该环境首次打开走冷路径`, e)
    }
  })()
}

/** 确保远程连接已在场（Rust `pi_gateway` 注册表缓存 socket；幂等）。 */
async function ensureRemoteGatewayConnected(connectionId: string): Promise<void> {
  const { invoke } = await tauriCore()
  const statusMap = await invoke<Record<string, { state?: string }>>('pi_gateway_status')
  if (statusMap?.[connectionId]?.state === 'open') return
  await invoke('pi_gateway_connect', {
    connectionId,
    url: remoteRosterCache.get(connectionId)?.url,
    // token: null = Rust 侧取该连接在 OS 凭据管理器里存的那份（永不回显）。
    token: null,
  })
}

/** 远程 agent 预热：保证连接在场（没有 per-profile 进程可拉起；SSH 源由
 *  `pi_gateway_connect` 自动起隧道，语义同上游"connect-on-demand"）。 */
function warmRemoteAgent(connectionId: string, profile: string): void {
  const key = `${connectionId}::${profile}`
  if (warmedRemoteAgents.has(key)) return
  warmedRemoteAgents.add(key)
  void (async () => {
    try {
      await ensureRemoteGatewayConnected(connectionId)
    } catch (e) {
      warmedRemoteAgents.delete(key)
      console.error(`[host] warmAgent(${connectionId}, ${profile}) 连接未就绪`, e)
    }
  })()
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

  /** 打开一个已存储的会话。
   *
   *  - 默认（`in-place`/`main`）：若该会话已作为**独立会话栏**在屏（插件
   *    `intent:'tab'` 开出的栏），先置前它——hermes 的「已在屏就 front」
   *    语义；否则走 runtime 的主会话切换桥。
   *  - `intent:'tab'`：**向右分出一个新栏**（hermes「在新标签页中打开机器人
   *    聊天」/「Open recent session」的宿主对偶），不抢主 workspace。
   *
   * **不切环境**（hermes `planPluginOpenSession` 的 `keepAllProfilesScope`
   * 缺省语义：插件打开是导航，不是 workspace/profile 切换；`refreshInPlace`
   * 的后台 resume 更不能动环境）。会话按自身路径打开——引擎的活动环境只
   * 决定新会话落点与列表扫描根，不影响打开既有文件。 */
  openSession: async (storedSessionId: string, options?: unknown): Promise<void> => {
    const opts = (options ?? null) as { intent?: unknown; tabTitle?: unknown } | null
    const bridge = await import('@/components/panes/session-manage/session-tab-bridge')

    if (opts?.intent === 'tab') {
      const title = typeof opts.tabTitle === 'string' ? opts.tabTitle.trim() : ''
      bridge.openSessionColumnBridge(storedSessionId, {
        ...(title ? { title } : {}),
      })

      return
    }

    if (bridge.focusSessionColumnBridge(storedSessionId)) {
      return
    }

    bridge.openStoredSessionBridge(storedSessionId)
  },

  /** 新建聊天。`profile` 在上游是 route 描述符或 profile 名——宿主按 bot 名
   *  解析（有 bot 预设就带人格/模型开一条新会话，否则普通新会话）。
   *  `workspaceMode:'bots'`（hermes「与此机器人开新聊天」）→ 新会话开在
   *  **主区右侧新栏**，不抢当前主会话；普通新会话仍走主会话切换。
   *
   *  **环境归属走会话落点，不切工作区**（hermes plugin-open 的
   *  dialWithoutSwitching 语义）：profile 名随 `session.create` 传下去，
   *  新会话落该 profile 的 home；引擎的活动环境保持用户所选，侧栏不因
   *  一次 bot 操作被整体换源。 */
  newChat: (profile?: null | string | { profile?: string; targetProfile?: string }, options: Record<string, unknown> = {}): void => {
    const name =
      typeof profile === 'string'
        ? profile
        : String(profile?.targetProfile ?? profile?.profile ?? '')
    const route = profile && typeof profile === 'object'
      ? (profile as { connectionId?: unknown; mode?: unknown })
      : null
    const localRoute =
      route === null ||
      String(route.connectionId ?? '').trim() === '' ||
      String(route.connectionId ?? '').trim() === 'local' ||
      route.mode === 'local'
    // 插件 bot 新聊天（hermes `host.newChat` 的 fresh draft）：插件调用带
    // workspaceOwnerKey + route；配置栏「在新分栏打开」只传 profile 字符串，
    // 仍是立即建会话列。草稿只在本机 profile 上成立。
    const pluginBotDraft =
      options.workspaceMode === 'bots' &&
      route !== null &&
      typeof options.workspaceOwnerKey === 'string' &&
      localRoute &&
      name !== ''
    void (async () => {
      try {
        // 环境跟随（2026-11-25）：本地 bot 的新聊天把活动环境切到该 bot——
        // 侧栏/底栏/环境菜单/机器人页四处一致；空名（沿用当前环境）不动。
        if (name && localRoute) {
          const { followProfileBridge } = await import(
            '@/components/panes/session-manage/active-profile-bridge'
          )
          const followed = await followProfileBridge(name === 'default' ? null : name)
          if (!followed) {
            console.error(`[host] newChat：环境跟随 ${name} 失败（继续建会话）`)
          }
        }
        if (pluginBotDraft) {
          // 只登记待落点 bot，丢当前会话回 New Chat 草稿；第一条消息由
          // runtime `ensureDraftSession` 用 bot 的 SOUL/模型/工具集 + 选中
          // 工作区建真会话（hermes openNewSessionTab 的宿主对偶）。
          const { requestNewChatDraftBridge } = await import(
            '@/components/panes/session-manage/active-profile-bridge'
          )
          // 先登记归属再回草稿：草稿态一出现用户就可能立刻发第一条消息，
          // ensureDraftSession 必须已经能看到 bot；失败则清掉。
          pendingBotChatStore.getState().set({ profile: name })
          const drafted = await requestNewChatDraftBridge()
          if (!drafted) {
            pendingBotChatStore.getState().set(null)
            throw new Error('回到 New Chat 草稿失败')
          }
          return
        }
        const { dispatchHostRequest } = await import('./host-rpc')
        pendingBotChatStore.getState().set(null)
        const created = await dispatchHostRequest<{ stored_session_id: string }>('session.create', {
          // 空 = 当前活动环境（普通新聊天）；'default' = 本体；具名 = 该环境。
          profile: name,
          title: typeof options.tabTitle === 'string' ? options.tabTitle : '',
        })
        const bridge = await import('@/components/panes/session-manage/session-tab-bridge')
        if (options.workspaceMode === 'bots') {
          // 页签标题不拿 bot 名兜底（2026-11-25）：新会话未命名时页签应显示
          // 会话自己的派生标题/「New Chat」，而非档案名。调用方显式给的
          // tabTitle 才用。
          const title =
            typeof options.tabTitle === 'string' && options.tabTitle.trim()
              ? options.tabTitle.trim()
              : ''
          bridge.openSessionColumnBridge(created.stored_session_id, title ? { title } : {})
        } else {
          bridge.openStoredSessionBridge(created.stored_session_id)
        }
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

  // ── profile 预热 / socket 常驻 / 偏好清理（2026-11-25 校正：多 profile
  //    与多网关都已存在，这些方法不再是"概念不存在"的空实现）─────────────
  //
  // 上游语义（hermes apps/desktop/src/sdk/index.ts + profile-local.ts）：
  // - warmProfile(profile)：悬停/"点名"时**后台预热该 profile 的后端**
  //   （进程池 + socket），不切活动环境；
  // - warmAgent(connectionId, profile)：在它自己的 source 上预拨 socket
  //   （多源花名册的 (连接, profile) 版；SSH 源不预热、按需建连）；
  // - retainProfileSocket(route)：relay drain 等连续 RPC 期间保 socket
  //   引用计数（括号随请求租约关闭）；字符串重载 = 本地/旧路由 → 空壳；
  // - dropLeftoverProfilePrefs(profile, connectionId)：profiles.create
  //   成功后清掉同名旧档案留下的**桌面端偏好**（不是删 profile 数据）。
  //
  // 宿主对偶（本机引擎 + Rust 网关连接注册表）：
  // - 本机 profile：预热 = 备好 `<home>` 目录 + 种子配置（`pi_profile_ensure`
  //   copy-if-missing），首次打开其会话不再走"建目录+补配置"冷路径；
  // - 远程 route：socket 属于**连接**（`pi_gateway` 注册表按连接常驻），
  //   预热的真实动作 = 保证连接在场（`pi_gateway_connect`）；
  // - 没有 per-profile 进程池与 socket 引用计数 → retainProfile 仍是空壳
  //   （没有对象可计数），retainProfileSocket 对远程 route 只做"确保连接"、
  //   释放为空操作（宿主不会因一次 drain 结束关连接）。

  /** 预热本机/远程 profile（上游单参签名：`warmProfile(profile)`）。 */
  warmProfile: (profile: unknown): void => {
    warmLocalProfileHome(String(profile ?? ''))
  },
  /** 在指定 source 上预拨（上游 `warmAgent(connectionId, profile)`）。 */
  warmAgent: (connectionId?: unknown, profile?: unknown): void => {
    const name = String(profile ?? '').trim() || 'default'
    const conn = String(connectionId ?? '').trim()
    if (conn && conn !== 'local') {
      warmRemoteAgent(conn, name)
      return
    }
    warmLocalProfileHome(name)
  },
  /**
   * 把某环境设为**活动环境**（宿主扩展；上游 `ensureGatewayAgent` 激活
   * 档案的对偶，2026-11-25 用户："左下角头像、会话选项的环境、机器人页
   * 的选中，三个不统一"）。
   *
   * 插件打开本地 bot 会话 / 新建 bot 聊天时调用：活动环境跟随该 bot，
   * 侧栏作用域/底栏身份/环境菜单/机器人页高亮随之一致。与显式切换
   * （`pi_profile_set_active` 的菜单路径）不同——不打断当前会话（轻量
   * 跟随，见 runtime 的 followProfile）。远程 route 不动本机环境。
   * 返回 false = 未跟随（远程行或引擎拒绝；调用方可继续打开）。
   */
  focusProfile: async (profile: unknown): Promise<boolean> => {
    if (profile && typeof profile === 'object') {
      const route = profile as { connectionId?: unknown; mode?: unknown; profile?: unknown; targetProfile?: unknown }
      const connectionId = String(route.connectionId ?? '').trim()
      if (route.mode === 'remote' && connectionId && connectionId !== 'local') return false
      profile = route.targetProfile ?? route.profile
    }
    const name = typeof profile === 'string' ? profile.trim() : ''
    if (!name) return false
    // 切到/打开某个 bot 的任何路径都作废上一份"新建 bot 聊天"草稿归属。
    pendingBotChatStore.getState().set(null)
    const { followProfileBridge } = await import(
      '@/components/panes/session-manage/active-profile-bridge'
    )
    return followProfileBridge(name === 'default' ? null : name)
  },
  /** 确保 agent 存在（激活路径；宿主没有待拉起的进程池，保持空壳）。 */
  ensureAgent: (_connectionId?: unknown, _name?: unknown): void => {},
  /** 保有 profile 引用计数（宿主没有进程池引用计数对象，保持空壳）。 */
  retainProfile: (_connectionId?: unknown, _profile?: unknown): void => {},
  /** 保有 profile socket（route 对象 → 确保远程连接在场并返回幂等释放
   *  函数；字符串重载 = 本机/旧路由 → 空壳释放函数）。 */
  retainProfileSocket: (route: unknown): (() => void) => {
    if (typeof route !== 'object' || route === null) return () => undefined
    const r = route as { connectionId?: unknown; profile?: unknown }
    const connectionId = String(r.connectionId ?? '').trim()
    const profile = String(r.profile ?? '').trim()
    if (!connectionId || connectionId === 'local') return () => undefined
    warmRemoteAgent(connectionId, profile || 'default')
    return () => undefined
  },
  /**
   * 删除机器人（profile-ops.deleteBot 的入口；参数是 route 对象或名字）。
   *
   * 宿主对偶 = hermes `profiles.delete`：**先删 profile home（磁盘）**，
   * 再删 bots-store 预设与插件本地缓存（`host-rpc.deleteBotProfile`，
   * 2026-11-23）。此前只删预设——磁盘目录残留，群聊成员还能把已删 bot
   * 重新拉起（`ensure_profile_dirs` 会重建目录）。删除失败原样抛出，
   * 注册表不动。
   */
  deleteProfile: async (profile: unknown): Promise<void> => {
    const route =
      profile && typeof profile === 'object'
        ? (profile as { connectionId?: unknown; mode?: unknown; profile?: unknown; targetProfile?: unknown })
        : null
    const name =
      typeof profile === 'string'
        ? profile
        : route
          ? String(route.targetProfile ?? route.profile ?? '')
          : ''
    const trimmed = name.trim()
    if (!trimmed) throw new Error('host.deleteProfile: 缺少 profile 名')

    // 远端 source-scoped 行：只能删对端网关上的 profile，绝不能拿同名去删
    // 本机目录（2026-11-23；上游走 Electron 拦截的 REST delete）。
    if (route?.mode === 'remote' && typeof route.connectionId === 'string' && route.connectionId && route.connectionId !== 'local') {
      await remoteInvoke(
        route.connectionId,
        remoteRosterCache.get(route.connectionId)?.url,
        'profiles.delete',
        { profile: trimmed },
        30_000,
      )
      return
    }

    const { deleteBotProfile } = await import('./host-rpc')
    await deleteBotProfile(trimmed)
  },
  /** 清理遗留 profile 偏好（profiles.create 成功后的清理；上游语义 =
   *  删掉同名旧档案在这台桌面留下的**偏好**，不是 profile 数据）。
   *  宿主对偶 = 该 profile 在插件 bot-meta 与 bot-ui-meta 缓存里的残条
   *  （删除机器人路径清的是同一组键）。远端 source 的档案不归本机清。 */
  dropLeftoverProfilePrefs: (profile: unknown, connectionId?: unknown): void => {
    const name = String(profile ?? '').trim()
    const conn = String(connectionId ?? '').trim()
    if (!name || name === 'default') return
    if (conn && conn !== 'local') return
    try {
      for (const key of ['mirach.plugin.hermes-bots.bot-meta-v2', 'mirach.harness.bot-ui-meta.v1']) {
        const raw = localStorage.getItem(key)
        if (!raw) continue
        const parsed: unknown = JSON.parse(raw)
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue
        const obj = parsed as Record<string, unknown>
        if (!(name in obj)) continue
        delete obj[name]
        localStorage.setItem(key, JSON.stringify(obj))
      }
    } catch (e) {
      console.error(`[host] dropLeftoverProfilePrefs(${name}) 失败——遗留偏好未清`, e)
    }
  },
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
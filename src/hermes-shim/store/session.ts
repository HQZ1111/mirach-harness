/**
 * `@/store/session` shim — the session/connection state the capabilities page
 * reads.
 *
 * Upstream: a 1,884-line store holding every session's runtime state, the gateway
 * connection descriptor, and the connection state machine's status.
 *
 * Host: sessions live in pi (JSONL on disk) and are surfaced through the
 * assistant-ui runtime and `sessionCatalog`. The capabilities page needs three
 * values:
 *   - `$activeSessionId` — so the MCP tab can name the chat whose servers would
 *     reload (pi applies MCP config at session creation, so this is display-only).
 *   - `$connection` — the resolved backend descriptor; the host has one engine.
 *   - `$gatewayState` — always `ready`: pi is in-process, nothing to connect to.
 *
 * The setters are kept because the upstream gateway adapter's callers name them;
 * they write the same atoms so a future real connection layer has one landing.
 */

import { atom } from 'nanostores'

import type { HermesConnection } from '@/hermes-shim/global'

// 会话目录（宿主真相源）：`ownerLookupSessionRows` / `sessionMatchesStoredId`
// 是镜像 cron 页与侧栏区读取"哪些会话存在"的唯一入口。
import { sessionCatalog } from '@/components/panes/session-manage/session-catalog'

/** Upstream's connection state comes from the shared package
 *  (`ConnectionState`: 'check' | 'connecting' | 'error' | 'idle' | 'open' …).
 *  pi is in-process, so the honest value is 'open' — nothing to dial. */
type ConnectionState = import('@/hermes-mirror/shared').ConnectionState

/** The active chat's id, mirrored from the host's session catalog. */
export const $activeSessionId = atom<null | string>(null)

/** The backend descriptor. One engine, so `null` until something asks. */
export const $connection = atom<HermesConnection & { registryScoped?: boolean } | null>(null)

/** pi is in-process: the connection is always open. */
export const $gatewayState = atom<ConnectionState>('open')

export function setConnection(connection: HermesConnection | null): void {
  $connection.set(connection)
}

export function setGatewayState(state: ConnectionState): void {
  $gatewayState.set(state)
}

export function setActiveSessionId(id: null | string): void {
  $activeSessionId.set(id)
}

/**
 * 当前打开的**已存会话** id（上游 `store/session.ts` 的同名 atom）。
 *
 * 上游区分「活动 runtime 会话」与「打开的已存会话行」；宿主这两者是同一个
 * （`sessionCatalog` 里的会话文件路径即 id）。镜像来的侧栏 cron 区用它判断
 * 「哪一行运行记录正在被查看」——`open-cron-run.ts` 也用它做归属匹配。
 * 与 `$activeSessionId` 指向同一份真相，避免两个 atom 各自漂移。
 */
export const $selectedStoredSessionId = $activeSessionId

/**
 * 当前已加载的会话行（上游 `store/session.ts:1094` `ownerLookupSessionRows`）。
 *
 * 上游把 recents + cron 会话 + messaging 会话三份合并（外加"未列出的归属桩"）。
 * 宿主只有一份会话目录（`sessionCatalog.entries`，pi 的 SessionIndex 投影），
 * 所以这里返回那一份——**不虚构额外的分片**。
 *
 * 返回 `SessionInfo[]` 是为了满足镜像调用点的类型（它们只读 `id` / `source`）；
 * 宿主目录里的 `path` 就是会话真相，映射成 `id` 与上游"行 id 即会话标识"
 * 的语义一致。
 */
export function ownerLookupSessionRows(): import('@/hermes-mirror/types/hermes').SessionInfo[] {
  // 会话目录是宿主的真相源（pi SessionIndex 投影）。静态 import 而非延迟
  // require：本项目是纯 ESM（vite + `"type": "module"`），require 不存在；
  // 且 session-catalog 只依赖 zustand 与 pi IPC，没有循环依赖。
  const entries = Object.values(sessionCatalog.getState().entries)
  return entries.map((entry) => ({
    id: entry.path ?? entry.id,
    source: 'session',
    title: entry.piName ?? entry.derivedTitle ?? null,
    cwd: entry.cwd ?? null,
    message_count: entry.messageCount ?? null,
    last_active: entry.lastModifiedMs ? Math.floor(entry.lastModifiedMs / 1000) : null,
  })) as import('@/hermes-mirror/types/hermes').SessionInfo[]
}

/**
 * 某个 stored id 是否指向这一行（上游 `store/session.ts:453`）。
 *
 * 上游比较三处：live id、lineage root、lineage ids（自动压缩会换 id，
 * 但 root 稳定）。宿主会话**不做压缩换 id**（pi 的会话文件路径就是稳定
 * 标识），所以只需比较 id 与 path 两处——多比一个 `_lineage_root_id`
 * 会让类型撒谎（宿主行里根本没有那个字段）。
 */
export function sessionMatchesStoredId(
  session: { id: string; path?: string },
  storedSessionId: string
): boolean {
  if (!storedSessionId) {
    return false
  }
  return session.id === storedSessionId || session.path === storedSessionId
}

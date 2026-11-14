/**
 * `@/store/gateway` shim — the backend-connection state machine.
 *
 * Upstream: a 2,485-line nanostore that dials a JSON-RPC WebSocket to the hermes
 * gateway, keeps per-(connection, profile) sockets, handles reconnect/backoff,
 * liveness probes, canonical protocol negotiation, and routes agent RPCs.
 *
 * Host: pi runs in this process (Rust, behind Tauri IPC). There is no socket, no
 * handshake, no reconnect. The three exports the capabilities tree uses reduce to
 * their honest host meaning:
 *   - `$gateway` — always `null`: there is no gateway instance to hand out. The
 *     MCP tab's live reload.mcp RPC rides that socket upstream, so it is withheld
 *     here and the tab falls back to "changes apply on the next session", which is
 *     pi's real semantics.
 *   - `activeGatewayConnectionId()` — `null` (the local pool). One machine.
 *   - `requestGatewayForAgent(...)` — throws. The connectors tab routes
 *     account/hosted-connector RPCs through it; pi has no hosted connectors and
 *     no RPC channel, so a caller reaching here is a real gap and must say so
 *     instead of returning an empty object that renders as "no connectors".
 */

import { atom } from 'nanostores'

import type { HermesGateway } from '@/hermes-shim/hermes'

/** No gateway socket exists in this host. Typed with the real client so mirrored
 *  consumers (`gateway?.on(...)`, `gateway?.request(...)`) typecheck against the
 *  methods they actually call; `null` is the honest value. */
export const $gateway = atom<HermesGateway | null>(null)

/** The active registry connection: always the local pool. */
export function activeGatewayConnectionId(): null {
  return null
}

/** Upstream dials (connectionId, profile) and issues a JSON-RPC call. This host
 *  has neither, so every call fails loudly with the reason. */
export function requestGatewayForAgent<T>(
  connectionId: null | string | undefined,
  profile: null | string | undefined,
  method: string,
  _params?: unknown,
  _timeoutMs?: number,
  _signal?: unknown,
  _options?: unknown
): Promise<T> {
  return Promise.reject(
    new Error(
      `网关 RPC「${method}」在本宿主不存在：pi 是进程内引擎，没有 JSON-RPC 通道` +
        (connectionId ? `（请求目标是 ${connectionId}::${profile ?? ''}）` : '')
    )
  )
}

export type SpawnPriority = 'background' | 'foreground'

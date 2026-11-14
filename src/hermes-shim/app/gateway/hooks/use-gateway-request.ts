/**
 * `@/app/gateway/hooks/use-gateway-request` shim — the one hook every mirrored
 * caller uses to reach the gateway.
 *
 * Upstream this returns the live JSON-RPC socket (`$gateway`), a ref to it, the
 * connection descriptor ref, and a `requestGateway` that dispatches, retries on
 * transport failure, and re-dials. The host has no socket: pi is an in-process
 * Rust engine behind Tauri IPC. So the shape is upstream's, and:
 *
 *   - `gateway` / `gatewayRef` are always `null` — the honest value, and every
 *     caller already handles it (`gateway?.on(...)`, `if (!gateway) return`).
 *   - `requestGateway` REJECTS with the reason. A caller that reaches it wants a
 *     gateway RPC method (billing.*, plugins.manage) that pi does not implement;
 *     returning `{}` would render as "no data" instead of "this backend has no
 *     such channel" (AGENTS.md rule 12).
 *   - `connectionRef` is `null` for the same reason.
 */

import { useCallback, useRef } from 'react'

import type { HermesGateway } from '@/hermes-shim/hermes'

export function useGatewayRequest() {
  const gatewayRef = useRef<HermesGateway | null>(null)
  const connectionRef = useRef<null>(null)

  const requestGateway = useCallback(
    async <T,>(method: string, _params: Record<string, unknown> = {}, _timeoutMs?: number, _signal?: AbortSignal) => {
      // Rejects rather than returning an empty payload: a caller reaching this
      // wants a gateway RPC method pi does not implement, and "no data" would
      // read as success (rule 12).
      const failure: Promise<T> = Promise.reject(
        new Error(
          `网关 RPC「${method}」在本宿主不存在：pi 是进程内引擎，没有 JSON-RPC 通道（该功能走 pi 的 IPC 命令）`
        )
      )
      return failure
    },
    []
  )

  return { connectionRef, gateway: null as HermesGateway | null, gatewayRef, requestGateway }
}

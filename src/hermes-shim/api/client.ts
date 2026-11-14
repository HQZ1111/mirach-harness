/**
 * `@/api/client` shim — the scope helpers the capabilities tree imports.
 *
 * Upstream `api/client.ts` (822 lines) is the REST client: `hermesApi` posts to
 * the Electron main which proxies to the hermes backend; `HermesGateway` is a
 * JSON-RPC WebSocket client; `$apiRequestScope` routes requests to the active
 * (connection, profile).
 *
 * Host: no REST backend, no socket. The four exports the tree imports are all
 * pure functions over the scope value, so their behaviour is kept verbatim —
 * they decide cache keys and query params, and the capabilities tree's React
 * Query keys depend on `profileScopeKey` matching exactly.
 *
 * `GATEWAY_NOT_CONNECTED_MESSAGE` keeps its upstream text: the connectors tab
 * compares error messages against it to decide whether to retry while connecting,
 * and this host's failure is the same shape (no connection to reach).
 */

export const STARTUP_REQUEST_TIMEOUT_MS = 60_000
export const PROMPT_SUBMIT_REQUEST_TIMEOUT_MS = 1_800_000

export const GATEWAY_NOT_CONNECTED_MESSAGE = 'Hermes gateway is not connected'

/**
 * Capability scope: which (connection, profile) a read/write targets. Upstream a
 * profile belongs to ONE gateway, so a scope can pin both. pi has one engine and
 * no profiles, but the type is verbatim — mirrored call sites pass `null`,
 * strings and objects, and the cache-key semantics below must stay identical for
 * React Query to treat one scope as one cache row.
 */
export type ProfileScope = undefined | null | string | { connectionId?: null | string; profile?: null | string }

/** Stable cache key for a scope (upstream's scope-in-key rule). */
export function profileScopeKey(scope?: ProfileScope): string {
  if (scope && typeof scope === 'object') {
    const profile = (scope.profile ?? '').trim() || 'default'
    const connectionId = (scope.connectionId ?? '').trim()

    return connectionId ? `${connectionId}::${profile}` : profile
  }

  return (scope ?? '').trim() || 'default'
}

/** Upstream attaches the active connection tag + foreground priority. With one
 *  local engine there is nothing to attach, so this is the profile pass-through
 *  with `priority: 'foreground'` — what upstream sends for an explicit pin. */
export function capabilityScoped(scope?: ProfileScope): {
  connectionId?: string
  priority?: 'foreground'
  profile?: string
} {
  if (scope && typeof scope === 'object') {
    const profile = (scope.profile ?? '').trim()
    const connectionId = (scope.connectionId ?? '').trim()

    return {
      ...(profile ? { profile } : {}),
      ...(connectionId ? { connectionId } : {}),
      priority: 'foreground'
    }
  }

  const profile = (scope ?? '').trim()

  return { ...(profile ? { profile } : {}), priority: 'foreground' }
}

/** Upstream's legacy single-field variant; kept because api/mcp.ts imports it. */
export function profileScoped(profile?: null | string): { priority?: 'foreground'; profile?: string } {
  const value = (profile ?? '').trim()

  return { ...(value ? { profile: value } : {}), priority: 'foreground' }
}

/**
 * Which registry connection served the current API request — upstream reads
 * `$apiRequestScope.connectionId` so a row can later be resumed on the backend
 * that actually holds it (`lib/session-owner-stamp.ts`).
 *
 * **宿主恒为 `null`**：只有一个本机引擎，没有"哪个后端"的问题。返回 null
 * 而不是空串，是因为上游的调用点用 `?? ''` 拼作用域键——null 与"没有连接"
 * 同义，空串会被当成一个具名连接。
 */
export function getApiRequestConnection(): null | string {
  return null
}

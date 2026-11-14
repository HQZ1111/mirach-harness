/**
 * @/store/session-states shim - session tiles and owner-routed RPCs.
 *
 * Upstream: a 3,133-line store of per-session tile state (pinned panes, dock
 * layout, provider wait, preview status) plus requestForOwnedSession, which
 * resolves which gateway owns a session and routes the RPC there, refusing when
 * the owner cannot be proven.
 *
 * Host: pi is in-process - one engine, no per-session sockets, no owner ambiguity.
 * requestForOwnedSession keeps upstream's exact signature (the MCP reload path
 * passes a six-argument call) and rejects: the only capability-tree caller is
 * lib/mcp-reload.ts (the live reload.mcp RPC), which the MCP tab treats as
 * optional, and an empty success would read as "reloaded nothing" - worse than
 * saying the RPC does not exist.
 */

export type SplitDir = 'bottom' | 'left' | 'right' | 'top'

/** Where a session tile docks. Upstream also allows 'center' (the main
 *  workspace); kept identical so the mirrored drag code typechecks. */
export type TileDock = 'center' | SplitDir

export function requestForOwnedSession<T>(
  sessionId: null | string | undefined,
  _ambientRequest: <R>(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs?: number,
    signal?: AbortSignal
  ) => Promise<R>,
  method: string,
  _params: Record<string, unknown> = {},
  _timeoutMs?: number,
  _signal?: AbortSignal
): Promise<T> {
  return Promise.reject(
    new Error(
      '会话级 RPC「' + method + '」在本宿主不存在：pi 是进程内引擎，MCP 配置在会话创建时生效' +
        (sessionId ? '（会话 ' + sessionId + '）' : '')
    )
  )
}

/**
 * `@/store/session-owner-resolution` shim（2026-10-29）。
 *
 * 上游 83 行，解决的是**多后端拓扑**下的路由问题：Electron 可能连多个
 * hermes backend（registry topology），一个带 `session_id` 的 RPC 只在
 * 拥有该会话的后端上才有意义，owner 解析不出来时必须 fail-closed 而不是
 * 悄悄走 ambient socket。
 *
 * **宿主没有这个问题**：只有一个进程内引擎（`PiEngine`），没有连接注册表，
 * 没有 profile 池，"哪个后端持有这个会话"恒有唯一答案。所以这里只需要
 * 保留**类型与判定函数的形状**，让镜像来的 `store/read-only-transcript.ts`
 * 能编译、且语义仍然正确：
 *
 * - `isSessionOwnerResolutionError` 保留（上游 `read-only-transcript.ts:148`
 *   用它决定是否降级成只读视图；宿主永远走不到这个分支，因为不抛这个错）。
 * - `ambientGatewayOwnsEverySession()` 恒 `true`——这就是宿主的真相：
 *   唯一引擎拥有所有会话。
 *
 * **不要**为了"完整性"把上游的 `connection-registry-state` /
 * `session-request-router` / `$profiles` 一并搬进来：那三件是拓扑状态机，
 * 宿主没有拓扑可管，搬进来会得到一堆永远返回同一个值的假状态机。
 */

/** 上游的错误类型（保留形状；宿主不抛它，但判定函数要认得出）。 */
export class SessionOwnerResolutionError extends Error {
  constructor(
    readonly sessionId: string,
    readonly method: string
  ) {
    super(
      `Session owner could not be resolved for "${sessionId}" (${method}): ` +
        'no owner route, hint, connection-tagged row or profile probe named the backend that holds this session, ' +
        'and routing it to the active gateway would be a guess.'
    )
    this.name = 'SessionOwnerResolutionError'
  }
}

export function isSessionOwnerResolutionError(error: unknown): error is SessionOwnerResolutionError {
  return (
    error instanceof SessionOwnerResolutionError ||
    (error as { name?: unknown })?.name === 'SessionOwnerResolutionError'
  )
}

/**
 * 宿主恒 `true`：只有一个进程内引擎，ambient gateway 就是唯一后端。
 *
 * 上游这个函数是"legacy 单后端 Desktop"的判定（无注册表拓扑 且 profile ≤ 1）。
 * 宿主两个条件都恒成立，所以直接返回 true——这是宿主的真实语义，不是兜底。
 */
export function ambientGatewayOwnsEverySession(): boolean {
  return true
}

/** 上游的 owner 作用域（宿主恒 `null`，但类型要存在）。 */
export type SessionOwnerScope = null | string | { connectionId?: string; profile?: string }

/** owner 是否已知。宿主唯一引擎 → 恒 `true`（见上）。 */
export function sessionOwnerIsKnown(_owner: SessionOwnerScope): boolean {
  return true
}

/**
 * session RPC 前的 owner 闸门。宿主恒放行（唯一引擎）。
 *
 * 上游在没有 owner 且 ambient 不是唯一后端时抛 `SessionOwnerResolutionError`；
 * 宿主两个前提都不成立，所以这个函数是空操作——**不是兜底**，是"条件不成立
 * 所以不抛"。
 */
export function assertSessionOwnerResolved(
  _owner: SessionOwnerScope,
  _context: { method: string; sessionId: null | string | undefined }
): void {
  // 唯一引擎拥有所有会话，无需闸门。
}

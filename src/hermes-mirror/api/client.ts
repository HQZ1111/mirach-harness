/**
 * API 客户端（hermes `api/client.ts` 的最小对偶）。
 *
 * 上游是 REST 客户端（带连接作用域）。宿主只有 `groups_dispatch` IPC。
 * SDK 只取 2 个导出：`capabilityScoped` / `getApiRequestConnection`。
 */

/**
 * 能力作用域包装（上游：把请求绑到某连接）。
 *
 * 宿主单引擎无连接作用域，直接执行。
 */
export function capabilityScoped<T>(fn: () => Promise<T>): Promise<T> {
  return fn()
}

/** 当前请求所属连接（宿主恒 null = 唯一引擎）。 */
export function getApiRequestConnection(): null {
  return null
}

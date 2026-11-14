/**
 * 极简查询缓存 —— hermes 用 TanStack Query（`@tanstack/react-query` 的
 * `queryOptions` / `useQuery` / `queryClient.prefetchQuery`）承载 catalog 的
 * 下载态；宿主**没有挂 QueryClientProvider**（AGENTS.md 里 TanStack Query
 * 是"非会话缓存"的选型，但至今没有消费方，全局 Provider 没有落地）。
 *
 * 为不因一个页面给整个应用加 Provider，这里实现**同语义的最小面**：
 * - 键 → 状态（pending / error / success + data），并发去重（同键同刻只发一次）；
 * - `staleTime`：未过期不重取；
 * - **失败停在错误态**，直到调用方显式 `refetch()`（上游 `retry: false` +
 *   `enabled: status !== 'error'` 的语义）；
 * - `prefetch`：空闲预热。
 *
 * 这不是通用 RQ 替身（没有 mutation/失效树/乐观更新），只服务 catalog 这一处；
 * 将来真接 TanStack Query 时把本文件换成薄适配即可（导出形状已对齐）。
 */

import { useCallback, useEffect, useReducer, useRef } from 'react'

export type QueryStatus = 'error' | 'pending' | 'success'

export interface QueryState<T> {
  status: QueryStatus
  data: T | undefined
  error: Error | null
  /** 每次成功/失败自增，驱动订阅方重渲染。 */
  version: number
}

interface Entry<T> extends QueryState<T> {
  updatedAt: number
  promise: Promise<void> | null
}

const store = new Map<string, Entry<unknown>>()
const listeners = new Map<string, Set<() => void>>()

function keyOf(key: readonly unknown[]): string {
  return JSON.stringify(key)
}

function emit(key: string) {
  const set = listeners.get(key)
  if (!set) return
  for (const fn of set) fn()
}

function entryFor<T>(key: string): Entry<T> {
  let entry = store.get(key) as Entry<T> | undefined
  if (!entry) {
    entry = { status: 'pending', data: undefined, error: null, version: 0, updatedAt: 0, promise: null }
    store.set(key, entry as Entry<unknown>)
  }
  return entry
}

export interface QueryOptions<T> {
  queryKey: readonly unknown[]
  queryFn: () => Promise<T>
  /** 未过期不重取（毫秒）。 */
  staleTime?: number
  /** 失败后是否允许自动重取；false = 停在错误态（上游 catalog 用 false）。 */
  retry?: boolean
}

/** 触发（或复用）一次请求；并发同键只发一次。 */
function run<T>(options: QueryOptions<T>, force = false): Promise<void> {
  const key = keyOf(options.queryKey)
  const entry = entryFor<T>(key)
  const staleTime = options.staleTime ?? 0
  const fresh = entry.status === 'success' && Date.now() - entry.updatedAt < staleTime

  if (!force && fresh) return Promise.resolve()
  // 错误态：除非显式 refetch，否则不自动重试（上游 retry:false 语义）
  if (!force && entry.status === 'error' && !options.retry) return Promise.resolve()
  if (entry.promise) return entry.promise

  entry.status = 'pending'
  entry.error = null
  entry.version += 1
  emit(key)

  entry.promise = options
    .queryFn()
    .then((data) => {
      entry.data = data
      entry.status = 'success'
      entry.error = null
      entry.updatedAt = Date.now()
    })
    .catch((error: unknown) => {
      entry.status = 'error'
      entry.error = error instanceof Error ? error : new Error(String(error))
    })
    .finally(() => {
      entry.promise = null
      entry.version += 1
      emit(key)
    })

  return entry.promise
}

export interface UseQueryResult<T> {
  data: T | undefined
  error: Error | null
  isPending: boolean
  refetch: () => void
}

/** 订阅一个查询（挂载即按 staleTime 触发）。 */
export function useQuery<T>(options: QueryOptions<T>): UseQueryResult<T> {
  const key = keyOf(options.queryKey)
  const [, forceRender] = useReducer((n: number) => n + 1, 0)
  // queryFn 每次 render 是新函数；用 ref 让订阅 effect 只跟 key 走。
  const optionsRef = useRef(options)
  optionsRef.current = options

  useEffect(() => {
    const listener = () => forceRender()
    let set = listeners.get(key)
    if (!set) {
      set = new Set()
      listeners.set(key, set)
    }
    set.add(listener)
    // 挂载触发（staleTime 内命中缓存则不发请求）
    void run(optionsRef.current)
    return () => {
      set.delete(listener)
      if (set.size === 0) listeners.delete(key)
    }
  }, [key])

  const entry = store.get(key) as Entry<T> | undefined
  const state = entry ?? entryFor<T>(key)

  return {
    data: state.data,
    error: state.error,
    isPending: state.status === 'pending',
    refetch: useCallback(() => void run(optionsRef.current, true), []),
  }
}

/** 强制取一次（不受 staleTime 限制）。 */
export function prefetchQuery<T>(options: QueryOptions<T>): Promise<void> {
  return run(options, true)
}

/** 测试用：清空全部缓存。 */
export function resetQueryCache(): void {
  store.clear()
  listeners.clear()
}

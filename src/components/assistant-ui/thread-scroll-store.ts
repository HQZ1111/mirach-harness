/**
 * 会话滚动位置桥（hermes desktop store/thread-scroll.ts 的 harness 对标，
 * zustand vanilla 模式同 connection-store）：
 *
 * - 保存面：`saveThreadScroll(sessionId, state)`——per-session key，内存
 *   Map + localStorage（`mirach.harness.thread-scroll.v1`）持久化最近
 *   THREAD_SCROLL_PERSIST_LIMIT(50) 个（插入序 = LRU，save 先删后插）。
 *   offset 存「距底部距离」而非 scrollTop（hermes 同款理由：恢复锚在
 *   底边做减法，内容上方增删/渲染预算回填不摇晃阅读位）。
 * - 恢复面：runtime 在 HYDRATE / switchToThread 成功路径发
 *   `scrollRestoreRequest{sessionId, seq}`（requestRestore）；视口（下一轮
 *   接线，thread.aui 的 Viewport div 订阅）消费后 consumeRestoreRequest(seq)。
 *   seq 让同一会话的连续两次打开都能通知到（引用变化即 effect 重跑）。
 *
 * 本 store 只提供 API + 恢复查询接口；视口的 onScroll 采样与恢复执行
 * 是 thread.aui 侧的 3 行订阅（本轮不动 thread.aui，挂载 patch 见交接）。
 */
import { createStore, useStore } from 'zustand'

/** 距底部 ≤ 此像素视为「停在底部」（阈值刻意紧——贴着底边停下的阅读者
 * 不该被记成 offset 后在恢复时被拽离边缘） */
export const THREAD_SCROLL_STICKY_THRESHOLD_PX = 8

export type ThreadScrollState = { mode: 'bottom' } | { mode: 'offset'; value: number }

export const THREAD_SCROLL_STORAGE_KEY = 'mirach.harness.thread-scroll.v1'

/** 持久化上限（最近 50 个会话）；内存 Map 同限，读写两侧形状一致 */
export const THREAD_SCROLL_PERSIST_LIMIT = 50

export interface ScrollMetrics {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

/** 纯函数：实时指标 → 距底距离（≥0，底边数学不依赖上方内容形状） */
export function scrollDistanceFromBottom(m: ScrollMetrics): number {
  return Math.max(0, m.scrollHeight - m.scrollTop - m.clientHeight)
}

/** 纯函数：实时指标分类为 bottom / 精确 offset（视口 onScroll 采样用） */
export function classifyScrollState(
  m: ScrollMetrics,
  threshold: number = THREAD_SCROLL_STICKY_THRESHOLD_PX,
): ThreadScrollState {
  return scrollDistanceFromBottom(m) <= threshold ? { mode: 'bottom' } : { mode: 'offset', value: scrollDistanceFromBottom(m) }
}

/** 纯函数：在当前内容高度下重放 state 的目标 scrollTop（恢复执行用） */
export function threadScrollTargetTop(
  state: ThreadScrollState,
  m: Pick<ScrollMetrics, 'scrollHeight' | 'clientHeight'>,
): number {
  const max = Math.max(0, m.scrollHeight - m.clientHeight)
  return state.mode === 'bottom' ? max : Math.max(0, max - state.value)
}

// ── 恢复请求（zustand vanilla，connection-store 同款）────────────────────

interface ThreadScrollBridgeState {
  /** runtime 在打开/水合会话成功后写入；视口消费后 consume 清空 */
  scrollRestoreRequest: { sessionId: string; seq: number } | null
  requestRestore: (sessionId: string) => void
  /** seq 匹配才清——视口处理期间来了新请求不得误清 */
  consumeRestoreRequest: (seq: number) => void
}

export const threadScrollBridge = createStore<ThreadScrollBridgeState>(() => ({
  scrollRestoreRequest: null,
  requestRestore: (sessionId) =>
    threadScrollBridge.setState((s) => ({
      scrollRestoreRequest: { sessionId, seq: (s.scrollRestoreRequest?.seq ?? 0) + 1 },
    })),
  consumeRestoreRequest: (seq) =>
    threadScrollBridge.setState((s) =>
      s.scrollRestoreRequest?.seq === seq ? { scrollRestoreRequest: null } : s,
    ),
}))

export const useScrollRestoreRequest = () =>
  useStore(threadScrollBridge, (s) => s.scrollRestoreRequest)

// ── 保存面（内存 Map + localStorage LRU-50）─────────────────────────────

const positions = new Map<string, ThreadScrollState>()

const parseThreadScrollState = (value: unknown): ThreadScrollState | null => {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (v.mode === 'bottom') return { mode: 'bottom' }
  if (
    v.mode === 'offset' &&
    typeof v.value === 'number' &&
    Number.isFinite(v.value) &&
    v.value >= 0
  ) {
    return { mode: 'offset', value: v.value }
  }
  return null
}

const persist = (): void => {
  const out: Record<string, ThreadScrollState> = {}
  for (const [k, v] of positions) out[k] = v
  localStorage.setItem(THREAD_SCROLL_STORAGE_KEY, JSON.stringify(out))
}

const loadPersisted = (): void => {
  const raw = localStorage.getItem(THREAD_SCROLL_STORAGE_KEY)
  if (!raw) return
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    console.error('[thread-scroll] 持久化数据解析失败（按空加载）', e)
    return
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    console.error('[thread-scroll] 持久化数据形状非法（按空加载）', parsed)
    return
  }
  let dropped = 0
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const state = parseThreadScrollState(value)
    if (!state) {
      dropped++
      continue
    }
    positions.set(key, state)
  }
  if (dropped > 0) console.error(`[thread-scroll] ${dropped} 条持久化条目形状非法——丢弃`)
}

// 模块加载即载入持久化位置（node 测试环境由 vitest.setup 的 localStorage
// 替身承接）
loadPersisted()

/** 保存会话滚动位置（LRU：先删后插 = 插入序即最近使用序），超限裁剪后
 * 整份写回 localStorage */
export function saveThreadScroll(sessionId: string, state: ThreadScrollState): void {
  if (!sessionId) {
    console.error('[thread-scroll] saveThreadScroll 需要非空 sessionId')
    return
  }
  positions.delete(sessionId)
  positions.set(sessionId, state)
  while (positions.size > THREAD_SCROLL_PERSIST_LIMIT) {
    const oldest = positions.keys().next().value
    if (oldest === undefined) break
    positions.delete(oldest)
  }
  persist()
}

/** 恢复查询：该会话最近一次保存的滚动位置（未保存过 = undefined） */
export function getSavedThreadScroll(sessionId: string): ThreadScrollState | undefined {
  return positions.get(sessionId)
}

/** 会话删除时清理对应位置（内存 + 持久化） */
export function clearThreadScroll(sessionId: string): void {
  if (!positions.has(sessionId)) return
  positions.delete(sessionId)
  persist()
}

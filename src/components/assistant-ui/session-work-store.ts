/**
 * 会话工作态（hermes `$workingSessionIds` + `session.info` 心跳的宿主最小对偶，
 * 2026-11-28）。
 *
 * 单一真相：某会话"在跑"的判据不再只有 actor 的 `streaming`（SSE 断流/
 * 终态帧丢失会让它永远 streaming 或提前 idle），而是双源：
 *  - `actorStreaming`：轮次机状态（事件驱动）；
 *  - `laneBusy`：引擎侧 `pi_lane_busy({thread:'main:<id>'})` 轮询。2026-11-28
 *    起引擎是**每会话独立句柄**（mains 表），忙闲必须按会话记——此前是
 *    进程级单布尔，后台会话起跑会把焦点会话画成"在跑"（或反之）。
 * `busy = actorStreaming || laneBusy`；`lastEventAt` 记录该会话最后一次
 * 收到 SSE 事件的时刻，用于：
 *  - 停浪探针（stalled）：actor 说 streaming 但 N 秒无事件 → console 可见
 *    （不静默；UI 卡下一批接）；
 *  - 流对账：**busy 的会话不关流**（事件间歇期误关会丢增量）；
 *  - actor 淘汰：busy 的 actor 永不驱逐（hermes `evictable()` 同语义）。
 */
import { createStore, useStore } from 'zustand'

/** 停浪判定阈值（> 引擎最长静默：工具执行/长思考都给事件）。 */
export const STALL_MS = 90_000

interface WorkEntry {
  actorStreaming: boolean
  /** 该会话自己的 lane 忙闲（引擎按 `main:<id>` 精确报告）。 */
  laneBusy: boolean
  lastEventAt: number
  lastStallLoggedAt: number
}

export interface SessionWorkState {
  byKey: Record<string, WorkEntry>
  markEvent: (key: string) => void
  setActorStreaming: (key: string, streaming: boolean) => void
  setLaneBusy: (key: string, busy: boolean) => void
  clearKey: (key: string) => void
}

const touch = (s: SessionWorkState, key: string): WorkEntry =>
  s.byKey[key] ?? { actorStreaming: false, laneBusy: false, lastEventAt: 0, lastStallLoggedAt: 0 }

export const sessionWork = createStore<SessionWorkState>()((set, get) => ({
  byKey: {},
  markEvent: (key) => {
    const cur = touch(get(), key)
    set({ byKey: { ...get().byKey, [key]: { ...cur, lastEventAt: Date.now() } } })
  },
  setActorStreaming: (key, streaming) => {
    const cur = touch(get(), key)
    if (cur.actorStreaming === streaming) return
    set({ byKey: { ...get().byKey, [key]: { ...cur, actorStreaming: streaming } } })
  },
  setLaneBusy: (key, busy) => {
    const cur = touch(get(), key)
    if (cur.laneBusy === busy) return
    set({ byKey: { ...get().byKey, [key]: { ...cur, laneBusy: busy } } })
  },
  clearKey: (key) => {
    const cur = get().byKey
    if (!(key in cur)) return
    const byKey = { ...cur }
    delete byKey[key]
    set({ byKey })
  },
}))

/** busy = actor streaming 或该会话自己的引擎 lane 忙（双源，hermes 同语义）。 */
export const isSessionBusy = (key: string): boolean => {
  const e = sessionWork.getState().byKey[key]
  return (e?.actorStreaming ?? false) || (e?.laneBusy ?? false)
}

/**
 * 停浪：actor 说在跑但 90s 无事件——console.error 可见（规矩 11：不静默），
 * 每会话每 90s 最多记一次。返回是否处于停浪（UI 卡下一批消费）。
 */
export const noteStallIfAny = (key: string, now = Date.now()): boolean => {
  const s = sessionWork.getState()
  const e = s.byKey[key]
  if (!e || !e.actorStreaming || e.lastEventAt === 0) return false
  if (now - e.lastEventAt < STALL_MS) return false
  if (now - e.lastStallLoggedAt < STALL_MS) return true
  sessionWork.setState({
    byKey: {
      ...s.byKey,
      [key]: { ...e, lastStallLoggedAt: now },
    },
  })
  console.error(
    `[session-work] ${key} 流式静默 ${Math.round((now - e.lastEventAt) / 1000)}s（无事件）——可能链路卡死，可点停止或切走重开`,
  )
  return true
}

export const useSessionBusy = (key: string): boolean =>
  useStore(
    sessionWork,
    (s) => (s.byKey[key]?.actorStreaming ?? false) || (s.byKey[key]?.laneBusy ?? false),
  )

/** 测试隔离。 */
export function resetSessionWorkForTests(): void {
  sessionWork.setState({ byKey: {} })
}

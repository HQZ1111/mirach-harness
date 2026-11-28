/**
 * 会话打开/恢复失败状态机（hermes resume-latches.ts + use-route-resume.ts
 * 的宿主对偶，2026-11-28）。
 *
 * 语义（hermes 原文件）：
 *  - 打开失败自动重试，指数退避 1s→2s→4s→8s，最多 4 次；
 *  - 耗尽 → exhausted latch（UI 给"重试"入口，不自动无限重试）；
 *  - **只有用户显式重试**（点会话行/点重试）才清 latch 并重启计数——自动
 *    重试永不清理（否则"已重试 N 次"的承诺不成立）。
 * 宿主差异：错误来源 = `pi_open_session` / POST 失败（引擎 no active
 * session、文件锁、文件不存在）；not-found 与瞬时错误暂不区分（Rust 侧
 * 结构化 code 留下一批）。
 */
import { createStore, useStore } from 'zustand'

export const MAX_RESUME_ATTEMPTS = 4

export const resumeBackoffMs = (attempt: number): number =>
  Math.min(8000, 1000 * 2 ** Math.max(0, attempt - 1))

export interface ResumeEntry {
  attempts: number
  exhausted: boolean
  lastError: string | null
}

export interface SessionResumeState {
  byId: Record<string, ResumeEntry>
  noteFailure: (id: string, error: string) => ResumeEntry
  noteSuccess: (id: string) => void
  /** 用户显式重试：清 latch（下一次失败从第 1 次重新计数）。 */
  reset: (id: string) => void
}

export const sessionResume = createStore<SessionResumeState>()((set, get) => ({
  byId: {},
  noteFailure: (id, error) => {
    const cur = get().byId[id] ?? { attempts: 0, exhausted: false, lastError: null }
    const attempts = cur.attempts + 1
    const entry: ResumeEntry = {
      attempts,
      exhausted: attempts >= MAX_RESUME_ATTEMPTS,
      lastError: error,
    }
    set({ byId: { ...get().byId, [id]: entry } })
    return entry
  },
  noteSuccess: (id) => {
    const cur = get().byId
    if (!(id in cur)) return
    const byId = { ...cur }
    delete byId[id]
    set({ byId })
  },
  reset: (id) => {
    const cur = get().byId
    if (!(id in cur)) return
    const byId = { ...cur }
    delete byId[id]
    set({ byId })
  },
}))

export const isResumeExhausted = (id: string): boolean =>
  sessionResume.getState().byId[id]?.exhausted ?? false

export const useResumeExhausted = (id: string | null): boolean =>
  useStore(sessionResume, (s) => (id ? (s.byId[id]?.exhausted ?? false) : false))

/** 测试隔离。 */
export function resetSessionResumeForTests(): void {
  sessionResume.setState({ byId: {} })
}

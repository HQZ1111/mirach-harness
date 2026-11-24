/**
 * 自动归档旧会话（ZCode `TaskAutoArchiveScheduler` 的宿主实现，2026-11-22）：
 * 设置页「归档管理 → 自动归档旧会话」的唯一执行者。
 *
 * ZCode 语义（packages/services/src/project/autoArchiveScheduler.ts）：
 * - 启动首轮 + 固定间隔（5 分钟）扫描；设置变更后立即补扫；
 * - 判定 = 会话「最后更新」早于 `now - 保留天数`；
 * - **置顶 / 当前打开的会话永不归档**（ZCode：pinned and running sessions
 *   are never affected）；
 * - 归档 = 写归档表（session-meta.archived），不是删除。
 *
 * 宿主数据面 = `pi_sessions_index`（跨根索引，lastModified 为 Unix 毫秒）+
 * `sessionCatalog.setArchived`（session-meta 写穿）。归档集合的真相在
 * session-meta，首次扫描前先 hydrate（与 runtime 启动水合同源），之后以
 * 内存态为准（避免把用户刚做的改动被磁盘旧值覆盖）。
 *
 * 扫描串行化（同 ZCode）：进行中的扫描 + 一次补扫；设置变更不丢。
 * 失败可见（铁律 12）：扫描错误 console.error，等下一轮，不静默吞。
 */
import { invoke } from '@tauri-apps/api/core'

import { loadAppPrefs } from '@/lib/app-prefs'
import { inTauri } from '@/lib/tauri-window'
import {
  hydrateSessionMeta,
  sessionCatalog,
  type SessionsIndexResult,
} from '@/components/panes/session-manage/session-catalog'
import { requestSessionListRefresh } from '@/components/panes/session-manage/session-refresh-bridge'

/** ZCode 同值：5 分钟。 */
export const AUTO_ARCHIVE_SCAN_INTERVAL_MS = 5 * 60 * 1000
const DAY_MS = 86_400_000

/** 截止时间：最后更新早于此值的会话进入归档候选。 */
export function autoArchiveCutoff(now: number, olderThanDays: number): number {
  const days = Math.max(1, Math.floor(olderThanDays))
  return now - days * DAY_MS
}

export interface AutoArchiveTargetInput {
  id: string
  lastModified: number
}

/**
 * 归档目标选择（纯函数，可单测）：早于 cutoff、未归档、非置顶、非当前会话。
 * lastModified 缺失（0）的条目跳过——没有时间事实就不做「旧」的判定。
 */
export function pickAutoArchiveIds(
  sessions: readonly AutoArchiveTargetInput[],
  options: {
    now: number
    olderThanDays: number
    pinned: readonly string[]
    archived: readonly string[]
    activeId: string | null
  },
): string[] {
  const cutoff = autoArchiveCutoff(options.now, options.olderThanDays)
  const skip = new Set<string>(options.pinned)
  for (const id of options.archived) skip.add(id)
  if (options.activeId !== null) skip.add(options.activeId)
  return sessions
    .filter(
      (session) =>
        session.lastModified > 0 && session.lastModified < cutoff && !skip.has(session.id),
    )
    .map((session) => session.id)
}

/** 首次扫描前 hydrate 一次归档/置顶真相；之后以内存态为准。 */
let metaReady = false

async function scanOnce(): Promise<string[]> {
  if (!inTauri) return []
  const prefs = await loadAppPrefs()
  if (!prefs.taskAutoArchiveEnabled) return []
  if (!metaReady) {
    await hydrateSessionMeta()
    metaReady = true
  }
  const result = await invoke<SessionsIndexResult>('pi_sessions_index')
  const state = sessionCatalog.getState()
  const ids = pickAutoArchiveIds(result.sessions, {
    now: Date.now(),
    olderThanDays: prefs.taskAutoArchiveOlderThanDays,
    pinned: state.pinned,
    archived: state.archived,
    activeId: state.activeId,
  })
  if (ids.length === 0) return []
  for (const id of ids) state.setArchived(id, true)
  console.info(
    `[auto-archive] 已归档 ${ids.length} 个旧会话（保留 ${prefs.taskAutoArchiveOlderThanDays} 天）`,
  )
  requestSessionListRefresh()
  return ids
}

let running: Promise<string[]> | null = null
let queued: Promise<string[]> | null = null

/** 串行扫描：进行中的扫描结束后补扫一次（设置变更与定时器撞车不丢）。 */
export function scanAutoArchive(): Promise<string[]> {
  if (running === null) {
    running = scanOnce().finally(() => {
      running = null
    })
    return running
  }
  queued ??= running
    .catch(() => [])
    .then(() => {
      queued = null
      return scanAutoArchive()
    })
  return queued
}

let timer: ReturnType<typeof setInterval> | null = null

/** 启动调度器（主窗 AppPrefsBoot 挂载时调用一次）。返回清理函数。 */
export function startAutoArchiveScheduler(): () => void {
  if (timer !== null) return () => {}
  const tick = () => {
    void scanAutoArchive().catch((error) => {
      console.error('[auto-archive] 自动归档扫描失败，等待下一轮', error)
    })
  }
  tick()
  timer = setInterval(tick, AUTO_ARCHIVE_SCAN_INTERVAL_MS)
  return () => {
    if (timer !== null) clearInterval(timer)
    timer = null
  }
}

/** 设置变更后立即补扫（失败可见）。 */
export function rescanAutoArchiveNow(): void {
  void scanAutoArchive().catch((error) => {
    console.error('[auto-archive] 设置变更后的补扫失败', error)
  })
}

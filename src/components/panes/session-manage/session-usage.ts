/**
 * 会话用量缓存（rowMeta「Tokens/成本」的数据面）：pi stats 聚合结果按
 * 会话文件缓存，键 = {path, messageCount}——messageCount 变了（会话又写了
 * 消息）才算过期。拉取经 IPC pi_sessions_usage（Rust 侧逐文件
 * pi::stats::aggregate 流式解析，hermes rowMeta 的 hermes 后端对偶）。
 *
 * 只在 Show 菜单打开 tokens/cost 后按需拉（懒计算，任务定稿）；并发请求
 * 收敛为一次（in-flight 去重）；失败 console.error 可见、不缓存失败态
 * （下次 ensure 重试——失败不冒充 0 值）。
 */
import { invoke } from '@tauri-apps/api/core'
import { createStore, useStore } from 'zustand'

import type { SessionUsageRow } from './session-figures'

/** 拉取输入：会话文件路径 + 当前条数（过期判定键）。 */
export interface UsageRequestRow {
  readonly path: string
  readonly messageCount: number
}

interface CacheEntry extends SessionUsageRow {
  readonly messageCount: number
}

interface SessionUsageState {
  /** path → 用量（含拉取时的 messageCount 快照）。 */
  readonly rows: Readonly<Record<string, CacheEntry>>
  /** 确保这些行的用量在缓存里（缺/过期才发 IPC；进行中不重复发）。 */
  ensure(rows: readonly UsageRequestRow[]): Promise<void>
}

let inFlight: Promise<void> | null = null

export const sessionUsageStore = createStore<SessionUsageState>((set, get) => ({
  rows: {},
  ensure: (requestRows) => {
    const stale = requestRows.filter((row) => {
      const cached = get().rows[row.path]
      return !cached || cached.messageCount !== row.messageCount
    })
    if (stale.length === 0) return Promise.resolve()
    // in-flight 收敛：上一次请求进行中则等它（完成后本批过期行会在下一次
    // ensure 重试——不排进同一请求，避免请求形状漂移）
    if (inFlight) return inFlight
    const paths = [...new Set(stale.map((row) => row.path))]
    inFlight = invoke<Record<string, { totalTokens?: unknown; costUsd?: unknown }>>(
      'pi_sessions_usage',
      { paths },
    )
      .then((result) => {
        const next: Record<string, CacheEntry> = { ...get().rows }
        for (const row of stale) {
          const got = result[row.path]
          if (
            !got ||
            typeof got.totalTokens !== 'number' ||
            !Number.isFinite(got.totalTokens) ||
            typeof got.costUsd !== 'number' ||
            !Number.isFinite(got.costUsd)
          ) {
            // 响应缺行/形状非法 = 该行不缓存（下次 ensure 重试），console 可见
            console.error('[session-usage] pi_sessions_usage 响应缺少合法条目——跳过', row.path, got)
            continue
          }
          next[row.path] = { totalTokens: got.totalTokens, costUsd: got.costUsd, messageCount: row.messageCount }
        }
        set({ rows: next })
      })
      .catch((e) => {
        console.error('[session-usage] 会话用量拉取失败（rowMeta 显示留空，下次刷新重试）', e)
      })
      .finally(() => {
        inFlight = null
      })
    return inFlight
  },
}))

/** React 订阅（组件层用）。 */
export const useSessionUsage = <T,>(selector: (s: SessionUsageState) => T): T =>
  useStore(sessionUsageStore, selector)

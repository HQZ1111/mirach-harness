/**
 * TAIL HYDRATION（hermes `store/transcript-tail` + `app/chat/transcript-backfill`
 * 的宿主对偶，2026-11-19 性能轮）。
 *
 * ## 为什么
 *
 * 旧水合 = `pi_get_messages` 全量。巨会话（11MB / 2036 条条目）一次水合
 * 冷 3.9s / 热 0.6s（纯 IPC 载荷），切页签/切 bot 都要等它。hermes 的做法：
 * 首屏只拉**最新一页**（256 行），「显示更早」再按需补页。
 *
 * ## 口径
 *
 * - 页 = 引擎 `SessionTree::transcript_page(limit, before_id)`：从分支尾部
 *   往回切，`beforeId` = 上一页最老条目 id（None = 最新页）；
 * - `entryIds` 逐条对应消息——行 id 用它（`msg-<entryId>-<role>`），跨页
 *   prepend 时 React key / 树节点身份不漂移；
 * - 时间线标记（模型切换/压缩）用 `beforeMessageIndexFromEnd`（之后还剩几条
 *   user|assistant）定位：本地落点 = 已加载条数 − FromEnd，与是否加载了
 *   头部无关；
 * - 补页守卫：响应回来时会话已切走 → 丢弃；空页 → hasMore 归 false。
 *
 * ## 失败语义（规矩 12）
 *
 * 首屏页失败照常 throw（调用方本来就 await 水合，失败要可见）；补页失败
 * `console.error` + 返回 0，保留已加载内容，下次点击重试。
 */
import { invoke } from '@tauri-apps/api/core'
import { createStore, useStore } from 'zustand'

import {
  hydratePiMessages,
  usageFromPiMessages,
} from './pi-hydrate'
import type { TurnMessage, TurnUsage } from './turn-actor'

/** 一页的原始条目数（`pi_get_messages_page.limit` 缺省值，与 hermes 同量级）。 */
export const TRANSCRIPT_PAGE_SIZE = 256

interface MessagesPageWire {
  messages?: Record<string, unknown>[]
  entryIds?: string[]
  hasMore?: boolean
  leafId?: unknown
}

interface TranscriptTailState {
  /** 当前 tail 快照对应的会话 id */
  sessionId: string | null
  /** 下一页更老一页的 `before` 游标（当前已加载最老条目 id） */
  oldestEntryId: string | null
  /** 后端还有更老条目 */
  hasMore: boolean
  /** 补页请求在途（按钮 / 滚顶节流） */
  loading: boolean
}

const emptyTail: TranscriptTailState = {
  sessionId: null,
  oldestEntryId: null,
  hasMore: false,
  loading: false,
}

export const transcriptTailStore = createStore<TranscriptTailState>(() => emptyTail)

/** 组件订阅：是否有更老的消息可补。 */
export const useTranscriptTail = () =>
  useStore(transcriptTailStore, (s) => s.hasMore)

/** 水合回调：type 用 TurnEvent 的形态，由调用方交给 XState actor。 */
export interface TranscriptHydrator {
  send(
    event:
      | { type: 'HYDRATE'; messages: TurnMessage[]; usage?: TurnUsage | null }
      | { type: 'PREPEND_HISTORY'; messages: TurnMessage[] },
  ): void
}

/** 当前 runtime 的 actor 注册表（thread.aui 的「显示更早」经此提交补页）。 */
let registeredActor: TranscriptHydrator | null = null

export function registerTranscriptActor(actor: TranscriptHydrator): void {
  registeredActor = actor
}

/** 最新一页 -> actor HYDRATE（会话打开 / 分支切换 / fork 后重水合共用）。 */
export async function hydrateTranscriptTail(
  actor: TranscriptHydrator,
  sessionId: string | null,
): Promise<void> {
  const page = await invoke<MessagesPageWire>('pi_get_messages_page', {
    limit: TRANSCRIPT_PAGE_SIZE,
  })
  const wire = Array.isArray(page?.messages) ? page.messages : []
  actor.send({
    type: 'HYDRATE',
    messages: hydratePiMessages(wire, page?.entryIds),
    usage: usageFromPiMessages(wire),
  })
  transcriptTailStore.setState({
    sessionId,
    oldestEntryId: page?.entryIds?.[0] ?? null,
    hasMore: page?.hasMore === true && wire.length > 0,
    loading: false,
  })
}

/**
 * 「显示更早」：向后端要更老的一页并前插。返回是否真的加进了行（false =
 * 没有更老内容 / 在途 / 会话已切走 / 失败）。
 */
export async function loadOlderTranscript(): Promise<boolean> {
  const tail = transcriptTailStore.getState()
  if (!tail.hasMore || !tail.oldestEntryId || tail.loading) return false
  const actor = registeredActor
  if (!actor) {
    console.error('[transcript] 补页被请求但 runtime actor 未注册——跳过')
    return false
  }
  const requestedFor = tail.sessionId
  transcriptTailStore.setState({ loading: true })
  let page: MessagesPageWire
  try {
    page = await invoke<MessagesPageWire>('pi_get_messages_page', {
      before: tail.oldestEntryId,
      limit: TRANSCRIPT_PAGE_SIZE,
    })
  } catch (e) {
    transcriptTailStore.setState({ loading: false })
    console.error('[transcript] 更早消息补页失败（保留已加载内容，可重试）', e)
    return false
  }
  // 过期响应守卫：拉取期间会话已切走 -> 丢弃
  if (transcriptTailStore.getState().sessionId !== requestedFor) return false
  const wire = Array.isArray(page?.messages) ? page.messages : []
  if (wire.length === 0) {
    transcriptTailStore.setState({ hasMore: false, loading: false })
    return false
  }
  actor.send({
    type: 'PREPEND_HISTORY',
    messages: hydratePiMessages(wire, page?.entryIds),
  })
  transcriptTailStore.setState({
    oldestEntryId: page?.entryIds?.[0] ?? tail.oldestEntryId,
    hasMore: page?.hasMore === true,
    loading: false,
  })
  return true
}

/**
 * 把当前会话的完整历史补进 store（Tail 水合后只有尾部一页）。
 *
 * 仅用于显式全量消费面（导出 Markdown 等）：逐页 loadOlderTranscript 直到
 * `hasMore=false`；页数上限 64（≈1.6 万条消息）防死循环，超限如实报错。
 * 失败向上传播（调用方决定是否按已加载内容继续）。
 */
export async function ensureFullTranscript(): Promise<void> {
  let guard = 0
  while (transcriptTailStore.getState().hasMore) {
    if (guard >= 64) {
      throw new Error('历史超过 64 页仍未读完——放弃全量加载')
    }
    if (!(await loadOlderTranscript())) return
    guard += 1
  }
}

/** 会话域重置（New Chat / 打开新会话前调用）：清空游标与在途态。 */
export function resetTranscriptTail(): void {
  transcriptTailStore.setState(emptyTail)
}
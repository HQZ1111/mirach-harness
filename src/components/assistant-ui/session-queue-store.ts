/**
 * 排队消息队列（官方 message-queue 元素的数据面）——**按会话分桶 + 持久化**
 * （2026-11-28 用户："原来输入框里的消息和排队消息，切换会话后都没了，
 * 关闭重启应用也没了"）。
 *
 * isRunning 时用户提交的新消息**入队**（不进轮次投影、不发 POST——pi
 * prompt 持锁跨整个 run，立即 POST 只会得到锁冲突），run 收尾
 * （RUN_FINISHED/RUN_ERROR，二者都走轮次机 streaming→idle 迁移）后由
 * runtime 逐条 drain 发出（每条出队 = USER_SUBMIT 乐观进投影 + postRun，
 * 发完等本 run 收尾再发下一条）。
 *
 * 与旧版（单一内存队列）的差异：
 * - **按会话分桶**（键 = `sessionThreadKey(id)`）：切换会话不再 clear——
 *   A 会话的排队消息留在 A，切回 A 继续按序发出（hermes
 *   `$queuedPromptsBySession` 同语义）；焦点会话切换时由 runtime 同步
 *   `activeKey`，队列面板/drain 都按焦点键读写。
 * - **localStorage 持久化**（`mirach:session-queue.v1`）：重启后恢复
 *   （hermes `hermes.desktop.composerQueue.v1` 同语义）；上限 30 会话 /
 *   每会话 20 条，超限丢弃最旧会话（排队意图是短命态，不做无限增长）。
 * - 会话**删除**时清该会话的队列（runtime onDelete）；切换不清。
 *
 * 排队行为与 pi Config 的对应关系（config.rs steering_mode/follow_up_mode，
 * one-at-a-time 为默认）：pi 0.6.x 的官方排队原语在当前版本尚未接线，本
 * store 是宿主侧等价物——pi 后续版本可用官方 queue 原语替换（外部 store
 * runtime 的 queue adapter 槽位即其挂点）。
 */
import { createStore, useStore } from 'zustand'

import { sessionThreadKey } from './session-thread-key'
import type { TurnAttachment } from './attachments'

/** 排队消息图片载荷（POST /ag-ui images[] 条目：纯 base64 + mimeType）。
 * 与 runtime 的 PiImagePayload 同形状——结构类型直接兼容，避免
 * runtime↔store 循环导入。 */
export interface QueuedImage {
  data: string
  mimeType: string
}

export interface QueuedMessage {
  id: string
  /** 显示文本（乐观用户消息 / 队列面板）。 */
  text: string
  /** 实际发给引擎的文本（语音委托的隐藏 note/上下文；缺省 = text）。 */
  submission?: string
  images?: QueuedImage[]
  /** 乐观用户消息的 image data URL（drain 时经 USER_SUBMIT images 进投影） */
  imageDataUrls?: string[]
  /** 视频/音频/文档的文件引用（drain 时经 USER_SUBMIT files 进投影；
   *  路径引用块已在 submission 文本里） */
  files?: TurnAttachment[]
}

const STORAGE_KEY = 'mirach:session-queue.v1'
const MAX_SESSIONS = 30
const MAX_PER_SESSION = 20

interface PersistedQueues {
  bySession: Record<string, QueuedMessage[]>
}

function loadPersisted(): Record<string, QueuedMessage[]> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as PersistedQueues
    if (!parsed || typeof parsed.bySession !== 'object' || parsed.bySession === null) {
      console.error('[queue] 排队持久化形状非法——按空队列处理', STORAGE_KEY)
      return {}
    }
    // 形状守卫：只收对象数组形状的条目（损坏条目整桶丢弃，不静默半收）
    const bySession: Record<string, QueuedMessage[]> = {}
    for (const [key, items] of Object.entries(parsed.bySession)) {
      if (!Array.isArray(items)) continue
      const valid = items.filter(
        (item): item is QueuedMessage =>
          !!item &&
          typeof item === 'object' &&
          typeof (item as QueuedMessage).id === 'string' &&
          typeof (item as QueuedMessage).text === 'string',
      )
      if (valid.length > 0) bySession[key] = valid.slice(0, MAX_PER_SESSION)
    }
    return bySession
  } catch (e) {
    console.error('[queue] 排队持久化读取失败——按空队列处理', e)
    return {}
  }
}

function persist(bySession: Record<string, QueuedMessage[]>): void {
  try {
    // 超限丢最旧会话（keys 序 = 插入序近似；足够表达"短命态"语义）
    const keys = Object.keys(bySession)
    const trimmed: Record<string, QueuedMessage[]> = {}
    for (const key of keys.slice(-MAX_SESSIONS)) {
      trimmed[key] = bySession[key] ?? []
    }
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ bySession: trimmed } satisfies PersistedQueues),
    )
  } catch (e) {
    console.error('[queue] 排队持久化写入失败（内存队列不受影响）', e)
  }
}

interface SessionQueueState {
  /** 会话键 → 排队条目（键 = sessionThreadKey(id)；含 New Chat 哨兵键） */
  bySession: Record<string, QueuedMessage[]>
  /** drain 失败预算（hermes MAX_AUTO_DRAIN_ATTEMPTS 对偶）：达到上限该会话
   *  停放（不再自动重试），错误 console 可见；新入队或手动重置后清零。
   *  内存态（不持久化，重启从零计数——重启本身就是一次新的尝试机会）。 */
  drainFailures: Record<string, number>
  noteDrainFailure: (key: string, error: unknown) => void
  resetDrainFailures: (key: string) => void
  /** 焦点会话键（runtime 随 currentThreadId 同步；面板/drain 按它读写） */
  activeKey: string
  enqueue: (key: string, item: QueuedMessage) => void
  remove: (key: string, id: string) => void
  /** 出队队首（drain 消费）；空队列返回 null 且不动状态 */
  takeFirst: (key: string) => QueuedMessage | null
  /** 清空指定会话的队列——只在**会话删除**时调用（切换不清！） */
  clearSession: (key: string) => void
  setActiveKey: (key: string) => void
}

export const sessionQueue = createStore<SessionQueueState>((set, get) => ({
  bySession: loadPersisted(),
  activeKey: sessionThreadKey(null),
  enqueue: (key, item) =>
    set((s) => {
      const items = [...(s.bySession[key] ?? []), item].slice(-MAX_PER_SESSION)
      const bySession = { ...s.bySession, [key]: items }
      persist(bySession)
      return { bySession }
    }),
  remove: (key, id) =>
    set((s) => {
      const items = (s.bySession[key] ?? []).filter((m) => m.id !== id)
      const bySession = { ...s.bySession, [key]: items }
      persist(bySession)
      return { bySession }
    }),
  takeFirst: (key) => {
    const items = get().bySession[key] ?? []
    if (items.length === 0) return null
    const first = items[0]
    set((s) => {
      const bySession = { ...s.bySession, [key]: (s.bySession[key] ?? []).slice(1) }
      persist(bySession)
      return { bySession }
    })
    return first ?? null
  },
  clearSession: (key) =>
    set((s) => {
      if (!(key in s.bySession)) return {}
      const bySession = { ...s.bySession }
      delete bySession[key]
      persist(bySession)
      return { bySession }
    }),
  setActiveKey: (key) => set({ activeKey: key }),
  drainFailures: {},
  noteDrainFailure: (key, error) => {
    const count = (get().drainFailures[key] ?? 0) + 1
    console.error(
      `[queue] ${key} drain 失败第 ${count} 次（上限 ${MAX_DRAIN_FAILURES}）`,
      error,
    )
    set({ drainFailures: { ...get().drainFailures, [key]: count } })
  },
  resetDrainFailures: (key) => {
    if ((get().drainFailures[key] ?? 0) === 0) return
    const drainFailures = { ...get().drainFailures, [key]: 0 }
    set({ drainFailures })
  },
}))

/** 焦点会话的排队条目（队列面板 / drain 用）。
 *
 * **选择器必须返回稳定引用**：`?? []` 每次调用都是新数组，useSyncExternalStore
 * 快照永远变化 → "getSnapshot should be cached" + "Maximum update depth
 * exceeded"，整个壳被错误边界打掉（2026-11-28 实锤：启动即炸、报错面是
 * 下游的 Slot/队列组件——"对话丢失"的一部分症状就是它）。空态用模块级常量。 */
export const EMPTY_QUEUE: QueuedMessage[] = []

/** 自动 drain 失败上限（hermes MAX_AUTO_DRAIN_ATTEMPTS 同值）。 */
export const MAX_DRAIN_FAILURES = 4

/** 该会话是否已停放（失败耗尽，不再自动重试）。 */
export const isQueueParked = (key: string): boolean =>
  (sessionQueue.getState().drainFailures[key] ?? 0) >= MAX_DRAIN_FAILURES

export const selectQueueItems = (state: {
  bySession: Record<string, QueuedMessage[]>
  activeKey: string
}): QueuedMessage[] => state.bySession[state.activeKey] ?? EMPTY_QUEUE

export const useSessionQueueItems = (): QueuedMessage[] =>
  useStore(sessionQueue, selectQueueItems)

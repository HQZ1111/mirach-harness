/**
 * 排队消息队列（官方 message-queue 元素的数据面）：isRunning 时用户提交
 * 的新消息**入队**（不进轮次投影、不发 POST——pi prompt 持锁跨整个 run，
 * 立即 POST 只会得到锁冲突），run 收尾（RUN_FINISHED/RUN_ERROR，二者都
 * 走轮次机 streaming→idle 迁移）后由 runtime 逐条 drain 发出（每条出队 =
 * USER_SUBMIT 乐观进投影 + postRun，发完等本 run 收尾再发下一条）。
 *
 * 排队行为与 pi Config 的对应关系（config.rs:114-117 steering_mode /
 * follow_up_mode，one-at-a-time 为默认）：pi 0.6.x 的官方排队原语在当前
 * vendored 版本尚未接线，本 store 是宿主侧等价物——语义按 one-at-a-time
 * 实现（同一时刻只有一个 run，队首消息在前一 run 收尾后才发出）；pi 后续
 * 版本可用官方 queue 原语替换本 store（外部 store runtime 的 queue adapter
 * 槽位即其挂点）。
 *
 * zustand vanilla 模式（createStore + getState/setState），照抄
 * connection-store / branch-bridge；队列是纯内存态（进程内排队意图，
 * 不持久化——刷新即消失，与 composer 草稿的丢失语义一致）。
 */
import { createStore, useStore } from 'zustand'

/** 排队消息图片载荷（POST /ag-ui images[] 条目：纯 base64 + mimeType）。
 * 与 runtime 的 PiImagePayload 同形状——结构类型直接兼容，避免
 * runtime↔store 循环导入。 */
export interface QueuedImage {
  data: string
  mimeType: string
}

export interface QueuedMessage {
  id: string
  text: string
  images?: QueuedImage[]
  /** 乐观用户消息的 image data URL（drain 时经 USER_SUBMIT images 进投影） */
  imageDataUrls?: string[]
}

interface SessionQueueState {
  items: QueuedMessage[]
  enqueue: (item: QueuedMessage) => void
  remove: (id: string) => void
  /** 出队队首（drain 消费）；空队列返回 null 且不动状态 */
  takeFirst: () => QueuedMessage | null
  /** 清空（会话更换时由 runtime 调用——排队意图属于原会话轨迹） */
  clear: () => void
}

export const sessionQueue = createStore<SessionQueueState>((set, get) => ({
  items: [],
  enqueue: (item) =>
    set((s) => ({ items: [...s.items, item] })),
  remove: (id) =>
    set((s) => ({ items: s.items.filter((m) => m.id !== id) })),
  takeFirst: () => {
    const first = get().items[0]
    if (!first) return null
    set((s) => ({ items: s.items.slice(1) }))
    return first
  },
  clear: () => set({ items: [] }),
}))

export const useSessionQueue = () => useStore(sessionQueue)

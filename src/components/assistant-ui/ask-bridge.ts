/**
 * ask 工具交互卡桥（docs/pi-coverage.md：ask 交互卡）。
 *
 * 与 approval-bridge 同款：`CUSTOM name=ask_request` 只是"有新问题"的
 * 信号（流上不带详情）——卡片数据以 Rust 端 AskRegistry 为唯一真相，
 * 挂载/收到信号/应答后经 IPC 拉取全量挂起列表（重放流不复活已答卡片）。
 *
 * 应答：`pi_ask_response(id, answers, dismissed)` → pi
 * `AskTool::respond_ui`（内部 oneshot 回灌给正在等待的工具调用）。
 */
import { invoke } from '@tauri-apps/api/core'
import { createStore, useStore } from 'zustand'

/** pi `ask::AskOption`（serde 默认 camelCase——无 rename 属性，字段即小写）。 */
export interface AskOption {
  label: string
  description?: string
}

/** pi `ask::AskQuestion`。 */
export interface AskQuestion {
  id?: string
  question: string
  header?: string
  options: AskOption[]
  recommended?: number
  multi: boolean
}

/** `pi_ask_pending` 的一行：`AskUiRequest` 投影（id + questions）。 */
export interface PendingAsk {
  id: string
  request: { questions: AskQuestion[] }
}

/** pi 的答案形状（`ask::AskAnswer`，serde camelCase）。 */
export interface AskAnswer {
  questionId: string
  selected: string[]
  other?: string
}

interface AskBridgeState {
  pending: PendingAsk[]
  refresh: () => Promise<void>
  /** 回答一张卡：逐题选中的 option label；dismissed = 用户关闭 */
  respond: (id: string, answers: AskAnswer[], dismissed: boolean) => Promise<void>
}

const asQuestion = (raw: unknown): AskQuestion | null => {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (typeof r.question !== 'string') return null
  const opts = Array.isArray(r.options)
    ? r.options
        .map((o) => {
          if (typeof o !== 'object' || o === null) return null
          const oo = o as Record<string, unknown>
          if (typeof oo.label !== 'string') return null
          return {
            label: oo.label,
            ...(typeof oo.description === 'string' ? { description: oo.description } : {}),
          }
        })
        .filter((o): o is AskOption => o !== null)
    : []
  return {
    ...(typeof r.id === 'string' ? { id: r.id } : {}),
    question: r.question,
    ...(typeof r.header === 'string' ? { header: r.header } : {}),
    options: opts,
    ...(typeof r.recommended === 'number' ? { recommended: r.recommended } : {}),
    multi: r.multi === true,
  }
}

/** 严格解析 `pi_ask_pending` 的返回（坏行 console.error + 跳过）。 */
export function parsePendingAsks(raw: unknown): PendingAsk[] {
  if (!Array.isArray(raw)) {
    console.error('[ask] pi_ask_pending 返回非数组——丢弃', raw)
    return []
  }
  const out: PendingAsk[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) {
      console.error('[ask] 挂起项形状非法——跳过', item)
      continue
    }
    const r = item as Record<string, unknown>
    const id = typeof r.id === 'string' ? r.id : null
    const req = r.request
    if (id === null || typeof req !== 'object' || req === null) {
      console.error('[ask] 挂起项缺 id/request——跳过', item)
      continue
    }
    const rawQs = (req as Record<string, unknown>).questions
    if (!Array.isArray(rawQs)) {
      console.error('[ask] 挂起项 questions 非数组——跳过', item)
      continue
    }
    const questions = rawQs
      .map(asQuestion)
      .filter((q): q is AskQuestion => q !== null)
    if (questions.length === 0) continue
    out.push({ id, request: { questions } })
  }
  return out
}

export const askBridge = createStore<AskBridgeState>((set) => ({
  pending: [],
  refresh: async () => {
    let next: PendingAsk[]
    try {
      const raw = await invoke<unknown>('pi_ask_pending')
      next = parsePendingAsks(raw)
    } catch (e) {
      if (!String(e).includes('no active session')) {
        console.error('[ask] 挂起问题拉取失败', e)
      }
      next = []
    }
    // 结构不变不落 state（每秒轮询 × IPC 新数组 = 订阅者每秒重渲染；
    // 与 approval-bridge 同款 dedupe，2026-11-19 性能轮）。
    const prev = askBridge.getState().pending
    if (JSON.stringify(prev) === JSON.stringify(next)) return
    set({ pending: next })
  },
  respond: async (id, answers, dismissed) => {
    try {
      await invoke('pi_ask_response', { id, answers, dismissed })
    } catch (e) {
      // 失败可见（应答未送达 = 用户以为答了其实没有，必须报）
      console.error('[ask] 应答失败', e)
      throw e
    } finally {
      // 无论成败都重拉（失败时卡片保留，成功时移除）
      await askBridge.getState().refresh()
    }
  },
}))

export const useAskBridge = () => useStore(askBridge)

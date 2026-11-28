/**
 * 发送发件箱（hermes store/composer-outbox.ts 的宿主最小对偶，2026-11-28）。
 *
 * hermes 语义（原文件注释）：Enter 那一刻**同步**把"这条要发的消息"写进
 * 持久层（浏览器崩溃/关窗也不丢）；发送结果已知后 retire；下次加载该会话
 * 时，**没有活页面持有**的条目恢复为「草稿 + 重试身份」——**不自动重发**
 * （防双发）。宿主差异（如实标注）：
 *  - 宿主单窗（多窗未启用），无 Web Locks 争夺——直接按会话键存读；
 *  - 恢复面：草稿为空时把 outbox 文本回填 composer（composer-draft 的恢复
 *    优先级高于它）；重试身份 = 队列条目的 id（drain 重试沿用同 id →
 *    turn-actor 的 appendUser 幂等门挡重复）。
 */
import { createStore, useStore } from 'zustand'

const STORAGE_KEY = 'mirach:send-outbox.v1'
const MAX_SESSIONS = 30
const MAX_PER_SESSION = 10
const MAX_AGE_MS = 24 * 60 * 60 * 1000

export interface OutboxEntry {
  /** 稳定提交 id（USER_SUBMIT 的 messageId；重试沿用）。 */
  id: string
  /** 用户可见文本（恢复成草稿时用）。 */
  text: string
  /** 实际提交载荷（含附件拼装的 prompt；恢复草稿时不回填——附件不跨页）。 */
  submission: string
  createdAt: number
}

interface Persisted {
  bySession: Record<string, OutboxEntry[]>
}

function loadPersisted(): Persisted {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { bySession: {} }
    const parsed = JSON.parse(raw) as unknown
    if (parsed === null || typeof parsed !== 'object') return { bySession: {} }
    const bySession: Record<string, OutboxEntry[]> = {}
    const now = Date.now()
    for (const [key, value] of Object.entries(
      (parsed as { bySession?: Record<string, unknown> }).bySession ?? {},
    )) {
      if (!Array.isArray(value)) continue
      const valid = value.filter(
        (e): e is OutboxEntry =>
          typeof e === 'object' &&
          e !== null &&
          typeof (e as OutboxEntry).id === 'string' &&
          typeof (e as OutboxEntry).text === 'string' &&
          now - ((e as OutboxEntry).createdAt ?? 0) < MAX_AGE_MS,
      )
      if (valid.length > 0) bySession[key] = valid.slice(-MAX_PER_SESSION)
    }
    return { bySession }
  } catch (e) {
    console.error('[outbox] 读取失败，从空表起步', e)
    return { bySession: {} }
  }
}

export interface SendOutboxState extends Persisted {
  journalSend: (key: string, entry: OutboxEntry) => void
  retireSend: (key: string, id: string) => void
  /** 会话删除 = 整键清（与队列/草稿同生命周期）。 */
  clearSession: (key: string) => void
}

export const sendOutbox = createStore<SendOutboxState>()((set, get) => {
  const persist = (bySession: Record<string, OutboxEntry[]>) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ bySession }))
    } catch (e) {
      console.error('[outbox] 持久化失败', e)
    }
  }
  const put = (key: string, entries: OutboxEntry[]) => {
    const cur = get().bySession
    // 会话上限：按最近写入裁剪（超限丢最旧的会话桶）
    const next = { ...cur, [key]: entries.slice(-MAX_PER_SESSION) }
    const keys = Object.keys(next)
    if (keys.length > MAX_SESSIONS) {
      const newest = (k: string) => next[k]!.at(-1)?.createdAt ?? 0
      keys.sort((a, b) => newest(a) - newest(b))
      for (const k of keys.slice(0, keys.length - MAX_SESSIONS)) delete next[k]
    }
    persist(next)
    set({ bySession: next })
  }
  return {
    bySession: loadPersisted().bySession,
    journalSend: (key, entry) => {
      const cur = get().bySession[key] ?? []
      put(key, [...cur.filter((e) => e.id !== entry.id), entry])
    },
    retireSend: (key, id) => {
      const cur = get().bySession[key]
      if (!cur || !cur.some((e) => e.id === id)) return
      put(
        key,
        cur.filter((e) => e.id !== id),
      )
    },
    clearSession: (key) => {
      const cur = get().bySession
      if (!(key in cur)) return
      const next = { ...cur }
      delete next[key]
      persist(next)
      set({ bySession: next })
    },
  }
})

/** 未退场的最后一条（恢复成草稿用；不存在 = null）。 */
export const lastPendingSend = (key: string): OutboxEntry | null =>
  sendOutbox.getState().bySession[key]?.at(-1) ?? null

export const usePendingSends = (key: string): OutboxEntry[] =>
  useStore(sendOutbox, (s) => s.bySession[key] ?? EMPTY_SENDS)

const EMPTY_SENDS: OutboxEntry[] = []

/** 测试隔离。 */
export function resetSendOutboxForTests(): void {
  sendOutbox.setState({ bySession: {} })
}

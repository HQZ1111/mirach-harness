/**
 * 会话目录——**会话名/项目名的单一真相源**（用户 2026-10-03 定稿："前端
 * 只是映射，应该有一个储存会话名，项目名的地方，左侧栏，主对话栏，所有
 * 的地方都从那里取"）。
 *
 * **唯一写入者 = runtime 数据面**（pi 会话列表 + 消息流）：
 * - `ingest()`：pi_list_sessions 全量灌入（refreshThreads 每次调用）；
 *   保留既有 derivedTitle（pi 行无名时前端派生标题仍有效）；
 * - `setActive()`：活动会话切换；
 * - `setDerivedTitle()`：首条用户消息的派生标题（消息流变化时写入）；
 * - `setPendingCwd()`：「选择工作区新建会话」记住 cwd——新会话（尚未
 *   落盘、不在 entries）的项目名来源。
 *
 * **消费方（全部只读）**：左侧栏 ThreadList（assistant-ui threads 派生）、
 * 主对话双行块（ChatTabLabel）、workspace 页签名（flex-layout）、标签总览
 * 面板。显示名统一走 `sessionDisplayName`：pi name ?? 派生标题 ?? New Chat。
 */
import { createStore } from 'zustand/vanilla'

export interface SessionCatalogEntry {
  id: string
  /** jsonl 路径（打开/删除/导出用）。 */
  path?: string
  /** pi 端名称（自动命名 / pi_rename_session）。 */
  piName?: string
  /** 前端派生标题（首条用户消息——pi 无名时的显示名）。 */
  derivedTitle?: string
  /** 工作区 cwd（项目名来源）。 */
  cwd?: string
  messageCount?: number
  lastModifiedMs?: number
  createdMs?: number
}

export interface SessionCatalogState {
  entries: Record<string, SessionCatalogEntry>
  /** 稳定显示序（pi 返回序）。 */
  order: string[]
  /** 活动会话 id；null = New Chat（无活动会话）。 */
  activeId: string | null
  /** 新会话项目名来源（「选择工作区新建会话」最近一次 cwd）。 */
  pendingCwd: string | null
  ingest(rows: SessionCatalogRow[], activeId: string | null): void
  setActive(id: string | null): void
  setDerivedTitle(id: string, title: string | undefined): void
  setPendingCwd(cwd: string | null): void
}

/** refreshThreads 行形状（runtime.tsx 的 ThreadListRow 结构子集）。 */
export interface SessionCatalogRow {
  id: string
  title?: string
  custom?: {
    path?: unknown
    cwd?: unknown
    messageCount?: unknown
    lastModifiedMs?: unknown
    timestamp?: unknown
  }
}

const numOrUndef = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined
const strOrUndef = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 ? v : undefined

export const sessionCatalog = createStore<SessionCatalogState>((set, get) => ({
  entries: {},
  order: [],
  activeId: null,
  pendingCwd: null,
  ingest: (rows, activeId) => {
    const prev = get().entries
    const entries: Record<string, SessionCatalogEntry> = {}
    const order: string[] = []
    for (const row of rows) {
      const prior = prev[row.id]
      entries[row.id] = {
        id: row.id,
        path: strOrUndef(row.custom?.path) ?? prior?.path,
        piName: strOrUndef(row.title),
        // pi 无名时保留前端派生标题（消息面写入，列表刷新不丢）
        derivedTitle: prior?.derivedTitle,
        cwd: strOrUndef(row.custom?.cwd),
        messageCount: numOrUndef(row.custom?.messageCount),
        lastModifiedMs: numOrUndef(row.custom?.lastModifiedMs),
        createdMs: numOrUndef(row.custom?.timestamp),
      }
      order.push(row.id)
    }
    set({ entries, order, activeId })
  },
  setActive: (id) => set({ activeId: id }),
  setDerivedTitle: (id, title) => {
    const e = get().entries[id]
    // 无会话行（未落盘）也要能记派生标题——先占位
    if (!e) {
      if (title === undefined) return
      set({ entries: { ...get().entries, [id]: { id, derivedTitle: title } } })
      if (!get().order.includes(id)) set({ order: [...get().order, id] })
      return
    }
    if (e.derivedTitle === title) return
    set({ entries: { ...get().entries, [id]: { ...e, derivedTitle: title } } })
  },
  setPendingCwd: (cwd) => set({ pendingCwd: cwd }),
}))

/** 统一显示名（所有消费方同源）：pi name ?? 派生标题 ?? New Chat。 */
export const sessionDisplayName = (e: SessionCatalogEntry | undefined): string =>
  e?.piName ?? e?.derivedTitle ?? 'New Chat'

/** 统一项目名来源：会话 cwd ?? 待落盘新会话 cwd。 */
export const sessionProjectCwd = (
  e: SessionCatalogEntry | undefined,
  pendingCwd: string | null,
): string | undefined => e?.cwd ?? pendingCwd ?? undefined

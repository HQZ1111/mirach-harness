/**
 * 会话归档（客户端归档——pi 无 archive 概念，hermes 交互照抄：归档的会话
 * 从侧栏隐藏但保留全部消息；Show 菜单「已归档」开关显示它们；行菜单
 * 归档/取消归档；⌥+⇧ 点击手势走 session-row-gesture 的 'archive' 分支）。
 *
 * 与 hiddenPanes（flexlayout 窗格隐藏，mirach.layout.hiddenPanes.v1）是
 * 两套机制：这里只藏侧栏行，不动布局。键 mirach.harness.sessions.archived.v1
 * = sessionId 数组；形状非法 console.error 从空态起（禁止兜底）。
 *
 * hermes 归档真相在后端（SessionDB archived 列）；客户端归档后若 pi 侧
 * 会话被其它宿主继续写入，lastModifiedMs 照旧增长——未读判定不受归档影响
 * （归档行默认不渲染，亮着的水位只是记账）。
 */
import { createStore, useStore } from 'zustand'

export const ARCHIVED_KEY = 'mirach.harness.sessions.archived.v1'

const safeGetItem = (key: string): string | null => {
  if (typeof localStorage === 'undefined') return null
  try {
    return localStorage.getItem(key)
  } catch (e) {
    console.error(`[session-archive] localStorage 读取失败（${key}）`, e)
    return null
  }
}

const safeSetItem = (key: string, value: string): void => {
  try {
    localStorage.setItem(key, value)
  } catch (e) {
    console.error(`[session-archive] localStorage 写入失败（${key}）——归档不持久`, e)
  }
}

/** 严格解析归档数组：非 string[] → console.error + 空表（去重保序）。 */
export const parseArchived = (raw: string | null): string[] => {
  if (raw === null) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    console.error(`[session-archive] ${ARCHIVED_KEY} JSON 解析失败——从空归档起`, e)
    return []
  }
  if (!Array.isArray(parsed) || parsed.some((x) => typeof x !== 'string')) {
    console.error(`[session-archive] ${ARCHIVED_KEY} 形状非法（应为 string[]）——从空归档起`, parsed)
    return []
  }
  return [...new Set(parsed as string[])]
}

interface SessionArchiveState {
  archived: readonly string[]
  /** 归档/取消归档（hermes archiveSession/unarchive 对偶）。 */
  toggleArchive(id: string): void
  /** 已消失会话清键（列表非空才清——同 sessionManageStore.prune 纪律）。 */
  prune(existingIds: readonly string[]): void
}

export const sessionArchiveStore = createStore<SessionArchiveState>((set, get) => ({
  archived: parseArchived(safeGetItem(ARCHIVED_KEY)),
  toggleArchive: (id) => {
    const next = get().archived.includes(id)
      ? get().archived.filter((a) => a !== id)
      : [...get().archived, id]
    set({ archived: next })
    safeSetItem(ARCHIVED_KEY, JSON.stringify(next))
  },
  prune: (existingIds) => {
    if (existingIds.length === 0) return
    const next = get().archived.filter((id) => existingIds.includes(id))
    if (next.length === get().archived.length) return
    set({ archived: next })
    safeSetItem(ARCHIVED_KEY, JSON.stringify(next))
  },
}))

/** React 订阅（组件层用）。 */
export const useSessionArchive = <T,>(selector: (s: SessionArchiveState) => T): T =>
  useStore(sessionArchiveStore, selector)

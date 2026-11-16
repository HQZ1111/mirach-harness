/**
 * 隐藏会话路径集合（hermes `host.setPersistedSessionHidden` 的宿主对偶）。
 *
 * ## 上游语义
 *
 * hermes 的会话有服务端 `hidden` 旗标：Bot Mode 打开的会话一律隐藏，侧栏
 * 只显示非 bot 会话。桌面端在进入/退出 Bot Mode 时逐会话调用
 * `host.setPersistedSessionHidden(route, {sessionId, hidden})`。
 *
 * ## 宿主对偶
 *
 * pi 引擎没有会话级 hidden 面（AGENTS.md「pi 无 hidden 会话面」已实锤）。
 * 隐藏因此落在**显示层**：这里持久化一份路径集合，`thread-list.aui.tsx`
 * 的行投影与搜索面按路径过滤。两类来源：
 *
 * - bots 插件的 `setPersistedSessionHidden`（会话打开/关闭时自动调）；
 * - `session.create {hidden:true}` 的群聊成员会话（room_plumbing——
 *   canonical Bot Chat 走双锚机制，不重复登记）。
 *
 * 与 bots-store 的双锚信任规则的区别：这里存的是**宿主自己创的 / 插件
 * 明确点名要藏的**路径，不做名字匹配，因此不存在误藏同名用户会话的风险。
 */

import { createStore, useStore } from 'zustand'

const STORAGE_KEY = 'mirach.harness.hidden-session-paths.v1'

interface HiddenSessionsState {
  /** 会话文件绝对路径集合（去重，最近在前）。 */
  paths: string[]
  loaded: boolean
  load: () => void
  hide: (path: string) => void
  show: (path: string) => void
}

function parse(raw: null | string): string[] {
  if (raw === null) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) {
      console.error('[hidden-sessions] 存储形状非法（应为数组）——按空表起步', parsed)
      return []
    }
    return parsed.filter((p): p is string => typeof p === 'string' && p.length > 0)
  } catch (e) {
    console.error('[hidden-sessions] 存储解析失败——按空表起步（原值保留）', e)
    return []
  }
}

export const hiddenSessionsStore = createStore<HiddenSessionsState>((set, get) => ({
  paths: [],
  loaded: false,
  load: () => {
    if (get().loaded) return
    set({ paths: parse(localStorage.getItem(STORAGE_KEY)), loaded: true })
  },
  hide: (path) => {
    const trimmed = path.trim()
    if (!trimmed) return
    if (!get().loaded) get().load()
    if (get().paths.includes(trimmed)) return
    const next = [trimmed, ...get().paths]
    set({ paths: next })
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    } catch (e) {
      console.error('[hidden-sessions] 落盘失败', e)
    }
  },
  show: (path) => {
    if (!get().loaded) get().load()
    const next = get().paths.filter((p) => p !== path)
    if (next.length === get().paths.length) return
    set({ paths: next })
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    } catch (e) {
      console.error('[hidden-sessions] 落盘失败', e)
    }
  },
}))

/** React 订阅。 */
export const useHiddenSessions = <T,>(selector: (s: HiddenSessionsState) => T): T =>
  useStore(hiddenSessionsStore, selector)

/** 非 React 读取（host-rpc / bridge 用；首次访问自动 load）。 */
export function hiddenSessionPaths(): Set<string> {
  const state = hiddenSessionsStore.getState()
  if (!state.loaded) state.load()
  return new Set(hiddenSessionsStore.getState().paths)
}

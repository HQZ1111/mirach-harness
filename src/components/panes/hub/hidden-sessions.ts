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

// ── Bot Mode 管道会话的**标题面**过滤（2026-11-25）────────────────────────
//
// hermes `session-sweep.ts:247-254` 的逐字对偶：Bot Mode 自己铸造的会话
// 标题恰为 "Bot Chat" / "Agent Inbox"，群聊成员会话以 "Group: " 开头——
// 上游由服务端 hidden 位与 ownership sweep 双保险隐藏。宿主没有服务端
// hidden 面，路径簿记（上面的 store + bots-store 双锚）覆盖不到
// **历史上铸造的**行（隔离前/旧版本逻辑 mint 的 Bot Chat 没有双锚记录，
// 用户实报"哪里来的这么多的 chat bot，现在会话名字还是有很多 chat bot"）。
//
// 故侧栏显示层再加一道**标题判据**：bots 插件启用时隐藏这三类标题。
// 判据与上游逐字同形（精确匹配 + "Group: " 前缀）——用户自己的会话标题
// 不受影响（上游注释同款承诺）。

/** 会话标题是否属于 Bot Mode 管道（侧栏应隐藏）。 */
export function isBotModePlumbingTitle(title: null | string | undefined): boolean {
  const t = String(title ?? '').trim()
  // `Router: <roomId>` 是 canonical 群聊的自动路由会话（group driver 内部
  // 会话），既不该出现在侧栏，也不该成为「上次会话」被启动恢复
  // （2026-11-27 实机：打包版启动直接打开了 Router 的内部英文提示）。
  return t === 'Bot Chat' || t === 'Agent Inbox' || t.startsWith('Group: ') || t.startsWith('Router: ')
}

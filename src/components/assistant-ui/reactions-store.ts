/**
 * 消息表情反应（hermes store/reactions*.ts 的宿主对偶，2026-11-28 完整移植
 * ——无 assistant-ui 上游对偶，属"完整移植"档）。
 *
 * 与 hermes 的差异（数据面事实，不是简化）：
 *  - hermes 的反应真相在**网关**（消息 metadata.custom.reactions + agent
 *    的 react_to_message 工具事件 + rowId 系 overlay）；宿主 pi 没有反应
 *    存储，也没有 agent 反应事件——本 store 是**本机唯一真相**（localStorage
 *    持久化，重启仍在），不假装有服务端；
 *  - **键 = 会话键 + 角色 + 文本指纹**（而不是消息 id）：宿主消息 id 在
 *    "实时客户端生成 id → 重载后按会话文件 entryId 重水合"之间会变（乐观
 *    user-<ts>、运行段 id 都会换），按键会丢反应；文本指纹跨实时/水合稳定。
 *    代价：同一会话里两条完全相同的消息共享反应（罕见，注释在案）；
 *  - agent 反应不实现（无事件源——不造假数据）。
 *
 * 语义抄 hermes：每人每消息**一条**用户反应（tapback），再点同款撤销；
 * 交互即时翻转（本地直改，无往返）。
 */
import { createStore, useStore } from 'zustand'

/** 快速反应行（hermes store/reactions.ts QUICK_REACTIONS 逐字）。 */
export const QUICK_REACTIONS = ['❤️', '👍', '👎', '😂', '‼️', '❓'] as const
/** 双击落的 tapback（hermes：Apple 的第一个 Tapback，也是我们的）。 */
export const DOUBLE_CLICK_REACTION = QUICK_REACTIONS[0]

const STORAGE_KEY = 'mirach:reactions.v1'

/** djb2 文本指纹（跨实时/水合稳定；只用于键的第三段）。 */
function fingerprint(text: string): string {
  let h = 5381
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) + h + text.charCodeAt(i)) | 0
  }
  return (h >>> 0).toString(36)
}

/** 反应键：会话 + 角色 + 文本指纹（见文件头"差异"段）。 */
export function reactionKey(
  sessionKey: string,
  role: 'user' | 'assistant',
  text: string,
): string {
  return `${sessionKey}::${role}::${fingerprint(text)}`
}

type ReactionMap = Record<string, string>

function readInitial(): ReactionMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      // 坏档不静默丢弃：可见报错，从空表起步（不 fallback 假装无事）。
      console.error('[reactions] 存储形状非法，已重置:', parsed)
      return {}
    }
    const out: ReactionMap = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string') out[k] = v
    }
    return out
  } catch (e) {
    console.error('[reactions] 读取失败，从空表起步', e)
    return {}
  }
}

export interface ReactionsState {
  /** key → emoji（用户在该消息上的反应；无键 = 无反应）。 */
  byKey: ReactionMap
  /** 切掉/撤下反应立即翻 UI；持久化在同一步内完成（本机真相，无往返）。 */
  toggle: (key: string, emoji: string) => void
  retract: (key: string) => void
}

export const reactionsStore = createStore<ReactionsState>()((set, get) => {
  const persist = (byKey: ReactionMap) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(byKey))
    } catch (e) {
      // 规矩 11：持久化失败可见（本轮内存态仍生效，重启会丢）。
      console.error('[reactions] 持久化失败', e)
    }
  }
  return {
    byKey: readInitial(),
    toggle: (key, emoji) => {
      const cur = get().byKey
      const next = cur[key] === emoji ? null : emoji
      const byKey = { ...cur }
      if (next === null) delete byKey[key]
      else byKey[key] = next
      persist(byKey)
      set({ byKey })
    },
    retract: (key) => {
      const cur = get().byKey
      if (!(key in cur)) return
      const byKey = { ...cur }
      delete byKey[key]
      persist(byKey)
      set({ byKey })
    },
  }
})

/** 单消息的反应（无反应 = null）。 */
export function useReaction(sessionKey: string, role: 'user' | 'assistant', text: string): string | null {
  const key = reactionKey(sessionKey, role, text)
  return useStore(reactionsStore, (s) => s.byKey[key] ?? null)
}

/** 测试隔离：清空内存表（localStorage 由测试环境自管）。 */
export function resetReactionsForTests(): void {
  reactionsStore.setState({ byKey: {} })
}

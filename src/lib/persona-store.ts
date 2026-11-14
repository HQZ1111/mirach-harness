/**
 * 个性（persona）身份字段的持久化 —— 显示名 + 描述。
 *
 * 上游 openhuman 用 redux-persist 的 `persona` slice（`store/personaSlice.ts`，
 * 长度上限 80 / 500，超限**拒绝而不是截断**——用户还在编辑草稿）。
 * 宿主没有 redux，用 zustand + localStorage，语义逐条照搬：
 *
 * - 两个字段都是"界面怎么显示这个助手"，不是提示词输入 → 不写 SOUL.md。
 *   （写进 SOUL.md 会让它们变成模型输入，语义就变了。）
 * - 超限返回 null → 调用方保持旧值，不静默截断。
 * - 空白串是合法的"已清空"。
 *
 * 真正的个性提示词在 `~/.pi/agent/SOUL.md`（pi_persona_* IPC，
 * 会话创建时注入 append_system_prompt）。
 */
import { createStore, useStore } from 'zustand'

export const MAX_PERSONA_DISPLAY_NAME_LEN = 80
export const MAX_PERSONA_DESCRIPTION_LEN = 500

const STORAGE_KEY = 'mirach:persona'

interface PersonaState {
  displayName: string
  description: string
  setDisplayName: (value: string) => void
  setDescription: (value: string) => void
  reset: () => void
}

/** 上游 normalizePersonaField：非字符串 → ''；超限 → null（调用方保持旧值）。 */
function normalize(value: unknown, maxLen: number): string | null {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (trimmed.length > maxLen) return null
  return trimmed
}

function readPersisted(): { displayName: string; description: string } {
  if (typeof localStorage === 'undefined') return { displayName: '', description: '' }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === null) return { displayName: '', description: '' }
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) {
      return { displayName: '', description: '' }
    }
    const obj = parsed as { displayName?: unknown; description?: unknown }
    // 上游 rehydrate 同款：异常值擦成 ''，不让坏 blob 污染 UI
    return {
      displayName: normalize(obj.displayName, MAX_PERSONA_DISPLAY_NAME_LEN) ?? '',
      description: normalize(obj.description, MAX_PERSONA_DESCRIPTION_LEN) ?? '',
    }
  } catch (e) {
    // 坏 JSON = 缺陷，必须可见（规矩 12）；回空值让 UI 可用
    console.error('[persona] localStorage 解析失败，按未设置处理', e)
    return { displayName: '', description: '' }
  }
}

function persist(state: { displayName: string; description: string }) {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ displayName: state.displayName, description: state.description }),
    )
  } catch (e) {
    // 配额满 / 隐私模式：写不进去必须可见（不假装已保存）
    console.error('[persona] localStorage 写入失败（本次改动不会持久化）', e)
  }
}

const initial = readPersisted()

export const personaStore = createStore<PersonaState>((set, get) => ({
  ...initial,
  setDisplayName: (value) => {
    const next = normalize(value, MAX_PERSONA_DISPLAY_NAME_LEN)
    // 超限 = 拒绝（上游 reducer 同语义：保持旧值，用户还能继续编辑）
    if (next === null) return
    set({ displayName: next })
    persist({ displayName: next, description: get().description })
  },
  setDescription: (value) => {
    const next = normalize(value, MAX_PERSONA_DESCRIPTION_LEN)
    if (next === null) return
    set({ description: next })
    persist({ displayName: get().displayName, description: next })
  },
  reset: () => {
    set({ displayName: '', description: '' })
    persist({ displayName: '', description: '' })
  },
}))

export function usePersona<T>(selector: (s: PersonaState) => T): T {
  return useStore(personaStore, selector)
}

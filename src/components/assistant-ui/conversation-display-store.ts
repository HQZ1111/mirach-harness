/**
 * 设置页「行为与工具」节的宿主偏好 store（ZCode 同款三项，2026-11-22 移植）：
 *
 * - `showReasoning`（显示思考过程）：true → 消息流展示全部思考；
 *   false → 每轮只保留第一条非空思考（其余从流中剔除，不当工作项计）。
 *   ZCode 语义 = `messageStreamShowReasoning`（conversationRowContext.ts:223-231
 *   `showReasoning === true || rowId === firstReasoningRowId`）；迁移后
 *   ZCode 默认 true（validationAppSettings.ts:281-296 一次性强制开启）。
 * - `showTodos`（显示待办）：true → todo 工具卡片进消息流；false → 剔除
 *   （状态面板的待办分区仍是唯一入口）。ZCode 默认 false。
 * - `interactionBehavior`（交互行为）：`queue`（默认，= ZCode 默认）→ 运行中
 *   提交的消息进宿主队列，本轮结束后跟进；`guide` → 经 `pi_steer` 注入当前
 *   run 的 steer 队列，引擎在下一次工具调用批后生效（ZCode「引导至下一轮
 *   工具调用后运行」同语义；rpi MessageDelivery::Steer）。
 *
 * 键：`mirach:conversation-show-reasoning` / `mirach:conversation-show-todos` /
 * `mirach:interaction-behavior`。宿主**默认值与现状一致**（思考恒显、待办
 * 恒剔、运行中恒排队）——开关只增加选择，不改变既有观感。
 *
 * 跨窗同步：设置独立窗（`?win=settings` 的独立 webview）与主窗共享同一个
 * WebView2 profile 的 localStorage；写入方之外的其他文档会收到 `storage`
 * 事件，这里监听并重读，主窗的对话区即时跟随设置窗的改动。
 *
 * 消费方：`work-parts.aui.tsx`（扫描/尾巴判定）、`tool-renderers.aui.tsx`
 * （todo 分流）、`runtime.tsx`（onNew 的运行中提交分支）。
 */
import { createStore, useStore } from 'zustand'

const KEY_SHOW_REASONING = 'mirach:conversation-show-reasoning'
const KEY_SHOW_TODOS = 'mirach:conversation-show-todos'
const KEY_INTERACTION_BEHAVIOR = 'mirach:interaction-behavior'

export type InteractionBehavior = 'queue' | 'guide'

/** 严格布尔读：`'true'`/`'false'` 之外（缺失/损坏）回落 fallback。 */
const readBool = (key: string, fallback: boolean): boolean => {
  try {
    const raw = window.localStorage.getItem(key)
    if (raw === 'true') return true
    if (raw === 'false') return false
    return fallback
  } catch {
    return fallback
  }
}

const readInteractionBehavior = (): InteractionBehavior => {
  try {
    return window.localStorage.getItem(KEY_INTERACTION_BEHAVIOR) === 'guide' ? 'guide' : 'queue'
  } catch {
    return 'queue'
  }
}

const writeValue = (key: string, value: string): void => {
  try {
    window.localStorage.setItem(key, value)
  } catch (e) {
    console.error('[conversation-display] 偏好持久化失败', key, e)
  }
}

interface ConversationDisplayState {
  /** 显示思考过程（默认 true，与 ZCode 迁移后默认一致）。 */
  showReasoning: boolean
  /** 显示待办（默认 false，与 ZCode 默认一致）。 */
  showTodos: boolean
  /** 交互行为：运行中提交 = 排队（queue，默认）或注入当前轮（guide）。 */
  interactionBehavior: InteractionBehavior
  setShowReasoning(value: boolean): void
  setShowTodos(value: boolean): void
  setInteractionBehavior(value: InteractionBehavior): void
}

export const conversationDisplayStore = createStore<ConversationDisplayState>((set) => ({
  showReasoning: readBool(KEY_SHOW_REASONING, true),
  showTodos: readBool(KEY_SHOW_TODOS, false),
  interactionBehavior: readInteractionBehavior(),
  setShowReasoning: (value) => {
    writeValue(KEY_SHOW_REASONING, value ? 'true' : 'false')
    set({ showReasoning: value })
  },
  setShowTodos: (value) => {
    writeValue(KEY_SHOW_TODOS, value ? 'true' : 'false')
    set({ showTodos: value })
  },
  setInteractionBehavior: (value) => {
    writeValue(KEY_INTERACTION_BEHAVIOR, value)
    set({ interactionBehavior: value })
  },
}))

// 跨文档同步（设置独立窗写入 → 主窗重读）。事件只在**其它**文档触发，
// 本窗写入走 setter 直达，无需去重。
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key === KEY_SHOW_REASONING) {
      conversationDisplayStore.setState({
        showReasoning: readBool(KEY_SHOW_REASONING, true),
      })
    } else if (event.key === KEY_SHOW_TODOS) {
      conversationDisplayStore.setState({ showTodos: readBool(KEY_SHOW_TODOS, false) })
    } else if (event.key === KEY_INTERACTION_BEHAVIOR) {
      conversationDisplayStore.setState({ interactionBehavior: readInteractionBehavior() })
    }
  })
}

export const useConversationDisplay = <T,>(
  selector: (state: ConversationDisplayState) => T,
): T => useStore(conversationDisplayStore, selector)

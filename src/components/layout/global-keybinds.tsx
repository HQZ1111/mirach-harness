/**
 * 全局快捷键派发器（hermes app/hooks/use-keybinds.ts 的移植，2026-10-24）。
 *
 * **挂载点必须在 `AssistantRuntime` 包装内**（dockview-shell）：session.new
 * 要调 `aui.threads.switchToNewThread()`，那依赖壳级 runtime provider 的
 * React 上下文。全局 keydown 单监听（capture 阶段）+ 组合索引派发，
 * 编辑目标（input/textarea/contenteditable）内跳过——hermes 同语义。
 *
 * 捕获态（设置页正在重绑）时：keydown 路由进捕获流程——Esc=取消，
 * Backspace/Delete=清除绑定，修饰键本体=继续等待。
 */

import { useEffect } from 'react'
import { useAui } from '@assistant-ui/react'

import { openCommandPalette, openSettingsOverlay } from '@/components/layout/app-context-menu'
import { comboFromEvent, useKeybindStore } from '@/lib/keybinds'

/** 事件目标是否为编辑区（hermes editable-target 同判）。 */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  return target.matches('input, textarea, select')
}

export function GlobalKeybinds(): null {
  // aui 上下文（session.new 用）：必须在组件体取——effect 回调里调 hook
  // 是规则违反（Invalid hook call，实测把整棵聊天树炸进 RuntimeBoundary）。
  const aui = useAui()
  // 订阅绑定快照（写操作后派发器用最新表）
  const bindings = useKeybindStore((s) => s.bindings)
  const capturing = useKeybindStore((s) => s.capturing)
  const endCapture = useKeybindStore((s) => s.endCapture)
  const setBinding = useKeybindStore((s) => s.setBinding)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const store = useKeybindStore.getState()

      // ── 捕获态：设置页正在等一颗键 ──
      if (store.capturing !== null) {
        e.preventDefault()
        e.stopPropagation()
        if (e.key === 'Escape') {
          endCapture()
          return
        }
        if (e.key === 'Backspace' || e.key === 'Delete') {
          setBinding(store.capturing, [])
          return
        }
        const combo = comboFromEvent(e)
        if (combo !== null) {
          setBinding(store.capturing, [combo])
        }
        return
      }

      const combo = comboFromEvent(e)
      if (combo === null) return

      // 组合索引：当前绑定表里命中该组合的 action（按注册序取第一个）
      const hits = Object.entries(bindings)
        .filter(([, combos]) => combos.includes(combo))
        .map(([id]) => id)
      if (hits.length === 0) return

      // 编辑区内不派发（hermes editable-target 同语义；注册表里全部动作
      // 都是 modified 组合，输入框里按 Ctrl+N 属于浏览器行为归属，跳过）
      if (isEditableTarget(e.target)) return

      const handlers: Record<string, () => void> = {
        'session.new': () => void aui.threads.switchToNewThread(),
        'nav.commandPalette': () => openCommandPalette(),
        'nav.settings': () => openSettingsOverlay(),
      }

      for (const id of hits) {
        const handler = handlers[id]
        if (handler === undefined) continue
        e.preventDefault()
        e.stopPropagation()
        handler()
        return
      }
    }

    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [aui, bindings, capturing, endCapture, setBinding])

  return null
}

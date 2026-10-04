/**
 * 对话宽度手柄（dsh 官方 ui-conversation 的 WidthHandle 完整移植）——
 * 源 = packages/client/ui-conversation/src/client/skeleton/ConversationRoot.tsx
 * + ConversationRoot.module.css（2026-10-05 用户提供 dsh master 检出版搬运；
 * 该检出已带 mirach 调参：CONTENT_MIN 330 = 用户设定，官方原值 640 按
 * 网页版列宽假设写死、与窄主栏组合会令手柄区间为负）。
 *
 * 交互语义（照抄官方）：
 *  - 左右各一条 40px col-resize 条带（绝对定位在对话列两侧），拖拽 =
 *    对称缩放（两侧同写一个居中宽度，向外 1px = 内容宽 +2）；
 *  - pointermove 发布指针 Y 到 --dsh-width-handle-pointer-y（光条跟随）；
 *  - 拖拽中只发布实时夹紧值；**有位移的松手才落盘**（原地按放不得用被
 *    窗口夹紧的显示值覆盖更宽的已存偏好）；pointercancel / 丢捕获 =
 *    放弃手势并按存储偏好重新发布；
 *  - 偏好存 localStorage dsh.conversation.contentWidth（px）。
 *
 * 与官方两处偏差（有意，均已注释）：
 *  1. resolveContentWidth 的无偏好自适应与 CSS clamp 完全一致（官方 TS
 *     侧多一层 max(680,…) 地板，与其自身 CSS 在 <1063px 列宽下不一致——
 *     harness 主栏常驻该区间，照抄会出现"抓住手柄瞬间跳宽"）；
 *  2. 列宽变化时存储偏好按新旧列宽**等比迁移**（apps/mirach 的
 *     conversation-width.ts 补丁行为：窗口最大化/还原时宽度跟随缩放），
 *     官方只重夹不迁移。
 */

import { useCallback, useEffect, useRef, useState } from 'react'

/** localStorage key for the dragged transcript width preference (px). */
const WIDTH_PREF_KEY = 'dsh.conversation.contentWidth'
/** Floor for a dragged content width. mirach: 对话内容宽最小 330（用户设定）。 */
const CONTENT_MIN = 330
/** Column budget the content must leave free: 88px per side keeps the width
 * handles fully placeable (24px inset + 40px strip + 24px safe zone). */
const CONTENT_EDGE_BUDGET = 176

/** Reads the persisted width preference; a missing or corrupt value resolves
 * to "no preference". @returns the stored width in px, or null. */
function readWidthPreference(): number | null {
  const raw = localStorage.getItem(WIDTH_PREF_KEY)
  if (raw === null) return null
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : null
}

/** Resolves the content width the CSS axis shows for a column width —
 * mirrors the CSS clamp exactly（官方 TS 的 max(680,…) 地板在窄列与其自身
 * CSS 打架，harness 统一到 CSS 语义）. */
export function resolveContentWidth(columnWidth: number, preference: number | null): number {
  const max = Math.max(CONTENT_MIN, columnWidth - CONTENT_EDGE_BUDGET)
  if (preference !== null) return Math.min(Math.max(preference, CONTENT_MIN), max)
  return Math.max(CONTENT_MIN, Math.min(columnWidth * 0.64, 920))
}

/** One transcript width handle: pointer capture + rAF-throttled symmetric
 * resize (both sides write the one centered width, so outward travel widens
 * by 2× the pointer distance). pointermove publishes the pointer's Y as a CSS
 * variable so the glow indicator rides it. */
export function WidthHandle(props: {
  side: 'left' | 'right'
  onStart: () => number
  onDrag: (width: number) => void
  onCommit: (width: number) => void
  onEnd: () => void
}) {
  const [dragging, setDragging] = useState(false)
  const base = useRef(0)
  const origin = useRef(0)
  const latest = useRef(0)
  const frame = useRef<number | null>(null)
  const callbacks = useRef(props)
  callbacks.current = props

  const outwardWidth = () => {
    const dx = latest.current - origin.current
    const outward = callbacks.current.side === 'right' ? dx : -dx
    return base.current + outward * 2
  }
  const cancelFrame = () => {
    if (frame.current !== null) {
      cancelAnimationFrame(frame.current)
      frame.current = null
    }
  }
  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    origin.current = e.clientX
    latest.current = e.clientX
    base.current = callbacks.current.onStart()
    setDragging(true)
  }, [])
  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    // 指针 Y 发布到**父容器**（thread 根）——两侧手柄的 ::after 共享同一个
    // 值，光条对称等高（用户 2026-10-05：只发在悬停侧会让另一侧停在 50%
    // 中线，两侧高度看着不一致）。两条手柄同高同位，坐标空间一致。
    const host = e.currentTarget.parentElement
    if (host) {
      const y = e.clientY - host.getBoundingClientRect().top
      host.style.setProperty('--dsh-width-handle-pointer-y', `${y}px`)
    }
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
    latest.current = e.clientX
    frame.current ??= requestAnimationFrame(() => {
      frame.current = null
      callbacks.current.onDrag(outwardWidth())
    })
  }, [])
  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
    e.currentTarget.releasePointerCapture(e.pointerId)
    cancelFrame()
    latest.current = e.clientX
    // Only a gesture with actual travel commits: a press-and-release on a
    // window-clamped width must not overwrite the wider stored preference
    // with the clamped display value.
    if (latest.current !== origin.current) callbacks.current.onCommit(outwardWidth())
    setDragging(false)
    callbacks.current.onEnd()
  }, [])
  // Releasing the button outside the window delivers pointercancel (or drops
  // the capture silently) instead of pointerup; the gesture is abandoned
  // uncommitted — onEnd republishes the stored preference.
  const onPointerCancel = useCallback(() => {
    cancelFrame()
    setDragging(false)
    callbacks.current.onEnd()
  }, [])

  return (
    <div
      className="aui-width-handle"
      data-side={props.side}
      data-width-handle={props.side}
      data-dragging={dragging || undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onLostPointerCapture={onPointerCancel}
    />
  )
}

/** 宽度轴（thread 根消费）：观察对话列宽 → 发布
 * --dsh-conversation-column-width 与 --dsh-chat-user-width（拖出的偏好按
 * 列宽重夹、并按补丁行为等比迁移存储值），返回手柄的四段拖拽回调。
 * 列宽收缩只重夹显示值、不改写已存偏好——加宽窗口后偏好原样恢复。 */
export function useConversationWidthAxis() {
  const rootEl = useRef<HTMLDivElement | null>(null)
  const rootObserver = useRef<ResizeObserver | null>(null)
  const lastColumn = useRef(0)

  const publishWidths = useCallback((root: HTMLElement): void => {
    const column = root.offsetWidth
    root.style.setProperty('--dsh-conversation-column-width', `${column}px`)
    let preference = readWidthPreference()
    if (preference !== null) {
      // 列宽变化：偏好按新旧列宽比例等比迁移（最大化/还原跟随缩放——
      // apps/mirach conversation-width.ts 的补丁行为）
      if (lastColumn.current > 0 && lastColumn.current !== column) {
        const migrated = resolveContentWidth(
          column,
          Math.round(preference * (column / lastColumn.current)),
        )
        if (migrated !== preference) {
          try {
            localStorage.setItem(WIDTH_PREF_KEY, String(migrated))
            preference = migrated
          } catch {
            /* 存储失败忽略——本轮仍按旧偏好夹紧发布 */
          }
        }
      }
      root.style.setProperty('--dsh-chat-user-width', `${resolveContentWidth(column, preference)}px`)
    } else {
      root.style.removeProperty('--dsh-chat-user-width')
    }
    lastColumn.current = column
  }, [])

  const rootResizeRef = useCallback(
    (root: HTMLDivElement | null): void => {
      rootObserver.current?.disconnect()
      rootObserver.current = null
      rootEl.current = root
      if (root === null) return
      rootObserver.current = new ResizeObserver(() => {
        publishWidths(root)
      })
      rootObserver.current.observe(root)
      publishWidths(root)
    },
    [publishWidths],
  )

  // Drag plumbing（照抄官方）：onStart 快照解析宽（夹紧态抓取不跳回原始
  // 偏好），onDrag 只发布实时夹紧值，onCommit 落盘有位移手势的宽度，
  // onEnd 从存储重新发布。
  const onHandleStart = useCallback((): number => {
    const root = rootEl.current
    if (root === null) return 680
    return resolveContentWidth(root.offsetWidth, readWidthPreference())
  }, [])
  const onHandleDrag = useCallback((width: number): void => {
    const root = rootEl.current
    if (root === null) return
    const clamped = resolveContentWidth(root.offsetWidth, width)
    root.style.setProperty('--dsh-chat-user-width', `${clamped}px`)
  }, [])
  const onHandleCommit = useCallback((width: number): void => {
    const root = rootEl.current
    if (root === null) return
    try {
      localStorage.setItem(WIDTH_PREF_KEY, `${resolveContentWidth(root.offsetWidth, width)}`)
    } catch (e) {
      console.error('[width-handle] 持久化对话宽度失败', e)
    }
  }, [])
  const onHandleEnd = useCallback((): void => {
    const root = rootEl.current
    if (root !== null) publishWidths(root)
  }, [publishWidths])

  // 卸载断观察（组件卸载时 root ref 会被 React 置 null 走 disconnect）
  useEffect(
    () => () => {
      rootObserver.current?.disconnect()
      rootObserver.current = null
    },
    [],
  )

  return { rootResizeRef, onHandleStart, onHandleDrag, onHandleCommit, onHandleEnd }
}

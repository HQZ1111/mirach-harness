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
 *  1. 无偏好默认 = **最大**（列宽−176 手柄余量；2026-11-25 用户："平时默认
 *     对话宽度最大"），JS 与 CSS（panes.css 的 --dsh-chat-content-width）
 *     同语义；官方 TS 侧是 64%/920 自适应 + 一层 max(680,…) 地板，与其
 *     自身 CSS 在窄列下不一致——照抄会出现"抓住手柄瞬间跳宽"；
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
/** 列宽变化 → 偏好按比例迁移的**基准**（2026-10-18 修累积漂移）。
 *
 *  旧实现每帧 `preference × (新列宽/旧列宽)` 并把结果**写回存储**——侧栏
 *  收放补间的每一帧都会触发 ResizeObserver，一次收放写 13 次、两次 26 次
 *  （实测 828 → 1153 → 831，净漂 +3px）。根因不是"取整误差"，是**链式
 *  相乘**：每次迁移都以"上一次取整后的值"为基数，误差被反复放大。
 *
 *  正解 = 只在`列宽稳定`后迁移一次，且迁移永远相对**同一个基准**算：
 *  基准 = { column, preference } 的快照，列宽没变到"稳定值"之前不写存储。
 *  这样同一基准下任意次求值结果相同，不会漂。 */
interface WidthBaseline {
  column: number
  preference: number
}

/** 列宽稳定判定（收放补间结束的静默期）。320ms 补间 + 取整抖动，400ms
 *  足够；期间只发布显示值、不落盘。 */
const MIGRATE_SETTLE_MS = 400

/** 把基准偏好按"基准列宽 → 目标列宽"的比例缩放（**相对基准算，不链式**）。
 *  单独抽成纯函数便于单测：同一 (baseline, target) 永远同一结果。 */
export function scalePreference(baseline: WidthBaseline, targetColumn: number): number {
  return Math.round(baseline.preference * (targetColumn / baseline.column))
}

/** Reads the persisted width preference; a missing or corrupt value resolves
 * to "no preference". @returns the stored width in px, or null. */
function readWidthPreference(): number | null {
  const raw = localStorage.getItem(WIDTH_PREF_KEY)
  if (raw === null) return null
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : null
}

/** Resolves the content width the CSS axis shows for a column width —
 * mirrors the CSS clamp (`panes.css` 的 --dsh-chat-content-width) exactly。
 *
 * **2026-11-25 用户："平时默认对话宽度最大"**：无偏好 = 最大（列宽−176），
 * 不再有 64%/920 的"阅读宽"自适应默认——那会让缺省态比最大值窄一截。
 * 有偏好时仍夹在 [330, 列宽−176]。 */
export function resolveContentWidth(columnWidth: number, preference: number | null): number {
  const max = Math.max(CONTENT_MIN, columnWidth - CONTENT_EDGE_BUDGET)
  if (preference !== null) return Math.min(Math.max(preference, CONTENT_MIN), max)
  return max
}

/** One transcript width handle: pointer capture + rAF-throttled symmetric
 * resize (both sides write the one centered width, so outward travel widens
 * by 2× the pointer distance). pointermove publishes the pointer's Y as a CSS
 * variable so the glow indicator rides it. */
export function WidthHandle(props: {
  side: 'left' | 'right'
  /** 保留位：面板让位已由 panes.css 按 `--dsh-column-width` /
   *  `--dsh-panel-offset` 统一计算（与内容列同源），调用方不再传类——
   *  第二写入者会让手柄与内容列漂移。 */
  shiftClass?: string
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
      className={
        'aui-width-handle' +
        // 面板让位（与内容列同款类：恒位移或 ≥1280 容器宽位移）——手柄跟列走
        (props.shiftClass ? ' ' + props.shiftClass : '')
      }
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
 * 列宽重夹、列宽**稳定后**按比例迁移存储值），返回手柄的四段拖拽回调。
 * 列宽收缩只重夹显示值、不改写已存偏好——加宽窗口后偏好原样恢复。 */
export function useConversationWidthAxis() {
  const rootEl = useRef<HTMLDivElement | null>(null)
  const rootObserver = useRef<ResizeObserver | null>(null)
  /** 迁移基准（见 WidthBaseline 注释）：链式相乘会漂，必须锚定不变的一对值。 */
  const baseline = useRef<WidthBaseline | null>(null)
  const settleTimer = useRef<number | null>(null)
  const pendingColumn = useRef(0)

  const publishWidths = useCallback((root: HTMLElement): void => {
    const column = root.offsetWidth
    root.style.setProperty('--dsh-conversation-column-width', `${column}px`)
    const preference = readWidthPreference()
    if (preference === null) {
      root.style.removeProperty('--dsh-chat-user-width')
      return
    }
    // 首次或列宽没变：只发布显示值，不动存储。
    const base = baseline.current
    if (base === null) {
      baseline.current = { column, preference }
      root.style.setProperty('--dsh-chat-user-width', `${resolveContentWidth(column, preference)}px`)
      return
    }
    if (base.column === column) {
      root.style.setProperty('--dsh-chat-user-width', `${resolveContentWidth(column, preference)}px`)
      return
    }
    // 列宽在变：**先按比例即时发布**（视觉跟手），但**不写存储**——
    // 收放补间每帧都会到这里，此时落盘就会链式累积漂移（见 WidthBaseline）。
    root.style.setProperty(
      '--dsh-chat-user-width',
      `${resolveContentWidth(column, scalePreference(base, column))}px`,
    )
    // 稳定后才迁移一次：以**基准**为起点重算，与中间过了多少帧无关
    // （幂等——同一 (基准, 目标列宽) 永远得到同一个结果，不漂）。
    pendingColumn.current = column
    if (settleTimer.current !== null) window.clearTimeout(settleTimer.current)
    settleTimer.current = window.setTimeout(() => {
      settleTimer.current = null
      const settled = pendingColumn.current
      const b = baseline.current
      if (!b || settled === b.column) return
      const migrated = resolveContentWidth(settled, scalePreference(b, settled))
      try {
        localStorage.setItem(WIDTH_PREF_KEY, String(migrated))
      } catch (e) {
        console.error('[width-handle] 持久化对话宽度失败', e)
      }
      // 基准前移：下一次迁移相对"这次稳定后的列宽与偏好"算。
      baseline.current = { column: settled, preference: migrated }
    }, MIGRATE_SETTLE_MS)
  }, [])

  // 卸载清场（计时器不泄漏）。
  useEffect(
    () => () => {
      if (settleTimer.current !== null) window.clearTimeout(settleTimer.current)
    },
    [],
  )

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
    const column = root.offsetWidth
    const committed = resolveContentWidth(column, width)
    try {
      localStorage.setItem(WIDTH_PREF_KEY, `${committed}`)
    } catch (e) {
      console.error('[width-handle] 持久化对话宽度失败', e)
    }
    // **用户拖拽是新基准**（2026-10-18）：不更新的话，下一次列宽变化会拿
    // 拖拽**之前**的旧基准去算，把用户刚设定的宽度又按旧比例缩放回去。
    baseline.current = { column, preference: committed }
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

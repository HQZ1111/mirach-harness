/**
 * 侧栏会话列表拖拽排序——逐字照抄 hermes apps/desktop/src/app/chat/sidebar/
 * reorderable-list.tsx（dnd-kit 0.11 一系的 @dnd-kit/core 6.3.1 +
 * @dnd-kit/sortable 10.0.0，钉版见 package.json）。置顶区与会话区各挂一个
 * （各自拥有 DndContext——拖拽只与本列表条目碰撞，互不越组）。
 *
 * 视觉实锤（用户点名处）：无 DragOverlay——拖起的行就是原行（useSortable 的
 * transform 跟指针 Y），isDragging 行 z-10 + 不透明底 + cursor-grabbing
 * （session-row.tsx:369），压暗 0.45 由跨面 pointer 机器统一施加
 * （session-drag.ts:120 实锤值）；其他行 transition 实时让位。
 *
 * 边缘自动滚 = 自制版（用户定稿 2026-10-02："限制滑到最底部和最顶部结束"）：
 * dnd-kit 内建 autoScroll 在可溢出列表有补偿环 bug（#1042 类——拖拽 transform
 * 随滚动增长 scrollHeight → 无限滚），故 autoScroll={false} + 拖拽中指针近
 * 容器上/下缘 48px 时按帧 scrollBy ±step——scrollTop 被浏览器钳在真实边界，
 * **到顶/到底自动停**，反馈环在源头不存在。容器 = 带
 * data-sortable-scroll-container 标记的最近祖先（ThreadListItems）。
 */
import { useEffect, useRef } from 'react'
import type { useSensors } from '@dnd-kit/core'
import { closestCenter, DndContext, type DragEndEvent, type DragStartEvent } from '@dnd-kit/core'
import { arrayMove, SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import type * as React from 'react'

const EDGE_ZONE = 48
const EDGE_STEP = 8

/** 指针纵向位置 → 本帧滚动步长（0=不在边缘带；负=向上）。纯函数可单测。 */
export function edgeScrollStep(
  pointerY: number,
  rect: { top: number; bottom: number },
  edgeZone = EDGE_ZONE,
  step = EDGE_STEP,
): number {
  if (pointerY < rect.top + edgeZone) return -step
  if (pointerY > rect.bottom - edgeZone) return step
  return 0
}

// One self-contained, nesting-safe reorderable list. It owns its DndContext, so a
// drag only ever collides with THIS list's own items — drop it at any depth (repos,
// worktrees, sessions) and reordering "just works" without leaking into the lists
// around or inside it. Pair each item with useSortableBindings(id); the list reports
// the new id order and the caller persists it. This is the single generic primitive
// behind every reorderable surface in the sidebar.
export function ReorderableList({
  children,
  ids,
  onReorder,
  sensors,
}: {
  children: React.ReactNode
  ids: string[]
  onReorder: (ids: string[]) => void
  sensors?: ReturnType<typeof useSensors>
}) {
  // ── 自制边缘滚（autoScroll=false 的替代，用户定稿：到顶/到底自动停）──
  const scrollElRef = useRef<HTMLElement | null>(null)
  const pointerYRef = useRef(0)
  const rafRef = useRef(0)
  const draggingRef = useRef(false)

  const onPointerMoveTracked = (e: PointerEvent) => {
    pointerYRef.current = e.clientY
  }

  const edgeFrame = () => {
    const el = scrollElRef.current
    if (!el || !draggingRef.current) return
    const rect = el.getBoundingClientRect()
    const step = edgeScrollStep(pointerYRef.current, rect)
    if (step !== 0) el.scrollTop += step
    rafRef.current = requestAnimationFrame(edgeFrame)
  }

  const startEdgeScroll = (event: DragStartEvent) => {
    draggingRef.current = true
    const target = (event.activatorEvent as PointerEvent | undefined)?.target
    if (target instanceof Element) {
      scrollElRef.current = target.closest(
        '[data-sortable-scroll-container]',
      ) as HTMLElement | null
    }
    window.addEventListener('pointermove', onPointerMoveTracked)
    rafRef.current = requestAnimationFrame(edgeFrame)
  }

  const stopEdgeScroll = () => {
    draggingRef.current = false
    window.removeEventListener('pointermove', onPointerMoveTracked)
    cancelAnimationFrame(rafRef.current)
    rafRef.current = 0
    scrollElRef.current = null
  }

  const handleDragStart = (event: DragStartEvent) => {
    startEdgeScroll(event)
  }

  const handleDragEnd = ({ activatorEvent, active, over }: DragEndEvent) => {
    stopEdgeScroll()
    // dnd-kit only restores focus for keyboard drags; after a pointer drop the
    // browser leaves :focus on the grab handle, which keeps a focus-within
    // grabber/affordance reveal stuck "on". Drop that focus so the row returns
    // to its resting state once the pointer moves away.
    if (!(activatorEvent instanceof KeyboardEvent)) {
      ;(document.activeElement as HTMLElement | null)?.blur()
    }

    if (!over || active.id === over.id) {
      return
    }

    const from = ids.indexOf(String(active.id))
    const to = ids.indexOf(String(over.id))

    if (from >= 0 && to >= 0) {
      onReorder(arrayMove(ids, from, to))
    }
  }

  const handleDragCancel = () => {
    stopEdgeScroll()
  }

  return (
    <DndContext
      autoScroll={false}
      collisionDetection={closestCenter}
      onDragCancel={handleDragCancel}
      onDragEnd={handleDragEnd}
      onDragStart={handleDragStart}
      sensors={sensors}
    >
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        {children}
      </SortableContext>
    </DndContext>
  )
}

export function useSortableBindings(id: string) {
  const { attributes, isDragging, listeners, setNodeRef, transform, transition } = useSortable({ id })
  // The FULL handle (role/tabIndex + dnd-kit's keyboard and pointer
  // activators) belongs on the grabber only. Row shells forward just
  // `onPointerDown` from it: a keyboard activator on a container makes every
  // focused descendant control (the ⋯ menu button) arm a drag on Space, and
  // an armed KeyboardSensor then eats Space/Enter window-wide — the rename
  // dialog swallowed spaces (#83617).
  const dragHandleProps: React.HTMLAttributes<HTMLElement> = { ...attributes, ...listeners }

  return {
    dragging: isDragging,
    dragHandleProps,
    ref: setNodeRef,
    reorderable: true as const,
    style: {
      // Uniform vertical list: only ever translate on Y. Ignoring x and the
      // scaleX/scaleY that CSS.Transform.toString would emit keeps a dragged
      // group/row from drifting sideways or morphing its size mid-drag.
      transform: transform ? `translate3d(0px, ${transform.y}px, 0)` : undefined,
      transition: isDragging ? undefined : transition,
      willChange: isDragging ? 'transform' : undefined,
    },
  }
}

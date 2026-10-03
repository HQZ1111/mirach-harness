/**
 * 会话区虚拟列表（**hermes virtual-session-list.tsx 骨架照抄**，用户
 * 2026-10-03 "不要等，直接做"）：会话区行数 ≥ VIRTUALIZE_THRESHOLD（hermes
 * 同款 25）时启用 @tanstack/react-virtual——虚拟行 absolute + translateY
 * + measureElement 动态测量，divider 与会话行混排（hermes SidebarListRow
 * 同构）。
 *
 * **与 dnd 共存**（hermes 实锤注释）：虚拟行只**消费**外层 ReorderableList
 * 的 SortableContext——renderSessionRow 产生的行内部已 useSortable，虚拟
 * 容器自身不建 DndContext。未挂载（视口外）行不参与拖拽 = hermes 同语义。
 *
 * 挂载点：ThreadListItems（flex col 滚动容器）内 `flex-1 min-h-0` 吃剩余
 * 高度——外层滚动与内层虚拟滚动互不重叠（非虚拟分支平铺溢出滚动不变）。
 */
import { useVirtualizer } from '@tanstack/react-virtual'
import { useRef, type FC, type ReactNode } from 'react'

import type { SessionListRow } from './session-date-groups'

/** 虚拟化阈值（hermes sessions-section.tsx:50 VIRTUALIZE_THRESHOLD 同值）。 */
export const VIRTUALIZE_THRESHOLD = 25

/** 行高估算（harness 单行 = 内容 min 26 + py 4 + gap 1 ≈ 31；divider ≈ 30）。
 *  measureElement 首帧后接管真实高度。 */
const ROW_ESTIMATE_PX = 31
const DIVIDER_ESTIMATE_PX = 30
const OVERSCAN_ROWS = 12

export interface VirtualSessionListProps {
  /** divider + session 混合行序（session-date-groups 的 rows 原样）。 */
  rows: SessionListRow[]
  renderSessionRow: (id: string, key: string) => ReactNode
  renderDivider: (row: Extract<SessionListRow, { kind: "divider" }>) => ReactNode
}

export const VirtualSessionList: FC<VirtualSessionListProps> = ({
  rows,
  renderSessionRow,
  renderDivider,
}) => {
  const scrollerRef = useRef<HTMLDivElement | null>(null)

  const virtualizer = useVirtualizer({
    count: rows.length,
    estimateSize: (index) =>
      rows[index]?.kind === "divider" ? DIVIDER_ESTIMATE_PX : ROW_ESTIMATE_PX,
    getItemKey: (index) => {
      const row = rows[index]
      return row ? (row.kind === "divider" ? row.key : row.id) : index
    },
    getScrollElement: () => scrollerRef.current,
    // jsdom-friendly default；真实 rect 首次 observe 后接管（hermes 同款）
    initialRect: { height: 600, width: 240 },
    overscan: OVERSCAN_ROWS,
  })

  const virtualItems = virtualizer.getVirtualItems()
  const totalSize = virtualizer.getTotalSize()

  return (
    <div
      className="virtual-session-scroller relative min-h-0 flex-1 overflow-x-hidden overflow-y-auto"
      data-slot="aui_virtual_session_list"
      ref={scrollerRef}
    >
      <div className="relative" style={{ height: `${totalSize}px` }}>
        {virtualItems.map((virtualItem) => {
          const row = rows[virtualItem.index]
          if (!row) return null
          const itemStyle: React.CSSProperties = {
            left: 0,
            position: "absolute",
            top: 0,
            transform: `translateY(${virtualItem.start}px)`,
            width: "100%",
          }
          const measureRef = virtualizer.measureElement
          const dataIndex = { "data-index": virtualItem.index }
          return row.kind === "divider" ? (
            <div key={row.key} ref={measureRef} style={itemStyle} {...dataIndex}>
              {renderDivider(row)}
            </div>
          ) : (
            <div key={row.id} ref={measureRef} style={itemStyle} {...dataIndex}>
              {renderSessionRow(row.id, `r-${row.id}`)}
            </div>
          )
        })}
      </div>
    </div>
  )
}
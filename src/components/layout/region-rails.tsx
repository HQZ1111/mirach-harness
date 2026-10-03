/**
 * 栏级竖轨（v3 定稿：**整栏页签导航**）——竖轨形态 = 该栏外缘一条 20px
 * 原生轨 tabset（真占位、零重叠），工厂对它（空轨）渲染 RailNav：
 * 该栏**全部分栏的全部页签**的清单（跨分栏投影）。分栏保持原样可见
 * （Q2：只换标签轨道位置），横向条隐藏、内容向上充满。
 *
 * 行交互（用户 2026-09-26 四问拍板）：
 *  - 点行 = 激活该页签（它所在的分栏显示它，宽度限制不动）——页签常驻
 *    轨里不消失；
 *  - 行纵向拖（≤16px 离轨）= 轨内重排/搬家：同分栏行间移插入符，跨分
 *    栏行 = 搬进那个分栏（此前跨组无动作 = "有的标签无法拖拽"）；
 *  - 行横向拖出（>16px）= 交给拖拽引擎搬去别的大栏；
 *  - 行下挂关闭图标（一级窗格在家乡无；离家 = 回家）；
 *  - 顶部一个切横轨钮（Q4：在顶部）；底部「+」（堆叠进该栏一级分栏）。
 */

import { useEffect, useRef, useState } from 'react'
import { Model, TabNode, TabSetNode } from 'flexlayout-react'

import { ChevronUpIcon, CloseIcon } from '@/components/ui/codicons'

import { PANE_TYPES, instancesOfType, zoneConfigOf, type PaneType, type Region } from './pane-registry'
import { useLayoutStore } from '@/store/layout-store'

/** 「+」打开窗格：单一可开类型直接开（主栏=新会话）；多类型弹选择菜单
 * （右栏=检查/终端）。无可开类型渲染 null（+ 自动隐藏）。 */
export function PaneAddButton({ items, onCreate }: { items: PaneType[]; onCreate: (t: PaneType) => void }) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const hostRef = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!open) return
    const away = (e: PointerEvent) => {
      if (!hostRef.current?.contains(e.target as globalThis.Node)) setOpen(false)
    }
    window.addEventListener('pointerdown', away, true)
    return () => window.removeEventListener('pointerdown', away, true)
  }, [open])
  if (items.length === 0) return null
  const pick = (t: PaneType) => {
    setOpen(false)
    onCreate(t)
  }
  if (items.length === 1) {
    return (
      <button
        className="fl-min-btn"
        title={`打开${PANE_TYPES[items[0]].name}`}
        onClick={(e) => {
          e.stopPropagation()
          pick(items[0])
        }}
        onPointerDown={(e) => e.stopPropagation()}
        type="button"
      >
        +
      </button>
    )
  }
  return (
    <span ref={hostRef}>
      <button
        className="fl-min-btn"
        title="打开窗格"
        onClick={(e) => {
          e.stopPropagation()
          const r = e.currentTarget.getBoundingClientRect()
          setPos({ x: r.right, y: r.bottom + 4 })
          setOpen((v) => !v)
        }}
        onPointerDown={(e) => e.stopPropagation()}
        type="button"
      >
        +
      </button>
      {open && pos && (
        <div className="zone-add-menu" style={{ left: pos.x, top: pos.y }}>
          {items.map((t) => (
            <button
              key={t}
              className="zone-add-item"
              onClick={(e) => {
                e.stopPropagation()
                pick(t)
              }}
              type="button"
            >
              {PANE_TYPES[t].name}
            </button>
          ))}
        </div>
      )}
    </span>
  )
}

/** 该大栏可打开的窗格类型（单例未开才列；多实例永远列） */
export const openableTypesForRegion = (m: Model, region: Region): PaneType[] => {
  const out: PaneType[] = []
  for (const [t, def] of Object.entries(PANE_TYPES) as [PaneType, (typeof PANE_TYPES)[PaneType]][]) {
    if (def.region !== region) continue
    if (def.primary) continue
    if (!def.multi && instancesOfType(m, t).length > 0) continue
    out.push(t)
  }
  return out
}

interface RailRow {
  id: string
  name: string
  closable: boolean
  active: boolean
  zoneId: string
  index: number
}

/**
 * 竖轨导航（工厂对 20px 轨 tabset 的占位渲染）：切横轨钮 + 整栏页签行
 * （90° 竖排、行下关闭图标、分栏之间留缝）+「+」。行手势：纵向 = 同分
 * 栏重排（插入符预览），横向离轨 = 搬去别的大栏。
 */
export function RailNav({
  model,
  region,
  addItems,
  onToggle,
  onSelect,
  onClose,
  onCreate,
  onReorder,
  onDragOut,
}: {
  model: Model
  region: Region
  addItems: PaneType[]
  onToggle: () => void
  onSelect: (tabId: string) => void
  onClose: (tabId: string) => void
  onCreate: (t: PaneType) => void
  onReorder: (tabId: string, zoneId: string, index: number) => void
  onDragOut: (e: React.PointerEvent, tabId: string, name: string) => void
}) {
  // 选中高亮时效：轨道是空轨占位，纯选中变化（selectTab）不会重渲这个
  // 占位——订阅 layoutRev（onModelChange 每次都 bump）强制刷新 active 行
  useLayoutStore((s) => s.layoutRev)
  // 整栏页签清单（分栏文档序；轨自身与 border 里的页签不列）
  const rows: RailRow[] = []
  model.visitNodes((n) => {
    if (!(n instanceof TabNode)) return
    const set = n.getParent()
    if (!(set instanceof TabSetNode)) return
    const cfg = zoneConfigOf(set)
    if (!cfg || cfg.track || cfg.region !== region) return
    const tabs = set.getChildren().filter((c): c is TabNode => c instanceof TabNode)
    rows.push({
      id: n.getId(),
      name: n.getName(),
      closable: n.isEnableClose(),
      active: set.getSelectedNode()?.getId() === n.getId(),
      zoneId: set.getId(),
      index: tabs.findIndex((c) => c.getId() === n.getId()),
    })
  })

  const stripRef = useRef<HTMLDivElement>(null)
  const [insertY, setInsertY] = useState<number | null>(null)
  const [draggingId, setDraggingId] = useState<string | null>(null)

  const beginGesture = (e: React.PointerEvent, row: RailRow) => {
    if (e.button !== 0) return
    const strip = stripRef.current
    if (!strip) return
    // 指针捕获（drag-session 契约）：pointerup 落在窗外/丢失时仍收得到，
    // 且 move 的 buttons 守卫能识别"按键已松"（审查 C-P1-10——无 capture
    // 时悬停即更新 target，下一次 pointerup 会提交过期 reorder）。
    try {
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    } catch {
      /* 合成事件无有效 pointerId 时降级（真实指针必成功） */
    }
    const srect = strip.getBoundingClientRect()
    const startX = e.clientX
    const startY = e.clientY
    const rects = rows.map((r) => {
      const el = strip.querySelector(`[data-rail-row="${r.id}"]`) as HTMLElement | null
      const rr = el?.getBoundingClientRect()
      return { row: r, top: rr?.top ?? 0, bottom: rr?.bottom ?? 0, mid: rr ? rr.top + rr.height / 2 : 0 }
    })
    let mode: 'idle' | 'reorder' = 'idle'
    let target = -1
    let targetZone = row.zoneId
    let insertTop = 0
    let cleanupRef: (() => void) | null = null
    // rAF 合帧（引擎"one hit-test per frame"契约）：pointermove 只存最新
    // 坐标，帧内跑一次命中测试（审查 C-P1-10）
    let pendingEv: PointerEvent | null = null
    let rafId = 0
    const applyMove = (ev: PointerEvent) => {
      // 横向离轨 → 交给拖拽引擎搬去别的大栏（原事件续用，坐标由后续
      // pointermove 驱动）
      if (mode === 'idle' && Math.abs(ev.clientX - startX) > 16) {
        cleanupRef?.()
        onDragOut(e, row.id, row.name)
        return
      }
      if (mode === 'idle' && Math.abs(ev.clientY - startY) > 6) {
        mode = 'reorder'
        setDraggingId(row.id)
      }
      if (mode !== 'reorder') return
      // 命中指针下的行：同分栏 = 轨内重排；**跨分栏 = 搬进那个分栏**
      // （此前跨组无动作 = "有的竖栏标签无法拖拽"的感知来源）
      const hit = rects.find(
        (r) => r.row.id !== row.id && ev.clientY >= r.top && ev.clientY <= r.bottom,
      )
      if (!hit) {
        target = -1
        setInsertY(null)
        return
      }
      const before = ev.clientY < hit.mid
      // moveNode 的目标序：同分栏先按"摘出被拖行"修正位移；跨分栏直接
      // 落在命中行前/后
      const sameZone = hit.row.zoneId === row.zoneId
      target = sameZone
        ? before
          ? hit.row.index > row.index
            ? hit.row.index - 1
            : hit.row.index
          : hit.row.index > row.index
            ? hit.row.index
            : hit.row.index + 1
        : before
          ? hit.row.index
          : hit.row.index + 1
      targetZone = hit.row.zoneId
      insertTop = (before ? hit.top : hit.bottom) - srect.top
      setInsertY(insertTop)
    }
    const move = (ev: PointerEvent) => {
      if (ev.buttons === 0) {
        // 按键已松（pointerup 丢失）——按结束处理
        finish()
        return
      }
      pendingEv = ev
      if (rafId) return
      rafId = requestAnimationFrame(() => {
        rafId = 0
        if (pendingEv) applyMove(pendingEv)
        pendingEv = null
      })
    }
    const finish = () => {
      cleanupRef?.()
    }
    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        e.stopPropagation()
        target = -1
        finish()
      }
    }
    const cleanup = () => {
      window.removeEventListener('pointermove', move, true)
      window.removeEventListener('pointerup', finish, true)
      window.removeEventListener('pointercancel', finish, true)
      window.removeEventListener('keydown', onKeyDown, true)
      if (rafId) cancelAnimationFrame(rafId)
      rafId = 0
      pendingEv = null
      cleanupRef = null
      setInsertY(null)
      setDraggingId(null)
      if (mode === 'reorder' && target >= 0 && !(targetZone === row.zoneId && target === row.index)) {
        onReorder(row.id, targetZone, target)
      }
    }
    cleanupRef = cleanup
    window.addEventListener('pointermove', move, true)
    window.addEventListener('pointerup', finish, true)
    window.addEventListener('pointercancel', finish, true)
    window.addEventListener('keydown', onKeyDown, true)
  }

  return (
    <div className="zone-rail" ref={stripRef}>
      <button
        className="zone-rail-btn"
        title="切换为横向标签"
        onClick={onToggle}
        onPointerDown={(e) => e.stopPropagation()}
        type="button"
      >
        <ChevronUpIcon />
      </button>
      {(() => {
        // 按分栏分组：同分栏的页签连排成组，相邻组之间**一条**分割线
        // （线在 CSS 的相邻选择器上——此前组自带上下边框+组间 gap 线，
        // 两组之间渲染出三根线，用户实测打回）
        const groups: RailRow[][] = []
        for (const r of rows) {
          const last = groups[groups.length - 1]
          if (last && last[0].zoneId === r.zoneId) last.push(r)
          else groups.push([r])
        }
        return groups.map((g) => (
          <div className="zone-rail-group" key={g[0].zoneId}>
            {g.map((r) => (
              <div
                key={r.id}
                data-rail-row={r.id}
                className={`zone-rail-cell${r.active ? ' active' : ''}${draggingId === r.id ? ' dragging' : ''}`}
                title={r.name}
                onClick={() => onSelect(r.id)}
                onPointerDown={(e) => beginGesture(e, r)}
              >
                <span className="zone-rail-label">{r.name}</span>
                {r.closable && (
                  <button
                    className="zone-rail-btn zone-rail-close fl-close-btn"
                    title={(() => {
                      const pt = r.id.replace(/-\d+$/, '')
                      return PANE_TYPES[pt as PaneType]?.primary ? '回到所属大栏' : '关闭'
                    })()}
                    onClick={(e) => {
                      e.stopPropagation()
                      onClose(r.id)
                    }}
                    onPointerDown={(e) => e.stopPropagation()}
                    type="button"
                  >
                    <CloseIcon />
                  </button>
                )}
              </div>
            ))}
          </div>
        ))
      })()}
      {insertY !== null && <div className="zone-rail-insert" style={{ top: insertY }} />}
      <div className="zone-rail-add">
        <PaneAddButton items={addItems} onCreate={onCreate} />
      </div>
    </div>
  )
}

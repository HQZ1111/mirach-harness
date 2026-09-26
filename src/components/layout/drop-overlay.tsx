/**
 * FancyZones drop overlay —— 移植 hermes tree-group.tsx 的 ZoneDropOverlay +
 * StripDropCaret，flexlayout 适配版。
 *
 * 每个 zone 一张虚线 sheet：拖拽中所有可投放 zone 画安静的描边，主投放区
 * accent 点亮并随悬停的 center/edge 区位变形（VS Code dock preview——insets
 * 用 CSS transition 插值，目标在整区和半区之间滑行而不是跳变）。悬停在目标
 * 的页签条上时，插入符（2px 竖线）接管提示、该区 sheet 退位，两者不叠加。
 *
 * hermes 的 sheet 渲染在每个 zone 的 div 里（零坐标计算）；flexlayout 的
 * tabset DOM 不可注入兄弟层，所以这里渲染在 .flexlayout-host 里的一个绝对
 * 定位层，sheet 位置取 drag-session 的 engage 快照（viewport rect 减宿主
 * 偏移）。布局拖拽中不重组 → 快照全程有效。
 *
 * 隔离契约（照抄 hermes）：壳组件不订阅 $dropHint/$treeDragging——per-move
 * churn 只重渲本组件；sheet 的过渡只走 box+colors（transition-all 会把
 * backdrop-filter 也插值，一帧重糊半个 zone）。
 */

import type { CSSProperties } from 'react'

import type { DropPosition } from '@/store/layout-store'
import { useLayoutStore } from '@/store/layout-store'
import { getDragGeometry } from './drag-session'

/** Overlay entry fade. FancyZones ships 200ms（FADE_IN_DURATION_MILLIS，
 *  zones-engine.ts）；on a drag that starts under the cursor that ramp reads
 *  as lag, so the sheets snap in far faster — same softening, instant feel. */
const OVERLAY_FADE_MS = 80

/** Sheet inset from the zone edge (px). */
const REGION_PAD = 6

/** The sheet's box per drop position — longhand insets so CSS transitions can
 *  interpolate the px↔% change: the target GLIDES between the full zone and
 *  the hovered half instead of snapping (VS Code dock preview). */
const REGION: Record<DropPosition, CSSProperties> = {
  bottom: { bottom: REGION_PAD, left: REGION_PAD, right: REGION_PAD, top: '50%' },
  center: { bottom: REGION_PAD, left: REGION_PAD, right: REGION_PAD, top: REGION_PAD },
  left: { bottom: REGION_PAD, left: REGION_PAD, right: '50%', top: REGION_PAD },
  right: { bottom: REGION_PAD, left: '50%', right: REGION_PAD, top: REGION_PAD },
  top: { bottom: '50%', left: REGION_PAD, right: REGION_PAD, top: REGION_PAD },
}

export function DropOverlay() {
  const dragging = useLayoutStore(s => s.treeDragging)
  const hint = useLayoutStore(s => s.dropHint)
  const geom = getDragGeometry()

  if (dragging === null || !geom) {
    return null
  }

  const moving = new Set(geom.moving)

  // 条带内重排（reorder 模式）：只有插入符——不画 zone sheet（hermes 语义：
  // divider 说去哪，其余保持安静）。zone 模式才铺全量 sheet。
  const reorderOnly = geom.mode === 'reorder'

  return (
    <div aria-hidden className="fl-drop-overlay">
      {geom.zones.map((zone) => {
        const rect = zone.rect
        const box: CSSProperties = {
          left: rect.left - geom.hostOffset.x,
          top: rect.top - geom.hostOffset.y,
          width: rect.right - rect.left,
          height: rect.bottom - rect.top,
        }

        // 源 zone 若装的全是拖动块（拖走即空）——没有可堆叠的邻居，不画
        // （hermes：拖拽源 zone 只剩一个页签时不画）。
        const strip = geom.strips.find((s) => s.groupId === zone.id)
        if (strip && strip.slots.length > 0 && strip.slots.every((s) => moving.has(s.id))) {
          return null
        }

        const primary = hint?.groupId === zone.id

        // 悬停在目标的页签条上：插入符（StripDropCaret）接管——sheet 退位
        if (primary && hint?.stack !== undefined) {
          return <StripDropCaret key={zone.id} zoneRect={rect} strip={strip} hint={hint} />
        }

        if (reorderOnly) {
          return null
        }

        const active = hint?.groupIds?.includes(zone.id) ?? false
        const multi = (hint?.groupIds?.length ?? 0) > 1
        // Sub-positions only exist for a single-zone target (a Shift-span merges).
        const pos = primary && !multi ? (hint?.pos ?? 'center') : 'center'

        return (
          <div key={zone.id} className="fl-drop-zone-anchor" style={box}>
            <div
              className={`fl-drop-sheet${active ? ' fl-drop-sheet-active' : ''}`}
              style={{ ...REGION[pos], animation: `fl-drop-fade ${OVERLAY_FADE_MS}ms linear both` }}
            />
          </div>
        )
      })}
    </div>
  )
}

/** The insertion divider for a stack drop: a 2px vertical line at the slot the
 *  dragged tab will land in (before `stack.before`, or after the last tab).
 *  位置从 engage 快照取（布局拖拽中不变）；anchor 已定位在 zone 盒上，caret
 *  取 zone 内相对坐标。 */
function StripDropCaret({
  zoneRect,
  strip,
  hint,
}: {
  zoneRect: { left: number; top: number }
  strip:
    | {
        rect: import('./zones-engine').ZoneRect
        slots: { id: string; left: number; right: number; top: number; height: number }[]
      }
    | undefined
  hint: { stack?: { before: null | string } }
}) {
  if (!strip || hint.stack === undefined) {
    return null
  }

  // Slot x: the before-tab's left edge, or the last tab's right edge.
  const target = hint.stack.before ? strip.slots.find((s) => s.id === hint.stack!.before) : strip.slots.at(-1)

  if (!target) {
    return null
  }

  const x = hint.stack.before ? target.left - zoneRect.left : target.right - zoneRect.left
  const top = target.top - zoneRect.top + target.height * 0.2

  return (
    <span
      aria-hidden
      className="fl-drop-caret"
      style={{ height: target.height * 0.6, left: x, top }}
    />
  )
}

/**
 * 编辑模式画布面 —— hermes tree-group.tsx 的 edit veil：
 * 编辑模式开启时每个 zone 的 body 变成拖拽把手——虚线 accent 描边 + 2px
 * 模糊 scrim + 居中的 gripper chip（显示活动页签名）；按住 body 即拖走该
 * zone 的活动页签（zone 模式）。页签条不在遮罩内，保持直接可交互（拖页签、
 * 右键菜单照旧）。
 *
 * hermes 的 veil 渲染在 zone div 里（starts below the header）；flexlayout
 * 的 tabset DOM 不可注入，所以在宿主层绝对定位（rect 现量，rAF 循环保持
 * 跟手——编辑模式不是热路径）。z 序：低于投放 overlay（60），盖住窗格内容。
 */

import { useEffect, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { Model, TabNode, TabSetNode } from 'flexlayout-react'

import { useLayoutStore } from '@/store/layout-store'
import { TAB_STRIP_H } from './layout-presets'

export function EditVeils({
  model,
  onVeilPointerDown,
}: {
  model: Model
  /** 按住 veil = 拖走该 zone 的活动页签（hermes startPaneDrag(activeId, …)）。 */
  onVeilPointerDown: (e: ReactPointerEvent<HTMLElement>, activeId: string, title: string) => void
}) {
  const editMode = useLayoutStore(s => s.editMode)
  const dragging = useLayoutStore(s => s.treeDragging)
  useLayoutStore(s => s.layoutRev) // 模型变更（拖拽落位等）后 rect 重读
  // rAF 循环：编辑模式期间每帧重读 zone rect——比订阅 resize/rev 更省心，
  // 也盖住 flexlayout 自身的布局动画。
  const [, tick] = useState(0)
  useEffect(() => {
    if (!editMode) return
    let raf = 0
    const loop = () => {
      tick((n) => (n + 1) % 100000)
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [editMode])

  if (!editMode || dragging !== null) return null

  const host = document.querySelector('.flexlayout-host')?.getBoundingClientRect()
  if (!host) return null

  const zones: { key: string; left: number; top: number; width: number; height: number; activeId: string; title: string }[] = []
  model.visitNodes((node) => {
    if (!(node instanceof TabSetNode)) return
    const el = document.querySelector(`.flexlayout__tabset[data-layout-path="${node.getPath()}"]`)
    if (!el) return
    const r = el.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) return
    const strip = el.querySelector('.flexlayout__tabset_tabbar_outer') as HTMLElement | null
    const stripH = strip?.offsetHeight || TAB_STRIP_H
    const active = node.getSelectedNode()
    zones.push({
      key: node.getId(),
      left: r.left - host.left,
      top: r.top - host.top + stripH,
      width: r.width,
      height: Math.max(0, r.height - stripH),
      activeId: active instanceof TabNode ? active.getId() : node.getChildren()[0]?.getId() ?? '',
      title: active?.getName() ?? '',
    })
  })

  return (
    <div aria-hidden={false} className="fl-edit-veils">
      {zones.map((z) => (
        <div
          className="fl-edit-veil"
          key={z.key}
          onPointerDown={(e) => {
            if (e.button !== 0) return
            onVeilPointerDown(e, z.activeId, z.title)
          }}
          style={{ left: z.left, top: z.top, width: z.width, height: z.height }}
        >
          <span className="fl-edit-chip">
            <svg aria-hidden fill="currentColor" height="11" viewBox="0 0 16 16" width="11">
              {/* codicon "gripper" 的两列圆点 */}
              {[3, 8, 13].map((y) => (
                <g key={y}>
                  <circle cx="5" cy={y + 0.5} r="1.3" />
                  <circle cx="11" cy={y + 0.5} r="1.3" />
                </g>
              ))}
            </svg>
            <span>{z.title}</span>
          </span>
        </div>
      ))}
    </div>
  )
}

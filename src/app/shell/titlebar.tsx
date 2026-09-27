/**
 * 自绘标题栏（Tauri decorations:false）：整条拖拽区，按钮不放该属性保持
 * 可点。从 flex-layout.tsx 拆出的纯表现层——布局处理器（toggleSide/mirror/
 * fullReset）由引擎（FlexLayoutShell）以 props 注入。
 * 工具面照抄 hermes titlebar-controls.tsx：左栏/右栏 positional toggles +
 * flip 互换 + LayoutGlyph 布局编辑器。窗格的显隐/新建走各 zone 的「+」
 * （v2.1：标题栏窗格菜单移除）。
 */

import { ArrowLeftRight, LayoutTemplate, PanelLeft, PanelRight } from 'lucide-react'

import { useLayoutStore, toggleEditMode } from '@/store/layout-store'
import { WindowControls } from './window-controls'

export function Titlebar({
  sideCollapsed,
  onToggleSide,
  onMirror,
  onFullReset,
}: {
  sideCollapsed: { left: boolean; right: boolean }
  onToggleSide: (side: 'left' | 'right') => void
  onMirror: () => void
  onFullReset: () => void
}) {
  const editMode = useLayoutStore(s => s.editMode)
  return (
    <div className="app-titlebar">
      {/* 顶部拖拽带（tb-drag-strip）已由 flex-layout 的 titlebar-drag-band
          （0-60px）替代：拖拽面积更大且不盖标题栏按钮。按钮 z 在拖拽带
          之上，保证可点。 */}
      {/* hermes 标题栏工具面（titlebar-controls.tsx）：左栏/右栏 positional
          toggles + flip 互换（箭头交换）。收起=整侧折进轨道，展开=收编回位。 */}
      <button
        className={`tb-tool${sideCollapsed.left ? ' tb-tool-off' : ''}`}
        title={sideCollapsed.left ? '显示左栏' : '隐藏左栏'}
        onClick={() => onToggleSide('left')}
        type="button"
      >
        <PanelLeft size={15} strokeWidth={1.8} />
      </button>
      {/* hermes：标题栏 flip toggle（⌘\ mirrorLayoutTree）——左右互换 */}
      <button className="tb-tool" onClick={onMirror} title="左右互换 (Ctrl+\)" type="button">
        <ArrowLeftRight size={14} strokeWidth={1.8} />
      </button>
      <button
        className={`tb-tool${sideCollapsed.right ? ' tb-tool-off' : ''}`}
        title={sideCollapsed.right ? '显示右栏' : '隐藏右栏'}
        onClick={() => onToggleSide('right')}
        type="button"
      >
        <PanelRight size={15} strokeWidth={1.8} />
      </button>
      <span className="tb-divider" />
      {/* hermes：LayoutGlyph 布局编辑器——点击开编辑模式（画布 veil +
          Layouts 卡片），mod+点击 = 全重置 */}
      <button
        className="tb-tool"
        title="布局编辑器 (Ctrl+Shift+\) — Ctrl+点击恢复默认布局"
        onClick={(e) => {
          if (e.ctrlKey || e.metaKey) {
            onFullReset()
            return
          }
          toggleEditMode()
        }}
        type="button"
      >
        <LayoutTemplate size={15} strokeWidth={1.8} />
      </button>
      <WindowControls />
    </div>
  )
}

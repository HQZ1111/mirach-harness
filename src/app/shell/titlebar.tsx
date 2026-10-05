/**
 * 自绘标题栏（Tauri decorations:false）：整条 pointer-events:none 浮片，
 * WindowControls 子元素 auto，其余穿透给布局层（flex-layout 的 window
 * 捕获段把顶带空白变拖窗区）。v6.0 瘦身：侧栏开关/互换/布局编辑器钮/
 * 设置齿轮全部裁掉——布局动词入应用右键菜单（app-context-menu.tsx），
 * 设置入口 = 菜单「设置」行。
 */

import { WindowControls } from './window-controls'

export function Titlebar() {
  return (
    <div className="app-titlebar">
      <WindowControls />
    </div>
  )
}

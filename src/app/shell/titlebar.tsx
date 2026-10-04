/**
 * 自绘标题栏（Tauri decorations:false）：整条拖拽区，按钮不放该属性保持
 * 可点。v5.0 瘦身：侧栏开关/互换/布局编辑器钮随旧布局系统删除——只剩
 * 窗口控制圆点 + 设置齿轮。齿轮钮开/关全局设置浮层（§7-7；
 * SettingsOverlay portal 到 body——标题栏是 z-50 stacking context，
 * 浮层不能渲染在本组件树内）。
 */

import { useState } from 'react'
import { Settings } from 'lucide-react'

import { SettingsOverlay } from '@/app/overlays/settings-overlay'
import { WindowControls } from './window-controls'

export function Titlebar() {
  // 设置浮层开/关（本地 state 即可——hermes 无此物，§7-7 设置页入口）
  const [settingsOpen, setSettingsOpen] = useState(false)
  return (
    <div className="app-titlebar">
      {/* 顶部拖拽带已由 flex-layout 的 titlebar-drag-band 替代；按钮 z 在
          拖拽带之上，保证可点。 */}
      <WindowControls />
      {/* 设置（§7-7 设置页入口）：齿轮钮，点击开/关设置浮层（本地 state） */}
      <button
        className="tb-tool"
        title="设置"
        onClick={() => setSettingsOpen((v) => !v)}
        type="button"
      >
        <Settings size={15} strokeWidth={1.8} />
      </button>
      {/* portal 到 body 的设置浮层（.set-overlay z 130）——渲染在 titlebar
          组件树内会被 z-50 stacking context 压到 veil 之下 */}
      {settingsOpen && <SettingsOverlay onClose={() => setSettingsOpen(false)} />}
    </div>
  )
}

/**
 * 无边框窗的窗口控制圆点（用户定稿 2026-10-02：四钮改 20px 圆点——
 * 关闭 DC6E6E / 最大化 CBDC6E / 最小化 6E97DC / 隐藏右栏 6EDCA2；
 * 上缘 25、右缘 50 避开圆角、间距 20——全部令牌见 tokens.css 的
 * --win-dot-* 块）。最大化态跟随窗口：isMaximized + onResized。
 * 纯浏览器直开（inTauri=false）渲染 null。
 */

import { useEffect, useState } from 'react'

import { appWindow, inTauri } from '@/lib/tauri-window'

export function WindowControls({
  onToggleSidebar,
  sidebarCollapsed,
}: {
  onToggleSidebar?: () => void
  sidebarCollapsed?: boolean
}) {
  const [maximized, setMaximized] = useState(false)
  useEffect(() => {
    const win = appWindow
    if (!win) return
    let disposed = false
    let unlisten: (() => void) | undefined
    void win.isMaximized().then((v) => {
      if (!disposed) setMaximized(v)
    })
    void win
      .onResized(() => {
        void win.isMaximized().then((v) => {
          if (!disposed) setMaximized(v)
        })
      })
      .then((fn) => {
        if (disposed) fn()
        else unlisten = fn
      })
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])
  if (!inTauri) return null
  return (
    <div className="win-dot-controls">
      {/* 侧栏圆点：窗口圆点组内最前（最小化左边，同排同间距——用户定稿） */}
      {onToggleSidebar && (
        <button
          aria-label={sidebarCollapsed ? '打开右栏' : '隐藏右栏'}
          className="win-dot"
          data-dot-role="sidebar"
          onClick={onToggleSidebar}
          title={sidebarCollapsed ? '打开右栏' : '隐藏右栏'}
          type="button"
        />
      )}
      <button
        aria-label="最小化"
        className="win-dot"
        data-dot-role="minimize"
        onClick={() => void appWindow?.minimize()}
        title="最小化"
        type="button"
      />
      <button
        aria-label={maximized ? '向下还原' : '最大化'}
        className="win-dot"
        data-dot-role="maximize"
        onClick={() => void appWindow?.toggleMaximize()}
        title={maximized ? '向下还原' : '最大化'}
        type="button"
      />
      <button
        aria-label="关闭"
        className="win-dot"
        data-dot-role="close"
        onClick={() => void appWindow?.close()}
        title="关闭"
        type="button"
      />
    </div>
  )
}

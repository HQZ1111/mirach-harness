/**
 * 无边框窗的窗口控制钮（Windows 形制：最小化/最大化还原/关闭）。
 * 从 flex-layout.tsx 拆出（hermes 无此物——无边框窗标配）。
 * 最大化态跟随窗口：isMaximated + onResized 在无边框窗上同样触发。
 * 纯浏览器直开（inTauri=false）渲染 null。
 */

import { useEffect, useState } from 'react'

import { appWindow, inTauri } from '@/lib/tauri-window'

export function WindowControls() {
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
    <>
      <span className="tb-divider" />
      <div className="win-controls">
        <button
          aria-label="最小化"
          className="win-btn"
          onClick={() => void appWindow?.minimize()}
          title="最小化"
          type="button"
        >
          <svg aria-hidden fill="none" height="12" stroke="currentColor" strokeWidth="1.2" viewBox="0 0 12 12" width="12">
            <path d="M1.5 6h9" />
          </svg>
        </button>
        <button
          aria-label={maximized ? '向下还原' : '最大化'}
          className="win-btn"
          onClick={() => void appWindow?.toggleMaximize()}
          title={maximized ? '向下还原' : '最大化'}
          type="button"
        >
          {maximized ? (
            <svg aria-hidden fill="none" height="12" stroke="currentColor" strokeWidth="1.2" viewBox="0 0 12 12" width="12">
              <rect height="7" width="7" x="1.5" y="3.5" />
              <path d="M3.5 3.5v-2h7v7h-2" />
            </svg>
          ) : (
            <svg aria-hidden fill="none" height="12" stroke="currentColor" strokeWidth="1.2" viewBox="0 0 12 12" width="12">
              <rect height="8" width="8" x="2" y="2" />
            </svg>
          )}
        </button>
        <button
          aria-label="关闭"
          className="win-btn win-btn-close"
          onClick={() => void appWindow?.close()}
          title="关闭"
          type="button"
        >
          <svg aria-hidden fill="none" height="12" stroke="currentColor" strokeWidth="1.2" viewBox="0 0 12 12" width="12">
            <path d="M2 2l8 8M10 2l-8 8" />
          </svg>
        </button>
      </div>
    </>
  )
}

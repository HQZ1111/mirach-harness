/**
 * 无边框窗的窗口控制圆点（用户定稿 2026-10-02：三钮圆点——
 * 关闭 DC6E6E / 最大化 CBDC6E6 / 最小化 6E97DC；
 * 上缘 25、右缘 50 避开圆角、间距 20——全部令牌见 tokens.css 的
 * --win-dot-* 块）。最大化态跟随窗口：isMaximized + onResized。
 * 纯浏览器直开（inTauri=false）渲染 null。
 * v5.0：第四颗"隐藏右栏"圆点随旧布局系统删除（右栏=面板栏，恒在）。
 * 2026-10-14：title 属性换 beUI Tooltip（悬停浮现动画化提示，
 * provider 缺省 delay 120ms / skip 300ms 同 beui.dev 原值）。
 */

import { useEffect, useState } from 'react'

import { Tooltip } from '@/components/motion/tooltip'
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
  // 最大化态同步到 DOM：CSS 圆角清零（base.css html[data-maximized='true']）
  // 与 Rust 端 SetWindowRgn 区域清空（main.rs）同一状态源，两侧同步开/关。
  useEffect(() => {
    document.documentElement.dataset.maximized = maximized ? 'true' : 'false'
  }, [maximized])
  if (!inTauri) return null
  return (
    <div className="win-dot-controls">
      <Tooltip content="最小化" side="bottom" delay={300}>
        <button
          aria-label="最小化"
          className="win-dot"
          data-dot-role="minimize"
          onClick={() => void appWindow?.minimize()}
          type="button"
        />
      </Tooltip>
      <Tooltip content={maximized ? '向下还原' : '最大化'} side="bottom" delay={300}>
        <button
          aria-label={maximized ? '向下还原' : '最大化'}
          className="win-dot"
          data-dot-role="maximize"
          onClick={() => void appWindow?.toggleMaximize()}
          type="button"
        />
      </Tooltip>
      <Tooltip content="关闭" side="bottom" delay={300}>
        <button
          aria-label="关闭"
          className="win-dot"
          data-dot-role="close"
          onClick={() => void appWindow?.close()}
          type="button"
        />
      </Tooltip>
    </div>
  )
}

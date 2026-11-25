/**
 * 最大化态 → DOM（`html[data-maximized]`）。
 *
 * 为什么需要单独一个 hook：CSS 是圆角与投影的**唯一**绘制方，它靠这个属性
 * 清零（base.css 的 `html[data-maximized='true']`：圆角、`--shell-shadow-margin`、
 * 投影全归零）。**每个顶层窗口都必须有人写这个属性**——不写 = 最大化后仍留
 * 40px 透明边距 + 35px 圆角，贴屏边看着像"窗口缩了一圈"。
 *
 * 2026-10-24：此前这段只在 `WindowControls`（主窗）里，设置窗没有控件圆点
 * 所以从来没人写 → 设置窗最大化时边距/圆角不消失。抽出来给两个窗口共用。
 */

import { useEffect, useState } from 'react'
import { appWindow } from '@/lib/tauri-window'

/** 返回当前是否最大化，并把状态同步到 `html[data-maximized]`。 */
export function useMaximized(): boolean {
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

  useEffect(() => {
    document.documentElement.dataset.maximized = maximized ? 'true' : 'false'
  }, [maximized])

  return maximized
}

/** 只**读**最大化态（`html[data-maximized]`），MutationObserver 跟随。
 *
 *  与 `useMaximized` 的分工：那个是**唯一写入方**（每个顶层窗口必须有一个人
 *  写属性，见模块头）；本 hook 给"只在最大化时生效"的消费方用（对话宽度手柄
 *  2026-11-25）——消费方再注册一份 Tauri 监听只会重复劳动，读属性即可。
 *  属性未落（首个 resolve 前）按未最大化答。 */
export function useHtmlMaximized(): boolean {
  const [maximized, setMaximized] = useState(
    () => typeof document !== 'undefined' && document.documentElement.dataset.maximized === 'true',
  )

  useEffect(() => {
    const el = document.documentElement
    const sync = () => setMaximized(el.dataset.maximized === 'true')
    sync()
    const observer = new MutationObserver(sync)
    observer.observe(el, { attributes: true, attributeFilter: ['data-maximized'] })
    return () => observer.disconnect()
  }, [])

  return maximized
}

import { useCallback, useEffect, useRef, useState } from 'react'
import { useStore } from 'zustand'

import { appearanceStore } from '@/lib/appearance-prefs'

/**
 * 外观 →「聊天背景」的图片层（2026-11-24 用户纠正）。
 *
 * - 图只在 #root 后铺一张（不是每栏各复制一张），每栏容器通过
 *   `--surface`/`--surface-shell` 的透明度档位透出它；栏基础色仍由主题
 *   令牌决定（`applyBackdropSurface` 用 color-mix 保留实色比例）。
 * - 自定义图片是绝对路径：走 Rust `fs_read_data_url` 读成 data URL（不把
 *   大图塞进 localStorage，只存路径）。
 * - `Backdrop` 保留为兼容导出（旧调用点），行为同全局图但局部定位。
 */
function useBackdropSrc(): string {
  const image = useStore(appearanceStore, (s) => s.backdropImage)
  const [src, setSrc] = useState(image)

  useEffect(() => {
    let cancelled = false
    if (!image || image.startsWith('/') || image.startsWith('data:') || image.startsWith('http')) {
      setSrc(image)
      return () => {
        cancelled = true
      }
    }
    void (async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        const dataUrl = await invoke<string>('fs_read_data_url', { path: image })
        if (!cancelled) setSrc(dataUrl)
      } catch (e) {
        console.error('[appearance] 读取自定义背景图失败', e)
        if (!cancelled) setSrc('')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [image])

  return src
}

export function GlobalBackdrop() {
  const on = useStore(appearanceStore, (s) => s.backdrop)
  const src = useBackdropSrc()
  const [ready, setReady] = useState(false)
  const imgRef = useRef<HTMLImageElement | null>(null)
  const markReady = useCallback(() => setReady(true), [])

  // 只有图片真的解码出第一帧才把壳层变透明。自定义路径读失败/图片损坏时
  // GlobalBackdrop 不挂 ready 属性，外壳保持主题实色——不把窗口透成桌面。
  useEffect(() => {
    setReady(false)
  }, [src])

  // 缓存图可能在 React 挂 ref 之前就 complete，onLoad 不再派发；这里补一次
  // 同步检查，否则重启后背景永远不显示（用户实报"展示失败"）。
  useEffect(() => {
    const img = imgRef.current
    if (on && src && img?.complete && img.naturalWidth > 0) setReady(true)
  }, [on, src])

  useEffect(() => {
    if (!on || !ready) return
    const root = document.documentElement
    root.setAttribute('data-mirach-backdrop-ready', '')
    return () => root.removeAttribute('data-mirach-backdrop-ready')
  }, [on, ready])

  if (!on || !src) return null

  return (
    <div aria-hidden className="mirach-global-backdrop">
      <img
        alt=""
        className="h-full w-full object-cover"
        fetchPriority="low"
        onError={() => console.error('[appearance] 背景图片加载失败', src)}
        onLoad={markReady}
        ref={imgRef}
        src={src}
      />
    </div>
  )
}

/** 旧对话栏内背景（保留导出；全局层已经覆盖所有栏）。 */
export function Backdrop() {
  const on = useStore(appearanceStore, (s) => s.backdrop)
  const src = useBackdropSrc()

  if (!on || !src) return null

  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 z-2 opacity-[0.025] mix-blend-difference">
      <img
        alt=""
        className="h-[160dvh] w-auto min-w-dvw object-cover object-left-top [filter:invert(var(--backdrop-invert-mul,1))]"
        fetchPriority="low"
        src={src}
      />
    </div>
  )
}

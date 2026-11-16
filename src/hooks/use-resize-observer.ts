/** 尺寸观察 hook（hermes `hooks/use-resize-observer.ts` 的宿主对偶）。 */
import { useEffect, useState, type RefObject } from 'react'

export function useResizeObserver<T extends HTMLElement>(ref: RefObject<T | null>): { width: number; height: number } {
  const [size, setSize] = useState({ width: 0, height: 0 })
  useEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect
      if (box) setSize({ width: box.width, height: box.height })
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [ref])
  return size
}

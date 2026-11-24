import { createElement, type ReactNode } from 'react'

import { ContribBoundary } from './contrib-boundary'
import { useContributions } from './use-contributions'

/**
 * 上游 `contrib/react/slot.tsx` 的宿主对偶（镜像同名文件 import 的是上游
 * 应用路径 `@/components/error-boundary`，宿主没有那棵组件树，不能直接用）。
 * 语义不变：按区渲染登记项，每项自带错误边界。
 *
 * 已知差异（宿主既有约束，非本次引入）：上游边界对 `chip` 失败画行内错误
 * 徽标；宿主 shim 边界隐藏该贡献并 console.error（错误可见，不造假 UI）。
 * 画徽标依赖的上游 ErrorBoundary/ErrorState 组件链在宿主不完整。
 */

export interface SlotProps {
  /** Area id whose contributions render inline, in order. */
  area: string
}

interface ContribRenderProps {
  render: () => ReactNode
}

/** Mount a contribution callback as a component so its hooks and errors belong
 *  to the contribution, not to whichever host surface happened to call it. */
function ContribRender({ render }: ContribRenderProps) {
  return createElement(render)
}

/** Renders a bar area: ordered inline items `[...core, ...plugin]`. */
export function Slot({ area }: SlotProps) {
  const items = useContributions(area)

  if (items.length === 0) {
    return null
  }

  return (
    <>
      {items.map((c) => (
        <ContribBoundary id={c.id} key={`${c.source ?? 'core'}:${c.id}`}>
          {c.render && <ContribRender render={c.render} />}
        </ContribBoundary>
      ))}
    </>
  )
}

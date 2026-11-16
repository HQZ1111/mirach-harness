/**
 * 贡献渲染的宿主边界（上游 `@/contrib/react/boundary` 的对偶）。
 *
 * 一个插件贡献的渲染抛错不得炸掉整个宿主界面（上游 ContribBoundary 同
 * 语义）：边界内失败 → 该贡献不渲染 + console.error 可见（不静默）。
 */

import { Component, type ReactNode } from 'react'

interface BoundaryProps {
  children: ReactNode
  id?: string
}

interface BoundaryState {
  failed: boolean
}

export class ContribBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { failed: false }

  static getDerivedStateFromError(): BoundaryState {
    return { failed: true }
  }

  componentDidCatch(error: unknown): void {
    console.error(`[contrib] ${this.props.id ?? '(unknown)'} 渲染失败——该贡献已隐藏`, error)
  }

  render(): ReactNode {
    return this.state.failed ? null : this.props.children
  }
}

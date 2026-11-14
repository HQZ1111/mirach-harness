/**
 * @/contrib/react/boundary shim - the contribution blast wall.
 *
 * ContribRender mounts a contribution render callback as a component (behaviour
 * kept verbatim: its hooks and errors belong to the contribution, not the host
 * surface). The boundary itself is not carried over: it depends on upstream's
 * app-wide ErrorBoundary + ErrorState pair, and with no renderer plugin runtime
 * there is nothing to contain. If a runtime lands, port the boundary with it.
 */

import { createElement, type ReactNode } from 'react'

interface ContribRenderProps {
  render: () => ReactNode
}

export function ContribRender({ render }: ContribRenderProps) {
  return createElement(render)
}

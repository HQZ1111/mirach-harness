/**
 * hermes 桌面端 `components/ui/row-button.tsx` 的逐字移植。
 *
 * 整行/整区点击目标，渲染成真 `<button>`：内建 `type="button"` 与稳定的
 * `data-slot`，**不带任何样式**（调用方保留自己的布局类，视觉零变化）。
 * 行/区目标用它；普通紧凑动作仍用 `Button`。
 */

import * as React from 'react'

function RowButton({ className, type = 'button', ...props }: React.ComponentProps<'button'>) {
  return <button className={className} data-slot='row-button' type={type} {...props} />
}

export { RowButton }

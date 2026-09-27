/**
 * flexlayout-react 0.11.1 行节点约束聚合缺陷的运行时修正（polyfill）。
 *
 * 缺陷（上游 RowNode.calcMinMaxSize）：行节点的沿轴 max 聚合从
 * DefaultMax(99999) **起算**再累加子项——HORZ 行 maxW = 99999 + Σ(子项
 * maxW)。后果：任何行节点（嵌套列）都没有有效宽度/高度上限，内联
 * max-width 形同虚设（实测 100840px = 99999+841）：
 *   1. 拖拽 calculateSplit 对被拖子项的自钳（sizes[index] = smax）失效，
 *      嵌套组合（如上两栏下一栏）拖宽度能拖过聚合上限；
 *   2. 松手后权重提交，我方串行通道按正确聚合钳回——用户看到"能多拉、
 *      松手弹回"（2026-09-27 实测）。
 *
 * 修正：按 flexlayout 自己的语义重写——沿轴（HORZ 宽/VERT 高）= Σ 子项、
 * 跨轴 = MAX(min)/MIN(max)、首项直赋（不再用 DefaultMax 当 ∞ 基座），
 * 末尾 max ≥ min 收口。修正后行节点获得真实聚合上限：
 *   - DOM 内联 max-width 生效 → flexbox 层硬钳；
 *   - getSplitterBounds/calculateSplit 原生把拖拽钳在上限内；
 *   - 我方 clampRowWeights 退化为保险网（正常拖拽不再触发）。
 *
 * 升级 flexlayout 后先核对上游是否已修（搜 RowNode.calcMinMaxSize 的
 * `maxHeight = DefaultMax`），已修则删除本文件。
 */

import { Orientation, RowNode } from 'flexlayout-react'

interface NodeLike {
  calcMinMaxSize(): void
  getMinWidth(): number
  getMaxWidth(): number
  getMinHeight(): number
  getMaxHeight(): number
}

interface RowLike {
  children: NodeLike[]
  model: { getSplitterSize(): number }
  getOrientation(): Orientation
  minHeight: number
  minWidth: number
  maxHeight: number
  maxWidth: number
}

function fixedCalcMinMaxSize(this: RowLike): void {
  this.minHeight = 1
  this.minWidth = 1
  this.maxHeight = 0
  this.maxWidth = 0
  let first = true
  const ss = this.model.getSplitterSize()
  for (const child of this.children) {
    child.calcMinMaxSize()
    const cMaxH = Math.max(child.getMinHeight(), child.getMaxHeight())
    const cMaxW = Math.max(child.getMinWidth(), child.getMaxWidth())
    if (this.getOrientation() === Orientation.VERT) {
      // 沿轴（高）= Σ；跨轴（宽）= MAX(min)/MIN(max)
      this.minHeight += child.getMinHeight()
      this.maxHeight += cMaxH
      if (!first) {
        this.minHeight += ss
        this.maxHeight += ss
      }
      this.minWidth = first ? child.getMinWidth() : Math.max(this.minWidth, child.getMinWidth())
      this.maxWidth = first ? cMaxW : Math.min(this.maxWidth, cMaxW)
    } else {
      // 沿轴（宽）= Σ；跨轴（高）= MAX(min)/MIN(max)
      this.minWidth += child.getMinWidth()
      this.maxWidth += cMaxW
      if (!first) {
        this.minWidth += ss
        this.maxWidth += ss
      }
      this.minHeight = first ? child.getMinHeight() : Math.max(this.minHeight, child.getMinHeight())
      this.maxHeight = first ? cMaxH : Math.min(this.maxHeight, cMaxH)
    }
    first = false
  }
  this.maxWidth = Math.max(this.maxWidth, this.minWidth)
  this.maxHeight = Math.max(this.maxHeight, this.minHeight)
}

export function patchRowCalcMinMaxSize(): void {
  ;(RowNode.prototype as unknown as { calcMinMaxSize: (this: RowLike) => void }).calcMinMaxSize =
    fixedCalcMinMaxSize
}

patchRowCalcMinMaxSize()

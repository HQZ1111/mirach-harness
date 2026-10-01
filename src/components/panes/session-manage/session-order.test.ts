/**
 * session-order 单测：置顶/手动顺序纯函数（hermes sidebar/order.ts +
 * store/layout pinSession 语义适配版）。覆盖：置顶清理/切换（追加尾部）、
 * 手动顺序折回（mergeFreshByPosition：新会话不沉底、旧页不跳顶）、移动落点、
 * 序号表往返、可见序拼回全量序（mergeVisibleReorder）、拖拽落点提交
 * （commitRecentMove——折叠桶藏行保位）。
 */
import { describe, expect, it } from 'vitest'

import {
  commitRecentMove,
  mergeVisibleReorder,
  moveBefore,
  orderMapFromIds,
  pruneOrder,
  prunePins,
  reconcileOrder,
  recencyCompare,
  togglePinId,
  type SessionRowMeta,
} from './session-order'

const row = (id: string, lastActiveMs: number): SessionRowMeta => ({ id, lastActiveMs })

/** 按时间递减的四个会话：a 最新，d 最旧 */
const fourRows = (): SessionRowMeta[] => [
  row('a', 4000),
  row('b', 3000),
  row('c', 2000),
  row('d', 1000),
]

describe('recencyCompare', () => {
  it('活跃降序，同毫秒按 id 稳定', () => {
    const sorted = [row('b', 100), row('z', 100), row('a', 200)].sort(recencyCompare)
    expect(sorted.map((r) => r.id)).toEqual(['a', 'b', 'z'])
  })
})

describe('prunePins', () => {
  it('只留仍存在的会话，去重保序（数组序=展示序，hermes pinned 语义）', () => {
    expect(prunePins(['a', 'x', 'a', 'b'], ['a', 'b', 'c'])).toEqual(['a', 'b'])
  })

  it('全消失 → 空组', () => {
    expect(prunePins(['x', 'y'], ['a'])).toEqual([])
  })
})

describe('togglePinId（hermes pinSession：追加尾部）', () => {
  it('未置顶 → 追加到尾', () => {
    expect(togglePinId(['a'], 'b')).toEqual(['a', 'b'])
  })

  it('已置顶 → 移除', () => {
    expect(togglePinId(['a', 'b'], 'a')).toEqual(['b'])
  })
})

describe('pruneOrder', () => {
  it('剔除消失会话与非有限序号', () => {
    expect(pruneOrder({ a: 1, x: 2, b: Number.NaN, c: 0 }, ['a', 'c'])).toEqual({ a: 1, c: 0 })
  })
})

describe('reconcileOrder（hermes mergeFreshByPosition 语义）', () => {
  it('无手动顺序 → 原新近序', () => {
    expect(reconcileOrder(['a', 'b', 'c'], {})).toEqual(['a', 'b', 'c'])
  })

  it('手动顺序居中，序号升序', () => {
    // 手动把 c 提到最前（c=0, a=1, b=2）
    expect(reconcileOrder(['a', 'b', 'c'], { c: 0, a: 1, b: 2 })).toEqual(['c', 'a', 'b'])
  })

  it('新会话（比第一个已排 id 更新）不沉底——折到顶部', () => {
    // 顺序里只有 b、c；a 是新会话（新近序在 b 之前）
    expect(reconcileOrder(['a', 'b', 'c'], { b: 0, c: 1 })).toEqual(['a', 'b', 'c'])
  })

  it('刚加载的旧页（比已排 id 更旧）沉到尾部，不跳顶', () => {
    expect(reconcileOrder(['a', 'd'], { a: 0 })).toEqual(['a', 'd'])
  })

  it('重复序号按 id 稳定，重复 id 去重', () => {
    expect(reconcileOrder(['a', 'b', 'c', 'a'], { a: 5, b: 5, c: 1 })).toEqual(['c', 'a', 'b'])
  })
})

describe('moveBefore', () => {
  it('移到目标行之前', () => {
    expect(moveBefore(['a', 'b', 'c'], 'c', 'a')).toEqual(['c', 'a', 'b'])
  })

  it('beforeId = null → 尾部', () => {
    expect(moveBefore(['a', 'b', 'c'], 'a', null)).toEqual(['b', 'c', 'a'])
  })

  it('目标不存在 → 尾部', () => {
    expect(moveBefore(['a', 'b', 'c'], 'a', 'zzz')).toEqual(['b', 'c', 'a'])
  })

  it('id 不在序列 → 原样（新数组）', () => {
    expect(moveBefore(['a', 'b'], 'zzz', 'a')).toEqual(['a', 'b'])
  })
})

describe('orderMapFromIds', () => {
  it('序列 → 0 起序号表', () => {
    expect(orderMapFromIds(['x', 'y'])).toEqual({ x: 0, y: 1 })
  })
})

describe('mergeVisibleReorder（hermes order.ts 逐语义）', () => {
  it('可见序与原长相等 → 原样替换', () => {
    expect(mergeVisibleReorder(['a', 'b'], ['b', 'a'])).toEqual(['b', 'a'])
  })

  it('折叠隐藏行保持原槽位，可见行按新序回填', () => {
    // 全量 [a, h, b, c]（h 在折叠桶里没渲染）；可见 [a, b, c] 拖成 [b, a, c]
    expect(mergeVisibleReorder(['a', 'h', 'b', 'c'], ['b', 'a', 'c'])).toEqual(['b', 'h', 'a', 'c'])
  })
})

describe('commitRecentMove（拖拽落点提交：可见序→全量序→序号表）', () => {
  it('把可见行移到目标行之前并收编全量序', () => {
    const map = commitRecentMove(['a', 'b', 'c', 'd'], ['a', 'b', 'c', 'd'], 'd', 'a')
    expect(map).toEqual({ d: 0, a: 1, b: 2, c: 3 })
  })

  it('beforeId = null → 移到可见尾部', () => {
    const map = commitRecentMove(['a', 'b', 'c', 'd'], ['a', 'b', 'c', 'd'], 'a', null)
    expect(map).toEqual({ b: 0, c: 1, d: 2, a: 3 })
  })

  it('折叠桶藏行保位（可见序短于全量序）', () => {
    // 全量 [a, h, b, c]：h 折叠未渲染；可见 [a, b, c] 把 c 拖到 a 前——
    // 新可见序 [c, a, b] 回填可见槽位（a、b 槽 → c、a；尾部 b），h 原地：
    // 结果 [c, h, a, b]
    const map = commitRecentMove(['a', 'h', 'b', 'c'], ['a', 'b', 'c'], 'c', 'a')
    expect(map).toEqual({ c: 0, h: 1, a: 2, b: 3 })
  })
})

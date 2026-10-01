/**
 * session-order 单测：置顶/手动顺序纯函数（hermes sidebar/order.ts 语义适
 * 配版）。覆盖：置顶清理/切换/组内活跃降序、手动顺序折回
 * （mergeFreshByPosition：新会话不沉底、旧页不跳顶）、移动落点、序号表
 * 往返、拖拽落点提交组合（orderMapAfterMove）。
 */
import { describe, expect, it } from 'vitest'

import {
  moveBefore,
  orderMapAfterMove,
  orderMapFromIds,
  orderedSessionIds,
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
  it('只留仍存在的会话，去重保序', () => {
    expect(prunePins(['a', 'x', 'a', 'b'], ['a', 'b', 'c'])).toEqual(['a', 'b'])
  })

  it('全消失 → 空组', () => {
    expect(prunePins(['x', 'y'], ['a'])).toEqual([])
  })
})

describe('togglePinId', () => {
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
    // 顺序里只有 a；d 是翻页加载的旧会话
    expect(reconcileOrder(['a', 'd'], { a: 0 })).toEqual(['a', 'd'])
    // 反向验证：若无位置规则、一律 hoist，d 会插到 a 前
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

describe('orderedSessionIds', () => {
  it('置顶组在最上（组内活跃降序），非置顶组按活跃降序', () => {
    const out = orderedSessionIds(fourRows(), ['c', 'a'], {})
    expect(out.pinnedIds).toEqual(['a', 'c']) // a(4000) > c(2000)
    expect(out.unpinnedIds).toEqual(['b', 'd'])
  })

  it('置顶键含已消失会话 → 忽略', () => {
    const out = orderedSessionIds(fourRows(), ['c', 'gone'], {})
    expect(out.pinnedIds).toEqual(['c'])
  })

  it('非置顶组遵循手动顺序', () => {
    const out = orderedSessionIds(fourRows(), ['a'], { d: 0, b: 1 })
    expect(out.unpinnedIds).toEqual(['d', 'b', 'c'])
  })

  it('新会话（无顺序条目、比已排的更新）落在非置顶组顶部', () => {
    const out = orderedSessionIds(fourRows(), [], { c: 0, d: 1 })
    expect(out.unpinnedIds).toEqual(['a', 'b', 'c', 'd'])
  })
})

describe('orderMapAfterMove（拖拽落点提交）', () => {
  it('把行移到目标行之前并重排序号表', () => {
    // 现状活跃序 [a,b,c,d]，把 d 拖到 a 前面
    const map = orderMapAfterMove(fourRows(), [], {}, 'd', 'a')
    expect(map).toEqual({ d: 0, a: 1, b: 2, c: 3 })
  })

  it('beforeId = null → 移到尾部', () => {
    const map = orderMapAfterMove(fourRows(), [], {}, 'a', null)
    expect(map).toEqual({ b: 0, c: 1, d: 2, a: 3 })
  })

  it('在既有手动顺序基础上继续排', () => {
    // 已有顺序 c=0,d=1,b=2（a 折回顶部）→ 当前序列 [a,b,c,d]；b 拖到 d 后（null）
    const map = orderMapAfterMove(fourRows(), [], { c: 0, d: 1, b: 2 }, 'b', null)
    expect(map).toEqual({ a: 0, c: 1, d: 2, b: 3 })
  })

  it('置顶行不可排——原样返回现有表', () => {
    const order = { b: 0 }
    expect(orderMapAfterMove(fourRows(), ['a'], order, 'a', 'c')).toEqual(order)
  })

  it('拖到自己的位置 → 全量重排但语义不变', () => {
    const map = orderMapAfterMove(fourRows(), [], {}, 'b', 'c')
    expect(map).toEqual({ a: 0, b: 1, c: 2, d: 3 })
  })
})

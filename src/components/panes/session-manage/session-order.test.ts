/**
 * session-order 单测：置顶/手动顺序纯函数（hermes sidebar/order.ts +
 * store/layout pinSession 语义适配版）。覆盖：置顶清理/切换（追加尾部）、
 * 手动顺序折回（mergeFreshByPosition：新会话不沉底、旧页不跳顶）、移动落点、
 * 序号表往返、可见序拼回全量序（mergeVisibleReorder）、拖拽落点提交
 * （commitRecentMove——折叠桶藏行保位）、dnd-kit 全量新序的落点反解
 * （diffArrayMove——穷举往返性质 + commitRecentMove 串通）。
 */
import { describe, expect, it } from 'vitest'

import {
  commitRecentMove,
  diffArrayMove,
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

/** 测试本地 arrayMove（= @dnd-kit/sortable 的实现，不跨包耦合）：
 *  dnd-kit onDragEnd 的产出形就是这个。 */
const dndArrayMove = <T>(array: readonly T[], from: number, to: number): T[] => {
  const copy = [...array]
  const len = copy.length
  const fromClamped = from < 0 ? Math.max(len + from, 0) : Math.min(from, len - 1)
  const toClamped = to < 0 ? Math.max(len + to, 0) : Math.min(to, len - 1)
  const [item] = copy.splice(fromClamped, 1)
  copy.splice(toClamped, 0, item as T)
  return copy
}

describe('diffArrayMove（dnd-kit 全量新序 → 提交通道落点反解）', () => {
  it('右移（被拖项落在更右槽）：moved = ids[首差]，beforeId = 新序后继', () => {
    expect(diffArrayMove(['a', 'b', 'c', 'd'], ['b', 'c', 'a', 'd'])).toEqual({
      movedId: 'a',
      beforeId: 'd',
    })
  })

  it('左移（被拖项来自右侧）：moved = next[首差]，beforeId = 新序后继', () => {
    expect(diffArrayMove(['a', 'b', 'c', 'd'], ['a', 'd', 'b', 'c'])).toEqual({
      movedId: 'd',
      beforeId: 'b',
    })
  })

  it('移到尾部 → beforeId = null；移到头部 → beforeId = 原首项', () => {
    expect(diffArrayMove(['a', 'b', 'c'], ['b', 'c', 'a'])).toEqual({ movedId: 'a', beforeId: null })
    expect(diffArrayMove(['a', 'b', 'c'], ['c', 'a', 'b'])).toEqual({ movedId: 'c', beforeId: 'a' })
  })

  it('相邻交换两种读法同解（结果序一致）', () => {
    const got = diffArrayMove(['a', 'b', 'c'], ['a', 'c', 'b'])
    expect(got).not.toBeNull()
    expect(moveBefore(['a', 'b', 'c'], got!.movedId, got!.beforeId)).toEqual(['a', 'c', 'b'])
  })

  it('无位移 / 形状异常 → null（拒绝提交，禁止兜底猜落点）', () => {
    expect(diffArrayMove(['a', 'b'], ['a', 'b'])).toBeNull()
    expect(diffArrayMove(['a', 'b'], ['a', 'c', 'b'])).toBeNull()
    expect(diffArrayMove(['a', 'a'], ['a', 'a'])).toBeNull()
  })

  it('穷举往返性质：任意 from/to 的 arrayMove 结果反解回 moveBefore 必还原新序', () => {
    const ids = ['a', 'b', 'c', 'd', 'e']
    for (let from = 0; from < ids.length; from++) {
      for (let to = 0; to < ids.length; to++) {
        const next = dndArrayMove(ids, from, to)
        if (from === to) {
          expect(diffArrayMove(ids, next)).toBeNull()
          continue
        }
        const got = diffArrayMove(ids, next)
        expect(got, `from=${from} to=${to}`).not.toBeNull()
        expect(moveBefore(ids, got!.movedId, got!.beforeId), `from=${from} to=${to}`).toEqual(next)
      }
    }
  })

  it('与 commitRecentMove 串通：折叠桶藏行保位（dnd-kit 提交全链）', () => {
    const all = ['a', 'h', 'b', 'c']
    const visible = ['a', 'b', 'c']
    const next = dndArrayMove(visible, 0, 2)
    const got = diffArrayMove(visible, next)!
    expect(commitRecentMove(all, visible, got.movedId, got.beforeId)).toEqual({
      b: 0,
      h: 1,
      c: 2,
      a: 3,
    })
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

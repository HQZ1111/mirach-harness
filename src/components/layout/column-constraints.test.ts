/**
 * 栏收放约束盒状态机（column-constraints.ts）的回归测试。
 *
 * 两条用例直接对应用户实测 bug：
 *  ①「关闭面板栏后分栏，面板栏的位置会出现一个空白页面」——收起态必须
 *    落成 0..0 盒；只放开 min 会让 0 宽列仍是 dockview 的 flexible item，
 *    `Sizing.Distribute` 的 addPanel（分栏/开新签）把它重新摊出宽度。
 *  ②「再次打开、关闭、打开面板栏，面板栏的宽度限制失效」——快照必须横跨
 *    整个隐藏期，展开收尾才还原原 min/max。
 *
 * 断言面 = 下发给组的显式约束序列（ConstraintTarget.apply 收到的值），
 * 以及 `splitview.distributeViewSizes` 的 flexible 判据
 * （`max - min > 0`）在收起态是否为假。
 */
import { describe, expect, it, vi } from 'vitest'

import {
  collapsedBox,
  createConstraintKeeper,
  NO_MAXIMUM,
  tweenBox,
  type ColumnConstraints,
  type ConstraintTarget,
} from './column-constraints'

/** 假组：初始在面板级约束上（无显式覆盖），记录每次下发的显式值。
 *  `currentMaximumWidth` 模拟 dockview 的组 getter：有显式值就返回显式值，
 *  否则回落到面板级（DockviewGroupPanel.maximumWidth 的实际语义）。 */
const fakeGroup = (panel: ColumnConstraints) => {
  const applied: ColumnConstraints[] = []
  let explicit: ColumnConstraints | null = null
  const target: ConstraintTarget = {
    id: 'g-panels',
    get currentMaximumWidth() {
      return explicit ? explicit.maximumWidth : panel.maximumWidth
    },
    get panelConstraints() {
      return panel
    },
    apply(next) {
      applied.push({ ...next })
      explicit = { ...next }
    },
  }
  return {
    target,
    applied,
    /** dockview 的 flexible 判据（splitview.distributeViewSizes / ViewItem）。 */
    effective(): ColumnConstraints {
      return explicit ?? panel
    },
  }
}

const PANELS: ColumnConstraints = { minimumWidth: 240, maximumWidth: NO_MAXIMUM }

describe('约束盒取值', () => {
  it('收起盒是 0..0（不是 0..MAX）', () => {
    expect(collapsedBox()).toEqual({ minimumWidth: 0, maximumWidth: 0 })
  })

  it('补间盒放开 min、保留原 max', () => {
    expect(tweenBox({ minimumWidth: 240, maximumWidth: 420 })).toEqual({
      minimumWidth: 0,
      maximumWidth: 420,
    })
  })

  it('收起盒不是 dockview 的 flexible item（分栏不会再摊出宽度）', () => {
    const box = collapsedBox()
    // distributeViewSizes 的判据原文：item.maximumSize - item.minimumSize > 0
    expect(box.maximumWidth - box.minimumWidth).toBe(0)
  })
})

describe('hide → show 序列（bug ②）', () => {
  it('展开收尾还原原 min/max', () => {
    const keeper = createConstraintKeeper()
    const g = fakeGroup(PANELS)

    keeper.beginTween(g.target) // 开始收起
    keeper.settleCollapsed(g.target) // 收尾：0..0
    expect(g.effective()).toEqual({ minimumWidth: 0, maximumWidth: 0 })

    keeper.beginTween(g.target) // 开始展开
    keeper.settleExpanded(g.target) // 展开收尾：还原
    expect(g.effective()).toEqual(PANELS)
  })

  it('快照横跨隐藏期：连续两次收放（用户报的"再次打开、关闭、打开"）', () => {
    const keeper = createConstraintKeeper()
    const g = fakeGroup(PANELS)

    for (let i = 0; i < 3; i++) {
      keeper.beginTween(g.target)
      keeper.settleCollapsed(g.target)
      expect(keeper.hasSnapshot(g.target)).toBe(true) // 隐藏期快照不消费
      keeper.beginTween(g.target)
      keeper.settleExpanded(g.target)
      expect(g.effective()).toEqual(PANELS) // 每一轮都还原
      expect(keeper.hasSnapshot(g.target)).toBe(false)
    }
  })

  it('左栏的 420 上限也一起还原（不只是 min）', () => {
    const keeper = createConstraintKeeper()
    const g = fakeGroup({ minimumWidth: 240, maximumWidth: 420 })
    keeper.beginTween(g.target)
    keeper.settleCollapsed(g.target)
    keeper.beginTween(g.target)
    keeper.settleExpanded(g.target)
    expect(g.effective().maximumWidth).toBe(420)
  })

  it('快照取面板级原值，不受组当前（收放态）值污染', () => {
    const keeper = createConstraintKeeper()
    const g = fakeGroup(PANELS)
    // 先经历一轮收放，队列里已有收放态的显式值
    keeper.beginTween(g.target)
    keeper.settleCollapsed(g.target)
    // 再走一轮：若快照误取组当前值，会把 0 当成原 max
    keeper.beginTween(g.target)
    keeper.settleExpanded(g.target)
    expect(g.effective().maximumWidth).toBe(NO_MAXIMUM)
  })
})

describe('target 身份（实机才暴露的陷阱）', () => {
  it('每次现造新 target 会让快照永远命中不了 → 展开后约束停在补间盒', () => {
    // 2026-10-22 实机实锤：dockview-column-ops 的投影对象必须按组分复用。
    // 这条用例把"不复用"的后果钉死：min 停在 0、max 停在原值（补间盒），
    // 用户看到的正是"宽度限制失效"。
    const keeper = createConstraintKeeper()
    const g = fakeGroup(PANELS)
    const freshTarget = () => ({
      id: g.target.id,
      get currentMaximumWidth() {
        return g.target.currentMaximumWidth
      },
      get panelConstraints() {
        return g.target.panelConstraints
      },
      apply: g.target.apply,
    })

    keeper.beginTween(freshTarget() as ConstraintTarget)
    keeper.settleCollapsed(freshTarget() as ConstraintTarget)
    keeper.beginTween(freshTarget() as ConstraintTarget)
    keeper.settleExpanded(freshTarget() as ConstraintTarget)

    // 没有还原到面板级约束：min 还是 0（限制失效的实锤形态）
    expect(g.effective()).toEqual({ minimumWidth: 0, maximumWidth: NO_MAXIMUM })
    expect(g.effective()).not.toEqual(PANELS)
  })

  it('复用同一个 target 时才真正还原（修复后的契约）', () => {
    const keeper = createConstraintKeeper()
    const g = fakeGroup(PANELS)
    keeper.beginTween(g.target)
    keeper.settleCollapsed(g.target)
    keeper.beginTween(g.target)
    keeper.settleExpanded(g.target)
    expect(g.effective()).toEqual(PANELS)
  })
})

describe('无快照的展开（刷新 / HMR 路径）', () => {  it('组上残留 0 宽盒 → 按面板约束还原，并让异常可见', () => {
    const keeper = createConstraintKeeper()
    const g = fakeGroup(PANELS)
    // 模拟 HMR：旧模块实例把 0..0 留在组上，新实例的 WeakMap 是空的
    g.target.apply({ minimumWidth: 0, maximumWidth: 0 })
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})

    keeper.settleExpanded(g.target)

    expect(g.effective()).toEqual(PANELS)
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })

  it('组上没有收放痕迹 → 不钉显式约束（保持"组约束跟随活动面板"的回落）', () => {
    const keeper = createConstraintKeeper()
    const g = fakeGroup(PANELS)

    keeper.settleExpanded(g.target)

    // 一次都不该下发：给组钉显式约束会切断 dockview 的 getter 回落语义
    expect(g.applied).toEqual([])
  })
})

describe('收起态不被分栏摊宽（bug ①）', () => {
  it('收起后按 flexible 集合算：0 宽列不在其中', () => {
    const keeper = createConstraintKeeper()
    const collapsed = fakeGroup(PANELS)
    const chat = fakeGroup({ minimumWidth: 395, maximumWidth: NO_MAXIMUM })
    keeper.beginTween(collapsed.target)
    keeper.settleCollapsed(collapsed.target)

    // port of splitview.distributeViewSizes 的筛选
    const flexible = [collapsed.effective(), chat.effective()].filter(
      (c) => c.maximumWidth - c.minimumWidth > 0,
    )
    expect(flexible).toHaveLength(1)
    expect(flexible[0]).toEqual(chat.effective())
  })

  it('只有 min 放开（旧行为）会留在 flexible 集合里——这是 bug ① 的机制', () => {
    // 反向断言：锁定修复的必要性，防止将来有人把 max 归零"优化"掉
    const onlyMinReleased = { minimumWidth: 0, maximumWidth: NO_MAXIMUM }
    expect(onlyMinReleased.maximumWidth - onlyMinReleased.minimumWidth).toBeGreaterThan(0)
  })
})

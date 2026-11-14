import { describe, expect, it } from 'vitest'

/**
 * 拖放准入判定的纯函数化（与 dockview-shell 里 onWillDrop 的条件一一对应）。
 *
 * 抽出这份判定只为**锁住语义**——用户 2026-10-22 明确要求：
 *   · 左栏不能分栏、也不能被拖进标签；
 *   · 只有面板栏的标签能拖出来分栏。
 * 真机 CDP 验证见交付说明；这里守的是"以后改代码别把规则改回去"。
 */

type Region = 'left' | 'chat' | 'panels'

interface DropContext {
  /** 落点组的语义域 */
  targetRegion: Region | undefined
  /** 目标组的 header 是否隐藏（无条组收下第二个标签 = 隐形标签死结） */
  targetHeaderHidden: boolean
  /** 落点方位 */
  position: 'left' | 'right' | 'top' | 'bottom' | 'center'
  /** 被拖面板的语义域 */
  sourceRegion: Region | undefined
  /** 源组里有多少面板 */
  sourceGroupSize: number
  /** 源组与目标组是否同一个 */
  sameGroup: boolean
}

type Verdict = 'deny' | 'dockview-default' | 'takeover-split'

const decide = (ctx: DropContext): Verdict => {
  // ① 左栏不是拖拽目标（用户定稿）
  if (ctx.targetRegion === 'left') return 'deny'
  // ② 内容区中心堆叠进无头组 → 隐形标签死结，拒
  if (ctx.targetHeaderHidden && ctx.position === 'center') return 'deny'
  // ③ 只有面板栏的标签需要我们接管（左栏无标签；会话标签走原生分栏）
  if (ctx.sourceRegion !== 'panels') return 'dockview-default'
  // ④ 源组多面板时 dockview 自己能正确拆组
  if (ctx.sourceGroupSize > 1) return 'dockview-default'
  // ⑤ 同组内换位交给 dockview
  if (ctx.sameGroup) return 'dockview-default'
  // ⑥ 中心 = 堆叠，不接管
  if (ctx.position === 'center') return 'dockview-default'
  return 'takeover-split'
}

const base: DropContext = {
  targetRegion: 'chat',
  targetHeaderHidden: true,
  position: 'left',
  sourceRegion: 'panels',
  sourceGroupSize: 1,
  sameGroup: false,
}

describe('拖放准入判定', () => {
  it('左栏一律拒绝（不能分栏、不能收标签）', () => {
    for (const position of ['left', 'right', 'top', 'bottom', 'center'] as const) {
      expect(decide({ ...base, targetRegion: 'left', position })).toBe('deny')
    }
  })

  it('面板栏单标签拖到对话列分栏位 → 我们接管', () => {
    for (const position of ['left', 'right', 'top', 'bottom'] as const) {
      expect(decide({ ...base, position })).toBe('takeover-split')
    }
  })

  it('中心落点不接管（堆叠由 dockview 处理，无头组另判）', () => {
    expect(decide({ ...base, position: 'center', targetHeaderHidden: false })).toBe('dockview-default')
  })

  it('无头组的中心落点被拒（隐形标签死结）', () => {
    expect(decide({ ...base, position: 'center', targetHeaderHidden: true })).toBe('deny')
  })

  it('会话标签（chat 域）不接管，走 dockview 原生分栏', () => {
    expect(decide({ ...base, sourceRegion: 'chat' })).toBe('dockview-default')
  })

  it('源组有多个面板时不接管（dockview 自己能正确拆组）', () => {
    expect(decide({ ...base, sourceGroupSize: 2 })).toBe('dockview-default')
  })

  it('同组内换位不接管', () => {
    expect(decide({ ...base, sameGroup: true })).toBe('dockview-default')
  })

  it('落到面板栏自己身上（不同组、单标签）仍接管', () => {
    expect(decide({ ...base, targetRegion: 'panels' })).toBe('takeover-split')
  })
})

/**
 * 栏收放的**约束盒状态机**（2026-10-22 从 dockview-column-ops 抽出）。
 *
 * 背景（两条用户实测 bug，同一个根因面）：
 *  ①「关闭面板栏后分栏，面板栏的位置会出现一个空白页面」；
 *  ②「再次打开、关闭、打开面板栏，面板栏的宽度限制失效」。
 *
 *  ①的机制：收起只把 min 放开到 0、max 留在 MAX_SAFE_INTEGER，那列对
 *  dockview 仍是 **flexible item**（`splitview.distributeViewSizes` 的判据
 *  是 `maximumSize - minimumSize > 0`）。任何走 `Sizing.Distribute` 的
 *  addPanel（分栏 / 开新签/预览都是这条）都会把它重新摊出四五百像素，
 *  而内容层还挂着 `data-dv-collapsed`（CSS 已把命中与 padding 关掉）——
 *  用户看到面板栏位置上一张空白卡片。
 *  ②的机制：收起收尾就把约束快照删了，展开方向拿不到原值 → 组级约束
 *  永久停在收放态。max 还留在 MAX 时 ①会持续复发；min 留在 0 时那列的
 *  最小宽限制也没了。
 *
 * 所以收起态的约束盒必须是 **0..0**（不可摊宽也不可拖宽），而展开必须
 * 还原收放前的原值。原值取**面板级**约束而不是组当前值——组当前值可能
 * 已经是收放态（刷新后按旗标自愈时列本来就在 0 宽），拿它当原值会把这个
 * 错误固化。
 *
 * 这个模块只做状态与盒子计算，不碰 DOM/dockview 模型——调用方（
 * dockview-column-ops）负责把 `ConstraintTarget` 投影到真实组上，测试
 * 用普通对象即可覆盖整条 hide→show 序列。
 */

export interface ColumnConstraints {
  minimumWidth: number
  maximumWidth: number
}

/** dockview 的"无上限"取值（BasePanelView 的默认 `_maximumWidth`）。 */
export const NO_MAXIMUM = Number.MAX_SAFE_INTEGER

/** 约束下发面 = DockviewGroupPanel 的最小投影。 */
export interface ConstraintTarget {
  readonly id: string
  /** 组**当前生效**的 max（`DockviewGroupPanel.maximumWidth`，含显式覆盖）。 */
  readonly currentMaximumWidth: number
  /** 面板级原约束（组级显式约束缺席时 dockview 的回落目标）。 */
  readonly panelConstraints: ColumnConstraints
  /** 下发组级显式约束（`group.api.setConstraints`）。 */
  apply(next: ColumnConstraints): void
}

/** 收起态：0..0。max 归零是关键——见文件头 ①。 */
export const collapsedBox = (): ColumnConstraints => ({ minimumWidth: 0, maximumWidth: 0 })

/** 补间窗口：min 放开到 0（否则补间收不到 0），max 保留原值（补间要在
 *  0..原宽 连续取值，任何上限都会让首帧被 clamp 跳变）。 */
export const tweenBox = (original: ColumnConstraints): ColumnConstraints => ({
  minimumWidth: 0,
  maximumWidth: original.maximumWidth,
})

export interface ConstraintKeeper {
  /** 补间开始前调用：记快照（仅首次）+ 放开 min。 */
  beginTween(t: ConstraintTarget): void
  /** 收起收尾：压成 0..0 盒。**快照保留**（隐藏期要给展开方向用）。 */
  settleCollapsed(t: ConstraintTarget): void
  /** 展开收尾：还原原约束并消费快照。 */
  settleExpanded(t: ConstraintTarget): void
  /** 该组是否持有隐藏期快照（诊断/测试）。 */
  hasSnapshot(t: ConstraintTarget): boolean
}

export const createConstraintKeeper = (): ConstraintKeeper => {
  // 快照横跨整个隐藏期（旧实现在收起收尾就 delete，导致 ②）
  const originals = new WeakMap<ConstraintTarget, ColumnConstraints>()

  const remember = (t: ConstraintTarget): ColumnConstraints => {
    const existing = originals.get(t)
    if (existing) return existing
    const saved: ColumnConstraints = { ...t.panelConstraints }
    originals.set(t, saved)
    return saved
  }

  return {
    beginTween(t) {
      t.apply(tweenBox(remember(t)))
    },
    settleCollapsed(t) {
      remember(t)
      t.apply(collapsedBox())
    },
    settleExpanded(t) {
      const saved = originals.get(t)
      originals.delete(t)
      if (saved) {
        t.apply({ ...saved })
        return
      }
      // 无快照 = 合法态（刷新后组级显式约束不随存档往返；HMR 换了模块
      // 实例）。只有**看到残留的 0 宽盒**才说明有东西要还原——此时按面板
      // 级约束下发一次；否则原样离开，不把约束钉成显式（那会切断"组约束
      // 跟随活动面板"的回落语义）。
      if (t.currentMaximumWidth !== 0) return
      console.error('[column-constraints] 组上残留收放约束盒（无快照）——按面板约束还原', t.id)
      t.apply({ ...t.panelConstraints })
    },
    hasSnapshot(t) {
      return originals.has(t)
    },
  }
}

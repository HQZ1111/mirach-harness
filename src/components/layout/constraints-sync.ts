import { Actions, DockLocation, Model, Orientation, RowNode, TabNode, TabSetNode, type Node } from 'flexlayout-react'
import { SPLITTER_PX } from './layout-presets'
import { PANE_TYPES, PRIMARY_PANE, REGION_LIMITS, TRACK_W, paneTypeOf, zoneConfigOf, type Region } from './pane-registry'
import { isTopBand, regionCfgOfNode, rootAvailPx, widthBounds } from './constraints'
import { sessionCatalog } from '../panes/session-manage/session-catalog'

/**
 * 约束应用器 syncTabsetConstraints（docs/layout-design.md §2 约束引擎 v4）：
 * 限制跟随状态——列 identity 三级推导（config 戳→一级窗格→最近邻）、
 * 过承诺缩让、空区竖轨清理、分栏 min/max/条形态/低条/关闭钮语义落属性。
 * diff 门控：属性一致的 tabset 不发动作。
 */
/**
 * 约束引擎 v4（docs/layout-design.md）——**限制跟随状态**：列 identity 由
 * 一级窗格锚定（含 sessions=左栏、workspace=主栏、files=右栏），分栏的
 * 宽度限制/关闭钮跟随其所在列动态推导（拖进哪栏继承哪栏，回家自动变
 * 回来）。**diff 门控**：属性一致的 tabset 不发动作。
 */
export const syncTabsetConstraints = (m: Model) => {
  // 竖轨形态由**轨**决定（railByRegion = 该栏有没有 20px 轨）——分栏自身
  // 不携带形态；有轨的大栏，其分栏横向条统一隐藏、内容向上充满
  const railByRegion: Record<Region, boolean> = { left: false, main: false, right: false }
  m.visitNodes((node) => {
    if (!(node instanceof TabSetNode)) return
    // 浮动窗格隔离（§8/§12）：非主布局子树（浮动/弹出窗）不参与竖轨形态
    // 判定——轨只建在主布局网格里
    if (node.getLayoutId() !== Model.MAIN_LAYOUT_ID) return
    const cfg = zoneConfigOf(node)
    if (cfg?.rail && cfg.track) railByRegion[cfg.region] = true
  })
  // 过承诺防护（"右栏被挤出窗口"的根治）：Σ(各大栏最小宽) > 可用宽时，
  // 主栏分栏的 min 按比例缩让——主栏是吸收者，富余归它，亏空也只能归它
  // （左右栏的 240 底线不让）。多开主栏分栏（395×n）或窗口变窄时触发；
  // 宽度恢复后这里自动回 395（diff 门控双向生效）。flexbox 的内联
  // min-width 钳死了权重层的一切缩让，min 必须在这里改。
  const rootRow = m.getRootRow()
  const rootKids = rootRow?.getChildren() ?? []
  // ── 列 region 推导（"宽度限制跟随状态"的核心，用户 2026-09-26 定稿）──
  // 来源优先级：①config 戳（有戳列 identity 永久保持——防夺锚：拖入别
  // 的一级窗格、或原锚离开，都不改变列身份）；②列子树内第一个一级窗格
  // （全新列由它锚定，如拖出的主会话新列 = 主栏）；③**最近邻已推导列**
  // （拖出的非一级新分栏继承来源列——v4 曾丢失此规则，机器人拖出双栏
  // 并列后错继承 main）；④main。轨不参与（无 region 条目）。
  const kidRegion = new Map<string, Region>()
  const primaryRegionOf = (k: Node): Region | undefined => {
    let r: Region | undefined
    const walk = (n: Node) => {
      if (r) return
      if (n instanceof TabNode) {
        const t = paneTypeOf(n.getId())
        const def = t ? PANE_TYPES[t] : undefined
        if (def?.primary) r = def.region
        return
      }
      for (const c of n.getChildren()) walk(c)
    }
    walk(k)
    return r
  }
  const nonTrackKids = rootKids.filter((k) => !regionCfgOfNode(k)?.track)
  for (const k of nonTrackKids) {
    const stamped = regionCfgOfNode(k)?.region
    if (stamped) kidRegion.set(k.getId(), stamped)
  }
  // ② 全新列（无戳）由列子树内第一个一级窗格的家乡 region 锚定——**必须
  // 先于邻居传播**（§2.1 优先级）：否则拖出的主会话新列会被邻居（如左栏）
  // 的 region 抢锚，宽度限制跟着错（"主会话拖到左栏旁分裂"场景，
  // 2026-10-01 审查 P1-2）。
  for (const k of nonTrackKids) {
    if (kidRegion.get(k.getId())) continue
    const r = primaryRegionOf(k)
    if (r) kidRegion.set(k.getId(), r)
  }
  // ③ 邻居传播：仍无 region 的列（子树无一级窗格，如拖出的机器人分栏）
  // 从最近邻（左先右后）继承，直到收敛
  let propagated = true
  while (propagated) {
    propagated = false
    for (let i = 0; i < nonTrackKids.length; i++) {
      const k = nonTrackKids[i]
      if (kidRegion.get(k.getId())) continue
      const leftR = i > 0 ? kidRegion.get(nonTrackKids[i - 1].getId()) : undefined
      const rightR = i < nonTrackKids.length - 1 ? kidRegion.get(nonTrackKids[i + 1].getId()) : undefined
      const r = leftR ?? rightR
      if (r) {
        kidRegion.set(k.getId(), r)
        propagated = true
      }
    }
  }
  // ④ 都不满足 → main
  for (const k of nonTrackKids) {
    if (!kidRegion.get(k.getId())) kidRegion.set(k.getId(), 'main')
  }
  // 空区竖轨清理（用户 2026-09-27：竖轨里关闭区内最后一个窗格后，空轨
  // 不残留——原"空轨保留"设计作废）：某区的轨还在、但该区已无任何分栏
  // → 拆轨（区丢失后回种走回家/拖缘/+，不依赖空轨）。
  for (const k of rootKids) {
    const cfg = regionCfgOfNode(k)
    if (!cfg?.track) continue
    if (nonTrackKids.some((z) => kidRegion.get(z.getId()) === cfg.region)) continue
    m.doAction(Actions.updateNodeAttributes(k.getId(), { enableDeleteWhenEmpty: true, enableClose: true }))
    const spacerId = `${cfg.region}-prune-spacer`
    m.doAction(
      Actions.addNode(
        { type: 'tab' as const, id: spacerId, component: 'external', name: '', enableClose: true },
        k.getId(),
        DockLocation.CENTER,
        0,
      ),
    )
    m.doAction(Actions.deleteTab(spacerId))
  }
  let mainMinW = REGION_LIMITS.main.minW
  if (nonTrackKids.length > 0 && window.innerWidth >= 600) {
    const avail = rootAvailPx() - SPLITTER_PX * Math.max(rootKids.length - 1, 0)
    if (avail > 300) {
      let nonMainMin = 0
      let mainTabs = 0
      for (const k of nonTrackKids) {
        if (kidRegion.get(k.getId()) === 'main') mainTabs++
        else nonMainMin += widthBounds(k, k instanceof RowNode).min
      }
      const scaled = mainTabs > 0 ? Math.floor((avail - nonMainMin) / mainTabs) : REGION_LIMITS.main.minW
      mainMinW = scaled >= REGION_LIMITS.main.minW ? REGION_LIMITS.main.minW : Math.max(scaled, 40)
    }
  }
  // 主栏吸收者是否在场——不在场时非主栏 max 放开、只留 min
  // （用户 2026-09-26 定稿："最大宽度限制应该变没有"）
  const hasMainKid = [...kidRegion.values()].some((r) => r === 'main')
  m.visitNodes((node) => {
    if (!(node instanceof TabSetNode)) return
    // 浮动窗格隔离（§8/§12）：非主布局子树（浮动/弹出窗）不被 sync 污染
    // ——浮窗内分栏不推 minWidth/不打 fl-strip-low/不改 enableClose，
    // 限制与形态语义只属于主布局网格。
    if (node.getLayoutId() !== Model.MAIN_LAYOUT_ID) return
    // 空分栏跳过；空轨（20px 导航轨）必须过——它的 min/max 在这里修
    if (node.getChildren().length === 0 && !zoneConfigOf(node)?.track) return
    const isTrack = zoneConfigOf(node)?.track === true
    // 列 region：沿父链上溯到根行直接子项，查列 region 表
    let rootKid: Node = node
    for (;;) {
      const p = rootKid.getParent()
      if (!p || p === rootRow) break
      rootKid = p
    }
    const region = kidRegion.get(rootKid.getId()) ?? regionCfgOfNode(node)?.region ?? 'main'
    const limits = REGION_LIMITS[region]
    const rail = railByRegion[region]
    const patch: Record<string, unknown> = {}
    // config 跟随状态重钉：分栏现在的 region = 它所在列的 region（"标签
    // 要知道自己被拖进哪一栏"，回家后自动变回来）。**轨必须跳过重钉**：
    // updateNodeAttributes 的 config 是整对象替换，重钉 {region, rail} 会
    // 把轨的 track:true 身份抹掉 → findRailTabset 失效 → 每次切竖轨都新建
    // 一条轨，积累成两排 20px 竖条（2026-09-26 用户截图实锤）。
    const oldCfg = zoneConfigOf(node)
    if (!isTrack && (!oldCfg || oldCfg.region !== region || oldCfg.rail)) {
      patch.config = { region, rail: false }
    }
    const parent = node.getParent()
    const parentRow = parent instanceof RowNode ? parent : undefined
    const alongWidth = parentRow ? parentRow.getOrientation() === Orientation.HORZ : true
    // 纵向堆叠列的**第一个（顶部）分栏**保留列宽度限制，其余跟随上部
    // （[0,∞]）——列的聚合 min=MAX(子 min)=列 min、max=MIN(子 max)=列 max，
    // 列限制得保（终端这类柔性子项不受影响）。
    const stackedFirst = !alongWidth && !!parentRow && parentRow.getChildren()[0] === node
    if (isTrack) {
      // 竖轨（栏外缘 20px 导航轨）：固定宽，不受大栏限制管
      if (node.getMinWidth() !== TRACK_W) patch.minWidth = TRACK_W
      if (node.getMaxWidth() !== TRACK_W) patch.maxWidth = TRACK_W
    } else if (alongWidth || stackedFirst) {
      // 主栏 min 用过承诺缩让值（正常宽度下 = 395）
      const minW = region === 'main' ? mainMinW : limits.minW
      if (node.getMinWidth() !== minW) patch.minWidth = minW
      // 主栏不在场（无吸收者）→ 非主栏 max 放开、只留 min——否则列顶到
      // max 后无人吸收富余又是行尾留白；主栏回来后 diff 门控自动恢复
      const maxW = !hasMainKid ? 99999 : (limits.maxW ?? 99999)
      if (node.getMaxWidth() !== maxW) patch.maxWidth = maxW
    } else {
      if (node.getMinWidth() !== 0) patch.minWidth = 0
      if (node.getMaxWidth() !== 99999) patch.maxWidth = 99999
    }
    const wantStrip = sessionCatalog.getState().stripHidden[region] === true
      ? node.isEnableTabStrip() // 用户「切换标签」主动隐藏——sync 不碰（boot 补跑不得覆盖用户选择）
      : !rail
    if (node.isEnableTabStrip() !== wantStrip) patch.enableTabStrip = wantStrip
    // 低条（上下分栏的非顶部分栏，isTopBand 判定）：classNameTabStrip 落在
    // tabbar_outer 上，CSS 把条降到 --strip-low-height、文字居中。
    // 轨跳过（无条）；竖轨形态条本就隐藏，类挂着无副作用。
    if (!isTrack) {
      const wantCls = isTopBand(rootRow, node) ? undefined : 'fl-strip-low'
      if (node.getClassNameTabStrip() !== wantCls) patch.classNameTabStrip = wantCls
    }
    // 高度：垂直堆叠语境不设限（min 由标题条天然保证，max 无——"最大高度
    // 没限制"）；历史遗留的 min/max 清回默认（白带类 bug 的根源随之消失）
    if (parentRow && parentRow.getOrientation() === Orientation.VERT) {
      if (node.getMinHeight() !== 0) patch.minHeight = 0
      if (node.getMaxHeight() !== 99999) patch.maxHeight = 99999
    }
    if (Object.keys(patch).length > 0) {
      m.doAction(Actions.updateNodeAttributes(node.getId(), patch))
    }
    // 一级窗格页签的关闭钮（回家语义）：离家显示 ✕（点击=回家），在家隐藏；
    // 显隐统一走 hover（用户 2026-09-27 撤销常显）——fl-tab-away 仅作语义标记
    for (const c of node.getChildren()) {
      if (!(c instanceof TabNode)) continue
      const ptype = paneTypeOf(c.getId())
      const pdef = ptype ? PANE_TYPES[ptype] : undefined
      if (!pdef?.primary) continue
      const wantClose = region !== pdef.region
      if (c.isEnableClose() !== wantClose) {
        m.doAction(Actions.updateNodeAttributes(c.getId(), { enableClose: wantClose }))
      }
      const wantCls = wantClose ? 'fl-tab-away' : undefined
      if (c.getClassName() !== wantCls) {
        m.doAction(Actions.updateNodeAttributes(c.getId(), { className: wantCls }))
      }
    }
  })
}

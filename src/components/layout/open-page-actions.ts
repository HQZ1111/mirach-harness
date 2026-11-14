/**
 * 打开页动作（打开页三按钮 + 面板栏标签条 + 号共用，2026-10-15 自
 * dockview-shell 抽出——两处调用方，逻辑单源）。
 *
 * 落点锚语义（2026-10-15 边界实测修复，原 dockview-shell 注释随迁）：
 * open 在场 → within open；锚缺席 = 面板列已有实签（生命周期：实签抵达即
 * 撤锚）——此时硬指向 'open' 会被 dockview 抛 "referencePanel 'open' does
 * not exist"。回退 within 根面板组（regionOfGroup 找 panels 域组），组也
 * 找不到（极空态）才回退 workspace 右侧新建。
 */
import type { DockviewApi } from 'dockview-react'

import type { OpenPageKind } from '@/components/panes/open-page'
import { columnFlagsOf, rootPanelsGroup, setPanelsHidden } from './dockview-column-ops'
import { RAIL_MIN_WIDTH } from './rail-metrics'

export const OPEN_KIND_PANEL: Record<OpenPageKind, { id: string; component: string; title: string }> = {
  files: { id: 'files', component: 'files', title: '文件树' },
  terminal: { id: 'terminal', component: 'terminal', title: '终端' },
  preview: { id: 'preview', component: 'preview', title: '预览' },
  // 审查（2026-10-26）：hermes right-sidebar/review 的移植——变更列表 +
  // diff + 暂存/还原 + 提交/推送/PR。
  review: { id: 'review', component: 'review', title: '审查' },
}

export const panelsDropPosition = (
  a: DockviewApi,
):
  | { referencePanel: string; direction: 'within' }
  | { referenceGroup: string; direction: 'within' }
  | { referencePanel: string; direction: 'right' } => {
  if (a.getPanel('open')) return { referencePanel: 'open', direction: 'within' }
  const host = rootPanelsGroup(a)
  if (host) return { referenceGroup: host.id, direction: 'within' }
  return { referencePanel: 'workspace', direction: 'right' }
}

/** 开出/置前一个打开页面板（文件树/终端/预览三入口共用）。失败 =
 *  console.error 可见（禁止静默假装成功）。
 *
 *  面板栏处于「末签关闭已关栏」态（panelsHidden）时开出实签 = 栏重新
 *  在场——旗标随实签清掉（ZCode 语义：栏的生命周期跟实签走）。 */
export function openPagePanel(a: DockviewApi, kind: OpenPageKind): void {
  const target = OPEN_KIND_PANEL[kind]
  try {
    const existing = a.getPanel(target.id)
    if (existing) {
      existing.api.setActive()
      if (columnFlagsOf().panelsHidden) setPanelsHidden(false)
      return
    }
    a.addPanel({
      ...target,
      minimumWidth: RAIL_MIN_WIDTH,
      params: { region: 'panels' },
      position: panelsDropPosition(a),
    })
    if (columnFlagsOf().panelsHidden) setPanelsHidden(false)
  } catch (e) {
    console.error('[open-page] 打开页动作失败', kind, e)
  }
}

/**
 * 把**单面板组**里的面板拖到另一组的分栏位（2026-10-22）。
 *
 * 为什么需要：dockview 的 `_doMoveGroupOrPanel` 在 `sourceGroup.size < 2`
 * 时走「整组移动」分支——同层 `moveView` 换位，**不拆新组**。面板栏常态
 * 只有一个标签（`open` 锚被实签撤下后就是 files/terminal 单签），于是
 * 「把面板栏的标签拖出来分栏」永远只是换位（用户报的"拖不出来"）。
 *
 * ## 为什么用「补占位 + moveTo + 撤占位」而不是 addPanel
 *
 * `addPanel({ position: { referenceGroup, direction } })` 内部走
 * `orthogonalize(directionToPosition(direction))`——在 **HORIZONTAL 根布局**
 * 上遇到 `top`/`bottom` 会 `insertOrthogonalSplitviewAtRoot()`，把**整个根**
 * 转成垂直再插入（CDP 实测：拖到底部时 files 变成对话组的第二个标签，
 * 而不是对话列下方的新组）。`left`/`right` 不走这一步，所以那两个方向
 * 用 addPanel 恰好正确——但用两套代码路径会留下"只有上下方向坏"的坑。
 *
 * `moveGroupOrPanel`（`panel.api.moveTo` 的内部实现）在 `sourceGroup.size >= 2`
 * 时走的是 `getRelativeLocation` + `createGroupAtLocation`——方位在**目标组
 * 所在的 gridview 内**相对计算，四个方向都对。所以这里：
 *   ① 给源组临时塞一个 0 尺寸占位面板，把 size 抬到 2；
 *   ② `source.api.moveTo({ group: target, position })` 让 dockview 走正确分支；
 *   ③ 关掉占位面板。
 * 占位面板必须用 `inactive: true` 且尺寸为 0，避免闪一下可见内容。
 */
export function splitPanelOut(
  a: DockviewApi,
  panelId: string,
  targetGroupId: string,
  position: 'left' | 'right' | 'top' | 'bottom',
): void {
  const placeholderId = `__split-placeholder-${panelId}`
  try {
    const source = a.getPanel(panelId)
    if (!source) {
      console.error('[split-out] 源面板不在场', panelId)
      return
    }
    const target = a.groups.find((g) => g.id === targetGroupId)
    if (!target) {
      console.error('[split-out] 目标组不在场', targetGroupId)
      return
    }
    const sourceGroupId = source.group.id

    // ① 占位：把源组 size 抬到 2（用同 component 的隐藏面板，避免渲染空壳报错）
    const component = source.view.contentComponent
    a.addPanel({
      id: placeholderId,
      component,
      title: '',
      inactive: true,
      params: { ...(source.params ?? {}) },
      position: { referenceGroup: sourceGroupId, direction: 'within' },
    })

    // ② 走 moveGroupOrPanel 的正确分支
    const moving = a.getPanel(panelId)
    if (!moving) {
      console.error('[split-out] 占位后源面板丢失', panelId)
      return
    }
    moving.api.moveTo({ group: target, position })

    // ③ 撤占位
    a.getPanel(placeholderId)?.api.close()
  } catch (e) {
    console.error('[split-out] 拖出分栏失败', { panelId, targetGroupId, position }, e)
    try {
      a.getPanel(placeholderId)?.api.close()
    } catch (cleanupErr) {
      console.error('[split-out] 占位面板清理失败', cleanupErr)
    }
  }
}

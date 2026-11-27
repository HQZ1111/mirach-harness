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
import { sessionCatalog } from '@/components/panes/session-manage/session-catalog'
import { pickTerminalCwd } from '@/components/panes/terminal/terminal-cwd'
import {
  isTerminalPanelId,
  nextTerminalPanelId,
  nextTerminalPanelTitle,
  terminalProjectName,
} from '@/components/panes/terminal/terminal-tabs'
import { columnFlagsOf, rootPanelsGroup, setPanelsHidden } from './dockview-column-ops'
import { RAIL_MAX_WIDTH, RAIL_MIN_WIDTH } from './rail-metrics'

export const OPEN_KIND_PANEL: Record<OpenPageKind, { id: string; component: string; title: string }> = {
  files: { id: 'files', component: 'files', title: '文件树' },
  terminal: { id: 'terminal', component: 'terminal', title: '终端' },
  preview: { id: 'preview', component: 'preview', title: '预览' },
  // 审查（2026-10-26）：hermes right-sidebar/review 的移植——变更列表 +
  // diff + 暂存/还原 + 提交/推送/PR。
  review: { id: 'review', component: 'review', title: '审查' },
  // 电台（2026-11-15）：hermes radio 插件改落窗格（宿主无底栏）。
  radio: { id: 'radio', component: 'radio', title: '电台' },
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
  // 预览面板必须带 filePath（文件树/审查双击走 preview-opener 专用通道）；
  // 空预览会留下一个永远空白的页签（2026-11-27 用户："预览页删除，现在是空的"）。
  if (kind === 'preview') {
    console.error('[dv-shell] 预览面板需要文件路径——不再打开空预览（请从文件树单击文件）')
    return
  }
  // 终端 = 多实例（ZCode side pane terminal tabs：每次点终端都新建一个
  // 标签，不复用单例）——单独一条路径，其余面板保持单例置前。
  if (kind === 'terminal') {
    openTerminalPanel(a)
    return
  }
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
      maximumWidth: RAIL_MAX_WIDTH,
      params: { region: 'panels' },
      position: panelsDropPosition(a),
    })
    if (columnFlagsOf().panelsHidden) setPanelsHidden(false)
  } catch (e) {
    console.error('[open-page] 打开页动作失败', kind, e)
  }
}

/**
 * 打开一个**新**终端面板（ZCode side pane Terminal tab，2026-11-17）。
 *
 * 上游规格 `docs/ui/side-pane-terminal-tabs.md`：
 *   - `+` 菜单每次点 Terminal 都新建一个 side pane tab，不复用单例；
 *   - 标题按 workspace 名命名：第一个 `workspace-name`，第二个
 *     `workspace-name 2`……（宿主没有全局 workspace，等价物 = 当前活动
 *     会话 cwd 的末段，也是终端 PTY 的实际 cwd）；
 *   - 每个 tab 一个独立终端实例，内部不再嵌套第二层 terminal tabs；
 *   - 关闭 tab = 卸载 TerminalSession = 释放该 PTY（TerminalPane 卸载路径）。
 *
 * 面板 id 与标题分开算：id 取最小空位（terminal / terminal-2…），标题按
 * 已打开终端标签的标题集去重（关掉 "名 2" 后新建仍取 "名 2"）。
 *
 * `renderer: 'always'`：终端内容切到别的标签时**保持挂载**——PTY 不中断
 * （ZCode side pane terminal "切换到其他 side pane tab 或收起 side pane
 * 时保持挂载，不中断正在运行的命令"）。dockview 的 `always` 把内容挂到
 * overlay 层，面板不可见时只 hidden/pointer-events:none，不卸载组件。
 */
export function openTerminalPanel(a: DockviewApi): void {
  try {
    const cwd = pickTerminalCwd(sessionCatalog.getState())
    const baseTitle = terminalProjectName(cwd) ?? OPEN_KIND_PANEL.terminal.title
    const terminalPanels = a.panels.filter((p) => isTerminalPanelId(p.id))
    const usedTitles = new Set(
      terminalPanels.map((p) => (p.title ?? '').trim()).filter(Boolean),
    )
    const title = nextTerminalPanelTitle(baseTitle, usedTitles)
    const id = nextTerminalPanelId(terminalPanels.map((p) => p.id))
    a.addPanel({
      id,
      component: OPEN_KIND_PANEL.terminal.component,
      title,
      minimumWidth: RAIL_MIN_WIDTH,
      maximumWidth: RAIL_MAX_WIDTH,
      // 终端内容保持挂载（PTY 保活）——面板不可见时只 hidden，不卸载
      renderer: 'always',
      // cwd 进 params：布局存档恢复时按同一个工作目录重开（不能恢复时
      // 再回退到当前活动会话 cwd，terminal-cwd.ts 的语义）
      params: { region: 'panels', cwd },
      position: panelsDropPosition(a),
    })
    if (columnFlagsOf().panelsHidden) setPanelsHidden(false)
  } catch (e) {
    console.error('[open-page] 打开终端失败', e)
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

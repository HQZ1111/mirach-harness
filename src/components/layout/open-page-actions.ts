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
import { rootPanelsGroup } from './dockview-column-ops'

export const OPEN_KIND_PANEL: Record<OpenPageKind, { id: string; component: string; title: string }> = {
  files: { id: 'files', component: 'files', title: '文件树' },
  terminal: { id: 'terminal', component: 'terminal', title: '终端' },
  preview: { id: 'preview', component: 'preview', title: '预览' },
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
 *  console.error 可见（禁止静默假装成功）。 */
export function openPagePanel(a: DockviewApi, kind: OpenPageKind): void {
  const target = OPEN_KIND_PANEL[kind]
  try {
    const existing = a.getPanel(target.id)
    if (existing) {
      existing.api.setActive()
      return
    }
    a.addPanel({
      ...target,
      minimumWidth: 240,
      params: { region: 'panels' },
      position: panelsDropPosition(a),
    })
  } catch (e) {
    console.error('[open-page] 打开页动作失败', kind, e)
  }
}

/**
 * 「管理配置档案」页的面板 opener（hermes `navigate(PROFILES_ROUTE)` 的宿主
 * 对偶，2026-11-26）。与机器人弹出栏不同：这是主区的单例页面（列表 + 详情 +
 * SOUL 编辑），不是机器人花名册。
 */
import type { DockviewApi } from 'dockview-react'

export const PROFILES_PANEL_ID = 'profiles'

function apiOf(): DockviewApi | null {
  return (globalThis as { __dvApi?: DockviewApi }).__dvApi ?? null
}

export function openProfilesPanel(): void {
  const api = apiOf()
  if (!api) {
    console.error('[profiles] 布局 api 不在场——管理配置档案页打开放弃')
    return
  }
  const existing = api.getPanel(PROFILES_PANEL_ID)
  if (existing) {
    existing.api.setActive()
    return
  }
  try {
    api.addPanel({
      id: PROFILES_PANEL_ID,
      component: 'profiles',
      title: '配置档案',
      params: { region: 'profiles' },
      // 主区工作台的同组标签（hermes 的 profiles 路由替换主内容；宿主用标签）。
      position: { referencePanel: 'workspace', direction: 'within' },
    })
  } catch (e) {
    console.error('[profiles] 打开管理配置档案页失败', e)
  }
}

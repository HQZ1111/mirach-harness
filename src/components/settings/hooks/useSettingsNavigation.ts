// [settings] 导航 hook —— 路由解析（**去 react-router 版**，2026-10-17）。
//
// 与 openhuman 原版的差异：原版用 `useLocation/useNavigate`（settings 是
// 一个 routed page）。mirach 的 settings 是**浮层**，没有 URL 路由，
// 所以这里换成模块级 store（zustand vanilla，与仓库其它桥同款）：
//   - `currentRoute` 从 store 读；
//   - `navigateToSettings` 写 store；
//   - `navigateBack` 回 home；
//   - `closeSettings` 由宿主（浮层）注入。
// 其余（registry 驱动的 slug 解析、breadcrumbs 恒空）与原版一致。
import { useCallback } from 'react'
import { createStore, useStore } from 'zustand'

import { entryRoute, SETTINGS_ROUTE_REGISTRY } from '../settingsRouteRegistry'

type SettingsRoute = string

interface BreadcrumbItem {
  label: string
  onClick?: () => void
}

interface SettingsNavState {
  route: SettingsRoute
  /** 宿主注入的关闭回调（浮层 unmount 时置 null） */
  onClose: (() => void) | null
  setRoute: (r: SettingsRoute) => void
  setOnClose: (fn: (() => void) | null) => void
}

export const settingsNavStore = createStore<SettingsNavState>((set) => ({
  route: 'home',
  onClose: null,
  setRoute: (route) => set({ route }),
  setOnClose: (onClose) => set({ onClose }),
}))

interface SettingsNavigationHook {
  currentRoute: SettingsRoute
  navigateToSettings: (route?: SettingsRoute) => void
  navigateBack: () => void
  closeSettings: () => void
  breadcrumbs: BreadcrumbItem[]
}

/** slug → registry id（与 openhuman 同款：先精确 id，再 route 别名）。 */
export function resolveSettingsRoute(slug: string): SettingsRoute {
  const firstSegment = slug.split('/').filter(Boolean)[0] ?? 'home'
  const byId = SETTINGS_ROUTE_REGISTRY.find((e) => e.id === firstSegment)
  if (byId) return byId.id
  const byRoute = SETTINGS_ROUTE_REGISTRY.find((e) => entryRoute(e) === firstSegment)
  if (byRoute) return byRoute.id
  return 'home'
}

export const useSettingsNavigation = (): SettingsNavigationHook => {
  const currentRoute = useStore(settingsNavStore, (s) => s.route)

  const navigateToSettings = useCallback((route: SettingsRoute = 'home') => {
    settingsNavStore.getState().setRoute(resolveSettingsRoute(route))
  }, [])

  const navigateBack = useCallback(() => {
    settingsNavStore.getState().setRoute('home')
  }, [])

  const closeSettings = useCallback(() => {
    // 浮层：关闭 = 通知宿主 unmount（无 URL 可退）
    const onClose = settingsNavStore.getState().onClose
    if (onClose) onClose()
    else settingsNavStore.getState().setRoute('home')
  }, [])

  // 两栏侧栏取代面包屑后，字段保留但恒空（与 openhuman 现状一致）
  const breadcrumbs: BreadcrumbItem[] = []

  return { currentRoute, navigateToSettings, navigateBack, closeSettings, breadcrumbs }
}

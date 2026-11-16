/** hermes `store/sidebar-nav.ts` 的最小对偶（SDK 只取常量或类型）。 */
import { atom } from 'nanostores'

/** 通用状态原子（宿主对应能力未接时为空）。 */
export const $sidebarNav = atom<Record<string, unknown>>({})

/** 上游 `setSidebarSessionOrderManual` 的宿主对偶（未接线时为空实现，见文件头注释）。 */
export const setSidebarSessionOrderManual = (_v: unknown): void => {}

/** 上游 `setSidebarSessionOrderIds` 的宿主对偶（未接线时为空实现，见文件头注释）。 */
export const setSidebarSessionOrderIds = (_ids: string[]): void => {}

/** 上游 `setShowAllProfiles` 的宿主对偶（未接线时为空实现，见文件头注释）。 */
export const setShowAllProfiles = (_v: boolean): void => {}

/** 上游 `SIDEBAR_NAV_PREFS_AREA` 的宿主对偶（未接线时为空实现，见文件头注释）。 */
export const SIDEBAR_NAV_PREFS_AREA: string = "sidebar.nav.prefs"

/** 上游 `SidebarNavPrefsContribution` 的宿主对偶（未接线时为空实现，见文件头注释）。 */
export const SidebarNavPrefsContribution: unknown = null

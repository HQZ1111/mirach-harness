/** hermes `store/tabstrip-prefs.ts` 的最小对偶（SDK 只取常量或类型）。 */
import { atom } from 'nanostores'

/** 通用状态原子（宿主对应能力未接时为空）。 */
export const $tabstripPrefs = atom<Record<string, unknown>>({})

/** 上游 `$tabStripDefault` 的宿主对偶（无对应能力时为空）。 */
export const $tabStripDefault = atom<unknown>(null)

/** 上游 `$composerPopoutGesturesEnabled` 的宿主对偶（无对应能力时为空）。 */
export const $composerPopoutGesturesEnabled = atom<unknown>(null)

/** 上游 `setTabStripDefault` 的宿主对偶（未接线时为空实现，见文件头注释）。 */
export const setTabStripDefault = (_v: unknown): void => {}

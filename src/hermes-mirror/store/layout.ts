/** hermes `store/layout.ts` 的最小对偶（SDK 只取常量或类型）。 */
import { atom } from 'nanostores'

/** 通用状态原子（宿主对应能力未接时为空）。 */
export const $layout = atom<Record<string, unknown>>({})

/** 上游 `TabStripDefault` 的宿主对偶（未接线时为空实现，见文件头注释）。 */
export const TabStripDefault: unknown = null

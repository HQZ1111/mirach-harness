/** hermes `store/intro-splash.ts` 的最小对偶（SDK 只取常量或类型）。 */
import { atom } from 'nanostores'

/** 通用状态原子（宿主对应能力未接时为空）。 */
export const $introSplash = atom<Record<string, unknown>>({})

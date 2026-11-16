/** hermes `store/reasoning-disclosure.ts` 的最小对偶（SDK 只取常量或类型）。 */
import { atom } from 'nanostores'

/** 通用状态原子（宿主对应能力未接时为空）。 */
export const $reasoningDisclosure = atom<Record<string, unknown>>({})

/** 上游 `$reasoningCollapsedByDefault` 的宿主对偶（无对应能力时为空）。 */
export const $reasoningCollapsedByDefault = atom<unknown>(null)

/** 上游 `setReasoningCollapsedByDefault` 的宿主对偶（未接线时为空实现，见文件头注释）。 */
export const setReasoningCollapsedByDefault = (_v: boolean): void => {}

/** 上游 `DEFAULT_REASONING_EFFORT` 的宿主对偶（未接线时为空实现，见文件头注释）。 */
export const DEFAULT_REASONING_EFFORT: string = "medium"

/** 上游 `REASONING_EFFORTS` 的宿主对偶（未接线时为空实现，见文件头注释）。 */
export const REASONING_EFFORTS: readonly string[] = ["off","low","medium","high","xhigh","max"]

/** 上游 `REASONING_EFFORT_VALUES` 的宿主对偶（未接线时为空实现，见文件头注释）。 */
export const REASONING_EFFORT_VALUES: readonly string[] = ["off","low","medium","high","xhigh","max"]

/** 上游 `ReasoningEffort` 的宿主对偶（未接线时为空实现，见文件头注释）。 */
export const ReasoningEffort: string = "medium"

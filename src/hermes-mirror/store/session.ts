/**
 * 会话状态原子（hermes `store/session.ts` 的**最小对偶**）。
 *
 * ## 为什么只保留这几个导出
 *
 * 上游这个文件有 1,981 行（会话状态机、tile 管理、pin、颜色覆盖…）。
 * 上游 SDK 只从它取 5 个东西：
 *
 * - `$activeSessionId` —— 活动会话运行时 id
 * - `$selectedStoredSessionId` —— 选中会话的存储 id
 * - `ownerLookupSessionRows()` / `sessionMatchesStoredId()` / `sessionPinId()`
 *   —— 会话行的身份匹配
 *
 * 宿主（Mirach）的会话由 `sessionCatalog`（zustand）管。这里用轻量 atom
 * 承担同形接口，**不复制上游的状态机**——那属于「移植 hermes 运行态」，
 * 不是「移植 bots」。
 */
import { atom } from 'nanostores'

import { $hostActiveSessionId, $hostFocusedStoredSessionId } from '@/sdk/host'

/** 活动会话运行时 id（转发 SDK host.state，保证同一份真相）。 */
export const $activeSessionId = $hostActiveSessionId

/** 选中会话的存储 id。 */
export const $selectedStoredSessionId = $hostFocusedStoredSessionId

/** 会话行（上游 `SessionListRow` 的宿主形态）。 */
export interface SessionRow {
  storedSessionId: string
  name?: null | string
  profile?: null | string
  running?: boolean
  pinned?: boolean
}

/** 会话行名册（宿主由 sessionCatalog 同步进来）。 */
export const $sessionRows = atom<SessionRow[]>([])

/** 按 owner（profile）筛行。 */
export function ownerLookupSessionRows(profile?: null | string): SessionRow[] {
  const rows = $sessionRows.get()
  if (!profile) return rows
  return rows.filter((row) => row.profile === profile)
}

/** 某行是否匹配给定存储 id。 */
export function sessionMatchesStoredId(row: SessionRow, storedSessionId: null | string): boolean {
  return Boolean(storedSessionId) && row.storedSessionId === storedSessionId
}

/** 行的 pin 标识（上游用存储 id 作为 pin 键）。 */
export function sessionPinId(row: SessionRow): string {
  return row.storedSessionId
}

/** 上游 `pinSession` 的宿主对偶（未接线时为空实现，见文件头注释）。 */
export const pinSession = (_id: string): void => {}

/** 上游 `unpinSession` 的宿主对偶（未接线时为空实现，见文件头注释）。 */
export const unpinSession = (_id: string): void => {}

/** 上游 `setPinnedSessionOrder` 的宿主对偶（未接线时为空实现，见文件头注释）。 */
export const setPinnedSessionOrder = (_ids: string[]): void => {}

/** 上游 `setResumeExhaustedSessionId` 的宿主对偶（未接线时为空实现，见文件头注释）。 */
export const setResumeExhaustedSessionId = (_id: null | string): void => {}

/**
 * `@/store/activity` shim - the desktop action registry.
 *
 * Upstream records background-action rows (hub installs, updates) so a toast can
 * link to a live log; the row type is the backend ActionStatusResponse. The
 * capabilities page calls this after an install attempt - which on this host
 * cannot start (no Skills Hub), so nothing writes here today. The store stays so
 * the mirrored code compiles and any future action source has a home.
 */

import { atom } from 'nanostores'

import type { ActionStatusResponse } from '@/hermes-mirror/types/hermes'

export type DesktopActionTask = ActionStatusResponse

export const $desktopActionTasks = atom<DesktopActionTask[]>([])

export function upsertDesktopActionTask(task: DesktopActionTask): void {
  const next = $desktopActionTasks.get().filter((entry) => entry.name !== task.name)
  $desktopActionTasks.set([task, ...next])
}

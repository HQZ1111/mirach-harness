/** 通知（hermes `store/notifications.ts` 的最小对偶）。 */
import { atom } from 'nanostores'

export interface HostNotification {
  id: string
  kind?: string
  message: string
}

/** 通知队列（宿主由外壳消费）。 */
export const $notifications = atom<HostNotification[]>([])

/** 普通通知。 */
export function notify(input: { kind?: string; message: string }): void {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  $notifications.set([...$notifications.get(), { id, kind: input.kind, message: input.message }])
  console.log(`[notify] ${input.message}`)
}

/** 错误通知（上游双参）。 */
export function notifyError(error: unknown, message?: string): void {
  const text = message ?? (error instanceof Error ? error.message : String(error))
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  $notifications.set([...$notifications.get(), { id, kind: 'error', message: text }])
  console.error(`[notify:error] ${text}`, error)
}

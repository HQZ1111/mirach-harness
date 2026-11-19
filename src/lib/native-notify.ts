/**
 * OS 通知派发（hermes `store/native-notifications.ts` 的宿主对偶）。
 *
 * 偏好 = `notification-prefs.ts`（localStorage，主窗与设置窗同源共享）。
 * 派发闸门照 hermes：
 * - `approval` / `input` 是「需要人」的阻塞提示：窗口失焦，或该请求不属于
 *   当前会话时也亮；
 * - 其余（回合完成 / 出错 / 后台任务完成）只在窗口失焦且属于当前会话时亮，
 *   避免后台会话每个回合都弹一条；
 * - 启动后 4s 静默窗（重连回放不会弹通知）；
 * - 同 kind+会话 1s 节流。
 *
 * 投递端 = Rust `pi_notify`（notify-rust；Windows 默认静音，非 silent 才指定
 * Default 声音）。失败只 console.error，不影响会话链路。
 */
import { invoke } from '@tauri-apps/api/core'

import { hapticsMuted } from './completion-sound'
import { readNotifyPrefs, type NotificationKind } from './notification-prefs'

const SEED_QUIET_MS = 4_000
const THROTTLE_MS = 1_000

let quietUntil = 0
const lastFiredAt = new Map<string, number>()

/** 应用启动（或重连回放开始）时打开静默窗。 */
export function markNativeNotifyBaseline(now = Date.now()): void {
  quietUntil = now + SEED_QUIET_MS
}

export interface NativeNotifyInput {
  kind: NotificationKind
  title: string
  body?: string
  /** 事件所属会话（活动会话 id）；会话级提示用。 */
  sessionId?: null | string
  /** 当前活动会话 id；与 sessionId 相同才算「当前会话」。 */
  activeSessionId?: null | string
  /** 与具体会话无关的提示（如全局后台任务）：失焦即亮。 */
  global?: boolean
  /** 节流键补充（无会话提示用）。 */
  tag?: string
}

function isBackgrounded(): boolean {
  if (typeof document === 'undefined') return false
  if (document.hidden) return true
  return typeof document.hasFocus === 'function' && !document.hasFocus()
}

function shouldFire(input: NativeNotifyInput): boolean {
  if (input.global) return isBackgrounded()
  const attention = input.kind === 'approval' || input.kind === 'input'
  if (attention) {
    return (
      isBackgrounded() ||
      (typeof input.sessionId === 'string' &&
        input.sessionId !== '' &&
        input.sessionId !== input.activeSessionId)
    )
  }
  return (
    isBackgrounded() &&
    typeof input.sessionId === 'string' &&
    input.sessionId !== '' &&
    input.sessionId === input.activeSessionId
  )
}

/** 返回是否真的投递（被偏好/闸门/节流拦下 = false）。 */
export function dispatchNativeNotification(input: NativeNotifyInput, now = Date.now()): boolean {
  const prefs = readNotifyPrefs()
  if (!prefs.enabled || !prefs.kinds[input.kind]) return false
  if (now < quietUntil) return false
  if (!shouldFire(input)) return false

  const key = `${input.kind}:${input.sessionId ?? input.tag ?? (input.global ? 'global' : '')}`
  for (const [seen, at] of lastFiredAt) {
    if (now - at >= THROTTLE_MS) lastFiredAt.delete(seen)
  }
  if (lastFiredAt.has(key)) return false
  lastFiredAt.set(key, now)

  void invoke<boolean>('pi_notify', {
    title: input.title,
    body: input.body ?? '',
    silent: hapticsMuted(),
  }).catch((error) => console.error('[notifications] 系统通知发送失败', error))
  return true
}
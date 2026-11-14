/**
 * 通知偏好（hermes store/native-notifications.ts 的移植，2026-10-24）。
 *
 * 持久化 = localStorage（hermes 同语义：`lib/storage.ts` 的
 * persistString/readKey → localStorage；harness 的设置页/主窗同源
 * `127.0.0.1:1430`，两窗共享同一份偏好）。
 *
 * 键名换 mirach 前缀（hermes: → mirach:），值形状保持一致：
 *   · `mirach:native-notifications` = JSON `{enabled, kinds{...}}`
 *   · 七类事件开关全部默认 true（hermes NATIVE_NOTIFICATION_KINDS 同表）
 *
 * 派发端（会话事件 → OS 通知）尚未接线（pi 事件 → 通知卡的管线在
 * message-queue 一轮）——本模块当前只服务设置页的读写与测试按钮，
 * 键位/形状与未来派发端共用。
 */

const PREFS_KEY = 'mirach:native-notifications'

/** 通知事件种类（hermes NATIVE_NOTIFICATION_KINDS 同表；顺序即展示序）。 */
export const NOTIFICATION_KINDS = [
  'approval',
  'input',
  'turnDone',
  'turnError',
  'backgroundDone',
  'credits',
  'plugin',
] as const

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number]

const KIND_DEFAULT: Record<NotificationKind, boolean> = {
  approval: true,
  input: true,
  turnDone: true,
  turnError: true,
  backgroundDone: true,
  credits: true,
  plugin: true,
}

export interface NativeNotifyPrefs {
  enabled: boolean
  kinds: Record<NotificationKind, boolean>
}

const DEFAULT_PREFS: NativeNotifyPrefs = { enabled: true, kinds: { ...KIND_DEFAULT } }

function normalize(raw: unknown): NativeNotifyPrefs {
  if (typeof raw !== 'object' || raw === null) return { ...DEFAULT_PREFS, kinds: { ...KIND_DEFAULT } }
  const obj = raw as { enabled?: unknown; kinds?: unknown }
  const kinds = { ...KIND_DEFAULT }
  if (typeof obj.kinds === 'object' && obj.kinds !== null) {
    for (const kind of NOTIFICATION_KINDS) {
      const v = (obj.kinds as Record<string, unknown>)[kind]
      if (typeof v === 'boolean') kinds[kind] = v
    }
  }
  return { enabled: obj.enabled !== false, kinds }
}

/** 读偏好。坏 JSON / 缺键 → 默认值（hermes 同语义：损坏偏好回默认）。 */
export function readNotifyPrefs(): NativeNotifyPrefs {
  try {
    const raw = window.localStorage.getItem(PREFS_KEY)
    if (raw === null) return { ...DEFAULT_PREFS, kinds: { ...KIND_DEFAULT } }
    return normalize(JSON.parse(raw))
  } catch (e) {
    console.error('[notifications] 偏好读取失败——按默认值处理', e)
    return { ...DEFAULT_PREFS, kinds: { ...KIND_DEFAULT } }
  }
}

function writePrefs(prefs: NativeNotifyPrefs): void {
  try {
    window.localStorage.setItem(PREFS_KEY, JSON.stringify(prefs))
    // 同源多窗（主窗 + 设置窗）跨窗同步：storage 事件由浏览器派发，
    // 同窗监听者用这个手工事件（hermes PersistenceEvent 同语义）。
    window.dispatchEvent(new Event('mirach:notify-prefs-changed'))
  } catch (e) {
    console.error('[notifications] 偏好写入失败', e)
    throw e
  }
}

export function setNotifyEnabled(enabled: boolean): NativeNotifyPrefs {
  const next = { ...readNotifyPrefs(), enabled }
  writePrefs(next)
  return next
}

export function setNotifyKind(kind: NotificationKind, value: boolean): NativeNotifyPrefs {
  const prefs = readNotifyPrefs()
  const next: NativeNotifyPrefs = {
    ...prefs,
    kinds: { ...prefs.kinds, [kind]: value },
  }
  writePrefs(next)
  return next
}

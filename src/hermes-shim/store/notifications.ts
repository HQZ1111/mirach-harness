/**
 * `@/store/notifications` shim — the toast surface.
 *
 * Upstream keeps an `AppNotification[]` nanostore rendered by
 * `components/notifications.tsx` (a CardStack). The behaviour kept verbatim: the
 * error-summary rule table, disk-full detection, placement defaulting (errors and
 * actionable toasts interrupt; routine confirmations go bottom-right), timer
 * bookkeeping, and `readableError`'s error unwrapping.
 *
 * Changed:
 *   - `RECOVERY_ACTIONS` — upstream navigates to /settings?tab=… and restarts the
 *     hermes backend. This host has its own settings window and no backend
 *     process, so each action opens that window or states the limit in the
 *     console. No action silently does nothing.
 *   - the desktop-log sink — upstream ships errors to the Electron main's log
 *     file; this host logs to the console, the visible sink (rule 12).
 */

import { atom } from 'nanostores'

import { translateNow } from '@/hermes-mirror/i18n'
import { isOutOfSyncRpcParams } from '@/hermes-shim/lib/gateway-rpc'
import { isTimeoutError } from '@/hermes-shim/lib/with-timeout'
import { type ErrorToastCategory, recordFriction } from '@/hermes-shim/store/desktop-metrics'

export type NotificationKind = 'error' | 'warning' | 'info' | 'success'

export interface NotificationAction {
  label: string
  onClick: () => void
}

export type NotificationPlacement = 'default' | 'bottom-right'

export interface AppNotification {
  accentColor?: string
  action?: NotificationAction
  createdAt: number
  detail?: string
  icon?: string
  id: string
  kind: NotificationKind
  message: string
  meta?: string
  onDismiss?: () => void
  persistent?: boolean
  placement?: NotificationPlacement
  secondaryAction?: NotificationAction
  title?: string
}

export interface NotificationInput {
  accentColor?: string
  action?: NotificationAction
  detail?: string
  durationMs?: number
  icon?: string
  id?: string
  kind?: NotificationKind
  message: string
  meta?: string
  onDismiss?: () => void
  persistent?: boolean
  placement?: NotificationPlacement
  secondaryAction?: NotificationAction
  title?: string
}

let notificationCounter = 0
const timers = new Map<string, number>()

export const $notifications = atom<AppNotification[]>([])

function defaultDuration(kind: NotificationKind) {
  if (kind === 'error' || kind === 'warning') {
    return 0
  }

  return 5_000
}

function defaultPlacement(kind: NotificationKind, action?: NotificationAction): NotificationPlacement {
  if (kind === 'error' || kind === 'warning' || action) {
    return 'default'
  }

  return 'bottom-right'
}

function cleanErrorText(value: string) {
  return value.replace(/^Error:\s*/, '').trim()
}

/** True when an error string is a disk-full / ENOSPC / SQLITE_FULL failure. */
export function isDiskFullErrorMessage(message: string): boolean {
  return (
    /no space left on device/i.test(message) ||
    /not enough space/i.test(message) ||
    /database or disk is full/i.test(message) ||
    /\bENOSPC\b/i.test(message) ||
    /disk full/i.test(message) ||
    /full disk/i.test(message)
  )
}

/** Open the host's settings window on a section. The Rust side owns the window;
 *  this is the only settings entry the renderer has. */
async function openHostSettings(section: string): Promise<void> {
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('pi_open_settings_window', { section })
  } catch (err) {
    console.error('[notifications] 打开设置窗口失败', section, err)
  }
}

export const RECOVERY_ACTIONS = {
  openGateways: (): NotificationAction => ({
    label: translateNow('notifications.actions.openGateways'),
    onClick: () => void openHostSettings('gateway')
  }),
  openKeys: (_envKey: string): NotificationAction => ({
    label: translateNow('notifications.actions.openKeys'),
    onClick: () => void openHostSettings('providers')
  }),
  openMaintenance: (): NotificationAction => ({
    label: translateNow('notifications.actions.openMaintenance'),
    onClick: () => void openHostSettings('about')
  }),
  openUpdates: (): NotificationAction => ({
    label: translateNow('notifications.updateHermes'),
    onClick: () => console.warn('[notifications] 更新窗口未接入本宿主')
  }),
  restartHermes: (): NotificationAction => ({
    label: translateNow('notifications.actions.restartHermes'),
    onClick: () => console.warn('[notifications] pi 在进程内运行，没有可重启的后端进程')
  })
}

const STORAGE_CODE_RE = /['"]code['"]\s*:\s*['"](storage_[a-z_]+|disk_full)['"]/i

interface ErrorSummaryRule {
  action?: (msg: string) => NotificationAction
  category: ErrorToastCategory
  summarize: (msg: string) => string
  test: (msg: string) => boolean
}

const ERROR_SUMMARIES: ErrorSummaryRule[] = [
  {
    // Disk full / ENOSPC — match before generic truncation so the user gets a
    // clear "free space" message instead of a raw errno dump.
    action: () => RECOVERY_ACTIONS.openMaintenance(),
    category: 'disk_full',
    summarize: () => translateNow('notifications.errors.diskFull'),
    test: isDiskFullErrorMessage
  },
  {
    // Any other classified storage failure (locked, corrupt, read-only …).
    action: () => RECOVERY_ACTIONS.openMaintenance(),
    category: 'storage_failure',
    summarize: () => translateNow('notifications.errors.storageFailure'),
    test: msg => STORAGE_CODE_RE.test(msg)
  },
  {
    action: () => RECOVERY_ACTIONS.openGateways(),
    category: 'gateway_auth_failed',
    summarize: () => translateNow('notifications.errors.gatewayAuthFailed'),
    test: msg => /['"]code['"]\s*:\s*['"]gateway_auth_failed['"]/i.test(msg)
  },
  {
    action: () => RECOVERY_ACTIONS.openKeys('OPENAI_API_KEY'),
    category: 'api_key_rejected',
    summarize: () => translateNow('notifications.errors.openaiRejectedApiKey'),
    test: msg => /incorrect api key provided/i.test(msg) || /['"]code['"]\s*:\s*['"]invalid_api_key['"]/i.test(msg)
  },
  {
    action: () => RECOVERY_ACTIONS.openKeys('OPENAI_API_KEY'),
    category: 'api_key_missing',
    summarize: () => translateNow('notifications.errors.openaiTtsNeedsKey'),
    test: msg => /neither voice_tools_openai_key nor openai_api_key is set/i.test(msg)
  },
  {
    action: () => RECOVERY_ACTIONS.openKeys('ELEVENLABS_API_KEY'),
    category: 'api_key_missing',
    summarize: () => translateNow('notifications.errors.elevenLabsNeedsKey'),
    test: msg => /ELEVENLABS_API_KEY not set/i.test(msg)
  },
  {
    action: () => RECOVERY_ACTIONS.openKeys('ELEVENLABS_API_KEY'),
    category: 'api_key_rejected',
    summarize: () => translateNow('notifications.errors.elevenLabsRejectedKey'),
    test: msg => /ElevenLabs STT API error \(HTTP 401\)/i.test(msg)
  },
  {
    action: () => RECOVERY_ACTIONS.restartHermes(),
    category: 'method_not_allowed',
    summarize: () => translateNow('notifications.errors.methodNotAllowed'),
    test: msg => /method not allowed/i.test(msg)
  },
  {
    category: 'microphone_permission',
    summarize: () => translateNow('notifications.errors.microphonePermission'),
    test: msg => /microphone permission/i.test(msg)
  },
  {
    action: () => RECOVERY_ACTIONS.openUpdates(),
    category: 'rpc_out_of_sync',
    summarize: () => translateNow('notifications.errors.rpcOutOfSync'),
    test: msg => isOutOfSyncRpcParams(msg)
  },
  {
    action: () => RECOVERY_ACTIONS.restartHermes(),
    category: 'restart_required',
    summarize: () => translateNow('notifications.errors.codeSkewRestartRequired'),
    test: msg => /Restart required:/i.test(msg)
  }
]

function summarizeErrorMessage(message: string, fallback: string) {
  const rule = ERROR_SUMMARIES.find(r => r.test(message))

  if (rule) {
    return { action: rule.action?.(message), category: rule.category, message: rule.summarize(message) }
  }

  return {
    action: undefined,
    category: 'unclassified' as const,
    message: message.length > 180 ? fallback : message || fallback
  }
}

function staleRewindRefusal(error: unknown): 'compacted' | 'stale' | null {
  const data = error && typeof error === 'object' ? (error as { data?: unknown }).data : undefined

  if (!data || typeof data !== 'object') {
    return null
  }

  const { detail, field, reason } = data as { detail?: unknown; field?: unknown; reason?: unknown }

  if (reason !== 'invalid_params' || field !== 'target_message_id') {
    return null
  }

  return typeof detail === 'string' && detail.startsWith('compacted:') ? 'compacted' : 'stale'
}

/** Reused by flows that surface errors inline (ConfirmDialog's rethrow, …). */
export function readableError(
  error: unknown,
  fallback: string
): { action?: NotificationAction; category: ErrorToastCategory; detail?: string; message: string } {
  const staleRewind = staleRewindRefusal(error)

  if (staleRewind) {
    const key = staleRewind === 'compacted' ? 'compactedTurnUnavailable' : 'staleTurnUnavailable'

    return { category: 'other', message: translateNow(`promptNotices.${key}`) }
  }

  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : fallback
  const unwrapped = raw.match(/Error invoking remote method '[^']+': Error: (.+)$/)?.[1] ?? raw
  const cleaned = cleanErrorText(unwrapped)
  const detail = cleaned.match(/"detail"\s*:\s*"([^"]+)"/)?.[1] ?? cleaned
  const summary = summarizeErrorMessage(detail, fallback)

  return {
    action: summary.action,
    category: summary.category,
    detail: detail === summary.message ? undefined : detail,
    message: summary.message
  }
}

export function notify(input: NotificationInput): string {
  return showNotification(input, input.kind === 'error' ? 'other' : null)
}

function showNotification(input: NotificationInput, errorCategory: ErrorToastCategory | null): string {
  const kind = input.kind ?? 'info'

  if (errorCategory) {
    recordFriction('error_toast', errorCategory)
  }

  const id = input.id ?? `${Date.now()}-${notificationCounter++}`

  const notification: AppNotification = {
    accentColor: input.accentColor,
    action: input.action,
    createdAt: Date.now(),
    detail: input.detail,
    icon: input.icon,
    id,
    kind,
    message: input.message,
    meta: input.meta,
    onDismiss: input.onDismiss,
    persistent: input.persistent,
    placement: input.placement ?? defaultPlacement(kind, input.action),
    secondaryAction: input.secondaryAction,
    title: input.title
  }

  window.clearTimeout(timers.get(id))
  timers.delete(id)
  // Visual depth is capped by CardStack, not by discarding queued notifications.
  $notifications.set([notification, ...$notifications.get().filter(item => item.id !== id)])

  const duration = input.durationMs ?? defaultDuration(kind)

  if (duration > 0) {
    timers.set(id, window.setTimeout(() => dismissNotification(id), duration))
  }

  return id
}

/** Upstream ships errors to the Electron main's log file. This host has no such
 *  bridge; the console is the visible sink (rule 12). */
function logErrorToConsole(error: unknown, fallback: string): void {
  const raw: string =
    error instanceof Error ? (error.stack ?? error.message) : typeof error === 'string' ? error : fallback
  console.error(`[toast] ${fallback}: ${raw}`)
}

export function notifyError(
  error: unknown,
  fallback: string,
  options: { action?: NotificationAction; id?: string } = {}
): string {
  const readable = readableError(error, fallback)
  logErrorToConsole(error, fallback)

  const category: ErrorToastCategory =
    readable.category === 'unclassified' && isTimeoutError(error) ? 'timeout' : readable.category

  return showNotification(
    {
      action: options.action ?? readable.action,
      id: options.id,
      kind: 'error',
      message: readable.message,
      detail: readable.detail,
      title: fallback
    },
    category
  )
}

export function dismissNotification(id: string) {
  window.clearTimeout(timers.get(id))
  timers.delete(id)
  const dismissed = $notifications.get().find(item => item.id === id)
  $notifications.set($notifications.get().filter(item => item.id !== id))
  dismissed?.onDismiss?.()
}

export function clearNotifications() {
  const all = $notifications.get()
  const cleared = all.filter(item => !item.persistent)
  $notifications.set(all.filter(item => item.persistent))

  for (const item of cleared) {
    window.clearTimeout(timers.get(item.id))
    timers.delete(item.id)
    item.onDismiss?.()
  }
}

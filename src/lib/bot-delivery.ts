/**
 * bot 投递核心（2026-11-18）：`message_agent` 的本地直投与 relay
 * `bot_relay.deliver` 门共用同一套"目标会话起一轮、等终局、取回复"的流程。
 *
 * 两侧语义（都对照 hermes 上游）：
 * - **本地直投**（engine-bridges 的 message_agent 路径）= hermes 的 local
 *   delivery runner：同网关 bot 互发不经过 envelope/relay 循环，直接进目标
 *   Bot Chat 跑一轮；回复再由调用方送回发送者会话。
 * - **relay 门**（host-rpc 的 `bot_relay.deliver`）= hermes 网关
 *   `gateway/session_bot.py::_deliver`：把 envelope 收成一轮、锁内幂等
 *   （同一 id 只跑一次）、终局回执带 reply/error/reason 交给 Desktop。
 *   幂等靠 `pi_relay_get_receipt`/`pi_relay_record_receipt`（回执落
 *   claimed/<id>.json，drain 重投时命中即返回同一回执）。
 *
 * 不 import host-rpc（避免环）：请求面由调用方以 `HostRequest` 注入。
 */

import { botsStore, type BotPreset } from '@/components/panes/hub/bots-store'

export type HostRequest = <T = unknown>(
  method: string,
  params?: Record<string, unknown>,
) => Promise<T>

async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<T>(cmd, args)
}

export function findBotByName(target: string): BotPreset | null {
  const needle = target.trim().toLowerCase()
  if (!needle) return null
  const bots = botsStore.getState().bots
  return (
    bots.find((bot) => bot.name.toLowerCase() === needle) ??
    bots.find((bot) => (bot.title ?? '').toLowerCase() === needle) ??
    null
  )
}

export function botBySession(sessionId: string | undefined): BotPreset | null {
  if (!sessionId) return null
  return botsStore.getState().bots.find((bot) => bot.chatSessionId === sessionId) ?? null
}

/** 等 bot 泳道会话空闲（轮询 session.resume 的 running；超时 = 明确错误）。 */
export async function waitUntilIdle(
  request: HostRequest,
  sessionId: string,
  profile: string,
  deadlineMs: number,
): Promise<void> {
  for (;;) {
    const state = await request<{ running?: boolean }>('session.resume', {
      session_id: sessionId,
      profile,
      omit_messages: true,
    })
    if (!state?.running) return
    if (Date.now() > deadlineMs) {
      throw new Error(`等待会话 ${sessionId} 空闲超时`)
    }
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
}

/** 提交一轮并等终局，返回最后一条 assistant 文本（失败行 → 抛错）。 */
export async function runBotTurn(
  request: HostRequest,
  sessionId: string,
  profile: string,
  text: string,
): Promise<string> {
  const before = await request<{
    messages?: { role?: string; text?: string; content?: string }[]
  }>('session.resume', { session_id: sessionId, profile })
  const baseline = Array.isArray(before?.messages) ? before.messages.length : 0
  await request('prompt.submit', { session_id: sessionId, text, profile })
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 2000))
    const state = await request<{
      running?: boolean
      messages?: { role?: string; text?: string; content?: string; display_kind?: string }[]
    }>('session.resume', { session_id: sessionId, profile })
    if (state?.running) continue
    const fresh = (state?.messages ?? []).slice(baseline)
    const failure = fresh.find((row) => row.display_kind === 'failed_turn')
    if (failure) {
      throw new Error(failure.text || failure.content || '成员轮次失败（无详情）')
    }
    const texts = fresh
      .filter((row) => row.role === 'assistant')
      .map((row) => String(row.text ?? row.content ?? '').trim())
      .filter(Boolean)
    return texts[texts.length - 1] ?? ''
  }
}

// ── relay 门：bot_relay.deliver（本机目标）──────────────────────────────────

export interface RelayDeliverParams {
  id: string
  profile: string
  message: string
  from_profile?: string
  from_handle?: string
  from_connection?: string
}

export interface RelayDeliverReceipt {
  status: 'settled' | 'failed'
  delivery_id: string
  session_id?: string
  /** Desktop 的 settle 判定要求 `delivery_id === envelopeId` 且本字段存在
   *  （或 `refused:true`）——「回执必须指名一次准入」。缺了它 Desktop 会把
   *  整个回执当"身份不可用"保留重投（实测：不写回信 + 无限重跑）。 */
  admission_id?: string
  /** 未准入即拒绝（unknown_profile / no_bot_chat 等，终局 failed）。 */
  refused?: true
  reply?: string
  error?: string
  reason?: string
}

const RELAY_DELIVER_TURN_WAIT_MS = 120_000

// ── 未收尾投递清单（hermes `bot_delivery.list` 的宿主对偶）───────────────────
//
// 上游由网关按目标 profile 的投递回执回答「这个 bot 还有哪些 message_agent
// 没落地」；宿主没有网关，投递由前端 engine-bridges 发起并在这里登记。
// **只登记真正在跑的投递**：settle 即删，失败保留（UI 可忽略）；窗口重启后
// 内存表清空 = 没有可证明的未收尾投递，不编造持久记录。

export type HostDeliveryState = 'claimed' | 'failed' | 'queued' | 'waiting_on_you' | 'working'

/** 与上游 `teammate-waits.tsx::TeammateDelivery` 同形（`since` = Unix 秒）。 */
export interface HostDeliveryRow {
  delivery_id: string
  target: string
  target_handle: string
  state: HostDeliveryState
  since: number
  preview: string
  waiting_on?: null | string
  reason?: null | string
  error?: null | string
}

interface TrackedDelivery extends HostDeliveryRow {
  /** 发起投递的 bot profile（`bot_delivery.list` 的过滤键）。 */
  from_profile: string
}

const activeDeliveries = new Map<string, TrackedDelivery>()

/** 上游 `tools/bot_delivery_status.py`: PREVIEW_CHARS / FAILED_VISIBLE_SECONDS. */
const DELIVERY_PREVIEW_CHARS = 140
const DELIVERY_FAILED_VISIBLE_SECONDS = 24 * 3600

/** 上游 `_preview`：摘掉投递签名、折叠空白、截到 140 字。 */
function deliveryPreview(message: string): string {
  let text = message
  const marker = text.indexOf('): ')
  if (marker >= 0 && text.startsWith('Message from ')) {
    text = text.slice(marker + 3)
  }
  text = text.split(/\s+/).filter(Boolean).join(' ')
  return text.length <= DELIVERY_PREVIEW_CHARS
    ? text
    : text.slice(0, DELIVERY_PREVIEW_CHARS - 1) + '…'
}

export function trackDeliveryStart(input: {
  id: string
  fromProfile: string
  target: string
  targetHandle?: string
  message: string
}): void {
  const id = String(input.id ?? '').trim()
  if (!id) return
  activeDeliveries.set(id, {
    delivery_id: id,
    from_profile: String(input.fromProfile ?? '').trim(),
    target: String(input.target ?? '').trim(),
    target_handle: String(input.targetHandle ?? input.target ?? '').trim(),
    state: 'queued',
    since: Math.floor(Date.now() / 1000),
    preview: deliveryPreview(String(input.message ?? '').trim()),
  })
}

export function trackDeliveryState(id: string, state: HostDeliveryState): void {
  const row = activeDeliveries.get(id)
  if (row) row.state = state
}

export function trackDeliverySettled(id: string): void {
  activeDeliveries.delete(id)
}

export function trackDeliveryFailed(id: string, error: string, reason = 'unknown'): void {
  const row = activeDeliveries.get(id)
  if (!row) return
  row.state = 'failed'
  row.reason = reason
  row.error = error
  // 上游 since = 回执最后一次写入（失败态即失败时刻），失败行可见 24h。
  row.since = Math.floor(Date.now() / 1000)
}

/** 某个 bot 发起、尚未 settle 的投递（上游 `bot_delivery.list` 的 rows，newest first）。 */
export function listTrackedDeliveries(profile: string): HostDeliveryRow[] {
  const wanted = String(profile ?? '').trim()
  const now = Math.floor(Date.now() / 1000)

  // 过期失败行真的删掉（不只过滤）：内存表不随运行时长增长。
  for (const [id, row] of activeDeliveries) {
    if (row.state === 'failed' && now - row.since > DELIVERY_FAILED_VISIBLE_SECONDS) {
      activeDeliveries.delete(id)
    }
  }

  const rows: HostDeliveryRow[] = []
  for (const row of activeDeliveries.values()) {
    if (wanted && row.from_profile !== wanted) continue
    // 上游 `list_sender_deliveries` 只扫本网关的本地队友回执；远端投递
    // 不在网关数据面（Desktop 的 relay 属跨机总线），宿主同样不列。
    if (!findBotByName(row.target)) continue
    const { from_profile: _from, ...visible } = row
    rows.push({ ...visible })
  }
  return rows.sort((a, b) => b.since - a.since)
}

/**
 * 上游 `delivery_state` 的 `waiting_on_you`：目标 bot 的**本投递轮**停在
 * 审批/澄清上时，strip 要写「等待你 — 请批准/回答问题」（只有一个「处理中」
 * 会让用户不知道队友被自己卡住）。
 *
 * 只对 `working` 行取目标泳道态：`waitUntilIdle` 保证交付前目标空闲，所以
 * 此刻的 pending prompt 属于本轮；`queued`/`claimed` 的 prompt（若有）属于
 * 别的轮次，不冒充。远端目标无法本地查——保持原态（如实）。
 */
export async function applyLiveDeliveryState(rows: HostDeliveryRow[]): Promise<HostDeliveryRow[]> {
  const out: HostDeliveryRow[] = []
  for (const row of rows) {
    if (row.state !== 'working') {
      out.push(row)
      continue
    }
    const target = findBotByName(row.target)
    if (!target?.chatSessionId) {
      out.push(row)
      continue
    }
    try {
      const state = await tauriInvoke<{
        open_requests?: unknown[]
        pending_approval?: unknown
      }>('pi_bot_state', { sessionId: target.chatSessionId })
      const approval = state?.pending_approval
      const hasApproval = approval !== null && approval !== undefined
      const hasClarify = Array.isArray(state?.open_requests) && state.open_requests.length > 0
      out.push(
        hasApproval
          ? { ...row, state: 'waiting_on_you', waiting_on: 'approval' }
          : hasClarify
            ? { ...row, state: 'waiting_on_you', waiting_on: 'clarify' }
            : row,
      )
    } catch (e) {
      // 状态查询失败不把整条清单变成错误：行保持上一态，错误可见。
      console.error('[bot-delivery] 读取目标泳道态失败', row.target, e)
      out.push(row)
    }
  }
  return out
}

/**
 * `bot_relay.deliver` 的宿主实现（目标 = 本机 bot）。
 *
 * 与 relay.ts 的约定：`delivery_id` 必须原样回传 envelope id、且必须带
 * `admission_id`（settle 判定的"回执指名准入"）；`status:'settled'` + `reply`
 * 会被 Desktop 经 `bot_relay.reply` 写回发送方。幂等：命中已有回执直接返回
 * （重投不重跑）；**从不在没有回执时假装已投**。
 */
export async function deliverToLocalBot(
  request: HostRequest,
  params: RelayDeliverParams,
): Promise<RelayDeliverReceipt> {
  const id = String(params.id ?? '').trim()
  if (!id) {
    return {
      status: 'failed',
      delivery_id: '',
      refused: true,
      reason: 'invalid_id',
      error: 'bot_relay.deliver 缺少 id',
    }
  }

  const finish = async (receipt: RelayDeliverReceipt): Promise<RelayDeliverReceipt> => {
    try {
      await tauriInvoke('pi_relay_record_receipt', { id, receipt })
    } catch (e) {
      // 回执落盘失败不吞：下一轮 drain 会重投（可能重跑一轮），如实可见。
      console.error('[bot-delivery] 回执落盘失败', id, e)
    }
    return receipt
  }

  const readReceipt = async (): Promise<RelayDeliverReceipt | null> => {
    const existing = await tauriInvoke<unknown>('pi_relay_get_receipt', { id }).catch((e) => {
      console.error('[bot-delivery] 读回执失败（按无回执继续）', id, e)
      return null
    })
    return existing && typeof existing === 'object' ? (existing as RelayDeliverReceipt) : null
  }

  const cached = await readReceipt()
  if (cached) return cached

  const target = findBotByName(String(params.profile ?? ''))
  if (!target) {
    return finish({
      status: 'failed',
      delivery_id: id,
      refused: true,
      reason: 'unknown_profile',
      error: `找不到机器人「${params.profile ?? ''}」`,
    })
  }
  if (!target.chatSessionId) {
    return finish({
      status: 'failed',
      delivery_id: id,
      refused: true,
      reason: 'no_bot_chat',
      error: `机器人「${target.name}」还没有 Bot Chat（先在花名册里打开一次它的聊天）`,
    })
  }

  const admissionId = `local:${target.chatSessionId}:${id}`
  const fromName = String(params.from_profile || '').trim() || 'user'
  const fromHandle = String(params.from_handle || '').trim() || fromName
  const body = `Message from 🤖 ${fromName} (@${fromHandle}): ${String(params.message ?? '').trim()}`

  try {
    await request('session.resume', {
      session_id: target.chatSessionId,
      profile: target.name,
      omit_messages: true,
    })
    await waitUntilIdle(request, target.chatSessionId, target.name, Date.now() + RELAY_DELIVER_TURN_WAIT_MS)
    // 并发重投的窄窗口兜底：等锁期间另一投递可能刚落盘回执。
    const settledElsewhere = await readReceipt()
    if (settledElsewhere) return settledElsewhere
    const reply = await runBotTurn(request, target.chatSessionId, target.name, body)
    return finish({
      status: 'settled',
      delivery_id: id,
      admission_id: admissionId,
      session_id: target.chatSessionId,
      reply,
    })
  } catch (e) {
    return finish({
      status: 'failed',
      delivery_id: id,
      admission_id: admissionId,
      reason: 'turn_failed',
      error: e instanceof Error ? e.message : String(e),
    })
  }
}

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

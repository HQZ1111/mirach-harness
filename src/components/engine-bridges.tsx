/**
 * 引擎侧宿主桥的前端半（2026-11-17）。
 *
 * 两个方向：
 * - `mirach://agent-message`：引擎 `message_agent` 工具的投递请求。前端知道
 *   bot 花名册与 canonical 会话，负责把消息送进目标 bot 的 Bot Chat、等回复、
 *   再把回复送进发送者会话（消息内容带 "Message from 🤖 …" 前缀，与 hermes
 *   的投递格式一致）。投递确认（ack）立即回给 Rust，工具只拿 ack。
 * - `mirach://approval-request`：引擎审批闸的询问。前端弹卡（允许一次/拒绝），
 *   决定回给 Rust 的 before_tool_call 门。
 *
 * 失败可见：投递失败 ack=false（模型看到工具错误）；后台段失败 console.error
 * 并保留（不静默）。没有对应 bot / 没有 canonical 会话时明确报错，不伪造投递。
 */

import { useEffect, useState } from 'react'
import { createStore, useStore } from 'zustand'

import { botBySession, findBotByName, runBotTurn, waitUntilIdle } from '@/lib/bot-delivery'
import { dispatchHostRequest } from '@/sdk/host-rpc'

interface ApprovalItem {
  id: string
  tool: string
  args: unknown
  sessionId: string
}

interface ApprovalState {
  items: ApprovalItem[]
  push: (item: ApprovalItem) => void
  remove: (id: string) => void
}

const approvalStore = createStore<ApprovalState>((set) => ({
  items: [],
  push: (item) => set((state) => ({ items: [...state.items, item] })),
  remove: (id) => set((state) => ({ items: state.items.filter((item) => item.id !== id) })),
}))

interface AgentMessagePayload {
  id: string
  source_session_id?: string
  target?: string
  message?: string
  constraints?: null | string
  expecting?: null | string
  expects_reply?: boolean
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke: tauriInvoke } = await import('@tauri-apps/api/core')
  return tauriInvoke<T>(cmd, args)
}

async function deliverAgentMessage(payload: AgentMessagePayload): Promise<void> {
  const target = findBotByName(String(payload.target ?? ''))
  if (!target) {
    throw new Error(`找不到机器人「${payload.target ?? ''}」`)
  }
  if (!target.chatSessionId) {
    throw new Error(`机器人「${target.name}」还没有 Bot Chat（先在花名册里打开一次它的聊天）`)
  }
  const source = botBySession(payload.source_session_id)
  const sourceName = source?.name ?? 'user'
  const text = String(payload.message ?? '').trim()
  if (!text) throw new Error('message_agent: 消息为空')
  const extras = [
    payload.constraints ? `约束：${payload.constraints}` : '',
    payload.expecting ? `需要你回复：${payload.expecting}` : '',
  ]
    .filter(Boolean)
    .join('\n')
  const body = `Message from 🤖 ${sourceName} (@${sourceName}): ${text}${extras ? `\n\n${extras}` : ''}`

  // 目标会话在 bot 泳道打开（同一 canonical 会话文件，历史保留）。
  await dispatchHostRequest('session.resume', {
    session_id: target.chatSessionId,
    profile: target.name,
    omit_messages: true,
  })
  await waitUntilIdle(dispatchHostRequest, target.chatSessionId, target.name, Date.now() + 120_000)
  const reply = await runBotTurn(dispatchHostRequest, target.chatSessionId, target.name, body)

  if (payload.expects_reply !== false && reply && payload.source_session_id && source) {
    // 回信送进发送者会话；发送者可能在跑，等它空闲再投。
    await waitUntilIdle(
      dispatchHostRequest,
      payload.source_session_id,
      source.name,
      Date.now() + 300_000,
    )
    const replyBody = `Message from 🤖 ${target.name} (@${target.name}): ${reply}`
    await dispatchHostRequest('prompt.submit', {
      session_id: payload.source_session_id,
      text: replyBody,
      profile: source.name,
    })
  }
}

interface RemoteAgentRow {
  connectionId: string
  profile: string
  targetProfile?: string
  handle?: string
}

/** 远端名册里按名/标题/handle 找目标（host.agents 的跨网关并集）。 */
async function findRemoteAgent(name: string): Promise<RemoteAgentRow | null> {
  const needle = name.trim().toLowerCase()
  if (!needle) return null
  const { host } = await import('@/sdk/host')
  const roster = await host.agents()
  for (const agent of roster.agents) {
    if (agent.connectionId === 'local') continue
    const record = agent as Record<string, unknown>
    const profile = String(agent.profile ?? '').toLowerCase()
    const title = String(record.title ?? '').toLowerCase()
    const handle = String(record.handle ?? '').toLowerCase()
    if (profile === needle || title === needle || handle === needle) {
      return {
        connectionId: agent.connectionId,
        profile: agent.profile,
        ...(typeof agent.targetProfile === 'string' ? { targetProfile: agent.targetProfile } : {}),
        ...(typeof record.handle === 'string' ? { handle: record.handle } : {}),
      }
    }
  }
  return null
}

/**
 * 等远端回执（hermes message_agent 的 waiter 对偶）：`bot_relay.reply` 事件
 * 命中本 envelope 后，把 reply 文本送进发送者会话（发送者可能在跑，等空闲）。
 * 无回信/错误回执 = console.error 可见，不伪造。
 */
async function waitForRelayReply(
  envelopeId: string,
  payload: AgentMessagePayload,
  remote: RemoteAgentRow,
): Promise<void> {
  const source = botBySession(payload.source_session_id)
  const sourceSessionId = source?.chatSessionId
  if (
    payload.expects_reply === false ||
    !source ||
    !sourceSessionId
  ) {
    return
  }
  const { listen } = await import('@tauri-apps/api/event')
  await new Promise<void>((resolve) => {
    let off: (() => void) | null = null
    let timer: number | null = null
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      if (timer !== null) clearTimeout(timer)
      off?.()
      resolve()
    }
    timer = window.setTimeout(() => {
      console.error(`[engine-bridge] relay 回执超时（${envelopeId}）——发送者不被唤醒`)
      finish()
    }, 1_800_000)
    void listen<{ id: string; reply?: string; error?: string; reason?: string }>(
      'mirach:plugin:bot_relay:reply',
      (event) => {
        if (event.payload?.id !== envelopeId) return
        const replyText = String(event.payload.reply ?? '').trim()
        const errorText = String(event.payload.error ?? '').trim()
        const reason = String(event.payload.reason ?? '').trim()
        finish()
        if (errorText || !replyText) {
          console.error(
            '[engine-bridge] relay 回执为错误',
            envelopeId,
            errorText || reason || '(空回信)',
          )
          return
        }
        void (async () => {
          try {
            await waitUntilIdle(
              dispatchHostRequest,
              sourceSessionId,
              source.name,
              Date.now() + 300_000,
            )
            await dispatchHostRequest('prompt.submit', {
              session_id: sourceSessionId,
              text: `Message from 🤖 ${remote.profile} (@${remote.handle ?? remote.profile}): ${replyText}`,
              profile: source.name,
            })
          } catch (error) {
            console.error('[engine-bridge] 回信送进发送者会话失败', error)
          }
        })()
      },
    ).then((offFn) => {
      if (settled) offFn()
      else off = offFn
    })
  })
}

function ApprovalDialog() {
  const items = useStore(approvalStore, (state) => state.items)
  const item = items[0]
  if (!item) return null
  const args = (() => {
    try {
      const text = JSON.stringify(item.args)
      return text.length > 600 ? `${text.slice(0, 600)}…` : text
    } catch {
      return String(item.args)
    }
  })()
  const decide = (allow: boolean) => {
    approvalStore.getState().remove(item.id)
    void invoke('pi_approval_decision', {
      id: item.id,
      allow,
      reason: allow ? undefined : '用户拒绝',
    }).catch((e) => console.error('[engine-bridge] 审批回执失败', e))
  }
  return (
    <div className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center bg-(--overlay-mask)">
      <div className="border-foreground/10 w-[min(92vw,32rem)] rounded-xl border bg-(--ui-chat-bubble-background) p-4 text-foreground shadow-xl">
        <h2 className="text-[0.9375rem] font-semibold">需要审批</h2>
        <p className="text-foreground/60 mt-1 text-xs">
          工具 <span className="font-mono">{item.tool}</span> 想执行一次操作。
        </p>
        <pre className="bg-(--ui-bg-tertiary) mt-3 max-h-56 overflow-auto rounded-md p-2 text-[0.75rem] whitespace-pre-wrap">
          {args}
        </pre>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            className="rounded-md px-3 py-1.5 text-xs hover:bg-(--chrome-action-hover)"
            onClick={() => decide(false)}
          >
            拒绝
          </button>
          <button
            type="button"
            className="rounded-md bg-(--ui-accent) px-3 py-1.5 text-xs text-white"
            onClick={() => decide(true)}
          >
            允许一次
          </button>
        </div>
      </div>
    </div>
  )
}

export function EngineBridges() {
  useEffect(() => {
    let disposed = false
    const unsubs: (() => void)[] = []
    // 应用启动即恢复用户上次的审批策略（Rust 默认 Yolo；前端偏好优先）。
    try {
      const stored = localStorage.getItem('mirach:approval-mode')
      if (stored === 'always-ask' || stored === 'write' || stored === 'yolo') {
        void invoke('pi_set_approval_mode', { mode: stored }).catch((e) =>
          console.error('[engine-bridge] 恢复审批模式失败', e),
        )
      }
    } catch {
      /* 偏好读取失败 = 保持默认；不阻断启动 */
    }
    void (async () => {
      const { listen } = await import('@tauri-apps/api/event')
      const offMessage = await listen<AgentMessagePayload>('mirach://agent-message', (event) => {
        const payload = event.payload
        // 先 ack（工具要立即返回 queued），后台再做真实投递。
        void (async () => {
          try {
            const target = findBotByName(String(payload.target ?? ''))
            if (target) {
              // 本机目标 = hermes 的 local delivery：直投，不经 envelope/relay。
              if (!target.chatSessionId) {
                throw new Error(`机器人「${target.name}」还没有 Bot Chat（先在花名册里打开一次它的聊天）`)
              }
              await invoke('pi_agent_message_ack', {
                id: payload.id,
                ok: true,
                deliveryId: payload.id,
              })
              void deliverAgentMessage(payload).catch((error) => {
                console.error('[engine-bridge] message_agent 投递失败', error)
              })
              return
            }
            // 远端目标（跨网关）：并入 envelope 仓，Desktop 的 relay 循环
            // 经 transport 投给对端网关；回执经 `bot_relay.reply` 事件唤醒
            // 本会话（hermes message_agent 的 waiter 对偶）。
            const remote = await findRemoteAgent(String(payload.target ?? ''))
            if (!remote) {
              throw new Error(`找不到机器人「${payload.target ?? ''}」（本机与远端名册都没有）`)
            }
            const source = botBySession(payload.source_session_id)
            const sourceName = source?.name ?? 'user'
            const text = String(payload.message ?? '').trim()
            if (!text) throw new Error('message_agent: 消息为空')
            const extras = [
              payload.constraints ? `约束：${payload.constraints}` : '',
              payload.expecting ? `需要你回复：${payload.expecting}` : '',
            ]
              .filter(Boolean)
              .join('\n')
            const envelope = await invoke<{ id: string }>('pi_relay_enqueue', {
              targetConnection: remote.connectionId,
              targetProfile: remote.targetProfile ?? remote.profile,
              targetHandle: remote.handle ?? remote.profile,
              fromProfile: sourceName,
              fromHandle: sourceName,
              message: `Message from 🤖 ${sourceName} (@${sourceName}): ${text}${extras ? `\n\n${extras}` : ''}`,
            })
            await invoke('pi_agent_message_ack', {
              id: payload.id,
              ok: true,
              deliveryId: envelope.id,
            })
            void waitForRelayReply(envelope.id, payload, remote).catch((error) => {
              console.error('[engine-bridge] 远端回执等待失败', error)
            })
          } catch (error) {
            console.error('[engine-bridge] message_agent 拒绝', error)
            await invoke('pi_agent_message_ack', {
              id: payload.id,
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            }).catch((e) => console.error('[engine-bridge] ack 失败', e))
          }
        })()
      })
      const offApproval = await listen<{ id: string; tool: string; args: unknown; session_id?: string }>(
        'mirach://approval-request',
        (event) => {
          approvalStore.getState().push({
            id: event.payload.id,
            tool: event.payload.tool,
            args: event.payload.args,
            sessionId: event.payload.session_id ?? '',
          })
        },
      )
      if (disposed) {
        offMessage()
        offApproval()
      } else {
        unsubs.push(offMessage, offApproval)
      }
    })().catch((error) => console.error('[engine-bridge] 监听注册失败', error))
    return () => {
      disposed = true
      for (const off of unsubs) off()
    }
  }, [])

  return <ApprovalDialog />
}

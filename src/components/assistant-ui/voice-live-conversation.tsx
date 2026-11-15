/**
 * GPT-Live 委托回路驱动（hermes use-voice-live-conversation.ts 的回复驱动
 * 段宿主移植，2026-11-12；语音会话本体在 voice-live-panel，本组件只做
 * **会话 ↔ agent turn** 的桥）：
 *
 * - **消费委托**：面板写入 pendingDelegation → 本组件 busy 时先 cancelRun
 *   （新请求取代在途 turn——hermes onInterrupt 同语义）→ `aui.thread.append`
 *   提交（发送通道 = 现有问候语 append 同源，用户行 + run 全走官方路径）。
 * - **回复驱动**（hermes :381-462 逐语义，200ms tick）：streaming 时按句界
 *   追加 `session.speak`，收尾补尾巴；在途工具名 → `session.think` 安静
 *   进度；idle 且已见运行（或 15s 提交宽限）→ 无语音结果提示 + 清委托。
 * - **状态机**：listening = 会话上、语音闲；speaking = 远端轨出声；
 *   thinking = delegation 在途。无 transcribing 相（语音模型自管语音）。
 *
 * 挂载 = provider 内常驻（无会话即 no-op）——PlanReviewCard 同款模式。
 *
 * 宿主适配：pi 无 per-turn 模型输入旁路（hermes 的 VOICE_LIVE_TURN_NOTE
 * 只进模型输入、不落用户行）——voiceContext 以注释块**前置进提交文本**
 * （落库行如实显示发送内容，不造假旁路）。
 */
import { FC, useEffect, useRef } from 'react'
import { useAui, useAuiState } from '@assistant-ui/react'

import { nextSpeechChunk, sanitizeTextForSpeech } from '@/lib/speech-text'
import {
  delegationPrompt,
  type LiveTranscriptFragment
} from '@/lib/voice-live'

import { getActiveSession, useVoiceLive, voiceLiveStore } from './voice-live-store'

/** 提交宽限（hermes SUBMIT_SETTLE_GRACE_MS：submit ack 滞后——turn 必须
 *  先被看到运行（busy）才能把"空闲且无回复"读成结束）。 */
const SUBMIT_SETTLE_GRACE_MS = 15_000

/** 从 thread 消息取最后一条 assistant 的可说话回复（text 部件拼接）。 */
function lastAssistantReply(
  messages: readonly {
    readonly id: string
    readonly role: string
    readonly parts: readonly { readonly type: string; readonly text?: string }[]
  }[],
): null | { id: string; text: string } {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]
    if (m.role !== 'assistant') continue
    const text = m.parts
      .filter((p) => p.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text as string)
      .join('')
    if (!text) return null
    return { id: m.id, text }
  }
  return null
}

export const VoiceLiveConversationDrive: FC = () => {
  const aui = useAui()
  const sessionUp = useVoiceLive((s) => s.sessionUp)
  // reply-drive 的重渲染触发器（hermes activeDelegation state 同物——ref
  // 写不触发 feed 循环重启）
  const activeDelegationId = useVoiceLive((s) => s.activeDelegationId)

  // 回复驱动游标（hermes spokenLengthRef / spokenResponseIdRef 同物）
  const spokenLengthRef = useRef(0)
  const spokenResponseIdRef = useRef<null | string>(null)
  const lastToolLabelRef = useRef<null | string>(null)
  const turnObservedRef = useRef(false)
  const submittedAtRef = useRef(0)
  // 已提交的委托 id（防同一请求重复消费）
  const consumedRef = useRef<null | string>(null)

  useEffect(() => {
    if (!sessionUp) {
      // 会话拆除：清游标（委托态由 setSessionUp(false) 清）
      spokenLengthRef.current = 0
      spokenResponseIdRef.current = null
      lastToolLabelRef.current = null
      turnObservedRef.current = false
      consumedRef.current = null
      return undefined
    }

    const tick = () => {
      const store = voiceLiveStore.getState()
      const session = getActiveSession()
      if (!session || !store.sessionUp) {
        return
      }

      // ── 消费面板写入的委托请求（hermes onDelegation 尾段：busy 先打断、
      //    setDelegation、onSubmit）──
      const pend = store.pendingDelegation
      if (pend && consumedRef.current !== pend.delegationId) {
        consumedRef.current = pend.delegationId
        store.setPendingDelegation(null)
        // 新请求取代在途 turn：停下，让语音说的是用户最后问的（hermes :309-313）
        if (aui.thread.getState().isRunning) {
          aui.thread.cancelRun()
        }
        store.setActiveDelegationId(pend.delegationId)
        spokenResponseIdRef.current = null
        spokenLengthRef.current = 0
        lastToolLabelRef.current = null
        turnObservedRef.current = false
        submittedAtRef.current = Date.now()
        // 提交（宿主适配：voiceContext 前置进文本——pi 无模型输入旁路面）
        const submission = [
          '[Note: this message is a delegation from a live spoken conversation. The text is a voice transcript (it may contain mis-hearings; use the latest intent). Answer in plain conversational sentences, keep it short, no markdown.]',
          '',
          '[Spoken context, oldest first]',
          pend.voiceContext,
          '',
          pend.prompt,
        ].join('\n')
        // **UI 只显示用户真正说的那句话**（pend.prompt）；内部 note/上下文走
        // runConfig.custom.voiceSubmission 交给 onNew 发给引擎。旧实现把
        // note 和 context 直接写进消息内容，聊天区会出现 English note 和
        // "[object Object]"（2026-11-15 用户："对话还乱"）。
        aui.thread.append({
          content: [{ type: 'text', text: pend.prompt }],
          runConfig: { custom: { voiceSubmission: submission } },
        })
        return
      }

      const delegationId = store.activeDelegationId
      if (!delegationId) {
        return
      }

      const state = aui.thread.getState()
      const busy = state.isRunning
      if (busy) {
        turnObservedRef.current = true
      }

      // 安静进度（hermes :398-403："Hermes is working: <tool>. Not done yet."）
      const lastParts = state.messages.at(-1)?.parts ?? []
      const pendingTool = lastParts.find(
        (p): p is Extract<typeof p, { toolName: string }> =>
          p.type === 'tool-call' && !('result' in p && p.result !== undefined),
      )
      const tool = busy && pendingTool ? pendingTool.toolName : null
      if (tool && tool !== lastToolLabelRef.current) {
        lastToolLabelRef.current = tool
        session.think(delegationId, `Mirach is working: ${tool}. Not done yet.`)
      }

      // 回复（hermes :405-440：流式句界追加，收尾补尾巴，consume + 清委托）
      const reply = lastAssistantReply(state.messages)

      if (reply) {
        turnObservedRef.current = true

        if (spokenResponseIdRef.current !== reply.id) {
          spokenResponseIdRef.current = reply.id
          spokenLengthRef.current = 0
        }

        const spoken = sanitizeTextForSpeech(reply.text)

        if (busy) {
          // 流式：完整句就送出。用 CJK 感知的切句（nextSpeechChunk）——旧的
          // `lastIndexOf('. ')` 只认英文句点，中文委托回复会整段攒到 turn
          // 结束才一次 commentary.append，听感就是 TTS 念稿。
          const tail = spoken.slice(spokenLengthRef.current)
          const chunk = nextSpeechChunk(tail)

          if (chunk !== null) {
            session.speak(delegationId, chunk)
            spokenLengthRef.current += chunk.length
          }

          return
        }

        if (spoken.length > spokenLengthRef.current) {
          session.speak(delegationId, spoken.slice(spokenLengthRef.current))
          spokenLengthRef.current = spoken.length
        }

        store.setActiveDelegationId(null)
        lastToolLabelRef.current = null

        return
      }

      // 提交 ack 滞后：先看到运行（或过宽限期）才能把"空闲无回复"读成结束
      // （hermes :442-455：纯工具/出错/被打断的 turn 无语音结果 → think 提示）
      if (
        !busy &&
        (turnObservedRef.current || Date.now() - submittedAtRef.current > SUBMIT_SETTLE_GRACE_MS)
      ) {
        if (spokenLengthRef.current === 0) {
          session.think(delegationId, 'Mirach finished that request without a spoken result.')
        }

        store.setActiveDelegationId(null)
        lastToolLabelRef.current = null
      }
    }

    const timer = window.setInterval(tick, 200)
    tick()

    return () => window.clearInterval(timer)
  }, [sessionUp, activeDelegationId, aui])

  return null
}

/** 语音字幕的导出（面板与驱动共用折叠逻辑——transcript 片段 → 轮）。 */
export function foldTranscriptForSeed(
  messages: readonly {
    readonly role: string
    readonly parts: readonly { readonly type: string; readonly text?: string }[]
  }[],
): { role: 'assistant' | 'user'; text: string }[] {
  return messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({
      role: m.role as 'assistant' | 'user',
      text: m.parts
        .filter((p) => p.type === 'text' && typeof p.text === 'string')
        .map((p) => p.text as string)
        .join(''),
    }))
    .filter((t) => t.text.trim().length > 0)
}

/** 导出给面板的片段类型（避免面板直接 import voice-live 的形状）。 */
export type { LiveTranscriptFragment }

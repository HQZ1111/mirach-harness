/**
 * 自动朗读回复（hermes use-auto-speak-replies.ts 的宿主对偶，2026-11-28）。
 *
 * hermes 语义（原文件注释）：
 *  - 纯 TTS：`voice.auto_tts` 开启时朗读**每条完成的助手轮**——无听写、
 *    无对话循环；语音对话进行中保持沉默（对话自己会说话）；
 *  - **总读最新**：积压折叠到最新一条（中间回复不排队复读）；
 *  - 播放占用时**挂起**：上一段没读完，新回复等 playback-idle 边沿再读；
 *  - 开关打开/打开新会话时**消耗**当前最后一条（只读之后新到的）；
 *  - 关闭时只掐自己启动的朗读（用户手动点的朗读不受影响）。
 *
 * 宿主差异（数据面事实，不是简化）：
 *  - 触发边沿 = 轮次机 isRunning true→false（hermes 订阅 $messages store，
 *    宿主 messages 是 per-render selector 值，不能按值订阅——按边沿等价）；
 *  - 会话切换是 isRunning false→false（无边沿），天然不触发朗读 = hermes
 *    "re-arm on session switch"（打开会话不读既有末条）同结果；
 *  - hermes 的跨窗口 claim（ownsAmbientCue / spokenReplyOf）宿主没有——
 *    宿主单聊天窗。但**同一会话可能同时开着主窗格 + 分栏**（两个 runtime
 *    各持一份 actor 投影），去重走模块级 spokenMessageIds（先到先读）；
 *  - 播放占用 = speechProgressBridge.playing（BoundarySpeechSynthesisAdapter
 *    全局唯一）；对话进行 = voiceLiveStore.sessionUp；
 *  - 朗读直接走 speechAdapter.speak（与手动朗读同一管道，进度条经
 *    speechProgressBridge 消费）。
 */
import { useEffect, useRef } from 'react'
import { useStore } from 'zustand'

import { speechProgressBridge } from './speech-adapter'
import { speechAdapter } from './runtime'
import type { TurnMessage } from './turn-actor'
import { voiceLiveStore } from './voice-live-store'
import { voicePrefsStore } from './voice-prefs'

/** 已朗读/已消耗的消息 id（上限 200，FIFO 淘汰）——跨 runtime/分栏共用。 */
const spokenMessageIds = new Set<string>()
const SPOKEN_CAP = 200

/** 测试隔离：清空去重表（生产代码不要调）。 */
export function resetSpokenForTests(): void {
  spokenMessageIds.clear()
}

function markSpoken(id: string): void {
  spokenMessageIds.add(id)
  if (spokenMessageIds.size > SPOKEN_CAP) {
    spokenMessageIds.delete(spokenMessageIds.values().next().value!)
  }
}

/** 取消息的纯文本部分（thinking/tool 部件不读；无文本 = 不朗读）。
 *  导出供单测（消费方只有本文件与测试）。 */
export function assistantReplyText(message: TurnMessage): string | null {
  if (message.role !== 'assistant') return null
  if (typeof message.content === 'string') {
    return message.content.trim() || null
  }
  const text = message.content
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('\n')
    .trim()
  return text || null
}

/** 当前 actor 投影里最后一条带文本的助手回复（最新在后）。导出供单测。 */
export function latestReply(messages: readonly TurnMessage[]): { id: string; text: string } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.role !== 'assistant') continue
    const text = assistantReplyText(m)
    if (text === null) continue
    return { id: m.id, text }
  }
  return null
}

export interface AutoSpeakOptions {
  /** 本 runtime 的消息投影（主 runtime = 焦点会话；分栏 = 自己的会话）。 */
  messages: readonly TurnMessage[]
  /** 本 runtime 是否在跑（true→false 边沿 = 回合完成）。 */
  isRunning: boolean
}

/**
 * 挂在持有 actor 投影的组件上（runtime.tsx 主会话 / session-runtime 分栏）。
 * 同一会话两处挂载由 spokenMessageIds 去重——先到的先读。
 */
export function useAutoSpeakReplies({ messages, isRunning }: AutoSpeakOptions): void {
  const autoSpeak = useStore(voicePrefsStore, (s) => s.autoSpeak)

  // messages 的 ref 影子（开关边沿要读"当前最新"而不把 messages 进依赖——
  // 依赖进去了就会在流式期间反复触发消耗）。
  const messagesRef = useRef(messages)
  messagesRef.current = messages
  /** 播放被占用时挂起的待读回复（总读最新：新完成覆盖旧的）。 */
  const heldRef = useRef<{ id: string; text: string } | null>(null)

  // 开关 false→true 边沿：消耗当前最后一条（打开时不把屏幕上已有的回复
  // 读出来——hermes "Don't read whatever reply already sits" 同语义）。
  const prevEnabledRef = useRef(autoSpeak)
  useEffect(() => {
    if (autoSpeak && !prevEnabledRef.current) {
      const reply = latestReply(messagesRef.current)
      if (reply) markSpoken(reply.id)
    }
    prevEnabledRef.current = autoSpeak
  }, [autoSpeak])

  // 回合完成边沿（true→false）：最新助手回复即本轮产物。可读即读；被
  // 占用（朗读中/语音对话中）则挂起，等 idle 边沿补读。
  const wasRunningRef = useRef(isRunning)
  useEffect(() => {
    const was = wasRunningRef.current
    wasRunningRef.current = isRunning
    if (!(was && !isRunning)) return
    const reply = latestReply(messages)
    if (!reply) return
    if (!voicePrefsStore.getState().autoSpeak) return
    if (spokenMessageIds.has(reply.id)) return
    if (voiceLiveStore.getState().sessionUp || speechProgressBridge.getState().playing) {
      heldRef.current = reply
      return
    }
    speakReply(reply.id, reply.text)
  }, [isRunning, messages])

  // idle 边沿（朗读结束 / 语音会话拆除）→ 补读挂起的那条（hermes
  // $voicePlayback.listen(speakLatest) 同语义）。
  useEffect(() => {
    const trySpeakHeld = () => {
      const held = heldRef.current
      if (!held || spokenMessageIds.has(held.id)) return
      if (!voicePrefsStore.getState().autoSpeak) return
      if (voiceLiveStore.getState().sessionUp) return
      if (speechProgressBridge.getState().playing) return
      heldRef.current = null
      speakReply(held.id, held.text)
    }
    const unsubPlayback = speechProgressBridge.subscribe(trySpeakHeld)
    const unsubLive = voiceLiveStore.subscribe(trySpeakHeld)
    return () => {
      unsubPlayback()
      unsubLive()
    }
  }, [])

  // 关闭开关：掐掉当前朗读。宿主全局只有一个 speechSynthesis 通道、
  // progress 桥不记来源，无法区分"自动启动"与"手动启动"——hermes 的
  // autoStartedReplies 精细语义在此不可实现，关闭 = 停当前朗读（可见行为
  // 与开关语义一致，不算静默兜底）。
  useEffect(() => {
    if (autoSpeak) return
    if (speechProgressBridge.getState().playing && typeof window !== 'undefined' && window.speechSynthesis) {
      window.speechSynthesis.cancel()
      speechProgressBridge.setState({ playing: false })
    }
  }, [autoSpeak])
}

function speakReply(id: string, text: string): void {
  if (!speechAdapter) {
    // 无语音引擎环境：不朗读也不反复尝试——mark 掉避免每个边沿重试。
    markSpoken(id)
    return
  }
  markSpoken(id)
  try {
    speechAdapter.speak(text)
  } catch (e) {
    console.error('[auto-speak] 朗读启动失败', e)
  }
}

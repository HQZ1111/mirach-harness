/**
 * GPT-Live 引擎状态桥（hermes store/voice-live.ts 的宿主版，2026-11-11）。
 *
 * 状态真相在宿主 Rust 桥（pi_voice_live_status：settings.json voice 段 →
 * OPENAI_API_KEY 链）；本 store 只缓存拉取结果与会话运行态，供 composer
 * 语音入口消费。**key 永不经此 store**。
 *
 * 委托回路（voice → agent turn → commentary 回读）需要 runtime 桥
 * （postRun 未导出）——下一轮接，接线前语音会话的 delegation 处理器
 * 只亮红注（真实语音对话不受影响）。
 */
import { createStore, useStore } from 'zustand'

import {
  fetchVoiceLiveStatus,
  type VoiceChatMode,
  type VoiceLiveStatus
} from '@/lib/voice-live'

/** 会话命令面的公共形状（GPT-Live WebRTC 桥与 MOSS Live WSS 桥都满足
 *  它——驱动组件经此调度，不关心传输）。 */
export interface VoiceSessionLike {
  sessionId: string | null
  connected: boolean
  activeDelegationId: string | null
  think(delegationId: string | null, content: string): void
  speak(delegationId: string | null, content: string): void
  instruct(content: string): void
  setMuted(muted: boolean): void
  close(): void
}

/** 面板提交的委托请求（hermes onDelegation → onSubmit 的宿主桥——面板持
 *  session，提交面在 provider 内的驱动组件，zustand 传话）。 */
export interface PendingDelegation {
  delegationId: string
  prompt: string
  voiceContext: string
}

interface VoiceLiveState {
  /** null = 后端未答（旧二进制无此命令）→ 引擎选择不渲染（hermes 同规则）。 */
  status: null | VoiceLiveStatus
  /** 会话在场（mic/扬声器已建， WebRTC/WSS 层） */
  sessionUp: boolean
  /** 远端轨在说话 */
  speaking: boolean
  muted: boolean
  /** 最后一条字幕（双方，最新在后；只留渲染窗——transcript 真相在 session） */
  captions: { speaker: 'assistant' | 'user'; text: string }[]
  /** 面板写入、驱动组件消费的委托请求（未消费 = 尚未提交为 turn） */
  pendingDelegation: null | PendingDelegation
  /** 已提交为 turn、正在等回复的 delegation（hermes delegationRef 同物） */
  activeDelegationId: null | string
  /** 红显文案（入口钮/字幕条消费——按钮在列头、字幕条在 composer，跨组件
   *  传话走 store，不走 React ref）。null = 无错。 */
  error: null | string
  refresh: () => void
  setSessionUp: (up: boolean) => void
  setSpeaking: (speaking: boolean) => void
  setMuted: (muted: boolean) => void
  pushCaption: (speaker: 'assistant' | 'user', text: string) => void
  /** 覆盖语义字幕（MOSS Live 的 transcript 是全文覆盖，非 delta） */
  setCaption: (speaker: 'assistant' | 'user', text: string) => void
  clearCaptions: () => void
  setPendingDelegation: (d: null | PendingDelegation) => void
  setActiveDelegationId: (id: null | string) => void
  setError: (message: null | string) => void
}

export const voiceLiveStore = createStore<VoiceLiveState>((set) => ({
  status: null,
  sessionUp: false,
  speaking: false,
  muted: false,
  captions: [],
  pendingDelegation: null,
  activeDelegationId: null,
  error: null,
  refresh: () => {
    void fetchVoiceLiveStatus().then((status) => set({ status }))
  },
  setSessionUp: (up) =>
    set((s) => ({
      sessionUp: up,
      speaking: false,
      muted: false,
      // 会话拆除即清委托态（hermes end() 的 setDelegation(null) 同款）
      pendingDelegation: up ? s.pendingDelegation : null,
      activeDelegationId: up ? s.activeDelegationId : null,
    })),
  setSpeaking: (speaking) => set({ speaking }),
  setMuted: (muted) => set({ muted }),
  pushCaption: (speaker, text) =>
    set((s) => {
      const last = s.captions.at(-1)
      // 同说话人相邻增量拼接（hermes 字幕折叠同构——GPT-Live 片段是 delta）
      if (last && last.speaker === speaker) {
        return { captions: [...s.captions.slice(0, -1), { speaker, text: last.text + text }] }
      }
      return { captions: [...s.captions.slice(-30), { speaker, text }] }
    }),
  setCaption: (speaker, text) =>
    set((s) => {
      const last = s.captions.at(-1)
      // MOSS transcript 是全文覆盖——同说话人覆盖最后一条
      if (last && last.speaker === speaker) {
        return { captions: [...s.captions.slice(0, -1), { speaker, text }] }
      }
      return { captions: [...s.captions.slice(-30), { speaker, text }] }
    }),
  clearCaptions: () => set({ captions: [] }),
  setPendingDelegation: (d) => set({ pendingDelegation: d }),
  setActiveDelegationId: (id) => set({ activeDelegationId: id }),
  setError: (message) => set({ error: message }),
}))

// ── 会话实例注册表（面板持 UI 生命周期，驱动组件经此读会话命令面——
//    跨组件不走 React ref）。同一时刻至多一个会话（hermes sessionRef 同
//    不变量）。 ──
let activeSession: VoiceSessionLike | null = null
export const setActiveSession = (s: null | VoiceSessionLike): void => {
  activeSession = s
}
export const getActiveSession = (): VoiceSessionLike | null => activeSession

export const useVoiceLive = <T,>(selector: (s: VoiceLiveState) => T): T =>
  useStore(voiceLiveStore, selector)

/** 选中引擎（status.mode 是后端真相；宿主单连接无远程切换面——hermes
 *  setVoiceChatMode 写 gateway config，宿主的设置写入走设置页 voice 段）。 */
export const selectedVoiceChatMode = (status: null | VoiceLiveStatus): VoiceChatMode =>
  status?.mode ?? 'chained'

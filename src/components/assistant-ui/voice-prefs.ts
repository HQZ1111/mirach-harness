/**
 * 语音偏好（hermes store/voice-prefs.ts 的宿主对偶，2026-11-28）。
 *
 * hermes 的 `$autoSpeakReplies`（`voice.auto_tts`）：开启后每条完成的
 * 助手回复自动朗读——无听写、无对话循环（对话进行时它自己让位）。
 * 宿主对偶挂在 composer 的语音菜单里（voice-menu 同位），持久化
 * localStorage `mirach:voice.auto-speak.v1`（UI 偏好走本机存储，与
 * 外观/通知偏好同策略；settings.json 的 voice 段只管引擎凭据与模式）。
 */
import { createStore, useStore } from 'zustand'

const STORAGE_KEY = 'mirach:voice.auto-speak.v1'

function readInitial(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1'
  } catch {
    // localStorage 不可用（极端环境）= 偏好缺省关。开关本身仍可用（内存态）。
    return false
  }
}

export interface VoicePrefsState {
  autoSpeak: boolean
  setAutoSpeak: (on: boolean) => void
}

export const voicePrefsStore = createStore<VoicePrefsState>()((set) => ({
  autoSpeak: readInitial(),
  setAutoSpeak: (on) => {
    set({ autoSpeak: on })
    try {
      localStorage.setItem(STORAGE_KEY, on ? '1' : '0')
    } catch (e) {
      // 持久化失败不静默：偏好本轮内存态仍生效，但下次启动会丢——必须可见。
      console.error('[voice-prefs] 自动朗读偏好持久化失败', e)
    }
  },
}))

export const useAutoSpeakRepliesPref = (): boolean => useStore(voicePrefsStore, (s) => s.autoSpeak)

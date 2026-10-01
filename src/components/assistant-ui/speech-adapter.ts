/**
 * Web Speech 朗读适配器（官方 read-aloud 元素的数据面）：
 * - BoundarySpeechSynthesisAdapter 实现 @assistant-ui/core 的
 *   SpeechSynthesisAdapter（speak(text) → Utterance{status, cancel,
 *   subscribe}，签名对 node_modules @assistant-ui/core dist
 *   adapters/speech.d.ts 实锤），注册进 runtime 的 adapters.speech——
 *   朗读走核心管道（aui.message.speak / aui.message.stopSpeaking），
 *   capabilities.speech 随注册点亮。
 * - boundary 事件 → speechProgressBridge（charIndex/状态投影）：核心
 *   Utterance 接口没有 boundary 钩子（官方 WebSpeechSynthesisAdapter
 *   也没有），逐词进度由宿主侧桥承接——ReadAloud 面板的 spokenIndex
 *   按 charIndex → 词下标映射推进。
 * - 能力门：speechSynthesis 不存在（无语音引擎环境）→ 不注册适配器
 *   （capabilities.speech=false → UI 钮隐藏），console.info 一次。
 */
import { createStore, useStore } from 'zustand'

import type { SpeechSynthesisAdapter } from '@assistant-ui/react'

/** 朗读速率（模块级——接口签名 speak(text) 不带速率参数，utterance 创建
 * 时从这里读取；Web Speech 的 rate 在创建后不可变，变速 = 重读） */
let currentRate = 1

/** 速率档位循环（面板的 onRateChange 依次取下一档） */
export const SPEECH_RATES: readonly number[] = [1, 1.25, 1.5, 2]

export const getSpeechRate = (): number => currentRate

export const setSpeechRate = (rate: number): void => {
  currentRate = rate
}

export interface SpeechProgressState {
  /** 正在朗读的全文（speak(text) 不带消息 id——面板用它判定"读的是不是我"） */
  text: string
  /** 最近一次 boundary 事件的 charIndex（0 = 起点；部分引擎不发 boundary，
   * 进度停在 0——播放本身不受影响，诚实不伪造进度） */
  charIndex: number
  /** playing = 核心管道正在合成（starting/running）；end/error/cancel 后 false */
  playing: boolean
}

export const speechProgressBridge = createStore<SpeechProgressState>(() => ({
  text: '',
  charIndex: 0,
  playing: false,
}))

export const isSpeechSupported = (): boolean =>
  typeof window !== 'undefined' &&
  'speechSynthesis' in window &&
  typeof SpeechSynthesisUtterance !== 'undefined'

let unsupportedLogged = false

/** 能力门：不支持时 console.info 一次（进程内只提醒一次），返回支持与否 */
export const ensureSpeechSupportLogged = (): boolean => {
  const ok = isSpeechSupported()
  if (!ok && !unsupportedLogged) {
    unsupportedLogged = true
    console.info('[speech] 当前环境无 speechSynthesis（无语音引擎）——朗读不可用')
  }
  return ok
}

/** status 不可变快照的构造（ended 带 reason/error） */
const endedStatus = (
  reason: 'finished' | 'cancelled' | 'error',
  error?: unknown,
): SpeechSynthesisAdapter.Status =>
  error !== undefined
    ? { type: 'ended', reason, error }
    : { type: 'ended', reason }

/**
 * 带 boundary 进度的 Web Speech 适配器：status 语义照抄官方
 * WebSpeechSynthesisAdapter（running 起、ended 收尾三 reason、cancel 停
 * 整个合成队列、subscribe 支持迟到订阅的一次性补发），额外把 boundary
 * charIndex 投影到 speechProgressBridge。
 */
export class BoundarySpeechSynthesisAdapter implements SpeechSynthesisAdapter {
  speak(text: string): SpeechSynthesisAdapter.Utterance {
    if (!isSpeechSupported()) {
      throw new Error('[speech] speechSynthesis 不可用（无语音引擎环境）')
    }
    const utterance = new SpeechSynthesisUtterance(text)
    utterance.rate = currentRate
    speechProgressBridge.setState({ text, charIndex: 0, playing: true })

    utterance.addEventListener('boundary', (e) => {
      const idx = (e as SpeechSynthesisEvent).charIndex
      if (typeof idx === 'number' && Number.isFinite(idx)) {
        speechProgressBridge.setState({ charIndex: idx })
      }
    })

    const subscribers = new Set<() => void>()
    const notify = () => {
      for (const cb of subscribers) cb()
    }
    const res: SpeechSynthesisAdapter.Utterance = {
      status: { type: 'running' },
      cancel: () => {
        if (res.status.type === 'ended') return
        window.speechSynthesis.cancel()
        res.status = endedStatus('cancelled')
        speechProgressBridge.setState({ playing: false })
        notify()
      },
      subscribe: (callback) => {
        if (res.status.type === 'ended') {
          // 迟到订阅：立即补发一次终态（官方同语义）
          let cancelled = false
          queueMicrotask(() => {
            if (!cancelled) callback()
          })
          return () => {
            cancelled = true
          }
        }
        subscribers.add(callback)
        return () => {
          subscribers.delete(callback)
        }
      },
    }
    utterance.addEventListener('end', () => {
      if (res.status.type === 'ended') return
      res.status = endedStatus('finished')
      speechProgressBridge.setState({ playing: false })
      notify()
    })
    utterance.addEventListener('error', (e) => {
      if (res.status.type === 'ended') return
      res.status = endedStatus('error', (e as SpeechSynthesisErrorEvent).error)
      speechProgressBridge.setState({ playing: false })
      console.error('[speech] 朗读合成出错', (e as SpeechSynthesisErrorEvent).error)
      notify()
    })
    window.speechSynthesis.speak(utterance)
    return res
  }
}

// ── 词序列与 charIndex → 词下标映射（纯函数，可单测）──────────────────
// boundary 事件只给 charIndex（UTF-16 偏移），ReadAloud 模板的 words/
// spokenIndex 需要词序列：CJK 字符逐字成词（中文无空格分词，逐字与
// boundary 粒度对齐）、连续非空白的非 CJK 段整段成词（英文按段，
// 引擎的 boundary 在词间给出段内偏移即可映射到段）。

export interface SpeechWord {
  word: string
  /** 该词在原文中的 UTF-16 起始偏移 */
  start: number
}

const CJK_CHAR = /[\u3000-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/

const isCJKChar = (ch: string): boolean => CJK_CHAR.test(ch)

/** 文本 → 朗读词序列（含词起点偏移）：空白分隔；CJK 逐字、其余整段。
 * 空文本 → []。 */
export const segmentSpeechWords = (text: string): SpeechWord[] => {
  const out: SpeechWord[] = []
  let buf = ''
  let bufStart = 0
  let i = 0
  const flush = () => {
    if (buf) {
      out.push({ word: buf, start: bufStart })
      buf = ''
    }
  }
  for (const ch of text) {
    if (/\s/.test(ch)) {
      flush()
    } else if (isCJKChar(ch)) {
      flush()
      out.push({ word: ch, start: i })
    } else {
      if (!buf) bufStart = i
      buf += ch
    }
    i += ch.length
  }
  flush()
  return out
}

/** boundary charIndex → 词下标：最后一个 start <= charIndex 的词；
 * 空序列 → -1；charIndex 越界（引擎补发到末尾）→ 最后一词 */
export const wordIndexAt = (words: readonly SpeechWord[], charIndex: number): number => {
  let idx = -1
  for (let i = 0; i < words.length; i++) {
    if (words[i]!.start <= charIndex) idx = i
    else break
  }
  return idx
}

/**
 * 完成音库（hermes lib/completion-sound.ts 的移植，2026-10-24）。
 *
 * 15 个预设（0=无）+ WebAudio 合成引擎逐字移植（voice/pluck/bloom/
 * whoosh/sweep/airPuff + 混响 impulse 生成）。hermes 的三个依赖在此本地化：
 *   · store/completion-sound → 本文件的 variant 偏好（localStorage，
 *     键 `mirach.desktop.completionSoundVariantId`，hermes 同语义存整数串）
 *   · store/haptics → 本文件的静音偏好（`mirach.desktop.hapticsMuted`，
 *     hermes persistBoolean 同语义存 'true'/'false' 字符串）
 *   · store/ambient（多窗口去重）→ 单窗口应用不需要跨窗仲裁，直接播放
 *     （hermes ownsAmbientCue 是 Electron 多窗口的专利；标注差异）
 *   · lib/audio-context → 本文件内联懒建 AudioContext 单例（同语义：
 *     无 AudioContext（如被策略禁用）返回 null 而不是抛错）
 *
 * 运行期派发端（回合完成 → 播放）与通知派发同域（message-queue 一轮）；
 * 当前消费者 = 设置页「通知 · 声音」的预览按钮。
 */

export const NO_COMPLETION_SOUND_VARIANT_ID = 0
const VARIANT_KEY = 'mirach.desktop.completionSoundVariantId'
const MUTED_KEY = 'mirach.desktop.hapticsMuted'

/** 读当前变体 id（坏值回 1；hermes resolveCompletionSoundVariantId 同语义）。 */
export function resolveCompletionSoundVariantId(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isInteger(n) || n < 0 || n > 14) {
    return 1
  }
  return n
}

export function completionSoundVariantId(): number {
  try {
    return resolveCompletionSoundVariantId(window.localStorage.getItem(VARIANT_KEY))
  } catch {
    return 1
  }
}

export function setCompletionSoundVariantId(id: number): void {
  window.localStorage.setItem(VARIANT_KEY, String(resolveCompletionSoundVariantId(id)))
}

export function hapticsMuted(): boolean {
  try {
    return window.localStorage.getItem(MUTED_KEY) === 'true'
  } catch {
    return false
  }
}

export function setHapticsMuted(muted: boolean): void {
  window.localStorage.setItem(MUTED_KEY, muted ? 'true' : 'false')
}

// ── AudioContext 单例（hermes lib/audio-context 同语义）──────────────
let sharedCtx: AudioContext | null = null
function getAudioContext(): AudioContext | null {
  if (sharedCtx) {
    void sharedCtx.resume()
    return sharedCtx
  }
  const Ctor: typeof AudioContext | undefined =
    typeof window !== 'undefined'
      ? window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      : undefined
  if (!Ctor) {
    return null
  }
  sharedCtx = new Ctor()
  return sharedCtx
}

type OscType = OscillatorType

// 以下合成引擎逐字移植自 hermes（含英文行注释——行为契约）。

function voice(ac: AudioContext, master: GainNode, t0: number, spec: ToneSpec) {
  const osc = ac.createOscillator()
  const env = ac.createGain()
  const start = t0 + (spec.start ?? 0)
  const peak = spec.gain ?? 0.5
  const attack = spec.attack ?? 0.006
  const end = start + spec.dur

  osc.type = spec.type ?? 'sine'
  osc.frequency.setValueAtTime(spec.freq, start)

  env.gain.setValueAtTime(0.0001, start)
  env.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), start + attack)
  env.gain.exponentialRampToValueAtTime(0.0001, end)

  osc.connect(env)
  env.connect(master)
  osc.start(start)
  osc.stop(end + 0.02)
}

function pluckVoice(ac: AudioContext, master: GainNode, t0: number, spec: PluckSpec) {
  const osc = ac.createOscillator()
  const env = ac.createGain()
  const start = t0 + (spec.start ?? 0)
  const attack = spec.attack ?? 0.004
  const glide = spec.glide ?? 0.16
  const end = start + spec.decay

  osc.type = 'triangle'
  osc.frequency.setValueAtTime(spec.freqFrom, start)
  osc.frequency.exponentialRampToValueAtTime(spec.freqTo, start + glide)

  env.gain.setValueAtTime(0.0001, start)
  env.gain.exponentialRampToValueAtTime(Math.max(spec.gain, 0.0002), start + attack)
  env.gain.exponentialRampToValueAtTime(0.0001, end)

  osc.connect(env)
  env.connect(master)
  osc.start(start)
  osc.stop(end + 0.02)
}

function bloomVoice(ac: AudioContext, master: GainNode, t0: number, spec: BloomSpec) {
  const osc = ac.createOscillator()
  const env = ac.createGain()
  const start = t0 + (spec.start ?? 0)
  const hold = spec.hold ?? 0.08
  const end = start + spec.attack + hold + spec.decay

  osc.type = spec.type ?? 'sine'
  osc.frequency.setValueAtTime(spec.freq, start)

  if (spec.freqTo) {
    osc.frequency.exponentialRampToValueAtTime(spec.freqTo, start + spec.attack + hold * 0.6)
  }

  osc.detune.setValueAtTime(spec.detune ?? 0, start)

  env.gain.setValueAtTime(0.0001, start)
  env.gain.exponentialRampToValueAtTime(Math.max(spec.gain, 0.0002), start + spec.attack)
  env.gain.setValueAtTime(Math.max(spec.gain, 0.0002), start + spec.attack + hold)
  env.gain.exponentialRampToValueAtTime(0.0001, end)

  osc.connect(env)
  env.connect(master)
  osc.start(start)
  osc.stop(end + 0.02)
}

function noiseSource(ac: AudioContext, seconds: number): AudioBufferSourceNode {
  const length = Math.floor(ac.sampleRate * seconds)
  const buffer = ac.createBuffer(1, length, ac.sampleRate)
  const data = buffer.getChannelData(0)

  for (let i = 0; i < length; i += 1) {
    data[i] = Math.random() * 2 - 1
  }

  const source = ac.createBufferSource()
  source.buffer = buffer

  return source
}

function airPuff(ac: AudioContext, master: GainNode, t0: number, spec: AirPuffSpec) {
  const source = noiseSource(ac, 0.12)
  const filter = ac.createBiquadFilter()
  const env = ac.createGain()
  const start = t0 + (spec.start ?? 0)
  const end = start + spec.decay

  filter.type = 'bandpass'
  filter.frequency.setValueAtTime(spec.freq, start)
  filter.Q.setValueAtTime(spec.q ?? 1.2, start)

  env.gain.setValueAtTime(0.0001, start)
  env.gain.exponentialRampToValueAtTime(Math.max(spec.gain, 0.0002), start + 0.018)
  env.gain.exponentialRampToValueAtTime(0.0001, end)

  source.connect(filter)
  filter.connect(env)
  env.connect(master)
  source.start(start)
  source.stop(end + 0.02)
}

function whooshVoice(ac: AudioContext, master: GainNode, t0: number, spec: WhooshSpec) {
  const source = noiseSource(ac, 0.4)
  const filter = ac.createBiquadFilter()
  const env = ac.createGain()
  const start = t0 + (spec.start ?? 0)
  const end = start + spec.decay

  filter.type = 'bandpass'
  filter.frequency.setValueAtTime(spec.freqFrom, start)
  filter.frequency.exponentialRampToValueAtTime(spec.freqTo, end)
  filter.Q.setValueAtTime(spec.q ?? 0.8, start)

  env.gain.setValueAtTime(0.0001, start)
  env.gain.exponentialRampToValueAtTime(Math.max(spec.gain, 0.0002), start + 0.03)
  env.gain.exponentialRampToValueAtTime(0.0001, end)

  source.connect(filter)
  filter.connect(env)
  env.connect(master)
  source.start(start)
  source.stop(end + 0.02)
}

function sweepVoice(ac: AudioContext, master: GainNode, t0: number, spec: SweepSpec) {
  const osc = ac.createOscillator()
  const env = ac.createGain()
  const start = t0 + (spec.start ?? 0)
  const attack = spec.attack ?? 0.003
  const end = start + spec.decay

  osc.type = spec.type ?? 'triangle'
  osc.frequency.setValueAtTime(spec.freqFrom, start)
  osc.frequency.exponentialRampToValueAtTime(spec.freqTo, end - 0.02)

  env.gain.setValueAtTime(0.0001, start)
  env.gain.exponentialRampToValueAtTime(Math.max(spec.gain, 0.0002), start + attack)
  env.gain.exponentialRampToValueAtTime(0.0001, end)

  osc.connect(env)
  env.connect(master)
  osc.start(start)
  osc.stop(end + 0.02)
}

let reverbImpulse: AudioBuffer | null = null

function makeReverb(ac: AudioContext): ConvolverNode {
  if (!reverbImpulse) {
    const seconds = 1.6
    const length = Math.floor(ac.sampleRate * seconds)
    reverbImpulse = ac.createBuffer(2, length, ac.sampleRate)

    for (let channel = 0; channel < 2; channel += 1) {
      const data = reverbImpulse.getChannelData(channel)

      for (let i = 0; i < length; i += 1) {
        data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** 2.6
      }
    }
  }

  const convolver = ac.createConvolver()
  convolver.buffer = reverbImpulse

  return convolver
}

export interface CompletionSoundVariant {
  id: number
  name: string
  play: (ac: AudioContext, master: GainNode, t0: number) => void
}

const A2 = 110
const A3 = 220
const A4 = 440
const A5 = 880
const B5 = 987.77
const C3 = 130.81
const C4 = 261.63
const E4 = 329.63
const E5 = 659.25
const E6 = 1318.51
const G4 = 392
const G5 = 783.99
const C5 = 523.25
const C6 = 1046.5

export const COMPLETION_SOUND_VARIANTS: readonly CompletionSoundVariant[] = [
  { id: 0, name: '无', play: () => undefined },
  {
    id: 1,
    name: '两音安抚',
    play: (ac, master, t0) => {
      voice(ac, master, t0, { freq: E4, dur: 0.22, gain: 0.05, attack: 0.03, type: 'sine' })
      voice(ac, master, t0 + 0.08, { freq: C4, dur: 0.52, gain: 0.07, attack: 0.08, type: 'sine' })
      voice(ac, master, t0 + 0.08, { freq: C3, dur: 0.46, gain: 0.02, attack: 0.1, type: 'sine' })
    }
  },
  {
    id: 2,
    name: '玻璃铃',
    play: (ac, master, t0) => {
      voice(ac, master, t0, { freq: C6, dur: 0.55, gain: 0.032, attack: 0.002, type: 'sine' })
      voice(ac, master, t0 + 0.01, { freq: E5, dur: 0.42, gain: 0.018, attack: 0.004, type: 'sine' })
      airPuff(ac, master, t0, { freq: 3200, gain: 0.004, decay: 0.1, q: 1.4 })
    }
  },
  {
    id: 3,
    name: '柔木琴',
    play: (ac, master, t0) => {
      pluckVoice(ac, master, t0, { freqFrom: E5, freqTo: G5, gain: 0.03, decay: 0.14, glide: 0.08 })
      bloomVoice(ac, master, t0 + 0.04, { freq: C5, gain: 0.028, attack: 0.08, hold: 0.04, decay: 0.62 })
      bloomVoice(ac, master, t0 + 0.06, { freq: G4, gain: 0.014, attack: 0.12, hold: 0.06, decay: 0.55 })
    }
  },
  {
    id: 4,
    name: '三音消息',
    play: (ac, master, t0) => {
      voice(ac, master, t0, { freq: C6, dur: 0.14, gain: 0.045, attack: 0.004, type: 'sine' })
      voice(ac, master, t0 + 0.1, { freq: A5, dur: 0.16, gain: 0.04, attack: 0.004, type: 'sine' })
      voice(ac, master, t0 + 0.2, { freq: G5, dur: 0.22, gain: 0.035, attack: 0.006, type: 'sine' })
    }
  },
  {
    id: 5,
    name: '气流嗖',
    play: (ac, master, t0) => {
      whooshVoice(ac, master, t0, { freqFrom: 4200, freqTo: 900, gain: 0.022, decay: 0.28, q: 0.7 })
      voice(ac, master, t0 + 0.12, { freq: A5, dur: 0.35, gain: 0.02, attack: 0.02, type: 'sine' })
    }
  },
  {
    id: 6,
    name: '发现音簇',
    play: (ac, master, t0) => {
      const clusterDetunes = [-14, -5, 0, 7, 12]

      clusterDetunes.forEach((detune, i) => {
        bloomVoice(ac, master, t0 + i * 0.03, {
          freq: A3,
          gain: 0.012,
          attack: 0.38,
          hold: 0.12,
          decay: 1.05,
          detune
        })
      })
      bloomVoice(ac, master, t0 + 0.1, { freq: E4, gain: 0.008, attack: 0.45, hold: 0.08, decay: 0.9, detune: 3 })
    }
  },
  {
    id: 7,
    name: '系统就绪',
    play: (ac, master, t0) => {
      voice(ac, master, t0, { freq: C5, dur: 0.16, gain: 0.04, attack: 0.006, type: 'sine' })
      voice(ac, master, t0 + 0.09, { freq: G5, dur: 0.28, gain: 0.042, attack: 0.008, type: 'sine' })
      voice(ac, master, t0 + 0.09, { freq: C4, dur: 0.24, gain: 0.012, attack: 0.01, type: 'sine' })
    }
  },
  {
    id: 8,
    name: 'IBM 终端',
    play: (ac, master, t0) => {
      voice(ac, master, t0, { freq: B5, dur: 0.12, gain: 0.038, attack: 0.002, type: 'square' })
      voice(ac, master, t0 + 0.14, { freq: E5, dur: 0.1, gain: 0.028, attack: 0.002, type: 'square' })
    }
  },
  {
    id: 9,
    name: '调制解调啁啾',
    play: (ac, master, t0) => {
      sweepVoice(ac, master, t0, { freqFrom: 320, freqTo: 2200, gain: 0.024, decay: 0.16, type: 'triangle' })
      sweepVoice(ac, master, t0 + 0.1, { freqFrom: 480, freqTo: 1400, gain: 0.014, decay: 0.12, type: 'sine' })
    }
  },
  {
    id: 10,
    name: '风铃',
    play: (ac, master, t0) => {
      const chimes = [G5, C6, E5, A5]

      chimes.forEach((frequency, i) => {
        voice(ac, master, t0 + i * 0.13, {
          freq: frequency,
          dur: 0.72,
          gain: 0.028 - i * 0.003,
          attack: 0.003,
          type: 'sine'
        })
      })
    }
  },
  {
    id: 11,
    name: '颂钵',
    play: (ac, master, t0) => {
      bloomVoice(ac, master, t0, { freq: A3, gain: 0.022, attack: 0.58, hold: 0.16, decay: 1.35 })
      bloomVoice(ac, master, t0 + 0.08, { freq: E4, gain: 0.01, attack: 0.62, hold: 0.12, decay: 1.2, detune: 4 })
      bloomVoice(ac, master, t0 + 0.14, { freq: A4, gain: 0.006, attack: 0.68, hold: 0.08, decay: 1.05, detune: -3 })
    }
  },
  {
    id: 12,
    name: '竖琴上扬',
    play: (ac, master, t0) => {
      const notes = [C5, E5, G5, C6]

      notes.forEach((frequency, i) => {
        voice(ac, master, t0 + i * 0.075, {
          freq: frequency,
          dur: 0.38,
          gain: 0.034 - i * 0.004,
          attack: 0.012,
          type: 'sine'
        })
      })

      bloomVoice(ac, master, t0 + 0.2, { freq: C4, gain: 0.01, attack: 0.18, hold: 0.06, decay: 0.7 })
    }
  },
  {
    id: 13,
    name: '声呐',
    play: (ac, master, t0) => {
      voice(ac, master, t0, { freq: A2, dur: 0.95, gain: 0.036, attack: 0.008, type: 'sine' })
      voice(ac, master, t0 + 0.42, { freq: A3, dur: 0.55, gain: 0.014, attack: 0.01, type: 'sine' })
      airPuff(ac, master, t0, { freq: 600, gain: 0.005, decay: 0.2, q: 0.5 })
    }
  },
  {
    id: 14,
    name: '音乐盒',
    play: (ac, master, t0) => {
      const notes = [E6, C6, G5, E5]

      notes.forEach((frequency, i) => {
        pluckVoice(ac, master, t0 + i * 0.09, {
          freqFrom: frequency,
          freqTo: frequency * 0.998,
          gain: 0.02 - i * 0.002,
          decay: 0.2,
          glide: 0.06
        })
      })
    }
  }
] as const

function playVariant(variantId: number) {
  if (variantId === NO_COMPLETION_SOUND_VARIANT_ID) {
    return
  }

  const variant = COMPLETION_SOUND_VARIANTS.find(v => v.id === variantId)

  if (!variant) {
    return
  }

  const ac = getAudioContext()

  if (!ac) {
    return
  }

  const master = ac.createGain()
  const tone = ac.createBiquadFilter()
  tone.type = 'lowpass'
  tone.frequency.setValueAtTime(3800, ac.currentTime)
  tone.Q.setValueAtTime(0.32, ac.currentTime)
  master.gain.setValueAtTime(0.48, ac.currentTime)
  master.connect(tone)

  const dry = ac.createGain()
  dry.gain.setValueAtTime(0.88, ac.currentTime)
  tone.connect(dry)
  dry.connect(ac.destination)

  const reverb = makeReverb(ac)
  const wet = ac.createGain()
  wet.gain.setValueAtTime(0.34, ac.currentTime)
  tone.connect(reverb)
  reverb.connect(wet)
  wet.connect(ac.destination)

  variant.play(ac, master, ac.currentTime + 0.01)
}

/** 设置页预览（hermes：绕过静音开关，"无"保持静默）。 */
export function previewCompletionSound(variantId?: number) {
  playVariant(resolveCompletionSoundVariantId(variantId ?? completionSoundVariantId()))
}

/** 运行期播放（回合完成）。派发端接线前无调用方——保留与 hermes 同
    语义的守卫（静音/无 → 不播）。跨窗口去重（hermes ownsAmbientCue）
    不适用：单窗口应用。 */
export function playCompletionSound(dedupeKey?: string) {
  void dedupeKey
  if (hapticsMuted()) {
    return
  }
  if (completionSoundVariantId() === NO_COMPLETION_SOUND_VARIANT_ID) {
    return
  }
  playVariant(completionSoundVariantId())
}

interface AirPuffSpec {
  decay: number
  freq: number
  gain: number
  q?: number
  start?: number
}

interface BloomSpec {
  attack: number
  decay: number
  detune?: number
  freq: number
  freqTo?: number
  gain: number
  hold?: number
  start?: number
  type?: OscType
}

interface PluckSpec {
  attack?: number
  decay: number
  freqFrom: number
  freqTo: number
  gain: number
  glide?: number
  start?: number
}

interface SweepSpec {
  attack?: number
  decay: number
  freqFrom: number
  freqTo: number
  gain: number
  start?: number
  type?: OscType
}

interface ToneSpec {
  attack?: number
  dur: number
  freq: number
  gain?: number
  start?: number
  type?: OscType
}

interface WhooshSpec {
  decay: number
  freqFrom: number
  freqTo: number
  gain: number
  q?: number
  start?: number
}

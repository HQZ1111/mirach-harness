/**
 * GPT-Live 全双工语音桥（hermes lib/voice-live.ts 的宿主移植，2026-11-11
 * 用户："复制hermes把moss live等双全工做个桥接层，能连接api"）。
 *
 * `voice.voice_chat_mode: gpt-live` 把链式 mic → STT → turn → TTS 循环换成
 * 一个 OpenAI 语音模型（gpt-live-1）——它同时听和说（WebRTC），自己没有
 * 工具；真工作经 `session.delegation.created` 委托给 agent 会话，回复经
 * `session.commentary.append` 流回、由语音转述。agent 保持全部能力
 * （模型选择、工具、审批）。
 *
 * 本模块只管传输（hermes 模块头原文）：
 * - 会话创建经宿主 Rust 桥（`pi_voice_live_session`——SDP 交换在服务端做，
 *   **OpenAI key 永不进前端**）；
 * - RTCPeerConnection（mic 入、语音出）与 `oai-events` 数据通道；
 * - transcript 累积 + 会话命令面（think/speak/instruct/mute/close）。
 * Vendor contract: https://developers.openai.com/api/docs/guides/live-delegation
 */

import { invoke } from '@tauri-apps/api/core'

export type VoiceChatMode = 'chained' | 'gpt-live' | 'moss-live'

export interface VoiceLiveStatus {
  mode: VoiceChatMode
  /** OpenAI GPT-Live 链就绪（gpt-live 模式用） */
  available: boolean
  reason: null | string
  model: string
  voice: string
  /** MOSS Live（模思）链就绪（moss-live 模式用）——key 链独立 */
  mossAvailable?: boolean
  mossModel?: string
  mossReason?: null | string
}

export interface LiveHistoryMessage {
  type: 'message'
  role: 'assistant' | 'developer' | 'user'
  content: Array<{ type: 'input_text' | 'output_text'; text: string }>
}

interface LiveServerEvent {
  type: string
  event_id?: string
  client_event_id?: string
  delta?: string
  start_ms?: number
  end_ms?: number
  delegation?: { id: string; type: string; target: string }
  error?: { type?: string; code?: null | string; message?: string; client_event_id?: string }
  usage?: { seconds?: number }
  reason?: string
  session?: { id: string }
}

export interface LiveTranscriptFragment {
  speaker: 'assistant' | 'user'
  text: string
  startMs: number
  endMs: number
}

export interface VoiceLiveHandlers {
  /** GPT-Live 向 agent 求助了。`context` 是最近的 transcript 窗口（最新在
   *  后）——delegation 本身不带文本。 */
  onDelegation: (delegationId: string, context: LiveTranscriptFragment[]) => void
  /** Vendor 侧错误。`fatal` = 会话已终结。 */
  onError: (message: string, fatal: boolean) => void
  /** `session.closed` 到了（或传输层先掉了）。 */
  onClosed: (reason: string, usageSeconds: null | number) => void
  /** Transcript 增量（字幕 / live UI）。 */
  onTranscript?: (fragment: LiveTranscriptFragment) => void
  /** 远端轨在说话（输出电平提示）。 */
  onSpeakingChange?: (speaking: boolean) => void
}

const CLOSE_TIMEOUT_MS = 15_000
const ICE_GATHER_TIMEOUT_MS = 10_000
// Vendor cap: 500 tokens per append. ~4 chars/token, keep headroom.
const APPEND_CHAR_LIMIT = 1_400
// 每次 delegation 附带的对话量（hermes :78-79 同值）。
const CONTEXT_WINDOW_MS = 5 * 60_000
const CONTEXT_MAX_FRAGMENTS = 80

/** 引擎状态面（宿主 Rust 桥：settings.json voice 段 → OPENAI_API_KEY 链，
 *  **永不返回 key**）。后端没接此面（旧二进制）= null → 链式。 */
export async function fetchVoiceLiveStatus(): Promise<null | VoiceLiveStatus> {
  try {
    const response = await invoke<{
      ok?: boolean
      available: boolean
      mode: string
      model: string
      reason?: null | string
      voice: string
      mossAvailable?: boolean
      mossModel?: string
      mossReason?: null | string
    }>('pi_voice_live_status')
    return {
      available: Boolean(response.available),
      mode:
        response.mode === 'gpt-live'
          ? 'gpt-live'
          : response.mode === 'moss-live'
            ? 'moss-live'
            : 'chained',
      model: response.model,
      reason: response.reason ?? null,
      voice: response.voice,
      mossAvailable: Boolean(response.mossAvailable),
      mossModel: response.mossModel ?? 'moss-live-1.0',
      mossReason: response.mossReason ?? null,
    }
  } catch {
    // 旧二进制没有该命令 → chained。
    return null
  }
}

/** 把回复切成 append 大小的块（按句界；vendor 500 token 上限留余量）。 */
export function chunkForCommentary(text: string, limit = APPEND_CHAR_LIMIT): string[] {
  const clean = text.replace(/\s+/g, ' ').trim()

  if (!clean) {
    return []
  }

  if (clean.length <= limit) {
    return [clean]
  }

  const chunks: string[] = []
  let current = ''

  for (const sentence of clean.split(/(?<=[.!?])\s+/)) {
    if (sentence.length > limit) {
      if (current) {
        chunks.push(current)
        current = ''
      }

      for (let index = 0; index < sentence.length; index += limit) {
        chunks.push(sentence.slice(index, index + limit))
      }

      continue
    }

    const candidate = current ? `${current} ${sentence}` : sentence

    if (candidate.length > limit) {
      chunks.push(current)
      current = sentence
    } else {
      current = candidate
    }
  }

  if (current) {
    chunks.push(current)
  }

  return chunks
}

/** 新 Live 会话的种子 history（聊天 transcript 的文本 turn，最新在前、
 *  字数预算封顶——hermes toLiveHistory :151-180 同款）。 */
export function toLiveHistory(
  turns: Array<{ role: 'assistant' | 'user'; text: string }>,
  maxMessages = 24,
  maxChars = 6_000
): LiveHistoryMessage[] {
  const out: LiveHistoryMessage[] = []
  let budget = maxChars

  for (const turn of [...turns].reverse()) {
    const text = turn.text.replace(/\s+/g, ' ').trim().slice(0, 1_200)

    if (!text) {
      continue
    }

    if (out.length >= maxMessages || budget - text.length < 0) {
      break
    }

    budget -= text.length
    out.unshift({
      content: [{ text, type: turn.role === 'assistant' ? 'output_text' : 'input_text' }],
      role: turn.role,
      type: 'message'
    })
  }

  return out
}

/** 把 transcript 片段流折成轮（hermes delegationPrompt :46-71 同款）：
 *  `prompt` = 用户最后说的（落库行），`context` = 近期口语交换（只进模型输入）。 */
export function delegationPrompt(context: LiveTranscriptFragment[]): { context: string; prompt: string } {
  const turns: Array<{ speaker: 'assistant' | 'user'; text: string }> = []

  for (const fragment of context) {
    const last = turns.at(-1)

    if (last && last.speaker === fragment.speaker) {
      last.text += fragment.text
    } else {
      turns.push({ speaker: fragment.speaker, text: fragment.text })
    }
  }

  const lastUser = [...turns].reverse().find(turn => turn.speaker === 'user')
  const prompt = (lastUser?.text ?? '').replace(/\s+/g, ' ').trim()

  const transcript = turns
    .map(turn => `${turn.speaker === 'user' ? 'User' : 'Voice assistant'}: ${turn.text.replace(/\s+/g, ' ').trim()}`)
    .filter(line => !line.endsWith(': '))
    .join('\n')

  return { context: transcript, prompt: prompt || transcript.slice(-400) }
}

/** 会话结束 toast 文案（hermes liveEndedMessage :73-94 同款）：connection_lost
 *  与 closed 是本机机器原因（有 i18n 文案）；其余 reason 是 vendor 发的，
 *  原样透传。 */
export function liveEndedMessage(
  reason: string,
  usageSeconds: null | number,
  copy: { liveEndedClosed: string; liveEndedConnectionLost: string }
): string {
  let text = reason?.trim() ?? ''

  if (text === 'connection_lost') {
    text = copy.liveEndedConnectionLost
  } else if (text === 'closed' || !text) {
    text = copy.liveEndedClosed
  }

  return usageSeconds != null ? `${text} (${Math.round(usageSeconds)}s)` : text
}

async function waitForIceGathering(connection: RTCPeerConnection): Promise<void> {
  if (connection.iceGatheringState === 'complete') {
    return
  }

  await new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      connection.removeEventListener('icegatheringstatechange', onState)
      // Trickle is fine: the vendor answers with the candidates it has.
      resolve()
    }, ICE_GATHER_TIMEOUT_MS)

    function onState() {
      if (connection.iceGatheringState !== 'complete') {
        return
      }

      window.clearTimeout(timeout)
      connection.removeEventListener('icegatheringstatechange', onState)
      resolve()
    }

    connection.addEventListener('icegatheringstatechange', onState)
    connection.addEventListener('connectionstatechange', () => {
      if (connection.connectionState === 'failed') {
        window.clearTimeout(timeout)
        reject(new Error('WebRTC connection failed'))
      }
    })
  })
}

export class VoiceLiveSession {
  readonly audio: HTMLAudioElement
  private readonly handlers: VoiceLiveHandlers
  private peer: null | RTCPeerConnection = null
  private events: null | RTCDataChannel = null
  private microphone: null | MediaStream = null
  private closeTimer: null | number = null
  private finalized = false
  private started = false
  private eventCounter = 0
  private transcript: LiveTranscriptFragment[] = []
  private speakingProbe: null | number = null
  private analyser: null | AnalyserNode = null
  private audioContext: null | AudioContext = null
  private lastSpeaking = false
  sessionId: null | string = null
  /** agent 正在回答的 delegation；旧 id 的迟到结果由会话钩子丢弃。 */
  activeDelegationId: null | string = null

  constructor(handlers: VoiceLiveHandlers) {
    this.handlers = handlers
    this.audio = new Audio()
    this.audio.autoplay = true
  }

  get connected(): boolean {
    return this.started && this.events?.readyState === 'open'
  }

  private nextEventId(prefix: string): string {
    this.eventCounter += 1

    return `${prefix}_${this.eventCounter}`
  }

  private send(event: Record<string, unknown>): boolean {
    if (!this.events || this.events.readyState !== 'open') {
      return false
    }

    this.events.send(JSON.stringify(event))

    return true
  }

  /** 近期对话（旧的在前），按时间与条数封顶。 */
  contextWindow(): LiveTranscriptFragment[] {
    const last = this.transcript.at(-1)

    if (!last) {
      return []
    }

    const floor = last.endMs - CONTEXT_WINDOW_MS

    return this.transcript.filter(fragment => fragment.endMs >= floor).slice(-CONTEXT_MAX_FRAGMENTS)
  }

  async start(history: LiveHistoryMessage[]): Promise<void> {
    if (this.peer) {
      throw new Error('GPT-Live session already started')
    }

    const connection = new RTCPeerConnection()
    this.peer = connection

    connection.addEventListener('track', event => {
      const stream = new MediaStream([event.track])
      this.audio.srcObject = stream
      void this.audio.play().catch(() => undefined)
      this.armSpeakingProbe(stream)
    })
    connection.addEventListener('connectionstatechange', () => {
      if (connection.connectionState === 'failed' || connection.connectionState === 'disconnected') {
        this.finish('connection_lost', null)
      }
    })

    this.microphone = await navigator.mediaDevices.getUserMedia({
      audio: { autoGainControl: true, echoCancellation: true, noiseSuppression: true }
    })

    for (const track of this.microphone.getAudioTracks()) {
      connection.addTrack(track, this.microphone)
    }

    // Register the data channel before the offer so its m-line is negotiated.
    const events = connection.createDataChannel('oai-events')
    this.events = events
    events.addEventListener('message', ({ data }) => this.handleEvent(String(data)))
    events.addEventListener('close', () => {
      if (!this.finalized) {
        this.finish('connection_lost', null)
      }
    })

    const offer = await connection.createOffer()
    await connection.setLocalDescription(offer)
    await waitForIceGathering(connection)

    const sdp = connection.localDescription?.sdp

    if (!sdp) {
      throw new Error('Missing local SDP offer')
    }

    // SDP 交换在宿主 Rust 桥做（hermes 走 gateway HTTP）——key 永不进前端。
    const response = await invoke<{
      ok: boolean
      session?: { id: string }
      transport?: { sdp: string; type: string }
    }>('pi_voice_live_session', { sdp, history })

    if (!response?.ok || !response.transport?.sdp) {
      throw new Error('GPT-Live session creation failed')
    }

    this.sessionId = response.session?.id ?? null
    await connection.setRemoteDescription({ sdp: response.transport.sdp, type: 'answer' })
  }

  /** 拆说话探针（interval + analyser + AudioContext）。重臂前必须先拆：
   *  'track' 事件每来一次就 arm 一次，AudioContext 是重量级对象（音频线程 +
   *  ~MB 级），只覆写引用不关旧的 = 每多一轨泄一个（2026-11-14 内存轮）。 */
  private disarmSpeakingProbe(): void {
    if (this.speakingProbe) {
      window.clearInterval(this.speakingProbe)
      this.speakingProbe = null
    }
    this.analyser?.disconnect()
    this.analyser = null
    void this.audioContext?.close().catch(() => undefined)
    this.audioContext = null
  }

  private armSpeakingProbe(stream: MediaStream): void {
    // 'track' 事件可能多次到达（重协商/多轨）——先拆旧的再建
    this.disarmSpeakingProbe()
    try {
      const context = new AudioContext()
      const source = context.createMediaStreamSource(stream)
      const analyser = context.createAnalyser()
      analyser.fftSize = 512
      source.connect(analyser)
      this.audioContext = context
      this.analyser = analyser
      const buffer = new Uint8Array(analyser.frequencyBinCount)
      let quietFrames = 0

      this.speakingProbe = window.setInterval(() => {
        analyser.getByteTimeDomainData(buffer)
        let peak = 0

        for (const sample of buffer) {
          peak = Math.max(peak, Math.abs(sample - 128))
        }

        const loud = peak > 6
        quietFrames = loud ? 0 : quietFrames + 1
        const speaking = loud || quietFrames < 4

        if (speaking !== this.lastSpeaking) {
          this.lastSpeaking = speaking
          this.handlers.onSpeakingChange?.(speaking)
        }
      }, 100)
    } catch {
      // No analyser → no speaking indicator; the conversation still works.
    }
  }

  private handleEvent(raw: string): void {
    let event: LiveServerEvent

    try {
      event = JSON.parse(raw) as LiveServerEvent
    } catch {
      return
    }

    switch (event.type) {
      case 'session.started':
        this.started = true
        this.sessionId = event.session?.id ?? this.sessionId

        return

      case 'session.input_transcript.delta':
      case 'session.output_transcript.delta': {
        const fragment: LiveTranscriptFragment = {
          endMs: event.end_ms ?? 0,
          speaker: event.type === 'session.input_transcript.delta' ? 'user' : 'assistant',
          startMs: event.start_ms ?? 0,
          text: event.delta ?? ''
        }

        this.transcript.push(fragment)

        if (this.transcript.length > 2_000) {
          this.transcript.splice(0, this.transcript.length - 1_500)
        }

        this.handlers.onTranscript?.(fragment)

        return
      }

      case 'session.delegation.created': {
        const id = event.delegation?.id

        if (id) {
          this.activeDelegationId = id
          this.handlers.onDelegation(id, this.contextWindow())
        }

        return
      }

      case 'error': {
        const code = event.error?.code ?? ''

        // 我们自己 close 之后的迟到 append 是预期噪声。
        if (code === 'context_injection_incomplete') {
          return
        }

        this.handlers.onError(event.error?.message ?? 'GPT-Live error', false)

        return
      }

      case 'session.closed':
        this.finish(event.reason ?? 'closed', event.usage?.seconds ?? null)

        return

      default:
        return
    }
  }

  /** live 模型的安静进度（"agent 正在跑测试…"）。 */
  think(delegationId: null | string, content: string): void {
    const text = content.replace(/\s+/g, ' ').trim().slice(0, APPEND_CHAR_LIMIT)

    if (text) {
      this.send({
        content: text,
        delegation_id: delegationId,
        event_id: this.nextEventId('think'),
        type: 'session.thinking.append'
      })
    }
  }

  /** 语音该转述的结果。 */
  speak(delegationId: null | string, content: string): void {
    for (const chunk of chunkForCommentary(content)) {
      this.send({
        content: chunk,
        delegation_id: delegationId,
        event_id: this.nextEventId('say'),
        type: 'session.commentary.append'
      })
    }
  }

  /** 中途调 live 人设（session 级）。 */
  instruct(content: string): void {
    const text = content.trim().slice(0, APPEND_CHAR_LIMIT)

    if (text) {
      this.send({
        content: text,
        delegation_id: null,
        event_id: this.nextEventId('instr'),
        type: 'session.instructions.append'
      })
    }
  }

  setMuted(muted: boolean): void {
    for (const track of this.microphone?.getAudioTracks() ?? []) {
      track.enabled = !muted
    }

    this.send({
      event_id: this.nextEventId(muted ? 'mute' : 'unmute'),
      type: muted ? 'session.input_audio.mute' : 'session.input_audio.unmute'
    })
  }

  /** 优雅关：先请求 `session.closed`，收到（或超时）后拆除。 */
  close(): void {
    if (this.finalized) {
      return
    }

    if (!this.send({ type: 'session.close' })) {
      this.finish('close_requested', null)

      return
    }

    this.closeTimer = window.setTimeout(() => this.finish('close_requested', null), CLOSE_TIMEOUT_MS)
  }

  private finish(reason: string, usageSeconds: null | number): void {
    if (this.finalized) {
      return
    }

    this.finalized = true

    if (this.closeTimer) {
      window.clearTimeout(this.closeTimer)
      this.closeTimer = null
    }

    this.disarmSpeakingProbe()
    this.microphone?.getTracks().forEach(track => track.stop())
    this.events?.close()
    this.peer?.close()
    this.audio.srcObject = null
    this.audio.pause()
    this.handlers.onClosed(reason, usageSeconds)
  }
}

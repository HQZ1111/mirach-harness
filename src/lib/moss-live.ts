/**
 * MOSS Live 双工语音桥（模思智能 platform.moss.cn 的 `moss-live-1.0`，
 * 2026-11-12——用户指名的 "moss live"；协议 = platform.moss.cn/docs/
 * reference/moss-live）。
 *
 * 与 GPT-Live 桥（voice-live.ts）同构的委托模型，传输不同：
 * - **WSS**（`wss://api.mosi.cn/v1/realtime`）而非 WebRTC——握手头
 *   `Authorization: Bearer $MOSS_API_KEY` 浏览器设不了，由 Rust 桥
 *   （pi_voice_moss.rs）代持 key 并转发事件/音频（`moss-live://*` 事件）；
 * - 上行音频 = 16kHz S16LE PCM（`0x00` 前缀由 Rust 加）真速率分帧；
 *   下行 = 48kHz S16LE PCM 裸帧，WebAudio 排队播放；
 * - **真双工**：模型说话时 mic 照送；`response.audio.stop`（barge-in）
 *   → 停该 run 播放 + 清队 + `playback.stopped`（带已播毫秒）；
 * - 委托 = `session.delegation.created`（objective + context），结果经
 *   `session.commentary.append`（≤2000 字/条）回报，进度经
 *   `session.thinking.append`——与宿主委托回路（voice-live-conversation）
 *   的 think/speak 面完全同签名，驱动组件零改动复用。
 *
 * transcript 事件是**全文覆盖**语义（data.text = 全量），与 GPT-Live 的
 * delta 追加不同——字幕走 store.setCaption（覆盖）。
 *
 * key 链：settings `voice.moss_live.api_key` → `MOSS_API_KEY` 环境变量，
 * 由 Rust 桥解析；前端永不接触 key。
 */

import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

import type { MossToolFlow } from './moss-tool-flow'

export interface MossLiveHandlers {
  /** live 模型委托给 agent：objective = 任务正文，context = 最近口语
   *  交换（≤6 条 ×600 字，官方随事件带）。 */
  onDelegation: (delegationId: string, info: { objective: string; context: string[] }) => void
  onError: (message: string, fatal: boolean) => void
  onClosed: (reason: string) => void
  /** transcript（全文覆盖语义——data.text 即全量）。 */
  onTranscript?: (speaker: 'user' | 'assistant', text: string) => void
  onSpeakingChange?: (speaking: boolean) => void
}

interface MossEvent {
  action: string
  data?: {
    session_id?: string
    error?: { code?: string; message?: string }
    text?: string
    run_id?: string
    turn_id?: string
    chunk_id?: string
    reason?: string
    delegation?: { id: string }
    objective?: string
    context?: string[]
    status?: string
    [k: string]: unknown
  }
}

const COMMENTARY_LIMIT = 2_000 // 协议上限：append ≤2000 Unicode 字符
const UPLINK_RATE = 16_000 // 上行 16kHz S16LE
const FRAME_MS = 64 // 采集聚合粒度（约 1024 样本/帧）

/** 采集 Worklet（内联 Blob 模块）：每 1024 个输入样本 post 一次 Float32
 *  单声道。`process` 返回 true 保持节点存活；无输入时直接返回，不 post。 */
const MOSS_MIC_WORKLET_SOURCE = `
class MossMicProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.buf = new Float32Array(1024)
    this.n = 0
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (!ch || ch.length === 0) return true
    let off = 0
    while (off < ch.length) {
      const take = Math.min(ch.length - off, this.buf.length - this.n)
      this.buf.set(ch.subarray(off, off + take), this.n)
      this.n += take
      off += take
      if (this.n === this.buf.length) {
        this.port.postMessage(this.buf.slice(0))
        this.n = 0
      }
    }
    return true
  }
}
registerProcessor('moss-mic-processor', MossMicProcessor)
`

/**
 * S16LE PCM → base64（上行帧载荷）。
 *
 * 必须按 **字节**（Uint8Array 视图）编码，不能把 Int16Array 采样值直接交给
 * `String.fromCharCode`：值 > 255（正常语音几乎必然）会生成 Latin1 之外的
 * 字符，`btoa` 抛 InvalidCharacterError——2026-11-15 真机日志实锤，是
 * "说话没反应"的最终根因（上行 0 帧）。
 */
export function pcm16ToBase64(pcm16: Int16Array): string {
  const bytes = new Uint8Array(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength)
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

export class MossLiveSession {
  sessionId: string | null = null
  activeDelegationId: string | null = null
  connected = false

  private handle: number | null = null
  private unlisteners: UnlistenFn[] = []
  private micStream: MediaStream | null = null
  private micCtx: AudioContext | null = null
  private micWorklet: AudioWorkletNode | null = null
  private micSink: GainNode | null = null
  private playbackCtx: AudioContext | null = null
  /** 首帧上行日志只打一次（排查"说话没反应"时确认采集真的在跑）。 */
  private firstUplinkLogged = false
  /** 页面卸载时关 WS（reload 不走 React cleanup，否则 Rust 侧会话泄漏）。 */
  private pageCloseHandler = (): void => {
    if (this.handle === null) return
    void invoke('pi_voice_moss_close', { handle: this.handle }).catch(() => undefined)
  }
  private inputEnabled = false
  private muted = false
  private finalized = false
  private uplinkBuf: number[] = []
  /** 播放队列（按序调度）；barge-in 按项停。键名随协议（run_id/turn_id/
   *  chunk_id）。 */
  private playQueue: {
    source: AudioBufferSourceNode
    run_id: string
    turn_id: string
    chunk_id: string
    startAt: number
  }[] = []
  private expectedChunk: { run_id: string; turn_id: string; chunk_id: string } | null = null
  /** 音频流已结束、等待播完确认的 run（协议：全部 chunk 播完才发
   *  playback.completed——2026-11-14 内存轮改成 onended 自摘队后，确认判定
   *  从"done 事件当下看队列"改为按 run 记账 + 每次 self-摘队后复查）。 */
  private doneRuns: Set<string> = new Set()
  /** 工具面态机（可选——start() 前经 attachToolFlow 挂；session.update 声明
   *  与 function_call 全回报路径都在态机里，本类只转发事件）。 */
  private toolFlow: MossToolFlow | null = null

  constructor(private handlers: MossLiveHandlers) {}

  /** 挂工具面（start() 前调用——session_attached 时发 session.update 声明）。 */
  attachToolFlow(flow: MossToolFlow): void {
    if (this.handle !== null) {
      throw new Error('attachToolFlow 必须在 start() 之前调用')
    }
    this.toolFlow = flow
  }

  /** 工具面态机的外发通道（conversation.item.create / response.create 等）。 */
  sendRawEvent(event: Record<string, unknown>): void {
    this.send(event)
  }

  async start(): Promise<void> {
    if (this.handle !== null) {
      throw new Error('MOSS Live session already started')
    }

    // 事件通道先于任何命令注册（Rust 桥 connect 后 vendor 立即发
    // session_attached，不丢帧的前提是监听先行）
    this.unlisteners.push(
      await listen<{ handle: number; text: string }>('moss-live://event', (e) => {
        if (e.payload.handle === this.handle) this.handleEvent(e.payload.text)
      }),
    )
    this.unlisteners.push(
      await listen<{ handle: number; audio: string }>('moss-live://audio', (e) => {
        if (e.payload.handle === this.handle) this.onAudioFrame(e.payload.audio)
      }),
    )
    this.unlisteners.push(
      await listen<{ handle: number; reason: string }>('moss-live://closed', (e) => {
        if (e.payload.handle !== this.handle || this.finalized) return
        this.finalized = true
        this.teardown()
        this.handlers.onClosed(e.payload.reason)
      }),
    )

    const opened = await invoke<{ handle: number }>('pi_voice_moss_open')
    this.handle = opened.handle
    // 页面 reload/关闭不会走 stop()：显式关 WS，避免 Rust 侧句柄与采集图
    // 在页面消失后继续存活（同类问题：原 ScriptProcessor 的音频图也泄漏）。
    window.addEventListener('pagehide', this.pageCloseHandler)

    // 会话挂载：client delegation（委托经宿主回路：thread append → 回读 →
    // commentary 回报）
    this.send({
      action: 'attach_session',
      session_id: null,
      delegation: { type: 'client' },
    })
    // 采集与播放图（mic_state 等 session_attached 后再开）
    this.openGraph()
  }

  private send(event: Record<string, unknown>): void {
    if (this.handle === null) return
    void invoke('pi_voice_moss_send_text', {
      handle: this.handle,
      text: JSON.stringify(event),
    }).catch((e) => console.error('[moss-live] 发送失败', e))
  }

  private sendAudioFrame(pcm16: Int16Array): void {
    if (this.handle === null) return
    if (!this.firstUplinkLogged) {
      this.firstUplinkLogged = true
      console.info('[moss-live] 首帧上行已发送', { samples: pcm16.length })
    }
    const b64 = pcm16ToBase64(pcm16)
    void invoke('pi_voice_moss_send_audio', { handle: this.handle, audio: b64 }).catch((e) =>
      console.error('[moss-live] 音频帧发送失败', e),
    )
  }

  // ── 采集：getUserMedia → AudioWorklet → 线性重采样 16k → Int16 聚合 ──
  //
  // **为什么不是 ScriptProcessorNode**（2026-11-15 真机实锤）：当前
  // WebView2 里 `createScriptProcessor` 的 `onaudioprocess` **一次都不触发**
  // （独立最小复现：context running、track live，2 秒 0 回调），上行因此
  // 永远是 0 帧——用户在应用里说话 MOSS 完全听不到（PowerShell WSS 协议
  // 测试正常，问题在采集端）。AudioWorklet 同一环境 2 秒 747 次回调，
  // 故改用 Worklet。
  //
  // Worklet 源内联为 Blob URL（不新增静态资源文件；CSP 允许 blob:）。
  // 每 1024 个输入样本（48k ≈ 21ms）post 一次，避免 128 样本/条的
  // postMessage 风暴。
  private openGraph(): void {
    void (async () => {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { autoGainControl: true, echoCancellation: true, noiseSuppression: true },
      })
      if (this.finalized) {
        stream.getTracks().forEach((t) => t.stop())
        return
      }
      this.micStream = stream
      const ctx = new AudioContext()
      this.micCtx = ctx
      this.playbackCtx = new AudioContext()
      // 采集上下文必须 running；创建后显式 resume（WebView2 实测可能
      // 初始 suspended，ScriptProcessor 时代就是被这个静默吞掉采集）。
      await ctx.resume()
      const moduleUrl = URL.createObjectURL(
        new Blob([MOSS_MIC_WORKLET_SOURCE], { type: 'application/javascript' }),
      )
      try {
        await ctx.audioWorklet.addModule(moduleUrl)
      } finally {
        URL.revokeObjectURL(moduleUrl)
      }
      if (this.finalized) {
        stream.getTracks().forEach((t) => t.stop())
        return
      }
      const source = ctx.createMediaStreamSource(stream)
      const worklet = new AudioWorkletNode(ctx, 'moss-mic-processor')
      worklet.port.onmessage = (e: MessageEvent) => {
        if (!this.inputEnabled || this.muted || this.finalized) return
        const samples = e.data
        if (!(samples instanceof Float32Array) || samples.length === 0) return
        this.upsampleTo16k(samples, ctx.sampleRate)
      }
      // 静音 sink：WorkletNode 必须接下游才会被音频图拉动；gain=0 不发声。
      const sink = ctx.createGain()
      sink.gain.value = 0
      source.connect(worklet)
      worklet.connect(sink)
      sink.connect(ctx.destination)
      this.micWorklet = worklet
      this.micSink = sink
      console.info('[moss-live] 麦克风采集已启动', {
        sampleRate: ctx.sampleRate,
        state: ctx.state,
        track: stream.getAudioTracks()[0]?.label,
      })
    })().catch((e) => {
      this.handlers.onError(
        e instanceof DOMException ? `麦克风不可用：${e.message}` : String(e),
        true,
      )
    })
  }

  /** 线性插值降采样到 16k → S16LE → 聚合整帧上行。 */
  private upsampleTo16k(input: Float32Array, inputRate: number): void {
    const ratio = inputRate / UPLINK_RATE
    const outLen = Math.floor(input.length / ratio)
    let int16 = new Int16Array(outLen)
    for (let i = 0; i < outLen; i += 1) {
      const pos = i * ratio
      const i0 = Math.floor(pos)
      const i1 = Math.min(i0 + 1, input.length - 1)
      const frac = pos - i0
      const sample = input[i0] * (1 - frac) + input[i1] * frac
      int16[i] = Math.max(-32768, Math.min(32767, Math.round(sample * 32767)))
    }
    this.uplinkBuf.push(...int16)
    int16 = new Int16Array(0)
    // 聚到整帧再发（FRAME_MS @16k = 1024 样本）
    while (this.uplinkBuf.length >= (UPLINK_RATE / 1000) * FRAME_MS) {
      const frame = new Int16Array(this.uplinkBuf.splice(0, Math.floor((UPLINK_RATE / 1000) * FRAME_MS)))
      this.sendAudioFrame(frame)
    }
  }

  // ── 播放：base64 PCM16 48k → AudioBuffer 排队；barge-in 可停 ──
  private onAudioFrame(b64: string): void {
    if (!this.playbackCtx) return
    const binary = atob(b64)
    const samples = new Int16Array(binary.length / 2)
    for (let i = 0; i < samples.length; i += 1) {
      samples[i] =
        (binary.charCodeAt(i * 2) | (binary.charCodeAt(i * 2 + 1) << 8)) | 0
    }
    const buffer = this.playbackCtx.createBuffer(1, samples.length, 48_000)
    const data = buffer.getChannelData(0)
    for (let i = 0; i < samples.length; i += 1) {
      data[i] = samples[i] / 32768
    }

    const expected = this.expectedChunk
    const source = this.playbackCtx.createBufferSource()
    source.buffer = buffer
    source.connect(this.playbackCtx.destination)
    const last = this.playQueue.at(-1)
    const startAt = Math.max(
      this.playbackCtx.currentTime + 0.02,
      last ? last.startAt + last.source.buffer!.duration : 0,
    )
    const item: (typeof this.playQueue)[number] = {
      source,
      run_id: expected?.run_id ?? '',
      turn_id: expected?.turn_id ?? '',
      chunk_id: expected?.chunk_id ?? '',
      startAt,
    }
    source.onended = () => {
      // 播完自摘（2026-11-14 内存轮：原来只在 barge-in 摘队，正常播完的
      // 节点+AudioBuffer（48kHz float32）整段会话永久保留——1 分钟语音
      // ≈11.5MB，长会话涨数百 MB 的主因）
      this.playQueue = this.playQueue.filter((p) => p.source !== item.source)
      if (expected) {
        this.send({
          action: 'playback.chunk.completed',
          run_id: expected.run_id,
          turn_id: expected.turn_id,
          chunk_id: expected.chunk_id,
        })
        this.maybeCompletePlayback(expected.run_id, expected.turn_id)
      }
    }
    source.start(startAt)
    this.playQueue.push(item)
  }

  /** run 的全部 chunk 播完（队列清空）→ playback.completed（协议确认；
   *  done 记账后每次 self-摘队复查——最后一个 onended 触发发送）。 */
  private maybeCompletePlayback(runId: string, turnId: string): void {
    if (!runId || !this.doneRuns.has(runId)) return
    if (this.playQueue.some((p) => p.run_id === runId)) return
    this.doneRuns.delete(runId)
    this.send({ action: 'playback.completed', run_id: runId, turn_id: turnId })
  }

  private stopPlaybackFor(runId: string, turnId: string): void {
    let playedMs = 0
    const keep: typeof this.playQueue = []
    for (const item of this.playQueue) {
      if (item.run_id === runId && item.turn_id === turnId) {
        try {
          item.source.stop()
        } catch {
          // 已播完的源 stop 会抛——忽略
        }
        playedMs = Math.max(playedMs, Math.round((this.playbackCtx!.currentTime - item.startAt) * 1000))
      } else {
        keep.push(item)
      }
    }
    this.playQueue = keep
    if (runId) {
      this.send({
        action: 'playback.stopped',
        run_id: runId,
        turn_id: turnId,
        played_audio_ms: Math.max(0, playedMs),
      })
    }
  }

  private handleEvent(text: string): void {
    let event: MossEvent
    try {
      event = JSON.parse(text) as MossEvent
    } catch {
      return
    }
    const data = event.data ?? {}

    // 工具面事件（function_call 到达/确认/取消）先经态机——其余照旧
    if (this.toolFlow?.owns(event.action)) {
      this.toolFlow.handleEvent(event.action, data)
      return
    }

    switch (event.action) {
      case 'session_attached': {
        this.sessionId = data.session_id ?? null
        this.connected = true
        // **二进制音频通道声明（2026-11-15 真机实锤，缺了它说话完全没反应）**：
        // 官方参考顺序 = attach_session → `media.mode`(binary_protocol:
        // "tagged-v1") → mic_state → 上行二进制音频。不声明 media.mode 时
        // 服务端**静默忽略**所有 0x00+PCM16 帧（连接不断、不报错——这就是
        // "聆听中但没反应"的根因）。补上后 input.speech.started /
        // input.transcript.updated / done 立即出现。
        this.send({ action: 'media.mode', binary_protocol: 'tagged-v1' })
        // 工具面声明（session.update 整表替换——mic_state 前发，模型一开口
        // 就带着工具；声明被 vendor 拒绝经 session.updated data.error 暴露）
        this.toolFlow?.announce()
        // 开麦（官方：attach 后 mic_state 打开输入；模型自己断句）
        this.inputEnabled = !this.muted
        this.send({ action: 'mic_state', enabled: !this.muted })
        return
      }

      case 'session.updated': {
        const msg = data.error?.message
        if (msg) this.handlers.onError(msg, false)
        return
      }

      case 'input.transcript.updated':
      case 'input.transcript.done':
        this.handlers.onTranscript?.('user', data.text ?? '')
        return

      case 'output.transcript.updated':
      case 'output.transcript.done':
        this.handlers.onTranscript?.('assistant', data.text ?? '')
        return

      case 'session.delegation.created': {
        const id = data.delegation?.id
        if (id) {
          this.activeDelegationId = id
          // 协议 context 是 [{role, content}] 对象数组（实测），不是 string[]。
          // 直接 join 会显示 "[object Object]"；归一成可读行（role: content）。
          const rawContext: unknown[] = Array.isArray(data.context) ? data.context : []
          const context = rawContext.map((entry) => {
            if (typeof entry === 'string') return entry
            if (entry && typeof entry === 'object') {
              const item = entry as { role?: unknown; content?: unknown }
              const content =
                typeof item.content === 'string' ? item.content : JSON.stringify(item)
              return typeof item.role === 'string' && item.role
                ? `${item.role}: ${content}`
                : content
            }
            return String(entry)
          })
          this.handlers.onDelegation(id, {
            objective: data.objective ?? '',
            context,
          })
        }
        return
      }

      case 'response.audio.started':
        this.handlers.onSpeakingChange?.(true)
        return

      case 'response.audio.context':
        this.expectedChunk = {
          run_id: data.run_id ?? '',
          turn_id: data.turn_id ?? '',
          chunk_id: data.chunk_id ?? '',
        }
        return

      case 'response.audio.done':
        this.handlers.onSpeakingChange?.(false)
        // 该 run 音频流结束——completed 等全部 chunk 播完（onended 自摘后
        // 复查；done 当下队列可能还有未播帧，原来"当下看队列"会漏发）
        const doneRun = data.run_id ?? ''
        if (doneRun) {
          this.doneRuns.add(doneRun)
          this.maybeCompletePlayback(doneRun, data.turn_id ?? '')
        }
        return

      case 'response.audio.stop':
        this.handlers.onSpeakingChange?.(false)
        // barge-in：停播 + 清队 + 确认（played_audio_ms = 已播部分）
        this.stopPlaybackFor(data.run_id ?? '', data.turn_id ?? '')
        return

      case 'response.interrupted':
        this.handlers.onSpeakingChange?.(false)
        return

      case 'response.ended':
        // turn 终态（completed/aborted/failed）——委托由驱动在 commentary
        // 发完后清（同 GPT-Live 语义），这里不动 activeDelegationId
        return

      case 'error': {
        const message = data.error?.message ?? 'MOSS Live error'
        this.handlers.onError(message, false)
        return
      }

      default:
        return
    }
  }

  /** 安静进度（协议：thinking.append，≤2000 字）。 */
  think(delegationId: string | null, content: string): void {
    const text = content.replace(/\s+/g, ' ').trim().slice(0, COMMENTARY_LIMIT)
    if (text) {
      this.send({
        action: 'session.thinking.append',
        content: text,
        delegation_id: delegationId,
        status: 'in_progress',
      })
    }
  }

  /** 语音该转述的结果（协议：commentary.append；status=completed 表示
   *  委托结果落地——驱动在收尾时调用并随后清委托）。 */
  speak(delegationId: string | null, content: string): void {
    const clean = content.replace(/\s+/g, ' ').trim()
    if (!clean) return
    for (let i = 0; i < clean.length; i += COMMENTARY_LIMIT) {
      const isTail = i + COMMENTARY_LIMIT >= clean.length
      this.send({
        action: 'session.commentary.append',
        content: clean.slice(i, i + COMMENTARY_LIMIT),
        delegation_id: delegationId,
        status: isTail ? 'completed' : 'in_progress',
      })
    }
  }

  /** 会话级指令（协议：instructions.append）。 */
  instruct(content: string): void {
    const text = content.trim().slice(0, COMMENTARY_LIMIT)
    if (text) {
      this.send({ action: 'session.instructions.append', content: text })
    }
  }

  setMuted(muted: boolean): void {
    this.muted = muted
    this.inputEnabled = !muted
    this.send({ action: 'mic_state', enabled: !muted })
  }

  /** 拆线（协议：关 WSS 即拆除，vendor 发 session.closing 收尾）。 */
  close(): void {
    if (this.finalized) return
    this.finalized = true
    if (this.handle !== null) {
      void invoke('pi_voice_moss_close', { handle: this.handle }).catch(() => undefined)
    }
    this.teardown()
  }

  private teardown(): void {
    if (typeof window !== 'undefined') {
      window.removeEventListener('pagehide', this.pageCloseHandler)
    }
    this.unlisteners.forEach((u) => u())
    this.unlisteners = []
    this.playQueue.forEach((p) => {
      try {
        p.source.stop()
      } catch {
        // 已播完的源——忽略
      }
    })
    this.playQueue = []
    this.doneRuns.clear()
    if (this.micWorklet) {
      this.micWorklet.port.onmessage = null
      this.micWorklet.disconnect()
      this.micWorklet = null
    }
    if (this.micSink) {
      this.micSink.disconnect()
      this.micSink = null
    }
    this.micStream?.getTracks().forEach((t) => t.stop())
    this.micStream = null
    void this.micCtx?.close().catch(() => undefined)
    this.micCtx = null
    void this.playbackCtx?.close().catch(() => undefined)
    this.playbackCtx = null
    this.connected = false
  }
}

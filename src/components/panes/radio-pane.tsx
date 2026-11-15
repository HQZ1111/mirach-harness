/**
 * 电台面板（hermes `apps/desktop/src/plugins/radio/plugin.js` 的移植，
 * 2026-11-15）。**单文件形态**：上游就是一个 `plugin.js`，这里保持一致——
 * 纯逻辑 + 播放内核 + 面板 UI 三段，按 §1/§2/§3 顺序排列。
 *
 * 上游是 Hermes Desktop 的状态栏插件（Popover 面板 + 状态栏波形条）。
 * 宿主（Mirach）**已撤除底栏**（`dockview-shell.tsx` 用户定稿："底栏不要了"），
 * 且没有 `@hermes/plugin-sdk` —— 所以这里落在 **dockview 的一个窗格**：
 * 「打开页」和标签条 `+` 菜单都能开它，与文件树/终端/预览同级。
 *
 * 版式（用户定稿）：**选台列表占满面板，播放器沉到底部单独一条元素区**
 * （不是右侧分栏）。
 *
 * ## 与上游逐项对照
 *
 * | 上游（plugin.js） | 本文件 | 说明 |
 * |---|---|---|
 * | `PRESETS` / `httpsUrl` / `validStation` / `sameStation` / `uniqueStations` | §1 | 逐条搬运 |
 * | `searchStations`（Radio Browser 镜像 + 检索） | §1 + `RadioPlayer.searchStations` | 同参数、同丢弃规则 |
 * | `createPlayer`（播放内核闭包） | §2 `RadioPlayer` 类 | 闭包 → 类，语义不变 |
 * | `trackCredit` / `pickSource`（曲目解析） | §1 | 逐条搬运 |
 * | `brailleTrace` / `Waveform` | §1 + §3 | 12fps、两层余辉、reduced-motion 冻结 |
 * | `RadioBar`（状态栏紧凑条） | §3 底部播放条 | 波形 + 台名 + 播放/切台 |
 * | `Stations`（Popover 里的选台） | §3 面板主体 | 搜索 → 置顶/预设/检索结果 |
 * | `Signal`（波形 + 曲目 + 艺人） | §3 底部播放条 | 波形整宽 + 曲目行 |
 * | `Transport`（音量/静音/官网） | §3 底部播放条 | 同钮集 |
 * | 状态栏 `STATUSBAR_AREAS.right` | 无（宿主无底栏） | 改窗格入口 |
 * | 跨窗口 `BroadcastChannel` 互斥 | §2 | 内核保留（设置独立窗也会停） |
 *
 * 上游用 `ctx.os.openExternal` 打开外链；宿主走 `fs_open_url` IPC。
 */

import { invoke } from '@tauri-apps/api/core'
import {
  ExternalLink,
  Loader2,
  Pause,
  Play,
  Pin,
  Radio as RadioIcon,
  SkipForward,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react'
import { atom, type WritableAtom } from 'nanostores'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { RowButton } from '@/components/ui/row-button'
import { SearchField } from '@/components/ui/search-field'
import { Tip } from '@/components/ui/tip'
import { inTauri } from '@/lib/tauri-window'

// ═══════════════════════════════════════════════════════════════════════════════
// §1 纯逻辑（原 radio-stations.ts）——预设台、URL 校验、目录映射、波形编码
// ═══════════════════════════════════════════════════════════════════════════════
export interface Station {
  id: string
  name: string
  /** 流地址（https 或本机回环 http，见 `streamUrlOrNull`）。 */
  url: string
  provider?: string
  description?: string
  homepage?: string
}

const NIGHTRIDE = 'https://stream.nightride.fm/'

/** 上游 `PRESETS` 逐字搬运（7 台）。 */
export const PRESET_STATIONS: readonly Station[] = [
  {
    id: 'chillsynth',
    name: 'Chillsynth',
    description: 'Soft focus · warm synths',
    provider: 'Nightride FM',
    url: `${NIGHTRIDE}chillsynth.mp3`,
    homepage: 'https://nightride.fm/?station=chillsynth',
  },
  {
    id: 'nightride',
    name: 'Nightride',
    description: 'Synthwave · after hours',
    provider: 'Nightride FM',
    url: `${NIGHTRIDE}nightride.mp3`,
    homepage: 'https://nightride.fm/',
  },
  {
    id: 'darksynth',
    name: 'Darksynth',
    description: 'Dark electronics · high energy',
    provider: 'Nightride FM',
    url: `${NIGHTRIDE}darksynth.mp3`,
    homepage: 'https://nightride.fm/?station=darksynth',
  },
  {
    id: 'spacesynth',
    name: 'Spacesynth',
    description: 'Cosmic synths · retro futures',
    provider: 'Nightride FM',
    url: `${NIGHTRIDE}spacesynth.mp3`,
    homepage: 'https://nightride.fm/?station=spacesynth',
  },
  {
    id: 'paradise-main',
    name: 'Main Mix',
    description: 'Eclectic · human selected',
    provider: 'Radio Paradise',
    url: 'https://stream.radioparadise.com/aac-128',
    homepage: 'https://radioparadise.com/',
  },
  {
    id: 'paradise-mellow',
    name: 'Mellow Mix',
    description: 'A gentler pace',
    provider: 'Radio Paradise',
    url: 'https://stream.radioparadise.com/mellow-flac',
    homepage: 'https://radioparadise.com/',
  },
  {
    id: 'eve-radio',
    name: 'EVE Radio',
    description: 'GamingNow · EVE community radio',
    provider: 'GamingNow',
    url: 'https://media01.gamingnow.net:8010/erweb.mp3',
    homepage: 'https://gamingnow.net/eve-radio/',
  },
] as const

/** Radio Browser 的元数据端点（上游 `Signal` 组件的 `endpoints` 表）。 */
export const METADATA_ENDPOINTS: Record<string, string> = {
  'stream.nightride.fm': `${NIGHTRIDE}status-json.xsl`,
  'media01.gamingnow.net': 'https://media01.gamingnow.net:8010/status-json.xsl',
}

/** 本机回环（CSP 允许 http 的唯一情况，上游注释同口径）。 */
function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1'
}

/**
 * 校验并归一一个流/主页地址。上游 `httpsUrl()` 只收 https；宿主额外放行
 * 本机回环 http（自制电台跑在 localhost 是常见用法），其余一律 null。
 */
export function streamUrlOrNull(value: unknown): null | string {
  if (typeof value !== 'string' || !value) return null
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  // 凭据写在 URL 里一律拒绝（上游同判据：`!url.username && !url.password`）
  if (url.username || url.password) return null
  if (url.protocol === 'https:') return url.href
  if (url.protocol === 'http:' && isLoopbackHost(url.hostname)) return url.href
  return null
}

/** 严格 https（主页/艺人页用：本机回环对"官网"没有意义）。 */
export function httpsUrlOrNull(value: unknown): null | string {
  const href = streamUrlOrNull(value)
  if (!href) return null
  return new URL(href).protocol === 'https:' ? href : null
}

/** 上游 `validStation()`：id/name 必须是字符串，url 必须过校验。 */
export function isValidStation(value: unknown): value is Station {
  if (!value || typeof value !== 'object') return false
  const station = value as Partial<Station>
  return typeof station.id === 'string' && typeof station.name === 'string' && Boolean(streamUrlOrNull(station.url))
}

/** 上游 `sameStation()`：同 id 或同流地址即同一台。 */
export function isSameStation(a: Station, b: Station): boolean {
  return a.id === b.id || a.url === b.url
}

/** 上游 `uniqueStations()`：按 id + url 双键去重，保序。 */
export function uniqueStations(items: readonly Station[]): Station[] {
  const ids = new Set<string>()
  const urls = new Set<string>()
  return items.filter((item) => {
    if (ids.has(item.id) || urls.has(item.url)) return false
    ids.add(item.id)
    urls.add(item.url)
    return true
  })
}

/** Radio Browser 的一个返回行（只声明用到的字段）。 */
export interface DirectoryRow {
  stationuuid?: string
  name?: string
  url_resolved?: string
  homepage?: string
  tags?: string
  hls?: number | boolean
}

/**
 * 把 Radio Browser 行映射成宿主 Station（上游 `searchStations` 的 flatMap
 * 逐条对应）：坏行丢弃、HLS 跳过、同 url 去重、tags 取前两个当描述。
 */
export function mapDirectoryRows(rows: unknown): Station[] {
  if (!Array.isArray(rows)) return []
  const seen = new Set<string>()
  const out: Station[] = []
  for (const raw of rows as DirectoryRow[]) {
    const url = streamUrlOrNull(raw?.url_resolved)
    if (!url || !raw?.stationuuid || !raw?.name || raw.hls) continue
    if (seen.has(url)) continue
    seen.add(url)
    out.push({
      id: raw.stationuuid,
      name: raw.name.trim(),
      url,
      provider: 'Radio Browser',
      description: raw.tags?.split(',').slice(0, 2).join(' · ') || '',
      homepage: httpsUrlOrNull(raw.homepage) ?? undefined,
    })
  }
  return out
}

/**
 * 镜像发现：上游只认 `^[a-z0-9-]+\.api\.radio-browser\.info$` 形态的
 * `servers[].name`，再打乱顺序（负载分摊）。返回去重后的 https 基址。
 */
export function directoryServersFrom(payload: unknown, random: () => number = Math.random): string[] {
  const servers = (payload as { servers?: unknown } | null)?.servers
  if (!Array.isArray(servers)) return []
  const hosts = new Set<string>()
  for (const server of servers) {
    const name = (server as { name?: unknown } | null)?.name
    if (typeof name === 'string' && /^[a-z0-9-]+\.api\.radio-browser\.info$/.test(name)) hosts.add(name)
  }
  // 洗牌：与上游 `.sort(() => Math.random() - 0.5)` 同目的（分散负载）。
  // 显式 Fisher–Yates，便于注入 random 做确定性单测。
  const list = [...hosts]
  for (let i = list.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1))
    const tmp = list[i]!
    list[i] = list[j]!
    list[j] = tmp
  }
  return list.map((host) => `https://${host}`)
}

/** 默认镜像（上游 `directoryServers` 初值）。 */
export const DEFAULT_DIRECTORY_SERVERS: readonly string[] = ['https://de1.api.radio-browser.info']

/** 检索参数（上游 `URLSearchParams` 逐字对照）。 */
export function directorySearchPath(text: string): string {
  const params = new URLSearchParams({ name: text, limit: '60', hidebroken: 'true', order: 'votes', reverse: 'true' })
  return `/json/stations/search?${params.toString()}`
}

/** 上游 `trackCredit()`：把 "Artist - Title" 拆成两段，显式 artist 优先。 */
export function trackCredit(source: null | { artist?: unknown; title?: unknown; metadata?: { artist?: unknown } }): {
  artist: string
  title: string
} {
  const raw = typeof source?.title === 'string' ? source.title.trim() : ''
  const explicitCandidate = source?.artist ?? source?.metadata?.artist
  const explicit = typeof explicitCandidate === 'string' ? explicitCandidate.trim() : ''
  const parts = raw.match(/^(.+?)\s[-–—]\s(.+)$/)
  const artist = explicit || parts?.[1]?.trim() || ''
  // 只有前缀真的等于 artist 时才拆开（上游注释：避免误拆标题里的横线）
  const title = parts && parts[1]?.trim() === artist ? (parts[2]?.trim() ?? raw) : raw
  return { artist: raw ? artist : '', title }
}

/** 从 Icecast status-json 里挑出当前台的 source（上游 `Signal` 同逻辑）。 */
export function pickSource(payload: unknown, streamPath: string): null | Record<string, unknown> {
  const sources = (payload as { icestats?: { source?: unknown } } | null)?.icestats?.source
  const list = Array.isArray(sources) ? sources : sources ? [sources] : []
  const match = list.find((item) => {
    const listenurl = (item as { listenurl?: unknown } | null)?.listenurl
    return typeof listenurl === 'string' && listenurl.endsWith(streamPath)
  })
  return (match as Record<string, unknown> | undefined) ?? null
}

/**
 * braille 波形采样 → 盲文字符串（上游 `brailleTrace` 逐行搬运）。
 *
 * 2 列像素/字符 + 每组 4 点/行；`dots` 是盲文点阵的位掩码。
 */
export function brailleTrace(samples: readonly number[], rows = 2): string[] {
  const width = Math.floor(samples.length / 2)
  const cells = new Array<number>(width * rows).fill(0)
  const dots = [
    [1, 2, 4, 64],
    [8, 16, 32, 128],
  ]
  const center = (rows * 4 - 1) / 2
  const rowOf = (value: number) => Math.max(0, Math.min(rows * 4 - 1, Math.round(center - value * center)))
  let previous = rowOf(samples[0] ?? 0)
  samples.forEach((value, x) => {
    const y = rowOf(value)
    const from = Math.min(previous, y)
    const to = Math.max(previous, y)
    for (let point = from; point <= to; point += 1) {
      const cellIndex = Math.floor(point / 4) * width + Math.floor(x / 2)
      cells[cellIndex] = (cells[cellIndex] ?? 0) | (dots[x % 2]?.[point % 4] ?? 0)
    }
    previous = y
  })
  return cells.map((cell) => String.fromCharCode(0x2800 | cell))
}

/** 空波形（与 `brailleTrace` 同宽，全零 = 一条平线）。 */
export function flatTrace(width: number, rows = 2): string[] {
  return brailleTrace(new Array<number>(width * 2).fill(0), rows)
}
// ═══════════════════════════════════════════════════════════════════════════════
// §2 播放内核（原 radio-player.ts）——Audio + WebAudio 分析 + 跨窗互斥
// ═══════════════════════════════════════════════════════════════════════════════

export type RadioStatus = 'paused' | 'connecting' | 'live' | 'error' | 'elsewhere'
export type MeterMode = 'levels' | 'activity'

const STORAGE = {
  favorites: 'mirach.radio.favorites',
  station: 'mirach.radio.station',
  volume: 'mirach.radio.volume',
  artistRequestAt: 'mirach.radio.artistRequestAt',
} as const

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch (e) {
    // 规矩 11：坏档可见，不静默吞成默认值
    console.error('[radio] 读取偏好失败', key, e)
    return fallback
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch (e) {
    console.error('[radio] 写入偏好失败', key, e)
  }
}

function clampVolume(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)))
}

/** 上游 `fetchJson`：10s 超时 + `credentials: 'omit'`。 */
async function fetchJson(url: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(url, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    credentials: 'omit',
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json()
}

/** 上游 `createBudgetedLoop` 的最小对偶：12fps + 失焦不跑 + idle 判据。 */
function createBudgetedLoop(tick: () => void, options: { fps: number; idleWhen?: () => boolean }) {
  let raf = 0
  let last = 0
  const period = 1000 / options.fps
  const step = (now: number) => {
    raf = requestAnimationFrame(step)
    if (options.idleWhen?.()) return
    if (now - last < period) return
    last = now
    tick()
  }
  return {
    start: () => {
      if (!raf) raf = requestAnimationFrame(step)
    },
    stop: () => {
      if (raf) cancelAnimationFrame(raf)
      raf = 0
    },
  }
}

export interface RadioPlayerOptions {
  /** 注入目录服务器（单测用）；省略则按上游自动发现。 */
  directoryServers?: string[]
  /** 跨窗口互斥通道；单测/渲染进程不可用时传 null。 */
  channel?: BroadcastChannel | null
}

export class RadioPlayer {
  readonly station: WritableAtom<Station>
  readonly favorites: WritableAtom<Station[]>
  readonly volume: WritableAtom<number>
  readonly status: WritableAtom<RadioStatus>
  readonly meterMode: WritableAtom<MeterMode>

  /** 当前波形采样（-1..1），空闲时为 null（UI 显示平线）。 */
  private waveformData = new Float32Array(2048)
  private audio: HTMLAudioElement | null = null
  private audioContext: AudioContext | null = null
  private analyser: AnalyserNode | null = null
  private source: MediaElementAudioSourceNode | null = null
  private output: GainNode | null = null
  private readonly plainStreams = new Set<string>()
  private generation = 0
  private playGeneration = -1
  private timeout: null | ReturnType<typeof setTimeout> = null
  private disposed = false
  private lastVolume: number
  private readonly channel: null | BroadcastChannel
  private readonly windowId = `radio-${Math.random().toString(36).slice(2)}`
  private readonly meterLoop: ReturnType<typeof createBudgetedLoop>
  private directoryServers: string[]
  private directoryDiscovered = false
  private readonly options: RadioPlayerOptions

  constructor(options: RadioPlayerOptions = {}) {
    this.options = options
    this.directoryServers = options.directoryServers ?? [...DEFAULT_DIRECTORY_SERVERS]

    const savedFavorites = readJson<unknown>(STORAGE.favorites, [])
    this.favorites = atom(
      Array.isArray(savedFavorites) ? savedFavorites.filter(isValidStation) : ([] as Station[]),
    )

    const savedStation = readJson<unknown>(STORAGE.station, null)
    this.station = atom(isValidStation(savedStation) ? savedStation : PRESET_STATIONS[0]!)

    const storedVolume = readJson<unknown>(STORAGE.volume, 25)
    this.volume = atom(Number.isFinite(storedVolume) ? clampVolume(Number(storedVolume)) : 25)
    this.lastVolume = this.volume.get() || 25

    this.status = atom<RadioStatus>('paused')
    this.meterMode = atom<MeterMode>('levels')

    this.channel = options.channel === undefined ? this.openChannel() : options.channel
    if (this.channel) {
      this.channel.onmessage = (event: MessageEvent) => {
        const data = event.data as { type?: string; sender?: string } | null
        if (data?.type === 'play' && data.sender !== this.windowId) {
          // 别的窗口开始播 → 本窗停（上游 stop('elsewhere')）
          this.stop('elsewhere')
        }
      }
    }

    this.meterLoop = createBudgetedLoop(() => this.onMeterTick(), {
      fps: 12,
      idleWhen: () => this.status.get() !== 'live' || this.meterMode.get() !== 'levels',
    })
  }

  private openChannel(): null | BroadcastChannel {
    // 无 BroadcastChannel（旧运行时/测试环境）→ 无跨窗互斥，其余照常。
    // 这不是降级掩盖：单窗口时该能力本就没有消费方。
    try {
      return typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('mirach:radio:playback')
    } catch (e) {
      console.error('[radio] BroadcastChannel 不可用——跨窗互斥关闭', e)
      return null
    }
  }

  // ── 播放控制 ────────────────────────────────────────────────────────────

  private stop(nextStatus: RadioStatus = 'paused'): void {
    this.generation += 1
    if (this.timeout) clearTimeout(this.timeout)
    this.timeout = null
    this.source?.disconnect()
    this.analyser?.disconnect()
    this.output?.disconnect()
    this.output = null
    this.source = null
    this.analyser = null
    if (this.audioContext?.state === 'running') void this.audioContext.suspend()
    if (this.audio) {
      this.audio.pause()
      this.audio.removeAttribute('src')
      this.audio.load()
      this.audio.remove()
      this.audio = null
    }
    this.status.set(nextStatus)
  }

  async play(next: Station = this.station.get(), analyse = true): Promise<void> {
    if (this.disposed || !isValidStation(next)) return
    this.stop()
    const token = this.generation
    this.station.set(next)
    writeJson(STORAGE.station, next)
    this.status.set('connecting')
    this.channel?.postMessage({ type: 'play', sender: this.windowId })

    const element = new Audio()
    this.audio = element
    element.dataset.mirachRadioAudio = 'true'
    element.hidden = true
    element.preload = 'none'
    // 每台都先试真分析（上游注释：不按主机白名单猜）；失败再退普通播放
    const metered = analyse && !this.plainStreams.has(next.url)
    this.meterMode.set(metered ? 'levels' : 'activity')
    if (metered) element.crossOrigin = 'anonymous'
    element.volume = metered ? 1 : this.volume.get() / 100
    document.body.append(element)

    const current = () => !this.disposed && token === this.generation
    const fail = () => {
      if (!current()) return
      if (metered) {
        this.plainStreams.add(next.url)
        void this.play(next, false)
      } else {
        this.stop('error')
      }
    }

    element.addEventListener('playing', () => {
      if (!current()) return
      if (this.timeout) clearTimeout(this.timeout)
      this.timeout = null
      this.playGeneration = token
      this.status.set('live')
      this.meterLoop.start()
    })
    // 浏览器/系统媒体控制能在我们的按钮之外暂停元素：如实反映，不销毁流
    element.addEventListener('pause', () => {
      if (current() && element.paused && !element.ended) this.status.set('paused')
    })
    element.addEventListener('waiting', () => {
      if (!current()) return
      this.status.set('connecting')
      if (this.timeout) clearTimeout(this.timeout)
      this.timeout = setTimeout(fail, 15_000)
    })
    element.addEventListener('error', fail)
    element.addEventListener('ended', fail)
    this.timeout = setTimeout(fail, 15_000)
    element.src = next.url

    try {
      if (metered) {
        this.audioContext ??= new AudioContext()
        const analyser = this.audioContext.createAnalyser()
        analyser.fftSize = this.waveformData.length
        this.analyser = analyser
        this.source = this.audioContext.createMediaElementSource(element)
        this.output = this.audioContext.createGain()
        this.output.gain.value = this.volume.get() / 100
        this.source.connect(analyser)
        analyser.connect(this.output)
        this.output.connect(this.audioContext.destination)
        await this.audioContext.resume()
        if (!current()) return
      }
      await element.play()
    } catch (e) {
      // 规矩 11：失败可见（连接不上/被策略拦），再走降级路径
      console.error('[radio] 播放失败', next.url, e)
      fail()
    }
  }

  /** 暂停/继续（插件自己的 Pause 是破坏性的，上游同语义）。 */
  toggle(): void {
    const status = this.status.get()
    if (status === 'live' || status === 'connecting') {
      this.stop()
      return
    }
    if (!this.resume()) void this.play()
  }

  /**
   * 续播被外部暂停的同一个流（系统媒体键、听写工具）。不是完整重连：
   * 元素或代际不匹配就返回 false，让调用方回退到 `play()`。
   */
  resume(): boolean {
    if (this.disposed || !this.audio || this.generation !== this.playGeneration) return false
    if (this.status.get() !== 'paused') return false
    const token = this.generation
    const element = this.audio
    this.status.set('connecting')
    void element
      .play()
      .then(() => {
        if (this.disposed || token !== this.generation) return
        if (this.timeout) clearTimeout(this.timeout)
        this.timeout = null
        this.status.set('live')
        this.meterLoop.start()
      })
      .catch((e) => {
        if (this.disposed || token !== this.generation) return
        console.error('[radio] 续播失败', e)
        this.stop('error')
      })
    return true
  }

  /** 下一台：置顶 + 预设 + 当前（上游 `next()` 同序）。 */
  next(): void {
    const queue = [...this.favorites.get(), ...PRESET_STATIONS]
    const currentStation = this.station.get()
    const index = queue.findIndex((item) => item.url === currentStation.url || item.id === currentStation.id)
    const nextStation = queue[(index + 1) % queue.length]
    if (nextStation) void this.play(nextStation)
  }

  setVolume(value: number): void {
    const nextVolume = clampVolume(value)
    this.volume.set(nextVolume)
    if (this.output) this.output.gain.value = nextVolume / 100
    else if (this.audio) this.audio.volume = nextVolume / 100
    writeJson(STORAGE.volume, nextVolume)
  }

  mute(): void {
    const volume = this.volume.get()
    if (volume) {
      this.lastVolume = volume
      this.setVolume(0)
    } else {
      this.setVolume(this.lastVolume)
    }
  }

  /** 置顶/取消置顶（上游 `favorite()`）。 */
  toggleFavorite(item: Station): void {
    const currentList = this.favorites.get()
    const exists = currentList.some((value) => value.url === item.url || value.id === item.id)
    const nextList = exists
      ? currentList.filter((value) => !(value.url === item.url || value.id === item.id))
      : [...currentList, item]
    this.favorites.set(nextList)
    writeJson(STORAGE.favorites, nextList)
  }

  // ── 目录检索 ────────────────────────────────────────────────────────────

  /** Radio Browser 检索（镜像发现 + 逐个 fallback，上游 `searchStations`）。 */
  async searchStations(text: string, signal: AbortSignal): Promise<Station[]> {
    if (!this.directoryDiscovered) {
      try {
        const payload = await fetchJson(`${this.directoryServers[0]}/json/servers`, signal)
        const servers = directoryServersFrom(payload)
        if (servers.length) this.directoryServers = servers
        this.directoryDiscovered = true
      } catch (e) {
        if (signal.aborted) throw e
        // 发现失败不致命：继续用默认镜像（上游同处理）
        console.error('[radio] 目录镜像发现失败', e)
      }
    }
    const path = directorySearchPath(text)
    let lastError: unknown = null
    for (const server of this.directoryServers.slice(0, 3)) {
      try {
        const rows = await fetchJson(`${server}${path}`, signal)
        return mapDirectoryRows(rows)
      } catch (e) {
        if (signal.aborted) throw e
        lastError = e
      }
    }
    throw lastError instanceof Error ? lastError : new Error('Directory unavailable')
  }

  /**
   * 当前曲目（Icecast status-json）。返回 null = 该台没有元数据端点。
   * 端点请求失败向调用方抛（UI 显示"元数据不可用"而不是编造曲目）。
   */
  async fetchNowPlaying(signal: AbortSignal): Promise<null | { artist: string; title: string; raw: string }> {
    const stream = new URL(this.station.get().url)
    const endpoint = METADATA_ENDPOINTS[stream.hostname]
    if (!endpoint) return null
    const payload = await fetchJson(endpoint, signal)
    const source = pickSource(payload, stream.pathname)
    const raw = typeof source?.title === 'string' ? source.title : ''
    const credit = trackCredit(raw ? source : null)
    return { ...credit, raw }
  }

  // ── 波形 ────────────────────────────────────────────────────────────────

  /** 取一段真实时域采样（上游 `waveform(columns)`：上升沿触发 + 固定增益）。 */
  waveform(columns: number): number[] {
    const analyser = this.analyser
    if (!analyser || this.status.get() !== 'live') return new Array<number>(columns).fill(0)
    analyser.getFloatTimeDomainData(this.waveformData)
    const sampleRate = this.audioContext?.sampleRate ?? 48_000
    const span = Math.floor(sampleRate * 0.004)
    let start = 0
    for (let i = 1; i < this.waveformData.length - span; i += 1) {
      const prev = this.waveformData[i - 1] ?? 0
      const curr = this.waveformData[i] ?? 0
      if (prev < 0 && curr >= 0) {
        start = i
        break
      }
    }
    return Array.from({ length: columns }, (_, x) => {
      const from = start + Math.floor((x * span) / columns)
      const to = start + Math.floor(((x + 1) * span) / columns)
      let sum = 0
      for (let i = from; i < to; i += 1) sum += this.waveformData[i] ?? 0
      const averaged = sum / Math.max(1, to - from)
      return Math.max(-1, Math.min(1, averaged * 2))
    })
  }

  /** 波形变化通知（12fps；UI 用 useSyncExternalStore 之外的简易订阅）。 */
  private meterListeners = new Set<() => void>()

  subscribeMeter(listener: () => void): () => void {
    this.meterListeners.add(listener)
    this.meterLoop.start()
    return () => {
      this.meterListeners.delete(listener)
      if (this.meterListeners.size === 0) this.meterLoop.stop()
    }
  }

  private onMeterTick(): void {
    for (const listener of this.meterListeners) listener()
  }

  dispose(): void {
    this.disposed = true
    this.meterLoop.stop()
    this.meterListeners.clear()
    this.stop('paused')
    if (this.channel) {
      this.channel.onmessage = null
      this.channel.close()
    }
    if (this.audioContext) void this.audioContext.close()
    this.audioContext = null
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// §3 面板 UI（原 radio-pane.tsx）——选台列表占满，播放器沉到底部独立一条
// ═══════════════════════════════════════════════════════════════════════════════

/** 状态文案（上游 i18n 的状态面；宿主规矩 2：只留 zh/en，这里中文）。 */
const STATUS_LABEL: Record<RadioStatus, string> = {
  paused: '已暂停',
  connecting: '正在连接',
  live: '直播',
  error: '无法播放',
  elsewhere: '已暂停，正在其他窗口播放',
}

/** 打开外链（宿主不装 opener 插件，走 `fs_open_url`；纯浏览器直开退 window.open）。 */
async function openExternal(url: string): Promise<void> {
  if (!inTauri) {
    window.open(url, '_blank', 'noopener,noreferrer')
    return
  }
  try {
    await invoke('fs_open_url', { url })
  } catch (e) {
    // 规矩 11：打开失败可见
    console.error('[radio] 打开外链失败', url, e)
  }
}

// ── 波形 ────────────────────────────────────────────────────────────────────

/**
 * braille 波形（上游 `Waveform`）：三层叠画（两层暗色余辉 + 当前），
 * `compact` 是 6 列的紧凑版。
 */
function Waveform({ player, compact = false }: { player: RadioPlayer; compact?: boolean }) {
  const width = compact ? 6 : 36
  const rows = compact ? 1 : 2
  const status = useStatus(player)
  const mode = useAtom(player.meterMode)
  const active = status === 'live'
  const baseline = useMemo(() => flatTrace(width, rows), [width, rows])
  const historyRef = useRef<string[][]>([
    new Array<string>(width * rows).fill('⠀'),
    new Array<string>(width * rows).fill('⠀'),
  ])
  const [layers, setLayers] = useState<string[][]>(() => [baseline, baseline, baseline])

  useEffect(() => {
    const blank = new Array<string>(width * rows).fill('⠀')
    if (!active) {
      // 未在播：平线（不编造电平）
      setLayers([baseline, baseline, baseline])
      return
    }
    const reduced =
      typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null
    if (reduced?.matches) {
      // 减弱动效：同样冻结在平线（上游同语义）
      setLayers([baseline, baseline, baseline])
      return
    }
    let step = 0
    const off = player.subscribeMeter(() => {
      if (mode === 'activity') {
        // 分析不可用（CORS/音频图失败）：走活动指示，不假装有电平
        const cells = [...blank]
        cells[Math.floor(step / 2) % (width * rows)] = '⠤'
        step += 1
        setLayers([blank, blank, cells])
        return
      }
      const cells = brailleTrace(player.waveform(width * 2), rows)
      const previous = historyRef.current
      historyRef.current = [previous[1]!, cells]
      setLayers([previous[0]!, previous[1]!, cells])
    })
    return off
  }, [active, baseline, mode, player, rows, width])

  return (
    <div
      className="radio-waveform"
      data-compact={compact}
      data-active={active}
      data-meter-mode={mode}
      aria-hidden
      style={{ ['--radio-columns' as string]: width }}
    >
      {layers.map((layer, index) => (
        <span className="radio-waveform-layer" key={index}>
          {layer.map((cell, cellIndex) => (
            <span key={cellIndex}>{cell}</span>
          ))}
        </span>
      ))}
    </div>
  )
}

// ── 小工具钩子 ──────────────────────────────────────────────────────────────

/** nanostores atom → React（避免为面板引入额外依赖面）。 */
function useAtom<T>(atom: { get(): T; subscribe(cb: (value: T) => void): () => void }): T {
  const [value, setValue] = useState<T>(() => atom.get())
  useEffect(() => {
    setValue(atom.get())
    return atom.subscribe((next: T) => setValue(next))
  }, [atom])
  return value
}

function useStatus(player: RadioPlayer): RadioStatus {
  return useAtom(player.status)
}

/** 小图标动作（上游 `SmallAction`：Tip 包 Button）。 */
function SmallAction({
  label,
  icon: Icon,
  onClick,
  pressed,
  busy = false,
  className,
}: {
  label: string
  icon: typeof Play
  onClick: () => void
  pressed?: boolean
  busy?: boolean
  className?: string
}) {
  return (
    <Tip label={label}>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={label}
        aria-pressed={pressed}
        className={className}
        onClick={onClick}
      >
        {busy ? (
          <Loader2 className="size-3 animate-spin" aria-label={label} />
        ) : (
          <Icon className="size-3" />
        )}
      </Button>
    </Tip>
  )
}

// ── 选台列表 ────────────────────────────────────────────────────────────────

function StationRow({
  station,
  current,
  status,
  pinned,
  onSelect,
  onToggleFavorite,
}: {
  station: Station
  current: boolean
  status: RadioStatus
  pinned: boolean
  onSelect: () => void
  onToggleFavorite: () => void
}) {
  const active = status === 'live' || status === 'connecting'
  const failed = current && status === 'error'
  const Icon = failed ? RadioIcon : current && active ? Pause : Play
  return (
    <div className="radio-row" data-current={current} data-pinned={pinned}>
      <RowButton
        className="radio-row-main"
        aria-current={current ? 'true' : undefined}
        aria-label={`${failed ? '重试' : current && active ? '暂停' : '播放'}: ${station.name}`}
        title={failed ? '无法连接，请重试或换台' : station.description}
        onClick={onSelect}
      >
        <span className="radio-row-icon">
          <Icon className="size-3" />
        </span>
        <span className="radio-row-copy">
          <span className="radio-row-name">{station.name}</span>
          {station.description ? <span className="radio-row-desc">{station.description}</span> : null}
        </span>
      </RowButton>
      <SmallAction
        label={`${pinned ? '取消置顶' : '置顶'}: ${station.name}`}
        icon={Pin}
        pressed={pinned}
        className="radio-row-pin"
        onClick={onToggleFavorite}
      />
    </div>
  )
}

function StationList({ player }: { player: RadioPlayer }) {
  const favorites = useAtom(player.favorites)
  const station = useAtom(player.station)
  const status = useStatus(player)
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const [remote, setRemote] = useState<Station[]>([])
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState<null | string>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const text = search.trim()

  // 350ms 防抖（上游 setQuery 延迟同值）
  useEffect(() => {
    const timer = setTimeout(() => setQuery(text), 350)
    return () => clearTimeout(timer)
  }, [text])

  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = 0
  }, [text])

  useEffect(() => {
    if (query.length < 2 || query !== text) return
    const controller = new AbortController()
    let cancelled = false
    setSearching(true)
    setSearchError(null)
    void player
      .searchStations(query, controller.signal)
      .then((rows) => {
        if (cancelled) return
        setRemote(rows)
      })
      .catch((e: unknown) => {
        if (cancelled || controller.signal.aborted) return
        // 规矩 11：检索失败可见，预设台照旧可用
        console.error('[radio] 电台检索失败', e)
        setSearchError('暂时无法搜索，精选电台仍可使用。')
        setRemote([])
      })
      .finally(() => {
        if (!cancelled) setSearching(false)
      })
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [player, query, text])

  const localMatches = useMemo(() => {
    const lowered = text.toLowerCase()
    const pool = uniqueStations([...favorites, ...PRESET_STATIONS])
    if (!lowered) return pool
    return pool.filter((item) =>
      [item.name, item.description, item.provider].some((value) =>
        value?.toLowerCase().includes(lowered),
      ),
    )
  }, [favorites, text])

  const items = useMemo(
    () => uniqueStations([...localMatches, ...(query === text ? remote : [])]),
    [localMatches, query, remote, text],
  )

  const pending = text.length >= 2 && (text !== query || searching)

  return (
    <div className="radio-stations">
      <div className="radio-search">
        <SearchField
          placeholder="搜索电台…"
          value={search}
          onChange={setSearch}
          containerClassName="radio-search-field"
          loading={pending}
          aria-label="搜索电台"
        />
      </div>
      <div className="radio-list" ref={listRef}>
        {items.map((item) => (
          <StationRow
            key={item.id}
            station={item}
            current={isSameStation(item, station)}
            status={status}
            pinned={favorites.some((value) => isSameStation(value, item))}
            onSelect={() => {
              if (isSameStation(item, station)) player.toggle()
              else void player.play(item)
            }}
            onToggleFavorite={() => player.toggleFavorite(item)}
          />
        ))}
        {searchError ? (
          <div className="radio-note" role="status">
            {searchError}
          </div>
        ) : null}
        {!pending && !searchError && text && items.length === 0 ? (
          <div className="radio-note" role="status">
            没有找到电台。
          </div>
        ) : null}
        {!text && items.length === 0 ? (
          <div className="radio-note" role="status">
            还没有置顶电台。搜索一个台名开始，例如 jazz、ambient 或 house。
          </div>
        ) : null}
      </div>
      <div className="radio-credit">搜索由 Radio Browser 提供</div>
    </div>
  )
}

// ── 曲目行 ──────────────────────────────────────────────────────────────────

/** 当前曲目/状态文案（上游 `Signal` 的曲目行部分；波形在播放条里单独画）。 */
function TrackLine({ player }: { player: RadioPlayer }) {
  const status = useStatus(player)
  const station = useAtom(player.station)
  const mode = useAtom(player.meterMode)
  const [credit, setCredit] = useState<null | { artist: string; title: string; raw: string }>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (status !== 'live') {
      setCredit(null)
      setFailed(false)
      return
    }
    const controller = new AbortController()
    let cancelled = false
    const load = () => {
      void player
        .fetchNowPlaying(controller.signal)
        .then((value) => {
          if (cancelled) return
          setCredit(value)
          setFailed(false)
        })
        .catch((e: unknown) => {
          if (cancelled || controller.signal.aborted) return
          // 规矩 11：元数据失败可见（不编造曲目）
          console.error('[radio] 曲目元数据获取失败', e)
          setFailed(true)
        })
    }
    load()
    // 上游 staleTime 20s / refetch 25s
    const timer = setInterval(load, 25_000)
    return () => {
      cancelled = true
      controller.abort()
      clearInterval(timer)
    }
  }, [player, status, station.url])

  const text =
    status === 'live'
      ? credit?.raw || (mode === 'activity' ? '正在播放 · 无法显示波形' : '')
      : STATUS_LABEL[status]

  return (
    <div className="radio-track" data-track={Boolean(credit?.raw)} role="status">
      {status === 'connecting' ? (
        <Loader2 className="size-3 animate-spin" aria-label="正在连接" />
      ) : null}
      {credit?.artist ? <span className="radio-track-artist">{credit.artist}</span> : null}
      {credit?.artist ? (
        <span className="radio-track-separator" aria-hidden>
          —
        </span>
      ) : null}
      {failed ? <span className="radio-track-text">曲目元数据不可用</span> : null}
      {!failed ? (
        <span className="radio-track-text">{credit?.artist ? credit.title : text}</span>
      ) : null}
    </div>
  )
}

// ── 传输条 ──────────────────────────────────────────────────────────────────

function Transport({ player }: { player: RadioPlayer }) {
  const volume = useAtom(player.volume)
  const station = useAtom(player.station)
  const status = useStatus(player)
  const active = status === 'live' || status === 'connecting'
  const homepage = httpsUrlOrNull(station.homepage)
  return (
    <div className="radio-transport">
      <SmallAction
        label={active ? '暂停' : '播放'}
        icon={active ? Pause : Play}
        busy={status === 'connecting'}
        onClick={() => player.toggle()}
      />
      <SmallAction label="下一个电台" icon={SkipForward} onClick={() => player.next()} />
      <span className="radio-transport-space" />
      <SmallAction
        label={volume ? '静音' : '取消静音'}
        icon={volume ? Volume2 : VolumeX}
        onClick={() => player.mute()}
      />
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={volume}
        aria-label="音量"
        onChange={(event) => player.setVolume(Number(event.target.value))}
      />
      {homepage ? (
        <SmallAction
          label="访问电台网站"
          icon={ExternalLink}
          onClick={() => void openExternal(homepage)}
        />
      ) : null}
    </div>
  )
}

// ── 面板入口 ────────────────────────────────────────────────────────────────

/**
 * 版式（2026-11-15 用户定稿）：**选台列表占满整个面板，播放器沉到底部
 * 单独一条元素区**——不是右侧分栏。
 *
 * ```
 * ┌────────────────────────────────────┐
 * │ 搜索电台…                          │
 * │ ● Nightride        ♪  Synthwave    │
 * │   Chillsynth                       │
 * │   …                                │
 * ├────────────────────────────────────┤
 * │ ⣿⣷⣦⣤ 波形（整宽，两层余辉）        │  ← .radio-playerbar
 * │ Nightride · Artist — Title  ⏯ ⏭ 🔊 ──  🌐 ✕ │
 * └────────────────────────────────────┘
 * ```
 */
export function RadioPane({ onClose }: { onClose: () => void }) {
  // 播放器随面板生命周期存活；关闭面板 = 停止播放并释放音频资源（上游
  // `ctx.onDispose` 同语义：关窗即停，没有后台音频服务）。
  const [player] = useState(() => new RadioPlayer())
  const station = useAtom(player.station)
  const status = useStatus(player)
  const active = status === 'live' || status === 'connecting'

  useEffect(() => () => player.dispose(), [player])

  const onToggle = useCallback(() => player.toggle(), [player])

  return (
    <div className="radio-pane" data-slot="radio-pane" data-status={status}>
      <StationList player={player} />
      <div className="radio-playerbar" data-slot="radio-playerbar">
        <Waveform player={player} />
        <div className="radio-playerbar-row">
          <div className="radio-playerbar-meta">
            <span className="radio-bar-name" title={`${station.name} · ${STATUS_LABEL[status]}`}>
              {station.name}
            </span>
            <TrackLine player={player} />
          </div>
          <SmallAction
            label={active ? '暂停电台' : '播放电台'}
            icon={active ? Pause : Play}
            busy={status === 'connecting'}
            onClick={onToggle}
          />
          <SmallAction label="下一个电台" icon={SkipForward} onClick={() => player.next()} />
          <Transport player={player} />
          <SmallAction label="关闭电台面板" icon={X} className="radio-playerbar-close" onClick={onClose} />
        </div>
      </div>
    </div>
  )
}

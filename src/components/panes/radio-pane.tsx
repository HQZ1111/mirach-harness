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
  Check,
  ExternalLink,
  Loader2,
  Pause,
  Play,
  Plus,
  Radio as RadioIcon,
  SkipForward,
  Trash2,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react'
import { atom, type WritableAtom } from 'nanostores'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
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

/** 海外预设台（上游 hermes 的 7 台原样保留，2026-11-15 改名）。 */
const OVERSEAS_PRESET_STATIONS: readonly Station[] = [
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

/**
 * 国内电台预设（2026-11-15 用户：“搞些国内的放进去”）。
 *
 * 地址与名字取自 Radio Browser 的 `country=China&order=votes` 实测结果
 * （不是手写/记忆值），并已在本机验过可达性：首字节 0.2–2.3s、
 * 稳定 ~13.5 KB/s——**比境外预设台明显稳定**，所以排在列表最前。
 *
 * 流由蜻蜓 FM（qingting / qtfm 同一 CDN 的两个域名）提供，统一 64k mp3。
 */
export const CN_PRESET_STATIONS: readonly Station[] = [
  {
    id: 'cn-cnr1',
    name: '中国之声',
    description: 'CNR-1 · 新闻',
    provider: '蜻蜓 FM',
    url: 'https://lhttp.qingting.fm/live/15318317/64k.mp3',
    homepage: 'https://www.qingting.fm/radios/15318317/',
  },
  {
    id: 'cn-guangdong-music',
    name: '广东音乐之声',
    description: '音乐',
    provider: '蜻蜓 FM',
    url: 'https://lhttp.qtfm.cn/live/1260/64k.mp3',
  },
  {
    id: 'cn-beijing-news',
    name: '北京新闻广播',
    description: '94.5 FM · 新闻',
    provider: '蜻蜓 FM',
    url: 'https://lhttp.qtfm.cn/live/339/64k.mp3',
  },
  {
    id: 'cn-guangdong-traffic',
    name: '广东交通之声',
    description: '羊城交通广播',
    provider: '蜻蜓 FM',
    url: 'https://lhttp.qtfm.cn/live/1262/64k.mp3',
  },
  {
    id: 'cn-guangdong-stock',
    name: '广东股市广播',
    description: '财经',
    provider: '蜻蜓 FM',
    url: 'https://lhttp.qtfm.cn/live/4847/64k.mp3',
  },
  {
    id: 'cn-huaiji-music',
    name: '怀集音乐之声',
    description: '音乐',
    provider: '蜻蜓 FM',
    url: 'https://lhttp.qingting.fm/live/4804/64k.mp3',
  },
  {
    id: 'cn-intl-news',
    name: '国际新闻',
    description: '资讯 · 新闻',
    provider: '蜻蜓 FM',
    url: 'https://lhttp.qtfm.cn/live/20500172/64k.mp3',
  },
  {
    id: 'cn-anhui-story',
    name: '安徽小说评书广播',
    description: '评书 · 故事',
    provider: '蜻蜓 FM',
    url: 'https://lhttp.qtfm.cn/live/1951/64k.mp3',
  },
]

/**
 * 列表展示顺序：国内台在前、海外台在后。
 *
 * 理由（实测不是主观偏好）：境内 CDN 首字节 0.2–2.3s 且带宽稳定，
 * 境外台在本机首字节 2–5.7s、速度贴在 128kbps 临界值上波动——
 * 用户报的“一直断”主要就来自后者。预设顺序 = 首选可用性的提示。
 */
export const PRESET_STATIONS: readonly Station[] = [...CN_PRESET_STATIONS, ...OVERSEAS_PRESET_STATIONS]

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

/**
 * 用户自选列表（`favorites`）的增/删纯函数。
 *
 * 语义（2026-11-15 用户：“搜索的电台要能加到列表，列表里的要能删除”）：
 * - 列表**只装用户自己加/置顶的台**，预设台不算“已在列表”（它们永远在
 *   预设区）；同名/同 url 不重复加。
 * - 删除按同 id 或同 url 命中（镜像改写 url 的同一个台也能删干净）。
 */
export function addToMyStations(list: readonly Station[], item: Station): Station[] {
  if (!isValidStation(item)) return [...list]
  const exists = list.some((value) => isSameStation(value, item))
  // 已存在就原样返回（同一引用，让 React 跳过重渲）
  return exists ? (list as Station[]) : [...list, item]
}

export function removeFromMyStations(list: readonly Station[], item: Station): Station[] {
  const next = list.filter((value) => !isSameStation(value, item))
  return next.length === list.length ? (list as Station[]) : next
}

/** 该台是否已在自选列表里（UI 决定星标亮不亮 / 显示“加入”还是“已在列表”）。 */
export function inMyStations(list: readonly Station[], item: Station): boolean {
  return list.some((value) => isSameStation(value, item))
}

/**
 * 已隐藏的预设台 id 集合（用户 2026-11-15：“预设电台怎么不能删除”）。
 *
 * 预设台是**内置常量**（代码里的 `PRESET_STATIONS`），不能真从源码删；
 * 所以删除 = 记进隐藏集，列表渲染时过滤掉。隐藏是可恢复的：清空该集合
 * （或以后加“恢复默认电台”入口）即全部回来。
 */
export function hidePreset(hidden: readonly string[], item: Station): string[] {
  if (hidden.includes(item.id)) return hidden as string[]
  return [...hidden, item.id]
}

export function unhidePreset(hidden: readonly string[], item: Station): string[] {
  const next = hidden.filter((id) => id !== item.id)
  return next.length === hidden.length ? (hidden as string[]) : next
}

/** 过滤掉被隐藏的预设台（保留非预设项，顺序不变）。 */
export function visiblePresets<T extends { id: string }>(
  presets: readonly T[],
  hidden: readonly string[],
): T[] {
  if (hidden.length === 0) return [...presets]
  const blocked = new Set(hidden)
  return presets.filter((item) => !blocked.has(item.id))
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

// ── 艺人主页解析（上游 `artistProfile` / `resolveArtist` / `resolveMusicBrainzArtist`） ──

/** 艺人名归一（上游 `normalizedArtist`）：NFKC + 去空白 + 小写。 */
export function normalizedArtist(name: string): string {
  return name.normalize('NFKC').trim().toLowerCase()
}

/**
 * 从 MusicBrainz 的 url-rels 里挑一个艺人主页（上游 `artistProfile`）。
 *
 * 优先级：Spotify artist 页 → bandcamp 子域首页 → official homepage。
 * Spotify 链接必须是 `/artist/<22 位 id>` 形态（专辑/单曲页一律不要——
 * 上游注释：绝不给歌曲结果或搜索页当艺人页）。
 */
export function artistProfile(relations: unknown): null | string {
  if (!Array.isArray(relations)) return null
  const links: { href: string; rank: number }[] = []
  for (const item of relations as { ended?: unknown; type?: unknown; url?: { resource?: unknown } }[]) {
    if (item?.ended) continue
    const href = httpsUrlOrNull(item?.url?.resource)
    if (!href) continue
    const url = new URL(href)
    if (url.hostname === 'open.spotify.com' && /^\/artist\/[a-zA-Z0-9]{22}\/?$/.test(url.pathname)) {
      links.push({ href, rank: 0 })
      continue
    }
    if (item.type === 'bandcamp' && /^[^.]+\.bandcamp\.com$/.test(url.hostname) && url.pathname === '/') {
      links.push({ href, rank: 1 })
      continue
    }
    if (
      item.type === 'official homepage' &&
      !['open.spotify.com', 'bandcamp.com'].includes(url.hostname)
    ) {
      links.push({ href, rank: 2 })
    }
  }
  return links.sort((a, b) => a.rank - b.rank)[0]?.href ?? null
}

/**
 * Apple Music 艺人搜索结果 → 主页 URL（上游 `resolveArtist` 的前半段）。
 * 只接受**唯一**的精确同名匹配；歧义或无匹配返回 null（不猜）。
 */
export function appleArtistProfile(payload: unknown, artist: string): null | string {
  const results = (payload as { results?: unknown } | null)?.results
  if (!Array.isArray(results)) return null
  const matches = (results as { wrapperType?: unknown; artistName?: unknown; artistLinkUrl?: unknown }[]).filter(
    (item) => item?.wrapperType === 'artist' && typeof item.artistName === 'string' && normalizedArtist(item.artistName) === normalizedArtist(artist),
  )
  if (matches.length !== 1) return null
  const href = httpsUrlOrNull(matches[0]!.artistLinkUrl)
  if (!href) return null
  const url = new URL(href)
  // 只认 /<lang>/artist/<slug>/<id> 的艺人页（上游同正则）
  if (url.hostname !== 'music.apple.com' || !/^\/[a-z]{2}\/artist\/[^/]+\/\d+$/.test(url.pathname)) return null
  url.search = ''
  return url.href
}

/**
 * MusicBrainz 艺人搜索 → 主页 URL（上游 `resolveMusicBrainzArtist`）。
 *
 * 判据比 Apple 更严：**恰好一条** 100 分精确同名，且返回条数不能正好是
 * 请求的 5 条（那意味着结果被截断，可能还有更匹配的没回来）。
 *
 * 返回 `{ id }` 或 null；真正取 url-rels 由调用方发第二枪（两段请求）。
 */
export function musicBrainzArtistId(payload: unknown, artist: string): null | string {
  const artists = (payload as { artists?: unknown } | null)?.artists
  if (!Array.isArray(artists)) return null
  const list = artists as { id?: unknown; name?: unknown; score?: unknown }[]
  const matches = list.filter(
    (item) => typeof item.name === 'string' && normalizedArtist(item.name) === normalizedArtist(artist),
  )
  if (matches.length !== 1 || matches[0]!.score !== 100 || list.length === 5) return null
  const id = matches[0]!.id
  return typeof id === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id) ? id : null
}

/** MusicBrainz 艺人检索的查询串（上游 `artistRequest` 的 path 构造）。 */
export function musicBrainzArtistQuery(artist: string): string {
  const escaped = artist.replace(/[+\-!(){}[\]^"~*?:\\/&|]/g, '\\$&')
  const params = new URLSearchParams({ query: `artist:"${escaped}"`, fmt: 'json', limit: '5' })
  return `artist/?${params.toString()}`
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
  hiddenPresets: 'mirach.radio.hiddenPresets',
} as const

/** 艺人主页缓存的键前缀（上游类比 React Query 的一天缓存）。 */
const ARTIST_CACHE_PREFIX = 'mirach.radio.artistProfile.'

/**
 * 首次连接超时窗口（含首字节等待）。
 *
 * 2026-11-15 实测：境外流首字节 2–5.7s，旧值 15s 在慢网下不够；国内台
 * 只要 0.2–2.3s。放宽到 25s——它只管制「连不上」，不管播起来之后的卡顿
 * （卡顿不再重连，见 `waiting` 处理）。
 */
const CONNECT_TIMEOUT_MS = 25_000

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
  /** 被用户删除的预设台 id（内置台不能真删，用隐藏集表达）。 */
  readonly hiddenPresets: WritableAtom<string[]>
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
  /** 本轮是否真的播起来过（区分「首次连接慢」与「播放中卡顿」）。 */
  private hasPlayed = false
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

    const savedHidden = readJson<unknown>(STORAGE.hiddenPresets, [])
    this.hiddenPresets = atom(
      Array.isArray(savedHidden) ? savedHidden.filter((id): id is string => typeof id === 'string') : [],
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
    // 新一轮播放：重置「已播起来」标志（否则重连后首个 waiting 会被当成
    // 播放中卡顿而永不超时）
    this.hasPlayed = false
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
      this.hasPlayed = true
      this.status.set('live')
      this.meterLoop.start()
    })
    // 浏览器/系统媒体控制能在我们的按钮之外暂停元素：如实反映，不销毁流
    element.addEventListener('pause', () => {
      if (current() && element.paused && !element.ended) this.status.set('paused')
    })
    // `waiting` = 缓冲不足/网速慢，**不是连接失败**。
    //
    // 2026-11-15 修「一直断」：旧版把 waiting 一律当成失败定时器，15s 没
    // 恢复就 fail() → metered 流会重走 play(next, false)，而那是 stop() +
    // 全新 new Audio()，等于整台重连。慢流（首字节 2–5.7s、带宽贴在码率
    // 临界值）本来就频繁 waiting，于是陷入「重连 → 又 waiting → 再重连」
    // 的循环，用户看到的正是「一直断」。
    //
    // 正解：只给**首次连接**设超时（下面 element.src 之前那一次）；
    // 已经播起来之后的卡顿交给浏览器自己的缓冲策略，状态只降到 connecting
    // 供 UI 显示，**不重连、不销毁流**。
    element.addEventListener('waiting', () => {
      if (!current()) return
      if (this.hasPlayed) {
        // 播放中卡顿：保留元素与已缓冲数据，只反映状态
        this.status.set('connecting')
        return
      }
      // 还没播起来：属于首次连接慢，沿用连接超时窗口
      this.status.set('connecting')
      if (this.timeout) clearTimeout(this.timeout)
      this.timeout = setTimeout(fail, CONNECT_TIMEOUT_MS)
    })
    element.addEventListener('error', fail)
    element.addEventListener('ended', fail)
    this.timeout = setTimeout(fail, CONNECT_TIMEOUT_MS)
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
  /** 把台加入自选列表（搜索结果的“加入”动作）。 */
  addStation(item: Station): void {
    const next = addToMyStations(this.favorites.get(), item)
    if (next === this.favorites.get()) return
    this.favorites.set(next)
    writeJson(STORAGE.favorites, next)
    // 加入列表 = 该台不应再算“被隐藏”（否则从预设区删过再加回来会不可见）
    this.hiddenPresets.set(unhidePreset(this.hiddenPresets.get(), item))
    writeJson(STORAGE.hiddenPresets, this.hiddenPresets.get())
  }

  /** 从自选列表删除（列表行的“删除”动作）。 */
  removeStation(item: Station): void {
    const next = removeFromMyStations(this.favorites.get(), item)
    if (next !== this.favorites.get()) {
      this.favorites.set(next)
      writeJson(STORAGE.favorites, next)
    }
    // 删的正是当前在播的台：继续播（不因删列表项而断），只是不再可重选
  }

  /**
   * 删除一个**预设台**（用户 2026-11-15：“预设电台怎么不能删除”）。
   *
   * 预设是编译进代码的常量，不能真删——所以“删除”= 记进 `hiddenPresets`，
   * 列表渲染时过滤掉。持久化表达用户意图，下次启动仍然隐藏。
   */
  hidePreset(item: Station): void {
    const next = hidePreset(this.hiddenPresets.get(), item)
    if (next === this.hiddenPresets.get()) return
    this.hiddenPresets.set(next)
    writeJson(STORAGE.hiddenPresets, next)
  }

  /** 恢复全部被隐藏的预设台（供以后加“恢复默认电台”入口）。 */
  restorePresets(): void {
    if (this.hiddenPresets.get().length === 0) return
    this.hiddenPresets.set([])
    writeJson(STORAGE.hiddenPresets, [])
  }

  /** 星标切换（行内图标）：已在列表→删，不在→加。 */
  toggleFavorite(item: Station): void {
    if (inMyStations(this.favorites.get(), item)) this.removeStation(item)
    else this.addStation(item)
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

  /**
   * 艺人名 → 主页 URL（上游 `resolveArtist`）。
   *
   * Apple 公开搜索优先（无需 key，直接给艺人页），失败/歧义再问 MusicBrainz。
   * **歧义或没匹配一律 null** —— UI 就保持纯文本，不做"猜一个"的死链接。
   */
  async resolveArtist(artist: string, signal: AbortSignal): Promise<null | string> {
    if (!artist) return null
    const cached = readJson<null | string>(`${ARTIST_CACHE_PREFIX}${artist}`, null)
    if (cached) return cached
    const params = new URLSearchParams({ term: artist, entity: 'musicArtist', limit: '10' })
    let resolved: null | string = null
    try {
      const payload = await fetchJson(`https://itunes.apple.com/search?${params.toString()}`, signal)
      resolved = appleArtistProfile(payload, artist)
    } catch (e) {
      if (signal.aborted) throw e
      // Apple 不可用不是错误：继续走 MusicBrainz（上游同结构）
      console.error('[radio] Apple 艺人检索失败', e)
    }
    resolved ??= await this.resolveMusicBrainzArtist(artist, signal)
    // 结果缓存一天（上游 staleTime/gcTime 86400000）
    if (resolved) writeJson(`${ARTIST_CACHE_PREFIX}${artist}`, resolved)
    return resolved
  }

  /** MusicBrainz 两段请求（搜索 → 取 url-rels），带跨窗限速（上游 `artistRequest`）。 */
  private async resolveMusicBrainzArtist(artist: string, signal: AbortSignal): Promise<null | string> {
    const id = await this.musicBrainzFetch(musicBrainzArtistQuery(artist), signal).then((payload) =>
      musicBrainzArtistId(payload, artist),
    )
    if (!id) return null
    const profile = await this.musicBrainzFetch(`artist/${id}?inc=url-rels&fmt=json`, signal)
    return artistProfile((profile as { relations?: unknown } | null)?.relations)
  }

  /**
   * MusicBrainz 请求本体：`navigator.locks` + 持久时间戳做 1.1s 跨窗限速
   * （上游同款；MusicBrainz 匿名限速约 1 req/s，超了会 503）。
   */
  private async musicBrainzFetch(path: string, signal: AbortSignal): Promise<unknown> {
    const run = async () => {
      const last = readJson<number>(STORAGE.artistRequestAt, 0)
      const delay = Math.max(0, 1100 - (Date.now() - last))
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay))
      signal.throwIfAborted()
      writeJson(STORAGE.artistRequestAt, Date.now())
      const response = await fetch(`https://musicbrainz.org/ws/2/${path}`, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
        credentials: 'omit',
        headers: { 'User-Agent': 'MirachRadio/1.0 (https://github.com/mirach-harness)' },
      })
      if (!response.ok) throw new Error(`Artist lookup: HTTP ${response.status}`)
      return response.json() as Promise<unknown>
    }
    // 无 navigator.locks（旧运行时）时直接跑：限速仍由持久时间戳保证
    if (typeof navigator === 'undefined' || !navigator.locks) return run()
    return navigator.locks.request('mirach:radio:artist-lookup', { signal }, run)
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

/**
 * 选台列表悬停滑动指示块（照宿主 `SessionListHoverPill` 模式，2026-11-15
 * 用户定稿："鼠标放上去是滑动的那个组件"）。
 *
 * **纯视觉层**：不动点击/置顶/键盘任何逻辑——挂在列表滚动容器里做末个子
 * 节点（行是 relative 定位、后绘制盖其上），事件委托监听 `.radio-row`，
 * 把绝对定位指示块滑到悬停行。
 *
 * 挂载点是**滚动容器**（不是 inner list）：abs 子元素随内容滚动 → top 必须
 * 加 `root.scrollTop` 才能钉在行上（宿主 2026-10-14 CDP 实测结论）。
 *
 * 动画纪律（同宿主）：只在"已钉在某行上"时开位移过渡；进场/退场只做透明度
 * 淡变，否则重新进入列表时 pill 会从上一处静止位置"飞"过来。
 */
function StationListHoverPill() {
  const ref = useRef<HTMLDivElement | null>(null)
  const [state, setState] = useState({ top: 0, left: 0, width: 0, height: 0, visible: false })
  const shownRef = useRef(false)
  const [sliding, setSliding] = useState(false)

  useEffect(() => {
    const el = ref.current
    const root = el?.parentElement ?? null
    if (!root) return

    const onOver = (event: Event) => {
      const row = (event.target as HTMLElement | null)?.closest('.radio-row') as HTMLElement | null
      // 非行面（行间隙/空态文案/底部署名）不隐藏也不动作——只认行，
      // 离开容器才灭（宿主同语义：逐行滑过时不许闪断）。
      if (!row || !root.contains(row)) return
      const rootRect = root.getBoundingClientRect()
      const rowRect = row.getBoundingClientRect()
      const next = {
        top: Math.round(rowRect.top - rootRect.top + root.scrollTop),
        left: Math.round(rowRect.left - rootRect.left),
        width: Math.round(rowRect.width),
        height: Math.round(rowRect.height),
        visible: true,
      }
      // 同行内子元素间移动 = 同坐标 → 跳过重渲（pointerover 每换子元素都发）
      setState((prev) =>
        prev.visible &&
        prev.top === next.top &&
        prev.left === next.left &&
        prev.width === next.width &&
        prev.height === next.height
          ? prev
          : next,
      )
      setSliding(shownRef.current)
      shownRef.current = true
    }

    const onLeave = () => {
      shownRef.current = false
      setState((prev) => (prev.visible ? { ...prev, visible: false } : prev))
    }

    root.addEventListener('pointerover', onOver)
    root.addEventListener('pointerleave', onLeave)
    return () => {
      root.removeEventListener('pointerover', onOver)
      root.removeEventListener('pointerleave', onLeave)
    }
  }, [])

  return (
    <div
      ref={ref}
      aria-hidden
      className="radio-hover-pill"
      style={{
        top: state.top,
        left: state.left,
        width: state.width,
        height: state.height,
        opacity: state.visible ? 1 : 0,
        transition: sliding
          ? 'top 180ms var(--ease-out, ease-out), left 140ms var(--ease-out, ease-out), width 140ms var(--ease-out, ease-out), height 140ms var(--ease-out, ease-out), opacity 80ms var(--ease-out, ease-out)'
          : 'opacity 100ms var(--ease-out, ease-out)',
      }}
    />
  )
}

function StationRow({
  station,
  current,
  status,
  action,
  onSelect,
  onAction,
}: {
  station: Station
  current: boolean
  status: RadioStatus
  /**
   * 行尾动作（用户 2026-11-15：搜索的台能加入列表、列表里的能删除、
   * 预设台也能删除）：
   * - `add`    = 搜索结果（不在列表）→ 加入我的电台
   * - `added`  = 已在我的电台（搜索命中）→ 不可再点，显示勾作为反馈
   * - `remove` = 我的电台行 → 从列表删除
   * - `preset` = 预设电台 → 删除（隐藏）该预设台
   */
  action: 'add' | 'added' | 'remove' | 'preset'
  onSelect: () => void
  onAction?: () => void
}) {
  const active = status === 'live' || status === 'connecting'
  const failed = current && status === 'error'
  const Icon = failed ? RadioIcon : current && active ? Pause : Play

  // 动作面文案：加入 = 副标题强调（主操作），删除 = 危险动作用中性灰避免抢眼
  const ACTION: Record<
    'add' | 'added' | 'remove' | 'preset',
    { icon: typeof Plus; label: string }
  > = {
    add: { icon: Plus, label: `加入我的电台: ${station.name}` },
    added: { icon: Check, label: `已在我的电台: ${station.name}` },
    remove: { icon: X, label: `从我的电台移除: ${station.name}` },
    preset: { icon: Trash2, label: `删除预设电台（可恢复）: ${station.name}` },
  }
  const spec = ACTION[action]
  const ActionIcon = spec.icon

  return (
    <div className="radio-row" data-current={current} data-action={action}>
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
      {/* 行尾动作：加入 = 实心小胶囊（主操作）；已加入 = 勾勾（不可点）；
          删除 = 悬停才现的中性图标（不抢眼） */}
      {action === 'added' ? (
        <span className="radio-row-added" title={`已在我的电台: ${station.name}`} aria-hidden>
          <Check className="size-3" />
        </span>
      ) : (
        <SmallAction
          label={spec.label}
          icon={ActionIcon}
          className="radio-row-action"
          onClick={() => onAction?.()}
        />
      )}
    </div>
  )
}

function StationList({ player }: { player: RadioPlayer }) {
  const favorites = useAtom(player.favorites)
  const hiddenPresets = useAtom(player.hiddenPresets)
  const station = useAtom(player.station)
  const status = useStatus(player)
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const [remote, setRemote] = useState<Station[]>([])
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState<null | string>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  // 删除确认（用户 2026-11-15：“删除要有确认弹窗啊”）：待确认的台 + 它的类型
  // （预设台删除影响更大，文案要说明“可在搜索里重新加入”）。
  const [pendingDelete, setPendingDelete] = useState<null | {
    station: Station
    kind: 'preset' | 'mine'
  }>(null)
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
    const pool = [...favorites, ...PRESET_STATIONS]
    if (!lowered) return pool
    return pool.filter((item) =>
      [item.name, item.description, item.provider].some((value) =>
        value?.toLowerCase().includes(lowered),
      ),
    )
  }, [favorites, text])

  // 搜索结果（不在本地命中里的才进远程区，防重复）
  const remoteItems = useMemo(() => {
    const rows = query === text ? remote : []
    return rows.filter(
      (item) => !inMyStations(favorites, item) && !PRESET_STATIONS.some((p) => isSameStation(p, item)),
    )
  }, [favorites, query, remote, text])

  // 「我的电台」区：自选列表（可删）；未搜索时显示全部，搜索时过滤
  const myStations = useMemo(() => {
    const lowered = text.toLowerCase()
    return lowered
      ? favorites.filter((item) =>
          [item.name, item.description, item.provider].some((value) =>
            value?.toLowerCase().includes(lowered),
          ),
        )
      : favorites
  }, [favorites, text])

  // 「预设」区：搜索时只显示命中，不搜索时全部显示。
  // **已加入“我的电台”的不在此区重复展示**（否则同一台会出现两行）；
  // **被用户删掉的预设台也不显示**（`hiddenPresets`）。
  const presetItems = useMemo(
    () =>
      visiblePresets(
        localMatches.filter(
          (item) =>
            PRESET_STATIONS.some((p) => isSameStation(p, item)) && !inMyStations(favorites, item),
        ),
        hiddenPresets,
      ),
    [favorites, hiddenPresets, localMatches],
  )

  const pending = text.length >= 2 && (text !== query || searching)
  const hasAnything = myStations.length > 0 || remoteItems.length > 0 || presetItems.length > 0

  const renderRow = (item: Station, action: 'add' | 'added' | 'remove' | 'preset') => (
    <StationRow
      key={item.id}
      station={item}
      current={isSameStation(item, station)}
      status={status}
      action={action}
      onSelect={() => {
        if (isSameStation(item, station)) player.toggle()
        else void player.play(item)
      }}
      onAction={
        action === 'remove'
          ? () => setPendingDelete({ station: item, kind: 'mine' })
          : action === 'preset'
            ? () => setPendingDelete({ station: item, kind: 'preset' })
            : action === 'add'
              ? () => player.addStation(item)
              : undefined
      }
    />
  )

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
        {/* 悬停滑动指示块（宿主 SessionListHoverPill 同模式）：首子节点、
            行在其后绘制盖上来 */}
        <StationListHoverPill />

        {/* ① 我的电台（自选列表；每行带删除） */}
        {myStations.length > 0 ? (
          <>
            <div className="radio-section">我的电台</div>
            {myStations.map((item) => renderRow(item, 'remove'))}
          </>
        ) : null}

        {/* ② 搜索结果（带“加入”按钮） */}
        {remoteItems.length > 0 ? (
          <>
            <div className="radio-section">搜索结果</div>
            {remoteItems.map((item) => renderRow(item, 'add'))}
          </>
        ) : null}

        {/* ③ 预设电台（带“钉到我的电台”） */}
        {presetItems.length > 0 ? (
          <>
            <div className="radio-section">预设电台</div>
            {presetItems.map((item) => renderRow(item, 'preset'))}
          </>
        ) : null}

        {searchError ? (
          <div className="radio-note" role="status">
            {searchError}
          </div>
        ) : null}
        {!pending && !searchError && !hasAnything ? (
          <div className="radio-note" role="status">
            {text ? '没有找到电台。' : '还没有自己的电台。搜索一个台名，点右侧 ＋ 加入列表。'}
          </div>
        ) : null}
      </div>

      {/* 删除确认弹窗（用户 2026-11-15：“删除要有确认弹窗啊”）。
          复用宿主 `ui/confirm-dialog`：打开即聚焦确认、Enter 确认、Esc 取消、
          destructive 样式——不另造一套弹窗。 */}
      <ConfirmDialog
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        destructive
        title={
          pendingDelete
            ? `${pendingDelete.kind === 'preset' ? '删除' : '移除'}「${pendingDelete.station.name}」？`
            : ''
        }
        description={
          pendingDelete?.kind === 'preset'
            ? '这台将从预设列表里隐藏。以后仍可在搜索框里找到它（或搜到同名台），点「加入」重新加回。'
            : '这台将从「我的电台」里移除。预设电台不受影响，可在预设区重新加入。'
        }
        confirmLabel={pendingDelete?.kind === 'preset' ? '删除' : '移除'}
        cancelLabel="取消"
        dismissOnConfirm
        onConfirm={() => {
          if (!pendingDelete) return
          if (pendingDelete.kind === 'preset') player.hidePreset(pendingDelete.station)
          else player.removeStation(pendingDelete.station)
        }}
      />
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
  const [artistUrl, setArtistUrl] = useState<null | string>(null)

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

  // 艺人主页解析（上游 useQuery：只在播且有艺人时跑；结果缓存一天）。
  // 只在**确切匹配**时变成链接；歧义/找不到保持纯文本（不造死链接）——
  // 上游注释：Missing or ambiguous matches stay plain text, with no dead
  // link or reserved icon gap。
  const artist = credit?.artist ?? ''
  useEffect(() => {
    if (!artist) {
      setArtistUrl(null)
      return
    }
    const controller = new AbortController()
    let cancelled = false
    void player
      .resolveArtist(artist, controller.signal)
      .then((href) => {
        if (!cancelled) setArtistUrl(href)
      })
      .catch((e: unknown) => {
        if (cancelled || controller.signal.aborted) return
        // 规矩 11：解析失败可见；UI 退纯文本
        console.error('[radio] 艺人主页解析失败', artist, e)
        setArtistUrl(null)
      })
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [artist, player])

  return (
    <div className="radio-track" data-track={Boolean(credit?.raw)} role="status">
      {status === 'connecting' ? (
        <Loader2 className="size-3 animate-spin" aria-label="正在连接" />
      ) : null}
      {credit?.artist ? (
        artistUrl ? (
          <a
            className="radio-track-artist radio-track-artist-link"
            href={artistUrl}
            rel="noreferrer noopener"
            target="_blank"
            title={`访问艺人主页: ${credit.artist}`}
            onClick={(event) => {
              event.preventDefault()
              void openExternal(artistUrl)
            }}
          >
            {credit.artist}
            <ExternalLink className="radio-track-artist-icon" aria-hidden />
          </a>
        ) : (
          <span className="radio-track-artist">{credit.artist}</span>
        )
      ) : null}
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
 * 版式（2026-11-15 用户定稿）：**播放器在顶部**，选台列表占满剩余高度。
 *
 * ```
 * ┌────────────────────────────────────┐
 * │ ⣿⣷⣦⣤⣴⣦⣷ 波形（整宽，两层余辉）      │  ← .radio-playerbar
 * │ 中国之声   Artist — Title            │
 * │ ⏯ ⏭  ──── 🔊 ────  🌐          ✕ │
 * ├────────────────────────────────────┤
 * │ 搜索电台…                           │
 * │ ● 中国之声                          │
 * │   广东音乐之声        ← 列表占满       │
 * │   …                                 │
 * └────────────────────────────────────┘
 * ```
 */
export function RadioPane({ onClose }: { onClose: () => void }) {
  // 播放器**必须在 effect 里建**，不能用 `useState(() => new RadioPlayer())`。
  // 理由（2026-11-15 实机复现「点播放没反应、状态恒为 paused」）：开发期
  // StrictMode 会挂载 → 卸载 → 再挂载，而 `useState` 初始化器创建的实例在
  // 重挂载后**被原样复用**——可它已经被上一轮 cleanup 的 dispose() 置为
  // disposed，于是 `play()` 开头的 `if (this.disposed) return` 直接吞掉整个
  // 播放。改成 effect 内建实例：每轮挂载拿到全新播放器，卸载时真正释放。
  const [player, setPlayer] = useState<null | RadioPlayer>(null)

  useEffect(() => {
    const instance = new RadioPlayer()
    setPlayer(instance)
    return () => {
      setPlayer(null)
      instance.dispose()
    }
  }, [])

  // 首帧（effect 尚未跑）只渲染骨架：hook 顺序稳定由 RadioPaneBody 承担。
  if (!player) {
    return <div className="radio-pane" data-slot="radio-pane" data-status="paused" />
  }

  return <RadioPaneBody player={player} onClose={onClose} />
}

/** 播放器就绪后的面板主体（所有读 atom 的 hook 都在这里，顺序稳定）。 */
function RadioPaneBody({ player, onClose }: { player: RadioPlayer; onClose: () => void }) {
  const station = useAtom(player.station)
  const status = useStatus(player)
  const active = status === 'live' || status === 'connecting'

  const onToggle = useCallback(() => player.toggle(), [player])

  return (
    <div className="radio-pane" data-slot="radio-pane" data-status={status}>
      {/* 播放条在**顶部**（用户 2026-11-15：“组件还是放在顶部吧”），两行独立区：
          第 1 行 = 整宽波形；第 2 行 = 台名/曲目；第 3 行 = 传输钮 + 音量 + 关闭。 */}
      <div className="radio-playerbar" data-slot="radio-playerbar">
        <Waveform player={player} />
        <div className="radio-playerbar-line">
          <span className="radio-bar-name" title={`${station.name} · ${STATUS_LABEL[status]}`}>
            {station.name}
          </span>
          <TrackLine player={player} />
        </div>
        <div className="radio-playerbar-line radio-playerbar-controls">
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
      <StationList player={player} />
    </div>
  )
}

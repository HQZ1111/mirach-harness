import { describe, expect, it } from 'vitest'

import {
  brailleTrace,
  DEFAULT_DIRECTORY_SERVERS,
  directorySearchPath,
  directoryServersFrom,
  flatTrace,
  httpsUrlOrNull,
  isValidStation,
  isSameStation,
  mapDirectoryRows,
  METADATA_ENDPOINTS,
  pickSource,
  PRESET_STATIONS,
  streamUrlOrNull,
  trackCredit,
  uniqueStations,
  type Station,
} from '@/components/panes/radio-pane'

/**
 * hermes radio 纯逻辑的宿主回归（移植自 `apps/desktop/src/plugins/radio/plugin.js`，
 * 2026-11-15）。上游没有对应单测（它是插件内联函数），这里钉住**保真判据**：
 * 预设台地址、URL 校验口径、目录映射的丢弃规则、波形编码。
 */
describe('radio-stations · 预设台', () => {
  it('7 个预设台与上游同 id/同流地址', () => {
    expect(PRESET_STATIONS).toHaveLength(7)
    expect(PRESET_STATIONS.map((s) => s.id)).toEqual([
      'chillsynth',
      'nightride',
      'darksynth',
      'spacesynth',
      'paradise-main',
      'paradise-mellow',
      'eve-radio',
    ])
    expect(PRESET_STATIONS[0]!.url).toBe('https://stream.nightride.fm/chillsynth.mp3')
    expect(PRESET_STATIONS[4]!.url).toBe('https://stream.radioparadise.com/aac-128')
    expect(PRESET_STATIONS[6]!.url).toBe('https://media01.gamingnow.net:8010/erweb.mp3')
  })

  it('每个预设台都过 isValidStation（流地址合法）', () => {
    for (const station of PRESET_STATIONS) expect(isValidStation(station)).toBe(true)
  })
})

describe('radio-stations · URL 校验', () => {
  it('https 放行，本机回环 http 放行，其它 http 拒绝', () => {
    expect(streamUrlOrNull('https://a.example/x.mp3')).toBe('https://a.example/x.mp3')
    expect(streamUrlOrNull('http://localhost:8000/x.mp3')).toBe('http://localhost:8000/x.mp3')
    expect(streamUrlOrNull('http://127.0.0.1:8000/x')).toBe('http://127.0.0.1:8000/x')
    expect(streamUrlOrNull('http://example.com/x.mp3')).toBeNull()
  })

  it('凭据写在 URL 里一律拒绝（上游同判据）', () => {
    expect(streamUrlOrNull('https://user:pass@a.example/x')).toBeNull()
  })

  it('非法输入返回 null，不抛', () => {
    expect(streamUrlOrNull('not a url')).toBeNull()
    expect(streamUrlOrNull(undefined)).toBeNull()
    expect(streamUrlOrNull(42)).toBeNull()
  })

  it('httpsUrlOrNull 对回环 http 返回 null（官网场景不要本机地址）', () => {
    expect(httpsUrlOrNull('http://localhost/x')).toBeNull()
    expect(httpsUrlOrNull('https://a.example/')).toBe('https://a.example/')
  })
})

describe('radio-stations · 台相等/去重', () => {
  const a: Station = { id: 'a', name: 'A', url: 'https://x/1' }
  const b: Station = { id: 'b', name: 'B', url: 'https://x/1' }
  const c: Station = { id: 'a', name: 'A2', url: 'https://x/2' }

  it('同 id 或同 url 即同一台', () => {
    expect(isSameStation(a, b)).toBe(true)
    expect(isSameStation(a, c)).toBe(true)
    expect(isSameStation(a, { id: 'z', name: 'Z', url: 'https://x/9' })).toBe(false)
  })

  it('去重按 id + url 双键，保序', () => {
    expect(uniqueStations([a, b, c])).toEqual([a])
    expect(uniqueStations([a, { id: 'z', name: 'Z', url: 'https://x/9' }])).toHaveLength(2)
  })
})

describe('radio-stations · Radio Browser 映射', () => {
  it('丢弃无 url/无 uuid/无 name 的行，跳过 HLS，按 url 去重', () => {
    const rows = [
      { stationuuid: 'u1', name: ' One ', url_resolved: 'https://a/1', tags: 'jazz,swing,extra' },
      { stationuuid: 'u2', name: 'Two', url_resolved: 'https://a/1' },
      { stationuuid: 'u3', name: 'Hls', url_resolved: 'https://a/3', hls: 1 },
      { stationuuid: 'u4', name: 'Insecure', url_resolved: 'http://a/4' },
      { name: 'NoUuid', url_resolved: 'https://a/5' },
      { stationuuid: 'u6', url_resolved: 'https://a/6' },
    ]
    const mapped = mapDirectoryRows(rows)
    expect(mapped).toHaveLength(1)
    expect(mapped[0]).toMatchObject({ id: 'u1', name: 'One', provider: 'Radio Browser', description: 'jazz · swing' })
  })

  it('非数组输入返回空数组（不抛）', () => {
    expect(mapDirectoryRows(null)).toEqual([])
    expect(mapDirectoryRows({})).toEqual([])
  })

  it('homepage 只保留 https', () => {
    const mapped = mapDirectoryRows([
      { stationuuid: 'u1', name: 'A', url_resolved: 'https://a/1', homepage: 'http://a/' },
      { stationuuid: 'u2', name: 'B', url_resolved: 'https://a/2', homepage: 'https://b/' },
    ])
    expect(mapped[0]!.homepage).toBeUndefined()
    expect(mapped[1]!.homepage).toBe('https://b/')
  })
})

describe('radio-stations · 目录镜像与检索参数', () => {
  it('只认 *.api.radio-browser.info 形态的主机', () => {
    const payload = {
      servers: [
        { name: 'de1.api.radio-browser.info' },
        { name: 'de1.api.radio-browser.info' },
        { name: 'evil.example.com' },
        { name: 'Bad_Host.api.radio-browser.info' },
        { name: 42 },
      ],
    }
    expect(directoryServersFrom(payload, () => 0)).toEqual(['https://de1.api.radio-browser.info'])
  })

  it('镜像列表洗牌但元素集合不变', () => {
    const payload = { servers: [{ name: 'a.api.radio-browser.info' }, { name: 'b.api.radio-browser.info' }] }
    const list = directoryServersFrom(payload, () => 0.99)
    expect(list).toHaveLength(2)
    expect(new Set(list)).toEqual(
      new Set(['https://a.api.radio-browser.info', 'https://b.api.radio-browser.info']),
    )
  })

  it('检索参数与上游逐字一致', () => {
    const path = directorySearchPath('lo fi')
    expect(path).toContain('/json/stations/search?')
    expect(path).toContain('name=lo+fi')
    expect(path).toContain('limit=60')
    expect(path).toContain('hidebroken=true')
    expect(path).toContain('order=votes')
    expect(path).toContain('reverse=true')
  })

  it('默认镜像就是上游初值', () => {
    expect([...DEFAULT_DIRECTORY_SERVERS]).toEqual(['https://de1.api.radio-browser.info'])
  })

  it('元数据端点表覆盖两个已知主机', () => {
    expect(METADATA_ENDPOINTS['stream.nightride.fm']).toBe('https://stream.nightride.fm/status-json.xsl')
    expect(METADATA_ENDPOINTS['media01.gamingnow.net']).toBe(
      'https://media01.gamingnow.net:8010/status-json.xsl',
    )
  })
})

describe('radio-stations · 曲目解析', () => {
  it('"Artist - Title" 拆两段', () => {
    expect(trackCredit({ title: 'Boards of Canada - Roygbiv' })).toEqual({
      artist: 'Boards of Canada',
      title: 'Roygbiv',
    })
  })

  it('显式 artist 优先，且只有前缀真的等于 artist 时才拆标题', () => {
    expect(trackCredit({ title: 'A - B', artist: 'A' })).toEqual({ artist: 'A', title: 'B' })
    expect(trackCredit({ title: 'A - B', artist: 'Other' })).toEqual({ artist: 'Other', title: 'A - B' })
    expect(trackCredit({ title: 'X', metadata: { artist: 'Y' } })).toEqual({ artist: 'Y', title: 'X' })
  })

  it('空/缺失输入返回空串（不编造）', () => {
    expect(trackCredit(null)).toEqual({ artist: '', title: '' })
    expect(trackCredit({ title: '   ' })).toEqual({ artist: '', title: '' })
  })

  it('pickSource 按 listenurl 后缀匹配当前台', () => {
    const payload = {
      icestats: {
        source: [
          { listenurl: 'https://stream.nightride.fm/chillsynth.mp3', title: 'A - B' },
          { listenurl: 'https://stream.nightride.fm/darksynth.mp3', title: 'C - D' },
        ],
      },
    }
    expect(pickSource(payload, '/chillsynth.mp3')).toMatchObject({ title: 'A - B' })
    expect(pickSource(payload, '/nope.mp3')).toBeNull()
    // 单个对象（非数组）也要认
    expect(pickSource({ icestats: { source: { listenurl: 'https://x/y.mp3' } } }, '/y.mp3')).not.toBeNull()
    expect(pickSource(null, '/y.mp3')).toBeNull()
  })
})

describe('radio-stations · braille 波形', () => {
  it('全零采样 = 平线（每格都是 BRAILLE PATTERN BLANK 或点阵中线）', () => {
    const trace = flatTrace(6, 2)
    expect(trace).toHaveLength(12)
    for (const cell of trace) expect(cell.codePointAt(0)! >= 0x2800).toBe(true)
  })

  it('输出宽度 = 采样数 / 2 × 行数', () => {
    expect(brailleTrace(new Array<number>(12).fill(0), 2)).toHaveLength(12)
    expect(brailleTrace(new Array<number>(12).fill(0), 1)).toHaveLength(6)
  })

  it('满幅正负采样会产生非空点阵（平线之外真的画了东西）', () => {
    const flat = flatTrace(6, 2).join('')
    const wave = brailleTrace([0, 1, -1, 1, -1, 1, -1, 1, -1, 1, -1, 1], 2).join('')
    expect(wave).not.toBe(flat)
  })
})
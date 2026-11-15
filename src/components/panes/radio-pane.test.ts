import { describe, expect, it } from 'vitest'

import {
  addToMyStations,
  appleArtistProfile,
  artistProfile,
  brailleTrace,
  DEFAULT_DIRECTORY_SERVERS,
  directorySearchPath,
  directoryServersFrom,
  flatTrace,
  httpsUrlOrNull,
  isValidStation,
  hidePreset,
  inMyStations,
  isSameStation,
  mapDirectoryRows,
  METADATA_ENDPOINTS,
  musicBrainzArtistId,
  musicBrainzArtistQuery,
  normalizedArtist,
  pickSource,
  PRESET_STATIONS,
  removeFromMyStations,
  unhidePreset,
  visiblePresets,
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
  it('15 个预设台：国内 8 台在前，上游 7 台在后', () => {
    expect(PRESET_STATIONS).toHaveLength(15)
    // 国内台优先（2026-11-15 用户："搞些国内的放进去"）——实测它们首字节
    // 0.2–2.3s、带宽稳定，而境外台贴在码率临界值上波动
    expect(PRESET_STATIONS.slice(0, 8).map((s) => s.id)).toEqual([
      'cn-cnr1',
      'cn-guangdong-music',
      'cn-beijing-news',
      'cn-guangdong-traffic',
      'cn-guangdong-stock',
      'cn-huaiji-music',
      'cn-intl-news',
      'cn-anhui-story',
    ])
    // 上游 7 台原样保留在后
    expect(PRESET_STATIONS.slice(8).map((s) => s.id)).toEqual([
      'chillsynth',
      'nightride',
      'darksynth',
      'spacesynth',
      'paradise-main',
      'paradise-mellow',
      'eve-radio',
    ])
    expect(PRESET_STATIONS[0]!.url).toBe('https://lhttp.qingting.fm/live/15318317/64k.mp3')
    expect(PRESET_STATIONS[8]!.url).toBe('https://stream.nightride.fm/chillsynth.mp3')
    expect(PRESET_STATIONS[12]!.url).toBe('https://stream.radioparadise.com/aac-128')
    expect(PRESET_STATIONS[14]!.url).toBe('https://media01.gamingnow.net:8010/erweb.mp3')
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
describe('radio-pane · 艺人主页解析（上游 artistProfile / resolveArtist）', () => {
  const spotify = 'https://open.spotify.com/artist/0123456789abcdefghijkl'
  const mbRel = (type: string, resource: string, ended = false) => ({ type, ended, url: { resource } })

  it('优先级：Spotify 艺人页 > bandcamp > official homepage', () => {
    const relations = [
      mbRel('official homepage', 'https://artist.example/'),
      mbRel('bandcamp', 'https://artist.bandcamp.com/'),
      mbRel('streaming', spotify),
    ]
    expect(artistProfile(relations)).toBe(spotify)
  })

  it('Spotify 只认 /artist/<22 位>，专辑/单曲/搜索页一律不要', () => {
    const album = mbRel('streaming', 'https://open.spotify.com/album/0123456789abcdefghijkl')
    expect(artistProfile([album])).toBeNull()
    const search = mbRel('streaming', 'https://open.spotify.com/search/foo')
    expect(artistProfile([search])).toBeNull()
  })

  it('bandcamp 必须是根路径的子域首页（不含 .bandcamp.com 主站）', () => {
    expect(artistProfile([mbRel('bandcamp', 'https://a.bandcamp.com/')])).toBe('https://a.bandcamp.com/')
    expect(artistProfile([mbRel('bandcamp', 'https://a.bandcamp.com/album/x')])).toBeNull()
    expect(artistProfile([mbRel('bandcamp', 'https://bandcamp.com/')])).toBeNull()
  })

  it('official homepage 排除 spotify/bandcamp 自身', () => {
    expect(artistProfile([mbRel('official homepage', 'https://open.spotify.com/x')])).toBeNull()
    expect(artistProfile([mbRel('official homepage', 'https://artist.example/')])).toBe(
      'https://artist.example/',
    )
  })

  it('已结束（ended）的关系和非法输入被跳过', () => {
    expect(artistProfile([mbRel('official homepage', 'https://a.example/', true)])).toBeNull()
    expect(artistProfile(null)).toBeNull()
    expect(artistProfile('nope')).toBeNull()
  })

  it('艺人名归一：NFKC + trim + 小写', () => {
    expect(normalizedArtist('  Ｋraftwerk ')).toBe('kraftwerk')
  })

  it('Apple 只接受唯一精确同名匹配，并剥掉查询串', () => {
    const payload = {
      results: [
        { wrapperType: 'artist', artistName: 'Kraftwerk', artistLinkUrl: 'https://music.apple.com/de/artist/kraftwerk/12345?uo=4' },
      ],
    }
    expect(appleArtistProfile(payload, 'kraftwerk')).toBe('https://music.apple.com/de/artist/kraftwerk/12345')
  })

  it('Apple 歧义（两条同名）返回 null，不猜', () => {
    const same = { wrapperType: 'artist', artistName: 'Nirvana', artistLinkUrl: 'https://music.apple.com/us/artist/nirvana/1' }
    expect(appleArtistProfile({ results: [same, { ...same, artistLinkUrl: 'https://music.apple.com/us/artist/nirvana/2' }] }, 'Nirvana')).toBeNull()
  })

  it('Apple 结果里只要艺人（wrapperType=artist），歌曲结果不用', () => {
    const song = { wrapperType: 'track', artistName: 'Kraftwerk', artistLinkUrl: 'https://music.apple.com/de/artist/kraftwerk/12345' }
    expect(appleArtistProfile({ results: [song] }, 'Kraftwerk')).toBeNull()
  })

  it('MusicBrainz：必须恰好一条 100 分精确同名，且结果不能正好 5 条', () => {
    const id = 'a1b2c3d4-1111-2222-3333-444455556666'
    const ok = { artists: [{ id, name: 'Kraftwerk', score: 100 }] }
    expect(musicBrainzArtistId(ok, 'Kraftwerk')).toBe(id)
    // 分数不是 100 → 不认
    expect(musicBrainzArtistId({ artists: [{ id, name: 'Kraftwerk', score: 99 }] }, 'Kraftwerk')).toBeNull()
    // 正好 5 条 → 可能被截断，不认
    const five = { artists: [...new Array(4)].map((_, i) => ({ id, name: `X${i}`, score: 50 })).concat({ id, name: 'Kraftwerk', score: 100 }) }
    expect(musicBrainzArtistId(five, 'Kraftwerk')).toBeNull()
  })

  it('MusicBrainz 非法 uuid 返回 null', () => {
    expect(musicBrainzArtistId({ artists: [{ id: 'not-a-uuid', name: 'A', score: 100 }] }, 'A')).toBeNull()
  })

  it('MusicBrainz 查询串对特殊字符做转义', () => {
    const query = musicBrainzArtistQuery('AC/DC')
    expect(query.startsWith('artist/?')).toBe(true)
    // 斜杠被转义成 \/（Lucene 查询语法要求），解码后仍是转义形态
    expect(decodeURIComponent(query)).toContain('artist:"AC\\/DC"')
    expect(query).toContain('fmt=json')
    expect(query).toContain('limit=5')
  })
})

describe('radio-pane · 我的电台增删（用户：搜索的能加入、列表里的能删除）', () => {
  const a: Station = { id: 'a', name: 'A', url: 'https://x/1' }
  const b: Station = { id: 'b', name: 'B', url: 'https://x/2' }

  it('加入：追加到末尾', () => {
    expect(addToMyStations([], a)).toEqual([a])
    expect(addToMyStations([a], b)).toEqual([a, b])
  })

  it('加入：同 id 或同 url 不重复（返回原引用，跳过重渲）', () => {
    const list = [a]
    expect(addToMyStations(list, { ...a, name: 'A2' })).toBe(list)
    expect(addToMyStations(list, { id: 'z', name: 'Z', url: 'https://x/1' })).toBe(list)
  })

  it('加入：非法台（url 不过校验）被忽略', () => {
    const list = [a]
    expect(addToMyStations(list, { id: 'x', name: 'X', url: 'http://insecure.example/s' })).toEqual([a])
  })

  it('删除：按同 id 或同 url 命中，其余保序', () => {
    expect(removeFromMyStations([a, b], a)).toEqual([b])
    expect(removeFromMyStations([a, b], { id: 'other', name: 'X', url: 'https://x/1' })).toEqual([b])
  })

  it('删除：未命中时返回原引用', () => {
    const list = [a]
    expect(removeFromMyStations(list, b)).toBe(list)
  })

  it('inMyStations 判定同 id 或同 url', () => {
    expect(inMyStations([a], { ...a, name: 'A2' })).toBe(true)
    expect(inMyStations([a], b)).toBe(false)
  })
})

describe('radio-pane · 预设台删除（用户：预设电台怎么不能删除）', () => {
  const a: Station = { id: 'p1', name: 'P1', url: 'https://x/1' }
  const b: Station = { id: 'p2', name: 'P2', url: 'https://x/2' }

  it('预设是内置常量：删除 = 记进隐藏集，不篡改源数据', () => {
    const before = PRESET_STATIONS.length
    const hidden = hidePreset([], a)
    expect(hidden).toEqual(['p1'])
    // 源常量不受影响
    expect(PRESET_STATIONS.length).toBe(before)
  })

  it('重复隐藏同一台不会产生重复 id（返回原引用）', () => {
    const hidden = ['p1']
    expect(hidePreset(hidden, a)).toBe(hidden)
  })

  it('visiblePresets 过滤掉隐藏项，保留其余顺序', () => {
    expect(visiblePresets([a, b], ['p1'])).toEqual([b])
    expect(visiblePresets([a, b], [])).toEqual([a, b])
  })

  it('unhidePreset 恢复指定台', () => {
    expect(unhidePreset(['p1', 'p2'], a)).toEqual(['p2'])
    expect(unhidePreset(['p2'], a)).toEqual(['p2'])
  })
})

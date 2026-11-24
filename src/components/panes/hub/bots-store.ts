/**
 * 机器人花名册存储（机器人弹出栏 + BotsDialog 的共享投影）。
 *
 * bot 数据形状（hermes plugins/hermes-bots 的宿主对偶——hermes bot =
 * profile 预设 + `ui_meta['hermes-bots']` 展示元数据；宿主两类合一存本地）：
 * - name：bot 名（启动即以该名开会话，rename_session 语义）；
 * - title：显示名称（hermes BotMeta.title 同语义——displayName 的第一优先）；
 * - systemPrompt：机器人人格（SessionOptions.system_prompt，sdk.rs:308）；
 * - provider/model：模型预设（"provider/modelId"——create_session_opts 拆分）；
 * - cwd：工作区目录（SessionOptions.working_directory，sdk.rs:311）；
 * - color/shape/image/custom：头像（avatar.tsx BotFace 的外观四元组；
 *   image = data URL——hermes 走 profiles.set_asset，宿主本地存）；
 * - pinned/hidden：花名册置顶 / 隐藏（hidden-bots.ts 同语义——隐藏只影响
 *   显示，行仍活着可从底部"已隐藏"区恢复）；
 * - sectionId/sectionName：分区归属（user-sections.ts：成员资格在 bot 身上，
 *   删分区不会孤儿任何人）；
 * - createdAt：创建时间戳（BotMeta.created 同语义）。
 *
 * **存储裁定：本地 JSON（v2 键），不用 pi settings。** 论证见 v1（pi
 * settings 是全局单文档 + bot 预设是桌面侧展示概念）。**v2 迁移**（2026-11-07
 * 完整移植 hermes 机器人页）：v1 键（mirach.harness.bots.v1）只含六字段，
 * 读到即映射成 v2 形状升格（v1 原值保留不删——hermes 'bot-meta-v2-migrated'
 * 同款不迁移先例）。
 *
 * zustand vanilla store；localStorage 持久化（读写时机显式）。禁止兜底：
 * JSON 损坏 console.error 后按空表起步（损坏文件保留在键上不覆盖）。
 */

import { createStore, useStore } from 'zustand'
import type { BotMeta } from './bots-types'

/** 机器人预设（hermes bot 的 pi 对偶：一份 SessionOptions 参数包 + 花名册元数据）。 */
export interface BotPreset {
  name: string
  /** 显示名称（空 = 用 name——hermes displayName 的 title 优先级）。 */
  title: string
  systemPrompt: string
  /** "provider/modelId"（model-catalog-store 的 id 形状）；空串 = pi 默认 */
  model: string
  /** 工作区目录；空串 = 进程 cwd */
  cwd: string
  description: string
  createdAt: number
  // ── hermes BotMeta 对偶字段 ──
  color?: string
  shape?: string
  image?: null | string
  /** 用户改过头像后置位（默认外观停止套用——hermes 同语义）。 */
  custom?: boolean
  pinned?: boolean
  hidden?: boolean
  sectionId?: null | string
  sectionName?: null | string
  /** 归属连接（多环境，2026-11-07）：'local' = 本机（真面）；远端连接的
   *  bot 启动为占位（标红——pi 无远端 gateway）。缺省 = 'local'。 */
  connectionId?: string
  /** 永久会话文件路径（"one bot = one forever chat"——首启记录，再启
   *  打开同一条会话，上下文保留。hermes canonical chat 的宿主对偶，
   *  纯前端实现不改引擎）。 */
  chatSessionPath?: null | string
  /** 永久会话的 pi 身份（文件 header id——pi sessions 表只有 path 主键，
   *  **name 无唯一索引**，同名会话会撞；sessionId 是无歧义锚）。与
   *  chatSessionPath 成对记录（双锚才可信——见 botChatPaths）。 */
  chatSessionId?: null | string
  /** 技能白名单（hermes profile.skills 对偶）：pi_capabilities 里已装技能
   *  的名字子集；空/缺省 = 不附加。启动时拼进 system prompt（pi 无
   *  per-session 技能注入面，bot-launch 组合）。 */
  skills?: string[]
  /** 工具集白名单（hermes profile toolsets 对偶）：pi_capabilities 的
   *  toolset key 子集；空/缺省 = 全局偏好/pi 默认集。启动时映射为
   *  enabled_tools 传给 pi_create_bot_session（宿主 Rust 层透传
   *  SessionOptions.enabled_tools）。 */
  toolsets?: string[]
  /** 扩展白名单（per-bot extension_filter）：全局 extensions/ 下的 DLL 文件名
   *  子集（不含扩展名）；空/缺省 = 加载全部（pi 默认行为）。启动时传给
   *  pi_create_bot_session → build_harness_impl → Args.extension 逐文件加载。 */
  extensions?: string[]
  /** MCP 服务器白名单（hermes McpSetupButton 对偶）：全局 mcp.json 里的
   *  mcpServers key 子集。启动时生成 **per-bot MCP 配置文件**（只含所选
   *  服务器），路径注入 system prompt——rpi-mcp-adapter 的 mcp_list/mcp_call
   *  接受 configPath，per-bot 由此真生效。缺省 = 不生成（沿用全局）。 */
  mcpServers?: string[]
}

/** patchMeta 接受的元数据补丁形状（BotPreset 的展示/行为字段子集）。 */
export type BotPatch = Partial<
  Pick<BotPreset, 'pinned' | 'hidden' | 'sectionId' | 'sectionName' | 'color' | 'shape' | 'image' | 'custom' | 'title' | 'chatSessionPath' | 'chatSessionId' | 'connectionId' | 'skills' | 'toolsets' | 'mcpServers'>
>

/** 本体环境（hermes 默认 profile "Hermes" 的宿主对偶，2026-11-22）：
 *  永远在场、不可删除；它承载"应用自身/默认配置"这一环境，侧栏「配置
 *  档案」选它 = 只看未被任何 bot 拥有的会话。 */
export const DEFAULT_BOT_NAME = 'default'

/** 默认 Mirach bot 的头像（2026-11-23 用户："默认的mirach头像不能更改，换成
 *  logo的"）——品牌 logo 随 `public/brand/logo.png` 打包，BotFace 直接当
 *  `<img src>` 用。用户仍可在编辑对话框里换成自己的图（custom 后迁移不动）。 */
export const DEFAULT_BOT_AVATAR = '/brand/logo.png'

/** 一次性迁移标记：把「默认 Mirach bot」的旧头像换成品牌 logo（2026-11-23
 *  用户："默认的mirach头像不能更改，换成logo的"）。迁移后用户再改头像不再覆盖。 */
const DEFAULT_LOGO_MIGRATION_KEY = 'mirach.harness.default-bot-logo.v1'

/** hermes-bots 插件自己的 bot-meta 本地缓存（runtime-loader storage 的落盘键）。
 *  机器人页头像是从这份 meta 画的，不是 botsStore——只改 botsStore 页面上
 *  仍是旧头。 */
const PLUGIN_BOT_META_V2_KEY = 'mirach.plugin.hermes-bots.bot-meta-v2'
const DEFAULT_LOGO_PLUGIN_MIGRATION_KEY = 'mirach.harness.default-bot-logo.plugin.v1'

function migrateDefaultBotPluginMeta(): void {
  try {
    if (localStorage.getItem(DEFAULT_LOGO_PLUGIN_MIGRATION_KEY)) return
    const raw = localStorage.getItem(PLUGIN_BOT_META_V2_KEY)
    if (raw) {
      const parsed: unknown = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const meta = parsed as Record<string, unknown>
        for (const key of ['local::default', 'default']) {
          const entry = meta[key]
          if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
            meta[key] = { ...(entry as Record<string, unknown>), image: DEFAULT_BOT_AVATAR }
          }
        }
        localStorage.setItem(PLUGIN_BOT_META_V2_KEY, JSON.stringify(meta))
      }
    }
    localStorage.setItem(DEFAULT_LOGO_PLUGIN_MIGRATION_KEY, '1')
  } catch (e) {
    console.error('[bots] 默认头像插件元数据迁移失败', e)
  }
}

migrateDefaultBotPluginMeta()

export function makeDefaultBot(): BotPreset {
  return {
    name: DEFAULT_BOT_NAME,
    // hermes 的 displayName 对未命名的 default profile 返回产品名 "Hermes"；
    // 宿主品牌替换后同位置显示 "Mirach"（不是"本体"——那是宿主早期自造名）。
    title: 'Mirach',
    systemPrompt: '',
    model: '',
    cwd: '',
    description: 'Mirach 默认环境（应用默认配置）',
    image: DEFAULT_BOT_AVATAR,
    createdAt: 0,
  }
}

/** 用户自建分区（hermes user-sections：{id, name}，本地存储）。 */
export interface BotSection {
  id: string
  name: string
}

interface BotsState {
  bots: BotPreset[]
  sections: BotSection[]
  load: () => void
  save: (bots: BotPreset[]) => void
  upsert: (bot: BotPreset, previousName?: string) => void
  remove: (name: string) => void
  saveSections: (sections: BotSection[]) => void
  addSection: (name: string) => BotSection | null
  renameSection: (id: string, name: string) => void
  removeSection: (id: string) => void
  /** 花名册元数据写穿（pinned/hidden/section/头像——hermes saveBotMeta 同款）。 */
  patchMeta: (name: string, patch: BotPatch) => void
}

const STORAGE_KEY = 'mirach.harness.bots.v2'
const LEGACY_KEY = 'mirach.harness.bots.v1'
const SECTIONS_KEY = 'mirach.harness.bot-sections.v1'

/** React 订阅（机器人弹出栏 / bots-dialog 用）。 */
export const useBotsStore = <T,>(selector: (s: BotsState) => T): T =>
  useStore(botsStore, selector)

const parseStored = (raw: string | null): BotPreset[] => {
  if (raw === null) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    // 坏文档可见不覆盖（用户可手动恢复该键）——禁止静默清场
    console.error('[bots] 存储解析失败——按空表起步（原值保留未覆盖）', e)
    return []
  }
  if (!Array.isArray(parsed)) {
    console.error('[bots] 存储形状非法（应为数组）——按空表起步', parsed)
    return []
  }
  return parsed.filter(
    (b): b is BotPreset =>
      typeof b === 'object' &&
      b !== null &&
      typeof (b as BotPreset).name === 'string' &&
      (b as BotPreset).name.length > 0,
  )
}

const parseSections = (raw: string | null): BotSection[] => {
  if (raw === null) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (s): s is BotSection =>
        typeof s === 'object' && s !== null && typeof (s as BotSection).id === 'string' && typeof (s as BotSection).name === 'string',
    )
  } catch {
    return []
  }
}

/** v1 → v2 升格（v1 的六字段原样搬；v2 新字段走默认）。 */
const migrateV1 = (raw: string | null): BotPreset[] => {
  const legacy = parseStored(raw).map((b) => ({
    ...b,
    title: '',
  }))
  if (legacy.length > 0) {
    // 升格结果写进 v2 键（v1 原值保留——hermes 迁移同款不删旧键）
    localStorage.setItem(STORAGE_KEY, JSON.stringify(legacy))
  }
  return legacy
}

export const botsStore = createStore<BotsState>((set, get) => ({
  bots: [],
  sections: [],
  load: () => {
    const v2 = localStorage.getItem(STORAGE_KEY)
    let bots = v2 === null ? migrateV1(localStorage.getItem(LEGACY_KEY)) : parseStored(v2)
    // 本体环境永远在场（hermes 默认 profile 的宿主对偶）——旧用户数据首次
    // 读到即补种并写回（一次），此后用户可改 title/头像，但删不掉。
    if (!bots.some((b) => b.name === DEFAULT_BOT_NAME)) {
      bots = [makeDefaultBot(), ...bots]
      localStorage.setItem(STORAGE_KEY, JSON.stringify(bots))
    } else {
      // 宿主 v1 种子的默认显示名「本体」/空标题一次性升格为 hermes 同款的
      // 产品名（用户自改过的 title 不动）。
      let changed = false
      bots = bots.map((b) => {
        if (b.name !== DEFAULT_BOT_NAME) return b
        let next = b
        if (b.title === '本体' || b.title === '') {
          next = { ...next, title: 'Mirach' }
          changed = true
        }
        // 默认 Mirach 头像一次性换成品牌 logo（覆盖旧自造头像；迁移标记后
        // 用户再改头像不再覆盖）。
        if (!localStorage.getItem(DEFAULT_LOGO_MIGRATION_KEY)) {
          next = { ...next, image: DEFAULT_BOT_AVATAR }
          changed = true
        }
        return next
      })
      if (changed) localStorage.setItem(STORAGE_KEY, JSON.stringify(bots))
    }
    if (!localStorage.getItem(DEFAULT_LOGO_MIGRATION_KEY)) {
      try {
        localStorage.setItem(DEFAULT_LOGO_MIGRATION_KEY, '1')
      } catch (e) {
        console.error('[bots] 记录默认头像迁移标记失败', e)
      }
    }
    set({ bots, sections: parseSections(localStorage.getItem(SECTIONS_KEY)) })
  },
  save: (bots) => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(bots))
    set({ bots })
  },
  upsert: (bot, previousName) => {
    const trimmed = bot.name.trim()
    if (!trimmed) {
      console.error('[bots] 空名称——忽略')
      return
    }
    const rest = get().bots.filter((b) => b.name !== trimmed && b.name !== previousName)
    get().save([...rest, { ...bot, name: trimmed }])
  },
  remove: (name) => {
    // 本体不可删（UI 已用 isDefaultBot 隐藏删除项；这里是数据层第二道闸，
    // 违规删除 = 错误可见不静默装成功，规矩 12）。
    if (name === DEFAULT_BOT_NAME) {
      console.error('[bots] 本体环境不可删除——已忽略')
      return
    }
    get().save(get().bots.filter((b) => b.name !== name))
  },
  saveSections: (sections) => {
    localStorage.setItem(SECTIONS_KEY, JSON.stringify(sections))
    set({ sections })
  },
  addSection: (name) => {
    const trimmed = name.trim()
    if (!trimmed) return null
    const section: BotSection = { id: `sec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, name: trimmed }
    get().saveSections([...get().sections, section])
    return section
  },
  renameSection: (id, name) => {
    const trimmed = name.trim()
    if (!trimmed) return
    const sections = get().sections.map((s) => (s.id === id ? { ...s, name: trimmed } : s))
    get().saveSections(sections)
    // 分区改名同步 bot 身上的 sectionName（hermes：名字随成员资格走）
    get().save(
      get().bots.map((b) => (b.sectionId === id ? { ...b, sectionName: trimmed } : b)),
    )
  },
  removeSection: (id) => {
    get().saveSections(get().sections.filter((s) => s.id !== id))
    // 归属该分区的 bot 回到未分类（hermes：删分区不孤儿任何人）
    get().save(
      get().bots.map((b) => (b.sectionId === id ? { ...b, sectionId: null, sectionName: null } : b)),
    )
  },
  patchMeta: (name, patch) => {
    get().save(get().bots.map((b) => (b.name === name ? { ...b, ...patch } : b)))
  },
}))

/** 模型预设 "provider/modelId" → (provider, modelId)；空串 = 两者皆 null
 *  （pi 默认）。含 '/' 的 model id（HF 风格）不被此截断——indexOf 第一
 *  斜杠切分，provider 段不含 '/'（ComposerWired 审查 #1 同款边界）。
 *  无斜杠的非空值 = 形状非法，两者皆 null——调用方（BotsDialog）先做
 *  表单校验（非法值禁提交），这里不再兜底猜语义。 */
export function splitBotModel(model: string): {
  provider: string | null
  modelId: string | null
} {
  const trimmed = model.trim()
  if (!trimmed) return { provider: null, modelId: null }
  const idx = trimmed.indexOf('/')
  if (idx <= 0) return { provider: null, modelId: null }
  return { provider: trimmed.slice(0, idx), modelId: trimmed.slice(idx + 1) }
}

/** bot 显示名（hermes displayName 的宿主版：title 优先，回落 name）。 */
export function botDisplayName(bot: BotPreset): string {
  return bot.title.trim() || bot.name
}

/** bot 永久会话的路径集（会话侧栏隐藏过滤用——hermes "花名册是唯一入口"
 *  的宿主实现：pi 无 hidden 会话面，隐藏只能做在前端显示层）。
 *
 * **只收双锚记录**（path + sessionId 都在）：旧版按 name 匹配记录的路径
 * 没有身份校验，可能指向同名的用户会话——那种记录若参与过滤会误藏用户
 * 会话；它在 bot 下次启动时经 pi_get_state 校验重新锚定（bot-launch），
 * 之后才进入本集。 */
export function botChatPaths(bots: readonly BotPreset[]): ReadonlySet<string> {
  const out = new Set<string>()
  for (const b of bots) {
    if (b.chatSessionPath && b.chatSessionId) out.add(b.chatSessionPath)
  }
  return out
}

/**
 * `host.request` / `host.requestProfile` 的宿主 RPC 对偶。
 *
 * ## 上游是什么
 *
 * hermes 的 `host.request(method, params)` 是插件访问后端的**唯一 RPC 门**
 * —— 上游 `gateway` 是 Python 后端 + WebSocket 网关，方法名（`profiles.list`
 * / `session.create` / `cron.manage` …）是网关的 JSON-RPC 契约。
 *
 * ## 宿主怎么对偶
 *
 * Mirach 没有 gateway：**数据真相在 pi 引擎（Rust IPC）与本地 store**。
 * 这张表把 bots 插件实际调用的方法逐个映射到宿主真实现：
 *
 * | 上游方法 | 宿主实现 |
 * |---|---|
 * | `profiles.list` | `botsStore`（BotPreset 行）→ hermes RosterRow 形状 |
 * | `profiles.create` | `botsStore.upsert` |
 * | `profiles.configure` | `botsStore` 字段写回 + `hermes-bots` ui_meta 余字段落盘 |
 * | `profiles.set_asset` / `get_asset` | BotPreset.image（data URL） |
 * | `profiles.describe` | `pi_capabilities` + bot（skills/toolsets/model/soul） |
 * | `session.list` | `pi_sessions_index` |
 * | `session.create` | `pi_create_bot_session`（bots 带人格/模型/工具集） |
 * | `session.title` | `pi_rename_session` |
 * | `session.info` | 索引按 id 查（缺 → `data.reason='not_found'`） |
 * | `session.interrupt` | `pi_interrupt` |
 * | `session.compress` | `pi_compact` |
 * | `cron.manage` | `pi_cron_*` |
 * | `skills.manage` | 宿主无技能市场（明确报错；搜索面另行接线） |
 * | `cli.exec` | `pi_run_command`；`profile delete` 映射为删 bot |
 * | `groups.*` | `groups_dispatch`（Rust hosted_rooms） |
 *
 * **没实现的方法一律 throw**（工程规矩 12：不假装成功）。上游对
 * `profiles.describe` / `mcp.catalog` 这类能力面有 feature-detect / catch，
 * 抛错会让 UI 走"旧网关"分支——这是上游自己的降级路径，不是我们伪造的。
 *
 * ## ui_meta 的余字段
 *
 * hermes 把 bot 展示元数据存在 profile.yaml 的 `ui_meta['hermes-bots']`。
 * 宿主把**已知字段**存在 BotPreset 上，**未知字段**（`groups`、`group`、
 * `imageKind`、`screenAutoOpen` 以及未来新增）原样存一个本地映射表
 * （`mirach.harness.bot-ui-meta.v1`），保证 configure → list 往返不丢数据
 * ——群聊成员表就骑在 `groups` 上。
 */

import { invoke } from '@tauri-apps/api/core'

import {
  botDisplayName,
  botsStore,
  type BotPatch,
  type BotPreset,
} from '@/components/panes/hub/bots-store'

// ── 本地 ui_meta 余字段表 ───────────────────────────────────────────────────

const BOT_UI_META_KEY = 'mirach.harness.bot-ui-meta.v1'

type UnknownMeta = Record<string, unknown>

function readMetaExtras(): Record<string, UnknownMeta> {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(BOT_UI_META_KEY)
  } catch (e) {
    console.error('[host-rpc] 读取 bot ui_meta 余字段失败', e)
    return {}
  }
  if (raw === null) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      console.error('[host-rpc] bot ui_meta 余字段形状非法——按空表起步', parsed)
      return {}
    }
    return parsed as Record<string, UnknownMeta>
  } catch (e) {
    console.error('[host-rpc] bot ui_meta 余字段解析失败——按空表起步', e)
    return {}
  }
}

function writeMetaExtras(next: Record<string, UnknownMeta>): void {
  try {
    localStorage.setItem(BOT_UI_META_KEY, JSON.stringify(next))
  } catch (e) {
    // 逐字工程规矩 12：失败要传播（否则 configure 假装成功，下次 list 丢字段）
    throw new Error(`bot ui_meta 落盘失败：${e instanceof Error ? e.message : String(e)}`)
  }
}

function patchMetaExtras(name: string, patch: UnknownMeta): void {
  const all = readMetaExtras()
  all[name] = { ...(all[name] ?? {}), ...patch }
  writeMetaExtras(all)
}

/** ui_meta 里由 BotPreset 直接持有的字段（不进余字段表）。 */
const MAPPED_META_KEYS = new Set([
  'created',
  'color',
  'custom',
  'description',
  'hidden',
  'image',
  'pinned',
  'sectionId',
  'sectionName',
  'shape',
  'title',
])

// ── BotPreset ⇄ hermes RosterRow ────────────────────────────────────────────

let botsLoaded = false

/** 首次访问时从 localStorage 水合（bots-pane 未挂载时花名册也必须真实）。 */
function ensureBotsLoaded(): BotPreset[] {
  if (!botsLoaded) {
    botsLoaded = true
    botsStore.getState().load()
  }
  return botsStore.getState().bots
}

function findBot(name: string): BotPreset | null {
  const trimmed = name.trim()
  if (!trimmed) return null
  return ensureBotsLoaded().find((b) => b.name === trimmed) ?? null
}

/** BotPreset → `ui_meta['hermes-bots']`（hermes BotMeta 形状）。 */
function botBotMeta(bot: BotPreset): UnknownMeta {
  const extras = readMetaExtras()[bot.name] ?? {}
  return {
    ...extras,
    title: bot.title,
    description: bot.description,
    color: bot.color,
    shape: bot.shape,
    image: bot.image ?? null,
    custom: bot.custom ?? false,
    pinned: bot.pinned ?? false,
    hidden: bot.hidden ?? false,
    sectionId: bot.sectionId ?? null,
    sectionName: bot.sectionName ?? null,
    created: bot.createdAt,
  }
}

/** BotPreset → hermes `profiles.list` 行（路径收敛处见文件头）。 */
function botToRosterRow(bot: BotPreset): Record<string, unknown> {
  const sessionId = bot.chatSessionId ?? null
  return {
    name: bot.name,
    display_name: botDisplayName(bot),
    handle: bot.name,
    title: bot.title || null,
    description: bot.description,
    connectionId: 'local',
    connectionKind: 'local',
    connectionLabel: '本机',
    targetProfile: bot.name,
    has_avatar: Boolean(bot.image),
    // 永久会话（"one bot = one forever chat"）：host.openSession 拿 id；
    // hermes 服务端按标题解析 "Bot Chat"，宿主按双锚记录直给。
    canonical_session: sessionId
      ? {
          id: sessionId,
          resolved_id: sessionId,
          title: 'Bot Chat',
          root_title: 'Bot Chat',
        }
      : null,
    last_session: null,
    ui_meta: { 'hermes-bots': botBotMeta(bot) },
    ui_meta_revisions: { 'hermes-bots': 1 },
  }
}

/** `ui_meta['hermes-bots']` → BotPreset 补丁 + 余字段。 */
function applyBotMeta(name: string, meta: UnknownMeta): void {
  const patch: BotPatch = {}
  const extras: UnknownMeta = {}

  for (const [key, value] of Object.entries(meta)) {
    if (MAPPED_META_KEYS.has(key)) continue
    extras[key] = value
  }
  if (Object.keys(extras).length > 0) patchMetaExtras(name, extras)

  if (typeof meta.title === 'string') patch.title = meta.title
  if (typeof meta.color === 'string') patch.color = meta.color
  if (typeof meta.shape === 'string') patch.shape = meta.shape
  if (typeof meta.image === 'string') patch.image = meta.image
  if (meta.image === null) patch.image = null
  if (typeof meta.custom === 'boolean') patch.custom = meta.custom
  if (typeof meta.pinned === 'boolean') patch.pinned = meta.pinned
  if (typeof meta.hidden === 'boolean') patch.hidden = meta.hidden
  if (meta.sectionId === null || typeof meta.sectionId === 'string') {
    patch.sectionId = meta.sectionId
  }
  if (meta.sectionName === null || typeof meta.sectionName === 'string') {
    patch.sectionName = meta.sectionName
  }
  // description 不是 BotPatch 字段（BotPreset 上却有）——直接走 upsert。
  const bot = findBot(name)
  if (bot && typeof meta.description === 'string' && meta.description !== bot.description) {
    botsStore.getState().upsert({ ...bot, description: meta.description })
  }

  botsStore.getState().patchMeta(name, patch)
}

// ── 会话行 ──────────────────────────────────────────────────────────────────

interface PiSessionRow {
  id: string
  name: null | string
  path: string
  cwd?: string
  messageCount?: number
  lastModified?: number
  lastModifiedMs?: number
  timestamp?: string
}

/** `pi_sessions_index`（跨工作区）+ `pi_list_sessions`（启动根基线）合并。 */
async function readSessions(): Promise<PiSessionRow[]> {
  const merged = new Map<string, PiSessionRow>()
  try {
    const index = await invoke<{ sessions?: PiSessionRow[] }>('pi_sessions_index')
    for (const row of index?.sessions ?? []) {
      if (row?.id) merged.set(row.id, row)
    }
  } catch (e) {
    console.error('[host-rpc] pi_sessions_index 读取失败——退回 pi_list_sessions', e)
  }
  const base = await invoke<PiSessionRow[]>('pi_list_sessions')
  for (const row of base ?? []) {
    if (row?.id && !merged.has(row.id)) merged.set(row.id, row)
  }
  return [...merged.values()]
}

function sessionToChatRow(row: PiSessionRow): Record<string, unknown> {
  return {
    id: row.id,
    title: row.name ?? '',
    root_title: row.name ?? '',
    message_count: row.messageCount ?? undefined,
    last_active: row.lastModified ?? row.lastModifiedMs ?? undefined,
  }
}

/** 按 id 找会话文件路径（刚建的会话可能还没进 pi_sessions_index）。 */
async function findSessionPath(sessionId: string): Promise<null | string> {
  try {
    const rows = await invoke<PiSessionRow[]>('pi_list_sessions')
    return (rows ?? []).find((r) => r.id === sessionId)?.path ?? null
  } catch (e) {
    console.error('[host-rpc] pi_list_sessions 读取失败', e)
    return null
  }
}

function missingSession(sessionId: string): Error {
  const error = new Error(`session not found: ${sessionId}`)
  // canonical-chat 的 isMissingSessionError 只看 data.reason / message
  ;(error as Error & { data?: unknown }).data = { reason: 'not_found' }
  return error
}

async function requireSession(sessionId: string): Promise<PiSessionRow> {
  const rows = await readSessions()
  const row = rows.find((r) => r.id === sessionId)
  if (!row) throw missingSession(sessionId)
  return row
}

// ── 启动参数（与 bot-launch.ts 同源语义）───────────────────────────────────

function splitModel(model: string): { modelId: null | string; provider: null | string } {
  const trimmed = model.trim()
  if (!trimmed) return { modelId: null, provider: null }
  const idx = trimmed.indexOf('/')
  if (idx <= 0) return { modelId: null, provider: null }
  return { modelId: trimmed.slice(idx + 1), provider: trimmed.slice(0, idx) }
}

/** bot 技能白名单 → system prompt 追加段（pi 无 per-session 技能注入面）。 */
function composeSystemPrompt(bot: BotPreset): string {
  const base = bot.systemPrompt.trim()
  const skills = (bot.skills ?? []).filter((s) => s.trim() !== '')
  if (skills.length === 0) return base
  const block = `# Skills\nThe following skills are attached to this agent. When a task matches, invoke them (slash form in prompts): ${skills.map((s) => `/${s}`).join(', ')}`
  return base ? `${base}\n\n${block}` : block
}

async function enabledToolsFor(bot: BotPreset): Promise<null | string[]> {
  const keys = (bot.toolsets ?? []).filter((s) => s.trim() !== '')
  if (keys.length === 0) return null
  const caps = await invoke<{ toolsets: { key: string; tools: string[] }[] }>('pi_capabilities')
  const set = new Set<string>()
  for (const ts of caps.toolsets) {
    if (!keys.includes(ts.key)) continue
    for (const tool of ts.tools) set.add(tool)
  }
  if (set.size === 0) {
    throw new Error(`所选工具集 ${keys.join(', ')} 在 pi_capabilities 中无工具`)
  }
  return [...set]
}

async function createSessionForBot(
  bot: BotPreset | null,
  title: string,
): Promise<{ session_id: string; stored_session_id: string }> {
  const systemPrompt = bot ? composeSystemPrompt(bot) : ''
  const { provider, modelId } = splitModel(bot?.model ?? '')
  const enabledTools = bot ? await enabledToolsFor(bot) : null
  const state = await invoke<{ sessionId?: null | string }>('pi_create_bot_session', {
    name: title,
    ...(systemPrompt ? { systemPrompt } : {}),
    ...(provider ? { provider, modelId } : {}),
    ...(bot?.cwd ? { cwd: bot.cwd } : {}),
    ...(enabledTools ? { enabledTools } : {}),
  })
  const sid = state?.sessionId ?? null
  if (!sid) {
    throw new Error('pi_create_bot_session 未返回 sessionId')
  }
  return { session_id: sid, stored_session_id: sid }
}

// ── cron ────────────────────────────────────────────────────────────────────

interface PiCronJob {
  bot?: null | string
  enabled?: boolean
  id: string
  last_error?: null | string
  last_run_at?: null | string
  name?: null | string
  next_run_at?: null | string
  prompt?: null | string
  repeat?: { completed?: number; times?: null | number }
  schedule?: unknown
  schedule_display?: string
  state?: string
  workdir?: null | string
}

function cronToRoutine(job: PiCronJob): Record<string, unknown> {
  return {
    job_id: job.id,
    name: job.name ?? '',
    schedule: job.schedule_display ?? '',
    prompt: job.prompt ?? '',
    prompt_preview: (job.prompt ?? '').slice(0, 200),
    enabled: job.enabled !== false,
    state: job.state ?? (job.enabled === false ? 'paused' : 'scheduled'),
    repeat: job.repeat?.times ?? undefined,
    last_run_at: job.last_run_at ?? undefined,
    next_run_at: job.next_run_at ?? undefined,
    last_fire_error: job.last_error ?? undefined,
    workdir: job.workdir ?? undefined,
  }
}

async function cronManage(params: Record<string, unknown>): Promise<unknown> {
  const action = String(params.action ?? '')
  const name = typeof params.name === 'string' ? params.name : undefined
  // `pi_cron_jobs` 回 `{jobs, tickerRunning}`（不是裸数组——曾按数组拍平，
  // 空表时 `(jobs ?? []).map` 直接 TypeError，例程窗格永远"读取失败"）。
  const listJobs = async (): Promise<PiCronJob[]> => {
    const reply = await invoke<{ jobs?: unknown }>('pi_cron_jobs')
    if (!Array.isArray(reply?.jobs)) {
      throw new Error(`pi_cron_jobs 返回形状非法（缺 jobs 数组）：${JSON.stringify(reply).slice(0, 200)}`)
    }
    return reply.jobs as PiCronJob[]
  }
  switch (action) {
    case 'list': {
      const jobs = await listJobs()
      return { jobs: jobs.map(cronToRoutine) }
    }
    case 'add': {
      const profile = typeof params.profile === 'string' ? params.profile : undefined
      await invoke('pi_cron_create', {
        input: {
          name: name ?? '',
          schedule: String(params.schedule ?? ''),
          prompt: String(params.prompt ?? ''),
          ...(typeof params.workdir === 'string' ? { workdir: params.workdir } : {}),
          ...(profile ? { bot: profile } : {}),
          ...(typeof params.repeat === 'number' ? { repeat: params.repeat } : {}),
        },
      })
      return {}
    }
    case 'pause':
    case 'resume':
    case 'trigger':
    case 'delete':
    // 上游 bots 的行内删除按钮发的是 `remove`（cron.tsx RoutineRow.act）；
    // `delete` 是同义别名（其它调用面）。曾只收 delete → 删除永远报
    // "未知 action：remove"。
    case 'remove':
    case 'update': {
      if (!name) throw new Error(`cron.manage ${action} 缺少 name`)
      const jobs = await listJobs()
      const job = (jobs ?? []).find((j) => j.id === name || j.name === name)
      if (!job) throw new Error(`定时任务不存在：${name}`)
      if (action === 'update') {
        await invoke('pi_cron_update', {
          id: job.id,
          input: {
            ...(typeof params.schedule === 'string' ? { schedule: params.schedule } : {}),
            ...(typeof params.prompt === 'string' ? { prompt: params.prompt } : {}),
          },
        })
        return {}
      }
      const command =
        action === 'pause'
          ? 'pi_cron_pause'
          : action === 'resume'
            ? 'pi_cron_resume'
            : action === 'trigger'
              ? 'pi_cron_trigger'
              : 'pi_cron_delete'
      await invoke(command, { id: job.id })
      return {}
    }
    default:
      throw new Error(`cron.manage 未知 action：${action}`)
  }
}

// ── cli.exec ────────────────────────────────────────────────────────────────

async function cliExec(params: Record<string, unknown>): Promise<unknown> {
  const argv = Array.isArray(params.argv) ? params.argv.map(String) : null
  if (!argv) throw new Error('cli.exec 缺少 argv')
  // hermes CLI 的 profile 子命令 → bot 预设（宿主没有 profile.yaml）
  if (argv[0] === 'profile') {
    const action = argv[1]
    const name = argv[2]
    if (action === 'delete' && name) {
      botsStore.getState().remove(name)
      return { code: 0, stdout: `deleted ${name}` }
    }
    if (action === 'rename' && name && argv[3]) {
      const bot = findBot(name)
      if (!bot) throw new Error(`profile 不存在：${name}`)
      botsStore.getState().upsert({ ...bot, name: argv[3] }, name)
      return { code: 0, stdout: `renamed ${name} -> ${argv[3]}` }
    }
    throw new Error(`cli.exec: profile ${action ?? ''} 未接线`)
  }
  // 宿主没有 hermes CLI（pi_run_command 是 slash command 执行器，语义不同）
  throw new Error(`cli.exec: 宿主未接线命令 ${argv.join(' ')}`)
}

// ── 分发 ────────────────────────────────────────────────────────────────────

/** 宿主 RPC 分发表。未知方法 → throw（规矩 12）。 */
export async function dispatchHostRequest<T>(
  method: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  // 诊断开关（localStorage `mirach.host-rpc.debug` = '1'）：插件 RPC 面
  // 没有开发者工具面板，排查"点了没反应"时靠它看调用序列。
  try {
    if (localStorage.getItem('mirach.host-rpc.debug') === '1') {
      console.info('[host-rpc]', method, params)
    }
  } catch {
    /* storage unavailable — debug aid only */
  }
  switch (method) {
    case 'profiles.list': {
      const rows = ensureBotsLoaded().map(botToRosterRow)
      return {
        profiles: rows,
        primaryConnectionId: 'local',
        sources: [{ connectionId: 'local', kind: 'local', label: '本机', reachable: true }],
        bot_mode_protocol: false,
      } as T
    }

    case 'profiles.create': {
      const name = String(params.name ?? '').trim()
      if (!name) throw new Error('profiles.create: name 不能为空')
      const existing = findBot(name)
      if (existing) return { profile: name, existed: true } as T
      const model =
        typeof params.provider === 'string' && typeof params.model === 'string' && params.provider && params.model
          ? `${params.provider}/${params.model}`
          : ''
      botsStore.getState().upsert({
        name,
        title: '',
        systemPrompt: typeof params.soul === 'string' ? params.soul : '',
        model,
        cwd: '',
        description: typeof params.description === 'string' ? params.description : '',
        createdAt: Date.now(),
      })
      return { profile: name } as T
    }

    case 'profiles.configure': {
      const name = String(params.name ?? '').trim()
      const bot = findBot(name)
      if (!bot) throw new Error(`profiles.configure: profile 不存在：${name}`)

      const uiMeta = params.ui_meta
      if (uiMeta && typeof uiMeta === 'object' && !Array.isArray(uiMeta)) {
        const leaf = (uiMeta as Record<string, unknown>)['hermes-bots']
        if (leaf && typeof leaf === 'object' && !Array.isArray(leaf)) {
          applyBotMeta(name, leaf as UnknownMeta)
        }
      }

      // 能力面（profile-config 的 disabled_skills / enabled_toolsets /
      // enabled_mcp_servers）：宿主只落**真生效**的字段。
      const next: BotPreset = { ...findBot(name)! }
      let changed = false
      if (Array.isArray(params.enabled_toolsets)) {
        next.toolsets = params.enabled_toolsets.map(String)
        changed = true
      }
      if (typeof params.soul === 'string') {
        next.systemPrompt = params.soul
        changed = true
      }
      if (typeof params.provider === 'string' && typeof params.model === 'string' && params.provider && params.model) {
        next.model = `${params.provider}/${params.model}`
        changed = true
      }
      if (Array.isArray(params.disabled_skills)) {
        const disabled = new Set(params.disabled_skills.map(String))
        const caps = await invoke<{ skills?: { name: string }[] }>('pi_capabilities')
        next.skills = (caps.skills ?? []).map((s) => s.name).filter((s) => !disabled.has(s))
        changed = true
      }
      if (Array.isArray(params.enabled_mcp_servers)) {
        patchMetaExtras(name, { 'host-enabled-mcp-servers': params.enabled_mcp_servers })
      }
      if (changed) botsStore.getState().upsert(next)

      return { applied: { ui_meta: true } } as T
    }

    case 'profiles.set_asset': {
      const name = String(params.name ?? '').trim()
      const bot = findBot(name)
      if (!bot) throw new Error(`profiles.set_asset: profile 不存在：${name}`)
      if (params.asset !== 'avatar') throw new Error(`profiles.set_asset: 未知 asset ${String(params.asset)}`)
      if (params.clear === true) {
        botsStore.getState().patchMeta(name, { image: null })
        return {} as T
      }
      const data = typeof params.data === 'string' ? params.data : ''
      if (!data.startsWith('data:')) throw new Error('profiles.set_asset: data 必须是 data URL')
      botsStore.getState().patchMeta(name, { image: data, custom: true })
      return {} as T
    }

    case 'profiles.get_asset': {
      const name = String(params.name ?? '').trim()
      const bot = findBot(name)
      if (!bot) throw new Error(`profiles.get_asset: profile 不存在：${name}`)
      return (bot.image ? { found: true, data: bot.image } : { found: false }) as T
    }

    case 'profiles.describe': {
      const name = String(params.name ?? '').trim()
      const bot = findBot(name)
      if (!bot) throw new Error(`profiles.describe: profile 不存在：${name}`)
      const caps = await invoke<{
        skills?: { description?: string; enabled?: boolean; name: string }[]
        toolsets?: { key: string; description?: string; enabled?: boolean; label?: string }[]
      }>('pi_capabilities')
      return {
        soul: bot.systemPrompt,
        model: (() => {
          const { provider, modelId } = splitModel(bot.model)
          return { provider: provider ?? '', default: modelId ?? '' }
        })(),
        skills: (caps.skills ?? []).map((s) => ({
          name: s.name,
          description: s.description ?? '',
          enabled: s.enabled !== false,
        })),
        toolsets: (caps.toolsets ?? []).map((t) => ({
          name: t.key,
          description: t.description ?? t.label ?? '',
          enabled: t.enabled !== false,
        })),
        mcp_servers: [],
      } as T
    }

    case 'session.list': {
      const profile = typeof params.profile === 'string' ? params.profile : ''
      const title = typeof params.title === 'string' ? params.title : null
      const limit = typeof params.limit === 'number' && params.limit > 0 ? params.limit : undefined
      const rows = await readSessions()
      // pi 的会话存储是**单命名空间**：所有 bot 的 "Bot Chat" 同名，按标题
      // 全局查会把 A 的永久会话交给 B（上游按 profile 目录天然隔离）。
      // 宿主的隔离锚 = bots-store 的双锚 chatSessionId：有锚只认锚，无锚
      // 返回空表（让上游 mint 自己的会话），绝不跨 bot 认领。
      const bot = profile ? findBot(profile) : null
      let scoped = rows
      if (bot) {
        const anchor = bot.chatSessionId ?? null
        scoped = anchor ? rows.filter((r) => r.id === anchor) : []
      }
      const filtered = title ? scoped.filter((r) => (r.name ?? '') === title) : scoped
      return {
        sessions: filtered.slice(0, limit ?? filtered.length).map(sessionToChatRow),
      } as T
    }

    case 'session.create': {
      const profile = typeof params.profile === 'string' ? params.profile : ''
      const bot = profile ? findBot(profile) : null
      const title =
        typeof params.title === 'string' && params.title.trim()
          ? params.title.trim()
          : (bot?.name ?? '新会话')
      const created = await createSessionForBot(bot, title)
      // hermes 的 bot 会话天生 hidden（Bot Mode 拥有）；宿主没有 hidden 面，
      // 显示层按 bots-store 的双锚路径集过滤。canonical Bot Chat 一创建就
      // 记双锚 → 侧栏会话列表立刻隐藏（花名册是唯一入口）。
      if (bot && title === 'Bot Chat') {
        const path = await findSessionPath(created.stored_session_id)
        if (path) {
          botsStore
            .getState()
            .patchMeta(bot.name, { chatSessionPath: path, chatSessionId: created.stored_session_id })
        } else {
          console.error(`[host-rpc] bot 会话 ${created.stored_session_id} 不在索引——双锚未记录`)
        }
      }
      return created as T
    }

    case 'session.info': {
      const sessionId = String(params.session_id ?? '')
      const row = await requireSession(sessionId)
      return {
        session_id: row.id,
        title: row.name ?? '',
        message_count: row.messageCount ?? undefined,
      } as T
    }

    case 'session.title': {
      const sessionId = String(params.session_id ?? '')
      const title = String(params.title ?? '')
      if (!sessionId || !title) throw new Error('session.title 缺少 session_id / title')
      await requireSession(sessionId)
      // pi 的 rename_session 只作用于**当前活动会话**（没有按 id 改名面）。
      // 上游 bots 的调用点（canonical-chat）总在 session.create 之后立刻
      // 改名——那时新会话就是活动的，所以这条约束在真实路径上成立。
      const st = await invoke<{ sessionId?: null | string }>('pi_get_state')
      if (st?.sessionId !== sessionId) {
        throw new Error(`session.title: 宿主只能重命名当前会话（目标是 ${sessionId}，当前是 ${st?.sessionId ?? '无'}）`)
      }
      await invoke('pi_rename_session', { name: title })
      return {} as T
    }

    case 'session.interrupt': {
      await invoke('pi_interrupt')
      return {} as T
    }

    case 'session.compress': {
      await invoke('pi_compact')
      return { compressed: true, status: 'done' } as T
    }

    case 'session.resume': {
      const sessionId = String(params.session_id ?? '')
      const row = await requireSession(sessionId)
      // pi_get_session_messages 按**文件 path** 读（非活动会话的静态面）；
      // 上游 session.resume 的 messages 形状是 [{role,text}] —— 这里只投影
      // 文本面（群聊的 tool/审批游行另议，缺失字段上游自然跳过）。
      const raw = await invoke<Record<string, unknown>[]>('pi_get_session_messages', {
        path: row.path,
      })
      const messages = (raw ?? [])
        .map((m) => {
          const role = typeof m.role === 'string' ? m.role : null
          if (!role) return null
          const text =
            typeof m.text === 'string'
              ? m.text
              : typeof m.content === 'string'
                ? m.content
                : Array.isArray(m.content)
                  ? (m.content as { text?: unknown; type?: string }[])
                      .filter((p) => p?.type === 'text' && typeof p.text === 'string')
                      .map((p) => p.text as string)
                      .join('')
                  : ''
          return text ? { role, text } : null
        })
        .filter((m): m is { role: string; text: string } => m !== null)
      return {
        session_id: row.id,
        running: false,
        message_count: messages.length,
        messages,
      } as T
    }

    case 'display.status': {
      // 宿主没有 Bot Desktop / display 后端（pi 引擎无 display.* 概念）。
      // 按上游契约给**已定型的不支持**答复：supported:false → 屏幕门户/
      // 例程头图走 unsupported 分支把自己藏起来；抛"未接线"只会让 portalTone
      // 停在 'unknown'——UI 永远显示"正在检查屏幕…"的假 spinner。
      return {
        supported: false,
        installed: false,
        running: false,
        profile_key: typeof params.profile === 'string' ? params.profile : null,
      } as T
    }

    case 'cron.manage':
      return (await cronManage(params)) as T

    case 'cli.exec':
      return (await cliExec(params)) as T

    default:
      if (method.startsWith('groups.')) {
        return (await invoke<T>('groups_dispatch', { method, params })) as T
      }
      throw new Error(`host.request: method '${method}' 在宿主未接线`)
  }
}

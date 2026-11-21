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
import { hiddenSessionsStore } from '@/components/panes/hub/hidden-sessions'
import {
  approveCanonicalAction,
  canonicalDriverStatus,
  discardCanonicalTask,
  kickCanonicalRoom,
  retryCanonicalTask,
  stopCanonicalRoom,
} from '@/components/panes/hub/canonical-group-driver'

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
  // canonical-chat 的 isMissingSessionError 只看 data.reason / message；
  // group-turns 的 isSessionAbsentError 还认 code 4007 / 4001——两个字段都给，
  // 让"会话确实不存在 → 允许新建"的判定在两套 wire 上都成立。
  ;(error as Error & { code?: number; data?: unknown }).data = { reason: 'not_found' }
  ;(error as Error & { code?: number }).code = 4007
  return error
}

async function requireSession(sessionId: string): Promise<PiSessionRow> {
  const rows = await readSessions()
  const row = rows.find((r) => r.id === sessionId)
  if (!row) throw missingSession(sessionId)
  return row
}

/** 按 id **或标题**找会话（上游 session.resume 的二者皆可语义：stored id
 *  优先，没命中时按 title 找——群聊成员会话在 room 里存的是 stored id，
 *  rehydrate 后丢了指针的旧房间按 `Group: <room> · <thread>` 标题找回）。 */
async function findSessionByAnyIdOrTitle(target: string): Promise<null | PiSessionRow> {
  const rows = await readSessions()
  const byId = rows.find((r) => r.id === target)
  if (byId) return byId
  const trimmed = target.trim()
  if (!trimmed) return null
  return rows.find((r) => (r.name ?? '') === trimmed) ?? null
}

// ── session.resume 的消息投影（上游 transcript 形状）───────────────────────

interface ResumeMessage {
  role: string
  text?: string
  content?: string
  display_kind?: string
}

/** pi 消息的文本面（string / 块数组的 text 块；toolResult/thinking 不进
 *  transcript——上游 resume 同样只投影角色 + 文本）。 */
function messageText(message: Record<string, unknown>): string {
  const content = message.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return (content as { text?: unknown; type?: string }[])
      .filter((p) => typeof p?.text === 'string' && (!p.type || p.type === 'text'))
      .map((p) => p.text as string)
      .join('')
  }
  return typeof message.text === 'string' ? message.text : ''
}

/**
 * pi 会话消息 → 上游 `session.resume` 的 transcript 行。
 *
 * 三条语义（都是群聊读取端实读的字段）：
 * - `[System:` 开头的 user 行是网关合成行，resume 直接丢弃（上游同款）；
 * - 无文本的行（纯工具/思考）不产出——上游 transcript 不含工具行；
 * - **失败轮**：`stopReason: error/aborted` 或带 `errorMessage` 的 assistant
 *   消息产出 `display_kind: 'failed_turn'` 边界行（正文 = 错误信息；此前
 *   的部分正文先按普通行产出）。这是房间引擎区分"成员回答"与"回合失败"
 *   的唯一标记（group-external-writes.ts:82）。
 */
function projectResumeMessages(raw: Record<string, unknown>[]): ResumeMessage[] {
  const out: ResumeMessage[] = []
  for (const message of raw ?? []) {
    const role = typeof message.role === 'string' ? message.role : null
    if (!role) continue
    const text = messageText(message).trim()
    const stopReason = typeof message.stopReason === 'string' ? message.stopReason : ''
    const errorMessage = typeof message.errorMessage === 'string' ? message.errorMessage : ''
    const failed = role === 'assistant' && (stopReason === 'error' || (stopReason === 'aborted' && !text) || errorMessage !== '')
    if (text) {
      if (!(role === 'user' && text.startsWith('[System:'))) {
        out.push({ role, text, content: text })
      }
    }
    if (failed) {
      if (stopReason === 'aborted' && !errorMessage) continue // 用户中断：无失败正文可报
      out.push({
        role,
        text: errorMessage || '本轮在模型给出回答前结束（无错误详情）',
        content: errorMessage || '本轮在模型给出回答前结束（无错误详情）',
        display_kind: 'failed_turn',
      })
    }
  }
  return out
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

// ── bot 泳道（后台成员会话）────────────────────────────────────────────────

/** bot 预设 → pi_bot_* 命令的重建参数（`follow_profile_config` 语义：会话
 *  每次重开都按成员预设的**当前**人格/模型/工具集装配）。 */
async function botLaneConfig(profile: string): Promise<Record<string, unknown>> {
  const bot = profile ? findBot(profile) : null
  if (!bot) return {}
  const systemPrompt = composeSystemPrompt(bot)
  const { provider, modelId } = splitModel(bot.model)
  const enabledTools = await enabledToolsFor(bot)
  return {
    ...(systemPrompt ? { systemPrompt } : {}),
    ...(provider && modelId ? { provider, modelId } : {}),
    ...(enabledTools ? { enabledTools } : {}),
    profile: bot.name,
  }
}

/** 按会话 id/标题定位并懒重开泳道会话（附件面的入口；prompt.submit 自带
 *  懒重开，不走这里）。 */
async function openBotLaneSession(sessionId: string, profile: string): Promise<PiSessionRow> {
  const row = await findSessionByAnyIdOrTitle(sessionId)
  if (!row) throw missingSession(sessionId)
  const config = await botLaneConfig(profile)
  await invoke('pi_bot_open', {
    sessionId: row.id,
    path: row.path,
    ...config,
  })
  return row
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
    if (action === 'describe' && name) {
      // hermes `profile describe <name> --text <desc>`：编辑机器人对话框的
      // 描述保存路径（此前未接线 → 改描述恒失败，2026-11-18 审计修）。
      const flag = argv.indexOf('--text')
      const description = flag >= 0 ? String(argv[flag + 1] ?? '') : ''
      const bot = findBot(name)
      if (!bot) throw new Error(`profile 不存在：${name}`)
      botsStore.getState().upsert({ ...bot, description }, name)
      return { code: 0, stdout: `described ${name}` }
    }
    throw new Error(`cli.exec: profile ${action ?? ''} 未接线`)
  }
  // profile-config 的"清除模型"：`['--profile', name, 'config', 'unset', 'model']`
  if (argv[0] === '--profile' && argv[2] === 'config' && argv[3] === 'unset' && argv[4] === 'model') {
    const name = argv[1]
    const bot = findBot(name)
    if (!bot) throw new Error(`profile 不存在：${name}`)
    botsStore.getState().upsert({ ...bot, model: '' }, name)
    return { code: 0, stdout: `unset model for ${name}` }
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
      if (!name) throw new Error('profiles.configure: name 不能为空')
      // 上游群聊的共享投影同步（group-chat.ts:1152-1247）把房间快照写进
      // profile `default` 的 ui_meta。宿主没有 gateway profile 表：这里
      // 接受并落 meta 余字段表（键 'default'），返回 applied 让同步循环
      // 不进入 8 次重试；读回面（profiles.list 的 default 行）不存在，
      // 快照按本地 localStorage 为真相（单实例等价）。
      if (name === 'default' && !findBot(name)) {
        const uiMeta = params.ui_meta
        if (uiMeta && typeof uiMeta === 'object' && !Array.isArray(uiMeta)) {
          patchMetaExtras(name, uiMeta as UnknownMeta)
        }
        return { applied: { ui_meta: true } } as T
      }
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
        // 如实标注：宿主没有 per-session MCP 面（pi 按 mcp.json 全局加载），
        // 这份名单是展示元数据 + describe 回显；勾选不改变引擎加载。
        console.warn(
          '[host-rpc] profiles.configure enabled_mcp_servers：宿主只保存展示名单（pi 的 MCP 由 mcp.json 全局加载，没有 per-bot 开关）',
        )
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
      // MCP 服务器清单：宿主真相 = pi_mcp（全局 + 项目 mcp.json）。
      // `enabled` 回显用户上次在编辑机器人里勾选的名单（meta 余字段）；
      // 名单缺省 = 全部启用。注意 pi 按 mcp.json 全局加载——勾选名单是
      // 展示元数据，不改变引擎加载（宿主没有 per-session MCP 面）。
      const mcpSnapshot = await invoke<{
        servers?: { command: null | string; envKeys?: string[]; name: string; url: null | string }[]
      }>('pi_mcp_servers', {
        cwd: bot.cwd || undefined,
        projectTrusted: false,
      })
      const rawEnabled = readMetaExtras()[name]?.['host-enabled-mcp-servers']
      const enabledSet = Array.isArray(rawEnabled)
        ? new Set(rawEnabled.map(String))
        : null
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
        mcp_servers: (mcpSnapshot?.servers ?? []).map((row) => ({
          name: row.name,
          enabled: enabledSet === null ? true : enabledSet.has(row.name),
          description: row.command ?? row.url ?? '',
          requires: row.envKeys ?? [],
        })),
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
      let anchor = bot?.chatSessionId ?? null
      // 锚交叉治疗（克隆历史数据可把两个 bot 锚到同一会话——实测
      // 风格和/微软共用 01a1e3ec）：同一 sessionId 被别的 bot 也锚定 =
      // 本 bot 锚已坏。持久清锚 + 本查询视为无锚（上游 mint 自己的
      // 会话）——否则插件花名册点谁都会打开同一个 "Bot Chat"
      // （"bot 没切换" 根因）。
      if (bot && anchor) {
        const cross = ensureBotsLoaded().find(
          (b) => b.name !== bot.name && b.chatSessionId === anchor,
        )
        if (cross) {
          console.error(
            `[host-rpc] 锚交叉：${bot.name} 与 ${cross.name} 共用 ${anchor.slice(0, 8)}——清锚，mint 新会话`,
          )
          botsStore.getState().patchMeta(bot.name, {
            chatSessionPath: null,
            chatSessionId: null,
          })
          anchor = null
        }
      }
      let scoped = rows
      if (bot) {
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
      // 群聊成员会话（`room_plumbing: true`）：跑在**后台 bot 泳道**，不抢
      // 前台活动会话；建好即登记进隐藏路径集（room 成员会话永不进侧栏）。
      if (params.room_plumbing === true) {
        const systemPrompt = bot ? composeSystemPrompt(bot) : ''
        const { provider, modelId } = splitModel(bot?.model ?? '')
        const enabledTools = bot ? await enabledToolsFor(bot) : null
        const created = await invoke<{ sessionId: string; path: string }>('pi_bot_create_session', {
          name: title,
          ...(systemPrompt ? { systemPrompt } : {}),
          ...(provider && modelId ? { provider, modelId } : {}),
          ...(bot?.cwd ? { cwd: bot.cwd } : {}),
          ...(enabledTools ? { enabledTools } : {}),
          ...(bot ? { profile: bot.name } : {}),
        })
        hiddenSessionsStore.getState().hide(created.path)
        return {
          session_id: created.sessionId,
          stored_session_id: created.sessionId,
        } as T
      }
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
      // 群聊 Stop 带 stored id（成员会话）→ 路由到后台泳道；无 id / 目标 =
      // 活动会话 → 前台 main lane。
      const target = typeof params.session_id === 'string' ? params.session_id : ''
      if (target) {
        const st = await invoke<{ sessionId?: null | string }>('pi_get_state')
        if (st?.sessionId !== target) {
          return (await invoke('pi_bot_interrupt', { sessionId: target })) as T
        }
      }
      await invoke('pi_interrupt')
      return {} as T
    }

    case 'session.compress': {
      // group-compress 对成员会话调 session.compress {session_id}——压缩目标
      // 是后台泳道会话，不是前台活动会话。
      const target = typeof params.session_id === 'string' ? params.session_id : ''
      if (target) {
        const st = await invoke<{ sessionId?: null | string }>('pi_get_state')
        if (st?.sessionId !== target) {
          return (await invoke('pi_bot_compact', { sessionId: target })) as T
        }
      }
      await invoke('pi_compact')
      return { compressed: true, status: 'done' } as T
    }

    case 'session.resume': {
      const target = String(params.session_id ?? '')
      if (!target) throw new Error('session.resume 缺少 session_id')
      // stored id 优先、标题兜底（上游语义；群聊 rehydrate 后按标题找回）。
      const row = await findSessionByAnyIdOrTitle(target)
      if (!row) throw missingSession(target)
      const omitMessages = params.omit_messages === true
      let messages: ResumeMessage[] = []
      if (!omitMessages) {
        const raw = await invoke<Record<string, unknown>[]>('pi_get_session_messages', {
          path: row.path,
        })
        messages = projectResumeMessages(raw)
      }
      // 后台泳道运行态（running / inflight / open_requests / pending_approval）
      // ——未注册的会话（应用重启后第一次 resume）返回诚实空态。
      const laneState = await invoke<Record<string, unknown>>('pi_bot_state', {
        sessionId: row.id,
      })
      // 启动时 recover 出的 indeterminate 任务（引擎 task_lease）：取一次即清。
      const recovered = await invoke<{ tasks?: unknown[] }>('pi_bot_take_recovered', {
        sessionId: row.id,
      }).catch((e) => {
        console.error('[host-rpc] pi_bot_take_recovered 失败', e)
        return { tasks: [] as unknown[] }
      })
      return {
        session_id: row.id,
        session_key: row.id,
        running: laneState?.running === true,
        inflight:
          laneState && laneState.inflight !== null && laneState.inflight !== undefined
            ? laneState.inflight
            : undefined,
        turn_started_at:
          typeof laneState?.turn_started_at === 'number' ? laneState.turn_started_at : null,
        message_count: omitMessages
          ? (typeof row.messageCount === 'number' ? row.messageCount : undefined)
          : messages.length,
        // omit_messages 时**不返回 messages 键**（上游同语义；群聊的
        // `Array.isArray(pre.messages) ? pre.messages.length : pre.message_count`
        // 基线判定依赖"缺键"走 message_count，空数组会被读成 0）。
        ...(omitMessages ? { messages_omitted: true } : { messages }),
        open_requests: Array.isArray(laneState?.open_requests) ? laneState.open_requests : [],
        pending_approval:
          laneState && laneState.pending_approval !== null && laneState.pending_approval !== undefined
            ? laneState.pending_approval
            : undefined,
        // 引擎任务租约面（canonical driver 的 fencing / 重试用）。
        task: laneState?.task ?? null,
        tasks: Array.isArray(laneState?.tasks) ? laneState.tasks : [],
        recovered_tasks: Array.isArray(recovered?.tasks) ? recovered.tasks : [],
      } as T
    }

    case 'prompt.submit': {
      // 群聊成员轮次（group-turns.ts）与 canvas 群聊的提交面：跑在后台
      // bot 泳道（不抢前台活动会话）。admission 语义——立即返回，
      // 完成靠轮询 session.resume / message.complete 事件。
      const target = String(params.session_id ?? '')
      const text = String(params.text ?? '')
      if (!target) throw new Error('prompt.submit 缺少 session_id')
      if (!text.trim()) throw new Error('prompt.submit 缺少 text')
      const row = await findSessionByAnyIdOrTitle(target)
      if (!row) throw missingSession(target)
      const profile = typeof params.profile === 'string' ? params.profile : ''
      const config = await botLaneConfig(profile)
      const result = await invoke<Record<string, unknown>>('pi_bot_prompt', {
        sessionId: row.id,
        text,
        // 引擎任务租约的元数据（canonical driver 存房间坐标，恢复时用）。
        taskMeta:
          params.task_meta !== null && typeof params.task_meta === 'object'
            ? params.task_meta
            : undefined,
        path: row.path,
        ...config,
      })
      return { ...result, session_id: row.id } as T
    }

    case 'task.interrupt': {
      // 引擎任务租约的带 fencing 中断（canonical driver 的 Stop/retry 用）。
      const sessionId = String(params.session_id ?? '')
      const taskId = String(params.task_id ?? '')
      const generation = Number(params.execution_generation ?? 0)
      if (!sessionId || !taskId || !Number.isSafeInteger(generation) || generation < 1) {
        throw new Error('task.interrupt 缺少 session_id / task_id / execution_generation')
      }
      return (await invoke('pi_bot_interrupt_task', {
        sessionId,
        taskId,
        executionGeneration: generation,
      })) as T
    }

    case 'approval.respond': {
      // 群聊审批回灌（answerGroupClarify 的 approval 分支）：session_id 是
      // resume 快照里那条 runtime id；宿主按会话定位后台泳道的审批对话框。
      const sessionId = typeof params.session_id === 'string' ? params.session_id : ''
      const requestId = String(params.request_id ?? '')
      const choice = typeof params.choice === 'string' && params.choice ? params.choice : 'deny'
      if (!requestId) throw new Error('approval.respond 缺少 request_id')
      if (!sessionId) {
        throw new Error('approval.respond 需要 session_id（宿主按会话定位挂起的审批）')
      }
      await invoke('pi_bot_approval_respond', { sessionId, requestId, choice })
      return { resolved: 1 } as T
    }

    case 'clarify.lock': {
      // 群聊 clarify 逐题应答（调用点不带 session_id）——按 request_id 在
      // 泳道注册表里找到持有它的会话。
      const requestId = String(params.request_id ?? '')
      const questionId = String(params.question_id ?? '')
      if (!requestId || !questionId) throw new Error('clarify.lock 缺少 request_id / question_id')
      return (await invoke('pi_bot_clarify_lock', {
        sessionId: typeof params.session_id === 'string' ? params.session_id : undefined,
        requestId,
        questionId,
        answer: typeof params.answer === 'string' ? params.answer : null,
      })) as T
    }

    case 'file.attach': {
      const target = String(params.session_id ?? '')
      const dataUrl = String(params.data_url ?? '')
      const name = typeof params.name === 'string' && params.name ? params.name : 'attachment'
      if (!target) throw new Error('file.attach 缺少 session_id')
      if (!dataUrl) throw new Error('file.attach 缺少 data_url')
      const profile = typeof params.profile === 'string' ? params.profile : ''
      const row = await openBotLaneSession(target, profile)
      return (await invoke('pi_bot_attach_file', {
        sessionId: row.id,
        dataUrl,
        name,
      })) as T
    }

    case 'image.attach_bytes': {
      const target = String(params.session_id ?? '')
      const content =
        typeof params.content_base64 === 'string'
          ? params.content_base64
          : typeof params.data === 'string'
            ? params.data
            : ''
      if (!target) throw new Error('image.attach_bytes 缺少 session_id')
      if (!content) throw new Error('image.attach_bytes 缺少 content_base64')
      const profile = typeof params.profile === 'string' ? params.profile : ''
      const row = await openBotLaneSession(target, profile)
      return (await invoke('pi_bot_attach_image', {
        sessionId: row.id,
        contentBase64: content,
        filename: typeof params.filename === 'string' ? params.filename : undefined,
      })) as T
    }

    case 'model.options': {
      // 编辑机器人 / 新建机器人的模型下拉（model-picker.tsx）：宿主模型
      // 目录（models.json + models.dev 回填）按 provider 分组。
      const res = await invoke<{
        models?: { id: string; name?: string; provider: string; contextWindow?: number }[]
      }>('pi_list_models')
      const byProvider = new Map<
        string,
        { slug: string; name: string; models: { id: string; name: string }[]; total_models: number }
      >()
      for (const model of res?.models ?? []) {
        if (!model?.provider || !model?.id) continue
        const entry = byProvider.get(model.provider) ?? {
          slug: model.provider,
          name: model.provider,
          models: [],
          total_models: 0,
        }
        entry.models.push({ id: model.id, name: model.name ?? model.id })
        entry.total_models = entry.models.length
        byProvider.set(model.provider, entry)
      }
      return { providers: [...byProvider.values()] } as T
    }

    case 'image.generate': {
      // hermes 的图像生成后端（avatars / 群聊图片）。宿主实现 = OpenAI 兼容
      // images 端点（provider/baseUrl/key 走 settings/models/auth；见
      // pi_image.rs）。probe 真查模型目录，缺图像模型 → available:false。
      const probe = params.probe === true
      const res = await invoke<{
        available?: boolean
        success?: boolean | null
        image?: string | null
        image_data?: string | null
        error?: string | null
        model?: string
        provider?: string
      }>('pi_image_generate', {
        probe,
        prompt: typeof params.prompt === 'string' ? params.prompt : undefined,
        aspectRatio: typeof params.aspect_ratio === 'string' ? params.aspect_ratio : undefined,
      })
      return res as T
    }

    case 'pet.gallery': {
      // petdex 公共 manifest 整册（installed 标记读 ~/.rpi/agent/pets）。
      return (await invoke<Record<string, unknown>>('pi_pet_gallery')) as T
    }

    case 'pet.thumb': {
      // 首帧缩略图（已装 spritesheet 或 petdex 主机 URL）→ data URI。
      return (await invoke<Record<string, unknown>>('pi_pet_thumb', {
        slug: typeof params.slug === 'string' ? params.slug : '',
        url: typeof params.url === 'string' ? params.url : undefined,
      })) as T
    }

    case 'display.install': {
      // 宿主不安装远程桌面服务；display.install.* 事件也不会有生产者。
      throw new Error('display.install: 宿主没有安装流程（本机屏幕镜像无需安装）')
    }

    case 'display.observe': {
      const profile = typeof params.profile === 'string' ? params.profile : ''
      return (await invoke('pi_display_observe', {
        profile: profile || undefined,
        viewerId: typeof params.viewer_id === 'string' ? params.viewer_id : undefined,
      })) as T
    }

    case 'display.thumbnail': {
      const profile = typeof params.profile === 'string' ? params.profile : ''
      return (await invoke('pi_display_thumbnail', { profile: profile || undefined })) as T
    }

    case 'display.start': {
      const profile = typeof params.profile === 'string' ? params.profile : ''
      return (await invoke('pi_display_start', { profile: profile || undefined })) as T
    }

    case 'display.lease.acquire': {
      // 租约 = 本机屏幕的"谁在控制"记账（只有持 hash 的 viewer 可释放）。
      const profile = typeof params.profile === 'string' ? params.profile : ''
      return (await invoke('pi_display_lease_acquire', {
        profile: profile || undefined,
        viewerId: String(params.viewer_id ?? ''),
      })) as T
    }

    case 'display.lease.release': {
      const profile = typeof params.profile === 'string' ? params.profile : ''
      return (await invoke('pi_display_lease_release', {
        profile: profile || undefined,
        viewerId: typeof params.viewer_id === 'string' ? params.viewer_id : undefined,
        force: params.force === true,
      })) as T
    }

    case 'display.switchSandboxImage': {
      // 宿主无沙箱镜像概念（本机桌面镜像，非按 profile 容器）——镜像切换卡
      // 由 status.image_switch 驱动，恒 null 所以永远不该出现；真被调用时
      // 返回当前状态（诚实空操作，而不是抛"未接线"）。
      const profile = typeof params.profile === 'string' ? params.profile : ''
      const status = await invoke<Record<string, unknown>>('pi_display_status', {
        profile: profile || undefined,
      })
      return { ...status, profile_key: profile || null } as T
    }

    case 'setup.runtime_check': {
      // create-dialog 的"建完即用"探针：`ok:false` → 红显"需要模型"。
      // 宿主真相 = 模型目录里有没有可用模型（pi_list_models 返回
      // `{models:[…]}`——不是裸数组，读错形状会把有模型误报成 no_model）。
      const profile = typeof params.profile === 'string' ? params.profile : ''
      try {
        const res = await invoke<{ models?: unknown[] }>('pi_list_models')
        const list = Array.isArray(res?.models) ? res.models : []
        if (list.length > 0) return { ok: true, profile } as T
        return { ok: false, profile, reason: 'no_model' } as T
      } catch (e) {
        return { ok: false, profile, reason: 'model_catalog_unavailable', detail: String(e) } as T
      }
    }

    case 'mcp.catalog': {
      // hermes `mcp.catalog` 的宿主对偶：内置目录 = `optional-mcps/` 里
      // rpi-mcp-adapter 可执行的子集（no-auth HTTP，2026-11-17 移植 10 条；
      // OAuth 条目引擎没有 token 管理，不入目录——见 pi_mcp_catalog.rs 头注）。
      // 已装服务器从 pi_mcp 真快照回读，installed 标记如实。
      const res = await invoke<{ entries?: unknown[] }>('pi_mcp_catalog')
      return { servers: res?.entries ?? [] } as T
    }

    case 'mcp.servers.list': {
      // mcp-setup 的 support 探针：返回宿主真实 MCP 快照（pi_mcp，
      // 全局 + 项目 mcp.json）。列表体不被 UI 读取，只为 ok:true。
      const profile = typeof params.profile === 'string' ? params.profile : ''
      const bot = profile ? findBot(profile) : null
      const snapshot = await invoke<{ servers?: unknown[] }>('pi_mcp_servers', {
        cwd: bot?.cwd || undefined,
        projectTrusted: false,
      })
      return { ok: true, result: { servers: snapshot?.servers ?? [] } } as T
    }

    case 'mcp.servers.add': {
      // 两种形态：
      // 1) `preset: '<catalog name>'`（hermes 目录一键装）——解析内置目录，
      //    往 `~/.rpi/agent/mcp.json` 写 `{url}`（pi_mcp_install_preset）；
      // 2) 显式 `config`（url/command/args/env）——直装（pi_mcp_upsert_server）。
      const name = String(params.name ?? '').trim()
      if (!name) throw new Error('mcp.servers.add 缺少 name')
      const preset = typeof params.preset === 'string' ? params.preset.trim() : ''
      const config = params.config
      if (!config || typeof config !== 'object' || Array.isArray(config)) {
        if (!preset) {
          throw new Error(
            `mcp.servers.add: 缺少 config（url/command/args/env），且没有可解析的目录预设「${name}」`,
          )
        }
        const installed = await invoke<{ installed?: boolean; url?: string }>('pi_mcp_install_preset', {
          name: preset === name ? name : preset,
        })
        return { ok: true, result: { added: true, name, url: installed?.url } } as T
      }
      const profile = typeof params.profile === 'string' ? params.profile : ''
      const bot = profile ? findBot(profile) : null
      await invoke('pi_mcp_upsert_server', {
        // Rust 侧 cwd 是必填 String（写路径固定全局，空串 = 无项目上下文）。
        cwd: bot?.cwd || '',
        name,
        spec: config,
      })
      return { ok: true, result: { added: true, name } } as T
    }

    case 'mcp.servers.remove': {
      // 从全局 mcp.json 删服务器（hermes 连接器/编辑器的移除路径）。
      const name = String(params.name ?? '').trim()
      if (!name) throw new Error('mcp.servers.remove 缺少 name')
      const removed = await invoke<boolean>('pi_mcp_remove_server', { cwd: '', name })
      return { ok: true, result: { removed, name } } as T
    }

    case 'mcp.servers.set_api_key': {      // 插件对目录条目写 env 密钥（hermes 写 .env；宿主写 mcp.json 的
      // `mcpServers.<name>.env`——rpi-mcp-adapter 启动 stdio 子进程时读取）。
      // 服务器必须已安装（不偷偷新建半截条目）；空值 = 清除该键。
      const name = String(params.name ?? '').trim()
      const envVar = String(params.env_var ?? params.envVar ?? '').trim()
      const value = typeof params.value === 'string' ? params.value : ''
      if (!name) throw new Error('mcp.servers.set_api_key 缺少 name')
      if (!envVar) throw new Error('mcp.servers.set_api_key 缺少 env_var')
      await invoke('pi_mcp_set_api_key', { cwd: '', name, envVar, value })
      return { ok: true, result: { name, env_var: envVar } } as T
    }

    case 'mcp.servers.test': {
      // HTTP 条目 = 真实 Streamable HTTP 探测（initialize → initialized →
      // tools/list，返回真工具表/serverInfo）；stdio 条目 = 配置校验 +
      // 如实 ok:false（宿主进程驱动不了引擎侧 adapter）。包成上游双层信封，
      // 让 mcp-setup 的错误行显示真实原因。
      const name = String(params.name ?? '')
      const profile = typeof params.profile === 'string' ? params.profile : ''
      const bot = profile ? findBot(profile) : null
      const result = await invoke<Record<string, unknown>>('pi_mcp_test_server', {
        cwd: bot?.cwd || '',
        name,
        projectTrusted: false,
      })
      return { ok: true, result } as T
    }

    case 'skills.manage': {
      // 宿主技能目录 = hermes `optional-skills/` 的本地复制（22 分类 139 技能，
      // 见 src-tauri/src/pi_skills_catalog.rs）。搜索真实命中；安装 = 整目录
      // 复制到 ~/.rpi/agent/skills/<name>（rpi 的技能发现目录）。
      const action = String(params.action ?? '')
      if (action === 'search') {
        const query = typeof params.query === 'string' ? params.query : ''
        const res = await invoke<{
          entries?: { name: string; description?: string; category?: string; installed?: boolean }[]
        }>('pi_skills_search', { query })
        return {
          results: (res?.entries ?? []).map((entry) => ({
            name: entry.name,
            description: entry.description ?? '',
          })),
        } as T
      }
      if (action === 'install') {
        // 插件把技能标识放在 `query`（skills-hub.tsx install()），兼容 name/identifier。
        const name = String(params.query ?? params.name ?? params.identifier ?? '').trim()
        if (!name) throw new Error('skills.manage install 缺少技能名')
        const res = await invoke<{ installed?: boolean; name?: string; path?: string }>('pi_skill_install', { name })
        return { ok: true, result: res } as T
      }
      if (action === 'remove' || action === 'uninstall') {
        const name = String(params.query ?? params.name ?? '').trim()
        if (!name) throw new Error('skills.manage remove 缺少技能名')
        return (await invoke('pi_skill_remove', { name })) as T
      }
      throw new Error(`skills.manage 未知 action：${action}`)
    }

    case 'bot_relay.roster.sync': {
      // 远端名册写盘（hermes `write_remote_roster`）：Desktop 的 roster 循环
      // 把"其它连接上的机器人并集"推给每个网关；本机厂房 = pi_relay 仓。
      // 空数组是合法输入（对端离去 → 写空表，别留旧行）。
      const agents = Array.isArray(params.agents) ? params.agents : []
      return (await invoke('pi_relay_roster_sync', { agents })) as T
    }

    case 'bot_relay.outbox.drain': {
      // 领走本机 outbox（含过期写 queued_expired、claimed 未回执重投）。
      return (await invoke('pi_relay_drain')) as T
    }

    case 'bot_relay.reply': {
      const id = String(params.id ?? '').trim()
      if (!id) throw new Error('bot_relay.reply 缺少 id')
      return (await invoke('pi_relay_reply', {
        id,
        reply: typeof params.reply === 'string' ? params.reply : undefined,
        error: typeof params.error === 'string' ? params.error : undefined,
        reason: typeof params.reason === 'string' ? params.reason : undefined,
      })) as T
    }

    case 'bot_relay.deliver': {
      // 目标在**本机**时的投递门（hermes gateway/session_bot.py::_deliver 的
      // 宿主对偶）：把 envelope 跑成目标 bot 的一轮，返回幂等终局回执。
      // 远端目标由 relay.ts 经 transport（pi_gateway_call）送到对端网关，
      // 不走这里。
      const id = String(params.id ?? '').trim()
      if (!id) throw new Error('bot_relay.deliver 缺少 id')
      const { deliverToLocalBot } = await import('@/lib/bot-delivery')
      return (await deliverToLocalBot(dispatchHostRequest, {
        id,
        profile: String(params.profile ?? ''),
        message: String(params.message ?? ''),
        from_profile: typeof params.from_profile === 'string' ? params.from_profile : undefined,
        from_handle: typeof params.from_handle === 'string' ? params.from_handle : undefined,
        from_connection: typeof params.from_connection === 'string' ? params.from_connection : undefined,
      })) as T
    }

    case 'display.status': {
      // 本机屏幕镜像（pi_display.rs）：supported 取决于平台截屏能力，
      // 几何/就绪状态全部真读。profile 从参数透传（status 里带该 profile
      // 的租约与 profile_key）。
      const status = await invoke<Record<string, unknown>>('pi_display_status', {
        profile: typeof params.profile === 'string' ? params.profile : undefined,
      })
      return {
        ...status,
        profile_key: typeof params.profile === 'string' ? params.profile : null,
      } as T
    }

    case 'groups.state': {
      // 宿主 canonical 驱动（canonical-group-driver.ts）的活跃轮次 → 上游
      // workspace 读的 driver_status（typing 行 / Round N / 停止按钮 /
      // stopConfirmed 判定）。
      const res = await invoke<Record<string, unknown>>('groups_dispatch', { method, params })
      const roomId = String(params.room_id ?? '')
      return { ...res, driver_status: canonicalDriverStatus(roomId) } as T
    }

    case 'groups.send': {
      const res = await invoke<Record<string, unknown>>('groups_dispatch', { method, params })
      const roomId = String(params.room_id ?? '')
      if (roomId) kickCanonicalRoom(roomId)
      return res as T
    }

    case 'groups.continue': {
      const res = await invoke<Record<string, unknown>>('groups_dispatch', { method, params })
      const roomId = String(params.room_id ?? '')
      if (roomId) kickCanonicalRoom(roomId)
      return res as T
    }

    case 'groups.stop': {
      const res = await invoke<Record<string, unknown>>('groups_dispatch', { method, params })
      const roomId = String(params.room_id ?? '')
      if (roomId) await stopCanonicalRoom(roomId)
      return res as T
    }

    case 'groups.approve': {
      // canonical 审批：lane forwarding —— once/deny 直接回给成员会话。
      const roomId = String(params.room_id ?? '')
      const requestId = String(params.request_id ?? '')
      const choice = String(params.choice ?? '')
      if (!roomId || !requestId || !choice) {
        throw new Error('groups.approve 缺少 room_id / request_id / choice')
      }
      await approveCanonicalAction(roomId, requestId, choice)
      return { ok: true } as T
    }

    case 'groups.retry': {
      const roomId = String(params.room_id ?? '')
      const memberId = String(params.member_id ?? '')
      const taskId = String(params.task_id ?? '')
      if (!roomId || !memberId || !taskId) {
        throw new Error('groups.retry 缺少 room_id / member_id / task_id')
      }
      retryCanonicalTask(roomId, memberId, taskId)
      return { ok: true } as T
    }

    case 'groups.discard': {
      const roomId = String(params.room_id ?? '')
      const memberId = String(params.member_id ?? '')
      const taskId = String(params.task_id ?? '')
      if (!roomId || !memberId || !taskId) {
        throw new Error('groups.discard 缺少 room_id / member_id / task_id')
      }
      await discardCanonicalTask(roomId, memberId, taskId)
      return { ok: true } as T
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

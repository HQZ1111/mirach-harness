/**
 * `@/hermes` shim — the data surface the mirrored Capabilities tree calls.
 *
 * Upstream this is a barrel over `api/*`: REST routes served by the hermes Python
 * backend. The host has no such backend — pi is an in-process Rust engine behind
 * Tauri IPC. So every function keeps **upstream's signature and return type**
 * (imported from the mirror's `types/hermes.ts`, the same contract the components
 * were written against) and fills it from pi:
 *
 * | upstream (hermes REST)             | host (pi IPC)                                  |
 * |------------------------------------|------------------------------------------------|
 * | getSkills / setSkillEnabled        | pi_capabilities / pi_set_skill_enabled         |
 * | getSkillContent                    | pi_read_skill                                  |
 * | getLearningNode / editLearningNode | pi_read_skill / pi_write_skill                 |
 * | deleteLearningNode                 | pi_delete_skill                                |
 * | getToolsets / setToolsetEnabled    | pi_capabilities / pi_set_toolset_enabled       |
 * | getHermesConfigRecord (mcp_servers)| pi_mcp_servers                                 |
 * | saveMcpServers                     | pi_mcp_upsert_server / pi_mcp_remove_server    |
 * | testMcpServer                      | pi_mcp_test_server                             |
 * | getUsageAnalytics                  | pi_usage_snapshot                              |
 * | getProfiles                        | the single local profile                       |
 * | getOfficialSkills / hub / catalog  | empty + a recorded reason                      |
 * | getLogs                            | pi's MCP config diagnostics, labelled as such  |
 *
 * Everything else (toolset provider matrices, terminal backends, computer-use
 * driver, TTS voices, OAuth dashboard flows) has **no pi counterpart**. Those
 * return upstream's own "nothing configured" shape and record why in
 * `hostUnsupportedFeatures()` — never a fabricated success.
 */

import { invokeOnce } from '@/lib/ipc'

// Upstream's own type contract: the mirrored components import these same names
// from `types/hermes`, so re-exporting keeps one source of truth and the shapes
// cannot drift from what the components read.
export type {
  ActionResponse,
  ActionStatusResponse,
  AnalyticsResponse,
  AnalyticsToolEntry,
  AutomationBlueprint,
  AutomationBlueprintField,
  ComputerUseCheck,
  ComputerUsePermissionSource,
  ComputerUseStatus,
  ConfigSchemaResponse,
  CronDeliveryTarget,
  CronJob,
  CronJobCreatePayload,
  CronJobSchedule,
  CronJobUpdates,
  ElevenLabsVoice,
  ElevenLabsVoicesResponse,
  EnvVarInfo,
  HermesConfigRecord,
  LogsResponse,
  McpCatalogEntry,
  McpCatalogResponse,
  McpServerSummary,
  McpServerTestResponse,
  OfficialSkillInfo,
  ProfileInfo,
  ProfilesResponse,
  SessionInfo,
  SkillHubInstalledEntry,
  SkillHubPreview,
  SkillHubResult,
  SkillHubScanFinding,
  SkillHubScanResult,
  SkillHubSearchResponse,
  SkillHubSource,
  SkillHubSourcesResponse,
  SkillInfo,
  TerminalBackendInfo,
  TerminalBackendStatus,
  TerminalBackendsResponse,
  ToolEnvVar,
  ToolProvider,
  ToolProviderStatus,
  ToolsetConfig,
  ToolsetInfo,
  ToolsetModel,
  ToolsetModelsResponse
} from '@/hermes-mirror/types/hermes'

/** Upstream api/skills.ts declares LearningNodeDetail inline (not part of the
 *  shared contract); the mirrored skills editor reads it via @/hermes. */
export interface LearningNodeDetail {
  content: string
  kind: 'memory' | 'skill'
  label: string
  ok: boolean
}

/** Upstream's model-options contract, from the mirrored shared package — the same
 *  type the components import from `@hermes/shared`, so the shapes cannot drift. */
import type { ModelOptionsResult } from '@/hermes-mirror/shared'

export type { ModelOptionsResult, ModelOptionProvider } from '@/hermes-mirror/shared'

/** 定时任务的 IPC 数据面（`@/api/cron` 的宿主实现）。
 *
 * 上游 `api/cron.ts` 是 REST 包装；宿主的 `hermes-shim/api/cron.ts` 换成
 * `pi_cron_*` IPC。镜像来的 `app/cron/*` 与侧栏区都从 `@/hermes` 取这些
 * 函数（上游 `hermes.ts:21` 的 `export * from './api/cron'` 同款），所以
 * 这里必须重新导出，否则镜像文件的 import 全部落空。 */
export {
  createCronJob,
  type CronRunRow,
  type CronTriggerResult,
  deleteCronJob,
  getAutomationBlueprints,
  getCronDeliveryTargets,
  getCronJob,
  getCronJobRuns,
  getCronJobs,
  getCronTickerState,
  instantiateAutomationBlueprint,
  pauseCronJob,
  resumeCronJob,
  triggerCronJob,
  updateCronJob,
} from '@/hermes-shim/api/cron'

/** 当前请求所属的连接（上游 `api/client.ts:765`）。宿主恒 `null`——
 *  只有一个本机引擎。镜像来的 `cron-actions.ts` 用它拼作用域键。 */
export { getApiRequestConnection } from '@/hermes-shim/api/client'

/** Upstream api/mcp.ts declares its own McpTestResult: the shared
 *  `McpServerTestResponse` plus the capability-count fields the MCP tab reads
 *  (absent on older backends). Declared here for the same reason as
 *  SelectToolsetProviderResponse — it is not part of the shared contract. */
export interface McpTestResult {
  error?: string
  ok: boolean
  prompts?: number
  resources?: number
  tools: { description: string; name: string; schema_chars?: number }[]
}

import type {
  ActionStatusResponse,
  AnalyticsResponse,
  ComputerUseStatus,
  EnvVarInfo,
  HermesConfigRecord,
  LogsResponse,
  McpCatalogResponse,
  McpServerTestResponse,
  OfficialSkillInfo,
  ProfileInfo,
  ProfilesResponse,
  SkillHubInstalledEntry,
  SkillHubPreview,
  SkillHubResult,
  SkillHubScanResult,
  SkillHubSearchResponse,
  SkillHubSource,
  SkillHubSourcesResponse,
  SkillInfo,
  TerminalBackendsResponse,
  ToolsetConfig,
  ToolsetInfo,
  ToolsetModelsResponse
} from '@/hermes-mirror/types/hermes'

// ── Profile scope ───────────────────────────────────────────────────────────
//
// Upstream profiles are named config islands inside one hermes install, and a
// scope may also pin a connection (another machine's gateway). pi has neither:
// one engine, one ~/.pi/agent directory. The type stays verbatim so mirrored
// call sites typecheck; `profileScopeKey` collapses everything to one cache slot.

export type ProfileScope = undefined | null | string | { connectionId?: null | string; profile?: null | string }

export function profileScopeKey(scope?: ProfileScope): string {
  if (scope && typeof scope === 'object') {
    const profile = (scope.profile ?? '').trim() || 'default'
    const connectionId = (scope.connectionId ?? '').trim()
    return connectionId ? `${connectionId}::${profile}` : profile
  }
  return (scope ?? '').trim() || 'default'
}

/** The gateway client type. Upstream `@/hermes` re-exports the real class from
 *  `api/client.ts` (`class HermesGateway extends JsonRpcGatewayClient`), and the
 *  mirrored consumers call `request()` / `on()` on it. The host has no socket, so
 *  the VALUE is always null — but the TYPE must be the real client, otherwise
 *  `gateway?.on(...)` narrows to `never` and the mirror's event handlers become
 *  unreachable code with an implicit-any payload (which is what tsc reported).
 *  Using the mirrored class keeps one source of truth. */
export type { JsonRpcGatewayClient as HermesGateway } from '@/hermes-mirror/shared/json-rpc-gateway'

/** Upstream `api/toolsets.ts` declares this response inline (it is not part of
 *  the shared type contract); aliased here for the same reason as McpTestResult. */
export interface SelectToolsetProviderResponse {
  /** Present when the selection was scoped to one web capability. */
  capability?: string
  /** The managed feature key (e.g. "browser") when needs_nous_auth is set. */
  feature?: string
  name: string
  /** Present (true) when a managed row was selected but the entitlement is
   *  missing — the row won't activate until the user signs in. */
  needs_nous_auth?: boolean
  ok: boolean
  provider: string
}

/** Why a call returned nothing — surfaced in the UI, never silent. */
export interface HostUnsupported {
  feature: string
  reason: string
}

const UNSUPPORTED: HostUnsupported[] = []

function unsupported(feature: string, reason: string): void {
  if (!UNSUPPORTED.some(entry => entry.feature === feature)) UNSUPPORTED.push({ feature, reason })
}

export function hostUnsupportedFeatures(): readonly HostUnsupported[] {
  return UNSUPPORTED
}

// ── IPC shapes (src-tauri/src/pi_capabilities.rs / pi_mcp.rs / pi_usage.rs) ─

interface PiSkillRow {
  category: string
  description: string
  enabled: boolean
  name: string
  source: string
}

interface PiToolsetRow {
  configured: boolean
  description: string
  enabled: boolean
  key: string
  label: string
  name: string
  tools: string[]
}

interface PiCapabilities {
  agentDir: string
  skills: PiSkillRow[]
  toolsets: PiToolsetRow[]
}

interface PiMcpServerRow {
  args: string[]
  command: null | string
  envKeys: string[]
  name: string
  transport: string
  url: null | string
}

interface PiMcpSnapshot {
  globalConfig: string
  projectConfig: string
  servers: PiMcpServerRow[]
  warnings: { entry: string; reason: string; sourceFile: string }[]
}

let capabilitiesCache: PiCapabilities | null = null

async function capabilities(): Promise<PiCapabilities> {
  const next = await invokeOnce<PiCapabilities>('pi_capabilities')
  capabilitiesCache = next
  return next
}

/** pi_mcp_servers needs the session workspace; the capabilities page has no
 *  session context of its own, so the shell wires its active workspace in. */
let workspaceCwd: () => null | string = () => null

export function setCapabilitiesWorkspaceCwd(read: () => null | string): void {
  workspaceCwd = read
}

async function mcpSnapshot(): Promise<PiMcpSnapshot> {
  return invokeOnce<PiMcpSnapshot>('pi_mcp_servers', { cwd: workspaceCwd(), projectTrusted: false })
}

/** pi's skill source is project / user / package:<name>; hermes' provenance is
 *  agent / bundled / hub / external. Lossy by nature — spelled out once. */
function provenanceOf(source: string): SkillInfo['provenance'] {
  if (source === 'project' || source === 'user') return 'agent'
  if (source.startsWith('package:')) return 'hub'
  return 'external'
}

// ── Skills ──────────────────────────────────────────────────────────────────

export async function getSkills(_profile?: ProfileScope): Promise<SkillInfo[]> {
  const caps = await capabilities()
  return caps.skills.map(skill => ({
    category: skill.category || 'general',
    description: skill.description,
    enabled: skill.enabled,
    name: skill.name,
    provenance: provenanceOf(skill.source)
  }))
}

export async function setSkillEnabled(
  name: string,
  enabled: boolean,
  _profile?: ProfileScope
): Promise<{ enabled: boolean; name: string; ok: boolean }> {
  await invokeOnce<null>('pi_set_skill_enabled', { enabled, name })
  capabilitiesCache = null
  return { enabled, name, ok: true }
}

export async function getSkillContent(
  name: string,
  _profile?: ProfileScope
): Promise<{ content: string; name: string; path: string }> {
  const skill = await invokeOnce<{ contents: string; name: string; path: string }>('pi_read_skill', { name })
  return { content: skill.contents, name: skill.name, path: skill.path }
}

/** The skill editor's read: pi's skills are files, so a "learning node" is the
 *  SKILL.md body. */
export async function getLearningNode(id: string, profile?: ProfileScope): Promise<LearningNodeDetail> {
  const file = await getSkillContent(id, profile)
  return { content: file.content, kind: 'skill', label: file.name, ok: true }
}

export async function editLearningNode(
  id: string,
  content: string,
  _profile?: ProfileScope
): Promise<{ message: string; ok: boolean }> {
  // The editor hands back the whole SKILL.md (frontmatter included); pi's writer
  // takes name + description + body and re-emits the frontmatter itself.
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(content)
  const head = frontmatter?.[1] ?? ''
  const body = frontmatter ? frontmatter[2] : content
  const description = /^description:\s*(.+)$/m.exec(head)?.[1]?.trim() ?? ''

  if (!description) {
    return { message: 'SKILL.md 的 frontmatter 缺少 description —— pi 的技能装载器要求它', ok: false }
  }

  await invokeOnce<null>('pi_write_skill', { body, description, name: id })
  capabilitiesCache = null
  return { message: 'saved', ok: true }
}

export async function deleteLearningNode(
  id: string,
  _profile?: ProfileScope
): Promise<{ message: string; ok: boolean }> {
  await invokeOnce<null>('pi_delete_skill', { name: id })
  capabilitiesCache = null
  return { message: 'deleted', ok: true }
}

/** The Skills tab's "available to install" rows come from hermes' bundled
 *  optional-skill catalog. pi ships no such catalog. */
export async function getOfficialSkills(_profile?: ProfileScope): Promise<{ skills: OfficialSkillInfo[] }> {
  unsupported(
    'skills.hub.official',
    'pi 没有内置可选技能目录（hermes 的 optional-skills 是它仓库自己的内容）——本栏为空'
  )
  return { skills: [] }
}

// ── Skills Hub (no hub on this host; the tab's banner copy says so) ─────────

export async function getSkillHubSources(_profile?: null | string): Promise<SkillHubSourcesResponse> {
  unsupported('skills.hub.sources', '本宿主没有 Skills Hub 数据源')
  return { featured: [], index_available: false, installed: {}, sources: [] }
}

export async function searchSkillsHub(
  _query: string,
  _source?: string,
  _limit?: number,
  _profile?: null | string
): Promise<SkillHubSearchResponse> {
  return { installed: {}, results: [], source_counts: {}, timed_out: [] }
}

export async function previewSkillHub(_identifier: string, _profile?: ProfileScope): Promise<SkillHubPreview> {
  throw new Error('本宿主没有 Skills Hub，无法预览技能')
}

export async function scanSkillHub(_identifier: string, _profile?: null | string): Promise<SkillHubScanResult> {
  throw new Error('本宿主没有 Skills Hub，无法扫描技能')
}

export async function installSkillFromHub(
  _identifier: string,
  _profile?: ProfileScope
): Promise<import('@/hermes-mirror/types/hermes').ActionResponse> {
  throw new Error('本宿主没有 Skills Hub，无法安装技能（pi 的技能是 ~/.pi/agent/skills 下的目录）')
}

export async function uninstallSkillFromHub(
  _name: string,
  _profile?: ProfileScope
): Promise<import('@/hermes-mirror/types/hermes').ActionResponse> {
  throw new Error('本宿主没有 Skills Hub，无法卸载（请直接删除技能目录，或用编辑器的归档）')
}

export async function updateSkillsFromHub(_profile?: ProfileScope): Promise<import('@/hermes-mirror/types/hermes').ActionResponse> {
  throw new Error('本宿主没有 Skills Hub，无可更新项')
}

// ── Toolsets ────────────────────────────────────────────────────────────────

export async function getToolsets(_profile?: ProfileScope): Promise<ToolsetInfo[]> {
  const caps = await capabilities()
  return caps.toolsets.map(row => ({
    configured: row.configured,
    description: row.description,
    enabled: row.enabled,
    label: row.label,
    name: row.name,
    tools: row.tools
  }))
}

export async function setToolsetEnabled(
  name: string,
  enabled: boolean,
  _profile?: ProfileScope
): Promise<{ enabled: boolean; name: string; ok: boolean }> {
  await invokeOnce<null>('pi_set_toolset_enabled', { enabled, key: name })
  capabilitiesCache = null
  return { enabled, name, ok: true }
}

/** hermes toolsets have a provider matrix (keys, backends, post-setup). pi's are
 *  pure tool groups, so the config panel renders the tool list instead — see the
 *  note in toolset-detail. */
export async function getToolsetConfig(name: string, _profile?: ProfileScope): Promise<ToolsetConfig> {
  return { active_provider: null, has_category: false, name, providers: [] }
}

export async function getToolsetModels(
  name: string,
  _provider?: string,
  _profile?: ProfileScope
): Promise<ToolsetModelsResponse> {
  return { current: null, default: null, has_models: false, models: [], name }
}

export async function selectToolsetModel(
  name: string,
  _model: string,
  _provider?: string,
  _profile?: ProfileScope
): Promise<{ model: string; name: string; ok: boolean }> {
  unsupported('toolsets.models', 'pi 的工具集没有模型绑定（模型选择在会话/设置页）')
  return { model: _model, name, ok: false }
}

export async function selectToolsetProvider(
  name: string,
  _provider: string,
  _capability?: 'extract' | 'search',
  _profile?: ProfileScope
): Promise<SelectToolsetProviderResponse> {
  unsupported('toolsets.providers', 'pi 的工具集没有 provider 矩阵')
  return { name, ok: false, provider: _provider }
}

export async function runToolsetPostSetup(
  name: string,
  key: string,
  _profile?: ProfileScope
): Promise<import('@/hermes-mirror/types/hermes').ActionResponse & { key: string }> {
  unsupported('toolsets.postSetup', 'pi 的工具集没有 post-setup 安装步骤')
  throw new Error('本宿主没有 post-setup 步骤')
}

export async function getTerminalBackends(_profile?: ProfileScope): Promise<TerminalBackendsResponse> {
  unsupported('toolsets.terminal', 'pi 在进程内执行命令，没有可切换的终端后端')
  return { active: '', backends: [] }
}

export async function selectTerminalBackend(
  backend: string,
  _profile?: ProfileScope
): Promise<{ backend: string; ok: boolean }> {
  unsupported('toolsets.terminal.select', 'pi 在进程内执行命令，没有可切换的终端后端')
  return { backend, ok: false }
}

export async function getComputerUseStatus(_profile?: ProfileScope): Promise<ComputerUseStatus> {
  unsupported('toolsets.computer', 'pi 的电脑控制工具走宿主审批，没有独立驱动的状态端点')
  return {
    accessibility: null,
    can_grant: false,
    checks: [],
    error: 'pi 的电脑控制工具没有独立驱动状态（走宿主审批）',
    installed: false,
    platform: typeof navigator === 'undefined' ? 'unknown' : navigator.platform,
    platform_supported: false,
    ready: false,
    screen_recording: null,
    screen_recording_capturable: null,
    source: null,
    version: null
  }
}

export async function grantComputerUsePermissions(): Promise<import('@/hermes-mirror/types/hermes').ActionResponse> {
  unsupported('toolsets.computer.grant', 'pi 的电脑控制工具走宿主审批，没有可授予的 OS 权限')
  throw new Error('本宿主没有可授予的 OS 权限')
}

export async function getElevenLabsVoices(_profile?: ProfileScope): Promise<import('@/hermes-mirror/types/hermes').ElevenLabsVoicesResponse> {
  unsupported('audio.voices', '本宿主没有接入 ElevenLabs 语音服务')
  return { available: false, voices: [] }
}

/** pi's catalog is a FLAT list (`pi_list_models` → `{models: [{provider, id, name, …}]}`,
 *  see src-tauri/src/pi_session.rs::list_models); hermes' is grouped by provider.
 *  Grouping here is a pure re-projection of the same rows — no invented provider,
 *  no invented model: a provider appears only because pi reported a model for it,
 *  and `models` holds exactly pi's ids in pi's order. */
interface PiModelRow {
  provider: string
  id: string
  name: string
}

/** 上游 `getGlobalModelOptions(opts, profile)` 的两个参数：
 *
 *  - `opts`：`{ explicitOnly?, refresh? }` —— 上游用它决定"只列已配置的
 *    provider"与"绕过缓存"。宿主 `pi_list_models` 只有一个清单（pi 的
 *    models.json 就是已配置集），所以两个开关都是 no-op；**但签名保留**，
 *    因为 `lib/model-options.ts` 的 `restModelOptions()` 按位置传参。
 *  - `profile`：宿主无 profile，忽略。 */
export async function getGlobalModelOptions(
  _opts?: { explicitOnly?: boolean; refresh?: boolean },
  _profile?: ProfileScope
): Promise<ModelOptionsResult> {
  const result = await invokeOnce<{ models: PiModelRow[] }>('pi_list_models')

  const byProvider = new Map<string, string[]>()
  for (const row of result.models) {
    const models = byProvider.get(row.provider)
    if (models) {
      models.push(row.id)
    } else {
      byProvider.set(row.provider, [row.id])
    }
  }

  return {
    providers: [...byProvider.entries()].map(([slug, models]) => ({
      slug,
      // Upstream shows a humanized provider name; pi has no display name for the
      // provider itself, so the slug is the honest label.
      name: slug,
      models,
      total_models: models.length
    }))
  }
}

// ── Config record (the MCP editor's read/write path) ────────────────────────

/** Read origin of a config record so a save can be routed back to where the read
 *  came from. One backend means one origin, but the WeakMap stays because
 *  upstream's structural-sharing merge relies on the identity round-trip. */
const configOrigins = new WeakMap<object, ProfileScope>()

export function retainConfigReadOrigin<T extends object>(next: T, from: unknown): T {
  if (from && typeof from === 'object') {
    const origin = configOrigins.get(from as object)
    if (origin !== undefined) configOrigins.set(next, origin)
  }
  return next
}

export function peekConfigReadOrigin(record: unknown): ProfileScope | undefined {
  return record && typeof record === 'object' ? configOrigins.get(record as object) : undefined
}

function toMcpServersMap(snapshot: PiMcpSnapshot): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {}
  for (const server of snapshot.servers) {
    const entry: Record<string, unknown> = { transport: server.transport }
    if (server.command !== null) entry.command = server.command
    if (server.args.length > 0) entry.args = server.args
    if (server.url !== null) entry.url = server.url
    // Only key names are known: values are $ENV: references pi resolves.
    if (server.envKeys.length > 0) entry.env_keys = server.envKeys
    out[server.name] = entry
  }
  return out
}

/** The host's own language preference (src/lib/ui-prefs.ts, key `mirach:locale`),
 *  expressed as hermes' `display.language` value. pi has no language setting —
 *  the UI language is a host preference — so this is where the mirrored
 *  `I18nProvider` must read it from: upstream's contract is "config record's
 *  display.language wins, else the OS locale, else English", and an empty record
 *  made every mirrored page render English on a Chinese install. */
function hostDisplayLanguage(): string | undefined {
  try {
    const raw = localStorage.getItem('mirach:locale')
    if (raw === 'zh-CN') return 'zh'
    if (raw === 'en') return 'en'
    return undefined
  } catch (error) {
    // A failed preference read must not silently become "English": say so, and
    // let upstream fall through to its OS-locale probe.
    console.error('[hermes-shim] 读取 mirach:locale 失败', error)
    return undefined
  }
}

export async function getHermesConfigRecord(
  profile?: ProfileScope,
  _options?: { includeDefaults?: boolean }
): Promise<HermesConfigRecord> {
  const snapshot = await mcpSnapshot()
  const language = hostDisplayLanguage()
  const record: HermesConfigRecord = {
    mcp_global_config: snapshot.globalConfig,
    mcp_project_config: snapshot.projectConfig,
    mcp_servers: toMcpServersMap(snapshot),
    mcp_warnings: snapshot.warnings,
    ...(language === undefined ? {} : { display: { language } })
  }
  configOrigins.set(record, profile)
  return record
}

/** Replace the whole mcp_servers map. pi's writer is per-server, so the edit is
 *  applied as a diff: upsert what changed, remove what vanished. */
export async function saveMcpServers(
  servers: Record<string, Record<string, unknown>>,
  _profile?: ProfileScope
): Promise<{ ok: boolean }> {
  const cwd = workspaceCwd()
  if (!cwd) {
    throw new Error('没有活动工作区：MCP 服务器只能写进某个项目的 .pi/mcp.json')
  }

  const current = toMcpServersMap(await mcpSnapshot())
  const removed = Object.keys(current).filter(name => !(name in servers))

  for (const name of removed) {
    await invokeOnce<boolean>('pi_mcp_remove_server', { cwd, name })
  }

  for (const [name, spec] of Object.entries(servers)) {
    // pi reads `transport`; hermes' editor may carry `type` instead.
    const { env_keys, type, ...rest } = spec as Record<string, unknown>
    const normalized: Record<string, unknown> = { ...rest }
    if (type !== undefined && normalized.transport === undefined) normalized.transport = type
    if (env_keys !== undefined) normalized.env = env_keys
    await invokeOnce<null>('pi_mcp_upsert_server', { cwd, name, spec: normalized })
  }

  return { ok: true }
}

export async function saveHermesConfigRecord(
  record: HermesConfigRecord,
  profile?: ProfileScope
): Promise<{ ok: boolean }> {
  const servers = record.mcp_servers
  if (servers && typeof servers === 'object' && !Array.isArray(servers)) {
    return saveMcpServers(servers as Record<string, Record<string, unknown>>, profile)
  }
  return { ok: true }
}

/** Upstream deep-merges a patch. The capabilities page writes `mcp_servers`; the
 *  language picker writes `display.language`. Both are honoured — the language
 *  goes to the host preference (`mirach:locale`, the same key src/lib/ui-prefs.ts
 *  reads), because pi has no config.yaml to write it into. */
export async function saveHermesConfig(
  patch: HermesConfigRecord,
  profile?: ProfileScope,
  _options?: { preserveLanguage?: boolean }
): Promise<{ ok: boolean }> {
  const display = patch.display
  if (display && typeof display === 'object' && !Array.isArray(display)) {
    const language = (display as Record<string, unknown>).language
    if (language === 'zh' || language === 'zh-hant') {
      localStorage.setItem('mirach:locale', 'zh-CN')
    } else if (typeof language === 'string' && language.length > 0) {
      // The host ships two UI languages (AGENTS.md: en + zh only). Storing a
      // third would make the picker claim a language the UI cannot render, so
      // it is refused loudly rather than silently downgraded.
      if (language !== 'en') {
        throw new Error(`本宿主界面只有中文与 English 两种语言，不支持「${language}」`)
      }
      localStorage.setItem('mirach:locale', 'en')
    }
  }

  return saveHermesConfigRecord(patch, profile)
}

export async function getHermesConfigSchema(_profile?: ProfileScope): Promise<import('@/hermes-mirror/types/hermes').ConfigSchemaResponse> {
  unsupported('config.schema', 'pi 的配置项由 Rust 侧强类型定义，没有可枚举的 schema 端点')
  return { fields: {} }
}

// ── MCP ─────────────────────────────────────────────────────────────────────

export async function testMcpServer(name: string, _profile?: ProfileScope): Promise<McpServerTestResponse> {
  const cwd = workspaceCwd()
  if (!cwd) {
    return { error: '没有活动工作区：项目级 MCP 服务器需要 cwd 才能测试', ok: false, tools: [] }
  }
  const result = await invokeOnce<{ error?: string; ok: boolean; tools: { description: string; name: string }[] }>(
    'pi_mcp_test_server',
    { cwd, name, projectTrusted: false }
  )
  // pass the backend's explanation through: `ok:false` without `error` would
  // silently hide why the probe could not connect.
  return {
    ...(result.error === undefined ? {} : { error: result.error }),
    ok: result.ok,
    tools: result.tools
  }
}

export async function getMcpCatalog(_profile?: ProfileScope): Promise<McpCatalogResponse> {
  unsupported(
    'mcp.catalog',
    'pi 没有 MCP 服务器目录（hermes 的 catalog 是它自带清单）——连接器页只列本机已配置的服务器'
  )
  return { diagnostics: [], entries: [] }
}

export async function installMcpCatalogEntry(
  name: string,
  _env: Record<string, string> = {},
  _profile?: ProfileScope
): Promise<{ action?: string; background?: boolean; name?: string; ok: boolean; pid?: number }> {
  unsupported('mcp.catalog.install', 'pi 没有 MCP 目录可安装；请在「添加服务器」里直接填写命令或 URL')
  throw new Error(`无法安装 ${name}：本宿主没有 MCP 服务器目录`)
}

export async function getActionStatus(
  name: string,
  _wait?: number,
  _profile?: ProfileScope
): Promise<ActionStatusResponse> {
  unsupported('actions.status', 'pi 的后台动作通过 jobs 工具上报，没有 REST 动作状态端点')
  return { exit_code: null, lines: [], name, pid: null, running: false }
}

// ── Logs ────────────────────────────────────────────────────────────────────

/** hermes tails ~/.hermes/logs/{mcp,agent}.log. pi writes no log file the page
 *  can tail, so this returns the MCP config warnings pi does report — labelled,
 *  not dressed up as a log. */
export async function getLogs(request: { file?: string; lines?: number; search?: string }): Promise<LogsResponse> {
  const file = request.file ?? 'mcp'
  const snapshot = await mcpSnapshot()
  const lines = snapshot.warnings.map(w => `[${w.sourceFile}] ${w.entry}: ${w.reason}`)
  unsupported('logs', 'pi 不写日志文件；这里列出的是 MCP 配置诊断（pi 唯一会报的运行时问题）')
  return { file, lines: lines.slice(-(request.lines ?? 200)) }
}

// ── Profiles ────────────────────────────────────────────────────────────────

/** pi has one global agent dir and no named profiles. Returning the single real
 *  one keeps the scope selector meaningful (it hides itself at <=1 option)
 *  instead of pretending a second profile exists. The fields pi cannot answer
 *  (`model`/`provider` are per-session in pi, not per-profile) come back null —
 *  that is absence, not a zero. */
export async function getProfiles(): Promise<ProfilesResponse> {
  const caps = await capabilities()
  const name = caps.agentDir.split(/[\\/]/).filter(Boolean).pop() ?? 'default'
  const profile: ProfileInfo = {
    has_env: false,
    is_default: true,
    model: null,
    name,
    path: caps.agentDir,
    provider: null,
    skill_count: caps.skills.length
  }
  return { profiles: [profile] }
}

// ── Usage analytics ─────────────────────────────────────────────────────────

function rangeToDays(range: string): number {
  const match = /^(\d+)d$/.exec(range)
  return match ? Number(match[1]) : 0
}

/** Maps pi's usage snapshot onto hermes' analytics shape. Fields pi does not
 *  record (per-skill activity, reasoning tokens, api-call counts) come back
 *  empty — never zeroed to look like "no activity". */
export async function getUsageAnalytics(days: number, _profile?: ProfileScope): Promise<AnalyticsResponse> {
  const range = days > 0 ? `${days}d` : 'all'
  const snapshot = await invokeOnce<{
    costUsd: number
    daily: { date: string; totalTokens: number; turnCount: number }[]
    models: { inputTokens: number; modelId: string; outputTokens: number; requestCount: number; totalTokens: number }[]
    summary: {
      cacheCreationTokens: number
      cacheReadTokens: number
      inputTokens: number
      outputTokens: number
      totalSessions: number
      totalTurns: number
      toolCallCount: number
    }
  }>('pi_usage_snapshot', { range })

  unsupported('analytics.skills', 'pi 不记录按技能的使用次数（stats 只聚合 token / 消息 / 工具调用）')

  return {
    by_model: snapshot.models.map(row => ({
      api_calls: row.requestCount,
      estimated_cost: 0,
      input_tokens: row.inputTokens,
      model: row.modelId,
      output_tokens: row.outputTokens,
      sessions: row.requestCount
    })),
    daily: snapshot.daily.map(row => ({
      actual_cost: 0,
      api_calls: row.turnCount,
      cache_read_tokens: 0,
      day: row.date,
      estimated_cost: 0,
      input_tokens: 0,
      output_tokens: 0,
      reasoning_tokens: 0,
      sessions: row.turnCount
    })),
    period_days: rangeToDays(range),
    skills: {
      summary: { distinct_skills_used: 0, total_skill_actions: 0, total_skill_edits: 0, total_skill_loads: 0 },
      top_skills: []
    },
    totals: {
      total_actual_cost: snapshot.costUsd,
      total_api_calls: null,
      total_cache_read: snapshot.summary.cacheReadTokens,
      total_estimated_cost: snapshot.costUsd,
      total_input: snapshot.summary.inputTokens,
      total_output: snapshot.summary.outputTokens,
      total_reasoning: null,
      total_sessions: snapshot.summary.totalSessions
    }
  }
}

// ── Env vars (toolset provider credentials) ─────────────────────────────────

/** hermes stores toolset provider credentials as env vars. pi's credentials live
 *  in auth.json / the OS keyring (see pi_keys.rs), keyed by provider — not env
 *  vars, so this list is empty rather than invented. */
export async function getEnvVars(_profile?: ProfileScope): Promise<{ env: EnvVarInfo[] }> {
  unsupported('env.vars', 'pi 的凭据存 auth.json / OS 钥匙串（设置页的提供方凭据），不是环境变量')
  return { env: [] }
}

export async function setEnvVar(_key: string, _value: string, _profile?: ProfileScope): Promise<{ ok: boolean }> {
  unsupported('env.set', 'pi 的凭据存 auth.json / OS 钥匙串（设置页的提供方凭据），不是环境变量')
  return { ok: false }
}

export async function deleteEnvVar(_key: string, _profile?: ProfileScope): Promise<{ ok: boolean }> {
  unsupported('env.delete', 'pi 的凭据存 auth.json / OS 钥匙串（设置页的提供方凭据），不是环境变量')
  return { ok: false }
}

export async function revealEnvVar(_key: string, _profile?: ProfileScope): Promise<{ value: null | string }> {
  unsupported('env.reveal', 'pi 的凭据存 auth.json / OS 钥匙串（设置页的提供方凭据），不是环境变量')
  return { value: null }
}

// ── OAuth (provider sign-in) ────────────────────────────────────────────────

/** pi HAS provider OAuth (pi_login.rs), but its shape is start/status polling by
 *  provider name — not the dashboard session flow hermes uses. The capabilities
 *  tree's OAuth entry points go through the toolset provider matrix, which does
 *  not exist here, so these fail loudly rather than pretending to sign in. */
export async function startOAuthLogin(
  _provider: string,
  _profile?: ProfileScope
): Promise<import('@/hermes-mirror/types/hermes').OAuthStartResponse> {
  unsupported('oauth.login', 'pi 的提供方 OAuth 走设置页「提供方凭据」，不是工具集面板')
  throw new Error('提供方登录请到设置页「提供方凭据」完成（pi_login）')
}

export async function pollOAuthSession(
  providerId: string,
  sessionId: string,
  _profile?: ProfileScope,
  _waitSeconds = 0
): Promise<import('@/hermes-mirror/types/hermes').OAuthPollResponse> {
  unsupported(
    'oauth.poll',
    `pi 的提供方 OAuth 走设置页「提供方凭据」（pi_login），没有 hermes 的 ${providerId} 会话轮询端点`
  )
  throw new Error(`提供方登录请到设置页「提供方凭据」完成（pi_login）；没有 ${sessionId} 这样的会话轮询`)
}

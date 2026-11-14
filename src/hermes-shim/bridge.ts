/**
 * The host bridge — the one place that answers `window.hermesDesktop.api(...)`.
 *
 * Upstream the Electron main proxies that call to the hermes backend over HTTP,
 * so the renderer never learns where data comes from. Here the only backend is
 * pi, reached through Tauri IPC. Rather than rewrite every api/*.ts helper, this
 * routes the paths they actually request:
 *
 *   /api/skills*            → pi_capabilities / pi_read_skill / pi_set_skill_enabled
 *   /api/learning/node      → pi_read_skill / pi_write_skill / pi_delete_skill
 *   /api/tools/toolsets*    → pi_capabilities / pi_set_toolset_enabled
 *   /api/mcp/*              → pi_mcp_servers / upsert / remove / test
 *   /api/profiles           → the single local profile
 *   /api/analytics/usage    → pi_usage_snapshot
 *
 * A path with no pi counterpart REJECTS with the reason (rule 12): the mirrored
 * UI has real error states for a failed read, and an empty-but-successful
 * response would read as "no skills installed" instead of "this backend does not
 * implement it".
 *
 * Also installed: the bridge members the mirrored tree calls through optional
 * chaining. Anything the host cannot do stays absent — call sites treat absence
 * as "not available", which is true here.
 */

import { invoke } from '@tauri-apps/api/core'

import { invokeOnce } from '@/lib/ipc'

import { installBridge } from './routes'

// ── Route table ─────────────────────────────────────────────────────────────

interface RouteContext {
  body: unknown
  method: string
  query: URLSearchParams
}

type RouteHandler = (ctx: RouteContext) => Promise<unknown>

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

/** pi's skill source → hermes' provenance (see hermes.ts for the rationale). */
function provenanceOf(source: string): 'agent' | 'bundled' | 'external' | 'hub' {
  if (source === 'project' || source === 'user') return 'agent'
  if (source.startsWith('package:')) return 'hub'
  return 'external'
}

const ROUTES: { pattern: RegExp; handle: RouteHandler }[] = [
  {
    pattern: /^\/api\/skills$/,
    handle: async () => {
      const caps = await invokeOnce<{ skills: PiSkillRow[] }>('pi_capabilities')
      return caps.skills.map(skill => ({
        category: skill.category || 'general',
        description: skill.description,
        enabled: skill.enabled,
        name: skill.name,
        provenance: provenanceOf(skill.source)
      }))
    }
  },
  {
    pattern: /^\/api\/skills\/content$/,
    handle: async ctx => {
      const name = required(ctx.query, 'name')
      const skill = await invokeOnce<{ contents: string; name: string; path: string }>('pi_read_skill', { name })
      return { content: skill.contents, name: skill.name, path: skill.path }
    }
  },
  {
    pattern: /^\/api\/skills\/toggle$/,
    handle: async ctx => {
      const body = ctx.body as { enabled?: boolean; name?: string }
      const name = String(body.name ?? '')
      if (!name) throw new Error('技能名为空')
      await invokeOnce<null>('pi_set_skill_enabled', { enabled: Boolean(body.enabled), name })
      return { enabled: Boolean(body.enabled), name, ok: true }
    }
  },
  {
    pattern: /^\/api\/learning\/node$/,
    handle: async ctx => {
      if (ctx.method === 'DELETE') {
        const body = ctx.body as { id?: string }
        await invokeOnce<null>('pi_delete_skill', { name: String(body.id ?? '') })
        return { message: 'deleted', ok: true }
      }
      if (ctx.method === 'PUT') {
        const body = ctx.body as { content?: string; id?: string }
        const content = String(body.content ?? '')
        const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(content)
        const description = frontmatter ? (/^description:\s*(.+)$/m.exec(frontmatter[1])?.[1] ?? '').trim() : ''
        if (!description) {
          return { message: 'SKILL.md 的 frontmatter 缺少 description —— pi 的技能装载器要求它', ok: false }
        }
        await invokeOnce<null>('pi_write_skill', {
          body: frontmatter ? frontmatter[2] : content,
          description,
          name: String(body.id ?? '')
        })
        return { message: 'saved', ok: true }
      }
      const id = required(ctx.query, 'id')
      const skill = await invokeOnce<{ contents: string; name: string }>('pi_read_skill', { name: id })
      return { content: skill.contents, kind: 'skill', label: skill.name, ok: true }
    }
  },
  {
    pattern: /^\/api\/tools\/toolsets$/,
    handle: async () => {
      const caps = await invokeOnce<{ toolsets: PiToolsetRow[] }>('pi_capabilities')
      return caps.toolsets.map(row => ({
        configured: row.configured,
        description: row.description,
        enabled: row.enabled,
        label: row.label,
        name: row.name,
        tools: row.tools
      }))
    }
  },
  {
    // `/api/tools/toolsets/<name>` PUT = the enable toggle.
    pattern: /^\/api\/tools\/toolsets\/([^/]+)$/,
    handle: async ctx => {
      const name = decodeURIComponent(ctx.query.get('__name') ?? '')
      const body = ctx.body as { enabled?: boolean }
      await invokeOnce<null>('pi_set_toolset_enabled', { enabled: Boolean(body.enabled), key: name })
      return { enabled: Boolean(body.enabled), name, ok: true }
    }
  },
  {
    pattern: /^\/api\/mcp\/servers$/,
    handle: async ctx => {
      const workspace = workspaceCwd()
      if (ctx.method === 'PUT') {
        if (!workspace) throw new Error('没有活动工作区：MCP 服务器只能写进某个项目的 .pi/mcp.json')
        const body = ctx.body as { servers?: Record<string, Record<string, unknown>> }
        const servers = body.servers ?? {}
        const snapshot = await invokeOnce<Record<string, unknown>>('pi_mcp_servers', {
          cwd: workspace,
          projectTrusted: false
        })
        const current = serversFromSnapshot(snapshot)
        for (const name of Object.keys(current)) {
          if (!(name in servers)) await invokeOnce<boolean>('pi_mcp_remove_server', { cwd: workspace, name })
        }
        for (const [name, spec] of Object.entries(servers)) {
          const { env_keys, type, ...rest } = spec as Record<string, unknown>
          const normalized: Record<string, unknown> = { ...rest }
          if (type !== undefined && normalized.transport === undefined) normalized.transport = type
          if (env_keys !== undefined) normalized.env = env_keys
          await invokeOnce<null>('pi_mcp_upsert_server', { cwd: workspace, name, spec: normalized })
        }
        return { ok: true }
      }
      const snapshot = await invokeOnce<Record<string, unknown>>('pi_mcp_servers', {
        cwd: workspace,
        projectTrusted: false
      })
      return { servers: snapshot.servers }
    }
  },
  {
    pattern: /^\/api\/mcp\/servers\/([^/]+)\/test$/,
    handle: async ctx => {
      const name = decodeURIComponent(ctx.query.get('__name') ?? '')
      const workspace = workspaceCwd()
      if (!workspace) return { error: '没有活动工作区：项目级 MCP 服务器需要 cwd 才能测试', ok: false, tools: [] }
      const result = await invokeOnce<{ ok: boolean; tools: { description: string; name: string }[] }>(
        'pi_mcp_test_server',
        { cwd: workspace, name, projectTrusted: false }
      )
      return { ok: result.ok, tools: result.tools }
    }
  },
  {
    pattern: /^\/api\/mcp\/servers\/([^/]+)\/enabled$/,
    handle: async ctx => {
      const name = decodeURIComponent(ctx.query.get('__name') ?? '')
      const workspace = workspaceCwd()
      if (!workspace) throw new Error('没有活动工作区：项目级 MCP 配置需要 cwd')
      const body = ctx.body as { enabled?: boolean }
      const snapshot = await invokeOnce<Record<string, unknown>>('pi_mcp_servers', {
        cwd: workspace,
        projectTrusted: false
      })
      const entry = serversFromSnapshot(snapshot)[name]
      if (!entry) throw new Error(`找不到 MCP 服务器：${name}`)
      const next = { ...entry }
      if (body.enabled) delete next.enabled
      else next.enabled = false
      await invokeOnce<null>('pi_mcp_upsert_server', { cwd: workspace, name, spec: next })
      return { ok: true }
    }
  },
  {
    pattern: /^\/api\/analytics\/usage$/,
    handle: async ctx => {
      const days = Number(ctx.query.get('days') ?? '30')
      return invokeOnce<Record<string, unknown>>('pi_usage_snapshot', { range: days > 0 ? `${days}d` : 'all' })
    }
  },
  {
    pattern: /^\/api\/profiles$/,
    handle: async () => {
      const caps = await invokeOnce<{ agentDir: string }>('pi_capabilities')
      const name = caps.agentDir.split(/[\\/]/).filter(Boolean).pop() ?? 'default'
      return { profiles: [{ is_default: true, name }] }
    }
  },
  {
    pattern: /^\/api\/profiles\/active$/,
    handle: async () => {
      const caps = await invokeOnce<{ agentDir: string }>('pi_capabilities')
      return { profile: caps.agentDir.split(/[\\/]/).filter(Boolean).pop() ?? 'default' }
    }
  }
]

function required(query: URLSearchParams, key: string): string {
  const value = query.get(key)
  if (!value) throw new Error(`缺少查询参数：${key}`)
  return value
}

function serversFromSnapshot(snapshot: Record<string, unknown>): Record<string, Record<string, unknown>> {
  const rows = Array.isArray(snapshot.servers) ? snapshot.servers : []
  const out: Record<string, Record<string, unknown>> = {}
  for (const row of rows) {
    const r = row as {
      args?: string[]
      command?: null | string
      name?: string
      transport?: string
      url?: null | string
    }
    if (typeof r.name !== 'string') continue
    const entry: Record<string, unknown> = { transport: r.transport ?? 'stdio' }
    if (r.command != null) entry.command = r.command
    if (Array.isArray(r.args) && r.args.length > 0) entry.args = r.args
    if (r.url != null) entry.url = r.url
    out[r.name] = entry
  }
  return out
}

/** The active workspace, needed by every project-scoped pi call. Wired by the
 *  host shell (runtime.tsx) so the capabilities page never guesses a cwd. */
let workspaceCwd: () => null | string = () => null

export function setBridgeWorkspaceCwd(read: () => null | string): void {
  workspaceCwd = read
}

/** Match a request against the table. `null` = no pi counterpart. */
function route(method: string, rawPath: string, body: unknown): Promise<unknown> | null {
  const [path, search = ''] = rawPath.split('?')
  const query = new URLSearchParams(search)

  for (const { pattern, handle } of ROUTES) {
    const match = pattern.exec(path)
    if (!match) continue

    // Capture groups become `__name` so handlers can read the id segment.
    for (const group of match.slice(1)) {
      if (group !== undefined) query.set('__name', group)
    }

    return handle({ body, method, query })
  }

  return null
}

export function installHostBridge(): void {
  installBridge({
    // The route handler returns `unknown` (each route knows its own shape); the
    // generic is re-typed here once, at the boundary — the same cast upstream's
    // `window.hermesDesktop.api<T>` performs over IPC.
    api: async <T,>(request: import('./global').HermesApiRequest): Promise<T> => {
      const handled = route(request.method ?? 'GET', request.path, request.body)
      if (!handled) {
        throw new Error(`端点「${request.path}」在本宿主不存在：pi 没有这个后端实现`)
      }
      return (await handled) as T
    },

    // Upstream Electron main calls shell.openExternal. The host's fs_open_url is
    // the same thing (and it is the ONLY one: it accepts http/https only, which
    // is exactly the set these call sites pass — provider auth pages, portal
    // links, docs).
    openExternal: async (url: string) => {
      await invoke<void>('fs_open_url', { url })
    },

    // Upstream Electron main reads the directory. fs_list is the host's own
    // directory reader (same shape: entries + an error CODE rather than a throw),
    // so the code is translated here — a failed read must not look like an empty
    // directory (rule 12).
    readDir: async (path: string) => {
      const result = await invoke<{ entries: { isDirectory: boolean; name: string; path: string }[]; error?: string }>(
        'fs_list',
        { path }
      )
      if (result.error) {
        throw new Error(`fs_list(${path}) 失败：${result.error}`)
      }
      return { entries: result.entries }
    },

    // Upstream Electron main reads these from Node (os / app.getLocale). The
    // renderer can read the same facts through the standard web APIs, so this is
    // a real implementation rather than an absence: `navigator.language` is the
    // OS/UI locale WebView2 reports, which is what upstream's `app.getLocale()`
    // returns on the same machine.
    getMachineProfile: async () => ({
      ageDays: null,
      arch: navigator.userAgent.includes('ARM64') ? 'arm64' : 'x64',
      locale: navigator.language ?? '',
      platform: navigator.userAgent.includes('Mac') ? 'darwin' : 'win32',
      release: '',
      username: ''
    }),

    logLine: line => console.log(line)
  })
}

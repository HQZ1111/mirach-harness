/**
 * 跨工作区会话登记表（前端投影，补 pi_list_sessions 的已知缺口）。
 *
 * **为什么存在**：rpi 的会话文件按 cwd 分目录存放
 * （`<cwd>/.rpi/sessions/--<encoded-cwd>--/<ts>_<id>.jsonl`，
 * `pi-rust-main/crates/rpi-harness/src/session/jsonl/repo.rs:106-133`），
 * 而宿主 `pi_list_sessions` 只扫描**引擎启动目录**的会话根
 * （`src-tauri/src/pi_session.rs:780-781` = `session_root(shared.cwd)`，
 * `shared.cwd` 是启动目录、不随选中的工作区更新）。
 * 于是「选择文件夹 → pi_new_session(cwd)」虽然真的建了会话（tab 标题
 * 已经显示工作区名），但下一次 `pi_list_sessions` 永远看不到它：
 * 侧栏无行、无工作区分组 —— 用户看到的"假"就是这里。
 *
 * 本表登记**由选择文件夹流程新建**的会话（id/cwd/会话文件路径），
 * runtime 的 refreshThreads 把它们并入 pi_list_sessions 的结果。这样
 * 是纯前端可验证的最小修复；彻底的跨根扫描仍应由 Rust 侧列表命令完成
 * （本轮不改 Rust：app 正在运行，改 Rust 会触发热重建/重启）。
 *
 * 路径定位不猜：目录名编码逐字照抄上游
 * `jsonl_session_directory_name`（strip 一个前导分隔符，再把 `/`、`\`、
 * `:` 全部换成 `-`，包 `--`）；会话根优先级照抄
 * `src-tauri/src/pi_session.rs:302-321`（settings.sessionDir 优先，其次
 * `<cwd>/.rpi/sessions`）。定位失败不编造路径：记录留空并由调用方
 * console.error 可见（该行的打开/删除等动作会因缺 path 明确失败）。
 */
import { createStore } from 'zustand'

import { fsList } from '@/lib/fs'
import { invoke } from '@tauri-apps/api/core'

export const WORKSPACE_SESSIONS_KEY = 'mirach.harness.workspace-sessions.v1'

export interface WorkspaceSessionRecord {
  /** pi 会话 id（文件 header id；与 pi_get_state.sessionId 同源）。 */
  id: string
  /** 工作区目录（pi_new_session 的 working_directory）。 */
  cwd: string
  /** 会话 jsonl 文件（路径定位失败时缺省——动作层会明确报错）。 */
  path?: string
  /** 落盘名（派生标题/用户重命名；pi_list_sessions 里没有它时用这个）。 */
  title?: string
  messageCount: number
  createdAtMs: number
  lastModifiedMs: number
}

/** 上游编码：`--<cwd 去一个前导分隔符、/ \ : 换 ->--`。 */
export function sessionDirectoryName(cwd: string): string {
  const normalized = cwd.replace(/[\\/]+$/, '') || cwd
  const stripped = normalized.replace(/^[\\/]/, '')
  const replaced = stripped.replace(/[\\/:]/g, '-')
  return `--${replaced}--`
}

const hasWindowsSeparator = (path: string): boolean =>
  /^[A-Za-z]:/.test(path) || path.includes('\\')

/** 拼接会话根（保留调用方路径的原生分隔符习惯；不引入 node:path）。 */
export function joinSessionPath(base: string, ...parts: string[]): string {
  const separator = hasWindowsSeparator(base) ? '\\' : '/'
  const head = base.replace(/[\\/]+$/, '')
  const tail = parts
    .map((part) => part.replace(/^[\\/]+/, '').replace(/[\\/]+$/, ''))
    .filter((part) => part.length > 0)
  return [head, ...tail].join(separator)
}

const isAbsolutePath = (path: string): boolean =>
  /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\') || path.startsWith('/')

/** 会话根解析（与宿主 session_root 同优先级；settings 为 pi_get_settings 原文）。 */
export function resolveSessionRoot(
  cwd: string,
  settings: Record<string, unknown> | null | undefined,
): string {
  const raw = settings?.['sessionDir'] ?? settings?.['session_dir']
  if (typeof raw === 'string' && raw.trim().length > 0) {
    const value = raw.trim()
    return isAbsolutePath(value) ? value : joinSessionPath(cwd, value)
  }
  return joinSessionPath(cwd, '.rpi', 'sessions')
}

export interface SessionPathResolution {
  root: string
  path: string | null
  reason?: string
}

/**
 * 定位会话文件：会话根 → cwd 编码目录 → `*_<id>.jsonl`。
 * 失败返回 path:null + reason（调用方必须把 reason 记进 console.error，
 * 不得静默当成功）。
 */
export async function resolveSessionPath(
  cwd: string,
  sessionId: string,
): Promise<SessionPathResolution> {
  const settings = await invoke<Record<string, unknown> | null>('pi_get_settings')
  const root = resolveSessionRoot(cwd, settings)
  const directory = joinSessionPath(root, sessionDirectoryName(cwd))
  const listing = await fsList(directory)
  if (listing.error) {
    return {
      root,
      path: null,
      reason: `无法读取会话目录（${listing.error}）：${directory}`,
    }
  }
  const suffix = `_${sessionId}.jsonl`
  const file = listing.entries.find(
    (entry) => !entry.isDirectory && entry.name.endsWith(suffix),
  )
  if (!file) {
    return {
      root,
      path: null,
      reason: `会话文件不在 ${directory}（无法定位 ${sessionId}）`,
    }
  }
  return { root, path: file.path }
}

/** 侧栏行形状（与 runtime 的 pi_list_sessions 投影同形）。 */
export interface WorkspaceSessionRow {
  status: 'regular'
  id: string
  title?: string
  custom: {
    path?: string
    messageCount: number
    lastModifiedMs: number
    cwd: string
    timestamp: number
  }
}

/**
 * 把登记表并入 pi_list_sessions 的投影：pi 列表已有的 id 以 pi 为准
 * （文件统计/名称是真相），只补 pi 列表缺的行；顺序按登记表插入序。
 */
export function mergeWorkspaceSessionRows<T extends { id: string }>(
  rows: readonly T[],
  records: readonly WorkspaceSessionRecord[],
): (T | WorkspaceSessionRow)[] {
  const known = new Set(rows.map((row) => row.id))
  const merged: (T | WorkspaceSessionRow)[] = [...rows]
  for (const record of records) {
    if (known.has(record.id)) continue
    merged.push({
      status: 'regular',
      id: record.id,
      ...(record.title ? { title: record.title } : {}),
      custom: {
        ...(record.path ? { path: record.path } : {}),
        messageCount: record.messageCount,
        lastModifiedMs: record.lastModifiedMs,
        cwd: record.cwd,
        timestamp: record.createdAtMs,
      },
    })
  }
  return merged
}

// ── 持久化（localStorage；Rust session-meta.json 的字段面不含本表） ──

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

const parseRecord = (value: unknown): WorkspaceSessionRecord | null => {
  if (typeof value !== 'object' || value === null) return null
  const raw = value as Record<string, unknown>
  const id = typeof raw.id === 'string' ? raw.id : ''
  const cwd = typeof raw.cwd === 'string' ? raw.cwd : ''
  if (!id || !cwd) return null
  return {
    id,
    cwd,
    ...(typeof raw.path === 'string' && raw.path.length > 0 ? { path: raw.path } : {}),
    ...(typeof raw.title === 'string' && raw.title.length > 0 ? { title: raw.title } : {}),
    messageCount: isFiniteNumber(raw.messageCount) ? raw.messageCount : 0,
    createdAtMs: isFiniteNumber(raw.createdAtMs) ? raw.createdAtMs : 0,
    lastModifiedMs: isFiniteNumber(raw.lastModifiedMs) ? raw.lastModifiedMs : 0,
  }
}

const loadRecords = (): Record<string, WorkspaceSessionRecord> => {
  if (typeof localStorage === 'undefined') return {}
  let text: string | null
  try {
    text = localStorage.getItem(WORKSPACE_SESSIONS_KEY)
  } catch (e) {
    console.error('[workspace-sessions] localStorage 读取失败', e)
    return {}
  }
  if (!text) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    // 损坏的持久化不冒充空表：可见报错后按空表启动（没有可恢复语义）。
    console.error('[workspace-sessions] 登记表 JSON 损坏——按空表启动', e)
    return {}
  }
  if (!Array.isArray(parsed)) {
    console.error('[workspace-sessions] 登记表形状非法（不是数组）——按空表启动', parsed)
    return {}
  }
  const out: Record<string, WorkspaceSessionRecord> = {}
  for (const item of parsed) {
    const record = parseRecord(item)
    if (!record) {
      console.error('[workspace-sessions] 丢弃非法登记项', item)
      continue
    }
    out[record.id] = record
  }
  return out
}

const persistRecords = (entries: Record<string, WorkspaceSessionRecord>): void => {
  try {
    localStorage.setItem(WORKSPACE_SESSIONS_KEY, JSON.stringify(Object.values(entries)))
  } catch (e) {
    console.error('[workspace-sessions] 登记表写入失败（本进程内仍生效）', e)
  }
}

interface WorkspaceSessionIndexState {
  entries: Record<string, WorkspaceSessionRecord>
  register(record: WorkspaceSessionRecord): void
  patch(id: string, patch: Partial<WorkspaceSessionRecord>): void
  setTitle(id: string, title: string | undefined): void
  updateStats(id: string, messageCount: number, lastModifiedMs: number): void
  remove(id: string): void
}

export const workspaceSessionIndex = createStore<WorkspaceSessionIndexState>((set, get) => ({
  entries: loadRecords(),
  register: (record) => {
    const next = { ...get().entries, [record.id]: record }
    set({ entries: next })
    persistRecords(next)
  },
  patch: (id, patch) => {
    const current = get().entries[id]
    if (!current) return
    const next = { ...get().entries, [id]: { ...current, ...patch } }
    set({ entries: next })
    persistRecords(next)
  },
  setTitle: (id, title) => {
    const current = get().entries[id]
    if (!current) return
    const normalized = title?.trim() || undefined
    if (current.title === normalized) return
    const next = {
      ...get().entries,
      [id]: { ...current, ...(normalized ? { title: normalized } : {}) },
    }
    if (!normalized) delete (next[id] as Partial<WorkspaceSessionRecord>).title
    set({ entries: next })
    persistRecords(next)
  },
  updateStats: (id, messageCount, lastModifiedMs) => {
    const current = get().entries[id]
    if (!current) return
    if (
      current.messageCount === messageCount &&
      current.lastModifiedMs === lastModifiedMs
    ) {
      return
    }
    const next = {
      ...get().entries,
      [id]: { ...current, messageCount, lastModifiedMs },
    }
    set({ entries: next })
    persistRecords(next)
  },
  remove: (id) => {
    if (!(id in get().entries)) return
    const next = { ...get().entries }
    delete next[id]
    set({ entries: next })
    persistRecords(next)
  },
}))

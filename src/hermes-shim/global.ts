/**
 * `@/global` shim — the desktop types the capabilities tree imports.
 *
 * Upstream's `src/global.d.ts` is a 77 KB declaration of the whole Electron
 * preload bridge (`window.hermesDesktop`) plus 60+ payload types, importing from
 * `../electron/*` — the main-process source, which the host does not have and
 * must not copy (that tree is Electron; this host is Tauri/wry).
 *
 * The capabilities page touches the bridge in two ways:
 *   1. two types (`DesktopRosterAgent`, `HermesConnection`), declared below with
 *      upstream's field lists;
 *   2. a handful of methods, always through optional chaining
 *      (`window.hermesDesktop?.revealPath?.(…)`), because every call site must
 *      already tolerate an older Electron main. Those are declared optional with
 *      the same signatures; where the member is absent at runtime the call is a
 *      no-op, and the methods the page can use are installed by `bridge.ts`.
 */

/** Upstream's skin payload type (`apps/shared/src/skin.ts`), imported so
 *  `localSkin` keeps upstream's exact shape instead of an unknown-ish stand-in. */
import type { HermesSkin } from '@/hermes-mirror/shared/skin'

/** One agent in the union roster: a profile on a registered source, with the
 *  pre-computed @name-device handle for duplicate profile names. */
export interface DesktopRosterAgent {
  connectionId: string
  connectionKind: string
  connectionLabel: string
  profile: string
  targetProfile?: string
  handle: string
}

/** Upstream `electron/machine-profile.ts::MachineProfile` — the facts the first-run
 *  guide and the locale probe read. Declared with upstream's exact fields; the
 *  host installs NO `getMachineProfile` member (there is no machine-profile IPC),
 *  so every call site takes its documented "unknown" path. */
export interface DesktopMachineProfile {
  ageDays: number | null
  arch: string
  locale: string
  platform: string
  release: string
  username: string
}

/** Upstream `global.d.ts::DesktopCloudStatus` — the portal the desktop talks to.
 *  The host has no cloud/portal (no subscription), so `cloud` is not installed;
 *  the type exists because `connectors/data/portal.ts` reads it off the member. */
export interface DesktopCloudStatus {
  portalBaseUrl: string
  signedIn: boolean
}

/** Upstream `global.d.ts::HermesReadDirEntry` / `HermesReadDirResult`. */
export interface HermesReadDirEntry {
  name: string
  path: string
  isDirectory: boolean
}

export interface HermesReadDirResult {
  entries: HermesReadDirEntry[]
  error?: string
}

/** The renderer's resolved backend descriptor. The host has exactly one backend
 *  (the pi engine); the remote fields are declared because copied shim modules
 *  read them when describing a backend. */
export interface HermesConnection {
  baseUrl: string
  isFullscreen: boolean
  mode?: 'local' | 'remote'
  authMode?: 'native' | 'oauth' | 'token'
  token: string
  wsUrl: string
  logs: string[]
  profile?: string
  connectionId?: string
  registryScoped?: boolean
  remoteHost?: string
  remoteIdentity?: string
  remoteKind?: 'cloud' | 'ssh' | 'url'
  windowButtonPosition: { x: number; y: number } | null
}

/** A REST-shaped request. Upstream the Electron main proxies it to the hermes
 *  backend; `bridge.ts` routes the routes pi can serve and rejects the rest. */
export interface HermesApiRequest {
  body?: unknown
  connectionId?: string
  method?: 'DELETE' | 'GET' | 'PATCH' | 'POST' | 'PUT'
  path: string
  /** Upstream's dial hint; nothing here can change scheduling. */
  priority?: 'background' | 'foreground'
  profile?: string
  timeoutMs?: number
}

/** Bridge members the mirrored tree touches. `api` is required — `bridge.ts`
 *  installs it before the capabilities page mounts. The rest are optional:
 *  absence is a real state (this host does not implement the Electron main), and
 *  every copied call site guards with `?.`. */
export interface HermesDesktopBridge {
  api: <T>(request: HermesApiRequest) => Promise<T>
  /**
   * 连接注册表（宿主对应 `pi_connections_*`）。
   *
   * `id` 是 bots 用来判断「成员所属连接是否已被删除」的键（见 `plugin.tsx:330`
   * 的 `annotateOrphanedGroupChatMembers`）。`onChanged` 是注册表生命周期推送
   * （`reason: 'removed'` 时 bots 会清扫孤儿成员）。
   *
   * 宿主 `onChanged` 实现见 `bridge.ts`（订阅 `mirach:connections-changed` 事件）。
   */
  connections?: {
    list: () => Promise<{ connections: { connectionId: string; id?: string; label: string }[] }>
    onChanged?: (handler: (payload: { connectionId?: string; reason?: string }) => void) => () => void
  }
  desktopPluginsRoot?: () => Promise<string>
  getAgentRoster?: () => Promise<{ agents: DesktopRosterAgent[] }>
  getConnection?: (profile?: null | string) => Promise<HermesConnection>
  getConnectionFor?: (payload: { connectionId?: null | string; profile?: null | string }) => Promise<HermesConnection>
  cloud?: { status: (payload?: Record<string, unknown>) => Promise<DesktopCloudStatus> }
  fetchLinkTitle?: (url: string) => Promise<string>
  getMachineProfile?: () => Promise<DesktopMachineProfile>
  glassSupported?: () => boolean
  localSkin?: { profile: string; skin: HermesSkin } | null
  logLine?: (line: string) => void
  mcpOauth?: {
    cancel: (id: string) => Promise<boolean>
    listen: () => Promise<{ id: string; redirectUri: string }>
    start: (payload: Record<string, unknown>) => Promise<unknown>
    wait: (id: string, timeoutMs?: number) => Promise<{ code: null | string; error: null | string; iss: null | string; state: null | string }>
  }
  openBrowserWindow?: (url: string) => Promise<void>
  openSessionInTerminal?: (payload: Record<string, unknown>) => Promise<void>
  openSessionWindow?: (payload: Record<string, unknown>) => Promise<void>
  openWindow?: (payload: Record<string, unknown>) => Promise<void>
  resolveFavicon?: (url: string) => Promise<string>
  revealLogs?: () => Promise<void>
  saveImageFromUrl?: (url: string, name?: string) => Promise<{ error?: string; ok: boolean }>
  setNativeTheme?: (theme: 'dark' | 'light' | 'system') => void
  setTitleBarTheme?: (theme: unknown) => void
  setTranslucency?: (state: unknown) => Promise<void>
  settings?: unknown
  stopPreviewFileWatch?: (payload: Record<string, unknown>) => Promise<void>
  translucencySupported?: () => boolean
  updates?: unknown
  writeClipboard?: (text: string) => Promise<{ error?: string; ok: boolean }>
  openDir?: (path: string) => Promise<{ error?: string; ok: boolean }>
  openExternal: (url: string) => Promise<void>
  reconcileDesktopPlugins?: () => Promise<void>
  removeDesktopPlugin?: (id: string) => Promise<{ error?: string; ok: boolean }>
  revealPath?: (path: string) => Promise<void>
  sanitizeWorkspaceCwd?: (cwd: string) => Promise<string>

  // ── Members the copied shim modules reference ────────────────────────────
  // Upstream these are Electron-main IPC (fs/git/terminal). pi exposes its own
  // IPC surface, so these stay UNTYPED-IMPLEMENTED here: declared as unknown
  // payloads with the signatures the copied modules call, and left undefined at
  // runtime (every copied call site guards with `?.` — absence is the honest
  // "this host does not implement it"). Wiring them to real pi IPC is per-feature
  // work, done where a feature actually lands.
  freeTierChallenge?: unknown
  getRecentLogs?: () => Promise<{ lines: string[]; path: string }>
  git?: unknown
  gitRoot?: (path: string) => Promise<null | string>
  readDir: (path: string) => Promise<HermesReadDirResult>
  readFileDataUrl?: (path: string, maxBytes?: number) => Promise<unknown>
  readFileDataUrlForAttach?: (path: string) => Promise<unknown>
  readFileText?: (path: string) => Promise<unknown>
  renamePath?: (path: string, newName: string) => Promise<{ path: string }>
  reportRendererError?: (report: { boundary: string; componentStack: string; label: string; message: string }) => void
  saveGatewayFile?: (payload: Record<string, unknown>) => Promise<unknown>
  selectPaths?: (options: Record<string, unknown>) => Promise<unknown>
  trashPath?: (path: string) => Promise<boolean>
  windowRelay?: unknown
  writeTextFile?: (path: string, content: string) => Promise<{ path: string }>
}

declare global {
  interface Window {
    hermesDesktop: HermesDesktopBridge
  }
}

export {}

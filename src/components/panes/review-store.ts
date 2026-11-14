/**
 * 审查（review）store —— hermes 桌面端 `src/store/review.ts`（791 行）的
 * 宿主移植（nanostores → zustand，逐字段对齐）。
 *
 * ## 上游结构（逐块对照）
 *
 * | 上游 | 本文件 |
 * |---|---|
 * | `$reviewFiles/$reviewLoading/$reviewIsRepo` | state.files / loading / isRepo |
 * | `$reviewMaxChurn`（computed） | `maxChurnOf(files)`（纯函数，渲染期算） |
 * | `$reviewSelectedPath/$reviewDiff/$reviewDiffLoading` | state.selectedPath / diff / diffLoading |
 * | `$reviewTreeMode`（persistentAtom） | state.treeMode（localStorage 同键语义） |
 * | `$reviewScope`（persistentAtom） | state.scope（uncommitted/branch/lastTurn） |
 * | `$reviewCommitDefault`（persistentAtom） | state.commitDefault（commit/commitPush） |
 * | `$reviewShipInfo/$reviewShipBusy/$reviewCommitMsgBusy` | shipInfo / shipBusy / commitMsgBusy |
 * | `$reviewRevertTarget` | revertTarget |
 * | `$reviewTurnBase`（cwd → HEAD sha，LRU 8） | turnBase（同语义） |
 * | `refreshReview/scheduleReviewRefresh`（seq 守卫 + 100ms 防抖） | 同名同语义 |
 * | `selectReviewFile/clearReviewSelection` | 同名同语义 |
 * | `stageReviewFile/unstageReviewFile/revertReviewFile` + `afterMutation` | 同名同语义 |
 * | `commitChanges/generateCommitMessage/cancelCommitMessage/pushChanges/createOrOpenPr` | 同名同语义 |
 * | `openReview/closeReview/toggleReview/revealReview/openReviewForPath` | 同名同语义（面板开关走 dockview 而非 pane-shell） |
 * | 自动刷新触发（workspaceChangeTick / busy settle / turn 基线 / cwd 变化 / focus） | `wireReviewTriggers()`（见文件末） |
 *
 * ## 与上游的差异（都是宿主事实）
 *
 * 1. **git 桥**：上游 `desktopGit().review.*`（Electron IPC，或远端 REST 镜像）；
 *    宿主 = `fs_git_*` IPC（fs.rs 审查段，同一语义用 git 子进程实现）。见
 *    `lib/desktop-git.ts`（宿主版桥，形状与上游一致）。
 * 2. **一次性 LLM（生成提交信息）**：上游 `requestOneShot({template:'commit_message'})`
 *    走网关的会话外端点；宿主 pi 没有"会话外一次性调用"的 IPC。**不提供该
 *    能力**（按钮按上游语义渲染但 disabled + 说明），不造假成功。
 * 3. **多工作区定向审查**（`$reviewScopeCwd` / tile worktree）：宿主单工作区，
 *    cwd 恒跟随活动会话。`reviewScopeCwd` 保留字段（恒 null）以便接线。
 * 4. **指标/PR 分支标记**（`recordFeatureUse` / `stampSessionPrBranch`）：
 *    宿主没有这两套 store，不移植（无行为差异，只是少了埋点）。
 * 5. **窄宽 overlay 揭示**（`PANE_TOGGLE_REVEAL_EVENT`）：宿主审查面板是
 *    dockview 面板，`toggleReview/revealReview` 直接开/聚焦该面板。
 */

import { invoke } from '@tauri-apps/api/core'
import { createStore, useStore } from 'zustand'

import { inTauri } from '@/lib/tauri-window'

import { sessionCatalog } from '@/components/panes/session-manage/session-catalog'

// ── 类型（hermes `global.d.ts` 的 HermesReview* 逐字段）─────────────────

export type ReviewScope = 'uncommitted' | 'branch' | 'lastTurn'
export type ReviewTreeMode = 'list' | 'tree'
export type CommitAction = 'commit' | 'commitPush'

export interface ReviewFile {
  path: string
  added: number
  removed: number
  /** M/A/D/R/C/U/? */
  status: string
  staged: boolean
}

export interface ReviewPr {
  url: string
  state: string
  number: number
}

export interface ShipInfo {
  ghReady: boolean
  pr: ReviewPr | null
}

export interface ReviewListResult {
  files: ReviewFile[]
  base: string | null
}

// ── 持久化（上游 `hermes.desktop.*` 键；宿主前缀 mirach.desktop.*）──────

const TREE_MODE_KEY = 'mirach.desktop.reviewTreeMode'
const SCOPE_KEY = 'mirach.desktop.reviewScope'
const COMMIT_DEFAULT_KEY = 'mirach.desktop.reviewCommitDefault'
const SELECTED_KEY = 'mirach.desktop.reviewSelectedPath'

const REVIEW_REFRESH_DEBOUNCE_MS = 100
const SHIP_INFO_STALE_MS = 30_000
/** 轮次基线表上限（上游 MAX_TURN_BASES 同值）。 */
const MAX_TURN_BASES = 8

function readLocal(key: string): string | null {
  if (typeof localStorage === 'undefined') return null
  try {
    return localStorage.getItem(key)
  } catch (e) {
    console.error(`[review] localStorage 读取失败（${key}）`, e)
    return null
  }
}

function writeLocal(key: string, value: string | null): void {
  if (typeof localStorage === 'undefined') return
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch (e) {
    console.error(`[review] localStorage 写入失败（${key}）`, e)
  }
}

/** 单文件最大变更行数（驱动每行的 churn 条：相对最大值按比例缩放）。 */
export function maxChurnOf(files: readonly ReviewFile[]): number {
  return files.reduce((max, f) => Math.max(max, f.added + f.removed), 0)
}

// ── 状态 ────────────────────────────────────────────────────────────────

export interface ReviewState {
  /** 当前仓库根（活动会话的 cwd；空 = 无会话）。 */
  repoCwd: string
  files: ReviewFile[]
  loading: boolean
  /** false = cwd 不是 git 仓库（面板说"不是仓库"而不是"没有变更"）。 */
  isRepo: boolean
  treeMode: ReviewTreeMode
  scope: ReviewScope
  selectedPath: string | null
  diff: string | null
  diffLoading: boolean
  commitDefault: CommitAction
  shipInfo: ShipInfo
  shipBusy: boolean
  /** 提交信息生成中（宿主不支持 → 恒 false，见文件头差异 2）。 */
  commitMsgBusy: boolean
  /** 提交/推送进行中的错误（ship bar 内联显示）。 */
  shipError: string | null
  /** revert 确认框：`{path}`（path null = 全部）；undefined = 关着。 */
  revertTarget: { path: null | string } | undefined
  /** 每仓库的轮次基线（cwd → 轮次开始时的 HEAD sha），lastTurn 的 baseRef。 */
  turnBase: Record<string, string>

  setRepoCwd: (cwd: string) => void
  setScope: (scope: ReviewScope) => void
  toggleTreeMode: () => void
  setCommitDefault: (action: CommitAction) => void
  refresh: () => Promise<boolean>
  selectFile: (file: ReviewFile) => Promise<void>
  clearSelection: () => void
  stageFile: (path: null | string) => Promise<void>
  unstageFile: (path: null | string) => Promise<void>
  requestRevert: (path: null | string) => void
  cancelRevert: () => void
  confirmRevert: () => Promise<void>
  commitChanges: (message: string, push: boolean) => Promise<void>
  pushChanges: () => Promise<void>
  refreshShipInfo: () => Promise<void>
  createOrOpenPr: () => Promise<void>
  /** 记录轮次基线（busy 上升沿调用；best-effort，失败不阻断）。 */
  captureTurnBase: (cwd: string) => Promise<void>
}

/** 只读 scope（branch / lastTurn）——暂存/还原/提交都只对未提交范围有意义。 */
export const isReadOnlyScope = (scope: ReviewScope): boolean => scope !== 'uncommitted'

function decodeScope(raw: string | null): ReviewScope {
  return raw === 'branch' || raw === 'lastTurn' ? raw : 'uncommitted'
}

// ── 序号守卫（上游 reviewRefreshSeq / reviewSelectionSeq / shipInfoSeq）──

let refreshSeq = 0
let refreshTimer: ReturnType<typeof setTimeout> | null = null
let selectionSeq = 0
let shipInfoSeq = 0
let shipInfoLastCheckedAt = 0

const repoCwdOf = (): string => reviewStore.getState().repoCwd.trim()

/** lastTurn 的 baseRef：面板自己的仓库 cwd 对应的轮次基线。 */
function reviewReadParams(): { scope: ReviewScope; baseRef: string | null } {
  const { scope, turnBase } = reviewStore.getState()
  if (scope !== 'lastTurn') return { scope, baseRef: null }
  const cwd = repoCwdOf()
  return { scope, baseRef: cwd ? (turnBase[cwd] ?? null) : null }
}

export const reviewStore = createStore<ReviewState>((set, get) => ({
  repoCwd: '',
  files: [],
  loading: false,
  isRepo: true,
  treeMode: readLocal(TREE_MODE_KEY) === 'list' ? 'list' : 'tree',
  scope: decodeScope(readLocal(SCOPE_KEY)),
  selectedPath: readLocal(SELECTED_KEY),
  diff: null,
  diffLoading: false,
  commitDefault: readLocal(COMMIT_DEFAULT_KEY) === 'commitPush' ? 'commitPush' : 'commit',
  shipInfo: { ghReady: false, pr: null },
  shipBusy: false,
  commitMsgBusy: false,
  shipError: null,
  revertTarget: undefined,
  turnBase: {},

  setRepoCwd: (cwd) => {
    if (get().repoCwd === cwd) return
    // 仓库换主 → 先清旧列表 + 选中（上游 onReviewRepoMoved 同语义：直接
    // 掉进 loading 骨架，不把上个仓库的 diff 闪进新仓库）。
    set({ repoCwd: cwd, files: [], selectedPath: null, diff: null, loading: true })
    void get().refresh()
    void get().refreshShipInfo()
  },

  setScope: (scope) => {
    if (get().scope === scope) return
    writeLocal(SCOPE_KEY, scope)
    // 上游 selectScope：换 scope 先清选中再刷新。
    get().clearSelection()
    set({ scope })
    void get().refresh()
  },

  toggleTreeMode: () => {
    const next = get().treeMode === 'tree' ? 'list' : 'tree'
    writeLocal(TREE_MODE_KEY, next)
    set({ treeMode: next })
  },

  setCommitDefault: (action) => {
    writeLocal(COMMIT_DEFAULT_KEY, action)
    set({ commitDefault: action })
  },

  refresh: async () => {
    // 直接刷新要顶掉已排队的防抖（上游同款：否则 openReviewForPath 发起的
    // 列表请求会被定时器反超）。
    if (refreshTimer) {
      clearTimeout(refreshTimer)
      refreshTimer = null
    }

    const intentCwd = repoCwdOf()
    const seq = (refreshSeq += 1)
    const selectionAtStart = selectionSeq
    const ownsList = () => seq === refreshSeq && repoCwdOf() === intentCwd

    if (!inTauri || !intentCwd) {
      if (ownsList()) {
        set({ files: [], isRepo: false, loading: false })
      }
      return ownsList()
    }

    set({ isRepo: true, loading: true })

    try {
      const { scope, baseRef } = reviewReadParams()
      const result = await invoke<ReviewListResult>('fs_git_review_list', {
        path: intentCwd,
        scope,
        baseRef,
      })

      if (!ownsList()) return false

      set({ files: result.files })

      // 选中文件消失（暂存走/被还原）→ 清选择防鬼影；还在且 diff 未取 →
      // 拉取（恢复持久化选中时开机即渲染）。
      if (selectionAtStart === selectionSeq) {
        const selected = get().selectedPath
        const selectedFile = selected ? result.files.find((f) => f.path === selected) : null
        if (selected && !selectedFile) {
          get().clearSelection()
        } else if (selectedFile && get().diff === null) {
          void get().selectFile(selectedFile)
        }
      }

      return true
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      // 非仓库 = 真实状态（面板说"不是仓库"）；其余错误进列表错误态
      // （禁止兜底：错误可见，不只吞成空列表）。
      if (message.includes('不是 git 仓库')) {
        if (ownsList()) set({ isRepo: false, files: [] })
      } else {
        console.error('[review] 变更列表获取失败', e)
        if (ownsList()) set({ files: [] })
      }
      return ownsList()
    } finally {
      if (ownsList()) set({ loading: false })
    }
  },

  selectFile: async (file) => {
    const seq = (selectionSeq += 1)
    writeLocal(SELECTED_KEY, file.path)
    set({ selectedPath: file.path, diffLoading: true })

    const intentCwd = repoCwdOf()
    const ownsSelection = () =>
      seq === selectionSeq && get().selectedPath === file.path && repoCwdOf() === intentCwd

    if (!inTauri || !intentCwd) {
      if (ownsSelection()) set({ diff: null, diffLoading: false })
      return
    }

    try {
      const { scope, baseRef } = reviewReadParams()
      const diff = await invoke<string>('fs_git_review_diff', {
        path: intentCwd,
        file: file.path,
        scope,
        baseRef,
        staged: file.staged,
      })
      if (ownsSelection()) set({ diff: diff || '' })
    } catch (e) {
      console.error('[review] diff 获取失败', e)
      if (ownsSelection()) set({ diff: '' })
    } finally {
      if (ownsSelection()) set({ diffLoading: false })
    }
  },

  clearSelection: () => {
    selectionSeq += 1
    writeLocal(SELECTED_KEY, null)
    set({ selectedPath: null, diff: null, diffLoading: false })
  },

  // ── 变更操作（上游 afterMutation：重拉列表 + 重取选中 diff）────────────

  stageFile: async (path) => {
    if (isReadOnlyScope(get().scope)) return
    await invoke('fs_git_stage', { path: get().repoCwd, file: path })
    await afterMutation()
  },

  unstageFile: async (path) => {
    if (isReadOnlyScope(get().scope)) return
    await invoke('fs_git_unstage', { path: get().repoCwd, file: path })
    await afterMutation()
  },

  requestRevert: (path) => set({ revertTarget: { path } }),
  cancelRevert: () => set({ revertTarget: undefined }),

  confirmRevert: async () => {
    const target = get().revertTarget
    set({ revertTarget: undefined })
    if (!target) return
    if (isReadOnlyScope(get().scope)) return
    await invoke('fs_git_revert', { path: get().repoCwd, file: target.path })
    await afterMutation()
  },

  // ── ship 流（commit / push / PR）─────────────────────────────────────

  commitChanges: async (message, push) => {
    const trimmed = message.trim()
    if (!trimmed) return
    set({ shipBusy: true, shipError: null })
    try {
      await invoke('fs_git_commit', { path: get().repoCwd, message: trimmed, push })
      await get().refresh()
      void get().refreshShipInfo()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      set({ shipError: msg })
      console.error('[review] 提交失败', e)
    } finally {
      set({ shipBusy: false })
    }
  },

  pushChanges: async () => {
    set({ shipBusy: true, shipError: null })
    try {
      await invoke('fs_git_push', { path: get().repoCwd })
      void get().refreshShipInfo()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      set({ shipError: msg })
      console.error('[review] 推送失败', e)
    } finally {
      set({ shipBusy: false })
    }
  },

  refreshShipInfo: async () => {
    const cwd = get().repoCwd
    const seq = (shipInfoSeq += 1)
    if (!inTauri || !cwd) {
      set({ shipInfo: { ghReady: false, pr: null } })
      return
    }
    try {
      const info = await invoke<ShipInfo>('fs_git_ship_info', { path: cwd })
      if (seq === shipInfoSeq && get().repoCwd === cwd) {
        set({ shipInfo: info })
        shipInfoLastCheckedAt = Date.now()
      }
    } catch (e) {
      console.error('[review] ship 信息获取失败', e)
      if (seq === shipInfoSeq) {
        set({ shipInfo: { ghReady: false, pr: null } })
        shipInfoLastCheckedAt = Date.now()
      }
    }
  },

  createOrOpenPr: async () => {
    const cwd = get().repoCwd
    if (!inTauri || !cwd) return

    const existing = get().shipInfo.pr
    if (existing?.url) {
      void openExternal(existing.url)
      return
    }

    set({ shipBusy: true, shipError: null })
    try {
      const { url } = await invoke<{ url: string }>('fs_git_create_pr', { path: cwd })
      if (url) void openExternal(url)
      void get().refreshShipInfo()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      set({ shipError: msg })
      console.error('[review] 创建 PR 失败', e)
    } finally {
      set({ shipBusy: false })
    }
  },

  captureTurnBase: async (cwd) => {
    const trimmed = cwd.trim()
    if (!inTauri || !trimmed) return
    try {
      const sha = await invoke<string | null>('fs_git_rev_parse', { path: trimmed, refName: 'HEAD' })
      if (!sha) return
      set((state) => {
        const prev = state.turnBase
        if (prev[trimmed] === sha) return state
        // 重插该 cwd 让对象键序跟踪最近使用（最旧在前），超上限从头部淘汰。
        const rest = Object.entries(prev).filter(([key]) => key !== trimmed)
        while (rest.length >= MAX_TURN_BASES) rest.shift()
        rest.push([trimmed, sha])
        return { turnBase: Object.fromEntries(rest) }
      })
    } catch (e) {
      // best-effort：非仓库/无提交时 lastTurn 显示空，不是错误。
      console.error('[review] 轮次基线捕获失败', e)
    }
  },
}))

/** 变更后：重拉列表，并重取选中文件的 diff（暂存翻转 diff 读哪边）。 */
async function afterMutation(): Promise<void> {
  await reviewStore.getState().refresh()
  const { selectedPath, files, selectFile } = reviewStore.getState()
  const file = selectedPath ? files.find((f) => f.path === selectedPath) : null
  if (file) void selectFile(file)
}

function refreshShipInfoIfStale(): void {
  if (Date.now() - shipInfoLastCheckedAt > SHIP_INFO_STALE_MS) {
    void reviewStore.getState().refreshShipInfo()
  }
}

/** 100ms 防抖刷新（上游 scheduleReviewRefresh 同语义）。 */
export function scheduleReviewRefresh(): void {
  if (refreshTimer) clearTimeout(refreshTimer)
  // 排程本身就是更新的列表意图：现在就作废在途请求，别等防抖到点。
  refreshSeq += 1
  refreshTimer = setTimeout(() => {
    refreshTimer = null
    void reviewStore.getState().refresh()
  }, REVIEW_REFRESH_DEBOUNCE_MS)
}

/** 打开外部浏览器（宿主没有 opener 插件，走 fs_open_url）。 */
async function openExternal(url: string): Promise<void> {
  try {
    await invoke('fs_open_url', { url })
  } catch (e) {
    console.error('[review] 打开浏览器失败', e)
  }
}

/**
 * 面板入口动作（上游 openReview / closeReview / toggleReview / revealReview
 * 的宿主形态）。
 *
 * 上游是 pane-shell 的面板树：open 置 `$reviewOpen`，reveal 还要 front/
 * un-minimize。宿主审查面板是 dockview 的 `review` 面板，开关走 dockview
 * api——但 store 不该依赖布局层（上游也不依赖），所以这里只做数据侧
 * （确保 cwd 与刷新），面板显隐由调用方用 dockview api 完成。
 */
export function openReview(): void {
  const cwd = activeSessionCwd()
  if (cwd) {
    // setRepoCwd 内部已经触发 refresh + refreshShipInfo（换仓库要先清列表）。
    reviewStore.getState().setRepoCwd(cwd)
    return
  }
  // 无活动会话 / cwd 未变：只补一次刷新（幂等，不重复打 IPC）。
  void reviewStore.getState().refresh()
  void reviewStore.getState().refreshShipInfo()
}

export function closeReview(): void {
  reviewStore.getState().clearSelection()
}

/**
 * 打开审查面板并定位到一个文件（转写区「改动的文件」卡片用；上游
 * `openReviewForPath` 同语义——工具报的路径可能是绝对路径而 git 报的是
 * 仓库相对路径，按尾部匹配）。
 */
export async function openReviewForPath(path: string): Promise<void> {
  openReview()
  const cwd = repoCwdOf()
  const refreshed = await reviewStore.getState().refresh()
  if (!refreshed || repoCwdOf() !== cwd) return

  const target = path.replace(/\\/g, '/').replace(/\/+$/, '')
  if (!target) return
  const file = reviewStore.getState().files.find((f) => {
    const candidate = f.path.replace(/\\/g, '/')
    return candidate === target || target.endsWith(`/${candidate}`) || candidate.endsWith(`/${target}`)
  })
  if (file) await reviewStore.getState().selectFile(file)
}

/** 活动会话的 cwd（`pi_list_sessions` 的 SessionMeta.cwd）。 */
export function activeSessionCwd(): string | null {
  const { activeId, entries } = sessionCatalog.getState()
  if (!activeId) return null
  return entries[activeId]?.cwd?.trim() || null
}

export function useReview<T>(selector: (s: ReviewState) => T): T {
  return useStore(reviewStore, selector)
}

// 调试句柄（与 `__dvApi` 同惯例）：E2E / CDP 从真实实例驱动，不猜 DOM。
// **必须挂在这里**：`import('/src/.../review-store.ts')` 在 vite 下是第二个
// 模块实例（AGENTS.md 陷阱 9），拿它改状态面板不会响应。
if (typeof window !== 'undefined') {
  ;(window as { __reviewStore?: typeof reviewStore }).__reviewStore = reviewStore
}
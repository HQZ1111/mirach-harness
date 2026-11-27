/**
 * assistant-ui 运行时接入（L1，docs/pi-integration.md §7-3）：
 * ExternalStore 纯渲染 + XState 轮次机唯一真相（§0.2-5 定稿）。
 *
 * 数据流：常驻 EventSource（GET /ag-ui/stream，断线自动带 Last-Event-ID
 * 重连）→ AGUI_EVENT → 轮次机归约 → messages/isRunning 喂 ExternalStore；
 * 发送：POST /ag-ui 起 run（RUN_STARTED 经 SSE 到达后进 streaming 态）。
 * 会话列表（§7-4）：threadListAdapter 接 pi SessionIndex——threadId =
 * pi 会话 id，切换 = pi_open_session + HYDRATE 注入历史（真相在 pi）。
 */
import { Component, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  AssistantRuntimeProvider,
  MessageNotSentError,
  useExternalStoreRuntime,
  type AppendMessage,
  type SpeechSynthesisAdapter,
} from '@assistant-ui/react'
import { invoke } from '@tauri-apps/api/core'
import { useSelector } from '@xstate/react'
import { createActor, type Actor } from 'xstate'
import { useStore } from 'zustand'

import { turnMachine, type TurnContext, type TurnMessage, type TurnUsage } from './turn-actor'
import {
  $hostActiveSessionId,
  $hostFocusedSessionOwner,
  $hostFocusedSessionProfile,
  $hostFocusedStoredSessionId,
  $hostBusy,
} from '@/sdk/host'
import {
  collectAttachmentPlan,
  composePrompt,
  piAttachmentAdapter,
  type PiImagePayload,
} from './attachments'
import { convertTurnMessage } from './pi-hydrate'
import { sessionPreviewBridge } from './session-preview-bridge'
import {
  applyTranscriptPeek,
  hydrateTranscriptTail,
  peekTranscriptTail,
  registerTranscriptActor,
  resetTranscriptTail,
  setEngineAttaching,
  transcriptTailStore,
} from './transcript-paging'
import { approvalBridge } from './approval-bridge'
import {
  branchBridge,
  parseForkPoints,
  type ForkRequest,
  type OpenParentRequest,
  type SwitchRequest,
} from './branch-store'
import { connectionBridge } from './connection-store'
import { bootBridge } from '@/lib/boot-store'
import { errorBridge } from './error-bridge'
import { clearThreadScroll, threadScrollBridge } from './thread-scroll-store'
import { deriveTitle, firstUserMessageText, nextTitleInLineage } from './session-title'
import { usageBridge, type UsageState } from './usage-bridge'
import { checkpointBridge, type RewindRequest } from './checkpoint-store'
import { costBridge } from './cost-bridge'
import { sessionQueue } from './session-queue-store'
import { clearComposerDraft } from './composer-draft-store'
import { conversationDisplayStore } from './conversation-display-store'
import { timelineMarkerBridge } from './timeline-marker-store'
import { dispatchToolDetails } from './tool-sidecar'
import { askBridge } from './ask-bridge'
import { runComposerMiddleware } from '@/hermes-shim/contrib/composer-middleware'

import { sessionWorkspaceStore } from '@/components/panes/session-manage/session-workspace'
import {
  hydrateSessionMeta,
  mergeSessionRows,
  sessionCatalog,
  sessionDisplayName,
  type SessionsIndexResult,
} from '@/components/panes/session-manage/session-catalog'
import { cachedAppPrefs, loadAppPrefs, setRunActive, updateAppPrefs } from '@/lib/app-prefs'
import { dispatchNativeNotification, markNativeNotifyBaseline } from '@/lib/native-notify'
import {
  mergeWorkspaceSessionRows,
  resolveSessionPath,
  workspaceSessionIndex,
  type SessionPathResolution,
} from '@/components/panes/session-manage/workspace-session-registry'
import {
  ensureProjectForWorkspace,
  ensureWorkspaceProjects,
} from '@/components/panes/session-manage/workspace-projects'

/** 启动补登记「工作区 = 项目」只跑一次（新工作区在建会话前同步登记）。 */
let workspaceProjectsBackfilled = false
import { sidebarViewStore } from '@/components/panes/session-manage/sidebar-view'
import { mainViewStore } from '@/components/panes/main-view-store'
import { fsList } from '@/lib/fs'
import { pendingBotChatStore } from '@/lib/pending-bot-chat'
import {
  activeSessionCwd,
  reviewStore,
  scheduleReviewRefresh,
} from '@/components/panes/review-store'
import {
  setSessionThreadSwitcher,
  setStoredSessionOpener,
} from '@/components/panes/session-manage/session-tab-bridge'
import { setSessionListRefresher } from '@/components/panes/session-manage/session-refresh-bridge'
import { botsStore } from '@/components/panes/hub/bots-store'
import { isBotModePlumbingTitle } from '@/components/panes/hub/hidden-sessions'
import { selectBotsRoster } from '@/plugins/bots-selection-bridge'
import {
  followProfileBridge,
  profileStore,
  setActiveProfileLocal,
  setNewChatDraftRequester,
  setProfileFollower,
  setProfileSwitcher,
  useActiveProfile,
} from '@/components/panes/session-manage/active-profile-bridge'
import { useBotsFeatureDesired } from '@/plugins/bots-gate'

import {
  BoundarySpeechSynthesisAdapter,
  ensureSpeechSupportLogged,
} from './speech-adapter'
import { sessionThreadKey, NEW_CHAT_THREAD_KEY } from './session-thread-key'

/**
 * 多会话并存（2026-11-28 用户："切换会话时要不中断对话，像 hermes 那样
 * 多标签并存、后台继续跑"）——**actor 注册表**：每个会话一份轮次机投影
 * （键 = `main:<piSessionId>`，与引擎 POST 的事件路由键同源），切换会话 =
 * 换焦点 actor（投影原样保留），**不重水合、不重置、不打断在跑 run**。
 *
 * 事件流模型：POST 解析会话后把 run 事件全部路由到 `main:<id>` 专属缓冲
 * （agui.rs），切走后 run 在 retired 句柄上继续跑、事件继续落自己的桶；
 * 焦点回到该会话时 SSE 从 actor 的 lastEventId 续放，增量无缝接上。
 * hermes `useSessionStateCache`（per-session ClientSessionState，busy 条目
 * 永不驱逐）+ "only the viewed session may stage into the shared view" 的
 * 宿主对偶。
 */
const ACTOR_CAP = 12

const freshTurnContext = (): TurnContext => ({
  messages: [],
  currentRunId: null,
  lastEventId: 0,
  error: null,
  usage: null,
  compaction: null,
  providerRetry: null,
  interrupted: false,
})

type TurnActor = Actor<typeof turnMachine>

const actorRegistry = new Map<string, TurnActor>()
/** 已经做过"文件水合"的会话键（切换路径据此区分冷/热：热 = 投影消费过
 *  全部流事件，只需引擎切 live + SSE 续放；冷 = 走 peek/open/水合全链）。 */
const hydratedKeys = new Set<string>()

/** 取/建焦点 actor。`focusKey` = 当前焦点键（驱逐时永不选中它）。
 *
 * 驱逐（> ACTOR_CAP）：最久未用的**非焦点、非 streaming** actor——hermes
 * `evictable()` 同语义（busy/awaiting 的条目永不驱逐，后台 run 不因容量
 * 被杀投影）。被驱逐的会话再打开 = 走冷路径重水合（文件里有已落盘部分）。 */
function getOrCreateActor(key: string, focusKey: string): TurnActor {
  let actor = actorRegistry.get(key)
  if (!actor) {
    actor = createActor(turnMachine, { input: freshTurnContext() })
    actorRegistry.set(key, actor)
  }
  if (actor.getSnapshot().status !== 'active') actor.start()
  if (actorRegistry.size > ACTOR_CAP) {
    const candidates = [...actorRegistry.entries()]
      .filter(([k, a]) => k !== focusKey && !a.getSnapshot().matches('streaming'))
      .sort((a, b) => a[1].getSnapshot().context.lastEventId - b[1].getSnapshot().context.lastEventId)
    for (const [k, a] of candidates) {
      if (actorRegistry.size <= ACTOR_CAP) break
      a.stop()
      actorRegistry.delete(k)
      hydratedKeys.delete(k)
    }
  }
  return actor
}

/** 丢弃一个会话的 actor（会话删除/New Chat 重建哨兵时用）。 */
function dropActor(key: string): void {
  const actor = actorRegistry.get(key)
  if (actor) {
    actor.stop()
    actorRegistry.delete(key)
  }
  hydratedKeys.delete(key)
}

/**
 * 焦点会话的 bot owner（插件 `host.state.focusedSessionOwner` 的对偶）。
 *
 * 机器人会话由 host-rpc 的 `session.create` 记双锚（`chatSessionId`）——只有
 * 命中锚的会话才报 owner（`{connectionId, profile: botName}`，与
 * `profiles.list` 的 RosterRow key 同源）。普通会话必须报 **null**：上游 SDK
 * 契约是无唯一 owner 时 fail closed，例程窗格（RoutinesPane）会退回花名册
 * 点选的 scope；伪造 `'local'` owner 会被当成 authoritative，匹配不到任何
 * 行 → 死锁在「这个机器人需要先出现在名单中」。
 */
let hostFocusBotsLoaded = false
function botOwnerForSession(sessionId: null | string): null | { connectionId: string; profile: string } {
  if (!sessionId) return null
  if (!hostFocusBotsLoaded) {
    hostFocusBotsLoaded = true
    botsStore.getState().load()
  }
  const bot = botsStore.getState().bots.find((b) => b.chatSessionId === sessionId)
  if (!bot) return null
  // connectionId 留空 = 本机（未 source-scoped）行。上游对 local 行的身份是
  // **裸名字**（botSelectionKey 只对 sourceScoped/remoteSource 行加
  // `connectionId::` 前缀）；带上 'local' 会让 bindProfileSync 把 $selectedBot
  // 写成 'local::name'——与 roster 行的选择键不匹配，例程窗格在"无焦点 bot"
  // 时也会退回空态。BotPreset.connectionId 是旧版远端占位标记，不能当
  // roster 身份用。
  return { connectionId: '', profile: bot.name }
}

/** 打开某个会话应当进入的环境（undefined = 该会话还未进目录且不是 bot
 *  会话，无法判定——不跟随）。bot 双锚优先（插件刚 mint 的 Bot Chat 还没
 *  进 pi_list_sessions，此时只有锚知道它属于哪个环境）。 */
function profileForSession(sessionId: string): string | null | undefined {
  const owner = botOwnerForSession(sessionId)
  if (owner) return owner.profile
  const entry = sessionCatalog.getState().entries[sessionId]
  return entry ? entry.profile ?? null : undefined
}

/** 自动命名已尝试过的会话（每会话只做一次——含失败，失败 console 可见、
 * 不静默重试；跨重启由 pi 持久的 name 字段 + 默认态判定兜住重名） */
const autoNamedSessions = new Set<string>()

/** 0 消息 Bot Chat 启动清扫只跑一次（跨重连不重复扫） */
let emptyBotChatSwept = false

/** 朗读适配器（read-aloud）：speechSynthesis 不存在的环境不注册（核心
 * capabilities.speech=false → UI 钮隐藏），console.info 一次 */
export const speechAdapter: SpeechSynthesisAdapter | undefined =
  ensureSpeechSupportLogged() ? new BoundarySpeechSynthesisAdapter() : undefined

/** 排队消息 id 序列（同毫秒双提交不得撞 id） */
let queuedSeq = 0

/** titling.auto_title 配置门（pi Config TitlingSettings，config.rs:434-440；
 * settings.json 落盘 snake_case `auto_title`，读取侧 pi 另收 autoTitle/auto
 * 别名——门保持同款别名集）。显式 false = 用户关掉自动命名；缺省（无
 * settings 文件 / titling 键缺 / auto_title 缺 / true）= 开（上游默认 true）。 */
const isAutoTitleEnabled = async (): Promise<boolean> => {
  const settings = await invoke<unknown>('pi_get_settings')
  if (settings === null || settings === undefined) return true // 无配置文件 = 上游默认
  if (typeof settings !== 'object') {
    console.error('[pi] 自动命名：pi_get_settings 返回形状非法——跳过', settings)
    return false
  }
  const titling = (settings as Record<string, unknown>).titling
  if (!titling || typeof titling !== 'object') return true
  const t = titling as Record<string, unknown>
  return (t.auto_title ?? t.autoTitle ?? t.auto) !== false
}

/** POST /ag-ui 图片契约白名单（png/jpeg/webp/gif）——实现与解析在
 * attachments.ts（附件通道单一来源：类型分类 / 提示词 / adapter） */
export {
  NATIVE_IMAGE_MIMES,
  parseImageDataUrl,
  piAttachmentAdapter,
  type PiImagePayload,
} from './attachments'

/** pi SessionIndex 行（pi_list_sessions 返回，字段对齐上游 SessionMeta） */
interface PiSessionMeta {
  path: string
  id: string
  cwd: string
  timestamp: string
  messageCount: number
  lastModifiedMs: number
  sizeBytes: number
  name: string | null
}

interface ThreadListRow {
  status: 'regular'
  id: string
  title?: string
  custom?: Record<string, unknown>
}

/** fs_list 错误码 → 用户可见的工作区错误（ZCode 对不存在/非目录的
 * `project.directory-required` 同语义：选择即建会话前先证伪目标目录；
 * 空目录是合法工作区，只有读不了/不存在/不是目录才是错误）。 */
function describeWorkspaceDirectoryError(code: string, cwd: string): string {
  switch (code) {
    case 'ENOENT':
      return `文件夹不存在：${cwd}`
    case 'EACCES':
      return `没有访问权限：${cwd}`
    case 'ENOTDIR':
      return `不是文件夹：${cwd}`
    case 'invalid-path':
      return `文件夹路径无效：${cwd}`
    default:
      return `无法读取文件夹（${code}）：${cwd}`
  }
}

/** 会话文件路径比较（Windows：分隔符统一、去 `\\?\` 前缀、去尾分隔符、
 *  大小写不敏感）。lastSessionPath 与目录行的 path 可能一个来自 pi（`\`）
 *  一个来自前端登记表（`/`）——直接 `===` 会漏清"已删空会话"的启动恢复
 *  记录，下次启动对已删文件报「会话文件无法打开」（2026-11-26 实报）。 */
function sameStoredSessionPath(a: null | string | undefined, b: null | string | undefined): boolean {
  if (!a || !b) return false
  const key = (path: string) => {
    const raw = path.replace(/\//g, '\\').replace(/^\\\\\?\\/, '')
    const trimmed = raw.length > 3 ? raw.replace(/\\+$/, '') : raw
    return trimmed.toLowerCase()
  }
  return key(a) === key(b)
}

/** 渲染错误兜底：归约链路的任何意外不得白屏整个应用（只隔离聊天树）。 */
class RuntimeBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  render() {
    if (this.state.error) {
      return (
        <div className="p-4 text-sm text-(--text-3)">
          聊天渲染出错：{String(this.state.error.message ?? this.state.error)}
        </div>
      )
    }
    return this.props.children
  }
}

export function AssistantRuntime({ children }: { children: ReactNode }) {
  // ── 焦点会话（多会话并存，2026-11-28 用户："切换会话时要不中断对话，
  // 像 hermes 那样多标签并存、后台继续跑"）——**每个会话一份轮次机投影**
  //（actorRegistry，键 = sessionThreadKey），切换 = 换焦点 actor：投影
  // 原样保留（在跑 run 的增量继续累积），不重水合、不重置、不打断。
  // hermes `useSessionStateCache` + "only the viewed session may stage into
  // the shared view" 的宿主对偶。
  const [currentThreadId, setCurrentThreadId] = useState<string | null>(null)
  const currentThreadIdRef = useRef<string | null>(null)
  currentThreadIdRef.current = currentThreadId
  const focusedThreadKey = sessionThreadKey(currentThreadId)
  const actorRef = getOrCreateActor(focusedThreadKey, focusedThreadKey)
  const messages = useSelector(actorRef, (s) => s.context.messages)
  const isRunning = useSelector(actorRef, (s) => s.matches('streaming'))
  const usage = useSelector(actorRef, (s) => s.context.usage)
  /** 在途的引擎打开（peek-first 会先画，但发送必须等引擎真就绪——
   *  prompt 持锁，打在旧会话上/撞 no active session 都是错误投递）。 */
  const pendingOpenRef = useRef<Promise<void> | null>(null)
  /** 内容加载防抖（快速连点会话 → 取消上一次的 pending 加载，只执行最后一次） */
  const switchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 转录补页通道（thread.aui 的「显示更早」→ PREPEND_HISTORY）：模块级注册，
  // actor 随 runtime 生命周期更替。
  useEffect(() => {
    registerTranscriptActor(actorRef as unknown as Parameters<typeof registerTranscriptActor>[0])
  }, [actorRef])
  // 会话管理元数据水合（Rust session-meta.json → catalog 管理维度；旧
  // localStorage 键一次性迁移）。挂载即拉一次——早于任何管理动作。
  useEffect(() => {
    void hydrateSessionMeta().catch((e) =>
      console.error('[session-catalog] 元数据水合失败——管理维度空态', e),
    )
    // 启动静默窗：重连回放不弹通知（hermes markNativeNotifyBaseline 同语义）。
    markNativeNotifyBaseline()
  }, [])
  useEffect(() => {
    usageBridge.getState().setUsage(usage as UsageState | null)
  }, [usage])
  // RUN_ERROR 用户可见面（§0.3 错误即错误）：轮次机 context.error 经桥
  // 传给 thread.aui 的错误条——机器在下一个 run 的 RUN_STARTED 归约里
  // 清 error，错误条随之消失。桥不持真相（真相在轮次机 context）。
  const runError = useSelector(actorRef, (s) => s.context.error)
  useEffect(() => {
    errorBridge.getState().setError(runError)
  }, [runError])
  // OS 通知：回合收尾（成功/失败）各派发一条，窗口失焦才亮。
  const notifyWasRunningRef = useRef(false)
  useEffect(() => {
    const wasRunning = notifyWasRunningRef.current
    notifyWasRunningRef.current = isRunning
    if (!wasRunning || isRunning) return
    const threadId = sessionCatalog.getState().activeId
    const entry = threadId ? sessionCatalog.getState().entries[threadId] : undefined
    dispatchNativeNotification({
      kind: runError === null ? 'turnDone' : 'turnError',
      title: (entry && sessionDisplayName(entry)) || 'Mirach',
      body: runError === null ? '本轮已完成' : '本轮执行失败',
      sessionId: threadId,
      activeSessionId: sessionCatalog.getState().activeId,
    })
  }, [isRunning, runError])
  // thread.state 透传（s.thread.state）：压缩横幅 / 中断态的机器投影——
  // 与 usageBridge/errorBridge 不同，这两个只在 thread.aui 消费，直接走
  // adapter 的 state 通道，不再加桥（真相仍在轮次机 context）
  const compaction = useSelector(actorRef, (s) => s.context.compaction)
  const interrupted = useSelector(actorRef, (s) => s.context.interrupted)
  // 提供方自动重试投影（同上：真相在轮次机 context，UI 直接读 state 通道）
  const providerRetry = useSelector(actorRef, (s) => s.context.providerRetry)

  // ── 审查面板的自动刷新触发（hermes store/review.ts 的模块级订阅对偶）──
  //
  // 上游挂在 `$busy`（活动会话的忙标志）与 `$workspaceChangeTick` 上：
  //  - busy **上升沿** → 记本轮基线（`git rev-parse HEAD`），供 lastTurn scope；
  //  - busy **下降沿**（一轮结束）→ 防抖刷新变更列表 + 过期就重查 gh/PR。
  // 宿主没有 `$workspaceChangeTick` 事件源（pi 的工具事件在轮次机里），
  // 用"轮次起止"这一条边覆盖同一个需求（工具改动都在轮内发生）；文件外部
  // 改动由面板的刷新钮与窗口 focus 兜底。
  //
  // 边沿变量复用下方收尾段的 `reviewWasRunningRef`（同一 render 作用域）。
  useEffect(() => {
    if (isRunning === reviewWasRunningRef.current) return
    reviewWasRunningRef.current = isRunning
    if (isRunning) {
      const cwd = activeSessionCwd()
      if (cwd) void reviewStore.getState().captureTurnBase(cwd)
      return
    }
    scheduleReviewRefresh()
  }, [isRunning])

  const [endpoint, setEndpoint] = useState<{ port: number; token: string } | null>(null)
  const endpointRef = useRef(endpoint)
  endpointRef.current = endpoint

  // ── 会话列表（§7-4 侧栏 sessions）——threadId = pi 会话 id（与
  // pi_get_state.sessionId 同源），path 存 custom 供打开/删除使用。
  // **真相源 = sessionCatalog**（用户定稿：会话名/项目名单一存储，所有
  // 消费方——侧栏/双行块/workspace 页签名——只读 catalog）；本组件是
  // 唯一写入者（pi_list_sessions 灌入 + 消息流派生标题）。assistant-ui
  // 的 threads 数组从 catalog 派生（title = 统一显示名）。
  // 必须声明在挂载 effect 之前（effect 依赖数组 render 期求值，TDZ）。
  // （currentThreadId/currentThreadIdRef 上移到组件头——焦点 actor 依赖它，
  // 多会话并存 2026-11-28。）
  // 【bisect】threads 暂回本地 state（title=统一显示名）；catalog 并行灌入。
  const [threads, setThreads] = useState<ThreadListRow[]>([])
  const threadsRef = useRef<ThreadListRow[]>([])
  threadsRef.current = threads

  // 活动会话切换 → catalog（消费方经 activeId 取显示名/项目名）。
  useEffect(() => {
    sessionCatalog.getState().setActive(currentThreadId)
    // 插件 host.state：活动会话（草稿态 null）——花名册高亮/屏幕门户读它。
    $hostActiveSessionId.set(currentThreadId)
    $hostFocusedStoredSessionId.set(currentThreadId)
    // 焦点 owner：只有机器人会话（双锚命中）报真名，普通会话报 null
    // （见 botOwnerForSession 注释——伪造 owner 会让例程窗格死锁）。
    const owner = botOwnerForSession(currentThreadId)
    $hostFocusedSessionOwner.set(owner)
    $hostFocusedSessionProfile.set(owner?.profile ?? 'local')
  }, [currentThreadId])

  // 插件 host.state.busy：轮次机 streaming 态就是"在跑"（turn 机只有
  // idle/streaming 两态，工具执行发生在 streaming 内，不是独立状态）。
  useEffect(() => {
    const sub = actorRef.subscribe((snap) => {
      $hostBusy.set(snap.matches('streaming'))
    })
    return () => sub.unsubscribe()
  }, [actorRef])

  // 「运行期间」保持唤醒（设置 → 常规）：run 开始/结束把活动信号发给 Rust
  // 的 keep-awake 线程。其它模式（关闭/始终）下该信号无效果。
  useEffect(() => {
    void setRunActive(isRunning).catch((e) =>
      console.error('[app-prefs] run 活动信号发送失败（保持唤醒可能未按预期工作）', e),
    )
  }, [isRunning])

  // 记录「上次打开的会话」（设置 → 常规 → 启动时恢复上次会话）。
  // 目录/登记表可能晚于 currentThreadId 就绪，故订阅 catalog 变化再试；
  // 写盘只在值变化时发生（cached 比对），避免每个会话切换都落一次文件。
  useEffect(() => {
    const persist = (): void => {
      if (!currentThreadId) return
      const entry = sessionCatalog.getState().entries[currentThreadId]
      const path = entry?.path
      if (typeof path !== 'string' || path.length === 0) return
      // 管道会话（Router / Bot Chat / Group 成员）不是用户的「上次会话」：
      // 记进去会让下次启动直接打开内部提示（2026-11-27 打包版实机）。
      if (isBotModePlumbingTitle(entry.piName)) return
      if (sameStoredSessionPath(cachedAppPrefs()?.lastSessionPath, path)) return
      void updateAppPrefs({ lastSessionPath: path }).catch((e) =>
        console.error('[app-prefs] 记录上次会话失败（启动恢复将使用旧路径）', e),
      )
    }
    persist()
    return sessionCatalog.subscribe(persist)
  }, [currentThreadId])

  // 派生标题（首条用户消息——侧栏/双行块/页签名同源的"自动命名"）：pi
  // 无名时前端即时显示，消息流变化即重算写入 catalog。
  const firstUserText = firstUserMessageText(messages)
  const derivedTitle = currentThreadId && firstUserText ? deriveTitle(firstUserText) : undefined
  useEffect(() => {
    if (!currentThreadId || !derivedTitle) return
    sessionCatalog.getState().setDerivedTitle(currentThreadId, derivedTitle)
    // 选择文件夹新建的会话不在 pi_list_sessions（会话根按 cwd 分裂），
    // 派生标题必须进登记表才能跨重启保住侧栏行名。
    workspaceSessionIndex.getState().setTitle(currentThreadId, derivedTitle)
  }, [currentThreadId, derivedTitle])

  const refreshThreads = useCallback(async () => {
    // 花名册先加载（会话显示名的降级判据要用 bot 名/显示名——旧
    // session.create 把档案名写进 pi name 的历史行按未命名显示）。
    if (botsStore.getState().bots.length === 0) botsStore.getState().load()
    // 项目注册表（侧栏 project 分组 / 行菜单归属标签的数据面）：只成功拉
    // 一次；失败置 projectsError（设置页可见、可手动重试），不自动循环重试。
    // includeDeleted=true：软删项目的名字仍要能解析（归属映射保留）。
    const before = sessionCatalog.getState()
    if (!before.projectsLoaded && before.projectsError === null) {
      try {
        await before.loadProjects(true)
      } catch (e) {
        console.error('[pi] 项目注册表读取失败（pi_projects_list）', e)
      }
    }
    // 双源并行：pi_list_sessions（旧形状，启动 cwd 的会话根，侧栏既有基线）
    // + pi_sessions_index（跨工作区/项目根，带 projectId 与诊断）。
    // 失败策略：索引失败 → 基线 + workspaceSessionIndex 补行照常（跨工作区
    // 会话暂不可见，错误 console 可见 + store.sessionsIndexError）；基线
    // 失败 → 用索引；两者都失败 → 保持现有列表不动（不把失败画成空态）。
    const [baseResult, indexResult] = await Promise.allSettled([
      invoke<PiSessionMeta[]>('pi_list_sessions'),
      invoke<SessionsIndexResult>('pi_sessions_index'),
    ])
    let index: SessionsIndexResult | null = null
    let indexError: string | null = null
    if (indexResult.status === 'fulfilled') {
      index = indexResult.value
    } else {
      indexError = String(indexResult.reason)
      console.error(
        '[pi] 跨根会话索引读取失败（pi_sessions_index）——跨工作区会话暂不可见',
        indexResult.reason,
      )
    }
    // 工作区 = 项目：首次刷新时把历史会话的 cwd 补登记到项目注册表，再
    // 重跑一次索引拿到 projectId（否则侧栏分组/项目页仍按「无项目」显示）。
    if (index !== null && !workspaceProjectsBackfilled) {
      workspaceProjectsBackfilled = true
      try {
        const created = await ensureWorkspaceProjects(index.sessions)
        if (created > 0) {
          await sessionCatalog.getState().loadProjects(true)
          index = await invoke<SessionsIndexResult>('pi_sessions_index')
          indexError = null
        }
      } catch (e) {
        console.error('[pi] 工作区项目补登记失败（项目页可能仍为空）', e)
      }
    }
    sessionCatalog.getState().applySessionIndex(index, indexError)
    if (baseResult.status === 'rejected') {
      console.error('[pi] 会话列表读取失败（pi_list_sessions）', baseResult.reason)
      if (index === null) return
    }
    const baseRows: ThreadListRow[] =
      baseResult.status === 'fulfilled'
        ? (baseResult.value ?? []).map((m) => ({
            status: 'regular' as const,
            id: m.id,
            title: m.name ?? undefined,
            // custom = SessionMeta 的前端投影面：path（打开/删除/导出）、
            // messageCount（未读水位）、lastModifiedMs（行龄）、cwd（工作区
            // 分组）、timestamp（created 排序）。
            custom: {
              path: m.path,
              messageCount: m.messageCount,
              lastModifiedMs: m.lastModifiedMs,
              cwd: m.cwd,
              timestamp: m.timestamp,
              // 基线 = 引擎活动环境自己的会话（跨环境聚合的标签；具名环境 =
              // 环境名，本体 = null——与 pi_sessions_index.profile 同形）。
              profile: profileStore.getState().profile,
            },
          }))
        : []
    // 选择文件夹建的会话在别的会话根里（pi_list_sessions 只扫启动目录）——
    // 登记表补行；活动登记会话的 messageCount 以 pi 真值回填（行尾"N 条
    // 消息"不长期停在 0）。这是 pi_sessions_index 就绪前的兜底面，索引
    // 成功时两边同一批会话由 mergeSessionRows 去重（索引覆盖同 id）。
    const activeId = currentThreadIdRef.current
    if (activeId && workspaceSessionIndex.getState().entries[activeId]) {
      try {
        const st = await invoke<{ messageCount?: unknown }>('pi_get_state')
        if (typeof st?.messageCount === 'number' && Number.isFinite(st.messageCount)) {
          workspaceSessionIndex
            .getState()
            .updateStats(activeId, st.messageCount, Date.now())
        }
      } catch (e) {
        // 行仍可见（登记表的旧统计），但错误必须可见——不冒充已刷新。
        console.error('[pi] 工作区会话状态读取失败（行统计保持登记值）', e)
      }
    }
    const withWorkspace = mergeWorkspaceSessionRows(
      baseRows,
      // 环境隔离：登记表按创建时的活动 profile 归属——具名环境只并入
      // 自己名下的跨工作区会话，本体环境只并入 profile 为空的旧记录。
      Object.values(workspaceSessionIndex.getState().entries).filter(
        (record) => (record.profile ?? null) === profileStore.getState().profile,
      ),
    )
    // 跨根合并：同 id 由索引覆盖（含 projectId/谱系），索引独有行追加。
    // custom 断言回 aui 的行形状（SessionCatalogRow.custom 是结构化子集，
    // 没有 string 索引签名；值本身仍是 JSON 对象，运行时同一份）。
    const rows: ThreadListRow[] = mergeSessionRows(withWorkspace, index?.sessions ?? []).map(
      (row) => ({
        status: 'regular' as const,
        id: row.id,
        ...(row.title === undefined ? {} : { title: row.title }),
        ...(row.custom === undefined
          ? {}
          : { custom: row.custom as Record<string, unknown> }),
      }),
    )
    // 单一真相源灌入：未读播种已并入 ingest（hermes ingestRows 语义）；
    // 侧栏 threads（assistant-ui）title 用统一显示名。会话真名保持 pi 原值
    // ——Bot Chat / 档案名污染由 sessionDisplayName 统一降级（2026-11-25
    // 用户："切换 bot 后会话名显示的是 bot 的名字"；此前的显示名覆写会把
    // bot 名当 piName 灌回 catalog，见 session-catalog 的降级判据注释）。
    sessionCatalog.getState().ingest(rows, currentThreadIdRef.current)
    setThreads(
      rows.map((r) => ({
        ...r,
        title: sessionDisplayName(sessionCatalog.getState().entries[r.id]),
      })),
    )
  }, [])

  /**
   * 启动清扫：0 消息的 `Bot Chat` 管道会话（历史铸造/点击 bot 但从未发言）
   * 不留在磁盘上（2026-11-26 用户："没有消息的会话不要落盘啊"）。只清
   * **0 消息 + 名字恰为 Bot Chat** 的行；有内容/正在看的/其它名字一律不动。
   * 进程内只跑一次（跨重启执行）。
   */
  const sweepEmptyBotChats = useCallback(async (): Promise<void> => {
    if (emptyBotChatSwept) return
    emptyBotChatSwept = true
    try {
      const index = await invoke<{
        sessions?: { id: string; messageCount?: number; name?: string; path: string }[]
      }>('pi_sessions_index')
      const active = currentThreadIdRef.current
      let liveId: string | null = null
      try {
        liveId = (await invoke<{ sessionId?: null | string }>('pi_get_state')).sessionId ?? null
      } catch {
        /* 无 live 会话 */
      }
      const victims = (index.sessions ?? []).filter(
        (s) =>
          (s.messageCount ?? 0) === 0 &&
          (s.name ?? '') === 'Bot Chat' &&
          s.id !== active &&
          s.id !== liveId,
      )
      for (const victim of victims) {
        try {
          await invoke('pi_delete_session', { path: victim.path })
          for (const bot of botsStore.getState().bots) {
            if (bot.chatSessionId === victim.id) {
              botsStore.getState().patchMeta(bot.name, {
                chatSessionId: null,
                chatSessionPath: null,
              })
            }
          }
        } catch (e) {
          console.error(`[pi] 清理 0 消息 Bot Chat 失败（${victim.path}）`, e)
        }
      }
      if (victims.length > 0) {
        console.info(`[pi] 已清理 ${victims.length} 条 0 消息 Bot Chat（不落盘规则）`)
      }
    } catch (e) {
      console.error('[pi] 0 消息 Bot Chat 清扫失败', e)
    }
  }, [])


  // ── 启动链（端点发现 + 环境/目录/上次会话恢复）──
  // 多会话并存（2026-11-28）：SSE 订阅移到**焦点效果**（下方）——每个会话
  // 一条流，thread = `main:<id>`（与 POST 事件路由键同源）；切换会话 =
  // 换订焦点流，从焦点 actor 的 lastEventId 续放（在跑 run 的增量不丢，
  // 切换永不打断）。
  // EventSource 断线时浏览器自动带 Last-Event-ID 重连 = 免费续放。
  // dropped 相（浏览器放弃自动重连）的手动 Reconnect：connectionBridge
  // requestReconnect 递增 reconnectSeq → 两个 effect 都重跑（幂等）。
  const reconnectSeq = useStore(connectionBridge, (s) => s.reconnectSeq)
  // 启动页「重试」序号：启动失败后用户点重试 → 本 effect 重跑端点发现链。
  const bootRetrySeq = useStore(bootBridge, (s) => s.retrySeq)
  useEffect(() => {
    let cancelled = false
    void (async () => {
      bootBridge.getState().setBooting()
      // 端点发现带自动重试（2026-11-25 启动页全链路）：Rust setup 里引擎是
      // 异步起步的，WebView 首帧可能早于 `agui endpoint ready`——旧实现一次
      // invoke 失败就只 console.error，SSE 永不连接（聊天假死）。这里在
      // 20s 窗口内退避重试；耗尽才把失败交给启动页（可重试）。
      let ep: { port: number; token: string } | null = null
      let endpointError: unknown = null
      for (let attempt = 0; attempt < 40 && !cancelled && ep === null; attempt++) {
        try {
          ep = await invoke<{ port: number; token: string }>('get_agui_endpoint')
        } catch (e) {
          endpointError = e
          await new Promise((resolve) =>
            window.setTimeout(resolve, attempt < 5 ? 300 : 700),
          )
        }
      }
      if (cancelled) return
      if (ep === null) {
        console.error('[agui] endpoint 获取失败（自动重试耗尽）', endpointError)
        bootBridge
          .getState()
          .setFailed(
            endpointError instanceof Error ? endpointError.message : String(endpointError),
          )
        return
      }
      try {
        setEndpoint(ep)
        // 挂载水合（§7-4 多会话）：历史真相在 pi；**事件流的订阅在焦点效果**
        // （下方）——thread = 焦点会话键 `main:<id>`，游标 = 焦点 actor 的
        // lastEventId。多会话并存：每会话独立缓冲（引擎按会话路由），SSE
        // 按 Key 续放；会话内的 Last-Event-ID 断线重连照常免费续放。
        // 会话列表 + 当前线程 id（threadId 与 pi sessionId 同源）。
        // 环境隔离（hermes profile 对偶）：先把上次活动环境应用到引擎，再
        // 首刷目录——否则具名环境的会话（独立 home/sessions）一条都列不到。
        try {
          const applied = await invoke<null | string>('pi_profile_set_active', {
            profile: profileStore.getState().profile,
          })
          setActiveProfileLocal(applied ?? null)
        } catch (e) {
          console.error('[profile] 启动环境恢复失败——按本体环境列出会话', e)
          // UI 真相跟随引擎：按钮/菜单口径与列表同源，不装作已切过去。
          setActiveProfileLocal(null)
        }
        if (cancelled) return
        await refreshThreads()
        if (cancelled) return
        void sweepEmptyBotChats()
        try {
          let st: { sessionId: string | null } | null = null
          try {
            st = await invoke<{ sessionId: string | null }>('pi_get_state')
          } catch (e) {
            // 区分"正常无会话"（pi_get_state 报 no active session——首启预期
            // 域状态：threadId 置空 = ThreadList 高亮 New Chat）与真错误
            // （mutex 中毒/pi 内部错误）：真错误交给外层 catch 可见，不伪装
            // "无会话"（禁止兜底）。
            if (!String(e).includes('no active session')) throw e
          }
          if (cancelled) return
          // 冷启动恢复（设置 → 常规 → 启动时恢复上次会话）：**仅当引擎当前
          // 没有活动会话时**才恢复——页面 reload / HMR 时 live 会话优先，
          // 不能被上次记录覆盖。打开失败保持空态，错误必须可见。
          if (!st?.sessionId) {
            try {
              const prefs = await loadAppPrefs()
              if (cancelled) return
              if (prefs.restoreLastSession && prefs.lastSessionPath) {
                // 上次记录若是管道会话（Router: / Bot Chat / Group:），不是
                // 用户的阅读现场：清掉记录并停在 New Chat（2026-11-27 实机：
                // 打包版启动打开了 Router 的内部英文提示）。
                const lastPath = prefs.lastSessionPath
                const plumbing = Object.values(sessionCatalog.getState().entries).find(
                  (entry) =>
                    sameStoredSessionPath(entry.path, lastPath) &&
                    isBotModePlumbingTitle(entry.piName),
                )
                if (plumbing) {
                  void updateAppPrefs({ lastSessionPath: null }).catch((err) =>
                    console.error('[app-prefs] 清理管道会话的上次会话记录失败', err),
                  )
                } else {
                  // 大会话秒开：先读文件尾把尾部画出来（不依赖引擎），
                  // 引擎 open 在后台继续；下方统一的水合会在引擎就绪后对齐。
                  // 画到**该会话自己的 actor**（多会话并存：注册表按键持有）。
                  const peek = await peekTranscriptTail(lastPath)
                  if (cancelled) return
                  if (peek) {
                    const peekKey = sessionThreadKey(peek.sessionId)
                    applyTranscriptPeek(getOrCreateActor(peekKey, peekKey), peek, peek.sessionId)
                    setCurrentThreadId(peek.sessionId)
                    mainViewStore.getState().showChat()
                  }
                  const restoreOpen = invoke('pi_open_session', {
                    path: lastPath,
                  }).then(() => undefined)
                  pendingOpenRef.current = restoreOpen
                  setEngineAttaching(true)
                  try {
                    await restoreOpen
                  } finally {
                    // 失败也必须撤掉「正在准备会话」——否则红条/错误之后提示
                    // 永远停在 composer 上方（2026-11-26 用户："引擎还在准备
                    // 中这是为什么"）。
                    setEngineAttaching(false)
                  }
                  if (cancelled) return
                  st = await invoke<{ sessionId: string | null }>('pi_get_state')
                }
              }
            } catch (e) {
              const message = e instanceof Error ? e.message : String(e)
              console.error(
                '[runtime] 恢复上次会话失败（文件被删 / 锁冲突？）——保持新会话空态',
                e,
              )
              // 启动恢复失败必须可见（规矩 12：不静默降级）。文件已不存在
              // 时清掉记录，避免每次启动重复对同一个已删文件报错；锁冲突等
              // 瞬时错误保留记录，下次启动还可以恢复。
              errorBridge.getState().setError(`恢复上次会话失败：${message}`, false)
              if (/os error 2|找不到指定的文件|not found|no such file/i.test(message)) {
                void updateAppPrefs({ lastSessionPath: null }).catch((err) =>
                  console.error('[app-prefs] 清理失效的上次会话记录失败', err),
                )
              }
            }
          }
          if (st?.sessionId) {
            const restoreKey = sessionThreadKey(st.sessionId)
            const restoreActor = getOrCreateActor(restoreKey, restoreKey)
            // 首屏只拉分支尾部一页（hermes tail hydration），「显示更早」按需补页
            // **水合 + SEEK 先于 setCurrentThreadId**：焦点效果据此从正确的
            // 游标开流（顺序反了会先从 0 开流，与文件水合竞态）。
            await hydrateTranscriptTail(restoreActor, st.sessionId)
            // 多会话并存：文件水合后把游标拨到该会话缓冲的当前头（缓冲里的
            // 历史已由文件覆盖，只收之后的增量）——焦点效果的 SSE 从这里续放。
            try {
              const cursor = await invoke<number>('pi_stream_cursor', {
                thread: restoreKey,
              })
              restoreActor.send({ type: 'SEEK', id: cursor })
              hydratedKeys.add(restoreKey)
            } catch (e) {
              console.error('[pi] 流游标获取失败（不 seek，直接续放）', e)
            }
            setCurrentThreadId(st.sessionId)
            // 滚动位置恢复请求（挂载水合成功路径）：视口（thread.aui 侧）
            // 消费后按持久化位置恢复阅读位
            threadScrollBridge.getState().requestRestore(st.sessionId)
            // 时间线标记（模型切换/压缩分隔线）：与消息同源、同索引，水合
            // 后必须一起重拉——否则刷新页面后分隔线整批消失。
            void timelineMarkerBridge.getState().refresh(st.sessionId)
          } else {
            // 无恢复会话（New Chat 启动）没有 ES onopen 信号：启动页在这里
            // 退场（端点 + 目录都就绪 = 引擎可用；恢复会话的 ready 由焦点流
            // onopen 补）。
            bootBridge.getState().setReady()
          }
        } catch (e) {
          // 真错误（pi_get_state 非"无会话"失败 / 水合失败）：保持当前状态并
          // console 可见，不伪装成功。泄漏路径的 es 由 cleanup close。
          console.error('[runtime] hydrate 失败', e)
        }
        // 审批挂起列表（§4.4 挂载拉取）
        approvalBridge
          .getState()
          .refresh()
          .catch((err) => console.error('[pi] 审批列表拉取失败', err))
      } catch (e) {
        // 端点已发现、后续水合/列表失败：可见但不谎报启动失败（引擎可用，
        // 只是首屏数据没齐）——启动页由 SSE onopen 决定退场。
        console.error('[agui] 启动水合失败', e)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [
    refreshThreads,
    hydrateTranscriptTail,
    reconnectSeq,
    bootRetrySeq,
    sweepEmptyBotChats,
  ])

  // ── 焦点流（per-session SSE，多会话并存）──────────────────────────────
  // thread = 焦点会话键 `main:<id>`（与 POST 事件路由键同源）；游标 = 焦点
  // actor 的 lastEventId——切走期间该会话缓冲里累积的增量在重订时整段续放
  // （在跑 run 不因切换中断，切回来接着看）。New Chat 哨兵键上没有引擎事
  // 件（首条消息前 runtime 先 pi_ensure_main_session 拿真 id），不订阅。
  const focusedThreadKeyForStream = sessionThreadKey(currentThreadId)
  useEffect(() => {
    if (!endpoint) return
    if (focusedThreadKeyForStream === NEW_CHAT_THREAD_KEY) {
      // New Chat 草稿态：没有会话流可订（引擎事件都落真会话键）；引擎可用
      // 性由启动链保证，连接态置 online（无流可断）。
      connectionBridge.getState().setConnected(true)
      bootBridge.getState().setReady()
      return
    }
    let es: EventSource | null = null
    let cancelled = false
    const streamActor = getOrCreateActor(focusedThreadKeyForStream, focusedThreadKeyForStream)
    void (async () => {
      try {
        const cursor = streamActor.getSnapshot().context.lastEventId
        let url = `http://127.0.0.1:${endpoint.port}/ag-ui/stream?thread=${encodeURIComponent(focusedThreadKeyForStream)}&token=${encodeURIComponent(endpoint.token)}`
        if (cursor > 0) url += `&lastEventId=${cursor}`
        if (cancelled) return
        es = new EventSource(url)
        es.onmessage = (e: MessageEvent) => {
          try {
            const parsed = JSON.parse(e.data)
            // 审批/ask 请求进流（§4.4）：卡片详情以 Rust 注册表为真相，经
            // IPC 拉取挂起列表（重放流不会造成卡片重复）。
            if (parsed?.type === 'CUSTOM' && parsed?.name === 'extension_ui_request') {
              approvalBridge
                .getState()
                .refresh()
                .catch((err) => console.error('[pi] 审批列表拉取失败', err))
            }
            if (parsed?.type === 'CUSTOM' && parsed?.name === 'ask_request') {
              askBridge
                .getState()
                .refresh()
                .catch((err) => console.error('[pi] 问题列表拉取失败', err))
            }
            // 活动面板 sidecar（todo / agent roster / jobs）：tool_execution
            // 的 details.schema 分派到对应 store。纯桥读取，不改消息段。
            if (parsed?.type === 'CUSTOM' && parsed?.name === 'tool_execution') {
              dispatchToolDetails(parsed.name, parsed.value)
            }
            // 事件喂**本流所属会话**的 actor（键在闭包里——切走后旧流的尾
            // 事件也落旧会话的投影，不串台）。
            streamActor.send({
              type: 'AGUI_EVENT',
              event: parsed as { type: string } & Record<string, unknown>,
              id: Number(e.lastEventId || 0),
            })
          } catch (err) {
            console.error('[agui] 事件解析失败', err)
          }
        }
        es.onopen = () => {
          connectionBridge.getState().setConnected(true)
          // 启动页就绪信号：事件流首连成功 = 引擎真的可用了（端点成功只
          // 说明 HTTP 面在，SSE 打开才代表 run 事件链就绪）。
          bootBridge.getState().setReady()
        }
        es.onerror = (e) => {
          console.error('[agui] SSE 连接错误', e)
          // readyState：CONNECTING = 自动重试中；CLOSED = 浏览器放弃（dropped）
          const source = e.target as EventSource
          connectionBridge.getState().setDisconnected(source.readyState === EventSource.CLOSED)
        }
      } catch (e) {
        console.error('[agui] 焦点流连接失败', e)
      }
    })()
    return () => {
      cancelled = true
      es?.close()
    }
  }, [focusedThreadKeyForStream, endpoint, reconnectSeq])

  /** 自动会话命名（规则段，hermes title_generator 两段式的即时段）：
   * POST 成功后对「默认态名」（pi SessionIndex 的 name 为 null/空 = 用户
   * 未命名）的会话，从首条 user 消息派生标题（deriveTitle——首个非空行、
   * 词边界截 48 字符+…），撞名走谱系编号追加 #N（nextTitleInLineage——
   * 既有最大号+1），pi_rename_session 落名后刷新线程列表。受
   * titling.auto_title 配置门约束（isAutoTitleEnabled）；每会话只尝试
   * 一次（autoNamedSessions 内存 Set，含失败——失败可见不重试）；LLM
   * 总结升级段不做（无凭据面）。全程独立 try/catch：命名失败不影响
   * 消息发送/run 流。 */
  const maybeAutoNameSession = useCallback(async () => {
    let sessionId: string | null
    try {
      sessionId = (await invoke<{ sessionId: string | null }>('pi_get_state')).sessionId
    } catch (e) {
      console.error('[pi] 自动命名：pi_get_state 失败——跳过', e)
      return
    }
    if (!sessionId) {
      console.error('[pi] 自动命名：POST 成功但无活动会话（域异常）——跳过')
      return
    }
    if (autoNamedSessions.has(sessionId)) return
    // 配置门（titling.auto_title）：显式 false = 用户关掉自动命名——
    // 不占命名名额（同一 run 内改回 true，下次 POST 即恢复触发）；
    // settings 读取失败 = 错误可见并跳过本次（同样不占名额）。
    try {
      if (!(await isAutoTitleEnabled())) return
    } catch (e) {
      console.error('[pi] 自动命名：pi_get_settings 读取失败——跳过', e)
      return
    }
    // 先占位再执行：并发 POST 不得重复触发同一会话的命名
    autoNamedSessions.add(sessionId)
    try {
      const metas = await invoke<PiSessionMeta[]>('pi_list_sessions')
      const self = (metas ?? []).find((m) => m.id === sessionId)
      if (!self) {
        console.error('[pi] 自动命名：会话不在索引中——跳过', sessionId)
        return
      }
      // 默认态判定：已有自定义名（用户命名/历史命名）→ 不动
      if (self.name) return
      // 历史被尾页截断时 store 里只有尾部消息——从尾部首条 user 派生标题
      // 会给出错误标题（不是会话开头那句话）。宁可留默认名，不造假。
      if (transcriptTailStore.getState().hasMore && transcriptTailStore.getState().sessionId === sessionId) {
        console.info('[pi] 自动命名：历史未全量水合（尾页模式）——跳过，可手动重命名')
        return
      }
      const firstUser = firstUserMessageText(actorRef.getSnapshot().context.messages)
      if (!firstUser) {
        console.error('[pi] 自动命名：没有可派生文本的首条 user 消息——跳过', sessionId)
        return
      }
      const derived = deriveTitle(firstUser)
      if (!derived) {
        console.error('[pi] 自动命名：首行派生标题为空——跳过', sessionId)
        return
      }
      // 谱系编号：与其它会话撞名时追加 #N（N = 既有最大号+1）
      const others = (metas ?? [])
        .filter((m) => m.id !== sessionId && m.name)
        .map((m) => m.name!)
      const title = nextTitleInLineage(derived, others)
      await invoke('pi_rename_session', { name: title })
      await refreshThreads()
    } catch (e) {
      console.error('[pi] 自动命名失败（会话保持默认名，可手动重命名）', e)
    }
  }, [actorRef, refreshThreads])

  const postRun = useCallback((message: string, images?: PiImagePayload[]) => {
    const ep = endpointRef.current
    if (!ep) return
    void (async () => {
      // peek-first 打开期间发送：先等引擎打开完成（打开失败在切换路径
      // 已可见；这里照常走 POST，让错误收敛到同一条可见路径）。
      if (pendingOpenRef.current) {
        try {
          await pendingOpenRef.current
        } catch {
          /* 已由切换路径报错 */
        }
      }
      const res = await fetch(
        `http://127.0.0.1:${ep.port}/ag-ui?token=${encodeURIComponent(ep.token)}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          // 契约：{threadId, message, images?: [{data: 纯base64, mimeType}]}；
          // 无图片不带 images 键。**threadId = 本会话的路由键**
          // `main:<id>`（多会话并存：引擎把本 run 的事件路由到该会话专属
          // 缓冲——与 SSE 订阅键同源，切换会话互不串台）。
          body: JSON.stringify({
            threadId: sessionThreadKey(currentThreadIdRef.current),
            message,
            // v7.4 双对话分栏：会话分栏发送会把引擎切到它自己的会话——工作区
            // 的每次发送都带上自己会话的 path，引擎切回工作区会话再跑（缺
            // path = 尚未落盘的新会话，ensure 按需创建不变）
            ...(sessionCatalog.getState().entries[currentThreadIdRef.current ?? '']?.path
              ? { sessionPath: sessionCatalog.getState().entries[currentThreadIdRef.current ?? '']!.path }
              : {}),
            ...(images && images.length > 0 ? { images } : {}),
          }),
        },
      )
      // 错误即错误：非 2xx 不装作已发送——状态码 + 服务端错误原文可见
      // （引擎 500 带 {error: 原文}；413 是图片链路的典型失败）。
      if (!res.ok) {
        let detail = `POST /ag-ui 返回 ${res.status}`
        try {
          const body = (await res.json()) as { error?: unknown }
          if (typeof body?.error === 'string' && body.error.trim()) {
            detail = `${detail}：${body.error.trim()}`
          }
        } catch {
          /* 响应体非 JSON——保留状态码文案 */
        }
        const msg =
          res.status === 413
            ? '消息发送失败：请求体过大（HTTP 413）——图片/附件总大小超过服务端上限'
            : `消息发送失败：${detail}`
        errorBridge.getState().setError(msg, false)
        throw new Error(msg)
      }
      // POST 成功即触发自动命名（maybeAutoNameSession 内部全 try/catch，
      // 不向外抛——外层 catch 仍只服务 POST 本身的失败）。同时清掉上一次
      // 发送失败的本地错误（新 run 已上路，旧错误条不该继续挂着）。
      errorBridge.getState().setError(null)
      await maybeAutoNameSession()
    })().catch((e) => {
      console.error('[agui] POST 失败', e)
      // 网络层失败（fetch 直接 reject）也要可见——错误条是用户唯一的
      // 反馈面（乐观消息已经进投影，不能让用户以为消息在跑）。
      if (!errorBridge.getState().error) {
        errorBridge.getState().setError(
          `消息发送失败：${e instanceof Error ? e.message : String(e)}`,
          false,
          )
        }
      })
  }, [maybeAutoNameSession])

  /** 最后一条 user 消息（TurnMessage 形）——onReload 重发文本的来源 */
  const lastUserMessage = useCallback((): TurnMessage | null => {
    const msgs = actorRef.getSnapshot().context.messages
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i]!.role === 'user') return msgs[i]!
    }
    return null
  }, [actorRef])

  // ── 会话预览请求桥（peek-first 通用入口）─────────────────────────────
  // runtime 之外的调用方（bots-pane 打开既有 bot 会话）投递请求：先尾读
  // 预览把会话画出来，真正的 pi_open_session 由调用方继续（完成后
  // reconnect 效果统一走 hydrateTranscriptTail 对齐）。
  const sessionPreviewRequest = useStore(sessionPreviewBridge, (s) => s.request)
  useEffect(() => {
    if (!sessionPreviewRequest) return
    const { seq, path, sessionId } = sessionPreviewRequest
    sessionPreviewBridge.getState().clear(seq)
    // 已是当前会话 / 引擎已完成该会话水合 → 无需预览
    if (currentThreadIdRef.current === sessionId) return
    if (
      transcriptTailStore.getState().sessionId === sessionId &&
      transcriptTailStore.getState().oldestEntryId !== null
    ) {
      return
    }
    const priorActive = sessionCatalog.getState().activeId
    void (async () => {
      const peek = await peekTranscriptTail(path)
      if (!peek) return
      // 身份守卫：header id 与双锚不符（文件被换）→ 不预览
      if (peek.sessionId && peek.sessionId !== sessionId) return
      // 等待期间用户已切走（activeId 被别的流程改写）→ 不抢
      if (sessionCatalog.getState().activeId !== priorActive) return
      sessionCatalog.getState().setActive(sessionId)
      setCurrentThreadId(sessionId)
      mainViewStore.getState().showChat()
      // 预览画到**目标会话自己的 actor**（多会话并存：键按会话隔离）
      applyTranscriptPeek(getOrCreateActor(sessionThreadKey(sessionId), sessionThreadKey(sessionId)), peek, sessionId)
      threadScrollBridge.getState().requestRestore(sessionId)
    })()
  }, [sessionPreviewRequest])

  /** run 进行中先中断（照抄 switchToThread 守卫）：prompt 持锁跨整个 run，
   * 不先 pi_interrupt 重发会撞锁失败；中断失败返回 false，调用方不动状态 */
  const interruptIfRunning = useCallback(async (): Promise<boolean> => {
    if (!actorRef.getSnapshot().matches('streaming')) return true
    try {
      await invoke('pi_interrupt')
      console.info('[pi] run 进行中：已中断当前 run 后继续（prompt 持锁跨整个 run）')
      return true
    } catch (e) {
      console.error('[pi] 中断当前 run 失败——取消本次操作', e)
      return false
    }
  }, [actorRef])

  // ── 分支桥请求执行器（fork / 兄弟分支切换）──────────────────────────
  // UI（thread.aui）经 branch-store 投递请求，这里订阅串行执行——fork/switch
  // 都要动活动会话（重水合走 actorRef + hydratePiMessages，currentThreadId/
  // 线程列表只在 runtime 手里）。branchBusy 串行锁：进行中收到新请求
  // drop + console.error（可见，不排队装作已受理）；handledBranchSeq 防
  // StrictMode 双 effect 对同一请求重复执行。

  /** 会话更换（切换 / New Chat / fork / 回父会话 / 删除当前 / 回退）成功后
   * 清会话域桥投影：排队消息属于原会话轨迹（clear）、检查点投影与
   * currentId 同属会话（resetProjection）、成本显示切到新会话（lastRun
   * 清；累计按 sessionId 键隔离保留）。时间线标记（模型切换/压缩分隔线）
   * 同属会话域——重拉该会话的条目投影。 */
  const resetSessionScopedBridges = useCallback((sessionId: string | null) => {
    // 排队消息**不再 clear**（多会话并存：排队意图按会话分桶持久化，切换
    // 会话 = 各归各键，切回继续按序发出——2026-11-28 用户："排队消息切换
    // 会话后都没了"）。会话删除时经 clearSession 单点清理。
    checkpointBridge.getState().resetProjection()
    costBridge.getState().resetSession(sessionId)
    void timelineMarkerBridge.getState().refresh(sessionId)
  }, [])

  /**
   * 「没有消息的会话不要落盘」（2026-11-26 用户）。
   *
   * 离开一个**从未发过消息**的会话（典型：点 bot 行刚铸出来还没说话的
   * canonical Bot Chat、空的工作区会话）时，把它的文件删掉并清掉指向它的
   * bot 双锚——不留 0 消息空壳。判据以引擎 `pi_get_state.messageCount`
   * 为准（当前 live 会话才可信）；有消息 / 无法确认一律不动。
   *
   * 只在“离开当前会话”的入口调用（切会话 / New Chat / 切环境）；打开中的
   * 空会话不会凭空消失。
   */
  const pruneEmptyCurrentSession = useCallback(
    async (sessionId: string | null): Promise<void> => {
      if (!sessionId) return
      let path: string | undefined
      let count: number | undefined
      try {
        const st = await invoke<{ messageCount?: unknown; sessionId?: null | string }>(
          'pi_get_state',
        )
        if (st?.sessionId !== sessionId) return
        if (typeof st.messageCount !== 'number' || st.messageCount !== 0) return
        count = st.messageCount
        path = sessionCatalog.getState().entries[sessionId]?.path
      } catch (e) {
        console.error('[pi] 读取空会话状态失败——不清理（避免误删有内容的会话）', e)
        return
      }
      if (count !== 0) return
      try {
        await invoke('pi_discard_session')
      } catch (e) {
        console.error('[pi] 丢弃空会话失败——保留文件', e)
        return
      }
      if (typeof path === 'string' && path.length > 0) {
        try {
          await invoke('pi_delete_session', { path })
        } catch (e) {
          console.error('[pi] 删除空会话文件失败（文件保留）', e)
          return
        }
      }
      workspaceSessionIndex.getState().remove(sessionId)
      clearThreadScroll(sessionId)
      // 删掉的会话若是「上次打开的会话」，清记录——否则下次启动恢复它
      // 会报文件不存在（错误循环）。
      if (path && sameStoredSessionPath(cachedAppPrefs()?.lastSessionPath, path)) {
        void updateAppPrefs({ lastSessionPath: null }).catch((e) =>
          console.error('[app-prefs] 清理已删空会话的 lastSessionPath 失败', e),
        )
      }
      // 双锚指向已删会话 = 悬空身份：清掉，下次点击重新铸造并记新锚。
      for (const bot of botsStore.getState().bots) {
        if (bot.chatSessionId === sessionId) {
          botsStore.getState().patchMeta(bot.name, {
            chatSessionId: null,
            chatSessionPath: null,
          })
        }
      }
    },
    [],
  )

  /**
   * 首个消息发送时把「待落点草稿」落成真会话（2026-11-26 用户：
   * "没有消息的会话不要落盘"——选择工作区文件夹只进入草稿态，不再
   * 立即 `pi_new_session`）。返回新会话 id；无 pendingCwd（普通 New Chat）
   * 返回 null（由 agui ensure 按当前环境懒创建，既有路径不变）。
   */
  const ensureDraftSession = useCallback(async (): Promise<string | null> => {
    if (currentThreadIdRef.current) return currentThreadIdRef.current
    const pendingCwd = sessionCatalog.getState().pendingCwd
    const pendingBot = pendingBotChatStore.getState().pending
    if (!pendingCwd && !pendingBot) {
      // 普通 New Chat 首发（多会话并存 2026-11-28）：**显式建会话**——
      // pi_ensure_main_session 引擎上台 + pi 分配 session id；拿到 id 后
      // 事件路由键 `main:<id>` 从第一条消息就正确（不再依赖懒创建后的
      // 收养补偿）。
      try {
        const ensured = await invoke<{ id: string; path: string | null }>(
          'pi_ensure_main_session',
        )
        if (!ensured?.id) throw new Error('pi 没有返回新会话 id')
        const now = Date.now()
        workspaceSessionIndex.getState().register({
          id: ensured.id,
          cwd: '',
          ...(ensured.path ? { path: ensured.path } : {}),
          profile: profileStore.getState().profile,
          messageCount: 0,
          createdAtMs: now,
          lastModifiedMs: now,
        })
        setCurrentThreadId(ensured.id)
        sessionCatalog.getState().setActive(ensured.id)
        await refreshThreads()
        return ensured.id
      } catch (e) {
        throw new MessageNotSentError(
          `新会话创建失败：${e instanceof Error ? e.message : String(e)}`,
        )
      }
    }
    try {
      let sessionId: string
      let createdPath: string | null = null
      let draftCwd: string | null = pendingCwd
      if (pendingBot) {
        // bot 草稿（host.newChat 的 bots 路径）：第一条消息才建会话，
        // SOUL/模型/工具集由 createBotDraftSession 施加；cwd = 用户选的
        // 文件夹优先，否则 bot.cwd / 引擎默认。
        const { createBotDraftSession } = await import('@/sdk/host-rpc')
        const created = await createBotDraftSession(pendingBot.profile, pendingCwd)
        sessionId = created.stored_session_id
        createdPath = created.path ?? null
        draftCwd = created.cwd ?? pendingCwd
        pendingBotChatStore.getState().set(null)
      } else {
        await invoke('pi_new_session', { cwd: pendingCwd })
        const st = await invoke<{ messageCount?: unknown; sessionId?: null | string }>(
          'pi_get_state',
        )
        if (typeof st?.sessionId !== 'string' || st.sessionId.length === 0) {
          throw new Error('pi 没有返回新会话 id')
        }
        sessionId = st.sessionId
      }
      let resolution: SessionPathResolution = { root: '', path: null, reason: '未定位' }
      if (createdPath) {
        resolution = { root: '', path: createdPath, reason: '宿主创建回传' }
      } else {
        try {
          const sessions = await invoke<{ id: string; path: string }[]>('pi_list_sessions')
          const hit = (sessions ?? []).find((s) => s.id === sessionId)
          resolution = hit
            ? { root: '', path: hit.path }
            : await resolveSessionPath(draftCwd ?? '', sessionId)
        } catch (e) {
          console.error(`[pi] 工作区会话文件定位失败（${draftCwd ?? ''} / ${sessionId}）`, e)
        }
      }
      const now = Date.now()
      workspaceSessionIndex.getState().register({
        id: sessionId,
        cwd: draftCwd ?? '',
        ...(resolution.path ? { path: resolution.path } : {}),
        profile: profileStore.getState().profile,
        messageCount: 0,
        createdAtMs: now,
        lastModifiedMs: now,
      })
      sessionCatalog.getState().setPendingCwd(null)
      setCurrentThreadId(sessionId)
      sessionCatalog.getState().setActive(sessionId)
      await refreshThreads()
      resetSessionScopedBridges(sessionId)
      branchBridge.getState().requestRefresh()
      return sessionId
    } catch (e) {
      // 让 assistant-ui 把草稿/附件回填（MessageNotSentError 语义）
      throw new MessageNotSentError(
        `在所选工作区创建会话失败：${e instanceof Error ? e.message : String(e)}`,
      )
    }
  }, [refreshThreads, resetSessionScopedBridges])

  /** 离开当前前台会话 → New Chat 草稿（不切环境）。切环境与 host.newChat
   *  的 bot 草稿共用同一条拆除链。 */
  const teardownToNewChat = useCallback(async (): Promise<void> => {
    const leavingEmpty = currentThreadIdRef.current
    try {
      // **不打断在跑 run**（多会话并存 2026-11-28）：pi_discard_session 把
      // 活动柄退入 retired（run 在后台继续，事件落自己的桶）；New Chat =
      // 焦点换到哨兵 actor，旧会话原样保留。
      // 空会话（bot 行刚铸出来还没说话）不留在磁盘上
      await pruneEmptyCurrentSession(leavingEmpty)
      await invoke('pi_discard_session')
    } catch (e) {
      // 会话拆除失败不阻断落点切换（环境/草稿真相已定），但必须可见。
      console.error('[profile] 离开当前会话失败（侧栏仍会按新落点重扫）', e)
    }
    // New Chat 草稿 = 全新哨兵 actor（旧会话投影留在注册表里，切回即恢复）
    dropActor(NEW_CHAT_THREAD_KEY)
    resetTranscriptTail()
    setCurrentThreadId(null)
    sessionCatalog.getState().setActive(null)
    sessionCatalog.getState().setPendingCwd(null)
    resetSessionScopedBridges(null)
    try {
      await refreshThreads()
    } catch (e) {
      console.error('[profile] 落点切换后会话目录刷新失败（侧栏保持旧列表）', e)
    }
    branchBridge.getState().requestRefresh()
  }, [pruneEmptyCurrentSession, refreshThreads, resetSessionScopedBridges])

  /** 切换活动环境（hermes Desktop「配置档案」选择的对偶；2026-11-22）。
   *
   *  引擎侧 `pi_profile_set_active` 只改活动 home/会话根；「离开当前会话、
   *  按新环境重扫目录」属于 UI 面，在这里做：停掉在途 run（prompt 持锁）
   *  → 丢活动会话柄（flush 落盘，不删文件）→ 轮次机 RESET → 侧栏与
   *  会话域桥重扫。重复选择当前环境 = 无操作（hermes selectProfile
   *  同语义：re-tap 不打断正在看的会话）。失败向上返回 false。 */
  const switchProfile = useCallback(
    async (profile: null | string): Promise<boolean> => {
      const target = profile === '' ? null : (profile ?? null)
      if (profileStore.getState().profile === target) return true
      try {
        const applied = await invoke<null | string>('pi_profile_set_active', { profile: target })
        setActiveProfileLocal(applied ?? null)
      } catch (e) {
        console.error('[profile] 环境切换失败——保持原环境', e)
        return false
      }
      // hermes `selectProfile`：切档案（或从"全部配置档案"浏览态回来）一律
      // **退出聚合视图**——侧栏回到「只看当前环境」（$showAllProfiles=false
      // 的对偶）。复位放这里，任何切换入口（设置页/菜单/插件）都走同一条。
      sidebarViewStore.getState().setShowAllProfiles(false)
      // 显式切环境 = 作废上一份 bot 新聊天草稿归属。
      pendingBotChatStore.getState().set(null)
      await teardownToNewChat()
      return true
    },
    [teardownToNewChat],
  )

  /** host.newChat 的 bot 草稿入口：丢当前会话但不改活动环境。 */
  const requestNewChatDraft = useCallback(async (): Promise<boolean> => {
    await teardownToNewChat()
    return true
  }, [teardownToNewChat])

  useEffect(() => {
    setProfileSwitcher(switchProfile)
    setNewChatDraftRequester(requestNewChatDraft)
    return () => {
      setProfileSwitcher(null)
      setNewChatDraftRequester(null)
    }
  }, [switchProfile, requestNewChatDraft])

  // bots 插件关闭 = 回到本体 Mirach 环境（用户 2026-11-26："bots关闭后不是
  // 要回到默认的mirach配置吗？"）。插件关掉后具名环境没有管理面了，留在
  // 具名 home 会让新建会话继续落一个看不见的 bot 配置；这里走正式环境
  // 切换（discard 当前会话 + 重扫侧栏），不是只改 UI 投影。
  const activeProfileForBotsGate = useActiveProfile()
  const botsFeatureDesired = useBotsFeatureDesired()
  const botsEnabledRef = useRef(botsFeatureDesired)
  // boot 时插件已经关着也要回落一次（设置里关掉后重启，活动环境仍可能
  // 持久化成具名 home）；true→false 的直播切换同样置位。只回落一次——
  // 之后用户在「环境」菜单显式选别的档案不再强行拉回，否则永远离不开默认。
  const pendingDefaultResetRef = useRef(!botsFeatureDesired)
  useEffect(() => {
    const wasEnabled = botsEnabledRef.current
    botsEnabledRef.current = botsFeatureDesired
    if (botsFeatureDesired) {
      pendingDefaultResetRef.current = false
      return
    }
    if (wasEnabled) pendingDefaultResetRef.current = true
    if (!pendingDefaultResetRef.current || activeProfileForBotsGate === null) return
    pendingDefaultResetRef.current = false
    void switchProfile(null).then((ok) => {
      if (!ok) {
        console.error('[bots] 插件关闭后回到默认环境失败——保持原环境')
      }
    })
  }, [activeProfileForBotsGate, botsFeatureDesired, switchProfile])

  /** 轻量跟随活动环境（打开会话 / 点机器人 / bot 新聊天调用）。
   *
   *  「三个入口一个真相」（2026-11-25 用户："左下角头像、会话选项的环境、
   *  机器人页的选中，三个不统一"）：打开哪个环境的会话就把哪个环境设为
   *  活动环境——侧栏换源、底栏头像、环境菜单、机器人页高亮随之一致。
   *  与 `switchProfile`（显式切换，hermes selectProfile 语义）的区别 =
   *  **不打断当前会话**（不 interrupt/discard/RESET），打开动作自己会把
   *  前台切到目标会话。失败原样返回 false（调用方可见）。 */
  const followProfile = useCallback(
    async (profile: null | string): Promise<boolean> => {
      const target = profile === '' ? null : (profile ?? null)
      if (profileStore.getState().profile === target) return true
      try {
        const applied = await invoke<null | string>('pi_profile_set_active', { profile: target })
        setActiveProfileLocal(applied ?? null)
      } catch (e) {
        console.error('[profile] 跟随环境失败——保持原环境', e)
        return false
      }
      sidebarViewStore.getState().setShowAllProfiles(false)
      // 机器人页跟随（用户："选择环境，机器人页没跟"）：打开某环境的会话/
      // 点 bot 行时，花名册选中同步到该环境（插件经 window 事件接收）。
      selectBotsRoster(target)
      void refreshThreads().catch((e) =>
        console.error('[profile] 跟随环境后会话目录刷新失败', e),
      )
      return true
    },
    [refreshThreads],
  )

  useEffect(() => {
    setProfileFollower(followProfile)
    return () => setProfileFollower(null)
  }, [followProfile])

  /** fork 执行（「从此分支探索」）：守卫 → fork 点 index 映射 →
   * pi_fork_session → 采纳新会话（HYDRATE 重水合——switchToThread 同款
   * 通道，messages/currentRunId/error/usage/compaction/interrupted 随
   * HYDRATE 整体重置；lastEventId 是流游标不属会话态，照旧不动）→
   * currentThreadId 切新会话 + 线程列表刷新 → composer 预填 selectedText
   * → 分支条刷新。任一步失败 console.error 并中止（不动本地状态）。 */
  const runFork = useCallback(
    async (req: ForkRequest) => {
      // 守卫：run 进行中先中断（照抄 switchToThread/onEdit——fork 与
      // prompt 同抢会话锁）
      if (!(await interruptIfRunning())) return
      // fork 点清单 + index 映射：thread 第 N 条 user 消息 = 清单第 N 项
      // （同源水合+流式追加按序对应）。清单解析失败/越界 = 该消息尚未
      // 落盘（fork 点只在已水合历史上有）；text 不匹配 = 投影与 pi 路径
      // 漂移。二者都 fail loud 中止。
      let points: ReturnType<typeof parseForkPoints>
      try {
        points = parseForkPoints(await invoke<unknown>('pi_get_fork_points'))
      } catch (e) {
        console.error('[pi] fork 点清单获取失败——fork 取消', e)
        return
      }
      const point = points[req.userOrdinal]
      if (!point) {
        console.error(
          `[pi] fork：第 ${req.userOrdinal} 条 user 消息没有对应 fork 点（越界——该消息尚未落盘或清单形状非法）——fork 取消`,
        )
        return
      }
      if (point.text !== req.expectText) {
        console.error(
          `[pi] fork：fork 点文本与 thread 投影不匹配（index=${req.userOrdinal}）——fork 取消`,
        )
        return
      }
      let forked: { path: string; sessionId: string; selectedText: string }
      try {
        forked = await invoke<{ path: string; sessionId: string; selectedText: string }>(
          'pi_fork_session',
          { entryId: point.entryId },
        )
      } catch (e) {
        console.error('[pi] fork 失败（保持当前会话）', e)
        return
      }
      if (
        typeof forked?.sessionId !== 'string' ||
        typeof forked?.selectedText !== 'string'
      ) {
        console.error('[pi] fork 返回形状非法——不采纳新会话', forked)
        return
      }
      // 采纳新会话：新会话自己的 actor 水合（多会话并存：fork 是新键，旧
      // 会话的 actor 原样保留）+ currentThreadId 切换 + 线程列表刷新
      try {
        const forkedKey = sessionThreadKey(forked.sessionId)
        const forkedActor = getOrCreateActor(forkedKey, forkedKey)
        await hydrateTranscriptTail(forkedActor, forked.sessionId)
        try {
          const cursor = await invoke<number>('pi_stream_cursor', { thread: forkedKey })
          forkedActor.send({ type: 'SEEK', id: cursor })
          hydratedKeys.add(forkedKey)
        } catch (e) {
          console.error('[pi] 流游标获取失败（不 seek，直接续放）', e)
        }
        setCurrentThreadId(forked.sessionId)
        await refreshThreads()
        resetSessionScopedBridges(forked.sessionId)
      } catch (e) {
        console.error('[pi] fork 后重水合失败（新会话未采纳，可从侧栏手动打开）', e)
        void refreshThreads()
        return
      }
      // composer 预填 selectedText：上游语义——选中的 user 消息不进新文件，
      // 用户重新提交即开新分支。重水合成功才预填。
      branchBridge.getState().setComposerPrefill(forked.selectedText)
      // 分支条刷新（新会话的分支态）
      branchBridge.getState().requestRefresh()
    },
      [hydrateTranscriptTail, interruptIfRunning, refreshThreads, resetSessionScopedBridges],
  )

  /** 分支切换执行：守卫 → pi_switch_branch（服务端切叶）→ 重拉
   * pi_get_messages 重水合（契约：切叶后必须重水合）→ 分支条刷新。
   * threadId 不变（同一会话文件内换叶）。失败 console.error 不动本地态。 */
  const runSwitch = useCallback(
    async (req: SwitchRequest) => {
      if (!(await interruptIfRunning())) return
      try {
        await invoke('pi_switch_branch', { leafId: req.leafId })
      } catch (e) {
        console.error('[pi] 分支切换失败（保持当前分支）', e)
        return
      }
      try {
        await hydrateTranscriptTail(actorRef, currentThreadIdRef.current)
      } catch (e) {
        console.error('[pi] 分支切换后重水合失败（服务端已切叶，可重试切换恢复）', e)
        return
      }
      branchBridge.getState().requestRefresh()
    },
    [actorRef, interruptIfRunning],
  )

  /** 会话线「回到父会话」执行：守卫 → pi_open_session(路径)（**返回的是
   * 模型条目串不是会话 id**——实测 "amazon-bedrock/…"；sessionId 从
   * pi_get_state 取）→ 重水合 + currentThreadId + 线程列表刷新 → 分支条
   * 刷新。失败 console.error 不动本地态。 */
  const runOpenParent = useCallback(
    async (req: OpenParentRequest) => {
      if (!(await interruptIfRunning())) return
      try {
        await invoke('pi_open_session', { path: req.path })
      } catch (e) {
        console.error('[pi] 回到父会话失败（保持当前会话）', e)
        return
      }
      let sessionId: string
      try {
        const st = await invoke<{ sessionId?: unknown }>('pi_get_state')
        if (typeof st?.sessionId !== 'string' || st.sessionId.length === 0) {
          console.error('[pi] 回到父会话后 pi_get_state 无 sessionId——不采纳', st)
          return
        }
        sessionId = st.sessionId
      } catch (e) {
        console.error('[pi] 回到父会话后读取会话 id 失败', e)
        return
      }
      try {
        // 回到父会话 = 打开另一个既有会话：水合到**父会话自己的 actor**
        // （多会话并存：键按会话隔离，旧 actor 原样保留）
        const parentKey = sessionThreadKey(sessionId)
        const parentActor = getOrCreateActor(parentKey, parentKey)
        await hydrateTranscriptTail(parentActor, sessionId)
        try {
          const cursor = await invoke<number>('pi_stream_cursor', { thread: parentKey })
          parentActor.send({ type: 'SEEK', id: cursor })
          hydratedKeys.add(parentKey)
        } catch (e) {
          console.error('[pi] 流游标获取失败（不 seek，直接续放）', e)
        }
        setCurrentThreadId(sessionId)
        await refreshThreads()
        resetSessionScopedBridges(sessionId)
        // 滚动位置恢复请求（回到父会话 = 打开既有历史会话，与
        // switchToThread 同语义）
        threadScrollBridge.getState().requestRestore(sessionId)
      } catch (e) {
        console.error('[pi] 回到父会话后重水合失败（服务端已切换，可从侧栏手动打开）', e)
        void refreshThreads()
        return
      }
      branchBridge.getState().requestRefresh()
    },
    [interruptIfRunning, refreshThreads, resetSessionScopedBridges],
  )

  const forkRequest = useStore(branchBridge, (s) => s.forkRequest)
  const switchRequest = useStore(branchBridge, (s) => s.switchRequest)
  const openParentRequest = useStore(branchBridge, (s) => s.openParentRequest)
  const branchBusyRef = useRef(false)
  const handledBranchSeqRef = useRef(0)

  useEffect(() => {
    if (!forkRequest || forkRequest.seq <= handledBranchSeqRef.current) return
    if (branchBusyRef.current) {
      console.error('[pi] fork/分支操作进行中——忽略新 fork 请求', forkRequest)
      branchBridge.getState().clearForkRequest(forkRequest.seq)
      return
    }
    handledBranchSeqRef.current = forkRequest.seq
    branchBusyRef.current = true
    void runFork(forkRequest).finally(() => {
      branchBusyRef.current = false
      branchBridge.getState().clearForkRequest(forkRequest.seq)
    })
  }, [forkRequest, runFork])

  useEffect(() => {
    if (!switchRequest || switchRequest.seq <= handledBranchSeqRef.current) return
    if (branchBusyRef.current) {
      console.error('[pi] fork/分支操作进行中——忽略新分支切换请求', switchRequest)
      branchBridge.getState().clearSwitchRequest(switchRequest.seq)
      return
    }
    handledBranchSeqRef.current = switchRequest.seq
    branchBusyRef.current = true
    void runSwitch(switchRequest).finally(() => {
      branchBusyRef.current = false
      branchBridge.getState().clearSwitchRequest(switchRequest.seq)
    })
  }, [switchRequest, runSwitch])

  useEffect(() => {
    if (
      !openParentRequest ||
      openParentRequest.seq <= handledBranchSeqRef.current
    )
      return
    if (branchBusyRef.current) {
      console.error(
        '[pi] fork/分支操作进行中——忽略新「回到父会话」请求',
        openParentRequest,
      )
      branchBridge.getState().clearOpenParentRequest(openParentRequest.seq)
      return
    }
    handledBranchSeqRef.current = openParentRequest.seq
    branchBusyRef.current = true
    void runOpenParent(openParentRequest).finally(() => {
      branchBusyRef.current = false
      branchBridge.getState().clearOpenParentRequest(openParentRequest.seq)
    })
  }, [openParentRequest, runOpenParent])

  // ── checkpoint 回退执行器（checkpoint-store 请求通道，branch 同款）──
  /** 回退执行：守卫（照抄 switchToThread——prompt 持锁跨整个 run）→
   * pi_rewind（checkpointId = 检查点**名称**，pi find_checkpoint 的匹配
   * 键——不是 entryId）→ 重拉 pi_get_messages HYDRATE 重水合（活动上下文
   * 已截断到检查点，其后 span 折叠为一条摘要——重水合后的投影即回退后的
   * 真相）→ currentId 标记 + 检查点清单/分支点刷新。任一步失败
   * console.error 不动本地态。 */
  const runRewind = useCallback(
    async (req: RewindRequest) => {
      if (!(await interruptIfRunning())) return
      try {
        await invoke('pi_rewind', { checkpointId: req.name })
      } catch (e) {
        console.error(`[pi] 回退到检查点「${req.name}」失败（保持当前上下文）`, e)
        return
      }
      try {
        await hydrateTranscriptTail(actorRef, currentThreadIdRef.current)
      } catch (e) {
        console.error('[pi] 回退后重水合失败（服务端已截断，可重开检查点面板查看）', e)
        return
      }
      checkpointBridge.setState({ currentId: req.name })
      void checkpointBridge.getState().refresh()
      branchBridge.getState().requestRefresh()
    },
    [actorRef, hydrateTranscriptTail, interruptIfRunning],
  )

  const rewindRequest = useStore(checkpointBridge, (s) => s.rewindRequest)
  const handledRewindSeqRef = useRef(0)
  const rewindBusyRef = useRef(false)

  useEffect(() => {
    if (!rewindRequest || rewindRequest.seq <= handledRewindSeqRef.current) return
    if (rewindBusyRef.current) {
      console.error('[pi] 回退进行中——忽略新回退请求', rewindRequest)
      checkpointBridge.getState().clearRewindRequest(rewindRequest.seq)
      return
    }
    handledRewindSeqRef.current = rewindRequest.seq
    rewindBusyRef.current = true
    void runRewind(rewindRequest).finally(() => {
      rewindBusyRef.current = false
      checkpointBridge.getState().clearRewindRequest(rewindRequest.seq)
    })
  }, [rewindRequest, runRewind])

  // ── 「选择工作区新建会话」执行器（session-workspace 请求桥，branch/
  //    checkpoint 同款请求-执行形态）──
  // **2026-11-26 用户定稿："没有消息的会话不要落盘"**：选目录只进入
  // **草稿态**（pendingCwd + 空白对话），不再立即 `pi_new_session`；
  // 第一条消息发送时由 `ensureDraftSession` 建会话（cwd 随创建传入）。
  // 顺序 = ① fs_list 校验目录（ZCode project.directory-required，空目录合法）
  // ② 项目注册表登记（同根复用/回收站恢复；失败则整个请求失败）
  // ③ 丢弃旧会话 + RESET → 草稿（tab/chip 立即显示待落 cwd）
  // 失败一律写 sessionWorkspaceStore.error（composer 工作区行可见），
  // 不排队假装成功。
  const workspaceRequest = useStore(sessionWorkspaceStore, (s) => s.request)
  const handledWorkspaceSeqRef = useRef(0)
  const workspaceBusyRef = useRef(false)

  useEffect(() => {
    if (!workspaceRequest || workspaceRequest.seq <= handledWorkspaceSeqRef.current) return
    if (workspaceBusyRef.current) {
      console.error('[pi] 会话操作进行中——忽略新工作区请求', workspaceRequest)
      sessionWorkspaceStore.getState().clearRequest(workspaceRequest.seq)
      return
    }
    handledWorkspaceSeqRef.current = workspaceRequest.seq
    workspaceBusyRef.current = true
    const { seq, cwd } = workspaceRequest
    // 先亮出将落到的目录（草稿态 tab/chip 立即有反馈），失败回滚。
    sessionCatalog.getState().setPendingCwd(cwd)
    void (async () => {
      const fail = (message: string): void => {
        sessionWorkspaceStore.getState().failRequest(seq, message)
        sessionCatalog.getState().setPendingCwd(null)
      }
      try {
        const listing = await fsList(cwd)
        if (listing.error) {
          const message = describeWorkspaceDirectoryError(listing.error, cwd)
          console.error(`[pi] 工作区不可用（${listing.error}）：${cwd}`)
          fail(message)
          return
        }
        // （多会话并存：在跑 run 后台继续，不再 gate 在"能中断"上）
        // ZCode 选文件夹 = 新建项目：先落项目注册表（同根复用/回收站恢复），
        // 再进入草稿；失败则整个请求失败（不留下「有会话无项目」）。
        await ensureProjectForWorkspace(cwd)
        await sessionCatalog.getState().loadProjects(true)
        // 草稿态：旧会话（若为 0 消息空壳）删掉，其余只 flush 不删文件。
        // **不打断在跑 run**（多会话并存）：discard 把柄退入 retired，run
        // 后台继续；焦点换到全新哨兵 actor。
        await pruneEmptyCurrentSession(currentThreadIdRef.current)
        try {
          await invoke('pi_discard_session')
        } catch (e) {
          console.error('[pi] 丢弃旧会话失败（仍进入工作区草稿）', e)
        }
        dropActor(NEW_CHAT_THREAD_KEY)
        resetTranscriptTail()
        setCurrentThreadId(null)
        sessionCatalog.getState().setActive(null)
        // ZCode 侧栏按项目分组；mirach 默认"更新时间"分组下新工作区没有
        // 可见的组头。仅在默认分组时切到"项目"（用户显式选过 status
        // 等自定义分组时不覆盖）。
        if (sidebarViewStore.getState().grouping === 'date') {
          sidebarViewStore.getState().setGrouping('project')
        }
        await refreshThreads()
        resetSessionScopedBridges(null)
        // 新会话——分支条/fork 点投影清空（同 New Chat 语义）
        branchBridge.getState().requestRefresh()
      } catch (e) {
        console.error(`[pi] 进入工作区草稿失败（${cwd}）——保持当前会话`, e)
        fail(`新建文件夹会话失败：${e instanceof Error ? e.message : String(e)}`)
      } finally {
        sessionWorkspaceStore.getState().clearRequest(seq)
      }
    })().finally(() => {
      workspaceBusyRef.current = false
    })
  }, [
    workspaceRequest,
    interruptIfRunning,
    pruneEmptyCurrentSession,
    refreshThreads,
    resetSessionScopedBridges,
    actorRef,
  ])

  // ── run 收尾（streaming → idle 迁移，RUN_FINISHED 与 RUN_ERROR 都走
  // 此迁移）三件事 ─────────────────────────────────────────────────────
  // ① 分支数据刷新：user 消息落盘后才成为 fork 点（「从此分支探索」钮
  //    可用性依赖 forkPoints 新鲜）。挂载跳过（SessionLineBar 挂载已拉）。
  // ② 队列 drain（message-queue）：按序发出下一条排队消息——出队即
  //    USER_SUBMIT 乐观进投影 + postRun；本 run 收尾后只发一条，发完等
  //    下一次收尾（one-at-a-time）。用户取消（pi_interrupt）同样算收尾
  //    ——排队意图仍然兑现（队列面板全程可见可删）。
  // ③ 成本入账（cost-meter）：pi_get_state 是 sessionId 的权威源（首条
  //    消息创建的会话 currentThreadId 可能仍为 null），把本 run 的
  //    costUsd 累进该会话的进程内账本（历史会话不回算）。
  const wasRunningRef = useRef(false)
  /** 审查刷新用的轮次边沿（与上面的收尾边沿分开：两者消费时机不同，
   *  共用一个变量会互相覆盖，见审查段注释）。 */
  const reviewWasRunningRef = useRef(false)
  const usageRef = useRef<TurnUsage | null>(null)
  usageRef.current = usage

  /** 队列 drain：endpoint 未就绪时保留队列（出队即丢 = 兜底，禁止）。
   *  **lane 收尾窗口**：RUN_FINISHED 到达 ≠ prompt 返回；引擎落盘/广播排空
   *  期间 lane 仍 busy，此时 POST 会得到 "Lane main already has an active
   *  run operation"（用户实报）。drain 前轮询 `pi_lane_busy`，busy 就等，
   *  队列保留在原处；超时仍 busy 则 2s 后自动重试（不硬发、不丢消息）。 */
  const drainRetryRef = useRef<number | null>(null)
  /** 并发闸：一次只允许一个 drain（effect 边沿 + 重试定时器可能同时到） */
  const drainInFlightRef = useRef(false)
  const drainQueue = useCallback(async () => {
    if (drainInFlightRef.current) return
    drainInFlightRef.current = true
    try {
      if (!endpointRef.current) {
        console.error('[queue] endpoint 未就绪——排队消息保留，待下次 run 收尾再发')
        return
      }
      // 排队消息按**焦点会话**分桶（多会话并存）：drain 只发焦点会话的
      // 队列（后台会话的队列在切回焦点且空闲时续发）。
      const drainKey = sessionThreadKey(currentThreadIdRef.current)
      if ((sessionQueue.getState().bySession[drainKey] ?? []).length === 0) return
      let busy = true
      for (let attempt = 0; attempt < 60; attempt += 1) {
        busy = false
        try {
          busy = await invoke<boolean>('pi_lane_busy')
        } catch (e) {
          // 查询失败不阻止发送：真正的 busy 会以 RUN_ERROR 可见（不静默）
          console.error('[queue] lane_busy 查询失败——按空闲继续', e)
        }
        if (!busy) break
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
      if (busy) {
        // 30s 仍 busy：不硬发（会撞 lane 拒绝）。消息保留在队列，2s 后再试
        // ——流断开的 run 可能仍在引擎里，用户也可点停止释放。
        console.error('[queue] lane 仍 busy——排队消息保留，2s 后重试')
        if (drainRetryRef.current === null) {
          drainRetryRef.current = window.setTimeout(() => {
            drainRetryRef.current = null
            void drainQueue()
          }, 2000)
        }
        return
      }
      const next = sessionQueue.getState().takeFirst(drainKey)
      if (!next) return
      actorRef.send({
        type: 'USER_SUBMIT',
        text: next.text,
        messageId: `user-q-${Date.now()}`,
        ...(next.imageDataUrls && next.imageDataUrls.length > 0
          ? { images: next.imageDataUrls }
          : {}),
        ...(next.files && next.files.length > 0 ? { files: next.files } : {}),
      })
      postRun(next.submission ?? next.text, next.images)
      void refreshThreads()
    } finally {
      drainInFlightRef.current = false
    }
  }, [actorRef, postRun, refreshThreads])

  /** 成本入账：失败 console.error 可见，本 run 不入账（不估算） */
  const recordRunCost = useCallback(() => {
    const u = usageRef.current
    void (async () => {
      try {
        const st = await invoke<{
          sessionId: string | null
          provider: string
          modelId: string
        }>('pi_get_state')
        costBridge.getState().recordRun({
          sessionId: st.sessionId,
          model: `${st.provider}/${st.modelId}`,
          costUsd: u?.costUsd,
          inputTokens: u?.inputTokens,
          outputTokens: u?.outputTokens,
        })
      } catch (e) {
        console.error('[cost] run 收尾成本入账失败（本 run 不入账）', e)
      }
    })()
  }, [])

  useEffect(() => {
    if (isRunning) {
      wasRunningRef.current = true
      return
    }
    if (!wasRunningRef.current) return
    wasRunningRef.current = false
    branchBridge.getState().requestRefresh()
    // 时间线标记重拉：模型切换 / 自动压缩都发生在 run 之间，run 收尾是
    // 唯一能看见它们落盘的时机（会话条目在 run 结束时 flush）。
    void timelineMarkerBridge.getState().refresh(currentThreadIdRef.current)
    void drainQueue()
    recordRunCost()
  }, [isRunning, drainQueue, recordRunCost])

  // 排队消息的**边沿无关自动 drain**（hermes shouldAutoDrain 同语义：
  // "the queue must advance whenever the session is idle and has pending
  // entries, NOT only on an observed busy→false edge"）——切到某会话时若
  // 它有排队消息且空闲，立即续发（否则切走的会话收尾时队列永远等不到
  // 下一个收尾边沿）。
  useEffect(() => {
    if (isRunning || !endpoint) return
    const key = sessionThreadKey(currentThreadId)
    if ((sessionQueue.getState().bySession[key] ?? []).length === 0) return
    const timer = window.setTimeout(() => void drainQueue(), 300)
    return () => window.clearTimeout(timer)
  }, [currentThreadId, isRunning, endpoint, drainQueue])

  // onEdit（§数据面契约 pi_retry_edit）：准备最后一个可重试 user turn 的
  // 兄弟分支，重发 = 之后一次普通 POST。成功后把编辑文本经 USER_SUBMIT
  // 进投影（乐观用户消息——否则编辑后的文本在扁平投影里不可见），再 POST。
  const onEdit = useCallback(
    async (m: AppendMessage) => {
      const raw = m.content
      const text = (
        typeof raw === 'string' ? raw : raw.map((c) => (c.type === 'text' ? c.text : '')).join('')
      ).trim()
      if (!text) throw new Error('[pi] 编辑后消息为空，未发送')
      if (!endpointRef.current) throw new Error('[agui] endpoint 未就绪，消息未发送')
      if (!(await interruptIfRunning())) return
      try {
        await invoke('pi_retry_edit')
      } catch (e) {
        // 失败 console.error 不动状态（重试分支未建立，POST 不发）
        console.error('[pi] retry_edit 失败——编辑未生效', e)
        return
      }
      actorRef.send({ type: 'USER_SUBMIT', text, messageId: `user-edit-${Date.now()}` })
      postRun(text)
      void refreshThreads()
      // retry_edit 已建兄弟分支——分支条/fork 点刷新
      branchBridge.getState().requestRefresh()
    },
    [actorRef, interruptIfRunning, postRun, refreshThreads],
  )

  // onReload（重新生成最后一条 assistant 回复）：同样守卫 → pi_retry_edit
  // → 取最后一条 user 消息文本重发。只支持最后 turn：parentId 非 null 且
  // 不是最后一条 user 消息（= 用户点了旧 assistant 的 Reload）时 fail loud
  // 拒绝——兄弟分支历史重建不做（诚实暴露，不硬做）。modelOverride：本版
  // core 的 StartRunConfig 无该字段（0.12 改名 runConfig.custom），两处都
  // 探测，存在则先 pi_set_model 成功再重发。
  const onReload = useCallback(
    async (
      parentId: string | null,
      // StartRunConfig 的结构超集（本版 core 无 modelOverride 字段——
      // 0.12 起挪进 runConfig.custom；两处都探测，兼容任务契约的旧位）
      config: {
        parentId?: string | null
        runConfig?: { custom?: Record<string, unknown> }
        modelOverride?: string
      },
    ) => {
      if (!endpointRef.current) throw new Error('[agui] endpoint 未就绪')
      const lastUser = lastUserMessage()
      if (!lastUser || typeof lastUser.content !== 'string') {
        console.error('[pi] reload：没有可重发的 user 文本消息——忽略')
        return
      }
      if (parentId !== null && parentId !== lastUser.id) {
        console.error(
          `[pi] reload：只支持重新生成最后一条回复（parentId=${parentId}，最后 user 消息=${lastUser.id}）——历史 turn 重刷未支持`,
        )
        return
      }
      const modelOverride =
        config.modelOverride ??
        (typeof config.runConfig?.custom?.modelOverride === 'string'
          ? config.runConfig.custom.modelOverride
          : undefined)
      if (modelOverride) {
        const idx = modelOverride.indexOf('/')
        if (idx <= 0) {
          console.error(`[pi] reload：modelOverride 形状非法（${modelOverride}）——忽略`)
          return
        }
        try {
          await invoke('pi_set_model', {
            provider: modelOverride.slice(0, idx),
            modelId: modelOverride.slice(idx + 1),
          })
        } catch (e) {
          console.error(`[pi] reload：pi_set_model ${modelOverride} 失败——未重发`, e)
          return
        }
      }
      if (!(await interruptIfRunning())) return
      try {
        await invoke('pi_retry_edit')
      } catch (e) {
        console.error('[pi] retry_edit 失败——重发取消', e)
        return
      }
      postRun(lastUser.content)
      void refreshThreads()
      // retry_edit 已建重试分支——分支条/fork 点刷新
      branchBridge.getState().requestRefresh()
    },
    [interruptIfRunning, lastUserMessage, postRun, refreshThreads],
  )

  const switchToThreadPath = useCallback(
    async (id: string, path: string, force = false) => {
      // 已是当前会话 = 无操作（hermes openSession 的 focusOpenSession 命中
      // main 分支对偶）。不回家重建 harness，也不重扫目录——这是点击已在
      // 看的那一行时唯一正确的响应，也避免了无意义的全量水合。
      // `force` = 插件 openSession 明确要求打开该会话（即使 ref 已是它）：
      // 后台 profile follow 可能只改了 ref/catalog 而没换 transcript，早退
      // 会把界面留在旧线程（机器人行"点了没反应"）。
      if (id === currentThreadIdRef.current && !force) {
        mainViewStore.getState().showChat()
        return
      }
      // 流式中切换（§4.5）：prompt 持锁跨整个 run（RUN_FINISHED/ERROR 才
      // 释放），不先中断 open_session 会撞锁失败——先 pi_interrupt 再切；
      // 中断失败保持当前会话（不更新本地态，禁止假装切换成功）。
      //
      // **中断必须可见**（2026-11-27 用户：「去掉工作中」）：引擎单 handle
      // 决定了「切换 = 只能中断」。标记要在下面 hydrate **之后**发（hydrate
      // 的 assign 会把 interrupted 重置为 false，先发会被清掉），否则切回来
      // 时 run 已经没了、界面上却没有任何痕迹。
      let interruptedBySwitch = false
      if (actorRef.getSnapshot().matches('streaming')) {
        try {
          await invoke('pi_interrupt')
          interruptedBySwitch = true
          console.info('[pi] run 进行中：已中断当前 run 后切换会话（prompt 持锁跨整个 run）')
        } catch (e) {
          console.error('[pi] 中断当前 run 失败，取消切换会话', e)
          return
        }
      }
      // 环境跟随（2026-11-25）：打开哪个环境的会话就进入哪个环境——侧栏
      // 作用域/底栏/环境菜单/机器人页选中四处同源。**聚合视图（全部配置
      // 档案）下不跟随**：那是在浏览所有环境，点行不该把浏览态拆掉。
      if (!sidebarViewStore.getState().showAllProfiles) {
        const targetProfile = profileForSession(id)
        if (targetProfile !== undefined && targetProfile !== profileStore.getState().profile) {
          const followed = await followProfileBridge(targetProfile)
          if (!followed) {
            console.error(`[profile] 会话 ${id} 的环境跟随失败（继续打开，侧栏仍按原环境）`)
          }
        }
      }
      // 离开的空会话不落盘（2026-11-26）：先清理当前 0 消息会话，再切目标。
      await pruneEmptyCurrentSession(currentThreadIdRef.current)
      // **切换绝不打断在跑 run**（2026-11-28 用户："切换会话时要不中断对
      // 话，像 hermes 那样多标签并存、后台继续跑"）：引擎按会话路由事件
      // （POST 键 `main:<id>`），切走后 run 在 retired 句柄上继续跑、事件
      // 落自己的桶；旧实现「先 pi_interrupt 再切」已随单会话路由一并撤销。
      // 用户要停止 = 点停止钮（显式手势，hermes/ZCode 同语义）。
      // 乐观高亮（hermes focusOpenSession 先前端面后等 RPC 的对偶）：点行
      // 立即把选中态切过去，侧栏/页签不用干等 open_session + 全量水合。
      // 打开失败时下面 catch 会拉一次真值把选中态纠正回来。
      const prevThreadId = currentThreadIdRef.current
      sessionCatalog.getState().setActive(id)
      setCurrentThreadId(id)
      mainViewStore.getState().showChat()
      const targetKey = sessionThreadKey(id)
      const warm = hydratedKeys.has(targetKey)
      // **内容加载防抖**（2026-11-21 用户实测：快速连点会话卡顿）：
      // 乐观 UI 零成本即时；peek+open+hydrate 的 React 提交 ~300-500ms/次，
      // 连点会堆叠。取消上一次的 pending 加载，只执行最后一次点击的加载。
      if (switchDebounceRef.current) clearTimeout(switchDebounceRef.current)
      switchDebounceRef.current = setTimeout(async () => {
        try {
          if (warm) {
            // **热会话**：投影已消费该会话全部流事件（比文件新，在跑 run 的
            // 增量也在）——只切引擎 live（get_state/模式/审批都跟 live），
            // **不重水合**：重水合会把文件里的旧状态盖回投影，在跑 run 的
            // 增量反而丢。SSE 由焦点效果按 focusedKey 变化换订续放。
            let openErrorW: unknown = null
            const openW = invoke('pi_open_session', { path })
              .then(() => undefined)
              .catch((e) => {
                openErrorW = e
              })
            pendingOpenRef.current = openW
            await openW
            if (openErrorW) throw openErrorW
            errorBridge.getState().setError(null)
            if (sessionCatalog.getState().activeId !== id) return
            $hostActiveSessionId.set(id)
            $hostFocusedStoredSessionId.set(id)
            void refreshThreads().catch((e) =>
              console.error('[pi] 切换后会话目录刷新失败（侧栏行统计可能偏高）', e),
            )
            resetSessionScopedBridges(id)
            threadScrollBridge.getState().requestRestore(id)
            branchBridge.getState().requestRefresh()
            return
          }
          // **冷会话（首次打开）**：引擎 pi_open_session 对巨文件要整树
          // replay（实测 11MB ≈ 5s）。尾部预览（文件尾读，不依赖引擎）与
          // 打开并行：预览先回来且引擎还没就绪 → 先把尾部画出来；打开就绪
          // 后统一走引擎页对齐（同条目 id 重水合，无 key 变化、无闪烁）。
          let openError: unknown = null
          let openSettled = false
          const openPromise = invoke('pi_open_session', { path })
            .catch((e) => {
              openError = e
            })
            .finally(() => {
              openSettled = true
            })
          pendingOpenRef.current = openPromise.then(() => undefined)
          const targetActor = getOrCreateActor(targetKey, targetKey)
          const peek = await peekTranscriptTail(path)
          // 预览等待期间用户可能已切走：只在仍是当前选中时才挂（以
          // catalog.activeId 为准——setActive 是同步 Zustand 写）
          if (peek && !openSettled && sessionCatalog.getState().activeId === id) {
            applyTranscriptPeek(targetActor, peek, id)
            threadScrollBridge.getState().requestRestore(id)
          }
          if (!openSettled) setEngineAttaching(true)
          try {
            await openPromise
          } finally {
            setEngineAttaching(false)
          }
          if (openError) throw openError
          // 成功切换 = 上一条"无法打开会话"红条过期，清掉（run 错误会被
          // 下一次 RUN_STARTED 的归约自然覆盖）。
          errorBridge.getState().setError(null)
          // 首屏只拉分支尾部一页（hermes tail hydration），「显示更早」按需补页
          // 返回值 = 是否真的写入（false = 已被更新的切换取代，本会话不再
          // 是该请求的归属者——后续副作用一律跳过，避免搞乱别人的会话）。
          const hydrated = await hydrateTranscriptTail(targetActor, id)
          if (!hydrated) return
          if (sessionCatalog.getState().activeId !== id) return // 已切走
          // 多会话并存：文件水合后把游标拨到该会话缓冲的当前头（缓冲历史
          // 已由文件覆盖，只收之后的增量），并标记为热会话（下次切换走热路）。
          try {
            const cursor = await invoke<number>('pi_stream_cursor', { thread: targetKey })
            targetActor.send({ type: 'SEEK', id: cursor })
            hydratedKeys.add(targetKey)
          } catch (e) {
            console.error('[pi] 流游标获取失败（不 seek，直接续放）', e)
          }
          // 宿主状态面（插件 host.state）：活动/聚焦会话 = 当前线程；机器人
          // 花名册的"这行是否正在看"与"是否在跑"读这两个 atom。owner/profile
          // 由 [currentThreadId] 的效果统一算（bot 双锚命中才是 owner）。
          $hostActiveSessionId.set(id)
          $hostFocusedStoredSessionId.set(id)
          // 目录刷新不阻塞切换感知：行高亮已乐观落，title/统计拉到再覆盖。
          void refreshThreads().catch((e) =>
            console.error('[pi] 切换后会话目录刷新失败（侧栏行统计可能偏高）', e),
          )
          resetSessionScopedBridges(id)
          // 滚动位置恢复请求（打开会话成功路径）：视口按该会话的持久化
          // 位置恢复阅读位
          threadScrollBridge.getState().requestRestore(id)
          // 活动会话已换——分支条/fork 点随新会话刷新（防上一会话的投影残留）
          branchBridge.getState().requestRefresh()
        } catch (e) {
          console.error(`[pi] 会话 ${id} 打开失败（已回滚选中态）`, e)
          // 乐观高亮已把选中态切过去，失败必须纠正回引擎真值，否则侧栏
          // 高亮一行、聊天区却是上一个会话——比不亮更误导。
          sessionCatalog.getState().setActive(prevThreadId)
          setCurrentThreadId(prevThreadId)
          errorBridge.getState().setError(
            `无法打开会话：${e instanceof Error ? e.message : String(e)}`,
            false,
          )
        }
        })
    },
    [hydrateTranscriptTail, pruneEmptyCurrentSession, refreshThreads, resetSessionScopedBridges],
  )

  const switchToThread = useCallback(
    async (id: string) => {
      const row = threadsRef.current.find((t) => t.id === id)
      const path = row?.custom?.path
      if (typeof path !== 'string') {
        console.error(`[pi] 会话 ${id} 缺少 path，无法打开`)
        return
      }
      await switchToThreadPath(id, path)
    },
    [switchToThreadPath],
  )

  /**
   * 按存储会话 id 打开（插件 `host.openSession` 的对偶）。
   *
   * 与 `switchToThread` 的差异：**不要求该行已在侧栏目录里**——插件刚
   * `session.create` 出来的 bot 会话还没被 `refreshThreads` 收进来。此时
   * 按 pi_list_sessions 的 id → path 兜路；仍找不到就 console.error（可见），
   * 不假装打开成功。
   */
  const openStoredSession = useCallback(
    async (storedId: string) => {
      // 主区前台化：机器人页点行时 active dockview 面板仍是「机器人」栏；
      // 只切 sessionCatalog 不会把 workspace 拉到前景，用户看起来"点了没
      // 反应"（2026-11-26 "机器人为什么无法回复" 实锤）。side 栏路径不走这
      // 里（host.openSession intent=tab 直接开新栏）。
      const activateWorkspace = (): void => {
        const api = (globalThis as {
          __dvApi?: { getPanel?: (id: string) => { api?: { setActive?: () => void } } | undefined }
        }).__dvApi
        api?.getPanel?.('workspace')?.api?.setActive?.()
      }
      const row = threadsRef.current.find((t) => t.id === storedId)
      const knownPath = row?.custom?.path
      // 插件 openSession 的 path 以引擎活动环境的 `pi_list_sessions` 为准：
      // 侧栏/目录行可能来自切换前的环境（旧 path 会在 pi_open_session 里
      // 被当成另一个会话/直接失败）。list 找不到才回落目录行的 path。
      try {
        const sessions = await invoke<{ id: string; path: string }[]>('pi_list_sessions')
        const path = (sessions ?? []).find((s) => s.id === storedId)?.path
        if (path) {
          await switchToThreadPath(storedId, path, true)
          activateWorkspace()
          return
        }
      } catch (e) {
        console.error(`[pi] 存储会话 ${storedId} 路径解析失败（回落目录行 path）`, e)
      }
      if (typeof knownPath === 'string') {
        await switchToThreadPath(storedId, knownPath, true)
        activateWorkspace()
        return
      }
      console.error(`[pi] 存储会话 ${storedId} 不在 pi_list_sessions——无法打开`)
    },
    [switchToThreadPath],
  )

  // 会话页签激活 → 切线程（docs/layout-design.md v6.0 §8）：flex-layout 的
  // SELECT_TAB 拦截经 bridge 调这里；switchToThread 换新（依赖变化）时
  // 重登记，卸载清空（未注册 = bridge 侧错误可见）。
  useEffect(() => {
    setSessionThreadSwitcher((id) => void switchToThread(id))
    return () => setSessionThreadSwitcher(null)
  }, [switchToThread])

  // 插件侧 host.openSession（存储会话 id，可能尚未进目录）→ 本组件的
  // 打开实现；卸载清空（未注册 = bridge 侧错误可见）。
  useEffect(() => {
    setStoredSessionOpener((id) => void openStoredSession(id))
    return () => setStoredSessionOpener(null)
  }, [openStoredSession])

  // 会话列表刷新登记（2026-11-15 会话管理 P0）：项目归属 / 项目增删 /
  // 归档恢复等写入 Rust 后，侧栏与跨根索引需要重拉（cwd 推断只有重扫才
  // 知道）。未注册时调用方 console.error 可见（bridge 内）。
  useEffect(() => {
    setSessionListRefresher(() => {
      void refreshThreads()
    })
    return () => setSessionListRefresher(null)
  }, [refreshThreads])

  const threadListAdapter = {
    threadId: currentThreadId ?? undefined,
    threads,
    onSwitchToNewThread: async () => {
      // New Chat：flush 旧会话落盘 + 清 handle（不立即建空会话文件），
      // 下一次发送按需创建全新会话；失败保持当前会话（不更新本地态）。
      // **不打断在跑 run**（多会话并存 2026-11-28）：discard 把柄退入
      // retired，run 后台继续；焦点换到全新哨兵 actor。
      try {
        // 旧会话如果是 0 消息空壳（bot 行刚铸出来的），直接删掉不留盘
        await pruneEmptyCurrentSession(currentThreadIdRef.current)
        await invoke('pi_discard_session')
        dropActor(NEW_CHAT_THREAD_KEY)
        resetTranscriptTail()
        setCurrentThreadId(null)
        // 新会话不继承上一个文件夹（"新建会话"按钮语义不变）；否则
        // chip/tab 会显示一个下一次懒创建根本不会落到的目录。
        sessionCatalog.getState().setPendingCwd(null)
        // 启动恢复也不应回到刚被丢弃的会话：清上次会话记录（下一次发送
        // 建出新会话后会重新写入）。写盘失败可见，不影响 New Chat 本身。
        void updateAppPrefs({ lastSessionPath: null }).catch((e) =>
          console.error('[app-prefs] 清除上次会话记录失败（启动恢复可能回到旧会话）', e),
        )
        await refreshThreads()
        resetSessionScopedBridges(null)
        // 无活动会话——分支条/fork 点投影清空（refresh 命中 no active
        // session 域状态，静默清投影）
        branchBridge.getState().requestRefresh()
      } catch (e) {
        console.error('[pi] New Chat 失败（保持当前会话）', e)
      }
    },
    onSwitchToThread: async (id: string) => {
      await switchToThread(id)
    },
    onRename: async (id: string, newTitle: string) => {
      if (id !== currentThreadId) {
        // SDK 语义：set_session_name 只作用于当前会话
        console.error('[pi] 仅当前活跃会话支持重命名')
        return
      }
      const name = newTitle.trim()
      if (!name) return
      // 标题唯一性（hermes core 的 UNIQUE(title) 语义，2026-11-26）：同一
      // 环境里已有同名会话 → 拒绝改名（上游报 "already in use"）。pi 的
      // name 没有唯一索引，宿主在写前守一道；查询失败不假装成功但也
      // 不阻断（console 可见）。
      try {
        const rows = await invoke<PiSessionMeta[]>('pi_list_sessions')
        if ((rows ?? []).some((r) => r.id !== id && (r.name ?? '') === name)) {
          errorBridge
            .getState()
            .setError(`会话名「${name}」已被当前环境的另一个会话使用`, false)
          return
        }
      } catch (e) {
        console.error('[pi] 重命名前查重失败（继续改名，可能产生同名会话）', e)
      }
      try {
        await invoke('pi_rename_session', { name })
        // 选择文件夹建的会话不在 pi_list_sessions：名字同步进登记表，
        // 否则刷新后该行又变回 New Chat。
        workspaceSessionIndex.getState().setTitle(id, name)
        await refreshThreads()
      } catch (e) {
        console.error('[pi] 会话重命名失败', e)
      }
    },
    onDelete: async (id: string) => {
      const row = threadsRef.current.find((t) => t.id === id)
      const path = row?.custom?.path
      if (typeof path !== 'string') {
        console.error(`[pi] 会话 ${id} 缺少 path，无法删除`)
        errorBridge.getState().setError(`无法删除会话：缺少会话文件路径`, false)
        return
      }
      // 乐观剔除（hermes dropListedSession + tombstoneSessions 对偶）：先把
      // 这行从侧栏目录摘掉，用户立刻看到结果；RPC 失败时按快照整行复原
      // 并给可见红条——不留幽灵行，也不把失败伪装成成功。
      const snapshot = threadsRef.current.slice()
      const evicted = snapshot.filter((t) => t.id !== id)
      setThreads(evicted)
      try {
        if (id === currentThreadId) {
          // 当前活跃会话：pi 持有该会话 handle（jsonl 打开中），直接
          // delete 会撞打开中的文件——先 discard（flush 落盘 + 清 handle
          // + 清挂起审批）+ 焦点换全新哨兵 actor（threadId 置 null = 高亮
          // New Chat），再删文件。非当前会话行为不变。
          await invoke('pi_discard_session')
          dropActor(NEW_CHAT_THREAD_KEY)
          resetTranscriptTail()
          setCurrentThreadId(null)
          sessionCatalog.getState().setPendingCwd(null)
          resetSessionScopedBridges(null)
          // 无活动会话——分支条/fork 点投影清空（同 New Chat 语义）
          branchBridge.getState().requestRefresh()
        }
        await invoke('pi_delete_session', { path })
        // 删除成功：登记表同步移除，否则 refreshThreads 会把这行补回来。
        workspaceSessionIndex.getState().remove(id)
        // 该会话的队列/草稿一并清掉（用户删除 = 意图明确，不是切换）。
        sessionQueue.getState().clearSession(sessionThreadKey(id))
        clearComposerDraft(id)
        // 删除成功清该会话的滚动位置记忆（内存 + 持久化）
        clearThreadScroll(id)
        await refreshThreads()
      } catch (e) {
        console.error(`[pi] 会话 ${id} 删除失败（已回滚侧栏行）`, e)
        // 回滚：按删除前快照复原整表（乐观剔除已改过 setThreads）；再拉
        // 一次真值以免快照之外的状态漂移。
        setThreads(snapshot)
        await refreshThreads().catch(() => undefined)
        errorBridge.getState().setError(
          `删除会话失败：${e instanceof Error ? e.message : String(e)}`,
          false,
        )
      }
    },
    onArchive: async () => {
      // 归档的实现在行菜单/手势（session-archive 客户端归档，重审计 #6）；
      // assistant-ui 的 archive API 本工程未接线——到达这里即未预期路径。
      console.error('[pi] threadListAdapter.onArchive 未接线（归档走行菜单）')
    },
  }

  const runtime = useExternalStoreRuntime({
    // threadListAdapter 必须放 adapters.threadList（core 的
    // getThreadListAdapter 只读 store.adapters?.threadList；顶层平铺无效）
    adapters: {
      threadList: threadListAdapter,
      // 附件（图片走引擎原生多模态，视频/音频/文档走 prompt 文件引用；
      // 分类/白名单/提示词见 attachments.ts 单一来源）
      attachments: piAttachmentAdapter,
      // 朗读（read-aloud 元素）：带 boundary 进度的 Web Speech 适配器——
      // 无语音引擎环境为 undefined（capabilities.speech=false，UI 钮隐藏）
      ...(speechAdapter ? { speech: speechAdapter } : {}),
    },
    // 压缩横幅 / 中断态 / 重试中投影（机器 context 的 JSON 快照）
    state: { compaction, interrupted, providerRetry },
    // TurnPart 与 ThreadMessageLike 的 tool-call 形状对齐；args 的
    // Record<string, unknown> 运行时即 JSON 对象（pi arguments Value），断言
    convertMessage: convertTurnMessage,
    messages,
    isRunning,
    onNew: async (m) => {
      const raw = m.content
      let text = (typeof raw === 'string' ? raw : raw.map((c) => (c.type === 'text' ? c.text : '')).join('')).trim()
      // 语音委托：UI 文本只有用户说的话；隐藏 note/上下文经 runConfig 传入，
      // 只用于发给引擎（0.12 起 runConfig.custom 是宿主自定义字段的通道）。
      const voiceSubmission =
        typeof m.runConfig?.custom?.voiceSubmission === 'string'
          ? m.runConfig.custom.voiceSubmission
          : null
      // composer.middleware 贡献面（hermes-bots 的 @身份注记 / /new→/compact
      // 守卫）：只在**用户直接提交**时跑（语音委托的隐藏 note 与队列重放
      // 不再过 middleware——上游同款：middleware 在 onSubmit 前跑一次）。
      // 返回 null = 取消发送（上游语义）。
      if (!voiceSubmission) {
        const rewritten = await runComposerMiddleware({
          text,
          attachments: m.attachments ?? [],
        })
        if (rewritten === null) return
        text = rewritten.text
      }
      // 附件归一（唯一来源 attachments.ts）：图片 → POST images[]（引擎原生
      // 多模态）；视频/音频/文档 → 绝对路径引用块（引擎没有这些原生块，
      // 不伪装）；不完整/不支持的类型直接报错，整条消息不发（禁止半发）。
      // 必须包成 MessageNotSentError：assistant-ui 只对它回填草稿/附件，
      // 普通 Error 会把用户刚打的字与附件留在"已清空"状态。
      let plan: ReturnType<typeof collectAttachmentPlan>
      try {
        plan = collectAttachmentPlan(m.attachments ?? [])
      } catch (e) {
        throw new MessageNotSentError(e instanceof Error ? e.message : String(e))
      }
      // 引擎契约：message 必填且非空。显示文本可以只有附件（乐观 user
      // 消息只渲染图片/附件 chip），发给引擎的文本用附件说明补齐。
      // 语音委托的隐藏 note 同样要带上附件引用（composePrompt 只 trim 边界）。
      const submission = composePrompt(
        voiceSubmission ?? text,
        plan.imageNames,
        plan.files,
      )
      if (!submission.trim()) {
        throw new MessageNotSentError('[pi] 消息为空：没有可发送的文本或附件')
      }
      // 错误即错误：endpoint 未就绪直接报错——消息不装作已发送；用
      // MessageNotSentError 保证草稿与附件回填（不丢用户输入）
      if (!endpointRef.current) {
        throw new MessageNotSentError('[agui] endpoint 未就绪，消息未发送')
      }
      // run 进行中（actor streaming **或** 引擎 lane 仍 busy）→ 入队：
      // 后者覆盖 RUN_FINISHED 到 prompt 返回之间的收尾窗口——此时直接
      // POST 会被引擎拒绝（"Lane main already has an active run operation"，
      // 用户实报）。队列消息不进轮次投影；run 收尾后由 drainQueue 发出。
      let laneBusy = false
      try {
        laneBusy = await invoke<boolean>('pi_lane_busy')
      } catch (e) {
        // 查询失败不吞：记录后按 actor 状态判断；真正的 busy 由 RUN_ERROR 可见
        console.error('[pi] lane_busy 查询失败——按 actor 状态判断', e)
      }
      const streaming = actorRef.getSnapshot().matches('streaming')
      if (laneBusy || streaming) {
        // 交互行为 = 引导（ZCode「引导至下一轮工具调用后运行」）：把消息注入
        // 当前活跃 run 的 steer 队列（pi_steer → AgentLane::steer，引擎在
        // 下一次工具调用批后注入）。仅 **真活跃 run**（streaming + laneBusy）
        // 时走此路；收尾窗口/断流残留（lane 忙但 UI 已 idle）没有可注入的
        // run，仍按队列处理（下面的重试 drain 覆盖该窗口）。
        if (conversationDisplayStore.getState().interactionBehavior === 'guide' && streaming && laneBusy) {
          try {
            await invoke('pi_steer', {
              text: submission,
              ...(plan.images.length > 0 ? { images: plan.images } : {}),
            })
          } catch (e) {
            console.error('[pi] steer 注入失败', e)
            // 消息未发送：MessageNotSentError 让 assistant-ui 回填草稿与附件
            throw new MessageNotSentError(
              `[pi] 引导注入失败：${e instanceof Error ? e.message : String(e)}`,
            )
          }
          // steer 已入引擎队列：乐观用户消息进本轮投影（引擎注入后落成会话条目）
          actorRef.send({
            type: 'USER_SUBMIT',
            text,
            messageId: `user-${Date.now()}`,
            ...(plan.imageDataUrls.length > 0 ? { images: plan.imageDataUrls } : {}),
            ...(plan.files.length > 0 ? { files: plan.files } : {}),
          })
          void refreshThreads()
          return
        }
        sessionQueue
          .getState()
          .enqueue(sessionThreadKey(currentThreadIdRef.current), {
            id: `queued-${++queuedSeq}`,
            text,
            ...(submission !== text ? { submission } : {}),
            ...(plan.images.length > 0
              ? { images: plan.images, imageDataUrls: plan.imageDataUrls }
              : {}),
            ...(plan.files.length > 0 ? { files: plan.files } : {}),
          })
        // lane 忙但 **UI 已 idle**（收尾窗口/断流残留）：没有 run 收尾事件
        // 会来触发 drain，必须自己排一次重试——否则排队消息永远不发出。
        if (laneBusy && !streaming) {
          if (drainRetryRef.current === null) {
            drainRetryRef.current = window.setTimeout(() => {
              drainRetryRef.current = null
              void drainQueue()
            }, 500)
          }
        }
        return
      }
      // 「没有消息的会话不要落盘」（2026-11-26）：工作区草稿在这里才真正
      // 建会话（cwd 随 pi_new_session 传入）；普通 New Chat 的 ensure 仍由
      // agui POST 懒创建。
      await ensureDraftSession()
      // 乐观 USER_SUBMIT 落**本会话自己的 actor**（多会话并存：ensure 之后
      // currentThreadId 已定，闭包里的 actorRef 可能还是旧焦点——按键取）。
      const sendSessionId = currentThreadIdRef.current
      if (!sendSessionId) throw new MessageNotSentError('[pi] 会话创建失败——消息未发送')
      const sendKey = sessionThreadKey(sendSessionId)
      getOrCreateActor(sendKey, sendKey).send({
        type: 'USER_SUBMIT',
        text,
        messageId: `user-${Date.now()}`,
        ...(plan.imageDataUrls.length > 0 ? { images: plan.imageDataUrls } : {}),
        ...(plan.files.length > 0 ? { files: plan.files } : {}),
      })
      postRun(submission, plan.images)
      // 首条消息触发会话创建 → 线程列表出现当前会话
      void refreshThreads()
    },
    onEdit,
    onReload,
    onCancel: async () => {
      // §4.5：abort 是控制操作走 IPC；阻塞中的 prompt 观察 abort 信号收尾
      try {
        await invoke('pi_interrupt')
        // 中断成功置标记：run 收尾后 StoppedRun 展示中断态（新 run 开始清）
        actorRef.send({ type: 'CANCEL_MARK' })
      } catch (e) {
        console.error('[agui] interrupt 失败', e)
      }
    },
  })

  return (
    <RuntimeBoundary>
      <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>
    </RuntimeBoundary>
  )
}

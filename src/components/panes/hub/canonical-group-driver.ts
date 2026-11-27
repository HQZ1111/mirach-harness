/**
 * canonical 群聊驱动（宿主对偶：hermes `tui_gateway/hosted_room_driver.py` 的
 * 最小可用版）。
 *
 * ## 为什么在宿主前端
 *
 * canonical 房间的「网关驱动」在 hermes = 一个进程内的 driver，把 plan 出的
 * 成员任务在成员自己的会话里跑一轮、把结果写回房间事件日志。宿主的等价物：
 *
 * - **规划** = `groups_plan`（Rust hosted_rooms 的 plan_next_task，含成员
 *   prompt 全文）；
 * - **执行** = 后台 bot 泳道（`prompt.submit` → `pi_bot.rs`，成员会话按
 *   canonical 标题 `Group: <room_id>` 复用）；
 * - **写回** = `groups.driver_append`（Rust 校验 actor-kinds + 事件形状，
 *   写进 `hosted_room_events`）；
 * - **状态** = 本模块的活跃轮次表 → `groups.state.driver_status`
 *   （typing 行 / Round N / 停止按钮）。
 *
 * 事件坐标与 payload 形状必须过 `decision_engine::validate_events`（否则下一
 * 次 plan 会整体失败）：message.member = 坐标 + text；turn.settled = 坐标 +
 * seen_through_seq + message_event_id + passed；actor：member 用
 * `{kind:'member', id, profile}`，turn 系与 room.activity 用
 * `{kind:'gateway', id: authority_gateway_id}`。
 *
 * ## 与 hermes 的已知差距（如实标注，不假装）
 *
 * - 没有 driver 租约/fencing/indeterminate 恢复：应用重启 = 在途轮次丢失
 *   （重启后 `startCanonicalGroupDriver` 会把仍有待办讨论的房间重新驱动；
 *   引擎侧 task_lease 已接，driver 层消费面未接租约交接）。
 * - lead 路由（routing=lead）走通用成员轮：`groups_plan` 会把 lead 路由
 *   turn 当普通任务发（prompt 带 lead 指令），lead 的点名回复落日志后由
 *   决策引擎接力选人——与上游"路由答案永不广播"同机制；未单独实机验证。
 *   router(auto) 已实现（`routeCanonicalRoom`，一次廉价模型调用 →
 *   `room.routed`；失败按 bounded 收尾 `router_unsupported`）。
 * - 窗格（并列窗格）内 ask/审批卡不渲染：ApprovalCards/AskCards 是主会话
 *   单例订阅，后端注册表只扫前台邮箱——窗格里触发交互工具会等超时。
 */

// ── wire 形状 ───────────────────────────────────────────────────────────────

interface RoomMember {
  member_id: string
  profile: string
  handle?: string
  display_name?: string
  /** peer 成员的 pinned 目标（actor 校验要求 connection_id = peer_id）。 */
  target?: { kind?: string; peer_id?: string; installation_id?: string }
}

interface RoomState {
  room?: {
    room_id?: string
    authority_gateway_id?: string
    members?: RoomMember[]
    latest_seq?: number
  }
}

interface PlannedTask {
  task_id: string
  turn_id: string
  thread_id: string
  member_id: string
  member_index: number
  round_index: number
  seen_through_seq: number
  source_event_seq: number
  prompt: string
}

interface RoomPlan {
  status: string
  reason: string
  discussion_event_id?: null | string
  thread_id?: null | string
  task?: null | PlannedTask
}

interface ResumeMessage {
  role?: string
  text?: string
  content?: string
  display_kind?: string
}

interface RoomRun {
  roomId: string
  cancelled: boolean
  sessionId?: string
  memberId?: string
  /** 当前轮成员的 profile（远端成员按它解析路由——interrupt/审批也走对端）。 */
  profile?: string
  baseline?: number
  startedAt?: number
  task?: PlannedTask
  discussionEventId?: string | null
  threadId?: string | null
  /** 引擎 task_lease 身份（prompt.submit 后由 session.resume 回读）。 */
  engineTask?: { task_id: string; execution_generation: number }
  /** 在途审批（lane 的 pending_approval）→ canonical pending_actions。 */
  pending?: {
    request_id: string
    description?: string
    command?: string
    choices: string[]
  }
}

export interface CanonicalDriverStatus {
  working: boolean
  counts: Record<string, number>
  pending_actions: unknown[]
  member_activity: {
    member_id: string
    status: string
    started_at?: number
    thread_id?: string
    round_index?: number
  }[]
  max_rounds: null | number
}

// ── 状态表 ──────────────────────────────────────────────────────────────────

const runs = new Map<string, RoomRun>()
const listeners = new Set<() => void>()
let booted = false
/** bots 插件关闭时置 true：kick/start 不再驱动房间；在途 run 由
 *  stopCanonicalGroupDriver 逐个 cancel。 */
let driverDisabled = false

/** 本次应用内失败的任务（canonical Retry 用）：task_id → 任务坐标 + prompt。 */
const failedTasks = new Map<string, { task: PlannedTask; member: RoomMember; discussionId: string }>()
/** Retry 请求：房间 → 待强制重跑的任务（驱动循环优先消费）。 */
const retryQueue = new Map<string, { task: PlannedTask; member: RoomMember; discussionId: string }>()

/** 已 defer 的任务（hermes `turn.deferred` 非终态，等 Retry/Discard）：
 *  task_id → 坐标 + 原因 + 代际。`pending_actions` 用它给 workspace 出 Retry 卡。 */
const deferredTasks = new Map<
  string,
  { roomId: string; task: PlannedTask; member: RoomMember; discussionId: string; error: string; generation: number }
>()

/**
 * 事件日志里该 task 的最新终态若是 `turn.deferred`，返回其代际；否则 null。
 *
 * 两个用途：
 *  · 重启后内存表为空——靠日志知道"这条轮次还在等重试"，不重新开跑；
 *  · 连续 defer 必须**代际递增**（Rust decision_engine 硬校验），generation
 *    从日志里的上一条 deferred 取最大值 +1。
 */
async function pendingDeferredGeneration(
  roomId: string,
  taskId: string,
  sinceSeq = 0,
): Promise<null | number> {
  const res = await invoke<{
    events?: { kind?: string; payload?: Record<string, unknown> }[]
  }>('groups_dispatch', {
    method: 'groups.log',
    // since_seq 用任务的 seen_through_seq：deferred 一定在该用户消息之后，
    // 不会因为长房间的 500 条窗口截断而漏看（limit 上限 = 500）。
    params: { room_id: roomId, since_seq: sinceSeq, limit: 500 },
  })
  let generation: null | number = null
  for (const event of res.events ?? []) {
    const payload = event.payload
    if (!payload || payload.task_id !== taskId) continue
    if (event.kind === 'turn.deferred') {
      const value = Number(payload.execution_generation)
      if (Number.isSafeInteger(value) && value > 0) generation = value
    } else if (
      event.kind === 'turn.settled' ||
      event.kind === 'turn.failed' ||
      event.kind === 'turn.cancelled'
    ) {
      generation = null
    }
  }
  return generation
}

function notify(): void {
  for (const listener of listeners) listener()
}

export function subscribeCanonicalDriver(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function canonicalDriverStatus(roomId: string): CanonicalDriverStatus {
  const run = runs.get(roomId)
  const activity = run?.memberId && run.startedAt
    ? [{
        member_id: run.memberId,
        status: 'running',
        started_at: run.startedAt,
        ...(run.task?.thread_id ? { thread_id: run.task.thread_id } : {}),
        ...(typeof run.task?.round_index === 'number' ? { round_index: run.task.round_index } : {}),
      }]
    : []
  const pendingActions = run?.pending && run.memberId && run.task
    ? [{
        kind: 'approval',
        member_id: run.memberId,
        task_id: run.task.task_id,
        execution_generation: 1,
        request_id: run.pending.request_id,
        approval: {
          request_id: run.pending.request_id,
          command: run.pending.command,
          description: run.pending.description,
          // canonical UI 只发 once/deny；lane 的 session/always 选项不外露。
          choices: run.pending.choices.filter((c) => c === 'once' || c === 'deny'),
        },
      }]
    : []
  const deferredActions = [...deferredTasks.values()]
    .filter((entry) => entry.roomId === roomId)
    .map((entry) => ({
      // workspace 的 CanonicalPendingCard 对 kind='retry' 渲染「重试」按钮；
      // execution_generation 必须带上（actions 的 key 与 groups.retry 参数）。
      kind: 'retry',
      member_id: entry.member.member_id,
      task_id: entry.task.task_id,
      execution_generation: entry.generation,
    }))
  return {
    working: Boolean(run),
    // 全 0/空 = workspace 的 stopConfirmed 判定成立（无 stopping/deferred 残留）。
    counts: deferredActions.length > 0 ? { deferred: deferredActions.length } : {},
    pending_actions: [...pendingActions, ...deferredActions],
    member_activity: activity,
    max_rounds: null,
  }
}

// ── RPC 薄层（动态 import 破 host-rpc ↔ driver 的循环）──────────────────────

async function request<T>(method: string, params: Record<string, unknown>): Promise<T> {
  const { dispatchHostRequest } = await import('@/sdk/host-rpc')
  return dispatchHostRequest<T>(method, params)
}

/** 成员 profile 的路由：远端名册里命中 → remote 路由对象；否则 null（本地）。 */
async function memberRoute(profile: string): Promise<null | { route: unknown }> {
  if (!profile) return null
  try {
    const { host } = await import('@/sdk/host')
    const routes = await host.profileRoutes()
    const route = routes.find((row) => row.profile === profile || row.targetProfile === profile)
    if (route?.mode === 'remote') return { route }
  } catch (e) {
    // 名册不可达时不能静默把远端成员跑成本地同名会话（规矩 12）：报错让
    // 本轮失败并显示在房间活动行，而不是制造假回复。
    console.error('[canonical-driver] 解析成员路由失败', e)
    throw e
  }
  return null
}

/**
 * hermes `member_roster` / `refuse_unseatable` 的宿主对偶（2026-11-23）：
 * 群聊成员记录独立于机器人名册——profile 被删除后，房间仍保留成员行，
 * 但**不能再把该 profile 拉起来**（`ensure_profile_dirs` 会重建目录，
 * 等于让已删 bot 复活）。远端 peer 成员走路由，不查本地名册。返回非空
 * 字符串 = 本轮必须失败（`member_unavailable`，可见）。
 */
async function memberUnavailableReason(member: RoomMember): Promise<null | string> {
  if (!member.profile) return '房间成员缺少 profile'
  if (member.target?.kind === 'peer') return null
  const remote = await memberRoute(member.profile)
  if (remote) return null

  const { botsStore } = await import('@/components/panes/hub/bots-store')
  if (!botsStore.getState().bots.length) botsStore.getState().load()
  if (!botsStore.getState().bots.some((bot) => bot.name === member.profile)) {
    return `机器人「${member.profile}」已不在机器人名册（profile 已删除）`
  }

  return null
}

/** 成员 RPC：远端成员走 `pi_gateway_call`（Desktop 驱动跨网关模式），本地走分发表。
 *  远端调用剥离宿主私有参数（`room_plumbing` / `task_meta`——hermes 网关会拒绝未知字段）。 */
async function memberRequest<T>(
  profile: string,
  method: string,
  params: Record<string, unknown>,
  timeoutMs?: number,
): Promise<T> {
  const remote = await memberRoute(profile)
  if (remote) {
    const { host } = await import('@/sdk/host')
    const sanitized = Object.fromEntries(
      Object.entries(params).filter(([key]) => key !== 'room_plumbing' && key !== 'task_meta'),
    )
    return host.requestProfile<T>(remote.route, method, sanitized, timeoutMs)
  }
  return request<T>(method, params)
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke: tauriInvoke } = await import('@tauri-apps/api/core')
  return tauriInvoke<T>(cmd, args)
}

function eventId(): string {
  return `evt-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
}

async function readRoomState(roomId: string): Promise<RoomState> {
  return invoke<RoomState>('groups_dispatch', { method: 'groups.state', params: { room_id: roomId } })
}

async function planRoom(roomId: string): Promise<RoomPlan> {
  return invoke<RoomPlan>('groups_plan', { roomId })
}

async function appendEvent(
  roomId: string,
  kind: string,
  actor: Record<string, unknown>,
  payload: Record<string, unknown>,
): Promise<void> {
  await invoke('groups_dispatch', {
    method: 'groups.driver_append',
    params: { room_id: roomId, event_id: eventId(), kind, actor, payload },
  })
}

function coordinates(task: PlannedTask, discussionEventId: string): Record<string, unknown> {
  return {
    discussion_event_id: discussionEventId,
    member_id: task.member_id,
    member_index: task.member_index,
    round_index: task.round_index,
    task_id: task.task_id,
    thread_id: task.thread_id,
    turn_id: task.turn_id,
  }
}

// ── 成员会话 ────────────────────────────────────────────────────────────────
//
// 每个成员一棵会话：上游是「每 profile 一个 `Group: <room_id>`」（profile 目录
// 天然隔离）；宿主单 profile，标题必须带成员名，否则两个成员共用一个会话
// （实测：第二个成员的 prompt 进第一个成员的上下文，回复互相污染）。

function sessionTitle(roomId: string, profile: string): string {
  return `Group: ${roomId} · ${profile}`
}

/** 按标题复用/新建一个 room_plumbing 会话（成员会话与 router 会话共用）。
 *  远端成员：resume/create 走对端网关（Desktop 驱动跨网关模式）。 */
async function ensureSessionByTitle(title: string, profile: string): Promise<string> {
  try {
    const resumed = await memberRequest<{ session_id?: string }>(profile, 'session.resume', {
      session_id: title,
      profile,
      omit_messages: true,
    })
    if (resumed?.session_id) return resumed.session_id
  } catch (e) {
    // 会话不存在 → 建。本地是结构化 4007；远端是网关错误文本（含
    // "session not found"/不存在）——两类都只放行"确实不存在"，其它照抛。
    const err = e as { code?: number; data?: { code?: number; reason?: string }; message?: string }
    const missing =
      err?.code === 4007 ||
      err?.data?.code === 4007 ||
      err?.data?.reason === 'not_found' ||
      /session[_ ]?not[_ ]?found|not found|不存在|\[4007\]/i.test(String(err?.message ?? e))
    if (!missing) throw e
  }
  const created = await memberRequest<{ session_id?: string }>(profile, 'session.create', {
    profile,
    title,
    room_plumbing: true,
  })
  if (!created?.session_id) throw new Error('canonical driver: session.create 未返回 session_id')
  return created.session_id
}

async function ensureMemberSession(roomId: string, profile: string): Promise<string> {
  return ensureSessionByTitle(sessionTitle(roomId, profile), profile)
}

async function resumeSnapshot(sessionId: string, profile: string): Promise<{
  running?: boolean
  messages?: ResumeMessage[]
  pending_approval?: unknown
  task?: { task_id?: string; execution_generation?: number } | null
  recovered_tasks?: {
    task_id?: string
    execution_generation?: number
    status?: string
    error?: string
    meta?: Record<string, unknown> | null
  }[]
}> {
  return memberRequest(profile, 'session.resume', { session_id: sessionId, profile })
}

// ── 一轮成员轮次 ────────────────────────────────────────────────────────────

const PASS_RE = /^\(?\s*pass\s*\)?\.?$/i

type TurnOutcome =
  | { kind: 'replied'; text: string }
  | { kind: 'passed' }
  /** 成员不可用（profile 已删）等**可重试**情形：hermes 语义 = `turn.deferred`
   *  （reason `member_unavailable`），不是 failed——房间等 Retry/Discard。 */
  | { kind: 'deferred'; error: string; reasonCode: string }
  | { kind: 'failed'; error: string; reasonCode?: string }

async function runMemberTurn(
  run: RoomRun,
  task: PlannedTask,
  member: RoomMember,
): Promise<TurnOutcome> {
  const unavailable = await memberUnavailableReason(member)
  if (unavailable) return { kind: 'deferred', error: unavailable, reasonCode: 'member_unavailable' }

  const sessionId = await ensureMemberSession(run.roomId, member.profile)
  run.sessionId = sessionId

  const before = await resumeSnapshot(sessionId, member.profile)
  const baseline = Array.isArray(before.messages) ? before.messages.length : 0
  // 引擎 task_lease 的启动恢复：上次进程死在轮次中 → indeterminate 记录
  // （meta 里存了房间坐标）。如实写 turn.failed，不静默丢。
  for (const record of before.recovered_tasks ?? []) {
    const meta = record.meta
    if (!meta || meta.room_id !== run.roomId || typeof meta.discussion_event_id !== 'string') {
      continue
    }
    try {
      await appendEvent(
        run.roomId,
        'turn.failed',
        { kind: 'gateway', id: '' },
        {
          discussion_event_id: meta.discussion_event_id,
          member_id: meta.member_id,
          member_index: meta.member_index,
          round_index: meta.round_index,
          task_id: meta.task_id,
          thread_id: meta.thread_id,
          turn_id: meta.turn_id,
          seen_through_seq: meta.seen_through_seq,
          error: record.error || '应用重启时该轮次状态未知（indeterminate）',
          reason_code: 'indeterminate',
        },
      )
    } catch (e) {
      console.error('[canonical-driver] indeterminate 轮次回写失败', e)
    }
  }
  run.baseline = baseline
  run.memberId = task.member_id
  run.profile = member.profile
  run.startedAt = Date.now()
  notify()

  await memberRequest(member.profile, 'prompt.submit', {
    session_id: sessionId,
    text: task.prompt,
    profile: member.profile,
    // 引擎任务租约元数据（room 坐标随任务落盘，重启恢复时用）。
    // 远端成员：memberRequest 会剥掉 task_meta（hermes 网关不收宿主私有字段）。
    task_meta: {
      room_id: run.roomId,
      discussion_event_id: run.discussionEventId ?? null,
      thread_id: task.thread_id,
      task_id: task.task_id,
      turn_id: task.turn_id,
      round_index: task.round_index,
      member_id: task.member_id,
      member_index: task.member_index,
      seen_through_seq: task.seen_through_seq,
    },
  })

  // 轮询到不忙为止（rpi 的 run 失败在消息里留 failed_turn 行；lane 层
  // last_error 为空时以消息为准）。
  for (;;) {
    if (run.cancelled) return { kind: 'failed', error: 'been cancelled' }
    await new Promise((resolve) => setTimeout(resolve, 1500))
    let snapshot: Awaited<ReturnType<typeof resumeSnapshot>>
    try {
      snapshot = await resumeSnapshot(sessionId, member.profile)
    } catch (e) {
      return { kind: 'failed', error: e instanceof Error ? e.message : String(e) }
    }
    if (snapshot.task?.task_id && typeof snapshot.task.execution_generation === 'number') {
      run.engineTask = {
        task_id: snapshot.task.task_id,
        execution_generation: snapshot.task.execution_generation,
      }
    }
    // 审批阻塞：把 lane 的 pending_approval 投影成 canonical pending action，
    // 轮次继续等（用户 once/deny 后 lane 继续跑）。
    const approval = snapshot.pending_approval
    if (approval && typeof approval === 'object' && !Array.isArray(approval)) {
      const row = approval as Record<string, unknown>
      const requestId = typeof row.request_id === 'string' ? row.request_id : ''
      if (requestId) {
        run.pending = {
          request_id: requestId,
          description: typeof row.description === 'string' ? row.description : undefined,
          command: typeof row.command === 'string' ? row.command : undefined,
          choices: Array.isArray(row.choices) ? row.choices.filter((c): c is string => typeof c === 'string') : ['once', 'deny'],
        }
        notify()
      }
    } else if (run.pending) {
      delete run.pending
      notify()
    }
    if (snapshot.running) continue

    const fresh = (snapshot.messages ?? []).slice(baseline)
    const failure = fresh.find((row) => row.display_kind === 'failed_turn')
    if (failure) {
      return { kind: 'failed', error: failure.text || failure.content || '本轮失败（无详情）' }
    }
    const replies = fresh
      .filter((row) => row.role === 'assistant')
      .map((row) => String(row.text ?? row.content ?? '').trim())
      .filter(Boolean)
    const last = replies[replies.length - 1]
    if (!last) return { kind: 'passed' }
    return PASS_RE.test(last) ? { kind: 'passed' } : { kind: 'replied', text: last }
  }
}

// ── 驱动循环 ────────────────────────────────────────────────────────────────

/**
 * routing=auto：一次廉价模型调用选出下一轮应答者（hermes `hosted_room_router`
 * 的宿主对偶）。答案按 `router::routed_payload` 的形状写 `room.routed`
 * （event_id = `droute:<discussion>`，member_ids/everyone/fallback 同上游）。
 * 调用/解析失败返回 false（调用方按 bounded 收尾），错误 console 可见。
 */
async function routeCanonicalRoom(
  run: RoomRun,
  room: NonNullable<RoomState['room']>,
  discussionId: string,
  threadId: string,
): Promise<boolean> {
  const members = room.members ?? []
  if (!members.length) return false
  try {
    const log = await invoke<{ events?: { kind?: string; payload?: Record<string, unknown> }[] }>(
      'groups_dispatch',
      { method: 'groups.log', params: { room_id: run.roomId, since_seq: 0, limit: 200 } },
    )
    const membersById = new Set(members.map((m) => m.member_id))
    const lines: string[] = []
    for (const event of log?.events ?? []) {
      const payload = event.payload ?? {}
      if (event.kind === 'message.user') lines.push(`User: ${String(payload.text ?? '')}`)
      if (event.kind === 'message.member') lines.push(`${String(payload.member_id ?? '')}: ${String(payload.text ?? '')}`)
    }
    const roster = members.map((m) => `${m.member_id} (${m.handle ?? m.member_id})`).join(', ')
    const prompt = [
      'You are the router for a group chat. Pick which participants should reply next.',
      `Participants: ${roster}`,
      'Recent messages:',
      ...lines.slice(-20),
      '',
      'Reply with ONE JSON object only: {"member_ids":["<member_id>", ...]} or {"everyone":true}.',
      'Choose the member(s) most relevant to the latest messages; pick one unless several are explicitly addressed.',
    ].join('\n')

    const profile = members[0].profile
    const sessionId = await ensureSessionByTitle(`Router: ${run.roomId}`, profile)
    const before = await resumeSnapshot(sessionId, profile)
    const baseline = Array.isArray(before.messages) ? before.messages.length : 0
    await request('prompt.submit', { session_id: sessionId, text: prompt, profile })

    let reply = ''
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 1200))
      const snapshot = await resumeSnapshot(sessionId, profile)
      if (snapshot.running) continue
      const fresh = (snapshot.messages ?? []).slice(baseline)
      const texts = fresh
        .filter((row) => row.role === 'assistant')
        .map((row) => String(row.text ?? row.content ?? '').trim())
        .filter(Boolean)
      reply = texts[texts.length - 1] ?? ''
      break
    }
    const match = reply.match(/\{[\s\S]*\}/)
    if (!match) throw new Error(`router 输出不是 JSON: ${reply.slice(0, 120)}`)
    const parsed = JSON.parse(match[0]) as { member_ids?: unknown; everyone?: unknown }
    const names = Array.isArray(parsed.member_ids)
      ? parsed.member_ids.filter((id): id is string => typeof id === 'string' && membersById.has(id))
      : []
    const everyone = parsed.everyone === true || names.length === 0
    await invoke('groups_dispatch', {
      method: 'groups.driver_append',
      params: {
        room_id: run.roomId,
        event_id: `droute:${discussionId}`,
        kind: 'room.routed',
        actor: { kind: 'gateway', id: room.authority_gateway_id ?? '' },
        payload: {
          discussion_event_id: discussionId,
          thread_id: threadId,
          member_ids: everyone ? [] : names,
          everyone,
          fallback: everyone,
        },
      },
    })
    return true
  } catch (e) {
    console.error('[canonical-driver] router 调用失败——按 bounded 收尾', e)
    return false
  }
}

async function executeMemberTask(
  run: RoomRun,
  room: NonNullable<RoomState['room']>,
  task: PlannedTask,
  discussionId: string,
  member: RoomMember,
): Promise<'done' | 'cancelled' | 'deferred'> {
  const gatewayActor: Record<string, unknown> = { kind: 'gateway', id: room.authority_gateway_id ?? '' }
  const memberActor: Record<string, unknown> = {
    kind: 'member',
    id: member.member_id,
    profile: member.profile,
    // peer 成员：Rust `DiscussionMember::actor` 带 connection_id = peer_id，
    // 缺它 message.member 会在下一次 validate_events 里被拒
    //（"actor does not match roster"）。
    ...(member.target?.kind === 'peer' && member.target.peer_id
      ? { connection_id: member.target.peer_id }
      : {}),
  }

  run.task = task
  run.discussionEventId = discussionId
  run.threadId = task.thread_id ?? null
  run.memberId = task.member_id
  run.startedAt = Date.now()
  notify()

  const outcome = await runMemberTurn(run, task, member)
  run.memberId = undefined
  run.startedAt = undefined
  delete run.pending
  notify()

  if (run.cancelled) {
    await appendEvent(run.roomId, 'turn.cancelled', gatewayActor, {
      ...coordinates(task, discussionId),
      seen_through_seq: task.seen_through_seq,
      reason: 'stopped',
    })
    return 'cancelled'
  }

  if (outcome.kind === 'replied') {
    deferredTasks.delete(task.task_id)
    const messageEventId = eventId()
    await invoke('groups_dispatch', {
      method: 'groups.driver_append',
      params: {
        room_id: run.roomId,
        event_id: messageEventId,
        kind: 'message.member',
        actor: memberActor,
        payload: { ...coordinates(task, discussionId), text: outcome.text },
      },
    })
    await appendEvent(run.roomId, 'turn.settled', gatewayActor, {
      ...coordinates(task, discussionId),
      seen_through_seq: task.seen_through_seq,
      message_event_id: messageEventId,
      passed: false,
    })
  } else if (outcome.kind === 'passed') {
    deferredTasks.delete(task.task_id)
    await appendEvent(run.roomId, 'turn.settled', gatewayActor, {
      ...coordinates(task, discussionId),
      seen_through_seq: task.seen_through_seq,
      message_event_id: null,
      passed: true,
    })
  } else if (outcome.kind === 'deferred') {
    // hermes 语义：成员不可用 = `turn.deferred`（**非终态**），房间停在
    // 这里等 Retry / Discard；同 task 的重复 defer 代际必须递增。
    const prior = await pendingDeferredGeneration(run.roomId, task.task_id, task.seen_through_seq)
    const generation = Math.max(prior ?? 0, deferredTasks.get(task.task_id)?.generation ?? 0) + 1
    deferredTasks.set(task.task_id, {
      roomId: run.roomId,
      task,
      member,
      discussionId,
      error: outcome.error,
      generation,
    })
    await appendEvent(run.roomId, 'turn.deferred', gatewayActor, {
      ...coordinates(task, discussionId),
      seen_through_seq: task.seen_through_seq,
      execution_generation: generation,
      reason: outcome.reasonCode,
    })
    notify()
    return 'deferred'
  } else {
    // 保留失败任务的 prompt/成员，供 canonical 的 Retry 重跑。
    deferredTasks.delete(task.task_id)
    failedTasks.set(task.task_id, { task, member, discussionId })
    await appendEvent(run.roomId, 'turn.failed', gatewayActor, {
      ...coordinates(task, discussionId),
      seen_through_seq: task.seen_through_seq,
      error: outcome.error,
      reason_code: outcome.reasonCode ?? 'turn_failed',
    })
  }
  return 'done'
}

async function driveRoom(roomId: string): Promise<void> {
  if (runs.has(roomId)) return
  const run: RoomRun = { roomId, cancelled: false }
  runs.set(roomId, run)
  notify()

  try {
    for (;;) {
      if (run.cancelled) break

      const state = await readRoomState(roomId)
      const room = state.room
      if (!room || room.room_id !== roomId) throw new Error(`driver: 房间 ${roomId} 读不到`)

      // Retry：用户按「重试」后优先重跑该成员的任务（坐标不变）。
      const forced = retryQueue.get(roomId)
      if (forced) {
        retryQueue.delete(roomId)
        const result = await executeMemberTask(run, room, forced.task, forced.discussionId, forced.member)
        if (result === 'cancelled' || result === 'deferred') break
        continue
      }

      const plan = await planRoom(roomId)

      if (plan.status !== 'task' || !plan.task) {
        const threadId = plan.thread_id ?? ''
        const discussionId = plan.discussion_event_id ?? ''
        const gatewayActor: Record<string, unknown> = { kind: 'gateway', id: room.authority_gateway_id ?? '' }
        if (plan.status === 'route') {
          // routing=auto：用一次廉价模型调用决定谁来接（hermes
          // hosted_room_router 的宿主对偶）。失败/无法解析 → 按 bounded 收尾。
          const routed = await routeCanonicalRoom(run, room, discussionId, threadId)
          if (routed) continue
          await appendEvent(roomId, 'room.activity', gatewayActor, {
            status: 'bounded',
            reason_code: 'router_unsupported',
            thread_id: threadId,
            discussion_event_id: discussionId,
          })
          break
        }
        if (plan.status === 'settled') {
          await appendEvent(roomId, 'room.activity', gatewayActor, {
            status: 'settled',
            reason_code: plan.reason || 'silent_round',
            thread_id: threadId,
            discussion_event_id: discussionId,
          })
        } else if (plan.status === 'bounded') {
          await appendEvent(roomId, 'room.activity', gatewayActor, {
            status: 'bounded',
            reason_code: plan.reason || 'max_rounds',
            thread_id: threadId,
            discussion_event_id: discussionId,
          })
        }
        break
      }

      const task = plan.task
      const discussionId = plan.discussion_event_id ?? ''
      if (!discussionId) {
        console.error('[canonical-driver] plan 给了 task 但缺 discussion_event_id——无法写回坐标')
        break
      }

      const member = (room.members ?? []).find((m) => m.member_id === task.member_id)
      if (!member?.profile) {
        await appendEvent(roomId, 'turn.failed', {
          kind: 'gateway',
          id: room.authority_gateway_id ?? '',
        }, {
          ...coordinates(task, discussionId),
          seen_through_seq: task.seen_through_seq,
          error: `房间名册里找不到成员 ${task.member_id}`,
          reason_code: 'member_unavailable',
        })
        break
      }

      // 同一 task 已有待处理的 turn.deferred（内存表或重启后的日志）→ 房间
      // 暂停等 Retry/Discard，不重复跑成员、不重复写 defer（hermes deferred
      // 不是终态；代际只能在新 retry 后递增）。
      const pendingDeferral = await pendingDeferredGeneration(roomId, task.task_id, task.seen_through_seq)
      if (pendingDeferral !== null) break

      const result = await executeMemberTask(run, room, task, discussionId, member)
      if (result === 'cancelled' || result === 'deferred') break
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    console.error('[canonical-driver] 驱动失败（房间保持现状，下次发送/启动会重试）', roomId, e)
    // 用户可见（2026-11-26："群聊也是，而且任何错误提示都没有"）：驱动
    // 失败过去只落 console，房间停在"运行中"没有任何提示。
    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('mirach:toast', {
          detail: {
            kind: 'error',
            title: '群聊驱动失败',
            message,
            persistent: true,
          },
        }),
      )
    }
  } finally {
    runs.delete(roomId)
    notify()
  }
}

// ── 对外 ────────────────────────────────────────────────────────────────────

/** 房间有新意图时踢一次驱动（幂等：已在跑就忽略）。 */
export function kickCanonicalRoom(roomId: string): void {
  if (driverDisabled) return
  void driveRoom(roomId)
}

/** 停止：打断在途成员轮次并让驱动收尾（turn.cancelled + 退出循环）。 */
export async function stopCanonicalRoom(roomId: string): Promise<void> {
  const run = runs.get(roomId)
  if (!run) return
  run.cancelled = true
  notify()
  if (run.sessionId) {
    try {
      if (run.engineTask) {
        // 引擎租约的带 fencing 中断：只有精确 task/generation 才生效（本地成员）。
        await request('task.interrupt', {
          session_id: run.sessionId,
          task_id: run.engineTask.task_id,
          execution_generation: run.engineTask.execution_generation,
        })
      } else {
        // 远端成员（无宿主租约）走对端网关的 session.interrupt。
        await memberRequest(run.profile ?? '', 'session.interrupt', { session_id: run.sessionId })
      }
    } catch (e) {
      console.error('[canonical-driver] 中断成员会话失败（驱动仍会退出）', e)
    }
  }
}

/** 审批答复（canonical `groups.approve` → lane `approval.respond`）。 */
export async function approveCanonicalAction(
  roomId: string,
  requestId: string,
  choice: string,
): Promise<void> {
  const run = runs.get(roomId)
  if (!run?.sessionId) throw new Error('没有在途成员轮次可审批')
  await memberRequest(run.profile ?? '', 'approval.respond', {
    session_id: run.sessionId,
    request_id: requestId,
    choice,
  })
  if (run.pending?.request_id === requestId) {
    delete run.pending
    notify()
  }
}

/**
 * Retry：重跑失败/推迟（deferred）的成员任务（坐标不变，结果写回原坐标）。
 * 应用重启后失败任务的 prompt 已不在内存——deferred 由启动扫描从日志重建
 * （member_unavailable 可跨重启重试）；两者都没有时明确报错，不假装能重试。
 */
export function retryCanonicalTask(roomId: string, memberId: string, taskId: string): void {
  const failed = failedTasks.get(taskId)
  const deferred = deferredTasks.get(taskId)
  const entry = failed ?? deferred
  if (!entry || entry.member.member_id !== memberId) {
    throw new Error('这张卡已不可重试（应用重启后仅保留日志；再发一条消息让房间继续）')
  }
  retryQueue.set(roomId, { task: entry.task, member: entry.member, discussionId: entry.discussionId })
  kickCanonicalRoom(roomId)
}

/** Discard：把失败/推迟的任务标成 cancelled，从当前轮次里收起。 */
export async function discardCanonicalTask(
  roomId: string,
  memberId: string,
  taskId: string,
): Promise<void> {
  const failed = failedTasks.get(taskId)
  const deferred = deferredTasks.get(taskId)
  const entry = failed ?? deferred
  if (!entry || entry.member.member_id !== memberId) {
    throw new Error('这张卡已不可丢弃（应用重启后仅保留日志）')
  }
  const state = await readRoomState(roomId)
  const gateway = state.room?.authority_gateway_id ?? ''
  await appendEvent(roomId, 'turn.cancelled', { kind: 'gateway', id: gateway }, {
    ...coordinates(entry.task, entry.discussionId),
    seen_through_seq: entry.task.seen_through_seq,
    reason: 'discarded',
  })
  failedTasks.delete(taskId)
  deferredTasks.delete(taskId)
  // 收起后让房间继续（plan 看到 cancelled 终态就会推进）。
  kickCanonicalRoom(roomId)
}

/**
 * 应用启动时的恢复扫描：仍在跑的讨论（plan 给 task）重新驱动。
 * 由 `startBundledPlugins` 在插件注册完成后调用一次。
 */export async function startCanonicalGroupDriver(): Promise<void> {
  if (booted) return
  booted = true
  driverDisabled = false
  try {
    const list = await invoke<{ rooms?: { room_id?: string; disbanded_at?: unknown }[] }>('groups_dispatch', {
      method: 'groups.list',
      params: { limit: 50 },
    })
    for (const room of list?.rooms ?? []) {
      const roomId = room?.room_id
      if (!roomId || room.disbanded_at) continue
      // 逐房间隔离：历史/夹具房间可能没有宿主 profile（plan 报错）——
      // 一个坏房间不能拖垮整次恢复扫描。
      try {
        const plan = await planRoom(roomId)
        if (plan.status !== 'task' || !plan.task) continue
        // deferred 轮次（成员已删）不是终态：重启后从日志重建「等重试」表，
        // 让 workspace 继续显示 Retry 卡；不要重新开跑。
        const generation = await pendingDeferredGeneration(roomId, plan.task.task_id, plan.task.seen_through_seq)
        if (generation !== null) {
          const state = await readRoomState(roomId)
          const member = (state.room?.members ?? []).find((m) => m.member_id === plan.task?.member_id)
          const discussionId = plan.discussion_event_id
          if (member && discussionId) {
            deferredTasks.set(plan.task.task_id, {
              roomId,
              task: plan.task,
              member,
              discussionId,
              error: `机器人「${member.profile}」已不在机器人名册（profile 已删除）`,
              generation,
            })
            continue
          }
        }
        kickCanonicalRoom(roomId)
      } catch (e) {
        console.warn(`[canonical-driver] 房间 ${roomId} 恢复扫描跳过`, e)
      }
    }
  } catch (e) {
    console.error('[canonical-driver] 启动恢复扫描失败', e)
  }
}

/** bots 插件关闭：停止恢复扫描的后续驱动，并取消在途成员轮次。 */
export function stopCanonicalGroupDriver(): void {
  driverDisabled = true
  booted = false
  for (const roomId of [...runs.keys()]) void stopCanonicalRoom(roomId)
}

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
 *   （重启后 `startCanonicalGroupDriver` 会把仍有待办讨论的房间重新驱动）。
 * - router（routing=auto）与 lead 路由不调模型：遇到 `route` 计划会把房间
 *   按 bounded 收尾（reason_code `router_unsupported`）。
 * - retry/discard（Rust 侧要求 driver 租约）暂不可用；approvals 不桥接。
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

/** 本次应用内失败的任务（canonical Retry 用）：task_id → 任务坐标 + prompt。 */
const failedTasks = new Map<string, { task: PlannedTask; member: RoomMember; discussionId: string }>()
/** Retry 请求：房间 → 待强制重跑的任务（驱动循环优先消费）。 */
const retryQueue = new Map<string, { task: PlannedTask; member: RoomMember; discussionId: string }>()

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
  return {
    working: Boolean(run),
    // 全 0/空 = workspace 的 stopConfirmed 判定成立（无 stopping/deferred 残留）。
    counts: {},
    pending_actions: pendingActions,
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
      /session not found|not found|不存在|\[4007\]/i.test(String(err?.message ?? e))
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
  | { kind: 'failed'; error: string }

async function runMemberTurn(
  run: RoomRun,
  task: PlannedTask,
  member: RoomMember,
): Promise<TurnOutcome> {
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
): Promise<'done' | 'cancelled'> {
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
    await appendEvent(run.roomId, 'turn.settled', gatewayActor, {
      ...coordinates(task, discussionId),
      seen_through_seq: task.seen_through_seq,
      message_event_id: null,
      passed: true,
    })
  } else {
    // 保留失败任务的 prompt/成员，供 canonical 的 Retry 重跑。
    failedTasks.set(task.task_id, { task, member, discussionId })
    await appendEvent(run.roomId, 'turn.failed', gatewayActor, {
      ...coordinates(task, discussionId),
      seen_through_seq: task.seen_through_seq,
      error: outcome.error,
      reason_code: 'turn_failed',
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
        if (result === 'cancelled') break
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

      const result = await executeMemberTask(run, room, task, discussionId, member)
      if (result === 'cancelled') break
    }
  } catch (e) {
    console.error('[canonical-driver] 驱动失败（房间保持现状，下次发送/启动会重试）', roomId, e)
  } finally {
    runs.delete(roomId)
    notify()
  }
}

// ── 对外 ────────────────────────────────────────────────────────────────────

/** 房间有新意图时踢一次驱动（幂等：已在跑就忽略）。 */
export function kickCanonicalRoom(roomId: string): void {
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
 * Retry：重跑本次应用内失败的任务（坐标不变，重跑结果写回同一 (round, member)）。
 * 应用重启后失败任务的 prompt 已不在内存——明确报错，不假装能重试。
 */
export function retryCanonicalTask(roomId: string, memberId: string, taskId: string): void {
  const entry = failedTasks.get(taskId)
  if (!entry || entry.member.member_id !== memberId) {
    throw new Error('这张失败卡已不可重试（应用重启后仅保留日志；再发一条消息让房间继续）')
  }
  retryQueue.set(roomId, entry)
  kickCanonicalRoom(roomId)
}

/** Discard：把失败任务标成 cancelled，从当前轮次里收起。 */
export async function discardCanonicalTask(
  roomId: string,
  memberId: string,
  taskId: string,
): Promise<void> {
  const entry = failedTasks.get(taskId)
  if (!entry || entry.member.member_id !== memberId) {
    throw new Error('这张失败卡已不可丢弃（应用重启后仅保留日志）')
  }
  const state = await readRoomState(roomId)
  const gateway = state.room?.authority_gateway_id ?? ''
  await appendEvent(roomId, 'turn.cancelled', { kind: 'gateway', id: gateway }, {
    ...coordinates(entry.task, entry.discussionId),
    seen_through_seq: entry.task.seen_through_seq,
    reason: 'discarded',
  })
  failedTasks.delete(taskId)
}

/**
 * 应用启动时的恢复扫描：仍在跑的讨论（plan 给 task）重新驱动。
 * 由 `startBundledPlugins` 在插件注册完成后调用一次。
 */export async function startCanonicalGroupDriver(): Promise<void> {
  if (booted) return
  booted = true
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
        if (plan.status === 'task') kickCanonicalRoom(roomId)
      } catch (e) {
        console.warn(`[canonical-driver] 房间 ${roomId} 恢复扫描跳过`, e)
      }
    }
  } catch (e) {
    console.error('[canonical-driver] 启动恢复扫描失败', e)
  }
}

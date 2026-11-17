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
  baseline?: number
  startedAt?: number
  task?: PlannedTask
  discussionEventId?: string | null
  threadId?: string | null
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
  return {
    working: Boolean(run),
    // 全 0/空 = workspace 的 stopConfirmed 判定成立（无 stopping/deferred 残留）。
    counts: {},
    pending_actions: [],
    member_activity: activity,
    max_rounds: null,
  }
}

// ── RPC 薄层（动态 import 破 host-rpc ↔ driver 的循环）──────────────────────

async function request<T>(method: string, params: Record<string, unknown>): Promise<T> {
  const { dispatchHostRequest } = await import('@/sdk/host-rpc')
  return dispatchHostRequest<T>(method, params)
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

const roomSessionTitles = new Map<string, string>()

function sessionTitle(roomId: string): string {
  const known = roomSessionTitles.get(roomId)
  if (known) return known
  const title = `Group: ${roomId}`
  roomSessionTitles.set(roomId, title)
  return title
}

async function ensureMemberSession(roomId: string, profile: string): Promise<string> {
  const title = sessionTitle(roomId)
  try {
    const resumed = await request<{ session_id?: string }>('session.resume', {
      session_id: title,
      profile,
      omit_messages: true,
    })
    if (resumed?.session_id) return resumed.session_id
  } catch (e) {
    // 4007 = 会话还不存在 → 建；其它错误不吞（继续抛给调用方）。
    const code = (e as { code?: number; data?: { code?: number } })?.code ?? (e as { data?: { code?: number } })?.data?.code
    if (code !== 4007) throw e
  }
  const created = await request<{ session_id?: string }>('session.create', {
    profile,
    title,
    room_plumbing: true,
  })
  if (!created?.session_id) throw new Error('canonical driver: session.create 未返回 session_id')
  return created.session_id
}

async function resumeSnapshot(sessionId: string, profile: string): Promise<{
  running?: boolean
  messages?: ResumeMessage[]
}> {
  return request('session.resume', { session_id: sessionId, profile })
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
  run.baseline = baseline
  run.memberId = task.member_id
  run.startedAt = Date.now()
  notify()

  await request('prompt.submit', {
    session_id: sessionId,
    text: task.prompt,
    profile: member.profile,
  })

  // 轮询到不忙为止（rpi 的 run 失败在消息里留 failed_turn 行；lane 层
  // last_error 为空时以消息为准）。
  for (;;) {
    if (run.cancelled) return { kind: 'failed', error: 'been cancelled' }
    await new Promise((resolve) => setTimeout(resolve, 1500))
    let snapshot: { running?: boolean; messages?: ResumeMessage[] }
    try {
      snapshot = await resumeSnapshot(sessionId, member.profile)
    } catch (e) {
      return { kind: 'failed', error: e instanceof Error ? e.message : String(e) }
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
      const gatewayActor: Record<string, unknown> = { kind: 'gateway', id: room.authority_gateway_id ?? '' }

      const plan = await planRoom(roomId)

      if (plan.status !== 'task' || !plan.task) {
        const threadId = plan.thread_id ?? ''
        const discussionId = plan.discussion_event_id ?? ''
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
        } else if (plan.status === 'route') {
          // routing=auto 需要一次路由模型调用；宿主不做，如实收尾。
          await appendEvent(roomId, 'room.activity', gatewayActor, {
            status: 'bounded',
            reason_code: 'router_unsupported',
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
      run.task = task
      run.discussionEventId = discussionId
      run.threadId = task.thread_id ?? plan.thread_id ?? null

      const member = (room.members ?? []).find((m) => m.member_id === task.member_id)
      if (!member?.profile) {
        await appendEvent(roomId, 'turn.failed', gatewayActor, {
          ...coordinates(task, discussionId),
          seen_through_seq: task.seen_through_seq,
          error: `房间名册里找不到成员 ${task.member_id}`,
          reason_code: 'member_unavailable',
        })
        break
      }

      const memberActor: Record<string, unknown> = {
        kind: 'member',
        id: member.member_id,
        profile: member.profile,
      }
      const outcome = await runMemberTurn(run, task, member)
      run.memberId = undefined
      run.startedAt = undefined
      notify()

      if (run.cancelled) {
        await appendEvent(roomId, 'turn.cancelled', gatewayActor, {
          ...coordinates(task, discussionId),
          seen_through_seq: task.seen_through_seq,
          reason: 'stopped',
        })
        break
      }

      if (outcome.kind === 'replied') {
        const messageEventId = eventId()
        await invoke('groups_dispatch', {
          method: 'groups.driver_append',
          params: {
            room_id: roomId,
            event_id: messageEventId,
            kind: 'message.member',
            actor: memberActor,
            payload: { ...coordinates(task, discussionId), text: outcome.text },
          },
        })
        await appendEvent(roomId, 'turn.settled', gatewayActor, {
          ...coordinates(task, discussionId),
          seen_through_seq: task.seen_through_seq,
          message_event_id: messageEventId,
          passed: false,
        })
      } else if (outcome.kind === 'passed') {
        await appendEvent(roomId, 'turn.settled', gatewayActor, {
          ...coordinates(task, discussionId),
          seen_through_seq: task.seen_through_seq,
          message_event_id: null,
          passed: true,
        })
      } else {
        await appendEvent(roomId, 'turn.failed', gatewayActor, {
          ...coordinates(task, discussionId),
          seen_through_seq: task.seen_through_seq,
          error: outcome.error,
          reason_code: 'turn_failed',
        })
      }
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
      await request('session.interrupt', { session_id: run.sessionId })
    } catch (e) {
      console.error('[canonical-driver] 中断成员会话失败（驱动仍会退出）', e)
    }
  }
}

/**
 * 应用启动时的恢复扫描：仍在跑的讨论（plan 给 task）重新驱动。
 * 由 `startBundledPlugins` 在插件注册完成后调用一次。
 */
export async function startCanonicalGroupDriver(): Promise<void> {
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

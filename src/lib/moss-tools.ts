/**
 * MOSS Live 工具面（2026-11-13，用户定稿"全协议：只读集 + cron 立即跑"）。
 *
 * 协议（platform.moss.cn/docs/reference/moss-live）：工具经 `session.update`
 * 的 `session.tools` 声明（每次**整表替换**，≤128 个）；模型调工具经
 * `response.function_call_arguments.done`（call_id + arguments 全文 JSON 串；
 * async 工具多带 execution_mode/task_id/revision）；结果经
 * `conversation.item.create`（item.type = function_call_output）回传，vendor
 * 确认 `conversation.item.created` 后客户端再 `response.create`
 * `{call_ids:[…]}` 续跑回复。
 *
 * **工具集口径（用户定稿 2026-11-13）**：host 原生只读集（问完即答的快查询）
 * + `run_cron_job_now`（async_effect，真跑 tool_task 生命周期）。**pi 内置
 * 工具不透传**——它们与 run 上下文/审批耦合，语音场景审批面不可见，等于绕过
 * 审批（SDK 的 execute_tool 只覆盖 JS extension 工具，独立执行面不存在）。
 *
 * 执行器错误**如实传播**（规矩 12）：IPC Err → 本文件 throw → flow 把
 * `{ok:false,error}` 作为工具输出交回（协议要求失败也返回可用描述），模型
 * 会如实转述——不静默、不假装成功。
 */

import { invoke } from '@tauri-apps/api/core'

/** 协议的函数工具声明形状（platform.moss.cn moss-live reference）。 */
export interface MossToolDecl {
  type: 'function'
  /** ^[A-Za-z_][A-Za-z0-9_]*$，≤64 字符，表内唯一。 */
  name: string
  /** 非空。 */
  description: string
  /** JSON Schema；省略 = 无参对象。 */
  parameters?: Record<string, unknown>
  /** sync（缺省）/ async_query（必须 read_only:true）/ async_effect（必须 read_only:false）。 */
  execution_mode?: 'sync' | 'async_query' | 'async_effect'
  read_only?: boolean
}

/** 协议校验规则（vendor 会整表拒绝，客户端先自查——错误信息即拒绝原因）。 */
export function validateToolDecls(tools: MossToolDecl[]): string[] {
  const errors: string[] = []
  const seen = new Set<string>()
  tools.forEach((t, i) => {
    const at = `tools[${i}](${t.name ?? '?'})`
    if (typeof t.name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(t.name)) {
      errors.push(`${at}: name 必须匹配 ^[A-Za-z_][A-Za-z0-9_]*$`)
    } else if (t.name.length > 64) {
      errors.push(`${at}: name 超 64 字符`)
    } else if (seen.has(t.name)) {
      errors.push(`${at}: name 重复`)
    } else {
      seen.add(t.name)
    }
    if (typeof t.description !== 'string' || t.description.trim().length === 0) {
      errors.push(`${at}: description 非空`)
    }
    if (t.execution_mode === 'async_query' && t.read_only !== true) {
      errors.push(`${at}: async_query 必须 read_only:true`)
    }
    if (t.execution_mode === 'async_effect' && t.read_only !== false) {
      errors.push(`${at}: async_effect 必须 read_only:false`)
    }
  })
  return errors
}

// ── host 原生工具集（用户定稿 2026-11-13）──────────────────────────────────

export const MOSS_VOICE_TOOLS: MossToolDecl[] = [
  {
    type: 'function',
    name: 'get_now',
    description: '获取当前日期时间（本地时区）。用户问"现在几点/今天几号/周几"时调用。',
    parameters: { type: 'object', properties: {} },
    execution_mode: 'sync',
    read_only: true,
  },
  {
    type: 'function',
    name: 'get_session_usage',
    description: '查询本地用量统计（tokens/轮次/会话数/活跃天数）。range 可选 all/7d/30d，缺省 7d。',
    parameters: {
      type: 'object',
      properties: {
        range: { type: 'string', enum: ['all', '7d', '30d'], description: '统计区间，缺省 7d' },
      },
    },
    execution_mode: 'sync',
    read_only: true,
  },
  {
    type: 'function',
    name: 'list_sessions',
    description: '列出最近的聊天会话（名称/时间/消息数），最多最近 15 条。',
    parameters: { type: 'object', properties: {} },
    execution_mode: 'sync',
    read_only: true,
  },
  {
    type: 'function',
    name: 'get_app_state',
    description: '查询应用当前状态：活动会话、模型、思考档位。没有活动会话时会报错，如实转述即可。',
    parameters: { type: 'object', properties: {} },
    execution_mode: 'sync',
    read_only: true,
  },
  {
    type: 'function',
    name: 'get_todo_state',
    description: '查询当前会话的待办清单状态（内容与完成度）。没有待办时返回空。',
    parameters: { type: 'object', properties: {} },
    execution_mode: 'sync',
    read_only: true,
  },
  {
    type: 'function',
    name: 'list_cron_jobs',
    description: '列出定时任务（名称/id/计划/下次运行时间）。run_cron_job_now 所需的 id 从这里取。',
    parameters: { type: 'object', properties: {} },
    execution_mode: 'sync',
    read_only: true,
  },
  {
    type: 'function',
    name: 'run_cron_job_now',
    description:
      '立即运行一个定时任务（一次完整的 agent 运行，可能耗时数十秒到数分钟；超过 120 秒的运行其结果无法回到语音——作业本身仍会跑完）。id 必填，来自 list_cron_jobs。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '定时任务 id（list_cron_jobs 返回的 id）' },
      },
      required: ['id'],
    },
    execution_mode: 'async_effect',
    read_only: false,
  },
]

/**
 * 执行器：按工具名分发到宿主真 IPC（命令签名/返回形状逐个核对过：
 * pi_usage_snapshot(pi_usage.rs) / pi_list_sessions·pi_get_state·
 * pi_todo_state(main.rs) / pi_cron_jobs·pi_cron_trigger(pi_cron.rs)）。
 * 返回**整形后的文本**（语音模型要转述给人听，行文优于裸 JSON）；
 * IPC 错误原样 throw（flow 转成失败输出）。
 */
export async function executeVoiceTool(
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  switch (name) {
    case 'get_now':
      return shapeNowOutput(new Date())
    case 'get_session_usage':
      return shapeUsageOutput(
        await invoke<unknown>('pi_usage_snapshot', {
          range: typeof args.range === 'string' && args.range ? args.range : '7d',
        }),
      )
    case 'list_sessions':
      return shapeSessionsOutput(await invoke<unknown>('pi_list_sessions'))
    case 'get_app_state':
      return shapeAppStateOutput(await invoke<unknown>('pi_get_state'))
    case 'get_todo_state':
      return shapeTodoOutput(await invoke<unknown>('pi_todo_state'))
    case 'list_cron_jobs':
      return shapeCronJobsOutput(await invoke<unknown>('pi_cron_jobs'))
    case 'run_cron_job_now': {
      const id = args.id
      if (typeof id !== 'string' || !id.trim()) {
        throw new Error('run_cron_job_now 需要 id 参数（先调 list_cron_jobs 取）')
      }
      return shapeCronTriggerOutput(await invoke<unknown>('pi_cron_trigger', { id }))
    }
    default:
      throw new Error(`未注册的语音工具：${name}`)
  }
}

// ── 输出整形（纯函数；输入 = 上面各 IPC 命令的真实返回形状）────────────────

const SESSION_ROW_CAP = 15
const CRON_ROW_CAP = 20
const TRIGGER_RESPONSE_CAP = 500

const WEEKDAYS_ZH = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/** 本地日期时间（问"几点/周几"的答案）。 */
export function shapeNowOutput(d: Date): string {
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
  const date = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
  const offsetMin = -d.getTimezoneOffset()
  const tz = `UTC${offsetMin >= 0 ? '+' : '-'}${pad2(Math.floor(Math.abs(offsetMin) / 60))}:${pad2(Math.abs(offsetMin) % 60)}`
  return `现在是本地时间 ${date} ${time}（${WEEKDAYS_ZH[d.getDay()]}，${tz}）。`
}

/** pi_usage_snapshot 返回 → 摘要行（形状见 pi_usage.rs build_snapshot）。 */
export function shapeUsageOutput(v: unknown): string {
  if (typeof v !== 'object' || v === null) throw new Error('用量快照返回形状异常')
  const { range, summary } = v as {
    range?: unknown
    summary?: Record<string, unknown> | null
  }
  if (!summary) throw new Error('用量快照缺 summary')
  const n = (k: string): number => (typeof summary[k] === 'number' ? (summary[k] as number) : 0)
  const fav = typeof summary.favoriteModel === 'string' ? `，最常用模型 ${summary.favoriteModel}` : ''
  return (
    `用量统计（${typeof range === 'string' ? range : '?'}）：` +
    `tokens ${n('totalTokens').toLocaleString('en-US')}（输入 ${n('inputTokens').toLocaleString('en-US')} / 输出 ${n('outputTokens').toLocaleString('en-US')}）` +
    `，轮次 ${n('totalTurns').toLocaleString('en-US')}，会话 ${n('totalSessions').toLocaleString('en-US')}` +
    `，工具调用 ${n('toolCallCount').toLocaleString('en-US')}，活跃 ${n('activeDays')} 天${fav}。`
  )
}

/** pi_list_sessions 返回（数组）→ 最近 15 条行文。 */
export function shapeSessionsOutput(v: unknown): string {
  if (!Array.isArray(v)) throw new Error('会话列表返回形状异常')
  const rows = v as Record<string, unknown>[]
  const sorted = [...rows].sort((a, b) => {
    const av = typeof a.lastModifiedMs === 'number' ? a.lastModifiedMs : 0
    const bv = typeof b.lastModifiedMs === 'number' ? b.lastModifiedMs : 0
    return bv - av
  })
  if (sorted.length === 0) return '还没有任何聊天会话。'
  const head =
    rows.length > SESSION_ROW_CAP
      ? `共 ${rows.length} 条会话，最近 ${SESSION_ROW_CAP} 条：`
      : `共 ${rows.length} 条会话：`
  const lines = sorted.slice(0, SESSION_ROW_CAP).map((r) => {
    const name = typeof r.name === 'string' && r.name ? r.name : '未命名会话'
    const msgs = typeof r.messageCount === 'number' ? r.messageCount : 0
    const ts = typeof r.lastModifiedMs === 'number' ? new Date(r.lastModifiedMs) : null
    const when = ts
      ? `${ts.getMonth() + 1}/${ts.getDate()} ${pad2(ts.getHours())}:${pad2(ts.getMinutes())}`
      : '时间未知'
    return `「${name}」（${when}，${msgs} 条消息）`
  })
  return `${head}\n${lines.join('\n')}`
}

/** pi_get_state 返回 → 一行状态（无活动会话 = 上游 Err，走失败输出）。 */
export function shapeAppStateOutput(v: unknown): string {
  if (typeof v !== 'object' || v === null) throw new Error('应用状态返回形状异常')
  const s = v as Record<string, unknown>
  const model = typeof s.modelId === 'string' ? s.modelId : '未知模型'
  const provider = typeof s.provider === 'string' ? s.provider : ''
  const thinking = typeof s.thinkingLevel === 'string' ? `，思考档位 ${s.thinkingLevel}` : ''
  const msgs = typeof s.messageCount === 'number' ? `，当前会话 ${s.messageCount} 条消息` : ''
  return `活动会话 ${typeof s.sessionId === 'string' ? s.sessionId : '?'}：模型 ${model}${provider ? `（${provider}）` : ''}${thinking}${msgs}。`
}

/** pi_todo_state 返回 {schema, list, summary} → 空态/摘要+清单。 */
export function shapeTodoOutput(v: unknown): string {
  if (typeof v !== 'object' || v === null) throw new Error('待办状态返回形状异常')
  const s = v as { schema?: unknown; list?: unknown; summary?: unknown }
  if (s.schema === null || s.schema === undefined || s.list === null || s.list === undefined) {
    return '当前会话没有待办清单。'
  }
  const head = typeof s.summary === 'string' ? s.summary : ''
  return `${head}\n${JSON.stringify(s.list)}`
}

/** pi_cron_jobs 返回 {jobs, tickerRunning} → 行文（id 供 run_cron_job_now）。 */
export function shapeCronJobsOutput(v: unknown): string {
  if (typeof v !== 'object' || v === null) throw new Error('定时任务列表返回形状异常')
  const { jobs } = v as { jobs?: unknown }
  if (!Array.isArray(jobs) || jobs.length === 0) return '当前没有定时任务。'
  const rows = jobs as Record<string, unknown>[]
  const lines = rows.slice(0, CRON_ROW_CAP).map((j) => {
    const name = typeof j.name === 'string' ? j.name : '?'
    const id = typeof j.id === 'string' ? j.id : '?'
    const enabled = j.enabled === true
    const paused = j.state === 'paused'
    const sched = typeof j.schedule_display === 'string' && j.schedule_display ? j.schedule_display : '计划未知'
    const next = typeof j.next_run_at === 'string' ? `，下次 ${j.next_run_at}` : ''
    const last = typeof j.last_status === 'string' ? `，上次 ${j.last_status}` : ''
    return `「${name}」（id=${id}）${paused ? '已暂停' : enabled ? '启用中' : '停用'}，${sched}${next}${last}`
  })
  return `共 ${rows.length} 个定时任务：\n${lines.join('\n')}`
}

/** pi_cron_trigger 返回 RunOutcome（wire camelCase）→ 行文。 */
export function shapeCronTriggerOutput(v: unknown): string {
  if (typeof v !== 'object' || v === null) throw new Error('定时任务运行返回形状异常')
  const o = v as { success?: unknown; skipped?: unknown; response?: unknown; error?: unknown }
  if (o.skipped === true) return '该任务被跳过（已有一次运行在进行，同作业运行权互斥）。'
  if (o.success !== true) {
    const err = typeof o.error === 'string' && o.error ? o.error : '原因未知'
    return `任务运行失败：${err}`
  }
  const resp = typeof o.response === 'string' ? o.response.trim() : ''
  if (!resp) return '任务运行完成，没有产生文本结果。'
  return resp.length > TRIGGER_RESPONSE_CAP
    ? `任务运行完成，结果摘要：${resp.slice(0, TRIGGER_RESPONSE_CAP)}…（结果已完整存档）`
    : `任务运行完成，结果：${resp}`
}

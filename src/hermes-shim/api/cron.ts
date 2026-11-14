/**
 * `@/api/cron` shim —— 定时任务的 IPC 数据面。
 *
 * 上游是 REST（`/api/cron/jobs` 等 12 个端点，见
 * `hermes_cli/web_routers/cron.py`）。宿主没有 HTTP 后端，数据面换成
 * `pi_cron_*` IPC（`src-tauri/src/pi_cron.rs`）。**形状保持上游不变**，
 * 所以镜像来的 `app/cron/*` 与侧栏区一行不用改。
 *
 * ## 与上游的语义差异（每一处都是宿主真实约束，不是简化）
 *
 * | 上游 | 宿主 | 原因 |
 * |---|---|---|
 * | `getCronJobs(profile)` 跨 profile 聚合 | 无 profile 概念 | 宿主单配置（`~/.pi`） |
 * | `getCronDeliveryTargets()` 列已连接平台 | **返回只有 `local`** | 宿主无 Telegram/Discord/Slack/Email 适配器 |
 * | `getAutomationBlueprints(profile)` 16 个内置蓝图 | **返回空数组** | 蓝图指向 hermes 自己的技能库（`google-workspace` 等），宿主技能集不同 |
 * | `getCronJobRuns()` 返回 `SessionInfo[]`（会话行） | 返回台账行 + 会话路径 | 宿主台账是 JSONL，不是 `source='cron'` 会话 |
 * | `triggerCronJob` 24 小时超时 | 同步等（内建 600s 不活动看门狗） | 宿主 run 有硬上限 |
 *
 * 错误一律传播（规矩 12）：IPC 失败就是失败，不返回空数组冒充"没有任务"。
 */

import { invokeOnce } from '@/lib/ipc'

import type {
  AutomationBlueprint,
  CronDeliveryTarget,
  CronJob,
  CronJobCreatePayload,
  CronJobUpdates,
  SessionInfo,
} from '@/hermes-mirror/types/hermes'

/** `pi_cron_jobs` 的返回形状（`src-tauri/src/pi_cron.rs::pi_cron_jobs`）。 */
interface JobsSnapshot {
  jobs: CronJob[]
  tickerRunning: boolean
}

/** `pi_cron_job` 的返回形状。 */
interface JobDetail {
  job: CronJob
  runs: CronRunRow[]
}

/**
 * 台账行（`pi_cron.rs::Execution` 的 camelCase 投影）。
 *
 * 上游 `getCronJobRuns` 返回的是普通会话行（`SessionInfo`，`source='cron'`），
 * 因为 hermes 的 cron run 就是一个会话。宿主也把 run 落成会话（`sessionPath`），
 * 但**台账是独立真相**（`executions.jsonl`）——所以这里返回台账行，并附带
 * 会话路径供「打开这次运行」用。
 */
export interface CronRunRow {
  id: string
  jobId: string
  status: 'claimed' | 'running' | 'completed' | 'failed'
  scheduledAt: null | string
  claimedAt: string
  startedAt: null | string
  finishedAt: null | string
  error: null | string
  sessionPath: null | string
  outputPath: null | string
}

/** 调度器是否在跑（前端「调度器状态」；上游没有这个字段）。 */
export async function getCronTickerState(): Promise<boolean> {
  const snap = await invokeOnce<JobsSnapshot>('pi_cron_jobs')
  return snap.tickerRunning
}

/**
 * 作业列表。
 *
 * `profile` 参数**保留但忽略**：镜像来的调用点会传它（上游按 profile
 * 隔离存储），宿主单配置没有这个概念。忽略而不是报错——报错会让整页
 * 打不开，而"忽略"与宿主的真实语义一致（只有一份作业表）。
 */
export async function getCronJobs(_profile?: string): Promise<CronJob[]> {
  const snap = await invokeOnce<JobsSnapshot>('pi_cron_jobs')
  return snap.jobs
}

/** 单个作业 + 运行历史。`limit` 是最近 N 次（上游默认 20）。 */
export async function getCronJob(jobId: string): Promise<CronJob> {
  const detail = await invokeOnce<JobDetail>('pi_cron_job', { id: jobId })
  return detail.job
}

/**
 * 作业的运行历史。
 *
 * 上游返回 `SessionInfo[]`（会话行）。宿主返回台账行，但**同时**给每一行
 * 补上 `SessionInfo` 的必要字段（`id` / `source` / `started_at` / `ended_at`），
 * 让镜像来的 `CronJobRuns` 组件能按原来的形状渲染，点开时用
 * `sessionPath` 走宿主的会话打开路径。
 */
export async function getCronJobRuns(jobId: string, limit = 20): Promise<SessionInfo[]> {
  const detail = await invokeOnce<JobDetail>('pi_cron_job', { id: jobId, limit })
  return detail.runs.map(runToSessionRow)
}

/**
 * 台账行 → 上游的会话行形状。
 *
 * **不伪造没有的字段**：`messageCount` / `last_active` 宿主台账不记，留空。
 * `source` 固定 `'cron'`（上游 `isCronRunRow` 靠它判类型）。
 */
function runToSessionRow(run: CronRunRow): SessionInfo {
  const startedMs = run.startedAt ? Date.parse(run.startedAt) : null
  const finishedMs = run.finishedAt ? Date.parse(run.finishedAt) : null
  return {
    id: run.sessionPath ?? run.id,
    source: 'cron',
    // 上游字段是秒；宿主台账存 RFC3339
    started_at: startedMs === null ? null : Math.floor(startedMs / 1000),
    ended_at: finishedMs === null ? null : Math.floor(finishedMs / 1000),
    last_active: finishedMs === null ? null : Math.floor(finishedMs / 1000),
    // 台账里有 error 就是失败；claim/running 是"还在跑"
    title: run.error ? `失败：${run.error}` : null,
  } as SessionInfo
}

/**
 * 投递目标。
 *
 * **只有 `local`**：宿主没有任何消息平台适配器（Telegram/Discord/Slack/
 * Email/bot-chat 全无）。上游这个端点是"已连接的平台"，宿主如实返回
 * 唯一的真目标——不编造平台条目让下拉框看起来丰满。
 */
export async function getCronDeliveryTargets(): Promise<CronDeliveryTarget[]> {
  return [
    {
      id: 'local',
      name: '本机',
      home_env_var: null,
      home_target_set: true,
    },
  ]
}

/**
 * 蓝图目录。
 *
 * 16 个内置模板，**照抄上游 `cron/blueprint_catalog.py`**（key/title/
 * description/category/tags/schedule_template/prompt_template/slots 逐字）。
 *
 * **唯一裁剪 = `skills` 字段**：上游有 5 个蓝图带 `skills`
 * （morning-brief → `google-workspace` 等），那些是 hermes 自己的技能库条目，
 * 宿主没有同名技能——照抄会让作业一建就因"技能不存在"而失败。处理方式是
 * 把"跑某个技能的过程"改写成自包含指令（见 `pi_cron.rs` 的
 * `blueprints()` 注释），蓝图仍然可用，也不假装技能存在。
 *
 * `profile` 保留但忽略：上游按 profile 列插件注册的蓝图，宿主单配置。
 */
export async function getAutomationBlueprints(
  _profile?: string
): Promise<{ blueprints: AutomationBlueprint[] }> {
  return invokeOnce<{ blueprints: AutomationBlueprint[] }>('pi_cron_blueprints', {})
}

/**
 * 从蓝图实例化作业（填槽 → 校验 → 走同一个 `pi_cron_create`）。
 *
 * 与手动创建**同一条路径**：上游 `fill_blueprint` 返回的就是 `create_job`
 * 的 kwargs（`blueprint_catalog.py:748` "there is no second job engine"）。
 * 槽位校验在后端（未知槽名/必填缺失/strict enum 越界都报错），错误文案
 * 前端 `cleanBlueprintFieldError` 会去掉数字前缀直接显示。
 */
export async function instantiateAutomationBlueprint(
  body: { blueprint: string; values: Record<string, string> },
  _profile?: string
): Promise<CronJob> {
  return invokeOnce<CronJob>('pi_cron_instantiate_blueprint', {
    blueprint: body.blueprint,
    values: body.values,
  })
}

/** 创建作业。 */
export async function createCronJob(body: CronJobCreatePayload): Promise<CronJob> {
  return invokeOnce<CronJob>('pi_cron_create', {
    input: {
      prompt: body.prompt,
      schedule: body.schedule,
      ...(body.name ? { name: body.name } : {}),
      ...(body.model ? { model: body.model } : {}),
      ...(body.provider ? { provider: body.provider } : {}),
      ...(body.repeat ? { repeat: body.repeat } : {}),
    },
  })
}

/** 更新作业。 */
export async function updateCronJob(jobId: string, updates: CronJobUpdates): Promise<CronJob> {
  return invokeOnce<CronJob>('pi_cron_update', {
    id: jobId,
    input: {
      ...(updates.name !== undefined ? { name: updates.name } : {}),
      ...(updates.prompt !== undefined ? { prompt: updates.prompt } : {}),
      ...(updates.schedule !== undefined ? { schedule: updates.schedule } : {}),
      ...(updates.provider !== undefined ? { provider: updates.provider } : {}),
      ...(updates.model !== undefined ? { model: updates.model } : {}),
    },
  })
}

/** 暂停作业。 */
export async function pauseCronJob(jobId: string): Promise<CronJob> {
  return invokeOnce<CronJob>('pi_cron_pause', { id: jobId })
}

/** 恢复作业。 */
export async function resumeCronJob(jobId: string): Promise<CronJob> {
  return invokeOnce<CronJob>('pi_cron_resume', { id: jobId })
}

/** 立即运行的返回（`pi_cron_trigger`）。 */
export interface CronTriggerResult {
  success: boolean
  skipped: boolean
  response: string
  error: null | string
  sessionPath: null | string
  outputPath: null | string
}

/**
 * 立即运行。
 *
 * **同步等整个 run**（上游同款：`triggerCronJob` 的注释说"waits for the
 * whole job so its response reflects the persisted execution result"）。
 * 宿主 run 有 600s 不活动看门狗兜底。
 */
export async function triggerCronJob(jobId: string): Promise<CronTriggerResult> {
  return invokeOnce<CronTriggerResult>('pi_cron_trigger', { id: jobId })
}

/** 删除作业。 */
export async function deleteCronJob(jobId: string): Promise<{ ok: boolean }> {
  return invokeOnce<{ ok: boolean }>('pi_cron_delete', { id: jobId })
}

/**
 * 机器人子页（hermes 子页面的宿主承载，2026-11-10/12 用户："所有的子页面
 * 一模一样"）。
 *
 * | 子页 | 数据面 | 形态 |
 * |---|---|---|
 * | ScreenPane（gateway 屏幕流：安装 agent / 实时画面 / 自动置顶） | pi 无
 *   gateway 屏幕面 | 红显占位（hero 文案，不渲染假画面） |
 * | RoutinesPane（per-bot cron：作业表 + 创建 + 触发/暂停/删除） | **真面**
 *   ——pi_cron Job 加 \`bot\` 绑定字段（2026-11-12），创建时把 bot 预设的
 *   模型/persona 填进作业（provider/model/prompt），作业随 bot 归档过滤 | 真面板 |
 *
 * 两页都替换 bots-pane body（GroupChatWorkspace 同语义），带返回钮。
 */
import { FC, useEffect, useMemo, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import {
  ArrowLeftIcon,
  MonitorIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  TimerIcon,
  TrashIcon,
} from 'lucide-react'

import { splitBotModel, type BotPreset } from './bots-store'
import { cn } from '@/lib/utils'

/** 子页外壳（hermes pane 头同构：返回钮 + 图标 + 标题）。 */
const SubPageShell: FC<{
  backLabel: string
  icon: React.ReactNode
  onBack: () => void
  redNote?: string
  title: string
  children?: React.ReactNode
}> = ({ backLabel, icon, onBack, redNote, title, children }) => (
  <div className="flex h-full flex-col" data-slot="bot-subpage">
    <div className="border-border/70 flex items-center gap-2 border-b px-2.5 py-2">
      <button
        aria-label={backLabel}
        className="text-muted-foreground hover:text-foreground rounded-md p-1 transition-colors"
        onClick={onBack}
        type="button"
      >
        <ArrowLeftIcon className="size-[var(--size-icon-sm)]" />
      </button>
      {icon}
      <span className="text-foreground min-w-0 truncate text-sm font-medium">{title}</span>
    </div>
    {redNote && (
      <div
        className="text-rose-600 dark:text-rose-400 bg-rose-50 dark:text-rose-400 dark:bg-rose-950/30 border-rose-200 dark:border-rose-800 border-b px-2.5 py-1 text-xs"
        data-stub="true"
      >
        {redNote}
      </div>
    )}
    {children ?? (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
        {icon}
        <div className="text-foreground/80 text-xs font-medium">{title}</div>
        {redNote && <div className="text-muted-foreground/80 text-xs">{redNote}</div>}
      </div>
    )}
  </div>
)

/** 屏幕子页（hermes ScreenPane 占位：pi 无 gateway 屏幕流）。 */
export const ScreenStubPane: FC<{ bot: string; onBack: () => void }> = ({ bot, onBack }) => (
  <SubPageShell
    backLabel="返回花名册"
    icon={<MonitorIcon className="text-muted-foreground/60 size-6" />}
    onBack={onBack}
    redNote="屏幕流需要远端 gateway，pi 未接通——占位页，不渲染假画面。"
    title={`屏幕 · ${bot}`}
  />
)

// ── per-bot 例程（真面：pi_cron Job.bot 绑定） ──────────────────────────

/** pi_cron_jobs 的 wire 行（job_to_wire 投影，snake_case）。 */
interface CronJobRow {
  id: string
  name: string
  prompt: string
  bot: null | string
  schedule_display: string
  next_run_at: null | string
  last_run_at: null | string
  last_status: null | string
  last_error: null | string
  state: string
  enabled: boolean
}

const formatWhen = (iso: null | string): string => {
  if (!iso) return '—'
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return iso
  return new Date(ms).toLocaleString([], {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** per-bot 例程面板（hermes cron.tsx 的 per-bot 视图宿主版）：作业表 +
    创建（bot 的模型/人设自动入作业）+ 立即运行/暂停/恢复/删除。 */
export const RoutinesPane: FC<{ bot: BotPreset; onBack: () => void }> = ({ bot, onBack }) => {
  const [jobs, setJobs] = useState<readonly CronJobRow[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  // 创建表单
  const [jobName, setJobName] = useState('')
  const [schedule, setSchedule] = useState('')
  const [prompt, setPrompt] = useState('')
  const [createError, setCreateError] = useState<string | null>(null)

  const load = () => {
    void invoke<{ jobs: CronJobRow[] }>('pi_cron_jobs')
      .then((r) => {
        setJobs(r.jobs.filter((j) => j.bot === bot.name))
        setLoadError(null)
      })
      .catch((e) => {
        console.error('[bots] 例程清单读取失败', e)
        setLoadError(String(e))
        setJobs([])
      })
  }
  useEffect(load, [bot.name])

  const mine = useMemo(() => jobs ?? [], [jobs])

  const act = async (id: string, cmd: 'pi_cron_pause' | 'pi_cron_resume' | 'pi_cron_delete') => {
    setBusyId(id)
    try {
      await invoke(cmd, { id, ...(cmd === 'pi_cron_pause' ? { reason: '手动暂停' } : {}) })
      load()
    } catch (e) {
      console.error('[bots] 例程操作失败', e)
    } finally {
      setBusyId(null)
      setConfirmDelete(null)
    }
  }

  const trigger = async (id: string) => {
    // 同步等待整个 run（pi_cron_trigger 语义；hermes trigger 24h 超时同域）
    setBusyId(id)
    try {
      await invoke('pi_cron_trigger', { id })
      load()
    } catch (e) {
      console.error('[bots] 例程触发失败', e)
    } finally {
      setBusyId(null)
    }
  }

  const create = async () => {
    setCreateError(null)
    const { provider, modelId } = splitBotModel(bot.model)
    try {
      // bot 预设的执行参数进作业（绑定语义：模型 = bot 的、persona 前置；
      // bot 删除后作业照常跑——Job.bot 仅归档过滤用，见 pi_cron.rs 注释）
      const persona = bot.systemPrompt.trim()
      const fullPrompt = persona ? `[Bot persona: ${persona}]\n\n${prompt.trim()}` : prompt.trim()
      await invoke('pi_cron_create', {
        input: {
          prompt: fullPrompt,
          schedule: schedule.trim(),
          name: jobName.trim() || undefined,
          provider: provider ?? undefined,
          model: modelId ?? undefined,
          workdir: bot.cwd.trim() || undefined,
          bot: bot.name,
        },
      })
      setCreateOpen(false)
      setJobName('')
      setSchedule('')
      setPrompt('')
      load()
    } catch (e) {
      setCreateError(String(e))
    }
  }

  return (
    <SubPageShell
      backLabel="返回花名册"
      icon={<TimerIcon className="text-muted-foreground size-[var(--size-icon-sm)]" />}
      onBack={onBack}
      title={`例程 · ${botDisplayNameSafe(bot)}`}
    >
      <div className="min-h-0 flex-1 overflow-y-auto" data-slot="bot-routines">
        <div className="grid w-full min-w-0 gap-0.5 px-1.5 pb-2">
          {loadError ? (
            <div className="set-err mx-0.5">{loadError}</div>
          ) : mine.length === 0 ? (
            <div className="text-muted-foreground/60 py-8 text-center text-xs">
              还没有例程——点下方「新建例程」给这台机器人定时任务。
            </div>
          ) : (
            mine.map((j) => (
              <div
                className="hover:bg-accent/60 rounded-md px-2 py-2 transition-colors"
                key={j.id}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-foreground min-w-0 truncate text-[0.8125rem] font-medium">
                    {j.name}
                  </span>
                  <span className="text-muted-foreground/60 shrink-0 text-[0.6875rem]">
                    {j.enabled ? `下次 ${formatWhen(j.next_run_at)}` : '已暂停'}
                  </span>
                </div>
                <div className="text-muted-foreground mt-0.5 flex min-w-0 items-center gap-1.5 text-xs">
                  <span className="shrink-0">{j.schedule_display}</span>
                  {j.last_status && (
                    <>
                      <span className="text-muted-foreground/50">·</span>
                      <span
                        className={cn(
                          'shrink-0',
                          j.last_status === 'error' && 'text-rose-600 dark:text-rose-400',
                        )}
                        title={j.last_error ?? undefined}
                      >
                        上次{j.last_status === 'ok' ? '成功' : '失败'}
                      </span>
                    </>
                  )}
                  <span className="text-muted-foreground/50">·</span>
                  <span className="min-w-0 truncate">上次 {formatWhen(j.last_run_at)}</span>
                </div>
                <div className="text-muted-foreground mt-0.5 flex items-center gap-1">
                  <button
                    className="hover:bg-accent flex size-6 items-center justify-center rounded-[4px] disabled:opacity-40"
                    disabled={busyId === j.id}
                    onClick={() => void trigger(j.id)}
                    title="立即运行（等待本次执行结束）"
                    type="button"
                  >
                    <PlayIcon className="size-3" />
                  </button>
                  <button
                    aria-label={j.enabled ? `暂停 ${j.name}` : `恢复 ${j.name}`}
                    className="text-muted-foreground hover:bg-accent hover:text-foreground flex size-6 items-center justify-center rounded-[4px] disabled:opacity-40"
                    disabled={busyId === j.id}
                    onClick={() => void act(j.id, j.enabled ? 'pi_cron_pause' : 'pi_cron_resume')}
                    title={j.enabled ? '暂停' : '恢复'}
                    type="button"
                  >
                    {j.enabled ? <PauseIcon className="size-3" /> : <PlayIcon className="size-3" />}
                  </button>
                  <button
                    aria-label={`删除 ${j.name}`}
                    className={cn(
                      'hover:bg-accent flex size-6 items-center justify-center rounded-[4px] disabled:opacity-40',
                      confirmDelete === j.id
                        ? 'text-rose-600 dark:text-rose-400'
                        : 'text-muted-foreground hover:text-foreground',
                    )}
                    disabled={busyId === j.id}
                    onClick={() => {
                      if (confirmDelete === j.id) {
                        void act(j.id, 'pi_cron_delete')
                      } else {
                        setConfirmDelete(j.id)
                      }
                    }}
                    title={confirmDelete === j.id ? '再点一次确认删除' : '删除'}
                    type="button"
                  >
                    <TrashIcon className="size-3" />
                  </button>
                  {busyId === j.id && (
                    <span className="text-muted-foreground/60 text-[0.625rem]">运行中…</span>
                  )}
                </div>
              </div>
            ))
          )}
          {createOpen ? (
            <div className="border-border/70 mt-1 grid gap-2 rounded-md border p-2">
              <input
                aria-label="例程名"
                className="set-input"
                onChange={(e) => setJobName(e.target.value)}
                placeholder="例程名（空 = 取提示词前 50 字）"
                value={jobName}
              />
              <input
                aria-label="调度"
                autoFocus
                className="set-input"
                onChange={(e) => setSchedule(e.target.value)}
                placeholder="30m / every day at 09:00 / cron 表达式"
                value={schedule}
              />
              <textarea
                aria-label="提示词"
                className="set-textarea"
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="到点了让机器人做什么……"
                rows={3}
                value={prompt}
              />
              {createError && <div className="set-err">{createError}</div>}
              <div className="flex justify-end gap-2">
                <button className="set-btn pressable" onClick={() => setCreateOpen(false)} type="button">
                  取消
                </button>
                <button
                  className="set-btn set-btn-primary pressable"
                  disabled={!schedule.trim() || !prompt.trim()}
                  onClick={() => void create()}
                  type="button"
                >
                  创建
                </button>
              </div>
            </div>
          ) : (
            <button
              className="text-muted-foreground hover:bg-accent/60 hover:text-foreground mt-1 flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-border/70 px-2 py-2 text-xs transition-colors"
              onClick={() => {
                setCreateError(null)
                setCreateOpen(true)
              }}
              type="button"
            >
              <PlusIcon className="size-3" />
              新建例程
            </button>
          )}
        </div>
      </div>
    </SubPageShell>
  )
}

/** bot 显示名（bots-pane 的 botDisplayName 同公式——避免循环 import 用本地实现）。 */
function botDisplayNameSafe(bot: BotPreset): string {
  return bot.title.trim() || bot.name
}

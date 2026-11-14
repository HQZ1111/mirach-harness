/**
 * 左栏「定时任务」区（2026-10-29）——上游
 * `apps/desktop/src/app/chat/sidebar/cron-jobs-section.tsx` 的宿主挂载点。
 *
 * 上游把这个区挂在它自己的 `chat/sidebar/index.tsx` 里（`:2046`，条件
 * `cronJobs.length > 0`），数据来自 `$cronJobs` atom。宿主的左栏是
 * `assistant-sessions-pane.tsx`（EntryBar + ThreadList），没有那个 2084 行的
 * 侧栏文件，所以这里做**最小挂载**：自己拉作业列表、自己管折叠状态、
 * 把上游 `SidebarCronJobsSection` 需要的回调接上。
 *
 * ## 为什么单独一个容器而不是改 ThreadList
 *
 * ThreadList 是 assistant-ui registry 组件（会话列表），它的职责边界清楚；
 * 往里塞 cron 会让那个组件同时管两套数据源。上游也是分文件的两个区块。
 *
 * ## 数据刷新
 *
 * 上游靠 `$cronJobs` atom + `cron.changed` 广播事件。宿主没有广播，用
 * 轮询（30s）+ 操作后刷新：作业列表是低频变化的，30s 足够；操作（暂停/
 * 触发/删除）后立刻重拉，用户看不到延迟。
 *
 * ## 空列表不渲染
 *
 * 与上游同款（`cronJobs.length > 0` 才挂）：一个从没建过定时任务的用户
 * 不该在侧栏看到一块空白。
 */

import { useCallback, useEffect, useState } from 'react'

import { SidebarCronJobsSection } from '@/hermes-mirror/app/chat/sidebar/cron-jobs-section'
import { useI18n } from '@/hermes-mirror/i18n'
import { type CronJob, getCronJobs, triggerCronJob } from '@/hermes-shim/hermes'

import { mainViewStore } from '@/components/panes/main-view-store'
import { switchSessionThreadBridge } from '@/components/panes/session-manage/session-tab-bridge'

/** 轮询间隔：作业列表低频变化，30s 足够；操作后另有立即刷新。 */
const REFRESH_INTERVAL_MS = 30_000

export function SidebarCronSection() {
  const { t } = useI18n()
  const [jobs, setJobs] = useState<CronJob[]>([])
  const [open, setOpen] = useState(true)

  const refresh = useCallback(async () => {
    try {
      setJobs(await getCronJobs())
    } catch (err) {
      // 读失败必须可见（规矩 12）：静默会让用户以为"任务没了"。
      console.error('[cron] 侧栏作业列表刷新失败', err)
    }
  }, [])

  useEffect(() => {
    void refresh()
    const id = window.setInterval(() => void refresh(), REFRESH_INTERVAL_MS)
    return () => window.clearInterval(id)
  }, [refresh])

  /** 打开完整 cron 页并聚焦该作业（上游 `onManageJob` 语义）。 */
  const manageJob = useCallback((_jobId: string) => {
    mainViewStore.getState().setView('cron')
  }, [])

  /** 打开某次运行的会话（走宿主唯一的会话切换入口）。 */
  const openRun = useCallback((sessionId: string) => {
    switchSessionThreadBridge(sessionId)
    mainViewStore.getState().showChat()
  }, [])

  /**
   * 立即运行。
   *
   * 上游签名是 `Promise<void>`；宿主的 `triggerCronJob` 返回结果对象。
   * 失败**不吞**：错误抛回给 `createCronTriggerController`（它负责把
   * running 标记收回），同时打 console.error 让原因可见。
   */
  const triggerJob = useCallback(
    async (jobId: string) => {
      try {
        const result = await triggerCronJob(jobId)
        if (result.skipped) {
          console.warn('[cron] 作业正在运行中，本次触发被跳过', jobId)
        } else if (!result.success) {
          console.error('[cron] 作业运行失败', jobId, result.error)
        }
      } finally {
        await refresh()
      }
    },
    [refresh]
  )

  /** 暂停/恢复的刷新回调（上游 `onToggle` 是"数据变了，重拉"）。 */
  const toggle = useCallback(() => {
    void refresh()
  }, [refresh])

  // 空列表不渲染（上游同款条件）
  if (jobs.length === 0) {
    return null
  }

  return (
    <SidebarCronJobsSection
      jobs={jobs}
      label={t.sidebar.cronJobs}
      onManageJob={manageJob}
      onOpenRun={openRun}
      onToggle={toggle}
      onTriggerJob={triggerJob}
      open={open}
      // 上游把展开态交给侧栏的分组状态机；宿主这一层只有它一个区，
      // 默认展开、点击标题折叠（`onToggle` 是上游"数据变了"的回调，
      // 不是折叠回调——折叠由本组件的 open 控制）。
      max={5}
    />
  )
}

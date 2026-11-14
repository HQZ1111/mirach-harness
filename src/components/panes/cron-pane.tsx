/**
 * 「定时任务」页面入口（dockview `workspace` 面板的 cron 视图）。
 *
 * 2026-10-29：用户要求"照抄 hermes 的定时任务"，形态与「技能与工具」页
 * 一致——**替换对话区**，不是新开面板栏标签。上游 `/cron` 是顶级路由
 * （`apps/desktop/src/app/routes.ts:73`），点侧栏入口时主内容区整体换成
 * `CronView`。
 *
 * 组件树来自 `src/hermes-mirror/app/cron/`（6 个上游文件逐字复制）+ 侧栏区
 * `src/hermes-mirror/app/chat/sidebar/cron-jobs-section.tsx`；数据面是
 * `src/hermes-shim/api/cron.ts`（`pi_cron_*` IPC，见该文件头的语义对照表）。
 *
 * 本文件只做三件事（与 `capabilities-pane.tsx` 同构）：
 *  1. 挂 `QueryClientProvider`（cron 页的蓝图目录与模型选项走 TanStack Query）；
 *  2. 挂上游 `I18nProvider`（语言 = 宿主偏好 `mirach:locale`）；
 *  3. 渲染上游 `CronView`。
 *
 * **`onOpenSession` 的宿主实现**：上游是"打开这次运行"——把 cron run 的
 * 会话在聊天区打开。宿主的 cron run 落在 `<global_dir>/cron/sessions/`，
 * 用 `pi_open_session` 打开即可（与侧栏点会话行走同一条路径）。
 */

import { QueryClientProvider } from '@tanstack/react-query'

import { CronView } from '@/hermes-mirror/app/cron'
import { I18nProvider } from '@/hermes-mirror/i18n'
import { ensureCapabilitiesWiring } from '@/components/panes/capabilities-pane'
import { queryClient } from '@/hermes-shim/lib/query-client'

import { switchSessionThreadBridge } from '@/components/panes/session-manage/session-tab-bridge'

/** 语言偏好：与 `capabilities-pane.tsx` 同一份判定（`mirach:locale`）。 */
function hostLocale(): 'en' | 'zh' {
  try {
    return new URLSearchParams(window.location.search).get('lang') === 'en' ||
      localStorage.getItem('mirach:locale') === 'en'
      ? 'en'
      : 'zh'
  } catch {
    return 'zh'
  }
}

/**
 * 「打开这次运行」的宿主实现。
 *
 * 上游签名是 `(sessionId: string, session: SessionInfo) => void`；宿主把
 * `sessionId` 解释成**会话文件路径**（`api/cron.ts` 的 `runToSessionRow`
 * 用 `sessionPath` 当 id）。
 *
 * 走 `sessionThreadSwitcher`（`session-tab-bridge.ts`）：这是宿主所有
 * "打开某个会话"的**唯一入口**——它由 `runtime.tsx:1031` 注册，内部做
 * 完整的一套（流式中先 `pi_interrupt`、`pi_open_session`、HYDRATE 历史、
 * 滚动位恢复、分支条刷新）。直接 invoke 会漏掉这些，表现为"打开了但
 * 消息是空的"。
 *
 * 未注册（runtime 还没挂载）= 明确报错，不静默。
 */
function openCronRun(sessionId: string): void {
  // 桥内建"未注册 = console.error"（`session-tab-bridge.ts:47`），所以这里
  // 不需要再判空——两条错误路径只会重复打印。
  switchSessionThreadBridge(sessionId)
  // 打开后切回聊天视图（上游 `openCronRun` 之后路由会翻到会话页）
  showChat()
}

/** 切回聊天视图（关掉 cron 页 / 打开运行后都要做）。 */
function showChat(): void {
  void import('@/components/panes/main-view-store').then(({ mainViewStore }) => {
    mainViewStore.getState().showChat()
  })
}

/** 定时任务视图（hermes `CronView` 的宿主挂载点）。 */
export function CronPane() {
  // 上游 `I18nProvider` 挂载后会**自己拉配置覆盖 initialLocale**
  // （`i18n/context.tsx:198` 读 `window.hermesDesktop.getMachineProfile`、
  // `:186` 读 configClient 的 saved locale）。宿主那份桥由
  // `installHostBridge` 装（定义在 capabilities-pane.tsx，模块级幂等）。
  // 不装 → 桥缺失 → provider 拉不到配置 → 回落 DEFAULT_LOCALE(en)，
  // 整页英文（实测）。所以这里必须先装桥。
  ensureCapabilitiesWiring()

  return (
    <QueryClientProvider client={queryClient}>
      <I18nProvider initialLocale={hostLocale()}>
        <CronView onClose={closeToChat} onOpenSession={openCronRun} />
      </I18nProvider>
    </QueryClientProvider>
  )
}

/**
 * `onClose`：上游是"关掉 cron 覆盖层回到上一路由"。宿主回到聊天。
 *
 * 用模块级函数而不是内联箭头：`CronView` 的 props 类型要求稳定引用，
 * 内联箭头每次渲染都会换引用（上游 `contrib/wiring.tsx:1393` 也是传的
 * 稳定函数 `closeOverlayToPreviousRoute`）。
 */
function closeToChat(): void {
  showChat()
}

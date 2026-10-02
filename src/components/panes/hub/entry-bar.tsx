/**
 * 左栏「上方入口条」——hermes app/chat/sidebar/index.tsx 的 SIDEBAR_NAV
 * 照抄（:201-237 五项定义 + :1516-1610 行渲染）。hermes 逐项出处：
 * - 顺序/图标/快捷键键：SIDEBAR_NAV（sidebar/index.tsx:201-237）——
 *   robot（新建会话）/ symbol-misc（技能与工具）/ comment（消息平台）/
 *   files（产物）/ watch（定时任务）；
 * - 行视觉：SidebarMenuButton（:1530-1545）——h-7、0.8125rem medium、
 *   图标 72%（:1590）、未激活 hover 洗底；快捷键标注 = KbdGroup
 *   ml-auto opacity-55（:1603-1609，仅新建会话有标注——hermes 同款）；
 * - zh 文案：i18n/zh.ts sidebar.nav（:2873-2879 逐字）。
 *
 * 数据面（pi 对照裁定，用户口径「插件位」）：
 * - 新建会话 → callbacks.newThread（assistant-ui 原生
 *   aui.threads.switchToNewThread，threadListAdapter.onSwitchToNewThread
 *   = pi_discard_session 语义——接线在 sessions-pane.tsx）；
 * - 技能与工具 → pi_list_resources 只读管理面板（pi 资源面，
 *   pi-resources-dialog.tsx——skills/prompts/extensions/packages 列举）；
 * - 消息平台 / 产物 / 定时任务 → pi 无对等物（pi 侧定时=后台 bash jobs
 *   工具非 cron 服务、无消息平台/制品实体）——hermes 视觉放行，点击弹
 *   诚实提示条（本组件内渲染、可关闭），不装假跳转。
 *
 * 快捷键标注：harness 无 keybinds store（接 pi 前定取舍）——静态
 * Ctrl+N（hermes actions.ts:84 session.new defaults ['mod+n']），注释注明。
 * 禁止 innerHTML：图标 = lucide-react 组件，无字符串拼接。
 */

import { useState } from 'react'
import {
  BotIcon,
  BriefcaseIcon,
  MessageCircleIcon,
  PuzzleIcon,
  TimerIcon,
  XIcon,
} from 'lucide-react'

import { openResourcesDialog } from './pi-resources-dialog'

/** 入口的动作回调（newThread 由 runtime 通道注入——sessions-pane.tsx）。 */
export interface EntryBarCallbacks {
  newThread: () => void
}

/** 单个入口（hermes SidebarNavItem 的对偶）。available=false = pi 无对等
 *  能力——点击弹诚实提示。 */
interface EntryItem {
  id: string
  label: string
  kbd?: string[]
  Icon: typeof BotIcon
  available: boolean
  act: (cb: EntryBarCallbacks) => void
}

/** SIDEBAR_NAV 五项（hermes sidebar/index.tsx:201-237 逐项对照；zh 文案
 *  zh.ts:2873-2879）。逐项数据面裁定注释： */
const ITEMS: EntryItem[] = [
  {
    id: 'new-session',
    label: '新建会话',
    kbd: ['Ctrl', 'N'],
    Icon: BotIcon,
    available: true,
    // hermes new-session 行（:1554-1556 $newChatProfile.set(null) + 导航）；
    // harness = assistant-ui switchToNewThread（pi_discard_session 语义）
    act: (cb) => cb.newThread(),
  },
  {
    id: 'capabilities',
    label: '技能与工具',
    Icon: PuzzleIcon,
    available: true,
    // pi 对等：skills/prompts 目录 + extensions/packages 配置（只读管理）
    // ——pi_list_resources（pi_resources.rs；loader = pi 原生
    // resources.rs:950 load_skills / :1414 load_prompt_templates）
    act: () => openResourcesDialog(),
  },
  {
    id: 'messaging',
    label: '消息平台',
    Icon: MessageCircleIcon,
    // hermes = messaging 平台面（Telegram/Slack/Discord，zh.ts:2171）；pi
    // 无消息平台桥（vendor 源码无 connector 实体）——诚实提示
    available: false,
    act: () => {},
  },
  {
    id: 'artifacts',
    label: '产物',
    Icon: BriefcaseIcon,
    // hermes = 制品浏览页；pi 的产物=后台 job 的 artifact 文件（jobs.rs:5-6
    // rolling artifact file），无独立制品实体——诚实提示
    available: false,
    act: () => {},
  },
  {
    id: 'cron',
    label: '定时任务',
    // hermes 图标 = watch（lucide WatchIcon 在本版本缺）——Timer 语义同
    Icon: TimerIcon,
    // hermes = cron jobs 面（CRON_ROUTE）；pi 无 cron（vendor 源码无 cron
    // 模块，定时= jobs 后台任务非调度器）——诚实提示
    available: false,
    act: () => {},
  },
]

/** 左栏入口条（hermes SIDEBAR_NAV 行渲染的 harness 版）。 */
export function EntryBar({ callbacks }: { callbacks: EntryBarCallbacks }) {
  // 诚实提示条（pi 无对等物的入口点击后显示；点 ✕ 或点其它可用入口即消）
  const [notice, setNotice] = useState<string | null>(null)

  return (
    <div className="hub-entry-bar">
      {ITEMS.map((item) => {
        const { Icon } = item
        return (
          <button
            aria-label={item.label}
            className="hub-entry-row"
            data-entry-id={item.id}
            key={item.id}
            onClick={() => {
              if (!item.available) {
                setNotice(
                  `「${item.label}」需要 pi 扩展支撑，尚未实现——pi 当前没有对等的插件能力。`,
                )
                return
              }
              setNotice(null)
              item.act(callbacks)
            }}
            title={item.label}
            type="button"
          >
            <Icon aria-hidden className="hub-entry-icon" />
            <span className="hub-entry-label">{item.label}</span>
            {/* 快捷键标注（hermes 仅新建会话带 KbdGroup 标注：1603-1609）；
                harness 无 keybinds 系统——静态 Ctrl+N 注释注明（见文件头） */}
            {item.kbd && (
              <span className="hub-kbd">{item.kbd.join('+')}</span>
            )}
          </button>
        )
      })}
      {notice && (
        <div className="hub-entry-notice" role="status">
          <span className="hub-entry-notice-text">{notice}</span>
          <button
            aria-label="关闭提示"
            className="hub-entry-notice-close"
            onClick={() => setNotice(null)}
            type="button"
          >
            <XIcon size={10} />
          </button>
        </div>
      )}
    </div>
  )
}

/**
 * 左栏「上方入口条」——hermes app/chat/sidebar/index.tsx 的 SIDEBAR_NAV
 * 照抄（:201-237 五项定义 + :1516-1610 行渲染）。hermes 逐项出处：
 * - 顺序/快捷键键：SIDEBAR_NAV（sidebar/index.tsx:201-237）——新建会话/
 *   技能与工具/消息平台/产物/定时任务；2026-10-06 用户定稿：**图标加回**
 *   （lucide 语义对位，16px 72% 灰——hermes :1590 同款视觉）；
 * - 行视觉：SidebarMenuButton（:1530-1545）——h-7、0.8125rem medium、
 *   图标 72%（:1590）、未激活 hover 洗底；快捷键标注 = KbdGroup
 *   ml-auto opacity-55（:1603-1609，仅新建会话有标注——hermes 同款）；
 * - zh 文案：i18n/zh.ts sidebar.nav（:2873-2879 逐字）。
 *
 * 数据面（pi 对照裁定，用户口径「插件位」）：
 * - 新建会话 → callbacks.newThread（assistant-ui 原生
 *   aui.threads.switchToNewThread，threadListAdapter.onSwitchToNewThread
 *   = pi_discard_session 语义——接线在 sessions-pane.tsx）；
 * - 技能与工具 → 主区视图切到 CapabilitiesPane（hermes SkillsPage 的移植，
 *   数据面 pi_capabilities）；
 * - 定时任务 → 主区视图切到 CronPane（2026-10-29 接通：后端 pi_cron.rs +
 *   前端 hermes-mirror/app/cron 上游逐字复制）；
 * - 消息平台 / 产物 → pi 无对等物（无消息平台桥、无独立制品实体）——
 *   hermes 视觉放行，点击弹诚实提示条（本组件内渲染、可关闭），不装假跳转。
 *
 * 快捷键标注：harness 无 keybinds store（接 pi 前定取舍）——静态
 * Ctrl+N（hermes actions.ts:84 session.new defaults ['mod+n']），注释注明。
 * 禁止 innerHTML：图标 = lucide-react 组件，无字符串拼接。
 */

import { useState } from 'react'
import {
  ClockIcon,
  MessageSquareIcon,
  PackageIcon,
  PlusIcon,
  WrenchIcon,
  XIcon,
} from 'lucide-react'

import { SharedLayoutBg } from '@/components/motion/shared-layout-bg'

import { mainViewStore } from '@/components/panes/main-view-store'

/**
 * 主区视图开关的入口动作（2026-10-26）。
 *
 * hermes 的 `/skills` 是顶级路由（`App.tsx:166`）——点「Skills」**替换对话
 * 区**，不是新开面板。宿主的对话区 = dockview `workspace` 面板，所以这里
 * 只切 `main-view-store` 的视图（MainWorkspacePane 消费）；聊天保持挂载
 * （`display:none`），流式 run 不中断。
 */
function openCapabilitiesPane(): void {
  mainViewStore.getState().setView('capabilities')
}

/**
 * 定时任务页（2026-10-29）。
 *
 * 与 `openCapabilitiesPane` 同语义：hermes 的 `/cron` 也是顶级路由
 * （`apps/desktop/src/app/routes.ts:73`），点入口**替换对话区**。
 */
function openCronPane(): void {
  mainViewStore.getState().setView('cron')
}

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
  available: boolean
  /** lucide 图标组件（2026-10-06 用户定稿加回；hermes :1590 图标 72%） */
  icon: typeof PlusIcon
  act: (cb: EntryBarCallbacks) => void
}

/** SIDEBAR_NAV 五项（hermes sidebar/index.tsx:201-237 逐项对照；zh 文案
 *  zh.ts:2873-2879）。逐项数据面裁定注释： */
const ITEMS: EntryItem[] = [
  {
    id: 'new-session',
    label: '新建会话',
    kbd: ['Ctrl', 'N'],
    available: true,
    // hermes new-session 行（:1554-1556 $newChatProfile.set(null) + 导航）；
    // harness = assistant-ui switchToNewThread（pi_discard_session 语义）。
    // 同时把主区切回聊天（若正停在技能页——hermes 的导航语义：点聊天动作
    // = 回 /chat 路由）。
    icon: PlusIcon,
    act: (cb) => {
      mainViewStore.getState().showChat()
      cb.newThread()
    },
  },
  {
    id: 'capabilities',
    label: '技能与工具',
    available: true,
    // 2026-10-26 用户："左侧栏的技能与工具完全复制 hermes 的" +
    // "独立页面（同 hermes）"——从浮层改为面板栏的独立标签页
    // （CapabilitiesPane，hermes SkillsPage 的移植）。
    // 数据面 = pi_capabilities（pi_capabilities.rs）：技能 CRUD + 开关 +
    // 工具集启停，落 ~/.pi/agent/{skills,harness-capabilities.json}。
    icon: WrenchIcon,
    act: () => openCapabilitiesPane(),
  },
  {
    id: 'messaging',
    label: '消息平台',
    // hermes = messaging 平台面（Telegram/Slack/Discord，zh.ts:2171）；pi
    // 无消息平台桥（vendor 源码无 connector 实体）——诚实提示
    available: false,
    icon: MessageSquareIcon,
    act: () => {},
  },
  {
    id: 'artifacts',
    label: '产物',
    // hermes = 制品浏览页；pi 的产物=后台 job 的 artifact 文件（jobs.rs:5-6
    // rolling artifact file），无独立制品实体——诚实提示
    available: false,
    icon: PackageIcon,
    act: () => {},
  },
  {
    id: 'cron',
    label: '定时任务',
    // 2026-10-29：**已接通**（此前是"pi 无 cron"的诚实提示）。
    // 后端 = src-tauri/src/pi_cron.rs（存储/调度/执行/IPC，模块头有对
    // hermes cron/ 的语义对照）；前端 = hermes-mirror/app/cron/（上游逐字
    // 复制）+ hermes-shim/api/cron.ts（数据面换成 pi_cron_* IPC）。
    // 与「技能与工具」同形态：替换对话区（上游 `/cron` 是顶级路由）。
    available: true,
    icon: ClockIcon,
    act: () => openCronPane(),
  },
]

/** 左栏入口条（hermes SIDEBAR_NAV 行渲染的 harness 版）。 */
export function EntryBar({ callbacks }: { callbacks: EntryBarCallbacks }) {  // 诚实提示条（pi 无对等物的入口点击后显示；点 ✕ 或点其它可用入口即消）
  const [notice, setNotice] = useState<string | null>(null)

  return (
    <div className="hub-entry-bar">
      {/* 悬停指示 = beUI SharedLayoutBg 滑动 pill（2026-10-14 接线）：
          行间滑动比逐行洗底更有方向感；行自身 CSS hover 洗底已移除防
          双层背景。inset=0 = pill 与行同宽（行即按钮本体）。
          注：Tooltip 包裹会破坏 SharedLayoutBg 的 clone 注入（它按直接
          子元素重写行壳）——入口条保留 title=（原生提示），行本身已有
          pill 滑动/文字变色两重反馈。 */}
      <SharedLayoutBg className="hub-entry-rows" inset={0} pillClassName="rounded-[6px] bg-(--hover-wash)">
        {ITEMS.map((item) => {
          return (
            <button
              aria-label={item.label}
              className="hub-entry-row pressable-row"
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
              {/* 图标（2026-10-06 用户定稿加回——hermes :1590 同位：文字前
                  16px 槽位，图标 inherit 色随行 hover） */}
              <item.icon aria-hidden className="hub-entry-icon" size={16} />
              <span className="hub-entry-label">{item.label}</span>
              {/* 快捷键标注（hermes 仅新建会话带 KbdGroup 标注：1603-1609）；
                  harness 无 keybinds 系统——静态 Ctrl+N 注释注明（见文件头） */}
              {item.kbd && (
                <span className="hub-kbd">{item.kbd.join('+')}</span>
              )}
            </button>
          )
        })}
      </SharedLayoutBg>
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

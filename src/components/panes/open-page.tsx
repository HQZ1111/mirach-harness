/**
 * 面板栏打开页 —— **ZCode open-tab launcher 的排列**（2026-11-01 用户：
 * "面板栏的打开页的选项位置和排列用zcode的"）。
 *
 * 上游 = `packages/ui/src/app-shell/AnimatedSidePanePanel.tsx` 的
 * `openTabLauncher` + `plugin-ui/components/PluginUiLauncherItems.tsx` 的
 * `SidePaneLauncherRow`（逐类对齐，非再创作）：
 *
 * - 页壳：滚动容器 `px-7 py-6`，内容 `mx-auto max-w-3xl flex-col gap-6`，
 *   标题 `pl-2`（左对齐，与原型 SidePaneAppLauncher 同款）；
 * - **选项是两列网格**：`grid-cols-1 gap-x-8 gap-y-1`，容器查询
 *   `@min-[36rem]/openpage` 起两列（上游 named container `launcher`，
 *   这里改名 openpage 避免与容器语义混淆）；
 * - 每行 = 48px 圆角图标块 + 粗标签/灰描述 + 尾部「打开」胶囊，整行一个
 *   按钮，hover 各自洗底（上游行样式逐类照抄）。
 *
 * **与 2026-10-31 那版的取舍**：上一版的 beui `SharedLayoutBg` 滑动 pill
 * 在这里拆除——它的容器类写死 `flex-col` 单列，撑不起两列网格；上游本身
 * 就是行内 hover（`hover:bg-hover`）。滑动 pill 仍服务于 entry-bar /
 * 设置页导航 / 文件树三处。
 *
 * 项集仍是宿主自己的四种面板（files/preview/terminal/review——宿主没有
 * 浏览器/部署/开发者工具面板，不列假入口），**顺序照上游**
 * （files → browser → terminal → review，preview 占 browser 的位），
 * 描述逐字取上游 zh-CN（`sidePane.launcher.*`；files 无描述键 → 不渲染
 * 描述行，preview 的描述保留宿主语义——上游同位是浏览器，文案"浏览网页"
 * 对文件预览是假话）。标题保留 2026-10-31 用户定稿的说明文字。
 */
import {
  EyeIcon,
  FileDiffIcon,
  FolderOpenIcon,
  RadioIcon,
  SquareTerminalIcon,
  type LucideIcon,
} from 'lucide-react'

import { buttonVariants } from '@/components/ui/button'
import { useRadioFeatureEnabled } from '@/plugins/radio-gate'
import { cn } from '@/lib/utils'

export type OpenPageKind = 'files' | 'terminal' | 'preview' | 'review' | 'radio'

const ACTIONS: readonly {
  kind: OpenPageKind
  icon: LucideIcon
  label: string
  description?: string
}[] = [
  { kind: 'files', icon: FolderOpenIcon, label: '文件' },
  { kind: 'preview', icon: EyeIcon, label: '预览', description: '预览打开的文件。' },
  { kind: 'terminal', icon: SquareTerminalIcon, label: '终端', description: '运行命令和查看输出。' },
  { kind: 'review', icon: FileDiffIcon, label: '审查', description: '查看代码变更与差异。' },
  // 电台（2026-11-15）：hermes radio 插件的宿主形态——上游是桌面端状态栏
  // 插件，宿主已撤除底栏，改落窗格（打开页 + 标签条 + 号两个入口）。
  { kind: 'radio', icon: RadioIcon, label: '电台', description: '听直播电台，可搜索与置顶。' },
]

/** SidePaneLauncherRow 逐类对齐（PluginUiLauncherItems.tsx:216）。 */
function LauncherRow({
  itemId,
  icon: Icon,
  label,
  description,
  onOpen,
}: {
  itemId: string
  icon: LucideIcon
  label: string
  description?: string
  onOpen: () => void
}) {
  return (
    <button
      type="button"
      data-open-page-item={itemId}
      className="hover:bg-(--hover-wash) flex w-full min-w-0 items-center gap-3 rounded-xl px-2 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/20"
      onClick={onOpen}
    >
      <span className="bg-foreground/[0.04] flex size-12 shrink-0 items-center justify-center rounded-xl">
        <Icon className="text-(--text-3) size-6" aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="text-(--text) block truncate text-[14px] font-semibold">{label}</span>
        {description ? (
          <span className="text-(--text-3) mt-0.5 flex min-w-0 items-center gap-1.5 text-[12px]">
            <span className="truncate" title={description}>
              {description}
            </span>
          </span>
        ) : null}
      </span>
      {/* 尾部「打开」只做视觉胶囊（上游同款：整行一个按钮，避免按钮嵌套按钮） */}
      <span
        aria-hidden="true"
        className={cn(buttonVariants({ variant: 'secondary', size: 'xs' }), 'shrink-0 rounded-full')}
      >
        打开
      </span>
    </button>
  )
}

export function OpenPage({ onOpen }: { onOpen(kind: OpenPageKind): void }) {
  const radioEnabled = useRadioFeatureEnabled()
  const actions = radioEnabled ? ACTIONS : ACTIONS.filter((action) => action.kind !== 'radio')
  return (
    <div className="@container/openpage flex h-full min-h-0 flex-col" data-slot="open-page">
      <div className="min-h-0 flex-1 overflow-y-auto px-7 py-6">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
          {/* 标题 = 说明文字（2026-10-31 用户定稿），左对齐 pl-2 与上游同位 */}
          <div className="pl-2">
            <h2 className="text-(--text) text-[18px] font-semibold">在这里打开一个面板</h2>
            <p className="text-(--text-4) mt-1 text-[12px]">
              选一种面板放到面板栏，或点标签条左端的 + 号。
            </p>
          </div>
          <div className="grid min-w-0 grid-cols-1 gap-x-8 gap-y-1 @min-[36rem]/openpage:grid-cols-2">
            {actions.map((a) => (
              <LauncherRow
                key={a.kind}
                itemId={a.kind}
                icon={a.icon}
                label={a.label}
                description={a.description}
                onOpen={() => onOpen(a.kind)}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

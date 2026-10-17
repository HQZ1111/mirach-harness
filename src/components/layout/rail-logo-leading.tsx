/**
 * 左栏 logo 带（logo 50 + Mirach 文字 30/black/#006fff/字距2，用户定稿）。
 * 两处使用：
 *  - 左侧栏窗格内容顶带（LeftRailPane）——Mirach 文字是**切换钮**
 *    （onWordClick 提供时文字渲染为 button，hover 变色 + 按压效果）；
 *  - 会话分栏页签条 leading（已随 v8 换壳删除——对话栏双行块占左半，
 *    仅左栏使用本组件）。
 *
 * 悬停提示（2026-10-16 用户："悬停显示的窗口动画怎么没有，不是下载了
 * beui 组件了吗"）：原生 title= 换 beUI Tooltip（动画化浮层 + 延迟，
 * 与 win-dot 同款）。
 */
import { Tooltip } from '@/components/motion/tooltip'

export const RailLogoLeading = ({
  onWordClick,
  wordTitle,
}: {
  onWordClick?: () => void
  wordTitle?: string
}) => (
  <div className="rail-logo-leading">
    <img alt="" className="rail-logo-mark" src="/brand/logo.png" />
    {onWordClick ? (
      <Tooltip content={wordTitle ?? ''} side="bottom">
        <button
          className="rail-logo-word rail-logo-word-btn pressable-sm"
          onClick={onWordClick}
          type="button"
        >
          Mirach
        </button>
      </Tooltip>
    ) : (
      <span className="rail-logo-word">Mirach</span>
    )}
  </div>
)

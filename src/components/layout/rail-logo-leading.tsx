/**
 * 左栏 logo 带（logo 50 + Mirach 文字 30/black/#006fff/字距2，用户定稿）。
 * 两处使用：
 *  - 左侧栏窗格内容顶带（LeftRailPane）——Mirach 文字是**切换钮**
 *    （onWordClick 提供时文字渲染为 button，hover 变色 + 按压效果）；
 *  - 会话分栏页签条 leading（onRenderTabSet 注入，v6.0 对话栏条恒显但
 *    leading 不再注入 logo——对话栏双行块占左半，仅左栏使用本组件）。
 */
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
      <button
        className="rail-logo-word rail-logo-word-btn"
        onClick={onWordClick}
        title={wordTitle}
        type="button"
      >
        Mirach
      </button>
    ) : (
      <span className="rail-logo-word">Mirach</span>
    )}
  </div>
)

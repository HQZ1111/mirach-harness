/**
 * 状态栏（用户定稿：高度 20）。当前是骨架占位 pill——网关/模型态接 pi 后
 * 由真实数据驱动（hermes app/shell/statusbar* 的 harness 对应位）。
 */

export function StatusBar() {
  return (
    <div className="app-statusbar">
      <span className="statusbar-pill">default ▾</span>
      <span className="statusbar-pill">⏳ 网关 检查中</span>
      <span className="statusbar-spacer" />
      <span className="statusbar-pill">⚡ 智能</span>
    </div>
  )
}

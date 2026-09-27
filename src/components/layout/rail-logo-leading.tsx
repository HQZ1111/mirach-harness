/** 会话分栏 logo 带（logo 50 + MIRACH 30/black/#006fff/字距2）：横向条 leading 与竖轨形态内容顶带共用 */
/** 会话分栏的 logo 带（logo 50 + MIRACH 30/black/#006fff/字距2，用户定稿）：
 *  横向形态渲染在页签条 leading（onRenderTabSet）；竖轨形态横向条被隐藏，
 *  工厂把它补在分栏内容顶部（.rail-pane-railform）——两处共用一个组件。 */
export const RailLogoLeading = () => (
  <div className="rail-logo-leading">
    <img alt="" className="rail-logo-mark" src="/brand/logo.png" />
    <span className="rail-logo-word">MIRACH</span>
  </div>
)

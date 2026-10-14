/**
 * 主对话栏调色层（MainTint，v6.0 语义；v8.0 dockview 版 2026-10-14 回迁）。
 *
 * 原 flexlayout 版（chrome-overlays.tsx）以宿主叠片绝对定位量 workspace
 * tabset 矩形——M1 换 dockview 时组件丢失（用户实锤"对话区的颜色层怎么
 * 没有了"）。dockview 下改为**面板内子元素**：放在主栏 panel 内容里
 * （AssistantThreadPane 内），CSS 绝对定位铺满自身面板——坐标量测整个
 * 消失（与 v8 布局定稿"工作区名=容器子元素"同款思路：叠片宿主方案退役，
 * 内容自持）。
 *
 * 视觉 = 原样（.main-tint 类：--main-tint-color E9EEEF@40% + 圆角
 * --main-tint-radius；z-index:-1 垫在内容下，宿主 isolation 保证不掉到
 * 白底之下）。顶带留白：容器 padding-top 让出 --logo-strip-h 后，本层
 * inset 从 padding 区之外起画（inset 见 CSS）。
 */
export function MainTint() {
  return <div aria-hidden className="main-tint main-tint--dockview" />
}

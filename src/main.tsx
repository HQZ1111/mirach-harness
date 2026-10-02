import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './app'
import { AppContextMenu, openAppContextMenu } from './components/layout/app-context-menu'
import { ZoneContextMenuHost, openZoneContextMenuAt } from './components/layout/pane-context-menu'
import { inTauri } from './lib/tauri-window'
import { resolveContextMenuScope } from './components/panes/session-manage/context-menu-scope'
// HarmonyOS Sans SC webfont（用户定稿：全局字体）——切片 woff2 + CSS
// （包 exports 只开放 default=dist/index.css，子路径导入会被 vite 拦）
import 'harmonyos-sans-sc-webfont-splitted'
// 样式分层（见 src/styles/tokens.css 头注释）：令牌 → 壳 → flexlayout
// → 窗格 → 编辑器 → 叠片。规则文件里禁止写字面值，取值一律进 tokens.css。
import './styles/tokens.css'
import './styles/base.css'
import './styles/flexlayout.css'
import './styles/panes.css'
import './styles/editor.css'
import './styles/overlays.css'
// 全局原语（hermes 可抄件）：滚动条/弹窗阴影/z 层令牌——tailwind 之前，
// 其工具类仍可覆盖
import './styles/ui-primitives.css'
// Tailwind v4 + assistant-ui registry 组件主题（shadcn 令牌；最后导入，
// 组件工具类可覆盖上方体系的同面规则）
import './styles/tailwind.css'

// 纯浏览器直开（无 Tauri 透明窗体）：铺满不圆角，见 base.css 窗体段
if (!inTauri) document.body.classList.add('in-browser')

// 全局右键范围裁定（hermes app-context-menu 体系的 Tauri 语义裁剪，纯函数
// 见 context-menu-scope.ts）。capture 段一次监听、全应用一个裁定：
// - editable（input/textarea/contenteditable）→ 放行 WebView2 原生编辑菜单；
// - owned（自带 Radix ContextMenu 的面：会话行 / 文件树行）→ 早退，让
//   Radix 自己的 handler 开菜单并压原生菜单——这里抢跑 preventDefault 会
//   令 composeEventHandlers 的 defaultPrevented 检查跳过 Radix 的开启分支
//   （菜单不弹），故 owned 面既不 preventDefault 也不 stopPropagation；
// - app（其余一切）→ preventDefault 压掉 WebView2 默认菜单。mock seam
//   时代的冒泡段全局 preventDefault 随 mock 一起删除后，非行区域右键
//   弹 WebView2 菜单（2026-10-01 用户实测 + CDP 实证），此处恢复。
// - pane（flexlayout 窗格 body，.flexlayout__tab）→ 同 owned 早退不
//   preventDefault：窗格容器自挂 Radix ContextMenu（components/layout/
//   pane-context-menu.tsx 工厂层 .pane-zone-menu-surface 面铺满 body），
//   Trigger 的 handler 自己 preventDefault + 开分栏操作菜单。这里抢跑
//   preventDefault 会让 composeEventHandlers 跳过开启分支（窗格右键又变
//   回"压无菜单"）。
// - app（其余一切）→ preventDefault 压掉 WebView2 默认菜单，再按落点分派
//   （hermes app-context-menu 体系：落点收集 → 组菜单）：
//   · .flexlayout__tabset 内（页签 body 之外 = 页签条/拉伸头栏/logo 带/条上
//     空白——hermes ZoneMenu 的 strip 面，tree-group.tsx 486）→ 弹该分栏的
//     ZoneMenu（openZoneContextMenuAt，与页签 body 表面同一份项清单——
//     components/layout/pane-context-menu.tsx store 路由）。页签按钮例外：
//     flexlayout 自管页签菜单（钉住/重命名…）照旧。
//   · 其余（标题栏/状态栏/分隔条/宿主空白）→ app 菜单（shellSections：
//     bare right-click on app chrome = 窗口动词，components/layout/
//     app-context-menu.tsx）。
//   flexlayout 自管面例外：边框轨（.flexlayout__border）/flexlayout 页签
//   弹层（.flexlayout__popup_menu_container）的右键由 flexlayout
//   onTabContextMenu 接管（TabNode=弹层菜单，TabSetNode/BorderNode=仅压
//   菜单）——hermes 里这些面同样归树渲染器自己的 zone 菜单管。**不能按
//   .flexlayout-host 整体豁免**：宿主是无边框窗的全窗绝对层（标题栏是
//   pointer-events 穿透的浮片），按宿主豁免 = app 菜单在除状态栏外全窗
//   失效（CDP 实测）。窗格 body 右键在 pane 分支已早退，到不了这里；其余
//   布局面（分隔条/编辑器画布/veil）= bare right-click，hermes 同语义
//   （落点无自有菜单 → shell 菜单）。
window.addEventListener(
  'contextmenu',
  (event) => {
    if (!(event.target instanceof Element)) return
    if (resolveContextMenuScope(event.target) !== 'app') return
    event.preventDefault()
    if (event.target.closest('.flexlayout__border, .flexlayout__popup_menu_container')) return
    const setEl = event.target.closest('.flexlayout__tabset')
    if (setEl) {
      // 页签按钮右键 = flexlayout 自管页签菜单（showPopupMenu，页签粒度
      // 动作）——不拦不弹 ZoneMenu；拉伸头栏（tab_button_stretch）不带基础
      // tab_button 类，落这里 = 分栏级 ZoneMenu（hermes 同）。
      if (event.target.closest('.flexlayout__tab_button')) return
      openZoneContextMenuAt(event.clientX, event.clientY, setEl)
      return
    }
    openAppContextMenu(event.clientX, event.clientY)
  },
  true,
)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    {/* app 右键菜单 + 命令面板/设置浮层最小开关（app 根挂载，树外——
        详情见 app-context-menu.tsx 文件头）；ZoneContextMenuHost = tabset
        chrome 落点的 store 路由 ZoneMenu（pane-context-menu.tsx 文件头） */}
    <AppContextMenu />
    <ZoneContextMenuHost />
  </StrictMode>
)

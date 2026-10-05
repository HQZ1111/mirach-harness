import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './app'
import { AppContextMenu, openAppContextMenu } from './components/layout/app-context-menu'
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
// - app（其余一切——v6.0：**含 flexlayout 窗格 body/页签条 chrome/页签
//   按钮**）→ preventDefault 压掉 WebView2 默认菜单，openAppContextMenu
//   开**唯一右键菜单**（ZoneMenu 体系与 flexlayout 自管页签菜单均已裁；
//   「隐藏标签」目标 = 落点所在 .flexlayout__tabset 的模型 id，hermes
//   toggleTargetZoneTabStrip 的"哪个栏"归属）。边框轨/页签弹层（flexlayout
//   自管面）早退。
window.addEventListener(
  'contextmenu',
  (event) => {
    if (!(event.target instanceof Element)) return
    if (resolveContextMenuScope(event.target) !== 'app') return
    event.preventDefault()
    if (event.target.closest('.flexlayout__border, .flexlayout__popup_menu_container')) return
    let tabsetId: string | undefined
    const setEl = event.target.closest('.flexlayout__tabset')
    if (setEl) {
      const model = (window as { __flModel?: import('flexlayout-react').Model }).__flModel
      const path = setEl.getAttribute('data-layout-path')
      let found: { getId(): string } | undefined
      model?.visitNodes((n) => {
        if (!found && n.getType && n.getType() === 'tabset' && n.getPath() === path) found = n
      })
      tabsetId = found?.getId()
      if (tabsetId === undefined) console.error('[context-menu] 落点分栏不在当前模型', path)
    }
    openAppContextMenu(event.clientX, event.clientY, tabsetId)
  },
  true,
)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    {/* app 右键菜单（唯一右键菜单）+ 命令面板/设置浮层开关（app 根挂载，
        树外——详情见 app-context-menu.tsx 文件头） */}
    <AppContextMenu />
  </StrictMode>
)

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './app'
import { inTauri } from './lib/tauri-window'
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

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)

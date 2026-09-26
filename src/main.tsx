import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './app'
import { inTauri } from './lib/tauri-window'
// 样式分层（见 src/styles/tokens.css 头注释）：令牌 → 壳 → flexlayout
// → 窗格 → 编辑器 → 叠片。规则文件里禁止写字面值，取值一律进 tokens.css。
import './styles/tokens.css'
import './styles/base.css'
import './styles/flexlayout.css'
import './styles/panes.css'
import './styles/editor.css'
import './styles/overlays.css'

// 纯浏览器直开（无 Tauri 透明窗体）：铺满不圆角，见 base.css 窗体段
if (!inTauri) document.body.classList.add('in-browser')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)

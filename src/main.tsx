import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

// 必须先于主题/translucency 模块求值：装上窗口透明桥（见文件头）。
import './lib/translucency-host'

// ── 样式必须**先于** app 图求值导入（2026-10-16 实锤）──
// ESM 按 import 序深度优先求值：CSS import 在前 → vite 先注入 <style>，
// 之后的 ease.ts（模块顶层 getComputedStyle 读 --beui-spring-* 令牌）
// 才读得到值。此前 app 图在前 → ease.ts 先于样式注入求值 → 全部静默回退
// 内置值（回退值与令牌同源故无可见症状；改 tokens.css 不生效 = 实锤路径）。
// 顺序约束照旧：dockview → 自有三层 → tailwind 最后。
// HarmonyOS Sans SC webfont（用户定稿：全局字体）——切片 woff2 + CSS
// （包 exports 只开放 default=dist/index.css，子路径导入会被 vite 拦）
import 'harmonyos-sans-sc-webfont-splitted'
// dockview 官方样式（v8.0 换栈）：**必须**在自有样式之前——.dv-* 的
// 定位/尺寸/overflow 规则全在此表；漏掉它布局渲染成堆叠裸 div（M4 实锤：
// "内容全错位"根因 = M1 写壳时忘了这条 import）。
import 'dockview-react/dist/styles/dockview.css'
// codicon 字体（@vscode/codicons dist，与 hermes 桌面端同一份包）：
// hermes 的 Codicon 组件（审查面板/技能与中心/连接器整套图标）按名字取字形，
// 必须与上游同源——手抄零星 SVG path 不现实。排在自有样式之前，
// 让 styles/*.css 可覆盖（.codicon 的 font-family/size 由组件内联控制）。
import '@vscode/codicons/dist/codicon.css'
// 样式分层（见 src/styles/tokens.css 头注释）：令牌 → 壳 → flexlayout
// → 窗格 → 叠片。规则文件里禁止写字面值，取值一律进 tokens.css。
// （editor.css 已删：.ep-*/.ze-* 对应组件在 v5.0/v8.0 两轮删除后无消费方）
import './styles/tokens.css'
// hermes 镜像树的 --ui-* / --dt-* / --theme-* 令牌（补齐 tokens.css 未定义的
// 56 个；必须在 tokens.css 之后——两者都是 :root，后者胜出，而本文件刻意
// 不重复定义已验收的宿主别名）
import './styles/hermes-tokens.css'
// hermes 镜像树直接用到的上游语义类（.desktop-input-chrome / .ref /
// .dt-portal-scrollbar / .dither / .setting-field-highlight 等 13 个）
import './styles/hermes-ui.css'
import './styles/base.css'
import './styles/flexlayout.css'
import './styles/panes.css'
import './styles/overlays.css'
// 外观页的氛围层（底部波浪动效），在 tailwind 之前导入。
import './styles/appearance.css'
// 启动页（LaunchOverlay + ReactBits ParticleText）样式。
import './styles/launch.css'
// 全局原语（hermes 可抄件）：滚动条/弹窗阴影/z 层令牌——tailwind 之前，
// 其工具类仍可覆盖
import './styles/ui-primitives.css'
// Tailwind v4 + assistant-ui registry 组件主题（shadcn 令牌；最后导入，
// 组件工具类可覆盖上方体系的同面规则）
import './styles/tailwind.css'

import { inTauri } from './lib/tauri-window'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { ThemeProvider } from './hermes-mirror/themes/context'
import { GlobalBackdrop } from './components/backdrop'
import { UpdateBootCheck } from './components/update-boot-check'
// 外观偏好必须在根组件挂载前应用（缩放 / 字体 / 字号跨窗口一致）。
import './lib/appearance-prefs'

/**
 * 窗口分派（2026-10-23 起真正生效）。
 *
 * `app/index.tsx` 的注释早就写着"按 `?win=` 分派"，但**从来没有这段代码**
 * ——之前只有主窗，那句话是空头注释。设置独立窗口（Rust 侧
 * `WebviewUrl::App("index.html?win=settings")`）需要它，故在此落地。
 *
 * `?win=quick` / `?win=hud` 仍**未接**：骨架在 `app/quick-entry/` 与
 * `app/hud/`，但没有窗口创建方。这里不为它们写假分支——落到默认主窗，
 * 行为与今天一致。
 *
 * ## 为什么两棵树必须**动态** import（2026-10-30 实锤）
 *
 * 此前 `App` / `SettingsWindowRoot` / `AppContextMenu` 全是**静态** import。
 * 静态 import 会在模块图求值阶段无条件加载整棵子树——于是设置窗（只渲染
 * `SettingsWindowRoot`）**仍然把整个主窗拉了进来**。CDP 实测设置窗首个
 * 文档的 198 个 `/src/` 模块里 **144 个是 `components/`**，含 dockview、
 * assistant-ui、thread.*（全是聊天界面的东西，设置窗一个都不渲染）。
 * 代价：首帧 2988ms，用户看到"白屏 → 黑屏 → 才出页面"。
 *
 * 改成按 `?win=` 分支动态 import 后，两个窗口各只加载自己那棵树。
 * **不要为了"简洁"改回静态 import**——那会把这次 3 秒的等待原样还回来。
 */
const winParam =
  typeof window === 'undefined'
    ? null
    : new URLSearchParams(window.location.search).get('win')

/**
 * 设置独立窗口：**不渲染**主窗壳与全局右键菜单（那是主窗的东西）。
 *
 * 判定用「URL `?win=` **或** Tauri 窗口 label」双源（2026-11-21 修）：
 * CDP 实测到过 settings 窗口的 URL 掉成 `/`（history 里多了一条
 * `/index.html?win=settings` → `/`）——此时只按 URL 判定会让设置窗
 * **整棵主窗应用**（会话列表 + composer + 全部 store/轮询），等于把
 * 主应用跑两份（实测 +150MB JS 堆）。label 是窗口的权威身份，
 * URL 只作浏览器直开（无 Tauri）时的退路。
 */
const settingsLabel = (() => {
  if (!inTauri) return false
  try {
    return getCurrentWindow().label === 'settings'
  } catch (e) {
    console.error('[boot] 读取窗口 label 失败——按 URL 判定', e)
    return false
  }
})()
const isSettingsWindow = winParam === 'settings' || settingsLabel

// 纯浏览器直开（无 Tauri 透明窗体）：铺满不圆角，见 base.css 窗体段
if (!inTauri) document.body.classList.add('in-browser')

const rootEl = document.getElementById('root')!

/**
 * 启动期模块加载失败的自愈（2026-11-16 用户实报"又白屏了"）。
 *
 * vite 重启/配置变更（tsconfig/vite.config 被插件移植改动）时，浏览器可能
 * 在 server ready 之前请求 `/src/app/index.tsx` → "Failed to fetch dynamically
 * imported module" → dynamic import reject → 根节点永远空白（页面不会自己再试）。
 * 这里只自动重载 **一次**（sessionStorage 护栏防死循环）；第二次仍失败就停在
 * 控制台可见的错误上，等用户手动刷新，绝不无限刷新。
 */
function retryBootOnce(err: unknown): void {
  console.error('[boot] 模块加载失败', err)
  try {
    if (sessionStorage.getItem('mirach.boot-retried') === '1') {
      console.error('[boot] 已自动重试过一次，停止刷新——请手动刷新窗口')
      return
    }
    sessionStorage.setItem('mirach.boot-retried', '1')
  } catch {
    return
  }
  window.setTimeout(() => window.location.reload(), 800)
}

/** 渲染成功后清掉重试标记，下一次启动仍可自愈。 */
function clearBootRetry(): void {
  try {
    sessionStorage.removeItem('mirach.boot-retried')
  } catch {
    /* nonfatal */
  }
}

// 设置独立窗口：整窗只有设置页，不需要主窗的右键菜单体系（那个菜单的
// 每一项——新建会话/布局/隐藏栏——在设置窗里全是无意义的）。
if (isSettingsWindow) {
  void import('./app/overlays/settings-window')
    .then(({ SettingsWindowRoot }) => {
      createRoot(rootEl).render(
        <StrictMode>
          <ThemeProvider>
            <SettingsWindowRoot />
          </ThemeProvider>
        </StrictMode>,
      )
      clearBootRetry()
    })
    .catch(retryBootOnce)
} else {
  void Promise.all([
    import('./app'),
    import('./components/layout/app-context-menu'),
    import('./components/panes/session-manage/context-menu-scope'),
  ]).then(([{ App }, { AppContextMenu, openAppContextMenu, openDomContextMenu }, { contextMenuEditable, resolveContextMenuScope }]) => {
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
        const scope = resolveContextMenuScope(event.target)
        if (scope === 'owned') return
        // 可编辑区 + 选中文字 = hermes domSections 的编辑/复制段（Tauri 无
        // contextMenuEdit 桥，动作在 renderer 用 clipboard/execCommand 对偶）。
        // 不再放行 WebView2 原生菜单：用户要求"选中文字的右键和输入框的右键"
        // 都走应用菜单。
        const editable = contextMenuEditable(event.target)
        const selectionText = window.getSelection()?.toString().trim() ?? ''
        if (editable || selectionText) {
          event.preventDefault()
          openDomContextMenu(event.clientX, event.clientY, { editable, selectionText })
          return
        }
        event.preventDefault()
        // v8.0 dockview：右键落点分栏解析已随「隐藏标签」行废除（左/主栏组
        // 恒无条、面板栏条恒显）——菜单布局行全部从栏旗标现读。
        openAppContextMenu(event.clientX, event.clientY)
      },
      true,
    )

    createRoot(rootEl).render(
      <StrictMode>
        <ThemeProvider>
          <GlobalBackdrop />
          <App />
          {/* 启动时自动检查更新（偏好默认关；只检查 + 系统通知，不自动安装） */}
          <UpdateBootCheck />
          {/* app 右键菜单（唯一右键菜单）+ 命令面板/设置浮层开关（app 根挂载，
              树外——详情见 app-context-menu.tsx 文件头） */}
          <AppContextMenu />
        </ThemeProvider>
      </StrictMode>,
    )
    clearBootRetry()

    // **首帧就绪 → 让 Rust 显示主窗**（2026-11-28 修"灰屏没起来"）：
    // 主窗 visible:false 创建 + 透明窗；webview 首帧前 show = 空灰玻璃
    // （冷启动 1~3s，实机截图实锤）。rAF×2 = 第一帧已提交，再发 ui_ready；
    // Rust 侧幂等显示，且 5s 兜底也会显示（前端崩了不会永远隐形）。
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        void import('@tauri-apps/api/core')
          .then(({ invoke }) => invoke('ui_ready'))
          .catch((e) => console.error('[boot] ui_ready 发送失败（主窗将由 5s 兜底显示）', e))
      })
    })

    // 内置插件（hermes bots 等）——与运行时磁盘门并列的第二条插件源：
    // vite 打包的整棵工程 + createContext 注册。失败只进设置页插件记录，
    // 不打白壳。
    void import('./plugins/bundled')
      .then(({ startBundledPlugins }) => startBundledPlugins())
      .catch((e) => console.error('[plugins] 内置插件启动失败', e))

    // 运行时插件热拔插：装 SDK 命名空间 → 扫描 <app_data>/desktop-plugins →
    // 每 1.5s 比对 mtime（保存即重载）。整条链动态 import + catch：插件侧
    // 任何失败都只影响插件清单，不把宿主壳打白。
    void import('./sdk/runtime')
      .then(({ installPluginSdk }) => installPluginSdk())
      .then(() => import('./hermes-shim/contrib/runtime-loader'))
      .then(({ discoverRuntimePlugins, startRuntimePluginWatch }) => {
        void discoverRuntimePlugins()
        startRuntimePluginWatch()
      })
      .catch((e) => console.error('[plugins] 运行时插件启动失败', e))
  }).catch(retryBootOnce)
}

# 代码审计与 mock seam 归档（2026-10-06 AGENTS 瘦身切出）

> 代码审计（2026-09-26）与 mock seam（已删除的死功能）——历史参考。

## 代码审计（2026-09-26，触发：adjustWeights 数据键 bug）

**同类"静默失效"全面扫描**（脚本核对全部 action.data.* 读取点 × flexlayout
工厂签名、全部 data-layout-path 查询点、全部 doAction 构造点）：

- **已修 1**：ADJUST_WEIGHTS 数据键 node（应为 nodeId）——见上。
- **已修 2**：pinPass 行子项量测——行元素无 data-layout-path，含行子项的
  行（Default 的根行含 spl-right ROW）重钉静默放弃 → resize 后固定轨道
  按比例缩水（350→291）。修复：measureNodePx（tabset 查 DOM；行子项用
  后代 tabset 的 union rect）+ 一次到位的余量再分配（旧归一化写法会把
  固定轨也缩掉，割线两轮收敛不到）。验证：1500→1800 resize，rail 稳定
  350（±4px 量测偏差：union rect 与 flex 份额的固有噪声，视觉不可辨）。
- **其余 6 处 action.data 读取全部核对正确**：DELETE_TAB.node、
  SELECT_TAB.tabNode、MOVE_NODE.fromNode/toNode（rail 不变量实测工作）、
  ADJUST_WEIGHTS.nodeId（已修）、adjustBorderSplit.node（peek 350 实测）。
- **其余 data-layout-path 查询（7 处）全部查 tabset**（有该属性）。

**原生能力清单**（哪些能直接用原生）：

已在用原生：树操作全套（moveNode/addNode/deleteTab/selectTab/
updateNodeAttributes）、tidy 自动回收、enableEdgeDock:false 配置、
分隔条对直接子 tabset 的原生 min/max 钳制、addNode 的 DockLocation
竖分/横分（打开页终端按钮重建底部行就靠它）。

必须自建（flexlayout 没有）：嵌套约束传播 + 富余回灌（原生只钳直接
子项、再分配按 grow 比例不支持 prefer）、投放预览 overlay、页签归属
准入（region 过滤）+ 上下两行上限、pointer 拖拽接管（原生 HTML5 DnD
在 Tauri dragDropEnabled:false 下不触发 + 功能不支持）、px 记忆/钉回
（原生纯权重制）、MainTint/双行块（tabset DOM 不可注入）。

未用的原生能力（接 pi 前定取舍）：popout/float 浮动窗口、tabGroups
分组着色、keyMap 键盘导航、border 折叠轨道（v5.0 废）、
SingleTabStretch（v6.0 关——对话栏页签条恒显）。

**审计方法教训**：①"验证通过"要找到真正的生效机制——min/max 生效可能
只是原生直接子项钳制的巧合（我方钳制当时从未运行）；②flexlayout 的
action 数据键不统一（node/nodeId/tabNode/fromNode），写拦截器必须逐个
对照工厂签名；③行元素没有 data-layout-path——对行的 DOM 查询一律用
后代 tabset 的 union rect。
## 布局与引擎（v8.0）

**主文档 = `docs/architecture.md`（Tauri 最新版 + CEF + dockview）**；
**布局语义 = `docs/layout-v8.md`**（三栏：左栏/主栏无标签，面板栏唯一
多标签；工作区名=容器子元素；分栏指派会话）。flexlayout 时代规则归档
`docs/history-flexlayout.md`（M1 迁移期间仍约束现有代码）。
**多柄引擎（v7.5 平移）**：side_engines 表/定向中断/sessionPath 路由。

## 目录结构（2026-09-25 定稿，参照 hermes desktop 按本架构 L1-L5 裁剪）

```
src/
  main.tsx            入口（未来 ?win= 窗口分派在此）
  styles/             令牌 + 分层样式（tokens/base/flexlayout/panes/editor/overlays，
                      见 tokens.css 头注释的架构说明与规矩）
  app/                应用壳与窗口子应用（hermes app/ 的对应位）
    index.tsx         主窗根（窗口分派注释在此）
    shell/            主窗 chrome：titlebar.tsx / window-controls.tsx / statusbar.tsx
    hud/              【空骨架】HUD 子应用（components/ lib/ 空子目录已建）
    quick-entry/      【空骨架】快捷入口子应用（components/ lib/ 空子目录已建）
    wake-indicator/   【空骨架】唤醒指示
    pet-overlay/      【空骨架】宠物悬浮层
    overlays/         全局 overlay（settings-overlay.tsx 设置页 §7-7 已落位；
                       boot-failure 等仍空）
  components/
    layout/           flexlayout 布局引擎与拖拽系统（=hermes components/pane-shell）
    panes/            窗格内容（占位）
    ui/               通用 UI 原语（codicons.tsx；未来 shadcn 原语）
    assistant-ui/     聊天渲染 L1 核心：runtime.tsx（ExternalStore 适配器）/
                       turn-actor.ts（**XState v5 轮次机+reduceAguiEvent 落位在
                       此**，src/agent/ 空骨架仍保留待未来归位）/
                       connection-store.ts / error-bridge.ts / usage-bridge.ts /
                       approval-bridge.ts / approval-cards.tsx /
                       model-selector.tsx / context-display.tsx /
                       elements/（**官方元件库全量在树 118 文件**【用户定稿
                       2026-10-02】：10 个已接线为 .aui 连接版在跑，其余 108
                       个为官方 elements 模板待按需接线——路径=拷入→写
                       .aui 连接版→扩展成完善件挂 thread；勿删勿称死代码，
                       曾误清后全量恢复）
  lib/                通用工具（tauri-window/escape-layers/drag-ghost/reorder）
  store/              Zustand 状态层（layout-store.ts；2026-09-26 从 nanostores
                       迁移，tab-selection.ts 同迁——vanilla store 供事件回调）
  agent/               【空骨架】XState Agent 轮次状态机（turn-actor 实际落位
                      components/assistant-ui/，未来归位到此）
  api/                【空骨架】L2：AG-UI HTTP+SSE 客户端
  ipc/                【空骨架】L2：Tauri IPC 调用层
  contrib/            【空骨架】窗格/能力注册表（hermes contrib 对应位）
  hooks/ types/ i18n/ themes/ test/  【空骨架】
  public/brand/        品牌物料（2026-09-25 落位）：logo.png / avatar.png（头像）/
                       splash.png（启动页）/ logo.svg（8 色 SVG，39.7KB，UI 缩放用）/
                       logo-detail.svg（24 色 SVG，154KB，细节版）/
                       avatars/{agents,users}/（空占位）/ backgrounds/（9 张壁纸壁画）
src-tauri/            L3 Rust 应用层（+未来 L4 pi-adapter）：
                       pi_session.rs（PiRuntime/PiEngine/审批桥）/
                       agui.rs（AG-UI HTTP 桥+环形缓冲+映射器+30 内嵌单测）/
                       pi_settings.rs（§7-7 设置面 5 命令）/
                       fs.rs / main.rs（18+5 IPC 命令）
  src-tauri/vendor/pi_agent_rust/   **pi vendored 副本**（2026-10-01：白名单拷贝，
                       255MB→22MB；含上游 gh #239 同款 .read(true) 补丁；
                       上游真源 G:\pi_agent_rust-main 不进 git，同步上游=重拷
                       并核对补丁）
```
规矩：新文件按层归位；空骨架目录内的实现文件落位时不许再建平行目录
（先来本表登记）。

### 系统托盘（2026-09-25，语义照抄 ZCode packages/desktop/src/main/desktopTray.ts）
- `src-tauri/src/main.rs` setup：`TrayIconBuilder`（图标 = default_window_icon，
  即品牌 logo）+ 菜单「显示主窗口/退出」+ tooltip；**左键单击托盘 = 显示主窗**
  （show_menu_on_left_click(false)，菜单走右键）；`on_menu_event` 处理
  tray-open/tray-quit（quit = app.exit(0)）。
- **✕ 关闭 = 隐藏到托盘**（`on_window_event` 拦 `CloseRequested` →
  prevent_close + 隐藏），退出只走托盘「退出」——ZCode 的
  closeToTrayOnWindows 语义。Cargo tauri features 加了 `"tray-icon"`。
- **两个大坑（实测）**：
  1. **tao 的 `window.hide()` 在 transparent 窗口上失效**——Ok 但窗口仍
     在屏幕上（SW_HIDE 疑似被 flag/diff 逻辑吞掉）。修法：`window.hwnd()`
     拿句柄后**裸 FFI `ShowWindow(hwnd, SW_HIDE/SW_SHOW)`**（main.rs 的
     raw_show_window，`#[link(name = "user32")]`——写成
     `#[link(name="user32.dll")]` 会生成 user32.dll.lib 链接错误；且
     #[link] extern 块必须放模块级，函数体内 E0459）。
  2. 验证窗口隐藏**不能用 CDP visibilityState / IsWindowVisible(MainWindowHandle)**
     ——前者不随窗口 hide 变化，后者可能指向别的辅助窗口；**唯一可靠是
     CopyFromScreen 真实屏幕截图**（fl-screencap.ps1）。
- tauri.conf `build.beforeDevCommand: npm run dev` + harness devDep
  `@tauri-apps/cli`：**`npm run tauri dev` 从此自管 vite 生命周期**（此前
  手动分离 vite 一死窗口就"打不开"——本轮打不开的根因）。
  **vite.config 必须忽略 `src-tauri/**` 的 watch**——cargo 链接锁
  mirach_harness.exe 时 chokidar EBUSY 把 vite 整个带走（规矩 8 的
  tauri dev 形态）。

### hermes desktop 顶层文件对照（2026-09-25 定论：现在一个都不搬）
- **永久跳过**：`electron/`（395 文件，Tauri 壳已替代）；`pr-assets/`、
  `preview-demo.html`、`DESIGN.md`、hermes 自己的 `AGENTS.md`/`README.md`
  （品牌/文档，留在 D 盘参考）。
- **已有等价物**：`assets/`（icon 三件套）→ 本工程 `src-tauri/icons/`；
  `tsconfig.json`/`vite.config.ts`/`package.json`/`index.html` → 已有。
- **暂缓（能力落地时再建自己的，不复制 hermes 的）**：
  `scripts/`（hermes 是 Electron 打包钩子，
  本工程打包走 tauri build）、`e2e/`+`playwright.config.ts`+`tsconfig.e2e.json`
  （做 E2E 时建，结构可照抄）、`vitest.config.ts`+`vitest.setup.ts`
  （写第一个单测时建，localStorage Map 替身照规矩搬）、
  `eslint.config.mjs`（引入 lint 时）、`components.json`（shadcn 配置——
  接 shadcn/assistant-ui 时才有效，且 shadcn 依赖 Tailwind，与本工程
  手写令牌 CSS 的取舍到时先定）。

- **状态库迁移（2026-09-26）：nanostores → Zustand 完成**。layout-store.ts
  重写为单 store（create + selector 订阅），tab-selection.ts 重写为 vanilla
  store（事件回调走 getState/setState，flex-layout 经 useTabSelection 订阅）；
  模块级 action 导出保留迁移前 API 面（openEditMode/setPaneSizes/…，内部
  代理 getState）。nanostores + @nanostores/react 已卸载。持久化语义
  （paneSizes/hiddenPanes/sides 的 localStorage 读写时机）逐条保留。回归：
  编辑模式/侧栏收起+persist/预设保存/多选全绿。**消费方约定**：组件用
  useLayoutStore(s => s.x) 订阅；非 React 上下文用 useLayoutStore.getState()
  + 模块级 action。

- **状态库迁移（2026-09-26）：nanostores → Zustand 完成**。layout-store.ts
  重写为单 store（create + selector 订阅），tab-selection.ts 重写为 vanilla
  store（事件回调走 getState/setState，flex-layout 经 useTabSelection 订阅）；
  模块级 action 导出保留迁移前 API 面（openEditMode/setPaneSizes/…，内部
  代理 getState）。nanostores + @nanostores/react 已卸载。持久化语义
  （paneSizes/hiddenPanes/sides 的 localStorage 读写时机）逐条保留。回归：
  编辑模式/侧栏收起+persist/预设保存/多选全绿。**消费方约定**：组件用
  useLayoutStore(s => s.x) 订阅；非 React 上下文用 useLayoutStore.getState()
  + 模块级 action。
- **public/ 已建（2026-09-25，品牌物料到位）**：见目录结构 public/brand/ 段。
  logo→SVG 用 imagetracerjs（npm，装在 %TEMP%\fl-svgtool 工具目录，未进
  工程依赖）+ pngjs 解码 + 320px 降采样描摹；logo.svg=8 色版（干净、UI 缩放
  用），logo-detail.svg=24 色版（细节多、脸上有描摹噪点）。插画带渐变，
  描摹是色块化近似——印刷级矢量需原画重绘，位图版 PNG 仍是 UI 首选。
  RailLogo 与 favicon 已接 /brand/logo.png。
- **应用图标（任务栏/exe 资源）已换品牌图（2026-09-25）**：源 =
  `public/brand/app-icon.png`（1024×1024 正方形，由 logo.png 衡边+降采样生成，
  tauri icon 要求正方形透明 PNG）；`npx tauri icon <src> -o src-tauri/icons`
  生成全套（含未来 L5 Android mipmap）。**坑：改 icon 后 tauri-build 不一定
  重跑资源编译——exe 里嵌的还是旧图**（用 exe 二进制里搜 PNG 签名可验证）。
  强制刷新：杀应用 → 删 `target\debug\build` → touch build.rs → cargo run。
  Windows 资源管理器/任务栏还有一层图标缓存，路径不变时可能要重启应用才刷新。


> **2026-09-25 目录拆分（用户拍板）**：`mirach-harness` 已单独移出至
> **`G:\mirach-harness`**（活跃项目，后续会话请开在那里；harness 根有本文件
> 的副本）；本文件夹改名 **`G:\参考文档`**，降级为参考实现/素材库。
> 下文所有 `G:\MIRACH\mirach-harness`（及相对路径 `mirach-harness/`）的
> 引用一律指 `G:\mirach-harness`；`G:\MIRACH` 指 `G:\参考文档`。
> **搬移 Tauri 工程的坑**：`target\debug\build` 的构建脚本缓存烙着旧绝对
> 路径——搬移后 cargo run 报 "failed to read plugin permissions ...
> G:\MIRACH\...tauri-*/out/..."（os error 3）。修法：删
> `target\debug\build` 重跑（保留 deps，依赖多数不需重编；本次实测
> icu/html5ever 等仍重编了一轮，约几分钟）。

本项目是 hermes 桌面应用（`D:\新建文件夹 (5)\hermes-agent-main\apps\desktop`）
前端的 **Tauri 2 移植版**。**用户的标准是"照抄 hermes，不要自己做"**——任何
手写替身都是 bug 来源。
**2026-09-24 方向变更（用户拍板）**：新应用 UI 不再使用 hermes 组件，改用
**assistant-ui** 栈；主工程降级为参考实现/素材库（架构见「待办 3」，逐字
照抄的标准只适用于仍在消费 hermes 的部分）。

## 当前状态（2026-09-20 全量重建后）

2026-09-20 前后工程曾被清空（旧的 `src/`、`.sync/src-backup/`、`scripts/`
全部丢失，只幸存 `src-tauri/` 与 `node_modules/`）。当日从 hermes 0.17.6
**逐字重建**：`src/` 2231 文件 + `shared/`（@hermes/shared）43 文件 + 根配置。

- `node node_modules\typescript\bin\tsc --noEmit` → **0 错误**（TypeScript 6.0.3）
- `npx vitest run` → **8337 passed / 1 skipped（cron-prompt 的 sh 用例，win32），
  907 文件全绿**（其中 `relay-deliver-budget.test.ts` 因需要 hermes Python
  后端源码整组 skipIf）
- `npm run tauri dev` → **主页面可进**（见下"mock seam"）；tsc/vitest 后改动
  一律先跑这两个门禁。

## mock seam（`src/mock/desktop-bridge.ts`）——无后端进主页面的关键

> **【2026-10-01 状态】mock seam 已整体删除**（`src/mock/` 目录不存在，
> main.tsx 无 mock 导入）——pi 真引擎切换（§6/§7）完成后 mock 面无消费方。
> 下文全部保留为**历史记录**，键名/路由/行为描述均已过时，勿按此补代码。

- `main.tsx` **第一行**导入，安装 `window.hermesDesktop`（替代 Electron
  preload；真桥存在时自动让位）。
- 组成：`api()` REST 路由器（status/config/profiles/sessions/models/cron/
  terminal/skills/toolsets/messaging 等最小合法载荷，**未识别路由返回 {} 并
  打 `[mock-api]` 日志**——补形状时对着控制台日志加）。注意：`/api/skills`、
  `/api/tools/toolsets`、`/api/cron/jobs`、`/api/cron/delivery-targets`、
  cron runs 的返回是**裸数组**，不是 `{xxx: []}` 包裹——形状错了页面直接崩。
- **config 是持久的**（localStorage `mirach.mock.config.v1`，GET/PUT /api/config
  浅合并）——设置页切语言/改显示设置能存住；`getMachineProfile` 跟随
  `navigator.language`（中文 Windows 首启即中文 UI，用户显式选择优先级更高）。
- **文件系统面接的是真 Rust 命令**（`src-tauri/src/fs.rs`：fs_list /
  fs_git_root / fs_read_data_url）——文件树、git 根、预览读图都是真的；
  `selectPaths` 走 tauri-plugin-dialog 原生目录选择（"新建项目/打开文件夹"
  可用）。纯浏览器 dev（无 Tauri）自动降级。
- **右键系统**：hermes 的 `app-context-menu` 从不 preventDefault（Electron 里
  未处理手势由主进程原生菜单兜底）；Tauri 里那会弹出 WebView2 默认菜单。
  mock 桥安装时在**冒泡段全局 preventDefault**（应用的 React 菜单在捕获段
  照常打开，Radix 自带右键不受影响），并补了剪贴板/编辑面（readClipboard /
  contextMenuEdit=execCommand / saveImageFromUrl=fetch+download）。无原生
  拼写集成；"复制图片"需要 Chromium 的右键坐标跟踪，Tauri 无对应物，暂 no-op。
- `api/client.ts` 的 HermesGateway 传了 `socketFactory` 钩子（mock 桥存在时
  用内存 socket，否则原生 WebSocket）——这是传输层（我们的层）里唯一
  动过 hermes 代码逻辑的地方。
- 已验证：boot 走完、引导可跳过、**主页面完整渲染可交互（中文 UI、右侧栏
  TERMINAL 面板可开关、左栏五个入口全开：新建会话/技能与工具/消息平台/
  产物/定时任务）**。Gateway 状态停在"检查中"（mock socket 不应答真实
  status RPC）——诚实状态。
- **设置页各 section 现状**（2026-09-20 实测，切换均 <170ms）：
  完整渲染 = 外观（语言/主题）/ 密码与登录 / 通知 / 提供方 / 键盘快捷键 /
  已归档对话 / 关于 / 工具与密钥（空态文案）；**空主区** = 工作区 / 安全 /
  Browser / 记忆与上下文 / 语音 / 高级（内容依赖 Electron 主进程才有的
  数据面：连接配置、硬件探测、浏览器档案…，mock 未供 → 上游按无数据
  渲染空白）；**"不可用"占位** = 网关（需要 getConnectionConfig/ssh/cloud
  桥面）。深化按需来——设置页壳本来就要用户自己做。
- **config-schema section 的遗留 bug（未解，2026-09-21）**：模型/对话/工作区/
  安全/Browser/记忆与上下文/语音/高级 这 8 个 schema 驱动 section 卡在字段
  骨架——react-query 缓存里 config（20 键）与 schema（57 字段）两个查询
  **都是 success**，但 `config-settings.tsx` 的 `!config || !schema` 门槛不
  放行（本地 draft 播种与 profile 状态机/编译器 memoization 的某种互动）。
  数据层已就绪：GET /api/config（深合并持久化）+ /api/config/schema
  （57 字段）就是自己做设置页要用的两条接口；骨架随旧组件一起被替换。
  摘 react-compiler 会白屏——compiler 必须保留（见工具链钉版表）。
- **网关相关的真实 RPC（prompt.submit、session.*）尚未 mock——发消息会
  得到 -32601 toast。这是 pi 接入前的预期行为。**
- **files 文件树窗格**：注册在案但可见性绑 `$hasWorkspace`（有工作区才显示，
  本地模式 cwd 来自会话/项目，`defaultCwd` 只在 remote 模式有值）——
  新建项目选个文件夹，文件树就出现。

## 工具链钉版（升级前必读，全部有教训在背后）

| 包 | 版本 | 为什么 |
|---|---|---|
| typescript | 6.0.3 | hermes 钉版；5.9 会报 TS2783/TS8047 等假错 |
| react / react-dom | 19.2.7 | hermes 钉版 |
| **@assistant-ui/tap** | **0.9.8（exact，直接进了 dependencies）** | **^0.9.0 会装到 0.9.18 → "getSnapshot should be cached" 无限循环，33 个测试文件全炸** |
| vite | 8.2.0 + @rolldown/plugin-babel + babel-plugin-react-compiler | React Compiler 的 babel pass **必须保留**（vite.config.ts），砍掉会导致测试里 tap 循环复发 |
| vitest / jsdom | 4.1.10 / 29.1.1 | hermes 钉版；jsdom 30 会让 Radix pointerDown 菜单打不开 |
| @tauri-apps/api 等 | 2.11.x | 上一轮验证过的 Tauri 基线（见 package.json） |
| vitest | 4.1.10 | harness 单测（2026-09-27 引入；与主工程钉版一致）；无 jsdom，node 环境 + localStorage 替身 |

**harness 测试**：`npm test`（vitest run）/ `npm run test:watch`；配置 = vitest.config.ts（node 环境、@ 别名）+ vitest.setup.ts（localStorage 替身）。2026-10-01 起 **77 用例**（constraints 14 / constraints-sync 9 / rebalance 25 / turn-actor 22 / pane-registry 4 / flexlayout-rowfix 3），覆盖聚合与钳制纯函数、absorbSurplus 唯一吸收者、syncTabsetConstraints identity 四步优先级、applyRootWeights/fitWindowWidth/updateNarrowViewport、rowfix 修正语义、AG-UI 归约（thinking/交错 run/run 外 drop）。**Rust 侧 30 用例**（`cargo test`，agui.rs 内嵌：映射器逐行/环形缓冲 seq/审批注册表 respond+cleanup）。

package-lock.json 已生成（2026-09-20，含上面全部钉版）；重装依赖后先跑
tsc + vitest 再动别的。改依赖版本先看上表——每个钉版都有一次翻车在背后。

## 待办（按优先级）

### 1. ~~mock seam 深化~~ ✅ 已终结（2026-10-01）
mock seam 整体删除（`src/mock/` 已不存在），真引擎（pi + AG-UI）上线，
无待办。历史方案见上"mock seam"段的状态横幅。

### 2. 设置页用户自己做
hermes 的 `src/app/settings/` 115 个文件**全量在树里**（不是最终形态）。
关键事实：**70/115 的 settings 文件被外部当组件库用**（capabilities 的
toolset/终端/浏览器面板、messaging 的凭据 UI、`sdk/index.ts`、i18n 的
en/zh、boot-failure 的 gateway 浮层）。用户自己做时的切面：**替换"页面壳"
（`settings/index.tsx` 导航结构 + 各 `*-settings.tsx` 顶层页面），
保留被嵌入的原语**（`primitives.tsx`、`helpers.ts`、各 *-panel.tsx、
`credential-key-ui.tsx`）。动壳之前先跑一遍"谁 import 我"。

### 3. 新应用架构（2026-09-24 定稿：assistant-ui 栈，取代旧 pi 接入计划）

**用户决策：不用 hermes 的组件了，用 assistant-ui。** 主工程（hermes 移植）
降级为参考实现/素材库；新应用在 **mirach-harness** 骨架上生长。旧计划
（gateway-contract 换传输、src/api 换 invoke/listen）作废。分层定稿：

- **L1 前端（纯投影，只渲染不持真相）**：assistant-ui（聊天 Store + A2UI
  渲染，**永不 innerHTML agent 产出**——这是 IPC"本地完全信任"的前提）·
  FlexLayout（harness 已有）· shadcn/ui · TanStack Query（非会话查询）·
  **Zustand（状态层）**· **XState v5（Agent 轮次状态机，见下条）**
  （2026-09-26 状态库定稿：**Zustand**，不计既有代码。理由：①AG-UI 事件
  归约/轮次机的调试是接下来的主要矛盾，Redux DevTools 对每次 set 的时间
  线检查是 nanostores 的 console logger 给不了的；②"单一 store = agent
  真相的一份投影、写入者只有 XState 与 AG-UI 归约"与 L1 纯投影哲学同构；
  ③selector 订阅覆盖全应用可扩展。nanostores 的框架无关与极小 API 在
  本项目价值低（L5 也是 React；重数据态在 assistant-ui runtime 与 XState
  手里）。layout-store（nanostores）随下一轮重写迁移到 Zustand。）
- **Agent 轮次状态机（XState v5，2026-09-25 增补，落位 `src/agent/`）**：
  显式建模单条 run 的生命周期，取代散落在组件里的布尔/轮询态——
  `idle → submitting → streaming ↔ tool（工具执行/前端回调/审批，经
  /ag-ui/tool-result 回传）→ done | error`，`interrupted`（/ag-ui/interrupt
  已发待确认）与 resume（断线后带 lastEventId 续流）横跨其中。三条铁律：
  ①**纯投影**——机器只把 L2 AG-UI 事件流归约为轮次态，不持会话真相
  （真相在 Pi/L4），context 里的 runId/lastEventId 是续传句柄而非数据源；
  ②**唯一消费者**——AG-UI SSE 只喂机器，UI 组件只 useSelector 读态、
  只发 transition（submit/interrupt/tool-result），不旁路订阅事件流；
  ③**可恢复优先**——interrupt/resume/断线重连是一等转换，轮次快照按
  run 边界持久化（对齐 L3 SQLx 策略）。
- **L2 桥接层（双通道正交，判据：是否属于 Agent 循环）**：
  - AG-UI HTTP+SSE（axum，绑 127.0.0.1:0，Origin/Host + Bearer，token 经
    IPC 下发）：`POST /ag-ui`（发消息+收事件流）、`/ag-ui/interrupt`、
    `/ag-ui/resume`（快照+可选 lastEventId）、`/ag-ui/tool-result`（前端
    工具回调/审批）；A2UI $action 按 target 分流：agent→AG-UI、
    client→本地消化或 IPC
  - Tauri IPC（本地完全信任）：会话 CRUD（list/create/open/delete/
    rename，open 返回体带 active run 标记）、UI 上下文同步、窗口/文件/
    通知/系统集成、`get_agui_endpoint`、A2UI $action(target:client) 里
    需系统能力的部分
- **L3 Rust 应用层（src-tauri）**：axum 挂 tauri::async_runtime · AppState
  · SQLx（快照按 run 边界+关键节点持久化）· Auth · SnapshotProvider 实现。
  持 UI 上下文/业务数据，**不持 Agent 会话真相——那是 Pi 的**
- **L4 pi-adapter**：create_agent_session · AgentEvent · ToolRegistry ·
  生命周期 · A2UI 消息生成与验证（A2UI schema 单一来源在此，L3/L1 按
  schema 消费）
- **L5 Tauri v2 Mobile**：双通道均可用于移动端，后台断流靠 resume

落地顺序：**L4 → L3 → L1 第一条竖链**（发消息→流式回复→渲染；Agent 轮次
状态机随之落地，xstate/@xstate-react 依赖届时一并引入），其余端点
都是该链的变体。遗留决策点：delete_session 对 active run 的保护规则、
target:client 里纯前端动作的本地消化清单。

### 4. ~~`npm run tauri dev` 冒烟~~ ✅ 已过（2026-09-20）
cargo 增量 15s 起窗；WebView2 加载 1420；React 全壳渲染（侧栏/composer/状态栏/
引导页/Tailwind 样式全在）；按预期停在 **"Desktop IPC bridge is unavailable"**
恢复对话框——那是 mock seam（待办 1）没建，不是冒烟失败。
`tauri.conf.json` 主窗带着 `additionalBrowserArgs: --remote-debugging-port=9222`
（有意保留：dev 态 CDP 冒烟/检查用，`curl 127.0.0.1:9222/json/list` 看页面 target）。

## 本工程的规矩（违反 = 制造 bug）

1. **照抄 hermes，不要自己做。** 所有手写替身都是 bug 来源；上游测试的环境
   缺陷也只做**最小放宽**并写注释（见 cron-detail.test.tsx 的 OS-locale 放宽）。
   已知例外：**上游 i18n 缺口**（如会话侧栏筛选菜单 `filter-menu.tsx` 硬编码
   英文、`errors` 段 zh 缺键）——走正规 i18n 三件套补齐（types.ts 契约 +
   en 原文 + zh 译文），如 `sidebarMenu` 段。
2. **`@hermes/shared` 是 vendor 目录** `shared/`，靠 tsconfig paths +
   vite alias 解析（`@hermes/shared/billing` → `billing-types.ts` 有显式条目，
   其余子路径走 `@hermes/shared/*` 通配）。**不要**改成 file: 依赖。
3. **语言只留 en + zh**（用户决定，上游六种）。`i18n/types.ts` 的 Locale、
   `catalog.ts`、`languages.ts` 已收窄；plugins 的 ja/zhHant bundle 留在
   源文件里但**不再注册**（BOTS_LOCALES / KANBAN_LOCALES 只导出 en+zh）。
4. **`main.tsx` 只保留三支窗口**：主窗、`?win=quick`、`?win=hud`。
   pet-overlay / wake / intro 的入口分支已删（组件文件仍在树里）。
5. **中文/emoji 编码**：PowerShell 5.1 读 .ps1 按 ANSI、`Set-Content` 写
   ANSI——改文本一律 `[System.IO.File]::ReadAllText/WriteAllText` +
   `New-Object System.Text.UTF8Encoding($false)`。普通 `Copy-Item` /
   `robocopy` 是字节复制，安全。
6. **tsc 输出正斜杠路径**（`src/app/...`），路径处理要兼容两种斜杠。
7. **vite 会死于 `EBUSY … watch '…\Cookies'`**：Edge `--user-data-dir`
   一律放 `%TEMP%`，绝不放进仓库。
8. **`tauri dev` 外壳死掉时 Vite 可能活着占住 1420**：
   `netstat -ano | findstr :1420` 找 PID 杀掉再重启。
   另有变体：**应用跑着时改 `tauri.conf.json`/Rust 触发热重建，watcher 会撞
   `EBUSY … target\debug\deps\mirach_lib.dll` 直接整个退出**——正常现象，
   杀干净进程重开 `npm run tauri dev` 即可（2026-09-20 实测）。
9. **vite 1420 是 Tauri devUrl**（`src-tauri/tauri.conf.json`），
   端口改动两边要同步。
10. **vite.config 别配 `server.fs.allow` 收窄**：一旦收窄，运行期动态
    import 的模块全部 403（"outside of Vite serving allow list"），页面表现为
    部分功能静默失败（2026-09-20 实测；hermes 配它是为了符号链接 worktree，
    本仓库没有这个需求）。
10b. **临时产物不要写进仓库根**（tsc/vitest 输出重定向到 `%TEMP%`）：vite
    watch 着仓库根，根目录文件一变就整页 reload（`page reload .tmp-tsc.txt`
    实测），正在看的页面会被无故刷新。
11. **测试环境**：`vitest.setup.ts` 的 localStorage **无条件装 Map 替身**——
    jsdom 真实 Storage 上 `vi.spyOn` 静默失效（Node 24.18 实测），别改回条件安装；
    部分 hermes 测试隐含英文 OS（Intl 相对时间跟随系统语言），在本机
    （中文 Windows）会有措辞差异，遇到先怀疑这个再怀疑代码。
12. **禁止兜底（2026-10-01 用户定稿：错误就是错误）**：任何实现不得写
    fail-open / 静默降级 / 默认值替代 / 乐观假装成功——失败必须传播
    （Err / throw）或可见（RUN_ERROR 进缓冲、console.error），调用方
    自己决定怎么处理。已清的兜底：list_models 的 auth 读取失败降级空
    目录（→传播）、POST/GET 缺 threadId/thread 静默默认 "main"（→400）、
    prompt 自身 Err 被吞（→RUN_ERROR 进缓冲）、onNew 在 endpoint 未就绪
    时静默 return（→throw）、composer set_model 乐观更新（→成功才写）、
    Mutex 中毒静默恢复（→传播；唯一例外 Drop 清场无法传播，注释说明）。
    新代码过审查时按此条执行。
  - **ComposerWired 审查核实轮（2026-10-01，14 条修 5 驳 9）**：真 bug
    ①onModelChange split('/') 截断含 / 的 model id（HF 风格）→
    indexOf 第一斜杠切分（provider 不含 /，唯一边界）；②useDictation
    过期闭包——识别实例启动后不重绑回调，第二段识别按启动时旧 value
    追加 = 覆盖第一段 → onFinalRef 每渲染更新（start 依赖数组随之去掉
    onFinal）；③onend 无身份校验——用户重新 start 后旧实例 onend 会停
    掉新识别 → recRef.current === rec 才清场；④ReactNode re-export 无
    消费方 → 删。加固⑤main.rs pi_set_model 显式 rename_all="camelCase"
    （Tauri 默认即此，写明防签名漂移）。**驳回（有据）**：#8 slash 覆盖
    丢前缀——useSlashMatches 是 value.startsWith('/') 语义（kit 源码），
    "hello /im" 时菜单根本不出现，无可丢前缀；#4 isRunning 拉 state 时序
    ——E2E 实测点亮即此机制在工作，挂载双 IPC 无依赖非竞争；#6 catch
    静默——上轮已修（console.error 在），审查看的是旧代码；#14 provider
    null——Rust 侧 String 非空；#12/#13 审查者自答/桌面无 SSR。
    **记录待办（功能缺口非 bug）**：slash/mention 菜单键盘导航
    （activeIndex+方向键）、附件 chip 删除钮（AttachmentRemove）。
  - **§7-5 审批/问题卡（2026-10-01，提交 9e87e71/75ec01e）**：SDK 实证
    ExtensionUiRequest 不走 AgentEvent 流——走 create 时安装的
    extension_ui_handler（#[async_trait]，impl 侧同宏否则 E0195）；无
    handler 时 fail-closed。审批信号 piggyback 唯一 GET 流（CUSTOM
    name=extension_ui_request 只带 {id}）→ 前端拉 pi_pending_approvals
    （Rust ApprovalRegistry 为真相，重放流不复活已应答卡）→ IPC
    pi_extension_ui_response(id, value, cancelled)（对齐 SDK
    ExtensionUiResponse；无 requestGeneration——那是 RPC 协议层）经
    tokio oneshot 回灌（Receiver 普通 Future，asupersync 可 poll）。
    **术语澄清（用户质疑后核实）**：这不是 v2.1 被删的 Tauri Event
    门铃复辟——门铃删的是第三通知通道；审批进流是 §4.4 prescribed，
    通道归零仍成立。persist_extension_permissions:false 已落实（决定
    全会话级，"仅本次"按钮无意义）。待办：oneshot 超时、ask_response、
    select/input 卡片真实形状（等扩展生态）。
  - **composer 小 UI 补全（6ca647e）**：斜杠/@ 菜单键盘导航（↑↓/
    Enter/Tab/Esc；Input 传入 onKeyDown 先于内部 handleKeyPress——
    composeEventHandlers，preventDefault 拦内部发送）；附件删除
    aui.composer.attachment({id}).remove()。
  - **【上游缺陷】pi Windows 会话持久化不可用（实锤实验，§7-4 会话
    持久化回退 ephemeral）**：no_session:false 下 Session 存活期间
    save_and_index/flush_autosave 永远失败（os error 5 拒绝访问；
    延时 2s/8s/15s 三次全败，干净目录复现）；jsonl 只建 .lock 不落盘
    （flush 仅 Shutdown 触发、SDK 路径无 Periodic 驱动、Session 无
    Drop flush）；save_and_index（官方 pub，flush+进索引）同败——
    SessionPersistenceLockGuard 持锁 + lock_session_persistence 再锁
    的同进程冲突嫌疑。**已回退 no_session:true**（flush_active_session
    保留：无会话 no-op；flush 失败中止切换不丢消息）；PI_SESSION_
    DURABILITY_MODE=strict 留存（上游修复即生效）。**恢复条件**：上游
    修锁冲突后 create_session_opts 改 no_session:false + session_path
    改回参数；threadListAdapter（runtime.tsx，threads/switch/hydrate/
    rename/delete 全接好）与 pi_list/new/open/rename/delete_session
    五命令原样可用。tsc 0；cargo check 零警告。
  - **【上游缺陷已修+持久化恢复（2026-10-01 晚）】用户版本疑问触发
    复查：本地 pi_agent_rust-main 自报 0.5.1（Cargo.toml/Cargo.lock），
    GitHub 实际最新 release=v0.6.1（24 Sep）——下载的 main zip 未含
    修复。**根因改判（有据）**：非锁冲突猜测，是 session_index.rs
    note_session_namespace_change 里 generation counter
    （session-index.generation，0 字节文件）以 append-only 打开后
    FileExt::lock——Windows LockFileEx 拒绝 append-only 句柄
    （FILE_APPEND_DATA 无 GENERIC_WRITE）→ os error 5 → save 流程
    中断（persist 排在 generation 打开之后）→ jsonl 永不落盘。
    **修复=同款上游 gh #239（v0.6.0 release note 原文："opens the
    counter read + append"）**：pi session_index.rs 加 .read(true)
    一行补丁。恢复 no_session:false + session_path 参数。实测：POST
    后 jsonl 落盘（731 字节）、pi_list_sessions 出完整记录
    （id/path/messageCount）、rename 成功且列表可见、threadId 与
    sessionId 同源。冒烟全绿；tsc 0；cargo check 零警告。
    **注意**：下次同步上游 pi 代码时此补丁会被同化（内容与官方一致，
    无冲突）。
  - **多会话接线完成（2026-10-01 深夜）**：
    1. **多轮对话 bug 修复**：agui_run 原来每次 POST 无条件
       create_session（每条消息换新会话、上下文全丢）→ PiEngine
       ensure_session（有会话复用，无才建）。
    2. **New Chat 语义**：pi_discard_session（flush 旧会话落盘 + 清
       handle），下一次 POST 按需建新——避免弃用空会话文件堆积。
    3. **挂载水合**：pi_stream_cursor（缓冲最新 seq）作 EventSource
       lastEventId 起点（跳过重放，多会话旧事件不混入）+ pi_get_messages
       水合当前会话历史（真相在 pi，流只管增量）。hydrate 消息 id 用
       序号（pi AssistantMessage 无 id/timestamp）。
    4. **【坑】threadListAdapter 键位**：useExternalStoreRuntime 的
       threadListAdapter 必须放 `adapters: { threadList: ... }`——core
       的 getThreadListAdapter 只读 store.adapters?.threadList；顶层
       平铺静默无效（threads 永空、侧栏只渲染自动补的当前行）。
    5. **【坑】TDZ 白屏**：挂载 effect 引用 refreshThreads/
       piMessageToTurn 但声明在 effect 之后——依赖数组 render 期求值
       抛 "Cannot access before initialization" 白屏（RuntimeBoundary
       包不住自身组件的 effect）。声明必须前移。
    6. **UI 全链实测**（CDP）：侧栏 5 行渲染（命名行显示真名）、点击
       "历史会话A" → 主区水合该会话两条历史消息 + 行 active 高亮、
       multi-sess 七步（建/多轮/列表/重命名/discard/新会话/切回）全绿。
  - **工具调用结构化（2026-10-01 深夜续）**：TurnMessage.content 从
    string 升级为 `string | TurnPart[]`（text + tool-call，形状对齐
    ThreadMessageLike）。归约：TEXT_MESSAGE_CONTENT 在 parts 形态下
    追加/合并最后 text part（工具后又有文本 = 新 text part）；CUSTOM
    tool_execution start = 转 parts + push 工具调用部件（args 取自
    ToolExecutionStart——参数流与执行维度在此汇合）；end = 按
    toolCallId 填 result/isError。映射器同步带上 args/result。
    **hydrate 升级**：pi 历史 assistant 的 toolCall blocks → 部件、
    toolResult 消息按 toolCallId 归并到前一条 assistant（孤儿结果
    跳过）；thinking/media blocks MVP 不渲染。
    convertMessage 对 tool-call part 的 args 做 ReadonlyJSONObject
    断言（pi arguments 运行时即 JSON 对象）。
    **单测**：turn-actor.test.ts 9 用例（文本/工具交错、end 归并、
    usage 替换语义、usage 缺失保留）全绿——"reduceAguiEvent 纯函数
    可单测"铁律首次兑现。tsc 0；cargo check 零警告；冒烟全绿。
  - **A 项清账 + 上游确认（2026-10-01 深夜续）**：
    ①**oneshot 超时清账**——上游 manager request_ui 对每请求
    bind_deadline 并 honor effective timeout（超时 fail 非挂死），宿主
    桥无需计时；§4.4 的 Registry 计时说法作废。
    ②**A25/A26 清账**——generative-ui 0.0.21 无 useAgUiRuntime/
    useAgUiSendA2uiAction；真实面 = JSONGenerativeUI（present 前端工具/
    promptUser 人审）+ UINode IR + ActionRegistry；它是 present 树渲染
    底座，非 A2UI 绑定。
    ③**A22 清账**——crates.io a2ui v0.0.0 占位（后端全桌面 GUI，无
    Web）；a2ui-rs 不存在。A2UI 三层全自建，维持 MVP 后（文档新增 §9）。
    ④全量回归 30/30（constraints/rowfix/pane-registry/turn-actor）。

## 工具（`scripts/`）

| 脚本 | 用途 |
|---|---|
| `node scripts/cdp-probe.mjs [--reload]` | 连真窗口（CDP 9222）抓控制台/异常，`--reload` 刷新后抓 8s |
| `node scripts/cdp-shot.mjs` | 真窗口截图 → `.tmp-tauri-window.png` + 正文转储 |
| `node scripts/cdp-click.mjs` | 按 CDP 点击页面元素（当前写死跳过引导按钮，用时改） |
| `node .tmp-*.mjs` 均依赖 `ws` devDep 与 `additionalBrowserArgs`（tauri.conf.json）|


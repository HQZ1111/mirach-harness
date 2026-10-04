# AGENTS.md — mirach-harness 工程须知（新会话必读）

> **【新会话第一站】交接快照：docs/HANDOFF.md（当前状态/未做清单/环境速查）。**

> **本文件是 G:\参考文档\AGENTS.md 的副本（2026-09-25 拆分时随迁）。**
> mirach-harness 是活跃项目，本体已独立在 `G:\mirach-harness`；
> 原 MIRACH 主工程（hermes 移植，本项目的参考实现/素材库）在
> `G:\参考文档`。下文所有 `G:\MIRACH` 字样指 `G:\参考文档`，
> 所有 `G:\MIRACH\mirach-harness` / `mirach-harness/` 字样指本工程
> `G:\mirach-harness`。harness 专属内容见「mirach-harness」一节；
> 「工具链钉版」「本工程的规矩」「已知的环境陷阱」对本工程同样生效
> （npm/vite/编码坑都是同一套）。

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
setTabPinned/updateNodeAttributes）、tidy 自动回收、border 折叠轨道 +
peek + autoHide、SingleTabStretch 头栏、双击改名/右键钉住/最大化、
enableEdgeDock:false 配置、分隔条对直接子 tabset 的原生 min/max 钳制。

必须自建（flexlayout 没有）：最小化到轨道 + 快照原位还原、主栏竖轨
（border 只能贴窗缘）、嵌套约束传播 + 富余回灌（原生只钳直接子项、
再分配按 grow 比例不支持 prefer）、FancyZones 投放预览、多页签选择、
pointer 拖拽接管（原生 HTML5 DnD 在 Tauri dragDropEnabled:false 下不触发
+ 功能不支持）、px 记忆/钉回（原生纯权重制）、logo 带/MainTint
（tabset DOM 不可注入）。

未用的原生能力（接 pi 前定取舍）：popout/float 浮动窗口、tabGroups
分组着色、keyMap 键盘导航。

**审计方法教训**：①"验证通过"要找到真正的生效机制——min/max 生效可能
只是原生直接子项钳制的巧合（我方钳制当时从未运行）；②flexlayout 的
action 数据键不统一（node/nodeId/tabNode/fromNode），写拦截器必须逐个
对照工厂签名；③行元素没有 data-layout-path——对行的 DOM 查询一律用
后代 tabset 的 union rect。
## 布局逻辑规范（2026-09-26 v3 已确认 · 代码已对齐）

**唯一规范 = `docs/layout-design.md`（v3，§9 四问已拍板）**。竖轨最终形态：
每大栏外缘一条 **20px 空轨 tabset**（左栏左缘/主栏左缘/右栏右缘，全应用
最多三条），工厂经 onTabSetPlaceHolder 对它渲染 **RailNav 整栏页签导航**
（跨分栏投影：点行=selectTab 切换显示且页签常驻；行纵向拖=同分栏轨内
重排（插入符预览）；横向拖出=搬去别的大栏；行下关闭图标；顶部切横轨钮；
底部 +）；该栏分栏**不合并**、保持可见，横向条由 sync 统一隐藏
（railByRegion 只认轨）。**存储键 = mirach.harness.layout.v6**（v5 带着三
轮废弃竖轨实验的残骸——停车轨/吸收区/合并式轨——整体作废；用户看到的
"无数竖轨+空白轨道区域"即此残骸）。
**切换=建/拆轨，无快照**（快照会把折叠期间关掉的页签复活、残骸布局下
还原前后无变化=「没反应」——用户实测双双踩中）：建轨=假页签建轨即删
（enableDeleteWhenEmpty:false 保轨）；拆轨=翻 enableDeleteWhenEmpty+enableClose
后加假页签再删，tidy 收走。竖轨态「+」= **直接多加一栏**（该栏最外侧分
栏旁并列新分栏，非堆叠——用户："多加一个会话栏"）。根行配重三坑
（adjustWeights 数组映射错位 / row 无 config / 读实际生效 min/max）见
v3 文档 §11；主栏多分栏按当前权重比例分吃剩余。**富余兜底
absorbSurplus**：分隔条拖拽（ADJUST_WEIGHTS）**与页签拖拽等结构性动作**
（MOVE/ADD/DELETE）提交后 90ms 量测根行，Σpx < 可用宽的差额强制归主栏
分栏（用户实测把各栏推到极限/跨栏拖页签后行尾留白的根治——主栏"吸收
一切富余"的执行者，实测空白 -1px≈0；注意这是补差额不重排，不与用户
拖拽打架；行盲量测 bug 与根行不变式见「2026-09-26 根行不变式轮」与
设计文档 §10）。RailNav 行按**分栏分组**
（.zone-rail-group，组上下各一条横向分割线——用户定稿）；占位窗格注入
tabName（WorkspacePane 等——多实例占位内容相同，靠标题区分"切没切"，
用户："点击标签没有转换页面"实为看不出变化）。

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

## mirach-harness（`mirach-harness/`，2026-09-21 立项）

布局骨架试验田。路线沿革：dockview → 自写 fixed-layout → hermes
pane-shell 抄写 → **2026-09-21 定稿：flexlayout-react 0.11.0**（用户指定）。
dockview 已从依赖移除，pane-shell 抄写终止——hermes 的 14k 行 pane-shell
被 ~170 行 flex-layout.tsx + 库内建能力替代。`npm run dev` →
**http://127.0.0.1:1430**（1420 留给主工程）。

- 现有文件就三层：`src/components/layout/flex-layout.tsx`（模型+壳）、
  `src/components/panes/*.tsx`（6 个占位窗格）、`src/lib/storage.ts`。
- **【2026-09-27 模块化】flex-layout.tsx（原 1957 行）已按职责拆分**（纯
  搬运零行为变更，tsc+全场景回归验证）：
  - `flex-layout.tsx`（~1284 行）= React 壳：FlexLayoutShell、工厂、
    onAction/onRenderTab*/onTabSetPlaceHolder、拖拽接管/双击/键盘/引导
    effect、scheduleRebalance 调度（定时器只在这一层）；
  - `constraints.ts` = 纯几何约束：widthBounds/heightBounds 聚合、
    clampRowWeights（保险网）、rootAvailPx/measuredPxWidth/rootNeededMin、
    isTopBand、regionCfgOfNode——无 React 无动作提交；
  - `constraints-sync.ts` = syncTabsetConstraints 约束应用器（§2 引擎 v4：
    列 identity 三级推导/过承诺缩让/空区竖轨清理/低条/关闭钮语义）；
  - `rebalance.ts` = 串行通道的模型级操作：applyRootWeights/absorbSurplus/
    fitWindowWidth/mergeZonesPerColumn/updateNarrowViewport/measureRootPx
    （rootPxMem 模块态在此）；DESIGN_WIDTH/MIN_WINDOW_WIDTH 在此；
  - `resize-handles.tsx`（无边框窗手柄）、`rail-logo-leading.tsx`（logo 带，
    横向条 leading 与竖轨内容顶带共用）；
  - 调试句柄：`window.__flModel`（活动 Model）、`window.__flDragLog`。
- **布局即 JSON**（`Model.fromJson`）：weight 是相对父 row 的百分比；
  嵌套 row 方向自动交替（根水平=三列，主列 row 垂直=主区/终端上下）。
- **Tauri 壳已加**（2026-09-21）：`mirach-harness/src-tauri/` 最小壳（无命令
  无插件，identifier `com.mirach.harness` 与主工程分开 → WebView2 数据目录
  不冲突），devUrl 指向 1430，`additionalBrowserArgs` CDP **9223**（主工程
  是 9222）。启动：vite 跑着 + `cd mirach-harness/src-tauri && cargo run`。
- **Tauri 里页签拖不动的坑（2026-09-21 实测修复）**：flexlayout 0.11 的页签
  拖拽是 **HTML5 Drag & Drop**（dragstart/dataTransfer），而 Tauri 窗口默认
  `dragDropEnabled: true` 会让 WebView2 走系统级拖放接管，页面里的 dragstart
  根本不触发——分隔条用鼠标事件所以能拖、页签拖不动。窗口配置必须
  `dragDropEnabled: false`（改 conf 要重编 Rust）。CDP 验证法：dispatch
  mousePressed+move 看页面是否收到 dragstart。
- **拖拽落点已收窄**：全局 `enableEdgeDock: false`——flexlayout 默认允许
  把页签拖到布局外缘 dock 成新列/新行（整宽顶条、左栏旁新列），超出 hermes
  分区不变量；关掉后页签只能进已有 tabset 或内部分裂。旧存档会在加载时被
  `updateModelAttributes` 压回 false。
- **左栏分区不变量（2026-09-21，onAction 校验）**：照抄 hermes 的
  SESSIONS|BOTS rail——sessions/bots 住在左栏，栏内可重排、别的页签进不来、
  它们也出不去、整个左栏 tabset 不可被拖走。实现：左栏 tabset
  `enableDrop: true`（否则拖出去就永远回不来，实测踩过），放行与否在
  `onAction` 拦 `MOVE_NODE` 判定——tabset id 是生成的，识别靠"子页签里
  有 sessions/bots 组件"，外部校验函数 `isRailTab/isRailTabset`。
  旧存档由加载时 coerce 统一改 `enableDrop`。
- **hermes 各栏限制已进模型**（tabset 的 minWidth/maxWidth/minHeight/
  maxHeight，像素）：左栏 237-360（sessions 默认/上限）、右栏 160-320、
  主区 minWidth=22vw、终端 20vh/80vh（建模型时按 innerWidth/innerHeight
  换算，并随窗口 resize 重算——照抄 hermes）。
- **flexlayout 约束的两个语义坑（实测）**：
  1. tabset 的 minHeight/maxHeight 是**内容高度**，实际渲染高度 = attr +
     页签条 29px（`calcMinMaxSize` 里 `+= this.tabStripRect.height`）——
     要按整栏 80vh 控制，attr 得减 29（`TAB_STRIP_H`）。宽度类约束无此加成。
  2. `model.getNodeById('workspace')` 拿到的是 **tab 节点**，min/max 在它
     的**父 tabset** 上（`getParent()`）。vh/vw px 烙死还会随 webview 初始
     尺寸漂移（Tauri 实测 900→936→720 变 749），所以必须 resize 重算
     （`Actions.updateNodeAttributes`）。
- **拖空塌缩的容器语义（2026-09-21 实测）**：flexlayout 的 `tidy()` 只回收
  `enableDeleteWhenEmpty && enableClose` 的空 tabset——"不可关"必须是
  **页签级**属性（workspace 页签的 enableClose:false），不能烙在 tabset 上，
  否则主区被拖走后原位置永远留一块空白面板。hermes 佐证：controller.tsx 的
  workspace 注册是 `uncloseable: true`（页签级）+ grid-model 拖空即塌缩。
  旧存档由 coerce 统一改回（workspace tabset enableClose:true、终端
  minHeight:1——hermes 终端无下限，20vh 只是默认 weight 不是钳制）。
- **关闭规则**：`onAction` 拦截 `Actions.DELETE_TAB`，sessions/bots/
  workspace（NO_CLOSE 集）返回 undefined 阻止关闭——对应 hermes 的
  hideOnly/uncloseable。
- **持久化**：`onModelChange` → `model.toJson()` → localStorage
  `mirach.layout.v4`（v3 及更早存档来自无约束 schema，作废）。
  标题栏"重置布局"按钮 `Model.fromJson(makeDefaultLayout())` 兜底。
- **踩坑（必读）**：
  - `.flexlayout-host` **必须 `position: relative`**——`.flexlayout__layout`
    是 `position:absolute; inset:0`，锚定最近的定位祖先，宿主不定位就会
    盖住标题栏/状态栏（2026-09-21 实测）。
  - 组件名是 `Layout` 不是 `FlexLayout`；`Action` 类型从包根导出。
  - flexlayout 在 DOM 里渲染一个 `FindBorderBarSize` 的 metrics 元素
    （`.flexlayout__layout_metrics`，top:-30000px）——a11y 树里见到是正常
    现象，不是 bug。
- **已验证（Tauri 窗口内 CDP 实测，2026-09-21）**：四区默认布局、页签
  可关、刷新持久化、左栏拖宽 237-360 精确钳制、终端 20vh 起步/80vh 精确
  钳制（720=0.8×900）；tsc 0 错误。
- **手感对齐 hermes**：`--fl-splitter-size: 4px`（默认 8px）、悬停即时
  `#4c6fff`（默认灰色带 0.05s 延迟）、命中区 10px、`tabDragSpeed={0.08}`
  （拖影跟手，默认 0.3 太飘）。
- **布局预设 + 管理面板（2026-09-21，逐字对照 hermes）**：`layout-presets.ts`
  五套模板（Default/Basic/Focus/Terminal deck/Quad，weights 逐值照抄
  app/contrib/layout-presets.ts）+ 用户预设存取（saveUserPreset/
  deleteUserPreset，localStorage `mirach.layout.presets.v1`，id 前缀 user-
  ——对应 hermes tree/presets.ts）。`edit-palette.tsx` 是 edit-bar.tsx +
  layout-picker.tsx 的移植：可拖动 Layouts 卡片、缩略图网格（hermes
  TreeThumbnail，flexlayout 行方向按深度交替）、另存当前/删除/重置/完成。
  **重要修正：hermes Default 的右列是 [review|files 并排] 上 + [终端] 下
  （weights [1,3.4,1.25]/[1.6,1]/[1,1.2]），终端不在主区底下**——
  第一版 Default 造错了，已按原树重造。编辑模式开关 hermes 走
  `layout.editMode` keybind，harness 暂用标题栏「布局」按钮（接 pi 补 keybind）。
- **吸附条视觉（对齐 tree-split.tsx 的 Sash）**：常驻 1px 发丝线
  （`--fl-splitter-size: 1px`，色 rgba(255,255,255,.12)≈hermes
  --ui-stroke-secondary@.1）+ 悬停/拖动中变 #4c6fff 加粗（≈
  --ui-sash-hover-border）+ 命中区 8px（hermes 非对称 grab band 总宽）。
- **状态层 agent-native（2026-09-21）**：`layout-store.ts`（nanostores，对齐
  hermes tree/store.ts 的架构）持有 UI 态——$editMode/$activePresetId/
  $userPresets/$layoutRev；flexlayout Model 只是渲染器持有的活动树，不进
  store。$layoutRev 在 onModelChange/adopt 后 bump：flexlayout 改模型不触发
  壳重渲，依赖模型派生状态（窗格徽标）的组件订阅它。
- **窗格注册表 + re-adoption（2026-09-21，`pane-registry.ts`）**：逐值对照
  hermes controller.tsx 注册项——六个窗格的 placement + dock 回收位
  （sessions/bots → workspace left；files/review → workspace right；terminal
  → bottom）+ closeable。右栏拖空塌缩（tidy 回收）后标题栏「窗格」菜单把
  离家窗格收回：优先并入同组纯 rail tabset，没有就 dock 到主区指定侧
  （hermes "beside main" 回收位）自动分裂新 tabset，再按身份补宽度限制；
  被关掉的窗格 addNode 重建。paneStatus 徽标：纯同组 tabset=在位，其余=
  在外，不在模型=已关闭。坑：rail 查找对 bottom/main placement 会撞
  RAIL_TABS undefined（终端无 rail），一律先守卫。
- **全套 hermes 行为（2026-09-21/22 二轮补齐，Tauri 窗口 CDP 实测）**：
  1. **镜像翻转**（⌘\）：`mirrorLayoutJson` 水平行 children 反转（hermes
     mirrorTreeHorizontal 同构），纯键位无按钮。
  2. **双击分隔条回默认**：几何定位拥有缝隙的最深 row → 按已应用树
     `$appliedTree` 的 split id 查原始权重，查不到均分（hermes
     resetBoundary 同语义）。预设树全带 hermes 命名的 split id（spl-root/
     spl-right/spl-rail…）；splitter 无 DOM path 标记，只能几何定位。
  3. **终端折叠进轨道**：拖到 COLLAPSED_ZONE_PX(28px) 地板 → 底部 border
     收页签；**判断高度必须读 DOM**（`.flexlayout__tabset[data-layout-path]`）
     ——模型 getRect() 在 onModelChange 时是旧值（与 720→749 漂移同源）。
  4. **窄屏边缘抽屉**：`$narrowViewport`（matchMedia，hermes 断点 640px=
     SIDEBAR_DOCK_MIN_WIDTH_PX）→ sessions/bots 进左 border、files/review
     进右 border，`borderType:'overlay'`（flexlayout 内建 VS 风格自动隐藏）
     ；恢复宽屏按 dock 回收位收编回网格。
  5. **logs 窗格**：dock 在终端右侧（hermes "its OWN zone beside the
     terminal"）；终端折叠时兜底收主区南侧。
  6. **Zone 编辑器**（hermes「New grid layout」）：从零画分叉树、分配窗格、
     应用生成新布局（zone-editor.tsx，树直接用 flexlayout JSON 形状）。
  7. **键位**：mod+\ 镜像、mod+shift+\ 编辑模式（hermes defaults 逐值）。
  8. **互换入口 + 隐藏**（2026-09-22 补）：标题栏「互换」按钮 = flip toggle
     （hermes 把它放 titlebar，键位 ⌘\ 同一功能）；窗格菜单是 hermes zone
     菜单 Show/Hide 行的等价物——在位/在外点击隐藏、已隐藏点击显示（dock
     回收位收编）。hidePane 走程序化 deleteTab：**程序化 doAction 不经过
     onAction**，所以 sessions/bots 能隐藏（UI × 手势仍被 NO_CLOSE 拦），
     空 zone 照旧 tidy 塌缩，显示走 addNode/moveNode 重建。
  - **border 的坑**：flexlayout 忽略 JSON 里的 border id，固定生成
    border_left/right/bottom/top；Model 没有 getBorders（用
    getBorderSet().getBorders()）；border JSON 属性只有 location+children。
- **2026-09-22 三批能力验证通过（Tauri 截图确认）**：SingleTabStretch 拉伸
  生效（单页签渲染成 tabset_header，不在 tab_button 里量）；右键菜单用
  flexlayout 导出的 `showPopupMenu` 实现（flexlayout 无内建菜单，
  onContextMenu 只是转发，菜单自己用 PopupMenuEntry 搭：关闭/重命名/
  钉住/关闭其他/关闭右侧/全部关闭，按可关性过滤，重命名走
  ILayoutApi.editTabName + Layout ref）；zone 头部最小化按钮经
  onRenderTabSet 注入（签名 TabSetNode|BorderNode 联合须收窄）。
  **待办**：①右键菜单真实鼠标复现（合成 buttons:2 已发）②1b 拒投后左栏
  分裂异常待查 ③hiddenStripTabs 持久化——✅ 已做（见"三批之三"④）。
- **2026-09-22 三批之二（已验证 tsc 0，待 CDP）**：中键关页签
  （onAuxMouseClick，只对可关窗格）；OS 文件拖入建页签（onExternalDrag →
  component 'external'，工厂渲染文件名占位）；空栏占位
  （onTabSetPlaceHolder）。**剩余未抄四项 → 已全部落地，见下"三批之三"。**
- **2026-09-22 三批之三（layout 剩余四项全落地，IAB 浏览器 CDP 实测 +
  tsc 0）**——原接续指引（顺序 ②→①→④→③）已执行完毕：
  - **② tab-selection 多选**（`tab-selection.ts` 逐字移植 hermes）：
    Ctrl/⌥ 点选进出选区、Shift 范围选（anchor 语义）、普通点击收拢+激活；
    选区高亮直接在 `flexlayout-tabbutton-<id>` 元素挂 `.fl-tab-selected`
    （effect 依赖 $layoutRev——flexlayout 重渲按钮会重建 class，每次模型
    变更后重刷）。**坑：修饰键点击必须吞掉松手后的合成 click**（flexlayout
    按钮 onClick 会 selectTab）；swallow 监听**不能带立即拆除的
    setTimeout(0)**——click 在 pointerup 之后的任务里才来，用 once + 1500ms
    兜底（实测踩过：拆除太快=选区编辑同时激活了页签）。
  - **① px 尺寸记忆收尾**：$paneSizes 持久化（`mirach.layout.paneSizes.v1`）。
    **只对纯 rail tabset 记/回放**（pane-registry `isPureRailTabsetFor`
    闸门）——窗格拖进混合 tabset 后按宿主 tabset 记宽度会把别人的尺寸贴回
    新家（实测 files=126 脏值）。applyJson 清空（hermes
    clearAllPaneSizeOverrides："A preset defines the layout's SIZES too"）；
    应用后 onModelChange 立即重记=模板声明值（等价无覆盖，无害）。双击分隔条
    reset 顺手清该 split 下窗格的记录；adopt 回放 minWidth；录制 timeout 有
    modelRef 守卫（预设换模型后旧 timeout 不得写新记录）。
  - **④ hiddenStripTabs 持久化**：$hiddenPanes（
    `mirach.layout.hiddenPanes.v1`），hermes 语义逐条：boot hydration 重放
    隐藏；显示（adopt）清记录；**左栏最后一个可见页签拒绝隐藏**
    （`isLastShownLeftRailPane`，菜单徽标"不可隐藏"）；applyJson 重隐
    （terminal 的 revealOnPreset 例外——选预设=想看见它）。**坑：paneStatus
    对折进 border 的窗格原本返回 away，菜单点击会走 hidePane 把折叠页签
    删掉**——已加 'folded' 态（父=BorderNode），菜单行"已折叠 · 点击恢复"
    （恢复=adoptPane 把页签 moveNode 出轨道）。
  - **③ FancyZones 投放预览引擎**：`zones-engine.ts`（PowerToys 引擎逐字
    移植）+ `drag-session.ts`（hermes 拖拽原语 flexlayout 适配：pointer-
    capture 会话、4px 阈值、rAF 合帧、ghost chip、Esc=顶层 escape layer、
    placement-on-release 中途不动）+ `drop-overlay.tsx`（zone sheet 闲置描边/
    点亮/边带变形 + 页签条插入符）+ `lib/{drag-ghost,escape-layers,reorder}.ts`。
    **页签拖拽全部从 flexlayout HTML5 DnD 接管**：宿主 onPointerDownCapture
    里 pointerdown preventDefault（Chromium 取消 pointerdown 默认 → 不派发
    mousedown → 不起原生拖拽）；提交走 model.doAction（程序化绕过 onAction，
    **rail 不变量在 drag-session 里重查**；change listener 照常触发壳的
    onModelChange 记账）。已实测：reorder（条内插入槽）/zone（径向
    center/edge，左缘带 sheet 变形 left:6px）/merge（Shift 扫掠组合区间，
    findCover 矩形检查、非矩形回退单区投放，真合并 [检查|文件] 成功）/
    Esc 中止/rail 单向阀 no-drop 光标（deny 释放保留选区）/多页签块整组
    拖移（块序保持+按下页签置前+落地才耗尽选区）。DOM 事实：页签按钮 id
    前缀 `flexlayout-tabbutton-`（**border 按钮同前缀**）、页签条容器
    `.flexlayout__tabset_tabbar_outer`、SingleTabStretch 的单页签 zone 无
    页签按钮（strip 快照为空 → 只能 center/edge）。reorder 模式 overlay 只画
    插入符不画 sheet（dragGeometry.mode 区分）；$treeDragging 两种模式都要
    置位（否则 overlay 不挂载）。
  - flex-layout.tsx 新接线：onHostPointerDown（语法编辑+拖拽接管）、选区高亮
    effect、DropOverlay、Escape 分层（isTopEscapeLayer，拖拽层 drag=50 最
    优先）。调试：`window.__flDragLog`（拖拽会话轨迹，CDP 冒烟用）。
  - 新文件：`src/components/layout/{tab-selection,zones-engine,drag-session,
    drop-overlay}` + `src/lib/{drag-ghost,escape-layers,reorder}`。
- **2026-09-23 详细比对轮（用户指出四处对不上 hermes，逐文件核对后全部修
  复，tsc 0，IAB 浏览器实测）**：
  - **①垂直栏宽度（根因两个）**：hermes 的 zone 尺寸是**声明式固定轨道**
    （sessions width/minWidth 237、files/review = FILE_BROWSER_DEFAULT_WIDTH
    = 237、终端 20vh——controller.tsx 逐值），harness 旧版用 hermes 权重
    比例换算，1280 下左栏只有 ~225、检查/文件 ~129。另有两个 flexlayout
    侧的隐性损耗：**四条空边框轨道各吃 31px**（实测网格被啃成 1218×596
    ——GLOBAL_ATTRS 加 `borderEnableAutoHide: true` 修掉，fold 进轨道时
    才出现 31px 竖条）；**分隔条元素实测占 8px**（CSS 发丝线 1px 只是
    视觉，SPLITTER_PX=8）。现按"可用宽 = 总宽 − 分隔条"在构建期把声明
    px 推成权重（layout-presets.ts 的 DEFAULT/FOCUS/BASIC/DECK/QUAD 全
    部重写，渲染像素与 hermes 一致：237/237/237/20vh 实测精确）。
  - **②固定轨道的钉回（pinPass 割线法，flex-layout.tsx）**：flexlayout
    权重制在 resize/adopt/整侧展开后会漂——adopt 重建 tabset 用默认分法、
    resize 时权重等比放大（hermes 固定轨道是 px 不漂）。**教训三连**：
    (a) 份额直接设绝对值有系统差（份额 237 渲染出 243，min/max 钳制再分
    配不可闭式求解）；(b) 残差修正式 `share+err` 方向错（偏置是乘性的，
    `2×target−measured` 会振荡）；(c) **份额(%)和 px 不能混进同一个权重
    数组**（混了被 minWidth 钳住假装收敛）。最终：按行分组（同行的
    review|files 一次 adjustWeights，防互相用过期测量），每固定轨道维护
    (施加 px, 实测 px) 采样点割线解逆，三轮收敛 ±1px（`pinHist` +
    `schedulePin` 90/230/370ms，`modelRef` 守卫防换模型写串）。resize 重
    钉走同一 pinPass。**px 记录只在分隔条拖拽时写**（onModelChange 的
    `action.type === ADJUST_WEIGHTS && !pinningNow`）——move/adopt 也记会
    把 flexlayout 的默认分法盖上用户记忆（实测 rail 被记成 294）。
  - **③左右栏收起按钮 + 标题栏工具面**：hermes titlebar-controls.tsx 的
    positional toggles（layout-sidebar-left/right 图标钮，整侧收起/展开，
    绑 $sidebarOpen/$fileBrowserOpen）。harness：`$sideCollapsed`（持久化
    `mirach.layout.sides.v1`）+ collapseSide/expandSide（整侧 rail 窗格
    moveNode 进 border 轨道 / adoptPane 收编），boot 重放；窄屏恢复宽屏
    时**收起状态优先**（restore 只切回 split 轨道不展开）。标题栏改为
    lucide icon 工具钮（tb-tool：PanelLeft/ArrowLeftRight/PanelRight/
    LayoutGrid/LayoutTemplate），布局编辑器钮 mod+点击 = 全重置（hermes
    LayoutGlyph 的 mod-click telegraphs 语义；恢复一切=清 hidden/sizes/
    sides 回 Default）。
  - **④布局编辑器画布面（edit-veils.tsx）**：hermes 编辑模式每个 zone 的
    body 是拖拽把手——虚线 accent 描边 + accent6%×chrome55% scrim +
    2px 模糊 + 居中 gripper chip（活动页签名），页签条不在遮罩内保持可
    交互。flexlayout tabset DOM 不可注入 → 宿主层绝对定位，**rAF 循环量
    rect**（编辑模式非热路径）；veil pointerdown = startPaneDrag(活动页
    签, zone 模式)。已实测：veil 拖拽 ghost/sheet/落位全通。
  - **⑤PaneTab 视觉（styles.css）**：对齐 hermes components/ui/pane-tab.tsx
    ——条 h-7(28px, TAB_STRIP_H 29→28) chrome 表面无底栏；页签 9px 大写
    宽字距 medium、激活=编辑器表面+2px 主题色下划线（唯一缝）、未激活
    hover 变暗（rgba 黑 24%）、flexlayout 的 ✕ 自带悬停显形；多选=
    accent 16% 渐变洗（替代旧的 box-shadow 圈）。flexlayout 0.11 走
    `--fl-color-tab-*` CSS 变量，覆盖在 .flexlayout-host 上。
  - 已知残留：review/files 同行双固定在收起-展开循环后 ±7px（修正差额被
    按比例分给右列容器而非主区——要根治需层级化钉轨道，自底向上算容器
    声明宽；新建预设与 resize 重钉都是精确的）。
- **2026-09-23 Tauri 实测反馈轮（用户在 Tauri 窗口验收，四项全修，tsc 0）**：
  - **①分隔条常态又粗又可见**：dark.css 把全部 `--fl-*` 变量定义在
    `.flexlayout__layout` 上（比 `.flexlayout-host` 更近）——旧版写在宿主
    上的 `--fl-splitter-size:1px` **从未生效**，分隔条一直是 8px 灰条。
    定制必须走输入变量 `--flexlayout-*`（fallback 链：`--fl-splitter-size:
    var(--flexlayout-splitter-size, 8px)`）。现在 1px 发丝线常态、命中带
    8px 由 `::before` 提供（不占布局）、hover/拖动变 `#4c6fff`。
    **连锁**：flexlayout 内部算宽也按该变量扣缝——分隔条 8→1px 后同权重
    漂 +3px/缝，SPLITTER_PX 常量必须同步改 1。
  - **②整侧展开"过度弹出再收回"+抖动**：adopt/moveNode 之后 flexlayout
    按默认分法给权重，旧 schedulePin 三轮可见修正 = 弹出→收回→微调。
    根治 = **解析式配重 applyFixedWeights**（自顶向下递归：声明子项=目标
    px、可伸缩子项按权重吃剩余；moveNode 后同步施加，React 渲染前到位，
    第一帧即最终几何）。**三个坑**：(a) moveNode 后 getRect/DOM 都是旧渲
    染（根行 DOM 查询宽度为 0）——根行可用宽改从宿主 clientWidth 推导，
    并减去仍可见的边框轨道条 31px（BORDER_BAR_PX，收起侧窄轨占一列），
    这也是此前 +6px 偏置的根源；(b) **递归双轴**：父行分配轴上的尺寸=
    pxs[i]，另一轴继承父行——分支条件看父行方向（vert? (availW,inner) :
    (inner,availH)），看子行方向会把高度轴喂成宽度（终端被撑满全高）；
    (c) **右栏=整个物理列**：SIDE_PANES.right 含 terminal/logs（hermes
    paneRootSide 语义），只折 files/review 会留孤立终端行被撑满；展开时
    只收回"活着的或被隐藏的"窗格（never-existing 的 logs 不凭空创建）。
  - **③布局编辑器"什么都没有"**：EditPalette（z-50）被 edit-veils
    （z-55）盖住了——veil 的 scrim+模糊+pointer-events 正好罩在居中的
    面板卡上。面板提到 z-[70]。
  - **④每栏能缩小到没有**：flexlayout 只钳直接子 tabset 的 min/max，
    嵌套行的 min 不向上传（右列整行能拖到 0）。onAction 对用户分隔条
    拖拽的 ADJUST_WEIGHTS 做行递归硬钳制（minAlong：同轴 Σ、跨轴 max；
    pinningNow/migrating 中的程序化配重跳过），拖拽实时钳在
    237-360/160-320，实测左右都精确。
  - Tauri 窗口验收提示：旧存档（vite 早期版本的权重布局）在 Tauri 自己的
    WebView2 档里，Ctrl+点击「布局编辑器」钮全重置一次即得新几何。
- **2026-09-23 二轮补充（用户复测，三项）**：
  - **①垂直页签（折叠轨道）没有还原按钮**：hermes 语义 = "Click a tab to
    restore + activate"——折叠 rail 的页签本身就是还原钮。实现：onAction
    拦 `SELECT_TAB`（**数据键是 `data.tabNode` 不是 `data.node`**——探针
    实测踩过），tab 父=BorderNode → adoptPane 还原 + applyFixedWeights +
    selectTab 激活，返回 undefined 拦掉 border 选中；窄屏抽屉例外（那里
    点击应是 VS 式 overlay 展开）。真实鼠标实测：底部轨道点「终端」→
    回网格 144px。
  - **②"布局编辑器没整个移植"的真相：harness 没有 Tailwind**——
    edit-palette 里全是 tailwind 类名（z-50/w-[26rem]/rounded-xl…）全部
    无效，面板从未真正显示过（无宽度、无 z 序，被 veil 盖住）。重写为
    styles.css 的 `.ep-*`（逐条翻译 hermes 的 tailwind 类，z-70 在
    veil/overlay 之上），文案逐字取 hermes zh catalog：editHint「选择一个
    布局，或在区域之间拖动面板。」+ 键位 kbd、saveCurrentAs「将当前排列
    保存为模板」、nameLayoutPlaceholder「为布局命名…」、deletePreset
    「删除 {name}」。截图确认：模板缩略图卡/自定义/新建网格布局/保存行
    全部真实显示。
  - 仍未移植（记录在案）：veil 右键 zone 菜单（harness 用标题栏「窗格」
    菜单替代）；palette 键位 kbd 目前是静态 Ctrl+Shift+\（接 pi 的
    keybinds 后读实时绑定）。
- **2026-09-24 代码复查轮（自查全量布局代码，五处修复 + 回归全绿）**：
  1. **onAction 探针残留清理**（__selLog 每动作写数组的调试代码）。
  2. **窄屏恢复宽屏的 adopt 接上解析配重**——原来窄屏效果里的 restore
     只 adoptPane 不 applyFixedWeights，会过冲。
  3. **窄屏下点"显示右栏"只记展开意图**（$sideCollapsed 置 false、不
     adopt）——hermes 语义：collapsible 窗格窄屏由 narrow 效果留在
     overlay 轨道，宽屏才真正收编（narrow 恢复分支已有 sideCollapsed
     守卫，天然衔接）。
  4. **adopt 的 minWidth 回放下限按栏位区分**（Math.max(160,w) 会把左栏
     的 237 下限写到 160——updateNodeAttributes 是覆盖不是取 max）。
  5. **双击分隔条重置的顺序修正**：先清 px 记录再 adjustWeights+
     applyFixedWeights——原顺序 applyFixedWeights 用旧记录值当目标，
     重置不彻底。
  - 复查确认无误的部分：onAction 的 SELECT_TAB 还原分支不会递归
    （adoptPane/配重走 model.doAction 直连，不回 onAction）；语法编辑的
    swallow 监听 1500ms 兜底可接受；pinPass 仍被 resize 分支使用；
    narrow 效果只迁 sessions/bots/files/review 是对的（hermes 的
    terminal 无 collapsible 标志，窄屏留在网格）。
  - 回归全绿（detached vite + IAB）：默认/收起展开/轨道还原三组
    237/237/237/144 全精确；拖宽 340 → 双击重置回 237（重记录的
    sizes=声明值，无害）。
  - **环境坑（重要）**：会话内 `npm run dev` 后台任务会被宿主反复回收
    （本轮死了三次），改 `Start-Process cmd /c npm run dev` 分离进程
    启动后存活；IAB 标签页也随会话回收，重连时 list→get 复用。
- **2026-09-24 无边框窗（用户三项：1800×1000 / 去原生标题栏 / 圆角 50）**：
  - **tauri.conf.json**：width 1800 / height 1000、`decorations: false`、
    `transparent: true`、`shadow: false`（透明窗配系统阴影会出伪影）。
    tauri.conf 改动要重编 Rust（generate_context! 编译期读）。
  - **capabilities/default.json 原来是空的**——窗口控制 API 全被拒。
    现：`core:default` + allow-minimize/toggle-maximize/close（is-maximized
    在 window:default 里）。拖拽区 data-tauri-drag-region 走
    core:window:default 的 start-dragging，无需单列。
  - **CSS**：body 透明（background: transparent），圆角画在 `.app-shell`
    （border-radius:50px + overflow:hidden 裁圆角）；纯浏览器直开由
    main.tsx 打 `body.in-browser`（铺满不圆角，白底兜底）。
  - **标题栏拖拽**：`.app-titlebar` + app-name/spacer 加
    `data-tauri-drag-region`（Tauri 检查的是**事件目标元素**的属性——
    子元素各挂各的，按钮不放该属性保持可点）。
  - **窗口控制钮**：@tauri-apps/api 已装入 harness 依赖（此前没有）；
    `lib/tauri-window.ts` 导出 inTauri/appWindow（浏览器 null）；
    最小化/最大化还原/关闭三钮（Windows 形制 SVG，关闭钮 hover 红），
    最大化态经 isMaximized+onResized 同步。TS 坑：模块级 const 的
    null 收窄不进嵌套回调，先落局部变量。
  - **验证（CDP 9223）**：innerWidth/Height 1800×1000、radius 50px、
    bodyBg rgba(0,0,0,0)、win-controls 3 钮、drag-region 属性全 ✓。
    探针脚本在 %TEMP%\mirach-cdp-9223-probe.mjs（ws 从参考工程
    node_modules 解析：createRequire('G:/参考文档/package.json')）。
  - **坑**：Tauri 窗口比 vite 先开（或 vite 死过）→ 页面"连接被拒"，
    CDP Page.reload 即恢复；窗体改动（conf/Rust）热重载会撞
    mirach-harness.exe 锁，先 taskkill 再 cargo run。
- **2026-09-24 窗体验收轮（用户反馈四项，全修，CDP 实测）**：
  1. **拖不动窗口的根因**：`core:window:default` **不含**
     `allow-start-dragging`（读 tauri-2.11.6 源码
     permissions/window/autogenerated/reference.md 实证——只有
     internal-toggle-maximize 等）。capabilities 显式加
     `core:window:allow-start-dragging` 后 invoke 直接 resolved。
     验证法：CDP 直接 invoke `plugin:window|start_dragging`（800ms race
     无 "not allowed" 即放行）；**Input.dispatchMouseEvent 合成事件测不了
     OS 拖拽循环**（合成事件不移动真实光标，dx 恒 0，别用）。
  2. **左右侧栏默认宽 350**（hermes 原值 237）：SIDEBAR_DEFAULT_WIDTH
     350、左右 tabset 上限 320/360 → 380（350 必须落在 min/max 内）。
     同步点：layout-presets 构建器、pane-registry railAttrs、
     flex-layout paneWidthTarget/pinPass 目标钳制。旧存档权重不自动变，
     全重置一次即可。
  3. **背景白色**：body #fff（圆角外露白），壳仍深色。若用户要整个
     应用浅色主题（flexlayout 浅色+页签换色），是独立的一轮主题改造。
  4. **底部栏**：终端默认 = 20% 视口高（1000 高窗即 200px，CDP 实测
     200），即 hermes 的 20vh，无需改。
  - 终态 CDP 实测：1800×1000、radius 50px、bodyBg rgb(255,255,255)、
    rail/files/review 350、termH 200、zones 五区齐。
- **2026-09-24 浅色主题轮（用户三项：背景圆角 / 底栏 20 / 垂直栏 20 /
  flexlayout 背景全透明）**：
  - **背景圆角**：圆角从 .app-shell 挪到 **body**（白底随窗体圆角裁切，
    圆角外 transparent 露桌面）；`.app-shell` 背景透明。
  - **状态栏 26 → 20px**，GRID_H 同步（36+20=56，layout-presets）。
  - **垂直栏（折叠边框轨）31 → 20px**：flexlayout 0.11 的栏宽来自
    `.flexlayout__border_sizer` 元素实测（padding 6+5 + 20px 按钮=31），
    override sizer 上下 padding 为 0 + border_button 高 20 即得 20px 栏宽
    （CDP 实测 bottomBarH=20）。**不能用 borderSize 属性**（那是展开
    面板尺寸，默认 200）。
  - **flexlayout 背景全透明 + 浅色**：dark.css → **light.css**（官方浅色，
    同名输入变量），再压 --flexlayout-color-background/tab-content/
    tabset-background/border-background = transparent（白底透出）；
    页签文字翻深色（selected #1f1f28 白面+蓝下划线、unselected #6b6b78）、
    分隔线 rgba(0,0,0,.08)、hover 黑 6%、drop-sheet/edit-veil/chip/
    ep-*/ze-*/pane-placeholder/菜单全量翻浅色。**text 的 color 别放 body
    后忘了壳**——浅色壳内深字由 .pane-placeholder 等自管。
  - **大坑（自查发现）**：重写窗体段时丢了 `html/body height:100%` →
    #root 的 100% 失去参照 → flex 宿主收缩为 0 → 整个布局白屏（状态栏
    贴到标题栏下面）。圆角/overflow 都画在 body 上没问题，**height 链条
    一节都不能少**。
- **2026-09-24 尺寸审计轮（用户："白色背景和窗体尺寸不一致"）**：
  - **实测**：outer = inner = 1800×1000（物理=逻辑，scale/dpr 均 1），
    但 **body 只有 1784×1000——差 16px = 浏览器默认 body margin 8px×2**
    （重写窗体段时 `margin: 0` 从 html/body 上丢了，左右各露 8px 透明底）。
  - **修复**：html/body 补回 `margin: 0`，body 1800×1000 与窗口精确一致。
  - **另**：探针期间窗口处于最小化态（-32000/160×28 是 Windows 对最小化
    窗的报告方式）——`plugin:window|unminimize` 恢复（CDP Browser 域在
    WebView2 上不可用）；测量键名是 **width/height**（不是 w/h）。
  - **方法论**：尺寸审计 = outer_size/inner_size（物理，除以 scale_factor
    得逻辑）+ innerWidth/Height + body/shell getBoundingClientRect 全量
    对比，任何一层不等即布局漏口。
- **2026-09-24 屏幕跟随轮（用户："换屏幕大小能跟随吗"）**：
  - **概念澄清**：tauri.conf 的 width/height 是**逻辑像素**（不是物理）；
    本机 scale/dpr 均 1 所以相等。跨屏拖动：Windows 保物理尺寸、逻辑
    重算；**换小屏**：1800×1000 会超出屏幕边界（min 900×600 救不了）。
  - **实现**：main.rs setup 钩子——取 current_monitor（fallback
    primary_monitor），逻辑工作区 = size/scale，装得下（≥1816×1148 含
    任务栏 48 预留）→ 保持 1800×1000 居中；装不下 → `window.maximize()`
    （最大化自动排除任务栏、跟随屏幕）。Manager trait 需要 use。
  - **未做（记录）**：大屏按比例放大（固定设计尺寸是常规桌面应用行为）；
    工作区精确高度（Monitor 只有整屏 size，任务栏用常数预留）。
- **2026-09-24 双屏 + 标签条错位轮（用户："终端在右栏下面，还原后跑到
  主栏下面"）**：
  - **终端 dock 改为 {pane:'files', pos:'bottom'}**——用户排布是终端在
    右栏文件下面，折叠还原后回原位（原来 dock workspace-bottom 会落到
    主区下面）。文件不在网格时 adoptPane 回退主区。
  - **tabLocation 残留**：上一轮的 tabLocation:'bottom' 已写进用户存档
    （tabset 属性随 JSON 持久化），代码删了属性但**旧存档还带着**——
    coerce 显式 `tabLocation: 'top'` 清残留。
  - **vite 陈旧模块缓存（重要环境坑）**：编辑 pane-registry 后 Tauri
    窗口整页 reload 仍拿到**旧模块**（vite 文件监听漏掉 Edit 工具的
    写入，模块缓存未失效）——表现为"改了代码行为没变"。诊断法：页面内
    `fetch('/src/xxx.ts')` 看 vite 实际提供的模块内容。修复 = **重启
    vite**（清内存转换缓存）。以后改了代码但行为不对，先怀疑这个。
- **2026-09-24 圆角失踪真因（品红测试实证，贯穿前几轮的总根因）**：
  - **CSS 背景传播规则**：html 没有自己的背景（transparent）时，body 的
    背景会**传播到整个 canvas 铺满视口，且不受 body 的 border-radius
    裁切**——白底画在 body 上，圆角裁了个寂寞，圆角外永远是 body 的
    底色（透明窗下看着像"背景还在/四个角"）。
  - **实证（品红测试）**：body 临时 #ff00ff + 屏幕抓图（CopyFromScreen，
    非 CDP 截图——后者合成结果不带 alpha 判定不了）——壳内圆角内 = 白
    （壳自己的底被圆角裁了 ✓ 壳的圆角生效）、四个角 = 品红（body 底色
    透出 ✓ 实锤传播）。
  - **修复**：白底 + border 1px + radius 50px 全部画在 **.app-shell** 上
    （内层容器裁自己的底色），html/body transparent——角外→透明→桌面。
    body 的 radius/border 移除（body 无底色，radius 无意义）。
  - **教训**：透明窗 + CSS 圆角的组合，底色必须画在**圆角容器自身**，
    html/body 上画底色 = 圆角必失效（传播规则）。PowerShell 5.1 跑
    -File 中文注释脚本需 UTF-8 **BOM**（否则 System.Drawing 等类型
    莫名解析失败——node 加 BOM 后正常）。
- **2026-09-24 双屏分辨率 + 四个角轮（用户两问）**：
  - **四个角的真凶**：body 的 `box-shadow`（细环+64px 投影）画在 50px
    圆角外的四个裁切角里——阴影跟 border-radius 走，但圆角外露出的
    是阴影的深色晕，看起来就是"还有四个角"。**修复**：去掉 box-shadow，
    改 `border: 1px solid rgba(0,0,0,.1)`（描边画在边框内侧、跟随圆角，
    不污染裁切区）——边缘定义保留、四角干净透桌面。
  - **双屏不同分辨率策略**（main.rs）：①启动时落在装不下的屏 → 最大化；
    ②`on_window_event` 监听 Moved/ScaleFactorChanged，**250ms 防抖**
    （std::thread，不引 tokio 依赖）后 `fit_to_monitor`——落点屏工作区
    （size/scale − 任务栏 48 − 边缘 16）装不下当前尺寸 → set_size 钳制，
    **不强制最大化**（拖过去可能只是临时放）。Monitor.size 是物理像素，
    除以 scale_factor 得逻辑。未做：多屏 WorkArea 精确 API（用整屏 size
    +常数替代）。
- **2026-09-24 最小化/还原定稿（用户："还原后只在文件树下面/跑到主栏
  下面"）**：
  - **机制换成快照还原**：moveNode 的 dock 语义做不到"回到折叠前的
    原位横跨原列"（dock 到文件下方只会缩在文件列宽里；dock 到主区
    下方又跨了主区）。`minimizeTabset` 折叠前快照整份布局 JSON
    （`preMinimizeSnapshot` 模块变量），轨道按钮还原 = setModel(快照)
    ——精确回到折叠前的位置/尺寸/宽度，hermes 的"原位折叠、原位恢复"
    语义。只保留最近一次折叠的快照；restore 后清空。
  - **终端 dock 改 {pane:'files', pos:'bottom'}**：无快照时的菜单还原
    路径回退（文件不在网格时 adoptPane 回退主区）。
  - CDP 终验：最小化 → 右轨 20px 含终端钮 ✓；还原 → 终端精确回到
    (1099, 779, 700) 横跨右栏 ✓。
- **2026-09-24 装饰叠片轮（用户两项：主区调色层 / 左栏上 logo 下标签）**：
  - **主区调色层**：`chrome-overlays.tsx` 的 MainTint——宿主层绝对定位
    跟随 workspace tabset 矩形，`rgba(233,238,239,0.4)`，pointer-events
    none，z-20（窗格内容之上、veil 55 / 投放 60 之下）。
  - **左栏 logo 带 + 标签下移**：flexlayout 0.11 支持 tabset 属性
    `tabLocation: "top"|"bottom"`（全局名 tabSetTabLocation）——左栏
    tabset 设 `bottom`（构建器 RAIL_TABSET_ATTRS / pane-registry
    railAttrs(left) / coerce 三处同步，adoptPane 重建 tabset 也会带上）；
    RailLogo 组件在左栏 tabset 顶部叠 40px logo 带（蓝方块+MIRACH 字样），
    会话/机器人窗格经工厂包裹 `.rail-pane-pad`（padding-top:40px）让位。
  - **叠片坐标坑**：宿主层叠片的坐标必须**减宿主原点**（
    `rect.top - hostRect.top`）——viewport 坐标直接用会整体偏低宿主.top
    （实测 logo 压住占位窗格标题）；edit-veils 一开始就减了所以没事。
  - CDP 终验：tint 740×944 @ rgba(233,238,239,0.4)、logo 347×40、
    railTabLocation=bottom、strip 在 tabset 下半、padTop 40px ✓。
- **2026-09-24 圆角可见性轮（用户："窗口的圆角怎么没有了"）**：
  - **诊断**：CSS 圆角一直在（body radius 50px computed 实测）；
    决定性测试 = body 临时全透明 + CDP 截图 omitBackground:true +
    自解 PNG 角像素——**corner alpha ≈ 0，WebView2 透明是生效的**，
    窗口物理上就是 50px 圆角。看不到 = **白窗贴浅色桌面，白对白**。
  - **修复**：body 加可见边缘——`box-shadow: 0 0 0 1px rgba(0,0,0,.1),
    0 24px 64px rgba(0,0,0,.24)`（细环 + 投影，画在透明表面上的
    alpha 阴影；透明生效与否都可见）。
  - **测试方法坑**：CDP 截图不带 omitBackground 时输出 RGB（垫白），
    alpha 判定必须 omitBackground:true；且 Page.reload 前先确认
    /json/list 的 target title 是应用页（启动瞬态会连到未还原的小窗）。
- **2026-09-24 不透明白窗定稿（用户："背景还在"→ 采纳白色容器提案）**：
  - 用户不接受圆角外露桌面（透明窗在他们的桌面上背景仍"可见"）。
    **transparent: false 定稿**：整窗不透明白色，圆角外不再有任何透出。
  - 圆角保留在 `.app-shell`（50px）+ `box-shadow: 0 0 0 1px
    rgba(0,0,0,.14)` 细环勾轮廓——白对白下这是圆角唯一可见的形式；
    body 的 radius/shadow 移除（不透明窗上无意义）。
  - 连锁：透明相关的 body 半透明写法全部改回实心白；tauri.conf 的
    shadow:false 保留（无边框窗无系统阴影）。
- **2026-09-24 圆角软件恢复 + 左栏 logo/标签布局定稿（用户："我要的是
  圆角的软件"+"标签怎么跑下面去了"）**：
  - **transparent: true 恢复**——上一轮的不透明白窗把"圆角软件"弄没了
    （白对白看不见圆角，用户要点名）。body 白底 + radius 50px +
    box-shadow 细环/投影（可见边缘）+ 圆角外透桌面，shell 透明。
  - **左栏布局定稿**：logo 带（40px，宿主层叠片）在顶部，**标签条紧随
    其下**（不是栏底部！上一轮误读成 tabLocation bottom）。实现：
    tabset 属性 `classNameTabStrip: 'rail-tabstrip'`（flexlayout 0.11
    支持，标签条自定义类）+ CSS `.rail-tabstrip { margin-top: 40px }`
    让位——比 tabLocation 方案好：标签条仍在 zone 顶部（logo 带正下），
    内容在其下。RAIL_TABSET_ATTRS / railAttrs(left) / coerce 三处同步；
    `.rail-pane-pad` 工厂让位方案删除（内容不再需要让位）。
  - CDP 终验：logo top 44、标签条 top 84（= logo 带 40 + tabset top 44）、
    gapBelowLogo 40、strip 带 rail-tabstrip 类 ✓；rail/files 347、
    终端 200、bodyRadius 50px ✓。
- **2026-09-25 四项收尾轮（用户：竖页签点击别自动还原 / 按钮互转 / 删多余
  逻辑 / 主区页签拖到本栏左半→右列旁多出空白）**：
  - **竖向页签点击不再自动还原**：onAction 里 SELECT_TAB 拦截分支（快照
    恢复 + adoptPane 兜底）整块删除——点击折叠轨道页签现在只是 flexlayout
    原生的轨道面板开合（peek）。窄屏抽屉例外分支随之消失（同样走原生）。
  - **按钮互转**：横→竖 = zone 头部「最小化」钮（已有）；竖→横 =
    **onRenderTab 给 border 页签挂「还原」钮**（fl-restore-btn，复用
    fl-min-btn 类）。关键事实：**border 按钮也走 onRenderTab**
    （BorderButton → getRenderStateEx → controller.customizeTab，
    renderValues.buttons 会渲染）。还原逻辑：有 preMinimizeSnapshot →
    整体恢复折叠前布局；无快照（窗格菜单隐藏等途径）→ adoptPane 回
    注册位。两个坑：①onHostPointerDown 的 closest 白名单要加
    `.fl-restore-btn`——否则拖拽接管 preventDefault pointerdown 会杀掉
    按钮的 click；②border 里没有 tabset hover 上下文，`.fl-restore-btn
    { opacity: 1 }` 必须写在 `.flexlayout-host .fl-min-btn { opacity: 0 }`
    之后（同特异性后写胜），左右轨道按钮行整体旋转、栏宽=按钮高 20px，
    还原钮要压小（14px）免得撑宽轨道。
  - **拖拽留白根因（两层）**：主区页签拖到本栏边缘 → flexlayout 分裂
    （TabSetNode.drop 同行=对半分权重，旧空 tabset 由 tidy 收走）→ 富余
    空间按权重摊给全行 → 检查/文件被 maxWidth 380 钳住吃不完 → **flexbox
    里全子项被 cap 时剩余空间无人吸收 → 渲染留白**（实测右列 924px 装
    380×2 剩 163px 空白）。修复：onModelChange 对结构动作
    （MOVE_NODE/DELETE_TAB，migrating 守卫）**同步重跑解析配重**
    （applyFixedWeights——富余归可伸缩的主区，第一帧即最终几何），顺带把
    主区 minWidth 22vw 补到分裂后的新 tabset（flexlayout 生成的 tabset
    无 minWidth）。第二层：applyFixedWeights 修好后仍差 22px——
    **FIXED_WIDTH_PANES 里没有 'bots'**，childWidthTarget 的"纯固定
    tabset"判定（every()）失败 → 整个左栏被判可伸缩、按权重分走富余
    （左栏被钳 380）→ bots 必须在列（paneWidthTarget 本就有 237-380 钳制，
    加进去无副作用）。
  - **childWidthTarget 语义修正**：tabset 是固定轨道当且仅当**全部**页签
    都是固定窗格——旧版"有一个固定窗格就钳整栏"会把 主区+文件 合并后的
    混合 zone 钳成 350px。
  - flexlayout 侧查明的事实（后续有用）：applyAdjustWeights（模型侧）纯
    setWeight 无钳制；controller 侧 ADJUST_WEIGHTS 走 applyAdjustingWeights
    **直接写 DOM flexGrow**（measurable 缺元素就 bail 不 redraw）；
    doAction 的监听器按注册序同步通知——**嵌套 doAction 的日志顺序 = 深度
    优先**（外层动作的 listener 排在内层之后注册时，日志里内层动作排在
    前面，别被假象骗了）；DockLocation.LEFT.orientation=HORZ（左/右插在
    同向行的兄弟位，TOP/BOTTOM 才是跨轴包裹）。
  - CDP 终验（合成指针拖拽 + 按钮点击）：分裂后 [350 | 746 | 350+350] 精确
    铺满 1798 无残留；检查 zone 最小化→右轨道（几何判定 cxf>0.6）、轨道
    页签点击不还原、还原钮原位恢复 x=1098/w=350 ✓；tsc 0 错误。
- **2026-09-25 二轮（用户：检查拖到主栏下半最小化进了整页底部 / 主栏要
  自己的左缘竖轨 / 竖轨文字没居中+图标换 hermes / 终端自动折叠落在软件
  底部；三追问后定稿"能用 flexlayout 原生就用原生、竖轨要和左侧栏同
  形式、样式按 hermes"）**：
  - **轨道按列固定（foldTargetFor）**：从 zone 的 tabset 向上找它在**根行
    的直接孩子列**——idx 0→左轨（border_left）、最后→右轨（border_right）、
    中间→主栏左缘竖轨。**没有"整宽→底轨"这回事**（用户明说："如果有整宽
    也是在左边了"——根行独苗 idx 0 也归左）。minimizeTabset 与终端自动
    折叠（onModelChange 60ms 地板检查）共用。
  - **主栏竖轨 = 树内原生分裂的真 20px tabset（foldIntoRail），不是叠片**：
    用户否掉了 border_top 停车 + 宿主层叠片的方案（"栏内多出来的，不是像
    左侧栏一样的形式"）。实现：moveNode(页签, 主栏列首个 tabset, LEFT) 让
    flexlayout **原生分裂**出新 tabset → 打上 ZONE_RAIL_ATTRS
    （minWidth/maxWidth 20、`enableTabStrip:false`、enableDrop:false）→
    **它就是一条真轨道**：占布局、推挤主区、跟随配重，与 border 同形式；
    页签停在没页签条的 tabset 里，**工厂检测
    `parent instanceof TabSetNode && isZoneRailTabset(parent)` 渲染
    ZoneRail**（列出该 tabset 全部页签：直立竖排标签 + chevron-up 还原钮）。
    `enableTabStrip:false` 是竖轨的唯一身份信号——存进布局 JSON，重启后
    工厂照常渲染（实测跨重启 ✓），无需额外状态。还原走 restoreFromBorder
    （快照优先，否则 adoptPane）；轨空了 flexlayout tidy 自动回收 ✓。
    childWidthTarget 给竖轨 tabset 固定 20px（isZoneRailTabset 判定）。
  - **横竖页签统一形态（2026-09-25 三/四轮定稿：文字横向 + 令牌制）**：
    用户否掉了 vertical-rl 竖排（"文字应该横向啊，文字大小样式都不一样"），
    并要求**用令牌统一样式**（"只让你改样式"）。styles.css 的
    `.flexlayout-host` 上有**页签系统令牌块**（--tab-font-size/-weight/
    -tracking/-pad-x/-pad-y/-text/-text-active/-active-bg/-accent/
    -accent-wash/-hover-bg/-separator + --rail-width/--rail-btn-size，
    注释里标了 hermes 对应物）——横向页签（tab_button）、左右轨道
    （border_button/content）、主栏竖轨（zone-rail-*）、fl-min-btn 的
    规则**只允许引用这些变量**；--flexlayout-color-tab-*/border-* 输入
    变量也改为引用令牌。改页签样式=改令牌一处。三个轨道页签同一形态：
    横向 9px 文字 + chevron-up 还原钮下方居中（实测 ≤0.5px 偏差）、
    py-2、页签间 border-t 分隔。border 页签原生整行 rotate(90°) 仍需 CSS
    摆正（inner_tab_container transform:none+absolute+top/left/right:0
    ——**必须绝对定位**，static 会被 align-content:center 吊到条中央）；
    **同选择器规则别分散多处**（本轮竖排块曾被后面遗留的
    `height:20px; padding:1px 6px` 覆盖，"没居中"的根源）。
  - **切换图标 = hermes codicon**（codicons.tsx，@vscode/codicons SVG path
    内联——harness 没有 codicon 字体）：zone 头部最小化 = chevron-down、
    还原 = chevron-up（hermes tree-group："icon points where the zone will
    GO"），12px；位置 hermes = 条带尾部（trailing）——flexlayout
    onRenderTabSet/onRenderTab 的 buttons 本来就渲染在尾部 ✓ 只换字形。
  - **主列吸收者判定（holdsWorkspace）**：住着主区的垂直行不能被固定子项
    钉宽——检查拖到主区下方时，childWidthTarget 旧逻辑按检查的 350px 钉死
    整个主列（max(defined)），主区被挤扁；含 workspace 的行返回 undefined
    （整行随主区伸缩，检查在行内拿自己的 350）。
  - **首轮叠片方案的遗训（已删，防重蹈）**：flexlayout 给有内容的 border
    元素写内联 `display:flex`，内联压过任何普通样式表规则——隐藏原生条
    必须 `!important`（CSSOM 里规则存在但不生效，CDP 查 computed display
    才发现）；BorderSet 只外露 toJson()（getBorders 是 @internal）。
  - **双栏拆分的约束同步（syncTabsetConstraints，2026-09-26 重新实现）**：
    拖拽分裂产出的新 tabset 没有 min/max——双栏时机器人/检查没有尺寸限制
    （用户重新提出）。上一版（全量 visit + 无条件发 action + 每次重申竖轨
    属性）在拖拽落地时嵌套触发一串 doAction，拖拽手感乱套，曾被回退。
    本版三处修正：①**diff 门控**——先比较 tabset 现有 attr 与应有值，一致
    就不发动作（常态零额外动作，拆分时只有 1 个新 tabset 需要补）；
    ②**竖轨 tabset 直接跳过**（不重申 ZONE_RAIL_ATTRS）；③requiredAttrsFor
    只比较它**声明了的键**（undefined 键不算差异，避免把 terminal 的 minW
    抹成 undefined）。拆分出的纯左栏新栏只补 {minWidth:237, maxWidth:380}——
    **不搬 classNameTabStrip**（logo 带 40px margin 只属于锚定 RailLogo 的
    原栏，新栏带了会留 40px 空带）。railAttrs 从 pane-registry 导出同源。
  - **【2026-09-26 深夜】"修复后仍现白带"的真正根因（两层叠加的失效）**：
    用户实测拆双栏后往左赶仍有白带。排查链：①给钳制加探针——拖拽时探针
    不触发 → **钳制从未运行**。②两个叠加原因：(a) **ADJUST_WEIGHTS 的
    数据键是 data.nodeId 不是 data.node**（flexlayout 工厂
    Actions.adjustWeights(nodeId, weights) 产 { nodeId, weights }）——钳制
    读 data.node 永远 undefined → getNodeById(undefined) → 早退；(b) 行
    元素**没有 data-layout-path**（只有 tabset 有）——钳制的 el 查找对
    任何行都匹配不到 → 早退。此前所有"钳制生效"的验证数据（review 钳
    160/files 钳 380）其实全是 **flexlayout 对直接子 tabset 的原生钳制**，
    我方钳制从未贡献过。修复：数据键改 nodeId；行可用 px 改
    rowAvailPx（从根行按当前权重递归下推，纯模型计算，不查 DOM——行没有
    可选标识）。验证：根缝往左拉到底 → [237 | 主区 799 | 检查 380 | 文件
    380 | 终端 760]，白带 0，主区吸收富余 ✓。**教训：为"验证通过"的结论
    找到真正的生效机制——钳制上限生效可能只是原生钳制的巧合， Controls
    探针要在第一次实现时就加。**
  - **CDP 验证坑**：窗口最小化时 WebView2 视口报 160×28（AGENTS 前记），
    页面动作照常但几何全废；`plugin:window|unminimize` 在 harness 未授权
    （capabilities 没加 allow-unminimize），PowerShell user32 ShowWindow
    恢复窗口后视口可能仍不更新——**Emulation.setDeviceMetricsOverride
    强制 1800×1000 视口可照常渲染/量测/截图，用完 clearDeviceMetrics-
    Override**。
  - CDP 终验：三轨道页签 fs 9px / horizontal-tb / pad 8px 2px、labelCx=
    railCx=restoreCx（≤0.5px 偏差）；bots 拆分后新 tabset 237-380 ✓；
    tsc 0；布局已重置 Default。
- **2026-09-25 样式架构定稿（用户三问：令牌没有单独文件？/ 终端标签为何
  没统一 / styles.css 为何 1000 多行）**：
  - **styles.css（1011 行）拆成 `src/styles/` 六个文件**，main.tsx 按序导入：
    `tokens.css`（全部令牌，:root 唯一取值处，文件头写明架构与"规则里禁止
    字面值"的规矩）→ `base.css`（窗体/壳/标题栏/窗口控制钮/状态栏/窗格
    菜单）→ `flexlayout.css`（宿主覆写+页签+三轨+fl-min-btn）→ `panes.css`
    （占位窗格）→ `editor.css`（.ep-* 布局编辑面板 + .ze-* Zone 编辑器）→
    `overlays.css`（main-tint/rail-logo/edit-veil/drop overlay）。全局色板
    令牌：--text/-2/-3/-4、--stroke/--stroke-soft、--hover-wash、--surface、
    --accent；页签系统与 --flexlayout-* 输入变量同前（全部引用令牌）。
  - **拉伸头栏（tab_button_stretch）不带基础 tab_button 类**——单页签
    zone（主区/检查/文件/终端）的头栏字号此前是 flexlayout 默认 16px，
    这就是"终端的标签样式没统一"的根源。flexlayout.css 单独给它接令牌
    （9px/500/tracking/pad；白底蓝下划线此前已复用既有规则）。CDP 实测：
    拉伸头栏与横向页签 computed 完全一致。
  - **【事故与恢复】PS 5.1 `Set-Content -Encoding UTF8` 毁掉
    layout-presets.ts / edit-palette.tsx**（规矩 5 的坑又踩一次——
    Get-Content 按 GBK 误读 UTF-8 无 BOM 文件 + Set-Content 重写，双文件
    乱码且吃掉引号/换行）。恢复：①iconv-lite（主工程 node_modules 有）
    做 GBK 逆向（layout-presets 仍剩 126 处不可逆、edit-palette 39 处）；
    ②edit-palette 逐点手修（只有 2 处可见字符串：placeholder"为布局命名…"
    与"自定义"，AGENTS 有记录可确证；其余全在注释里）；③layout-presets 用
    会话内完整 Read 的原文整体重写（写前按工具要求重 Read）。tsc 0 +
    布局编辑面板 CDP 实测全好（模板/自定义/五预设/保存行文案完整）。
    **教训升级：碰 .ts/.tsx 一律 node 脚本或 [System.IO.File]::WriteAllText
    + UTF8Encoding($false)，PowerShell 文本 cmdlet（Get/Set-Content）对
    含中文文件全面禁用。**
- **2026-09-25 三轮（用户截图：拖主区/检查的缝把左栏挤了、文件右侧一大块
  空白——"是不应该有空白区域啊"）**：
  - **根因**：分隔条拖拽路径的钳制只钳 min 不钳 max——检查/文件各有
    380 上限，把主区/检查的缝往左拖让右列超过 761（=380×2+缝）后，
    flexbox 里一行子项全部顶到 cap，富余无人吸收 → 渲染成文件右侧的
    空白；非拖拽子项的宽度还被按比例摊动（左栏被连带挤）。
  - **修复（onAction 的 ADJUST_WEIGHTS 钳制升级为有界再分配）**：
    ①新增 `maxAlong`（容量递归：行同轴 Σ、跨轴 **MIN**——垂直行的子项
    横跨整行，一个子项没上限=整行不受它约束；tabset=声明 max；
    flexlayout 的"无上限"默认 ~1e5，`< NO_CAP(9000)` 才算真钳制）；
    ②`clampBounded`：每项钳进 [minAlong, maxAlong] 后总量对齐 avail，
    差额由有余量的子项分担、**prefer 主区**（holdsWorkspace——全应用的
    伸缩吸收者）。效果：缝拖到检查/文件顶满 380 就自动停，多拖的部分
    全部进主区，机制上不可能再出空白。
  - **合成拖拽的坑**：flexlayout Splitter 用 pointerdown +
    `setPointerCapture(event.pointerId)` 起拖——JS 合成 PointerEvent 的
    假 pointerId 会让 setPointerCapture 抛 NotFoundError，拖拽根本不起
    （dispatchEvent 一路"成功"但布局纹丝不动）。**验证分隔条拖拽必须走
    CDP Input.dispatchMouseEvent**（真实指针，capture 可用）。
  - CDP 终验（Input 真实拖拽）：右列变宽方向拖 500 → review/files 钳在
    379/380、富余回灌主区、无空白；左栏缝左拖 250 → rail 精确钳 237；
    终端高度缝拖到地板 → 自动折进右轨（右侧 20px 是轨道条不是空白）；
    用户手拖的混合状态（files 并进主区 tabset、bots 在左轨）下全行仍
    铺满 1798 ✓；tsc 0。
- **三批 flexlayout 原生能力接入（2026-09-22）**：①`setOnAllowDrop` 分区投放
  校验（拖拽实时路径判定，比 onAction 拦截多"不可投放"光标；border 目标放行）
  ②`tabEnableRename/tabEnablePin`（双击改名/右键钉住/内建右键菜单）
  ③`tabSetEnableSingleTabStretch`（单页签 zone 拉伸成头栏=hermes 视觉）
  ④`onRenderTabSet` 注入 zone 头部「最小化」按钮（整组折进各自 border 轨道，
  主区不给按钮；签名是 TabSetNode|BorderNode 联合，须 instanceof 收窄）
  ⑤Escape 退出编辑模式/编辑器（hermes edit-mode owns Escape-to-exit）。
  **已知问题**：合成拖拽"机器人→主区"被 allow-drop 拒绝后左栏曾分裂成两个
  tabset（onAction 双保险也没拦住）——待查：可能是合成事件序列与 flexlayout
  内部 dragState 的交互，真实鼠标待复现。
- **flexlayout 能力清单**（0.11 全量 27 动作/27 props/60+ 全局属性；已用
  与未用、中文说明、hermes 之外的能力）——见本轮会话报告，接 pi 前把
  popout/float/tabGroups/keyMap 的取舍定下来。
- **flexlayout 仍抄不到的（残余差距，需 hermes 自绘渲染层）**：
  zone 头部菜单（harness 用标题栏「窗格」代替）；主区页签的会话瓦片拖拽
  （workspaceTabDrag——无会话数据时 hermes 本身退化为普通拖拽，骨架阶段
  等价）；动态 preview tiles 属数据面。i18n 三件套随主工程接入。
- 分工建议维持：布局骨架用库；左栏会话列表用自己的 store 重画（~2k 行）。
- **2026-09-26 v2.1 架构轮（用户定稿 → 实现，docs/layout-design.md 为唯一规范）**：
  - **窗格类型化多实例**（pane-registry.ts 重写）：PANE_TYPES 表
    （region/multi/primary/reopenable，逐项对应用户规范），实例 id =
    `type-N`（单例 id=类型名）；工厂按**类型**分发组件（paneTabJson 的
    component 必须=类型不是 id——多实例共用组件，实测踩过）。多实例类型：
    session/terminal；一级（primary）：sessions/workspace/files。
  - **关闭语义（§7）**：一级窗格离家点 ✕ = **回家**（sendPaneHome：并回
    家乡大栏现有分栏，无则在列缘重建），在家 = 拒绝；其他窗格真关闭。
    UI 路径走 Layout 的 **onAction**（签名 `(action) => Action | undefined`
    单参！）拦 DELETE_TAB；程序化路径走 closePaneById（doAction 不经过
    onAction）。
  - **region 继承**（约束引擎 v3，flex-layout syncTabsetConstraints）：
    tabset.config = {region, rail}（JSON 持久化载体）；无 config 的 tabset
    按**近邻兄弟**继承（findInheritedCfg：分裂来源=相邻兄弟先左后右，
    兄弟是 row 则下钻子树），全无 → main。
  - **宽度限制只给宽度轴上的分栏**（本轮最大 bug 教训）：父行 HORZ 的
    tabset 才拿 REGION_LIMITS（240/395/420）；父行 VERT（底部堆叠分栏）
    宽度**跟随所在列**（用户规范原文"底部分栏的限制跟随上部的宽度"），
    min/max 清默认——否则列 maxW(420) < 行内 Σmin(481) 自相矛盾，根行
    被挤成 419/895/241 + 终端被钳 420（实测）。垂直堆叠高度无上限（min
    由横向条天然保证）。
  - **栏级竖轨（RegionRails，region-rails.tsx）**：竖轨是**大栏级**的一条
    ——左栏列左缘/右栏列右缘/主栏列左缘（用户："不是就三栏吗"），20px
    宽、文字 90°（vertical-rl）、列出该栏全部分栏的页签：点行=selectTab
    （分栏约束不动）、行上关闭钮（一级在家乡无）、顶部一个切横轨钮、
    底部「+」（竖轨态 + = 直接多加一栏：addNode LEFT/RIGHT 并列新分栏，
    右栏向左分）。宿主绝对定位叠片 + rAF 循环量测（分隔条拖拽中
    layoutRev 不 bump）——flexlayout 无法在列缘生成承载其它 tabset 页签
    的原生条，**记录在案的有意偏差**。形态标志按 region 归一（sync：任一
    分栏 rail → 整栏 rail）；toggleRegionForm 整栏切换。
  - **「+」系统**：PaneAddButton（单一可开类型直建=主栏；多类型弹
    zone-add-menu=右栏）；+ 只渲染在**一级栏**（宿含本大栏一级窗格的
    zone）——"分出的其他栏没有 + 号"；单例已开/无可开 → + 自动隐藏。
  - **本轮删除**：pane-menu.tsx（标题栏窗格菜单）、layout-store 的
    paneSizes/hiddenPanes、drag-session 的 rail 单向阀（v2.1 无分区隔离：
    窗格可落任何大栏，落点定身份）、zone-editor 改用类型注册表。
  - **CDP 验证陷阱（重要）**：Tauri 窗口**最小化时 WebView2 视口报
    160×28**——boot 时默认预设按 160px 算权重（350/158 → NaN weight）并
    被 boot 自愈动作立刻持久化，清存储+reload 的窗口期会被回写覆盖；
    全部几何数字都是伪影。验证前必须确认窗口未最小化（evalJs
    `window.innerWidth`  sane 再测），或用应用内全重置（ctrl+点击布局
    编辑器钮）在当前视口重建默认布局。修复宽度轴 bug 后实测：全重置 →
    350/746/350+350/700×200 精确无缝；tsc 0。
- **2026-09-26 竖轨三次修正轮（用户实测反馈驱动，最终形态见设计文档 §5）**：
  1. 一次修正：竖轨是**大栏级**一条（不是每分栏一条 84px 横字轨）；
     文字 90°（vertical-rl）——折叠轨道（border 轨）同样改回 90°（撤销
     前轮"文字横向"的摆正）。
  2. 二次修正（停车轨方案，**已废弃**）：20px 原生停车 tabset + 点行开
     栏——用户实测四连拒：空栏占位=bug（吸收区空分栏）、页签点完从轨里
     消失、行拖不动、"标签应该显示的栏没显示"。
  3. **三次修正（最终形态）**：竖轨 = 该栏的页签条竖过来——折叠把该栏
     全部页签**并进一个竖轨分栏**（rail:true + enableTabStrip:false），
     工厂渲染 `RailZone` = [20px 竖轨 | 活动窗格]，内嵌分栏 flex 布局
     （独立占位、零重叠）。**页签常驻轨里**：点行=selectTab 切换显示
     （不消失）；行可拖拽（onRowPointerDown → startPaneDrag，拖去别的
     栏=搬家）；关闭图标按 enableClose；顶部一个切横轨钮（快照还原）；
     「+」= 本栏加页签。**没有空栏**——折叠后该栏只剩竖轨分栏本身，富
     余由它按大栏限制吸收；竖轨分栏拖空 → 紧凑控制条占位
     （enableDeleteWhenEmpty:false）。左栏竖轨 padding-top 40 给 logo 带。
  - **连锁的三个坑（都有实测）**：
    ① `Actions.adjustWeights(nodeId, weights)` 的数组映射会把权重写到
    错误的兄弟头上（吸收区被加上右列权重 79.4=40.46+38.95 复现）——
    根行配重改用逐节点 `updateNodeAttributes({weight})`。
    ② **flexlayout 的 ROW 属性不含 config**（预设 JSON 里 row.config 被
    解析丢弃）——根行配重读右列身份时拿到 undefined → px=0 → 主栏吸收
    区吃下全部富余。regionCfgOfNode 对 row 下钻子树取第一个带配置的
    tabset。
    ③ 根行配重的列宽钳制必须读**实际生效**的 min/max（sync 已按堆叠语
    境清过），不能回头按 REGION_LIMITS 表钳——否则右列被终端的 420 上
    限整列钳死（widthBounds：垂直行 MAX/MIN 聚合、水平行 Σ）。
  - 终态实测：折叠后 [350 | 20+内容 | 420] 三轨各就各位、页签切换/拖
    曳/快照还原全通、无空栏无白带、tsc 0。
- **2026-09-26 根行不变式轮（用户：总宽 1800 宽度全变最小后右边留白 +
  右栏被挤出窗口，"就不应该有空白区域"）**：
  - **根因一（行盲量测，主犯）**：absorbSurplus/measureRootPx 用
    data-layout-path 量根行子节点——**行没有该属性**（Default 根行第
    三个孩子就是 spl-right ROW）→ 右栏恒被量成 0px → deficit 恒为整栏
    宽 → 主栏权重每次拖拽/结构动作提交 90ms 后都被吹爆一次（用户看到
    的"挤栏 → 下次调宽度自己弹回"循环）。修：measuredPxWidth（行=后代
    tabset union rect，与 pinPass 教训同源）+ rootAvailPx（宿主宽−可见
    左右边框轨条；window.innerWidth 把壳边框也算进去）。
  - **根因二（过度承诺）**：主栏多开会话栏（395×n）或窄窗时
    Σmin(240+395n+481+轨) > 可用宽——flexbox 的内联 min-width 钳死权重
    层的一切缩让，末栏被挤出窗口。修：syncTabsetConstraints 里主栏
    min 按可用宽比例缩让（底线 40px；宽度恢复自动回 395，diff 门控双
    向生效）。左右栏 240 底线不让。
  - 其余：absorbSurplus 吸收者改为 主栏→无上限列→最后一个非轨列（右
    栏 20px 轨贴行尾，不能当吸收者）；window resize 160ms 防抖自愈
    （sync+absorb）；boot 自愈补跑 absorbSurplus。
  - **flexlayout 新事实**：分隔条拖拽边界用**聚合 min**（行 getMinWidth
    ()=子节点聚合，右栏 481 实测生效）；**聚合 max 不钳**（右栏列被拖
    过聚合上限 841 到 1051——主栏顶到 min 后富余只能归它，留白比越
    max 更不可接受，视为正确行为）。
  - 规范落纸：docs/layout-design.md 新 §10「根行不变式」（Σpx+缝=可用
    宽的三层机制 + 量测教训）；§11 存储键记录修正 v5→v6。
  - 实测（IAB CDP，1800×1000）：默认 [350|746|700] 精确；右栏拖到 min
    [350|964|481]（左栏不再被权重污染挤动）；主栏拖到 min 时右栏吸收
    富余无留白；缩 1000×800 → sync 缩主栏 min 至 275、[240|276|482]
    Σ=998 无溢出；回 1800 几何恢复；+ 堆叠/竖轨建拆轨全程 Σ=可用宽；
    tsc 0。
- **2026-09-26 根行不变式二轮（用户：还有空白/轨内行有的拖不动/组分割线
  三根/最小化后位置漂移/轨内 + 应堆叠/拖签能进轨还能把轨分栏）**：
  - **冷启动权重写坏（"还有空白"的真根因）**：flexlayout 的
    calculatedMin/Max 要到**首次布局**才算（`Model.fromJson` 后全 0，node
    实测），boot 时同步跑的 absorbSurplus 拿到 widthBounds={0,0} → 左右栏
    目标被钳成 0 → 主栏吃到 rest=全部可用宽（权重 100，动作日志实锤
    `{weight:100}`）→ 左右栏钳最小 = 右侧大块空白且烙进存档。修：absorb/
    applyRootWeights 加**布局未就绪守卫**（任一列量不到 px≤0 或 bounds 非
    有限/上限 0 → 整体放弃）+ boot absorb 延后双 rAF。
  - **absorb 常跑钳制+再分配**：列超**聚合 max** 时（子分栏全顶满）根行
    Σ=可用宽、deficit 探测不到，留白在行内部——非主栏列钳进聚合约束、富
    余还主栏，写入权重与渲染真相对齐消掉钉住态。
  - **最小化→位置漂移**：最小化视口 160×28 过窄屏断点 → 两侧收 overlay →
    恢复收编重排。修：narrowNow 高度守卫（innerHeight ≤240 视为最小化瞬
    态）；expandSide 重建锚点改"左贴最左/右贴最右"（此前都锚第一个子节
    点，两栏同收再展开主栏被挤到最后=列序漂移，窄视口往返实测抓到）。
  - **拖签进轨/把轨分栏**：两条路径都堵——①本引擎 snapshotZones 排除轨
    （此前 20px 轨是合法投放 zone：中心吞签不显示、边缘把轨分栏）；
    ②setOnAllowDrop 拒贴轨分裂/插入（row 索引相邻轨、tabset 边缘相邻轨）。
  - **轨内行跨组拖 = 搬进那个分栏**（此前跨组无动作="有的行拖不动"的感
    知来源）；RailNav 订阅 layoutRev 修选中高亮滞后（占位内容不随纯选中
    变化重渲）。
  - **竖轨「+」改堆叠语义**（用户二次定稿，覆盖"直接多加一栏"）：堆叠进
    该栏一级窗格所在分栏，同类型收进页签组、点行切换、拖出并列。文档 §4.2
    已改。
  - **组分割线**：组自带上下边框+组间 gap 线 = 两组之间三根线（用户实测）
    → 改相邻选择器单根线、删 gap 元素。
  - 实测（IAB CDP 全场景）：冷启动 [350|746|700] 权重正确；轨 20px/3 组/
    单分割线；+ 堆叠几何零扰动；点行切换 active 即时；跨组搬移 ✓；拖出
    大栏 ✓（原分栏 tidy）；投轨拒绝 ✓；主栏 min 极限右栏吸收无留白；窄视
    口往返列序不漂。已知小瑕疵：窄往返重建的侧栏分栏落在 max（420）而非
    记忆宽，有界、后续可用记忆配重优化。tsc 0。
- **系统托盘 + 关闭到托盘（2026-09-26 凌晨加进 harness，主工程 AGENTS 段
  的语义与坑在此同款适用）**：`src-tauri/src/main.rs`——托盘菜单
  「显示主窗口/退出」、左键托盘=显示主窗、✕=CloseRequested 拦截+隐藏
  （tao hide 在 transparent 窗上失效 → `force_hide` 裸 FFI SW_HIDE 兜底）。
  Cargo features 需 `tray-icon`（已在）。**"托盘没了/关了就退出"的排查**：
  ①先对 exe 与 main.rs 的 mtime——旧 exe 无托盘（托盘是 00:25 才加的），
  重启 `npm run tauri dev`/`cargo run` 即得；②行为级测试法（PowerShell 起
  exe → `SendMessage(hwnd, WM_CLOSE)` → `EnumWindows` 看进程存活+主窗
  vis=false + `tray_icon_app` 窗口存在）——2026-09-26 实测当前构建全绿；
  ③Win10/11 新托盘图标默认进**隐藏溢出区**（时钟旁 ^ 里面），不自动展示
  在任务栏，用户看不到≠功能没有。托盘窗口类名 `tray_icon_app` 可用作
  注册成功的探针。
- **2026-09-26 代码复审轮（用户：全面复审找逻辑漏洞）——六处修复**：
  1. **双击分隔条回默认权重整体从未生效（复审最大发现）**：三层叠加——
     ①flexlayout 的 splitter 在 pointerdown 里 preventDefault，浏览器不
     合成 click/dblclick，React 的 onDoubleClick 在分隔条上永远不触发
     （此前"已验证"是假的——dblclick 探针实测从未到达宿主）；②缝心
     永远压在相邻子矩形共享边界上，闭区间比较 → insideChild 恒 true →
     best 永远找不到；③查到的预设权重算完就丢（死代码），永远走均分。
     修：双击检测挂 **document 原生捕获**（flexlayout 起拖把指针捕获到
     host 外的元素，第二击 pointerdown 不经过宿主捕获段——document 级
     捕获必然在路径上），第二击 stopPropagation 拦起拖；子矩形比较向内
     缩 3px（flexlayout 相邻子项矩形互相重叠 1-2px，把分隔条空间包在
     里面）；预设权重恢复真正实现（逐节点 updateNodeAttributes，避开
     adjustWeights 数组映射坑）。
  2. **sendPaneHome 重建锚点**：右栏回家锚第一个子节点 → 插到左栏旁边；
     改 region 感知（左=最左、右=最右、主=第一个主栏分栏）。
  3. **narrow 效应两处洞**：borderType 无差别 doAction → onModelChange →
     刚应用的预设标记立刻被清（applyJson → setModel → effect 重跑）——改
     isOverlay diff 门控；applyRootWeights 未重建也跑 → 旧记忆覆盖预设
     权重——改按 expandSide 返回的"是否重建"门控。
  4. **drag-session 贴轨 edge 拒绝**：dropBlock 走 doAction 直提、绕过
     setOnAllowDrop——edge 落点新分栏会插进轨和分栏之间（"把竖轨分栏"
     的第二条例径）；resolveMove 里对 left/right edge 检查相邻轨，命中
     返回 null（no-drop）。
  5. **startDragSession 捕获兜底**：RailNav 拖出转交已结束的 pointerdown，
     React currentTarget 已置空 → 捕获从未建立 → 指针拖出窗口会话卡死；
     currentTarget 为空时退化捕获到 documentElement（同一 pointerId 有效）。
  6. resize 自愈补 measureRootPx（记忆不再被中间态污染后保持新鲜）。
  - **已知待跟进**：窄视口往返重建的侧栏分栏落在 max（420）而非记忆宽
    （重建直写记忆权重 + 延迟 applyRootWeights 都做了，仍有中间态交互，
    有界不破规范，后续专项）。tsc 0；冒烟：冷启动几何 ✓、拖拽 ✓、双击
    重置生效 ✓、窄往返列序 ✓ 无留白 ✓。
- **2026-09-26 三轮（用户四项：纵向拆分后列限制丢失 / 主栏没了 max 该放
  开 / 离家一级标签 ✕ 常显 / 回家落错位）**：
  1. **纵向拆分后整列宽度限制丢失**：sync 把 VERT 父下的堆叠分栏一律清成
     [0,99999]（跟随列宽）——但列的聚合 min/max 来自子项，全清后列本身
     变成无界（用户："整个宽度限制没了"）。修：**堆叠列的第一个（顶部）
     分栏保留大栏限制**，其余跟随（[0,∞]）——列聚合 = [大栏 min, 大栏
     max]，终端这类柔性子项不受影响（右列 [481,841] 不变）。
  2. **主栏缺失时非主栏 max 放开**（用户定稿："主栏没了，左右两栏最大宽
     度限制应该变没有，只保留最小宽度限制"）——sync 检测根行有无主栏分
     栏，没有则非主栏 maxWidth=99999（min 保留），主栏回来 diff 门控自动
     恢复 max；吸收者兜底（absorb 的无上限列选择）随之恢复工作，无留白。
  3. **离家一级标签 ✕ 常显**（用户定稿："关闭按钮要可见，点击是回家"）：
     flexlayout 的 trailing 关闭钮默认 hover 才显示——sync 给离家一级页签
     打 `fl-tab-away` 类 + CSS 强制 `visibility: visible`（拉伸头栏同覆
     盖）；在家时类被移除、✕ 消失。
  4. **回家落错位**（用户："主栏去到左边，左栏变到中间"）：sendPaneHome
     主栏重建回退锚 kids[0] 的残留——主栏缺失时改锚**第一个右栏分栏的左
     缘**（无右栏则贴最后子项右缘），主栏必然回到左右两栏之间的中间位。
  - "整个标签栏能拖出来" = SingleTabStretch 的视觉：单页签分栏的头栏就是
    页签本身（拉伸充满），拖它 = 拖该页签（规格行为，分栏随页签走）；
    flexlayout 无整栏拖拽能力（grep 证实）。若嫌误触率高，后续可加拖拽
    阈值或把拖拽把手缩小区——待用户定夺。
  - tsc 0；用户 Tauri 实例 CDP 重载验证：Σ 铺满（420/1336/轨 20 + 右轨条
    20）、无 away 页签时类不挂。
- **2026-09-26 四轮（用户：宽度限制要跟随状态 / 无主栏 max 放开 / 离家 ✕
  常显点击回家 / 手柄拖过头和限制打架闪烁）**：
  1. **sync v4：限制跟随状态（本轮核心重构）**——列 identity 改由**一级窗
     格锚定**（列子树按文档序找第一个一级窗格：sessions=左栏、workspace=
     主栏（中间栏）、files=右栏；无一级窗格沿用 config、再缺 main），每个
     分栏的 config/限制/关闭钮**全部从其所在列动态推导**：拖进哪栏继承哪
     栏限制、回家自动变回来（此前 config 贴在分栏身上一次定死，搬动后不
     跟随）。findInheritedCfg 邻居继承被此模型取代（删除）。
  2. **拖拽实时钳制 clampRowWeights（onAction 拦 ADJUST_WEIGHTS）**：
     flexlayout 的 calculateSplit 只按 MIN 侧钳位、不钳聚合 MAX——手柄把
     右栏拖过聚合上限后，DOM 内联 max 把列钉住、富余甩给邻列，松手权重
     提交又跳回 = "带着整个右侧栏往左跑、和限制打架来回闪烁"（用户实测）。
     修：onAction 对 ADJUST_WEIGHTS（含 adjusting 中间帧）逐子项钳进
     [minAlong, maxAlong]，差额按容量水填充给未顶格子项（主栏/无上限列容
     量最大自然承担吸收者），返回修正后的 action——手柄到 max 物理推不动。
     实测：右栏顶满 841 后把手拖过头纹丝不动。
  3. 纵向堆叠列**顶部首分栏保留列限制**（其余 [0,∞] 跟随）——修"会话移到
     左栏下半部分后整列宽度限制没了"。
  4. **无主栏吸收者 → 非主栏 max 放开只留 min**（diff 门控，主栏回来自动
     恢复）——修"主栏没了只有左右两栏"时的无界/留白。
  5. **离家一级标签 ✕ 常显**（fl-tab-away 类 + CSS visibility）+ **回家锚
     点**：主栏缺失时锚第一个右栏分栏左缘（主栏必然回到左右之间的中间
     位）——修"主栏去到左边、左栏变到中间"。实测：拖主会话进左栏 →
     fl-tab-away + ✕ visible ✓ → 点 ✕ → [左|主|右] 正确归位 ✓。
  - **邻居继承回归修复（v4 遗留，三栏通用非只左栏）**：列 region 推导重构
    时丢了"无戳新列从最近邻继承"——机器人拖出双栏并列后错继承 main（min
    395 无上限）。修：三级来源 ①config 戳 ②列内第一个一级窗格 ③最近邻
    已推导列（左先右后传播）→ main。实测：机器人拖出 → 新列继承 left
    （宽拖到 420 停）✓；链式分裂（检查拖到机器人栏右缘）→ 第三列仍 left ✓。
  - **自适应窗宽（用户定稿）**：Σ(各列聚合 min)+轨+缝+壳边框 > 当前窗宽
    （装不下新栏）→ fitWindowWidth 自动长窗到 need（钳屏幕可用宽）；关栏
    /合并后 need ≤ 1800 → 回 1800（仅结构动作触发回位，resize 只长不缩）。
    实现：fitWindowWidth 在串行通道内先于 sync 执行（长窗后缩让不误触
    发）；窄屏抽屉模式跳过。**需要 caps `core:window:allow-set-size`**
    （加权限后必须重建 exe）。无锚列不夺锚：有 config 戳的列 identity 永
    久保持（拖入一级窗格、原锚离开均不变）。
  - **挤压级联 + 自适应窗宽（用户定稿，PowerShell 缩窗实测）**：窗口缩小时
    级联 = ①各列挤到 min → ②装不下（inner+2 < Σ聚合min）→ 每大栏合并所
    有分栏进家乡一级分栏（一级不在家并入第一个分栏），单向不自动拆回 →
    ③仍装不下 → 隐藏左右栏（撤 overlay 抽屉）→ 最终窗宽下限 600（conf
    minWidth 900→600）。实现：mergeZonesPerColumn + updateNarrowViewport
    （动态阈值=根行聚合 min+边框折叠侧栏 min，替代 640 matchMedia；最小
    化 innerHeight≤240 不改判）。fitWindowWidth 长窗/回位仅结构动作触发
    （手动缩窗走挤压不长窗）。**无边框窗 resize 手柄**：8 条命中带
    （四边+四角）pointerdown → startResizeDragging（caps 需
    allow-start-resize-dragging）。
  - "整个标签栏能拖出来" = SingleTabStretch 视觉（单页签分栏的头栏就是页
    签），拖它 = 拖该页签，规格行为。【2026-09-27 修正：flexlayout 其实
    **有**整栏拖拽——tabstrip 容器 draggable=true，空白处拖 = 整栏拖出/
    浮动；当日已关闭，见「2026-09-27 轮」。】
- **2026-09-26 五轮（用户截图：切竖轨后满屏 20px 竖条）——v4 重钉自伤**：
  sync v4 的 config 重钉 `patch.config = { region, rail: false }` 是**整对象
  替换**，把竖轨的 `track: true` 身份抹掉了 → findRailTabset 永远找不到
  轨 → 每次切竖轨都新建一条轨，多次切换积累成两排 20px 竖条（每条渲染
  一个 RailNav）。修：重钉跳过 isTrack。教训：**updateNodeAttributes 的
  config 是整对象替换，重钉时必须保留/跳过带 track 身份的节点**。
  - 拖拽幽灵线（flexlayout__splitter_drag）定性：realtimeResize 默认开启
    （实时缩放），幽灵线是非实时模式的遗留指示物，本方案下"不该有"——
    【2026-09-27 修正：display:none 不是正解——它是拖拽位置输入，见下
    「六轮」；正确写法 visibility:hidden。本条作废留痕】。
  - 用户实例恢复：CDP 清 mirach.* 存档 + 重载（污染的多轨布局不可修，
    直接重置）+ 程序化验证切轨生命周期：on=1 轨/off=0/on=1 不累积 ✓。
- **2026-09-26 六轮（用户："宽度拖动没用，只会跳"）——幽灵线 display:none
  自伤**：隐藏 `.flexlayout__splitter_drag` 用了 display:none——flexlayout
  拖拽以幽灵线的 offsetLeft/offsetTop 作为**拖拽位置输入**，display:none
  使 offset 恒为 0 → 每帧 calculateSplit 都按"缝在最左"重算 → 宽度/高度
  拖动全部砸向边界、只会跳。修：改 `visibility: hidden`（保留几何、仅不
  可见）。实测拖拽精确跟随（350→270 精确）、连续拖动正常、高度 -40 精确。
  **教训：隐藏库元素的拖拽指示物前，先确认库是否用它做位置输入。**
- **2026-09-27 轮（用户四项：条拖拽打架 / 竖轨避 100 / 底栏避圆角 /
  最小窗宽 600）**：
  1. **页签条本体拖拽关闭**（用户："条拖出来和标题栏打架，只要里面的
     标签能拖"）。根因实锤：flexlayout 的 tabstrip 容器
     `draggable: true + onDragStart`（bundle 里 path+"/tabstrip" 两处），
     空白处按住拖 = HTML5 拖整栏（拖出/浮动）——**五轮"flexlayout 无整
     栏拖拽"的结论是错的**。修：document 捕获段拦 dragstart，目标不在
     页签按钮内（tab_button / border_button / tab_button_stretch）一律
     preventDefault+stopPropagation；页签按钮拖拽本就由 pointer 引擎
     接管（pointerdown preventDefault → 原生 dragstart 不发起）。
  2. **竖轨标签上下避 100**：`.zone-rail` 与左右折叠轨道
     （border_inner_tab_container_left/right）padding 上下各 100——顶部
     让开 100px 页签条/标题栏带，底部让开圆角曲线。实测轨内首行 offset
     =100、切轨往返无残留。
  3. **底栏/手柄避圆角**：状态栏内容左右 padding 50；resize 四边手柄
     离角 50（South left/right 50 等，四角 16px 归角手柄）——圆角 50px
     区域全部让位。
  4. **最小窗宽 600**：tauri.conf minWidth 已是 600（上轮）；本轮补
     fitWindowWidth 的钳制下限 900→600（MIN_WINDOW_WIDTH 常量，注释
     标了与 conf 同步）。
  - 验证（CDP 9223）：条 dragstart prevented=true 且 flexlayout 的
    onDragStart **未执行**（无 setData 报错=拦截在库 handler 之前）；
    页签/拉伸头栏 dragstart 放行（真拖拽走 pointer 引擎）；状态栏
    padding 50/50、pill 左缘 51；手柄几何 [50..1750]×6 四边 + 16px 四角；
    竖轨 100/100；拆轨 500ms 内干净、存档无 track 残留；tsc 0。
  - **测试方法论两坑**：①合成 DragEvent 无 dataTransfer → flexlayout
    onDragStart 里 setData 抛 TypeError——这是合成事件伪影不是 bug，
    反过来"条分发无报错"恰是拦截生效的证据；②程序化 el.click() 不会关
    「+」弹出的类型菜单——后续点击被菜单吞掉，曾误判"拆轨失效"（复现
    失败 + 无菜单路径干净即证）。
  - **竖轨形态 logo 补位**（用户："标签竖型时没有横向标签栏，logo 不见
    了"）：logo 原本住在会话分栏横向条 leading（onRenderTabSet 注入），
    竖轨形态 sync 把横向条 enableTabStrip:false 隐藏 → logo 随条消失。
    修：RailLogoLeading 提成模块组件，工厂检测"父分栏 enableTabStrip
    =false 且含 sessions 页签"时在**内容顶部**渲染同一条带
    （.rail-pane-railform：leading 70 高 + body flex:1 吃剩余）——横向
    形态条内 leading 仍在、不会双 logo；logo 跟随 sessions 所在分栏
    （§6 语义），被拖进别的大栏再切竖轨也成立。实测（CDP）：切竖轨出带
    （70/带内 img+MIRACH、body 908）、切回恢复条内 leading 无带、截图
    目检带与竖轨并排无重叠。
  - **调色层三改 + 低条**（用户：颜色层写进令牌 / 垫到文字下 / 避 100 /
    40 圆角 / 上下分栏 100 条太高）：
    ①**调色层进令牌**：--main-tint-color（E9EEEF@40%）/ --main-tint-radius
    （40px）；条高令牌化补齐——flexlayout.css 的 tabbar 100px 字面量改接
    既有 --logo-strip-h，新增 --strip-low-height: 36px。
    ②**垫到文字下**：.main-tint z 20→**-1** + .flexlayout-host
    **isolation: isolate**（建层叠上下文，-1 掉不进 app 白底、又压不到
    布局内容）——flexlayout 背景全透明（light.css），颜色层从内容后面
    透出，文字正常画在上面。
    ③**顶部避 100**：MainTint 的 top/height 改 calc(± var(--logo-strip-h))
    ——横向避条、竖轨避标题栏/logo 带（条高改令牌一处全跟）。
    ④**低条（isTopBand + fl-strip-low）**：条 100 高的双重身份（标题栏区）
    只属于窗口顶带——沿父链上行，VERT 行只有第一个孩子在顶带、HORZ 行
    全体孩子都算、到根行=顶带；非顶带分栏（如终端）sync 打
    classNameTabStrip 'fl-strip-low'（flexlayout 0.11 该 attr 落在
    tabbar_outer 上，**没有 classNameTabSet attr**——bundle 实证），CSS
    把条降到 36、文字居中、rail-logo-leading 强制隐藏（退化保护）。
    实测（CDP）：tint bg/radius 40/z -1/topGap 精确 100（横+竖轨）、终端
    条 36+低标而顶带三条 100、截图目检文字在层上圆角可见。
  - **logo 20/20 + 空区竖轨清理**（用户 2026-09-27）：
    ①**logo 上/左间距 20**：实测原 logo 顶距条顶 44——条容器是 flex-end
    沉底链，70 高的 leading 被压到条底（30-100），padding-top 10 只是
    其中偏移。修：leading 高度 = var(--logo-strip-h)（占满条，沉底失效）
    + padding 20/20 + **align-items: flex-start**（行内 logo+文字整体
    垂直居中会把 logo 再压到 34，顶对齐后 .rail-logo-word 加
    line-height: var(--logo-size) 与 50px logo 互相对中）。实测 mark
    距条顶 19/左 22（1-2px 是 tabset 边框）。
    ②**空区竖轨清理**：原设计"空轨保留"作废——竖轨里关闭区内最后一个
    窗格后空轨残留（用户实测报 bug）。修：sync 在 region 推导完成后
    prune——某区的轨还在但 nonTrackKids 里已无该区分栏 → 拆轨（翻
    enableDeleteWhenEmpty + 假页签即删，同 toggleRegionForm 拆路径）。
    区回种不依赖空轨：回家（一级列缘重建）/拖缘/别的栏的 +。全链路
    CDP 实测：会话拖进主栏（withWorkspace true）→ 左栏只剩机器人切竖轨
    → 竖轨里关机器人 → railGone true、根行 [main, right]、存档无 track。
  - **CDP 拖拽新坑**：会话页签按钮的中心点会被条尾 **tab_toolbar 覆盖**
    （logo leading 217 + 两页签 + 工具钮 > 350，条内过挤——按钮左段
    ~219-251 是无覆盖区）——CDP 按页签要按按钮**左段**（x = rect.left
    +15），按中心点命中的是工具钮、拖拽不发生（elementFromPoint 实证）。
    条内拥挤是已知形态代价（用户定的 logo 进条方案），未修。
  - **页签纯文字化 + 条内左对齐**（用户 2026-09-27："标签下面为什么有根
    线 / 文字就是按钮不要按钮形式 / 会话列表标签没左对齐"）：
    ①"根线"两层：条容器自带 border-bottom 1px 灰线（flexlayout 默认）+
    选中/拉伸头栏的 inset 0 -2px 主题色下划线。②**页签=纯文字**：全部去
    掉（表面/下划线/页签间 border-left 分隔/条底灰线），状态只剩文字色
    ——常规 #242424 / hover 品牌色 / 选中 #006fff；多选 accent 14% 洗
    保留（多选唯一视觉）。③**左对齐**：logo 不在 inner_tab_container
    里——它的包裹层 **.flexlayout__tabset_leading** 才是 tabbar_outer
    的直接子级（flex 行内把按钮顶到 x=219）。修：包裹层 absolute 条顶
    满宽 + pointer-events none（点击穿透到下面的页签行）；容器
    padding-left 10 + 页签 padding 10 → 文字与 logo 同一左线 20。
    **坑**：拉伸头栏前有 0/4px 的 tab_spacer，`:first-child` 打不到它；
    absolute 要打在包裹层不是 .rail-logo-leading 本身。实测：sessLeft
    219→12（文字 22=logo 左线）、全部 bg/shadow/border 清零、条底 0px、
    选中蓝 hover 蓝、截图目检干净。
  - **页签分隔圆点**（用户 2026-09-27：横栏标签中间加 5px #BFC3CC 圆点）：
    onRenderTab 对**多页签条的非首签**注入 renderValues.leading =
    .fl-tab-sep（CSS 绝对定位 left -2.5px 骑在两签交界、top 50% 对文字
    中线；按钮加 position:relative 作参照）；单页签 zone（无前签）与
    折叠轨道（BorderNode 早退）天然无点。令牌 --tab-dot-size:5px /
    --tab-dot-color:#bfc3cc。实测：左栏两签 1 点、交界居中、单签区与
    轨道 0 点、截图目检 ✓。
  - **【UI 阶段启动】assistant-ui 接入（2026-09-27，用户指令）**：
    - 版本：@assistant-ui/react **0.15.22**（含 @assistant-ui/core）；
      ~~@assistant-ui/react-ui 0.2.1~~ **已放弃**（其构建面向 react 0.14，
      import useThread/useAssistantRuntime 等 0.15 已移除的导出，vite
      预构建直接报 No matching export）；改走 **assistant-ui CLI**
      （= shadcn CLI + registry：`npx shadcn@latest add
      https://r.assistant-ui.com/thread https://r.assistant-ui.com/thread-list`）。
    - CLI 带来 Tailwind v4（tailwindcss 4.3.3 + @tailwindcss/vite，vite
      插件已接）+ shadcn 基座（src/components/ui/*：button/textarea/
      tooltip/dialog/avatar/collapsible/input/skeleton）+ src/lib/utils
      .ts（cn）+ src/hooks/*；registry 组件落位：thread.aui.tsx（对话，
      833 行）、thread-list.aui.tsx（会话侧栏）、markdown-text.tsx、
      reasoning/tool-group/tool-fallback/follow-up-suggestions/
      attachment（elements 归 src/components/assistant-ui/elements/——
      CLI 写到 components 根目录但导入路径指向 elements/，需手工归位）、
      file.tsx/image.tsx；主题令牌在 src/styles/tailwind.css（Tailwind
      v4 CSS-first：@theme inline + shadcn :root 变量），main.tsx 最后导入。
    - 挂载：`src/components/assistant-ui/runtime.tsx` = AssistantRuntime
      （useLocalRuntime + mockModelAdapter：回显式流式，pi 接入后仅换
      adapter）；FlexLayoutShell 整树包 AssistantRuntimeProvider；
      COMPONENTS：sessions→AssistantSessionsPane(ThreadList)、
      workspace/session→AssistantThreadPane(Thread)；右栏 files 无
      assistant-ui 组件（生态没有文件树），保持占位，后续基于 src-tauri
      的 fs_list 命令自建。
  - **文件树窗格实装**（2026-09-27 二轮补完，替代"保持占位"）：fs.rs 从
    主工程（G:/MIRACH/src-tauri/src/fs.rs）逐字移植（fs_list/fs_git_root/
    fs_read_data_url；Cargo 加 serde+base64；main.rs 注册 mod fs +
    invoke_handler）。前端：`src/lib/fs.ts`（invoke 封装）+
    `panes/file-tree-pane.tsx`（懒加载目录树：根路径可输入、目录点击
    展开/收起按需 fsList、文件叶子选中高亮；样式走令牌）；COMPONENTS
    files→FileTreePane。实测：根目录 16 项、目录排前、懒展开正常。
    文件点击预览（fs_read_data_url）待接。
  - **composer 控件 = 官方 elements**（用户 2026-09-27 指令："elements
    有很多组件，不要自己做"，**自研 composer-controls/settings 已删**）：
    shadcn CLI 拉 `https://r.assistant-ui.com/model-selector` +
    `.../context-display`（也可用 `@assistant-ui/model-selector` 命名），
    落 **model-selector.{tsx,aui.tsx} / context-display.{tsx,aui.tsx}**
    （手工归位 components/assistant-ui/，导入路径同步修正）。
    接线 = **直接改 thread.aui.tsx 的 Composer 函数**（官方 Perplexity
    克隆模式）：ComposerPrimitive.Root 内加 ModelSelector（models 传
    ModelOption[]，efforts:true 带 低/中/高 Thinking 行；选择经
    ModelContext 注册进 runtime——api.modelContext.register）+
    ContextDisplay.Bar（aui 版自动 useThreadTokenUsage 读用量元数据；
    **无用量时不渲染是官方语义**，mock 运行器无元数据故暂不显示，pi 接
    入后 finish 步带 usage 即亮）。官方原语保留：Root/Input/Send/附件/
    Dictate；`unstable_useComposerInput`（headless 输入接管）0.15 存在、
    备用。**颜色层回归修复**：registry Thread 根 `bg-background` 白底盖
    住 MainTint——改 `bg-transparent`（Tint 从内容后面透出恢复）。
  - **asChild 落容器**（用户 2026-09-27 二次指令，"已有 FlexLayout 容器"
    官方场景）：ThreadRoot 的 **ThreadPrimitive.Root asChild** + **Viewport
    asChild**（turnAnchor prop 留在**原语上**——asChild 只合并行为到子
    元素，业务 prop 不能写进子 div JSX，TS2322 实证）。改后 DOM 层级：
    tab content → aui-root 容器（我方 div）→ viewport div（我方 div，
    overflow-y:scroll）→ maxwidth div——registry 的两层包裹 div 消失。
    ViewportFooter 的 `bg-background` 同步改 `bg-transparent`（composer
    带后不再挡 Tint）。实测：pane.children===1 且即 aui-root、viewport
    为 root 直接子级、滚动容器有效。
  - **mock 全阶段运行 + thinking-indicator**（2026-09-27 三轮，"组件都
    补齐"）：之前"简陋"的真因是 mock 只吐纯文本——官方 Reasoning（思考
    前/中/完成折叠）与 ToolGroup（工具运行/折叠计数）**早已接线**但从未
    被触发。mock 运行器升级为三阶段模拟：reasoning 流式 → tool-call
    （适配器结果的 tool-call **不带 status**——运行态由有无 result 推导；
    **argsText 必填**）→ 最终文本流式，全程 yield 累积 content 数组。
    thinking-indicator 元素（shadcn 拉，+surfaces 依赖，归位 elements/）
    按官方文档接线：运行中且无可见正文时渲染，label=挂起工具名或"正在
    思考"，1s 计时器做耗时徽章，正文到达即卸载（PartState 联合类型需
    type guard 收窄 toolName）。composer 工具栏按官方 anatomy 修正：
    **左侧仅附件**，模型触发器/语音/上下文/发送在右侧 actions 组。
    实测：300ms 思考行、2.2s "正在使用 mock_search"+耗时、4.7s 正文后
    消失；Reasoning 折叠与 ToolGroup "1 tool call" 折叠渲染 ✓。
  - **elements 全量落盘**（用户 2026-09-29 指令："按网站 elements 目录
    补齐，所有的组件"）：官网 /elements 目录共 **119 个**，除此前已装的
    15 个外，**113 个全部从官方 registry 批量拉取落盘**
    src/components/assistant-ui/elements/（方法：registry JSON 的
    files[].content 自带源码，BFS registryDependencies 闭包并发抓取 +
    按 path 落盘，无需逐个跑 CLI）。**命名陷阱**：不少元素 registry 名
    ≠ 官网 slug（composer-attachments→elements-composer、
    composer-model-picker→elements-model-picker、composer-voice→voice、
    thread-list-sidebar→threadlist-sidebar），404 的先从官网文档页抓
    @assistant-ui/elements-* 真名再拉。**缺货定论**：geo-map /
    image-gallery / link-preview / media-player / option-list /
    question-flow / orb 七个 registry 全 404（CLI 新旧版同样 404、
    registry.json 156 条目无对应、官网页面也无源码块）——**文档已发布
    但 registry 未发布**，等上游。连带落盘：shadcn ui 原语
    badge/label/separator/resizable/sheet/sidebar、icons/github.tsx、
    use-mobile hook、utils/range.ts；tailwind.css 补 sidebar 令牌组。
    新依赖：@assistant-ui/react-generative-ui / react-mcp /
    react-syntax-highlighter / store、@base-ui/react、beautiful-mermaid、
    heat-graph、react-shiki、@types/react-syntax-highlighter、@types/node。
    组件只落盘未接线（接线按需来——多数需要具体数据面）；已接线元素
    （thread/composer/reasoning/tool-group/thinking-indicator 等）以根级
    定制版为准，registry 同名源码并存不覆盖。tsc 0；vitest 21/21；
    推送 5036d45。
  - **pi SDK 集成方案落纸**（用户 2026-09-29 指令：读 G 盘
    pi_agent_rust-main 文档，按 SDK 库集成方式做出落位文档）：新增
    docs/pi-integration.md 为接入规范——集成形态=**库依赖 in-process**
    （pi = { package = "pi_agent_rust" } 进 src-tauri Cargo.toml，
    default-features=false 去 TUI 栈；非 tokio，上游用 asupersync runtime；
    消费 crate 必须 recursion_limit=256）；L3 新模块 pi_session.rs 包
    create_agent_session/prompt_with_abort/set_model 等；事件映射表
    AgentEvent→AG-UI（MessageUpdate.TextDelta→TEXT_MESSAGE_CONTENT、
    TurnEnd.usage→STEP_FINISHED 等）；控制面走 Tauri IPC 十二命令
    （session_*、set_model、get_state、compact、fork…不进 AG-UI）；
    UI 落位=对话区（停止钮/ModelSelector/ContextDisplay/thinking 等级）、
    侧栏（sessions 列表读 pi 会话 header 镜像、tab↔sessionId 绑定、
    logs 吃 on_tool_* 钩子）、设置页（提供方/模型/compaction/工具/技能
    包管理/审批镜像）；数据真相=pi 持对话真相（V1 JSONL→V2 store，分支
    树/compaction 下沉），mirach SQLx 只存 run 边界快照服务 resume；
    extension_ui_handler 必须实现（fail closed）+persist:false、
    workspace_trusted 默认 false 要信任确认框；steer/follow_up
    in-process 缺位→MVP 降级 abort+prompt；七步落地顺序与风险清单见
    文档 §6/§7。
  - **pi 集成文档 v2（吸收 agent-native 架构文档 + 附录 A 清账）**
    （2026-09-29，用户提供了一份更完整的架构文档：workspace 五 crate
    拆分/三通道/ActionRegistry/A2UI/delegate 队列/附录 A 三十项待
    确认，要求对照核实并优化）：docs/pi-integration.md 重写为 v2。
    **源码实锤两处**：①A19——上游 rust-toolchain.toml 钉死
    nightly-2026-08-31，"nightly 隔离在 pi-adapter"成立（v1 的 stable
    说法作废）；②A16——sdk.rs 无 approve/deny，架构文档 §6.1 的
    "session.approve()/deny()"是编造 API，审批回灌唯一正道=
    extension_ui_handler 挂 oneshot（请求→Tauri Event 弹卡→IPC 回→
    resolve→返回 ExtensionUiResponse），fail closed。**其余裁定**：
    A10 清账（AgentEnd 后还有 AutoCompaction*/extension_error，流退出
    以 channel 关闭为准）；依赖图矛盾以"pi-adapter→agent-core"为准；
    事件映射合并为单表（补 TurnEnd→STEP_FINISHED 带 usage）；审批走
    IPC 与 /ag-ui/tool-result（AG-UI frontend tools）是两个机制勿混；
    delegate 队列标注为 mirach 自建设计非 pi 能力；workspace 拆分分
    阶段（先单 crate 模块，nightly 拖累/编译时间/A2UI semver 任一
    出现再拆）；A2UI render_a2ui 拦截+验证失败降级文本照抄；30 项
    附录清掉 13 项（A1-4/7-10/15-17/19/21/27），余项标待确认。提交
    c0c8c27（v1）、本轮 v2。

  - **pi 接线 §7-1/2/3 实施 + E2E 冒烟三修（2026-09-30，提交
    54956cc/380d18a/2be0c62/69e5af2）**：
    - **§7-1**：pi_agent_rust 0.5.1 进 src-tauri（path 依赖
      G:/pi_agent_rust-main，features=["sqlite-sessions"——memory.rs 无条件
      import session_sqlite，不带就 E0432]）+ rust-toolchain.toml 钉
      nightly-2026-08-31 + recursion_limit=256；pi_session.rs：PiRuntime
      （asupersync reactor+RuntimeBuilder::current_thread，Box::leak 成
      &'static）+ PiEngine（Mutex<Option<AgentSessionHandle>> 串行）。
      **SDK 事实**：prompt 是二参 (text, on_event) 直通，无 subscribe 式
      一参 API（wrapper 照签名写，别造）。
    - **§7-2**：agui.rs——axum 双端点（POST /ag-ui 起 run 返回 runId；
      GET /ag-ui/stream 常驻 SSE 唯一消费口，150ms 轮询缓冲放出）+
      per-thread 环形缓冲（seq 单调，cap 2000）+ AgentEvent→AG-UI 映射器
      （ToolExecution*→CUSTOM，AgentStart 不发 RUN_STARTED——POST 处理器
      手动发一次，双发会触发前端交错守卫）。
    - **§7-3**：runtime.tsx（ExternalStore 纯渲染 + EventSource 常驻流，
      断线自动带 Last-Event-ID 重连=免费续放）+ turn-actor.ts（XState v5
      轮次机，reduceAguiEvent 纯函数可单测）。
    - **【E2E 三修，全部实测根因】**：
      ①**pi 深递归爆栈杀进程**（exe "无声死亡"真凶）——create_session/
      prompt 的 future 在 tokio worker（axum）/2MiB 默认栈上 block_on，
      debug 构建下 pi session future 深递归 >2MiB 直接
      "thread has overflowed its stack" 带走整个进程。修法：专用
      Builder::new().stack_size(16MiB) 线程承载（对齐 pi .cargo/config.toml
      的 RUST_MIN_STACK=16777216 教训：MutexGuard 跨 await 非 Send，
      不能挪 reserved thread，只能加大调用线程自己的栈）。
      ②**RUN_STARTED 双发**——POST 手动 push 一次 + AgentStart 映射又
      一次；删映射器分支。
      ③**XState fail-loud 守卫白屏**——streaming 中收到另一 runId 的
      RUN_STARTED 就 throw，但 HTTP 流无连接亲和性：断线重连重放/多 run
      同缓冲是常态（§0.3 交错语义本来接受），throw 杀死整个 React 树
      （实测 reload 后重放缓冲即白屏）。改 console.warn+按新 run 段接受；
      runtime.tsx 加 RuntimeBoundary error boundary 兜底。
    - 冒烟终态（Tauri 窗口 CDP）：POST 200+runId → SSE
      RUN_STARTED→TEXT_MESSAGE_END×2→STEP_FINISHED（无 key 时 RUN_ERROR
      透传 pi 鉴权错误，符合"错误可观测"设计）；UI composer 发送→用户
      消息渲染 ✓；进程存活 ✓；tsc 0。
      **验证方法坑**：会话内后台 spawn 的 exe 会被宿主回收——用
      Start-Process 分离启动；冒烟脚本一律文件日志（appendFileSync）+
      看门狗，CDP Runtime.evaluate 长 awaitPromise 会无声死（改页面内
      fire-and-forget + node 短轮询 window.__probe）。
  - **§7-4 控制面 IPC（2026-09-30，提交 11217a5）**：
    - pi_session.rs 重构 **Arc<EngineShared>**：共享态(handle/abort/runtime)
      全在 Arc 里，16MiB 大栈线程 move Arc、锁在线程内拿——闭包满足
      'static（此前版本闭包借 &self/guard 被 E0521/E0597 全拒）。串行
      不变量不变（std Mutex 排队）。
    - 引擎新增 state/messages/set_model/set_thinking_level/interrupt/
      list_models；**prompt 改走 prompt_with_abort**（AbortHandle 登记，
      pi_interrupt 置信号，prompt 返回即清）。
    - main.rs 六 IPC 命令（§4.5 判据：HTTP 只管事件流）：pi_get_state/
      pi_get_messages/pi_set_model/pi_set_thinking_level/pi_interrupt/
      pi_list_models。
    - composer-wired：ModelSelector 接 **pi_list_models**（只列凭据就绪
      条目=上游 model_entry_is_ready 语义，本机 72 条 bedrock 实测）；
      当前模型 **随 isRunning 变化重拉**（会话按需创建后 trigger 从
      "Select model" 自动点亮真名——挂载时只拉一次会错过）；选模型走
      pi_set_model；onCancel 接 pi_interrupt（composer 停止钮生效）。
    - **稳定面例外记录**：AuthStorage/Config 未进 pi::sdk re-export，
      但 ModelRegistry::load_for_listing（sdk 稳定面）签名要求
      &AuthStorage——走 pub mod（pi::auth/pi::config）是上游 sdk 内部
      同款用法（sdk.rs: AuthStorage::load_async(Config::auth_path())），
      最小例外注释在案。
    - 实测（CDP）：无会话 state 报 "no active session"；models=72；
      POST 后 state 完整快照（sessionId/opus-4/thinkingLevel=high）；
      UI 发消息后 trigger 显示 us.anthropic.claude-opus-4-…-v1:0；
      tsc 0；cargo check 零警告。

  - **  - **  - **  - **  - **代码模式撤回 + 左侧栏回归官方 ThreadList 原语（用户 2026-09-29：
    "代码模式不对，撤回。左侧栏要用它本身原语的方式加，参考 hermes
    样式，但得用 assistant-ui 的组件"）**：①v3.1 的行号代码模式撤回，
    恢复 pre break-all 文本渲染；②**hermes-sessions-pane.tsx（mock）与
    chrome.tsx 删除**——mock 方案违背"用 assistant-ui 组件"的方向；
    注册表 sessions 回指 AssistantSessionsPane（官方 thread-list 元素
    thread-list.aui.tsx，**原语接线零改动**：ThreadListPrimitive.New/
    ItemByIndex、ThreadListItemPrimitive.Root/Trigger/Title/Archive/
    Delete、ThreadListItemMorePrimitive 全保留），只换皮——顶排
    [搜索(flex-1)|新建钮(size-7 边框)]、日期分组 caption+发丝线中文
    （今天/昨天/更早）、行 min-h-9 + 状态点三态（isRunning 绿点脉冲/
    其余灰点；**官方 ThreadListItemState 无 isMain 字段**，选中态靠
    data-active 蓝洗）、行 hover ⋯、More 菜单中文（重命名/归档/删除）、
    空态"没有匹配的会话"。运维坑：vite 死后 taskkill node.exe 会连
    验证脚本一起杀（**只杀 1430 持有 PID**）；官方 state 字段先查类型
    再用（isMain 编译期才暴露）。
预览代码模式 + 图标更换（用户 2026-09-29："文件树看代码没有代码
    模式，选位/折叠图标换掉"）**：①文本预览改**代码模式**——行号列
    （sticky left-0 贴左、横向滚动时行号不动）+ whitespace-pre 不换行
    （长行横向滚动，旧 break-all 换行把代码搅碎）+ min-w-max 撑宽；
    ②选位钮 FolderPlus（读作"新建文件夹"）→ **FolderSearch**（文件夹+
    放大镜=选位置）；③折叠全部钮 ChevronRight → **ChevronsDownUp**
    （双箭头相向=折叠全部的标准形）。CDP 实测：whiteSpace pre ✓、
    ChevronsDownUp/FolderSearch SVG 换装 ✓、行号列渲染 ✓（截图）。
文件树 v3（用户 2026-09-29 四连：预览别切树开右侧栏标签/各类文件
    都能开/地址纯显示+左文件夹钮选位置/刷新旁折叠全部）**：①预览改
    **flexlayout 页签**——点文件经 preview-opener（模块单例解耦）调
    flex-layout 的 openPreviewTab：同 filePath 已开则 selectTab，否则
    Actions.addNode 到 files 同区（**注意 0.11 签名 5 参**：json+tabsetId
    +DockLocation.CENTER+index+select；visitNodes 回调 n 是 Node 需
    as TabNode 收窄才有 getComponent/getConfig）+selectTab；pane-registry
    PaneType 并集加 preview。工厂特例渲染 HermesPreviewPane（config.
    filePath 现读）：图片 img/html **沙箱 iframe sandbox=""**/文本 pre/
    二进制提示。②地址行改版：纯显示（去输入框）+左 FolderPlus 钮
    （tauri-plugin-dialog open({directory:true})——**插件四处**：Cargo
    [dependencies]（**别放 build-deps**，tauri-build 行后面=错误段，能力
    校验报 Permission dialog:default not found）/main.rs .plugin()/caps
    dialog:default/npm 包）+刷新旁折叠全部钮（setOpenDirs({})）。cargo
    check 过；需重启应用（新 exe 才有 dialog 能力）。
文件树 v2（用户 2026-09-29："文件树不能打开文件，每种文件样式
    一样，没有颜色和图标区分"）**：hermes-file-tree-pane 重写——①**类型
    徽章**：FILE_KINDS 表按扩展名族上色（TS 蓝/JS 黄/{} 橄榄/CSS 天蓝/
    <> 橙/MD 蓝紫/RS 橙红/CFG 灰/IMG 紫/LCK），16px 圆角块类型色底+字，
    无族退回灰文件图标；②**文件可打开**：点文件 fs_read_data_url
    （≤16MB）→ [树|预览] 双栏 55/45——图片直接 img、文本 fetch(dataUrl)
    解码 pre 展示、含 \u0000 判二进制提示；预览头部路径+关闭钮。
    CDP 实测：徽章四色抽查 ✓、点 package.json 预览出 JSON 全文 ✓。
    教训：点行定位用 textContent===文件名会因徽章字混入失效（v2 按钮
    内含 "{}" 等徽章文本），测试选择器要按结构找。
hermes 侧栏/文件树视觉移植（用户 2026-09-29："左侧栏的会话，项目，
    能用 hermes 的 ui 样式吗？还有文件树，纯 ui 前端可以直接复制"）**：
    依赖分类结论——hermes 的 sessions-section/session-row/project-*/
    file-tree 全部长在 nanostores store 网+@hermes 类型+网关 RPC 上
    （session-row 一个文件 import 10+ store），**不是纯 UI**，逐字复制
    必然断链。做法=**复制视觉结构与类名**（chrome.tsx 的行几何体系、
    日期分桶分隔条、项目色点概览、文件树 chevron 缩进），数据本地 mock，
    令牌换 harness 体系（--ui-* → --text/--stroke/--hover-wash）。落位
    src/components/panes/hermes-sidebar/：chrome.tsx（行外壳/分隔条/
    区块头共享件）+ hermes-sessions-pane.tsx（项目概览 Home+色点项目行
    +今天/昨天/上周分桶+状态点行+搜索）+ hermes-file-tree-pane.tsx
    （后端=本 harness fs_list，与 hermes useProjectTree 的 ipc
    readProjectDir 同构；懒展开+路径行+刷新）。注册表：sessions→
    HermesSessionsPane、files→HermesFileTreePane（AssistantSessionsPane/
    FileTreePane 保留在树未删）。CDP 截图确认全量渲染。
    待接真数据：行点击→resume 会话、⋯菜单、项目进入、文件点击预览
    （fs_read_data_url）、dnd-kit 排序（未搬）。
  - **页签文字统一沉条底 + stretch 文字区判定 + 虚线预览边（用户
    2026-09-29 三连）**：①拖拽落点 sheet 的深蓝边线改虚线
    （.fl-drop-sheet-active border-style:dashed，预览感不与真实边界
    混淆）；②拉伸头栏只有**文字标签区**（content rect ±8px）归页签
    拖拽，标签左右空白归窗口拖动（window 捕获段判定：stretch 按
    .flexlayout__tab_button_content rect 落穿，多页签整钮照旧）——
    实测右侧空白按下拖动 __flDragLog 全空（窗口路径）、文字区 engage
    正常；③**页签文字统一沉条底**（用户："下面分栏的标签跑顶部去了，
    在上面的时候明明在底部；关闭机器人后会话列表标签自己上移"）：
    (a) stretch 头栏 padding-bottom 10px → 0——旧值把 stretch 文字抬
    高 10px，与普通页签（沉条底 y80-101）错位，**单页签化瞬间标签上
    跳 10px**（左栏关签后标签上移的根因）；(b) fl-strip-low 低条容器
    align-items center → flex-end——下分栏 36px 条文字沉底（旧 center
    悬中视觉跑顶）。终态实测全量页签 textGapBottom=0（顶带/低条、
    stretch/普通完全同位，开关页签零跳位）。
  - **【bug】--accent 令牌冲突=落点预览隐形的真凶（用户 2026-09-29
    二次报告"还是不行，是不是 assistant-ui 容器叠加"）**：CDP 实测
    （elementFromPoint 逐点命中 + Input.dispatchMouseEvent 真实指针拖拽
    + 拖拽中截图）洗清了两个怀疑：①页签头命中面干净——拉伸头栏 5 采样
    点最顶层全是页签按钮本身，aui 容器无一叠加在条带上（composer 在
    pane 内部 y721）；②拖拽机制全通——撕离/zone 模式/4 张 sheet 全渲染、
    Esc 干净中止。**真凶**：main.tsx 里 tailwind.css（shadcn 主题）import
    在 tokens.css 之后，其 :root --accent: oklch(0.97 0 0)（近白）覆盖了
    tokens.css 的品牌蓝——落点 sheet/编辑 veil/分隔条 hover 的
    color-mix(var(--accent)…) 全部静默变灰白，白上画白=看不见。
    **修法（命名空间分家）**：布局引擎令牌换名 --accent → --fl-accent
    （tokens.css 定义 + overlays/editor 10 处引用 + splitter hover/drag
    2 处），shadcn 的 --accent 留给 CLI 组件（bg-accent 等工具类经
    --color-accent 映射不受影响）；styles 层 var(--accent) 零残留。
    修后实测：active sheet bg=浅蓝洗、border=#006fff@75%，截图确认可见。
    **教训**：引入第二套主题令牌体系（shadcn/tailwind）时必须查与
    tokens.css 的 :root 键名冲突——两边都定义 --accent，import 顺序决定
    胜者，静默失败无报错。另：主会话页签在 y499，从不在旧盖层（0-60）
    覆盖范围；"拖整个页面"报告极可能叠加了 vite 陈旧模块缓存（改码后
    行为不变的已知坑），CDP Page.reload 后实测拖拽即正常。

  - **【bug】拖拽带截胡页签头（用户 2026-09-29：标签拖拽出来被挡住
    看不到落在哪 + 主对话标签拖的是整个页面）**：根因一个——
    .titlebar-drag-band（0-60px 绝对定位盖层 z40）盖住了顶带的**页签头**。
    顶带即页签条（tabbar_outer 高 100=--logo-strip-h，页签沉底 y≈60-95，
    上部是 logo 空白）；多页签条的上部空白归拖拽带没问题，但**拉伸头栏
    （SingleTabStretch 单页签 zone，如主对话）的按钮整条 100px 都是页签**
    ——上部 60px 被盖层截胡，按下命中的是盖层、事件到不了
    flexlayout-host（onPointerDownCapture 收不到），于是变拖窗口（拖整
    个页面）+ 拖拽会话/ghost/zone 落点预览全不启动（看不到落在哪）。
    左栏页签在 y64+ 不受影响，所以只在主对话发现。**修法（语义定稿：有
    页签的地方拖页签，没页签的空白拖窗口）**：删盖层元素与 CSS；改
    window 捕获段 pointerdown 判定——clientY≤100 且 target 命中
    tabbar_outer/app-shell 空白（排除 button/input/[id^=flexlayout-
    tabbutton-]/splitter/overflow-btn/.win-resize-handle/.fl-min|close|home-btn/
    ep-*/ze-*）才 startDragging（detail===2 双击最大化）；拉伸头栏与
    普通页签同 id 前缀（flexlayout 源码 domId 实证），归宿主接管拖页签。
    resize 手柄补 .win-resize-handle 类。tsc 0；vitest 21/21。

  - **关闭钮统一**（用户 2026-09-27：图标统一/样式走令牌/仅悬停显形，
    撤销 2026-09-26"离家 ✕ 常显"）：①codicons 新增 CloseIcon（codicon
    close path）；②原生 trailing 经 **Layout 的 icons={{close}}** 注入
    同一图标；③拉伸头栏 ✕/回家钮与竖轨行 ✕ 换 CloseIcon、类统一
    **fl-close-btn**（不再挂 fl-min-btn，那套 20px 盒留给条尾工具钮）；
    ④令牌 --tab-close-size:12px / --tab-close-hit:16px /
    --tab-close-color:text-3 / --tab-close-color-hover:品牌色；⑤显隐：
    悬停**所在页签/行**才出现——flexlayout 默认让选中页签 trailing 常显，
    已 CSS 压成 hover 才显；fl-tab-away 类保留但只作语义标记（CSS 常显
    规则删除）。实测：native trailing CloseIcon+hidden、stretch/竖轨钮
    opacity 0、hover 规则在案、截图无任何常显 ✕。
  - **【工程修复】行节点聚合上限缺陷（用户 2026-09-27："下面一栏上面两栏
    拖宽度能多拉、松手弹回——结构性弱点要从底层解决，补的不对"）**：
    根因在 flexlayout 0.11.1 库内——RowNode.calcMinMaxSize 的沿轴 max
    聚合从 DefaultMax(99999) **起算**再累加子项（ HORZ 行 maxW =
    99999+Σ、VERT 行 maxH 同病），运行时实证：内行 maxW=100840、
    spl-root=300419——行节点永远无有效上限 → calculateSplit 对被拖行
    子项的自钳失效 → 拖拽越过聚合上限渲染（flexbox 归一化）→ 松手被
    absorb 按正确聚合钳回（=弹回）。此前纯钳制/water-fill 都是在我方
    钳制器里打补丁，错层。**修复 = flexlayout-rowfix.ts**：运行时按
    官方语义重写 RowNode.calcMinMaxSize（沿轴 Σ 从 0 起算、跨轴
    MAX(min)/MIN(max) 首项直赋、末尾 max≥min 收口；node_modules 的
    dist 手工补丁已还原，patch-package 因环境 npm install-scripts 受限
    + 临时安装失败不可用）。修复后行节点获得真实聚合上限：DOM 内联
    max-width 硬钳（flexbox 层）、getSplitterBounds/calculateSplit
    原生钳拖拽、clampRowWeights 退化为非拖拽路径保险网（water-fill
    已回退为纯钳制）。另加调试句柄 window.__flModel（活动 Model）。
    实测（CDP，拖拽中+松手后三个时间点）：行 maxW 99999→841、拖拽中
    几何即钳制目标（420/420/841、主栏 605 吃富余）、松手稳定无弹回、
    默认布局无挤压。升级 flexlayout 先核对上游是否已修，已修则删除
    flexlayout-rowfix.ts。
  - **单测基建**（2026-09-27，UI 阶段前置）：vitest 4.1.10 + vitest
    .config.ts（node 环境、@ 别名）+ vitest.setup.ts（localStorage Map
    替身）。constraints(14)/flexlayout-rowfix(3)/pane-registry(4) 全绿；
    npm test / npm run test:watch。假节点 = Object.create(真原型)+自有
    字段（instanceof 真实、行为可控）。
  - **2026-09-27 二轮（窗口外框交互：拖拽区/图标闪/resize 手柄）**：
    1. **四周 resize 手柄无反应**：capabilities 里**没有
       allow-start-resize-dragging**（上轮说加了、实际没落盘）——
       startResizeDragging 被拒且 .catch 吞掉。已补；caps 编译进 exe，
       须重启应用（实测 invoke DENIED→OK）。
    2. **标题栏图标悬停闪**：tb-drag-strip（absolute 0-36）盖住按钮
       （y 4-28）——hover 命中在拖拽带上反复横跳。修：标题栏按钮
       relative 提升到拖拽带之上。
    3. **拖拽区覆盖 100px 条带**：tb-drag-strip（36）换成
       titlebar-drag-band（0-60、z 40，flex-layout 渲染、仅 Tauri）：
       pointerdown → startDragging（双击=最大化）。不走
       data-tauri-drag-region（页签按钮盖满条带且我方引擎 preventDefault
       pointerdown，原生拖拽区脚本收不到 mousedown）。z 40 在 flexlayout
       内容之上、标题栏按钮(50 容器)与手柄(300)之下；页签行(60-95)与
       条尾工具钮不受影响。实测：真点击标题栏按钮打开布局编辑器 ✓。

## 有意不做的 / 有意的偏差（全部有注释在代码里）

- **README.md 是上一轮（mock 静态版）的文档，已过时**——以本文件为准，
  有空再重写。
- `src/api/` 保持 hermes 原样（指向 gateway）——2026-09-24 定稿后新栈不再
  消费它，整个 hermes `src/` 降级为参考实现/素材库（照抄来源），不再接线。
- 仓库根有个 3 文件的 `electron/` 目录：`command-screenshot-types.ts`、
  `notification-types.ts`、`pool-limits.ts`——hermes renderer 逐字引用的
  **纯类型/纯函数文件**（零 import），路径 `../electron/...` 必须存在。
  `electron/command-screenshot.ts` 等真主进程模块**没有**复制。
- `tests/fixtures/session-resume-active-turn.json` 同理（hermes 仓库级
  fixtures，被 `use-session-actions.test.tsx` 引用，路径改为 4 个 `..`）。
- `i18n/context.test.tsx` 删了 zh-hant/ja 两个加载用例、RTL 用例；
  `runtime.test.ts`/`plugin-i18n.test.tsx`/`bot-row.test.tsx` 等把
  ja/zh-hant 样本换成 zh——意图不变。
- hermes 的 `electron/`、`e2e/`、`scripts/`、playwright、tsconfig.electron
  均未复制（Tauri 壳已替代或不需要）。

## 已知的环境陷阱

- **dev 模式的"慢"是编译位置问题**：设置页是动态 import（115 文件 /
  ~1.1MB 源码），vite 按需编译 → 每次重启后**第一次**打开要现场转换整个
  子图（数十秒，React-Compiler 的 babel pass 会放大每个文件的成本），
  之后 ~300ms。vite.config 已配 `server.warmup` 预热设置图（后台转换）。
  官方 hermes 同样慢，且它的 Python 后端还要做 skill 树遍历之类的数据
  探测——MIRACH 无此问题。**打包后（tauri build）这些全部消失**（chunk 预构建）。
- **临时产物不要写进仓库根**：见规矩 10b（vite watch 会整页 reload）。
- C 盘曾被 `.zcode/cli/rollout/` 打满：满了删 `model-io-sess_subagent_*.jsonl`
  （**不要删当前会话的**）。
- npm 的 optional dependency bug（`lightningcss-win32-x64-msvc` 等）复现过
  两次：`npm i <那个平台包>`。
- tsc 跑全仓 ~20s，vitest 全量 ~14min——改一两个文件时只跑目标测试文件。
- **技术栈**：TypeScript（React renderer）+ Rust（Tauri 壳 + 未来的 pi
  engine），**没有 Python**——hermes 官方的 Python 后端从未复制；源码里
  50 处 "python" 字样只是文案/类型引用，node_modules 里 5 个 .py 是 katex
  的构建期脚本。

## 架构

见上"待办 3"与 README 的历史背景。要点：组件与 store 全保留；
被替换的只有传输层（api/gateway → Rust 命令 → pi agent rust SDK）。
`src-tauri/src/lib.rs` 里 HUD / quick-entry / fs 的命令面已经完整，
注释里有全部踩坑记录（WebView2 环境单例、DWM 线框、停车 vs 销毁…），
动 Rust 之前先读。

## 生产就绪收口轮（2026-10-01，全量审查驱动，子代理执行）

四域审查（Rust/聊天链路/布局/完成度盘点）后的一轮修复。审查结论「内测级」，
本轮清掉 3 个 P0 + 10 个 P1 + 全部低成本 P2，测试 30→77（TS）+ 30（Rust）。

### Rust 安全与正确性（agui.rs / pi_session.rs / main.rs / tauri.conf.json）
- **P0 鉴权**：GET /ag-ui/stream 加 token 校验（此前 POST 有校验、数据出口裸奔）；
  very_permissive CORS → 显式白名单（tauri.localhost/tauri://localhost/dev 1430）
  + Host 校验中间件（127.0.0.1:{port}/localhost:{port}，否则 403——DNS rebinding
  防线）；生产 CSP 进 tauri.conf（dev 不注入）。
- **P0 SSE 重连全量重放**（双代理独立发现的头号 bug）：EventSource 原生重连
  复用挂载 URL 的陈旧 query → 服务端从挂载游标重放全部缓冲 → 消息整段重复。
  修法：服务端 cursor 优先取标准 `Last-Event-ID` 头，与 query 取 max。
- **交付面**：bundle.active:true + targets:["nsis"]；`tauri.prod.conf.json`
  （`npm run tauri:build`）剥 CDP 9223——**坑：--config 是 RFC 7386 合并，数组
  整体替换，app.windows 必须带完整窗口对象，只写 additionalBrowserArgs 会抹掉
  width/height**；`additionalBrowserArgs:""` 空串剥参（null 是删键）。
- **主线程冻结**：全部 pi_* 命令 `#[tauri::command(async)]`（同步 fn 加此参走
  线程池；**实际是 14 个 pi_*，不是 16**）——此前流式期间调 pi_get_state 等
  会冻住 tao 事件循环整个 run（pi_list_sessions 撞 stale lock 可冻 15s）。
- **abort 竞态**：AbortSlot{run,handle}+run_counter，PromptGuard Drop 身份比对
  （不匹配不清）；abort 注册挪到拿 handle mutex 之后。RUN_STARTED 移入
  on_start 回调（Box<dyn FnOnce>，拿锁后起跑前）——排队 run 不再提前入缓冲
  （§0.3-1 协议违例序列不再由后端制造）。
- **审批清账**：respond 的 oneshot send 失败返回 Err（含 id，不再假装成功）；
  ApprovalRegistry::cleanup 在 discard/open 会话时清空（registry 所有权移到
  PiEngine，AguiState 共享同一 Arc）；ensure_session 失败只推 RUN_ERROR
  （不再先推无 runId 的 RUN_STARTED 留空消息段）。

### 聊天链路（turn-actor / runtime / thread.aui / composer-wired 等）
- **RUN_ERROR 可见**：error-bridge（zustand）+ thread.aui RunErrorBar——此前
  error 存进机器 context 全工程零消费，run 失败界面零反馈。
- **SSE 断开可见**：connection-store + ConnectionBanner（null≠断开防启动误报）。
- **交错 RUN_STARTED**：console.error 协议违例 + reduce 追加新段（此前 targetless
  transition 只 warn，delta 会并进旧消息）。
- **run 外守卫**：TEXT/TOOL_CALL/THINKING/tool_execution 在 currentRunId===null
  时 drop+warn；compaction 等 run 外 CUSTOM 照常透传（§0.3-5）。
- **铁律三处**：hydrate catch 区分 "no active session" 域态（正常置 null）与真
  错误（console.error 保持状态）；postRun 查 res.ok（401 时消息上屏无回复的
  根因）；挂载 effect 每个 await 后查 cancelled（StrictMode 泄漏）。
- **流式中切换会话**：先 pi_interrupt 再切（prompt 持锁跨整个 run，切换会挂到
  run 结束）；onDelete 命中当前会话 → discard+RESET（此前删了文件机器还拿着
  旧 handle）。switchToThread/onDelete/rename 全补 try/catch（失败不改本地态）。
- **thinking 渲染接通**：TurnPart 加 {type:'thinking'}（THINKING_* 三分支），
  **出口 convertMessage 必须映射成 "reasoning"**（ThreadMessageLike 形状，
  类型错误就在这）；历史水合的 thinking 块仍 MVP 不渲染。
- **effort 档位接线**（此前断链）：onEffortChange → pi_set_thinking_level(level)
  → pi_get_state 回读成功才写本地态（禁乐观更新；ModelSelector effort 传空串
  保持受控）。除零红环（contextWindow<=0 不渲染 Bar）、Esc 关菜单 setState、
  审批卡 respond 失败也 refresh 一并修。

### 布局引擎（对照 layout-design.md v3.1）
- **拉伸头栏死钮**：onHostPointerDown 白名单缺 `.fl-close-btn`——可关窗格独占
  zone 时 ✕ 被 pointer 接管吞掉（同类坑第三次：fl-restore-btn/fl-home-btn
  都修过，这个 2026-09-27 新增时漏了）。**规矩：注入页签按钮必须进白名单**。
- **列 identity 四步优先级**（§2.1）：config 戳 → primary 家乡锚定 → 邻居传播
  （仅无 primary 列）→ main；dropBlock 预戳仅当投放内容无 primary 或 region
  一致——此前邻居传播先跑，主会话拖到左栏旁会被永久戳成 left（420 钳死）。
- **narrowViewport 单写者**：删 layout-store 的 matchMedia(640)（与 rebalance
  动态判据打架，窄窗收/展横跳）；boot 由 updateNarrowViewport 写初值。
- **浮动隔离**：sync/onAction 对 getLayoutId()!==Model.MAIN_LAYOUT_ID 跳过/放行
  （此前浮动 tabset 被推 minWidth 395、浮窗一级 ✕ 被拦——§12 待核查项落地）。
- **absorbSurplus 真 bug（测试探出）**：无主栏回退路径里吸收者份额已计入 rest
  扣减、槽位又被覆写为 rest → 行内留白（差值=吸收者原宽）。修法与
  applyRootWeights 同构（rest += 归还份额）。**单测第一次抓住几何真 bug**。
- 其余：主栏回家链①（最后一个 left 列右缘）；applyRootWeights 下限读实际生效
  minWidth（不再顶回缩让）；appliedTree/activePresetId 持久化（新键
  `mirach.harness.layout.applied.v1`）；REGION_LIMITS 单源化（删 presets 死副本）；
  pointercancel 兜底（分隔条拖拽被系统打断后重排通道饿死）；100px 避让带
  令牌化（flexlayout.css×2 + base.css 标题栏 height）；空 catch → console.error。

### 设置页 §7-7（pi_settings.rs + settings-overlay.tsx）
- 5 命令：pi_get/set_settings、pi_get/set_models_config（**整体替换写入**、
  写前反序列化进 pi 的 Config/ModelsConfig 校验——坏文档不落盘）、
  pi_auth_status（只报存在性绝不回 key 内容；坏 auth.json 如实报错——
  不用 AuthStorage::load，它对损坏 JSON 静默回空目录）。
- **pi 配置面实锤（源码核实）**：settings.json=~/.pi/agent/settings.json
  （PI_CONFIG_PATH 可整体覆盖；**serde 写 snake_case、读 camelCase alias**
  ——手写键名注意）；默认模型键=default_provider/default_model；
  models.json providers map（凭据引用四种：!命令/env:VAR/file:/裸大写名）；
  auth.json type tag（api_key/oauth/aws_credentials/bearer_token/service_key）。
- **UI 坑**：设置浮层必须 portal 到 body（标题栏 z-50 是 stacking context，
  组件树内渲染会被 veil(55)/投放(60) 压住）；Esc 走 escape-layers overlay 层。

### 死代码清理 + pi vendored
- **删 119 文件 / 16,474 行**：elements/ 108 个脚手架副本（活文件仅 10 个）、
  ui/ 6 个 shadcn 未用原语、顶层 reasoning.tsx 重复、lib/storage、use-mobile、
  icons/github、panes/logs-pane。方法：从 main.tsx 的 import 可达性 BFS
  （脚本在 %TEMP%，**不进仓库根**——vite watch 着）。**坑：清理连带删了 15 个
  空骨架目录，已 .gitkeep 重建**（git 不跟踪空目录，骨架位靠 .gitkeep 存活）。
- **【2026-10-02 定性纠正 + 全量恢复（用户定稿）】**：elements/ 的 108 个
  **不是死代码**——是官方 assistant-ui elements 库的未接线模板（官方默认件
  = 最小演示，落地靠「拷入 → 写 .aui 连接版 → 扩展」），已全量恢复进树当
  元件库，连带恢复其 shadcn 依赖（ui/{badge,label,resizable,separator,sheet,
  sidebar}、icons/github、hooks/use-mobile）。恢复源=提交 4193a4d。两条教训：
  ①**定性教训**——「未被 import」≠「可删」：元件库模板、官方示例这类
  待接线资产，删除前先问定性；②**提交卫生**——聊天链路提交
  `git add src/components/assistant-ui` 曾把 elements/ 的删除**连带暂存**
  （elements/ 在该路径前缀下），分组提交时路径过宽会吞无关变更，
  删除类变更必须与代码变更分开提交。
- **pi vendored**：`src-tauri/vendor/pi_agent_rust`（255MB→22MB 白名单拷贝：
  src/examples/benches/themes/Cargo.toml/build.rs/CHANGELOG + build.rs 嵌入资源
  4 件 + legacy models.generated.ts；tests/ 187MB 安全排除——path 依赖不编译
  其 test targets）。**坑：cmd 里 `if exist X rmdir Y & robocopy Z` 会把整条
  & 链当 if 语句体**（目录不存在=整链跳过，看似成功实则没跑）。上游同步
  流程：重拷 + 核对**两个 vendor 本地补丁**：①session_index.rs:778 的
  .read(true)（gh #239 同款）；②**push-protection 脱敏**——auth.rs 的
  Google Gemini CLI/Antigravity OAuth client id/secret 四常量 +
  secrets.rs 夹具表 google/slack 假字面量，替换为 MIRACH-VENDOR-REDACTED
  （均为上游公开 installed-app 元数据/明显假夹具，上游带 ubs:ignore 注释；
  GitHub Push Protection 不认，首次推送被 GH013 拦截后就地占位化——
  上游真源 G:\pi_agent_rust-main 不动）。

### 测试与文档同步
- TS 77 用例（新增 rebalance.test 25 / constraints-sync.test 9 / turn-actor+13）；
  Rust 30 用例（agui.rs 内嵌首个 src-tauri 测试：映射器逐行/缓冲 seq 从 1
  monotonic/cap 淘汰连续性/审批 respond+cleanup）。
- **spec-debt（测试钉住的翻转点，非 bug）**：MessageUpdate 的 *_START/*_END
  未映射（前端无分支，无影响）；TurnEnd→STEP_FINISHED 未实现——usage 实际随
  RUN_FINISHED 下发且前端只消费它（pi-integration.md §2.2 该行已改注）。
- layout-design.md §5「离家 ✕ 常显」已按 §4.1 定稿改注（撤销常显）。

## elements 接线轮（2026-10-02，pi 支持面全接）

用户定稿「恢复后看 pi 支持哪些，支持的都接上」。两轮调查（elements 118 文件
分类矩阵 + pi 能力面实锤）后五批代理落地：Rust 桥接、前端 elements、fork
调查、fork 四命令、fork 前端。测试 77→105（TS）+ 30→39（Rust）。

### pi 能力面实锤（修正了三个旧错误认知）
- **pi 消息有 timestamp（i64 毫秒）**——runtime.tsx:118 旧注释「无 id/
  timestamp」是错的（id 无、timestamp 有，model.rs:106），day-separator
  因此可接。
- **每条 assistant 消息自带 usage.cost（美元）**（model.rs:384-397）——
  RUN_FINISHED.usage 补 costUsd（run 内全部 assistant 消息 cost.total 加和）
  与 cacheWriteTokens。
- **fork/分支原语全 pub**（照抄 TUI）：plan_fork_from_user_message（**实际
  签名是 Result<ForkPlan> 不是调查初判的 Option**）→ create_with_dir →
  header 直写 branchedFrom → init_from_fork_plan（**历史批量注入唯一正确
  入口**，直写 entries 会破坏缓存）→ save → 复用 open_session 换装。分支
  切换 = tree_ui 的 stage_and_commit 配方（clone→navigate_to→save→
  to_messages_for_current_path→replace_messages）。**Agent 只是投影，改
  历史必须走 Session**（rpc.rs:303-308）。分支 preview=**离根最近**的 user
  文本（path_preview 逐条覆盖，不是离叶最近——单测抓到的上游行为细节）。
  上游 fork 语义：选中 user 消息**不进**新文件（叶停其父级），selectedText
  供 composer 预填、重新提交成新分支。RPC 面 37 命令**没有**分支切换——
  BranchPicker 只在 in-process 可做（rpc_subprocess 反而拿不到）。

### 新增 8 个 IPC 命令 + 图片契约
- `pi_retry_edit`（prepare_retry_branch，返回 {text, abandonedEntryId}；
  下一次 POST = 兄弟分支，旧分支保留在同一 JSONL）/
  `pi_mark_checkpoint`（**手工带回 entryId——Checkpoint.entry_id 被 serde
  skip，直接序列化会丢**）/ `pi_list_checkpoints`（枚举 JSONL Custom 条目，
  上游只有按名查找无枚举）/ `pi_rewind`（摘要失败 Err 传播——有意分歧自
  上游的降级文本，禁兜底）。
- `pi_fork_session(entryId)`（大栈闭包内 Phase1+2 合并免 pi 结构跨线程
  Send；Phase 3 复用 open_session 换装链）/ `pi_get_fork_points` /
  `pi_list_sibling_branches` / `pi_switch_branch`（leafId）。
- 图片：POST body `images:[{data /*纯base64*/, mimeType}]`，白名单
  png/jpeg/webp/gif 外 400；带图走 `run_with_content_with_abort`（SDK 无
  内容块 prompt 包装，message_*/tool_execution_* 扩展扇出缺席=上游注释明示
  受支持的形态，注释在 pi_session.rs:748-756）。

### 前端接线（全部真实挂载，冒烟截图确认）
- runtime：onEdit/onReload（isRunning 先 interrupt → pi_retry_edit →
  postRun；parentId 只支持最后一条 user 消息——诚实拒绝）、postRun images、
  attachments adapter（**此前缺失——附件按钮点击直接抛 "Attachments are
  not supported"**）、hydrate 时间戳+历史 image 块（契约形
  `{type:'image', data, mimeType}`，与 pi_get_messages 序列化对齐一处）。
- 挂载 12 件：tool-call 结构化（默认）/terminal-block（bash）/web-search
  （web_search，严格解析不符回退通用）/tool-error/message-actions（复制+
  regenerate 复用 reload 通道）/message-timing（run 级 usage+costUsd，仅
  最后一条 assistant）/day-separator（createdAt 日期）/error-state（替换
  RunErrorBar 内部，带 Retry）/stopped-run/connection-state（四相，替换
  ConnectionBanner）/empty-state（Welcome 槽，中文起步语）/guardrail-notice
  （压缩横幅，吃 compaction CUSTOM）。
- fork 入口（user 消息「从此分支探索」，GitBranch 图标）+ BranchPicker 条
  （message-branches 真数据）+ branch-store.ts（投影/刷新信号/请求通道/
  composer 预填）。fork 点 entryId 用 **index 映射**（thread 第 N 条 user
  消息=pi_get_fork_points 第 N 项）+ 钮级文本预判 + 执行级复核双重防漂移。

### 官方模板的坑（接线时逐个撞上）
- **day-separator 是自带迷你消息列表的整块演示组件**——嵌不进真实消息循环，
  只能提取分隔行喂 DatedMessage 形状。EmptyStateComposer 纯展示无输入框。
  guardrail-notice 无 errorMessage 槽位（宿主补一行红字）。message-branches
  是纯 props 模板（好用）。
- StartRunConfig **没有 modelOverride**（实际 {parentId, sourceId,
  runConfig.custom}）——onReload 两处探测兼容。
- 100/118 模板是纯 props 驱动（不用 assistant-ui 钩子）——接线=喂 props。

### 验证
- 门禁：tsc 0 / vitest **105**（branch-store 15 新用例）/ cargo check 净 /
  cargo test **39**（映射器 4 + fork 5 新用例）。
- 真窗口冒烟（CDP）：UI 发送→RUN_ERROR 条；**fork 真通**（新会话文件+
  sessionId+composer 预填）；retry_edit→POST→**sibling_branches 真树**
  （双分支+isCurrent+forkPointId）；坏 mime **400**；1×1 png POST **200+
  runId**；截图见 BranchPicker「‹ 2/2 ›」+ 日期分隔行 + 图片消息渲染 +
  新错误卡。**注意：直连 POST 的 token 走 query 参数，Authorization 头
  不认（冒烟脚本第一版踩的 401 就是这个）**。
- 代理卫生：仓库根出现碎片文件 `fn`（grep 重定向事故）——代理跑
  findstr/grep 重定向一律指向 %TEMP%，不进仓库根。

## 会话管理/对标轮（2026-10-02 续：ZCode+hermes 双参考落地）

用户指令「全部按你说的做」。五批代理 + 宿主修复，测试 105→221（TS）+
39（Rust）。上游 pi 实锤与 FR 清单见 `docs/upstream-feature-requests.md`。

### 上游 pi 实锤（修正认知）
- **上游真仓库 = Dicklesworthstone/pi_agent_rust**（Cargo.toml repository；
  badlogic/pi-mono 是 TS 版另一生态，别查错）。最新 **v0.6.1**：**SDK 已加
  live steering/follow-up/abort within a turn + turn-wide deadlines**
  （旧结论"in-process 无 steer/follow_up"是 0.5.1 时代事实，升级即得）；
  **Windows 保存 Access denied 已修**（= 我们的 session_index 补丁，升级
  退休）；citations / UI hostcall select-input schema / SDK 层自动命名
  **仍无**（FR 清单已建）。
- **pi Config 本来就有**：`titling.auto_title`（bool 默认 true）、
  `steering_mode`/`follow_up_mode`（枚举 one-at-a-time）、
  `approval.mode`（always-ask/write/yolo）——自动命名与排队必须对齐这些
  键，别自造开关。`system_prompt`/`enabled_tools` **不在 Config**（CLI/
  SDK 参数），settings.json 无法表达，别造 UI。
- **自动命名机制在 TUI 层**（interactive/agent.rs:1189，首轮后小模型要
  名字、手动优先、fire-and-forget）——宿主自实现语义即可（已做规则段）。
- **pi 分支模型 = user turn 续接线**：prepare_retry_branch 把叶移到
  user turn 父级，重发是**新 user 消息兄弟**（每条分支以各自 user 消息
  开头）——不是"同一 user 的多个 assistant 回复"。变体条锚点 =
  **分叉点 user 消息**（踩过：挂 assistant footer 永不命中）。
- **pi_open_session 返回模型条目串**（"amazon-bedrock/…"）不是
  sessionId——按路径切换后 sessionId 从 pi_get_state 取。

### 本轮落地（全部真实鼠标冒烟确认）
- **侧栏会话管理**：置顶（`mirach.harness.sessions.pinned.v1`，置顶组
  标签+图钉，组内 lastActive 降序）、指针拖拽排序
  （`mirach.harness.sessions.order.v1`，插入符预览，mergeFreshByPosition：
  新会话不沉底旧页不跳顶）、拖到主会话标签切换（命中
  `#flexlayout-tabbutton-workspace`，走 aui threads.switchToThread 既有
  通道——**零 runtime 改动**）、行菜单（fork 非活动行禁用；移除 archive
  死钮）。prune 守卫：列表非空才清持久化（首帧空=未加载）。谱系树嵌套
  **跳过**（list_sessions 无 branchedFrom 字段——Rust 待办：透出后接
  hermes session-branch-tree.ts 语义）。
- **设置页扩展**：压缩（enabled/reserve_tokens/keep_recent_tokens/mode +
  顶层 compaction_mode）与重试（六控件）结构化段；**串行写队列**（Tauri
  async 命令落盘不保序）；snake_case 写回（camelCase 是读取别名，写错键
  静默失效——Config 无 deny_unknown_fields）；文档已有别名形式原地更新
  防双键并存；「高级」段有未保存手改时拒绝结构化写。
- **runtime 性能**：stabilizeMessages（引用相等=未变——零变化重建返回
  prev 数组本身，命中 ExternalStore 快速通道跳过全量转换；有测试的不变
  式而非实现巧合）；滚动位置按会话持久化（thread-scroll-store LRU-50，
  offset 存**距底距离**；视口接线在 thread.aui ThreadRoot：恢复 'instant'
  防长会话动画、采样 300ms 节流）；自动命名规则段（derive_title 48 字符
  词边界截断 + 撞名 #N 取最大号+1 + auto_title 配置门 + 默认态判定=
  list_sessions name null；**pi_open_session 返回模型串的坑在此修复**）。
- **ZCode 构图审计快赢**：user 消息 hover 条补复制（copied 1.5s 复位）、
  assistant footer 补时间戳（createdAt→Intl HH:mm）。审计结论：构图基本
  一致、多处超集（日期分隔/RunTiming/run 级 Retry/断连四相 ZCode 都没有）。
- **文件树**：ZCode workspace-file-tree 16 文件照抄（虚拟化自写等价替
  换 @tanstack/react-virtual——不引新依赖；吸顶/空目录链压缩 a/b/c/软链
  接豁免），fs.rs 加 is_symlink（junction 指向祖先会无限递归 fs_list），
  预览通道复用；git 状态/watcher/搜索无 IPC 未随（头注释在案）。
- **变体条**：MessageVariantPicker 挂 user 消息 footer（分叉点 entryId
  经 forkPoints 序号映射比对 forkPointId；2/2 切换真鼠标实测通过）。
- **全局原语样式**：ui-primitives.css（hermes 滚动条三段 CSS：平时隐形
  hover 18%/40%；--shadow-dialog 四段阴影；--z-modal 令牌；Chromium 121+
  同时给标准与 webkit 时忽略 webkit——只用 webkit）。

### 本轮新坑
- **Tauri 命令返回 Option<String> 时 invoke 得到裸 string**——branch-store
  按 {branchedFrom} 对象解析导致谱系条永不渲染（冒烟抓到）；parse 兼容
  裸 string/null/对象三形。
- **冒烟假阳性**：断言"命名成功"时派生标题=首条消息文本，body textContent
  同时含消息气泡——必须查侧栏行/DOM 特定槽位，不能查 body 全文。
- **合成 click 过不了拖拽机器**：侧栏行挂 pointer 拖拽机器后，行切换必须
  CDP Input.dispatchMouseEvent 真实鼠标序列（press→move→release）。
- **exe 陈旧 vs 前端新**：前端调新 IPC 命令报 "Command not found" = exe
  未重编（branch-store 铁律式清投影是正确行为）；重编后即愈。
- on_big_stack 返回 Result<T,String>（spawn/join 层）——闭包内再返回
  Result 时记得 and_then 拍平（session_lineage 首版 E0308 的根因）。

## 侧栏重审计轮（2026-10-02，用户质疑"不适用"潦草→逐条重查）

上一代理把 hermes 侧栏特性批量判"不适用"，用户实测反驳成立——重审计
（读 pi 源码逐条）后落地：**行右侧时间**（SessionMeta.lastModifiedMs/
timestamp 一直在，旧判"无 age 字段"是错的）、**按工作区分组**（cwd 直
投影）+ **选工作区建会话**（pi working_directory 透传，fs_workspace_*
三命令：校验/默认目录/目录对话框）、**created 排序**、rowMeta
时间·Tokens·成本（pi stats 每文件聚合懒拉+单飞）、**未读**（客户端
last-seen 水位+全部已读）、**客户端归档**（pi 无 archive 属实→客户端
面：行菜单归档/取消归档+已归档开关）、导出 HTML（pi export_html 属实
无→宿主自渲染）。真正不可行仅：live 状态桶/PR/多 profile/每行
tokens 排序键（全表 rank 与懒拉冲突，诚实不做）。

菜单重构为 hermes filter-menu 逐行结构：分组▸/排序/显示▸（含紧凑
行高）/显示所有会话/Inbox style/──筛选（状态·PR·Profile 禁用+项目▸+
已归档+重置为默认）/──全部收起/全部标记为已读/选择工作区…。
store 三新旋钮：inboxStyle（卡片行第二行=时间·消息数）/showAll（过滤
旁路）/projectFilter（cwd 过滤，__all__/__home__ 哨兵位绕 Radix 空串
value 限制）。406 用例。

**教训（用户两次纠正）**："不适用"必须逐条读源码实证，不许凭印象；
交互对齐不许简化（拖拽 DragOverlay 让位、右键全区域接管——简化版被
打回，dnd-kit 照抄版在排）。

### 空白区右键分栏菜单（de4f978，hermes ZoneMenu 实锤）
- **hermes 真相**：zone 菜单在 `pane-shell/tree/renderer/tree-group.tsx`
  的 ZoneMenu（不在 contrib/layout——旧引用路径不存在）；**现役 hermes
  zone 菜单没有四向分栏/最大化项**（"Split actions" 是 246 行残留注释，
  i18n 无 split 键）——项清单：重新加载/关闭·关闭其他·关闭右侧·全部
  关闭/隐藏显示标签/最小化还原（主区不给最小化）。四向分栏是任务指定
  的新增动作面（addNode DockLocation），其余照抄。
- 一级窗格「关闭」不隐藏、保留可见仅"已在家"禁用（=回家规则）；
  重新加载无占位可载不装假（规矩 12）。
- 裁定层：context-menu-scope 只加 `pane` 分支（editable>owned>pane>app
  优先级），main.tsx 零改动（非 app 天然放行，Radix Trigger 自管）。
- **菜单项打开时刻现读 model**（hermes "resolved when the menu OPENS"
  契约）——禁用态随实时结构变（副本可关/原籍禁用）。
- CDP 七步实测：右分栏真分裂（746→395+367 无留白，rebalance 生效）、
  一级已在家→关闭禁用、副本→关闭=回家（tidy 收空栏）、composer
  输入框→本菜单不弹（editable 放行）。425 用例。

### app-context-menu 系统整抄（59bdced，hermes 719 行系统移植）
- **架构**（app-context-menu.tsx 头注释有全文）：全应用一个右键体系 =
  一份 capture 监听 + 一个 $contextMenu store（受控 DropdownMenu：光标
  零尺寸 fixed 锚 span + open 常开 + onOpenChange(false) 关）+ 行/树等
  Radix 自管面早退；**dom 段为空回退 shellSections**（bare right-click
  on app chrome = 窗口动词：新建会话/新建窗口条件行/命令面板/──切换
  状态栏/Profile Rail 条件行/切换标签/设置/──更新 Hermes）。
- **Tauri 裁剪清单**（逐项注释在案）：新建窗口（单窗格架构，L5 再启）、
  Profile Rail（无对应物）、更新 Hermes（无 updater，段3 整段消失）、
  editable/link/image 段（原生编辑菜单已由三面裁定承担，Electron
  editFlags 无对应物）。
- **切换标签 = app 级等价**：hermes 作用于单一 zone（"the pointer-only
  way back to a hidden tab strip"）——宿主等价 = 切换全部非轨分栏
  （planTabStripToggle 纯规划：轨+竖轨形态不在切换面，"toggle against
  what is ON SCREEN"），经 __flModel + updateNodeAttributes 施加。
- **状态栏可见性**：hermes statusbar-prefs 对应位（statusbar.tsx
  store + mirach.harness.statusbar.v1 持久化，隐藏=整条卸载）。
- **命令面板**：官方模板 command-palette.tsx 此前无 consume——最小
  接线（store+挂载，命令=菜单真实动作面）。
- **坑**：不能按 .flexlayout-host 整体豁免 flexlayout 自管面——宿主是
  无边框窗全窗绝对层（标题栏 pointer-events 穿透浮片盖住栏顶），按宿主
  豁免=app 菜单全窗失效；窄豁免用 `.flexlayout__tabset, .flexlayout__
  border, .flexlayout__popup_menu_container`。
- CDP 实测：状态栏/标题栏/分隔条右键 → 5 项菜单与 hermes 截图逐项
  一致；切换状态栏/切换标签/命令面板/设置全真生效；行/树/输入框/
  页签四不变面核对无混入。439 用例。

### 侧栏重审计+机器人页+顶栏圆点（2026-10-02 深夜，多代理+宿主缝合）
- **重审计落地**（用户质疑"不适用"潦草成立）：行右侧时间（SessionMeta
  lastModifiedMs/timestamp 本来就有）、按工作区分组+选工作区建会话
  （pi working_directory 透传+目录对话框）、created 排序、rowMeta
  时间·词元数·成本（stats 懒拉单飞）、未读（last-seen 水位+全部已读）、
  客户端归档、导出。真正不可行仅：live 状态桶/PR/多 profile/词元排序键。
- **顶栏四钮改圆点**（用户定稿）：15px 四色（关闭 DC6E6E/最大化
  CBDC6E/最小化 6E97DC/侧栏 6EDCA2）、上缘 25/右缘 50/间距 20 全令牌
  （--win-dot-*）；侧栏圆点在窗口圆点组**最前**（最小化左边）；原
  PanelRight 工具钮删除；双挂载坑（Titlebar 内两处 <WindowControls>）。
- **右键三层严格化**：pane 分支删除——hermes 实锤 ZoneMenu 只包页签
  条/竖轨/编辑遮罩（816 在 editMode 分支内），body 右键归 app 菜单；
  ZoneMenu 砍自创四向分栏/最大化/重命名（hermes i18n zones 零命中）；
  host/rename 死管道清。
- **机器人页**：BotsPane/BotsDialog/bots-store（bot=SessionOptions 参数
  包：system_prompt+model+cwd，本地 JSON 存）+ pi_create_bot_session
  （create_session_opts 参数化：working_directory/model/system_prompt）
  + pi_resources（skills/prompts/extensions/packages 只读列举）+ 入口条
  （五项，无对等物弹诚实提示）。
- **模型目录 hook**：useModelCatalog 加重载（零参=全状态/带选择器=T）。
- 门禁：tsc 0 / vitest **457**（37 文件）/ cargo test **40**。
- **教训**：①并行代理死在限额墙后，工作树是半成品交汇——接手前先
  git status 全量枚举+跑门禁拿断面，再逐文件缝合；②"照抄"任务的
  派单书必须附参考源码的**确切 file:line**（否则代理找不到 pi 位置/
  漏抄系统层——app-context-menu 719 行系统就是派单书漏了出处才没抄）。

## 对标轮续（2026-10-02 深夜：终端/composer/代码高亮/预览）

用户四条 UI 反馈 + 官方三页文档对照。测试 221→275（TS）+ 40（Rust）。

### 终端真 PTY（terminal.rs 445 行 + xterm 前端）
- **pi SDK 无 PTY 面**（bash 是工具内部 exec）——宿主自建：portable-pty
  0.8.1 ConPTY 注册表（上限 8、输出泵 8KB 块 → `terminal-output:{id}`
  Tauri Event、wait 线程统一上报退出码、双保险清理）。
- **通道裁定**（模块头）：终端输出/退出走 Tauri Event **不违反** AG-UI
  三通道纪律——AG-UI 只管 Agent 数据；终端是系统设施。输出载荷 = PTY
  原始字节 base64（read 可能劈开 UTF-8，前端流式 TextDecoder）。
- **cwd 裁定**：pi_get_state/fs.rs 均无 cwd 来源 → 系统 home。
- 前端 xterm（@xterm/xterm+fit+clipboard，与 ZCode 同版）：**fit 先于
  spawn**、resize 去重+在途守卫+pending 队列、**PSReadLine 40m 黑底重绘
  归一**、buffer 折行合并扫链接、StrictMode 孤儿 PTY 回收（main.tsx 有
  StrictMode 必要）、Ctrl+C 有选区走复制。多页签（+号新开/退出码上墙/
  重开钮）。
- **已知限制**：flexlayout 切换同 tabset 内页签会卸载隐藏窗格 → 按
  「卸载=kill」语义终端会话结束（默认布局终端独占分栏不受影响；跨切换
  保活=ZCode 式模块级 registry，独立一轮）。Windows IME 组合输入兜底
  （ZCode 约 300 行）未抄——验收后按需补。

### composer 对齐官方 elements（三页文档实测对照）
- 构图：附件区在输入**上方**（empty:hidden 无附件不占位）；工具行左附件
  右动作组=**模型→语音→上下文环→发送**；容器 paper+rounded-[24px]+p-2.5
  （kit 默认，去掉自绘覆盖）。
- **ContextDisplay.Ring**（18px 环+% 数值）嵌动作组，悬停 tooltip 明细——
  数据照旧 usageBridge；除零守卫保留。
- **官方三态 dictation**：active/recording/transcribing + 秒表；激活期
  **ComposerVoice 替换输入行**（官方原句 "meant to replace ComposerInput
  while active, not sit beside it"），波形（脉冲点+14 柱）+ mono 0:SS，
  停止后 "Transcribing" 微光；Web Speech 逻辑与审查修复原样保留；激活期
  Input 禁用（官方行为）。
- **ComposerAttachments**：官方 56px tile（useAttachmentSrc：内存文件
  object URL、图片缩略、右上移除、上传/失败遮罩、预览 Dialog）——替换
  自绘文字 chip。ComposerSend 官方箭头↔方块动画。
- 不可对齐项：data-compact 态（本仓 kit 快照未含该属性，不猜）；官方
  ComposerPrimitive.Dictate 依赖 runtime dictation 能力面（我们保留
  Web Speech useDictation，仅 UI 三态对齐）。

### 代码高亮两处（shiki）
- **聊天代码块**（components/shiki/ 8 文件）：hermes 四件套（lazy 单缝/
  内容键 LRU 512 条/150k·3k 行预算分块/prose 判定含 CJK 适配）+ Expandable
  Block 折叠。**关键升级：react-shiki `outputFormat:'react'`（hast→React
  元素树）替代 hermes 的 codeToHtml+innerHTML——永不 innerHTML**；
  github-light/dark-dimmed 双主题随 color-scheme；tailwind 坑：裸
  `text-(--var)` 编译成 color，字号须 `text-(length:--var)`。
- **文件预览**（components/preview/ 4 文件）：preview-file 的 200 行分块
  固定 20px 行高窗口化（rAF+ResizeObserver）+ 行号槽 + 74 扩展名→Shiki
  语言映射 + 512KB/3k 行预算降级（同窗口化布局纯文本分块，诚实提示）；
  lazy 单缝独立（与聊天侧互不影响）；vite build 实证首屏零语法包（622KB
  wasm 在按需 chunk）。顺手修一处旧兜底：预览读取失败伪装"二进制文件"
  → 错误态可见。

### 冒烟（真实鼠标）
- 终端：xterm 挂载 + **PowerShell 提示符真实渲染**（截图）；composer
  voice/send 钮在位；空态欢迎+中文建议+起步输入全活；侧栏自动命名行
  （派生标题）+「最近」组标签；零控制台错误。

### 侧栏隐藏修复（用户回归实测：隐藏右栏左栏 350 漂移）
- **照抄路线落地**（用户明令不许自创）：hermes 声明式固定轨语义 = 隐藏/
  重排后**在场固定轨显式钉回记忆宽**（rootPxMem 350/700），主栏吃剩余，
  flexlayout 的兄弟再归一结果禁止裸露到渲染；ZCode expandedSize 记忆
  （panel.expand() resize 回记忆尺寸）= 恢复路径同款钉回。
- **全隐藏语义**：标题栏隐藏与窗格菜单隐藏统一走 hidePane 全隐藏路径
  （deleteTab + hiddenPanes 记录），**不折 border 竖轨**——用户追问
  "为什么标签变竖轨标签，不应该全隐藏吗"；border 轨只保留给终端折叠。
- **首击生效**：sides.v1 持久化与实际布局脱同步曾吃掉第一击（状态说
  已收起、实际展开、expandSide 对在家窗格 no-op）——以实际模型状态为
  展开判定；钮名随态翻转（隐藏右栏↔显示右栏）。
- **真实鼠标全链实测**：350|746|700 → 隐藏右栏（右列消失、左 350、主
  1447）→ 显示右栏（回 700）→ 隐藏左栏（右 700 稳、主 1097）→ 显示左
  栏（回 350）。**坑：侧栏行切换/标题栏钮必须 CDP Input 真实鼠标序列**
  （合成 click 过不了拖拽机器；量测探针 find(title) 要兼容钮名翻转）。
- 调试代理配额耗尽死于报告前——实现已完整落树（flex-layout/rebalance
  518 行），宿主接手验证收尾；**教训：长任务代理的验收标准要在派单时
  写成"可独立核验的量测序列"，中途死掉时宿主能直接跑序列判定完成度**。

## 侧栏排版轮（2026-10-02 深夜：字号/间距四批，ff2ddd9→a7d4f79→bca411f→84964b4）

左栏字号与间距的用户定稿三轮迭代，全部令牌化（tokens.css 单一取值处）：

- **一轮（ff2ddd9）**：初版把 20px 文字/组头/间距全量上调（入口行高 44/
  图标 20/条距 10/行距 4、组头 20px）——方向大体对但粒度错（见二轮）。
- **二轮（a7d4f79）**：①入口条 18px（行高 32/图标 18/条内距 6/行距 1
  全缩回 hermes 几何）+②组头 15px 品牌色加粗（`--side-group-size`
  20→15）+③工作区头 18px（`--side-workspace-size` 新令牌）+④**会话行
  纵距** `--tl-row-pad-y`（comfortable 4px/compact 2px，行元素 py 接线，
  panes.css 密度块随行）——**间距的准确语义是"会话行与会话行之间"**，
  初版误解为入口条/组头间距全数上调后回调归位。
- **三轮（bca411f）**：①**入口条图标列删除**（Item.Icon 字段/五个
  lucide import/`.hub-entry-icon` 规则/`--hub-row-icon`/
  `--hub-icon-dim` 令牌全链清——删前 Select-String 全量核实消费链
  唯一）；②组头间距令牌化 `--tl-head-pt`（6→12px，pt-1.5 静态值退役，
  compact 密度减半）；③工作区与工作区间距 `--tl-ws-pt`（8→16px，
  WorkspaceDividerRow 独立 pt；组头走 head-pt 不再共用 div-pt）；
  ④工作区头颜色 **#4C4C4C**（`--side-workspace-color`，folder 字形+
  组名同改——中性灰与品牌色组头/日期桶区分）。
- **四批（84964b4，commit 信息写"五轮"系口误）**：①组头间距再加大
  （`--tl-head-pt` 12→16px）；②工作区组间距再加大（`--tl-ws-pt`
  16→24px）；③**侧栏正文色统一 #4C4C4C**——`--side-workspace-color`
  重命名 **`--side-text`**（会话行标题/入口条/工作区头三处共用，
  hover 加深保留）；④入口条文字 15px（行高 32→28 回 hermes h-7
  几何）；⑤工作区头 15px（与组头同字号，灰/品牌色区分）。
- **六轮（18ef7cd）**：①组头间距再加大（`--tl-head-pt` 16→24px，五
  轮的 12→16 视觉不可辨——四批把 fallback 0.75rem 同步 1.5rem 保取值
  一致）；②入口条 16px（`--hub-row-font`）；③工作区头 16px
  （`--side-workspace-size`）。
- **七轮（5a6d66f）+ 八轮（b2fd9af，CDP 实锤 root cause）**：①六处间距
  类从 `pt-(--var,fallback)` 括号简写切到 `pt-[var(--var,fallback)]` 方括
  号——Tailwind v4 **括号简写带逗号兜底不生成 CSS**，所有行 px（间距
  令牌此前四轮调到 24px 全部静默失效为零）；②**真凶是侧栏密度 = compact**
  ——CDP 9223 脚本 reload 后实测：`[data-density='compact']` 块覆盖
  `--tl-head-pt: 0.375rem / --tl-ws-pt: 0.5rem / --tl-row-pad-y: 0.125rem
  / --tl-div-pt: 0.25rem`，用户看的是 6/8/2px 而非令牌值——间距"调多少
  遍都没变"是 density 属性在作怪。修复：compact 块全部提一档
  （head-pt 6→16 / ws-pt 8→20 / row-pad-y 2→4 / div-pt 4→6，保留档差
  与舒适档比例）。③实测 compact：组头 pt 15px（舒适 24px）/ wsDivider
  18.75（24）/ item 3.75（4）；字号组头 15/16px 工作区头 fs 15px
  继承（实际 span 16px，探针取外层 div）/ 行标题 #4C4C4C / 入口条
  #4C4C4C 全部生效。**教训**：①以后改间距/字号**必须先量 computed
  值**确认令牌链路实际命中——grep 产物 CSS 是假阴性（minified `\[`/`\(`/
  `\,` 转义）；CDP 9 计 9 evaluate 23 用 9 是唯一金标准；②带逗号 fallback
  的 `(--var,fallback)` 写法**不要用**，方括号 `var(--var,fallback)` 唯
  一稳妥；③**密度档 silent override 令牌**——调令牌前先确认 density 值，
  否则 token 改 100 遍用户眼里还是上次的旧值。
- 门禁：tsc 0 / vitest 462（38 文件）四批全绿。
- **九轮（c09c7be）**：紧凑档回调过头修复——`--tl-head-pt` 16→8 /
  `--tl-ws-pt` 20→8（八轮同步抬档过头，会话↔工作区 pb-1+gap+ws-pt
  实测 ~24px 视觉夸张→紧凑 13px / 舒适 29px 保持）；tsc 0 / 462。
- **十轮（9a13e91）**：对话标签双行块（用户定稿）——`onRenderTab` 在
  `region='main'`（workspace/session 两 pane）替换 tab content 为
  `<ChatTabLabel />`：上工作区 25px/bold/#303030（cwd pathLeaf via
  `workspaceGroupLabel`）+ 下会话名 15px/regular/#5A5A5A（thread.title
  from threadListAdapter）；真实接线（runtime useEffect 把
  `currentThreadId`+`currentMeta.title`+`currentMeta.custom.cwd` 推到
  `chatTabLabelStore`，vanilla zustand）。位置：tab 右半最多 50% 宽
  （CDP 实测 rect x=699 w=373 在 tabRect [336..1067] 中线 701.5 右
  侧，pos=absolute/pointer-events:none 不挡 trailing ✕/home 钮）。
  **坑——CSS 特异性 (0,2,0) 不够**：初版 `.flexlayout-host
  .chat-tab-label` 时 CDP 实测 `position: static`（flexlayout 内部
  `.flexlayout__tab_button_content` 的 child 选择器覆盖）。修复：选择
  器提到 (0,3,0) `.flexlayout__tab_button(_stretch) .chat-tab-label`
  双选择器后实测 pos=absolute。新文件 `chat-tab-label-store.ts`
  （runtime 单向 import，layout 不 import assistant-ui——跨层最小耦合）
  + `chat-tab-label.tsx`（useStore 订阅）。
- **十一轮（7f3be93，CDP 实锤）**：**关闭右栏 window 后左栏漂移修复**
  ——用户实测 2026-10-02："左栏默认 350，右栏并行两栏关掉其中一个，左
  变宽"。**真因——结构路径 scheduleRebalance 跑了 measureRootPx**：
  flexlayout 权重保留旧 23%/60%/17% 比例，删 terminal tab → 右栏
  350→308 → 等比缩到左栏实测 413 → measureRootPx 把 413 写入
  `rootPxMem.left` 永久污染；后续 absorbSurplus 用 measured[413]
  而不是 mem[350]，applyRootWeights 又不在这条管道里，钉不回去。
  **修复**：scheduleRebalance 结构路径（DELETE_TAB/MOVE_NODE/AddNode）
  不跑 measureRootPx（保留默认 350/700），改跑 `syncTabsetConstraints
  + applyRootWeights` 钉回记忆 px，与 hide/show 同款 pinAfterLayout
  语义。CDP 验证：Ctrl+click 布局编辑器重置 → 左 350/主 746/右 700
  → doAction FlexLayout_DeleteTab terminal → 左仍 350 ✓（修复前 413）。
  教训：①stale 权重 + measureRootPx 会把测量值烙进记忆——**结构动作
  必须显式钉回而非信赖旧权重**；②CDP 量实际渲染宽前用 `m.toJson()
  .layout.children`（不是 `j.children`）拿到模型 children；visitNodes
  实测在本会话因 model setup 时机不返回 TabNode——以 toJson 为准。
- **十二轮（c351240，用户 2026-10-03）**：对话标签双行块**改 leading 形式**
  ——用户："项目名和会话名往左边放，参考左栏会话列表中 logo 放的形式；
  标签怎么没有了"。改动：①`onRenderTab` 删 region='main' 的 content
  替换（原 tab 名恢复——十轮把 content 换成 chip 导致原生标签消失）；
  ②主区**单签拉伸头栏**（原生 strip 隐藏场景）`renderValues.leading`
  追加 `<ChatTabLabel />`（与 fl-tab-sep 共存：fragment 包裹）；多页签
  条不注入（页签名即会话名已够）。③CSS 改 static + align-self:stretch
  + justify-content:center（拉伸头栏 align-items:flex-end 沉底布局下
  chip 不被压扁、垂直居中）；max-width 40vw 防超长路径撑爆。CDP 实测：
  chip x=369-586 贴 tab 左缘（359+10）、content "主会话" x=600 恢复、
  pos=static ✓。教训：**替换 content 会吃掉原生标签**——跟标签共存的
  装饰一律走 leading（hermes/RailLogoLeading 同款位置语义）。
- **十三轮（163c2c6，用户 2026-10-03 复现"默认布局直接关检查页左栏
  变大"）**：十一轮修复的**自愈补丁**。CDP 实测新代码下"重置默认→关
  review→左 350 保持"✓——用户仍见变大的根因是**遗留污染态**：旧 bug
  时代 stale 权重已写进 rootPxMem（模块态，HMR 不重置）与 localStorage
  布局权重，新代码 applyRootWeights"忠实"钉 413。补丁两处：①
  onModelChange 在 DELETE_TAB **同步时刻** measureRootPx——此刻 getRect
  仍是动作前布局（flexlayout 重排在 React commit，AGENTS"onModelChange
  时 DOM 是旧渲染"在此恰是正确值），记录的 = 用户关闭前看到的各列宽
  （想要的状态）→ 定时器钉回它 → **关闭一次即自愈为"保持不变"**（覆
  盖任何历史污染）；②定时器结构路径跳过 measureRootPx（applyRootWeights
  钉回后立即量测读到 stale 渲染会再污染 mem，影响下一次钉回目标）。
  非 DELETE_TAB 的结构动作（MOVE_NODE/AddNode）不同步量测——migrating/
  程序化序列有自己的 pinAfterLayout 机制，中途量测会写中间态。教训：
  **"旧渲染"是好是坏取决于问题**——对量测折叠高度是坑，对"关闭前状态
  快照"恰是唯一正确时刻。
- **十四轮（e38ce7d，用户"没有任何变化"+指示参考 hermes）**：十三轮
  的"自愈"被证伪——**程序化 CDP doAction 用裸对象 `{type,data}`，缺
  `isAdjusting()` 方法，flexlayout Layout 的 onAfterAction 包装层调用
  它抛 TypeError → 我的 onModelChange 整个没跑 → 程序化路径"350 保持"
  是"什么都没跑"的假象**。真实鼠标点 ✕ 复现：左 350→**420**（顶满
  max）。真凶（临时探针 dbg-sync/dbg-pin 数据流实锤）：①同步量测 ✓
  （mem={350,746,700} 正确写入）；②定时器 applyRootWeights ✓（写
  left 19.47=350——px[right]=420 是 files 塌缩后独占 VERT 列被自身
  max=420 钳列，sync stackedFirst"堆叠第一个保留列限制"语义，几何
  必然）；③**absorbSurplus 同帧串跑在 applyRootWeights 之后，非主栏
  base 用 measured（此刻渲染还是 stale 的 420），px[left]=420 且
  权重差 23.39 vs 19.47 > 0.05 过不了跳过阈值 → 把刚钉的 350 权重
  覆盖回 420**。修复：absorbSurplus 非主栏 base=**mem**（与
  applyRootWeights 同源，fallback measured；mem 由 measureRootPx 在
  拖拽/resize/boot 维护、结构动作由同步量测维护）——hermes 声明式
  "关列别列不动"的权重制等价物。单测 ③④ 补"量测已跑"记忆前置 +
  beforeEach 重置 rootPxMem 防泄漏。CDP 真实点击终验：左 **350 保持**
  ✓、主 1026 吃富余 ✓、右 420（files max 几何必然=hermes"列随
  files 变窄"）。**教训**：①**CDP 程序化 doAction 必须用真工厂**
  （Actions.deleteTab(id)）或真实鼠标——裸对象会在 flexlayout 内部
  包装层炸掉且静默（异常只在 consoleAPICalled 里看得到）；②同帧
  串跑的"钉回→兜底"两函数必须**同源取值**（都 mem 或都 measured），
  混用=后写覆盖先写；③"验证通过"要找到生效机制的老教训在此升级：
  **异常中断链路后"结果恰好正确"≠修复生效**。
- **十六/十七/十八轮（溢出标签三轮返工，用户 2026-10-03）**：
  - **十六轮教训——位置全错**：把"标签总览下拉"做到左栏 sessions+bots
    tabset 的 leading（用户："左侧栏为什么有个按钮啊？我要的是所有的
    标签"）——需求是**所有多签 tabset 的页签溢出处理**（浏览器式：多开
    →压缩→折叠→下拉），不是左栏窗格切换。十七轮移 trailing 仍不对。
  - **十八轮定稿——flexlayout 原生机制 + ZCode 面板照抄**（用户："两个
    同时存在？"+"去 zcode 的源码抄"）：**flexlayout 0.11 自带完整溢出
    体系**（useTabOverflow：tab 超宽自动裁→hiddenTabs→原生溢出按钮→
    PopupMenu，`onShowOverflowMenu` 回调可替换面板、`icons.more` 可换
    图标、函数式 icons.more 不带 count badge）——自制按钮与原生并存
    是重复造轮子，全删。落地：①Layout 接 `onShowOverflowMenu`（回调
    items=hiddenTabs）+ `icons.more: () => <ChevronsDownIcon/>`（双箭
    头，ZCode 截图同款）；②新组件 `tab-overview-menu.tsx` **逐结构照
    抄 ZCode SidePaneTabOverview.tsx**：cmdk Command（搜索框+「打开的
    标签页」分组+类型图标+名字+相对时间+✕ 关闭+active 高亮），Radix
    Popover `virtualRef`（`getBoundingClientRect` 对象）锚定点击处；
    相对时间复用 sessionRowAge（刚刚/天/时/分）；搜索评分照抄
    sidePaneTabSearch.ts；TabNode 无 openedAt——模块级 Map 首见时间
    补；③tab_button `min-width: 60px`（ZCode
    SIDE_PANE_TAB_MIN_WIDTH_PX 等宽收缩下限：空间足自然排→不足等比
    收缩到 60→仍溢出才交原生裁切+按钮）；④CSS 隐藏原生 count 数字
    （`.flexlayout__tab_button_overflow_count { display: none }`）+
    原生按钮令牌化（`.flexlayout__tab_button_overflow`）。
  - **照抄的坑（必记）**：①复刻 ZCode 搜索函数**漏了空查询早退**
    （`if (queryParts.length === 0) return items`）——空 query 时
    reduce 初值 0 全部条目被 score>0 滤空，面板永远"没有匹配"——
    **照抄必须完整，缺一行分支就是全量失效**（CDP data-metas=2/
    filtered=0 实锤）；②vite 陈旧模块缓存连 props 都吞（data-* 属性
    不进 DOM）——重启 vite 才放新代码；③CDP 造溢出场景：动态 import
    vite deps 路径 `Actions.renameTab` 真工厂改长名（min-width 60 下
    左栏两签必溢出）；④debug 手段：React 面板 props 用 `data-*`
    attribute 直接读（innerHTML dump 看不到元素自身 attribute）。
  - CDP 终验：长名造溢出→原生按钮 (302,83) 32×16 双箭头→点击面板
    288px、items=2（会话列表/机器人-超长名）。tsc 0/462。

## 标签溢出定稿 + 双行块对齐 + sessionCatalog 单一真相源（2026-10-03 续）

- **十九轮（5bd0479）**：①溢出面板显示**全部**打开的标签（props 改接
  tabset 读全量 children——ZCode「打开的标签页」=全量，不只 hiddenTabs；
  跳转 selectTab 原生滚入视图）；②**CSS 注释陷阱（重要）**：注释里写
  `--zone-btn-*/--tab-*` 的 `*/` **提前闭合注释**，废 token 吞掉紧跟的
  按钮规则（CSSOM 实锤：库注入规则在、hover/count 在、唯独基础规则消
  失）——注释改写后按钮 20×20 令牌化生效。教训：CSS 注释中出现 `*/`
  序列（如 `--x-*/--y-*`）= 灾难。
- **二十轮（3188d6c）**：主对话双行块**宿主层叠片化**（ChatLabelOverlay，
  chrome-overlays 同 MainTint 机制，相对 workspace tabset 顶带
  --logo-strip-h 100px 定位）——stretch 头栏上方有 tabset_header 25px，
  leading 内永远够不到 MIRACH 顶（21 vs 82 实锤）。对齐 CDP：项目名
  top 21=MIRACH top、会话名 bottom 83=页签行底（tab_button_stretch
  padding-bottom 18 同步落）。显示逻辑 ZCode 式：新会话 New Chat +
  最近工作区（setPendingCwd），标题 = pi name ?? 派生标题
  （firstUserMessageText+deriveTitle）?? New Chat——首条消息即时跟随。
- **廿一轮（f08bf07）+ 廿二轮（8230a45）**：**sessionCatalog 单一真相
  源**（用户定稿："前端只是映射，应该有一个储存会话名，项目名的地方，
  左侧栏，主对话栏，所有的地方都从那里取"+"所有的数据都只有一个真相
  源，参考 hermes 和 zcode 能抄就抄"）。
  - **参考**：zcode tabStore（packages/ui/src/store/tabStore.ts——单
    store 承载全部 tab 维度状态+动作内聚+工厂创建+settingService 持
    久化）；hermes api/sessions.ts（pinned/archived/unread/name 全是
    **后端 API**——pi 无此后端，客户端统一承载）。
  - **catalog 扩展**：目录（entries/piOrder/activeId/pendingCwd，runtime
    唯一写入者，不持久化——pi 是真相）+ 管理维度（pinned/manualOrder/
    archived/seen/markers/groupsCollapsed，hermes 后端字段的客户端对应
    物）+ 动作内聚（togglePin/setPinnedOrder/setManualOrder/toggleArchive/
    ackSession/markSessionUnread/ackAll/setGroupCollapsed/prune）+ 未读
    播种并入 ingest（hermes ingestRows 三规则）+ 统一持久化**单键**
    `mirach.harness.sessions.v1` + **旧五键一次性迁移**（旧键保留回滚
    安全）。
  - **退役**：sessionManageStore/sessionArchiveStore/sessionUnreadStore
    三 store 删除（960 行-），消费方（thread-list/sidebar-view/runtime）
    只改 import 路径 + `s.order`→`s.manualOrder` 改名；hook 别名
    useSessionManage/Archive/Unread 保留指向 catalog（选择器零改动）；
    mirach:workspace-title CustomEvent 旁路桥退役（flex-layout 直接订阅
    catalog）；chatTabLabelStore 删除（ChatTabLabel 订阅 catalog）。
  - **CDP 全链同源**：侧栏行/双行块会话名/workspace 页签名三处同值、
    双行块对齐 21/83 保持；448 用例（三旧测试合并为 session-catalog.test
    语义保全 21 用例含迁移公式）。
  - **教训**：①zustand selector 里 map 新对象 + useShallow = 元素引用
    每次新建永不相等 → **无限重渲整页卡死**（Runtime.evaluate 永不返
    回）——派生数组必须 useMemo 依原始引用；②页面假死先重启 app 再
    bisect——webview 热更叠加的陈旧状态和代码死循环症状相同（本轮
    bisect 全禁+重启仍活、全恢复+重启仍活=非代码问题）。
- **廿三轮（A 349bc26 前半 + C 07cb05d；用户"要做生产级的""不要等直接
  做"）**：①**所有栏页签行离条底统一 15px**（`--strip-pad-bottom` 令
  牌；tabbar_outer 全局 padding-bottom；fl-strip-low 36px 紧凑条排除
  ——15px 只约束顶带 100px 的左/中/右条）。**字形级量测**（Range
  getClientRects——元素 rect 底含行盒空隙，用户量的"25 都有了"实为
  字形差）：`--logo-glyph-drop: 8px` 补 MIRACH 50px 行盒下沉 → 项目名
  字形顶 28=MIRACH 字形顶 28；页签字形底→条底 10px（用户"15→下移
  5px"）；会话名字形底=页签字形底。**教训：跨字号的对齐一律按字形
  （Range rect）量，元素 rect 是行盒不是字形**。②**生产级：管理元数
  据上 Rust 层**——新增 `src-tauri/src/session_meta.rs`：
  `app_data_dir/session-meta.json`（pinned/manualOrder/archived/seen/
  markers/groupsCollapsed，camelCase），**原子写**（tmp+rename 防半
  写），Mutex 懒初始化路径；IPC `session_meta_get`/`session_meta_set`
  （整量写穿）；前端 `hydrateSessionMeta()`（runtime 挂载水合——
  Rust 空 && 旧 localStorage 有 → 迁移链成立，旧键保留不删）；persist
  写穿防抖 250ms；localStorage 退役为迁移源（只读）。CDP 实测：
  shift+点击置顶 → meta 文件 250ms 内落盘全量字段（含旧数据迁移）。
  hermes 后端模式（api/sessions.ts 的 setSessionPinnedRemote 等）的
  宿主实现——**这才是"生产级"与 hermes 的真实对齐**。③**虚拟化**：
  `virtual-session-list.tsx`（hermes virtual-session-list.tsx 骨架照
  抄）——@tanstack/react-virtual（threshold **25** 同值/overscan 12/
  divider 30px·行 31px 估算/measureElement 动态测量/getItemKey）；
  **dnd 共存**（hermes 实锤注释）：ReorderableList 仍持有
  DndContext+SortableContext，虚拟行只**消费** context（renderRow 内
  useSortable），未挂载行不参与拖拽；挂载于 ThreadListItems flex col
  内 `flex-1 min-h-0` 吃剩余高度（外层滚动与内层虚拟滚动不重叠，非
  虚拟分支平铺不变）。CDP：threshold 临时 3 时 virtualMounted/scroller
  620px 可滚/DOM 行数受控。**教训：CDP 动态 import '/src/...' 与应用
  内 '@/' 别名 import 可能不是同一模块实例（孤儿实例写进 store 应用
  无感）——涉及应用 store 的验证改走真实 UI 手势（鼠标/键盘）。**
- **布局全量审查轮（2026-10-03，4 子代理并行：模型层/主组件/CSS/交互）**：
  共 11 个 P1（0 个 P0）+ 40 个 P2，三批修复已推（f81e917/39f5dff/987967e）。
  **P1 清单**：①onModelChange 在分隔条拖拽的每个 adjusting 帧全量执行
  （flexlayout 对 adjusting 走直写 DOM 快路径却被我们 persist×2+bump 击穿
  ——帧早退，提交帧一次做完）；②showSide 回退路径孤儿页签裸 addNode 造
  重复 id 模型（getNodeById 语义损坏——统一过滤+错误可见）；③
  scheduleRebalance 定时器无卸载清理（StrictMode/HMR 下写死模型）；
  ④fitWindowWidth 无最大化守卫（最大化后关页签被砸回 1800——模块级
  `windowMaximized` 标志由 onResized 维护，**async 查询会破坏测试同步断
  言**，必须标志化）；⑤applyRootWeights 亏空场景写出 Σpx>avail 的权重
  （窄窗右栏挤出窗口——clamp 后按比例收缩，与 absorbSurplus 语义对齐）；
  ⑥stripHidden **区域级 flag × 分栏级 toggle** 粒度错位（pane 菜单只改
  单个 tabset 却写区域 flag——两条隐藏路径分叉；sync 改
  `stripHidden?false:!rail` 全形态一致）；⑦pane 菜单 hide-strip 不写
  stripHidden（sync 会翻回来）；⑧tab-overview `useMemo([tabset])` 因
  flexlayout **就地变异节点**永不重算——关闭后幽灵行"关不掉点不动"
  （改每次渲染现取+layoutRev 订阅）；⑨拖拽插入符坐标是 zone 相对系却被
  直挂 overlay（宿主相对系）——除贴宿主原点的 zone 外全错位（包 zone 盒
  anchor）；⑩RailNav 手写手势机无 setPointerCapture/无 Esc/无 rAF 合帧
  （偏离 drag-session 契约——**待修**）；⑪Zone 编辑器遮罩挂宿主内
  （.flexlayout-host isolation:isolate 内再高 z 也压不过根上下文
  app-titlebar 50——窗口圆点浮在 scrim 上；portal 到 body 根治）。
  **新增 z 层级表**（tokens.css）：宿主内 main-tint -1 < 锚层 30 < veil 55
  < drop 60 < ep-card 70 < zone-add 90；根上下文 titlebar 50 < 弹出 70 <
  modal 130；**规则：模态必须 portal 到 body**。
  **架构评价（代理共识）**：分层干净（constraints 纯几何 →
  constraints-sync 应用器 → rebalance 通道 → React 壳），主要债是
  **写放大**（通道每个 doAction 被 onModelChange 全额观察——批内抑制
  observer 是下一步）与**偏离核心机器的自建旁路**（RailNav 手势/
  tab-overview memo/pane 菜单 strip 三处 P1 同源）。
- **排版/双行块/溢出/条隐藏轮（2026-10-03，廿四~廿八轮补登，用户逐轮
  验收）**：①左栏排版定稿——入口条 16px、组头 15px 品牌色、行 15px、
  文字色统一 #4C4C4C；②**对话标签双行块**（chat-tab-label.tsx +
  ChatLabelOverlay 宿主叠片）：工作区名 25px bold + 会话名 15px，
  cwd pathLeaf + thread title 真实接线，顶对齐 MIRACH、底对齐页签行，
  占顶带左半；③左栏宽度漂移修复（结构动作时序量测：DELETE_TAB 同步
  getRect=动作前布局 + absorbSurplus base 与 mem 同源）；④**标签溢出
  照抄 ZCode**——条内 overflow 双箭头钮（无计数，用户实测驳回归零）+
  cmdk 搜索总览面板（tab-overview-menu.tsx，hermes SidePaneTabOverview
  形制）+ threshold 25 虚拟化（virtual-session-list.tsx，
  @tanstack/react-virtual 与 dnd 共存=虚拟行只消费 SortableContext）；
  ⑤**条隐藏形态**——内容上移根因=条在文档流（顶带 100px 保留，三栏
  信息位：左 railform logo/主双行块/右 StripHiddenTitleOverlay 活动
  页签名）；⑥**sessionCatalog 单一真相源**（用户定稿"所有的数据都只有
  一个真相源"：entries/piOrder/activeId/pendingCwd/pinned/manualOrder/
  archived/seen/markers/groupsCollapsed 统一持久化 Rust
  session_meta.json，左侧栏/主对话栏/浮层全从它取）。
- **竖轨文字 + 编译护栏轮（2026-10-03）**：竖轨 cell 文字照抄 hermes
  （justify-center + max-h-48 截断，f8f76b0）；asupersync 并行全量编
  必崩（STATUS_STACK_BUFFER_OVERRUN：16GB 内存 + C 盘页面文件不可扩，
  仅并行触发、单 crate 单独编必成）→ **.cargo/config.toml 护栏三条**
  （jobs=4 / RUST_MIN_STACK=32MB / debug=1，ed5d8e9）。
- **条隐藏顶带定位修正（14863de）**：`.flexlayout__tabset_content` 是
  **position:relative**（非 absolute）——top 位移只偏视觉不改布局占位
  （height 回自然值 → composer 被挤到圆角外，用户截图实锤）；修 =
  父容器 tabset `padding-top: var(--logo-strip-h)`（推子项+压缩可用高）
  + content `height: calc(100% - 100px)` 对齐。
- **标签条显隐 hermes 阶梯（廿九轮，ae75f72/ae05c9a）**：
  resolveTabStripVisible 完整移植（区域竖轨→空区→stranded→mode 显式→
  >1 签→sibling main zone）；zone config 加 `tabStripMode` 三态
  （'always'/'never' 显式 / undefined=auto 不持久化——"nothing outside
  mode is persisted"）；「切换标签」对**屏幕现状**取反写显式 mode；
  stripHidden 布尔全链退役。
- **三十轮（2026-10-04，375eafe）——「切换标签」无效 + 多标签回最左
  双 bug 根修**：①**zoneConfigOf 返回体截掉了 tabStripMode** → 阶梯
  mode 分支永远死，toggle 写的 always/never 被 sync 按 auto 立即打回
  （用户"什么都没变"的根因；zoneConfigOf 返回型别有该键、实现漏了——
  **教训：pick 型 reader 与写入口径必须对表**）；②sync region 重钉
  （整对象替换）携带 tabStripMode，mode 随分栏走；③**主栏多标签中线
  起排**：data-chat-zone 标记（StripHiddenTitleOverlay 打在**收容
  workspace 的 tabset**上，tab 级存在性不受激活态影响——
  [data-chat-lead] 随页签内容卸载失灵）+ 容器 padding-left:50%
  （stretch 规则同改标记源；单签/多签落点实测一致 681/684）。CDP 全链
  验证：隐藏→reload 持久化→右键显示→bots 拖进主栏→拖回左栏全绿；
  测试 +4 共 452，tsc 0。
- **三十一轮（2026-10-04，7869ca3/ad690cb）——布局 v4.0 最小宽度定稿 +
  拖拽跟随 + 顶带减负**：①**拖拽中叠片逐帧跟随**（"颜色层/双行块只在
  松手瞬间跳"）：adjusting 帧 flexlayout 直写 DOM、模型不变——layout-store
  加 dragRev 轻量计数（仅量测叠片订阅，壳不订阅=churn 隔离契约），
  onModelChange 的 adjusting 早退分支逐帧 bump；CDP 实测拖动中
  tabset/tint/anchor 三者 rect 完全相等（用户后实测确认钉死并收回晃动
  反馈）。②**布局 v4.0（用户定稿：所有栏只保留最小宽度，先改文档后改
  代码）**——docs/layout-design.md §2.2/§2.3/§2.4/§3/§9/§11/§12 就地改写；
  代码 REGION_LIMITS 删 maxW、widthBounds 非轨 max 恒 99999、
  clampRowWeights 退化纯 min 保险网（嵌套 min 不向上传播场景保留）、sync
  统一 coerce 旧档 maxWidth→99999 自愈、applyRootWeights/absorbSurplus
  目标=记忆宽托底 min、**flexlayout-rowfix.ts 整文件删除**（只修聚合
  max——上限废除后上游缺陷无害）+3 用例；CDP：左栏拖到 610 无钳制
  （旧上限 420/380 废）。③右栏条隐藏顶带**占位文字删除**（顶带保留但
  空着，hermes 同样无 chrome）——StripHiddenTitleOverlay 退化纯标记层。
  ④文件树（ZCode 拷贝件适配）：行包裹层 px-1→0（行卡片与地址行同宽，
  CDP 左右 inset 均 7.5）+ 地址行文件夹名品牌蓝
  **text-(color:--brand)**——【坑】裸 text-(--brand) 对 Tailwind v4 歧义
  （text-\* = 字号或颜色）不生成规则，须显式色彩提示。449 全绿 tsc 0。
- **三十二轮（2026-10-04，89b8aa8）——布局二轮清账（用户："为 max 绕路
  的逻辑继续删"）**：①**clampRowWeights 整函数删除**——2026-09-23 为
  max 时代而生；**__noClamp 对照实证**：关掉保险网后右列嵌套 min 481
  仍被原生守住（行聚合 min 经 calcMinMaxSize 内联 DOM + calculateSplit
  边界钳位）——"嵌套 min 不向上传播"是 max 时代的误诊，min 保险网是
  死代码（**教训：保险网也要定期验证生效机制，别让反向证明缺席**）；
  ②heightBounds 删除（唯一消费方是 clamp）；③__noClamp 调试钩子删除；
  ④widthBounds max 聚合递归删除（轨 20 固定/其余恒 99999）；⑤
  applyRootWeights ready 守卫与 absorbSurplus boundsOk 守卫删除（依赖
  max 有限性，废除后永真）。onAction 只留负权重防线+提交帧所见即所得。
  文档 §2.3/§9.4/§9.5 同步。CDP 回归：压右列停嵌套 min、左栏拖 700 无
  上限、0 控制台错误；443 全绿 tsc 0（净 -140 行）。
- 教训：①间距/字号需求的落位要先确认**是哪两层之间**（"上下间距
  加大"本轮两次返工：组头→行间→组头间+工作区组间），按自认为的结构
  批量调 = 每轮都错一层；②cmd shell 的 findstr 对多点路径
  （`src\styles\*.css`）会漏匹配——删共享令牌前用 PowerShell
  Select-String 全量重查真实消费链；③PowerShell 正则改写 tokens.css
  后同文件 Edit 会报 modified-since-read——先 Read 再 Edit。

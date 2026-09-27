# AGENTS.md — mirach-harness 工程须知（新会话必读）

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
    overlays/         【空骨架】全局 overlay（boot-failure 等）
  components/
    layout/           flexlayout 布局引擎与拖拽系统（=hermes components/pane-shell）
    panes/            窗格内容（占位）
    ui/               通用 UI 原语（codicons.tsx；未来 shadcn 原语）
    assistant-ui/     【空骨架】assistant-ui 聊天渲染（L1 核心接入位）
  lib/                通用工具（tauri-window/escape-layers/drag-ghost/reorder/storage）
  store/              Zustand 状态层（layout-store.ts；2026-09-26 从 nanostores
                       迁移，tab-selection.ts 同迁——vanilla store 供事件回调）
  agent/               【空骨架】XState Agent 轮次状态机（AG-UI 事件归约，
                      见「待办 3」轮次状态机专条）
  api/                【空骨架】L2：AG-UI HTTP+SSE 客户端
  ipc/                【空骨架】L2：Tauri IPC 调用层
  contrib/            【空骨架】窗格/能力注册表（hermes contrib 对应位）
  hooks/ types/ i18n/ themes/ test/  【空骨架】
  agent/               【空骨架】XState Agent 轮次状态机（AG-UI 事件归约，
                      见「待办 3」轮次状态机专条）
  public/brand/        品牌物料（2026-09-25 落位）：logo.png / avatar.png（头像）/
                       splash.png（启动页）/ logo.svg（8 色 SVG，39.7KB，UI 缩放用）/
                       logo-detail.svg（24 色 SVG，154KB，细节版）/
                       avatars/{agents,users}/（空占位）/ backgrounds/（9 张壁纸壁画）
src-tauri/            L3 Rust 应用层（+未来 L4 pi-adapter）
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

package-lock.json 已生成（2026-09-20，含上面全部钉版）；重装依赖后先跑
tsc + vitest 再动别的。改依赖版本先看上表——每个钉版都有一次翻车在背后。

## 待办（按优先级）

### 1. mock seam 深化（按需）
`window.hermesDesktop` 桥已建（见上"mock seam"），主页面可进。深化方向
按用户需求驱动：网关 RPC mock（让发消息出假回复流）、更多 REST 路由形状
（对着 `[mock-api]` 日志补）、窗口控制接 Rust（`toggle_main_maximize` 已在）。

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

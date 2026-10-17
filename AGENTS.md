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

## 代码审计与 mock seam

已归档 `docs/history-audit-mock.md`（2026-09-26 adjustWeights 审计；mock seam 死功能文档——src/mock 已删，pi 真引擎上线）。

## mock seam（已删除）

src/mock 已删（pi 真引擎上线）；历史文档归档 `docs/history-audit-mock.md`。
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
  - **活动面板（2026-10-16，提交 e85c25f）**：对话栏右上角状态面板 =
    ZCode `ConversationStatusPanel`（`G:\ZCode-main\packages\ui\src\v4\`，
    2086 行）的 mirach 移植版。**能做的接真数据、缺数据的做 UI 并标注**
    （用户口径：别砍）：
    - **真数据三分区**：待办（`todo` 工具 `todo_list.v1` details →
      `todo-store`）/ 子代理（`agent_hub::registry().roster()` →
      `pi_hub_roster` IPC → `agent-hub-store`）/ 终端（`jobs::list(sessionId)`
      → `pi_job_list` IPC → `jobs-store`）。
    - **数据通路两条**：①拉取（挂载时 `pi_hub_roster`/`pi_job_list`——
      registry 是 pi **进程级全局单例**（`agent_hub.rs:165` pub /
      `jobs.rs:2205` pub），宿主直接拉，不依赖模型调 hub/jobs 工具）；
      ②事件（`CUSTOM tool_execution` 的 `details.schema` 经 `tool-sidecar.ts`
      在 runtime 边界分派到 store——`ToolOutput.details` 序列化存活，
      `agui.rs` mapper 整包透传 partial/result，**已加 3 个回归测试**）。
    - **引擎侧缺数据分区**（UI 保留 + 占位行）：workflow run / goal / git
      变更统计——pi 内核无这些概念。**缺口清单见 `docs/engine-gaps.md`**
      （G1-G6，每条留"自建/等上游"决策位，待用户定）。
    - 组件：`src/components/assistant-ui/conversation-status-panel.tsx`
      （浮动卡 + mini 胶囊 + 分区折叠）；挂点 `assistant-thread-pane.tsx`
      右上角（`.assistant-thread-pane` 已 position:relative）。
    - 验证：cargo check 0 / agui 37 测试 / tsc 0 / vitest 全绿 + 新增 20 用例
      （`status-panel-stores.test.ts`）/ vite build OK。
    - **未接线（见 gaps G5）**：面板 Stop 按钮是禁用占位——`hub agent kill` /
      `jobs cancel` 的宿主 IPC 未加（能力在 pi 侧 pub，成本低，待定）。

## 工具（`scripts/`）

| 脚本 | 用途 |
|---|---|
| `node scripts/cdp-probe.mjs [--reload]` | 连真窗口（CDP 9222）抓控制台/异常，`--reload` 刷新后抓 8s |
| `node scripts/cdp-shot.mjs` | 真窗口截图 → `.tmp-tauri-window.png` + 正文转储 |
| `node scripts/cdp-click.mjs` | 按 CDP 点击页面元素（当前写死跳过引导按钮，用时改） |
| `node .tmp-*.mjs` 均依赖 `ws` devDep 与 `additionalBrowserArgs`（tauri.conf.json）|

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

- **v8.0 换栈后的新坑（2026-10-14，全部有实锤）**：
  1. **dockview 官方 CSS 必须显式 import**（`main.tsx`：
     `import 'dockview-react/dist/styles/dockview.css'`）——漏掉则
     `.dv-*` 定位规则全缺，三组渲染成垂直堆叠裸 div（"内容全错位"根因）。
  2. **样式域 .flexlayout-host → .dockview-host**：flexlayout 时代的
     宿主域规则（rail-logo 等）在 dockview 下全部静默失效（logo 350px
     无圆角实锤）——改规则或改域名，别只在旧域加新规则。
  3. **vite watch 必须排除 `crates/**`**：N1 的 agent-protocol 有独立
     `target/`，cargo 锁 `build_script_build-*.exe` 时 chokidar EBUSY
     杀死 vite → CEF 窗 ERR_CONNECTION_REFUSED（vite.config.ts 已配）。
  4. **CEF 的 CDP 端口走 `Cef::remote_debugging(RemoteDebugging::Port)`**
     ——只传 `command_line_arg("remote-debugging-port")` 在 release 下
     无效；且 **`Local State` 文件持久化 `devtools.remote_debugging.
     allowed`**——历史 Disabled 态跑过再改 Port 会被持久值挡住，删
     `%LOCALAPPDATA%\com.mirach.harness\cef\Local State` 即恢复。
  5. **CEF 二进制必须与 exe 同目录**：dev = 从
     `%LOCALAPPDATA%\tauri-cef\<ver>\cef_windows_x86_64\` 拷进
     `target/debug/`（清过 build cache 后必补，否则 "Invalid file
     descriptor to ICU data"）；**打包 = tauri-cli 3 自带 CEF 集成
     自动处理**（cli bin 内含 "failed to copy CEF file for NSIS bundle"
     逻辑），**不要**再手动 resources 拷 cef-bundle（双重冗余实锤）。
  6. **cargo 必须与 cmake 同 PATH**（cef-dll-sys 构建脚本直接找 cmake）：
     `set "PATH=%USERPROFILE%\miniconda3-mirach\Library\bin;%PATH%"` 后
     再跑 npm run tauri build/dev。
  7. **窗口最大化"闪烁回来"的根因是自家 `fit_to_monitor`**：最大化窗
     高≈工作区恒大于旧阈值（工作区-EDGE），250ms 防抖后 set_size 缩回。
     已加 `is_maximized` 守卫（main.rs）；**不是** Tauri3/CEF 的问题。
  8. **前端窗口命令的权限面**：capabilities/default.json 列 white-list
     ——`maximize`/`unmaximize` 未授权（`toggleMaximize` 已授权），
     报错形如 "window.maximize not allowed"；加命令先加权限。
9. **CEF `setSize` 到相同尺寸是 no-op**（2026-10-14 实锤）：API 返回
     成功、`innerSize()` 也报目标值，但 viewport 不发生实际 resize——
     窗口曾被压小后想恢复原尺寸，单次 setSize 到"当前 API 所报值"无效
     （viewport 卡在 1500×950 而 API 报 1800×1000）。**恢复路径 = 先设
     一个不同值（如 1600×900）再设目标值**，强制触发 CEF resize。
10. **最小化陷阱的观察值**：B 代理轮实测窗口被压到 160×28（同 AGENTS
     既有的"minimized WebView2 reports 160×28"现象，CEF 下同样出现）；
     遇此按上一条两步法恢复。
11. **"最底层黑页面"/四角黑楔 = CEF 页面画布本身**（2026-10-15 品红实验
     实锤）：CEF windowed 不支持透明绘制（tauri-runtime-cef webview.rs:161
     原文——transparent painting exists only in off-screen rendering），
     页面画布恒不透明、基色 #1F1F1F（像素 31,31,31）。html/body 必须透明
     （.app-shell 圆角技巧前提），黑楔就从圆角外露出。**修复 = SetWindowRgn
     物理裁圆**（main.rs win_shape 模块：CreateRoundRectRgn(0,0,W+1,H+1,80,80)
     ——注意 +1，r=40 直径 80；Resized/ScaleFactorChanged/托盘恢复三处重设；
     最大化清空（NULL region），配套 CSS `html[data-maximized='true']
     .app-shell{border-radius:0}` 由 window-controls 写 dataset 联动）。
     圆角半径与 base.css .app-shell 的 40px 同值，改一处必须改两处。
     另有 winit undecorated shadow 激活后顶行 1px 深灰线（227,227,227）：
     WM_NCCALCSIZE 的 rgba[0].top+=1 必然现象（winit 源码注释），非 bug。
12. **dockview 布局存档按比例记宽**：窗口被 resize（哪怕外部 SetWindowPos）
     存下的 size 是比例，恢复窗口尺寸后三栏不会回到 350/1100/350，而是
     按存储比例铺——要恢复出厂布局就删 localStorage
     `mirach.harness.layout.v9` 再 reload（布局存档只存 ratio 不存 px，
     参考 fromJSON 后的归一行为）。
13. **布局 fromJSON 手术必须持护栏**（2026-10-16 两天两实锤）：dockview
     `fromJSON` 内部先 `clear()`——逐面板 `onDidRemovePanel` **同步**外发。
     shell 的 `handlePanelRemoved` 看见「末签关闭」就 `restoreOpenAnchor`
     → `addPanel(referencePanel:'workspace')` 打进半清树 → 抛
     `referencePanel 'workspace' does not exist` 且整树搅成空组。两个
     案发现场：「默认布局」复位、**隐藏面板栏（面板列里有实签时）**。
     修复 = `holdLayoutSurgery(fn)` 包住一切 fromJSON 手术（column-ops），
     shell 生命周期 handler 读 `layoutResetInProgress()` 让位。**新增任何
     fromJSON 调用点都要包**。
14. **winit 的 dragging 标志会被"没有物理按键的 startDragging"毒死**
     （2026-10-16 排查实锤）：`WindowMessage::StartDragging → winit
     handle_os_dragging` 里 `if !guard.dragging { dragging = true } else
     { return }`——标志只在 `WM_EXITSIZEMOVE` 复位。CDP 合成 pointerdown
     触发 `startDragging`（无物理按键）→ OS 不进模态移动循环 → 标志永卡
     true → **之后所有顶栏拖拽全部静默失效**（JS 链全通、窗口不动）。
     **判定命令必须用物理级输入**（PowerShell mouse_event 全序列），
     合成 `startDragging` 只能用于验证 JS 调用链，不能用于外观/行为判定；
     实例被毒后重启即愈。
15. **CDP 动态 import 的项目模块 ≠ 页面静态 import 的实例**（2026-10-16
     测试假象实锤）：`import('/src/.../x.ts')`（无 `?t=` HMR 时间戳）在
     vite 下是**第二个模块实例**——模块级变量（护栏 depth、api 单例）不
     共享，行为验证会得到假失败。**行为验证走真实 UI 路径**（真鼠标点菜单
     → 页面自己的模块图）；只在纯函数探针里用动态 import。
16. **beUI Tooltip 与 Radix asChild 链的嵌套序**（2026-10-16）：Tooltip
     必须在外层（`<Tooltip content><DropdownMenu.Trigger asChild><button>
     …`）——两层 asChild 逐层克隆到 button；反序（Trigger 包 Tooltip）会把
     Tooltip **组件**当 DOM 节点克隆，菜单事件全丢。Tooltip 包
     SharedLayoutBg 的行（入口条）也不行：它按直接子元素 clone 注入 pill，
     行壳被包成 Tooltip 后 pill 不渲染——入口条保留原生 title=。
17. **main.tsx 样式 import 必须先于 app 图 import**（2026-10-16 实锤）：
     ESM 按 import 序深度优先求值——`import './styles/tokens.css'` 在
     `import { App } from './app'` **之后**时，app 图（含 ease.ts 顶层的
     getComputedStyle 令牌读取）先求值，此时 `<style>` 还没注入 → 全部
     **静默回退内置值**（回退值与令牌同源，零可见症状；改 tokens.css
     不生效 = 唯一实锤路径）。已修（样式 import 全部提到 app import 前、
     相对顺序照旧）；ease.ts 令牌缺失现在 console.error 可见。**验证法**：
     落盘改一个 --beui-spring-*-dur → reload → CDP 量动画时长是否随动
     （勿用 Page.addScriptToEvaluateOnNewDocument 注入证明——document-start
     注入绕过此序，会假 PASS）。
18. **CSS 注释里禁止半角「星号紧跟斜杠」连写**（2026-10-16 实锤，已踩两次）：
     tokens.css 的 hub 段注释写了 `panes/hub/*，`——其中的 `/*` 在注释内部
     **再次开启注释**（CSS 注释不嵌套）；tailwind.css 的 `duration-*/ease-*`
     同理（`*/` 提前闭合）。后果极隐蔽：**整个 `:root` 块被解析器丢弃**，
     表现为「tokens.css 第一个 :root 里的令牌全部 undefined」——本次实测
     12 个 :root 只进 11 个，`--text/--surface/--brand/--stroke/--tab-font-size/
     --tab-pad-x/--logo-strip-h` 全部失效（`var(--x, fallback)` 恒取 fallback）。
     **排查法**：`var(--token, 777px)` 探针看是否恒为 777；或数 CSSOM 的
     `:root` 条数 vs 文件里的 `/*` 配对。**替写法**：`panes/hub 目录`、
     `duration- 与 ease- 工具类`。本会话加了脚本级自检（见手册"工具"段）。
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

## 轮次演变史

已归档 `docs/history-rounds.md`（生产就绪收口/elements 接线/会话管理对标/侧栏重审计/对标续/排版/标签溢出定稿+双行块对齐 逐轮细节）。
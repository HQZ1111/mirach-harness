# MIRACH 架构（当前态）

> 本文只写**现在是什么**。已完成的迁移过程（flexlayout→dockview、
> Tauri 2→3、CEF 试验）不再保留叙述；换栈留下的**约束与陷阱**在
> `AGENTS.md`。布局语义另见 `docs/layout-design.md`，pi 集成见
> `docs/pi-integration.md`。

## 0. 技术栈

| 层 | 选型 | 备注 |
|---|---|---|
| 壳 | Tauri **3.0.0-alpha.4** + `tauri-runtime-wry` **3.0.0-alpha.4** | Windows = WebView2；v3 把 webview 后端外置成 runtime crate，Builder 必须显式 `.runtime(Wry::default())` |
| 布局 | **dockview-react 8.5.1** | 存档键 `mirach.harness.layout.v10` |
| 前端 | React 19.3 / TS 5.9.3 / Vite 7.3.6 / Tailwind 4.3.3 | |
| 状态 | Zustand 5.0.15 · XState 5.33.2 · TanStack Query | |
| 聊天 | assistant-ui 0.15.22 | |
| 引擎 | pi_agent_rust 0.5.1（vendored） | nightly-2026-08-31（`src-tauri/rust-toolchain.toml`） |

**CDP 端口 9223** 由 `tauri.conf.json` 的 `additionalBrowserArgs`
（`--remote-debugging-port=9223`）开启；`tauri.prod.conf.json` 里该值为空。

## 1. 分层总图（L1 → L5）

```
L1 前端（React+TS，纯投影，只渲染不持真相）
  Dockview（布局容器）· assistant-ui（Thread/Composer/ToolCard/Thinking）
  shadcn/ui（vendor 单一源码，业务改动走 wrapper）
  状态层（分层消费 · 单向派生）：
    Zustand = UI 真相 ⭐        TanStack Query = 缓存（非真相）
    XState actor = run 生命周期投影（tool call 生命周期 / 审批镜像 /
      extension UI 请求；写入路径 channel.ts → SeqTracker → 派发）
    ExternalStoreRuntime 喂 assistant-ui → TokenStream Store（纯 append +
      按 runId/toolCallId 索引；AgentEventKind 类型系统强制；run end 清空）
  API 封装层：ipc.ts（InFlightMap）· channel.ts（SeqTracker + onmessage 分流）
L2 桥接层（双通道正交，判据 = 是否属于 Agent 循环）
  ① AG-UI HTTP+SSE（axum，绑 127.0.0.1:0 + token，端点经 IPC 下发）
  ② Tauri IPC（本地完全信任：会话 CRUD / UI 上下文 / 窗口/文件/通知）
L3 Rust 应用层（src-tauri）
  agui.rs（HTTP+SSE + 映射器）· AppState · pi_session.rs（多柄引擎）
  ApprovalRegistry（审批真相⭐）· fs/terminal/session_meta 等命令面
L4 Pi SDK（pi_agent_rust）—— 会话真相⭐（JSONL / segmented store）
L5 移动端（Tauri v2 Mobile）—— 未做
```

## 2. 唯一真相源总表（每类数据恰一个权威持有者）

| 真相 | 持有者 | 其余皆是投影 |
|------|------|------|
| UI 状态 | Zustand（唯一 store） | 组件 selector 订阅，禁止旁路写 |
| run / tool call 生命周期 | XState actor（唯一事件消费者） | channel.ts 只派发（经 SeqTracker），state 拒绝重复 |
| 会话消息/分支/compaction | **Pi SDK（JSONL）** | 前端 hydrate 只读（`pi_get_session_messages`） |
| 业务数据 | 宿主侧（Usage/token 等） | 前端缓存 invalidate |
| 审批态 | ApprovalRegistry（Rust，list/respond/cleanup） | 前端卡片是镜像，重放流不复活已应答卡 |
| Agent 事件传输序 | AG-UI `seq`（per-run 单调） | 前端按序 append，乱序走 SeqTracker |
| **流游标（lastEventId）** | **Rust 缓冲（`pi_stream_cursor`）** | 前端只在 attach 时读一次作起点，不持推进权 |
| 布局 | dockview JSON（v9）+ colflags.v1 | toJSON 快照，非真相 |

**判定规则**：任何字段出现两个写入者 = 违反本表，改设计不改实现。
非真相层必须能用真相层重算（水合路径覆盖全字段）。

## 3. L2 双通道

| 通道 | 用途 | 端点/命令 |
|------|------|------|
| AG-UI HTTP+SSE | Agent 循环 | `POST /ag-ui`（发消息，返回 run 结果）· `GET /ag-ui/stream`（SSE 事件流，支持 `lastEventId` 续流）· `GET /healthz` |
| Tauri IPC | 一切非 Agent 循环 | `get_agui_endpoint` · 会话 CRUD（`pi_list_sessions` / `pi_open_session` / `pi_rename_session` / `pi_delete_session` / `pi_discard_session`）· `pi_get_state` / `pi_get_messages` / `pi_stream_cursor` · 中断与审批（`pi_interrupt` / `pi_pending_approvals` / `pi_extension_ui_response`）· 设置/资源 · `fs_*` · `terminal_*` · `session_meta_*` |

**中断/审批走 IPC，不走 AG-UI**：`pi_interrupt`（含分栏定向 `thread` 参数）、
审批信号以 `CUSTOM extension_ui_request`（只带 `{id}`）piggyback 在唯一 GET 流上，
前端据此拉 `pi_pending_approvals`（Rust `ApprovalRegistry` 是真相），应答走
`pi_extension_ui_response`。

A2UI `$action` 按 `target` 分流：`agent` → AG-UI；`client` → 本地消化或 IPC。

**鉴权**：AG-UI 用 Bearer token（启动时生成，经 `get_agui_endpoint` 下发）；
IPC 是本地完全信任通道（前端永不 `innerHTML` agent 产出——这是该前提成立的条件）。

## 4. L1 事件时序

```
1. 生成 runId
2. 建 EventSource（lastEventId = pi_stream_cursor 给的缓冲最新 seq）
3. POST /ag-ui 发消息
4. 事件到达 → reduceAguiEvent（纯函数）→ TurnMessage/parts
   ├ TEXT_MESSAGE_CONTENT → 追加/合并最后 text part
   ├ CUSTOM tool_execution(start) → push 工具调用部件（args 来自 start）
   └ CUSTOM tool_execution(end) → 按 toolCallId 填 result/isError
5. RUN_FINISHED / RUN_ERROR → 清轮次态
```

**铁律**：AG-UI 事件流只喂轮次机；UI 组件只读态、只发 transition，不旁路订阅。
`reduceAguiEvent` 是纯函数（可单测，`turn-actor.test.ts` 45 例）。

## 5. 布局层（dockview）

**三栏**：[左栏 | 主栏 | 面板栏]。左/主栏组 `hideHeader`（无标签条），
面板栏是唯一多标签列。出厂布局 = `factoryLayout(容器宽, 容器高)`
（`dockview-column-ops.ts`）——两轨默认宽 **300**、许可 **270–400**（定值，不随
窗口缩放；口径单源在 `layout/rail-metrics.ts`），主栏吃剩余。

**栏动词**（右键菜单 / 命令面板）：

| 动词 | 实现 |
|---|---|
| 隐藏/打开左栏、面板栏 | 宽度补间到 0（组常驻，从不摘除）+ 收起态 `0..0` 约束盒 |
| 位置切换 | `colOrder` 条目移动 + `groupApi.moveTo` + FLIP 动画 |
| 默认布局 | `fromJSON(factoryLayout(...))`（必须包 `holdLayoutSurgery`）+ 双轨按比例钉回 |

**收放约束盒**：收起态 = `{min:0, max:0}`。只放开 min 不够——0 宽但 max 仍为
MAX 的列会被 `Sizing.Distribute` 的 `addPanel`（分栏/开新签）重摊出宽度。
状态机在 `layout/column-constraints.ts`，详细理由与三条实锤坑见该文件头。

**打开页生命周期**：面板列有实签 → 撤 `open` 锚；末签关闭 → 锚回来。
`fromJSON` 内部先 `clear()`（同步外发 `onDidRemovePanel`），所以一切 fromJSON
手术必须包 `holdLayoutSurgery(fn)`，否则生命周期反应会把 `addPanel` 打进半清树。

## 6. L3 命令面（src-tauri）

| 模块 | 内容 |
|------|------|
| `agui.rs` | axum 路由 + AG-UI 映射器 + 环形缓冲 + 审批注册表；内嵌 53 个 Rust 单测 |
| `pi_session.rs` | 多柄引擎（`side_engines` 按 thread 分柄 / 定向中断 / 按路径路由） |
| `pi_settings.rs` | settings/models/auth 三个配置文件的读改 |
| `pi_resources.rs` | skills/prompts/extensions/packages 只读列举（走 pi 自己的 loader） |
| `session_meta.rs` | pinned/archived/水位/折叠 → `app_data_dir/session-meta.json`（原子写） |
| `window_state.rs` | 窗口几何记忆 → `app_data_dir/window-state.json`（原子写；坏档/离屏判废） |
| `fs.rs` | 文件树数据源 + `fs_git_diff_stat` |
| `terminal.rs` | PTY（portable-pty）+ 输出/退出走 Tauri Event |
| `main.rs` | 窗口/托盘/非客户区与阴影/AG-UI 启动/命令注册 |

## 7. 窗口与外壳

- **首屏尺寸按屏幕工作区算**（照搬 hermes，2026-10-22）：工作区 × 0.88，
  夹在 **1280×820 ~ 1760×1100**；工作区比下限还小时以工作区为准。
  `tauri.conf.json` 里的 width/height 只是创建占位，setup 里改定后再居中。
  早先是写死 1800×1000 + "装不下就最大化"，那条分支已删（比例公式自己就
  落在屏内，最大化反而吃掉整个工作区）。
- **窗口几何存档**（`window_state.rs`，hermes `window-state.json` 语义）：
  x/y/width/height/isMaximized 存 `app_data_dir/window-state.json`（原子写）。
  启动**存档优先、公式兜底**；坏档/非法尺寸判废、离屏坐标丢弃改居中
  （`MIN_VISIBLE = 48` 的重叠判定）。尺寸/位置变化 400ms 防抖落盘，✕ 关闭
  时立即刷一次；最大化/最小化态只翻标志位、不存退化 bounds。
- **无边框 + 圆角由 CSS 绘制**：`main.rs` 的 `win_shape::sync_round_region`
  按顺序做五件事（幂等，Resized/DPI/托盘恢复都调）：
  ⓪ wndproc 子类化（`subclass`）——`WM_NCCALCSIZE` 不再内缩客户区；
  ① `DWMWA_NCRENDERING_POLICY=ENABLED`（**系统阴影的唯一来源**，
  `shadow:true` 对无边框窗口无效）；② `DWMWA_WINDOW_CORNER_PREFERENCE=
  DWMWCP_DONOTROUND`（主动关掉 DWM 圆角，把圆角让给 CSS）；
  ②b `DWMWA_BORDER_COLOR=COLOR_NONE`（抹掉 Win11 那圈 1px 描边）；
  ③ `SetWindowPos(SWP_FRAMECHANGED)`；④ `DwmExtendFrameIntoClientArea{-1,…}`；
  ⑤ 重装 `DwmEnableBlurBehindWindow` 空 region。
- **⓪ 子类化为什么必需**：tao 对 undecorated 窗口仍按 `SM_CXFRAME` 内缩客户区
  （`event_loop.rs:2114-2122`），客户区比窗口矩形每边小 7-8px。除了画布留边，
  它还会让 tao 的 `set_inner_size` 带上 `window_rect − client_rect` 偏移
  （`window.rs:249-262`）→ **几何存档逐轮膨胀**（实测 1760 → 1824 → 1872）。
  所以 `install()` 必须在 setup 里任何 `set_size` **之前**。
  运行时自检：`subclass::check_client_matches_window`。
- **②b 描边为什么必需**：Win11 给每个顶层窗口画 1px 描边，**按窗口矩形直角
  走**，不跟随 CSS 圆角——用户看到的就是"圆角处有黑线的直角边"。
  该属性只写不读（`DwmGetWindowAttribute` 恒 E_INVALIDARG）。
  与阴影、CSS 都无关：关掉 NCRENDERING 后线仍在，改 CSS 背景色也不变。
- **圆角同心**：壳 `--radius-shell` = 卡片 `--radius-pane`(25) +
  窗边内缩 `--pane-edge`(10) = 35px。DWM 系统圆角固定 ~8px，两者并存会把
  35px 裁成 8px，所以必须 DONOTROUND。
- **CSS 大圆角可行的前提**：wry/WebView2 窗口真透明（tao 用
  `DwmEnableBlurBehindWindow` + 空 region）。实测 CDP 截图 alpha 通道：
  弧外 A=0、弧上 A=217（抗锯齿半覆盖）、弧内 A=255。
- **托盘**：✕ = 隐藏到托盘（ZCode `closeToTrayOnWindows` 语义），真退出走托盘菜单。
- **最大化**：`fit_to_monitor` 有 `is_maximized` 守卫（否则 250ms 防抖会把窗口缩回）；
  CSS 侧 `html[data-maximized='true']` 把圆角清零。

## 8. 未做（架构侧）

- **L5 移动端**：`MobileSink`（无 Replayable）与契约测试未做。
- **agent-protocol crate**：`crates/agent-protocol` 已有骨架与 serde 往返测试，
  但 L3 命令面仍以 `agui.rs` 的现有形状为准（迁移未开始）。
- **分级传输**（>8KB 走 IPC Queue + token）：未做，当前事件都走 SSE。

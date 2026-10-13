# MIRACH 架构方案 v9.0（2026-10-14 · Agent-Native：唯一真相源 + Tauri 3 原生双通道）

> **状态**：换栈（M1/M2/M3）已落地——dockview 布局、Tauri 3.0.0-alpha.4、
> 官方 tauri-runtime-cef（CEF 152.3.0）窗口实跑（§0-§6）。**§7-§14 是
> 本轮新增的 Agent-Native 架构**（协议层 agent-protocol / 真相源分层 /
> 双通道与 SeqTracker / Sink 契约 / 移动端），代码未动，按此逐项移植。
> 本文取代 layout-design.md（v7.x flexlayout 时代）成为架构主文档。

## 0. 换栈决定（用户 2026-10-06）

| 层 | 现状（v7.x） | 目标（v9.0） | 动机 |
|----|------|------|------|
| 壳 | Tauri + wry(WebView2) | **Tauri 3.0.0-alpha.4 + 官方 CEF runtime** | WebView2 行为绑定 Windows/Edge 版本；CEF 自带全量 Chromium，跨端一致、协议可控（§1） |
| 布局 | flexlayout-react 0.11 | **dockview-react 8.5.1** | flexlayout 语义补丁越打越多；dockview 原生 docking/分组/序列化（§2） |
| 引擎 | pi_session.rs 多柄（v7.5） | **不变**（平移） | 多柄并发/定向中断/按路径路由已是栈无关设计（§3） |
| 传输 | axum HTTP+SSE 桥 + token 鉴权 | **Tauri 原生双通道**（invoke + Channel） | HTTP 桥是自建中间层；原生通道去掉端口/token/端点发现（§8） |
| 协议 | 事件形状内联在 agui.rs | **agent-protocol crate（L3.5）** | 类型系统强制 `tool_call_id`、序列号、协议版本；nightly 污染不外泄（§9） |

## 1. Tauri + CEF：现状与路径

### 1.1 Tauri

- **现状**（2026-10-12 查实）：crates.io tauri = **3.0.0-alpha.4**（Rust 核
  心最新 alpha）；npm @tauri-apps/api = 3.0.0-alpha.2（alpha 线最新——npm 侧
  版本线独立于 Rust 侧，alpha 期核心跑在 npm 包前面）。M2 配对 = 核心
  alpha.4 + npm alpha.2（最新各自侧）。
  权限系统沿用 capabilities 模型；
  IPC 层重写（自定义协议 → 更快的 JSON/二进制通道）；插件 API 稳定化。
- **本工程的迁移清单**：tauri::Manager（窗口/托盘）、
  自定义命令 18+（走 Tauri invoke 原生通道——见 §3.5）。

### 1.2 CEF（2026-10-13 实做：官方 runtime crate，**非** wry 分叉）

- **v3 alpha 的后端选择面**：tauri 主 crate 不含 wry/tao——webview 后端
  外置成 **runtime crate**，Builder 必须显式 `.runtime(attrs)` 选，默认
  DynRuntime 无属性即 panic `RuntimeNotConfigured`（M2 实测）。
- **官方已有 CEF 运行时**：`tauri-runtime-cef` 3.0.0-alpha.5（crates.io，
  与 tauri-runtime-wry 3.0.0-alpha.4 同级）。`Cef` 实现 `RuntimeInitAttrs`、
  `CefRuntime` 实现 `Runtime<T>`——**与 wry API 对称**，换栈 = 换依赖名 +
  一个构建器参数。**本文原定「wry 分叉加 CEF 后端」方案作废。**
- **构建工具链前置**：`cef-dll-sys` 构建脚本用 CMake 下载并构建 CEF
  152.3.0，需要 **cmake + ninja + MSVC C++**。本机解法 = Miniconda 通道
  装 cmake 4.3.1 + ninja 1.13.2 + VS2026 BuildTools MSVC 14.51。
  **坑：cargo 必须与 cmake 同一 shell（同 PATH）**——构建脚本直接
  `running: "cmake"`，PATH 不含即 abort（本机踩过两次）。
- **运行期前置**：CEF 二进制（libcef.dll / chrome_elf.dll / icudtl.dat /
  v8_context_snapshot.bin / …）必须**与 exe 同目录**（或命中 CEF 搜索
  路径），否则 `STATUS_DLL_NOT_FOUND (0xc0000135)`。dev 态 = 从
  `target/debug/build/cef-dll-sys/*/out/cef_windows_x86_64/` 拷进
  `target/debug/`；生产 = 打进安装包（M4 打包项）。
- **入口宏**：CEF 多进程（renderer/GPU 子进程）靠
  `#[tauri_runtime_cef::cef_entry_point]` 标注 main 分派。
- **CDP 冒烟**：`tauri.conf` 的 `additionalBrowserArgs` 是 **wry 参数、
  CEF 下无效**；CEF 走 `Cef::default().command_line_arg("remote-
  debugging-port", Some("9223"))`（CEF 原生同名开关）——E2E 脚本零改动。
- **CEF 沙箱**：上游注明 Windows 当前**一律无沙箱**运行（CEF 要 sandbox
  broker，而 Tauri 应用不是 CEF 自带 bootstrap.exe 宿主）——Windows 本就
  无应用沙箱语义，Linux 才需留意。
- **并行能力与渲染后端无关**：多会话并发在 Rust 引擎层（`side_engines`
  按 thread 分柄）+ 前端分栏层（各 panel 自己的 runtime），换 wry/CEF
  只换渲染壳。v7.5 的多柄并发 E2E 在两个后端下都成立。

### 1.3 迁移期间的开发态

vite 1430 dev server 不变（CEF 窗与 WebView2 窗都加载同一 dev server）；
CDP 冒烟脚本（9222/9223）在 CEF 下经 `Cef::command_line_arg` 下发同名
参数——E2E 脚本零改动。

## 2. 布局层：dockview（语义文档 = layout-v8.md）

### 2.1 概念映射表（flexlayout → dockview）

| flexlayout 概念（v7.x） | dockview 对应 | 平移说明 |
|------|------|------|
| Model / toJson / fromJson | DockviewApi.toJSON()/fromJSON() | 布局序列化/恢复原生支持 |
| TabSetNode | GroupPanel（group） | 页签组 |
| 根行 RowNode（水平） | dockview 的根 grid | 分栏 = grid 的行/列嵌套 |
| tab（页签） | Panel（panel id） | 每个会话/文件树/终端 = 一个 panel |
| Actions.moveNode | api.movePanel / group.moveToPanel | 移动面板 |
| Actions.addNode | api.addPanel({ position }) | 加面板（referencePanel + direction） |
| Actions.deleteTab | api.removePanel | 删面板 |
| 边缘投放 | dockview 原生 drop overlay | 内置 droppable 高亮 |
| 浮动 | floating groups（原生） | flexlayout 无此能力，dockview 免费 |
| popout 窗口 | popout windows（原生） | 同上 |
| 可见性/序列化守卫 | onWillLayoutChange/onDidChange + 序列化白名单 | 语义戳/根面板校验挂这里 |
| 右键菜单（自建） | api 自管或 DockviewReactPanelProps | 我们的 app-context-menu 不变 |
| ITabRenderValues（自绘） | panel/tabComponent 参数 | 图标/标题自定义照搬 |

### 2.2 语义模型（**详见 layout-v8.md**——三栏无标签/面板栏唯一多标签/工作区名容器子元素）

以下语义与实现载体无关，换栈只换 API 调用点：

1. **三栏语义归属**：left/chat/panels 语义戳 → dockview panel 参数
   `params: { region }`；主窗格优先（workspace/leftrail/open 定区域）。
2. **根面板唯一**：打开页（open panel）所在 group = 面板栏；动词只作用
   根面板列；子栏独立（拖空自己关）。
3. **colOrder 恒 3 项**：位置记录（含隐藏列）照搬；侧别结算（左栏优先/
   同侧让位）改调 dockview api.moveGroup。
4. **条显隐 ladder**：搁浅 > 手动 > 自动 ≥2 > siblingMainZone——dockview
   的 group 没有"隐藏条"概念（group 总有 tab 头），条显隐改为
   `api.updateGroupParam({ tabStripHidden })` 自定义扩展或 CSS 隐藏。
5. **会话分栏独立运行时**（v7.4）：panel component 'session' 绑定
   useThreadChatRuntime(threadId)——栈无关 ✓ 原样平移。
6. **多柄引擎**（v7.5）：side_engines 表/定向中断/按路径路由——Rust 层
   与前端布局库解耦 ✓ 原样平移。
7. **边缘 20px 留白**：dockview 的 panel 视图容器加 padding（贴边判定
   逻辑照搬）。

### 2.3 dockview 侧需要自建的（flexlayout 白得、dockview 也要写的）

- 虚拟化大列表在 panel 内（与布局库无关）
- 语义戳校验器：onWillDrop 阻止非法跨区（files 只能 panels/chat 等）
- 根面板守卫：open panel 不可关（dockview 的 removePanel 拦截）

### 2.4 dockview 换栈的不变式

- 布局 JSON 存储键 v9（dockview 序列化格式，不复用 v8）——迁移时旧档
  废弃不迁移（用户布局重建成本 < 格式映射成本）
- colflags.v1 / colstash.v1 语义平移（colOrder/隐藏列快照照旧）
- 语义戳存 dockview panel params ✓ 序列化自动带

## 3. 引擎层（Rust）：平移清单

pi_session.rs 多柄（v7.5）与 Tauri/CEF/dockview 全解耦，逐项：

- side_engines 表 / side_open / side_prompt / side_interrupt：**不变**
- POST /ag-ui sessionPath 路由：**不变**（HTTP 层，CEF 下走 CefRequestHandler
  或保留 axum on 1430 端口——CEF 窗照常 fetch localhost）
- pi_stream_cursor thread 参数：**不变**
- pi_get_session_messages 按路径水合：**不变**

CEF 窗下 invoke 通道走 CEF 的 V8 绑定（cef-rs 的 CefV8Handler 桥接
Tauri command——或保持 HTTP invoke 走 axum，V8 只做 window.invoke 薄壳）。
**推荐后者**：invoke 走 HTTP（与 SSE 同源同鉴权），CEF 侧零桥接成本。

## 3.5 L2 原生 IPC 化（Tauri 3 双通道：axum 整层废除）

> **本节是 2026-10-12 的初步裁定（agui_run 两命令面）。2026-10-14
> Agent-Native 定稿后，命令面以 §10（四模块拆分 + InFlightMap + Channel
> 按 run 分实例 + SeqTracker/时序固化 §11）为准**——本节只保留"废除什么"
> 的清单依据，不再定义新面。

**Tauri 3 的 IPC 双通道**（invoke 请求-响应 + Channel 双向流）取代 axum
HTTP+SSE 桥——L2 从"自建 HTTP 服务器 + token 鉴权 + 端点发现"瘦身为
**纯 Tauri command 调用**。

### 废除清单（axum 桥的全部面）

| v7.x（axum 桥） | v8.0（Tauri 原生） | 删除的代码 |
|------|------|------|
| POST /ag-ui?token=… {threadId,sessionPath,message} | `invoke('agui_run', { threadId, sessionPath, message })` | HTTP fetch + token 拼接 |
| GET /ag-ui/stream?thread=X&lastEventId=N（SSE EventSource） | `Channel<Message>` 传入 command，Rust 端逐事件推送 | EventSource + lastEventId 游标 + 断线重连逻辑（Channel 由 Tauri 管理生命周期） |
| get_agui_endpoint（端口/token 发现） | **废除**（无 HTTP 层即无端点） | 整个命令 |
| token 鉴权（check_token / 401 路径） | **废除**（Tauri IPC origin 隔离，无 token 需求） | 鉴权面 |
| ThreadBuffers 环形缓冲（per-thread 分桶 + seq） | **视场景保留或直推**（见下） | 视断线重连需求裁定 |
| 1430 端口 axum 路由表 | **废除**（axum 依赖整体移除） | agui.rs 的 HTTP 层 ~200 行 |

### 保留/改造清单

| 组件 | 处置 |
|------|------|
| PiEngine 多柄（side_engines / side_open / side_prompt / side_interrupt） | **不变**（Tauri command 直接调引擎方法） |
| 映射器 AgentEvent → AG-UI | **不变**（事件形状是前端轮次机契约） |
| RUN_STARTED on_start 回调 | **不变**（语义：STARTED 在真实起跑前推） |
| sessionPath 路由（POST 切会话） | **不变**（command 参数直传） |
| ThreadBuffers 环形缓冲 | **两案择一**：A) 保留——断线重连时 Channel 重发 replay（多柄柄存活期事件不丢）；B) 废除——Channel 直推、断线靠前端重水合（pi_get_session_messages 已按路径水合 ✓）。**推荐 B**：水合路径已覆盖状态恢复，环形缓冲的唯一价值（HTTP 断线续传）在原生 IPC 下不存在 |
| token/endpoint | **废除** |

### 新命令面（初稿，已被 §10.3 取代）

```rust
// ⚠️ 2026-10-14：此二命令面是初稿。Agent-Native 定稿的命令面 =
// §10.3 的四模块（actions/sync/config/ctrl），事件流走
// start_agent_event_stream + ResumeOutcome + SeqTracker（§10.3/§11），
// 不是"每 run 一个 Channel 绑在 run 命令参数上"。本段仅留作对照。
#[tauri::command] async fn agui_run(
    thread: String, session_path: Option<String>,
    message: String, images: Vec<AguiImage>,
    on_event: Channel<serde_json::Value>,
) -> Result<RunId, String>
#[tauri::command] async fn agui_interrupt(thread: String) -> Result<(), String>
```

前端：`invoke('agui_run', { ..., onEvent: new Channel() })`——Channel 回调
逐事件喂轮次机（替代 EventSource onMessage）。多柄并发 = 每分栏一个
Channel 实例（Tauri 原生支持多 Channel 并行 ✓）。

### 净收益

- **删除**：axum 依赖、HTTP 层 ~200 行、token 鉴权、端点发现、
  EventSource 生命周期管理、lastEventId 游标逻辑
- **消除**：端口占用/冲突、CEF 下的 HTTP 桥接成本（§1.2 的"推荐后者"
  不再需要——invoke 走 Tauri 原生通道，CEF 只需桥接 Tauri invoke 一个口）
- **简化**：Rust 侧 agui.rs 从 HTTP 服务器瘦身为纯命令处理；CEF 迁移
  难度骤降（M3 只剩 webview 渲染层的 CEF 化，IPC 已原生）

## 4. 迁移阶段（每阶段独立可验证）

| 阶段 | 内容 | 验证 |
|------|------|------|
| M1 | 布局库替换：flexlayout → dockview（语义全平移，Tauri/CEF 不动） | 现有全部 E2E（v73c/v73b/v73/v74b + 矩阵 350）改写后全绿 |
| M2 | Tauri 2.11 → 3.0.0-alpha.4（显式 `.runtime(Wry)`；JS 面零改动） | ✅ 5d8c3e7：窗口/invoke 冒烟全绿 |
| M3 | 官方 `tauri-runtime-cef` alpha.5（CEF 152.3.0；Miniconda cmake+ninja；CDP 经 `Cef::command_line_arg`） | CEF 窗 + invoke/SSE 全链 + CDP 9223 |
| M4 | 生产构建 + 打包（CEF 二进制随 exe 同目录分发） | 安装包冒烟 |

每阶段独立提交。M2/M3 实测结论（以 crates.io 实际版本为准，不钉死）。

## 5. 风险登记

| 风险 | 等级 | 缓解 |
|------|------|------|
| wry CEF 后端维护成本 | ~~高~~ **已消解** | 官方 `tauri-runtime-cef` crate——无需维护分叉，M3 实接跑通 |
| dockview 布局守卫不如 flexlayout 细 | 中 | onWillLayoutChange + 语义校验器自建（§2.3） |
| CEF 打包体积 +100MB | 低 | 产品级 CEF 分发是成熟做法（Steam/Spotify/Notion 同栈） |
| asupersync 并发 block_on（多柄已用） | 已验证 | v7.5 E2E 实测并行流式 ✓ |

## 6. 载体对照（v7.x → v9.0 文件映射）

| v7.x（flexlayout） | v9.0（dockview） |
|------|------|
| flex-layout.tsx（Layout 壳/工厂/onModelChange） | dockview-shell.tsx（DockviewReact 壳/onReady/onWillLayoutChange） |
| layout-presets.ts（出厂树） | dockview-shell.tsx 内 FACTORY_LAYOUT（dockview JSON） |
| constraints.ts / constraints-sync.ts | panel 级 minimumWidth/maximumWidth（组约束回落活动 panel） |
| column-ops.ts（栏动词/colOrder/根面板） | dockview-column-ops.ts（serialize 手术 + groupApi.moveTo） |
| drag-session.ts（指针拖拽接管） | dockview 原生 DnD（onWillDragPanel 准入拦截） |
| session-runtime.ts / session-thread-pane.tsx | **不变** |
| pi_session.rs 多柄 / agui.rs | **不变**（agui.rs 的 HTTP 层在 §8 迁移中废除） |

---

# 第二部分：Agent-Native 架构（v9.0 新增，代码未动）

## 7. 分层总图（L1 → L5）

```
L1 前端（React+TS，纯投影）
  Dockview（布局容器）· assistant-ui（Thread/Composer/ToolCard/Thinking）
  shadcn/ui（vendor 单一源码，业务改动走 wrapper）
  状态层（分层消费 · 单向派生）：
    Zustand = UI 真相 ⭐        TanStack Query = 缓存（非真相）
    XState actor = run 生命周期投影（tool call 生命周期 / 审批镜像 /
      extension UI 请求；写入路径 channel.ts → SeqTracker → 派发）
    ExternalStoreRuntime 喂 assistant-ui → TokenStream Store（纯 append +
      按 runId/toolCallId 索引；AgentEventKind 类型系统强制；run end 清空）
  API 封装层：ipc.ts（InFlightMap）· channel.ts（SeqTracker + onmessage 分流）
L2 桥接层（Tauri 3 原生双通道）
  ① invoke（请求-响应，InFlightMap 去重）  ② Channel（按 run 分实例，保序）
L3.5 Protocol 层（agent-protocol crate）
  AgentEvent{runId, seq} · ResumeOutcome · ExtensionUi/控制帧 · capability flag
L3 Rust 应用层（src-tauri）
  commands/{actions,sync,config,ctrl} + middleware(InFlightMap)
  ActionRegistry · ApprovalRegistry(审批真相⭐) · AppContext(Arc<ArcSwap>)
  Channel 句柄表(DashMap<runId,Ch>+AttachState) · AgentDelegate 队列(≤10)
  event-bridge(RunBuffer 8MB/run · 128MB 全局) · Snapshot/EventSink/Replayable
  SQLx（业务数据真相⭐）· pi-adapter（nightly 隔离层）
L4 Pi SDK（pi_agent_rust）—— 会话真相⭐（JSONL/segmented store）
L5 移动端（feature flag mobile）—— MobileSink（无 Replayable）
```

## 8. 唯一真相源总表（每类数据恰一个权威持有者）

| 真相 | 持有者 | 其余皆是投影 |
|------|------|------|
| UI 状态 | Zustand（唯一 store） | 组件 selector 订阅，禁止旁路写 |
| run / tool call 生命周期 | XState actor（唯一事件消费者） | channel.ts 只派发，state 拒绝重复 |
| 会话消息/分支/compaction | **Pi SDK（JSONL / segmented store）** | 前端 hydrate 只读（pi_get_session_messages） |
| 业务数据 | Rust SQLx（app_data_dir/agent.db） | TanStack Query 缓存 invalidate |
| 审批态 | ApprovalRegistry（Rust） | 前端卡片是镜像，重放流不复活已应答卡 |
| Agent 事件传输序 | agent-protocol 的 `seq`（per-run 单调） | TokenStream 按序 append，乱序走 SeqTracker |
| AppContext | AppState（Arc<ArcSwap<Ctx>>） | 前端 sync_app_context 推送副本 |
| 布局 | dockview JSON（存储键 v9）+ colflags.v1 | toJSON 快照，非真相 |

**判定规则**：任何字段出现两个写入者 = 违反本表，改设计不改实现。

## 9. L3.5 Protocol 层：agent-protocol crate（新建）

**职责**：前后端事件契约的单一来源。纯类型 + 序列化，**零 IO**（可单测）、
**不引用 pi**（nightly 污染不外泄，pi-adapter 做转换）。

```rust
// 核心类型（骨架；字段名以实现为准，类型约束必须保住）
pub struct AgentEvent { pub run_id: RunId, pub seq: u64, pub kind: AgentEventKind }

pub enum AgentEventKind {
    /// 模型文本输出。无 tool_call_id —— 类型系统保证不会张冠李戴。
    AssistantOutput { delta: String },
    /// 工具流式输出。必有 tool_call_id ⭐ —— 编译期强制。
    ToolOutput { tool_call_id: ToolCallId, delta: String },
    // 生命周期/控制帧同枚举或独立 enum，实现时定：
    // RUN_STARTED / RUN_FINISHED / RUN_ABORTED / RUN_ERROR
    // SNAPSHOT_RESTORED / RUN_ENDED_ACK / RUN_GONE
}

pub enum ResumeOutcome { Replayed, SnapshotRequired, RunGone }

pub struct ExtensionUiRequest { /* + protocolVersion */ }
pub struct ExtensionUiResponse { /* + protocolVersion */ }
```

**铁律**：
1. `ToolOutput` 必带 `tool_call_id`——构造时无 id 编译不过（pi-adapter
   转换处漏 id = 编译错误，不是运行期丢事件）。
2. `seq` per-run 单调递增，从 1 起；控制帧不占 seq（或独立序，实现时定）。
3. `protocolVersion` 随 ExtensionUi 往返校验（前后端协议漂移 = 显式错误）。
4. 移动端能力差异用 **capability flag** 表达（协议层声明，不做 cfg 散布）。
5. serde 序列化形状 = L1 TypeScript 镜像类型的唯一依据（手工镜像或
   ts-rs 生成，实现时定）。

## 10. L2 双通道（Tauri 3 原生）与 L3 命令面

### 10.1 通道分工

| 通道 | 方向 | 语义 | 纪律 |
|------|------|------|------|
| invoke | 前端→Rust | 请求-响应（动作/同步/配置/控制） | **统一走 InFlightMap**（无黑名单） |
| Channel | Rust→前端 | 事件流（按 run 分实例，独立 index 序列） | 保序；分级传输（§12） |

### 10.2 InFlightMap（前端 ipc.ts 与 Rust middleware.rs 同构）

- key = `method + ':' + hash(payload)` ⭐（approve_action 也走，key 含 payload hash）
- 仅 **in-flight 去重**，无 response cache；容量 1000（并发上限），
  打满 → `ERR_INFLIGHT_FULL`
- 清理 TTL 用**完成时间** ⭐；后台每 30s 清理

### 10.3 命令清单（按类拆模块）

| 模块 | 命令 |
|------|------|
| commands/actions | call_action · delegate_to_agent · approve_action（payload=ExtensionUiResponse+protocolVersion） |
| commands/sync | sync_app_context |
| commands/config | set_model · set_thinking_level · set_compaction_settings |
| commands/ctrl | **start_agent_event_stream**⭐ `{runId, lastSequence: Option<Seq>} → ResumeOutcome`（InFlightMap key=runId，lastSequence 作 payload 校验）· snapshot_applied · run_ended_ack · issue_token · get_agui_endpoint · 窗口控制 |

### 10.4 L3 组件职责

- **ApprovalRegistry**：审批真相 ⭐。`resolve(response)`：
  is_valid_response → protocolVersion 校验 → 类型驱动反序列化 →
  终态幂等兜底（已 resolved → AlreadyResolved）→ resolve oneshot。
- **AgentDelegate 队列**：上限 10，满 → `ERR_QUEUE_FULL`（前端 UI 提示
  + 重试）；FIFO（MVP）；统一走 InFlightMap。
- **event-bridge**：按 runId 写 Channel + RunBuffer（环形缓冲重放：
  8 MB/run，128 MB 全局；`latest_seq` 溢出后继续推进、events 清空、
  send() 不塞、replay() 无论 from 必返回 `SnapshotRequired`）。
- **Sink 三 trait**：`EventSink(send)` · `SnapshotSource(snapshot：
  缓存命中→JSONL 重建→RunGone)` · `Replayable(replay)`。
  **ChannelSink（desktop）impl 全部 3 个**；**MobileSink（feature flag）
  只 impl 前 2 个**——能力探测变成类型约束（编译期即知移动端不可重放）。
- **AppContext**：`Arc<ArcSwap<Ctx>>`（高频读低频写，读者无锁）；
  Channel 句柄表 `DashMap<runId, Channel>+AttachState`（防同 runId 重复 attach）。
- **pi-adapter**：唯一碰 pi 的 nightly 层。PiAgent(impl Agent) ·
  events 转换器（pi::AgentEvent → agent_protocol，ToolOutput 漏
  tool_call_id = 编译错误 + tracing::warn! 兜底）· session/lifecycle/tools ·
  extension_ui_handler（请求→event-bridge→Channel；响应←ApprovalRegistry）·
  pi_session_indexer（只读 header 更新 SQLx 索引：幂等/增量重建(mtime)/
  崩溃后重建/index_version）。

## 11. L1 状态层与事件时序（channel.ts / ipc.ts）

### 11.1 状态层纪律（lint 可查）

| 状态库 | 角色 | 纪律 |
|------|------|------|
| Zustand | UI 真相 ⭐ | 组件只经 Zustand 读 UI 态 |
| TanStack Query | 缓存 | 组件中**禁止直接 useQuery**（经封装层） |
| XState actor | run 生命周期投影 | 组件中**禁止直接 useActor**（经 selector/封装） |
| TokenStream Store | 轻量 ExternalStore | 纯 append + 按 runId/toolCallId 索引；run end 清空（无 orphan/attached） |

### 11.2 SeqTracker（channel.ts，⭐核心）

- `maxSeq` = 连续收到的最大 seq；`pendingBuffer: Map<seq, event>` 接乱序窗口
- 收到 `seq == maxSeq+1`：接受 + flushPending
- 收到 `seq > maxSeq+1`：入 pendingBuffer + 触发 `attachStream(maxSeq)`
- 收到 `seq <= maxSeq`：丢弃
- onmessage 分流：①SeqTracker 处理 → ②token/思考/stdout → TokenStream →
  ③tool 生命周期/审批/run → XState（send 语义，state 拒绝重复）

### 11.3 时序固化（每次 run）

```
1. 生成 runId
2. 创建 Channel + onmessage
3. attachStream(runId, null)（maxSeq=0）→ ResumeOutcome：
   ├ Replayed         → 等 Channel 推重放事件
   ├ SnapshotRequired → 起 5s 提示超时（不判 RunGone ⭐），等 Rust 推
   │                    SNAPSHOT_RESTORED 或 RUN_GONE ⭐
   └ RunGone          → 清 Store
4. SNAPSHOT_RESTORED → 立即替换状态 + 恢复渲染 + 异步发显式 ack
   （指数退避 2s→4s→8s→16s + 抖动，maxAttempts=4，总 ~30s）
5. 触发 call_action / delegate
6. RUN_ENDED / RUN_ABORTED → 标记 ENDING → 清 Store/XState/订阅 →
   RUN_ENDED_ACK（超时 3s → 直接释放；超时后 ACK → 幂等忽略 + 日志）
```

## 12. 分级传输（TransferPolicy，Channel 内）

| 大小 | 通道 | 附加 |
|------|------|------|
| <4KB | JSON → webview.eval（已转义，防注入） | 阈值可配置（桌面/移动不同） |
| <64KB | Uint8Array | — |
| >64KB | IPC Queue + fetch | token 绑定 (runId, payloadId) + 30s 仅限首次使用 + 主路径 Rust 推 `TOKEN_ISSUED` ⭐ + 兜底 issue_token（response 带 token） |

## 13. L4/L5 与契约测试

- **L4 Pi SDK**：`create_agent_session · AgentSessionHandle::prompt ·
  AgentEvent 流 · ToolRegistry · 生命周期（Mutex 串行）·
  ExtensionUiRequest（confirm/select/input/editor/notify）·
  ExtensionUiResponse（Confirmed|Value|Cancelled）· **会话真相 ⭐**。
- **L5 移动端**：`#[cfg(feature="mobile")]` 隔离。MobileSink
  （EventSink+SnapshotSource）：send=有序 IPC+前端批量合并；
  snapshot=从 pi_session_snapshots 恢复（共享 schema，每会话 ≤3 快照，
  淘汰最老+保留最近 run 边界；snapshot_version 不匹配→JSONL 重建；
  缓存+JSONL 都失败→RunGone ⭐）。**不 impl Replayable**。
- **契约测试 ⭐**：
  - EventSink + SnapshotSource 契约测试：跑在 ChannelSink **和** MobileSink
  - Replayable 契约测试：只跑在 ChannelSink

## 14. Agent-Native 落地顺序（每步独立可验证）

| 步 | 内容 | 验证 |
|----|------|------|
| N1 | agent-protocol crate（§9 类型 + 单测：seq/tool_call_id/serde 往返） | cargo test |
| N2 | pi-adapter 转换器切换到 agent-protocol 类型（agui.rs 映射器逐行迁移） | 现有 30 Rust 用例 + 映射单测 |
| N3 | L2 双通道切换：agui_run(invoke) + Channel 替代 axum HTTP+SSE（§8 废除清单执行，ThreadBuffers 按推荐 B 废除） | CDP 冒烟：发消息→流式渲染→中断→重水合 |
| N4 | channel.ts SeqTracker + ipc.ts InFlightMap + XState 接线（§11） | vitest：乱序/跳变/时序固化单测 |
| N5 | event-bridge RunBuffer + start_agent_event_stream/ResumeOutcome（§10.4） | 重放/溢出→SnapshotRequired 单测 |
| N6 | 审批/审批注册表/protocolVersion 校验（§10.4） | 审批卡 E2E |
| N7 | MobileSink + 契约测试（§13，M4 后） | cargo test 双 sink |

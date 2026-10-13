# MIRACH 架构方案 v8.0（2026-10-06 · 换栈设计：Tauri 最新版 + CEF + dockview）

> **状态**：设计定稿，代码未迁移。本文取代 layout-design.md（v7.x flexlayout
> 时代）成为架构主文档——v7.x 的语义模型（三栏/根面板/colOrder/多柄引擎）
> 全部平移，实现载体层换栈。 

## 0. 换栈决定（用户 2026-10-06）

| 层 | 现状（v7.x） | 目标（v8.0） | 动机 |
|----|------|------|------|
| 壳 | Tauri + wry(WebView2) | **Tauri 最新版 + CEF** | WebView2 行为绑定 Windows/Edge 版本；CEF 自带全量 Chromium，跨端一致、协议可控 |
| 布局 | flexlayout-react 0.11 | **dockview-react** | flexlayout 语义补丁越打越多（语义戳/根面板/跨度归位全是外挂）；dockview 原生支持 docking/分组/序列化/受控布局 |
| 引擎 | pi_session.rs 多柄（v7.5） | **不变**（平移） | 多柄并发/定向中断/按路径路由已是栈无关设计 |

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

### 新命令面（Tauri invoke）

```rust
#[tauri::command] async fn agui_run(
    thread: String, session_path: Option<String>,
    message: String, images: Vec<AguiImage>,
    on_event: Channel<serde_json::Value>,   // Tauri 3 Channel 双向流
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

## 6. 载体对照（v7.x → v8.0 文件映射）

| v7.x（flexlayout） | v8.0（dockview） |
|------|------|
| flex-layout.tsx（Layout 壳/工厂/onModelChange） | dockview-shell.tsx（DockviewReact 壳/onReady/onWillLayoutChange） |
| layout-presets.ts（出厂树） | layout-default.ts（dockview JSON） |
| constraints.ts / constraints-sync.ts | dockview-constraints.ts（min/max/语义戳校验） |
| column-ops.ts（栏动词/colOrder/根面板） | dockview-column-ops.ts（api.moveGroup 路由） |
| drag-session.ts（指针拖拽接管） | dockview 原生 DnD + 自定义 drop overlay（保留 20px 留白逻辑） |
| session-runtime.ts / session-thread-pane.tsx | **不变** |
| pi_session.rs 多柄 / agui.rs | **不变** |

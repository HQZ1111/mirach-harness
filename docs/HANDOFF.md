# mirach-harness 交接文档（2026-10-02）

> 本文是**会话交接快照**：新会话从这里接手。工程规矩/历史踩坑的
> 唯一规范仍是 `AGENTS.md`（必读）；pi 集成的架构规范是
> `docs/pi-integration.md`（v2.3，含 §9 A2UI 扫雷）。三者不重复，
> 本文只记录"现在在哪、下一步做什么"。

## 一句话状态

pi 集成 §7 落地顺序 1–5 **全部完成**（SDK 骨架 / AG-UI 桥 / L1 渲染 /
控制面 IPC / 审批卡），多会话 + 工具部件 + 用量环已通。§7-6（A2UI）
与 §7-7（设置页）按计划属下一阶段，前置扫雷已清。**本地领先
origin/main 1 个提交（965be7e，A 项清账）——GitHub 网络不稳未推送，
随时 `git push`**。

## 提交与仓库

- 工作目录 `G:\mirach-harness`，分支 main。
- 本地最新提交链（本会话）：
  - `965be7e` A 项清账（A22/A25/A26/oneshot 超时，文档 §9）【未推送】
  - `f9502b7` 工具调用结构化渲染（TurnMessage.content → parts）
  - `3a4f0ce` ContextDisplay 用量环
  - `2a36852` 多会话接线（多轮修复/discard/水合/侧栏点亮）
  - `eee66f4` 上游缺陷根因改判 + 一行补丁恢复持久化
  - `7368dc0` 持久化尝试（初判回退，后被 eee66f4 修正）
- **上游 pi**：`G:\pi_agent_rust-main`（path 依赖）。**有一处本地补丁
  必须知道**：`src/session_index.rs` 的
  `note_session_namespace_change`——generation counter 必须
  **read + append** 打开（Windows LockFileEx 拒绝 append-only 句柄 →
  os error 5 → 会话 JSONL 永不落盘）。这是 pi 上游 gh #239（v0.6.0
  官方修复）的同款修复，但本地这份 main zip 是未修复的 0.5.x 形态
  （Cargo.toml 自报 0.5.1）。**下次同步上游代码时检查此补丁是否被
  覆盖**；若上游已含修复则补丁自然同化。

## 已完成（按 pi-integration.md §7 落地顺序）

1. **§7-1 L3 骨架**：pi_agent_rust path 依赖（features sqlite-sessions）
   + rust-toolchain.toml（nightly-2026-08-31）+ recursion_limit 256；
   `pi_session.rs` = PiRuntime（asupersync current_thread）+ PiEngine
   （Arc<EngineShared>；**一切 block_on 走 16MiB 大栈线程**
   `on_big_stack`——pi future 深递归 2MiB 必爆栈）。
2. **§7-2 L2 AG-UI 桥**（`agui.rs`）：POST /ag-ui（起 run 返回 runId，
   **ensure_session 按需建会话——不能无条件 create**）+ GET
   /ag-ui/stream（常驻 SSE 唯一消费口）+ per-thread 环形缓冲
   （seq 从 1 起，cap 2000）+ AgentEvent→AG-UI 映射器（ToolExecution
   带 args/result；AgentEnd→RUN_FINISHED.usage）+ ApprovalRegistry。
3. **§7-3 L1 渲染**：`turn-actor.ts`（XState v5 轮次机；reduceAguiEvent
   纯函数，9 单测全绿）+ `runtime.tsx`（ExternalStore 纯渲染 +
   EventSource；**挂载用 pi_stream_cursor 作 lastEventId 跳过重放**，
   历史经 pi_get_messages 水合）。
4. **§7-4 控制面**：IPC 14 命令（get_state/get_messages/set_model/
   set_thinking_level/interrupt/list_models/pending_approvals/
   extension_ui_response/list_sessions/discard_session/stream_cursor/
   open_session/rename_session/delete_session）；composer 三件套
   （ModelSelector 真模型表 / 停止钮=pi_interrupt / ContextDisplay
   用量环）；**多会话**：no_session:false 持久化 + 侧栏
   threadListAdapter（**必须放 adapters.threadList**）+ New Chat =
   pi_discard_session。
5. **§7-5 审批卡**：HostUiBridge（#[async_trait] ExtensionUiHandler）
   → CUSTOM 进流（只带 {id}）→ 前端拉 registry → IPC oneshot 回灌；
   confirm 全支持；persist_extension_permissions:false。
6. **工具调用结构化**：TurnMessage.content = `string | TurnPart[]`
   （text + tool-call）；pi 历史 toolCall/toolResult 水合归并。

## 未做清单（含确切阻塞）

1. **真模型端到端验证**：本机 `~/.pi/agent/` **无 auth.json /
   models.json**（零凭据）——pi 起跑即 RUN_ERROR（Bedrock 需 AWS
   配置，错误已可观测）。配 key 后可验证：多轮上下文、工具调用真
   渲染（ToolFallback）、用量环真实数字。
2. **§7-7 设置页接线**（提供方/模型/compaction/审批镜像）：大轮次。
   建议路径：设置页 UI 面向 Tauri IPC（命令已有 8 个可复用），补
   models.json/auth 的管理命令；不要走 hermes REST seam。
3. **§7-6 A2UI**：三层全自建（crates.io a2ui v0.0.0 占位且无 Web
   后端；generative-ui 包是 present 树渲染底座非 A2UI 绑定；pi 侧
   catalog/ts-rs 未做）——文档 §9 有完整扫雷，属独立立项。
4. **等扩展生态**：审批卡 select/input 真实形状（上游 UI hostcall
   payload 形状未定）；oneshot 超时已确认由上游 deadline 承担
   （manager request_ui bind_deadline，超时 fail 非挂死——宿主无需
   计时）。
5. **人工验收未做**：真机拖拽/多显示器/主题/长会话滚动等。

## 验证与环境速查（细节见 AGENTS.md）

- 启动：`npm run dev`（vite:1430，常驻 PID 别杀错）+ **Start-Process
  分离启动** `src-tauri\target\debug\mirach-harness.exe`（会话内后台
  spawn 会被宿主回收）。CDP 9223。
- 门禁：`node node_modules\typescript\bin\tsc --noEmit`、
  `cargo check`（src-tauri）、`npm test`（vitest，当前 30 用例）。
- 冒烟脚本（%TEMP%）：`aui-smoke-v4.cjs`（直连 POST→SSE + UI 发送）、
  `aui-multi-sess.cjs`（多会话七步）、`aui-rows-diag.cjs`（侧栏行）、
  `aui-final-check.cjs`（页面健康）。均为文件日志 + 页面内
  fire-and-forget + node 短轮询模式（CDP 长 awaitPromise 会无声死）。
- exe 改 Rust/caps 后必须重编译重启；改前端代码若行为不变，先怀疑
  vite 陈旧模块缓存（Page.reload）。
- GitHub 网络间歇性抽风：push 失败等 30–120 秒重试即可。

## 本会话踩的新坑（AGENTS 已登记，此处防漏）

- pi 上游 Windows flush 永败 = generation counter append-only + 锁
  （一行补丁，见上）；**不是**锁竞争/线程模型问题。
- `threadListAdapter` 必须放 `useExternalStoreRuntime` 的
  `adapters: { threadList }`——顶层平铺静默无效。
- 挂载 effect 引用的 useCallback 必须声明在 effect 之前（依赖数组
  render 期求值 → TDZ 白屏，RuntimeBoundary 包不住自身 effect）。
- zustand vanilla store 的函数：`store.getState().fn()`，store 对象
  上没有平铺 state 函数。
- CDP `Runtime.evaluate` 长 `awaitPromise` 会无声死：页面内
  fire-and-forget 写 `window.__probe`，node 侧短轮询读取。

# mirach-harness 交接（新会话从这里接手）

> 本文只写**现在在哪、下一步做什么、环境怎么跑**。工程约束与踩坑见
> `AGENTS.md`（必读）；架构分层见 `docs/architecture.md`；布局语义见
> `docs/layout-design.md`；pi 集成规范见 `docs/pi-integration.md`。

## 当前状态

**✅ 2026-11-18（第五波）：状态面板剩余缺口——目标迭代行（插件补）+ 工作流分区（orchestrator 派生）**

- **目标迭代行（插件侧，真数据）**：新 vendored 插件
  `G:\mirach-plugins\rpi-goal-iterations`（DLL 装到
  `~/.rpi/agent/extensions/rpi_goal_iterations.dll`）：监听 `TurnEnd`，
  goal 为 active 时把当前 `todo-state` 快照写进自己的 `goal-iterations`
  条目（按 title+startedAt 分代、自数 TurnEnd、上限 50 轮、重启恢复、
  subagent 跳过）。宿主 `pi_goal_state` 按 goalTitle+goalStartedAt 匹配并入
  `active.iterations`（`merge_goal_iterations`，4 单测；残留目标不并、坏条目
  Err）。面板 GoalStatusSection 换成 ZCode 迭代行结构
  （`buildConversationGoalIterationSummaries` 逐条照抄；插件 complete →
  `verified`；verifying/notSatisfied/failed 解析与 UI 就绪，但 rpi 没有
  goal-verifier 子系统——**不造假校验结论**）。实机：6 轮 goal（4 轮带
  todo 快照）→ `pi_goal_state` 6 行 → 面板 6 行、计数/属性全对。
- **工作流分区（宿主派生）**：`status-workflow-runs.ts` 从本线程 `plan` /
  `dispatch` 工具调用派生（`details.nodes` 真形状：id/task/deps/status ∈
  pending/running/done/failed/skipped）；plan set = 一条 run，dispatch 波更新
  同图；pending/running 进分区，全 settled 进「已结束的工作流」页脚；图快照
  缺席不造 0/0；被新 plan 替换且未收敛的旧图 console.warn 后丢弃。
  UI 照抄上游 `WorkflowStatusSection` / `WorkflowRunRow`（Stop 不渲染——
  orchestrator 无取消面）；行/页脚开 `workflow-run:<runId>` /
  `workflow-directory` 面板栏标签（`workflow-run-detail-pane.tsx`）。
  实机：真模型 plan(set) 两节点 → 面板「工作流 1 个运行中」+ 真行；
  真 dispatch 结果含 `details.nodes`，与派生规则一致。
- **门禁**：vitest **1072**（86 文件）/ cargo test **692** / tsc 0 新错
  （hermes-mirror + sdk-upstream 既有基线不变）。

**✅ 2026-11-18（第四波）：bots 剩余未接面收口——远端 token / image.generate / pet 画廊 + keyring 真后端修复**

- **远端连接 token 管理已接**（`pi_connections.rs` + `pi_gateway.rs` + 连接页）：
  token 进 OS 凭据管理器（service `mirach.connections`，entry = 连接 id）；
  注册表 JSON 只存派生 `tokenSet/tokenPreview`（每次读取从 keyring 重算）；
  `pi_connections_save.token` 只写不读（空串 = 清除；删除连接同步删 entry）；
  连接页有密码输入/清除钮/`token ...123456` 徽章（preview = hermes
  `tokenPreview` 同款：≤8 → "set"，否则末 6 位）；`pi_gateway_connect` 的
  token=null 时 **Rust 侧取 keyring**——token 永不进前端；`pi_connections_test`
  对 remote/cloud **变真**：一次性 WS 等 `gateway.ready`（8s），失败红显真错误；
  ssh 无隧道仍 stub 红显。**实机（CDP）**：存 token → tokenSet true /
  preview `...123456` → 测试真连（连接被拒 = 真网络错误）→ 删除无残留。
- **修大坑：keyring 3 没有默认特性**——裸 `keyring = "3"` 退化成进程内 mock
  store（set 静默不落盘、get 恒 NoEntry）→ **pi_vault 此前一直是假成功**。
  改 `keyring = { version = "3", features = ["windows-native"] }`；实机
  vault add → reveal（真 secret 回读）→ remove 全通。
- **image.generate 真后端**（`src-tauri/src/pi_image.rs`）：OpenAI 兼容
  `{base}/images/generations`；provider = `settings.image.provider` >
  `default_provider` > models.json 首个有凭据者；key = models.json apiKey
  （字面量 / `env:` / 裸环境变量）→ auth.json → provider env；probe =
  GET `{base}/models` 真找图像模型（无 → `available:false`，插件隐藏入口）；
  `settings.image.model` 可覆盖；失败走契约 `error`。实机 probe：DS provider
  无图像模型 → `{available:false, error:"provider 的模型目录里没有图像模型"}`。
- **pet.gallery / pet.thumb**（`src-tauri/src/pi_pet.rs`）：petdex 公共
  manifest（UA 同上游，300s 缓存；installed 读 `~/.rpi/agent/pets`）；
  thumb = 已装 sheet 优先、否则仅 petdex.dev 主机 URL（上游 `_is_petdex_host`
  同款反 SSRF），裁首帧 192×208 → 96×104 NEAREST → PNG data URI +
  `pets/.thumbs/<slug>.png` 缓存。实机：gallery **5208 只**；thumb
  `homelander` → 20KB PNG data URI（webp 解码经 image crate `webp` feature）。
- **peer 房间 Desktop 驱动模式全通（同日续）**：authority 侧
  `groups.peer.register/revoke` 真落地（pinned catalog 校验 + `room-links.json`
  持久化；并发 seat 用进程内串行锁 + 唯一 tmp——实测踩中固定 `.tmp` 冲突导致
  第二个成员 `registration_unconfirmed`）；canonical driver 对 peer 成员按
  profile 解析 remote 路由，session.create/resume/prompt.submit/interrupt 全走
  对端 WS（宿主私有字段 `room_plumbing/task_meta` 剥离）；roster 行补
  `sourceScoped/remoteSource/installId/route`（插件 `usePeerTargets` 才能
  ready）；peer actor 带 `connection_id`。**实机（mock 网关，走 hermes 插件
  自身 `createGroupAcrossConnections` + `seatPeer`）**：1 本机 + 2 远端成员
  建房 → unjoined=[] → 本机真模型回复 + 两名远端成员均回复
  （actor.connection_id=mock-install-1）→ 4 turn.settled → room.activity
  settled（silent_round）。
- **per-bot MCP 已接**：bots 对话框 MCP 页 = 全局 `mcp.json` 服务器多选；
  启动 `pi_bot_mcp_config` 只过滤所选服务器生成
  `~/.rpi/agent/bot-mcp/<bot>.json`，`configPath` 注入 system prompt
  （rpi-mcp-adapter 的 `mcp_list/mcp_call/mcp_resource` 本就按 `configPath`
  读配置——真生效）。**限制（如实）**：不选 = 不注入；adapter 四个 MCP 工具
  是进程级注册，无 per-session 遮蔽面（"不选"不能从工具层阻断）。
- **session.reclaimed 有生产者**：`pi_delete_session` 成功后按 path 在索引
  定位 stored id → emit `mirach:plugin:session:reclaimed`
  （`{stored_session_id, path, reason:"deleted"}`）；插件监听器据此刷新打开
  的 bot canonical chat。
- **结构性未做（如实）**：peer 的 **lending 侧**（本机对外 RoomLink HTTP
  服务端 + `groups.peer.invite`——host 无对外监听，invite 明确报错）、
  ssh 隧道（用 remote 指向已转发端口）。
- **主栏标签条 auto 显隐修复**：g-chat 组构造期 `hideHeader:true` 会让后加入的
  标签（房间 / 屏幕 / 预览 / 文件）**既切换不到也关不掉**（用户实测：打开机器人
  屏幕后无法关闭）。`dockview-shell.tsx::syncChatGroupStrip` 在 onReady +
  add/remove/layout 事件后按面板数重算：仅 `workspace`/`open` 锚 = 无条；
  有额外标签 = 显示条（含 ✕）。实机：开探针面板 → 条 flex 且签在场；关掉 →
  条复隐。与 hermes `resolveTabStripVisible` 的 auto 规则同义。
- **门禁**：cargo check 0 / cargo test **692** / vitest **1072**（86 文件）/
  tsc 1319（= hermes-mirror + sdk-upstream 既有基线，0 新错）。

**✅ 2026-11-18：状态面板缺口收口——终端 Stop 走插件、子代理名册/Stop 走引擎（PR #355）**

- **终端 Stop（插件侧）**：vendored `rpi-background-tasks` 增 `/jobs` 斜杠命令
  （list / tail / kill），宿主 `pi_job_cancel` 转发 `run_command("/jobs",
  "kill <id>")`；面板终端行重新渲染 Stop。实机：运行中 job 点 Stop →
  快照 `cancelled`、行消失、pid 进程消失。
- **子代理名册/Stop（引擎侧，已自测 + PR）**：引擎 `ChildAgents` 增
  `roster()`/`stop(child_id)`（childId/status/turns/startedMs/finishedMs/
  role/taskPreview/error；按 id 取消，非 owner 过滤）；`RuntimeActionHost`
  默认方法 + `HarnessActionHost` 实现。宿主新 IPC `pi_child_agents` /
  `pi_child_agent_stop` + `child-agents-store.ts`，面板「智能体」分区优先
  渲染引擎名册（running 行带「停止子代理」）。实机：真模型 delegate_task
  长任务 → 名册 running → 面板 Stop → 模型收到「child cancelled by user」、
  名册行消失、子进程终止。**PR：bigfish1913/pi-rust #355**。
- 引擎门禁：`cargo test -p rpi-cli` 1197 passed（native_durable 的 2 条
  resource_fixture 构建失败在干净 upstream/main 同样复现，环境性）。
- 仍无数据面（不造假 UI）：workflow 分区、目标 verifying/迭代徽章。

**✅ 2026-11-18：状态面板让位链与 ZCode 源码对账修正（用户："对话区宽度被挤在左边，面板没出现还在左边"）**

- **根因 1**：面板组件总会挂载（无内容时 `return null`），而 `setMounted(true)`
  写在挂载即执行 → 无面板的会话也把对话列左移。修 = `panelVisible =
  activeId && hasContent` 与渲染闸门同判。
- **根因 2**：旧"钉死形态恒让位"与上游不符。核对 `ZCode-main/v4/conversationLayout.ts`：
  偏移类对 auto/inline **同一条**（`@min-[1280px]:-translate-x-42`，无断点的
  `INLINE_OFFSET` 是死代码）；内容列宽度带不带面板**同一个类**（不收窄）；e2e
  断言布局切换**零过渡**。已全部对齐（不再收窄、不再 300ms 过渡、<1280 一律不平移）。
- 判定收敛成纯函数 `resolveStatusPanelShift`（+5 单测：
  `status-panel-layout.test.ts`）；实机度量：无内容会话无 shift/无 pt-14/居中；
  胶囊态 pt 52.5px；宽容器 transform −157.5px。
- 门禁：tsc 0 新错 / vitest **1050**（85 文件）/ cargo test **678**。

**✅ 2026-11-18（第二波）：bots 完整复刻审计 + 跨网关全链打通**（用户："垮网关是bots的核心，看bots的代码有没有漏项"）

- **审计（对照 `D:\hermes-agent-main\apps\desktop\src\plugins\hermes-bots`）**：镜像 121
  文件 vs 上游 283 —— 缺的 **162 个全是 `.test.ts(x)` + LICENSE + 一个测试夹具**，
  生产文件一个不缺；真漏项在**数据面**（逐调用点审计）：多网关整块、relay 死链、
  `host.connections()` 形状 bug（恒空表）、插件侧删 bot/改描述恒失败、display 三处
  返回形状不合契约、`tool.start`/`groups.changed` 无生产者、`revealPane/undismissPane/
  navigate` 全仓无监听、notify/notifyError 不可见、`setup.runtime_check` 未接线。
- **B1（合同面，全修）**：connections 裸数组真注册表；profileRoutes 每 bot 一条 local
  路由 + 远端路由；deleteProfile 真删；`cli.exec profile describe --text` /
  `--profile <n> config unset model`；display.observe/start 展平、thumbnail
  `{data_url, suppressed}`（人持租约抑制）+ switchSandboxImage；setup.runtime_check
  （`pi_models.models`）；tool.start（pi_bot 事件泵）；groups.changed（groups_dispatch
  变更成功后广播 + `change_events:true`）；gateway.ready（boot 广播）；reveal/undismiss
  真监听；navigate `/settings?tab=gateway` → 设置窗深链 `core-connection`（Rust 带
  section 参数；常开窗走 `mirach:settings:section` 事件）；notify/notifyError →
  **ToastHost**（beui AnimatedToastStack + `mirach:toast` 事件桥，挂应用根）。
- **B2+B4（跨网关，本轮核）**：`pi_relay.rs`（hermes `tools/bot_relay.py` 对偶：
  `~/.rpi/agent/bot_relay/` 持久仓 outbox/claimed/replies/**receipts**/roster.json；
  四门 + TTL 900s→`queued_expired` + claimed 未回执重投 + 先写者胜 reply；6 单测）+
  `pi_gateway.rs`（**JSON-RPC 2.0 over WS `/api/ws`**，hermes 桌面端同款：ready/ping/
  事件推送/服务端请求答 -32601/2^n 重连；URL 归一化 + 帧解析 2 单测）+ host.ts
  `requestProfile` 远端分支 + agents/profileRoutes 远端并集（30s 缓存、瞬时失败沿用
  旧值）+ engine-bridges 远端目标 `pi_relay_enqueue` + `bot_relay.reply` waiter 唤醒。
  **两个实测缺陷（已修）**：① Rust 事件名 `…bot_relay:outbox.pending` 与前端监听
  `…bot_relay:outbox:pending` 差一个"点变冒号"（push drain 永不触发）；② deliver 回执
  缺 `admission_id` → Desktop 判"身份不可用"保留重投（目标实测重复 13 轮）+ 回执只认
  claimed → 远端来件存不进。修 = `admission_id`（未准入带 `refused:true`）+ 回执独立
  `receipts/<id>.json`。
- **双向 E2E（mock 网关，无依赖手写 RFC6455）**：远端→本机（envelope → drain → 本机
  bot 真模型轮次 → receipts settled → `bot_relay.reply` 写回 mock）✓；本机→远端
  （message_agent queued+delivery_id → Desktop 投给 mock 的 `bot_relay.deliver` →
  回执 → replies 落盘 → **waiter 把回信送进发送者会话** → 发送者再回复）✓。
- **门禁**：tsc 0 新错（1319 镜像基线）/ vitest **1050**（85 文件）/ cargo test **678** /
  cargo check 0。
- **仍未接**：远端连接 token 管理 UI（keyring 录入；当前只能无 token 连回环/--insecure）；
  **跨网关 peer 房间**（groups.peer.* + RoomLink HTTP——transport 已铺好，等待实现）；
  pet.thumb/gallery；image.generate；per-bot MCP 勾选（引擎 mcp.json 全局）；
  session.reclaimed 无生产者。

**✅ 2026-11-18：状态面板缺口「用插件补」——rpi-background-tasks 就地补齐 + 实机 E2E 通**。

- 上游调查（`pi-rust/rpi-package` main）：**只有** `rpi-background-tasks` 有源码
  （`background`/`jobs` 工具 + `background-tasks` 会话快照；无 release tag、本机未装）；
  目标迭代验证、workflow 分区、子代理名册/Stop/子会话**没有**可移植的插件面
  （`rpi-goal` 无 verify/iteration；`rpi-orchestrator` DAG 只在进程内存；
  `ChildAgents` 是 `pub(crate)`），这三项保持如实不渲染。
- 插件落点：vendor 到 `G:\mirach-plugins\rpi-background-tasks`（独立 crate，path 依赖
  `G:/pi-rust-main/crates/rpi-plugin-sdk`），`cargo build --release` → 复制到
  `~/.rpi/agent/extensions/rpi_background_tasks.dll`（**应用运行时会锁住 dll，换版本须先退出应用**）。
- **本地适配**：上游 shell 解析漏了「`where git.exe` 反推安装根（自定义盘）」，本机 Git 在
  `D:\Git` → 落到 System32 的 WSL 存根（exit 1 + UTF-16 乱码）。已按宿主
  `rpi-tools::os_env` 顺序补齐 + 排除 WSL；实测命中 `D:\Git\bin\bash.exe`。
- 宿主：`pi_plugin_state.rs::background_tasks_wire` + `pi_session.rs::job_list()` 读最新
  `background-tasks` 条目（真字段投影；未知 status Err）；`pi_job_cancel` 保留 Err
  （Job Object 句柄在插件进程内）。
- 前端：jobs-store 词表 = 插件 `STATUS_*`；终端分区行 = label（或 command）+ 秒针，
  **不渲染 Stop**；run 期 2s + 挂载期 3s 双轮询（修了「跨轮 settle → 行永远停在运行中」竞态）。
- 实机 E2E：真模型 composer 发后台请求 → job 真跑（sleep 20 / 60 均 exit 0）→ 面板
  「终端」分区运行中在场、秒针在走、settle 后自动收掉。Rust 单测 +4（670）。
- 门禁：tsc 0 新错 / vitest 1045（84 文件）。

**✅ 2026-11-18（夜）：bots 引擎侧四件套全落地 + 实机 E2E 全绿 —— PR 给 pi-rust 是唯一欠账**
（用户："全部做，做完检查，没问题了pr给pi rust" / "改了引擎测，提pr给ri rust"）

- **引擎侧（`G:\pi-rust-main`，未入宿主仓库；上游 = `github.com/bigfish1913/pi-rust`）**：
  - `rpi-harness/src/task_lease.rs`（新，6 单测）：持久任务租约——`acquire_with_meta`
    / `renew` / `finish` / `status` / `list` / `recover`（过期 Running→Indeterminate）
    / `ensure_live`（fencing：Conflict/Stale/LeaseLost/AlreadyFinished/Invalid/Io）；
    落盘 `<session>.tasks.json`（tmp+rename）。
  - `rpi-cli/src/approval_gate.rs`（新，3 单测）：运行时审批模式（AlwaysAsk/Write/Yolo
    进程级 AtomicU8）+ `ApprovalHandler` + `before_tool_call`（组合在扩展 hook **之后**，
    只读白名单显式）。
  - `rpi-cli/src/message_agent.rs`（新，2 单测）：引擎内置 `message_agent` 工具
    （fire-and-forget；**handler 未装不注册**；caller session id 从 harness 绑定解析）。
  - `rpi-cli/src/session.rs` 接线 + **绑定修复**：`durable_binding` 原来只在
    `native_durable` 时填充 → 宿主（从不设它）里 message_agent 恒报
    "session binding not ready"；改为无条件 `set`（顺带让审批请求带真 session_id）。
    `lib.rs` 两行 mod 声明。
- **宿主侧**：`pi_bot.rs`（prompt = task 身份+租约+meta；结束 finish(Settled/Cancelled/
  Failed+receipt)；state 出 `task`/`tasks`；`pi_bot_take_recovered`、
  `pi_bot_interrupt_task` 带 fencing）｜`pi_engine_bridges.rs`（agent-message 事件+30s ack、
  approval-request 事件+600s 裁决）｜`pi_display.rs`（GDI 截屏 + RFB 3.8 WS 服务：ticket
  单次、lease 契约修复）｜`engine-bridges.tsx`（投递/回信 + 审批弹卡 + 模式恢复）｜
  host-rpc（display.* 真接线、`task.interrupt`、resume 扩租约面、prompt.submit 传 taskMeta）｜
  canonical-group-driver（localStorage ledger 删除 → 引擎租约 + recovered→indeterminate
  回写 + Stop 走 fenced task.interrupt）。
- **实机 E2E（真模型 BBT/deepseek-v4.1-flash）**：
  ① 审批：always-ask → bash 弹卡（真 args）→「允许一次」→ `approval-e2e-ok` 真执行；
  「拒绝」路径回灌 `用户拒绝`、命令未执行。② message_agent：微软 →引擎工具→ `queued`+
  delivery_id → 真投递 remote-bot（归属前缀）→ 回信进微软会话。③ 屏幕面板：右键「打开
  屏幕」→ noVNC canvas 1280×720 真帧（像素采样非零）→ 接管「你正在控制」→ 交还
  「机器人正在控制」（lease epoch 2 / holder:'agent'）。④ 任务租约：running 快照
  `task{id,gen}`+meta；stale generation interrupt **被拒**（"stale task identity"）；
  正确 generation → abort → `cancelled`+meta 落盘；崩溃恢复 fixture → `indeterminate`
  ("driver restarted while the task was running") → take-once 清空。
- **门禁**：tsc 0 新错（1326 条 = hermes-mirror/sdk-upstream 既有基线）/ vitest
  **1044**（84 文件）/ cargo test **666** / cargo check 0 / rpi-cli+rpi-harness 新模块
  单测 11 条全过。
- **PR 已提（2026-11-18 夜）**：**bigfish1913/pi-rust #348**
  （https://github.com/bigfish1913/pi-rust/pull/348，
  head `HQZ1111:feat/task-lease-approval-message-agent`，6 文件：
  三个新模块 + session.rs +50/-3 + 两个 lib.rs 各一行）。分支基于上游
  main d3e388d 干净重建（镜像里用户自己的本地补丁如 execution_env /
  after_tool_call 改动**没有**带进 PR）；克隆在本机
  `E:\Temp\pi-rust-pr333`。余下：等上游 review；canonical 群聊**含租约**的
  整房间 UI E2E（各原语已单独实测）。
- **有意不做**：屏幕的 display.stop/install 面无（宿主无停止语义）；
  relay 跨网关（单身份宿主无 relay 概念，显式报错）。


**✅ 2026-11-18：对话右上角活动状态面板 = ZCode `ConversationStatusPanel` 完整移植**
（用户："把zcode的对话右上角的状态面板栏完整移植" → "有意差异去除，全部对齐"）。

- **结构对齐**：分区顺序 Git 工具 → 目标 → 会话计划 → 进程 Todo → 终端 →
  智能体；每区限高滚动（goal/sessionPlans/terminal/agent max-h-48、plan
  max-h-80）+ separated 上边线 + trailing 随开合切换；智能体分区页脚
  「已结束的智能体 · N ›」；mini 胶囊完整优先级链（运行待办 → 目标(活) →
  git 变更 → 目标(完) → 最近完成项 → 待办计数 → 最新会话计划 → 运行计数 →
  无则不渲染）。
- **卸载闸门照抄上游**：`!hasContent → null`（只有已结束智能体的会话整块不
  渲染），推翻 11-15 的"常驻空态"宿主选择。
- **目标区完整化**：`pi_goal_state`（rpi-goal `goal-state` 条目）→ 用时秒针 +
  `/goal pause|resume` 按钮走既有 `pi_run_command`；真机：起目标 → 面板
  出现（active、秒针在走）→ 暂停/恢复按钮真翻转状态 → `/goal stop` 归档后
  面板整块消失。
- **会话计划目录**：新 Rust IPC `pi_plan_entries`（rpi-plan-mode 条目，只收
  有 markdown 的，seq 降序）+ 新 `plan-entries-store`；点行开面板栏标签页
  `plan-detail:<entryId>`（每计划一实例）。**真模型全链路已实测**：plan 模式
  下发规划请求（composer 真发送）→ 模型 `plan_mode_complete` 写入真计划 →
  分区出现（H2 回退标题 + 计数 1）→ 点行开详情页展示原文。
- **智能体分区**：rpi 子代理运行态无宿主读取面（`pi_hub_roster` 如实 Err）→
  从 `delegate_task` / `subagent` / `dispatch` 工具调用派生运行/已结束两段
  （`status-agent-rows.ts` 纯函数）；页脚开单实例 `agent-directory` 标签页，
  行可再开子代理详情页。
- **终端分区**：数据面 = jobs-store（`pi_job_list`，rpi 未装 background-tasks
  插件 → 如实 Err → 空 → 分区不渲染），有任务时行 = 命令行 + 用时 + Stop。
- **workflow 分区不渲染**：rpi 无该概念（engine-gaps G3），不造假 UI。
- 顺带修复：`pi_get_state.hasExtensions` 硬编码 `false` → 读
  `extension_session` 真值（实机回读 `true`；扩展命令本来就可用）。
- 门禁：tsc 0 新错（1326 条均在 hermes-mirror / sdk-upstream 既有基线）/
  vitest 1044（84 文件，新增 25+9 条）/ cargo test 666。

**✅ 2026-11-18：右侧面板栏终端对齐 ZCode 侧栏终端**（用户："我的右侧面板栏
里的终端，打开怎么和zcode不一样？"）。规格 = 上游
`docs/ui/side-pane-terminal-tabs.md` + `SidePaneTerminalPane.tsx`：

- **一个面板 = 一个终端**：删掉面板内自绘的二级页签条（`Administrator +`
  那排）与二级新建钮（上游明令"内部不再嵌套 terminal tabs"）；内容区 =
  `bg-background p-3`（0.75rem）留白——此前是贴边满铺。
- **点「终端」= 新建面板**（不复用单例）：`open-page-actions.ts::
  openTerminalPanel`，标题 = cwd 末段（取不到 = 终端）+ " 2/3"（上游
  `createTerminalSidePaneTitle` 同源），id = `terminal` / `terminal-2`…；
  cwd 进 params，存档恢复沿用。`isTerminalPanelId()` 同时接进关标签的
  栏生命周期判定（dockview-shell）。
- **保活**：终端面板以 `renderer:'always'` 挂载（dockview overlay），切标签/
  收栏**不卸载、PTY 不中断**（上游"切换到其他 side pane tab 或收起 side pane
  时保持挂载"）；关闭面板才卸载 = kill（实机：pwsh 进程 5→4）。boot 时对旧
  存档里的终端面板补写 `setRenderer('always')`。
- **坑（已实锤进代码注释）**：`always` 面板隐藏时 overlay 未定位、容器报
  整坞尺寸（100%×100%）——"有尺寸就 spawn"会按错尺寸起 PTY；spawn/fit 必须
  同时以 `api.isVisible` 为准，激活时由 visibility/dimensions 回调补启动。
  实机断言：隐藏终端无 xterm（不 spawn）；激活后面板 69 行、容器 240×1046
  尺寸一致；A 终端 `echo probe-AAA` → 切到 B → 切回，scrollback 仍在且能
  继续执行（保活）。
- 退出条（进程已退出/重新打开）保留——宿主失败可见通道；实机：`exit` →
  条出现 → 点「重新打开」→ 新会话。
- **二轮（同日，用户："显示达到上限8无法打开了，而且有黑色背景，文字也不对"）**：
  - **上限 8 = 泄漏症状，不是策略**：页面 reload（dev HMR / webview 重启）
    后旧页面的 kill 钩子随页面消失 → 遗留 PTY 占满登记。修法 = 会话带
    页面归属（webview label + per-page token，`terminal-pty.ts`），
    `terminal_reap` 在 boot（`app/index.tsx`）与 spawn 各回收一次；**上限
    撤除**（ZCode 无上限）。实机：开 10 个终端标签全成功（10 个 pwsh 各一）
    → reload → reap 后只剩活动标签 1 个进程；关标签即减。顺带实锤
    portable-pty 0.8.1 `WinChildKiller::kill` 成功判定写反（成功返 Err），
    `terminal_kill` 不再据其返错（以 exit 事件 + 登记摘除为真）。
  - **配色改 ZCode 默认浅色主题**：`--term-*` = Tailwind v4 调色板（底 =
    `--surface`，字 = neutral-950，ANSI = 500 系；red-500 是 `#fb2c36` 非
    v3 的 `#ef4444`）；`.xterm-viewport` 原生滚动条按 ZCode 同款隐藏。
    实测 getTerminalTheme 解析：bg rgba(255,255,255,1) / fg rgba(10,10,10,1)
    / selection rgba(0,165,243,0.322)。截图：浅色终端与面板一体，黑块消失。
  - **字体被全局 webfont 规则劫持（真 bug，已修）**：harmonyos-sans-sc
    包的 `:lang(zh)` 规则直接命中 xterm 逐字符 span → 终端拉丁字用比例体
    渲染（"Power Shell"/"Adm inistrator" 怪字距）。panes.css 以
    `.term-host .xterm *` 更高优先级钉回 `--term-font-family`；实测
    span 字体回到 ui-monospace 栈、逐字符 letter-spacing 归零。
  - xterm 5.5 的 dispose 必须延后一个宏任务（其 Viewport 构造函数有未追踪
    setTimeout，同步 dispose 会报 "reading 'dimensions'"）：开关终端标签
    循环测试 0 异常。
  - **三轮（继续）：标签图标 + 右键复制/粘贴**——终端签标题前加
    SquareTerminal（CSS mask + 令牌 `--term-tab-icon`，判据精确匹配 id
    `terminal`/前缀 `terminal-`，不加自定义 tabComponent，✕/拖拽零变化）；
    窗格根 `data-slot="terminal-pane"` 登记进全局右键范围，右键菜单
    复制/粘贴走 `term.paste`（bracketed-paste），动作后焦点还给终端。
    **坑**：终端面板是 `renderer:'always'`，内容在 `.dv-render-overlay`
    （带 transform/contain/will-change = position:fixed 的包含块），motion
    ContextMenu 内联渲染会被叠加 overlay 偏移（实测点击 (1619,156) 画到
    x=3030）→ 菜单必须 `createPortal(..., document.body)`。
- 门禁（三轮后）：tsc 0（非镜像树）/ vitest 1051（85 文件，含
  context-menu-scope 的终端面用例）/ cargo test 667 / cargo check 0。

**✅ 2026-11-17：bots 插件补齐轮（用户："先补齐bots……百分百对齐hermes的bots"）**。

- **P0 群聊成员轮次全链接通**：新 `src-tauri/src/pi_bot.rs` = 后台 bot 会话
  泳道（独立 harness，不抢前台会话；create/open/prompt/interrupt/compact/
  attach/ask/approval），`host-rpc` 接 `prompt.submit`/`approval.respond`/
  `clarify.lock`/`file.attach`/`image.attach_bytes` + `session.resume` 富投影
  （running/inflight/turn_started_at/open_requests/pending_approval +
  `failed_turn` 边界行）。实机：发消息 → 成员会话真跑 → deepseek 403（key
  配额用尽）→ 房间活动行如实显示真错误 → 自动轮到下一成员。
- **贡献面 2/7 → 6/7**：`composer.atCompletions`（@ 补全出机器人行）、
  `composer.middleware`（发送前管线）、`chat.empty`、`command.palette`
  （New bot… 行），加既有 panes×2；`profile group header` 无消费面（屏幕
  不支持）。
- **`host.openWorkspace` 从空开关变真门**：`plugin-workspaces.ts` +
  `plugin-workspace-pane.tsx`（主区标签页 + 重启孤儿剪枝）——群聊房间此前
  点开毫无反应（事件无监听者 + close 返回值被吞）。
- **修 5 个真 bug**（用户可见）：ctx.storage 值级 KV 被当字符串（bot-meta v2
  等持久化全坏）；`gatewayActivationEpoch` 写成常量而上游是函数（群聊创建
  对话框永远"检查中"）；`host.agents().sources` 用错键名（所有行"网关已
  移除"、群成员 0 可用）；`pi_get_session_messages` 叶子取文件尾行（rpi
  记录条目无父链 → 投影恒空 → 群聊读不到回复）；`sdk/message-text.tsx`
  借 assistant-ui part 原语（群聊房间白屏）。
- **剩余结构性缺口 = canonical（网关驱动）群聊**：新群聊按上游语义要求
  网关 driver（宿主 legacy 声明 → 对话框如实"版本过旧"）；Rust 已移植
  hosted_rooms 状态机/规划/控制面，缺 driver runner（上游源
  `tui_gateway/hosted_room_driver.py` + `hosted_room_service.py`；依赖会话层
  task 身份/终局回执，rpi 侧未定协议）。详见 `docs/bots-port-gaps.md`。
- **门禁**：tsc 0（非镜像树）/ vitest 1003（82 文件）/ cargo test 660 /
  cargo check 0 错误。
- **2026-11-17 续（用户："其他缺口能补齐的就补齐"）**：
  - **MCP 真面补全**：`pi_mcp_catalog.rs` + `assets/mcp-catalog.json`（hermes
    `optional-mcps/` 的宿主可执行子集：10 条 no-auth HTTP）；`mcp.catalog`
    出目录、`mcp.servers.add {preset}` 一键装、`mcp.servers.test` 对 HTTP
    做**真实 MCP 探测**（initialize→initialized→tools/list；实机 deepwiki 3
    工具 + serverInfo）、`mcp.servers.set_api_key` 写 env、
    `mcp.servers.remove` 真删。56 条 OAuth 条目不入目录（引擎扩展没有 OAuth，
    见 `docs/pi-host-gaps.md`）。
  - **能力面板导出**：`sdk/capabilities-views.tsx`（CapabilitiesView /
    ConnectorsTab / ToolsetConfigPanel）→ 机器人编辑对话框出现
    技能/插件/连接器/工具集四页签（实机）。
  - **图像/屏幕面**：`image.generate` probe available:false；`display.*`
    明确报错（无 display 子系统）。
  - **canonical 群聊最小驱动落地**（同日）：`canonical-group-driver.ts`
    （前端驱动）+ `groups_plan` 暴露 task.prompt + `groups.driver_append`
    写回口 + `groups.capabilities` driver:true。实机：新建群聊 → 发消息 →
    两名成员依次跑轮次（真实 403）→ turn.failed 如实回写 → room.activity
    settled；界面出「回合失败」卡 / Round 状态 / Stop。差距：无租约/
    fencing/indeterminate 恢复、router(auto) 不支持、retry/discard/
    approvals 未桥接（`docs/bots-port-gaps.md` §3）。
  - **2026-11-17 收尾（用户提供测试 key：`bbtoken.boywe.cn/v1`）**：
    models.json 加 `BBT` provider 并设为默认 → **「真模型端到端」硬阻塞解除**。
    成功链实机验证：主对话 1+1=2；canonical 群聊两成员真实自我介绍 +
    handoff + settled；legacy 群聊真回复；router(auto) `room.routed` →
    成员真回复；**MCP 模型内调用**（`mcp_list` 发现 deepwiki → `mcp_call
    ask_wiki_question(facebook/react)` 返回真实答案并中文总结）；远端错误
    如实回显。
  - **新增宿主面**：`pi_mcp_oauth.rs`（MCP OAuth 标准 DCR+PKCE+刷新，目录扩到
    64 条）；`pi_skills_catalog.rs`（hermes optional-skills 139 技能，
    skills.manage 搜索/安装/删除，实机装 watchers）；canonical driver 补
    **approvals 桥 / retry / discard / router(auto)**；`groups.capabilities`
    方法表 16 项。
  - **仍未做（引擎侧，见 `docs/pi-host-gaps.md` §6/§7）**：权限闸运行时切换
    （rpi 迁移后 set_approval_mode/plan 系为只读，approval 卡触发需扩展通道）、
    message_agent/relay（需会话层工具注册面）、display、canonical 租约级恢复。
  - **引擎侧缺口文档**：`docs/pi-host-gaps.md`（OAuth MCP / display /
    canonical 全语义所需 task 身份 / session.reclaimed / 多连接 peer）。
    结论：本轮所有补齐均在宿主侧完成，未改 `G:\pi-rust-main`（该树无 .git，
    需要时按文档拆 patch）。
- **PR**：https://github.com/HQZ1111/mirach-harness/pull/2（分支
  `bots-plugin-complete`；本轮续的改动追加在同一分支）。

**✅ 2026-11-16：hermes-bots 插件移植落地（c85756a）+ groups_plan 修复（ff41b18）**。

- **内置插件跑通**：`src/sdk`（`@hermes/plugin-sdk` 宿主对偶：host.request 分发
  profiles/session/cron/cli/groups；host.state 八字段接真 atom）→ `src/plugins/bundled.ts`
  + `PluginPane` + dockview `bots` 槽位（贡献优先、BotsPane 回落）；CDP 实测
  花名册渲染 / 点击建·复用 canonical Bot Chat（双锚，侧栏过滤）/ composer 发送
  （人格·模型生效）/ 编辑机器人对话框 / 例程面板（列表·新建·暂停·删除全链）。
- **例程面板**：`hermes-bots:routines` 贡献自动挂到主区右侧「定时任务」面板
  （registry 订阅：贡献在→建面板，消失→摘）。修四个真缺陷：`pi_cron_jobs` 回包是
  `{jobs,tickerRunning}` 非数组（曾 TypeError）、行内删除动作是 `remove`（非 delete）、
  `nextRunOverdueMs` 签名必须收 job 对象（手写近似版让每行恒「逾期自」）、
  `display.status` 给 `supported:false` 定型（屏幕门户不再假 spinner）。
- **焦点 owner 口径**：`focusedSessionOwner` 只认 bot 双锚（`chatSessionId`），
  普通会话报 null；connectionId 留空（本机行身份=裸名字）。此前伪造 `local`
  owner 让例程窗格死锁在「这个机器人需要先出现在名册中」。
- **groups 后端**：`groups_plan` 的 `local_profiles` 从成员 `target.kind=local`
  提取（原返回空 Vec → 恒报 "not local to this gateway"）；`cargo test hosted_rooms`
  **464 passed**；CDP 实测 `groups_plan('plan-test')` → `status=task, member_id=m-ada`。
- **门禁**：改动文件 tsc 0；镜像树历史类型错仍在（全仓 tsc 1341 条为镜像类型漂移，
  vite 构建不受影响，待后续收）；cargo test 464 绿。
- **已推送**：`c6cd077..93e1ad1`（群聊后端 + 插件移植 + groups 修复 + 交接快照
  + 对话对齐缺口文档），origin/main 已同步。
- **下一步（已定稿，待统一批次执行）**：对话对齐 ZCode 的**宿主（pi rust 引擎）侧**改造——
  缺口清单见 `docs/zcode-parity-gaps.md`（P1 会话行投影 / P2 productTurn+workSegments /
  P3 块级状态计时 / P4 最终正文标记 / P5 错误事件 / P6 subagent·hook·marker 行 /
  P7 行序列读取 API）；tauri 侧 agui 映射与前端启发式收在该文档 §5 附录（下游）。
- **bots 插件移植完成度审计**：`docs/bots-port-gaps.md`（插件源码 121 文件原样；
  宿主适配 P0 缺 `prompt.submit`（群聊轮次不执行）/P1 事件面 9 通道无生产者/
  MCP/技能市场/relay/composer 贡献面未接；**不是 100% 功能复刻**）。

**✅ 2026-11-13（续）：MOSS 工具面全协议落地 + mock vendor 全链 E2E 通**。
`lib/moss-tools.ts`（host 原生只读集 6 个 sync 工具 + `run_cron_job_now`
async_effect，用户定稿口径）+ `lib/moss-tool-flow.ts`（纯协议态机：call_id
去重 / cancel_requested 迟到丢弃 / ≤4 并发 / ≤128 会话 / 120s 超时失败输出
——失败可见，规矩 12）；接线 = `MossLiveSession.attachToolFlow()` +
voice-live-panel moss 臂。pi 内置工具**不透传**（语音场景审批面不可见），
tool_task.revise/.cancel 无 UI 不做（不做死代码）。**E2E（mock vendor 配
假 key 打通整条真链）**：声明→get_now sync 回报→cron trigger 失败输出→
cancel 丢弃，全部 PASS；排障揪出并修掉两个真缺陷：①Rust 桥无 path 的
base_url → tungstenite request line `GET ?…` 非法 → 400（normalize_base_url
+4 Rust 测）；②onClosed 静默吞断线 → 红显 reason。门禁：tsc 0 / vitest
**792**（64 文件，+33）/ cargo test **138**（+4）。cargo check 有 **5 条
既有 warning**（2 unused import + 2 must_use PlanChange + 上游 agui.rs
CoerceUnsized——11 月轮欠账，非本轮引入）。**真 key 端到端（模型真调工具）
仍待 platform.moss.cn key**。细节见 `AGENTS.md`「MOSS 工具面」段。

**✅ 2026-11-03：对话层对齐 ZCode 轮结构（阶段 1-3 全落地）+ 扩展系统接通。**
四道门禁全绿（tsc 0 / vitest 697 / cargo check 0 / cargo test 123），全部实机验证。
细节与实机踩坑见 `AGENTS.md`「轮（turn）层」「阶段 2」「阶段 3」三节。

- **扩展系统**（阶段 0，RPi 插件前提）：`pi_extensions.rs` 照抄 pi CLI 的
  `ResourceLoader` 发现链；`create_session_opts` 把 `extension_paths` 交给
  `SessionOptions`（此前恒空 = pi 扩展能力整块不存在）。`pi_get_state` 新增
  `hasExtensions`。实机闭环：探针扩展 `hasExtensions: true`，坏清单错误
  如实传播。
- **轮层**：`turn-units.ts`（一条 user 开一轮，11 单测）→ `MessageTurnList`
  轮容器替换扁平 `ThreadPrimitive.Messages`（`Unstable_MessageById` 按 id
  挂载）。
- **轮级操作条**：一轮只挂一条（`isLastContentAssistantOfTurn`），4 条
  assistant 只出 1 条（实机）。
- **时间线标记**：新 IPC `pi_get_timeline_markers`（model_change/compaction
  + 消息索引）；`timeline-marker-store` + ZCode 分隔线形态。**索引口径必须
  与 hydrate 同一**（只数 user/assistant）。
- **轮尾文件汇总**：`turn-file-changes.ts` 现场聚合（edit 有真值、write
  行数 null 不造 0），挂操作条之前。
- **工作段折叠**：`work-segment.aui.tsx` 折叠 `group-chainOfThought`（=
  宿主的工作段），「已工作 N 秒」/「已处理」，running 恒开无头。
- **轮导航器**：`turn-navigator.aui.tsx` 左缘竖条 mini-map（≥864px 且
  ≥2 query），悬停预览、点击跳轮。
- **顺带修的投影缺陷**：水合路径 toolResult 的 `details` 被拼掉——历史
  会话 edit 的 diff / submit_plan 审批态全丢。已统一为流式的 ToolOutput
  对象形状。

**✅ 2026-11-03（续）：阶段 4 三项落地**——框选工具条（复制/引用到输入框，
守卫定位照抄 ZCode）、会话内查找（Ctrl+F，CSS Custom Highlight 高亮 +
n/m 计数导航；坑：`Highlight` 构造器在 window 全局不在 CSS 上）、子代理
单行摘要（ZCode 单行形态；宿主无下钻面，展开看输出，注释已记）。门禁
tsc 0 / vitest 719 / cargo 123。**遗留专项**：工具组跨 reasoning 边界
（需照抄 ZCode 的 reasoning 可见性规则 + 自建 work-items 扫描替换
GroupedParts——渲染核心重写，单独一轮做，方案见 AGENTS.md「阶段 4」节）。
另：清理了仓库根 10 个历史探针残渣文件（空文件 + 依赖图临时产物，
untracked）。

**✅ 2026-11-07：对话层对齐收官**——「工具组跨 reasoning 边界」专项落地：
`assistant-work-items.ts`（ZCode `buildAssistantWorkRenderItems` 扫描，18 单测）
+ `work-parts.aui.tsx` 渲染器**替换 `MessagePrimitive.GroupedParts`**。思考
可见性 = ZCode 默认（每消息只显示首条，其余剔除——不渲染/不断族组/不计时
长）；实测 `[思考,bash,思考,bash,思考,read,bash,text]` → 一个「查阅」组
跨两条被剔除的思考合并 4 子工具，思考行只剩首条，正文在折叠区外。叶子机制
（part scope / 注册工具 UI / data 渲染器 / indicator）与官方逐条对齐，其中
`PartByIndexProvider` 用公开 API 复刻（官方不导出，`MarkdownTextPrimitive`
读 `s.part` 没 scope 就空）。**groupBy 指纹机制退役**（详见 AGENTS.md
「分组器（2026-11-07 改版后）」）。门禁 tsc 0 / vitest 733 / cargo 123。

**✅ 2026-11-07（续）：机器人页完整移植**——hermes plugins/hermes-bots 的
roster-pane 全链路落到 `bots-pane.tsx`（用户口径：**左栏右侧弹出独立栏**，
Mirach 点击开合，不再切侧栏视图）。BotFace 程序化头像（avatar.tsx 1158 行
逐字字节复制 + profileColor shim）、用户分区 + 行拖拽归区、行右键菜单、
已隐藏区、对话框头像选择区（形状/颜色/图片）全落地；bots-store v2 扩
hermes BotMeta 字段（v1 自动升格）。群聊/网关/Routines 等 pi 无承载面
**不造假 UI**（逐项见 AGENTS.md「机器人页完整移植」表）。门禁 tsc 0 /
vitest 734 / cargo 123。

**✅ 2026-11-11：GPT-Live 双工语音桥（"moss live"查证 = hermes gpt-live）**。桥接层全落地：
Rust `pi_voice_live.rs`（status + SDP 交换端点，key 不进前端，6 测）+ 前端
`lib/voice-live.ts`（VoiceLiveSession 逐段移植，13 测）+ voice-live-store +
composer VoiceLiveButton/字幕面板。实机：status IPC 通、无 key 红显 hermes 同文
reason。**委托回路（voice→agent→commentary）待接**（runtime postRun 桥，红显）；
配 OpenAI key 即为真 API 会话。门禁 tsc 0 / vitest 752（61 文件）/ cargo test 134。
**✅ 2026-11-10（续2）：间距度量全对 + BotsDialog 完整结构 + per-bot 工具集真生效**。
间距按 hermes dialog.tsx 源码值（gap-3 p-4 / 标题 15px semibold / footer gap-2 /
labeled gap-1.5；实测 15px 根字号换算全对）。BotsDialog = CreateAgentDialog
骨架（Advanced 折叠 → 四页签：常规/技能/工具/MCP；高级态 768px + resize:both）；
工具页签 17 组真数据；BotPreset.toolsets → bot-launch 映射 enabledTools →
pi_create_bot_session 新参 → SessionOptions.enabled_tools（Rust 胶水透传，
pi_agent_rust 未动；目录读失败传播不降级）。门禁 tsc 0 / vitest 739 /
cargo test 128。

**✅ 2026-11-12：委托回路全链路（上一轮红显拆掉）**。驱动组件
voice-live-conversation.tsx（provider 内）：pendingDelegation 消费（busy 先
cancelRun → aui.thread.append 官方通道提交；voiceContext 前置进文本——pi 无
模型输入旁路）+ 200ms 回复驱动（句界 speak / 工具名 think / 15s 宽限）+
口语停止词（voice-stop-word.ts：hermes 英文表 + 中文等价，整句判）+
speech-text.ts 逐字复制（回复语音净化）+ 种子 history。配 OpenAI key 即为
完整 GPT-Live：说话 → 委托 → agent 干活 → 语音转述。门禁 tsc 0 / vitest 759（62 文件）。
**✅ 2026-11-12（续2）：per-bot 例程真绑定（RoutinesStubPane 退役）**。pi_cron
Job 加 bot 字段（serde default 兼容旧 jobs.json；仅归档/过滤——执行参数创建时
由前端从 bot 预设填进 provider/model/prompt）。RoutinesPane 真面板（作业表/
创建/立即运行/暂停/恢复/删除）。实机：IPC 直查绑定 + 过滤 + 清理全通。
**✅ 2026-11-12（续3）：moss live 接通收尾——设置页「语音」节**。vendor

**✅ 2026-11-12（续4）：真身确认 = 模思智能 MOSS Live（不是 OpenAI）**。

## ⚠️ 换会话须知（2026-11-12 收尾时写，新会话先读这段）

1. **C 盘**：~~23GB rollout~~ **已删（2026-11-13 新会话执行，1.53→25.07GB）**。
   **经验**：每轮对话别跑太长——model-io rollout 会持续膨胀（那次的根因）。
2. **dev 实例**：11-13 早上机器已重启，**exe/vite 都没在跑**。启动 = vite
   `npx vite --port 1430 --strictPort` + exe（`npm run tauri dev` 或直接跑
   debug 二进制）；重建 Rust 前先 Stop-Process mirach-harness。
3. **门禁基线**：tsc 0 / vitest **792**（64 文件）/ cargo test **138**——
   11-13 工具面轮后。cargo check 有 **5 条既有 warning**（pi_mcp.rs unused
   Path / pi_voice_moss.rs unused on_big_stack / pi_session.rs 两处 unused
   PlanChange / 上游 agui.rs CoerceUnsized overflow）——11 月轮欠账，
   **不是新引入**，哪轮顺手清哪轮。
4. **下一轮候选**：MOSS key 配置后的真语音端到端（platform.moss.cn key；
   Live 计费页未标价，免费待确认）——**含工具面验证**（模型真调
   get_now/list_cron_jobs + run_cron_job_now 的 async 回报链，工具面协议
   已落地，见 AGENTS.md「MOSS 工具面」）；hermes 的 officeoffice 模式
   （用户此前说先不做）。
5. **⚠ 整个 11 月的工作未提交**：main 恒在 10-19 的 bd88e55，10-22 换栈
   wry 起的全部轮次（设置独立窗口/审查面板/技能页/cron/机器人页/轮层/
   语音双桥/工具面）都只在 `G:\mirach-harness` 工作树里——一次误操作
   checkout/reset 就全没了。**新会话开工前建议先让用户拍板提交一个存档点**。

用户纠偏后查 platform.moss.cn：moss-live-1.0 = WSS 全双工语音（真双工+
barge-in+client delegation），且 vendor 官方委托后端 Option 1 就是 pi。
宿主桥：Rust pi_voice_moss.rs（tokio-tungstenite 新依赖；WSS 握手头持 key
——浏览器设不了 WS 头，事件/音频经 emit 广播）+ 前端 lib/moss-live.ts
（16k 采集上行/48k 排队播放/barge-in 确认/transcript 全文覆盖字幕）+
mode=moss-live 全链（status.mossAvailable/设置第三 radio/MOSS key 只写）。
委托回路与 GPT-Live 共用（VoiceSessionLike 接口，驱动零改动）。门禁 tsc 0 /
vitest 759 / cargo 134。另：C 盘满根因 = 本对话 model-io 日志 23GB（在写
不可删），已清 Temp 1.1GB + cargo cache 0.14GB（0.8→2.03GB）。
contract 对官网三页逐条核对全一致（POST /v1/live/sessions 201 / gpt-live-1 /
oai-events / 事件集全对上；差异仅 ICE 宽松放行与 200/201 兼容）。应用内两步
接通：设置 → 语音 → 粘 key + 切 gpt-live → 保存（pi_voice_live_set_config
→ persist_voice_live_config RMW；key 只写不读有测试守着）。实机：假 key 写入
→ status available:true 翻转无泄漏 → 清除复位。门禁 tsc 0 / vitest 759 /
cargo test 134。

**✅ 2026-11-10（续）：新建分区/新建群聊两个对话框逐段对齐**。分区对话框
空白 = .set-card 70vh 两列大卡（display:block 补丁漏了它）→ 420/auto 紧凑卡；
分区嵌套结构全量对齐（renderUserSections：网关桶内嵌套 / filter=具体连接切
回平铺 / 孤儿连接红显桶 / 空块规则）。群聊对话框照 CreateGroupChatDialog
重写（搜索/徽章/BotFace 成员行/Checkbox/图片/空名默认成员名/创建群聊 (N)/
上限 6）。内存结论：5.4M = 宿主进程私有内存（一直没变）；大头在 WebView2
dev 进程，重启即回落。门禁 tsc 0 / vitest 739。

**✅ 2026-11-10：子页全量对齐 + 内存实测**（用户"所有的子页面一模一样"）。
工具条 Filters 落地（kind/gateway 真 + activity 禁用红显）；屏幕/per-bot 例程
两个红显占位子页（bot-subpages.tsx，行菜单真入口）；群聊房间结构升级（头像栈/
行头像/右对齐/@提及高亮/成员 chips）；编辑对话框技能多选（pi_capabilities 真
清单 + skills 拼进 systemPrompt 真效果）+ MCP 红显段。顺带修两真缺陷：
CreateGroupDialog/SectionDialog 缺 Esc 关闭层；多连接分支不渲染群聊分区。
内存实测：冷启动 webview 392MB WS / 堆 112MB / 宿主 68MB——"变高"= 三天连跑
的 HMR 累积，重启即回落。门禁 tsc 0 / vitest 739。

**✅ 2026-11-08：永久会话锚定修正 + 会话侧栏隐藏真接线**（用户核对引擎事实
"pi 无 hidden 会话面、无 title 唯一索引"后全链路修正）。vendor 坐实：sessions
表只有 path 主键（session_index.rs init_schema:723），name 无唯一索引；无会话
级 hidden 面。两处修正：①bot-launch **sessionId 锚定**（create 采纳返回快照
的 sessionId、路径按 id 匹配；open 后 pi_get_state 身份校验——不符清锚重建，
无锚旧记录借此锚定；名字匹配已废）；②thread-list **真接侧栏隐藏**（此前头
注释声称 botSessionNames 过滤但从未实现——假声明；现在 useThreadDisplay 按
`botChatPaths()` 双锚 path 集过滤行投影与搜索面；删 bot = 锚消失 = 行重现）。
克隆 bot 补清 chatSessionId。实机直证：锚定/复用/隐藏（bot 在场行不在）/重现
（删 bot 行回）/删除（活动会话被引擎拒，切走可删）全 PASS；孤儿探针会话与
锁文件已清。单测 +5（botChatPaths）。门禁 tsc 0 / vitest 739（60 文件）。

**✅ 2026-11-07（续2）：机器人栏间距/排列对齐 hermes row-geometry**（用户
"间距，排列样式还是有区别"的收口轮）。逐项对照 hermes 源码常量（`row-geometry.ts`
`chrome.tsx` `bot-row.tsx` `roster-pane-toolbar.tsx` `roster-sections.tsx`
`search-field.tsx` `button.tsx icon-xs`）改 `bots-pane.tsx`：

- **搜索框** = SearchField underline 变体：无边框（border-b transparent），
  静止 opacity-50 / 聚焦 100 / 有词 100，icon 3.5 + 输入 0.75rem + 清空钮。
  原带边框圆角盒删除。
- **段头** = RosterSectionHeader 逐类对应：`px-2 py-1.5`（原 px-2.5 pt-2 pb-1）
  + caret 折叠（全部区块可收）+ 前导图标 + 计数**同色** font-normal（原
  muted/50）+ 悬停 ⋯（用户分区，右键同菜单双击改名）+ `mt-1 pr-1` 组。
- **不可达连接**：头部文字照常 quaternary，**尾部**小红标"未接通"
  （hermes 放 amber 断连图标的位；宿主占位规则用红）+ **行头像置灰**
  （hermes sourceStatus.available 的 grayscale opacity-60）。
- **状态点** = SessionStatusDot idle：`size-1` quaternary，装进
  SidebarRowLead 的 **14px 固定前导格**（名称左缘与左栏会话行同线）；
  原 6px 绿点裸放删除。
- **细节行**：handle = `font-mono text-[0.6875rem]` + `·` 分隔（原无 mono
  无分隔）；置顶/隐藏标记 `size-[0.6875rem]`（原 12px）。
- **行栈间距**：行间 `gap-px`（1px，原 gap-0.5）；块间 gap-0.5；全部区块
  收进**一个** `grid gap-0.5 px-1.5 pb-2` 容器（原每区自画 px-1.5 + 段头
  px-2.5 → 左缘差半像素；现在段头/行同线 9.5px）。
- **工具条钮** = icon-xs：`size-6 rounded-[4px]` svg 12px（原 p-1 约 20px 盒）。
- **群聊行** = GroupRow：34px 头像列 + size-8 圆角盒 + ring（原 14px 图标
  裸放——与机器人行头像列没对齐）。
- **隐藏区** = roster-pane-content :137-172：`border-t` 分隔 + caret +
  font-medium（**非大写**）+ 计数尾缀；**删掉额外恢复钮**——恢复走行右键
  「取消隐藏」（隐藏行本体照常渲染 + eye-closed 标记，hermes 同款）。
- **拖拽落区** = SectionDropZone：拖拽飞行中全部合法落区 `ring-inset`
  淡描（BotsPane 持 draggingBot state，行 dragstart/dragend 上报——hermes
  $draggingBot 同构），悬停中块 `bg-accent/10 ring-accent` lit；源块
  （isSource）不描不接收。原只亮段头删除。

实机验证（CDP）：搜索 opacity 0.5→1→0.5 + 清空钮、段头折叠行 1→0→1、
段头 px 7.5/py 5.625/大写/字距全对（15px 根字号）。门禁 tsc 0 / vitest 734。

**✅ 2026-11-07（续）：多环境配置 + pi pkg 做成插件——落地并实机验证 + 完整对齐收尾**。
- **永久会话**（bot-launch.ts 重写）：BotPreset 加 `chatSessionPath`——首启
  `pi_create_bot_session` + `pi_list_sessions` 按 bot 名找到会话文件路径存入；
  再启 `pi_open_session` 打开同一条（上下文保留 = "This chat never resets"
  的宿主对偶，纯前端不改引擎）。会话文件被删时退回首启（路径清空重建）。
- **群聊**（假面标红）：bot-stub-store 加 groupChats（本地 log）+ CreateGroupDialog
  （群名+成员多选≥2）+ GroupChatWorkspace（pane body 替换：头+标红提示条+log
  +发送框+成员条）+ 花名册群聊行 + New… 下拉新建群聊项。机器人互发不发生——
  发送写本地 log，UI 全标红。
- **克隆机器人**（真）：右键复制预设（新名+新 createdAt，不复制 chatSessionPath）。
- **与此机器人开新聊天**（真）：另起一条普通会话（不动永久会话）。
- **打开屏幕**（假面禁用）：红显"未接通"。
- **活动通知铃**：切偏好存 localStorage，标红"派发未接通"。
- **New… 下拉**：hermes roster-pane-toolbar 同位——新建机器人/新建群聊/新建分区
  三项（goo Popover 同体系）。
- **插件体系**：`src/contrib/` 三文件（types/context/plugins）——hermes
  contrib 模型的最小复刻（Contribution/HarnessPlugin/PluginContext，贡献
  id 自动 `plugin:<id>:` 命名空间）；首批 bundled 插件 = mirach-connections
  + mirach-pkg。
- **连接注册表**（pi_connections.rs + connections-registry.tsx）：v2 模型
  完整（local 恒在不可删 / label 查重 / URL·ssh 端点查重 / primary 重定向
  / 坏文件 local-only 兜底），hermes connections-registry.tsx 的列表行 /
  内联编辑器 / Test/Make primary/Edit/Remove 移植。local = 真面（test 走
  引擎快照），remote/cloud/ssh = 假面标红"远端 gateway 未接通"。
- **包管理**（pi_pkg.rs + pkg-manager.tsx）：直调 vendored PackageManager
  blocking 面（install/remove/update/list + add/remove_package_source），
  全真实数据（源列表同步落 settings.json 上游通道）。
- **设置页接线**：settings-overlay 消费 settings.page 贡献（SectionId 加
  `plugin:${string}` 动态臂 + 插件集成组动态填充 + render 分流）。
- 实机验证：IPC 全通（list/save/remove/test/local 真测/remote 假面 stub）；
  设置窗口导航含连接+包，连接页渲染+添加连接+存档持久化+清理全通；包页
  渲染+空态。门禁 tsc 0 / vitest 734 / cargo test 128 / cargo check 0。
- 设计文档（源码锚点）= `docs/HANDOFF-multi-env-pkg.md`。

**对话层对齐（ZCode v4 全链路）至此全部完成**：轮层 / 轮级操作条 / 时间线
标记 / 轮尾文件汇总 / 工作段折叠 / 轮导航器 / 框选工具条 / 会话内查找 /
子代理单行 / 工具组跨 reasoning。机器人页 = hermes Bot Mode 的宿主对偶。
真模型端到端仍是唯一硬阻塞（DEEPSEEK_API_KEY 401）。

**⚠️ 实机事故记录（2026-11-03）**：造测试夹具时探针脚本按 mtime 挑"最新
会话文件"，误覆盖了 `2026-10-26T05-10-13.592Z_c7e53723.jsonl`（用户的
会话「1」）。已按当时记录的元数据忠实重建（header 原样 + 一条内容 "1" 的
user 消息），但**若原会话还有其它条目（model_change / 多轮），已不可恢复**。
教训（已写进夹具脚本）：**写会话文件必须按 sessionId 精确匹配文件名，绝不
按 mtime 挑**。

**✅ 2026-10-30：「技能与工具」页 hermes 真搬移植，全部按最新上游源码**
（用户定稿）。四道门禁全绿（tsc 0 / vitest 567 / cargo check 0 / cargo test 87），
四个 tab 已实机验证。

镜像纯度：**485 文件正文与 `apps/desktop` 逐字一致**，唯一差异是
`i18n/zh.ts`（补了上游缺失的 connectorsPage 中文，207 键）。守卫脚本
`node scripts/audit-mirror2.mjs`（AST 比对，import 前缀改写不算差异）。

页面行为**完全等于上游默认**：卡片网格布局 · 单 profile 时环境下拉框隐藏 ·
已安装条目追加在目录末尾 · tab 左对齐。此前按用户逐项选择加的三条偏离已全部
回滚（`scripts/host-patches.mjs` 已删）。

**镜像重建后必须重打的手写文件**（`hermes-mirror.mjs` 先删后拷）：
`i18n/zh_connectors_page.ts`、`lib/text.ts`、`scripts/hermes-cluster1-stores.mjs`
拷入的上游 store 原件。

细节与**实机暴露的 4 个真实 bug**（tab 点击失效 / 整页英文 / 上游 zh 缺
connectorsPage / 73 令牌+13 类未定义）见 `docs/HANDOFF-hermes-port.md`；
那份文档也记了两个**按上游保留的已知缺陷**（宿主 10 万条目录下已安装技能被
分页截断、单 profile 环境下拉框隐藏）。

**桌面壳跑在 Tauri 3.0.0-alpha.4 + wry（WebView2）上，三栏 dockview 布局、
pi 真引擎（AG-UI HTTP+SSE）全链通。**

- 最近一次换栈（2026-10-22）：运行时从 `tauri-runtime-cef` **换回
  `tauri-runtime-wry`**。CEF 相关代码、二进制、缓存已删净；CDP 走
  `additionalBrowserArgs`（9223）。
- 窗口几何（2026-10-22，照搬 hermes）：首屏 = 屏幕工作区 × 0.88，夹在
  1280×820 ~ 1760×1100；**尺寸/位置/最大化态存 `window-state.json`**
  （`%APPDATA%\com.mirach.harness\`，原子写、坏档判废、离屏坐标丢弃）。
  栏宽是定值 **300 / min 270 / max 400**，窗口缩放时钉回绝对宽。
- 冒烟（2026-10-22，wry）：窗口起来、三栏几何正确（左/主/面板）、
  dockview CSS 全在、IPC 通（`pi_list_sessions` 返回 22 条）、零 console 错误。
- 窗口边缘（2026-10-23）：修掉"黑线直角边"——真因是 Win11 的 DWM 1px 描边
  （`DWMWA_BORDER_COLOR`），不是阴影也不是 CSS；同时子类化 `WM_NCCALCSIZE`
  抹掉 tao 预留的 resize 边框，**顺带修掉窗口尺寸逐轮膨胀**
  （1760 → 1824 → 1872）。细节见 `AGENTS.md`「窗口边缘那圈线」。
- 设置页（2026-10-23）：左导航重组为 5 组 20 项（基础设置 / Agent 控制 /
  安全与数据 / 插件集成 / 关于）。**动效与结构来自 beui `animated-sidebar`
  的本地裁剪版**（`src/components/motion/animated-sidebar.tsx`：删掉 Provider
  状态机 / Ctrl+B 快捷键 / 移动端抽屉与 body 滚动锁 / 折叠态，保留全部菜单项
  与子选项 + `layoutId` 滑动 pill + `clip-path` 子级 stagger）。4 节接真数据
  （模型 / 记忆 / 安全 / 版本与更新），16 节是**写明原因的占位**。
- 设置独立窗口（2026-10-23）：设置页改为**真 OS 窗口**（能拖出壳、可 alt-tab、
  可独立缩放）。新增 `pi_open_settings_window` / `pi_close_settings_window`；
  `main.tsx` 落地 `?win=settings` 分派；`wire_window` 抽为两个窗口共用的装配
  （DWM 四步 + 子类化 + 事件 + 首屏落盘）。同时修掉 4 处单窗口假设
  （wndproc 单槽 → map、几何存档按 label 分文件、capabilities 加 label、
  browser args 必须与主窗一致）。细节见 `AGENTS.md`「多窗口」。
- **设置窗首屏提速 + 白屏/黑屏（2026-10-30）**：用户报"打开设置要等很久，
  先白屏再黑屏然后出页面"。CDP 实测设置窗首个文档 **198 个 `/src/` 模块、
  144 个来自 `components/`**（含 dockview / assistant-ui / thread.*，全是主窗
  聊天的东西），First paint **2988ms**。根因是 `main.tsx` **静态 import 了
  `App` 整棵树**——静态 import 在模块图求值阶段无条件加载，与"只渲染
  `SettingsWindowRoot`"无关。改成按 `?win=` 分支**动态 import** 后：
  33 个模块 / First paint 356ms / FCP 788ms。白屏黑屏另有两个成因：
  `html, body { background: transparent }`（`base.css:18`）让 WebView2 先露
  默认白底、样式生效后露合成器黑底。修法 = `index.html` 内联首屏底色 +
  `base.css` 把 `html,body` 底色改成 `--surface-shell`。
  **不要为了简洁把 main.tsx 改回静态 import。**
- 设置入口三形态（2026-10-23）：桌面 → 独立窗口；浏览器直开 → 壳内浮层
  （`invoke` 在浏览器里必抛 TypeError，不能走窗口路径）；移动端 → 运行时问
  `supportsMultipleWindows()`（Android 12L+/iPad 支持窗口，iPhone 退回浮层）。
  决策抽成纯函数 `lib/settings-shell.ts` + 6 条单测。**web 端已实测**：
  浮层可打开、20 项齐全、IPC 失败显示可读文案。
- 门禁：`tsc` 0 / `vitest` **577** / `cargo test` **86** / `cargo check` 0
  （仅一条上游 agui.rs 递归深度 warning）。

- **审查面板完整复刻（2026-10-27）**：旧简化版整体替换为 hermes 桌面端
  `apps/desktop/src/app/right-sidebar/review/` 的逐文件移植
  （`src/components/panes/review/`：index / file-tree / scope-row /
  ship-bar / churn-bar / tree-data）。配套：
  - `review-store.ts` 按上游 `store/review.ts` 逐字段重写（zustand）：
    scope（未提交/分支/上一轮）、树/列表持久化、seq 守卫 + 100ms 防抖、
    轮次基线表（lastTurn 的 baseRef）、ship 流。
  - Rust `fs_git_*` 扩到上游语义：`review_list/diff` 带 scope+baseRef
    （`branch` 用 merge-base，`lastTurn` 用 baseRef）、新增
    `fs_git_rev_parse` / `fs_git_commit_context` / `fs_git_create_pr`；
    `fs_git_commit` 补"无暂存先 add -A"与 `push -u`；`fs_git_ship_info`
    的 `ghReady` 改为 **gh 已认证**（`gh auth status`，上游同义）。
  - 状态归约照抄上游：porcelain 两列保留、`status_letter` 单字母、
    `is_staged` 看 index 列（有单测守着）。
  - 新增原语：`components/ui/codicon.tsx`（@vscode/codicons 字体，与上游
    同源）、`diff-count` / `segmented-control` / `split-button` /
    `generate-button` / `confirm-dialog` / `tip` / `chat/skeletons` /
    `chat/diff-lines`（FileDiffPanel + shiki 高亮 + 固定行窗口化）/
    `hooks/use-delayed-true`；`tokens.css` 补 `--ui-green` / `--ui-red` /
    `--ui-diff-*` / `--ui-bg-tertiary` 等别名。
  - **如实不做的两处**（各有就地注释）：AI 生成提交信息（宿主无会话外
    一次性 LLM 端点 → 按钮 disabled + 说明）、「交给 agent 提交」（宿主
    composer 无 action 注入面 → 不渲染）。
  - 实机验证（CDP）：面板挂载、树/列表切换（6 顶层 → 48 行）、三个 scope
    切换与只读提示、真实 727 个变更文件与目录聚合、62KB diff 渲染、
    还原确认框。调试句柄 `window.__reviewStore`（与 `__dvApi` 同惯例）。

- **技能与工具完整复刻（2026-10-27）**：旧两 tab 简化版替换为 hermes 桌面端
  `apps/desktop/src/app/capabilities/` 的结构 —— `src/components/panes/capabilities/`
  （index 页壳 + skills-tab + toolsets-tab + unavailable-tabs + catalog/ 全套
  12 个文件）。四 tab：技能 / 插件 / 连接器 / 工具集。
  - **技能**：接 `pi_capabilities` IPC（真实装载结果）；开关走
    `pi_set_skill_enabled`（落 `~/.pi/agent/harness-capabilities.json`），
    编辑走 `pi_read_skill` / `pi_write_skill`，归档走 `pi_delete_skill`。
  - **工具集**：17 组（宿主对 pi 内置工具的语义分组投影，UI 如实说明
    "pi 本身没有 toolset 概念"），开关走 `pi_set_toolset_enabled`，只影响新会话。
  - **插件 / 连接器 = pi 真实能力**（2026-10-27 用户纠正"引擎侧有插件系统
    和 mcp 啊"——此前我写成"宿主暂无"是错的）：
    - **连接器 = MCP 服务器管理**（`src-tauri/src/pi_mcp.rs`）：
      `pi_mcp_servers` 分层读配置（`.pi/mcp.json` → `.agents/mcp.json` →
      `~/.pi/agent/mcp.json` → 外来文件，走 pi 自己的
      `McpDiscovery::discover`）、`pi_mcp_upsert_server` /
      `pi_mcp_remove_server`（`write_project_config` read-modify-write）、
      `pi_mcp_test_server`（`McpManager::test` **真起进程/发 HTTP**）。
      宿主会话侧本来就每轮调 `sync_extension_mcp_registrations()`。
    - **插件 = pi 扩展管理**（`pi_extensions`）：扫
      `~/.pi/agent/extensions/*` 与项目 `.pi/extensions/*`，用
      `load_extension_manifest` 读清单（id / 版本 / 运行时 / 能力声明），
      解析失败如实透出。**不做启停开关**——pi 的扩展在会话启动时装配，
      运行中开关不生效（页面上写明"新建会话才生效"）。
    - hermes 那两页的 hosted SaaS 账户面（它的网关 OAuth）宿主确实没有，
      页头如实说明。
  - **技能中心（catalog）数据源 = GitHub awesome 清单**（用户定稿："用
    Awesome 代替"）：`AWESOME_SOURCES` 表，skills = awesome-claude-code
    （实测 252 条 / 32 分类）、plugins = awesome-mcp-servers（4636 条）。
    解析器 `parseAwesomeMarkdown` 认三种条目形态（裸条目 / `- 描述` /
    `by [作者](url) - 描述`），`## 标题` 成分类，元信息节整节跳过（有单测）。
    **清单条目不可安装**（pi 无 hermes hub 协议）→ 卡片给"打开仓库"。
  - 配套新增：`components/ui/` 的 `switch` / `alert` / `row-button` /
    `search-field` / `masonry` + `Button` 的 `text|chip` variant 与
    `text|inline` size；`styles/catalog.css` / `catalog-discovery.css` /
    `page.css` / `masonry.css`；`src/assets/catalog-wing-retro.svg`；
    `--ui-chat-bubble-background` / `--ui-text-primary` 等令牌别名。
  - **`lib/query-cache.ts`**：宿主没有挂 TanStack Query 的 Provider，为一个
    页面加全局 Provider 不划算 → 实现同语义的最小查询缓存（并发去重 /
    staleTime / 失败停在错误态 / 空闲预热）。将来真接 RQ 时换薄适配即可。
  - **CSP 放开**（`tauri.conf.json`）：`connect-src` / `img-src` 增加
    `raw.githubusercontent.com`、`*.githubusercontent.com`、`github.com`、
    `api.github.com` —— 清单要直连 GitHub 拉取，原 CSP 只放行本地回环。
  - 实机验证（CDP）：四 tab 切换、技能中心 75 张卡 / 10 个分类货架 / 精选
    滑块 / 分类 chip（+29 折叠）、搜索（"mcp" → 37 张）、工具集 17 卡片
    17 开关且真实写盘、插件 tab 的如实标注。

- **定时任务完整复刻（2026-10-31）**：hermes 的 `cron/`（43 个 Python 文件 /
  19,009 行）在 Rust 侧重写为 **`src-tauri/src/pi_cron.rs`**（自包含模块，
  可整体摘除），前端从 `apps/desktop/src/app/cron/` **逐字复制**进
  `src/hermes-mirror/app/cron/`（6 个文件）+ 侧栏区
  `chat/sidebar/cron-jobs-section.tsx`。
  - **为什么不是 pi 扩展**（先查过事实）：扩展生命周期绑会话
    （`ExtensionRegion` 归 `AgentSessionHandle`，`sdk.rs:3586` 的
    `has_extensions` 要求会话传了 `extension_paths`），而调度器必须在
    **没有会话时**触发——根本矛盾。宿主也**没有前端插件系统**
    （`src/contrib/` 只有 `.gitkeep`）。所以"插件式集成"的实际形态 =
    独立文件 + 独立 `pi_cron_*` IPC + 独立存储 + 独立面板。
  - **后端**：`~/.pi/agent/cron/{jobs.json, executions.jsonl, output/, sessions/}`。
    jobs.json 原子写（tmp + rename + fsync）；executions.jsonl 追加式
    （崩溃半行可跳过）；调度四种语法照抄上游 `parse_schedule`
    （裸时长=重复 / `in 30m`=一次性 / 自然语言周几 / 5 字段 cron / ISO 时间戳），
    cron 表达式是自写引擎（**不引新 crate**，字母月份显式拒绝而非当 0）。
    60s ticker 走 std 线程（pi future 不能进 tokio），**先持久化推进
    `next_run_at` 再执行**（at-most-once，上游 `scheduler_tick.py:160` 同款）；
    每作业运行权守卫（内存 BTreeSet，等价上游 fire_claim CAS 的单进程版）。
  - **执行**：独立会话（`SessionOptions.session_dir` = `<cron>/sessions`，
    不碰用户活动会话），600s 不活动看门狗（上游 `_cron_inactivity_seconds`
    默认值），输出文档落 `<cron>/output/<job>/<时间戳>.md`，台账记
    `claimed → running → completed|failed`。**失败如实传播**：实测 deepseek
    key 无效时返回 `success:false` + 完整 provider 错误，作业记
    `last_status=error`。
  - **数据面**：`src/hermes-shim/api/cron.ts` 把上游 REST 换成 `pi_cron_*`
    IPC，**形状保持上游 snake_case**（`schedule_display` / `next_run_at`）——
    Rust 内部 `Job` 是 camelCase，`job_to_wire()` 做投影层。不投影的表现是
    "频率/上次/下次"全显示 `—`（实测踩过）。
  - **有意的裁剪**（每条都写进代码注释）：投递只有 `local`（宿主无
    Telegram/Discord/Slack/Email 适配器）；monitor/wake gate 脚本闸门未做。
  - **蓝图 16 个全部实现**（2026-10-31 补，先前的"返回空数组"裁剪已推翻）：
    核实后 16 个里只有 5 个带 `skills`，其余 11 个是纯 prompt 模板。处理 =
    全部照抄 + 去掉 `skills` 字段 + 把"跑某个技能的过程"改写成自包含指令。
    顺带修正一个**上游数据 bug**：`competitor-watch` 的 `recurrence` 槽是
    `weekdays` 类型（options = everyday/weekdays/weekends），上游默认值却写成
    `"monday"`——上游自己用默认值填槽也会抛 `unknown recurrence 'monday'`。
  - **补了 4 个上游 zh 缺失键**（i18n 三件套例外）：
    `lastRunFailed` / `editJob` / `runAgain` / `overdueSince`——缺失时界面
    中英混排（实机看到 "Last run failed: / Edit job"）。
  - **实机验证**（CDP）：入口条点击 → 页面渲染（`定时任务 / 0 个任务 /
    暂无排程任务`）；建作业 → 列表出现（`每 1 小时 / 下次 2026/10/31
    05:48:01`）+ 侧栏 `CRON JOBS` 区；暂停 → `state=paused`；恢复 →
    `scheduled`；立即触发 → 真跑 agent（凭据无效 → 失败横幅 + 台账两行 +
    会话文件 + 输出文档）；删除 → 列表清空。
  - **蓝图 UI 验证**（CDP + 真实鼠标事件）：蓝图区 16 行全部渲染
    （`data-panel-row="blueprint-*"`）；点 `hydration-move` → 编辑器弹出，
    槽位正确（How often / Start hour / End hour / Where to deliver）；点
    「安排任务」→ 对话框关闭、任务数 1→2、后端 `0 9-17/1 * * 1-5`
    （**小时字段步长生效**，不是退化的每分钟）。
  - 门禁：`tsc` 0 / `vitest` **595**（47 文件）/ `cargo test` **122** /
    `cargo check` 0。镜像纯度 `SAME 503 / INTENTIONAL 3 / DEV 0`。

## 未做清单

1. **真模型端到端（唯一硬阻塞）**：配凭据后验证工具真数据形状、图片理解、
   压缩真触发、用量成本真数字、thinking 流式、自动命名 LLM 段。
2. **设置页**（用户自己做）：hermes 的 115 个 settings 文件全量在树里，
   切面见 `AGENTS.md`「待办 2」。
3. **最后一波接线**：message-queue / checkpoint UI / cost-meter /
   read-aloud / regenerate-menu。
4. **pi 0.6.x 升级**（breaking：MCP project_trusted）——等真模型基线。
5. **谱系树嵌套**（`list_sessions` 透出 `branchedFrom`）。
6. **终端保活**：面板级 `renderer:'always'`（2026-11-18）已解决"同组切标签
   卸载 → 终端会话结束"；剩余**跨布局重建/重启**的会话恢复 = ZCode 式模块级
   registry，独立一轮。
7. 人工验收 + i18n + L5 移动端。

## 环境速查

```bash
# 开发（vite 1430 + tauri 窗）
set "PATH=%USERPROFILE%\miniconda3-mirach\Library\bin;%PATH%"
npm run tauri dev

# 全量重编（换依赖/运行时后，避免并行 OOM）
cd src-tauri && cargo build -j 1

# 门禁
npx tsc --noEmit
npm test
cd src-tauri && cargo test
```

- CDP：`127.0.0.1:9223`（`curl 127.0.0.1:9223/json/list` 看 page target）。
- 布局存档：localStorage `mirach.harness.layout.v10`；栏旗标
  `mirach.harness.layout.colflags.v1`。要出厂形态就删 v10 再 reload，或右键
  「默认布局」。
- 应用数据：`%LOCALAPPDATA%\com.mirach.harness`（WebView2 的 `EBWebView/`）、
  `%APPDATA%\com.mirach.harness\session-meta.json`。
- 终端 PTY / AG-UI 端口在启动日志里（`[agui] listening on 127.0.0.1:<port>`）。

## 验证习惯（别省）

- **行为验证走真实 UI 路径**（真鼠标 `Input.dispatchMouseEvent` / 真实菜单
  点击）——CDP 动态 import 项目模块会拿到第二个模块实例，模块级状态不共享
  （AGENTS 陷阱 9）。
- 断言侧栏内容查行 DOM，不查 body 全文（消息气泡同文会假阳性）。
- 行级交互（切换/拖拽）必须用真实鼠标事件；合成 click 不可靠。

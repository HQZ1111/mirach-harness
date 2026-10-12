# 轮次演变史（2026-10-06 AGENTS.md 瘦身时切出）

> 生产就绪收口/elements 接线/会话管理对标/侧栏重审计/对标续/排版轮/
> 标签溢出定稿+双行块对齐/sessionCatalog 单一真相源——逐轮细节。

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
- **三十三轮（2026-10-05，6c180f7）——对话区宽度设置：dsh mirach 移植件
  完整搬运**（用户提供 G:\deepseek-harness-master\apps\mirach）：①
  lib/chat-width.ts 逐字移植（zosma 三档 small 820/medium 1080/full 无
  限制；存储键 mirach.chatWidth；applyChatWidth 落 --chat-max-width/
  --chat-composer-max-width 到 documentElement）；②store/ui-settings.ts
  （dsh 同名文件形状，仅取对话宽度切片，nanostores→Zustand）；③main.tsx
  启动 initUiSettings（首帧即正确列宽）；④thread.aui.tsx 可读列
  --thread-max-width 跟随 var(--chat-max-width, 44rem 回退)，composer 同
  列自动跟随（dsh 需独立 composer 变量因其 composer 在列外，harness 同
  列）；⑤设置页新增「对话」段居首（MessageSquare 图标 + set-select 控件，
  文案照抄 dsh General 段）。**不搬 conversation-width.ts**：其观察目标
  （centerCol/data-phase/WidthHandle）是 dsh 官方 ConversationRoot 内部
  DOM，harness 的 assistant-ui 栈没有该树——将来接官方 ui-conversation
  包时一并移植（lib 头注释留档）。CDP 全链：默认 820→切中 1080→刷新
  持久化→还原 small；443 全绿 tsc 0。
- **三十四轮（2026-10-05，109cf9e）——对话宽度改用 dsh 官方 WidthHandle
  （用户纠正："不是 zosma 的，是 dsh 的"）**：三十三轮的 zosma 三档移植
  理解错了方向，本轮整体替换。①width-handle.tsx = 官方
  ui-conversation ConversationRoot 的 WidthHandle 完整移植（指针捕获 +
  rAF 合帧 + **对称缩放**：外移 1px 内容宽 +2；指针 Y 发布光条变量；**有
  位移的松手才落盘**——原地按放不得用夹紧显示值覆盖已存偏好；
  pointercancel/丢捕获放弃手势）+ 宽度轴 hook（ResizeObserver 发布
  --dsh-conversation-column-width 与重夹后的 --dsh-chat-user-width；**列宽
  变化偏好等比迁移** = apps/mirach conversation-width.ts 补丁行为，官方
  只重夹不迁移——最大化/还原时宽度跟随缩放）；②panes.css 手柄几何/
  光条/宽度轴照抄官方 module.css（40px 条带/24 内缩/24 安全区/3px 光条，
  窄列算负自动归零；dsw-alias-scrollbar-hover-l1→--text-4）；③
  thread.aui.tsx 消息列走 --dsh-chat-content-width（自适应=列宽 64% 夹
  [330,920]；CONTENT_MIN 330 = dsh 检出里已带的 mirach 调参），双手柄
  仅对话在屏渲染（hero 无列=dsh 同语义）；④zosma 三档四处全撤（settings
  段/main init/lib/store）。**两处有意偏差**：resolveContentWidth 与 CSS
  clamp 完全一致（官方 TS 的 max(680,…) 地板在 <1063px 列与其自身 CSS
  打架，harness 主栏常驻该区间——照抄会"抓柄瞬间跳宽"）；偏好等比迁移。
  **CDP 验证**：自适应 477、拖拽实时发布+落盘、刷新持久化、等比迁移
  330×(712/474)=496 分毫不差、悬停光条显形。**验证坑**：①会话水合期间
  手柄随 !isEmpty 卸载——赶在水合窗口按下手柄 = 打在空处（首次拖拽无效
  的假象，等水合完再拖即好）；②窗口最小化时 viewport=160px，布局在压缩
  态被持久化（清 v6 也救不了——每次重载都再压缩再存）——测试前先用
  PowerShell ShowWindow(9) 恢复 mirach-harness.exe 窗口。443 全绿 tsc 0。
  **二轮纠正（用户实测两项）**：光条色 --text-4 深灰发黑 → 令牌化
  --width-handle-glow；悬停/拖拽任意一侧 = 两侧光条一起显形
  （:has 根选择器，官方只亮悬停侧——两侧缩放同一宽度，对称可见才是
  正确可供性，用户定稿）。**三轮纠正（用户实测两项）**：①光条色定为
  **品牌蓝**（--width-handle-glow → var(--brand)，neutral-300 灰被否）；
  ②两侧光条高度不一致——指针 Y 只发在悬停侧、另一侧停在 50% 中线，
  改发到**父容器**（thread 根）两侧共享同一坐标（两柄同高同位，坐标
  空间一致）。
- **三十六轮（2026-10-05，c4d14ef）——顶带 chrome 跟随激活页签（用户
  定稿："项目名和logo应该是哪个标签在激活显示哪个，切换显示的时候跟着
  切换"）**：①onRenderTabSet：选中=会话列表 → logo leading；选中=对话
  页签（workspace/session-*）→ data-chat-lead 标记——**按激活互斥**
  （同分栏叠加不可能，位置论作废）；②ChatLabelOverlay 重写锚定 =
  **选中态对话页签所在 tabset**（跨 tabset 找、border 折叠不算、宽<100
  竖轨隐藏），订阅 dragRev；③railform 收敛为只包会话窗格自身内容
  （node.getId()==='sessions'——原"父分栏包含 sessions"会把同分栏
  workspace 内容也误包 logo）；④data-chat-zone 标记改按激活对话页签
  （中线起排 CSS 随激活切换）。**附带三件**：双行块会话名限列宽 50%
  （40vw→50%）+ 悬停看全名（span title + pointer-events:auto 放行——
  锚层整体 none 否则 title 永不显形）；光条品牌蓝 **50% 透明度**
  （color-mix 掺透明——用户定稿）。CDP：拆分布局上带 logo/下带双行块
  各自正确；同分栏切页签四连互斥无误；title/50% 生效。443 全绿 tsc 0。
  **描边全去（用户定稿："壳，所有栏的描边效果不要了"）**：.app-shell 的
  1px ring 删除 + `--flexlayout-color-splitter: transparent`（分栏发丝线
  不再画；1px 元素保留 = 布局数学 SPLITTER_PX 不动，悬停/拖拽蓝保留为
  拖拽可供性）。
  **顶带 85（用户定稿："顶栏高度改为85，原来100的标题栏高度也改成85"）**：
  `--logo-strip-h` 100→85 一处取值（标题栏/顶带/双行块锚层/边框轨让位/
  竖轨 padding 全走该令牌自动跟随）；唯二绑死字面量已清（MainTint 的
  stripH 回退 100→85）。
  **圆角三档（用户 2026-10-05 定稿）**：壳 50→**40**（base.css .app-shell；
  resize 手柄离角 50 仍大于圆角不用改）、主对话颜色层 40→**30**
  （--main-tint-radius）、输入框 24→**20**（官方 kit composer.tsx 的
  rounded-[24px] 是真实圆角来源——--composer-radius 只喂编辑态；同文件
  另一处 rounded-[24px] 是 chat-panel 示例未接线未动）。CDP：40/30/20。
  **遗留值清账（用户："代码中还有很多老数据遗留"）**：分拣扫描命中后
  只修**真遗留**——①resize 手柄离角 50→**45**（壳圆角 40 后不再需要
  50）；②六处过时注释（composer-wired 24、flexlayout 条隐藏/边框轨
  strip-100、chrome-overlays 顶带 100、tokens 主区颜色层 40/100 带注释、
  base.css 窗体 50px 注释）；③杂物空文件 b.width 删除。**保留不动**
  （合法的同数字他义）：状态栏/圆点的 50 padding（圆角 40 后有余量）、
  --logo-size 50（logo 图直径）、50%（中线/透明度）、chat-panel 示例
  24（未接线组件）。CDP 复核 85 带 + 40/30/20 全部生效。
- **三十七轮（2026-10-05）——拖拽黑块归因反转 + 删除**：用户截图
  （会话行拖出时旁边黑底白字块）——**不是浏览器原生拖影**（CDP 实查
  行/把手均无 draggable 属性，dnd-kit attributes 只有 ARIA），**正是
  drag-ghost 的深底白字 chip**（#1a1a22/#e6e6ea，跟指针右下 14/12px——
  与截图配色位置完全吻合）。会话行拖拽（session-drag.ts）删除 chip：
  engage 不再 createDragGhost、moveTo/destroy 拆除，「直接拖出的效果」
  = 源行压暗 0.45 跟手 + 落主页签 accent 高亮（原有反馈链不变）。
  drag-ghost.ts 保留（flexlayout 窗格拖拽 startPaneDrag 仍在用——
  若窗格拖拽的 chip 也要去，删 drag-session.ts 的 ghost 分支即可）。
  验证：MutationObserver 布探 chip 特征样式，拖会话行全程 chipSeen=
  false、源行 dimmed=true；443 全绿 tsc 0。**续（用户："标签拖拽还是
  黑底白字"）**：窗格页签拖拽（drag-session.ts）的 chip 同删——
  PaneDragSpec.ghostLabel 字段、spec.ghost 分支、moveTo/destroy 全拆，
  三个调用点（flex-layout 1585/1700/1979）去参；**drag-ghost.ts 整文件
  删除**（两消费方全去后无 import）。反馈链 = zone sheet/插入符预览 +
  no-drop/grabbing 光标（DropOverlay 侧不受影响）。CDP：拖页签全程
  chipSeen=false、dropOverlay 在、拖拽提交成功。**续（用户："标签还是
  没被拖出来"）**：克隆件从没创建——**真根因 = startPaneDrag 从宿主
  捕获段进入（onPointerDownCapture 挂 .flexlayout-host），capture 段
  currentTarget = 宿主不是页签按钮**，按 handle.classList 判定永远不中。
  修复：克隆源改 `e.target.closest(页签按钮类)`（真实按下元素上溯）。
  CDP：clone 跟随指针（页签尺寸/文字/opacity 0.95/pointer-events none，
  松手即拆）。
- **三十五轮（2026-10-05）——关栏左栏跳动根修（用户实测："关闭其中一个
  栏，左栏会跳动一下"）**：**根因 = 关栏后的根行权重归一闪跳帧**——
  DELETE_TAB 已改模型、React 提交按剩余权重归一渲染一帧（左栏份额突变
  349.6），90ms 串行通道才按记忆钉回（262）——廿四轮的"同步量测+90ms
  钉回"留了这个窗口。**修复 = DELETE_TAB 时同步钉回**（onModelChange 的
  DELETE_TAB 分支：measureRootPx 记录关闭前所见宽 → 立即 applyRootWeights
  写权重——React 提交帧即带最终几何，闪跳帧根本不渲染；90ms 通道保留作
  批量/兜底，二次执行幂等；pinPending 挂起期不插手）。**复现法（模型直
  操作，绕开拖拽几何）**：`window.__flModel.doAction(Actions.addNode(…,
  root.getId(), DockLocation.RIGHT, …))` 建临时列 → 逐帧采样左栏宽 →
  `deleteTab` → 修复前 trace 262→349.6→262，修复后仅 262。**坑**：探针
  里 flexlayout 的 Actions 要从 vite deps 缓存 URL `import()`（与应用同
  实例；裸对象 doAction 会炸链）。443 全绿 tsc 0。
- 教训：①间距/字号需求的落位要先确认**是哪两层之间**（"上下间距
  加大"本轮两次返工：组头→行间→组头间+工作区组间），按自认为的结构
  批量调 = 每轮都错一层；②cmd shell 的 findstr 对多点路径
  （`src\styles\*.css`）会漏匹配——删共享令牌前用 PowerShell
  Select-String 全量重查真实消费链；③PowerShell 正则改写 tokens.css
  后同文件 Edit 会报 modified-since-read——先 Read 再 Edit。


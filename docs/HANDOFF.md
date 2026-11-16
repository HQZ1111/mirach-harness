# mirach-harness 交接（新会话从这里接手）

> 本文只写**现在在哪、下一步做什么、环境怎么跑**。工程约束与踩坑见
> `AGENTS.md`（必读）；架构分层见 `docs/architecture.md`；布局语义见
> `docs/layout-design.md`；pi 集成规范见 `docs/pi-integration.md`。

## 当前状态

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
6. **终端保活**（同组切签会卸载隐藏窗格 → PTY 结束）。
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

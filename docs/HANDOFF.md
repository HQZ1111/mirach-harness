# mirach-harness 交接文档（2026-10-02 · 会话管理/对标轮后）

> **【2026-10-14 更新·晚】N1+L2 前端落地 + 修复轮**：
> N1 agent-protocol crate（crates/agent-protocol，58 测试全绿）+
> L2 前端封装（src/lib/ipc.ts InFlightMap / channel.ts SeqTracker，
> 43 测试全绿，提交 11a9c48）。**修复轮实锤**（6aeba15/42a7203/004d231）：
> ①dockview CSS 忘 import = "内容全错位"根因；②logo 域 .flexlayout-host
> 死了；③vite watch 未排除 crates/** → EBUSY 杀 vite；④最大化"闪烁
> 回来"真凶 = 自家 fit_to_monitor 边界 bug（非 Tauri3），已修+实证
> PASS；⑤**tauri-cli 3 自带 CEF 打包**（撤手动 cef-bundle 双冗余）；
> ⑥CEF 二进制 dev 态需手工补到 target/debug（清 build cache 后必补）。
> **当前是开发环境**（M4 打包只验证过 CEF 随包分发，离发布远）。
> 下步 = N2（pi-adapter 转换器切 agent-protocol 类型）。
> 新会话先读 AGENTS.md「已知的环境陷阱」v8.0 换栈 8 条（全部实锤）。

> **【2026-10-14 更新】架构 v9.0 定稿**（Agent-Native：§7-§14 全部入档
> `docs/architecture.md`——协议层 agent-protocol / 真相源总表 L1-L5 /
> 双通道 InFlightMap+SeqTracker/时序固化 / Sink 三 trait+契约测试 /
> 落地顺序 N1-N7）。**§3.5 的 agui_run 二命令面是指草稿，已被 §10.3
> 四模块命令面取代**（文档内已标 ⚠️）。下步 = N1 agent-protocol crate
> 落地（代码）。本文其余部分为 2026-10-02 快照，状态行已过时。

> **【2026-10-13 更新】M1+M2+M3 长任务完成**：
> M1 dockview 语义全量平移（9d3baa4，物理序 8/8 + 生命周期 + 持久化 v9）；
> M2 Tauri 3.0.0-alpha.4（5d8c3e7，显式 `.runtime()` + 冒烟全绿）；
> M3 **官方 tauri-runtime-cef 真切成功**——Miniconda 通道
> （cmake 4.3.1 + ninja 1.13.2 + VS2026 MSVC 14.51）修好构建链，
> CEF 窗跑起来了（CDP 9223 + invoke 全通 + 侧栏 15 行）。CEF 二进制
> 每次 clean 后要从 build 目录拷到 exe 旁（STATUS_DLL_NOT_FOUND 见
> architecture.md §1.2）；cargo 必须跟 cmake 同 PATH。下步 = M4 打包
> （CEF 二进制进安装包）。本文其余部分为 2026-10-02 快照，状态行已过时。

> **【2026-10-12 更新】v8.0 换栈已开工**：架构定稿（Tauri 最新 + CEF +
> dockview，`docs/architecture.md` + `docs/layout-v8.md`，无 Tauri2 退路）；
> **M1 骨架已提交（fbcef54）**——`src/components/layout/dockview-shell.tsx`
> 出厂三栏 [左|主|面板] + 打开页三按钮 CDP 全链通（`window.__dvApi` 调试
> 句柄；`hideHeader:true` = 左/主栏无标签；壳级 AssistantRuntime 必包）。
> 挂载仍 flexlayout，M1 语义平移（分栏/会话指派/根面板守卫/colOrder 动词
> → dockview api）完成时切 `app/index.tsx`。dockview 8.5.1 类型事实与踩坑
> 见 dockview-shell.tsx 头注释。本文其余部分为 2026-10-02 快照，状态行已
> 过时。

> 本文是**会话交接快照**：新会话从这里接手。工程规矩/历史踩坑的
> 唯一规范仍是 `AGENTS.md`（必读——最新两大节：「elements 接线轮」、
> 「会话管理/对标轮」）；pi 集成架构规范 `docs/pi-integration.md`；
> 上游 FR 清单 `docs/upstream-feature-requests.md`。不重复，本文只记
> "现在在哪、下一步做什么"。

## 一句话状态

elements 接线轮 + 会话管理/对标轮（ZCode+hermes 双参考）+ **对标轮续**
完成：**侧栏会话管理全套**（置顶/拖拽排序/拖到主会话标签/行菜单/分组
折叠）、**设置页主从两栏**（压缩/重试段 + pi Config 65+ 字段盘点）、
**分支语义双挂点**（顶部会话线谱系条 / user 消息变体条 2-2 切换实测）、
**runtime 性能三件**（增量同步/滚动持久化/自动命名规则段）、**ZCode 文
件树照抄落地**、**终端真 PTY**（ConPTY + xterm 多页签，PowerShell 实跑）、
**composer 对齐官方 elements**（附件上方/模型→语音→上下文环→发送/官方
三态 dictation/56px 附件 tile）、**聊天代码块与文件预览 shiki 高亮**、
user 复制/时间戳/滚动条弹窗令牌。门禁：tsc 0 / vitest **275** / cargo
test **40**，真窗口冒烟全通（终端 PowerShell 实跑/谱系条/变体切换/自动
命名/零控制台错误）。**唯一阻塞项不变：真模型凭据未配。**

## 提交与仓库

- 分支 main，本轮提交链（时间序）：14ad69d 分支语义拆分 → 85fc06f 文件
  树 → f01e8b0 设置页 → 494cc72 runtime 性能/命名+FR 清单 → 1e4aa9e
  侧栏管理 → b8c06a4 冒烟修复三件。均已推送。
- **上游 pi**：vendored 0.5.1 于 `src-tauri/vendor/pi_agent_rust`。同步
  流程：重拷白名单 + 核对两个 vendor 补丁（①session_index.rs:778
  `.read(true)`；②push-protection 脱敏）。**上游已发布 v0.6.1**（steer/
  follow_up SDK 原语 + Windows 保存修复=补丁①退休；breaking：
  MCP project_trusted）——升级立为里程碑，**等真模型端到端基线**。

## 已完成（累计口径）

1. pi-integration.md §7-1..5 + §7-7：完成（收口轮）。
2. **elements 接线**：23 个官方组件在跑（含工具结构化分流
   bash→终端块/web_search→搜索卡）、分支语义双挂点、图片端到端、
   8 个新 IPC（retry_edit/checkpoint 三件/fork 四件/lineage）。
3. **会话管理**：置顶/拖拽排序/拖到主标签/行菜单/自动命名/滚动恢复。
4. **设置页**：模型/凭据/压缩/重试/原始 JSON/关于。
5. **文件树**：ZCode 版真树（懒加载/虚拟化/吸顶/预览联动）。

## 未做清单

1. **真模型端到端（唯一硬阻塞）**：配凭据（env var/auth.json/models.json
   凭据引用——设置页「提供方凭据」段有指引）后验证：工具真数据形状、
   图片理解、压缩真触发、用量成本真数字、thinking 流式、自动命名 LLM 段。
2. **最后一波接线**（可接件清零）：message-queue（宿主排队；pi 0.6.x
   后可切官方 steer/follow_up）、checkpoint UI（命令面已通）、cost-meter、
   read-aloud（speechSynthesis）、regenerate-menu。（shiki 两件已完成。）
3. **pi 0.6.x 升级里程碑**（breaking：MCP project_trusted）+ 上游 FR
   提交（citations 模型/hostcall schema）。
4. **谱系树嵌套**：list_sessions 透出 branchedFrom（Rust 小改）→ 接
   hermes session-branch-tree 语义（├─/└─）。
5. **终端已知限制**：flexlayout 同 tabset 内切页签会卸载隐藏窗格 →
   「卸载=kill」语义下终端会话结束（默认布局独占分栏不受影响；跨切换
   保活=ZCode 式模块级 registry，独立一轮）；Windows IME 组合输入兜底
   未抄（验收后按需）。
6. ZCode 审计余项：重试计数徽章、异常轮强制展开、左 rail 回合导航（P3）。
7. 人工验收 + i18n + L5。

## 验证与环境速查

- 启动：`npm run dev`（vite:1430）+ Start-Process 分离
  `src-tauri\target\debug\mirach-harness.exe`（或 cargo run）。CDP 9223。
- 门禁：tsc（0）/ `npm test`（**275**）/ cargo check（零警告）/
  `cargo test`（**40**）。
- 冒烟脚本（%TEMP%）：`aui-round3-smoke.cjs`（自动命名/键检查）、
  `aui-round3e-smoke.cjs`（刷新+真鼠标点击行）、`aui-round3f/g`（谱系条/
  composer 观感）——**侧栏行切换必须 CDP Input.dispatchMouseEvent 真实鼠标**
  （行挂拖拽机器，合成 click 不可靠）；断言侧栏内容查行 DOM 不查 body
  全文（消息气泡同文会假阳性）。
- 直连 POST token 走 query；exe 报 "Command not found" = 未重编。

## 本轮新坑速记（AGENTS「会话管理/对标轮」有全文）

- pi_open_session 返回**模型条目串**非 sessionId——按路径切换后从
  pi_get_state 取 id。
- Tauri 命令返回 Option<String> → invoke 得**裸 string**——parse 别按
  包裹对象写（谱系条永不渲染的根因）。
- pi 分支模型 = **user turn 续接线**（每条分支以各自 user 消息开头）——
  变体条锚点=分叉点 user 消息。
- pi Config 有 titling.auto_title / steering_mode / follow_up_mode——
  自建逻辑先对齐这些键；system_prompt/enabled_tools 不在 Config。
- 自动命名派生标题=会话**开场消息**的截断，不是最新消息。
- prune 持久化守卫：列表非空才清（首帧空=未加载）。

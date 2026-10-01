# mirach-harness 交接文档（2026-10-02 · 会话管理/对标轮后）

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

# mirach-harness 交接文档（2026-10-02 · elements 接线轮后）

> 本文是**会话交接快照**：新会话从这里接手。工程规矩/历史踩坑的
> 唯一规范仍是 `AGENTS.md`（必读——本轮新增「elements 接线轮」大节，
> 收口轮大节在其上方）；pi 集成的架构规范是 `docs/pi-integration.md`。
> 三者不重复，本文只记录"现在在哪、下一步做什么"。

## 一句话状态

收口轮（安全/正确性/测试/死代码/vendor/设置页/打包）之后，完成了
**elements 接线轮**：官方 elements 库 118 件全量在树，pi 支持面全接——
图片端到端、编辑重跑（retry_edit 兄弟分支）、checkpoint/rewind、
fork 建新会话独立探索、分支切换（BranchPicker）、消息时间戳、工具结构化
渲染（bash→终端块、web_search→搜索卡）、usage 美元成本、压缩横幅、
错误/断连/空态全面升级。门禁全绿（tsc 0 / vitest **105** / cargo test
**39**），真窗口冒烟确认 fork 真通、分支真树、图片链真通、零控制台错误。
**唯一阻塞项不变：真模型凭据未配，端到端从未见过真模型回复。**

## 提交与仓库

- 工作目录 `G:\mirach-harness`，分支 main。本轮（elements 接线轮）提交链
  见 `git log`（Rust 桥接批 / 前端 elements+fork 批 / 文档批）；此前
  收口轮提交链（d6476fd…f22e01a）与 elements 恢复（abd6848）均已推送。
- **上游 pi**：vendored 于 `src-tauri/vendor/pi_agent_rust`（白名单拷贝）。
  同步上游流程：重拷白名单子集 + 核对**两个 vendor 本地补丁**
  （①session_index.rs:778 `.read(true)`，gh #239 同款；②push-protection
  脱敏：auth.rs Google OAuth 四常量 + secrets.rs 夹具字面量 →
  MIRACH-VENDOR-REDACTED）。上游真源 `G:\pi_agent_rust-main` 不进 git。

## 已完成（按 pi-integration.md §7 + 本轮增量）

1. **§7-1..5 + §7-7** 全部完成（收口轮，详见 AGENTS「生产就绪收口轮」）。
2. **§7-6 A2UI** 仍 MVP 后（本轮的宿主渲染约定 `{render, payload}` 是其
   最小雏形，未实装）。
3. **elements 接线轮增量**（AGENTS「elements 接线轮」大节有全文）：
   - 8 个新 IPC：pi_retry_edit / pi_mark_checkpoint / pi_list_checkpoints /
     pi_rewind / pi_fork_session / pi_get_fork_points /
     pi_list_sibling_branches / pi_switch_branch。
   - 图片端到端（POST images → run_with_content_with_abort，白名单 400）。
   - 前端：onEdit/onReload、attachments adapter、hydrate 时间戳+图片块、
     12 个官方组件挂载（bash 终端块/web_search 卡/工具错误/复制重生成/
     耗时成本/日期分隔/错误卡/中断卡/断连四相/空态/压缩横幅/工具结构化）、
     fork 入口 + BranchPicker + branch-store。

## 未做清单（含确切阻塞）

1. **真模型端到端（唯一硬阻塞）**：`~/.pi/agent/` 无 auth.json/models.json。
   配 key（env var / auth.json / models.json 凭据引用）后验证：多轮上下文、
   **工具真调用渲染**（bash 终端块/web_search 卡的真数据形状）、图片理解、
   压缩横幅真触发、用量环与成本真数字、thinking 流式。
2. **elements 剩余批次**（pi 支持面之外，按价值排序）：
   - message-queue 可视化（宿主本地排队——isRunning 时输入入队，run 结束
     自动发）；
   - read-aloud（浏览器 speechSynthesis，零 pi 依赖）；
   - checkpoint UI（命令面 pi_mark_checkpoint/pi_list_checkpoints/pi_rewind
     已通，缺 UI 挂载）；
   - sources 卡（web_search 结果解析出 URL——形状需真模型实测后定）；
   - 图表类（chart/data-table/code-diff/file-tree）——等宿主 details
     渲染约定 `{render, payload}` 立约定 + 自定义工具示例。
3. **pi 不支持、明确不接**：citations/sources（数据模型无）、steer/follow_up
   （in-process 无，POST 排队等价；message-queue 走宿主自管）、
   feedback/语音后端（无服务端）。
4. 打包：首跑已过（NSIS 83MB，`npm run tauri:build`，CARGO_BUILD_JOBS=2
   防 OOM）；updater 未配。
5. 人工验收 + i18n（UI 中英混排）+ L5 移动端：未启动。

## 验证与环境速查（细节见 AGENTS.md）

- 启动：`npm run dev`（vite:1430）+ Start-Process 分离启动
  `src-tauri\target\debug\mirach-harness.exe`（或 cargo run）。CDP 9223。
- 门禁：tsc（0）/ `npm test`（**105**）/ `cargo check`（零警告）/
  `cargo test`（**39**）。
- 冒烟脚本（%TEMP%）：`aui-round2-smoke.cjs`（发送/fork/mime/截图）+
  `aui-round2b-smoke.cjs`（图片 POST/retry_edit 分支链）——**直连 POST 的
  token 走 query 参数，Authorization 头不认**。旧脚本 aui-smoke-v4 等同目录。
- 直连 IPC 冒烟可用页内 `window.__TAURI_INTERNALS__.invoke`（CDP
  Runtime.evaluate awaitPromise 短超时）。
- exe 改 Rust 后必须重编重启；前端行为不变先怀疑 vite 陈旧模块缓存。
- GitHub push 偶发抽风：重试即可。**Push Protection 拦截时检查 vendor
  脱敏补丁是否还在（见上）**。

## 本轮新坑速记（AGENTS「elements 接线轮」有全文）

- pi 消息**有** timestamp；每条 assistant 消息带美元成本——旧认知两条都错。
- 官方模板三个不通用：day-separator（自带迷你列表，只能提取分隔行）、
  EmptyStateComposer（无输入框）、guardrail-notice（无错误槽位）。
- `plan_fork_from_user_message` 返回 Result 非 Option；分支 preview=离根
  最近；Agent 是投影改历史必须走 Session。
- StartRunConfig 无 modelOverride（探测 runConfig.custom）。
- 直连 POST token 走 query；仓库根不落地任何临时文件（`fn` 事故）。

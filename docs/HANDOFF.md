# mirach-harness 交接文档（2026-10-02 · 收口轮后）

> 本文是**会话交接快照**：新会话从这里接手。工程规矩/历史踩坑的
> 唯一规范仍是 `AGENTS.md`（必读，本轮新增「生产就绪收口轮」大节）；
> pi 集成的架构规范是 `docs/pi-integration.md`（v2.3+收口轮改注）。
> 三者不重复，本文只记录"现在在哪、下一步做什么"。

## 一句话状态

四域全量审查（Rust/聊天/布局/完成度，判定「内测级」）→ **收口轮完成**：
3 个 P0（stream 无鉴权 / CDP 留生产 conf / SSE 重连全量重放）+ 10 个 P1
+ 低成本 P2 全部修复；补齐 Rust 30 单测 + 布局/归约单测至 77；删死代码
119 文件 1.65 万行；pi vendored 脱离 G: 绝对路径；设置页 §7-7 落地。
门禁全绿（tsc 0 / vitest 77 / cargo check 零警告 / cargo test 30），
真窗口冒烟通过（UI 发消息 → RUN_ERROR 红条可见、设置浮层真数据开合、
零控制台错误）。**唯一阻塞项：真模型凭据未配（~/.pi/agent 无 auth.json
/models.json），端到端从未见过真模型回复。**

## 提交与仓库

- 工作目录 `G:\mirach-harness`，分支 main。本轮提交链（收口轮）：
  - `fb657b2` Rust 收口（stream 鉴权/CORS+Host/Last-Event-ID/async 命令/
    abort 竞态/审批清理 + pi_settings 5 命令 + agui 30 单测）
  - `a097744` pi vendored（白名单 255MB→22MB，session_index 补丁随迁）
  - `e70c102` 聊天链路（RUN_ERROR/断连可见 + thinking 渲染 + effort 接线
    + 流式切换守卫 + 禁止兜底三处清账）
  - `c019c41` 布局引擎（identity 四步优先级/浮动隔离/narrowViewport 单写者
    /absorbSurplus 留白修复/appliedTree 持久化 + 单测 34 例）
  - （后续）设置页 UI / 死代码清理 / 文档同步——见 git log。
- **上游 pi**：已 vendored 到 `src-tauri/vendor/pi_agent_rust`（白名单拷贝：
  src/examples/benches/themes + build.rs 嵌入资源；tests/ 187MB 未拷）。
  **上游真源 `G:\pi_agent_rust-main` 不进 git**。同步上游流程：重拷白名单
  子集 + **核对两个 vendor 本地补丁**：① `session_index.rs:778` 的
  `.read(true)`（gh #239 同款，Windows 会话持久化的命门；上游 v0.6.0+
  已含则自然同化）；② **push-protection 脱敏**（auth.rs 的 Google
  Gemini CLI/Antigravity OAuth client 四常量 + secrets.rs 夹具表假字面量
  → MIRACH-VENDOR-REDACTED；公开元数据/假夹具，GH013 拦截所需）。
  Cargo.toml 的 path 已指 vendor/，改回真源只需改这一行。

## 已完成（累计，按 pi-integration.md §7 落地顺序）

1. **§7-1 L3 骨架** ✓（PiRuntime/PiEngine/on_big_stack 大栈）
2. **§7-2 L2 AG-UI 桥** ✓（POST+常驻 GET 流+环形缓冲+映射器+审批注册表；
   本轮补 Rust 30 单测：映射器逐行/缓冲 seq/审批 respond+cleanup）
3. **§7-3 L1 渲染** ✓（turn-actor XState 轮次机 22 单测 + ExternalStore +
   thinking 渲染接通 + run 外事件守卫 + 交错 run fail-loud）
4. **§7-4 控制面** ✓（18+5 IPC 命令全 async 化；composer 三件套 + effort
   档位接线打通；多会话侧栏）
5. **§7-5 审批卡** ✓（链路 + 本轮鬼影卡根治：registry cleanup + respond
   Err 传播 + 前端失败刷新）
6. **§7-7 设置页** ✓（pi_settings.rs 5 命令：settings/models.json 整体
   替换写入+写前校验、auth_status 不回 key 内容；titlebar 齿轮 +
   settings-overlay：模型默认/凭据状态/原始 JSON 编辑器/关于）
7. **布局引擎** ✓（v3.1 规范逐节对齐 + 本轮 identity 优先级/浮动隔离/
   单写者/回家链①修复；absorbSurplus 留白 bug 由单测探出并修复）

## 未做清单（含确切阻塞）

1. **真模型端到端（唯一硬阻塞）**：本机 `~/.pi/agent/` 无 auth.json /
   models.json。配 key 后验证：多轮上下文、工具调用真渲染、用量环真实
   数字、thinking 流式（代码已就绪）。配 key 途径（pi 源码实锤）：
   env var（如 ANTHROPIC_API_KEY）/ auth.json / models.json 凭据引用
   （!命令、env:VAR、file:、裸大写名）——设置页「提供方凭据」段有指引。
2. **打包**：`npm run tauri:build`（tauri.prod.conf.json 已剥 CDP、
   bundle.active:true + nsis）——**尚未实际跑过一次**（Rust release 全量
   编译较久）；首跑可能遇 NSIS 下载/工具链问题。
3. **A2UI §7-6**：维持 MVP 后（§9 扫雷已清：三层全自建，属独立立项）。
4. **等扩展生态**：审批 select/input 真实形状；ask_response 卡。
5. **人工验收**：真机拖拽/多显示器/主题/长会话滚动；i18n（空骨架，
   UI 中英混排）；L5 移动端未启动。
6. **spec-debt（测试钉住的翻转点，非 bug）**：MessageUpdate 的
   *_START/*_END 未映射；STEP_FINISHED 未实现（usage 在 RUN_FINISHED，
   前端消费自洽）。

## 验证与环境速查（细节见 AGENTS.md）

- 启动：`npm run dev`（vite:1430）+ **Start-Process 分离启动**
  `src-tauri\target\debug\mirach-harness.exe`（或 `cargo run`）。CDP 9223。
- 门禁：`node node_modules\typescript\bin\tsc --noEmit`（0 错）、
  `npm test`（77）、`cargo check`（src-tauri，零警告）、`cargo test`（30）。
- 冒烟：`%TEMP%\aui-round-smoke.cjs`（本轮：UI 发送→RUN_ERROR 条+设置
  浮层+控制台错误收集+截图；ws 从 `G:/MIRACH/node_modules` 解析）。
  旧脚本 aui-smoke-v4/aui-multi-sess/aui-final-check 同目录可复用
  （**注意 GET stream 现在要 token**——旧脚本直连 POST 仍可用）。
- exe 改 Rust/caps 后必须重编译重启；改前端行为不变先怀疑 vite 陈旧
  模块缓存（Page.reload；顽固时重启 vite）。
- GitHub 网络间歇性抽风：push 失败等 30–120 秒重试。

## 本轮新增的坑（AGENTS「生产就绪收口轮」大节有全文）

- **SSE 重连全量重放**（头号 P0）：EventSource 原生重连复用挂载 URL 的
  陈旧 query——服务端只认 query 不认 `Last-Event-ID` 头就会整段重放。
- tauri `--config` 是 RFC 7386 合并：数组整体替换，prod conf 的
  app.windows 必须带完整窗口对象；`additionalBrowserArgs:""` 空串剥参。
- 注入页签按钮（fl-close-btn 等）必须进 onHostPointerDown 白名单——
  同类坑第三次。
- cmd 里 `if exist X rmdir Y & robocopy Z` 会把整条 & 链当 if 语句体。
- 设置浮层必须 portal 到 body（标题栏 z-50 stacking context）。
- TurnPart thinking 出口必须转 "reasoning"（ThreadMessageLike 形状）。
- vendored 拷贝时 `if exist` 坑 + tests/ 可安全排除（path 依赖不编译
  其 test targets）；doctor.rs 的 tests fixture include 在 cfg(test) 内。
- 空骨架目录靠 .gitkeep 存活（git 不跟踪空目录；本轮曾被连带删掉，
  已重建）。

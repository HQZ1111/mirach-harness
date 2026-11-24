# dsh 模式插件移植可行性报告（2026-11-23）

> 源 = `D:\deepseek-harness-master`（dsh，DeepSeek Harness）。
> 本文只做可行性判定与改造清单，**本轮不改代码**。
> 宿主 = mirach-harness（Tauri + React + pi_agent_rust / rpi-cli 0.27）。

## 0. 结论先行

dsh 的“模式”是**两层完全不同的东西**：

| 层 | dsh 包 | 形态 | 宿主现状 |
|---|---|---|---|
| 权限 / 计划 | `dsh-permission-presets`、`dsh-plan-mode` + 两个 client UI 包 | 会话级权限预设（沙箱 + 审批）+ 独立计划模式 | 计划门已有（无审批卡）；审批只有全局三态、无沙箱 |
| Agent 预置 | `dsh-agent-preset` + `dsh-agent-preset-registry` + `bundle/web-app/presets/*.patch.yml` | Cordis YAML 组合包，新会话选择 | 无主会话 preset；只有 bot 的 toolsets |

迁移判定：

| 目标 | 判定 | 说明 |
|---|---|---|
| 计划模式（UI + 进出） | **部分可移植** | 计划态、工具限制、入口/退出可做；dsh 的 `exit_plan_mode` 审批流宿主没有（`pi_decide_plan` 恒 Err，审批卡已删） |
| 工作区内修改 | **语义不可完整移植** | dsh = `workspace-write` 沙箱 + ask；pi 无沙箱，只能映射到 `ApprovalMode::Write`（写自动批、命令询问），**不能保证写不出工作区** |
| 完全访问 | **可近似移植** | dsh = `danger-full-access` + never + 二次确认；pi `ApprovalMode::Yolo` + 宿主风险确认可对齐，硬策略闸两边都仍在 |
| 仅可查看（read-only） | **不建议移植** | dsh = 只读沙箱 + ask；pi 无只读沙箱。用 `set_active_tools` 裁成只读工具只是“不给变更工具”，不是文件系统只读（且 bash 会整个消失） |
| 极简模式（Agent preset） | **可近似移植** | dsh = persona + readImage + compaction + 持久 shell，无 read/write/edit/search。pi 可用 `set_active_tools(bash,powershell,read)` 近似；`read` 会连文本一起开放（pi 无 readImage-only），也没有 dsh 的持久 PTY 语义 |
| PTC 模式 | **不可移植** | 依赖 `tool-executor-ptc` / `run_code` / PTC runtime，pi 无对应执行面 |
| 创造模式（cordis） | **不可移植** | 依赖 dsh Cordis Plugin Manager、`tool-cordis`、`dsh-doc` skill、agent-preset registry 整套运行时；宿主是 pi 引擎 + hermes 前端插件 SDK，架构不同 |

**一句话**：dsh 的**前端 UI 形态**可以逐文件移植；**后端模式语义**只能按 pi 现有原语做近似。把 dsh 的包“原样拷进来”不可行——它们 import `@deepseek-ai/dsh-*` 的 Cordis/client 运行时，宿主没有这些包。

## 1. dsh 侧事实（源码定位）

### 1.1 权限预设

- 预设表（沙箱 + 审批两件套）：
  `packages/bundle/base/cordis.patch.yml:270-282`
  - `read-only` → sandbox `read-only` + approval `ask`
  - `workspace-write` → sandbox `workspace-write` + approval `ask`
  - `danger-full-access` → sandbox `danger-full-access` + approval `never`
- 服务实现与投影：`packages/interaction/permission-presets/src/index.ts`
  - 默认预设 `workspace-write`；`danger-full-access` 的 approval 是 `never`（`:191-198`）
  - 新会话创建时 pin 初始权限（`:241-243`）
- 当前会话选择器（UI）：
  `packages/client/ui-permission-presets/src/client/PermissionSelect.tsx`
  - 触发器 = 权限图标 + 当前标签 + chevron（`:129-150`）
  - 菜单 = 预设列表；`danger-full-access` / `auto` 走 `RiskConfirmation` 二次确认（`:155-176`）
- 中文文案：`packages/client/ui-permission-presets/src/client/locales.ts:42-60`
  - `仅可查看` / `工作区内修改` / `完全权限`
  - 完全权限二次确认文案 `确认启用完全权限？`（含风险说明与勾选）
- 图标：`packages/client/ui-primitives/src/PermissionIcon.tsx`（四个 16×16 SVG，可直接拷）。

### 1.2 计划模式

- 客户端 UI：`packages/client/ui-plan/src/client/PlanModeControl.tsx`
  - `PlanChip` 只在**计划态生效**时渲染；点击执行 `/plan off`；hover 时图标从 plan 变 close-circle；失败行内可见（`:19-69`）。
  - 进入计划模式不是这个 chip 负责——dsh 用 `/plan` 命令/会话模式；chip 只负责显示与退出。
- 服务端：`packages/plan/plan-mode`（`exit_plan_mode`、计划投影、计划审阅）。
- 计划审阅与计划卡在 `ui-plan` 包内（PlanCards / PlanReviewOpen / 右侧预览）。

### 1.3 Agent 预置（标准 / PTC / 极简 / 创造）

- 声明机制：`packages/preset/agent-preset/README.zh.md`
  - preset = 普通 Cordis YAML 里的子插件列表；`id` + `plugins`；修改只影响之后创建的 Agent。
- 内置组合包：`packages/bundle/web-app/presets/`
  - `standard.patch.yml`：persona + instructions + time-context + bash/pwsh + fs + fs-search + jobs + schedule + skill + goal + plan-mode + compaction + subagent/workflow + ask + todo + web + cordis 检查 + present + office + plugin-manager/market
  - `ptc.patch.yml`：standard + `tool-executor-ptc`（PTC 运行时）
  - `minimal.patch.yml`：persona（complete）+ `tool-fs{read:false,readImage:true,write:false,edit:false}` + compaction + **persistent shell**（bash/pwsh，300s）——没有 read/write/edit/search/todo/ask/web/skill/subagent
  - `cordis.patch.yml`：standard + `tool-cordis` + `tool-plugin-manager` + `tool-plugin-market` + dsh-doc skill + 更长计划模式提示词
- 新会话 chip：`packages/client/ui-agent-preset/src/client/AgentPresetSeat.tsx`
  - 只在“还没有跑过 turn”的新会话显示；选择只暂存，成为当前会话时落地（文件头注释）。
- 设置页预置管理：`AgentPresetSection.tsx`（列表 / 默认 / 组合查看 / 创造模式入口）。

## 2. 宿主现状（pi / mirach）

| 能力 | 位置 | 事实 |
|---|---|---|
| 计划门 | `rpi-plan-mode` + `src-tauri/src/main.rs:1155-1180` | `/plan start|exit`；计划期间拒绝变更工具；`plan_mode_complete` 直接存盘退出 |
| 计划审批 | `src/components/thread.aui.tsx:1358-1360` | **没有**：`pi_decide_plan` 恒 Err、`planPending` 恒 null，PlanReviewCard 已于 2026-11-15 删除 |
| 审批模式 | `G:\pi-rust-main\crates\rpi-cli\src\approval_gate.rs:33-41` | 三态 `AlwaysAsk` / `Write` / `Yolo`；**进程级 AtomicU8**，不是会话级 |
| 审批桥 | `src-tauri/src/pi_engine_bridges.rs` | 宿主装 handler → 审批请求进宿主 AskCards；默认 Yolo，前端 localStorage 恢复 |
| 工具注册 | `G:\pi-rust-main\crates\rpi-cli\src\session.rs` | 内建 8 个（read/bash/edit/write/grep/find/ls/docs；Windows 另 powershell） |
| 工具集裁剪 | `G:\pi-rust-main\crates\rpi-harness\src\agent_harness.rs:6562+` | `AgentLane::set_active_tools` 可用；宿主只在 bot 会话用过（`pi_session.rs:3411-3462`） |
| 主会话工具集 | `src-tauri/src/main.rs` / `pi_session.rs:828` | `session::build` 无 per-session enabled tools；**没有 Tauri IPC** |
| 沙箱 | — | **完全没有**；bash/powershell 直接起进程 |
| PTC / run_code | — | 没有 |
| Cordis | — | 没有；宿主插件是 hermes 前端 SDK（`src/plugins`） |

另外两个宿主差异必须写进实现前提：

1. **审批模式是全局的**（`ApprovalMode` 是进程级 atomic）。dsh 的 permission preset 是**会话级**并在新会话 pin 住。要做会话级需要改引擎（或切会话时重设全局值，但并发窗格会串）。
2. **主会话没有预设概念**。bot 会话有 `enabled_tools`；主会话要在创建后调用 `set_active_tools` 并新增 IPC，且必须赶在第一条 prompt 前，避免 `active_tools_change` 落进历史、改变工具目录（dsh 的 preset 也是创建期固定）。

## 3. 逐项改造清单（若后续实施）

### 3.1 权限 / 计划 UI 移植（推荐先做，S/M）

目标：把 dsh 的触发器和菜单形态搬过来，不假装沙箱。

- 新文件 `src/components/assistant-ui/permission-select.tsx`
  - 直接照抄 dsh `PermissionSelect.tsx` 的 trigger/menu/confirm 结构与 `PermissionIcon.tsx` 的四个 SVG。
  - 选项映射：
    - `仅可查看`：**不出现**（宿主无沙箱只读面）；或在菜单里禁用并写原因（用户已定“不移植”，则不出现）。
    - `工作区内修改` → `pi_set_approval_mode("write")`；文案必须写明“写自动批、命令询问；宿主没有沙箱，不能限制在工作区内”。
    - `完全权限` → `pi_set_approval_mode("yolo")` + `ConfirmDialog`（children 放“我已了解风险”check；确认前禁用主按钮）。
- 计划：
  - 新文件 `plan-chip.tsx`，照抄 dsh `PlanChip` 的形态（active 才渲染，点击 `/plan exit`，错误行可见）。
  - 进入计划：保留现有 `/plan start` 入口（可做一个未激活时的 plan 图标按钮，或保留菜单项）。dsh 本身没有“进入 chip”，进入是 `/plan`。
  - **不要**恢复计划审批卡：宿主引擎没有 host approval gate；除非另立引擎 PR。
- 旧 `permission-mode-chip.tsx` 可保留兼容，或把 `thread.aui.tsx` 的挂载点换成新组件。
- 标签建议：dsh 的 `工作区内修改` / `完全权限` 与用户口语的“文件夹内修改 / 完全访问”不同；**选定一套后全应用统一**，不要在菜单里混用。

### 3.2 极简模式（Agent preset，M/L）

目标：新会话选择“标准 / 极简”，落地为 pi 工具集。

- 前端：
  - 新增 `src/components/panes/hermes-sidebar/agent-preset-chip.tsx`（与 `workspace-composer-menu.tsx` 同排，只在 `activeId === null` 显示）。
  - 新增 store（建议 `agent-preset-store.ts`）：`standard | minimal`，默认 standard；选择在新会话首条消息前生效。
- 后端：
  - 新 IPC `pi_set_active_tools(tools: Vec<String>)` / `pi_get_active_tools()`：定位当前 `PiEngine` 的活动 harness，调 `AgentLane::set_active_tools`。
  - 极简工具集建议 `["bash", "powershell", "read"]`（Windows 下 powershell 存在；read 为图片折中）。
  - 应用时机必须覆盖两个新会话入口：
    1. 懒创建（首条 prompt 前，`runtime.tsx` 的发送路径）；
    2. `选择文件夹` → `pi_new_session` 后（`runtime.tsx:1235`）。
  - 选择落库：新会话尚未有 session id 时先存 pending；`pi_new_session`/首条发送后写入会话元数据（或依赖引擎的 `active_tools_change` 持久化，重开自然保留）。
- 与 dsh 的差异（必须告知用户）：
  - dsh minimal 的 `readImage` 专属面在 pi 不存在；`read` 会同时开放文本读取。
  - dsh 的“persistent shell”是持续 PTY；pi 的 bash/powershell 是逐次调用（非持久会话状态）。
  - dsh minimal 没 persona 之外的工具；pi 的 `read` 会进入工具目录，KV cache 与 dsh 不等价。
- 不要在极简模式下允许中途切回标准：dsh 在跑过 turn 后拒绝换 preset；宿主若 `set_active_tools` 中途改会让工具目录变化（历史 + 缓存）。建议只在“新会话”允许选，会话开始后 chip 隐藏。

### 3.3 不建议做的项

- **仅可查看**：除非先做文件系统/进程沙箱。用工具裁剪冒充只读会误导（bash 被删后模型无法完成普通只读命令；保留 bash 又不是只读）。
- **PTC**：需要 `run_code` 执行器、内层调用审批、隔离进程/VM；与现有 pi 工具层不是一层。
- **创造模式**：需要 Cordis 插件管理器 + 运行时热装配 + dsh-doc 技能 + agent-preset YAML 编辑/安装链。宿主没有这些，且 hermes 插件 SDK 语义不同；另做“mirach 创造模式”是新产品，不是移植。

## 4. 工作量估算（粗）

| 项 | 估时 | 风险 |
|---|---|---|
| 权限/计划 UI 移植（不含审批卡） | 0.5–1 天 | 低；只动前端 + 现有 IPC |
| 完全访问二次确认 | 含上 | 低 |
| 极简模式（chip + store + 两处创建路径 + IPC） | 1–2 天 | 中；懒创建时序、会话元数据、Windows 工具名 |
| 会话级审批（引擎改 AtomicU8 → per-session） | 1–2 天 + 引擎 PR | 中高；并发窗格/全局状态 |
| 只读 / 工作区沙箱 | 3–5 天 + 引擎/OS 层 | 高；Windows 沙箱（Job Object/AppContainer/ACL）不属于现引擎 |
| PTC runtime | 周级 | 高；新执行面 |
| Cordis 创造模式 | 不可估 | 架构级；不建议 |

## 5. 建议

1. **先做 3.1**：dsh 的权限选择器 + 计划 chip 形态，映射到现有 pi 审批/计划原语；完全权限加二次确认。明确标注“无沙箱、工作区内修改是审批近似”。
2. **再做 3.2 极简模式**：只在新会话暴露，落地 `set_active_tools`；不要在会话中途切换。
3. **不做** 仅可查看 / PTC / 创造模式；菜单里不摆假入口（遵循 AGENTS 规矩 11：不假装成功、不做假 UI）。
4. 如果未来一定要 dsh 级的工作区沙箱/审核/创造模式，应单独立项评估引擎与 Cordis 移植，而不是在 UI 层“补语义”。

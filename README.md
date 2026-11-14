# Mirach Harness

MIRACH 的桌面壳与布局骨架（立项 2026-09-21）：Tauri 3 + wry(WebView2) +
dockview 三栏布局 + assistant-ui 聊天层 + pi 引擎（AG-UI HTTP+SSE）。

**新会话先读 `AGENTS.md`（工程约束/踩坑）与 `docs/HANDOFF.md`（当前状态/未做）。**

## 跑起来

```bash
npm install
npm run tauri dev        # vite 1430 + Tauri 窗
npx tsc --noEmit         # 类型门禁
npm test                 # vitest（507 用例）
cd src-tauri && cargo test   # Rust（53 用例）
```

全量重编（换依赖/运行时后，避免并行 OOM）：`cd src-tauri && cargo build -j 1`。

## 结构

| 目录 | 职责 |
|---|---|
| `src/components/layout/` | dockview 壳（`dockview-shell.tsx`）、栏动词（`dockview-column-ops.ts`）、收放约束状态机（`column-constraints.ts`） |
| `src/components/panes/` | 窗格：左栏、对话、会话分栏、文件树、终端、预览、打开页 |
| `src/components/assistant-ui/` | 聊天层：runtime、轮次归约（`turn-actor`）、工具呈现、活动面板 |
| `src/lib/` | IPC / 通道 / 窗口 / 转义层等基础设施 |
| `src/styles/` | `tokens.css`（令牌唯一源头）+ 各域样式 |
| `src-tauri/src/` | Rust：`agui.rs`（HTTP+SSE 与映射器）、`pi_session.rs`（多柄引擎）、`fs.rs`、`terminal.rs`、`session_meta.rs`、`main.rs`（窗口/托盘/DWM 圆角） |
| `crates/agent-protocol/` | 前后端事件协议类型骨架（未接线） |

## 文档

- `AGENTS.md` — 工程须知（必读）
- `docs/HANDOFF.md` — 交接快照
- `docs/architecture.md` — 分层与真相源
- `docs/layout-design.md` — 布局语义
- `docs/pi-integration.md` — pi SDK 集成规范
- 其余：`elements-wiring.md`（组件接线清单）、`engine-gaps.md`（引擎缺数据）、
  `pi-coverage.md`（能力覆盖）、`ui-token-plan.md`（令牌体系）、
  `upstream-feature-requests.md`（上游 FR）

## 与 hermes 的关系

hermes（`G:\参考文档`）是本工程的**参考实现与素材库**——组件、i18n 三件套、
交互语义都照抄；被替换的只有传输层（gateway → Rust 命令 → pi SDK）与布局层
（pane-shell → dockview）。

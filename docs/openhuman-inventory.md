# openhuman 可复用清单（2026-10-17 盘点）

> **【2026-10-18 状态】** 第 1 批（工具呈现层 4 文件）已落地并保留：
> `src/components/assistant-ui/tool-presentation/`。第 2/3 批（UI 原语、
> settings 壳）移植后已整体回退（13,569 行，实测 45/48 原语零调用）。
> 本文保留作为下次搬运的成本参考。详见 `openhuman-migration-plan.md` 顶部。

> 源：`G:\openhuman-main\app\src`（本地已有，无需下载）。
> 判据：**零/低依赖且语义与 pi 对齐**才可直接拿；带 redux/router/i18n/
> react-icons 或接 openhuman gateway 的，需改写数据层（成本高，不推荐整搬）。

## 0. 规模总账

| 目录 | 文件 | 行数 | 可直接拿？ |
|---|---|---|---|
| `components/ui` | 48 | ~5.6k | ✅ **大部分可直拷**（依赖仅 react/radix/cva） |
| `components/settings` | 132 | 27.9k | ❌ 85 文件依赖 i18n、11 依赖 router，面板全接 openhuman API |
| `components/assistant-ui/elements` | 49 | 7.8k | ⚠️ 与我们已有 elements 大量重复（同源上游） |
| `features/conversations/tools` | 8 | 2.3k | ✅ **纯数据/纯函数，高价值** |
| `components/flows` | 38 | 8.1k | ❌ 画布式工作流编辑器，接 openhuman flows API |
| `components/skills` | 20 | 5.6k | ❌ 接 openhuman skills API |
| `components/dashboard` | 9 | 1.1k | ⚠️ 成本仪表盘；`formatCurrency` 可直拿 |
| `hooks` | 35 | 4.8k | ⚠️ 少数纯 hook 可拿 |
| `lib` | 86 | 96.7k | ⚠️ 少数纯函数可拿（其余接 composio/flows/daemon） |

## 1. ✅ 零依赖，可直接拷（推荐第一批）

| 文件 | 行 | 依赖 | 价值 |
|---|---|---|---|
| `features/conversations/tools/toolChips.ts` | 138 | **无** | 工具参数 → 展示 chip（路径缩短、URL 清洗、长度截断）。**我们现在 `summarizeArgs` 是 10 行的土办法** |
| `features/conversations/tools/toolPhrases.ts` | 238 | **无** | 工具动词表（active/done 两时态：`Reading file` / `Read file`）。我们现在只拼 `${toolName} 运行中` |
| `features/conversations/tools/toolSpecs.ts` | 654 | lucide-react | **每个工具一条 spec**（图标/短语/分类/chip 规则/富文本体）。这是最大的单块收益 |
| `features/conversations/tools/toolPresentation.ts` | 394 | lucide + 上面三个 | 解析顺序（exact → action → family → fallback） |
| `lib/cron/cronToHuman.ts` | 91 | **无** | cron → "每天 09:00"。为将来定时任务备 |
| `components/dashboard/formatCurrency.ts` | 153 | **无** | 货币格式化（<1 分显示 `<$0.01`、-0 处理）。我们现在 `formatUsd` 只有 5 行 |
| `chat/promptInjectionGuard.ts` | 158 | **无** | 提示注入检测（规则打分 + 归一化）。安全向 |
| `hooks/useDebouncedValue.ts` | 17 | react | 通用 |
| `hooks/useMediaQuery.ts` | 26 | react | 通用 |
| `hooks/useEscapeKey.ts` | 17 | react | 我们已有 escape-layers，可能重复 |
| `hooks/useDismissLayer.ts` | 62 | react + 上一个 | 浮层外点关闭（比我们现在手写垫层干净） |

**合计约 2.0k 行，零/低依赖。**

## 2. ✅ UI 原语（依赖已装，可拷但**与我们 shadcn 重叠**）

我们已有 `src/components/ui/`（shadcn）。openhuman 的 48 个里，**真正新增价值的**：

| 组件 | 行 | 我们有没有 | 价值 |
|---|---|---|---|
| `DataTable.tsx` | 613 | ❌ 无 | 分页/排序/筛选/多选的数据表。**大件** |
| `Sidebar.tsx` | 758 | ⚠️ dockview 替代 | 两栏导航，我们用 dockview，**不适用** |
| `InputGroup.tsx` | 145 | ❌ 无 | 输入框前后缀组合 |
| `TileGrid.tsx` | 119 | ❌ 无 | 磁贴网格 |
| `Stepper.tsx` | 85 | ❌ 无 | 步骤条（向导） |
| `ConfirmDialog.tsx` | 103 | ❌ 无 | 确认框（我们散落各处） |
| `ModalShell.tsx` | 150 | ⚠️ 有 Dialog | 模态外壳 |
| `LoadingState.tsx` | 58 | ⚠️ 有 Skeleton | — |
| `StatusLine.tsx` | 46 | ❌ 无 | 状态行 |
| `Card.tsx` / `Field.tsx` / `ListRow.tsx` / `NumberField.tsx` / `Switch.tsx` / `Checkbox.tsx` / `NativeSelect.tsx` / `TextField.tsx` / `TextArea.tsx` / `Badge.tsx` | ~600 | 大部分有 | 风格差异，**不建议替换已有** |

**推荐拿**：`DataTable`、`InputGroup`、`TileGrid`、`Stepper`、`ConfirmDialog`、`StatusLine`（6 个，约 1.1k 行）。

## 3. ⚠️ 需适配才能用

| 模块 | 行 | 障碍 |
|---|---|---|
| `components/commands/CommandPalette.tsx` + `lib/commands/*`（5 文件 ~560L） | 560 | 依赖 `cmdk`（我们有）+ i18n `useT`。**改掉 i18n 即可用**，价值高（我们已有 command-palette 元素但没接） |
| `components/assistant-ui/elements/*` | 7.8k | 与我们现有 elements 同源（都源自 ai-elements），**逐文件比对后只取差异**，不整搬 |
| `features/conversations/components/AssistantUiToolCall.tsx` | 330 | 工具卡渲染，需把 openhuman 的 toolProps 换成 pi 的 |
| `lib/chat/toolCallEnvelope.ts` | 164 | 工具调用信封解析，依赖 `debug`（可去） |

## 4. ❌ 不能拿

| 模块 | 原因 |
|---|---|
| `components/settings/*`（27.9k 行） | 85 文件依赖 i18n、11 依赖 react-router、面板全接 openhuman gateway API |
| `components/flows/*`（8.1k 行） | 画布工作流编辑器，接 openhuman flows API（我们没有这个后端） |
| `components/skills/*`（5.6k 行） | 接 openhuman skills API |
| `components/dashboard/*`（除 formatCurrency） | 接 openhuman usage API |
| `lib/composio/*`、`lib/coreState`、`lib/daemon*` | openhuman 专有后端 |
| `features/human/Mascot/*`、`features/wallet/*`、`features/voice/*` | openhuman 特有功能 |

---

## 建议执行顺序

**第 1 批（零风险，纯函数）**：`toolChips` / `toolPhrases` / `toolSpecs` /
`toolPresentation` + `formatCurrency` / `cronToHuman` / `promptInjectionGuard`。
→ 直接改善工具卡的呈现（现在只有一个 `summarizeArgs` 土办法）。

**第 2 批（UI 原语）**：`DataTable` / `InputGroup` / `TileGrid` / `Stepper` /
`ConfirmDialog` / `StatusLine`。

**第 3 批（需适配）**：`CommandPalette` + `lib/commands/*`（去 i18n）。

**不做**：settings / flows / skills / dashboard / mascot / wallet / voice。

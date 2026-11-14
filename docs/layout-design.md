# MIRACH 布局语义（当前态）

> 载体 = dockview-react 8.5.1。本文只写**与载体无关的语义**与当前取值；
> 实现细节（收放约束盒、fromJSON 护栏、FLIP 等）在
> `src/components/layout/dockview-column-ops.ts` 的注释里，
> 架构分层见 `docs/architecture.md` §5。

## 1. 三栏与语义归属

```
┌──────────┬────────────────────────┬──────────────┐
│ 左栏     │ 主栏（对话）            │ 面板栏        │
│ 无标签   │ 无标签                  │ 唯一多标签列  │
│ 会话列表 │ 工作区名头 + 消息/composer│ 文件树/终端/预览│
└──────────┴────────────────────────┴──────────────┘
```

- 语义戳 = dockview panel 的 `params: { region: 'left' | 'chat' | 'panels' }`，
  随序列化自动带。
- 左栏与主栏**没有页签**（组 `hideHeader: true`）——面板页签不能拖入。
- 左栏与主栏**只能分栏**（并排/上下拆分），拆出的格通过侧栏指派会话。
- 面板栏是唯一有多标签的列：文件树/终端/预览以页签共存。

## 2. 根面板唯一

**打开页（`open` panel）所在组 = 面板栏的身份锚**。

- 面板列有实签 → `open` 锚撤下（锚与实签不并存）。
- 末签关闭 → 锚回来（组仍在，或按 colOrder 语义位重建）。
- `open` 不可拖出（`onWillDragPanel` 整钮拦截）——拖走 = 不经旗标地拆列。

## 3. 尺寸约束（按语义戳）

| 语义 | min | max | 默认宽 |
|------|------|------|------|
| left | **270** | **400** | **300** |
| chat | 395 | — | 吸收者（吃剩余宽度） |
| panels | **270** | **400** | **300** |

- **栏宽是定值，不随窗口缩放**（`rail-metrics.ts`，2026-10-22 用户定稿）。
  默认 300、许可 270–400；窗口变宽变窄，两轨都保持 300，主栏吃剩余。
- **窗口缩放后要重新钉宽**：dockview 的序列化按**比例**记列宽，1400 宽窗口
  恢复 1760 存档会把 300 摊成 240 左右。所以 `repinRailWidths()` 在 resize
  稳定后把两轨钉回目标宽（绝对 px），目标宽由用户拖 sash 更新。
- **主栏撞 min 时不记目标宽**：窗口窄到主栏触 `CHAT_MIN_WIDTH` 时 dockview
  会强行压窄某一轨（1000 宽下左栏 300→293），那是几何让位不是用户意图；
  记成新目标会导致窗口恢复后栏宽永久停在 293。
- 约束走**面板级** `minimumWidth`/`maximumWidth`（组约束回落到活动 panel 的
  同名值），随 panels 记录 round-trip。
- **收起态**（隐藏左栏/面板栏）= 宽度 0 + 组约束盒 `{min:0, max:0}`——只放开
  min 不够，max 留着会让分栏把它重摊出宽度（见 `column-constraints.ts`）。
- 上下最多 2 行不可再竖分（投放层拒）；左右不限。
- 配重吸收者 = **chat 语义列**；panels 按记忆宽托底。

## 4. 页签归属与拖拽

| 页签 | 能去哪 |
|------|------|
| 左栏 | **无页签**——文字切换视图，拖入拖出均不存在 |
| 对话栏页签（workspace / session-N） | **只能在对话栏内**：条内重排、拖出分栏；拖入左栏被拒 |
| 面板栏页签（files/review/terminal/preview） | **对话栏 + 面板栏**均可，且可拖出分栏 |
| 打开页（open） | **不可拖出**（根面板钉死） |

### 4.1 拖放准入（2026-10-22 定稿）

- **左栏不是拖拽目标**：不接收标签、也不在它周围分栏（判据 = 组内有
  `region: 'left'` 的面板）。`onUnhandledDragOver` 不 accept、`onWillShowOverlay`
  与 `onWillDrop` 双缝 `preventDefault`。
- **只有面板栏的标签能拖出分栏**；对话栏的会话标签走 dockview 原生分栏。
- **单标签组拖出必须自己接管**：dockview 的 `_doMoveGroupOrPanel` 在
  `sourceGroup.size < 2` 时走「整组移动」分支（同层 `moveView` 换位，不拆
  新组）——面板栏常态只有一个标签，于是"拖出来"永远只是换位。接管实现见
  `open-page-actions.ts::splitPanelOut`（补占位 → `moveTo` → 撤占位）。
- 判定语义有单测守着：`drop-admission.test.ts`。
| 会话行（左栏列表） | 拖到对话栏内容区 → 按落点开该会话分栏（center=堆叠、四边=分栏）；其余拒绝 |

**hideHeader 组不收 center 堆叠**：无条组收下第二个标签后不可见也不可切
（隐形标签死结）——`onWillShowOverlay` + `onWillDrop` 双缝拦。

## 5. 打开页（ZCode openTabLauncher 对照）

**ZCode 原始生命周期**：面板内容 = `sidePaneState`（tabs）| `null`；末签关闭 →
`null` 并收起面板；打开页渲染条件 = 面板开着但一个实签都没有的窗口期；
任一实签开出 → launcher 被页签 UI 替换。

**harness 映射**（打开页 = `open` 签）：

- **出现**：①用户显式「打开面板栏」（无快照即新打开页）；②boot 出厂
  （面板开着且无实签）。
- **消失**：①第一个实签开出（点文件树/终端/预览）；②最后一个实签关闭/拖走
  → 锚回来。
- 三个按钮（文件树/终端/预览）开出实签；文件树点文件 → 预览页签；
  终端重开回底部行。

## 6. 会话分栏（独立完整聊天运行时）

会话分栏 = **独立完整聊天**（`session-runtime.ts` `useThreadChatRuntime`）：
自己的轮次机 + per-thread SSE 流（`GET ?thread=<sessionId>`，引擎
`ThreadBuffers` 按线程分桶）+ 自己的 composer（`thread.aui` 的 `scoped`：
跳过主会话管理 chrome，消息/composer/思考指示/建议照常）+ 发送 POST 带
`sessionPath`（引擎 flush 当前会话切到分栏会话再跑，事件落本线程 buffer）。
水合 = `pi_get_session_messages(path)`。

**多柄并发**：引擎 `side_engines` 表——分栏线程键 → 独立 SideEngine（自己的
柄/锁/abort 槽），分栏 prompt 只锁自己柄，与主柄/其他分栏并行；
`pi_interrupt` 按 `thread` 定向 abort。

**已知边界**：单 handle 时两个分栏不能同时流式（后发等先发收尾）；分栏内本
会话 run 进行中再发 = fail loud（排队面板是主会话功能）。

## 7. 位置切换与收放

- **colOrder 恒 3 项**（含隐藏列），存 `colflags.v1`。
- **左栏占端位**：`left` 在 colOrder 首位 = 最左，否则最右。
- **面板栏在内/外位之间切换**（永不跨到左栏的端，同侧让位）。
- **收放 = 宽度归 0**（全隐藏语义，不做 icon rail）；组常驻，从不摘除
  ——摘除会在展开时重挂整棵 React 树（实测 391ms long task）。
- 隐藏态的行文案由 colflags 驱动（打开 X / X 移到 Y），与树无关。

## 8. 布局存档

- 键 `mirach.harness.layout.v10`（dockview 序列化）+ `colflags.v1`（栏旗标）。
  v10 是栏宽改比例口径后换的新键（旧 v9 档存的是 350 基准的列比例）。
- **存档按比例记宽**：窗口 resize 后存的是比例，恢复按新容器宽摊开。
  要出厂形态就删 v10 再 reload，或右键「默认布局」。
- 坏档防御：根行有 `views: []` 的空 leaf 判废，回出厂布局（错误可见）。

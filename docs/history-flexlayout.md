# flexlayout 时代规则归档（v7.x · AGENTS.md 布局节切出 2026-10-06）

> 迁移期间（M1 前）这些规则仍约束现有代码；M1 dockview 落地后转纯历史。

## 布局逻辑规范（2026-10-06 v7.3.1 · 代码已对齐——根面板唯一 + v73b 8/8 + 矩阵 350 + fourverb 19/19 + closecol 3/3 + v73 7/7 全绿）

**唯一规范 = `docs/layout-design.md`（v7.2）**。**v7.2 独立双位置切换
（2026-10-06，用户定稿"没有交换位置了"）**：交换动词废除，布局段两行
位置动词 = 左侧栏移到最右/最左 + **面板栏移到左侧/右侧（两态，v7.2.1
废除三态"左栏旁"文案）**。**状态域收窄**：colOrder 合法值 = 4 种排列，
left 恒占一端（[P,L,C]/[C,L,P] 非法）；面板栏按钮请求**侧别**（左/右），
让位在点击结算——目标侧被左栏占 → 面板栏落到该侧紧挨左栏、**不占边缘**
（内位）；chat 自由填补剩余跨度（面板栏内位时 chat 靠边——"对话栏不用
一直在中间"）。实现 = `leftPosToggle`（colOrder 里 left 条目移
另一端，其余条目相对序不动）/`panelsPosToggle`（panels 与 chat 条目换
位）+ 在场列 alignVisibleToOrder；**隐藏列切位 = 纯记录**（投影不变、
物理不动——面板栏不因隐藏的左栏切边而跳端，重开按记录位插回）。两切
换皆纯对合（双击必还原）。菜单标签 = `leftPosLabel`/`panelsPosLabel`
（由 colOrder 现算）。v7.2 矩阵 = 16 状态 × 4 动词 × 双击 + 重载持久 +
120 步游走 = 350 checks 全绿（脚本同 fl-fullmatrix.mjs，模型 v3/v4 换
新语义）。
**v7.1 四动词全量矩阵修复
（2026-10-06，24 状态 × 4 动词 × 双击 + 24 状态重载持久 + 120 步随机游走
= 477 checks 全绿；确定性状态机下全状态×全动词覆盖 ≡ 全序列覆盖）**：
①**投影不变量**（§3）：物理列序 ≡ colOrder 去隐藏投影，一切栏动词后必须
维持；②**毁列链**：`withdrawOpenOnPanelTabArrival` 曾把栏级 moveNode 的
fromNode（列节点本体）误判成"实签抵达面板栏"→删 open→嵌套 DELETE_TAB
再进 onModelChange→关空收列见列已空→整列带走——修 = **TabNode 门**
（只有页签级到达才撤打开页；flexlayout 列节点 id 是 UUID 永不撞
paneTypeOf）；③**交换重写** = colOrder 旗标互换 + alignVisibleToOrder
统一一条路径（双在场/缺席同权，任意状态恒等回放）——旧"两次 moveNode
锚 chat"在 [L,P,C] 类序不回位（[L,P,C]→[P,C,L]→[L,C,P]）且破坏投影；
④**show-left 不重算 colOrder**（重算把隐藏列挤成 2 项——位置记忆丢失 +
重载校验 length===3 失败整表回退默认）；⑤**setFlagsColOrder 改 merge
规则**：可见列按物理序重排、隐藏列保持原槽位（走原 colOrder 回插）——
旧"缺席期整跳过"守卫把 v4 物理移动后的重映射一并跳掉（左栏隐藏时位置
切换 colOrder 不再更新）。
**矩阵 E2E 方法论（脚本 %TEMP%\fl-fullmatrix.mjs）**：探针全在页面内
求值只回 JSON；**窗口最小化时几何依赖的点击全落空而探针照常**（最小化
护栏 = 每次点击前查 innerWidth<600 即中止 + PowerShell IsIconic 看门狗
仅在最小化时 SW_RESTORE 不抢焦点）；**✕ 是 hover 门控**（visibility:
hidden 不参与命中，2026-09-27 用户定稿"关闭钮不常显"）——合成点击必须
先 mouseMoved 悬停再点击（真实用户无此问题）；vite dev 转换会剥注释，
"在所供模块里搜中文注释标记"恒 false——要用功能性代码标记验证。
**v7.0 语义归属**：tabset
约束由**语义戳**驱动（config.region = 锚页签即第一个有语义页签的
PANE_TYPES.region，syncSemanticStamps 在结构动作后同步重算）——面板页签
拖到主栏分栏仍是面板栏子栏（min 240 非 chat 395），dropSplit 预戳 =
被拖页签语义（非目标列）；"在哪栏分继承哪栏"废除。**根面板** = 打开页
宿主 tabset，**唯一**——定义"面板栏在哪"，动词（隐藏/打开/位置）只作用
根面板列；子栏（拖出的 panels 语义列）= **独立分栏**（v7.3.1 用户定稿：
不跟动词跟移/隐藏，自己拖空自己关=ZCode 语义，空白 tabset 一律
deleteTabset），根面板不可关不可拖（open
enableDrag:false）→ 面板栏打开期间永不空；面板栏缺席仅"隐藏面板栏"一
条路径，缺席时**交换/位置 = 纯逻辑旗标**（colOrder 恒 3 项记录根面板
位；缺席态位置切换纯记录、子栏不跳位），打开
面板栏按 colOrderInsertIndex 语义位重建。多 panels 语义列：hide 只收根
面板列（colstash.panels 单列快照）、setFlagsColOrder 按物理首现序去重
排序。**优先级（v7.3.2）**：两栏同一套移到左/右逻辑，左栏优先——同侧时左栏贴边缘第一、面板栏让到第二位。
三栏固定：
左栏（350 默认/240-420，唯一有上限）| 对话栏（395+，吸收者）| 面板栏
（350 默认/240+，上行页签组〔打开页+文件树/检查/预览〕+ 下行终端 20vh）。
分栏：上下最多 2 行不可再竖分（投放层拒）、左右不限。存储键
`mirach.harness.layout.v8`（v7 及更早作废不迁移）。

**页签条显隐（对话/面板栏，hermes strip-visibility ladder 抄写）**：
搁浅优先（唯一可关页签的 ✕ 只在条上——孤终端/孤文件树条强制在位，
压过手动 never）；手动开关 = **应用右键菜单「隐藏/显示标签」行**（目标
= 右键落点所在栏，main.tsx 解析 tabsetId 随 open 载荷传入；hermes
setTreeGroupTabStrip 同款 always/never，存 config.stripMode）；缺省自动
（单签隐藏、≥2 签显示）。下发在 constraints-sync（stripVisibleOf）。

**应用右键菜单（v6.0 · 唯一右键菜单）**：全应用只此一份（app-context-
menu.tsx），页签 body/chrome/**页签按钮**/标题栏右键全弹它（flexlayout
自管页签菜单与 ZoneMenu 均已裁）；布局段 = 隐藏/显示标签 + 隐藏/打开左
侧栏 + 隐藏/打开面板栏 + 交换左栏与面板栏 + 面板栏位置。实现 =
column-ops.ts。**四个坑**：①旗标不能放根行 config——RowNode 运行时无
getConfig（实测 undefined），走 localStorage
`mirach.harness.layout.colflags.v1`（列快照 = colstash.v1）；
②moveNode 的 toNode 落 **CENTER 到 row 会把整列溶解成签**（RowNode.drop
的 CENTER 分支逐签 addChild）——整列移动必须锚到兄弟列节点本体、
LEFT/RIGHT 边缘插入；③applyDeleteTabset **只删 isCloseable 的子签**——
撤列改用逐签 deleteTab（applyDeleteTab 无 isCloseable 检查）+ 残留空
tabset deleteTabset 兜底（锚组 enableDeleteWhenEmpty=false 不被 tidy
收）；④hide 面板栏时 **syncOpenAnchor 会删一个 open 立刻加回一个**
（空态锚打架，show 时撞 id）——syncOpenAnchor 尊重 panelsHidden 旗标
先行。互换/位置 = moveNode 整列移动（零卸载、终端不死）；hide/show =
快照 + deleteTab / 拼回 + 重采纳（hermes mirrorTreeHorizontal / v4
hideSide 同款）。**重采纳通道返回 boolean**（adopt 成功才提交旗标/快
照——失败整体放弃，状态不脱同步）；adopter 内 **applyRootWeights 同步
跑**（rootPxMem 记忆值，首帧即最终几何——否则恢复列按归一化缩放、90ms
后才纠正 = 可见的"从上往下弹"）；boot 旗标未隐藏但快照在场 = **判废快
照**（陈旧快照拼回会撞 id）。**colOrder 恒 3 项（含隐藏列）**——hide 不缩序、show 按 colOrder 语义位插回（colOrderInsertIndex：colOrder 序里排在 region 前的可见列数 = 根行下标），互换/移位后的位置记忆在隐藏-恢复间保留。

**打开页 = ZCode 空态逻辑**：open 签只在面板栏顶组无实签时存在——有
实签 syncOpenAnchor 程序化撤下、全关自动回来（flexlayout 0.11 无单签
隐藏 API，删/建实现；顶组 enableDeleteWhenEmpty=false 保空组不塌——
**注意 tidy 回收条件 = enableDeleteWhenEmpty && enableClose 双真**）。
单例窗格（files/terminal）id = 类型名，**别用 nextInstanceId**（会生成
files-1 之类）。
**打开页三坑（2026-10-05 用户实测"多打开页/空白面板"轮）**：
①**实签判定 = 宿主横带**（宿主所在的水平 RowNode 内的页签；终端行在 VERT
行的另一格不算——横带误取整个面板列 ROW 会把终端当实签，boot 就把出厂
打开页删掉）；②**addNode 前全局查重**（open 在任何位置在场不再 add——
boot 中间态重建曾 duplicate id:open 白屏）；③**重建的新 tabset 无
config，add 后立即盖 panels 戳**（否则位置回退误标），重建仅
allowRecreate（boot normalize）路径开放。open 签 enableDrag:false（不
可拖出顶组），sync 对空 tabset 一律 deleteTabset（空白面板=bug）。

**顶带两大坑（2026-10-05 用户实测翻车轮）**：
1. **`.app-titlebar` 外面不得再包一层同名容器**——flex-layout 曾写
   `<div className="app-titlebar"><Titlebar /></div>`，Titlebar 自渲染
   一层 .app-titlebar，内层命中 `.app-titlebar > * { pointer-events:
   auto }` 变成盖满 85px 顶带的透明板，**全部栏的页签点击/拖拽静默失效**
   （elementsFromPoint 首位 = app-titlebar 即此症）。Titlebar 直接渲染。
2. **顶带空白拖窗口走 window 捕获段**（flex-layout 的 onWinPointerDown
   effect，v4 恢复）：页签整钮/按钮/输入/分隔条/resize 手柄归原主，
   clientY≤100 的条带容器/logo 带/双行块锚层/条隐藏分栏让位带 →
   startDragging，双击 toggleMaximize。**绝不用绝对定位盖层**（截胡页签
   pointerdown，2026-09-29 定稿）。

- **左栏无页签条**（enableTabStrip=false 由 constraints-sync 按区域下发）；
  会话/机器人两视图住一个 leftrail 窗格，**点顶带 Mirach 文字切换**
  （RailLogoLeading 的 onWordClick，文字 hover/按压效果）；会话行 dnd-kit
  上下排序不变。
- **页签归属（drag-session 的 allowedRegionsOf）**：对话栏页签
  （workspace/session-N）只进对话栏；面板栏页签进面板栏+对话栏；打开页
  钉死面板栏（不可关不可拖出）；左栏拒收一切。上下限 =
  verticalRowCount(列)<2 才许 top/bottom 投放。
- **会话多标签（v7.3 hermes 投放语言）**：主会话页签（workspace）恒在
  不可关；左栏会话行拖到对话栏**页签条**（条带矩形覆盖页签按钮——拖到
  主对话页签上=拖到条上）= 在悬停页签的**槽位前堆叠**会话页签（hermes
  slotBefore 精度；session-N，tab.config 带 threadId，同会话不重复开→
  置前）；**条隐藏 = 无法拖入**（用户定稿；hermes snapshotStrips 来自
  DOM 同果）。切主会话只走侧栏行点击。**会话窗格自持完整聊天运行时
  （v7.4 并排双对话分栏，用户定稿：禁止简化版）**：`SessionThreadPane` =
  threadId ≠ 目录 activeId → **独立完整聊天**（`session-runtime.ts`
  useThreadChatRuntime：自己的轮次机 + per-thread SSE 流
  `?thread=<sessionId>` + composer + 发送 POST 带 sessionPath 引擎切
  会话 + 水合 pi_get_session_messages；thread.aui `scoped` 跳过主会话
  管理 chrome）；= activeId → live 复用工作区（buffer 单消费）。
  工作区 postRun 同样带 path（跨分栏发送后切回）。已知边界：引擎单
  handle，两分栏不能同时流式；分栏 run 中再发 = fail loud。SELECT_TAB
  不再切运行时线程（拦截分支已删）。bridge = session-tab-bridge.ts
  （openSessionTabBridge 带 beforeTabId；setSessionThreadSwitcher 供
  侧栏行）。
- **页签条显隐 ladder（v7.3 全量对齐 hermes）**：搁浅 > 手动 stripMode >
  ≥2 签 > **siblingMainZone**（孤 workspace 页签 + 另一根对话分栏在场 →
  条在位——`siblingMainZoneOf` 现算，`stripVisibleOf` 第 4 参）。
  **条隐藏分栏 = 拖拽目标缺席**：`hiddenStripZoneIds` 快照期过滤
  （drag-session.ts），中心/边缘/条带全不亮。
- **拖拽引擎（drag-session.ts v6 瘦身）**：单目标解析（先条带插入符后
  zone 径向），FancyZones 多区高亮/Shift 合并/多签块/track 拒绝全删；
  跟手克隆件/机械层保留。**工厂 body 右键面 = PaneBodyMenu**
  （pane-context-menu.tsx，.pane-zone-menu-surface 铺满 body——缺它窗格
  右键漏 WebView2 菜单）。
- **打开页（open，常驻锚）**：面板栏默认显示；三按钮 文件树/终端/预览
  → 开/激活对应页签；终端重开 = 面板栏列已两行→落最后一行，塌成单
  tabset→BOTTOM 竖分出新底部行。文件树点文件→预览（preview-opener 链）。
- **v5.0 重建烂尾已修复**：flex-layout.tsx 曾是带 `declare` 假声明的骨架
  （tsc 35 错、运行白屏）——本轮完整重建；死窗格文件（workspace-pane/
  sessions-pane/files-pane/file-tree-pane）已删，placeholder-pane 保留
  （review/terminal 在用）。


---

## 布局逻辑规范（2026-10-06 v7.3.1 · 代码已对齐——根面板唯一 + v73b 8/8 + 矩阵 350 + fourverb 19/19 + closecol 3/3 + v73 7/7 全绿）

**唯一规范 = `docs/layout-design.md`（v7.2）**。**v7.2 独立双位置切换
（2026-10-06，用户定稿"没有交换位置了"）**：交换动词废除，布局段两行
位置动词 = 左侧栏移到最右/最左 + **面板栏移到左侧/右侧（两态，v7.2.1
废除三态"左栏旁"文案）**。**状态域收窄**：colOrder 合法值 = 4 种排列，
left 恒占一端（[P,L,C]/[C,L,P] 非法）；面板栏按钮请求**侧别**（左/右），
让位在点击结算——目标侧被左栏占 → 面板栏落到该侧紧挨左栏、**不占边缘**
（内位）；chat 自由填补剩余跨度（面板栏内位时 chat 靠边——"对话栏不用
一直在中间"）。实现 = `leftPosToggle`（colOrder 里 left 条目移
另一端，其余条目相对序不动）/`panelsPosToggle`（panels 与 chat 条目换
位）+ 在场列 alignVisibleToOrder；**隐藏列切位 = 纯记录**（投影不变、
物理不动——面板栏不因隐藏的左栏切边而跳端，重开按记录位插回）。两切
换皆纯对合（双击必还原）。菜单标签 = `leftPosLabel`/`panelsPosLabel`
（由 colOrder 现算）。v7.2 矩阵 = 16 状态 × 4 动词 × 双击 + 重载持久 +
120 步游走 = 350 checks 全绿（脚本同 fl-fullmatrix.mjs，模型 v3/v4 换
新语义）。
**v7.1 四动词全量矩阵修复
（2026-10-06，24 状态 × 4 动词 × 双击 + 24 状态重载持久 + 120 步随机游走
= 477 checks 全绿；确定性状态机下全状态×全动词覆盖 ≡ 全序列覆盖）**：
①**投影不变量**（§3）：物理列序 ≡ colOrder 去隐藏投影，一切栏动词后必须
维持；②**毁列链**：`withdrawOpenOnPanelTabArrival` 曾把栏级 moveNode 的
fromNode（列节点本体）误判成"实签抵达面板栏"→删 open→嵌套 DELETE_TAB
再进 onModelChange→关空收列见列已空→整列带走——修 = **TabNode 门**
（只有页签级到达才撤打开页；flexlayout 列节点 id 是 UUID 永不撞
paneTypeOf）；③**交换重写** = colOrder 旗标互换 + alignVisibleToOrder
统一一条路径（双在场/缺席同权，任意状态恒等回放）——旧"两次 moveNode
锚 chat"在 [L,P,C] 类序不回位（[L,P,C]→[P,C,L]→[L,C,P]）且破坏投影；
④**show-left 不重算 colOrder**（重算把隐藏列挤成 2 项——位置记忆丢失 +
重载校验 length===3 失败整表回退默认）；⑤**setFlagsColOrder 改 merge
规则**：可见列按物理序重排、隐藏列保持原槽位（走原 colOrder 回插）——
旧"缺席期整跳过"守卫把 v4 物理移动后的重映射一并跳掉（左栏隐藏时位置
切换 colOrder 不再更新）。
**矩阵 E2E 方法论（脚本 %TEMP%\fl-fullmatrix.mjs）**：探针全在页面内
求值只回 JSON；**窗口最小化时几何依赖的点击全落空而探针照常**（最小化
护栏 = 每次点击前查 innerWidth<600 即中止 + PowerShell IsIconic 看门狗
仅在最小化时 SW_RESTORE 不抢焦点）；**✕ 是 hover 门控**（visibility:
hidden 不参与命中，2026-09-27 用户定稿"关闭钮不常显"）——合成点击必须
先 mouseMoved 悬停再点击（真实用户无此问题）；vite dev 转换会剥注释，
"在所供模块里搜中文注释标记"恒 false——要用功能性代码标记验证。
**v7.0 语义归属**：tabset
约束由**语义戳**驱动（config.region = 锚页签即第一个有语义页签的
PANE_TYPES.region，syncSemanticStamps 在结构动作后同步重算）——面板页签
拖到主栏分栏仍是面板栏子栏（min 240 非 chat 395），dropSplit 预戳 =
被拖页签语义（非目标列）；"在哪栏分继承哪栏"废除。**根面板** = 打开页
宿主 tabset，**唯一**——定义"面板栏在哪"，动词（隐藏/打开/位置）只作用
根面板列；子栏（拖出的 panels 语义列）= **独立分栏**（v7.3.1 用户定稿：
不跟动词跟移/隐藏，自己拖空自己关=ZCode 语义，空白 tabset 一律
deleteTabset），根面板不可关不可拖（open
enableDrag:false）→ 面板栏打开期间永不空；面板栏缺席仅"隐藏面板栏"一
条路径，缺席时**交换/位置 = 纯逻辑旗标**（colOrder 恒 3 项记录根面板
位；缺席态位置切换纯记录、子栏不跳位），打开
面板栏按 colOrderInsertIndex 语义位重建。多 panels 语义列：hide 只收根
面板列（colstash.panels 单列快照）、setFlagsColOrder 按物理首现序去重
排序。**优先级（v7.3.2）**：两栏同一套移到左/右逻辑，左栏优先——同侧时左栏贴边缘第一、面板栏让到第二位。
三栏固定：
左栏（350 默认/240-420，唯一有上限）| 对话栏（395+，吸收者）| 面板栏
（350 默认/240+，上行页签组〔打开页+文件树/检查/预览〕+ 下行终端 20vh）。
分栏：上下最多 2 行不可再竖分（投放层拒）、左右不限。存储键
`mirach.harness.layout.v8`（v7 及更早作废不迁移）。

**页签条显隐（对话/面板栏，hermes strip-visibility ladder 抄写）**：
搁浅优先（唯一可关页签的 ✕ 只在条上——孤终端/孤文件树条强制在位，
压过手动 never）；手动开关 = **应用右键菜单「隐藏/显示标签」行**（目标
= 右键落点所在栏，main.tsx 解析 tabsetId 随 open 载荷传入；hermes
setTreeGroupTabStrip 同款 always/never，存 config.stripMode）；缺省自动
（单签隐藏、≥2 签显示）。下发在 constraints-sync（stripVisibleOf）。

**应用右键菜单（v6.0 · 唯一右键菜单）**：全应用只此一份（app-context-
menu.tsx），页签 body/chrome/**页签按钮**/标题栏右键全弹它（flexlayout
自管页签菜单与 ZoneMenu 均已裁）；布局段 = 隐藏/显示标签 + 隐藏/打开左
侧栏 + 隐藏/打开面板栏 + 交换左栏与面板栏 + 面板栏位置。实现 =
column-ops.ts。**四个坑**：①旗标不能放根行 config——RowNode 运行时无
getConfig（实测 undefined），走 localStorage
`mirach.harness.layout.colflags.v1`（列快照 = colstash.v1）；
②moveNode 的 toNode 落 **CENTER 到 row 会把整列溶解成签**（RowNode.drop
的 CENTER 分支逐签 addChild）——整列移动必须锚到兄弟列节点本体、
LEFT/RIGHT 边缘插入；③applyDeleteTabset **只删 isCloseable 的子签**——
撤列改用逐签 deleteTab（applyDeleteTab 无 isCloseable 检查）+ 残留空
tabset deleteTabset 兜底（锚组 enableDeleteWhenEmpty=false 不被 tidy
收）；④hide 面板栏时 **syncOpenAnchor 会删一个 open 立刻加回一个**
（空态锚打架，show 时撞 id）——syncOpenAnchor 尊重 panelsHidden 旗标
先行。互换/位置 = moveNode 整列移动（零卸载、终端不死）；hide/show =
快照 + deleteTab / 拼回 + 重采纳（hermes mirrorTreeHorizontal / v4
hideSide 同款）。**重采纳通道返回 boolean**（adopt 成功才提交旗标/快
照——失败整体放弃，状态不脱同步）；adopter 内 **applyRootWeights 同步
跑**（rootPxMem 记忆值，首帧即最终几何——否则恢复列按归一化缩放、90ms
后才纠正 = 可见的"从上往下弹"）；boot 旗标未隐藏但快照在场 = **判废快
照**（陈旧快照拼回会撞 id）。**colOrder 恒 3 项（含隐藏列）**——hide 不缩序、show 按 colOrder 语义位插回（colOrderInsertIndex：colOrder 序里排在 region 前的可见列数 = 根行下标），互换/移位后的位置记忆在隐藏-恢复间保留。

**打开页 = ZCode 空态逻辑**：open 签只在面板栏顶组无实签时存在——有
实签 syncOpenAnchor 程序化撤下、全关自动回来（flexlayout 0.11 无单签
隐藏 API，删/建实现；顶组 enableDeleteWhenEmpty=false 保空组不塌——
**注意 tidy 回收条件 = enableDeleteWhenEmpty && enableClose 双真**）。
单例窗格（files/terminal）id = 类型名，**别用 nextInstanceId**（会生成
files-1 之类）。
**打开页三坑（2026-10-05 用户实测"多打开页/空白面板"轮）**：
①**实签判定 = 宿主横带**（宿主所在的水平 RowNode 内的页签；终端行在 VERT
行的另一格不算——横带误取整个面板列 ROW 会把终端当实签，boot 就把出厂
打开页删掉）；②**addNode 前全局查重**（open 在任何位置在场不再 add——
boot 中间态重建曾 duplicate id:open 白屏）；③**重建的新 tabset 无
config，add 后立即盖 panels 戳**（否则位置回退误标），重建仅
allowRecreate（boot normalize）路径开放。open 签 enableDrag:false（不
可拖出顶组），sync 对空 tabset 一律 deleteTabset（空白面板=bug）。

**顶带两大坑（2026-10-05 用户实测翻车轮）**：
1. **`.app-titlebar` 外面不得再包一层同名容器**——flex-layout 曾写
   `<div className="app-titlebar"><Titlebar /></div>`，Titlebar 自渲染
   一层 .app-titlebar，内层命中 `.app-titlebar > * { pointer-events:
   auto }` 变成盖满 85px 顶带的透明板，**全部栏的页签点击/拖拽静默失效**
   （elementsFromPoint 首位 = app-titlebar 即此症）。Titlebar 直接渲染。
2. **顶带空白拖窗口走 window 捕获段**（flex-layout 的 onWinPointerDown
   effect，v4 恢复）：页签整钮/按钮/输入/分隔条/resize 手柄归原主，
   clientY≤100 的条带容器/logo 带/双行块锚层/条隐藏分栏让位带 →
   startDragging，双击 toggleMaximize。**绝不用绝对定位盖层**（截胡页签
   pointerdown，2026-09-29 定稿）。

- **左栏无页签条**（enableTabStrip=false 由 constraints-sync 按区域下发）；
  会话/机器人两视图住一个 leftrail 窗格，**点顶带 Mirach 文字切换**
  （RailLogoLeading 的 onWordClick，文字 hover/按压效果）；会话行 dnd-kit
  上下排序不变。
- **页签归属（drag-session 的 allowedRegionsOf）**：对话栏页签
  （workspace/session-N）只进对话栏；面板栏页签进面板栏+对话栏；打开页
  钉死面板栏（不可关不可拖出）；左栏拒收一切。上下限 =
  verticalRowCount(列)<2 才许 top/bottom 投放。
- **会话多标签（v7.3 hermes 投放语言）**：主会话页签（workspace）恒在
  不可关；左栏会话行拖到对话栏**页签条**（条带矩形覆盖页签按钮——拖到
  主对话页签上=拖到条上）= 在悬停页签的**槽位前堆叠**会话页签（hermes
  slotBefore 精度；session-N，tab.config 带 threadId，同会话不重复开→
  置前）；**条隐藏 = 无法拖入**（用户定稿；hermes snapshotStrips 来自
  DOM 同果）。切主会话只走侧栏行点击。**会话窗格自持完整聊天运行时
  （v7.4 并排双对话分栏，用户定稿：禁止简化版）**：`SessionThreadPane` =
  threadId ≠ 目录 activeId → **独立完整聊天**（`session-runtime.ts`
  useThreadChatRuntime：自己的轮次机 + per-thread SSE 流
  `?thread=<sessionId>` + composer + 发送 POST 带 sessionPath 引擎切
  会话 + 水合 pi_get_session_messages；thread.aui `scoped` 跳过主会话
  管理 chrome）；= activeId → live 复用工作区（buffer 单消费）。
  工作区 postRun 同样带 path（跨分栏发送后切回）。已知边界：引擎单
  handle，两分栏不能同时流式；分栏 run 中再发 = fail loud。SELECT_TAB
  不再切运行时线程（拦截分支已删）。bridge = session-tab-bridge.ts
  （openSessionTabBridge 带 beforeTabId；setSessionThreadSwitcher 供
  侧栏行）。
- **页签条显隐 ladder（v7.3 全量对齐 hermes）**：搁浅 > 手动 stripMode >
  ≥2 签 > **siblingMainZone**（孤 workspace 页签 + 另一根对话分栏在场 →
  条在位——`siblingMainZoneOf` 现算，`stripVisibleOf` 第 4 参）。
  **条隐藏分栏 = 拖拽目标缺席**：`hiddenStripZoneIds` 快照期过滤
  （drag-session.ts），中心/边缘/条带全不亮。
- **拖拽引擎（drag-session.ts v6 瘦身）**：单目标解析（先条带插入符后
  zone 径向），FancyZones 多区高亮/Shift 合并/多签块/track 拒绝全删；
  跟手克隆件/机械层保留。**工厂 body 右键面 = PaneBodyMenu**
  （pane-context-menu.tsx，.pane-zone-menu-surface 铺满 body——缺它窗格
  右键漏 WebView2 菜单）。
- **打开页（open，常驻锚）**：面板栏默认显示；三按钮 文件树/终端/预览
  → 开/激活对应页签；终端重开 = 面板栏列已两行→落最后一行，塌成单
  tabset→BOTTOM 竖分出新底部行。文件树点文件→预览（preview-opener 链）。
- **v5.0 重建烂尾已修复**：flex-layout.tsx 曾是带 `declare` 假声明的骨架
  （tsc 35 错、运行白屏）——本轮完整重建；死窗格文件（workspace-pane/
  sessions-pane/files-pane/file-tree-pane）已删，placeholder-pane 保留
  （review/terminal 在用）。


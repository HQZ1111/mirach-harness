# 布局系统重做：三栏固定布局（先文档 → 删旧逻辑 → 重建）

## 新规范要点（写入 docs/layout-design.md v5.0，先行）

**三栏**（出厂树，不再有五套预设）：
```
根行: [左栏 240–420 | 对话栏 ≥395 无上限 | 面板栏 ≥240 无上限]
左栏:   单窗格 leftrail（会话列表/机器人 两视图，Mirach 文字点击切换；
        无页签条 → 无拖入拖出；顶带 = logo+Mirach 文字行）
对话栏: tabset [主会话(不可关) + 多开会话页签]；页签=真会话
面板栏: 垂直两行 [上: tabset 打开页/文件树/检查/预览 | 下: 终端(可关，独立页签)]
```
- **区域改名**：'left' | 'chat' | 'panels'（原 main/right 退役）
- **多开/切换（hermes 语义）**：点击左栏会话行 = 该会话已开页签则置前，否则装入主会话标签（主区内容切换，不开新签）；拖会话行落对话栏页签条/主页签 = 开出/切换；会话页签可关（只删投影，会话留在左栏可再开）；主会话标签恒在不可关；"+"= 新建会话开新页签
- **拖拽规则**：左栏拒收一切；对话栏页签只在对话栏内移动/分栏；面板栏页签可拖到对话栏和面板栏（无限制）
- **分栏规则**：上下最多 2 行、不可再分；左右不限
- **打开页**（新窗格 open，面板栏默认激活页签）：三个全宽按钮——文件树/终端/预览；点击=开出或激活对应页签/终端行（终端关闭后由此重开）；文件树页签点击文件→预览页签（现有链复用）
- **保留**：会话行上下排序（dnd-kit）、会话行跨面拖（session-drag）、双行块/颜色层、双击分隔条回默认（简化版）、页签拖出跟手克隆件

## 实施阶段

### 阶段 1 — 文档（先行）
重写 `docs/layout-design.md` → v5.0：上表全部规则 + 完整删除清单（下述阶段 2 的每一项都写进文档"已废弃"节），作为唯一规范。

### 阶段 2 — 删旧逻辑（大删除提交）
- **整文件删**：layout-presets.ts、edit-palette.tsx、edit-veils.tsx、zone-editor.tsx、region-rails.tsx、zones-engine.ts、tab-selection.ts
- **代码段删**（flex-layout.tsx 为重灾区）：applyJson/applyTemplate/fullReset/applyUser/saveCurrent/removeUser、EditPalette/EditVeils 挂载、mirror+⌘\、toggleRegionForm+切竖轨钮+onTabSetPlaceHolder(RailNav)+railform+createPaneInRegion、foldSide/hideSide/showSide/expandSide/toggleSide+sideHideRecord+boot 折叠、窄屏 effect+updateNarrowViewport 调用、fitWindowWidth/windowMaximized、tab-selection 多选语法（onHostPointerDown 简化为纯起拖）、PaneAddButton 语义收敛到打开页、双行块 glyph-drop 旧补偿（已清）
- **rebalance.ts**：删 fitWindowWidth/windowMaximized/updateNarrowViewport/mergeZonesPerColumn/narrowViewport/DESIGN_WIDTH；rootPxMem/applyRootWeights/absorbSurplus 收敛为三栏固定配重
- **constraints-sync.ts**：删列 identity 推导/过承诺缩让/轨清理/条显隐阶梯/回家重钉——重写为静态三栏校验（min/max 下发 + 上下≤2 行限制 + 页签栏归属）
- **pane-registry**：PANE_TYPES v5（+open，region 改名，sendPaneHome/closePane 回家分支删）
- **菜单链**：app-context-menu 的「切换标签」整链、pane-context-menu 的 hide-strip/stripLocked、Titlebar 的互换/布局模板/侧栏开关钮
- **store**：layout-store 删 sideCollapsed/appliedTree/activePresetId/userPresets/zoneEditorOpen/narrowViewport/editMode
- **CSS**：flexlayout.css 删 zone-rail*/rail-pane-railform/border 竖排/fl-strip-low/fl-min-btn/fl-tab-selected/fl-tab-away 段
- **测试**：constraints-sync.test/rebalance.test 大幅重写（保三栏 min/配重冒烟）、app-context-menu.test 删切换标签段；session-row-gesture/edge-scroll 保留

### 阶段 3 — 新骨架
1. layout-presets.ts 重写为 `defaultLayout()` 单一三栏树（左 240–420 / 对话 ≥395 / 面板 ≥240 垂直两行）
2. pane-registry v5：PANE_TYPES 加 `open`；REGION_LIMITS 改三区新值；会话页签绑定 threadId（tab config.threadId）
3. drag-session 收敛：保留 startDragSession 机械层+条内插入槽重排+跟手克隆件；投放合法区=按页签归属（对话签→对话列条/分栏、面板签→对话+面板列）；上下≤2 行强制
4. session-drag 扩展：命中面 = 对话栏主页签+对话栏页签条（hermes stack 语义）
5. 会话模型：行点击=激活已开页签/装入主会话签；"+"=新建会话开签；页签激活=runtime switchToThread(threadId)（全局投影，v1 不做并排双会话）；页签关闭=删投影留会话
6. 打开页：新组件 OpenPage（三按钮，ZCode 全宽按钮范式）+ 'open' 工厂接线；文件树页签接预览链（已有）
7. 左栏 leftrail：新组件（Mirach 文字行可点击切视图 + 会话列表/机器人内容），替代 sessions/bots 独立页签

### 阶段 4 — 收尾
styles 删旧段、tsc、443 测试重跑、CDP 全链验证（出厂三栏/拖拽规则/打开页/多开切换）、提交推送、AGENTS 登记。

## 风险与说明
- 会话页签绑定 threadId 是最大新功能面（v1 用"激活页签=切全局线程"投影，并排双会话各显各的不做，写入文档边界节）
- 主会话标签关闭语义按你"无法被关闭"定稿：无关闭钮（hermes 的"提升下一个页签"语义不做）
- 删除量大（预估 -3000 行级），分两个提交：①文档 ②删除+重建，每步 tsc+测试门禁
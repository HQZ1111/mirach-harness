# 技能与工具页：hermes 真搬移植（2026-10-28 起，2026-10-29 完成）

> 用户指令链：「完整复刻 hermes 的技能与工具，不要简化版」→ 手写近似版两次被
> 否 →「A：逐文件复制 hermes 组件，只改数据层」→「全部 88 个依赖都做替身」。
>
> **状态：四道门禁全绿，四个 tab 已实机验证。** tsc 0 错 · vitest 45 文件 /
> 567 用例 · cargo check 0 错 · cargo test 87 用例。本文写清楚形态、数据面、
> 复现步骤，以及**实机验证暴露并修掉的 4 个真实 bug**（这些不是类型错误，
> 是跑起来才发现的）。

## 版本基准：抄的是哪份源码（2026-10-29 核实）

用户质疑过「是不是抄成 web 版了」。核实结论（**有数字，可复现**）：

| 检查 | 结果 |
|---|---|
| `apps/web/src/app/capabilities` 文件数 | **0**（web 版根本没有这个页面） |
| `apps/desktop/src/app/capabilities` 文件数 | 119 |
| 镜像 vs `apps/desktop`（忽略 import 行） | **461 逐字相同 / 25 仅 import 前缀不同 / 0 正文不同** |
| 镜像 vs 运行中安装（`C:\...\hermes-agent`）的 capabilities 树 | **122 文件全部逐字相同，0 差异** |

25 个"不同"全部是 import specifier 改写（`@/components/ui/button` →
`@/hermes-mirror/components/ui/button`），行数与上游完全相同。这是
`hermes-rewire.mjs` 的唯一职责，不是手改。

**但用户看到的界面确实和源码不同**：运行中的 Hermes.exe 是 10-18 的旧构建，
源码是 10-23 的新版（见 bug 7）。用户定稿以**最新源码**为准。

## 形态（已落地，可复现）

```
src/hermes-mirror/   ← 上游代码逐字镜像（388 文件，~166k 行）
  app/capabilities/     95 个组件文件：四 tab + catalog + master-detail + 连接器全套
  components/ui/        上游 UI 原语（button/select/dropdown-menu/loader/…）
  components/chat/      CodeMirror 编辑器 / json 编辑器 / log 面板 / zoomable-image
  app/settings/         toolset 配置面板族（provider 矩阵 / 终端后端 / computer-use）
  app/{master-detail,page-search-shell,overlays,hooks}/
  i18n/                 全部 9 语言 catalog + runtime（AST 改写后仅换 import 前缀）
  lib/ shared/ themes/  上游纯函数库 / workspace 共享包 / 主题
src/hermes-shim/     ← 宿主边界：手写适配器 + 上游纯模块（见下「哪些是上游原件」）
```

入口 `components/panes/capabilities-pane.tsx`：

```
QueryClientProvider(queryClient)   ← 必须，上游页面全走 TanStack Query
  I18nProvider(initialLocale)      ← 语言 = 宿主 mirach:locale
    CapabilitiesView               ← 上游页面本体
```

旧手写实现**已删除**（`pi-resources-dialog.tsx` 也删了——两个入口必然漂移）。

## 数据面（shim → pi IPC）

`hermes-shim/hermes.ts` 保上游函数签名，数据从 pi 来：

| 上游 | 宿主 |
|---|---|
| getSkills / setSkillEnabled | pi_capabilities / pi_set_skill_enabled |
| getSkillContent / getLearningNode | pi_read_skill |
| editLearningNode / deleteLearningNode | pi_write_skill / pi_delete_skill |
| getToolsets / setToolsetEnabled | pi_capabilities / pi_set_toolset_enabled |
| getGlobalModelOptions | pi_list_models（扁平目录 → 按 provider 分组） |
| getHermesConfigRecord | pi_mcp_servers + `display.language` ← mirach:locale |
| saveMcpServers | pi_mcp_upsert_server / pi_mcp_remove_server（diff 应用） |
| saveHermesConfig | 同上 + 语言写回 mirach:locale |
| testMcpServer | pi_mcp_test_server |
| getUsageAnalytics | pi_usage_snapshot |
| getProfiles | 单一本地 profile（pi 无 profile 概念，如实返回一个） |

**无对等物的上游面（hub 目录 / hosted connectors / 插件运行时 / 终端后端 /
computer-use 驱动 / env-var 凭据 / 网关 RPC）一律空结果 + 抛错并写明原因 +
`hostUnsupportedFeatures()` 登记，绝不造假成功**（工程规矩 12）。

`bridge.ts` 装 `window.hermesDesktop`（上游 renderer 的唯一数据出口）：
- `api()` 按路径路由到 pi IPC：/api/skills* /api/learning/node
  /api/tools/toolsets* /api/mcp/* /api/profiles* /api/analytics/usage；无路由的
  端点**抛错并写明原因**。
- `openExternal` → `fs_open_url`；`readDir` → `fs_list`（错误码显式转 throw，
  不让失败读成空目录）；`getMachineProfile` → navigator（OS 语言探测）。

## 全部按最新上游源码（2026-10-30 用户定稿）

用户：「还是全部按最新的 hermes 源码来做吧，等会我看一下最新版是什么样的」。

此前一轮按用户逐项选择加过三条偏离（下拉框单选项占位 / 默认 master-detail /
已安装排最前），**已全部回滚为上游原文**，`scripts/host-patches.mjs` 已删除。
当前状态：

| 项 | 行为 | 来源 |
|---|---|---|
| 列表默认布局 | **卡片网格**（masonry） | 上游 `$catalogCardView` 默认 `true` |
| 环境下拉框 | 只有一个 profile 时**隐藏** | 上游 `options.length <= 1 → return null` |
| 已安装条目位置 | 追加在目录条目**末尾** | 上游 `mergeInstalled` |
| tab 条 | 左对齐（`tabsAlign="start"`） | 上游 `CapabilitiesView` |

**唯一保留的非上游改动**（都是数据层，不是页面行为）：

- `i18n/zh_connectors_page.ts` + `zh.ts` 注册 —— 上游中文 catalog 缺整段
  `connectorsPage`（207 键），不补就整页英文。这是 AGENTS.md 规矩 1 的
  i18n 三件套例外。
- `hermes-shim/` 全部 —— 数据面适配（pi IPC），本来就不是上游代码。

### 镜像纯度守卫（可复跑）

```
node scripts/audit-mirror2.mjs
# 期望输出：SAME: 485   DEV: 1   HOST-ONLY: 34
#   DEV 唯一项 = i18n/zh.ts（上面的中文补齐）
#   HOST-ONLY = shared/* 上游 workspace 包 + zh_connectors_page.ts
```

它用 **TypeScript AST** 剔除 import/export-from 语句与注释后逐文件比对正文，
所以「import 前缀被改写」不算差异，只有真正的代码改动才会被列为 DEV。
**新增任何对 `src/hermes-mirror/` 的手改，都必须能让这个数字保持 1。**

### 已知：宿主数据规模下的两个真实缺陷（未修，按上游保留）

回滚后这两点会重新出现，它们**不是抄错版本**，是上游设计在宿主数据量下的表现：

1. **已安装技能不出现在列表前 60 条**：宿主目录 102,542 条（awesome 列表），
   上游 `mergeInstalled` 把已安装条目追加在末尾 → 被 `slice(0, 60)` 截掉。
   表现：tab 徽章显示 1、列表里找不到。点「显示更多」加到 120 条也不够。
2. **环境下拉框不显示**：宿主只有一个 profile，上游逻辑隐藏它。

要改这两点就是「与上游不同」，需用户明确授权后走补丁脚本（见 git 历史
`scripts/host-patches.mjs` 的三条实现）。

## 实机验证暴露并修掉的 4 个真实 bug

这些全是 tsc 通过、跑起来才暴露的。**下次动这套之前先读这一节。**

### 1. tab 点击完全无效（`react-router` shim 吞掉了 navigate）

第一版 shim 的 `useNavigate` 只 `console.warn` 然后丢弃。上游
`use-route-enum-param.ts` 把 tab 写进 `?tab=`，写操作消失 → **点工具集/插件/
Connectors 永远停在技能 tab**。tsc 全绿，功能全废。

修法：`hermes-shim/react-router.ts` 改成**真实的内存 location store**
（`useSyncExternalStore` + `navigateTo` + `useSearchParams` 读写同一份）。
不是假路由：没有 history 栈，`push`/`replace` 同义；但读写真的生效、组件真的
重渲染。**教训：shim 里"没有对应物"不等于"调用可以丢掉"——先问这个调用是不是
页面唯一的状态通道。**

### 2. 整页英文（上游 i18n 缺 connectorsPage，且 config 记录为空）

两个独立成因：
- 宿主 `getHermesConfigRecord` 只返回 `mcp_*`，上游 `I18nProvider` 读
  `display.language` 读到空 → `resolveInitialLocale(undefined, undefined)` →
  默认 `en`。**中文界面上整页英文**。
- 修法：`getHermesConfigRecord` 填 `display.language`（从 `mirach:locale`
  反推 zh/en）；`saveHermesConfig` 把语言写回 `mirach:locale`（第三个语言
  显式拒绝并报错，不静默降级）；`bridge.ts` 补 `getMachineProfile`（返回
  `navigator.language`，没有保存偏好时按 OS 语言推断）。

### 3. 上游中文 catalog 缺整段 `connectorsPage`

`zh.ts` / `zh-hant.ts` 里 `connectorsPage` **一个键都没有**（英文 11 KB /
207 键），`defineLocale` 基于英文深度合并 → 缺的键静默显示英文。这是真正的
上游 i18n 缺口，按 AGENTS.md 规矩 1 的例外走正规三件套补齐：
`i18n/zh_connectors_page.ts`（207 键全中文，函数型键签名与插值位置与英文完全
一致）+ `zh.ts` 里注册。

### 5. 用户看到的是旧版 hermes，不是 D 盘源码

用户报「技能与工具不一样」，核对后确认：**运行中的 Hermes.exe 是 2026-10-18
构建**（`release/win-unpacked/resources/app.asar` mtime 10-18），而
`D:\新建文件夹 (5)` 的源码是 10-23 修改的。两版的 `PageSearchShell` 不同
（旧版两列居中，新版三列左对齐带 `data-tour`）。

**核查方法**（本次用过，可复用）：
- `Get-Process Hermes | Select Path` 找真实安装位置（本例
  `C:\Users\<user>\AppData\Local\hermes\hermes-agent`）；
- 对比 `app.asar` 与 `src/` 的 mtime；
- 读 asar header 拿文件表（`b.readUInt32LE(12)` 是 JSON 长度，16 起是 JSON）；
- 在 `dist/assets/*.js` 里 grep 特征 class（如 `minmax(0,1fr)_auto_auto`）判断
  运行版到底编译的是哪一版布局。

用户定稿：**全部按最新源码**，不追旧版行为。

### 4. 镜像树的 73 个设计令牌 + 13 个语义类宿主都没有

镜像组件的 tailwind 类写的是上游令牌（`--ui-*` / `--dt-*` / `--theme-*`）。
`tokens.css` 只给早期手写版用到的 17 个建了别名，**其余 56 个未定义 →
`var(--ui-bg-editor)` 解析成空值 → 背景/描边/语义色全塌**。这就是"视觉上和
hermes 不一样"的机械成因。

修法（两个新文件，都在 `tokens.css` 之后导入）：
- `src/styles/hermes-tokens.css`：补齐 56 个令牌，取值**照抄上游
  `styles.css` 的 `:root`**（种子 → `--ui-*` 派生 → `--dt-*` 桥接，同一顺序）。
  唯一偏离：`--theme-primary` / `--theme-midground` / `--ui-blue` 指宿主
  `--brand`（用户定稿的 #006fff，上游是同族 #0053fd）。**不重复定义**
  tokens.css 已有的 17 个（会静默覆盖已验收的宿主取值）。
- `src/styles/hermes-ui.css`：13 个上游语义类（`.desktop-input-chrome` /
  `.ref` / `.dt-portal-scrollbar` / `.scrollbar-dt` / `.dither` /
  `.setting-field-highlight` / `.titlebar-icon-button` / `.row-hover` /
  `.xterm`），逐条照抄上游规则。

**守卫脚本**（临时脚本已删，方法记在这里）：从两个真实入口
（`app/capabilities/index.tsx`、`components/panes/review-pane.tsx`）做 AST
可达性遍历 → 收集镜像用到的上游令牌名与类名 → 与 `src/styles/*.css` 里已定义
的集合做差集。**修前 56 个令牌 / 13 个类缺失，修后都是 0。**

## 哪些 shim 文件是上游原件（不是手写替身）

`interface-mode.ts` / `panes.ts` / `tool-view.ts` / `reasoning-disclosure.ts` /
`statusbar-prefs.ts` / `custom-models.ts` / `model-visibility.ts` /
`components/pane-shell/index.ts` 是**逐字上游原件**（脚本
`scripts/hermes-cluster1-stores.mjs` 拷入）。理由：镜像的
`pane-shell/tree/store.ts` 消费 `modeLayout.atom/.mode/.restoring/.write/.has/
.onRestore` 这套 layout-persistence API，窄适配器满足不了——**替身写不出来时
的正确做法是搬原件，不是把 API 削窄**。它们只依赖 persisted/storage/
layout-persistence，都在。

`store/layout.ts` 是**唯一的手写裁剪**：上游 1,059 行驱动整个侧栏与窗格树，
宿主侧栏是自己的实现，镜像只读 `$sidebarRowMeta` 一个导出。该导出连同
`SidebarRowMeta` 联合类型、存储键、默认值、`modeBound` 包装全部照抄，其余
约 1,000 行不搬（可达性遍历证明没人读）。

## 构建脚本（可重跑，顺序执行）

```
node scripts/hermes-copy-set.mjs        # 1. 算出需镜像的上游闭包 → %TEMP%\copyset.txt
node scripts/hermes-mirror.mjs <copyset> <report>   # 2. 逐字复制进 src/hermes-mirror
node scripts/hermes-i18n-all.mjs        # 3. i18n 全 catalog（BundledLocale 是九元联合）
node scripts/hermes-fill-mirror.mjs     # 4. i18n barrel + shared 包全量
node scripts/recreate-billing.mjs       # 5. shared/billing.ts 转发
node scripts/hermes-rewire.mjs          # 6. AST 改写 import 前缀
node scripts/hermes-shim-pure-only.mjs  # 7. 上游纯模块拷进 shim（只增不删）
node scripts/hermes-shim-store-adapters.mjs   # 8. store 适配器批量生成
node scripts/hermes-shim-contrib-adapters.mjs # 9. contrib/api/lib 适配器
node scripts/hermes-boundary-final.mjs  # 10. 窄适配器回填 + 剪枝
node scripts/hermes-cluster1-stores.mjs # 11. 上游 store 原件回填（见上节）
node scripts/hermes-rewire.mjs          # 12. 再 rewrite
node ./node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
```

**hermes-rewire.mjs 必须走 TypeScript AST**——第一版用正则替换所有引号字符串，
把注释/字符串里的 `'git'` 也改成了 `'@/hermes-shim/git'`（类型检查通过但运行时
行为被改，实锤过一次）。任何新的改写只能碰 import/export 的 moduleSpecifier。

**重跑顺序有坑**：`hermes-mirror.mjs` 先删后拷，会冲掉手写的
`zh_connectors_page.ts` 与 `lib/text.ts`。重跑镜像后要重新拷这两个（以及
`hermes-cluster1-stores.mjs` 的原件）。

## 有意不做 / 已知限制

- **连接器 tab 显示"无法访问托管应用"**：上游 hosted connectors 走网关 RPC
  （`connectors.list`），宿主没有这类通道。这是**如实上报**，不是 bug；本地
  MCP 服务器列表（`/api/mcp/servers` → pi）工作正常。
- **技能/工具集的"开关"语义**：pi 没有 per-skill 开关，宿主存在
  `~/.pi/agent/harness-capabilities.json`（不进 settings.json）；工具集映射到
  `SessionOptions.enabled_tools`。实测双向读写都生效。
- **插件 tab 的安装/开关/更新**：pi 的扩展是 `.pi/extensions/<id>/` 清单目录，
  会话启动时装载，没有安装/开关通道 → 列表真实（pi_extensions），动作用
  `throw` 说清楚。
- **Skills Hub 浏览**：目录源按用户决定指向 awesome 列表
  （`hermes-shim/lib/plugin-catalog.ts`）。
- **vitest 排除 mirror/shim**：那是上游代码 + 依赖宿主桥，node 环境跑不起来；
  门禁只看宿主用例（567 条）。
- 新增依赖：@codemirror/{commands,language,language-data,state,view} +
  @lezer/highlight + @icons-pack/react-simple-icons + @testing-library/react(dev)。
  tsconfig target/lib ES2023（上游用 findLastIndex）。

## 验证方法（下次改这套时照着做）

```bash
npx tsc --noEmit                       # 0
npm test                               # 45 文件 / 567 用例
cd src-tauri && cargo check            # 0（2 条既有 warning：agui 递归深度 + future-incompat）
cd src-tauri && cargo test             # 87 用例
```

实机（`npm run tauri dev`，CDP 在 9223）：

1. 点侧栏「技能与工具」→ `.hermes-capabilities-host` 存在；
2. 四个 tab 逐个点，**确认 tab 真的切换**（DOM 文本变，不只是按钮高亮）——
   这是 bug 1 的回归点；
3. 界面是中文（bug 2/3 的回归点）；
4. 令牌探针：`getComputedStyle(el).backgroundColor` 不能是空/transparent
   （bug 4 的回归点）；
5. 技能有数据时：列表行 → 详情（含 SKILL.md 全文）→ 编辑（CodeMirror 高亮）
   → 开关往返（`pi_capabilities` 前后状态变）。
6. **列表默认 master-detail**：`[data-catalog-list] aside`（左，~509px）+
   `main`（右，~679px），已安装条目 `[data-entry-id^="installed:"]` 排在
   第一个且带 `[role=switch]`（bug 5 的回归点）；
7. **环境下拉框有值**：`[data-slot=select-trigger]` 的 textContent 非空
   （应显示 `Hermes (default)`，bug 6 的回归点）。

**截图判读注意**：CDP 截图在本环境里用图片查看器读出来可能是空白，但文件
12 万字节、页面采样 469 种颜色。**判定"有没有画出来"用像素统计 + ASCII
渲染**（把暗像素画成 `#`），不要靠肉眼看图。

# UI 令牌统一 + 视觉调整方案

> 产出日期：2026-10-16 · 状态：**已定稿待实施**（v2，见文末 §6 决策记录）· 未改动任何代码
> 范围：默认布局的间距 / 字号 / 圆角 / 颜色 / 层级，以及"数值散落"的令牌化架构
>
> **阅读顺序**：§1–§5 + 附录 = v1 审计事实（全部有效）；
> **§6–§9 = v2 决策与改写清单（执行看这里）**。

---

## 0. 先纠正我自己的一个误判

我第一版里把"外壳 40px 太大"当成问题。你指出前沿 UI 外壳圆角在 50+，这是对的
——**40 不是过大，是偏小**。但真正决定"大圆角好不好看"的不是数值本身，而是
**同心圆规则**：

```
inner_radius ≈ outer_radius − inset
```

嵌套盒的圆角必须等于「外圆角 − 两者间距」，否则内盒看起来像"浮在里面的小盒子"
而不是"同一个物体的一部分"。

### 当前实测几何（CDP 量得，非推测）

| 元素 | 位置 | 圆角 | 说明 |
|---|---|---|---|
| `.app-shell` | (0,0) 1800×1000 | **40px** | 白底 + `overflow:hidden` |
| `.dv-groupview`（三栏） | (0,0) **inset = 0** | **0px** | 三栏**顶到壳边缘、方角** |
| `.app-titlebar` | (0,0) 高 85 | 0 | 透明浮层 |
| `.app-statusbar` | y=980 高 20 | 0 | 透明 |
| `.main-tint--dockview` | (294,85) 1201×895 | **30px** | 唯一的"内表面"，贴边侧 inset 20px |

**结论**：目前 40px 圆角之所以不显得怪，是因为三栏被 `overflow:hidden` **裁掉**了，
不是同心设计。真正参与圆角语言的只有 MainTint(30) 一个。
→ 这意味着：**改外壳圆角几乎无风险**（没有内盒需要跟着调），但**这也是机会**
——可以借这次把"壳 + 内容"做成真正的同心层级。

---

## 1. 候选方案：外壳圆角 × 内容同心

三个方案，差别在"内容要不要跟着做成同心"：

### 方案 A — 大圆角壳 + 内容仍裁切（最小改动）
```
壳 56px ──┬─ 三栏 inset 0、方角、被壳裁切（现状逻辑）
          └─ MainTint 30 → 40（跟着放大，保持呼吸感）

改动：--shell-radius 40→56（CSS + Rust SetWindowRgn 同步）
     --main-tint-radius 30→40
     --win-dot-right / 状态栏 padding 的"避开圆角魔数"重算
```
- ✅ 一分钟能改完，视觉立刻"前沿"
- ✅ Rust 侧只需改 `win_shape` 的 `CreateRoundRectRgn` 半径（注释已标"改一处必须改两处"）
- ⚠️ 大圆角会把三栏的四角裁出更大缺口 —— 顶栏的 logo 和右上圆点会**更靠近弧线**，需要重排留白
- ❌ 没有解决"内外圆角语言断裂"，只是把断裂推得更远

### 方案 B — 大圆角壳 + 内容同心内缩（推荐）
```
壳 56px，内容整体 inset 8px → 内层圆角 48px
  48 = 56 − 8  ← 同心成立
三栏内缩后自己带 48/12 半径？（见下方"实施代价"）

改动：app-shell 加 padding 8px；.app-main 获得圆角与裁切；
     三栏首尾的 MainTint/tab 条重排
```
- ✅ 真正的同心层级，最有"高级感"，也是 macOS 15 / 新版 OS 的做法
- ⚠️ **代价大**：三栏现在是"顶满 + 壳裁切"，改成内缩后，**用户拖 sash 的宽度基准变了**、
  `FACTORY_LAYOUT`/`RAIL_W` 的 350 常量、贴边检测的 `:has()` 选择器、MainTint 的
  贴边 inset 20 全部要重算
- 会让"三栏直达窗口边缘"的既有语义变成"三栏在一个圆角卡片里"

### 方案 C — 折中：壳 50 + 只调顶带留白（半同心）
```
壳 50px
顶带留白重算（logo 左线、圆点右距）
MainTint 30→34
状态栏 padding 50→60
```
- ✅ 50 恰好是你说的"前沿区间"，改动可控
- ✅ 不动三栏几何，风险低
- ⚠️ 仍不是严格同心，但 50 这种量级下肉眼差异小

**我建议 C 起步**（满足"前沿大圆角"、风险最低），把 B 列为后续可选项。

---

## 2. 数值散落的量化（"怎么统一"的事实基础）

### 2.1 三套并行体系（这是"散"的总根因）

| 体系 | 位置 | 形态 | 消费方 |
|---|---|---|---|
| A 布局引擎 | `tokens.css` | px 字面值、语义名 | 壳/dockview/tab/rail/panes |
| B shadcn 主题 | `tailwind.css` `:root` | **oklch** + `--radius:0.625rem` | assistant-ui CLI 组件 |
| C Tailwind 工具类 | 各 `.tsx` | `rounded-*`/`p-*`/`gap-*` | 所有 vendored 组件 |

同一概念（圆角）**三个源头互不知情**。

### 2.2 圆角：26 种取值

工具类实测频次：`rounded-full` 206 · `rounded-md` 82 · `rounded-lg` 65 ·
`rounded-2xl` 63 · `rounded-xl` 56 · `rounded` 30 · `rounded-sm` 10 ·
`rounded-[20px]` 15 · 另有一堆 1–5 次的 `[2px]/[3px]/[4px]/[5px]/[10px]/[18px]/[24px]/[28px]`。
CSS 侧另有 4/6/8/12px 混写；TSX 里还有 `style={{borderRadius:12}}`、`tabs.tsx:313` 的 `8`。

### 2.3 间距：半像素 + 无栅格

实测非整数：`7.5px`(tab 内距) · `3.75px`(tab 上下) · `11.5px`(状态栏字号) ·
`14.0625px`(输入框) · `2.5px`(圆点派生)。
内距在 1/2/3/4/5/6/7.5/8/9/10/11/12/14/16/18/20/21px 之间跳，**无 4px 基准**。

### 2.4 字号：13 档

`10, 11, 11.5, 12, 12.5, 13, 14, 14.0625, 15, 16, 18, 20, 25`
其中 11.5 / 12.5 / 14.0625 非整数。

### 2.5 颜色：两套灰

`--stroke: rgba(0,0,0,.1)`（体系 A）与 `--border: oklch(0.922 0 0)`（体系 B）
是两个不同的灰，落在相邻元素上会显出差异。

---

## 3. 令牌架构方案（三层）

```
Layer 1  Primitives（原始刻度 —— 全项目唯一的字面值处）
├─ 圆角   --scale-radius-{xs,sm,md,lg,xl,2xl,full}   4/8/12/16/24/32/9999
├─ 间距   --scale-space-{1..10}                      4/8/12/16/20/24/32/40/48/64
├─ 字号   --scale-font-{xs,sm,base,md,lg,xl,2xl}     11/12/14/16/20/25/32
└─ 颜色   --scale-gray-{50..900} + --brand + 语义色（统一色彩空间）

Layer 2  Semantic（语义别名 —— 组件只认这一层）
├─ --radius-control  (按钮/输入/行)
├─ --radius-surface  (卡片/面板/浮层)
├─ --radius-shell    (软件外壳，特殊大值)
├─ --space-row-{x,y} / --space-panel / --space-stack-{sm,md,lg}
├─ --font-caption / --font-body / --font-title / --font-h{1,2,3}
└─ --color-text{,-2,-3,-4} / --color-surface / --color-stroke

Layer 3  Component（组件级，只在语义层不够用时新增）
└─ --tab-pad-x / --hub-row-radius / --code-radius ...
```

**规则**：
1. Layer 3 只能引用 Layer 2，Layer 2 只能引用 Layer 1，Layer 1 才写字面值。
2. 组件 tsx 里**禁止**出现字面数值（`rounded-[20px]`、`p-[7px]` 等）。
3. 跨体系：`tailwind.css` 的 `--radius-*` **指向** Layer 2（见下）。

### 与 Tailwind/shadcn 的桥接（关键难点）

vendored 组件写的是 `rounded-md` 这类**类名**，改令牌需要让类名跟着变：

```css
/* tailwind.css @theme inline —— 让 82 处 rounded-md 自动跟随刻度 */
--radius-sm: var(--scale-radius-xs);   /* 4  */
--radius-md: var(--scale-radius-sm);   /* 8  */
--radius-lg: var(--scale-radius-md);   /* 12 */
--radius-xl: var(--scale-radius-lg);   /* 16 */
--radius-2xl: var(--scale-radius-xl);  /* 24 */
```

**一行不动组件**就能把 26 种圆角收敛到刻度上（散落的 `rounded-[Npx]`
再逐个归并）。这是本方案里性价比最高的一招。

---

## 4. 分阶段实施（每阶段可独立回滚）

| # | 内容 | 影响面 | 回滚方式 | 风险 |
|---|---|---|---|---|
| 1 | 建 Layer 1+2 刻度（**纯新增**，不改消费方）+ 文档 | 0 | 删新增段 | 零 |
| 2 | `@theme inline` 桥接 + 半像素归整 | 全站圆角 | 改回数值 | 中 |
| 3 | 5 个规则 css 的字面值 → 语义令牌 | 壳/dockview/panes | git revert | 中 |
| 4 | 字号收敛（13 → 6 档） | 全站文字 | 改回 `--*-size` | 中 |
| 5 | 颜色统一（`--stroke`/`--border` 合一） | 描边/分隔 | 改回色值 | 低 |
| 6 | 外壳圆角改 50（方案 C）+ 顶带留白重算 | 壳 | 改回 40 | 低-中 |

每阶段以"只改令牌值"为回滚保证：除阶段 3 外，视觉变化的来源都是令牌值本身。

---

## 5. 需要你确认的点

1. **外壳圆角取哪个方案**（A 56 裁切 / B 同心内缩 / **C 50 折中**）
2. **圆角刻度档位数**：`4/8/12/16/24` 五档（推荐）还是保留更多档
3. **字号 13 → 6 档**是否接受（`11/12/14/16/20/25`）
4. **是否接受"组件 tsx 里禁止字面数值"**（阶段 3 要动 vendored 组件，虽然多数
   只需调类名；严格禁止可能触碰 100+ 文件，可先只做"新增代码必须用令牌"）
5. 是否要我把阶段 1（建刻度）先做出来给你看效果——它是纯新增、零风险

---

# v2 —— 已定稿决策（2026-10-16 用户逐条确认）

> 用户答复原文摘要：「我选方案 b」「文字点击的，还是文字本身不变啊，它又没有高亮
> 状态，哪来的圆角，胶囊？按钮命中盒改成正方形的，换成圆形」「按你说的做」
> 状态：**仍未动代码**。v1 的审计事实全部有效，本节只补决策与改写清单。

## 6. 决策记录

| 项 | 决策 | 备注 |
|---|---|---|
| 外壳圆角 | **方案 B**：壳 56 + 内容 inset 8 → 内层 48（同心） | 用户选 B（不是 v1 我推荐的 C） |
| 纯文字标签 | **完全不动** | 用户纠正：无背景/无圆角，不存在"胶囊化"问题 |
| 面板栏 dockview 标签 | 保持现状（已是品牌色实心胶囊） | 无需改动 |
| 纯图标按钮 | 命中盒统一正方形 → **圆形**（`border-radius: 50%`） | 唯一新增的视觉规则 |
| 正方形尺寸刻度 | **三档 24 / 28 / 32**，窗口圆点单独 16 | 见 §7 |
| 面板栏滚动箭头 | **保持竖直拉伸不动** | 它是滚动通道替代物，非独立圆钮 |
| 实施顺序 | **圆钮先做（低风险独立），同心内缩排后面** | 同心内缩影响栏宽记忆，面大 |

### 关于"胶囊化"的澄清（避免后续误解）

v1 里我提出"要不要把高亮按钮胶囊化"是**多余的**：
- 顶带标签（对话栏/左栏）本就是**纯文字**：`flexlayout.css:95-111` 明确
  `background: transparent; border-radius: 0`，选中态只是 `color: var(--tab-text-active)`。
  **没有背景就没有圆角，不存在胶囊**——用户的纠正是对的。
- 面板栏 dockview 标签**已经是**品牌色实心胶囊（`flexlayout.css:211-224`，
  `border-radius: 9999px` + `background: var(--brand)` + 白字）。
- 结论：**标签一类零改动**。本轮唯一要动的是图标按钮。

## 7. 图标按钮清点与改写清单（正方形 + 圆形）

### 7.1 新增刻度（Layer 1 + 2）

```css
/* Layer 1 —— 正方形命中盒刻度 */
--scale-size-1: 16px;   /* 窗口圆点（装饰性控制点，比按钮小一档） */
--scale-size-2: 24px;   /* 常规图标钮 */
--scale-size-3: 28px;   /* 大图标钮 */
--scale-size-4: 32px;   /* 特大/主操作 */

/* Layer 2 —— 语义 */
--size-icon-btn: var(--scale-size-2);        /* 默认 24 */
--size-icon-btn-lg: var(--scale-size-3);     /* 28 */
--size-icon-btn-xl: var(--scale-size-4);     /* 32 */
--radius-icon-btn: 50%;                      /* 圆形（正方形盒前提） */
```

### 7.2 逐项改写清单（实测现状 → 目标）

| # | 元素 | 文件:行 | 现状 | 目标 | 前置 |
|---|---|---|---|---|---|
| 1 | `.tab-new-trigger`「+」 | `flexlayout.css:894-909` | 20×20 · `--zone-btn-radius`(4) | 24×24 · 50% | 无（已是正方形） |
| 2 | `.tab-overview-trigger` 总览 | `flexlayout.css:865-880` | 20×20 · 4px | 24×24 · 50% | 无 |
| 3 | 侧栏筛选钮 | `thread-list.aui.tsx` `size-5 rounded-[4px]` | 20×20 · 4px | 24×24 · `rounded-full` | 无 |
| 4 | `.tb-tool` 标题栏工具钮 | `base.css:128-142` | **26×24** · 5px | 24×24 · 50% | **需改盒（去 26 宽）** |
| 5 | `.set-close` 浮层关闭 ×3 | `overlays.css:164-172` | `padding:4px`+图标（**尺寸不定**） | `24×24` 固定 · 50% | **需固定盒** |
| 6 | `.term-add` 终端新建 | `panes.css:308-316` | `padding:0 10px`（**尺寸不定**） | 24×24 · 50% | **需固定盒** |
| 7 | `.term-tab-close` | `panes.css:283-297` | `16×16`（`--tab-close-hit`） | 保持 16（在标签内，非独立钮） | — |
| 8 | `.win-dot` 四圆点 | `base.css:108-125` | 15×15 · 50% | 16×16（接刻度）· 50% | 无 |
| 9 | 面板栏滚动箭头 | `tab-strip-arrows.tsx` `w-9 self-stretch` | 36×拉伸 | **不动**（决策） | — |

**特殊说明**：
- #4 `.tb-tool` 与 #6 `.term-add`、#5 `.set-close` 的共性是**命中盒由内容撑开**，
  改圆形前必须先把盒钉成正方形，否则 `50%` 会渲成椭圆。这是"先正方形、后圆形"
  的执行顺序，不可颠倒。
- #7 `.term-tab-close` 在终端标签内部，随标签高度，不参与独立圆钮体系。

## 8. 方案 B 同心几何 —— 改动清单与风险（独立于圆钮）

### 8.1 几何目标

```
外壳 .app-shell        radius 40 → 56        （CSS + Rust SetWindowRgn 双处同步）
内容内缩               inset 0 → 8px
内层圆角               56 − 8 = 48px         （同心成立）
三栏 .dv-groupview     0 → 48px（获得自身圆角，不再被壳裁切）
MainTint              30 → 40px              （保持"内盒比内容再小一档"）
```

### 8.2 连带必改项（v1 已标，此处细化）

| 项 | 位置 | 现状 | 改后 |
|---|---|---|---|
| `RAIL_W` 常量 | `dockview-column-ops.ts` | 350 | 需重算（内容区变窄 16） |
| `FACTORY_LAYOUT` 尺寸 | `dockview-column-ops.ts` | 绝对 px | 同上 |
| 拖 sash 宽度基准 | dockview 内部 | 以容器宽为基准 | 内缩后基准平移 8px |
| 贴边检测 `:has()` | `panes.css:79` | 以 `.dv-view:first-child` 判定 | 逻辑不变，但 inset 20 需重估 |
| MainTint 贴边 inset | `panes.css` `--chat-edge-inset: 20px` | 20 | 与 8px 内缩叠加，需确认视觉意图 |
| 状态栏 `padding: 0 50px` | `base.css:217` | 避 40 圆角 | 避 56 圆角 → 需重算 |
| `--win-dot-right: 50px` | `tokens.css:239` | 避 40 圆角 | 避 56 圆角 → 需重算 |

### 8.3 风险评级

- **栏宽记忆**：用户已定稿的左右栏 350px 记忆写在 localStorage
  （`mirach.harness.layout.v9`）。内缩后**恢复存档的布局比例不变**，但绝对宽度
  语义变了。**建议**：改完清一次存档（删 key 重载）验证出厂态。
- **拖拽/分栏几何**：dockview 的 drop 坐标以内层容器为参照，内缩后所有
  落点判定会平移——**这是方案 B 最大的回归面**，需要逐点复测（尤其刚修好的
  radial 落点判定）。

## 9. 建议执行顺序（更新）

| 阶段 | 内容 | 风险 | 依赖 |
|---|---|---|---|
| **1** | 建 Layer 1+2 刻度（纯新增） | 零 | — |
| **2** | `@theme inline` 桥接 + 半像素归整 | 中 | 1 |
| **3** | **图标钮正方形→圆形**（§7，9 项） | **低** | 1（独立可做） |
| **4** | 规则 css 字面值 → 语义令牌 | 中 | 2 |
| **5** | 字号收敛 13→6 档 | 中 | — |
| **6** | 颜色统一 | 低 | — |
| **7** | **方案 B 同心内缩**（§8） | **中-高** | 3、4 完成后 |

**理由**：阶段 3（圆钮）与阶段 7（同心内缩）无依赖关系，且 3 风险低、见效快，
先做可独立验证。阶段 7 放在最后，因为它是唯一会动布局几何的阶段。

---

## 10. 执行记录

### 阶段 1 ✅ 完成（2026-10-16）

**做了什么**：`tokens.css` 末尾新增"设计刻度"段——4 组 L1 原始刻度
（圆角 6 档 / 间距 10 档 / 字号 6 档 / 图标钮正方形 4 档）+ 全套 L2 语义别名
（`--radius-*` / `--space-*` / `--font-*` / `--size-icon-btn*`）。
**纯新增，零消费方改动**（现有 `--tab-*` 等一概未动）。

**验证**：26/26 新令牌在页面可读；现有样式实测值全部未变
（壳圆角 40 / tab 16px / 状态栏 11.5px / group 0）。tsc 0。

### 附带修复：CSS 注释吞 `:root` 块（**严重，pre-existing**）

做阶段 1 时发现 `tokens.css` **第一个 `:root` 块整个没进浏览器**——12 个
`:root` 只解析出 11 个。根因有二，**都不是本次引入的**：

1. `tokens.css:253` hub 段注释里写了 `panes/hub/*，`——`/*` 在注释内**再次开启
   注释**（CSS 注释不嵌套），吃掉后续全部内容；
2. `tailwind.css:56` 注释里写了 `duration-*/ease-*`——`*/` **提前闭合**注释。

**影响**：`--text / --text-2 / --surface / --brand / --stroke / --h1-size /
--tab-font-size / --tab-pad-x / --logo-strip-h / --flexlayout-*` 等**全部
undefined**，`var(--x, fallback)` 恒取 fallback。之所以长期没暴露，是因为
规则文件里恰好也硬编码了同值。

**修复**：改写成 `panes/hub 目录` / `duration- 与 ease- 工具类`；全 8 个 css
文件加注释配对自检（现全部 OK）；实测 `:root` 块 11 → **12**，
`--tab-font-size` 由 undefined → **14px**。

**已记入 AGENTS.md #18**（含排查法：`var(--token, 777px)` 探针 + CSSOM
`:root` 条数比对）。

### 阶段 2 ✅ 完成（2026-10-16）

**做了什么**：`tailwind.css` 的 `@theme inline` 里把 `--radius-*` 从
`calc(var(--radius) ± Npx)` **改为指向设计刻度**：

```
--radius-xs/sm  → --scale-radius-xs (4)
--radius-md     → --scale-radius-sm (8)
--radius-lg     → --scale-radius-md (12)
--radius-xl     → --scale-radius-lg (16)
--radius-2xl/3xl/4xl → --scale-radius-xl (24)
--radius        → --scale-radius-sm (8)   ← 裸 rounded 读它
```

**效果**：`rounded-md`(82) / `rounded-lg`(65) / `rounded-2xl`(63) / `rounded-xl`(56)
/ `rounded`(30) / `rounded-sm`(10) 等 **185+ 处类名自动收敛到 5 档**，一行不动组件。

**实测**：`rounded` 8 · `sm` 4 · `md` 8 · `lg` 12 · `xl` 16 · `2xl` 24 —— 全部 px 整数。
**顺带消掉半像素根因**：Tailwind 默认表用 rem，而根字号是 15px，
`0.25rem` 算出 **3.75px**（裸 rounded 原值）、`0.125rem` 算出 **1.875px**（原 xs）——
这就是"半像素"的来源。改为 px 令牌后归零。

### 阶段 3 ✅ 完成（2026-10-16）

**做了什么**：按 §7.2 清单改 8 项图标钮为**正方形 + 圆形**（`--radius-icon-btn`=50%）。

| # | 元素 | 结果（实测） |
|---|---|---|
| 1 | `.tab-new-trigger`「+」 | 24×24 · 50% ✓ |
| 2 | `.tab-overview-trigger` 总览 | 24×24 · 50% ✓ |
| 3 | 侧栏筛选钮 ×3（`thread-list.aui.tsx`） | `size-5`(20×20) · `rounded-full` ✓ |
| 4 | `.tb-tool` 标题栏工具 | 24×24 · 50% ✓（原 26×24 矩形） |
| 5 | `.set-close` 浮层关闭 ×3 | 24×24 · 50% ✓（原 padding 撑开、尺寸不定） |
| 6 | `.term-add` 终端新建 | 24×24 · 50% ✓（原 padding 撑开） |
| 7 | `.term-tab-close` | **保持 16×16 不圆**（标签内控件） |
| 8 | `.win-dot` 窗口圆点 | 16×16 · 50% ✓（原 15×15，接刻度最小档） |
| 9 | 面板栏滚动箭头 | **未动**（滚动通道，非独立圆钮） |

**验证**：8 项全部实测为正方形且 `border-radius: 50%`；tsc 0；8 个 css 注释自检
全 OK；reload 后 **console 错误 0**；截图渲染正常。

### 阶段 4 ✅ / 阶段 5 ✅ / 阶段 6 ✅（2026-10-16）

| 阶段 | 内容 | 数量 | 验证 |
|---|---|---|---|
| 4 | 规则 css 圆角字面值 → 语义令牌 | **42 处** | 全 5 文件，0 MISS |
| 5 | 字号收敛到 6 档（10/11/11.5→11 · 12/12.5→12 · 13/14→14 · 15/16→16） | **48 处** | 0 MISS；实测状态栏 11px |
| 6 | 灰阶统一 | **25 处** + 令牌 | stroke/border 同源 |

**阶段 6 关键**：新增 `--scale-gray-a1..a6`（rgba 黑 α = 0.03/0.05/0.08/0.12/0.18/0.24），
把 `--stroke`(原 0.10) / `--stroke-soft`(0.06) / `--hover-wash`(0.07) / `--tab-hover-bg` /
`--tab-separator` 全部改指刻度；**并把 tailwind 的 `--border`/`--input` 从独立的
`oklch(0.922 0 0)`（≈#e5e5e5）改为 `var(--stroke)`**——此前那是**两个不同的灰**，
相邻元素并排会露差异（这是 v1 审计列的 P2 项）。

### 阶段 7 ✅ 完成（2026-10-16）—— 方案 B 同心几何

**做了什么**：

```
.app-shell          radius 56 (= --radius-shell)  + padding 8 (= --shell-inset)
.app-main           radius 48 (= --radius-shell-inner) + overflow:hidden
                    → 三栏由**内层**裁切（不再被壳直接裁）
Rust main.rs        RADIUS_LOGICAL 40.0 → 56.0（SetWindowRgn 同步）
resize-handles.tsx  四边手柄离角 45 → 56（圆角区在窗口 region 之外，压进去点不到）
--win-dot-right     50 → calc(8 + 42) = 50（避圆角值随几何派生）
--win-dot-left      35 → calc(8 + 27) = 35
状态栏 padding       0 50px → 0 calc(8 + 42px) = 50px
```

**实测验证**：壳 radius 56 / padding 8；`.app-main` **48px** 圆角、位置 (8,8)、尺寸
1784×964；`GetWindowRgn` 返回 **3 (COMPLEXREGION)** = 圆角区域已应用；
右缘扫描 x=1792→`.app-shell`（内缩带）、x≥1794→`win-resize-handle`（对称）；
底部 y=975..990→状态栏、y=995→手柄。**同心成立：56 = 48 + 8**。

**连带项核查**：`RAIL_W=350` 用 `setSize({width})` 是**绝对值**，不受容器内缩影响，
无需改；存档布局按**比例**归一，属预期行为。

### ⚠️ 已知遗留（本轮未做）

**TSX 里的 129 处任意值字号**（`text-[13px]`×63 · `text-[13.5px]`×50 · 其余零散），
散在 **79 个文件**，几乎全在 `components/assistant-ui/elements/*`（上游 registry
组件）。**本轮刻意不做**：

1. 违背 AGENTS 的「照抄上游，不要自己做」——手改 129 处会让下次同步上游全冲突；
2. 不在「默认布局」范围内——那些是弹窗/工具条等非首屏组件；
3. 若要做，应作为独立一轮（写脚本批量 + 记录上游 diff）。

### 全量回归（阶段 1–7 完成后）

- `tsc --noEmit`：**0 错误**
- `cargo check` / `cargo build`：**通过**（1 条 pre-existing warning，在 agui.rs）
- `vitest run`：**34 文件 / 426 用例全过**
- 8 个 css 注释配对自检：**全 OK**
- 应用重跑（含 Rust 重建）：**console 错误 0**，截图正常

---

## 附：本次未做验证的事项（诚实声明）

- 圆角/间距的**具体档位数值**来自通行惯例（Material shape scale / Fluent /
  Apple 同心规则），我尝试抓取官方文档但页面已迁移或无正文，**未能取得权威原文**。
  建议在定稿前对照 MD3 shape scale 与 Fluent 2 radius token 确认。
- 已实测确认的：三套并行体系的存在、26 种圆角取值分布、半像素出现位置、
  当前嵌套几何（外壳 40 / 三栏方角 / tint 30）。

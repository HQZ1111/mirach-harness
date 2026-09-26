# Mirach Harness

MIRACH 的**布局骨架试验田**（立项 2026-09-21）：验证"布局核心用 dockview 库 + 适配层自写"
这条路线，替代直接提取 hermes 的 14k 行 pane-shell。目录结构对照 hermes `apps/desktop`。

## 跑起来

```bash
npm install
npm run dev     # http://127.0.0.1:1430（1420 留给主工程 MIRACH）
npm run typecheck
```

## 布局架构（C 路线）

| 职责 | 归属 | 说明 |
|---|---|---|
| 分栏 / 页签 / 拖拽停靠 / 分栏拖宽 / 序列化 | **dockview 库**（内建） | 树模型、落点预览、sash 全是库的事 |
| 窗格注册表 | `src/components/layout/panes.tsx` | id → { component, title, 约束, 默认尺寸 }，hermes contrib 概念的极简版 |
| 初始布局 + 持久化 | `src/components/layout/dock-layout.tsx` + `persistence.ts` | 布局变化防抖序列化进 localStorage；回读按**不可信输入**处理（版本号 + try/catch，照抄 hermes 的原则） |
| 宽高手感 | 同上，数值逐字来自 hermes | sessions 237/360、files+review 237/(160-320)、bots 260、终端 20vh/80vh 无下限；约束挂载重放（不序列化）、resize 重算、双击 sash 回默认 |
| 窗格内容 | `src/components/panes/` | 占位壳，未来逐个换真组件 |

加新窗格 = `panes.tsx` 注册一行 + 写组件。

## 与 hermes 的关系

- **复制的**：持久化"不可信输入"原则、窗格注册表概念、初始布局对照 hermes Default 预设（左会话 | 主区 | 右文件 | 底终端）。
- **没有复制的**：hermes 的树引擎/网格解算/sash 数学（dockview 内建替代）；插件停靠不变量、窄视口边缘浮层等 hermes 特有语义（等需要时再在适配层实现）。
- 依赖：react 19 + dockview 8.3（`dockview` = vanilla 核心，`dockview-react` = React 绑定，8.x 拆成了两个包）。

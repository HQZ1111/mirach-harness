# AGENTS.md — mirach-harness 工程须知（新会话必读）

> **【新会话第一站】交接快照：`docs/HANDOFF.md`（当前状态 / 未做清单 / 环境速查）。**
> 本文只写**当前有效**的工程约束；已废弃的路线（flexlayout、mock seam、
> openhuman 设置页移植、CEF 运行时）不再留过程，只在「有意不做」里留结论。

## 技术栈现状

| 层 | 选型 |
|---|---|
| 壳 | **Tauri 3.0.0-alpha.4** + **`tauri-runtime-wry` 3.0.0-alpha.4**（Windows = WebView2） |
| 前端 | React 19.3 + TypeScript 5.9.3 + Vite 7.3.6 |
| 布局 | **dockview-react 8.5.1**（序列化存档键 `mirach.harness.layout.v10`） |
| 状态 | Zustand 5.0.15（UI 真相）+ XState 5.33.2（run 轮次机）+ TanStack Query（非会话缓存） |
| 聊天 | assistant-ui 0.15.22（Thread / Composer / ToolCard / Thinking） |
| 样式 | Tailwind 4.3.3 + tokens.css 令牌层 |
| 引擎 | pi_agent_rust 0.8.0（vendored `src-tauri/vendor/`，2026-10-24 自 0.5.1 升级）+ axum AG-UI HTTP+SSE |

**没有 Python**：hermes 官方的 Python 后端从未复制；源码里 "python" 字样只是
文案/类型引用，node_modules 里几个 .py 是 katex 的构建期脚本。

## 2026-11-22 环境（profile）与 bots 插件边界（当前有效）

### 概念对齐（hermes 事实）

- hermes 的默认环境 = profile `default`，home = `~/.hermes` 根；名册未改名时
  显示产品名 **Hermes**；「本机 / This device」是 connection 标签，不是 bot。
  宿主品牌替换后默认显示 **Mirach**（`bots-store.makeDefaultBot`，旧种子
  「本体」一次性迁移；名字仍是 `default`）。
- 本地 bot = 一个 profile 环境。具名 profile 的 home 在 hermes 是
  `<root>/profiles/<name>`；宿主对偶在 `~/.rpi/agent/profiles/<name>`。
- **bot 行点击 = 导航（openRosterBot），不切 workspace/profile**；只有
  「环境」菜单（`active-profile-bridge`）才显式切环境。新建 bot 聊天把
  `profile` 随 `session.create` 传给引擎（落该 bot 的 home），同样不抢
  当前活动环境。之前把 openSession 做成切环境是错的，已回退。

### 宿主的真实隔离程度（不要夸大）

- **已隔离**：会话目录/列表扫描根（`pi_profiles.rs`；具名 profile 只扫
  `<home>/sessions`），以及 bot 会话创建落点（`pi_bot.rs` 的
  `ensure_profile_dirs`）。切环境会让左侧栏整体换源。
- **未隔离**：auth.json / models.json / settings.json / trust.json / skills /
  extensions / SYSTEM.md 仍是进程级 `RPI_CODING_AGENT_DIR` / `~/.rpi/agent`；
  bot 的模型/人格/工具集是创建时拷贝的 SessionOptions，不是 profile home。
  **不得再写「每个环境只启用自己的配置」**，当前只做到会话面。
- **cron 的 `Job.bot` 只是归档/过滤标签**（`pi_cron.rs` 注释）；执行在
  `~/.rpi/agent/cron/sessions`，用创建时复制的 provider/model/prompt +
  全局 auth/settings。bot 切走/删掉，作业仍会触发，但不是「在该 bot 的
  环境里跑」。hermes 是 per-profile `cron/jobs.json` + profile 路由。

### rpi 上游方案（已完成原型，PR 前必须先提 issue）

- 工作树：`E:\Temp\pi-pr1-latest`（上游 `main@301c98c` 的树，非 git 目录；
  发布走 GitHub API）。**2026-11-23 方案 = `AgentHome` 构造注入，已合并**
  （PR #409，merge commit `301c98c`；树与 PR head `49fa12c` 相同）：
  `config::AgentHome` 一次解析 home，`session::build(home,…)` /
  `prepare_extensions(home,…)` / `build_prepared(home,…)` /
  `ReloadContext.home` 全链传递；provider/resolver、settings/trust、
  resource dirs、`Scope::Global`/`host_leases_for`、native-package 扩展
  读取都用同一值。**没有 `--agent-dir` 旗标、没有 `set_var` pin、没有
  公开 `_at` twins**。CLI 传 `AgentHome::process()`，行为不变。
- 测试：`agent_dir_home.rs` **5 条**（双 home 隔离 + 并发 + 真
  `session::build` 显式 home B 在 `RPI_CODING_AGENT_DIR=A` 下只读 B 的
  skills + 相对 home 立即拒绝 + 同进程两个真 `session::build` 各读自己的
  home/skills）；库 1263 过 / 3 ignored；`RUSTFLAGS=-D warnings cargo check
  -p rpi-cli --all-targets` 过。本地 `native_durable` 2 条 integration 仍是
  fixture 构建失败（`plugin_stub.dll` 未产出），与补丁无关。
- **PR 历史**：issue `https://github.com/bigfish1913/pi-rust/issues/405`
  保持 open；PR #406（`--agent-dir` + env pin）已被作者 closed 未合并，
  理由 = 进程级 pin 无法支持同进程多 profile。作者要求 `SessionHome`
  （一次解析，注入 session services + resource_management/install/prebuilt）。
  PR #409 按该 shape 提交并于 2026-11-24 **approved + merged**
  （merge commit `301c98c`）。Review 的非阻塞项由
  `https://github.com/bigfish1913/pi-rust/pull/414`（branch
  `feat/agent-home-polish`）跟进：
  `AgentHome::from_option` 改为 `Result` 并立即拒绝相对路径
  （`ConfigError::InvalidAgentHome`）；全部 `--agent-dir` 文案改成
  "explicit agent home"；补双 home 同进程 build 测试。
- **宿主事实核对（2026-11-22，重要）**：mirach-harness **不是**
  `rpi-extcore` 架构——`src-tauri/Cargo.toml:32` 以 path 依赖 `rpi-cli`，
  `pi_session.rs:828` 直接调 `rpi_cli::session::build`，`pi_bot.rs` 每个 bot
  成员一个 `BotSession`（同一进程）。宿主当前只隔离会话根
  （`pi_profiles.rs` 给 `Args.session_dir`）；auth/models/settings/trust/
  skills/extensions/native-packages/event log 仍是 `pi_paths::agent_dir()`
  / `RPI_CODING_AGENT_DIR` 进程级。**不得再写「宿主已有 profile 配置隔离」**。
  已在 issue #405 用上述证据回复。
- `rpi-extcore` 评估：crate 0.2.16（repo `pi-rust/rpi-package`）提供
  `Service`/`HostSession`，每个 session 起 `rpi --mode rpc` 子进程；但
  `SessionOptions`/`BackendConfig` **没有 env/agent_dir 字段**，子进程继承
  父环境，per-profile 需要一进程一 profile 或给 extcore 加 per-child env。
  宿主换 extcore = 把进程内 `AgentHarness` 全部改 RPC，属于独立架构迁移，
  不是本 PR 级别。暂走 in-process `AgentHome`。
- 发布方式 = GitHub API（本机 git HTTPS 到 GitHub 被 reset，API 正常；
  凭据在 Windows Credential Manager 的 `git:https://github.com`）。

### bots 插件边界（关闭必须干净）

- **bots 的唯一 UI = hermes-bots 插件**。已删除宿主自造的精简替身：
  `bots-pane.tsx`、`hub/bot-launch.ts`、`bot-group.tsx`、`bot-subpages.tsx`、
  `bots-dialog.tsx`、`bot-stub-store.ts`、`bot-face.tsx`。
- 总门 = `src/plugins/bots-gate.ts`：`pluginActive('hermes-bots')` +
  `$botsRuntimeLoaded`（bundled 注册成功后置 true；**不要用
  `$pluginRecords` 状态**——runtime-loader 的周期 refresh 会误 drop bundled
  记录）。关闭插件时：左栏 Mirach 变纯文本、bots/routines 面板移除、
  `canonical-group-driver` 停止、Bot Chat 隐藏过滤关闭、连接页入口隐藏。
- `botChatPaths` 双锚隐藏仍是**前端显示过滤**：pi 无 hidden 会话面；关闭插件
  后过滤关闭，旧 Bot Chat 行重新显示。
- **2026-11-23 对齐 hermes 新版**：`teammate-waits.tsx` /
  `teammate-wait-locales.ts` / `group-chat-record.ts` 逐字复制。宿主补了
  `composer.top` 贡献槽（`components/assistant-ui/composer-top-slot.tsx`，
  挂在 `composer-wired.tsx` 的 ComposerBar 首行）与
  `useComposerSession`（`hermes-shim/app/composer-session.tsx`，SDK 按上游
  `sdk/areas.ts` 导出）；`bot_delivery.list` 由
  `lib/bot-delivery.ts` 的内存登记表回答（本机直投 + 远端 relay 未收尾
  投递；settle 即删，重启清空）。群聊 durable 记录只走
  `group-chat-record.ts` 的 helper——不要再写内联 durable 映射（旧版会丢
  `sessionOwners`/`holds`/`holdDetection`/`heldMessages`）。
- **2026-11-23 群聊房间输入区**：`group-room-ui.tsx` 与上游逐字一致；显示
  依赖的上游 composer 令牌（`--composer-control-gap` /
  `--composer-surface-pad-x/y` / `--composer-input-min-height` /
  `--conversation-text-base-size/font-size` / `--composer-fill` /
  `--composer-ring-strength`）与 `--chrome-action-hover` 已补进
  `tokens.css` / `hermes-tokens.css`；SDK 的 `composerInputBacking` /
  `composerSurfaceRing` 直接复用镜像 `components/chat/composer-dock`，
  房间输入区圆角 20px 与主输入框一致。**不要再写回旧的近似常量**
  （`rounded-md border bg-background` 会造成框里套小框）。
- **镜像主题层与宿主暗色壳（2026-11-23）**：此前宿主只有 light 调色板，
  镜像主题层跟随 OS（system → dark）会得到黑底黑字 + 描边（用户实报
  "机器人页弹窗都是黑的"），当时临时固定 `light`。**外观页落地后已补
  `tokens.css` 的 `:root:root.dark` 暗色令牌**，boot paint 恢复按存储 mode
  解析（缺省 light），主窗/设置窗根都挂 `ThemeProvider`——不要再把 boot
  写回固定 light，也不要在没有 `.dark` 令牌时让 mirror 跟随 OS。
- **群聊输入区 = 主输入框组件（2026-11-23）**：`RoomComposer` 用宿主
  `ComposerBar` / `ComposerSend` / `ComposerAttachButton`（SDK 导出），
  **不要再写自造 surface**（`room-composer-surface` 已删；用户："是你自己
  又做了一个"）。错误 notice 必须 `wrap-anywhere` + `overflow-hidden`。
- **对话头像系统（2026-11-23）**：设置 →「形象」= 41 张内置头像
  （`public/avatars/user/u01..u41.jpg`，localStorage `mirach:user-avatar`）；
  对话区**每条消息最上面**一行身份区：名字与内容同边（AI 左 / 用户右），
  名字中线与头像中线对齐（`h-[40px]` + `items-center`），**头像在外侧**
  （AI 最左 / 用户最右，40px；机器人页行头像同尺寸）——不要整体水平居中（用户实报"各自还在左右，
  现在跑中间了"），也不要让头像贴内容边（"头像应该在外面"）。用户名 =
  个性「显示名称」（未设 = 你）；AI 名 = bot 显示名（普通会话 = Mirach）。AI
  头像 = bot `image`，无图/普通会话回落 `/brand/logo.png`。默认 Mirach bot
  头像 = `/brand/logo.png`（`makeDefaultBot` + botsStore/插件 bot-meta 各
  一次迁移；迁移标记后用户再改不再覆盖）。群聊轮次状态条必须在输入卡
  **上面**（`RoomComposer` 的 `status` 在 `ComposerBar` 外），不要再塞进
  输入框。
- **删除机器人 = 删 profile home（2026-11-23）**：`host.deleteProfile` /
  `cli.exec profile delete` 都走 `host-rpc.deleteBotProfile`：先 Rust
  `pi_profile_delete` 删 `<agent_dir>/profiles/<name>`（default 拒绝、符号
  链接拒绝、不存在 = `removed:false` 幂等），**成功后才**删 botsStore 与
  `bot-meta-v2` / 选中项 / `bot-ui-meta` 缓存；删除失败原样抛出、注册表不动。
  群聊成员**不跟着删**（hermes `member_roster` 同语义：房间保留成员行），
  但 `canonical-group-driver` 的 `memberUnavailableReason` 会在跑轮前查本地
  名册——已删 profile 直接 `turn.failed` + `reason_code: member_unavailable`，
  绝不再经 `ensure_profile_dirs` 把目录拉起来。
- **设置 →「外观」（2026-11-23，hermes 整页复制）**：`app/settings/
  appearance-settings.tsx` 照 hermes Appearance 页重写（行距/文案/控件
  顺序一致），数据面 = `lib/appearance-prefs.ts`（localStorage
  `mirach:appearance.v1`，跨窗口 storage 同步）：
  - 主题：`ThemeProvider` 已挂到主窗与设置窗根（`main.tsx`），
    `ThemeMode` 明亮/暗色/跟随系统 + 皮肤画廊；宿主壳令牌由
    `themes/context.tsx::applyHostTheme` 从当前皮肤同步（`--brand/--text/
    --surface-base/--stroke/--accent/--ui-*`），换主题会真的改整窗颜色；
    暗色兜底令牌在 `tokens.css` 的 `:root:root.dark`。`normalizeMode`
    缺省 **light**（宿主历史只有浅色）；boot paint 按存储 mode 解析。
    **2026-11-24 修正**：模式切换放大成单独一排（3 个大按钮），画廊
    不再用 `max-h-96` 内层截断、整页滚动完整显示；主题名/描述中文化
    （`THEME_ZH`）。**不再有「默认」主题卡**：`nous` 从设置画廊隐藏，
    点击已选主题写入哨兵 `HOST_THEME_NONE`，`applyHostBase` 清掉
    `applyTheme` 写过的全部根内联变量（`APPLIED_THEME_PROPS`），恢复
    tokens.css 宿主基础外观，再派发 `mirach:appearance-reapply` 让外观偏好
    （字号/字体/主题色/文字色/背景）重新落回。
  - 主题色 + 文字颜色（主题画廊下方）：预设 `#006fff/#f97316/#ef4444/
    #10b981/#94a3b8/#a855f7` + 自定义 color picker +「默认」；已选预设
    再点一次回默认。`applyAccent` 写 `--brand/--h2-color/--logo-text-color/
    --tab-text-active/--fl-accent` 等；`setTextColor` 写 `--text/--foreground/
    --ui-text-primary/--tab-text`，换肤时 `applyHostTheme` 从存档读取用户
    文字色并重新覆盖。**位图 logo 也跟随主题色**：`lib/logo-tint.ts` 把
    #006fff 与目标色的 HSL 差算成 `--logo-hue-rotate`/`--logo-saturate`，
    `.rail-logo-mark` 用 `filter: hue-rotate() saturate()` 旋转蓝底（白脸
    不受影响）；`--logo-word-btn-hover-color` 也改为 `var(--brand)`，不再
    写死 #006fff。
  - 界面缩放：90/100/110/125/150/175，`getCurrentWebview().setZoom`；权限
    `core:webview:allow-set-webview-zoom`（capabilities/default.json）；
    Ctrl/Cmd +/-/0 快捷键在 `AppPrefsBoot` 安装。
  - 聊天文字大小：90–175，`--chat-text-scale`；主 thread 正文、用户气泡、
    AI markdown（`components/markdown-text.tsx` 的 `.aui-md`）和 composer
    都读 `--conversation-text-font-size`。**100% = 15px 绝对值**
    （`--conversation-text-base-size: 15px`；2026-11-24 用户校正"之前是 15"），
    再点已选档位恢复 100%。
  - 聊天字体 / 终端字体：hermes 同款 ComboboxInput（本地
    `app/settings/combobox-input.tsx` 复制，popover z-index 抬到
    `--z-modal+10`，否则被设置浮层盖住点不到）+ 实时预览；聊天字体写
    `--font-family`（`--font-family-default` 为原 HarmonyOS 栈）并同步
    `$chatFontFamily`；终端字体写 `--term-font-family`，`TerminalPane`
    订阅 appearanceStore 热更新已有 xterm。
  - 开场标识：空对话显示 **MIRACH 字标** +「有什么可以帮你的？」；关闭
    整块隐藏。**2026-11-24 按 hermes `Wordmark` 的 `.fit-text` 复制**：
    字标宽度 = 输入框列宽（`thread.aui` 里 `width="100%"`），字号由
    `--fit-ratio` 随宽度缩放（实测 934px 列 → 215px 字），不再写死 32px。
    **letter-spacing 必须同时挂 `.mirach-wordmark` 和它内部每个 span 的
    `0.08em`**——只写在 p 上会在父字号 15px 结算，200px 大字只有 1.2px
    间距，左右各空 74px；逐 span 解析后文字左右边与输入框误差 <0.1px。
    结构里的第二份 `aria-hidden` 文案是宽度参照，不能删。starter
    suggestions 气泡整组已删除（用户："总结我们当前对话进度等气泡提示
    组件删除卸载"）。
  - 底部动效：`BottomWave`（`components/bottom-wave.tsx` +
    `styles/appearance.css`）——窗口底部两层弧形渐变波浪，颜色 `--brand`，
    **高度 33.333dvh（软件 1/3）、从底边起**。2026-11-24 用户："不能挡
    文字和各种组件"：组件挂在 `.app-shell` 内、`.app-main` 之下
    （wave z-index 0 / app-main z-index 1），只在栏间空隙和半透明栏面后
    可见，不再 fixed 覆盖消息/会话行/输入框；pointer-events:none，
    `prefers-reduced-motion` 停动画。
  - 聊天背景（2026-11-24 最终口径）：`GlobalBackdrop` 在 #root 后铺**一张**
    图；**每栏容器**通过 `--surface`/`--surface-shell` 的透明度档位透出
    它，基础色仍是主题的 `--surface-base`/`--surface-shell-base`，颜色不变。
    透明度 5/15/30/50/100 → surface 保留 96/90/82/72/55%（shell 再低 8，
    最低 45%）；变量 `--backdrop-surface-keep`/`--backdrop-shell-keep` 只在
    `<img onLoad>` 挂 `data-mirach-backdrop-ready` 后由 CSS 消费，图片读
    失败不会把窗口透成桌面。**每栏只留最外层 `.dv-groupview` 一层色**：
    `[data-slot='aui_thread-list-root']` / `[data-testid='workspace-file-tree-panel']`
    在背景开启时 transparent，否则会在会话列表/文件树里再叠一层"容器"。
    输入区照 hermes `styles.css` 的 composer fill：ComposerBar rest =
    `--composer-fill` **55%** + 12px backdrop blur saturate(1.12)（不再叠
    白色渐变；footer 已 portal 到滚动区外，输入框后面没有消息）；
    footer **通过 portal 移到 viewport 外侧**（`createPortal` 保留
    ThreadViewport context），消息滚动区结束在 footer 上方；viewport 用
    `mask-image` 在最后 64px 渐隐到透明——不画颜色、不裁输入框，也没有
    硬边界。footer 本身全栏宽，里面的 status/composer 用
    `max-w-(--dsh-chat-content-width)` 居中，输入框宽度保持内容列宽
    （用户："输入框的宽度怎么跟着变了"→"输入框很白是不是层级变了"）。
    来源只有两项：
    内置图片横向切换（`BUILTIN_BACKDROPS`）或自定义上传（Tauri dialog →
    存路径 → `fs_read_data_url` data URL，大图不进 localStorage）。
  - 文件浏览器 = 主窗 dockview `files` 面板，跨窗口镜像键
    `mirach:appearance.file-browser.v1`；消息气泡透明度 =
    `--user-bubble-keep`（0 实心 / 100 只剩描边），描边另有
    `bubbleOutline` 开关（关 = `border-transparent`）。
  - **窗口透明已接通**：`tauri.conf.json` `transparent: true` +
    `lib/translucency-host.ts` 在任何主题模块前装 `window.hermesDesktop`
    桥（`translucencySupported/glassSupported = true`、`setTranslucency`）；
    Clear 用 `#root` opacity（0→1，100→0.3）模拟整窗淡出，Glass 用
    `getCurrentWindow().setEffects(Acrylic)` + `--translucency-glass-keep`
    让 surface 半透明；权限 `core:window:allow-set-effects`。
  - 悬停/选中统一：`--hover-wash: #f1f4f8`、`--select-wash: #e3eaf2`
    （暗色 rgba(148,163,184,.12/.18)；2026-11-24 用户"太亮、饱和度太高"
    后降饱和），`--tab-hover-bg` / `--ui-row-*` /
    `--ui-control-*` 全部别名到这两个令牌；`--accent` 固定浅蓝。
  - 首选项默认：界面缩放 100、聊天文字 100（15px 基准）、气泡 0 + 描边开、
    开场标识开、聊天背景关、底部动效关、文件浏览器关；主题 mode 缺省 light。
    **所有可选项都有默认/重置**：已选缩放或聊天字号再点回 100，主题/皮肤
    再点回 `HOST_THEME_NONE`（宿主基础外观，无主题），主题色/文字色再点回
    跟随主题，内置背景再点回第一张，气泡透明度有「默认」按钮。

## 2026-11-23 设置页「数据与统计」全链路对齐（ZCode，当前有效）

用户口径："除了分享管理以外全部复制，不许自己做"。四个子页的现状：

- **数据同步** = ZCode 的远端设备配置同步（SSH / WSL / Docker），不是网关连接。
  设备存 `~/.rpi/agent/data-sync-devices.json`，推送 = 本机 `tar.exe` 打包
  skills/extensions/mcp.json 流到远端 `~/.rpi/agent`。密钥只进 keyring，
  askpass 用临时 `.cmd` + `MIRACH_SSH_SECRET`；**不得回显/落盘**。
- **迁移数据** = Claude Code 导入器（会话 / Skills / MCP / AGENTS.md；commands
  如实不支持），会话经 `JsonlSessionRepo` 写成真 pi JSONL。UI 是 ZCode 六步
  向导（迁移对话框），不是自造表单。
- **项目管理**：全量 ZCode ProjectManagement 语义——未使用检测
  （missing/empty/idle）、建议卡（stats 加载完成才显示，避免闪错数）、
  搜索/过滤/排序、**全选 indeterminate**、置顶 Pin、多 root +N 浮层、
  窄屏三列折行、失败条「重试 + 关闭」、批量移除 toast「撤销」、已移除项目
  分组（软删可恢复；宿主无 purge 命令，不放假彻底删除）。
  **工作区 = 项目**（2026-11-23 补）：启动时 `runtime.refreshThreads` 按
  `pi_sessions_index` 的 distinct cwd 自动补登记项目（`workspace-projects.ts`；
  已有项目根/软删项目根覆盖的 cwd 跳过，不复活用户移除的项目）；「选择文件夹」
  新建会话前先 `ensureProjectForWorkspace`（同根活跃复用 / 回收站恢复 / 新建），
  再 `pi_new_session`，失败则整个请求失败。此前只建会话不落项目注册表，项目页
  恒 0。
- **归档管理**：标题行「全部永久删除 / 永久删除筛选结果」、搜索清空、排序
  「更新时间 / 创建时间」、项目过滤（未归类 / 名 · 已移除 / 已移除项目）、
  组折叠箭头、删除确认、逐条结果「成功 N 项，失败 M 项，跳过 K 项」。
  当前打开会话删除时跳过并计入 skipped（引擎拒绝删活动会话）。
- **用量**：ZCode App Usage 全量；`daily[].models` 是每天各模型 token，
  趋势图 = top 6 模型多折线 + 图例（不是单条总量线）；
  `summary.longestSessionMs` = 单会话首末消息时间戳差的最大值（旧文件无
  时间戳不计，不造 0）。**Coding Plan 不移植**（云端订阅 API，宿主无账户）；
  **分享管理不移植**（用户明确排除，宿主无分享服务）。
- **wire 变更**：`pi_sessions_index.sessions[]` 加 `createdAt`（header.createdAt
  Unix ms，缺失 0）；`pi_usage_snapshot.daily[]` 加 `models`，summary 加
  `longestSessionMs`。改这两处时同步 TS 类型 + 测试夹具。

## 2026-11-24 设置页导航/布局/记忆插件（当前有效）

- **导航真相**（`settings-overlay.tsx` 的 NAV_GROUPS）：通知单页（无提醒/
  声音子页）；模型子项 = API 密钥 / 自定义端点 / 默认模型（**账号已删**）；
  安全与数据 = 安全 / 密码与登录 / 会话管理 / 键盘快捷键 / 知识库（**项目
  顶层项已删**）；**会话管理总项**的四个子项 = 数据同步 / 使用统计 / 项目
  管理 / 归档管理（原「数据与统计」组不复存在）。关于只有版本与更新。
- **布局**：`--dialog-nav-w` = 200px；`.set-nav-head` padding-left 20 对齐组
  标题；`.set-inset-head` 是独立卡片（同 --surface/描边/--radius-panel-lg，
  padding 0 16px），标题与卡内正文同基线；`.set-scroll` 底部不留 20px，
  内容卡（`.set-section` / `.set-persona` / 最后一张 `.set-acct-card`）
  `flex:1 0 auto`，只有一项也撑到左栏岛底边。
- **通知页**：逐字对齐 hermes `notifications-settings.tsx`——启用通知 +
  七类事件 + 完成提示音（选择 + 预览）+ 测试按钮；每行用 `SetPrefRow`
  文字左、`Switch` 右、垂直居中。**不要改回 checkbox/子页**。
- **记忆插件 rpi-optchat**：`rpi install rpi-optchat` 装到
  `~/.rpi/agent/extensions/rpi_optchat.dll`，原生扩展装即启用；引擎工具
  集实测含 `zoom`/`search`。设置页状态读 `pi_pkg_list`，不写死「未安装」。
  `/optchat` 命令只在终端可用；MEMORY.md/USER.md 与 mem0 仍无对偶。
- **rpi settings 审计口径**：`retry.maxAgentDelayMs` 才是引擎退避上限
  （`max_delay_ms` 已删）；`shellPath` / `shellCommandPrefix` 真消费，已接
  「技能与工具 → 终端执行」。TUI 专属键（theme/keybindings/editorPaddingX…）
  与无消费方键（branchSummary/compaction.modelOverrides）**有意不做 UI**。
- **插件集成**：mirach-pkg 目录删除；mirach-connections 只保留
  `bots.roster.grouping`（设置页「连接」删除）；无贡献时整组隐藏。

## 工具链钉版（升级前必读）

| 包 | 版本 | 为什么 |
|---|---|---|
| typescript | 5.9.3 | 与 hermes 一致；升级前先跑全量 tsc（历史上有假错版本） |
| react / react-dom | 19.3.0 | assistant-ui 0.15.x 的对型基线 |
| vite | 7.3.6 | 配置里有 React Compiler 的 babel pass（见 vite.config.ts），**不要砍** |
| vitest | 4.1.10 | node 环境 + localStorage 替身（无 jsdom） |
| @assistant-ui/tap | 0.9.19（transitive） | **教训**：0.9.18 曾触发 "getSnapshot should be cached" 无限循环（33 个测试文件全炸）。≥0.9.19 已修，保持现状；若复发先查这个版本，可临时钉回 0.9.8 |
| dockview-react / core | 8.5.1 | 序列化形状与约束语义按此版本实测（组 state 不含约束，见下） |
| @tauri-apps/api / cli | 3.0.0-alpha.2 / 3.0.0-alpha.4 | 与 Rust 侧 tauri 3.0.0-alpha.4 配对 |

重装依赖后先跑 `npx tsc --noEmit` + `npm test` 再动别的。

## 门禁（提交前必须全绿）

```
npx tsc --noEmit                 # 注意：本分支 hermes-mirror 仍有历史缺模块错误（见 2026-11-22 节）
npm test                         # 当前 1121 用例 / 95 文件
cd src-tauri && cargo test       # 当前 738 用例
cd src-tauri && cargo check      # 0 错误（既有 warning 是上游/未用代码 lint）
```

> **2026-11-22 实测事实**：`npx tsc --noEmit` 并非 0 错——`src/hermes-mirror/**`
> 有约 1318 条历史错误（`@/types/hermes`、`@/lib/session-owner-stamp` 等宿主
> 没有的上游模块）。改到镜像区时只能用「本次改动文件无新增错误」判定，
> 不得再宣称全量 tsc 绿。

`npm test` 配置 = `vitest.config.ts`（node 环境、`@` 别名）+ `vitest.setup.ts`
（localStorage Map 替身——**无条件安装**，见陷阱 11）。

**`include` 是逐目录列举的，不是 `src/**`**（2026-10-31 改）：镜像来的
`hermes-mirror` / `hermes-shim` 用例是上游环境（jsdom + 上游 i18n provider）
的，不能全收；只有 `hermes-mirror/app/cron/{job-state,cron-job-model}.test.ts`
这两个纯逻辑用例被显式列进 include。**`exclude` 不支持否定模式**（`!x` 会被
当字面 glob），所以别试图"先全排除再放回"——实测收集到 0 个文件。新增
mirror 用例要进门禁，就往 include 里加一行具体路径。

**cargo 必须从 `src-tauri/` 目录跑**：`rust-toolchain.toml`（nightly-2026-08-31）
在该目录下，从仓库根跑会用 stable，asupersync 立刻报 `#![feature] may not be used
on the stable release channel`。

**cargo 必须与 cmake 同 PATH**（历史遗留的构建脚本依赖）：
`set "PATH=%USERPROFILE%\miniconda3-mirach\Library\bin;%PATH%"` 后再跑 cargo。

## 待办（按优先级）

### 1. 真模型端到端（唯一硬阻塞）
配凭据后验证：工具真数据形状、图片理解、压缩真触发、用量成本真数字、
thinking 流式、自动命名 LLM 段。凭据入口 = 设置页「提供方凭据」段。

### 2. 设置页用户自己做
hermes 的 `src/app/settings/` 115 个文件**全量在树里**（不是最终形态）。
关键事实：**70/115 的 settings 文件被外部当组件库用**（capabilities 的
toolset/终端/浏览器面板、messaging 的凭据 UI、`sdk/index.ts`、i18n 的
en/zh、boot-failure 的 gateway 浮层）。用户自己做时的切面：**替换"页面壳"
（`settings/index.tsx` 导航结构 + 各 `*-settings.tsx` 顶层页面），
保留被嵌入的原语**（`primitives.tsx`、`helpers.ts`、各 `*-panel.tsx`、
`credential-key-ui.tsx`）。动壳之前先跑一遍"谁 import 我"。

**2026-10-24 已移植的六节**（hermes → harness 设置页，`SectionId` 见
settings-overlay.tsx 的 NAV_GROUPS/IMPLEMENTED_SECTIONS）：通知
（notifications-settings → localStorage 偏好 + `pi_notify_test`）、密码与登录
（vault-settings → **pi_vault.rs** local 源：元数据 JSON + secret 进 OS 凭据
管理器 keyring；来源子页的 bw/op 安装探测走 **pi_login.rs** 的
`pi_vault_sources`（真实 spawn `--version`），解锁/列条目待接线——UI 如实
标注）、键盘快捷键（keybind-settings + store/keybinds → **lib/keybinds.ts**
差分覆盖存储 + **global-keybinds.tsx** 派发器挂 AssistantRuntime 内）、提供方
→ 模型节（providers 凭据目录 + `pi_set_provider_key`/`pi_delete_provider_key`
写 auth.json；**账号 OAuth 登录已接通**（pi_login.rs，见下）；端点「测试」=
`pi_endpoint_validate` 真发 GET {base}/models）、网关 → 核心连接（本地端点/
token 只读展示 + 复制；hermes 的远程/云/SSH 模式深绑它的网关后端，未移植）、
关于 → 版本与更新（应用名/logo 已换 Mirach；引擎版本 `pi_engine_version`
从 vendored Cargo.toml 编译期读）。

**pi_login.rs（2026-10-24）**——pi::auth 的公开 OAuth 面接成 IPC：四家
localhost 回调流（anthropic / openai-codex / google / google-antigravity；
kimi/copilot/gitlab 是设备码流，不列假入口）。`pi_oauth_start` = 生成授权
URL + PKCE verifier + `start_oauth_callback_server` 本机监听 + 开系统浏览器；
回调线程收到 code 后跑 complete 并写 auth.json（verifier 只存内存，重启 =
流程作废）。**回调线程里的 complete 用独立 asupersync current_thread 运行时**
（pi 的 future 不能进 tokio，构造与 PiRuntime 同款）。UI 轮询
`pi_oauth_status`（pending → ok/err，5 分钟超时）。**ProvidersSettings 是受控
组件**（view/onViewChange props）：左栏「模型」子项是唯一导航源，组件内不再
有顶部 tab 行，也没有"无 OAuth 账号就落密钥视图"的回退（回退会藏掉登录
按钮——接通后已删）。

**账户页（2026-10-25，openhuman 移植）**——`src/app/settings/account-settings.tsx`：
照抄 openhuman `AccountPanel.tsx` + `LogoutAndClearActions.tsx` 的结构（卡片
网格 / Field 行 / 会话卡 / 二次确认对话框），文案用它的 zh-CN 原文、
`签名至 OpenHuman` → `签名至 Mirach`。**上游「偏好」卡按用户定稿移除**，
语言与时区搬到「基础设置 → 常规」（`src/lib/ui-prefs.ts`：localStorage
`mirach:locale` / `mirach:timezone`，语言只留中文+English，时区默认
"使用设备时区"）。宿主没有云端订阅：套餐徽章与用量条整块不渲染（不造假
数据），「打开控制台」暂用 openhuman 的
`https://tinyhumans.ai/dashboard?tab=billing`（用户指定，后续替换）。
「退出登录」= 清空 auth.json 全部提供方凭据；「清除应用数据」= 凭据 +
vault 条目（会话/设置/工作区属用户资产，**不清**，对话框文案已按宿主事实
改写）。语言选择的生效范围如实标注：持久化 + 驱动 `<html lang>`/日期格式，
界面文案仍是硬编码中文（i18n 未建，`src/i18n` 只有 .gitkeep）。

### 3. 最后一波接线（可接件清零）
checkpoint UI（命令面已通）、cost-meter、read-aloud（speechSynthesis）、
regenerate-menu。~~message-queue~~ 与「通知派发」同域：通知设置已接线
（2026-10-24），派发端（会话事件 → OS 通知）待专项；steer/follow_up 随
pi 0.8.0 可用。

### 4. pi 升级（已完成 2026-10-24：0.5.1 → 0.8.0）
原计划"等真模型端到端基线再升"，用户拍板直接升。要点（下次同步必读）：

- **上游源** = `G:\pi_agent_rust-main`（已镜像 v0.8.0，265MB；旧 0.5.1 树连同
  target 缓存已清）。**vendor 白名单** = 12 项：`benches docs examples
  legacy_pi_mono_code proptest-regressions src themes` + `build.rs Cargo.toml
  CHANGELOG.md LICENSE README.md`（上游 265MB → vendor ~48MB）。
- **同步时必须重打 2 个脱敏补丁**（GitHub push protection 会拦真实值，上游真源
  不动）：`src/auth.rs` 的 Google OAuth client 元数据 → `MIRACH-VENDOR-REDACTED`
  （4 处）；`src/secrets.rs` 测试假密钥 → 占位（2 处）。脚本化替换后 grep 校验
  泄漏为 0。
- **session_index.rs 的 .read(true) 本地补丁已退休**（v0.6.0 上游修复，gh #239）。
- **代码适配只有一处**：`pi::checkpoint::summarize_span` 签名从
  `(span, provider, &api_key, settings)` 变为
  `(span, provider, &StreamOptions, settings, &CompactionPrivacy)`
  （pi_session.rs rewind 路径，写法照抄上游 sdk.rs）。其余消费面
  （`SessionOptions::default()` 结尾写法 / `AgentEvent` / `pi::config` /
  `pi::models` / `pi::provider_metadata`）0.8.0 兼容。
- 0.8.0 的 breaking 清单见上游 CHANGELOG：`SessionOptions` 新增
  `model_scope/max_time/skills_prompt/no_context_files/advisor`（Default 结尾
  写法免疫）、`mount_mcp_server_tools_if_absent` → `refresh_mcp_server_tools`
  （宿主未用）、`restore_secrets_inbound` 返回 `Result`（宿主未用）、MCP
  discover/bootstrap 加 `project_trusted`（宿主未用 `pi::mcp`）。
- vendor 的 Cargo.toml 随上游走（edition 2024、rust-version 1.95、工具链钉
  nightly-2026-08-31 不变）；依赖树大版本跳动（fsqlite 0.4 / gix 0.8x /
  jsonschema 0.58 / ftui 0.9 / ast-grep 0.45）已随 Cargo.lock 更新。

### 5. 谱系树嵌套
`list_sessions` 透出 `branchedFrom`（Rust 小改）→ 接 hermes
session-branch-tree 语义（├─/└─）。

### 6. 终端已知限制
同组内切页签会卸载隐藏窗格 →「卸载 = kill」语义下终端会话结束（独占分栏不受
影响）。跨切换保活 = ZCode 式模块级 registry，独立一轮。

### 7. 其余
人工验收 + i18n + L5 移动端。

## 本工程的规矩（违反 = 制造 bug）

1. **照抄 hermes，不要自己做。** 所有手写替身都是 bug 来源；上游测试的环境
   缺陷也只做**最小放宽**并写注释。已知例外：**上游 i18n 缺口**（如会话侧栏
   筛选菜单硬编码英文、`errors` 段 zh 缺键）——走正规 i18n 三件套补齐
   （types.ts 契约 + en 原文 + zh 译文）。
2. **语言只留 en + zh**（用户决定，上游六种）。plugins 的 ja/zhHant bundle 留在
   源文件里但**不再注册**。
3. **`main.tsx` 只保留三支窗口**：主窗、`?win=quick`、`?win=hud`。
4. **中文/emoji 编码**：PowerShell 5.1 读 .ps1 按 ANSI、`Set-Content` 写 ANSI
   ——改文本一律 `[System.IO.File]::ReadAllText/WriteAllText` +
   `New-Object System.Text.UTF8Encoding($false)`。`Copy-Item`/`robocopy` 是字节
   复制，安全。
5. **tsc 输出正斜杠路径**（`src/app/...`），路径处理要兼容两种斜杠。
6. **vite 会死于 `EBUSY … watch '…\Cookies'`**：Edge `--user-data-dir` 一律放
   `%TEMP%`，绝不放进仓库。
7. **`tauri dev` 外壳死掉时 Vite 可能活着占住 1430**：
   `netstat -ano | findstr :1430` 找 PID 杀掉再重启。
   变体：应用跑着时改 `tauri.conf.json`/Rust 触发热重建，watcher 会撞
   `EBUSY … target\debug\deps\*.dll` 直接退出——正常现象，杀干净重开即可。
8. **vite 1430 是 Tauri devUrl**（`src-tauri/tauri.conf.json`），端口改动两边同步。
9. **vite.config 别配 `server.fs.allow` 收窄**：收窄后运行期动态 import 的模块
   全部 403（"outside of Vite serving allow list"），页面表现为部分功能静默失败。
9b. **临时产物不要写进仓库根**（tsc/vitest 输出重定向到 `%TEMP%`）：vite watch
    着仓库根，根目录文件一变就整页 reload。
10. **测试环境**：`vitest.setup.ts` 的 localStorage **无条件装 Map 替身**——
    jsdom 真实 Storage 上 `vi.spyOn` 静默失效（Node 24.18 实测），别改回条件安装；
    部分 hermes 测试隐含英文 OS（Intl 相对时间跟随系统语言），本机（中文 Windows）
    会有措辞差异，遇到先怀疑这个。
11. **禁止兜底（2026-10-01 用户定稿：错误就是错误）**：任何实现不得写
    fail-open / 静默降级 / 默认值替代 / 乐观假装成功——失败必须传播
    （Err / throw）或可见（RUN_ERROR 进缓冲、console.error），调用方自己决定
    怎么处理。新代码过审查时按此条执行。
12. **cargo 并行编译会 OOM**：16GB 机器上 `jobs=4`（`.cargo/config.toml`）仍可能在
    asupersync / fsqlite-core 上炸 `rustc-LLVM ERROR: out of memory` /
    `STATUS_STACK_BUFFER_OVERRUN`。换运行时（如 CEF→wry）这类需要全量重编的
    改动，用 **`cargo build -j 1`** 一次过，别硬扛。

## 窗口外观：Tauri 原生壳（2026-10-25 定稿，10-26 补三条）

**结论先行**：`tauri.conf.json` 的 `decorations: false` + `shadow: true` +
`visible: false`；Rust 侧 `apply_window_chrome`（`wire_window` 里每个顶层
窗口调）做两件事：`DWMWCP_DONOTROUND`（直角）+ `DWMWA_BORDER_COLOR =
COLOR_NONE`（无描边）。窗口 = 直角矩形 + Windows 的 DWM 系统投影，无标题栏。

- **不要动 `NCRENDERING`**：改成 `DWMNCRP_DISABLED` 会让渲染退回经典 GDI
  路径，系统把 `WS_CAPTION | WS_THICKFRAME` 的完整边框画回来（2026-10-24
  实测回归，用户原话"外面怎么套了一个窗口"）。
- **样式位里带 `WS_CAPTION` 是正常态**：tao 的 `to_window_styles()`
  无条件写它，无边框靠它自己的 `WM_NCCALCSIZE` 处理把客户区铺满全窗。
  实测右上角干净、没有 — □ ✕ 按钮。
- **CSS 侧 `--radius-shell = 0`**（tokens.css）：外壳不画圆角。窗口
  `transparent: false`，CSS 若画大弧，弧外会露出白块。
- **栏卡片仍是圆角**（`--radius-pane: 25px` + `--shadow-pane`）：容器的
  悬浮感靠这两者；2026-10-25 曾试过改直角，用户次日要求恢复并加重阴影。

### 三条 2026-10-26 实测修复

**① 顶部 1px 黑线（`top_line` 模块）**：窗口矩形 T+0 那一行横贯全宽都是
`31,31,31`，T+1 起才是壳色；左右下三边没有。这是 tao 给 undecorated 窗口
做 `WM_NCCALCSIZE` 的副作用（`WS_CAPTION` 族样式位在 tao 里无条件写入）。
`DWMWA_BORDER_COLOR = COLOR_NONE` **管不到它**。修法 = 子类化 wndproc，
在 `WM_NCCALCSIZE` 里把 `rgrc[0].top` **上移 1 物理像素**（客户区多吃掉
那一行），最大化态不动（贴屏边不该有偏移）。验证：`CopyFromScreen` 采
T+0 行，修复后应是壳色而非 31,31,31。

**② 启动跳跃（`visible: false`）**：窗口原以 `tauri.conf.json` 的
1280×820 **可见**创建，setup 里再 `set_size` 到存档尺寸 → 用户看到"先闪
小窗再变大"。修法 = 配置里 `visible: false`，setup 中几何定好后
`window.show()`。用户看到的第一帧就是最终几何。

**③ 圆形图标钮图标偏左**：会话行的 `aria-label="会话操作"` 按钮原本是
`size-5` + `p-0`，**没有 flex 居中** → svg 按文本基线对齐，实测左偏
2.81px；且 20px 命中盒偏小（用户"圆的范围有点小，不好点中"）。修法 =
`inline-flex size-6 items-center justify-center`。**判定方法**：CDP 遍历
所有圆形按钮，比对 `svg` 中心与按钮中心的 dx/dy，>0.6px 即未居中。

**④ 图标尺寸归拢（2026-10-26）**：此前 208 处图标写死 `size-2.5/3/3.5/4/5/8`
（5 个档位、跨 80 个文件）。归拢为**四个令牌**（tokens.css）：

| 令牌 | 值 | 用途 |
|---|---|---|
| `--size-icon-xs` | 10px | 行内标记（状态点、列表前小圆点） |
| `--size-icon-sm` | 12px | 紧凑图标（表格/列表行内） |
| `--size-icon-md` | 14px | 默认（工具条/按钮图标，绝大多数） |
| `--size-icon-lg` | 16px | 图标钮里的图标（`--size-icon-glyph`） |

用法 `className="size-[var(--size-icon-md)]"`。**新代码不要写字面值**。
盒子与图标分离：`--size-icon-btn`(28) ← `--size-icon-glyph`(16)，差值就是
命中余量（用户："按钮的到图标给个空白的间隙，可点击的区域不是大了吗"）。
档位：盒 28/32/36 ← 图 16/18/20。

**⑤ 弹窗动效接线（2026-10-26）**：`--beui-ease-*` / `--beui-dur-*` 令牌
早在 tokens.css 里，但只有设置页浮层用了（`.set-overlay`）。用户在
`ui-primitives.css` 补了一套**通用弹窗动效**：`beui-popup-in/out`
（菜单类，缩放 + 位移）与 `beui-dialog-in/out`（对话框，纯缩放），
选择器挂 Radix 的结构属性：

```css
[data-radix-popper-content-wrapper] > [data-state='open'] { animation: beui-popup-in ... }
[data-slot='dialog-content'][data-state='open']          { animation: beui-dialog-in ... }
```

**为什么用 CSS 而不是换成 beui 的 motion Popover**：beui Popover 是 goo
粘性形变（SVG filter + spring），API 与 Radix 的
`ContextMenuPrimitive`/`DropdownMenuPrimitive` 完全不同；`thread-list.aui.tsx`
有 142 处 Radix 用法（assistant-ui 的 ThreadListItemMorePrimitive 深度绑定），
整体替换回归风险远大于收益。CSS 关键帧让所有弹窗一次性获得同一套动效，
**行为零改动**。验证：CDP 打开右键菜单，读
`getComputedStyle(el).animationName` 应为 `beui-popup-in`。

### 为什么不再自绘（这一段的血泪史，别重走）


2026-10-22 ~ 10-25 试过一整套自绘方案，最终全部拆除。**核心教训：
`SetWindowRgn` 能实现跨进程鼠标穿透，但它把边距裁出窗口区域，画在边距里的
CSS 阴影随之消失；而"边距里有阴影"和"边距可穿透"在 WebView2 上互斥**
（阴影必须由 webview 画在窗口内，而画阴影的 webview 会吃掉点击）。

试过并**否决**的路（都在运行中的窗口上逐像素实测过）：

| 尝试 | 结果 |
|---|---|
| CSS `box-shadow` + 40px 透明边距 | 阴影跟随 35px 弧，但边距区是鼠标死区（用户报"鼠标没法穿透"） |
| `WM_NCHITTEST → HTTRANSPARENT` | **只对同线程窗口有效**；边距下面是别的进程，点击仍被本窗吃掉 |
| 给全部子窗装穿透 hook（`install_family`） | 同线程子窗有效，但 WebView2 的 `Chrome_WidgetWin_1` 是**独立进程**（msedgewebview2.exe），装不上 |
| `SetWindowRgn(圆角矩形)` | **跨进程穿透成立**（边距点归属桌面/别的应用），但 CSS 阴影被一起裁掉 |
| 独立 layered 阴影窗（`UpdateLayeredWindow`） | 带 `WS_EX_TRANSPARENT` 时内容不显示（合成器跳过）；去掉它又会吃点击 |
| `DwmExtendFrameIntoClientArea` 归零 / `NCRENDERING` 开关 / blur region 变体 | 都不能让 DWM 投影跟随 CSS 弧 |
| tao vendor 补丁（undecorated 窗出生即无 caption 位） | 治好了"失活后顶部 caption 玻璃带"，但与本轮取舍无关，已一并撤除 |

**验证方法论（仍然有效）**：

- **CDP 截图看不到任何 OS 合成层**（系统按钮/投影/描边/caption 带），这类
  验证只能走 `CopyFromScreen`。
- **桌面壁纸纯黑时系统投影不可见**（采样恒 0 = 没测）。要么垫一个浅色窗口，
  要么看窗口边缘外侧的渐变。
- **失活复现**：caption 带只在窗口失活后出现（如打开设置窗）——验证"没有条"
  必须先开一次设置窗再测。
- `WindowFromPoint` 不按 `HTTRANSPARENT` 语义走，不能当穿透的验证工具；
  真实穿透要用 `SendInput` 点击后看前景窗口。

> **【已废止 · 2026-11-22】** 用户："这个弹窗效果组件就不要了，换成默认的
> 弹窗效果就行"——goo（GooSurface / goo-layer.tsx / `--beui-popover-goo`）
> 已整体删除：`context-menu.tsx` 与 `popover.tsx` 的弹层改为 portal 到 body
> 的 fixed 面板 + tw-animate 默认 `animate-in fade-in-0 zoom-in-95`；
> 下方 2026-10-26 / 11-01 的 goo 设计记录与 goo-layer.test 守卫**仅作历史**，
> 不要再照它实现。现行落位规则见「侧栏按钮打通审计」一节的根因段。
>
> **默认缩放的进场纪律（2026-11-22 修"打开后抖一下"）**：`animate-in` 必须
> 在**测量完成的那一帧**才挂（popover：`open && layout`；菜单：
> `size.width > 0`），且 `transform-origin` 指向锚点边缘
> （side=top → 底缘、bottom → 顶缘，x 随 align）。中心缩放 + 先画后测的组合
> 会在可见第一帧把面板先按旧几何画出来再挪位，观感就是"打开后抖动一下"。

## 弹层动效：只有一个来源（2026-10-26 用户定稿）
用户："能不能归拢成一个，现在输入框的模型选择，右键，左侧栏，三种效果，
所有的弹窗效果归拢成一个"。

**归拢前确实是三套**（各自为政，观感互不相同）：

| 面 | 实现 |
|---|---|
| 模型选择器 | `motion/popover.tsx` 的 goo（SVG 粘性滤镜 + `shape()` 形变） |
| 右键菜单 | `motion/context-menu.tsx` 的 clip-path 从落点摊开（无粘性） |
| 侧栏/会话菜单 | Radix + `ui-primitives.css` 的 opacity/scale 缩放淡入 |

**归拢后**：几何与渲染只有一份 —— **`src/components/motion/goo-layer.tsx`**
（`buildGooGeometry` + `GooSurface`）。所有有锚点的弹层都渲染它：

| 面 | 锚点形态 | 调用点 |
|---|---|---|
| 模型选择器 / 标签总览 | `trigger`（触发钮矩形） | `motion/popover.tsx`（`Popover`/`PopoverContent`） |
| 全局右键菜单 | `point`（右键落点，0×0 锚点） | `layout/app-context-menu.tsx` |
| 侧栏选项（含 3 层子菜单） | `trigger` | `thread-list.aui.tsx` 的 `SidebarViewMenu` |
| 会话行 ⋯ / 右键 | `trigger` / `point`（同一个菜单实例，开时定） | `thread-list.aui.tsx` 的 `ThreadListItem` |
| 文件树行右键 | `point`（左键保留展开/选中） | `panes/workspace-file-tree/WorkspaceFileTreeRowView.tsx` |
| 标签条「+」 | `trigger` | `layout/tab-strip-new.tsx` |

**模态对话框例外**：居中、无锚点，goo 的"从某处长出来"语义不适用，仍是
Radix Dialog + `ui-primitives.css` 的 `beui-dialog-in/out` 关键帧。

**必须知道的五件事**（都是实测坑）：

1. **CSS 不能给菜单挂 animation**。菜单元素由 motion 的 clip-path 动画驱动，
   再叠一层 `@keyframes` 会把形变覆盖成缩放淡入——这正是归拢前"三种效果"的
   成因。`ui-primitives.css` 里已把菜单类选择器删干净，只剩对话框。
2. **`ContextMenuAnchor` 必须 forwardRef**。它夹在 `Tooltip`（asChild 克隆链）
   和 `button` 之间；不转发 ref → Tooltip 拿不到锚点，实测 12 条
   `TooltipTrigger: the child did not attach a ref` 且所有图标钮悬停提示失效。
3. **关闭后必须卸载 portal**。每个菜单带一份 `<svg><filter>`；不卸载时侧栏
   一屏（30 文件树行 + 20 会话行）常驻 **31 个 portal / 31 个
   `feGaussianBlur`**（实测 `portalCount=31`）。`closedAtRest && !open` 时
   `return null`，降到 2（模型选择器的常驻 portal + 当前菜单）。
4. **子菜单是独立 `ContextMenu` 实例**（锚点 = 父菜单里那一行的矩形）。
   外部点击判定要把"任何 `data-menu-portal` 命中祖先 id 链"算内部，否则点进
   子菜单会把父菜单一起关掉（三层结构会整串塌）。
5. **二级悬停菜单必须同层互斥 + 延迟打开**（2026-11-23 用户实报"鼠标从上
   滑到下会出现很多弹窗"）。每个 `ContextMenuSub` 不能各持一份 `open`——
   SubTrigger 的 pointerenter 只开不关，扫过 6 个二级项会叠 6 个 portal。
   现由父菜单记唯一的 `openSubmenuId`：新子菜单打开即替换旧的；指针移到
   父面板的非 SubTrigger 项时清空（`ContextMenuContent` 的 onPointerOver）。
   打开延迟 `SUBMENU_OPEN_DELAY=120ms`，pointerleave 取消，避免纵向滑过
   时一路闪。CDP 实测：6 个二级项逐个 hover，portal 恒 = 2（父 + 当前
   子菜单）；移到普通项 → 1；关菜单 → 0。

**守卫**：`motion/goo-layer.test.ts` 锁住几何两种形态 + "只有一个 goo 滤镜
实现" + "CSS 不再给菜单挂 keyframes" + "四个调用点不再 import Radix
DropdownMenu" + "goo 开关只有令牌一个来源（调用点不许传 `goo`）"。改这套之前
先看它为什么红。

### goo 总开关：令牌，不是调用点（2026-11-01 用户定稿）

用户："调用点没传，直接在令牌中统一开关不行吗"。

**是。** `tokens.css` 的 `--beui-popover-goo`（默认 `0` = 关）→ `ease.ts` 的
`POPOVER_GOO` → `GooSurface` / `Popover` / `ContextMenu` 三处 `goo` 默认值。
**调用点一个都不传**；此前散在 3 个调用点的 `goo={false}` 已全部删除（那是
"有的有脖子有的没有"的成因）。要开回 beui 原设计只改令牌一个数字。

为什么不能"纯 CSS"：开关要控制**渲染结构**（画不画锚点副本 `<div>`、`filter`
里拼不拼 `url(#goo)`），CSS 变量只能改已渲染元素的样式值，删不掉 DOM 节点。

**`goo=false` 的收起终点必须换**（`collapseStartRect`）：`goo=true` 时收起
终点的 clip 是触发钮矩形，靠 `anchorCutout` 挖掉所以看不见；`goo=false` 没有
cutout，若仍收缩到触发钮矩形，面板会变成**盖在按钮上的白色方块**再消失
（用户报的"白块跳闪"）。现在收缩到"面板朝向锚点的那条边"——几何上永远落在
面板内部。方向判定用**间隙最大**的那条边，不能用中心距（align=start 时两者
左边重合，中心距会把最近边判成左边，面板被压成一条竖线）。

**验证方法**（CDP 内联求值）：打开弹层后读
`[data-goo-portal]` 里 goo 体的 `filter` —— 令牌关时应是
`drop-shadow(...)`（**不含** `url(`）、`body.children.length === 1`（没有锚点
副本）。**只查 `role=menu` 存在不算验证**——那只能证明菜单弹出来了。

**两个 CDP 陷阱**（都踩过）：

1. **页面有常驻 goo portal**（模型选择器的），`document.querySelector('[data-goo-portal]')`
   会抓到它而不是刚开的那个——两次采样会得到完全相同的 rect。要按
   "visibility 非 hidden + 面板 `aria-hidden` 非 true + rect 非 0" 挑。
2. **`clipPath` 是相对 goo 层盒子**（goo 体的 `left/top` = `geo.left/top`），
   不是相对触发钮。拿面板相对触发钮的坐标去比会得到假失败。层原点 =
   `portal.getBoundingClientRect().x + parseFloat(body.style.left)`。

## ZCode 三件套移植（2026-11-01）：打开页 / 活动状态面板 / 文件夹位置

用户三连："面板栏的打开页的选项位置和排列用zcode的，对话区的右上角的活动状态面板直接用zcode的，新建任务的时候输入框上加个文件夹的位置选项，也直接用zcode的"，随后纠偏 "是不是全部做的精简版，没有完整，全链路复制？"——第一轮确实做了三处精简（锚签当标签、分区只收 running、chip 进了输入卡），本轮全部按全链路重做。源 = `G:\ZCode-main`（上游真源，只读参照）。

### ① 面板栏生命周期（ZCode 语义，dockview 版）

"zcode打开页是没有标签的，只有一个标签的时候是关闭是会关闭面板栏的"：

- **打开页无标签**：launcher 是栏的空态不是签。CSS `:has` 承担——`.dv-tabs-and-actions-container:has(.dv-open-tab-title) { display:none }`（flexlayout.css）。'open' 锚仍是一个 dockview panel（要它撑栏宽），但只剩它时整条标签条（含总览/加号/箭头）都不画。
- **末签关闭 = 关栏**：handlePanelRemoved 里面板列再无实签 → `setPanelsHidden(true)`，锚不复活。**'open' 自身被关（标签总览 ✕）也走这条**——实锤：早退分支漏记账，组被收走而 panelsHidden 仍是 false，重启 normalize 误报"旗标未隐藏但组不在树里"。
- **重开**：右键「打开面板栏」→ `setPanelsHidden(false)`；组不在场（末签关闭后 dockview 收走）→ **ensurePanelsAnchor 重建**（column-ops）。锚的 addPanel 必须 **min+max 都带**（RAIL_MIN/MAX_WIDTH）——漏 max 的重建组吃到比例摊分宽 766（实测）；重开后 rAF repinRailWidths 钉回目标宽。
- **实签抵达清旗标**：openPagePanel / preview opener 在 addPanel 后若 panelsHidden 仍 true → `setPanelsHidden(false)`（栏的生命周期跟实签走）。
- 旧的「栏宽快照 + 末签重建钉回」（colWidthSnapshotRef / onWillMutateLayout）随锚复活路径一起删除。

### ② 活动状态面板（packages/ui/src/v4/ConversationStatusPanel.tsx 的移植）

文件：`conversation-status-panel.tsx`（组件）+ `conversation-status-panel-model.ts`（模型）。上游结构逐段照抄：三态（auto=容器查询 / panel / mini）、控制行（Ellipsis 显示策略菜单 + Minimize2 收胶囊）、Collapsible 分区 + 每类限高滚动 + separated 上边线 + trailing 随开合切换、mini 胶囊优先级链。容器 = `.assistant-thread-pane` 的 named container `thread`（panes.css）。

- **draft 态不挂**（上游 SessionPane 同款）：activeId === null 直接 null。2026-11-01 实测教训：New Chat 态无会话 → pi_todo_state 报 no active session、gitBridge cwd=null 诚实清空 → 面板整块消失是**正确行为**，不是 bug。
- **数据面**：todo-store / agent-hub-store / jobs-store / git-store → buildStatusPanelModel（上游 buildConversationStatusPanelModel 的宿主适配）。
- **与上游的偏差（都有因）**：
  - 已结束的终端/子代理**就地留在分区**（运行中在前）——上游折进「已结束」目录页，宿主没有目录页；不这样做的话一回合一结束分区整个消失（用户报"没有终端/智能体"的根因）。
  - git 区 = 「更改」行（开审查面板，走 `__dvApi` + openPagePanel）+ 分支行（`fs_git_branches` / `fs_git_checkout` 新 IPC，git 子进程，分支名过白名单）。ZCode 的 GitActionMenu（提交/推送）宿主由审查面板承担，不重复列。
  - 显示策略菜单补全 panel/mini 两项——上游菜单只挂了 auto 一项（键与 handler 都在，上游缺陷），照抄会得到单选项目单。
  - HoverCard → motion Popover `trigger="hover"`（Todo 折叠组预览）；宿主无 HoverCard。
  - 工作流 / 目标 / 会话计划三分区不移植（pi 无这些概念，engine-gaps G3/G4；上游本就是无数据返回 null）。2026-10-16 旧口径的「占位分区 + 标注缺数据」按本轮"直接用zcode的"撤销。
- variant 持久化 = localStorage `mirach:status-panel-variant`。

### ③ 文件夹位置选项（ProjectComposerMenu 的宿主适配）

文件：`panes/hermes-sidebar/workspace-composer-menu.tsx`，挂 composer-wired 的 ComposerBar **上方卡外一行**（用户纠偏："选择文件夹在输入框的上面啊，怎么跑输入框里面了"；上游 v4 的 contextHeader 在 surface 内，宿主按用户口径放卡外）。

- **只在新建任务态显示**：activeId === null（New Chat/启动无会话/删除活动会话），有会话即卸载（empty:hidden 外壳零占位）。
- 菜单（motion ContextMenu，side=top）= 搜索框 + 最近工作区（sessionCatalog entries 的 distinct cwd，最近使用在前，截 8）+「选择文件夹…」（@tauri-apps/plugin-dialog，与文件树窗格同款）。上游的项目实体/远程设备/创建项目对话框宿主没有，不列假入口。
- **选择即建会话**：sessionWorkspaceStore.requestCreate(cwd) → runtime 执行器 pi_new_session。必须首条消息前建——pi 懒创建会话用进程默认 cwd，pendingCwd 不参与。
- 搜索框包 onKeyDown stopPropagation——菜单 typeahead 会截走单字符键（上游 command-input-wrapper 同款手法）。

### 二轮纠偏（2026-11-01 同日）：三处布局

1. **launcher 竖位**（"打开页没有标签了怎么整体往上移了"）：条隐藏后内容顶到了
   卡顶。修 = `.dv-content-container:has([data-slot='open-page'])` 补
   `padding-top: var(--logo-strip-h)`（75 顶带下方，与左栏内容线齐——实测
   launcher 标题顶 108 ≈ 新建会话按钮顶 107）。
   **`:has()` 里不能再嵌 `:has()`**——`:has(> x:has(y))` 是非法选择器，
   整条被静默丢弃（style 标签里有文本但 cssRules 无此规则，实测定位）。
   判据改挂内容上（open-page 在场 = launcher 态；同组非活动面板会卸载，
   实签在场时元素不存在）。
2. **状态面板避顶带**（"高度也应该避开顶栏"）：宿主列头（ChatTabLabel，75）
   做在 thread pane 里，上游 conversation 容器不含头部——wrapper 从
   `top-0` 改 `top-[var(--logo-strip-h)]`（实测 panelTop 100 > bandBottom 85）。
3. **新建任务一排**（"选择文件夹和压缩会话应该在一排，压缩在选择文件夹后面
   不是上面"）：chip 从 composer-wired 内部挪到 thread.aui.tsx 的 viewport
   footer，与 SessionMaintenanceBar（压缩上下文/撤销/重做）同排
   （`aui_composer-side-row`，flex-wrap；维护条根从 w-full 改 min-w-0
   flex-1 让位）。顺序 = [选择文件夹][压缩上下文][撤销][重做]。

### 三轮补充（2026-11-01 同日）：对话区让位 + 模式切换钮

1. **对话区让位**（"活动状态面板在一定宽度的时候不是能把对话区往左挤吗"）：
   ZCode conversationLayout 的 `-translate-x-42`（168px）移植——面板以面板形态
   在场时，对话内容列在容器 ≥1280 整体左移（`@min-[1280px]/thread:
   -translate-x-42` + transition），收胶囊/卸载即回位。载体 =
   `status-panel-store.ts`（override + visible；面板组件写 visible，内容列读；
   宽度条件由 CSS 容器查询承担，React 不翻译容器宽——上游同纪律）。scoped
   分栏无面板不让位。实测 translate -157.5px（根字号 15px）。
   **注意**：TW4 的 translate 工具类走 CSS `translate` 属性，不是
   `transform`——CDP 验证读 `.transform` 会得假"none"。

2. **模式切换钮**（"输入框的加号右边加个zcode的切换模式按钮，计划模式，
   文件内修改，完全访问"）：composer 工具行 "+" 右侧（ZCode
   V4ComposerModeSwitch 同位）。**三态全部映射 pi 原生能力，零自创语义**：
   - 计划模式 = pi plan gate（plan.rs：Planning 态工具执行器拒绝
     变更/进程类工具；模型 submit_plan 提交、宿主批准/驳回——
     `enter_plan_mode`/`approve_plan_review`/`reject_plan_review`/
     `exit_plan_mode`）；
   - 文件内修改 = `ApprovalMode::Write`（写文件自动批、其余照问）；
   - 完全访问 = `ApprovalMode::Yolo`（硬策略闸/双确认类除外）；
   - 默认 = AlwaysAsk（变更前确认）。yolo 切换保留确认步
     （ZCode useYoloModeConfirmation 同款）。
   数据面：`EngineShared.approval: Arc<ApprovalState>` 进程级共享 →
   `SessionOptions.approval_state` 挂同一份（`set_mode` 即时生效于运行中
   会话）；审批卡经 pi `approval_handler_via_ask` 自动桥到 ask 面 = 宿主
   现有 AskCards，零新卡通道。IPC：`pi_mode_state`（快照 + planPending）、
   `pi_set_approval_mode`（未知值 Err 不猜；会话在场落 `approval_mode`
   审计条目——上游 CLI `/approval` 同款）、`pi_set_plan_mode`、
   `pi_decide_plan`（无待审计划 Err）。
   前端：`mode-store.ts`（状态 + 动作；错误可见不吞）+ `mode-switch.tsx`
   （触发钮 = 模式图标+名+ChevronDown，yolo 警示色；菜单 = 计划独立勾选
   [Lightbulb] + 权限单选组——ZCode 菜单结构同款）+ `PlanReviewCard`
   （thread 消息区顶，计划模式期间轮询 planPending 2s；批准/驳回）。
   实测：三态 IPC 回读 ✓、非法值 Err ✓、planning 开/关 ✓、无计划裁决
   Err ✓、菜单渲染截图对齐（Lightbulb + 单选点 + yolo 警示盾）。
   **mode_state 无会话时返回默认值不报错**（composer 在 New Chat 态也要
   显示）——有意为之，不是兜底：模式是进程级偏好，不依赖会话。

**2026-11-23 模式芯片重做：只要「计划模式 / 完全访问」，且会话级**
（用户："只要计划模式和完全访问，要会话级别的，完整移"）。上面 11-01 的
三态/进程级语义作废：

- **完全访问 = 会话级 pin**。引擎 `approval_gate` 新增
  `set_session_mode` / `session_mode` / `clear_session_mode`（按会话 id 的
  HashMap；进程 `MODE` 只作未 pin 时的 fallback）；`evaluate` 先解析当前
  harness 的 session id 再查模式。宿主 `approval_modes.rs` 持久化
  `<agent_dir>/approval-modes.json`（会话 id → always-ask/write/yolo；
  **planning 不落盘**——插件重启后不恢复 active，落盘会留下假计划态），
  `install_live` 时恢复。主会话创建（lazy / 选文件夹 / open）默认
  **pin always-ask**；New Chat 里选的 full access 暂存 pending，第一份主
  会话创建时消费并落盘。IPC 增加 `sessionId`：
  `pi_mode_state({sessionId?})` / `pi_set_approval_mode({mode, sessionId?})`。
  **前端不再恢复 `mirach:approval-mode` localStorage**（已删）。
- **计划模式 = 每个会话一个插件实例**。`rpi_plan_mode` 把 active /
  previous_tools 存在模块级 static，且 SDK 的 RUNTIME 是 OnceLock——同路径
  多会话 LoadLibrary 会共享同一份状态（实测 A 开计划、B 也 planning；
  后开会话的 `/plan` 改的是第一个会话的工具集）。引擎 `rpi-extensions`
  loader 对 `rpi_plan_mode.dll` 做 **per-session 临时副本**再加载
  （`%TEMP%/mirach-plugin-instances/`；Windows 不同路径 = 独立模块实例/
  独立 static）。其它插件不受影响。实测 A planning / B off / 回 A
  planning；full access 同样 A yolo / B ask / 回 A yolo。
- **计划入口/退出 = `pi_set_plan_mode({enabled, sessionId?})`**（宿主
  `set_plan_mode_for`）：按会话找主柄/窗格 harness，在该会话自己的扩展
  实例上执行 `/plan start|exit`。计划期间审批 pin 设 **`ApprovalMode::Planning`**
  （不是 yolo）：插件收窄工具目录是 run 开始时快照，**对话进行中切计划**
  时目录要下一轮才换；Planning gate 在 `before_tool_call` 层确定性拦截
  write/edit 等变更工具（read/bash/powershell/docs/plan_mode_complete 放行），
  当前 run 立即生效。退出回 always-ask。New Chat（无会话）把选择暂存
  pending，第一份主会话创建后消费并执行 `/plan start` + Planning。窗格计划
  态也走同一入口（审批卡不渲染，但计划插件只放行非变更工具）。
  `mode_state` 每 2s 轮询时对账插件态与 pin（`plan_mode_complete` 自行退出
  → 回 always-ask；计划态恢复但 pin 丢失 → 补 Planning），**对账只改内存**。
  `Planning` 只能经受 `pi_set_plan_mode` 设置，`pi_set_approval_mode('planning')`
  报错（避免 gate 与插件半态）。**计划态不跨进程重启**（重启后插件
  active=false，实测；只有 full access 进 `approval-modes.json`）。
- **UI**：`permission-mode-chip.tsx` 只剩两项——计划模式、完全访问（都是
  会话级）；完全访问走 `ConfirmDialog` + “我已了解风险”勾选（`ConfirmDialog`
  新增 `confirmDisabled`）。互斥：进计划先退 full access；开 full access
  先退计划。两者都关 = 默认逐次确认。2s 轻轮询兜 `plan_mode_complete`
  自行退出与外部切换。
- **诊断面 `pi_active_tools({sessionId?})`**：直接读指定会话 harness 的
  active tools（`AgentLane::get_active_tools`）。实测 A 计划态 =
  `read/bash/docs/plan_mode_complete`（4 个），同时 B = 50 个且含 write；
  回 A 仍 4 个，退出计划恢复 write。证明 per-session 插件副本 + 工具集
  隔离都是真的。
- **并列窗格**：审批卡只在前台渲染，宿主拒绝把窗格会话切到会等待审批的
  档位（保持全访问），错误可见——不让工具调用等一个永不出现在卡。
- **引擎本地补丁（同步上游要重放）**：`crates/rpi-cli/src/approval_gate.rs`
  （per-session mode map）与 `crates/rpi-extensions/src/loader.rs`
  （`rpi_plan_mode` per-session copy）。两者都在 `G:\pi-rust-main`，非宿主
  仓库；上游升级时按本地补丁层重放，不要丢。
- **计划审阅卡仍无**：rpi-plan-mode 的 `plan_mode_complete` 是存盘即退出，
  没有 dsh 的 exit_plan_mode 审批闸；本轮不造 pending 卡。


### 五轮修复（2026-11-01 同日）：持久化协议破坏 + 让位连带 + 上下文按钮

1. **会话列表/状态面板消失的根因（我造成的事故，勿重蹈）**：`set_approval_mode`
   的审计条目落盘直接对 store 调 `Session::save()`——绕过 pi 的 generation
   协议，把 append 句柄打进坏态，此后**所有 flush 永败 `os error 1`**
   （ERROR_INVALID_FUNCTION），`pi_list_sessions`（先 flush）全挂 → 侧栏
   行清空 + 面板 hasContent 落空。修复 = 条目只 append，落盘走引擎统一
   通道 `session_mut().save_and_index()`（flush_active_session 同款）。
   **教训：SDK 会话的持久化只有 save_and_index / persist_session 两个口，
   任何"就地 save"都是协议破坏。** 磁盘文件完好（损坏只在内存句柄态），
   重启即恢复。
2. **分组折叠是第二处"不见"**：`session-meta.json` 的 groupsCollapsed
   recent+pinned 均为 true（侧栏选项菜单的「折叠全部分组」或段头点击的
   合法结果）→ 行被 buildSessionDisplay 整行滤掉。展开走真实 UI（点段头）。
   诊断时踩的假线索：refreshThreads 实际成功（日志行数 4），别再沿
   list 链排查。
3. **宽度手柄跟列走**：手柄锚 `calc(50% + 列宽/2)`，内容列 translate 后
   脱节——WidthHandle 加 `shifted` prop 挂同款 translate 类。
4. **模式钮贴加号**：ComposerToolbar 是 justify-between，第二个子元素被
   推到行中——附件钮与模式钮包成一个左组。
5. **上下文明细按钮**（用户："模型选择的左边加个上下文的按钮，和zcode
   一样的，用assistant-ui的Context breakdown"）：`ContextDisplay.Button`
   新 preset（base 层 + aui 接线），点击弹明细卡（getContextSegments：
   Input/Cached/Output/Reasoning + %full 进度条）；挂模型选择器左侧，
   右侧原 Ring 撤下（同一信息第二个入口是噪声）。渲染门槛最终版（次日定稿"一个圆圈图标就行"）：**按钮 = 仅一枚圆环图标**
   （size-8 圆形钮，环填充度 = 占用；无用量即空环 + 弹层说明"暂无用量
   记录"），不放文字。窗口缺失（模型目录无条目）仍不渲染。0.15.22
   包内无 "Context breakdown" 组件（registry 也 404）——从宿主既有
   ContextDisplay 扩展，不是照抄上游。

### 对话显示流程对比（2026-11-02）：ZCode v4 链 vs 宿主 thread.aui

探查源 = packages/ui/src/v4（SessionPane / ConversationTimeline /
ConversationComposer / conversationLayout / ConversationTurnGroup）+
docs/chat/*。逐项对比结论：

**已修的三处位置错误**：

1. **让位断点**：此前只移植了 WIDE_OFFSET（≥1280 让位）——面板被钉死成
   panel 形态时，**窄窗（<1280）不让位，面板直接盖住用户气泡**（实测
   "1 #2" 的气泡被盖半截）。ZCode 是双类：INLINE_OFFSET（无断点，钉死
   形态恒让位）+ WIDE_OFFSET（auto 形态仅宽屏）。修复 = 让位按
   `statusPanelShift` 三态：panel 恒让位 / auto 仅宽屏 / mini 不让位
   （换顶部余隙）。
2. **让位是「收窄 + 左移」两步，不是只左移**（2026-11-02，用户："对话区
   怎么靠左边了，间距也没有了"）。ZCode `conversationLayout.ts` 同时给
   宽度类（`w-[calc(100%-24rem)] max-w-6xl`）和位移类（`-translate-x-42`）。
   宿主此前只做了位移：852px 居中块左推 157.5px 后右缘到 1148，而面板
   左缘 1135 —— **内容压在面板上**，左边距同时被吃成负数（实测内容列
   x=293 < 视口 310），右侧空出 300px 而面板只占 300px。
   现在两个量都提成 CSS 变量挂在 `.aui-thread-root[data-status-panel-shift]`
   上，**内容列与宽度手柄共用同一来源**：
   `--dsh-column-width`（`min(内容宽, 100% - 24rem)`）、
   `--dsh-panel-offset`（`10.5rem`）、`--dsh-column-left/right`、
   `--dsh-panel-width`（21rem = w-80 + right-4）。
   **位移必须写 `10.5rem` 不是 `168px`**：后者按 16px 根字号算，宿主根
   字号是 15px，比例偏了会把左边距压到 12px（实测）。
   手柄宽度 `clamp(0px, 余量 - 48px, 40px)`：面板让位后两侧余量不足
   88px 时如实归零，不硬塞到面板上。
3. **顶部余隙**（ZCode pt-14 同语义，conversationLayout.ts:14-19）：胶囊
   形态（mini，或 auto 在 <1280）下面板挂在列右上角（mini 底边 ~50px），
   首条内容的顶部要给它留高度。修复 = 内容列 `pt-20`（80px > 胶囊底边
   50px）：auto 走 `@max-[1279px]/thread:pt-20`（宽屏有横向让位不需要），
   mini 恒 `pt-20`；panel 钉死形态靠横向让位，不加。判定用
   statusPanelStore 的 `mounted`（面板组件在场，含 mini——原 `visible`
   对 mini 是 false，判定错了）。
   **让位还必须以 `mounted` 为前提**：override 只是显示模式偏好，草稿态
   / 无内容时面板根本不渲染，只看 override 会把整列白推 157.5px。

**对比后确认不需要动的（有意差异或已对齐）**：

- **composer 位置**：ZCode dock 在滚动容器内 sticky bottom-0，与消息列
  共享 content-width 类和让位偏移——宿主 ViewportFooter 同构（sticky、
  在位移列内）✓。
- **思考指示**：ZCode 在运行中的 turn 尾部（TurnChatLoadingSlot：像素
  动画 + label + 计时器）；宿主在 composer 上方（thinking-indicator 元素
  + 消息内三点 bounce 共存）。位置不同但宿主是定稿选择（"用户视线处"），
  且消息内已有 in-turn 指示器兜底——不动。
- **时间分隔线**：ZCode v4 无日期分隔行（时间内联在 assistant actions
  行）；宿主有 DaySeparatorRow + MessageTimeLabel 双轨——宿主既有定稿，
  不动。
- **turn 间距**：ZCode pt-14+pb-5（76px/turn）；宿主 gap-y-6（24px）+
  消息内 -mb-7.5/pb-7.5 结构——节奏不同但为宿主既有定稿。
- **滚动语义**：ZCode 的 following/back-to-bottom/scroll-memory 状态机
  与宿主 thread-scroll-store 同构（48px 底部容差 vs 宿主类似实现）✓。

**可复用的常量参考**（若后续对齐节奏）：面板顶隙 pt-14（56px）、turn 间
距 76px、工作组 gap-4、dock padding px-2 pb-4、底部容差 48px、掩膜
fade 24px/transparent 96px。

### 事故时间线备忘（同日会话消失）

模式切换验证轮：`inner.save()` 破坏协议 → flush 永败 → list_sessions 挂
→ 侧栏空。重启（mode 二进制）后引擎 fresh、list 恢复，但用户在此期间已
经历"列表空"。再叠加分组折叠态，用户看到"会话+面板全没了"。两条线索都
要修：协议修复（代码）+ 分组展开（UI 操作，可复现、合法态）。

### 验证（CDP，scripts/cdp-zcode-port-audit.mjs）

面板栏生命周期断言组：panels 集合 / colflags 的 panelsHidden / launcher 条 display。实机已验：①launcher 空态宽 300 + 条 display:none ②实签在场条可见、锚已撤 ③末签关闭 → panelsHidden:true、组消失 ④右键重开 → 锚重建、无标签条。状态面板与 chip 各有截图比对。

## 消息显示链路（2026-11-02 对照 ZCode v4 全链路修正）

用户："不止这三块，ass上百个消息组件，能不能和 zcode 对比一下，现在消息
显示的有问题。"对照 ZCode `ConversationRowView.tsx` /
`conversationAssistantWorkItems.ts` / `ai-elements/reasoning.tsx` /
`ToolCallBlocks/QueuedSummaryContent.tsx` 后改的五处，以及**确认为有意
差异、不要"修"的六处**。

### 五处修正

1. **思考折叠态 = 单行流式摘要**（ZCode `reasoning-streaming-auto-collapse.md`）。
   触发器三形态：流式收起 = `正在思考 · <最后一条非空行>`（shimmer）；
   完成 = `思考 · 持续了 N 秒`（SSR/无计时 = `持续了几秒`）；流式且无内容
   = **整块不渲染**（交给底部「正在思考」指示器，不留空行）。
   摘要按**换行边界**派生（`resolveReasoningStreamingSummary`），行号当
   动画 key：同行新 token 原位刷新，出现新非空行才纵向翻滚；视口横向溢出
   时挂 16px 双侧 mask 并滚到末尾，未溢出**不挂 mask**。滚动节奏 =
   `QueuedSummaryContent`（300ms 动画 + 500ms 停留，最多两条待播，timer
   迟到 >250ms 直接收敛到最新——逐字移植 ZCode 同名组件）。
   **流式期间默认收起**（原实现 `streaming || initialOpen` 会把整段思考铺开，
   这是"消息显示有问题"的观感主因）。

2. **历史思考块此前被丢弃**（真 bug，`pi-hydrate.ts`）。水合只映射
   text/image/toolCall，`thinking` 直接跳过——**只有实时流式才看得到思考，
   历史会话里整块消失**。修法 = `blk.type === 'thinking'` 且 `blk.thinking`
   非空 → TurnPart thinking → `convertTurnMessage` 的 reasoning 部件。
   `redacted_thinking` 无正文，不造假文本（console.error 可见）。
   实机验证：打开含 thinking+toolCall 的历史会话，4 处折叠态
   `思考 · 持续了几秒` 正确出现。

3. **工具按族聚合**（ZCode Explore / Execute / Changes 三组，
   `lib/exploreToolCall.ts` 逐条照抄到 `assistant-ui/tool-grouping.ts`）：
   只读（read/ls/grep/find/ast_grep/lsp/web_search + 只读 shell）→ `查阅`；
   非只读 shell → `终端`；写文件（write/edit/hashline_edit/ast_edit）→
   `更改`。**其余工具不聚合**（ZCode 只合成这三族，todo/agent/ask 各自
   独立一行）——分组路径直接挂 `group-chainOfThought`。
   **单个子项不成父组**（ZCode 三处 builder 都有 `length === 1 → 保持原始
   工具行`）：渲染层 `part.indices.length === 1` 直接摊平。
   父组摘要契约（`buildFamilySummary`，纯函数 + 单测）：进行中 = 最新子项
   动作/命令/文件；完成 = `N 个命令`（+`, M 个失败`）/ `2 次搜索，1 个文件`
   / `N 个文件`。**子项失败不把父级标成失败**（父级是阶段容器）。

4. **删除重复的工具渲染**：`RunToolTimeline`（run 级聚合时间线）与
   GroupedParts 的族组渲染的是**同一批工具调用**——已整块删除
   （`elements/tool-timeline.tsx` 随之无消费方，文件保留）。

5. **assistant 操作条补 fork + 时间**（ZCode
   `ConversationAssistantTextActions` 顺序：复制 → 赞 → 踩 → 分叉 → 时间）：
   分叉 = 本轮最后一条 user 消息的 fork 点开新会话
   （`branchBridge.requestFork`），fork 点未落盘时按钮禁用（不假装可点）；
   时间移到条尾（原在条首且 `mr-auto`，视觉上被推到另一端）。宿主额外
   保留 `RegenerateMenu` / `ExportMarkdown`（ZCode 产品面没有 retry 与 `…`，
   但宿主已有落地）。

6. **空 assistant 消息整条不渲染**（2026-11-02，用户："发送一条消息，ai
   没回复，下面还是有一串按钮，而且是乱的"）。`RUN_STARTED` 会**无条件**
   push 一条 `content: ''` 的 assistant 消息占位（`turn-actor.ts` 的
   reduce）；run 直接失败时（`SESSION_PERSISTENCE_FAILED` / provider 401）
   它永远拿不到内容，却仍占一整条气泡高度 + 渲染复制/赞踩/分叉/重试
   六枚钮。修法 = `ThreadMessage` 里 `role === 'assistant' && parts.length
   === 0` 直接 `return null`，footer 再用 `AuiIf(parts.length > 0)` 兜一道。
   ZCode 同判：`latestAssistantTextRow?.state === "complete" &&
   assistantCopyText !== undefined`（没有正文就没有操作条）。
   **不要**改成"给空消息填占位文本"——那是造假。

### 用户消息操作条的位置（2026-11-02）

ZCode `ConversationRowView.tsx:1300`：user row 是 `flex flex-col
items-end`，`MessageActions` 作为普通子元素排在气泡**之后**，即
**气泡下方、右对齐、横向一排、悬停才显示**。

宿主旧实现是 `absolute start-0 top-1/2 -translate-x-full
-translate-y-1/2` + `flex flex-col`——气泡**左侧垂直居中**且**竖排**，
鼠标要移到气泡左边才找得到。三处一起改：

| 项 | 旧 | 新 |
|---|---|---|
| 位置 | 气泡左侧 absolute | `col-start-2 mt-1 flex justify-end`（气泡下方） |
| 排布 | `flex flex-col items-end` | `flex items-center gap-1` |
| 显隐 | `autohide="not-last"`（最后一条常显） | `autohide="always"`（一律悬停） |

实测：气泡 bottom=275 → 操作条 top=285（下方 11px），右缘差 0。

### 确认为有意差异、不要改的六处
| 面 | ZCode | 宿主 | 为什么不改 |
|---|---|---|---|
| 思考指示位置 | turn 尾部 TurnChatLoadingSlot | composer 上方 + 消息内三点 | 宿主既有定稿（"用户视线处"） |
| 日期分隔行 | v4 无（时间内联） | DaySeparatorRow + MessageTimeLabel | 宿主既有定稿 |
| turn 间距 | pt-14+pb-5（76px） | gap-y-6（24px）+ 消息内负边距 | 宿主既有节奏 |
| 工具卡状态字 | 仅失败时显示 | 通用卡带 Check 图标 | 宿主 tool-call 元素既有形态 |
| 消息级 status badge | 无 | 无（已确认一致） | — |
| `…` 菜单 | 无 | ExportMarkdown | 宿主唯一导出入口，保留 |

### 分组器（2026-11-07 改版后）

- **消息渲染不再走 `MessagePrimitive.GroupedParts`**：改用
  `assistant-work-items.ts`（ZCode 扫描）+ `work-parts.aui.tsx`（渲染器）。
  旧「groupBy 指纹 / GROUPBY_MEMO_KEY symbol」机制随之退役——那是
  GroupedParts 的 memo 依赖要求，新渲染器用 `useAuiState(s.message.parts)`
  直订阅（parts 引用即变化信号，turn-actor 的 stabilizeMessages 保证
  未变时不换引用）。
- **standalone 判定不再需要**：扫描按部件类型直接分流，MCP app / 注册
  UI 的工具照常经 `ToolLeaf` 的 toolUIs 解析渲染（与官方 ToolUIDisplay
  同源），不会因为不进族组而丢渲染。
- **族分类与父组摘要**仍在 `tool-grouping.ts`
  （`classifyToolFamily` / `buildFamilySummary`，测试保留）；分组语义
  （跨隐藏思考合族 / 单子项摊平 / 可见思考断组）锁在
  `assistant-work-items.test.ts`（18 条）。

### 执行摘要意图描述 + 查阅/执行分布（2026-11-19 定稿）

1. **执行摘要行显示意图描述（取代 11-15 的中文过滤）**：ZCode
   `execute.tsx:274-278` 摘要 = `description ?? command`（只对 Bash 读
   description）。rpi 的 bash（bash.rs:49）/ powershell 参数**都有**
   `description` 且模型实测在传（一天 35 条，英文为主）——`tool-renderers.aui.tsx`
   的 `isChineseText` 过滤（11-15 用户"摘要能变中文吗"后加）已**删除**：
   英文描述原样显示，与 ZCode 完全一致（用户 2026-11-19 拍板"对齐 ZCode：
   显示意图描述"）。**别再把语言过滤加回来。**
2. **「怎么没有查阅只有执行」不是显示 bug**：分类链全对（agui 透传 →
   classifySummaryCategory），实机验证 read 调用时组头出现「已查阅 N 项」。
   根因 = 模型探查重度走 powershell/bash（max 会话 75 powershell vs 7 read），
   而现 ZCode 也是 Bash→shell→执行（`tool-identity.ts` + e2e 断言
   "Explored 2 items, Ran 2 commands"），旧「只读 shell→查阅」口径在现
   ZCode 已删；用户拍板**保持与现 ZCode 一致不改**。
3. **ZCode 的工具选择引导 = 工具描述即路由提示词**（`apps/zcode-cli/.../
   bash-prompt.ts`）：Bash 描述写明 "IMPORTANT: Avoid … cat/head/tail/
   grep/sed/awk/echo … use the appropriate dedicated tool"，Read 描述自荐
   （cat -n / 图片 / offset 分页 / 别复读刚编辑的文件）。**2026-11-19 已完整
   复制到引擎（用户拍板"这个能完整复制吗"→ 实施）**，两层：
   ① **注册层（真正的根因）**：`rpi-cli/src/session.rs` 内建表原本只有
   read/bash/edit/write/docs（+Windows powershell）——**grep/find/ls 根本没
   注册给模型**，模型想搜文件只能 shell，"查阅"无从谈起。已注册三工具
   （`with_replay(ToolReplay::Safe)`，只读）+ `BUILTIN_TOOL_NAMES` 扩为
   8 项（`builtin_tool_snippet` 里上游早已备好三工具的提示词条目）+
   两个断言旧集合的测试改为新集合（`default_prompt_mentions_cwd_and_tools` /
   `default_tools_include_docs_lookup`）。宿主 capabilities 页
   （pi_capabilities.rs 用 BUILTIN_TOOL_NAMES）自动变真。
   ② **描述层**：bash 加 ZCode 同款 IMPORTANT avoid 行（read/grep/find/ls/
   edit/write 为专用工具）；powershell 纠偏——原 "Prefer bash for file/text
   work"（把文件工作推向 bash）改为指向专用工具；read 加自荐（prefer over
   cat/Get-Content、按需 offset、别复读刚编辑的文件——**没有 cat -n 行号线，
   不照抄 ZCode 那句**）；grep/find/ls 各加一句 prefer-over-shell。
   **补丁位置 = G:\pi-rust-main（引擎真源，路径依赖、非 git）**——上游同步
   新版时这两个补丁层要重打（session.rs 注册块 + BUILTIN_TOOL_NAMES + 两测、
   rpi-tools 六个描述）。验证：cargo check 0 错 / 引擎 system_prompt_compat
   7 过 + session::tests 61 过 / 宿主 cargo test 708 过。
4. 次要已知差异（未修）：展开正文卡内距/底色（ZCode `px-4 py-3 bg-panel`
   vs 宿主 `px-3 py-2.5 bg-muted/20`）、运行态类别词动画（`animated-gradient-text`
   vs `shimmer`）。

### 顺带发现的引擎缺陷（未修，非本次范围）

**打开 `2026-10-24T16-09-39.590Z_f0e71fcf.jsonl`（15KB，含 thinking+toolCall）
之后，pi 的 flush 永久失败**（`SESSION_PERSISTENCE_FAILED: os error 1`），
`pi_list_sessions` / `pi_get_fork_points` 随之全挂；重启即恢复，且**同一
进程里换成其他会话文件也不恢复**（句柄已被毒住）。已 bisect 确认：
`baseline ok → open 小会话 ok → open 该文件 → 永久失败`。与前端改动无关，
下次动 `pi_session.rs` 的 open 路径时要查。
**2026-11-03 补充**：把该文件**复制**成另一个文件名再打开同样触发——
毒化与文件**内容**相关，与路径无关。验证会话层改动时别用它当夹具。

## 轮（turn）层（2026-11-03，ZCode `ConversationTurnRenderUnit` 投影）

用户裁定"全部对齐"后的第一刀：宿主从扁平消息列表升级为**轮结构**。
ZCode 的轮边界来自协议 `row.turnId`（CLI 权威）；宿主没有这个字段，等价
推导 = **一条 user 消息开启一轮**（`turn-units.ts::groupMessagesIntoTurns`，
11 条单测）。

### 三件已落地的能力

1. **轮容器**（`thread.aui.tsx::MessageTurnList`）：`<div data-slot="aui_turn"
   data-turn-key …>` 替换扁平 `<ThreadPrimitive.Messages>`。消息仍逐条渲染
   （`ThreadPrimitive.Unstable_MessageById` 按 id 挂载——官方为自定义列表/
   虚拟滚动准备的口子），外面包轮。**间距不变**（轮内轮间都 `gap-y-6`，
   ZCode 的 pt-14+pb-5 仍是有意差异）。
2. **轮级操作条**（`isLastContentAssistantOfTurn`）：一个 turn 里的多条
   assistant 消息（工具调用前后各一段文本）此前**每条都挂**复制/赞踩/分叉/
   重试；现在只有「本轮最后一条有正文的 assistant」挂（ZCode
   `hideAssistantActions={!item.latest}` 同款）。实机验证：4 条 assistant
   只有第 4 条出操作条。footer 上留了 `data-turn-tail` / `data-has-parts`
   两个语义属性（测试/排查钩子）。
3. **时间线标记**（模型切换/压缩分隔线）：pi 会话条目里的
   `SessionEntry::ModelChange` / `Compaction` 此前完全不可见（`pi_get_messages`
   只投影 message）。新增后端 `pi_get_timeline_markers`（`PiEngine::
   timeline_markers`）沿当前分支扫条目，输出 `[{kind, beforeMessageIndex,
   provider?, modelId?}]`；前端 `timeline-marker-store`（zustand 桥）+
   `elements/timeline-marker.tsx`（ZCode `MarkerDividerRow` 的两侧细线 +
   居中图标文案形态）按 `beforeMessageIndex` 分桶插进消息流。刷新时机 =
   水合 / 切会话 / **run 收尾**（模型切换与自动压缩都发生在轮之间）。

### 三个必须点（都是实机踩出来的）

- **`beforeMessageIndex` 的计数口径必须与前端 hydrate 同一**：只数
  `role == user | assistant` 的条目。`toolResult` 被前端**并进前一条
  assistant 的部件**，`custom` / `bash_execution` 前端直接跳过——按"全部
  message 条目"计数会系统性偏大，尾部标记永远挂不上（实测：
  11 条条目 vs 5 条投影）。
- **桥的 `sessionId` 守卫必须先登记再发请求**：`refresh()` 若等响应回来才
  写 `sessionId`，首次调用时 store 里还是 null，`get().sessionId !==
  sessionId` 守卫会把自己这次的合法响应丢掉——分隔线永远不出现（实测踩中）。
- **`beforeMessageIndex === ids.length` 的标记挂在列表末尾**（最后一轮收尾
  后的模型切换，为下一轮准备）——不渲染就是静默丢真数据。

### ZCode 有、宿主有意不做的 marker

`goalVerify`（无 goal 引擎）、`forkNotice`/`forkCreated`（fork 谱系走
SessionLineBar，不重复）、`retryNotice`/`checkpointRestored`（ZCode 自己也
不渲染，`default: return null`）。**不渲染空壳。**

## 阶段 2：轮尾文件汇总 + 工作段折叠（2026-11-03）

### 轮尾文件变更汇总（`turn-file-changes.ts` + `elements/turn-file-summary.tsx`）

数据 = 本 turn 的 tool-call 部件**现场聚合**（`edit`/`hashline_edit` 从
`details.diff` 取真值；`write` 无 diff → 行数 `null` **不造 0**）。挂点 =
轮尾 assistant 消息的操作条**之前**（ZCode 明确排序：summary 在 bar 前）。
ZCode 的撤销按钮不渲染——pi 无文件级回滚面，不放假按钮。
实机验证：`2 个文件已更改 +3 -2`，同文件两次 edit 正确累加。

- **selector 必须返回原始值**：组件里用「工具签名串」（toolName + 状态 +
  结果是否落地）做订阅，部件数组在 `useMemo` 里经 `getState()` 现取——
  selector 返回新数组 = `getSnapshot` 不缓存 = 无限重渲染（AGENTS.md
  tap 0.9.18 同款教训）。
- useAuiState 的 selector 里**不要 `Array.prototype.map`**（每帧全量分配），
  传 MessageState 数组走结构兼容即可。

### 工作段折叠（`work-segment.ts` 纯函数 + `elements/work-segment.aui.tsx`）

ZCode `ConversationWorkSegmentFlow` / `AssistantHistoryStatus` 的语义：
中间工作折叠成「已工作 N 秒」，正文在外。**宿主的 `group-chainOfThought`
分组就是工作段**（reasoning + 工具全挂它下面，text 不分组）——折叠它
即可，不需要复刻 `buildGroupTree`（非导出，禁止）。

| 状态 | 头部 | 默认 |
|---|---|---|
| running | **不渲染**（反馈在轮尾 loading 位） | 恒开、不可收 |
| completed 有计时 | `已工作 N 秒` | 收起 |
| completed 无计时（纯思考段） | `已处理` | 收起 |
| interrupted | `已停止` | 收起 |
| 段后无正文（本轮再无 assistant 文本） | — | **展开**（折叠区不能空着） |

时长来源 = tool-call 的宿主计时（`convertTurnMessage` 写入的
`timing{startedAt,completedAt}`），区间 = min(start) → max(end)。
纯思考段无计时 → 无时长 → 「已处理」，**不造「0 秒」**。

### 顺带修掉的投影缺陷：toolResult 两条路径形状不一致（2026-11-03）

`ToolExecutionEnd.result` 是完整 `ToolOutput` 对象 `{content, details?,
isError}`（agent.rs:1428 + agui.rs:318 原样透传）——**流式路径**一直是
对象；**水合路径**（`pi-hydrate.ts`）却把 content 拼成纯文本字符串，
`details` 丢失。后果：历史会话里 edit 的 diff 卡片退回通用卡、
`planReviewState`（读 `result.details`）失效、文件汇总拿不到行数。
修法 = 水合同样构造对象形状；`toolResultText` 兼容两种形状（字符串是旧
投影残留）。**下游所有 result 消费点都要过一遍**：bash 快速路径的
`typeof result === "string"` 判断已扩成三形状。

## 阶段 3：轮导航器（2026-11-03）

`turn-navigator.ts`（纯函数，10 条单测）+ `elements/turn-navigator.aui.tsx`：
对话区左缘竖条 mini-map，一条横杠 = 一次用户 query（只收有 user 的轮，
孤儿 assistant 轮不进目录——ZCode `realUser` 同口径）。悬停出预览浮层
（user 两行 + assistant 三行），点击滚到该轮。

- **bar 视觉判定逐字照抄** ZCode
  `resolveConversationTurnNavigatorBarVisualState`（hover 距离 0/1/2/≥3 →
  opacity 1/0.86/0.72/0.58、scaleX 2.6/1.7/1.25/1）；scroll 活动项
  （视口 40% 线）只在不悬停时提亮（opacity 0.9）——ZCode 的
  `showScrollActiveColor` 同语义。running 轮的最后一条 query 有 0.72
  不透明度下限。
- **显示条件**：容器 `@container thread (min-width: 864px)`（ZCode
  `CONVERSATION_TURN_NAVIGATOR_MIN_WIDTH_PX` 同值）且 ≥2 条 query。
- **与 ZCode 的结构差异（有意）**：ZCode 是虚拟列表，跳转要先挂载目标轮
  （重试 12 帧）；宿主无虚拟化（用户裁定"虚拟滚动先不做"），轮常驻
  DOM，点击直接 `scrollTo`，无重试循环。
- 预览浮层不用 Radix HoverCard（宿主无该封装），组件按 hoveredIndex
  自绘、跟随 hovered 杠的 y 位置。
- 滚动监听 rAF 节流；`measure` 里 `tops` 用 `getBoundingClientRect`
  差值（相对视口），判定线 = `vh.height * 0.4`。

## 阶段 4：框选工具条 / 会话内查找 / 子代理单行（2026-11-03）

三项落地并实机验证（夹具会话：思考与 bash 交错 + subagent 调用）。

### 框选工具条（`conversation-selection.ts` + `elements/selection-toolbar.aui.tsx`）

ZCode `ConversationSelectionTooltip` + `SelectionActionMenu`。守卫/定位/消失
逻辑照抄：单 range、同一消息根内、非排除元素（button/input/composer…）、
非空文本有布局；**无最小长度**，>8000 字只渲染警告；mouseup/touchend 触发
（rAF），collapse/Escape/根内滚动/resize 关闭；portal 到 body、水平对选区
中心、垂直优先上方放不下落下方、`pointerdown` preventDefault 防清选区。
**动作层宿主适配**：ZCode 的「加入任务 / 侧聊询问」依赖它没有的任务系统
与侧聊——宿主换成「复制 / 引用到输入框」（`composer().setText` 追加
`> ` 引用排版，`formatQuoteForComposer` 纯函数）。**不渲染假入口。**

### 会话内查找（`conversation-find.ts` + `elements/conversation-find.aui.tsx`）

Ctrl/Cmd+F（对话区聚焦时）→ 顶部浮层：搜索框 + `n/m` + ↑↓/Enter（Shift
反向）导航 + Esc 关。高亮 = **CSS Custom Highlight API**（不动 DOM——
markdown 子树插 span 会打断 React）：registry 名
`mirach-conversation-find(-active)`，CSS 在 overlays.css（ZCode 同色
#fde68a/#facc15）。**计数/高亮/跳转三者同源 = DOM 实际出现处**（源文本
偏移经 markdown 渲染后对不上，ZCode 的源序号 rebase 方案依赖虚拟列表
锚点，宿主无虚拟化直接 DOM 扫描更诚实）。流式更新 MutationObserver 防抖
重扫。与 ZCode 的裁剪差异：无「变更」scope、无多层缓存（无虚拟化不需要）。
**坑**：`Highlight` 构造器在 **window 全局**，不在 `CSS` 上
（`CSS.highlights` 才是）——实测踩中，构造器取错处注册永远静默失败。

### 子代理单行摘要（`elements/subagent-line.tsx`）

pi 的 `subagent` 工具（subagents.rs:440，输入 `{agent,task}` 单委托或
`tasks[]/chain[]` 多任务）此前走通用卡。现在是 ZCode `agent.tsx` 的单行
形态：bot 图标 + 「子代理」+ agent 名（mono）+ `·` + 任务摘要 + 状态字；
失败态走行内「失败」（ZCode showFailureStatus 同位，不换错误卡——分流
顺序**先于 isError 分支**）。**ZCode 不可展开（详情在它的侧栏子会话面板）；
宿主没有下钻面，展开 = 看工具输出**（唯一详情面，不放假下钻）——这是有
注释的宿主适配，等子会话侧栏落地后再对齐成"单行 + 侧栏"。

### 工具组跨 reasoning 边界——已落地（2026-11-07 专项）

`[思考, bash, 思考, bash]` 同消息序列曾被拆成两个单子项「终端」组各自摊平
（GroupedParts 按相邻路径合并，任何插入部件断组）。ZCode 能跨，是它**默认
只渲染每条消息第一条 reasoning**（`messageStreamShowReasoning=false` →
`messageStreamFirstReasoningRowId`），隐藏行在 `buildAssistantWorkRenderItems`
扫描**前剔除**。本轮照抄该语义，**替换了渲染路径**：

| 文件 | 职责 |
|---|---|
| `assistant-work-items.ts`（18 单测） | 纯扫描：思考可见性 + 工作段划分 + 族组合并 + 单子项/任务判定 |
| `elements/work-parts.aui.tsx` | 渲染器：替换 `MessagePrimitive.GroupedParts` |

扫描规则（每条有 ZCode 出处，详见模块头）：

1. **思考可见性**：`showAllReasoning=false`（ZCode 默认）→ 只有首条
   reasoning 可见，其余**从流中剔除**——不渲染、不断段、不计工作时长。
2. **工作段** = 极大连续工作运行（reasoning+tool），被 standalone 部件
   （text/file/image/data）打断——正文在折叠区外（阶段 2 语义不变）。
3. **族组** = 段内连续**同族** tool-call；被可见 reasoning / 异族 / 任务
   工具打断（ZCode 谓词同款）。隐藏思考**不**打断（已剔除）。
4. **单子项不成父组**（渲染层摊平）；**任务工具优先于族分组**
   （旧 taskAwareGroupBy 同判定，仅提供 TaskGroup 槽位时启用）。
5. 组键锚定首部件下标——流式追加不重挂子树。

**叶子机制与官方逐条对齐**（都是核对 core dist 源码后的结论）：

- 官方每叶子包 `PartByIndexProvider`（`part` 派生 scope）；
  `MarkdownTextPrimitive` 经 `useMessagePartText` 读 **`s.part`**——没
  scope 文本读不到。Provider 不从包根导出，但只用公开 API
  （`AuiConfig`/`Derived`/`AuiProvider`，与 `MessageByIdProvider` 同构），
  `work-parts.aui.tsx::PartScope` 逐行复刻。**实测**：正文 markdown 正常。
- 工具部件的方法挂接（`addResult/resume/respondToApproval`）照抄官方
  `MessagePartChildrenInner`：从 part scope 的 `aui.part` 取——
  `ToolCallMessagePartComponent` 的 props 契约要求它们（漏了 tsc 就红）。
- 注册工具 UI = `s.tools.toolUIs[toolName]?.[0]?.render`；data 渲染器 =
  具名优先、`fallbacks[0]` 兜底、皆无渲染 null。
- indicator = 官方 `shouldShowIndicator('no-text')`：running 且末部件非
  text/reasoning。

**`groupBy` 指纹机制随之退役**：`MESSAGE_GROUP_BY_KEY` /
`GROUPBY_MEMO_KEY` 全局 symbol 挂载 / `taskAwareGroupBy` 已删；
`toolAwareGroupPath` / `FAMILY_GROUP_KEY` / `shouldCollapseSingleChildGroup`
从 `tool-grouping.ts` 删除（族分类 `classifyToolFamily` 与父组摘要
`buildFamilySummary` 仍被渲染器直接消费，测试保留）。旧
`tool-grouping.test.ts` 里锁分组路径的用例随之删除，语义由
`assistant-work-items.test.ts` 接管。

实机验证（夹具 `[思考, bash, 思考, bash, 思考, read, bash, text]`）：
一个「查阅」组**跨两条被剔除的思考**合并 4 个子工具（git status / git log /
read / ls src——全是只读 shell 故归查阅族）；思考行只剩首条
（`思考·持续了几秒`），第 2/3 条文本从 DOM 消失；正文在折叠区外。

## 机器人页完整移植（2026-11-07，hermes plugins/hermes-bots）

用户："机器人页面完整移植……现在是点击mirach切换显示，改成在左侧栏的
右边弹出一个栏显示"。三件事：入口形态改掉、页面照 hermes 全链路重做、
数据面扩到 hermes BotMeta。

### 子页全量对齐（2026-11-10，"所有的子页面一模一样"轮）

用户"还是好多不一样，我想要一模一样的，所有的子页面"。hermes bots 的子页
面逐项补齐（数据面缺失的一律红显占位，不造假数据）：

| 子页 | 数据面 | 落点 |
|---|---|---|
| 工具条 Filters（kind/activity/gateway + 清除，roster-pane-toolbar :152-243） | kind/gateway 真（花名册数据 + pi_connections）；**activity 四项禁用红显**（pi 无会话活动流） | bots-pane FilterItem + Popover |
| 打开屏幕（ScreenPane） | pi 无 gateway 屏幕面 | `hub/bot-subpages.tsx` ScreenStubPane（行菜单真入口 → 红显占位页，不渲染假画面） |
| per-bot 例程（RoutinesPane/cron.tsx） | 宿主 pi_cron 存在但 Job **无 bot 绑定字段** | RoutinesStubPane（红显 + 指向宿主「定时任务」真面）；绑定要动 pi_cron 的 Job 形状，独立一轮 |
| 群聊房间（group-chat-view 67KB） | 本地 log（机器人互发不发生） | bot-group.tsx 结构升级：**成员头像栈**（BotFace 22 重叠）+ 行头头像 + 用户气泡右对齐 + **@提及高亮**（group-mention-text 宿主版，纯正则分段）+ 成员 chips 带 BotFace |
| 编辑对话框技能（skills-hub-picker） | **pi_capabilities 真清单** | bots-dialog 技能多选（字段常在，未装技能如实空态指向 ~/.pi/agent/skills）；`BotPreset.skills` 启动拼进 system prompt（bot-launch composeSystemPrompt——pi 无 per-session 技能注入面，这是真效果不是装饰） |
| 编辑对话框 MCP（mcp-setup） | pi 无 per-bot MCP 面 | 红显占位段 |

**间距度量与 BotsDialog 完整结构（2026-11-10 续3）**。间距全部按 hermes
dialog.tsx 源码值：**body = grid gap-3 p-4**（:247——所有直接子元素 12px 间隔、
16px 内边距）；**标题 = text-[0.9375rem] font-semibold tracking-tight**（:295，
非 text-lg）；描述 = caption 级 tertiary；**header = flex-col gap-1**（:264）；
**footer = flex justify-end gap-2**（:274）；字段 = labeled()（dialog-parts：
grid gap-1.5 + label text-xs font-medium）。实测换算（15px 根字号）：gap 11.25 /
padding 15 / 标题 14.06px w600——全对。SectionNameDialog 尺寸 = **max-w-sm
（384px）**、无描述行、Input 直接放（maxLength 40、autofocus+select、Enter
提交）；CreateGroupChatDialog = max-w-md（448px）。

**BotsDialog = CreateAgentDialog 完整结构**（:723-1148 骨架逐段）：标题+描述 →
主栈 **gap-3.5**（:757）→ BotFace 56 预览 → AvatarPicker → labeled 字段
（名称/显示名称/描述 min-h-16/多连接的 createOn）→ **Advanced 折叠钮**
（:842-858 text 钮 + caret）→ 展开容器（:860 rounded-md border p-3 grid
gap-3）→ **SegmentedControl [常规/技能/工具/MCP]**（:861-888 四页签）：
常规 = 模型 + System prompt + 工作区；技能 = pi_capabilities 真清单；**工具 =
17 组 toolsets 真数据**（组名 + 描述 + N 个工具 + needsSetup 红注）；
MCP = 红显占位。**高级态 max-w-3xl（768）+ resize:both**（:737-751 原生缩放）。
**per-bot 工具集真生效**：BotPreset.toolsets → bot-launch composeEnabledTools
（pi_capabilities toolsets → 工具名并集；所选组无工具 = throw 传播，规矩 12）
→ pi_create_bot_session enabledTools → pi_session create_bot_session 新参
bot_enabled_tools（create_session_opts 四个调用点全部补 None）→
SessionOptions.enabled_tools。Rust 胶水层参数透传，vendored pi 未动。

**新建群聊对话框全量对齐（2026-11-10 续2，CreateGroupChatDialog 逐段照抄）**
——hermes create-dialog.tsx :1279-1550 的结构逐段落到 bot-group.tsx：①标题 +
描述行（"选择 2–6 台机器人…互发未接通"红显嵌在描述里）②搜索框（underline
变体，"搜索以添加机器人…"）③**已选徽章行**（圆角胶囊 + ✕ 点移除，hermes
Badge :1433-1458）④**成员列表**（BotFace 24 + 名 + `@handle · 已在"群"` 第二
行 + 右侧原生 Checkbox；**上限 GROUP_CHAT_MAX_MEMBERS = 6**，满员禁用未选行
opacity-50）⑤群图片（40px 圆预览 + 上传；AI 生成钮 hermes 仅 imagen 可用时
渲染——宿主无 imagen，同款条件不渲染，不是裁剪）⑥名称输入（maxLength 64，
**placeholder = 已选成员名逗号连接；空名创建 = 成员名连接**，hermes :1321
`(name.trim() || placeholder).slice(0, 64)` 同款）⑦footer **创建群聊 (N)**
计数主钮。空态两分支（搜索无匹配 / 还没有机器人）。BotGroupChat 加
`image` 字段（创建时落 stub store；房间头/群行可用）。CDP 断言：徽章移除、
计数、placeholder 跟随、空态、默认名——全过。

**分区嵌套结构（2026-11-10 续：hermes renderUserSections 全量对齐）**——hermes
roster-pane-sections.tsx 头注原文 "USER SECTIONS — **composed with the gateway
sections, not instead of them**"：网关分区是外层桶（>1 连接且 filter=all 时
拥有顶层），**用户分区嵌在每个连接桶内部**（`ml-2.5 border-l pl-1` 缩进），
平铺模式（≤1 连接或 filter=具体连接）才在顶层。空块规则：平铺 = 头 + 虚线槽
（emptyHint 同位："把机器人拖到这里归入此分区"）；嵌套 = 只在拖拽中渲染
（每个桶都重复空头是噪声——hermes :filter(block.rows.length || !nested ||
dragging)）。孤儿连接（注册表删除后）自成红显区块（hermes :181-198 同款，
不静默丢行）。**宿主第一版漏了三层**：网关分支不渲染用户分区（行全平铺）、
filter=具体连接没切回平铺、孤儿连接的 bot 直接消失——全部按 hermes 补齐。
**新建分区对话框"空白"的根因**：`.set-card` 基类是 `height:70vh; width:840px;
grid-template-columns:var(--dialog-nav-w) 1fr` 的两列大卡——SectionDialog 没
打 `display:block` 补丁（BotsDialog/CreateGroupDialog 都打过），表单被塞进
172px 左列 + 70vh 里 80% 是空白。修 = `width:420, height:auto, display:block`
（CreateGroupDialog 同补 height:auto）；对话框加提示语"多连接时分区显示在
各连接桶内"。

**顺带修的两个真缺陷**：①CreateGroupDialog / SectionDialog **没有 Esc 关闭层**
（BotsDialog 有——Esc 穿透到下层；已补 pushEscapeLayer + isTopEscapeLayer
同款）；②**多连接布局分支不渲染群聊分区**（hermes showGatewaySections 分支
是 `[groups, ...gateways]`，宿主第一版只在单连接分支画——已提取 groupSection
两分支共用）。测试期间的假象：群成员"点不动"其实是陈旧对话框没关（Esc 缺陷
所致），状态跨 HMR 残留——先修 Esc 再测。

**内存占用（用户同日问"怎么变高了"）**：实测冷启动 = 主 webview 392MB WS /
JS 堆 112MB / DOM 1204 / goo portal 6；Rust 宿主仅 68MB。之前"变高"是应用
从 11/7 连跑三天（大量 HMR 热重载累积在同一个 webview 进程）——重启即回落，
已实测。系统里 13 个 msedgewebview2 残留进程属 Windows 小组件 / GameViewer，
与本应用无关。dev 模式（未压缩 + HMR + source map）本身显著高于 release。

### 永久会话锚定与会话侧栏隐藏（2026-11-08 修正轮）

用户核对引擎事实："pi 无 hidden 会话面、无 title 唯一索引，你再看看"。vendor
源码坐实（session_index.rs init_schema）：sessions 表只有 `path TEXT PRIMARY
KEY`，**name 无唯一索引**；全库无会话级 hidden 面（"hidden" 命中全是隐藏
消息/分支与 doc(hidden)）。此前 bot-launch 的两个说法都站不住：

1. **名字匹配记录路径**（v1 实现）——同名会话会误配（无唯一索引）；且
   `pi_create_bot_session` 明明**已返回带 sessionId 的状态快照**
   （main.rs:827）却被丢弃。修正 = **sessionId 锚定**：建会话采纳返回快照
   的 sessionId，路径从 pi_list_sessions 按 **id** 匹配（id = 文件 header
   身份，天然唯一）；再启 pi_open_session（返回 "provider/model" 仅供日志，
   sessionId 走 `pi_get_state`——runtime.tsx「回到父会话」同款先例）后
   **身份校验**：state.sessionId ≠ 锚 id = 路径内容已不是该 bot 的会话，
   console.error 可见后清锚重建；无锚旧记录借此完成首校锚定。
2. **头注释声称 "session-catalog 按 botSessionNames 过滤"**——从未实现
   （全仓库无此函数，假声明）。修正 = 真接线：thread-list.aui 的
   useThreadDisplay 在归档过滤后按 `bots-store.botChatPaths()`（**双锚才
   信**：path+sessionId 都在才参与隐藏——旧名字匹配记录重新锚定前不得
   藏任何行，防误藏同名用户会话）过滤行投影；搜索面同源（filteredMetas
   先于 buildSessionSearch）。花名册是唯一入口 = hermes canonical chat
   语义的宿主实现；删 bot = 锚消失 = 会话重现侧栏（用户可自行处置）。

实机直证（CDP 全程）：建 bot → 启动 → 锚 = {path, sessionId}；侧栏无该行
（PASS）→ 删 bot → 行重现（PASS）→ 行右键删除（活动会话被引擎正确拒绝
"cannot delete the active session"，切走后可删）。克隆 bot 必须同时清
chatSessionId（bots-pane 右键克隆已补）。单测 = bots-store.test.ts 5 条
（botChatPaths 双锚信任规则）。门禁 tsc 0 / vitest 739（60 文件）。

### 行几何与间距（2026-11-07（续2）对齐轮，可复用常量）

用户"间距，排列样式还是有区别"的收口轮。hermes 的行几何全在
`apps/desktop/src/app/chat/sidebar/row-geometry.ts`（会话行是标尺，机器人行
复用同一套），逐常量对照后改 `bots-pane.tsx`：

| hermes 常量 | 值 | 宿主落点 |
|---|---|---|
| `SIDEBAR_ROW_LEAD` | `grid size-3.5 place-items-center` | 行内 14px 前导格（状态点装里面，名称与左栏同左缘） |
| `SessionStatusDot` idle | `size-1` quaternary（4px） | 空闲点；启动中 pulse 6px（宿主适配） |
| `SIDEBAR_ROW_LABEL` | `text-[0.8125rem] leading-[1.35]` | 机器人名 |
| 段头（RosterSectionHeader） | `px-2 py-1.5 text-[0.6875rem] font-semibold uppercase tracking-wider` quaternary + caret + 计数同色 | SectionHead 组件（全部区块可折叠） |
| 行栈 | `gap-px`（1px）/ 块间 `gap-0.5` | 容器 `grid gap-0.5 px-1.5 pb-2` 一个（段头行同左缘） |
| SearchField underline | 无边框 + opacity-50→focus 1 / 有词 1 | 搜索框 |
| `icon-xs`（button.tsx） | `size-6 rounded-[4px]` svg 12px | 工具条铃/加号钮 |
| SectionDropZone | armed ring-inset / lit `bg-accent/10 ring-accent` | draggingBot state 上报（hermes $draggingBot 同构） |
| sourceStatus.available | 头像 `grayscale opacity-60` | 远端连接的行 |

**段头是折叠钮**（hermes UserSectionHeader onToggle）：点击收展、双击改名、
右键/⋯ 同菜单——三个手势都在头按钮上，⋯ 只是悬停入口。

### 入口：Mirach 点击 = 左栏右侧弹出独立栏

- **旧形态已删**：左栏"会话/机器人"双视图切换（`left-rail-pane.tsx` 的
  view state + BotsPane 内嵌渲染）——现在是单视图（会话列表），Mirach
  文字按钮 = **开合弹出栏**（`wordActive` 高亮态，aria-pressed）。
- **弹出栏 = dockview 面板**（id `bots`，region `'bots'`——**不是**
  `'panels'`：面板栏的末签关栏/锚重建语义不适用本栏），dock 位 =
  `referencePanel: 'leftrail', direction: 'right'`，宽 260（min 240/max
  360，addPanel 后 `panel.api.setSize` 钉宽——对半分宽实测 429 超 max）。
  开合动作在 `hub/bots-panel-actions.ts`（api 取 `__dvApi` 全局句柄——
  leftrail 内容组件拿不到 containerApi，同 conversation-status-panel 先例）。
- **按钮态的真相源 = `botsPanelStore.open`**，三条同步路径：Mirach toggle
  （add/remove 即写）、shell 的 onDidAddPanel/onDidRemovePanel（✕ 关闭）、
  **left-rail-pane 挂载时的 `syncBotsPanelOpen()`**（fromJSON 恢复的面板
  **不走 didAddPanel**——反序列化直接建组，布局事件在 boot 路径不可依赖，
  读最终态最稳。实测踩中：面板开着但按钮不亮）。
- 布局存档自然携带开合态（dockview 序列化所有面板），重开应用保持。

### 页面（`bots-pane.tsx` 重写）——hermes 逐项对照见文件头表格

| hermes | 本栏 |
|---|---|
| 工具条（段头 BOTS + 新建钮 + 搜索） | ✅ |
| 用户分区 + 未分类 + 行拖拽归区（私有 MIME `application/x-mirach-bot`） | ✅ |
| BotRow（BotFace 头像 + 状态点 + 名称 + 置顶/隐藏标记 + 细节行 + 年龄） | ✅ |
| 行右键菜单（打开会话/置顶/隐藏/编辑/移动到分区▸/删除） | ✅（motion ContextMenu 受控 point，**全局右键 scope 需登记**） |
| 已隐藏区（底部折叠 + 显示钮）+ 空态三态 | ✅ |
| 群聊 / 网关分区 / toasts 铃 / kind·activity·gateway 筛选 / RoutinesPane | ❌ pi 无对等承载，不造假 UI |

**右键 scope 登记（漏了会全局菜单抢跑）**：`context-menu-scope.ts` 的
`CONTEXT_MENU_OWNER_SELECTOR` 加了 `[data-roster-key]`（行根）——机器人行
与分区头自管右键（onContextMenu preventDefault + 开行菜单），全局 capture
监听若不早退就会抢先开窗口动词菜单（实测踩中）。

### 数据面

- **`bots-store.ts` v2**（键 `mirach.harness.bots.v2`）：BotPreset 扩
  hermes BotMeta 字段（`title/color/shape/image/custom/pinned/hidden/
  sectionId/sectionName`）；v1 六字段自动升格（v1 键保留不删——hermes
  迁移同款）。分区 = 独立键 `mirach.harness.bot-sections.v1`
  （`{id,name}[]`），删分区把成员打回未分类（hermes user-sections 同语义）。
- **`bots-types.ts`**：hermes `BotMeta` / `AvatarShape` / `FaceMood` /
  `AvatarAppearance` 逐字段照抄（网关字段不收）。
- **`bot-face.tsx`**：hermes `avatar.tsx`（1158 行）**逐字字节复制**
  （Copy-Item），仅头部打补丁——`profileColor` 换宿主实现（名字 FNV hash →
  HSL，default 返回 null 走 PRIMARY 兜底），`blobatarSvg` /
  `createBudgetedLoop` 两个 SDK 可选依赖恒 undefined（上游自带
  `typeof sdk === 'undefined'` 退化分支，宿主无 SDK 走的正是那条路）。
  **类型层坑**：这两个常量若直接写 `= undefined`，调用点被窄化成 never
  （"This expression is not callable"）——必须显式给函数类型注解。
- 对话框（`bots-dialog.tsx`）：头像区照抄 create-dialog（BotFace 预览 +
  形状行 + 颜色行 + 图片上传 FileReader→dataURL + 还原默认）+ 显示名称
  字段；提交随 preset 落 `color/shape/image/custom`。
- 行右键 scope 单测：`context-menu-scope.test.ts` 补机器人行根用例。

## GPT-Live 双工语音桥（2026-11-11，hermes voice-live 移植）

用户："复制hermes把moss live等双全工做个桥接层，能连接api"。查证："moss live"
在 hermes 里不存在——用户指的是 **GPT-Live**（`voice.voice_chat_mode:
gpt-live`）：一个 OpenAI 全双工语音模型（gpt-live-1）同时听和说（WebRTC），
无自有工具，真工作经 `session.delegation.created` 委托给 agent 会话，回复经
`session.commentary.append` 流回、由语音转述。**三分职**（hermes
tools/voice_live.py 模块头）：前端持 WebRTC 媒体+数据通道；服务端做唯一的
一步（SDP offer → vendor answer 交换，key 不进前端）；agent 保持全部能力。

## MOSS Live 桥（2026-11-12，模思智能 moss.cn——用户指名的 "moss live"）

用户纠偏："为什么你一直查openai，我说的是moss live啊"+"看模思的官网"。
**查证反转**：hermes 里确实没有 moss live（全树唯一命中 = 宠物生成示例词
"moss golem"）——真身是**模思智能**（www.moss.cn，复旦 OpenMOSS 团队孵化）
开放平台的 moss-live-1.0（platform.moss.cn/docs/scenarios/moss-live +
/docs/reference/moss-live）。协议与 GPT-Live 同构但传输不同：

| 面 | MOSS Live | 宿主 |
|---|---|---|
| 传输 | **WSS** wss://api.mosi.cn/v1/realtime?model=moss-live-1.0，握手头 Bearer | **pi_voice_moss.rs**：tokio-tungstenite（新依赖 + futures-util），独立线程持活；事件经 app.emit 广播（moss-live://event / audio / closed）——**浏览器设不了 WS 握手头，key 只在 Rust 桥** |
| 音频 | 上行 16k S16LE（tagged-v1 0x00 前缀，Rust 加）；下行 48k S16LE 裸帧 | 前端 lib/moss-live.ts：ScriptProcessor 采集→线性重采样 16k→聚合 64ms 帧上行；下行 base64→Int16→WebAudio 排队播放 |
| 委托 | session.delegation.created（**objective + context 直接随事件**，非转写片段）→ client 后端干活 → session.thinking/commentary.append 回报（≤2000 字） | **与 GPT-Live 共用同一委托回路**（voice-live-conversation 驱动零改动）——session 类同签名（think/speak/instruct/setMuted/close + VoiceSessionLike 接口） |
| 双工 | 真双工（说话时 mic 照送）+ barge-in（response.audio.stop → 停播 + playback.stopped 带 played_audio_ms） | 播放队列按 run/turn 记账，barge-in 停源 + 确认 |
| 就绪 | key = settings voice.moss_live.api_key → MOSS_API_KEY 环境变量 | status 增 mossAvailable/mossModel/mossReason（独立于 OpenAI 链）；mode 扩 moss-live（voice_chat_mode 容忍 moss） |
| 设置 | hermes 无 | 「语音」节第三模式 radio + **MOSS API key** 输入（只写不读同规）+ 双链就绪读数 |

字幕语义分流：GPT-Live transcript 是 delta 拼接（pushCaption）、MOSS 是
**全文覆盖**（setCaption）。计费页（/app/pricing）只列 TTS/转写/图像——
**Live 价格未列**（用户"现在不是免费吗"待官方确认；页面无收费项 ≠ 免费）。
vendor 还提供 **pi 作为预适配委托后端**（Option 1：@mossai/mosslive Node 适配
器）与自定义 harness 脚手架（Option 2）——宿主的 Rust WSS 桥 + 既有委托
回路即等价物，不引其 npm 适配器。
**Vendor contract 已对官网逐条核对（2026-11-12，developers.openai.com
/api/docs/guides/live + live-delegation + voice-webrtc.md）——全部一致，
**可接通**：`POST /v1/live/sessions`（body = `{session, transport:{type:"webrtc",
sdp}}`，成功 **HTTP 201** 返回 `{session:{id:"live_…"}, transport:{sdp}}`）；
模型 `gpt-live-1`；数据通道 `oai-events`；事件 `session.started /
session.input_transcript.delta / session.output_transcript.delta /
session.delegation.created / session.thinking.append /
session.commentary.append / session.instructions.append /
session.input_audio.mute / session.close / session.closed` 与宿主桥逐一
对上；**HTTP 请求即建会话，禁止在数据通道发 session.start**（宿主没发）；
**audio.format 必须省略**（SDP 协商，宿主照做）；关闭 = 发 `session.close`
等 `session.closed`（15s 超时与官网示例同值）；client delegation 的
`delegation: {type:"client"}` 与 append 500-token 上限同款。差异仅两处
（无害）：官网 ICE 10s 超时判失败、宿主按 trickle 宽松放行；官网 201、宿主
接受 200/201。
| 层 | hermes | 宿主 |
|---|---|---|
| 传输桥 | `lib/voice-live.ts`（VoiceLiveSession：RTCPeerConnection + `oai-events` + transcript + think/speak/instruct/mute/close） | **`src/lib/voice-live.ts` 逐段移植**（SDP 交换改走 `pi_voice_live_session` IPC）；纯函数单测 13 条（chunkForCommentary/toLiveHistory/delegationPrompt/liveEndedMessage） |
| 服务端 | `tools/voice_live.py`（`POST {base}/v1/live/sessions` + status 端点） | **`src-tauri/src/pi_voice_live.rs`**（pi::http client POST，on_big_stack；单测 6 条：mode 拼法/secret 不泄漏/缺 key reason/session config/空 SDP fail-fast/凭据优先级） |
| 凭据链 | `voice.gpt_live.api_key` → VOICE_TOOLS_OPENAI_KEY 链 | `voice.gpt_live.api_key`（settings.json）→ `OPENAI_API_KEY` 环境变量；**status 永不返回 key**（测试守着） |
| 状态/模式 | `store/voice-live.ts` + voice-engine-rows（chained/gpt-live 单选） | `assistant-ui/voice-live-store.ts`（status 缓存 + 会话态 + 字幕）；宿主单连接无引擎切换面（mode 由 settings.json voice 段定） |
| composer 入口 | 语音钮 + status-stack 字幕 | `assistant-ui/voice-live-panel.tsx`：VoiceLiveButton（composer-side-row）+ 字幕条（听/说状态 + 静音 + 关闭） |
| 委托回路 | use-voice-live-conversation.ts（495 行 + 5 测文件：boundary/meter/rearm/stale-reply/warmup） | **红显待接**（delegation 到达只亮注"委托 agent 未接通"；接线需要 runtime postRun 桥 + 回读捕获，独立一轮） |

实机（CDP）：`pi_voice_live_status` → `{available:false, mode:"chained",
model:"gpt-live-1", reason:"no OpenAI API key (set OPENAI_API_KEY or
voice.gpt_live.api_key)"}`（本机无 OpenAI key——reason 与 hermes 同文）；按钮
在 composer-side-row 渲染；点击红显 reason（不假装能启动）。**配 key 后即为
真 API 会话**：settings.json `voice.voice_chat_mode: "gpt-live"` +
`voice.gpt_live.api_key`（或环境变量 OPENAI_API_KEY）。链式引擎（STT→turn→
TTS）宿主无 STT/TTS 提供方——不渲染假入口。

**委托回路全链路（2026-11-12 续，上一轮的红显拆掉）**。hermes
use-voice-live-conversation.ts 的回复驱动段（:381-462）宿主移植为
`assistant-ui/voice-live-conversation.tsx`（provider 内常驻驱动组件，
PlanReviewCard 模式）：

- **消费委托**：面板 onDelegation → `delegationPrompt()` 折轮 → 停止词判 →
  store.setPendingDelegation → 驱动组件消费：busy 先 `aui.thread.cancelRun()`
  （新请求取代在途 turn——hermes onInterrupt 同语义）→
  `aui.thread.append({ content: [{ type: 'text', text }] })` 提交（官方
  append 通道 = 用户行 + run 全走 adapter）。**宿主适配**：pi 无 per-turn
  模型输入旁路（hermes VOICE_LIVE_TURN_NOTE 只进模型输入）——voiceContext
  以注释块**前置进提交文本**（落库行如实显示，不造假旁路）。
- **回复驱动**（200ms tick）：最后一条 assistant 的 text 部件 →
  `sanitizeTextForSpeech` → streaming 时按句界 `session.speak`（句界 =
  `. ` 边界 + spoken 游标），收尾补尾巴 → 清委托。在途工具名 →
  `session.think("Mirach is working: <tool>. Not done yet.")`。idle 且已见
  运行（或 15s 提交宽限）→ 无语音结果 think 提示 + 清委托。
- **停止词**：`lib/voice-stop-word.ts` 移植（hermes 默认英文表逐字 +
  **中文等价词**——宿主用户语言是中文，"停止/再见/结束对话" 必须同样生效；
  称呼前缀加 mirach；整句判——"停止那个容器" 永不吞）。utterance 1.5s
  安静判定 + delegation prompt 双口判定（hermes 两处同源）。
- **语音净化**：`lib/speech-text.ts` **逐字字节复制**（自包含零 import——
  表格→表头朗读 / 标识符剪枝（#119207）/ code fence / 链接 / emoji）。
- **种子 history**：panel start() 读 `aui.thread.getState().messages` →
  foldTranscriptForSeed → toLiveHistory（文字对话的上下文喂给 live 模型）。
- store 增 pendingDelegation / activeDelegationId + **session 实例注册表**
  （setActiveSession/getActiveSession——面板持 UI 生命周期，驱动组件经此
  读会话命令面，跨组件不走 React ref）。

**接通收尾（2026-11-12 续3）：设置页「语音」节**（上一条"接通条件"变成
应用内两步）。app/settings/voice-settings.tsx：引擎模式单选（chained
红显"STT/TTS 提供方未接通"）、OpenAI key password 输入（**只写不读**——
placeholder 报已配置态，保存后不回显）、模型/音色（留空 = gpt-live-1/marin
默认）、就绪状态读数（真相 = pi_voice_live_status）。数据面 =
pi_voice_live_set_config → pi_settings::persist_voice_live_config
（settings.json voice 段 RMW，同 persist_default_model 通道；api_key
**只写不读**、空串 = 清除、写后回读就绪判定且**永不回显 key**——有测试
守着）。settings-overlay：voice 从占位变实节（IMPLEMENTED_SECTIONS +
render 分支 + nav placeholder 移除）。实机（CDP）：写假 key → 主窗 status
翻转 available:true/mode:gpt-live 且 key 无泄漏 → 清除复位。aui/CDP 陷阱：
设置窗的第二个 WebSocket 连接，CDP 消息字段必须叫 id（自定义名会被协议
静默丢响应——eval 永挂）。
**per-bot 例程真绑定（2026-11-12 续2，RoutinesStubPane 退役）**。pi_cron
Job 加 `bot: Option<String>`（serde default——旧 jobs.json 兼容；**仅归档/
过滤用**——执行参数在创建时由前端从 bot 预设填进 provider/model/prompt，
bot 删除后作业照常跑）。CreateJobInput/UpdateJobInput 加 bot（update 的
`Option<Option<String>>` = Some(None) 解绑）；job_to_wire 投影带 bot。
前端 `hub/bot-subpages.tsx` 的 RoutinesPane = 真面板：作业表（bot 过滤）+
创建（调度自由文本——`parse_schedule` 全语法：间隔/every/N 字段 cron/裸
ISO 一次性/`in 30m`；**"once ISO" 不是合法形态**，错误信息会完整列出）+
立即运行（pi_cron_trigger 同步等整个 run）/暂停/恢复/删除（两击确认）。
bots-pane 的 paneView routines 臂改持 BotPreset 对象（创建要 model/persona）。
实机：创建带 bot=微软 → wire 带绑定 → 列表过滤命中 → 清理干净（IPC 直查）。
aui API 实测：`aui.thread.append` 收 `{ content: [{ type: 'text', text }] }`
（`{ text }` 直接给会 TS2353）；`aui.thread.getState().messages` 常驻可读
（tick 内不用 hook）；MessageState readonly——映射函数签名收 readonly。
门禁 tsc 0 / vitest 759（62 文件）。

Rust 注意：on_big_stack 外层是 spawn/join 错、内层是业务错——双层 Result 用
`and_then(|inner| inner)` 拍平（本轮实测编译错一次）。测试不碰 OPENAI_API_KEY
环境变量（并行竞态）；fail-fast 顺序 = SDP 形状检查先于凭据。

**MOSS 工具面（2026-11-13，交接单"下一轮候选"第 2 项落地；GPT-Live 的已核对
contract 无工具事件——工具面天然限 MOSS）**。协议（platform.moss.cn
/docs/reference/moss-live）：`session.update`（session.tools **整表替换**，
≤128 个）声明 → `response.function_call_arguments.done`（call_id + arguments
JSON 串；async 多带 task_id/revision）→ `conversation.item.create`
（function_call_output）→ `conversation.item.created` 确认 →
`response.create` `{call_ids:[…]}` 续跑；sync/async 同一条回报路径。
**工具集口径（用户定稿"全协议：只读集 + cron 立即跑"）**：host 原生只读集
（get_now / get_session_usage / list_sessions / get_app_state / get_todo_state
/ list_cron_jobs，全 sync+read_only）+ `run_cron_job_now`（async_effect，
pi_cron_trigger 真跑 tool_task 生命周期——超 120s 的作业结果回不到语音，
作业本身照常跑完，description 写明）。**pi 内置工具不透传**（与 run 上下文/
审批耦合，语音场景审批面不可见；SDK execute_tool 只覆盖 JS extension）。
**写类工具同此口径不上**。
- `lib/moss-tools.ts`：声明集 + `validateToolDecls`（name 正则/≤64/唯一/
  非空描述/async_query⇔read_only:true、async_effect⇔read_only:false）+
  执行器（真 IPC：pi_usage_snapshot(range all/7d/30d) / pi_list_sessions /
  pi_get_state（无活动会话 = 上游 Err 走失败输出）/ pi_todo_state /
  pi_cron_jobs / pi_cron_trigger）+ 输出整形（行文优于裸 JSON——模型要转述
  给人听；sessions 截最近 15、cron 截 20、trigger response 截 500 均注明）。
- `lib/moss-tool-flow.ts`：**纯协议态机**（无 DOM/IPC，执行器/传输注入，
  单测覆盖）。call_id 去重（response.done 会重播）；cancel_requested → 停跟 +
  迟到结果丢弃（不强杀执行器，cron 照常跑完）；≤4 并发 / ≤128 会话（含已
  结束，deliverFailure 占位也计入——vendor 侧任务已存在）；120s 超时 =
  交付失败输出后停止跟踪（迟到真结果经 state 守卫丢弃，不重复交付）。
  失败可见（规矩 12）：执行器 throw/超时/限流 → `{"ok":false,error}` 工具
  输出（模型如实转述）+ console.warn + onNotice。
- **有意不做**：客户端发起的 `session.tool_task.revise`/`.cancel`（需要改参
  重跑/撤销 UI，本轮没有——不做死代码；服务端确认 `session.tool_task.updated`
  无动作）。GPT-Live 无工具事件，不加。
- 接线：`MossLiveSession.attachToolFlow()`（start() 前挂；session_attached
  先 announce 再 mic_state）+ `sendRawEvent` 外发通道；
  voice-live-panel moss 臂构造 flow（执行器 = executeVoiceTool，onNotice →
  setError 非致命）。Rust 零改动（协议全走既有 pi_voice_moss_send_text）。
- **实机端到端已通（2026-11-13，mock vendor 全链）**：Rust 桥的
  `voice.moss_live.base_url` 可被 settings 覆盖 → 本地 mock WSS（无依赖手写
  RFC6455：http upgrade + SHA1 accept + 帧 parse/encode，说 vendor 协议子集）
  配假 key 打通整条真链：面板 → MossLiveSession → Rust 桥（WSS 握手 + Bearer）
  → mock vendor → session.update 7 工具整表声明（async 配对正确、
  **update 先于 mic_state**）→ get_now sync 全回报路径（执行器真跑 →
  conversation.item.create → created → response.create）→
  run_cron_job_now（不存在的 id）→ pi_cron_trigger 真调 → IPC Err 如实失败
  输出 `{"ok":false,error:"作业不存在…"}` → 回报+续跑 → cancel_requested
  先于 done → c-3 丢弃（flow 的 notice 经 onNotice→setError 红显可见）。
  **真 key 端到端（模型真调工具）仍待 platform.moss.cn key**（交接单候选
  第 1 项）。单测 33 条（声明自查/回报路径/去重/取消迟到丢弃/限流/超时）
  + Rust 4 条（normalize_base_url）。
- **E2E 排障揪出两个真缺陷（都已修）**：
  1. **pi_voice_moss.rs：无 path 的 base_url → 400 Bad Request**——
     tungstenite 的 request line 原样用 path_and_query，`GET ?model=…` 是
     非法 HTTP（Node/浏览器的 URL 构造器会自动补 `/`，tungstenite 不补）。
     官方端点带 path 所以生产没炸过；本地 mock 一接就现形。修 =
     `normalize_base_url`（host 后无 `/` 时补；带 query 也处理；4 测）。
     **排查法**：连接失败是静默的（onClosed 无红显）→ 先裸调
     `window.__TAURI_INTERNAL__.invoke('pi_voice_moss_open')` 拿 handle →
     send 报"会话不存在" = 连接失败后注册表已移除 → 再经 vite 动态 import
     真 `MossLiveSession`（listen 无模块状态依赖，陷阱 15 不适用）抓
     onClosed reason。
  2. **前端 onClosed 静默吞断线**：panel 的 onClosed 只清态不报错——连接
     失败用户看不见。修 = 红显 `语音会话已断开：{reason}`（用户主动 stop 的
     拆除走 finalized 守卫不会到达 onClosed，不误报）。
- **环境观察（非缺陷）**：E2E 期间系统时钟被前拨 ~15h（get_now 报
  23:56 → 三方核对 WebView2/Node/PowerShell 完全一致）——疑似 Windows
  Time 校时修正 RTC 漂移。get_now 如实报告进程所见时钟，行为正确。
- 测试坑：`.at(-1)` 返回 `T|undefined`，直接 `as {item:…}` 会 TS2352——
  先 `.item` 再窄化；deferred 执行器手控时序时**先结算再探针**（并发上限
  会把未结算的调用全拒掉，128 上限测试必须按 ≤4 分波执行）；
  Runtime.evaluate 里 `import('@tauri-apps/api/event')` 裸说明符解析不了
  （要过 vite 就 import('/src/...') 真模块）。

## 间距/入口对齐轮（2026-11-14，用户三连："机器人栏间距和左侧栏不一样 /
技能页顶部标签跑最顶 / 双工语音入口放项目名右边"）

**方法论照旧**：先 CDP 量文本级矩形（段头文字/行标题/首内容 y/右缘），再改，
改完实测闭环。三个根因与修法：

1. **机器人栏（bots-pane.tsx，宿主组件随便改）**：实测侧栏文字线统一
   x=54（段头/入口/行标题同线）；bots 栏四条线互不相同（工具条标签
   +9.4 / 搜索 +32 / 段头 +50~61 / 行名称 **+89.4**）——行名称离群 = 
   `px-2 + BotFace(34) + gap-2.5 + 14px lead 格` 链。修：
   - BotFace 34→28、gap-2.5→gap-2、**删名称链的 14px lead 格**（状态点改
     绝对定位叠头像右下角，`ring-2 ring-(--surface)` 分色——面板底色令牌
     是 `--surface` 不是 --ui-chat-surface-background）→ 行名称 +62.8 =
     所属段头 61（差 1.8px，此前差 28）；GroupRow 同步（w-[34px]→w-7、
     size-8→size-7、gap-2）。
   - 工具条 `mt-[22px]`：首行行盒顶对齐侧栏入口条首项（新建会话 y=109.8；
     原贴 pane 顶 85 → 差 14+8 两轮微调出 22）。
   - 搜索容器 `pl-[30px]`：文字线 +50.6 ≈ 段头线（原 32）。
   - **段头文字线的 +5px 残差**（类链算 50、实测 55）没有追到底——阶梯差
     ≤5px 视觉一致即收；嵌套段头（未分类 +61）是分区树语义，保留。
2. **技能页标签贴顶（page-search-shell.tsx 镜像不改）**：上游标签行顶距
   `pt-[calc(var(--titlebar-height)+1.5rem)]` 为 hermes 桌面浮动红绿灯留白，
   宿主**从未定义该变量**（只有 overlay-view 在自己子树内联定义——所以
   cron 页（Panel→OverlayView 通道）顶距生效、capabilities（PageSearchShell
   通道）calc 失效 → padding-top 归零 → 标签贴面板顶（y=10，页签胶囊线
   y≈35-58）。修 = panes.css 宿主覆盖
   `.hermes-capabilities-host :has(> [data-tour='page-tabs']) { padding-top: 24px }`
   （标签 y=34 落进胶囊线；:has 实测 WebView2 可用；镜像纯度由 audit-mirror2
   守着，覆盖写在宿主 CSS）。
3. **双工语音入口迁移（用户定稿"项目名右边，像微信语音通话按钮"）**：
   - VoiceLiveButton 从 composer-side-row **迁列头 workspace 行**
     （chat-tab-label.tsx 加 `__row` 容器：项目名 + 钮，gap-10px）；列头
     整体 `pointer-events:none` → 钮组件自带 `pointer-events-auto`。
   - 字幕条（VoiceLivePanel）**留 composer**：钮与字幕条分离挂载，跨组件
     传话走 store——`voiceLiveStore` 加 `error/setError`（原按钮 useState），
     字幕条改无 props 读 store；会话命令面走既有 getActiveSession() 注册表。
   - aria/title 文案中性化（"开始语音会话"/"开始双工语音（GPT-Live /
     MOSS-Live——在设置 → 语音配置）"——原文案"委托 agent 待接线"已过时）。
   - 图标 size-3→size-3.5（列头 25px 项目名旁的视觉重量）。

验收（CDP 实测+截图）：caps 标签 y=34（胶囊线）✓；bots 行名称=段头线
（62.8/61）✓；工具条首行 y=110.5 ≈ 侧栏 109.8 ✓；语音钮在项目名右侧
（workspace 行内，钮 x=项目名右缘+10）✓；控制台零新增错误。门禁 tsc 0 /
vitest 792。**坑**：HMR 时序下 thread.aui 的旧模块会短暂报
`VoiceLiveButton is not defined`（改 import 与改 JSX 两个 HMR 到达之间）——
reload 后即消，不是真引用残留（Select-String 全量复核 0）。

## 引擎核心换 rpi-main（2026-11-14 竖链移植，用户定稿"核心换成
G:\pi-rust-main，不用 pi agent rust 了"，策略选 1 竖链优先）

- **egui 试验田结论先行**（G:\mirach-egui，独立仓库，已重建保留待做）：
  egui 直连 rpi 的竖链（AgentHarness 驱动）+ 样式对齐轮全部打通，但**内存
  地板四组实测证伪了 egui 的内存优势**（空窗 Private：0.37 Vello/wgpu
  D3D12 385.5 / GL 218.6 / 0.32+glow 182.9 / WebView2 空 ~190——本机任何
  GPU 渲染 UI 地板 ~180-220 起，0.37 的 Vello 后端比 WebView2 还重；应用级
  423MB > 打包版 WebView 全应用 321.8MB）。用户看过原型样式差距后定夺：
  egui 删除→重建保留待做，主线留在 WebView。
- **引擎核心交换（本轮主体）**：`pi_session.rs` 全量重写——对话面
  （ensure/open/discard/prompt/prompt_with_content/interrupt/state/
  list_sessions/rename/delete/new_session_with_cwd）换 **rpi-harness
  AgentHarness**；旧 pi 独有面（hub 五面/todo/usage/分支线系/检查点/rewind/
  undo/retry_edit/compact/export/timeline/job 面/bot 会话/模型切换/plan-
  审批模式）**如实降级 Err("rpi 引擎待接：…")**——标红纪律，rpi-main
  v0.24.0 尚无对应能力；分栏 side_* = Err（rpi 非 main lane 只读）；
  session_lineage = Ok(None)（线系条不渲染，非错误）。
- **嵌入法（照 egui 试验田验证）**：**rpi-cli 当 SDK 库**——
  `provider::resolve`（models.json+env key）→ `session::build(&resolved,
  &args, &cwd, false)`（文档原话 "v1 equivalent of TS createAgentSession"）
  → `(AgentHarness, tokio broadcast::Receiver<AgentEvent>, ReloadContext)`；
  prompt = `AgentLane::prompt_text(&self, text, images)`（&self 可共享，
  **须 use rpi_harness::agent_harness::AgentLane**）；流式 = options 的
  BroadcastEmitter → build 返回的 Receiver → **每轮 resubscribe** 排水任务
  转 on_event；中断 = `AgentLane::abort(&self)`；运行时 = **tokio
  multi-thread**（rpi 用 tokio，旧 asupersync/16MiB 大栈/AbortHandle/
  spawn_blocking 深递归机制全部退役）。
- **AG-UI 协议面 100% 不变**（前端零改动）：agui.rs 只换 ①AgentEvent
  import 源（pi::sdk → rpi_agent）②map_agent_event 变体映射（rpi
  AgentEnd 无 error 字段——RUN_ERROR 由 prompt Err 的 POST 分支承担；
  RetryScheduled 新事件 → CUSTOM "provider_retry" 观察面；其余
  TEXT_MESSAGE_CONTENT/THINKING/TOOL_CALL_*/CUSTOM tool_execution/
  STEP_FINISHED/RUN_FINISHED 形状逐一保持）③图片转换不变（AguiImage →
  rpi ImageContent 在引擎内做）。**分栏 side_* = Err 如实上屏**。
- **降级清单（rpi-main 追平后逐项接回）**：hub 花名册五面 / todo 重放 /
  usage 聚合（pi::stats 无 rpi 对应）/ 分支线系 / 检查点+rewind / undo/
  redo / retry_edit / compact / export_session_html / timeline_markers /
  job 面 / create_bot_session / set_model+thinking（重建 harness）/ plan-
  审批模式 / 审批卡桥（before_tool_call + ApprovalRegistry——本轮工具
  直接执行，审批卡不出现，已记降级）/ get_messages 水合（Err——重放面
  待写）/ messageCount（诚实 null）。
- **依赖并存**：vendored pi_agent_rust 0.8.0 保留（pi_cron.rs 自开会话
  用）+ rpi-cli/rpi-agent/rpi-ai/rpi-harness path-dep
  `../../pi-rust-main/crates/*`——两引擎并存至迁移完成（迁移完拆旧）。
  **path-dep 工作区成员从外部工程可行**（egui/mirach 双实测）。
  **【已终结】同日晚「pi_agent_rust 整体删除」轮拆除——见下节。**
- 待办（rpi-main 侧追平后）：hub/todo/stats/分支/审批桥/水合重放/分栏
  多 lane。rpi 会话目录 = `<workspace>/.rpi/sessions/<sanitized-cwd>/
  *.jsonl`（默认 workspace = USERPROFILE，工作区选择面后续接列头）。

## pi_agent_rust 整体删除（2026-11-14 单引擎定稿，用户"删除所有的pi agent rust，改用rpi"）

- **vendor/ 目录已删**（src-tauri/vendor/pi_agent_rust，~49MB / 数千文件，
  git 全量 D）；Cargo.toml 的 pi path-dep 与 asupersync 一并移除，新增
  **rpi-tools** path-dep（`ExecutionEnv`/`OsExecutionEnv`——rpi-harness
  skills loader 的 env 参数）。同步上游的脱敏补丁、session_index.rs
  `.read(true)` 补丁随依赖一起退休。
- **compile 清理轮**（pi dep 摘除后 19 错 → 0）：
  - **pi_capabilities**：`OsExecutionEnv` 在 **rpi_tools::os_env**（不在
    env 模块）；`load_all_skills` 改走共享列举运行时
    （`pi_session::list_runtime`，OnceLock\<PiRuntime\>——rpi 的
    skills/prompt loaders 都是 async，tokio::fs 底座）；skill_dirs/
    harness_prefs_path → Result 传播（pi_paths::agent_dir 可失败）；
    重复 load_all_skills 定义删（上轮遗留）；诊断 json 换 rpi
    SkillDiagnostic 形状（`code.as_str()`，message/path 是 String）；
    pi_read_skill 的 `file_path` 是 String（无 .display()），source 从
    file_path 推导；测试 `KNOWN_TOOL_NAMES` →
    **`rpi_cli::session::BUILTIN_TOOL_NAMES`**（file 组补 "docs"，
    DEFAULT_ENABLED_TOOLS 同步 + 注释改为"UI 默认组开关"语义——rpi 工具
    过滤未接线前此表不进引擎）。
  - **pi_resources**：重写 = rpi-harness `skills::load_skills` +
    `prompt_templates::load_prompt_templates`；旧 pi settings.json 的
    extensions/packages/enableSkillCommands 字段 **rpi schema 没有**
    （rpi 扩展面 = cdylib 插件 ABI，无 settings 路径清单）——如实去掉
    （findstr 实测无前端消费者，仅注释提及）。
  - **pi_cron**：**路径面改 Result**（cron_dir/jobs_path/executions_path/
    job_output_dir/sessions_dir → `pi_paths::agent_dir()?` 传播；
    CRON_DIR_OVERRIDE 测试短路保留——rpi 无旧 pi 的 Known Folder 坑）；
    `run_in_session` 重写 = rpi-cli `resolve(job.provider/model)` +
    **`Args.session_id = 文件 stem`**（rpi ByExactId 契约"文件以给定 id
    命名"→ 落盘路径与调用方 session_path 严格一致）+ `Args.session_dir` =
    cron sessions + `build(cwd=workdir||current, trusted=workdir.is_some())`
    + `AgentLane::prompt_text` + **TurnEnd 排水抓最后一条 assistant**
    （`AgentMessage::as_assistant` → `Content::text_only`）；assistant_text
    同函数（error_message 追加语义保持）。落盘由 rpi durable session 自管，
    旧 save_and_index 手动钩子无对应物。
  - 小修：pi_settings `ModelsConfig` → `rpi_cli::config::ModelsConfig`
    （rpi-runtime 再导出，rpi_ai::types 没有）；pi_keys 重复 PathBuf 导入
    删；pi_voice_moss 未用 on_big_stack 导入删；**pi_engine_version 的
    include_str 换源**——vendor 清单删除后编译期嵌入改指 rpi 工作区根
    Cargo.toml（`../../../pi-rust-main/Cargo.toml`；rpi-cli 是
    `version.workspace = true`，真值在根 `[workspace.package]`，解析器
    收下该节名；include_str 相对**源文件**而非 Cargo.toml，三层 `../`）。
    注意 **vendor 删除后 Cargo.lock 要重新解析**（metadata 触发重解析，
    pi 系 ~200 条目剪除 + rpi-tools 系补入）；本地 target 里 pi 的
    陈旧 fingerprint 也随之过期（进程内已清）。
- **死代码清零**（13 处旧消费者随引擎消失）：**真删** =
  `flush_active_session`（rpi 逐条落盘，无 flush 概念）、
  `pi_paths::cron_sessions_dir`（与 pi_cron::sessions_dir 重复）；
  **allow(dead_code) 留接线点**（全部带注释）= UiBridgeHandle（事件转发
  待接）/ 审批注册表 register+cleanup+UiAnswer 字段（§7-5 面，rpi 无
  extension_ui_handler 产出面）/ AskRegistry pending+cleanup /
  persona_prompt_for_session（SOUL 注入点）/ persist_default_model（模型
  切换已降级）/ 工具过滤链 session_enabled_tools→enabled_tools_for→
  enabled_tools_for_session + skills_prompt_for_session（rpi 工具过滤/
  资源注入待接回）。
- **门禁**：cargo check **0 错 0 警**；cargo test **117/117**（cron 29 +
  capabilities + agui 40 + 全量回归）；tsc **0**（前端零改动——AG-UI 面
  100% 保持）；vitest 未跑（本轮无 TS 改动，git status 只动 src-tauri +
  AGENTS.md）。

## rpi 插件库接入（2026-11-14，用户"插件全部用上，有mcp，用插件和pkg解决"）

- **插件库在哪**：`G:\pi-rust-main\website\data\packages.json` = rpi 官方
  扩展目录（10 个核心 crate + **22 个已发布扩展**），crates.io 发布 +
  GitHub `pi-rust/rpi-package` 分发预编译 cdylib（per-package release，
  `rpi-extension.json` v1 清单 + sha256 校验 + 目标三元组字段，绝不从
  资产名猜——`prebuilt_extensions.rs` 协议）。安装命令 = `rpi install
  <crate>`，落点 = `~/.rpi/agent/extensions/*.dll`——**session::build 的
  默认扫描目录**（`load_extensions`：trusted → 项目 `.rpi/extensions` +
  全局；untrusted → 仅全局。mirach 走 Args::default() + untrusted =
  全局目录必扫）。宿主侧零改动（规矩：用户明令不动）。
- **引擎侧修复（G:\pi-rust-main，非 git 树——改动只在磁盘，本节即存档）**：
  ①`cdn.rs::download_one` 加 **300s per-request 超时**——共享安装 client
  的 15s 总超时掐断 >15s 的 archive 下载，reqwest 报成
  "error decoding response body"（curl 同 URL 200/2.5MB 实证网络无罪）；
  ②`prebuilt_extensions.rs` 安装 client 15s→**60s**（GitHub TLS 握手在
  弱网下间歇 >15s，"error sending request" 集群）。尺寸上限 + sha256
  仍是完整性守卫，超时只影响传输耐心。
- **安装结果（rpi.exe v0.24.0 本地构建，ABI v4）**：22 个扩展中 **21 个
  入库**，loader 探针（`%TEMP%\rpi-ext-probe`，rpi-extensions::load_one
  直载 + register + 收 registry）**21/21 全部 OK**：
  - **rpi_mcp_adapter**（MCP 四件套 `mcp_request/mcp_call/mcp_list/
    mcp_resource`，stdio + Streamable HTTP 持久连接）——**MCP 面回归**；
  - rpi_todo（`todo` 工具+命令——宿主状态面板的 todo_list.v1 数据面）、
    rpi_plan_mode（plan_mode_start/complete）、rpi_ask_user（ask_user）、
    rpi_subagents（delegate_task）+ rpi_orchestrator（subagent/plan/
    dispatch）、rpi_goal、rpi_codegraph（8 工具）、rpi_permissions +
    rpi_permission_gate（审批钩子面）、rpi_lens（code_lens）、
    rpi_websearch、rpi_webfetch、rpi_im_message（飞书/Lark）、
    rpi_langfuse（score/prompt/trace）、rpi_acp（编辑器接入面）、
    rpi_providers（DeepSeek/OpenRouter/llama.cpp 目录）、rpi_ui_adapter、
    rpi_web_extension（RPC 宿主工作区；DLL 名与 crate 名不同：
    `rpi_web_extension.dll`）、rpi_btw + rpi_run_stats（命令面）。
- **待入库 1 个**：`rpi_voice`（终端语音扩展——mirach 有自己的
  MOSS/GPT-Live 桥，非关键；**archive 是全库最大件**，弱网 300s 也没拉完
  ——好窗口跑 `rpi install rpi-voice` 即可，幂等）。GitHub 直连间歇不通
  （坏窗口整批清单 443 连不上；21 个都是好窗口进的）。
- **对宿主的传导路径（零改动原理）**：插件工具进 session 后经 rpi
  AgentEvent 流出 → agui.rs map_agent_event 的 TOOL_CALL_*/CUSTOM
  tool_execution → AG-UI → 前端工具呈现层照常渲染。todo/plan-mode/
  ask_user 等降级面从**引擎工具**回归，宿主 UI 面仍待接（status 面板的
  sidecar 分派已就位）。`rpi install` 用的本地 rpi.exe =
  `G:\pi-rust-main\target\release\rpi.exe`（engine 同源 ABI v4；crates.io
  的 0.9.0 发布线与本地 0.24.0 开发线不同，**别用 cargo install rpi-cli
  装旧版**——ABI/配置语义可能漂移）。
- **补装进度**：22 官方 + README 追加的 codemode/background-tasks/server/
  node/edit-diagnostics 里——`rpi-codemode`/`rpi-server`/`rpi-edit-diagnostics`
  已入（探针 24/24 绿）；`rpi-node` **不是扩展**（无 cdylib 目标，是可执行
  件，适用"rpi 引擎待接"以外的排除）；`rpi-background-tasks` 上游未发
  预编译（rpi-extension.json 缺，`--build` 撞 crates.io DNS 坏窗口）、
  `rpi-voice` 大包弱网未拉完——两者都在好窗口补 `rpi install <name>` 或
  `--build` 即可。

## 降级面接线第一轮（2026-11-14 晚，用户"为什么不分子智能体做"→ 3 子代理并行）

- **模型面（pi_session.rs）**：`list_models` 接 rpi models.json
  （`rpi_cli::config::load_models_config` + `provider_to_models` →
  `{models:[{provider,id,name}]}`，前端 hermes.ts:546 消费形状）；
  `set_model`（已配置集里精确找 `rpi_ai::Model` → `AgentLane::set_model`
  → `persist_default_model` → model_line；顺序先切换后写盘，注释写明两态
  取舍）；`set_thinking_level`（`rpi_cli::args::parse_thinking_level` +
  `AgentLane::set_thinking_level`，不写盘并注释理由）；`state()` 的
  provider/modelId/thinkingLevel 改读 harness 实值（get_model /
  get_thinking_level——构建期快照在 set_model 后必过期）。
  **实证坑（重要）**：`persist_default_model` 原写 snake_case
  `default_provider/default_model`——**rpi Settings 是
  `rename_all = "camelCase"` 且无 snake alias**（settings.rs:3 注释原文），
  写盘成功但 rpi 完全读不到 = 新会话仍用旧模型（"模型选择是假的"复发
  路径）。已改 camelCase 并清旧 snake 键；前端三处同步：composer-wired
  双键读、providers-settings / settings-overlay 的键组数组改 camelCase
  优先；settings-overlay 的压缩/重试键组同样 camelCase 优先（rpi
  RetrySettings/CompactionSettingsJson 全 camelCase）；rpi 无对应字段的
  旧键（max_delay_ms / failover* / compaction.mode / 顶层 compaction_mode）
  注明"写入惰性"。
- **MCP 管理面（pi_mcp.rs 重写，876 行含 9 测试）**：全局
  `~/.rpi/agent/mcp.json`（顶层 `mcpServers`，与 rpi-mcp-adapter 的
  configPath 格式一致）list/upsert/remove 真实现（read-modify-write +
  pi_settings 原子替换 + 坏文件拒绝覆盖）；项目级 `<cwd>/.rpi/mcp.json`
  只读合并（同名项目级覆盖全局并出 warning）；**test_server 永不
  ok:true**——只做配置合法性校验（stdio command 可解析/PATH+PATHEXT、
  http URL 语法），错误文案指向"真实连通性请在会话内用 mcp_list/mcp_call"
  （宿主进程无法驱动引擎侧适配器，ok:true 就是乐观撒谎）。
  前端 bridge.ts/hermes.ts 补 error 透传（原来丢弃 ok:false 的原因）。
  命令名实为 `pi_mcp_remove_server`（非 delete），保持不变。
- **扩展/包管理面（pi_extensions.rs + pi_pkg.rs 重写）**：`pi_extensions`
  扫 `~/.rpi/agent/extensions`（判据照抄 install.rs 的 is_dynamic_library）
  + 反序列化 `~/.rpi/agent/native-packages.json`
  （`rpi_cli::install::InstalledNativePackage`，schema 零漂移）；
  旧 wire 8 字段 + abi/repository/target/size/mtime；手工 dll 照实列
  （registered:false，不编造 version）；`pi_pkg_list` = 全局登记表 +
  项目 `<cwd>/.rpi/packages.json`（**实查路径：不是
  .rpi/packages/packages.json**，上游 packages.rs:793 读外层）；
  install/remove/update 保留 Err 但文案准确（rpi install / rpi package
  link / rpi extension update；宿主不代跑 exe、不手改登记表——越信任
  边界）。pkg-manager.tsx UI 同步新行形状。
- **门禁**：cargo check 0 错 0 警 / cargo test **138**（117 基线 + mcp 9 +
  extensions/pkg 11 + 并发余量）/ tsc 0 / vitest 全量跑（本轮末）。
- **已知遗留**：①前端 toMcpServersMap 保存时丢条目 timeout/headers
  （编辑器层）；②plugins-tab 的 isDesktopRelevantPlugin 恒 false，扩展行
  不进该标签页（后端数据真、UI 过滤）；③set_model/set_thinking_level 需
  活动会话（无会话 → Err，规矩 12）；④thinking 档位不写盘（rpi
  save_settings 无读-改-写入口，会清未覆盖字段）。

## 模型页「模型目录」报错实锤与修复（2026-11-14 深夜，用户截图）

- 截图里的 **"rpi 引擎待接：模型目录（…尚无对应能力）"是旧构建残留**：
  该 unavailable 分支已在 915178f 删除（list_models 接真）。用户实际
  运行形态 = `vite preview --outDir %TEMP%\mirach-dist --port 1430` +
  `src-tauri\target\debug\mirach-harness.exe`（devUrl=1430，vite.config:7
  与主工程 1420 错开）——**改完必须三步才上屏：重建 dist（vite build
  --outDir %TEMP%\mirach-dist）→ cargo build → 重启 app**。另外本机
  debug 二进制**没有 CDP 9222**（9222 是旧 conf 的 additionalBrowserArgs），
  别再拿 cdp-probe 判定页面。
- **真缺口 1：API 模式不落盘**。rpi 没有协议自动检测——`ProviderConfig.api`
  缺省 = anthropic-messages，`openai-completions` / `openai-responses`
  必须显式（rpi-runtime/src/config.rs:201-215）。原表单"pi 无 apiMode
  配置——此控件不持久化"是旧 pi 时代假设：**OpenAI 兼容端点保存后会静默
  走 Anthropic 协议**（请求必失败且难查）。已改：表单 apiMode 可点选并写
  `entry.api`（选项值 = rpi 合法字符串；默认 openai-completions——本页
  定位就是"兼容 OpenAI 的端点"；编辑回显缺省 api 的条目显示
  anthropic-messages，与 rpi 推断一致）。
- **真缺口 2：pi_endpoint_validate 仍 Err**。已接真：宿主 reqwest
  GET `{base}/models`（去尾斜杠、可选 Bearer、20s 超时）；**HTTP 成败
  = 测试结论**（ok/status/models/message 如实返回，不抛 Err），只有空
  URL/非 http(s) 才 Err（规矩 12 的分界）；模型表解析兼容
  `{"data":[{id}]}` / `{"models":[{id}]}` / `{"models":["…"]}` 三形状；
  +2 单测。表单「测试」按钮可用。
- **端到端探针**（`%TEMP%\rpi-ext-probe\src\bin\models-probe.rs`）：表单
  形状 JSON → `load_models_config` + `provider_to_models` →
  `axet-proxy`(api=openai-completions) 正确映射 OpenaiCompletions；
  无 api 条目 → AnthropicMessages（rpi 缺省语义）——表单写盘与引擎解析
  形状对齐实锤。
- **环境实锤**：`~/.pi/agent/models.json` = `{"providers": {}}`（旧时代
  就是空表），`~/.rpi/agent/` 只有 extensions/registry——用户从未配过
  模型；截图里的 axet-proxy/gpt-5.4 是待新增。想用模型：设置 → 模型 →
  自定义端点填表保存（现在会正确写 api 字段 + 写 defaultProvider/
  defaultModel）。
- 门禁：cargo check 0 错 0 警；cargo test **140**（+2 pi_login）；tsc 0；
  dist + debug 二进制已重建、app 已重启。

## 设置页白屏 + 「关于」旧标签（2026-11-14 深夜，用户"设置页打不开了"）

- **白屏根因：OAuth 清单 wire 形状**。前端账号区读
  `setOauthProviders(r.providers)` 再 `.map`（providers-settings.tsx:240/
  341）；rpi 迁移降级版 `pi_oauth_providers` 错发**裸数组** `[]` →
  `r.providers === undefined` → `undefined.map` 抛
  "Cannot read properties of undefined" → 设置窗口整窗白屏（bodyLen 31）。
  旧 dist 里后端还是 `{providers:[...]}` 真形状所以此前没炸；重建 dist 后
  暴露。**已修**：返回 `{"providers": []}`（前端无入口可点 = 现状真相）。
  **教训：降级实现也必须保留旧 wire 形状**，否则前端渲染链整窗崩。
- **"pi agent rust 怎么没法删除"= 「关于」区硬编码旧引擎名**：
  settings-overlay.tsx:2049/2061 写死 `引擎 pi_agent_rust {version}`，
  引擎早换 rpi → 显示 "rpi 0.24.0"。已改标签为 `rpi`（version 来源 =
  pi_engine_version → rpi 工作区根 Cargo.toml）。注：G:\pi_agent_rust-main
  （265MB 上游源码树，未进 git）仍在磁盘上——仓库内的 vendor 已删干净
  （git 零引用），那个目录要不要删由用户定。
- **会话列表噪音修复**：`list_sessions` 在 `<workspace>/.rpi/sessions`
  不存在时原先 Err（控制台 "会话列表读取失败 os error 3"）；目录不存在 =
  从没跑过会话（正常态）→ 返回空数组，其它 IO 错误照常传播。
- **调试入口**：debug 构建 CDP 在 **9223**（tauri.conf.json
  additionalBrowserArgs，不是 9222）；`%TEMP%\cdp-settings-probe.mjs`
  可连目标抓 console/exception + DOM 摘要（Node ≥22 内置 WebSocket，无需
  ws 依赖）。白屏类问题先看 `Runtime.exceptionThrown`。
- 门禁：cargo check 0/0；cargo test **140**；tsc 0；dist+二进制重建、app
  重启（设置窗 bodyLen 31 → 35177 实证恢复）。
- **「发现模型」接真（同日续）**：rpi 引擎自身**不发现**（ModelsConfig
  只认显式 `models[]`；目录 = 内置 + models.json）。但 OpenAI 兼容端点的
  `GET {base}/models` 就是标准发现面：表单勾选「发现模型」→ 保存时先
  `pi_endpoint_validate` 探测 → 全量 id 写进 `provider.models`（按 id 保留
  既有逐模型配置：contextWindow 等）；探测失败**中止保存且错误可见**，
  并提示"取消勾选可只存默认模型"（不静默退化）。添加模型的三个入口：
  ①表单+发现（推荐）②表单不勾发现（只写默认模型一条）③模型页的原始
  JSON 编辑器直编 models.json。

## 真机端到端验证 + 单写者租约修复（2026-11-14 深夜，用户"在模型里试一下"）

- **实测全绿**（DS / cnkey.win / deepseek-v4.1-flash-1017）：设置表单
  填 → 保存 → `~/.rpi/agent/models.json`（`api: "openai-completions"` +
  apiKey + models[]）与 `settings.json`（`defaultProvider`/`defaultModel`
  camelCase）**由 UI 正确写出**；聊天发消息 → 引擎 resolve → 真实回复
  上屏（输入 41 tok / 总计 20563 tok）。UI 驱动方式：CDP 9223 →
  `Runtime.evaluate` 原生 value setter + input 事件填表、`[data-slot=
  "composer-send"]` 点击发送（**Enter 不触发发送**，assistant-ui 走按钮）。
- **真 bug：`agui_run` 每次 POST 都 `open_session(同一路径)`** → rpi 单
  写者 writer lease 冲突（"Failed to acquire writer lease … already
  held"），第二条消息必挂。修复：`PiEngine::is_live_session(path)` 守卫
  ——已是活动会话就复用、不重建 harness（agui.rs 主柄分支）；锁中毒 Err
  传播。**教训：rpi 会话单写者，任何"按路径重开"的代码都要先查在场态。**
- 遗留小项（同轮已修）：编辑器模型钮显示 "Select model" 的根因 =
  `composer-wired.tsx` 只认英文 `'no active session'`，后端真实文案是
  中文 **「无活动会话」** → 永远走"其它失败"分支 return，settings 默认
  模型回填从不执行。已改为两种文案都认；实测 trigger 显示
  `deepseek-v4.1-flash-1017`。**教训：跨语言错误文案匹配是雷区，宁可
  优先结构化错误码；至少中英双认并注释来源。**
- **发现模型端到端实证**：`GET https://cnkey.win/v1/models` → 200，2 个
  模型；编辑态表单不回显密钥 → 新增 **`pi_discover_models`**（服务端在
  apiKey 留空时从 models.json 借用已存密钥，JSON Pointer 转义）；UI 勾
  「发现模型」保存 → models.json models[] = flash + flash-1017（按 id
  合并既有配置），结果提示"已保存（发现 2 个模型）"；刷新后选择器两个
  都在、trigger 显示当前模型。
- 调试资产：`%TEMP%\cdp-fill-settings.mjs`（填表+保存）、
  `cdp-fill-discover.mjs`（发现+保存）、`cdp-send-click.mjs`（发消息+
  抓回复）、`cdp-verify-model.mjs`（trigger/选项）、
  `cdp-settings-probe.mjs`（console/异常）。刷新设置页会回到「账号」节，
  填表前先点导航「自定义端点」。

## 全 SDK 接线轮（2026-11-14 夜，3 子代理并行：会话树/设置页/用量）

- **致命陷阱：`Runtime::block_on` 不能在 tauri async 命令线程上直接调**
  （2026-11-14 实锤，表现为"点会话/新建会话没反应"）：tauri async 命令跑
  在 tokio runtime worker 上，直接 block_on 引擎 runtime 会 panic
  `Cannot start a runtime from within a runtime`，命令 promise 永不
  resolve。**修在 `PiRuntime::block_on` 一处**：检测
  `Handle::try_current().is_ok()` → 把 future 搬到独立线程
  （`thread::Builder` 16MiB + `spawn_scoped`，可借用、无需 'static）再
  block_on；`F: Send + F::Output: Send` 是代价。agui 早用 spawn_blocking
  线程绕开了这个坑，IPC 命令层漏了。**新增任何"命令层直接 block_on
  引擎"的代码前先想这条。**
- **会话面接真（pi_session.rs）**：`pi_get_messages`（rpi
  `find_entries_on_branch` + MessageEntry → hydrate wire）、`compact`
  （AgentLane::compact）、`sessions_usage` / `state.messageCount`（**会话
  文件行扫描**：harness.get_stats() 在恢复会话上实测恒 0）、`export_session_html`
  （rpi_cli::export；写临时文件再读回）、`fork`（JsonlSessionRepo::
  fork_typed + ForkOptions::Branch + release_writer_lease）、fork 点、
  兄弟分支（按旧 pi 语义自投影）、`switch_branch` / `retry_edit`
  （navigate_tree）、`session_lineage`（parent_session_id 反查路径）、
  时间线标记（ModelChange/Compaction 条目）。rewind/undo/redo/checkpoint
  保留 Err（rpi 只有条目级 label 与 durable 执行日志，无会话回退内核，
  文案已改准确）。
- **单写者租约二次实锤**：`open_session` 现在自带 `is_live_session` 守卫
  （同路径已是活动会话直接复用返回 id）——IPC 的 pi_open_session / 前端
  切页签 / bot-launch 全部受益；agui 的守卫保留。
- **pi_list_sessions 三修**：①会话根与引擎同源（settings.sessionDir 优先，
  原来硬编码 HOME 路径）；②跳过 `*.jsonl.progress.jsonl` 边车（原来当
  会话列出空 id 幽灵行）；③name/messageCount 走 rpi 只读快照
  （`JsonlSessionStorage::read_snapshot` + Session::get_name；原来只读首行，
  set_name 是 fact 条目不在 header，重启后名字/条数全丢）。实测
  messageCount 4 / 3 行列表无幽灵。
- **设置页补齐 rpi 全选项（settings-overlay.tsx +860 行）**：新增
  defaultThinkingLevel / hideThinkingBlock / thinkingBudgets /
  scopedModels / steeringMode+followUpMode / httpProxy / cdnBaseUrl /
  streamIdleTimeout / httpIdleTimeout / sessionDir / skillDirs+promptDirs+
  extensionDirs / defaultTools；TUI 专属（keybindings/editorPaddingX/
  terminal.*/quietStartup 等）明确跳过并注释理由；修正 compaction:null
  被误报"段不是 JSON object"的老 bug。**rpi settings 全表见
  G:\pi-rust-main\crates\rpi-cli\src\settings.rs（38 个字段，camelCase，
  无 snake alias）**。
- **用量聚合（pi_usage.rs 全量重写）**：扫 `~/.rpi/sessions/**/*.jsonl`
  行级聚合（按 provider/model、UTC 日、工具结果），wire 与旧 pi 形状
  零漂移；实测 41075 tokens/2 turns/favoriteModel DS。vault_sources 照
  df701a4 的纯 CLI 探测移植（bw/op）。OAuth/ask 保留 Err + 准确文案
  （OAuth 需加载扩展注册表 + rpi-extensions 依赖；ask 由插件工具提供）。
- **门禁**：cargo check 0 错 0 警 / cargo test **151**（140 + 会话树 3 +
  用量 8）/ tsc 0 / vitest **792**；真机 CDP 实证：new/open 秒回、
  hydrate 4 条（user/assistant 交替、tool 块保留）、fork 点 2 个、
  session usage 41075、state.messageCount 4。

## 插件生态深挖轮（2026-11-15）：对话框桥 / 状态投影 / 新检查点插件

- **插件对话框接真（ask_user / 权限确认）**：`ReloadContext`（session::build
  第三返回值，原先当 `_reload` 丢弃）里的 `ui_dialog: UiDialogMailbox`
  存进 HarnessLive 并立即 `try_attach_with_generation()`（不 attach 插件
  fail-closed）。`pi_ask_pending`/`pi_ask_response`/`pi_pending_approvals`/
  `pi_extension_ui_response` 全部改接邮箱：
  - 取用 = `take_pending_filtered(形状谓词)` 循环（ask 与 confirm 互不吞）；
    `is_pending(id)` 剪掉已答/超时条目。
  - 应答形状按插件源码契约（rpi-ask-user: `{values,kind}`/`{values,value,
    text,kind:input}`；permission-gate: `{values:[title]}`，answer 首值
    eq_ignore_ascii_case("yes")）。
  - discard/切会话：旧邮箱 `cancel_all()` + 清注册表。
  - 前端 ask-cards/approval-cards 改 **1s 轮询**（插件对话框不走 AgentEvent
    流——旧的 CUSTOM ask_request 信号在 rpi 下永不发生）。
  - **真机 E2E 闭环**：模型调 ask_user → 卡片（今日菜单/米饭/面条）→ 点选
    提交 → 插件回传 → 模型回复「你选择了：米饭。」（124 tok in / 9 out）。
- **插件状态投影（pi_plugin_state.rs）**：插件用 `AppendEntry` 写 custom
  条目，宿主投影只读：
  - `pi_todo_state` ← rpi-todo `customType="todo-state"`（`{todos:[{id,
    text,done,status}],nextId}`）→ `todo_list.v1` wire（pending→open /
    in_progress / completed→done），取当前分支 seq 最大一条；坏条目 Err。
  - `pi_mode_state` ← rpi-plan-mode `customType="plan-mode"`
    `{active,plan}` → `planMode` planning/off；approvalMode/planPending
    如实 null（rpi 无审批模式概念/无待审计划面）。
  - hub/job 保留 Err 且文案准确：subagents/orchestrator 状态只在插件进程
    内存（源码实锤无 AppendEntry/SetStatus）；background-tasks 未装且条目
    wire 缺字段（禁止编默认值）。
- **新插件 `rpi-checkpoints`（用户"没有的新做插件引入"）**：源码
  **G:\mirach-plugins\rpi-checkpoints**（cdylib，只依赖 rpi-plugin-sdk +
  serde_json；931 行，5 单测），DLL 已装 `~/.rpi/agent/extensions/
  rpi_checkpoints.dll`（探针：OK abi=4 tools=[checkpoint_mark,
  checkpoint_list, checkpoint_rewind] commands=[checkpoint]）。
  - mark = AppendEntry `customType="checkpoint.v1"` `{version,id,label,
    leafId,createdAt}`；list = GetSessionBranch 读分支条目（真读，非内存）；
    rewind = NavigateTree 跳**检查点条目 id**（不是 mark 前的 leaf——否则
    检查点被甩到旁支、list 再也看不到），校验 status=completed + 叶指针回读。
  - **rewind 在轮次内必失败**（lane_busy，宿主规则）：模型调用解释失败并
    提示在空闲提示符执行 `/checkpoint rewind <id>`；插件命令面就是这个入口。
  - **undo/redo（文件变更回滚）做不了**：rpi 无 FileMutationRecorder，
    任何 ABI 都读不回编辑前文件内容——插件源码模块头已写明范围外。
  - 真机 E2E：模型调 checkpoint_mark + checkpoint_list → 条目落盘 ×2、
    list 返回两处检查点、UI 正常渲染。
- **两个真 UI bug（用户实报）**：
  1. **Duplicate key toolCallId 崩渲染**：多工具调用回合里同一 id 的
     `tool_execution start` 到两次（SSE 重连重放/水合叠加）→ assistant-ui
     `useResources` 抛 Duplicate key 整窗炸。turn-actor 归约器改为**合并
     既有部件**（保留 result、合并 args/toolName）并 console.error 可见。
  2. **两个刷新钮**：MessageActions 的「重新生成」(↻) 与 regenerate-menu
     的「换模型重新生成」同为 RefreshCw → 后者改 **Shuffle** 图标 + 中文
     tooltip；**时间移到操作条末尾**（原先夹在按钮中间）。
- **成本展示删除（用户要求）**：消息页脚「费用 $0.0000」行与 composer 上方
  的 CostMeter 面板（`$0.0000 this run / $0.0000 session`）整体移除——
  rpi 的 usage.cost 恒有值（未配 models.json 价目恒 0）。cost-bridge 数据面
  保留（将来配价目/恢复展示随时可用）。
- **门禁**：cargo check 0/0 · cargo test **164** · tsc 0 · vitest **793**。

## 待办清零轮（2026-11-15）：bot 会话 / 子代理实证 / 三项不可做实证

- **bot 会话接真**：`create_bot_session` 从 Err 改为真实现——新增
  `build_harness_with(cwd, session_path, provider, model)`（resolve 带
  provider/model 覆盖；`build_harness` 委托它），再
  `set_system_prompt` + `AgentLane::set_active_tools` → 作为活动会话；
  命令层 `pi_create_bot_session` 照旧 rename 成 bot 名。真机实测：
  注入 SOUL「只回复'机器人已就绪'」→ 会话回复正好是「机器人 已就绪」；
  sessionId 返回、provider/model 覆盖生效。
- **子代理能力实证通过**：`delegate_task`（rpi-subagents 插件）——
  rpi-cli 的 `extensions_actions.rs:689` **实现了 RuntimeActionHost::
  child_agent**（trait 默认是 Err "not supported"），所以模型真能派子代理：
  实测模型回「子代理返回结果：2（completed，1 轮）」。**hub 花名册 UI
  仍不可得**：child 状态在 rpi-cli 进程内（`ChildAgents` 是 pub(crate)，
  无 AppendEntry/SetStatus），宿主没有任何读取面——保留 Err 是事实。
- **background-tasks 插件：上游包不可用于本引擎（实证）**：无预编译
  （rpi-extension.json 缺）；`rpi install rpi-background-tasks --build`
  源码编译 **5 个错**（E0061/E0133/E0277/E0425）——该 crate 针对的
  rpi-plugin-sdk 版本与本地 v0.24.0 不兼容。等上游更新前无解。
- **OAuth：无可用路径（实证）**：rpi-cli auth.rs 只有交互式 TUI
  （`run`/`run_with_extensions`，无 begin/exchange/poll 嵌入 API）；
  宿主桥 `rpi-extensions::oauth::request_oauth` 需要**已注册的 OAuth
  provider 插件**，而 rpi-package 没有 OAuth provider 扩展（24 个已装
  插件里也没有）——桥接代码会是死代码。凭据走 env key / models.json
  apiKey（设置页已覆盖）。保留 Err + 准确文案。
- **分栏 side / undo/redo：引擎结构性不可做（实证）**：rpi 非 main
  lane 的 `LaneHandle` 一律拒绝 run 操作（只读视图），side_prompt 无法
  实现；undo/redo 需要 FileMutationRecorder（rpi 全仓无此概念，任何
  ABI 都读不回改动前文件内容）。两者保留 Err + 准确文案。
- **门禁**：cargo check 0/0 · cargo test **164** · 真机：bot 会话、
  delegate_task、ask_user、checkpoint 四个插件面全部闭环。

## Duplicate key 崩溃的**两条**成因（2026-11-15，第二条晚到一轮）

用户两次报 `聊天渲染出错：Duplicate key toolCallId-… in useResources`：
1. **SSE 重连重放**：归约器只记录 lastEventId 从不比较 → 同一 seq 事件二次
   应用。修法 = 归约入口 `id <= 已应用游标` 整事件丢弃（console.warn）。
2. **水合/流竞态**（序号去重挡不住）：切会话/挂载时先 `pi_get_messages`
   水合（历史里已有该 toolCall 部件），而 SSE 是 **150ms 轮询**——水合前
   已产生、水合后才投递的 `tool_execution start` 再挂一份 → 同一
   toolCallId 两个部件。修法 = **投影幂等**：toolCallId 是自然键，部件已
   存在则整事件跳过（console.warn），不合并、不改写既有部件（result 由
   后续 end 事件填）。**这不是兜底**：事件流 at-least-once（重放 + 水合
   双源），幂等应用是协议契约；上一版"合并 + 静默"才是掩盖，已按用户
   要求删除。
   - 排查启示：`useResources` 只看**部件键**，任何"同一 id 出现两次"都炸；
     新增任何"从第二个源补状态"的路径（水合、插件投影、重放）都必须
     按自然键幂等。

## MOSS Live 真机协议（2026-11-15，key 配置后 E2E 实锤）

- **官方参考**：`https://platform.moss.cn/docs/reference/moss-live`（HTML 里
  内嵌协议表，可直接 WebFetch/Invoke-WebRequest 抓，不用 JS 渲染）。
- **握手顺序（缺一步就"聆听中但说话没反应"）**：
  `attach_session`（`delegation:{type:"client"}`）→ **`media.mode`
  `{binary_protocol:"tagged-v1"}`** → `mic_state {enabled:true}` → 上行
  二进制 `0x00 + PCM16 16kHz mono`（每个 WS binary 帧一个 0x00 前缀）。
  **不声明 media.mode 时服务端静默忽略所有二进制音频帧**（连接保持、
  不报错）——这是真机"说话没反应"的根因（已修 lib/moss-live.ts 的
  session_attached 分支）。可选 `video.state {source:"camera"}`（视频），
  `media.configure` 可改格式（默认 PCM16 16k 上行 / 48k 下行）。
- **下行**：文本事件 `action`（`input.transcript.updated/done`、
  `response.audio.started/context`、`response.audio.done`…）；二进制
  **无前缀** PCM16 48k（桥 base64 后 `moss-live://audio`）。持续发静音帧
  （官方要求，vad 靠连续性）；播放中保持采集支持 barge-in。
- **实测链路**（PowerShell 复刻同协议 + 合成语音）：补 media.mode 前 0
  事件；补后 `input.speech.started → input.transcript.updated(流式) →
  done → response.audio.started → 二进制音频块`。应用内 CDP：mic
  getUserMedia 正常（3 个输入设备）、btoa 帧持续产生；`pi_voice_live_status`
  `mode:moss-live/mossAvailable:true`。
- **key 落点**：`~/.rpi/agent/settings.json` 的 `voice.moss_live.api_key`
  （只写不读）+ `voice.voice_chat_mode:"moss-live"`。

## 构建工具换 huacnlee/cargo fork + egui 组件库调研（2026-11-14）

- **huacnlee/cargo fork 已装**（v0.102.0-9，基线 cargo 1.101.0）：替换
  `~/.cargo/bin/cargo.exe`，旧 rustup 代理保留为 `cargo.rustup.exe`。核心
  能力 = 每项目一个共享构建目录（`~/.cargo/targets/<name>-<hash>`，按主
  .git 键控，全 worktree 复用）+ registry/git 依赖全机编译一次（shared-deps）
  + 自清理 GC（闲置 1 天/总量上限）+ nightly Cranelift。**已实测**：fork-smoke
  构建落共享目录 ✓；mirach-harness 全量 check 入共享缓存（shared-deps
  3.4GB + 项目 1.15GB），增量 check 32.6s ✓。
- **安装事故与修复（重要）**：①rustup 的垫片（cargo/rustc/rustdoc/clippy 全
  家）是**同一二进制的硬链接**——直接 Copy-Item fork→cargo.exe 会**写穿硬链
  接**污染 rustc.exe 全家（特征：`rustc -V` 打印 cargo 版本）。修复 = 全部
  垫片从 `cargo.rustup.exe`（改名保留的原件）Remove+Copy 重放。**手工装
  fork 必须用 Staged Move-Item 而非 Copy-Item**。②fork 的**后台自动更新器**
  首跑把 cargo.exe 截断成 0MB——已永久禁用（User env
  `CARGO_FORK_AUTO_UPDATE=0`）。③最终用官方 install.ps1 打补丁（跳过下载步
  骤、用本地已验证资产）安装——其 Staged Move-Item + Restore-Rustup 垫片舞
  步才是正确姿势。④rustup 代理每次运行**自动修复垫片**——fork 就位后任何
  rustc/rustup 调用都可能把 cargo.exe 写回代理（huacnlee fork 自身如何长期
  保持 cargo.exe = fork 未深究，出问题重跑 install.ps1 即可）。
- **egui 组件库调研（用户问"有没有 dockview/assistant-ui 类"）**：
  dockview 类 = **egui_tiles**（rerun 出品，树形 tiles/tabs/拖拽/grid，
  生产级）+ egui_dock（仅二分）+ grimdock（2026-05 新）；assistant-ui 类
  **无对应物**——markdown = egui_commonmark(+extended)，chat widgets 有
  egui-components（gpui-component 移植）可看，对话流本质手写。清单已同步
  mirach-egui AGENTS.md 路线图口径。

## 内存排查轮（2026-11-14，用户："加了机器人和双全工的语音，运行内存暴涨
了很多"——点名两模块）

基线：渲染进程 Private 330MB / JS 堆 133MB / DOM 1340 节点（对照 11-10 记录：
冷启动 WS 392MB / 堆 112MB——堆 +21MB 属正常区间，"暴涨"发生在**语音会话
运行中/后**，代码审查锁定两处真泄漏 + bots 侧无泄漏）：

1. **moss-live.ts playQueue 只增不减（主泄漏，会话期间线性增长）**：下行
   音频每帧 push `{AudioBufferSourceNode, AudioBuffer}`，**只有 barge-in
   （stopPlaybackFor）摘队**——`onended` 只发确认不摘队、`response.audio.done`
   只读不清。AudioBuffer = 48kHz float32，1 分钟语音 ≈ 11.5MB 永久保留，
   长会话涨数百 MB。修 = **onended 自摘**（按 source 身份 filter）+
   `doneRuns: Set` 记账——completed 确认语义从"done 事件当下看队列"改为
   "done 记账 + 每次 self-摘队后复查"（原实现当下队列还有未播帧会**漏发
   playback.completed**，顺带修掉的协议缺陷）；teardown 补 doneRuns.clear()。
2. **voice-live.ts armSpeakingProbe 重臂不拆旧（边缘泄漏）**：'track' 事件
   每次到达都 new AudioContext，只覆写 `this.audioContext`——旧 ctx 不关
   （音频线程 + MB 级），finish 只关最后一个。多轨/重协商场景累积。修 =
   `disarmSpeakingProbe()`（interval + analyser.disconnect + ctx.close +
   lastSpeaking 复位），armSpeakingProbe 先拆再建；finish 改调同一方法。
3. **顺手删死字段**：MossLiveSession.`readonly audio = new Audio()`——
   MOSS 播放走 WebAudio（playbackCtx），该元素零消费方（grep 全树），每
   会话白造一个元素。

**bots 侧审查结论：无泄漏**（逐项）：SectionDialog 的 pushEscapeLayer/
dispose 配对（L1369-1372）；窗口监听均成对 removeEventListener；bot-face
= SVG（blobatarSvg 字符串，非 canvas）+ hermes createBudgetedLoop 预算化
rAF 时钟（idle → dormant 停 rAF，teardownCaches 存在）；stores 无无界数组
（groupChats log 用户驱动且小）；dockview 开合 = addPanel/removePanel 真
卸载。voice-live.ts 其余清理链完整（transcript 2000→1500 封顶 / finish 全
拆 / speakingProbe 封顶）。
**排查过排除的**：runtime.tsx SSE onerror 只记日志+连接态投影，重连走
EventSource 原生背退（无手写循环）；moss-tool-flow records 有界（≤128）；
moss 上行 uplinkBuf 按帧聚合（mute 时早退不积累）。
门禁 tsc 0 / vitest 792。**验证口径**：playQueue 修复逻辑经代码推演+
tsc（音频回放路径需要真 vendor 音频帧，mock E2E 未覆盖 binary 下行——
真 key 端到端时顺带验证）。

**"变成 700 多"的实测归因（同日晚些）**：渲染进程 WS 852MB / Private 835MB /
JS 堆 588MB（1 小时前 133）→ `HeapProfiler.collectGarbage` 后仍 566MB（真
滞留）→ 20s 空闲分配采样仅 448KB（**没有活跃增长源**）→ bot-face 时钟重入
守卫核对（`window.__hbFaceClock` wake 复用，无对手 rAF）→ **重启 exe 后堆
110MB 稳定、渲染进程 Private 253.5MB（-580MB）**。结论 = 本轮马拉松 dev
会话的 HMR/reload 滞留（十几轮组件补丁 + 多次 Page.reload + 面板反复开合；
dockview 重初始化 + assistant-ui/XState 树按补丁重建是两个滞留大头），与
11-10 的"HMR 累积，重启即回落"同签名，**dev 态现象，打包版无 HMR 不存在**。
排查法（可复用）：`HeapProfiler.collectGarbage` → `performance.memory` 分
滞留/垃圾 → `startSampling/getSamplingProfile` 排活跃分配 → 重启对比。
**dev 工作流建议**：长会话多补丁后定期重启 exe；heap 异常先重启再归因。

**打包态实测 + "全应用 100MB"方法清单（2026-11-14，用户问"怎么才能全应用
100MB 以内，Tauri 不是占用低吗，怎么比 Electron 还高"）**：
- **同一 exe 只换前端产物（vite build → 静态服务）实测**：JS 堆 110→**25MB**
  （-77%）、主渲染 Private 264→**147.6MB**、全应用进程树合计（递归）**321.8MB**
  = host 8.6 + browser 30.9 + **renderer 140.2** + GPU **112.7** + utilities 28 +
  conhost 1.4。dev 态损耗（未打包 250 ESM 模块/13.8MB 源/11.5 万 scopes/
  react-refresh）占当前数字近一半。
- **"Tauri 占用低"的真相**：轻的是 Rust 侧 + 打包体积（不带 Chromium/Node
  二进制）——host 8.6MB 就是那一半；Windows 上 UI 跑 WebView2 = 完整
  Chromium，内存与 Electron 同量级。系统共享的只是 WebView2 **二进制**
  （磁盘），每个 app 独立 user-data-dir → 独立 browser/GPU 进程实例，**内存
  不共享**。GPU 进程 112.7MB 是下一个大头（合成器，随窗口/内容伸缩）。
- **全应用 ≤100MB 的方法清单（按现实性）**：
  1. **WebView2 低内存模式**：wry 0.57 已有 `WebView::set_memory_usage_level
     (Normal|Low)`（→ ICoreWebView2_19::SetMemoryUsageTargetLevel，官方空闲
     瘦身/可挂起渲染器），但 **tauri 3.0.0-alpha.4 / tauri-runtime-wry 三层
     均未透传**（grep 零命中）——实现路径 = `with_webview`（webview/mod.rs
     L173，文档即 webview2-com controller 示例）直调 COM + 空闲检测（无输入
     + 无活动 run 5min → Low，交互即 Normal）。**唯一不换架构能逼近 100MB
     的路径**（预计闲时 ~150-200；隐藏+TrySuspend 更低）。
  2. 页面子树懒加载：模块数/代码/上下文/字符串四桶同步缩（capabilities/
     cron/bots/review 全静态 import）。
  3. 换原生 Rust UI（egui/iced/Slint）：全应用 40-80MB 真可达——但 = 重写
     整个前端栈（assistant-ui/dockview/xterm/shiki 全弃），产品形态级决定。
  - 结论：**"用着的全应用 100MB"在任何 webview 架构下不可达**（browser+GPU+
    utilities ≈ 170-180MB 架构死数）；"闲时 100MB"只能靠 1。
- 实验陷阱：1430 曾被漏杀的 vite dev 占着（命令行形态 `vite.js --port 1430`
  与 `vite --port 1430` 不同，按 CommandLine 正则匹配漏掉）——打包态测量前
  必须确认 1430 owner 是 preview 不是 dev（Get-NetTCPConnection OwningProcess
  + Win32_Process CommandLine 双查）。实验后遗留状态 = exe 跑在 preview
  （打包前端）上；恢复 dev = 起 vite dev 再重启 exe。

**"256 是什么"拆解（同日，用户追问主渲染进程构成）**：HeapProfiler 快照
自算 175MB self（276 万节点）+ 非堆 ~150MB。堆构成：**(native) 96MB（33.4
万对象 = Blink 对 1551 DOM 节点 × 3041 CSS 规则 + 大量自定义变量的 C++ 侧
伴生存储——样式体系的功能性成本，非泄漏）** / strings 20MB（47.6 万条）/
code 17MB（250 个 dev 模块字节码，源码 13.8MB）/ Object+Array ~24MB
（6531 FiberNode）/ scopes ~3MB（**11.5 万条**——dev ESM 每函数作用域一个）。
非堆 = GPU/图像字体缓存/网络/WebView2 内部。**三层结论**：①这是完整
Chromium 总账单（空白页对照：渲染器 18.8MB + 共享进程 ~200MB 地板）；
②dev 放大器 = 未打包 ESM + 无 tree-shake（打包版降 30-50%）；③能压的 =
页面子树懒加载（capabilities/cron/bots/review 全静态 import → 动态，预计
渲染 264 → ~200-220MB）。用户记忆的"8MB" = Rust 壳进程（今天闲时 9.3MB，
没变过）；壳与 WebView 是两类进程，Task Manager 分行显示。

## 宿主插件体系 + 多环境连接 + pi 包管理（2026-11-07）

用户："将hermes的多环境配置配合pi本身的pkg，做成插件，完整复刻"。
**设计全文与源码锚点 = `docs/HANDOFF-multi-env-pkg.md`**（hermes connections
registry 逐行核对 + pi PackageManager pub 面 + 宿主插件体系设计），实现
按文档清单落地：

### 插件体系（`src/contrib/` 三文件）

- **`types.ts`**：`Contribution { id, area, source?, title?, render?, data? }`
  + `HarnessPlugin { id, register(ctx) }` + `PluginContext { register,
  storage, onDispose }`——hermes `contrib/types.ts:25-51` /
  `contrib/plugin.ts:181-194` 最小复刻。
- **`context.ts`**：`createPluginContext`（贡献 id 自动 `plugin:<id>:` 命名
  空间 + source 印 `plugin:<id>`——hermes :348-375 同语义）+
  `activatePlugin`（跑 register → 按 area 索引的贡献表）。
- **`plugins.ts`**：bundled 注册表（静态 import，首批 mirach-connections +
  mirach-pkg），`activateBundledPlugins()` 幂等聚合；注册失败 console 可见
  贡献缺席（hermes runtime-loader 错误隔离同语义——不是能力边界）。
- 贡献区首批两个：`settings.page`（设置页导航项）+
  `bots.roster.grouping`（花名册按连接分组的数据贡献）。按需扩区。

### 连接注册表（`pi_connections.rs` + `contrib/mirach-connections/`）

hermes `connection-registry.ts` v2 模型的宿主移植（数据面 Rust + UI
connections-registry.tsx）。存储 `~/.pi/agent/connections.json`（pi agent
目录 = 宿主真实数据目录；pi_cron 同 precedent）。

- **不变量**：local 恒在不可删（删 primary 重定向 local）；label 大小写
  不敏感查重；remote/cloud 按 URL 查重（normalize 尾斜杠）；ssh 按
  `user@host:port#profile` 查重；kind 创建后固定（hermes 同规则）。
- **真假分界**（用户："可以做假ui，但是标红显示"）：local = **真面**
  （test 走引擎快照读取——`state.inner().clone()` 解出 Arc 再搬进
  on_big_stack，State<'r,T> 不是 'static）；remote/cloud/ssh = 条目/表单/
  持久化全真，**test 返回 `{ok:false, stub:true}`** → UI 红显"远端 gateway
  未接通"。token 暂不入库（tokenSet 恒 false；接入 pi_vault 属后续）。
- 设置页消费（`settings-overlay.tsx`）：SectionId 加 `` `plugin:${string}` ``
  动态臂 + 插件集成组 items 由贡献填充 + render 分流（activeSection 以
  `plugin:` 开头 → 查贡献表 render）。NAV_GROUPS 静态定义不动——消费点改
  ALL_NAV_GROUPS/ALL_NAV_ITEMS（含插件页的合并版）。

### 包管理（`pi_pkg.rs` + `contrib/mirach-pkg/`）

直调 vendored `PackageManager` **blocking** 变体（npm/git 子进程在大栈线程
跑）——install/remove/update/list + add/remove_package_source（源列表落
settings.json 只走上游 :881-926 官方通道，宿主不自己读写）。**全真实数据**。
**类型坑**：`PackageFilter` 无 Serialize——entry_to_json 手拼四键（形状
稳定的 Option<Vec<String>>）。

### 实机验证（settings 独立窗口 CDP 直测）

`?win=settings` 是独立 CDP target（`win=settings` URL 参数分派）——导航含
「连接」「包」两项（插件集成组从空态变有货）；连接页渲染 + 添加远端连接
+ 注册表持久化 + 清理全通；包页渲染 + 空态。IPC：connections list/save/
remove/test（local 真测/remote stub）+ pkg list 全通。

### 机器人页接缝（花名册按连接分组）

`BotPreset` 加 `connectionId?: string`（缺省 = local）；`bot-launch.ts` 对
非 local 连接的启动返回 false（红显"归属远端连接——gateway 未接通"）；
`bots-pane.tsx` 在 connections.length > 1 时按连接分块（local 头正常色、
远端头红显"未接通"）；`bots-dialog.tsx` 加"创建在连接上"选择器
（connections.length > 1 才显示 + 远端标红提示）——hermes create-dialog
:641-671 "Create on connection" 同位。**单 local 连接时与之前的 UI 零
差异**（无多余分组头/选择器），多连接才浮现。

## 设置页新增两节（2026-10-26）：个性 / 使用统计

### 个性（基础设置 → 个性）

openhuman 的 `PersonaPanel` 全量移植（`app/src/components/settings/panels/PersonaPanel.tsx`
343 行 + `panels/persona/` 四个文件）。落点：

| 面 | 上游 | 宿主 |
|---|---|---|
| 身份（显示名/描述） | redux-persist 的 `persona` slice | `lib/persona-store.ts`（zustand + localStorage，键 `mirach:persona`，上限 80/500，**超限拒绝不截断**） |
| 角色（SOUL.md） | core RPC `openhuman.workspace_file_{read,write,reset}` | `pi_persona_read/write/reset`，文件 = **`~/.pi/agent/SOUL.md`**，上限 256 KiB，缺失回落 bundled 默认（`isDefault: true`） |
| 注入 | core 自己读 | `create_session_opts` 把内容喂 `SessionOptions.append_system_prompt`（**追加**，不覆盖内置提示——覆盖会丢工具使用契约） |

`personaSections.ts` / `personaTemplates.ts` 是**逐字复制**的纯函数（无损 splice
受管小节 + 六个角色种子文本）。改这两个文件前先看上游有没有同步。

**不要**把身份两字段写进 SOUL.md：它们是"应用里怎么显示助手"的界面字段，
进 SOUL.md 就变成模型输入了。

### 使用统计（安全与数据 → 使用统计）

ZCode `AppUsagePanel` 的移植。ZCode 的用量页有两个 tab，**只有一个能移植**：

| tab | 上游数据 | 宿主 |
|---|---|---|
| App Usage | 本地 session 聚合 | ✅ `pi_usage_snapshot(range)`（pi `stats::aggregate`），概览条 + 52 周热力图 + 按天趋势 + 按模型占比 |
| Coding Plan | 云端 monitor API（订阅额度/重置时间/权益） | ❌ 宿主没有订阅账户与该端点。页面底部如实说明，**不渲染 0 冒充** |

**不可得字段返回 null，UI 隐藏对应格子**（不是 0）：pi stats 不记录
`avgTimeToFirstTokenMs` / `avgTurnDurationMs` / `toolErrorRate` /
`modelErrorRate` / 会话时长。`by_day` 也不带 model 维度，所以没有
"每日按模型"图（ZCode 那张图的数据宿主拿不到）。

**图表不引新依赖**：上游用 recharts（ZCode 自己也要 lazy 隔离它的
decimal.js-light 启动副作用）；宿主用内联 SVG 折线 + 横向堆叠条，
配色照 `appUsageChartPalette` 的 6 色。

## 技能与工具：hermes SkillsPage 的完整移植（2026-10-26）

用户："左侧栏的技能与工具完全复制 hermes 的" + "选 2（完整版），做成一个插件
集成 rust 的" + "独立页面（同 hermes）" + （纠偏）"hermes 是直接换了对话区，
你再看下逻辑"。

### 形态：替换对话区，不是新开面板

hermes 的 `/skills` 是**顶级路由**（`web/src/App.tsx:166` `"/skills":
SkillsPage`）——点侧栏「Skills」**替换对话区**，聊天不可见。宿主第一版做成了
面板栏新开标签页（错），第二版改成 dockview `workspace` 组件内的视图开关：

- `main-view-store.ts`：`view: 'chat' | 'capabilities'`；
- `main-workspace-pane.tsx`：按 store 切换 `AssistantThreadPane` 与
  `CapabilitiesPane`；
- 回到聊天的路径（与 hermes 导航同语义）：侧栏点会话行（resume →
  `showChat()`，钩子在 thread-list 的 `onClickCapture` resume 分支）、
  侧栏点「新建会话」。

**聊天保持挂载只隐藏**（`display:none`，包装层可见时 `display:contents`）：
流式 run 运行在 AssistantThreadPane 里，卸载会拆掉流 UI；hermes 嵌入式形态
下 ChatPage 同样常驻（`App.tsx:148` "Chat is rendered persistently"）。

### 数据面：pi_capabilities.rs（Rust 写面）

hermes 的数据面是 REST（`/api/skills`、`/api/tools/toolsets`）；宿主换成 IPC：

| hermes | 宿主 | 备注 |
|---|---|---|
| `getSkills`（name/description/enabled/category） | `pi_capabilities` | pi 无 per-skill 开关 → 宿主存禁用集 |
| `toggleSkill` | `pi_set_skill_enabled` | 落 `~/.pi/agent/harness-capabilities.json`（不进 settings.json——那是 pi 的 schema） |
| `getToolsets` | `pi_capabilities` | **pi 没有 toolset 概念** → 宿主把 `KNOWN_TOOL_NAMES`（tools.rs:5607）按语义分 17 组 |
| 工具集启停 | `pi_set_toolset_enabled` | 映射到 `SessionOptions.enabled_tools` |
| SkillEditorDialog | `pi_read/write/delete_skill` | 落 `~/.pi/agent/skills/<name>/SKILL.md`；校验规则逐条照抄 `resources::validate_name/description`（pub(crate) 拿不到，复刻 + 常量同源） |
| Hub 浏览 | ❌ | hermes 搜自己的技能库；pi 无技能市场 → 页面如实说明 + 列出可放 SKILL.md 的目录 |

**技能提示由宿主渲染**（这是"技能开关"能生效的唯一位置）：pi 的
`SessionOptions.skills_prompt` 是宿主提供的字符串（`sdk.rs:399`，pi 自己不扫
skills 目录；ACP 同款 `acp.rs:1825`）。链路 = `load_skills`（pi 原生 loader，
语义零漂移）→ 按禁用集过滤 → `format_skills_for_prompt`（`resources.rs:1365`）
→ 建会话时喂 `skills_prompt`。

**工具集的双向语义**（实测踩坑）：组启用 = (在默认集 且 不在禁用集) 或 在
显式启用集。只存禁用集一个列表的话，opt-in 组（memory/media/browser/
computer/github/python/security/skills/subagent）永远开不了。无任何开关时
会话**不传** `enabled_tools`（让 pi 用自己的默认集，升级自动跟上）。

### 守卫（pi_capabilities.rs tests，5 条）

- `every_pi_tool_belongs_to_a_toolset`：pi 加新工具而分组表漏掉 → 失败；
- `default_toolsets_match_pi_cli_default`：默认组覆盖必须精确等于 pi CLI 的
  `--tools` default_value（cli.rs:538，逐字）——多一个 = 用户没开就有额外
  能力，少一个 = pi 默认能力被静默砍掉；
- opt-in 开关双向语义 / untouched prefs yield None / session tools 两向合成。

### 前端

`capabilities-pane.tsx`：左分类栏（筛选头 + 全部/工具集/浏览中心 + 分类计数）
+ 右三视图（技能行带开关/编辑/删除、工具集三列卡片网格、hub 不可用说明）+
顶栏（`enabledOf` 计数 + 搜索 + 刷新）+ SkillEditorDialog +
ToolsetConfigDrawer。分类用 pi 的 `source`（user/project/package）聚合——
hermes 的 category 是它技能库的元数据，pi 没有，不编造。

原 `pi-resources-dialog.tsx`（只读三 tab 浮层）已删除——两个入口必然漂移。

## 定时任务：hermes cron 的自包含移植（2026-10-31）

用户："A 能做成插件集成吗，能的话直接开始"。核实后：**能，但形态是
"自包含模块"而不是 pi 扩展**——理由见下，这条结论不要再重新论证。

### 为什么不是 pi 扩展

| 形态 | 能否承载 | 依据 |
|---|---|---|
| pi 扩展（QuickJS） | ❌ | 扩展生命周期**绑会话**：`ExtensionRegion` 归 `AgentSessionHandle`，`sdk.rs:3586` 的 `has_extensions` 要求该会话传了 `extension_paths`；会话结束扩展就停。调度器必须**无会话时**触发——根本矛盾。宿主也**一个扩展都没加载**（`src-tauri/src` 里 `JsExtensionRuntimeHandle::start` 零调用）。 |
| 宿主前端插件系统 | ❌ 不存在 | `src/contrib/` 只有 `.gitkeep`；没有 contribution registry / routes 区域 / 插件 API。hermes 的 `contrib/wiring.tsx`（1,446 行注册表）没移植。 |
| **自包含模块** | ✅ | 独立 `pi_cron.rs` + 独立 `pi_cron_*` IPC + 独立存储 + 独立面板。可整体摘除。 |

### 文件落点

| 面 | 路径 |
|---|---|
| 后端（全部逻辑） | `src-tauri/src/pi_cron.rs`（存储 / 调度解析 / tick / 执行 / 蓝图 / IPC） |
| 前端页面 | `src/hermes-mirror/app/cron/`（上游 6 文件逐字复制） |
| 前端侧栏区 | `src/hermes-mirror/app/chat/sidebar/cron-jobs-section.tsx` |
| 数据面适配 | `src/hermes-shim/api/cron.ts`（REST → IPC） |
| 宿主挂载 | `components/panes/cron-pane.tsx` + `hub/sidebar-cron-section.tsx` |

### 五条硬约束（每条都是实测踩出来的）

1. **线上形状必须是 snake_case**。Rust 内部 `Job` 是 camelCase（jobs.json
   可读），但镜像来的页面读 `job.schedule_display`（`index.tsx:144`）/
   `job.next_run_at`。`job_to_wire()` 是投影层——**不要**给 `Job` 加
   `rename_all = "snake_case"`（那会让已有 jobs.json 读不出来）。不投影的
   表现是"频率/上次/下次"全显示 `—`。
2. **tick 必须先持久化推进再执行**（at-most-once，上游
   `scheduler_tick.py:160` 同款）。中途崩了重启不能重放。
3. **运行权守卫按作业隔离**（`RUNNING` 内存集合）。手动「立即触发」走
   IPC 线程池、ticker 走自己线程，两者能同时选中同一作业。跳过 ≠ 失败：
   `RunOutcome.skipped` 不写 `last_status`、不进台账。
4. **执行用独立会话**（`SessionOptions.session_dir` = `<cron>/sessions`），
   绝不能碰用户的 `PiEngine` 活动 handle。
5. **测试必须用 `CRON_DIR_OVERRIDE`**（`with_temp_cron_dir`），不能只改
   环境变量：`Config::global_dir()` 在 Windows 走 Known Folder API，
   改 `USERPROFILE` 无效；只改 `PI_CODING_AGENT_DIR` 会出现"作业进临时
   目录、pi 会话进真实 `~/.pi`"的半隔离（实测污染过
   `~/.pi/agent/cron/sessions`）。

### 有意的裁剪（代码里都有注释，不要当缺陷修）

- **投递只有 `local`**：宿主没有任何消息平台适配器（Telegram/Discord/
  Slack/Email/bot-chat 全无），`getCronDeliveryTargets()` 如实只返回一个。
  蓝图的 deliver 槽也因此只列 `local`（列了平台就是下拉框里点不动的项）。
- **monitor gate / wake gate 脚本闸门未做**：依赖 hermes 的 script 沙箱语义。
- **无 profile 多路复用**：宿主单配置。
- **无跨进程锁**：单进程单 ticker（hermes 的 flock 是为 gateway + CLI 并发）。

### 蓝图：16 个全部实现（2026-10-31 补）

**先前的裁剪是错的**，已推翻：我曾以"上游蓝图指向它自己的技能库"为由返回
空数组，但核实后 16 个里只有 5 个带 `skills`（morning-brief /
important-mail / weekly-review / price-watch / competitor-watch），其余 11 个
是纯 prompt 模板。正确处理：

- **16 个全部照抄**（key/title/description/category/schedule_template/
  prompt_template/slots/tags 逐字），落在 `pi_cron.rs::blueprints()`。
- **只去掉 `skills` 字段**，把那 5 个蓝图里"跑某个技能的过程"改写成
  **自包含指令**（每个都有一行注释写原文怎么说的）。这样蓝图可用，
  也不假装技能存在。
- **修正一个上游数据 bug**：`competitor-watch` 的 `recurrence` 槽是
  `weekdays` 类型（options = everyday/weekdays/weekends），上游却把默认值
  写成 `"monday"`——上游自己用默认值填槽也会抛
  `unknown recurrence 'monday'`。改成 `weekdays` 并在代码里注明。

**两条硬约束**（有测试守着）：

1. **每个蓝图用默认值都必须填出可解析的调度**
   （`every_blueprint_fills_with_defaults_and_parses_as_schedule`）。这条
   守着"模板引用了不存在的槽"与"拼出来的 cron 不合法"。
2. **`hydration-move` 必须用小时字段步长**，不能用分钟字段 `*/90`——
   上游注释（`blueprint_catalog.py:408`）明说 cron 的分钟步长会按小时回绕，
   `*/90` 与 `*/120` 都退化成每小时。

前端零改动：镜像来的 `index.tsx` 已经在读 `getAutomationBlueprints()`，
`blueprints.tsx` 的 `BlueprintSlotControl` 已支持四种槽类型。

### 补了 4 个上游 zh 缺失键

`lastRunFailed` / `editJob` / `runAgain` / `overdueSince`——en 有 zh 没有，
缺失时界面中英混排（实机看到 "Last run failed: / Edit job / Run again"）。
按规矩 1 的 i18n 三件套例外补齐，位置在 `i18n/zh.ts` 的 cron 段。

## 模型选择必须是"真的"（2026-10-26 修）

用户报："无论选哪个用的都是之前设置的，甚至不在模型选择器里的模型"。
两个独立成因，都已修：

1. **`pi_set_model` 只切当前会话，不写回默认值**。新建会话走
   `create_agent_session`，模型来自 `settings.json` 的
   `default_provider/default_model`。不写回 → 用户选的模型只活到本次会话
   结束；旧默认值若已失效（provider 不在 models.json），pi 回落到内置目录
   第一项 —— 于是"选哪个都用之前那个，甚至不在选择器里"。
   **修法**：`PiEngine::set_model` 切换成功后调
   `pi_settings::persist_default_model`（读-改-写 settings.json，只动这两个
   键，其余字段原样保留）。无活动会话时也写回（用户意图仍然有效）。
2. **`pi_list_models` 传 `None` 当 models_path**，只列内置目录——
   用户在设置页自定义的 provider（models.json 的 providers 表）在选择器里
   根本看不到。**修法**：传 `default_models_path(&Config::global_dir())`。

前端两处配套：无会话时读 `pi_get_settings` 的默认值显示（不退回
`models[0]`）；切换失败的错误上到工具栏（此前只进 console，用户看到的是
"选了没反应"）。

## beui 组件：本地副本与上游的关系（2026-10-23 核对）

**先查事实，再改组件。** 设置页那轮"为什么和 beui 不一样"的结论：

1. **`animated-sidebar.tsx` 从来没下载过**。`6ffe097` 那笔提交只拉了 17 条
   registry（tabs/theme-toggle/bouncy-accordion/animated-toast-stack/
   animated-number/number-ticker/digit-swap/popover/tooltip/context-menu/
   file-tree/shared-layout-bg/select/input/breadcrumb/date-range-picker/
   alert/color-picker），没有 sidebar。此前设置页左导航是**手写 CSS 复刻**。
2. **已下载的有一半被裁过/漏文件**（用 `https://beui.dev/r/<name>.json`
   逐文件比对得出）：
   - `tabs.tsx` 381 行 vs 上游 672 行——丢了 `icons="selected"` 图标弹簧、
     **方向键/Home/End 导航**、roving tabindex、panel 注册、tracked pill
   - `select.tsx` 少 80 行，且 **`use-listbox.ts` / `use-on-open.ts` /
     `use-row-cursor.ts` 三个 hook 根本没下载**
   - `shared-layout-bg.tsx` 少了 `onFocus`/`onBlur` 段 → **键盘焦点不驱动
     pill**（鼠标有、键盘没有）。已按上游补回。
   - `lib/ease.ts` 是**有意**重写的（读 CSS 令牌 `--beui-spring-*`，
     令牌唯一源头），不要"同步"回上游字面值。

**核对脚本思路**（不要凭印象判断"是否和 beui 一致"）：拉
`https://beui.dev/r/<name>.json`，对 `files[].content` 与本地逐文件做
规范化行集比对，输出 `IDENTICAL / DIFFERS(reg-only, local-only) / MISSING`。
`animated-sidebar` 的 registry 依赖是 `clsx / lucide-react / motion /
tailwind-merge`，`registryDependencies: []`。

**落地裁剪的口径（用户 2026-10-23 定）**：页面级骨架与陷阱删掉，菜单结构
与动效全留。已删：`AnimatedSidebarProvider`（收起状态机 + **Ctrl/⌘+B 全局
快捷键劫持**）、`AnimatedSidebar`/Rail/Inset/Header/Footer/Trigger/Close、
`MobileSidebar`（`createPortal` 抽屉 + **body 滚动锁** + 焦点陷阱 + inert）、
折叠态分支（icon rail / `--sidebar-width-icon`）、`useIsMobile`。
保留：`Group` / `GroupLabel` / `GroupContent` / `Menu` / `MenuItem` /
`MenuButton` / `MenuSub` / `MenuSubItem` / `MenuSubButton` +
`layoutId` 滑动 pill + `clip-path` 子级 stagger + `whileTap` 按压。
本地扩展 props：`sectionId`（渲染 `data-section-id`）、`tabIndex`（roving）、
`activePillClassName`（见下条），以及 2026-11-23 的 `sharedHover` /
`sidebarRow`（见下条）。

**2026-11-23 滑动悬停块两处修正（用户实报）**：

- **设置页左栏可展开节支持再点收起**：`settings-overlay.tsx` 的
  `collapsedSubmenus`（`Set<SectionId>`）——再点当前选中的可展开节 = 收起；
  切节 / ↑↓ / 深链 `mirach:settings:section` 走 `activateSection()` 自动展开。
  `aria-expanded` / chevron 跟 `submenuOpen`（不是单纯的 `isActive`）。
- **设置页子项接入滑动悬停**：`SharedLayoutBg` 的 pill 是**每组一份**且只
  认直接子项——子项在父项 li 内部，永远吃不到（用户："子项没有滑动效果"）。
  设置页改用 `AnimatedSidebarMenu sharedHover={false}`（不再注入每组 pill）
  + nav 容器层的 `AnimatedSidebarHoverPill`：按 `[data-sidebar-row]`
  （`AnimatedSidebarMenuButton sidebarRow` / 子项按钮）现测矩形，组头与
  子项共用一条 pill。坐标公式同 `SessionListHoverPill`（abs 随内容滚动 →
  top 含 `scrollTop`；`.set-nav` 补 `position: relative`）。
  **其它三处 SharedLayoutBg 消费点（入口条 / 文件树 / 按组菜单）语义未动。**
- **主窗会话列表 `SessionListHoverPill` 与可折叠组头**：指针命中
  段头/日期桶/工作区桶/状态桶 → **淡出 pill**（不再停在上一行，也不与
  组头的 hover 反馈"打架"）——但**只 suspend、不清 `shownRef`**（2026-11-23
  用户实报"滑动组件没有滑动的效果了"：分组模式行间夹着分隔线，旧实现每次
  命中都 `hide()` 归零滑行状态，下一行只能重新淡入）。位移曲线统一用
  `SLIDE_EASE_CSS`（`lib/ease.ts`，easeOutCubic）+ **top 260ms**——原
  `EASE_OUT_CSS` 是 expo（60ms 吃掉 80% 距离），45px 行位移看起来像瞬跳。
  锚定行被卸载或开始播
  `.disclose-row--closing` → MutationObserver 全量收起（收起组后不再残留旧
  几何）；其它行增删位移 / 列表滚动 → 重测（滚动用 `elementFromPoint`，
  pointerover 不因滚动触发）。行间 1px 间隙仍不动作（逐行滑过不闪断）。
- **设置页 `AnimatedSidebarHoverPill` 同规则**：组标题/空态走 `suspend()`，
  跨组选下一项仍保留 top/left 滑动过渡。

**2026-11-23 机器人页选中底 + 输入框圆角（用户："机器人页也用这个组件
选择，对话输入框的圆角改成20"）**：

- **机器人名单选中底改为滑动 pill**：新 `hermes-bots/roster-active-pill.tsx`
  挂在 `[data-slot="bots-roster"]` 滚动容器（`relative` + top 含 scrollTop），
  读唯一 `[data-roster-active]` 行现测矩形；行由 `bot-row.tsx`（bot 行 /
  GroupRow）与 `canonical-group-row.tsx` 写该属性。**行 class 不再画**
  `bg-(--ui-row-active-background)`（否则 pill 被同色行底盖住），行补
  `relative` 绘制在 pill 之上。MutationObserver 盯 `data-roster-active` /
  childList，ResizeObserver 兜行高变化；首次出现只淡入，之后换行才滑。
- **composer 圆角 20**：主输入卡的 `rounded-[32px]` 改 `rounded-[20px]`
  （`assistant-ui/elements/composer.tsx`，padding/gap 不动）；同时把
  `thread.aui.tsx` 的 `--composer-radius` 32→20（编辑消息 composer /
  ask·approval 卡 / 附件 tile 的 calc 同源）。


**颜色必须接回 mirach 令牌**：beui 全用 shadcn 令牌（`text-muted-foreground`
≈#7a7a7a、`bg-muted` ≈#f2f2f2）。照抄会让 ①组标题与行文字**同一个灰**
（层级只剩字号）②选中与悬停**几乎同色**（差 1.2% 亮度）。已在
`overlays.css` 用 `.set-nav [data-slot=...]` 前缀覆盖颜色（不改动效/尺寸）：
组标题 → `--text-4`，行 → `--text-2`，悬停/选中 → `--text`；
选中 pill 底色走 `activePillClassName="bg-[var(--scale-gray-a4)]"`。

**beui 没有横跨两栏的顶栏**（用户 2026-10-23 指出）：骨架是
`<aside>`（自带 header）+ `<main>`（自带 header），不是 hermes 的
`grid-template-rows: auto …` + `grid-column: 1/-1`。设置页已改为
`.set-card--split`：**单行两列**，左栏 `.set-rail` 是一整块（内部 flex
竖排 `nav-head`(48) + `nav`(1fr)），右栏 `.set-content` 跨满高（内部
`inset-head`(48) + `.set-scroll`(1fr)）。

**左栏必须包成一个 `.set-rail`**（2026-10-23 二次修正，用户报"左栏设置的
下面有横线 / 整个页面还有个白色的顶栏"）：第一版把 `nav-head` 与 `nav`
做成两个 grid 单元格，同时引发三个症状——
①head 是卡片白底、nav 是 #fafafa → 交界色阶被看成**横线**；
②head 只 172px 宽但与右栏 668px 的白底头同高无缝 → 840px 白色横条被看成
**顶栏**；③`.set-nav` 的 `border-right` 只画在第二行 → **竖分隔线在顶部
48px 断开**。
修法：背景 + `border-right` + 圆角裁切全部上移到 `.set-rail`，`nav-head`
与 `inset-head` 都**不画底部分隔线**（上游 inset header 也没有）。
实测：`x=500` 的 `y=200..225` 全 `250,250,250`（无接缝）、`x=800` 全
`255,255,255`（无横线）、`x=631` 竖线从 y=170 到 y=930 连续。

**grid 子项必须显式定位**：不写时按源码顺序自动放置，实测
`rows: 770px 0px`、inset 头跑到卡片底部。
`.set-header` 与 `.set-section-head` 仍被 bots-dialog / pi-resources-dialog
使用，不要删。

## 多窗口（2026-10-23：设置独立窗口）

设置页现在是**真 OS 窗口**（`pi_open_settings_window`），能拖到另一块显示器、
alt-tab、独立缩放——浮层做不到"拖出壳"。六个必做项，每条都是"不做就出 bug"：

1. **`subclass::ORIGINALS` 必须是 `HashMap<hwnd, isize>`，不能是单槽**
   （`main.rs` 的 `win_shape::subclass`）。单槽有两个后果：①`install()` 看见
   槽里有值就早退 → 新窗口 wndproc 不被挂钩 → tao 的 NC 边框回来（画布留边
   + `set_size` 尺寸膨胀）；②`hook` 里取到主窗的原 wndproc 去处理别的 HWND
   的消息 = 未定义行为。实测双窗 `insets` 均为 `0x0` 即此改造生效的证据。
2. **`window_state` 按 label 分文件**：`main` → `window-state.json`（历史名，
   老用户记忆不能失效），其余 → `window-state.<label>.json`。共用一份会让
   关设置窗时把主窗几何覆盖掉。
3. **每个新顶层窗口都要调 `wire_window(app, window, close_action)`**：直角
   （`apply_square_corners`）+ Resized/Moved/DPI 事件 + 首屏落盘。这些都
   **按窗口生效**，没有全局开关——漏调 = 窗口带 DWM 圆角、几何不落盘。
4. **`capabilities/default.json` 的 `windows` 必须加 label**，否则窗内
   `getCurrentWindow()` 全报 "not allowed"。
5. **`additional_browser_args` 必须与主窗一致**（从 `main` 的 config 读，
   不要硬编码）。不一致时 `build()` 直接失败：
   `HRESULT(0x8007139F)` = ERROR_INVALID_STATE。根因在 tauri 文档
   （`webview_window.rs:1098`）："Webview instances with different browser
   arguments must also have different data directories"——主窗带
   `--remote-debugging-port=9223`，新窗不带 → args 不同、目录相同 → 拒绝。
6. **设置窗的 builder 与主窗用同一套外观**：`decorations(false)` +
   `transparent(false)` + `shadow(true)`。两边不一致会出现"主窗有阴影、
   设置窗没有"。

**关闭语义分叉**：`CloseAction::HideToTray`（主窗，✕ = 隐到托盘）vs
`CloseAction::Destroy`（设置窗，✕ = 真关，下次重开还原几何）。

**前端分派**：`main.tsx` 现在真的读 `?win=`（此前 `app/index.tsx` 的注释
声称分派但**没有那段代码**）。`?win=settings` → `SettingsWindowRoot`
（不渲染主窗壳、不挂全局右键菜单）。`?win=quick` / `?win=hud` 仍未接——
不为它们写假分支。

**设置页一份内容两种外壳**：`SettingsOverlay` 的 `variant: 'overlay' |
'window'`。`overlay` = 遮罩 + 居中卡片 + 退场动画；`window` = 铺满
（`.set-card--window` 清掉 `position:fixed` / `width:840px` / `height:70vh`，
圆角改用 `--radius-shell`）。**不要另写一份面板**——1562 行内容必然漂移。

### 设置入口的三形态分叉（2026-10-23）

`lib/settings-shell.ts` 是**纯函数**（`settingsShellFor` /
`settingsShellFromProbe`），有 6 条单测。抽出来的理由：三条分支里两条
**在这台机器上无法实机验证**（没有 Android/iOS 构建），纯函数 + 单测是唯一
能锁住行为的办法。

| 环境 | 形态 | 依据 |
|---|---|---|
| 浏览器直开（`inTauri === false`） | `overlay` | **不能 invoke**：`core.js:328` 直接读 `window.__TAURI_INTERNALS__`，浏览器里 undefined → TypeError |
| 桌面 Tauri | `window` | 桌面恒支持多窗口，跳过探测省一次 IPC |
| 移动端 Tauri | `probe` → 运行时问 `supportsMultipleWindows()` | Android 12L+ / iPad 为 true；iPhone / 旧 Android 为 false。**同一份 APK 在不同设备答案不同，必须运行时问** |

`supportsMultipleWindows` 已在 `core:default` 权限集里（`permissions/app/
autogenerated/reference.md`），**不需要额外加 capabilities**。

**web 端的 IPC 错误文案**：`describeIpcError()`（settings-overlay.tsx）把
`TypeError: Cannot read properties of undefined (reading 'invoke')` 翻译成
"浏览器直开模式：没有桌面宿主后端……"。只翻译不吞错——原始错误仍由各调用点
的 `console.error` 打出（铁律 12）。

**注意**：web 端目前只有设置页可用。`runtime.tsx` / `agent-hub-store.ts` /
`thread.aui.tsx` 等**从未**用 `inTauri` 守卫，浏览器里它们的 `invoke` 全报
TypeError（console 可见）。这是"web 端还没做"的范围，不是 bug。

## 布局层（dockview）关键约束
**收放约束盒**（`layout/column-constraints.ts` 状态机 +
`dockview-column-ops.ts` dockview 投影）：收起态必须是 **`0..0`** 约束盒，不只是
min=0。理由与三条实锤坑见该文件头注释，摘要：

- dockview 的 `distributeViewSizes` 按 `maximumSize − minimumSize > 0` 挑 flexible
  item；0 宽但 max 仍是 MAX 的列会被任何 `Sizing.Distribute` 的 `addPanel`
  （分栏/开新签/预览）重摊出宽度 → 面板栏位置一张空白卡。
- 约束快照必须**横跨整个隐藏期**（收起收尾不能消费它），否则展开拿不到原值、
  宽度限制永久失效。
- **投影对象必须按组复用**（状态机快照表是 WeakMap）；每次现造新对象快照永不命中。
- **还原约束后必须再 `setSize` 一次**：`setConstraints` 触发父 branch 按存档比例
  relayout，会把宽度钳回面板级 min。
- 组级显式约束**不随存档 round-trip**（组 state 只有 id/locked/hideHeader/
  headerPosition/views）→ 刷新后必须由 `normalizeColumns` 按旗标重新落成 0..0。

**栏宽是定值**（`layout/rail-metrics.ts`，2026-10-22 用户定稿）：两轨默认
**300**、许可 **270–400**，不随窗口缩放；主栏吃剩余（min 395）。dockview 存档
按**比例**记宽，所以 `repinRailWidths()` 在 resize 后把两轨钉回绝对目标宽；
主栏撞 min 时（几何让位）不记目标宽，否则窗口恢复后栏宽会永久停在让位值。

**窗口最小尺寸 = 1280×600**（2026-11-24）：四列 min 总和（270+240+395+270
+ 分隔条约 1210）低于它就从右边缘裁栏。`tauri.conf.json` 的
`minWidth/minHeight`、`window_state.rs::MIN_W/MIN_H`、`main.rs` 运行时
`set_min_size` 三处同值。**所有 `addPanel` 必须 min+max 都带**；组级约束
不随存档 round-trip，boot `normalizeColumns` 按 `region` 统一补
（rail 270–400 / chat ≥395）。旧存档里的 `routines` 独立第五列会补
`params.region='panels'` 并 `moveTo` 并回面板组，不能留成单独列。

**面板栏允许上下/左右分栏**（2026-11-24）：
- `normalizeColumns` 只迁移**旧档的 routines 第五列**。判据 = 根级 leaf
  **且宽度 < RAIL_MIN_WIDTH(270)**（历史被挤成 100px）；用户拖出的左右分栏
  列宽 ≥270，必须原样保留。上下分栏则是嵌套 branch，也原样保留。
- `alignVisibleToOrder` 在 panels 区出现多个组（分栏）时**跳过面板栏贴边
  重排**：只挑其中一个组 moveTo 到最右会把另一组挤到左边，重载后顺序翻转。
- 左右分栏 = 根级多一列，1280 窗口必然裁切 → `ensureWindowFitsColumns`
  按每列组 `minimumWidth` 求和（上下堆叠按 x 去重），窗口不够就 `setSize`
  长窗，并把 Tauri `setMinSize` 抬到同一值；列数减少时最小宽收回 1280。
  需要权限 `core:window:allow-set-min-size`。
- **存档不许写半成品树**：boot 只在 `normalizeColumns()` 真迁移 routines
  时落盘；`saveLayout` 在 `leftHidden=false`/`panelsHidden=false` 但 JSON
  缺对应 `region` panel 时拒绝写入（HMR 重载曾把好布局写成只剩左/主栏）。
- `routinesPaneSync` 用 `routinesContributionSeen` 区分"启动早期贡献还没
  注册"与"贡献已注销"——前者不摘面板（否则插件加载后按普通标签重建，
  分栏被毁），后者才摘。

**拖放准入**（2026-10-22 用户定稿，`drop-admission.test.ts` 守着）：
- **左栏不是拖拽目标**——不收标签、周围也不分栏。
- **只有面板栏的标签能拖出分栏**；会话标签走 dockview 原生分栏。
- `onUnhandledDragOver` **必须 `accept()`**：dockview 的
  `canDisplayContentOverlay` 只看 `isAccepted`，默认 false → 所有落点被拒
  （这是"标签拖不出来"的根因）。
- **单标签组拖出要自己接管**：`sourceGroup.size < 2` 时 dockview 走"整组移动"
  （换位，不拆新组）。接管见 `splitPanelOut`（补占位 → `moveTo` → 撤占位）。
- **绝不能在 `onDidLayoutChange` 里 `setSize`**：会同步再触发该回调 → 无界
  循环，主线程冻死（实测"软件卡死动不了"）。栏宽收敛只能走有上限的定时轮询。

**布局存档按比例记宽**：窗口 resize 后存的是比例，恢复按新容器宽摊开。
要出厂形态就删 localStorage `mirach.harness.layout.v10` 再 reload，或走右键菜单
「默认布局」。

**fromJSON 手术必须持护栏**：dockview `fromJSON` 内部先 `clear()`，逐面板
`onDidRemovePanel` **同步**外发。shell 的「末签关闭 → restoreOpenAnchor」会
`addPanel` 打进半清树并抛 `referencePanel 'workspace' does not exist`。
一切 fromJSON 手术都要包 `holdLayoutSurgery(fn)`。

## 有意不做的 / 有意的偏差（全部有注释在代码里）

- **`src/api/` 保持 hermes 原样**（指向 gateway）——新栈不消费它，整个 hermes
  `src/` 是参考实现/素材库。
- **dndStrategy 保持 `pointer`**：CEF 时代因 HTML5 drop 不派发而切；2026-10-22 在
  WebView2 上复测 **drop 正常派发**，但为不改动已验收的拖拽行为仍保留 pointer。
  要恢复 dockview 默认（`'auto'`）只需删掉那一行——已验证可行。
- **补间用 `setTimeout` 驱动**：CEF 下 rAF 会停 400ms+；WebView2 下 rAF 正常
  （16ms/帧），但 setTimeout(0) 实测 0ms 更快，维持不变。
- 动效三套（侧栏收放 / 按压 / 选项展开）、三栏卡片化、同心圆角、左栏字级分层
  等视觉定稿的**取值理由**都写在 `tokens.css` / `base.css` / `flexlayout.css`
  的注释里，改值前先读那段。
- **底栏已撤除**（用户定稿）；**主对话调色层 MainTint 已整体删除**（2026-10-21）。
  `.assistant-thread-pane` 的 `position: relative` 保留（活动面板浮卡需要定位祖先）。

## 2026-11-15 轮次：设置页常规 / 记忆与上下文 / 对话显示 / 新建项目

- **设置页白屏根因（已修）**：`pi_list_models` 漏 `contextWindow` → 默认
  模型下拉执行 `m.contextWindow.toLocaleString()` 抛 TypeError → 整个设置
  浮层被 React 卸载。Rust 已补字段；前端对缺失值显示「上下文窗口未知」，
  不再让单条坏数据显示炸整页。
- **常规页（ZCode 选项）**：真相 = `<app_data_dir>/app-prefs.json`
  （`src-tauri/src/app_prefs.rs`，8 单测）。真接线：关窗→托盘（窗口事件
  运行时读）、保持唤醒（专用线程持 `SetThreadExecutionState`；「运行期间」
  由 runtime 的 `setRunActive` 信号驱动）、最大智能体步数
  （`RPI_MAX_TURNS_PER_RUN`，下一次 run 生效）、F12 拦截、http(s) 外链交
  系统浏览器、数据存储路径（settings.json `sessionDir`，文件夹选择器）。
  引擎固定项（终端 50KB / 2000 行 / 500 字符 / 检查点）只读如实标注；
  文件检查点 / 手机推送禁用并写明引擎缺什么。
- **启动恢复上次会话**：runtime 挂载时**仅当引擎无活动会话**才
  `pi_open_session(lastSessionPath)`（页面 reload/HMR 时 live 优先）；
  切会话/新建后由 sessionCatalog 订阅写 lastSessionPath，New Chat 清空。
- **记忆与上下文（hermes 整节移植）**：导航改名；记忆层（当前/已选提供方、
  内置层 MEMORY.md/USER.md、持久记忆、用户档案、2200/1375 预算）+ 上下文
  （compressor、自动压缩、阈值 0.50、target 0.20、protect_last_n 20、
  Codex 自动提高、压缩超时 120 秒）+ rpi compaction 真实字段。rpi 没有
  持久记忆/memory 工具/外部提供方协议 → 记忆层与 hermes 特有百分比字段
  禁用并注明；`compaction.enabled`、`reserveTokens`、`keepRecentTokens`、
  `mode`、`compactionMode` 真写。
- **对话显示（ZCode 完整复刻，2026-11-15 二次交付）**：不再用"族组"简化版。
  - 历史投影按 turn 合并（`pi-hydrate.ts`）：连续 assistant 消息并成一条，
    toolResult 按 toolCallId 归并；消息 timestamp 映射成 part timing，
    `metadata.custom.{workStartedAt,workEndedAt}` 供「已工作」时长兜底。
  - 一个 turn 一个外层工作段（`work-segment.ts::splitWorkParts`）：最后一条
    非空正文之外的部件全进折叠区（含中间正文）；running 不渲染头部、
    `已工作 {duration}` / 无时长 `已处理` / `已停止`；时长格式 = ZCode 规则。
  - 内层连续摘要组（`work-summary.ts` + `elements/summary-group.aui.tsx`）：
    explore/run/change/session 分类，连续摘要行成组（≥2），统计
    `已查阅 N 项，已执行 N 命令，已修改 N 文件`（change 按唯一路径去重、
    无路径计 unresolved、分隔符「，」、空统计回退「思考」）；代表图标
    优先级 change > run > explore；hover 才显 chevron；组内容
    `ml-2 pl-4 border-l` + 隐藏子行 leading icon + `16lh+30*spacing`
    限高滚动；收起+运行中滚动最新子动作，展开显示统计。
  - 子行：思考 `思考 持续了几秒/持续了 N 秒`；execute
    `已执行 description ?? command`；read `已读取`、search `已搜索` 不可
    展开；edit/write `已编辑/已写入 文件 +N −N`；失败红字 + 虚线下划线 +
    错误 tooltip；成功不挂状态词。
  - 删除被取代的简化实现：`assistant-work-items.ts(+test)`、
    `tool-family-group.aui.tsx`、`tool-grouping.ts(+test)`。
  - 门禁：tsc 0 · vitest 869 · vite build；CDP 长会话实测每 turn 一个
    `已工作` 头、摘要组统计/子行走线/图标隐藏/失败样式均与 ZCode 对齐。
- **新建项目文件夹流程**：ZCode ProjectEditor 语义（选目录 → 保存前
  `stat` 校验存在且是目录 → 建会话）；`workspace-session-registry.ts` 把
  跨会话根的新建行登记进 localStorage，`refreshThreads` 合并；取消零副作用；
  错误写 `sessionWorkspaceStore.error` 且菜单关闭后仍可见；首次选目录把
  侧栏分组切到「项目」。
- **跨工作区打开 + writer lease 泄漏（真 bug，已修）**：rpi 的 JSONL writer
  lease 在 HarnessLive 被替换后仍被引擎内部任务持有——实测 A→B 后切回 A
  必报 `writer lease is already held`（TUI 用 `set_session` 原地换会话规避，
  宿主重建 harness 的路径无法释放）。宿主新增 **retired 缓存**：切走/丢弃
  的 HarnessLive 不 drop，再次打开同路径直接复用；同时 `open_session` 按
  `<cwd>/.rpi/sessions/<enc>/file.jsonl` 反推工作区 cwd（跨工作区打开）。
  实测 A→B→A→B→A 五次切换全通。注意：retired 表无上限，进程内打开的会话
  数 = 常驻 harness 数（每个很小，重启即清）。

## 终端窗格 = ZCode 侧栏终端（2026-11-18 用户："右侧面板栏里的终端打开怎么和zcode不一样？"）

规格 = 上游 `docs/ui/side-pane-terminal-tabs.md` + `SidePaneTerminalPane.tsx`
（一个终端 = 一个侧栏标签，**内部不嵌第二层 tabs、无二级新建钮**）。

- **一个面板 = 一个终端会话**（`terminal-pane.tsx`）：无内层页签条；内容 =
  `bg-background p-3`（panes.css `.term-pane` 的 `padding: 0.75rem`——按
  Tailwind p-3 语义随宿主 15px 根字号缩放）。退出条（重新打开）保留 =
  宿主失败可见通道，上游没有、不影响同形。
- **打开 = 新建面板**（`open-page-actions.ts::openTerminalPanel`，`openPagePanel`
  对 terminal 走这条，不在复用单例）：标题 = cwd 末段（取不到 = 终端）+
  " 2/3"（`terminal-tabs.ts::nextTerminalPanelTitle`，上游
  `createTerminalSidePaneTitle` 同源）；id = 最小空位 `terminal` /
  `terminal-2`…（`nextTerminalPanelId`）；**cwd 进 params**，存档恢复按同
  目录重开。面板域判定统一走 `isTerminalPanelId`（dockview-shell 关标签的
  栏生命周期 + boot 归一）。
- **保活 = `renderer: 'always'`**（dockview overlay 挂载）：切标签/收栏不卸载、
  PTY 不中断（上游 keepalive）；关闭面板才卸载 = kill。旧存档的终端面板在
  boot 时补写 `setRenderer('always')`。
- **必须知道的坑**：`always` 面板**隐藏时容器报整坞尺寸**（overlay 未定位
  前 `.dv-render-overlay` 默认 100%×100%）——旧的"有尺寸就 spawn"会按
  1726×1129 起 PTY。所以 spawn/fit 必须**同时**以 `api.isVisible` 为准；
  激活时由 `onDidVisibilityChange`（dockview 自己的 overlay rAF 先于本回调
  的 rAF，尺寸已写好）+ `onDidDimensionsChange` 补启动/fit。实测：隐藏终端
  无 xterm、激活后 69 行与容器 240×1046 一致、来回切标签 scrollback 与
  可执行性保持。另：`term.dispose()` 必须**延后一个宏任务**（xterm 5.5
  Viewport 构造函数里有未追踪的 setTimeout，同步 dispose 会命中已释放的
  render service → "reading 'dimensions'"，实测已在 StrictMode 双挂载
  下复现并修掉）。
- **已删**：panel 内页签条（`.term-strip/.term-tab*/.term-add` CSS、
  `--term-strip-h` 令牌）、`terminal-tabs.ts` 的 `formatTerminalTabTitle` /
  `nextTerminalIndex`（语义上移到面板标题）。改这套前先看
  `terminal-tabs.test.ts`（标题/id 去重与 `isTerminalPanelId` 的守卫）。
- **配色 = ZCode 默认浅色主题**（2026-11-18 第二轮，用户："有黑色背景，
  文字也不对"）：tokens.css 的 `--term-*` 改为 ZCode `@theme` 段的
  Tailwind v4 默认调色板——底 = `--surface`（ZCode 语义"终端底 = 应用
  背景"，其 `.theme-zai-*` 变体直接写 `var(--color-background)`）、字 =
  neutral-950、ANSI = red/green/yellow/sky/fuchsia/cyan-500 + neutral 灰阶
  （数值 = oklch 经 Chromium 量化：red-500 = `#fb2c36`，不是 v3 的
  `#ef4444`——别照抄旧调色板）。**此前误取了 ZCode `.dark` 段的值**
  （#171717 黑底浅字），浅色应用里就是那块黑块。`.xterm-viewport` 原生
  滚动条按 ZCode 同款隐藏（`.term-host .xterm-viewport`，panes.css）。
  **字体同理**：`harmonyos-sans-sc-webfont-splitted` 的
  `:lang(zh) { font-family: HarmonyOS Sans SC, sans-serif }` 会直接命中
  xterm DOM renderer 的逐字符 span（继承的等宽栈输给直接命中），终端
  拉丁字被 xterm 用逐 span letter-spacing 硬凑单元格（"Power Shell"
  怪字距、l 长成 I）。修法 = panes.css 用 `.term-host .xterm *` 更高
  优先级钉回 `--term-font-family`。宿主暂无深色主题；真做时按 ZCode
  `.dark` 段（neutral-950 底 + 600 系 ANSI）移植。
- **终端背景透明（2026-11-24）**：`.term-pane` 不再叠第二层
  `--surface`（组容器已有一层 55% 栏面色）。普通态 `.term-pane` 用
  `--term-bg`，`html[data-mirach-backdrop-ready]` 时 transparent；xterm
  构造开 `allowTransparency:true`，主题 `background` 恒
  `rgba(0,0,0,0)`——不能在建实例时读背景图 ready 状态，否则终端先于
  图片 onLoad 创建会永久留一层 `#fff`。实测 `.term-pane` / `.xterm` /
  `.xterm-viewport` 三层全透明。
- **会话登记 = 页面归属（label + token）+ 孤儿回收**（2026-11-18 第二轮，
  用户："显示达到上限 8 无法打开了"）：根因 = **页面 reload（dev HMR /
  webview 重启）后旧页面的 kill 钩子随页面消失**，遗留 PTY 永远活着、
  占满旧上限。修法 = `terminal-pty.ts` 的 per-page token（挂 globalThis，
  HMR 不换、reload 才换）随 spawn 上报；Rust `terminal_reap(owner_label,
  owner_token)` 回收同 label 下旧 token 的会话，boot（`app/index.tsx`
  effect）与 spawn 各调一次；**8 条上限撤除**（ZCode 不设上限；见
  terminal.rs `alloc_id` 注释）。另实锤：portable-pty 0.8.1
  `WinChildKiller::kill` **成功判定写反**（`if res != 0 { Err }`，而
  TerminateProcess 非 0 才是成功）——Windows 上每次成功 kill 都返回 Err
  （带上一次的陈旧 errno，曾日志成"句柄无效 os error 6"），所以
  `kill_session`/`terminal_kill` **不看返回值**（以 exit 事件 + 登记摘除
  为真）。实测：10 个终端标签全部可开、10 个 pwsh 各一；reload 后 reap
  到只剩活动标签 1 个进程；关标签 pwsh 5→4。
- 会话登记/回收改动后自检：开 2 个终端标签 → 关掉 → `Get-Process pwsh`
  只应剩活动实例；页面 reload 后由 `terminal_reap` 清掉旧页会话（boot 日志
  会有 "reaping stale session"）。

## 活动状态面板 = ZCode ConversationStatusPanel 完整移植（2026-11-18 用户："完整移植"→"有意差异去除，全部对齐"）

规格 = 上游 `packages/ui/src/v4/ConversationStatusPanel.tsx`（2293 行）+
`conversationStatusPanelModel.ts`。宿主落点 `conversation-status-panel.tsx`
（三态外壳）+ `conversation-status-panel-model.ts`（纯函数推导）。

**结构（对齐结论）**：分区顺序 Git 工具(environment) → 目标(goal) → 会话计划
(sessionPlans) → 进程 Todo(plan) → 终端(terminal) → 智能体(agent)；限高表
`STATUS_SECTION_SCROLL_POLICY`（environment null；goal/sessionPlans/terminal/
agent max-h-48；plan max-h-80）；分区头 = 标题 + 悬停箭头 + trailing 随开合
切换；智能体分区页脚 EndedDirectoryRow「已结束的智能体 · N ›」；mini 胶囊
优先级链（运行待办 → 目标(活/暂停) → git 变更 → 目标(完) → 最近完成项 →
待办计数 → 最新会话计划 → 运行计数 → 无则不渲染）。**卸载闸门照抄上游**
`if (!model.hasContent) return null`（2026-11-15 的"常驻空态"宿主选择作废，
用户 11-17 明令"有意差异去除"）；draft（activeId===null）仍不挂。

**数据面无造假口径**：

- git = `fs_git_diff_stat`（干净仓库 → 卡不挂，上游 buildGitModel 同判）；
- 目标 = rpi-goal `goal-state` 自定义条目 → `pi_goal_state`；用时秒针
  active 走 now、paused/complete 停 updatedAt；暂停/恢复按钮 = 既有
  `/goal pause|resume` 扩展命令（`pi_run_command`），错误可见不吞；
- 会话计划 = **新 IPC `pi_plan_entries`**（`pi_session.rs::plan_entries()`，
  扫当前分支 custom type `plan-mode`，只收有 markdown 的，seq 降序）+ 新
  `plan-entries-store.ts`；标题 = 首个 H1 否则首个非空行（上游
  `getPlanDirectoryTitle` 逐字）；
- 终端 = jobs-store（`pi_job_list` 读 rpi-background-tasks 插件的
  `background-tasks` 会话快照，只投影真字段）；行 = 标签（或命令行）+ 用时，
  **无 Stop 钮**——作业进程的 Job Object 句柄在插件进程内，宿主没有按 id
  终止面（见下节）；
- 智能体 = 宿主从 delegate_task / subagent / dispatch 工具调用派生
  （`status-agent-rows.ts`：timing.completedAt 有无分运行/已结束两段，结束段
  按完成时间倒序）；rpi 子代理运行态只在插件进程内存，`pi_hub_roster` 如实
  Err，工具调用是唯一宿主真值；
- workflow = 宿主从 rpi-orchestrator 的 `plan` / `dispatch` 工具调用派生
  （`status-workflow-runs.ts`，2026-11-18 第五波；旧的"不渲染"口径作废，
  见下节）；
- 目标迭代 = rpi-goal-iterations 插件的 `goal-iterations` 逐轮快照并入
  `active.iterations`（2026-11-18 第五波，见下节）。

**详情面落点 = 面板栏标签页**（宿主没有 ZCode 的 workspace side tab）：
`status-pane-openers.ts` 投递，`dockview-shell.tsx` 注册 ——
`plan-detail:<entryId>`（每计划一实例，同 id 再点只激活）与
`agent-directory`（单实例）。目录页自身从线程消息派生 ended 行（与页脚计数
同源），点击行落既有 `openSubagentDetail` 通道。

**坑**：CDP/脚本手工拼 Windows 路径去调 `pi_open_session` 时注意转义
（`\s` 之类会被 JS 吃成 `s`）——字符串相等守卫会漏，报「lock …
Failed to acquire」误导；用同一次求值里 `pi_list_sessions` 返回的 `path`
原样传即可。

**顺带修复**：`pi_get_state.hasExtensions` 此前硬编码 `false`；实测 rpi 扩展
实际已装载（`/goal` 等扩展命令可用）——改为读
`live.reload.extension_session.lock().is_empty()` 的真值（锁中毒如实 Err）。
实机回读 `{…, hasExtensions: true}`。

**实机断言（CDP）**：`/goal start` 起真目标 → aside 出现且 `data-goal-status=
active`、秒针在走；UI 暂停/恢复点击真翻转；`/goal stop` 归档后 `!hasContent`
闸门让面板整块消失。**会话计划全链路**（真模型规划运行）：plan 模式下发一条
规划请求（composer 真发送）→ 模型探索后 `plan_mode_complete` 写入条目 →
`pi_plan_entries` 返回真 plan markdown → 面板「会话计划」分区出现（H2 回退
标题 + 计数 1）→ 点行开 `plan-detail:<entryId>` 标签页展示原文。
`agent-directory` / `plan-detail` 标签页开合与单实例语义实测。
单测：`conversation-status-panel-model.test.ts`（25）、
`status-agent-rows.test.ts`（9）、`status-panel-stores.test.ts` 增
`parsePlanEntries`。

### 缺口用插件补（2026-11-18，用户："能用插件补上的用插件……没有的就完整移植插件解决"）

先摸上游（`pi-rust/rpi-package` main）现成插件面，结论：

| 缺口 | 上游插件面 | 处置 |
|---|---|---|
| 终端 / 后台作业 | `rpi-background-tasks` **有源码**（`background` / `jobs` 工具 + `background-tasks` 快照；无 release tag、本机未装） | **就地补齐**：vendored 到 `G:\mirach-plugins\rpi-background-tasks`，`cargo build --release` 后装到 `~/.rpi/agent/extensions/rpi_background_tasks.dll`；宿主 `pi_job_list` 改读最新 `background-tasks` 条目（`data.jobs`），`pi_job_cancel` 仍如实 Err（kill 由模型经 `jobs` 工具发出） |
| 目标迭代/验证徽章 | 无（`rpi-goal` 只有 active/paused/complete + archived；runtime.rs 全文无 verify/iteration 概念） | **第五波已补**：宿主在 rpi-goal 之上记 `goal-attempts` 迭代行 + `pi_goal_verify` 产校验结论（见下节） |
| workflow 分区 | 无（`rpi-orchestrator` 的 DAG 只在本进程内存，且由模型工具驱动，无会话投影面） | **第五波已补**：宿主从 plan/dispatch 工具调用派生 `details.nodes`（见下节） |
| 子代理名册/Stop/子会话 | 无（`delegate_task` 的子运行是 `ChildAgents`，`pub(crate)` 进程内注册表，无 AppendEntry/SetStatus 面） | 沿用「工具调用派生」方案 |

**插件源码的本地适配（必须记住）**：上游 `resolve_shell` 只探
`%ProgramFiles%\Git` 再 `where bash.exe`，本机 Git 装在 `D:\Git` → 落到
`System32\bash.exe`（WSL 存根，exit 1 + UTF-16 乱码）。已按宿主
`rpi-tools::os_env` 的顺序补齐：`RPI_BASH_PATH` → 常见安装根（含
`LOCALAPPDATA\Programs\Git`）→ `where git.exe` 反推安装根（覆盖自定义盘）
→ `where bash.exe` **排除 WSL**。实测 `D:\Git\bin\bash.exe` 命中，后台作业
真跑通。

**前端接线（jobs-store）**：词表改为插件 `STATUS_*`（running / completed /
failed / interrupted / cancelled）；可选项（kind/label/finishedAtMs/exitCode/
pid）缺席留 null。发现并修了一个真竞态：**后台作业跨轮存活**（60s 任务在本轮
回复后才 settle），只在 isRunning 期轮询会让行永远停在「运行中」——现在
run 期 2s 轮询（jobs+todo+planEntries），挂载期另有一条 3s 慢轮询兜住跨轮
settle（插件未装时 `pi_job_list` 立即返回 []，开销可忽略）。

**实机 E2E**：真模型经 composer 发出后台请求 → 插件 `background` 工具真跑
（`sleep 20` exit 0、`sleep 60` exit 0）→ `pi_job_list` 回真行（label/command/
startedAtMs/pid/exitCode 全真）→ 面板「终端」分区运行中在场、秒针在走、行文
案 = label + 用时、无 Stop 钮；settle 后慢轮询自动收掉分区。

### 让位链与 ZCode 源码对账修正（2026-11-18，用户："对话区宽度被挤在左边，
面板没出现还在左边，你到底全部对齐了没"）

**报障根因（两个，都已修）**：

1. **面板没出现仍让位**：面板组件**总会挂载**（可能 `return null`），而
   `setMounted(true)` 原来写在挂载即执行——`!hasContent → null` 的会话把
   对话列照样左移收窄（用户看到的"面板没出现还在左边"）。修法 =
   `panelVisible = activeId !== null && model.hasContent` 与渲染闸门**同判**
   （`conversation-status-panel.tsx`）。
2. **旧让位语义本身与上游不符**：2026-11-02 轮把"钉死形态恒让位（无断点）"
   当真（依据是 `INLINE_OFFSET_CLASS_NAME` 常量存在），但核对
   `G:\ZCode-main\packages\ui\src\v4\conversationLayout.ts` 后实锤：
   - `getConversationStatusPanelOffsetClassName(layout)` 对 **auto 与 inline
     返回同一个类**：`@min-[1280px]/conversation:-translate-x-42` ——
     **偏移只在容器 ≥1280 生效**；`INLINE_OFFSET` 常量全仓只有定义、无使用，
     是死代码；
   - `CONVERSATION_CONTENT_WITH/WITHOUT_STATUS_PANEL_WIDTH_CLASS_NAME` 是
     **同一个字符串**——面板出现**不收窄**内容列。（旧实现 shift 时
     `min(宽, 100% - 24rem)` 是多余的，已删。）
   - `TOP_CLEARANCE = pt-14`（56px@16px）——胶囊形态顶部余隙；e2e 断言
     `transitionDuration === "0s"`（布局切换零过渡），旧实现的
     `transition: width/max-width/transform 300ms` 已删。

**现在的形态判定 = 纯函数** `resolveStatusPanelShift`（`status-panel-store.ts`，
单测 `status-panel-layout.test.ts` 5 条）：

| present | variant | offset（CSS ≥1280 才平移） | topClearance |
|---|---|---|---|
| false（draft/无内容） | 任意 | 否 | none |
| true | mini | 否 | always（pt-14） |
| true | auto | 是 | below-wide（<1280 才 pt-14） |
| true | panel | 是 | none |

`thread.aui.tsx` 的 `data-status-panel-shift="wide"` / `data-column-shift="wide"`
只在 `offset=true` 时写；`panes.css` 单块 `@container thread (min-width:1280px)`
应用 `--dsh-panel-offset: 10.5rem` 平移。

**实机度量（CDP）**：无内容会话 → 无 shift 属性、无 pt-14、居中；胶囊态
（容器 660）→ pt 52.5px、transform none；宽容器（zoom 模拟 ≥1280）→
pt 15px、transform `matrix(1,0,0,1,-157.5,0)`。

### 插件 / 引擎双路径收口（2026-11-18 第三波，用户："能用插件的形式解决就用插件的形式，
如果必须动引擎侧才能实现，引擎侧的要自己测试完没有问题了再pr给pi rust"）

**① 终端 Stop = 插件侧闭合**：给 vendored `rpi-background-tasks` 补
`/jobs` 斜杠命令（`list` / `tail <id> [lines]` / `kill <id>`；命令面没有
`__rpi.sessionId`，kill 按进程内唯一 id 反查 owner）。宿主 `pi_job_cancel`
改为 `run_command("/jobs", "kill <id>")` 转发；面板终端行重新渲染 Stop。
实机：运行中 job 点 Stop → 快照 `status=cancelled`、行消失、pid 进程消失。

**② 子代理名册/Stop = 引擎侧补齐（已自测 + PR）**：
- 引擎（`G:\pi-rust-main` 同源补丁，PR **bigfish1913/pi-rust #355**）：
  `ChildAgents` 新增 `roster()`（childId/status/turns/startedMs/finishedMs/
  role/taskPreview/error，按开始时间倒序）与 `stop(child_id)`（按 id 取消，
  非 owner 过滤——调用者就是宿主；未知 id=Err）；`State` 增 started_ms/
  finished_ms/role/task_preview（首写胜出）；`RuntimeActionHost` 增默认
  `child_agent_roster()`（空）/`stop_child_agent()`（拒绝），
  `HarnessActionHost` 覆写。
- 宿主：`pi_session.rs` 新增 `child_agent_roster()`/`child_agent_stop()`
  （经 `live.reload.action_bridge` 的 `clone_host()` 调 trait）；
  main.rs 新增 `pi_child_agents` / `pi_child_agent_stop`；新 store
  `child-agents-store.ts`（严格解析）；面板「智能体」分区优先渲染引擎名册
  （running 行带「停止子代理」钮），工具调用派生仅剩已结束目录用途。
- 实机：真模型 delegate_task 长任务（child sleep 180）→ `pi_child_agents`
  返回 running 行（role/taskPreview 真值）→ 面板行点 Stop →
  `pi_child_agent_stop` → 模型侧收到「child cancelled by user」、名册行消失、
  子进程终止。
- 引擎门禁：`cargo test -p rpi-cli` **1197 passed**；`native_durable` 的
  `resource_fixture` 2 条构建失败在干净 `upstream/main`（v0.25.0）上同样
  复现（环境性，与补丁无关）。

### 第五波：目标迭代行 + 目标完成校验 + 工作流分区（2026-11-18，用户："缺点补啊，不是说了吗，可以从zcode复制"；"Rpi有goal，直接在它上面做行吗"）

**目标状态机住在 rpi-goal 插件，宿主只做触发 + 模型裁判**（用户定稿
"Rpi 有 goal，直接在它上面做"）。vendored fork 在
`G:\mirach-plugins\rpi-goal`（基线 = `pi-rust/rpi-package` main @ `6144715`），
已编译替换 `~/.rpi/agent/extensions/rpi_goal.dll`（官方原件备份为
`rpi_goal.dll.official-0.2.5.bak`）；fork 改动已向上游提 PR
**pi-rust/rpi-package #336**（https://github.com/pi-rust/rpi-package/pull/336，
6 个新增 SDK slot 在 PR 里没有接——上游 `rpi-plugin-sdk =0.3.20` 没这 6 个
字段，宿主本地 SDK 0.24 有；两边各自编译过）。

1. **插件新增状态**：`Goal` 加 `iterations[]`（每次 run 收尾的 todo 快照，
   `{iteration,items[{content,status}],updatedAt}`）/ `verifications[]`
   （`{iteration,outcome pass|notSatisfied|failed,at,reason?,nextAction?}`）/
   `verify_iteration`；状态词表扩成 ZCode 六态 `active|paused|verifying|
   verified|failed`（保留旧 `complete` 读兼容）。**`complete` 语义改为
   "终态但仍在场"（verified），归档改由 `/goal stop` 承担**——上游是
   status=complete 仍在场，rpi 旧的 complete=归档会把已完成目标从面板抹掉。
2. **插件新增内部动词**（宿主面）：`/goal _verify-start {"items":[…]}` →
   status=verifying + 开下一轮迭代；`/goal _verify-result {"outcome":…,…}` →
   落裁决：pass→verified；notSatisfied→回 active（上游存储面语义）+ 带
   nextAction 时**插件自己 SendMessage(display:false) 续跑下一轮**；
   failed→failed；cancelled→paused。
3. **模型调用只能在宿主**：rpi 的 action 24/25（ChildAgent / SideQuestion）
   只挂在工具/命令的 invocation bridge 上，插件的 `on_turn_end` 拿不到——
   所以宿主 `src-tauri/src/pi_goal_verify.rs` 负责：`AgentEnd` 常驻订阅 →
   闸门（当前会话 / goal active / 后台作业不在跑 / 单槽在途）→ 读 todo 快照
   → `_verify-start` → `side_question({"op":"new","question":…})` 无工具单轮
   裁判（64KB 文本摘录 + 问句里带 todo 快照）→ `_verify-result`。孤儿修复：
   会话上台（`install_live`）时若 goal 仍 verifying 且本进程无在途校验 →
   发 `cancelled` 收口回 paused。
   （旁路监听插件 `G:\mirach-plugins\rpi-goal-iterations` 已退役、DLL 卸载，
   源码留存仅作参考。）

前端：`StatusPanelGoalModel` 扩成 ZCode 六态（rpi-goal 的 complete →
`verified`；verifying/notSatisfied/failed 由宿主校验器真实产出，见下段）；
新增 `buildConversationGoalIterationSummaries`（上游
`conversationGoalSummaryModel.ts` 逐条照抄：首轮标题 = 目标、后续轮 = 上轮
nextAction、完成轮数字圆环、N/M 计数、`data-goal-*` 断言属性；
**requiredIterationCount 不再 +1**——上游的"续跑开行"在宿主会多出一行空
迭代，宿主最后一轮快照就是当前轮）。迭代行额外渲染校验结论徽章
（pass/notSatisfied/failed），在途行显示「目标校验中」且
`data-goal-status=verifying`。实机：`/goal start`（自动首轮）→ 宿主记
iteration 1（todo 快照 0/2）→ 校验先 `verifying:{iteration:1}` 再落
`verifications:[{outcome:"notSatisfied", reason:"…待办未完成…",
nextAction:"完成未完成待办项「检查状态面板」"}]`（verifier 按上游规则查了
todo 清单，拒绝通过——真裁判语义）→ 面板行带 notSatisfied 徽章；历史 6 轮
goal 的迭代行实机同验。

**校验裁决语义（照 ZCode 逐条对齐）**

- **问句**：上游 `formatGoalCompletionVerificationPrompt` 原文逐条搬进 fork
  （objective 内联 `<untrusted_objective>` 转义、todo 自查条款、失败时
  nextAction 成为下一轮标题）；token 计数宿主没有 → 换成 Iteration /
  Turns used / Turn budget，并附本轮 todo 快照（side_question 的文本摘录
  不带工具输入/结果，todo 是唯一可复核的「工作状态」）。
- **裁决**：`{"passed": bool, "reason": string, "nextAction": string}`，
  解析 = 取最后一个 JSON 对象、`passed === true` 才算过、reason 缺失用兜底
  文案；**坏 JSON = fail-open 成 pass + 保留 reason**（上游语义，防止裁判
  链路故障把已交付目标卡死）；请求失败/超时 = `cancelled` → paused。
- **续跑**：`notSatisfied` + `nextAction` → 插件用 `SendMessage` 发一条
  `display:false` 的 model-only 消息驱动下一轮（预算耗尽则不续），与上游
  「validator 拒绝 → 继续迭代」同形；面板的「目标校验中」= status=verifying，
  结论徽章 = 本轮 verification。
- **实机**（插件驱动的完整回路）：`/goal start 用一句话回答 1+1 等于几` +
  用户消息 → status 依次 `verifying` → `verified`，`verifications:[{n:1,
  outcome:"pass"}]`（面板行带徽章、目标保持可见）；另一条不可达目标
  （CPU 降到 20°C）→ `notSatisfied` + 真 nextAction → **自动续跑第二轮**
  （turnsUsed 1→2，用户未输入）→ 第二轮再次 notSatisfied，turns 4/4 预算
  用尽 → paused。说明闸门、裁决、续跑、预算四条路径都走通。

**门禁（本轮）**：宿主 `cargo test` **702**、前端 `vitest` **1073**（86 文件）、
`tsc` 0 新错（hermes-mirror + sdk-upstream 既有基线不变）；fork 自身
`cargo test --release` **31** 条（含状态机/载荷解析/续跑提示词/预算闸 4 组新测），
在干净上游克隆里同样 31 条通过。
**工作流分区（宿主派生）**：`status-workflow-runs.ts` 从本线程 `plan` /
`dispatch` 工具调用派生（成功结果 `details.nodes` = 引擎
`Graph::to_details` 真形状：id/task/deps/status ∈ pending/running/done/
failed/skipped）。一次成功 `plan(action=set)` = 一条 run；dispatch 波更新
同图；pending/running 进分区，全 settled 进「已结束的工作流」页脚计数；
图快照缺席 → 步数字段缺席（不造 0/0）；被新 plan 替换且未收敛的旧图不伪装
终态（console.warn 后丢弃，引擎侧它已不存在）。UI 照抄上游
`WorkflowStatusSection` / `WorkflowRunRow`（灯 + 步数词 + 时长；Stop 不渲染
——orchestrator 没有取消面）。行/页脚 → 面板栏 `workflow-run:<runId>` /
`workflow-directory` 标签（新 `workflow-run-detail-pane.tsx`，节点图实时
派生）。**坑**：分区开合必须非受控（`defaultOpen={runs.length>0}` +
`key={activeId}`）；接成受控 state 默认 false 时，运行中的 run 只出现在
标题、行永远不可见（实机踩中）。实机：真模型 `plan(set)` 两节点 → 面板
「工作流 1 个运行中」+ 行（首节点任务、pending、时长）；真 `dispatch`
结果含 `details.nodes`（failed+skipped）——与派生规则一致（errored → 目录）。
单测：`status-workflow-runs.test.ts` 9 条 + 面板模型/goal 迭代 33 条。

### 上游 PR 裁定与窄版重提（2026-11-19）

- **bigfish1913/pi-rust #348（四件套引擎半）已合并**：两轮评审 6 个 blocker
  全修复后 APPROVED（过期围栏 / 跨进程 fs2 锁 + 唯一 tmp / 扩展 hook 结果
  保留 + 审批按改写后 args / 审批取消 fail-closed / message_agent
  send-cancel 分型 + delivery_id 校验 / 模块文档对齐）；遗留 nit（acquire
  文档声称的 Indeterminate 与实现的 Expired 矛盾）由维护者以 **#376** 落地
  并致谢——我们顺手开的 **#374** 因此关闭，无需动作。
- **pi-rust/rpi-package #336（完成校验宽版）关闭为 superseded**：评审两轮
  6 blocker 都已处理（fmt / forbid(unsafe) / CI workflow / 假宿主契约测试 /
  边界超时+行数上限 / complete-stop 语义迁移），但维护者裁定不落：
  布局基于 0.2.5 单体（#343 已模块化）、per-goal iteration 与
  complete/blocked/wait 语义上游已有、verifying/verified/failed 状态词表
  会重写七态模型（只为 UI 差异）、todo 快照与 rpi-todo 重复、unsafe 来自
  宿主 SDK 钉版（上游 0.3.20 仍 safe）。
- **按维护者窄版规格新开 #362**（feat(goal): host-recorded completion
  verdicts with verifier-directed continuations；branch
  `feat/goal-verify-verdicts` 基于 upstream/main c6f4877；本地克隆
  `E:\Temp\rpi-package-pr`）：七态不动，`/goal _verify-result` 隐藏宿主
  动词只**记录**裁决（有界 `verifications[]` 50 行/2k 字段 +
  `pendingNextAction`）；notSatisfied 必带 nextAction → 活跃目标保持活跃
  （waiting 被唤醒）、已归档目标复活回 active 槽（fresh id，stale 终端
  工具/旧裁决全被拒）；派发走**既有 worker**（同 revision 守卫 + 绝不
  注入 live run），verdict 以不可信任务数据转义引用进续跑提示词，
  pending 在 dispatch fold-back 消费（暂停插进来不丢）；pass 只记录并清
  pending、不启动 run；stopped 目标记录后等 `/goal resume`。
  测试 56 lib + 6 集成全绿（验收测试 = `goal_complete` 后宿主拒绝 → 复活
  → 恰好一条带 reason/nextAction/新 id 的续跑）；fmt / clippy -D warnings
  干净；`forbid(unsafe_code)` 未动。#336 已留言指向 #362。
- **宿主 vendored fork（`G:\mirach-plugins\rpi-goal`）不跟随窄版**：宽版
  （verifying/verified 词表 + 宿主裁判驱动 + AgentEnd 闸门）E2E 已验、
  继续在用；#362 是上游可接受的独立贡献，两边语义**有意分叉**——上游若
  收窄版，同步策略到时候再定。

## 引擎侧四件套 + 宿主桥（2026-11-18 夜，用户"全部做……pr给pi rust"）

**引擎侧改动都在 `G:\pi-rust-main` 工作树，PR 已提：pi-rust #348**
（https://github.com/bigfish1913/pi-rust/pull/348，基于上游 main 干净重建；
diff = task_lease.rs / approval_gate.rs / message_agent.rs 三个新文件 +
session.rs +50/-3 + 两个 lib.rs 一行。**镜像里用户自己的本地补丁不在 PR 内**）。
**已合并（2026-11-19）**，评审 nit 由上游 #376 落地。

| 件 | 引擎文件 | 宿主对偶 |
|---|---|---|
| 任务租约（fencing/终局回执/recover） | `rpi-harness/src/task_lease.rs`（落盘 `<session>.tasks.json`） | `pi_bot.rs`（prompt=task 身份+meta；`pi_bot_state` 出 task/tasks；`pi_bot_take_recovered`；`pi_bot_interrupt_task` 带 fencing）→ host-rpc `session.resume`/`task.interrupt` → canonical driver |
| 审批闸运行时三态 | `rpi-cli/src/approval_gate.rs`（AtomicU8 + handler + before_tool_call 组合在扩展 hook 后） | `pi_engine_bridges.rs`（`mirach://approval-request` + 600s 裁决）→ `engine-bridges.tsx` ApprovalDialog；模式钮三态 |
| agent 互发 | `rpi-cli/src/message_agent.rs`（内置工具，handler 未装不注册） | `mirach://agent-message` + 30s ack → 前端真投递/回信；**bot-launch 提示词里的 `hermes -p … chat` shell 指令是 hermes 形态，宿主实际走引擎工具** |
| 本机屏幕 RFB | 无（宿主子系统 `pi_display.rs`：GDI + RFB 3.8 WS + ticket + lease） | screen-pane 经 `resolveSiblingWsUrl('/api/display/ws')` 直连 noVNC。**2026-11-21 对齐：默认关闭**（hermes 本机网关没有 bot 屏幕，按钮打开是"此主机没有机器人屏幕 / 此机器人使用主机自身的显示器"）；`MIRACH_HOST_SCREEN=1` 才启用主机桌面镜像，仅作显式自测 |

**必读坑（都实测过）**：
1. **`durable_binding` 只在 `native_durable` 时填充**（engine session.rs 原逻辑）
   → 宿主嵌入（从不设 native_durable）里 message_agent 恒报
   "session binding not ready"。**修复 = 无条件 `set(harness.downgrade())`**，
   已进 PR 清单。改引擎后宿主需重编（tauri dev 不 watch path 依赖）。
2. **display lease 契约恒为对象**（gateway-contract：`holder:'agent'|'human'`）：
   返回 `null` 会让 screen-pane 的 `setScreenLease` 在释放路径读 `null.epoch`
   抛错（UI 卡"你正在控制"）。宿主 `pi_display.rs` 已按契约修（agent 占位 +
   单调 epoch）；`running = supported`（本机镜像恒在跑，硬编码 false 会让面板
   永远停在"已关闭/启动"）。
3. **display.status 的 `geometry` 是字符串**（面板头部拼文案），不是对象。
4. canonical driver 的 stop/retry 走 `task.interrupt`（带
   `execution_generation`）；陈旧 token 会被引擎拒（"stale task identity"），
   这也是**故意**的——绝不作用到另一轮。
5. `pi_bot_prompt` 的 taskMeta = 房间坐标（room_id/thread_id/turn_id/…），
   `recover` 出的 indeterminate 记录由 `session.resume` 的 `recovered_tasks`
   取出（take-once），driver 回写 `turn.failed` + reason_code `indeterminate`。

### 跨网关 relay + transport（2026-11-18 第二波，bots 的"核心"）

- **宿主两模块**：`pi_relay.rs`（hermes `tools/bot_relay.py` 对偶：持久仓
  `~/.rpi/agent/bot_relay/{outbox,claimed,replies,receipts}` + 四门 + TTL +
  未回执重投 + 先写者胜 reply + 独立 receipts）+ `pi_gateway.rs`（**JSON-RPC
  2.0 over WS `/api/ws`**，hermes 桌面端同款：ready/ping/事件推送/服务端请求
  答 -32601/2^n 重连）。`host.connections()`=裸数组、`profileRoutes`=每
  （连接×profile）一条、`agents`=远端并集（30s 缓存、瞬时失败沿用旧值）。
- **relay 总线在 Desktop**（上游事实）：每个网关四个门，Desktop 持有各连接
  socket 做 drain→deliver→reply 穿梭；本地目标（同网关）走直投（envelope 不经
  循环）；远端目标才进 envelope。**单连接时 drain 循环整体短路**（peerCount<2）
  ——测本地链路别拿它验证。
- **三个实测坑（都吃了亏）**：① Rust 事件名要与 host.onEvent 的点号→冒号映射
  **逐字**一致（`bot_relay.outbox.pending` → 前端监听 `…bot_relay:outbox:pending`；
  点没换成冒号的 API 就是死信道）；② `bot_relay.deliver` 回执**必须带
  `admission_id`**（或 refused:true）——Desktop settle 判定"回执指名准入"，缺了
  会把整个回执当"身份不可用"保留重投（实测目标 bot 连跑 13 轮）；③ 回执落盘
  **用独立 `receipts/<id>.json`**，不能吊在 claimed 上——远端来件不在本机
  claimed，幂等会整块失效。
- **E2E 方法**：`E:\Temp\mock-gateway.mjs`（无依赖手写 RFC6455 的 hermes 协议
  子集 mock；MOCK_ENVELOPE=1 开方向 A）。双向链路实测见 HANDOFF 同轮条目。

## ZCode 逆向对照环境（2026-11-15，继续对齐对话 UI 时必用）

不再靠读源码猜。ZCode 桌面版支持用环境变量隔离出**第二个实例**并开 CDP：

```powershell
$env:ZCODE_DESKTOP_APPLICATION_NAME='ZCode Debug'
$env:ZCODE_DESKTOP_USER_DATA_DIR='E:\zcode-debug-profile'
$env:ZCODE_DESKTOP_SESSION_DATA_DIR='E:\zcode-debug-profile\session'
Start-Process -FilePath 'D:\zcode\ZCode.exe' -ArgumentList '--remote-debugging-port=9444'
```

- 关键：ZCode main 会 `app.setPath("userData", runtimeUserDataPath)`
  （desktopRuntimeEnv.ts:72-82），所以只传 Electron `--user-data-dir` **无效**，
  必须用上面三个 `ZCODE_DESKTOP_*` 环境变量；否则单实例锁直接 `app.quit()`。
- 该实例与正式 ZCode 共用 `~/.zcode` 任务数据，但不抢窗口/单实例锁；
  只读对照用，别在里面发消息（会写用户任务数据）。
- CDP 端口 9444；`set CDP_PORT=9444` 后可直接用 `scripts/cdp.mjs eval/shot`。
- **主窗 + 设置窗是两个 page target**（9223 上 `?win=settings` 与 `/` 各一个，
  list 顺序不稳定）。用 `CDP_EXCLUDE=win=settings`（或 `CDP_INCLUDE`）按 URL
  选目标，否则会在设置窗里量对话区、得到全 null。
- 已实测的 ZCode 基准值（2026-11-15，**以 9444 实时 DOM 为准**）：
  - 正文字号 14px / 行高 24.5px（`text-ui-base leading-[1.75]`），段落 mb16，
    h1/h2 18/16px·行高 28·mt24/mb16，列表 my12/pl20/行距 6。
  - 工作段头 14/21、pb8、border .9px；header→组 20（实测是 header pb8 +
    组容器内部 `pt-5`）；组内容 mt8、rail ml8+pl16、gap8、
    `max-h 16lh+30*--spacing`。history-message 的子项（除 collapsible-content）
    一律 `mt-5`；collapsible-content 自身 `mb -4 / pb 4`。
  - **轮间距 = 76px**：每个 turn 是独立 SECTION，`pt-56 pb-20`；宿主旧值
    gap-y-6 只有 22.5px，整段对话会明显偏挤。turn 内 user→assistant 20px。
  - **user 气泡 = 四角统一 24、无描边**（border 宽度实测 0；类里的
    rounded-tr-xs 被 rounded-xl 覆盖）、padding 12/16、14/21。
  - **动作钮 = 24×24、圆角 6px、图标 14px、容器 gap 4px、常态 text-foreground**；
    条本身 `opacity-0` + hover/focus 显形，**始终挂载**（不是卸载）。
    assistant-ui 的 `autohide="always"` 是卸载（悬停行高跳变），要用
    `autohide="never"` + CSS 透明度。消息时间 12/18、subtlest、跟在按钮后。
  - composer radius 32 / padding 12 / gap 12 / border .5；输入 14/20、min-h40；
    **控件 28×28**：附件/上下文/模型触发器圆角 8（非胶囊），语音/发送圆形；
    模型触发器 14px 字、padding 0 6 0 8；工具行 gap 4。
  - 「工作中」= ChatLoadingOrbs（105 点球面→Z 字形，8240ms）。
  - **思考正文 = 纯文本**（ZCode `reasoning.tsx`：`whitespace-pre-wrap`，
    `text-ui-base` 14/21；**不要套 MarkdownText**——段落会吃到 `p` 的
    mb16 + leading-24.5，用户实报"思考的内容分段的间距有点大"）。工作区
    每一行（思考/工具/询问）实测都是 **21px 高、行间 gap 4px**；reasoning
    根容器必须 `flex flex-col`，否则 inline-flex 触发基线行盒，行高变 25。
  - **图标线宽 lucide 1.5**（本工程根字号 15px，`size-6/7/8` 分别只有
    22.5/26.25/30px，对 ZCode 的 24/28 全部要写死像素）。
  - **上下文用量环常驻**：窗口未知（models.json 没写 `contextWindow`）也渲染，
    环上叠 `?`、弹层写"窗口未知"；用量从 pi 最后一条带非零 usage 的 assistant
    提取（`usageFromPiMessages` → `HYDRATE.usage`，历史会话也有数）。
    **总决定价链**：models.json 的显式 `contextWindow` 永远优先（用户在环弹层/
    设置页写的值）→ 否则宿主侧 **model registry**（`src-tauri/src/
    model_registry.rs`，拉 https://models.dev/api.json 的 `limit.context`）
    回填；目录缓存 `<app_data_dir>/model-registry.json`，启动后台刷新（TTL
    24h），`pi_refresh_model_registry` 可强制刷新。回填点两处：
    ①`pi_list_models` 响应（UI/设置页）；②`build_harness_with` 里
    `resolved.model.context_window`（引擎压缩阈值 `should_compact` 也吃到
    真实窗口——**只改内存 model，不写用户配置**）。目录里没有的模型保持
    未知（不编默认值）。实测：models.dev 有 2581 条；`deepseek-v4.1-flash`
    → 1,048,576，`deepseek-v4.1-flash-1017` → 1,000,000（显式配置优先）。
  - **模式芯片 = 计划 / 完全访问两态，可切换**：`pi_run_command`
    （宿主新 IPC）直接调扩展 slash command `/plan start|exit`，与 rpi-cli
    RPC `execute_command` 同一 handler 契约（snapshot.commands() + handler +
    `OwnedString::from_raw`），**不需要改引擎**。计划态下插件
    `activate()` 会 `set_tools([read,bash,docs,plan_mode_complete])`——write/edit
    不在工具表里（**bash 不是只读沙箱**，扩展 README 原话）。
    **状态真值用 `/plan status`，不要只看会话条目**：rpi-plan-mode 0.2.3 的
    `active` 是 DLL 里的进程级 static，`persist_state` 只在 false→true 时写
    条目；切会话后条目可能是 off 而工具已被限制（或反之，见下条上游缺陷）。
    `pi_mode_state` 现在跑一次 `/plan status`，text 含 "Plan · Planning" 即
    planning。
    **上游缺陷（实测）**：`restore_state()` 在 SessionStart/Tree 只恢复
    `active/plan`，**不重新 set_tools**；切到没有条目的会话时也不重置 active。
    即"计划态中切会话"= 插件仍认为 planning，但新 harness 的工具表没被收紧。
    宿主不做 exit+start 补救（会清掉进行中的 plan）；UI 只如实显示状态。
    `RPI_PERMISSION_GATE=1` 是启动期开关（无运行时切换面），芯片如实标注。
- **2026-11-15 ZCode 对齐批次（逆向结论，全部实测/源码对照）**：
  - **工作段**：一轮一个总折叠块（`turnWorkOwner` = 轮尾 assistant 才建组）；运行中且收起时组头换成**当前活动项摘要**（思考显示流式末行；工具显示其摘要行；`QueuedSummaryContent` 300ms 翻滚）；完成后收起显示统计/时长；展开逐项平铺（左侧导线、隐藏行首图标）；最终正文恒在折叠区外；无最终正文强制展开。压缩显示改为对话内 `LiveCompactionRow`（正在压缩/已压缩 tokensBefore→tokensAfter/中断/失败四态）。
  - **标签栏**：`.dv-tab` 允许收缩（ZCode `flex 1 1 9.75rem`、min 60px、max 156px），标题 ellipsis + mask 渐隐；✕ 绝对定位、常态 `visibility:hidden;opacity:0`，hover/`:focus-within` 才显形（active 也不常显）；隐藏 dockview 自绘 `.dv-scrollbar`（只藏原生滚动条不够）；终端 `.term-*` 同款。令牌：`--tab-max-w/-min-w/-fade-offset`。
  - **输入框窄宽**：composer 根 `@container/composer`；`@max-xl`（<36rem）模式芯片只留盾牌图标、隐藏思考档位、模型名 cap 160px；`@max-sm`（<24rem）模型 cap 96px；其余按钮 `shrink-0`。**模型名宽态 cap 320px**（200px 会把 `deepseek-v4.1-flash-1017` 截断）。motion Popover 内容必须 portal 到 `document.body`（`container-type` 会让 composer 成为 fixed 子元素的 containing block，内联会整体偏移）。
  - **粒子**：`chat-loading-orbs` 形变目标 Z → **M**（4 段笔画按弧长等距采 105 点，x3..17/y4..16），颜色保持 `--brand`（#006fff）。
  - **附件**：图片走原生多模态（`POST /ag-ui images[]`，白名单 png/jpeg/webp/gif，单图 24MB）；视频/音频/文档引擎**无原生块**（`rpi_ai::Content` 只有 Text/Thinking/Image/ToolCall）→ 落绝对路径引用进 prompt（`read`/shell 自取），未知类型直接拒绝；POST body limit 64MB；拖放非图片用 `attachment_stage` 落 `%TEMP%\mirach-attachments`；纯附件消息允许发送（旧实现被静默丢掉）。
  - **bash**：Windows 上 `where bash.exe` 命中 `System32\bash.exe`（WSL stub，UTF-16LE 错误串 → 乱码）。引擎改为候选解析：`settings.shellPath`/`RPI_BASH_PATH` → Git 安装根（含 PATH 上 `git.exe` 反推，覆盖 `D:\Git`）→ PATH 非 WSL bash；WSL 一律拒绝；默认注入 `LANG/LC_ALL=C.UTF-8`（输出仍 UTF-8 优先、控制台代码页回退）。宿主 exe 需重编。
  - **终端**：spawn → 先 listen → `terminal_attach` 回放 backlog（1MB 有界）→ flush resize → focus；shell 候选 pwsh→powershell→ComSpec→cmd；cwd 取会话工作区（显式目录不存在 = Err）；`TERM=xterm-256color`；Windows IME composed-text 兜底；可见性变化时 fit+focus；页签名 = 项目名 + 最小空位序号。
  - **状态面板**：补「目标」（`goal-state` 条目，rpi-goal；3s 轮询）与「智能体」（本线程 `delegate_task` 且 `timing.completedAt` 缺席 = 运行中）分区；面板宽 320px（不是 `w-80`=300，根字号 15px）。
  - **项目/会话索引**：`pi_sessions_index`（跨 `settings.sessionDir` + 项目根 + cwd 扫描，带 skipped/roots 诊断）、`pi_projects_list/save/delete/restore/reorder`（session-meta.json 内 projects/sessionProjects，软删/恢复/重排）；设置页新增「项目」「归档会话」两节；侧栏「移到项目」经 `session_meta_set` 的 sessionProjects 切片持久化（无专用 IPC，写后回读校验）。

- **流式投影铁律**：同一 tool 边界内只保留一个 text part，thinking 一律插到
  该 text part 之前（对齐 pi 落盘 `[thinking, text]`）；否则 live 的
  `text→thinking→text` 会和完成后形状不一致（用户："思考和结论穿插"）。
  `prompt_inner` 的 drain 必须在 prompt 返回后显式停（watch 信号），
  不能等 broadcast sender 关闭——旧 drain 会继续订阅后续 run，同一 delta
  被推 N 次（实测 314 组重复）。

## 已知的环境陷阱

0. **C 盘空间布局（2026-11-14 满盘处置，别再往 C 盘堆缓存）**：C 盘曾只剩
   0.7GB。已迁/已清：`.cargo\targets` → `E:\cargo\targets`（**junction**，
   cargo 实测正常）、`.cargo\registry` → `E:\cargo\registry`（junction）、
   用户 TEMP/TMP → `E:\Temp`、npm cache → `E:\npm-cache`、旧 ZCode rollout
   日志（保留当前会话文件）。**仍占 C 盘的大户**：`~/.zcode/cli/rollout`
   的当前会话 model-io 日志（单个 8GB+，会话结束才能动）、
   `~/.zcode/cli/db`（3.2GB，ZCode 会话库别删）、Roaming\Tencent（用户数据
   微信/QQ，未动）、Roaming\2345Pic / 360se6（用户数据未动）、
   `~/.rustup`（2.6GB，迁 RUSTUP_HOME 有风险未动）。新工具缓存/大文件
   一律放 E 盘；`robocopy /E /MOVE` + `mklink /J` 是搬家套路。

1. **dockview 官方 CSS 必须显式 import**（`main.tsx`：
   `import 'dockview-react/dist/styles/dockview.css'`）——漏掉则 `.dv-*` 定位规则
   全缺，三组渲染成垂直堆叠裸 div。
2. **样式域是 `.dockview-host`**（flexlayout 时代的 `.flexlayout-host` 已不存在）。
3. **vite watch 必须排除 `crates/**`**：agent-protocol 有独立 `target/`，cargo 锁
   `build_script_build-*.exe` 时 chokidar EBUSY 杀死 vite → 窗 ERR_CONNECTION_REFUSED。
4. **CDP 端口 9223 走 `additionalBrowserArgs`**（`tauri.conf.json` 的
   `--remote-debugging-port=9223`）。wry 下这是标准 WebView2 开关。
   `tauri.prod.conf.json` 里该值为空（生产不带调试口）。
5. **窗口最大化"闪烁回来"的根因是自家 `fit_to_monitor`**：最大化窗高 ≈ 工作区
   恒大于旧阈值，250ms 防抖后 set_size 缩回。已加 `is_maximized` 守卫。
6. **前端窗口命令的权限面**：`capabilities/default.json` 是白名单——加命令先加
   权限，否则报 "window.xxx not allowed"。
7. **同值 `setSize` 可能是 no-op**：API 返回成功、`innerSize()` 也报目标值，但
   viewport 没实际 resize。恢复路径 = 先设一个不同值再设目标值（
   `lib/window-reset.ts` 的两步恢复法）。
8. **winit 的 dragging 标志会被"没有物理按键的 startDragging"毒死**：CDP 合成
   pointerdown 触发 startDragging → OS 不进模态移动循环 → 标志永卡 true →
   之后所有顶栏拖拽静默失效。**判定命令必须用物理级输入**；实例被毒后重启即愈。
9. **CDP 动态 import 的项目模块 ≠ 页面静态 import 的实例**：`import('/src/.../x.ts')`
   在 vite 下是第二个模块实例，模块级变量不共享，行为验证会得到假失败。
   **行为验证走真实 UI 路径**；只在纯函数探针里用动态 import。
10. **CSS 注释里禁止半角「星号紧跟斜杠」连写**：CSS 注释不嵌套，`/*` 会在注释内
    再次开启注释 → 整个 `:root` 块被丢弃，令牌全部 undefined（`var(--x, fallback)`
    恒取 fallback）。排查法：`var(--token, 777px)` 探针看是否恒为 777。
11. **main.tsx 样式 import 必须先于 app 图 import**：ESM 按 import 序深度优先求值
    ——app 图（含 ease.ts 顶层 getComputedStyle 令牌读取）先求值会拿到未注入的
    `<style>`，全部静默回退内置值。
12. **CEF 相关坑已随换栈消失**（不再需要 CEF 二进制同目录、RemoteDebugging、
    `Local State` 清理等）。若将来重新评估 CEF，重读该 runtime crate 的文档。
13. **vite preview 服务的是 `%TEMP%\mirach-dist`，不是仓库 `dist`**（2026-11-15
    实锤）：常驻预览命令是 `vite preview --outDir %TEMP%\mirach-dist --port
    1430`。往仓库 `dist` 构建**不会生效**——页面仍加载旧 hash，改了前端看不到
    （本次设置页白屏修复因此多绕一轮）。判定：页面 `script[type=module].src`
    的 hash 是否存在于被服务目录。构建必须带
    `--outDir "%TEMP%\mirach-dist" --emptyOutDir`。
14. **改 Rust 后 `cargo build` 会因运行中的 exe 报 os error 5**：先
    `taskkill /IM mirach-harness.exe /F` 再 build；重启时 WorkingDirectory
    设为 `src-tauri\target\debug`（CEF/WebView2 依赖文件在同目录）。
15. **面板栏签条被 open 锚误藏（2026-11-15 实锤）**：
    `.dv-tabs-and-actions-container:has(.dv-open-tab-title){display:none}` 的
    原意只是藏「**只有**打开页」的空态签条；但 open 与实签同组（拖入 /
    `moveTo` / 存档异常都会发生）时整条被藏——用户报「标签页没了」。
    判据必须收窄为 `:has(.dv-open-tab-title):not(:has(.dv-default-tab))`
    （open 签渲染 `.dv-open-tab`，实签渲染 `.dv-default-tab`；**嵌套
    `:has` 是非法选择器**，不能写 `:has(x:has(y))`）。
    另：直接把面板 `moveTo` 进 open 组不会带 `params.region='panels'`，
    `handlePanelAdded` 的撤锚与 `handlePanelRemoved` 的末签判据都认不出它
    ——手工/测试建面板必须补 `region`，正式路径走 `openPagePanel`。
16. **终端「文字挤在一起」= 隐藏态启动的尺寸竞态（2026-11-15 实锤）**：
    面板在后台/零尺寸时 xterm 只能按内置 80×24 fit；先 spawn 再用真实尺寸
    resize，ConPTY/PSReadLine 会重绘旧屏（banner 与提示符在行 0 和行
    41 各出现一次 = 用户看到「内容被撒开/挤在一起」）。同时隐藏态
    `term.open()` 的滚动同步 rAF 与 `dispose()` 竞态会抛
    `Cannot read properties of undefined (reading 'dimensions')`。
    修法（terminal-pane.tsx 的 `ensureSpawned`）：**只有容器
    clientWidth/Height > 0 才 `term.open` + fit + spawn**；隐藏时挂起，
    由 ResizeObserver / `onDidVisibilityChange` / 活动签 effect 重试。
    `term.open` 之后才存在 textarea，输入法兜底的监听也必须随之延迟挂载。
17. **「已查阅 N 项，已执行 M 命令」总项（2026-11-15 最终定稿，ZCode 9444 实时
    DOM 为基准）**：ZCode 的折叠轮**只有「已工作 N」，没有统计字**——统计是
    展开后内层 `ConsecutiveSummaryGroup` 的头（9444 实测：折叠 trigger 文本
    仅「已工作 12 分 14 秒」，展开 content 里才是「已查阅 11 项…」）。
    分组规则（`groupConsecutiveAssistantSummaries`）：思考 + explore/run/
    change/session 工具是摘要行；**assistantText 正文、子代理 Agent/Task、
    工作流工具、未归类工具（MCP/ToolSearch/ask_user…）、待审批行、图片/文件**
    是边界，边界后开新组；todo 行被过滤（不断组）。新 user 轮、以及最后正文
    之后的 following 工作也会各成新的组。ZCode 的场景里组内只有「思考 +
    工具」行，没有正文 commentary（9444 实测组内子行全是这两类）——所以它
    看起来一轮一个总项。
    **宿主的两处有意偏差**：
    ①pi 在每个工具批次前写 commentary 正文；严格按 ZCode 的正文边界会碎成
    十几个组头，宿主把非空正文并进当前组（不新开组）；
    ②ZCode 组内 <2 行平铺；宿主单行也建组头，避免「第一条工具裸行、第二条
    到达才变组头」的跳变。
    组默认**收起**；运行中收起头滚动最新动态摘要，完成后收起头显示统计；
    用户点开才看到思考/正文/工具行。
18. **运行态只允许一个「工作中」，且挂在输入框上方（2026-11-15 用户定稿）**：
    ZCode 的观感是 composer 上方一行 orbs + `工作中 N`；消息内没有
    「仍在工作」，也没有轮尾第二个加载位。宿主曾把 ChatLoading 迁到轮尾
    （`aui_turn-loading-slot`），用户明确要求回到输入框上方——已回退为
    footer 单实例。`MessageStallIndicator` 已删。计时起点取当前 run 的
    assistant `createdAt`（重启/切会话恢复运行轮不再从 0 计时），0 秒也
    显示时长。orbs 动画驱动改用 `setTimeout(16ms)`（CEF 下 rAF 会停 400ms+
    → 球体看起来冻住）。
19. **工具行对齐要点（2026-11-15）**：`read` 用放大镜 + **文件名**
    （完整路径进 tooltip）；`websearch/web_search` 是 ZCode search 行
    「查找 {query}」不可展开（旧 WebSearch 结果卡解析不了 rpi 的纯文本
    结果，退化成 JSON——已删）；`webfetch/web_fetch/fetch` 单独一行
    「网页抓取/正在抓取 <url>」，prompt 不能替代 URL；`ask_user` 运行中
    不可展开（`canToggle={!running}`）；bash/powershell 的英文
    `description` 不显示（退回 command；中文 description 保留），避免
    「已执行 Run radio tests」这类英文夹在中文界面里。
20. **运行中插话 / 排队（ZCode 源码 + 9444 实测，2026-11-15）**：
    ZCode 默认 `followupMode = queue`（设置 `zcodeInteractionBehavior ===
    "guide"` 才切 guide）；运行中输入框 placeholder 是「继续输入以排队后续
    修改」，Enter 把消息加入 **follow-up 队列**，不是停止。**有草稿时停止钮
    隐藏**（`showStopControl = canStop && !hasDraftToSubmit`），停止走 Esc
    ——所以运行中不可能同时出现「发送」和「停止」两个黑按钮（宿主曾同时
    渲染，用户实报"两个发送按钮"）。队列面板项可 Steer/Send now/Edit/
    Remove；stop 或 run error 时队列暂停并可 Continue。Ctrl/Cmd+Enter 在
    queue 模式是反向投递（startNow/steer），guide 模式反之。
    宿主落地：
    - 运行中有草稿 → 只渲染「排队消息」按钮（普通 onClick 直接
      `aui.composer.send()`；核心 `ComposerPrimitive.Send` 在 running &&
      !capabilities.queue 时是 disabled 的）；无草稿 → 只有停止钮；Esc 停止。
    - Enter 在 `onInputKeyDown` 里拦截（核心默认 Enter 在 running 且无
      queue capability 时直接 return）→ `aui.composer.send()` → runtime
      onNew 入本地队列。
    - **lane 收尾竞态**：RUN_FINISHED 到达 ≠ prompt 返回，引擎 lane 仍
      busy，POST 会得到 "Lane main already has an active run operation"。
      新增 IPC `pi_lane_busy`（`AgentHarness::snapshot().active`）；onNew
      与队列 drain 先查它，busy 就留在队列；drain 最多等 30s，仍 busy 则
      2s 后重试（不硬发、不丢消息）。UI idle 但 lane busy 时 enqueue 会
      自排一次 drain（否则没有 run 收尾事件可等）。
    - 未做：真 steer（`AgentLane::steer` 引擎已支持，缺 IPC 与「已引导」
      行渲染）。



## 架构（详见 `docs/architecture.md`）

```
L1 前端（纯投影，只渲染不持真相）
   assistant-ui（聊天 Store + 渲染，永不 innerHTML agent 产出）· dockview（布局）
   shadcn/ui · TanStack Query（非会话查询）· Zustand（UI 状态）· XState v5（run 轮次机）
L2 桥接层（双通道正交）
   AG-UI HTTP+SSE（axum，127.0.0.1:0 + token，经 IPC 下发端点）
   Tauri IPC（会话 CRUD / UI 上下文 / 窗口/文件/通知 / A2UI $action target:client）
L3 Rust 应用层（src-tauri）——持 UI 上下文与业务数据，不持 Agent 会话真相
L4 pi-adapter / pi SDK——**会话真相**（JSONL）
L5 Tauri v2 Mobile（未做）
```

**唯一真相源**：UI 态 = Zustand；run 生命周期 = XState；会话消息/分支 = pi；
业务数据 = SQLx；审批态 = Rust ApprovalRegistry；事件传输序 = AG-UI seq。
任何字段出现两个写入者 = 设计错误。

## hermes peer lending wire（2026-11-19）：WS 方法分派 + `/v1/runs` 路由

grant 基础层（HMAC 签发/校验/scope/fingerprint/execution policy digest）之上，本轮补齐
对端可调用的**路由层**，让 hermes Desktop/网关能把 mirach 当作 peer lender：

- **WS `/api/ws?token=`**（axum WebSocket，挂在 peer 服务上）：
  accept 后首帧 `gateway.ready`（含 `room_link.catalog`）。方法面 = lender 面
  （`gateway.ping` / `profiles.list` / `groups.capabilities` / `groups.peer.invite` /
  `groups.peer.revoke`）+ **home 面**（`groups.peer.register` 经 `pi_groups::rpc_dispatch`
  并带 live `_probe` 探测；`groups.list/state/log/create/send/stop/continue/retry/discard/
  driver_append` 同一校验链）+ **会话面**（`session.create/resume/list/interrupt/compress`、
  `prompt.submit` → bot 泳道）。未知方法答 `-32601`；`groups.state` 带
  `driver_status.peer_routes`（Desktop `peerMemberStates` 读它）。
- **`groups.changed` 真实扇出**：`groups.*` 变更成功后（IPC 与 peer WS 共用
  `pi_groups::rpc_dispatch` 入口）向所有 peer WS 广播 `{room_ids, broadcast_id}`；
  `gateway.ready` 的 `change_events` 为 `true`，`replay_epoch` = 进程代际（毫秒）。
- **HTTP（同一 peer 服务）**：
  `GET /v1/room-members/capabilities`；`POST /v1/room-members/invitations`（201）；
  `POST /v1/room-members/grants/refresh`（403 `room_reauthorization_required` /
  `room_execution_policy_changed`）；`POST /v1/room-members/grants/revoke`（空体幂等）；
  `POST /v1/room-members/runs/close`；以及 `POST /v1/runs`（幂等 admission，202；
  无 grant 时走 Bearer 宿主令牌的 API-key 普通 runs 面，房间字段无 grant 一律
  `room_grant_required`）、`GET /v1/runs/{id}`（可轮询状态，含 `waiting_for_approval`）、
  `GET /v1/runs/{id}/events`（SSE，`id:` 序号 + `run.status` / 终局 `run.<status>`）、
  `POST /v1/runs/{id}/stop`（fenced，`stopping`）、
  `POST /v1/runs/{id}/approval`（仅 `once`/`deny`）、
  `POST /v1/runs/{id}/clarify`（回灌 todo ask 邮箱）、
  `POST /v1/runs/{id}/steer`（运行中注入指导，`accepted:true`）、
  `POST /v1/runs/{id}/resolve-unknown`。
- **台账**：`src-tauri/src/hosted_rooms/grants.rs`——撤销围栏
  `hosted_room_peer_reservations` / `room_grant_is_revoked` /
  `peer_room_grant_is_current`（三张第 4 层表 P1 已建，未改 schema）；
  `src-tauri/src/pi_peer_runs.rs`——运行记录 + 房间↔隐藏泳道会话映射（`peer-runs.db`，
  与 state.db 分库）。
- **成员轮次落地**：`/v1/runs` 的 prompt 转进 bot 泳道（`Group: <room_id>` 会话），
  `pi_bot_state` 增 `last_status` / `last_output` 供轮询终局；monitor 线程在轮次结束后
  写回 durable 状态，`stop` 走 `pi_bot_interrupt`，`steer` 走 `harness.steer`
  （`pi_bot_steer`），`approval` 走 `pi_bot_approval_respond`，`clarify` 走
  `pi_bot_answer_clarify`。
- **与上游的已知差异（非裁剪借口，均有因）**：`driver:false` + `persistent_process:false`
  （宿主是桌面进程，群聊驱动在 mirach 自己的 canonical-group-driver；不假称常驻网关）；
  `profiles.list` 单行（mirach 无 profile 系统，bot 是插件概念）；
  SSE 事件按 durable 状态迁移生成（宿主没有 hermes 的 token 级 agent 回调流）；
  `resolve-unknown` 以本宿主 run_id 作 admission_id 匹配。
- 门禁：`cargo check` / `cargo test`（724 条，含新增 7 条 grant/dispatch 单测与
  5 条台账单测）/ `vitest 1082` 全绿；实机 E2E 全链通过（WS invite/revoke/session.*/
  groups.list、HTTP invitations/capabilities/runs/stop/steer/SSE/API-key runs、
  runs/close，真模型回复）。

### 全链对账轮（2026-11-19 续）：hermes 客户端语义 E2E + 三个实机缺陷

E2E 脚本 = `E:\Temp\peer-hermes-wire-e2e.mjs`（仓库外临时产物）：**完整按 hermes
客户端语义**逐条走（`canonical-group-peers.ts` 的 `peerTargetState`/`seatPeer`、
`hosted-room-peer-http.ts` 的 `_admit_dispatch`/`refresh_grant`/`stop_receipt`），
对运行中的实机 app 跑：capabilities 准入检查 → WS `groups.peer.invite`
（ttl=86400 + status_ttl=30d 的 seatPeer 边界值）→ `groups.peer.register`
（live probe）→ `/v1/runs` {input,hosted_room_dispatch} + `Idempotency-Key:
room:{task}:{gen}` → 重放 `replayed:true` / 换体 409 → 轮询终局读 `output`
（真模型 3+4=7、5+6=11）→ grants/refresh + 替换 grant 探活 → gen2 派发 →
`stop`（空体）→ `stopping`→`cancelled` → lender `groups.peer.revoke` →
再派发 403 `room_reauthorization_required` → 全绿（`HERMES_WIRE_OK`）。

**E2E 当场抓到的三个真缺陷（都已修）**：

1. **`MAX_STATUS_GRANT_TTL_SECONDS` 少乘一个 60**（`pi_gateway_peer.rs`）：
   写成 `30*24*60` = 12h，上游是 30 天 → seatPeer 传 `status_ttl_seconds=30d`
   时 WS invite 直接 `room grant lifetime is invalid`（旧 E2E 只传 ttl，没测
   horizon 边界，漏了）。修 = `30*24*60*60` + 新单测
   `invitation_honors_full_status_horizon`（30d 边界过 / 30d+1 拒）。
2. **`groups.peer.register` 回执 `mode` 写的是 "desktop"**：上游回 link mode
   **`"direct"`**（`hosted-room-wiring.ts` register 回执）。同时 probe 的
   `home_install_id` 校验按上游对齐**本机 authority id**（原写成房间 authority
   id，单机同值时无差，但口径要正）。修 + E2E 断言 `mode === "direct"`。
3. **冷启动假 `interrupted`（真 bug，E2E 首发轮次必现）**：monitor 与
   `resolve_run_status` 都用「bot 泳道此刻不在 running」当终局/重启信号——
   第一条 dispatch 要现建会话，提交后到轮次真正开跑之间有窗口，running 仍为
   false → 轮次被误写成 `interrupted`（"gateway restarted"）。修法 =
   **真终局信号**：
   - `pi_bot.rs`：`BotRunState.last_turn_seq` 终局计数器（与 running=false /
     last_status 同一临界区 +1），`pi_bot_state` 透出；
   - `pi_peer.rs`：admit 在提交前记 `pre_seq` 传 monitor；monitor **只在
     `last_turn_seq > pre_seq` 时收口**（30 分钟上限，超时如实 failed 不空转）；
   - `pi_peer.rs`：进程内活跃 run 注册表（`active_peer_runs`），
     `resolve_run_status` 只有**不在注册表**时才判 interrupted（真重启残留），
     在表内 cold 窗口保持原态；`stop` 对不在表的活态记录同样按重启收口。

**如实记录（非缺陷）**：lender catalog `persistent_process:false` —— hermes
Desktop 的 `peerCatalogProblem` 要求 true 才肯把 bot 借进别人的房间；上游对
**Desktop 管理的网关**同样报 false（`catalog_mapping`：`HERMES_DESKTOP=1` 时
恒 false），即 hermes 自己要求 lender 是 `hermes serve` 常驻进程。宿主是桌面
应用，报 false 是与上游同款的老实话——真 hermes Desktop 会因此拒 seat
（`persistent_process_required`），wire 本身全通（E2E 已证）。mirach↔mirach
走原生 peer 面，无此约束。

**仍存的已声明间隙**（未动）：`driver_status` 只有 `peer_routes`（无
`working`/`counts`/`member_activity`/`routing_modes`，插件 UI 优雅降级）；
room-link 状态只在 register 写 `registered`（无 `needs_reauthorization`/
`unavailable` 的写入者）。

## 多会话并列窗格（2026-11-19/20，hermes `_sessions` 模型落地）

**结论先行**：`session-N` dockview 窗格从"只能看"变成**真正能并行收发**。
此前 `side_open/side_prompt/side_interrupt` 是恒 `Err` 的占位（rpi 竖链时
误判"非 main lane 只读"挡住了整条路），agui 对 `thread != "main"` 走
`side_*` → 非活动窗格一发送就 `200 {"runId":null,"error":"…分栏（rpi 非
main lane 只读）…"}`（实机复现）。

**根因澄清**：rpi 引擎根本不禁止多会话——`session::build` 每次返回独立
`HarnessLive`（各自 harness/lane/writer lease/broadcast），"非 main lane
只读"说的是**同一会话内的 side lane**。限制是宿主 `EngineShared.live:
Option<…>` 这个单柄假设。hermes 对偶 = `tui_gateway/server.py` 的
`_sessions` 注册表（每个会话一条活记录）+ `prompt-submit-<sid>` 每轮一线程
+ Desktop 的 session tile（`session-states.ts`：中央缓存摄取**所有**会话事件
，tile 只是投影）。

**落地（全部在 Rust，前端协议零改动）**：

- `EngineShared` 增 `side: Mutex<HashMap<thread_key, Arc<HarnessLive>>>`；
  `live`（前台）+ `side`（窗格）+ `retired`（退役保租约）**三张归属表**
  兜住单写者约束：同一会话文件不允许主柄与窗格、或两个窗格同时在场
  （重建必撞 "writer lease is already held"）。
- `side_open(thread, path)`：幂等复用（同键同路径直接 Ok）；`retired`
  命中 → 迁出复活（不重 acquire lease）；否则按会话文件反推工作区
  `build_harness`（复用 `workspace_from_session_path`），attach 该桥的
  `ui_dialog` 邮箱；`watch_runs`（goal 校验）只对新建挂。
- `prompt_inner` 抽出 `run_prompt_on(live, …)`（前台与窗格共用排水逻辑）；
  `side_prompt` / `side_interrupt` / `side_lane_busy` / `side_close` 全真。
  `pi_lane_busy(thread)` 按 thread 路由（main → 前台，窗格键 → 该窗格句柄）。
- 切前台协调：`open_session` 先查 side 表——同路径句柄直接**上台复用**
  （不重建，lease 不冲突）；`delete_session` 对窗格在场会话拒绝
  （"该会话正在窗格中打开"）。窗格未 mount 的句柄暂留 side 表（应用级
  生命周期；`side_close` 退役入口已备，未接前端）。
- **已知边界（如实）**：窗格里的 ask/审批卡不渲染（`Thread scoped` 跳过
  主会话单例的 ApprovalCards/AskCards，后端注册表也只扫前台邮箱）——
  窗格里触发交互工具会等超时；要对齐 hermes tile 需把 ask/approval 按
  thread 分桶（后端注册表加 `thread` 维度 + 前端 tile 内渲染），单独一轮。
  排队/steer 在窗格内是 fail-loud（与主会话同语义）。

**实机 E2E**（`E:\Temp\peer-tabs-e2e.mjs`，仓库外）：新建 A/B 两会话 →
A 主柄预热落盘 → B 上台（A 退役）→ **主柄 B 与并列窗格 A 同时 POST**，
两条 SSE 各自收到完整回复（11 / 7），无串扰 → side 上起长 run，
`pi_lane_busy(side)=true && main=false` → `pi_interrupt(thread=A)` 只停
窗格 → `pi_open_session(A)` 从 side 表上台复用（`messageCount` 连续）。
TABS_OK。门禁：cargo test **726** / vitest **1090**（88 文件）。

## 语音 402 诊断（2026-11-19，用户报"语音会话已断开：WSS 连接失败"）

**根因 = MOSS 账户余额不足，不是宿主 bug**。原始握手探针对比（raw
Upgrade，同端点 `api.mosi.cn/v1/realtime?model=moss-live-1.0`）：

| 请求 | 响应 |
|---|---|
| 用户真 key | **402 Payment Required**，body `{"error":{"code":"insufficient_credits","message":"billing error"}}` |
| 伪 key | 403 `iam api key auth failed` |
| 无 key | 403 `missing bearer api key` |

即：端点/协议/模型/鉴权通道全部正常，**这个 key 的账户积分用完了**
（11-15 配 key 实测全链时还有免费额度）。处置 = 平台充值/换 key
（设置 → 语音 → MOSS API key 只写不读）。

**顺带修**：`pi_voice_moss.rs` 握手错误原本只透传 tungstenite 的
`HTTP error: 402 Payment Required`，**不含 vendor body**——用户看不出是
计费问题。新增 `describe_handshake_error`：`Error::Http` 时解 OpenAI 风格
错误体，附成 `HTTP error: 402 Payment Required（insufficient_credits:
billing error）`（解不出 body 原样返回）。单测
`handshake_error_includes_vendor_body` 锁 402 体 + 非 HTTP 错误透传。

## 侧栏切换性能 + 系统托盘（2026-11-19，两边都照上游对偶）

### 侧栏会话切换（内置 agent 完成，本仓核验后提交）

**hermes 对偶**（`open-session.ts` 的 `openSession → focusOpenSession` 先前端短路、
再 resume RPC）。三处改动：

1. **同会话短路**（`runtime.tsx::switchToThreadPath`）：`id === currentThreadIdRef.current`
   时只 `showChat()` 返回——点已在看的行不再重建 harness/全量水合；
2. **乐观高亮**：点行立即 `setActive(id)` + `setCurrentThreadId(id)`，不等
   `pi_open_session` 往返；失败时 catch 里**回滚选中态**（否则侧栏高亮一行、聊天区
   却是旧会话——比不亮更误导）；`refreshThreads()` 从 await 改为 `void + catch`
   （目录统计不阻塞切换感知，失败 console.error 可见）；
3. **`rowMetaCache`**（`thread-list.aui.tsx::useSessionRowMetas`）：WeakMap 按 item
   引用缓存行投影——`threadItems` 每次刷新是新数组，全量重建会让每行都换新对象、
   下游 memo 全失效（会话越多越卡）；附带删掉三连 `prune` 的复制粘贴冗余（留 1 次）。
4. **⋯ 左键开菜单修复（2026-11-19 冒烟实测发现）**：会话行菜单是受控
   ContextMenu（`open={menuOpen}`），但 `onOpenChange` 只处理关闭——⋯ 点击
   （ContextMenuAnchor.onClick → `setOpen(true)`）的打开请求被吞，**该行 ⋯
   永久点不开**（右键路径直写 `setMenuOpen(true)` 所以正常）。修复 = 双向镜像
   `setMenuOpen(next)` + 关闭时 `setMenuAnchor("trigger")` 复位（右键把锚态置
   "point" 后不复位，会让该行 ⋯ 从此失效——`ContextMenuAnchor.onClick` 里有
   `anchor !== "trigger"` 早退）。**受控动效菜单的 onOpenChange 必须镜像双向**；
   其它 ContextMenu 调用点均为「右键-only、point 受控」，单向无此问题。

### 系统托盘（ZCode `desktopTray.ts` 完整对齐）

Rust 侧在 setup 里建（`main.rs`），**核心语义早就在**（左键/双击=显示主窗、✕=
隐藏到托盘、右键菜单），本轮把菜单补到 ZCode 对齐：

| ZCode 菜单 | 宿主 | 实现 |
|---|---|---|
| 打开 ZCode | 打开 Mirach Harness | `show_main` |
| 新建任务 | 新建任务 | `show_main` + emit `mirach:tray:new-task` → 前端桥 → `triggerNewChat`（段头新建钮既有通道，app-context-menu 导出） |
| 打开工作区 | 打开工作区 | emit `mirach:tray:open-workspace` → 前端桥 → 文件夹对话框 → `sessionWorkspaceStore.requestCreate`（composer 工作区行同一请求桥） |
| 关于 ZCode | 关于 Mirach Harness | `pi_open_settings_window(Some("updates"))`（设置窗「版本与更新」节） |
| 检查更新（prod）/ 导出日志 | **不渲染** | 宿主无对等面（更新面在设置里，导出无入口）——不放假入口 |
| 退出 | 退出 | `app.exit(0)` |

- 前端桥 = `components/layout/tray-bridge.tsx`（挂 `app/index.tsx` 的 App 根，与
  EngineBridges 并列）；事件名 `mirach:tray:new-task` / `mirach:tray:open-workspace`。
- ZCode `executeTrayCommand` 的**顺序契约**：先 `showCurrentWindow()` 再执行命令——
  Rust 侧 `show_main` 之后才 emit，前端不做聚焦。
- **closeToTray 陷阱已消解**：此前 ✕ 隐藏后没有任何入口把窗口调回来（"打不开"事故
  的根因之一）；托盘菜单「打开」与左键即恢复入口。close 偏好关（`closeToTray=false`）
  时 ✕ 仍走 `app.exit(0)` 真退出（`wire_window` CloseAction::HideToTray 运行时读偏好）。
- 托盘图标 = `app.default_window_icon()`（bundle icon.ico）；tooltip = "Mirach Harness"。
- 门禁：`cargo check` 0 错 / `cargo test` 724 过 / `vitest` 1073 过（86 文件）/
  tsc 非镜像区 0 错；实机 exe 启动 10s 存活（托盘创建无 panic，已杀干净）。

## 会话打开/切换性能第二轮（2026-11-19，用户："切换会话不卡顿……切换长会话
## 更慢，bot 切换也很慢"；"参考 hermes 是怎么管理的"）

**分层实测（先测再改，11MB / 2036 条消息的巨会话 01a1df20 为基准）**：
引擎侧 `pi_get_messages` 冷 3.9s / 热 1.4s（7.8MB 载荷）、
`pi_get_timeline_markers` 0.9s、`pi_get_state` 0.35s（内部 `snapshot_stats`
全文件重扫）、`pi_list_sessions` **4.1s**（每次 run 收尾的 refreshThreads 都
付一遍：read_snapshot 重放全部 39 个会话 + 又一次 `read_to_string` 整文件
只为读 header 首行）。前端 hydrate 转换本身只要 2ms（7.8MB → 140 条
TurnMessage）——**地板全在引擎重复重放 + IPC 载荷**。

### ① hermes 视图窗移植（`render-weight.ts` + `transcript-window.ts`）

hermes 的 render-weight + transcript window 逐条移植（纯函数 + 9 条单测）：
`partPaintWeight`（text/reasoning=ceil(chars/512)；todo 族=0；卡类工具 6；
其余 1）、`selectTranscriptWindow`（**从最新往回按轮累计**，够预算且 ≥
MIN_VISIBLE_TURNS=8 才停；轮永不切开）、FIRST_PAINT=20 → FULL=600 分步
（rAF `nextBackfillBudget` +48/帧）→ `expandBudget`（"显示更早"按钮 /
滚到顶继续上滚）。接线在 `thread.aui.tsx::MessageTurnList`：**切会话按
`ids[0]` 复位预算**（render 期 reset，不靠 effect）、只裁**渲染**不动
store 与 scrollTop。**与 hermes 的差异**：后端分页（tail 120 行
`getOlderSessionMessages`）**未移植**——宿主 store 仍是全量水合，此窗只管
DOM；巨会话首屏仍受 IPC 载荷约束（下节的缓存把热路径砍到 0.6s）。

**TurnGate 已退役（2026-11-24）**：轮级 IntersectionObserver 卸载 + 等高
占位已删（用户实报"长会话往上滚动没法滚动、闪烁；切换会话也有闪烁"）。
此渲染窗口保留；不再按视口卸载轮次，DOM/滚动高度稳定。

### ② 引擎派生面缓存（`pi_session.rs`，宿主侧零引擎改动）

- **`messages` / `timeline_markers`**：`DerivedCache` 键 = **path + len +
  mtime + leaf**。leaf 必须入键——切分支只改会话叶不改文件 stat，只按 stat
  会把旧分支消息面发出去。文件未落盘（新会话）不进缓存。
- **`list_sessions`**：`session_facts_cache`（path → stat + 整行）逐文件
  复用；header 改 `read_first_line`（BufReader 只读一行，原来整文件
  `read_to_string`）；坏文件仍每次重试（失败不缓存）。
- **`snapshot_stats`**：`stats_cache` stat 校验（`state()` 高频调用）。
- 实测：`list_sessions` 4137→**4ms**（热）、`state` 352→**4ms**、
  `markers` 955→**5ms**、`get_messages` 1661→**601ms**（余下是 7.8MB IPC
  管道本身，冷路径仍 1.4s 一次）。全部按 append-only 语义失效（文件一写
  stat 即变），不引入 TTL / 猜测失效。

### ③ 每秒 ~100ms 主线程尖峰（空转也有）——根因与修复

空转 profile 每秒一个 101~152ms 长任务、同步 flush 贯穿侧栏整棵子树
（rows / 两行对话框 / 侧栏选项菜单），但**零 DOM 变更**。根因链：
`approval-cards` 每秒轮询 → `approvalBridge.setState({pending: 新数组})`
**无条件** → `useThreadDisplay` 直接订阅 `s.pending` 数组 → 会话树每秒
重渲染；`components={{ ThreadListItem }}` 内联对象再把行的 memo 打穿。
三处修复：① 两个 bridge（approval/ask）refresh 做**结构相等去重**（真变化
才 setState，错误路径语义不变）；② 侧栏改布尔订阅
`s.pending.length > 0`（第二道闸）；③ `ITEM_COMPONENTS` 提升为模块级常量
+ `SessionRowScope`/`ThreadListItem` memo 化 + `forkPointCount` 改订阅计数
（数组引用不再击穿整列表）。修复后空转 6s **longtask = 0**。

### ④ 端到端复测（巨会话 11MB/2036 条，dev 模式）

点击切到巨会话：首条新轮 DOM **2.9s**（窗口按钮同帧出现）；DOM 只挂
**尾部 18 轮**（不再全量 200+ 轮）；总阻塞 1.9s（此前 3.6s，最大单次
0.96s = 18 轮 dev 版提交）。小/中会话切换回到引擎地板（热 ~40-600ms）。
`vitest 1084`（87 文件）/ `cargo test 724` / tsc 非镜像区 0 错。

**遗留（有意不移植）**：hermes 的后端 tail 分页 + store retention——宿主
全量水合架构不动（改动量/回归面大），巨会话首开仍付一次全量 IPC（热
0.6s）；`thread-list.aui.tsx` 的 memo 家族已在，但行订阅表若再出现
「每秒全树重渲染」症状，先查两类模式：**轮询桥无条件 setState** 与
**内联对象/数组订阅**。

### ⑤ hermes 尾页水合完全对齐（同日续，替换上段「遗留」）

上段遗留的「后端 tail 分页」已按 hermes `store/transcript-tail` +
`app/chat/transcript-backfill` 模型落地：

- 新 IPC `pi_get_messages_page(before?, limit=256)` → 引擎
  `SessionTree::transcript_page`（**bounded read**，不整树 payload 重放）→
  wire `{messages, entryIds, hasMore, leafId}`。
- **轮边界回退**：整页会在轮中间切断（页首 assistant/toolResult →
  水合后 toolResult 找不到宿主部件 = 丢卡）。页首不是 user 消息时回看最多
  2 页，把上一页「最后一条 user 起」的后缀并入，保证每页从轮首开始；
  hasMore 相应扣减。
- 前端 `assistant-ui/transcript-paging.ts`：`hydrateTranscriptTail(actor,
  sessionId)` 取代 7 处 `invoke('pi_get_messages')`（runtime 挂载/切叶/fork/
  回父/branch 切换等全部走它）；`loadOlderTranscript()` 用 `entryIds[0]`
  作 `before` 游标补页，经 actor 新事件 **`PREPEND_HISTORY`** 前插（保留
  已加载行与在途 run 段，不触碰 currentRunId/usage）；
  `ensureFullTranscript()` 供导出 Markdown 等显式全量面（先补全再触发官方
  导出，避免静默截断）。
- 行 key = 原始条目 id（`msg-<entryId>-<role>`），跨页 prepend 时 React
  key / 树节点身份不漂移。
- 时间线标记新增 `beforeMessageIndexFromEnd`（后端沿分支单遍统计）：前端
  落桶 = `已加载条数 − fromEnd`——头部未加载时标记不会错位（负值不画），
  补页后自动出现。
- 「显示更早的消息」按钮 / 滚顶：`hasMore` 时走后端补页，后端耗尽才退回
  纯前端渲染预算展开。
- **自动命名守卫**：`hasMore` 时 store 首条 user 不是会话开头 → 跳过自动
  命名（不造假标题），可手动重命名。
- 实测（巨会话 11MB / 2041 条）：首屏尾页（256 条扩展至轮首，实取
  303 条）**333ms**（改前全量水合 1445ms）；再补页 606ms（283 条）；UI 全链
  （点行切换 → 连点两次「显示更早」）DOM 6→17→18 轮、console 零错误（无
  孤儿 toolResult 告警）。`pi_sessions_index` 共用事实缓存后 **7.7s → 71ms**；
  bot 行打开 69ms。**冷开仍由引擎 replay 决定**（0.5MB 362ms、0.8MB 791ms、
  11MB ~4.9s；热开 3~6ms）——未做 lazy-open，属引擎地板。
- **打开前先画（peek-first）**：引擎 `pi_open_session` 对巨会话要整树 replay
  （实测 11MB ≈ 4.9s，热开 3~6ms）。新增 `pi_peek_session_tail(path, limit)`
  **不打开引擎**，直接从 JSONL 尾部回扫一页（父链回溯 + 轮首裁剪），与
  `pi_open_session` **并行**：peek 先回且引擎未就绪 → 先画尾部；引擎就绪后
  统一走 `hydrateTranscriptTail` 对齐（同条目 id 重水合，无 key 变化/闪烁）。
  实测巨会话点行 **首屏 557ms**（原 ~5s），peek 本身 64~68ms。守卫：
  `sessionCatalog.activeId` 仍是目标会话才挂预览（连点切换不串）。
- **bot「没切换」根因坐实（2026-11-21）**：hermes-bots 插件花名册按
  (profile, 标题"Bot Chat") 解析每个 bot 的常驻会话——hermes 每 agent 有
  独立 gateway 命名空间所以唯一；mirach 单引擎单命名空间下**所有 bot 的
  canonical chat 同名**（实测 5 个 "Bot Chat" 会话）→ 点谁解析到同一个。
  修复属插件特性级（per-bot 标题/命名空间，连带 system prompt 的 DM 指令
  与 CLI 流），另立一轮。宿主侧已修：roster「正在看」高亮（此前硬编码
  isActive=false）+ 锚交叉守卫（launchBotSession）。
- **引擎 replay 根因拆分（load_streaming 内分段计时，MIRACH_OPEN_TIMING）**：
  11MB/6134 行 loop=1.86s = sha256 506ms + reducer apply 628ms + 行内未解释
  ~630ms（async poll/锁/policy）+ parse 仅 38ms（serde 不是瓶颈）；
  read_snapshot 另有 into_detached/from_state ~1.0s（open 不走）。cold=0：
  该会话没有 legacy assistant frame。再压需动引擎（去 restore 期 sha /
  reducer 增量结构）——upstream 级改动，暂不做。引擎侧已留 env 门控诊断
  （streaming.rs Scanner 分段），补丁层随 G:\pi-rust-main 本地化（非 git）。
- **release 模式实测**：`cargo test --release -- --ignored timing_storage_only_giant`
  → **295ms**（debug 3.0s = **10× 膨胀**）。引擎 replay 在 release 下不是瓶颈。
  用户感知的"卡顿"全部来自 dev 模式的 StrictMode + jsxDEV + 无优化 sha/reducer。
- **bot 对话区标题 / 页签（2026-11-23 定稿）**：`ChatTabLabel` 下行（会话名）
  与页签读 `sessionDisplayName`。canonical chat 的**真名仍是 "Bot Chat"**
  （引擎落盘 + registry 匹配不动），显示层与普通会话同款：**优先派生标题**
  （首条用户消息），还没有派生标题时回落到 `botDisplayName(bot)`。
  `runtime.tsx` refreshThreads 对 bot 锚会话的 `row.title` 覆写负责这一层
  （用户："下面是会话名，现在会话名变成 bot chat 了"）。旧布局存档里的
  `Bot Chat · <机器人>` / `<机器人> · Bot Chat` 侧栏标题在 dockview 恢复时
  一并改写。`canonical-chat.ts` 的 `tabTitle` 仍是上游 `CANONICAL_CHAT_TITLE`
  （文件与上游逐字一致）。
- **误判更正（2026-11-21）**：此前记录的"锚交叉 共用 01a1e3ec"是**截断 ULID
  到 8 位的测量伪影**（两个不同会话同一时间桶前缀相同）——全量 sid 对比
  （anchors-full.mjs）证实两个 bot 各有自己的 Bot Chat，插件花名册切换本来
  就是通的；守卫/治疗代码保留（真碰撞仍防御）。
- **切换点击遍历实测（2026-11-21，StrictMode dev）**：全部会话/器人切换零
  console 错误、引擎落点全对。首内容 0.99-1.24s、单帧最大 355-418ms——
  成本=切窗提交（旧 38-48 轮卸载 + 新首屏挂载，一次同步 commit）；补齐已改
  **每帧 +48 权重（1-2 轮）**（原 +290 一页一步实测 300-500ms 长任务），
  消息三组件 memo（ThreadMessage/MessageWithDaySeparator/UserMessage，无 props
  读 context）后预算步不再整列表重渲。StrictMode 双渲染下 dev 数字 ≈2× release。
- **打开耗时拆分（MIRACH_OPEN_TIMING）**：prep(模型解析等)≈1.5ms；
  **纯存储重放 3.0s**（11MB scanner+reducer，`JsonlSessionStorage::read_snapshot`
  单测 `--ignored timing_storage_only_giant` 可复测）；装配/插件再加 ~1.4s。
  引擎地板坐实——宿主侧已把全部可见延迟移出关键路径（peek-first），
  仅「打开窗口内立即发送」会等装配完成（postRun await）。
- **装配提示**：`engineAttaching`（transcript-paging store）+ composer 上方
  「正在准备会话（引擎载入中）…」一行（EngineAttachHint，`isRunning` 时让位）。
- **发送等待打开**：peek 先画后，发送（postRun）会先 `await pendingOpenRef`
  （切换路径设置的在途 open Promise）——prompt 持锁，不能打在旧会话上/落空。
- **bot 切换同享预览**：`session-preview-bridge.ts`（请求桥）——bots-pane
  打开既有 bot 会话时先投递预览，runtime 执行器做身份双锚守卫（header id 不符
  不预览）+ activeId 未变守卫（连点不抢）+ 引擎已水合守卫（不 shrink），然后
  乐观选中并挂尾部；`pi_open_session` 完成后 reconnect 效果统一对齐。
- **store retention（同日补齐）**：`releaseTranscriptHistory()` 在向下滚离
    顶部时把最老历史页从 actor store 释放（只留最近 3 页，游标随保留窗首条
    推进）；再上滚由 `loadOlderTranscript()` 按游标重读，内容不丢。
  - **设置窗预热 + hide 复用**：`setup` 里延迟 1.5s 构建**隐藏**设置窗（只
    build 不 show，不抢焦点）；前端 ✕ 改为 `hide()` 保实例。首次打开实测
    **1178ms → 21ms**（WebView2 二次建窗成本消失）。

## 上游仓库迁移事件（2026-11-20，必读）→ **已完成重提（2026-11-21）**

**rpi-package（extensions 仓）迁移 → `pi-rust/rpi-extension`**：维护者
DavidHinton-xcpc 于 2026-11-20 11:17 同时关闭 **#362**（goal 完成校验窄版）
与 **#363**（background-tasks `/jobs` 命令面），评论原文："这个仓库正在迁移，
extension 的新仓库后续会公开；相关改动会在新仓库继续推进"——**不是否决，
是挂起等迁移**。

- **2026-11-21 rpi-extension 已落地内容**（full workspace import：packages/
  tools/catalog/registry/docs，crates.io 发布方）。**新仓不含我们的两个改动**
  （核实过：background-tasks 无命令面、goal 无 verify 动词）→ 已在 fork
  HQZ1111/rpi-extension 上重提：**rpi-extension #19**（/jobs 命令面）+
  **rpi-extension #20**（goal 完成校验窄版）。分支：
  `feat/background-jobs-command`（f2c3abf）/ `feat/goal-verify-verdicts`
  （733e172），基于 rpi-extension main 607c00d 单提交构建（git 直连被墙，
  走 Git Data API：tree(base_tree)+commit+ref+PR 四步）。
- **对同步的影响（已执行）**：vendored 插件来源今后 = rpi-extension；
  引擎仓 bigfish1913/pi-rust 不受迁移影响（#348/#355 已合并）。
- 本地克隆 `E:\Temp\rpi-package-pr`（旧仓，仅存档参考）、
  `E:\Temp\rpi-extension-clone` 未建成功（git 直连断续）——fork 操作全走 API。

## Tauri alpha.6 + 引擎 0.27.0 同步轮（2026-11-21，用户："仓库更新了，更新一下tauri3和rpi，然后重新pr"）

### ① Tauri 3：alpha.4 → **alpha.6**（一次过，零 API 断裂）

- crates：tauri / tauri-runtime-wry → `3.0.0-alpha.6`；tauri-build、
  tauri-plugin-dialog → `3.0.0-alpha.4`（各 crate 的最新 alpha 各不相同，
  tauri 自身把 macros/utils 拽到 alpha.4）。npm：`@tauri-apps/api` → alpha.3、
  `@tauri-apps/cli` → alpha.6。宿主用面（wire_window / tray / runtime-wry
  显式 Builder / dialog 插件）在 alpha.6 无 API 变化——cargo check 一次过。

### ② rpi 引擎：0.24.0 → **0.27.0**（59f985a，21+ 提交跨 0.25/0.26/0.27）

- **镜像真实基线 = v0.24.0**（非 0.25/0.26）：`git diff --no-index v0.24.0
  镜像` = **27 文件**本地补丁；其中已上游化（#333 write diffs、#348
  lease/审批/message_agent、#355 子代理名册——上游版本更新更好）→ 跳过；
  真正重放的 = **os_env.rs execution_env（431 行，上游该文件 v0.24→0.27
  零变化 → 整文件直拷）**、find/grep/ls/read.rs 描述（上游零变化 → 直拷）、
  prebuilt_extensions.rs/settings.rs（上游零变化 → 直拷）、
  **BUILTIN_TOOL_NAMES 8 项注册（session.rs 内，3-way 合并）**、
  bash.rs 描述（+463B 合并）、powershell.rs 描述（1 冲突块，取镜像
  #369 措辞——"IMPORTANT: Avoid…用专用工具"是指向专用工具的定稿）、
  actions.rs child_agent_roster 文档（1 冲突块，取上游 #355 的更全注释）、
  session.rs 3 冲突块（全为注释措辞/格式差异，取上游）、
  bash_windows_shell.rs 测试（本地新文件拷入）。
- **有意丢弃**：streaming.rs 的 MIRACH_OPEN_TIMING 诊断插桩（纯计时，
  上游 #368/#394 重写了该文件）。
- **3-way 合并方法（本次的坑，下次直接用）**：`git merge-file -p ours base
  theirs` 的三个输入**必须先统一行尾**（worktree 是 CRLF、镜像 LF——不归一
  化会把整文件打成全冲突，产物 = 双倍大小拼接垃圾）；冲突标记带 label
  （`<<<<<<< E:\…ours`），数冲突要用 `/^<{7}/m` 不是 `^<{7}$`。
- **宿主零 API 断裂**：0.24→0.27 的 SDK/agui/session 面在宿主消费点上
  无需改动——cargo check/test 一次过（727 测试全绿）。
- 旧镜像保留 = `G:\pi-rust-main.old-0.24`（流式诊断插桩在里面，要找回看它）。

### ③ vendored goal fork 对 SDK 0.27 重编译

61 测试全过（unsafe wrapper 在 0.27 的 safe SDK 上仍编译——
`#![forbid(unsafe_code)]` 的 fork 本体没有，wrapper 是 fork 内局部 unsafe
块，合法保留）。DLL 已装（改名替换法，rpi_goal.dll 1090KB，实机探针确认
verify 动词在）。

### ④ 实机启动（三件同验：Tauri alpha.6 + rpi 0.27 + 新 DLL）

job list / get_state / **47 会话列表** / goal v2 状态 / `/jobs` 守卫探针
（返回新命令面文案）全通；**goal 武装无假目标**（arm 回执核验生效）。
门禁：cargo 727 ✓ / vitest 1106 ✓ / tsc 1319（唯一非镜像错 =
transcript-paging.ts 的 TRIM_HISTORY——并行会话 WIP，非本轮改动）。

## 状态面板功能全对齐轮（2026-11-20，用户："做，缺pi 引擎面的复制zcode的然后提pr，全部对齐功能"）

盘点结论先行：**GitActionRow（"提交或推送"第三行）2026-11-17 已实现**（此前
记录过时——GitActionMenu 不再是缺口）。本轮真正落地的四件：

### 1. 终端分区实机验证 + 真缺陷修复（引擎 PR #363）

- **分区渲染 ✓**：真后台作业（模型调 background 工具跑 ping）→ pi_job_list
  真数据 → 分区出现（折叠头「终端 · N 秒 · 1 个运行中」，与上游同构）；
  展开 = 行（label + 时长 + 停止钮）；停止真取消（插件进程树死）。
- **缺陷（引擎，已提 rpi-package #363）**：UI 停止后 pi_job_list 仍报
  running——kill 只结算内存行、cancelled 快照不落盘（旧装 DLL 的命令面无
  persist）。修法 = **给 rpi-background-tasks 加 /jobs 命令面**（list/tail/
  kill，镜像工具动作），会话守卫走「当前会话最新快照成员资格」（命令信封
  无 `__rpi.sessionId`——每次 spawn 都落快照，故 job id 不在本会话最新快照
  = 别的会话的/未提交，拒绝）；kill 走与工具同一条 settle+persist 路径。
  单测 4 条（kill 落盘 / 跨会话拒绝 / list / 畸形入参）；本机 5 个真 shell
  失败在干净 main 同样复现（bash=WSL 启动器，环境性，CI ubuntu 过）。
  **新 DLL 已编译装进 `~/.rpi/agent/extensions`（官方原件备份 `.official.bak`；
  被运行进程锁定时用改名替换法）**，实机守卫探针返回新文案确认生效。
- **诊断教训**：旧装 DLL 与上游 main 有版本漂移（它有命令面，main 是
  tool-only）——别按装的二进制 strings 猜源码行为，以仓库源码 + 重编译为准。
- **快照时序（非缺陷）**：run 期间 append 被引擎排队、turn 边界才提交——
  run 中停止作业守卫会拒（快照未提交），turn 结束后重试即成；应用关闭时
  SessionShutdown 对受影响会话补写终局快照（昨日卡 running 的旧作业今日
  读回即 cancelled，shutdown 补的）。

### 2. 工作流 Stop（宿主接通，无需引擎 PR）

ZCode 的 workflow Stop = `onCancelBackgroundWork(workId)`（后台任务取消通道）；
rpi 的 dispatch 是**轮内工具调用**，引擎 per-call 取消链（run abort →
rpi-extensions `tool.rs` 调 `(cancel_fn)` → 插件 kit cancel → Control → 杀
进程组 + 未启动节点回 pending）经 **pi_interrupt** 可达——Stop 按钮
（WorkflowRunRow，悬停显形盖在时长上的幽灵钮，上游 WorkflowRunStopButton
逐类抄）wire 到 pi_interrupt。**无 orchestrator 命令面 PR**：会话级
`/orchestrator stop` 需要命令信封带 host context（TUI/RPC/宿主三处调用点
各自拼信封，引擎无统一注入点）——待引擎同步 0.26 后评估。

### 3. composer 徽标（上游 ConversationBackgroundWorkTrigger 完整移植）

`conversation-background-work-trigger.tsx`（typed 三类计数 + <480px 紧凑
Activity 总数；Bot 图标替代上游 SubagentCollectionIcon——宿主无该资源）+
`composer-status-badge.tsx` 接线（计数 = 面板同一份真值：jobs-store running /
`deriveWorkflowRuns.running` / 引擎名册优先的 runningAgents）；点击落点照上游：
唯一在跑的工作流直达详情页，否则 `requestExpandSections` +
`setOverride('panel')`。**面板侧配套**：工作流分区改受控（hasLiveWorkflowRun
翻转写入——2026-11-18 的坑是"受控且无翻转写入"，不是受控本身）；
`expandRequest` 进 status-panel-store（nonce 一次消费）。徽标挂 composer-wired
工具行左组（模式芯片右侧）。

### 4. 门禁与实机

tsc 1319（非镜像区 0）/ vitest **1093** / cargo **726**；实机：终端分区
渲染/展开/停止全链 ✓（旧 DLL 下），新 DLL 守卫探针 ✓；徽标与工作流 Stop
的实机渲染待一个真实 workflow/后台作业会话（接线已 tsc 闭环；Stop 的
pi_interrupt 与 composer 停止钮同 IPC）。

### 5. 顺带实锤加固：武装回执核验（假目标同类问题第二例）

实机发现一个 archived 假目标 `_verify-enable on`（某次会话装的是无
`_verify-enable` 动词的 goal 插件 → `/goal` 的速记 start 兜底把武装命令
吃成了目标）。与"CPU 温度降到 20 度"残留目标同类——**宿主向插件发的隐藏
动词被速记兜底吞掉会造出真目标并烧轮次**。修法 = `arm_goal_verification`
核验回执：含「Goal started」= 假目标已造出，立刻 `/goal stop` 归档止损 +
红印日志；回执不含 `verification`/`_verify` 字样也红印（插件不支持校验）。
v2 fork 的成功回执 =「🔒 Completion verification armed」两种核验都过。



## bots 实点对账（2026-11-20，hermes Desktop 逐键 vs mirach）

用户："打开d盘的hermes实际点击一遍bots有关的所有按钮，再点击一遍mirach的，
找问题，缺口"。方法 = CDP 真鼠标（hermes 9222 `D:\hermes-agent-main\apps\desktop`
+ mirach 9223），两侧逐面点、逐面对话框/菜单/尺寸取证。镜像源 =
`src/hermes-mirror/plugins/hermes-bots/**`（真正在屏的 bot 面；旧
`components/panes/bots-pane.tsx` 只是 PluginPane 未注册时的 fallback）。

### 逐面核对结果（一致项，不再复述实现）

行/群行左键打开、行右键 12+1 项菜单（含上游英文缺口 "Open recent session"）、
筛选菜单（kind 3 项 + activity 4 项；单连接无 gateway 组）、+ 菜单三项、
新建机器人（头像页签/名称/显示名/描述/高级 → [常规|能力]，能力页含
技能/插件/连接器/工具集）、编辑机器人（382x687，高级全屏面板）、管理群组
对话框（仅"创建并加入"输入，两侧同）、群聊设置（用途/共享笔记/路由下拉/
deliver 目标）、群行右键（打开群聊/解散——mirach 修复后与 hermes 同）、
群房间头（返回/群组详情/重命名/解散 + 详情抽屉成员行）、隐藏/取消隐藏、
置顶/取消置顶、复制、删除确认、屏幕窗格（本机无 bot 屏：与 hermes 同一空态）、
例程/电台
窗格 —— 全部实点通过。上游英文硬串（删除对话框 "This will permanently
delete…"、Open recent session）逐字保留（照抄规矩，不是 bug）。

### 本轮修掉的真 bug（3 个，都有实机证据）

1. **分组行右键被全局窗口菜单抢走**（`canonical-group-row.tsx` /
   `bot-row.tsx` 的传统 GroupRow 均无登记标记；`context-menu-scope.ts` 的
   owner 选择器只认 `data-roster-key`，且旧 `[data-slot="bots-pane"]` 前缀
   对镜像面不存在）。修 = 两处行根加 `data-bots-menu-row=""` + 选择器登记
   `[data-bots-menu-row]`（删掉死掉的旧选择器）；单测补一条。实机：右键群行
   = 打开群聊/解散（与 hermes 一致），不再弹「新建会话/设置…」。
2. **机器人空聊天显示「Mirach / Say something to get started.」**（hermes
   显示「HERMES / 说点什么开始吧。」）。两个成因：
   - `src/sdk/wordmark.tsx` 的宿主 shim **吞掉 `text` prop**（恒渲染品牌名）；
     上游 `components/chat/wordmark.tsx` 必需 `text`，BotChatEmpty 传机器人名。
     修 = 接受 `text/fitMin/width`，有 text 渲染 text。
   - `thread.aui.tsx` 的 `chat.empty` 贡献槽**没挂 I18nProvider**（dockview
     各 PluginPane 都挂了）→ `usePluginI18n` locale 恒 'en'，中文文案变英文。
     修 = ChatEmptyEntry 包 `I18nProvider initialLocale={readLocale()}`。
   实机：空聊天现在显示「二万人 (copy) / 说点什么开始吧。」。
3. （连带实测确认，非代码改动）"与此机器人开新聊天" 能真建新会话（pi_get_state
   新 sessionId）、"复制"出的 bot 点开是真空态（此前一轮疑似失败是探针时序）。

### 缺口补齐（2026-11-21，用户："能不能改成打开一个新栏"）

**「在新标签页中打开机器人聊天」→ 主区右侧分出的独立会话栏**（宿主主区是
单 workspace 面板，不强行做页签模型；"新栏"= 等价承载）。实现：

- `host.openSession`（src/sdk/host.ts）读 `options.intent`：`'tab'` →
  `openSessionColumnBridge`（会话 bridge 的新门）；默认 intent 先
  `focusSessionColumnBridge`（已在栏里就置前——hermes 的「已在屏就 front」，
  行点击不再抢主工作区），未开才走原主会话切换。
- `session-tab-bridge.ts`：新增 `setSessionColumnOpener(fn, focus)` /
  `openSessionColumnBridge` / `focusSessionColumnBridge`（未注册 = 错误
  可见；focus 未登记 = false，调用方继续主会话切换）。
- `dockview-shell.tsx`：注册实现——面板 id `session-<storedId>`，已开置前；
  该会话就是主会话 → 置前 workspace（不重复开，防双写）；否则 `addPanel`
  到 `workspace` 右侧（**新栏**），组件 = 既有 `session`（SessionThreadPane；
  引擎侧 agui 非 main 线程 → `side_open` 独立柄，与主柄并行流式）。
- `session-thread-pane.tsx`：非目录会话（隐藏 bot 会话不在侧栏目录）按 id
  从 `pi_list_sessions` → `pi_sessions_index` 补路径；`session-runtime.ts`
  的 `useThreadChatRuntime` 返回 `{ runtime, error }`，分栏内直接渲染
  `ErrorState`（主 runtime 的错误条走全局桥，分栏没有桥——失败不能静默，
  规矩 12）。

实机（CDP）：右键 微软 → 「在新标签页中打开机器人聊天」→ 主区右侧多出
「Bot Chat」栏（面板 `session-01a1e3ec-…`，workspace 不动）；再点行 →
置前该栏、主会话不切；重启后布局档案恢复该栏；栏内发送 → `side_prompt`
真跑（`pi_lane_busy(thread)` 忙→闲、会话文件真追加）。单测
`session-tab-bridge.test.ts` 5 条锁登记/派发/复位。

**屏幕对齐（同日第二轮，用户："hermes 本机的屏幕是没法打开的"）**：
hermes 本机（Windows 网关）没有 bot desktop，`打开屏幕` 打开的是空态页
「此主机没有机器人屏幕 / 此机器人使用主机自身的显示器」；宿主此前用
GDI 截自己的 Windows 桌面冒充 bot 屏（AGENTS 旧行称"宿主子系统"），
语义不对。现 `pi_display.rs::host_screen_enabled()` 默认 false（`support
ed/available/installed/ready/running` 全 false、geometry null），
mirach 与 hermes 本机一致显示空态；RFB 代码保留，`MIRACH_HOST_SCREEN=1`
才启用（仅显式自测）。实机：打开屏幕 → 同一句空态文案，无 noVNC 连接。

**环境备注**：验证期间 BBT 测试 key 失效（直连 relay `/chat/completions`
401 `Invalid token`），侧栏 run 在引擎里以空 `RUN_FINISHED` 收尾（provider
失败不进 RUN_ERROR，错误只落会话文件 stopReason:error）——与"新栏"改动无关；
key 恢复后回复即照常。

### 留下的缺口（如实，未修）

| 缺口 | 事实 |
|---|---|
| "Open recent session" 恒灰 | `src/sdk/host-rpc.ts::botToRosterRow` 把 `last_session` **写死 null**；连带花名册行年龄永远显示 createdAt（hermes 是"刚刚"式最后活动）、活动铃（`trackInboundActivity`）永不触发。要真做需要 profile→session 归属数据面（pi 会话索引没有 profile 字段），独立一轮 |
| 连接器页「无法访问托管应用。…重试」 | 上游 Connectors 页在宿主没有云后端时如实报错（`zh_connectors_page.ts` 文案；本机 MCP 管理在设置页「连接器」）——已知、不改 |
| 技能 0 / 工具集 17 vs hermes 38/23 | 数据面差异：`~/.pi/skills` 本机为空；工具集来自 pi_capabilities 的 17 组（hermes 有自己的 23）。同一 UI 同一行为，数字随环境 |
| 活动筛选无数据 | activity 三档筛选器真实接线，但 roster 无 `last_active`（同 last_session 缺口），选了只会空列表 |

### 探针与清理

CDP 辅助 = `E:\Temp\cdp.mjs`（shot/eval/click/type/key）、`mirach-menu-click.mjs`
（单连接：右键行 → 点指定菜单项）、`mirach-click-row.mjs`。测试产物（临时分区、
复制 bot、群聊用途、新建 bot）全部已清理；群聊用途已清空回 ""。

## 内存复查（2026-11-21）：弹层 rAF 轮询泄漏 + 设置窗预热撤回

**症状**：主渲染器 JS 堆长跑翻倍（~2h 122MB→244MB 且持续涨，进程 WS 462MB），
设置窗（隐藏）常驻一个完整渲染进程。用户口径：主渲染器应在 200MB 内、壳 10MB 内。

### ① 弹层位置轮询 = 无界 React 更新队列（真 bug，已修）

`src/components/motion/popover-position.ts`：`usePopoverPortalPosition` 的 rAF
每 3 帧调 `setLayout(current => sameLayout(current,next) ? current : next)`；
`popover.tsx` 给 hook 传的 `active` 是 `portalReady`（挂载后恒 true）→ 8 个常驻
PopoverContent（tab 总览 ×4、模型选择器、上下文明细、维护条……）关闭后仍 20Hz 派发。

React 对"派发同值 state"走 **eager bail-out**：不调度渲染，但 Update 对象照样挂进
`queue.pending`——fiber 没理由再渲染，队列只增不减。实测（CDP 遍历 `__reactFiber$`
数 `queue.pending` 环长）：单队列 15s 84,856→85,157（20/s × 8 实例 ≈160/s）；每条
连带 action 闭包 + scope + trigger/content 两个几何对象 ≈160B → **~77MB/小时**。
堆快照对比（旧 2h vs 新冷启）：`{trigger,content}` 822k → 178k、React Update
826k → 179k。

修法（**不要改回去**）：
1. hook 内用 `layoutRef` 记最近已派发几何，`sameLayout` 命中时 **dispatch 前 return**
   （在 updater 里 `return current` 没用，React 仍会 enqueue）；
2. `popover.tsx` 的 `active` 改传 `open`，关闭即停轮询（打开瞬间 useLayoutEffect
   仍同步测一次，无闪位）。
实测修后：UI 静止 maxPending=12，堆 60s 157.8→148.4MB 持续回落。

### ② 设置窗开机预热已撤（内存优先）

2026-11-20 的 `prewarm_settings_window` 在启动后 1.5s 构建隐藏设置窗（首次点开
1178ms→21ms），代价是**常驻一个完整渲染进程**（实测设置页私有内存 ~100MB、
WS 136MB）。现改为：首次打开现场构建、关闭仍 `hide()` 保实例（后续仍瞬开）。
`pi_close_settings_window` 语义不变。

### ③ 窗口身份判定双源（防主窗应用跑两份）

实测 settings 窗口 URL 掉成 `/`（`Page.getNavigationHistory` 两条：
`/index.html?win=settings` → `/`）。`main.tsx` 原先只按 `?win=` 判定 → 设置窗渲染
整棵主窗应用（会话列表 + composer + 全部 store/轮询），等于主应用跑两份（实测该
渲染进程 426MB WS）。现判定 = URL `?win=` **或** Tauri
`getCurrentWindow().label === "settings"`。

### 当前开销大头（debug 构建实测，2026-11-21 早）

- 主渲染器：JS 堆 ~150-175MB（V8 快照 self ~225MB）
  - `ExternalStringData` 77MB（脚本源码等外部字符串——dev 未压缩模块图是放大项，
    release 会显著下降）；
  - V8 code 28MB + string 27MB + object 19MB + array 13MB；
  - FiberNode 仅 ~4.6MB（React 树不是大头）。
- Chromium browser ~127MB、GPU ~90MB、utilities ~70MB（WebView2 进程基线；多一个
  webview 就多一份）。
- Rust 宿主：priv ~33MB 起、随会话增（每份在场 harness ≈8MB）/ WS 80–130MB 波动。
  **不是空壳能到的量级**（二进制链着整个 pi 引擎 + fsqlite + TLS）。
- **retired 会话表已加上限（2026-11-21，同轮）**：`RetiredSessions`（`HashMap` +
  进入顺序 `VecDeque`，`RETIRED_HARNESS_CAP = 4`）——超出上限按进入顺序淘汰
  最老的一份，淘汰时**先 `harness.session().storage().release_writer_lease()`
  显式放租约再 drop**（drop 本身不释放，会悬空成 "writer lease is already
  held"）。被淘汰会话再次打开走正常重建（lease 已放）。取用口同轮
  `.remove()` → `.take()`。实测：连开 6 个不同会话宿主 priv +51MB（首次装载），
  **再开 5 个只 +1.1MB**（淘汰生效、内存平台化）；被淘汰的会话重新打开正常，
  无 lease 报错（E2E 15s 节奏点侧栏行）。
- 渲染器跨会话切换平坦：reload 后连开 6 个会话、每次强制 GC，堆 120.8 → 120–127MB
  无累积；**之前读到的 254MB 是 HMR 中途态的假象**（dev 限制，reload 即回落）。

### WebGPU 结论：不引入

全仓 `canvas` 数量为 0（实测 DOM），UI 是 DOM+CSS+SVG；goo 的 feGaussianBlur 是 SVG
滤镜且已被 `--beui-popover-goo` 令牌默认关闭。内存问题在 JS 堆与多余渲染进程，
WebGPU 帮不上，反而增加 GPU 设备/管线常驻（+10~40MB）与 WebView2/D3D12 驱动兼容
风险。重开条件：本地模型推理（WebLLM/onnxruntime-web）、波形/频谱等 >60fps 自绘、
视频处理；即便如此先评估 WebGL2。

### 侧车（Node.js）结论：不带

Tauri bundle 仅 NSIS，`resources: ["skills-catalog"]`（技能 markdown，~11MB 文件，
按需 `pi_skills_search` 读，不常驻）。Rust 侧 `Command::new` 只有 `git` / `gh` /
`cmd`（Windows）+ `ssh` 与凭据页 bw/op 探测——**无 node、无 sidecar 进程**。开发时
看到的 node.exe 全是 `npx tauri dev` 工具链（npm → tauri-cli → vite）。

### 测量方法（复现）
- 进程：`Get-Process mirach-harness,msedgewebview2` 按 `WorkingSet64` /
  `PrivateMemorySize64` 取数，用 CommandLine `--type=` 分类。
- 渲染堆：CDP 9223 `HeapProfiler.takeHeapSnapshot` 落盘 + 流式聚合（类型 / 构造名 /
  字符串前缀 / 保留链）。坑：`.heapsnapshot` 的 `edges[].to_node` 是**字节偏移**
  （÷6 才是节点下标）；>512MB 不能用 `JSON.parse`（V8 字符串上限），必须流式扫。
- 滞留队列：页面内遍历 `Object.keys(el).filter(k => k.startsWith('__reactFiber$'))`，
  沿 `memoizedState / next` 数 `queue.pending` 环长（修好后静止应 <50）。

## 侧栏按钮打通审计 + 配置档案筛选（2026-11-21 续）

用户："会话列表按钮都打通了吗？有的是灰色，有的点击没反应……会话分组选项
里面的配置，好多按钮都是灰的"。

**根因（三个点/分组菜单"点不了"，2026-11-21 已修）**：`context-menu.tsx` 的
GooSurface 根是 `position:fixed` + 视口坐标，但 `ContextMenuContent` **没有
portal 到 body**，而是留在侧栏/滚动列表的 React 树里。带 layout containment
的祖先成为 fixed 的包含块 → 菜单按"祖先左上 + 视口坐标"偏移、且被列表
overflow 裁掉：DOM 里 `role=menu` 存在、UIA 也能看到焦点，屏幕上却什么都看
不见。修法 = 与 `popover.tsx:580` 同一条纪律
`return createPortal(<GooSurface …/>, document.body)`。实测修复后：会话行 ⋯
菜单、分组 ▸（项目/状态）、排序 ▸（更新时间/状态）、筛选 ▸ 状态（空闲桶）、
配置档案 ▸（全部/二万人）、收件箱样式、已归档、全部折叠逐项真鼠标点选均
可见且生效（26 行 → 配置档案过滤 1 行 → 复原）。

### ① 会话行按钮审计结论

- 行操作全接线（重命名 / 归档 / 置顶 / 复制 ID / 导出 HTML / 分叉 / 删除 /
  打开），真实 UI 点击逐项验过，无死钮。
- 「分支」项恒 disabled = 有意（pi 无分支重放面，只有 fork 点；保留项作提示）。
- 「配置档案栏」「拉取请求」disabled = 诚实面：前者视觉条未移植（见 ②），
  后者 pi 无 PR 概念。
- 「全部标记为已读」在 unreadCount=0 时置灰 = 条件态，不是故障。
- **复制 ID 真缺陷（已修）**：菜单关闭后 webview 失焦，
  `navigator.clipboard.writeText` 抛 `NotAllowedError: Document is not focused`。
  修法 = 写剪贴板前 `document.hasFocus()` 为假先 `window.focus()`。
- **例程面板移除崩溃（已修）**：dockview 的 `getPanel` 会返回已 disposed 的
  陈旧引用，`removePanel` 抛 "resource already disposed"；移除前先查
  `containerApi.panels` 成员资格。

### ② 配置档案 ▸（已被 2026-11-22 环境切换取代）

**旧实现已删除**：`sidebarViewStore.profileFilter` / `mirach.harness.sidebar.
profileFilter.v1` / 前端「只显示该 bot 锚定会话」的过滤全部退役——那是
「表面过滤」，用户明确要求改为 hermes 的 profile 环境隔离。

现行语义：侧栏选项「环境 ▸」= 显式切引擎活动环境（`active-profile-bridge`
→ `pi_profile_set_active` → 列表整体换源；默认 = Mirach/全局根）。bot 行
点击**只打开会话，不切环境**；新 bot 聊天把 profile 传给创建 IPC。详见
本文件开头「2026-11-22 环境（profile）与 bots 插件边界」。

### 验证纪律（本轮踩到）

CDP 探针里 `import('/src/.../sidebar-view.ts')` 读写 store 时，若页面经过
HMR/陈旧 boot，可能读到与应用不同的模块实例：探针读回 filter 正确、列表却
不动。**以真实 UI 路径（点菜单 radio）为准**；直接 store 探针仅作辅助，
两者不一致先重载页面再测。

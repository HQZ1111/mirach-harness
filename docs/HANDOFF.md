# mirach-harness 交接（新会话从这里接手）

> 本文只写**现在在哪、下一步做什么、环境怎么跑**。工程约束与踩坑见
> `AGENTS.md`（必读）；架构分层见 `docs/architecture.md`；布局语义见
> `docs/layout-design.md`；pi 集成规范见 `docs/pi-integration.md`。

## 当前状态

**✅ 2026-11-27（二十一）：启动连接页 + 单实例守卫 + 打包版白容器/图标/会话恢复修复（v0.1.1）**

- **启动连接页**：首次启动 / `?setup=1` / 设置「网关连接 → 启动与连接」
  打开 `StartupConnectionGate`：本机启动 + 远程连接管理（复用
  `ConnectionsRegistrySection`，真保存/真测试/设主要）。第一版范围 =
  只做启动页和连接管理；远程运行面（主窗口切远端引擎）还没接，页面上
  明说「下一阶段」，不放假按钮。
- **打包版闪退根因**：安装版和正在运行的 dev 版同时开 → 两个实例共用
  WebView2 user-data / 引擎会话锁，第二个在 webview 创建阶段 panic（exit
  101）。已在 `main()` 加 Windows 命名互斥量单实例守卫：第二次启动只
  置前已有窗口（找不到窗口则弹「已在运行」），不再闪退。另外 panic 现在
  写 `%LOCALAPPDATA%\com.mirach.harness\logs\crash.log`。
- **会话栏白容器**：`ThreadListRoot` 的 `bg-(--surface)` 在无背景图的
  打包版里叠出第二层白卡；改 `bg-transparent`（外层 `.dv-groupview`
  是唯一底色）。
- **打包版显示旧会话**：桌面版/安装版共用同一份 `~/.rpi/agent` 数据根
  （默认 `sessions/` + `profiles/<name>/sessions/`），不是按安装版本隔离；
  启动恢复 `lastSessionPath` 是 AppData 里的同一份偏好，所以会回到 dev
  上次看的会话。顺带修：`Router: <roomId>`（群聊自动路由的内部会话）
  不再出现在侧栏、也不会被记成 `lastSessionPath`（旧记录启动时自动清掉）。
- **图标**：`src-tauri/icons` 已用 `public/brand/logo.png --fit cover`
  重新生成（安装器/任务栏/exe 不再是默认占位图）；版本号升到 **0.1.1**。
- **任务栏/通知中心图标**：`SetCurrentProcessExplicitAppUserModelID
  ("com.mirach.harness")` 与 NSIS 快捷方式的 AUMID 对齐；`pi_notify` /
  `pi_notify_test` 也带同一 `app_id`，通知不再走无名 exe 的默认图标。
- **启动黑框**：宿主 `git` / `gh` / `tar` / `ssh` / `wsl` / `docker`
  子进程统一走 `win_proc::HideConsole`（CREATE_NO_WINDOW），GUI 启动/审查
  刷新不再闪控制台窗口。
- **本机安装验证**：v0.1.0 安装到 `G:\MirachHarnessTest` 可运行（无 Vite、
  clean `RPI_CODING_AGENT_DIR` 都试过）；v0.1.1 构建后按同样路径安装复验，
  通过后再发布（用户："安装到 G 盘，没问题了再发"）。
- **v0.1.1 已发布**：
  `https://github.com/HQZ1111/mirach-harness/releases/tag/v0.1.1`
  （安装器 84.50 MiB）。旧的 v0.1.0 Release（有闪退/默认图标）已从
  Releases 删除，tag 保留作源码历史。实机复验：启动页出现 → 本机启动后
  无白容器/机器人栏正常；二次启动 exit 0 且不闪退；exe/安装器/窗口图标
  均为 Mirach。
- **v0.1.2 补丁**：Tauri 原生只在 finish 页勾选 `createDesktop` 或
  silent/passive 时创建桌面快捷方式（用户"桌面怎么没有图标"）。新增
  `src-tauri/nsis/hooks.nsh` 的 `NSIS_HOOK_POSTINSTALL` 无条件
  `CreateOrUpdateDesktopShortcut`（幂等，保留 AUMID）；版本升 0.1.2。
  默认安装目录（currentUser）= `%LOCALAPPDATA%\Mirach Harness`；本机测试
  安装 = `G:\MirachHarnessTest`。实机：删掉旧快捷方式 → 静默安装 0.1.2
  → 桌面快捷方式重建并指向安装目录，双击可启动。
- **v0.1.3 边框补丁（最终口径）**：`decorations:false + shadow:true` 时 tao
  给窗口留了一圈 undecorated-shadow 非客户 inset（`SM_CXSIZEFRAME +
  SM_CXPADDEDBORDER`，150% DPI 实测 6-7px），DWM 把投影画在这圈里；用户
  看到的就是"左/右/下灰边"。试过并撤掉的两条路：①客户区铺满窗口矩形 →
  WebView2 子窗不跟着长，底部留大片未绘制黑带；②WM_NCPAINT 自绘填充 →
  投影被覆盖、边缘多黑线。最终：保留 tao inset 与 DWM 投影，只把
  `DWMWA_BORDER_COLOR` 从 `COLOR_NONE` 改为**外壳色 COLORREF
  `0x00EFEEE9`**（`BORDER_SHELL`），1px 描边融进壳色；`top_line` 仍只吃
  顶部 1px。**投影与灰边是同一条 inset 的两面：要完全无灰边只能
  `shadow:false`（同时失去投影），默认不做。**
- **v0.1.3 已发布**：
  `https://github.com/HQZ1111/mirach-harness/releases/tag/v0.1.3`
  （安装器 84.49 MiB）。实机复验：设置页连开连关（第二次 ✕ 可关）；
  边缘无黑线、系统投影保留、1px 边框融进壳色；启动/单实例/桌面快捷方式
  延续 0.1.2。
- **设置页第二次关闭失灵（v0.1.3 修）**：设置窗 `hide()` 不卸载 React 树，
  `useOverlayExit` 的 `closedRef` 第一次关闭后永久 true → 再开点 ✕ 直接
  return。`useOverlayExit` 增加 `reset()`；`SettingsOverlay` 在
  `variant === 'window'` 时监听 `focus` / `visibilitychange` 重新复位。
  实机：打开→关→再开→再关，第二次也能关（修复前第二次 title 仍为「设置」）。

**✅ 2026-11-26（二十）：群聊显示对齐主对话 + 群聊回复恢复 + 右键菜单 / 启动页 / 技能包**

- **群聊显示**（用户实报截图）：
  - 作者判定补 `local-user`：宿主 `pi_groups.rs` 的 `groups.send` actor 是
    `{kind:'user',id:'local-user'}`（hermes 桌面端是 `desktop`）。此前只认
    `desktop` → 自己的消息显示作者 `local-user`、回复条「正在回复 local-user」；
    现在作者 = **你**，且名字/时间靠气泡右缘。
  - **自己的消息不再给回复入口**（`canReply` 排除 own）；回复条经
    `RoomComposer.aboveSurface` 移到**输入卡外面**（轮次状态同层），
    用户："正在回复 ... 怎么不在输入框上面，跑输入框里面了"。
  - 头像统一 **40px**（`ROOM_AVATAR_SIZE` / `w-[40px]` / `h-[40px]`；Tailwind
    `size-10` 在 15px 根字号下只有 37.5px，已改绝对 px），AI 左/用户右、
    头像在外侧、名字行中线与头像中线对齐；用户气泡 24px 圆角 + 同款留白。
  - `RoomHeader` 标题行改为全栏宽、左内距 `--rail-gutter`、`pt-6`（22.5px）
    → 标题中心 47.5px，与其它栏 75px 标签条里的标签中心对齐；成员 chips
    仍在 `max-w-3xl` 内容列。
  - 群聊 bot 头像以宿主 `botsStore`（`botPhotoImage`）优先——自定义上传图
    在群聊/消息行/机器人页一致。
- **群聊回复恢复（真根因）**：`BotLane` 的成员会话在**创建时**解析 provider
  凭据；改 `profiles/<name>/models.json` 不会热更新已存在的 live 会话。
  风格和 home 的 key 是旧的 → 一直 401 invalid token；进程重启后同一房间两条
  回复都正常（实测：风格和 / 二万人各回一句）。**换 key 后必须重启宿主**。
- **右键**：选中文字 / 输入框右键 = DOM 编辑菜单（复制/剪切/粘贴/全选），
  选中文字不再触发会话行拖拽；其余区域仍是宿主壳菜单。
- **启动页**：ParticleText 画完（`onComplete`，2.6s 兜底）才做品牌接力，
  用户："启动页文字显示完再移动到左上角进入主页"。
- **对话工作区名**用主题色（`--chat-tab-workspace-color: var(--brand)`）。
- **技能**：已把 `addyosmani/agent-skills` 的 26 个技能装进
  `~/.rpi/agent/skills`（本机资产，不在仓库）。
- **启动恢复空会话报错 / 「正在准备会话」卡死**（用户 2026-11-26 实报）：
  `lastSessionPath` 指向已被清理的 0 消息草稿时，启动 `pi_open_session` 失败，
  旧代码只 console、且 `setEngineAttaching(false)` 不在 finally 里 → 红条
  + 提示永久停留。现在：恢复失败写 `errorBridge`（「恢复上次会话失败：…」）
  可见；`finally` 必撤提示；文件不存在（os error 2）时清空
  `lastSessionPath`，不再每次启动重复报同一错。lastSessionPath 与目录 path
  的相等判定改成 Windows 路径键（`/`↔`\`、大小写、`\\?\`），空会话清理
  时能真正清掉记录。
- 门禁：vitest **1135 / 97 文件**；touched 文件 tsc 无新增错误。
- **仓库/发布（2026-11-26）**：分支收拢为 **只有 `main`**（本地与 origin 的
  `bots-plugin-complete`、`sync/local-main-2026-11-15` 已删）；origin 改为
  SSH（HTTPS push 被 reset，SSH 可用）。打包命令 =
  `npx tauri build --config src-tauri/tauri.prod.conf.json --config <override>`
  （override 只把 beforeBuildCommand 换成 `npx vite build`，绕过 tsc 镜像基线）；
  产物 84.38 MiB，Release `v0.1.0`：
  `https://github.com/HQZ1111/mirach-harness/releases/tag/v0.1.0`。

**✅ 2026-11-26（十九）：bots 关闭回落默认 + 活动面板开关 + 插件工作区无标签 + 收音机开关**

- **bots 关 → 默认 Mirach**：runtime 在 true→false 边沿（含 boot 已关的首次
  profile 载入）调用 `switchProfile(null)`，只回落一次；之后环境菜单显式
  切具名档案不再被强行拉回。实机：二万人 → 关 bots → 再开 = Mirach。
- **对话区活动面板开关**：列头 actions 顺序 = 活动面板 → 语音 → 聊天记录；
  点击写 `hidden`（整块消失，不是 mini 胶囊），再点写 `panel`；按钮常驻。
- **bot 新聊天 = hermes 草稿**：插件 `host.newChat`（带 workspaceOwnerKey）
  只跟随 profile + 回 New Chat 草稿，记 `pending-bot-chat`；首条消息由
  `ensureDraftSession` → `createBotDraftSession` 用 bot SOUL/模型/工具集 +
  选中工作区建会话。机器人页新聊天现在和底栏一样有文件夹选择器；配置栏
  「在新分栏打开」仍是立即建会话列。
- **群聊 / 屏幕无标签**：chat 组仅有 `plugin-workspace` extras 时隐藏标签条；
  群聊用 RoomHeader 返回，屏幕由 `PluginWorkspacePane` 渲染宿主「返回」浮层
  （`plugin-workspace-back`）。实机 dummy screen workspace 验证通过。
- **收音机开关**：`hermes-radio` 决策（默认开，`radio-gate`）；关闭移除已开
  电台面板并过滤打开页/标签条入口。原生扩展 DLL 仍无 per-extension 开关。
- 门禁：tsc 1310（无新增）；vitest 1134 / 97。

**✅ 2026-11-26（十八）：Bots 插件关闭 = 机器人面整个关（机器人页 + 配置档案栏）**

- 用户："bots关了之后是整个关吗，机器人页和配置档案栏一起消失。" 现在：
  - `DockviewShell` 订阅 `useBotsFeatureDesired()`，false 时直接摘 `bots` /
    `routines` 面板（不依赖 bundled 插件 handle，boot 与 live 切换都干净）；
  - 底部 `ProfileSwitcher` 同门隐藏，只留设置齿轮（侧栏「环境」菜单仍是
    核心 profile 切换兜底，不会把用户锁在具名环境里）。
- 实机（CDP 真实点击插件开关）：off → panels 只剩 leftrail/review/workspace、
  profile trigger 消失、Mirach 文字变 SPAN；on → trigger/Mirach 按钮恢复，
  机器人栏从 Mirach 重新打开（不自动复活）。

**✅ 2026-11-26（十七）：「技能与工具」主区页 = 纯本地清单（技能 / 工具 / 插件分明）**

- `CapabilitiesPane` 不再渲染 hermes `CapabilitiesView` 四页签；改为
  `LocalCapabilitiesPane`：顶部保留 hermes `TextTab` 同形的三页签
  「技能 / 工具 / 插件」（带计数，默认技能；**无标题**，页签条
  `pt-[21px]` 对齐其它栏标签中心 47.5px），每个页签只显示自己的本地清单：
  技能（本机已装，名称/描述/来源/路径/Switch）+
  **工具**（17 组 / 36 个，逐个列出 read/write/bash… + 组开关）+
  **插件**（Bots 内置插件真开关、收音机打开窗格、原生扩展 DLL 目录清单）+
  诊断。页面根不再叠 `--surface`（审查页同步去掉 sidebar 底色）。
- **开关已接引擎**：工具集 `disabledToolsets` → `Args.exclude_tools`；
  技能 `disabledSkills` → 引擎新增 `Args.exclude_skills`（本地补丁
  `rpi-cli/src/{args,session}.rs`）。**新会话/重开的会话生效**，旧会话不
  热改；Bots 插件开关即时。
- 无 Scope selector、Skills Hub/Optional、连接器、安装更新按钮；
  `ensureCapabilitiesWiring` 保留给机器人编辑高级页与 cron。
- **具名环境补种**：`seed_profile_home_config` 现在也 copy-if-missing 克隆
  `skills/`、`extensions/`、`native-packages.json`；`pi_capabilities` /
  `pi_extensions` 读前 ensure。风格和实测从 0/0 → 1 技能 / 27 扩展。
- 门禁：vitest 1134 / 97；tsc 1310；cargo test 744 过 / 1 ignored；
  引擎 `exclude_skills_filters_by_name` 1 过。

**✅ 2026-11-26（十六）：档案栏改底部「头像+名字 → 弹窗垂直切换」（横向横条删、原底栏组件删）**

- 横向 `ProfileRail` 不再挂载；左栏底部 = `ProfileSwitcher`（当前环境头像+
  名字+齿轮），点击弹出**垂直**档案列表：每行头像+显示名+状态点，活动勾选，
  可垂直拖拽重排；底部「全部配置档案 / 管理配置档案 / 新建 / 导入」；
  行悬停「在新分栏打开」= `host.newChat(workspaceMode:'bots')`（多栏对偶，
  用户纠正主窗单实例但支持分栏）。底栏名字显式左对齐贴头像右边
  （button UA 居中会把名字推到行中间），并去掉整行焦点框；触发区收窄为
  头像+名字（无向上箭头，底栏空白/齿轮不弹窗）。
- **头像 = 用户选图优先**：`imageKind` 直映射进 BotPreset；`photo/pet`
  即使 160×160 也用原图（此前被当回填脸，橙色头像显示成绿色数学脸）；
  宿主/插件渲染面统一 `botPhotoImage` / `isChosenAvatarImage`。
- `rail-user-zone.tsx` 已删除；`$profileRailVisible` 偏好与菜单项退休；
  颜色改到「管理配置档案」页详情（12 色+自动）。
- 实机：弹窗三行头像正常（二万人橙色原图）、切换同步底栏、拖拽写 order、
  全部档案开关、管理页入口、分栏打开新会话均通。门禁 vitest 1134 / 97；
  tsc 1310。

**✅ 2026-11-26（十五）：「管理配置档案」= 真管理页（列表 / 详情 / SOUL / 重命名 / 删除）**

- 旧入口只 `openBotsPanel()`（机器人花名册，且面板已开时点击无变化）——
  现已换成主区单例面板 `profiles`（`openProfilesPanel`，标签「配置档案」）。
- 页面 = hermes `app/profiles/index.tsx` 移植：左列表（搜索/首字色块/
  行菜单/新建/导入）+ 右详情（显示名、id、home 路径、模型、技能数、
  内联 SOUL.md 编辑器）；默认档案重命名 = 显示名称、不可删；具名档案
  真改目录/可删（活动先切走）。新增 `pi_profile_info` IPC。
- 表单与 rail 共用 `profile-dialogs.tsx`。实机：tab 打开、三行列表、
  微软详情 path/skills/SOUL、重命名/命名/删除确认全部正确。
- 门禁：vitest 1135 / 97；tsc 1310；cargo test 741 过 / 1 ignored。

**✅ 2026-11-26（十四）：引擎 0.29.0（main@6d69712）+ 档案栏终态（重命名/SOUL/导出导入/状态点）**

- **引擎**：upstream main@6d69712（0.29.0，含 #414 AgentHome 即时校验 /
  #411 消息级 fork / #424 mini mode）。本地 15 文件补丁 `--3way` 全清；
  宿主零代码改动即编译过；实机 `pi_engine_version` = 0.29.0。
- **档案栏补全**：状态点（未读 + 运行中 `$hostBusy` + 待输入
  `approvalBridge`）、身份重命名（`pi_profile_rename`，实机 e2e
  rail/botsStore/磁盘三同步）、编辑 SOUL.md（bot.systemPrompt）、导出/导入
  配置档案（tar.gz，安全清单校验 + 单层目录包），rail 加导入按钮。
- **仍未移植**：每档案远端覆盖 / 多网关 fleet——宿主只有 local 连接且无
  添加远程连接入口，hermes 单连接下也不渲染，无数据面不写假 UI。
- 门禁：vitest 1135 / 97；tsc 1310；宿主 cargo test 741 过 / 1 ignored；
  引擎 lib 1276 过 / 3 ignored；agent_dir_home 5/5。

**✅ 2026-11-26（十三）：配置档案栏按 hermes 真源重做（首字色块 / 拖拽 / 调色 / 直达机器人页）**

- 真源 = hermes `profile-switcher.tsx` 单网关路径。旧宿主版是自造头像栏，
  现已换成：**首字 + 档案色方块**（`lib/profile-color.ts` /
  `profile-short-label.ts` 逐字移植：名字哈希 hsl、默认中性、override
  优先、12 色板）、**home/layers 单药丸**、横滚条（滚轮/渐隐遮罩/
  dnd-kit 拖拽重排 + `profileRailOrder.v1`）、长按 450ms / 右键调色
  （`profileRailColors.v1`）、「+」/省略号 → 插件新建/编辑/删除对话框
  （`plugins/bots-request-bridge.ts` + `openBotsPanel`）、>13 折叠下拉、
  未读状态点（按 profile 聚合）。
- **不移植（宿主无数据面）**：档案导入/导出、远端覆盖、多网关 fleet
  分组、档案身份重命名（没有 `pi_profile_rename`；右键编辑的是显示名/
  外观/人格）。方块右键不再叠全局菜单（context-menu-scope 登记 owned）。
- 实机：切环境三同步、右键/长按/选色/拖拽/「+」「编辑」「删除」全部走通；
  门禁 vitest **1135 / 97 文件**；tsc **1310**。

**✅ 2026-11-26（十二）：空会话不落盘 / 重名 / 分叉 / 档案栏 / 审查页**

- **空会话不落盘三层**：选工作区文件夹只进草稿态（首条消息
  `ensureDraftSession` 才 `pi_new_session`）；离开 0 消息会话
  `pruneEmptyCurrentSession`（discard + delete + 清锚/登记/恢复位）；
  启动 `sweepEmptyBotChats` 清 0 消息 `Bot Chat`（实机造会话验证：
  reload 后文件消失 + 日志「已清理 1 条」）。`pi_delete_session` 连
  `.lock` / `.progress.jsonl` 伴生文件一起清。有名字的旧 0 消息会话
  （API session 等 8 条）有意不删。
- **重名**：hermes core 是 UNIQUE(title) per profile，两个同名会话不允许；
  宿主 `onRename` 查 `pi_list_sessions`，同环境重名红条拒绝。
- **分叉显示**：`flattenBranchOrder` DFS 嵌套 + `├─`/`└─` 分支干，子行
  紧跟父行（created/updated 都保持），根组按子树最新活动排序。
- **ProfileRail**：首版是自造头像栏；已由（十三）按 hermes 真源重做成
  首字色块栏，**现行口径见（十三）**。切换环境同步机器人页 roster 选中保留。
- **灰项**：删 PR 过滤子菜单/行 PR 项；仅「全部标记为已读」条件灰。
- **审查页**：改绑 `workspaceRootStore`（与文件树同根），实测
  `G:/mirach-harness` / 1175 文件。
- 门禁：vitest **1134 / 97 文件**；tsc 1312（0 新错）；cargo check 0 错误。

**✅ 2026-11-26（十一）：机器人行点击不再重复 mint 会话**

- hermes 语义：首次点 bot 行建该 bot 的隐藏永久 Bot Chat，之后复用；
  不是每次点击都建。
- **default（Mirach）从不记双锚** → 每次点击都 mint 新的
  （39→40→40 实测修后）。修 = `host-rpc` session.create 拆 `anchorBot`
  （default 也记 `chatSessionId/Path`），预设仍只对具名环境生效。
- **显示名降级把管道会话漏进侧栏**：Bot Chat 过滤改看 **pi 真名**
  （`sessionRawTitle`），不再看被降级成 `New Chat` 的显示标题——侧栏不再
  出现"点一下 bot 多一条 New Chat"。
- 门禁：vitest **1132 / 97 文件**；tsc 1312（0 新错）。

**✅ 2026-11-25（十）：新建任务开场统一（粒子 + 输入框居中 + 选文件夹不消失）**

- **空对话开场 = 宿主统一自绘**（不再挂 `chat.empty` 贡献）：bot 会话 →
  机器人脸 + **机器人名 ParticleText** +「说点什么开始吧。」；本体/普通会话
  → MIRACH 粒子 +「有什么可以帮你的？」。状态门 = `messages.length === 0`
  ——**选工作区文件夹会建会话，但 0 消息仍显示开场**，首条消息才换掉。
- **新任务布局**：空对话时开场标识与输入框作为一组垂直居中（ZCode
  `centerEmptyStateWithDock` 对偶：root justify-center + viewport
  flex-none）；有消息恢复贴底。
- hermes 的 `chat-empty.tsx` 保持原文（静态 Wordmark），宿主不再挂该贡献
  是有意为之：用户要求其他配置也有粒子效果。
- 实机：本体 MIRACH 粒子 + 输入居中；微软 = 橙脸 +「二万人」粒子；选最近
  工作区后开场仍在；重载后仍在。门禁 vitest 1131 / tsc 1312（0 新错）。

**✅ 2026-11-25（九）：侧栏二级项可点 / 环境跟随（三面统一）/ 头像 / 会话名**

- **侧栏二级菜单全部点不中（真根因）**：子菜单是兄弟 portal，父菜单的
  window-capture pointerdown 外部点击判定看不见它 → 父菜单在按下当帧卸载
  整棵树，click 到不了二级项。修法 = portal 写 `data-menu-ancestors` +
  `menuPortalDescendsFrom` 判后代内部 + 选中项 `closeRoot()` 关整棵树。
  真鼠标实测：分组→项目、排序→创建时间均生效并持久化。
  **合成 `el.click()` 测不出这个 bug，验证必须用真实鼠标事件。**
- **三处身份统一**（用户："底栏头像、会话选项的环境、机器人页的选中，
  三个不统一"）：底栏 = 活动环境 bot；`followProfileBridge`（轻量，不拆
  会话）由 `switchToThreadPath`（非聚合视图）/ `host.focusProfile`
  （bot 行点击，mirror roster-actions 调用）/ `host.newChat`（本地 bot）
  触发。点「二万人」→ activeProfile=微软 + 侧栏换源 + 底栏 二万人，实测三处
  同步。聚合视图（全部配置档案）下点侧栏行不跟随。
- **左栏头像失效**：botsStore 停在插件推来的 160×160 人脸回填，插件 meta
  已是 256 照片 → `botsStore.load()` 用插件 meta 的非回填图修复。实机
  风格和底栏从蓝六边形变上传照片。
- **会话名 = bot 名**：`sessionDisplayName` 降级 `Bot Chat` / 档案名污染
  （旧 session.create 回落 bot.name）为派生标题/New Chat；页签不再回落
  bot 显示名；`refreshThreads` 删除写 bot 名的覆写。
- **折叠/展开**：维持单一默认过渡（160ms 淡入 / 120ms 淡出后提交），收起
  补 translateY(-2px)；不加逐行步进。
- **composer.top 贡献补 QueryClientProvider**（顺带修）：teammate-waits 用
  TanStack useQuery，此前每次渲染报 `No QueryClient set` 并被隐藏；
  `ComposerTopSlot` 现在自包 Provider。
- 门禁：vitest **1131 / 97 文件**；tsc 1312（既有镜像基线，touched 0 新错）。

**✅ 2026-11-25（八）：对照 hermes 真源（D:\hermes-agent-main）修档案作用域 / 过渡 / 头像 / 开场宽 / 子菜单**

- **档案作用域校正**：hermes `$showAllProfiles` **默认 false**（opt-in 聚合），
  `selectProfile` 切档案即复位并换源。宿主：`sidebar-view` 新增同名开关
  （默认 false，`mirach.harness.sidebar.showAllProfiles.v1`）；侧栏行投影与
  ack 面按 `(profile ?? null) === activeProfile` 过滤；Filters 菜单加
  「全部配置档案」复选框；聚合行带 bot 头像角标；runtime 切环境成功后
  自动关聚合。
- **过渡**：单档 160ms 淡入 / 120ms 淡出（deferred-collapse 恢复 120ms
  延迟提交，无逐行步进）；虚拟化分支也挂类（用户列表 ≥25 行恒虚拟化）。
- **头像**：160×160 人脸回填 PNG ≠ 用户自定义——`profiles.set_asset` 不再
  把它写成 custom、不覆盖真照片；左栏底栏改与机器人页同判定（真照片 img /
  否则实时 BotFace）。
- **开场标识**：`.aui-intro-particle` inline-size 容器 + `min(25cqw,18rem)`
  字号；词宽 590/674 ≈ 88%（原 69%）。
- **子菜单点不中**：220ms 延迟关闭 + `[data-menu-portal]:hover` 判据（真实
  鼠标斜向路径穿过父面板行不再瞬关）。分组四项实测可点可持久化。
- **会话名 = bot 名**：`session.create` 无标题时不再回落 bot.name（未命名，
  首条消息后自动命名）；host.newChat bots 页签不再拿 bot 名当标题。
- **host.ts 空实现校正**：多 profile / 多网关已存在；`warmProfile` =
  `pi_profile_ensure`（新 IPC），`warmAgent`/`retainProfileSocket` 远端
  route 确保连接在场；`retainProfile`/`ensureAgent` 仍空（无进程池引用
  计数对象，注释说明）；`dropLeftoverProfilePrefs` 清本机 bot-meta/ui-meta
  残条；mirror `store/profile.ts` 的 `$profiles` = botsStore 真实投影。

**✅ 2026-11-25（七）：侧栏体验修复（Bot Chat 洪泛 / 二级菜单 / 折叠动画 / 例程面板）**

- **Bot Chat 洪泛**：磁盘 61 条 "Bot Chat" 只有 2 条有双锚（其余旧版本历史
  铸造）→ 侧栏加标题判据 `isBotModePlumbingTitle`（Bot Chat / Agent Inbox /
  `Group: ` 前缀，hermes session-sweep 同形）；锚逻辑实测不再重复 mint。
  实机：侧栏 0 条 Bot Chat / Group 行。
- **侧栏选项二级菜单**：根因 = React 合成事件沿组件树冒泡——子菜单 portal 的
  pointerover 也到父面板，父面板旧判据把子菜单卸载。修复判据 = 最近
  `[data-menu-portal]` 必须是本面板 + 只有悬停真实菜单项才清。实测进入/
  点击「项目」通过。
- **折叠/展开动画删除**：deferred-collapse 退化为同步 setGroupCollapsed；
  `beui-disclose-row*` 关键帧/.disclose-row 规则/justExpanded/collapsing
  全删。实机 60ms 内 25↔0。
- **例程面板**：hermes = Bot Mode 右缘折叠竖标签（defaultCollapsed）；宿主
  addPanel 改 `inactive: true`——打开机器人页只挂后台「定时任务」标签，不抢
  激活签（实测 group 激活仍是文件树）。
- 附：群聊（room ≠ 会话；每成员一条隐藏 `Group: <roomId> · <profile>` 管道
  会话）与远程/SSE（远程 bot transcript 落对端网关 home；本机只有
  bot_relay 消息信封）的审计结论见 AGENTS「2026-11-25（七）」节。

**✅ 2026-11-25（六）：配置绑定收尾 + 侧栏「网关与配置」跨环境聚合**

- **（五·二）providers/models/auth + 技能装删 + 扩展列表按环境**（commit
  f0cdaf2）：`pi_settings`/`pi_keys`/`pi_login`(discover)/`pi_image` 全走
  `pi_profiles::active_home`；语音配置留本体 home；`pi_skills_catalog`
  的搜索/安装/删除按**目标环境**（`skills.manage` 随请求带 `profile`，
  host-rpc + shim 透传；bot 编辑框给哪个 bot 装就落哪个 home）；
  `pi_extensions` 列表按活动环境 home。
- **（六）侧栏「网关与配置」打通**（用户："网关与配置没有打通吗？"→
  完全按 hermes）：`pi_session::index_sessions` **跨环境聚合**——本体既有
  根之外再扫每个具名环境的 `<home>/sessions`（`list_profile_names()`；
  切环境不再让列表换源）；`ScanRoot`/`SessionRecord` 带 `profile` 标签
  （`RootKind::Profile`）；前端标签链（`SessionsIndexSession.profile` →
  catalog/session-order/profile 元数据 → 基线行按活动环境打标、登记表
  补行带 `record.profile`）；`grouping='gateway'` 从 disabled 转正
  （`groupEntriesByProfile`：本体「Mirach」+ 品牌 logo 恒第一组，具名组
  按 bot 花名册序带圆形头像，孤儿环境殿后；折叠键 `gw:<name>`）。
  **实机**：index 分桶 本体 73 / 微软 13 / remote-bot 10 / 风格和 7；
  网关与配置分组 4 组头（Mirach + 3 bot）滚到底分组计数 3/7/10 行。
  有意不做：`showAllProfiles` 复选框（恒聚合）、配置档案栏视觉条。
- **打开跨环境会话补种子配置**（实机修复）：点 remote-bot 组里的会话报
  `No API key`（隔离前建的 bot home 只有 sessions/）——
  `build_harness_for_profile` 打开路径改走 `ensure_profile_dirs`
  （copy-if-missing 四件套），重开验证通过。
- **门禁**：`cargo test` 740 passed / 1 ignored；`npm test` 96 文件 /
  1126 用例；touched 文件 tsc 无新增错误。**待做**：`pi_pkg_*`（rpi
  install 落本体 home）、MCP 全局配置/cron 仍进程级（AGENTS「五·二/六」节）。

**✅ 2026-11-25（五）：配置绑定（引擎同步 AgentHome + 会话/技能按环境走）**

- **引擎已同步到上游 main@301c98c**（`G:\pi-rust-main`，宿主 path 依赖）：
  本地补丁层已重放（approval per-session / plan-mode 副本 / 工具描述 / shell
  prefix），`cargo check -p rpi-cli --all-targets` 干净。上游新增
  **`AgentHome`**（PR #409）：`session::build(home,…)` / `provider::resolve(home,…)`。
- **宿主**：`home_for_profile` + `profile_from_session_path`；`build_harness_impl`
  按 home 解析 provider/build/扩展；`build_harness_for_profile` 归属 = 显式
  profile（bot）> 打开会话按文件环境 > 新建按活动环境；**`pi_create_bot_session`
  补上 `profile` 参数**（前端一直传、Rust 此前丢弃 —— bot 会话落错根的根因）；
  `pi_capabilities`/技能开关/读写删全部按**活动环境** home；环境 home 的
  auth/models/settings/trust 四件套 copy-if-missing 克隆（hermes
  `profile create --clone-all` 对偶）。
- **门禁**：`cargo test` 739 passed / 1 ignored。（同轮后续已在（五·二）/
  （六）完成 providers/models/auth IPC、技能安装落点与侧栏聚合——见上。）

**✅ 2026-11-25（四）：技能页只列本机已装 + 左栏底部跟随正在看的 bot**

- **技能与工具页 = 只列本机已装技能**（用户："我要的是只显示本地仓库的技能"——
  即 pi 实际装载的 `~/.rpi/agent/skills` + 工作区 `.rpi/skills`）：shim
  `getOfficialSkills` 回空（139 条随包 optional-skills 目录不再在技能页展示，
  只留给机器人编辑框的技能选择器）；`catalog-browser.tsx::isDiscoverView`
  对 skills 恒 false（平铺列表，无 "Discover 技能" 货架）。实机：技能页 =
  「1password」一行（已装）+ Disable 开关 + Local/Global 标注，无目录行。
- **左栏底部身份 = 正在看的会话的 bot**（用户："左栏的左下角没有在切换机器人
  后变"）：点机器人行是导航（不切引擎活动环境），底栏改为
  `focusedBot ?? 活动环境 bot ?? 本体`（`useSessionBot` 从 message-avatars
  导出复用）。实机：点二万人 → 底栏 二万人+头像；回普通会话 → Mirach+logo；
  环境菜单切换 → 底栏随环境变（本来就通）。

**✅ 2026-11-25（三）：宽度调节只限最大化 + 机器人头像圆形/状态点 + 左栏生效 bot**

- **对话宽度手柄只在窗口最大化时出现/生效**（用户："只在软件最大化的时候出现
  生效，平时默认对话宽度最大，不可调节"）：`useHtmlMaximized()`（读
  `html[data-maximized]`）gate 手柄渲染 + CSS 兜底隐藏；宽度默认改最大值
  （列宽−176），**普通态忽略存储偏好**，最大化才套 `--dsh-chat-user-width`。
  实机 893px 列：普通 handles=0/内容 717；最大化 handles=2/内容=存储偏好；
  还原回最大。
- **机器人页**：头像统一圆形（BotFace 照片 50%、行内强制 `shape="circle"`、
  GroupRow 圆）；状态点从名字行首挪到**头像右下角**（tone = botMood
  work/think ? live : idle；底盘 + 细环同群聊角标）。
- **左栏底部**：改显示**当前生效环境 bot 的头像 + 名字**（active-profile +
  botsStore；本体 = Mirach + 品牌 logo；默认态已实测）。

**✅ 2026-11-25（续）：技能市场 = 本地技能目录 + 开场粒子 + 拖动带 30**

- **「技能与工具」页的技能市场改用本地技能目录**（用户："技能与工具不是做
  成本地目录吗?"）：`fetchCatalog('skills')` 直接 `[]`（不再拉
  nousresearch.github.io 的远端 skills.json）；shim `getOfficialSkills` =
  `pi_skills_search('')`（随包 `src-tauri/skills-catalog/`：hermes
  optional-skills 22 分类 / 139 技能，`installed` 读磁盘）；
  `installSkillFromHub` / `uninstallSkillFromHub` = `pi_skill_install` /
  `pi_skill_remove`（上游 runHubAction 的「spawn → 轮询」两步用模块级
  `localActions` 登记表接住第二步）。实机：139 条 Optional 行渲染、点
  「安装」1password → `~/.rpi/agent/skills/1password/SKILL.md` 落盘
  （5104B）、行即刻翻已装、页签计数 0→1。
- **开场标识 = 启动页同款 ParticleText**（用户："开场标识也用启动页的那个
  组件？"）：`thread.aui.tsx` 的 `EmptyStateWelcome` 换成
  `components/particle-text/`，容器 `.aui-intro-particle`（`launch.css`）；
  旧宿主 `Wordmark` 撤下。实机：672x220 画布、平均色 (0,111,255) = `--brand`。
- **顶栏拖动带 = 30px**（用户："拖动窗口的区域高度改为 30"）：
  `dockview-shell.tsx::TOP_BAND_PX` 85→30；clientY=45/60 的 pointerdown
  不再被拖窗处理器 preventDefault（旧 85 会拦截），页签/按钮手势不再被
  截胡。

**✅ 2026-11-25（续）：hermes 启动页移植（ReactBits ParticleText）**

- `src/components/launch-overlay.tsx` = hermes `GatewayConnectingOverlay` 的
  宿主对偶：冷启动全屏实色遮罩（`--surface-shell-base`，玻璃/透明也不透桌
  面）→ MIRACH 粒子字标 + 「正在启动 Mirach 引擎…」→ 就绪后按 hermes 编排
  退场（字标 360ms 位移淡出去饱和 → 停 300ms → 遮罩 520ms → 卸载）；
  最短展示 1200ms 防闪；`prefers-reduced-motion` 直接卸载。
- 字标 UI = **ReactBits ParticleText 逐字复制**（`src/components/
  particle-text/`，纯 Canvas 2D，无依赖；只删了 `'use client'`）。
  **不要给它传 `color="var(--brand)"`**——canvas fillStyle 不解析 CSS 变量，
  粒子会静默变黑；组件默认 `currentColor` 会读容器 computed color（正确，
  容器 `.launch-overlay__particles` 设 `color: var(--brand)`）。
- **品牌接力（2026-11-25 用户："启动页 logo 也加进去……文字和 logo 缩小移动
  到主页 logo 和文字的位置，主页的内容从四面八方落位"）**：启动页显示
  logo（`--logo-size` 基座 ×2.1）+ 粒子 MIRACH；就绪后隐藏真实栏品牌
  （`data-launch-handoff`），粒子淡出、精确版「Mirach」文字出现，logo 与
  文字按 FLIP（translate + scale，680ms）落到 `.rail-logo-mark` /
  `.rail-logo-word` 的**最终 rect**（实测 260ms 时 logo 45px@30,25、文字
  116.5px@87,25，与左栏完全重合），随后卸载遮罩、真实品牌原样出现。
  同时给每个 `.dv-groupview` 按 x 排序分配左/上/下/右方向矢量
  （`--launch-enter-x/y` + 70ms 递进），`data-launch-reveal(-active)`
  触发 `launch-enter-group` keyframes，标题栏从顶部落下。
- 全链路 boot 状态：`src/lib/boot-store.ts`（booting/ready/failed + retrySeq）
  ← runtime endpoint 发现带 40 次退避重试（20s），失败进启动页错误卡；
  SSE `onopen` 置 ready。启动页失败态有「重试」→ requestRetry → runtime
  重跑发现/水合。启动 45s 未连上或 SSE dropped 也收敛为可见失败。
  dev 预览：URL 加 `?connecting=1` 常驻展示。
- 实机验证：`?connecting=1` 截图 MIRACH 蓝色粒子字标 + 状态行；导航回
  `/` 真实冷启动 4s 后遮罩已卸载（`overlay:false`）。

**✅ 2026-11-25：对话错误可见 + 技能与工具本地开关 + 打包**

- **模型连接失败/运行失败有可见错误**（用户："用户发了消息就看到 ai 没回复"）：
  根因 = rpi 的 `RunResult.outcome = Failed` 仍以 `Ok` 返回（AgentEnd 无
  error 字段），`pi_session.rs::run_prompt_on` 的 `result.map(|_| ())` 把它
  当成功 → agui 只推 RUN_FINISHED、不推 RUN_ERROR，空 assistant 消息又被
  前端抑制。修复 = Failed 转 `Err(error.message)`，agui Err 分支推
  RUN_ERROR；实机把 BBT baseUrl 指到关闭端口复现，错误条正确显示
  `http error: ... http://127.0.0.1:9/v1/chat/completions`。
- **机器人/分栏 run 错误卡不再挤内容**：`session-thread-pane.tsx` 的
  `ErrorState` 从文档流改为 `absolute inset-x-3 top-3` 浮层（对话区
  relative），出现/消失不改变 Thread 高度。
- **设置 → 技能与工具 = 纯本地开关**（用户："内容全部换成本地的开关"）：
  新 `src/app/settings/skills-tools-settings.tsx`，数据面
  `pi_capabilities` / `pi_set_toolset_enabled` / `pi_set_skill_enabled`
  （`harness-capabilities.json`）；17 个工具集 + 技能清单全部 Switch，
  旧 skillDirs/promptDirs/extensionDirs/defaultTools 文本框删除。
  `shellPath` / `shellCommandPrefix` 迁到「核心连接 → 引擎网络 → 终端执行」。
- **打包**：`npx tauri build --config src-tauri/tauri.prod.conf.json
  --config '{"build":{"beforeBuildCommand":"npx vite build"}}'`（跳过历史
  tsc 基线错误，仅构建）→ `src-tauri/target/release/bundle/nsis/
  Mirach Harness_0.1.0_x64-setup.exe`（84.27 MiB）。prod 窗口最小尺寸
  同步 1280×600 / shadow true；`src-tauri/icons/*` 从 G:\MIRACH 复制
  （安装器图标/配置对齐 hermes）。分支 `bots-plugin-complete` 已推送
  `8d29b75`、`cd492ca`。

**✅ 2026-11-24（续）：设置页大修 + 记忆插件 rpi-optchat**

- **布局**：`--dialog-nav-w` 172→200（「密码与登录」不再截断）；左栏
  「设置」对齐组标题（padding 20），右栏标题栏改为独立卡片（`.set-inset-head`
  同 --surface/描边/--radius-panel-lg，padding 16 → 标题与卡内正文同基线）；
  内容卡撑满：`.set-scroll > .set-section` / `.set-persona` /
  `.set-persona-card` 与最后一张 `.set-acct-card` `flex:1 0 auto`，底部
  与左栏岛齐平。
- **导航**：通知去掉「提醒/声音」子页（hermes 单页）；模型删「账号」子项，
  默认子视图 = API 密钥；「安全与数据 → 项目」删除；**会话管理**成为总项，
  四个子项 = 数据同步 / 使用统计 / 项目管理 / 归档管理（原「数据与统计」
  组整体删除）；关于删「账户」；插件集成无贡献时整组隐藏。
- **页面**：常规删「引擎固定限制」；形象 41 头像改为「选择头像…」弹窗；
  通知按 hermes notifications-settings 单页复制（启用通知 + 七类事件 +
  完成提示音 + 测试按钮，右侧 Switch）；关于按 hermes about 重排（居中
  logo/版本 → 更新状态卡 → 自动更新/渠道 → 运行信息；本地构建无更新器，
  按钮禁用并写明升级路径）。
- **模型**：自定义端点底部按钮靠右；默认模型页字段全部中文（默认思考档位/
  隐藏思考块/思考预算·档位/可用模型范围/重试字段）。
- **rpi 设置审计**（引擎 `settings.rs` vs 宿主 UI）：
  - 修真字段：`retry.maxAgentDelayMs`（原来写的是引擎不消费的
    `max_delay_ms`）；新增 `shellPath` / `shellCommandPrefix`（技能与工具 →
    终端执行）。
  - 删死键控件：`retry.max_delay_ms` / `failover*` /
    `compaction.mode` / 顶层 `compaction_mode`（serde 忽略，写了没效果）。
  - 未暴露且**有意不做**：TUI 专属（theme/keybindings/editorPaddingX 等）、
    无消费方（branchSummary/compaction.modelOverrides）。
- **记忆插件**：已 `rpi install rpi-optchat`（0.1.0，`~/.rpi/agent/extensions/
  rpi_optchat.dll`）。引擎新会话工具集实测含 `zoom` / `search`。设置页
  「记忆与上下文」显示真实安装状态、128 KB 摘要树、profile 存储、
  /optchat 命令仅终端可用；MEMORY.md/USER.md 与 mem0 仍无对偶。
- **核心连接**：hermes 四模式卡保留；远程/云/SSH 卡未配置时点击 → 滚动到
  下方连接注册表并**按所选 kind 打开添加表单**（新增
  `ConnectionsRegistrySection` 的 `initialKind/openEditorSignal`）；注册表
  本身承载增删改/测试/设为主要。宿主主窗仍固定本机引擎，hermes 的「保存并
  重连到远端 backend」未移植（无该后端模式）。
- **插件集成**：mirach-connections 只保留 `bots.roster.grouping`（设置页
  「连接」删除）；mirach-pkg 整个插件目录删除；插件组无贡献时隐藏。

**✅ 2026-11-24：设置页卡片化 + 窗口/栏宽约束**

- **设置页**：恢复「岛屿卡片」形态（`.set-acct-card`），小节标题用 `:has()`
  焊进卡片头（标题在卡内）；全局设置字号令牌 `--settings-label-size:14px` /
  `--settings-desc-size:12px` / 行距 `--settings-row-pad-y:12px`，与聊天字号
  缩放解耦。无卡片的平面页由 CSS 包成一张卡。
- **栏宽**：窗口最小尺寸 **1280×600**（`tauri.conf.json` `minWidth/minHeight`
  + `window_state.rs::MIN_W/MIN_H` + `main.rs` 运行时 `set_min_size`；实测
  `WM_GETMINMAXINFO` minTrack = 1280×600）。四列最小 300+240+395+270 因此
  不会被窗口边缘裁切。
- **面板约束**：所有右侧栏/会话新面板 `addPanel` 带 `minimumWidth` +
  `maximumWidth`（preview / subagent / plan / agent-directory / workflow /
  routines / open / terminal）；boot `normalizeColumns` 给每个带 `region` 的组
  补组级约束（rail 270–400、chat ≥395）——组级约束不随存档 round-trip。
- **旧五列存档迁移**：`routines` 从独立第五列并回 panels 组（`params.region`
  补戳 + `moveTo({group, position:'center'})`），否则窗口一窄就被挤成 100px
  并裁掉。实测重载后组数 = 4（left/bots/chat/panels），routines 与 terminal
  同组，聊天列 `setSize(200)` 夹回 395。
- **面板栏内上下/左右分栏保留**（2026-11-24 用户："把定时任务标签拉出在
  面板栏进行分栏"→"左右分栏啊"）：
  - `normalizeColumns` 只迁移**旧第五列**——根级 leaf 且宽度 <270（历史
    100px）；用户拖出的左右分栏列 ≥270，原样保留；上下分栏是嵌套 branch，
    也原样保留。
  - `alignVisibleToOrder` 在 panels 区有多个组时跳过面板栏贴边重排，避免
    重载后左右顺序翻转。
  - **左右分栏 = 根级多一列**：`ensureWindowFitsColumns` 按每列组
    `minimumWidth` 求和（上下堆叠按 x 去重），窗口不够就 `setSize` 长窗，
    并把 `setMinSize` 抬到同一值；列数减少时收回 1280。实测 1280 窗口下
    把 routines 拖到 terminal 右侧 → 窗口自动长到 1505，五列
    300/240/395/288/270 全部可见；冷重启后仍是五列，顺序为
    terminal(左) → routines(右)。
- **输入框不再被会话穿透**（2026-11-24 用户："输入框又被会话穿透了，
  看看 hermes 是怎么做的"→"遮罩能隐身但截断文字吗"→"宽度能撑满整个栏，
  上方给个渐变"→"输入框很白是不是层级变了"）：footer 通过
  `createPortal` 移到 viewport 外侧（保留 ThreadViewport context），
  消息滚动区结束在 footer 上方；viewport 用 `mask-image` 最后 64px
  渐隐透明，不画颜色、不裁输入卡、无硬边界。footer 本身全栏宽，内部
  status/composer 用 `max-w-(--dsh-chat-content-width)` 居中，输入框
  宽度保持内容列宽。ComposerBar = `--composer-fill` **55%** + 12px blur
  saturate(1.12)，不再叠白色渐变（输入框后面已无消息，不需要高不透明）。
- **语音输入可取消**（2026-11-24 用户："输入框的语音按钮点击之后没法
  取消"）：根因 = `useDictation.stop()` 先把 `recRef` 置空再 `rec.stop()`，
  `onend` 的身份校验永远失配 → `transcribing` 永久卡住且按钮被 disabled。
  修法 = stop 保留句柄等 onend 收尾 + 3s 看门狗；transcribing 期间按钮
  仍是可点的停止态，点击直接 `cancel()`；`onerror`/`start` 异常也走
  settle。实测点开始 → 标签变「停止语音」→ 再点面板消失。
- **终端背景透明**（2026-11-24）：`.term-pane` 不再叠第二层 `--surface`
  （组容器已经有一层 55% 栏面色），普通态用 `--term-bg`，背景图开启时
  transparent；xterm 构造开 `allowTransparency:true`，主题 `background`
  固定 `rgba(0,0,0,0)`（不能依赖建实例时背景图已 onLoad）。实机
  `.term-pane` / `.xterm` / `.xterm-viewport` 三层背景全透明。
- **TurnGate 退役**（2026-11-24）：轮级 IntersectionObserver 卸载/等高占位
  被移除（用户："长会话往上滚动会没法滚动、闪烁；切换会话也有闪烁"）。
  转录渲染窗口（`transcript-window.ts` 的尾部预算）保留；不再按视口卸载
  轮次，滚动/DOM 高度稳定。实机 8 轮长会话上滚每档 500px 稳定、无占位符。
- **boot 落盘保护**（2026-11-24）：boot 不再无条件保存布局——只有
  `normalizeColumns()` 真的迁移了 routines 才落盘。`saveLayout` 增加结构
  不变量：`leftHidden=false`/`panelsHidden=false` 但 JSON 里没有对应
  `region` 的 panel 时拒绝写入（实测 HMR 重载会把只剩左栏+主栏的临时树
  固化成正式存档，之后每次启动都丢栏）。
- `routinesPaneSync` 增加 `routinesContributionSeen`：启动早期插件贡献
  尚未注册时 `wanted=false` 不再摘除存档里的 routines 面板（否则插件
  加载后按普通标签重建，分栏被毁）；真正注销/插件关闭时才摘。

**✅ 2026-11-23（续2）：bots 插件对齐 hermes 新版（用户："对齐，新版本，不要自己做，复制"）**

- **逐字复制的新文件**：`teammate-waits.tsx` / `teammate-wait-locales.ts`
  （Bot Chat 输入框上方「等待队友」条：5s 轮询 `bot_delivery.list`，
  queued/claimed/working/waiting_on_you/failed，失败可忽略；unknown outcome
  明示「永不自动重发」）。
- **durable 群聊记录收敛**：`group-chat-record.ts`
  （`durableGroupChatRoom` / `hydrateDurableGroupChatRoom`）逐字复制；
  `types.ts` 补 `RuntimeGroupChatKey` / `DurableGroupChat`；`group-chat.ts`
  的 `durableGroupChatRooms` 与 `updateGroupChat` 全部走 helper（宿主旧版
  丢 `sessionOwners`/`holds`/`holdDetection`/`heldMessages`，重启即丢数据）；
  `group-chat-view.tsx` 解散路径改回上游 `persistGroupChatRooms`。
- **composer.top 贡献槽**：`ComposerTopSlot`（`composer-wired.tsx` 的
  ComposerBar 首行）+ `ComposerSessionProvider/useComposerSession`
  （`hermes-shim/app/composer-session.tsx` 逐字段照抄上游 scope.tsx 段；
  SDK 按上游 `sdk/areas.ts` 导出）+ `hermes-shim/contrib/react/slot.tsx`
  （镜像 slot 依赖上游组件树，不能直接用）。`plugin.tsx` 注册
  `teammate-waits` 到 `COMPOSER_AREAS.top`。
- **i18n**：四语言 `waiting` 段并入 `BotsMessages`/`BOTS_LOCALES`；
  `shareKeysHint` 四语言恢复上游文案；宿主自有 skills-hub 七键保留。
- **tokens**：`hermes-tokens.css` 补 `--ui-bg-primary` / `--ui-bg-secondary`
  （上游 styles.css 公式；teammate-waits 卡片底此前会解析成透明）。
- **`bot_delivery.list` 宿主数据面**：`lib/bot-delivery.ts` 登记本机直投与
  远端 relay 的未收尾投递（queued→claimed→working→settle/failed；远端
  settle 由 `bot_relay:reply` 唤醒），`host-rpc.ts` 新增该 RPC。只登记
  **真有 waiter 的投递**，settle 即删；窗口重启内存表清空 = 不虚构。
- `create-dialog.tsx` 恢复上游 `PROFILE_ID_ARG_RE`（`src/lib/profile-id.ts`
  逐字复制 + SDK 导出），删除自写 `NAME_RE`。
- **bot 对话区标题 / 页签（用户："下面是会话名，现在会话名变成 bot chat 了"）**：
  会话真名仍是 "Bot Chat"（引擎/registry 不动），显示层与普通会话同款：
  优先派生标题（首条用户消息），无派生标题时回落到机器人显示名——
  `runtime.tsx` refreshThreads 的 bot 锚会话 `row.title` 覆写从
  `机器人名 · Bot Chat` 改为这一规则；`canonical-chat.ts` 保持上游逐字；
  旧布局存档里的旧格式侧栏标题在 `dockview-shell.tsx` 恢复时一并改写。
- **群聊房间输入区显示修正（用户："群聊的显示对吗？输入框怎么和我的输入框不一样了"）**：
  `group-room-ui.tsx` 与上游逐字一致，但宿主缺上游 composer 令牌 →
  补 `--composer-control-gap` / `--composer-surface-pad-x/y` /
  `--composer-input-min-height` / `--conversation-text-base-size/font-size` /
  `--composer-fill` / `--composer-ring-strength` / `--chat-text-scale`
  （hermes-tokens.css）；`--chrome-action-hover` 别名补进 tokens.css
  （整个插件的 hover 底此前透明）；SDK 的 `composerInputBacking` /
  `composerSurfaceRing` 改为直接复用镜像 `components/chat/composer-dock`
  （旧近似值造成"框里套小框"）；房间输入区圆角 20px 与主输入框一致。
- **机器人页弹窗全黑 + 描边（用户："机器人页的弹窗选项，怎么都是黑的，还有描边？"）**：
  根因 = 宿主壳只有 light 调色板（tokens.css），但镜像主题层默认跟随 OS
  （system → dark）——菜单/对话框用 `--ui-bg-elevated` 等暗色 token，而宿主
  文字/描边仍是浅色 token，实际是黑底黑字。`hermes-mirror/themes/context.tsx`
  的 boot paint 固定 `light`（宿主补齐暗色壳之前）；实测机器人行右键菜单
  底 `#f6f6f6`、文字深色、1px 12% 发丝边（上游设计边）。
- **群聊输入区 = 主输入框同一套组件（用户："输入框还是不对啊，是你自己又做了一个"）**：
  `group-room-ui.tsx` 的 `RoomComposer` 改用宿主 `ComposerBar` /
  `ComposerSend`（SDK 新增导出），附件钮换 `ComposerAttachButton`；布局改为
  「附件/回复 chip → 输入 → 工具行（+ 左 / 发送右）」，圆角/内距/发送钮与主
  输入框一致（实测 720 宽房间：radius 20 / padding 12 / gap 12）。轮次状态
  （「已结束 — 没有人还有话要说」）移到输入卡**上面**（用户："这个提示应该
  在输入框的上面"）；群聊 `turn.failed` 等错误 notice 补 `wrap-anywhere`
  + `overflow-hidden`，长 error 不再突破右边距。
- **对话头像系统（用户："用户一个头像，ai也有头像"）**：
  - 设置 → **形象**（原占位节）→ 41 张内置用户头像（
    `public/avatars/user/u01..u41.jpg`，来自桌面「新建文件夹 (3)/用户头像」，
    最长边 256px），选择存 localStorage `mirach:user-avatar`。
  - 对话区：**每条消息最上面**一行身份区——名字与内容同边（AI 左 /
    用户右，名字中线与头像中线对齐），**头像在外侧**（AI 最左 / 用户最右，
    40px，机器人页行头像同为 40px；`message-avatars.tsx`）。用户名 =
    个性页「显示名称」（未设 = 你），AI 名 = 所属 bot 显示名（普通会话 =
    Mirach）。AI 头像 = 当前会话所属 bot 的 `image`；普通会话/无图 bot
    回落 `/brand/logo.png`。分栏 pane 的会话 id 走 `thread-session-id` 上下文。
  - 删除机器人（与 hermes `profiles.delete` 对齐）：先 Rust
    `pi_profile_delete` 删 `<agent_dir>/profiles/<name>`，成功后才删
    botsStore / `bot-meta-v2` / 选中项 / `bot-ui-meta`；群聊成员不跟着删，
    但群聊驱动跑轮前查本地名册，已删 profile 报
    `turn.failed(member_unavailable)`，不会重建目录复活。
  - 默认 Mirach bot 头像改为品牌 logo：`makeDefaultBot` + 一次性迁移
    （`botsStore` 与插件 `bot-meta-v2` 各一次；迁移后用户再改不再覆盖）。
- **设置 →「外观」（2026-11-23 整页从 hermes 复制；2026-11-24 第二轮
  按用户反馈修正）**：主题（明亮/暗色/跟随系统；模式控件放大成单独一排，
  皮肤画廊完整展开不内层截断、中文名/描述，选中项不置顶、已选主题再点
  取消主题回宿主基础外观）、主题色
  + 文字颜色（同为 6 预设 + 自定义 + 默认；文字色换肤后仍保留；位图
  logo 用 hue-rotate/saturate 跟随主题色）、底部
  波浪动效（`BottomWave`，高度 1/3 窗高、底部起始、跟随主题色；挂在
  app-shell 内、app-main 之下，不覆盖文字/组件）、开场
  标识（hermes `Wordmark` 的 `.fit-text`：MIRACH 字号随输入框列宽缩放、
  0.08em 字距按每个 span 自己的字号结算，文字左右边与输入框对齐；starter
  suggestions 气泡已删除）、界面缩放（Tauri webview
  zoom + Ctrl/Cmd +/-/0）、聊天文字大小（100% = 15px 基准；AI markdown/
  用户气泡/composer 都走 `--conversation-text-font-size`）、聊天字体/
  终端字体、聊天背景（`GlobalBackdrop` 在 #root 后铺一张图，**每栏容器**
  按 5/15/30/50/100 透明度档位透出；`--surface` 仍由主题基础色 mix，栏
  颜色不变；来源只有内置图片切换 + 自定义上传；图片 onLoad 后才透明
  容器）、文件浏览器（dockview `files` 面板跨
  窗口镜像）、消息气泡（`--user-bubble-keep` + 描边开关）。**窗口透明已
  接通**：`tauri.conf.json` `transparent:true` + `lib/translucency-host.ts`
  桥，Clear 用 #root opacity，Glass 用 Tauri Acrylic + surface 半透明。
  悬停/选中统一低饱和 `#f1f4f8`/`#e3eaf2` 令牌。数据面
  `lib/appearance-prefs.ts`（localStorage `mirach:appearance.v1`，跨窗口
  生效）；主题 mode 缺省 light。所有可选项均有默认/再次点击复原。

- 生产文件对比：上游独有 0；宿主独有仅 `roster-active-pill.tsx` /
  `skills-hub.tsx` 及已注明的宿主增行（选中 pill、skills hub 入口）。
  门禁：tsc 1315（历史值不变，改动文件 0 新错）/
  vitest 1121（95 文件）/ `vite build` 通过。

**✅ 2026-11-23（续）：设置页「数据与统计」按 ZCode 全链路补齐（用户："继续补齐啊"）**

- **项目管理**（projects-settings.tsx）：全选半选（indeterminate）、置顶
  Pin、多 root +N 悬停列表、窄屏三列折行（设备/会话/最近活动进元信息行）、
  加载失败/会话统计失败各自「重试」、操作失败可关闭可重试、批量移除 toast
  「撤销」、错误提示条对齐 ZCode（TriangleAlert + 重试 + 关闭）。移除项目
  的菜单图标改为 FolderMinus（不是垃圾桶）。
- **工作区 = 项目**（同日修）：项目页此前恒 0——`选择文件夹` 只建会话不落
  项目注册表。现在 `workspace-projects.ts`：启动按会话索引 distinct cwd
  补登记项目（已有根/软删根覆盖的跳过）；新建工作区会话前
  `ensureProjectForWorkspace`（同根复用/恢复/新建）再建会话，失败整个请求
  失败。当前本机会话 cwd 都是 `C:\Users\Administrator`，因此项目页会自动
  出现「Administrator」。
- **归档管理**（archives-settings.tsx）：标题行「全部永久删除/永久删除筛选
  结果」、搜索清空钮、排序（更新时间/创建时间）+ 项目过滤三列栅格、分组
  折叠箭头、行标题+时间堆叠、删除确认对话框、结果「成功 N 项，失败 M 项，
  跳过 K 项」+ 失败详情、加载失败重试、项目标签（未归类 / 名 · 已移除 /
  已移除项目）。
- **后端真实字段**：`pi_sessions_index` 透出 `createdAt`（header.createdAt，
  旧文件 0 不伪造）；`pi_usage_snapshot` 的 `daily[].models` 给出每天各模型
  token（多模型折线图真实数据）、`summary.longestSessionMs` 按会话首末消息
  时间戳差值计算（不再显示"—"）。前端趋势图改为 top 6 模型多折线 + 图例。
- **实机验收**（真实鼠标/截图，未用 CDP）：项目管理表头/半选/选择条/
  已移除项目展开、归档页空态与筛选布局、用量页 5 格概览（最长聊天时长
  5 天 11 小时）/热力图/多模型折线/环形占比均正常。
- 门禁：tsc 非镜像区 0 新错（镜像历史 1385 条不变）/ vitest **1117**
  （94 文件）/ cargo test **738** 通过 + 1 ignored。测试项目
  「Mirach Test / Missing Root」已从 session-meta 清除，未残留。
- **仍不移植**：Coding Plan（云端订阅 API，宿主无账户与端点）、分享管理
  （用户明确排除）。

**✅ 2026-11-23：两处滑动悬停块修正（用户实报"碰到可折叠组头打架/残留"）**

- **主窗左栏会话列表**（`SessionListHoverPill.tsx`）：指针命中组头/日期桶/
  工作区桶/状态桶 → 收起 pill（不再停在上一行）；锚定行卸载或开始
  `.disclose-row--closing` → MutationObserver 收起（收起组后无残留）；行位移
  与列表滚动 → 重测（滚动用 `elementFromPoint`，pointerover 不因滚动触发）。
  行间 1px 间隙仍不动作（逐行滑过不闪断）。
- **设置页左栏**：可展开节再点一次收起（`collapsedSubmenus`；切节/键盘/
  深链自动展开）；子项接入滑动悬停——`AnimatedSidebarMenu sharedHover={false}`
  + nav 容器层 `AnimatedSidebarHoverPill`（`data-sidebar-row`，组头与子项
  共用一条 pill，坐标公式同会话列表）。其它 SharedLayoutBg 消费点不动。
- 实机 CDP：分组收起后 pill `opacity:0`；设置页子项悬停 pill 跟到
  `y=392/x=53/w=100/h=25`，再点「模型」`aria-expanded:false`、子项 0 个，
  再点恢复 4 个。门禁：tsc 非镜像区 0 新错 / vitest 1112（93 文件）。
- **同日续（用户："机器人页也用这个组件选择，对话输入框的圆角改成20"）**：
  机器人名单选中底改滑动 pill（`roster-active-pill.tsx`；行 class 去掉静态
  `bg-(--ui-row-active-background)`，改 `data-roster-active`；实机 254→166→154
  滑动、群聊行 48px / bot 行 49px 自适应）；composer 圆角 32→20（
  `ComposerBar rounded-[20px]` + `--composer-radius` 20；实测计算值 20px）。
- **同日续2（用户："只要计划模式和完全访问，要会话级别的，完整移"）**：
  - 引擎 `approval_gate.rs` 新增按会话 id 的审批 pin（`set_session_mode` /
    `session_mode` / `clear_session_mode`；全局 MODE 只作 fallback）。
  - 宿主 `approval_modes.rs` 持久化 `~/.rpi/agent/approval-modes.json`；
    `pi_mode_state` / `pi_set_approval_mode` 增 `sessionId`；主会话默认
    always-ask，New Chat 选择暂存 pending，第一份主会话消费并落盘。
    前端删掉全局 localStorage 恢复。
  - 计划模式：`rpi_plan_mode.dll` 的模块级 static 会跨会话串（A 计划 B 也
    planning）；引擎 loader 对 `rpi_plan_mode` 做 **per-session 临时副本**
    再 LoadLibrary，得到独立模块实例。入口 `pi_set_plan_mode({enabled,
    sessionId?})` 按会话执行 `/plan start|exit`；计划期审批 pin =
    `ApprovalMode::Planning`（不是 yolo）：插件工具目录是 run 开始时快照，
    Planning gate 在 before_tool_call 层让**对话中切计划**立即拦截 write/edit，
    read/bash 照常；退出回 always-ask。计划 pin 只存内存——重启后插件
    不恢复 active（实测），所以 planning 不写 `approval-modes.json`。
    New Chat 选择暂存 pending，第一份
    主会话创建后消费。实测 A planning /
    B off / 回 A planning；新会话 pending → planning；full access A yolo /
    B ask / 回 A yolo，重启后 A 仍按持久化值。
  - UI：`permission-mode-chip.tsx` 只剩计划模式 / 完全访问；完全访问
    ConfirmDialog + 风险勾选；两者互斥；2s 轻轮询。
  - 门禁：engine approval_gate **7** 测试过 / rpi-extensions 239 过 /
    host cargo test **738** / tsc 非镜像区 0 新错 / vitest **1121**（95 文件）。
- **同日续3（滑动组件 / 二级悬停弹窗）**：侧栏选项菜单扫过二级项时每个
  `ContextMenuSub` 各持 open、只开不关，叠出很多 portal。改为父菜单唯一
  `openSubmenuId` 互斥 + SubTrigger 120ms 延迟打开（leave 取消）+ 父面板
  pointerover 普通项清空。CDP 实测 6 个二级项逐个 hover：portal 恒 2
  （父 + 当前子菜单），移到普通项 1，关菜单 0。
- **同日续4（滑动效果回归）**：分组模式下命中组头/分隔线曾 `hide()` 把
  `shownRef` 归零，跨组后下一行只能淡入（用户："滑动组件没有滑动的效果了"）。
  `SessionListHoverPill` 与设置页 `AnimatedSidebarHoverPill` 的结构行改为
  `suspend()`：只淡出、不重置滑行状态。CDP 实测跨 workspace divider 后
  `transition` 仍含 `top 260ms`，行间连续滑动。另统一位移曲线为
  `SLIDE_EASE_CSS`（easeOutCubic）：原 expo 曲线 60ms 吃掉 80% 距离，
  45px 行距看起来像瞬跳（用户："没有滑动的效果"）。

**✅ 2026-11-22（续）：环境隔离 PR1 原型 + bots 插件边界收口**

- **rpi 上游环境隔离 → PR #409（AgentHome 构造注入，已合并）**：PR #406
  （`--agent-dir` + env pin）已被作者 closed 未合并；工作树
  `E:\Temp\pi-pr1-latest`（上游 `main@301c98c` 的树；发布走 GitHub API）。
  PR `https://github.com/bigfish1913/pi-rust/pull/409` 于 2026-11-24
  approved + merged（merge commit `301c98c`）。设计 = `AgentHome` 一次
  解析，`session::build(home,…)` / `prepare_extensions(home,…)` /
  `build_prepared(home,…)` / `ReloadContext.home` 全链传递；provider、
  settings/trust、resource dirs、`Scope::Global`/`host_leases_for`、
  native-package 扩展读取同值。无 CLI flag / `set_var` pin / 公开 `_at`
  twins；CLI 传 `AgentHome::process()`，行为不变。
- **PR #414（review 跟进，open）**：`AgentHome::from_option` 改为
  `Result`、立即拒绝相对 home（`ConfigError::InvalidAgentHome`）；全部
  `--agent-dir` 文案改成 explicit agent home；`agent_dir_home.rs` 补到 5 条
  （含同进程两个真 `session::build` 各读自己的 home/skills）。
  `https://github.com/bigfish1913/pi-rust/pull/414`。
- **宿主核对结论**：mirach-harness 不是 `rpi-extcore`——它 path 依赖
  `rpi-cli`（`src-tauri/Cargo.toml:32`）并在同进程里 `rpi_cli::session::build`
  前后台多个会话（`pi_session.rs:828`，`pi_bot.rs` 每 bot 一个 `BotSession`）。
  当前只有 session 根按 profile 隔离（`pi_profiles.rs`），auth/models/
  settings/trust/skills/extensions/native-packages/event log 仍走
  `pi_paths::agent_dir()`。已在 issue #405 用证据回复；上游 PR #409 是
  该 shape 的 scoped 变更。issue #405 保持 open 作设计参考。
- **extcore 评估**：`rpi-extcore 0.2.16`（`pi-rust/rpi-package`）每 session
  起 `rpi --mode rpc` 子进程；其 `SessionOptions`/`BackendConfig` 没有
  env/agent_dir 字段，per-profile 需一进程一 profile 或先给 extcore 加
  per-child env。宿主换 extcore = RPC 化重写，暂不走。
- 测试：`agent_dir_home.rs` 3 条（双 home 隔离 + 并发 + 真
  `session::build` 显式 home B 在 env A 下只读 B）；库 1263 过 / 3 ignored；
  `RUSTFLAGS=-D warnings cargo check -p rpi-cli --all-targets` 过。
- **bots 插件边界**：唯一 UI = hermes-bots 插件；删除宿主自造精简版
  `bots-pane.tsx` / `bot-launch.ts` / `bot-group.tsx` / `bot-subpages.tsx` /
  `bots-dialog.tsx` / `bot-stub-store.ts` / `bot-face.tsx`。新增总门
  `src/plugins/bots-gate.ts`（pluginActive + 注册成功标志，避开 runtime-loader
  误 drop bundled 记录）；关闭插件后左栏 Mirach 变文本、bots/routines 面板移除、
  群聊驱动停止、Bot Chat 隐藏过滤关闭。实机（CDP）验过启用/禁用两态。
- **bot 行语义修正**：点击 = 打开会话，**不切活动环境**；只有侧栏「环境 ▸」
  显式切。新 bot 聊天把 `profile` 传给创建 IPC，会话落 bot home 但不抢当前
  环境。默认 bot 显示名从自造的「本体」改为 hermes 同款的 **Mirach**。
- **未完成（诚实）**：auth/models/settings/skills/extensions 仍是进程级全局；
  cron 的 `Job.bot` 仍是过滤标签；群聊 host 驱动仍是自研适配层。全量 tsc
  仍有镜像区历史错误（见 AGENTS 门禁节）。

**✅ 2026-11-22：goo 弹层组件整体退役（用户："这个弹窗效果组件就不要了，换成默认的弹窗效果就行"）**

- 删除 `motion/goo-layer.tsx`（GooSurface / buildGooGeometry / gooClipPath）
  与其 18 条守卫测试；`--beui-popover-goo` 令牌、`POPOVER_GOO*` 弹簧导出
  一并移除。
- `context-menu.tsx`、`popover.tsx` 的弹层 = **portal 到 body 的 fixed
  面板 + tw-animate 默认 `animate-in fade-in-0 zoom-in-95`**（关闭时
  unmount / visibility:hidden）；落位数学（side/align/翻转/视口钳位）保留。
- 菜单/模型选择器/标签总览/加号等所有调用点 API 不变（`goo`/`gooStrength`
  保留为 no-op prop）。
- **"打开后抖一下"修复（同日）**：进场动画改为**测量完成那一帧才挂**
  （popover `open && layout`、菜单 `size.width > 0`），且 `transform-origin`
  指向锚点边缘（side=top → bottom、bottom → top，x 随 align）。原来中心
  缩放 + 先画后测的组合 = 可见第一帧先按旧几何出现再挪位。
- 门禁：vitest **1090**（89 文件；少 goo-layer.test 18 条）/ tsc 非镜像区
  0 错。真鼠标复验待做（应用当时被并行会话占用）。

**✅ 2026-11-21（续）：侧栏按钮审计 + 配置档案 ▸ 接 bots 筛选**

- **三个点/分组菜单"没反应"的真根因已修**：`motion/context-menu.tsx` 的
  `ContextMenuContent` 没 portal 到 body，fixed 弹层被侧栏 containment
  祖先偏移+overflow 裁掉（DOM/UIA 都有、屏幕看不见）。改为
  `createPortal(<GooSurface/>, document.body)`（后续 11-22 又整体换默认
  动效，见上）。修复后真鼠标逐项点通：行 ⋯（重命名对话框/置顶/标记未读）、
  分组 ▸、排序 ▸、筛选 ▸ 状态（空闲桶）、配置档案 ▸、收件箱样式、已归档、
  全部折叠。
- 会话行 8 个操作逐项真实点击验过，无死钮；复制 ID 的
  "Document is not focused" 已修（写剪贴板前补 window.focus）；例程面板移除
  的 dockview disposed 引用崩溃已修（先查 panels 成员资格）。
- **「配置档案 ▸」不再是灰项**：用户纠偏"一个本地 bot 就是一个 profile"，
  已接 bots-store——子菜单 = 全部配置档案 + 花名册 bots（值 = bot.name），
  选中后列表独占该 bot 的 chatSessionPath 行（并豁免 bot 永久隐藏面）；
  未读计数 / 全部已读 ack 面同步同一判据。
- 「配置档案栏」（hermes profile-switcher 视觉条）仍未移植，继续诚实置灰。
- 实测：26 行 → 选「二万人」→ 1 行（二万人 · Bot Chat）→ 全部 → 26 行。
- 门禁：vitest **1108**（90 文件）/ tsc 非镜像区 0 错。

**✅ 2026-11-21：Tauri alpha.6 + 引擎 0.27.0 同步 + PR 重提（用户："仓库更新了，更新一下tauri3和rpi，然后重新pr"）**

- **Tauri 3 → alpha.6**（tauri/wry alpha.6、build/dialog alpha.4、npm api alpha.3
  / cli alpha.6）：宿主用面零 API 变化，一次编译过。
- **rpi 引擎 0.24.0 → 0.27.0**（59f985a）：镜像真实基线 = v0.24.0（27 文件
  补丁）；已上游化的跳过（#333/#348/#355），真重放 = os_env execution_env
  （431 行，上游零变化 → 直拷）+ 工具描述路由（read/grep/ls/find 直拷 +
  bash/powershell 合并）+ BUILTIN_TOOL_NAMES 8 项（session.rs 3-way）+
  bash_windows_shell.rs 测试拷入；streaming.rs 的 MIRACH_OPEN_TIMING 诊断
  插桩有意丢弃（上游 #368/#394 重写了该文件）。**3-way 合并必须先统一行尾**
  （CRLF/LF 不归一 → 整文件假冲突、双倍拼接垃圾；冲突标记带 label，
  数冲突用 `/^<{7}/m`）。宿主消费面 **0.24→0.27 零 API 断裂**（cargo 727
  一次过）。旧镜像保留 `G:\pi-rust-main.old-0.24`。
- **vendored goal 对 SDK 0.27 重编译**：61 测试全过，DLL 已装（改名替换法）。
- **实机三件同验 ✓**：job list / get_state / 47 会话 / goal v2 / `/jobs`
  守卫探针全通；goal 武装无假目标（arm 回执核验生效）。
- **PR 已重提到新仓**：**rpi-extension #19**（/jobs 命令面）+ **#20**（goal
  完成校验窄版）——新仓是 rpi-package 的迁移归宿（full workspace import，
  crates.io 发布方），**不含**我们的两个改动（核实过）；分支
  `feat/background-jobs-command`（f2c3abf）/ `feat/goal-verify-verdicts`
  （733e172）在 fork HQZ1111/rpi-extension 上，基于其 main 607c00d 单提交
  构建（git 直连断续 → 走 Git Data API）。**vendored 插件今后同步来源 =
  rpi-extension**。
- 门禁：cargo 727 ✓ / vitest 1106 ✓ / tsc 1319（唯一非镜像错 =
  transcript-paging.ts TRIM_HISTORY——并行会话 WIP，非本轮改动）。

**⚠️ 上游仓库迁移（2026-11-20）——已由上条收口**：rpi-package（extensions 仓）**正在
迁移，新仓库后续公开**。维护者 DavidHinton-xcpc 11:17 同时关闭我们最后两个
PR：**#362**（goal 完成校验窄版）与 **#363**（`/jobs` 命令面），原文"相关
改动会在新仓库继续推进，因此先关闭此 PR"，且都单独致谢了改动内容——**挂起
等迁移，不是否决**。新仓 = **`pi-rust/rpi-extension`**（公开但 0 提交，
git 操作 409），等 README/内容落地再往那重提；rpi-package 仍在正常收
web/server/mcp 的维护者 PR。分支留在 fork（`feat/goal-verify-verdicts`
3916920、`feat/background-jobs-command` 685798d）可直接复用；**新仓落地前
别再往旧仓提 PR**；vendored 插件同步也要认新仓。引擎仓
bigfish1913/pi-rust 不受影响（#348/#355 已合并）。

**✅ 2026-11-20：状态面板功能全对齐轮（终端分区验证 + 引擎 PR #363 + workflow Stop + composer 徽标）**

- **终端分区实机全链 ✓**：真后台作业（模型调 background 工具）→ 分区渲染
  （折叠头/展开行/停止钮，与上游同构）→ 停止真取消。抓到真缺陷：**停止后
  快照不落盘**（pi_job_list 永报 running）→ 引擎修 = rpi-background-tasks 加
  `/jobs` 命令面（守卫 = 当前会话最新快照成员资格，零引擎改动），已提
  **pi-rust/rpi-package #363**；新 DLL 已装机（改名替换法；备份
  `.official.bak`），实机守卫探针确认生效。
- **workflow Stop**：宿主 WorkflowRunRow 加悬停显形停止钮（上游
  WorkflowRunStopButton 形态）→ `pi_interrupt`（引擎 per-call 取消链可达：
  abort → `(cancel_fn)` → Control → 杀进程组 + pending 恢复）。无引擎 PR——
  orchestrator 会话级 stop 需要命令信封 host context，待引擎同步后评估。
- **composer 徽标**：`conversation-background-work-trigger.tsx` +
  `composer-status-badge.tsx`（计数与面板同一份真值；点击 = 唯一 run 直达
  详情 / 展开非空分区 + panel 形态）；面板工作流分区改受控
  （hasLiveWorkflowRun 翻转写入），expandRequest 走 status-panel-store。
- **GitActionRow 无需动**：2026-11-17 已实现（此前记录过时）。
- 门禁：tsc 1319（非镜像区 0）/ vitest **1093** / cargo **726**。
- 待实机：徽标与 workflow Stop 渲染（需真实 workflow/后台作业会话）；
  终端 UI 停止在新 DLL 下的快照落盘（链路已被单测钉死）。

**引擎同步候选（2026-11-19 量化，未执行——专项一轮再做）**：`G:\pi-rust-main`
（引擎真源，非 git 树）落后 bigfish1913/pi-rust main `b0ac963 → 3e48b03`
**21 个提交**：0.26.0 release prep(#373)、SDK 安全化 **#375**（ABI 字符串
移出插件 unsafe 块）与 **#378**（`take_step!` 免调用方 unsafe）、goal parity
#367、session-tree 生命周期事件、编辑器草稿/completion parity(#366/#338)、
LaTeX 渲染(#362)、transcript replay 性能(#368) + 我们已合并的 #348/#355/#376。
树差 = **78 个文件**，仅 `rpi-cli/src/session.rs` 就 **+743/-151**。
**为什么不能热替换**：① 镜像带着用户本地补丁（execution_env /
after_tool_call，未上游化）——同步必须重放；② vendored
`G:\mirach-plugins\rpi-goal` 按 SDK 0.24 编译（unsafe wrapper 是为 0.24 的
StbString），0.26 后编译面要重对（机会：#375/#378 落地后 unsafe wrapper 可
整体删掉）；③ 全量 cargo 重编译 + DLL 重装 + 宿主门禁 + E2E；④ 工作树多会话
共享。**建议步骤**：干净 clone 上上游 main → 重放本地补丁 → 换路径依赖 →
vendored 插件重编译（先验 #375/#378 的 safe 宏）→ cargo build -j 1（16GB
机器，规矩 12）→ 三面门禁 → goal/审批/租约 E2E 复测。

**✅ 2026-11-19（晚）：打开/切换会话性能第二轮（hermes 视图窗 + 引擎缓存 + 轮询去重）**

- **用户症状**：打开会话慢、切换长会话更慢、bot 切换也慢（"切换会话不卡顿"）。
- **分层实测（改前，11MB/2036 条巨会话 01a1df20）**：`pi_get_messages` 冷
  3.9s/热 1.4s（7.8MB 载荷）；`pi_get_timeline_markers` 0.9s；`pi_get_state`
  0.35s；`pi_list_sessions` **4.1s（每次 run 收尾都全量重放 39 个会话文件）**。
  前端 hydrate 转换仅 2ms——瓶颈全在引擎重复重放与 IPC 载荷。
- **修复一（前端渲染窗，hermes render-weight 移植）**：
  `render-weight.ts` + `transcript-window.ts`（纯函数 + 9 单测）——
  FIRST_PAINT=20 → FULL=600 分步、按轮累计不切开、`显示更早`/滚顶展开；
  接线 `thread.aui.tsx::MessageTurnList`（切会话复位预算）。巨会话 DOM 只挂
  尾部 18 轮（原来 200+ 全挂）。
- **修复二（Rust 派生面缓存，`pi_session.rs`）**：messages / markers 按
  `(path,len,mtime,leaf)` 缓存（leaf 入键防分支切换串数据）；`list_sessions`
  逐文件事实缓存 + header 改只读首行；`snapshot_stats` stat 缓存。
  实测热路径：list_sessions 4137→**4ms**、state 352→**4ms**、
  markers 955→**5ms**、get_messages 1661→**601ms**（余量是 7.8MB IPC 本身）。
- **修复三（每秒 ~100ms 主线程尖峰，空转也有）**：审批/提问桥每秒轮询**无条件
  setState 新数组** → 侧栏会话树每秒整棵同步重渲染（侧栏 rows/对话框/选项
  菜单全在，DOM 零变更）。修复 = 两桥结构相等去重 + 侧栏布尔订阅
  (`pending.length > 0`) + `ITEM_COMPONENTS` 常量提升 + 行 memo/计数订阅。
  修复后空转 6s **longtask 归零**。
- **端到端复测**：巨会话切换首轮 DOM 2.9s、总阻塞 1.9s（改前 3.6s+）、
  只渲染尾部 18 轮；普通会话回到引擎地板（热 40-600ms）。
- **遗留（已在本轮补齐）**：hermes 的后端 tail 分页——见下条「尾页水合完全对齐」。
- 门禁：vitest 1084（87 文件）/ cargo test 724 / tsc 非镜像区 0 错。

**✅ 2026-11-19（晚续）：尾页水合完全对齐 hermes（后端分页 IPC 落地）**

- `pi_get_messages_page(before?, limit=256)` → 引擎 `SessionTree::transcript_page`
  有界读；**轮边界回退**：页首非 user 时回看最多 2 页并把「最后一条 user 起」的
  后缀并入，防止一页切在轮中间（孤儿 toolResult = 丢工具卡）。
- 前端 `transcript-paging.ts`：`hydrateTranscriptTail(actor, sessionId)` 统一
  水合入口（7 处调用点）+ `PREPEND_HISTORY` 补页 + `ensureFullTranscript()`
  给导出 Markdown 等显式全量面；行 key = 原始条目 id；时间线标记带
  `beforeMessageIndexFromEnd` 做尾部相对落桶；自动命名在历史截断时跳过。
- 实测（巨会话 11MB / 2041 条）：首屏尾页实取 303 条 **333ms**（改前全量
  1445ms）；再补页 606ms（283 条）；UI 全链 DOM 6→17→18 轮、console 零错误。
  `pi_sessions_index` 共用事实缓存 **7.7s → 71ms**；bot 行打开 69ms。
  - `pi_peek_session_tail(path, limit)`：**不打开引擎**的尾部预览（JSONL 尾读 +
  父链回溯 + 轮首裁剪），与 `pi_open_session` 并行；peek 先回就先画尾部，引擎
  就绪后再走 `hydrateTranscriptTail` 对齐。巨会话点行首屏 **557ms**（原 ~5s），
  peek 64ms；`activeId` 守卫防连点串会话。
冷开 = 引擎 replay 地板（0.5MB 362ms / 0.8MB 791ms / 11MB ~4.9s，热开 3~6ms）。
- bot「没切换」根因：插件 canonical chat 按 (profile,"Bot Chat") 解析，
  单命名空间下全 bot 同名互窜（5 个 Bot Chat 会话实测）；特性级修复另立轮。- **release 实测**：引擎 replay 295ms（debug 3.0s = 10× 膨胀）——引擎不是瓶颈。- bot 页签 per-bot 标题：页签 = `显示名 · Bot Chat`（会话真名不动，registry
  匹配不受影响）；更正"锚交叉"误判（ULID 截断伪影——两 bot 各有自己的
  Bot Chat，插件花名册切换本来就是通的）。- 引擎 replay 根因（load_streaming 分段计时）：sha 506ms + apply 628ms +
  行内 ~630ms（parse 仅 38ms——serde 非瓶颈）；诊断已留在引擎 streaming.rs。- 切换点击遍历（dev/StrictMode）：零错误、落点全对；首内容 ~1s、单帧 ≤420ms；
  补齐改每帧 +48（1-2 轮）+ 消息组件 memo 后预算步无整列表重渲。- 打开耗时拆分：纯存储重放 3.0s（引擎地板，--ignored 单测可复测）+ 装配 ~1.4s；
  装配期间 composer 上方显示「正在准备会话（引擎载入中）…」。- 发送等待：postRun 先 await 在途 `pi_open_session`（peek 先画但 prompt 必须
  打在对的会话上）；bot 切换经 `session-preview-bridge` 同享预览（双锚/activeId/
  已水合三重守卫）。实测：巨会话点行首屏 **259ms**；bot「风格和」797ms 出 7 轮，零错误。
- transcript retention（同日补齐）：滚离顶部释放最老历史页（留最近 3 页，再上滚重读）。
- 设置窗预热：setup 后台构建隐藏设置窗 + 前端 ✕ 改 hide 复用实例——首开 1178ms → 21ms。


**✅ 2026-11-20：多会话并列窗格真实现（hermes `_sessions` 模型）+ 语音 402 诊断**

- **并列窗格能并行收发了**（此前 `side_*` 是恒 Err 占位，非活动窗格一发送
  就报 "rpi 非 main lane 只读"）。根因澄清：rpi 引擎允许多会话（每次 build
  独立 HarnessLive），限制在宿主单柄假设。落地（全 Rust，前端协议零改动）：
  `EngineShared.side` 窗格表（thread key → 独立句柄）+ `side_open/prompt/
  interrupt/lane_busy/close` 全真 + `live/side/retired` 三表兜住单写者
  （同会话不双开；切前台从 side 表上台复用；窗格在场会话拒删）。
  `prompt_inner` 抽 `run_prompt_on` 前台/窗格共用。实机 E2E：主柄 B 与
  窗格 A 同时 POST 各自收全回复、`pi_interrupt(thread=A)` 只停窗格、
  上台复用历史连续。**已知边界**：窗格 ask/审批卡不渲染（后端注册表只扫
  前台邮箱）——对齐 hermes tile 需按 thread 分桶，单独一轮。
- **语音 402 = MOSS 账户余额不足，非宿主 bug**：raw 握手对比，真 key →
  402 `insufficient_credits`，伪 key/无 key → 403 permission_error——端点/
  协议/key 全正常，积分用完（11-15 时还有免费额度）。处置 = 平台充值/换
  key（设置 → 语音）。顺带修：`pi_voice_moss.rs` 握手错误附 vendor body
  （`describe_handshake_error`），红显变为 `…402（insufficient_credits:
  billing error）`；单测锁体。
- 门禁：cargo test **726** / vitest **1090**（88 文件）；E2E 脚本
  `E:\Temp\peer-tabs-e2e.mjs`（TABS_OK）。

**✅ 2026-11-19（下午）：侧栏会话切换性能（hermes 对偶）+ 系统托盘 ZCode 对齐**

- **侧栏切换**（内置 agent 完成，本仓核验提交）：`runtime.tsx` 三处——同会话短路
  （点已在看的行不再重建 harness/全量水合）、乐观高亮（点行立即切选中态，不等
  `pi_open_session` 往返；失败回滚选中态 + 红条）、`refreshThreads` 不再阻塞切换。
  `thread-list.aui.tsx`——`rowMetaCache`（WeakMap 按 item 引用缓存行投影，未变行
  保持同引用让下游 memo 命中）+ 删重复的 `prune` 三连调用。
- **系统托盘**（照 ZCode `desktopTray.ts` 完整对齐）：左键/双击 = 显示主窗；✕ =
  隐藏到托盘（`closeToTray` 偏好，关 = 真退出）；右键菜单 = 打开 / 新建任务 /
  打开工作区 / 关于 / 退出。新建任务经 `mirach:tray:new-task` → 段头「新建会话」
  通道；打开工作区经 `mirach:tray:open-workspace` → 文件夹对话框 →
  `requestCreate`（composer 工作区同一请求桥）；关于 → 设置窗「版本与更新」节。
  ZCode 的「检查更新/导出日志」宿主无对等面，不渲染。前端桥 =
  `components/layout/tray-bridge.tsx`。**此前的"✕ 藏起来回不来"陷阱就此消解**
  （托盘左键/菜单即恢复入口）。
- 门禁：cargo test 724 / vitest 1073（86 文件）/ tsc 非镜像区 0 错；实机 exe
  启动 10s 存活（托盘创建无 panic）。

**✅ 2026-11-19：hermes peer lending wire 路由层（WS 方法分派 + `/v1/runs`）**

- grant 基础层（HMAC 签发/校验/scope/fingerprint/execution policy digest）已在前一轮落地；本轮在其上补齐对端可调用面，让 hermes Desktop/网关能把 mirach 当 peer lender。
- **WS `/api/ws?token=`**（axum）：accept 首帧 `gateway.ready`（含 `room_link.catalog`，`change_events:true`）。方法面 = lender（`gateway.ping` / `profiles.list` / `groups.capabilities` / `groups.peer.invite` / `groups.peer.revoke`）+ home（`groups.peer.register` 带 live probe、`groups.list/state/log/create/send/stop/continue/retry/discard/driver_append` 走 `pi_groups::rpc_dispatch`；`groups.state` 带 `driver_status.peer_routes`）+ 会话（`session.create/resume/list/interrupt/compress`、`prompt.submit` → bot 泳道）；未知方法 `-32601`。`groups.*` 变更成功后向所有 peer WS 扇出 `groups.changed`（`broadcast_id` = 进程代际 + 计数器）。
- **HTTP（peer 服务同端口，全量）**：`GET /v1/room-members/capabilities`、`POST /v1/room-members/invitations`（201）、`POST /v1/room-members/grants/refresh`、`POST /v1/room-members/grants/revoke`（空体幂等）、`POST /v1/room-members/runs/close`；`POST /v1/runs`（grant 幂等 admission 202；无 grant 走 Bearer 宿主令牌的 API-key 普通 runs，房间字段缺 grant → 403 `room_grant_required`）、`GET /v1/runs/{id}`（含 `waiting_for_approval`）、`GET /v1/runs/{id}/events`（SSE，`id:` 序号 + `run.status`/终局 `run.<status>`）、`POST /v1/runs/{id}/stop`、`/approval`（仅 `once`/`deny`）、`/clarify`、`/steer`、`/resolve-unknown`。
- **台账**：`src-tauri/src/hosted_rooms/grants.rs`（撤销围栏 + target reservation 判定，复用 P1 已建的第 4 层表）＋ `src-tauri/src/pi_peer_runs.rs`（运行记录 / 房间↔隐藏泳道映射，独立 `peer-runs.db`）。
- **成员轮次**：`/v1/runs` 的 prompt 进 bot 泳道（`Group: <room_id>`）；`pi_bot_state` 新增 `last_status` / `last_output`，monitor 写回 durable 状态；stop → `pi_bot_interrupt`，steer → `harness.steer`，approval → `pi_bot_approval_respond`，clarify → `pi_bot_answer_clarify`。
- **实测（实机 app）**：WS ready/capabilities/invite/revoke/session.create/prompt.submit/session.resume/session.list(33)/groups.list(3) 全通；HTTP invitations 201、revoke 后 403、`/v1/runs` 202 → steer accepted → `completed`；API-key runs 202 → SSE `run.status`→`run.completed` → 真模型 `二加二等于四。`；WS session 真模型 `三加三等于六。`；未知方法 `-32601`。门禁：cargo check / cargo test 724 / vitest 1082 全绿。
- **与上游的差异（有因，非裁剪）**：`driver:false` + `persistent_process:false`（桌面进程 + 驱动在本仓前端）；`profiles.list` 单行；SSE 事件按 durable 状态迁移生成；`resolve-unknown` 用本宿主 run_id 作 admission_id。
- **全链对账轮（同日续）**：E2E 按 hermes 客户端语义逐条走——`peerTargetState` 准入检查 → WS `groups.peer.invite`（ttl=86400 + status_ttl=30d 的 seatPeer 边界值）→ `groups.peer.register` live probe 回执 → `/v1/runs` {input,hosted_room_dispatch} + `Idempotency-Key: room:{task}:{gen}` 重放/换体 409 → 轮询终局读 `output`（真模型 3+4=7、5+6=11）→ `grants/refresh` 替换 grant 探活 → `stop`（空体）stopping→cancelled → lender `groups.peer.revoke` → 再派发 403 `room_reauthorization_required`。实机全绿（脚本在仓库外：`E:\Temp\peer-hermes-wire-e2e.mjs`）。当场抓到的三个真缺陷（已修）：
  1. `pi_gateway_peer.rs` 的 `MAX_STATUS_GRANT_TTL_SECONDS` **少乘一个 60**（12h vs 上游 30d）→ 带 horizon 的 invite 直接 `room grant lifetime is invalid`；补单测 `invitation_honors_full_status_horizon` 锁 30d 边界。
  2. `groups.peer.register` 回执 `mode` 由 "desktop" 改回上游 link mode **"direct"**；probe 的 `home_install_id` 校验按上游口径对齐**本机 authority id**。
  3. **冷启动假 `interrupted`**：monitor / `resolve_run_status` 曾以「bot 泳道此刻非 running」当终局/重启证据——首条 dispatch 现建会话的窗口里 running=false，轮次被误收口。修 = `pi_bot.rs` 增 `last_turn_seq` 终局计数（与 running/last_status 同临界区）、`pi_peer.rs` monitor 只在 seq 前进时收口（30 分钟上限如实 failed）+ 进程内活跃 run 注册表（只有不在表内才判真重启残留），`stop` 同样按此收口。
  - 如实口径：lender catalog 的 `persistent_process:false` 与上游「Desktop 管理的网关」一致（`catalog_mapping` 在 `HERMES_DESKTOP=1` 时恒 false，即 hermes 要求 lender 是 `hermes serve` 常驻进程）→ 真 hermes Desktop 会以 `persistent_process_required` 拒 seat；wire 面本身已证全通，mirach↔mirach 原生面不受此限。
  - 门禁：cargo test **725** / vitest 1084（87 文件）/ tsc 非镜像区 0 新错。

**✅ 2026-11-18（第五波）：状态面板剩余缺口——目标迭代行 + 完成校验（状态机进 rpi-goal 插件）+ 工作流分区（orchestrator 派生）**

- **rpi-goal vendored fork（用户定稿"Rpi 有 goal，直接在它上面做"）**：
  `G:\mirach-plugins\rpi-goal`（基线 = `pi-rust/rpi-package` main @ 6144715，
  与上游源码逐字一致，仅本地 SDK 0.24 的 6 个新 slot 差异另计），已编译替换
  `~/.rpi/agent/extensions/rpi_goal.dll`（官方原件备份 `.official-0.2.5.bak`）。
  fork 新增：`Goal.iterations[]`（每次 run 收尾的 todo 快照）/
  `verifications[]`（`{iteration,outcome,at,reason?,nextAction?}`）/
  `verify_iteration`；状态词表扩成 ZCode 六态 `active|paused|verifying|verified|failed`
  （旧 `complete` 读兼容）。**`complete` 语义改为「终态但仍在场」(verified)，归档改由
  `/goal stop` 承担**——否则已完成目标会从面板消失（上游是 status=complete 仍在场）。
  fork 改动已向上游提 PR **pi-rust/rpi-package #336**。
  **上游裁定（2026-11-19）**：#336 关闭为 superseded——布局基于 0.2.5 单体、
  大部分面 #343/#346 已有、状态词表改动过大；维护者给窄版规格（七态不动 /
  verdict 只记录 / 既有 worker 派发 nextAction）。已按规格新开
  **#362**（feat(goal): host-recorded completion verdicts，本地克隆
  `E:\Temp\rpi-package-pr`）。**宿主 vendored fork 不跟随窄版**：宽版
  （verifying/verified 词表 + 宿主裁判驱动）E2E 已验、继续在用；若上游收
  窄版，同步策略再定。
- **宿主 = 触发 + 模型裁判**（`src-tauri/src/pi_goal_verify.rs`）：常驻订阅每个在场
  会话的 `AgentEnd`（run 收尾）→ 闸门（当前会话 / goal `active` / 后台作业不在跑 /
  单槽在途）→ 读 todo 快照 → `/goal _verify-start {"items":[…]}`（插件开下一轮迭代 +
  `verifying`）→ 宿主克隆的 `RuntimeActionHost::side_question` 跑无工具单轮裁判
  （64KB 文本摘录；工具输入/结果不进摘录，所以问句里带同一份 todo 快照）→
  `/goal _verify-result {"outcome":…,"reason":…,"nextAction":…}`。坏 JSON fail-open 成
  `pass` + reason（上游语义）；请求失败/超时 = `cancelled` → paused；会话上台时若 goal
  仍 `verifying` 且本进程无在途校验 → 补发 `cancelled` 收口（孤儿修复）。
  **续跑在插件侧**：`notSatisfied` + `nextAction` → 插件用 `SendMessage(display:false)`
  （model-only，不进 UI）驱动下一轮，预算耗尽则不续——与上游 validator 回路同形。
  **架构事实**：rpi 的模型原语（action 24/25）只挂在 invocation bridge 上，插件的
  `on_turn_end` 拿不到——所以裁判模型调用在宿主、状态机在插件，各归其位。
  （旁路监听插件 `rpi-goal-iterations` 已退役、DLL 卸载，源码留存仅作参考。）
  面板 GoalStatusSection = ZCode 迭代行结构（`buildConversationGoalIterationSummaries`
  逐条照抄）+ 结论徽章；在途行 spinner = status `verifying`。
  **实机**（插件驱动全回路）：`/goal start 用一句话回答 1+1 等于几` + 用户消息 →
  `verifying` → `verified`，`verifications:[{n:1,outcome:"pass"}]`；另一条不可达目标
  （CPU 降到 20°C）→ `notSatisfied` + 真 nextAction → **自动续跑第二轮**（用户未输入，
  turnsUsed 1→2）→ 再判 notSatisfied，turns 4/4 预算耗尽 → paused。
- **工作流分区（宿主派生）**：`status-workflow-runs.ts` 从本线程 `plan` /
  `dispatch` 工具调用派生（`details.nodes` 真形状：id/task/deps/status ∈
  pending/running/done/failed/skipped）；plan set = 一条 run，dispatch 波更新
  同图；pending/running 进分区，全 settled 进「已结束的工作流」页脚；图快照
  缺席不造 0/0；被新 plan 替换且未收敛的旧图 console.warn 后丢弃。
  UI 照抄上游 `WorkflowStatusSection` / `WorkflowRunRow`（Stop 不渲染——
  orchestrator 无取消面）；行/页脚开 `workflow-run:<runId>` /
  `workflow-directory` 面板栏标签（`workflow-run-detail-pane.tsx`）。
  实机：真模型 plan(set) 两节点 → 面板「工作流 1 个运行中」+ 真行；
  真 dispatch 结果含 `details.nodes`，与派生规则一致。
- **门禁**：vitest **1073**（86 文件）/ 宿主 cargo test **702** / tsc 0 新错
  （hermes-mirror + sdk-upstream 既有基线不变）；fork `cargo test --release` **31**
  条（干净上游克隆同验）。
- **工作流分区（宿主派生）**：`status-workflow-runs.ts` 从本线程 `plan` /
  `dispatch` 工具调用派生（`details.nodes` 真形状：id/task/deps/status ∈
  pending/running/done/failed/skipped）；plan set = 一条 run，dispatch 波更新
  同图；pending/running 进分区，全 settled 进「已结束的工作流」页脚；图快照
  缺席不造 0/0；被新 plan 替换且未收敛的旧图 console.warn 后丢弃。
  UI 照抄上游 `WorkflowStatusSection` / `WorkflowRunRow`（Stop 不渲染——
  orchestrator 无取消面）；行/页脚开 `workflow-run:<runId>` /
  `workflow-directory` 面板栏标签（`workflow-run-detail-pane.tsx`）。
  实机：真模型 plan(set) 两节点 → 面板「工作流 1 个运行中」+ 真行；
  真 dispatch 结果含 `details.nodes`，与派生规则一致。
- **门禁**：vitest **1073**（86 文件）/ cargo test **702** / tsc 0 新错
  （hermes-mirror + sdk-upstream 既有基线不变）。

**✅ 2026-11-18（第四波）：bots 剩余未接面收口——远端 token / image.generate / pet 画廊 + keyring 真后端修复**

- **远端连接 token 管理已接**（`pi_connections.rs` + `pi_gateway.rs` + 连接页）：
  token 进 OS 凭据管理器（service `mirach.connections`，entry = 连接 id）；
  注册表 JSON 只存派生 `tokenSet/tokenPreview`（每次读取从 keyring 重算）；
  `pi_connections_save.token` 只写不读（空串 = 清除；删除连接同步删 entry）；
  连接页有密码输入/清除钮/`token ...123456` 徽章（preview = hermes
  `tokenPreview` 同款：≤8 → "set"，否则末 6 位）；`pi_gateway_connect` 的
  token=null 时 **Rust 侧取 keyring**——token 永不进前端；`pi_connections_test`
  对 remote/cloud **变真**：一次性 WS 等 `gateway.ready`（8s），失败红显真错误；
  ssh 无隧道仍 stub 红显。**实机（CDP）**：存 token → tokenSet true /
  preview `...123456` → 测试真连（连接被拒 = 真网络错误）→ 删除无残留。
- **修大坑：keyring 3 没有默认特性**——裸 `keyring = "3"` 退化成进程内 mock
  store（set 静默不落盘、get 恒 NoEntry）→ **pi_vault 此前一直是假成功**。
  改 `keyring = { version = "3", features = ["windows-native"] }`；实机
  vault add → reveal（真 secret 回读）→ remove 全通。
- **image.generate 真后端**（`src-tauri/src/pi_image.rs`）：OpenAI 兼容
  `{base}/images/generations`；provider = `settings.image.provider` >
  `default_provider` > models.json 首个有凭据者；key = models.json apiKey
  （字面量 / `env:` / 裸环境变量）→ auth.json → provider env；probe =
  GET `{base}/models` 真找图像模型（无 → `available:false`，插件隐藏入口）；
  `settings.image.model` 可覆盖；失败走契约 `error`。实机 probe：DS provider
  无图像模型 → `{available:false, error:"provider 的模型目录里没有图像模型"}`。
- **pet.gallery / pet.thumb**（`src-tauri/src/pi_pet.rs`）：petdex 公共
  manifest（UA 同上游，300s 缓存；installed 读 `~/.rpi/agent/pets`）；
  thumb = 已装 sheet 优先、否则仅 petdex.dev 主机 URL（上游 `_is_petdex_host`
  同款反 SSRF），裁首帧 192×208 → 96×104 NEAREST → PNG data URI +
  `pets/.thumbs/<slug>.png` 缓存。实机：gallery **5208 只**；thumb
  `homelander` → 20KB PNG data URI（webp 解码经 image crate `webp` feature）。
- **peer 房间 Desktop 驱动模式全通（同日续）**：authority 侧
  `groups.peer.register/revoke` 真落地（pinned catalog 校验 + `room-links.json`
  持久化；并发 seat 用进程内串行锁 + 唯一 tmp——实测踩中固定 `.tmp` 冲突导致
  第二个成员 `registration_unconfirmed`）；canonical driver 对 peer 成员按
  profile 解析 remote 路由，session.create/resume/prompt.submit/interrupt 全走
  对端 WS（宿主私有字段 `room_plumbing/task_meta` 剥离）；roster 行补
  `sourceScoped/remoteSource/installId/route`（插件 `usePeerTargets` 才能
  ready）；peer actor 带 `connection_id`。**实机（mock 网关，走 hermes 插件
  自身 `createGroupAcrossConnections` + `seatPeer`）**：1 本机 + 2 远端成员
  建房 → unjoined=[] → 本机真模型回复 + 两名远端成员均回复
  （actor.connection_id=mock-install-1）→ 4 turn.settled → room.activity
  settled（silent_round）。
- **peer lending 侧（本机被借出）已接（2026-11-19）**：`pi_peer.rs` 原生
  HTTP 服务（127.0.0.1:9731，Bearer 配对令牌走 OS 凭据管理器
  `mirach.peer/token`，首次启动生成）——对端 mirach 用 URL + 令牌接入后，
  canonical driver 的 remote 路由经 `pi_peer_call` 走对端
  `session.create/resume/prompt.submit/interrupt/compact`。`pi_gateway_call`
  对已登记 peer 连接自动改走 peer HTTP 面（host.ts `remoteInvoke` 自动探测
  并记住）；连接页「本机 Peer 服务」块展示 URL + 令牌（复制给对端）。
  实机（mock peer + 真 canonical driver）：1 本机 + 1 远端 mirach 成员建房 →
  本机真模型回复 + 远端 peer bot 经 peer HTTP 回复 → 双 turn.settled →
  settled。**限制（如实）**：hermes 网关 wire 不兼容（`groups.peer.invite`
  WS 方法 + `/v1/room-members/*` HTTP 路由是 hermes 网关 HTTP 服务端，
  宿主没有）；对端必须也是 mirach。
- **SSH 隧道已接（2026-11-19）**：`pi_ssh.rs` —— 注册表 ssh 条目加
  `gatewayPort`（缺省 = hermes api_server 默认 8642）；`pi_ssh_tunnel_start`
  起 `ssh -N -L` 子进程（`BatchMode=yes` + `ExitOnForwardFailure=yes`），
  等本地端口就绪返回隧道 URL；`pi_gateway_connect` 对 url 为空的 SSH 连接
  自动起隧道 + WS 走本地端口；`pi_connections_test` 对 ssh 变真（隧道 +
  gateway.ready 探测）；连接页 ssh 编辑器加网关端口字段；`RunEvent::Exit`
  时 `stop_all()` kill 全部子进程。**限制（如实）**：密钥需在 agent
  （`BatchMode=yes` 不弹交互）；hermes SSH 模式是 1197 行完整远端 backend
  管理，宿主只做了端口转发这一层。
- **per-bot MCP 已接**：bots 对话框 MCP 页 = 全局 `mcp.json` 服务器多选；
  启动 `pi_bot_mcp_config` 只过滤所选服务器生成
  `~/.rpi/agent/bot-mcp/<bot>.json`，`configPath` 注入 system prompt
  （rpi-mcp-adapter 的 `mcp_list/mcp_call/mcp_resource` 本就按 `configPath`
  读配置——真生效）。**限制（如实）**：不选 = 不注入；adapter 四个 MCP 工具
  是进程级注册，无 per-session 遮蔽面（"不选"不能从工具层阻断）。
- **session.reclaimed 有生产者**：`pi_delete_session` 成功后按 path 在索引
  定位 stored id → emit `mirach:plugin:session:reclaimed`
  （`{stored_session_id, path, reason:"deleted"}`）；插件监听器据此刷新打开
  的 bot canonical chat。
- **结构性未做（如实）**：peer 的 **lending 侧**（本机对外 RoomLink HTTP
  服务端 + `groups.peer.invite`——host 无对外监听，invite 明确报错）、
  ssh 隧道（用 remote 指向已转发端口）。
- **主栏标签条 auto 显隐修复**：g-chat 组构造期 `hideHeader:true` 会让后加入的
  标签（房间 / 屏幕 / 预览 / 文件）**既切换不到也关不掉**（用户实测：打开机器人
  屏幕后无法关闭）。`dockview-shell.tsx::syncChatGroupStrip` 在 onReady +
  add/remove/layout 事件后按面板数重算：仅 `workspace`/`open` 锚 = 无条；
  有额外标签 = 显示条（含 ✕）。实机：开探针面板 → 条 flex 且签在场；关掉 →
  条复隐。与 hermes `resolveTabStripVisible` 的 auto 规则同义。
- **门禁**：cargo check 0 / cargo test **692** / vitest **1072**（86 文件）/
  tsc 1319（= hermes-mirror + sdk-upstream 既有基线，0 新错）。

**✅ 2026-11-18：状态面板缺口收口——终端 Stop 走插件、子代理名册/Stop 走引擎（PR #355）**

- **终端 Stop（插件侧）**：vendored `rpi-background-tasks` 增 `/jobs` 斜杠命令
  （list / tail / kill），宿主 `pi_job_cancel` 转发 `run_command("/jobs",
  "kill <id>")`；面板终端行重新渲染 Stop。实机：运行中 job 点 Stop →
  快照 `cancelled`、行消失、pid 进程消失。
- **子代理名册/Stop（引擎侧，已自测 + PR）**：引擎 `ChildAgents` 增
  `roster()`/`stop(child_id)`（childId/status/turns/startedMs/finishedMs/
  role/taskPreview/error；按 id 取消，非 owner 过滤）；`RuntimeActionHost`
  默认方法 + `HarnessActionHost` 实现。宿主新 IPC `pi_child_agents` /
  `pi_child_agent_stop` + `child-agents-store.ts`，面板「智能体」分区优先
  渲染引擎名册（running 行带「停止子代理」）。实机：真模型 delegate_task
  长任务 → 名册 running → 面板 Stop → 模型收到「child cancelled by user」、
  名册行消失、子进程终止。**PR：bigfish1913/pi-rust #355**。
- 引擎门禁：`cargo test -p rpi-cli` 1197 passed（native_durable 的 2 条
  resource_fixture 构建失败在干净 upstream/main 同样复现，环境性）。
- 仍无数据面（不造假 UI）：workflow 分区、目标 verifying/迭代徽章。

**✅ 2026-11-18：状态面板让位链与 ZCode 源码对账修正（用户："对话区宽度被挤在左边，面板没出现还在左边"）**

- **根因 1**：面板组件总会挂载（无内容时 `return null`），而 `setMounted(true)`
  写在挂载即执行 → 无面板的会话也把对话列左移。修 = `panelVisible =
  activeId && hasContent` 与渲染闸门同判。
- **根因 2**：旧"钉死形态恒让位"与上游不符。核对 `ZCode-main/v4/conversationLayout.ts`：
  偏移类对 auto/inline **同一条**（`@min-[1280px]:-translate-x-42`，无断点的
  `INLINE_OFFSET` 是死代码）；内容列宽度带不带面板**同一个类**（不收窄）；e2e
  断言布局切换**零过渡**。已全部对齐（不再收窄、不再 300ms 过渡、<1280 一律不平移）。
- 判定收敛成纯函数 `resolveStatusPanelShift`（+5 单测：
  `status-panel-layout.test.ts`）；实机度量：无内容会话无 shift/无 pt-14/居中；
  胶囊态 pt 52.5px；宽容器 transform −157.5px。
- 门禁：tsc 0 新错 / vitest **1050**（85 文件）/ cargo test **678**。

**✅ 2026-11-18（第二波）：bots 完整复刻审计 + 跨网关全链打通**（用户："垮网关是bots的核心，看bots的代码有没有漏项"）

- **审计（对照 `D:\hermes-agent-main\apps\desktop\src\plugins\hermes-bots`）**：镜像 121
  文件 vs 上游 283 —— 缺的 **162 个全是 `.test.ts(x)` + LICENSE + 一个测试夹具**，
  生产文件一个不缺；真漏项在**数据面**（逐调用点审计）：多网关整块、relay 死链、
  `host.connections()` 形状 bug（恒空表）、插件侧删 bot/改描述恒失败、display 三处
  返回形状不合契约、`tool.start`/`groups.changed` 无生产者、`revealPane/undismissPane/
  navigate` 全仓无监听、notify/notifyError 不可见、`setup.runtime_check` 未接线。
- **B1（合同面，全修）**：connections 裸数组真注册表；profileRoutes 每 bot 一条 local
  路由 + 远端路由；deleteProfile 真删；`cli.exec profile describe --text` /
  `--profile <n> config unset model`；display.observe/start 展平、thumbnail
  `{data_url, suppressed}`（人持租约抑制）+ switchSandboxImage；setup.runtime_check
  （`pi_models.models`）；tool.start（pi_bot 事件泵）；groups.changed（groups_dispatch
  变更成功后广播 + `change_events:true`）；gateway.ready（boot 广播）；reveal/undismiss
  真监听；navigate `/settings?tab=gateway` → 设置窗深链 `core-connection`（Rust 带
  section 参数；常开窗走 `mirach:settings:section` 事件）；notify/notifyError →
  **ToastHost**（beui AnimatedToastStack + `mirach:toast` 事件桥，挂应用根）。
- **B2+B4（跨网关，本轮核）**：`pi_relay.rs`（hermes `tools/bot_relay.py` 对偶：
  `~/.rpi/agent/bot_relay/` 持久仓 outbox/claimed/replies/**receipts**/roster.json；
  四门 + TTL 900s→`queued_expired` + claimed 未回执重投 + 先写者胜 reply；6 单测）+
  `pi_gateway.rs`（**JSON-RPC 2.0 over WS `/api/ws`**，hermes 桌面端同款：ready/ping/
  事件推送/服务端请求答 -32601/2^n 重连；URL 归一化 + 帧解析 2 单测）+ host.ts
  `requestProfile` 远端分支 + agents/profileRoutes 远端并集（30s 缓存、瞬时失败沿用
  旧值）+ engine-bridges 远端目标 `pi_relay_enqueue` + `bot_relay.reply` waiter 唤醒。
  **两个实测缺陷（已修）**：① Rust 事件名 `…bot_relay:outbox.pending` 与前端监听
  `…bot_relay:outbox:pending` 差一个"点变冒号"（push drain 永不触发）；② deliver 回执
  缺 `admission_id` → Desktop 判"身份不可用"保留重投（目标实测重复 13 轮）+ 回执只认
  claimed → 远端来件存不进。修 = `admission_id`（未准入带 `refused:true`）+ 回执独立
  `receipts/<id>.json`。
- **双向 E2E（mock 网关，无依赖手写 RFC6455）**：远端→本机（envelope → drain → 本机
  bot 真模型轮次 → receipts settled → `bot_relay.reply` 写回 mock）✓；本机→远端
  （message_agent queued+delivery_id → Desktop 投给 mock 的 `bot_relay.deliver` →
  回执 → replies 落盘 → **waiter 把回信送进发送者会话** → 发送者再回复）✓。
- **门禁**：tsc 0 新错（1319 镜像基线）/ vitest **1050**（85 文件）/ cargo test **678** /
  cargo check 0。
- **仍未接**：远端连接 token 管理 UI（keyring 录入；当前只能无 token 连回环/--insecure）；
  **跨网关 peer 房间**（groups.peer.* + RoomLink HTTP——transport 已铺好，等待实现）；
  pet.thumb/gallery；image.generate；per-bot MCP 勾选（引擎 mcp.json 全局）；
  session.reclaimed 无生产者。

**✅ 2026-11-18：状态面板缺口「用插件补」——rpi-background-tasks 就地补齐 + 实机 E2E 通**。

- 上游调查（`pi-rust/rpi-package` main）：**只有** `rpi-background-tasks` 有源码
  （`background`/`jobs` 工具 + `background-tasks` 会话快照；无 release tag、本机未装）；
  目标迭代验证、workflow 分区、子代理名册/Stop/子会话**没有**可移植的插件面
  （`rpi-goal` 无 verify/iteration；`rpi-orchestrator` DAG 只在进程内存；
  `ChildAgents` 是 `pub(crate)`），这三项保持如实不渲染。
- 插件落点：vendor 到 `G:\mirach-plugins\rpi-background-tasks`（独立 crate，path 依赖
  `G:/pi-rust-main/crates/rpi-plugin-sdk`），`cargo build --release` → 复制到
  `~/.rpi/agent/extensions/rpi_background_tasks.dll`（**应用运行时会锁住 dll，换版本须先退出应用**）。
- **本地适配**：上游 shell 解析漏了「`where git.exe` 反推安装根（自定义盘）」，本机 Git 在
  `D:\Git` → 落到 System32 的 WSL 存根（exit 1 + UTF-16 乱码）。已按宿主
  `rpi-tools::os_env` 顺序补齐 + 排除 WSL；实测命中 `D:\Git\bin\bash.exe`。
- 宿主：`pi_plugin_state.rs::background_tasks_wire` + `pi_session.rs::job_list()` 读最新
  `background-tasks` 条目（真字段投影；未知 status Err）；`pi_job_cancel` 保留 Err
  （Job Object 句柄在插件进程内）。
- 前端：jobs-store 词表 = 插件 `STATUS_*`；终端分区行 = label（或 command）+ 秒针，
  **不渲染 Stop**；run 期 2s + 挂载期 3s 双轮询（修了「跨轮 settle → 行永远停在运行中」竞态）。
- 实机 E2E：真模型 composer 发后台请求 → job 真跑（sleep 20 / 60 均 exit 0）→ 面板
  「终端」分区运行中在场、秒针在走、settle 后自动收掉。Rust 单测 +4（670）。
- 门禁：tsc 0 新错 / vitest 1045（84 文件）。

**✅ 2026-11-18（夜）：bots 引擎侧四件套全落地 + 实机 E2E 全绿 —— PR 给 pi-rust 是唯一欠账**
（用户："全部做，做完检查，没问题了pr给pi rust" / "改了引擎测，提pr给ri rust"）

- **引擎侧（`G:\pi-rust-main`，未入宿主仓库；上游 = `github.com/bigfish1913/pi-rust`）**：
  - `rpi-harness/src/task_lease.rs`（新，6 单测）：持久任务租约——`acquire_with_meta`
    / `renew` / `finish` / `status` / `list` / `recover`（过期 Running→Indeterminate）
    / `ensure_live`（fencing：Conflict/Stale/LeaseLost/AlreadyFinished/Invalid/Io）；
    落盘 `<session>.tasks.json`（tmp+rename）。
  - `rpi-cli/src/approval_gate.rs`（新，3 单测）：运行时审批模式（AlwaysAsk/Write/Yolo
    进程级 AtomicU8）+ `ApprovalHandler` + `before_tool_call`（组合在扩展 hook **之后**，
    只读白名单显式）。
  - `rpi-cli/src/message_agent.rs`（新，2 单测）：引擎内置 `message_agent` 工具
    （fire-and-forget；**handler 未装不注册**；caller session id 从 harness 绑定解析）。
  - `rpi-cli/src/session.rs` 接线 + **绑定修复**：`durable_binding` 原来只在
    `native_durable` 时填充 → 宿主（从不设它）里 message_agent 恒报
    "session binding not ready"；改为无条件 `set`（顺带让审批请求带真 session_id）。
    `lib.rs` 两行 mod 声明。
- **宿主侧**：`pi_bot.rs`（prompt = task 身份+租约+meta；结束 finish(Settled/Cancelled/
  Failed+receipt)；state 出 `task`/`tasks`；`pi_bot_take_recovered`、
  `pi_bot_interrupt_task` 带 fencing）｜`pi_engine_bridges.rs`（agent-message 事件+30s ack、
  approval-request 事件+600s 裁决）｜`pi_display.rs`（GDI 截屏 + RFB 3.8 WS 服务：ticket
  单次、lease 契约修复）｜`engine-bridges.tsx`（投递/回信 + 审批弹卡 + 模式恢复）｜
  host-rpc（display.* 真接线、`task.interrupt`、resume 扩租约面、prompt.submit 传 taskMeta）｜
  canonical-group-driver（localStorage ledger 删除 → 引擎租约 + recovered→indeterminate
  回写 + Stop 走 fenced task.interrupt）。
- **实机 E2E（真模型 BBT/deepseek-v4.1-flash）**：
  ① 审批：always-ask → bash 弹卡（真 args）→「允许一次」→ `approval-e2e-ok` 真执行；
  「拒绝」路径回灌 `用户拒绝`、命令未执行。② message_agent：微软 →引擎工具→ `queued`+
  delivery_id → 真投递 remote-bot（归属前缀）→ 回信进微软会话。③ 屏幕面板：右键「打开
  屏幕」→ noVNC canvas 1280×720 真帧（像素采样非零）→ 接管「你正在控制」→ 交还
  「机器人正在控制」（lease epoch 2 / holder:'agent'）。④ 任务租约：running 快照
  `task{id,gen}`+meta；stale generation interrupt **被拒**（"stale task identity"）；
  正确 generation → abort → `cancelled`+meta 落盘；崩溃恢复 fixture → `indeterminate`
  ("driver restarted while the task was running") → take-once 清空。
- **门禁**：tsc 0 新错（1326 条 = hermes-mirror/sdk-upstream 既有基线）/ vitest
  **1044**（84 文件）/ cargo test **666** / cargo check 0 / rpi-cli+rpi-harness 新模块
  单测 11 条全过。
- **PR 已提（2026-11-18 夜）**：**bigfish1913/pi-rust #348**
  （https://github.com/bigfish1913/pi-rust/pull/348，
  head `HQZ1111:feat/task-lease-approval-message-agent`，6 文件：
  三个新模块 + session.rs +50/-3 + 两个 lib.rs 各一行）。分支基于上游
  main d3e388d 干净重建（镜像里用户自己的本地补丁如 execution_env /
  after_tool_call 改动**没有**带进 PR）；克隆在本机
  `E:\Temp\pi-rust-pr333`。余下：等上游 review；canonical 群聊**含租约**的
  整房间 UI E2E（各原语已单独实测）。
  **上游结论（2026-11-19）：#348 已合并**。评审两轮 6 blocker 全修复
  （过期围栏/跨进程 fs2 锁/扩展结果保留/取消 fail-closed/message_agent
  send-cancel 分型/文档对齐）；遗留 nit（acquire 文档与实现矛盾）由维护者
  以 **#376** 落地并致谢（我们的 #374 因此关闭，无需动作）。
- **有意不做**：屏幕的 display.stop/install 面无（宿主无停止语义）；
  relay 跨网关（单身份宿主无 relay 概念，显式报错）。


**✅ 2026-11-18：对话右上角活动状态面板 = ZCode `ConversationStatusPanel` 完整移植**
（用户："把zcode的对话右上角的状态面板栏完整移植" → "有意差异去除，全部对齐"）。

- **结构对齐**：分区顺序 Git 工具 → 目标 → 会话计划 → 进程 Todo → 终端 →
  智能体；每区限高滚动（goal/sessionPlans/terminal/agent max-h-48、plan
  max-h-80）+ separated 上边线 + trailing 随开合切换；智能体分区页脚
  「已结束的智能体 · N ›」；mini 胶囊完整优先级链（运行待办 → 目标(活) →
  git 变更 → 目标(完) → 最近完成项 → 待办计数 → 最新会话计划 → 运行计数 →
  无则不渲染）。
- **卸载闸门照抄上游**：`!hasContent → null`（只有已结束智能体的会话整块不
  渲染），推翻 11-15 的"常驻空态"宿主选择。
- **目标区完整化**：`pi_goal_state`（rpi-goal `goal-state` 条目）→ 用时秒针 +
  `/goal pause|resume` 按钮走既有 `pi_run_command`；真机：起目标 → 面板
  出现（active、秒针在走）→ 暂停/恢复按钮真翻转状态 → `/goal stop` 归档后
  面板整块消失。
- **会话计划目录**：新 Rust IPC `pi_plan_entries`（rpi-plan-mode 条目，只收
  有 markdown 的，seq 降序）+ 新 `plan-entries-store`；点行开面板栏标签页
  `plan-detail:<entryId>`（每计划一实例）。**真模型全链路已实测**：plan 模式
  下发规划请求（composer 真发送）→ 模型 `plan_mode_complete` 写入真计划 →
  分区出现（H2 回退标题 + 计数 1）→ 点行开详情页展示原文。
- **智能体分区**：rpi 子代理运行态无宿主读取面（`pi_hub_roster` 如实 Err）→
  从 `delegate_task` / `subagent` / `dispatch` 工具调用派生运行/已结束两段
  （`status-agent-rows.ts` 纯函数）；页脚开单实例 `agent-directory` 标签页，
  行可再开子代理详情页。
- **终端分区**：数据面 = jobs-store（`pi_job_list`，rpi 未装 background-tasks
  插件 → 如实 Err → 空 → 分区不渲染），有任务时行 = 命令行 + 用时 + Stop。
- **workflow 分区不渲染**：rpi 无该概念（engine-gaps G3），不造假 UI。
- 顺带修复：`pi_get_state.hasExtensions` 硬编码 `false` → 读
  `extension_session` 真值（实机回读 `true`；扩展命令本来就可用）。
- 门禁：tsc 0 新错（1326 条均在 hermes-mirror / sdk-upstream 既有基线）/
  vitest 1044（84 文件，新增 25+9 条）/ cargo test 666。

**✅ 2026-11-18：右侧面板栏终端对齐 ZCode 侧栏终端**（用户："我的右侧面板栏
里的终端，打开怎么和zcode不一样？"）。规格 = 上游
`docs/ui/side-pane-terminal-tabs.md` + `SidePaneTerminalPane.tsx`：

- **一个面板 = 一个终端**：删掉面板内自绘的二级页签条（`Administrator +`
  那排）与二级新建钮（上游明令"内部不再嵌套 terminal tabs"）；内容区 =
  `bg-background p-3`（0.75rem）留白——此前是贴边满铺。
- **点「终端」= 新建面板**（不复用单例）：`open-page-actions.ts::
  openTerminalPanel`，标题 = cwd 末段（取不到 = 终端）+ " 2/3"（上游
  `createTerminalSidePaneTitle` 同源），id = `terminal` / `terminal-2`…；
  cwd 进 params，存档恢复沿用。`isTerminalPanelId()` 同时接进关标签的
  栏生命周期判定（dockview-shell）。
- **保活**：终端面板以 `renderer:'always'` 挂载（dockview overlay），切标签/
  收栏**不卸载、PTY 不中断**（上游"切换到其他 side pane tab 或收起 side pane
  时保持挂载"）；关闭面板才卸载 = kill（实机：pwsh 进程 5→4）。boot 时对旧
  存档里的终端面板补写 `setRenderer('always')`。
- **坑（已实锤进代码注释）**：`always` 面板隐藏时 overlay 未定位、容器报
  整坞尺寸（100%×100%）——"有尺寸就 spawn"会按错尺寸起 PTY；spawn/fit 必须
  同时以 `api.isVisible` 为准，激活时由 visibility/dimensions 回调补启动。
  实机断言：隐藏终端无 xterm（不 spawn）；激活后面板 69 行、容器 240×1046
  尺寸一致；A 终端 `echo probe-AAA` → 切到 B → 切回，scrollback 仍在且能
  继续执行（保活）。
- 退出条（进程已退出/重新打开）保留——宿主失败可见通道；实机：`exit` →
  条出现 → 点「重新打开」→ 新会话。
- **二轮（同日，用户："显示达到上限8无法打开了，而且有黑色背景，文字也不对"）**：
  - **上限 8 = 泄漏症状，不是策略**：页面 reload（dev HMR / webview 重启）
    后旧页面的 kill 钩子随页面消失 → 遗留 PTY 占满登记。修法 = 会话带
    页面归属（webview label + per-page token，`terminal-pty.ts`），
    `terminal_reap` 在 boot（`app/index.tsx`）与 spawn 各回收一次；**上限
    撤除**（ZCode 无上限）。实机：开 10 个终端标签全成功（10 个 pwsh 各一）
    → reload → reap 后只剩活动标签 1 个进程；关标签即减。顺带实锤
    portable-pty 0.8.1 `WinChildKiller::kill` 成功判定写反（成功返 Err），
    `terminal_kill` 不再据其返错（以 exit 事件 + 登记摘除为真）。
  - **配色改 ZCode 默认浅色主题**：`--term-*` = Tailwind v4 调色板（底 =
    `--surface`，字 = neutral-950，ANSI = 500 系；red-500 是 `#fb2c36` 非
    v3 的 `#ef4444`）；`.xterm-viewport` 原生滚动条按 ZCode 同款隐藏。
    实测 getTerminalTheme 解析：bg rgba(255,255,255,1) / fg rgba(10,10,10,1)
    / selection rgba(0,165,243,0.322)。截图：浅色终端与面板一体，黑块消失。
  - **字体被全局 webfont 规则劫持（真 bug，已修）**：harmonyos-sans-sc
    包的 `:lang(zh)` 规则直接命中 xterm 逐字符 span → 终端拉丁字用比例体
    渲染（"Power Shell"/"Adm inistrator" 怪字距）。panes.css 以
    `.term-host .xterm *` 更高优先级钉回 `--term-font-family`；实测
    span 字体回到 ui-monospace 栈、逐字符 letter-spacing 归零。
  - xterm 5.5 的 dispose 必须延后一个宏任务（其 Viewport 构造函数有未追踪
    setTimeout，同步 dispose 会报 "reading 'dimensions'"）：开关终端标签
    循环测试 0 异常。
  - **三轮（继续）：标签图标 + 右键复制/粘贴**——终端签标题前加
    SquareTerminal（CSS mask + 令牌 `--term-tab-icon`，判据精确匹配 id
    `terminal`/前缀 `terminal-`，不加自定义 tabComponent，✕/拖拽零变化）；
    窗格根 `data-slot="terminal-pane"` 登记进全局右键范围，右键菜单
    复制/粘贴走 `term.paste`（bracketed-paste），动作后焦点还给终端。
    **坑**：终端面板是 `renderer:'always'`，内容在 `.dv-render-overlay`
    （带 transform/contain/will-change = position:fixed 的包含块），motion
    ContextMenu 内联渲染会被叠加 overlay 偏移（实测点击 (1619,156) 画到
    x=3030）→ 菜单必须 `createPortal(..., document.body)`。
- 门禁（三轮后）：tsc 0（非镜像树）/ vitest 1051（85 文件，含
  context-menu-scope 的终端面用例）/ cargo test 667 / cargo check 0。

**✅ 2026-11-17：bots 插件补齐轮（用户："先补齐bots……百分百对齐hermes的bots"）**。

- **P0 群聊成员轮次全链接通**：新 `src-tauri/src/pi_bot.rs` = 后台 bot 会话
  泳道（独立 harness，不抢前台会话；create/open/prompt/interrupt/compact/
  attach/ask/approval），`host-rpc` 接 `prompt.submit`/`approval.respond`/
  `clarify.lock`/`file.attach`/`image.attach_bytes` + `session.resume` 富投影
  （running/inflight/turn_started_at/open_requests/pending_approval +
  `failed_turn` 边界行）。实机：发消息 → 成员会话真跑 → deepseek 403（key
  配额用尽）→ 房间活动行如实显示真错误 → 自动轮到下一成员。
- **贡献面 2/7 → 6/7**：`composer.atCompletions`（@ 补全出机器人行）、
  `composer.middleware`（发送前管线）、`chat.empty`、`command.palette`
  （New bot… 行），加既有 panes×2；`profile group header` 无消费面（屏幕
  不支持）。
- **`host.openWorkspace` 从空开关变真门**：`plugin-workspaces.ts` +
  `plugin-workspace-pane.tsx`（主区标签页 + 重启孤儿剪枝）——群聊房间此前
  点开毫无反应（事件无监听者 + close 返回值被吞）。
- **修 5 个真 bug**（用户可见）：ctx.storage 值级 KV 被当字符串（bot-meta v2
  等持久化全坏）；`gatewayActivationEpoch` 写成常量而上游是函数（群聊创建
  对话框永远"检查中"）；`host.agents().sources` 用错键名（所有行"网关已
  移除"、群成员 0 可用）；`pi_get_session_messages` 叶子取文件尾行（rpi
  记录条目无父链 → 投影恒空 → 群聊读不到回复）；`sdk/message-text.tsx`
  借 assistant-ui part 原语（群聊房间白屏）。
- **剩余结构性缺口 = canonical（网关驱动）群聊**：新群聊按上游语义要求
  网关 driver（宿主 legacy 声明 → 对话框如实"版本过旧"）；Rust 已移植
  hosted_rooms 状态机/规划/控制面，缺 driver runner（上游源
  `tui_gateway/hosted_room_driver.py` + `hosted_room_service.py`；依赖会话层
  task 身份/终局回执，rpi 侧未定协议）。详见 `docs/bots-port-gaps.md`。
- **门禁**：tsc 0（非镜像树）/ vitest 1003（82 文件）/ cargo test 660 /
  cargo check 0 错误。
- **2026-11-17 续（用户："其他缺口能补齐的就补齐"）**：
  - **MCP 真面补全**：`pi_mcp_catalog.rs` + `assets/mcp-catalog.json`（hermes
    `optional-mcps/` 的宿主可执行子集：10 条 no-auth HTTP）；`mcp.catalog`
    出目录、`mcp.servers.add {preset}` 一键装、`mcp.servers.test` 对 HTTP
    做**真实 MCP 探测**（initialize→initialized→tools/list；实机 deepwiki 3
    工具 + serverInfo）、`mcp.servers.set_api_key` 写 env、
    `mcp.servers.remove` 真删。56 条 OAuth 条目不入目录（引擎扩展没有 OAuth，
    见 `docs/pi-host-gaps.md`）。
  - **能力面板导出**：`sdk/capabilities-views.tsx`（CapabilitiesView /
    ConnectorsTab / ToolsetConfigPanel）→ 机器人编辑对话框出现
    技能/插件/连接器/工具集四页签（实机）。
  - **图像/屏幕面**：`image.generate` probe available:false；`display.*`
    明确报错（无 display 子系统）。
  - **canonical 群聊最小驱动落地**（同日）：`canonical-group-driver.ts`
    （前端驱动）+ `groups_plan` 暴露 task.prompt + `groups.driver_append`
    写回口 + `groups.capabilities` driver:true。实机：新建群聊 → 发消息 →
    两名成员依次跑轮次（真实 403）→ turn.failed 如实回写 → room.activity
    settled；界面出「回合失败」卡 / Round 状态 / Stop。差距：无租约/
    fencing/indeterminate 恢复、router(auto) 不支持、retry/discard/
    approvals 未桥接（`docs/bots-port-gaps.md` §3）。
  - **2026-11-17 收尾（用户提供测试 key：`bbtoken.boywe.cn/v1`）**：
    models.json 加 `BBT` provider 并设为默认 → **「真模型端到端」硬阻塞解除**。
    成功链实机验证：主对话 1+1=2；canonical 群聊两成员真实自我介绍 +
    handoff + settled；legacy 群聊真回复；router(auto) `room.routed` →
    成员真回复；**MCP 模型内调用**（`mcp_list` 发现 deepwiki → `mcp_call
    ask_wiki_question(facebook/react)` 返回真实答案并中文总结）；远端错误
    如实回显。
  - **新增宿主面**：`pi_mcp_oauth.rs`（MCP OAuth 标准 DCR+PKCE+刷新，目录扩到
    64 条）；`pi_skills_catalog.rs`（hermes optional-skills 139 技能，
    skills.manage 搜索/安装/删除，实机装 watchers）；canonical driver 补
    **approvals 桥 / retry / discard / router(auto)**；`groups.capabilities`
    方法表 16 项。
  - **仍未做（引擎侧，见 `docs/pi-host-gaps.md` §6/§7）**：权限闸运行时切换
    （rpi 迁移后 set_approval_mode/plan 系为只读，approval 卡触发需扩展通道）、
    message_agent/relay（需会话层工具注册面）、display、canonical 租约级恢复。
  - **引擎侧缺口文档**：`docs/pi-host-gaps.md`（OAuth MCP / display /
    canonical 全语义所需 task 身份 / session.reclaimed / 多连接 peer）。
    结论：本轮所有补齐均在宿主侧完成，未改 `G:\pi-rust-main`（该树无 .git，
    需要时按文档拆 patch）。
- **PR**：https://github.com/HQZ1111/mirach-harness/pull/2（分支
  `bots-plugin-complete`；本轮续的改动追加在同一分支）。

**✅ 2026-11-16：hermes-bots 插件移植落地（c85756a）+ groups_plan 修复（ff41b18）**。

- **内置插件跑通**：`src/sdk`（`@hermes/plugin-sdk` 宿主对偶：host.request 分发
  profiles/session/cron/cli/groups；host.state 八字段接真 atom）→ `src/plugins/bundled.ts`
  + `PluginPane` + dockview `bots` 槽位（贡献优先、BotsPane 回落）；CDP 实测
  花名册渲染 / 点击建·复用 canonical Bot Chat（双锚，侧栏过滤）/ composer 发送
  （人格·模型生效）/ 编辑机器人对话框 / 例程面板（列表·新建·暂停·删除全链）。
- **例程面板**：`hermes-bots:routines` 贡献自动挂到主区右侧「定时任务」面板
  （registry 订阅：贡献在→建面板，消失→摘）。修四个真缺陷：`pi_cron_jobs` 回包是
  `{jobs,tickerRunning}` 非数组（曾 TypeError）、行内删除动作是 `remove`（非 delete）、
  `nextRunOverdueMs` 签名必须收 job 对象（手写近似版让每行恒「逾期自」）、
  `display.status` 给 `supported:false` 定型（屏幕门户不再假 spinner）。
- **焦点 owner 口径**：`focusedSessionOwner` 只认 bot 双锚（`chatSessionId`），
  普通会话报 null；connectionId 留空（本机行身份=裸名字）。此前伪造 `local`
  owner 让例程窗格死锁在「这个机器人需要先出现在名册中」。
- **groups 后端**：`groups_plan` 的 `local_profiles` 从成员 `target.kind=local`
  提取（原返回空 Vec → 恒报 "not local to this gateway"）；`cargo test hosted_rooms`
  **464 passed**；CDP 实测 `groups_plan('plan-test')` → `status=task, member_id=m-ada`。
- **门禁**：改动文件 tsc 0；镜像树历史类型错仍在（全仓 tsc 1341 条为镜像类型漂移，
  vite 构建不受影响，待后续收）；cargo test 464 绿。
- **已推送**：`c6cd077..93e1ad1`（群聊后端 + 插件移植 + groups 修复 + 交接快照
  + 对话对齐缺口文档），origin/main 已同步。
- **下一步（已定稿，待统一批次执行）**：对话对齐 ZCode 的**宿主（pi rust 引擎）侧**改造——
  缺口清单见 `docs/zcode-parity-gaps.md`（P1 会话行投影 / P2 productTurn+workSegments /
  P3 块级状态计时 / P4 最终正文标记 / P5 错误事件 / P6 subagent·hook·marker 行 /
  P7 行序列读取 API）；tauri 侧 agui 映射与前端启发式收在该文档 §5 附录（下游）。
- **bots 插件移植完成度审计**：`docs/bots-port-gaps.md`（插件源码 121 文件原样；
  宿主适配 P0 缺 `prompt.submit`（群聊轮次不执行）/P1 事件面 9 通道无生产者/
  MCP/技能市场/relay/composer 贡献面未接；**不是 100% 功能复刻**）。

**✅ 2026-11-13（续）：MOSS 工具面全协议落地 + mock vendor 全链 E2E 通**。
`lib/moss-tools.ts`（host 原生只读集 6 个 sync 工具 + `run_cron_job_now`
async_effect，用户定稿口径）+ `lib/moss-tool-flow.ts`（纯协议态机：call_id
去重 / cancel_requested 迟到丢弃 / ≤4 并发 / ≤128 会话 / 120s 超时失败输出
——失败可见，规矩 12）；接线 = `MossLiveSession.attachToolFlow()` +
voice-live-panel moss 臂。pi 内置工具**不透传**（语音场景审批面不可见），
tool_task.revise/.cancel 无 UI 不做（不做死代码）。**E2E（mock vendor 配
假 key 打通整条真链）**：声明→get_now sync 回报→cron trigger 失败输出→
cancel 丢弃，全部 PASS；排障揪出并修掉两个真缺陷：①Rust 桥无 path 的
base_url → tungstenite request line `GET ?…` 非法 → 400（normalize_base_url
+4 Rust 测）；②onClosed 静默吞断线 → 红显 reason。门禁：tsc 0 / vitest
**792**（64 文件，+33）/ cargo test **138**（+4）。cargo check 有 **5 条
既有 warning**（2 unused import + 2 must_use PlanChange + 上游 agui.rs
CoerceUnsized——11 月轮欠账，非本轮引入）。**真 key 端到端（模型真调工具）
仍待 platform.moss.cn key**。细节见 `AGENTS.md`「MOSS 工具面」段。

**✅ 2026-11-03：对话层对齐 ZCode 轮结构（阶段 1-3 全落地）+ 扩展系统接通。**
四道门禁全绿（tsc 0 / vitest 697 / cargo check 0 / cargo test 123），全部实机验证。
细节与实机踩坑见 `AGENTS.md`「轮（turn）层」「阶段 2」「阶段 3」三节。

- **扩展系统**（阶段 0，RPi 插件前提）：`pi_extensions.rs` 照抄 pi CLI 的
  `ResourceLoader` 发现链；`create_session_opts` 把 `extension_paths` 交给
  `SessionOptions`（此前恒空 = pi 扩展能力整块不存在）。`pi_get_state` 新增
  `hasExtensions`。实机闭环：探针扩展 `hasExtensions: true`，坏清单错误
  如实传播。
- **轮层**：`turn-units.ts`（一条 user 开一轮，11 单测）→ `MessageTurnList`
  轮容器替换扁平 `ThreadPrimitive.Messages`（`Unstable_MessageById` 按 id
  挂载）。
- **轮级操作条**：一轮只挂一条（`isLastContentAssistantOfTurn`），4 条
  assistant 只出 1 条（实机）。
- **时间线标记**：新 IPC `pi_get_timeline_markers`（model_change/compaction
  + 消息索引）；`timeline-marker-store` + ZCode 分隔线形态。**索引口径必须
  与 hydrate 同一**（只数 user/assistant）。
- **轮尾文件汇总**：`turn-file-changes.ts` 现场聚合（edit 有真值、write
  行数 null 不造 0），挂操作条之前。
- **工作段折叠**：`work-segment.aui.tsx` 折叠 `group-chainOfThought`（=
  宿主的工作段），「已工作 N 秒」/「已处理」，running 恒开无头。
- **轮导航器**：`turn-navigator.aui.tsx` 左缘竖条 mini-map（≥864px 且
  ≥2 query），悬停预览、点击跳轮。
- **顺带修的投影缺陷**：水合路径 toolResult 的 `details` 被拼掉——历史
  会话 edit 的 diff / submit_plan 审批态全丢。已统一为流式的 ToolOutput
  对象形状。

**✅ 2026-11-03（续）：阶段 4 三项落地**——框选工具条（复制/引用到输入框，
守卫定位照抄 ZCode）、会话内查找（Ctrl+F，CSS Custom Highlight 高亮 +
n/m 计数导航；坑：`Highlight` 构造器在 window 全局不在 CSS 上）、子代理
单行摘要（ZCode 单行形态；宿主无下钻面，展开看输出，注释已记）。门禁
tsc 0 / vitest 719 / cargo 123。**遗留专项**：工具组跨 reasoning 边界
（需照抄 ZCode 的 reasoning 可见性规则 + 自建 work-items 扫描替换
GroupedParts——渲染核心重写，单独一轮做，方案见 AGENTS.md「阶段 4」节）。
另：清理了仓库根 10 个历史探针残渣文件（空文件 + 依赖图临时产物，
untracked）。

**✅ 2026-11-07：对话层对齐收官**——「工具组跨 reasoning 边界」专项落地：
`assistant-work-items.ts`（ZCode `buildAssistantWorkRenderItems` 扫描，18 单测）
+ `work-parts.aui.tsx` 渲染器**替换 `MessagePrimitive.GroupedParts`**。思考
可见性 = ZCode 默认（每消息只显示首条，其余剔除——不渲染/不断族组/不计时
长）；实测 `[思考,bash,思考,bash,思考,read,bash,text]` → 一个「查阅」组
跨两条被剔除的思考合并 4 子工具，思考行只剩首条，正文在折叠区外。叶子机制
（part scope / 注册工具 UI / data 渲染器 / indicator）与官方逐条对齐，其中
`PartByIndexProvider` 用公开 API 复刻（官方不导出，`MarkdownTextPrimitive`
读 `s.part` 没 scope 就空）。**groupBy 指纹机制退役**（详见 AGENTS.md
「分组器（2026-11-07 改版后）」）。门禁 tsc 0 / vitest 733 / cargo 123。

**✅ 2026-11-07（续）：机器人页完整移植**——hermes plugins/hermes-bots 的
roster-pane 全链路落到 `bots-pane.tsx`（用户口径：**左栏右侧弹出独立栏**，
Mirach 点击开合，不再切侧栏视图）。BotFace 程序化头像（avatar.tsx 1158 行
逐字字节复制 + profileColor shim）、用户分区 + 行拖拽归区、行右键菜单、
已隐藏区、对话框头像选择区（形状/颜色/图片）全落地；bots-store v2 扩
hermes BotMeta 字段（v1 自动升格）。群聊/网关/Routines 等 pi 无承载面
**不造假 UI**（逐项见 AGENTS.md「机器人页完整移植」表）。门禁 tsc 0 /
vitest 734 / cargo 123。

**✅ 2026-11-11：GPT-Live 双工语音桥（"moss live"查证 = hermes gpt-live）**。桥接层全落地：
Rust `pi_voice_live.rs`（status + SDP 交换端点，key 不进前端，6 测）+ 前端
`lib/voice-live.ts`（VoiceLiveSession 逐段移植，13 测）+ voice-live-store +
composer VoiceLiveButton/字幕面板。实机：status IPC 通、无 key 红显 hermes 同文
reason。**委托回路（voice→agent→commentary）待接**（runtime postRun 桥，红显）；
配 OpenAI key 即为真 API 会话。门禁 tsc 0 / vitest 752（61 文件）/ cargo test 134。
**✅ 2026-11-10（续2）：间距度量全对 + BotsDialog 完整结构 + per-bot 工具集真生效**。
间距按 hermes dialog.tsx 源码值（gap-3 p-4 / 标题 15px semibold / footer gap-2 /
labeled gap-1.5；实测 15px 根字号换算全对）。BotsDialog = CreateAgentDialog
骨架（Advanced 折叠 → 四页签：常规/技能/工具/MCP；高级态 768px + resize:both）；
工具页签 17 组真数据；BotPreset.toolsets → bot-launch 映射 enabledTools →
pi_create_bot_session 新参 → SessionOptions.enabled_tools（Rust 胶水透传，
pi_agent_rust 未动；目录读失败传播不降级）。门禁 tsc 0 / vitest 739 /
cargo test 128。

**✅ 2026-11-12：委托回路全链路（上一轮红显拆掉）**。驱动组件
voice-live-conversation.tsx（provider 内）：pendingDelegation 消费（busy 先
cancelRun → aui.thread.append 官方通道提交；voiceContext 前置进文本——pi 无
模型输入旁路）+ 200ms 回复驱动（句界 speak / 工具名 think / 15s 宽限）+
口语停止词（voice-stop-word.ts：hermes 英文表 + 中文等价，整句判）+
speech-text.ts 逐字复制（回复语音净化）+ 种子 history。配 OpenAI key 即为
完整 GPT-Live：说话 → 委托 → agent 干活 → 语音转述。门禁 tsc 0 / vitest 759（62 文件）。
**✅ 2026-11-12（续2）：per-bot 例程真绑定（RoutinesStubPane 退役）**。pi_cron
Job 加 bot 字段（serde default 兼容旧 jobs.json；仅归档/过滤——执行参数创建时
由前端从 bot 预设填进 provider/model/prompt）。RoutinesPane 真面板（作业表/
创建/立即运行/暂停/恢复/删除）。实机：IPC 直查绑定 + 过滤 + 清理全通。
**✅ 2026-11-12（续3）：moss live 接通收尾——设置页「语音」节**。vendor

**✅ 2026-11-12（续4）：真身确认 = 模思智能 MOSS Live（不是 OpenAI）**。

## ⚠️ 换会话须知（2026-11-12 收尾时写，新会话先读这段）

1. **C 盘**：~~23GB rollout~~ **已删（2026-11-13 新会话执行，1.53→25.07GB）**。
   **经验**：每轮对话别跑太长——model-io rollout 会持续膨胀（那次的根因）。
2. **dev 实例**：11-13 早上机器已重启，**exe/vite 都没在跑**。启动 = vite
   `npx vite --port 1430 --strictPort` + exe（`npm run tauri dev` 或直接跑
   debug 二进制）；重建 Rust 前先 Stop-Process mirach-harness。
3. **门禁基线**：tsc 0 / vitest **792**（64 文件）/ cargo test **138**——
   11-13 工具面轮后。cargo check 有 **5 条既有 warning**（pi_mcp.rs unused
   Path / pi_voice_moss.rs unused on_big_stack / pi_session.rs 两处 unused
   PlanChange / 上游 agui.rs CoerceUnsized overflow）——11 月轮欠账，
   **不是新引入**，哪轮顺手清哪轮。
4. **下一轮候选**：MOSS key 配置后的真语音端到端（platform.moss.cn key；
   Live 计费页未标价，免费待确认）——**含工具面验证**（模型真调
   get_now/list_cron_jobs + run_cron_job_now 的 async 回报链，工具面协议
   已落地，见 AGENTS.md「MOSS 工具面」）；hermes 的 officeoffice 模式
   （用户此前说先不做）。
5. **⚠ 整个 11 月的工作未提交**：main 恒在 10-19 的 bd88e55，10-22 换栈
   wry 起的全部轮次（设置独立窗口/审查面板/技能页/cron/机器人页/轮层/
   语音双桥/工具面）都只在 `G:\mirach-harness` 工作树里——一次误操作
   checkout/reset 就全没了。**新会话开工前建议先让用户拍板提交一个存档点**。

用户纠偏后查 platform.moss.cn：moss-live-1.0 = WSS 全双工语音（真双工+
barge-in+client delegation），且 vendor 官方委托后端 Option 1 就是 pi。
宿主桥：Rust pi_voice_moss.rs（tokio-tungstenite 新依赖；WSS 握手头持 key
——浏览器设不了 WS 头，事件/音频经 emit 广播）+ 前端 lib/moss-live.ts
（16k 采集上行/48k 排队播放/barge-in 确认/transcript 全文覆盖字幕）+
mode=moss-live 全链（status.mossAvailable/设置第三 radio/MOSS key 只写）。
委托回路与 GPT-Live 共用（VoiceSessionLike 接口，驱动零改动）。门禁 tsc 0 /
vitest 759 / cargo 134。另：C 盘满根因 = 本对话 model-io 日志 23GB（在写
不可删），已清 Temp 1.1GB + cargo cache 0.14GB（0.8→2.03GB）。
contract 对官网三页逐条核对全一致（POST /v1/live/sessions 201 / gpt-live-1 /
oai-events / 事件集全对上；差异仅 ICE 宽松放行与 200/201 兼容）。应用内两步
接通：设置 → 语音 → 粘 key + 切 gpt-live → 保存（pi_voice_live_set_config
→ persist_voice_live_config RMW；key 只写不读有测试守着）。实机：假 key 写入
→ status available:true 翻转无泄漏 → 清除复位。门禁 tsc 0 / vitest 759 /
cargo test 134。

**✅ 2026-11-10（续）：新建分区/新建群聊两个对话框逐段对齐**。分区对话框
空白 = .set-card 70vh 两列大卡（display:block 补丁漏了它）→ 420/auto 紧凑卡；
分区嵌套结构全量对齐（renderUserSections：网关桶内嵌套 / filter=具体连接切
回平铺 / 孤儿连接红显桶 / 空块规则）。群聊对话框照 CreateGroupChatDialog
重写（搜索/徽章/BotFace 成员行/Checkbox/图片/空名默认成员名/创建群聊 (N)/
上限 6）。内存结论：5.4M = 宿主进程私有内存（一直没变）；大头在 WebView2
dev 进程，重启即回落。门禁 tsc 0 / vitest 739。

**✅ 2026-11-10：子页全量对齐 + 内存实测**（用户"所有的子页面一模一样"）。
工具条 Filters 落地（kind/gateway 真 + activity 禁用红显）；屏幕/per-bot 例程
两个红显占位子页（bot-subpages.tsx，行菜单真入口）；群聊房间结构升级（头像栈/
行头像/右对齐/@提及高亮/成员 chips）；编辑对话框技能多选（pi_capabilities 真
清单 + skills 拼进 systemPrompt 真效果）+ MCP 红显段。顺带修两真缺陷：
CreateGroupDialog/SectionDialog 缺 Esc 关闭层；多连接分支不渲染群聊分区。
内存实测：冷启动 webview 392MB WS / 堆 112MB / 宿主 68MB——"变高"= 三天连跑
的 HMR 累积，重启即回落。门禁 tsc 0 / vitest 739。

**✅ 2026-11-08：永久会话锚定修正 + 会话侧栏隐藏真接线**（用户核对引擎事实
"pi 无 hidden 会话面、无 title 唯一索引"后全链路修正）。vendor 坐实：sessions
表只有 path 主键（session_index.rs init_schema:723），name 无唯一索引；无会话
级 hidden 面。两处修正：①bot-launch **sessionId 锚定**（create 采纳返回快照
的 sessionId、路径按 id 匹配；open 后 pi_get_state 身份校验——不符清锚重建，
无锚旧记录借此锚定；名字匹配已废）；②thread-list **真接侧栏隐藏**（此前头
注释声称 botSessionNames 过滤但从未实现——假声明；现在 useThreadDisplay 按
`botChatPaths()` 双锚 path 集过滤行投影与搜索面；删 bot = 锚消失 = 行重现）。
克隆 bot 补清 chatSessionId。实机直证：锚定/复用/隐藏（bot 在场行不在）/重现
（删 bot 行回）/删除（活动会话被引擎拒，切走可删）全 PASS；孤儿探针会话与
锁文件已清。单测 +5（botChatPaths）。门禁 tsc 0 / vitest 739（60 文件）。

**✅ 2026-11-07（续2）：机器人栏间距/排列对齐 hermes row-geometry**（用户
"间距，排列样式还是有区别"的收口轮）。逐项对照 hermes 源码常量（`row-geometry.ts`
`chrome.tsx` `bot-row.tsx` `roster-pane-toolbar.tsx` `roster-sections.tsx`
`search-field.tsx` `button.tsx icon-xs`）改 `bots-pane.tsx`：

- **搜索框** = SearchField underline 变体：无边框（border-b transparent），
  静止 opacity-50 / 聚焦 100 / 有词 100，icon 3.5 + 输入 0.75rem + 清空钮。
  原带边框圆角盒删除。
- **段头** = RosterSectionHeader 逐类对应：`px-2 py-1.5`（原 px-2.5 pt-2 pb-1）
  + caret 折叠（全部区块可收）+ 前导图标 + 计数**同色** font-normal（原
  muted/50）+ 悬停 ⋯（用户分区，右键同菜单双击改名）+ `mt-1 pr-1` 组。
- **不可达连接**：头部文字照常 quaternary，**尾部**小红标"未接通"
  （hermes 放 amber 断连图标的位；宿主占位规则用红）+ **行头像置灰**
  （hermes sourceStatus.available 的 grayscale opacity-60）。
- **状态点** = SessionStatusDot idle：`size-1` quaternary，装进
  SidebarRowLead 的 **14px 固定前导格**（名称左缘与左栏会话行同线）；
  原 6px 绿点裸放删除。
- **细节行**：handle = `font-mono text-[0.6875rem]` + `·` 分隔（原无 mono
  无分隔）；置顶/隐藏标记 `size-[0.6875rem]`（原 12px）。
- **行栈间距**：行间 `gap-px`（1px，原 gap-0.5）；块间 gap-0.5；全部区块
  收进**一个** `grid gap-0.5 px-1.5 pb-2` 容器（原每区自画 px-1.5 + 段头
  px-2.5 → 左缘差半像素；现在段头/行同线 9.5px）。
- **工具条钮** = icon-xs：`size-6 rounded-[4px]` svg 12px（原 p-1 约 20px 盒）。
- **群聊行** = GroupRow：34px 头像列 + size-8 圆角盒 + ring（原 14px 图标
  裸放——与机器人行头像列没对齐）。
- **隐藏区** = roster-pane-content :137-172：`border-t` 分隔 + caret +
  font-medium（**非大写**）+ 计数尾缀；**删掉额外恢复钮**——恢复走行右键
  「取消隐藏」（隐藏行本体照常渲染 + eye-closed 标记，hermes 同款）。
- **拖拽落区** = SectionDropZone：拖拽飞行中全部合法落区 `ring-inset`
  淡描（BotsPane 持 draggingBot state，行 dragstart/dragend 上报——hermes
  $draggingBot 同构），悬停中块 `bg-accent/10 ring-accent` lit；源块
  （isSource）不描不接收。原只亮段头删除。

实机验证（CDP）：搜索 opacity 0.5→1→0.5 + 清空钮、段头折叠行 1→0→1、
段头 px 7.5/py 5.625/大写/字距全对（15px 根字号）。门禁 tsc 0 / vitest 734。

**✅ 2026-11-07（续）：多环境配置 + pi pkg 做成插件——落地并实机验证 + 完整对齐收尾**。
- **永久会话**（bot-launch.ts 重写）：BotPreset 加 `chatSessionPath`——首启
  `pi_create_bot_session` + `pi_list_sessions` 按 bot 名找到会话文件路径存入；
  再启 `pi_open_session` 打开同一条（上下文保留 = "This chat never resets"
  的宿主对偶，纯前端不改引擎）。会话文件被删时退回首启（路径清空重建）。
- **群聊**（假面标红）：bot-stub-store 加 groupChats（本地 log）+ CreateGroupDialog
  （群名+成员多选≥2）+ GroupChatWorkspace（pane body 替换：头+标红提示条+log
  +发送框+成员条）+ 花名册群聊行 + New… 下拉新建群聊项。机器人互发不发生——
  发送写本地 log，UI 全标红。
- **克隆机器人**（真）：右键复制预设（新名+新 createdAt，不复制 chatSessionPath）。
- **与此机器人开新聊天**（真）：另起一条普通会话（不动永久会话）。
- **打开屏幕**（假面禁用）：红显"未接通"。
- **活动通知铃**：切偏好存 localStorage，标红"派发未接通"。
- **New… 下拉**：hermes roster-pane-toolbar 同位——新建机器人/新建群聊/新建分区
  三项（goo Popover 同体系）。
- **插件体系**：`src/contrib/` 三文件（types/context/plugins）——hermes
  contrib 模型的最小复刻（Contribution/HarnessPlugin/PluginContext，贡献
  id 自动 `plugin:<id>:` 命名空间）；首批 bundled 插件 = mirach-connections
  + mirach-pkg。
- **连接注册表**（pi_connections.rs + connections-registry.tsx）：v2 模型
  完整（local 恒在不可删 / label 查重 / URL·ssh 端点查重 / primary 重定向
  / 坏文件 local-only 兜底），hermes connections-registry.tsx 的列表行 /
  内联编辑器 / Test/Make primary/Edit/Remove 移植。local = 真面（test 走
  引擎快照），remote/cloud/ssh = 假面标红"远端 gateway 未接通"。
- **包管理**（pi_pkg.rs + pkg-manager.tsx）：直调 vendored PackageManager
  blocking 面（install/remove/update/list + add/remove_package_source），
  全真实数据（源列表同步落 settings.json 上游通道）。
- **设置页接线**：settings-overlay 消费 settings.page 贡献（SectionId 加
  `plugin:${string}` 动态臂 + 插件集成组动态填充 + render 分流）。
- 实机验证：IPC 全通（list/save/remove/test/local 真测/remote 假面 stub）；
  设置窗口导航含连接+包，连接页渲染+添加连接+存档持久化+清理全通；包页
  渲染+空态。门禁 tsc 0 / vitest 734 / cargo test 128 / cargo check 0。
- 设计文档（源码锚点）= `docs/HANDOFF-multi-env-pkg.md`。

**对话层对齐（ZCode v4 全链路）至此全部完成**：轮层 / 轮级操作条 / 时间线
标记 / 轮尾文件汇总 / 工作段折叠 / 轮导航器 / 框选工具条 / 会话内查找 /
子代理单行 / 工具组跨 reasoning。机器人页 = hermes Bot Mode 的宿主对偶。
真模型端到端仍是唯一硬阻塞（DEEPSEEK_API_KEY 401）。

**⚠️ 实机事故记录（2026-11-03）**：造测试夹具时探针脚本按 mtime 挑"最新
会话文件"，误覆盖了 `2026-10-26T05-10-13.592Z_c7e53723.jsonl`（用户的
会话「1」）。已按当时记录的元数据忠实重建（header 原样 + 一条内容 "1" 的
user 消息），但**若原会话还有其它条目（model_change / 多轮），已不可恢复**。
教训（已写进夹具脚本）：**写会话文件必须按 sessionId 精确匹配文件名，绝不
按 mtime 挑**。

**✅ 2026-10-30：「技能与工具」页 hermes 真搬移植，全部按最新上游源码**
（用户定稿）。四道门禁全绿（tsc 0 / vitest 567 / cargo check 0 / cargo test 87），
四个 tab 已实机验证。

镜像纯度：**485 文件正文与 `apps/desktop` 逐字一致**，唯一差异是
`i18n/zh.ts`（补了上游缺失的 connectorsPage 中文，207 键）。守卫脚本
`node scripts/audit-mirror2.mjs`（AST 比对，import 前缀改写不算差异）。

页面行为**完全等于上游默认**：卡片网格布局 · 单 profile 时环境下拉框隐藏 ·
已安装条目追加在目录末尾 · tab 左对齐。此前按用户逐项选择加的三条偏离已全部
回滚（`scripts/host-patches.mjs` 已删）。

**镜像重建后必须重打的手写文件**（`hermes-mirror.mjs` 先删后拷）：
`i18n/zh_connectors_page.ts`、`lib/text.ts`、`scripts/hermes-cluster1-stores.mjs`
拷入的上游 store 原件。

细节与**实机暴露的 4 个真实 bug**（tab 点击失效 / 整页英文 / 上游 zh 缺
connectorsPage / 73 令牌+13 类未定义）见 `docs/HANDOFF-hermes-port.md`；
那份文档也记了两个**按上游保留的已知缺陷**（宿主 10 万条目录下已安装技能被
分页截断、单 profile 环境下拉框隐藏）。

**桌面壳跑在 Tauri 3.0.0-alpha.4 + wry（WebView2）上，三栏 dockview 布局、
pi 真引擎（AG-UI HTTP+SSE）全链通。**

- 最近一次换栈（2026-10-22）：运行时从 `tauri-runtime-cef` **换回
  `tauri-runtime-wry`**。CEF 相关代码、二进制、缓存已删净；CDP 走
  `additionalBrowserArgs`（9223）。
- 窗口几何（2026-10-22，照搬 hermes）：首屏 = 屏幕工作区 × 0.88，夹在
  1280×820 ~ 1760×1100；**尺寸/位置/最大化态存 `window-state.json`**
  （`%APPDATA%\com.mirach.harness\`，原子写、坏档判废、离屏坐标丢弃）。
  栏宽是定值 **300 / min 270 / max 400**，窗口缩放时钉回绝对宽。
- 冒烟（2026-10-22，wry）：窗口起来、三栏几何正确（左/主/面板）、
  dockview CSS 全在、IPC 通（`pi_list_sessions` 返回 22 条）、零 console 错误。
- 窗口边缘（2026-10-23）：修掉"黑线直角边"——真因是 Win11 的 DWM 1px 描边
  （`DWMWA_BORDER_COLOR`），不是阴影也不是 CSS；同时子类化 `WM_NCCALCSIZE`
  抹掉 tao 预留的 resize 边框，**顺带修掉窗口尺寸逐轮膨胀**
  （1760 → 1824 → 1872）。细节见 `AGENTS.md`「窗口边缘那圈线」。
- 设置页（2026-10-23）：左导航重组为 5 组 20 项（基础设置 / Agent 控制 /
  安全与数据 / 插件集成 / 关于）。**动效与结构来自 beui `animated-sidebar`
  的本地裁剪版**（`src/components/motion/animated-sidebar.tsx`：删掉 Provider
  状态机 / Ctrl+B 快捷键 / 移动端抽屉与 body 滚动锁 / 折叠态，保留全部菜单项
  与子选项 + `layoutId` 滑动 pill + `clip-path` 子级 stagger）。4 节接真数据
  （模型 / 记忆 / 安全 / 版本与更新），16 节是**写明原因的占位**。
- 设置独立窗口（2026-10-23）：设置页改为**真 OS 窗口**（能拖出壳、可 alt-tab、
  可独立缩放）。新增 `pi_open_settings_window` / `pi_close_settings_window`；
  `main.tsx` 落地 `?win=settings` 分派；`wire_window` 抽为两个窗口共用的装配
  （DWM 四步 + 子类化 + 事件 + 首屏落盘）。同时修掉 4 处单窗口假设
  （wndproc 单槽 → map、几何存档按 label 分文件、capabilities 加 label、
  browser args 必须与主窗一致）。细节见 `AGENTS.md`「多窗口」。
- **设置窗首屏提速 + 白屏/黑屏（2026-10-30）**：用户报"打开设置要等很久，
  先白屏再黑屏然后出页面"。CDP 实测设置窗首个文档 **198 个 `/src/` 模块、
  144 个来自 `components/`**（含 dockview / assistant-ui / thread.*，全是主窗
  聊天的东西），First paint **2988ms**。根因是 `main.tsx` **静态 import 了
  `App` 整棵树**——静态 import 在模块图求值阶段无条件加载，与"只渲染
  `SettingsWindowRoot`"无关。改成按 `?win=` 分支**动态 import** 后：
  33 个模块 / First paint 356ms / FCP 788ms。白屏黑屏另有两个成因：
  `html, body { background: transparent }`（`base.css:18`）让 WebView2 先露
  默认白底、样式生效后露合成器黑底。修法 = `index.html` 内联首屏底色 +
  `base.css` 把 `html,body` 底色改成 `--surface-shell`。
  **不要为了简洁把 main.tsx 改回静态 import。**
- 设置入口三形态（2026-10-23）：桌面 → 独立窗口；浏览器直开 → 壳内浮层
  （`invoke` 在浏览器里必抛 TypeError，不能走窗口路径）；移动端 → 运行时问
  `supportsMultipleWindows()`（Android 12L+/iPad 支持窗口，iPhone 退回浮层）。
  决策抽成纯函数 `lib/settings-shell.ts` + 6 条单测。**web 端已实测**：
  浮层可打开、20 项齐全、IPC 失败显示可读文案。
- 门禁：`tsc` 0 / `vitest` **577** / `cargo test` **86** / `cargo check` 0
  （仅一条上游 agui.rs 递归深度 warning）。

- **审查面板完整复刻（2026-10-27）**：旧简化版整体替换为 hermes 桌面端
  `apps/desktop/src/app/right-sidebar/review/` 的逐文件移植
  （`src/components/panes/review/`：index / file-tree / scope-row /
  ship-bar / churn-bar / tree-data）。配套：
  - `review-store.ts` 按上游 `store/review.ts` 逐字段重写（zustand）：
    scope（未提交/分支/上一轮）、树/列表持久化、seq 守卫 + 100ms 防抖、
    轮次基线表（lastTurn 的 baseRef）、ship 流。
  - Rust `fs_git_*` 扩到上游语义：`review_list/diff` 带 scope+baseRef
    （`branch` 用 merge-base，`lastTurn` 用 baseRef）、新增
    `fs_git_rev_parse` / `fs_git_commit_context` / `fs_git_create_pr`；
    `fs_git_commit` 补"无暂存先 add -A"与 `push -u`；`fs_git_ship_info`
    的 `ghReady` 改为 **gh 已认证**（`gh auth status`，上游同义）。
  - 状态归约照抄上游：porcelain 两列保留、`status_letter` 单字母、
    `is_staged` 看 index 列（有单测守着）。
  - 新增原语：`components/ui/codicon.tsx`（@vscode/codicons 字体，与上游
    同源）、`diff-count` / `segmented-control` / `split-button` /
    `generate-button` / `confirm-dialog` / `tip` / `chat/skeletons` /
    `chat/diff-lines`（FileDiffPanel + shiki 高亮 + 固定行窗口化）/
    `hooks/use-delayed-true`；`tokens.css` 补 `--ui-green` / `--ui-red` /
    `--ui-diff-*` / `--ui-bg-tertiary` 等别名。
  - **如实不做的两处**（各有就地注释）：AI 生成提交信息（宿主无会话外
    一次性 LLM 端点 → 按钮 disabled + 说明）、「交给 agent 提交」（宿主
    composer 无 action 注入面 → 不渲染）。
  - 实机验证（CDP）：面板挂载、树/列表切换（6 顶层 → 48 行）、三个 scope
    切换与只读提示、真实 727 个变更文件与目录聚合、62KB diff 渲染、
    还原确认框。调试句柄 `window.__reviewStore`（与 `__dvApi` 同惯例）。

- **技能与工具完整复刻（2026-10-27）**：旧两 tab 简化版替换为 hermes 桌面端
  `apps/desktop/src/app/capabilities/` 的结构 —— `src/components/panes/capabilities/`
  （index 页壳 + skills-tab + toolsets-tab + unavailable-tabs + catalog/ 全套
  12 个文件）。四 tab：技能 / 插件 / 连接器 / 工具集。
  - **技能**：接 `pi_capabilities` IPC（真实装载结果）；开关走
    `pi_set_skill_enabled`（落 `~/.pi/agent/harness-capabilities.json`），
    编辑走 `pi_read_skill` / `pi_write_skill`，归档走 `pi_delete_skill`。
  - **工具集**：17 组（宿主对 pi 内置工具的语义分组投影，UI 如实说明
    "pi 本身没有 toolset 概念"），开关走 `pi_set_toolset_enabled`，只影响新会话。
  - **插件 / 连接器 = pi 真实能力**（2026-10-27 用户纠正"引擎侧有插件系统
    和 mcp 啊"——此前我写成"宿主暂无"是错的）：
    - **连接器 = MCP 服务器管理**（`src-tauri/src/pi_mcp.rs`）：
      `pi_mcp_servers` 分层读配置（`.pi/mcp.json` → `.agents/mcp.json` →
      `~/.pi/agent/mcp.json` → 外来文件，走 pi 自己的
      `McpDiscovery::discover`）、`pi_mcp_upsert_server` /
      `pi_mcp_remove_server`（`write_project_config` read-modify-write）、
      `pi_mcp_test_server`（`McpManager::test` **真起进程/发 HTTP**）。
      宿主会话侧本来就每轮调 `sync_extension_mcp_registrations()`。
    - **插件 = pi 扩展管理**（`pi_extensions`）：扫
      `~/.pi/agent/extensions/*` 与项目 `.pi/extensions/*`，用
      `load_extension_manifest` 读清单（id / 版本 / 运行时 / 能力声明），
      解析失败如实透出。**不做启停开关**——pi 的扩展在会话启动时装配，
      运行中开关不生效（页面上写明"新建会话才生效"）。
    - hermes 那两页的 hosted SaaS 账户面（它的网关 OAuth）宿主确实没有，
      页头如实说明。
  - **技能中心（catalog）数据源 = GitHub awesome 清单**（用户定稿："用
    Awesome 代替"）：`AWESOME_SOURCES` 表，skills = awesome-claude-code
    （实测 252 条 / 32 分类）、plugins = awesome-mcp-servers（4636 条）。
    解析器 `parseAwesomeMarkdown` 认三种条目形态（裸条目 / `- 描述` /
    `by [作者](url) - 描述`），`## 标题` 成分类，元信息节整节跳过（有单测）。
    **清单条目不可安装**（pi 无 hermes hub 协议）→ 卡片给"打开仓库"。
  - 配套新增：`components/ui/` 的 `switch` / `alert` / `row-button` /
    `search-field` / `masonry` + `Button` 的 `text|chip` variant 与
    `text|inline` size；`styles/catalog.css` / `catalog-discovery.css` /
    `page.css` / `masonry.css`；`src/assets/catalog-wing-retro.svg`；
    `--ui-chat-bubble-background` / `--ui-text-primary` 等令牌别名。
  - **`lib/query-cache.ts`**：宿主没有挂 TanStack Query 的 Provider，为一个
    页面加全局 Provider 不划算 → 实现同语义的最小查询缓存（并发去重 /
    staleTime / 失败停在错误态 / 空闲预热）。将来真接 RQ 时换薄适配即可。
  - **CSP 放开**（`tauri.conf.json`）：`connect-src` / `img-src` 增加
    `raw.githubusercontent.com`、`*.githubusercontent.com`、`github.com`、
    `api.github.com` —— 清单要直连 GitHub 拉取，原 CSP 只放行本地回环。
  - 实机验证（CDP）：四 tab 切换、技能中心 75 张卡 / 10 个分类货架 / 精选
    滑块 / 分类 chip（+29 折叠）、搜索（"mcp" → 37 张）、工具集 17 卡片
    17 开关且真实写盘、插件 tab 的如实标注。

- **定时任务完整复刻（2026-10-31）**：hermes 的 `cron/`（43 个 Python 文件 /
  19,009 行）在 Rust 侧重写为 **`src-tauri/src/pi_cron.rs`**（自包含模块，
  可整体摘除），前端从 `apps/desktop/src/app/cron/` **逐字复制**进
  `src/hermes-mirror/app/cron/`（6 个文件）+ 侧栏区
  `chat/sidebar/cron-jobs-section.tsx`。
  - **为什么不是 pi 扩展**（先查过事实）：扩展生命周期绑会话
    （`ExtensionRegion` 归 `AgentSessionHandle`，`sdk.rs:3586` 的
    `has_extensions` 要求会话传了 `extension_paths`），而调度器必须在
    **没有会话时**触发——根本矛盾。宿主也**没有前端插件系统**
    （`src/contrib/` 只有 `.gitkeep`）。所以"插件式集成"的实际形态 =
    独立文件 + 独立 `pi_cron_*` IPC + 独立存储 + 独立面板。
  - **后端**：`~/.pi/agent/cron/{jobs.json, executions.jsonl, output/, sessions/}`。
    jobs.json 原子写（tmp + rename + fsync）；executions.jsonl 追加式
    （崩溃半行可跳过）；调度四种语法照抄上游 `parse_schedule`
    （裸时长=重复 / `in 30m`=一次性 / 自然语言周几 / 5 字段 cron / ISO 时间戳），
    cron 表达式是自写引擎（**不引新 crate**，字母月份显式拒绝而非当 0）。
    60s ticker 走 std 线程（pi future 不能进 tokio），**先持久化推进
    `next_run_at` 再执行**（at-most-once，上游 `scheduler_tick.py:160` 同款）；
    每作业运行权守卫（内存 BTreeSet，等价上游 fire_claim CAS 的单进程版）。
  - **执行**：独立会话（`SessionOptions.session_dir` = `<cron>/sessions`，
    不碰用户活动会话），600s 不活动看门狗（上游 `_cron_inactivity_seconds`
    默认值），输出文档落 `<cron>/output/<job>/<时间戳>.md`，台账记
    `claimed → running → completed|failed`。**失败如实传播**：实测 deepseek
    key 无效时返回 `success:false` + 完整 provider 错误，作业记
    `last_status=error`。
  - **数据面**：`src/hermes-shim/api/cron.ts` 把上游 REST 换成 `pi_cron_*`
    IPC，**形状保持上游 snake_case**（`schedule_display` / `next_run_at`）——
    Rust 内部 `Job` 是 camelCase，`job_to_wire()` 做投影层。不投影的表现是
    "频率/上次/下次"全显示 `—`（实测踩过）。
  - **有意的裁剪**（每条都写进代码注释）：投递只有 `local`（宿主无
    Telegram/Discord/Slack/Email 适配器）；monitor/wake gate 脚本闸门未做。
  - **蓝图 16 个全部实现**（2026-10-31 补，先前的"返回空数组"裁剪已推翻）：
    核实后 16 个里只有 5 个带 `skills`，其余 11 个是纯 prompt 模板。处理 =
    全部照抄 + 去掉 `skills` 字段 + 把"跑某个技能的过程"改写成自包含指令。
    顺带修正一个**上游数据 bug**：`competitor-watch` 的 `recurrence` 槽是
    `weekdays` 类型（options = everyday/weekdays/weekends），上游默认值却写成
    `"monday"`——上游自己用默认值填槽也会抛 `unknown recurrence 'monday'`。
  - **补了 4 个上游 zh 缺失键**（i18n 三件套例外）：
    `lastRunFailed` / `editJob` / `runAgain` / `overdueSince`——缺失时界面
    中英混排（实机看到 "Last run failed: / Edit job"）。
  - **实机验证**（CDP）：入口条点击 → 页面渲染（`定时任务 / 0 个任务 /
    暂无排程任务`）；建作业 → 列表出现（`每 1 小时 / 下次 2026/10/31
    05:48:01`）+ 侧栏 `CRON JOBS` 区；暂停 → `state=paused`；恢复 →
    `scheduled`；立即触发 → 真跑 agent（凭据无效 → 失败横幅 + 台账两行 +
    会话文件 + 输出文档）；删除 → 列表清空。
  - **蓝图 UI 验证**（CDP + 真实鼠标事件）：蓝图区 16 行全部渲染
    （`data-panel-row="blueprint-*"`）；点 `hydration-move` → 编辑器弹出，
    槽位正确（How often / Start hour / End hour / Where to deliver）；点
    「安排任务」→ 对话框关闭、任务数 1→2、后端 `0 9-17/1 * * 1-5`
    （**小时字段步长生效**，不是退化的每分钟）。
  - 门禁：`tsc` 0 / `vitest` **595**（47 文件）/ `cargo test` **122** /
    `cargo check` 0。镜像纯度 `SAME 503 / INTENTIONAL 3 / DEV 0`。

## 未做清单

1. **真模型端到端（唯一硬阻塞）**：配凭据后验证工具真数据形状、图片理解、
   压缩真触发、用量成本真数字、thinking 流式、自动命名 LLM 段。
2. **设置页**（用户自己做）：hermes 的 115 个 settings 文件全量在树里，
   切面见 `AGENTS.md`「待办 2」。
3. **最后一波接线**：message-queue / checkpoint UI / cost-meter /
   read-aloud / regenerate-menu。
4. **pi 0.6.x 升级**（breaking：MCP project_trusted）——等真模型基线。
5. **谱系树嵌套**（`list_sessions` 透出 `branchedFrom`）。
6. **终端保活**：面板级 `renderer:'always'`（2026-11-18）已解决"同组切标签
   卸载 → 终端会话结束"；剩余**跨布局重建/重启**的会话恢复 = ZCode 式模块级
   registry，独立一轮。
7. 人工验收 + i18n + L5 移动端。

## 环境速查

```bash
# 开发（vite 1430 + tauri 窗）
set "PATH=%USERPROFILE%\miniconda3-mirach\Library\bin;%PATH%"
npm run tauri dev

# 全量重编（换依赖/运行时后，避免并行 OOM）
cd src-tauri && cargo build -j 1

# 门禁
npx tsc --noEmit
npm test
cd src-tauri && cargo test
```

- CDP：`127.0.0.1:9223`（`curl 127.0.0.1:9223/json/list` 看 page target）。
- 布局存档：localStorage `mirach.harness.layout.v10`；栏旗标
  `mirach.harness.layout.colflags.v1`。要出厂形态就删 v10 再 reload，或右键
  「默认布局」。
- 应用数据：`%LOCALAPPDATA%\com.mirach.harness`（WebView2 的 `EBWebView/`）、
  `%APPDATA%\com.mirach.harness\session-meta.json`。
- 终端 PTY / AG-UI 端口在启动日志里（`[agui] listening on 127.0.0.1:<port>`）。

## 验证习惯（别省）

- **行为验证走真实 UI 路径**（真鼠标 `Input.dispatchMouseEvent` / 真实菜单
  点击）——CDP 动态 import 项目模块会拿到第二个模块实例，模块级状态不共享
  （AGENTS 陷阱 9）。
- 断言侧栏内容查行 DOM，不查 body 全文（消息气泡同文会假阳性）。
- 行级交互（切换/拖拽）必须用真实鼠标事件；合成 click 不可靠。

# 交接快照：多环境配置 + pi pkg 做成插件（2026-11-07 调研定稿，实现未开工）

> 用户原话："将hermes的多环境配置配合pi本身的pkg，做成插件，完整复刻"
> （结合上一句语境——"可以做假ui，但是标红显示"的纪律**同样适用本任务**）。
> 本文是 Explore 调研的完整结论（两边源码逐行核对过），实现从本文接手。

## 0. 一句话设计

宿主**新建插件体系**（hermes `contrib` 模型的最小复刻）→ 第一个插件
`mirach-connections`（hermes 多环境连接注册表的宿主移植）+ 第二个插件面
`mirach-pkg`（pi PackageManager 的管理 UI）→ 机器人页的花名册按连接分组
（hermes 的 roster = profile × connection 同构）。

## 1. hermes 连接注册表（多环境）——移植蓝图

### 数据模型（`apps/desktop/src/global.d.ts:1153-1247` + `electron/connection-registry.ts`）

- `DesktopConnectionKind = 'cloud' | 'local' | 'remote' | 'ssh'`（:1153）。
- `DesktopRegistryConnection`（:1157-1182）：`id / kind / label（registry 内
  唯一、大小写不敏感）/ url? / authMode?: 'oauth'|'token' / org? / host? /
  user? / port? / keyPath? / remoteHermesPath? / remoteProfile? / tokenSet /
  tokenPreview / headerNames?`。
- 注册表（:1184-1198）：`{ version: 2, primary（拥有窗口后端的连接 id）,
  launchMode?: 'last-used'|'primary', lastUsed?, secureTokenStorage,
  connections[] }`。
- **恒有且仅有一个 `local` 连接**（connection-registry.ts 头注释 12-24）：
  不可删除、默认 primary；删 primary 重定向到 local。
- 去重规则（connections-registry.tsx:126-166）：local 至多一个；remote/cloud
  按 normalize 后 URL 查重；ssh 按 `user@host:port` + remoteProfile。
- 隔离区：坏条目原样保留（cap 20），坏文件不删留 sidecar。

### 传输（electron/）

- local = 自带 gateway 后端；remote/cloud = 直连 WebSocket（OAuth 网关先铸
  单次 WS ticket）；**ssh = `ssh -N -L` 本地隧道（只绑 127.0.0.1）+ 隧道端口
  上的本地 WebSocket**，远端 `hermes serve --isolated --port 0` 就绪抓取
  （remote-lifecycle.ts，120s 预算）。
- **宿主对偶**：pi 无远端 gateway——remote/cloud/ssh 三种传输**做假 UI 标红**
  （连接条目/表单完整，Test 钮红标"远端 gateway 未接通"）；`local` 是真实
  面（宿主本机就是 pi 引擎宿主）。token 存储走**既有 pi_vault.rs**（OS
  keyring），不用 Electron 加密文件。

### 设置页 UI（`apps/desktop/src/app/settings/connections-registry.tsx:219` 起）

- KIND_ICONS：cloud=Cloud / local=Monitor / remote=Globe / ssh=Terminal（:30-35）。
- 列表行：图标 + label + `Current/Primary/Managed` 徽章 + 描述（`kind · url`
  或 `kind · user@host:port`）+ 动作 **Test / Make primary / Edit / Remove**
  （Edit+Remove 仅 kind !== 'local'，:654-674）。
- 内联编辑器（:695-873）：创建时 kind 四选（**创建后固定**）；local 在已有
  托管 local 时禁选；remote/cloud 走 RemoteSetupFields（OAuth 可保存前登录）；
  ssh = `user@host:22` 复合输入 + 远端 hermes 路径；额外 headers 编辑器
  （Cloudflare Access）。
- Launch mode 开关（:914-924 last-used vs primary）+ "Update all" 扇出 +
  明文 token 同意框（无 keyring 机器）。

### 与机器人页的接缝

- 花名册行 = profile × connection（`DesktopRosterAgent`，:1226-1247，handle =
  `@name-device` 防重名）。宿主：bots 花名册按连接分区（现有分区体系之上或
  并列），bot 预设加 `connectionId` 字段（默认 `'local'`）。
- 选择连接 = 两阶段拨号（`selectConnection`，src/store/connections.ts:389-613：
  Phase 1 dial + OAuth 保护读，Phase 2 beginGatewaySwitch 屏障）。宿主只有
  local 真面——**切连接时 local 即时生效，其余标红**。

## 2. pi pkg 体系——管理 UI 的数据源（全部真实可接）

- `PackageSource`（config.rs:677-688，untagged）：字符串 `"npm:foo@1.2"` /
  `git:host/owner/repo[@ref]` / 本地路径，或对象 `{source, local?, kind?}`。
  settings.json 字段 `packages: Option<Vec<PackageSource>>`（:241，全局+项目
  两 scope）。
- `PackageManager`（package_manager.rs:127+）：`install`（:283，npm install -g
  / 项目 --prefix / git clone 进 `~/.pi/git` 或 `.pi/git` + 子目录 npm
  install）/ `remove`（:331）/ `update_source`（:364，git fetch --prune +
  reset --hard @{upstream}）/ `list_packages`（:452）/ `resolve`（:668，三
  趟：settings 声明 → 本地资源条目 → 标准目录自动发现）。
- Lockfile：`pi.package_lock.v1`（:144-168），条目含 `digest_sha256` +
  `trust_state`；信任审计 `pi.package_trust_audit.v1`（:209-239）。
- 四类资源：extensions / skills / prompts / themes（resources.rs:267+，
  `ResourceLoader::load` 已在宿主 pi_extensions.rs 接过）。
- **CLI 没有 `pi pkg` 命令**——平铺：`pi install/remove/update/list` +
  `pi info/search`（cli.rs:2325+）。
- **Rust 侧零新逻辑**：新 IPC 直调 PackageManager pub 面（install/remove/
  update_source/list_packages/resolve），全部走 `on_big_stack`（spawn npm/git
  子进程，16MiB 栈纪律）。**禁止自己解析 settings.json**——
  `add_package_source_sync` / `remove_package_source_sync`（:881-926）是
  官方写入口。

## 3. "做成插件"——宿主需要先建插件体系

宿主 `src/contrib/` 只有 .gitkeep（无插件系统）。按 hermes 模型建最小版：

- `contrib/types.ts`：`Contribution { id, area, source?, title?, order?,
  when?, render?, data? }`（hermes contrib/types.ts:25-51 逐字段照抄）；
  `HermesPlugin { id, name?, description?, defaultEnabled?, register(ctx) }`
  （contrib/plugin.ts:181-194）。
- `contrib/context.ts`：`PluginContext.register/registerSettingsPage/storage/
  onDispose` + id 命名空间（`${pluginId}:${c.id}`，hermes :348-375）。
- `contrib/plugins.ts`：bundled 插件注册表（`import.meta.glob` 官方同款；
  首批两个：`mirach-connections` / `mirach-pkg`）。
- **cron 先例不翻案**：pi_cron 保持自包含模块不动；新子系统走插件面。
- 首批贡献区（area）：`settings.page`（连接注册表页 + pkg 管理页挂设置页）
  + `bots.roster.grouping`（花名册按连接分组的数据贡献）。

## 4. 实现清单（下一轮从这接）

1. **Rust**：`pi_connections.rs`（registry 存取 + test IPC；token 进
   pi_vault）+ `pi_pkg.rs`（install/remove/update/list/resolve IPC）。
   门禁：cargo test（registry 校验/dedupe/local 不可删/v1 隔离区）。
2. **插件体系**：`src/contrib/` 三文件（types/context/plugins）+ 设置页
   贡献区接线（settings-overlay 的 NAV_GROUPS 挂 `plugin:<id>:<page>`）。
3. **connections 插件 UI**：ConnectionsRegistrySection 移植（Test 钮对
   local 走 pi_endpoint_validate 真测；remote/ssh/cloud 标红"远端 gateway
   未接通"）。
4. **pkg 插件 UI**：安装（source 字符串输入）+ 列表（lockfile 条目：identity/
   source_kind/resolved/digest/trust）+ 移除/更新 + 四类资源计数。全部真实
   数据（PackageManager IPC）。
5. **机器人页接缝**：BotPreset 加 `connectionId`（默认 'local'）；花名册按
   连接分组（单 local 时与现状无差别）；连接编辑器进弹出栏工具条。
6. **假 UI 标红纪律**：`StubNote`（红字"未接通"）+ 菜单项 disabled 红——
   remote/ssh/cloud 的 Test/Dial、Screen、DM relay。

## 5. 已确认的源码锚点（实现时直接引用）

- hermes：connections-registry.tsx:219/618-693（行）/695-873（编辑器）/
  126-166（去重）；connection-registry.ts:40-106（存储形）；global.d.ts
  :1153-1247（渲染形）；store/connections.ts:389-613（两阶段切连接）。
- pi：package_manager.rs :283/:331/:364/:452/:668/:881-926；config.rs:241/
  :677-688；resources.rs:267-339；cli.rs:2325+（命令语义文案）。
- 宿主已有面：pi_vault.rs（token/keyring）、pi_endpoint_validate（真测）、
  pi_extensions.rs（ResourceLoader 消费先例）、pi_cron.rs（自包含模块先例
  ——本任务改走插件面，cron 不迁移）。

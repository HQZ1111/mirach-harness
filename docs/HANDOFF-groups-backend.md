# 交接文档：hermes 群聊后端 → Mirach Rust 移植

> 写给下一个 agent（ZCode）。**先读完本文再动手。**
>
> 生成时间：2026-11-15。执行者：前一个 agent（在 Mirach 宿主进程内运行，无法重启宿主）。

---

## 0. 一句话现状

**后端语义层 100% 完成**（17,949 行 Rust，26 个文件，659 个测试全绿）。
**剩下的是接线**：贴回主仓库 → 重启宿主 → 前端接 invoke → 实机验证。

---

## 1. 前因后果（为什么会有这个工程）

### 1.1 用户最初的需求

用户说：「把 hermes 的 bots 插件完整复制，做成 Rust 插件，现在的做的不行」。

### 1.2 关键的技术调研结论（**这些结论花了大量时间才厘清，不要重走**）

**结论 A：rpi 的 Rust 插件 ABI 没有 GUI 能力。**

查过 `G:\pi-rust-main\crates\rpi-plugin-sdk\src\lib.rs`：

```rust
/// message/entry handlers return `{text:"...",markdown?:true}` or `{lines:["..."]}`
pub type RenderFn = extern "C" fn(input_json: StbStringRef, out: *mut StbString, ...) -> i32;
```

插件能注册的渲染器只有三类：`register_message_renderer` / `register_markdown_transformer` / `register_entry_renderer`，全部返回**终端文本行**。

`ExtensionPanel`（`UiComponent = 22`）是只读的：

```rust
pub struct ExtensionPanel {
    pub lines: Vec<String>,              // 纯文本行
    pub highlights: Vec<PanelHighlight>, // 只能是 Warning | Error 上色
}
```

**没有**键盘回调、点击回调、拖拽、焦点。所以 hermes bots 那 41.8k 行 React/TSX **不可能**变成 rpi Rust 插件。

**结论 B：hermes 群聊的复杂度在后端，不在前端。**

`D:\hermes-agent-main\gateway\hosted_room_*.py` 共 19 个模块 / 9,330 行。这才是真正的业务逻辑：

| 模块 | 行数 | 职责 |
|---|---|---|
| `hosted_rooms.py` | 1,442 | 房间状态 + append-only 事件日志 |
| `hosted_room_attachments.py` | 1,364 | 附件（magic 嗅探/配额/blob） |
| `hosted_room_discussion.py` | 1,057 | 讨论规划（**纯函数、确定性**） |
| `hosted_room_driver.py` | 1,033 | 8 态任务状态机 + 租约 fencing |
| `hosted_room_work_records.py` | 703 | 工作证据 |
| `hosted_room_peer.py` | 562 | 跨网关 HMAC grant |
| …其余 13 个 | … | 路由/lead/上下文/策略/副本/链接 |

**结论 C：所以选了「后端照抄进 Mirach 的 Rust 侧」这条路。**

- 后端 9,330 行 → Rust（本文档交付的内容）
- 前端 41.8k 行 → 将来逐字复制进 `src/mirach-harness/src/hermes-mirror/`
- 模型调用 → 交给 rpi 已有的单会话 harness

---

## 2. 已经做完了什么

### 2.1 交付物位置

**开发位置（副本，已验证可编译可测试）**：
```
G:\mirach-verify\src-tauri\src\hosted_rooms\   ← 25 个模块
G:\mirach-verify\src-tauri\src\pi_groups.rs    ← 1 个 IPC 层
```

**为什么在副本里开发？** 见 §4.1「自己改自己」问题。这个副本里 `cargo test` 完全可用。

### 2.2 26 个文件的职责

| 文件 | 行数 | 上游对应 | 完成度 |
|---|---|---|---|
| `common.rs` | 457 | `hosted_rooms_common.py` | ✅ 叶子工具 |
| `store.rs` | 1,189 | `hosted_rooms.py` | ✅ 8 表 + 事件日志 |
| `driver.rs` | 1,108 | `hosted_room_driver.py` | ✅ 租约 + 8 态表 |
| `driver_ops.rs` | 1,553 | 同上 | ✅ 全部状态迁移 |
| `discussion.rs` | 1,221 | `hosted_room_discussion.py` | ✅ 名册/载荷/提及 |
| `decision_engine.rs` | 1,144 | 同上 | ✅ 事件校验 + 水位 + task id |
| `plan.rs` | 853 | 同上 `plan_next_task()` | ✅ 顶层编排 |
| `router.rs` | 719 | `hosted_room_router.py` | ✅ 自动路由 + Continue |
| `lead.rs` | 416 | `hosted_room_lead.py` | ✅ 主机器人分派 |
| `context.rs` | 371 | `hosted_room_context.py` | ✅ purpose/notes/routing |
| `execution_policy.rs` | 432 | `hosted_room_execution_policy.py` | ✅ sha256 签名策略 |
| `task_input.rs` | 185 | `hosted_room_task_input.py` | ✅ 有界输入引用 |
| `work_records.rs` | 827 | `hosted_room_work_records.py` | ✅ 完整校验 |
| `work_capture.rs` | ~700 | 同上 capture + 附件 blob | ✅ 捕获编排 + 原子写 |
| `delivery.rs` | ~750 | 同上 delivery + `work_storage.py` | ✅ 两阶段投递 + ACK |
| `work_lineage.rs` | 216 | `hosted_room_work_lineage.py` | ✅ 证据对归属 |
| `authority_history.rs` | 408 | `hosted_room_authority_history.py` | ✅ 归属链重放 |
| `policy_checkpoint.rs` | 493 | `hosted_room_policy_checkpoint.py` | ✅ 9 张投影表 |
| `attachments.rs` | 680 | `hosted_room_attachments.py` | ✅ magic/MIME/配额/base64 |
| `peer.rs` | 905 | `hosted_room_peer.py` | ✅ HMAC-SHA256 grant |
| `replicas.rs` | 659 | `hosted_room_replicas.py` | ✅ 幂等/无缺口/epoch |
| `links.rs` | 561 | `hosted_room_links.py` | ✅ 链接存储 + grant 红化 |
| `adapters.rs` | ~430 | `hosted_rooms.py` SQL 部分 | ✅ 停止/换权/探测/回执 |
| `controls.rs` | 487 | `session_group_controls.py` | ✅ 20 个方法契约 |
| `mod.rs` | 79 | — | 模块地图 |
| `pi_groups.rs` | ~660 | — | IPC 命令面 |

### 2.3 已验证的事实

```bash
cd G:\mirach-verify\src-tauri
$env:PATH = "C:\Users\Administrator\miniconda3-mirach\Library\bin;$env:PATH"
env -u CARGO_MANIFEST_DIR cargo test -j 2

# 结果：659 passed; 0 failed（含宿主既有的 195 个，无一破坏）
# hosted_rooms 单独：464 passed
```

`cargo check` 0 error。

---

## 3. 你必须做的事（按顺序）

### 步骤 1：贴回主仓库

```bash
cp -r /g/mirach-verify/src-tauri/src/hosted_rooms /g/mirach-harness/src-tauri/src/
cp /g/mirach-verify/src-tauri/src/pi_groups.rs /g/mirach-harness/src-tauri/src/
```

### 步骤 2：`G:\mirach-harness\src-tauri\Cargo.toml` 加两个依赖

在 `base64 = "0.22"` 下面加：

```toml
# 托管群聊（hosted_rooms）：事件日志 + 状态机 + 证据 + 跨网关
# 版本与 rpi 同源（pi-rust-main/Cargo.toml 的 workspace 依赖 0.31 + bundled）
rusqlite = { version = "0.31", features = ["bundled"] }
# 执行策略签名 / grant HMAC / 各类 digest
sha2 = "0.10"
```

### 步骤 3：`G:\mirach-harness\src-tauri\src\main.rs` 加模块与命令

在 `mod app_prefs;` 附近加：

```rust
// 托管群聊后端（hermes gateway/hosted_room_*.py 的 Rust 移植）
mod hosted_rooms;

// 群聊 IPC 命令面（groups.* 20 个方法 + 讨论规划）
mod pi_groups;
```

在 `tauri::generate_handler![...]` 里加两行（找 `pi_run_command,` 之后）：

```rust
            pi_groups::groups_dispatch,
            pi_groups::groups_plan,
```

### 步骤 4：编译验证

```powershell
cd G:\mirach-harness\src-tauri
$env:PATH = "C:\Users\Administrator\miniconda3-mirach\Library\bin;$env:PATH"
cargo check -j 2          # 期望 0 error
cargo test -j 2 hosted_rooms   # 期望 464 passed
```

⚠️ **注意**：`cargo build` / `cargo run` 会覆盖正在运行的 `mirach-harness.exe`。
如果你也是在宿主里运行的 agent，见 §4.1 —— **这一步必须先让用户停掉应用**。

### 步骤 5：让用户重启应用验证 IPC

前端可以这样调用（先手动在 DevTools 里试）：

```js
await window.__TAURI__.core.invoke('groups_dispatch', {
  method: 'groups.capabilities',
  params: {}
})
// → { methods: [...], max_log_limit: 500 }
```

---

## 4. 你必须知道的四个坑（血泪教训）

### 4.1 「自己改自己」——**最重要**

**问题**：如果你运行在 `mirach-harness.exe` 进程里（父进程链里有它），那么：

| 操作 | 后果 |
|---|---|
| `cargo build` / `cargo run` | **失败**——`target\debug\mirach-harness.exe` 被自己锁定 |
| 用 `edit` 改 `G:\mirach-harness\src-tauri\src\**` | **触发 tauri dev 热重建 → 重启应用 → 杀死自己** |
| `cargo check` | ✅ 安全（不写 exe） |
| `cargo test` | ✅ 安全（写的是 test 二进制） |
| 改副本 `G:\mirach-verify\` | ✅ 安全（无监视器） |

**前一个 agent 就是这样被杀了好几次。** 解决方案：

1. 在副本里开发（`G:\mirach-verify\src-tauri`）
2. 只在副本里 `cargo test`
3. 贴回主仓库的动作**交给用户执行**，或者先让用户停掉应用

检查自己是否在宿主里：
```powershell
$p = Get-CimInstance Win32_Process -Filter "ProcessId=$PID"
while ($p) { "$($p.Name) $($p.ProcessId)"; $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($p.ParentProcessId)" -ErrorAction SilentlyContinue }
```

### 4.2 CJK 编码 / 换行

- PowerShell 5.1 读写文件按 ANSI → 所有文本操作用 `[System.IO.File]::ReadAllText/WriteAllText` + UTF8Encoding($false)
- `bash` 工具的 heredoc 里写中文模板字符串会出问题 → 用 `write` 工具写文件，或 node 脚本读文件
- 仓库是 CRLF，git 会警告但不影响

### 4.3 编译内存

`G:\mirach-harness\src-tauri\.cargo\config.toml` 已钉 `jobs = 4`。这台机器 16GB，`-j 4` 是上限。
`asupersync` 并行编译会 OOM，遇到就 `-j 1`。

tsc 也可能 OOM：`NODE_OPTIONS="--max-old-space-size=6144" npx tsc --noEmit`。

### 4.4 hermes 源码位置

```
D:\hermes-agent-main\gateway\          ← Python 后端（19 个 hosted_room 模块）
D:\hermes-agent-main\apps\desktop\src\plugins\hermes-bots\  ← 前端 121 文件 / 41.8k 行
```
**只读参考，不要改。**

---

## 5. 语义保真的关键点（照抄时不能走样）

前一个 agent 在移植过程中抓到的 **13 个真 bug**，都是语义偏差。你在改这些代码时要特别小心：

| # | 坑 | 正确语义 |
|---|---|---|
| 1 | JSON 键排序 | 必须**递归按键字典序**。`serde_json` 的 `json!` 宏按插入顺序输出，不能直接用 `to_string()` |
| 2 | `prune_disbanded_rooms` | SQLite 的 `LIMIT` **不接受聚合子查询**，要先算溢出条数 |
| 3 | `create_room` 判定顺序 | 先查 name/members（`different state`），再查 authority（`different authority`） |
| 4 | `_cancel_generation` | **允许 0**（初始值就是 0），不是正数 |
| 5 | `expected_generations` | `execution` 报 "positive integer"，`cancel` 报 "non-negative"，**文案不同不能合并** |
| 6 | 参数名遮蔽 | Rust 里 `fn f(cancel_generation: i64)` 会遮蔽同名函数 |
| 7 | `work_records` digest | 必须**排除 `revision` 与 `digest`** 两个字段 |
| 8 | `MAX_AUTHORITY_SPANS` | 1024 条**合法**，1025 才越界 |
| 9 | `truncate_utf8_text` | `keep = max_bytes - suffix.len()`，要从 keep 往退回字符边界 |
| 10 | 测试函数同名 | `fn demote_requires_newer_epoch()` 会遮蔽 `pub fn demote_...` |
| 11 | `room_grant_is_revoked` | 必须比较 `issued_at <= revoked_before`，否则**撤销后新签发的 grant 被误杀** |
| 12 | pending 表 schema | 简化版与加固版冲突，`CREATE TABLE IF NOT EXISTS` 谁先建谁赢 → 统一由 `delivery::initialize_delivery` 建 |
| 13 | `MAX_ATTACHMENT_BYTES` 边界 | base64 编码上限是 `((MAX+2)/3)*4`，解码后再校验 `len > MAX` |

### 最重要的三条设计原则（上游注释原文）

1. **「Evidence is not an execution gate」**（`work_records`）
   工作证据是**记录**，不是权限、不是可执行状态。捕获失败不能阻止 driver 推进。

2. **「at most one next driver task」**（`discussion`）
   同一份日志 + 同一份名册 → 永远算出同一个任务。纯函数，重启后重算即可，**不需要持久化「上次算到哪」**。

3. **「The caller decides when takeover is safe」**（`replicas`）
   `promote_replica` / `demote_room` 只提供**存储原语**，不替调用方做分布式共识。

---

## 6. 剩余工作清单

### 6.1 已完成但未接线的（你来做）

| 项 | 位置 | 难度 |
|---|---|---|
| 贴回主仓库 + 三处配置 | §3 | 简单 |
| 重启宿主验证 IPC 能用 | §3 步骤 5 | 简单（需用户配合） |
| 前端接 `groups_dispatch` | `src/` 前端 | 中等 |

### 6.2 后端未做的部分

| 项 | 说明 | 为什么没做 |
|---|---|---|
| HTTP 传输（peer 端点发现 + 实际 RPC） | `peer.rs` 只有密码学与契约，没有 http client | 需真实网络 + TLS 环境验证 |
| `groups.approve` 接线 | 需接 rpi 的 approval 通道 | 宿主未接线，返回明确错误而非假成功 |
| `groups.peer.*` 三个方法 | 同上 | 返回明确错误 |

### 6.3 前端（41.8k 行，最大的一块）

如果用户还想做前端，正确路径是：

```bash
# 1. 逐字复制（不要重写！）
cp -r /d/hermes-agent-main/apps/desktop/src/plugins/hermes-bots \
      /g/mirach-harness/src/hermes-mirror/plugins/

# 2. 造 shim：把 @hermes/plugin-sdk 的 88 个符号本地化
#    模式参考已有的 src/hermes-shim/（capabilities 就是这么搬的，95 个文件）

# 3. 数据面：host.request(method, params) → invoke('groups_dispatch', {method, params})
```

⚠️ **不要重写前端。** Mirach 的工程规矩第 1 条：「照抄 hermes，不要自己做。所有手写替身都是 bug 来源」。

现有的 `src/components/panes/hub/`（11 文件 / 3.6k 行）就是**重写的残缺版**，用户已经明确说「现在的做的不行」。

---

## 7. 关键文件速查

### hermes 源码（只读）
```
D:\hermes-agent-main\gateway\hosted_rooms.py                    1442  房间+日志
D:\hermes-agent-main\gateway\hosted_room_driver.py              1033  状态机
D:\hermes-agent-main\gateway\hosted_room_discussion.py          1057  讨论规划
D:\hermes-agent-main\gateway\hosted_room_peer.py                 562  跨网关
D:\hermes-agent-main\gateway\session_group_controls.py           640  RPC 契约
D:\hermes-agent-main\apps\desktop\src\plugins\hermes-bots\      41.8k  前端
```

### 文档（前一个 agent 写的）
```
G:\mirach-harness\docs\bots-port-feasibility.md    可行性核查（体量/依赖/对偶）
G:\mirach-harness\docs\bots-rust-port-plan.md      19 模块映射清单
```

### 交付代码
```
G:\mirach-verify\src-tauri\src\hosted_rooms\       25 个模块
G:\mirach-verify\src-tauri\src\pi_groups.rs        IPC 层
```

---

## 8. 用户的原话（理解意图用）

- 「能把 hermes 的 bots 插件完整复制吗？现在的做的不行」
- 「要的就是全搬做成 rust 的插件啊」
- 「跨网关同步，单机无消费方，按规矩 11 有意不做，这个怎么解决，也得做啊」
- 「做」/「继续」/「继续，不要停，一次做完」

**用户要的是完整复刻，不是近似实现。** 遇到「这块单机用不上」的判断时，用户明确要求也要做。

---

## 9. 给下一个 agent 的建议

1. **先跑一遍 `cargo test hosted_rooms`** 确认 464 个测试绿，再动手
2. **不要在宿主进程里改主仓库的 Rust 文件**（§4.1）
3. **贴回和重启的动作让用户执行**
4. **前端如果要做，逐字复制，不要重写**
5. **遇到不确定的语义，去读 `D:\hermes-agent-main\gateway\` 的原始 Python**

祝顺利。
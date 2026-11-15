# hermes 群聊后端 → Rust 移植映射清单

> 2026-11-15。路径 3 执行文档：把 `D:\hermes-agent-main\gateway\hosted_room_*.py`（19 模块 / 9,330 行）语义照抄进 Mirach 的 Rust 侧。
>
> 本清单只记实测事实（行数、依赖、schema），不含推测。

## 1. 总体判断：**移植条件极好**

hermes 群聊后端的设计恰好适合 Rust：

- **纯函数核心**。`hosted_room_discussion.py` 自述："Pure (no I/O, transport or model knowledge)"；`hosted_room_router.py`："pure: no I/O, no model knowledge"
- **依赖极简**。19 个模块里 17 个只依赖 `hosted_rooms_common`（叶子模块，自述"Must stay a leaf: never import a hosted_room* module"）
- **append-only 事件日志**。`hosted_room_events(room_id, seq, event_id, kind, actor_json, payload_json)` —— 确定性重放，Rust 的 enum + serde 天然贴合
- **存储 = SQLite**。Mirach 已有 `state.db`（rusqlite），可直接复用

## 2. 模块映射表

### 第 1 层：叶子与存储（无内部依赖）

| hermes | 行数 | Rust 目标 | 说明 |
|---|---|---|---|
| `hosted_rooms_common.py` | 151 | `src-tauri/src/hosted_rooms/common.rs` | 标识符校验、bounded int、canonical JSON、`fenced_update`、`table_columns` |
| `hosted_rooms.py` | 1,442 | `src-tauri/src/hosted_rooms/store.rs` | 9 张表 DDL + append-only 事件日志 + 迁移 |

**表结构（9 张，须逐字照抄）**：
`hosted_rooms`（room_id/name/members_json/authority_gateway_id/authority_epoch/next_seq/event_bytes/revision/created_at/updated_at/disbanded_at）
`hosted_room_events`（room_id/seq/event_id/kind/actor_json/authority_epoch/payload_json/created_at）
`hosted_room_retired_ids` · `hosted_room_links` · `hosted_room_remote_runs` · `hosted_room_revoked_grants` · `hosted_room_peer_reservations` · `hosted_room_owed_revokes` · driver 任务表

### 第 2 层：纯策略（无 I/O，最好移植）

| hermes | 行数 | Rust 目标 | 移植难度 |
|---|---|---|---|
| `hosted_room_discussion.py` | 1,057 | `hosted_rooms/discussion.rs` | **低**。纯函数：roster + 事件日志 → 下一个任务 |
| `hosted_room_context.py` | 174 | `hosted_rooms/context.rs` | 低。purpose/notes/定时贴，从事件日志读 |
| `hosted_room_task_input.py` | 24 | 并入 `discussion.rs` | 低 |
| `hosted_room_router.py` | 213 | `hosted_rooms/router.rs` | 低。但内部调 `tui_gateway.hosted_room_router_call`（一次无工具廉价模型调用）→ 需注入 trait |
| `hosted_room_lead.py` | 167 | `hosted_rooms/lead.rs` | 低。lead 路由，同样依赖一次模型调用 |
| `hosted_room_execution_policy.py` | 152 | `hosted_rooms/execution_policy.rs` | 低。纯 hash + 结构 |

### 第 3 层：状态机与持久化

| hermes | 行数 | Rust 目标 | 说明 |
|---|---|---|---|
| `hosted_room_driver.py` | 1,033 | `hosted_rooms/driver.rs` | **核心**。TaskStatus 8 态状态机 + 租约（lease_generation/authority_epoch/process_generation）+ fencing |
| `hosted_room_work_records.py` | 416 | `hosted_rooms/work_records.rs` | 工作记录 |
| `hosted_room_work_storage.py` | 247 | `hosted_rooms/work_storage.rs` | 存储 |
| `hosted_room_work_lineage.py` | 40 | `hosted_rooms/work_lineage.rs` | 血缘 |
| `hosted_room_policy_checkpoint.py` | 521 | `hosted_rooms/policy_checkpoint.rs` | 策略检查点 |
| `hosted_room_authority_history.py` | 121 | `hosted_rooms/authority_history.rs` | 权限历史 |

### 第 4 层：附件与 peer（最复杂，可延后）

| hermes | 行数 | Rust 目标 | 说明 |
|---|---|---|---|
| `hosted_room_attachments.py` | 1,364 | `hosted_rooms/attachments.rs` | 最大单文件。上传/下载/校验 |
| `hosted_room_peer.py` | 562 | `hosted_rooms/peer.rs` | **跨网关 peer**。rpi 无此概念，需自建或裁剪 |
| `hosted_room_replicas.py` | 286 | `hosted_rooms/replicas.rs` | 副本同步，依赖 peer |
| `hosted_room_links.py` | 152 | `hosted_rooms/links.rs` | RoomLink |
| `hosted_room_legacy_import.py` | 147 | 可跳过 | 旧数据迁移，新装不需要 |
| `hosted_rooms_gateway_import.py` | 184 | 可跳过 | 同上 |

### 第 5 层：控制面

| hermes | 行数 | Rust 目标 |
|---|---|---|
| `session_group_controls.py` | 640 | `src-tauri/src/hosted_rooms/controls.rs`（对外 RPC 面，对应 `groups.*` 30 个方法） |
| `bot_loop_guard.py` | 220 | `hosted_rooms/loop_guard.rs` |
| `bot_peer_notices.py` | 17 | 并入 `peer.rs` |

## 3. 分工边界（关键决策）

| 层 | 归属 | 理由 |
|---|---|---|
| 事件日志 + 9 张表 | **Rust**（`src-tauri`） | SQLite 复用 `state.db`，纯数据 |
| discussion/router/lead/execution_policy | **Rust**（纯函数） | 无 I/O，最适合 Rust，可直接对拍验证 |
| driver 状态机 | **Rust** | 租约/fencing/恢复，Rust 的类型系统明显更安全 |
| **模型调用（每个成员一次 turn）** | **交给 rpi 单会话 harness** | 这是 rpi 的强项，不重写 |
| UI（121 文件 / 41.8k 行） | **前端逐字照抄** | 已有的路线 |

## 4. 与 rpi 的接缝

群聊每个成员的一次 turn = 在该成员自己的 rpi 会话里跑一次 agent run。

- 现有 `PiEngine` 是单活动会话，需扩成 `HashMap<MemberId, HarnessLive>`（即之前方案 B 的改动）
- 每次 driver 派发任务 → 找到对应 member 的 harness → `prompt_with_content()`
- 结果经 `AgentEvent` 流回 → 写入 `hosted_room_events`

**这是唯一必须改 `pi_session.rs` 的地方**，但改动范围可控（约 15 个方法加 member 维度）。

## 5. 工作量估算

| 阶段 | 内容 | 估算 |
|---|---|---|
| P1 | common + store（9 张表）+ 事件日志 | 2–3 天 |
| P2 | 纯策略四件套（discussion/context/router/lead/execution_policy） | 3–4 天 |
| P3 | driver 状态机 + work_records | 4–5 天 |
| P4 | `pi_session.rs` 多 member 改造 | 3–4 天 |
| P5 | controls.rs（30 个 `groups.*` 方法）+ IPC | 3–4 天 |
| P6 | 附件（1,364 行） | 3–4 天 |
| P7 | 前端 41.8k 行照抄 + 接线 | 8–12 天 |
| **合计** | | **约 26–36 天** |

peer/replicas（跨网关）建议**暂不做**——rpi 是单机单引擎，跨网关同步没有消费方。砍掉这两块（848 行）不影响单机群聊。

## 6. 验证策略

hermes 有 162 个测试文件。其中纯函数部分（discussion/router/lead）的测试可以**逐条翻译成 Rust 测试**，作为移植正确性的对拍基准。这是本方案最大的质量保障。

## 7. 风险

1. **事件日志的字节级一致性**：`canonical_json`/`compact_json` 的键序与序列化必须完全一致，否则重放会漂移
2. **driver 的恢复语义**：`indeterminate` 状态的判定条件是移植最容易错的地方
3. **`tui_gateway.hosted_room_router_call`**：router/lead 需要一次廉价模型调用，要用 trait 注入（Rust 侧接 rpi 的 provider 层）

## 8. 建议执行顺序

先做 P1+P2（纯数据 + 纯函数），这两块可以用 hermes 的测试对拍，**风险最低、验证最快**。P1+P2 完成后就能证明「事件日志 + 讨论策略」的语义完全正确，再往后推进状态机。
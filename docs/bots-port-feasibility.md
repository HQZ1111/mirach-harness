# hermes bots 全量搬运可行性核查

> 2026-11-15。目标：把 hermes `apps/desktop/src/plugins/hermes-bots`（121 个非测试文件 / 41,807 行）完整搬到 Mirach 前端（Tauri/WebView GUI）。
>
> 本文件只记录**实测数据**与**对偶结论**，不含推测。

## 1. 体量实测

| 层 | 文件数 | 行数 | 说明 |
|---|---|---|---|
| bots UI | 121 非测试（+162 测试） | **41,807** | 逐字复制目标 |
| `@hermes/plugin-sdk` | 23 | **5,518** | 解析到 `apps/desktop/src/sdk/index.ts` |
| SDK 依赖 `@/store/*` | 18 | **12,465** | 见 §2 |
| SDK 依赖 `@/lib/*` | 28 | **5,366** | 见 §2 |
| **合计** | **190** | **≈65,156** | 不含测试 |

## 2. SDK 依赖层实测（这是真正的风险点）

### store/（12,465 行）

| 模块 | 行数 |
|---|---|
| session-states | 3,084 |
| gateway | 2,355 |
| session | 1,981 |
| profile | 1,223 |
| layout | 1,064 |
| composer | 980 |
| session-unread | 736 |
| notifications | 436 |
| system-actions | 184 |
| session-focus | 92 |
| sidebar-nav | 86 |
| session-color | 82 |
| reasoning-disclosure | 44 |
| tabstrip-prefs | 38 |
| chat-text-scale | 27 |
| backdrop | 18 |
| session-list-density | 18 |
| intro-splash | 17 |

### lib/（5,366 行，前几名）

`chat-runtime` 618 · `media` 505 · `tool-media-renderers` 439 · `keybinds/actions` 433 · `keybinds/combo` 340 · `icons` 295 · `storage` 258 · `time` 253 · `transcript-directives` 237 · `mcp-dashboard-oauth` 233 · `runtime-readiness` 232 · `model-options` 224 · `hermes-open-target` 177 …

## 3. 数据面对偶核查（关键结论）

### 3.1 bots 的调用收敛得很好

bots **不直接拼 REST URL**，全部经 SDK 的 `host` 对象（约 130 处调用、30 个方法）。真正的后端交互只有 `host.request(method, params)` 一个门。

### 3.2 bots 依赖的网关 RPC 全清单（49 个）

```
profiles.list / create / describe / configure / get_asset / set_asset
groups.list / state / context / create / rename / send / continue / stop / retry
groups.discard / disband / promote / demote / approve / changed / log
groups.capabilities / replica_state / replicate / not_declared / state.undeclared
groups.attachment.list / upload / download
groups.peer / peer.register / peer.invite / peer.invite.status_ttl_seconds / peer.revoke
canonical.*（会话锚定/所有权）
session.create / info / list / resume / title / interrupt / compress / reclaimed / set_hidden
skills.manage
cli.exec
```

### 3.3 pi 侧对偶情况

| bots 概念 | pi/Mirach 现状 | 结论 |
|---|---|---|
| `profiles.*`（6 个方法） | 无 profiles 概念。pi 侧只有 `pi_connections_*`（6 个：list/save/remove/set_primary/test）与 `pi_persona_*`（read/write/reset） | **要造** |
| `groups.*`（约 30 个方法，含群聊全生命周期） | **完全没有**。pi 无「群聊/多机器人互发」概念 | **搬不了**（需 pi 引擎改） |
| `canonical.*` | `pi_create_bot_session` 有 sessionId 锚定语义，`pi_get_session_lineage` 有血缘 | **部分对偶**，需适配 |
| `session.*`（9 个） | `pi_new_session` / `pi_get_state` / `pi_list_sessions` / `pi_rename_session` / `pi_interrupt` / `pi_compact` / `pi_open_session` / `pi_discard_session` / `pi_delete_session` | **基本对偶** ✅ |
| `skills.manage` | `pi_capabilities` / `pi_set_skill_enabled` | **对偶** ✅ |
| `cli.exec` | `pi_run_command` | **对偶** ✅ |

## 4. 结论

**能搬的（约 82% UI）**：花名册、机器人行/头像/分区、右键菜单、创建/编辑对话框、Soul、技能中心、宠物、资料（profile）管理界面。

**搬不了的核心（约 18%，但正是 bots 最有价值的部分）**：`groups.*` 全部——群聊创建/成员/能力门/审批/附件/历史/循环/peer 邀请。这不是前端问题：**pi 引擎没有多机器人会话模型**，前端搬过来就是死 UI。

## 5. 建议路径

1. 先搬「单机器人」完整面（profiles 用 `pi_connections` + `pi_persona` 造 shim）
2. `groups.*` 需先向 pi 引擎提能力需求，否则不做 UI（避免假界面，遵守工程规矩 11「禁止兜底」）

## 6. 待决

- 是否接受「先单人后群聊」的分批落地？
- 群聊是否愿意等 pi 引擎侧支持？
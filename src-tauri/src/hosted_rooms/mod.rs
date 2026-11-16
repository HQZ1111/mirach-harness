//! 托管群聊后端（hermes `gateway/hosted_room_*.py` 的 Rust 移植）。
//!
//! ## 为什么在宿主侧而不是 rpi 插件
//!
//! hermes 的群聊复杂度在**后端 9,330 行**（19 个 `hosted_room_*` 模块），不在
//! 前端 UI。rpi 插件 ABI 没有持久化任务状态机的落脚点（`AppendEntry` 只能存
//! 数据，不能跑调度），也没有 GUI 通道。所以群聊后端落在宿主 Rust 侧，模型
//! 调用交给 rpi 的单会话 harness —— 分工见 `docs/bots-rust-port-plan.md`。
//!
//! ## 模块地图
//!
//! | 模块 | 上游 | 职责 |
//! |---|---|---|
//! | [`common`] | `hosted_rooms_common.py` | 叶子工具：标识符/整数/字段集/JSON/围栏更新 |
//! | [`store`] | `hosted_rooms.py` | 8 张房间表 + append-only 事件日志 |
//! | [`driver`] | `hosted_room_driver.py` | driver 表 + 租约 + 8 态状态机表 |
//! | [`driver_ops`] | 同上 | 全部状态迁移（start/settle/cancel/reconcile/recover） |
//! | [`discussion`] | `hosted_room_discussion.py` | 讨论策略（纯函数：名册/载荷/提及） |
//! | [`decision_engine`] | 同上（`decision()`） | 事件校验 + 水位推导 + 确定性 task id |
//! | [`plan`] | 同上（`plan_next_task()`） | 顶层编排：回放日志 → 至多一个下一步任务 |
//! | [`peer`] | `hosted_room_peer.py` | 跨网关 grant（HMAC-SHA256 签发/校验） |
//! | [`replicas`] | `hosted_room_replicas.py` | 副本 ingest（幂等/无缺口/epoch 不回退）+ 接管 |
//! | [`links`] | `hosted_room_links.py` | 房间链接存储（grant 红化） |
//! | [`adapters`] | `hosted_rooms.py`（SQL 部分） | 适配层：停止/换权/探测/peer 保留/回执 |
//! | [`work_capture`] | `work_records.py` capture + 附件 blob | 证据捕获编排 + 内容寻址 blob 存储 |
//! | [`delivery`] | `work_records.py` delivery + `work_storage.py` | 两阶段投递 + ACK 校验 + disposition 四态 |
//! | [`context`] | `hosted_room_context.py` | purpose/notes/routing |
//! | [`router`] | `hosted_room_router.py` | 自动路由 + Continue |
//! | [`lead`] | `hosted_room_lead.py` | 主机器人分派 |
//! | [`execution_policy`] | `hosted_room_execution_policy.py` | 目标下发的执行权限（sha256 签名） |
//! | [`task_input`] | `hosted_room_task_input.py` | 有界输入引用 |
//! | [`work_records`] | `hosted_room_work_records.py` | 工作证据（**非**可执行状态） |
//! | [`work_lineage`] | `hosted_room_work_lineage.py` | 证据对归属区间 |
//! | [`authority_history`] | `hosted_room_authority_history.py` | 归属链重放上下文 |
//! | [`policy_checkpoint`] | `hosted_room_policy_checkpoint.py` | 9 张策略投影表 |
//! | [`attachments`] | `hosted_room_attachments.py` | 附件校验（magic/MIME/配额） |
//! | [`controls`] | `session_group_controls.py` | `groups.*` RPC 契约层 |
//!
//!
//! ## 已完成度
//!
//! 约 **13,900 行**，464 个单测。真正的未做项：
//! - 存储层的 SQL 封装（`work_records` 的 capture/delivery、`attachments` 的 blob IO）
//! - 宿主 IPC 接线（P5 后半：把 `controls` 挂到 Tauri 命令）
//!
//! ## 边界（不假装做完）
//!
//! 8 张房间表 + 2 张 driver 表 + 9 张投影表**全部建好**，后续接入不需要改 schema。
//! 跨网关三件套（peer/replicas/links）已实现到**契约与判定层**：grant 的 HMAC 签发校验、
//! 副本的幂等/缺口/epoch 判定、链接记录的字段校验与 grant 红化。SQL 读写与 HTTP 传输
//! 属适配层，未做。

pub mod adapters;
pub mod attachments;
pub mod authority_history;
pub mod common;
pub mod context;
pub mod decision_engine;
pub mod delivery;
pub mod discussion;
pub mod controls;
pub mod driver;
pub mod driver_ops;
pub mod execution_policy;
pub mod lead;
pub mod links;
pub mod peer;
pub mod plan;
pub mod policy_checkpoint;
pub mod replicas;
pub mod router;
pub mod store;
pub mod task_input;
pub mod work_capture;
pub mod work_lineage;
pub mod work_records;

pub use common::FieldError;
pub use store::{HostedRoomError, Room, RoomActor, RoomEvent, RoomResult};

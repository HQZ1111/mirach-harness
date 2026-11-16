//! 房间驱动状态机的操作层（hermes `gateway/hosted_room_driver.py` 的 P3b 移植）。
//!
//! P3a（`driver.rs`）给了 schema、租约、状态机表与任务创建；本文件给**所有
//! 状态迁移操作**，每条都是「先校验 → 再 fenced UPDATE → 恰好一行」。
//!
//! ## 上游的两类迁移
//!
//! | 类别 | fence | 用在哪 |
//! |---|---|---|
//! | **run fence** | `run_gateway_id + run_process_generation + run_lease_generation` + 双代 | `start` 后的 settle / requeue（必须证明"这次执行仍归我"） |
//! | **generation fence** | `execution_generation + cancel_generation` + 期望 status | reconcile 系列（indeterminate / deferred 的对账） |
//! | **cancel fence** | `cancel_generation`（+ cancel_id） | 取消三步（queued cancel / begin stop / complete stop） |
//!
//! ## 上游反复强调的两条语义
//!
//! 1. **`defer` 永不等于 `cancelled`**：Stop 未被成员确认时，任务进 `deferred`
//!    而不是 `cancelled`——「Discard 放弃的是一次尝试，不是用户的消息」。
//! 2. **`start` 有严格的前置条件**：房间里不能有 `running`/`indeterminate`/`stopping`
//!    的任务（必须先对账），且该任务必须是队列里**下一个**（按事件序）。
//!    这保证同一房间同一时刻只有一个在跑。

use rusqlite::Connection;
use serde_json::{json, Value};

use super::common;
use super::driver::{
    read_lease, read_task, DriverLease, DriverResult, DriverStateError, DriverTask, ERR_INVALID_TRANSITION,
    ERR_STALE_LEASE, ERR_STALE_TASK, ERR_VALIDATION, MAX_IDENTIFIER_CHARS, MAX_RESULT_JSON_BYTES,
    TERMINAL_TASK_RETENTION_SECONDS, MAX_RETAINED_TERMINAL_TASKS, MAX_TASK_PRUNE_BATCH, TASK_ORDER,
    SHOWN_TASK_STATUSES, TERMINAL_STATUSES,
};

// ── 身份类型 ────────────────────────────────────────────────────────────────

/// 上游 `TaskIdentity`：一个已准入房间 turn 的稳定身份。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskIdentity {
    pub room_id: String,
    pub task_id: String,
    pub thread_id: String,
    pub turn_id: String,
}

impl TaskIdentity {
    /// 上游 `__post_init__`：四个字段都要过 identifier 校验。
    pub fn new(room_id: &str, task_id: &str, thread_id: &str, turn_id: &str) -> DriverResult<Self> {
        let check = |value: &str, label: &str| {
            common::identifier(value, label, MAX_IDENTIFIER_CHARS, true, None)
                .map_err(|e| DriverStateError::new(ERR_VALIDATION, e.0))
        };
        Ok(Self {
            room_id: check(room_id, "room_id")?,
            task_id: check(task_id, "task_id")?,
            thread_id: check(thread_id, "thread_id")?,
            turn_id: check(turn_id, "turn_id")?,
        })
    }
}

/// 上游 `TaskAttempt`：被授权结算某个任务的**那一次**执行。
#[derive(Debug, Clone, PartialEq)]
pub struct TaskAttempt {
    pub identity: TaskIdentity,
    pub lease: DriverLease,
    pub execution_generation: i64,
    pub cancel_generation: i64,
}

// ── 内部校验 ────────────────────────────────────────────────────────────────

fn timestamp(now: f64) -> DriverResult<f64> {
    if !now.is_finite() {
        return Err(DriverStateError::new(ERR_VALIDATION, "clock must be finite"));
    }
    Ok(now)
}

fn require_active_lease(conn: &Connection, lease: &DriverLease, now: f64) -> DriverResult<()> {
    let Some(current) = read_lease(conn, &lease.room_id)? else {
        return Err(DriverStateError::new(ERR_STALE_LEASE, "driver lease is gone"));
    };
    if current.released_at.is_some()
        || current.process_generation != lease.process_generation
        || current.lease_generation != lease.lease_generation
        || current.expires_at <= now
    {
        return Err(DriverStateError::new(
            ERR_STALE_LEASE,
            "lease generation can no longer mutate room state",
        ));
    }
    Ok(())
}

fn check_same_room(lease: &DriverLease, identity: &TaskIdentity) -> DriverResult<()> {
    if lease.room_id != identity.room_id {
        return Err(DriverStateError::new(
            ERR_VALIDATION,
            "lease and task belong to different rooms",
        ));
    }
    Ok(())
}

fn load_task(conn: &Connection, identity: &TaskIdentity) -> DriverResult<DriverTask> {
    read_task(conn, &identity.room_id, &identity.task_id)?
        .ok_or_else(|| DriverStateError::new(ERR_VALIDATION, "task not found"))
}

/// 上游 `_expected_generations`：`execution` 必须 ≥ 1，`cancel` 走
/// [`cancel_generation`]（**允许 0**）。两个文案各自不同，不能合并。
fn expected_generations(
    lease: &DriverLease,
    identity: &TaskIdentity,
    execution_generation: i64,
    cancel_generation: i64,
) -> DriverResult<()> {
    check_same_room(lease, identity)?;
    if execution_generation < 1 {
        return Err(DriverStateError::new(
            ERR_VALIDATION,
            "expected_execution_generation must be a positive integer",
        ));
    }
    // 注意：参数名 `cancel_generation` 遮蔽了同名函数，所以用完整路径调用
    validate_cancel_generation(cancel_generation)?;
    Ok(())
}

/// 上游 `_cancel_generation`：**非负**（初始 cancel_generation 就是 0）。
///
/// 上游注释："Deliberately accepts bool (a bool is an int); do not swap for
/// non_negative_int." —— 文案与下界逐字对齐。
fn cancel_generation(value: i64) -> DriverResult<i64> {
    validate_cancel_generation(value)
}

/// 实际校验体（单独命名避免与参数同名遮蔽）。
fn validate_cancel_generation(value: i64) -> DriverResult<i64> {
    if value < 0 {
        return Err(DriverStateError::new(
            ERR_VALIDATION,
            "expected_cancel_generation must be non-negative",
        ));
    }
    Ok(value)
}

/// 上游 `_identifier` 包装。
fn identifier(value: &str, label: &str) -> DriverResult<String> {
    common::identifier(value, label, MAX_IDENTIFIER_CHARS, true, None)
        .map_err(|e| DriverStateError::new(ERR_VALIDATION, e.0))
}

/// 上游 `_terminal_settlement_id`：终态 status 必须是 settled/failed，
/// 且 settlement_id 必须是 identifier。**settlement 错误优先于 generation 错误。**
fn terminal_settlement(cancel_or_settlement: &str, status: &str) -> DriverResult<String> {
    if status != "settled" && status != "failed" {
        return Err(DriverStateError::new(
            ERR_VALIDATION,
            format!("invalid terminal status '{status}'"),
        ));
    }
    identifier(cancel_or_settlement, "settlement_id")
}

/// 结算结果的标准形状（上游 `_settlement` 的 set_params 部分）。
fn settlement_result(status: &str, result: &Value) -> DriverResult<String> {
    let canonical = common::canonical_json(result, "result", MAX_RESULT_JSON_BYTES, true)
        .map_err(|e| DriverStateError::new(ERR_VALIDATION, e.0))?;
    let _ = status;
    Ok(canonical)
}

// ── start ───────────────────────────────────────────────────────────────────

/// 上游 `start_task()`：把队列里的任务推进到 running。
///
/// 三条硬前置（顺序与上游一致）：
/// 1. 房间当前没有 `running`/`indeterminate`/`stopping` 的任务
/// 2. 该任务必须是队列里**下一个**（`ORDER BY source_event_seq, created_at, task_id`）
/// 3. 当前 status 必须是 `queued`
pub fn start_task(
    conn: &mut Connection,
    identity: &TaskIdentity,
    lease: &DriverLease,
    expected_cancel_generation: i64,
    now: f64,
) -> DriverResult<TaskAttempt> {
    check_same_room(lease, identity)?;
    cancel_generation(expected_cancel_generation)?;
    let now = timestamp(now)?;

    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    require_active_lease(&tx, lease, now)?;

    let row = load_task(&tx, identity)?;
    if row.cancel_generation != expected_cancel_generation {
        return Err(DriverStateError::new(
            ERR_STALE_TASK,
            "task attempt is stale or cancelled",
        ));
    }
    if row.status != "queued" {
        return Err(DriverStateError::new(
            ERR_INVALID_TRANSITION,
            format!("cannot start task in state '{}'", row.status),
        ));
    }

    // 房间里不能有未对账的在跑/不确定/停止中任务
    let blocking: Option<String> = tx
        .query_row(
            &format!(
                "SELECT task_id FROM hosted_room_driver_tasks
                 WHERE room_id=?1 AND status IN ('running','indeterminate','stopping') {TASK_ORDER} LIMIT 1"
            ),
            [&identity.room_id],
            |r| r.get(0),
        )
        .ok();
    if blocking.is_some() {
        return Err(DriverStateError::new(
            ERR_INVALID_TRANSITION,
            "room recovery must resolve the prior task before starting new work",
        ));
    }

    // 必须是队列里的下一个
    let next_queued: Option<String> = tx
        .query_row(
            &format!(
                "SELECT task_id FROM hosted_room_driver_tasks WHERE room_id=?1 AND status='queued' {TASK_ORDER} LIMIT 1"
            ),
            [&identity.room_id],
            |r| r.get(0),
        )
        .ok();
    if next_queued.as_deref() != Some(identity.task_id.as_str()) {
        return Err(DriverStateError::new(
            ERR_INVALID_TRANSITION,
            "task is not next in the hosted room event order",
        ));
    }

    let execution_generation = row.execution_generation + 1;

    // run fence：把这次执行的租约身份写进行，之后的 settle 靠它证明归属
    let affected = tx.execute(
        "UPDATE hosted_room_driver_tasks
         SET status='running', execution_generation=?, run_gateway_id=?, run_process_generation=?,
             run_lease_generation=?, started_at=?, updated_at=?
         WHERE room_id=? AND task_id=? AND status='queued' AND cancel_generation=?",
        rusqlite::params![
            execution_generation,
            lease.gateway_id,
            lease.process_generation,
            lease.lease_generation,
            now,
            now,
            identity.room_id,
            identity.task_id,
            expected_cancel_generation
        ],
    )?;
    if affected != 1 {
        return Err(DriverStateError::new(ERR_STALE_TASK, "task changed during start"));
    }
    tx.commit()?;

    Ok(TaskAttempt {
        identity: identity.clone(),
        lease: lease.clone(),
        execution_generation,
        cancel_generation: expected_cancel_generation,
    })
}

// ── settle（run fence）──────────────────────────────────────────────────────

const RUN_FENCE: &str = "run_gateway_id=? AND run_process_generation=? AND run_lease_generation=?";

/// 上游 `settle_task()`：在**所有**租约与任务 fence 都匹配时提交终态结果。
///
/// `allow_expired_lease` 只服务「活进程内的终态回调」：自己那份未释放的租约
/// 单纯到期，不该丢掉一个已经完成的本地结果。所以那种情况下只去掉
/// `expires_at > now` 这一项；reclaim / release / authority 转移仍然 fence。
pub fn settle_task(
    conn: &mut Connection,
    attempt: &TaskAttempt,
    settlement_id: &str,
    status: &str,
    result: &Value,
    now: f64,
    allow_expired_lease: bool,
) -> DriverResult<DriverTask> {
    let settlement_id = terminal_settlement(settlement_id, status)?;
    let now = timestamp(now)?;
    let result_json = settlement_result(status, result)?;

    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;

    // 租约 fence（含归属检查）
    let Some(current) = read_lease(&tx, &attempt.lease.room_id)? else {
        return Err(DriverStateError::new(ERR_STALE_LEASE, "driver lease is gone"));
    };
    let lease_ok = current.released_at.is_none()
        && current.process_generation == attempt.lease.process_generation
        && current.lease_generation == attempt.lease.lease_generation
        && (allow_expired_lease || current.expires_at > now);
    if !lease_ok {
        return Err(DriverStateError::new(
            ERR_STALE_LEASE,
            "lease generation can no longer mutate room state",
        ));
    }

    let affected = tx.execute(
        &format!(
            "UPDATE hosted_room_driver_tasks
             SET status=?, settlement_id=?, settlement_status=?, result_json=?, terminal_at=?, updated_at=?
             WHERE room_id=? AND task_id=? AND status='running'
               AND execution_generation=? AND cancel_generation=? AND {RUN_FENCE}"
        ),
        rusqlite::params![
            status,
            settlement_id,
            status,
            result_json,
            now,
            now,
            attempt.identity.room_id,
            attempt.identity.task_id,
            attempt.execution_generation,
            attempt.cancel_generation,
            attempt.lease.gateway_id,
            attempt.lease.process_generation,
            attempt.lease.lease_generation,
        ],
    )?;
    if affected != 1 {
        return Err(DriverStateError::new(
            ERR_STALE_TASK,
            "task changed during settlement",
        ));
    }

    let task = load_task(&tx, &attempt.identity)?;
    tx.commit()?;
    Ok(task)
}

// ── 取消三步（cancel fence）───────────────────────────────────────────────

/// 上游 `cancel_task()`：在**任何外部工作被准入之前**取消一个排队任务。
///
/// 只允许 `queued` / `deferred`；running 需要两阶段取消（begin → complete）。
pub fn cancel_task(
    conn: &mut Connection,
    identity: &TaskIdentity,
    cancel_id: &str,
    expected_cancel_generation: i64,
    now: f64,
) -> DriverResult<DriverTask> {
    let cancel_id = identifier(cancel_id, "cancel_id")?;
    cancel_generation(expected_cancel_generation)?;
    let now = timestamp(now)?;

    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let row = load_task(&tx, identity)?;

    if TERMINAL_STATUSES.contains(&row.status.as_str()) {
        return Err(DriverStateError::new(
            ERR_INVALID_TRANSITION,
            format!("cannot cancel task in state '{}'", row.status),
        ));
    }
    if row.status != "queued" && row.status != "deferred" {
        return Err(DriverStateError::new(
            ERR_INVALID_TRANSITION,
            "running work requires acknowledged two-phase cancellation",
        ));
    }
    if row.cancel_generation != expected_cancel_generation {
        return Err(DriverStateError::new(
            ERR_STALE_TASK,
            "task attempt is stale or cancelled",
        ));
    }

    let affected = tx.execute(
        "UPDATE hosted_room_driver_tasks
         SET status='cancelled', cancel_generation=?, cancel_id=?, terminal_at=?, updated_at=?
         WHERE room_id=? AND task_id=? AND status IN ('queued','deferred') AND cancel_generation=?",
        rusqlite::params![
            expected_cancel_generation + 1,
            cancel_id,
            now,
            now,
            identity.room_id,
            identity.task_id,
            expected_cancel_generation
        ],
    )?;
    if affected != 1 {
        return Err(DriverStateError::new(
            ERR_STALE_TASK,
            "task changed during cancellation",
        ));
    }

    let task = load_task(&tx, identity)?;
    tx.commit()?;
    Ok(task)
}

/// 上游 `begin_task_cancel()`：记录停止意图，但**不声称**远端已停止。
///
/// 只允许停在 running / stopping / indeterminate / deferred（不能是 queued 或终态）。
pub fn begin_task_cancel(
    conn: &mut Connection,
    identity: &TaskIdentity,
    cancel_id: &str,
    expected_cancel_generation: i64,
    now: f64,
) -> DriverResult<DriverTask> {
    let cancel_id = identifier(cancel_id, "cancel_id")?;
    cancel_generation(expected_cancel_generation)?;
    let now = timestamp(now)?;

    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let row = load_task(&tx, identity)?;

    if TERMINAL_STATUSES.contains(&row.status.as_str()) || row.status == "queued" {
        return Err(DriverStateError::new(
            ERR_INVALID_TRANSITION,
            format!("cannot request remote stop in state '{}'", row.status),
        ));
    }
    if row.cancel_generation != expected_cancel_generation {
        return Err(DriverStateError::new(
            ERR_STALE_TASK,
            "task attempt is stale or cancelled",
        ));
    }

    let affected = tx.execute(
        "UPDATE hosted_room_driver_tasks
         SET status='stopping', cancel_generation=?, cancel_id=?, updated_at=?
         WHERE room_id=? AND task_id=? AND status IN ('running','stopping','indeterminate','deferred')
           AND cancel_generation=?",
        rusqlite::params![
            expected_cancel_generation + 1,
            cancel_id,
            now,
            identity.room_id,
            identity.task_id,
            expected_cancel_generation
        ],
    )?;
    if affected != 1 {
        return Err(DriverStateError::new(
            ERR_STALE_TASK,
            "task changed during stop request",
        ));
    }

    let task = load_task(&tx, identity)?;
    tx.commit()?;
    Ok(task)
}

/// 上游 `complete_task_cancel()`：**只有传输层确认了精确的 Stop 之后**才提交取消。
pub fn complete_task_cancel(
    conn: &mut Connection,
    identity: &TaskIdentity,
    cancel_id: &str,
    expected_cancel_generation: i64,
    now: f64,
) -> DriverResult<DriverTask> {
    let cancel_id = identifier(cancel_id, "cancel_id")?;
    let now = timestamp(now)?;

    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let row = load_task(&tx, identity)?;

    // 上游：(status, cancel_id, cancel_generation) 必须精确等于 (stopping, cancel_id, expected)
    if row.status != "stopping"
        || row.cancel_id.as_deref() != Some(cancel_id.as_str())
        || row.cancel_generation != expected_cancel_generation
    {
        return Err(DriverStateError::new(
            ERR_STALE_TASK,
            "task stop acknowledgement is stale",
        ));
    }

    let affected = tx.execute(
        "UPDATE hosted_room_driver_tasks
         SET status='cancelled', terminal_at=?, updated_at=?
         WHERE room_id=? AND task_id=? AND status='stopping' AND cancel_id=? AND cancel_generation=?",
        rusqlite::params![
            now,
            now,
            identity.room_id,
            identity.task_id,
            cancel_id,
            expected_cancel_generation
        ],
    )?;
    if affected != 1 {
        return Err(DriverStateError::new(
            ERR_STALE_TASK,
            "task changed during stop acknowledgement",
        ));
    }

    let task = load_task(&tx, identity)?;
    tx.commit()?;
    Ok(task)
}

// ── indeterminate / deferred 对账（generation fence）────────────────────────

/// 通用 generation 迁移（上游 `_generation_transition` 内核）。
fn generation_transition(
    conn: &mut Connection,
    identity: &TaskIdentity,
    lease: &DriverLease,
    transition_name: &str,
    expected_execution_generation: i64,
    expected_cancel_generation: i64,
    now: f64,
    set_params: &[&dyn rusqlite::ToSql],
) -> DriverResult<DriverTask> {
    expected_generations(lease, identity, expected_execution_generation, expected_cancel_generation)?;
    let now = timestamp(now)?;

    let transition = super::driver::generation_transition(transition_name)
        .ok_or_else(|| DriverStateError::new(ERR_VALIDATION, "unknown generation transition"))?;
    let sql = super::driver::generation_update_sql(transition);

    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    require_active_lease(&tx, lease, now)?;

    // 拼参数：set_params + (room, task, execution_generation, cancel_generation)
    let mut params: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
    for p in set_params {
        params.push(Box::new(ToSqlRef(p)));
    }
    params.push(Box::new(identity.room_id.clone()));
    params.push(Box::new(identity.task_id.clone()));
    params.push(Box::new(expected_execution_generation));
    params.push(Box::new(expected_cancel_generation));
    let refs: Vec<&dyn rusqlite::ToSql> = params.iter().map(|p| p.as_ref()).collect();

    let affected = tx.execute(&sql, refs.as_slice())?;
    if affected != 1 {
        return Err(DriverStateError::new(ERR_STALE_TASK, transition.stale_message));
    }

    let task = load_task(&tx, identity)?;
    tx.commit()?;
    Ok(task)
}

/// 把 `&dyn ToSql` 包成可装箱的 `ToSql`（借用转拥有）。
struct ToSqlRef<'a>(&'a dyn rusqlite::ToSql);

impl rusqlite::ToSql for ToSqlRef<'_> {
    fn to_sql(&self) -> rusqlite::Result<rusqlite::types::ToSqlOutput<'_>> {
        self.0.to_sql()
    }
}

/// 上游 `resolve_indeterminate_task()`：在当前房间租约下提交**已验证的历史回执**。
pub fn resolve_indeterminate_task(
    conn: &mut Connection,
    identity: &TaskIdentity,
    lease: &DriverLease,
    expected_execution_generation: i64,
    expected_cancel_generation: i64,
    settlement_id: &str,
    status: &str,
    result: &Value,
    now: f64,
) -> DriverResult<DriverTask> {
    let settlement_id = terminal_settlement(settlement_id, status)?;
    let result_json = settlement_result(status, result)?;
    let now = timestamp(now)?;
    generation_transition(
        conn,
        identity,
        lease,
        "resolve",
        expected_execution_generation,
        expected_cancel_generation,
        now,
        &[&status, &settlement_id, &status, &result_json, &now, &now],
    )
}

/// 上游 `resolve_indeterminate_cancellation()`：为一次不确定的执行提交已验证的终态取消。
pub fn resolve_indeterminate_cancellation(
    conn: &mut Connection,
    identity: &TaskIdentity,
    lease: &DriverLease,
    expected_execution_generation: i64,
    expected_cancel_generation: i64,
    cancel_id: &str,
    now: f64,
) -> DriverResult<DriverTask> {
    let cancel_id = identifier(cancel_id, "cancel_id")?;
    let now = timestamp(now)?;
    let next_cancel = expected_cancel_generation + 1;
    generation_transition(
        conn,
        identity,
        lease,
        "resolve_cancel",
        expected_execution_generation,
        expected_cancel_generation,
        now,
        &[&next_cancel, &cancel_id, &now, &now],
    )
}

/// 上游 `requeue_indeterminate_task()`：运维接受 at-least-once 风险后显式重试。
pub fn requeue_indeterminate_task(
    conn: &mut Connection,
    identity: &TaskIdentity,
    lease: &DriverLease,
    expected_execution_generation: i64,
    expected_cancel_generation: i64,
    now: f64,
) -> DriverResult<DriverTask> {
    let now = timestamp(now)?;
    generation_transition(
        conn,
        identity,
        lease,
        "requeue",
        expected_execution_generation,
        expected_cancel_generation,
        now,
        &[&now],
    )
}

/// 上游 `defer_indeterminate_task()`：fence 一次不确定的执行，放行后续房间工作。
pub fn defer_indeterminate_task(
    conn: &mut Connection,
    identity: &TaskIdentity,
    lease: &DriverLease,
    expected_execution_generation: i64,
    expected_cancel_generation: i64,
    reason: &str,
    now: f64,
) -> DriverResult<DriverTask> {
    defer_inner(
        conn,
        identity,
        lease,
        "defer",
        expected_execution_generation,
        expected_cancel_generation,
        reason,
        now,
    )
}

/// 上游 `defer_unconfirmed_stop()`：放行被一个成员永远没确认的 Stop 挡住的工作。
///
/// **deferred，永不 cancelled。**
pub fn defer_unconfirmed_stop(
    conn: &mut Connection,
    identity: &TaskIdentity,
    lease: &DriverLease,
    expected_execution_generation: i64,
    expected_cancel_generation: i64,
    reason: &str,
    now: f64,
) -> DriverResult<DriverTask> {
    defer_inner(
        conn,
        identity,
        lease,
        "defer_stopping",
        expected_execution_generation,
        expected_cancel_generation,
        reason,
        now,
    )
}

#[allow(clippy::too_many_arguments)]
fn defer_inner(
    conn: &mut Connection,
    identity: &TaskIdentity,
    lease: &DriverLease,
    transition_name: &str,
    expected_execution_generation: i64,
    expected_cancel_generation: i64,
    reason: &str,
    now: f64,
) -> DriverResult<DriverTask> {
    let reason = identifier(reason, "defer_reason")?;
    let result_json = common::compact_json(&json!({"reason": reason, "retryable": true}), true);
    let now = timestamp(now)?;
    generation_transition(
        conn,
        identity,
        lease,
        transition_name,
        expected_execution_generation,
        expected_cancel_generation,
        now,
        &[&result_json, &now, &now],
    )
}

/// 上游 `reopen_deferred_task()`：把 deferred 退回 indeterminate，**代际不变**。
pub fn reopen_deferred_task(
    conn: &mut Connection,
    identity: &TaskIdentity,
    lease: &DriverLease,
    expected_execution_generation: i64,
    expected_cancel_generation: i64,
    now: f64,
) -> DriverResult<DriverTask> {
    let now = timestamp(now)?;
    generation_transition(
        conn,
        identity,
        lease,
        "reopen_deferred",
        expected_execution_generation,
        expected_cancel_generation,
        now,
        &[&now, &now, &now],
    )
}

/// 上游 `requeue_deferred_task()`：显式重试一个被 fence 的 deferred turn。
pub fn requeue_deferred_task(
    conn: &mut Connection,
    identity: &TaskIdentity,
    lease: &DriverLease,
    expected_execution_generation: i64,
    expected_cancel_generation: i64,
    now: f64,
) -> DriverResult<DriverTask> {
    let now = timestamp(now)?;
    generation_transition(
        conn,
        identity,
        lease,
        "requeue_deferred",
        expected_execution_generation,
        expected_cancel_generation,
        now,
        &[&now],
    )
}

// ── 崩溃恢复 ────────────────────────────────────────────────────────────────

/// 上游 `mark_attempt_indeterminate()`：退役**恰好那一次**无人看管的执行。
///
/// 关键：即使别的控制面续了租约，只要任务行还停在 (running, 那两代)，
/// 这次标记就该生效（fenced）。代际不符则**静默返回**（上游 `return`，不报错）。
pub fn mark_attempt_indeterminate(
    conn: &mut Connection,
    attempt: &TaskAttempt,
    lease: &DriverLease,
    now: f64,
) -> DriverResult<()> {
    check_same_room(lease, &attempt.identity)?;
    let now = timestamp(now)?;

    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    require_active_lease(&tx, lease, now)?;

    let row = load_task(&tx, &attempt.identity)?;
    // 上游：代际不匹配就 return（不是错误）
    if row.status != "running"
        || row.execution_generation != attempt.execution_generation
        || row.cancel_generation != attempt.cancel_generation
    {
        tx.commit()?;
        return Ok(());
    }

    tx.execute(
        "UPDATE hosted_room_driver_tasks SET status='indeterminate', indeterminate_at=?, updated_at=?
         WHERE room_id=? AND task_id=? AND status='running' AND execution_generation=? AND cancel_generation=?",
        rusqlite::params![
            now,
            now,
            attempt.identity.room_id,
            attempt.identity.task_id,
            attempt.execution_generation,
            attempt.cancel_generation
        ],
    )?;
    tx.commit()?;
    Ok(())
}

/// 上游 `recover_room()` 的返回：`{status: [task_identity...]}`。
#[derive(Debug, Clone, PartialEq)]
pub struct RecoveredRoom {
    pub queued: Vec<TaskIdentity>,
    pub indeterminate: Vec<TaskIdentity>,
}

/// 上游 `recover_room()`：把**别人留下的** running 尝试 fence 成 indeterminate，
/// **绝不重排不确定的工作**。
///
/// 判据：`status='running' AND NOT (run fence 是我的)`——即不是本进程代际那次执行。
pub fn recover_room(
    conn: &mut Connection,
    lease: &DriverLease,
    now: f64,
) -> DriverResult<RecoveredRoom> {
    let now = timestamp(now)?;

    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    require_active_lease(&tx, lease, now)?;

    // 先把不属于我的 running 全标成 indeterminate
    let foreign = "room_id=? AND status='running'
        AND NOT (run_gateway_id=? AND run_process_generation=? AND run_lease_generation=?)";
    tx.execute(
        &format!(
            "UPDATE hosted_room_driver_tasks SET status='indeterminate', indeterminate_at=?, updated_at=?
             WHERE {foreign}"
        ),
        rusqlite::params![
            now,
            now,
            lease.room_id,
            lease.gateway_id,
            lease.process_generation,
            lease.lease_generation
        ],
    )?;

    // 读回 queued 与 indeterminate（按准入序）
    let read_ids = |status: &str| -> DriverResult<Vec<TaskIdentity>> {
        let sql = format!(
            "SELECT room_id, task_id, thread_id, turn_id FROM hosted_room_driver_tasks
             WHERE room_id=?1 AND status=?2 {TASK_ORDER}"
        );
        let mut stmt = tx.prepare(&sql)?;
        let rows = stmt.query_map(rusqlite::params![lease.room_id, status], |row| {
            Ok(TaskIdentity {
                room_id: row.get(0)?,
                task_id: row.get(1)?,
                thread_id: row.get(2)?,
                turn_id: row.get(3)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    };

    let queued = read_ids("queued")?;
    let indeterminate = read_ids("indeterminate")?;
    tx.commit()?;
    Ok(RecoveredRoom {
        queued,
        indeterminate,
    })
}

// ── 状态汇总 / 清理 ─────────────────────────────────────────────────────────

/// 上游 `room_task_summary()`：`({status: count}, 那些状态的任务，按准入序)`。
pub fn room_task_summary(
    conn: &Connection,
    room_id: &str,
    statuses: &[&str],
) -> DriverResult<(std::collections::BTreeMap<String, i64>, Vec<DriverTask>)> {
    identifier(room_id, "room_id")?;
    for status in statuses {
        if !super::driver::TASK_STATUSES.contains(status) {
            return Err(DriverStateError::new(ERR_VALIDATION, "invalid task status"));
        }
    }

    let mut counts = std::collections::BTreeMap::new();
    let mut stmt = conn.prepare(
        "SELECT status, COUNT(*) FROM hosted_room_driver_tasks WHERE room_id=?1 GROUP BY status",
    )?;
    let mut rows = stmt.query([room_id])?;
    while let Some(row) = rows.next()? {
        let status: String = row.get(0)?;
        let count: i64 = row.get(1)?;
        counts.insert(status, count);
    }

    let tasks = if statuses.is_empty() {
        Vec::new()
    } else {
        super::driver::list_tasks(conn, room_id, MAX_RETAINED_TERMINAL_TASKS.min(MAX_TASK_PRUNE_BATCH))?
            .into_iter()
            .filter(|task| statuses.contains(&task.status.as_str()))
            .collect()
    };
    Ok((counts, tasks))
}

/// 上游 `prune_published_terminal_tasks()`：终态结果已durable在房间日志后，
/// 限制执行行数（保留 30 天 / 最多 2048 条）。
pub fn prune_published_terminal_tasks(
    conn: &mut Connection,
    room_id: &str,
    now: f64,
    retention_seconds: f64,
    retain: i64,
) -> DriverResult<usize> {
    identifier(room_id, "room_id")?;
    if !(retention_seconds.is_finite() && retention_seconds >= 0.0) {
        return Err(DriverStateError::new(ERR_VALIDATION, "retention_seconds is invalid"));
    }
    if retain < 0 || retain > MAX_RETAINED_TERMINAL_TASKS {
        return Err(DriverStateError::new(ERR_VALIDATION, "retain is invalid"));
    }
    let now = timestamp(now)?;
    let cutoff = now - retention_seconds;

    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;

    // 1) 超过保留期的终态任务
    let mut removed = tx.execute(
        "DELETE FROM hosted_room_driver_tasks
         WHERE room_id=?1 AND status IN ('settled','failed','cancelled')
           AND terminal_at IS NOT NULL AND terminal_at < ?2",
        rusqlite::params![room_id, cutoff],
    )?;

    // 2) 超出条数上限的最老终态任务
    let total: i64 = tx.query_row(
        "SELECT COUNT(*) FROM hosted_room_driver_tasks
         WHERE room_id=?1 AND status IN ('settled','failed','cancelled')",
        [room_id],
        |row| row.get(0),
    )?;
    let overflow = (total - retain).max(0).min(MAX_TASK_PRUNE_BATCH);
    if overflow > 0 {
        removed += tx.execute(
            "DELETE FROM hosted_room_driver_tasks WHERE rowid IN (
                SELECT rowid FROM hosted_room_driver_tasks
                WHERE room_id=?1 AND status IN ('settled','failed','cancelled')
                ORDER BY terminal_at ASC, task_id ASC LIMIT ?2
             )",
            rusqlite::params![room_id, overflow],
        )?;
    }

    tx.commit()?;
    Ok(removed)
}

/// 上游 `SHOWN_TASK_STATUSES` 的便捷读取（房间状态用）。
pub fn shown_statuses() -> &'static [&'static str] {
    SHOWN_TASK_STATUSES
}

/// 终态判断（上游 `TERMINAL_STATUSES`）。
pub fn is_terminal_status(status: &str) -> bool {
    TERMINAL_STATUSES.contains(&status)
}

/// 默认保留期（上游常量）。
pub fn default_retention() -> f64 {
    TERMINAL_TASK_RETENTION_SECONDS
}

/// 默认保留条数（上游常量）。
pub fn default_retain() -> i64 {
    MAX_RETAINED_TERMINAL_TASKS
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hosted_rooms::driver::{
        acquire_lease, create_task, initialize_driver_schema, read_task, LeaseRequest,
    };
    use serde_json::json;

    /// 建库 + 房间 + driver 表 + 一把租约。
    fn setup() -> (Connection, DriverLease) {
        let mut conn = super::super::store::open_in_memory().unwrap();
        super::super::store::create_room(
            &mut conn,
            &json!("room-1"),
            &json!("Room"),
            &json!([]),
            &json!("gw-1"),
            Some(1.0),
        )
        .unwrap();
        initialize_driver_schema(&conn).unwrap();
        let lease = acquire_lease(
            &mut conn,
            &LeaseRequest {
                room_id: "room-1",
                gateway_id: "gw-1",
                authority_epoch: 1,
                process_generation: "proc-a",
                ttl_seconds: 3600.0,
                now: 100.0,
            },
        )
        .unwrap();
        (conn, lease)
    }

    fn payload(seq: i64) -> Value {
        json!({"target_profile": "alice", "prompt": "do it", "source_event_seq": seq})
    }

    fn add_task(conn: &mut Connection, id: &str, seq: i64) {
        create_task(
            conn,
            "room-1",
            id,
            &format!("th-{id}"),
            &format!("tu-{id}"),
            seq,
            &payload(seq),
            100.0,
        )
        .unwrap();
    }

    fn identity(id: &str) -> TaskIdentity {
        TaskIdentity::new("room-1", id, &format!("th-{id}"), &format!("tu-{id}")).unwrap()
    }

    // ── start_task ─────────────────────────────────────────────────────────

    #[test]
    fn start_moves_queued_to_running() {
        let (mut conn, lease) = setup();
        add_task(&mut conn, "t1", 1);
        let attempt = start_task(&mut conn, &identity("t1"), &lease, 0, 110.0).unwrap();
        assert_eq!(attempt.execution_generation, 1);
        assert_eq!(attempt.cancel_generation, 0);
        let task = read_task(&conn, "room-1", "t1").unwrap().unwrap();
        assert_eq!(task.status, "running");
        assert_eq!(task.run_gateway_id.as_deref(), Some("gw-1"));
        assert_eq!(task.started_at, Some(110.0));
    }

    #[test]
    fn start_requires_task_to_be_next_in_order() {
        let (mut conn, lease) = setup();
        add_task(&mut conn, "t2", 2);
        add_task(&mut conn, "t1", 1);
        // t2 先入表但 seq=2；下一个应是 t1
        let err = start_task(&mut conn, &identity("t2"), &lease, 0, 110.0).unwrap_err();
        assert_eq!(err.message, "task is not next in the hosted room event order");
        // t1 可以
        assert!(start_task(&mut conn, &identity("t1"), &lease, 0, 110.0).is_ok());
    }

    #[test]
    fn start_blocks_while_another_task_is_unresolved() {
        let (mut conn, lease) = setup();
        add_task(&mut conn, "t1", 1);
        add_task(&mut conn, "t2", 2);
        start_task(&mut conn, &identity("t1"), &lease, 0, 110.0).unwrap();
        // t1 在 running → 不能开始 t2
        let err = start_task(&mut conn, &identity("t2"), &lease, 0, 120.0).unwrap_err();
        assert_eq!(
            err.message,
            "room recovery must resolve the prior task before starting new work"
        );
    }

    #[test]
    fn start_rejects_non_queued_state() {
        let (mut conn, lease) = setup();
        add_task(&mut conn, "t1", 1);
        start_task(&mut conn, &identity("t1"), &lease, 0, 110.0).unwrap();
        let err = start_task(&mut conn, &identity("t1"), &lease, 0, 120.0).unwrap_err();
        assert_eq!(err.code, ERR_INVALID_TRANSITION);
    }

    #[test]
    fn start_rejects_wrong_cancel_generation() {
        let (mut conn, lease) = setup();
        add_task(&mut conn, "t1", 1);
        let err = start_task(&mut conn, &identity("t1"), &lease, 5, 110.0).unwrap_err();
        assert_eq!(err.code, ERR_STALE_TASK);
    }

    #[test]
    fn start_requires_live_lease() {
        let (mut conn, lease) = setup();
        add_task(&mut conn, "t1", 1);
        // now 超过 expires_at（100+3600）
        let err = start_task(&mut conn, &identity("t1"), &lease, 0, 9999.0).unwrap_err();
        assert_eq!(err.code, ERR_STALE_LEASE);
    }

    // ── settle_task ────────────────────────────────────────────────────────

    #[test]
    fn settle_commits_terminal_result() {
        let (mut conn, lease) = setup();
        add_task(&mut conn, "t1", 1);
        let attempt = start_task(&mut conn, &identity("t1"), &lease, 0, 110.0).unwrap();
        let task = settle_task(
            &mut conn,
            &attempt,
            "settle-1",
            "settled",
            &json!({"text": "done"}),
            120.0,
            false,
        )
        .unwrap();
        assert_eq!(task.status, "settled");
        assert_eq!(task.settlement_id.as_deref(), Some("settle-1"));
        assert_eq!(task.settlement_status.as_deref(), Some("settled"));
        assert_eq!(task.terminal_at, Some(120.0));
        assert!(task.is_terminal());
    }

    #[test]
    fn settle_rejects_invalid_terminal_status() {
        let (mut conn, lease) = setup();
        add_task(&mut conn, "t1", 1);
        let attempt = start_task(&mut conn, &identity("t1"), &lease, 0, 110.0).unwrap();
        let err = settle_task(&mut conn, &attempt, "s1", "cancelled", &json!({}), 120.0, false).unwrap_err();
        assert_eq!(err.message, "invalid terminal status 'cancelled'");
    }

    #[test]
    fn settle_requires_matching_run_fence() {
        let (mut conn, lease) = setup();
        add_task(&mut conn, "t1", 1);
        let mut attempt = start_task(&mut conn, &identity("t1"), &lease, 0, 110.0).unwrap();
        // 篡改执行代际 → run fence 不匹配
        attempt.execution_generation = 99;
        let err = settle_task(&mut conn, &attempt, "s1", "settled", &json!({}), 120.0, false).unwrap_err();
        assert_eq!(err.code, ERR_STALE_TASK);
    }

    #[test]
    fn settle_allow_expired_lease_still_checks_ownership() {
        let (mut conn, lease) = setup();
        add_task(&mut conn, "t1", 1);
        let attempt = start_task(&mut conn, &identity("t1"), &lease, 0, 110.0).unwrap();
        // 租约已过期，但 allow_expired_lease=true → 允许
        let task = settle_task(
            &mut conn,
            &attempt,
            "s1",
            "settled",
            &json!({}),
            9999.0,
            true,
        )
        .unwrap();
        assert_eq!(task.status, "settled");

        // 但换一个进程代际就不行
        let (mut conn2, lease2) = setup();
        add_task(&mut conn2, "t1", 1);
        let attempt2 = start_task(&mut conn2, &identity("t1"), &lease2, 0, 110.0).unwrap();
        let mut forged = attempt2.clone();
        forged.lease.process_generation = "proc-other".into();
        assert_eq!(
            settle_task(&mut conn2, &forged, "s1", "settled", &json!({}), 120.0, true)
                .unwrap_err()
                .code,
            ERR_STALE_LEASE
        );
    }

    // ── cancel 三步 ────────────────────────────────────────────────────────

    #[test]
    fn cancel_queued_task_bumps_generation() {
        let (mut conn, _lease) = setup();
        add_task(&mut conn, "t1", 1);
        let task = cancel_task(&mut conn, &identity("t1"), "c1", 0, 110.0).unwrap();
        assert_eq!(task.status, "cancelled");
        assert_eq!(task.cancel_generation, 1);
        assert_eq!(task.cancel_id.as_deref(), Some("c1"));
    }

    #[test]
    fn cancel_rejects_running_task() {
        let (mut conn, lease) = setup();
        add_task(&mut conn, "t1", 1);
        start_task(&mut conn, &identity("t1"), &lease, 0, 110.0).unwrap();
        let err = cancel_task(&mut conn, &identity("t1"), "c1", 0, 120.0).unwrap_err();
        assert_eq!(
            err.message,
            "running work requires acknowledged two-phase cancellation"
        );
    }

    #[test]
    fn begin_and_complete_stop_two_phase() {
        let (mut conn, lease) = setup();
        add_task(&mut conn, "t1", 1);
        start_task(&mut conn, &identity("t1"), &lease, 0, 110.0).unwrap();

        // 阶段 1：记停止意图
        let stopping = begin_task_cancel(&mut conn, &identity("t1"), "c1", 0, 120.0).unwrap();
        assert_eq!(stopping.status, "stopping");
        assert_eq!(stopping.cancel_generation, 1);
        // 还没有 terminal_at
        assert!(stopping.terminal_at.is_none());

        // 阶段 2：确认后才 cancelled
        let cancelled = complete_task_cancel(&mut conn, &identity("t1"), "c1", 1, 130.0).unwrap();
        assert_eq!(cancelled.status, "cancelled");
        assert_eq!(cancelled.terminal_at, Some(130.0));
    }

    #[test]
    fn complete_stop_rejects_stale_acknowledgement() {
        let (mut conn, lease) = setup();
        add_task(&mut conn, "t1", 1);
        start_task(&mut conn, &identity("t1"), &lease, 0, 110.0).unwrap();
        begin_task_cancel(&mut conn, &identity("t1"), "c1", 0, 120.0).unwrap();
        // 用错的 cancel_id
        let err = complete_task_cancel(&mut conn, &identity("t1"), "c-other", 1, 130.0).unwrap_err();
        assert_eq!(err.message, "task stop acknowledgement is stale");
    }

    #[test]
    fn begin_stop_rejects_queued_task() {
        let (mut conn, _lease) = setup();
        add_task(&mut conn, "t1", 1);
        let err = begin_task_cancel(&mut conn, &identity("t1"), "c1", 0, 110.0).unwrap_err();
        assert_eq!(err.message, "cannot request remote stop in state 'queued'");
    }

    // ── reconcile ──────────────────────────────────────────────────────────

    fn indeterminate_attempt(conn: &mut Connection, lease: &DriverLease) -> TaskAttempt {
        add_task(conn, "t1", 1);
        let attempt = start_task(conn, &identity("t1"), lease, 0, 110.0).unwrap();
        mark_attempt_indeterminate(conn, &attempt, lease, 115.0).unwrap();
        attempt
    }

    #[test]
    fn mark_indeterminate_moves_running_task() {
        let (mut conn, lease) = setup();
        let attempt = indeterminate_attempt(&mut conn, &lease);
        let task = read_task(&conn, "room-1", "t1").unwrap().unwrap();
        assert_eq!(task.status, "indeterminate");
        assert_eq!(task.indeterminate_at, Some(115.0));
        assert_eq!(task.execution_generation, attempt.execution_generation);
    }

    #[test]
    fn mark_indeterminate_is_noop_when_generation_moved() {
        let (mut conn, lease) = setup();
        let mut attempt = indeterminate_attempt(&mut conn, &lease);
        // 再次调用同代际 → 静默 no-op（上游 return）
        mark_attempt_indeterminate(&mut conn, &attempt, &lease, 120.0).unwrap();
        let task = read_task(&conn, "room-1", "t1").unwrap().unwrap();
        // indeterminate_at 保持第一次
        assert_eq!(task.indeterminate_at, Some(115.0));

        // 篡改代际 → 也是 no-op，不改状态
        attempt.execution_generation += 5;
        mark_attempt_indeterminate(&mut conn, &attempt, &lease, 130.0).unwrap();
        let task = read_task(&conn, "room-1", "t1").unwrap().unwrap();
        assert_eq!(task.indeterminate_at, Some(115.0));
    }

    #[test]
    fn resolve_indeterminate_commits_receipt() {
        let (mut conn, lease) = setup();
        let attempt = indeterminate_attempt(&mut conn, &lease);
        let task = resolve_indeterminate_task(
            &mut conn,
            &identity("t1"),
            &lease,
            attempt.execution_generation,
            attempt.cancel_generation,
            "s1",
            "settled",
            &json!({"ok": true}),
            140.0,
        )
        .unwrap();
        assert_eq!(task.status, "settled");
        assert_eq!(task.terminal_at, Some(140.0));
    }

    #[test]
    fn resolve_indeterminate_cancellation_bumps_cancel_generation() {
        let (mut conn, lease) = setup();
        let attempt = indeterminate_attempt(&mut conn, &lease);
        let task = resolve_indeterminate_cancellation(
            &mut conn,
            &identity("t1"),
            &lease,
            attempt.execution_generation,
            attempt.cancel_generation,
            "c1",
            140.0,
        )
        .unwrap();
        assert_eq!(task.status, "cancelled");
        assert_eq!(task.cancel_generation, attempt.cancel_generation + 1);
    }

    #[test]
    fn requeue_indeterminate_returns_to_queue() {
        let (mut conn, lease) = setup();
        let attempt = indeterminate_attempt(&mut conn, &lease);
        let task = requeue_indeterminate_task(
            &mut conn,
            &identity("t1"),
            &lease,
            attempt.execution_generation,
            attempt.cancel_generation,
            140.0,
        )
        .unwrap();
        assert_eq!(task.status, "queued");
        // run fence 已清空
        assert!(task.run_gateway_id.is_none());
        assert!(task.indeterminate_at.is_none());
    }

    #[test]
    fn defer_indeterminate_marks_retryable() {
        let (mut conn, lease) = setup();
        let attempt = indeterminate_attempt(&mut conn, &lease);
        let task = defer_indeterminate_task(
            &mut conn,
            &identity("t1"),
            &lease,
            attempt.execution_generation,
            attempt.cancel_generation,
            "needs-review",
            140.0,
        )
        .unwrap();
        assert_eq!(task.status, "deferred");
        let result: Value = serde_json::from_str(task.result_json.as_deref().unwrap()).unwrap();
        assert_eq!(result["reason"], "needs-review");
        assert_eq!(result["retryable"], true);
    }

    #[test]
    fn defer_unconfirmed_stop_is_deferred_not_cancelled() {
        let (mut conn, lease) = setup();
        add_task(&mut conn, "t1", 1);
        start_task(&mut conn, &identity("t1"), &lease, 0, 110.0).unwrap();
        // 进入 stopping
        begin_task_cancel(&mut conn, &identity("t1"), "c1", 0, 115.0).unwrap();
        let task = defer_unconfirmed_stop(&mut conn, &identity("t1"), &lease, 1, 1, "no-ack", 140.0).unwrap();
        // 上游核心语义：deferred，永不 cancelled
        assert_eq!(task.status, "deferred");
    }

    #[test]
    fn reopen_deferred_returns_to_indeterminate_same_generation() {
        let (mut conn, lease) = setup();
        let attempt = indeterminate_attempt(&mut conn, &lease);
        defer_indeterminate_task(
            &mut conn,
            &identity("t1"),
            &lease,
            attempt.execution_generation,
            attempt.cancel_generation,
            "wait",
            140.0,
        )
        .unwrap();
        let task = reopen_deferred_task(
            &mut conn,
            &identity("t1"),
            &lease,
            attempt.execution_generation,
            attempt.cancel_generation,
            150.0,
        )
        .unwrap();
        assert_eq!(task.status, "indeterminate");
        assert_eq!(task.execution_generation, attempt.execution_generation);
        // 重开重启尝试时钟
        assert_eq!(task.started_at, Some(150.0));
    }

    #[test]
    fn requeue_deferred_clears_state() {
        let (mut conn, lease) = setup();
        let attempt = indeterminate_attempt(&mut conn, &lease);
        defer_indeterminate_task(
            &mut conn,
            &identity("t1"),
            &lease,
            attempt.execution_generation,
            attempt.cancel_generation,
            "wait",
            140.0,
        )
        .unwrap();
        let task = requeue_deferred_task(
            &mut conn,
            &identity("t1"),
            &lease,
            attempt.execution_generation,
            attempt.cancel_generation,
            150.0,
        )
        .unwrap();
        assert_eq!(task.status, "queued");
        assert!(task.result_json.is_none());
        assert!(task.terminal_at.is_none());
    }

    #[test]
    fn reconcile_rejects_stale_generations() {
        let (mut conn, lease) = setup();
        let attempt = indeterminate_attempt(&mut conn, &lease);
        let err = requeue_indeterminate_task(
            &mut conn,
            &identity("t1"),
            &lease,
            attempt.execution_generation + 5,
            attempt.cancel_generation,
            140.0,
        )
        .unwrap_err();
        assert_eq!(err.code, ERR_STALE_TASK);
    }

    // ── recover_room ───────────────────────────────────────────────────────

    #[test]
    fn recover_fences_foreign_running_tasks() {
        let (mut conn, lease) = setup();
        add_task(&mut conn, "t1", 1);
        // 用"别人的"租约身份把任务推进到 running（手工写 run fence）
        conn.execute(
            "UPDATE hosted_room_driver_tasks SET status='running', execution_generation=1,
                run_gateway_id='gw-other', run_process_generation='proc-old', run_lease_generation=9,
                started_at=100.0, updated_at=100.0 WHERE task_id='t1'",
            [],
        )
        .unwrap();

        let recovered = recover_room(&mut conn, &lease, 200.0).unwrap();
        assert!(recovered.queued.is_empty());
        assert_eq!(recovered.indeterminate.len(), 1);
        assert_eq!(recovered.indeterminate[0].task_id, "t1");

        // 状态确实变成 indeterminate
        let task = read_task(&conn, "room-1", "t1").unwrap().unwrap();
        assert_eq!(task.status, "indeterminate");
    }

    #[test]
    fn recover_leaves_own_running_task_alone() {
        let (mut conn, lease) = setup();
        add_task(&mut conn, "t1", 1);
        start_task(&mut conn, &identity("t1"), &lease, 0, 110.0).unwrap();
        let recovered = recover_room(&mut conn, &lease, 200.0).unwrap();
        // 自己的 running 不算 foreign
        assert!(recovered.indeterminate.is_empty());
        let task = read_task(&conn, "room-1", "t1").unwrap().unwrap();
        assert_eq!(task.status, "running");
    }

    // ── summary / prune ────────────────────────────────────────────────────

    #[test]
    fn summary_counts_by_status() {
        let (mut conn, lease) = setup();
        add_task(&mut conn, "t1", 1);
        add_task(&mut conn, "t2", 2);
        start_task(&mut conn, &identity("t1"), &lease, 0, 110.0).unwrap();
        let (counts, tasks) = room_task_summary(&conn, "room-1", &["queued", "running"]).unwrap();
        assert_eq!(counts.get("queued"), Some(&1));
        assert_eq!(counts.get("running"), Some(&1));
        assert_eq!(tasks.len(), 2);
    }

    #[test]
    fn summary_rejects_unknown_status() {
        let (conn, _lease) = setup();
        assert_eq!(
            room_task_summary(&conn, "room-1", &["nope"]).unwrap_err().code,
            ERR_VALIDATION
        );
    }

    #[test]
    fn prune_removes_old_terminal_tasks() {
        let (mut conn, lease) = setup();
        add_task(&mut conn, "t1", 1);
        add_task(&mut conn, "t2", 2);
        let a1 = start_task(&mut conn, &identity("t1"), &lease, 0, 110.0).unwrap();
        settle_task(&mut conn, &a1, "s1", "settled", &json!({}), 120.0, false).unwrap();
        let a2 = start_task(&mut conn, &identity("t2"), &lease, 0, 130.0).unwrap();
        settle_task(&mut conn, &a2, "s2", "settled", &json!({}), 140.0, false).unwrap();

        // 保留期 10 秒，now=200 → 两条（120/140）都超期
        let removed = prune_published_terminal_tasks(&mut conn, "room-1", 200.0, 10.0, 2048).unwrap();
        assert_eq!(removed, 2);
    }

    #[test]
    fn prune_keeps_recent_terminal_tasks() {
        let (mut conn, lease) = setup();
        add_task(&mut conn, "t1", 1);
        let a1 = start_task(&mut conn, &identity("t1"), &lease, 0, 110.0).unwrap();
        settle_task(&mut conn, &a1, "s1", "settled", &json!({}), 120.0, false).unwrap();
        // 保留期 1 天，now=130 → 不超期
        let removed = prune_published_terminal_tasks(&mut conn, "room-1", 130.0, 86_400.0, 2048).unwrap();
        assert_eq!(removed, 0);
    }

    #[test]
    fn prune_enforces_retain_cap() {
        let (mut conn, lease) = setup();
        for i in 1..=3 {
            let id = format!("t{i}");
            add_task(&mut conn, &id, i);
            let attempt = start_task(&mut conn, &identity(&id), &lease, 0, 110.0 + i as f64).unwrap();
            settle_task(
                &mut conn,
                &attempt,
                &format!("s{i}"),
                "settled",
                &json!({}),
                115.0 + i as f64,
                false,
            )
            .unwrap();
        }
        // 只保留 1 条 → 删 2 条
        let removed = prune_published_terminal_tasks(&mut conn, "room-1", 200.0, 86_400.0, 1).unwrap();
        assert_eq!(removed, 2);
    }
}
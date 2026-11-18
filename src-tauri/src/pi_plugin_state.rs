//! rpi 插件状态 → 宿主旧 wire 的**只读投影**（2026-11-15）。
//!
//! 已安装的 rpi 插件（cdylib，ABI v4）通过 `runtime_action(AppendEntry)` 把
//! 状态写进**会话条目**（jsonl 的 custom entry）。本模块只做两件事：
//!
//! 1. 定义插件条目类型常量（与插件源码逐字一致，见下方证据）；
//! 2. 把条目 `data` 校验后投影成前端正在消费的旧 wire 形状。
//!
//! 不改插件、不改会话文件；损坏条目一律 `Err`（与插件自身的恢复语义一致：
//! rpi-todo `restore_from_branch` 对坏 data 直接 Blocked，不回退旧快照）。
//!
//! ## 插件源码证据（rpi-package @ main，2026-11-15 拉取）
//!
//! - `packages/rpi-todo/src/lib.rs`：
//!   `const TODO_ENTRY: &str = "todo-state";`（第 16 行）
//!   `RuntimeActionId::AppendEntry, json!({"customType": TODO_ENTRY, "data":
//!   state_json(&next)})`（第 245-246 行）；`state_json` = `{todos:[{id,text,
//!   done,status}], nextId}`，`status` ∈ pending / in_progress / completed。
//! - `packages/rpi-plan-mode/src/lib.rs`：
//!   `const PLAN_ENTRY: &str = "plan-mode";`（第 15 行）
//!   `RuntimeActionId::AppendEntry, json!({"customType": PLAN_ENTRY, "data":
//!   {"active": active, "plan": plan}})`（第 90-91 行）。
//! - `packages/rpi-subagents` / `rpi-orchestrator`：**无 AppendEntry**——子代理
//!   运行态只在插件进程内存（`ChildAgent` runtime action 24 / 进程内 DAG），
//!   两个插件都没有 `SetStatus`，宿主无读取面（故 hub 面保留 Err）。
//! - `packages/rpi-background-tasks/src/lib.rs`：`SNAPSHOT_ENTRY =
//!   "background-tasks"`（第 27 行），每次作业状态变化都 AppendEntry 一条自包含
//!   快照；`data = {"jobs":[{id,kind,label,command,status,pid?,exitCode?,
//!   startedAt,finishedAt?}]}`（`Job::snapshot`，第 133-151 行），`status`
//!   ∈ running / completed / failed / interrupted / cancelled。宿主原来以
//!   "缺 wire 字段"为由 Err；2026-11-18 起改为投影这组真字段（占位字段不再
//!   要求——面板行只显示命令行/标签 + 用时），插件未安装时条目恒空。
//! - **宿主自己写的 `goal-iterations` / `goal-verification` 条目**
//!   （`pi_goal_verify.rs`，2026-11-18）：每次 run 收尾（goal 为 active）
//!   AppendEntry 一条**迭代行** `{goalTitle, goalStartedAt, iteration,
//!   items:[{id,content,status}], updatedAt}`（status ∈ pending / inProgress /
//!   completed，ZCode plan-item 词表）与一条**校验结论** `{goalTitle,
//!   goalStartedAt, iteration, outcome, at, reason?, nextAction?}`。宿主
//!   `goal_state` 读入后按 goalTitle+goalStartedAt 匹配并入
//!   active.iterations / active.verifications（`merge_goal_timeline`）。
//!   —— 这两条走引擎的 AppendEntry 通道（会话元数据，不进模型上下文），
//!   与插件写状态的通道相同。

use serde_json::{json, Value};

/// rpi-todo 的会话条目 customType。
pub const TODO_ENTRY: &str = "todo-state";

/// rpi-plan-mode 的会话条目 customType。
pub const PLAN_ENTRY: &str = "plan-mode";

/// rpi-background-tasks 的会话条目 customType（=`SNAPSHOT_ENTRY`，与 crate 名
/// 有意不同）。
pub const BACKGROUND_TASKS_ENTRY: &str = "background-tasks";

/// 旧 wire 的 todo schema 名（前端 `tool-sidecar.ts` / `todo-store.ts` 按此
/// 值分派；与旧 pi `pi::todo::TODO_LIST_SCHEMA` 同值）。
const TODO_LIST_SCHEMA: &str = "todo_list.v1";

/// 一条 rpi-todo 任务 → 旧 wire 任务行 `{content, state}`。
///
/// 插件用 `status`（pending/in_progress/completed）表达状态；前端的
/// `TodoStatus` 是旧 pi 口径（open/in_progress/done/dropped/blocked），
/// 这里只做一对一改名，不引入前端不认识的取值。
fn todo_task(raw: &Value) -> Result<Value, String> {
    let obj = raw
        .as_object()
        .ok_or_else(|| "todo-state 任务行不是对象".to_string())?;
    // 插件 `parse_todos` 把 id/text 都当必填（任一缺失即整条快照不可用）。
    obj.get("id")
        .and_then(Value::as_u64)
        .ok_or_else(|| "todo-state 任务行缺少数值 id".to_string())?;
    let text = obj
        .get("text")
        .and_then(Value::as_str)
        .ok_or_else(|| "todo-state 任务行缺少字符串 text".to_string())?;
    let state = match obj.get("status").and_then(Value::as_str) {
        Some("completed") => "done",
        Some("in_progress") => "in_progress",
        Some("pending") => "open",
        Some(other) => return Err(format!("todo-state 任务行 status 非法: {other}")),
        // 插件 `parse_todos` 兼容只有 done 的旧形状（done=true = completed）。
        None => match obj.get("done").and_then(Value::as_bool) {
            Some(true) => "done",
            Some(false) => "open",
            None => return Err("todo-state 任务行缺少 status/done".to_string()),
        },
    };
    Ok(json!({ "content": text, "state": state }))
}

/// `pi_todo_state` 的 wire：`{schema, list, summary}`。
///
/// - 无条目（`data = None`）= 诚实空态：`schema/list/summary` 全 null；
/// - 有条目 = `schema: "todo_list.v1"`，`list.phases` 单阶段扁平（插件只有
///   一个平铺列表），`summary` 用插件 `render` 同款计数行
///   （`"{done}/{total} completed"`）。
pub fn todo_wire(data: Option<&Value>) -> Result<Value, String> {
    let Some(data) = data else {
        return Ok(json!({
            "schema": Value::Null,
            "list": Value::Null,
            "summary": Value::Null,
        }));
    };
    let obj = data
        .as_object()
        .ok_or_else(|| "todo-state 条目 data 不是对象".to_string())?;
    let todos = obj
        .get("todos")
        .and_then(Value::as_array)
        .ok_or_else(|| "todo-state 条目缺少 todos 数组".to_string())?;
    let mut tasks = Vec::with_capacity(todos.len());
    let mut done = 0usize;
    for todo in todos {
        let task = todo_task(todo)?;
        if task["state"] == "done" {
            done += 1;
        }
        tasks.push(task);
    }
    let summary = format!("{done}/{} completed", tasks.len());
    Ok(json!({
        "schema": TODO_LIST_SCHEMA,
        "list": { "phases": [{ "name": Value::Null, "tasks": tasks }] },
        "summary": summary,
    }))
}

/// `pi_mode_state` 的 wire：`{approvalMode, planMode, planPending}`。
///
/// rpi 的「模式」只有 rpi-plan-mode 插件的一段会话条目状态：
/// `active=true` = 正在规划（`plan` 尚未产出），`active=false` = 已退出/未进入。
/// 旧 wire 的 `pending_approval` / `approved` 在 rpi 里**没有对应态**——插件
/// `plan_mode_complete` 只是存下计划并退出，没有宿主审批闸，故
/// `planPending` 恒 null（不显示会被 `pi_decide_plan` Err 打回的假审批卡）。
///
/// `approvalMode` 在 rpi 中**不存在**（grep 全仓无 `ApprovalMode`；权限由
/// rpi-permissions / rpi-permission-gate 的规则文件与 ask 对话框承担，没有
/// always-ask/write/yolo 三态开关）。这里如实返回 null（未暴露），不冒充
/// 任何一个模式；前端 mode-store 对未知值已有既有处理。
pub fn mode_wire(data: Option<&Value>) -> Result<Value, String> {
    let Some(data) = data else {
        return Ok(json!({
            "approvalMode": Value::Null,
            "planMode": "off",
            "planPending": Value::Null,
        }));
    };
    let obj = data
        .as_object()
        .ok_or_else(|| "plan-mode 条目 data 不是对象".to_string())?;
    let active = obj
        .get("active")
        .and_then(Value::as_bool)
        .ok_or_else(|| "plan-mode 条目 data.active 不是布尔".to_string())?;
    match obj.get("plan") {
        None | Some(Value::Null) | Some(Value::String(_)) => {}
        Some(_) => return Err("plan-mode 条目 data.plan 不是字符串/null".to_string()),
    }
    Ok(json!({
        "approvalMode": Value::Null,
        "planMode": if active { "planning" } else { "off" },
        "planPending": Value::Null,
    }))
}

/// `pi_job_list` 的 wire（2026-11-18 起 = rpi-background-tasks 快照的真字段）。
///
/// 条目 `data = {"jobs":[{id:string, kind, label, command, status, pid?,
/// exitCode?, startedAt(ms), finishedAt?}]}`。宿主只投影存在过的字段：
/// `startedAtMs` / `finishedAtMs` / `exitCode` / `pid`（缺失留 null），不再
/// 要求旧 pi JobSnapshot 的 artifact 面（rpi 插件不产出产物文件）。
/// 未知 status → Err（规矩 12：不猜成 running）。
pub fn background_tasks_wire(data: Option<&Value>) -> Result<Value, String> {
    let Some(data) = data else {
        return Ok(Value::Array(Vec::new()));
    };
    let jobs = data
        .as_object()
        .and_then(|obj| obj.get("jobs"))
        .and_then(Value::as_array)
        .ok_or_else(|| "background-tasks 条目缺少 jobs 数组".to_string())?;
    let mut rows = Vec::with_capacity(jobs.len());
    for job in jobs {
        let obj = job
            .as_object()
            .ok_or_else(|| "background-tasks 作业行不是对象".to_string())?;
        let id = obj
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| "background-tasks 作业行缺少字符串 id".to_string())?;
        let status = obj
            .get("status")
            .and_then(Value::as_str)
            .ok_or_else(|| format!("background-tasks 作业 {id} 缺少 status"))?;
        if !matches!(
            status,
            "running" | "completed" | "failed" | "interrupted" | "cancelled"
        ) {
            return Err(format!("background-tasks 作业 {id} 的 status 非法: {status}"));
        }
        rows.push(json!({
            "schema": "rpi.background-tasks.v1",
            "id": id,
            "kind": obj.get("kind").and_then(Value::as_str),
            "label": obj.get("label").and_then(Value::as_str),
            "command": obj.get("command").and_then(Value::as_str),
            "status": status,
            "startedAtMs": obj.get("startedAt").and_then(Value::as_f64),
            "finishedAtMs": obj.get("finishedAt").and_then(Value::as_f64),
            "exitCode": obj.get("exitCode").and_then(Value::as_i64),
            "pid": obj.get("pid").and_then(Value::as_u64),
        }));
    }
    Ok(Value::Array(rows))
}

/// 宿主写入的逐轮迭代行会话条目 customType。
///
/// 名字有意不同于 rpi-goal 插件的 `goal-state`：迭代行是宿主面
/// （每次 run 收尾读 todo 快照后 AppendEntry 一条），不是插件状态。
pub const GOAL_ITERATIONS_ENTRY: &str = "goal-attempts";

/// 宿主写入的校验结论会话条目 customType。
pub const GOAL_VERIFICATION_ENTRY: &str = "goal-verification";

/// 把宿主写的 `goal-iterations` / `goal-verification` 条目并入 `goal-state`
/// wire（面板「目标」分区的 ZCode 迭代行 / 校验结论数据面）。
///
/// 规则：
/// - goal-state 无 active / 非对象 = 无可并（迭代与校验都是目标的从属数据）；
/// - 条目形状损坏（缺 goalTitle / goalStartedAt / iteration）→ Err（规矩 12：
///   坏条目可见，不静默丢行）；条目里其他未知字段忽略；
/// - `goalTitle` + `goalStartedAt` 与 active 不一致 = 上一个目标的残留条目，
///   不并入（面板不显示过期目标的迭代/校验）；
/// - 一致 → `active.iterations` / `active.verifications` 按 iteration 升序透出。
pub fn merge_goal_timeline(
    goal_state: &mut Value,
    iterations: &[Value],
    verifications: &[Value],
) -> Result<(), String> {
    let Some(active) = goal_state.get_mut("active") else {
        return Ok(());
    };
    if !active.is_object() {
        return Ok(());
    }
    let active_title = active
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let active_started = active.get("startedAt").and_then(Value::as_i64);

    let matches_goal = |raw: &Value| -> Result<bool, String> {
        let obj = raw
            .as_object()
            .ok_or_else(|| "goal 时间线条目不是对象".to_string())?;
        let title = obj
            .get("goalTitle")
            .and_then(Value::as_str)
            .ok_or_else(|| "goal 时间线条目缺少 goalTitle".to_string())?;
        let started_at = obj
            .get("goalStartedAt")
            .and_then(Value::as_i64)
            .ok_or_else(|| "goal 时间线条目缺少 goalStartedAt".to_string())?;
        Ok(title == active_title && Some(started_at) == active_started)
    };
    let iteration_of = |raw: &Value| -> Result<u64, String> {
        raw.get("iteration")
            .and_then(Value::as_u64)
            .filter(|n| *n >= 1)
            .ok_or_else(|| "goal 时间线条目缺少合法 iteration".to_string())
    };

    let mut iteration_rows: Vec<(u64, Value)> = Vec::new();
    for entry in iterations {
        if !matches_goal(entry)? {
            continue;
        }
        iteration_rows.push((iteration_of(entry)?, entry.clone()));
    }
    iteration_rows.sort_by_key(|(iteration, _)| *iteration);

    let mut verification_rows: Vec<(u64, Value)> = Vec::new();
    for entry in verifications {
        if !matches_goal(entry)? {
            continue;
        }
        verification_rows.push((iteration_of(entry)?, entry.clone()));
    }
    verification_rows.sort_by_key(|(iteration, _)| *iteration);

    let object = active.as_object_mut().expect("checked above");
    object.insert(
        "iterations".to_string(),
        Value::Array(iteration_rows.into_iter().map(|(_, row)| row).collect()),
    );
    object.insert(
        "verifications".to_string(),
        Value::Array(
            verification_rows
                .into_iter()
                .map(|(_, row)| row)
                .collect(),
        ),
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn todo(todos: Value) -> Value {
        json!({ "todos": todos, "nextId": 9 })
    }

    #[test]
    fn todo_wire_without_entry_is_honest_empty() {
        let wire = todo_wire(None).expect("empty");
        assert!(wire["schema"].is_null());
        assert!(wire["list"].is_null());
        assert!(wire["summary"].is_null());
    }

    #[test]
    fn todo_wire_maps_plugin_statuses() {
        let data = todo(json!([
            { "id": 0, "text": "读取仓库", "done": true, "status": "completed" },
            { "id": 1, "text": "改代码", "done": false, "status": "in_progress" },
            { "id": 2, "text": "写测试", "done": false, "status": "pending" },
        ]));
        let wire = todo_wire(Some(&data)).expect("wire");
        assert_eq!(wire["schema"], TODO_LIST_SCHEMA);
        let tasks = wire["list"]["phases"][0]["tasks"]
            .as_array()
            .expect("tasks");
        assert_eq!(tasks.len(), 3);
        assert_eq!(tasks[0]["content"], "读取仓库");
        assert_eq!(tasks[0]["state"], "done");
        assert_eq!(tasks[1]["state"], "in_progress");
        assert_eq!(tasks[2]["state"], "open");
        assert_eq!(wire["summary"], "1/3 completed");
    }

    #[test]
    fn todo_wire_supports_done_only_shape() {
        let data = todo(json!([
            { "id": 0, "text": "旧形状完成", "done": true },
            { "id": 1, "text": "旧形状未完成", "done": false },
        ]));
        let wire = todo_wire(Some(&data)).expect("wire");
        let tasks = &wire["list"]["phases"][0]["tasks"];
        assert_eq!(tasks[0]["state"], "done");
        assert_eq!(tasks[1]["state"], "open");
        assert_eq!(wire["summary"], "1/2 completed");
    }

    #[test]
    fn todo_wire_keeps_empty_snapshot_as_empty_phases() {
        // 插件删掉最后一个 todo 时仍会 append 一条 todos=[] 的快照——
        // 有快照 = schema 在位、任务为空（与"从未建过"的 schema null 区分）。
        let data = todo(json!([]));
        let wire = todo_wire(Some(&data)).expect("wire");
        assert_eq!(wire["schema"], TODO_LIST_SCHEMA);
        assert_eq!(
            wire["list"]["phases"][0]["tasks"]
                .as_array()
                .expect("tasks")
                .len(),
            0
        );
        assert_eq!(wire["summary"], "0/0 completed");
    }

    #[test]
    fn todo_wire_rejects_corrupt_entry() {
        assert!(todo_wire(Some(&json!({ "bogus": true }))).is_err());
        assert!(todo_wire(Some(&json!({ "todos": [{}] }))).is_err());
        assert!(todo_wire(Some(&json!({
            "todos": [{ "id": 0, "text": "x", "status": "wat" }]
        })))
        .is_err());
        assert!(todo_wire(Some(&json!({ "todos": "nope" }))).is_err());
        // 条目 data 为 null（AppendEntry 缺 data）也是损坏
        assert!(todo_wire(Some(&Value::Null)).is_err());
    }

    #[test]
    fn mode_wire_defaults_to_off_without_entry() {
        let wire = mode_wire(None).expect("empty");
        assert!(wire["approvalMode"].is_null());
        assert_eq!(wire["planMode"], "off");
        assert!(wire["planPending"].is_null());
    }

    #[test]
    fn mode_wire_maps_plugin_active_flag() {
        let planning = mode_wire(Some(&json!({ "active": true, "plan": Value::Null })))
            .expect("planning");
        assert_eq!(planning["planMode"], "planning");
        // 插件 complete 后：active=false + plan 文本——没有审批态，仍是 off
        let done = mode_wire(Some(&json!({ "active": false, "plan": "# 计划" })))
            .expect("off");
        assert_eq!(done["planMode"], "off");
        assert!(done["planPending"].is_null());
    }

    #[test]
    fn mode_wire_rejects_corrupt_entry() {
        assert!(mode_wire(Some(&json!({ "active": "yes" }))).is_err());
        assert!(mode_wire(Some(&json!({ "plan": "x" }))).is_err());
        assert!(mode_wire(Some(&json!({ "active": false, "plan": 1 }))).is_err());
        assert!(mode_wire(Some(&Value::Null)).is_err());
    }

    #[test]
    fn background_tasks_wire_without_entry_is_empty_list() {
        assert_eq!(
            background_tasks_wire(None).expect("empty"),
            json!([]),
        );
    }

    #[test]
    fn background_tasks_wire_projects_real_fields_only() {
        // 插件 `Job::snapshot` 的真实形状（running 无 exitCode/finishedAt，
        // 未启用 process feature 时也没有 pid——缺失字段必须留 null，不能补 0）。
        let wire = background_tasks_wire(Some(&json!({
            "jobs": [
                { "id": "7", "kind": "bash", "label": "dev", "command": "npm run dev",
                  "status": "running", "pid": 1234, "startedAt": 1_700_000_000_000u64 },
                { "id": "8", "kind": "bash", "label": "build", "command": "cargo build",
                  "status": "completed", "exitCode": 0,
                  "startedAt": 1_700_000_000_000u64, "finishedAt": 1_700_000_005_000u64 },
            ]
        })))
        .expect("wire");
        let rows = wire.as_array().expect("array");
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0]["schema"], "rpi.background-tasks.v1");
        assert_eq!(rows[0]["id"], "7");
        assert_eq!(rows[0]["status"], "running");
        assert_eq!(rows[0]["label"], "dev");
        assert_eq!(rows[0]["command"], "npm run dev");
        assert_eq!(rows[0]["startedAtMs"], 1_700_000_000_000f64);
        assert!(rows[0]["finishedAtMs"].is_null());
        assert!(rows[0]["exitCode"].is_null());
        assert_eq!(rows[1]["status"], "completed");
        assert_eq!(rows[1]["exitCode"], 0);
        assert_eq!(rows[1]["finishedAtMs"], 1_700_000_005_000f64);
    }

    #[test]
    fn background_tasks_wire_rejects_corrupt_rows() {
        assert!(background_tasks_wire(Some(&json!({ "jobs": "nope" }))).is_err());
        assert!(background_tasks_wire(Some(&json!({ "bogus": [] }))).is_err());
        assert!(background_tasks_wire(Some(&json!({ "jobs": [{ "id": "1" }] }))).is_err());
        assert!(background_tasks_wire(Some(&json!({
            "jobs": [{ "id": "1", "status": "exploded" }]
        })))
        .is_err());
        assert!(background_tasks_wire(Some(&Value::Null)).is_err());
    }

    fn goal_state(title: &str, started_at: i64) -> Value {
        json!({
            "active": { "title": title, "status": "active", "startedAt": started_at },
            "archived": []
        })
    }

    fn iteration_entry(title: &str, started_at: i64, iteration: u64) -> Value {
        json!({
            "goalTitle": title,
            "goalStartedAt": started_at,
            "iteration": iteration,
            "updatedAt": 9,
            "items": [ { "id": "t1", "content": "读仓库", "status": "completed" } ]
        })
    }

    fn verification_entry(title: &str, started_at: i64, iteration: u64) -> Value {
        json!({
            "goalTitle": title,
            "goalStartedAt": started_at,
            "iteration": iteration,
            "outcome": "pass",
            "reason": "done",
            "nextAction": Value::Null,
            "at": 9
        })
    }

    #[test]
    fn merge_goal_timeline_attaches_matching_rows_in_order() {
        let mut state = goal_state("修面板", 1_000);
        merge_goal_timeline(
            &mut state,
            &[iteration_entry("修面板", 1_000, 2), iteration_entry("修面板", 1_000, 1)],
            &[verification_entry("修面板", 1_000, 1)],
        )
        .expect("merge");
        let rows = state["active"]["iterations"].as_array().expect("iterations");
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0]["iteration"], 1, "按 iteration 升序");
        assert_eq!(rows[0]["items"][0]["status"], "completed");
        let verdicts = state["active"]["verifications"].as_array().expect("verifications");
        assert_eq!(verdicts.len(), 1);
        assert_eq!(verdicts[0]["outcome"], "pass");
    }

    #[test]
    fn merge_goal_timeline_skips_stale_goal_rows() {
        // 上一个目标的残留条目：标题/起始时间对不上 → 不并入。
        let mut state = goal_state("新目标", 2_000);
        merge_goal_timeline(
            &mut state,
            &[iteration_entry("旧目标", 1_000, 1)],
            &[verification_entry("旧目标", 1_000, 1)],
        )
        .expect("merge");
        assert_eq!(state["active"]["iterations"].as_array().expect("rows").len(), 0);
        assert_eq!(state["active"]["verifications"].as_array().expect("rows").len(), 0);
        // 同标题但重新开始（startedAt 变了）同样不并入。
        let mut state = goal_state("同名", 3_000);
        merge_goal_timeline(&mut state, &[iteration_entry("同名", 2_000, 1)], &[]).expect("merge");
        assert_eq!(state["active"]["iterations"].as_array().expect("rows").len(), 0);
    }

    #[test]
    fn merge_goal_timeline_is_noop_without_goal() {
        let mut null_state = Value::Null;
        merge_goal_timeline(&mut null_state, &[iteration_entry("t", 1, 1)], &[]).expect("noop");
        assert!(null_state.is_null());

        let mut archived = json!({ "active": Value::Null, "archived": [] });
        merge_goal_timeline(&mut archived, &[iteration_entry("t", 1, 1)], &[]).expect("noop");
        assert!(archived["active"].is_null());

        let mut state = goal_state("t", 1);
        merge_goal_timeline(&mut state, &[], &[]).expect("noop");
        assert_eq!(state["active"]["iterations"].as_array().expect("rows").len(), 0);
    }

    #[test]
    fn merge_goal_timeline_rejects_corrupt_entries() {
        let mut state = goal_state("t", 1);
        assert!(merge_goal_timeline(&mut state, &[json!(42)], &[]).is_err());
        assert!(merge_goal_timeline(&mut state, &[json!({ "goalTitle": "t" })], &[]).is_err());
        assert!(
            merge_goal_timeline(
                &mut state,
                &[json!({ "goalTitle": "t", "goalStartedAt": 1, "iteration": 0 })]
            ,&[])
            .is_err()
        );
    }
}

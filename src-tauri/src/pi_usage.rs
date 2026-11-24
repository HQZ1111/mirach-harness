//! 使用统计（设置页「用量」/ 语音 `get_session_usage`）：rpi 会话 JSONL 的真实聚合。
//!
//! ## 实证来源（2026-11-14 核实，全部上游源码 + 本机真实会话文件）
//!
//! - rpi **没有**旧 pi `pi::stats` 的跨会话聚合面：`rpi-harness` 的
//!   `SessionStats`（`crates/rpi-harness/src/session/types.rs:1450`）只有
//!   `message_count / cached_tokens / uncached_tokens / total_tokens /
//!   cost_total`，是 **`AgentHarness::get_stats()` 的单会话**统计，没有
//!   按天 / 按 provider·model / 工具调用维度。
//! - 跨会话聚合的真相在落盘 JSONL 里：
//!   `<workspace>/.rpi/sessions/<cwd-encoded>/<ts>_<id>.jsonl`
//!   （`rpi-cli/src/session.rs:371 default_session_dir` =
//!   `<cwd>/.rpi/sessions`，`RPI_CODING_AGENT_SESSION_DIR` 可覆盖；
//!   mirach 的 workspace 固定为 `$USERPROFILE`，见
//!   `pi_session.rs:144 default_workspace`）。
//!   本机实读 `C:\Users\Administrator\.rpi\sessions\--C--Users-Administrator--\
//!   2026-11-14T13-28-34-759Z_01a1da3e-....jsonl`：每条 assistant entry 都带
//!   ```json
//!   {"kind":"entry","type":"message","id":"…","timestamp":1794662919488,
//!    "message":{"role":"assistant","provider":"DS",
//!      "model":"deepseek-v4.1-flash-1017",
//!      "usage":{"input":20231,"output":25,"cacheRead":256,"cacheWrite":0,
//!               "totalTokens":20512,
//!               "cost":{"input":0,"output":0,"cacheRead":0,
//!                       "cacheWrite":0,"total":0}}}}
//!   ```
//!   工具调用 = 同形状的 `role:"toolResult"` entry（`toolName` / `isError`，
//!   `crates/rpi-ai/src/types.rs:649 ToolResultMessage`）。
//!
//! 所以本模块直接扫 JSONL 聚合，**等价旧 `pi::stats::aggregate` 的跨会话面**
//! （旧实现存档 `git show df701a4:src-tauri/src/pi_usage.rs`），全部本地、
//! 无网络。语义边界：
//!
//! - session 目录不存在 = 还没聊过（空快照，不是错误；与
//!   `pi_list_sessions` 同语义）。
//! - 文件**打开/读取失败 = Err**（如实传播，不静默跳过整个会话）。
//! - append-only 日志的**半行尾**（进程被杀时的合法残尾）与非法 usage
//!   （负数 token 等）按"该行不可解析"跳过——不是兜底，是日志容错；
//!   缺 timestamp 的 entry 无法归日，同样跳过（rpi 类型要求 timestamp）。
//! - 同一 entry id 在单文件内只计一次（重放/重写残影不重复计费）。
//! - **范围**：只扫 `<workspace>/.rpi/sessions`（旧实现同样是单一
//!   `global_dir/sessions` 树）。定时任务会话另存
//!   `<agent_dir>/cron/sessions`（`pi_cron.rs`），不在本树内——旧 pi stats
//!   也未计入，保持同语义（不是静默遗漏，是明确的统计范围）。
//!
//! ## wire 形状
//!
//! 对齐旧实现（`AppUsageSnapshot` 子集）：`range/generatedAt/source/summary/
//! heatmap/models/daily/costUsd`。`summary` 里实际用到的字段全部按真实数据
//! 计算；不可得字段保持 `null`（不是 0，"没有数据"≠"0 错误"）：
//! `avgTimeToFirstTokenMs` / `avgTurnDurationMs` / `modelErrorRate`（rpi 不记
//! 这两类耗时）。`toolErrorRate` 可得（toolResult.isError），没有 toolResult
//! 时为 `null`；`longestSessionMs` = 单会话首末消息时间差的最大值。
//! `daily[].models` 给出当天各模型的 token（模型折线图的真实数据）。
//!
//! `costUsd` 只累加**引擎记录的成本**（`usage.cost.total`），不做静态价目表
//! 回填：免费模型真实成本就是 0，用价目表估算会把"未计费"变成"假装有成本"
//! （旧 pi stats 的 price_fallback 已弃用）。

use std::collections::{BTreeMap, HashSet};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::pi_session::on_big_stack;

const DAY_MS: i64 = 86_400_000;
/// 热力图固定 52 周（旧实现 / ZCode `HEATMAP_DISPLAY_WEEK_COUNT` 同值）。
const HEATMAP_WEEKS: usize = 52;

/// App Usage 快照。`range` = all / 7d / 30d（旧实现同集合）。
#[tauri::command(rename_all = "camelCase", async)]
pub fn pi_usage_snapshot(range: String) -> Result<Value, String> {
    on_big_stack(move || build_snapshot(&range))?
}

// ── 路径 ────────────────────────────────────────────────────────────────────

/// 与 `pi_session::default_workspace` 同义（那边是私有 fn，无法跨模块调用）。
fn workspace_root() -> PathBuf {
    std::env::var("USERPROFILE")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
}

/// rpi 会话根 = `default_session_dir(workspace)`：环境变量优先，否则
/// `<workspace>/.rpi/sessions`（`rpi-cli/src/session.rs:371` 逐行同义）。
fn sessions_root() -> PathBuf {
    std::env::var("RPI_CODING_AGENT_SESSION_DIR")
        .ok()
        .map(PathBuf::from)
        .unwrap_or_else(|| workspace_root().join(".rpi").join("sessions"))
}

/// 会话正文文件：`*.jsonl`，排除旁路文件 `<session>.jsonl.lock` 与
/// `<session>.jsonl.progress.jsonl`（progress 是 UI 帧状态，无 usage）。
fn is_session_jsonl(path: &Path) -> bool {
    if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
        return false;
    }
    match path.file_name().and_then(|n| n.to_str()) {
        Some(name) => !name.ends_with(".progress.jsonl") && !name.ends_with(".lock"),
        None => false,
    }
}

/// 扫描会话根：一层 project 目录（cwd 编码目录）+ 根下直属 jsonl（兼容）。
/// 目录不存在 = 空集合（还没聊过）；其它 IO 错误传播。
fn collect_session_files(root: &Path) -> Result<Vec<PathBuf>, String> {
    let mut out = Vec::new();
    let entries = match std::fs::read_dir(root) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(out),
        Err(e) => {
            return Err(format!("会话目录读取失败 {}: {e}", root.display()))
        }
    };
    for entry in entries {
        let entry = entry.map_err(|e| format!("会话目录读取失败 {}: {e}", root.display()))?;
        let path = entry.path();
        if path.is_dir() {
            let files = std::fs::read_dir(&path)
                .map_err(|e| format!("会话子目录读取失败 {}: {e}", path.display()))?;
            for file in files {
                let file =
                    file.map_err(|e| format!("会话子目录读取失败 {}: {e}", path.display()))?;
                let path = file.path();
                if path.is_file() && is_session_jsonl(&path) {
                    out.push(path);
                }
            }
        } else if path.is_file() && is_session_jsonl(&path) {
            out.push(path);
        }
    }
    out.sort();
    Ok(out)
}

// ── 日期（UTC；Howard Hinnant days_from_civil，无依赖）─────────────────────

/// 毫秒时间戳 → UTC 日序（1970-01-01 = 0）。
fn day_index_from_millis(ms: i64) -> i64 {
    // div_euclid：负时间戳（1970 前，理论值）也落到正确日序
    ms.div_euclid(DAY_MS)
}

/// "YYYY-MM-DD" → 日序（旧实现同款；只取前 10 字符）。
fn date_key_to_day_index(date: &str) -> Option<i64> {
    let key = date.get(..10)?;
    let mut parts = key.split('-');
    let y: i32 = parts.next()?.parse().ok()?;
    let m: u32 = parts.next()?.parse().ok()?;
    let d: u32 = parts.next()?.parse().ok()?;
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = if m > 2 { m - 3 } else { m + 9 } as i64;
    let doy = (153 * mp + 2) / 5 + d as i64 - 1;
    let doe = yoe as i64 * 365 + yoe as i64 / 4 - yoe as i64 / 100 + doy;
    Some(era as i64 * 146_097 + doe - 719_468)
}

/// 日序 → "YYYY-MM-DD"（`days_from_civil` 的逆运算）。
fn day_index_to_date_key(index: i64) -> String {
    let z = index + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}")
}

/// 0 = 周日（旧实现 / ZCode `getUtcWeekday` 同义）。
fn utc_weekday(day_index: i64) -> i64 {
    // 1970-01-01 是周四（4）
    (day_index + 4).rem_euclid(7)
}

/// 热力图等级 0..4（旧实现 / `levelForValue` 同义）。
fn level_for(value: u64, max: u64) -> u8 {
    if value == 0 || max == 0 {
        return 0;
    }
    let level = (value as f64 / max as f64 * 4.0).ceil() as u64;
    level.clamp(1, 4) as u8
}

/// 连续天数（`days` 为 "YYYY-MM-DD"；`today` 是 UTC 日序，便于测试）。
fn streaks(days: &[String], today: i64) -> (u64, u64) {
    let mut indices: Vec<i64> = days
        .iter()
        .filter_map(|d| date_key_to_day_index(d))
        .collect();
    indices.sort_unstable();
    indices.dedup();
    if indices.is_empty() {
        return (0, 0);
    }
    let mut longest = 1u64;
    let mut run = 1u64;
    for pair in indices.windows(2) {
        if pair[1] == pair[0] + 1 {
            run += 1;
            longest = longest.max(run);
        } else {
            run = 1;
        }
    }
    // current = 从最后一个活跃日往回数的连续段；只有落在今天/昨天才算"当前"
    let last = *indices.last().expect("indices non-empty");
    let mut current = 1u64;
    for pair in indices.windows(2).rev() {
        if pair[1] == pair[0] + 1 {
            current += 1;
        } else {
            break;
        }
    }
    let current = if today - last <= 1 { current } else { 0 };
    (current, longest)
}

// ── 聚合 ────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct TokenTotals {
    input: u64,
    output: u64,
    cache_read: u64,
    cache_write: u64,
    total: u64,
}

#[derive(Debug, Default)]
struct DayTotals {
    tokens: u64,
    turns: u64,
    tool_calls: u64,
}

#[derive(Debug, Default)]
struct Aggregate {
    sessions: u64,
    turns: u64,
    tokens: TokenTotals,
    cost: f64,
    tool_calls: u64,
    tool_results: u64,
    tool_errors: u64,
    by_model_messages: BTreeMap<(String, String), u64>,
    by_model_tokens: BTreeMap<(String, String), TokenTotals>,
    by_day: BTreeMap<String, DayTotals>,
    /// 每天每个模型的 token（modelId = "provider/model"）。
    by_day_model_tokens: BTreeMap<String, BTreeMap<String, u64>>,
    /// 单会话首末消息时间差的最大值（毫秒，0 = 无可用时间戳）。
    longest_session_ms: u64,
}

/// 会话 entry 行探针（只取聚合需要的字段；其它字段忽略）。
#[derive(serde::Deserialize)]
struct EntryProbe {
    #[serde(default)]
    kind: Option<String>,
    #[serde(default, rename = "type")]
    kind_type: Option<String>,
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    timestamp: Option<i64>,
    #[serde(default)]
    message: Option<MessageProbe>,
}

#[derive(serde::Deserialize, Default)]
struct MessageProbe {
    #[serde(default)]
    role: Option<String>,
    #[serde(default)]
    provider: Option<String>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    timestamp: Option<i64>,
    #[serde(default)]
    usage: Option<UsageProbe>,
    #[serde(default, rename = "toolName")]
    tool_name: Option<String>,
    #[serde(default, rename = "isError")]
    is_error: bool,
}

#[derive(serde::Deserialize, Default)]
struct UsageProbe {
    #[serde(default)]
    input: u64,
    #[serde(default)]
    output: u64,
    #[serde(default, rename = "cacheRead")]
    cache_read: u64,
    #[serde(default, rename = "cacheWrite")]
    cache_write: u64,
    #[serde(default, rename = "totalTokens")]
    total_tokens: u64,
    #[serde(default)]
    cost: Option<CostProbe>,
}

#[derive(serde::Deserialize, Default)]
struct CostProbe {
    #[serde(default)]
    total: f64,
}

/// 聚合一个会话文件。IO 失败传播；单行不可解析（含撕裂的 UTF-8 尾行）= 跳过
/// ——append-only 日志的合法残尾，不是兜底。
fn ingest_file(path: &Path, since_day: Option<i64>, agg: &mut Aggregate) -> Result<(), String> {
    let file = std::fs::File::open(path)
        .map_err(|e| format!("会话文件打开失败 {}: {e}", path.display()))?;
    let mut reader = BufReader::new(file);
    let mut seen_entry_ids: HashSet<String> = HashSet::new();
    let mut counted_session = false;
    let mut session_first_ts: Option<i64> = None;
    let mut session_last_ts: Option<i64> = None;
    let mut buf: Vec<u8> = Vec::new();
    loop {
        buf.clear();
        let read = reader
            .read_until(b'\n', &mut buf)
            .map_err(|e| format!("会话文件读取失败 {}: {e}", path.display()))?;
        if read == 0 {
            break;
        }
        // 撕裂尾行可能是非法 UTF-8（多字节字符被截断）——按不可解析跳过；
        // 真实 IO 错误已在上面传播，不在此吞掉。
        let Ok(line) = std::str::from_utf8(&buf) else {
            continue;
        };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(probe) = serde_json::from_str::<EntryProbe>(trimmed) else {
            continue; // 半行尾 / 非 entry 行
        };
        // rpi v4：kind="entry" + type="message"（比较 record/header 行）
        if probe.kind.as_deref() != Some("entry") || probe.kind_type.as_deref() != Some("message")
        {
            continue;
        }
        let Some(message) = probe.message.as_ref() else {
            continue;
        };
        let Some(ts_millis) = probe.timestamp.or(message.timestamp) else {
            continue; // 无时间戳无法归日（rpi 类型要求必填）
        };
        let day_index = day_index_from_millis(ts_millis);
        if since_day.is_some_and(|since| day_index < since) {
            continue;
        }
        let date_key = day_index_to_date_key(day_index);
        session_first_ts = Some(session_first_ts.map_or(ts_millis, |v| v.min(ts_millis)));
        session_last_ts = Some(session_last_ts.map_or(ts_millis, |v| v.max(ts_millis)));

        // 单文件内同 id 只计一次（重放/重写残影；entry id 全局唯一）
        if let Some(id) = probe.id.as_deref() {
            if !seen_entry_ids.insert(id.to_string()) {
                continue;
            }
        }

        match message.role.as_deref() {
            Some("toolResult") => {
                // 旧实现同义：有 toolName 才计一次
                if message.tool_name.is_some() {
                    agg.tool_calls += 1;
                    agg.tool_results += 1;
                    if message.is_error {
                        agg.tool_errors += 1;
                    }
                    agg.by_day.entry(date_key).or_default().tool_calls += 1;
                }
            }
            Some("assistant") => {
                if !counted_session {
                    agg.sessions += 1;
                    counted_session = true;
                }
                agg.turns += 1;
                let usage = message.usage.as_ref();
                let tokens = TokenTotals {
                    input: usage.map_or(0, |u| u.input),
                    output: usage.map_or(0, |u| u.output),
                    cache_read: usage.map_or(0, |u| u.cache_read),
                    cache_write: usage.map_or(0, |u| u.cache_write),
                    total: usage.map_or(0, |u| u.total_tokens),
                };
                // 只累加引擎记录值（不按静态价目表猜测）
                agg.cost += usage
                    .and_then(|u| u.cost.as_ref())
                    .map_or(0.0, |c| c.total);
                agg.tokens.input += tokens.input;
                agg.tokens.output += tokens.output;
                agg.tokens.cache_read += tokens.cache_read;
                agg.tokens.cache_write += tokens.cache_write;
                agg.tokens.total += tokens.total;

                let key = (
                    message.provider.clone().unwrap_or_else(|| "unknown".into()),
                    message.model.clone().unwrap_or_else(|| "unknown".into()),
                );
                *agg.by_model_messages.entry(key.clone()).or_insert(0) += 1;
                let model_id = format!("{}/{}", key.0, key.1);
                *agg
                    .by_day_model_tokens
                    .entry(date_key.clone())
                    .or_default()
                    .entry(model_id)
                    .or_insert(0) += tokens.total;
                let model_tokens = agg.by_model_tokens.entry(key).or_default();
                model_tokens.input += tokens.input;
                model_tokens.output += tokens.output;
                model_tokens.cache_read += tokens.cache_read;
                model_tokens.cache_write += tokens.cache_write;
                model_tokens.total += tokens.total;

                let day = agg.by_day.entry(date_key).or_default();
                day.tokens += tokens.total;
                day.turns += 1;
            }
            _ => {}
        }
    }
    if let (Some(first), Some(last)) = (session_first_ts, session_last_ts) {
        if last >= first {
            agg.longest_session_ms = agg
                .longest_session_ms
                .max(u64::try_from(last - first).unwrap_or(0));
        }
    }
    Ok(())
}

fn now_millis() -> Result<i64, String> {
    let elapsed = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| format!("系统时钟早于 Unix 纪元: {e}"))?;
    i64::try_from(elapsed.as_millis()).map_err(|e| format!("时间戳超出 i64: {e}"))
}

/// 构建 App Usage 快照（真实聚合；不可得字段为 null）。
fn build_snapshot(range: &str) -> Result<Value, String> {
    let now = now_millis()?;
    let today = day_index_from_millis(now);
    let since_day = match range {
        "all" => None,
        "7d" => Some(today - 6),
        "30d" => Some(today - 29),
        other => {
            return Err(format!(
                "未知的用量区间：{other}（可选 all / 7d / 30d）"
            ))
        }
    };

    let root = sessions_root();
    let files = collect_session_files(&root)?;
    let mut agg = Aggregate::default();
    for file in &files {
        ingest_file(file, since_day, &mut agg)?;
    }

    let day_keys: Vec<String> = agg.by_day.keys().cloned().collect();
    let (current_streak, longest_streak) = streaks(&day_keys, today);
    let peak_day_tokens = agg.by_day.values().map(|d| d.tokens).max().unwrap_or(0);

    // 收藏模型 = 总 token 最大的 (provider, model)
    let favorite = agg
        .by_model_tokens
        .iter()
        .max_by_key(|(_, tokens)| tokens.total)
        .map(|((provider, model), tokens)| {
            json!({
                "modelId": format!("{provider}/{model}"),
                "totalTokens": tokens.total,
                "share": if agg.tokens.total == 0 {
                    0.0
                } else {
                    tokens.total as f64 / agg.tokens.total as f64
                },
            })
        });

    // 缓存命中率 = cacheRead / (cacheRead + cacheWrite)（旧实现同公式；
    // 引擎只给两个计数、不给比率）
    let cache_total = agg.tokens.cache_read + agg.tokens.cache_write;
    let cache_hit_rate = if cache_total == 0 {
        0.0
    } else {
        agg.tokens.cache_read as f64 / cache_total as f64
    };

    // 热力图：52 个自然周（周日为首），锚点 = 数据最后一天（无数据 = 今天）
    let max_tokens = peak_day_tokens;
    let end_index = day_keys
        .iter()
        .filter_map(|d| date_key_to_day_index(d))
        .max()
        .unwrap_or(today);
    let end_week_start = end_index - utc_weekday(end_index);
    let start_index = end_week_start - (HEATMAP_WEEKS as i64 - 1) * 7;
    let weeks: Vec<Value> = (0..HEATMAP_WEEKS)
        .map(|week_index| {
            let days: Vec<Value> = (0..7)
                .map(|day_offset| {
                    let idx = start_index + week_index as i64 * 7 + day_offset;
                    let date = day_index_to_date_key(idx);
                    let day = agg.by_day.get(&date);
                    let tokens = day.map_or(0, |d| d.tokens);
                    let turns = day.map_or(0, |d| d.turns);
                    let tool_calls = day.map_or(0, |d| d.tool_calls);
                    json!({
                        "date": date,
                        "level": level_for(tokens, max_tokens),
                        "totalTokens": tokens,
                        "turnCount": turns,
                        "toolCallCount": tool_calls,
                    })
                })
                .collect();
            json!({ "weekIndex": week_index, "days": days })
        })
        .collect();

    let models: Vec<Value> = agg
        .by_model_messages
        .iter()
        .map(|((provider, model), request_count)| {
            let key = (provider.clone(), model.clone());
            let tokens = agg.by_model_tokens.get(&key).copied().unwrap_or_default();
            json!({
                "modelId": format!("{provider}/{model}"),
                "totalTokens": tokens.total,
                "inputTokens": tokens.input,
                "outputTokens": tokens.output,
                "requestCount": request_count,
            })
        })
        .collect();

    let daily: Vec<Value> = agg
        .by_day
        .iter()
        .map(|(date, day)| {
            let mut day_models: Vec<(&String, u64)> = agg
                .by_day_model_tokens
                .get(date)
                .map(|models| models.iter().map(|(id, tokens)| (id, *tokens)).collect())
                .unwrap_or_default();
            day_models.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(b.0)));
            json!({
                "date": date,
                "totalTokens": day.tokens,
                "turnCount": day.turns,
                "models": day_models
                    .iter()
                    .map(|(model_id, tokens)| json!({
                        "modelId": model_id,
                        "totalTokens": tokens,
                    }))
                    .collect::<Vec<Value>>(),
            })
        })
        .collect();

    // 工具错误率：有 toolResult 才可算；没有 = null（不是 0）
    let tool_error_rate = if agg.tool_results == 0 {
        Value::Null
    } else {
        json!(agg.tool_errors as f64 / agg.tool_results as f64)
    };

    Ok(json!({
        "range": range,
        "generatedAt": now,
        "source": "local",
        "summary": {
            "totalTokens": agg.tokens.total,
            "inputTokens": agg.tokens.input,
            "outputTokens": agg.tokens.output,
            "cacheReadTokens": agg.tokens.cache_read,
            "cacheCreationTokens": agg.tokens.cache_write,
            "cacheHitRate": cache_hit_rate,
            "totalSessions": agg.sessions,
            "totalTurns": agg.turns,
            "toolCallCount": agg.tool_calls,
            "activeDays": agg.by_day.len() as u64,
            "currentStreakDays": current_streak,
            "longestStreakDays": longest_streak,
            "peakDayTokens": peak_day_tokens,
            "favoriteModel": favorite,
            // 会话时长 = 该会话首末消息时间差（header/entry 时间戳，毫秒）
            "longestSessionMs": agg.longest_session_ms,
            // rpi 不记录：模型错误率（null = 不可得，UI 隐藏卡片）
            "avgTimeToFirstTokenMs": Value::Null,
            "avgTurnDurationMs": Value::Null,
            "toolErrorRate": tool_error_rate,
            "modelErrorRate": Value::Null,
        },
        "heatmap": {
            "maxTokens": max_tokens,
            "weeks": weeks,
        },
        "models": models,
        "daily": daily,
        "costUsd": agg.cost,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn day_index_roundtrips() {
        for key in ["1970-01-01", "2026-10-26", "2000-02-29", "1999-12-31"] {
            let idx = date_key_to_day_index(key).expect("valid date");
            assert_eq!(day_index_to_date_key(idx), key);
        }
    }

    #[test]
    fn epoch_is_thursday() {
        assert_eq!(utc_weekday(0), 4);
    }

    #[test]
    fn millis_maps_to_utc_day() {
        // 2026-11-14T13:28:34.759Z → 当天日序
        let idx = day_index_from_millis(1_794_662_914_759);
        assert_eq!(day_index_to_date_key(idx), "2026-11-14");
    }

    #[test]
    fn level_maps_to_four_buckets() {
        assert_eq!(level_for(0, 100), 0);
        assert_eq!(level_for(1, 100), 1);
        assert_eq!(level_for(25, 100), 1);
        assert_eq!(level_for(26, 100), 2);
        assert_eq!(level_for(100, 100), 4);
        assert_eq!(level_for(5, 0), 0);
    }

    #[test]
    fn streaks_counts_consecutive_days() {
        let days = vec![
            "2026-10-01".to_string(),
            "2026-10-02".to_string(),
            "2026-10-03".to_string(),
            "2026-10-10".to_string(),
        ];
        let today = date_key_to_day_index("2026-10-10").expect("today");
        let (current, longest) = streaks(&days, today);
        assert_eq!(longest, 3);
        assert_eq!(current, 1);
    }

    #[test]
    fn unknown_range_is_an_error() {
        assert!(build_snapshot("90d").is_err());
    }

    #[test]
    fn session_jsonl_filter_excludes_sidecars() {
        assert!(is_session_jsonl(Path::new(
            "2026-11-14T13-28-34-759Z_01a1.jsonl"
        )));
        assert!(!is_session_jsonl(Path::new(
            "2026-11-14T13-28-34-759Z_01a1.jsonl.progress.jsonl"
        )));
        assert!(!is_session_jsonl(Path::new(
            "2026-11-14T13-28-34-759Z_01a1.jsonl.lock"
        )));
        assert!(!is_session_jsonl(Path::new("header.txt")));
    }

    /// 真实 rpi v4 行形状（取自本机会话文件）→ 聚合读数逐项核对。
    #[test]
    fn aggregates_real_session_shape() {
        let dir = std::env::temp_dir().join(format!(
            "mirach-usage-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let file = dir.join("session.jsonl");
        let body = concat!(
            r#"{"kind":"header","version":4,"id":"s1","createdAt":1794662914759,"cwd":"C:\\x"}"#,
            "\n",
            r#"{"kind":"record","type":"operation_started","id":"r1","seq":1,"timestamp":1794662914793}"#,
            "\n",
            r#"{"kind":"entry","type":"message","id":"m1","seq":2,"timestamp":1794662914793,"message":{"kind":"user","role":"user","content":"hi","timestamp":1794662914792}}"#,
            "\n",
            r#"{"kind":"entry","type":"message","id":"a1","seq":3,"timestamp":1794662919488,"message":{"kind":"assistant","role":"assistant","content":[{"type":"text","text":"hi"}],"provider":"DS","model":"m-a","usage":{"input":20231,"output":25,"cacheRead":256,"cacheWrite":0,"totalTokens":20512,"cost":{"input":0.0,"output":0.0,"cacheRead":0.0,"cacheWrite":0.0,"total":0.0}},"timestamp":1794662914813}}"#,
            "\n",
            r#"{"kind":"entry","type":"message","id":"t1","seq":4,"timestamp":1794662919488,"message":{"role":"toolResult","toolCallId":"c1","toolName":"read","content":[],"isError":true,"timestamp":1794662919488}}"#,
            "\n",
            r#"{"kind":"entry","type":"message","id":"a2","seq":5,"timestamp":1794663000000,"message":{"role":"assistant","content":[{"type":"text","text":"again"}],"provider":"DS","model":"m-b","usage":{"input":41,"output":42,"cacheRead":20480,"cacheWrite":0,"totalTokens":20563,"cost":{"input":0.0,"output":0.0,"cacheRead":0.0,"cacheWrite":0.0,"total":1.5}},"timestamp":1794663000000}}"#,
            "\n",
            r#"{"kind":"entry","type":"message","id":"a2","seq":6,"timestamp":1794663000000,"message":{"role":"assistant","content":[],"provider":"DS","model":"m-b","usage":{"input":41,"output":42,"cacheRead":20480,"cacheWrite":0,"totalTokens":20563,"cost":{"total":1.5}},"timestamp":1794663000000}}"#,
            "\n",
            "{not json}\n"
        );
        std::fs::write(&file, body).expect("write session");

        let mut agg = Aggregate::default();
        // since_day = None（all）
        ingest_file(&file, None, &mut agg).expect("ingest");

        assert_eq!(agg.sessions, 1, "一个文件计一个会话");
        assert_eq!(agg.turns, 2, "assistant 数；同 id 重放行不计");
        assert_eq!(agg.tokens.input, 20_272);
        assert_eq!(agg.tokens.output, 67);
        assert_eq!(agg.tokens.cache_read, 20_736);
        assert_eq!(agg.tokens.total, 41_075);
        assert_eq!(agg.cost, 1.5);
        assert_eq!(agg.tool_calls, 1);
        assert_eq!(agg.tool_results, 1);
        assert_eq!(agg.tool_errors, 1);
        assert_eq!(agg.by_model_messages.len(), 2);
        assert_eq!(
            agg.by_model_messages
                .get(&("DS".to_string(), "m-a".to_string()))
                .copied(),
            Some(1)
        );
        let day = agg
            .by_day
            .get("2026-11-14")
            .expect("UTC day key from millis");
        assert_eq!(day.turns, 2);
        assert_eq!(day.tokens, 41_075);
        assert_eq!(day.tool_calls, 1);
        let day_models = agg
            .by_day_model_tokens
            .get("2026-11-14")
            .expect("按天模型用量");
        assert_eq!(day_models.get("DS/m-a"), Some(&20_512));
        assert_eq!(day_models.get("DS/m-b"), Some(&20_563));
        assert_eq!(agg.longest_session_ms, 85_207, "首末消息时间差");

        // 7d 过滤：把 since 调到数据次日 → 全部丢弃
        let mut empty = Aggregate::default();
        ingest_file(
            &file,
            date_key_to_day_index("2026-11-15"),
            &mut empty,
        )
        .expect("ingest filtered");
        assert_eq!(empty.turns, 0);
        assert_eq!(empty.sessions, 0);

        std::fs::remove_dir_all(&dir).expect("cleanup");
    }
}

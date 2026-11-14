//! 用量统计 IPC —— ZCode「设置 → 用量」的宿主移植（2026-10-26 用户：
//! "用量移植 zcode 里设置页的用量"）。
//!
//! ## 上游形状（ZCode `packages/ui/src/settings/usage-stats/`）
//!
//! ZCode 的用量页有两个 tab：
//!
//! | tab | 数据来源 | 宿主能否移植 |
//! |---|---|---|
//! | Coding Plan（`CodingPlanUsagePanel`） | 云端 monitor API（BigModel / Z.AI 的订阅额度、重置时间、权益） | **不能**：本宿主没有订阅账户，也没有那个 monitor 端点。造假数据 = 违反规矩 12 |
//! | App Usage（`AppUsagePanel`） | **本地 session 聚合**（`source: "local"`） | **能**：pi 的 `stats::aggregate` 就是同一层数据（tokens/cost/按天/按模型/工具调用） |
//!
//! 所以本模块只做 App Usage，并把"为什么没有 Coding Plan"写进 UI（不是
//! 留白、不是渲染 0）。
//!
//! ## 数据面映射（ZCode 字段 → pi stats）
//!
//! | ZCode `AppUsageSnapshot` | 宿主来源 |
//! |---|---|
//! | `summary.totalTokens` / `inputTokens` / `outputTokens` | `StatsReport.tokens.*` |
//! | `summary.cacheReadTokens` / `cacheCreationTokens` | `StatsReport.tokens.cache_read` / `cache_write` |
//! | `summary.cacheHitRate` | 由上面两值算（pi 不直接给） |
//! | `summary.totalSessions` | `StatsReport.sessions` |
//! | `summary.totalTurns` | `StatsReport.messages` |
//! | `summary.toolCallCount` | `StatsReport.tool_calls_total` |
//! | `summary.activeDays` / `currentStreakDays` / `longestStreakDays` / `peakDayTokens` | 由 `by_day` 算 |
//! | `summary.favoriteModel` | `by_provider_model` 的最大项 |
//! | `heatmap.weeks` | 由 `by_day` 按自然周补齐（52 周，周日为首） |
//! | `daily[].models[]` | **不可得**：pi 的 `by_day` 不带 model 维度 |
//! | `summary.avgTimeToFirstTokenMs` / `avgTurnDurationMs` | **不可得**：pi stats 不记时延 |
//! | `summary.toolErrorRate` / `modelErrorRate` | **不可得**：pi stats 不记错误 |
//!
//! 不可得的字段**返回 null**（不是 0）——UI 据此隐藏对应卡片，而不是显示
//! "0%" 让人以为"没有错误"。
//!
//! ## 纪律
//!
//! - 全部本地、无网络（pi 的 stats 模块本身有这个不变量）。
//! - 读不到会话目录 = 空快照（真实状态：还没聊过），不是错误。
//! - 单文件解析失败 = pi 的 `aggregate` 内部跳过坏行（append-only 日志的
//!   合法尾部形态），不因此整体失败。

use std::collections::BTreeMap;
use std::path::PathBuf;

use pi::stats::{collect_session_files, StatsFilter};

use crate::pi_session::on_big_stack;

const DAY_MS: i64 = 86_400_000;
/// 热力图固定展示 52 周（ZCode `HEATMAP_DISPLAY_WEEK_COUNT`）。
const HEATMAP_WEEKS: usize = 52;

/// pi 会话目录（`<global_dir>/sessions`）。
fn sessions_dir() -> PathBuf {
    pi::config::Config::global_dir().join("sessions")
}

/// 把 "YYYY-MM-DD" 转成 UTC 日序号（用于算 streak / 补周）。
fn date_key_to_day_index(date: &str) -> Option<i64> {
    // 只取日期前缀，避免带时间的键算错
    let key = date.get(..10)?;
    let mut parts = key.split('-');
    let y: i32 = parts.next()?.parse().ok()?;
    let m: u32 = parts.next()?.parse().ok()?;
    let d: u32 = parts.next()?.parse().ok()?;
    // 公历 → 日序号（Howard Hinnant 的 days_from_civil，无依赖）
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = if m > 2 { m - 3 } else { m + 9 } as i64;
    let doy = (153 * mp + 2) / 5 + d as i64 - 1;
    let doe = yoe as i64 * 365 + yoe as i64 / 4 - yoe as i64 / 100 + doy;
    Some(era as i64 * 146_097 + doe - 719_468)
}

fn day_index_to_date_key(index: i64) -> String {
    // 逆运算（days_from_civil 的逆）
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

/// 0 = 周日（与 ZCode 的 `getUtcWeekday` 一致）。
fn utc_weekday(day_index: i64) -> i64 {
    // 1970-01-01 是周四（=4）
    (day_index + 4).rem_euclid(7)
}

/// 热力图等级（ZCode `levelForValue`：1..4 按 max 等分，0 表示无用量）。
fn level_for(value: u64, max: u64) -> u8 {
    if value == 0 || max == 0 {
        return 0;
    }
    let level = (value as f64 / max as f64 * 4.0).ceil() as u64;
    level.clamp(1, 4) as u8
}

/// 连续天数（ZCode 的 currentStreakDays / longestStreakDays 语义）。
fn streaks(days: &[String]) -> (u64, u64) {
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
    // current = 从最后一个活跃日往回数的连续段；只有它落在今天/昨天才算"当前"
    let last = *indices.last().unwrap();
    let today = (std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0))
        / DAY_MS;
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

/// 构建 App Usage 快照。
///
/// `range`：`"all"` / `"7d"` / `"30d"`（与 ZCode `APP_USAGE_RANGES` 同值）。
fn build_snapshot(range: &str) -> Result<serde_json::Value, String> {
    let since = match range {
        "all" => None,
        "7d" => Some(7),
        "30d" => Some(30),
        other => return Err(format!("未知的用量区间：{other}（可选 all / 7d / 30d）")),
    };

    let files = collect_session_files(&sessions_dir(), None);
    // 会话目录不存在 = 还没聊过（真实状态，空快照不是错误）
    let filter = StatsFilter {
        since: since.map(|days| {
            let today = (std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0))
                / DAY_MS;
            day_index_to_date_key(today - (days - 1))
        }),
        ..StatsFilter::default()
    };
    let report = pi::stats::aggregate(&files, &filter);

    // 按天（pi 的 by_day 是 UTC 日前缀；排序后用于 streak 与热力图）
    let mut by_day: BTreeMap<String, (u64, u64)> = BTreeMap::new();
    for row in &report.by_day {
        by_day.insert(row.day.clone(), (row.tokens.total, row.messages));
    }
    let day_keys: Vec<String> = by_day.keys().cloned().collect();
    let (current_streak, longest_streak) = streaks(&day_keys);
    let peak_day_tokens = by_day.values().map(|(t, _)| *t).max().unwrap_or(0);

    // 收藏模型（by_provider_model 的最大 token 项）
    let favorite = report
        .by_provider_model
        .iter()
        .max_by_key(|row| row.tokens.total)
        .map(|row| {
            serde_json::json!({
                "modelId": format!("{}/{}", row.provider, row.model),
                "totalTokens": row.tokens.total,
                "share": if report.tokens.total == 0 {
                    0.0
                } else {
                    row.tokens.total as f64 / report.tokens.total as f64
                },
            })
        });

    // 缓存命中率（pi 给 cache_read / cache_write，不给比率）
    let cache_total = report.tokens.cache_read + report.tokens.cache_write;
    let cache_hit_rate = if cache_total == 0 {
        0.0
    } else {
        report.tokens.cache_read as f64 / cache_total as f64
    };

    // 热力图：52 个自然周，周日为首，缺的补 0 格（ZCode buildDisplayHeatmapWeeks 同语义）
    let max_tokens = peak_day_tokens;
    let end_index = day_keys
        .iter()
        .filter_map(|d| date_key_to_day_index(d))
        .max()
        .unwrap_or_else(|| {
            (std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0))
                / DAY_MS
        });
    let end_week_start = end_index - utc_weekday(end_index);
    let start_index = end_week_start - (HEATMAP_WEEKS as i64 - 1) * 7;
    let weeks: Vec<serde_json::Value> = (0..HEATMAP_WEEKS)
        .map(|week_index| {
            let days: Vec<serde_json::Value> = (0..7)
                .map(|day_offset| {
                    let idx = start_index + week_index as i64 * 7 + day_offset;
                    let date = day_index_to_date_key(idx);
                    let (tokens, turns) = by_day.get(&date).copied().unwrap_or((0, 0));
                    serde_json::json!({
                        "date": date,
                        "level": level_for(tokens, max_tokens),
                        "totalTokens": tokens,
                        "turnCount": turns,
                        "toolCallCount": 0, // pi 的 by_day 不带工具维度
                    })
                })
                .collect();
            serde_json::json!({ "weekIndex": week_index, "days": days })
        })
        .collect();

    Ok(serde_json::json!({
        "range": range,
        "generatedAt": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0),
        "source": "local",
        "summary": {
            "totalTokens": report.tokens.total,
            "inputTokens": report.tokens.input,
            "outputTokens": report.tokens.output,
            "cacheReadTokens": report.tokens.cache_read,
            "cacheCreationTokens": report.tokens.cache_write,
            "cacheHitRate": cache_hit_rate,
            "totalSessions": report.sessions,
            "totalTurns": report.messages,
            "toolCallCount": report.tool_calls_total,
            "activeDays": by_day.len() as u64,
            "currentStreakDays": current_streak,
            "longestStreakDays": longest_streak,
            "peakDayTokens": peak_day_tokens,
            "favoriteModel": favorite,
            // 以下三项 pi stats 不记录 —— 返回 null（不是 0），UI 隐藏卡片
            "avgTimeToFirstTokenMs": serde_json::Value::Null,
            "avgTurnDurationMs": serde_json::Value::Null,
            "toolErrorRate": serde_json::Value::Null,
            "modelErrorRate": serde_json::Value::Null,
        },
        "heatmap": {
            "maxTokens": max_tokens,
            "weeks": weeks,
        },
        "models": report.by_provider_model.iter().map(|row| {
            serde_json::json!({
                "modelId": format!("{}/{}", row.provider, row.model),
                "totalTokens": row.tokens.total,
                "inputTokens": row.tokens.input,
                "outputTokens": row.tokens.output,
                "requestCount": row.messages,
            })
        }).collect::<Vec<_>>(),
        "daily": report.by_day.iter().map(|row| {
            serde_json::json!({
                "date": row.day,
                "totalTokens": row.tokens.total,
                "turnCount": row.messages,
            })
        }).collect::<Vec<_>>(),
        "costUsd": report.cost.total,
    }))
}

/// App Usage 快照（本地 session 聚合）。`range` = all / 7d / 30d。
#[tauri::command(rename_all = "camelCase", async)]
pub fn pi_usage_snapshot(range: String) -> Result<serde_json::Value, String> {
    on_big_stack(move || build_snapshot(&range))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn day_index_roundtrips() {
        for key in ["1970-01-01", "2026-10-26", "2000-02-29", "1999-12-31"] {
            let idx = date_key_to_day_index(key).unwrap();
            assert_eq!(day_index_to_date_key(idx), key);
        }
    }

    #[test]
    fn epoch_is_thursday() {
        // 1970-01-01 是周四
        assert_eq!(utc_weekday(0), 4);
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
        let (_current, longest) = streaks(&days);
        assert_eq!(longest, 3);
    }

    #[test]
    fn unknown_range_is_an_error() {
        assert!(build_snapshot("90d").is_err());
    }
}

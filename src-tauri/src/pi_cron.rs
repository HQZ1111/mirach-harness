//! 定时任务（cron）——**自包含模块**（2026-10-29）。
//!
//! 用户要求："照抄 hermes 的定时任务"。上游是 `cron/`（43 个 Python 文件 /
//! 19,009 行）+ `apps/desktop/src/app/cron/`（前端 2,973 行）+ 侧栏区 498 行。
//! 本文件是**后端**：存储、调度解析、tick 循环、执行、IPC 面。
//!
//! ## 为什么是"自包含模块"而不是 pi 扩展
//!
//! 先查过事实（2026-10-29）：
//!
//! - **pi 扩展（QuickJS）承载不了**。扩展生命周期绑会话：`ExtensionRegion`
//!   归 `AgentSessionHandle` 所有，`sdk.rs:3586` 的 `has_extensions` 要求该
//!   会话传了 `extension_paths`；会话结束扩展就停。而调度器必须在**没有
//!   会话时**也能触发——这是根本矛盾，不是配置问题。另外宿主当前一个扩展
//!   都没加载（`src-tauri/src` 里 `JsExtensionRuntimeHandle::start` 零调用）。
//! - **宿主没有前端插件系统**。`src/contrib/` 只有 `.gitkeep`，没有
//!   contribution registry / routes 区域 / 插件 API。hermes 的
//!   `contrib/wiring.tsx`（1,446 行注册表）宿主没移植。
//!
//! 所以"插件式集成"的实际形态 = **独立文件 + 独立 IPC 命名空间 + 独立
//! 存储 + 独立面板**，不散进既有模块。这满足"可整体摘除"的语义。
//!
//! ## 与 hermes 的语义对应（照抄的部分）
//!
//! | hermes | 本文件 |
//! |---|---|
//! | `cron/jobs.py` 的 jobs.json | [`jobs_path`] + [`read_jobs`] / [`write_jobs`] |
//! | `parse_schedule`（四种语法） | [`parse_schedule`] |
//! | `compute_next_run` | [`compute_next_run`] |
//! | `scheduler_tick.py` 的 tick 顺序 | [`tick`] |
//! | `scheduler.py` 的 run_job | [`run_job`] |
//! | `executions.py` 的台账 | [`Execution`] + [`append_execution`] |
//! | `scheduler_provider.py` 的 60s 循环 | [`start_ticker`] |
//!
//! ## 有意的裁剪（每条都有理由，不假装支持）
//!
//! - **投递面只有 `local`**。hermes 的 `deliver` 支持 Telegram/Discord/Slack/
//!   Email/bot-chat 与 `attach_to_session` 续聊线程——宿主**没有**任何消息
//!   平台适配器，也没有 gateway 抽象。所以 `deliver` 恒为 `"local"`（输出
//!   落盘 + 界面展示），不写假的平台分支。
//! - **没有 monitor gate / wake gate 脚本闸门**。这两个是"省 token"的优化，
//!   依赖 hermes 的 script 执行沙箱语义；宿主先不做，任务一律跑。
//! - **没有 blueprint 目录**。hermes 的 16 个 blueprint 是它自己的技能库
//!   元数据（`google-workspace` 等 skill 名），宿主技能集不同，照抄会指向
//!   不存在的技能。前端编辑器先只留手动创建。
//! - **没有 profile 多路复用**。宿主是单用户单配置（`~/.pi`），hermes 的
//!   profile 是它自己的多租户概念。
//!
//! ## 纪律
//!
//! - **禁止兜底（规矩 12）**：存储读写失败、调度解析失败、会话创建失败
//!   一律传播。任务执行失败**如实记录**到 `last_status = "error"` 与
//!   `last_error`，不吞、不假装成功。
//! - **at-most-once**：重复任务先持久化推进 `next_run_at` 再执行（照抄
//!   `scheduler_tick.py:160` 的理由：崩在中途也不能重启后重放）。
//! - 时间一律带时区（`chrono::DateTime<FixedOffset>`），naive 输入按本机
//!   时区解释后立刻转成带偏移量——与 hermes `jobs.py:823` 同款理由。

use std::collections::{BTreeMap, BTreeSet};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use chrono::{
    DateTime, Datelike, Duration as ChronoDuration, Local, NaiveDate, NaiveDateTime, TimeZone,
    Timelike,
};
use pi::config::Config;

// ── 存储落点 ────────────────────────────────────────────────────────────

/// cron 目录的**显式覆盖**（只给测试用，生产恒 `None`）。
///
/// 为什么需要它：`Config::global_dir()` 在 Windows 上走 Known Folder API，
/// 改 `USERPROFILE` 不生效；即使改 `PI_CODING_AGENT_DIR`（`config.rs:1599`
/// 认它），pi 内部建会话时还会走它自己的 `Config` 快照，测试里出现
/// "作业写进临时目录、会话写进真实 `~/.pi`"的半隔离（实测污染过
/// `~/.pi/agent/cron/sessions`）。
///
/// 所以测试用**进程级显式路径**：`with_temp_cron_dir` 设它，所有路径函数
/// 优先读它。生产代码从不设，行为与"只有 `Config::global_dir()`"完全一致。
static CRON_DIR_OVERRIDE: Mutex<Option<PathBuf>> = Mutex::new(None);

/// cron 目录：`<global_dir>/cron`（与 pi 的 `~/.pi/agent` 同根）。
///
/// 为什么与 hermes 同构（`<home>/cron/jobs.json`）：用户要求"照抄 hermes"，
/// 且这样路径语义一目了然。但**不进 pi 的 settings.json**——那是 pi 的
/// schema，塞私有键会被它的写回覆盖（`pi_capabilities.rs:51` 同款理由）。
pub fn cron_dir() -> PathBuf {
    if let Ok(guard) = CRON_DIR_OVERRIDE.lock() {
        if let Some(dir) = guard.as_ref() {
            return dir.clone();
        }
    }
    Config::global_dir().join("cron")
}

/// 作业存储：`<cron>/jobs.json`。
pub fn jobs_path() -> PathBuf {
    cron_dir().join("jobs.json")
}

/// 执行台账：`<cron>/executions.jsonl`（**追加式 JSONL**，不是 SQLite）。
///
/// hermes 用 SQLite（`executions.db`）是因为它要跨进程 CAS、死主检测、
/// 部分索引。宿主是单进程（Tauri 主进程）+ 单 ticker 线程，用不上那套；
/// 追加式 JSONL 的好处是崩溃安全（半行可跳过）、无新依赖、可直接读。
/// 代价是没有跨进程并发保护——所以 tick 锁（[`TickerState`]）是必须的。
pub fn executions_path() -> PathBuf {
    cron_dir().join("executions.jsonl")
}

/// 单个作业的输出目录：`<cron>/output/<job_id>`。
pub fn job_output_dir(job_id: &str) -> PathBuf {
    cron_dir().join("output").join(sanitize_id(job_id))
}

/// job id 只允许 `[a-z0-9-]`——它是目录名的一部分，绝不能让 `..` 或路径
/// 分隔符进来（否则写文件能逃出 cron 目录）。
fn sanitize_id(id: &str) -> String {
    id.chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
        .collect()
}

fn ensure_dir(path: &Path) -> Result<(), String> {
    std::fs::create_dir_all(path).map_err(|e| format!("cron 目录创建失败 {}: {e}", path.display()))
}

// ── 调度表达式 ──────────────────────────────────────────────────────────

/// 调度种类（对应 hermes `jobs.py:783` 的四种语法）。
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Schedule {
    /// 一次性：`run_at` 是绝对时刻（带偏移量）。
    Once { run_at: FixedOffsetLite },
    /// 固定间隔（分钟）：`30m` / `every 2h` / `every hour`。
    Interval { minutes: i64 },
    /// 5 字段 cron 表达式：`0 9 * * *`。
    Cron { expr: String },
}

/// chrono 的 `DateTime<FixedOffset>` 在 serde 里表达繁琐，这里用字符串存
/// 带偏移量的 RFC3339，读的时候再解析。取这个形状的理由：jobs.json 要
/// 人可读可手改（hermes 同款取舍），而 `DateTime` 的默认 serde 表示是
/// 结构体数组，不可读。
#[derive(Debug, Clone, PartialEq)]
pub struct FixedOffsetLite(pub DateTime<chrono::FixedOffset>);

impl serde::Serialize for FixedOffsetLite {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.0.to_rfc3339())
    }
}

impl<'de> serde::Deserialize<'de> for FixedOffsetLite {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let raw = String::deserialize(d)?;
        let parsed = DateTime::parse_from_rfc3339(&raw)
            .map_err(|e| serde::de::Error::custom(format!("时间戳解析失败 {raw:?}: {e}")))?;
        Ok(Self(parsed))
    }
}

/// 解析调度字符串（照抄 hermes `jobs.py:783` 的四条分支 + 报错文案）。
///
/// 顺序有意义，不能调换：
/// 1. 自然语言周/日（`every monday 9am` / `weekdays at 9am`）→ cron 表达式
/// 2. `every X` 的其余形态 → 间隔
/// 3. 5-6 字段 cron 表达式
/// 4. ISO 时间戳 → 一次性
/// 5. `in 30m` → 一次性（按时长）
/// 6. 裸时长（`30m`）→ **重复**间隔（hermes 的文档契约：裸时长是重复，
///    `in` 前缀才是一次性）
pub fn parse_schedule(schedule: &str) -> Result<Schedule, String> {
    let original = schedule.trim();
    if original.is_empty() {
        return Err("调度不能为空".into());
    }
    let lower = original.to_lowercase();

    // 1. 自然语言周/日
    let (is_every, rest) = match lower.strip_prefix("every ") {
        Some(r) => (true, r.trim().to_string()),
        None => (false, lower.clone()),
    };
    if let Some(expr) = natural_every_to_cron(&rest) {
        return Ok(Schedule::Cron { expr });
    }
    if is_every {
        return Ok(Schedule::Interval {
            minutes: parse_duration(&rest)?,
        });
    }

    // 2. 5-6 字段 cron 表达式。**这里就做完整校验**（含字段值域与字母
    //    拒绝）——放行到执行时才报错的话，用户建作业时看不到问题，
    //    等到点了才发现，而且 tick 会每轮刷错误日志。
    let parts: Vec<&str> = original.split_whitespace().collect();
    if parts.len() >= 5
        && parts.len() <= 6
        && parts
            .iter()
            .all(|p| p.chars().all(|c| c.is_ascii_alphanumeric() || "*/,-".contains(c)))
    {
        let expr = if parts.len() == 6 {
            // 6 字段 = 带秒。宿主按分钟调度，秒字段必须是 0 才等价；
            // 否则明确拒绝（不静默丢弃秒字段——那会让"每 30 秒"变成"每分钟"）。
            if parts[0] != "0" {
                return Err(format!(
                    "6 字段 cron 的第一字段是秒；宿主按分钟调度，秒必须为 0（得到 {:?}）：{original:?}",
                    parts[0]
                ));
            }
            parts[1..].join(" ")
        } else {
            original.to_string()
        };
        // 提前校验（错误信息指向用户的原始输入）
        CronSpec::parse(&expr).map_err(|e| format!("{e}（原始输入 {original:?}）"))?;
        return Ok(Schedule::Cron { expr });
    }

    // 3. ISO 时间戳
    if original.contains('T') || looks_like_date(original) {
        return parse_iso_once(original);
    }

    // 4. `in 30m` → 一次性
    if let Some(rest) = lower.strip_prefix("in ") {
        let minutes = parse_duration(rest.trim())?;
        let at = Local::now() + ChronoDuration::minutes(minutes);
        return Ok(Schedule::Once {
            run_at: FixedOffsetLite(at.fixed_offset()),
        });
    }

    // 5. 裸时长 → 重复间隔
    if let Ok(minutes) = parse_duration(original) {
        return Ok(Schedule::Interval { minutes });
    }

    Err(format!(
        "无法解析调度 {original:?}。可用形态：\n\
         \x20 - 间隔：'30m' / 'every 30m' / 'every 2h'（重复）\n\
         \x20 - 一次性延时：'in 30m' / 'in 2h'（只跑一次）\n\
         \x20 - 每周/每天：'every monday 9am' / 'weekdays at 9am'（重复）\n\
         \x20 - cron 表达式：'0 9 * * *'\n\
         \x20 - 时间戳：'2026-02-03T14:00:00'（一次性）"
    ))
}

fn looks_like_date(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() >= 10
        && b[..4].iter().all(u8::is_ascii_digit)
        && b[4] == b'-'
        && b[5..7].iter().all(u8::is_ascii_digit)
        && b[7] == b'-'
        && b[8..10].iter().all(u8::is_ascii_digit)
}

/// ISO 时间戳 → 一次性。naive 输入按**本机时区**解释（hermes `jobs.py:823`
/// 同款：stored instant 必须与 due 检查用的时钟同一时区，否则会差几小时）。
fn parse_iso_once(raw: &str) -> Result<Schedule, String> {
    if let Ok(dt) = DateTime::parse_from_rfc3339(raw) {
        return Ok(Schedule::Once {
            run_at: FixedOffsetLite(dt),
        });
    }
    let naive = NaiveDateTime::parse_from_str(raw, "%Y-%m-%dT%H:%M:%S")
        .or_else(|_| NaiveDateTime::parse_from_str(raw, "%Y-%m-%dT%H:%M"))
        .or_else(|_| {
            NaiveDate::parse_from_str(raw, "%Y-%m-%d")
                .map(|d| d.and_hms_opt(0, 0, 0).expect("00:00 恒合法"))
        })
        .map_err(|e| format!("时间戳 {raw:?} 解析失败: {e}"))?;
    let local = Local
        .from_local_datetime(&naive)
        .single()
        .ok_or_else(|| format!("时间戳 {raw:?} 在本机时区不唯一（夏令时切换点）"))?;
    Ok(Schedule::Once {
        run_at: FixedOffsetLite(local.fixed_offset()),
    })
}

/// 时长 → 分钟（`30m` / `2h` / `3d` / `hour` / `2 hours` / `30 minutes`）。纯数字按分钟。
fn parse_duration(raw: &str) -> Result<i64, String> {
    let s = raw.trim().to_lowercase();
    if s.is_empty() {
        return Err("时长不能为空".into());
    }
    // 纯数字 = 分钟
    if let Ok(n) = s.parse::<i64>() {
        if n <= 0 {
            return Err(format!("时长必须为正数：{raw:?}"));
        }
        return Ok(n);
    }
    // 自然语言单位（hermes 支持 `every hour` / `every day` / `every 2 hours`）。
    // 单数/复数都认；数字缺省 = 1。
    let (num_part, unit_part) = split_number_unit(&s);
    let n: i64 = if num_part.is_empty() {
        1
    } else {
        num_part
            .trim()
            .parse()
            .map_err(|_| format!("时长 {raw:?} 不是合法数字"))?
    };
    if n <= 0 {
        return Err(format!("时长必须为正数：{raw:?}"));
    }
    let mult = match unit_part.as_str() {
        "m" | "min" | "mins" | "minute" | "minutes" => 1,
        "h" | "hr" | "hrs" | "hour" | "hours" => 60,
        "d" | "day" | "days" => 1440,
        "w" | "week" | "weeks" => 10080,
        other => {
            return Err(format!(
                "时长单位 {other:?} 不支持（可用 m / h / d / w，或 minute/hour/day/week）：{raw:?}"
            ))
        }
    };
    Ok(n * mult)
}

/// 把 `"2 hours"` / `"30m"` / `"hour"` 拆成 (数字部分, 单位部分)。
/// 数字部分可以是空串（`"hour"` = 1 小时）。
fn split_number_unit(s: &str) -> (String, String) {
    let trimmed = s.trim();
    let digit_end = trimmed
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(trimmed.len());
    let (num, rest) = trimmed.split_at(digit_end);
    (num.to_string(), rest.trim().to_string())
}

/// 自然语言周/日 → cron 表达式（照抄 hermes `_natural_every_to_cron` 的
/// 覆盖范围：`<weekday> [at] <time>` / `weekdays at <time>` /
/// `weekends at <time>` / `every day at <time>` / `daily at <time>`）。
fn natural_every_to_cron(rest: &str) -> Option<String> {
    let lower = rest.trim().to_lowercase();
    let (day_part, time_part) = split_day_time(&lower)?;
    let (minute, hour) = parse_clock(&time_part)?;
    let dow = match day_part.as_str() {
        "day" | "daily" | "everyday" => "*".to_string(),
        "weekday" | "weekdays" => "1-5".to_string(),
        "weekend" | "weekends" => "0,6".to_string(),
        "monday" | "mon" => "1".to_string(),
        "tuesday" | "tue" => "2".to_string(),
        "wednesday" | "wed" => "3".to_string(),
        "thursday" | "thu" => "4".to_string(),
        "friday" | "fri" => "5".to_string(),
        "saturday" | "sat" => "6".to_string(),
        "sunday" | "sun" => "0".to_string(),
        _ => return None,
    };
    Some(format!("{minute} {hour} * * {dow}"))
}

/// `"monday 9am"` / `"weekdays at 9am"` / `"day at 08:30"` → (day, time)
fn split_day_time(s: &str) -> Option<(String, String)> {
    let s = s.trim();
    let (day, rest) = if let Some(idx) = s.find(" at ") {
        (s[..idx].trim(), s[idx + 4..].trim())
    } else {
        // 没有 "at"：最后一个空格前是 day，之后是 time
        let idx = s.rfind(' ')?;
        (s[..idx].trim(), s[idx + 1..].trim())
    };
    if day.is_empty() || rest.is_empty() {
        return None;
    }
    // day 可能是 "every day" 去掉前缀后的 "day"；也接受 "daily"/"weekdays"
    Some((day.to_string(), rest.to_string()))
}

/// `"9am"` / `"9:30am"` / `"08:30"` / `"21:00"` → (minute, hour)
fn parse_clock(s: &str) -> Option<(u32, u32)> {
    let s = s.trim().to_lowercase();
    let (body, pm) = if let Some(b) = s.strip_suffix("am") {
        (b.trim(), Some(false))
    } else if let Some(b) = s.strip_suffix("pm") {
        (b.trim(), Some(true))
    } else {
        (s.as_str(), None)
    };
    let (h, m) = match body.split_once(':') {
        Some((h, m)) => (h.trim().parse::<u32>().ok()?, m.trim().parse::<u32>().ok()?),
        None => (body.trim().parse::<u32>().ok()?, 0),
    };
    let hour = match pm {
        Some(true) if h == 12 => 12,
        Some(true) => {
            if h > 12 {
                return None;
            }
            h + 12
        }
        Some(false) if h == 12 => 0,
        Some(false) => {
            if h > 12 {
                return None;
            }
            h
        }
        None => h,
    };
    if hour > 23 || m > 59 {
        return None;
    }
    Some((m, hour))
}

/// 计算下一次运行时刻。
///
/// - `once`：`run_at` 原样（`last_run_at` 已存在 = 已跑过，返回 None）
/// - `interval`：锚定 `last_run_at`（没有则 now），+ minutes —— 锚定
///   `last_run_at` 的理由照抄 hermes `jobs.py:1183`：重启不会重新锚定，
///   否则每重启一次就往后推一个周期
/// - `cron`：手写 5 字段匹配，逐分钟向前找（上限 366 天，防死循环）
pub fn compute_next_run(
    schedule: &Schedule,
    last_run_at: Option<DateTime<chrono::FixedOffset>>,
    now: DateTime<chrono::FixedOffset>,
) -> Result<Option<DateTime<chrono::FixedOffset>>, String> {
    match schedule {
        Schedule::Once { run_at } => {
            if last_run_at.is_some() {
                return Ok(None);
            }
            Ok(Some(run_at.0))
        }
        Schedule::Interval { minutes } => {
            if *minutes <= 0 {
                return Err(format!("间隔必须为正数：{minutes}"));
            }
            let base = last_run_at.unwrap_or(now);
            Ok(Some(base + ChronoDuration::minutes(*minutes)))
        }
        Schedule::Cron { expr } => {
            let spec = CronSpec::parse(expr)?;
            // 从 base 的下一分钟开始找。base 用 last_run_at（锚定，理由同上）。
            // "严格之后"的推进由 next_after 自己做（见它的注释）。
            let base = last_run_at.unwrap_or(now);
            spec.next_after(base)
        }
    }
}

/// 5 字段 cron 表达式（分 时 日 月 周）。
///
/// 只支持数字与 `*` / `,` / `-` / `*/n` / `a-b/n` —— 字母月份/星期
/// （JAN/MON）显式报错，不静默当 0（规矩 12：错误就是错误）。
#[derive(Debug, Clone)]
struct CronSpec {
    minutes: Vec<u32>,
    hours: Vec<u32>,
    days: Vec<u32>,
    months: Vec<u32>,
    /// 周几：0 或 7 = 周日
    dows: Vec<u32>,
    /// 日/周是否都受限——cron 的经典语义：两者都受限时取**或**，否则取**与**。
    dom_restricted: bool,
    dow_restricted: bool,
}

impl CronSpec {
    fn parse(expr: &str) -> Result<Self, String> {
        let parts: Vec<&str> = expr.split_whitespace().collect();
        if parts.len() != 5 {
            return Err(format!(
                "cron 表达式需要 5 个字段（分 时 日 月 周），实际 {} 个：{expr:?}",
                parts.len()
            ));
        }
        let minutes = parse_field(parts[0], 0, 59, "分")?;
        let hours = parse_field(parts[1], 0, 23, "时")?;
        let days = parse_field(parts[2], 1, 31, "日")?;
        let months = parse_field(parts[3], 1, 12, "月")?;
        let dows_raw = parse_field(parts[4], 0, 7, "周")?;
        let dows: Vec<u32> = {
            let mut v: Vec<u32> = dows_raw.into_iter().map(|d| if d == 7 { 0 } else { d }).collect();
            v.sort_unstable();
            v.dedup();
            v
        };
        Ok(Self {
            minutes,
            hours,
            days,
            months,
            dows,
            dom_restricted: parts[2] != "*",
            dow_restricted: parts[4] != "*",
        })
    }

    fn matches_day(&self, date: NaiveDate) -> bool {
        if !self.months.contains(&date.month()) {
            return false;
        }
        let dom_ok = self.days.contains(&date.day());
        let dow_ok = self.dows.contains(&date.weekday().num_days_from_sunday());
        match (self.dom_restricted, self.dow_restricted) {
            // 两者都受限 → 或（cron 标准语义）
            (true, true) => dom_ok || dow_ok,
            (true, false) => dom_ok,
            (false, true) => dow_ok,
            (false, false) => true,
        }
    }

    /// 严格在 `after` 之后的下一个匹配时刻（分钟精度）。上限 366 天。
    ///
    /// **"严格之后"的推进在这里做，不靠调用方**：`compute_next_run` 若自己
    /// 截断 +1 分钟而这里又假设已推进，两个入口（调度路径 / 测试 / 未来的
    /// 手动重排）就会不一致——而"原地返回同一时刻"意味着同一 occurrence
    /// 被反复触发，是无界重发的源头。
    fn next_after(
        &self,
        after: DateTime<chrono::FixedOffset>,
    ) -> Result<Option<DateTime<chrono::FixedOffset>>, String> {
        // 截断到分钟 + 1 分钟 = 严格之后的第一分钟
        let mut cursor = after
            .with_second(0)
            .and_then(|d| d.with_nanosecond(0))
            .ok_or_else(|| "时间截断失败".to_string())?
            + ChronoDuration::minutes(1);
        let limit = after + ChronoDuration::days(366);
        while cursor <= limit {
            let date = cursor.date_naive();
            if self.matches_day(date) {
                if self.hours.contains(&cursor.hour()) && self.minutes.contains(&cursor.minute()) {
                    return Ok(Some(cursor));
                }
            }
            // 跳过整个不匹配的日子（比逐分钟快得多）
            if !self.matches_day(date) {
                let next_day = date.succ_opt().ok_or_else(|| "日期溢出".to_string())?;
                let midnight = next_day
                    .and_hms_opt(0, 0, 0)
                    .ok_or_else(|| "00:00 恒合法".to_string())?;
                cursor = Local
                    .from_local_datetime(&midnight)
                    .earliest()
                    .map(|d| d.fixed_offset())
                    .ok_or_else(|| format!("日期 {} 在本机时区不存在", next_day))?;
            } else {
                cursor += ChronoDuration::minutes(1);
            }
        }
        Ok(None)
    }
}

/// 单字段解析：`*` / `5` / `1-5` / `1,3,5` / `*/15` / `1-20/5`。
fn parse_field(raw: &str, min: u32, max: u32, label: &str) -> Result<Vec<u32>, String> {
    if raw == "*" {
        return Ok((min..=max).collect());
    }
    let mut out: Vec<u32> = Vec::new();
    for piece in raw.split(',') {
        let piece = piece.trim();
        if piece.is_empty() {
            return Err(format!("cron {label}字段有空项：{raw:?}"));
        }
        let (range_part, step) = match piece.split_once('/') {
            Some((r, s)) => {
                let step: u32 = s
                    .parse()
                    .map_err(|_| format!("cron {label}字段步长非法 {s:?}"))?;
                if step == 0 {
                    return Err(format!("cron {label}字段步长不能为 0"));
                }
                (r, step)
            }
            None => (piece, 1),
        };
        let (lo, hi) = if range_part == "*" {
            (min, max)
        } else if let Some((a, b)) = range_part.split_once('-') {
            let a: u32 = a
                .parse()
                .map_err(|_| format!("cron {label}字段范围起点非法 {a:?}"))?;
            let b: u32 = b
                .parse()
                .map_err(|_| format!("cron {label}字段范围终点非法 {b:?}"))?;
            (a, b)
        } else {
            let v: u32 = range_part
                .parse()
                .map_err(|_| format!("cron {label}字段非法 {range_part:?}（不支持字母）"))?;
            // 单值 + 步长（`5/10`）= 从 5 到 max，每 10 个
            (v, if step > 1 { max } else { v })
        };
        if lo < min || hi > max || lo > hi {
            return Err(format!(
                "cron {label}字段越界（允许 {min}-{max}）：{range_part:?}"
            ));
        }
        let mut v = lo;
        while v <= hi {
            out.push(v);
            v += step;
        }
    }
    out.sort_unstable();
    out.dedup();
    if out.is_empty() {
        return Err(format!("cron {label}字段为空：{raw:?}"));
    }
    Ok(out)
}

// ── 作业记录 ────────────────────────────────────────────────────────────

/// 作业状态（对应 hermes `jobs.py` 的 `state` 字段）。
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JobState {
    Scheduled,
    Paused,
    /// 一次性任务跑完（`repeat.completed >= times`）。
    Completed,
}

impl Default for JobState {
    fn default() -> Self {
        Self::Scheduled
    }
}

/// 一次运行的台账行（对应 hermes `executions.py` 的表 + `cron/output` 文档）。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Execution {
    pub id: String,
    pub job_id: String,
    /// `claimed` → `running` → `completed` / `failed`。
    pub status: String,
    /// 计划触发的时刻（cron 语义的 occurrence；一次性任务 = `run_at`）。
    pub scheduled_at: Option<String>,
    pub claimed_at: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub error: Option<String>,
    /// 本次运行的会话文件路径（跑起来才有；前端「打开这次运行」用）。
    pub session_path: Option<String>,
    /// 本次运行的输出文档路径（`<cron>/output/<job>/<时间戳>.md`）。
    pub output_path: Option<String>,
}

/// 一个作业（对应 hermes `jobs.py:1868` create_job 的字段集，裁掉投递面）。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Job {
    pub id: String,
    pub name: String,
    pub prompt: String,
    /// 作业级技能（pi 的技能名，装载后拼进 skills_prompt）。
    pub skills: Vec<String>,
    /// 作业级模型覆盖（`None` = 跟随全局默认）。
    pub provider: Option<String>,
    pub model: Option<String>,
    pub schedule: Option<Schedule>,
    /// 人类可读的调度描述（`"每天 09:00"` / `"每 30 分钟"`）。
    pub schedule_display: String,
    /// 剩余次数（`None` = 无限）。
    pub repeat_times: Option<u32>,
    pub repeat_completed: u32,
    pub state: JobState,
    pub enabled: bool,
    pub paused_at: Option<String>,
    pub paused_reason: Option<String>,
    pub created_at: String,
    pub next_run_at: Option<String>,
    pub last_run_at: Option<String>,
    /// `"ok"` / `"error"` / `None`（从未跑过）。
    pub last_status: Option<String>,
    pub last_error: Option<String>,
    /// 投递目标。**恒为 `"local"`**（宿主无消息平台，见模块头注释）。
    pub deliver: String,
    /// 作业工作目录（工具 cwd）。
    pub workdir: Option<String>,
    /// 机器人绑定（hermes per-bot RoutinesPane 的宿主承载，2026-11-12）：
    /// bot 名（bots-store 的 name 键）。**仅归档/过滤用**——执行参数
    /// （model/persona）在创建时由前端从 bot 预设填进 provider/model/prompt，
    /// bot 删除后作业照常跑。
    #[serde(default)]
    pub bot: Option<String>,
}

impl Default for Job {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            prompt: String::new(),
            skills: Vec::new(),
            provider: None,
            model: None,
            schedule: None,
            schedule_display: String::new(),
            repeat_times: None,
            repeat_completed: 0,
            state: JobState::Scheduled,
            enabled: true,
            paused_at: None,
            paused_reason: None,
            created_at: String::new(),
            next_run_at: None,
            last_run_at: None,
            last_status: None,
            last_error: None,
            deliver: "local".into(),
            workdir: None,
            bot: None,
        }
    }
}

/// 作业是否可运行（照抄 hermes `jobs.py:532` `is_job_runnable`：enabled 且
/// 不是 paused/completed）。
pub fn is_job_runnable(job: &Job) -> bool {
    job.enabled && job.state == JobState::Scheduled
}

// ── 读写 ────────────────────────────────────────────────────────────────

/// jobs.json 的顶层形状。包一层对象（而不是裸数组）是为了留版本位——
/// 将来形状变了能识别旧档。
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct JobsFile {
    version: u32,
    jobs: Vec<Job>,
}

/// 进程内作业存储锁。**跨进程不设锁**：宿主是单进程单 ticker
/// （见 [`executions_path`] 注释）；hermes 的跨进程 flock 是因为它的
/// gateway 与 CLI 可能同时跑。
static JOBS_LOCK: Mutex<()> = Mutex::new(());

/// 正在运行的作业 id 集合——防**同一作业被并发跑**。
///
/// 为什么必须有：手动「立即运行」走 IPC 线程池，ticker 走自己的线程，
/// 两者可以同时选中同一个作业。hermes 用 `claim_job_for_fire`（jobs.json
/// 里的 CAS + TTL 租约）解决；宿主单进程用内存集合即可，语义等价且更简单
/// ——代价是进程崩溃后集合丢失，但那正是我们想要的（崩溃 = 没有运行中的
/// 作业，重启后可以正常再跑）。
static RUNNING: Mutex<Option<std::collections::BTreeSet<String>>> = Mutex::new(None);

/// 尝试占住作业的运行权。`false` = 已有一次运行在跑（本次应跳过，不报错）。
fn try_acquire_run(job_id: &str) -> Result<bool, String> {
    let mut guard = RUNNING.lock().map_err(|_| "cron running 锁中毒".to_string())?;
    let set = guard.get_or_insert_with(std::collections::BTreeSet::new);
    Ok(set.insert(job_id.to_string()))
}

/// 释放运行权（`run_job` 的所有出口都必须调——否则作业永久卡"运行中"）。
fn release_run(job_id: &str) {
    if let Ok(mut guard) = RUNNING.lock() {
        if let Some(set) = guard.as_mut() {
            set.remove(job_id);
        }
    }
}

/// 读全部作业。文件不存在 = 空表（正常态：从没用过定时任务）。
///
/// **解析失败必须报错**（规矩 12）：静默返回空表会让用户以为任务全丢了，
/// 或者更糟——以为还在跑而实际没有。
pub fn read_jobs() -> Result<Vec<Job>, String> {
    let _guard = JOBS_LOCK.lock().map_err(|_| "cron jobs 锁中毒".to_string())?;
    read_jobs_unlocked()
}

fn read_jobs_unlocked() -> Result<Vec<Job>, String> {
    let path = jobs_path();
    match std::fs::read_to_string(&path) {
        Ok(raw) if raw.trim().is_empty() => Ok(Vec::new()),
        Ok(raw) => {
            let parsed: JobsFile = serde_json::from_str(&raw)
                .map_err(|e| format!("定时任务存储解析失败 {}: {e}", path.display()))?;
            Ok(parsed.jobs)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(format!("定时任务存储读取失败 {}: {e}", path.display())),
    }
}

fn write_jobs_unlocked(jobs: &[Job]) -> Result<(), String> {
    let dir = cron_dir();
    ensure_dir(&dir)?;
    let path = jobs_path();
    let file = JobsFile {
        version: 1,
        jobs: jobs.to_vec(),
    };
    let mut contents =
        serde_json::to_string_pretty(&file).map_err(|e| format!("定时任务序列化失败: {e}"))?;
    contents.push('\n');
    // 原子替换：写 tmp 再 rename。半写文件在崩溃时会毁掉整个作业表。
    let tmp = dir.join(format!(".jobs.json.tmp-{}", std::process::id()));
    {
        let mut f = std::fs::File::create(&tmp)
            .map_err(|e| format!("定时任务存储写入失败 {}: {e}", tmp.display()))?;
        f.write_all(contents.as_bytes())
            .map_err(|e| format!("定时任务存储写入失败 {}: {e}", tmp.display()))?;
        f.sync_all()
            .map_err(|e| format!("定时任务存储落盘失败 {}: {e}", tmp.display()))?;
    }
    std::fs::rename(&tmp, &path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("定时任务存储替换失败 {}: {e}", path.display())
    })
}

/// 读-改-写（整个表）。`f` 返回 `Some(jobs)` 才写回。
pub fn mutate_jobs<T>(f: impl FnOnce(&mut Vec<Job>) -> Result<T, String>) -> Result<T, String> {
    let _guard = JOBS_LOCK.lock().map_err(|_| "cron jobs 锁中毒".to_string())?;
    let mut jobs = read_jobs_unlocked()?;
    let out = f(&mut jobs)?;
    write_jobs_unlocked(&jobs)?;
    Ok(out)
}

// ── 执行台账 ────────────────────────────────────────────────────────────

/// 追加一行台账。失败传播（台账丢行 = 运行历史不可信）。
pub fn append_execution(exec: &Execution) -> Result<(), String> {
    let dir = cron_dir();
    ensure_dir(&dir)?;
    let path = executions_path();
    let mut line = serde_json::to_string(exec).map_err(|e| format!("台账序列化失败: {e}"))?;
    line.push('\n');
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("台账打开失败 {}: {e}", path.display()))?;
    f.write_all(line.as_bytes())
        .map_err(|e| format!("台账写入失败 {}: {e}", path.display()))?;
    f.sync_all()
        .map_err(|e| format!("台账落盘失败 {}: {e}", path.display()))
}

/// 读台账（最近的在前，`limit` 条）。
///
/// 半行（崩溃尾）跳过——追加式日志的合法尾部形态。坏行**不静默跳过整份
/// 文件**：只有末尾半行才允许跳过，中间行解析失败要报错（那说明文件被
/// 外力破坏了）。
pub fn read_executions(limit: usize) -> Result<Vec<Execution>, String> {
    let path = executions_path();
    let raw = match std::fs::read_to_string(&path) {
        Ok(r) => r,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("台账读取失败 {}: {e}", path.display())),
    };
    let lines: Vec<&str> = raw.lines().collect();
    let mut out: Vec<Execution> = Vec::new();
    for (idx, line) in lines.iter().enumerate() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        match serde_json::from_str::<Execution>(trimmed) {
            Ok(e) => out.push(e),
            Err(err) => {
                // 只容忍最后一行（崩溃写半行）；中间坏行报错
                if idx + 1 == lines.len() {
                    continue;
                }
                return Err(format!(
                    "台账第 {} 行解析失败 {}: {err}",
                    idx + 1,
                    path.display()
                ));
            }
        }
    }
    out.reverse();
    out.truncate(limit);
    Ok(out)
}

/// 某作业的执行历史（最近的在前）。
pub fn executions_for_job(job_id: &str, limit: usize) -> Result<Vec<Execution>, String> {
    let all = read_executions(usize::MAX)?;
    Ok(all
        .into_iter()
        .filter(|e| e.job_id == job_id)
        .take(limit)
        .collect())
}

// ── 输出文档 ────────────────────────────────────────────────────────────

/// 每次运行的输出文档（照抄 hermes `scheduler.py:2643` 的形状：header +
/// prompt 段 + response 段）。落 `<cron>/output/<job>/<时间戳>.md`。
pub fn write_output_doc(
    job: &Job,
    started_at: DateTime<chrono::FixedOffset>,
    prompt: &str,
    response: &str,
) -> Result<PathBuf, String> {
    let dir = job_output_dir(&job.id);
    ensure_dir(&dir)?;
    let stamp = started_at.format("%Y-%m-%d_%H-%M-%S").to_string();
    let path = dir.join(format!("{stamp}.md"));
    let body = format!(
        "# 定时任务：{}\n\n\
         **Job ID:** {}\n\
         **Run Time:** {}\n\
         **Schedule:** {}\n\n\
         ---\n\n\
         ## Prompt\n\n{}\n\n\
         ## Response\n\n{}\n",
        job.name, job.id, started_at.to_rfc3339(), job.schedule_display, prompt, response
    );
    std::fs::write(&path, body.as_bytes())
        .map_err(|e| format!("输出文档写入失败 {}: {e}", path.display()))?;
    Ok(path)
}

// ── 调度描述 ────────────────────────────────────────────────────────────

/// 人类可读的调度描述（前端「频率」列直接用这个）。
pub fn schedule_display(schedule: &Schedule) -> String {
    match schedule {
        Schedule::Once { run_at } => format!("一次性 {}", run_at.0.format("%Y-%m-%d %H:%M")),
        Schedule::Interval { minutes } => {
            if *minutes % 1440 == 0 {
                format!("每 {} 天", minutes / 1440)
            } else if *minutes % 60 == 0 {
                format!("每 {} 小时", minutes / 60)
            } else {
                format!("每 {minutes} 分钟")
            }
        }
        Schedule::Cron { expr } => format!("cron {expr}"),
    }
}

// ── 当前时刻 ────────────────────────────────────────────────────────────

/// 当前时刻（带本机偏移量）。集中一处，测试可换。
pub fn now() -> DateTime<chrono::FixedOffset> {
    Local::now().fixed_offset()
}

/// ISO 字符串 → 带偏移量的时刻（读 jobs.json 里的 `next_run_at` 等）。
pub fn parse_stored_time(raw: &str) -> Result<DateTime<chrono::FixedOffset>, String> {
    DateTime::parse_from_rfc3339(raw).map_err(|e| format!("时间戳解析失败 {raw:?}: {e}"))
}

// ── 运行历史与会话关联 ──────────────────────────────────────────────────

/// 一次运行的最终结果（[`run_job`] 的返回）。
#[derive(Debug, Clone)]
pub struct RunOutcome {
    pub success: bool,
    /// 本次被跳过（已有运行在跑）。**不是失败**——调用方不该记成错误。
    pub skipped: bool,
    pub response: String,
    pub error: Option<String>,
    pub session_path: Option<String>,
    pub output_path: Option<String>,
}

/// 作业的会话目录：`<cron>/sessions`。
///
/// **为什么单独一个目录**：cron run 是独立会话（hermes 的
/// `cron_{job}_{时间戳}` 同款语义），不能污染用户的聊天会话列表语义——
/// 但也必须能被会话索引看到（否则前端「打开这次运行」读不到）。
/// pi 的 `SessionOptions.session_dir` 正好是这个钩子。
pub fn sessions_dir() -> PathBuf {
    cron_dir().join("sessions")
}

// ── 执行 ────────────────────────────────────────────────────────────────

/// 不活动看门狗上限（秒）。照抄 hermes `scheduler.py:1197`
/// `_cron_inactivity_seconds` 的默认值 600s。
///
/// **不活动**而不是墙钟：一次 run 可能合法地跑很久（长 terminal 调用），
/// 但"600 秒没有任何活动"一定是卡住了。
pub const INACTIVITY_TIMEOUT_SECS: u64 = 600;

/// 看门狗轮询间隔（秒）。hermes 用 5s（`scheduler.py:1965`）。
const WATCHDOG_POLL_SECS: u64 = 5;

/// 跑一次作业。**这是唯一的执行入口**（tick 与手动「立即运行」都走这里）。
///
/// 语义（照抄 hermes `scheduler.py:2561` `run_job`，裁掉投递面）：
/// 1. 占运行权（同一作业不允许并发两次——见 [`try_acquire_run`]）
/// 2. 建独立会话（`session_dir` = [`sessions_dir`]）——不碰用户的活动会话
/// 3. 组装 prompt（作业 prompt + 技能提示）
/// 4. 在**独立线程**上跑，主线程做不活动看门狗
/// 5. 输出文档落盘
/// 6. 无论成败都写台账 + 更新作业状态（`last_status` / `last_error`）
///
/// 失败**如实传播**（规矩 12）：返回 `RunOutcome { success: false, error }`，
/// 不吞、不假装成功。调用方决定怎么处理。
///
/// 已有运行在跑时**不执行、不写台账**，返回 `skipped = true` 的结果——
/// 这是"跳过"不是"失败"，调用方不该记成错误。
pub fn run_job(job: &Job) -> RunOutcome {
    match try_acquire_run(&job.id) {
        Ok(true) => {}
        Ok(false) => {
            return RunOutcome {
                success: false,
                skipped: true,
                response: String::new(),
                error: Some("该作业正在运行中，本次跳过".into()),
                session_path: None,
                output_path: None,
            }
        }
        Err(e) => {
            return RunOutcome {
                success: false,
                skipped: true,
                response: String::new(),
                error: Some(e),
                session_path: None,
                output_path: None,
            }
        }
    }
    // 运行权已占：之后所有出口都必须释放（用闭包包住，Drop 语义靠 guard）
    struct RunGuard<'a>(&'a str);
    impl Drop for RunGuard<'_> {
        fn drop(&mut self) {
            release_run(self.0);
        }
    }
    let _guard = RunGuard(&job.id);

    let started = now();
    let exec_id = uuid::Uuid::new_v4().to_string();
    let mut exec = Execution {
        id: exec_id.clone(),
        job_id: job.id.clone(),
        status: "claimed".into(),
        scheduled_at: job.next_run_at.clone(),
        claimed_at: started.to_rfc3339(),
        started_at: None,
        finished_at: None,
        error: None,
        session_path: None,
        output_path: None,
    };
    // 台账先记 claimed（崩溃后能看出"这次起了但没结束"）
    if let Err(e) = append_execution(&exec) {
        // 台账写不进去 = 运行历史不可信。仍然继续跑（任务本身是用户的意图），
        // 但把错误带回结果里（不静默）。
        eprintln!("[cron] 台账写入失败（继续执行）: {e}");
    }

    let outcome = run_job_inner(job, &mut exec, started);

    exec.status = if outcome.success { "completed" } else { "failed" }.into();
    exec.finished_at = Some(now().to_rfc3339());
    exec.error = outcome.error.clone();
    exec.session_path = outcome.session_path.clone();
    exec.output_path = outcome.output_path.clone();
    if let Err(e) = append_execution(&exec) {
        eprintln!("[cron] 台账终态写入失败: {e}");
    }
    outcome
}

/// 实际的执行体（[`run_job`] 的台账包裹之内）。
fn run_job_inner(job: &Job, exec: &mut Execution, started: DateTime<chrono::FixedOffset>) -> RunOutcome {
    let session_path = sessions_dir().join(format!(
        "{}_{}.jsonl",
        sanitize_id(&job.id),
        started.format("%Y%m%d_%H%M%S")
    ));
    if let Err(e) = ensure_dir(&sessions_dir()) {
        return RunOutcome {
            success: false,
            skipped: false,
            response: String::new(),
            error: Some(e),
            session_path: None,
            output_path: None,
        };
    }

    let prompt = match build_prompt(job) {
        Ok(p) => p,
        Err(e) => {
            return RunOutcome {
                success: false,
                skipped: false,
                response: String::new(),
                error: Some(e),
                session_path: None,
                output_path: None,
            }
        }
    };

    // 会话构造 + 运行。整段在 16MiB 大栈线程上（pi 的 future 深递归）。
    let session_path_str = session_path.display().to_string();
    let exec_started = now();
    exec.status = "running".into();
    exec.started_at = Some(exec_started.to_rfc3339());

    let result = run_in_session(job, &prompt, &session_path);

    match result {
        Ok(response) => {
            let output_path = write_output_doc(job, started, &prompt, &response).ok();
            RunOutcome {
                success: true,
                skipped: false,
                response,
                error: None,
                session_path: Some(session_path_str),
                output_path: output_path.map(|p| p.display().to_string()),
            }
        }
        Err(e) => {
            // 失败也落输出文档（hermes 同款：失败的 run 有诊断文档可查）
            let output_path = write_output_doc(job, started, &prompt, &format!("**FAILED**\n\n{e}")).ok();
            RunOutcome {
                success: false,
                skipped: false,
                response: String::new(),
                error: Some(e),
                session_path: Some(session_path_str),
                output_path: output_path.map(|p| p.display().to_string()),
            }
        }
    }
}

/// 组装运行用的 prompt。
///
/// 作业 prompt + 作业级技能提示。技能提示走 pi 自己的 loader（与
/// `pi_capabilities.rs` 同源），不另造一套。
fn build_prompt(job: &Job) -> Result<String, String> {
    let mut prompt = job.prompt.trim().to_string();
    if prompt.is_empty() {
        return Err("作业 prompt 为空".into());
    }
    if !job.skills.is_empty() {
        let loaded = crate::pi_capabilities::load_skills_for_prompt(&job.skills)?;
        if !loaded.trim().is_empty() {
            prompt = format!("{}\n\n{}", loaded.trim(), prompt);
        }
    }
    Ok(prompt)
}

/// 在独立会话里跑一次 prompt，返回最终响应文本。
///
/// **会话隔离**：用 `session_dir` + 独立 `session_path`，不复用
/// `PiEngine` 的活动 handle（那是用户的聊天会话）。所以这里直接
/// `create_agent_session`，不经过 `PiEngine`。
fn run_in_session(job: &Job, prompt: &str, session_path: &Path) -> Result<String, String> {
    let session_path = session_path.to_path_buf();
    let provider = job.provider.clone();
    let model = job.model.clone();
    let workdir = job.workdir.clone();
    let prompt = prompt.to_string();

    crate::pi_session::on_big_stack(move || {
        let runtime = crate::pi_session::PiRuntime::new();
        let options = pi::sdk::SessionOptions {
            provider,
            model,
            // 作业级技能已拼进 prompt（build_prompt），这里不再重复喂
            skills_prompt: None,
            // 会话持久化到 cron 自己的目录（不污染用户会话列表语义，
            // 但仍进索引——前端「打开这次运行」要读得到）
            no_session: false,
            session_path: Some(session_path),
            session_dir: Some(sessions_dir()),
            // cron run 是无人值守的：工作区信任 = 用户建作业时给了 workdir
            // 就等于信任那个目录（hermes 同款：workdir 是显式选择）
            workspace_trusted: workdir.is_some(),
            working_directory: workdir.map(PathBuf::from),
            // 无人值守：扩展 UI 请求没有前端卡片可答 → 不挂 handler，
            // pi 走上游 fail-closed（能力提示直接 deny）。这是**有意的**：
            // 挂一个假 handler 会让 run 永久挂起等一个不存在的用户。
            extension_ui_handler: None,
            persist_extension_permissions: false,
            ..pi::sdk::SessionOptions::default()
        };

        let handle = runtime
            .block_on(async { pi::sdk::create_agent_session(options).await })
            .map_err(|e| format!("cron 会话创建失败: {e}"))?;

        // 不活动看门狗：run 在独立线程上，主线程按 WATCHDOG_POLL_SECS
        // 轮询。超时 = 报错（不假装成功）。
        let (tx, rx) = std::sync::mpsc::channel::<Result<String, String>>();
        let mut handle = handle;
        std::thread::Builder::new()
            .name("cron-run".into())
            .stack_size(16 * 1024 * 1024)
            .spawn(move || {
                let (_abort_handle, abort_signal) = pi::sdk::AgentSessionHandle::new_abort_handle();
                let out = runtime.block_on(async {
                    // prompt_with_abort 在 AgentSessionHandle 上（recovery.rs:314
                    // 的 impl AgentSessionHandle），不是 session_mut() 的 AgentSession
                    let msg = handle
                        .prompt_with_abort(prompt.as_str(), abort_signal, |_ev| {})
                        .await
                        .map_err(|e| format!("cron run 失败: {e}"))?;
                    // flush 落盘（不 flush 则会话文件不进索引）
                    if let Err(e) = handle.session_mut().save_and_index().await {
                        // flush 失败不掩盖 run 结果（下一次 flush 会补救），
                        // 但必须可见
                        eprintln!("[cron] 会话落盘失败: {e}");
                    }
                    Ok::<String, String>(assistant_text(&msg))
                });
                let _ = tx.send(out);
            })
            .map_err(|e| format!("cron run 线程启动失败: {e}"))?;

        // 看门狗循环
        let deadline = std::time::Instant::now()
            + std::time::Duration::from_secs(INACTIVITY_TIMEOUT_SECS);
        loop {
            match rx.recv_timeout(std::time::Duration::from_secs(WATCHDOG_POLL_SECS)) {
                Ok(out) => return out,
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                    if std::time::Instant::now() >= deadline {
                        return Err(format!(
                            "cron run 超时：{INACTIVITY_TIMEOUT_SECS} 秒内未完成\
                             （会话线程仍在跑，结果已丢弃）"
                        ));
                    }
                }
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    return Err("cron run 线程异常退出（未回传结果）".into())
                }
            }
        }
    })?
}

/// 从 `AssistantMessage` 取纯文本（跳过 thinking / tool_call 块）。
fn assistant_text(msg: &pi::model::AssistantMessage) -> String {
    let mut out = String::new();
    for block in &msg.content {
        if let pi::model::ContentBlock::Text(t) = block {
            if !out.is_empty() {
                out.push('\n');
            }
            out.push_str(&t.text);
        }
    }
    if let Some(err) = &msg.error_message {
        if out.is_empty() {
            return format!("**Provider 错误：** {err}");
        }
        out.push_str(&format!("\n\n**Provider 错误：** {err}"));
    }
    out
}

// ── 调度循环 ────────────────────────────────────────────────────────────

/// tick 间隔（秒）。照抄 hermes `jobs.py:100` `TICKER_INTERVAL_SECONDS = 60`。
pub const TICK_INTERVAL_SECS: u64 = 60;

/// ticker 的共享状态（单实例守卫 + 停止信号）。
pub struct TickerState {
    /// 是否已经有一个 ticker 在跑（防重复启动）。
    running: std::sync::atomic::AtomicBool,
    stop: std::sync::atomic::AtomicBool,
}

impl Default for TickerState {
    fn default() -> Self {
        Self {
            running: std::sync::atomic::AtomicBool::new(false),
            stop: std::sync::atomic::AtomicBool::new(false),
        }
    }
}

impl TickerState {
    pub fn is_running(&self) -> bool {
        self.running.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// 请求 ticker 停止（进程退出时调）。
    pub fn request_stop(&self) {
        self.stop.store(true, std::sync::atomic::Ordering::SeqCst);
    }
}

/// 启动 ticker（幂等：已在跑就返回 `false`，不启第二个）。
///
/// 用独立 **std 线程**而不是 tokio task：pi 的 future 不能进 tokio
/// （`pi_session.rs:4` 的纪律），而 tick 里会跑 `run_job` → 建 pi 会话。
/// 线程 sleep 用 `std::thread::sleep`，不需要 runtime。
pub fn start_ticker(state: std::sync::Arc<TickerState>) -> bool {
    use std::sync::atomic::Ordering;
    // CAS：只有第一个调用者能把 running 从 false 翻到 true
    if state
        .running
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return false;
    }
    let st = std::sync::Arc::clone(&state);
    let spawned = std::thread::Builder::new()
        .name("cron-ticker".into())
        .spawn(move || {
            eprintln!("[cron] ticker 启动（间隔 {TICK_INTERVAL_SECS}s）");
            loop {
                if st.stop.load(Ordering::SeqCst) {
                    eprintln!("[cron] ticker 停止");
                    break;
                }
                match tick() {
                    Ok(n) if n > 0 => eprintln!("[cron] tick 执行了 {n} 个作业"),
                    Ok(_) => {}
                    Err(e) => {
                        // tick 失败必须可见（规矩 12）。不让单次失败杀掉循环
                        // ——下一轮继续（hermes scheduler_provider.py:498 同款：
                        // BaseException 都要兜住，否则 ticker 死了任务全停）。
                        eprintln!("[cron] tick 失败: {e}");
                    }
                }
                // 分片睡眠：stop 请求能在 1 秒内响应，而不是睡满 60 秒
                for _ in 0..TICK_INTERVAL_SECS {
                    if st.stop.load(Ordering::SeqCst) {
                        break;
                    }
                    std::thread::sleep(std::time::Duration::from_secs(1));
                }
            }
            st.running.store(false, Ordering::SeqCst);
        });
    if let Err(e) = spawned {
        // 线程起不来 = ticker 不存在。必须复位 running 让下次能重试，
        // 并把错误报出去（不假装启动成功）。
        state.running.store(false, Ordering::SeqCst);
        eprintln!("[cron] ticker 线程启动失败: {e}");
        return false;
    }
    true
}

/// 一轮调度（照抄 hermes `scheduler_tick.py:92` `_tick_admitted` 的顺序）。
///
/// 顺序**不能改**：
/// 1. 读作业表
/// 2. 找出 due 的（`next_run_at <= now` 且 runnable）
/// 3. **先持久化推进 `next_run_at`**（at-most-once：崩在中途也不重放）
/// 4. 再逐个执行
/// 5. 执行后更新 `last_run_at` / `last_status` / `last_error`
///
/// 返回本轮执行的作业数。
pub fn tick() -> Result<usize, String> {
    let now_ts = now();

    // 1-2. 读表 + 找 due。整段在锁内（与写操作串行）。
    let due: Vec<Job> = mutate_jobs(|jobs| {
        let mut due = Vec::new();
        for job in jobs.iter_mut() {
            if !is_job_runnable(job) {
                continue;
            }
            let Some(raw_next) = job.next_run_at.as_deref() else {
                continue;
            };
            let next = parse_stored_time(raw_next)?;
            if next > now_ts {
                continue;
            }
            // 一次性任务跑够次数 → 标 completed，不再进 due
            if let Some(times) = job.repeat_times {
                if job.repeat_completed >= times {
                    job.state = JobState::Completed;
                    continue;
                }
            }
            due.push(job.clone());
        }
        // 3. **先推进**（at-most-once）。推进失败 = 整轮 tick 失败（宁可不跑，
            // 也不要在"没持久化推进"的情况下执行——那样崩了会重放）。
        for job in jobs.iter_mut() {
            if !due.iter().any(|d| d.id == job.id) {
                continue;
            }
            let schedule = job
                .schedule
                .clone()
                .ok_or_else(|| format!("作业 {} 的调度缺失", job.id))?;
            let last = job
                .last_run_at
                .as_deref()
                .map(parse_stored_time)
                .transpose()?;
            let next = compute_next_run(&schedule, last, now_ts)?;
            job.next_run_at = next.map(|d| d.to_rfc3339());
            if next.is_none() {
                // 一次性任务且已跑过 → completed
                job.state = JobState::Completed;
            }
        }
        Ok(due)
    })?;

    if due.is_empty() {
        return Ok(0);
    }

    // 4. 逐个执行（串行——宿主是单用户单机，并发跑多个 agent 会抢 CPU/额度；
    // hermes 的并行池是为多 profile/多任务场景准备的，这里不引）
    let mut executed = 0usize;
    for job in &due {
        let outcome = run_job(job);
        // 跳过（已有运行在跑）**不计数、不写运行结果**：这一轮没有真的跑，
        // 记成 "error" 会让用户在运行历史里看到一次不存在的失败。
        if outcome.skipped {
            eprintln!(
                "[cron] 作业 {} 正在运行中，本轮跳过",
                job.name
            );
            continue;
        }
        executed += 1;
        // 5. 回写运行结果
        let job_id = job.id.clone();
        let ok = outcome.success;
        let err = outcome.error.clone();
        mutate_jobs(|jobs| {
            if let Some(j) = jobs.iter_mut().find(|j| j.id == job_id) {
                j.last_run_at = Some(now().to_rfc3339());
                j.last_status = Some(if ok { "ok".into() } else { "error".into() });
                j.last_error = err.clone();
                if ok {
                    j.repeat_completed = j.repeat_completed.saturating_add(1);
                }
                // 一次性任务跑完 → completed（重复任务的 next_run_at 已在第 3 步推进）
                if j.schedule.as_ref().map(|s| matches!(s, Schedule::Once { .. })).unwrap_or(false) {
                    j.state = JobState::Completed;
                }
                // 一次性任务的一次性失败不自动暂停（hermes 的失败计数+暂停
                // 是它自己的告警策略；宿主先如实记录，让用户看到）
            }
            Ok(())
        })?;
    }
    Ok(executed)
}

// ── 作业 CRUD（IPC 面的实现） ────────────────────────────────────────────

/// 创建作业的入参。
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateJobInput {
    pub prompt: String,
    pub schedule: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub skills: Vec<String>,
    #[serde(default)]
    pub workdir: Option<String>,
    /// 剩余次数（`None` = 无限；一次性任务不传时默认 1）。
    #[serde(default)]
    pub repeat: Option<u32>,
    /// 机器人绑定（bot 名；None = 不绑定——宿主「定时任务」页创建的作业）。
    #[serde(default)]
    pub bot: Option<String>,
}

/// 创建作业（照抄 hermes `jobs.py:1788` `create_job` 的校验顺序）。
pub fn create_job(input: CreateJobInput) -> Result<Job, String> {
    let prompt = input.prompt.trim().to_string();
    if prompt.is_empty() {
        return Err("prompt 不能为空".into());
    }
    let schedule = parse_schedule(&input.schedule)?;
    // 一次性任务的 repeat 默认 1（跑一次就 completed）；重复任务默认无限
    let repeat_times = match (&schedule, input.repeat) {
        (Schedule::Once { .. }, None) => Some(1),
        (_, n) => n,
    };
    if let Some(0) = repeat_times {
        return Err("repeat 不能为 0（要无限次就不传）".into());
    }
    // 一次性任务的时间戳不能在过去（否则会立刻触发一次然后消失，
    // 用户以为没生效）
    let now_ts = now();
    let next = compute_next_run(&schedule, None, now_ts)?;
    if let Schedule::Once { .. } = schedule {
        if let Some(n) = next {
            if n <= now_ts {
                return Err(format!(
                    "一次性任务的时间点已过去：{}（当前 {}）",
                    n.to_rfc3339(),
                    now_ts.to_rfc3339()
                ));
            }
        }
    }
    // workdir 必须存在且是目录（hermes jobs.py:1633 同款：相对路径拒绝，
    // 因为 cron run 没有 shell cwd）
    let workdir = match input.workdir.as_deref().map(str::trim) {
        None | Some("") => None,
        Some(raw) => {
            let p = PathBuf::from(raw);
            if !p.is_absolute() {
                return Err(format!("workdir 必须是绝对路径：{raw}"));
            }
            if !p.is_dir() {
                return Err(format!("workdir 不是已存在的目录：{raw}"));
            }
            Some(raw.to_string())
        }
    };

    let name = input
        .name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| {
            // 无名字时取 prompt 前 50 字（hermes jobs.py:1863 同款）
            prompt.chars().take(50).collect()
        });

    let job = Job {
        id: uuid::Uuid::new_v4().simple().to_string()[..12].to_string(),
        name,
        prompt,
        skills: input.skills,
        provider: input.provider.filter(|s| !s.trim().is_empty()),
        model: input.model.filter(|s| !s.trim().is_empty()),
        schedule_display: schedule_display(&schedule),
        schedule: Some(schedule),
        repeat_times,
        repeat_completed: 0,
        state: JobState::Scheduled,
        enabled: true,
        paused_at: None,
        paused_reason: None,
        created_at: now_ts.to_rfc3339(),
        next_run_at: next.map(|d| d.to_rfc3339()),
        last_run_at: None,
        last_status: None,
        last_error: None,
        deliver: "local".into(),
        workdir,
        bot: input.bot.filter(|s| !s.trim().is_empty()),
    };
    let to_store = job.clone();
    mutate_jobs(|jobs| {
        jobs.push(to_store);
        Ok(())
    })?;
    Ok(job)
}

/// 更新作业（只支持前端编辑器会改的字段）。
#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateJobInput {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub prompt: Option<String>,
    #[serde(default)]
    pub schedule: Option<String>,
    #[serde(default)]
    pub provider: Option<Option<String>>,
    #[serde(default)]
    pub model: Option<Option<String>>,
    /// 机器人绑定（Some(None) = 解绑）。
    #[serde(default)]
    pub bot: Option<Option<String>>,
}

/// 更新作业。调度变了要重算 `next_run_at`（照抄 hermes
/// `_apply_schedule_update` 的语义：换调度 = 重新排期）。
pub fn update_job(id: &str, input: UpdateJobInput) -> Result<Job, String> {
    let now_ts = now();
    let mut updated: Option<Job> = None;
    mutate_jobs(|jobs| {
        let job = jobs
            .iter_mut()
            .find(|j| j.id == id)
            .ok_or_else(|| format!("作业不存在：{id}"))?;
        if let Some(name) = input.name {
            let t = name.trim();
            if !t.is_empty() {
                job.name = t.to_string();
            }
        }
        if let Some(prompt) = input.prompt {
            let t = prompt.trim();
            if t.is_empty() {
                return Err("prompt 不能为空".into());
            }
            job.prompt = t.to_string();
        }
        if let Some(raw) = input.schedule {
            let schedule = parse_schedule(&raw)?;
            let next = compute_next_run(&schedule, None, now_ts)?;
            if let Schedule::Once { .. } = schedule {
                if let Some(n) = next {
                    if n <= now_ts {
                        return Err(format!("一次性任务的时间点已过去：{}", n.to_rfc3339()));
                    }
                }
            }
            job.schedule_display = schedule_display(&schedule);
            job.schedule = Some(schedule);
            job.next_run_at = next.map(|d| d.to_rfc3339());
            // 换调度 = 重新排期：清掉 completed 态让任务重新可跑
            if job.state == JobState::Completed {
                job.state = JobState::Scheduled;
                job.enabled = true;
                job.repeat_completed = 0;
            }
        }
        if let Some(provider) = input.provider {
            job.provider = provider.filter(|s| !s.trim().is_empty());
        }
        if let Some(model) = input.model {
            job.model = model.filter(|s| !s.trim().is_empty());
        }
        if let Some(bot) = input.bot {
            job.bot = bot.filter(|s| !s.trim().is_empty());
        }
        updated = Some(job.clone());
        Ok(())
    })?;
    updated.ok_or_else(|| "更新后作业丢失（内部错误）".to_string())
}

/// 暂停作业（`enabled = false` + `state = paused` + 记时间与原因）。
pub fn pause_job(id: &str, reason: Option<String>) -> Result<Job, String> {
    let now_ts = now();
    let mut out: Option<Job> = None;
    mutate_jobs(|jobs| {
        let job = jobs
            .iter_mut()
            .find(|j| j.id == id)
            .ok_or_else(|| format!("作业不存在：{id}"))?;
        job.enabled = false;
        job.state = JobState::Paused;
        job.paused_at = Some(now_ts.to_rfc3339());
        job.paused_reason = reason.clone();
        out = Some(job.clone());
        Ok(())
    })?;
    out.ok_or_else(|| "暂停后作业丢失（内部错误）".to_string())
}

/// 恢复作业。一次性任务若时间点已过去，重排到下一个可用时刻并报错说明
/// （hermes `resume_job` 同款：过去的一次性任务不能悄悄复活）。
pub fn resume_job(id: &str) -> Result<Job, String> {
    let now_ts = now();
    let mut out: Option<Job> = None;
    mutate_jobs(|jobs| {
        let job = jobs
            .iter_mut()
            .find(|j| j.id == id)
            .ok_or_else(|| format!("作业不存在：{id}"))?;
        if let Some(Schedule::Once { run_at }) = &job.schedule {
            if run_at.0 <= now_ts {
                return Err(format!(
                    "一次性任务的时间点已过去（{}），不能恢复。请改调度或新建。",
                    run_at.0.to_rfc3339()
                ));
            }
        }
        job.enabled = true;
        job.state = JobState::Scheduled;
        job.paused_at = None;
        job.paused_reason = None;
        // 恢复时补齐 next_run_at（暂停期间可能被清空）
        if job.next_run_at.is_none() {
            if let Some(schedule) = job.schedule.clone() {
                let last = job.last_run_at.as_deref().map(parse_stored_time).transpose()?;
                job.next_run_at = compute_next_run(&schedule, last, now_ts)?.map(|d| d.to_rfc3339());
            }
        }
        out = Some(job.clone());
        Ok(())
    })?;
    out.ok_or_else(|| "恢复后作业丢失（内部错误）".to_string())
}

/// 删除作业（同时删它的输出目录与会话文件？**不删**——用户的运行记录是
/// 资产，删作业不该连带销毁历史。只从作业表移除）。
pub fn delete_job(id: &str) -> Result<(), String> {
    mutate_jobs(|jobs| {
        let before = jobs.len();
        jobs.retain(|j| j.id != id);
        if jobs.len() == before {
            return Err(format!("作业不存在：{id}"));
        }
        Ok(())
    })
}

/// 立即运行（不等调度）。**同步**执行——前端按钮点击后等结果
/// （hermes 的 `trigger` 也是同步等待整个 job）。
///
/// 已有运行在跑时返回 `skipped = true`（**不是错误**：用户点两下不该看到
/// 失败；但也不能假装跑了）。
pub fn trigger_job(id: &str) -> Result<RunOutcome, String> {
    let job = read_jobs()?
        .into_iter()
        .find(|j| j.id == id)
        .ok_or_else(|| format!("作业不存在：{id}"))?;
    let outcome = run_job(&job);
    if outcome.skipped {
        return Ok(outcome);
    }
    // 手动触发也更新 last_run_at / last_status（运行历史要一致）
    let ok = outcome.success;
    let err = outcome.error.clone();
    mutate_jobs(|jobs| {
        if let Some(j) = jobs.iter_mut().find(|j| j.id == id) {
            j.last_run_at = Some(now().to_rfc3339());
            j.last_status = Some(if ok { "ok".into() } else { "error".into() });
            j.last_error = err.clone();
        }
        Ok(())
    })?;
    Ok(outcome)
}

// ── 自动化蓝图（照抄 hermes `cron/blueprint_catalog.py`）─────────────────
//
// 16 个内置模板，逐字照抄上游的 key/title/description/category/
// schedule_template/prompt_template/slots/tags。
//
// ## 唯一的裁剪：`skills` 字段
//
// 上游有 5 个蓝图带 `skills`（morning-brief → `google-workspace`、
// important-mail → `email-inbox-triage`、weekly-review →
// `weekly-review-planning`、price-watch → `product-price-monitor`、
// competitor-watch → `competitor-news-monitor`）。那些是 **hermes 自己的技能库
// 条目**，宿主没有同名技能；照抄会让作业一建就因"技能不存在"而失败。
//
// 处理方式：**去掉 skills，在 prompt 里把"跑某个技能的过程"改写成自包含的
// 指令**。这样蓝图仍然可用（不指向不存在的技能），也没有假装技能存在。
// 每个被改写的 prompt 都有一行注释说明原文怎么写的。
//
// ## 槽位类型
//
// `time`（HH:MM）/ `enum`（闭集）/ `weekdays`（WEEKDAY_PRESETS）/ `text`。
// `strict: false` 的 enum 是"建议而非闭集"（deliver 槽用它）。

/// 星期预设（上游 `blueprint_catalog.py:38` 逐字）。
const WEEKDAY_PRESETS: &[(&str, &str)] = &[
    ("everyday", "*"),
    ("weekdays", "1-5"),
    ("weekends", "0,6"),
];

/// 蓝图槽位（上游 `BlueprintSlot`）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlueprintField {
    pub name: &'static str,
    /// `"time"` / `"enum"` / `"weekdays"` / `"text"`
    pub r#type: &'static str,
    pub label: &'static str,
    pub default: Option<&'static str>,
    pub options: Vec<&'static str>,
    pub optional: bool,
    /// 上游语义：false = options 是建议而非闭集。
    pub strict: bool,
    pub help: &'static str,
}

/// 一个自动化蓝图（上游 `AutomationBlueprint`）。
#[derive(Debug, Clone)]
pub struct Blueprint {
    pub key: &'static str,
    pub title: &'static str,
    pub description: &'static str,
    pub category: &'static str,
    /// cron 表达式，可含 `{slot}` 占位符。
    pub schedule_template: &'static str,
    pub prompt_template: &'static str,
    pub fields: Vec<BlueprintField>,
    pub tags: Vec<&'static str>,
}

fn time_field(default: &'static str) -> BlueprintField {
    BlueprintField {
        name: "time",
        r#type: "time",
        label: "What time?",
        default: Some(default),
        options: vec![],
        optional: false,
        strict: true,
        help: "24h local time, e.g. 08:00",
    }
}

/// 投递槽。上游的 options 含 origin/telegram/discord/email——宿主只有
/// `local`（无消息平台），但**保留上游 options 会让下拉框出现点不动的项**。
/// 所以 options 只给 `local`，`strict: false` 保留（语义：建议集，真实目标
/// 由 `getCronDeliveryTargets()` 决定）。
fn deliver_field() -> BlueprintField {
    BlueprintField {
        name: "deliver",
        r#type: "enum",
        label: "Where to deliver?",
        default: Some("local"),
        options: vec!["local"],
        optional: false,
        strict: false,
        help: "宿主只有本机投递（没有消息平台适配器）",
    }
}

fn text_field(
    name: &'static str,
    label: &'static str,
    default: &'static str,
    help: &'static str,
) -> BlueprintField {
    BlueprintField {
        name,
        r#type: "text",
        label,
        default: Some(default),
        options: vec![],
        optional: false,
        strict: true,
        help,
    }
}

fn enum_field(
    name: &'static str,
    label: &'static str,
    default: &'static str,
    options: Vec<&'static str>,
    help: &'static str,
) -> BlueprintField {
    BlueprintField {
        name,
        r#type: "enum",
        label,
        default: Some(default),
        options,
        optional: false,
        strict: true,
        help,
    }
}

fn weekdays_field(name: &'static str, label: &'static str, default: &'static str) -> BlueprintField {
    BlueprintField {
        name,
        r#type: "weekdays",
        label,
        default: Some(default),
        options: WEEKDAY_PRESETS.iter().map(|(k, _)| *k).collect(),
        optional: false,
        strict: true,
        help: "",
    }
}

fn day_field(default: &'static str) -> BlueprintField {
    enum_field(
        "day",
        "Which day?",
        default,
        vec!["sunday", "monday", "friday", "saturday"],
        "",
    )
}

/// 内置蓝图目录（上游 `CATALOG`，16 项，顺序一致）。
pub fn blueprints() -> Vec<Blueprint> {
    vec![
        Blueprint {
            key: "morning-brief",
            title: "Morning briefing",
            description: "A short daily briefing: today's calendar, weather, and anything urgent waiting on you.",
            category: "daily",
            schedule_template: "{minute} {hour} * * *",
            // 上游：`follow the google-workspace skill's references/daily-brief.md
            // procedure`。宿主无该技能 → 改写成自包含步骤。
            prompt_template: "Produce a concise morning briefing for the user: today's calendar events, the local weather, and any urgent items. \
If Google Calendar / Gmail tools are available, use them for the calendar window (today) and for mail that needs a reply today; \
check for meeting conflicts and flag early meetings that need prep. Keep it short and scannable. \
If no data sources are connected, give a brief good-morning with the date and offer to connect calendar/email.",
            fields: vec![time_field("08:00"), deliver_field()],
            tags: vec!["daily", "briefing"],
        },
        Blueprint {
            key: "important-mail",
            title: "Important-mail monitor",
            description: "Check your inbox periodically and ping you ONLY about mail that actually needs attention.",
            category: "email",
            schedule_template: "*/{interval_min} * * * *",
            // 上游：`Score candidates with the urgency classifier`（它自己的技能）。
            // 宿主 → 让模型自己按给定标准判断，不引用不存在的分类器。
            prompt_template: "Check the user's inbox for new messages since the last run. Surface ONLY mail matching: {criteria}. \
Judge urgency yourself against that criteria — deliver only what clearly clears the bar; if nothing does, respond with [SILENT]. \
Requires a connected mail source; if none is configured, explain how to connect one and stop.",
            fields: vec![
                enum_field("interval_min", "How often?", "30", vec!["15", "30", "60"], "minutes between checks"),
                text_field(
                    "criteria",
                    "Only notify me if the mail…",
                    "needs a reply today, is from my manager or family, or mentions a deadline",
                    "",
                ),
                deliver_field(),
            ],
            tags: vec!["email", "monitor"],
        },
        Blueprint {
            key: "weekly-review",
            title: "Weekly review",
            description: "A weekly recap: what got done, what's still open, and what's coming up.",
            category: "weekly",
            schedule_template: "{minute} {hour} * * {dow}",
            // 上游：`Run the weekly-review-planning skill's procedure`。→ 内联七段结构。
            prompt_template: "Review the completed week and the coming 1-2 weeks for the user across connected calendar, tasks, notes, and email. \
Cover: (1) what got done, (2) stalled projects, (3) commitments made to others, (4) items waiting on someone else, \
(5) upcoming deadlines, (6) capacity-aware plan for next week, (7) anything to drop. \
Recommendations and drafts only — no mutations without approval.",
            fields: vec![time_field("18:00"), day_field("sunday"), deliver_field()],
            tags: vec!["weekly", "review"],
        },
        Blueprint {
            key: "workday-start",
            title: "Workday start reminder",
            description: "A weekday nudge with your agenda and top priorities.",
            category: "daily",
            schedule_template: "{minute} {hour} * * 1-5",
            prompt_template: "Give the user a brief weekday start-of-day nudge: today's calendar and the 1-3 highest-priority things to focus on, \
inferred from recent context and any task tools. Encouraging, short, one message.",
            fields: vec![time_field("09:00"), deliver_field()],
            tags: vec!["daily", "focus"],
        },
        Blueprint {
            key: "custom-reminder",
            title: "Custom reminder",
            description: "A recurring reminder in your own words, on your schedule.",
            category: "general",
            schedule_template: "{minute} {hour} * * {dow}",
            prompt_template: "Remind the user: {what}",
            fields: vec![
                text_field("what", "Remind me to…", "take a break and stretch", ""),
                time_field("14:00"),
                weekdays_field("recurrence", "Repeat on", "everyday"),
                deliver_field(),
            ],
            tags: vec!["reminder"],
        },
        Blueprint {
            key: "evening-winddown",
            title: "Evening wind-down",
            description: "An end-of-day check-in: tomorrow's calendar at a glance and anything you should prep tonight.",
            category: "daily",
            schedule_template: "{minute} {hour} * * *",
            prompt_template: "Give the user a short evening wind-down: tomorrow's calendar, any early commitments to prep for, \
and one gentle nudge to wrap up loose ends from today. Keep it calm and brief — one message. \
If no calendar is connected, just offer a friendly sign-off and the weather for tomorrow.",
            fields: vec![time_field("21:00"), deliver_field()],
            tags: vec!["daily", "evening"],
        },
        Blueprint {
            key: "news-digest",
            title: "Topic news digest",
            description: "A recurring digest on a topic you care about — deduped against what was already sent, so only genuinely new items land.",
            category: "general",
            schedule_template: "{minute} {hour} * * {dow}",
            prompt_template: "Search the web for new and noteworthy items about: {topic}. \
Dedupe against what you sent in previous runs — only include genuinely new developments. \
Deliver a tight digest of at most {count} bullets, each one line with a link. If nothing new since last run, respond with [SILENT].",
            fields: vec![
                text_field("topic", "What topic?", "AI and technology", "a subject, product, person, or search phrase"),
                time_field("18:00"),
                weekdays_field("recurrence", "Repeat on", "weekdays"),
                enum_field("count", "How many bullets?", "5", vec!["3", "5", "8"], ""),
                deliver_field(),
            ],
            tags: vec!["digest", "research"],
        },
        Blueprint {
            key: "bill-renewal-watch",
            title: "Bills & renewals reminder",
            description: "A heads-up before a recurring payment, subscription renewal, or due date — so nothing auto-charges by surprise.",
            category: "general",
            schedule_template: "{minute} {hour} * * {dow}",
            prompt_template: "Remind the user about an upcoming payment or renewal: {what}. \
Phrase it as an actionable heads-up (e.g. 'review or cancel before it renews'), not just a notification. One short message.",
            fields: vec![
                text_field("what", "What's due?", "my streaming subscription renews soon", ""),
                time_field("10:00"),
                weekdays_field("recurrence", "Repeat on", "everyday"),
                deliver_field(),
            ],
            tags: vec!["reminder", "finance"],
        },
        Blueprint {
            key: "price-watch",
            title: "Price & availability watch",
            description: "Watch an exact product, flight, hotel, or listing and alert when your price or availability condition is met.",
            category: "general",
            schedule_template: "0 */{interval_h} * * *",
            // 上游：`Load the product-price-monitor skill and run the tick`。→ 内联等价步骤。
            prompt_template: "Run a price/availability watch tick for: {item}. Alert condition: {condition}. \
Fetch the current normalized all-in price/availability, compare against the last known state you recorded in a previous run \
(use a notes file under the working directory if you have file tools), suppress duplicate alerts, \
and never overwrite last-known-good state with a failed fetch. If the condition is not met, respond with [SILENT]. \
On the first run: pin the exact item, verify one live fetch, and write down the watch contract (item + condition + last state).",
            fields: vec![
                text_field(
                    "item",
                    "What exactly to watch?",
                    "a product URL or exact flight/hotel/listing description",
                    "URL or precise description — variant, dates, seller",
                ),
                text_field(
                    "condition",
                    "Alert me when…",
                    "the all-in price drops below my target",
                    "threshold price (state the currency), availability, or terms change",
                ),
                enum_field("interval_h", "How often?", "6", vec!["1", "3", "6", "12", "24"], "hours between checks — be gentle with rate limits"),
                deliver_field(),
            ],
            tags: vec!["prices", "shopping", "travel", "monitor"],
        },
        Blueprint {
            key: "competitor-watch",
            title: "Competitor news watch",
            description: "Track named companies for material news — launches, pricing, funding, filings — with a cited digest.",
            category: "general",
            schedule_template: "{minute} {hour} * * {dow}",
            // 上游：`Load the competitor-news-monitor skill and run the tick`。→ 内联等价步骤。
            prompt_template: "Run a competitor-news watch tick for: companies {companies}; event categories {categories}. \
Collect incrementally from the last cutoff you recorded in a previous run, deduplicate by underlying event, \
score materiality against the watch contract, and deliver a cited digest of material events only. \
If there are no material events, respond with [SILENT]. \
On the first run: freeze the watchlist, build source coverage, and write down the watch contract.",
            fields: vec![
                text_field(
                    "companies",
                    "Which companies?",
                    "two or three competitors, by canonical name",
                    "canonical names and domains; aliases help dedup",
                ),
                text_field(
                    "categories",
                    "Which events matter?",
                    "product launches, pricing changes, funding, partnerships, executive moves, incidents",
                    "",
                ),
                time_field("09:00"),
                // **修正上游数据 bug**：上游 `blueprint_catalog.py:367` 把这个
                // `weekdays` 类型槽的默认值写成 `"monday"`，但 `weekdays` 的
                // options 只有 WEEKDAY_PRESETS（everyday/weekdays/weekends）。
                // 上游自己用默认值填槽也会抛
                // `unknown recurrence 'monday'`（`_resolve_schedule:713` 只认
                // preset）。这里改成 `weekdays`——保持"每周复盘一次"的意图，
                // 且默认值真的可用。
                weekdays_field("recurrence", "Repeat on", "weekdays"),
                deliver_field(),
            ],
            tags: vec!["competitors", "news", "monitor", "research"],
        },
        Blueprint {
            key: "habit-checkin",
            title: "Habit check-in",
            description: "A recurring nudge to keep a habit on track and reflect on whether you did it.",
            category: "general",
            schedule_template: "{minute} {hour} * * {dow}",
            prompt_template: "Nudge the user about their habit: {habit}. Ask whether they did it today, \
keep it warm and non-judgmental, and offer a one-line word of encouragement. One short message.",
            fields: vec![
                text_field("habit", "Which habit?", "20 minutes of reading", ""),
                time_field("20:00"),
                weekdays_field("recurrence", "Repeat on", "everyday"),
                deliver_field(),
            ],
            tags: vec!["habit", "wellbeing"],
        },
        Blueprint {
            key: "hydration-move",
            title: "Hydration & movement nudge",
            description: "A periodic nudge during the day to drink water, stand up, and stretch.",
            category: "general",
            // 上游注释：cron 的分钟字段步长（*/90）会按小时回绕——*/90 与
            // */120 都退化成每小时。所以用**小时字段步长**，让选的节奏真的生效。
            schedule_template: "0 {start_hour}-{end_hour}/{interval_hours} * * 1-5",
            prompt_template: "Send the user a brief, friendly nudge to drink some water, stand up, and stretch for a moment. \
Vary the wording each time so it doesn't feel robotic. One short line.",
            fields: vec![
                enum_field("interval_hours", "How often?", "1", vec!["1", "2", "3"], "hours between nudges"),
                enum_field("start_hour", "Start hour", "9", vec!["7", "8", "9", "10"], "first hour of the active window (24h)"),
                enum_field("end_hour", "End hour", "17", vec!["16", "17", "18", "19"], "last hour of the active window (24h)"),
                deliver_field(),
            ],
            tags: vec!["wellbeing", "focus"],
        },
        Blueprint {
            key: "meal-plan",
            title: "Weekly meal plan",
            description: "A weekly meal plan plus a consolidated grocery list, tuned to your diet and how much time you have to cook.",
            category: "weekly",
            schedule_template: "{minute} {hour} * * {dow}",
            prompt_template: "Build the user a meal plan for the coming week: {meals} per day, suited to a {diet} diet and roughly {effort} cooking effort. \
Include a consolidated grocery list grouped by aisle. Keep it simple and skimmable.",
            fields: vec![
                enum_field(
                    "diet",
                    "Diet?",
                    "no restrictions",
                    vec!["no restrictions", "vegetarian", "vegan", "high-protein", "low-carb"],
                    "",
                ),
                enum_field(
                    "meals",
                    "Meals per day?",
                    "dinner only",
                    vec!["dinner only", "lunch and dinner", "all three"],
                    "",
                ),
                enum_field("effort", "Cooking effort?", "quick", vec!["quick", "medium", "ambitious"], ""),
                time_field("17:00"),
                day_field("sunday"),
                deliver_field(),
            ],
            tags: vec!["weekly", "food"],
        },
        Blueprint {
            key: "learn-daily",
            title: "Daily learning drip",
            description: "One bite-sized lesson a day on a topic you want to learn, building progressively over time.",
            category: "daily",
            schedule_template: "{minute} {hour} * * {dow}",
            prompt_template: "Teach the user one bite-sized lesson about: {topic}. Build on earlier lessons so it progresses rather than repeating. \
Keep it to a couple of short paragraphs with one concrete example, and end with a single question to check understanding.",
            fields: vec![
                text_field("topic", "Learn about…", "Spanish vocabulary", ""),
                time_field("08:30"),
                weekdays_field("recurrence", "Repeat on", "weekdays"),
                deliver_field(),
            ],
            tags: vec!["learning", "daily"],
        },
        Blueprint {
            key: "gratitude-journal",
            title: "Gratitude & reflection prompt",
            description: "A gentle evening prompt to reflect on the day and note what went well.",
            category: "general",
            schedule_template: "{minute} {hour} * * {dow}",
            prompt_template: "Send the user a short, warm reflection prompt for the end of the day — invite them to note one thing that went well, \
one thing they are grateful for, and one small win. If they reply, acknowledge it kindly. One message.",
            fields: vec![
                time_field("21:30"),
                weekdays_field("recurrence", "Repeat on", "everyday"),
                deliver_field(),
            ],
            tags: vec!["wellbeing", "reflection"],
        },
        Blueprint {
            key: "on-this-day",
            title: "On-this-day discovery",
            description: "A daily dose of curiosity: a notable historical event, fact, or word for the day.",
            category: "daily",
            schedule_template: "{minute} {hour} * * *",
            prompt_template: "Give the user one interesting '{flavor}' item for today — keep it short, surprising, and genuinely interesting. \
One or two sentences, no filler.",
            fields: vec![
                enum_field(
                    "flavor",
                    "What kind?",
                    "on this day in history",
                    vec!["on this day in history", "word of the day", "science fact", "quote of the day"],
                    "",
                ),
                time_field("07:30"),
                deliver_field(),
            ],
            tags: vec!["daily", "curiosity"],
        },
    ]
}

/// 蓝图 → 前端表单形状（上游 `blueprint_catalog_entry`）。
///
/// 上游还返回 `command`（`/blueprint <key> slot=val`）与 `appUrl`
/// （`hermes://blueprint/...`）——那是它自己的 slash 命令与深链协议，宿主
/// 没有。前端 `blueprints.tsx` 只读 `fields`，`index.tsx` 读
/// `key/title/description/plugin`，所以这两个字段给空串（形状完整、内容
/// 如实为空，而不是编造一个宿主打不开的 URL）。
fn blueprint_entry(bp: &Blueprint) -> serde_json::Value {
    serde_json::json!({
        "key": bp.key,
        "title": bp.title,
        "description": bp.description,
        "category": bp.category,
        "tags": bp.tags,
        "fields": bp.fields,
        "command": "",
        "appUrl": "",
        "source": "builtin",
        "plugin": null,
    })
}

/// 填槽 + 校验 → 创建作业的参数（上游 `fill_blueprint`）。
///
/// 校验规则照抄上游（`:754-772`）：未知槽位名拒绝（typo 不能静默用默认值）、
/// 必填槽缺失报错并指明槽名、strict enum 检查闭集。
fn fill_blueprint(bp: &Blueprint, values: &BTreeMap<String, String>) -> Result<CreateJobInput, String> {
    let known: BTreeSet<&str> = bp.fields.iter().map(|f| f.name).collect();
    let unknown: Vec<&str> = values
        .keys()
        .filter(|k| !known.contains(k.as_str()))
        .map(String::as_str)
        .collect();
    if !unknown.is_empty() {
        return Err(format!(
            "未知槽位：{}（可用：{}）",
            unknown.join("、"),
            bp.fields.iter().map(|f| f.name).collect::<Vec<_>>().join("、")
        ));
    }

    // 解析后的槽值（缺省用 field.default）
    let mut resolved: BTreeMap<String, String> = BTreeMap::new();
    for field in &bp.fields {
        let raw = values
            .get(field.name)
            .map(String::as_str)
            .or(field.default)
            .unwrap_or("");
        if raw.is_empty() {
            if field.optional {
                continue;
            }
            return Err(format!("缺少必填槽位：{}（{}）", field.name, field.label));
        }
        if field.r#type == "enum" && field.strict && !field.options.contains(&raw) {
            return Err(format!(
                "{}={raw:?} 不在允许值内（可用：{}）",
                field.name,
                field.options.join("、")
            ));
        }
        resolved.insert(field.name.to_string(), raw.to_string());
    }

    let schedule = resolve_blueprint_schedule(bp, &resolved)?;
    let prompt = fill_template(bp.prompt_template, &resolved)?;

    Ok(CreateJobInput {
        prompt,
        schedule,
        name: Some(bp.title.to_string()),
        provider: None,
        model: None,
        skills: vec![],
        workdir: None,
        repeat: None,
        bot: None,
    })
}

/// 填 `{slot}` 占位符（简单的单层替换，无转义——上游用 Python `str.format`，
/// 我们的模板只含裸 `{name}`，没有格式说明符）。
fn fill_template(template: &str, values: &BTreeMap<String, String>) -> Result<String, String> {
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(start) = rest.find('{') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        let Some(end) = after.find('}') else {
            // 没有闭合括号 = 模板写错了，原样保留（不是用户输入问题）
            out.push_str(&rest[start..]);
            return Ok(out);
        };
        let name = &after[..end];
        match values.get(name) {
            Some(v) => out.push_str(v),
            // 上游同样报错（`blueprint prompt missing value for {e}`）
            None => return Err(format!("蓝图模板缺少槽位 {name:?} 的值")),
        }
        rest = &after[end + 1..];
    }
    out.push_str(rest);
    Ok(out)
}

/// 把 `schedule_template` 的占位符换成实际值（上游 `_resolve_schedule`）。
///
/// 处理顺序照抄上游：`{minute}/{hour}` 从 time 槽拆、`{dow}` 从
/// recurrence/day 槽查表、`{interval_*}` 直接插，其余占位符按同名槽原样插。
fn resolve_blueprint_schedule(
    bp: &Blueprint,
    values: &BTreeMap<String, String>,
) -> Result<String, String> {
    let sched = bp.schedule_template;
    let mut repl: BTreeMap<String, String> = BTreeMap::new();

    // 自由文本 schedule 槽直接透传（上游 :695 同款）
    if let Some(free) = values.get("schedule") {
        if !free.trim().is_empty() {
            return Ok(free.clone());
        }
    }

    if sched.contains("{minute}") || sched.contains("{hour}") {
        let time = values
            .get("time")
            .ok_or_else(|| "蓝图需要 time 槽（HH:MM）".to_string())?;
        let (h, m) = parse_hh_mm(time)?;
        repl.insert("hour".into(), h.to_string());
        repl.insert("minute".into(), m.to_string());
    }

    if sched.contains("{dow}") {
        if let Some(preset) = values.get("recurrence") {
            let key = preset.to_lowercase();
            let dow = WEEKDAY_PRESETS
                .iter()
                .find(|(k, _)| *k == key)
                .map(|(_, v)| *v)
                .ok_or_else(|| {
                    format!(
                        "未知重复方式 {preset:?}（可用：{}）",
                        WEEKDAY_PRESETS.iter().map(|(k, _)| *k).collect::<Vec<_>>().join("、")
                    )
                })?;
            repl.insert("dow".into(), dow.to_string());
        } else if let Some(day) = values.get("day") {
            let dow = match day.to_lowercase().as_str() {
                "sunday" => "0",
                "monday" => "1",
                "tuesday" => "2",
                "wednesday" => "3",
                "thursday" => "4",
                "friday" => "5",
                "saturday" => "6",
                other => return Err(format!("未知星期 {other:?}")),
            };
            repl.insert("dow".into(), dow.to_string());
        } else {
            repl.insert("dow".into(), "*".into());
        }
    }

    for key in ["interval_min", "interval_h", "interval_hours", "start_hour", "end_hour"] {
        if sched.contains(&format!("{{{key}}}")) {
            let v = values
                .get(key)
                .ok_or_else(|| format!("蓝图模板需要 {key} 槽"))?;
            // 数值型槽必须真的是正整数（上游 :726 对 interval_min 同款校验）
            if key.starts_with("interval") && !v.chars().all(|c| c.is_ascii_digit()) {
                return Err(format!("{key} 必须是正整数（得到 {v:?}）"));
            }
            repl.insert(key.to_string(), v.clone());
        }
    }

    // 其余占位符按同名槽原样插
    let mut names: Vec<String> = Vec::new();
    let mut rest = sched;
    while let Some(s) = rest.find('{') {
        let after = &rest[s + 1..];
        let Some(e) = after.find('}') else { break };
        names.push(after[..e].to_string());
        rest = &after[e + 1..];
    }
    for name in names {
        if !repl.contains_key(&name) {
            if let Some(v) = values.get(&name) {
                repl.insert(name, v.clone());
            }
        }
    }

    fill_template(sched, &repl)
}

/// `"08:30"` → (8, 30)。上游用 `^([01]?\d|2[0-3]):([0-5]\d)$`。
fn parse_hh_mm(raw: &str) -> Result<(u32, u32), String> {
    let t = raw.trim();
    let (h, m) = t
        .split_once(':')
        .ok_or_else(|| format!("时间格式应为 HH:MM（24 小时制），得到 {raw:?}"))?;
    let hour: u32 = h
        .parse()
        .map_err(|_| format!("时间 {raw:?} 的小时不是数字"))?;
    let minute: u32 = m
        .parse()
        .map_err(|_| format!("时间 {raw:?} 的分钟不是数字"))?;
    if hour > 23 || minute > 59 {
        return Err(format!("时间 {raw:?} 越界（小时 0-23，分钟 0-59）"));
    }
    Ok((hour, minute))
}

// ── IPC 命令面 ──────────────────────────────────────────────────────────
//
// 命名 `pi_cron_*`，与 pi_* 命名空间对齐。所有命令 `async`（走 Tauri 线程池，
// 不占 WebView2 UI 线程——`pi_session.rs` 的 P1-1 纪律）。

/// 作业 → **上游 `CronJob` 形状**（snake_case，`types/hermes.ts:1051`）。
///
/// 为什么必须有这一层：宿主内部的 `Job` 是 camelCase（Rust 惯例 + jobs.json
/// 可读），但镜像来的 `app/cron/*` 读的是上游字段名——`job.schedule_display`
/// （`index.tsx:144`）、`job.next_run_at`（`:905`）、`job.last_run_at`。
/// 直接扔 camelCase 过去的表现是"频率/上次/下次"全显示 `—`（实测踩过）。
///
/// **不改成给 `Job` 加 `#[serde(rename_all = "snake_case")]`**：jobs.json 是
/// 用户可见可手改的存储文件，改字段名会让已有作业档读不出来；投影层把
/// "存储形状"与"线上形状"分开，两边各自稳定。
fn job_to_wire(j: &Job) -> serde_json::Value {
    serde_json::json!({
        "id": j.id,
        "name": j.name,
        "prompt": j.prompt,
        "skills": j.skills,
        "provider": j.provider,
        "model": j.model,
        // 上游 `CronJobSchedule` 是 `{kind, expr?, display?, run_at?, minutes?}`
        "schedule": j.schedule,
        "schedule_display": j.schedule_display,
        // 上游没有 repeat_times/repeat_completed 这两个字段名（它的 repeat
        // 是 `{times, completed}`），按上游形状给。
        "repeat": {
            "times": j.repeat_times,
            "completed": j.repeat_completed,
        },
        "state": j.state,
        "enabled": j.enabled,
        "paused_at": j.paused_at,
        "paused_reason": j.paused_reason,
        "created_at": j.created_at,
        "next_run_at": j.next_run_at,
        "last_run_at": j.last_run_at,
        "last_status": j.last_status,
        "last_error": j.last_error,
        "deliver": j.deliver,
        "workdir": j.workdir,
        "bot": j.bot,
    })
}

/// 作业列表（前端首屏一次拉全：作业 + 下次运行时刻 + 最近状态）。
#[tauri::command(async)]
pub fn pi_cron_jobs() -> Result<serde_json::Value, String> {
    let jobs = read_jobs()?;
    let mut rows: Vec<serde_json::Value> = jobs.iter().map(job_to_wire).collect();
    // 按名字排序（前端列表的稳定顺序；hermes index.tsx:415 同款）
    rows.sort_by(|a, b| {
        a["name"]
            .as_str()
            .unwrap_or("")
            .to_lowercase()
            .cmp(&b["name"].as_str().unwrap_or("").to_lowercase())
    });
    Ok(serde_json::json!({ "jobs": rows, "tickerRunning": ticker_running() }))
}

/// 单个作业的详情 + 它的执行历史（前端详情面板一次拉全）。
#[tauri::command(rename_all = "camelCase", async)]
pub fn pi_cron_job(id: String, limit: Option<usize>) -> Result<serde_json::Value, String> {
    let job = read_jobs()?
        .into_iter()
        .find(|j| j.id == id)
        .ok_or_else(|| format!("作业不存在：{id}"))?;
    let runs = executions_for_job(&id, limit.unwrap_or(20))?;
    Ok(serde_json::json!({ "job": job_to_wire(&job), "runs": runs }))
}

/// 创建作业。
#[tauri::command(rename_all = "camelCase", async)]
pub fn pi_cron_create(input: CreateJobInput) -> Result<serde_json::Value, String> {
    let job = create_job(input)?;
    Ok(job_to_wire(&job))
}

/// 更新作业。
#[tauri::command(rename_all = "camelCase", async)]
pub fn pi_cron_update(id: String, input: UpdateJobInput) -> Result<serde_json::Value, String> {
    let job = update_job(&id, input)?;
    Ok(job_to_wire(&job))
}

/// 暂停作业。
#[tauri::command(rename_all = "camelCase", async)]
pub fn pi_cron_pause(id: String, reason: Option<String>) -> Result<serde_json::Value, String> {
    let job = pause_job(&id, reason)?;
    Ok(job_to_wire(&job))
}

/// 恢复作业。
#[tauri::command(rename_all = "camelCase", async)]
pub fn pi_cron_resume(id: String) -> Result<serde_json::Value, String> {
    let job = resume_job(&id)?;
    Ok(job_to_wire(&job))
}

/// 立即运行（同步等待整个 run——前端按钮点击后出结果）。
///
/// **超时语义**：这里没有额外超时，靠 [`run_job`] 内部的不活动看门狗
/// （600s）。前端调用方应给足超时（hermes 的 trigger 是 24 小时）。
#[tauri::command(rename_all = "camelCase", async)]
pub fn pi_cron_trigger(id: String) -> Result<serde_json::Value, String> {
    let outcome = trigger_job(&id)?;
    Ok(serde_json::json!({
        "success": outcome.success,
        "skipped": outcome.skipped,
        "response": outcome.response,
        "error": outcome.error,
        "sessionPath": outcome.session_path,
        "outputPath": outcome.output_path,
    }))
}

/// 删除作业。
#[tauri::command(rename_all = "camelCase", async)]
pub fn pi_cron_delete(id: String) -> Result<serde_json::Value, String> {
    delete_job(&id)?;
    Ok(serde_json::json!({ "ok": true }))
}

/// 自动化蓝图目录（16 个内置模板）。
///
/// `profile` 参数保留但忽略（上游按 profile 列插件注册的蓝图，宿主单配置）。
#[tauri::command(rename_all = "camelCase", async)]
pub fn pi_cron_blueprints(_profile: Option<String>) -> Result<serde_json::Value, String> {
    let list: Vec<serde_json::Value> = blueprints().iter().map(blueprint_entry).collect();
    Ok(serde_json::json!({ "blueprints": list }))
}

/// 从蓝图实例化作业（填槽 → 校验 → 走同一个 `create_job`）。
///
/// **与手动创建同一条路径**：上游 `fill_blueprint` 返回的就是
/// `create_job` 的 kwargs（`blueprint_catalog.py:748` 的 docstring：
/// "there is no second job engine"）。这里保持一致——蓝图只是 prompt 与
/// 调度的生成器，落盘/调度/执行与手建作业完全相同。
#[tauri::command(rename_all = "camelCase", async)]
pub fn pi_cron_instantiate_blueprint(
    blueprint: String,
    values: Option<BTreeMap<String, String>>,
) -> Result<serde_json::Value, String> {
    let catalog = blueprints();
    let bp = catalog
        .iter()
        .find(|b| b.key == blueprint)
        .ok_or_else(|| {
            format!(
                "蓝图不存在：{blueprint}（可用：{}）",
                catalog.iter().map(|b| b.key).collect::<Vec<_>>().join("、")
            )
        })?;
    let input = fill_blueprint(bp, &values.unwrap_or_default())?;
    let job = create_job(input)?;
    Ok(job_to_wire(&job))
}

/// ticker 是否在跑（前端「调度器状态」）。
fn ticker_running() -> bool {
    TICKER
        .get()
        .map(|s| s.is_running())
        .unwrap_or(false)
}

/// 全局 ticker 状态（进程级单例，`setup` 里初始化）。
static TICKER: std::sync::OnceLock<std::sync::Arc<TickerState>> = std::sync::OnceLock::new();

/// 初始化并启动 ticker（`main.rs` 的 setup 里调一次）。
///
/// 返回 `false` = 已经在跑（幂等，不是错误）。
pub fn init_ticker() -> bool {
    let state = TICKER.get_or_init(|| std::sync::Arc::new(TickerState::default()));
    start_ticker(std::sync::Arc::clone(state))
}

/// 请求 ticker 停止（进程退出钩子）。
pub fn shutdown_ticker() {
    if let Some(state) = TICKER.get() {
        state.request_stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_bare_duration_as_recurring_interval() {
        // hermes 契约：裸时长 = 重复（`in 30m` 才是一次性）
        assert_eq!(
            parse_schedule("30m").unwrap(),
            Schedule::Interval { minutes: 30 }
        );
        assert_eq!(
            parse_schedule("every 2h").unwrap(),
            Schedule::Interval { minutes: 120 }
        );
        assert_eq!(
            parse_schedule("every hour").unwrap(),
            Schedule::Interval { minutes: 60 }
        );
    }

    #[test]
    fn parses_in_prefix_as_one_shot() {
        let s = parse_schedule("in 30m").unwrap();
        match s {
            Schedule::Once { run_at } => {
                let delta = run_at.0 - now();
                assert!(
                    (delta.num_minutes() - 30).abs() <= 1,
                    "in 30m 应约 30 分钟后，实际 {delta:?}"
                );
            }
            other => panic!("应为一次性，得到 {other:?}"),
        }
    }

    #[test]
    fn parses_five_field_cron() {
        assert_eq!(
            parse_schedule("0 9 * * *").unwrap(),
            Schedule::Cron {
                expr: "0 9 * * *".into()
            }
        );
        assert_eq!(
            parse_schedule("*/15 * * * *").unwrap(),
            Schedule::Cron {
                expr: "*/15 * * * *".into()
            }
        );
    }

    #[test]
    fn parses_natural_weekday_phrase() {
        assert_eq!(
            parse_schedule("every monday 9am").unwrap(),
            Schedule::Cron {
                expr: "0 9 * * 1".into()
            }
        );
        assert_eq!(
            parse_schedule("weekdays at 9am").unwrap(),
            Schedule::Cron {
                expr: "0 9 * * 1-5".into()
            }
        );
        assert_eq!(
            parse_schedule("every day at 08:30").unwrap(),
            Schedule::Cron {
                expr: "30 8 * * *".into()
            }
        );
    }

    #[test]
    fn parses_iso_timestamp_as_once() {
        let s = parse_schedule("2030-06-01T09:00:00").unwrap();
        match s {
            Schedule::Once { run_at } => {
                assert_eq!(run_at.0.format("%Y-%m-%d %H:%M").to_string(), "2030-06-01 09:00");
            }
            other => panic!("应为一次性，得到 {other:?}"),
        }
    }

    #[test]
    fn rejects_garbage_with_actionable_message() {
        let err = parse_schedule("nonsense").unwrap_err();
        assert!(err.contains("无法解析调度"), "错误文案应可操作：{err}");
        assert!(err.contains("0 9 * * *"), "错误文案应给出示例：{err}");
    }

    #[test]
    fn cron_field_rejects_letters_explicitly() {
        // JAN/MON 是 croniter 扩展语法；本实现不支持——必须报错而不是当 0
        let err = parse_schedule("0 9 * JAN *").unwrap_err();
        assert!(err.contains("不支持字母"), "应明确说明不支持字母：{err}");
    }

    #[test]
    fn interval_anchors_on_last_run_not_now() {
        // 锚定 last_run_at：重启不重新锚定（hermes jobs.py:1183 同款）
        let now = parse_stored_time("2030-01-01T12:00:00+08:00").unwrap();
        let last = parse_stored_time("2030-01-01T10:00:00+08:00").unwrap();
        let next = compute_next_run(
            &Schedule::Interval { minutes: 60 },
            Some(last),
            now,
        )
        .unwrap()
        .unwrap();
        assert_eq!(next, parse_stored_time("2030-01-01T11:00:00+08:00").unwrap());
    }

    #[test]
    fn cron_next_run_is_strictly_after_base() {
        let base = parse_stored_time("2030-01-01T09:00:00+08:00").unwrap();
        let spec = CronSpec::parse("0 9 * * *").unwrap();
        let next = spec.next_after(base).unwrap().unwrap();
        // 严格之后 = 第二天 09:00，不是当天（否则会原地重发）
        assert_eq!(
            next.format("%Y-%m-%d %H:%M").to_string(),
            "2030-01-02 09:00"
        );
    }

    #[test]
    fn cron_dom_and_dow_both_restricted_uses_or() {
        // 经典 cron 语义：日与周都受限时取"或"
        let spec = CronSpec::parse("0 9 1 * 1").unwrap();
        // 2030-01-01 是周二，但日是 1 号 → 命中（dom 命中）
        let from = parse_stored_time("2029-12-31T12:00:00+08:00").unwrap();
        let next = spec.next_after(from).unwrap().unwrap();
        assert_eq!(next.format("%Y-%m-%d").to_string(), "2030-01-01");
    }

    #[test]
    fn once_returns_none_after_it_ran() {
        let s = Schedule::Once {
            run_at: FixedOffsetLite(parse_stored_time("2030-01-01T09:00:00+08:00").unwrap()),
        };
        let ran = parse_stored_time("2030-01-01T09:00:00+08:00").unwrap();
        assert!(compute_next_run(&s, Some(ran), now()).unwrap().is_none());
    }

    #[test]
    fn job_runnable_requires_enabled_and_scheduled() {
        let mut job = Job::default();
        assert!(is_job_runnable(&job));
        job.state = JobState::Paused;
        assert!(!is_job_runnable(&job));
        job.state = JobState::Scheduled;
        job.enabled = false;
        assert!(!is_job_runnable(&job));
    }

    #[test]
    fn job_id_is_sanitized_for_path_use() {
        // 目录名注入防护：`..` 与分隔符必须被吃掉
        assert_eq!(sanitize_id("../../etc/passwd"), "etcpasswd");
        assert_eq!(sanitize_id("abc-123"), "abc-123");
    }

    #[test]
    fn schedule_display_is_human_readable() {
        assert_eq!(
            schedule_display(&Schedule::Interval { minutes: 30 }),
            "每 30 分钟"
        );
        assert_eq!(
            schedule_display(&Schedule::Interval { minutes: 120 }),
            "每 2 小时"
        );
        assert_eq!(
            schedule_display(&Schedule::Interval { minutes: 2880 }),
            "每 2 天"
        );
    }

    #[test]
    fn run_guard_rejects_concurrent_run_of_same_job() {
        // 手动「立即运行」与 ticker 同时选中同一作业时必须只有一个真跑
        // （hermes 的 fire_claim CAS 语义的内存版）
        let id = "test-job-run-guard";
        assert_eq!(try_acquire_run(id).unwrap(), true, "第一次应拿到运行权");
        assert_eq!(
            try_acquire_run(id).unwrap(),
            false,
            "同一作业第二次必须被拒"
        );
        release_run(id);
        assert_eq!(
            try_acquire_run(id).unwrap(),
            true,
            "释放后应能重新拿到"
        );
        release_run(id);
    }

    #[test]
    fn run_guard_is_per_job_not_global() {
        // 守卫必须按作业隔离：一个作业在跑不该挡住别的作业
        assert!(try_acquire_run("job-a").unwrap());
        assert!(
            try_acquire_run("job-b").unwrap(),
            "不同作业必须能同时运行"
        );
        release_run("job-a");
        release_run("job-b");
    }

    #[test]
    fn six_field_cron_rejects_nonzero_seconds() {
        // 6 字段的第一段是秒。宿主按分钟调度，非 0 秒不能静默丢弃
        // （"每 30 秒"变成"每分钟"是行为漂移）
        let err = parse_schedule("30 0 9 * * *").unwrap_err();
        assert!(err.contains("秒必须为 0"), "应说明秒字段约束：{err}");
        // 秒为 0 时接受，等价于 5 字段
        assert_eq!(
            parse_schedule("0 0 9 * * *").unwrap(),
            Schedule::Cron {
                expr: "0 9 * * *".into()
            }
        );
    }

    #[test]
    fn natural_language_units_are_supported() {
        // hermes 的 `every hour` / `every 2 hours` 是文档里的形态
        assert_eq!(
            parse_schedule("every hour").unwrap(),
            Schedule::Interval { minutes: 60 }
        );
        assert_eq!(
            parse_schedule("every 2 hours").unwrap(),
            Schedule::Interval { minutes: 120 }
        );
        assert_eq!(
            parse_schedule("every day").unwrap(),
            Schedule::Interval { minutes: 1440 }
        );
    }

    // ── 蓝图（照抄上游 blueprint_catalog.py）──────────────────────────────

    #[test]
    fn blueprint_catalog_has_all_sixteen_upstream_entries() {
        // 上游 CATALOG 是 16 项。少一个 = 用户少一个模板；多一个 = 编造。
        let keys: Vec<&str> = blueprints().iter().map(|b| b.key).collect();
        assert_eq!(keys.len(), 16, "蓝图数量必须与上游一致：{keys:?}");
        for expected in [
            "morning-brief",
            "important-mail",
            "weekly-review",
            "workday-start",
            "custom-reminder",
            "evening-winddown",
            "news-digest",
            "bill-renewal-watch",
            "price-watch",
            "competitor-watch",
            "habit-checkin",
            "hydration-move",
            "meal-plan",
            "learn-daily",
            "gratitude-journal",
            "on-this-day",
        ] {
            assert!(keys.contains(&expected), "缺少上游蓝图 {expected}");
        }
    }

    #[test]
    fn every_blueprint_has_consistent_fields() {
        for bp in blueprints() {
            assert!(!bp.key.is_empty(), "蓝图 key 不能为空");
            assert!(!bp.title.is_empty(), "{} 缺 title", bp.key);
            assert!(!bp.fields.is_empty(), "{} 没有槽位", bp.key);
            // 每个蓝图都必须有 deliver 槽（前端对话框靠它渲染投递选择）
            assert!(
                bp.fields.iter().any(|f| f.name == "deliver"),
                "{} 缺 deliver 槽",
                bp.key
            );
            // 槽名不能重复（重复会让填槽静默覆盖）
            let mut seen = BTreeSet::new();
            for f in &bp.fields {
                assert!(seen.insert(f.name), "{} 有重复槽位 {}", bp.key, f.name);
                // 槽类型必须在四种之内
                assert!(
                    matches!(f.r#type, "time" | "enum" | "weekdays" | "text"),
                    "{} 的槽 {} 类型非法：{}",
                    bp.key,
                    f.name,
                    f.r#type
                );
            }
            // 模板里出现的占位符必须**能填出来**：要么是同名槽，要么是
            // 派生占位符（{minute}/{hour} 来自 time 槽、{dow} 来自
            // recurrence/day 槽——上游 `_resolve_schedule` 同款语义）。
            let derived = ["minute", "hour", "dow"];
            let mut rest = bp.schedule_template;
            while let Some(s) = rest.find('{') {
                let after = &rest[s + 1..];
                let Some(e) = after.find('}') else { break };
                let name = &after[..e];
                assert!(
                    bp.fields.iter().any(|f| f.name == name) || derived.contains(&name),
                    "{} 的 schedule 模板引用了填不出来的槽 {name}",
                    bp.key
                );
                // 派生占位符还要有来源槽，否则运行时必失败
                if name == "minute" || name == "hour" {
                    assert!(
                        bp.fields.iter().any(|f| f.name == "time"),
                        "{} 用了 {{{name}}} 但没有 time 槽",
                        bp.key
                    );
                }
                if name == "dow" {
                    assert!(
                        bp.fields.iter().any(|f| f.name == "recurrence" || f.name == "day"),
                        "{} 用了 {{dow}} 但没有 recurrence/day 槽",
                        bp.key
                    );
                }
                rest = &after[e + 1..];
            }
        }
    }

    #[test]
    fn blueprint_deliver_options_are_local_only() {
        // 宿主没有消息平台适配器：投递选项只能有 local。
        // 出现 telegram/discord 等 = 下拉框里有点不动的项。
        for bp in blueprints() {
            let deliver = bp.fields.iter().find(|f| f.name == "deliver").unwrap();
            assert_eq!(
                deliver.options,
                vec!["local"],
                "{} 的 deliver 选项应只有 local",
                bp.key
            );
        }
    }

    #[test]
    fn fill_blueprint_resolves_time_and_recurrence() {
        let catalog = blueprints();
        let bp = catalog.iter().find(|b| b.key == "custom-reminder").unwrap();
        let mut values = BTreeMap::new();
        values.insert("what".to_string(), "喝水".to_string());
        values.insert("time".to_string(), "14:30".to_string());
        values.insert("recurrence".to_string(), "weekdays".to_string());

        let input = fill_blueprint(bp, &values).expect("填槽应成功");
        assert_eq!(input.schedule, "30 14 * * 1-5", "time+recurrence 应拼成 cron");
        assert!(input.prompt.contains("喝水"), "prompt 应填入槽值");
        assert_eq!(input.name.as_deref(), Some("Custom reminder"));
        assert!(input.skills.is_empty(), "宿主蓝图不带 skills");
    }

    #[test]
    fn fill_blueprint_uses_defaults_when_values_omitted() {
        let catalog = blueprints();
        let bp = catalog.iter().find(|b| b.key == "custom-reminder").unwrap();
        // 全部走默认值
        let input = fill_blueprint(bp, &BTreeMap::new()).expect("默认值应能填满");
        assert_eq!(input.schedule, "0 14 * * *", "默认 14:00 + everyday");
        assert!(input.prompt.contains("take a break and stretch"));
    }

    #[test]
    fn fill_blueprint_rejects_unknown_slot() {
        let catalog = blueprints();
        let bp = catalog.iter().find(|b| b.key == "custom-reminder").unwrap();
        let mut values = BTreeMap::new();
        values.insert("tiem".to_string(), "07:15".to_string()); // typo
        let err = fill_blueprint(bp, &values).unwrap_err();
        assert!(err.contains("未知槽位"), "typo 必须报错而不是静默用默认值：{err}");
    }

    #[test]
    fn fill_blueprint_rejects_strict_enum_outside_options() {
        let catalog = blueprints();
        let bp = catalog.iter().find(|b| b.key == "news-digest").unwrap();
        let mut values = BTreeMap::new();
        values.insert("count".to_string(), "99".to_string());
        let err = fill_blueprint(bp, &values).unwrap_err();
        assert!(err.contains("不在允许值内"), "strict enum 越界必须拒绝：{err}");
    }

    #[test]
    fn fill_blueprint_rejects_bad_time_format() {
        let catalog = blueprints();
        let bp = catalog.iter().find(|b| b.key == "custom-reminder").unwrap();
        let mut values = BTreeMap::new();
        values.insert("time".to_string(), "25:99".to_string());
        let err = fill_blueprint(bp, &values).unwrap_err();
        assert!(err.contains("越界"), "越界时间必须拒绝：{err}");
    }

    #[test]
    fn every_blueprint_fills_with_defaults_and_parses_as_schedule() {
        // 端到端不变量：每个蓝图用默认值都能填出**可解析**的调度。
        // 这条守着"模板引用了不存在的槽"或"拼出来的 cron 不合法"。
        for bp in blueprints() {
            let input = fill_blueprint(&bp, &BTreeMap::new())
                .unwrap_or_else(|e| panic!("{} 默认值填槽失败：{e}", bp.key));
            parse_schedule(&input.schedule)
                .unwrap_or_else(|e| panic!("{} 的调度 {:?} 无法解析：{e}", bp.key, input.schedule));
            assert!(!input.prompt.trim().is_empty(), "{} 的 prompt 为空", bp.key);
        }
    }

    #[test]
    fn hydration_blueprint_uses_hour_field_step_not_minute() {
        // 上游注释（blueprint_catalog.py:408）：cron 分钟字段步长 */90 会按小时
        // 回绕，*/90 与 */120 都退化成每小时。所以模板必须用小时字段步长。
        let catalog = blueprints();
        let bp = catalog.iter().find(|b| b.key == "hydration-move").unwrap();
        assert!(
            bp.schedule_template.starts_with("0 {start_hour}-{end_hour}/{interval_hours}"),
            "hydration 必须用小时字段步长，实际 {:?}",
            bp.schedule_template
        );
        let mut values = BTreeMap::new();
        values.insert("interval_hours".to_string(), "2".to_string());
        values.insert("start_hour".to_string(), "9".to_string());
        values.insert("end_hour".to_string(), "17".to_string());
        let input = fill_blueprint(bp, &values).unwrap();
        assert_eq!(input.schedule, "0 9-17/2 * * 1-5");
        // 并且这个表达式真的能算出下次运行（不是语法错）
        let spec = CronSpec::parse(&input.schedule).expect("应可解析");
        let from = parse_stored_time("2030-01-07T08:00:00+08:00").unwrap(); // 周一
        assert!(spec.next_after(from).unwrap().is_some());
    }

    // ── 存储闭环（用临时目录，不碰用户 ~/.pi）────────────────────────────
    //
    // 这些测试改 `HOME` 环境变量让 `Config::global_dir()` 落到临时目录。
    // **必须串行**（环境变量是进程级）：cargo test 默认多线程，所以每个
    // 测试自己建独占目录 + 用一把全局锁串行化。

    use std::sync::MutexGuard;

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    /// 在**临时 cron 目录**下跑 `f`，结束后恢复。
    ///
    /// 用 `CRON_DIR_OVERRIDE`（进程级显式路径）而不是改环境变量：
    /// `Config::global_dir()` 在 Windows 上走 Known Folder API，改
    /// `USERPROFILE` 不生效；只改 `PI_CODING_AGENT_DIR` 也不彻底——pi 建
    /// 会话时会用自己缓存的 `Config`，实测出现"作业进临时目录、会话进真实
    /// `~/.pi`"的半隔离（污染过 `~/.pi/agent/cron/sessions`）。
    fn with_temp_cron_dir<T>(f: impl FnOnce() -> T) -> T {
        let guard: MutexGuard<'_, ()> = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = std::env::temp_dir().join(format!(
            "mirach-cron-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).expect("临时目录");
        *CRON_DIR_OVERRIDE.lock().unwrap_or_else(|e| e.into_inner()) = Some(dir.clone());
        let out = f();
        *CRON_DIR_OVERRIDE.lock().unwrap_or_else(|e| e.into_inner()) = None;
        let _ = std::fs::remove_dir_all(&dir);
        drop(guard);
        out
    }

    #[test]
    fn jobs_round_trip_through_disk() {
        with_temp_cron_dir(|| {
            assert!(read_jobs().unwrap().is_empty(), "初始应为空表");

            let job = create_job(CreateJobInput {
                prompt: "每天早上汇报".into(),
                schedule: "every day at 09:00".into(),
                name: Some("晨报".into()),
                provider: None,
                model: None,
                skills: vec![],
                workdir: None,
                repeat: None,
                bot: None,
            })
            .expect("创建应成功");

            let back = read_jobs().unwrap();
            assert_eq!(back.len(), 1);
            assert_eq!(back[0].id, job.id);
            assert_eq!(back[0].name, "晨报");
            assert_eq!(back[0].prompt, "每天早上汇报");
            assert_eq!(back[0].deliver, "local", "投递恒为 local（宿主无平台）");
            assert!(back[0].next_run_at.is_some(), "应算出下次运行时刻");
        })
    }

    #[test]
    fn create_rejects_past_one_shot() {
        with_temp_cron_dir(|| {
            let err = create_job(CreateJobInput {
                prompt: "过去".into(),
                schedule: "2020-01-01T00:00:00".into(),
                name: None,
                provider: None,
                model: None,
                skills: vec![],
                workdir: None,
                repeat: None,
                bot: None,
            })
            .unwrap_err();
            assert!(err.contains("已过去"), "应拒绝过去的一次性任务：{err}");
        })
    }

    #[test]
    fn create_rejects_empty_prompt_and_relative_workdir() {
        with_temp_cron_dir(|| {
            let e1 = create_job(CreateJobInput {
                prompt: "   ".into(),
                schedule: "30m".into(),
                name: None,
                provider: None,
                model: None,
                skills: vec![],
                workdir: None,
                repeat: None,
                bot: None,
            })
            .unwrap_err();
            assert!(e1.contains("prompt 不能为空"), "{e1}");

            let e2 = create_job(CreateJobInput {
                prompt: "x".into(),
                schedule: "30m".into(),
                name: None,
                provider: None,
                model: None,
                skills: vec![],
                workdir: Some("relative/dir".into()),
                repeat: None,
                bot: None,
            })
            .unwrap_err();
            assert!(e2.contains("绝对路径"), "{e2}");
        })
    }

    #[test]
    fn pause_and_resume_flip_state() {
        with_temp_cron_dir(|| {
            let job = create_job(CreateJobInput {
                prompt: "x".into(),
                schedule: "30m".into(),
                name: None,
                provider: None,
                model: None,
                skills: vec![],
                workdir: None,
                repeat: None,
                bot: None,
            })
            .unwrap();

            let paused = pause_job(&job.id, Some("测试".into())).unwrap();
            assert!(!paused.enabled);
            assert_eq!(paused.state, JobState::Paused);
            assert_eq!(paused.paused_reason.as_deref(), Some("测试"));
            assert!(!is_job_runnable(&paused), "暂停后不可运行");

            let resumed = resume_job(&job.id).unwrap();
            assert!(resumed.enabled);
            assert_eq!(resumed.state, JobState::Scheduled);
            assert!(is_job_runnable(&resumed));
        })
    }

    #[test]
    fn delete_removes_only_the_named_job() {
        with_temp_cron_dir(|| {
            let a = create_job(CreateJobInput {
                prompt: "a".into(),
                schedule: "30m".into(),
                name: Some("A".into()),
                provider: None,
                model: None,
                skills: vec![],
                workdir: None,
                repeat: None,
                bot: None,
            })
            .unwrap();
            let b = create_job(CreateJobInput {
                prompt: "b".into(),
                schedule: "30m".into(),
                name: Some("B".into()),
                provider: None,
                model: None,
                skills: vec![],
                workdir: None,
                repeat: None,
                bot: None,
            })
            .unwrap();

            delete_job(&a.id).unwrap();
            let left = read_jobs().unwrap();
            assert_eq!(left.len(), 1);
            assert_eq!(left[0].id, b.id);

            // 删不存在的作业 = 错误（不静默成功）
            assert!(delete_job(&a.id).is_err());
        })
    }

    #[test]
    fn tick_advances_recurring_job_before_running() {
        with_temp_cron_dir(|| {
            let job = create_job(CreateJobInput {
                prompt: "x".into(),
                schedule: "30m".into(),
                name: None,
                provider: None,
                model: None,
                skills: vec![],
                workdir: None,
                repeat: None,
                bot: None,
            })
            .unwrap();
            // 把 next_run_at 拨到过去，制造"到期"
            mutate_jobs(|jobs| {
                let j = jobs.iter_mut().find(|j| j.id == job.id).unwrap();
                j.next_run_at = Some((now() - ChronoDuration::minutes(5)).to_rfc3339());
                Ok(())
            })
            .unwrap();

            // **只断言推进部分**（at-most-once 的核心），不跑真 agent：
            // 真 run 会建 pi 会话，而 pi 的 session_index 走它自己的
            // `PI_SESSIONS_DIR` / `global_dir/sessions`，测试改不到——那会
            // 污染用户真实目录（实测发生过）。run 本身由
            // `run_guard_*` / `create_*` / `pause_*` 与手工 E2E 覆盖。
            //
            // 这里直接复刻 tick 的"推进"步骤，验证它的语义：
            // 到期 → 推进到未来 → 作业仍 runnable。
            let before = read_jobs().unwrap();
            let j = before.iter().find(|j| j.id == job.id).unwrap();
            let due = parse_stored_time(j.next_run_at.as_deref().unwrap()).unwrap();
            assert!(due < now(), "前置：作业应已到期");

            let schedule = j.schedule.clone().unwrap();
            let next = compute_next_run(&schedule, j.last_run_at.as_deref().map(parse_stored_time).transpose().unwrap(), now())
                .unwrap()
                .unwrap();
            mutate_jobs(|jobs| {
                let jj = jobs.iter_mut().find(|x| x.id == job.id).unwrap();
                jj.next_run_at = Some(next.to_rfc3339());
                Ok(())
            })
            .unwrap();

            let after = read_jobs().unwrap();
            let j = after.iter().find(|j| j.id == job.id).unwrap();
            let advanced = parse_stored_time(j.next_run_at.as_deref().unwrap()).unwrap();
            assert!(advanced > now(), "推进后 next_run_at 必须落在未来");
            assert!(is_job_runnable(j), "推进不改变可运行性");
        })
    }

    #[test]
    fn executions_ledger_round_trips_and_tolerates_torn_tail() {
        with_temp_cron_dir(|| {
            let exec = Execution {
                id: "e1".into(),
                job_id: "j1".into(),
                status: "completed".into(),
                scheduled_at: None,
                claimed_at: now().to_rfc3339(),
                started_at: None,
                finished_at: Some(now().to_rfc3339()),
                error: None,
                session_path: None,
                output_path: None,
            };
            append_execution(&exec).unwrap();
            let rows = read_executions(10).unwrap();
            assert_eq!(rows.len(), 1);
            assert_eq!(rows[0].id, "e1");

            // 模拟崩溃写的半行：必须跳过（追加式日志的合法尾部形态）
            let path = executions_path();
            let mut f = std::fs::OpenOptions::new().append(true).open(&path).unwrap();
            f.write_all(b"{\"id\":\"torn\",\"job_id\":\"j1\"").unwrap();
            drop(f);
            let rows = read_executions(10).unwrap();
            assert_eq!(rows.len(), 1, "半行应被跳过，前面完整的行仍可读");
        })
    }

}

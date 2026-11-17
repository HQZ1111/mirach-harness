//! 讨论策略（hermes `gateway/hosted_room_discussion.py` 的 Rust 移植）。
//!
//! 上游自述：
//! > Deterministic policy for same-gateway hosted-room Discussions.
//! > **Pure (no I/O, transport or model knowledge)**: a frozen local roster plus the
//! > complete typed room log yields **at most one next driver task**. Discussion
//! > coordinates live in deterministic `TaskIdentity` values and typed terminal events
//! > rather than a widened driver payload, so **a restart reconstructs tasks from
//! > durable state**.
//!
//! ## 为什么这份代码必须"纯"
//!
//! 「at most one next task」+「纯函数」两个约束合起来意味着：
//! **同一份日志 + 同一份名册 → 永远算出同一个下一个任务**。重启后重算得到
//! 完全相同的结果，不需要任何持久化的"上次算到哪"。这就是它可以只靠
//! append-only 事件日志工作的原因。
//!
//! task id 是 prompt 的哈希——所以改名房间不该让已持久化的回执变成孤儿
//! （见 `lead` 模块注释里同样的取舍）。
//!
//! ## 移植边界
//!
//! ✅ 本文件：全部常量、`DiscussionLimits` / `DiscussionMember` / `DiscussionRoom` /
//!   `DiscussionDecision` / `EventPlan` 等数据类型、`validate_user_payload`、
//!   `validate_roster`（含 target 校验）、`validate_room`、`is_pass_text`、
//!   `resolve_mentions`、`turn_round`、`_member_actor`、`_require_gateway_actor`、
//!   `member_by_id`、`validate_turn_coordinates`。
//!
//! ⏳ 未移植：`decision()`（需要逐 kind 的事件校验器全家族，约 500 行）、
//!   `PublicationPlan` 的归约、`_terminal_text`。它们建立在上面这些之上。

use serde_json::{Map, Value};

use super::attachments;
use super::common;
use super::store::{MAX_ACTOR_LABEL_CHARS, MAX_ROOM_NAME_CHARS};

// ── 常量（上游逐字）────────────────────────────────────────────────────────

pub const MAX_DISCUSSION_MEMBERS: usize = 6;
pub const MIN_DISCUSSION_MEMBERS: usize = 2;
pub const MAX_DISCUSSION_ROUNDS: i64 = 3;
pub const MAX_DISCUSSION_MESSAGES: i64 = 10;
pub const MAX_DISCUSSION_DELTA_LINES: usize = 24;
pub const MAX_USER_TEXT_BYTES: usize = 64 * 1024;
pub const MAX_MEMBER_TEXT_BYTES: usize = 64 * 1024;

/// `message.user` 的精确字段（附件是可选）。
pub const USER_PAYLOAD_FIELDS: &[&str] = &["text", "thread_id"];

/// 保留的 @ 提及名（不能当成员 handle）。
pub const RESERVED_HANDLES: &[&str] = &["all", "everyone"];

/// `turn.*` 的坐标字段。
pub const TURN_COORDINATE_FIELDS: &[&str] = &[
    "discussion_event_id",
    "member_id",
    "member_index",
    "round_index",
    "task_id",
    "thread_id",
    "turn_id",
];

/// 跨网关字段（成员里出现则报错）。
pub const REMOTE_MEMBER_FIELDS: &[&str] = &[
    "connectionId",
    "connectionKind",
    "connectionLabel",
    "connection_id",
    "connection_kind",
    "connection_label",
    "remoteSource",
    "route",
    "sourceMissing",
    "sourceReachable",
    "sourceScoped",
    "targetProfile",
    "target_profile",
];

// ── 错误 ────────────────────────────────────────────────────────────────────

/// 上游 `DiscussionPolicyError` 家族。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiscussionError {
    /// `validation` | `reconstruction`
    pub code: &'static str,
    pub message: String,
}

impl DiscussionError {
    fn validation(message: impl Into<String>) -> Self {
        Self {
            code: "validation",
            message: message.into(),
        }
    }
}

impl std::fmt::Display for DiscussionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for DiscussionError {}

fn fail<T>(message: impl Into<String>) -> Result<T, DiscussionError> {
    Err(DiscussionError::validation(message))
}

pub type DiscussResult<T> = Result<T, DiscussionError>;

// ── 数据类型 ────────────────────────────────────────────────────────────────

/// 上游 `DiscussionLimits`：每次用户发送的调度上限（与重放校验分开）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DiscussionLimits {
    pub max_rounds: i64,
    pub max_messages: i64,
}

impl Default for DiscussionLimits {
    fn default() -> Self {
        Self {
            max_rounds: MAX_DISCUSSION_ROUNDS,
            max_messages: MAX_DISCUSSION_MESSAGES,
        }
    }
}

impl DiscussionLimits {
    /// 上游 `__post_init__`：两个值都必须 ≥ 1。
    pub fn validate(&self) -> DiscussResult<()> {
        if self.max_rounds < 1 {
            return fail("hosted_rooms.discussion.max_rounds must be a positive integer");
        }
        if self.max_messages < 1 {
            return fail("hosted_rooms.discussion.max_messages must be a positive integer");
        }
        Ok(())
    }
}

/// 成员的 target（local 或 peer）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MemberTarget {
    /// 本网关上的 profile。
    Local { profile: String },
    /// 跨网关 peer。
    Peer {
        peer_id: String,
        installation_id: String,
        profile: String,
        capability_digest: String,
    },
}

impl MemberTarget {
    /// 上游 `_peer_id()`。
    pub fn peer_id(&self) -> Option<&str> {
        match self {
            MemberTarget::Peer { peer_id, .. } => Some(peer_id),
            MemberTarget::Local { .. } => None,
        }
    }

    pub fn profile(&self) -> &str {
        match self {
            MemberTarget::Local { profile } => profile,
            MemberTarget::Peer { profile, .. } => profile,
        }
    }

    pub fn to_json(&self) -> Value {
        match self {
            MemberTarget::Local { profile } => {
                serde_json::json!({"kind": "local", "profile": profile})
            }
            MemberTarget::Peer {
                peer_id,
                installation_id,
                profile,
                capability_digest,
            } => serde_json::json!({
                "kind": "peer",
                "peer_id": peer_id,
                "installation_id": installation_id,
                "profile": profile,
                "capability_digest": capability_digest,
            }),
        }
    }
}

/// 上游 `DiscussionMember`：房间的不可变本地/peer 成员。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiscussionMember {
    pub member_id: String,
    pub profile: String,
    pub handle: String,
    pub display_name: String,
    pub target: MemberTarget,
}

impl DiscussionMember {
    /// 上游 `_member_actor()`：成员在房间日志里的 actor。
    ///
    /// `connection_id` 只在对端成员时出现；`display_name` 只在非空且要求时出现。
    pub fn actor(&self, include_display_name: bool) -> Value {
        let mut map = Map::new();
        map.insert("kind".into(), Value::String("member".into()));
        map.insert("id".into(), Value::String(self.member_id.clone()));
        map.insert("profile".into(), Value::String(self.profile.clone()));
        if let Some(peer_id) = self.target.peer_id() {
            map.insert("connection_id".into(), Value::String(peer_id.to_owned()));
        }
        if include_display_name && !self.display_name.is_empty() {
            map.insert("display_name".into(), Value::String(self.display_name.clone()));
        }
        Value::Object(map)
    }
}

/// 上游 `DiscussionRoom`：一个活跃房间的已校验策略投影。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiscussionRoom {
    pub room_id: String,
    pub name: String,
    pub members: Vec<DiscussionMember>,
    pub gateway_id: String,
    pub authority_epoch: i64,
}

/// 上游 `EventPlan`：一次幂等 append 的计划。
#[derive(Debug, Clone, PartialEq)]
pub struct EventPlan {
    pub event_id: String,
    pub kind: String,
    pub actor: Value,
    pub payload: Value,
    pub authority_gateway_id: String,
    pub authority_epoch: i64,
}

/// 上游 `DiscussionDecision` 的 status。
pub const STATUS_IDLE: &str = "idle";
pub const STATUS_TASK: &str = "task";
pub const STATUS_SETTLED: &str = "settled";
pub const STATUS_BOUNDED: &str = "bounded";
pub const STATUS_ROUTE: &str = "route";

// ── turn id ─────────────────────────────────────────────────────────────────

/// 上游 `_TURN_ID_RE`：`d<source>.r<round>.p<position>.s<seen>.m<hex24>`。
///
/// `turn_round()` 从中取轮次；形状不符返回 `None`。
pub fn turn_round(turn_id: &str) -> Option<i64> {
    // 手写解析（避免 regex 依赖）：
    // d<1-9 digits>.r<digits>.p<0-5>.s<1-9 digits>.m<24 hex>
    let rest = turn_id.strip_prefix('d')?;
    let (source, rest) = take_digits(rest, false)?;
    let _ = source;
    let rest = rest.strip_prefix(".r")?;
    let (round, rest) = take_digits(rest, true)?;
    let rest = rest.strip_prefix(".p")?;
    let (position, rest) = take_digits(rest, true)?;
    // position 必须 0..=5
    if position.parse::<u8>().ok().filter(|p| *p <= 5).is_none() {
        return None;
    }
    let rest = rest.strip_prefix(".s")?;
    let (seen, rest) = take_digits(rest, false)?;
    let _ = seen;
    let rest = rest.strip_prefix(".m")?;
    if rest.len() != 24 || !rest.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()) {
        return None;
    }
    round.parse::<i64>().ok()
}

/// 取前导数字串；`allow_zero` 控制是否允许 `0`（上游 `0|[1-9][0-9]*`）。
fn take_digits(input: &str, allow_zero: bool) -> Option<(&str, &str)> {
    let end = input.find(|c: char| !c.is_ascii_digit()).unwrap_or(input.len());
    if end == 0 {
        return None;
    }
    let digits = &input[..end];
    // 前导零不合法（除单个 "0" 且允许零）
    if digits.len() > 1 && digits.starts_with('0') {
        return None;
    }
    if !allow_zero && digits == "0" {
        return None;
    }
    Some((digits, &input[end..]))
}

// ── 提及解析 ────────────────────────────────────────────────────────────────

/// 从文本里抽出 `@handle`（上游 `_MENTION_RE`）。
///
/// 形状：`@` + 首字符 `[A-Za-z0-9]` + 其后 `[A-Za-z0-9._:-]*`。
pub fn extract_mentions(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let bytes: Vec<char> = text.chars().collect();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != '@' {
            i += 1;
            continue;
        }
        // 下一个字符必须字母数字
        let Some(&first) = bytes.get(i + 1) else {
            break;
        };
        if !first.is_ascii_alphanumeric() {
            i += 1;
            continue;
        }
        let mut handle = String::new();
        handle.push(first);
        let mut j = i + 2;
        while let Some(&c) = bytes.get(j) {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '-') {
                handle.push(c);
                j += 1;
            } else {
                break;
            }
        }
        out.push(handle);
        i = j;
    }
    out
}

/// 上游 `resolve_mentions()`：按冻结名册确定性地解析提及。
///
/// 语义：
/// - 出现 `@all` / `@everyone` → **全员**
/// - 出现已知 handle → 那些成员（按名册顺序）
/// - 没有任何已知提及且 `default_all` → 全员
/// - 否则 → 空（没人被点名）
pub fn resolve_mentions(
    texts: &[&str],
    members: &[DiscussionMember],
    default_all: bool,
) -> Vec<DiscussionMember> {
    let mut mentioned: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    let mut everyone = false;

    for text in texts {
        for handle in extract_mentions(text) {
            let folded = handle.to_lowercase();
            if RESERVED_HANDLES.contains(&folded.as_str()) {
                everyone = true;
            } else if members.iter().any(|m| m.handle.to_lowercase() == folded) {
                mentioned.insert(folded);
            }
        }
    }

    if everyone || (default_all && mentioned.is_empty()) {
        return members.to_vec();
    }
    members
        .iter()
        .filter(|m| mentioned.contains(&m.handle.to_lowercase()))
        .cloned()
        .collect()
}

// ── 校验 ────────────────────────────────────────────────────────────────────

/// 上游 `_identifier` 包装。
fn identifier(value: Option<&Value>, label: &str) -> DiscussResult<String> {
    let Some(s) = value.and_then(Value::as_str) else {
        return fail(format!("invalid {label}"));
    };
    common::identifier(s, label, super::driver::MAX_IDENTIFIER_CHARS, true, None)
        .map_err(|e| DiscussionError::validation(e.0))
}

/// 上游 `_positive_int`。
fn positive_int(value: Option<&Value>, label: &str) -> DiscussResult<i64> {
    let Some(n) = value.and_then(common::json_i64) else {
        return fail(format!("{label} must be a positive integer"));
    };
    common::bounded_int(n, 1, None, &format!("{label} must be a positive integer"))
        .map_err(|e| DiscussionError::validation(e.0))
}

/// 上游 `_zero_based_int`。
fn zero_based_int(value: Option<&Value>, label: &str, maximum: i64) -> DiscussResult<i64> {
    let Some(n) = value.and_then(common::json_i64) else {
        return fail(format!("{label} must be an integer between 0 and {maximum}"));
    };
    common::bounded_int(n, 0, Some(maximum), &format!("{label} must be an integer between 0 and {maximum}"))
        .map_err(|e| DiscussionError::validation(e.0))
}

/// 上游 `_exact_fields`：required 必须齐全、required ∪ optional 之外拒绝。
fn exact_fields(value: &Value, label: &str, required: &[&str], optional: &[&str]) -> DiscussResult<()> {
    common::exact_fields_default(value, label, required, optional)
        .map_err(|e| DiscussionError::validation(e.0))
}

/// 上游 `validate_user_payload()`：校验并归一条 `message.user` payload。
///
/// - `thread_id` 必需且是 identifier
/// - `text` 必须是有界字符串（64KB）
/// - `text` 空白**且**没有附件 → 报错（不能空消息）
/// - `text` 会被 `strip()`
/// - `attachments` 可选，走附件清单校验
pub fn validate_user_payload(value: &Value) -> DiscussResult<Value> {
    exact_fields(value, "user payload", USER_PAYLOAD_FIELDS, &["attachments"])?;
    let Value::Object(map) = value else {
        return fail("invalid user payload");
    };

    let thread_id = identifier(map.get("thread_id"), "thread_id")?;
    let mut normalized = Map::new();
    normalized.insert("thread_id".into(), Value::String(thread_id));

    if let Some(raw_attachments) = map.get("attachments") {
        let entries = attachments::validate_manifest(raw_attachments)
            .map_err(|e| DiscussionError::validation(e.message))?;
        normalized.insert(
            "attachments".into(),
            Value::Array(entries.iter().map(|e| e.to_json()).collect()),
        );
    }

    let Some(text) = map.get("text").and_then(Value::as_str) else {
        return fail("user payload text must be a bounded string");
    };
    if text.len() > MAX_USER_TEXT_BYTES {
        return fail("user payload text must be a bounded string");
    }
    let trimmed = text.trim();
    let has_attachments = normalized.contains_key("attachments");
    if trimmed.is_empty() && !has_attachments {
        return fail("user payload must contain text or attachments");
    }
    normalized.insert("text".into(), Value::String(trimmed.to_owned()));

    Ok(Value::Object(normalized))
}

/// 上游 `_validate_member_target()`：校验成员 target。
fn validate_member_target(
    value: Option<&Value>,
    profile: &str,
    known_profiles: &std::collections::BTreeSet<String>,
    index: usize,
) -> DiscussResult<MemberTarget> {
    let Some(value) = value else {
        // 无 target = 本网关成员；profile 必须是本机已知的
        if !known_profiles.contains(profile) {
            return fail(format!(
                "member {index} profile '{profile}' is not local to this gateway"
            ));
        }
        return Ok(MemberTarget::Local {
            profile: profile.to_owned(),
        });
    };

    let Value::Object(map) = value else {
        return fail(format!("member {index} target must be an object"));
    };

    let kind = map.get("kind").and_then(Value::as_str).unwrap_or("");

    if kind == "local" {
        exact_fields(value, &format!("member {index} local target"), &["kind", "profile"], &[])?;
        let target_profile = common::identifier_unicode(
            map.get("profile").and_then(Value::as_str).unwrap_or(""),
            &format!("member {index} target profile"),
            128,
        )
        .map_err(|e| DiscussionError::validation(e.0))?;
        if target_profile != profile {
            return fail(format!(
                "member {index} local target profile does not match member profile"
            ));
        }
        if !known_profiles.contains(profile) {
            return fail(format!(
                "member {index} profile '{profile}' is not local to this gateway"
            ));
        }
        return Ok(MemberTarget::Local {
            profile: profile.to_owned(),
        });
    }

    if kind == "peer" {
        exact_fields(
            value,
            &format!("member {index} peer target"),
            &["kind", "peer_id", "installation_id", "profile", "capability_digest"],
            &[],
        )?;
        let target_profile = identifier(map.get("profile"), &format!("member {index} target profile"))?;
        if target_profile != profile {
            return fail(format!(
                "member {index} peer target profile does not match member profile"
            ));
        }
        let digest = map.get("capability_digest").and_then(Value::as_str).unwrap_or("");
        if digest.len() != 64
            || !digest
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return fail(format!(
                "member {index} capability_digest must be a sha256 digest"
            ));
        }
        return Ok(MemberTarget::Peer {
            peer_id: identifier(map.get("peer_id"), &format!("member {index} peer_id"))?,
            installation_id: identifier(
                map.get("installation_id"),
                &format!("member {index} installation_id"),
            )?,
            profile: target_profile,
            capability_digest: digest.to_owned(),
        });
    }

    fail(format!("member {index} target kind must be local or peer"))
}

/// 上游 `_validate_member()`：校验一个成员条目。
fn validate_member(
    raw: &Value,
    index: usize,
    known_profiles: &std::collections::BTreeSet<String>,
) -> DiscussResult<DiscussionMember> {
    let Value::Object(map) = raw else {
        return fail(format!("member {index} must be an object"));
    };

    // 跨网关字段一律拒绝（上游 `_REMOTE_MEMBER_FIELDS`）
    let mut remote: Vec<&str> = map
        .keys()
        .map(String::as_str)
        .filter(|k| REMOTE_MEMBER_FIELDS.contains(k))
        .collect();
    if !remote.is_empty() {
        remote.sort_unstable();
        return fail(format!(
            "member {index} contains cross-gateway fields: {}",
            remote.join(", ")
        ));
    }

    exact_fields(
        raw,
        &format!("member {index}"),
        &["member_id", "profile", "handle"],
        &["display_name", "target"],
    )?;

    // 宿主扩展：成员身份字段用 Unicode 标识符（机器人名/群成员名是中文）。
    let member_id = common::identifier_unicode(
        map.get("member_id").and_then(Value::as_str).unwrap_or(""),
        &format!("member {index} id"),
        128,
    )
    .map_err(|e| DiscussionError::validation(e.0))?;
    let profile = common::identifier_unicode(
        map.get("profile").and_then(Value::as_str).unwrap_or(""),
        &format!("member {index} profile"),
        128,
    )
    .map_err(|e| DiscussionError::validation(e.0))?;
    let handle = common::identifier_unicode(
        map.get("handle").and_then(Value::as_str).unwrap_or(""),
        &format!("member {index} handle"),
        128,
    )
    .map_err(|e| DiscussionError::validation(e.0))?;

    let target = validate_member_target(map.get("target"), &profile, known_profiles, index)?;

    let display_name_raw = map.get("display_name");
    let display_name = match display_name_raw {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(_) => return fail(format!("member {index} display_name must be a string")),
    };
    let display_name = display_name.trim().to_owned();
    if display_name.chars().count() > MAX_ACTOR_LABEL_CHARS {
        return fail(format!("member {index} display_name is too long"));
    }

    Ok(DiscussionMember {
        member_id,
        profile,
        handle,
        display_name,
        target,
    })
}

/// 上游 `validate_roster()`：校验 2-6 人的冻结名册。
///
/// 三条唯一性检查（顺序与上游一致）：
/// - target（local 按 profile / peer 按整体）唯一
/// - handle 唯一且不能占用 `all` / `everyone`
/// - member_id 唯一
///
/// 全部比较用 `casefold`（Rust 侧 `to_lowercase`）。
pub fn validate_roster(
    value: &Value,
    local_profiles: &[String],
) -> DiscussResult<Vec<DiscussionMember>> {
    let Value::Array(items) = value else {
        return fail("members must be a list");
    };
    if items.len() < MIN_DISCUSSION_MEMBERS || items.len() > MAX_DISCUSSION_MEMBERS {
        return fail(format!(
            "members must contain between {MIN_DISCUSSION_MEMBERS} and {MAX_DISCUSSION_MEMBERS} entries"
        ));
    }

    let known_profiles: std::collections::BTreeSet<String> = local_profiles
        .iter()
        .map(|p| {
            common::identifier_unicode(p, "local profile", 128)
                .map_err(|e| DiscussionError::validation(e.0))
        })
        .collect::<DiscussResult<_>>()?;

    let mut members = Vec::with_capacity(items.len());
    let mut targets: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    let mut handles: std::collections::BTreeSet<String> =
        RESERVED_HANDLES.iter().map(|h| (*h).to_owned()).collect();
    let mut member_ids: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();

    for (index, raw) in items.iter().enumerate() {
        let member = validate_member(raw, index, &known_profiles)?;

        // target 唯一（canonical JSON 小写比较，与上游 compact_json(..., ensure_ascii=False) 一致）
        let target_key = common::compact_json(&member.target.to_json(), false).to_lowercase();
        if !targets.insert(target_key) {
            let unique = if matches!(member.target, MemberTarget::Local { .. }) {
                "profiles"
            } else {
                "targets"
            };
            return fail(format!("member {unique} must be unique"));
        }

        // handle 唯一且不占用保留名
        if !handles.insert(member.handle.to_lowercase()) {
            return fail("member handles must be unique and cannot reserve @all or @everyone");
        }

        // member_id 唯一
        if !member_ids.insert(member.member_id.to_lowercase()) {
            return fail("member ids must be unique");
        }

        members.push(member);
    }
    Ok(members)
}

/// 上游 `validate_room()`：把房间行投影成严格的同网关策略形状。
pub fn validate_room(value: &Value, local_profiles: &[String]) -> DiscussResult<DiscussionRoom> {
    let Value::Object(map) = value else {
        return fail("room must be an object");
    };

    // 已解散房间不可用于讨论
    if map.get("disbanded_at").is_some_and(|v| !v.is_null()) {
        return fail("room is disbanded");
    }

    let room_id = identifier(map.get("room_id"), "room_id")?;

    let Some(name_raw) = map.get("name").and_then(Value::as_str) else {
        return fail("room name must be a non-empty string");
    };
    let name = name_raw.trim();
    if name.is_empty() {
        return fail("room name must be a non-empty string");
    }
    if name.chars().count() > MAX_ROOM_NAME_CHARS {
        return fail("room name is too long");
    }

    let gateway_id = identifier(map.get("authority_gateway_id"), "authority_gateway_id")?;
    let authority_epoch = positive_int(map.get("authority_epoch"), "authority_epoch")?;
    let members = validate_roster(map.get("members").unwrap_or(&Value::Null), local_profiles)?;

    Ok(DiscussionRoom {
        room_id,
        name: name.to_owned(),
        members,
        gateway_id,
        authority_epoch,
    })
}

/// 上游 `is_pass_text()`：settled 的成员结果是否等于「讨论沉默」。
///
/// 判据：空白，或匹配 `（pass）/ (pass).` 这类形状（忽略大小写）。
pub fn is_pass_text(value: &str) -> bool {
    let text = value.trim();
    if text.is_empty() {
        return true;
    }
    // 手写匹配 `\(?\s*pass\s*\)?\.?`（ignorecase）
    let lower = text.to_lowercase();
    let mut rest = lower.as_str();
    if let Some(stripped) = rest.strip_prefix('(') {
        rest = stripped;
        rest = rest.trim_start();
        let Some(after) = rest.strip_prefix("pass") else {
            return false;
        };
        rest = after.trim_start();
        let Some(after_paren) = rest.strip_prefix(')') else {
            return false;
        };
        rest = after_paren;
        return rest.trim() == "" || rest.trim() == ".";
    }
    // 无左括号：`pass` 或 `pass.`
    if let Some(after) = rest.strip_prefix("pass") {
        let tail = after.trim();
        return tail.is_empty() || tail == ".";
    }
    false
}

/// 上游 `_require_gateway_actor()`：actor 必须是本房间的 gateway。
pub fn require_gateway_actor(actor: &Value, room: &DiscussionRoom, message: &str) -> DiscussResult<()> {
    let kind = actor.get("kind").and_then(Value::as_str);
    let id = actor.get("id").and_then(Value::as_str);
    if kind != Some("gateway") || id != Some(room.gateway_id.as_str()) {
        return fail(message.to_owned());
    }
    Ok(())
}

/// 上游 `_member_by_id()`。成员 id 走 Unicode 标识符（宿主机器人名可为中文）。
pub fn member_by_id<'a>(room: &'a DiscussionRoom, member_id: &Value) -> DiscussResult<&'a DiscussionMember> {
    let normalized = common::identifier_unicode(member_id.as_str().unwrap_or(""), "member_id", 128)
        .map_err(|e| DiscussionError::validation(e.0))?;
    room.members
        .iter()
        .find(|m| m.member_id == normalized)
        .ok_or_else(|| DiscussionError::validation(format!("unknown Discussion member '{normalized}'")))
}

/// 上游 `_validate_turn_coordinates()`：turn 坐标合法性。
pub fn validate_turn_coordinates(payload: &Value, room: &DiscussionRoom) -> DiscussResult<()> {
    let Value::Object(map) = payload else {
        return fail("invalid turn coordinates");
    };
    member_by_id(room, map.get("member_id").unwrap_or(&Value::Null))?;
    zero_based_int(
        map.get("member_index"),
        "member_index",
        (MAX_DISCUSSION_MEMBERS - 1) as i64,
    )?;
    // 上游注释：降低调度预算不应让已发布的高轮次失效，所以只要求非负
    let Some(round_index) = map.get("round_index").and_then(common::json_i64) else {
        return fail("round_index must be a non-negative integer");
    };
    common::bounded_int(round_index, 0, None, "round_index must be a non-negative integer")
        .map_err(|e| DiscussionError::validation(e.0))?;
    for field in ["thread_id", "task_id", "turn_id", "discussion_event_id"] {
        identifier(map.get(field), field)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn member(member_id: &str, profile: &str, handle: &str, target: Value) -> Value {
        json!({
            "member_id": member_id,
            "profile": profile,
            "handle": handle,
            "target": target,
        })
    }

    fn local(profile: &str) -> Value {
        json!({"kind": "local", "profile": profile})
    }

    fn profiles() -> Vec<String> {
        vec!["alice".to_owned(), "bob".to_owned(), "carol".to_owned()]
    }

    fn roster() -> Vec<DiscussionMember> {
        vec![
            DiscussionMember {
                member_id: "m-ada".into(),
                profile: "alice".into(),
                handle: "ada".into(),
                display_name: "Ada".into(),
                target: MemberTarget::Local {
                    profile: "alice".into(),
                },
            },
            DiscussionMember {
                member_id: "m-linus".into(),
                profile: "bob".into(),
                handle: "linus".into(),
                display_name: String::new(),
                target: MemberTarget::Local {
                    profile: "bob".into(),
                },
            },
        ]
    }

    // ── turn_round ────────────────────────────────────────────────────────

    #[test]
    fn parses_turn_round() {
        // d1.r0.p0.s1.m<24 hex>
        let id = format!("d1.r0.p0.s1.m{}", "a".repeat(24));
        assert_eq!(turn_round(&id), Some(0));
        let id = format!("d3.r2.p5.s10.m{}", "0123456789abcdef01234567");
        assert_eq!(turn_round(&id), Some(2));
    }

    #[test]
    fn rejects_bad_turn_shapes() {
        let hex24 = "a".repeat(24);
        // position 越界
        assert_eq!(turn_round(&format!("d1.r0.p6.s1.m{hex24}")), None);
        // 缺段
        assert_eq!(turn_round(&format!("d1.r0.s1.m{hex24}")), None);
        // hex 长度不对
        assert_eq!(turn_round("d1.r0.p0.s1.mabc"), None);
        // 大写 hex 不接受
        assert_eq!(turn_round(&format!("d1.r0.p0.s1.m{}", "A".repeat(24))), None);
        // source 不能为 0
        assert_eq!(turn_round(&format!("d0.r0.p0.s1.m{hex24}")), None);
        // 前导零
        assert_eq!(turn_round(&format!("d01.r0.p0.s1.m{hex24}")), None);
    }

    // ── extract_mentions / resolve_mentions ──────────────────────────────

    #[test]
    fn extracts_mentions_by_shape() {
        assert_eq!(extract_mentions("@ada hi"), vec!["ada"]);
        assert_eq!(
            extract_mentions("hi @ada and @linus.b_x"),
            vec!["ada", "linus.b_x"]
        );
        // @ 后不是字母数字 → 忽略
        assert!(extract_mentions("mail me at @ hi").is_empty());
        assert!(extract_mentions("no mentions").is_empty());
        assert_eq!(extract_mentions("@a@b"), vec!["a", "b"]);
    }

    #[test]
    fn resolve_mentions_to_members() {
        let members = roster();
        let got = resolve_mentions(&["hi @ada"], &members, true);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].member_id, "m-ada");
    }

    #[test]
    fn resolve_mentions_all_reserves() {
        let members = roster();
        for text in ["@all hello", "@everyone hello"] {
            let got = resolve_mentions(&[text], &members, false);
            assert_eq!(got.len(), 2, "@all/@everyone should pick everyone");
        }
    }

    #[test]
    fn resolve_mentions_default_all_when_unaddressed() {
        let members = roster();
        // 无提及 + default_all → 全员
        assert_eq!(resolve_mentions(&["hello"], &members, true).len(), 2);
        // 无提及 + 不 default → 空
        assert!(resolve_mentions(&["hello"], &members, false).is_empty());
    }

    #[test]
    fn resolve_mentions_case_insensitive() {
        let members = roster();
        let got = resolve_mentions(&["@ADA"], &members, false);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].member_id, "m-ada");
    }

    #[test]
    fn resolve_mentions_unknown_handle_yields_nothing() {
        let members = roster();
        // 只 @ 了不存在的人，且不 default_all → 空（没人被点名）
        assert!(resolve_mentions(&["@nobody"], &members, false).is_empty());
        // 但 default_all=true 时也返回空（因为 mentioned 非空？不——unknown 不进 mentioned）
        // 上游：mentioned 只收已知 handle，所以 unknown 等同于"无提及" → default_all 生效
        assert_eq!(resolve_mentions(&["@nobody"], &members, true).len(), 2);
    }

    // ── validate_user_payload ─────────────────────────────────────────────

    #[test]
    fn validates_user_payload() {
        let payload = json!({"text": "  hello  ", "thread_id": "t-1"});
        let normalized = validate_user_payload(&payload).unwrap();
        assert_eq!(normalized["text"], "hello");
        assert_eq!(normalized["thread_id"], "t-1");
    }

    #[test]
    fn rejects_empty_text_without_attachments() {
        assert_eq!(
            validate_user_payload(&json!({"text": "   ", "thread_id": "t-1"}))
                .unwrap_err()
                .message,
            "user payload must contain text or attachments"
        );
    }

    #[test]
    fn accepts_empty_text_with_attachments() {
        let payload = json!({
            "text": "   ",
            "thread_id": "t-1",
            "attachments": [{
                "attachment_id": format!("att_{}", "a".repeat(32)),
                "kind": "file",
                "name": "a.txt",
                "size": 10,
                "mime": "text/plain"
            }]
        });
        let normalized = validate_user_payload(&payload).unwrap();
        assert_eq!(normalized["text"], "");
        assert!(normalized["attachments"].as_array().is_some());
    }

    #[test]
    fn rejects_unknown_payload_fields() {
        assert_eq!(
            validate_user_payload(&json!({"text": "x", "thread_id": "t", "extra": 1}))
                .unwrap_err()
                .message,
            "user payload has unknown fields: extra"
        );
    }

    #[test]
    fn rejects_oversized_text() {
        let big = "x".repeat(MAX_USER_TEXT_BYTES + 1);
        let payload = json!({"text": big, "thread_id": "t-1"});
        assert_eq!(
            validate_user_payload(&payload).unwrap_err().message,
            "user payload text must be a bounded string"
        );
    }

    // ── validate_roster ───────────────────────────────────────────────────

    #[test]
    fn validates_two_member_roster() {
        let value = json!([
            member("m-ada", "alice", "ada", local("alice")),
            member("m-bob", "bob", "bob", local("bob")),
        ]);
        let members = validate_roster(&value, &profiles()).unwrap();
        assert_eq!(members.len(), 2);
        assert_eq!(members[0].handle, "ada");
    }

    #[test]
    fn rejects_single_member_roster() {
        let value = json!([member("m-ada", "alice", "ada", local("alice"))]);
        assert_eq!(
            validate_roster(&value, &profiles()).unwrap_err().message,
            "members must contain between 2 and 6 entries"
        );
    }

    #[test]
    fn rejects_too_many_members() {
        let items: Vec<Value> = (0..=MAX_DISCUSSION_MEMBERS)
            .map(|i| member(&format!("m-{i}"), "alice", &format!("h{i}"), local("alice")))
            .collect();
        assert!(validate_roster(&json!(items), &profiles()).is_err());
    }

    #[test]
    fn rejects_duplicate_handles_and_reserved_names() {
        let value = json!([
            member("m-ada", "alice", "ada", local("alice")),
            member("m-bob", "bob", "ADA", local("bob")),
        ]);
        assert_eq!(
            validate_roster(&value, &profiles()).unwrap_err().message,
            "member handles must be unique and cannot reserve @all or @everyone"
        );

        // 保留名
        let value = json!([
            member("m-ada", "alice", "all", local("alice")),
            member("m-bob", "bob", "bob", local("bob")),
        ]);
        assert!(validate_roster(&value, &profiles()).is_err());
    }

    #[test]
    fn rejects_duplicate_member_ids() {
        let value = json!([
            member("m-dup", "alice", "ada", local("alice")),
            member("m-dup", "bob", "bob", local("bob")),
        ]);
        assert_eq!(
            validate_roster(&value, &profiles()).unwrap_err().message,
            "member ids must be unique"
        );
    }

    #[test]
    fn rejects_duplicate_local_targets() {
        // 两个成员指向同一 local profile
        let value = json!([
            member("m-1", "alice", "a", local("alice")),
            member("m-2", "alice", "b", local("alice")),
        ]);
        assert_eq!(
            validate_roster(&value, &profiles()).unwrap_err().message,
            "member profiles must be unique"
        );
    }

    #[test]
    fn rejects_unknown_local_profile() {
        let value = json!([
            member("m-ada", "zed", "ada", local("zed")),
            member("m-bob", "bob", "bob", local("bob")),
        ]);
        assert_eq!(
            validate_roster(&value, &profiles()).unwrap_err().message,
            "member 0 profile 'zed' is not local to this gateway"
        );
    }

    #[test]
    fn rejects_cross_gateway_fields() {
        let mut m = member("m-ada", "alice", "ada", local("alice"));
        m["route"] = json!("x");
        let value = json!([m, member("m-bob", "bob", "bob", local("bob"))]);
        assert!(validate_roster(&value, &profiles())
            .unwrap_err()
            .message
            .contains("cross-gateway fields"));
    }

    #[test]
    fn accepts_peer_target() {
        let peer = json!({
            "kind": "peer",
            "peer_id": "peer-1",
            "installation_id": "inst-1",
            "profile": "alice",
            "capability_digest": "a".repeat(64)
        });
        let value = json!([
            member("m-ada", "alice", "ada", peer),
            member("m-bob", "bob", "bob", local("bob")),
        ]);
        let members = validate_roster(&value, &profiles()).unwrap();
        assert!(matches!(members[0].target, MemberTarget::Peer { .. }));
        assert_eq!(members[0].target.peer_id(), Some("peer-1"));
    }

    #[test]
    fn rejects_bad_peer_digest() {
        let peer = json!({
            "kind": "peer", "peer_id": "peer-1", "installation_id": "inst-1",
            "profile": "alice", "capability_digest": "nothex"
        });
        let value = json!([
            member("m-ada", "alice", "ada", peer),
            member("m-bob", "bob", "bob", local("bob")),
        ]);
        assert!(validate_roster(&value, &profiles())
            .unwrap_err()
            .message
            .contains("capability_digest"));
    }

    // ── validate_room ─────────────────────────────────────────────────────

    fn room_value() -> Value {
        json!({
            "room_id": "room-1",
            "name": "Team Room",
            "authority_gateway_id": "gw-1",
            "authority_epoch": 1,
            "disbanded_at": null,
            "members": [
                member("m-ada", "alice", "ada", local("alice")),
                member("m-bob", "bob", "bob", local("bob")),
            ]
        })
    }

    #[test]
    fn validates_room() {
        let room = validate_room(&room_value(), &profiles()).unwrap();
        assert_eq!(room.room_id, "room-1");
        assert_eq!(room.name, "Team Room");
        assert_eq!(room.members.len(), 2);
        assert_eq!(room.authority_epoch, 1);
    }

    #[test]
    fn rejects_disbanded_room() {
        let mut value = room_value();
        value["disbanded_at"] = json!(100.0);
        assert_eq!(
            validate_room(&value, &profiles()).unwrap_err().message,
            "room is disbanded"
        );
    }

    #[test]
    fn rejects_bad_room_epoch() {
        let mut value = room_value();
        value["authority_epoch"] = json!(0);
        assert!(validate_room(&value, &profiles()).is_err());
    }

    // ── is_pass_text ──────────────────────────────────────────────────────

    #[test]
    fn detects_pass_text() {
        for text in ["", "   ", "pass", "PASS", "(pass)", "( pass ).", "pass.", " (PASS) "] {
            assert!(is_pass_text(text), "should be pass: {text:?}");
        }
        for text in ["hello", "passed", "(pass extra)", "pass more"] {
            assert!(!is_pass_text(text), "should not be pass: {text:?}");
        }
    }

    // ── member actor ──────────────────────────────────────────────────────

    #[test]
    fn member_actor_includes_optional_fields() {
        let m = &roster()[0];
        let actor = m.actor(true);
        assert_eq!(actor["kind"], "member");
        assert_eq!(actor["id"], "m-ada");
        assert_eq!(actor["profile"], "alice");
        assert_eq!(actor["display_name"], "Ada");
        // local 成员没有 connection_id
        assert!(actor.get("connection_id").is_none());

        // 不要 display_name 时省略
        let actor = m.actor(false);
        assert!(actor.get("display_name").is_none());
    }

    // ── require_gateway_actor ─────────────────────────────────────────────

    #[test]
    fn requires_matching_gateway_actor() {
        let room = DiscussionRoom {
            room_id: "room-1".into(),
            name: "R".into(),
            members: roster(),
            gateway_id: "gw-1".into(),
            authority_epoch: 1,
        };
        assert!(require_gateway_actor(&json!({"kind": "gateway", "id": "gw-1"}), &room, "msg").is_ok());
        assert_eq!(
            require_gateway_actor(&json!({"kind": "gateway", "id": "gw-2"}), &room, "msg")
                .unwrap_err()
                .message,
            "msg"
        );
        assert!(require_gateway_actor(&json!({"kind": "user", "id": "gw-1"}), &room, "msg").is_err());
    }

    // ── validate_turn_coordinates ─────────────────────────────────────────

    #[test]
    fn validates_turn_coordinates() {
        let room = DiscussionRoom {
            room_id: "room-1".into(),
            name: "R".into(),
            members: roster(),
            gateway_id: "gw-1".into(),
            authority_epoch: 1,
        };
        let payload = json!({
            "member_id": "m-ada",
            "member_index": 0,
            "round_index": 2,
            "thread_id": "t-1",
            "task_id": "task-1",
            "turn_id": "turn-1",
            "discussion_event_id": "d-1",
        });
        validate_turn_coordinates(&payload, &room).unwrap();

        // member_index 越界
        let mut bad = payload.clone();
        bad["member_index"] = json!(6);
        assert!(validate_turn_coordinates(&bad, &room).is_err());

        // 未知成员
        let mut bad = payload.clone();
        bad["member_id"] = json!("m-unknown");
        assert!(validate_turn_coordinates(&bad, &room)
            .unwrap_err()
            .message
            .contains("unknown Discussion member"));
    }

    #[test]
    fn constants_match_upstream() {
        assert_eq!(MIN_DISCUSSION_MEMBERS, 2);
        assert_eq!(MAX_DISCUSSION_MEMBERS, 6);
        assert_eq!(MAX_DISCUSSION_ROUNDS, 3);
        assert_eq!(MAX_DISCUSSION_MESSAGES, 10);
        assert_eq!(MAX_USER_TEXT_BYTES, 64 * 1024);
    }
}
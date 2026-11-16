//! 群聊控制面（hermes `gateway/session_group_controls.py` 的移植）。
//!
//! 这是前端 `groups.*` RPC 的**入口契约层**：每个方法的能力要求、参数集、
//! 派发目标。真正的业务在 store / driver / attachments 里。
//!
//! ## 20 个方法（上游 `GROUP_METHODS` + `_FIELDS` 逐条对照）
//!
//! | 方法 | 能力 | 参数 |
//! |---|---|---|
//! | `groups.capabilities` | `session:read` | （无） |
//! | `groups.list` | `session:read` | limit, offset, include_disbanded |
//! | `groups.state` | `session:read` | room_id, include_disbanded |
//! | `groups.log` | `session:read` | room_id, since_seq, limit, include_disbanded |
//! | `groups.create` | `session:control` | room_id, name, members |
//! | `groups.rename` | `session:control` | room_id, event_id, name |
//! | `groups.context` | `session:control` | room_id, event_id, purpose, notes, routing, lead_member_id |
//! | `groups.disband` | `session:control` | room_id, cancel_id |
//! | `groups.send` | `session:submit` | room_id, event_id, payload |
//! | `groups.attachment.upload` | `session:submit` | room_id, upload_id, kind, name, mime, data_base64 |
//! | `groups.attachment.download` | `session:read` | room_id, event_id, attachment_id |
//! | `groups.stop` | `session:control` | room_id, cancel_id |
//! | `groups.continue` | `session:control` | room_id, discussion_event_id |
//! | `groups.retry` | `session:control` | room_id, member_id, task_id, execution_generation |
//! | `groups.discard` | `session:control` | room_id, member_id, task_id, execution_generation |
//! | `groups.approve` | `session:approve` | room_id, member_id, task_id, execution_generation, choice, request_id |
//! | `groups.peer.register` | `session:control` | room_id, member_id, target_url, target_profile, grant, catalog |
//! | `groups.peer.invite` | `session:operator` | room_id, home_install_id, authority_gateway_id, authority_epoch, member_id, ttl_seconds, status_ttl_seconds |
//! | `groups.peer.revoke` | `session:operator` | grant |
//! | `profiles.list` | `session:read` | include_sessions |
//!
//! ## 校验顺序（上游 `dispatch_group_control`，顺序即语义）
//!
//! 1. **能力**：`GROUP_METHODS[method]` 必须在 actor 的 capabilities 里
//! 2. **profile 一致**：`actor.profile_id != authority.profile_id` → `profile_mismatch`
//! 3. **参数集**：方法必须已知，params 必须是对象，且不含 `_FIELDS[method] | {profile}` 之外的键
//! 4. **db 归属**：`db_path.parent == home` → 否则 `profile_mismatch`
//! 5. 可选 `profile` 参数：必须是字符串且匹配 home
//!
//! 任何一步失败都**不进入**业务层。

use serde_json::Value;

/// RPC 拒绝原因（上游 `RuntimeStoreError(reason)` 的 reason 串）。
pub const ERR_PERMISSION_DENIED: &str = "permission_denied";
pub const ERR_PROFILE_MISMATCH: &str = "profile_mismatch";
pub const ERR_INVALID_PARAMS: &str = "invalid_params";

// ── 能力 ────────────────────────────────────────────────────────────────────

/// 上游 `GROUP_METHODS`：方法 → 所需能力。
pub const GROUP_METHODS: &[(&str, &str)] = &[
    ("groups.capabilities", "session:read"),
    ("groups.list", "session:read"),
    ("groups.state", "session:read"),
    ("groups.log", "session:read"),
    ("groups.create", "session:control"),
    ("groups.rename", "session:control"),
    ("groups.context", "session:control"),
    ("groups.disband", "session:control"),
    ("groups.send", "session:submit"),
    ("groups.attachment.upload", "session:submit"),
    ("groups.attachment.download", "session:read"),
    ("groups.stop", "session:control"),
    ("groups.continue", "session:control"),
    ("groups.retry", "session:control"),
    ("groups.discard", "session:control"),
    ("groups.approve", "session:approve"),
    ("groups.peer.register", "session:control"),
    ("groups.peer.invite", "session:operator"),
    ("groups.peer.revoke", "session:operator"),
    // profiles.list 不在 GROUP_METHODS 里走默认 session:read（上游 `get(method, 'session:read')`）
];

/// 上游 `_FIELDS`：方法 → 允许的参数名（不含可选的 `profile`）。
pub const METHOD_FIELDS: &[(&str, &[&str])] = &[
    ("groups.capabilities", &[]),
    ("groups.list", &["limit", "offset", "include_disbanded"]),
    ("groups.state", &["room_id", "include_disbanded"]),
    ("groups.log", &["room_id", "since_seq", "limit", "include_disbanded"]),
    ("groups.create", &["room_id", "name", "members"]),
    ("groups.rename", &["room_id", "event_id", "name"]),
    (
        "groups.context",
        &["room_id", "event_id", "purpose", "notes", "routing", "lead_member_id"],
    ),
    ("groups.disband", &["room_id", "cancel_id"]),
    ("groups.send", &["room_id", "event_id", "payload"]),
    (
        "groups.attachment.upload",
        &["room_id", "upload_id", "kind", "name", "mime", "data_base64"],
    ),
    ("groups.attachment.download", &["room_id", "event_id", "attachment_id"]),
    ("groups.stop", &["room_id", "cancel_id"]),
    ("groups.continue", &["room_id", "discussion_event_id"]),
    ("groups.retry", &["room_id", "member_id", "task_id", "execution_generation"]),
    ("groups.discard", &["room_id", "member_id", "task_id", "execution_generation"]),
    (
        "groups.approve",
        &["room_id", "member_id", "task_id", "execution_generation", "choice", "request_id"],
    ),
    (
        "groups.peer.register",
        &["room_id", "member_id", "target_url", "target_profile", "grant", "catalog"],
    ),
    (
        "groups.peer.invite",
        &[
            "room_id",
            "home_install_id",
            "authority_gateway_id",
            "authority_epoch",
            "member_id",
            "ttl_seconds",
            "status_ttl_seconds",
        ],
    ),
    ("groups.peer.revoke", &["grant"]),
    ("profiles.list", &["include_sessions"]),
];

/// 可选参数名（上游 `{*_FIELDS[method], 'profile'}`）。
pub const OPTIONAL_PROFILE_FIELD: &str = "profile";

// ── 派发目标 ────────────────────────────────────────────────────────────────

/// 方法的实际落点（上游派发分支）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DispatchTarget {
    /// `profiles.list` → `_profiles()`
    Profiles,
    /// `groups.peer.*` → `session_group_peers.dispatch_target`
    Peers,
    /// 其余 → `_group()`
    Group,
}

/// 判定方法的派发目标。
pub fn dispatch_target(method: &str) -> DispatchTarget {
    if method == "profiles.list" {
        return DispatchTarget::Profiles;
    }
    if method.starts_with("groups.peer.") {
        return DispatchTarget::Peers;
    }
    DispatchTarget::Group
}

// ── 校验 ────────────────────────────────────────────────────────────────────

/// 上游 `dispatch_group_control` 的校验结果：通过或拒绝原因。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refusal {
    /// 上游 `RuntimeStoreError` 的 reason。
    pub reason: &'static str,
    /// `Some(false)` = `groups.send` 在用户事件提交前就被拒（`admitted=false` 随错误数据走）。
    pub admitted: Option<bool>,
}

/// 校验上下文（上游从 `connection` 与 `authority` 取的那些字段）。
#[derive(Debug, Clone)]
pub struct DispatchContext<'a> {
    /// 调用方 actor 拥有的能力集合。
    pub actor_capabilities: &'a [String],
    /// 调用方 actor 的 profile id。
    pub actor_profile_id: &'a str,
    /// authority 的 profile id。
    pub authority_profile_id: &'a str,
}

/// 上游 `dispatch_group_control` 的**前四步校验**（能力 / profile / 参数集 / db 归属）。
///
/// 第 5 步（可选 `profile` 参数匹配 home）由 [`validate_profile_param`] 单独做——
/// 它需要文件系统路径解析，宿主侧另有实现。
///
/// 通过返回 `Ok(supplied)`：去掉 `profile` 后的**业务参数**（上游 `supplied`）。
pub fn validate_dispatch(
    method: &str,
    params: &Value,
    ctx: &DispatchContext<'_>,
) -> Result<serde_json::Map<String, Value>, Refusal> {
    // 1) 能力：GROUP_METHODS 未列出的方法按 session:read（上游默认）
    let capability = GROUP_METHODS
        .iter()
        .find(|(name, _)| *name == method)
        .map(|(_, cap)| *cap)
        .unwrap_or("session:read");
    if !ctx.actor_capabilities.iter().any(|c| c == capability) {
        return Err(Refusal {
            reason: ERR_PERMISSION_DENIED,
            admitted: None,
        });
    }

    // 2) profile 一致
    if ctx.actor_profile_id != ctx.authority_profile_id {
        return Err(Refusal {
            reason: ERR_PROFILE_MISMATCH,
            admitted: None,
        });
    }

    // 3) 参数集：方法必须已知、params 必须是对象、键不许越界
    let Some((_, allowed)) = METHOD_FIELDS.iter().find(|(name, _)| *name == method) else {
        return Err(Refusal {
            reason: ERR_INVALID_PARAMS,
            admitted: None,
        });
    };
    let Value::Object(map) = params else {
        return Err(Refusal {
            reason: ERR_INVALID_PARAMS,
            admitted: None,
        });
    };
    for key in map.keys() {
        if key == OPTIONAL_PROFILE_FIELD {
            continue;
        }
        if !allowed.contains(&key.as_str()) {
            return Err(Refusal {
                reason: ERR_INVALID_PARAMS,
                admitted: None,
            });
        }
    }

    // 4) db 归属（`db_path.parent == home`）在宿主侧另做；此处只产出 supplied
    let supplied: serde_json::Map<String, Value> = map
        .iter()
        .filter(|(key, _)| key.as_str() != OPTIONAL_PROFILE_FIELD)
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect();

    Ok(supplied)
}

/// 上游第 5 步：可选 `profile` 参数校验。
///
/// - `None` → 通过（未提供）
/// - `Some(非字符串)` → `invalid_params`
/// - `Some(空串)` → 通过（上游 `if profile and ...`，空串假值跳过）
/// - `Some(非空)` → 必须匹配 home，否则 `profile_mismatch`
///
/// `matches_home` 是宿主侧的判定（上游 `profile_matches_home(profile, home)`）。
pub fn validate_profile_param(
    profile: Option<&Value>,
    matches_home: impl Fn(&str) -> bool,
) -> Result<(), Refusal> {
    let Some(value) = profile else {
        return Ok(());
    };
    let Some(text) = value.as_str() else {
        return Err(Refusal {
            reason: ERR_INVALID_PARAMS,
            admitted: None,
        });
    };
    if text.is_empty() {
        return Ok(());
    }
    if !matches_home(text) {
        return Err(Refusal {
            reason: ERR_PROFILE_MISMATCH,
            admitted: None,
        });
    }
    Ok(())
}

/// 上游 `groups.capabilities` 的返回值形状。
///
/// 上游：`{'methods': list(GROUP_METHODS), 'max_log_limit': rooms.MAX_LOG_LIMIT, ...}`
pub fn capabilities_payload(max_log_limit: i64) -> Value {
    serde_json::json!({
        "methods": GROUP_METHODS.iter().map(|(name, _)| *name).collect::<Vec<_>>(),
        "max_log_limit": max_log_limit,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ctx_with(caps: &[&str]) -> (Vec<String>, DispatchContext<'static>) {
        let caps: Vec<String> = caps.iter().map(|c| (*c).to_owned()).collect();
        // 借用问题：用 leak 让测试简单（只在测试里）
        let leaked: &'static [String] = Box::leak(caps.clone().into_boxed_slice());
        (
            caps,
            DispatchContext {
                actor_capabilities: leaked,
                actor_profile_id: "prof-1",
                authority_profile_id: "prof-1",
            },
        )
    }

    // ── 契约完整性 ────────────────────────────────────────────────────────

    #[test]
    fn all_methods_have_fields_entry() {
        for (name, _) in GROUP_METHODS {
            assert!(
                METHOD_FIELDS.iter().any(|(m, _)| m == name),
                "missing _FIELDS for {name}"
            );
        }
        // profiles.list 有字段但不在 GROUP_METHODS（走默认能力）
        assert!(METHOD_FIELDS.iter().any(|(m, _)| *m == "profiles.list"));
    }

    #[test]
    fn method_count_matches_upstream() {
        // 上游 GROUP_METHODS 19 项 + profiles.list = 20
        assert_eq!(GROUP_METHODS.len(), 19);
        assert_eq!(METHOD_FIELDS.len(), 20);
    }

    #[test]
    fn capabilities_match_upstream() {
        let find = |name: &str| {
            GROUP_METHODS
                .iter()
                .find(|(m, _)| *m == name)
                .map(|(_, c)| *c)
                .unwrap()
        };
        assert_eq!(find("groups.list"), "session:read");
        assert_eq!(find("groups.create"), "session:control");
        assert_eq!(find("groups.send"), "session:submit");
        assert_eq!(find("groups.approve"), "session:approve");
        assert_eq!(find("groups.peer.invite"), "session:operator");
        assert_eq!(find("groups.peer.revoke"), "session:operator");
    }

    // ── 派发目标 ──────────────────────────────────────────────────────────

    #[test]
    fn dispatch_targets() {
        assert_eq!(dispatch_target("profiles.list"), DispatchTarget::Profiles);
        assert_eq!(dispatch_target("groups.peer.register"), DispatchTarget::Peers);
        assert_eq!(dispatch_target("groups.peer.revoke"), DispatchTarget::Peers);
        assert_eq!(dispatch_target("groups.list"), DispatchTarget::Group);
        assert_eq!(dispatch_target("groups.create"), DispatchTarget::Group);
    }

    // ── 校验 1: 能力 ──────────────────────────────────────────────────────

    #[test]
    fn rejects_missing_capability() {
        let (_caps, ctx) = ctx_with(&["session:read"]);
        let err = validate_dispatch("groups.create", &json!({}), &ctx).unwrap_err();
        assert_eq!(err.reason, ERR_PERMISSION_DENIED);
    }

    #[test]
    fn accepts_when_capability_present() {
        let (_caps, ctx) = ctx_with(&["session:control"]);
        assert!(validate_dispatch(
            "groups.create",
            &json!({"room_id": "r1", "name": "R", "members": []}),
            &ctx
        )
        .is_ok());
    }

    #[test]
    fn unknown_method_defaults_to_session_read() {
        // 上游 `get(method, 'session:read')`：未知方法默认需 read
        let (_caps, ctx) = ctx_with(&["session:read"]);
        // 但 _FIELDS 里没有它 → invalid_params（能力先过）
        let err = validate_dispatch("groups.unknown", &json!({}), &ctx).unwrap_err();
        assert_eq!(err.reason, ERR_INVALID_PARAMS);

        // 没有 read 能力时先报 permission_denied
        let (_caps2, ctx2) = ctx_with(&[]);
        let err2 = validate_dispatch("groups.unknown", &json!({}), &ctx2).unwrap_err();
        assert_eq!(err2.reason, ERR_PERMISSION_DENIED);
    }

    // ── 校验 2: profile ───────────────────────────────────────────────────

    #[test]
    fn rejects_profile_mismatch() {
        let (_caps, mut ctx) = ctx_with(&["session:read"]);
        ctx.actor_profile_id = "prof-2";
        let err = validate_dispatch("groups.list", &json!({}), &ctx).unwrap_err();
        assert_eq!(err.reason, ERR_PROFILE_MISMATCH);
    }

    // ── 校验 3: 参数集 ────────────────────────────────────────────────────

    #[test]
    fn rejects_non_object_params() {
        let (_caps, ctx) = ctx_with(&["session:read"]);
        assert_eq!(
            validate_dispatch("groups.list", &json!([]), &ctx)
                .unwrap_err()
                .reason,
            ERR_INVALID_PARAMS
        );
    }

    #[test]
    fn rejects_unknown_param_keys() {
        let (_caps, ctx) = ctx_with(&["session:read"]);
        assert_eq!(
            validate_dispatch("groups.list", &json!({"bogus": 1}), &ctx)
                .unwrap_err()
                .reason,
            ERR_INVALID_PARAMS
        );
    }

    #[test]
    fn allows_profile_key_anywhere() {
        let (_caps, ctx) = ctx_with(&["session:read"]);
        // profile 是可选键，各方法都放行（由第 5 步校验）
        let supplied = validate_dispatch(
            "groups.list",
            &json!({"profile": "alice", "limit": 10}),
            &ctx,
        )
        .unwrap();
        // supplied 里不含 profile
        assert!(!supplied.contains_key("profile"));
        assert_eq!(supplied.get("limit"), Some(&json!(10)));
    }

    #[test]
    fn rejects_params_for_zero_field_method() {
        let (_caps, ctx) = ctx_with(&["session:read"]);
        // groups.capabilities 无参数
        assert!(validate_dispatch("groups.capabilities", &json!({}), &ctx).is_ok());
        assert_eq!(
            validate_dispatch("groups.capabilities", &json!({"x": 1}), &ctx)
                .unwrap_err()
                .reason,
            ERR_INVALID_PARAMS
        );
    }

    // ── 校验 5: 可选 profile ──────────────────────────────────────────────

    #[test]
    fn profile_param_absent_is_ok() {
        assert!(validate_profile_param(None, |_| false).is_ok());
    }

    #[test]
    fn profile_param_non_string_is_invalid() {
        assert_eq!(
            validate_profile_param(Some(&json!(42)), |_| true)
                .unwrap_err()
                .reason,
            ERR_INVALID_PARAMS
        );
    }

    #[test]
    fn profile_param_empty_string_passes() {
        // 上游 `if profile and not matches` → 空串是假值，跳过校验
        assert!(validate_profile_param(Some(&json!("")), |_| false).is_ok());
    }

    #[test]
    fn profile_param_must_match_home() {
        assert!(validate_profile_param(Some(&json!("alice")), |p| p == "alice").is_ok());
        assert_eq!(
            validate_profile_param(Some(&json!("bob")), |p| p == "alice")
                .unwrap_err()
                .reason,
            ERR_PROFILE_MISMATCH
        );
    }

    // ── capabilities 载荷 ─────────────────────────────────────────────────

    #[test]
    fn capabilities_payload_lists_methods() {
        let payload = capabilities_payload(500);
        assert_eq!(payload["max_log_limit"], 500);
        let methods = payload["methods"].as_array().unwrap();
        assert_eq!(methods.len(), GROUP_METHODS.len());
        assert!(methods.iter().any(|m| m == "groups.send"));
    }
}
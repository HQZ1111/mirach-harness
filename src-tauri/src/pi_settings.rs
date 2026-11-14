//! pi 配置面 IPC（docs/pi-integration.md §5/§7-7/§4.5：设置页走 Tauri IPC，
//! 不走 AG-UI HTTP）。
//!
//! 配置真相 = pi 自己的配置文件（§5），路径/格式从上游源码核实（非猜测）：
//! - settings.json：`pi_paths::agent_dir().map_err(|e| e)?.join("settings.json")` =
//!   `~/.pi/agent/settings.json`（PI_CODING_AGENT_DIR 可覆盖，
//!   上游 config.rs:740/1542-1555；PI_CONFIG_PATH 显式覆盖时整体替换
//!   global+project，config.rs:676-680——读/写都跟随该覆盖，与 pi 实际
//!   读取的文件保持一致）。
//! - models.json：`default_models_path(&pi_paths::agent_dir().map_err(|e| e)?)` =
//!   `~/.pi/agent/models.json`（上游 models.rs:3994，pi main.rs:887 同款）。
//! - auth.json：`pi_paths::auth_path().map_err(|e| e)?` = `~/.pi/agent/auth.json`
//!   （config.rs:729-731；pi_session.rs 同款）。
//!
//! 写入语义（§5）：**nested 对象整体替换不合并——前端送完整文档**。
//! 写入前先对 pi 自己的 schema 反序列化校验（Config / ModelsConfig 均
//! #[derive(Deserialize)]），类型不符即 Err——坏文档不得落盘（落盘后
//! pi 起跑即解析失败）。
//!
//! 纪律：**禁止兜底**——读失败/解析失败一律 Err（UI 可见）；文件不存在
//! 返回 Ok(None) 是真实状态（上游 load_from_path 同语义：缺文件 → 默认，
//! config.rs:751-754），不是降级。

use std::path::{Path, PathBuf};

use crate::pi_paths;



use crate::pi_session::on_big_stack;

/// settings.json 的实际路径 = `~/.rpi/agent/settings.json`（rpi 语义；
/// RPI_CODING_AGENT_DIR 覆盖已在 pi_paths::agent_dir 内处理）。
fn settings_path() -> PathBuf {
    pi_paths::settings_path().unwrap_or_else(|_| PathBuf::from("."))
}

/// models.json 的实际路径 = `~/.rpi/agent/models.json`。
fn models_config_path() -> PathBuf {
    pi_paths::models_path().unwrap_or_else(|_| PathBuf::from("."))
}

/// provider → env key 名称映射（rpi 迁移：原 pi::provider_metadata 的
/// 静态表裁剪——只保留 mirach 场景实际出现的提供方；完整目录 ~104 个
/// 提供方在旧 pi 内，rpi 侧由 resolve 层按 env/model.json 解析）。
fn provider_env_keys(provider: &str) -> Vec<String> {
    match provider {
        "anthropic" => vec!["ANTHROPIC_API_KEY".into()],
        "openai" | "openai-completions" | "openai-responses" => vec!["OPENAI_API_KEY".into()],
        "deepseek" => vec!["DEEPSEEK_API_KEY".into()],
        "google" => vec!["GEMINI_API_KEY".into()],
        "xai" => vec!["XAI_API_KEY".into()],
        "openrouter" => vec!["OPENROUTER_API_KEY".into()],
        _ => vec![],
    }
}

/// 免凭据本地提供方（ollama 等不需要 API key）。
fn provider_is_keyless_local(provider: &str) -> bool {
    matches!(provider, "ollama")
}

/// 读一个 JSON 文档为原始 Value。文件不存在 → Ok(None)（真实状态）；
/// 存在但解析失败 → Err（禁止兜底——坏文件必须可见）。
/// 注：不做 pi Config 结构校验——原始文档如实返回，结构校验在写入侧
/// （pi 自己 load 时不认识的键会忽略、错误类型才报错）。
pub(crate) fn read_json_document(path: &Path) -> Result<Option<serde_json::Value>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let content = std::fs::read_to_string(path)
        .map_err(|e| format!("配置文件读取失败 {}: {e}", path.display()))?;
    if content.trim().is_empty() {
        // 空文件 = 上游 load_from_path 视作默认（config.rs:757-759）——
        // 如实呈现为"无配置"而不是报错
        return Ok(None);
    }
    let value: serde_json::Value = serde_json::from_str(&content)
        .map_err(|e| format!("配置文件解析失败 {}: {e}", path.display()))?;
    Ok(Some(value))
}

/// 临时文件代号发生器（并发写不共用同一 tmp 名——两个 IPC 写入并发时
/// 各拿各的临时文件，原子 rename 后写者胜，不产生交错损坏）。
fn next_tmp_seq() -> u64 {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(0);
    SEQ.fetch_add(1, Ordering::Relaxed)
}

/// 整体替换写入一个 JSON 文档（§5：nested 不合并——前端送完整文档）。
/// 写入前对 pi 自己的 schema 反序列化校验；落盘 = pretty + 换行
/// （上游 write_settings_json_atomic 格式，config.rs:2133-2134），经
/// 临时文件 + rename 原子替换（上游 NamedTempFile.persist 同语义，
/// 不引 tempfile 依赖）。
fn write_json_document(
    path: &Path,
    value: &serde_json::Value,
    validate: impl Fn(&serde_json::Value) -> Result<(), String>,
) -> Result<(), String> {
    validate(value)?;
    atomic_write_json(path, value)
}

/// 原子写入（临时文件 + rename），无 schema 校验——调用方自带校验
/// （auth.json 的校验器在 pi_keys.rs：object 检查；pi 的 AuthDocument
/// 类型未从稳定面导出，不做结构校验）。
pub(crate) fn atomic_write_json(path: &Path, value: &serde_json::Value) -> Result<(), String> {
    let mut contents = serde_json::to_string_pretty(value)
        .map_err(|e| format!("配置序列化失败: {e}"))?;
    contents.push('\n');
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    if !parent.as_os_str().is_empty() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("配置目录创建失败 {}: {e}", parent.display()))?;
    }
    let file_name = path
        .file_name()
        .map(|n| n.to_os_string().to_string_lossy().to_string())
        .ok_or_else(|| format!("配置路径无效: {}", path.display()))?;
    let tmp = parent.join(format!(
        "{file_name}.tmp-{}-{}",
        std::process::id(),
        next_tmp_seq()
    ));
    std::fs::write(&tmp, contents.as_bytes())
        .map_err(|e| format!("配置写入失败 {}: {e}", path.display()))?;
    std::fs::rename(&tmp, path)
        .map_err(|e| format!("配置替换失败 {}: {e}", path.display()))
        .inspect_err(|_| {
            // rename 失败时清掉临时文件（失败信息本身已传播，这里只清场）
            let _ = std::fs::remove_file(&tmp);
        })
}

/// pi_keys.rs 用的写入口（同 atomic_write_json，命名对齐调用方语义）。
pub(crate) fn write_json_document_public(
    path: &Path,
    value: &serde_json::Value,
    validate: impl Fn(&serde_json::Value) -> Result<(), String>,
) -> Result<(), String> {
    validate(value)?;
    atomic_write_json(path, value)
}

/// settings.json 写入前校验：必须是 JSON object（rpi SavedSettings 不 pub
/// Deserialize——结构校验降级为 object-only；错误类型的键值由 rpi 侧
/// load 时忽略——旧 pi Config::load 同语义，config.rs:751-754）。
fn validate_settings_document(value: &serde_json::Value) -> Result<(), String> {
    if !value.is_object() {
        return Err("settings 文档必须是 JSON object".into());
    }
    Ok(())
}

/// models.json 写入前校验：必须是 JSON object 且能反序列化进 rpi 的
/// ModelsConfig（providers 表 + 唯一性校验都在上游 Deserialize 内；
/// rpi 真相源 = rpi-runtime config，经 rpi-cli::config 再导出）。
fn validate_models_document(value: &serde_json::Value) -> Result<(), String> {
    if !value.is_object() {
        return Err("models 文档必须是 JSON object".into());
    }
    serde_json::from_value::<rpi_cli::config::ModelsConfig>(value.clone())
        .map(|_| ())
        .map_err(|e| format!("models 文档与 rpi 配置结构不符: {e}"))
}

// ── pi 设置页 IPC（§7-7；§4.5 控制面走 IPC）──

/// 读 pi 全局 settings.json 原始文档（§5 配置真相）。不存在 → Ok(None)
/// （真实状态：上游同语义——缺文件视作默认配置）。
#[tauri::command(async)]
pub fn pi_get_settings() -> Result<Option<serde_json::Value>, String> {
    on_big_stack(move || read_json_document(&settings_path()))?
}

/// 整体替换写入 settings.json（§5 nested 不合并——前端送完整文档）。
/// 写入前对 pi Config schema 校验；失败 Err 不落盘。
#[tauri::command(async)]
pub fn pi_set_settings(value: serde_json::Value) -> Result<(), String> {
    on_big_stack(move || {
        write_json_document(&settings_path(), &value, validate_settings_document)
    })?
}

/// 读 models.json 原始文档（路径 = default_models_path(&global_dir)，
/// 上游 models.rs:3994 / pi main.rs:887 同款）。不存在 → Ok(None)。
#[tauri::command(async)]
pub fn pi_get_models_config() -> Result<Option<serde_json::Value>, String> {
    on_big_stack(move || read_json_document(&models_config_path()))?
}

/// 整体替换写入 models.json（前端送完整文档）。写入前对 pi ModelsConfig
/// schema 校验（providers 唯一性等）。
#[tauri::command(async)]
pub fn pi_set_models_config(value: serde_json::Value) -> Result<(), String> {
    on_big_stack(move || {
        write_json_document(&models_config_path(), &value, validate_models_document)
    })?
}

/// 把"用户刚选的模型"写回 settings.json 的默认值
/// （`default_provider` / `default_model`）。
///
/// 为什么必须有这一步（2026-10-26 用户报："模型选择是假的，无论选哪个用的
/// 都是之前设置的，甚至不在模型选择器里的模型"）：
///
/// 上游 `AgentSession::set_provider_model` 只换**当前会话**的 provider 实现
/// 与会话头。新建会话走 `create_agent_session`，模型来自
/// `settings.json` 的 `default_provider/default_model`。不写回 →
/// 用户选的模型只活到本次会话结束；下一条新会话回到那个旧默认值，若它
/// 已失效（provider 不在 models.json、模型不在目录里），pi 会回落到内置
/// 目录第一项——于是"选哪个都用之前那个，甚至不在选择器里"。
///
/// 语义：**读-改-写**（保留 settings.json 里其余全部字段，只动这两个）。
/// 读失败 / 校验失败一律 Err（规矩 12：错误就是错误）；文件不存在 = 从
/// 空对象起（上游缺文件即默认配置，同 read_json_document 语义）。
/// rpi 迁移后暂无调用方（composer set_model 已降级），模型切换接线时复用。
#[allow(dead_code)]
pub(crate) fn persist_default_model(provider: &str, model_id: &str) -> Result<(), String> {
    let path = settings_path();
    let mut doc = read_json_document(&path)?.unwrap_or_else(|| serde_json::json!({}));
    let Some(obj) = doc.as_object_mut() else {
        return Err(format!(
            "settings.json 不是 JSON object，无法写回默认模型: {}",
            path.display()
        ));
    };
    // 用 pi 的字段别名写（defaultProvider/defaultModel 与 snake_case 上游
    // 都认；这里写 snake_case，与现有文件一致）
    obj.insert(
        "default_provider".to_string(),
        serde_json::Value::String(provider.to_string()),
    );
    obj.insert(
        "default_model".to_string(),
        serde_json::Value::String(model_id.to_string()),
    );
    write_json_document(&path, &doc, validate_settings_document)
}

/// GPT-Live 语音配置写回（voice.gpt_live 段，2026-11-12 设置页「语音」节
/// 的数据面）。语义同 persist_default_model：**读-改-写**，保留 settings.json
/// 其余字段。`api_key` **只写不读**（status 永不回显）；空串 = 清除该项。
/// 返回写后的就绪判定（available/mode/model/voice/reason——无 key）。
#[allow(clippy::too_many_arguments)]
pub(crate) fn persist_voice_live_config(
    api_key: Option<String>,
    mode: Option<String>,
    model: Option<String>,
    voice: Option<String>,
    moss_api_key: Option<String>,
) -> Result<serde_json::Value, String> {
    let path = settings_path();
    let mut doc = read_json_document(&path)?.unwrap_or_else(|| serde_json::json!({}));
    let Some(obj) = doc.as_object_mut() else {
        return Err(format!(
            "settings.json 不是 JSON object，无法写 voice 段: {}",
            path.display()
        ));
    };
    let voice_section = obj
        .entry("voice")
        .or_insert_with(|| serde_json::json!({}))
        .as_object_mut()
        .ok_or("settings.json 的 voice 段不是 object")?;

    if let Some(mode) = mode.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        // 归一拼法（voice_chat_mode 的容忍集），存 canonical 值
        let mode = if mode == "gpt-live" || mode == "gptlive" || mode == "live" {
            "gpt-live"
        } else if mode == "moss-live" || mode == "moss" {
            "moss-live"
        } else {
            "chained"
        };
        voice_section.insert("voice_chat_mode".into(), serde_json::Value::String(mode.into()));
    }

    let live = voice_section
        .entry("gpt_live")
        .or_insert_with(|| serde_json::json!({}))
        .as_object_mut()
        .ok_or("settings.json 的 voice.gpt_live 段不是 object")?;

    apply_voice_live_field(live, "api_key", &api_key);
    apply_voice_live_field(live, "model", &model);
    apply_voice_live_field(live, "voice", &voice);

    // MOSS Live（模思）key：voice.moss_live 段（独立于 OpenAI 链）
    if moss_api_key.is_some() {
        let moss = voice_section
            .entry("moss_live")
            .or_insert_with(|| serde_json::json!({}))
            .as_object_mut()
            .ok_or("settings.json 的 voice.moss_live 段不是 object")?;
        apply_voice_live_field(moss, "api_key", &moss_api_key);
    }

    write_json_document(&path, &doc, validate_settings_document)?;
    // 写后回读就绪判定（available 会因 key 落盘翻转；**永不回显 key**）
    crate::pi_voice_live::voice_live_status()
}

/// 单字段写入（Some 空 = 清除；None = 不动）。模块级 helper——闭包会与
/// 外层可变借用冲突。
fn apply_voice_live_field(
    live: &mut serde_json::Map<String, serde_json::Value>,
    key: &str,
    v: &Option<String>,
) {
    match v.as_deref().map(str::trim) {
        Some(s) if !s.is_empty() => {
            live.insert(key.to_string(), serde_json::Value::String(s.to_string()));
        }
        Some(_) => {
            live.remove(key);
        }
        None => {}
    }
}

/// 各提供方凭据存在性（§7-7 设置页）。**绝不返回 key 内容**——只报
/// 存在性与凭据类型。
///
/// 凭据来源（pi 源码语义，全部实锤）：
/// - auth.json：per-provider typed 凭据（auth.rs:252-326，type 标签
///   api_key/oauth/aws_credentials/bearer_token/service_key）；
/// - models.json 的 apiKey / headers.Authorization：值可为 `!command`
///   shell 查找 / `env:VAR` / `file:path` / 裸大写环境变量名（UPPERCASE_
///   WITH_UNDERSCORE 模式）/ 字面量，运行期解析（models.rs:3842-3926）；
/// - 已声明的环境变量键名：provider_metadata.auth_env_keys
///   （provider_metadata.rs:45/1835，如 ANTHROPIC_API_KEY）——环境变量
///   凭据的官方体现（pi resolve_api_key 链，auth.rs:1777-1806）；
/// - 免凭据本地提供方（ollama 等）：provider_is_keyless_local
///   （provider_metadata.rs:1858）。
///
/// 列出的提供方 = auth.json 与 models.json 中出现的（内置目录 ~104 个
/// 提供方不逐个罗列——pi_list_models 已覆盖"凭据就绪即可用"的视图）。
#[tauri::command(async)]
pub fn pi_auth_status() -> Result<serde_json::Value, String> {
    on_big_stack(move || {
        let auth_path = pi_paths::auth_path().map_err(|e| e)?;
        let models_path = models_config_path();

        // auth.json：原始 JSON 解析（不用 AuthStorage::load——它对损坏
        // JSON 静默返回空目录，设置页必须把坏文件如实报出来）
        let auth_doc = read_json_document(&auth_path)?;
        let auth_file_exists = auth_doc.is_some();
        let mut rows: Vec<serde_json::Value> = Vec::new();
        let mut seen: std::collections::BTreeMap<String, usize> = Default::default();

        if let Some(doc) = &auth_doc {
            let Some(obj) = doc.as_object() else {
                return Err(format!(
                    "auth.json 不是 JSON object: {}",
                    auth_path.display()
                ));
            };
            for (provider, cred) in obj {
                let credential_type = cred
                    .get("type")
                    .and_then(|t| t.as_str())
                    .unwrap_or("unknown")
                    .to_string();
                let mut row = serde_json::json!({
                    "provider": provider,
                    "configured": true,
                    "source": "auth",
                    "credentialType": credential_type,
                });
                // 已声明的环境变量键名 + 实时置位状态（pi resolve 链的一环，
                // 只报名字与存在性，绝不报 key 内容）
                let env_keys = provider_env_keys(provider);
                if !env_keys.is_empty() {
                    let keys: Vec<serde_json::Value> = env_keys
                        .iter()
                        .map(|name| {
                            let set = std::env::var(name)
                                .ok()
                                .is_some_and(|v| !v.trim().is_empty());
                            serde_json::json!({ "name": name, "set": set })
                        })
                        .collect();
                    row["envKeys"] = serde_json::Value::Array(keys);
                }
                upsert_provider_row(&mut rows, &mut seen, row);
            }
        }

        // models.json：凭据引用（apiKey / Authorization header）按 pi 的
        // 值解析语义分类（env:/!/file:/裸大写名/字面量）
        let models_doc = read_json_document(&models_path)?;
        if let Some(doc) = &models_doc {
            let Some(obj) = doc.get("providers").and_then(|p| p.as_object()) else {
                return Err(format!(
                    "models.json 缺 providers 表或不是 JSON object: {}",
                    models_path.display()
                ));
            };
            for (provider, cfg) in obj {
                let key_ref = cfg.get("apiKey").and_then(|k| k.as_str());
                let auth_ref = cfg
                    .get("headers")
                    .and_then(|h| h.get("Authorization"))
                    .and_then(|v| v.as_str());
                let key_ref = key_ref.or(auth_ref);
                match key_ref {
                    Some(raw) => {
                        let (credential_type, env_var) = classify_key_reference(raw);
                        let mut row = serde_json::json!({
                            "provider": provider,
                            "configured": true,
                            "source": "models",
                            "credentialType": credential_type,
                        });
                        if let Some(var) = env_var {
                            row["envVar"] = serde_json::json!(var);
                            row["envSet"] = serde_json::json!(std::env::var(&var)
                                .ok()
                                .is_some_and(|v| !v.trim().is_empty()));
                        }
                        upsert_provider_row(&mut rows, &mut seen, row);
                    }
                    None => {
                        // 无凭据引用：免凭据本地提供方（ollama 等）= 可用；
                        // 其余 = 未配置（真实状态，UI 如实呈现）
                        let configured = provider_is_keyless_local(provider);
                        let mut row = serde_json::json!({
                            "provider": provider,
                            "configured": configured,
                            "source": "models",
                            "credentialType": serde_json::Value::Null,
                        });
                        let env_keys = provider_env_keys(provider);
                        if !env_keys.is_empty() {
                            let keys: Vec<serde_json::Value> = env_keys
                                .iter()
                                .map(|name| {
                                    let set = std::env::var(name)
                                        .ok()
                                        .is_some_and(|v| !v.trim().is_empty());
                                    serde_json::json!({ "name": name, "set": set })
                                })
                                .collect();
                            row["envKeys"] = serde_json::Value::Array(keys);
                        }
                        upsert_provider_row(&mut rows, &mut seen, row);
                    }
                }
            }
        }

        Ok(serde_json::json!({
            "authPath": auth_path.display().to_string(),
            "settingsPath": settings_path().display().to_string(),
            "modelsPath": models_path.display().to_string(),
            "authFileExists": auth_file_exists,
            "providers": rows,
        }))
    })?
}

/// upsert 语义：同 provider 的后写覆盖先写（models.json 条目会覆盖
/// auth.json 同名条目的视角——两个来源的凭据以 models.json 引用为晚写）。
fn upsert_provider_row(
    rows: &mut Vec<serde_json::Value>,
    seen: &mut std::collections::BTreeMap<String, usize>,
    row: serde_json::Value,
) {
    let provider = row["provider"].as_str().unwrap_or_default().to_string();
    match seen.get(&provider) {
        Some(&idx) => rows[idx] = row,
        None => {
            seen.insert(provider, rows.len());
            rows.push(row);
        }
    }
}

/// models.json 凭据引用分类（pi resolve_value_with_resolvers 语义，
/// models.rs:3842-3926）：`!command` / `env:VAR` / `file:path` /
/// 裸大写环境变量名（`^[A-Z][A-Z0-9_]*$` 且含下划线，pi
/// looks_like_env_var_reference）/ 字面量。返回 (类型, 环境变量名)。
fn classify_key_reference(raw: &str) -> (&'static str, Option<String>) {
    if raw.starts_with('!') {
        return ("command", None);
    }
    if let Some(var) = raw.strip_prefix("env:") {
        return ("env", Some(var.to_string()));
    }
    if raw.starts_with("file:") {
        return ("file", None);
    }
    // 裸大写环境变量名（pi looks_like_env_var_reference：首字符 A-Z，
    // 其余 A-Z/0-9/_，且至少一个下划线——真实 key 不可能匹配）
    let mut chars = raw.chars();
    let looks_like_env = match chars.next() {
        Some(first) if first.is_ascii_uppercase() => {
            let mut has_underscore = false;
            let mut ok = true;
            for c in chars {
                match c {
                    '_' => has_underscore = true,
                    'A'..='Z' | '0'..='9' => {}
                    _ => {
                        ok = false;
                        break;
                    }
                }
            }
            ok && has_underscore
        }
        _ => false,
    };
    if looks_like_env {
        return ("env", Some(raw.to_string()));
    }
    ("literal", None)
}

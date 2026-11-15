//! 宿主侧模型目录（models.dev 镜像）——补 rpi 没有内置 registry 的缺口。
//!
//! **不改引擎**：rpi 的 `Model.context_window` 只来自 models.json 的
//! `providers.*.models[].contextWindow`（缺省 0）。这里在宿主补一份公开
//! 目录（https://models.dev/api.json 的 `limit.context`），并在两个消费点
//! 生效：
//! 1. `pi_list_models` 响应：`contextWindow == 0` 时回填 → 设置页/模型
//!    选择器/上下文环拿到真实总量；
//! 2. `build_harness_with` 的 `resolved.model.context_window`：会话构建时
//!    回填 → 引擎的压缩阈值（`should_compact` 只看 >0）也吃到真实窗口。
//!
//! 优先级：models.json 的显式值**永远优先**（用户配置是真相）；目录只补 0。
//! 目录里没有的模型保持"窗口未知"（UI 叠 `?`，不编默认值）。
//!
//! 缓存：`<app_data_dir>/model-registry.json`，启动时后台刷新（TTL 24h）。
//! 离线/首次失败 = 空目录（错误在启动日志可见；不阻塞 UI）。

use std::collections::HashMap;
use std::sync::{OnceLock, RwLock};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

/// models.dev 的公开目录端点。
const CATALOG_URL: &str = "https://models.dev/api.json";
/// 目录 TTL：一天；目录更新不频繁，没必要每次启动都拉。
const TTL_SECS: u64 = 24 * 60 * 60;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct RegistryFile {
    fetched_at: u64,
    /// 归一化 model id（小写、去掉 `provider/` 前缀）→ 上下文窗口（tokens）
    contexts: HashMap<String, u64>,
}

fn state() -> &'static RwLock<RegistryFile> {
    static REGISTRY: OnceLock<RwLock<RegistryFile>> = OnceLock::new();
    REGISTRY.get_or_init(|| RwLock::new(RegistryFile::default()))
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn cache_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir 解析失败: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("app_data_dir 创建失败: {e}"))?;
    Ok(dir.join("model-registry.json"))
}

/// 归一化 model id：取最后一个 `/` 之后的段（models.dev 里同一模型可能带
/// provider 前缀），小写。例：`deepseek/deepseek-v4.1-flash-1017`
/// → `deepseek-v4.1-flash-1017`。
fn normalize_model_id(id: &str) -> String {
    id.rsplit('/')
        .next()
        .unwrap_or(id)
        .trim()
        .to_ascii_lowercase()
}

/// 把 models.dev 目录压平成 id → context。同一 id 在多个 provider 下出现时
/// 取**众数**（同一模型的不同分发可能报 1_000_000 / 1_048_576）；平票取较小
/// 值——压缩阈值宁可保守，不能把 1MiB 写成 1MB 再越界。
fn contexts_from_catalog(catalog: &serde_json::Value) -> HashMap<String, u64> {
    let mut votes: HashMap<String, HashMap<u64, u32>> = HashMap::new();
    let Some(providers) = catalog.as_object() else {
        return HashMap::new();
    };
    for provider in providers.values() {
        let Some(models) = provider.get("models").and_then(|m| m.as_object()) else {
            continue;
        };
        for (raw_id, model) in models {
            let Some(context) = model
                .get("limit")
                .and_then(|l| l.get("context"))
                .and_then(|c| c.as_u64())
                .filter(|c| *c > 0)
            else {
                continue;
            };
            let id = normalize_model_id(raw_id);
            if id.is_empty() {
                continue;
            }
            *votes.entry(id).or_default().entry(context).or_insert(0) += 1;
        }
    }
    votes
        .into_iter()
        .filter_map(|(id, counts)| {
            let picked = counts
                .into_iter()
                .max_by(|a, b| a.1.cmp(&b.1).then(b.0.cmp(&a.0)))
                .map(|(context, _)| context)?;
            Some((id, picked))
        })
        .collect()
}

/// 启动时载入磁盘缓存（同步、无网络）。缓存损坏 = 记日志后按空目录处理
/// （派生数据，不是用户配置——不因缓存坏了拖死启动）。
pub fn init(app: &AppHandle) {
    let path = match cache_path(app) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("[model-registry] 缓存路径解析失败: {e}");
            return;
        }
    };
    match std::fs::read_to_string(&path) {
        Ok(text) => match serde_json::from_str::<RegistryFile>(&text) {
            Ok(file) => {
                if let Ok(mut guard) = state().write() {
                    *guard = file;
                }
            }
            Err(e) => eprintln!(
                "[model-registry] 缓存解析失败（按空目录处理）{}: {e}",
                path.display()
            ),
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => eprintln!("[model-registry] 缓存读取失败 {}: {e}", path.display()),
    }
}

/// 拉取/刷新目录。`force=false` 时 TTL 内直接返回缓存条数。
/// 网络/解析失败 = Err（调用方决定可见性：启动任务打日志，IPC 返回给 UI）。
pub async fn refresh(app: &AppHandle, force: bool) -> Result<usize, String> {
    {
        let guard = state()
            .read()
            .map_err(|_| "模型目录锁中毒".to_string())?;
        if !force
            && !guard.contexts.is_empty()
            && now_secs().saturating_sub(guard.fetched_at) < TTL_SECS
        {
            return Ok(guard.contexts.len());
        }
    }
    let client = reqwest::Client::builder()
        // models.dev/api.json 约 6.6MB；20s 在慢链路上会被截断
        // （"error decoding response body"）。
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| format!("HTTP 客户端创建失败: {e}"))?;
    let response = client
        .get(CATALOG_URL)
        .send()
        .await
        .map_err(|e| format!("模型目录拉取失败（{CATALOG_URL}）: {e}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "模型目录拉取失败：HTTP {}（{CATALOG_URL}）",
            response.status()
        ));
    }
    let text = response
        .text()
        .await
        .map_err(|e| format!("模型目录响应体读取失败: {e}"))?;
    let catalog: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("模型目录解析失败: {e}"))?;
    let contexts = contexts_from_catalog(&catalog);
    let file = RegistryFile {
        fetched_at: now_secs(),
        contexts,
    };
    let count = file.contexts.len();
    {
        let mut guard = state()
            .write()
            .map_err(|_| "模型目录锁中毒".to_string())?;
        *guard = file.clone();
    }
    let path = cache_path(app)?;
    let text = serde_json::to_string(&file).map_err(|e| format!("模型目录序列化失败: {e}"))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text.as_bytes())
        .map_err(|e| format!("模型目录缓存写入失败（{}）: {e}", tmp.display()))?;
    std::fs::rename(&tmp, &path)
        .map_err(|e| format!("模型目录缓存落盘失败（{}）: {e}", path.display()))?;
    Ok(count)
}

/// 精确查表（归一化后）。miss = None（窗口未知，由调用方决定 UI）。
pub fn lookup(model_id: &str) -> Option<u64> {
    let id = normalize_model_id(model_id);
    let guard = state().read().ok()?;
    guard.contexts.get(&id).copied()
}

/// 当前缓存状态（fetched_at 秒级 unix；count）。
pub fn status() -> (u64, usize) {
    match state().read() {
        Ok(guard) => (guard.fetched_at, guard.contexts.len()),
        Err(_) => (0, 0),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn contexts_use_mode_and_normalize_prefix() {
        let catalog = json!({
            "a": { "models": {
                "deepseek/deepseek-v4.1-flash-1017": { "limit": { "context": 1_000_000 } },
                "deepseek/deepseek-v4.1-flash-1017-thinking": { "limit": { "context": 1_000_000 } }
            }},
            "b": { "models": {
                "deepseek-v4.1-flash-1017": { "limit": { "context": 1_000_000 } }
            }},
            "c": { "models": {
                "DeepSeek-V4.1-Flash-1017": { "limit": { "context": 1_048_576 } }
            }},
            "d": { "models": { "no-context": { "limit": { "context": 0 } } } }
        });
        let map = contexts_from_catalog(&catalog);
        // 1_000_000 ×3（a 的两条 + b）> 1_048_576 ×1 → 众数 1_000_000
        assert_eq!(map.get("deepseek-v4.1-flash-1017"), Some(&1_000_000));
        assert!(!map.contains_key("no-context"));
    }

    #[test]
    fn tie_breaks_to_smaller_context() {
        let catalog = json!({
            "a": { "models": { "m": { "limit": { "context": 200_000 } } } },
            "b": { "models": { "m": { "limit": { "context": 1_000_000 } } } }
        });
        assert_eq!(contexts_from_catalog(&catalog).get("m"), Some(&200_000));
    }

    #[test]
    fn malformed_catalog_yields_empty_map() {
        assert!(contexts_from_catalog(&json!("nope")).is_empty());
        assert!(contexts_from_catalog(&json!({ "p": { "models": [] } })).is_empty());
    }

    #[test]
    fn normalize_strips_provider_prefix_and_lowercases() {
        assert_eq!(
            normalize_model_id("Provider/DeepSeek-V4.1-Flash-1017"),
            "deepseek-v4.1-flash-1017"
        );
        assert_eq!(normalize_model_id("  plain-id  "), "plain-id");
    }
}

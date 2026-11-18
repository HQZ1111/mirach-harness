//! `pet.gallery` / `pet.thumb`（2026-11-18）：hermes `agent/pet/*` 的宿主对偶。
//!
//! - gallery = petdex 公共 manifest（`https://petdex.dev/api/manifest`，UA 与
//!   上游一致），300s 进程内缓存；`installed` = `~/.rpi/agent/pets/<slug>/pet.json`
//!   存在（本地已装优先排序由插件做）。
//! - thumb = 已装 spritesheet（磁盘）否则仅接受 petdex.dev 主机 URL
//!   （上游 `_is_petdex_host` 同款反 SSRF），裁首帧 192×208 → 96×104 NEAREST，
//!   PNG data URI；磁盘缓存 `pets/.thumbs/<slug>.png`（上游同位置）。
//!
//! 规矩 12：manifest/下载/解码失败全部 Err（插件侧会把失败 tile 置空并重试，
//! 但宿主从不假装成功）；`ok:false` 只用于"该 slug 既未安装也没有可抓 URL"。

use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use base64::Engine;
use serde_json::{json, Value};

use crate::pi_session::on_big_stack;

const MANIFEST_URL: &str = "https://petdex.dev/api/manifest";
const MANIFEST_TTL: Duration = Duration::from_secs(300);
const USER_AGENT: &str = "hermes-agent-petdex";
const FRAME_W: u32 = 192;
const FRAME_H: u32 = 208;
const THUMB_W: u32 = 96;
const THUMB_H: u32 = 104;

fn pets_dir() -> Result<PathBuf, String> {
    Ok(crate::pi_paths::agent_dir()?.join("pets"))
}

fn safe_slug(raw: &str) -> Option<&str> {
    let slug = raw.trim();
    if slug.is_empty()
        || slug == "."
        || slug == ".."
        || slug.contains('/')
        || slug.contains('\\')
    {
        return None;
    }
    Some(slug)
}

/// 上游 `_is_petdex_host`：只放行 petdex.dev / *.petdex.dev。
fn petdex_host_ok(url: &str) -> bool {
    let Ok(parsed) = reqwest::Url::parse(url) else {
        return false;
    };
    let Some(host) = parsed.host_str() else {
        return false;
    };
    let host = host.to_lowercase();
    host == "petdex.dev" || host.ends_with(".petdex.dev")
}

fn client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| format!("pet: HTTP 客户端构建失败: {e}"))
}

fn installed_pets() -> Vec<String> {
    let Ok(dir) = pets_dir() else {
        return Vec::new();
    };
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    entries
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.path().join("pet.json").is_file())
        .filter_map(|entry| entry.file_name().into_string().ok())
        .collect()
}

fn manifest_cache() -> &'static Mutex<Option<(Instant, Vec<Value>)>> {
    static CELL: OnceLock<Mutex<Option<(Instant, Vec<Value>)>>> = OnceLock::new();
    CELL.get_or_init(|| Mutex::new(None))
}

fn fetch_manifest() -> Result<Vec<Value>, String> {
    {
        let guard = manifest_cache().lock().expect("pet manifest cache poisoned");
        if let Some((fetched_at, pets)) = guard.as_ref() {
            if fetched_at.elapsed() < MANIFEST_TTL {
                return Ok(pets.clone());
            }
        }
    }
    let response = client()?
        .get(MANIFEST_URL)
        .header(reqwest::header::USER_AGENT, USER_AGENT)
        .send()
        .map_err(|e| format!("pet.gallery: GET {MANIFEST_URL} 失败: {e}"))?;
    let status = response.status();
    let body = response.text().unwrap_or_default();
    if !status.is_success() {
        return Err(format!(
            "pet.gallery: GET {MANIFEST_URL} → {status}: {}",
            body.chars().take(200).collect::<String>()
        ));
    }
    let payload: Value =
        serde_json::from_str(&body).map_err(|e| format!("pet.gallery: manifest 不是 JSON: {e}"))?;
    let rows = payload
        .get("pets")
        .and_then(Value::as_array)
        .ok_or_else(|| "pet.gallery: manifest 缺 pets 数组".to_string())?;
    let installed = installed_pets();
    let pets: Vec<Value> = rows
        .iter()
        .filter_map(|row| {
            let slug = row.get("slug").and_then(Value::as_str)?.trim();
            if slug.is_empty() {
                return None;
            }
            let display_name = row
                .get("displayName")
                .and_then(Value::as_str)
                .filter(|name| !name.is_empty())
                .unwrap_or(slug);
            let spritesheet = row
                .get("spritesheetUrl")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            Some(json!({
                "slug": slug,
                "displayName": display_name,
                "spritesheetUrl": spritesheet,
                "installed": installed.iter().any(|name| name == slug),
                "curated": false,
            }))
        })
        .collect();
    *manifest_cache()
        .lock()
        .expect("pet manifest cache poisoned") = Some((Instant::now(), pets.clone()));
    Ok(pets)
}

fn local_sheet(slug: &str) -> Option<PathBuf> {
    let dir = pets_dir().ok()?.join(slug);
    if !dir.is_dir() {
        return None;
    }
    if let Ok(raw) = std::fs::read_to_string(dir.join("pet.json")) {
        if let Ok(meta) = serde_json::from_str::<Value>(&raw) {
            if let Some(name) = meta.get("spritesheetPath").and_then(Value::as_str) {
                let path = dir.join(name);
                if path.is_file() {
                    return Some(path);
                }
            }
        }
    }
    for name in ["spritesheet.png", "spritesheet.webp"] {
        let path = dir.join(name);
        if path.is_file() {
            return Some(path);
        }
    }
    None
}

fn thumb_cache_path(slug: &str) -> Result<PathBuf, String> {
    let dir = pets_dir()?.join(".thumbs");
    std::fs::create_dir_all(&dir).map_err(|e| format!("pet.thumb: 缓存目录创建失败: {e}"))?;
    Ok(dir.join(format!("{slug}.png")))
}

fn sheet_bytes(slug: &str, source_url: &str) -> Result<Vec<u8>, String> {
    if let Some(path) = local_sheet(slug) {
        return std::fs::read(&path).map_err(|e| format!("pet.thumb: 本地 spritesheet 读取失败: {e}"));
    }
    if source_url.trim().is_empty() {
        return Err("pet.thumb: 该 pet 未安装且没有 spritesheet URL".into());
    }
    if !petdex_host_ok(source_url) {
        return Err(format!("pet.thumb: 拒绝非 petdex 主机: {source_url}"));
    }
    let response = client()?
        .get(source_url)
        .header(reqwest::header::USER_AGENT, USER_AGENT)
        .send()
        .map_err(|e| format!("pet.thumb: 下载 spritesheet 失败: {e}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("pet.thumb: 下载 spritesheet → {status}"));
    }
    let bytes = response
        .bytes()
        .map_err(|e| format!("pet.thumb: 读取 spritesheet 失败: {e}"))?;
    Ok(bytes.to_vec())
}

fn render_thumb_from(slug: &str, source_url: &str) -> Result<Vec<u8>, String> {
    let bytes = sheet_bytes(slug, source_url)?;
    let image = image::load_from_memory(&bytes)
        .map_err(|e| format!("pet.thumb: spritesheet 解码失败: {e}"))?
        .to_rgba8();
    let frame_w = image.width().min(FRAME_W);
    let frame_h = image.height().min(FRAME_H);
    if frame_w == 0 || frame_h == 0 {
        return Err("pet.thumb: spritesheet 尺寸为空".into());
    }
    let frame = image::imageops::crop_imm(&image, 0, 0, frame_w, frame_h).to_image();
    let thumb = image::imageops::resize(&frame, THUMB_W, THUMB_H, image::imageops::FilterType::Nearest);
    let mut out = Cursor::new(Vec::new());
    thumb
        .write_to(&mut out, image::ImageFormat::Png)
        .map_err(|e| format!("pet.thumb: PNG 编码失败: {e}"))?;
    Ok(out.into_inner())
}

/// IPC：整册画廊（petdex manifest + 本地 installed 标记）。
#[tauri::command(rename_all = "camelCase", async)]
pub fn pi_pet_gallery() -> Result<Value, String> {
    on_big_stack(move || {
        let pets = fetch_manifest()?;
        Ok(json!({ "enabled": true, "pets": pets }))
    })?
}

/// IPC：单个 pet 的首帧缩略图（data URI）。
#[tauri::command(rename_all = "camelCase", async)]
pub fn pi_pet_thumb(slug: String, url: Option<String>) -> Result<Value, String> {
    on_big_stack(move || {
        let slug = safe_slug(&slug).ok_or_else(|| "pet.thumb: slug 非法".to_string())?;
        let cache = thumb_cache_path(slug)?;
        let png = if cache.is_file() {
            std::fs::read(&cache).map_err(|e| format!("pet.thumb: 缓存读取失败: {e}"))?
        } else {
            let png = render_thumb_from(slug, url.as_deref().unwrap_or(""))?;
            let _ = std::fs::write(&cache, &png);
            png
        };
        Ok(json!({
            "ok": true,
            "slug": slug,
            "dataUri": format!(
                "data:image/png;base64,{}",
                base64::engine::general_purpose::STANDARD.encode(&png)
            ),
        }))
    })?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slug_rejects_traversal() {
        assert_eq!(safe_slug(" cat "), Some("cat"));
        assert_eq!(safe_slug(""), None);
        assert_eq!(safe_slug(".."), None);
        assert_eq!(safe_slug("a/b"), None);
        assert_eq!(safe_slug("a\\b"), None);
    }

    #[test]
    fn petdex_host_bounds_ssrf() {
        assert!(petdex_host_ok("https://petdex.dev/x.webp"));
        assert!(petdex_host_ok("https://cdn.petdex.dev/a/b.png"));
        assert!(!petdex_host_ok("https://evil.example.com/x.webp"));
        assert!(!petdex_host_ok("https://petdex.dev.evil.com/x"));
        assert!(!petdex_host_ok("not a url"));
    }

    #[test]
    fn thumb_geometry_preserves_frame_aspect() {
        assert_eq!(THUMB_W, 96);
        assert_eq!(THUMB_H, 104);
        // 96×104 与 192×208 同比例（交叉相乘）。
        assert_eq!(THUMB_H * FRAME_W, FRAME_H * THUMB_W);
    }
}

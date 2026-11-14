//! 个性（persona）配置面 IPC —— OpenHuman「设置 → 个性」的宿主移植
//! （2026-10-26 用户："把 openhuman 设置里的个性完整，全链路复制，设置里的
//! 个性页做成一样的"）。
//!
//! ## 上游形状（openhuman，逐项对照）
//!
//! - `settings/panels/PersonaPanel.tsx`（343 行）= 页壳：身份卡（显示名 +
//!   描述）+ 模板卡 + 角色卡（guided 字段 / advanced 原文编辑器）+ 单一
//!   保存条。
//! - `settings/panels/persona/personaSections.ts` = SOUL.md ⇄ 结构化字段的
//!   无损往返（`parsePersonaFields` / `applyPersonaField`，只 splice 受管
//!   小节，其余字节不动）。
//! - `settings/panels/persona/personaTemplates.ts` = 六个角色起点
//!   （doctor / researcher / executive / teacher / student / family）。
//! - `settings/panels/persona/PersonaGuidedFields.tsx` = 三个字段
//!   （personality / voice / about）。
//! - `services/api/personaFilesApi.ts` → core RPC
//!   `openhuman.workspace_file_{read,write,reset}`（只允许 SOUL.md /
//!   IDENTITY.md，256 KiB 上限，缺失时回落到 bundled default）。
//!
//! ## 宿主映射（**不照抄 openhuman 的 workspace 概念**）
//!
//! openhuman 把 SOUL.md 放在它自己的 workspace 目录里，由 core 的
//! workspace_file_* RPC 管。本宿主没有那个 workspace——pi 也没有 SOUL 概念。
//! 所以落点是 **`~/.pi/agent/SOUL.md`**（与 settings.json / models.json /
//! auth.json 同目录，pi 的 global_dir），并由宿主在每次建会话时把内容注入
//! `SessionOptions.append_system_prompt`。
//!
//! **身份两字段（displayName / description）落在哪里**：上游放 redux
//! localStorage。宿主同样放 localStorage（前端 `lib/persona-store.ts`），
//! 因为它们是"应用里怎么显示这个助手"的界面字段，不是模型输入——放进
//! SOUL.md 会让它们变成提示词的一部分，语义就变了。
//!
//! ## 纪律
//!
//! - 读：文件缺失 → 返回 bundled 默认 + `isDefault: true`（上游同语义：
//!   新装未 init 时也能编辑）；超过 256 KiB → **Err**（不截断、不静默）。
//! - 写：校验 UTF-8 与上限，原子替换（tmp + rename）。
//! - 重置：写回 bundled 默认。
//! - 绝不吞错误（AGENTS.md 规矩 12）。

use std::path::PathBuf;

use crate::pi_session::on_big_stack;

/// 与上游 `MAX_WORKSPACE_FILE_BYTES` 同值（256 KiB）。SOUL.md 是散文提示词，
/// 以 KB 计；这个上限同时挡住 UI 的误粘贴与磁盘上被别的进程塞进去的巨文件。
pub const MAX_PERSONA_FILE_BYTES: u64 = 256 * 1024;

/// 可编辑的个性文件名（上游 allowlist 只有 SOUL.md / IDENTITY.md；宿主
/// 只用 SOUL.md —— IDENTITY.md 是 openhuman 的第二个提示文件，pi 侧没有
/// 对应注入点，不造假入口）。
pub const PERSONA_FILE_SOUL: &str = "SOUL.md";

/// 随包默认 SOUL.md（首次打开 / 重置时用）。
///
/// 上游默认是 OpenHuman 的自述（"You are OpenHuman, the user's AI teammate
/// on their own machine…"）。宿主按同一结构换成 Mirach，并保留"直接、不
/// 猜、失败要说清"的原始口径。
const DEFAULT_SOUL: &str = "# Mirach\n\nYou are Mirach, the user's AI teammate on their own machine. Warm, direct, no filler; say \"I'm not sure\" rather than guess. The user drives. When something fails, try another way, then say what failed.\n\n## Personality\n\n- Direct and concrete; lead with the answer, then the reasoning.\n- Say what you are unsure about instead of filling the gap with a guess.\n- When something fails, report what failed and what you tried.\n\n## Voice\n\n- Plain language, short sentences, no filler.\n- Match the user's language.\n\n## When Mirach is criticized\n\nOwn real limits plainly. Don't validate FUD: ask what they actually hit, or correct it with specifics.\n";

/// 个性文件路径：`<pi global_dir>/SOUL.md`。
///
/// 用 pi 自己的 `Config::global_dir()` 而不是手拼 `~/.pi/agent`——`PI_CODING_
/// AGENT_DIR` 覆盖时两者会分叉，而会话注入读的是前者。
fn persona_file_path() -> PathBuf {
    crate::pi_paths::agent_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join(PERSONA_FILE_SOUL)
}

/// 读出的个性文件（形状对齐上游 `WorkspaceFile`：filename/contents/is_default）。
fn read_persona_file() -> Result<serde_json::Value, String> {
    let path = persona_file_path();
    match std::fs::read(&path) {
        Ok(bytes) => {
            // 超限不加载进内存也不截断——上游同款（refuse over cap）
            if bytes.len() as u64 > MAX_PERSONA_FILE_BYTES {
                return Err(format!(
                    "{PERSONA_FILE_SOUL} 过大，无法编辑（超过 {MAX_PERSONA_FILE_BYTES} 字节上限）：{}",
                    path.display()
                ));
            }
            let contents = String::from_utf8(bytes).map_err(|e| {
                format!(
                    "{PERSONA_FILE_SOUL} 不是有效 UTF-8，无法编辑 {}: {e}",
                    path.display()
                )
            })?;
            Ok(serde_json::json!({
                "filename": PERSONA_FILE_SOUL,
                "contents": contents,
                "isDefault": false,
            }))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            // 缺失 = 用 bundled 默认（上游 read 的 fallback-to-default 同语义）
            Ok(serde_json::json!({
                "filename": PERSONA_FILE_SOUL,
                "contents": DEFAULT_SOUL,
                "isDefault": true,
            }))
        }
        Err(e) => Err(format!(
            "{PERSONA_FILE_SOUL} 读取失败 {}: {e}",
            path.display()
        )),
    }
}

/// 原子写入（tmp + rename；与 pi_settings::atomic_write_json 同一套纪律）。
fn write_persona_file(contents: &str) -> Result<serde_json::Value, String> {
    if contents.len() as u64 > MAX_PERSONA_FILE_BYTES {
        return Err(format!(
            "{PERSONA_FILE_SOUL} 内容过大（超过 {MAX_PERSONA_FILE_BYTES} 字节上限）"
        ));
    }
    let path = persona_file_path();
    let parent = path.parent().unwrap_or_else(|| std::path::Path::new("."));
    std::fs::create_dir_all(parent)
        .map_err(|e| format!("配置目录创建失败 {}: {e}", parent.display()))?;
    let tmp = parent.join(format!("{PERSONA_FILE_SOUL}.tmp-{}", std::process::id()));
    std::fs::write(&tmp, contents.as_bytes())
        .map_err(|e| format!("{PERSONA_FILE_SOUL} 写入失败 {}: {e}", path.display()))?;
    std::fs::rename(&tmp, &path)
        .map_err(|e| format!("{PERSONA_FILE_SOUL} 替换失败 {}: {e}", path.display()))
        .inspect_err(|_| {
            let _ = std::fs::remove_file(&tmp);
        })?;
    Ok(serde_json::json!({
        "filename": PERSONA_FILE_SOUL,
        "contents": contents,
        "isDefault": contents == DEFAULT_SOUL,
    }))
}

/// 读个性文件（SOUL.md）。缺失 → bundled 默认 + isDefault=true。
#[tauri::command(async)]
pub fn pi_persona_read() -> Result<serde_json::Value, String> {
    on_big_stack(read_persona_file)?
}

/// 写个性文件（SOUL.md）。超限 / 非 UTF-8 由上游语义决定：超限 Err，
/// 非 UTF-8 只可能在读侧遇到（写侧接 String）。
#[tauri::command(async)]
pub fn pi_persona_write(contents: String) -> Result<serde_json::Value, String> {
    on_big_stack(move || write_persona_file(&contents))?
}

/// 重置个性文件为随包默认。
#[tauri::command(async)]
pub fn pi_persona_reset() -> Result<serde_json::Value, String> {
    on_big_stack(|| write_persona_file(DEFAULT_SOUL))?
}

/// 会话注入用：当前 SOUL.md 的内容。
///
/// **读不到 = 不注入**（返回 Ok(None)）：文件不存在是正常态（用户从没打开过
/// 个性页），不是错误；但读取失败（权限/IO）必须传播——那才是真错误。
/// 内容为空（用户清空了 SOUL.md）同样视为"不注入"。
/// rpi 迁移后暂无调用方——注入点（system_prompt 组装）待 rpi 资源面接回。
#[allow(dead_code)]
pub(crate) fn persona_prompt_for_session() -> Result<Option<String>, String> {
    let path = persona_file_path();
    match std::fs::read_to_string(&path) {
        Ok(s) if s.trim().is_empty() => Ok(None),
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!(
            "个性文件读取失败 {}: {e}",
            path.display()
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 默认 SOUL.md 必须能被 guided 编辑器解析出 Personality / Voice 两节
    /// ——前端 `parsePersonaFields` 靠这两个 `## ` 标题，标题写错会让模板卡
    /// 与字段卡显示空值（静默的"看起来没生效"）。
    #[test]
    fn default_soul_has_guided_sections() {
        assert!(DEFAULT_SOUL.contains("\n## Personality\n"));
        assert!(DEFAULT_SOUL.contains("\n## Voice\n"));
        assert!(DEFAULT_SOUL.starts_with("# Mirach\n"));
    }

    #[test]
    fn default_soul_fits_cap() {
        assert!((DEFAULT_SOUL.len() as u64) < MAX_PERSONA_FILE_BYTES);
    }
}

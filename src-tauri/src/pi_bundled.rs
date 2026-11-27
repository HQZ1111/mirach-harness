//! 打包版随附的默认资产（2026-11-27：用户"打包版的技能插件都是空的"）。
//!
//! 背景：技能在 pi 语义里就是**每个 agent home 的 `skills/` 目录**，原生扩展
//! 是 `extensions/*.dll`；开发机上这些是从早期 `rpi install` 攒出来的，但
//! 安装包从不携带它们——换一台新机器（或公司在用的 Win10 机器）打开，
//! 「技能与工具」页的技能/插件两个页签就是空的，plan mode / todo / ask /
//! 后台任务等扩展也不可用。
//!
//! 对偶 hermes：桌面端安装包里带自己的 runtime 资源；宿主把**当前已验证可用
//! 的那套资产**随包分发：
//!   · `bundled/skills/<name>/SKILL.md…`      —— 27 个随包技能
//!   · `bundled/rpi-extensions.zip`           —— 原生扩展 DLL（zip 收纳）
//!
//! 种子语义 = **copy-if-missing**（首次/缺什么补什么）：
//!   · 技能：目标 home 缺同名目录才复制，用户改过的技能不会被覆盖；
//!   · 扩展：目标 home 没有任何 `.dll` 时把 zip 全部解出（先用 `tar.exe`
//!     解到临时目录再逐文件补缺），已有 DLL 一个不动——本地替换过的扩展
//!     （如打过补丁的 rpi_goal / rpi_background_tasks）不被官方版覆盖。
//!
//! 调用点：
//!   · `pi_profiles::ensure_profile_dirs` —— 本体 home 与具名环境都会种；
//!   · setup 早期后台线程主动种本体 home（首屏不等种子）。
//!
//! 资产根解析：打包后 = `resource_dir()/bundled`（tauri bundle.resources）；
//! 开发树回退 `CARGO_MANIFEST_DIR/bundled`。两处都没有 = 资产本就不存在
//! （老版本安装包没有这个目录）——**记日志跳过**，不把会话/设置页整个打挂；
//! 有资产但复制/解包失败 = Err 上传（规矩 12，不静默降级）。

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use tauri::Manager;

use crate::win_proc::HideConsole;

static BUNDLED_ROOT: OnceLock<PathBuf> = OnceLock::new();
/// 串行化种子：setup 后台线程与 ensure_profile_dirs（命令线程）可能同时进来，
/// 并发解同一个 zip / 复制同一批技能会互相踩临时文件。
static SEED_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// 资产根（setup 最早调用；重复调用幂等）。
pub fn init(app: &tauri::AppHandle) {
    let root = resolve_root(app);
    let _ = BUNDLED_ROOT.set(root);
}

fn resolve_root(app: &tauri::AppHandle) -> PathBuf {
    if let Ok(resource_dir) = app.path().resource_dir() {
        let bundled = resource_dir.join("bundled");
        if bundled.is_dir() {
            return bundled;
        }
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("bundled")
}

/// 进程级只报一次"没有随包资产"（旧安装包 / 裁剪过的开发树）。
fn warn_missing_once() {
    static WARNED: std::sync::Once = std::sync::Once::new();
    WARNED.call_once(|| {
        eprintln!("[bundled] 随包资产目录不存在（bundled/skills 或 rpi-extensions.zip）——跳过种子");
    });
}

/// 把随包默认资产种进一个 agent home（copy-if-missing）。
///
/// `home` = `AgentHome` 的 root（本体 `~/.rpi/agent`，具名
/// `~/.rpi/agent/profiles/<name>`）。
pub fn seed_home(home: &Path) -> Result<(), String> {
    let Some(root) = BUNDLED_ROOT.get() else {
        // init 未跑（单测/异常路径）——按"没有资产"处理，不猜路径。
        warn_missing_once();
        return Ok(());
    };
    let _guard = SEED_LOCK
        .lock()
        .map_err(|e| format!("随包资产种子锁中毒: {e}"))?;
    let skills_src = root.join("skills");
    let ext_zip = root.join("rpi-extensions.zip");
    if !skills_src.is_dir() && !ext_zip.is_file() {
        warn_missing_once();
        return Ok(());
    }
    if skills_src.is_dir() {
        seed_skills(&skills_src, &home.join("skills"))?;
    }
    if ext_zip.is_file() {
        seed_extensions(&ext_zip, &home.join("extensions"))?;
    }
    Ok(())
}

fn seed_skills(src: &Path, dst: &Path) -> Result<(), String> {
    let entries = std::fs::read_dir(src)
        .map_err(|e| format!("随包技能目录读取失败 {}: {e}", src.display()))?;
    std::fs::create_dir_all(dst)
        .map_err(|e| format!("技能目录创建失败 {}: {e}", dst.display()))?;
    let mut copied = 0usize;
    for entry in entries {
        let entry = entry.map_err(|e| format!("随包技能目录项读取失败 {}: {e}", src.display()))?;
        if !entry
            .file_type()
            .map_err(|e| format!("随包技能目录项类型读取失败 {}: {e}", entry.path().display()))?
            .is_dir()
        {
            continue;
        }
        let name = entry.file_name();
        let target = dst.join(&name);
        if target.exists() {
            continue;
        }
        copy_dir_all(&entry.path(), &target)?;
        copied += 1;
    }
    if copied > 0 {
        eprintln!(
            "[bundled] 技能种子：复制 {copied} 个技能 → {}",
            dst.display()
        );
    }
    Ok(())
}

fn copy_dir_all(src: &Path, dst: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dst).map_err(|e| format!("目录创建失败 {}: {e}", dst.display()))?;
    for entry in std::fs::read_dir(src)
        .map_err(|e| format!("目录读取失败 {}: {e}", src.display()))?
    {
        let entry = entry.map_err(|e| format!("目录项读取失败 {}: {e}", src.display()))?;
        let file_type = entry
            .file_type()
            .map_err(|e| format!("目录项类型读取失败 {}: {e}", entry.path().display()))?;
        let target = dst.join(entry.file_name());
        if file_type.is_dir() {
            copy_dir_all(&entry.path(), &target)?;
        } else if file_type.is_file() {
            std::fs::copy(entry.path(), &target)
                .map_err(|e| format!("文件复制失败 {} → {}: {e}", entry.path().display(), target.display()))?;
        }
        // 符号链接等其它类型跳过（随包资产里没有）。
    }
    Ok(())
}

fn seed_extensions(zip: &Path, dst: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dst)
        .map_err(|e| format!("扩展目录创建失败 {}: {e}", dst.display()))?;
    // 已有任一 DLL = 这台机器的扩展面已经就绪（用户自己装过 / 之前种过）。
    // 直接跳过，避免每次 ensure_profile_dirs 都解一遍 32MB zip。
    let has_dll = std::fs::read_dir(dst)
        .map_err(|e| format!("扩展目录读取失败 {}: {e}", dst.display()))?
        .filter_map(Result::ok)
        .any(|entry| {
            entry
                .path()
                .extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("dll"))
        });
    if has_dll {
        return Ok(());
    }
    let temp = std::env::temp_dir().join(format!("mirach-bundled-ext-{}", std::process::id()));
    if temp.exists() {
        std::fs::remove_dir_all(&temp)
            .map_err(|e| format!("扩展临时目录清理失败 {}: {e}", temp.display()))?;
    }
    std::fs::create_dir_all(&temp)
        .map_err(|e| format!("扩展临时目录创建失败 {}: {e}", temp.display()))?;

    // Windows 自带 bsdtar 能解 zip；用 tar.exe 避免为一次解包引入新依赖。
    let output = std::process::Command::new("tar")
        .args(["-xf"])
        .arg(zip)
        .args(["-C"])
        .arg(&temp)
        .hide_console()
        .output();
    let result = (|| -> Result<(), String> {
        let output = output.map_err(|e| format!("扩展解包失败（启动 tar 失败）: {e}"))?;
        if !output.status.success() {
            return Err(format!(
                "扩展解包失败（tar 退出码 {:?}）: {}",
                output.status.code(),
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
        let entries = std::fs::read_dir(&temp)
            .map_err(|e| format!("扩展临时目录读取失败 {}: {e}", temp.display()))?;
        let mut copied = 0usize;
        for entry in entries {
            let entry = entry.map_err(|e| format!("扩展临时目录项读取失败: {e}"))?;
            let path = entry.path();
            if !path.is_file() || !path.extension().is_some_and(|e| e.eq_ignore_ascii_case("dll")) {
                continue;
            }
            let target = dst.join(entry.file_name());
            if target.exists() {
                continue;
            }
            std::fs::copy(&path, &target).map_err(|e| {
                format!("扩展复制失败 {} → {}: {e}", path.display(), target.display())
            })?;
            copied += 1;
        }
        if copied > 0 {
            eprintln!("[bundled] 扩展种子：解出 {copied} 个 DLL → {}", dst.display());
        }
        Ok(())
    })();
    let _ = std::fs::remove_dir_all(&temp);
    result
}

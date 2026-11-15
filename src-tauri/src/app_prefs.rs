//! 应用级偏好（2026-11-15）：设置页「常规」里那些**不属于引擎配置**的开关
//! 的持久化真相层。
//!
//! 边界（为什么与 settings.json 分家）：
//!   · 引擎的 settings.json 归 rpi 所有（rpi-cli settings.rs 只认它认识的
//!     键），宿主自己的"关窗行为 / 保持唤醒 / 启动恢复"不能塞进去——否则
//!     既污染引擎文档，又会在 rpi 升级换 schema 时被带走。
//!   · 这里有 OS 副作用的两项（关窗→托盘、保持唤醒）必须在**窗口事件
//!     回调**里读到最新值，所以真相在 Rust 进程内（`AppPrefsState`），
//!     文件只是重启后的恢复源。前端经 `app_prefs_get` / `app_prefs_set`
//!     读写，其余（F12 拦截 / 外链外部打开 / 启动恢复）由渲染层消费。
//!
//! 存储：`<app_data_dir>/app-prefs.json`（原子写 tmp + rename，同
//! session_meta.rs / window_state.rs 的写法）。
//!
//! **不做兜底**（铁律 12）：文件不存在 = 首次启动，取默认值；**文件存在
//! 但损坏 = Err**（启动时 setup 返回错误、命令返回 Err），不静默重置——
//! 静默重置会把用户设置当垃圾扔掉，且永远不会有人发现。
//!
//! 保持唤醒的实现细节：`SetThreadExecutionState(ES_CONTINUOUS | …)` 的
//! 状态**绑定在调用线程**上，线程一死请求就失效。Tauri 命令线程是复用的
//! 池线程，不能把请求挂在它身上——所以这里起一条专用线程，命令只向它发
//! `Mode` / `RunActive`，线程自己持有执行状态直到进程退出。

use serde::{Deserialize, Serialize};
use std::sync::mpsc;
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Manager, State};

/// 保持电脑唤醒的模式（对齐 ZCode 设置页的 关闭 / 运行期间 / 始终）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum KeepAwakeMode {
    Off,
    Run,
    Always,
}

/// 应用级偏好。字段与前端 `src/lib/app-prefs.ts` 的 AppPrefs 一一对应。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppPrefs {
    /// 启动时恢复上次会话（false = 每次启动开新会话）。
    pub restore_last_session: bool,
    /// 关主窗 = 隐藏到托盘（false = 退出应用）。
    pub close_to_tray: bool,
    /// 保持电脑唤醒。
    pub keep_awake: KeepAwakeMode,
    /// 拦截 F12（阻止开发者工具快捷键）。发布构建本身不开放 devtools，
    /// 该开关只影响开发构建的页面级快捷键。
    pub disable_f12: bool,
    /// http(s) 链接一律交系统默认浏览器打开（不在应用内导航）。
    pub open_links_externally: bool,
    /// 单次 run 的最大智能体步数（0 = 不设上限）。写入引擎读取的
    /// `RPI_MAX_TURNS_PER_RUN` 环境变量（rpi-harness run_budget.rs）。
    pub max_agent_steps: u32,
    /// 上次打开的会话文件绝对路径（启动恢复用）。None = 无历史。
    pub last_session_path: Option<String>,
}

impl Default for AppPrefs {
    fn default() -> Self {
        Self {
            restore_last_session: true,
            close_to_tray: true,
            keep_awake: KeepAwakeMode::Off,
            disable_f12: true,
            open_links_externally: false,
            max_agent_steps: 100,
            last_session_path: None,
        }
    }
}

/// 进程内真相。窗口关闭回调在事件线程上读它，所以不能只读文件。
pub struct AppPrefsState(pub Mutex<AppPrefs>);

impl AppPrefsState {
    pub fn snapshot(&self) -> Result<AppPrefs, String> {
        self.0
            .lock()
            .map(|p| p.clone())
            .map_err(|_| "app-prefs 锁中毒（前一次写入 panic）".to_string())
    }
}

fn prefs_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir 解析失败: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("app_data_dir 创建失败: {e}"))?;
    Ok(dir.join("app-prefs.json"))
}

fn read_prefs(app: &AppHandle) -> Result<AppPrefs, String> {
    let path = prefs_path(app)?;
    match std::fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str::<AppPrefs>(&text)
            .map_err(|e| format!("app-prefs.json 解析失败（{}）：{e}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(AppPrefs::default()),
        Err(e) => Err(format!("app-prefs.json 读取失败（{}）：{e}", path.display())),
    }
}

fn write_prefs(app: &AppHandle, prefs: &AppPrefs) -> Result<(), String> {
    let path = prefs_path(app)?;
    let text = serde_json::to_string_pretty(prefs)
        .map_err(|e| format!("app-prefs 序列化失败：{e}"))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text.as_bytes())
        .map_err(|e| format!("app-prefs 临时文件写入失败（{}）：{e}", tmp.display()))?;
    std::fs::rename(&tmp, &path)
        .map_err(|e| format!("app-prefs 落盘失败（{}）：{e}", path.display()))
}

// ── 保持唤醒专用线程 ────────────────────────────────────────────────

enum AwakeCmd {
    Mode(KeepAwakeMode),
    RunActive(bool),
}

static AWAKE_TX: OnceLock<Mutex<Option<mpsc::Sender<AwakeCmd>>>> = OnceLock::new();

fn awake_sender() -> Result<mpsc::Sender<AwakeCmd>, String> {
    let cell = AWAKE_TX.get_or_init(|| Mutex::new(None));
    let mut slot = cell
        .lock()
        .map_err(|_| "keep-awake 发送端锁中毒".to_string())?;
    if let Some(tx) = slot.as_ref() {
        // std 的 Sender 没有 is_closed；线程若已 panic，发送端会在 send 时
        // 报错（apply_side_effects 里传播），不需要额外探活。
        return Ok(tx.clone());
    }
    let (tx, rx) = mpsc::channel::<AwakeCmd>();
    let tx_thread = tx.clone();
    std::thread::Builder::new()
        .name("keep-awake".into())
        .spawn(move || {
            let mut mode = KeepAwakeMode::Off;
            let mut run_active = false;
            // 先落一次 Off：线程从"不阻止睡眠"的确定态开始。
            set_prevent_sleep(false);
            while let Ok(cmd) = rx.recv() {
                match cmd {
                    AwakeCmd::Mode(next) => mode = next,
                    AwakeCmd::RunActive(next) => run_active = next,
                }
                let prevent = mode == KeepAwakeMode::Always
                    || (mode == KeepAwakeMode::Run && run_active);
                set_prevent_sleep(prevent);
            }
            // 进程退出/发送端全部断开：撤销请求（线程结束本来也会撤销，
            // 显式清一次让语义不依赖 OS 实现细节）。
            set_prevent_sleep(false);
        })
        .map_err(|e| format!("keep-awake 线程启动失败：{e}"))?;
    *slot = Some(tx_thread.clone());
    Ok(tx_thread)
}

#[cfg(windows)]
fn set_prevent_sleep(prevent: bool) {
    use windows_sys::Win32::System::Power::{
        SetThreadExecutionState, ES_CONTINUOUS, ES_SYSTEM_REQUIRED,
    };
    let flags = ES_CONTINUOUS | if prevent { ES_SYSTEM_REQUIRED } else { 0 };
    // 失败只可能来自非法 flags（这里全是合法常量）；返回值是旧状态，不检查。
    unsafe {
        SetThreadExecutionState(flags);
    }
}

#[cfg(not(windows))]
fn set_prevent_sleep(prevent: bool) {
    // 非 Windows 平台暂无实现：显式记录，不假装生效。
    if prevent {
        eprintln!("[keep-awake] 当前平台未实现保持唤醒（prevent_sleep=true 被忽略）");
    }
}

/// 把 `maxAgentSteps` 同步到引擎读取的环境变量（rpi-harness run_budget.rs
/// 的 `RPI_MAX_TURNS_PER_RUN`）：`RunBudget::from_env()` 在**每次 run 开始**
/// 时读取，所以运行期改设置对下一次 run 立即生效。0 = 删变量（不设上限）。
fn apply_max_agent_steps(steps: u32) -> Result<(), String> {
    const KEY: &str = "RPI_MAX_TURNS_PER_RUN";
    if steps == 0 {
        std::env::remove_var(KEY);
        return Ok(());
    }
    std::env::set_var(KEY, steps.to_string());
    Ok(())
}

fn apply_side_effects(prefs: &AppPrefs) -> Result<(), String> {
    apply_max_agent_steps(prefs.max_agent_steps)?;
    awake_sender()?.send(AwakeCmd::Mode(prefs.keep_awake))
        .map_err(|_| "keep-awake 线程已退出".to_string())
}

/// setup 时调用：读文件 → 进进程状态 → 应用副作用。返回可 manage 的状态。
pub fn init(app: &AppHandle) -> Result<AppPrefsState, String> {
    let prefs = read_prefs(app)?;
    apply_side_effects(&prefs)?;
    Ok(AppPrefsState(Mutex::new(prefs)))
}

fn merge_patch(current: &AppPrefs, patch: &serde_json::Value) -> Result<AppPrefs, String> {
    if !patch.is_object() {
        return Err("app_prefs_set 的 patch 必须是 JSON 对象".to_string());
    }
    let mut doc = serde_json::to_value(current)
        .map_err(|e| format!("app-prefs 序列化失败：{e}"))?;
    let obj = doc
        .as_object_mut()
        .ok_or_else(|| "app-prefs 序列化结果不是对象".to_string())?;
    for (k, v) in patch.as_object().expect("已校验 is_object") {
        obj.insert(k.clone(), v.clone());
    }
    let next: AppPrefs = serde_json::from_value(doc)
        .map_err(|e| format!("app-prefs 字段校验失败：{e}"))?;
    // 步数上限：0 = 不设上限；其余必须落在 [1, 100000]（引擎的 run_budget
    // 只接受 u32，超大值等于永不到达，没有意义——拒绝而不是静默夹取）。
    if next.max_agent_steps > 100_000 {
        return Err(format!(
            "最大智能体步数 {} 超出范围（0 = 不设上限，或 1..=100000）",
            next.max_agent_steps
        ));
    }
    Ok(next)
}

#[tauri::command]
pub fn app_prefs_get(state: State<'_, AppPrefsState>) -> Result<AppPrefs, String> {
    state.snapshot()
}

/// 合并写（前端只传变化的字段）。落盘成功才更新进程内状态；副作用在
/// 状态更新后应用——任何一步失败都返回 Err，前端必须显示错误。
#[tauri::command]
pub fn app_prefs_set(
    app: AppHandle,
    state: State<'_, AppPrefsState>,
    patch: serde_json::Value,
) -> Result<AppPrefs, String> {
    let current = state.snapshot()?;
    let next = merge_patch(&current, &patch)?;
    write_prefs(&app, &next)?;
    {
        let mut guard = state
            .0
            .lock()
            .map_err(|_| "app-prefs 锁中毒".to_string())?;
        *guard = next.clone();
    }
    apply_side_effects(&next)?;
    Ok(next)
}

/// 「运行期间」模式的 run 活动信号：runtime 在 run 开始/结束时调用。
/// 其它模式下该信号无效果（线程只在自己的模式是 Run 时才阻止睡眠）。
#[tauri::command]
pub fn app_keep_awake_run(active: bool) -> Result<(), String> {
    awake_sender()?
        .send(AwakeCmd::RunActive(active))
        .map_err(|_| "keep-awake 线程已退出".to_string())
}

/// 关窗行为给窗口事件回调用：读进程内状态；状态尚未 manage（极早的
/// 关窗竞态）时返回 Err，调用方按"隐藏到托盘"的既有行为处理。
pub fn close_to_tray(app: &AppHandle) -> Result<bool, String> {
    app.try_state::<AppPrefsState>()
        .ok_or_else(|| "app-prefs 尚未初始化".to_string())?
        .snapshot()
        .map(|p| p.close_to_tray)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn prefs_with(steps: u32) -> AppPrefs {
        AppPrefs {
            max_agent_steps: steps,
            ..AppPrefs::default()
        }
    }

    #[test]
    fn defaults_match_the_settings_page_initial_state() {
        let p = AppPrefs::default();
        assert!(p.restore_last_session);
        assert!(p.close_to_tray);
        assert_eq!(p.keep_awake, KeepAwakeMode::Off);
        assert!(p.disable_f12);
        assert!(!p.open_links_externally);
        assert_eq!(p.max_agent_steps, 100);
        assert_eq!(p.last_session_path, None);
    }

    #[test]
    fn merge_patch_updates_only_named_fields() {
        let current = AppPrefs::default();
        let next = merge_patch(
            &current,
            &serde_json::json!({"closeToTray": false, "maxAgentSteps": 7}),
        )
        .unwrap();
        assert!(!next.close_to_tray);
        assert_eq!(next.max_agent_steps, 7);
        // 未点名字段保持原值
        assert!(next.restore_last_session);
        assert_eq!(next.keep_awake, KeepAwakeMode::Off);
    }

    #[test]
    fn merge_patch_rejects_non_object_and_bad_types() {
        assert!(merge_patch(&AppPrefs::default(), &serde_json::json!(1)).is_err());
        assert!(merge_patch(
            &AppPrefs::default(),
            &serde_json::json!({"closeToTray": "yes"})
        )
        .is_err());
        assert!(merge_patch(
            &AppPrefs::default(),
            &serde_json::json!({"keepAwake": "sometimes"})
        )
        .is_err());
    }

    #[test]
    fn merge_patch_rejects_out_of_range_steps() {
        assert!(merge_patch(&AppPrefs::default(), &serde_json::json!({"maxAgentSteps": 100_001})).is_err());
        assert!(merge_patch(&AppPrefs::default(), &serde_json::json!({"maxAgentSteps": 0})).is_ok());
    }

    #[test]
    fn merge_patch_accepts_last_session_path_null() {
        let mut current = AppPrefs::default();
        current.last_session_path = Some("C:/x.jsonl".into());
        let next = merge_patch(&current, &serde_json::json!({"lastSessionPath": null})).unwrap();
        assert_eq!(next.last_session_path, None);
    }

    #[test]
    fn unknown_patch_keys_are_ignored_by_serde() {
        // 前向兼容：旧前端把新字段名发过来时不该报错（serde 默认忽略未知键）。
        let next = merge_patch(
            &AppPrefs::default(),
            &serde_json::json!({"futureFlag": true, "closeToTray": false}),
        )
        .unwrap();
        assert!(!next.close_to_tray);
    }

    #[test]
    fn apply_max_agent_steps_sets_and_clears_env() {
        // 环境变量是进程级的：本模块内串行，避免与其它用例互相踩。
        static ENV_LOCK: Mutex<()> = Mutex::new(());
        let _guard = ENV_LOCK.lock().unwrap();
        apply_max_agent_steps(42).unwrap();
        assert_eq!(std::env::var("RPI_MAX_TURNS_PER_RUN").unwrap(), "42");
        apply_max_agent_steps(0).unwrap();
        assert!(std::env::var("RPI_MAX_TURNS_PER_RUN").is_err());
    }

    #[test]
    fn prefs_round_trip_through_json() {
        let p = prefs_with(9);
        let text = serde_json::to_string(&p).unwrap();
        let back: AppPrefs = serde_json::from_str(&text).unwrap();
        assert_eq!(back.max_agent_steps, 9);
        assert_eq!(back.close_to_tray, p.close_to_tray);
    }
}

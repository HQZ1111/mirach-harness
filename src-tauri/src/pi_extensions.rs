//! 扩展列表（竖链移植降级：rpi-extensions = cdylib 插件 ABI（与旧 pi 的
//! JS/WASM/Native 三运行时完全不同的设计），无 manifest 目录扫描面——
//! 待 rpi-extensions 长出等价能力后接回；旧实现存档于 git df701a4）。

use serde_json::Value;

/// 扩展列表（rpi 无目录扫描面——如实降级）。
#[tauri::command(async)]
pub fn pi_extensions(_cwd: Option<String>) -> Result<Value, String> {
    Err("rpi 引擎待接：扩展列表（rpi-extensions ABI 不同）".into())
}

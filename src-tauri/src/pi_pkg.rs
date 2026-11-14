//! 包管理页（竖链移植降级：rpi-cli packages.rs = 项目包运行面，无
//! install/remove/update/list 安装管理——待 rpi-main 长出后接回；
//! 旧实现存档于 git df701a4）。

use serde_json::Value;

#[tauri::command(async)]
pub fn pi_pkg_list(_cwd: Option<String>) -> Result<Value, String> {
    Err("rpi 引擎待接：包管理".into())
}

#[tauri::command(async)]
pub fn pi_pkg_install(_cwd: Option<String>, _source: String, _scope: String) -> Result<Value, String> {
    Err("rpi 引擎待接：包管理".into())
}

#[tauri::command(async)]
pub fn pi_pkg_remove(_cwd: Option<String>, _source: String, _scope: String) -> Result<Value, String> {
    Err("rpi 引擎待接：包管理".into())
}

#[tauri::command(async)]
pub fn pi_pkg_update(_cwd: Option<String>, _source: String, _scope: String) -> Result<Value, String> {
    Err("rpi 引擎待接：包管理".into())
}

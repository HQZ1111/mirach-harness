//! 使用统计（竖链移植降级：rpi-main 无跨会话 stats 聚合——
//! rpi-harness get_stats = 单会话面；待 rpi-main 长出聚合能力后接回；
//! 旧实现存档于 git df701a4）。

use serde_json::Value;

#[tauri::command(async)]
pub fn pi_usage_snapshot(_range: String) -> Result<Value, String> {
    Err("rpi 引擎待接：使用统计聚合".into())
}

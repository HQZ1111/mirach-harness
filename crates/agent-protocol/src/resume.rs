//! ResumeOutcome — attach 时 Rust 返回的三分支（§11.3 第 3 步）。
//!
//! serde 形状（snake_case 判别 tag，与 L1 TypeScript mirror 对齐）：
//! ```json
//! { "type": "replayed" }
//! { "type": "snapshot_required" }
//! { "type": "run_gone" }
//! ```

use serde::{Deserialize, Serialize};

/// attachStream(runId, lastSequence) 的返回：三分支。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ResumeOutcome {
    /// 等 Channel 推重放事件。
    Replayed,
    /// 起 5s 提示超时，等 SNAPSHOT_RESTORED 或 RUN_GONE。
    SnapshotRequired,
    /// 清 Store（run 已不存在）。
    RunGone,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_all_branches() {
        for outcome in [
            ResumeOutcome::Replayed,
            ResumeOutcome::SnapshotRequired,
            ResumeOutcome::RunGone,
        ] {
            let json = serde_json::to_string(&outcome).unwrap();
            let back: ResumeOutcome = serde_json::from_str(&json).unwrap();
            assert_eq!(outcome, back);
        }
    }

    #[test]
    fn tag_values() {
        assert_eq!(
            serde_json::to_value(ResumeOutcome::Replayed).unwrap()["type"],
            "replayed"
        );
        assert_eq!(
            serde_json::to_value(ResumeOutcome::SnapshotRequired).unwrap()["type"],
            "snapshot_required"
        );
        assert_eq!(
            serde_json::to_value(ResumeOutcome::RunGone).unwrap()["type"],
            "run_gone"
        );
    }
}
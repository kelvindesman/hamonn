//! Serde domain types shared by the kernel and (via the JSON boundary) the TS shell.
//! JSON field names are camelCase; enum values match the spec (`"OPEN"`, `"clean"`, ...).

use serde::{Deserialize, Serialize};

pub type LaneId = u64;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum LaneState {
    Open,
    Pushed,
    Ready,
    Landing,
    Landed,
    Behind,
    Archived,
    Failed,
}

impl LaneState {
    /// Terminal states have no outgoing edges.
    pub fn is_terminal(self) -> bool {
        matches!(self, LaneState::Landed | LaneState::Archived)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LaneMode {
    Fork,
    Branch,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MergePreview {
    Clean,
    Conflict,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoRef {
    pub name: String,
    pub remote: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LedgerStatus {
    pub intent: bool,
    pub handoff: bool,
    pub evidence: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub handoff_lines: Option<usize>,
    #[serde(default)]
    pub handoff_too_long: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectPolicy {
    pub name: String,
    #[serde(default = "default_branch")]
    pub integration_branch: String,
    #[serde(default = "default_lane_mode")]
    pub lane_mode: LaneMode,
    #[serde(default)]
    pub gated_paths: Vec<String>,
    #[serde(default)]
    pub required_checks: Vec<String>,
}

fn default_branch() -> String {
    "main".to_string()
}

fn default_lane_mode() -> LaneMode {
    LaneMode::Fork
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub project_name: String,
    #[serde(default)]
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub winner_lane: Option<LaneId>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Lane {
    pub id: LaneId,
    pub task_id: String,
    pub agent: String,
    pub intent: String,
    pub repo: RepoRef,
    pub branch: String,
    pub state: LaneState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub head: Option<String>,
    pub base: String,
    #[serde(default)]
    pub claims: Vec<String>,
    #[serde(default)]
    pub touched: Vec<String>,
    #[serde(default)]
    pub drift: Vec<String>,
    #[serde(default)]
    pub overlaps: Vec<LaneId>,
    #[serde(default)]
    pub gate_required: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gate_signed_by: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub landed_sha: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conflict_files: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub merge_preview: Option<MergePreview>,
    #[serde(default)]
    pub ledger: LedgerStatus,
    #[serde(default)]
    pub allow_drift: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token_expires: Option<i64>,
    pub opened_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CheckStatus {
    Pass,
    Fail,
    Pending,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckResult {
    pub lane_id: LaneId,
    pub name: String,
    pub status: CheckStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// Lane head the check ran against. A check bound to a head only counts while the lane is
    /// still at that head (so a re-push invalidates stale greens); unbound checks always count.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub head: Option<String>,
    pub at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueEntry {
    pub lane_id: LaneId,
    pub enqueued_at: i64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_policy_defaults() {
        let p: ProjectPolicy = serde_json::from_str(r#"{"name":"demo"}"#).unwrap();
        assert_eq!(p.integration_branch, "main");
        assert_eq!(p.lane_mode, LaneMode::Fork);
        assert!(p.gated_paths.is_empty() && p.required_checks.is_empty());
    }

    #[test]
    fn wire_names() {
        assert_eq!(serde_json::to_string(&LaneState::Behind).unwrap(), r#""BEHIND""#);
        assert_eq!(serde_json::to_string(&MergePreview::Clean).unwrap(), r#""clean""#);
        assert_eq!(serde_json::to_string(&CheckStatus::Pass).unwrap(), r#""pass""#);
    }
}

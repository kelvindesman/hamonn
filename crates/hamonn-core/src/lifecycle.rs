//! Lane lifecycle rules: open, push, sign, archive, land, pick-winner, queue, compare.
//! Every function is pure: facts in, new facts (or a plan) out.

use serde::{Deserialize, Serialize};

use crate::claims::{claims_overlap, drift, matches_any, normalize};
use crate::domain::*;
use crate::error::KernelError;
use crate::evaluate::latest;
use crate::state::{can_transition, transition};

/// Lifetime of the short-lived credentials minted for a lane (seconds).
pub const LANE_TOKEN_TTL_SEC: u32 = 3600;
/// Lifetime of the one-shot credentials minted inside a landing (seconds).
pub const LAND_TOKEN_TTL_SEC: u32 = 600;

// ───────────────────────────── open ─────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenRequest {
    pub project: ProjectPolicy,
    pub lane_id: LaneId,
    pub task_id: String,
    pub agent: String,
    pub intent: String,
    pub claims: Vec<String>,
    /// Integration head observed by the shell (`host.headSha`).
    pub base: String,
    pub now: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaneSummary {
    pub id: LaneId,
    pub task_id: String,
    pub state: LaneState,
    #[serde(default)]
    pub claims: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenPlan {
    /// Lane skeleton; the shell fills `repo` (fork result) and token fields.
    pub lane: Lane,
    /// `Some(name)` in fork mode (shell must fork), `None` in branch mode.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fork_name: Option<String>,
    pub branch: String,
    pub overlaps: Vec<LaneId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
    pub token_ttl_sec: u32,
}

fn require(value: &str, what: &str) -> Result<(), KernelError> {
    if value.trim().is_empty() {
        Err(KernelError::InvalidInput(format!("{what} must not be empty")))
    } else {
        Ok(())
    }
}

pub fn plan_open(req: &OpenRequest, open_lanes: &[LaneSummary]) -> Result<OpenPlan, KernelError> {
    require(&req.agent, "agent")?;
    require(&req.intent, "intent")?;
    require(&req.task_id, "task")?;
    let claims: Vec<String> = req.claims.iter().filter_map(|c| normalize(c)).collect();
    if claims.is_empty() {
        return Err(KernelError::InvalidInput("at least one claim is required".into()));
    }
    let mut overlapping: Vec<&LaneSummary> = open_lanes
        .iter()
        .filter(|l| l.id != req.lane_id && !l.state.is_terminal() && claims_overlap(&claims, &l.claims))
        .collect();
    overlapping.sort_by_key(|l| l.id);
    let overlaps: Vec<LaneId> = overlapping.iter().map(|l| l.id).collect();
    let hint = if overlapping.is_empty() {
        None
    } else {
        let who: Vec<String> = overlapping
            .iter()
            .map(|l| {
                if l.task_id == req.task_id {
                    format!("#{} (same task: compete as a candidate)", l.id)
                } else {
                    format!("#{} (task {}: coordinate)", l.id, l.task_id)
                }
            })
            .collect();
        Some(format!("claims overlap open lane(s) {}", who.join(", ")))
    };
    let (fork_name, branch) = match req.project.lane_mode {
        LaneMode::Fork => (
            Some(format!("{}-l{}", req.project.name, req.lane_id)),
            req.project.integration_branch.clone(),
        ),
        LaneMode::Branch => (None, format!("lane/{}", req.lane_id)),
    };
    let lane = Lane {
        id: req.lane_id,
        task_id: req.task_id.clone(),
        agent: req.agent.clone(),
        intent: req.intent.clone(),
        repo: RepoRef {
            name: fork_name.clone().unwrap_or_default(),
            remote: String::new(),
        },
        branch: branch.clone(),
        state: LaneState::Open,
        head: None,
        base: req.base.clone(),
        claims,
        touched: vec![],
        drift: vec![],
        overlaps: overlaps.clone(),
        gate_required: false,
        gate_signed_by: None,
        landed_sha: None,
        conflict_files: None,
        merge_preview: None,
        ledger: LedgerStatus::default(),
        allow_drift: false,
        failure: None,
        token_id: None,
        token_expires: None,
        opened_at: req.now,
        updated_at: req.now,
    };
    Ok(OpenPlan {
        lane,
        fork_name,
        branch,
        overlaps,
        hint,
        token_ttl_sec: LANE_TOKEN_TTL_SEC,
    })
}

// ───────────────────────────── push ─────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PushFacts {
    /// New lane head.
    pub head: String,
    /// All paths changed between the lane's base and `head`.
    pub touched: Vec<String>,
    pub ledger: LedgerStatus,
    pub now: i64,
}

pub fn apply_push(lane: &Lane, push: &PushFacts, project: &ProjectPolicy) -> Result<Lane, KernelError> {
    let mut next = lane.clone();
    next.state = transition(lane.state, LaneState::Pushed)?;
    next.head = Some(push.head.clone());
    next.touched = push.touched.clone();
    next.drift = drift(&push.touched, &lane.claims);
    next.gate_required = push.touched.iter().any(|t| matches_any(t, &project.gated_paths));
    // A sign-off applies to one head; any new push voids it.
    next.gate_signed_by = None;
    next.merge_preview = Some(MergePreview::Unknown);
    next.conflict_files = None;
    next.failure = None;
    next.ledger = push.ledger.clone();
    next.updated_at = push.now;
    Ok(next)
}

pub fn sign(lane: &Lane, by: &str, now: i64) -> Result<Lane, KernelError> {
    require(by, "signer")?;
    if !matches!(lane.state, LaneState::Pushed | LaneState::Ready) {
        return Err(KernelError::WrongState {
            lane: lane.id,
            state: lane.state,
            expected: "PUSHED or READY",
        });
    }
    if !lane.gate_required {
        return Err(KernelError::InvalidInput(format!(
            "lane #{} touches no gated path",
            lane.id
        )));
    }
    let mut next = lane.clone();
    next.gate_signed_by = Some(by.to_string());
    next.updated_at = now;
    Ok(next)
}

pub fn archive(lane: &Lane, now: i64) -> Result<Lane, KernelError> {
    let mut next = lane.clone();
    next.state = transition(lane.state, LaneState::Archived)?;
    next.updated_at = now;
    Ok(next)
}

// ───────────────────────────── land ─────────────────────────────

pub fn can_enqueue(lane: &Lane) -> Result<(), KernelError> {
    if lane.state == LaneState::Ready {
        Ok(())
    } else {
        Err(KernelError::WrongState {
            lane: lane.id,
            state: lane.state,
            expected: "READY",
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LandPlan {
    /// The lane, already moved to LANDING.
    pub lane: Lane,
    pub integration_branch: String,
    pub lane_branch: String,
    pub head: String,
    pub message: String,
    pub token_ttl_sec: u32,
}

pub fn plan_land(lane: &Lane, project: &ProjectPolicy, now: i64) -> Result<LandPlan, KernelError> {
    can_enqueue(lane)?;
    let head = lane
        .head
        .clone()
        .ok_or_else(|| KernelError::InvalidInput(format!("lane #{} has no head to land", lane.id)))?;
    let mut next = lane.clone();
    next.state = transition(lane.state, LaneState::Landing)?;
    next.updated_at = now;
    let first_line = lane.intent.lines().next().unwrap_or_default();
    let message = format!(
        "Land lane #{} [{}] by {}: {}",
        lane.id, lane.task_id, lane.agent, first_line
    );
    Ok(LandPlan {
        lane: next,
        integration_branch: project.integration_branch.clone(),
        lane_branch: lane.branch.clone(),
        head,
        message,
        token_ttl_sec: LAND_TOKEN_TTL_SEC,
    })
}

/// What the GitWire reported. It never touches the host API.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum WireResult {
    Clean { sha: String },
    Conflict { files: Vec<String> },
    Error { message: String },
}

/// Evidence read *after* a clean push: is the lane head an ancestor of the integration head?
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Proof {
    pub integration_head: String,
    pub is_ancestor: bool,
}

pub fn apply_land_result(
    lane: &Lane,
    result: &WireResult,
    proof: Option<&Proof>,
    now: i64,
) -> Result<Lane, KernelError> {
    if lane.state != LaneState::Landing {
        return Err(KernelError::WrongState {
            lane: lane.id,
            state: lane.state,
            expected: "LANDING",
        });
    }
    let mut next = lane.clone();
    next.updated_at = now;
    match result {
        WireResult::Clean { sha } => match proof {
            Some(p) if p.is_ancestor => {
                next.state = transition(lane.state, LaneState::Landed)?;
                next.landed_sha = Some(sha.clone());
                next.merge_preview = Some(MergePreview::Clean);
                next.conflict_files = None;
                next.failure = None;
            }
            _ => {
                next.state = transition(lane.state, LaneState::Failed)?;
                next.failure = Some(format!(
                    "landed proof failed: lane head is not an ancestor of integration head {}",
                    proof.map_or("(unread)", |p| p.integration_head.as_str())
                ));
            }
        },
        WireResult::Conflict { files } => {
            next.state = transition(lane.state, LaneState::Behind)?;
            next.conflict_files = Some(files.clone());
            next.merge_preview = Some(MergePreview::Conflict);
        }
        WireResult::Error { message } => {
            next.state = transition(lane.state, LaneState::Failed)?;
            next.failure = Some(message.clone());
        }
    }
    Ok(next)
}

// ─────────────────────── candidates & queue ───────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PickPlan {
    pub task: Task,
    pub winner: LaneId,
    /// Sibling lanes to archive (their tokens get revoked by the shell).
    pub archive: Vec<LaneId>,
}

pub fn pick_winner(task: &Task, lanes: &[Lane], winner: LaneId) -> Result<PickPlan, KernelError> {
    let siblings: Vec<&Lane> = lanes.iter().filter(|l| l.task_id == task.id).collect();
    let chosen = siblings.iter().find(|l| l.id == winner).ok_or_else(|| {
        KernelError::NotFound(format!("lane #{winner} is not a candidate of task {}", task.id))
    })?;
    if task.winner_lane.is_some_and(|w| w != winner) {
        return Err(KernelError::InvalidInput(format!(
            "task {} already has a winner",
            task.id
        )));
    }
    can_enqueue(chosen)?;
    let mut archive: Vec<LaneId> = siblings
        .iter()
        .filter(|l| l.id != winner && can_transition(l.state, LaneState::Archived))
        .map(|l| l.id)
        .collect();
    archive.sort_unstable();
    let mut picked = task.clone();
    picked.winner_lane = Some(winner);
    Ok(PickPlan {
        task: picked,
        winner,
        archive,
    })
}

/// Queue order: oldest `enqueued_at` first, ties broken by lane id.
pub fn queue_order(queue: &[QueueEntry]) -> Vec<LaneId> {
    let mut sorted: Vec<&QueueEntry> = queue.iter().collect();
    sorted.sort_by_key(|e| (e.enqueued_at, e.lane_id));
    sorted.iter().map(|e| e.lane_id).collect()
}

pub fn next_in_queue(queue: &[QueueEntry]) -> Option<LaneId> {
    queue_order(queue).first().copied()
}

/// Zero-based position of `lane_id` in the landing order.
pub fn queue_position(queue: &[QueueEntry], lane_id: LaneId) -> Option<usize> {
    queue_order(queue).iter().position(|id| *id == lane_id)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CandidateRow {
    pub lane_id: LaneId,
    pub agent: String,
    pub state: LaneState,
    pub touched_count: usize,
    pub drift_count: usize,
    pub claims_kept: bool,
    pub checks_passed: usize,
    pub checks_failed: usize,
    pub checks_pending: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub merge_preview: Option<MergePreview>,
    pub ledger_ok: bool,
    pub score: i64,
}

fn check_counts(lane: &Lane, checks: &[CheckResult]) -> (usize, usize, usize) {
    let mut names: Vec<&str> = checks
        .iter()
        .filter(|c| c.lane_id == lane.id)
        .map(|c| c.name.as_str())
        .collect();
    names.sort_unstable();
    names.dedup();
    let (mut pass, mut fail, mut pending) = (0, 0, 0);
    for name in names {
        match latest(checks, lane, name).map(|c| c.status) {
            Some(CheckStatus::Pass) => pass += 1,
            Some(CheckStatus::Fail) => fail += 1,
            _ => pending += 1,
        }
    }
    (pass, fail, pending)
}

/// Candidate comparison table, best first (score desc, then lane id asc).
pub fn compare(lanes: &[Lane], checks: &[CheckResult]) -> Vec<CandidateRow> {
    let mut rows: Vec<CandidateRow> = lanes
        .iter()
        .map(|l| {
            let (passed, failed, pending) = check_counts(l, checks);
            let ledger_ok = l.ledger.intent && l.ledger.handoff;
            let preview = match l.merge_preview {
                Some(MergePreview::Clean) => 5,
                Some(MergePreview::Conflict) => -10,
                _ => 0,
            };
            let score = 10 * passed as i64 - 10 * failed as i64 - 5 * l.drift.len() as i64
                + if ledger_ok { 5 } else { 0 }
                + preview;
            CandidateRow {
                lane_id: l.id,
                agent: l.agent.clone(),
                state: l.state,
                touched_count: l.touched.len(),
                drift_count: l.drift.len(),
                claims_kept: l.drift.is_empty(),
                checks_passed: passed,
                checks_failed: failed,
                checks_pending: pending,
                merge_preview: l.merge_preview,
                ledger_ok,
                score,
            }
        })
        .collect();
    rows.sort_by(|a, b| b.score.cmp(&a.score).then(a.lane_id.cmp(&b.lane_id)));
    rows
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::evaluate::fixtures::*;

    fn req(mode: LaneMode) -> OpenRequest {
        let mut project = project();
        project.lane_mode = mode;
        OpenRequest {
            project,
            lane_id: 44,
            task_id: "T-17".into(),
            agent: "claude-C".into(),
            intent: "feat: rss".into(),
            claims: vec!["./src/rss/".into(), " ".into()],
            base: "base0".into(),
            now: 100,
        }
    }

    fn summary(id: LaneId, task: &str, state: LaneState, claims: &[&str]) -> LaneSummary {
        LaneSummary {
            id,
            task_id: task.into(),
            state,
            claims: claims.iter().map(|s| s.to_string()).collect(),
        }
    }

    #[test]
    fn open_fork_mode_with_overlaps() {
        let open = vec![
            summary(41, "T-18", LaneState::Pushed, &["src/rss/feed.ts"]),
            summary(40, "T-17", LaneState::Ready, &["src/rss/**"]),
            summary(39, "T-17", LaneState::Landed, &["src/rss/**"]),
            summary(38, "T-9", LaneState::Pushed, &["src/cron/**"]),
            summary(44, "T-17", LaneState::Open, &["src/rss/**"]),
        ];
        let p = plan_open(&req(LaneMode::Fork), &open).unwrap();
        assert_eq!(p.overlaps, vec![40, 41]);
        assert_eq!(
            p.hint.as_deref(),
            Some("claims overlap open lane(s) #40 (same task: compete as a candidate), #41 (task T-18: coordinate)")
        );
        assert_eq!(p.fork_name.as_deref(), Some("demo-l44"));
        assert_eq!(p.branch, "main");
        assert_eq!(p.lane.claims, vec!["src/rss/**".to_string()]);
        assert_eq!(p.lane.state, LaneState::Open);
        assert_eq!(p.lane.overlaps, vec![40, 41]);
        assert_eq!(p.token_ttl_sec, LANE_TOKEN_TTL_SEC);
    }

    #[test]
    fn open_branch_mode_no_overlap() {
        let p = plan_open(&req(LaneMode::Branch), &[]).unwrap();
        assert_eq!((p.fork_name, p.branch.as_str(), p.hint), (None, "lane/44", None));
        assert_eq!(p.lane.repo.name, "");
    }

    #[test]
    fn open_validation() {
        for (mutate, what) in [
            (
                Box::new(|r: &mut OpenRequest| r.agent = " ".into()) as Box<dyn Fn(&mut OpenRequest)>,
                "agent",
            ),
            (Box::new(|r| r.intent = "".into()), "intent"),
            (Box::new(|r| r.task_id = "".into()), "task"),
        ] {
            let mut r = req(LaneMode::Fork);
            mutate(&mut r);
            assert_eq!(
                plan_open(&r, &[]),
                Err(KernelError::InvalidInput(format!("{what} must not be empty")))
            );
        }
        let mut r = req(LaneMode::Fork);
        r.claims = vec!["".into()];
        assert_eq!(
            plan_open(&r, &[]),
            Err(KernelError::InvalidInput("at least one claim is required".into()))
        );
    }

    fn facts(touched: &[&str]) -> PushFacts {
        PushFacts {
            head: "h2".into(),
            touched: touched.iter().map(|s| s.to_string()).collect(),
            ledger: LedgerStatus {
                intent: true,
                handoff: true,
                evidence: false,
                ..Default::default()
            },
            now: 50,
        }
    }

    #[test]
    fn push_computes_drift_gate_and_resets() {
        let mut l = lane(1, LaneState::Ready);
        l.gate_signed_by = Some("owner".into());
        l.conflict_files = Some(vec!["a".into()]);
        l.failure = Some("old".into());
        let n = apply_push(
            &l,
            &facts(&["src/rss/a.ts", "src/db/x.ts", ".lane/intent.md"]),
            &project(),
        )
        .unwrap();
        assert_eq!(n.state, LaneState::Pushed);
        assert_eq!(n.head.as_deref(), Some("h2"));
        assert_eq!(n.drift, vec!["src/db/x.ts".to_string()]);
        assert!(n.gate_required);
        assert_eq!(n.gate_signed_by, None);
        assert_eq!(n.merge_preview, Some(MergePreview::Unknown));
        assert_eq!((n.conflict_files, n.failure, n.updated_at), (None, None, 50));
        assert!(n.ledger.intent);
    }

    #[test]
    fn push_without_gated_paths_and_from_bad_state() {
        let n = apply_push(&lane(1, LaneState::Open), &facts(&["src/rss/a.ts"]), &project()).unwrap();
        assert!(!n.gate_required);
        assert!(n.drift.is_empty());
        assert_eq!(
            apply_push(&lane(1, LaneState::Landed), &facts(&[]), &project()),
            Err(KernelError::InvalidTransition {
                from: LaneState::Landed,
                to: LaneState::Pushed
            })
        );
    }

    #[test]
    fn signing() {
        let mut l = lane(1, LaneState::Pushed);
        l.gate_required = true;
        let s = sign(&l, "owner", 7).unwrap();
        assert_eq!((s.gate_signed_by.as_deref(), s.updated_at), (Some("owner"), 7));
        assert_eq!(
            sign(&l, " ", 7),
            Err(KernelError::InvalidInput("signer must not be empty".into()))
        );
        assert!(matches!(
            sign(&lane(1, LaneState::Pushed), "o", 7),
            Err(KernelError::InvalidInput(_))
        ));
        let mut landed = lane(1, LaneState::Landed);
        landed.gate_required = true;
        assert!(matches!(
            sign(&landed, "o", 7),
            Err(KernelError::WrongState { .. })
        ));
    }

    #[test]
    fn archiving() {
        assert_eq!(
            archive(&lane(1, LaneState::Behind), 9).unwrap().state,
            LaneState::Archived
        );
        assert!(archive(&lane(1, LaneState::Landing), 9).is_err());
    }

    #[test]
    fn enqueue_and_plan_land() {
        assert!(can_enqueue(&lane(1, LaneState::Ready)).is_ok());
        assert_eq!(
            can_enqueue(&lane(1, LaneState::Pushed)),
            Err(KernelError::WrongState {
                lane: 1,
                state: LaneState::Pushed,
                expected: "READY"
            })
        );
        let mut l = lane(3, LaneState::Ready);
        l.intent = "feat: rss\nmore detail".into();
        let p = plan_land(&l, &project(), 77).unwrap();
        assert_eq!(p.lane.state, LaneState::Landing);
        assert_eq!(p.lane.updated_at, 77);
        assert_eq!(p.message, "Land lane #3 [T-1] by claude-A: feat: rss");
        assert_eq!(
            (
                p.integration_branch.as_str(),
                p.lane_branch.as_str(),
                p.head.as_str()
            ),
            ("main", "main", "aaa")
        );
        assert_eq!(p.token_ttl_sec, LAND_TOKEN_TTL_SEC);
        let mut headless = lane(3, LaneState::Ready);
        headless.head = None;
        assert!(matches!(
            plan_land(&headless, &project(), 1),
            Err(KernelError::InvalidInput(_))
        ));
        assert!(plan_land(&lane(3, LaneState::Pushed), &project(), 1).is_err());
    }

    #[test]
    fn land_results() {
        let l = lane(1, LaneState::Landing);
        let ok = Proof {
            integration_head: "m1".into(),
            is_ancestor: true,
        };
        let landed = apply_land_result(&l, &WireResult::Clean { sha: "m1".into() }, Some(&ok), 5).unwrap();
        assert_eq!(
            (landed.state, landed.landed_sha.as_deref()),
            (LaneState::Landed, Some("m1"))
        );
        assert_eq!(landed.merge_preview, Some(MergePreview::Clean));

        let bad = Proof {
            integration_head: "zzz".into(),
            is_ancestor: false,
        };
        let failed = apply_land_result(&l, &WireResult::Clean { sha: "m1".into() }, Some(&bad), 5).unwrap();
        assert_eq!(failed.state, LaneState::Failed);
        assert_eq!(
            failed.failure.as_deref(),
            Some("landed proof failed: lane head is not an ancestor of integration head zzz")
        );
        let unread = apply_land_result(&l, &WireResult::Clean { sha: "m1".into() }, None, 5).unwrap();
        assert!(unread.failure.unwrap().ends_with("(unread)"));

        let behind = apply_land_result(
            &l,
            &WireResult::Conflict {
                files: vec!["a.ts".into()],
            },
            None,
            5,
        )
        .unwrap();
        assert_eq!(behind.state, LaneState::Behind);
        assert_eq!(behind.conflict_files, Some(vec!["a.ts".to_string()]));
        assert_eq!(behind.merge_preview, Some(MergePreview::Conflict));

        let err = apply_land_result(
            &l,
            &WireResult::Error {
                message: "boom".into(),
            },
            None,
            5,
        )
        .unwrap();
        assert_eq!(
            (err.state, err.failure.as_deref()),
            (LaneState::Failed, Some("boom"))
        );

        assert_eq!(
            apply_land_result(
                &lane(1, LaneState::Ready),
                &WireResult::Error { message: "x".into() },
                None,
                5
            ),
            Err(KernelError::WrongState {
                lane: 1,
                state: LaneState::Ready,
                expected: "LANDING"
            })
        );
    }

    fn task() -> Task {
        Task {
            id: "T-1".into(),
            project_name: "demo".into(),
            title: "t".into(),
            winner_lane: None,
        }
    }

    #[test]
    fn picking_winner() {
        let mut other_task = lane(9, LaneState::Ready);
        other_task.task_id = "T-2".into();
        let lanes = vec![
            lane(2, LaneState::Pushed),
            lane(1, LaneState::Ready),
            lane(3, LaneState::Landed),
            lane(4, LaneState::Landing),
            lane(5, LaneState::Behind),
            other_task,
        ];
        let p = pick_winner(&task(), &lanes, 1).unwrap();
        assert_eq!(p.winner, 1);
        assert_eq!(p.archive, vec![2, 5]);
        assert_eq!(p.task.winner_lane, Some(1));

        assert!(matches!(
            pick_winner(&task(), &lanes, 9),
            Err(KernelError::NotFound(_))
        ));
        assert!(matches!(
            pick_winner(&task(), &lanes, 2),
            Err(KernelError::WrongState { .. })
        ));
        let mut decided = task();
        decided.winner_lane = Some(2);
        assert!(matches!(
            pick_winner(&decided, &lanes, 1),
            Err(KernelError::InvalidInput(_))
        ));
        decided.winner_lane = Some(1);
        assert!(pick_winner(&decided, &lanes, 1).is_ok());
    }

    #[test]
    fn queue_ordering() {
        let q = vec![
            QueueEntry {
                lane_id: 7,
                enqueued_at: 20,
            },
            QueueEntry {
                lane_id: 5,
                enqueued_at: 10,
            },
            QueueEntry {
                lane_id: 3,
                enqueued_at: 20,
            },
        ];
        assert_eq!(queue_order(&q), vec![5, 3, 7]);
        assert_eq!(next_in_queue(&q), Some(5));
        assert_eq!(next_in_queue(&[]), None);
        assert_eq!(queue_position(&q, 7), Some(2));
        assert_eq!(queue_position(&q, 99), None);
    }

    #[test]
    fn compare_scores_and_orders() {
        let mut good = lane(1, LaneState::Ready);
        good.merge_preview = Some(MergePreview::Clean);
        good.touched = vec!["a".into(), "b".into()];
        let mut drifty = lane(2, LaneState::Pushed);
        drifty.drift = vec!["x".into()];
        drifty.merge_preview = Some(MergePreview::Conflict);
        drifty.ledger = LedgerStatus::default();
        let mut tie = lane(3, LaneState::Pushed);
        tie.merge_preview = Some(MergePreview::Unknown);
        let checks = vec![
            check(1, "unit", CheckStatus::Pass, 2),
            check(1, "unit", CheckStatus::Fail, 1),
            check(1, "lint", CheckStatus::Pending, 1),
            check(2, "unit", CheckStatus::Fail, 1),
            check(3, "unit", CheckStatus::Pass, 1),
        ];
        let rows = compare(&[drifty, tie, good], &checks);
        let ids: Vec<LaneId> = rows.iter().map(|r| r.lane_id).collect();
        assert_eq!(ids, vec![1, 3, 2]);
        let first = &rows[0];
        assert_eq!(
            (first.checks_passed, first.checks_failed, first.checks_pending),
            (1, 0, 1)
        );
        assert_eq!(
            (first.touched_count, first.claims_kept, first.ledger_ok),
            (2, true, true)
        );
        assert_eq!(first.score, 10 + 5 + 5);
        let last = &rows[2];
        assert_eq!(
            (last.drift_count, last.claims_kept, last.ledger_ok),
            (1, false, false)
        );
        assert_eq!(last.score, -10 - 5 - 10);
        assert_eq!(rows[1].score, 10 + 5);
    }
}

//! Readiness evaluation: is a lane eligible to be queued for landing?

use serde::{Deserialize, Serialize};

use crate::domain::{CheckResult, CheckStatus, Lane, LaneState, ProjectPolicy};
use crate::error::KernelError;
use crate::state::transition;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "code", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Reason {
    WrongState { state: LaneState },
    NoPush,
    CheckMissing { name: String },
    CheckFailing { name: String },
    CheckPending { name: String },
    IntentMissing,
    HandoffMissing,
    Drift { paths: Vec<String> },
    GateUnsigned,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Readiness {
    pub ready: bool,
    pub reasons: Vec<Reason>,
}

/// Latest result (by `at`, later wins ties) of check `name` valid for this lane's current head.
pub(crate) fn latest<'a>(checks: &'a [CheckResult], lane: &Lane, name: &str) -> Option<&'a CheckResult> {
    checks
        .iter()
        .filter(|c| c.lane_id == lane.id && c.name == name)
        .filter(|c| c.head.is_none() || c.head == lane.head)
        .max_by_key(|c| c.at)
}

/// READY iff: lane pushed, all required checks pass, intent + handoff ledger present,
/// no drift (unless `allow_drift`), and any required gate is signed.
pub fn evaluate(lane: &Lane, checks: &[CheckResult], project: &ProjectPolicy) -> Readiness {
    let mut reasons = Vec::new();
    if !matches!(lane.state, LaneState::Pushed | LaneState::Ready) {
        reasons.push(Reason::WrongState { state: lane.state });
    }
    if lane.head.is_none() {
        reasons.push(Reason::NoPush);
    }
    for name in &project.required_checks {
        match latest(checks, lane, name).map(|c| c.status) {
            None => reasons.push(Reason::CheckMissing { name: name.clone() }),
            Some(CheckStatus::Fail) => reasons.push(Reason::CheckFailing { name: name.clone() }),
            Some(CheckStatus::Pending) => reasons.push(Reason::CheckPending { name: name.clone() }),
            Some(CheckStatus::Pass) => {}
        }
    }
    if !lane.ledger.intent {
        reasons.push(Reason::IntentMissing);
    }
    if !lane.ledger.handoff {
        reasons.push(Reason::HandoffMissing);
    }
    if !lane.drift.is_empty() && !lane.allow_drift {
        reasons.push(Reason::Drift {
            paths: lane.drift.clone(),
        });
    }
    if lane.gate_required && lane.gate_signed_by.is_none() {
        reasons.push(Reason::GateUnsigned);
    }
    Readiness {
        ready: reasons.is_empty(),
        reasons,
    }
}

/// Move a PUSHED lane to READY (or a READY lane back to PUSHED) according to `readiness`.
pub fn settle(lane: &Lane, readiness: &Readiness, now: i64) -> Result<Lane, KernelError> {
    let target = match (lane.state, readiness.ready) {
        (LaneState::Pushed, true) | (LaneState::Ready, true) => LaneState::Ready,
        (LaneState::Pushed, false) | (LaneState::Ready, false) => LaneState::Pushed,
        (state, _) => {
            return Err(KernelError::WrongState {
                lane: lane.id,
                state,
                expected: "PUSHED or READY",
            })
        }
    };
    let mut next = lane.clone();
    if target != lane.state {
        next.state = transition(lane.state, target)?;
        next.updated_at = now;
    }
    Ok(next)
}

#[cfg(test)]
pub(crate) mod fixtures {
    use crate::domain::*;

    pub fn lane(id: LaneId, state: LaneState) -> Lane {
        Lane {
            id,
            task_id: "T-1".into(),
            agent: "claude-A".into(),
            intent: "do the thing".into(),
            repo: RepoRef {
                name: format!("demo-l{id}"),
                remote: format!("https://x/{id}.git"),
            },
            branch: "main".into(),
            state,
            head: Some("aaa".into()),
            base: "000".into(),
            claims: vec!["src/rss/**".into()],
            touched: vec![],
            drift: vec![],
            overlaps: vec![],
            gate_required: false,
            gate_signed_by: None,
            landed_sha: None,
            conflict_files: None,
            merge_preview: None,
            ledger: LedgerStatus {
                intent: true,
                handoff: true,
                ..Default::default()
            },
            allow_drift: false,
            failure: None,
            token_id: None,
            token_expires: None,
            opened_at: 1,
            updated_at: 1,
        }
    }

    pub fn project() -> ProjectPolicy {
        ProjectPolicy {
            name: "demo".into(),
            integration_branch: "main".into(),
            lane_mode: LaneMode::Fork,
            gated_paths: vec!["wrangler.jsonc".into(), "src/db/**".into()],
            required_checks: vec!["unit".into()],
        }
    }

    pub fn check(lane_id: LaneId, name: &str, status: CheckStatus, at: i64) -> CheckResult {
        CheckResult {
            lane_id,
            name: name.into(),
            status,
            url: None,
            head: None,
            at,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::fixtures::*;
    use super::*;

    fn pass(at: i64) -> Vec<CheckResult> {
        vec![check(1, "unit", CheckStatus::Pass, at)]
    }

    #[test]
    fn ready_when_everything_holds() {
        let r = evaluate(&lane(1, LaneState::Pushed), &pass(5), &project());
        assert_eq!(
            r,
            Readiness {
                ready: true,
                reasons: vec![]
            }
        );
    }

    #[test]
    fn collects_every_reason() {
        let mut l = lane(1, LaneState::Open);
        l.head = None;
        l.ledger = Default::default();
        l.drift = vec!["src/db/x".into()];
        l.gate_required = true;
        let r = evaluate(&l, &[], &project());
        assert!(!r.ready);
        assert_eq!(
            r.reasons,
            vec![
                Reason::WrongState {
                    state: LaneState::Open
                },
                Reason::NoPush,
                Reason::CheckMissing { name: "unit".into() },
                Reason::IntentMissing,
                Reason::HandoffMissing,
                Reason::Drift {
                    paths: vec!["src/db/x".into()]
                },
                Reason::GateUnsigned,
            ]
        );
    }

    #[test]
    fn check_statuses_and_latest_wins() {
        let l = lane(1, LaneState::Pushed);
        let failing = vec![check(1, "unit", CheckStatus::Fail, 9)];
        assert_eq!(
            evaluate(&l, &failing, &project()).reasons,
            vec![Reason::CheckFailing { name: "unit".into() }]
        );
        let pending = vec![check(1, "unit", CheckStatus::Pending, 9)];
        assert_eq!(
            evaluate(&l, &pending, &project()).reasons,
            vec![Reason::CheckPending { name: "unit".into() }]
        );
        // an older failure is superseded by a newer pass; other lanes' checks are ignored
        let mixed = vec![
            check(1, "unit", CheckStatus::Fail, 1),
            check(1, "unit", CheckStatus::Pass, 2),
            check(2, "unit", CheckStatus::Fail, 3),
        ];
        assert!(evaluate(&l, &mixed, &project()).ready);
    }

    #[test]
    fn checks_bound_to_an_old_head_do_not_count() {
        let l = lane(1, LaneState::Pushed); // head "aaa"
        let mut stale = check(1, "unit", CheckStatus::Pass, 5);
        stale.head = Some("old".into());
        assert_eq!(
            evaluate(&l, &[stale], &project()).reasons,
            vec![Reason::CheckMissing { name: "unit".into() }]
        );
        let mut fresh = check(1, "unit", CheckStatus::Pass, 5);
        fresh.head = Some("aaa".into());
        assert!(evaluate(&l, &[fresh], &project()).ready);
    }

    #[test]
    fn drift_allowed_and_gate_signed() {
        let mut l = lane(1, LaneState::Ready);
        l.drift = vec!["x".into()];
        l.allow_drift = true;
        l.gate_required = true;
        l.gate_signed_by = Some("owner".into());
        assert!(evaluate(&l, &pass(1), &project()).ready);
    }

    #[test]
    fn settle_promotes_demotes_and_rejects() {
        let ready = Readiness {
            ready: true,
            reasons: vec![],
        };
        let not = Readiness {
            ready: false,
            reasons: vec![Reason::NoPush],
        };
        let up = settle(&lane(1, LaneState::Pushed), &ready, 9).unwrap();
        assert_eq!((up.state, up.updated_at), (LaneState::Ready, 9));
        let same = settle(&lane(1, LaneState::Ready), &ready, 9).unwrap();
        assert_eq!((same.state, same.updated_at), (LaneState::Ready, 1));
        let down = settle(&lane(1, LaneState::Ready), &not, 9).unwrap();
        assert_eq!(down.state, LaneState::Pushed);
        let still = settle(&lane(1, LaneState::Pushed), &not, 9).unwrap();
        assert_eq!((still.state, still.updated_at), (LaneState::Pushed, 1));
        assert_eq!(
            settle(&lane(1, LaneState::Landed), &ready, 9),
            Err(KernelError::WrongState {
                lane: 1,
                state: LaneState::Landed,
                expected: "PUSHED or READY"
            })
        );
    }
}

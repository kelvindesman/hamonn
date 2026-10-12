//! The JSON boundary. `call(name, json) -> json` is the single entry point exposed to the
//! TS shell (through wasm-bindgen). Keeping it in plain Rust means the whole boundary is
//! unit-tested natively; `wasm.rs` is a 3-line shim.

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use crate::claims;
use crate::domain::*;
use crate::error::KernelError;
use crate::evaluate::{self, Readiness};
use crate::ledger;
use crate::lifecycle::{self, LaneSummary, OpenRequest, Proof, PushFacts, WireResult};
use crate::state;

fn run<I, O>(input: &str, f: impl FnOnce(I) -> Result<O, KernelError>) -> Result<String, KernelError>
where
    I: DeserializeOwned,
    O: Serialize,
{
    let parsed: I = serde_json::from_str(input)?;
    Ok(serde_json::to_string(&f(parsed)?)?)
}

#[derive(Deserialize)]
struct TransitionIn {
    from: LaneState,
    to: LaneState,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlanOpenIn {
    req: OpenRequest,
    #[serde(default)]
    open_lanes: Vec<LaneSummary>,
}
#[derive(Deserialize)]
struct ApplyPushIn {
    lane: Lane,
    push: PushFacts,
    project: ProjectPolicy,
}
#[derive(Deserialize)]
struct EvaluateIn {
    lane: Lane,
    #[serde(default)]
    checks: Vec<CheckResult>,
    project: ProjectPolicy,
}
#[derive(Deserialize)]
struct SettleIn {
    lane: Lane,
    readiness: Readiness,
    now: i64,
}
#[derive(Deserialize)]
struct SignIn {
    lane: Lane,
    by: String,
    now: i64,
}
#[derive(Deserialize)]
struct LaneNowIn {
    lane: Lane,
    now: i64,
}
#[derive(Deserialize)]
struct LaneIn {
    lane: Lane,
}
#[derive(Deserialize)]
struct PlanLandIn {
    lane: Lane,
    project: ProjectPolicy,
    now: i64,
}
#[derive(Deserialize)]
struct ApplyLandIn {
    lane: Lane,
    result: WireResult,
    #[serde(default)]
    proof: Option<Proof>,
    now: i64,
}
#[derive(Deserialize)]
struct PickIn {
    task: Task,
    #[serde(default)]
    lanes: Vec<Lane>,
    winner: LaneId,
}
#[derive(Deserialize)]
struct QueueIn {
    #[serde(default)]
    queue: Vec<QueueEntry>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct QueuePosIn {
    #[serde(default)]
    queue: Vec<QueueEntry>,
    lane_id: LaneId,
}
#[derive(Deserialize)]
struct OverlapIn {
    a: Vec<String>,
    b: Vec<String>,
}
#[derive(Deserialize)]
struct DriftIn {
    touched: Vec<String>,
    claims: Vec<String>,
}
#[derive(Deserialize)]
struct MatchesIn {
    path: String,
    glob: String,
}
#[derive(Deserialize)]
struct LedgerIn {
    #[serde(default)]
    intent: Option<String>,
    #[serde(default)]
    handoff: Option<String>,
    #[serde(default)]
    evidence: Option<String>,
}
#[derive(Deserialize)]
struct CompareIn {
    #[serde(default)]
    lanes: Vec<Lane>,
    #[serde(default)]
    checks: Vec<CheckResult>,
}

/// Every exported kernel function name, in documentation order.
pub const FUNCTIONS: &[&str] = &[
    "transition",
    "planOpen",
    "applyPush",
    "evaluate",
    "settle",
    "sign",
    "archive",
    "canEnqueue",
    "planLand",
    "applyLandResult",
    "pickWinner",
    "queueOrder",
    "nextInQueue",
    "queuePosition",
    "claimsOverlap",
    "drift",
    "matches",
    "parseLedger",
    "compare",
];

pub fn call(name: &str, input: &str) -> Result<String, KernelError> {
    match name {
        "transition" => run(input, |i: TransitionIn| state::transition(i.from, i.to)),
        "planOpen" => run(input, |i: PlanOpenIn| lifecycle::plan_open(&i.req, &i.open_lanes)),
        "applyPush" => run(input, |i: ApplyPushIn| {
            lifecycle::apply_push(&i.lane, &i.push, &i.project)
        }),
        "evaluate" => run(input, |i: EvaluateIn| {
            Ok(evaluate::evaluate(&i.lane, &i.checks, &i.project))
        }),
        "settle" => run(input, |i: SettleIn| {
            evaluate::settle(&i.lane, &i.readiness, i.now)
        }),
        "sign" => run(input, |i: SignIn| lifecycle::sign(&i.lane, &i.by, i.now)),
        "archive" => run(input, |i: LaneNowIn| lifecycle::archive(&i.lane, i.now)),
        "canEnqueue" => run(input, |i: LaneIn| lifecycle::can_enqueue(&i.lane).map(|()| true)),
        "planLand" => run(input, |i: PlanLandIn| {
            lifecycle::plan_land(&i.lane, &i.project, i.now)
        }),
        "applyLandResult" => run(input, |i: ApplyLandIn| {
            lifecycle::apply_land_result(&i.lane, &i.result, i.proof.as_ref(), i.now)
        }),
        "pickWinner" => run(input, |i: PickIn| {
            lifecycle::pick_winner(&i.task, &i.lanes, i.winner)
        }),
        "queueOrder" => run(input, |i: QueueIn| Ok(lifecycle::queue_order(&i.queue))),
        "nextInQueue" => run(input, |i: QueueIn| Ok(lifecycle::next_in_queue(&i.queue))),
        "queuePosition" => run(input, |i: QueuePosIn| {
            Ok(lifecycle::queue_position(&i.queue, i.lane_id))
        }),
        "claimsOverlap" => run(input, |i: OverlapIn| Ok(claims::claims_overlap(&i.a, &i.b))),
        "drift" => run(input, |i: DriftIn| Ok(claims::drift(&i.touched, &i.claims))),
        "matches" => run(input, |i: MatchesIn| Ok(claims::matches(&i.path, &i.glob))),
        "parseLedger" => run(input, |i: LedgerIn| {
            Ok(ledger::parse_ledger(
                i.intent.as_deref(),
                i.handoff.as_deref(),
                i.evidence.as_deref(),
            ))
        }),
        "compare" => run(input, |i: CompareIn| Ok(lifecycle::compare(&i.lanes, &i.checks))),
        other => Err(KernelError::UnknownFunction(other.to_string())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_function_and_bad_json() {
        assert_eq!(
            call("nope", "{}"),
            Err(KernelError::UnknownFunction("nope".into()))
        );
        assert!(matches!(call("transition", "{"), Err(KernelError::Json(_))));
        assert!(matches!(
            call("transition", r#"{"from":"OPEN","to":"BOGUS"}"#),
            Err(KernelError::Json(_))
        ));
    }

    #[test]
    fn kernel_errors_propagate() {
        let e = call("transition", r#"{"from":"LANDED","to":"PUSHED"}"#).unwrap_err();
        assert_eq!(e.to_string(), "INVALID_TRANSITION: Landed -> Pushed");
    }

    #[test]
    fn simple_calls_round_trip() {
        assert_eq!(
            call("transition", r#"{"from":"OPEN","to":"PUSHED"}"#).unwrap(),
            r#""PUSHED""#
        );
        assert_eq!(
            call("claimsOverlap", r#"{"a":["src/**"],"b":["src/x"]}"#).unwrap(),
            "true"
        );
        assert_eq!(call("matches", r#"{"path":"a/b","glob":"a/*"}"#).unwrap(), "true");
        assert_eq!(
            call("drift", r#"{"touched":["a","b"],"claims":["a"]}"#).unwrap(),
            r#"["b"]"#
        );
        assert_eq!(call("queueOrder", r#"{}"#).unwrap(), "[]");
        assert_eq!(
            call("nextInQueue", r#"{"queue":[{"laneId":2,"enqueuedAt":1}]}"#).unwrap(),
            "2"
        );
        assert_eq!(call("nextInQueue", r#"{}"#).unwrap(), "null");
        assert_eq!(call("queuePosition", r#"{"laneId":2}"#).unwrap(), "null");
        assert_eq!(
            call("parseLedger", r#"{"intent":"x"}"#).unwrap(),
            r#"{"intent":true,"handoff":false,"evidence":false,"handoffTooLong":false}"#
        );
        assert_eq!(call("compare", "{}").unwrap(), "[]");
    }

    #[test]
    fn every_listed_function_is_dispatched() {
        for name in FUNCTIONS {
            // `{}` is invalid input for every function that needs fields, but must never be
            // reported as an unknown function.
            let r = call(name, "{}");
            assert!(
                !matches!(r, Err(KernelError::UnknownFunction(_))),
                "{name} not dispatched"
            );
        }
    }
}

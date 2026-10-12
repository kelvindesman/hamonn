//! Cross-language test vectors. `cases()` is the single source; `render_all()` runs each case
//! through `api::call` and serialises `{fn, input, output | error}`. The committed files in
//! `tests/vectors/` must equal `render_all()` (checked by a test) and are replayed from TS
//! against the compiled wasm, proving the boundary is lossless.

use serde_json::{json, Value};

use crate::api::call;

pub struct Case {
    pub name: &'static str,
    pub function: &'static str,
    pub input: Value,
}

fn lane(id: u64, state: &str) -> Value {
    json!({
        "id": id, "taskId": "T-17", "agent": "claude-A", "intent": "feat: rss",
        "repo": {"name": format!("demo-l{id}"), "remote": format!("https://x/{id}.git")},
        "branch": "main", "state": state, "head": "aaa", "base": "000",
        "claims": ["src/rss/**"], "touched": [], "drift": [], "overlaps": [],
        "gateRequired": false, "ledger": {"intent": true, "handoff": true, "evidence": false, "handoffTooLong": false},
        "allowDrift": false, "openedAt": 1, "updatedAt": 1
    })
}

fn project() -> Value {
    json!({
        "name": "demo", "integrationBranch": "main", "laneMode": "fork",
        "gatedPaths": ["wrangler.jsonc", "src/db/**"], "requiredChecks": ["unit"]
    })
}

pub fn cases() -> Vec<Case> {
    let ledger_ok = json!({"intent": true, "handoff": true, "evidence": false, "handoffTooLong": false});
    vec![
        Case {
            name: "transition-ok",
            function: "transition",
            input: json!({"from": "OPEN", "to": "PUSHED"}),
        },
        Case {
            name: "transition-invalid",
            function: "transition",
            input: json!({"from": "LANDED", "to": "PUSHED"}),
        },
        Case {
            name: "plan-open-overlap",
            function: "planOpen",
            input: json!({
                "req": {
                    "project": project(), "laneId": 44, "taskId": "T-17", "agent": "claude-C",
                    "intent": "feat: rss", "claims": ["src/rss/**"], "base": "base0", "now": 100
                },
                "openLanes": [
                    {"id": 40, "taskId": "T-17", "state": "READY", "claims": ["src/rss/**"]},
                    {"id": 41, "taskId": "T-18", "state": "PUSHED", "claims": ["src/cron/**"]}
                ]
            }),
        },
        Case {
            name: "apply-push-drift-gate",
            function: "applyPush",
            input: json!({
                "lane": lane(42, "OPEN"),
                "push": {"head": "bbb", "touched": ["src/rss/a.ts", "src/db/x.ts", ".lane/intent.md"], "ledger": ledger_ok, "now": 50},
                "project": project()
            }),
        },
        Case {
            name: "evaluate-not-ready",
            function: "evaluate",
            input: json!({"lane": lane(42, "PUSHED"), "checks": [], "project": project()}),
        },
        Case {
            name: "evaluate-ready",
            function: "evaluate",
            input: json!({
                "lane": lane(42, "PUSHED"),
                "checks": [{"laneId": 42, "name": "unit", "status": "pass", "at": 5}],
                "project": project()
            }),
        },
        Case {
            name: "settle-promote",
            function: "settle",
            input: json!({"lane": lane(42, "PUSHED"), "readiness": {"ready": true, "reasons": []}, "now": 9}),
        },
        Case {
            name: "sign-gate",
            function: "sign",
            input: {
                let mut l = lane(42, "PUSHED");
                l["gateRequired"] = json!(true);
                json!({"lane": l, "by": "owner", "now": 7})
            },
        },
        Case {
            name: "archive",
            function: "archive",
            input: json!({"lane": lane(42, "BEHIND"), "now": 9}),
        },
        Case {
            name: "can-enqueue",
            function: "canEnqueue",
            input: json!({"lane": lane(42, "READY")}),
        },
        Case {
            name: "plan-land",
            function: "planLand",
            input: json!({"lane": lane(42, "READY"), "project": project(), "now": 77}),
        },
        Case {
            name: "land-clean",
            function: "applyLandResult",
            input: json!({
                "lane": lane(42, "LANDING"), "result": {"kind": "clean", "sha": "m1"},
                "proof": {"integrationHead": "m1", "isAncestor": true}, "now": 5
            }),
        },
        Case {
            name: "land-conflict",
            function: "applyLandResult",
            input: json!({
                "lane": lane(42, "LANDING"), "result": {"kind": "conflict", "files": ["src/db/x.ts"]}, "now": 5
            }),
        },
        Case {
            name: "pick-winner",
            function: "pickWinner",
            input: json!({
                "task": {"id": "T-17", "projectName": "demo", "title": "rss"},
                "lanes": [lane(40, "READY"), lane(44, "PUSHED")], "winner": 40
            }),
        },
        Case {
            name: "queue-order",
            function: "queueOrder",
            input: json!({"queue": [{"laneId": 7, "enqueuedAt": 20}, {"laneId": 5, "enqueuedAt": 10}]}),
        },
        Case {
            name: "claims-overlap",
            function: "claimsOverlap",
            input: json!({"a": ["src/rss/**"], "b": ["src/rss/feed.ts"]}),
        },
        Case {
            name: "matches-glob",
            function: "matches",
            input: json!({"path": "src/a/b.ts", "glob": "src/**/b.ts"}),
        },
        Case {
            name: "drift",
            function: "drift",
            input: json!({"touched": ["src/rss/a.ts", "src/db/x.ts", ".lane/handoff.md"], "claims": ["src/rss/"]}),
        },
        Case {
            name: "parse-ledger",
            function: "parseLedger",
            input: json!({"intent": "do x", "handoff": "a\nb\n", "evidence": ""}),
        },
        Case {
            name: "compare",
            function: "compare",
            input: json!({
                "lanes": [lane(40, "READY"), lane(44, "PUSHED")],
                "checks": [{"laneId": 40, "name": "unit", "status": "pass", "at": 1}]
            }),
        },
    ]
}

/// `(file name, pretty JSON body)` for every case.
pub fn render_all() -> Vec<(String, String)> {
    cases()
        .into_iter()
        .map(|c| {
            let input = serde_json::to_string(&c.input).expect("input serialises");
            let mut doc = json!({"fn": c.function, "input": c.input});
            match call(c.function, &input) {
                Ok(out) => doc["output"] = serde_json::from_str(&out).expect("kernel emits JSON"),
                Err(e) => doc["error"] = json!(e.code()),
            }
            (
                format!("{}.json", c.name),
                serde_json::to_string_pretty(&doc).expect("doc serialises") + "\n",
            )
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn committed_vectors_are_current() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/vectors");
        for (file, body) in render_all() {
            let on_disk = std::fs::read_to_string(dir.join(&file))
                .expect("missing vector file; run `cargo run --bin gen-vectors`");
            assert_eq!(
                on_disk, body,
                "stale vector {file}; run `cargo run --bin gen-vectors`"
            );
        }
    }

    #[test]
    fn covers_every_exported_function_except_helpers() {
        let used: Vec<&str> = cases().iter().map(|c| c.function).collect();
        for f in crate::api::FUNCTIONS {
            assert!(
                used.contains(f) || *f == "nextInQueue" || *f == "queuePosition",
                "no vector for {f}"
            );
        }
    }

    #[test]
    fn error_cases_record_a_code() {
        let rendered = render_all();
        let (_, body) = rendered
            .iter()
            .find(|(f, _)| f == "transition-invalid.json")
            .unwrap();
        assert!(body.contains(r#""error": "INVALID_TRANSITION""#));
    }
}

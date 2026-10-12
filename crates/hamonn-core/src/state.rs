//! Table-driven lane state machine.

use crate::domain::LaneState::{self, *};
use crate::error::KernelError;

/// Allowed outgoing edges per state. This table *is* the spec.
pub fn allowed(from: LaneState) -> &'static [LaneState] {
    match from {
        Open => &[Pushed, Archived],
        Pushed => &[Pushed, Ready, Archived],
        Ready => &[Pushed, Landing, Archived],
        Landing => &[Landed, Behind, Failed],
        Behind => &[Pushed, Archived],
        Failed => &[Pushed, Archived],
        Landed => &[],
        Archived => &[],
    }
}

pub fn can_transition(from: LaneState, to: LaneState) -> bool {
    allowed(from).contains(&to)
}

pub fn transition(from: LaneState, to: LaneState) -> Result<LaneState, KernelError> {
    if can_transition(from, to) {
        Ok(to)
    } else {
        Err(KernelError::InvalidTransition { from, to })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    const ALL: [LaneState; 8] = [Open, Pushed, Ready, Landing, Landed, Behind, Archived, Failed];

    #[test]
    fn exact_table() {
        assert_eq!(allowed(Open), &[Pushed, Archived]);
        assert_eq!(allowed(Pushed), &[Pushed, Ready, Archived]);
        assert_eq!(allowed(Ready), &[Pushed, Landing, Archived]);
        assert_eq!(allowed(Landing), &[Landed, Behind, Failed]);
        assert_eq!(allowed(Behind), &[Pushed, Archived]);
        assert_eq!(allowed(Failed), &[Pushed, Archived]);
        assert!(allowed(Landed).is_empty());
        assert!(allowed(Archived).is_empty());
    }

    #[test]
    fn terminal_states_have_no_edges() {
        for s in ALL {
            assert_eq!(s.is_terminal(), allowed(s).is_empty());
        }
    }

    #[test]
    fn ok_and_err() {
        assert_eq!(transition(Open, Pushed), Ok(Pushed));
        assert_eq!(
            transition(Landed, Pushed),
            Err(KernelError::InvalidTransition {
                from: Landed,
                to: Pushed
            })
        );
    }

    fn any_state() -> impl Strategy<Value = LaneState> {
        (0..ALL.len()).prop_map(|i| ALL[i])
    }

    proptest! {
        /// `transition` is total: it always returns, and agrees with the table.
        #[test]
        fn transition_is_total(a in any_state(), b in any_state()) {
            let r = transition(a, b);
            prop_assert_eq!(r.is_ok(), allowed(a).contains(&b));
            if let Ok(s) = r { prop_assert_eq!(s, b); }
        }
    }
}

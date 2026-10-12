//! Kernel error type. Every fallible kernel function returns `Result<_, KernelError>`.

use std::fmt;

use crate::domain::{LaneId, LaneState};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KernelError {
    /// The lane state machine has no edge `from -> to`.
    InvalidTransition { from: LaneState, to: LaneState },
    /// The caller supplied input that violates a documented precondition.
    InvalidInput(String),
    /// The lane is in a state that does not permit the requested operation.
    WrongState {
        lane: LaneId,
        state: LaneState,
        expected: &'static str,
    },
    /// A referenced entity is not part of the supplied facts.
    NotFound(String),
    /// `call` was given a function name the kernel does not export.
    UnknownFunction(String),
    /// JSON (de)serialisation failed at the boundary.
    Json(String),
}

impl KernelError {
    /// Stable machine-readable code, surfaced to the shell as the error prefix.
    pub fn code(&self) -> &'static str {
        match self {
            KernelError::InvalidTransition { .. } => "INVALID_TRANSITION",
            KernelError::InvalidInput(_) => "INVALID_INPUT",
            KernelError::WrongState { .. } => "WRONG_STATE",
            KernelError::NotFound(_) => "NOT_FOUND",
            KernelError::UnknownFunction(_) => "UNKNOWN_FUNCTION",
            KernelError::Json(_) => "JSON",
        }
    }
}

impl fmt::Display for KernelError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: ", self.code())?;
        match self {
            KernelError::InvalidTransition { from, to } => write!(f, "{from:?} -> {to:?}"),
            KernelError::InvalidInput(m) | KernelError::NotFound(m) | KernelError::Json(m) => {
                write!(f, "{m}")
            }
            KernelError::WrongState {
                lane,
                state,
                expected,
            } => {
                write!(f, "lane #{lane} is {state:?}, expected {expected}")
            }
            KernelError::UnknownFunction(n) => write!(f, "{n}"),
        }
    }
}

impl std::error::Error for KernelError {}

impl From<serde_json::Error> for KernelError {
    fn from(e: serde_json::Error) -> Self {
        KernelError::Json(e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_and_code_for_every_variant() {
        let cases = [
            (KernelError::InvalidInput("bad".into()), "INVALID_INPUT: bad"),
            (KernelError::NotFound("lane #3".into()), "NOT_FOUND: lane #3"),
            (KernelError::Json("eof".into()), "JSON: eof"),
            (
                KernelError::UnknownFunction("zap".into()),
                "UNKNOWN_FUNCTION: zap",
            ),
            (
                KernelError::WrongState {
                    lane: 4,
                    state: LaneState::Open,
                    expected: "READY",
                },
                "WRONG_STATE: lane #4 is Open, expected READY",
            ),
            (
                KernelError::InvalidTransition {
                    from: LaneState::Open,
                    to: LaneState::Landed,
                },
                "INVALID_TRANSITION: Open -> Landed",
            ),
        ];
        for (err, text) in cases {
            assert_eq!(err.to_string(), text);
            assert!(text.starts_with(err.code()));
        }
    }
}

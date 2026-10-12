//! In-repo ledger (`.lane/{intent,handoff,evidence}.md`) parsing.

use crate::domain::LedgerStatus;

/// A handoff longer than this many non-empty lines is flagged `handoff_too_long`.
pub const MAX_HANDOFF_LINES: usize = 10;

fn non_empty_lines(s: &str) -> usize {
    s.lines().filter(|l| !l.trim().is_empty()).count()
}

fn present(s: Option<&str>) -> bool {
    s.is_some_and(|t| !t.trim().is_empty())
}

pub fn parse_ledger(intent: Option<&str>, handoff: Option<&str>, evidence: Option<&str>) -> LedgerStatus {
    let handoff_present = present(handoff);
    let handoff_lines = handoff.filter(|_| handoff_present).map(non_empty_lines);
    LedgerStatus {
        intent: present(intent),
        handoff: handoff_present,
        evidence: present(evidence),
        handoff_lines,
        handoff_too_long: handoff_lines.is_some_and(|n| n > MAX_HANDOFF_LINES),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_and_blank_files() {
        let l = parse_ledger(None, Some("  \n\n"), Some(""));
        assert_eq!(l, LedgerStatus::default());
    }

    #[test]
    fn present_files() {
        let l = parse_ledger(Some("do x"), Some("a\n\nb\n"), Some("ok"));
        assert!(l.intent && l.handoff && l.evidence);
        assert_eq!(l.handoff_lines, Some(2));
        assert!(!l.handoff_too_long);
    }

    #[test]
    fn handoff_length_boundary() {
        let ten = "x\n".repeat(10);
        let eleven = "x\n".repeat(11);
        assert!(!parse_ledger(None, Some(&ten), None).handoff_too_long);
        assert!(parse_ledger(None, Some(&eleven), None).handoff_too_long);
    }
}

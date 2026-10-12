//! Claim globs: matching, overlap heuristic and drift detection.
//!
//! Glob dialect: `?` one non-`/` char, `*` any run of non-`/` chars, `**` any run of chars
//! (including `/`), `**/` zero or more directories. A claim ending in `/` means "everything
//! below" (`dir/` == `dir/**`). A leading `./` is ignored.
//!
//! Overlap is a *conservative heuristic* (documented limitation): a literal path overlaps a
//! glob iff the glob matches it; two globs overlap iff their literal prefixes (the text before
//! the first wildcard) are prefix-related. False positives are possible, false negatives are not.

/// Paths under this prefix are the in-repo ledger and never count as drift.
pub const LEDGER_PREFIX: &str = ".lane/";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Tok {
    Lit(char),
    Any,
    Star,
    DStar,
    DStarSlash,
}

fn tokenize(glob: &str) -> Vec<Tok> {
    let c: Vec<char> = glob.chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < c.len() {
        match c[i] {
            '*' => {
                let mut j = i;
                while j < c.len() && c[j] == '*' {
                    j += 1;
                }
                if j - i >= 2 {
                    if j < c.len() && c[j] == '/' {
                        out.push(Tok::DStarSlash);
                        i = j + 1;
                    } else {
                        out.push(Tok::DStar);
                        i = j;
                    }
                } else {
                    out.push(Tok::Star);
                    i = j;
                }
            }
            '?' => {
                out.push(Tok::Any);
                i += 1;
            }
            ch => {
                out.push(Tok::Lit(ch));
                i += 1;
            }
        }
    }
    out
}

/// Canonical form of a claim: trimmed, no leading `./`, trailing `/` expanded to `/**`.
/// Returns `None` for empty claims.
pub fn normalize(glob: &str) -> Option<String> {
    let g = glob.trim();
    let g = g.strip_prefix("./").unwrap_or(g);
    if g.is_empty() {
        None
    } else if g.ends_with('/') {
        Some(format!("{g}**"))
    } else {
        Some(g.to_string())
    }
}

/// Does `glob` match the whole of `path`?
pub fn matches(path: &str, glob: &str) -> bool {
    let toks = tokenize(glob);
    let p: Vec<char> = path.chars().collect();
    let (n, m) = (p.len(), toks.len());
    let mut dp = vec![vec![false; n + 1]; m + 1];
    dp[m][n] = true;
    for i in (0..m).rev() {
        for j in (0..=n).rev() {
            dp[i][j] = match toks[i] {
                Tok::Lit(c) => j < n && p[j] == c && dp[i + 1][j + 1],
                Tok::Any => j < n && p[j] != '/' && dp[i + 1][j + 1],
                Tok::Star => dp[i + 1][j] || (j < n && p[j] != '/' && dp[i][j + 1]),
                Tok::DStar => dp[i + 1][j] || (j < n && dp[i][j + 1]),
                Tok::DStarSlash => dp[i + 1][j] || (j..n).any(|k| p[k] == '/' && dp[i + 1][k + 1]),
            };
        }
    }
    dp[0][0]
}

/// Does `path` match any of `globs` (normalised)?
pub fn matches_any(path: &str, globs: &[String]) -> bool {
    globs
        .iter()
        .filter_map(|g| normalize(g))
        .any(|g| matches(path, &g))
}

fn is_wild(glob: &str) -> bool {
    glob.contains(['*', '?'])
}

fn static_prefix(glob: &str) -> &str {
    &glob[..glob.find(['*', '?']).unwrap_or(glob.len())]
}

fn globs_overlap(a: &str, b: &str) -> bool {
    match (is_wild(a), is_wild(b)) {
        (false, false) => a == b,
        (false, true) => matches(a, b),
        (true, false) => matches(b, a),
        (true, true) => {
            let (pa, pb) = (static_prefix(a), static_prefix(b));
            pa.starts_with(pb) || pb.starts_with(pa)
        }
    }
}

/// Do two claim sets possibly cover a common path? Symmetric. Empty sets never overlap.
pub fn claims_overlap(a: &[String], b: &[String]) -> bool {
    let a: Vec<String> = a.iter().filter_map(|g| normalize(g)).collect();
    let b: Vec<String> = b.iter().filter_map(|g| normalize(g)).collect();
    a.iter().any(|x| b.iter().any(|y| globs_overlap(x, y)))
}

/// Touched paths that fall outside every claim (ledger paths excepted). Order preserved.
pub fn drift(touched: &[String], claims: &[String]) -> Vec<String> {
    touched
        .iter()
        .filter(|t| !t.starts_with(LEDGER_PREFIX) && !matches_any(t, claims))
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    fn v(xs: &[&str]) -> Vec<String> {
        xs.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn glob_matching() {
        assert!(matches("src/a.ts", "src/*.ts"));
        assert!(!matches("src/x/a.ts", "src/*.ts"));
        assert!(matches("src/x/a.ts", "src/**"));
        assert!(matches("src/x/y/a.ts", "src/**/a.ts"));
        assert!(matches("src/a.ts", "src/**/a.ts"));
        assert!(matches("a.ts", "**/a.ts"));
        assert!(matches("d/e/a.ts", "**/a.ts"));
        assert!(!matches("d/e/b.ts", "**/a.ts"));
        assert!(matches("src/ab", "src/a?"));
        assert!(!matches("src/a/", "src/a?"));
        assert!(!matches("src", "src/**"));
        assert!(matches("wrangler.jsonc", "wrangler.jsonc"));
        assert!(!matches("wrangler.json", "wrangler.jsonc"));
        assert!(matches("y", "***/y"));
        assert!(matches("a/b/y", "***/y"));
    }

    #[test]
    fn normalisation() {
        assert_eq!(normalize("  ./src/rss/ "), Some("src/rss/**".to_string()));
        assert_eq!(normalize("src/a.ts"), Some("src/a.ts".to_string()));
        assert_eq!(normalize("   "), None);
        assert_eq!(normalize("./"), None);
        assert!(matches_any("src/rss/a.ts", &v(&["", "src/rss/"])));
        assert!(!matches_any("src/db/a.ts", &v(&["src/rss/"])));
        assert!(!matches_any("x", &[]));
    }

    #[test]
    fn overlap_cases() {
        assert!(claims_overlap(&v(&["src/rss/**"]), &v(&["src/rss/feed.ts"])));
        assert!(claims_overlap(&v(&["src/rss/feed.ts"]), &v(&["src/rss/**"])));
        assert!(claims_overlap(&v(&["src/rss/**"]), &v(&["src/**"])));
        assert!(claims_overlap(&v(&["src/**"]), &v(&["src/rss/**"])));
        assert!(!claims_overlap(&v(&["src/rss/**"]), &v(&["src/cron/**"])));
        assert!(!claims_overlap(&v(&["src/rss/a.ts"]), &v(&["src/cron/a.ts"])));
        assert!(claims_overlap(&v(&["src/a.ts"]), &v(&["src/a.ts"])));
        assert!(!claims_overlap(&v(&["src/a.ts"]), &v(&["src/b.ts"])));
        assert!(!claims_overlap(&[], &v(&["src/**"])));
        assert!(!claims_overlap(&v(&["src/**"]), &v(&[" "])));
        // documented false positive: both wildcard, prefixes related
        assert!(claims_overlap(&v(&["src/*.ts"]), &v(&["src/db/**"])));
        assert!(claims_overlap(&v(&["**/*.ts"]), &v(&["src/db/x.ts"])));
    }

    #[test]
    fn drift_cases() {
        let claims = v(&["src/rss/**"]);
        let touched = v(&["src/rss/a.ts", "src/db/x.ts", ".lane/handoff.md", "README.md"]);
        assert_eq!(drift(&touched, &claims), v(&["src/db/x.ts", "README.md"]));
        assert!(drift(&v(&[".lane/intent.md"]), &[]).is_empty());
        assert_eq!(drift(&v(&["a"]), &[]), v(&["a"]));
    }

    fn glob_strategy() -> impl Strategy<Value = String> {
        "[ab/*?.]{0,8}"
    }

    proptest! {
        #[test]
        fn overlap_is_symmetric(a in proptest::collection::vec(glob_strategy(), 0..3),
                                b in proptest::collection::vec(glob_strategy(), 0..3)) {
            prop_assert_eq!(claims_overlap(&a, &b), claims_overlap(&b, &a));
        }

        #[test]
        fn drift_is_subset_of_touched(touched in proptest::collection::vec("[ab/.]{0,6}", 0..6),
                                      claims in proptest::collection::vec(glob_strategy(), 0..3)) {
            let d = drift(&touched, &claims);
            prop_assert!(d.iter().all(|p| touched.contains(p)));
        }

        /// A path matched by a claim never overlaps-fails against that claim (no false negatives).
        #[test]
        fn matched_literal_overlaps(path in "[ab/]{1,6}", glob in glob_strategy()) {
            if let Some(g) = normalize(&glob) {
                if !path.ends_with('/') && !is_wild(&path) && matches(&path, &g) {
                    prop_assert!(claims_overlap(std::slice::from_ref(&path), &[glob]));
                }
            }
        }
    }
}

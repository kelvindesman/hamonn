## What & why
<!-- One paragraph. Link the docs/spec.md section this implements. -->

## Checklist
- [ ] Rules live in `crates/hamonn-core` (not the TS shell), with tests; `pnpm vectors` re-run if the kernel changed
- [ ] `pnpm check` passes locally (coverage gates untouched)
- [ ] New adapter? It passes `@hamonn/contract` and `docs/adapters.md` says what is live- vs fixture-tested
- [ ] Changeset added for user-visible changes
- [ ] No secrets, no network in unit tests
- [ ] `fix:` commits carry `Detected-by:` / `Introduced-in:` trailers

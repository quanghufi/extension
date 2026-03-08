# Responses — Round 6 (Formal Codex Review via Hub)

**Date:** 2026-03-08
**Reviewer:** Codex (gpt-5.4 / reasoning: xhigh)
**Source:** `.feedback/inbox-v6.md` (via `hub-codex-review.js` dogfooding)
**Scope:** Uncommitted changes (scripts/e2e-test.js, scripts/hub-codex-review.js, package.json)

---

## Triage Results: 3/3 Accepted

### FB-20260308-E2E-001 — `e2e` npm scripts hang forever
- **Priority:** P1 (Critical — blocks CI usage)
- **Verdict:** ✅ ACCEPTED
- **Analysis:** Codex is correct. Both `e2e-test.js` and `hub-codex-review.js` use `await new Promise(() => {})` to keep the server alive for dashboard viewing, which means `npm run e2e` hangs. For CI, we need an `--auto-exit` flag or a timeout-based exit.
- **Plan:** Add `--auto-exit` flag that exits after finalization. Default to keeping server alive (for interactive use). CI scripts use `--auto-exit`.

### FB-20260308-E2E-002 — SIGINT handler missing `cleanup()`
- **Priority:** P2 (High — resource leak)
- **Verdict:** ✅ ACCEPTED
- **Analysis:** Valid. The `process.on('SIGINT')` handler in `e2e-test.js` calls `process.exit(0)` without invoking `cleanup()`. This leaves behind read-only snapshots and worktrees.
- **Plan:** Move cleanup into SIGINT handler with error-tolerant execution (try/catch around each cleanup step).

### FB-20260308-SNAP-003 — Dogfooding review runs against live tree
- **Priority:** P2 (High — design contract violation)
- **Verdict:** ✅ ACCEPTED
- **Analysis:** Valid and important. `hub-codex-review.js` launches Codex directly on `PROJECT_DIR` without creating a snapshot first. This violates the Hub's immutable-snapshot contract. During the 2-5 minute review, files could change (autosave, formatters, etc.) making findings inaccurate.
- **Plan:** Add snapshot creation step before launching Codex review. Use `SnapshotManager` to create snapshot, pass snapshot path as `cwd` for Codex.

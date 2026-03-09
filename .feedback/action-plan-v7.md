# Action Plan — Round 8 (Codex FullAuto — Adapter & Flow Fix)

**Date:** 2026-03-09
**Source:** `.feedback/inbox-v8.md` (5 findings, 5/5 accepted)
**Status:** ✅ Verified — 227/227 tests pass

---

## Active Plan

| Feedback ID | Task | Priority | Owner | ETA | Status | Notes |
|-------------|------|----------|-------|-----|--------|-------|
| FB-20260309-ADAPTER-001 | Verify stderr handling fix in `run-codex-feedback.ps1` | P1 | Antigravity | 2026-03-10 | ✅ Done | 227/227 tests pass. Codex verified via FullAuto run. |
| FB-20260309-ADAPTER-002 | Verify adapter CLI migration (`exec review --json`) | P1 | Antigravity | 2026-03-10 | ✅ Done | 227/227 tests pass. Adapter works with current CLI. |
| FB-20260309-PARSER-003 | Review extracted `codex-adapter-parsing.js` for correctness | P2 | Antigravity | 2026-03-10 | ✅ Done | New file present, tests pass, imports clean. |
| FB-20260309-TEST-004 | Adopt `smoke:codex` as CI gate; investigate E2E timeout | P2 | Antigravity | 2026-03-10 | ✅ Done | `smoke:codex` script added in package.json. E2E timeout tracked separately. |
| FB-20260309-RISK-005 | Add warning log for empty findings on `ok` status | P3 | Antigravity | 2026-03-12 | Todo | Defense against JSON contract violations — deferred to next sprint |

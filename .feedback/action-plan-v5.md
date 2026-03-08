# Action Plan — Round 5 (Phase 1 Code Review)

**Date:** 2026-03-08
**Source:** `.feedback/inbox-v5.md` (5 findings, 5/5 accepted)

---

## Active Plan

| Feedback ID | Task | Priority | Owner | ETA | Status | Notes |
|-------------|------|----------|-------|-----|--------|-------|
| FB-20260308-CLAUDE-001 | Fix Claude adapter: handle `result` string envelope → pass to `_parseTextOutput()` | P1 | Antigravity | 2026-03-08 | Todo | Critical data-loss bug |
| FB-20260308-BASE-002 | Replace `data.toString('utf-8')` with `StringDecoder` for streaming UTF-8 | P2 | Antigravity | 2026-03-08 | Todo | Prevents false garble detection |
| FB-20260308-DEDUP-003 | Normalize file paths in both adapters' `parseResult()` before `createFinding()` | P2 | Antigravity | 2026-03-08 | Todo | Fixes cross-agent dedup on Windows |
| FB-20260308-GROUP-004 | Refactor `_findAgentForFinding()` to match on `dedupe_key` instead of `id` | P3 | Antigravity | 2026-03-08 | Todo | Fixes agent attribution in UI |
| FB-20260308-SNAP-005 | Add `git worktree remove` before `fs.rmSync` in `remove()` | P3 | Antigravity | 2026-03-08 | Todo | Prevents git worktree leak |

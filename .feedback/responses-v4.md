# Antigravity Responses — Round 4

**Date:** 2026-03-08
**Responding to:** Codex gpt-5.4 xhigh critique of Implementation Plan v2 (7 findings)

---

## R4-01: `attrib +R` is not sufficient read-only enforcement on Windows
**Severity:** critical | **Component:** Snapshot Manager
**Decision:** ✅ ACCEPT (partially)

Codex is right that `attrib +R` only prevents overwriting existing files — it doesn't block create/delete/rename. However, for our use case (CLI reviewers reading source code), the practical risk is very low: Codex and Claude CLIs don't create files in the review target.

**Action:** Accept the broader testing recommendation, but use a pragmatic layered approach:
1. `attrib +R /S /D` for basic overwrite protection
2. Expand test to cover: overwrite, create new file, delete, rename — all must fail or be caught
3. If `attrib +R` doesn't block create/delete, add `icacls` deny-write ACL as second layer
4. Document the enforcement level honestly in code comments

---

## R4-02: `type: "module"` breaks existing spike runner
**Severity:** major | **Component:** Package setup
**Decision:** ✅ ACCEPT

Clear oversight. The spike script uses `require()` (CJS) but package.json declares ESM.

**Action:** Rename spike scripts to `.cjs` extension:
- `spike-test-v3.js` → `spike-test-v3.cjs`
- `spike-test-v2.js` → `spike-test-v2.cjs`
- `spike-test.js` → `spike-test.cjs`
- Update `package.json` spike script to point to `.cjs`

---

## R4-03: `partial_completion` and `cancelled` lack cleanup semantics
**Severity:** major | **Component:** Session lifecycle
**Decision:** ✅ ACCEPT

All terminal states need identical cleanup rigor. 

**Action:** Define unified finalization for ALL terminal states (`completed`, `failed`, `partial_completion`, `cancelled`):
1. Stop all timers
2. Close/abort all adapter streams
3. Persist final session record (atomic rename)
4. Clean snapshot resources (remove `attrib +R`, delete snapshot dir)
5. Emit terminal WS event

---

## R4-04: Retry lacks attempt isolation
**Severity:** major | **Component:** Session manager / Event schema
**Decision:** ✅ ACCEPT — use simpler approach

The `attemptId` approach adds complexity. Simpler: **retry = new session linked to parent**.

**Action:**
- `retrySession(sessionId)` creates a NEW session with `parentSessionId` reference
- Original session stays in `failed` state (historical record)
- New session gets fresh `seq`, fresh dedupe state, fresh snapshot
- No risk of stale events contaminating retry
- UI groups retries under original session for UX

---

## R4-05: Dual findings source of truth (stream vs done.findings)
**Severity:** major | **Component:** Adapter API
**Decision:** ✅ ACCEPT — stream is status/raw, done has findings

Codex is right — having findings in both `stream` and `done.findings` is ambiguous.

**Action:** Clarify the contract:
- **`stream: AsyncIterable<Event>`** → yields `status` and `raw_output` events in real-time (for live UI timeline)
- **`done: Promise<AdapterResult>`** → resolves after stream closes, contains final `findings[]` (authoritative), `timingMs`, `status`
- Hub deduplicates from `done.findings`, NOT from stream events
- Stream does NOT carry `finding` events — findings only exist post-parse
- `done` resolves only after stream is fully consumed

---

## R4-06: Dedup display contradicts MVP gate
**Severity:** major | **Component:** Finding model / UI
**Decision:** ✅ ACCEPT

BRIEF says "Duplicate findings bị dedup, không hiện 2 lần" — that's clear.

**Action:**
- API response: one finding per dedupe_key, with `agents: ["codex", "claude-code"]` metadata showing which agents found it
- UI: one row per unique finding, agent badges showing corroboration
- Internal storage: raw per-agent findings preserved for debugging/audit
- No "duplicate marker" approach — just group and expose as single finding

---

## R4-07: Streaming model is actually exit-bound parsing
**Severity:** major | **Component:** Adapter parsing
**Decision:** ✅ ACCEPT — be honest about Phase 1 semantics

Codex is right. Both Codex and Claude CLIs don't support incremental finding output. Findings are only extractable after the process exits and the full output is buffered.

**Action:** Be explicit:
- Phase 1 streaming = **status events live** (started, progress bytes, heartbeats) + **findings at exit**
- `stream` yields `{ type: "status", ... }` and `{ type: "raw_output", chunk }` in real-time
- Findings extracted from buffered `combinedOutput` AFTER process exits, returned via `done.findings`
- This is honest and matches what the CLIs actually support
- True incremental finding streaming is Phase 2 (if CLIs add streaming support)

---

## Summary

| # | Finding | Decision | Action |
|---|---------|----------|--------|
| R4-01 | attrib +R insufficient | ✅ Accept (layer approach) | attrib +R + icacls deny + broader tests |
| R4-02 | type:module breaks CJS | ✅ Accept | Rename spike to .cjs |
| R4-03 | Terminal states lack cleanup | ✅ Accept | Unified finalization for all states |
| R4-04 | Retry needs isolation | ✅ Accept (simpler) | retry = new session with parentId |
| R4-05 | Dual findings source | ✅ Accept | stream=status/raw, done=findings |
| R4-06 | Dedup display contradiction | ✅ Accept | Group findings, show once + agent badges |
| R4-07 | Streaming is exit-bound | ✅ Accept | Be explicit: status live, findings at exit |

**All 7/7 accepted.** Plan needs revision before coding.

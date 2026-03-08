# Action Plan — Round 4

**Date:** 2026-03-08
**Source:** `.feedback/inbox-v4.md` (7 findings, 7/7 accepted)

---

## Priority 1: Critical — Fix Before Coding

### 1.1 Snapshot Enforcement Upgrade (R4-01)
- [ ] Keep `attrib +R /S /D` as base layer
- [ ] Add `icacls <path> /deny Everyone:(W,D)` as second layer for create/delete/rename protection
- [ ] Expand test to: overwrite, create new file, delete, rename — all from child process
- [ ] Document enforcement level in code

---

## Priority 2: Major — Fix in Plan Before Coding

### 2.1 Fix CJS/ESM Conflict (R4-02)
- [ ] Rename all spike scripts: `*.js` → `*.cjs`
- [ ] Update `package.json` spike script path

### 2.2 Unified Terminal State Cleanup (R4-03)
- [ ] Define finalization for ALL terminal states: `completed`, `failed`, `partial_completion`, `cancelled`
- [ ] Each state: stop timers → close streams → persist session → clean snapshot
- [ ] Add this as explicit section in plan

### 2.3 Retry = New Session (R4-04)
- [ ] `retrySession(sessionId)` → creates NEW session with `parentSessionId`
- [ ] Original stays in failed state
- [ ] Fresh seq, dedupe, snapshot
- [ ] UI groups retries under parent

### 2.4 Clarify Adapter Contract (R4-05 + R4-07)
- [ ] `stream` → yields `status` and `raw_output` events (real-time)
- [ ] `done` → resolves after stream closes, contains authoritative `findings[]` + `timingMs`
- [ ] No `finding` events in stream — findings only from `done.findings`
- [ ] `done` settles only after stream fully consumed
- [ ] Be explicit: Phase 1 = status live, findings at exit

### 2.5 Dedup Display Fix (R4-06)
- [ ] API: one finding per dedupe_key, `agents: [...]` metadata
- [ ] UI: one row per finding, agent badges
- [ ] Internal: raw per-agent findings preserved

---

## Next Steps

1. Update `implementation_plan.md` with all 7 fixes
2. Begin Phase 1 coding — no more critique rounds needed (4 rounds is sufficient)

# Action Plan — Round 3 (Codex Phase 1 Critique)

**Date:** 2026-03-09
**Source:** `.feedback/inbox-v3.md` (10 findings, 10/10 accepted)

---

## Priority 0: Resolve Before Updating Plan

### 0.1 MVP Scope Resolution (Finding 10)
- [ ] Confirm BRIEF MVP scope: cancel, retry, reconnect, dedup, history, >100KB streaming
- [ ] Move items from Phase 2 → Phase 1 as needed (cancel, retry, reconnect per BRIEF)
- [ ] Update implementation plan section headers to match resolved scope

---

## Priority 1: Critical — Must Fix Before Phase 1 Coding

### 1.1 Snapshot Immutability (Finding 1)
- [ ] After `robocopy /MIR`, run `attrib +R /S /D <snapshot_path>` 
- [ ] Add integration test: child process attempts write inside snapshot → must get `EPERM`
- [ ] Remove "or at least separate" hedging language from plan

### 1.2 Adapter API Redesign: Streaming (Finding 2)
- [ ] Change adapter return type to `{ stream: AsyncIterable<Event>, done: Promise<AdapterResult> }`
- [ ] Session manager consumes `stream` incrementally
- [ ] WebSocket broadcasts events as they arrive (not after adapter finishes)
- [ ] `done` promise resolves after adapter process exits
- [ ] Update state machine documentation to show streaming data flow

### 1.3 Dedupe Strategy Fix (Finding 3)
- [ ] Remove `severity` from dedupe fingerprint
- [ ] Normalize `summary` before hashing (lowercase, strip punctuation)
- [ ] Store raw per-agent findings — never destructive merge
- [ ] Merge only when BOTH normalized location AND normalized issue match
- [ ] Defer auto-merge to Phase 2 per BRIEF phasing

### 1.4 Path Normalization (Finding 4)
- [ ] Create `normalizeFindingPath(rawPath, snapshotRoot)` utility
- [ ] Normalize: resolve → reject traversal → `/` separators → lowercase on Windows → strip `./`
- [ ] Apply normalization BEFORE hashing or storage
- [ ] Add unit tests: `src\server.js` and `src/server.js` must hash identically

### 1.5 Event Ordering (Finding 5)
- [ ] Hub assigns session-global monotonic `seq` (not adapters)
- [ ] Adapters emit events without `seq` — hub stamps on receipt
- [ ] All events go through single serial queue (async mutex or promise chain)
- [ ] Atomic temp-file-plus-rename for mid-session persistence

---

## Priority 2: High — Fix Before Integration Testing

### 2.1 Error Propagation Policy (Finding 6)
- [ ] Infrastructure failures (snapshot/storage/server) → session `failed`
- [ ] Adapter failures → adapter status `failed`, preserve partial findings
- [ ] Add `partial_completion` state to session state machine
- [ ] Final result includes per-adapter status object
- [ ] Update plan with explicit error policy section

### 2.2 WebSocket Backpressure (Finding 7)
- [ ] Session-scoped subscriptions: `{ subscribe: sessionId }`
- [ ] Per-client bounded send queue (100 messages or 1MB)
- [ ] Monitor `ws.bufferedAmount` — disconnect slow consumers
- [ ] Coalesce heartbeats for slow clients
- [ ] No global broadcast — only to subscribed sessions

### 2.3 Windows Cancellation (Finding 8)
- [ ] Graceful: `child.kill()` first
- [ ] After 5s timeout: `taskkill /T /F /PID <pid>` for process tree kill
- [ ] Integration test: spawn → cancel → verify no orphan processes via `tasklist`
- [ ] Use `{ detached: false }` in spawn options

### 2.4 Timeout as Config (Finding 9)
- [ ] Make timeouts configurable per adapter (not hardcoded)
- [ ] Log timing telemetry: `{ firstByteMs, lastIdleGapMs, totalMs }`
- [ ] Add test fixtures for slow-output and large-output scenarios
- [ ] Document current values as defaults, not validated thresholds

---

## Priority 3: Update Plan & Verification

### 3.1 Verification Section Overhaul (Finding 10)
- [ ] Add cancel mid-review integration test
- [ ] Add retry after adapter failure test
- [ ] Add >100KB streaming test (no truncation, no OOM)
- [ ] Add parser accuracy test against captured CLI output fixtures
- [ ] Use `curl.exe` or `Invoke-RestMethod` (not PowerShell `curl` alias)
- [ ] Update implementation_plan.md verification section to match MVP scope

---

## Next Steps

1. Revise `implementation_plan.md` with all Priority 0+1 changes
2. Re-submit to Codex for Round 4 critique
3. Begin Phase 1 coding only after plan passes critique with 0 critical findings

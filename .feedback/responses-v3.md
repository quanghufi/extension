# Antigravity Responses — Round 3

**Date:** 2026-03-09
**Responding to:** Codex gpt-5.4 xhigh critique of Phase 1 Implementation Plan (10 findings)

---

## Finding 1: Snapshot doesn't enforce read-only review
**Category:** correctness | **Severity:** critical
**Decision:** ✅ ACCEPT

Codex is right — `git worktree add --detach` + `robocopy /MIR` gives you a *separate* copy, not an *immutable* copy. The test plan saying "read-only (or at least separate from source)" is a cop-out that directly contradicts BRIEF's "technical enforcement" requirement.

**Action:** After creating the snapshot:
1. Recursively set read-only attributes via `attrib +R /S /D <snapshot_path>`
2. Test enforcement: spawn a child process that attempts `fs.writeFileSync()` inside the snapshot — must throw `EPERM`
3. Remove the "or at least separate" language from the plan

---

## Finding 2: Adapter API is batch-oriented but state machines require streaming
**Category:** architecture | **Severity:** high
**Decision:** ✅ ACCEPT

This is a fundamental design mismatch. `execute(prompt, opts) → { events[], rawResult }` implies events are collected then returned, but `running.onEvent()` and the WebSocket UI need live events.

**Action:** Redesign adapter return contract:
- Adapters return `{ stream: AsyncIterable<Event>, done: Promise<AdapterResult> }`
- Session manager consumes `stream` incrementally, dedupes per-event, broadcasts via WebSocket
- `done` resolves when adapter exits — session manager finalizes aggregation after all `done` promises settle
- `events[]` in the final result becomes a post-hoc snapshot of all streamed events

---

## Finding 3: Dedupe/merge strategy has false negatives AND false positives
**Category:** correctness | **Severity:** high
**Decision:** ✅ ACCEPT

Two bugs in one:
- **False negative:** Same bug with different wording → different hash → missed duplicate
- **False positive:** Two different bugs on the same line → merged into one → lost finding

**Action:**
1. Remove `severity` from dedupe fingerprint — severity is presentation, not identity
2. Normalize `summary` before hashing (lowercase, strip punctuation)
3. Keep raw per-agent findings in storage — never destructively merge
4. Merge logic: only merge when BOTH normalized location AND normalized issue fingerprint match
5. "Higher severity wins" is a display-layer decision, not a storage-layer mutation
6. Move auto-merge from Phase 1 to Phase 2, per BRIEF's phasing (Phase 1 = schema + basic dedup, Phase 2 = auto-merge)

---

## Finding 4: Path handling breaks dedupe on Windows
**Category:** windows-compat | **Severity:** high
**Decision:** ✅ ACCEPT

Classic Windows gotcha. One adapter emits `src\server.js`, another emits `src/server.js`, and they hash differently.

**Action:** Add `normalizeFindingPath(rawPath, snapshotRoot)`:
1. Resolve against snapshot root
2. Reject paths that escape snapshot (path traversal)
3. Normalize separators to `/`
4. Case-fold on Windows (`path.toLowerCase()`)
5. Strip leading `./` or `/`
6. Apply normalization BEFORE any hashing or storage

---

## Finding 5: Event ordering is racy — seq assignment undefined
**Category:** correctness | **Severity:** high
**Decision:** ✅ ACCEPT

With parallel adapters and no defined `seq` assigner, event ordering is nondeterministic. The BRIEF defines `seq` in the event schema but the plan never says who assigns it.

**Action:**
1. Hub (Session Manager) assigns session-global monotonic `seq` — NOT the adapters
2. All events for a session go through a single serial queue (async mutex or in-order `Promise` chain)
3. Adapters emit events without `seq` — hub stamps `seq` on receipt
4. If persisting state mid-session, use atomic temp-file-plus-rename writes
5. Dedupe runs after seq assignment, so ordering is deterministic

---

## Finding 6: Error propagation undefined — partial results at risk
**Category:** missing | **Severity:** high
**Decision:** ✅ ACCEPT

No policy for "Codex failed, Claude succeeded" means we could either lose useful partial results or let one adapter failure kill the session.

**Action:** Define explicit error policy:
- **Infrastructure failures** (snapshot, storage, server) → fail the session entirely
- **Adapter failures** (non-zero exit, timeout, crash) → mark adapter as `failed`, preserve any findings already streamed
- Session terminal state: `partial_completion` when ≥1 adapter succeeds but not all
- Final result includes per-adapter status: `{ codex: 'completed', claude: 'failed' }`
- Add `partial_completion` state to the session state machine between `running` and `completed`

---

## Finding 7: WebSocket has no backpressure or subscription model
**Category:** performance | **Severity:** high
**Decision:** ✅ ACCEPT

BRIEF explicitly flags >100KB streaming as an MVP concern. Broadcasting all events to all clients without filtering or queue bounds is a recipe for slow-client cascading failures.

**Action:**
1. WebSocket subscriptions are session-scoped: client sends `{ subscribe: sessionId }` on connect
2. Per-client bounded send queue (e.g., 100 messages or 1MB)
3. Coalesce heartbeats/status updates when client is slow (skip intermediate heartbeats)
4. Monitor `ws.bufferedAmount` — disconnect slow consumers when buffer exceeds threshold
5. No global broadcast — only send events matching subscribed session(s)

---

## Finding 8: Cancellation is POSIX-style, not Windows-safe
**Category:** windows-compat | **Severity:** high
**Decision:** ✅ ACCEPT

`SIGTERM → SIGKILL` is a Unix contract. On Windows, `child.kill()` sends `SIGTERM` which doesn't exist as a clean signal, and child process trees can survive.

**Action:**
1. Graceful attempt: `child.kill()` (sends `SIGTERM` equivalent on Windows)
2. After timeout (e.g., 5s): `taskkill /T /F /PID <pid>` to kill the full process tree
3. Verify: integration test spawns a child, cancels, then checks `tasklist` for orphan processes
4. Use `cross-spawn` + `child_process.spawn()` with `{ detached: false }` to keep process tree attached

---

## Finding 9: Timeout values are presets, not proven production numbers
**Category:** correctness | **Severity:** medium
**Decision:** ✅ ACCEPT

The spike proved these values don't fail for one small prompt on one machine. That's necessary but not sufficient.

**Action:**
1. Make timeouts configurable per adapter (not hardcoded constants)
2. Log actual timing telemetry: `{ firstByteMs, lastIdleGapMs, totalMs }` per adapter run
3. Add test fixtures for slow-output and large-output scenarios before finalizing defaults
4. Document that current values are *defaults*, not validated production thresholds
5. Revisit after Phase 1 has real usage data

---

## Finding 10: Verification plan doesn't cover stated MVP
**Category:** testing | **Severity:** high
**Decision:** ✅ ACCEPT

The BRIEF puts cancel, retry, dedup, history, and >100KB streaming in MVP scope, but the Phase 1 plan's verification section only tests a subset. Phase 2 still lists "Cancel / retry / reconnect handling" — that's a scope contradiction.

**Action:**
1. **Resolve scope first:** Move cancel, retry, reconnect to Phase 1 MVP since BRIEF requires it
2. Add integration tests for:
   - Cancel mid-review → verify cleanup and no orphan processes
   - Retry after adapter failure → verify session recovers
   - >100KB output → verify streaming doesn't truncate or OOM
   - Parser accuracy against captured CLI output fixtures
3. Use Windows-native HTTP tools for API tests (`curl.exe` or `Invoke-RestMethod`, NOT PowerShell's `curl` alias which is `Invoke-WebRequest`)
4. Update the verification section of the implementation plan to match MVP scope

---

## Summary: 10/10 ACCEPTED

This is the most thorough critique yet. Codex found real architectural flaws that would have caused production bugs:

1. **Snapshot immutability** — was "separate" not "read-only" (critical)
2. **Streaming vs batch** — adapter API didn't match the state machines (architectural)
3. **Dedupe bugs** — would miss real duplicates AND merge different findings (correctness)
4. **Windows paths** — would silently break dedup (platform)
5. **Race conditions** — seq ordering was undefined under concurrency (correctness)
6. **Error propagation** — partial results would be lost (missing)
7. **WebSocket backpressure** — no plan for slow clients or large output (performance)
8. **Windows cancellation** — POSIX signals don't work here (platform)
9. **Timeout validation** — treated presets as proven values (medium, but real)
10. **Scope gaps** — verification plan didn't cover MVP (testing)

The Phase 1 implementation plan needs revision before coding starts. All 10 items feed into `action-plan-v3.md`.

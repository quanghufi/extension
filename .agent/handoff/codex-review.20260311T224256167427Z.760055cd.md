# Codex Review

## Overview
- Status: has_findings
- Summary: Found 5 material issues in the `Session` changes, mainly around backward compatibility, inconsistent derived state, and incorrect agent accounting.
- Findings: 5

## Key Findings

### 1. [HIGH] Completed sessions saved before this schema change will load with empty merge/group data
- Location: src/hub/session.js:243
- Why it matters: `SessionStore.load()` hydrates old JSON through `Session.fromJSON()`. If an older completed session file lacks `mergedFindings`, `mergeStats`, or grouped findings, this code leaves those fields empty instead of rebuilding them from `events` and `allFindings`. The `/api/sessions/:id/findings` response will silently regress for historical evidence already in the repo.
- Recommended fix: After `hydrateSession(session, data)`, detect missing or legacy aggregation fields for terminal sessions and recompute them with `buildFindingAgentMap(session.events, session.allFindings)`, `groupFindings(...)`, and `mergeFindingsSmart(...)`. Add a regression test that round-trips a legacy JSON object containing only `events` and `allFindings` and verifies merged/grouped data is rebuilt.
- Confidence: high

### 2. [MEDIUM] Retry sessions share the parent's `reviewOptions` object by reference
- Location: src/hub/session.js:124
- Why it matters: `createRetry()` is supposed to create an isolated child session, but it passes the parent's `reviewOptions` object straight through. Any later mutation of `child.reviewOptions` will mutate the parent session too, which can leak configuration across rounds and corrupt persisted lineage.
- Recommended fix: Clone `reviewOptions` when constructing a retry session, using `structuredClone` or an equivalent deep-copy for plain JSON data. Add a test that mutates `retry.reviewOptions` and asserts the parent session's `reviewOptions` remains unchanged.
- Confidence: high

### 3. [MEDIUM] Final reconciliation assigns every unfinished agent the total session finding count
- Location: src/hub/session.js:178
- Why it matters: In a multi-agent session, any agent that never emitted a `done` event is rewritten with `findingCount = this.allFindings.length`. That misattributes other agents' findings to failed/cancelled agents and corrupts agent-level telemetry used for review attribution and debugging.
- Recommended fix: Do not copy the global finding total into each unfinished agent. Either preserve the agent's existing `findingCount`, or recompute per-agent counts from `buildFindingAgentMap(this.events, this.allFindings)` and assign only that agent's own count. Add a test with two agents where only one produced findings and verify reconciliation does not give both agents the same total.
- Confidence: high

### 4. [MEDIUM] `displayState` can disagree with the returned `watchdog` snapshot
- Location: src/hub/session.js:211
- Why it matters: `toJSON()` and `toSummaryJSON()` call `getWatchdogStatus()` and then call `getDisplayState()`, which calls `getWatchdogStatus()` again with a fresh `Date.now()`. Near the threshold, one call can return `stalled: false` while the second flips `displayState` to `stalled`, producing self-contradictory API responses and flaky UI behavior.
- Recommended fix: Compute the watchdog object once per serialization path and derive `displayState` from that same object. For example, let `const watchdog = this.getWatchdogStatus(nowMs)` and pass it into a helper like `getDisplayStateFromWatchdog(watchdog)`. Add a test that injects a fixed timestamp and asserts `watchdog.stalled` and `displayState` stay consistent at the threshold boundary.
- Confidence: high

### 5. [LOW] Reconciled agent statuses use undocumented values like `partial_completion` and `cancelled`
- Location: src/hub/session.js:177
- Why it matters: `AgentRegistry` documents `status` as `ok | failed | timeout`, but `_reconcileAgentStates()` writes `partial_completion` and `cancelled` into that field. That creates a persisted schema mismatch and invites downstream code to mishandle agent status values it was never written to understand.
- Recommended fix: Either expand the `AgentState.status` contract everywhere to include these values, or keep `status` within the documented enum and store the session-level closure reason in a separate field. Add a serialization test that verifies reconciled agent records conform to the chosen schema.
- Confidence: medium

## Recommendations
- Backfill grouped/merged findings during `fromJSON()` for legacy completed sessions.
- Make watchdog/display-state derivation use a single timestamp snapshot per response.
- Rework `_reconcileAgentStates()` to preserve or recompute per-agent finding counts instead of copying the session total.
- Deep-clone `reviewOptions` when creating retry sessions to preserve parent/child isolation.
- Align reconciled agent `status` values with the documented persisted schema and add regression coverage.
- Rerun review: yes

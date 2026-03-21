# Codex Review

## Overview
- Status: has_findings
- Summary: I found 6 material issues in the current change set, centered on debate orchestration, the new Claude adapter, and test/flow regressions.
- Findings: 6

## Key Findings

### 1. [HIGH] Claude stream parsing drops NDJSON records when a JSON line is split across process chunks
- Location: src/adapters/claude-code-adapter.js:74
- Why it matters: `claude --output-format stream-json` is a streaming transport; chunk boundaries are arbitrary. Splitting on `\n` inside each chunk means partial JSON objects are discarded permanently, so status updates and assistant/result payloads can vanish nondeterministically in real runs.
- Recommended fix: Introduce per-execution line buffering for Claude NDJSON parsing instead of parsing each raw chunk independently. Keep incomplete trailing data until the next chunk arrives, flush the final buffered line on process end, and add tests that split a single JSON record across multiple chunks.
- Confidence: high

### 2. [HIGH] A debating agent can still act as the final decider despite the independence check
- Location: src/hub/debate-orchestrator.js:599
- Why it matters: `runTieBreakerIfNeeded()` correctly skips tie-break execution when the configured decider is also one of the debating agents, but `resolveFinalFindings()` still passes that same agent as `decider` into `mergeFinalFindings()`. In disputed cases this gives one participant veto power even though the code already recognized that the tie-break was not independent.
- Recommended fix: Only pass `decider` into `mergeFinalFindings()` when you actually received tie-break evaluations from an independent decider. If the decider is also a debating agent, leave `decider` undefined and resolve disputes with the non-decider fallback path. Add a test where `decider` is one of the debating agents and verify no unilateral drop occurs.
- Confidence: high

### 3. [HIGH] `runSession()` still finalizes retries without advancing the collaboration workflow
- Location: src/server.js:187
- Why it matters: The new tests expect rerun sessions to auto-post a `review_summary` and move into `awaiting_antigravity_turn` or `awaiting_resolution`, but the implementation still only calls `session.finalize(...)`. A clean rerun will therefore stay in its initial collab state with no summary message, breaking the Antigravity follow-up path and causing the added `server.test.js` cases to fail.
- Recommended fix: After a successful review completes, detect retry/collab sessions and explicitly sync the collaboration layer: add a `review_summary` message for the reviewer, set `collabState` to `awaiting_antigravity_turn` when findings exist or `awaiting_resolution` when none exist, then persist the updated session. Keep the logic in one place and add assertions against the stored session state/messages.
- Confidence: high

### 4. [MEDIUM] The debate event contract is incomplete: newly declared event types are never emitted
- Location: src/hub/debate-orchestrator.js
- Why it matters: `schema/events.js` now advertises `debate_phase_changed`, `debate_agent_completed`, and `debate_failed`, but the implementation only emits `debate_started` and `debate_resolved`. Any client built against the new event schema will miss phase transitions, per-agent completion, and failure notifications.
- Recommended fix: Emit `debate_phase_changed` whenever the debate state machine transitions, emit `debate_agent_completed` after each agent review/rebuttal/tie-break completes, and emit `debate_failed` in the server/orchestrator failure path before persisting the failed state. Add tests that assert these events appear in `session.events`.
- Confidence: medium

### 5. [MEDIUM] Per-agent debate timeout profiles are declared but never applied
- Location: src/hub/debate-orchestrator.js:266
- Why it matters: The new debate code advertises separate review/eval/rebuttal budgets for `codex` and `claude-code`, but every debate pass still calls `adapter.execute()` with the adapter's default timeouts. In practice debates can run far longer than the configured profile and the new timeout policy is effectively dead code.
- Recommended fix: Thread timeout overrides from `agentProfiles` into debate execution. Either clone adapters with per-pass timeout values or extend `execute()` to accept timeout overrides for review, rebuttal, and tie-break phases. Add a test proving the configured debate profile is what gets used.
- Confidence: high

### 6. [MEDIUM] The updated turn-token requirement breaks existing integration tests and likely legacy callers
- Location: src/hub/session-collab-integration.test.js:94
- Why it matters: `Session.advanceCollabState()` now requires a valid `turnToken` for `review_complete` and `request_response`, but `session-collab-integration.test.js` still calls `review_complete` without passing the token. That means the current suite will fail, and any unchanged callers using the old contract will also start throwing `Invalid turn token`/`No active turn`.
- Recommended fix: Update all `review_complete` and `request_response` call sites and tests to pass the claimed turn token, not just `release_turn`. Add coverage for both the success path with a valid token and the failure path with a missing/invalid token so the new contract is enforced consistently.
- Confidence: high

## Recommendations
- Implement the missing post-review collaboration sync in `src/server.js` so reruns create `review_summary` messages and advance to the correct collab state.
- Rework Claude stream parsing to use buffered NDJSON framing and add chunk-splitting tests.
- Fix debate resolution so only an independent tie-breaker can act as `decider`, then wire the declared debate events into real state transitions and failures.
- Apply `DEBATE_AGENT_PROFILES` to actual debate executions and update all tests/callers for the new turn-token contract.
- Rerun review: yes

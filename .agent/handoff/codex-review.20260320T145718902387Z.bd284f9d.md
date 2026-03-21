# Codex Review

## Overview
- Status: has_findings
- Summary: I found 8 material issues in the current change set, concentrated around the new turn-token enforcement and debate lifecycle handling.
- Findings: 8

## Key Findings

### 1. [HIGH] Debate gating is enforced only in MCP tools; the REST collaboration routes can still mutate a session during an active debate
- Location: src/collab-routes.js:55
- Why it matters: The new debate feature assumes manual collaboration tools are blocked while `debateActive` is true, but `apiPostMessage`, `apiClaimTurn`, `apiAssignAgent`, and `apiAdvanceSession` have no equivalent guard. A dashboard or HTTP client can still change turn ownership or post new messages mid-debate and corrupt the state machine.
- Recommended fix: Add the same `debateActive` guard used in `src/mcp-collab-tools.js` to all REST collaboration endpoints, returning a 409/400 with a clear error when debate is active. Add REST-level tests covering blocked post/claim/assign/advance calls during debate.
- Confidence: high

### 2. [HIGH] REST advance path no longer passes the required turn token, so normal collaboration transitions now fail over HTTP
- Location: src/collab-routes.js:196
- Why it matters: `Session.advanceCollabState()` now enforces turn ownership for `review_complete`, `request_response`, and `release_turn`, but the REST route still calls it with only `payload`. Any UI or client using `/api/sessions/:id/advance` will start getting 400s for the main review flow even when the caller legitimately owns the turn.
- Recommended fix: Parse `turnToken` from the request body and pass it through to `session.advanceCollabState(...)`. Add a regression test that claims a turn via REST, then advances with `review_complete` and `release_turn` using that token.
- Confidence: high

### 3. [HIGH] Expired turns move the session into `awaiting_assignment`, which makes the session unclaimable without manual reassignment
- Location: src/hub/session.js:391
- Why it matters: After TTL expiry, `claimTurn()` only allows the `awaiting_*_turn` and `*_reviewing` states. `expireTurnIfNeeded()` now forces `awaiting_assignment`, so once a turn expires no assigned agent can reclaim it until someone reassigns roles. That is a dead-end state for an otherwise healthy session.
- Recommended fix: On expiry, clear the turn and transition back to the correct waiting state for the previous owner/role, or recompute from existing assignments instead of forcing `awaiting_assignment`. Add a test that expires a claimed turn and then successfully re-claims it without reassignment.
- Confidence: high

### 4. [HIGH] `hub_start_debate` acknowledges success before verifying that every requested agent/decider adapter actually exists
- Location: src/mcp-collab-tools.js:408
- Why it matters: The tool returns "Debate started" immediately, but `runDebate()` later calls `getAdapter()` and will throw if an unknown agent ID was provided. From the client's perspective this is a false success response followed by an asynchronous background failure.
- Recommended fix: Before scheduling `server.runDebate(...)`, validate `agents` and `decider` with `hasAdapter()`/`getAdapter()` and return an MCP error synchronously if any adapter is missing. Add a test that `hub_start_debate` rejects an unknown agent ID instead of reporting success.
- Confidence: high

### 5. [HIGH] Debate failures persist an invalid state name (`debate_failed`) that is outside the declared debate state machine
- Location: src/server.js:258
- Why it matters: `debate-state.js` defines terminal failure as `failed`, and helpers like `isDebateTerminal()` only understand that value. Writing `debate_failed` leaves the session in a state no validator or transition helper recognizes, which can break UI logic and any follow-up processing based on valid debate states.
- Recommended fix: Persist `session.debateState = 'failed'` instead. If you want a distinct event, emit `debate_failed` as an event payload/type, but keep the stored state inside the `DEBATE_STATES` enum. Add a test that forces `runDebate()` to fail and asserts the stored `debateState` is valid.
- Confidence: high

### 6. [MEDIUM] The per-phase debate timeout profiles are dead code, so debates do not use the configured review/eval/rebuttal limits
- Location: src/hub/debate-orchestrator.js:266
- Why it matters: `DEBATE_AGENT_PROFILES` and `this.agentProfiles` suggest debate rounds should run with phase-specific deadlines, but `runReviewPass()` always calls `adapter.execute()` with whatever default timeout the adapter already has. That means the new debate orchestration can hang far longer than the code and tests imply.
- Recommended fix: Either thread the selected phase timeout into execution (for example by constructing a phase-specific adapter wrapper or extending `execute()` to accept overrides) or remove the profile table and its tests so the code no longer advertises behavior it does not implement.
- Confidence: high

### 7. [MEDIUM] Server shutdown ignores active debates because it only waits on sessions whose main state is `running`
- Location: src/server.js:96
- Why it matters: A debate runs while the session's main `state` remains `completed`, so `HubServer.stop()` will skip the wait loop and close the process even if `debateActive` is still true. That can terminate a debate mid-round and leave no terminal debate result persisted.
- Recommended fix: Include `session.debateActive` in the shutdown wait condition, or explicitly cancel/fail active debates before exiting. Add a shutdown test that starts a debate, calls `stop()`, and verifies the debate reaches a persisted terminal state instead of being cut off.
- Confidence: medium

### 8. [MEDIUM] `runDebate()` never removes sessions from `activeSessions`, so debated sessions stay pinned in memory and shadow persisted state forever
- Location: src/server.js:213
- Why it matters: `runSession()` has a `finally` cleanup, but `runDebate()` does not. Over time every debated session remains in the active map, which leaks memory and causes reads to prefer stale in-memory objects over freshly loaded persisted state.
- Recommended fix: Wrap `runDebate()` in a `try/finally` and call `this.activeSessions.delete(sessionId)` in the `finally` block, matching the lifecycle used by `runSession()`. Add a test that `activeSessions` no longer contains the session after debate success and after debate failure.
- Confidence: medium

## Recommendations
- Restore transport parity for the collaboration state machine: pass `turnToken` through REST advance calls and add the same `debateActive` guards to REST routes that MCP already enforces.
- Normalize debate lifecycle handling: store only valid debate states, emit/broadcast a failure event on debate errors, and validate adapters before accepting a debate request.
- Make turn expiry recoverable by returning to the correct waiting state instead of `awaiting_assignment`, then add regression coverage for expiry/reclaim.
- Finish the debate runtime implementation by wiring or removing the advertised timeout profiles, waiting for/canceling active debates on shutdown, and cleaning debated sessions out of `activeSessions` in `finally`.
- Rerun review: yes

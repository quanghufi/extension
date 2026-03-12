# Codex Review

## Overview
- Status: has_findings
- Summary: Found 3 material issues in the collaboration/session changes: fresh sessions never enter a usable collaboration state, state advancement bypasses turn ownership, and collab audit events are not persisted.
- Findings: 3

## Key Findings

### 1. [HIGH] Fresh sessions are created in `draft`, so the new collaboration API is unusable until someone manually reassigns a role
- Location: src/hub/session.js:77
- Why it matters: `Session` now defaults `assignments` to reviewer/responder/decider, but `collabState` still starts as `draft`. Neither normal session creation path calls `initCollab()`. As a result, `claimTurn()` rejects the first reviewer action on every newly created session because it only allows `awaiting_codex_turn` / `awaiting_antigravity_turn`. Retries work, but first-run sessions do not.
- Recommended fix: Initialize the collaboration state when a session is created, not only on retries. Either set `this.collabState = transitionOnAssignments(this.assignments)` in the constructor after `assignments` is initialized, or call `session.initCollab()` in both creation paths (`src/api-routes.js` and `src/mcp-server.js`) before saving/returning the session. Add a regression test that a brand-new session can immediately be claimed by the reviewer without any reassignment step.
- Confidence: high

### 2. [HIGH] `advanceCollabState` can be invoked without owning the claimed turn, which defeats the turn-locking model
- Location: src/hub/session.js:320
- Why it matters: Messages correctly require a valid `turnToken`, but state transitions do not. `advanceCollabState()` validates only role/state, and the REST/MCP `advance` endpoints do not even accept a turn token. Any caller that knows the expected `agentId` can complete reviews, release turns, or request reruns without holding the active claim. That breaks exclusivity and opens the door to racey or spoofed workflow transitions.
- Recommended fix: Extend the advance APIs to accept a `turnToken`, and in `advanceCollabState()` require `ensureTurnOwner(agentId, turnToken)` for all actions that are supposed to happen during an active turn (`review_complete`, `request_response`, `release_turn`, and `request_rerun` when coming from a reviewing state). Also tighten `validateAdvanceAction()` so `request_rerun` from `awaiting_resolution` is limited to the decider. Add tests that advancing without the correct token is rejected.
- Confidence: high

### 3. [MEDIUM] Collaboration events are emitted after persistence, so reloading the session loses the audit trail
- Location: src/collab-routes.js:73
- Why it matters: In the new collab handlers, the mutated session is saved before `message_posted` / `turn_claimed` / `agent_assigned` / `collab_state_changed` / `session_resolved` / `session_closed` events are appended. The in-memory broadcast works, but if the process restarts or a later request reloads the session from disk, those lifecycle events are missing from `session.events`. That creates inconsistent history and breaks any consumer relying on persisted event logs.
- Recommended fix: For every collab mutation handler in `src/collab-routes.js` and the mirrored MCP tool implementations in `src/mcp-collab-tools.js`, append all generated events to the session before calling `server.store.save(session)`. Add a persistence test that performs one collab action, reloads the session from `SessionStore`, and verifies the corresponding lifecycle events are still present.
- Confidence: high

## Recommendations
- Initialize collaboration state on first session creation so default assignments immediately produce `awaiting_codex_turn`.
- Require valid turn ownership for workflow-advancing actions and pass `turnToken` through the REST/MCP advance APIs.
- Persist collab lifecycle events before saving the session, then add reload-based regression tests for the event log.
- Rerun review: yes

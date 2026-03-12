# Codex Review

## Overview
- Status: has_findings
- Summary: I found 4 material issues in the new collaboration/MCP changes: two authorization/state-machine bugs, one initialization regression that leaves new sessions unusable for collaboration, and a test gap that would have caught them.
- Findings: 4

## Key Findings

### 1. [CRITICAL] `release_turn` can be invoked by the wrong agent and can switch the session into the wrong queue
- Location: src/hub/session-collab.js:230
- Why it matters: `validateAdvanceAction()` only checks that the session is in a reviewing state, and `deriveNextCollabState()` uses the caller-supplied `agentId` to choose the next waiting state. Any caller can therefore release someone else’s claimed turn and move the workflow from `codex_reviewing` to `awaiting_antigravity_turn` (or the reverse), corrupting turn ownership and session progression.
- Recommended fix: Change the advance API so `release_turn` requires a `turnToken`, then in `Session.advanceCollabState()` call `ensureTurnOwner(agentId, turnToken)` before allowing `release_turn`. Compute the next waiting state from the actual claimed owner (`this.turn.ownerId`), not from the request payload, and add REST/MCP tests that a non-owner cannot release another agent’s turn.
- Confidence: high

### 2. [HIGH] New sessions are created with default assignments but remain stuck in `draft`
- Location: src/api-routes.js:45
- Why it matters: `Session` starts with `collabState = 'draft'`, but neither `apiCreateSession()` nor `hub_create_review` calls `initCollab()`. As a result, a fresh session advertises collaboration fields but rejects the first `claimTurn()` with `Cannot claim turn in collab state: draft`, which breaks the documented MCP workflow unless assignments are manually rewritten first.
- Recommended fix: Initialize collaboration state when a session is created. Either call `session.initCollab()` in both `apiCreateSession()` and `hub_create_review`, or derive the initial state in the `Session` constructor when assignments already exist. Add coverage for both REST and MCP creation paths asserting that a new session starts in `awaiting_codex_turn` and accepts the first reviewer claim.
- Confidence: high

### 3. [HIGH] `request_response` and `request_rerun` are not restricted to the assigned actor or current turn owner
- Location: src/hub/session-collab.js:194
- Why it matters: The state machine only enforces actor identity for `review_complete`, `resolve`, and `close`. In the current code, any caller can send `request_response` while Codex is reviewing, or `request_rerun` from `awaiting_resolution`, which lets an unrelated agent skip steps or restart the loop without owning the active turn.
- Recommended fix: Tighten `validateAdvanceAction()` so `request_response` is only valid for `assignments.reviewer`, and `request_rerun` is only valid for the responder while reviewing or the decider while awaiting resolution. For reviewer/responder actions, require and verify the active `turnToken` inside `Session.advanceCollabState()`. Add negative tests covering wrong-agent and missing-token calls through the session object and the REST/MCP wrappers.
- Confidence: high

### 4. [MEDIUM] The new MCP/server tests only verify tool registration, not the collaboration behavior that regressed
- Location: src/mcp-server.test.js:72
- Why it matters: `src/mcp-server.test.js` stops at `client.listTools()`, so the broken initial `collabState` and the missing authorization checks on advance actions are not exercised anywhere. These regressions are easy to ship because the current suite proves the schemas exist, not that the workflow is safe or usable.
- Recommended fix: Add end-to-end MCP tests that create a session, assert the initial collab state, claim a turn, reject wrong-agent `request_response`/`request_rerun`/`release_turn` calls, and verify that only the owner with the correct token can advance or release the turn.
- Confidence: high

## Recommendations
- Initialize `collabState` for newly created sessions in both the REST and MCP creation flows.
- Require turn ownership (`turnToken`) for reviewer/responder state transitions, especially `release_turn`, and derive state changes from the actual claimed owner instead of request input.
- Restrict `request_response` and `request_rerun` to the correct assigned roles in the state machine.
- Add REST/MCP integration tests that cover initial state, claim/release, and wrong-agent rejection paths.
- Rerun review: yes

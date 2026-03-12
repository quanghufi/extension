# Codex Review

## Overview
- Status: has_findings
- Summary: Found 7 material issues in the collaboration and MCP integration changes. The highest-risk problems are uninitialized collaboration state on new sessions, missing authorization on state advances, and MCP tool errors being misreported as successful reviews.
- Findings: 7

## Key Findings

### 1. [HIGH] MCP bridge tool failures are treated as successful zero-finding reviews
- Location: src/adapters/mcp-adapter.js:456
- Why it matters: The Python bridge returns tool-level failures via the MCP `isError` flag, but `McpCodexAdapter.execute()` ignores that flag and always continues parsing `structuredContent.review`. If the bridge reports an error payload, the adapter can still return `status: "ok"` with zero findings, masking infrastructure failures as clean reviews.
- Recommended fix: After `callTool()`, check `resultPayload.isError === true` and treat that as an adapter failure. Emit an `error` event with the bridge summary, set adapter status to `failed` or `timeout` as appropriate, and only convert findings when the MCP tool result is not an error and contains a valid `review` object. Add a test that mocks an MCP tool result with `isError: true` and verifies the adapter does not return `ok`.
- Confidence: high

### 2. [HIGH] New review sessions never initialize the collaboration state machine
- Location: src/api-routes.js:45
- Why it matters: Both REST and MCP session creation leave `collabState` at `draft`, but the new docs, tests, and manual demo assume fresh sessions start at `awaiting_codex_turn`. In the current build, the first `claim-turn` call fails until something else mutates assignments, so the collaboration flow is broken from session creation.
- Recommended fix: Call `session.initCollab()` immediately after constructing a new `Session` in both `src/api-routes.js` and `src/mcp-server.js`, before saving or returning the session. Add an integration test that creates a session through each entry point and asserts `collabState === "awaiting_codex_turn"` with default assignments.
- Confidence: high

### 3. [HIGH] Advance actions can be spoofed without owning the current turn
- Location: src/hub/session-collab.js:194
- Why it matters: `Session.addMessage()` enforces turn ownership, but `advanceCollabState()` does not. On top of that, `validateAdvanceAction()` does not check actor identity for `request_response`, `request_rerun`, or `release_turn`. Any caller that knows an `agentId` can move the workflow forward or force a rerun, which is both a correctness bug and an authorization gap.
- Recommended fix: Require turn ownership for all non-decider transition actions. Add a `turnToken` parameter to `Session.advanceCollabState()`, `apiAdvanceSession`, and `hub_advance_session`, call `ensureTurnOwner()` before applying `review_complete`, `request_response`, `request_rerun`, or `release_turn`, and tighten `validateAdvanceAction()` so only the assigned reviewer/responder can perform those actions.
- Confidence: high

### 4. [MEDIUM] The advertised idle timeout and timing metrics are not implemented
- Location: src/adapters/mcp-adapter.js:45
- Why it matters: The adapter config claims a 3-tier timeout (`firstByteMs`, `idleMs`, `hardMs`), but only connect timeout and hard timeout are enforced. `idleMs` is unused, and the returned timing data is hardcoded to zero. A stalled review therefore waits until hard timeout or unrelated watchdog logic, which is a regression from the documented timeout guarantees.
- Recommended fix: Implement an actual idle watchdog for the MCP review path and populate real `timingMs.firstByteMs` / `timingMs.lastIdleGapMs` values. If the SDK path cannot surface progress, add an application-level heartbeat from the Python bridge or route reviews through a subprocess wrapper that can enforce idle timeouts. Add a test that proves an idle review aborts before `hardMs`.
- Confidence: high

### 5. [MEDIUM] Assignments can start collaboration without a decider, leaving sessions impossible to resolve
- Location: src/hub/session-collab.js:120
- Why it matters: `transitionOnAssignments()` only checks reviewer and responder, and `assignAgent()` accepts whatever `agentId` string the caller sends. A caller can assign an empty decider (or clear it later) and still move the session into `awaiting_codex_turn`, but `resolve`/`close` later depend on `assignments.decider`, so the workflow can dead-end.
- Recommended fix: Reject empty `agentId` values in assignment routes and in `Session.assignAgent()`. Update `transitionOnAssignments()` so it only leaves `awaiting_assignment` when reviewer, responder, and decider are all populated, or explicitly auto-fill decider before transitioning. Add tests for blank-role assignments and for resolution after reassignment.
- Confidence: medium

### 6. [MEDIUM] Live UI never shows new collaboration messages, only the synthetic event shell
- Location: src/ui/index.html:660
- Why it matters: The dashboard initially loads messages with `/messages`, but live updates only arrive as `message_posted` events over WebSocket. `handleEvent()` always renders events, and the broadcast payload does not include the message body, so manual collaboration demos miss the actual message content until the page is reloaded.
- Recommended fix: On `message_posted`, either broadcast the full message payload from `apiPostMessage`/`hub_post_message` or have the UI fetch `/api/sessions/:id/messages?afterSeq=...` and call `renderTimelineMessage()` for the newly posted messages. Add a browser-level or integration test that posts a message after the page is loaded and asserts the message content appears in the timeline without refresh.
- Confidence: high

### 7. [LOW] `awaiting_resolution` is styled as a generic awaiting state instead of the resolution state
- Location: src/ui/index.html:555
- Why it matters: The collaboration badge helper checks `state.includes('awaiting')` before the exact `awaiting_resolution` match, so the special resolution styling never appears. This will make the manual UI validation misleading right at the most important handoff point.
- Recommended fix: Reorder `collabBadgeClass()` so the exact `awaiting_resolution` branch is evaluated before the generic `includes('awaiting')` branch, then add a small UI test or helper-unit test covering all badge classes.
- Confidence: high

## Recommendations
- Initialize collaboration state during REST and MCP session creation, then add creation-path tests for the default `awaiting_codex_turn` state.
- Enforce turn-token ownership on collaboration state advances and tighten actor validation for every non-decider action.
- Treat MCP tool-level errors as adapter failures, then implement the missing idle-timeout/timing behavior with regression tests.
- Make live message updates render full collaboration messages in the UI and harden assignment validation so sessions cannot enter an unresolvable state.
- Fix the `awaiting_resolution` badge classification so the manual collaboration demo reflects the actual state.
- Rerun review: yes

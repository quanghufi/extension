# Codex Review

## Overview
- Status: has_findings
- Summary: I found 8 material issues in the new MCP/collaboration changes, including one regression from the token-redaction fix and several state-machine/auth problems that make the collaboration flow unreliable or spoofable.
- Findings: 8

## Key Findings

### 1. [CRITICAL] Redacting turn tokens in `toJSON()` breaks persisted sessions after restart
- Location: src/hub/session.js:423
- Why it matters: `SessionStore.save()` persists `session.toJSON()`. After this change, any claimed turn is saved without `turn.token`, so reloading the session makes every turn-sensitive action fail with `Invalid turn token`. This is a direct regression from the Round 4 redaction fix.
- Recommended fix: Do not use the redacted `toJSON()` output for persistence. Keep `serializeSession()` as the full internal serializer for `SessionStore.save()`, and add a separate API/view serializer that redacts `turn.token` and `messages[*].turnToken` only for external responses. Add a save/load round-trip test that claims a turn, persists, reloads, and successfully posts a turn-bound message with the original token.
- Confidence: high

### 2. [HIGH] The MCP adapter treats tool-level errors as successful reviews
- Location: src/adapters/mcp-adapter.js:441
- Why it matters: After `callTool()`, the adapter parses `structuredContent.review` and unconditionally sets `status = 'ok'`. If the Python bridge returns `{ isError: true, ... }`, the hub still finalizes the session as completed, usually with zero findings, masking review failures as clean runs.
- Recommended fix: Inspect the MCP result for `isError === true` before parsing findings. When set, throw or map it to a failed adapter result using the returned summary/error text. Add a test that a tool error response causes `done.status !== 'ok'` and emits an error event instead of completing successfully.
- Confidence: high

### 3. [HIGH] Default reviewer assignment does not match the actual default review agent
- Location: src/hub/session-collab.js:71
- Why it matters: The collaboration layer defaults the reviewer to `codex`, but new sessions default `agentId` to `mcp-codex`. Even if `collabState` is initialized correctly, the default reviewer cannot claim the turn because the expected agent is wrong out of the box.
- Recommended fix: Align the default reviewer assignment with the session creation defaults. Either change `defaultAssignments().reviewer` to `mcp-codex`, or derive the reviewer assignment from `Session.agentId` when constructing a session. Add a test that a default-created session accepts `claimTurn('mcp-codex')`.
- Confidence: high

### 4. [HIGH] `advance` actions can be spoofed because most transitions do not require turn ownership
- Location: src/hub/session-collab.js:194
- Why it matters: `request_response`, `request_rerun`, and `release_turn` only validate the current state, not who owns the turn. Any caller that knows the session ID can forge `agentId` and move the workflow forward or release another agent’s active turn, which breaks the turn-based collaboration contract.
- Recommended fix: Require turn ownership for all state-changing actions originating from a reviewing state. Extend `advanceCollabState()` and the REST/MCP `advance` endpoints to accept a `turnToken`, call `ensureTurnOwner()` for reviewer/responder actions, and explicitly validate the acting agent for `request_response`, `request_rerun`, and `release_turn`. Add tests that spoofed agent IDs are rejected.
- Confidence: high

### 5. [HIGH] New sessions never leave `draft`, so collaboration cannot start without a manual reassignment
- Location: src/hub/session.js:77
- Why it matters: The constructor initializes `collabState` to `draft`, but none of the session creation paths call `initCollab()`. As a result, `claimTurn()` rejects the first claim with `Cannot claim turn in collab state: draft`, even when defaults are already present.
- Recommended fix: Initialize the collaboration state when a session is created. Either set `this.collabState = transitionOnAssignments(this.assignments)` in the constructor, or call `session.initCollab()` in every creation path (`apiCreateSession`, MCP `hub_create_review`, and rerun creation). Add an integration test that creates a session and successfully claims the first turn without an extra assignment call.
- Confidence: high

### 6. [HIGH] The Python MCP bridge was switched to NDJSON framing, which is incompatible with MCP stdio transport
- Location: src/mcp/codex_review_mcp.py:37
- Why it matters: The stdio MCP transport speaks framed JSON-RPC messages, not bare one-line JSON. Replacing `Content-Length` parsing/writing with newline-delimited JSON will cause initialization and tool calls to fail or hang as soon as the Node SDK talks to this bridge.
- Recommended fix: Restore `Content-Length` framed stdio handling in `read_framed_message()` and `write_framed_message()`, or insert the existing line-bridge layer and keep the server side unchanged. Add a round-trip integration test that starts the Python bridge via `StdioClientTransport`, calls `tools/list`, and verifies the response is received.
- Confidence: medium

### 7. [MEDIUM] Message authors can spoof arbitrary roles, including `decider` and `system`
- Location: src/hub/session-messages.js:100
- Why it matters: `buildSessionMessage()` only checks that `role` is one of the allowed enums. A reviewer with a valid turn can post a `resolution` message while claiming `role: 'decider'`, which corrupts the audit trail and any UI logic that trusts the stored role.
- Recommended fix: Derive the allowed role from `agentId` and the session assignments instead of trusting the caller-provided `role`. Reserve `system` messages for server-generated events only. Add tests showing that mismatched `agentId`/`role` combinations are rejected.
- Confidence: high

### 8. [MEDIUM] Re-claiming an already claimed turn silently rotates the token
- Location: src/hub/session.js:257
- Why it matters: `claimTurn()` overwrites the existing claim even when the same agent already owns it. A duplicate claim request or retry invalidates the first token, so any in-flight `post_message`/`advance` call using the original token starts failing unexpectedly.
- Recommended fix: Make `claimTurn()` idempotent for the current owner: if the turn is already claimed and unexpired by the same agent, return the existing token (or reject with a conflict) instead of minting a new one. If another owner holds the turn, reject the claim. Add a regression test for duplicate claim requests.
- Confidence: medium

## Recommendations
- Restore MCP protocol compatibility and propagate tool-level errors from the Python bridge all the way through `McpCodexAdapter`.
- Split internal persistence serialization from redacted API serialization so turn tokens survive save/load while remaining hidden from external callers.
- Initialize collaboration state on session creation, align default assignments with `mcp-codex`, and enforce role/turn ownership on message and advance operations.
- Add integration tests for session creation -> claim -> post -> advance flows, plus an MCP stdio round-trip test against the Python bridge.
- Rerun review: yes

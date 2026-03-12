# Codex Review

## Overview
- Status: has_findings
- Summary: The collaboration/MCP changes add useful structure, but the current implementation has several correctness and security gaps around session initialization, turn enforcement, token handling, and persistence. The project brief is also out of sync with the actual codebase.
- Findings: 9

## Key Findings

### 1. [HIGH] Claim-turn events broadcast the secret token to all subscribers
- Location: src/collab-routes.js:112
- Why it matters: The `turn_claimed` event payload includes the raw token. Any websocket or MCP subscriber observing the session immediately learns the active bearer credential, which defeats turn isolation even if storage is fixed.
- Recommended fix: Keep the token only in the direct response to the caller that successfully claimed the turn. Broadcast only non-secret metadata such as `ownerId` and `expiresAt`. Apply the same redaction in `src/mcp-collab-tools.js` and add a test that event payloads never contain tokens.
- Confidence: high

### 2. [HIGH] Message roles are client-controlled and can be spoofed
- Location: src/hub/session-messages.js:102
- Why it matters: `buildSessionMessage()` only checks that `role` is one of the allowed enum values. A caller can submit messages as `decider` or `system` regardless of the assigned agent, which corrupts the audit trail and any automation that trusts message roles.
- Recommended fix: Do not trust the incoming `role` field. Derive role from `session.assignments` and `agentId`, or validate that the supplied role matches the current assignment before storing the message. Reject mismatches and add impersonation tests.
- Confidence: high

### 3. [HIGH] Turn bearer tokens are persisted on messages and exposed through history APIs
- Location: src/hub/session-messages.js:127
- Why it matters: Each stored `SessionMessage` keeps the raw `turnToken`, and message-list responses return those message objects. Anyone who can read session history can reuse another agent's active token until it expires.
- Recommended fix: Use the token only for authorization at write time, then discard it. Remove `turnToken` from persisted messages, redact `session.turn.token` from serialized/listed responses, and rotate/clear any active token that has already been exposed. Add regression tests covering both persistence and listing paths.
- Confidence: high

### 4. [HIGH] Fresh sessions never enter a collaboration-ready state
- Location: src/hub/session.js:77
- Why it matters: `Session` starts with `collabState = 'draft'`, and the new REST/MCP creation paths never call `initCollab()`. A brand-new session therefore cannot be claimed by the default reviewer/responder until someone manually reassigns agents, which breaks the primary collaboration flow.
- Recommended fix: Initialize collaboration state when a session is created. Either derive `collabState` from default assignments in the constructor, or call `session.initCollab()` immediately after `new Session(...)` in both `src/api-routes.js` and `src/mcp-server.js`. Add an integration test asserting a fresh session starts in `awaiting_codex_turn`.
- Confidence: high

### 5. [HIGH] State transitions bypass turn ownership entirely
- Location: src/hub/session.js:320
- Why it matters: `advanceCollabState()` validates only `agentId` and state. Any caller that knows the expected agent name can send `review_complete`, `request_rerun`, or `release_turn` without owning the active turn, so the collaboration lock is not actually enforced.
- Recommended fix: Extend `advanceCollabState()` and the REST/MCP advance endpoints to accept a `turnToken`, then call `ensureTurnOwner()` for reviewer/responder actions before allowing the transition. Add negative tests proving unauthorized transitions are rejected.
- Confidence: high

### 6. [MEDIUM] The project brief no longer matches the implemented architecture or status
- Location: docs/BRIEF.md:11
- Why it matters: `docs/BRIEF.md` still describes a `.md` file handoff model with three agents including Claude and says Phase 0/1 work is pending, while the repo already contains REST/WebSocket hub code, an MCP server, and collaboration session machinery. That misleads anyone using the brief to plan or review work.
- Recommended fix: Update the brief to reflect the current codebase as of 2026-03-12: current transport, supported agents, implemented MCP/REST collaboration components, and the real project phase/status. Remove or clearly mark unsupported Claude/Markdown-flow claims.
- Confidence: high

### 7. [MEDIUM] Collaboration events are lost on disk because handlers save before appending them
- Location: src/collab-routes.js:73
- Why it matters: `message_posted`, `turn_claimed`, `agent_assigned`, and `collab_state_changed` are added after `server.store.save(session)`. After a restart, the session state survives but the event timeline does not, which breaks replay/audit expectations in an event-driven hub.
- Recommended fix: Reorder the handlers so all session mutations and event appends happen first, then save once after the final event is added. Mirror the same fix in `src/mcp-collab-tools.js`. Add a persistence test that reloads a session and verifies the collab events are still present.
- Confidence: high

### 8. [MEDIUM] `pendingAction` never clears after non-rerun transitions
- Location: src/hub/session.js:346
- Why it matters: Once `request_rerun` sets `pendingAction`, later transitions like `review_complete`, `resolve`, or `close` leave the old rerun request attached to the session. Status APIs can therefore report stale work that is no longer pending.
- Recommended fix: Replace the conditional assignment with `this.pendingAction = result.pendingAction ?? null` so every transition resets stale state unless it explicitly sets a new pending action. Add regression tests for rerun -> resolve and rerun -> close flows.
- Confidence: high

### 9. [MEDIUM] Tests do not cover the new collaboration invariants or security boundaries
- Location: src/mcp-server.test.js:55
- Why it matters: The added tests cover helpers and MCP tool enumeration, but there is no end-to-end coverage for fresh-session collaboration startup, unauthorized state changes, token redaction, or collab-event persistence. The highest-risk regressions in this patch are therefore unguarded.
- Recommended fix: Add integration tests that create a real session through REST or MCP, assert initial `collabState`, reject unauthorized advance attempts, verify list/event payloads never leak tokens, and reload from `SessionStore` to confirm collaboration events persist.
- Confidence: high

## Recommendations
- Initialize collaboration state for new sessions in every creation path and add a fresh-session integration test.
- Enforce turn ownership on all reviewer/responder state transitions, not just message posting.
- Treat turn tokens as secrets: stop persisting them, stop broadcasting them, and redact them from all read APIs.
- Validate message roles against session assignments instead of trusting client input.
- Persist collaboration events after they are appended, and add restart/reload tests for the event timeline.
- Clear stale `pendingAction` on every transition unless a new pending action is produced.
- Rewrite `docs/BRIEF.md` so the brief matches the actual architecture, supported agents, and current project phase.
- Rerun review: yes

# Codex Review

## Overview
- Status: has_findings
- Summary: Phan collab moi van con mot so lo hong ve redaction, authorization va state initialization; cac loi nay du de gay ro ri token, spoof agent action, va lam workflow ket o trang thai sai.
- Findings: 7

## Key Findings

### 1. [HIGH] Status endpoints still leak turn secrets through serialized session payloads
- Location: src/api-routes.js:78
- Why it matters: `session.toJSON()` includes both `turn.token` and every historical `message.turnToken`. `GET /api/sessions/:id` and `hub_get_status` return that object directly, so any client that can read session status can steal the active turn token or replay old ones.
- Recommended fix: Introduce a single session-response sanitizer that deep-redacts `turn.token` and `messages[*].turnToken` before any API/MCP response. Use it in `apiGetSession`, `apiCreateSession`, and `hub_get_status` instead of returning `session.toJSON()` directly.
- Confidence: high

### 2. [HIGH] Advance-session actions can be spoofed because no turn token is required
- Location: src/hub/session-collab.js:195
- Why it matters: `request_response`, `request_rerun`, `release_turn`, and even `review_complete` are authorized only by a caller-supplied `agentId`. Any client that knows the session ID can impersonate `codex` or `antigravity` and move the collaboration state machine without owning the turn.
- Recommended fix: Thread a `turnToken` through both REST and MCP advance-session handlers, and in `Session.advanceCollabState()` require `ensureTurnOwner()` for all actions that are supposed to come from the active reviewer/responder turn. Keep `resolve`/`close` as explicit decider-only exceptions if intended.
- Confidence: high

### 3. [HIGH] Message posting trusts caller-provided roles, allowing decider/system spoofing
- Location: src/hub/session.js:380
- Why it matters: `addMessage()` validates only that `role` is one of the allowed enum values. A client can post as `agentId: "codex"` with `role: "decider"` or `role: "system"`, which can mislead reviewers and any automation that consumes message roles.
- Recommended fix: Derive the allowed role from `session.assignments` server-side and reject mismatches. Reserve `system` messages for internal code paths only, not external REST/MCP input.
- Confidence: high

### 4. [MEDIUM] Fresh sessions are never moved out of `draft`, so default collaboration cannot start
- Location: src/hub/session.js:77
- Why it matters: The constructor sets default assignments, but `collabState` stays `draft` and `initCollab()` is never called anywhere in the workspace. A brand-new session therefore cannot be claimed immediately even though reviewer/responder are already assigned by default.
- Recommended fix: Initialize `collabState` from `transitionOnAssignments(this.assignments)` in the constructor, or call `initCollab()` from every session creation path (`apiCreateSession`, MCP create-review flow, and any tests/helpers). Add a test that a new default session can be claimed by the reviewer without a prior assignment call.
- Confidence: high

### 5. [MEDIUM] Expired turns are only detected on mutating calls, so status can report stale ownership indefinitely
- Location: src/hub/session.js:356
- Why it matters: `expireTurnIfNeeded()` runs inside `claimTurn`, `ensureTurnOwner`, and `advanceCollabState`, but not when serving status/message-list endpoints. If nobody submits another action, clients can keep seeing a claimed turn long after expiry, and no `turn_expired` event is ever emitted.
- Recommended fix: Refresh turn expiry before serializing session state in read endpoints, and emit/persist a `turn_expired` event the first time an expired claim is observed so subscribers see the transition.
- Confidence: medium

### 6. [MEDIUM] Finding-targeted message types do not actually require a finding reference
- Location: src/hub/session.js:386
- Why it matters: `finding_reply`, `decision`, `rerun_request`, and `resolution` are documented as requiring finding refs, but the code only validates refs when the caller happens to provide them. That allows orphaned replies/decisions with no finding target, which breaks per-finding discussion and automation.
- Recommended fix: In `Session.addMessage()`, reject `MESSAGE_TYPES_REQUIRING_FINDING_REF` when `findingRefs` is missing or empty, then validate the refs. Add tests for each required type failing without a ref.
- Confidence: high

### 7. [MEDIUM] Critical collab invariants are not covered by tests
- Location: src/mcp-server.test.js:36
- Why it matters: The new tests exercise pure helpers and MCP tool listing, but there is no coverage for the bugs above: status redaction, fresh-session initialization, advance-action authorization, role spoofing, or required finding refs. These regressions are therefore likely to reappear.
- Recommended fix: Add integration-style tests around session/route behavior that assert: status responses redact tokens, new sessions start in a claimable collab state, advance actions fail without the owner token, external callers cannot spoof `system`/`decider` roles, and finding-targeted messages require refs.
- Confidence: high

## Recommendations
- Add a shared sanitizer for session payloads and use it for every REST/MCP status response.
- Make turn ownership explicit in collaboration mutations by requiring a valid `turnToken` for reviewer/responder state advances.
- Bind message roles to assignments server-side and block externally supplied `system` messages.
- Initialize collaboration state on session creation instead of leaving new sessions in `draft`.
- Enforce non-empty `findingRefs` for finding-targeted message types and add regression tests.
- Expire turns during read paths and emit a persisted `turn_expired` lifecycle event when appropriate.
- Rerun review: yes

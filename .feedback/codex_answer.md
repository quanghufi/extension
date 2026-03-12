# Codex Answer — Final Phase 2A Implementation Spec

This file merges:
- the original Phase 2A plan
- Antigravity's review in `.feedback/anti_review_plan.md`

Goal: provide one implementation-ready spec for Antigravity with the main decisions already resolved.

---

## 1. Final Decision Summary

Phase 2A should proceed.

The original plan is directionally correct. Antigravity's review identified several important implementation risks that should be incorporated into the final spec before coding.

### Final direction

- Keep the **shared-thread collaboration model**
- Keep **`hub_advance_session`** as the main workflow primitive
- Keep **backward compatibility** with existing review/evaluate/rerun flows
- Add a **collaboration layer** on top of the existing session model instead of replacing the current execution model
- Put **state machine and validation in the domain layer**, not in MCP handlers

### Final defaults

- reviewer = `codex`
- responder = `antigravity`
- decider = `antigravity`
- first turn = reviewer
- turn TTL = `600s`

---

## 2. Important Adjustments from Antigravity Review

These changes are accepted and should be part of the implementation.

### A. `events.js` must be updated first

`src/schema/events.js` currently validates event types strictly.

Before implementing collaboration tools, add these new event types to `EVENT_TYPES`:

- `message_posted`
- `turn_claimed`
- `turn_released`
- `turn_expired`
- `agent_assigned`
- `collab_state_changed`
- `resolution_requested`
- `session_resolved`
- `session_closed`

This is a required first step to avoid runtime failures.

### B. Terminal-event behavior must be handled explicitly

`session.addEvent()` currently rejects events once the session is terminal.

This conflicts with collaboration lifecycle events such as:
- `session_resolved`
- `session_closed`

Final implementation rule:

- either emit collab terminal events **before** switching to the final terminal state
- or extend `session.addEvent()` with a safe mechanism such as `force: true` for a narrow whitelist of collab lifecycle events

Recommended approach:

- add a narrow `force` option to `addEvent(event, options)`
- only allow forced add for collaboration terminal events
- do not relax terminal protections globally

### C. Split collaboration transport code out of `mcp-server.js`

`src/mcp-server.js` is already large.

Final decision:

- keep `buildMcpServer()` in `src/mcp-server.js`
- move the 5 new collaboration tool registrations into a new helper module:
  - `src/mcp-collab-tools.js`

This keeps the MCP entrypoint maintainable.

### D. Child retry sessions must inherit assignments but reset collaboration runtime state

`session.createRetry()` needs clearer behavior.

Final decision:

Child session created from rerun should:
- inherit `assignments`
- inherit collaboration defaults for agent identities
- reset `messages`
- reset `messageSeqCounter`
- reset `turn`
- reset `pendingAction`
- reset `collabState` to the appropriate fresh state for a new review round

Recommended state for retry child:
- if reviewer/responder are present: `awaiting_codex_turn`
- otherwise: `awaiting_assignment`

### E. Turn expiry remains lazy for MVP

No background timer is required in this phase.

Final decision:

- keep turn expiry lazy
- `expireTurnIfNeeded()` is called before any collaboration mutation or read that depends on turn validity
- document that expiry is enforced on interaction, not by a background worker

---

## 3. Final Collaboration Model

Session now has 3 layers:

### Execution layer
- `projectDir`
- `prompt`
- `reviewOptions`
- `snapshotPath`
- `round`
- existing review execution state in `session.state`

### Collaboration layer
- `collabState`
- `assignments`
- `turn`
- `messages`
- `messageSeqCounter`
- `pendingAction`

### Review artifact layer
- `allFindings`
- `groupedFindings`
- `mergedFindings`
- `rebuttals`
- `rebuttalOutcomes`

---

## 4. Final State Model

### Existing execution state remains

Keep `session.state` for execution lifecycle compatibility:

- `pending`
- `running`
- `completed`
- `failed`
- `partial_completion`
- `cancelled`

### New collaboration state

Add `session.collabState`:

- `draft`
- `awaiting_assignment`
- `awaiting_codex_turn`
- `codex_reviewing`
- `awaiting_antigravity_turn`
- `antigravity_reviewing`
- `awaiting_resolution`
- `resolved`
- `closed`
- `failed`

### Final collaboration terminal states

Adopt Antigravity's narrower terminal set:

- `resolved`
- `closed`

`failed` is not treated as permanently terminal for collaboration logic, because recovery back to a waiting state may be desirable.

### Transition table

```text
draft -> awaiting_assignment
awaiting_assignment -> awaiting_codex_turn
awaiting_assignment -> awaiting_antigravity_turn
awaiting_assignment -> failed

awaiting_codex_turn -> codex_reviewing
codex_reviewing -> awaiting_antigravity_turn
codex_reviewing -> awaiting_resolution
codex_reviewing -> failed

awaiting_antigravity_turn -> antigravity_reviewing
antigravity_reviewing -> awaiting_codex_turn
antigravity_reviewing -> awaiting_resolution
antigravity_reviewing -> failed

awaiting_resolution -> awaiting_codex_turn
awaiting_resolution -> awaiting_antigravity_turn
awaiting_resolution -> resolved
awaiting_resolution -> closed
awaiting_resolution -> failed

resolved -> closed
failed -> awaiting_codex_turn
failed -> awaiting_antigravity_turn
closed -> terminal
```

---

## 4A. State Machine Quick Reference

Use this section as the fastest implementation reference.

### Collaboration state machine

```text
[draft]
  -> [awaiting_assignment]

[awaiting_assignment]
  -> [awaiting_codex_turn]
  -> [awaiting_antigravity_turn]
  -> [failed]

[awaiting_codex_turn]
  -> [codex_reviewing]              via `hub_claim_turn(agentId='codex')`

[codex_reviewing]
  -> [awaiting_antigravity_turn]    via `review_complete` or `request_response`
  -> [awaiting_resolution]          via `review_complete` when no responder pass needed
  -> [failed]

[awaiting_antigravity_turn]
  -> [antigravity_reviewing]        via `hub_claim_turn(agentId='antigravity')`

[antigravity_reviewing]
  -> [awaiting_codex_turn]          via `request_rerun`
  -> [awaiting_resolution]          via review/debate complete
  -> [failed]

[awaiting_resolution]
  -> [awaiting_codex_turn]          via `request_rerun`
  -> [awaiting_antigravity_turn]    if more responder work is required
  -> [resolved]                     via `resolve`
  -> [closed]                       via `close`
  -> [failed]

[resolved]
  -> [closed]

[failed]
  -> [awaiting_codex_turn]
  -> [awaiting_antigravity_turn]

[closed]
  -> terminal
```

### Turn state machine

```text
[idle]
  -> [claimed]   via successful `hub_claim_turn`

[claimed]
  -> [idle]      via `release_turn`
  -> [expired]   when token TTL has passed and session is touched again

[expired]
  -> [idle]      immediately after expiry handling resets waiting state
```

### Expected actor by waiting state

- `awaiting_codex_turn` -> `codex`
- `awaiting_antigravity_turn` -> `antigravity`
- `awaiting_assignment` -> system or caller assigning roles
- `awaiting_resolution` -> decider (`antigravity` by default)

### Required implementation rule

The state machine must be enforced by domain helpers in:

- `src/hub/session-collab.js`
- `src/hub/session.js`

Do not duplicate transition logic in MCP handlers or REST routes.

---

## 5. Final Turn Model

Use this structure:

```json
{
  "status": "idle",
  "ownerId": null,
  "claimedAt": null,
  "claimExpiresAt": null,
  "token": null
}
```

### Notes

- Prefer `ownerId` over `owner` for clarity
- `status` values:
  - `idle`
  - `claimed`
  - `expired`

### Rules

- only one active turn at a time
- only the expected agent may claim turn
- turn-sensitive actions require valid token
- turn expiry is evaluated lazily

---

## 6. Final Message Model

Use a slightly narrowed MVP message type set to reduce scope.

### Final message types for Phase 2A

- `note`
- `review_summary`
- `finding_reply`
- `decision`
- `rerun_request`
- `resolution`
- `system`

This replaces the broader earlier set and is acceptable for MVP.

### Final message shape

```ts
type SessionMessage = {
  id: string;
  sessionId: string;
  seq: number;
  createdAt: string;
  agentId: string;
  role: 'reviewer' | 'responder' | 'decider' | 'system';
  type:
    | 'note'
    | 'review_summary'
    | 'finding_reply'
    | 'decision'
    | 'rerun_request'
    | 'resolution'
    | 'system';
  content: string;
  findingRefs: Array<{
    findingId?: string;
    dedupeKey?: string;
  }>;
  replyToMessageId: string | null;
  turnToken: string | null;
  metadata: Record<string, unknown>;
};
```

### Validation

- `content` must be non-empty after trim
- `replyToMessageId` must reference an existing message if present
- `finding_reply`, `decision`, `rerun_request`, `resolution` should validate refs when refs are provided
- turn-sensitive message types require valid turn token

---

## 7. Final MCP Tool Set

The Phase 2A collaboration tools remain:

- `hub_post_message`
- `hub_list_messages`
- `hub_claim_turn`
- `hub_assign_agent`
- `hub_advance_session`

### Keep existing tools unchanged for compatibility

- `hub_create_review`
- `hub_get_status`
- `hub_get_findings`
- `hub_evaluate_findings`
- `hub_rerun_review`

### Final transport-layer rule

MCP handlers must remain thin:

1. ensure hub ready
2. load session
3. call domain method
4. save session
5. emit events
6. return JSON

No state machine logic should live directly in tool handlers.

---

## 8. Final File-by-File Implementation Tasks

### `src/hub/session-collab.js` (new)

Create a pure collaboration state machine module.

Required exports:
- `COLLAB_STATES`
- `COLLAB_TERMINAL_STATES`
- `TURN_STATUS`
- `ADVANCE_ACTIONS`
- `defaultAssignments()`
- `createDefaultTurn()`
- `expectedAgentForState()`
- `transitionOnAssignments()`
- `claimStateForAgent()`
- `waitingStateForAgent()`
- `validateAdvanceAction()`
- `deriveNextCollabState()`

### `src/hub/session-messages.js` (new)

Create the message model/validation module.

Required exports:
- `MESSAGE_TYPES`
- `MESSAGE_TYPES_REQUIRING_TURN`
- `MESSAGE_TYPES_REQUIRING_FINDING_REF`
- `buildSessionMessage()`
- `validateFindingRefs()`
- `validateReplyTarget()`
- `filterMessages()`

### `src/hub/session.js`

Add:
- `messages`
- `messageSeqCounter`
- `collabState`
- `assignments`
- `turn`
- `pendingAction`

Add methods:
- `addMessage()`
- `listMessages()`
- `assignAgent()`
- `claimTurn()`
- `releaseTurn()`
- `ensureTurnOwner()`
- `advanceCollabState()`
- `expireTurnIfNeeded()`
- `isCollabTerminal()`
- `getExpectedAgentForCurrentState()`

Also update:
- `toJSON()`
- `toSummaryJSON()`
- `createRetry()`

### `src/hub/session-serialization.js`

Persist all collab fields additively with safe defaults.

### `src/schema/events.js`

Update `EVENT_TYPES` first.

### `src/mcp-collab-tools.js` (new)

Create a dedicated collaboration MCP registration helper.

Suggested export:
- `registerCollabTools(mcpServer, hub)`

This file should register:
- `hub_post_message`
- `hub_list_messages`
- `hub_claim_turn`
- `hub_assign_agent`
- `hub_advance_session`

### `src/mcp-server.js`

Keep the base MCP server setup here.

Modify to:
- import `registerCollabTools`
- call it from `buildMcpServer()`
- extend `hub_get_status` output with collab fields

### `src/collab-routes.js` (new)

Create REST parity endpoints:
- `GET /api/sessions/:id/messages`
- `POST /api/sessions/:id/messages`
- `POST /api/sessions/:id/claim-turn`
- `POST /api/sessions/:id/assignments`
- `POST /api/sessions/:id/advance`

### `src/server.js`

Add route dispatch for collaboration routes.

Also:
- call `expireTurnIfNeeded()` before collab-sensitive operations if needed
- do not auto-advance multiple collaboration states from runtime execution

### `src/rebuttal-routes.js`

Keep current rerun/evaluate behavior.

Required adjustment:
- ensure retry child sessions inherit assignments but reset collab runtime state correctly

Optional for this phase:
- mirror evaluate actions into collaboration messages

This is allowed to remain a TODO if clearly documented.

---

## 9. Final Action Semantics for `hub_advance_session`

Keep these actions for Phase 2A:

- `review_complete`
- `request_response`
- `request_rerun`
- `resolve`
- `close`
- `release_turn`

Optional earlier actions such as `accept_resolution` and `reject_resolution` are not required for MVP if they complicate the implementation.

### Final MVP behavior

#### `review_complete`
- actor: `codex`
- from: `codex_reviewing`
- to:
  - `awaiting_antigravity_turn` when human/agent response is expected
  - `awaiting_resolution` when no further responder pass is needed

#### `request_response`
- actor: current turn owner
- from: `codex_reviewing`
- to: `awaiting_antigravity_turn`

#### `request_rerun`
- actor: `antigravity`
- from: `antigravity_reviewing` or `awaiting_resolution`
- to: `awaiting_codex_turn`
- side effect: set `pendingAction`

#### `resolve`
- actor: `decider` or `system`
- from: `awaiting_resolution`
- to: `resolved`

#### `close`
- actor: `decider` or `system`
- from: `resolved` or `awaiting_resolution`
- to: `closed`

#### `release_turn`
- actor: current turn owner
- to corresponding waiting state

---

## 10. Final Testing Plan

### New tests

#### `src/hub/session-collab.test.js`
- default assignments
- expected agent mapping
- valid transitions
- invalid transitions
- derive next state for all supported actions

#### `src/hub/session-messages.test.js`
- valid note message
- reject empty content
- reject invalid reply target
- reject invalid finding refs
- afterSeq filtering
- limit filtering
- type filtering
- agent filtering

### Updated tests

#### `src/hub/session.test.js`
- constructor collab defaults
- assignAgent behavior
- claimTurn behavior
- releaseTurn behavior
- advanceCollabState behavior
- serialization round-trip
- retry child session reset rules

#### `src/mcp-server.test.js`
- registration or availability of new collab tools
- `hub_get_status` includes collab fields

#### `src/server.test.js`
- create session -> codex claim -> codex summary -> advance -> antigravity claim -> antigravity reply -> resolve/rerun
- websocket receives new collaboration events

---

## 11. Final Verification Order

Implement in this order:

1. `src/schema/events.js`
2. `src/hub/session-collab.js`
3. `src/hub/session-messages.js`
4. `src/hub/session.js`
5. `src/hub/session-serialization.js`
6. `src/mcp-collab-tools.js`
7. `src/mcp-server.js`
8. `src/collab-routes.js`
9. `src/server.js`
10. `src/rebuttal-routes.js`
11. tests

Rationale:
- event schema first prevents runtime failures
- domain before transport keeps handlers thin
- transport after domain avoids duplicate logic

---

## 11A. Read First / Code First

This is the exact order Antigravity should use.

### Read these files first

1. `AGENTS.md`
2. `.feedback/anti_review_plan.md`
3. `.feedback/codex_answer.md`
4. `plans/260312-agent-to-agent-mcp/task-breakdown.md`

### Then inspect current implementation files

1. `src/hub/session.js`
2. `src/hub/session-serialization.js`
3. `src/schema/events.js`
4. `src/mcp-server.js`
5. `src/server.js`
6. `src/rebuttal-routes.js`

### Code in this exact order

1. `src/schema/events.js`
   - add collab event types first
2. `src/hub/session-collab.js`
   - implement state machine and turn helpers
3. `src/hub/session-messages.js`
   - implement message schema and filters
4. `src/hub/session.js`
   - integrate collab fields and methods
5. `src/hub/session-serialization.js`
   - persist and hydrate new fields
6. `src/mcp-collab-tools.js`
   - register the 5 new MCP tools
7. `src/mcp-server.js`
   - wire collab tool registration and expand `hub_get_status`
8. `src/collab-routes.js`
   - add HTTP parity endpoints
9. `src/server.js`
   - wire route dispatch
10. `src/rebuttal-routes.js`
   - ensure retry child sessions reset collab runtime state correctly
11. tests
   - add unit tests first, then integration coverage

### Test order

1. `src/hub/session-collab.test.js`
2. `src/hub/session-messages.test.js`
3. `src/hub/session.test.js`
4. `src/mcp-server.test.js`
5. `src/server.test.js`

### Stop conditions

Stop and re-evaluate before continuing if any of these happen:

- `EVENT_TYPES` validation starts rejecting new collab events
- terminal event emission fails after state transition
- child retry sessions inherit stale `messages`, `turn`, or `pendingAction`
- MCP handlers begin duplicating state machine rules already defined in domain code

---

## 12. Deferred Items

These items may remain TODOs for a later phase if necessary:

- `hub_reply_to_finding`
- mirroring legacy rebuttal/evaluate actions into collaboration messages everywhere
- background turn expiry worker
- shared-state unification between all possible MCP and HTTP process topologies
- dashboard UX improvements for collaboration timeline

---

## 13. Final Recommendation to Antigravity

Proceed with implementation.

Priority rules:

1. Update event types first
2. Keep state machine in domain layer
3. Split collab transport code out of `mcp-server.js`
4. Make retry child session behavior explicit and deterministic
5. Treat legacy evaluate/rerun integration as compatibility surface, not the primary collaboration surface

If scope pressure appears during implementation:

- keep the core 5 MCP tools
- keep turn model + assignments + collabState
- defer message mirroring niceties and optional resolution sub-actions

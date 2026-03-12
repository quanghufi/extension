# Codex Phase 2B — Verification, Hardening, and Real Multi-Agent Operation

This file defines the recommended **Phase 2B** after Phase 2A collaboration primitives have been implemented.

Phase 2A introduced the shared-thread collaboration model:
- `hub_post_message`
- `hub_list_messages`
- `hub_claim_turn`
- `hub_assign_agent`
- `hub_advance_session`

Phase 2B should **not** jump immediately into new product features.
Instead, it should prove that the new collaboration layer works end-to-end, harden edge cases, and make the system operational for real Codex + Antigravity collaboration.

---

## 1. Phase 2B Goal

Turn the Phase 2A collaboration layer into a **verified, operable, and debuggable agent-to-agent workflow**.

### Success criteria

Phase 2B is done when all of the following are true:

1. Codex and Antigravity can collaborate on the **same session** reliably.
2. Shared state is visible and consistent across MCP and HTTP surfaces.
3. Turn ownership is enforced under normal and adversarial conditions.
4. Retry/rerun lineage behaves correctly without stale collaboration state.
5. Collaboration events are observable and replayable.
6. The project has repeatable smoke tests and e2e verification for the collaboration loop.
7. The main workflows and docs reflect the new collaboration model.

---

## 2. Recommended Phase 2B Scope

Phase 2B should include 5 workstreams:

1. **End-to-end verification**
2. **State consistency hardening**
3. **Observability and debugging**
4. **Workflow integration for Antigravity + Codex**
5. **Documentation and operator guidance**

Phase 2B should not yet focus on:
- fancy dashboard UX
- auth / multi-tenant access control
- distributed deployment architecture
- background schedulers or message brokers

---

## 3. Phase 2B Deliverables

Antigravity should produce the following deliverables in this phase:

### Deliverable A — Collaboration smoke test script

A deterministic script that verifies:
- session creation
- assignment
- turn claim
- message posting
- state advance
- rerun request or resolution

Recommended new file:
- `scripts/collab-smoke.js`

### Deliverable B — Collaboration e2e test suite

Integration tests covering the real collaboration path.

Recommended new file:
- `src/collab-e2e.test.js`

### Deliverable C — State consistency checks

Hardening tests for:
- stale turn tokens
- turn expiry
- wrong agent claiming turn
- rerun child session resets
- event ordering

Recommended placement:
- extend `src/server.test.js`
- extend `src/hub/session.test.js`
- extend `src/mcp-server.test.js`

### Deliverable D — Operator workflow docs

Update workflows so both agents know how to use Phase 2A features in practice.

Target files:
- `.agents/workflows/antigravity-hub-contract.md`
- `.agents/workflows/codex-review-loop.md`
- `docs/USER-GUIDE.md`

### Deliverable E — Shared-state limitations note

Document clearly whether MCP and HTTP currently share the same backing process/state.

If they do not, Phase 2B must make that limitation explicit in docs and in the operator workflow.

---

## 4. Read First / Code First

Antigravity should use this exact order.

### Read these files first

1. `AGENTS.md`
2. `.feedback/codex_answer.md`
3. `.feedback/anti_review_plan.md`
4. `src/hub/session.js`
5. `src/hub/session-collab.js`
6. `src/hub/session-messages.js`
7. `src/mcp-server.js`
8. `src/mcp-collab-tools.js`
9. `src/server.js`
10. `src/collab-routes.js`
11. `src/rebuttal-routes.js`

### Inspect these test files next

1. `src/hub/session-collab.test.js`
2. `src/hub/session-messages.test.js`
3. `src/hub/session.test.js`
4. `src/mcp-server.test.js`
5. `src/server.test.js`

### Code in this exact order

1. `scripts/collab-smoke.js`
2. `src/collab-e2e.test.js`
3. `src/server.test.js`
4. `src/hub/session.test.js`
5. `src/mcp-server.test.js`
6. `.agents/workflows/antigravity-hub-contract.md`
7. `.agents/workflows/codex-review-loop.md`
8. `docs/USER-GUIDE.md`

Reasoning:
- verify behavior first
- strengthen tests next
- then update operator-facing workflow docs

---

## 5. Final Phase 2B State Machine Focus

Phase 2B does not introduce a new state machine.
Instead, it verifies and hardens the Phase 2A state machine.

### Collaboration states that must be exercised in tests

```text
draft
awaiting_assignment
awaiting_codex_turn
codex_reviewing
awaiting_antigravity_turn
antigravity_reviewing
awaiting_resolution
resolved
closed
failed
```

### Mandatory transition coverage

At minimum, test these transitions end-to-end:

```text
awaiting_codex_turn -> codex_reviewing
codex_reviewing -> awaiting_antigravity_turn
awaiting_antigravity_turn -> antigravity_reviewing
antigravity_reviewing -> awaiting_codex_turn      (rerun path)
antigravity_reviewing -> awaiting_resolution      (decision path)
awaiting_resolution -> resolved
resolved -> closed
```

### Turn-state coverage

Test all of these:

```text
idle -> claimed
claimed -> idle
claimed -> expired -> idle
```

### Required invariants

These must hold after implementation:

1. only one active turn token per session
2. only expected agent can claim waiting turn
3. wrong token cannot mutate collaboration state
4. child rerun session must not inherit stale messages or stale turn token
5. terminal collaboration states must not accept new mutating collaboration actions

---

## 6. Detailed Workstream A — Collaboration Smoke Script

### File
- `scripts/collab-smoke.js`

### Purpose

This is the fastest operational proof that agent-to-agent collaboration works.

### Behavior

The script should:

1. start from a target project directory
2. create a session via MCP or HTTP
3. verify assignments exist
4. claim Codex turn
5. post a Codex review summary
6. advance to Antigravity turn
7. claim Antigravity turn
8. post a finding reply or decision
9. either:
   - request rerun, or
   - resolve the session
10. print a compact success/failure summary

### Recommended CLI shape

```powershell
node scripts/collab-smoke.js --project d:/extension --mode resolve
node scripts/collab-smoke.js --project d:/extension --mode rerun
```

### Minimum output

The script should print:
- session id
- initial collab state
- each action executed
- final collab state
- pass/fail verdict

### Failure conditions

The script should fail non-zero if:
- claim turn succeeds for wrong agent
- expected message is missing from timeline
- state does not advance as expected
- rerun child session has stale collab state

---

## 7. Detailed Workstream B — E2E Collaboration Tests

### File
- `src/collab-e2e.test.js`

### Purpose

Codify the collaboration smoke path as automated tests.

### Required scenarios

#### Scenario 1 — Happy path resolve

1. create session
2. auto/default assignments are present
3. Codex claims turn
4. Codex posts `review_summary`
5. Codex advances to responder
6. Antigravity claims turn
7. Antigravity posts `decision`
8. Antigravity advances to `awaiting_resolution`
9. Antigravity resolves session
10. optional close

#### Scenario 2 — Happy path rerun

1. create session
2. go through Codex review
3. Antigravity requests rerun
4. verify parent session pending action is set
5. trigger legacy rerun or direct rerun path
6. verify child session resets collab runtime state

#### Scenario 3 — Wrong turn claim rejected

1. session in `awaiting_codex_turn`
2. Antigravity attempts claim
3. must fail

#### Scenario 4 — Wrong token rejected

1. valid turn claim
2. mutate using bad token
3. must fail

#### Scenario 5 — Turn expiry recovery

1. claim turn with short TTL
2. wait past expiry or simulate expiry
3. next interaction expires token
4. state returns to correct waiting state

#### Scenario 6 — Event replay correctness

1. perform collaboration actions
2. fetch events after a sequence cursor
3. verify ordering and presence of collaboration events

---

## 8. Detailed Workstream C — Hardening Tests

### Extend `src/hub/session.test.js`

Add tests for:
- stale turn token rejection
- retry child session resets `messages`, `messageSeqCounter`, `turn`, `pendingAction`
- `expireTurnIfNeeded()` is idempotent
- resolved/closed sessions reject further collaboration mutations

### Extend `src/mcp-server.test.js`

Add tests for:
- MCP tool availability for all collaboration tools
- `hub_get_status` includes `collabState`, `assignments`, `turn`, `pendingAction`, `messageCount`
- JSON shape stability for new tools

### Extend `src/server.test.js`

Add tests for:
- collab HTTP endpoints
- event ordering
- websocket collaboration event delivery
- rerun child session lineage + collab reset

---

## 9. Detailed Workstream D — Workflow Integration

### Update `.agents/workflows/antigravity-hub-contract.md`

Add the new collaboration tools and usage rules:
- `hub_list_messages`
- `hub_claim_turn`
- `hub_assign_agent`
- `hub_post_message`
- `hub_advance_session`

Add behavioral rules:
- always check `hub_get_status` before taking action
- claim turn before posting turn-sensitive messages
- do not use stale turn token
- when `awaiting_codex_turn`, Antigravity must not act as if it owns the turn
- when `awaiting_antigravity_turn`, Codex must not act as if it owns the turn

### Update `.agents/workflows/codex-review-loop.md`

Refactor the review loop to the new collaboration model:

1. create session
2. Codex claim turn
3. Codex posts `review_summary`
4. Codex advances
5. Antigravity claim turn
6. Antigravity posts reply/decision
7. Antigravity requests rerun or resolves

The old evaluate/rerun flow can remain documented as compatibility or fallback.

### Update `docs/USER-GUIDE.md`

Add a new section:
- “Agent-to-agent collaboration workflow”

Include:
- required tool order
- meaning of `collabState`
- meaning of turn token
- rerun child session behavior

---

## 10. Detailed Workstream E — Shared-State Clarification

This is critical.

Phase 2B must explicitly verify whether MCP and HTTP surfaces share the same underlying state in the current runtime model.

### Required check

Antigravity should verify:

1. create or mutate session via MCP
2. read same session via HTTP
3. compare:
   - `collabState`
   - `turn`
   - `messages`
   - `pendingAction`

### Outcomes

#### If state is shared
- document that MCP and HTTP are consistent surfaces

#### If state is not shared
- document the limitation explicitly
- mark it as a Phase 2C or later architecture item
- do not hide the limitation

This is not optional documentation. Operators need to know whether the dashboard is authoritative.

---

## 11. File-by-File Task Breakdown

### `scripts/collab-smoke.js`
- create a deterministic collaboration smoke runner
- support `resolve` and `rerun` modes
- exit non-zero on failure

### `src/collab-e2e.test.js`
- add collaboration integration coverage
- cover resolve, rerun, wrong turn, wrong token, expiry, event replay

### `src/server.test.js`
- add HTTP + websocket collaboration scenarios

### `src/hub/session.test.js`
- add hardening assertions for token, expiry, terminal states, child session reset

### `src/mcp-server.test.js`
- verify tool registration and new status payload shape

### `.agents/workflows/antigravity-hub-contract.md`
- document how Antigravity should behave with collaboration tools

### `.agents/workflows/codex-review-loop.md`
- update the loop to use claim/post/advance semantics

### `docs/USER-GUIDE.md`
- document Phase 2A collaboration operation and Phase 2B verification commands

---

## 12. Test Execution Order

Run tests in this order:

```powershell
# 1. New smoke script
node scripts/collab-smoke.js --project d:/extension --mode resolve
node scripts/collab-smoke.js --project d:/extension --mode rerun

# 2. Focused domain and integration tests
node --test src/hub/session.test.js
node --test src/mcp-server.test.js
node --test src/collab-e2e.test.js

# 3. Broader server verification
node --test src/server.test.js

# 4. Full targeted suite
node --test src/hub/*.test.js src/schema/*.test.js src/mcp-server.test.js src/collab-e2e.test.js src/server.test.js
```

---

## 13. Stop Conditions / Risks

Stop and re-evaluate before continuing if any of these happen:

1. MCP mutations are not visible on HTTP reads for the same session and the team expected them to be shared.
2. Child retry sessions inherit stale turn token or stale messages.
3. `session_closed` / `session_resolved` events disappear due to terminal-state event ordering.
4. Wrong agent can claim turn under any scenario.
5. Any endpoint duplicates state machine logic already present in domain code.

---

## 14. Definition of Done for Phase 2B

Phase 2B is complete when:

- collaboration smoke script passes in both resolve and rerun modes
- e2e collaboration tests pass
- hardening tests pass
- operator workflows are updated
- the MCP vs HTTP state-sharing story is documented clearly
- the system is usable by real Codex + Antigravity collaboration without ambiguity

---

## 15. Final Guidance to Antigravity

Do not treat Phase 2B as a feature-expansion phase.

Treat it as:
- verification
- hardening
- operationalization

The main objective is to prove that the Phase 2A collaboration primitives are safe, deterministic, and usable in practice.


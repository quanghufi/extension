# Codex Phase 2C — Workflow Alignment, Collaboration UX, and Operator Controls

This file defines the recommended **Phase 2C** after:
- Phase 2A: collaboration primitives
- Phase 2B: verification and hardening

Phase 2C should make the collaboration model **operable, visible, and aligned across docs, workflows, and UI**.

The most important insight from the current repo state is this:

- the backend collaboration layer exists
- but the operator workflows still mostly follow the older `create_review -> get_findings -> evaluate -> rerun` model

Therefore, Phase 2C must begin with **workflow alignment**, not just UI work.

---

## 1. Phase 2C Goal

Make the shared-thread collaboration system usable by real operators and agents by aligning:

1. workflow docs
2. runtime mental model
3. UI/session inspection surfaces
4. operator controls

### Success criteria

Phase 2C is complete when:

1. Antigravity workflows reflect the Phase 2A collaboration model.
2. Operators can see `collabState`, `turn`, `assignments`, `pendingAction`, and messages in the UI.
3. A session can be understood and debugged without manually inspecting raw JSON files.
4. Operators can take safe actions from the UI.
5. Findings, messages, and session state transitions are visually linked.

---

## 2. Core Strategy

Phase 2C has 4 workstreams:

1. **Workflow alignment**
2. **Collaboration session detail UI**
3. **Operator controls**
4. **Replay and inspection**

Phase 2C does **not** introduce a new collaboration protocol.
It builds on the Phase 2A state machine and Phase 2B hardening work.

---

## 3. Workstream 1 — Workflow Alignment

This is the first and most important part of Phase 2C.

### Why this comes first

Current workflow docs still emphasize the older review loop:

- `hub_create_review`
- `hub_get_status`
- `hub_get_findings`
- `hub_evaluate_findings`
- `hub_rerun_review`

But Phase 2A introduced a richer collaboration model:

- `hub_post_message`
- `hub_list_messages`
- `hub_claim_turn`
- `hub_assign_agent`
- `hub_advance_session`

If workflows are not updated first, the UI and operator behavior will remain conceptually stuck in the older model.

### Files to update first

1. `.agents/workflows/antigravity-hub-contract.md`
2. `.agents/workflows/codex-review-loop.md`
3. `docs/USER-GUIDE.md`

---

## 4. Workflow Alignment Requirements

## 4.1 Update `.agents/workflows/antigravity-hub-contract.md`

### Current problem

It describes Antigravity mainly as a review consumer that:
- starts review
- polls state
- fetches findings
- evaluates findings
- reruns review

It does not describe:
- `collabState`
- turn ownership
- assignments
- shared messages
- `hub_advance_session`

### Required rewrite

The updated contract must include:

#### Collaboration-first tool table

Add these tools to the main contract:
- `hub_post_message`
- `hub_list_messages`
- `hub_claim_turn`
- `hub_assign_agent`
- `hub_advance_session`

Keep legacy review tools as compatibility tools:
- `hub_get_findings`
- `hub_evaluate_findings`
- `hub_rerun_review`

#### New core rules

Antigravity must:

1. always check `hub_get_status` before acting on a session
2. inspect `collabState`, not only execution `state`
3. inspect current `turn` before posting turn-sensitive messages
4. call `hub_claim_turn` before sending turn-sensitive collaboration actions
5. use `hub_advance_session` as the canonical workflow transition mechanism
6. treat `hub_evaluate_findings` and `hub_rerun_review` as compatibility/fallback tools

#### New decision table

Add a collaboration decision table like:

| `collabState` | Expected actor | Expected action |
|---|---|---|
| `awaiting_codex_turn` | Codex | claim turn, post review summary, advance |
| `codex_reviewing` | Codex | post/update summary, request response or complete review |
| `awaiting_antigravity_turn` | Antigravity | claim turn |
| `antigravity_reviewing` | Antigravity | post reply/decision, request rerun or move to resolution |
| `awaiting_resolution` | Decider | resolve, close, or request more work |
| `resolved` | Operator/Decider | optional close |

#### Explicit forbidden patterns

Add these forbidden patterns:
- posting a turn-sensitive message without owning turn
- advancing state with a stale token
- acting only on `session.state` while ignoring `collabState`
- using `hub_evaluate_findings` as the primary collaboration mechanism when message/turn flow is available

---

## 4.2 Update `.agents/workflows/codex-review-loop.md`

### Current problem

The current loop still uses a mostly legacy structure:

- create review
- wait for review to finish
- fetch findings
- evaluate findings
- rerun review

That is still useful, but it does not model the new collaboration layer.

### Required rewrite

Refactor the workflow into a collaboration-first loop.

### New recommended flow

#### Phase 0 — Check Hub
- `hub_list_sessions()`

#### Phase 1 — Choose target
- identify file or project target

#### Phase 2 — Start or prepare collaboration session
- create review session
- confirm assignments
- confirm initial `collabState`

#### Phase 3 — Codex turn
- `hub_claim_turn(agentId='codex')`
- `hub_post_message(type='review_summary', ...)`
- optional `hub_get_findings(...)` if findings surface is needed
- `hub_advance_session(action='review_complete' or 'request_response')`

#### Phase 4 — Antigravity turn
- `hub_claim_turn(agentId='antigravity')`
- `hub_list_messages(...)`
- `hub_post_message(type='finding_reply' or 'decision', ...)`
- `hub_advance_session(action='request_rerun' or move to resolution)`

#### Phase 5 — Resolution or rerun
- if rerun required:
  - use `hub_rerun_review(...)` as compatibility execution step if needed
  - continue same collaboration understanding for the next round
- if resolved:
  - `hub_advance_session(action='resolve')`

#### Phase 6 — Tests and summary
- run tests
- summarize rounds, accepted bugs, rejected bugs, final state

### Required note

Document clearly that:
- old evaluate/rerun tools still exist
- but the preferred operator mental model is now **claim -> message -> advance**

---

## 4.3 Update `docs/USER-GUIDE.md`

Add a new section:

## Agent-to-Agent Collaboration

This section must explain:
- what `collabState` means
- what a turn token means
- which tools are collaboration-native
- how rerun child sessions behave
- how to inspect a session from the dashboard or API

Include one example collaboration flow end-to-end.

---

## 5. Workstream 2 — Collaboration Session Detail UI

This is the main UI work of Phase 2C.

### Goal

Make one session understandable at a glance.

### Required UI sections

#### A. Session header

Show:
- `sessionId`
- execution `state`
- `collabState`
- round / lineage
- updated timestamp

#### B. Assignment panel

Show:
- reviewer
- responder
- decider

#### C. Turn panel

Show:
- current owner
- turn status
- claimed time
- expiry time

Do **not** expose raw secret token value in the UI.

#### D. Pending action panel

Show:
- pending action type
- requested by
- requested at
- associated payload summary

#### E. Message thread

Render collaboration messages with:
- actor
- role
- type
- timestamp
- content
- finding references
- reply linkage if present

#### F. Findings panel

Show:
- finding list
- grouped/merged findings
- whether a finding has related replies/decisions/messages

---

## 6. Workstream 3 — Operator Controls

Phase 2C should let an operator take safe actions from the UI.

### Required controls

#### Assignment actions
- assign reviewer
- assign responder
- assign decider

#### Turn actions
- claim turn
- release turn

#### Message actions
- post system note
- post decision/reply where appropriate

#### State actions
- advance session
- resolve session
- close session

### Safety rules

The UI must:
- disable actions that are invalid for the current `collabState`
- disable turn-sensitive actions if the actor does not own the turn
- never display raw turn token in a way that encourages manual copying

---

## 7. Workstream 4 — Replay and Inspection

This is the observability layer of Phase 2C.

### Goal

Allow operators to answer:
- what happened?
- in what order?
- who did what?
- why did the session rerun or resolve?

### Required replay view

Add a merged timeline built from:
- events
- messages
- state changes

### Minimum replay features

- chronological timeline
- event type badge
- actor label
- `collabState` transition markers
- finding/message links

### Optional but valuable

- step-by-step replay mode
- filter timeline by actor or type

---

## 8. Recommended Backend/API Work for Phase 2C

Phase 2C should avoid unnecessary backend churn.

Prefer building the UI from existing surfaces where possible:
- `GET /api/sessions/:id`
- `GET /api/sessions/:id/messages`
- `GET /api/sessions/:id/events`
- `GET /api/sessions/:id/findings`

Only add backend endpoints if the UI is clearly blocked.

### Acceptable backend additions

- small payload enrichments to session detail responses
- replay-oriented aggregation endpoint only if client-side composition becomes too awkward

Avoid major backend redesign in this phase.

---

## 9. File-by-File Task Breakdown

### `src/ui/index.html`

Update the session detail UI to include:
- collab header
- assignment panel
- turn panel
- pending action panel
- message thread
- finding linkage summary

### `src/ui/session-autoselect.js`

Update if needed so session detail selection works with richer collaboration state views.

### `src/api-routes.js`

Only extend if existing session detail payload is too thin for the UI.

### `src/collab-routes.js`

Use existing message/assignment/advance endpoints as the control surface for UI actions.

### `src/ws-handler.js`

Ensure collaboration events are delivered cleanly enough for live UI updates.

### `.agents/workflows/antigravity-hub-contract.md`

Rewrite toward collaboration-first operation.

### `.agents/workflows/codex-review-loop.md`

Rewrite toward claim -> message -> advance flow.

### `docs/USER-GUIDE.md`

Document the collaboration model and session inspection flow.

---

## 10. Test Plan for Phase 2C

Phase 2C should add tests in 3 areas:

### A. UI rendering tests

If the repo has a suitable pattern for UI testing, add checks for:
- rendering `collabState`
- rendering assignments
- rendering turn panel
- rendering pending action summary

If UI tests are not already established, keep this light and focus on integration-level validation.

### B. Route/integration tests

Add or update tests to ensure:
- session detail responses contain collaboration fields required by UI
- message list endpoint supports the UI flow cleanly
- invalid operator actions are rejected

### C. Workflow verification tests

Add at least one test or scripted verification that the documented workflow matches the actual collaboration behavior.

---

## 11. Read First / Code First

Antigravity should use this order.

### Read first

1. `AGENTS.md`
2. `.feedback/codex_answer.md`
3. `.feedback/codex_phase2b.md`
4. `.agents/workflows/antigravity-hub-contract.md`
5. `.agents/workflows/codex-review-loop.md`
6. `src/ui/index.html`
7. `src/server.js`
8. `src/api-routes.js`
9. `src/collab-routes.js`
10. `src/ws-handler.js`

### Code first

1. `.agents/workflows/antigravity-hub-contract.md`
2. `.agents/workflows/codex-review-loop.md`
3. `docs/USER-GUIDE.md`
4. `src/ui/index.html`
5. `src/ui/session-autoselect.js`
6. minimal backend payload extensions if necessary
7. tests

Reasoning:
- align the human/operator workflow first
- then build the UI to match that workflow
- only then patch backend payload gaps if they actually block the UI

---

## 12. Stop Conditions / Risks

Stop and re-evaluate before continuing if:

1. The workflows remain legacy-first after edits and still do not describe `collabState`, turn ownership, and `hub_advance_session`.
2. The UI exposes raw token data.
3. The UI suggests invalid actions for the current `collabState`.
4. The replay view cannot explain why a session advanced or reran.
5. The implementation starts redesigning the backend instead of using the already-built collaboration layer.

---

## 13. Definition of Done for Phase 2C

Phase 2C is complete when:

- workflow docs match the Phase 2A collaboration model
- the dashboard/session view shows collaboration state clearly
- operators can inspect a session without reading raw JSON
- operators can take safe collaboration actions from the UI
- findings, messages, and state transitions are visibly linked
- the system is easier to operate than in the Phase 2B state

---

## 14. Final Recommendation to Antigravity

Do not treat Phase 2C as a pure frontend beautification phase.

Treat it as:
- workflow alignment
- operator experience
- observability
- controlled collaboration operations

The correct first move is to rewrite the workflows so they match the collaboration reality of the hub.


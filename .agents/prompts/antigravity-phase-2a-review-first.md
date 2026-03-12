# Antigravity Prompt — Phase 2A Review-First Then Code

Use this prompt when implementing the shared-thread agent-to-agent collaboration layer for `extension-hub`.

## Read first

Read these files before writing code:

1. `AGENTS.md`
2. `plans/260312-agent-to-agent-mcp/task-breakdown.md`
3. `.feedback/action-plan-v4-agent-to-agent.md`

## Phase 1 — Review first

Before coding, review the plan against the current repository and identify:

- architecture risks
- compatibility risks with existing review/evaluate/rerun flows
- state machine edge cases
- persistence/serialization gaps
- missing tests
- any implementation detail that should be adjusted before coding

Output a short review summary first with exactly these sections:

- `Agree`
- `Risks`
- `Changes before coding`

If there is no blocking contradiction, continue directly to implementation.

## Phase 2 — Implement

Implement Phase 2A for the Node Hub MCP.

### New MCP tools to add

- `hub_post_message`
- `hub_list_messages`
- `hub_claim_turn`
- `hub_assign_agent`
- `hub_advance_session`

### Required behavior

- shared-thread collaboration model
- one active turn at a time
- assignments for reviewer/responder/decider
- collaboration state machine enforced in domain layer
- backward compatibility with:
  - `hub_create_review`
  - `hub_get_status`
  - `hub_get_findings`
  - `hub_evaluate_findings`
  - `hub_rerun_review`

### Implementation order

1. `src/hub/session-collab.js`
2. `src/hub/session-messages.js`
3. `src/hub/session.js`
4. `src/hub/session-serialization.js`
5. `src/schema/events.js`
6. `src/mcp-server.js`
7. `src/api-routes.js` or `src/collab-routes.js`
8. `src/server.js`
9. `src/rebuttal-routes.js`
10. tests
11. docs

## Constraints

- Put business rules in the domain layer, not MCP handlers
- Keep changes focused and compatible with existing flows
- Split files only when it clearly improves maintainability or readability
- English or Vietnamese are both acceptable in code and docs
- Summarize final results for the user in Vietnamese

## Required success criteria

- shared session contains:
  - `messages`
  - `turn`
  - `assignments`
  - `collabState`
- `Codex -> Antigravity -> Codex` works in one session
- existing APIs still work
- tests cover:
  - state transitions
  - message validation
  - turn claiming/releasing
  - MCP tool behavior
  - integration flow

## Final report format

When done, report:

1. review summary
2. changed files
3. implemented state machine summary
4. tests added or updated
5. deferred TODOs
6. compatibility caveats


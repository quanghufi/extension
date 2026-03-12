---
description: Antigravity operational contract for the local Agent Communication Hub
---

# Antigravity Hub Contract

Use this workflow whenever Antigravity interacts with the Extension Hub.

## Communication Method: MCP Tools (Primary)

Antigravity connects directly to the Extension Hub via **MCP stdio transport**.
The hub is registered as the `extension-hub` MCP server in `~/.gemini/antigravity/mcp_config.json`.

### Basic Mode - Review Tools

| Tool | Purpose |
|------|---------|
| `hub_list_sessions` | List all review sessions |
| `hub_create_review` | Create and start a review session |
| `hub_get_status` | Get session state, watchdog state, and collaboration details |
| `hub_get_findings` | Get grouped and merged findings plus rebuttals |
| `hub_evaluate_findings` | Accept, reject, or dispute findings |
| `hub_rerun_review` | Retry a review with an updated prompt |

### Collaboration Mode - Agent-to-Agent Tools

| Tool | Purpose |
|------|---------|
| `hub_assign_agent` | Assign an agent to a role (`reviewer`, `responder`, `decider`) |
| `hub_claim_turn` | Claim the current turn for an agent |
| `hub_post_message` | Post a message to the session thread |
| `hub_list_messages` | List messages with filtering (`afterSeq`, `types`, `agentId`) |
| `hub_advance_session` | Advance the collaboration state machine |

Collaboration tools extend the basic review flow with structured turn-based interaction.
Use them when running an agent-to-agent review loop, for example Codex reviews and Antigravity responds.

## Core Rules

1. Always call `hub_get_status` before doing anything with a session.
2. Use `session.displayState` as the primary execution-state signal.
3. Always inspect `session.collabState`, not just execution `state`, to understand collaboration progress.
4. If `session.collabState` is `draft` or `awaiting_assignment`:
   - Do **not** assume the session is already on the turn-based path.
   - Only inspect assignments, wait and re-check, or switch to Compatibility Mode (fallback).
   - Do **not** call `hub_advance_session(resolve|close|request_rerun)` as a collaboration action from these states.
5. If `displayState == "stalled"` or `watchdog.stalled == true`:
   - Stop immediately.
   - Do **not** keep waiting as if the review were progressing.
   - Report `reviewer_stalled`.
   - Optionally trigger `hub_rerun_review` as fallback.
6. Prefer calling `hub_get_findings` after `session.state == "completed"` to get stable findings.
7. `hub_get_findings` may still be called earlier in collab-first or Compatibility Mode when partial findings are needed for analysis.
8. If `displayState == "stalled"`, do **not** treat fetched findings as evidence that the review completed successfully.
9. If `session.state == "failed"` or `session.state == "cancelled"`, stop and report terminal failure.
10. Treat MCP startup stalls as runtime or infrastructure failures, not progress.
11. Check the current turn before posting turn-sensitive messages (`review_summary`, `finding_reply`, `decision`, `rerun_request`, `resolution`).
12. Prefer `hub_claim_turn` -> `hub_post_message` -> `hub_advance_session` as the canonical shared-thread collaboration protocol when the session is already on a valid turn-based path.

## State Decision Table

| Condition | Action |
|---|---|
| `displayState = completed` | Prefer `hub_get_findings` for stable review output |
| `displayState = stalled` | Stop, report `reviewer_stalled`, consider `hub_rerun_review` |
| `state = failed` | Stop and report failure |
| `state = cancelled` | Stop |
| `state = running` and not stalled | Wait, then re-check `hub_get_status` |

## Collaboration Decision Table

| `collabState` | Expected Actor | Expected Action |
|---|---|---|
| `draft` | None / operator | Check assignments, do not post turn-sensitive messages, do not advance |
| `awaiting_assignment` | Operator / system | Assign roles or confirm defaults; only enter the turn-based flow after `awaiting_codex_turn` or `awaiting_antigravity_turn` |
| `awaiting_codex_turn` | Codex (`reviewer`) | Claim turn, post review summary, advance |
| `codex_reviewing` | Codex (`reviewer`) | Post or update summary, then `review_complete` or `request_response` |
| `awaiting_antigravity_turn` | Antigravity (`responder`) | Claim turn |
| `antigravity_reviewing` | Antigravity (`responder`) | Post a reply or decision, then `request_rerun` or `review_complete` |
| `awaiting_resolution` | `decider` | `resolve`, `close`, or request more work |
| `resolved` | Operator / `decider` | Optional `close` |

Notes:
- A newly created session may legitimately still be `draft`; this is not automatically an error.
- `draft` does not mean it is already someone's turn.
- `resolve` is only valid when `collabState == awaiting_resolution`.

## MCP Usage Patterns

### Create a Review

```js
hub_create_review({
    projectDir: "{PROJECT_DIR}",
    prompt: "Review this code for bugs and issues",
    reviewTarget: "file",
    filePath: "src/server.js",
    maxFindings: 15,
    waitForCompletion: false
})
```

`waitForCompletion: false` is the default for **collab-first** execution because the agent may need to inspect `collabState`, assignments, turn ownership, and messages while the review is in progress.

Use `waitForCompletion: true` only when you intentionally choose **Compatibility Mode (fallback)** or poll-completion behavior.

### Poll Status

```js
hub_get_status({ sessionId: "..." })
// Check session.state, session.displayState, watchdog.stalled
// Check session.collabState, session.assignments, session.turn
```

### Fetch Findings

```js
hub_get_findings({ sessionId: "..." })
// grouped, merged, mergeStats, rebuttals
```

Prefer this after `completed` for a stable snapshot, but it is valid to read partial findings earlier if you are doing analysis in collab-first or Compatibility Mode.

### Evaluate Findings (Basic Mode)

```js
hub_evaluate_findings({
    sessionId: "...",
    evaluations: [
        { dedupeKey: "abc123", verdict: "accepted", rationale: "Valid bug" },
        { dedupeKey: "def456", verdict: "rejected", rationale: "False positive: guarded by a null check" }
    ]
})
```

### Rerun Review (Basic Mode)

```js
hub_rerun_review({
    sessionId: "...",
    prompt: "Re-review after fixes",
    waitForCompletion: true
})
```

This is a **Compatibility Mode** example.
Do not use `hub_rerun_review` as the first instinct when a valid turn-based path is already active.

### Collaboration Pattern: Claim Turn -> Post Message -> Advance

```js
// 1. Claim turn
const turn = hub_claim_turn({ sessionId: "...", agentId: "antigravity" })
// => { token: "abc12345" }

// 2. Post a message with the turn token
hub_post_message({
    sessionId: "...",
    agentId: "antigravity",
    role: "responder",
    type: "finding_reply",
    content: "This is a false positive because...",
    findingRefs: "[{\"dedupeKey\":\"abc123\"}]",
    turnToken: turn.token
})

// 3. Advance collaboration state
hub_advance_session({
    sessionId: "...",
    agentId: "antigravity",
    action: "review_complete"
})
```

Notes:
- `findingRefs` is passed to the MCP tool as a **JSON string** when present.
- `turnToken` is required for turn-sensitive message types such as `review_summary`, `finding_reply`, `decision`, `rerun_request`, and `resolution`.
- `hub_advance_session` does **not** take `turnToken`; action validity depends on `collabState` and the acting agent.

## Compatibility Mode (Fallback)

Use Compatibility Mode when:
- collab-first flow is not available,
- or `collabState` is still `draft` / `awaiting_assignment`,
- or the current runtime has not yet entered a valid turn-based path.

### Compatibility Mode Guardrails

- If you chose Compatibility Mode because the session is still `draft`, do **not** try to close the loop with `hub_advance_session(resolve|close)`.
- In this path, prefer only:
  - `hub_get_status`
  - `hub_get_findings`
  - `hub_evaluate_findings`
  - `hub_rerun_review` if a new round is needed
- If a next round is needed, the new round must re-check `collabState` from the start.
- Do not mix compatibility evaluation with collab advance actions in the same draft session.
- This guardrail exists because `resolve` from `draft` is invalid (`resolve only valid from awaiting_resolution, got draft`).

## Fallback: HTTP REST API

If MCP is unavailable, use HTTP at `http://localhost:3849`:

| MCP Tool | HTTP Equivalent |
|----------|----------------|
| `hub_list_sessions` | `GET /api/sessions` |
| `hub_create_review` | `POST /api/sessions` |
| `hub_get_status` | `GET /api/sessions/:id` |
| `hub_get_findings` | `GET /api/sessions/:id/findings` |
| `hub_evaluate_findings` | `POST /api/sessions/:id/findings/evaluate` |
| `hub_rerun_review` | `POST /api/sessions/:id/rerun` |
| `hub_assign_agent` | `POST /api/sessions/:id/assignments` |
| `hub_claim_turn` | `POST /api/sessions/:id/claim-turn` |
| `hub_post_message` | `POST /api/sessions/:id/messages` |
| `hub_list_messages` | `GET /api/sessions/:id/messages` |
| `hub_advance_session` | `POST /api/sessions/:id/advance` |

## Forbidden Patterns

- Poll forever just because `state == running`
- Ignore `displayState` or `watchdog.stalled`
- Treat findings from a `stalled` session as proof of success
- Use HTTP when MCP tools are available

## Collaboration Forbidden Patterns

- Post a turn-sensitive message (`review_summary`, `finding_reply`, `decision`, `rerun_request`, `resolution`) **without owning the turn**
- Call `hub_advance_session` from non-turn-based states like `draft` or `awaiting_assignment`
- Call `resolve` outside `awaiting_resolution`
- Act only on `session.state` while **ignoring `collabState`**
- Use collab advance actions after choosing Compatibility Mode for a draft session
- Use `hub_evaluate_findings` as the **primary collaboration mechanism** when message/turn flow is available; use it as a compatibility fallback only

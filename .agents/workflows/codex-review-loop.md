---
description: Codex review-debug loop (up to 5 automatic rounds)
---

# Codex Review Loop

**Two-agent review loop:** Codex reviews -> Antigravity evaluates and rebuts -> fixes are applied -> tests are run -> repeat for up to 5 rounds.

Use MCP tools from the `extension-hub` server for direct stdio-based communication.

Before running this loop, Antigravity should follow:
`./.agents/workflows/antigravity-hub-contract.md`

## Phase 0: Verify the Hub MCP Server

Call the MCP tool:

```
hub_list_sessions()
```

- If it succeeds, the hub is available over MCP. Continue.
- If it fails, inspect `~/.gemini/antigravity/mcp_config.json`.

## Phase 1: Determine the Review Target

1. Ask the user which file should be reviewed, or use the currently open file.
2. Confirm the test command, preferably by auto-detecting it.

## Phase 2: Review Loop (Up to 5 Rounds, Collab-First)

> Default preference: use the shared-thread collaboration flow (`claim -> message -> advance`).
> Legacy `evaluate -> rerun` is **Compatibility Mode (fallback)**, not the primary path.

### Step 2.1: Create the Review Session (Round 1)

Call the MCP tool:

```js
hub_create_review({
    projectDir: "{PROJECT_DIR}",
    prompt: "Review this code for bugs and issues",
    reviewTarget: "file",
    filePath: "{RELATIVE_FILE_PATH}",
    maxFindings: 15,
    waitForCompletion: false
})
```

The response contains `sessionId`, `state`, and `findingCount`.

`waitForCompletion: false` is the default for the collab-first path so the agent can inspect `collabState`, turn ownership, and messages.
Use `waitForCompletion: true` only when intentionally choosing **Compatibility Mode (fallback)**.

### Step 2.2: Inspect Session and Collaboration State

Call the MCP tool:

```js
hub_get_status({ sessionId: "{SESSION_ID}" })
```

Always check:
- `session.state`
- `session.displayState`
- `session.collabState`
- `session.assignments`
- `session.turn`

Safe handling rules:
- `failed` / `cancelled` -> report the failure and stop.
- `stalled` -> report `reviewer_stalled`; only use `hub_rerun_review` as fallback.
- `collabState = draft` or `awaiting_assignment` -> do **not** assume collaboration is ready; verify assignments and only continue the collaboration path once the session enters a valid turn-based state.
- `collabState` in turn-based states (`awaiting_codex_turn`, `codex_reviewing`, `awaiting_antigravity_turn`, `antigravity_reviewing`, `awaiting_resolution`) -> continue with the collab-first flow.

## Collaboration-Enhanced Flow (Preferred)

> This is the preferred shared-thread collaboration path.
> Every turn-sensitive message must include a valid `turnToken`.

### Phase A: Setup

```js
hub_get_status({ sessionId: "{SESSION_ID}" })
// Check session.collabState
// Check session.assignments (reviewer, responder, decider)
// Check session.turn
```

Notes:
- Do not assume a newly created session is already `awaiting_codex_turn`.
- If the session is still `draft`, follow the contract to decide between assignment handling and fallback; do not post turn-sensitive messages yet.

### Phase B: Codex Turn

```js
// Codex claims the turn
const codexTurn = hub_claim_turn({ sessionId: "{SESSION_ID}", agentId: "codex" })

// Codex posts a review summary with the turn token
hub_post_message({
    sessionId: "{SESSION_ID}",
    agentId: "codex",
    role: "reviewer",
    type: "review_summary",
    content: "Found N issues in {FILE}...",
    turnToken: codexTurn.token
})

// Optional: fetch findings for detailed inspection
hub_get_findings({ sessionId: "{SESSION_ID}" })

// Codex advances the state to Antigravity's turn
hub_advance_session({
    sessionId: "{SESSION_ID}",
    agentId: "codex",
    action: "review_complete"
})
```

### Phase C: Antigravity Turn

```js
// Antigravity claims the turn
const antiTurn = hub_claim_turn({ sessionId: "{SESSION_ID}", agentId: "antigravity" })

// Read Codex messages
hub_list_messages({ sessionId: "{SESSION_ID}" })

// Antigravity may also inspect findings directly
hub_get_findings({ sessionId: "{SESSION_ID}" })

// Antigravity replies with a rebuttal using the turn token
hub_post_message({
    sessionId: "{SESSION_ID}",
    agentId: "antigravity",
    role: "responder",
    type: "finding_reply",
    content: "Finding F-XXX is a false positive because...",
    turnToken: antiTurn.token
})

// Advance: request rerun if fixes are needed, or mark the review complete
hub_advance_session({
    sessionId: "{SESSION_ID}",
    agentId: "antigravity",
    action: "request_rerun" // or "review_complete"
})
```

### Phase D: Fix and Verify

Antigravity should **not** fix blindly.

1. Read the code at the lines Codex referenced.
2. Look for reasons a finding might be a false positive.
3. Only fix bugs that are actually accepted.
4. Run tests.

```powershell
node --test src/**/*.test.js
```

### Phase E: Resolution

When enough rounds have been completed and the conclusion is clear:

```js
hub_advance_session({
    sessionId: "{SESSION_ID}",
    agentId: "antigravity",
    action: "resolve"
})
```

If the session should be closed entirely:

```js
hub_advance_session({
    sessionId: "{SESSION_ID}",
    agentId: "antigravity",
    action: "close"
})
```

Only do this when the collaboration state allows it. In particular, `resolve` is valid only from `awaiting_resolution`.

### Phase F: Next Round

If `round < 5` and another review pass is needed after fixes:

- Prefer preserving the message thread and session context through the collaboration flow.
- Then create or rerun the next round according to the current contract.
- Every new round must return to **Step 2.2** and re-check the real `collabState`; never assume it.

## Compatibility Mode (Fallback)

Use this only when the collab-first flow is unavailable or the current session or runtime has not entered a valid turn-based path yet.

### Compatibility Guardrails

- If `collabState` is still `draft` or `awaiting_assignment`, do **not** use collab advance actions such as `resolve` or `close` to force completion.
- In this mode, prefer `hub_get_status`, `hub_get_findings`, `hub_evaluate_findings`, and `hub_rerun_review`.
- If a new round is needed, the new session must start again from **Step 2.2** and re-check `collabState`.

### Fallback 1: Poll Completion

```js
hub_get_status({ sessionId: "{SESSION_ID}" })
```

- `completed` -> fetch findings
- `stalled` -> consider fallback rerun
- `failed` / `cancelled` -> stop

### Fallback 2: Evaluate Findings

```js
hub_get_findings({ sessionId: "{SESSION_ID}" })

hub_evaluate_findings({
    sessionId: "{SESSION_ID}",
    evaluations: [
        { dedupeKey: "abc123", verdict: "accepted", rationale: "Valid bug: variable can be null" },
        { dedupeKey: "def456", verdict: "rejected", rationale: "False positive: guarded at line 42" }
    ]
})
```

### Fallback 3: Rerun Review

```js
hub_rerun_review({
    sessionId: "{SESSION_ID}",
    prompt: "Round {N+1}: Re-review after fixes were applied",
    waitForCompletion: true
})
```

The response contains a new `sessionId`; use it for the next round.

### Fallback Rules

- Do not use `hub_evaluate_findings` as the primary collaboration mechanism when `claim -> message -> advance` is available.
- Do not use `hub_rerun_review` as the first instinct when the session is still in a valid collaboration turn flow.
- After fallback creates a new session that supports collaboration clearly, return to the collab-first path.

### Legacy vs Collaboration Mode

| Aspect | Legacy (Compatibility) | Collaboration (Preferred) |
|--------|-------------------------|---------------------------|
| Evaluate findings | `hub_evaluate_findings` | `hub_post_message` (`finding_reply`) |
| Rerun | `hub_rerun_review` | `hub_advance_session` (`request_rerun`) |
| Flow control | Poll-based | Turn-based (`claim -> message -> advance`) |
| Thread history | No message thread | Full message thread with replies |

## Next Steps Menu

```
1. /run    -> Run it
2. /test   -> Run tests
3. /deploy -> Deploy
4. /next   -> Suggest next actions
```

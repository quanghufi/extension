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
2. Build a **review context bundle** before creating the session.
3. Confirm the test command, preferably by auto-detecting it.

The review context bundle should make implicit assumptions explicit whenever correctness depends on them.

Minimum fields:

- `filePath`: repo-relative target file to review
- `scope`: whether review should stay on this file first or inspect nearby dependencies when needed
- `expectedBehavior`: what the code is supposed to do
- `invariants`: required preconditions, postconditions, or guarantees that must hold
- `knownAssumptions`: upstream/downstream guards, runtime constraints, feature flags, or intentionally safe patterns
- `focusAreas`: bug classes to prioritize such as null safety, async ordering, race conditions, stale state, security, or API contract mismatches
- `ignoreAreas`: non-goals such as style, naming, or formatting

If important context is not provided, Codex should be expected to review based on local code evidence and the explicit session prompt only.
Antigravity must not assume that unwritten architectural or business context is already shared.

## Phase 2: Review Loop (Up to 5 Rounds, Collab-First)

> Default preference: use the shared-thread collaboration flow (`claim -> message -> advance`).
> Legacy `evaluate -> rerun` is **Compatibility Mode (fallback)**, not the primary path.

### Step 2.1: Create the Review Session (Round 1)

Call the MCP tool:

```js
hub_create_review({
    projectDir: "{PROJECT_DIR}",
    prompt: `
Review this file for correctness bugs.

Target:
- File: {RELATIVE_FILE_PATH}
- Scope: stay on this file first; inspect directly referenced neighbors only when needed

Context:
- Expected behavior: {EXPECTED_BEHAVIOR}
- Invariants: {INVARIANTS}
- Known assumptions: {KNOWN_ASSUMPTIONS}
- Focus on: {FOCUS_AREAS}
- Ignore: {IGNORE_AREAS}

Rules:
- Prefer evidence from code and explicit context over guesswork
- If a finding depends on a missing assumption, say so explicitly
- Do not spend findings on style-only issues unless they hide a correctness risk
`,
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

### Waiting Policy

**Default rule: keep waiting until Codex responds or the user cancels manually.**

Do **not** switch to Compatibility Mode just because the review is slow, quiet, or still initializing.
Deep reviews may take a long time before the first findings appear.

Use `hub_get_status({ sessionId })` to keep polling and report progress in user-friendly local time.

Auto-continue rule while waiting:
- While the session is only in a waiting/polling phase, the agent should **continue automatically** without asking the user for confirmation on every poll.
- Status updates are informational, not blocking.
- If the agent offers the user a chance to cancel, that offer must be non-blocking.
- If there is no user reply after **30 seconds**, the agent should automatically continue polling.
- The only time the agent should stop and wait for the user is when the user explicitly interrupts, cancels, or asks to change strategy.

For user-facing progress updates:
- prefer **local time**,
- derive `session age` from the canonical session timestamp source,
- do **not** mix UTC narration and local-time narration in the same progress message.

Preferred user-facing format:
- `Created at: {local time}`
- `Now: {local time}`
- `Session age: {elapsed}`

Keep polling while any of the following are true:
- `session.state == running`,
- `displayState` is non-terminal,
- `collabState` is still moving toward or within the collaboration path,
- there is no explicit failure signal.

Only stop waiting automatically when there is an explicit failure signal, such as:
- `watchdog.stalled == true`,
- `session.state` is `failed` or `cancelled`,
- a clear reviewer startup/runtime error is present.

Manual cancel is valid and expected:
- If the review is taking too long for the user, the user may cancel manually.
- In interactive use, prefer manual user cancellation over agent-driven time-based fallback.
- Silence from the user is **not** a cancel signal; continue automatically after 30 seconds.

Compatibility Mode is now an explicit-failure fallback only:
- It may be used when there is an explicit failure signal.
- It must **not** be triggered solely because elapsed time is long or progress appears quiet.
- Agents must **not invent additional fallback heuristics** that are not explicitly listed in this workflow.
- In particular, rules such as `N minutes with no progress = startup stall = fallback` are **not allowed** unless this workflow explicitly defines them.

### Completion Guard

Do **not** declare a round or the whole review loop complete unless there is terminal proof.

Terminal proof means at least one of the following:
- the relevant session reached a valid terminal session state,
- the collaboration state machine reached a valid conclusion state for that round,
- the user explicitly asked to stop or cancel,
- an explicit failure signal was handled and reported as failure/inconclusive.

The following are **not** sufficient to declare completion:
- long silence,
- zero new findings by itself,
- `draft` or `awaiting_codex_turn` with no response yet,
- inability to advance the state machine,
- an agent assumption that the review is probably clean.

If a round is still active or still waiting for another agent's turn, the agent must keep polling or report the session as still in progress.
It must **not** write a final summary that claims `clean pass`, `review complete`, or `loop complete` without terminal proof.

Key principle:
- `slow != failure`
- `quiet != failure`
- wait for a real response unless there is a real failure signal or the user cancels

## Collaboration-Enhanced Flow (Preferred)

> This is the preferred shared-thread collaboration path.
> Every turn-sensitive message must include a valid `turnToken`.

### Role Boundary Rules

- An agent may act **only as itself**.
- Do **not** claim a turn on behalf of another agent.
- Do **not** post a turn-sensitive message on behalf of another agent.
- `agentId` in tool calls must match the actual acting agent.
- If `collabState = awaiting_codex_turn`, Antigravity must wait for Codex; it must **not** claim or complete Codex's turn.
- If `collabState = awaiting_antigravity_turn`, Codex must wait for Antigravity; it must **not** claim or complete Antigravity's turn.
- If a session is in an active turn-based state owned by another agent, the correct action is to wait, inspect status, or read safe state — not impersonate the other agent.

These role boundaries are mandatory.

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
    content: "Finding F-XXX is a false positive because the session context guarantees upstream validation before this call...",
    turnToken: antiTurn.token
})

// Advance: request rerun if fixes are needed, or mark the review complete
hub_advance_session({
    sessionId: "{SESSION_ID}",
    agentId: "antigravity",
    action: "request_rerun" // or "review_complete"
})
```

When rebutting or accepting findings, Antigravity should reference the same review context bundle used to create the session.
If new architectural context is discovered mid-review, add it explicitly to the message thread instead of assuming Codex already knows it.

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

Use this only when the **Progress-Based Fallback Rule** (Step 2.2) triggers — i.e., `stalePollCount >= 3` with no progress signals and `collabState` still in `draft` or `awaiting_assignment`.

**Do NOT fallback because:**
- The review is merely taking a long time (slow ≠ stuck)
- You've polled N times (use progress signals, not poll count)
- You're impatient (deep reviews are legitimately slow)

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

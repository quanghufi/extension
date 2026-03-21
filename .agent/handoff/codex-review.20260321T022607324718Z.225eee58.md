# Codex Review

## Overview
- Status: has_findings
- Summary: Tôi tìm thấy 8 vấn đề vật chất trong phần thay đổi hiện tại, chủ yếu quanh luồng debate/collab mới, autoStart, và Claude adapter.
- Findings: 8

## Key Findings

### 1. [HIGH] `autoStart:false` creates pending sessions that cannot be started through any public API
- Location: src/api-routes.js:45
- Why it matters: `apiCreateSession` now lets callers persist a `pending` session, but the server exposes no REST route to start that session later. This strands sessions in memory/storage and makes the new option unusable outside tests.
- Recommended fix: Either remove the public `autoStart:false` path, or add an explicit start endpoint/tool that transitions a pending session into `runSession()`. Also add an integration test that creates with `autoStart:false`, starts it through the public surface, and verifies completion.
- Confidence: high

### 2. [HIGH] `request_rerun` can be triggered during `antigravity_reviewing` without owning the turn token
- Location: src/hub/session.js:355
- Why it matters: The new turn-token enforcement omits `request_rerun`. While the responder is reviewing, any caller that knows the session/agent IDs can force a rerun without holding the claimed turn, bypassing the turn-based safety model.
- Recommended fix: Require `turnToken` for `request_rerun` when the current state is `antigravity_reviewing`, and add tests for missing-token and wrong-owner-token rejection.
- Confidence: high

### 3. [HIGH] Legacy mutation tools remain available while a debate is active
- Location: src/mcp-server.js:69
- Why it matters: The new debate gating was added for collab tools, but `hub_evaluate_findings` and `hub_rerun_review` still only check `collabState`. During an active debate, those tools can still mutate the same session concurrently, undermining the whole debate lockout.
- Recommended fix: Extend `getLegacyToolBlock()` or the individual handlers to reject `hub_evaluate_findings` and `hub_rerun_review` whenever `session.debateActive` is true. Mirror that behavior in the REST rebuttal routes and add coverage for both MCP tools during an active debate.
- Confidence: high

### 4. [HIGH] `runSession()` never performs the new collab auto-sync that the added tests expect
- Location: src/server.js:187
- Why it matters: The new tests assert that completed retry sessions auto-create a `review_summary` message and advance `collabState` to `awaiting_resolution` or `awaiting_antigravity_turn`, but `runSession()` still just finalizes and saves the session. As written, those tests should fail and the rerun UX remains unsynchronized.
- Recommended fix: After `session.finalize(...)`, detect retry/collab sessions, add the `review_summary` message, and transition `collabState` based on whether findings exist. Cover both zero-findings and has-findings cases with server-level tests.
- Confidence: high

### 5. [MEDIUM] Claude fallback parsing manufactures findings from generic free-text output
- Location: src/adapters/claude-code-parsing.js:168
- Why it matters: If Claude returns any long plain-text message containing words like `error`, `fix`, or `warning`, `parseClaudeResult()` synthesizes a medium-severity finding. That can turn malformed output, tool chatter, or review failures into bogus code findings and pollute consensus/debate results.
- Recommended fix: Remove the keyword-based synthetic finding fallback, or gate it behind a much stricter format check. Add tests for non-JSON success text, CLI error prose, and progress chatter to ensure they do not become findings.
- Confidence: high

### 6. [MEDIUM] Per-agent debate timeout profiles are dead code
- Location: src/hub/debate-orchestrator.js:423
- Why it matters: `DEBATE_AGENT_PROFILES` advertises shorter debate-specific budgets, but `runReviewPass()` never applies them; it just calls each adapter's normal `execute()`. A stuck Claude debate run will therefore inherit the adapter's full default timeout instead of the debate budget the code claims to enforce.
- Recommended fix: Plumb timeout overrides into debate execution, either by extending `adapter.execute()` to accept per-call timeouts or by wrapping adapters for debate runs. Add a test that verifies debate execution uses the profile values instead of the adapter defaults.
- Confidence: high

### 7. [MEDIUM] A debating agent is treated as the decider even when no tie-break review actually ran
- Location: src/hub/debate-orchestrator.js:598
- Why it matters: `resolveFinalFindings()` passes `decider` into `mergeFinalFindings()` whenever the configured decider is one of the debating agents. That lets one participant's ordinary vote silently become the authoritative tie-break for disputed findings, even if the debate resolved by threshold rather than by tie-break.
- Recommended fix: Only pass `decider` to `mergeFinalFindings()` when a separate tie-break evaluation was actually produced. If the decider is also a debating agent, either forbid that configuration or require an explicit extra tie-break pass and test the disputed-finding path.
- Confidence: medium

### 8. [MEDIUM] Debate failures do not emit the `debate_failed` event declared in the schema
- Location: src/server.js:255
- Why it matters: Clients subscribed over WS/MCP only see `debate_started`; on failure the server silently flips stored state to `failed` and exits. That leaves dashboards/agents without a terminal event to explain why the debate stopped.
- Recommended fix: In the `runDebate()` catch path, emit and broadcast a `debate_failed` event with the error message before saving the failed state. Add a test that forces `executor.run()` to throw and asserts subscribers receive `debate_failed`.
- Confidence: high

## Recommendations
- Add a real start path for `autoStart:false` sessions or remove that public option.
- Implement the missing run-to-collab synchronization after `runSession()` finalization and verify the new server tests pass.
- Tighten mutation guards: enforce turn tokens for `request_rerun` in active review states and block all legacy mutation tools/routes during active debate.
- Fix debate robustness: emit `debate_failed`, apply timeout profiles during debate runs, and only grant decider authority when an explicit tie-break evaluation exists.
- Harden Claude parsing so unstructured/free-text output cannot become synthetic findings without strong evidence.
- Rerun review: yes

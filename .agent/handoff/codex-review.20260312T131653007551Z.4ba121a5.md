# Codex Review

## Overview
- Status: has_findings
- Summary: The MCP path is not behaviorally equivalent to the existing HTTP flow yet. The biggest regressions are stalled reviews hanging until timeout, tool-level failures being reported as successful clean reviews, and evaluate/rerun semantics diverging from the REST implementation and the updated workflow docs.
- Findings: 9

## Key Findings

### 1. [CRITICAL] `waitForCompletion` never stops on stalled sessions, so `waitForCompletion: true` masks reviewer stalls until the hard timeout
- Location: src/mcp-server.js:95
- Why it matters: The updated contract says stalled reviews must stop immediately and surface `reviewer_stalled`. The current MCP implementation only waits for terminal `state` values, but stalled sessions remain `running`, so callers block for up to 10 minutes and lose the intended retry path.
- Recommended fix: Update `HubManager.waitForCompletion()` to check `session.getDisplayState()` or `session.getWatchdogStatus().stalled` on each poll. When stalled, throw a dedicated error or return a structured stalled result so `hub_create_review` and `hub_rerun_review` can surface `reviewer_stalled` immediately instead of waiting for timeout.
- Confidence: high

### 2. [HIGH] Adapter ignores MCP tool errors and can report execution failures as successful zero-finding reviews
- Location: src/adapters/mcp-adapter.js:457
- Why it matters: `codex_review_mcp.py` returns tool results with `isError: true` on failures, but `McpCodexAdapter.execute()` never checks that flag. If the bridge fails, the adapter can parse an empty `review.findings` array, mark the run `ok`, and finalize the session as `completed`, which is a false clean review.
- Recommended fix: After `callTool()`, inspect the returned `isError` flag and validate that a structured review payload is present. If `isError` is true or the review payload is missing/invalid, emit an error event and set adapter status to `failed` instead of converting an empty result to success.
- Confidence: high

### 3. [HIGH] `hub_evaluate_findings` bypasses the existing rebuttal model and never persists evaluations
- Location: src/mcp-server.js:297
- Why it matters: The REST path normalizes rebuttals, updates legacy evaluations, and saves the session. The MCP tool just pushes `{target, verdict, rationale}` records into `session.rebuttals` in memory. Those records use a different verdict vocabulary (`accepted/rejected/disputed` instead of `accept/reject/defer/...`), are not written to disk, and are incompatible with the appeal/rerun logic in `src/hub/rebuttal.js`.
- Recommended fix: Replace the custom `hub_evaluate_findings` logic with the same normalization/persistence flow used by `apiEvaluateFindings`: map MCP verdicts to the canonical rebuttal verdicts, call `normalizeRebuttalInput()`, update `session.evaluations`, assign `session.rebuttals = upsertRebuttal(...)`, and `server.store.save(session)` before returning.
- Confidence: high

### 4. [HIGH] `hub_rerun_review` skips the HTTP rerun safeguards and semantics
- Location: src/mcp-server.js:376
- Why it matters: The REST rerun route enforces the 5-round cap, supports appeal vs reverify modes, builds the appeal prompt from rebuttals, and derives rebuttal outcomes after the child review completes. The MCP rerun tool does none of that, so MCP users can exceed 5 rounds and lose the feedback-chain behavior the workflow documents describe.
- Recommended fix: Make `hub_rerun_review` mirror `apiRerunSession`: reject reruns when `session.round >= 5`, accept mode/context/snapshot inputs, use `buildAppealPrompt()` for appeal mode, persist the child session, and after completion compute `deriveAppealOutcomes()` and save the updated child session.
- Confidence: high

### 5. [MEDIUM] `src/mcp-server.js` imports `zod` directly but `package.json` does not declare it as a direct dependency
- Location: package.json:45
- Why it matters: The new MCP server has a hard runtime import on `zod`, but the package only declares `@modelcontextprotocol/sdk`. The current lockfile happens to contain `zod`, but consumers installing from the published package are relying on a transitive/peer resolution detail instead of an explicit dependency.
- Recommended fix: Add `zod` to `dependencies` in `package.json` and refresh `package-lock.json`. Treat it as a first-class runtime dependency because `src/mcp-server.js` imports it directly.
- Confidence: medium

### 6. [MEDIUM] `poll_hub.js` assumes `/api/sessions` returns an array and reads the wrong status fields
- Location: scripts/poll_hub.js:22
- Why it matters: `apiListSessions()` returns `{ sessions: [...] }`, not a bare array. `poll_hub.js` therefore treats the whole response object as an array, so `latest` becomes `undefined`. Its status branch also reads `data.displayState` instead of `data.session.displayState`, so even manual debugging output is misleading.
- Recommended fix: Parse the list response as `const { sessions } = await httpGet('/api/sessions')`, then select from `sessions`. For session status, read `data.session.state`, `data.session.displayState`, and `data.watchdog` to match the actual REST payload.
- Confidence: high

### 7. [MEDIUM] `review_and_poll.js` does not call the existing HTTP API correctly, so it never creates the intended file-targeted review
- Location: scripts/review_and_poll.js:31
- Why it matters: `POST /api/sessions` expects nested `reviewOptions`, but the script sends `reviewTarget`, `filePath`, and `maxFindings` at the top level. The server ignores those fields and starts a default uncommitted review instead. The polling code also reads `status.displayState` instead of `status.session.displayState`, so it does not reflect the actual API shape.
- Recommended fix: Send `reviewOptions: { review_target: 'file', file_path: '...', max_findings: 15 }` in the create request, and read `status.session.displayState` from `/api/sessions/:id`. If this script is meant to exercise MCP instead of HTTP, switch it to the MCP client entirely and remove the stale HTTP assumptions.
- Confidence: high

### 8. [MEDIUM] `hub_get_status` returns a different shape than the documented contract and HTTP fallback
- Location: src/mcp-server.js:247
- Why it matters: The updated docs tell Antigravity to read `session.state` and `session.displayState`, but the MCP tool currently flattens the session object into the top level. A client following the new contract literally will look for `session.displayState` and get `undefined`, which breaks the state machine in both new workflow documents.
- Recommended fix: Return a payload shape that matches the documented contract and the HTTP API: `{ session: session.toJSON(), watchdog: session.getWatchdogStatus(), lineage?: ... }`. Update all MCP tools to keep field names aligned with the workflow examples.
- Confidence: high

### 9. [LOW] The new tests do not exercise any MCP tool behavior, which leaves the regressions above undetected
- Location: src/mcp-server.test.js:34
- Why it matters: `src/mcp-server.test.js` only checks that `buildMcpServer()` returns objects and that `HubManager` exposes methods. It does not cover stalled-session handling, payload shapes, evaluation persistence, rerun semantics, or adapter handling of MCP tool errors, so the current parity gaps can ship unnoticed.
- Recommended fix: Add behavioral tests that invoke `hub_create_review`, `hub_get_status`, `hub_evaluate_findings`, and `hub_rerun_review` against a temporary in-process hub. Also add adapter tests for `isError` tool responses and stalled-session completion paths.
- Confidence: high

## Recommendations
- Make the MCP server tool contracts match the existing REST behavior and the updated workflow documents, starting with `hub_get_status`, `hub_evaluate_findings`, and `hub_rerun_review`.
- Fix stalled-review handling end-to-end: stop `waitForCompletion()` on watchdog stalls and propagate that state through `hub_create_review`/`hub_rerun_review`.
- Harden `McpCodexAdapter` so MCP tool failures cannot be reported as successful clean reviews.
- Repair or remove the broken debug scripts that still assume the old HTTP payload shapes.
- Add integration-style tests for MCP tool payloads, persistence, rerun semantics, and adapter error propagation, then rerun the review.
- Rerun review: yes

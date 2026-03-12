# Codex Review

## Overview
- Status: has_findings
- Summary: The MCP migration introduces several behavior regressions: wait-for-completion no longer stops on stalled reviews, MCP evaluation data is stored in a shape the rest of the hub cannot consume or persist, and multiple new helper/test scripts still target the old HTTP/protocol contracts. The current tests do not cover these paths.
- Findings: 10

## Key Findings

### 1. [HIGH] The adapter removed idle-timeout detection, so the promised 3-tier timeout strategy is no longer implemented
- Location: src/adapters/mcp-adapter.js:45
- Why it matters: The project decisions require `firstByte/idle/hard` timeouts. The new SDK path only races `connect()` against `firstByteMs` and `callTool()` against `hardMs`; `idleMs` is defined but never enforced. A review that connects successfully and then stops emitting progress will sit until the hard timeout instead of being classified as a stall and retried.
- Recommended fix: Add an inactivity watchdog around the review call. Reset it on observable activity, abort the request when `idleMs` is exceeded, classify that case as `stall`, and cover the behavior with an integration-style test that simulates a hung review after initialization.
- Confidence: high

### 2. [HIGH] `waitForCompletion` never stops on watchdog stalls, so `waitForCompletion: true` can hang until the generic 10 minute timeout
- Location: src/mcp-server.js:95
- Why it matters: The new contract and workflow docs tell Antigravity to use `waitForCompletion: true`, but this loop only exits on terminal `session.state` values. A stalled review keeps `state === "running"` and only changes `displayState`/`watchdog.stalled`, so MCP callers will keep waiting instead of getting the required `reviewer_stalled` outcome.
- Recommended fix: In `HubManager.waitForCompletion`, check `session.getDisplayState()` or `session.getWatchdogStatus().stalled` on every poll. If the session is stalled, stop immediately and return or throw a specific stalled error that `hub_create_review`/`hub_rerun_review` can surface distinctly from a hard timeout.
- Confidence: high

### 3. [HIGH] `hub_evaluate_findings` stores rebuttals in a schema that is incompatible with the rest of the hub
- Location: src/mcp-server.js:313
- Why it matters: This tool writes `{ target: <dedupeKey string>, verdict: 'accepted'|'rejected'|'disputed' }`, but the existing rebuttal pipeline expects normalized records with `target.{dedupeKey,findingId}` and verdicts like `accept`/`reject`/`defer`. Any later code that assumes normalized rebuttals will misread or break on MCP-created evaluations.
- Recommended fix: Replace the ad hoc mapping with the same normalization path used by the REST API: map MCP verdicts to the internal verdict vocabulary, call `normalizeRebuttalInput`, update `session.rebuttals` via `upsertRebuttal`, and keep `session.evaluations` in sync via `toLegacyEvaluation`.
- Confidence: high

### 4. [HIGH] MCP evaluations are never persisted to the session store
- Location: src/mcp-server.js:320
- Why it matters: `hub_evaluate_findings` mutates the in-memory session but never calls `server.store.save(session)`. Any restart, reload, or lookup that falls back to disk loses the user's accepted/rejected findings, which breaks rerun history and auditability.
- Recommended fix: After applying evaluations, call `server.store.save(session)` before returning the tool result. Add a test that evaluates findings, reloads the session from the store, and verifies the rebuttals/evaluations are still present.
- Confidence: high

### 5. [MEDIUM] `scripts/poll_hub.js` is written against response shapes the current REST API does not return
- Location: scripts/poll_hub.js:22
- Why it matters: `GET /api/sessions` returns `{ sessions }`, not a bare array, and `GET /api/sessions/:id` nests `displayState` under `session`. As written, the helper prints `undefined` or the wrong state, which makes manual validation unreliable.
- Recommended fix: Read `sessions.sessions` from the list response, and use `data.session?.displayState` for status polling. Add a small smoke test or fixture-based assertion so the script is checked against the current API contract.
- Confidence: high

### 6. [MEDIUM] `scripts/review_and_poll.js` also reads the wrong status shape, so its stall detection is operating on undefined data
- Location: scripts/review_and_poll.js:63
- Why it matters: The script uses `status?.displayState`, but the REST handler returns `session.displayState`. That means the log and stall logic are not observing the actual display state from the server, undermining the debugging path this script is supposed to provide.
- Recommended fix: Change the status parsing to `status?.session?.displayState` and keep the watchdog fields aligned with the actual REST payload. Verify the script against a real or mocked `/api/sessions/:id` response before using it as evidence.
- Confidence: high

### 7. [MEDIUM] `scripts/test_mcp_raw.js` still speaks Content-Length framing even though the Python bridge was changed to newline-delimited JSON
- Location: scripts/test_mcp_raw.js:52
- Why it matters: This helper is now guaranteed to report a false failure against the new bridge protocol. Given the repo status explicitly says the spike needs rerunning with corrected tests, keeping a raw test on the old framing is likely to generate misleading evidence again.
- Recommended fix: Update the script to send one JSON-RPC message per line, or replace it with an SDK-based smoke test so it exercises the same transport as production. Remove the remaining `Content-Length` writes at both initialize and `notifications/initialized`.
- Confidence: high

### 8. [MEDIUM] The MCP server starts its private HubServer on a random port, so the documented HTTP fallback points at the wrong process
- Location: src/mcp-server.js:67
- Why it matters: The new docs and helper scripts still say HTTP fallback is `http://localhost:3849`, but `HubManager.ensureReady()` creates a HubServer with `port: 0`. That means MCP sessions live in a different in-process hub than the documented fallback port, so fallback debugging and cross-checking will hit a different server or no server at all.
- Recommended fix: Either run the embedded HubServer on the configured shared port used by the docs, or remove the HTTP fallback claims/scripts for the MCP-managed process and expose the actual bound port in tool output/logging.
- Confidence: high

### 9. [MEDIUM] `hub_get_status` response shape does not match the new contract docs
- Location: src/mcp-server.js:244
- Why it matters: The contract tells callers to inspect `session.state` and `session.displayState`, but the MCP tool returns a flattened JSON object from `session.toJSON()` rather than `{ session: ... }`. A caller following the documented shape will read the wrong fields and miss stalled/terminal states.
- Recommended fix: Choose one shape and make code and docs agree. The safest fix is to return `{ session: session.toJSON(), watchdog: session.getWatchdogStatus() }` so the MCP tool matches the existing REST contract and published workflow examples.
- Confidence: high

### 10. [MEDIUM] The new tests do not exercise the behaviors most likely to regress in this migration
- Location: src/mcp-server.test.js:36
- Why it matters: `src/mcp-server.test.js` only checks construction, and `src/adapters/mcp-adapter.test.js` only checks helper functions. They never cover an actual SDK round-trip, stalled `waitForCompletion`, evaluation persistence, or MCP-to-internal rebuttal mapping, so the main migration risks above can ship unnoticed.
- Recommended fix: Add integration-style tests that spin up the MCP server/adapter in-process and cover: successful tool handshake, stalled review handling with `waitForCompletion`, `hub_evaluate_findings` persistence plus internal schema normalization, and rerun behavior after evaluations.
- Confidence: high

## Recommendations
- Make `waitForCompletion` stall-aware and return a distinct stalled outcome instead of hanging until the hard timeout.
- Unify MCP evaluation handling with the existing rebuttal pipeline and persist the updated session after every evaluation.
- Restore the documented 3-tier timeout behavior in the adapter, including real idle/stall detection and retry coverage.
- Reconcile MCP/REST/docs/tool-script payload shapes so callers and debug scripts read the same fields.
- Update the raw/debug scripts to the new MCP framing and current REST payloads, then add end-to-end tests that cover the migrated paths.
- Rerun review: yes

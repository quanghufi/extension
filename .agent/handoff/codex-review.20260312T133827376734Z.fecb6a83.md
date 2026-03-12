# Codex Review

## Overview
- Status: has_findings
- Summary: Found 10 material issues in the MCP hub integration and supporting scripts/tests. The highest-risk regressions are broken evaluation persistence, inability to rerun stalled sessions, registry reset dropping the default MCP adapter, and an undocumented status payload change that breaks tool consumers.
- Findings: 10

## Key Findings

### 1. [HIGH] `resetRegistry()` drops the built-in `mcp-codex` adapter
- Location: src/adapters/adapter-registry.js:141
- Why it matters: Any test or runtime path that calls `resetRegistry()` leaves the registry without the default MCP adapter. Subsequent session execution fails with `No adapter registered for "mcp-codex"`, which is now the default agent in the hub.
- Recommended fix: Update `resetRegistry()` to re-register both built-ins, mirroring module initialization: `new CodexAdapter()` and `new McpCodexAdapter()`. Add a regression test that calls `resetRegistry()` and then asserts `getAdapter('mcp-codex')` succeeds.
- Confidence: high

### 2. [HIGH] `ensureReady()` is not singleton-safe and can start multiple hub instances concurrently
- Location: src/mcp-server.js:60
- Why it matters: Two MCP tool calls arriving while the manager is still idle will both enter startup, create different `HubServer` instances, and race to overwrite `this._hub`. Sessions created on the first instance can become unreachable from later tool calls.
- Recommended fix: Memoize startup with a shared promise, e.g. `this._startingPromise`, and return it to concurrent callers until initialization settles. Only create one `HubServer` instance per manager lifetime.
- Confidence: medium

### 3. [HIGH] MCP evaluations bypass the real rebuttal pipeline and are never persisted
- Location: src/mcp-server.js:323
- Why it matters: `hub_evaluate_findings` stores ad-hoc objects with verdicts like `accepted`/`rejected`, but the rest of the hub expects normalized rebuttals with verdicts `accept`/`reject`/`defer` and updates `session.evaluations` plus the session store. Today MCP evaluations disappear on restart and will not drive appeal/rerun logic correctly.
- Recommended fix: Replace the manual `session.rebuttals.push(...)` block with the same normalization and persistence flow used by `apiEvaluateFindings`: normalize each input via `normalizeRebuttalInput`, upsert it, update `session.evaluations`, and call `server.store.save(session)`. Map MCP verdict labels to the canonical internal values or change the MCP schema to use the canonical values directly.
- Confidence: high

### 4. [HIGH] `hub_rerun_review` cannot rerun stalled sessions even though the contract tells clients to do that
- Location: src/mcp-server.js:375
- Why it matters: A stalled review still has `session.state === 'running'`, so the terminal-state guard rejects reruns with `Cannot rerun`. That leaves clients stuck exactly in the failure mode the new workflow is supposed to recover from.
- Recommended fix: Allow reruns when `session.getDisplayState() === 'stalled'` or `session.getWatchdogStatus().stalled === true`, not just when the base state is terminal. If you keep the original session running, mark the rerun as a recovery child session explicitly so clients can proceed immediately.
- Confidence: high

### 5. [MEDIUM] `src/mcp-server.js` imports `zod`, but `package.json` does not declare it directly
- Location: package.json:45
- Why it matters: The new CLI entrypoint depends on `zod` at runtime. It currently works only because npm happened to auto-install a transitive peer from `@modelcontextprotocol/sdk`; that is not a safe packaging contract and can break installs under different package-manager or dependency-resolution behavior.
- Recommended fix: Add `zod` to the package's direct dependencies and regenerate the lockfile. Do not rely on `@modelcontextprotocol/sdk` to provide modules that this package imports directly.
- Confidence: high

### 6. [MEDIUM] `poll_hub.js` misreads the list endpoint response and returns `undefined` for the latest session
- Location: scripts/poll_hub.js:22
- Why it matters: `GET /api/sessions` returns `{ sessions: [...] }`, not a raw array. The current `sessions[sessions.length - 1]` logic reads properties off the wrapper object, so the `list` action cannot reliably show anything useful.
- Recommended fix: Read `const response = await httpGet('/api/sessions'); const latest = response.sessions?.[response.sessions.length - 1];` and handle the empty-list case explicitly.
- Confidence: high

### 7. [MEDIUM] `poll_hub.js` and `review_and_poll.js` look for `displayState` at the wrong level
- Location: scripts/poll_hub.js:31
- Why it matters: The REST status endpoint returns `{ session, lineage, watchdog }` with `displayState` nested under `session`. Both helper scripts read `data.displayState` / `status.displayState`, so they can miss the stalled state they are supposed to detect.
- Recommended fix: Read `data.session?.displayState` (and the equivalent in `review_and_poll.js`) instead of a top-level field. Keep the watchdog fallback, but do not depend on it as the only stalled signal.
- Confidence: high

### 8. [MEDIUM] `review_and_poll.js` sends unsupported session-creation fields, so file-target reviews silently degrade
- Location: scripts/review_and_poll.js:28
- Why it matters: The REST `POST /api/sessions` handler reads `reviewOptions`, not top-level `reviewTarget`/`filePath`/`maxFindings`. This script therefore creates a default uncommitted review instead of reviewing the requested file, which makes its output misleading.
- Recommended fix: Wrap those values under `reviewOptions` using the server's expected keys: `{ reviewOptions: { review_target: 'file', file_path: '...', max_findings: 15 } }`, or change the server to accept the top-level aliases consistently.
- Confidence: high

### 9. [MEDIUM] `hub_get_status` returns a different shape than the documented contract and REST API
- Location: src/mcp-server.js:257
- Why it matters: The workflow docs and existing consumers expect `session.state` / `session.displayState`, but this tool flattens session fields at the top level. Any MCP client implemented from the new contract will read the wrong fields and miss stalled/completed transitions.
- Recommended fix: Return the same shape as the REST endpoint: `{ session: session.toJSON(), lineage, watchdog }`, or update every documented consumer and helper to the flattened schema. Prefer reusing the REST shape to avoid a second incompatible contract.
- Confidence: high

### 10. [MEDIUM] The new tests do not cover the MCP tool behaviors that regressed
- Location: src/mcp-server.test.js:14
- Why it matters: `src/mcp-server.test.js` only asserts constructor smoke paths, so CI would not catch the broken status payload, missing evaluation persistence, stalled-rerun rejection, or startup race. The registry regression also has no dedicated test.
- Recommended fix: Add behavioral tests for each MCP tool: `hub_get_status` response shape, `hub_evaluate_findings` persistence/normalization, `hub_rerun_review` on stalled sessions, and concurrent `ensureReady()` calls. Add a registry test that verifies `resetRegistry()` still exposes `mcp-codex`.
- Confidence: high

## Recommendations
- Fix the adapter registry reset path so both built-in adapters are restored after tests or runtime resets.
- Make the MCP server reuse a single startup promise, then align `hub_get_status` with the REST/status contract.
- Rewrite `hub_evaluate_findings` to call the existing rebuttal normalization and persistence flow instead of appending raw objects.
- Allow `hub_rerun_review` to recover stalled sessions based on watchdog/display state, not only terminal state.
- Declare `zod` directly in `package.json` and regenerate `package-lock.json`.
- Correct the helper scripts to use the actual REST request/response shapes (`reviewOptions`, `response.sessions`, `session.displayState`).
- Expand tests to cover MCP tool semantics and the `resetRegistry()` regression before rerunning review.
- Rerun review: yes

# Codex Review

## Overview
- Status: has_findings
- Summary: Reviewed `src/server.js`. The main regressions are an adapter compatibility break in `runSession`, missing persistence of terminal session state, and an overly permissive CORS policy that now protects additional mutating endpoints.
- Findings: 6

## Key Findings

### 1. [HIGH] `reviewOptions` are passed as an object to every adapter, which breaks the legacy `codex` adapter
- Location: src/server.js:134
- Why it matters: `runSession()` now builds `promptArg` as an object whenever `session.reviewOptions` is present, then passes it to `adapter.execute()` without checking the adapter type. `CodexAdapter.buildCommand()` still expects a string prompt and calls `formatReviewPrompt(prompt)`, which does `prompt.trim()`. Any session that sets `agentId: "codex"` together with `reviewOptions` will now throw before the review starts.
- Recommended fix: Only pass an object prompt to adapters that explicitly support structured review options, or normalize `promptArg` by adapter id. For example, keep `promptArg = session.prompt` for `codex`/BaseAdapter-based adapters and use the object form only for `mcp-codex`. Add a regression test that creates a session with `agentId: "codex"` plus `reviewOptions` and verifies the run completes instead of throwing.
- Confidence: high

### 2. [HIGH] Completed or failed session state is never persisted after `runSession()` finishes
- Location: src/server.js:151
- Why it matters: `apiEvaluateFindings()` and `apiRerunSession()` both load from `activeSessions` or `store`. `runSession()` updates the in-memory session with final state and findings, but never calls `server.store.save(session)` after success or failure. After a restart, eviction, or any future change that removes completed sessions from memory, the store still contains the original pre-run session, so evaluation and rerun can incorrectly return 409/empty data.
- Recommended fix: Persist the session after terminal transitions. Call `this.store.save(session)` immediately after `session.finalize(...)` in the success path and again in the error path after `session.finalize('failed')`. Add an integration test that runs a session, clears `activeSessions`, then verifies `GET /api/sessions/:id`, `/findings/evaluate`, and `/rerun` still operate on the stored terminal session.
- Confidence: high

### 3. [HIGH] Wildcard CORS exposes destructive localhost endpoints to any website
- Location: src/server.js:175
- Why it matters: The server sends `Access-Control-Allow-Origin: *` and permits `POST` and `DELETE` for all requests. With the new rerun/evaluate routes, any webpage the user visits can drive the local hub from the browser, trigger reviews, mutate evaluations, or delete sessions, which is a meaningful localhost CSRF/exfiltration risk.
- Recommended fix: Remove wildcard CORS by default. Restrict allowed origins to the local UI origin(s), or require an explicit allowlist from configuration. For mutating routes, add CSRF protection or a shared secret header and reject requests that do not present it. Add tests proving cross-origin requests without the trusted origin/header are rejected.
- Confidence: high

### 4. [MEDIUM] User-supplied `reviewOptions.prompt` can silently override `session.prompt`
- Location: src/server.js:135
- Why it matters: The merge order is `{ prompt: session.prompt, ...session.reviewOptions }`, so any `prompt` key inside `reviewOptions` replaces the canonical session prompt. Because `reviewOptions` comes from request data and is not validated here, the server can end up reviewing with different instructions than the session record suggests, which is a hard-to-debug correctness issue.
- Recommended fix: Reverse the merge order to `{ ...session.reviewOptions, prompt: session.prompt }` or, better, validate and whitelist the supported review option keys before constructing the adapter payload. Add a test that sends `reviewOptions.prompt` and verifies the adapter receives `session.prompt`, not the override.
- Confidence: high

### 5. [MEDIUM] HTTP route wiring for the new endpoints is untested in `HubServer`
- Location: src/server.js:208
- Why it matters: There are unit tests for `apiEvaluateFindings()` and `apiRerunSession()`, but no server-level tests that exercise the actual `POST /api/sessions/:id/findings/evaluate` and `POST /api/sessions/:id/rerun` paths. A typo in the regex, wrong segment index, or future route ordering change in `src/server.js` would pass current tests and break the API.
- Recommended fix: Add `server.test.js` coverage for both HTTP routes through `apiRequest()`: success cases, unknown session 404s, and conflict cases. Assert that the correct session id is extracted and that the handlers are reachable only via the intended HTTP methods.
- Confidence: high

### 6. [LOW] `start()` never rejects on listen errors, so boot failures can hang callers
- Location: src/server.js:65
- Why it matters: `start()` resolves on `listen`, but it does not attach an `'error'` handler to reject the promise. If the port is already in use or binding fails, startup can become an unhandled server error instead of a cleanly failed promise, which makes CLI startup and tests flaky.
- Recommended fix: Before calling `listen()`, attach `this._server.once('error', reject)` and remove that listener after a successful `listen` callback. Add a test that attempts to start two servers on the same port and asserts the second `start()` rejects.
- Confidence: medium

## Recommendations
- Gate structured `promptArg` payloads to `mcp-codex` (or adapters that declare support) and keep string prompts for legacy adapters.
- Persist sessions after successful and failed runs so the new evaluate/rerun APIs work from stored state, not only in-memory state.
- Lock down CORS/auth for localhost mutating endpoints before shipping the new route surface.
- Validate or whitelist `reviewOptions` keys so request payloads cannot override the canonical prompt.
- Add `src/server.test.js` coverage for the new HTTP routes and for startup/listen error handling.
- Rerun review: yes

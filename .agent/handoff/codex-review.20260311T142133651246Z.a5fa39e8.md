# Codex Review

## Overview
- Status: has_findings
- Summary: Review of `src/server.js` found a small set of material issues, centered on adapter compatibility, persistence of terminal session state, and error-handling gaps that can leave the process or clients in a bad state.
- Findings: 5

## Key Findings

### 1. [HIGH] `reviewOptions` are passed to every adapter, breaking non-MCP adapters that still expect a string prompt
- Location: src/server.js:134
- Why it matters: The new `promptArg` object is built whenever `session.reviewOptions` exists, but `adapter.execute()` is called for any `agentId`. Existing adapters and custom `GenericAdapter` implementations commonly treat the third argument as a plain string prompt. With this change, file-scoped reviews routed through anything other than `mcp-codex` can misbuild commands, stringify `[object Object]`, or fail outright.
- Recommended fix: Only wrap the prompt into an object for adapters that explicitly support structured review options, for example `if (agentId === 'mcp-codex')`. Keep passing `session.prompt` unchanged to other adapters until the adapter interface is versioned and all implementations are updated. Add a server test that creates a session with `reviewOptions` and a non-MCP adapter and asserts the adapter receives a string prompt.
- Confidence: high

### 2. [HIGH] Completed or failed runs are never saved back to the session store
- Location: src/server.js:151
- Why it matters: `apiCreateSession` and rerun creation save the session before execution, but `runSession()` never persists the final state, findings, or emitted terminal events after `finalize()`. After a process restart, the newly added `/findings/evaluate` and `/rerun` endpoints will load stale on-disk sessions that still appear pending or lack findings, which breaks the Phase 1 workflow and loses evidence.
- Recommended fix: After every state transition that changes durable session data, call `this.store.save(session)`. At minimum, persist once after the success path finalizes and once after the failure path finalizes. Add an integration test that runs a session, clears `activeSessions`, reloads it via `server.store.load()`, and verifies the terminal state and findings are still present.
- Confidence: high

### 3. [MEDIUM] `start()` can hang forever on bind errors because the promise never rejects
- Location: src/server.js:64
- Why it matters: The returned promise resolves only from the `listen()` callback and does not subscribe to the server `error` event. If the port is already in use or binding fails for any reason, callers awaiting `start()` can block indefinitely and the startup `catch` at the bottom of the file will never run.
- Recommended fix: Attach a one-time `error` listener before calling `listen()` and reject the promise on startup failures. Remove the listener after successful bind. Add a test that occupies a port first, calls `start()`, and asserts the returned promise rejects with `EADDRINUSE` or the platform-equivalent error.
- Confidence: high

### 4. [MEDIUM] Synchronous failures in `runSession()` do not emit a terminal status event
- Location: src/server.js:153
- Why it matters: If `getAdapter(agentId)` throws, `session.start()` throws, or any other error occurs before the adapter emits its own `done` status, the catch block only appends an `error` event and finalizes the session. WebSocket clients and UIs that key off status transitions will never see a terminal `status` event for that run, so they can remain stuck in a running/error intermediate state.
- Recommended fix: In the catch block, append and broadcast a terminal system status event such as `{ state: 'failed' }` before or together with `session.finalize('failed')`, then persist the session. Add a regression test that forces `getAdapter()` to throw and asserts the last event is a `status` event with `payload.state === 'failed'`.
- Confidence: high

### 5. [MEDIUM] Static file responses can crash or hang on stream errors
- Location: src/server.js:238
- Why it matters: `existsSync()` followed by `createReadStream().pipe(res)` has a race window: the file can disappear or become unreadable after the existence check. Without an `error` handler on the stream, Node can emit an unhandled stream error or leave the HTTP response incomplete.
- Recommended fix: Replace the `existsSync()`/`pipe()` pattern with a stream that listens for `error` and converts `ENOENT` to 404 and other read failures to 500 before ending the response. Add a test that stubs `fs.createReadStream` to emit an error and verifies the server returns a handled HTTP error instead of crashing.
- Confidence: medium

## Recommendations
- Gate structured `promptArg` construction by adapter capability instead of applying it to every adapter.
- Persist sessions after successful and failed finalization so terminal state, findings, and rebuttal workflows survive process restarts.
- Emit a terminal `failed` status event from the `runSession()` catch path before finalizing.
- Make `start()` reject on HTTP server bind errors.
- Handle `createReadStream` errors explicitly in `_serveStatic()` and cover the failure path with tests.
- Rerun review: yes

# Codex Review

## Overview
- Status: has_findings
- Summary: 6 material issues in src/server.js: one adapter-compatibility regression, one filesystem exposure, two lifecycle/resource-leak bugs, one persistence gap, and one startup error-handling hole.
- Findings: 6

## Key Findings

### 1. [HIGH] Server shutdown does not cancel in-flight reviews, so child processes can outlive the server
- Location: src/server.js:84
- Why it matters: `stop()` closes WebSockets and the HTTP listener, but it does nothing to terminate running adapter processes. A long-lived review can keep consuming CPU/memory after the server is considered stopped, leaving orphaned subprocesses and dangling event listeners. This directly violates the cleanup requirements in the review brief.
- Recommended fix: Track a per-session cancellation handle from `adapter.execute()` or wrap adapters so `runSession()` can abort them. In `stop()`, iterate active running sessions, request cancellation, wait for termination, then close the WebSocket and HTTP servers. Add a test with a stub adapter that blocks until cancelled and verify `stop()` terminates it.
- Confidence: high

### 2. [HIGH] Session mutations are never persisted after the run starts or finishes
- Location: src/server.js:122
- Why it matters: `apiCreateSession` saves the initial pending session, but `runSession()` mutates state, events, findings, and terminal status entirely in memory. After a restart, completed/failed sessions revert to the stale on-disk copy, which breaks rerun/evaluation flows and makes run history unreliable.
- Recommended fix: Call `this.store.save(session)` after each state-changing milestone: after `session.start()`, after appending/broadcasting terminal/error events, and after `session.finalize(...)`. If you want to avoid saving on every streamed event, at minimum persist on start, on terminal completion, and in the error path. Add a test that runs a session, reloads it from `SessionStore`, and verifies the persisted state/events/findings are terminal and current.
- Confidence: high

### 3. [HIGH] `reviewOptions` is now passed to every adapter as an object, which breaks non-MCP adapters
- Location: src/server.js:134
- Why it matters: `BaseAdapter`/`GenericAdapter` and the built-in `codex` adapter expect `prompt` to be a string. After this change, any session that sets `reviewOptions` and uses a non-`mcp-codex` adapter will receive an object instead, which can produce malformed CLI args (`[object Object]`), wrong prompts, or adapter crashes. This is a regression introduced by the new `promptArg` flow.
- Recommended fix: Only build the object-shaped prompt for `mcp-codex` (or adapters that explicitly declare support for structured prompt input). For all other adapters, pass `session.prompt` unchanged. Add a regression test that creates a session with `agentId: 'codex'` plus `reviewOptions` and verifies `adapter.execute()` still receives a string prompt.
- Confidence: high

### 4. [HIGH] `snapshotPath` is used as the actual execution workspace without any validation
- Location: src/server.js:137
- Why it matters: The new `executionPath = session.snapshotPath ?? session.projectDir` behavior makes `snapshotPath` security-sensitive. Both session creation and rerun APIs accept this field from the request, so a client can point the reviewer at arbitrary host paths outside the managed snapshot area. That expands the server's filesystem read surface and breaks the intended immutable-snapshot model.
- Recommended fix: Reject client-supplied arbitrary paths here unless they resolve inside the server-managed snapshot root. Prefer storing a snapshot ID and resolving it server-side, or verify `snapshotPath` exists under `this.snapshots.baseDir` before executing. Add tests covering rejection of paths outside the snapshot directory.
- Confidence: high

### 5. [HIGH] Completed and failed sessions are never removed from `activeSessions`
- Location: src/server.js:151
- Why it matters: `activeSessions` only grows unless the user explicitly deletes sessions. Every finished session retains its event log, findings, agent state, and any lineage metadata in memory indefinitely. Reruns make this worse because each retry adds another permanently retained session object. This is the orphaned-session leak called out in the review focus.
- Recommended fix: After persisting a terminal session, remove it from `this.activeSessions` unless there is a strong reason to keep a bounded hot cache. If a cache is needed, implement an eviction policy instead of unbounded retention. Add a test that runs a session to completion and asserts it is no longer present in `activeSessions` while still retrievable from the store.
- Confidence: high

### 6. [MEDIUM] A duplicate `runSession()` call turns a valid running session into `failed`
- Location: src/server.js:122
- Why it matters: `session.start()` throws when the state is already `running`, but the surrounding `try/catch` treats that as a runtime failure, emits an error event, and finalizes the session as failed. Any accidental second invocation for the same ID races the real run and corrupts session state instead of being ignored or rejected cleanly.
- Recommended fix: Guard `runSession()` before calling `session.start()`: if the session is already `running`, return early or throw a dedicated non-fatal error that is not converted into a failed session. Keep the existing failure path only for actual adapter/runtime failures. Add a test that calls `runSession()` twice on the same pending session and verifies the second call does not flip the session to `failed`.
- Confidence: medium

## Recommendations
- Gate structured prompt passing to `mcp-codex` only, and keep string prompts for other adapters.
- Validate `snapshotPath` against the managed snapshot root before using it as the execution workspace.
- Persist session state at start/completion/error and evict terminal sessions from `activeSessions` after saving.
- Introduce explicit session/process cancellation so `stop()` can terminate in-flight reviews safely.
- Add regression tests for non-MCP adapters with `reviewOptions`, invalid snapshot paths, persistence after completion, active-session eviction, shutdown cancellation, and duplicate `runSession()` calls.
- Rerun review: yes

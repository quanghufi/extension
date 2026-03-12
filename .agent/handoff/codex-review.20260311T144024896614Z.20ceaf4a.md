# Codex Review

## Overview
- Status: has_findings
- Summary: The wildcard CORS concern at `src/server.js:182` is withdrawn for this localhost-only server. Two material issues remain in `src/server.js`: one crash path in static file serving and one startup error-handler regression risk.
- Findings: 2

## Key Findings

### 1. [MEDIUM] `start()` removes every server `error` listener after bind succeeds
- Location: src/server.js:73
- Why it matters: `this._server?.removeAllListeners('error')` deletes more than the one temporary startup listener added at line 71. Any other `error` listener registered before or during startup is silently removed, and later server-level errors are left without the intended handler. That creates brittle behavior and makes future diagnostics or cleanup hooks disappear unexpectedly.
- Recommended fix: Store the startup error callback in a variable, register it with `once('error', onStartupError)`, and after `listen()` succeeds remove only that callback with `off('error', onStartupError)` if it is still present. Do not call `removeAllListeners('error')`. Add a test in `src/server.test.js` that attaches a separate `error` listener before `start()`, starts the server, and verifies that listener is still registered afterward.
- Confidence: medium

### 2. [MEDIUM] Static file reads can crash the process when the stream errors after the existence check
- Location: src/server.js:264
- Why it matters: `existsSync()`/`statSync()` only prove the file was readable at that instant. If the file is deleted, replaced, or becomes unreadable before `createReadStream()` opens it, the stream emits `error` with no listener and Node will treat that as an unhandled exception. A single bad UI asset request can take down the hub.
- Recommended fix: Wrap static-file delivery in error handling instead of piping a bare stream. Create the read stream, attach an `error` listener before piping, and translate `ENOENT` to `404` and other I/O failures to `500` if headers have not been sent yet. Prefer `stream.pipeline()` or an explicit `readStream.on('error', ...)`. Add a regression test in `src/server.test.js` that stubs `fs.createReadStream()` to emit an error after `_serveStatic()` starts and asserts the server responds gracefully instead of crashing.
- Confidence: high

## Recommendations
- Replace bare `fs.createReadStream(filePath).pipe(res)` with a read path that handles stream errors and maps them to HTTP responses.
- Change startup error cleanup to remove only the temporary listener created by `start()`.
- Extend `src/server.test.js` with regressions for static-file stream failures and preservation of non-startup server error listeners.
- Rerun review: yes

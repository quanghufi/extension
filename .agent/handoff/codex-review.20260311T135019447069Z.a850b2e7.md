# Codex Review

## Overview
- Status: has_findings
- Summary: Reviewed `src/api-routes.js` and the newly factored request/route dependencies it now relies on. The main issues are missing request/path validation, one stored-XSS path introduced by `label`, unsafe deletion semantics for running sessions, and weak error handling around request bodies.
- Findings: 8

## Key Findings

### 1. [HIGH] `snapshotPath` and review-target fields are accepted without any path boundary checks
- Location: src/api-routes.js:42
- Why it matters: `apiCreateSession` now accepts `snapshotPath` and arbitrary `reviewOptions`, and `runSession` uses those values to choose the workspace and forwarded `file_path`. A caller can point reviews at directories/files outside the intended repo or snapshot root, which turns this API into a local file access primitive.
- Recommended fix: Before constructing the `Session`, validate `projectDir`, `snapshotPath`, and `reviewOptions.file_path` against an allowlist rooted in the configured workspace/snapshot directories. Reject absolute paths or any resolved path that escapes those roots, and return `400` with a specific validation error. Add integration tests covering `..` traversal, absolute paths, and valid in-root paths.
- Confidence: high

### 2. [HIGH] User-controlled `label` creates a stored XSS path in the dashboard
- Location: src/api-routes.js:44
- Why it matters: This route now persists arbitrary `label` input. The dashboard later renders `session.label` through `innerHTML`, so a malicious label can execute script when another operator opens the session view. That is a stored XSS introduced by this new API surface.
- Recommended fix: Treat `label` as untrusted input. Either reject labels containing markup at the API boundary or, preferably, update the UI renderer to use `textContent`/DOM node creation instead of interpolating `session.label` into `innerHTML`. Add a regression test that posts a label containing HTML and verifies the rendered text is escaped.
- Confidence: high

### 3. [MEDIUM] The new create-session fields are not schema-validated before being forwarded deeper into execution
- Location: src/api-routes.js:38
- Why it matters: `agentId`, `reviewOptions`, `label`, and `snapshotPath` are accepted as-is. Bad types propagate into adapter execution where values like `max_findings`, `review_target`, or `file_path` are coerced later, which can produce surprising behavior or unbounded review requests instead of deterministic API errors.
- Recommended fix: Introduce explicit request validation for the POST body: require strings for `projectDir`/`prompt`/`snapshotPath`/`label`, restrict `agentId` to registered adapters, and validate `reviewOptions` against a strict schema including bounded integer checks for `max_findings`. Add negative tests for wrong types and out-of-range values.
- Confidence: high

### 4. [MEDIUM] `apiCreateSession` maps internal server failures to a misleading `400 Invalid request body`
- Location: src/api-routes.js:54
- Why it matters: The broad `catch` covers JSON parsing, `Session` construction, store writes, and response writing. If disk persistence fails or another internal error occurs, clients are told their request body was invalid, which hides operational failures and makes recovery/debugging much harder.
- Recommended fix: Split request parsing/validation from persistence and startup. Return `400` only for JSON/schema validation errors; log and return `500` for store/save/runtime failures. Add tests that simulate `server.store.save` throwing and assert a `500` response.
- Confidence: high

### 5. [MEDIUM] Deleting a running session does not stop the in-flight review
- Location: src/api-routes.js:81
- Why it matters: `apiDeleteSession` removes the session from memory and disk immediately, but any already-started `runSession` keeps running with its captured `session` object. That leaves orphaned work consuming resources and producing events for a session the API reports as deleted.
- Recommended fix: Do not hard-delete sessions that are still running. Either reject deletion with `409` until the session is terminal, or implement explicit cancellation of the adapter process and only remove the session after cancellation completes. Add an integration test that deletes a running session and verifies the review is actually stopped.
- Confidence: high

### 6. [MEDIUM] Invalid `after` query values silently return an empty event list
- Location: src/api-routes.js:99
- Why it matters: `parseInt` can produce `NaN`, and `(event.seq ?? -1) > NaN` is always false. A malformed `?after=` therefore looks like 'no events exist' instead of a client error or a sensible fallback, which breaks pagination/debugging behavior.
- Recommended fix: Validate `after` with `Number.isInteger` after parsing. If it is missing, use `-1`; if it is malformed or negative beyond the supported sentinel, return `400` with a clear error. Add tests for `?after=abc`, `?after=1.5`, and the happy path.
- Confidence: high

### 7. [MEDIUM] Request body reader has no size limit and no abort/error handling
- Location: src/http-utils.js:20
- Why it matters: All POST handlers now rely on `readBody`, which concatenates the entire request into memory and never rejects on `aborted`/`error`. A client can hold connections open or send a very large body, causing memory pressure and stuck requests.
- Recommended fix: Rework `readBody` to enforce a maximum byte size, decode explicitly as UTF-8, and reject on `req` `aborted`/`error` events. On limit overflow, destroy the request and return a `413`. Add unit tests for oversized bodies and aborted connections.
- Confidence: high

### 8. [LOW] Coverage does not exercise the new failure and security-sensitive branches in these routes
- Location: src/server.test.js:82
- Why it matters: Current tests cover the happy path for `snapshotPath` and basic session fetches, but they do not lock down the new branches for invalid `after` values, path rejection, label sanitization, or deletion of running sessions. Those gaps make the regressions above easy to reintroduce.
- Recommended fix: Extend integration coverage for the new API behavior: reject malformed POST payloads by field, reject unsafe paths, verify invalid `after` handling, ensure deleting a running session returns `409` or cancels correctly, and add an XSS regression test around `label`.
- Confidence: high

## Recommendations
- Add strict schema validation to `POST /api/sessions`, including adapter allowlisting, bounded `reviewOptions`, and path normalization checks against approved roots.
- Harden request body handling in `src/http-utils.js` with explicit UTF-8 decoding, size limits, and abort/error rejection paths.
- Change delete semantics so running sessions cannot be silently orphaned; either cancel them explicitly or reject deletion until terminal.
- Narrow error handling in `apiCreateSession` so only client parse/validation issues return `400`, while persistence/runtime failures return `500` and are logged.
- Add integration tests for invalid `after` values, unsafe paths, malicious labels, store-write failures, and deletion of active sessions.
- Rerun review: yes

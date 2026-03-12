# Codex Review

## Overview
- Status: has_findings
- Summary: Reviewed `src/api-routes.js` against the Phase 4 API/security focus. The main risks are unvalidated path input, a stored-XSS source introduced by the new `label` field, weak request validation, and missing negative-path coverage.
- Findings: 7

## Key Findings

### 1. [HIGH] `apiCreateSession` lets clients point reviews at arbitrary filesystem paths
- Location: src/api-routes.js:38
- Why it matters: The handler accepts `projectDir` and `snapshotPath` directly from the request and immediately schedules `runSession()`. That path is later handed to the adapter as the execution target. With the server advertising `Access-Control-Allow-Origin: *`, any site that can reach the local server can trigger reviews against arbitrary local directories or snapshots, which is a serious local-file exposure and command-surface issue.
- Recommended fix: Validate both fields before constructing the session: require strings, resolve them to canonical absolute paths, reject nonexistent paths, and enforce that they stay under an approved workspace/snapshot root configured by the server. Return `403` or `422` for out-of-bounds paths. Add server tests that POST `..`/external absolute paths and assert they are rejected.
- Confidence: high

### 2. [HIGH] New `label` input becomes a persistent XSS source for the dashboard
- Location: src/api-routes.js:44
- Why it matters: `label` is now accepted from the API and persisted verbatim. The dashboard later renders `session.label`, `session.projectDir`, finding text, and event text via `innerHTML`, so a crafted label like `<img onerror=...>` becomes stored script execution when the session page is opened. This is a direct Phase 4 viewer vulnerability.
- Recommended fix: Treat all request fields as plain text. Either reject HTML-bearing values at the API boundary or, preferably, update the UI to render with `textContent`/DOM node assembly instead of `innerHTML`. Add an integration test that creates a session with HTML in `label` and verifies the rendered DOM contains escaped text, not executable markup.
- Confidence: high

### 3. [MEDIUM] The catch-all turns internal failures into misleading `400 Invalid request body` responses
- Location: src/api-routes.js:35
- Why it matters: The `try/catch` around session creation covers parsing, validation, session construction, and persistence. If `server.store.save()` throws or another internal error happens, clients get a false `400` instead of a `500`, and the real operational failure is hidden. That makes regressions harder to diagnose and can mask partial-write bugs.
- Recommended fix: Narrow the `try/catch` so JSON parsing and validation failures return `400`, but persistence/runtime failures are logged and returned as `500`. Add a test that stubs `server.store.save` to throw and asserts the route returns `500` with an internal-error payload.
- Confidence: high

### 4. [MEDIUM] Both POST endpoints read request bodies without any size limit or abort/error handling
- Location: src/api-routes.js:36
- Why it matters: `apiCreateSession` relies on `readBody(req)`, which only resolves on `end`. A client can send an arbitrarily large body or abort mid-stream, causing unbounded memory growth or hanging requests. Because these are public POST routes, this is an easy denial-of-service vector.
- Recommended fix: Harden `readBody` and its callers: enforce a maximum payload size, reject on `aborted` and `error`, and return `413` for oversized bodies and `400` for truncated/invalid ones. Add tests that simulate an oversized body and an aborted request for `/api/sessions`.
- Confidence: high

### 5. [MEDIUM] The POST body is not schema-validated, so invalid types can break later flows
- Location: src/api-routes.js:37
- Why it matters: `JSON.parse(body || '{}')` is accepted as-is. Non-string `label`, `agentId`, `projectDir`, `snapshotPath`, or malformed `reviewOptions` are stored without checks. That can surface later as runtime failures, for example reruns call `this.label.replace(...)` and will throw if `label` is an array/object, or adapter lookup can fail on a non-string `agentId`.
- Recommended fix: Add explicit request validation before `new Session(...)`: require a plain object body, enforce string types for string fields, validate `reviewOptions` against a defined schema, and reject unknown/invalid shapes with `400`. Add tests for `label: []`, `agentId: {}`, and non-object JSON payloads such as `[]` or `"text"`.
- Confidence: high

### 6. [LOW] `after` query parsing silently drops all events for invalid values
- Location: src/api-routes.js:98
- Why it matters: `parseInt()` can return `NaN`. When that happens, `(event.seq ?? -1) > afterSeq` is always false, so `/events?after=abc` returns an empty list instead of either defaulting to `-1` or rejecting the query. In the UI this looks like missing event history, which is a correctness regression that's hard to distinguish from real data loss.
- Recommended fix: Validate `afterSeq` with `Number.isInteger`. If it is invalid, either return `400` with a clear error or coerce it to `-1`. Add a route test for `/api/sessions/:id/events?after=abc` covering the chosen behavior.
- Confidence: high

### 7. [LOW] The new API contract is under-tested on the server surface
- Location: src/server.test.js:82
- Why it matters: Current tests only cover the happy path for `snapshotPath`/`reviewOptions`. There is no server-level test for the new `lineage` field on `GET /api/sessions/:id`, no negative-path validation tests for malicious `label`/path input, and no regression test for invalid `after` values. That leaves the new Phase 4 behaviors largely unguarded.
- Recommended fix: Expand `src/server.test.js` with route tests for: `GET /api/sessions/:id` returning `lineage`, invalid `label`/`agentId`/`projectDir` types returning `400`, out-of-root `snapshotPath` rejection, and invalid `after` handling. Add at least one XSS regression test around label/session rendering or API sanitization.
- Confidence: high

## Recommendations
- Add strict request validation for `POST /api/sessions`, including canonical path checks and an explicit schema for `reviewOptions`.
- Harden request-body handling so oversized, aborted, and malformed requests fail fast with correct status codes.
- Split client-error and server-error handling in `apiCreateSession` so persistence/runtime failures return `500` and are logged.
- Close the stored-XSS path by rendering API data as text in the UI and adding an API/UI regression test for hostile `label` content.
- Extend server tests to cover `lineage`, invalid `after`, malicious path input, and invalid body types.
- Rerun review: yes

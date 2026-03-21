# Codex Review

## Overview
- Status: has_findings
- Summary: Reviewed `src/http-utils.js`. The file has several robustness and correctness gaps around request-body handling and response emission that can hang handlers, corrupt UTF-8 input, or crash when response state/data is unexpected.
- Findings: 7

## Key Findings

### 1. [HIGH] `readBody()` never rejects or settles on request stream errors/abort
- Location: src/http-utils.js:21
- Why it matters: The promise only resolves on `end`. If the client disconnects early or the socket emits `error`/`aborted`, every caller awaiting `readBody()` can hang indefinitely, tying up request handlers and creating an easy local DoS path.
- Recommended fix: Extend `readBody()` to reject on `req` `error` and `aborted`/premature `close` events, and ensure the promise settles exactly once. Remove listeners after resolve/reject so aborted requests do not leak handlers.
- Confidence: high

### 2. [HIGH] `readBody()` has no maximum body size
- Location: src/http-utils.js:22
- Why it matters: The function concatenates arbitrary input into a single string with no cap. Any caller that accepts POST data can be forced to allocate unbounded memory, which is a straightforward denial-of-service vector even on a localhost-only service.
- Recommended fix: Add a byte limit parameter or module constant, track received bytes from each chunk, and reject once the limit is exceeded. Call `req.destroy()` after the limit is hit so the process stops reading the oversized body; callers should translate that rejection into HTTP 413.
- Confidence: high

### 3. [MEDIUM] No direct tests cover the failure modes this utility is responsible for
- Location: src/http-utils.js
- Why it matters: This file is used by multiple HTTP route modules, but the current repository search did not show dedicated tests for `readBody()` or `jsonResponse()`. Without direct coverage, regressions in abort handling, oversize-body rejection, UTF-8 decoding, and double-send behavior are likely to slip through route-level happy-path tests.
- Recommended fix: Add focused tests for `readBody()` resolving normal UTF-8 bodies, rejecting on `error`/abort, and rejecting oversized payloads; add tests for `jsonResponse()` setting the correct content type/charset, handling already-sent responses safely, and handling serialization failures predictably.
- Confidence: medium

### 4. [MEDIUM] `jsonResponse()` can throw after headers/body were already sent
- Location: src/http-utils.js:10
- Why it matters: This helper unconditionally calls `setHeader()`, `writeHead()`, and `end()`. If a caller reaches it after another write path has already started the response, Node throws `ERR_HTTP_HEADERS_SENT` or writes after end, turning a recoverable route error into an uncaught failure/regression.
- Recommended fix: Guard the helper with `res.headersSent`/`res.writableEnded` checks. If the response is already committed, either no-op safely or only call `end()` when appropriate; do not call `setHeader()`/`writeHead()` once headers are sent.
- Confidence: medium

### 5. [MEDIUM] `jsonResponse()` does not handle serialization failures
- Location: src/http-utils.js:12
- Why it matters: `JSON.stringify(data)` throws for circular structures and `BigInt` values. Several route handlers call `jsonResponse()` outside their own protective `try` blocks, so one unexpected payload shape can bubble into a 500 or process-level unhandled exception instead of a controlled error response.
- Recommended fix: Serialize inside a `try/catch` in `jsonResponse()`. On failure, fall back to a minimal 500 JSON payload if the response is still writable, or rethrow only after attaching enough context for the caller to handle it explicitly.
- Confidence: medium

### 6. [MEDIUM] Per-chunk `toString()` can corrupt split UTF-8 sequences
- Location: src/http-utils.js:23
- Why it matters: The code decodes each chunk independently with `chunk.toString()`. Multi-byte UTF-8 characters split across chunk boundaries will be replaced or mangled, violating the stated UTF-8 invariant and potentially breaking JSON parsing for non-ASCII input.
- Recommended fix: Decode the stream with `req.setEncoding('utf8')` before reading, or use `StringDecoder('utf8')` to join chunk boundaries correctly. Keep the implementation explicitly UTF-8 so request parsing is deterministic.
- Confidence: high

### 7. [LOW] JSON responses omit an explicit UTF-8 charset
- Location: src/http-utils.js:10
- Why it matters: The file-level contract says UTF-8 is expected end-to-end, but the response header is only `application/json`. Most clients assume UTF-8 for JSON, yet making it explicit avoids ambiguity and keeps the helper aligned with the project invariant.
- Recommended fix: Change the header value to `application/json; charset=utf-8` and keep response serialization encoded as UTF-8 text.
- Confidence: high

## Recommendations
- Harden `readBody()` so it settles on all terminal stream states and cleans up listeners.
- Add explicit UTF-8 decoding plus a configurable maximum body size with rejection on overflow.
- Make `jsonResponse()` resilient to committed responses and `JSON.stringify()` failures.
- Add targeted unit tests for normal, aborted, oversized, UTF-8, and double-send scenarios.
- Rerun review: yes

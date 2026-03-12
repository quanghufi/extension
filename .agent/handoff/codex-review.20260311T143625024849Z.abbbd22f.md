# Codex Review

## Overview
- Status: has_findings
- Summary: Withdrew the `UI_DIR` fallback finding because the documented/runtime assumptions in this repo make that branch dead on supported deployments. Revised the static-stream concern to a concrete failure mode in `src/server.js`, and identified two higher-severity exposure issues in the same file.
- Findings: 3

## Key Findings

### 1. [HIGH] Server listens on all network interfaces despite exposing unauthenticated control endpoints
- Location: src/server.js:72
- Why it matters: `http.Server.listen(this.port)` binds to the unspecified address by default, so the REST and WebSocket APIs are reachable from the local network, not just `localhost`. Because this service has no authentication and can create/delete/rerun sessions, remote clients on the same LAN can drive reviews and read findings from the developer machine.
- Recommended fix: Add an explicit host option to `HubServer` and default it to a loopback address (`127.0.0.1` or `::1`). Pass that host into `server.listen`, include it in the startup log, and add a test asserting the default bind address is loopback unless the caller opts into external exposure.
- Confidence: high

### 2. [HIGH] Wildcard CORS lets any website issue and read localhost review requests
- Location: src/server.js:182
- Why it matters: The API unconditionally returns `Access-Control-Allow-Origin: *` and permits mutating methods. If a developer has the hub running and visits a malicious page, that page can create sessions against arbitrary local paths, poll results, and exfiltrate findings through the browser. Binding to localhost does not mitigate this browser-origin attack.
- Recommended fix: Replace the wildcard CORS policy with an allowlist. At minimum, only allow the dashboard origin(s) you control, or disable CORS entirely unless an explicit `Origin` is configured. Reject disallowed origins for both preflight and actual requests, and add tests covering allowed vs disallowed `Origin` headers on `GET`, `POST`, and `OPTIONS`.
- Confidence: high

### 3. [MEDIUM] Static handler can send `200 OK` for paths that exist but are not readable files
- Location: src/server.js:246
- Why it matters: `fs.existsSync(filePath)` accepts directories and symlink targets, and the code sends `200` before the stream is proven valid. Requesting an existing directory under `src/ui` (or a symlink that resolves to an unreadable/missing target) will fail in `createReadStream` after headers are sent, producing a broken response and noisy stream errors. This is a concrete server bug, not just a TOCTOU edge case.
- Recommended fix: Validate the target with `fs.statSync`/`fs.promises.stat` before sending headers and require `isFile() === true`. Then stream the file with `stream.pipeline` or an explicit `error` handler so read failures return `404`/`500` instead of leaving a partial `200` response. Add regression tests for requesting an existing directory and for a forced read-stream failure.
- Confidence: high

## Recommendations
- Bind the HTTP/WebSocket server to loopback by default, with an explicit opt-in host setting for non-local access.
- Tighten CORS so only trusted origins can call the API, and cover both preflight and actual requests in tests.
- Harden `_serveStatic` to serve only regular files and handle stream failures before/while piping, with regression tests for directory and read-error cases.
- Rerun review: yes

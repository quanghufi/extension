# Codex Review

## Overview
- Status: has_findings
- Summary: Withdrew the previously rebutted static-file stream concern after re-review. Two material issues remain in `src/server.js`.
- Findings: 2

## Key Findings

### 1. [MEDIUM] Binding only to 127.0.0.1 breaks clients that resolve localhost to ::1
- Location: src/server.js:73
- Why it matters: `start()` now listens exclusively on IPv4, but the server advertises `http://localhost:...` and the test helper also connects via `localhost`. On machines where `localhost` resolves to IPv6 first, requests will fail with connection refusal even though the server started successfully.
- Recommended fix: Stop forcing the host to `127.0.0.1`. Either omit the host argument so Node binds normally, or bind in a way that accepts both IPv4 and IPv6 loopback. Add an integration test that starts `HubServer` and verifies an HTTP request to `http://localhost:<port>/api/sessions` succeeds.
- Confidence: high

### 2. [MEDIUM] Unvalidated reviewOptions can silently override the session prompt for MCP runs
- Location: src/server.js:138
- Why it matters: `runSession()` builds the MCP payload with `{ prompt: session.prompt, ...session.reviewOptions }`. If the request body includes `reviewOptions.prompt`, that later spread replaces the canonical session prompt, so the stored session says one thing while the adapter executes another. That makes reruns and audit trails unreliable and lets callers inject unexpected adapter inputs through an unvalidated object.
- Recommended fix: Do not spread `session.reviewOptions` directly into the adapter payload. Build a whitelist object with only the supported keys (`review_target`, `file_path`, `max_findings`) and always set `prompt` from `session.prompt`. Add a test that creates a session with a conflicting `reviewOptions.prompt` and asserts the adapter receives the top-level prompt, not the nested override.
- Confidence: high

## Recommendations
- Remove the hard-coded IPv4 listen host and verify `localhost` connectivity with an integration test.
- Whitelist MCP review option fields when constructing `promptArg` so nested input cannot override `session.prompt`.
- Add regression coverage for both cases before rerunning review.
- Rerun review: yes

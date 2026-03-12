# Codex Review

## Overview
- Status: has_findings
- Summary: Found 4 material issues in scripts/codex-smoke.js that can produce false passes, mutate the live workspace, or make the smoke test flaky.
- Findings: 4

## Key Findings

### 1. [HIGH] The smoke test runs Codex against the caller's current working directory instead of an isolated snapshot
- Location: scripts/codex-smoke.js:24
- Why it matters: This script invokes the real Codex CLI. Pointing it at `process.cwd()` means a misconfigured adapter, prompt regression, or accidental tool use can read or modify the live repository rather than a disposable copy. That contradicts the repo's stated snapshot isolation goal and makes the smoke test unsafe to run from a dirty workspace.
- Recommended fix: Create a temporary directory for the smoke run, copy only the minimal fixture files needed into it, and pass that temp path to `adapter.execute()`. If the test must target this repo, resolve the repo root explicitly and create a read-only snapshot first instead of using the live working tree.
- Confidence: high

### 2. [HIGH] Smoke test can pass even when Codex does not return the required final JSON `[]`
- Location: scripts/codex-smoke.js:51
- Why it matters: The script only asserts `result.findings.length === 0`. `parseCodexExecResult()` also returns an empty array when the final agent message is missing, malformed, or not JSON, so a broken adapter/parser can still produce a green smoke test.
- Recommended fix: Capture and inspect the streamed `agent_message` payloads during the run, then assert that the last agent message is exactly `[]` after trimming whitespace. Fail if no agent message was seen, if JSON parsing fails, or if the parsed value is not an empty array.
- Confidence: high

### 3. [MEDIUM] Timeouts are much stricter than the project's Codex contract, so the smoke test is likely to be flaky
- Location: scripts/codex-smoke.js:17
- Why it matters: The script hard-codes `20s/15s/60s`, while the project guidance says Codex should use `45s/20s/90s`. Real Codex runs regularly exceed these shorter limits on cold start, auth refresh, or transient network delay, so this test can fail even when the adapter is healthy.
- Recommended fix: Align the smoke test defaults with the documented Codex thresholds (`45_000`, `20_000`, `90_000`) and optionally allow overrides via environment variables for slower CI or local debugging.
- Confidence: high

### 4. [MEDIUM] Using `process.cwd()` makes the test validate whichever directory the user launched from, not this repository
- Location: scripts/codex-smoke.js:24
- Why it matters: `npm run smoke:codex` from the repo root works today, but direct invocation from another directory, a workspace runner, or a parent script will silently test the wrong path. That creates hard-to-diagnose failures and makes the smoke result non-reproducible.
- Recommended fix: Resolve the intended workspace path from the script location, for example by deriving the repository root from `import.meta.url`, or require an explicit `--workspace` argument and reject relative/unknown locations.
- Confidence: high

## Recommendations
- Make the smoke assertion validate the final streamed agent message is exactly `[]`, not just that parsed findings are empty.
- Run the smoke test in a disposable snapshot/temp directory instead of `process.cwd()`.
- Resolve the workspace path deterministically from the script or require it as an explicit argument.
- Update the smoke timeouts to match the documented Codex defaults and allow overrides for slower environments.
- Rerun review: yes

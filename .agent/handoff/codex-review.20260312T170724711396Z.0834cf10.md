# Codex Review

## Overview
- Status: has_findings
- Summary: Reviewed `scripts/codex-smoke.js`. The main risks are a new false-negative success criterion tied to streamed `agent_message` events and timeout values that are significantly stricter than the project’s documented Codex thresholds, making the smoke test flaky and less representative.
- Findings: 3

## Key Findings

### 1. [HIGH] Smoke test can fail even when the adapter successfully parses the final `[]` result
- Location: scripts/codex-smoke.js:40
- Why it matters: The new `sawAgentMessage` gate treats a streamed `status=agent_message` event as mandatory success evidence, but that event is derived from incremental chunk parsing. `parseChunk()` operates on arbitrary stream chunks, so a JSONL line split across chunk boundaries or any Codex protocol change that still leaves the final accumulated output parseable will make `result.status === 'ok'` and `findings.length === 0`, yet this script still exits 1. That creates a false-negative smoke test and will block CI on benign stream-shape changes.
- Recommended fix: Remove the hard failure on `!sawAgentMessage`, or downgrade it to diagnostic logging only. If you want to assert final-answer presence, validate it from the adapter result or from the fully accumulated output instead of relying on incremental `agent_message` events. Add a regression case where the final `[]` is parseable but no streamed `agent_message` event is emitted.
- Confidence: high

### 2. [MEDIUM] Timeouts are tighter than the project’s documented Codex smoke thresholds and will make this test flaky
- Location: scripts/codex-smoke.js:22
- Why it matters: This script hard-codes `20s/15s/60s`, while the repo guidance for Codex is `45s/20s/90s`. Real Codex runs can spend noticeable time on cold start, auth initialization, or transient stalls before first output. A smoke test should validate the supported production envelope, not a much narrower one, otherwise it will fail intermittently on slower machines or under load and produce misleading evidence.
- Recommended fix: Align the smoke-test adapter timeouts with the documented Codex thresholds used by the project (`firstByteMs: 45_000`, `idleMs: 20_000`, `hardMs: 90_000`) or import the canonical values from a shared config so the smoke test cannot silently drift from the supported configuration.
- Confidence: high

### 3. [MEDIUM] Hard-coding `snapshotPath` to the repository root stops exercising the caller-supplied execution path behavior
- Location: scripts/codex-smoke.js:29
- Why it matters: Changing from `process.cwd()` to `repoRoot` makes the script less representative of how the adapter is consumed elsewhere, where the execution path is supplied by the caller and may be a prepared snapshot directory. This weakens the smoke test: it no longer catches bugs that only appear when the script is launched from another working directory or when the review target is an external snapshot path.
- Recommended fix: Keep `repoRoot` as the default, but allow an explicit target path override (for example via `process.argv[2]` or an env var) and log both the current working directory and the effective snapshot path. Add a regression test that invokes the script from a non-root working directory and confirms it still targets the intended path.
- Confidence: medium

## Recommendations
- Relax or remove the `sawAgentMessage` hard failure so success is determined from the final parsed result rather than a specific streamed event shape.
- Replace the smoke-test timeout literals with the project’s canonical Codex timeout values, ideally sourced from shared configuration.
- Make the target review path configurable so the script can still default to the repo root while exercising non-root invocation and snapshot-path scenarios in tests.
- Rerun review: yes

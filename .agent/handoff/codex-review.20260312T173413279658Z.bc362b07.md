# Codex Review

## Overview
- Status: has_findings
- Summary: Re-review of scripts/codex-smoke.js found 4 material issues: the smoke test still runs Codex against the live repo, does not fail if Codex executes shell commands, ignores adapter error events from streaming parse failures, and lacks focused regression coverage for these behaviors.
- Findings: 4

## Key Findings

### 1. [HIGH] Smoke test runs the real agent against the live workspace instead of an immutable snapshot
- Location: scripts/codex-smoke.js:29
- Why it matters: This script hands the real repository root to Codex. If the model ignores the prompt, follows prompt-injected repo content, or regresses into tool use, it can modify or inspect the developer's working tree during a smoke test. That is a real regression/security risk and contradicts the repo's own immutable-snapshot decision.
- Recommended fix: Replace `snapshotPath = repoRoot` with a temporary snapshot directory created from the repo contents, and run the adapter against that snapshot. Make the snapshot read-only where possible, or at minimum isolate it under a temp dir and delete it after the run. Fail the test if snapshot creation/isolation cannot be established.
- Confidence: high

### 2. [HIGH] The test never fails if Codex executes shell commands despite the prompt explicitly forbidding them
- Location: scripts/codex-smoke.js:43
- Why it matters: `parseCodexExecChunk()` emits `command_started` and `command_completed` status events, but this loop ignores them. A misbehaving or prompt-injected Codex run can execute commands and still end with `[]`, causing the smoke test to report PASS even though the safety contract was violated.
- Recommended fix: Track `status` events whose `payload.state` is `command_started` or `command_completed`. Record the command text, and after the stream ends, fail the smoke test with the captured command(s) if any command-execution event was seen.
- Confidence: high

### 3. [MEDIUM] Streaming parse failures are silently ignored by the smoke script
- Location: scripts/codex-smoke.js:43
- Why it matters: The adapter emits `error` events when `parseChunk()` or `parseResult()` throws. This script ignores those events and only checks `result.status` plus the final message. That means the smoke test can pass while JSONL streaming is already broken, which defeats the stated goal of verifying streaming parsing behavior.
- Recommended fix: While consuming `stream`, collect any `event.event_type === 'error'` events. After the loop, fail immediately if any were seen, and include the error message(s) in stderr so the regression is visible.
- Confidence: high

### 4. [LOW] No focused regression test covers the new strict validation paths in the smoke script
- Location: scripts/codex-smoke.js
- Why it matters: Round 3 changed the acceptance logic around agent-message text typing, JSON parse hard failure, and requiring an empty array. Without unit coverage, a later refactor can reintroduce false positives or false negatives and the only signal will be a flaky/manual smoke run.
- Recommended fix: Add automated tests for the smoke-script decision logic by stubbing `adapter.execute()`. Cover at least: non-string `payload.text` must not satisfy the check, malformed JSON in the last agent message must fail, non-empty arrays must fail, command-execution events must fail, and stream `error` events must fail.
- Confidence: medium

## Recommendations
- Run the smoke test against an isolated temporary snapshot instead of `repoRoot`.
- Fail the run if any `command_started` or `command_completed` event is observed.
- Fail the run if any adapter `error` event is emitted while consuming the stream.
- Add regression tests around the strict validation branches introduced in Round 3.
- Rerun review: yes

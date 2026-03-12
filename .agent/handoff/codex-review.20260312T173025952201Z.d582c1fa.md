# Codex Review

## Overview
- Status: has_findings
- Summary: Re-review found 3 material issues left in scripts/codex-smoke.js. The new agent_message check still does not guarantee the smoke test actually verified a final `[]` payload, so the script can report PASS on malformed or non-JSON final output.
- Findings: 3

## Key Findings

### 1. [HIGH] Non-JSON last agent_message still only warns, so the smoke test can pass without verifying the final payload
- Location: scripts/codex-smoke.js:71
- Why it matters: The stated purpose of this smoke test is to prove Codex returned a structured final `[]`. If the last agent_message is prose or malformed JSON, the current code only emits a warning and still allows PASS as long as `result.findings.length === 0`. That masks exactly the regression this script is supposed to catch.
- Recommended fix: Change the `catch` around `JSON.parse(lastAgentMessageText)` to a hard failure: log a FAIL message and exit 1. The script should only pass when the final agent_message parses successfully as JSON.
- Confidence: high

### 2. [HIGH] The script accepts any JSON array, not specifically the required empty array `[]`
- Location: scripts/codex-smoke.js:74
- Why it matters: `Array.isArray(parsed)` is too weak. Responses like `[{}]`, `["ok"]`, or `[1]` satisfy this check, and `result.findings.length` can still be zero after normalization/filtering. That means the smoke test can PASS even when Codex did not follow the prompt `Return exactly []`.
- Recommended fix: After parsing, require `Array.isArray(parsed)` and `parsed.length === 0`. If either condition fails, print a FAIL message and exit 1. Do not rely on `result.findings.length === 0` as a proxy for exact `[]` compliance.
- Confidence: high

### 3. [MEDIUM] An agent_message event with a missing or non-string text payload bypasses validation entirely
- Location: scripts/codex-smoke.js:45
- Why it matters: `sawAgentMessage` becomes true before validating `payload.text`. If the event exists but `payload.text` is absent or not a string, `lastAgentMessageText` stays `undefined` and the JSON validation block is skipped. The script can then PASS without ever inspecting the final message body.
- Recommended fix: Only treat the event as satisfying the smoke-test requirement when `event.payload.text` is a string. Otherwise fail explicitly after the stream completes with a message like `agent_message text missing or not a string`. Update the condition so `sawAgentMessage` and `lastAgentMessageText` are set together from a validated string payload.
- Confidence: high

## Recommendations
- Make final payload parsing mandatory: if the last `agent_message` text is missing, non-string, or invalid JSON, exit with failure.
- Tighten the payload check to require an empty JSON array specifically (`[]`), not merely any array.
- Add regression tests for three cases: prose/non-JSON final message, non-empty JSON array like `[{}]`, and `agent_message` events with missing/non-string `text`.
- Rerun review: yes

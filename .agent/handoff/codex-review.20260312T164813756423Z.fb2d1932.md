# Codex Review

## Overview
- Status: has_findings
- Summary: Re-review found one functional regression in the new assertion and one remaining coverage gap that still lets the smoke test pass without proving the final `[]` contract.
- Findings: 2

## Key Findings

### 1. [HIGH] `sawAgentMessage` check looks at the wrong field, so successful runs are reported as failures
- Location: scripts/codex-smoke.js:43
- Why it matters: The parser maps Codex agent messages to `event_type: 'status'` with `payload.state: 'agent_message'`, not to `event_type: 'agent_message'`. As written, the new assertion never becomes true on a normal success path, so this smoke test will fail even when the adapter is working.
- Recommended fix: Change the loop to detect the parsed agent-message status event shape the adapter actually emits, for example by checking `event.event_type === 'status' && event.payload?.state === 'agent_message'`. Then add/update a test fixture that feeds a real `item.completed` / `agent_message` JSONL chunk through the script logic and proves the flag becomes true.
- Confidence: high

### 2. [MEDIUM] The smoke test still does not verify that the final agent message content is exactly `[]`
- Location: scripts/codex-smoke.js:60
- Why it matters: `result.findings.length === 0` only proves the parser produced no findings. It also stays zero when Codex returns a non-JSON or otherwise unparsable final message, so the smoke test can pass without catching a regression in the structured-output contract it claims to validate.
- Recommended fix: Capture the text from the final `agent_message` event and assert that its trimmed content is exactly `[]` (or, at minimum, parse it as JSON and assert it is an empty array). Add a regression test covering a plain-English final agent message to ensure the smoke test fails in that case.
- Confidence: high

## Recommendations
- Update `scripts/codex-smoke.js` to detect agent messages using the actual event schema (`event_type: 'status'`, `payload.state: 'agent_message'`).
- Store the final agent-message text during stream consumption and assert it is exactly an empty JSON array.
- Add regression coverage for both cases: a valid `agent_message` JSONL event and an invalid/non-JSON final message that must fail the smoke test.
- Rerun review: yes

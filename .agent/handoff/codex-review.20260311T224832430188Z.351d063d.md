# Codex Review

## Overview
- Status: has_findings
- Summary: Two rebutted findings still hold after re-review. I am withdrawing the legacy-hydration concern at line 243 and the watchdog/displayState mismatch at line 211 as not material in this codebase.
- Findings: 2

## Key Findings

### 1. [MEDIUM] Reconciliation overwrites unfinished agents with the session-wide finding total
- Location: src/hub/session.js:178
- Why it matters: This is still a correctness bug in the current code, not just a hypothetical multi-agent future. The module already tracks multiple agent IDs across findings and tests them (`semgrep`, `eslint`, `codex`), and `_reconcileAgentStates()` runs for every terminal session, including `fromJSON()`. Any agent that never emitted a final `done` status is assigned `this.allFindings.length`, which attributes every session finding to that one agent and corrupts persisted per-agent metadata.
- Recommended fix: Do not synthesize `findingCount` from `this.allFindings.length` for unfinished agents. Either leave the existing count unchanged, or recompute a per-agent count from the session data (for example by counting findings mapped to that `agentId` via `buildFindingAgentMap`). Add a regression test with at least two agents where one agent finishes and another remains running when the session finalizes; assert the unfinished agent does not inherit the global finding total.
- Confidence: high

### 2. [LOW] Reconciled agent status stores session-level values outside the documented agent status contract
- Location: src/hub/session.js:177
- Why it matters: `_updateAgentState()` only records adapter outcome statuses like `ok`, `failed`, and `timeout`, and `AgentRegistry` documents the same contract. `_reconcileAgentStates()` instead writes `partial_completion` and `cancelled` into `agent.status`. That makes serialized agent records inconsistent depending on whether they were closed by an agent event or by reconciliation, which is a regression risk for consumers during the planned TypeScript migration.
- Recommended fix: Keep `agent.state` as the lifecycle source of truth and normalize `agent.status` to the documented agent outcome vocabulary. If you need to preserve session-level terminal reasons such as `partial_completion`, store them on a separate field or extend/document the `AgentState.status` contract everywhere and add tests covering reconciled terminal sessions.
- Confidence: medium

## Recommendations
- Remove the session-wide `allFindings.length` fallback from `_reconcileAgentStates()` and preserve or recompute counts per agent.
- Normalize reconciled `agent.status` values so they match the declared agent status contract, or formally widen that contract in `AgentRegistry` and its tests.
- Add regression tests for terminal reconciliation of partially finished multi-agent sessions and for JSON round-trips of reconciled agent metadata.
- Rerun review: yes

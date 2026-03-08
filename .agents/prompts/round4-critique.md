# Codex Round 4 Critique — Phase 1 Implementation Plan v2

## Context

You are reviewing an implementation plan (v2) for the Extension project — a multi-agent code review hub. Phase 0 spike is complete (all gate tests passed, evidence in `docs/spike-results-v3.json`). This plan covers Phase 1: the Event-Driven Hub build.

This is Round 4 critique. Rounds 1-3 are in `.feedback/` (inbox.md, inbox-v2.md, inbox-v3.md). Previous critiques identified 24 findings across 3 rounds, ALL accepted and incorporated into v2.

## Your Task

Critique `implementation_plan.md` (copied below) for correctness, completeness, and risks. Focus on:

1. **Architecture gaps** — Missing components, unclear boundaries, race conditions
2. **Windows-specific land mines** — Codex outputs to stderr, process tree kill, path handling
3. **Streaming correctness** — AsyncIterable lifecycle, backpressure, error propagation through streams
4. **Testing blind spots** — What unit tests won't catch? What integration tests are missing?
5. **MVP gate coverage** — Does the verification plan actually prove all 8 MVP gate items from BRIEF section 9?
6. **Implementation order** — Dependencies between components, what blocks what?
7. **Scope creep risk** — Is anything in here that should be Phase 2?

## Important Rules

- Read the ENTIRE plan before commenting
- Read `docs/BRIEF.md` for project requirements context
- Read `.feedback/inbox-v3.md` and `.feedback/responses-v3.md` to see what was already addressed in Round 3
- **Do NOT re-raise findings that were already fixed** (check Changes from v1 table at bottom)
- Number each finding with a sequential ID (e.g., R4-01, R4-02, ...)
- For each finding, specify: severity (critical/major/minor/nit), affected component, and concrete recommendation
- If you find NO issues, say so explicitly

## Output Format

```markdown
# Codex Round 4 Critique

**Date:** YYYY-MM-DD
**Reviewer:** Codex (gpt-5.4, xhigh reasoning)
**Artifact reviewed:** implementation_plan.md v2
**Previous rounds incorporated:** R1 (6/6), R2 (8/8), R3 (10/10)

## Summary

[1-2 sentence overview]

## Findings

### R4-01: [Title]
- **Severity:** critical | major | minor | nit
- **Component:** [affected area]
- **Issue:** [what's wrong]
- **Evidence:** [where in the plan]
- **Recommendation:** [concrete fix]

[...repeat for each finding...]

## Verdict

- [ ] PASS — ready for implementation
- [ ] CONDITIONAL PASS — implement with noted changes
- [ ] NEEDS REVISION — address critical/major findings first
```

---

## Implementation Plan v2 (Full Text Below)

<implementation_plan>
# Phase 1: Event-Driven Hub — Implementation Plan (v2)

Phase 0 Spike is ✅ complete — all patterns proven (`spike-results-v3.json`). This plan covers the Phase 1 Core Hub build: Agent Adapters, Hub/Session Manager, Review Snapshot, Finding Schema, and a simple browser UI.

> **v2 changes:** Incorporates all 10 findings from Codex Round 3 critique. Major changes: streaming adapter API, path normalization, hub-assigned seq, read-only snapshot enforcement, error propagation, WS backpressure, Windows cancellation, configurable timeouts, MVP scope alignment.

## User Review Required

> **JavaScript or TypeScript?** AGENTS.md says "JavaScript (migrating to TypeScript in Phase 1)". This plan uses **JavaScript with JSDoc types** for iteration speed. TypeScript migration can happen in Phase 2.

> **Framework choice**: This plan uses vanilla Node.js HTTP + `ws` WebSocket. No Express needed at this scale. Should this change?

> **Codex and Claude CLI must be globally installed** on the machine for integration tests to pass. Unit tests use mocked spawns and do NOT require CLIs.

> **MVP scope resolved per BRIEF section 9.** The following are ALL required for Phase 1 MVP pass:
> - Cancel review mid-way → cleanup sạch
> - Retry failed review → restart clean  
> - Dedup findings (no duplicates shown)
> - Session history (save + load)
> - >100KB streaming (no crash, no truncate)
> - Read-only snapshot enforcement (technical, not policy)
> - Vietnamese UTF-8 full pipeline

---

## State Machines

### Session Lifecycle

```
States: pending → snapshotting → running → collecting → completed | partial_completion | failed | cancelled
          running → cancelling → cancelled

Inside running:
  adapters_launched → receiving_events → adapters_done
```

**Error propagation policy:**

| Error source | Session result | Behavior |
|---|---|---|
| Infrastructure (snapshot/storage/server) | `failed` | Session stops, no partial results |
| All adapters fail | `failed` | No findings available |
| Some adapters fail, some succeed | `partial_completion` | Preserve partial findings, per-adapter status |
| Adapter timeout | Adapter `failed` | Other adapter continues, partial findings preserved |

**Guards & side-effects:**

| Transition | Guard | Side-effect |
|---|---|---|
| `pending → snapshotting` | session exists | `snapshotManager.create()` |
| `snapshotting → running` | snapshot path valid, snapshot read-only verified | launch adapters in parallel |
| `running.onEvent()` | valid event envelope | hub stamps `seq`, deduplicate finding, broadcast via WS |
| `running → collecting` | all adapters exited successfully | stop heartbeat timer |
| `running → partial_completion` | some adapters failed, some succeeded | preserve partial findings |
| `collecting → completed` | — | persist session JSON (atomic rename), cleanup snapshot |
| `* → failed` | infra error caught | persist error (atomic rename), cleanup snapshot |
| `running → cancelling` | session is running | `child.kill()` → 5s → `taskkill /T /F /PID` |

---

### Adapter Execution (Streaming)

Each adapter returns a **streaming** `AsyncIterable<Event>` — not a batch result. The hub consumes events incrementally and broadcasts them to WebSocket clients as they arrive.

```
States: resolving → spawning → waiting_first_byte → receiving → parsing → done | error
         waiting_first_byte → timeout_kill → error
         receiving → timeout_kill → error
```

**Adapter return type (streaming):**

```javascript
/**
 * @returns {{ stream: AsyncIterable<Event>, done: Promise<AdapterResult> }}
 */
async function execute(prompt, opts) { ... }

// AdapterResult = { status: 'ok'|'failed'|'timeout', findings: Finding[], timingMs: TimingTelemetry }
// TimingTelemetry = { firstByteMs: number, lastIdleGapMs: number, totalMs: number }
```

**Timeout tiers (configurable, defaults from spike v3):**

| Tier | Codex default | Claude default | Purpose |
|---|---|---|---|
| `firstByte` | 45s | 90s | Detect CLI not responding at all |
| `idle` | 20s | 30s | Detect hung process mid-output |
| `hard` | 90s | 120s | Absolute max wall-clock time |

---

### WebSocket Client (Browser UI)

```
States: disconnected → connecting → connected → disconnected (retry 3s)
Inside connected: idle → streaming → idle
```

---

### Data Flow Overview

```
Browser UI → POST /api/sessions → Server → Hub/Session Manager
                                         → Snapshot Manager (create snapshot)
                                         → Codex Adapter (execute → stream)
                                         → Claude Adapter (execute → stream)
                                         ← AsyncIterable events
Hub stamps seq, dedup → Session Store (.json, atomic rename)
                      → WebSocket broadcast (session-scoped)
```

---

## Proposed Changes

### Pre-requisites: Package Setup

#### [MODIFY] package.json

```json
{
  "name": "extension-hub",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "start": "node src/server.js",
    "test": "node --test src/**/*.test.js",
    "test:unit": "node --test src/**/*.test.js",
    "spike": "node scripts/spike-test-v3.js"
  },
  "dependencies": {
    "cross-spawn": "^7.0.6",
    "ws": "^8.18.0",
    "uuid": "^9.0.0"
  },
  "devDependencies": {}
}
```

Uses Node.js 20 built-in test runner (`node --test`) — no Jest/Vitest dependency needed.

---

### Component 1: Agent Adapter Layer

Extracts the proven `runAgent()` pattern from `spike-test-v3.js` into a reusable adapter that **streams** structured events via `AsyncIterable`.

#### [NEW] src/adapters/base-adapter.js

Base class for all agent adapters. Core responsibilities:
- Wraps `cross-spawn` with 3-tier timeout (from spike v3)
- Returns `{ stream: AsyncIterable<Event>, done: Promise<AdapterResult> }`
- Events yielded as they arrive — hub consumes incrementally
- Captures stdout/stderr separately, decodes explicit UTF-8
- Detects garbled output (replacement chars `\ufffd`) — logs warning, skips relay
- Provides `combinedBytes` for pass/fail (not just stdoutBytes)
- **Configurable timeouts** via constructor `opts.timeouts = { firstByte, idle, hard }`
- Logs **timing telemetry**: `{ firstByteMs, lastIdleGapMs, totalMs }`

Key methods:
- `execute(prompt, opts)` → `{ stream: AsyncIterable<Event>, done: Promise<AdapterResult> }`
- `parseOutput(rawResult)` → extract findings from raw text (override per agent)
- `#spawnWithTimeout(file, args, timeouts)` → private, reuses spike v3's `runAgent()`

#### [NEW] src/adapters/codex-adapter.js

Codex-specific adapter:
- Resolves `codex` shim path (reuses `resolveShim()` from spike v3)
- Command: `codex review "<prompt>"`
- Default timeouts: `firstByte=45s, idle=20s, hard=90s` (overridable)
- Output parsing: Codex outputs to **stderr** — parse combinedOutput
- Finding extraction: regex-based extraction of severity/file/line patterns
- **Path normalization** applied to all finding paths before yielding

#### [NEW] src/adapters/claude-adapter.js

Claude Code CLI adapter:
- Resolves `claude` shim path
- Command: `claude -p --no-session-persistence "<prompt>"`
- Supports `--output-format json` for structured output
- Default timeouts: `firstByte=90s, idle=30s, hard=120s` (overridable)
- Finding extraction: parse structured JSON output when available, fallback to text parsing
- **Path normalization** applied to all finding paths before yielding

#### [NEW] src/adapters/base-adapter.test.js

Unit tests (no CLI required — mock spawn):
- Streaming: events arrive via `for await` as mock process emits data
- Event emission format validation
- 3-tier timeout behavior (firstByte, idle, hard)
- UTF-8 garble detection
- combinedBytes calculation
- Error handling (spawn failure, signal)
- Timing telemetry logged correctly
- Slow-output fixtures (simulate >100KB output)
- Large-output fixtures (no truncation, no OOM)

---

### Component 2: Path Normalization Utility

#### [NEW] src/utils/normalize-path.js

Central path normalization applied BEFORE hashing or storage:

```javascript
function normalizeFindingPath(rawPath, snapshotRoot) {
  // 1. path.resolve(snapshotRoot, rawPath) — resolve relative paths
  // 2. Reject traversal — if resolved path is outside snapshotRoot, throw
  // 3. Convert to forward slashes: path.sep → '/'
  // 4. Lowercase on Windows (case-insensitive filesystem)
  // 5. Strip leading './' 
  // 6. Return relative path from snapshotRoot
}
```

#### [NEW] src/utils/normalize-path.test.js

Tests:
- `src\server.js` and `src/server.js` normalize to same string
- `./src/server.js` and `src/server.js` normalize to same string
- `SRC/Server.js` normalizes to `src/server.js` on Windows
- Path traversal (`../../../etc/passwd`) throws error
- Absolute paths outside snapshot root throw error

---

### Component 3: Event Schema & Finding Model

#### [NEW] src/schema/events.js

Event factory functions:

```javascript
// Creates event envelope — NO seq field (hub assigns it)
function createEvent(sessionId, agentId, eventType, payload) { ... }

// Creates finding with auto-generated dedupe_key
// dedupe_key: hash(normalizedFile + line + normalizedSummary)
// NOTE: severity is NOT in the dedupe fingerprint
function createFinding({ severity, summary, evidence, file, line, confidence }) { ... }

// Dedupe key: hash(normalizedFile + line + normalizedSummary)
function computeDedupeKey(finding) { ... }
```

> **Dedupe strategy:**
> - `severity` is NOT in the dedupe fingerprint
> - `summary` is normalized (lowercase, strip punctuation) before hashing
> - Raw per-agent findings are ALWAYS stored
> - Phase 1: dedup flags duplicates, shows both with "duplicate" indicator

#### [NEW] src/schema/events.test.js

---

### Component 4: Review Snapshot Manager

#### [NEW] src/snapshot/snapshot-manager.js

Creates **immutable** (read-only enforced) review snapshots:
- `createSnapshot(workspacePath)` → `{ snapshotId, commitHash, snapshotPath }`
- Uses `git worktree add --detach` for review copy
- Fallback: if worktree fails, use `robocopy /MIR` to temp directory
- **After copy, enforce read-only:** `attrib +R /S /D <snapshotPath>`
- `cleanupSnapshot(snapshotId)` → remove `attrib +R`, then remove worktree/temp copy
- All findings tagged with `commit_hash` + `snapshot_id`

> **Read-only enforcement is technical, not policy.** After copy, run `attrib +R /S /D`. Integration test verifies child processes get `EPERM` when attempting writes.

#### [NEW] src/snapshot/snapshot-manager.test.js

Tests (uses temp git repos):
- Snapshot creates a directory with correct commit hash
- **Snapshot is read-only:** child process attempting write gets `EPERM`
- Cleanup removes read-only attribute, then removes directory
- Commit hash matches current HEAD

---

### Component 5: Hub / Session Manager

#### [NEW] src/hub/session.js

Session lifecycle:
- `createSession(opts)` → `{ sessionId, status: 'pending' }`
- `startSession(sessionId)` → creates snapshot, launches adapters in parallel, consumes streams
- `onEvent(sessionId, event)` → **hub stamps monotonic `seq`**, routes events, deduplicates findings
- `cancelSession(sessionId)` → `child.kill()` → 5s → `taskkill /T /F /PID`
- `retrySession(sessionId)` → re-creates snapshot, re-launches adapters
- `endSession(sessionId)` → collects all findings, cleanup snapshot

**Event ordering:**
- Adapters emit events WITHOUT `seq`
- Hub assigns session-global monotonic `seq` on receipt
- All events go through single serial queue (async promise chain)
- Guarantees total ordering across both adapters

**Finding storage:**
- Raw per-agent findings are ALWAYS stored
- Dedup flags duplicates with `isDuplicate: true` marker
- Final result includes per-adapter status

#### [NEW] src/hub/session-store.js

File-based persistence with **atomic writes**:
- `save(session)` → write JSON to temp file, then `fs.rename()` to `.extension/sessions/<id>.json`
- `load(sessionId)` → read from disk
- `list()` → all session summaries
- Atomic temp-file-plus-rename prevents corruption on crash

#### [NEW] src/hub/session.test.js

Tests (mock adapters):
- Session lifecycle transitions (happy path)
- `partial_completion` state test
- Finding dedup
- Hub-assigned `seq` monotonically increasing
- Session persistence roundtrip
- Cancel mid-session cleanup
- Retry after failure
- Per-adapter status object

---

### Component 6: HTTP + WebSocket Server

#### [NEW] src/server.js

Vanilla Node.js HTTP + `ws` WebSocket:

**REST endpoints:**
- `POST /api/sessions` → create + start review
- `GET /api/sessions` → list all
- `GET /api/sessions/:id` → details + findings
- `POST /api/sessions/:id/cancel` → cancel
- `POST /api/sessions/:id/retry` → retry
- `GET /` → serve static UI

**WebSocket (session-scoped with backpressure):**
- `ws://localhost:3456/ws` → real-time events
- Client subscribes: `{ type: "subscribe", sessionId }`
- Per-client bounded queue: 100 messages or 1MB
- Monitor `ws.bufferedAmount` — disconnect slow consumers

#### [NEW] src/server.test.js

---

### Component 7: Browser UI

Simple single-page app served statically. No build step.

#### [NEW] src/ui/index.html + styles.css + app.js

Dark theme, WebSocket live updates, findings table with dedup indicators, cancel/retry buttons, per-adapter status.

---

## Verification Plan

### Automated Tests (`node --test`)

All unit tests use mocked spawns — no CLI required.

### Integration Tests (Manual — requires CLI)

1. Start server → trigger review via curl → watch real-time events → verify findings
2. Cancel mid-review → verify cleanup, no orphans
3. Retry failed review → verify new snapshot + re-launch
4. >100KB streaming test
5. Browser UI verification via browser_subagent

### MVP Gate Checklist (BRIEF section 9)

- [ ] 2 reviewers parallel on same snapshot
- [ ] Read-only enforcement (EPERM test)
- [ ] Vietnamese UTF-8 full pipeline
- [ ] Large output >100KB streaming
- [ ] Cancel → clean cleanup
- [ ] Retry → clean restart
- [ ] Duplicate findings dedup flagged
- [ ] Session history save + load

---

## Changes from v1

| # | Finding | Fix |
|---|---------|-----|
| 1 | Snapshot immutability is aspirational | `attrib +R /S /D` + EPERM test |
| 2 | Adapter API is batch, not streaming | `AsyncIterable<Event>` return |
| 3 | Dedupe includes severity | Removed severity from fingerprint |
| 4 | No path normalization | `normalizeFindingPath()` utility |
| 5 | No event ordering | Hub-assigned monotonic `seq` |
| 6 | No error propagation policy | Infrastructure vs adapter errors |
| 7 | WS broadcasts globally | Session-scoped + backpressure |
| 8 | SIGTERM/SIGKILL on Windows | `child.kill()` → `taskkill /T /F` |
| 9 | Hardcoded timeouts | Configurable + telemetry |
| 10 | Missing MVP verification | Full gate checklist added |
</implementation_plan>

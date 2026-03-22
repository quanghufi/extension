# Debate P0 Fixes Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix two P0 bugs in the debate system (consensus ratio miscalculation, ghost debate after restart) and add retry + graceful single-agent fallback when one agent dies.

**Architecture:** Three independent changes to the debate subsystem: (1) Fix consensus ratio to count `dropped` findings as agreement, (2) Detect and recover ghost debates on session load, (3) Replace `Promise.all` with `Promise.allSettled` + retry logic with exponential backoff + fallback to single-agent results.

**Tech Stack:** Node.js, `node:test` + `assert/strict`

---

## File Map

| File | Change | Responsibility |
|------|--------|----------------|
| `src/hub/consensus-engine.js` | Modify | Fix ratio calculation to treat `dropped` as agreement |
| `src/hub/consensus-engine.test.js` | Modify | Add tests for the ratio fix |
| `src/hub/debate-orchestrator.js` | Modify | Add retry + `Promise.allSettled` + single-agent fallback in `runReviewPass` |
| `src/hub/debate-orchestrator.test.js` | Modify | Add tests for retry and fallback |
| `src/hub/session-store.js` | Modify | Add ghost debate recovery in `load()` |
| `src/hub/session-store.test.js` | Create | Tests for ghost debate recovery |

---

## Chunk 1: Fix consensus ratio calculation

### Task 1: Fix `calculateAgreement` ratio to count dropped findings as agreement

**Context:** Currently `ratio = agreed / total` where `total = agreed + disputed + dropped`. The problem: when both agents reject a finding (dropped), that IS consensus — they agree it's not a real issue. The ratio should be `(agreed + dropped) / total`, i.e. `1 - (disputed / total)`.

Example: 5 findings, 3 agreed, 0 disputed, 2 dropped → current ratio = 3/5 = 0.6 (below 0.7 threshold → triggers unnecessary rebuttal). Correct ratio = 5/5 = 1.0 (consensus reached).

**Files:**
- Modify: `src/hub/consensus-engine.js:170-174`
- Modify: `src/hub/consensus-engine.test.js`

- [ ] **Step 1: Write failing test — dropped findings should count as agreement**

In `src/hub/consensus-engine.test.js`, add inside the `ConsensusEngine` describe block:

```javascript
it('counts dropped findings as consensus (not just agreed)', () => {
    const engine = new ConsensusEngine({ threshold: 0.7 });

    // 3 findings: 1 agreed, 1 dropped (both reject), 1 disputed
    const findings = [
        { dedupeKey: 'f1', severity: 'high', title: 'Real bug', agentId: 'codex' },
        { dedupeKey: 'f2', severity: 'low', title: 'False positive', agentId: 'codex' },
        { dedupeKey: 'f3', severity: 'medium', title: 'Debatable', agentId: 'codex' },
    ];
    const evaluations = [
        { dedupeKey: 'f1', verdict: 'accepted', agentId: 'claude-code' },
        { dedupeKey: 'f2', verdict: 'rejected', agentId: 'claude-code' },
        { dedupeKey: 'f2', verdict: 'rejected', agentId: 'codex' },
        { dedupeKey: 'f3', verdict: 'accepted', agentId: 'codex' },
        { dedupeKey: 'f3', verdict: 'rejected', agentId: 'claude-code' },
    ];

    const result = engine.calculateAgreement(findings, evaluations);

    // f1 = agreed, f2 = dropped, f3 = disputed
    assert.equal(result.agreed.length, 1);
    assert.equal(result.dropped.length, 1);
    assert.equal(result.disputed.length, 1);

    // Ratio should be (agreed + dropped) / total = 2/3 ≈ 0.667
    // NOT agreed / total = 1/3 ≈ 0.333
    const expected = 2 / 3;
    assert.ok(Math.abs(result.ratio - expected) < 0.01,
        `Expected ratio ~${expected.toFixed(3)} but got ${result.ratio.toFixed(3)}`);
});

it('returns ratio 1.0 when all findings are dropped (full rejection consensus)', () => {
    const engine = new ConsensusEngine({ threshold: 0.7 });

    const findings = [
        { dedupeKey: 'f1', severity: 'low', title: 'FP1', agentId: 'codex' },
        { dedupeKey: 'f2', severity: 'low', title: 'FP2', agentId: 'codex' },
    ];
    const evaluations = [
        { dedupeKey: 'f1', verdict: 'rejected', agentId: 'claude-code' },
        { dedupeKey: 'f1', verdict: 'rejected', agentId: 'codex' },
        { dedupeKey: 'f2', verdict: 'rejected', agentId: 'claude-code' },
        { dedupeKey: 'f2', verdict: 'rejected', agentId: 'codex' },
    ];

    const result = engine.calculateAgreement(findings, evaluations);
    assert.equal(result.ratio, 1.0);
    assert.equal(result.agreed.length, 0);
    assert.equal(result.dropped.length, 2);
    assert.equal(result.disputed.length, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx --no-install node --test src/hub/consensus-engine.test.js 2>&1 | head -40`
Expected: FAIL — ratio returns `0.333` instead of `0.667` for first test, and returns `0.0` instead of `1.0` for second test.

- [ ] **Step 3: Fix the ratio calculation**

In `src/hub/consensus-engine.js`, change lines 170–174 from:

```javascript
        const total = uniqueFindings.length;
        const agreedCount = agreed.length;
        const ratio = total > 0 ? agreedCount / total : 1.0;
```

to:

```javascript
        const total = uniqueFindings.length;
        const consensusCount = agreed.length + dropped.length;
        const ratio = total > 0 ? consensusCount / total : 1.0;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx --no-install node --test src/hub/consensus-engine.test.js`
Expected: ALL PASS

- [ ] **Step 5: Update 3 existing tests whose ratio assertions reflect the old formula**

Three existing tests in `src/hub/consensus-engine.test.js` assert ratio values based on the old `agreed / total` formula. They must be updated to match `(agreed + dropped) / total`:

**Test 1 — Line 74**: `'all evaluators reject → dropped, ratio 0.0'`
The test has 1 finding, all rejected → dropped. Old ratio = 0/1 = 0.0. New ratio = (0+1)/1 = 1.0.

Change the test name and assertion:
```javascript
// Old:
it('all evaluators reject → dropped, ratio 0.0', () => {
    ...
    assert.equal(result.ratio, 0.0);

// New:
it('all evaluators reject → dropped, ratio 1.0 (rejection is consensus)', () => {
    ...
    assert.equal(result.ratio, 1.0);
```

**Test 2 — Line 100**: `'multiple findings → correct ratio'`
Has 2 agreed + 1 dropped + 0 disputed. Old ratio = 2/3. New ratio = (2+1)/3 = 1.0.

```javascript
// Old:
    // ratio = 2/3
    assert.ok(Math.abs(result.ratio - 2 / 3) < 0.001);

// New:
    // ratio = (2 agreed + 1 dropped) / 3 total = 1.0
    assert.equal(result.ratio, 1.0);
```

**Test 3 — Line 128**: `'deduplicates findings by dedupeKey before calculating agreement'`
Has 1 agreed + 1 dropped (after dedup). Old ratio = 1/2 = 0.5. New ratio = (1+1)/2 = 1.0.

```javascript
// Old:
    assert.equal(result.ratio, 0.5);

// New:
    assert.equal(result.ratio, 1.0);
```

- [ ] **Step 6: Run full test suite to check for regressions**

Run: `npm test 2>&1 | tail -20`
Expected: ALL PASS — no regressions.

- [ ] **Step 7: Commit**

```bash
git add src/hub/consensus-engine.js src/hub/consensus-engine.test.js
git commit -m "fix(debate): count dropped findings as consensus in agreement ratio

Dropped findings (both agents reject) represent mutual agreement that the
finding is invalid. Previously only 'agreed' findings counted toward the
consensus ratio, causing unnecessary rebuttal rounds when agents actually
agree to reject false positives.

Ratio formula: (agreed + dropped) / total instead of agreed / total."
```

---

## Chunk 2: Ghost debate recovery on session load

### Task 2: Recover sessions stuck with `debateActive=true` after server restart

**Context:** When the server restarts during an active debate, the background promise is lost but the session file still has `debateActive=true`. This causes all collab tools to be permanently blocked because they check `debateActive` before allowing operations. The fix: when `SessionStore.load()` deserializes a session, check for ghost debates and auto-recover by setting `debateActive=false` and `debateState='failed'`.

**Files:**
- Modify: `src/hub/session-store.js:59-70`
- Create: `src/hub/session-store.test.js`

- [ ] **Step 1: Write failing test for ghost debate detection**

Create `src/hub/session-store.test.js`:

```javascript
// @ts-check
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SessionStore } from './session-store.js';
import { Session } from './session.js';

describe('SessionStore', () => {
    /** @type {string} */
    let tempDir;
    /** @type {SessionStore} */
    let store;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-store-test-'));
        store = new SessionStore(tempDir);
    });

    afterEach(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    describe('ghost debate recovery', () => {
        it('recovers session with debateActive=true on load', () => {
            // Create and save a session with active debate
            const session = new Session({
                projectDir: '/test/project',
                prompt: 'Review this code',
            });
            session.debateActive = true;
            session.debateState = 'reviewing';
            session.debateAgents = ['codex', 'claude-code'];
            store.save(session);

            // Load it back — simulates server restart
            const loaded = store.load(session.id);

            assert.equal(loaded.debateActive, false,
                'debateActive should be false after recovery');
            assert.equal(loaded.debateState, 'failed',
                'debateState should be failed after recovery');
        });

        it('does not modify sessions without active debate', () => {
            const session = new Session({
                projectDir: '/test/project',
                prompt: 'Review this code',
            });
            session.debateActive = false;
            session.debateState = 'resolved';
            store.save(session);

            const loaded = store.load(session.id);

            assert.equal(loaded.debateActive, false);
            assert.equal(loaded.debateState, 'resolved');
        });

        it('does not modify sessions with debateState in terminal state', () => {
            const session = new Session({
                projectDir: '/test/project',
                prompt: 'Review this code',
            });
            // Edge case: debateActive somehow true but state already terminal
            session.debateActive = true;
            session.debateState = 'resolved';
            store.save(session);

            const loaded = store.load(session.id);

            // Should still recover — debateActive=true is the authoritative
            // indicator that no background process is driving the debate.
            assert.equal(loaded.debateActive, false);
        });
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx --no-install node --test src/hub/session-store.test.js 2>&1 | head -30`
Expected: FAIL — `loaded.debateActive` is `true` (not recovered).

- [ ] **Step 3: Add ghost debate recovery to `SessionStore.load()`**

In `src/hub/session-store.js`, modify the `load()` method (lines 59-70):

```javascript
    load(sessionId) {
        const filePath = this._sessionPath(sessionId);
        if (!fs.existsSync(filePath)) return null;

        try {
            const raw = fs.readFileSync(filePath, 'utf-8');
            const data = JSON.parse(raw);
            const session = Session.fromJSON(data);

            // Ghost debate recovery: if debateActive is true on disk, no
            // background executor owns this session (we just loaded from
            // cold storage). Mark as failed so collab tools are unblocked.
            if (session.debateActive) {
                session.debateActive = false;
                if (session.debateState && session.debateState !== 'resolved') {
                    session.debateState = 'failed';
                }
            }

            return session;
        } catch {
            return null; // Corrupted file
        }
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx --no-install node --test src/hub/session-store.test.js`
Expected: ALL PASS

- [ ] **Step 5: Run full test suite**

Run: `npm test 2>&1 | tail -20`
Expected: No regressions. Existing tests create sessions in-memory, not through load(), so recovery doesn't trigger on them.

- [ ] **Step 6: Commit**

```bash
git add src/hub/session-store.js src/hub/session-store.test.js
git commit -m "fix(debate): recover ghost debates on session load

When server restarts during active debate, the background executor
promise is lost but debateActive=true persists on disk. This blocks
all collab tools permanently. Now SessionStore.load() detects this
state and auto-recovers: debateActive=false, debateState='failed'.

Sessions loaded into memory by a running debate executor are unaffected
because the executor holds the in-memory reference, not a fresh load()."
```

---

## Chunk 3: Retry + graceful single-agent fallback

### Task 3: Add retry logic with exponential backoff to `runReviewPass`

**Context:** Currently `runReviewPass` uses `Promise.all` — if any agent fails, the entire debate dies. The fix:
1. Wrap each agent's execution in a retry loop (max 3 attempts, exponential backoff: 2s, 4s, 8s).
2. Use `Promise.allSettled` instead of `Promise.all`.
3. If an agent still fails after 3 retries in a 2-agent debate, degrade gracefully: continue with the surviving agent's findings only, treating the failed agent as absent. Emit system messages explaining the degradation.

**Files:**
- Modify: `src/hub/debate-orchestrator.js:769-813`
- Modify: `src/hub/debate-orchestrator.test.js`

- [ ] **Step 1: Write failing test — retry on transient failure**

Add to `src/hub/debate-orchestrator.test.js` inside the `DebateExecutor` describe block:

```javascript
describe('retry and fallback', () => {
    it('retries a failed agent up to 3 times before giving up', async () => {
        const session = createMockSession();
        session.id = 'sess-retry';
        session.projectDir = '/project';
        session.snapshotPath = '/snapshot';
        session.debateRound = 0;
        session.debateAgents = ['codex'];

        let callCount = 0;
        const executor = new DebateExecutor({
            session,
            adapterMap: {
                codex: {
                    execute: () => {
                        callCount++;
                        if (callCount < 3) {
                            return {
                                stream: (async function* () {})(),
                                done: Promise.resolve({
                                    status: 'error',
                                    findings: [],
                                    timingMs: { firstByteMs: 0, lastIdleGapMs: 0, totalMs: 0 },
                                }),
                            };
                        }
                        return {
                            stream: (async function* () {})(),
                            done: Promise.resolve({
                                status: 'ok',
                                findings: [{ id: 'f1', dedupe_key: 'dk1', summary: 'Bug', severity: 'high' }],
                                timingMs: { firstByteMs: 0, lastIdleGapMs: 0, totalMs: 0 },
                            }),
                        };
                    },
                },
            },
        });

        await executor.runReviewPass(['codex'], {
            phase: 'review',
            prompt: 'Review this',
        });

        assert.equal(callCount, 3, 'Should have retried until success on 3rd attempt');
        assert.equal(executor.rawFindingsByAgent.get('codex')?.length, 1);
    });

    it('falls back to surviving agent when one agent exhausts retries in 2-agent debate', async () => {
        const session = createMockSession();
        session.id = 'sess-fallback';
        session.projectDir = '/project';
        session.snapshotPath = '/snapshot';
        session.debateRound = 0;
        session.debateAgents = ['codex', 'claude-code'];

        const messages = [];
        const executor = new DebateExecutor({
            session,
            onSystemMessage: (msg) => messages.push(msg),
            adapterMap: {
                codex: {
                    execute: () => ({
                        stream: (async function* () {})(),
                        done: Promise.resolve({
                            status: 'ok',
                            findings: [{ id: 'f1', dedupe_key: 'dk1', summary: 'Bug', severity: 'high' }],
                            timingMs: { firstByteMs: 0, lastIdleGapMs: 0, totalMs: 0 },
                        }),
                    }),
                },
                'claude-code': {
                    execute: () => ({
                        stream: (async function* () {})(),
                        done: Promise.resolve({
                            status: 'error',
                            findings: [],
                            timingMs: { firstByteMs: 0, lastIdleGapMs: 0, totalMs: 0 },
                        }),
                    }),
                },
            },
        });

        await executor.runReviewPass(['codex', 'claude-code'], {
            phase: 'review',
            prompt: 'Review this',
        });

        // Codex findings should survive
        assert.equal(executor.rawFindingsByAgent.get('codex')?.length, 1);
        // Claude-code should have empty findings (failed)
        assert.equal(executor.rawFindingsByAgent.has('claude-code'), false);
        // System message about fallback
        assert.ok(messages.some(m => /claude-code.*failed.*3 attempts/i.test(m)),
            'Should emit system message about agent failure');
        assert.ok(messages.some(m => /continuing.*single.agent|surviving/i.test(m)),
            'Should emit system message about single-agent fallback');
    });

    it('throws when ALL agents fail after retries (no survivor)', async () => {
        const session = createMockSession();
        session.id = 'sess-all-fail';
        session.projectDir = '/project';
        session.snapshotPath = '/snapshot';
        session.debateRound = 0;
        session.debateAgents = ['codex'];

        const executor = new DebateExecutor({
            session,
            adapterMap: {
                codex: {
                    execute: () => ({
                        stream: (async function* () {})(),
                        done: Promise.resolve({
                            status: 'error',
                            findings: [],
                            timingMs: { firstByteMs: 0, lastIdleGapMs: 0, totalMs: 0 },
                        }),
                    }),
                },
            },
        });

        await assert.rejects(
            () => executor.runReviewPass(['codex'], {
                phase: 'review',
                prompt: 'Review this',
            }),
            /all agents failed/i,
        );
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx --no-install node --test src/hub/debate-orchestrator.test.js --test-name-pattern "retry" 2>&1 | head -30`
Expected: FAIL — current code uses `Promise.all` with no retry.

- [ ] **Step 3: Implement retry + fallback in `runReviewPass`**

Replace the `runReviewPass` method in `src/hub/debate-orchestrator.js` (lines 769-814). The new implementation:

```javascript
    /**
     * @param {string} agentId
     * @param {{ phase: 'review'|'rebuttal'|'tie_break', prompt: string }} options
     * @param {{ maxRetries?: number, baseDelayMs?: number }} [retryOpts]
     * @returns {Promise<{ agentId: string, findings: import('../schema/events.js').Finding[] }>}
     */
    async _executeAgentWithRetry(agentId, options, retryOpts = {}) {
        const maxRetries = retryOpts.maxRetries ?? 3;
        const baseDelayMs = retryOpts.baseDelayMs ?? 2000;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            const adapter = this.resolveAdapter(agentId);
            const executionPath = this.resolveExecutionPath(agentId);
            const startedAt = Date.now();

            try {
                const { stream, done } = adapter.execute(
                    this.session.id,
                    executionPath,
                    options.prompt,
                    { timeouts: this.getPhaseTimeouts(agentId, options.phase) },
                );

                for await (const event of stream) {
                    this.onEvent(event);
                }

                const result = await done;
                const completedAt = Date.now();
                this.recordTiming(agentId, options.phase, startedAt, completedAt, result.status === 'timeout');

                if (result.status === 'ok') {
                    return { agentId, findings: result.findings };
                }

                // Non-ok status — retry if attempts remain
                if (attempt < maxRetries) {
                    const delay = baseDelayMs * Math.pow(2, attempt - 1);
                    this.onSystemMessage(`${agentId} ${options.phase} attempt ${attempt}/${maxRetries} failed (status: ${result.status}). Retrying in ${delay / 1000}s...`);
                    await new Promise((resolve) => setTimeout(resolve, delay));
                } else {
                    throw new Error(`${agentId} ${options.phase} failed with status "${result.status}" after ${maxRetries} attempts`);
                }
            } catch (err) {
                if (attempt >= maxRetries) {
                    throw err;
                }
                const delay = baseDelayMs * Math.pow(2, attempt - 1);
                this.onSystemMessage(`${agentId} ${options.phase} attempt ${attempt}/${maxRetries} threw error. Retrying in ${delay / 1000}s...`);
                await new Promise((resolve) => setTimeout(resolve, delay));
            }
        }

        // Unreachable, but TypeScript/JSDoc needs it
        throw new Error(`${agentId} ${options.phase} failed after ${retryOpts.maxRetries ?? 3} attempts`);
    }

    /**
     * @param {string[]} agentIds
     * @param {{ phase: 'review'|'rebuttal'|'tie_break', prompt: string, disputedKeys?: string[] }} options
     */
    async runReviewPass(agentIds, options) {
        const round = this.session.debateRound ?? 0;
        this.completedEvals = [];

        const settled = await Promise.allSettled(
            agentIds.map((agentId) =>
                this._executeAgentWithRetry(agentId, options),
            ),
        );

        /** @type {{ agentId: string, findings: import('../schema/events.js').Finding[] }[]} */
        const succeeded = [];
        /** @type {string[]} */
        const failedAgents = [];

        for (let i = 0; i < settled.length; i++) {
            const outcome = settled[i];
            if (outcome.status === 'fulfilled') {
                succeeded.push(outcome.value);
            } else {
                failedAgents.push(agentIds[i]);
                this.onSystemMessage(`Agent ${agentIds[i]} failed after 3 attempts: ${outcome.reason?.message ?? outcome.reason}`);
            }
        }

        if (succeeded.length === 0) {
            throw new Error(`All agents failed in ${options.phase} phase: [${failedAgents.join(', ')}]`);
        }

        if (failedAgents.length > 0) {
            this.onSystemMessage(
                `Continuing with surviving agent(s) [${succeeded.map(s => s.agentId).join(', ')}]. ` +
                `Failed agent(s) [${failedAgents.join(', ')}] excluded from this ${options.phase} round.`
            );
        }

        for (const { agentId, findings } of succeeded) {
            if (options.phase === 'rebuttal' && options.disputedKeys) {
                const retained = (this.rawFindingsByAgent.get(agentId) ?? [])
                    .filter((finding) => !options.disputedKeys.includes(finding.dedupe_key));
                const updated = findings.filter((finding) => options.disputedKeys.includes(finding.dedupe_key));
                this.rawFindingsByAgent.set(agentId, [...retained, ...updated]);
            } else {
                this.rawFindingsByAgent.set(agentId, findings);
            }

            this.completedReviews = [...new Set([...this.completedReviews, agentId])];
            this.onSystemMessage(`${agentId} produced ${(this.rawFindingsByAgent.get(agentId) ?? []).length} active findings in ${options.phase}.`);
        }

        this.rebuildFindingEntries();
    }
```

- [ ] **Step 4: Run retry tests to verify they pass**

Run: `npx --no-install node --test src/hub/debate-orchestrator.test.js --test-name-pattern "retry|fallback|ALL agents fail" 2>&1`
Expected: ALL PASS

- [ ] **Step 5: Run full test suite to check for regressions**

Run: `npm test 2>&1 | tail -30`
Expected: ALL PASS. Existing tests use mock adapters that return `status: 'ok'` → they succeed on first attempt, no retry logic triggered.

**Important regression note:** The existing test `passes phase timeout overrides into adapter execution` passes a mock adapter that returns `status: 'ok'` immediately, so the retry loop exits on the first attempt without delay. Same for all file-scoped sandbox tests.

- [ ] **Step 6: Commit**

```bash
git add src/hub/debate-orchestrator.js src/hub/debate-orchestrator.test.js
git commit -m "fix(debate): add retry with backoff and single-agent fallback

Replace Promise.all fail-fast with Promise.allSettled + per-agent retry
(3 attempts, exponential backoff 2s/4s/8s). When one agent exhausts
retries in a 2-agent debate, the surviving agent's findings are used
as the debate result. Only throws when ALL agents fail.

This prevents transient CLI failures from killing the entire debate."
```

---

## Verification

After all 3 chunks are committed:

- [ ] **Run full test suite**: `npm test`
- [ ] **Run e2e tests if available**: `npm run e2e` (may require running server)
- [ ] **Manual verification**: Confirm the 3 fixes are independent and don't interact negatively

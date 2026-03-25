// @ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Session, SESSION_STATES, TERMINAL_STATES, severityRank } from './session.js';
import { createEvent, createFinding } from '../schema/events.js';

describe('Session', () => {
    const baseOpts = { projectDir: '/project', prompt: 'Review this code' };

    it('creates with required fields', () => {
        const s = new Session(baseOpts);
        assert.ok(s.id);
        assert.equal(s.projectDir, '/project');
        assert.equal(s.prompt, 'Review this code');
        assert.equal(s.state, 'pending');
        assert.equal(s.parentSessionId, null);
        assert.ok(s.createdAt);
    });

    it('accepts custom ID', () => {
        const s = new Session({ ...baseOpts, id: 'custom-id' });
        assert.equal(s.id, 'custom-id');
    });

    it('accepts parentSessionId for retries', () => {
        const s = new Session({ ...baseOpts, parentSessionId: 'parent-1' });
        assert.equal(s.parentSessionId, 'parent-1');
    });
});

describe('Session.addEvent', () => {
    it('assigns monotonic seq starting from 0', () => {
        const s = new Session({ projectDir: '/p', prompt: 'test' });
        s.start();

        const e1 = s.addEvent(createEvent(s.id, 'codex', 'status', { state: 'started' }));
        const e2 = s.addEvent(createEvent(s.id, 'semgrep', 'status', { state: 'started' }));
        const e3 = s.addEvent(createEvent(s.id, 'codex', 'heartbeat', {}));

        assert.equal(e1.seq, 0);
        assert.equal(e2.seq, 1);
        assert.equal(e3.seq, 2);
    });

    it('seq is assigned by Hub, not in original event', () => {
        const s = new Session({ projectDir: '/p', prompt: 'test' });
        s.start();

        const originalEvent = createEvent(s.id, 'codex', 'status', {});
        assert.equal(originalEvent.seq, undefined);

        const withSeq = s.addEvent(originalEvent);
        assert.equal(withSeq.seq, 0);
    });

    it('throws when adding to terminal session', () => {
        const s = new Session({ projectDir: '/p', prompt: 'test' });
        s.start();
        s.finalize('completed');

        assert.throws(
            () => s.addEvent(createEvent(s.id, 'codex', 'status', {})),
            /Cannot add events to terminal session/
        );
    });

    it('auto-registers agents on event receipt', () => {
        const s = new Session({ projectDir: '/p', prompt: 'test' });
        s.start();

        s.addEvent(createEvent(s.id, 'codex', 'status', { state: 'started' }));
        assert.ok(s.agents.has('codex'));
        assert.equal(s.agents.get('codex')?.state, 'running');
    });

    it('tracks agent completion state', () => {
        const s = new Session({ projectDir: '/p', prompt: 'test' });
        s.start();

        s.addEvent(createEvent(s.id, 'codex', 'status', { state: 'started' }));
        s.addEvent(createEvent(s.id, 'codex', 'status', { state: 'done', status: 'ok', findingCount: 5 }));

        const agent = s.agents.get('codex');
        assert.equal(agent?.state, 'completed');
        assert.equal(agent?.status, 'ok');
        assert.equal(agent?.findingCount, 5);
    });

    it('resets agent completion metadata when a new pass starts', () => {
        const s = new Session({ projectDir: '/p', prompt: 'test' });
        s.start();

        s.addEvent(createEvent(s.id, 'codex', 'status', { state: 'started' }));
        s.addEvent(createEvent(s.id, 'codex', 'status', { state: 'done', status: 'ok', findingCount: 5 }));
        s.addEvent(createEvent(s.id, 'codex', 'status', { state: 'started' }));

        const agent = s.agents.get('codex');
        assert.equal(agent?.state, 'running');
        assert.equal(agent?.completedAt, null);
        assert.equal(agent?.status, null);
        assert.equal(agent?.findingCount, 0);
    });
});

describe('Session state management', () => {
    it('transitions pending → running', () => {
        const s = new Session({ projectDir: '/p', prompt: 'test' });
        assert.equal(s.state, 'pending');
        s.start();
        assert.equal(s.state, 'running');
    });

    it('throws if start() called when not pending', () => {
        const s = new Session({ projectDir: '/p', prompt: 'test' });
        s.start();
        assert.throws(() => s.start(), /Cannot start session in state/);
    });

    it('finalize sets terminal state and completedAt', () => {
        const s = new Session({ projectDir: '/p', prompt: 'test' });
        s.start();
        s.finalize('completed');

        assert.equal(s.state, 'completed');
        assert.ok(s.completedAt);
        assert.ok(s.isTerminal());
    });

    it('finalize is idempotent', () => {
        const s = new Session({ projectDir: '/p', prompt: 'test' });
        s.start();
        s.finalize('completed');
        const ts = s.completedAt;

        // Should not throw, should not change state
        s.finalize('failed');
        assert.equal(s.state, 'completed'); // Still first terminal state
        assert.equal(s.completedAt, ts);
    });

    it('rejects invalid terminal state', () => {
        const s = new Session({ projectDir: '/p', prompt: 'test' });
        s.start();
        assert.throws(
            // @ts-ignore
            () => s.finalize('invalid_state'),
            /Invalid terminal state/
        );
    });

    it('all terminal states are recognized', () => {
        for (const state of TERMINAL_STATES) {
            const s = new Session({ projectDir: '/p', prompt: 'test' });
            s.start();
            s.finalize(/** @type {any} */(state));
            assert.ok(s.isTerminal());
        }
    });
});

describe('Session.createRetry', () => {
    it('creates new session linked to parent', () => {
        const parent = new Session({ projectDir: '/p', prompt: 'review' });
        const retry = parent.createRetry();

        assert.notEqual(retry.id, parent.id);
        assert.equal(retry.parentSessionId, parent.id);
        assert.equal(retry.projectDir, parent.projectDir);
        assert.equal(retry.prompt, parent.prompt);
        assert.equal(retry.state, 'pending');
        assert.deepStrictEqual(retry.events, []);
    });

    it('can override prompt in retry', () => {
        const parent = new Session({ projectDir: '/p', prompt: 'old prompt' });
        const retry = parent.createRetry({ prompt: 'new prompt' });
        assert.equal(retry.prompt, 'new prompt');
    });

    it('retry has fresh seq counter', () => {
        const parent = new Session({ projectDir: '/p', prompt: 'review' });
        parent.start();
        parent.addEvent(createEvent(parent.id, 'codex', 'status', {}));
        parent.addEvent(createEvent(parent.id, 'codex', 'status', {}));

        const retry = parent.createRetry();
        retry.start();
        const e = retry.addEvent(createEvent(retry.id, 'codex', 'status', {}));
        assert.equal(e.seq, 0); // Fresh counter
    });

    it('forwards agentId, reviewOptions, snapshotPath, round', () => {
        const parent = new Session({
            projectDir: '/p',
            prompt: 'review',
            agentId: 'mcp-codex',
            reviewOptions: { review_target: 'file', file_path: 'a.js' },
            snapshotPath: '/snap/123',
            round: 2,
            label: 'Review X Round 2',
        });
        const retry = parent.createRetry();

        assert.equal(retry.agentId, 'mcp-codex');
        assert.deepStrictEqual(retry.reviewOptions, { review_target: 'file', file_path: 'a.js' });
        assert.equal(retry.snapshotPath, '/snap/123');
        assert.equal(retry.round, 3);
        assert.equal(retry.label, 'Review X Round 3');
        assert.equal(retry.parentSessionId, parent.id);
    });

    it('auto-generates label when parent has no label', () => {
        const parent = new Session({ projectDir: '/p', prompt: 'review' });
        const retry = parent.createRetry();
        assert.equal(retry.label, 'Round 2');
    });

    it('allows label override in retry', () => {
        const parent = new Session({ projectDir: '/p', prompt: 'review', label: 'Review X Round 1' });
        const retry = parent.createRetry({ label: 'Custom Label' });
        assert.equal(retry.label, 'Custom Label');
    });
});

describe('Session finding aggregation', () => {
    it('groups findings by dedupe_key', () => {
        const s = new Session({ projectDir: '/p', prompt: 'test' });
        s.start();

        const f1 = createFinding({ severity: 'high', summary: 'Bug X', evidence: '', file: 'a.js', line: 1 });
        const f2 = createFinding({ severity: 'low', summary: 'Bug X', evidence: '', file: 'a.js', line: 1 });
        // f1 and f2 have same dedupe_key (severity excluded)

        const f3 = createFinding({ severity: 'medium', summary: 'Different', evidence: '', file: 'b.js', line: 5 });

        s.finalize('completed', [f1, f2, f3]);

        assert.equal(s.groupedFindings.length, 2); // 2 unique issues
        const bugGroup = s.groupedFindings.find((g) => g.finding.summary === 'Bug X');
        assert.ok(bugGroup);
        assert.equal(bugGroup.raw_findings.length, 2);

        // Representative finding should be highest severity (high > low)
        assert.equal(bugGroup.finding.severity, 'high');
    });

    it('preserves raw findings in allFindings', () => {
        const s = new Session({ projectDir: '/p', prompt: 'test' });
        s.start();

        const findings = [
            createFinding({ severity: 'high', summary: 'A', evidence: '', file: 'a.js' }),
            createFinding({ severity: 'low', summary: 'B', evidence: '', file: 'b.js' }),
        ];

        s.finalize('completed', findings);
        assert.equal(s.allFindings.length, 2);
    });
});

describe('Session serialization', () => {
    it('toJSON and fromJSON roundtrip', () => {
        const s = new Session({ projectDir: '/p', prompt: 'test', id: 'sess-42' });
        s.start();
        s.addEvent(createEvent(s.id, 'codex', 'status', { state: 'started' }));
        s.addEvent(createEvent(s.id, 'codex', 'heartbeat', {}));

        const json = s.toJSON();
        const restored = Session.fromJSON(json);

        assert.equal(restored.id, 'sess-42');
        assert.equal(restored.state, 'running');
        assert.equal(restored.events.length, 2);
        assert.equal(restored._seqCounter, 2);
        assert.ok(restored.agents.has('codex'));
    });

    it('label roundtrips through toJSON/fromJSON', () => {
        const s = new Session({ projectDir: '/p', prompt: 'test', label: 'Review Phase-04 Round 1' });
        const json = s.toJSON();
        assert.equal(json.label, 'Review Phase-04 Round 1');
        const restored = Session.fromJSON(json);
        assert.equal(restored.label, 'Review Phase-04 Round 1');
    });

    it('fromJSON defaults label to null', () => {
        const restored = Session.fromJSON({ id: 'x', projectDir: '/p', prompt: 'test' });
        assert.equal(restored.label, null);
    });

    it('fromJSON handles missing optional fields', () => {
        const minimal = {
            id: 'minimal',
            projectDir: '/p',
            prompt: 'test',
        };
        const restored = Session.fromJSON(minimal);
        assert.equal(restored.id, 'minimal');
        assert.equal(restored.state, 'pending');
        assert.deepStrictEqual(restored.events, []);
    });
});

describe('Session watchdog', () => {
    it('marks running session as stalled after idle threshold', () => {
        const s = new Session({ projectDir: '/project', prompt: 'review' });
        s.start();
        s.createdAt = '2026-03-11T00:00:00.000Z';

        const watchdog = s.getWatchdogStatus(Date.parse('2026-03-11T00:16:00.000Z'));
        assert.equal(watchdog.stalled, true);
        assert.equal(s.getDisplayState(), 'stalled');
    });

    it('does not mark mcp-codex stalled too early for deep reviews', () => {
        const s = new Session({ projectDir: '/project', prompt: 'review', agentId: 'mcp-codex' });
        s.start();
        s.createdAt = '2026-03-11T00:00:00.000Z';

        const watchdog = s.getWatchdogStatus(Date.parse('2026-03-11T00:02:00.000Z'));
        assert.equal(watchdog.stalled, false);
        assert.equal(watchdog.thresholdMs, 900000);
    });

    it('does not mark codex stalled before its extended review hard-timeout window', () => {
        const s = new Session({ projectDir: '/project', prompt: 'review', agentId: 'codex' });
        s.start();
        s.createdAt = '2026-03-11T00:00:00.000Z';

        const watchdog = s.getWatchdogStatus(Date.parse('2026-03-11T00:10:30.000Z'));
        assert.equal(watchdog.stalled, false);
        assert.equal(watchdog.thresholdMs, 660000);
    });

    it('embeds watchdog and displayState in JSON', () => {
        const s = new Session({ projectDir: '/project', prompt: 'review' });
        s.start();
        const json = s.toJSON();

        assert.ok(json.watchdog);
        assert.equal(json.displayState, 'running');
    });
});

describe('severityRank', () => {
    it('ranks critical > high > medium > low', () => {
        assert.ok(severityRank('critical') > severityRank('high'));
        assert.ok(severityRank('high') > severityRank('medium'));
        assert.ok(severityRank('medium') > severityRank('low'));
    });

    it('returns 0 for unknown severity', () => {
        assert.equal(severityRank('unknown'), 0);
    });
});

describe('SESSION_STATES / TERMINAL_STATES', () => {
    it('terminal states are subset of all states', () => {
        for (const ts of TERMINAL_STATES) {
            assert.ok(SESSION_STATES.includes(ts));
        }
    });

    it('pending and running are not terminal', () => {
        assert.ok(!TERMINAL_STATES.includes('pending'));
        assert.ok(!TERMINAL_STATES.includes('running'));
    });
});

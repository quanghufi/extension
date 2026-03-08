// @ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    createEvent,
    createFinding,
    computeDedupeKey,
    normalizeSummary,
    SEVERITY_LEVELS,
    EVENT_TYPES,
} from './events.js';

describe('createEvent', () => {
    it('creates event with all required fields', () => {
        const event = createEvent('sess-1', 'codex', 'status', { state: 'running' });

        assert.equal(event.session_id, 'sess-1');
        assert.equal(event.agent_id, 'codex');
        assert.equal(event.event_type, 'status');
        assert.deepStrictEqual(event.payload, { state: 'running' });
        assert.ok(event.timestamp);
        // ISO-8601 format
        assert.ok(!isNaN(Date.parse(event.timestamp)));
    });

    it('does NOT include seq field — Hub assigns it', () => {
        const event = createEvent('sess-1', 'codex', 'status', {});
        assert.equal(event.seq, undefined);
        assert.ok(!('seq' in event));
    });

    it('rejects invalid eventType', () => {
        assert.throws(
            () => createEvent('sess-1', 'codex', 'invalid_type', {}),
            /eventType must be one of/
        );
    });

    it('rejects empty sessionId', () => {
        assert.throws(
            () => createEvent('', 'codex', 'status', {}),
            /sessionId is required/
        );
    });

    it('rejects empty agentId', () => {
        assert.throws(
            () => createEvent('sess-1', '', 'status', {}),
            /agentId is required/
        );
    });

    it('uses empty object when payload is null/undefined', () => {
        const event = createEvent('sess-1', 'codex', 'heartbeat', null);
        assert.deepStrictEqual(event.payload, {});
    });

    it('accepts all valid event types', () => {
        for (const type of EVENT_TYPES) {
            const event = createEvent('sess-1', 'codex', type, {});
            assert.equal(event.event_type, type);
        }
    });
});

describe('createFinding', () => {
    const baseFinding = {
        severity: 'high',
        summary: 'Missing null check',
        evidence: 'Line 42 dereferences without null guard',
        file: 'src/server.js',
        line: 42,
        confidence: 0.85,
    };

    it('creates finding with all fields', () => {
        const finding = createFinding(baseFinding);

        assert.equal(finding.severity, 'high');
        assert.equal(finding.summary, 'Missing null check');
        assert.equal(finding.file, 'src/server.js');
        assert.equal(finding.line, 42);
        assert.equal(finding.confidence, 0.85);
        assert.ok(finding.id.startsWith('F-'));
        assert.equal(finding.id.length, 10); // F- + 8 hex chars
        assert.ok(finding.dedupe_key);
        assert.equal(finding.dedupe_key.length, 16);
    });

    it('defaults line to null', () => {
        const finding = createFinding({ ...baseFinding, line: undefined });
        assert.equal(finding.line, null);
    });

    it('defaults confidence to 0.5', () => {
        const finding = createFinding({ ...baseFinding, confidence: undefined });
        assert.equal(finding.confidence, 0.5);
    });

    it('rejects invalid severity', () => {
        assert.throws(
            () => createFinding({ ...baseFinding, severity: 'extreme' }),
            /severity must be one of/
        );
    });

    it('rejects empty summary', () => {
        assert.throws(
            () => createFinding({ ...baseFinding, summary: '' }),
            /summary is required/
        );
    });

    it('rejects empty file', () => {
        assert.throws(
            () => createFinding({ ...baseFinding, file: '' }),
            /file is required/
        );
    });

    it('rejects confidence out of range', () => {
        assert.throws(
            () => createFinding({ ...baseFinding, confidence: 1.5 }),
            /confidence must be a number between 0 and 1/
        );
        assert.throws(
            () => createFinding({ ...baseFinding, confidence: -0.1 }),
            /confidence must be a number between 0 and 1/
        );
    });

    it('accepts all valid severity levels', () => {
        for (const sev of SEVERITY_LEVELS) {
            const finding = createFinding({ ...baseFinding, severity: sev });
            assert.equal(finding.severity, sev);
        }
    });
});

describe('normalizeSummary', () => {
    it('lowercases text', () => {
        assert.equal(normalizeSummary('Missing Null Check'), 'missing null check');
    });

    it('strips punctuation', () => {
        assert.equal(normalizeSummary('Error: missing check!'), 'error missing check');
    });

    it('collapses whitespace', () => {
        assert.equal(normalizeSummary('missing   null   check'), 'missing null check');
    });

    it('trims leading/trailing whitespace', () => {
        assert.equal(normalizeSummary('  missing check  '), 'missing check');
    });

    it('preserves Unicode letters (Vietnamese/Japanese)', () => {
        assert.equal(normalizeSummary('Thiếu kiểm tra null'), 'thiếu kiểm tra null');
        assert.ok(normalizeSummary('日本語テスト').includes('日本語'));
    });

    it('handles empty string', () => {
        assert.equal(normalizeSummary(''), '');
    });
});

describe('computeDedupeKey', () => {
    it('produces deterministic hash — same input same key', () => {
        const key1 = computeDedupeKey({ file: 'src/a.js', line: 10, summary: 'Bug here' });
        const key2 = computeDedupeKey({ file: 'src/a.js', line: 10, summary: 'Bug here' });
        assert.equal(key1, key2);
    });

    it('differs when file changes', () => {
        const key1 = computeDedupeKey({ file: 'src/a.js', line: 10, summary: 'Bug' });
        const key2 = computeDedupeKey({ file: 'src/b.js', line: 10, summary: 'Bug' });
        assert.notEqual(key1, key2);
    });

    it('differs when line changes', () => {
        const key1 = computeDedupeKey({ file: 'src/a.js', line: 10, summary: 'Bug' });
        const key2 = computeDedupeKey({ file: 'src/a.js', line: 20, summary: 'Bug' });
        assert.notEqual(key1, key2);
    });

    it('differs when summary changes', () => {
        const key1 = computeDedupeKey({ file: 'src/a.js', line: 10, summary: 'Bug A' });
        const key2 = computeDedupeKey({ file: 'src/a.js', line: 10, summary: 'Bug B' });
        assert.notEqual(key1, key2);
    });

    it('IGNORES severity — same file+line+summary with different severity → same key', () => {
        // This is the critical R3 finding 3 test.
        // We can't pass severity to computeDedupeKey, but let's prove it via createFinding
        const f1 = createFinding({
            severity: 'critical', summary: 'Null check missing', evidence: '', file: 'src/a.js', line: 5
        });
        const f2 = createFinding({
            severity: 'low', summary: 'Null check missing', evidence: '', file: 'src/a.js', line: 5
        });
        assert.equal(f1.dedupe_key, f2.dedupe_key);
    });

    it('normalizes summary — case/punctuation differences → same key', () => {
        const key1 = computeDedupeKey({ file: 'src/a.js', line: 10, summary: 'Missing null check!' });
        const key2 = computeDedupeKey({ file: 'src/a.js', line: 10, summary: 'missing null check' });
        assert.equal(key1, key2);
    });

    it('handles null line', () => {
        const key1 = computeDedupeKey({ file: 'src/a.js', line: null, summary: 'Bug' });
        const key2 = computeDedupeKey({ file: 'src/a.js', line: null, summary: 'Bug' });
        assert.equal(key1, key2);

        // null line differs from line 0
        const key3 = computeDedupeKey({ file: 'src/a.js', line: 0, summary: 'Bug' });
        assert.notEqual(key1, key3);
    });

    it('returns 16 character hex string', () => {
        const key = computeDedupeKey({ file: 'src/a.js', line: 1, summary: 'test' });
        assert.equal(key.length, 16);
        assert.match(key, /^[0-9a-f]{16}$/);
    });
});

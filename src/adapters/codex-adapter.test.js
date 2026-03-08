// @ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CodexAdapter, mapSeverity } from './codex-adapter.js';

describe('CodexAdapter', () => {
    it('has agentId "codex"', () => {
        const adapter = new CodexAdapter();
        assert.equal(adapter.agentId, 'codex');
    });

    it('buildCommand returns correct cmd and args', () => {
        const adapter = new CodexAdapter();
        const { cmd, args } = adapter.buildCommand('/path/to/snapshot', 'Review this code');

        assert.equal(cmd, 'codex');
        assert.ok(args.includes('review'));
        assert.ok(args.includes('--output-format'));
        assert.ok(args.includes('stream-json'));
        assert.ok(args.includes('--verbose'));
        assert.ok(args.includes('Review this code'));
    });

    it('uses default base timeouts', () => {
        const adapter = new CodexAdapter();
        assert.equal(adapter.timeouts.firstByteMs, 60000);
        assert.equal(adapter.timeouts.idleMs, 30000);
    });

    it('accepts custom timeouts', () => {
        const adapter = new CodexAdapter({ firstByteMs: 10000 });
        assert.equal(adapter.timeouts.firstByteMs, 10000);
    });
});

describe('CodexAdapter.parseChunk', () => {
    const adapter = new CodexAdapter();

    it('parses JSON finding line', () => {
        const chunk = JSON.stringify({
            type: 'finding',
            finding: { summary: 'Bug', file: 'a.js', line: 1 },
        });
        const events = adapter.parseChunk(chunk, 'sess-1');
        assert.ok(events.length > 0);
        assert.equal(events[0].event_type, 'finding');
    });

    it('parses JSON status line', () => {
        const chunk = JSON.stringify({ type: 'status', state: 'analyzing' });
        const events = adapter.parseChunk(chunk, 'sess-1');
        assert.ok(events.length > 0);
        assert.equal(events[0].event_type, 'status');
    });

    it('parses JSON error line', () => {
        const chunk = JSON.stringify({ type: 'error', message: 'Failed' });
        const events = adapter.parseChunk(chunk, 'sess-1');
        assert.ok(events.length > 0);
        assert.equal(events[0].event_type, 'error');
    });

    it('handles multi-line chunks', () => {
        const chunk = [
            JSON.stringify({ type: 'status', state: 'start' }),
            JSON.stringify({ type: 'finding', finding: { summary: 'A', file: 'b.js' } }),
        ].join('\n');

        const events = adapter.parseChunk(chunk, 'sess-1');
        assert.equal(events.length, 2);
    });

    it('emits progress for substantive non-JSON text', () => {
        const events = adapter.parseChunk('Analyzing src/server.js for vulnerabilities...', 'sess-1');
        assert.equal(events.length, 1);
        assert.equal(events[0].event_type, 'status');
        assert.equal(events[0].payload.state, 'progress');
    });

    it('silently skips progress bars', () => {
        const events = adapter.parseChunk('████████', 'sess-1');
        assert.equal(events.length, 0);
    });

    it('skips empty and short lines', () => {
        const events = adapter.parseChunk('\n  \n  hi\n', 'sess-1');
        // "hi" is only 2 chars, should be skipped
        assert.equal(events.length, 0);
    });

    it('handles empty chunk', () => {
        const events = adapter.parseChunk('', 'sess-1');
        assert.equal(events.length, 0);
    });
});

describe('CodexAdapter.parseResult', () => {
    const adapter = new CodexAdapter();

    it('extracts findings from JSON lines', () => {
        const output = [
            JSON.stringify({ summary: 'Null check missing', file: 'src/a.js', line: 10, severity: 'high' }),
            JSON.stringify({ summary: 'Unused import', file: 'src/b.js', line: 1, severity: 'low' }),
        ].join('\n');

        const findings = adapter.parseResult(output, 'sess-1');
        assert.equal(findings.length, 2);
        assert.equal(findings[0].severity, 'high');
        assert.equal(findings[0].summary, 'Null check missing');
        assert.equal(findings[1].severity, 'low');
    });

    it('handles finding wrapper object', () => {
        const output = JSON.stringify({
            type: 'finding',
            finding: { summary: 'Bug', file: 'x.js', severity: 'critical' },
        });

        const findings = adapter.parseResult(output, 'sess-1');
        assert.equal(findings.length, 1);
        assert.equal(findings[0].severity, 'critical');
    });

    it('skips non-finding JSON lines', () => {
        const output = [
            JSON.stringify({ type: 'status', state: 'done' }),
            JSON.stringify({ type: 'progress', percent: 50 }),
        ].join('\n');

        const findings = adapter.parseResult(output, 'sess-1');
        assert.equal(findings.length, 0);
    });

    it('skips non-JSON lines', () => {
        const output = 'This is just plain text\nNot JSON at all';
        const findings = adapter.parseResult(output, 'sess-1');
        assert.equal(findings.length, 0);
    });

    it('handles empty output', () => {
        const findings = adapter.parseResult('', 'sess-1');
        assert.equal(findings.length, 0);
    });

    it('uses message/description fallback fields', () => {
        const output = JSON.stringify({ message: 'Some issue', file: 'y.js' });
        const findings = adapter.parseResult(output, 'sess-1');
        assert.equal(findings.length, 1);
        assert.equal(findings[0].summary, 'Some issue');
    });

    it('defaults file to "unknown" when missing', () => {
        const output = JSON.stringify({ summary: 'No file given' });
        const findings = adapter.parseResult(output, 'sess-1');
        assert.equal(findings.length, 1);
        assert.equal(findings[0].file, 'unknown');
    });

    it('clamps confidence to 0-1 range', () => {
        const output = JSON.stringify({ summary: 'Test', file: 'a.js', confidence: 5.0 });
        const findings = adapter.parseResult(output, 'sess-1');
        assert.equal(findings[0].confidence, 1);
    });
});

describe('mapSeverity', () => {
    it('maps critical variants', () => {
        assert.equal(mapSeverity('critical'), 'critical');
        assert.equal(mapSeverity('error'), 'critical');
        assert.equal(mapSeverity('fatal'), 'critical');
        assert.equal(mapSeverity('CRITICAL'), 'critical');
    });

    it('maps high variants', () => {
        assert.equal(mapSeverity('high'), 'high');
        assert.equal(mapSeverity('warning'), 'high');
        assert.equal(mapSeverity('warn'), 'high');
    });

    it('maps medium variants', () => {
        assert.equal(mapSeverity('medium'), 'medium');
        assert.equal(mapSeverity('info'), 'medium');
        assert.equal(mapSeverity('note'), 'medium');
    });

    it('maps low variants', () => {
        assert.equal(mapSeverity('low'), 'low');
        assert.equal(mapSeverity('hint'), 'low');
        assert.equal(mapSeverity('suggestion'), 'low');
    });

    it('defaults to medium for unknown', () => {
        assert.equal(mapSeverity('unknown'), 'medium');
        assert.equal(mapSeverity(''), 'medium');
    });
});

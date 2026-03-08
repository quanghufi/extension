// @ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeAdapter, mapClaudeSeverity, CLAUDE_DEFAULTS } from './claude-adapter.js';

describe('ClaudeAdapter', () => {
    it('has agentId "claude-code"', () => {
        const adapter = new ClaudeAdapter();
        assert.equal(adapter.agentId, 'claude-code');
    });

    it('buildCommand returns correct cmd and args', () => {
        const adapter = new ClaudeAdapter();
        const { cmd, args } = adapter.buildCommand('/path/to/snapshot', 'Review this code');

        assert.equal(cmd, 'claude');
        assert.ok(args.includes('--output-format'));
        assert.ok(args.includes('json'));
        assert.ok(args.includes('--print'));
        assert.ok(args.includes('Review this code'));
    });

    it('uses Claude-specific extended timeouts by default', () => {
        const adapter = new ClaudeAdapter();
        assert.equal(adapter.timeouts.firstByteMs, CLAUDE_DEFAULTS.firstByteMs);
        assert.equal(adapter.timeouts.idleMs, CLAUDE_DEFAULTS.idleMs);
        assert.equal(adapter.timeouts.hardMs, CLAUDE_DEFAULTS.hardMs);
    });

    it('accepts custom timeout overrides', () => {
        const adapter = new ClaudeAdapter({ firstByteMs: 5000, idleMs: 3000 });
        assert.equal(adapter.timeouts.firstByteMs, 5000);
        assert.equal(adapter.timeouts.idleMs, 3000);
        // hardMs should still be Claude default
        assert.equal(adapter.timeouts.hardMs, CLAUDE_DEFAULTS.hardMs);
    });
});

describe('CLAUDE_DEFAULTS', () => {
    it('has extended firstByte timeout for MCP init', () => {
        assert.equal(CLAUDE_DEFAULTS.firstByteMs, 120000);
    });

    it('has extended idle timeout', () => {
        assert.equal(CLAUDE_DEFAULTS.idleMs, 45000);
    });

    it('has extended hard timeout', () => {
        assert.equal(CLAUDE_DEFAULTS.hardMs, 600000);
    });
});

describe('ClaudeAdapter.parseChunk', () => {
    const adapter = new ClaudeAdapter();

    it('detects JSON start and emits processing status', () => {
        const chunk = JSON.stringify({ result: [] });
        const events = adapter.parseChunk(chunk, 'sess-1');
        assert.ok(events.length > 0);
        const ev = events[0];
        assert.equal(ev.event_type, 'status');
        assert.equal(ev.payload.hasJson, true);
    });

    it('emits progress for plain text', () => {
        const events = adapter.parseChunk('Analyzing your code for issues...', 'sess-1');
        assert.equal(events.length, 1);
        assert.equal(events[0].event_type, 'status');
        assert.equal(events[0].payload.state, 'progress');
    });

    it('truncates long progress text to 500 chars', () => {
        const longText = 'A'.repeat(1000);
        const events = adapter.parseChunk(longText, 'sess-1');
        assert.equal(events.length, 1);
        assert.ok(events[0].payload.text.length <= 500);
    });

    it('skips empty chunks', () => {
        const events = adapter.parseChunk('   ', 'sess-1');
        assert.equal(events.length, 0);
    });

    it('handles incomplete JSON without crashing', () => {
        const events = adapter.parseChunk('{ "incomplete": true,', 'sess-1');
        // Should fall through to progress
        assert.ok(events.length >= 0);
    });
});

describe('ClaudeAdapter.parseResult (JSON mode)', () => {
    const adapter = new ClaudeAdapter();

    it('extracts findings from JSON array', () => {
        const output = JSON.stringify([
            { summary: 'Issue A', file: 'src/a.js', line: 10, severity: 'high' },
            { summary: 'Issue B', file: 'src/b.js', line: 20, severity: 'low' },
        ]);
        const findings = adapter.parseResult(output, 'sess-1');
        assert.equal(findings.length, 2);
        assert.equal(findings[0].summary, 'Issue A');
        assert.equal(findings[0].severity, 'high');
        assert.equal(findings[1].summary, 'Issue B');
    });

    it('extracts from { result: [...] } wrapper', () => {
        const output = JSON.stringify({
            result: [
                { summary: 'Bug', file: 'x.js', severity: 'critical' },
            ],
        });
        const findings = adapter.parseResult(output, 'sess-1');
        assert.equal(findings.length, 1);
        assert.equal(findings[0].severity, 'critical');
    });

    it('extracts from { findings: [...] } wrapper', () => {
        const output = JSON.stringify({
            findings: [
                { message: 'Warning', file: 'y.js' },
            ],
        });
        const findings = adapter.parseResult(output, 'sess-1');
        assert.equal(findings.length, 1);
        assert.equal(findings[0].summary, 'Warning');
    });

    it('extracts from { issues: [...] } wrapper', () => {
        const output = JSON.stringify({
            issues: [
                { title: 'Missing check', path: 'z.js', lineNumber: 5 },
            ],
        });
        const findings = adapter.parseResult(output, 'sess-1');
        assert.equal(findings.length, 1);
        assert.equal(findings[0].summary, 'Missing check');
        assert.equal(findings[0].file, 'z.js');
        assert.equal(findings[0].line, 5);
    });

    it('handles single finding object (not in array)', () => {
        const output = JSON.stringify({
            summary: 'Single issue',
            file: 'one.js',
            line: 1,
        });
        const findings = adapter.parseResult(output, 'sess-1');
        assert.equal(findings.length, 1);
    });

    it('returns empty array for JSON without findings', () => {
        const output = JSON.stringify({ status: 'ok', message: 'No issues found' });
        const findings = adapter.parseResult(output, 'sess-1');
        assert.equal(findings.length, 0);
    });

    it('skips null/non-object items in arrays', () => {
        const output = JSON.stringify([
            null,
            42,
            { summary: 'Real issue', file: 'a.js' },
        ]);
        const findings = adapter.parseResult(output, 'sess-1');
        assert.equal(findings.length, 1);
    });

    it('skips items without summary-like fields', () => {
        const output = JSON.stringify([
            { type: 'status', state: 'done' },
            { summary: 'Has summary', file: 'a.js' },
        ]);
        const findings = adapter.parseResult(output, 'sess-1');
        assert.equal(findings.length, 1);
    });

    it('handles various line number field names', () => {
        const output = JSON.stringify([
            { summary: 'A', file: 'a.js', line: 1 },
            { summary: 'B', file: 'b.js', lineNumber: 2 },
            { summary: 'C', file: 'c.js', line_number: 3 },
        ]);
        const findings = adapter.parseResult(output, 'sess-1');
        assert.equal(findings[0].line, 1);
        assert.equal(findings[1].line, 2);
        assert.equal(findings[2].line, 3);
    });
});

describe('ClaudeAdapter.parseResult (text fallback)', () => {
    const adapter = new ClaudeAdapter();

    it('extracts findings from file:line pattern', () => {
        const output = `
Here are the issues I found:
src/server.js:42 - Missing null check before access
src/utils.js:10 - Unused variable declaration
        `.trim();

        const findings = adapter.parseResult(output, 'sess-1');
        assert.ok(findings.length >= 2);
        assert.ok(findings.some((f) => f.file === 'src/server.js' && f.line === 42));
        assert.ok(findings.some((f) => f.file === 'src/utils.js' && f.line === 10));
    });

    it('text-extracted findings have lower confidence', () => {
        const output = 'src/a.js:1 - Some issue';
        const findings = adapter.parseResult(output, 'sess-1');
        assert.ok(findings.length > 0);
        assert.ok(findings[0].confidence < 0.5);
    });

    it('returns empty for text without file patterns', () => {
        const output = 'This code looks great! No issues found.';
        const findings = adapter.parseResult(output, 'sess-1');
        assert.equal(findings.length, 0);
    });

    it('handles empty output', () => {
        const findings = adapter.parseResult('', 'sess-1');
        assert.equal(findings.length, 0);
    });

    it('finds JSON in mixed output (text before JSON)', () => {
        const output = `
Analyzing code...
Processing files...
${JSON.stringify([{ summary: 'Found bug', file: 'main.js', line: 5 }])}
        `.trim();

        const findings = adapter.parseResult(output, 'sess-1');
        assert.ok(findings.length >= 1);
        assert.ok(findings.some((f) => f.summary === 'Found bug'));
    });
});

describe('mapClaudeSeverity', () => {
    it('maps critical variants', () => {
        assert.equal(mapClaudeSeverity('critical'), 'critical');
        assert.equal(mapClaudeSeverity('blocker'), 'critical');
        assert.equal(mapClaudeSeverity('severe'), 'critical');
        assert.equal(mapClaudeSeverity('p0'), 'critical');
    });

    it('maps high variants', () => {
        assert.equal(mapClaudeSeverity('high'), 'high');
        assert.equal(mapClaudeSeverity('major'), 'high');
        assert.equal(mapClaudeSeverity('important'), 'high');
        assert.equal(mapClaudeSeverity('p1'), 'high');
    });

    it('maps medium variants', () => {
        assert.equal(mapClaudeSeverity('medium'), 'medium');
        assert.equal(mapClaudeSeverity('moderate'), 'medium');
        assert.equal(mapClaudeSeverity('normal'), 'medium');
        assert.equal(mapClaudeSeverity('p2'), 'medium');
    });

    it('maps low variants', () => {
        assert.equal(mapClaudeSeverity('low'), 'low');
        assert.equal(mapClaudeSeverity('minor'), 'low');
        assert.equal(mapClaudeSeverity('trivial'), 'low');
        assert.equal(mapClaudeSeverity('nit'), 'low');
        assert.equal(mapClaudeSeverity('p3'), 'low');
        assert.equal(mapClaudeSeverity('p4'), 'low');
    });

    it('defaults to medium', () => {
        assert.equal(mapClaudeSeverity(''), 'medium');
        assert.equal(mapClaudeSeverity('unknown'), 'medium');
    });

    it('is case-insensitive', () => {
        assert.equal(mapClaudeSeverity('CRITICAL'), 'critical');
        assert.equal(mapClaudeSeverity('High'), 'high');
    });
});

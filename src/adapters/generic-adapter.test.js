// @ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    GenericAdapter,
    defaultSeverityMapper,
    defaultChunkParser,
    parseJsonOutput,
    parseTextOutput,
    extractFindingsFromArray,
    GENERIC_TIMEOUT_DEFAULTS,
} from './generic-adapter.js';

// ── Helper ───────────────────────────────────────────

/** @returns {import('./generic-adapter.js').GenericAdapterConfig} */
function makeConfig(overrides = {}) {
    return {
        agentId: 'test-agent',
        buildCommand: (snapshotPath, prompt) => ({
            cmd: 'test-cli',
            args: ['--check', snapshotPath, prompt],
        }),
        ...overrides,
    };
}

// ── GenericAdapter ───────────────────────────────────

describe('GenericAdapter', () => {
    it('requires agentId', () => {
        assert.throws(
            () => new GenericAdapter(/** @type {any} */ ({})),
            /requires config\.agentId/
        );
    });

    it('requires buildCommand function', () => {
        assert.throws(
            () => new GenericAdapter(/** @type {any} */ ({ agentId: 'x' })),
            /requires config\.buildCommand/
        );
    });

    it('sets agentId from config', () => {
        const adapter = new GenericAdapter(makeConfig());
        assert.equal(adapter.agentId, 'test-agent');
    });

    it('uses default timeouts when none provided', () => {
        const adapter = new GenericAdapter(makeConfig());
        assert.equal(adapter.timeouts.firstByteMs, GENERIC_TIMEOUT_DEFAULTS.firstByteMs);
        assert.equal(adapter.timeouts.idleMs, GENERIC_TIMEOUT_DEFAULTS.idleMs);
        assert.equal(adapter.timeouts.hardMs, GENERIC_TIMEOUT_DEFAULTS.hardMs);
    });

    it('accepts custom timeouts', () => {
        const adapter = new GenericAdapter(makeConfig({
            timeouts: { firstByteMs: 5000, idleMs: 2000 },
        }));
        assert.equal(adapter.timeouts.firstByteMs, 5000);
        assert.equal(adapter.timeouts.idleMs, 2000);
        assert.equal(adapter.timeouts.hardMs, GENERIC_TIMEOUT_DEFAULTS.hardMs);
    });

    it('buildCommand delegates to config', () => {
        const adapter = new GenericAdapter(makeConfig());
        const { cmd, args } = adapter.buildCommand('/snap', 'Do review');
        assert.equal(cmd, 'test-cli');
        assert.deepEqual(args, ['--check', '/snap', 'Do review']);
    });
});

describe('GenericAdapter.parseChunk', () => {
    it('uses default chunk parser when none configured', () => {
        const adapter = new GenericAdapter(makeConfig());
        const events = adapter.parseChunk('some progress text', 'sess-1');
        assert.equal(events.length, 1);
        assert.equal(events[0].payload.state, 'progress');
    });

    it('uses custom chunk parser when provided', () => {
        const adapter = new GenericAdapter(makeConfig({
            parseChunk: (_chunk, sessionId, agentId) => [{
                sessionId,
                agentId,
                type: 'status',
                payload: { state: 'custom' },
                ts: Date.now(),
            }],
        }));
        const events = adapter.parseChunk('data', 'sess-2');
        assert.equal(events.length, 1);
        assert.equal(events[0].payload.state, 'custom');
    });

    it('detects JSON in default parser', () => {
        const adapter = new GenericAdapter(makeConfig());
        const events = adapter.parseChunk('{"result": "ok"}', 'sess-3');
        assert.equal(events.length, 1);
        assert.equal(events[0].payload.state, 'processing');
        assert.equal(events[0].payload.hasJson, true);
    });

    it('ignores empty chunks', () => {
        const adapter = new GenericAdapter(makeConfig());
        const events = adapter.parseChunk('   ', 'sess-4');
        assert.equal(events.length, 0);
    });
});

describe('GenericAdapter.parseResult', () => {
    it('extracts findings from JSON array', () => {
        const adapter = new GenericAdapter(makeConfig());
        const output = JSON.stringify([
            { summary: 'Unused var', file: 'app.js', line: 10, severity: 'high' },
            { message: 'Missing return', path: 'lib.js', line: 5 },
        ]);
        const findings = adapter.parseResult(output, 'sess-5');
        assert.equal(findings.length, 2);
        assert.equal(findings[0].summary, 'Unused var');
        assert.equal(findings[0].severity, 'high');
        assert.equal(findings[1].summary, 'Missing return');
    });

    it('extracts findings from wrapped JSON object', () => {
        const adapter = new GenericAdapter(makeConfig());
        const output = JSON.stringify({
            results: [
                { summary: 'Bug', file: 'bug.js', line: 1 },
            ],
        });
        const findings = adapter.parseResult(output, 'sess-6');
        assert.equal(findings.length, 1);
        assert.equal(findings[0].summary, 'Bug');
    });

    it('falls back to text parsing when no JSON', () => {
        const adapter = new GenericAdapter(makeConfig());
        const output = 'src/index.js:42: Missing semicolon';
        const findings = adapter.parseResult(output, 'sess-7');
        assert.equal(findings.length, 1);
        assert.equal(findings[0].line, 42);
        assert.ok(findings[0].summary.includes('Missing semicolon'));
    });

    it('uses custom parseOutput when provided', () => {
        const adapter = new GenericAdapter(makeConfig({
            parseOutput: (_output, _sid, _root) => [{
                severity: 'critical',
                summary: 'Custom finding',
                evidence: '',
                file: 'custom.js',
                line: 1,
                confidence: 1.0,
            }],
        }));
        const findings = adapter.parseResult('anything', 'sess-8');
        assert.equal(findings.length, 1);
        assert.equal(findings[0].summary, 'Custom finding');
        assert.equal(findings[0].severity, 'critical');
    });

    it('uses custom severity mapper', () => {
        const adapter = new GenericAdapter(makeConfig({
            mapSeverity: (raw) => raw === 'danger' ? 'critical' : 'low',
        }));
        const output = JSON.stringify([
            { summary: 'Vuln', file: 'a.js', severity: 'danger' },
        ]);
        const findings = adapter.parseResult(output, 'sess-9');
        assert.equal(findings[0].severity, 'critical');
    });
});

// ── Utility Functions ────────────────────────────────

describe('defaultSeverityMapper', () => {
    it('maps critical variants', () => {
        for (const v of ['critical', 'blocker', 'severe', 'p0', 'error']) {
            assert.equal(defaultSeverityMapper(v), 'critical', `expected critical for ${v}`);
        }
    });

    it('maps high variants', () => {
        for (const v of ['high', 'major', 'important', 'p1', 'warning']) {
            assert.equal(defaultSeverityMapper(v), 'high', `expected high for ${v}`);
        }
    });

    it('maps medium variants', () => {
        for (const v of ['medium', 'moderate', 'normal', 'p2', 'info']) {
            assert.equal(defaultSeverityMapper(v), 'medium', `expected medium for ${v}`);
        }
    });

    it('maps low variants', () => {
        for (const v of ['low', 'minor', 'trivial', 'nit', 'p3', 'p4', 'style']) {
            assert.equal(defaultSeverityMapper(v), 'low', `expected low for ${v}`);
        }
    });

    it('defaults to medium for unknown', () => {
        assert.equal(defaultSeverityMapper('unknown'), 'medium');
        assert.equal(defaultSeverityMapper(''), 'medium');
    });
});

describe('parseJsonOutput', () => {
    const sev = defaultSeverityMapper;
    const root = '/project';

    it('parses JSON array', () => {
        const output = JSON.stringify([{ summary: 'Issue', file: 'a.js' }]);
        const findings = parseJsonOutput(output, 's1', root, sev);
        assert.equal(findings.length, 1);
    });

    it('parses wrapped JSON with "findings" key', () => {
        const output = JSON.stringify({ findings: [{ summary: 'Issue', file: 'b.js' }] });
        const findings = parseJsonOutput(output, 's2', root, sev);
        assert.equal(findings.length, 1);
    });

    it('parses wrapped JSON with "diagnostics" key', () => {
        const output = JSON.stringify({ diagnostics: [{ summary: 'Diag', file: 'c.js' }] });
        const findings = parseJsonOutput(output, 's3', root, sev);
        assert.equal(findings.length, 1);
    });

    it('handles NDJSON', () => {
        const output = [
            JSON.stringify({ summary: 'A', file: 'a.js' }),
            JSON.stringify({ summary: 'B', file: 'b.js' }),
        ].join('\n');
        const findings = parseJsonOutput(output, 's4', root, sev);
        assert.equal(findings.length, 2);
    });

    it('returns empty for non-JSON', () => {
        const findings = parseJsonOutput('just text', 's5', root, sev);
        assert.equal(findings.length, 0);
    });
});

describe('parseTextOutput', () => {
    const sev = defaultSeverityMapper;
    const root = '/project';

    it('extracts file:line: message pattern', () => {
        const output = 'src/app.js:10: Unused import\nsrc/lib.js:20: Missing type';
        const findings = parseTextOutput(output, 's1', root, sev);
        assert.equal(findings.length, 2);
        assert.equal(findings[0].line, 10);
        assert.equal(findings[1].line, 20);
    });

    it('extracts file:line:col: message pattern', () => {
        const output = 'src/app.js:10:5: Unexpected token';
        const findings = parseTextOutput(output, 's2', root, sev);
        assert.equal(findings.length, 1);
        assert.equal(findings[0].line, 10);
    });

    it('extracts numbered list pattern', () => {
        const output = '1. **Unused variable** in `utils.js`:15 - Remove dead code';
        const findings = parseTextOutput(output, 's3', root, sev);
        assert.ok(findings.length >= 1);
    });

    it('returns empty for no patterns', () => {
        const findings = parseTextOutput('looks good!', 's4', root, sev);
        assert.equal(findings.length, 0);
    });
});

describe('extractFindingsFromArray', () => {
    const sev = defaultSeverityMapper;
    const root = '/project';

    it('skips null and non-object items', () => {
        const items = [null, 'string', 42, { summary: 'Valid', file: 'a.js' }];
        const findings = extractFindingsFromArray(/** @type {any} */ (items), root, sev);
        assert.equal(findings.length, 1);
    });

    it('skips items without summary', () => {
        const items = [{ file: 'a.js' }, { summary: 'Valid', file: 'b.js' }];
        const findings = extractFindingsFromArray(items, root, sev);
        assert.equal(findings.length, 1);
    });

    it('handles alternative field names', () => {
        const item = {
            description: 'A description',
            filename: 'test.js',
            lineNumber: 42,
            level: 'high',
            details: 'Some details',
        };
        const findings = extractFindingsFromArray([item], root, sev);
        assert.equal(findings.length, 1);
        assert.equal(findings[0].summary, 'A description');
        assert.equal(findings[0].line, 42);
        assert.equal(findings[0].severity, 'high');
        assert.equal(findings[0].evidence, 'Some details');
    });

    it('handles nested start.line', () => {
        const item = {
            summary: 'Issue',
            file: 'nested.js',
            start: { line: 99 },
        };
        const findings = extractFindingsFromArray([item], root, sev);
        assert.equal(findings[0].line, 99);
    });

    it('clamps confidence to [0, 1]', () => {
        const items = [
            { summary: 'Over', file: 'a.js', confidence: 1.5 },
            { summary: 'Under', file: 'b.js', confidence: -0.5 },
        ];
        const findings = extractFindingsFromArray(items, root, sev);
        assert.equal(findings[0].confidence, 1);
        assert.equal(findings[1].confidence, 0);
    });
});

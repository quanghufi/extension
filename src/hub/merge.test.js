// @ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MergeEngine } from './merge.js';
import { createFinding } from '../schema/events.js';

// ── Helpers ──────────────────────────────────────────

/** Create a finding with minimal required fields */
function makeFinding(overrides = {}) {
    return createFinding({
        severity: 'medium',
        summary: 'Test finding summary',
        evidence: 'some evidence',
        file: 'src/app.js',
        line: 10,
        ...overrides,
    });
}

// ── Constructor ──────────────────────────────────────

describe('MergeEngine constructor', () => {
    it('uses default options', () => {
        const engine = new MergeEngine();
        assert.equal(engine.threshold, 0.7);
        assert.equal(engine.lineTolerance, 3);
        assert.equal(engine.severityStrategy, 'highest');
    });

    it('accepts custom options', () => {
        const engine = new MergeEngine({ threshold: 0.5, lineTolerance: 5 });
        assert.equal(engine.threshold, 0.5);
        assert.equal(engine.lineTolerance, 5);
    });
});

// ── Empty / Single Input ─────────────────────────────

describe('MergeEngine edge cases', () => {
    it('handles empty array', () => {
        const engine = new MergeEngine();
        const result = engine.merge([]);
        assert.deepEqual(result.merged, []);
        assert.deepEqual(result.stats, { total: 0, merged: 0, unique: 0, conflicts: 0 });
    });

    it('handles null input', () => {
        const engine = new MergeEngine();
        const result = engine.merge(null);
        assert.equal(result.stats.total, 0);
    });

    it('single finding passes through', () => {
        const engine = new MergeEngine();
        const f = makeFinding();
        const result = engine.merge([f]);
        assert.equal(result.merged.length, 1);
        assert.equal(result.stats.total, 1);
        assert.equal(result.stats.merged, 0);
        assert.equal(result.stats.unique, 1);
        assert.equal(result.merged[0].confidence, 1.0);
        assert.equal(result.merged[0].sources.length, 1);
    });
});

// ── Exact Dedup ──────────────────────────────────────

describe('MergeEngine exact dedup', () => {
    it('merges findings with identical dedupe_key', () => {
        const engine = new MergeEngine();
        const f1 = makeFinding({ summary: 'missing null check', file: 'src/app.js', line: 10 });
        const f2 = makeFinding({ summary: 'missing null check', file: 'src/app.js', line: 10 });

        const agentMap = new Map([
            [f1.id, 'codex'],
            [f2.id, 'semgrep'],
        ]);

        const result = engine.merge([f1, f2], agentMap);
        assert.equal(result.stats.unique, 1);
        assert.equal(result.stats.merged, 1);
        assert.equal(result.merged[0].sources.length, 2);
        assert.deepEqual(result.merged[0].agents, ['semgrep', 'codex']);
        assert.equal(result.merged[0].confidence, 1.0);
    });
});

// ── Fuzzy Match ──────────────────────────────────────

describe('MergeEngine fuzzy match', () => {
    it('merges similar summaries on same file and close line', () => {
        const engine = new MergeEngine({ threshold: 0.5 });
        const f1 = makeFinding({
            summary: 'missing null check in handler',
            file: 'src/handler.js',
            line: 10,
        });
        const f2 = makeFinding({
            summary: 'null check missing from handler',
            file: 'src/handler.js',
            line: 12, // within tolerance of 3
        });

        const agentMap = new Map([
            [f1.id, 'codex'],
            [f2.id, 'semgrep'],
        ]);

        const result = engine.merge([f1, f2], agentMap);
        assert.equal(result.stats.unique, 1);
        assert.equal(result.stats.merged, 1);
        assert.deepEqual(result.merged[0].agents, ['semgrep', 'codex']);
    });

    it('does NOT merge different files', () => {
        const engine = new MergeEngine();
        const f1 = makeFinding({ summary: 'null check', file: 'src/a.js', line: 10 });
        const f2 = makeFinding({ summary: 'null check', file: 'src/b.js', line: 10 });

        const result = engine.merge([f1, f2]);
        assert.equal(result.stats.unique, 2);
        assert.equal(result.stats.merged, 0);
    });

    it('does NOT merge distant lines', () => {
        const engine = new MergeEngine({ lineTolerance: 3 });
        const f1 = makeFinding({ summary: 'null check issue', file: 'src/app.js', line: 10 });
        const f2 = makeFinding({ summary: 'null check issue', file: 'src/app.js', line: 20 });

        const result = engine.merge([f1, f2]);
        assert.equal(result.stats.unique, 2);
    });

    it('merges when both lines are null', () => {
        const engine = new MergeEngine();
        const f1 = makeFinding({ summary: 'global config issue', file: 'config.js', line: null });
        const f2 = makeFinding({ summary: 'global config issue', file: 'config.js', line: null });

        const result = engine.merge([f1, f2]);
        assert.equal(result.stats.unique, 1);
    });

    it('does NOT merge dissimilar summaries', () => {
        const engine = new MergeEngine();
        const f1 = makeFinding({ summary: 'SQL injection vulnerability', file: 'src/app.js', line: 10 });
        const f2 = makeFinding({ summary: 'missing CORS headers', file: 'src/app.js', line: 10 });

        const result = engine.merge([f1, f2]);
        assert.equal(result.stats.unique, 2);
    });
});

// ── Severity Resolution ──────────────────────────────

describe('MergeEngine severity resolution', () => {
    it('resolves to highest severity (high > medium)', () => {
        const engine = new MergeEngine();
        const f1 = makeFinding({ summary: 'null check issue', severity: 'medium', file: 'src/app.js', line: 10 });
        const f2 = makeFinding({ summary: 'null check issue', severity: 'high', file: 'src/app.js', line: 10 });

        const agentMap = new Map([
            [f1.id, 'codex'],
            [f2.id, 'semgrep'],
        ]);

        const result = engine.merge([f1, f2], agentMap);
        assert.equal(result.stats.unique, 1);
        assert.equal(result.stats.conflicts, 1);
        assert.equal(result.merged[0].severity, 'high');
    });

    it('resolves critical > high', () => {
        const engine = new MergeEngine();
        const f1 = makeFinding({ summary: 'XSS attack vector', severity: 'high', file: 'src/form.js', line: 5 });
        const f2 = makeFinding({ summary: 'XSS attack vector', severity: 'critical', file: 'src/form.js', line: 5 });

        const result = engine.merge([f1, f2]);
        assert.equal(result.merged[0].severity, 'critical');
    });

    it('no conflict when severities match', () => {
        const engine = new MergeEngine();
        const f1 = makeFinding({ summary: 'same issue here', severity: 'low', file: 'src/app.js', line: 1 });
        const f2 = makeFinding({ summary: 'same issue here', severity: 'low', file: 'src/app.js', line: 1 });

        const result = engine.merge([f1, f2]);
        assert.equal(result.stats.conflicts, 0);
    });
});

// ── Multi-agent ──────────────────────────────────────

describe('MergeEngine multi-agent', () => {
    it('tracks agents correctly for 3-way merge', () => {
        const engine = new MergeEngine();
        const f1 = makeFinding({ summary: 'auth bypass', file: 'src/auth.js', line: 20 });
        const f2 = makeFinding({ summary: 'auth bypass', file: 'src/auth.js', line: 20 });
        const f3 = makeFinding({ summary: 'auth bypass', file: 'src/auth.js', line: 20 });

        const agentMap = new Map([
            [f1.id, 'codex'],
            [f2.id, 'semgrep'],
            [f3.id, 'eslint'],
        ]);

        const result = engine.merge([f1, f2, f3], agentMap);
        assert.equal(result.stats.unique, 1);
        assert.equal(result.stats.merged, 2);
        assert.equal(result.merged[0].sources.length, 3);
        assert.deepEqual(result.merged[0].agents, ['semgrep', 'codex', 'eslint']);
    });

    it('works without agent map', () => {
        const engine = new MergeEngine();
        const f1 = makeFinding({ summary: 'same bug', file: 'src/x.js', line: 5 });
        const f2 = makeFinding({ summary: 'same bug', file: 'src/x.js', line: 5 });

        const result = engine.merge([f1, f2]);
        assert.equal(result.stats.unique, 1);
        assert.deepEqual(result.merged[0].agents, []);
    });
});

// ── Summary selection ────────────────────────────────

describe('MergeEngine summary selection', () => {
    it('keeps longest summary as representative', () => {
        // Use summaries with high token overlap but different length
        const f1 = makeFinding({
            summary: 'missing null check handler',
            file: 'src/app.js',
            line: 10,
        });
        const f2 = makeFinding({
            summary: 'missing null check handler in request processing pipeline',
            file: 'src/app.js',
            line: 10,
        });

        // Tokens f1: {missing, null, check, handler}
        // Tokens f2: {missing, null, check, handler, in, request, processing, pipeline}
        // Intersection: 4, Union: 8, J = 0.5
        const engine = new MergeEngine({ threshold: 0.4 });
        const result = engine.merge([f1, f2]);
        assert.equal(result.stats.unique, 1);
        assert.ok(
            result.merged[0].summary.includes('pipeline'),
            'Expected longer summary to be representative'
        );
    });
});

// ── Output format ────────────────────────────────────

describe('MergeEngine output format', () => {
    it('merged finding has correct structure', () => {
        const engine = new MergeEngine();
        const f = makeFinding();
        const result = engine.merge([f]);
        const m = result.merged[0];

        assert.ok(m.id.startsWith('M-'));
        assert.equal(typeof m.file, 'string');
        assert.equal(typeof m.severity, 'string');
        assert.equal(typeof m.summary, 'string');
        assert.ok(Array.isArray(m.agents));
        assert.ok(Array.isArray(m.sources));
        assert.equal(typeof m.confidence, 'number');
        assert.equal(typeof m.dedupe_key, 'string');
    });

    it('deterministic — same input produces same structure', () => {
        const engine = new MergeEngine();
        const findings = [
            makeFinding({ summary: 'issue A', file: 'a.js', line: 1 }),
            makeFinding({ summary: 'issue B', file: 'b.js', line: 2 }),
        ];
        const r1 = engine.merge(findings);
        const r2 = engine.merge(findings);
        assert.equal(r1.stats.unique, r2.stats.unique);
        assert.equal(r1.stats.merged, r2.stats.merged);
    });
});

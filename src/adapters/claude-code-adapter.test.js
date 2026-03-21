// @ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ClaudeCodeAdapter, CLAUDE_TIMEOUTS } from './claude-code-adapter.js';
import {
    buildReviewPrompt,
    parseStreamLine,
    parseClaudeResult,
    mapSeverity,
} from './claude-code-parsing.js';

// ── ClaudeCodeAdapter ────────────────────────────────

describe('ClaudeCodeAdapter', () => {
    it('has correct agentId', () => {
        const adapter = new ClaudeCodeAdapter();
        assert.equal(adapter.agentId, 'claude-code');
    });

    it('has generous default timeouts', () => {
        const adapter = new ClaudeCodeAdapter();
        assert.equal(adapter.timeouts.firstByteMs, CLAUDE_TIMEOUTS.firstByteMs);
        assert.equal(adapter.timeouts.idleMs, CLAUDE_TIMEOUTS.idleMs);
        assert.equal(adapter.timeouts.hardMs, CLAUDE_TIMEOUTS.hardMs);
    });

    it('allows custom timeouts', () => {
        const adapter = new ClaudeCodeAdapter({ firstByteMs: 1000 });
        assert.equal(adapter.timeouts.firstByteMs, 1000);
        assert.equal(adapter.timeouts.idleMs, CLAUDE_TIMEOUTS.idleMs);
    });

    it('buildCommand returns claude CLI with stream-json', () => {
        const adapter = new ClaudeCodeAdapter();
        const { cmd, args, stdinText } = adapter.buildCommand('/snap', 'Review this code');
        assert.equal(cmd, 'claude');
        assert.ok(args.includes('-p'));
        assert.ok(args.includes('--output-format'));
        assert.ok(args.includes('stream-json'));
        assert.ok(args.includes('--verbose'));
        assert.equal(args[args.indexOf('-p') + 1], '-');
        assert.equal(typeof stdinText, 'string');
        assert.match(stdinText, /Review this code/);
    });

    it('parseChunk handles multi-line chunks', () => {
        const adapter = new ClaudeCodeAdapter();
        const chunk = [
            JSON.stringify({ type: 'system', subtype: 'init' }),
            JSON.stringify({ type: 'assistant', content: [{ type: 'text', text: 'Found issue' }] }),
        ].join('\n');

        const events = adapter.parseChunk(chunk, 'sess-1');
        assert.equal(events.length, 1);
        assert.equal(events[0].event_type, 'status');
        assert.equal(events[0].payload.state, 'agent_message');
    });

    it('parseResult delegates to parseClaudeResult', () => {
        const adapter = new ClaudeCodeAdapter();
        const output = JSON.stringify({
            type: 'result',
            subtype: 'success',
            result: JSON.stringify([
                { summary: 'Bug found', evidence: 'Missing null check', severity: 'high', file: 'app.js' },
            ]),
        });
        const findings = adapter.parseResult(output, 'sess-1');
        assert.ok(findings.length >= 1);
        assert.equal(findings[0].summary, 'Bug found');
    });
});

// ── buildReviewPrompt ────────────────────────────────

describe('buildReviewPrompt', () => {
    it('includes review instructions', () => {
        const prompt = buildReviewPrompt('Check for bugs');
        assert.ok(prompt.includes('Check for bugs'));
        assert.ok(prompt.includes('JSON array'));
        assert.ok(prompt.includes('severity'));
        assert.ok(prompt.includes('why_it_matters'));
        assert.ok(prompt.includes('fix_instructions'));
        assert.match(prompt, /dedupeKey/i);
    });

    it('adds scope guardrails consistent with codex', () => {
        const prompt = buildReviewPrompt('Review only src/http-utils.js');
        assert.match(prompt, /Review only src\/http-utils\.js/);
        assert.match(prompt, /Do not inspect git diff, git history, or unrelated files/i);
        assert.match(prompt, /You may inspect other files only if needed/i);
    });

    it('includes context snippet when provided', () => {
        const prompt = buildReviewPrompt('Review', 'const x = 1;');
        assert.ok(prompt.includes('const x = 1;'));
        assert.ok(prompt.includes('Code Context'));
    });
});

// ── parseStreamLine ──────────────────────────────────

describe('parseStreamLine', () => {
    it('parses system init event', () => {
        const events = parseStreamLine(
            JSON.stringify({ type: 'system', subtype: 'init' }),
            'sess-1', 'claude-code',
        );
        assert.deepEqual(events, []);
    });

    it('parses assistant message with content array', () => {
        const events = parseStreamLine(
            JSON.stringify({
                type: 'assistant',
                content: [{ type: 'text', text: 'Found a bug on line 5' }],
            }),
            'sess-1', 'claude-code',
        );
        assert.equal(events.length, 1); // agent_message only (raw_output removed to avoid duplication)
        assert.equal(events[0].event_type, 'status');
        assert.equal(events[0].payload.state, 'agent_message');
        assert.ok(events[0].payload.text.includes('bug'));
    });

    it('parses result event', () => {
        const events = parseStreamLine(
            JSON.stringify({
                type: 'result', subtype: 'success',
                result: 'All good', duration_ms: 1500,
            }),
            'sess-1', 'claude-code',
        );
        assert.deepEqual(events, []);
    });

    it('ignores empty and non-JSON lines', () => {
        assert.deepEqual(parseStreamLine('', 's', 'a'), []);
        assert.deepEqual(parseStreamLine('not json', 's', 'a'), []);
        assert.deepEqual(parseStreamLine('  \n  ', 's', 'a'), []);
    });

    it('handles error result', () => {
        const events = parseStreamLine(
            JSON.stringify({ type: 'result', subtype: 'error', is_error: true }),
            'sess-1', 'claude-code',
        );
        assert.deepEqual(events, []);
    });
});

// ── parseClaudeResult ────────────────────────────────

describe('parseClaudeResult', () => {
    it('extracts findings from JSON array in result', () => {
        const output = JSON.stringify({
            type: 'result', subtype: 'success',
            result: JSON.stringify([
                {
                    summary: 'SQL Injection',
                    evidence: 'Use parameterized queries',
                    why_it_matters: 'An attacker can exfiltrate arbitrary rows.',
                    fix_instructions: 'Replace string interpolation with parameterized queries.',
                    severity: 'critical',
                    file: 'db.js',
                    line: 42,
                    confidence: 0.95,
                },
                { summary: 'Missing null check', evidence: 'Check before access', severity: 'medium', file: 'utils.js' },
            ]),
        });
        const findings = parseClaudeResult(output, 'sess-1');
        assert.equal(findings.length, 2);
        assert.equal(findings[0].summary, 'SQL Injection');
        assert.equal(findings[0].severity, 'critical');
        assert.equal(findings[0].file, 'db.js');
        assert.equal(findings[0].line, 42);
        assert.equal(findings[0].why_it_matters, 'An attacker can exfiltrate arbitrary rows.');
        assert.equal(findings[0].fix_instructions, 'Replace string interpolation with parameterized queries.');
        assert.equal(findings[0].confidence, 0.95);
        assert.equal(findings[1].severity, 'medium');
    });

    it('extracts findings from ```json code block in result', () => {
        const resultText = 'Here are my findings:\n```json\n[{"summary":"XSS vulnerability","evidence":"Sanitize user input","why_it_matters":"Attackers can run script in other users browsers.","fix_instructions":"Escape or sanitize user-controlled HTML before rendering.","severity":"high","file":"views.js"}]\n```\nPlease fix these.';
        const output = JSON.stringify({
            type: 'result', subtype: 'success', result: resultText,
        });
        const findings = parseClaudeResult(output, 'sess-1');
        assert.equal(findings.length, 1);
        assert.equal(findings[0].summary, 'XSS vulnerability');
        assert.equal(findings[0].severity, 'high');
        assert.equal(findings[0].why_it_matters, 'Attackers can run script in other users browsers.');
        assert.equal(findings[0].fix_instructions, 'Escape or sanitize user-controlled HTML before rendering.');
    });

    it('maps remediation aliases from Claude-style fields', () => {
        const output = JSON.stringify({
            type: 'result', subtype: 'success',
            result: JSON.stringify([
                {
                    title: 'Leaky timer on retry path',
                    detail: 'The timer is never cleared when the promise resolves.',
                    impact: 'Long-lived processes accumulate dangling timers.',
                    recommendation: 'Clear the timer in both success and error paths.',
                    severity: 'high',
                    file: 'retry.js',
                    line: 18,
                },
            ]),
        });

        const findings = parseClaudeResult(output, 'sess-1');
        assert.equal(findings.length, 1);
        assert.equal(findings[0].summary, 'Leaky timer on retry path');
        assert.equal(findings[0].why_it_matters, 'Long-lived processes accumulate dangling timers.');
        assert.equal(findings[0].fix_instructions, 'Clear the timer in both success and error paths.');
        assert.equal(findings[0].evidence, 'The timer is never cleared when the promise resolves.');
    });

    it('preserves explicit dedupeKey during disputed rebuttal parsing', () => {
        const output = JSON.stringify({
            type: 'result', subtype: 'success',
            result: [
                'Looking at each disputed finding carefully.',
                '```json',
                JSON.stringify([
                    {
                        dedupeKey: 'abc123samefinding',
                        summary: 'Renamed wording for the same disputed issue',
                        evidence: 'Still the same bug after re-review.',
                        why_it_matters: 'Requests can still hang.',
                        fix_instructions: 'Reject on error and abort.',
                        severity: 'high',
                        file: 'src/http-utils.js',
                        line: 21,
                        confidence: 'high',
                    },
                ], null, 2),
                '```',
            ].join('\n'),
        });

        const findings = parseClaudeResult(output, 'sess-1');
        assert.equal(findings.length, 1);
        assert.equal(findings[0].dedupe_key, 'abc123samefinding');
        assert.equal(findings[0].confidence, 0.9);
        assert.equal(findings[0].summary, 'Renamed wording for the same disputed issue');
    });

    it('extracts findings from object wrapper with findings array', () => {
        const output = JSON.stringify({
            type: 'result', subtype: 'success',
            result: JSON.stringify({
                status: 'has_findings',
                findings: [
                    {
                        summary: 'Wrapper format issue',
                        evidence: 'Returned under findings key.',
                        why_it_matters: 'Parser must not drop it.',
                        fix_instructions: 'Parse object wrappers too.',
                        severity: 'medium',
                        file: 'src/http-utils.js',
                        line: 23,
                        confidence: 'medium',
                    },
                ],
            }),
        });

        const findings = parseClaudeResult(output, 'sess-1');
        assert.equal(findings.length, 1);
        assert.equal(findings[0].summary, 'Wrapper format issue');
        assert.equal(findings[0].confidence, 0.6);
    });

    it('falls back to single summary finding for non-JSON text', () => {
        const output = JSON.stringify({
            type: 'result', subtype: 'success',
            result: 'I found several issues with error handling in the authentication module. The password comparison is done using == instead of a constant-time comparison function.',
        });
        const findings = parseClaudeResult(output, 'sess-1');
        assert.equal(findings.length, 1);
        assert.equal(findings[0].summary, 'Claude Code Review Summary');
        assert.ok(findings[0].evidence.includes('password comparison'));
    });

    it('returns empty array when no findings', () => {
        const output = JSON.stringify({
            type: 'result', subtype: 'success',
            result: '[]',
        });
        const findings = parseClaudeResult(output, 'sess-1');
        assert.equal(findings.length, 0);
    });

    it('returns empty for "no issues" text', () => {
        const output = JSON.stringify({
            type: 'result', subtype: 'success',
            result: 'No issues found.',
        });
        const findings = parseClaudeResult(output, 'sess-1');
        assert.equal(findings.length, 0);
    });

    it('extracts from assistant messages as fallback', () => {
        const lines = [
            JSON.stringify({ type: 'assistant', content: [{ type: 'text', text: '```json\n[{"summary":"Race condition","evidence":"Lock needed","severity":"high","file":"worker.js"}]\n```' }] }),
            JSON.stringify({ type: 'result', subtype: 'success', result: 'Review complete' }),
        ].join('\n');
        const findings = parseClaudeResult(lines, 'sess-1');
        assert.equal(findings.length, 1);
        assert.equal(findings[0].summary, 'Race condition');
    });
});

// ── mapSeverity ──────────────────────────────────────

describe('mapSeverity', () => {
    it('maps known severity strings', () => {
        assert.equal(mapSeverity('critical'), 'critical');
        assert.equal(mapSeverity('error'), 'critical');
        assert.equal(mapSeverity('high'), 'high');
        assert.equal(mapSeverity('major'), 'high');
        assert.equal(mapSeverity('medium'), 'medium');
        assert.equal(mapSeverity('low'), 'low');
        assert.equal(mapSeverity('suggestion'), 'low');
        assert.equal(mapSeverity('info'), 'low');
    });

    it('defaults to medium', () => {
        assert.equal(mapSeverity(undefined), 'medium');
        assert.equal(mapSeverity('unknown'), 'medium');
    });

    it('handles case-insensitive input', () => {
        assert.equal(mapSeverity('CRITICAL'), 'critical');
        assert.equal(mapSeverity('High'), 'high');
    });
});

// ── Registry Integration ─────────────────────────────

describe('adapter-registry integration', () => {
    it('getAdapter returns claude-code adapter', async () => {
        const { getAdapter } = await import('./adapter-registry.js');
        const adapter = getAdapter('claude-code');
        assert.ok(adapter);
        assert.equal(adapter.agentId, 'claude-code');
    });

    it('listAdapters includes claude-code', async () => {
        const { listAdapters } = await import('./adapter-registry.js');
        const list = listAdapters();
        assert.ok(list.includes('claude-code'));
    });
});

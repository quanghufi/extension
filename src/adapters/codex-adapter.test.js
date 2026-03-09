// @ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CodexAdapter, mapSeverity } from './codex-adapter.js';

describe('CodexAdapter', () => {
    it('has agentId "codex"', () => {
        const adapter = new CodexAdapter();
        assert.equal(adapter.agentId, 'codex');
    });

    it('buildCommand returns current codex exec review args', () => {
        const adapter = new CodexAdapter();
        const { cmd, args } = adapter.buildCommand('/path/to/snapshot', 'Review this code');

        assert.equal(cmd, 'codex');
        assert.deepEqual(args.slice(0, 4), ['exec', 'review', '--skip-git-repo-check', '--json']);
        assert.match(args[4], /Return the final answer as a JSON array only\./);
        assert.match(args[4], /Review this code/);
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

    it('parses command start event from exec jsonl', () => {
        const chunk = JSON.stringify({
            type: 'item.started',
            item: { type: 'command_execution', command: 'git diff --name-only' },
        });

        const events = adapter.parseChunk(chunk, 'sess-1');
        assert.equal(events.length, 1);
        assert.equal(events[0].event_type, 'status');
        assert.equal(events[0].payload.state, 'command_started');
    });

    it('parses agent message event from exec jsonl', () => {
        const chunk = JSON.stringify({
            type: 'item.completed',
            item: { type: 'agent_message', text: '[{"summary":"Bug","file":"a.js"}]' },
        });

        const events = adapter.parseChunk(chunk, 'sess-1');
        assert.equal(events.length, 1);
        assert.equal(events[0].event_type, 'status');
        assert.equal(events[0].payload.state, 'agent_message');
    });

    it('parses plain text fallback as progress', () => {
        const events = adapter.parseChunk('Analyzing changed files...', 'sess-1');
        assert.equal(events.length, 1);
        assert.equal(events[0].event_type, 'status');
        assert.equal(events[0].payload.state, 'progress');
    });

    it('silently skips progress bars', () => {
        const events = adapter.parseChunk('¦¦¦¦¦¦¦¦', 'sess-1');
        assert.equal(events.length, 0);
    });
});

describe('CodexAdapter.parseResult', () => {
    const adapter = new CodexAdapter();

    it('extracts findings from final agent_message JSON array', () => {
        const output = [
            JSON.stringify({ type: 'thread.started', thread_id: 't1' }),
            JSON.stringify({
                type: 'item.completed',
                item: {
                    type: 'agent_message',
                    text: JSON.stringify([
                        {
                            summary: 'Null check missing',
                            file: 'src/a.js',
                            line: 10,
                            severity: 'high',
                            confidence: 0.9,
                        },
                    ]),
                },
            }),
        ].join('\n');

        const findings = adapter.parseResult(output, 'sess-1');
        assert.equal(findings.length, 1);
        assert.equal(findings[0].summary, 'Null check missing');
        assert.equal(findings[0].severity, 'high');
        assert.equal(findings[0].file, 'src/a.js');
        assert.equal(findings[0].line, 10);
    });

    it('returns empty array when final message is not structured json', () => {
        const output = JSON.stringify({
            type: 'item.completed',
            item: { type: 'agent_message', text: 'Hello world' },
        });

        const findings = adapter.parseResult(output, 'sess-1');
        assert.equal(findings.length, 0);
    });

    it('clamps confidence to 0-1 range', () => {
        const output = JSON.stringify({
            type: 'item.completed',
            item: {
                type: 'agent_message',
                text: JSON.stringify([{ summary: 'Test', file: 'a.js', confidence: 5 }]),
            },
        });

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

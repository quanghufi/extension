// @ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CodexAdapter, mapSeverity } from './codex-adapter.js';
import { formatReviewPrompt, DEBATE_PROMPT_MARKER } from './codex-adapter-parsing.js';

describe('CodexAdapter', () => {
    it('has agentId "codex"', () => {
        const adapter = new CodexAdapter();
        assert.equal(adapter.agentId, 'codex');
    });

    it('buildCommand returns current codex exec args', () => {
        const adapter = new CodexAdapter();
        const { cmd, args } = adapter.buildCommand('/path/to/snapshot', 'Review this code');

        assert.equal(cmd, 'codex');
        assert.deepEqual(args.slice(0, 2), ['exec', '--json']);
        assert.deepEqual(args.slice(2, 4), ['--sandbox', 'danger-full-access']);
        assert.equal(args[4], '--output-schema');
        assert.match(args[5], /codex-review-schema\.json$/);
        assert.equal(args[6], '-');
    });

    it('sends the formatted prompt through stdin instead of the command line', () => {
        const adapter = new CodexAdapter();
        const { stdinText } = adapter.buildCommand('/path/to/snapshot', 'Review this code');

        assert.equal(typeof stdinText, 'string');
        assert.match(stdinText, /Review this code/);
        assert.match(stdinText, /Return the final answer as a JSON object/i);
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

describe('formatReviewPrompt', () => {
    it('adds strict scope guardrails for focused file review', () => {
        const prompt = formatReviewPrompt('Review only src/http-utils.js');
        assert.match(prompt, /Review only src\/http-utils\.js/);
        assert.match(prompt, /Do not inspect git diff, git history, or unrelated files/i);
        assert.match(prompt, /You may inspect other files only if needed/i);
        assert.match(prompt, /Return the final answer as a JSON object/i);
        assert.match(prompt, /status, summary, findings, fix_plan, rerun_review/i);
    });

    it('skips wrapping when prompt contains DEBATE_PROMPT_MARKER (no double-wrap)', () => {
        const debatePrompt = 'Review the disputed findings. Return a JSON array.\n__DEBATE_PROMPT__';
        const result = formatReviewPrompt(debatePrompt);
        assert.equal(result, debatePrompt);
        assert.doesNotMatch(result, /Return the final answer as a JSON object/);
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

    it('extracts findings from codex schema object wrapper', () => {
        const output = JSON.stringify({
            type: 'item.completed',
            item: {
                type: 'agent_message',
                text: JSON.stringify({
                    status: 'has_findings',
                    summary: 'Found one issue',
                    findings: [
                        {
                            title: 'Null check missing',
                            why_it_matters: 'Can crash production requests.',
                            file: 'src/a.js',
                            line: 10,
                            severity: 'high',
                            fix_instructions: 'Add a null check.',
                            confidence: 'high',
                        },
                    ],
                    fix_plan: ['Add null check'],
                    rerun_review: false,
                }),
            },
        });

        const findings = adapter.parseResult(output, 'sess-1');
        assert.equal(findings.length, 1);
        assert.equal(findings[0].summary, 'Null check missing');
        assert.equal(findings[0].why_it_matters, 'Can crash production requests.');
        assert.equal(findings[0].fix_instructions, 'Add a null check.');
        assert.equal(findings[0].confidence, 0.9);
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

    it('maps title/body/findings strings from codex real-world output', () => {
        const output = JSON.stringify({
            type: 'item.completed',
            item: {
                type: 'agent_message',
                text: JSON.stringify([
                    {
                        title: 'Request body hangs forever on abort',
                        body: 'Promise only resolves on end and never rejects on abort/error.',
                        severity: 'high',
                        file: 'src/http-utils.js',
                        line: 20,
                        confidence: 'high',
                        fix_instructions: 'Reject on error and aborted.',
                        why_it_matters: 'Routes can hang forever.',
                    },
                ]),
            },
        });

        const findings = adapter.parseResult(output, 'sess-1');
        assert.equal(findings.length, 1);
        assert.equal(findings[0].summary, 'Request body hangs forever on abort');
        assert.equal(findings[0].evidence, 'Promise only resolves on end and never rejects on abort/error.');
        assert.equal(findings[0].confidence, 0.9);
        assert.equal(findings[0].fix_instructions, 'Reject on error and aborted.');
        assert.equal(findings[0].why_it_matters, 'Routes can hang forever.');
    });

    it('extracts adjudication findings from summary when schema wrapper has empty findings', () => {
        const output = JSON.stringify({
            type: 'item.completed',
            item: {
                type: 'agent_message',
                text: JSON.stringify({
                    status: 'has_findings',
                    summary: JSON.stringify([
                        {
                            dedupeKey: 'unbounded_body_read',
                            rationale: 'The body reader still has no maximum size limit.',
                        },
                    ]),
                    findings: [],
                    fix_plan: [],
                    rerun_review: false,
                }),
            },
        });

        const findings = adapter.parseResult(output, 'sess-1');
        assert.equal(findings.length, 1);
        assert.equal(findings[0].dedupe_key, 'unbounded_body_read');
        assert.equal(findings[0].summary, 'unbounded_body_read');
        assert.match(findings[0].evidence, /maximum size limit/i);
    });

    it('preserves explicit dedupeKey for minimal rebuttal adjudication items', () => {
        const output = JSON.stringify({
            type: 'item.completed',
            item: {
                type: 'agent_message',
                text: JSON.stringify([
                    {
                        dedupeKey: 'f234f4172055c6b9',
                        rationale: 'The request can still hang forever on abort.',
                    },
                ]),
            },
        });

        const findings = adapter.parseResult(output, 'sess-1');
        assert.equal(findings.length, 1);
        assert.equal(findings[0].dedupe_key, 'f234f4172055c6b9');
        assert.equal(findings[0].summary, 'f234f4172055c6b9');
        assert.match(findings[0].evidence, /hang forever on abort/i);
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

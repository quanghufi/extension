// @ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
    DebateReducer,
    DebateExecutor,
    DEBATE_AGENT_PROFILES,
    buildInitialReviewPrompt,
    buildRebuttalPrompt,
    buildTieBreakPrompt,
    buildAdversarialReviewPrompt,
    buildEscalatingReviewPrompt,
} from './debate-orchestrator.js';
import { DEBATE_PROMPT_MARKER } from '../adapters/claude-code-parsing.js';

describe('debate-orchestrator', () => {

    describe('prompt scoping', () => {
        const fileScopedSession = {
            prompt: 'Review only src/http-utils.js for hangs and UTF-8 handling.',
            reviewOptions: {
                review_target: 'file',
                file_path: 'src/http-utils.js',
            },
        };

        it('anchors the initial review prompt to the file target', () => {
            const prompt = buildInitialReviewPrompt(fileScopedSession);
            assert.match(prompt, /Primary review target: src\/http-utils\.js/);
            assert.match(prompt, /Ignore any stale review outputs, handoff artifacts, debate transcripts/i);
            assert.match(prompt, /Review the target code itself, not the debate process around it/i);
            assert.match(prompt, /Target file content \(src\/http-utils\.js\)/i);
            // New: output format and marker
            assert.match(prompt, /Return your answer as a raw JSON array\. Do not wrap it in markdown fences/i);
            assert.match(prompt, /__DEBATE_PROMPT__/);
        });

        it('keeps rebuttal prompt anchored to the original target', () => {
            const prompt = buildRebuttalPrompt([
                {
                    dedupeKey: 'dk-1',
                    severity: 'high',
                    title: 'Body reader can hang',
                    agentId: 'claude-code',
                    file: 'src/http-utils.js',
                    line: 21,
                    why_it_matters: 'Requests can hang forever.',
                    fix_instructions: 'Reject on stream errors.',
                    evidence: 'The promise only resolves on end.',
                },
            ], 1, fileScopedSession);
            assert.match(prompt, /re-review the same target scope/i);
            assert.match(prompt, /BEGIN ORIGINAL REVIEW PROMPT/i);
            assert.match(prompt, /src\/http-utils\.js/);
            assert.match(prompt, /not a review of debate artifacts/i);
            assert.match(prompt, /The disputed findings are already included below\. Do not ask for them again\./i);
            assert.match(prompt, /Disputed findings JSON \(exact items to adjudicate\):/i);
            assert.match(prompt, /copy ALL fields from the disputed findings JSON/i);
            assert.match(prompt, /Return ONLY a raw JSON array/i);
            assert.match(prompt, /Do not wrap in markdown fences/i);
            assert.match(prompt, /rationale.*why you still believe/i);
            assert.match(prompt, /"dedupeKey": "dk-1"/i);
            assert.match(prompt, /"why_it_matters": "Requests can hang forever\."/i);
            assert.match(prompt, /"fix_instructions": "Reject on stream errors\."/i);
        });

        it('keeps tie-break prompt anchored to the original target', () => {
            const prompt = buildTieBreakPrompt([
                {
                    dedupeKey: 'dk-1',
                    severity: 'high',
                    title: 'Body reader can hang',
                    agentId: 'claude-code',
                    file: 'src/http-utils.js',
                    line: 21,
                    why_it_matters: 'Requests can hang forever.',
                    fix_instructions: 'Reject on stream errors.',
                    evidence: 'The promise only resolves on end.',
                },
            ], fileScopedSession, [
                { dedupeKey: 'dk-1', verdict: 'accepted', agentId: 'codex' },
                { dedupeKey: 'dk-1', verdict: 'rejected', agentId: 'claude-code' },
            ]);
            assert.match(prompt, /tie-break reviewer/i);
            assert.match(prompt, /src\/http-utils\.js/);
            assert.match(prompt, /Do not audit debate artifacts, prompts, or repository instructions/i);
            assert.match(prompt, /Disputed findings JSON \(exact items to adjudicate\):/i);
            assert.match(prompt, /copy the exact dedupeKey/i);
            assert.match(prompt, /Return ONLY a raw JSON array/i);
            assert.match(prompt, /Do not wrap in markdown fences/i);
            assert.match(prompt, /rationale.*independent assessment/i);
            // Evaluations context
            assert.match(prompt, /accepted by \[codex\]/i);
            assert.match(prompt, /rejected by \[claude-code\]/i);
        });

        it('uses document-review wording for plan files', () => {
            const prompt = buildInitialReviewPrompt({
                prompt: 'Review this implementation plan for contradictions and risky guidance.',
                reviewOptions: {
                    review_target: 'file',
                    file_path: 'plans/phase-04-code-annotation.md',
                },
            });

            assert.match(prompt, /document or implementation plan/i);
            assert.match(prompt, /Review the document itself/i);
            assert.match(prompt, /implementation risks/i);
        });

        it('uses broad-review wording for project-wide review', () => {
            const prompt = buildInitialReviewPrompt({
                prompt: 'Review the current project for real bugs.',
                reviewOptions: {
                    review_target: 'uncommitted',
                },
            });

            assert.match(prompt, /broad-scope review/i);
            assert.match(prompt, /repository-wide or multi-file review/i);
            assert.match(prompt, /prioritize fewer, stronger findings/i);
        });

        it('initial review prompt includes output format instructions', () => {
            const prompt = buildInitialReviewPrompt({
                prompt: 'Review the codebase.',
                reviewOptions: { review_target: 'uncommitted' },
            });
            assert.match(prompt, /Return your answer as a raw JSON array\. Do not wrap it in markdown fences/i);
            assert.match(prompt, /severity.*critical\|high\|medium\|low/i);
            assert.match(prompt, /confidence.*0\.0.*1\.0/i);
            assert.match(prompt, /__DEBATE_PROMPT__/);
        });

        it('DEBATE_PROMPT_MARKER is exported and non-empty', () => {
            assert.equal(typeof DEBATE_PROMPT_MARKER, 'string');
            assert.ok(DEBATE_PROMPT_MARKER.length > 0);
        });

        it('tie-break works without evaluations (no crash)', () => {
            const prompt = buildTieBreakPrompt([
                { dedupeKey: 'dk-1', severity: 'high', title: 'Bug', agentId: 'codex' },
            ]);
            assert.match(prompt, /tie-break reviewer/i);
            assert.match(prompt, /Return ONLY a raw JSON array/i);
            // No "Agent disagreements" section when no evaluations
            assert.doesNotMatch(prompt, /Agent disagreements/);
        });
    });

    // ── DEBATE_AGENT_PROFILES ────────────────────────

    describe('DEBATE_AGENT_PROFILES', () => {
        it('has codex profile with generous timeouts', () => {
            assert.ok(DEBATE_AGENT_PROFILES['codex']);
            assert.equal(DEBATE_AGENT_PROFILES['codex'].reviewTimeoutMs, 360_000);
        });

        it('has claude-code profile with matching generous timeouts', () => {
            assert.ok(DEBATE_AGENT_PROFILES['claude-code']);
            assert.equal(DEBATE_AGENT_PROFILES['claude-code'].reviewTimeoutMs, 360_000);
            assert.equal(DEBATE_AGENT_PROFILES['claude-code'].rebuttalTimeoutMs, 360_000);
        });

        it('both agents have identical review timeouts', () => {
            assert.equal(
                DEBATE_AGENT_PROFILES['codex'].reviewTimeoutMs,
                DEBATE_AGENT_PROFILES['claude-code'].reviewTimeoutMs,
            );
        });

        it('gives claude-code a rebuttal budget equal to its review budget', () => {
            assert.equal(
                DEBATE_AGENT_PROFILES['claude-code'].rebuttalTimeoutMs,
                DEBATE_AGENT_PROFILES['claude-code'].reviewTimeoutMs,
            );
        });
    });

    // ── DebateReducer ────────────────────────────────

    describe('DebateReducer', () => {
        const reducer = new DebateReducer({ maxRounds: 3, consensusThreshold: 0.7 });

        describe('getNextAction', () => {
            it('idle → START_REVIEW', () => {
                const action = reducer.getNextAction({
                    debateState: 'idle',
                    debateRound: 0,
                    agents: ['codex'],
                    findings: [],
                    evaluations: [],
                    completedReviews: [],
                    completedEvals: [],
                });
                assert.equal(action.type, 'START_REVIEW');
                assert.deepEqual(action.payload.agents, ['codex']);
            });

            it('reviewing with all done → START_CROSS_EVAL', () => {
                const action = reducer.getNextAction({
                    debateState: 'reviewing',
                    debateRound: 0,
                    agents: ['codex'],
                    findings: [{ dedupeKey: 'f1', severity: 'high', title: 'Bug', agentId: 'codex' }],
                    evaluations: [],
                    completedReviews: ['codex'],
                    completedEvals: [],
                });
                assert.equal(action.type, 'START_CROSS_EVAL');
            });

            it('reviewing with pending agent → START_REVIEW (pending only)', () => {
                const action = reducer.getNextAction({
                    debateState: 'reviewing',
                    debateRound: 0,
                    agents: ['codex', 'claude-code'],
                    findings: [],
                    evaluations: [],
                    completedReviews: ['claude-code'],
                    completedEvals: [],
                });
                assert.equal(action.type, 'START_REVIEW');
                assert.deepEqual(action.payload.agents, ['codex']); // only pending
            });

            it('cross_eval with all done → CHECK_CONSENSUS', () => {
                const action = reducer.getNextAction({
                    debateState: 'cross_eval',
                    debateRound: 0,
                    agents: ['codex'],
                    findings: [{ dedupeKey: 'f1', severity: 'high', title: 'Bug', agentId: 'codex' }],
                    evaluations: [{ dedupeKey: 'f1', verdict: 'accepted', agentId: 'codex' }],
                    completedReviews: ['codex'],
                    completedEvals: ['codex'],
                });
                assert.equal(action.type, 'CHECK_CONSENSUS');
            });

            it('consensus_check with agreement → RESOLVE', () => {
                const action = reducer.getNextAction({
                    debateState: 'consensus_check',
                    debateRound: 0,
                    agents: ['codex'],
                    findings: [{ dedupeKey: 'f1', severity: 'high', title: 'Bug', agentId: 'codex' }],
                    evaluations: [{ dedupeKey: 'f1', verdict: 'accepted', agentId: 'claude-code' }],
                    completedReviews: ['codex'],
                    completedEvals: ['claude-code'],
                });
                assert.equal(action.type, 'RESOLVE');
            });

            it('consensus_check with low agreement, rounds left → START_REBUTTAL', () => {
                const action = reducer.getNextAction({
                    debateState: 'consensus_check',
                    debateRound: 1,
                    agents: ['codex', 'claude-code'],
                    findings: [
                        { dedupeKey: 'f1', severity: 'high', title: 'Bug', agentId: 'codex' },
                        { dedupeKey: 'f2', severity: 'low', title: 'FP', agentId: 'codex' },
                    ],
                    evaluations: [
                        { dedupeKey: 'f1', verdict: 'accepted', agentId: 'claude-code' },
                        { dedupeKey: 'f2', verdict: 'rejected', agentId: 'claude-code' },
                        { dedupeKey: 'f2', verdict: 'accepted', agentId: 'codex' }, // mixed
                    ],
                    completedReviews: ['codex', 'claude-code'],
                    completedEvals: ['codex', 'claude-code'],
                });
                assert.equal(action.type, 'START_REBUTTAL');
            });

            it('consensus_check at max rounds → TIE_BREAK', () => {
                const action = reducer.getNextAction({
                    debateState: 'consensus_check',
                    debateRound: 3, // max rounds hit
                    agents: ['codex', 'claude-code'],
                    findings: [
                        { dedupeKey: 'f1', severity: 'high', title: 'Bug', agentId: 'codex' },
                    ],
                    evaluations: [
                        { dedupeKey: 'f1', verdict: 'accepted', agentId: 'codex' },
                        { dedupeKey: 'f1', verdict: 'rejected', agentId: 'claude-code' },
                    ],
                    completedReviews: ['codex', 'claude-code'],
                    completedEvals: ['codex', 'claude-code'],
                });
                assert.equal(action.type, 'TIE_BREAK');
            });

            it('debate_round → START_CROSS_EVAL (loop back)', () => {
                const action = reducer.getNextAction({
                    debateState: 'debate_round',
                    debateRound: 1,
                    agents: ['codex'],
                    findings: [],
                    evaluations: [],
                    completedReviews: ['codex'],
                    completedEvals: [],
                });
                assert.equal(action.type, 'START_CROSS_EVAL');
            });

            it('tie_break → RESOLVE', () => {
                const action = reducer.getNextAction({
                    debateState: 'tie_break',
                    debateRound: 3,
                    agents: ['codex'],
                    findings: [],
                    evaluations: [],
                    completedReviews: [],
                    completedEvals: [],
                });
                assert.equal(action.type, 'RESOLVE');
                assert.equal(action.payload.forceTieBreak, true);
            });

            it('resolved → RESOLVE (noop)', () => {
                const action = reducer.getNextAction({
                    debateState: 'resolved',
                    debateRound: 0,
                    agents: [],
                    findings: [],
                    evaluations: [],
                    completedReviews: [],
                    completedEvals: [],
                });
                assert.equal(action.type, 'RESOLVE');
            });

            it('unknown state → FAIL', () => {
                const action = reducer.getNextAction({
                    debateState: 'bogus',
                    debateRound: 0,
                    agents: [],
                    findings: [],
                    evaluations: [],
                    completedReviews: [],
                    completedEvals: [],
                });
                assert.equal(action.type, 'FAIL');
            });
        });

        describe('getEventFromResult', () => {
            it('START_REVIEW success → all_reviews_done', () => {
                assert.equal(reducer.getEventFromResult('START_REVIEW', { success: true }), 'all_reviews_done');
            });

            it('START_CROSS_EVAL success → all_evals_done', () => {
                assert.equal(reducer.getEventFromResult('START_CROSS_EVAL', { success: true }), 'all_evals_done');
            });

            it('CHECK_CONSENSUS with consensus → consensus_reached', () => {
                assert.equal(reducer.getEventFromResult('CHECK_CONSENSUS', { success: true, consensus: true }), 'consensus_reached');
            });

            it('CHECK_CONSENSUS without consensus → no_consensus', () => {
                assert.equal(reducer.getEventFromResult('CHECK_CONSENSUS', { success: true, consensus: false }), 'no_consensus');
            });

            it('CHECK_CONSENSUS at max rounds → max_rounds', () => {
                assert.equal(reducer.getEventFromResult('CHECK_CONSENSUS', { success: true, consensus: false, maxRoundsHit: true }), 'max_rounds');
            });

            it('any failure → error', () => {
                assert.equal(reducer.getEventFromResult('START_REVIEW', { success: false }), 'error');
            });

            it('TIE_BREAK success → tie_broken', () => {
                assert.equal(reducer.getEventFromResult('TIE_BREAK', { success: true }), 'tie_broken');
            });
        });
    });

    // ── DebateExecutor ───────────────────────────────

    describe('DebateExecutor', () => {
        /** Helper: create a mock session */
        function createMockSession() {
            return {
                sessionId: 'test-session-123',
                state: 'completed',
                debateState: null,
                debateRound: 0,
                debateMaxRounds: 3,
                debateAgents: null,
                debateActive: false,
                debateRoundEvals: {},
                debateTimings: [],
                assignments: { reviewer: 'codex', responder: 'antigravity', decider: 'antigravity' },
            };
        }

        describe('initDebate', () => {
            it('initializes debate fields on session', () => {
                const session = createMockSession();
                const executor = new DebateExecutor({ session });
                const result = executor.initDebate({ agents: ['codex'], maxRounds: 3 });

                assert.equal(session.debateState, 'idle');
                assert.equal(session.debateRound, 0);
                assert.equal(session.debateMaxRounds, 3);
                assert.deepEqual(session.debateAgents, ['codex']);
                assert.equal(session.debateActive, true);
                assert.deepEqual(session.debateRoundEvals, {});

                assert.equal(result.debateState, 'idle');
                assert.equal(result.round, 0);
                assert.equal(result.maxRounds, 3);
            });

            it('rejects 0 agents', () => {
                const session = createMockSession();
                const executor = new DebateExecutor({ session });
                assert.throws(() => executor.initDebate({ agents: [] }), /1-2 agents/);
            });

            it('rejects 3+ agents (F-2)', () => {
                const session = createMockSession();
                const executor = new DebateExecutor({ session });
                assert.throws(() => executor.initDebate({ agents: ['a', 'b', 'c'] }), /1-2 agents/);
            });

            it('rejects 2 agents without decider (F-6)', () => {
                const session = createMockSession();
                const executor = new DebateExecutor({ session });
                assert.throws(
                    () => executor.initDebate({ agents: ['codex', 'claude-code'] }),
                    /Decider is required/,
                );
            });

            it('accepts 2 agents with decider', () => {
                const session = createMockSession();
                const executor = new DebateExecutor({ session });
                const result = executor.initDebate({
                    agents: ['codex', 'claude-code'],
                    decider: 'antigravity',
                });
                assert.equal(result.agents.length, 2);
                assert.equal(session.assignments.decider, 'antigravity');
            });

            it('single agent does not require decider', () => {
                const session = createMockSession();
                const executor = new DebateExecutor({ session });
                const result = executor.initDebate({ agents: ['codex'] });
                assert.equal(result.agents.length, 1);
            });
        });

        describe('transition', () => {
            it('valid transition updates session state', () => {
                const session = createMockSession();
                session.debateState = 'idle';
                const executor = new DebateExecutor({ session });

                const result = executor.transition('start');
                assert.equal(result.valid, true);
                assert.equal(result.state, 'reviewing');
                assert.equal(session.debateState, 'reviewing');
            });

            it('invalid transition does not change state', () => {
                const session = createMockSession();
                session.debateState = 'idle';
                const executor = new DebateExecutor({ session });

                const result = executor.transition('all_reviews_done');
                assert.equal(result.valid, false);
                assert.equal(session.debateState, 'idle');
            });

            it('no_consensus transitions to judging (Phase 3 targeted judge)', () => {
                const session = createMockSession();
                session.debateState = 'consensus_check';
                session.debateRound = 0;
                const executor = new DebateExecutor({ session });

                executor.transition('no_consensus');
                assert.equal(session.debateState, 'judging');
            });

            it('terminal state sets debateActive to false', () => {
                const session = createMockSession();
                session.debateState = 'consensus_check';
                session.debateActive = true;
                const executor = new DebateExecutor({ session });

                executor.transition('consensus_reached');
                assert.equal(session.debateState, 'resolved');
                assert.equal(session.debateActive, false);
            });

            it('failure sets debateActive to false', () => {
                const session = createMockSession();
                session.debateState = 'reviewing';
                session.debateActive = true;
                const executor = new DebateExecutor({ session });

                executor.transition('error');
                assert.equal(session.debateState, 'failed');
                assert.equal(session.debateActive, false);
            });
        });

        describe('recordTiming', () => {
            it('records timing entry', () => {
                const session = createMockSession();
                const executor = new DebateExecutor({ session });
                const start = Date.now();
                const end = start + 5000;

                executor.recordTiming('codex', 'review', start, end, false);

                assert.equal(executor.timings.length, 1);
                assert.equal(executor.timings[0].agentId, 'codex');
                assert.equal(executor.timings[0].phase, 'review');
                assert.equal(executor.timings[0].timedOut, false);
                assert.equal(session.debateTimings.length, 1);
            });

            it('records timeout flag', () => {
                const session = createMockSession();
                const executor = new DebateExecutor({ session });

                executor.recordTiming('codex', 'review', Date.now(), Date.now() + 360000, true);
                assert.equal(executor.timings[0].timedOut, true);
            });

            it('passes phase timeout overrides into adapter execution', async () => {
                const session = createMockSession();
                session.id = 'sess-timeout-override';
                session.projectDir = '/project';
                session.snapshotPath = '/snapshot';
                session.debateRound = 0;
                session.debateAgents = ['claude-code'];

                /** @type {any[]} */
                const calls = [];
                const executor = new DebateExecutor({
                    session,
                    adapterMap: {
                        'claude-code': {
                            execute: (...args) => {
                                calls.push(args);
                                return {
                                    stream: (async function* () {})(),
                                    done: Promise.resolve({
                                        status: 'ok',
                                        findings: [],
                                        timingMs: { firstByteMs: 0, lastIdleGapMs: 0, totalMs: 0 },
                                    }),
                                };
                            },
                        },
                    },
                    agentProfiles: {
                        'claude-code': {
                            reviewTimeoutMs: 123_000,
                            evalTimeoutMs: 45_000,
                            rebuttalTimeoutMs: 67_000,
                        },
                    },
                });

                await executor.runReviewPass(['claude-code'], {
                    phase: 'review',
                    prompt: 'Review this snapshot',
                });

                assert.equal(calls.length, 1);
                assert.deepEqual(calls[0][3], {
                    timeouts: {
                        firstByteMs: 123_000,
                        idleMs: 123_000,
                        hardMs: 123_000,
                    },
                });
            });

            it('uses a file-scoped sandbox workspace for file target reviews', async () => {
                const session = createMockSession();
                session.id = 'sess-file-scope';
                session.projectDir = process.cwd();
                session.snapshotPath = process.cwd();
                session.prompt = 'Review only src/http-utils.js';
                session.reviewOptions = {
                    review_target: 'file',
                    file_path: 'src/http-utils.js',
                };
                session.debateRound = 0;
                session.debateAgents = ['claude-code'];

                /** @type {any[]} */
                const calls = [];
                const executor = new DebateExecutor({
                    session,
                    adapterMap: {
                        'claude-code': {
                            execute: (...args) => {
                                calls.push(args);
                                return {
                                    stream: (async function* () {})(),
                                    done: Promise.resolve({
                                        status: 'ok',
                                        findings: [],
                                        timingMs: { firstByteMs: 0, lastIdleGapMs: 0, totalMs: 0 },
                                    }),
                                };
                            },
                        },
                    },
                });

                await executor.runReviewPass(['claude-code'], {
                    phase: 'review',
                    prompt: 'Review only src/http-utils.js',
                });

                assert.equal(calls.length, 1);
                assert.notEqual(calls[0][1], process.cwd());
                assert.match(calls[0][1], /extension-debate-file-/i);
            });

            it('copies only the target file into the file-scoped sandbox', async () => {
                const session = createMockSession();
                session.id = 'sess-file-only-copy';
                session.projectDir = process.cwd();
                session.snapshotPath = process.cwd();
                session.prompt = 'Review only src/http-utils.js';
                session.reviewOptions = {
                    review_target: 'file',
                    file_path: 'src/http-utils.js',
                };
                session.debateRound = 0;
                session.debateAgents = ['claude-code'];

                /** @type {any[]} */
                const calls = [];
                const executor = new DebateExecutor({
                    session,
                    adapterMap: {
                        'claude-code': {
                            execute: (...args) => {
                                calls.push(args);
                                return {
                                    stream: (async function* () {})(),
                                    done: Promise.resolve({
                                        status: 'ok',
                                        findings: [],
                                        timingMs: { firstByteMs: 0, lastIdleGapMs: 0, totalMs: 0 },
                                    }),
                                };
                            },
                        },
                    },
                });

                await executor.runReviewPass(['claude-code'], {
                    phase: 'review',
                    prompt: 'Review only src/http-utils.js',
                });

                const sandboxPath = String(calls[0][1]);
                assert.equal(fs.existsSync(path.join(sandboxPath, 'src', 'http-utils.js')), true);
                assert.equal(fs.existsSync(path.join(sandboxPath, 'src', 'api-routes.js')), false);
                assert.equal(fs.existsSync(path.join(sandboxPath, 'src', 'collab-routes.js')), false);
            });

            it('splits file-scoped rebuttals into one finding per batch', async () => {
                const session = createMockSession();
                session.id = 'sess-file-per-finding';
                session.projectDir = process.cwd();
                session.snapshotPath = process.cwd();
                session.prompt = 'Review only src/http-utils.js';
                session.reviewOptions = {
                    review_target: 'file',
                    file_path: 'src/http-utils.js',
                };
                session.debateRound = 1;
                session.debateAgents = ['claude-code'];

                /** @type {any[]} */
                const calls = [];
                const executor = new DebateExecutor({
                    session,
                    adapterMap: {
                        'claude-code': {
                            execute: (...args) => {
                                calls.push(args);
                                return {
                                    stream: (async function* () {})(),
                                    done: Promise.resolve({
                                        status: 'ok',
                                        findings: [],
                                        timingMs: { firstByteMs: 0, lastIdleGapMs: 0, totalMs: 0 },
                                    }),
                                };
                            },
                        },
                    },
                });

                await executor.runRebuttal([
                    { dedupeKey: 'f1', severity: 'high', title: 'A', agentId: 'codex', file: 'src/http-utils.js' },
                    { dedupeKey: 'f2', severity: 'medium', title: 'B', agentId: 'codex', file: 'src/http-utils.js' },
                ]);

                assert.equal(calls.length, 2);
                assert.match(String(calls[0][2]), /"dedupeKey": "f1"/i);
                assert.doesNotMatch(String(calls[0][2]), /"dedupeKey": "f2"/i);
                assert.match(String(calls[1][2]), /"dedupeKey": "f2"/i);
                assert.doesNotMatch(String(calls[1][2]), /"dedupeKey": "f1"/i);
            });

            it('splits broad-scope rebuttals into multiple batches', async () => {
                const session = createMockSession();
                session.id = 'sess-batched-rebuttal';
                session.projectDir = process.cwd();
                session.snapshotPath = process.cwd();
                session.prompt = 'Review the project for bugs';
                session.reviewOptions = {
                    review_target: 'uncommitted',
                };
                session.debateRound = 1;
                session.debateAgents = ['claude-code'];

                /** @type {any[]} */
                const calls = [];
                const executor = new DebateExecutor({
                    session,
                    adapterMap: {
                        'claude-code': {
                            execute: (...args) => {
                                calls.push(args);
                                return {
                                    stream: (async function* () {})(),
                                    done: Promise.resolve({
                                        status: 'ok',
                                        findings: [],
                                        timingMs: { firstByteMs: 0, lastIdleGapMs: 0, totalMs: 0 },
                                    }),
                                };
                            },
                        },
                    },
                });

                await executor.runRebuttal([
                    { dedupeKey: 'f1', severity: 'high', title: 'A', agentId: 'codex', file: 'src/a.js' },
                    { dedupeKey: 'f2', severity: 'high', title: 'B', agentId: 'codex', file: 'src/a.js' },
                    { dedupeKey: 'f3', severity: 'medium', title: 'C', agentId: 'codex', file: 'src/b.js' },
                    { dedupeKey: 'f4', severity: 'medium', title: 'D', agentId: 'codex', file: 'src/b.js' },
                    { dedupeKey: 'f5', severity: 'low', title: 'E', agentId: 'codex', file: 'src/c.js' },
                ]);

                assert.equal(calls.length, 3);
                assert.match(String(calls[0][2]), /Rebuttal batch 1 of 3/i);
                assert.match(String(calls[1][2]), /Rebuttal batch 2 of 3/i);
                assert.match(String(calls[2][2]), /Rebuttal batch 3 of 3/i);
            });

            it('chunks broad-scope rebuttals when one file has many disputed findings', async () => {
                const session = createMockSession();
                session.id = 'sess-batched-rebuttal-chunked';
                session.projectDir = process.cwd();
                session.snapshotPath = process.cwd();
                session.prompt = 'Review the project for bugs';
                session.reviewOptions = {
                    review_target: 'uncommitted',
                };
                session.debateRound = 1;
                session.debateAgents = ['claude-code'];

                /** @type {any[]} */
                const calls = [];
                const executor = new DebateExecutor({
                    session,
                    adapterMap: {
                        'claude-code': {
                            execute: (...args) => {
                                calls.push(args);
                                return {
                                    stream: (async function* () {})(),
                                    done: Promise.resolve({
                                        status: 'ok',
                                        findings: [],
                                        timingMs: { firstByteMs: 0, lastIdleGapMs: 0, totalMs: 0 },
                                    }),
                                };
                            },
                        },
                    },
                });

                await executor.runRebuttal([
                    { dedupeKey: 'f1', severity: 'high', title: 'A', agentId: 'codex', file: 'src/a.js' },
                    { dedupeKey: 'f2', severity: 'high', title: 'B', agentId: 'codex', file: 'src/a.js' },
                    { dedupeKey: 'f3', severity: 'medium', title: 'C', agentId: 'codex', file: 'src/a.js' },
                    { dedupeKey: 'f4', severity: 'medium', title: 'D', agentId: 'codex', file: 'src/b.js' },
                ]);

                assert.equal(calls.length, 3);
                assert.match(String(calls[0][2]), /"dedupeKey": "f1"/i);
                assert.match(String(calls[0][2]), /"dedupeKey": "f2"/i);
                assert.doesNotMatch(String(calls[0][2]), /"dedupeKey": "f3"/i);
                assert.match(String(calls[1][2]), /"dedupeKey": "f3"/i);
                assert.match(String(calls[2][2]), /"dedupeKey": "f4"/i);
            });
        });

        describe('getDebateStatus', () => {
            it('returns current debate status', () => {
                const session = createMockSession();
                session.debateState = 'reviewing';
                session.debateRound = 1;
                session.debateMaxRounds = 3;
                session.debateAgents = ['codex', 'claude-code'];
                session.debateActive = true;
                const executor = new DebateExecutor({ session });
                executor.findings = [{ dedupeKey: 'f1', severity: 'high', title: 'Bug', agentId: 'codex' }];

                const status = executor.getDebateStatus();
                assert.equal(status.debateState, 'reviewing');
                assert.equal(status.debateRound, 1);
                assert.equal(status.debateMaxRounds, 3);
                assert.deepEqual(status.debateAgents, ['codex', 'claude-code']);
                assert.equal(status.debateActive, true);
                assert.equal(status.findingsCount, 1);
            });

            it('returns null/defaults when no debate', () => {
                const session = createMockSession();
                const executor = new DebateExecutor({ session });
                const status = executor.getDebateStatus();
                assert.equal(status.debateState, null);
                assert.equal(status.debateActive, false);
            });
        });

        describe('resolveFinalFindings', () => {
            it('does not treat a debating agent as an authoritative decider without an independent tie-break', async () => {
                const session = createMockSession();
                session.debateState = 'resolved';
                session.debateAgents = ['codex', 'claude-code'];
                session.assignments.decider = 'codex';

                const executor = new DebateExecutor({ session });
                executor.rawFindingsByAgent.set('claude-code', [
                    {
                        id: 'finding-1',
                        dedupe_key: 'f1',
                        summary: 'readBody hangs on abort',
                        severity: 'high',
                    },
                ]);
                executor.findings = [
                    {
                        dedupeKey: 'f1',
                        severity: 'high',
                        title: 'readBody hangs on abort',
                        agentId: 'claude-code',
                        round: 3,
                    },
                ];
                executor.evaluations = [
                    { dedupeKey: 'f1', verdict: 'rejected', agentId: 'codex', round: 3 },
                    { dedupeKey: 'f1', verdict: 'accepted', agentId: 'claude-code', round: 3 },
                ];

                const result = await executor.resolveFinalFindings();

                assert.equal(result.logicalFindings.length, 1);
                assert.equal(result.logicalFindings[0].dedupeKey, 'f1');
                assert.equal(result.finalFindings.length, 1);
                assert.equal(session.allFindings.length, 1);
                assert.equal(session.mergedFindings.length, 1);
            });
        });

        describe('system messages', () => {
            it('calls onSystemMessage during initDebate', () => {
                const messages = [];
                const session = createMockSession();
                const executor = new DebateExecutor({
                    session,
                    onSystemMessage: (msg) => messages.push(msg),
                });

                executor.initDebate({ agents: ['codex'] });
                assert.equal(messages.length, 1);
                assert.ok(messages[0].includes('Debate initialized'));
            });

            it('calls onSystemMessage during transition', () => {
                const messages = [];
                const session = createMockSession();
                session.debateState = 'idle';
                const executor = new DebateExecutor({
                    session,
                    onSystemMessage: (msg) => messages.push(msg),
                });

                executor.transition('start');
                assert.equal(messages.length, 1);
                assert.ok(messages[0].includes('idle → reviewing'));
            });
        });

        describe('rebuttal field preservation', () => {
            it('backfills missing fields from original finding when rebuttal returns sparse data', async () => {
                const session = createMockSession();
                session.id = 'sess-backfill';
                session.projectDir = '/project';
                session.snapshotPath = '/snapshot';
                session.debateRound = 1;
                session.debateAgents = ['codex'];

                const executor = new DebateExecutor({
                    session,
                    adapterMap: {
                        codex: {
                            execute: () => ({
                                stream: (async function* () {})(),
                                done: Promise.resolve({
                                    status: 'ok',
                                    // Rebuttal returns sparse finding: only dedupeKey + rationale
                                    findings: [{
                                        id: 'f1-rebuttal',
                                        dedupe_key: 'dk1',
                                        summary: 'Body reader can hang',
                                        severity: 'high',
                                        file: 'src/http-utils.js',
                                        line: null,
                                        confidence: 0.5,
                                        evidence: '',       // empty — agent omitted
                                        why_it_matters: '', // empty — agent omitted
                                        fix_instructions: null,
                                    }],
                                    timingMs: { firstByteMs: 0, lastIdleGapMs: 0, totalMs: 0 },
                                }),
                            }),
                        },
                    },
                });

                // Seed rawFindingsByAgent with original rich finding
                executor.rawFindingsByAgent.set('codex', [{
                    id: 'f1-original',
                    dedupe_key: 'dk1',
                    summary: 'Body reader can hang',
                    severity: 'high',
                    file: 'src/http-utils.js',
                    line: 21,
                    confidence: 0.9,
                    evidence: 'The promise only resolves on end, never rejects on stream error.',
                    why_it_matters: 'Requests can hang forever if stream errors are not handled.',
                    fix_instructions: 'Add reject handler on stream error event.',
                }]);

                await executor.runReviewPass(['codex'], {
                    phase: 'rebuttal',
                    prompt: 'Reconsider...',
                    disputedKeys: ['dk1'],
                });

                const result = executor.rawFindingsByAgent.get('codex');
                assert.equal(result.length, 1);
                const finding = result[0];

                // Rebuttal values should win where provided
                assert.equal(finding.dedupe_key, 'dk1');
                assert.equal(finding.summary, 'Body reader can hang');
                assert.equal(finding.severity, 'high');
                assert.equal(finding.file, 'src/http-utils.js');

                // Original values should backfill where rebuttal was empty/null
                assert.equal(finding.line, 21, 'line should be backfilled from original (rebuttal had null)');
                assert.equal(finding.confidence, 0.5, 'confidence keeps rebuttal value (0.5 is valid, not empty)');
                assert.equal(finding.evidence, 'The promise only resolves on end, never rejects on stream error.',
                    'evidence should be backfilled from original (rebuttal had empty string)');
                assert.equal(finding.why_it_matters, 'Requests can hang forever if stream errors are not handled.',
                    'why_it_matters should be backfilled from original (rebuttal had empty string)');
                assert.equal(finding.fix_instructions, 'Add reject handler on stream error event.',
                    'fix_instructions should be backfilled from original (rebuttal had null)');
            });
        });

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

                // Override baseDelayMs to 0 so test runs instantly
                executor._executeAgentWithRetry = executor._executeAgentWithRetry.bind(executor);
                const origMethod = executor._executeAgentWithRetry;
                executor._executeAgentWithRetry = (agentId, opts) => origMethod(agentId, opts, { maxRetries: 3, baseDelayMs: 0 });

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

                // Override to skip delays
                const origMethod = executor._executeAgentWithRetry.bind(executor);
                executor._executeAgentWithRetry = (agentId, opts) => origMethod(agentId, opts, { maxRetries: 3, baseDelayMs: 0 });

                await executor.runReviewPass(['codex', 'claude-code'], {
                    phase: 'review',
                    prompt: 'Review this',
                });

                // Codex findings should survive
                assert.equal(executor.rawFindingsByAgent.get('codex')?.length, 1);
                // Claude-code should have no findings (failed)
                assert.equal(executor.rawFindingsByAgent.has('claude-code'), false);
                // System messages about failure and fallback
                assert.ok(messages.some(m => /claude-code.*failed.*3 attempts/i.test(m)),
                    'Should emit system message about agent failure');
                assert.ok(messages.some(m => /surviving agent/i.test(m)),
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

                // Override to skip delays
                const origMethod = executor._executeAgentWithRetry.bind(executor);
                executor._executeAgentWithRetry = (agentId, opts) => origMethod(agentId, opts, { maxRetries: 3, baseDelayMs: 0 });

                await assert.rejects(
                    () => executor.runReviewPass(['codex'], {
                        phase: 'review',
                        prompt: 'Review this',
                    }),
                    /all agents failed/i,
                );
            });
        });
    });

    describe('buildAdversarialReviewPrompt', () => {
        const mockSession = {
            prompt: 'Review this PR for security issues',
            reviewOptions: {},
        };

        it('includes hostile design reviewer framing', () => {
            const prompt = buildAdversarialReviewPrompt(mockSession);
            assert.match(prompt, /HOSTILE design reviewer/i);
        });

        it('includes four challenge areas', () => {
            const prompt = buildAdversarialReviewPrompt(mockSession);
            assert.match(prompt, /WHY/);
            assert.match(prompt, /FAILURE/);
            assert.match(prompt, /ASSUMPTIONS/);
            assert.match(prompt, /COST/);
        });

        it('includes structured output instructions', () => {
            const prompt = buildAdversarialReviewPrompt(mockSession);
            assert.match(prompt, /verdict.*fail.*pass.*conditional/);
            assert.match(prompt, /confidence.*certain.*likely.*inference/);
            assert.match(prompt, /design_challenge/);
        });

        it('does not mention finding bugs as the job', () => {
            const prompt = buildAdversarialReviewPrompt(mockSession);
            assert.match(prompt, /your job is NOT to find bugs/i);
        });
    });

    describe('buildEscalatingReviewPrompt', () => {
        const mockSession = {
            prompt: 'Review this PR for security issues',
            reviewOptions: {},
        };

        it('returns normal prompt when findings >= threshold', () => {
            const normal = buildInitialReviewPrompt(mockSession);
            const escalating = buildEscalatingReviewPrompt(mockSession, 5, 3);
            assert.equal(escalating, normal);
        });

        it('returns adversarial prompt when findings < threshold', () => {
            const adversarial = buildAdversarialReviewPrompt(mockSession);
            const escalating = buildEscalatingReviewPrompt(mockSession, 2, 3);
            assert.equal(escalating, adversarial);
        });

        it('uses custom escalation threshold', () => {
            const adversarial = buildAdversarialReviewPrompt(mockSession);
            // findings=4, threshold=5 → below threshold → adversarial
            const escalating = buildEscalatingReviewPrompt(mockSession, 4, 5);
            assert.equal(escalating, adversarial);
        });
    });
});

// @ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    DebateReducer,
    DebateExecutor,
    DEBATE_AGENT_PROFILES,
} from './debate-orchestrator.js';

describe('debate-orchestrator', () => {

    // ── DEBATE_AGENT_PROFILES ────────────────────────

    describe('DEBATE_AGENT_PROFILES', () => {
        it('has codex profile with longer timeouts', () => {
            assert.ok(DEBATE_AGENT_PROFILES['codex']);
            assert.equal(DEBATE_AGENT_PROFILES['codex'].reviewTimeoutMs, 360_000);
        });

        it('has claude-code profile with shorter timeouts', () => {
            assert.ok(DEBATE_AGENT_PROFILES['claude-code']);
            assert.equal(DEBATE_AGENT_PROFILES['claude-code'].reviewTimeoutMs, 120_000);
        });

        it('codex review timeout > claude-code review timeout', () => {
            assert.ok(
                DEBATE_AGENT_PROFILES['codex'].reviewTimeoutMs >
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

            it('debate_round increments round counter', () => {
                const session = createMockSession();
                session.debateState = 'consensus_check';
                session.debateRound = 0;
                const executor = new DebateExecutor({ session });

                executor.transition('no_consensus');
                assert.equal(session.debateState, 'debate_round');
                assert.equal(session.debateRound, 1);
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
    });
});

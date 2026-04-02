// @ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    DEBATE_STATES,
    DEBATE_TERMINAL_STATES,
    DEBATE_EVENTS,
    DEBATE_TRANSITIONS,
    validateDebateTransition,
    isDebateTerminal,
    isValidDebateState,
    deriveNextDebateState,
    createDefaultDebateFields,
} from './debate-state.js';

describe('debate-state', () => {

    // ── Constants ────────────────────────────────────

    describe('DEBATE_STATES', () => {
        it('has 9 states', () => {
            assert.equal(DEBATE_STATES.length, 9);
        });

        it('contains all expected states', () => {
            const expected = ['idle', 'reviewing', 'cross_eval', 'consensus_check', 'judging', 'debate_round', 'tie_break', 'resolved', 'failed'];
            assert.deepEqual([...DEBATE_STATES], expected);
        });
    });

    describe('DEBATE_TERMINAL_STATES', () => {
        it('has resolved and failed', () => {
            assert.deepEqual([...DEBATE_TERMINAL_STATES], ['resolved', 'failed']);
        });
    });

    describe('DEBATE_EVENTS', () => {
        it('has 11 event types', () => {
            assert.equal(DEBATE_EVENTS.length, 11);
        });
    });

    // ── validateDebateTransition ─────────────────────

    describe('validateDebateTransition', () => {
        it('idle → reviewing is valid', () => {
            assert.equal(validateDebateTransition('idle', 'reviewing'), true);
        });

        it('reviewing → cross_eval is valid', () => {
            assert.equal(validateDebateTransition('reviewing', 'cross_eval'), true);
        });

        it('reviewing → failed is valid', () => {
            assert.equal(validateDebateTransition('reviewing', 'failed'), true);
        });

        it('cross_eval → consensus_check is valid', () => {
            assert.equal(validateDebateTransition('cross_eval', 'consensus_check'), true);
        });

        it('consensus_check → resolved is valid', () => {
            assert.equal(validateDebateTransition('consensus_check', 'resolved'), true);
        });

        it('consensus_check → debate_round is valid', () => {
            assert.equal(validateDebateTransition('consensus_check', 'debate_round'), true);
        });

        it('consensus_check → tie_break is valid', () => {
            assert.equal(validateDebateTransition('consensus_check', 'tie_break'), true);
        });

        it('debate_round → cross_eval is valid (loop back)', () => {
            assert.equal(validateDebateTransition('debate_round', 'cross_eval'), true);
        });

        it('tie_break → resolved is valid', () => {
            assert.equal(validateDebateTransition('tie_break', 'resolved'), true);
        });

        it('consensus_check → judging is valid', () => {
            assert.equal(validateDebateTransition('consensus_check', 'judging'), true);
        });

        it('judging → resolved is valid', () => {
            assert.equal(validateDebateTransition('judging', 'resolved'), true);
        });

        it('judging → failed is valid', () => {
            assert.equal(validateDebateTransition('judging', 'failed'), true);
        });

        it('idle → resolved is INVALID (skip states)', () => {
            assert.equal(validateDebateTransition('idle', 'resolved'), false);
        });

        it('resolved → idle is INVALID (terminal)', () => {
            assert.equal(validateDebateTransition('resolved', 'idle'), false);
        });

        it('failed → reviewing is INVALID (terminal)', () => {
            assert.equal(validateDebateTransition('failed', 'reviewing'), false);
        });

        it('unknown state returns false', () => {
            assert.equal(validateDebateTransition('nonexistent', 'idle'), false);
        });

        it('reviewing → idle is INVALID (backward)', () => {
            assert.equal(validateDebateTransition('reviewing', 'idle'), false);
        });
    });

    // ── isDebateTerminal ─────────────────────────────

    describe('isDebateTerminal', () => {
        it('resolved is terminal', () => {
            assert.equal(isDebateTerminal('resolved'), true);
        });

        it('failed is terminal', () => {
            assert.equal(isDebateTerminal('failed'), true);
        });

        it('idle is NOT terminal', () => {
            assert.equal(isDebateTerminal('idle'), false);
        });

        it('reviewing is NOT terminal', () => {
            assert.equal(isDebateTerminal('reviewing'), false);
        });

        it('consensus_check is NOT terminal', () => {
            assert.equal(isDebateTerminal('consensus_check'), false);
        });
    });

    // ── isValidDebateState ───────────────────────────

    describe('isValidDebateState', () => {
        for (const state of DEBATE_STATES) {
            it(`${state} is valid`, () => {
                assert.equal(isValidDebateState(state), true);
            });
        }

        it('unknown state is invalid', () => {
            assert.equal(isValidDebateState('bogus'), false);
        });

        it('empty string is invalid', () => {
            assert.equal(isValidDebateState(''), false);
        });
    });

    // ── deriveNextDebateState ────────────────────────

    describe('deriveNextDebateState', () => {
        it('idle + start → reviewing', () => {
            const result = deriveNextDebateState('idle', 'start');
            assert.deepEqual(result, { state: 'reviewing', valid: true });
        });

        it('reviewing + all_reviews_done → cross_eval', () => {
            const result = deriveNextDebateState('reviewing', 'all_reviews_done');
            assert.deepEqual(result, { state: 'cross_eval', valid: true });
        });

        it('cross_eval + all_evals_done → consensus_check', () => {
            const result = deriveNextDebateState('cross_eval', 'all_evals_done');
            assert.deepEqual(result, { state: 'consensus_check', valid: true });
        });

        it('consensus_check + consensus_reached → resolved', () => {
            const result = deriveNextDebateState('consensus_check', 'consensus_reached');
            assert.deepEqual(result, { state: 'resolved', valid: true });
        });

        it('consensus_check + no_consensus → judging (Phase 3)', () => {
            const result = deriveNextDebateState('consensus_check', 'no_consensus');
            assert.deepEqual(result, { state: 'judging', valid: true });
        });

        it('consensus_check + max_rounds → tie_break', () => {
            const result = deriveNextDebateState('consensus_check', 'max_rounds');
            assert.deepEqual(result, { state: 'tie_break', valid: true });
        });

        it('consensus_check + no_consensus → judging', () => {
            const result = deriveNextDebateState('consensus_check', 'no_consensus');
            assert.deepEqual(result, { state: 'judging', valid: true });
        });

        it('judging + judging_done → resolved', () => {
            const result = deriveNextDebateState('judging', 'judging_done');
            assert.deepEqual(result, { state: 'resolved', valid: true });
        });

        it('debate_round + rebuttals_done → cross_eval (loop)', () => {
            const result = deriveNextDebateState('debate_round', 'rebuttals_done');
            assert.deepEqual(result, { state: 'cross_eval', valid: true });
        });

        it('tie_break + tie_broken → resolved', () => {
            const result = deriveNextDebateState('tie_break', 'tie_broken');
            assert.deepEqual(result, { state: 'resolved', valid: true });
        });

        it('any non-terminal + error → failed', () => {
            const nonTerminal = ['idle', 'reviewing', 'cross_eval', 'consensus_check', 'judging', 'debate_round', 'tie_break'];
            for (const state of nonTerminal) {
                const result = deriveNextDebateState(state, 'error');
                assert.deepEqual(result, { state: 'failed', valid: true }, `${state} + error should → failed`);
            }
        });

        it('terminal state + any event → stays, invalid', () => {
            const result1 = deriveNextDebateState('resolved', 'start');
            assert.deepEqual(result1, { state: 'resolved', valid: false });

            const result2 = deriveNextDebateState('failed', 'start');
            assert.deepEqual(result2, { state: 'failed', valid: false });
        });

        it('unknown event in valid state → stays, invalid', () => {
            const result = deriveNextDebateState('idle', 'unknown_event');
            assert.deepEqual(result, { state: 'idle', valid: false });
        });

        it('unknown state → stays, invalid', () => {
            const result = deriveNextDebateState('nonexistent', 'start');
            assert.deepEqual(result, { state: 'nonexistent', valid: false });
        });
    });

    // ── createDefaultDebateFields ────────────────────

    describe('createDefaultDebateFields', () => {
        it('returns null/false/0 defaults', () => {
            const fields = createDefaultDebateFields();
            assert.equal(fields.debateState, null);
            assert.equal(fields.debateRound, 0);
            assert.equal(fields.debateMaxRounds, 1);
            assert.equal(fields.debateAgents, null);
            assert.equal(fields.debateActive, false);
            assert.deepEqual(fields.debateRoundEvals, {});
            assert.deepEqual(fields.debateTimings, []);
        });

        it('returns a new object each call', () => {
            const a = createDefaultDebateFields();
            const b = createDefaultDebateFields();
            assert.notEqual(a, b);
            assert.notEqual(a.debateRoundEvals, b.debateRoundEvals);
        });
    });

    // ── transition completeness ──────────────────────

    describe('transition table completeness', () => {
        it('every state has a transition entry', () => {
            for (const state of DEBATE_STATES) {
                assert.ok(
                    DEBATE_TRANSITIONS[state] !== undefined,
                    `Missing transition entry for state: ${state}`,
                );
            }
        });

        it('all transition targets are valid states', () => {
            for (const [from, targets] of Object.entries(DEBATE_TRANSITIONS)) {
                for (const to of targets) {
                    assert.ok(
                        DEBATE_STATES.includes(to),
                        `Invalid target state '${to}' in transition from '${from}'`,
                    );
                }
            }
        });

        it('terminal states have no outgoing transitions', () => {
            for (const state of DEBATE_TERMINAL_STATES) {
                assert.equal(
                    DEBATE_TRANSITIONS[state].length,
                    0,
                    `Terminal state '${state}' should have no transitions`,
                );
            }
        });
    });
});

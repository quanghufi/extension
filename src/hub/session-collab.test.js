// @ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    COLLAB_STATES, COLLAB_TERMINAL_STATES, COLLAB_TURN_BASED_STATES, TURN_STATUS, ADVANCE_ACTIONS,
    defaultAssignments, createDefaultTurn,
    expectedAgentForState, transitionOnAssignments,
    claimStateForAgent, waitingStateForAgent, isCollabTurnBased,
    isValidTransition, validateAdvanceAction, deriveNextCollabState,
} from './session-collab.js';

describe('session-collab', () => {
    describe('Constants', () => {
        it('COLLAB_STATES has 10 states', () => {
            assert.equal(COLLAB_STATES.length, 10);
        });
        it('COLLAB_TERMINAL_STATES is subset of COLLAB_STATES', () => {
            for (const s of COLLAB_TERMINAL_STATES) {
                assert.ok(COLLAB_STATES.includes(s), `${s} should be in COLLAB_STATES`);
            }
        });
        it('TURN_STATUS has idle, claimed, expired', () => {
            assert.deepEqual([...TURN_STATUS], ['idle', 'claimed', 'expired']);
        });
        it('ADVANCE_ACTIONS has 6 actions', () => {
            assert.equal(ADVANCE_ACTIONS.length, 6);
        });
        it('COLLAB_TURN_BASED_STATES has 5 active states', () => {
            assert.deepEqual([...COLLAB_TURN_BASED_STATES], [
                'awaiting_codex_turn',
                'codex_reviewing',
                'awaiting_antigravity_turn',
                'antigravity_reviewing',
                'awaiting_resolution',
            ]);
        });
    });

    describe('defaultAssignments', () => {
        it('returns codex/antigravity/antigravity', () => {
            const a = defaultAssignments();
            assert.equal(a.reviewer, 'codex');
            assert.equal(a.responder, 'antigravity');
            assert.equal(a.decider, 'antigravity');
        });
    });

    describe('createDefaultTurn', () => {
        it('returns idle turn with null fields', () => {
            const t = createDefaultTurn();
            assert.equal(t.status, 'idle');
            assert.equal(t.ownerId, null);
            assert.equal(t.token, null);
        });
    });

    describe('isCollabTurnBased', () => {
        for (const collabState of COLLAB_TURN_BASED_STATES) {
            it(`returns true for ${collabState}`, () => {
                assert.equal(isCollabTurnBased(collabState), true);
            });
        }

        for (const collabState of ['draft', 'awaiting_assignment', 'failed', 'resolved', 'closed']) {
            it(`returns false for ${collabState}`, () => {
                assert.equal(isCollabTurnBased(collabState), false);
            });
        }
    });

    describe('expectedAgentForState', () => {
        const a = defaultAssignments();
        it('awaiting_codex_turn → reviewer', () => {
            assert.equal(expectedAgentForState('awaiting_codex_turn', a), 'codex');
        });
        it('codex_reviewing → reviewer', () => {
            assert.equal(expectedAgentForState('codex_reviewing', a), 'codex');
        });
        it('awaiting_antigravity_turn → responder', () => {
            assert.equal(expectedAgentForState('awaiting_antigravity_turn', a), 'antigravity');
        });
        it('awaiting_resolution → decider', () => {
            assert.equal(expectedAgentForState('awaiting_resolution', a), 'antigravity');
        });
        it('draft → null', () => {
            assert.equal(expectedAgentForState('draft', a), null);
        });
    });

    describe('transitionOnAssignments', () => {
        it('both assigned → awaiting_codex_turn', () => {
            assert.equal(transitionOnAssignments(defaultAssignments()), 'awaiting_codex_turn');
        });
        it('no reviewer → awaiting_assignment', () => {
            assert.equal(transitionOnAssignments({ reviewer: '', responder: 'x', decider: 'x' }), 'awaiting_assignment');
        });
    });

    describe('claimStateForAgent / waitingStateForAgent', () => {
        const a = defaultAssignments();
        it('reviewer → codex_reviewing / awaiting_codex_turn', () => {
            assert.equal(claimStateForAgent('codex', a), 'codex_reviewing');
            assert.equal(waitingStateForAgent('codex', a), 'awaiting_codex_turn');
        });
        it('responder → antigravity_reviewing / awaiting_antigravity_turn', () => {
            assert.equal(claimStateForAgent('antigravity', a), 'antigravity_reviewing');
            assert.equal(waitingStateForAgent('antigravity', a), 'awaiting_antigravity_turn');
        });
        it('unknown agent throws', () => {
            assert.throws(() => claimStateForAgent('unknown', a), /not assigned/);
        });
    });

    describe('isValidTransition', () => {
        it('draft → awaiting_assignment: valid', () => {
            assert.ok(isValidTransition('draft', 'awaiting_assignment'));
        });
        it('draft → codex_reviewing: invalid', () => {
            assert.ok(!isValidTransition('draft', 'codex_reviewing'));
        });
        it('closed → anything: invalid', () => {
            assert.ok(!isValidTransition('closed', 'draft'));
        });
        it('failed → awaiting_codex_turn: valid (recovery)', () => {
            assert.ok(isValidTransition('failed', 'awaiting_codex_turn'));
        });
    });

    describe('validateAdvanceAction', () => {
        const a = defaultAssignments();
        it('review_complete from codex_reviewing by codex: valid', () => {
            const r = validateAdvanceAction({
                collabState: 'codex_reviewing', action: 'review_complete',
                agentId: 'codex', assignments: a,
            });
            assert.ok(r.valid);
        });
        it('review_complete from draft: invalid', () => {
            const r = validateAdvanceAction({
                collabState: 'draft', action: 'review_complete',
                agentId: 'codex', assignments: a,
            });
            assert.ok(!r.valid);
        });
        it('review_complete by wrong agent: invalid', () => {
            const r = validateAdvanceAction({
                collabState: 'codex_reviewing', action: 'review_complete',
                agentId: 'antigravity', assignments: a,
            });
            assert.ok(!r.valid);
        });
        it('resolve from awaiting_resolution by decider: valid', () => {
            const r = validateAdvanceAction({
                collabState: 'awaiting_resolution', action: 'resolve',
                agentId: 'antigravity', assignments: a, isDecider: true,
            });
            assert.ok(r.valid);
        });
        it('resolve by non-decider: invalid', () => {
            const r = validateAdvanceAction({
                collabState: 'awaiting_resolution', action: 'resolve',
                agentId: 'codex', assignments: a,
            });
            assert.ok(!r.valid);
        });
        it('unknown action: invalid', () => {
            const r = validateAdvanceAction({
                collabState: 'codex_reviewing', action: 'bogus',
                agentId: 'codex', assignments: a,
            });
            assert.ok(!r.valid);
        });
    });

    describe('deriveNextCollabState', () => {
        const a = defaultAssignments();
        it('review_complete from codex_reviewing → awaiting_antigravity_turn', () => {
            const r = deriveNextCollabState({
                collabState: 'codex_reviewing', action: 'review_complete',
                agentId: 'codex', assignments: a,
            });
            assert.equal(r.nextState, 'awaiting_antigravity_turn');
        });
        it('review_complete with skipResponse → awaiting_resolution', () => {
            const r = deriveNextCollabState({
                collabState: 'codex_reviewing', action: 'review_complete',
                agentId: 'codex', assignments: a, payload: { skipResponse: true },
            });
            assert.equal(r.nextState, 'awaiting_resolution');
        });
        it('review_complete from antigravity_reviewing → awaiting_resolution', () => {
            const r = deriveNextCollabState({
                collabState: 'antigravity_reviewing', action: 'review_complete',
                agentId: 'antigravity', assignments: a,
            });
            assert.equal(r.nextState, 'awaiting_resolution');
        });
        it('request_rerun → awaiting_codex_turn with pendingAction', () => {
            const r = deriveNextCollabState({
                collabState: 'antigravity_reviewing', action: 'request_rerun',
                agentId: 'antigravity', assignments: a,
            });
            assert.equal(r.nextState, 'awaiting_codex_turn');
            assert.ok(r.pendingAction);
            assert.equal(r.pendingAction?.type, 'rerun');
        });
        it('resolve → resolved', () => {
            const r = deriveNextCollabState({
                collabState: 'awaiting_resolution', action: 'resolve',
                agentId: 'antigravity', assignments: a,
            });
            assert.equal(r.nextState, 'resolved');
        });
        it('close → closed', () => {
            const r = deriveNextCollabState({
                collabState: 'resolved', action: 'close',
                agentId: 'antigravity', assignments: a,
            });
            assert.equal(r.nextState, 'closed');
        });
        it('release_turn returns to waiting state', () => {
            const r = deriveNextCollabState({
                collabState: 'codex_reviewing', action: 'release_turn',
                agentId: 'codex', assignments: a,
            });
            assert.equal(r.nextState, 'awaiting_codex_turn');
        });
    });
});

// @ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Session } from './session.js';

describe('session-collab-integration', () => {
    /** Helper: create a session with default assignments */
    function createTestSession() {
        const session = new Session({
            projectDir: '/test',
            prompt: 'test review',
            agentId: 'codex',
        });
        session.initCollab();
        return session;
    }

    describe('Session detail contains collaboration fields', () => {
        it('toJSON includes collabState, assignments, turn, messages', () => {
            const session = createTestSession();
            const json = session.toJSON();

            assert.ok('collabState' in json, 'toJSON must include collabState');
            assert.ok('assignments' in json, 'toJSON must include assignments');
            assert.ok('turn' in json, 'toJSON must include turn');
            assert.ok('messages' in json, 'toJSON must include messages');
        });

        it('toJSON redacts turn token', () => {
            const session = createTestSession();
            session.claimTurn('codex');
            const json = session.toJSON();

            assert.equal(json.turn.token, undefined, 'turn token must be redacted');
            assert.equal(json.turn.ownerId, 'codex');
            assert.equal(json.turn.status, 'claimed');
        });

        it('toJSON redacts message turnToken', () => {
            const session = createTestSession();
            const { token } = session.claimTurn('codex');
            session.addMessage({
                agentId: 'codex',
                role: 'reviewer',
                type: 'review_summary',
                content: 'Found 3 issues',
                turnToken: token,
            });
            const json = session.toJSON();

            assert.equal(json.messages.length, 1);
            assert.equal(json.messages[0].turnToken, undefined, 'message turnToken must be redacted');
        });

        it('toSummaryJSON includes collabState, assignments, messageCount', () => {
            const session = createTestSession();
            const summary = session.toSummaryJSON();

            assert.ok('collabState' in summary);
            assert.ok('assignments' in summary);
            assert.ok('messageCount' in summary);
        });
    });

    describe('End-to-end collaboration flow', () => {
        it('full flow: create → assign → claim → message → advance → resolve', () => {
            const session = createTestSession();

            // Step 1: Initial state after initCollab
            assert.equal(session.collabState, 'awaiting_codex_turn', 'should start at awaiting_codex_turn');
            assert.equal(session.assignments.reviewer, 'codex');
            assert.equal(session.assignments.responder, 'antigravity');
            assert.equal(session.assignments.decider, 'antigravity');

            // Step 2: Codex claims turn
            const { token: codexToken } = session.claimTurn('codex');
            assert.equal(session.collabState, 'codex_reviewing');
            assert.equal(session.turn.ownerId, 'codex');
            assert.equal(session.turn.status, 'claimed');
            assert.ok(codexToken);

            // Step 3: Codex posts review summary
            const msg1 = session.addMessage({
                agentId: 'codex',
                role: 'reviewer',
                type: 'review_summary',
                content: 'Found 2 issues in server.js',
                turnToken: codexToken,
            });
            assert.equal(msg1.type, 'review_summary');
            assert.equal(session.messages.length, 1);

            // Step 4: Codex advances → Antigravity's turn
            const advance1 = session.advanceCollabState('review_complete', 'codex');
            assert.equal(advance1.previousState, 'codex_reviewing');
            assert.equal(advance1.nextState, 'awaiting_antigravity_turn');
            assert.equal(session.collabState, 'awaiting_antigravity_turn');
            assert.equal(session.turn.status, 'idle', 'turn should be released after advance');

            // Step 5: Antigravity claims turn
            const { token: agToken } = session.claimTurn('antigravity');
            assert.equal(session.collabState, 'antigravity_reviewing');
            assert.ok(agToken);

            // Step 6: Antigravity posts reply
            const msg2 = session.addMessage({
                agentId: 'antigravity',
                role: 'responder',
                type: 'finding_reply',
                content: 'Issue 1 is a false positive',
                turnToken: agToken,
            });
            assert.equal(msg2.type, 'finding_reply');
            assert.equal(session.messages.length, 2);

            // Step 7: Antigravity advances → review complete
            const advance2 = session.advanceCollabState('review_complete', 'antigravity');
            assert.equal(advance2.nextState, 'awaiting_resolution');

            // Step 8: Decider (antigravity) advances → resolve
            const advance3 = session.advanceCollabState('resolve', 'antigravity');
            assert.equal(advance3.nextState, 'resolved');
            assert.equal(session.collabState, 'resolved');

            // Step 9: Close
            const advance4 = session.advanceCollabState('close', 'antigravity');
            assert.equal(advance4.nextState, 'closed');
            assert.ok(session.isCollabTerminal());
        });

        it('message list filtering works for UI timeline', () => {
            const session = createTestSession();
            const { token } = session.claimTurn('codex');

            session.addMessage({
                agentId: 'codex', role: 'reviewer', type: 'review_summary',
                content: 'Summary', turnToken: token,
            });
            session.addMessage({
                agentId: 'codex', role: 'reviewer', type: 'note',
                content: 'A note',
            });

            // Filter by type
            const summaries = session.listMessages({ types: ['review_summary'] });
            assert.equal(summaries.length, 1);
            assert.equal(summaries[0].type, 'review_summary');

            // Filter by agent
            const codexMsgs = session.listMessages({ agentId: 'codex' });
            assert.equal(codexMsgs.length, 2);

            // All messages
            const all = session.listMessages();
            assert.equal(all.length, 2);
        });

        it('claim turn fails for wrong agent', () => {
            const session = createTestSession();
            assert.throws(
                () => session.claimTurn('antigravity'),
                /cannot claim turn/i,
            );
        });

        it('turn-sensitive message fails without token', () => {
            const session = createTestSession();
            session.claimTurn('codex');
            assert.throws(
                () => session.addMessage({
                    agentId: 'codex', role: 'reviewer',
                    type: 'review_summary', content: 'test',
                }),
                /requires a valid turn token/i,
            );
        });
    });
});

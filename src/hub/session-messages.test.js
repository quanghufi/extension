// @ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    MESSAGE_TYPES, MESSAGE_TYPES_REQUIRING_TURN,
    buildSessionMessage, validateFindingRefs, validateReplyTarget,
    filterMessages,
} from './session-messages.js';

/**
 * Helper to create a minimal session-like object for testing.
 * @param {Array<import('./session-messages.js').SessionMessage>} [msgs]
 */
function fakeSession(msgs = []) {
    return {
        id: 'test-session-1',
        messages: msgs,
        messageSeqCounter: msgs.length,
        groupedFindings: [
            { dedupe_key: 'dk-1', finding: { id: 'f-1' } },
            { dedupe_key: 'dk-2', finding: { id: 'f-2' } },
        ],
    };
}

describe('session-messages', () => {
    describe('MESSAGE_TYPES', () => {
        it('has 7 types', () => {
            assert.equal(MESSAGE_TYPES.length, 7);
        });
        it('requiring turn is subset of all types', () => {
            for (const t of MESSAGE_TYPES_REQUIRING_TURN) {
                assert.ok(MESSAGE_TYPES.includes(t), `${t} should be a valid message type`);
            }
        });
    });

    describe('buildSessionMessage', () => {
        it('creates a valid note message', () => {
            const session = fakeSession();
            const msg = buildSessionMessage({
                session,
                agentId: 'codex',
                role: 'reviewer',
                type: 'note',
                content: 'Hello world',
            });
            assert.ok(msg.id.startsWith('msg-'));
            assert.equal(msg.sessionId, 'test-session-1');
            assert.equal(msg.seq, 0);
            assert.equal(msg.agentId, 'codex');
            assert.equal(msg.role, 'reviewer');
            assert.equal(msg.type, 'note');
            assert.equal(msg.content, 'Hello world');
            assert.deepEqual(msg.findingRefs, []);
            assert.equal(msg.replyToMessageId, null);
            assert.equal(msg.turnToken, null);
        });

        it('rejects empty content', () => {
            const session = fakeSession();
            assert.throws(() => buildSessionMessage({
                session, agentId: 'codex', role: 'reviewer', type: 'note',
                content: '   ',
            }), /non-empty/);
        });

        it('rejects invalid type', () => {
            const session = fakeSession();
            assert.throws(() => buildSessionMessage({
                session, agentId: 'codex', role: 'reviewer', type: 'bogus',
                content: 'test',
            }), /Invalid message type/);
        });

        it('rejects invalid role', () => {
            const session = fakeSession();
            assert.throws(() => buildSessionMessage({
                session, agentId: 'codex', role: 'bogus', type: 'note',
                content: 'test',
            }), /Invalid message role/);
        });

        it('rejects invalid replyToMessageId', () => {
            const session = fakeSession();
            assert.throws(() => buildSessionMessage({
                session, agentId: 'codex', role: 'reviewer', type: 'note',
                content: 'test', replyToMessageId: 'non-existent',
            }), /Reply target not found/);
        });
    });

    describe('validateFindingRefs', () => {
        it('passes for valid refs', () => {
            const session = fakeSession();
            assert.doesNotThrow(() => {
                validateFindingRefs(session, [{ findingId: 'f-1' }, { dedupeKey: 'dk-2' }]);
            });
        });

        it('throws for invalid findingId', () => {
            const session = fakeSession();
            assert.throws(() => {
                validateFindingRefs(session, [{ findingId: 'f-999' }]);
            }, /Finding ref not found/);
        });

        it('throws for invalid dedupeKey', () => {
            const session = fakeSession();
            assert.throws(() => {
                validateFindingRefs(session, [{ dedupeKey: 'dk-999' }]);
            }, /Finding ref not found/);
        });

        it('throws for ref with neither findingId nor dedupeKey', () => {
            const session = fakeSession();
            assert.throws(() => {
                validateFindingRefs(session, [{}]);
            }, /at least findingId or dedupeKey/);
        });

        it('no-op for empty refs', () => {
            const session = fakeSession();
            assert.doesNotThrow(() => validateFindingRefs(session, []));
        });
    });

    describe('validateReplyTarget', () => {
        it('passes for existing message', () => {
            const msg = buildSessionMessage({
                session: fakeSession(), agentId: 'codex', role: 'reviewer',
                type: 'note', content: 'hello',
            });
            assert.doesNotThrow(() => validateReplyTarget([msg], msg.id));
        });

        it('throws for non-existing message', () => {
            assert.throws(() => validateReplyTarget([], 'non-existent'), /Reply target not found/);
        });
    });

    describe('filterMessages', () => {
        const session = fakeSession();
        const msgs = [
            buildSessionMessage({ session: { ...session, messageSeqCounter: 0 }, agentId: 'codex', role: 'reviewer', type: 'note', content: 'msg1' }),
            buildSessionMessage({ session: { ...session, messageSeqCounter: 1 }, agentId: 'antigravity', role: 'responder', type: 'review_summary', content: 'msg2' }),
            buildSessionMessage({ session: { ...session, messageSeqCounter: 2 }, agentId: 'codex', role: 'reviewer', type: 'finding_reply', content: 'msg3' }),
            buildSessionMessage({ session: { ...session, messageSeqCounter: 3 }, agentId: 'antigravity', role: 'responder', type: 'note', content: 'msg4' }),
        ];

        it('returns all messages with no filters', () => {
            assert.equal(filterMessages(msgs).length, 4);
        });

        it('afterSeq filters correctly', () => {
            assert.equal(filterMessages(msgs, { afterSeq: 1 }).length, 2);
        });

        it('limit works', () => {
            assert.equal(filterMessages(msgs, { limit: 2 }).length, 2);
        });

        it('types filter works', () => {
            const result = filterMessages(msgs, { types: ['note'] });
            assert.equal(result.length, 2);
            assert.ok(result.every(m => m.type === 'note'));
        });

        it('agentId filter works', () => {
            const result = filterMessages(msgs, { agentId: 'codex' });
            assert.equal(result.length, 2);
            assert.ok(result.every(m => m.agentId === 'codex'));
        });

        it('multiple filters compose', () => {
            const result = filterMessages(msgs, { afterSeq: 0, agentId: 'antigravity', limit: 1 });
            assert.equal(result.length, 1);
            assert.equal(result[0].agentId, 'antigravity');
        });
    });
});

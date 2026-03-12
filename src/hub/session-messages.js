// @ts-check
/**
 * Session Message Model — schema, validation, and filtering.
 *
 * Handles message construction, content/ref validation, and query filtering
 * for the collaboration message thread.
 *
 * @module hub/session-messages
 */

import { v4 as uuidv4 } from 'uuid';

// ── Constants ────────────────────────────────────────

/** @type {readonly string[]} */
export const MESSAGE_TYPES = /** @type {const} */ ([
    'note',
    'review_summary',
    'finding_reply',
    'decision',
    'rerun_request',
    'resolution',
    'system',
]);

/** Types that require the sender to own the current turn */
export const MESSAGE_TYPES_REQUIRING_TURN = /** @type {const} */ ([
    'review_summary',
    'finding_reply',
    'decision',
    'rerun_request',
    'resolution',
]);

/** Types that should validate finding refs when refs are provided */
export const MESSAGE_TYPES_REQUIRING_FINDING_REF = /** @type {const} */ ([
    'finding_reply',
    'decision',
    'rerun_request',
    'resolution',
]);

/** @type {readonly string[]} */
export const MESSAGE_ROLES = /** @type {const} */ ([
    'reviewer',
    'responder',
    'decider',
    'system',
]);

// ── Message Factory ──────────────────────────────────

/**
 * @typedef {object} SessionMessage
 * @property {string} id
 * @property {string} sessionId
 * @property {number} seq
 * @property {string} createdAt
 * @property {string} agentId
 * @property {string} role
 * @property {string} type
 * @property {string} content
 * @property {Array<{findingId?: string, dedupeKey?: string}>} findingRefs
 * @property {string|null} replyToMessageId
 * @property {string|null} turnToken
 * @property {Record<string, unknown>} metadata
 */

/**
 * Build and validate a session message.
 *
 * @param {object} input
 * @param {{ id: string, messages: SessionMessage[], messageSeqCounter: number }} input.session
 * @param {string} input.agentId
 * @param {string} input.role
 * @param {string} input.type
 * @param {string} input.content
 * @param {Array<{findingId?: string, dedupeKey?: string}>} [input.findingRefs]
 * @param {string|null} [input.replyToMessageId]
 * @param {string|null} [input.turnToken]
 * @param {Record<string, unknown>} [input.metadata]
 * @returns {SessionMessage}
 */
export function buildSessionMessage({
    session,
    agentId,
    role,
    type,
    content,
    findingRefs = [],
    replyToMessageId = null,
    turnToken = null,
    metadata = {},
}) {
    // Validate type
    if (!MESSAGE_TYPES.includes(type)) {
        throw new Error(`Invalid message type: ${type}. Must be one of: ${MESSAGE_TYPES.join(', ')}`);
    }

    // Validate role
    if (!MESSAGE_ROLES.includes(role)) {
        throw new Error(`Invalid message role: ${role}. Must be one of: ${MESSAGE_ROLES.join(', ')}`);
    }

    // Validate content
    const trimmedContent = (content ?? '').trim();
    if (!trimmedContent) {
        throw new Error('Message content must be non-empty after trim');
    }

    // Validate replyToMessageId
    if (replyToMessageId != null) {
        validateReplyTarget(session.messages, replyToMessageId);
    }

    return {
        id: `msg-${uuidv4().slice(0, 12)}`,
        sessionId: session.id,
        seq: session.messageSeqCounter,
        createdAt: new Date().toISOString(),
        agentId,
        role,
        type,
        content: trimmedContent,
        findingRefs: findingRefs ?? [],
        replyToMessageId: replyToMessageId ?? null,
        turnToken: turnToken ?? null,
        metadata: metadata ?? {},
    };
}

// ── Validation Helpers ───────────────────────────────

/**
 * Validate that finding refs exist in session findings.
 *
 * @param {{ groupedFindings: Array<{dedupe_key: string, finding: {id: string}}> }} session
 * @param {Array<{findingId?: string, dedupeKey?: string}>} refs
 * @throws {Error} if any ref doesn't match a known finding
 */
export function validateFindingRefs(session, refs) {
    if (!refs || refs.length === 0) return;

    const knownIds = new Set();
    const knownKeys = new Set();

    for (const f of session.groupedFindings) {
        knownKeys.add(f.dedupe_key);
        knownIds.add(f.finding.id);
    }

    for (const ref of refs) {
        if (ref.findingId && !knownIds.has(ref.findingId)) {
            throw new Error(`Finding ref not found: findingId="${ref.findingId}"`);
        }
        if (ref.dedupeKey && !knownKeys.has(ref.dedupeKey)) {
            throw new Error(`Finding ref not found: dedupeKey="${ref.dedupeKey}"`);
        }
        if (!ref.findingId && !ref.dedupeKey) {
            throw new Error('Finding ref must have at least findingId or dedupeKey');
        }
    }
}

/**
 * Validate that a reply target message exists.
 *
 * @param {SessionMessage[]} messages
 * @param {string} replyToMessageId
 * @throws {Error} if target message doesn't exist
 */
export function validateReplyTarget(messages, replyToMessageId) {
    const target = messages.find((m) => m.id === replyToMessageId);
    if (!target) {
        throw new Error(`Reply target not found: "${replyToMessageId}"`);
    }
}

// ── Query/Filter ─────────────────────────────────────

/**
 * Filter messages with polling support.
 *
 * @param {SessionMessage[]} messages
 * @param {object} [filters]
 * @param {number} [filters.afterSeq] — only return messages with seq > afterSeq
 * @param {number} [filters.limit] — max messages to return
 * @param {string[]} [filters.types] — filter by message types
 * @param {string} [filters.agentId] — filter by agentId
 * @returns {SessionMessage[]}
 */
export function filterMessages(messages, filters = {}) {
    let result = messages;

    if (filters.afterSeq != null) {
        result = result.filter((m) => m.seq > filters.afterSeq);
    }

    if (filters.types && filters.types.length > 0) {
        const typeSet = new Set(filters.types);
        result = result.filter((m) => typeSet.has(m.type));
    }

    if (filters.agentId) {
        result = result.filter((m) => m.agentId === filters.agentId);
    }

    if (filters.limit != null && filters.limit > 0) {
        result = result.slice(0, filters.limit);
    }

    return result;
}

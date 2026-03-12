// @ts-check
/**
 * Collaboration State Machine — pure functions, no I/O.
 *
 * Source of truth for collab states, transitions, turn lifecycle,
 * and advance-action validation.
 *
 * @module hub/session-collab
 */

// ── Constants ────────────────────────────────────────

/** @type {readonly string[]} */
export const COLLAB_STATES = /** @type {const} */ ([
    'draft',
    'awaiting_assignment',
    'awaiting_codex_turn',
    'codex_reviewing',
    'awaiting_antigravity_turn',
    'antigravity_reviewing',
    'awaiting_resolution',
    'resolved',
    'closed',
    'failed',
]);

/** @type {readonly string[]} */
export const COLLAB_TERMINAL_STATES = /** @type {const} */ ([
    'resolved',
    'closed',
]);

/** @type {readonly string[]} */
export const TURN_STATUS = /** @type {const} */ ([
    'idle',
    'claimed',
    'expired',
]);

/** @type {readonly string[]} */
export const ADVANCE_ACTIONS = /** @type {const} */ ([
    'review_complete',
    'request_response',
    'request_rerun',
    'resolve',
    'close',
    'release_turn',
]);

// ── Transition Table ─────────────────────────────────

/** @type {Record<string, readonly string[]>} */
const TRANSITIONS = Object.freeze({
    draft: ['awaiting_assignment'],
    awaiting_assignment: ['awaiting_codex_turn', 'awaiting_antigravity_turn', 'failed'],
    awaiting_codex_turn: ['codex_reviewing'],
    codex_reviewing: ['awaiting_antigravity_turn', 'awaiting_resolution', 'failed'],
    awaiting_antigravity_turn: ['antigravity_reviewing'],
    antigravity_reviewing: ['awaiting_codex_turn', 'awaiting_resolution', 'failed'],
    awaiting_resolution: ['awaiting_codex_turn', 'awaiting_antigravity_turn', 'resolved', 'closed', 'failed'],
    resolved: ['closed'],
    failed: ['awaiting_codex_turn', 'awaiting_antigravity_turn'],
    closed: [],
});

// ── Default Factories ────────────────────────────────

/**
 * @returns {{ reviewer: string, responder: string, decider: string }}
 */
export function defaultAssignments() {
    return {
        reviewer: 'codex',
        responder: 'antigravity',
        decider: 'antigravity',
    };
}

/**
 * @returns {{ status: string, ownerId: string|null, claimedAt: string|null, claimExpiresAt: string|null, token: string|null }}
 */
export function createDefaultTurn() {
    return {
        status: 'idle',
        ownerId: null,
        claimedAt: null,
        claimExpiresAt: null,
        token: null,
    };
}

// ── Agent/State Mapping ──────────────────────────────

/**
 * Which agent is expected to act in the given collabState?
 * @param {string} collabState
 * @param {{ reviewer: string, responder: string, decider: string }} assignments
 * @returns {string|null}
 */
export function expectedAgentForState(collabState, assignments) {
    switch (collabState) {
        case 'awaiting_codex_turn':
        case 'codex_reviewing':
            return assignments.reviewer;
        case 'awaiting_antigravity_turn':
        case 'antigravity_reviewing':
            return assignments.responder;
        case 'awaiting_resolution':
            return assignments.decider;
        default:
            return null;
    }
}

/**
 * Given assignments, determine the initial collab state.
 * @param {{ reviewer: string, responder: string, decider: string }} assignments
 * @returns {string}
 */
export function transitionOnAssignments(assignments) {
    if (assignments.reviewer && assignments.responder) {
        return 'awaiting_codex_turn';
    }
    return 'awaiting_assignment';
}

/**
 * Get the "reviewing" state for an agent.
 * @param {string} agentId
 * @param {{ reviewer: string, responder: string }} assignments
 * @returns {string}
 */
export function claimStateForAgent(agentId, assignments) {
    if (agentId === assignments.reviewer) return 'codex_reviewing';
    if (agentId === assignments.responder) return 'antigravity_reviewing';
    throw new Error(`Agent "${agentId}" is not assigned as reviewer or responder`);
}

/**
 * Get the "awaiting" state for an agent.
 * @param {string} agentId
 * @param {{ reviewer: string, responder: string }} assignments
 * @returns {string}
 */
export function waitingStateForAgent(agentId, assignments) {
    if (agentId === assignments.reviewer) return 'awaiting_codex_turn';
    if (agentId === assignments.responder) return 'awaiting_antigravity_turn';
    throw new Error(`Agent "${agentId}" is not assigned as reviewer or responder`);
}

// ── Transition Validation ────────────────────────────

/**
 * @param {string} from
 * @param {string} to
 * @returns {boolean}
 */
export function isValidTransition(from, to) {
    const allowed = TRANSITIONS[from];
    return allowed ? allowed.includes(to) : false;
}

// ── Advance Action Validation ────────────────────────

/**
 * Validate whether an advance action is permitted.
 *
 * @param {object} ctx
 * @param {string} ctx.collabState
 * @param {string} ctx.action
 * @param {string} ctx.agentId
 * @param {{ reviewer: string, responder: string, decider: string }} ctx.assignments
 * @param {boolean} [ctx.isDecider]
 * @returns {{ valid: boolean, reason?: string }}
 */
export function validateAdvanceAction({ collabState, action, agentId, assignments, isDecider }) {
    if (!ADVANCE_ACTIONS.includes(action)) {
        return { valid: false, reason: `Unknown action: ${action}` };
    }

    switch (action) {
        case 'review_complete': {
            const validStates = ['codex_reviewing', 'antigravity_reviewing'];
            if (!validStates.includes(collabState)) {
                return { valid: false, reason: `review_complete requires state codex_reviewing or antigravity_reviewing, got ${collabState}` };
            }
            const expected = expectedAgentForState(collabState, assignments);
            if (expected && expected !== agentId) {
                return { valid: false, reason: `Only ${expected} can complete review in state ${collabState}` };
            }
            return { valid: true };
        }

        case 'request_response': {
            if (collabState !== 'codex_reviewing') {
                return { valid: false, reason: `request_response only valid from codex_reviewing, got ${collabState}` };
            }
            return { valid: true };
        }

        case 'request_rerun': {
            const validStates = ['antigravity_reviewing', 'awaiting_resolution'];
            if (!validStates.includes(collabState)) {
                return { valid: false, reason: `request_rerun requires antigravity_reviewing or awaiting_resolution, got ${collabState}` };
            }
            return { valid: true };
        }

        case 'resolve': {
            if (collabState !== 'awaiting_resolution') {
                return { valid: false, reason: `resolve only valid from awaiting_resolution, got ${collabState}` };
            }
            if (!isDecider && agentId !== assignments.decider) {
                return { valid: false, reason: `Only decider (${assignments.decider}) can resolve` };
            }
            return { valid: true };
        }

        case 'close': {
            const validStates = ['resolved', 'awaiting_resolution'];
            if (!validStates.includes(collabState)) {
                return { valid: false, reason: `close requires resolved or awaiting_resolution, got ${collabState}` };
            }
            if (!isDecider && agentId !== assignments.decider) {
                return { valid: false, reason: `Only decider (${assignments.decider}) can close` };
            }
            return { valid: true };
        }

        case 'release_turn': {
            const activeTurnStates = ['codex_reviewing', 'antigravity_reviewing'];
            if (!activeTurnStates.includes(collabState)) {
                return { valid: false, reason: `release_turn requires active reviewing state, got ${collabState}` };
            }
            return { valid: true };
        }

        default:
            return { valid: false, reason: `Unhandled action: ${action}` };
    }
}

// ── Derive Next State ────────────────────────────────

/**
 * Derive the next collab state from an advance action.
 *
 * @param {object} ctx
 * @param {string} ctx.collabState
 * @param {string} ctx.action
 * @param {string} ctx.agentId
 * @param {{ reviewer: string, responder: string, decider: string }} ctx.assignments
 * @param {Record<string, unknown>} [ctx.payload]
 * @returns {{ nextState: string, pendingAction?: { type: string, [key: string]: unknown } }}
 */
export function deriveNextCollabState({ collabState, action, agentId, assignments, payload }) {
    switch (action) {
        case 'review_complete': {
            if (collabState === 'codex_reviewing') {
                // After codex review, pass to antigravity unless explicitly going to resolution
                const goToResolution = payload?.skipResponse === true;
                return { nextState: goToResolution ? 'awaiting_resolution' : 'awaiting_antigravity_turn' };
            }
            // antigravity_reviewing → awaiting_resolution
            return { nextState: 'awaiting_resolution' };
        }

        case 'request_response':
            return { nextState: 'awaiting_antigravity_turn' };

        case 'request_rerun':
            return {
                nextState: 'awaiting_codex_turn',
                pendingAction: {
                    type: 'rerun',
                    requestedBy: agentId,
                    context: payload?.context ?? null,
                },
            };

        case 'resolve':
            return { nextState: 'resolved' };

        case 'close':
            return { nextState: 'closed' };

        case 'release_turn': {
            // Return to waiting state for the same agent
            return { nextState: waitingStateForAgent(agentId, assignments) };
        }

        default:
            throw new Error(`Cannot derive next state for unknown action: ${action}`);
    }
}

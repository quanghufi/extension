// @ts-check
/**
 * Debate State Machine — pure functions, no I/O.
 *
 * Source of truth for debate lifecycle states, valid transitions,
 * and state derivation from events. Mirrors session-collab.js pattern.
 *
 * @module hub/debate-state
 */

// ── Constants ────────────────────────────────────────

/** @type {readonly string[]} */
export const DEBATE_STATES = /** @type {const} */ ([
    'idle',
    'reviewing',
    'cross_eval',
    'consensus_check',
    'debate_round',
    'tie_break',
    'resolved',
    'failed',
]);

/** @type {readonly string[]} */
export const DEBATE_TERMINAL_STATES = /** @type {const} */ ([
    'resolved',
    'failed',
]);

// ── Transition Table ─────────────────────────────────

/** @type {Readonly<Record<string, readonly string[]>>} */
const DEBATE_TRANSITIONS = Object.freeze({
    idle:             ['reviewing'],
    reviewing:        ['cross_eval', 'failed'],
    cross_eval:       ['consensus_check', 'failed'],
    consensus_check:  ['resolved', 'debate_round', 'tie_break'],
    debate_round:     ['cross_eval', 'failed'],
    tie_break:        ['resolved'],
    resolved:         [],
    failed:           [],
});

// ── Event Types ──────────────────────────────────────

/**
 * Events that can trigger state transitions.
 * @type {readonly string[]}
 */
export const DEBATE_EVENTS = /** @type {const} */ ([
    'start',             // idle → reviewing
    'all_reviews_done',  // reviewing → cross_eval
    'all_evals_done',    // cross_eval → consensus_check
    'consensus_reached', // consensus_check → resolved
    'no_consensus',      // consensus_check → debate_round
    'max_rounds',        // consensus_check → tie_break
    'rebuttals_done',    // debate_round → cross_eval
    'tie_broken',        // tie_break → resolved
    'error',             // any non-terminal → failed
]);

// ── Event → Transition Map ───────────────────────────

/**
 * Maps (currentState, event) → nextState.
 * @type {Readonly<Record<string, Record<string, string>>>}
 */
const EVENT_MAP = Object.freeze({
    idle: {
        start: 'reviewing',
        error: 'failed',
    },
    reviewing: {
        all_reviews_done: 'cross_eval',
        error: 'failed',
    },
    cross_eval: {
        all_evals_done: 'consensus_check',
        error: 'failed',
    },
    consensus_check: {
        consensus_reached: 'resolved',
        no_consensus: 'debate_round',
        max_rounds: 'tie_break',
        error: 'failed',
    },
    debate_round: {
        rebuttals_done: 'cross_eval',
        error: 'failed',
    },
    tie_break: {
        tie_broken: 'resolved',
        error: 'failed',
    },
    resolved: {},
    failed: {},
});

// ── Validation ───────────────────────────────────────

/**
 * Check if a transition from one state to another is valid.
 * @param {string} from
 * @param {string} to
 * @returns {boolean}
 */
export function validateDebateTransition(from, to) {
    const allowed = DEBATE_TRANSITIONS[from];
    if (!allowed) return false;
    return allowed.includes(to);
}

/**
 * Check if a state is a terminal (final) state.
 * @param {string} state
 * @returns {boolean}
 */
export function isDebateTerminal(state) {
    return DEBATE_TERMINAL_STATES.includes(state);
}

/**
 * Check if a state is a valid debate state.
 * @param {string} state
 * @returns {boolean}
 */
export function isValidDebateState(state) {
    return DEBATE_STATES.includes(state);
}

// ── State Derivation ─────────────────────────────────

/**
 * Derive the next debate state from the current state and an event.
 *
 * @param {string} currentState - Current debate state
 * @param {string} event - Event that occurred
 * @returns {{ state: string, valid: boolean }}
 */
export function deriveNextDebateState(currentState, event) {
    const stateMap = EVENT_MAP[currentState];
    if (!stateMap) {
        return { state: currentState, valid: false };
    }

    const nextState = stateMap[event];
    if (!nextState) {
        return { state: currentState, valid: false };
    }

    return { state: nextState, valid: true };
}

// ── Default Factory ──────────────────────────────────

/**
 * Create default debate state fields for a session.
 * All null/false/0 for backward-compatible defaults.
 *
 * @returns {{
 *   debateState: null,
 *   debateRound: number,
 *   debateMaxRounds: number,
 *   debateAgents: null,
 *   debateActive: boolean,
 *   debateRoundEvals: Record<string, never>,
 *   debateTimings: any[],
 * }}
 */
export function createDefaultDebateFields() {
    return {
        debateState: null,
        debateRound: 0,
        debateMaxRounds: 3,
        debateAgents: null,
        debateActive: false,
        debateRoundEvals: {},
        debateTimings: [],
    };
}

export { DEBATE_TRANSITIONS };

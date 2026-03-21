// @ts-check
/**
 * Agent Registry — tracks agent lifecycle with validated state machine.
 *
 * State machine transitions:
 *   pending → running
 *   running → completed | failed | cancelled
 *   failed  → running   (retry)
 *   completed → running (another debate/rebuttal pass)
 *
 * @module hub/agent-registry
 */

// ── Transition Table ─────────────────────────────────

/** @type {Record<string, readonly string[]>} */
const TRANSITIONS = {
    pending:   ['running'],
    running:   ['completed', 'failed', 'cancelled'],
    failed:    ['running'],
    completed: ['running'],
    cancelled: [],
};

// ── Custom Error ─────────────────────────────────────

export class InvalidTransitionError extends Error {
    /**
     * @param {string} agentId
     * @param {string} from
     * @param {string} to
     */
    constructor(agentId, from, to) {
        super(`Invalid transition for agent "${agentId}": ${from} → ${to}`);
        this.name = 'InvalidTransitionError';
        this.agentId = agentId;
        this.from = from;
        this.to = to;
    }
}

// ── AgentRegistry ────────────────────────────────────

export class AgentRegistry {
    constructor() {
        /** @type {Map<string, AgentState>} */
        this._agents = new Map();
    }

    /**
     * Register a new agent with state 'pending'.
     * No-op if already registered.
     * @param {string} agentId
     */
    register(agentId) {
        if (this._agents.has(agentId)) return;
        this._agents.set(agentId, {
            agentId,
            state: 'pending',
            startedAt: null,
            completedAt: null,
            findingCount: 0,
            status: null,
        });
    }

    /**
     * Transition agent to a new state (validated).
     * @param {string} agentId
     * @param {string} newState
     * @param {Partial<Omit<AgentState, 'agentId'|'state'>>} [meta]
     */
    transition(agentId, newState, meta = {}) {
        const agent = this._agents.get(agentId);
        if (!agent) {
            throw new Error(`Agent not registered: "${agentId}"`);
        }
        const allowed = TRANSITIONS[agent.state];
        if (!allowed || !allowed.includes(newState)) {
            throw new InvalidTransitionError(agentId, agent.state, newState);
        }
        agent.state = newState;
        Object.assign(agent, meta);
    }

    /** @param {string} agentId */
    has(agentId) { return this._agents.has(agentId); }

    /** @param {string} agentId */
    get(agentId) { return this._agents.get(agentId); }

    /**
     * Filter agents by state.
     * @param {string} state
     * @returns {AgentState[]}
     */
    allInState(state) {
        return [...this._agents.values()].filter(a => a.state === state);
    }

    /** @returns {Record<string, AgentState>} */
    toJSON() {
        return Object.fromEntries(this._agents);
    }

    /**
     * Reconstruct from plain object.
     * @param {Record<string, AgentState>} obj
     * @returns {AgentRegistry}
     */
    static fromJSON(obj) {
        const reg = new AgentRegistry();
        if (obj && typeof obj === 'object') {
            for (const [key, value] of Object.entries(obj)) {
                reg._agents.set(key, /** @type {AgentState} */ (value));
            }
        }
        return reg;
    }

    /** Iterate entries for compatibility. */
    [Symbol.iterator]() {
        return this._agents.entries();
    }
}

// ── Types ────────────────────────────────────────────

/**
 * @typedef {Object} AgentState
 * @property {string} agentId
 * @property {string} state - 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
 * @property {string|null} startedAt
 * @property {string|null} completedAt
 * @property {number} findingCount
 * @property {string|null} status - 'ok' | 'failed' | 'timeout'
 */

export { TRANSITIONS };

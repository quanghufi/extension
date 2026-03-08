// @ts-check
/**
 * Session Model
 *
 * Manages a review session lifecycle:
 * - Hub-assigned monotonic `seq` on event receipt
 * - Unified terminal state finalization
 * - Retry-as-new-session (parentSessionId isolation)
 * - Finding aggregation with dedup grouping
 *
 * @module hub/session
 */

import { v4 as uuidv4 } from 'uuid';

// ── Constants ────────────────────────────────────────

/** @type {readonly string[]} */
const SESSION_STATES = /** @type {const} */ ([
    'pending', 'running', 'completed', 'failed', 'partial_completion', 'cancelled',
]);

/** @type {readonly string[]} */
const TERMINAL_STATES = /** @type {const} */ ([
    'completed', 'failed', 'partial_completion', 'cancelled',
]);

// ── Session Class ────────────────────────────────────

export class Session {
    /**
     * @param {object} opts
     * @param {string} opts.projectDir - Project directory being reviewed
     * @param {string} opts.prompt - Review prompt
     * @param {string} [opts.id] - Custom session ID
     * @param {string|null} [opts.parentSessionId] - Parent session for retries
     * @param {string} [opts.snapshotPath] - Path to code snapshot
     */
    constructor({ projectDir, prompt, id, parentSessionId, snapshotPath }) {
        /** @type {string} */
        this.id = id ?? uuidv4();

        /** @type {string} */
        this.projectDir = projectDir;

        /** @type {string} */
        this.prompt = prompt;

        /** @type {string|null} */
        this.parentSessionId = parentSessionId ?? null;

        /** @type {string|null} */
        this.snapshotPath = snapshotPath ?? null;

        /** @type {string} */
        this.state = 'pending';

        /** @type {string} */
        this.createdAt = new Date().toISOString();

        /** @type {string|null} */
        this.completedAt = null;

        /** @type {number} */
        this._seqCounter = 0;

        /** @type {import('../schema/events.js').Event[]} */
        this.events = [];

        /** @type {Map<string, AgentState>} */
        this.agents = new Map();

        /** @type {import('../schema/events.js').Finding[]} */
        this.allFindings = [];

        /** @type {import('../schema/events.js').GroupedFinding[]} */
        this.groupedFindings = [];
    }

    // ── Event Management ─────────────────────────────

    /**
     * Add event to session with Hub-assigned seq number.
     * @param {import('../schema/events.js').Event} event
     * @returns {import('../schema/events.js').Event} Event with seq assigned
     */
    addEvent(event) {
        if (this.isTerminal()) {
            throw new Error(`Cannot add events to terminal session (state: ${this.state})`);
        }

        // Hub assigns monotonic seq
        const seqEvent = { ...event, seq: this._seqCounter++ };
        this.events.push(seqEvent);

        // Update agent state
        this._updateAgentState(seqEvent);

        return seqEvent;
    }

    /**
     * Register an agent starting work on this session.
     * @param {string} agentId
     */
    registerAgent(agentId) {
        if (!this.agents.has(agentId)) {
            this.agents.set(agentId, {
                agentId,
                state: 'pending',
                startedAt: null,
                completedAt: null,
                findingCount: 0,
                status: null,
            });
        }
    }

    // ── State Management ─────────────────────────────

    /**
     * Start the session (transition from pending → running).
     */
    start() {
        if (this.state !== 'pending') {
            throw new Error(`Cannot start session in state: ${this.state}`);
        }
        this.state = 'running';
    }

    /**
     * Finalize session with a terminal state.
     * Unified finalization: all terminal states trigger identical cleanup.
     *
     * @param {'completed'|'failed'|'partial_completion'|'cancelled'} finalState
     * @param {import('../schema/events.js').Finding[]} [findings] - Findings from all agents
     */
    finalize(finalState, findings = []) {
        if (!TERMINAL_STATES.includes(finalState)) {
            throw new Error(`Invalid terminal state: ${finalState}`);
        }
        if (this.isTerminal()) {
            return; // Already finalized — idempotent
        }

        this.state = finalState;
        this.completedAt = new Date().toISOString();

        // Collect and group findings
        this.allFindings = findings;
        this.groupedFindings = this._groupFindings(findings);
    }

    /**
     * @returns {boolean}
     */
    isTerminal() {
        return TERMINAL_STATES.includes(this.state);
    }

    // ── Retry Support ────────────────────────────────

    /**
     * Create a retry session linked to this one.
     * The new session is completely isolated (fresh seq, events, findings).
     *
     * @param {object} [overrides]
     * @param {string} [overrides.prompt] - Override prompt for retry
     * @returns {Session}
     */
    createRetry(overrides = {}) {
        return new Session({
            projectDir: this.projectDir,
            prompt: overrides.prompt ?? this.prompt,
            parentSessionId: this.id,
        });
    }

    // ── Finding Aggregation ──────────────────────────

    /**
     * Group findings by dedupe_key across agents.
     * Preserves raw per-agent findings; groups by dedupe_key.
     *
     * @param {import('../schema/events.js').Finding[]} findings
     * @returns {import('../schema/events.js').GroupedFinding[]}
     */
    _groupFindings(findings) {
        /** @type {Map<string, import('../schema/events.js').GroupedFinding>} */
        const groups = new Map();

        for (const finding of findings) {
            const key = finding.dedupe_key;
            if (groups.has(key)) {
                const group = /** @type {import('../schema/events.js').GroupedFinding} */ (groups.get(key));
                // Add agent badge if not already present
                const agentFromEvent = this._findAgentForFinding(finding);
                if (agentFromEvent && !group.agents.includes(agentFromEvent)) {
                    group.agents.push(agentFromEvent);
                }
                group.raw_findings.push(finding);
                // Keep highest severity as representative
                if (severityRank(finding.severity) > severityRank(group.finding.severity)) {
                    group.finding = finding;
                }
            } else {
                const agent = this._findAgentForFinding(finding);
                groups.set(key, {
                    dedupe_key: key,
                    finding,
                    agents: agent ? [agent] : [],
                    raw_findings: [finding],
                });
            }
        }

        return Array.from(groups.values());
    }

    /**
     * Try to determine which agent produced a finding.
     * Matches on dedupe_key since finding IDs are regenerated in parseResult().
     *
     * @param {import('../schema/events.js').Finding} finding
     * @returns {string|null}
     */
    _findAgentForFinding(finding) {
        // Look through events for a finding event matching this finding's dedupe_key
        for (const event of this.events) {
            if (event.event_type === 'finding' && event.payload?.raw?.dedupe_key === finding.dedupe_key) {
                return event.agent_id;
            }
        }
        // Fallback: check if any agent explicitly tagged this finding
        for (const event of this.events) {
            if (event.event_type === 'finding' && event.agent_id) {
                const raw = event.payload?.raw;
                if (raw && (raw.file === finding.file || raw.path === finding.file) &&
                    (raw.summary === finding.summary || raw.message === finding.summary)) {
                    return event.agent_id;
                }
            }
        }
        return null;
    }

    /**
     * Update internal agent state based on event.
     * @param {import('../schema/events.js').Event} event
     */
    _updateAgentState(event) {
        const agentId = event.agent_id;
        this.registerAgent(agentId);
        const agent = /** @type {AgentState} */ (this.agents.get(agentId));

        if (event.event_type === 'status') {
            const payload = /** @type {Record<string, unknown>} */ (event.payload);
            if (payload.state === 'started') {
                agent.state = 'running';
                agent.startedAt = event.timestamp;
            } else if (payload.state === 'done') {
                agent.state = 'completed';
                agent.completedAt = event.timestamp;
                agent.status = /** @type {string|null} */ (payload.status ?? null);
                agent.findingCount = typeof payload.findingCount === 'number' ? payload.findingCount : 0;
            }
        }
    }

    // ── Serialization ────────────────────────────────

    /**
     * Serialize session to a plain object for persistence.
     * @returns {Record<string, unknown>}
     */
    toJSON() {
        return {
            id: this.id,
            projectDir: this.projectDir,
            prompt: this.prompt,
            parentSessionId: this.parentSessionId,
            snapshotPath: this.snapshotPath,
            state: this.state,
            createdAt: this.createdAt,
            completedAt: this.completedAt,
            events: this.events,
            agents: Object.fromEntries(this.agents),
            allFindings: this.allFindings,
            groupedFindings: this.groupedFindings,
            _seqCounter: this._seqCounter,
        };
    }

    /**
     * Restore session from serialized data.
     * @param {Record<string, unknown>} data
     * @returns {Session}
     */
    static fromJSON(data) {
        const session = new Session({
            projectDir: /** @type {string} */ (data.projectDir),
            prompt: /** @type {string} */ (data.prompt),
            id: /** @type {string} */ (data.id),
            parentSessionId: /** @type {string|null} */ (data.parentSessionId ?? null),
            snapshotPath: /** @type {string|null} */ (data.snapshotPath ?? null),
        });

        session.state = /** @type {string} */ (data.state ?? 'pending');
        session.createdAt = /** @type {string} */ (data.createdAt ?? session.createdAt);
        session.completedAt = /** @type {string|null} */ (data.completedAt ?? null);
        session._seqCounter = /** @type {number} */ (data._seqCounter ?? 0);
        session.events = /** @type {import('../schema/events.js').Event[]} */ (data.events ?? []);
        session.allFindings = /** @type {import('../schema/events.js').Finding[]} */ (data.allFindings ?? []);
        session.groupedFindings = /** @type {import('../schema/events.js').GroupedFinding[]} */ (data.groupedFindings ?? []);

        // Restore agents map
        if (data.agents && typeof data.agents === 'object') {
            for (const [key, value] of Object.entries(data.agents)) {
                session.agents.set(key, /** @type {AgentState} */(value));
            }
        }

        return session;
    }
}

// ── Utility ──────────────────────────────────────────

/**
 * @param {string} severity
 * @returns {number}
 */
function severityRank(severity) {
    const ranks = { critical: 4, high: 3, medium: 2, low: 1 };
    return ranks[/** @type {keyof typeof ranks} */ (severity)] ?? 0;
}

// ── Types ────────────────────────────────────────────

/**
 * @typedef {Object} AgentState
 * @property {string} agentId
 * @property {string} state - 'pending' | 'running' | 'completed'
 * @property {string|null} startedAt
 * @property {string|null} completedAt
 * @property {number} findingCount
 * @property {string|null} status - 'ok' | 'failed' | 'timeout'
 */

export { SESSION_STATES, TERMINAL_STATES, severityRank };

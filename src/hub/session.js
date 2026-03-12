// @ts-check
/** @module hub/session */

import { v4 as uuidv4 } from 'uuid';
import { AgentRegistry } from './agent-registry.js';
import { buildFindingAgentMap, groupFindings, mergeFindingsSmart } from './finding-aggregation.js';
import { severityRank } from './session-finding-grouping.js';
import { hydrateSession, serializeSession } from './session-serialization.js';

/** @type {readonly string[]} */
const SESSION_STATES = /** @type {const} */ ([
    'pending', 'running', 'completed', 'failed', 'partial_completion', 'cancelled',
]);

/** @type {readonly string[]} */
const TERMINAL_STATES = /** @type {const} */ ([
    'completed', 'failed', 'partial_completion', 'cancelled',
]);
const DEFAULT_STALL_THRESHOLD_MS = 15 * 60_000;
const STALL_THRESHOLD_BY_AGENT = Object.freeze({
    'mcp-codex': 15 * 60_000,
    codex: 5 * 60_000,
});

export class Session {
    /**
     * @param {object} opts
     * @param {string} opts.projectDir
     * @param {string} opts.prompt
     * @param {string} [opts.id]
     * @param {string|null} [opts.parentSessionId]
     * @param {string} [opts.snapshotPath]
     * @param {string} [opts.agentId]
     * @param {Record<string,unknown>} [opts.reviewOptions]
     * @param {number} [opts.round]
     * @param {string|null} [opts.label]
     */
    constructor({ projectDir, prompt, id, parentSessionId, snapshotPath, agentId, reviewOptions, round, label }) {
        this.id = id ?? uuidv4();
        this.projectDir = projectDir;
        this.prompt = prompt;
        this.parentSessionId = parentSessionId ?? null;
        this.snapshotPath = snapshotPath ?? null;
        this.agentId = agentId ?? 'codex';
        this.reviewOptions = reviewOptions ?? null;
        this.round = round ?? 1;
        this.label = label ?? null;
        this.evaluations = [];
        this.rebuttals = [];
        this.rebuttalOutcomes = [];
        this.retryMode = null;
        this.state = 'pending';
        this.createdAt = new Date().toISOString();
        this.completedAt = null;
        this._seqCounter = 0;
        this.events = [];
        this.agents = new AgentRegistry();
        this.allFindings = [];
        this.groupedFindings = [];
        this.mergedFindings = [];
        this.mergeStats = { total: 0, merged: 0, unique: 0, conflicts: 0 };
    }

    /** @param {import('../schema/events.js').Event} event */
    addEvent(event) {
        if (this.isTerminal()) {
            throw new Error(`Cannot add events to terminal session (state: ${this.state})`);
        }

        const seqEvent = { ...event, seq: this._seqCounter++ };
        this.events.push(seqEvent);
        this._updateAgentState(seqEvent);
        return seqEvent;
    }

    /** @param {string} agentId */
    registerAgent(agentId) {
        this.agents.register(agentId);
    }

    start() {
        if (this.state !== 'pending') {
            throw new Error(`Cannot start session in state: ${this.state}`);
        }
        this.state = 'running';
    }

    /** @param {'completed'|'failed'|'partial_completion'|'cancelled'} finalState @param {import('../schema/events.js').Finding[]} [findings] */
    finalize(finalState, findings = []) {
        if (!TERMINAL_STATES.includes(finalState)) {
            throw new Error(`Invalid terminal state: ${finalState}`);
        }
        if (this.isTerminal()) {
            return;
        }

        this.state = finalState;
        this.completedAt = new Date().toISOString();
        this.allFindings = findings;
        const findingAgentMap = buildFindingAgentMap(this.events, findings);
        this.groupedFindings = groupFindings(findings, findingAgentMap);
        const mergeResult = mergeFindingsSmart(findings, findingAgentMap);
        this.mergedFindings = mergeResult.merged;
        this.mergeStats = mergeResult.stats;
        this._reconcileAgentStates(finalState);
    }

    isTerminal() {
        return TERMINAL_STATES.includes(this.state);
    }

    /** @param {{prompt?: string, label?: string, snapshotPath?: string, retryMode?: 'appeal'|'reverify'}} [overrides] */
    createRetry(overrides = {}) {
        const nextRound = this.round + 1;
        const autoLabel = this.label
            ? this.label.replace(/Round \d+/, `Round ${nextRound}`)
            : `Round ${nextRound}`;

        const nextSession = new Session({
            projectDir: this.projectDir,
            prompt: overrides.prompt ?? this.prompt,
            parentSessionId: this.id,
            agentId: this.agentId,
            reviewOptions: this.reviewOptions ? structuredClone(this.reviewOptions) : undefined,
            snapshotPath: overrides.snapshotPath ?? this.snapshotPath ?? undefined,
            round: nextRound,
            label: overrides.label ?? autoLabel,
        });
        nextSession.retryMode = overrides.retryMode ?? null;
        return nextSession;
    }

    /** @param {import('../schema/events.js').Event} event */
    _updateAgentState(event) {
        const agentId = event.agent_id;
        this.registerAgent(agentId);

        if (event.event_type !== 'status') {
            return;
        }

        const payload = /** @type {Record<string, unknown>} */ (event.payload);
        if (payload.state === 'started') {
            this.agents.transition(agentId, 'running', { startedAt: event.timestamp });
            return;
        }

        if (payload.state !== 'done') {
            return;
        }

        const status = /** @type {string|null} */ (payload.status ?? null);
        const isFailure = status === 'failed' || status === 'timeout';
        this.agents.transition(agentId, isFailure ? 'failed' : 'completed', {
            completedAt: event.timestamp,
            status,
            findingCount: typeof payload.findingCount === 'number' ? payload.findingCount : 0,
        });
    }

    /** @param {'completed'|'failed'|'partial_completion'|'cancelled'} finalState */
    _reconcileAgentStates(finalState) {
        const closedState = finalState === 'completed' ? 'completed'
            : finalState === 'cancelled' ? 'cancelled'
                : 'failed';
        const completedAt = this.completedAt ?? new Date().toISOString();

        for (const [agentId, agent] of this.agents) {
            if (agentId === 'system') {
                continue;
            }
            if (['completed', 'failed', 'cancelled'].includes(agent.state)) {
                continue;
            }
            agent.state = closedState;
            agent.completedAt = completedAt;
            agent.status = finalState === 'completed' ? 'ok' : finalState;
            agent.findingCount = this.allFindings.length;
        }
    }

    toJSON() {
        return {
            ...serializeSession(this),
            watchdog: this.getWatchdogStatus(),
            displayState: this.getDisplayState(),
        };
    }

    toSummaryJSON() {
        return {
            id: this.id,
            projectDir: this.projectDir,
            parentSessionId: this.parentSessionId,
            snapshotPath: this.snapshotPath,
            agentId: this.agentId,
            label: this.label,
            state: this.state,
            createdAt: this.createdAt,
            completedAt: this.completedAt,
            round: this.round,
            retryMode: this.retryMode,
            eventCount: this.events.length,
            findingCount: this.groupedFindings.length,
            rebuttalCount: this.rebuttals.length,
            watchdog: this.getWatchdogStatus(),
            displayState: this.getDisplayState(),
        };
    }

    getDisplayState() {
        return this.getWatchdogStatus().stalled ? 'stalled' : this.state;
    }

    getWatchdogStatus(nowMs = Date.now()) {
        const lastActivityAt = this.events.length > 0
            ? this.events[this.events.length - 1].timestamp
            : this.createdAt;
        const idleMs = Math.max(0, nowMs - Date.parse(lastActivityAt));
        const thresholdMs = getStallThresholdMs(this.agentId);
        return {
            stalled: this.state === 'running' && idleMs >= thresholdMs,
            idleMs,
            thresholdMs,
            lastActivityAt,
        };
    }

    /** @param {Record<string, unknown>} data */
    static fromJSON(data) {
        const session = new Session({
            projectDir: /** @type {string} */ (data.projectDir),
            prompt: /** @type {string} */ (data.prompt),
            id: /** @type {string} */ (data.id),
            parentSessionId: /** @type {string|null} */ (data.parentSessionId ?? null),
            snapshotPath: /** @type {string|null} */ (data.snapshotPath ?? null),
            agentId: /** @type {string|undefined} */ (data.agentId),
            reviewOptions: /** @type {Record<string,unknown>|undefined} */ (data.reviewOptions ?? undefined),
            round: /** @type {number|undefined} */ (data.round ?? undefined),
            label: /** @type {string|null} */ (data.label ?? null),
        });

        hydrateSession(session, data);
        if (session.isTerminal()) {
            session._reconcileAgentStates(/** @type {'completed'|'failed'|'partial_completion'|'cancelled'} */(session.state));
        }
        return session;
    }
}

export { SESSION_STATES, TERMINAL_STATES, severityRank };

function getStallThresholdMs(agentId) {
    const envValue = Number.parseInt(process.env.HUB_STALL_THRESHOLD_MS ?? '', 10);
    if (Number.isFinite(envValue) && envValue > 0) {
        return envValue;
    }

    return STALL_THRESHOLD_BY_AGENT[agentId] ?? DEFAULT_STALL_THRESHOLD_MS;
}

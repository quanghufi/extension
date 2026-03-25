// @ts-check
/** @module hub/session */

import { v4 as uuidv4 } from 'uuid';
import { AgentRegistry } from './agent-registry.js';
import { buildFindingAgentMap, groupFindings, mergeFindingsSmart } from './finding-aggregation.js';
import { severityRank } from './session-finding-grouping.js';
import { hydrateSession, serializeSession } from './session-serialization.js';
import {
    defaultAssignments, createDefaultTurn, expectedAgentForState,
    claimStateForAgent, waitingStateForAgent, transitionOnAssignments,
    validateAdvanceAction, deriveNextCollabState, COLLAB_TERMINAL_STATES,
} from './session-collab.js';
import {
    buildSessionMessage, validateFindingRefs, filterMessages,
    MESSAGE_TYPES_REQUIRING_TURN, MESSAGE_TYPES_REQUIRING_FINDING_REF,
} from './session-messages.js';
import { COLLAB_EVENT_TYPES } from '../schema/events.js';

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
    // Keep watchdog above the local Codex hard timeout so waitForCompletion()
    // does not mark an in-flight review as stalled before the adapter finishes.
    codex: 11 * 60_000,
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

        // ── Collaboration Layer ──────────────────────
        /** @type {import('./session-messages.js').SessionMessage[]} */
        this.messages = [];
        this.messageSeqCounter = 0;
        this.collabState = 'draft';
        this.assignments = defaultAssignments();
        this.turn = createDefaultTurn();
        /** @type {{ type: string, [key: string]: unknown }|null} */
        this.pendingAction = null;

        // ── Debate Layer ────────────────────────────────
        /** @type {string|null} */
        this.debateState = null;
        this.debateRound = 0;
        this.debateMaxRounds = 3;
        /** @type {string[]|null} */
        this.debateAgents = null;
        this.debateActive = false;
        /** @type {Record<string, Record<string, any[]>>} */
        this.debateRoundEvals = {};
        /** @type {Array<{ agentId: string, phase: string, startedAt: number, completedAt: number|null, timedOut: boolean }>} */
        this.debateTimings = [];

        // ── Judge Layer ────────────────────────────────
        /** @type {Array<{ dedupeKey: string, verdict: 'confirmed'|'rejected', rationale: string, suggested_fix: string|null, judgeAgent: string }>|null} */
        this.judgeVerdicts = null;
    }

    /**
     * @param {import('../schema/events.js').Event} event
     * @param {{ force?: boolean }} [options]
     */
    addEvent(event, options = {}) {
        if (this.isTerminal() && !options.force) {
            // Allow collab lifecycle events on terminal sessions
            if (!COLLAB_EVENT_TYPES.includes(event.event_type)) {
                throw new Error(`Cannot add events to terminal session (state: ${this.state})`);
            }
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

    isCollabTerminal() {
        return COLLAB_TERMINAL_STATES.includes(this.collabState);
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

        // Inherit assignments but reset collab runtime state
        nextSession.assignments = { ...this.assignments };
        nextSession.messages = [];
        nextSession.messageSeqCounter = 0;
        nextSession.turn = createDefaultTurn();
        nextSession.pendingAction = null;
        nextSession.collabState = transitionOnAssignments(nextSession.assignments);

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
            this.agents.transition(agentId, 'running', {
                startedAt: event.timestamp,
                completedAt: null,
                status: null,
                findingCount: 0,
            });
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

    // ── Collaboration Methods ─────────────────────────

    /**
     * Initialize collaboration after session creation (e.g. from review flow).
     * Sets collabState based on current assignments.
     */
    initCollab() {
        this.collabState = transitionOnAssignments(this.assignments);
    }

    /** @returns {string|null} */
    getExpectedAgentForCurrentState() {
        return expectedAgentForState(this.collabState, this.assignments);
    }

    /**
     * @param {'reviewer'|'responder'|'decider'} role
     * @param {string} agentId
     */
    assignAgent(role, agentId) {
        if (!['reviewer', 'responder', 'decider'].includes(role)) {
            throw new Error(`Invalid role: ${role}`);
        }
        this.assignments[role] = agentId;

        // Auto-transition from draft/awaiting_assignment if both assigned
        if (this.collabState === 'draft' || this.collabState === 'awaiting_assignment') {
            this.collabState = transitionOnAssignments(this.assignments);
        }
    }

    /**
     * @param {string} agentId
     * @param {number} [ttlSeconds]
     * @returns {{ token: string }}
     */
    claimTurn(agentId, ttlSeconds = 600) {
        this.expireTurnIfNeeded();

        // Idempotent: if same agent already owns an unexpired turn, return existing token
        if (this.turn.status === 'claimed' && this.turn.ownerId === agentId) {
            return { token: this.turn.token };
        }

        const expected = this.getExpectedAgentForCurrentState();
        if (expected && expected !== agentId) {
            throw new Error(`Agent "${agentId}" cannot claim turn. Expected: "${expected}" in state "${this.collabState}"`);
        }

        const claimableStates = ['awaiting_codex_turn', 'awaiting_antigravity_turn', 'codex_reviewing', 'antigravity_reviewing'];
        if (!claimableStates.includes(this.collabState)) {
            throw new Error(`Cannot claim turn in collab state: ${this.collabState}`);
        }

        const token = uuidv4().slice(0, 8);
        const now = new Date();
        this.turn = {
            status: 'claimed',
            ownerId: agentId,
            claimedAt: now.toISOString(),
            claimExpiresAt: new Date(now.getTime() + ttlSeconds * 1000).toISOString(),
            token,
        };

        // Transition to reviewing state
        this.collabState = claimStateForAgent(agentId, this.assignments);

        return { token };
    }

    /**
     * @param {string} agentId
     * @param {string} token
     */
    releaseTurn(agentId, token) {
        this.ensureTurnOwner(agentId, token);
        this.turn = createDefaultTurn();
        this.collabState = waitingStateForAgent(agentId, this.assignments);
    }

    /**
     * @param {string} agentId
     * @param {string} token
     * @throws {Error} if agent doesn't own the turn or token is invalid
     */
    ensureTurnOwner(agentId, token) {
        this.expireTurnIfNeeded();
        if (this.turn.status !== 'claimed') {
            throw new Error(`No active turn (status: ${this.turn.status})`);
        }
        if (this.turn.ownerId !== agentId) {
            throw new Error(`Turn owned by "${this.turn.ownerId}", not "${agentId}"`);
        }
        if (this.turn.token !== token) {
            throw new Error('Invalid turn token');
        }
    }

    /**
     * @param {string} action
     * @param {string} agentId
     * @param {{ payload?: Record<string, unknown>, turnToken?: string }} [options]
     * @returns {{ previousState: string, nextState: string, pendingAction?: { type: string, [key: string]: unknown } }}
     */
    advanceCollabState(action, agentId, options = {}) {
        this.expireTurnIfNeeded();

        const isDecider = agentId === this.assignments.decider;
        const validation = validateAdvanceAction({
            collabState: this.collabState,
            action,
            agentId,
            assignments: this.assignments,
            isDecider,
        });

        if (!validation.valid) {
            throw new Error(validation.reason);
        }

        // Enforce turn ownership for all turn-sensitive actions
        const TURN_REQUIRED_ACTIONS = ['release_turn', 'review_complete', 'request_response'];
        if (TURN_REQUIRED_ACTIONS.includes(action)) {
            this.ensureTurnOwner(agentId, options.turnToken ?? '');
        }

        const previousState = this.collabState;
        const result = deriveNextCollabState({
            collabState: this.collabState,
            action,
            agentId,
            assignments: this.assignments,
            payload: options.payload,
        });

        this.collabState = result.nextState;
        this.pendingAction = result.pendingAction ?? null;

        // Release turn on state transition
        if (this.turn.status === 'claimed') {
            this.turn = createDefaultTurn();
        }

        return { previousState, nextState: result.nextState, pendingAction: result.pendingAction };
    }

    /** @param {Date} [now] */
    expireTurnIfNeeded(now = new Date()) {
        if (this.turn.status !== 'claimed' || !this.turn.claimExpiresAt) {
            return;
        }
        if (now >= new Date(this.turn.claimExpiresAt)) {
            const ownerId = this.turn.ownerId;
            this.turn.status = 'expired';

            // Recover to the correct waiting state for the previous owner,
            // so the same agent (or another) can re-claim without manual reassignment.
            if (ownerId) {
                this.collabState = waitingStateForAgent(ownerId, this.assignments);
            } else {
                this.collabState = 'awaiting_assignment';
            }
        }
    }

    /**
     * @param {object} input
     * @param {string} input.agentId
     * @param {string} input.role
     * @param {string} input.type
     * @param {string} input.content
     * @param {Array<{findingId?: string, dedupeKey?: string}>} [input.findingRefs]
     * @param {string|null} [input.replyToMessageId]
     * @param {string|null} [input.turnToken]
     * @param {Record<string, unknown>} [input.metadata]
     * @returns {import('./session-messages.js').SessionMessage}
     */
    addMessage(input) {
        // Turn validation for turn-sensitive messages
        if (MESSAGE_TYPES_REQUIRING_TURN.includes(input.type)) {
            if (!input.turnToken) {
                throw new Error(`Message type "${input.type}" requires a valid turn token`);
            }
            this.ensureTurnOwner(input.agentId, input.turnToken);
        }

        // Finding ref validation
        if (MESSAGE_TYPES_REQUIRING_FINDING_REF.includes(input.type) && input.findingRefs?.length) {
            validateFindingRefs(this, input.findingRefs);
        }

        const message = buildSessionMessage({
            session: this,
            ...input,
        });

        this.messages.push(message);
        this.messageSeqCounter++;

        return message;
    }

    /**
     * @param {object} [filters]
     * @param {number} [filters.afterSeq]
     * @param {number} [filters.limit]
     * @param {string[]} [filters.types]
     * @param {string} [filters.agentId]
     * @returns {import('./session-messages.js').SessionMessage[]}
     */
    listMessages(filters) {
        return filterMessages(this.messages, filters);
    }

    // ── Serialization ────────────────────────────────────

    toJSON() {
        const json = {
            ...serializeSession(this),
            watchdog: this.getWatchdogStatus(),
            displayState: this.getDisplayState(),
        };
        // Redact turn token from serialized output
        if (json.turn) {
            json.turn = { ...json.turn, token: undefined };
        }
        // Redact turnToken from messages
        if (json.messages) {
            json.messages = json.messages.map(m => ({ ...m, turnToken: undefined }));
        }
        return json;
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
            // Collaboration fields
            collabState: this.collabState,
            messageCount: this.messages.length,
            assignments: this.assignments,
            // Debate fields (F-10)
            debateState: this.debateState,
            debateRound: this.debateRound,
            debateAgents: this.debateAgents,
            debateActive: this.debateActive,
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

// @ts-check

import { AgentRegistry } from './agent-registry.js';
import { defaultAssignments, createDefaultTurn } from './session-collab.js';

/**
 * @param {import('./session.js').Session} session
 * @returns {Record<string, unknown>}
 */
export function serializeSession(session) {
    return {
        id: session.id,
        projectDir: session.projectDir,
        prompt: session.prompt,
        parentSessionId: session.parentSessionId,
        snapshotPath: session.snapshotPath,
        agentId: session.agentId,
        label: session.label,
        state: session.state,
        createdAt: session.createdAt,
        completedAt: session.completedAt,
        events: session.events,
        agents: session.agents.toJSON(),
        allFindings: session.allFindings,
        groupedFindings: session.groupedFindings,
        mergedFindings: session.mergedFindings,
        mergeStats: session.mergeStats,
        reviewOptions: session.reviewOptions,
        round: session.round,
        evaluations: session.evaluations,
        rebuttals: session.rebuttals,
        rebuttalOutcomes: session.rebuttalOutcomes,
        retryMode: session.retryMode,
        _seqCounter: session._seqCounter,
        // Collaboration layer
        messages: session.messages,
        messageSeqCounter: session.messageSeqCounter,
        collabState: session.collabState,
        assignments: session.assignments,
        turn: session.turn,
        pendingAction: session.pendingAction,
        // Debate layer
        debateState: session.debateState,
        debateRound: session.debateRound,
        debateMaxRounds: session.debateMaxRounds,
        debateAgents: session.debateAgents,
        debateActive: session.debateActive,
        debateRoundEvals: session.debateRoundEvals,
        debateTimings: session.debateTimings,
    };
}

/**
 * @param {import('./session.js').Session} session
 * @param {Record<string, unknown>} data
 */
export function hydrateSession(session, data) {
    session.state = /** @type {string} */ (data.state ?? 'pending');
    session.createdAt = /** @type {string} */ (data.createdAt ?? session.createdAt);
    session.completedAt = /** @type {string|null} */ (data.completedAt ?? null);
    session._seqCounter = /** @type {number} */ (data._seqCounter ?? 0);
    session.events = /** @type {import('../schema/events.js').Event[]} */ (data.events ?? []);
    session.allFindings = /** @type {import('../schema/events.js').Finding[]} */ (data.allFindings ?? []);
    session.groupedFindings = /** @type {import('../schema/events.js').GroupedFinding[]} */ (data.groupedFindings ?? []);
    session.mergedFindings = /** @type {import('./merge.js').MergedFinding[]} */ (data.mergedFindings ?? []);
    session.mergeStats = /** @type {import('./merge.js').MergeStats} */ (data.mergeStats ?? {
        total: 0,
        merged: 0,
        unique: 0,
        conflicts: 0,
    });
    session.retryMode = /** @type {'appeal'|'reverify'|null} */ (data.retryMode ?? null);

    if (data.agents && typeof data.agents === 'object') {
        session.agents = AgentRegistry.fromJSON(
            /** @type {Record<string, import('./agent-registry.js').AgentState>} */(data.agents)
        );
    }

    if (Array.isArray(data.evaluations)) {
        session.evaluations = data.evaluations;
    }
    if (Array.isArray(data.rebuttals)) {
        session.rebuttals = data.rebuttals;
    }
    if (Array.isArray(data.rebuttalOutcomes)) {
        session.rebuttalOutcomes = data.rebuttalOutcomes;
    }

    // Collaboration layer — safe defaults for old sessions
    session.messages = /** @type {import('./session-messages.js').SessionMessage[]} */ (data.messages ?? []);
    session.messageSeqCounter = /** @type {number} */ (data.messageSeqCounter ?? 0);
    session.collabState = /** @type {string} */ (data.collabState ?? 'draft');
    session.assignments = /** @type {{ reviewer: string, responder: string, decider: string }} */ (
        data.assignments ?? defaultAssignments()
    );
    session.turn = /** @type {ReturnType<typeof createDefaultTurn>} */ (
        data.turn ?? createDefaultTurn()
    );
    session.pendingAction = /** @type {{ type: string, [key: string]: unknown }|null} */ (
        data.pendingAction ?? null
    );

    // Debate layer — safe defaults for old sessions
    session.debateState = /** @type {string|null} */ (data.debateState ?? null);
    session.debateRound = /** @type {number} */ (data.debateRound ?? 0);
    session.debateMaxRounds = /** @type {number} */ (data.debateMaxRounds ?? 3);
    session.debateAgents = /** @type {string[]|null} */ (data.debateAgents ?? null);
    session.debateActive = /** @type {boolean} */ (data.debateActive ?? false);
    session.debateRoundEvals = /** @type {Record<string, Record<string, any[]>>} */ (data.debateRoundEvals ?? {});
    session.debateTimings = /** @type {Array<any>} */ (data.debateTimings ?? []);
}

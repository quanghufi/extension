// @ts-check

import { AgentRegistry } from './agent-registry.js';

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
}

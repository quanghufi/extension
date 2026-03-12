// @ts-check

import { jsonResponse, readBody } from './http-utils.js';
import { buildAppealPrompt, deriveAppealOutcomes, normalizeRebuttalInput, toLegacyEvaluation, upsertRebuttal } from './hub/rebuttal.js';

/**
 * POST /api/sessions/:id/findings/evaluate
 * @param {import('./server.js').HubServer} server
 * @param {string} id
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 */
export async function apiEvaluateFindings(server, id, req, res) {
    const session = server.activeSessions.get(id) ?? server.store.load(id);
    if (!session) {
        return jsonResponse(res, 404, { error: 'Session not found' });
    }
    if (session.state !== 'completed') {
        return jsonResponse(res, 409, { error: 'Session must be completed before evaluating' });
    }

    try {
        const body = await readBody(req);
        const data = JSON.parse(body || '{}');
        const inputs = Array.isArray(data.rebuttals)
            ? data.rebuttals
            : Array.isArray(data.evaluations)
                ? data.evaluations
                : [];

        let accepted = 0;
        let rejected = 0;
        let deferred = 0;

        for (const input of inputs) {
            const rebuttal = normalizeRebuttalInput(session, /** @type {Record<string, unknown>} */ (input));
            session.rebuttals = upsertRebuttal(session, rebuttal);

            const legacy = toLegacyEvaluation(rebuttal);
            session.evaluations = [
                ...session.evaluations.filter((entry) => entry.findingId !== legacy.findingId),
                legacy,
            ];

            if (rebuttal.verdict === 'accept') accepted++;
            else if (rebuttal.verdict === 'reject') rejected++;
            else deferred++;
        }

        server.store.save(session);
        return jsonResponse(res, 200, {
            accepted,
            rejected,
            deferred,
            total: inputs.length,
            rebuttals: session.rebuttals,
        });
    } catch (err) {
        const message = err instanceof Error ? err.message : 'Invalid request body';
        return jsonResponse(res, 400, { error: message });
    }
}

/**
 * POST /api/sessions/:id/rerun
 * @param {import('./server.js').HubServer} server
 * @param {string} id
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 */
export async function apiRerunSession(server, id, req, res) {
    const session = server.activeSessions.get(id) ?? server.store.load(id);
    if (!session) {
        return jsonResponse(res, 404, { error: 'Session not found' });
    }
    if (!session.isTerminal()) {
        return jsonResponse(res, 409, { error: 'Session must be in a terminal state before rerun' });
    }
    if (session.round >= 5) {
        return jsonResponse(res, 409, { error: 'Maximum 5 rounds reached' });
    }

    try {
        const body = await readBody(req);
        const data = JSON.parse(body || '{}');
        const mode = data.mode === 'reverify' ? 'reverify' : 'appeal';

        const childSession = session.createRetry({
            prompt: mode === 'appeal'
                ? buildAppealPrompt(session, /** @type {string|undefined} */ (data.context))
                : String(data.context ?? session.prompt),
            snapshotPath: mode === 'reverify' && typeof data.snapshotPath === 'string'
                ? data.snapshotPath
                : undefined,
            retryMode: mode,
        });

        server.activeSessions.set(childSession.id, childSession);
        server.store.save(childSession);

        jsonResponse(res, 201, {
            childSessionId: childSession.id,
            round: childSession.round,
            parentSessionId: id,
            mode,
        });

        server.runSession(childSession.id).then(() => {
            const freshChild = server.activeSessions.get(childSession.id) ?? server.store.load(childSession.id);
            if (!freshChild) return;
            if (mode === 'appeal') {
                freshChild.rebuttalOutcomes = deriveAppealOutcomes(session, freshChild);
                server.store.save(freshChild);
            }
        }).catch(err => {
            console.error(`[FATAL] Unhandled error in rerun for ${childSession.id}:`, err);
        });
    } catch (err) {
        const message = err instanceof Error ? err.message : 'Invalid request body';
        return jsonResponse(res, 400, { error: message });
    }
}

/**
 * @param {import('./server.js').HubServer} server
 * @param {import('./hub/session.js').Session} session
 */
export function buildSessionLineage(server, session) {
    const parent = session.parentSessionId
        ? server.activeSessions.get(session.parentSessionId) ?? server.store.load(session.parentSessionId)
        : null;

    return {
        parentSessionId: session.parentSessionId,
        retryMode: session.retryMode,
        rebuttalCount: session.rebuttals.length,
        rebuttalOutcomeCount: session.rebuttalOutcomes.length,
        parentRebuttalCount: parent?.rebuttals.length ?? 0,
        rebuttalOutcomes: session.rebuttalOutcomes,
    };
}

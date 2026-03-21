// @ts-check
/**
 * REST API Route Handlers for the Hub Server.
 *
 * Provides session CRUD operations and event streaming endpoints.
 *
 * @module routes/api-routes
 */

import { Session } from './hub/session.js';
import { jsonResponse, readBody } from './http-utils.js';
import { apiEvaluateFindings, apiRerunSession, buildSessionLineage } from './rebuttal-routes.js';

/**
 * @param {import('./server.js').HubServer} server
 * @param {import('http').ServerResponse} res
 */
export function apiListSessions(server, res) {
    const ids = server.store.list();
    const sessions = ids.map((id) => {
        const active = server.activeSessions.get(id);
        if (active) return active.toSummaryJSON();
        const stored = server.store.load(id);
        return stored ? stored.toSummaryJSON() : { id, state: 'unknown' };
    });
    jsonResponse(res, 200, { sessions });
}

/**
 * @param {import('./server.js').HubServer} server
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 */
export async function apiCreateSession(server, req, res) {
    /** @type {unknown} */
    let data;
    try {
        const body = await readBody(req);
        data = JSON.parse(body || '{}');
    } catch {
        return jsonResponse(res, 400, { error: 'Invalid request body' });
    }

    try {
        const shouldAutoStart = data.autoStart !== false;
        const session = new Session({
            projectDir: data.projectDir ?? process.cwd(),
            prompt: data.prompt ?? 'Review this code for bugs and issues',
            agentId: data.agentId ?? 'mcp-codex',
            snapshotPath: data.snapshotPath,
            reviewOptions: data.reviewOptions,
            label: data.label ?? null,
        });

        server.activeSessions.set(session.id, session);
        server.store.save(session);
        jsonResponse(res, 201, { session: session.toJSON() });

        if (shouldAutoStart) {
            server.runSession(session.id).catch(err => {
                console.error(`[FATAL] Unhandled error in runSession for ${session.id}:`, err);
            });
        }
    } catch (err) {
        console.error('[ERROR] apiCreateSession internal failure:', err);
        jsonResponse(res, 500, { error: 'Internal server error' });
    }
}

/**
 * @param {import('./server.js').HubServer} server
 * @param {string} id
 * @param {import('http').ServerResponse} res
 */
export function apiGetSession(server, id, res) {
    const session = server.activeSessions.get(id) ?? server.store.load(id);
    if (!session) {
        return jsonResponse(res, 404, { error: 'Session not found' });
    }
    jsonResponse(res, 200, {
        session: session.toJSON(),
        lineage: buildSessionLineage(server, session),
        watchdog: session.getWatchdogStatus(),
    });
}

/**
 * @param {import('./server.js').HubServer} server
 * @param {string} id
 * @param {import('http').ServerResponse} res
 */
export function apiDeleteSession(server, id, res) {
    server.activeSessions.delete(id);
    server.store.delete(id);
    jsonResponse(res, 200, { deleted: id });
}

/**
 * @param {import('./server.js').HubServer} server
 * @param {string} id
 * @param {URL} url
 * @param {import('http').ServerResponse} res
 */
export function apiGetEvents(server, id, url, res) {
    const session = server.activeSessions.get(id) ?? server.store.load(id);
    if (!session) {
        return jsonResponse(res, 404, { error: 'Session not found' });
    }

    const afterRaw = url.searchParams.get('after');
    const afterSeq = afterRaw != null ? parseInt(afterRaw, 10) : -1;
    if (Number.isNaN(afterSeq)) {
        return jsonResponse(res, 400, { error: 'Invalid after parameter: must be an integer' });
    }
    const events = session.events.filter((event) => (event.seq ?? -1) > afterSeq);
    jsonResponse(res, 200, { events, total: session.events.length });
}

/**
 * @param {import('./server.js').HubServer} server
 * @param {string} id
 * @param {import('http').ServerResponse} res
 */
export function apiGetFindings(server, id, res) {
    const session = server.activeSessions.get(id) ?? server.store.load(id);
    if (!session) {
        return jsonResponse(res, 404, { error: 'Session not found' });
    }

    jsonResponse(res, 200, {
        grouped: session.groupedFindings,
        merged: session.mergedFindings,
        mergeStats: session.mergeStats,
        totalRaw: session.allFindings.length,
        rebuttals: session.rebuttals,
        rebuttalOutcomes: session.rebuttalOutcomes,
    });
}

export { apiEvaluateFindings, apiRerunSession };

// @ts-check
/**
 * REST API Route Handlers for the Hub Server.
 *
 * Provides session CRUD operations and event streaming endpoints.
 * All handlers follow the pattern: (server, req|id, res) => void
 *
 * @module routes/api-routes
 */

import { Session } from './hub/session.js';

// ── Session API Handlers ────────────────────────────

/**
 * GET /api/sessions — List all sessions.
 * @param {import('./server.js').HubServer} server
 * @param {import('http').ServerResponse} res
 */
export function apiListSessions(server, res) {
    const ids = server.store.list();
    const sessions = ids.map((id) => {
        const active = server.activeSessions.get(id);
        if (active) return active.toJSON();
        const stored = server.store.load(id);
        return stored ? stored.toJSON() : { id, state: 'unknown' };
    });
    jsonResponse(res, 200, { sessions });
}

/**
 * POST /api/sessions — Create a new session.
 * @param {import('./server.js').HubServer} server
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 */
export async function apiCreateSession(server, req, res) {
    try {
        const body = await readBody(req);
        const data = JSON.parse(body);

        const session = new Session({
            projectDir: data.projectDir ?? process.cwd(),
            prompt: data.prompt ?? 'Review this code for bugs and issues',
            agentId: data.agentId,
        });

        server.activeSessions.set(session.id, session);
        server.store.save(session);

        jsonResponse(res, 201, { session: session.toJSON() });

        // Run in background and log any unhandled errors
        server.runSession(session.id).catch(err => {
            console.error(`[FATAL] Unhandled error in runSession for ${session.id}:`, err);
        });

    } catch (err) {
        jsonResponse(res, 400, { error: 'Invalid request body' });
    }
}

/**
 * GET /api/sessions/:id — Get a single session.
 * @param {import('./server.js').HubServer} server
 * @param {string} id
 * @param {import('http').ServerResponse} res
 */
export function apiGetSession(server, id, res) {
    const session = server.activeSessions.get(id) ?? server.store.load(id);
    if (!session) {
        return jsonResponse(res, 404, { error: 'Session not found' });
    }
    jsonResponse(res, 200, { session: session.toJSON() });
}

/**
 * DELETE /api/sessions/:id — Delete a session.
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
 * GET /api/sessions/:id/events — Get session events.
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

    const afterSeq = parseInt(url.searchParams.get('after') ?? '-1', 10);
    const events = session.events.filter((e) => (e.seq ?? -1) > afterSeq);

    jsonResponse(res, 200, { events, total: session.events.length });
}

/**
 * GET /api/sessions/:id/findings — Get session findings (grouped + merged).
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
    });
}

// ── Shared Helpers ──────────────────────────────────

/**
 * Send a JSON response.
 * @param {import('http').ServerResponse} res
 * @param {number} status
 * @param {unknown} data
 */
export function jsonResponse(res, status, data) {
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(status);
    res.end(JSON.stringify(data));
}

/**
 * Read the full request body as a string.
 * @param {import('http').IncomingMessage} req
 * @returns {Promise<string>}
 */
export function readBody(req) {
    return new Promise((resolve) => {
        let body = '';
        req.on('data', (chunk) => { body += chunk.toString(); });
        req.on('end', () => resolve(body));
    });
}

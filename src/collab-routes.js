// @ts-check
/**
 * REST API Route Handlers for Collaboration.
 *
 * Provides REST parity for the 5 MCP collaboration tools.
 *
 * @module routes/collab-routes
 */

import { jsonResponse, readBody } from './http-utils.js';
import { createEvent } from './schema/events.js';

/**
 * GET /api/sessions/:id/messages
 * @param {import('./server.js').HubServer} server
 * @param {string} id
 * @param {URL} url
 * @param {import('http').ServerResponse} res
 */
export function apiListMessages(server, id, url, res) {
    const session = server.activeSessions.get(id) ?? server.store.load(id);
    if (!session) {
        return jsonResponse(res, 404, { error: 'Session not found' });
    }

    const afterSeq = url.searchParams.has('afterSeq')
        ? parseInt(url.searchParams.get('afterSeq') ?? '-1', 10) : undefined;
    const limit = url.searchParams.has('limit')
        ? parseInt(url.searchParams.get('limit') ?? '50', 10) : undefined;
    const types = url.searchParams.has('types')
        ? url.searchParams.get('types')?.split(',') : undefined;
    const agentId = url.searchParams.get('agentId') ?? undefined;

    const messages = session.listMessages({ afterSeq, limit, types, agentId });

    // Redact turnToken from responses
    const redacted = messages.map(m => ({ ...m, turnToken: undefined }));

    jsonResponse(res, 200, {
        messages: redacted,
        total: session.messages.length,
        nextAfterSeq: messages.length > 0 ? messages[messages.length - 1].seq : (afterSeq ?? -1),
        collabState: session.collabState,
        turn: { ...session.turn, token: undefined },
    });
}

/**
 * POST /api/sessions/:id/messages
 * @param {import('./server.js').HubServer} server
 * @param {string} id
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 */
export async function apiPostMessage(server, id, req, res) {
    const session = server.activeSessions.get(id) ?? server.store.load(id);
    if (!session) {
        return jsonResponse(res, 404, { error: 'Session not found' });
    }

    try {
        const body = await readBody(req);
        const data = JSON.parse(body || '{}');

        const message = session.addMessage({
            agentId: data.agentId,
            role: data.role,
            type: data.type,
            content: data.content,
            findingRefs: data.findingRefs ?? [],
            replyToMessageId: data.replyToMessageId ?? null,
            turnToken: data.turnToken ?? null,
            metadata: data.metadata ?? {},
        });

        const event = createEvent(id, data.agentId, 'message_posted', {
            messageId: message.id,
            type: message.type,
            role: message.role,
            seq: message.seq,
        });
        session.addEvent(event, { force: true });
        server.store.save(session);
        server.broadcast(id, event);

        jsonResponse(res, 201, { message: { id: message.id, seq: message.seq, type: message.type } });
    } catch (err) {
        const msg = err instanceof Error ? err.message : 'Invalid request';
        jsonResponse(res, 400, { error: msg });
    }
}

/**
 * POST /api/sessions/:id/claim-turn
 * @param {import('./server.js').HubServer} server
 * @param {string} id
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 */
export async function apiClaimTurn(server, id, req, res) {
    const session = server.activeSessions.get(id) ?? server.store.load(id);
    if (!session) {
        return jsonResponse(res, 404, { error: 'Session not found' });
    }

    try {
        const body = await readBody(req);
        const data = JSON.parse(body || '{}');
        const previousState = session.collabState;

        const { token } = session.claimTurn(data.agentId, data.ttlSeconds ?? 600);

        const claimEvent = createEvent(id, data.agentId, 'turn_claimed', {
            ownerId: data.agentId, expiresAt: session.turn.claimExpiresAt,
        });
        session.addEvent(claimEvent, { force: true });

        if (previousState !== session.collabState) {
            const stateEvent = createEvent(id, data.agentId, 'collab_state_changed', {
                from: previousState, to: session.collabState,
            });
            session.addEvent(stateEvent, { force: true });
            server.broadcast(id, stateEvent);
        }

        server.store.save(session);
        server.broadcast(id, claimEvent);

        jsonResponse(res, 200, { token, collabState: session.collabState, turn: session.turn });
    } catch (err) {
        const msg = err instanceof Error ? err.message : 'Invalid request';
        jsonResponse(res, 400, { error: msg });
    }
}

/**
 * POST /api/sessions/:id/assignments
 * @param {import('./server.js').HubServer} server
 * @param {string} id
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 */
export async function apiAssignAgent(server, id, req, res) {
    const session = server.activeSessions.get(id) ?? server.store.load(id);
    if (!session) {
        return jsonResponse(res, 404, { error: 'Session not found' });
    }

    try {
        const body = await readBody(req);
        const data = JSON.parse(body || '{}');
        const previousState = session.collabState;

        session.assignAgent(data.role, data.agentId);

        const assignEvent = createEvent(id, 'system', 'agent_assigned', {
            role: data.role, agentId: data.agentId, assignments: session.assignments,
        });
        session.addEvent(assignEvent, { force: true });

        if (previousState !== session.collabState) {
            const stateEvent = createEvent(id, 'system', 'collab_state_changed', {
                from: previousState, to: session.collabState,
            });
            session.addEvent(stateEvent, { force: true });
            server.broadcast(id, stateEvent);
        }

        server.store.save(session);
        server.broadcast(id, assignEvent);

        jsonResponse(res, 200, { assignments: session.assignments, collabState: session.collabState });
    } catch (err) {
        const msg = err instanceof Error ? err.message : 'Invalid request';
        jsonResponse(res, 400, { error: msg });
    }
}

/**
 * POST /api/sessions/:id/advance
 * @param {import('./server.js').HubServer} server
 * @param {string} id
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 */
export async function apiAdvanceSession(server, id, req, res) {
    const session = server.activeSessions.get(id) ?? server.store.load(id);
    if (!session) {
        return jsonResponse(res, 404, { error: 'Session not found' });
    }

    try {
        const body = await readBody(req);
        const data = JSON.parse(body || '{}');

        const result = session.advanceCollabState(data.action, data.agentId, { payload: data.payload });

        const stateEvent = createEvent(id, data.agentId, 'collab_state_changed', {
            action: data.action, from: result.previousState, to: result.nextState,
        });
        session.addEvent(stateEvent, { force: true });

        if (data.action === 'resolve') {
            const e = createEvent(id, data.agentId, 'session_resolved', { from: result.previousState });
            session.addEvent(e, { force: true });
            server.broadcast(id, e);
        } else if (data.action === 'close') {
            const e = createEvent(id, data.agentId, 'session_closed', { from: result.previousState });
            session.addEvent(e, { force: true });
            server.broadcast(id, e);
        }

        server.store.save(session);
        server.broadcast(id, stateEvent);

        jsonResponse(res, 200, {
            action: data.action,
            previousState: result.previousState,
            nextState: result.nextState,
            collabState: session.collabState,
            pendingAction: result.pendingAction ?? null,
        });
    } catch (err) {
        const msg = err instanceof Error ? err.message : 'Invalid request';
        jsonResponse(res, 400, { error: msg });
    }
}

// @ts-check
/**
 * WebSocket Handler — session-scoped subscriptions with backpressure.
 *
 * Supports:
 * - Session subscription: { subscribe: sessionId }
 * - Unsubscribe: { unsubscribe: true }
 * - Ping/pong keepalive: { ping: true }
 * - Backpressure monitoring via ws.bufferedAmount
 *
 * @module ws-handler
 */

// ── Constants ────────────────────────────────────────

const MAX_WS_BUFFER = 1_048_576; // 1MB backpressure limit

// ── WebSocket Connection Handler ────────────────────

/**
 * Handle a new WebSocket connection.
 * @param {import('ws').WebSocket} ws
 * @param {import('./server.js').HubServer} server
 */
export function handleWsConnection(ws, server) {
    /** @type {string|null} */
    let subscribedSessionId = null;

    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data.toString());

            if (msg.subscribe) {
                // Unsubscribe from previous
                if (subscribedSessionId) {
                    unsubscribe(server, subscribedSessionId, ws);
                }

                subscribedSessionId = msg.subscribe;
                subscribe(server, /** @type {string} */(subscribedSessionId), ws);

                ws.send(JSON.stringify({
                    type: 'subscribed',
                    sessionId: subscribedSessionId,
                }));
            }

            if (msg.unsubscribe) {
                if (subscribedSessionId) {
                    unsubscribe(server, subscribedSessionId, ws);
                    subscribedSessionId = null;
                }
            }

            if (msg.ping) {
                ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
            }
        } catch {
            ws.send(JSON.stringify({ type: 'error', message: 'Invalid message format' }));
        }
    });

    ws.on('close', () => {
        if (subscribedSessionId) {
            unsubscribe(server, subscribedSessionId, ws);
        }
    });
}

// ── Broadcast ───────────────────────────────────────

/**
 * Broadcast event to all subscribers of a session.
 * @param {import('./server.js').HubServer} server
 * @param {string} sessionId
 * @param {import('./schema/events.js').Event} event
 */
export function broadcastEvent(server, sessionId, event) {
    const subs = server.subscriptions.get(sessionId);
    if (!subs) return;

    const msg = JSON.stringify({ type: 'event', event });

    for (const ws of subs) {
        // Backpressure check
        if (ws.bufferedAmount > MAX_WS_BUFFER) {
            continue;
        }
        try {
            ws.send(msg);
        } catch {
            subs.delete(ws);
        }
    }
}

// ── Subscribe / Unsubscribe ─────────────────────────

/**
 * @param {import('./server.js').HubServer} server
 * @param {string} sessionId
 * @param {import('ws').WebSocket} ws
 */
function subscribe(server, sessionId, ws) {
    if (!server.subscriptions.has(sessionId)) {
        server.subscriptions.set(sessionId, new Set());
    }
    server.subscriptions.get(sessionId)?.add(ws);
}

/**
 * @param {import('./server.js').HubServer} server
 * @param {string} sessionId
 * @param {import('ws').WebSocket} ws
 */
function unsubscribe(server, sessionId, ws) {
    server.subscriptions.get(sessionId)?.delete(ws);
}

export { MAX_WS_BUFFER };

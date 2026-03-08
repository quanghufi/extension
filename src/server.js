// @ts-check
/**
 * HTTP & WebSocket Server
 *
 * REST API for session lifecycle + WebSocket for live event streaming.
 * Session-scoped subscriptions with backpressure monitoring.
 *
 * @module server
 */

import http from 'node:http';
import { WebSocketServer } from 'ws';
import path from 'node:path';
import fs from 'node:fs';
import { Session } from './hub/session.js';
import { SessionStore } from './hub/session-store.js';
import { SnapshotManager } from './snapshot/snapshot-manager.js';

// ── Constants ────────────────────────────────────────

const DEFAULT_PORT = 3847;
const MAX_WS_BUFFER = 1_048_576; // 1MB backpressure limit
const MAX_WS_QUEUE = 100;        // Max pending messages per client
const UI_DIR = path.join(import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname), 'ui');

// ── Server ───────────────────────────────────────────

export class HubServer {
    /**
     * @param {object} [options]
     * @param {number} [options.port]
     * @param {string} [options.dataDir] - Directory for session storage
     * @param {string} [options.snapshotDir] - Directory for code snapshots
     */
    constructor(options = {}) {
        /** @type {number} */
        this.port = options.port ?? DEFAULT_PORT;

        /** @type {SessionStore} */
        this.store = new SessionStore(options.dataDir ?? './data');

        /** @type {SnapshotManager} */
        this.snapshots = new SnapshotManager(options.snapshotDir ?? './tmp/snapshots');

        /** @type {Map<string, Session>} */
        this.activeSessions = new Map();

        /** @type {Map<string, Set<import('ws').WebSocket>>} */
        this.subscriptions = new Map(); // sessionId → Set<ws>

        /** @type {http.Server|null} */
        this._server = null;

        /** @type {WebSocketServer|null} */
        this._wss = null;
    }

    /**
     * Start the server.
     * @returns {Promise<void>}
     */
    start() {
        return new Promise((resolve) => {
            this._server = http.createServer((req, res) => this._handleHttp(req, res));

            this._wss = new WebSocketServer({ server: this._server });
            this._wss.on('connection', (ws) => this._handleWsConnection(ws));

            this._server.listen(this.port, () => {
                console.log(`🚀 Hub server running at http://localhost:${this.port}`);
                console.log(`   REST API: http://localhost:${this.port}/api/sessions`);
                console.log(`   Dashboard: http://localhost:${this.port}/`);
                resolve();
            });
        });
    }

    /**
     * Stop the server.
     * @returns {Promise<void>}
     */
    stop() {
        return new Promise((resolve) => {
            // Close all WebSocket connections
            if (this._wss) {
                for (const client of this._wss.clients) {
                    client.close(1001, 'Server shutting down');
                }
                this._wss.close();
            }
            if (this._server) {
                this._server.close(() => resolve());
            } else {
                resolve();
            }
        });
    }

    // ── HTTP Request Handler ─────────────────────────

    /**
     * @param {http.IncomingMessage} req
     * @param {http.ServerResponse} res
     */
    _handleHttp(req, res) {
        const url = new URL(req.url ?? '/', `http://localhost:${this.port}`);
        const method = req.method ?? 'GET';

        // CORS headers
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

        if (method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }

        // API routes
        if (url.pathname === '/api/sessions' && method === 'GET') {
            return this._apiListSessions(res);
        }
        if (url.pathname === '/api/sessions' && method === 'POST') {
            return this._apiCreateSession(req, res);
        }
        if (url.pathname.match(/^\/api\/sessions\/[^/]+$/) && method === 'GET') {
            const id = url.pathname.split('/').pop() ?? '';
            return this._apiGetSession(id, res);
        }
        if (url.pathname.match(/^\/api\/sessions\/[^/]+$/) && method === 'DELETE') {
            const id = url.pathname.split('/').pop() ?? '';
            return this._apiDeleteSession(id, res);
        }
        if (url.pathname.match(/^\/api\/sessions\/[^/]+\/events$/) && method === 'GET') {
            const id = url.pathname.split('/')[3] ?? '';
            return this._apiGetEvents(id, url, res);
        }

        // Static file serving for UI
        return this._serveStatic(url.pathname, res);
    }

    // ── API Handlers ─────────────────────────────────

    /**
     * @param {http.ServerResponse} res
     */
    _apiListSessions(res) {
        const ids = this.store.list();
        const sessions = ids.map((id) => {
            const active = this.activeSessions.get(id);
            if (active) return active.toJSON();
            const stored = this.store.load(id);
            return stored ? stored.toJSON() : { id, state: 'unknown' };
        });
        this._json(res, 200, { sessions });
    }

    /**
     * @param {http.IncomingMessage} req
     * @param {http.ServerResponse} res
     */
    _apiCreateSession(req, res) {
        this._readBody(req).then((body) => {
            try {
                const data = JSON.parse(body);
                const session = new Session({
                    projectDir: data.projectDir ?? process.cwd(),
                    prompt: data.prompt ?? 'Review this code for bugs and issues',
                });

                this.activeSessions.set(session.id, session);
                this.store.save(session);

                this._json(res, 201, { session: session.toJSON() });
            } catch (err) {
                this._json(res, 400, { error: 'Invalid request body' });
            }
        });
    }

    /**
     * @param {string} id
     * @param {http.ServerResponse} res
     */
    _apiGetSession(id, res) {
        const session = this.activeSessions.get(id) ?? this.store.load(id);
        if (!session) {
            return this._json(res, 404, { error: 'Session not found' });
        }
        this._json(res, 200, { session: session.toJSON() });
    }

    /**
     * @param {string} id
     * @param {http.ServerResponse} res
     */
    _apiDeleteSession(id, res) {
        this.activeSessions.delete(id);
        this.store.delete(id);
        this._json(res, 200, { deleted: id });
    }

    /**
     * @param {string} id
     * @param {URL} url
     * @param {http.ServerResponse} res
     */
    _apiGetEvents(id, url, res) {
        const session = this.activeSessions.get(id) ?? this.store.load(id);
        if (!session) {
            return this._json(res, 404, { error: 'Session not found' });
        }

        const afterSeq = parseInt(url.searchParams.get('after') ?? '-1', 10);
        const events = session.events.filter((e) => (e.seq ?? -1) > afterSeq);

        this._json(res, 200, { events, total: session.events.length });
    }

    // ── WebSocket Handler ────────────────────────────

    /**
     * @param {import('ws').WebSocket} ws
     */
    _handleWsConnection(ws) {
        /** @type {string|null} */
        let subscribedSessionId = null;
        /** @type {number} */
        let pendingMessages = 0;

        ws.on('message', (data) => {
            try {
                const msg = JSON.parse(data.toString());

                if (msg.subscribe) {
                    // Unsubscribe from previous
                    if (subscribedSessionId) {
                        this._unsubscribe(subscribedSessionId, ws);
                    }

                    subscribedSessionId = msg.subscribe;
                    this._subscribe(subscribedSessionId, ws);

                    ws.send(JSON.stringify({
                        type: 'subscribed',
                        sessionId: subscribedSessionId,
                    }));
                }

                if (msg.unsubscribe) {
                    if (subscribedSessionId) {
                        this._unsubscribe(subscribedSessionId, ws);
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
                this._unsubscribe(subscribedSessionId, ws);
            }
        });
    }

    /**
     * Broadcast event to all subscribers of a session.
     * @param {string} sessionId
     * @param {import('../schema/events.js').Event} event
     */
    broadcast(sessionId, event) {
        const subs = this.subscriptions.get(sessionId);
        if (!subs) return;

        const msg = JSON.stringify({ type: 'event', event });

        for (const ws of subs) {
            // Backpressure check
            if (ws.bufferedAmount > MAX_WS_BUFFER) {
                // Skip message — client is too slow
                continue;
            }
            try {
                ws.send(msg);
            } catch {
                // Client disconnected
                subs.delete(ws);
            }
        }
    }

    /**
     * @param {string} sessionId
     * @param {import('ws').WebSocket} ws
     */
    _subscribe(sessionId, ws) {
        if (!this.subscriptions.has(sessionId)) {
            this.subscriptions.set(sessionId, new Set());
        }
        this.subscriptions.get(sessionId)?.add(ws);
    }

    /**
     * @param {string} sessionId
     * @param {import('ws').WebSocket} ws
     */
    _unsubscribe(sessionId, ws) {
        this.subscriptions.get(sessionId)?.delete(ws);
    }

    // ── Static File Serving ──────────────────────────

    /**
     * @param {string} pathname
     * @param {http.ServerResponse} res
     */
    _serveStatic(pathname, res) {
        let filePath = pathname === '/' ? '/index.html' : pathname;
        filePath = path.join(UI_DIR, filePath);

        // Security: prevent path traversal
        if (!filePath.startsWith(UI_DIR)) {
            res.writeHead(403);
            res.end('Forbidden');
            return;
        }

        if (!fs.existsSync(filePath)) {
            res.writeHead(404);
            res.end('Not found');
            return;
        }

        const ext = path.extname(filePath);
        const contentTypes = /** @type {Record<string, string>} */ ({
            '.html': 'text/html; charset=utf-8',
            '.css': 'text/css; charset=utf-8',
            '.js': 'application/javascript; charset=utf-8',
            '.json': 'application/json',
            '.svg': 'image/svg+xml',
            '.png': 'image/png',
        });

        res.setHeader('Content-Type', contentTypes[ext] ?? 'application/octet-stream');
        res.writeHead(200);
        fs.createReadStream(filePath).pipe(res);
    }

    // ── Helpers ──────────────────────────────────────

    /**
     * @param {http.ServerResponse} res
     * @param {number} status
     * @param {unknown} data
     */
    _json(res, status, data) {
        res.setHeader('Content-Type', 'application/json');
        res.writeHead(status);
        res.end(JSON.stringify(data));
    }

    /**
     * @param {http.IncomingMessage} req
     * @returns {Promise<string>}
     */
    _readBody(req) {
        return new Promise((resolve) => {
            let body = '';
            req.on('data', (chunk) => { body += chunk.toString(); });
            req.on('end', () => resolve(body));
        });
    }
}

export { DEFAULT_PORT };

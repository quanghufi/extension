// @ts-check
/**
 * HTTP & WebSocket Server
 *
 * REST API for session lifecycle + WebSocket for live event streaming.
 * Route handlers in api-routes.js, WebSocket in ws-handler.js.
 *
 * @module server
 */

import http from 'node:http';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import path from 'node:path';
import fs from 'node:fs';
import { SessionStore } from './hub/session-store.js';
import { SnapshotManager } from './snapshot/snapshot-manager.js';
import { apiListSessions, apiCreateSession, apiGetSession, apiDeleteSession, apiGetEvents } from './api-routes.js';
import { handleWsConnection, broadcastEvent } from './ws-handler.js';
import { getAdapter } from './adapters/adapter-registry.js';
import { createEvent } from './schema/events.js';

// ── Constants ────────────────────────────────────────

const DEFAULT_PORT = 3849;
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

        /** @type {Map<string, import('./hub/session.js').Session>} */
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
            this._wss.on('connection', (ws) => handleWsConnection(ws, this));

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

    /**
     * Broadcast event to all subscribers of a session.
     * @param {string} sessionId
     * @param {import('./schema/events.js').Event} event
     */
    broadcast(sessionId, event) {
        broadcastEvent(this, sessionId, event);
    }

    /**
     * Run a session by executing its agents.
     * @param {string} sessionId
     */
    async runSession(sessionId) {
        const session = this.activeSessions.get(sessionId);
        if (!session) {
            console.error(`runSession: Session not found: ${sessionId}`);
            return;
        }
        console.log(`[Orchestrator] Starting run for session: ${sessionId}`);

        try {
            session.start();
            const startEvent = createEvent(sessionId, 'system', 'status', { state: 'running' });
            console.log(`[Orchestrator] Broadcasting: ${startEvent.event_type} - ${startEvent.payload.state}`);
            this.broadcast(sessionId, session.addEvent(startEvent));

            // For now, just run codex
            const agentId = 'codex';
            const adapter = getAdapter(agentId);
            session.registerAgent(agentId);
            console.log(`[Orchestrator] Executing adapter: ${agentId}`);

            const { stream, done } = adapter.execute(sessionId, session.projectDir, session.prompt);
            console.log(`[Orchestrator] Adapter execution started, got stream and done promise.`);

            for await (const event of stream) {
                session.addEvent(event);
                this.broadcast(sessionId, event);
            }
            console.log(`[Orchestrator] Stream finished.`);

            const result = await done;
            session.finalize(result.status === 'ok' ? 'completed' : 'failed', result.findings);

            const doneEvent = createEvent(sessionId, 'system', 'status', { state: session.state });
            this.broadcast(sessionId, session.addEvent(doneEvent));

        } catch (err) {
            console.error(`runSession error for ${sessionId}:`, err);
            const errorEvent = createEvent(sessionId, 'system', 'error', { message: err.message });
            this.broadcast(sessionId, session.addEvent(errorEvent));
            session.finalize('failed');
        }
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

        // API routes — delegated to api-routes.js
        if (url.pathname === '/api/sessions' && method === 'GET') {
            return apiListSessions(this, res);
        }
        if (url.pathname === '/api/sessions' && method === 'POST') {
            return apiCreateSession(this, req, res);
        }
        if (url.pathname.match(/^\/api\/sessions\/[^/]+$/) && method === 'GET') {
            const id = url.pathname.split('/').pop() ?? '';
            return apiGetSession(this, id, res);
        }
        if (url.pathname.match(/^\/api\/sessions\/[^/]+$/) && method === 'DELETE') {
            const id = url.pathname.split('/').pop() ?? '';
            return apiDeleteSession(this, id, res);
        }
        if (url.pathname.match(/^\/api\/sessions\/[^/]+\/events$/) && method === 'GET') {
            const id = url.pathname.split('/')[3] ?? '';
            return apiGetEvents(this, id, url, res);
        }

        // Static file serving for UI
        return this._serveStatic(url.pathname, res);
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
}

export { DEFAULT_PORT };

// ── Startup ──────────────────────────────────────────

// This allows the script to be run directly to start the server.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const server = new HubServer();
    server.start().catch((err) => {
        console.error('Failed to start server:', err);
        process.exit(1);
    });
}

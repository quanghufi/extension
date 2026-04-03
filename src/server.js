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
import fsPromises from 'node:fs/promises';
import { SessionStore } from './hub/session-store.js';
import { SnapshotManager } from './snapshot/snapshot-manager.js';
import { apiListSessions, apiCreateSession, apiGetSession, apiDeleteSession, apiGetEvents, apiGetFindings, apiEvaluateFindings, apiRerunSession } from './api-routes.js';
import { apiListMessages, apiPostMessage, apiClaimTurn, apiAssignAgent, apiAdvanceSession } from './collab-routes.js';
import { handleWsConnection, broadcastEvent } from './ws-handler.js';
import { getAdapter, hasAdapter } from './adapters/adapter-registry.js';
import { createEvent } from './schema/events.js';
import { DebateExecutor } from './hub/debate-orchestrator.js';

// ── Constants ────────────────────────────────────────

const DEFAULT_PORT = 3849;
const SERVER_DIR = import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname);
const PROJECT_ROOT = path.resolve(SERVER_DIR, '..');
const UI_DIR = path.join(SERVER_DIR, 'ui');

/**
 * Resolve a Hub storage path against the project root unless explicitly provided.
 *
 * @param {string|undefined} configuredPath
 * @param {string} defaultRelativePath
 * @returns {string}
 */
function resolveHubPath(configuredPath, defaultRelativePath) {
    if (typeof configuredPath === 'string' && configuredPath.trim() !== '') {
        return configuredPath;
    }
    return path.join(PROJECT_ROOT, defaultRelativePath);
}

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
        this.store = new SessionStore(resolveHubPath(options.dataDir, 'data'));

        /** @type {SnapshotManager} */
        this.snapshots = new SnapshotManager(resolveHubPath(options.snapshotDir, path.join('tmp', 'snapshots')));

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
        return new Promise((resolve, reject) => {
            this._server = http.createServer((req, res) => this._handleHttp(req, res));

            this._wss = new WebSocketServer({ server: this._server });
            this._wss.on('connection', (ws) => handleWsConnection(ws, this));

            const onStartupError = (err) => reject(err);
            this._server.once('error', onStartupError);
            this._server.listen(this.port, '127.0.0.1', () => {
                this._server?.removeListener('error', onStartupError);
                console.error(`🚀 Hub server running at http://localhost:${this.port}`);
                console.error(`   REST API: http://localhost:${this.port}/api/sessions`);
                console.error(`   Dashboard: http://localhost:${this.port}/`);
                resolve();
            });
        });
    }

    /**
     * Stop the server.
     * @returns {Promise<void>}
     */
    async stop() {
        // Wait for active sessions to complete (with timeout)
        const shutdownTimeout = 30_000;
        const startWait = Date.now();

        if (this.activeSessions.size > 0) {
            // Wait for sessions that are running OR have active debates
            const runningSessions = [...this.activeSessions.values()].filter(
                (s) => s.state === 'running' || s.debateActive
            );

            if (runningSessions.length > 0) {
                console.error(`[Server] Waiting for ${runningSessions.length} running session(s) to complete...`);

                while (
                    [...this.activeSessions.values()].some((s) => s.state === 'running' || s.debateActive) &&
                    Date.now() - startWait < shutdownTimeout
                ) {
                    await new Promise((r) => setTimeout(r, 500));
                }

                const remaining = [...this.activeSessions.values()].filter((s) => s.state === 'running' || s.debateActive);
                if (remaining.length > 0) {
                    console.error(`[Server] ${remaining.length} session(s) did not complete within ${shutdownTimeout}ms — forcing shutdown`);
                }
            } else {
                console.error(`[Server] ${this.activeSessions.size} session(s) in activeSessions but none running — skipping wait`);
            }
        }

        // Close WebSocket connections
        if (this._wss) {
            for (const client of this._wss.clients) {
                client.close(1001, 'Server shutting down');
            }
            this._wss.close();
        }

        // Close HTTP server
        if (this._server) {
            await new Promise((resolve) => {
                this._server.close(() => resolve());
            });
        }
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
            console.error(`[Orchestrator] runSession: Session not found: ${sessionId}`);
            return;
        }
        console.error(`[Orchestrator] Starting run for session: ${sessionId}`);

        try {
            session.start();
            const startEvent = createEvent(sessionId, 'system', 'status', { state: 'running' });
            console.error(`[Orchestrator] Broadcasting: ${startEvent.event_type} - ${startEvent.payload.state}`);
            this.broadcast(sessionId, session.addEvent(startEvent));

            // Use MCP-backed Codex by default unless a specific adapter is requested.
            const agentId = session.agentId ?? 'codex';
            const adapter = getAdapter(agentId);
            session.registerAgent(agentId);
            console.error(`[Orchestrator] Executing adapter: ${agentId}`);

            // For MCP-based adapters, pass reviewOptions as prompt object
            const isMcpAdapter = agentId.startsWith('mcp-');
            const promptArg = (isMcpAdapter && session.reviewOptions)
                ? { prompt: session.prompt, .../** @type {object} */ (session.reviewOptions) }
                : session.prompt;
            const executionPath = session.snapshotPath ?? session.projectDir;
            const { stream, done } = adapter.execute(sessionId, executionPath, promptArg);
            console.error(`[Orchestrator] Adapter execution started, got stream and done promise.`);

            for await (const event of stream) {
                session.addEvent(event);
                this.broadcast(sessionId, event);
            }
            console.error(`[Orchestrator] Stream finished.`);

            const result = await done;
            const finalState = result.status === 'ok' ? 'completed' : 'failed';
            const doneEvent = createEvent(sessionId, 'system', 'status', { state: finalState });
            this.broadcast(sessionId, session.addEvent(doneEvent));
            session.finalize(finalState, result.findings);
            if (finalState === 'completed') {
                this.syncCodexCompletionIntoCollab(session, result.findings);
            }
            this.store.save(session);
            // State machine cleanup: remove handoff artifacts after finalize
            this.cleanupHandoffArtifacts(session.projectDir).catch(() => { });

        } catch (err) {
            console.error(`runSession error for ${sessionId}:`, err);
            if (!session.isTerminal()) {
                const message = err instanceof Error ? err.message : String(err);
                const errorEvent = createEvent(sessionId, 'system', 'error', { message });
                this.broadcast(sessionId, session.addEvent(errorEvent));
                const failedEvent = createEvent(sessionId, 'system', 'status', { state: 'failed' });
                this.broadcast(sessionId, session.addEvent(failedEvent));
                session.finalize('failed');
                this.store.save(session);
                this.cleanupHandoffArtifacts(session.projectDir).catch(() => { });
            }
        } finally {
            // Let a background debate keep ownership of the active session slot.
            const active = this.activeSessions.get(sessionId);
            if (active === session && !session.debateActive) {
                this.activeSessions.delete(sessionId);
            }
        }
    }

    /**
     * Run a multi-agent debate on a completed session.
     * @param {string} sessionId
     * @param {{ agents: string[], maxRounds?: number, decider?: string, consensusThreshold?: number, seedFindings?: import('./schema/events.js').Finding[], reviewGate?: import('./hub/review-gate.js').GateConfig, promptMode?: 'normal'|'adversarial'|'escalating' }} config
     * @returns {Promise<{ logicalFindings: any[], finalFindings: any[], evaluations: any[] }>}
     */
    async runDebate(sessionId, config) {
        const session = this.activeSessions.get(sessionId) ?? this.store.load(sessionId);
        if (!session) {
            throw new Error(`runDebate: Session not found: ${sessionId}`);
        }

        // Track session while debate is running
        this.activeSessions.set(sessionId, session);

        const executor = new DebateExecutor({
            session,
            onSystemMessage: (msg) => {
                console.error(`[Debate:${sessionId}] ${msg}`);
            },
            onEvent: (event) => {
                session.addEvent(event, { force: true });
                this.broadcast(sessionId, event);
            },
            onCheckpoint: () => {
                this.store.save(session);
            },
        });

        try {
            // Emit debate_started event
            const startedEvent = createEvent(sessionId, 'system', 'debate_started', {
                agents: config.agents,
                maxRounds: config.maxRounds ?? 1,
                decider: config.decider ?? null,
                seedFindingCount: config.seedFindings?.length ?? 0,
            });
            session.addEvent(startedEvent, { force: true });
            this.broadcast(sessionId, startedEvent);
            this.store.save(session);

            const result = await executor.run(config);

            // Emit debate_resolved event
            const resolvedEvent = createEvent(sessionId, 'system', 'debate_resolved', {
                debateState: session.debateState,
                survivalCount: result.logicalFindings.length,
            });
            session.addEvent(resolvedEvent, { force: true });
            this.broadcast(sessionId, resolvedEvent);

            this.store.save(session);
            // State machine cleanup: remove handoff artifacts after debate
            this.cleanupHandoffArtifacts(session.projectDir).catch(() => { });
            return result;
        } catch (err) {
            console.error(`[Debate] runDebate error for ${sessionId}:`, err);
            session.debateActive = false;
            session.debateState = 'failed';
            this.store.save(session);
            throw err;
        } finally {
            // Only delete if this debate run still owns the active session slot.
            const active = this.activeSessions.get(sessionId);
            if (active === session) {
                this.activeSessions.delete(sessionId);
            }
        }
    }

    // ── Handoff Artifact Cleanup ──────────────────────

    /**
     * Auto-advance rerun sessions through the reviewer step after Codex finishes.
     * Keeps collaboration state aligned with the latest review output.
     *
     * @param {import('./hub/session.js').Session} session
     * @param {import('./schema/events.js').Finding[]} findings
     */
    syncCodexCompletionIntoCollab(session, findings) {
        const reviewerId = session.assignments?.reviewer;
        if (!session.parentSessionId || !reviewerId) {
            return;
        }
        if (session.collabState !== 'awaiting_codex_turn') {
            return;
        }

        try {
            const { token } = session.claimTurn(reviewerId);
            const findingLabel = findings.length === 1 ? 'finding' : 'findings';
            session.addMessage({
                agentId: reviewerId,
                role: 'reviewer',
                type: 'review_summary',
                content: `Codex rerun completed with ${findings.length} ${findingLabel}.`,
                turnToken: token,
            });
            session.advanceCollabState('review_complete', reviewerId, {
                turnToken: token,
                payload: { skipResponse: findings.length === 0 },
            });
        } catch (err) {
            console.error(`[Server] Failed to sync Codex completion into collab state for session ${session.id}:`, err);
        }
    }

    /**
     * Clean up timestamped history files from .agent/handoff/,
     * keeping only codex-review.latest.* files.
     * Called by state machine on session finalize (completed/failed).
     * @param {string} projectDir
     */
    async cleanupHandoffArtifacts(projectDir) {
        const handoffDir = path.join(projectDir, '.agent', 'handoff');
        /** @type {import('node:fs').Dirent[]} */
        let entries;
        try {
            entries = await fsPromises.readdir(handoffDir, { withFileTypes: true });
        } catch {
            return; // Directory doesn't exist — nothing to clean
        }

        let deleted = 0;
        for (const entry of entries) {
            if (!entry.isFile()) continue;
            // Keep latest.* files, delete all timestamped history files
            if (entry.name.startsWith('codex-review.latest.')) continue;
            if (!entry.name.startsWith('codex-review.')) continue;
            try {
                await fsPromises.unlink(path.join(handoffDir, entry.name));
                deleted++;
            } catch {
                // Ignore: file may have been removed already
            }
        }
        if (deleted > 0) {
            console.error(`[Cleanup] Removed ${deleted} handoff history file(s) from ${handoffDir}`);
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
        if (url.pathname.match(/^\/api\/sessions\/[^/]+\/findings$/) && method === 'GET') {
            const id = url.pathname.split('/')[3] ?? '';
            return apiGetFindings(this, id, res);
        }
        if (url.pathname.match(/^\/api\/sessions\/[^/]+\/findings\/evaluate$/) && method === 'POST') {
            const id = url.pathname.split('/')[3] ?? '';
            return apiEvaluateFindings(this, id, req, res);
        }
        if (url.pathname.match(/^\/api\/sessions\/[^/]+\/rerun$/) && method === 'POST') {
            const id = url.pathname.split('/')[3] ?? '';
            return apiRerunSession(this, id, req, res);
        }

        // Collaboration routes
        if (url.pathname.match(/^\/api\/sessions\/[^/]+\/messages$/) && method === 'GET') {
            const id = url.pathname.split('/')[3] ?? '';
            return apiListMessages(this, id, url, res);
        }
        if (url.pathname.match(/^\/api\/sessions\/[^/]+\/messages$/) && method === 'POST') {
            const id = url.pathname.split('/')[3] ?? '';
            return apiPostMessage(this, id, req, res);
        }
        if (url.pathname.match(/^\/api\/sessions\/[^/]+\/claim-turn$/) && method === 'POST') {
            const id = url.pathname.split('/')[3] ?? '';
            return apiClaimTurn(this, id, req, res);
        }
        if (url.pathname.match(/^\/api\/sessions\/[^/]+\/assignments$/) && method === 'POST') {
            const id = url.pathname.split('/')[3] ?? '';
            return apiAssignAgent(this, id, req, res);
        }
        if (url.pathname.match(/^\/api\/sessions\/[^/]+\/advance$/) && method === 'POST') {
            const id = url.pathname.split('/')[3] ?? '';
            return apiAdvanceSession(this, id, req, res);
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
        const normalizedUiDir = UI_DIR + path.sep;
        if (!filePath.startsWith(normalizedUiDir) && filePath !== path.join(UI_DIR, 'index.html')) {
            res.writeHead(403);
            res.end('Forbidden');
            return;
        }

        if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
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

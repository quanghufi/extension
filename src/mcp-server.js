#!/usr/bin/env node
// @ts-check
/**
 * Extension Hub — MCP Server Entry Point
 *
 * Exposes Hub functionality as MCP tools via stdio transport,
 * allowing Antigravity (or any MCP client) to interact directly.
 *
 * State machine: IDLE → STARTING → READY → BUSY → READY
 *                                        → ERROR → STARTING (auto-recover)
 *
 * Tools:
 *   hub_list_sessions    — List all review sessions
 *   hub_create_review    — Create and start a new review session
 *   hub_get_status       — Get session status and details
 *   hub_get_findings     — Get findings for a session
 *   hub_evaluate_findings — Accept/reject findings
 *   hub_rerun_review     — Rerun review with context
 *
 * @module mcp-server
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { HubServer } from './server.js';
import { Session } from './hub/session.js';
import { isCollabTurnBased } from './hub/session-collab.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { registerCollabTools, startDebateInBackground, validateDebateRequest } from './mcp-collab-tools.js';

// ── Constants ────────────────────────────────────────

const SERVER_INFO = { name: 'extension-hub', version: '1.0.0' };

const STATES = /** @type {const} */ ({
    IDLE: 'idle',
    STARTING: 'starting',
    READY: 'ready',
    BUSY: 'busy',
    ERROR: 'error',
});

/**
 * @param {string} text
 * @returns {{ content: Array<{ type: 'text', text: string }>, isError: true }}
 */
function createMcpError(text) {
    return {
        content: [{ type: /** @type {const} */ ('text'), text }],
        isError: /** @type {const} */ (true),
    };
}

/**
 * @param {string} text
 * @returns {{ content: Array<{ type: 'text', text: string }> }}
 */
function createMcpResult(text) {
    return {
        content: [{ type: /** @type {const} */ ('text'), text }],
    };
}

/**
 * @param {HubServer} server
 * @param {string} sessionId
 * @returns {{ persisted: boolean, storePath: string, activeInMemory: boolean }}
 */
function getSessionStorageMetadata(server, sessionId) {
    return {
        persisted: server.store.exists(sessionId),
        storePath: server.store.getPath(sessionId),
        activeInMemory: server.activeSessions.has(sessionId),
    };
}

/**
 * @param {HubServer} server
 * @param {string} sessionId
 * @returns {{ persisted: true, storePath: string, activeInMemory: boolean }}
 */
function requirePersistedSession(server, sessionId) {
    const storage = getSessionStorageMetadata(server, sessionId);
    if (!storage.persisted) {
        throw new Error(`Session ${sessionId} was not persisted to disk at ${storage.storePath}`);
    }
    return {
        persisted: true,
        storePath: storage.storePath,
        activeInMemory: storage.activeInMemory,
    };
}

/**
 * @param {HubServer} server
 * @param {{ projectDir: string, prompt?: string, agentId?: string, reviewTarget?: string, filePath?: string, maxFindings?: number }} args
 * @returns {Session}
 */
function createReviewSession(server, args) {
    const reviewTarget = args.reviewTarget ?? 'uncommitted';
    const filePath = args.filePath;
    const prompt = normalizeReviewPrompt({
        prompt: args.prompt,
        reviewTarget,
        filePath,
    });

    const session = new Session({
        projectDir: args.projectDir,
        prompt,
        agentId: args.agentId ?? 'codex',
        reviewOptions: {
            review_target: reviewTarget,
            file_path: filePath,
            max_findings: args.maxFindings ?? 10,
        },
    });

    server.activeSessions.set(session.id, session);
    server.store.save(session);
    requirePersistedSession(server, session.id);
    return session;
}

/**
 * @param {{ reviewTarget?: string, filePath?: string }} args
 * @returns {string|null}
 */
function validateReviewScopeArgs(args) {
    if (args.filePath && args.reviewTarget !== 'file') {
        return 'filePath requires reviewTarget="file" for file-scoped review.';
    }
    return null;
}

/**
 * @param {{ prompt?: string, reviewTarget: string, filePath?: string }} args
 * @returns {string}
 */
function normalizeReviewPrompt(args) {
    const basePrompt = args.prompt?.trim() || 'Review this code for bugs and issues';
    if (args.reviewTarget !== 'file' || !args.filePath) {
        return basePrompt;
    }

    const fileLead = `Review only ${args.filePath}. Stay focused on this file.`;
    const normalizedBase = basePrompt.toLowerCase();
    if (normalizedBase.includes(`review only ${args.filePath.toLowerCase()}`)) {
        return normalizedBase.includes('stay focused on this file')
            ? basePrompt
            : `${basePrompt} Stay focused on this file.`;
    }
    return `${fileLead} ${basePrompt}`;
}

/**
 * @param {import('./hub/session.js').Session} session
 * @param {string} toolName
 */
function getLegacyToolBlock(session, toolName) {
    if (!isCollabTurnBased(session.collabState)) {
        return null;
    }

    /** @type {Record<string, string>} */
    const guidanceByTool = {
        hub_evaluate_findings: 'Use hub_post_message with type="finding_reply" instead.',
        hub_rerun_review: 'Use hub_advance_session with action="request_rerun" instead.',
    };

    const guidance = guidanceByTool[toolName];
    if (!guidance) {
        return null;
    }

    return createMcpError(
        `COLLAB_PATH_ACTIVE: ${toolName} is blocked while collaboration is active `
        + `(collabState=${session.collabState}). ${guidance}`,
    );
}

// ── Hub Manager (lazy init) ──────────────────────────

class HubManager {
    constructor() {
        /** @type {typeof STATES[keyof typeof STATES]} */
        this.state = STATES.IDLE;

        /** @type {Map<string, HubServer>} */
        this._hubs = new Map();

        /** @type {string | null} */
        this._lastError = null;

        /** @type {Map<string, Promise<HubServer>>} */
        this._startPromises = new Map();

        /** @type {Map<string, string>} */
        this._sessionOwners = new Map();
    }

    /**
     * @param {string} projectDir
     * @returns {{ projectDir: string, dataDir: string, snapshotDir: string }}
     */
    getProjectConfig(projectDir) {
        if (typeof projectDir !== 'string' || projectDir.trim() === '') {
            throw new Error('projectDir is required to initialize a Hub server');
        }

        const normalized = path.resolve(projectDir);
        return {
            projectDir: normalized,
            dataDir: path.join(normalized, 'data'),
            snapshotDir: path.join(normalized, 'tmp', 'snapshots'),
        };
    }

    /**
     * @param {string} sessionId
     * @param {string} projectDir
     */
    trackSession(sessionId, projectDir) {
        const { projectDir: normalized } = this.getProjectConfig(projectDir);
        this._sessionOwners.set(sessionId, normalized);
    }

    /**
     * Ensure Hub is started and ready. Lazy-initializes on first call.
     * Concurrent callers share the same startup promise to prevent races.
     * @param {string} projectDir
     * @returns {Promise<HubServer>}
     */
    async ensureReady(projectDir) {
        const config = this.getProjectConfig(projectDir);

        const existing = this._hubs.get(config.projectDir);
        if (existing) {
            this.state = STATES.READY;
            return existing;
        }

        const existingPromise = this._startPromises.get(config.projectDir);
        if (existingPromise) {
            return existingPromise;
        }

        this.state = STATES.STARTING;
        const startPromise = (async () => {
            try {
                const server = new HubServer({
                    port: 0,
                    dataDir: config.dataDir,
                    snapshotDir: config.snapshotDir,
                });
                await server.start();
                this._hubs.set(config.projectDir, server);
                this.state = STATES.READY;
                this._lastError = null;
                this._startPromises.delete(config.projectDir);
                return server;
            } catch (err) {
                this._lastError = err instanceof Error ? err.message : String(err);
                this.state = STATES.ERROR;
                this._startPromises.delete(config.projectDir);
                throw err;
            }
        })();

        this._startPromises.set(config.projectDir, startPromise);
        return startPromise;
    }

    /**
     * Get session from active or stored sessions, along with its owning server.
     * @param {string} sessionId
     * @returns {{ server: HubServer, session: import('./hub/session.js').Session, projectDir: string } | null}
     */
    getSessionRecord(sessionId) {
        const ownerProject = this._sessionOwners.get(sessionId);
        if (ownerProject) {
            const ownerHub = this._hubs.get(ownerProject);
            if (ownerHub) {
                const ownerSession = ownerHub.activeSessions.get(sessionId) ?? ownerHub.store.load(sessionId);
                if (ownerSession) {
                    return { server: ownerHub, session: ownerSession, projectDir: ownerProject };
                }
            }
            this._sessionOwners.delete(sessionId);
        }

        for (const [projectDir, server] of this._hubs.entries()) {
            const session = server.activeSessions.get(sessionId) ?? server.store.load(sessionId);
            if (session) {
                this._sessionOwners.set(sessionId, projectDir);
                return { server, session, projectDir };
            }
        }

        return null;
    }

    /**
     * @param {string} sessionId
     * @returns {import('./hub/session.js').Session | null}
     */
    getSession(sessionId) {
        return this.getSessionRecord(sessionId)?.session ?? null;
    }

    /**
     * @returns {Array<ReturnType<import('./hub/session.js').Session['toSummaryJSON']>>}
     */
    listSessions() {
        const sessions = [];

        for (const server of this._hubs.values()) {
            const ids = server.store.list();
            for (const id of ids) {
                const active = server.activeSessions.get(id);
                const session = active ?? server.store.load(id);
                if (session) {
                    this._sessionOwners.set(id, path.resolve(session.projectDir));
                    sessions.push(session.toSummaryJSON());
                } else {
                    sessions.push({ id, state: 'unknown' });
                }
            }
        }

        return sessions;
    }

    /**
     * Stop the underlying Hub server if it was started.
     * Safe to call multiple times.
     * @returns {Promise<void>}
     */
    async shutdown() {
        this._startPromises.clear();
        this._sessionOwners.clear();
        this.state = STATES.IDLE;

        if (this._hubs.size === 0) {
            return;
        }

        const hubs = [...this._hubs.values()];
        this._hubs.clear();
        await Promise.all(hubs.map((hub) => hub.stop()));
    }

    /**
     * Wait for a session to reach a terminal state.
     * Default 720s > adapter's 600s hardMs to allow clean completion.
     * Also checks for stalled sessions (watchdog) to fail fast.
     * @param {string} sessionId
     * @param {number} [timeoutMs=720_000]
     * @returns {Promise<import('./hub/session.js').Session>}
     */
    async waitForCompletion(sessionId, timeoutMs = 720_000) {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            const record = this.getSessionRecord(sessionId);
            if (!record) throw new Error(`Session ${sessionId} not found`);
            const { session } = record;

            if (['completed', 'failed', 'timeout', 'cancelled'].includes(session.state)) {
                return session;
            }

            // Detect stalled sessions early instead of blocking until timeout
            if (typeof session.getWatchdogStatus === 'function') {
                const watchdog = session.getWatchdogStatus();
                if (watchdog?.stalled) {
                    throw new Error(`Session ${sessionId} stalled (idle ${Math.round((watchdog.idleMs ?? 0) / 1000)}s). Use hub_rerun_review to retry.`);
                }
            }

            await new Promise((r) => setTimeout(r, 2000));
        }
        throw new Error(`Session ${sessionId} timed out after ${timeoutMs}ms`);
    }
}

// ── Build MCP Server ─────────────────────────────────

/**
 * Create and configure the MCP server with all Hub tools.
 * @returns {{ mcpServer: McpServer, hubManager: HubManager }}
 */
function buildMcpServer() {
    const mcpServer = new McpServer(SERVER_INFO, {
        capabilities: { tools: {} },
    });

    const hub = new HubManager();

    // ── Tool: hub_list_sessions ──────────────────────

    mcpServer.tool(
        'hub_list_sessions',
        'List all review sessions with their current status',
        async () => {
            const sessions = hub.listSessions();
            return {
                content: [{
                    type: /** @type {const} */ ('text'),
                    text: JSON.stringify({ sessions, total: sessions.length }, null, 2),
                }],
            };
        },
    );

    // ── Tool: hub_create_review ──────────────────────

    mcpServer.tool(
        'hub_create_review',
        'Create a new code review session and start the review process',
        {
            projectDir: z.string().describe('Project directory to review'),
            prompt: z.string().optional().describe('Review instructions/prompt. For single-file review, start with "Review only <filePath>" and keep scope anchored to that file.'),
            agentId: z.string().optional().describe('Agent ID (default: codex)'),
            reviewTarget: z.string().optional().describe('Review target. Must be "file" when filePath is provided.'),
            filePath: z.string().optional().describe('Specific file to review. Required when reviewing a single file.'),
            maxFindings: z.number().optional().describe('Max findings to return (default: 10)'),
            waitForCompletion: z.boolean().optional().describe('Wait for review to complete before returning (default: false)'),
        },
        async (args) => {
            const server = await hub.ensureReady(args.projectDir);
            hub.state = STATES.BUSY;

            try {
                const invalidArgs = validateReviewScopeArgs(args);
                if (invalidArgs) {
                    hub.state = STATES.READY;
                    return createMcpError(invalidArgs);
                }
                const session = createReviewSession(server, args);
                hub.trackSession(session.id, session.projectDir);

                // Start review in background
                server.runSession(session.id).catch((err) => {
                    console.error(`[MCP] runSession error for ${session.id}:`, err);
                });

                // Optionally wait for completion
                if (args.waitForCompletion) {
                    const completed = await hub.waitForCompletion(session.id);
                    hub.state = STATES.READY;
                    return {
                        content: [{
                            type: /** @type {const} */ ('text'),
                            text: JSON.stringify({
                                sessionId: completed.id,
                                state: completed.state,
                                findingCount: completed.allFindings.length,
                                message: `Review ${completed.state} with ${completed.allFindings.length} findings`,
                            }, null, 2),
                        }],
                    };
                }

                hub.state = STATES.READY;
                return {
                    content: [{
                        type: /** @type {const} */ ('text'),
                        text: JSON.stringify({
                            sessionId: session.id,
                            state: session.state,
                            message: 'Review session created. Use hub_get_status to check progress.',
                        }, null, 2),
                    }],
                };
            } catch (err) {
                hub.state = STATES.READY;
                return {
                    content: [{
                        type: /** @type {const} */ ('text'),
                        text: `Error: ${err instanceof Error ? err.message : String(err)}`,
                    }],
                    isError: true,
                };
            }
        },
    );

    // ── Tool: hub_get_status ─────────────────────────

    mcpServer.tool(
        'hub_create_review_and_start_dual_debate',
        'Create a new review session, wait for completion, then start a mandatory dual-agent debate with codex and claude-code',
        {
            projectDir: z.string().describe('Project directory to review'),
            prompt: z.string().optional().describe('Review instructions/prompt. For single-file review, start with "Review only <filePath>" and keep scope anchored to that file.'),
            agentId: z.string().optional().describe('Review agent ID (default: codex)'),
            reviewTarget: z.string().optional().describe('Review target. Must be "file" when filePath is provided.'),
            filePath: z.string().optional().describe('Specific file to review. Required when reviewing a single file.'),
            maxFindings: z.number().optional().describe('Max findings to return from the review (default: 10)'),
            maxRounds: z.number().optional().describe('Maximum debate rounds (default: 3)'),
            consensusThreshold: z.number().optional().describe('Agreement threshold 0.0-1.0 (default: 0.7)'),
        },
        async (args) => {
            const server = await hub.ensureReady(args.projectDir);
            hub.state = STATES.BUSY;

            try {
                const debateAgents = ['codex', 'claude-code'];
                const decider = 'codex';
                const invalidReviewArgs = validateReviewScopeArgs(args);
                if (invalidReviewArgs) {
                    hub.state = STATES.READY;
                    return createMcpError(invalidReviewArgs);
                }
                const preflightSession = new Session({
                    projectDir: args.projectDir,
                    prompt: normalizeReviewPrompt({
                        prompt: args.prompt,
                        reviewTarget: args.reviewTarget ?? 'uncommitted',
                        filePath: args.filePath,
                    }),
                    agentId: args.agentId ?? 'codex',
                });
                preflightSession.state = 'completed';
                const invalid = validateDebateRequest(preflightSession, {
                    agents: debateAgents,
                    decider,
                    sessionId: '<new-session>',
                });
                if (invalid) {
                    hub.state = STATES.READY;
                    return invalid;
                }

                const session = createReviewSession(server, args);
                hub.trackSession(session.id, session.projectDir);
                server.runSession(session.id).catch((err) => {
                    console.error(`[MCP] runSession error for ${session.id}:`, err);
                });

                const completed = await hub.waitForCompletion(session.id);
                const completedSession = server.activeSessions.get(completed.id) ?? server.store.load(completed.id);
                if (!completedSession) {
                    hub.state = STATES.READY;
                    return createMcpError(`Session ${completed.id} disappeared before debate could start`);
                }
                const storage = requirePersistedSession(server, completed.id);

                const invalidAfterReview = validateDebateRequest(completedSession, {
                    agents: debateAgents,
                    decider,
                    sessionId: completed.id,
                });
                if (invalidAfterReview) {
                    hub.state = STATES.READY;
                    return invalidAfterReview;
                }

                startDebateInBackground(server, completed.id, {
                    agents: debateAgents,
                    maxRounds: args.maxRounds,
                    decider,
                    consensusThreshold: args.consensusThreshold,
                });

                hub.state = STATES.READY;
                return createMcpResult(JSON.stringify({
                    sessionId: completed.id,
                    reviewState: completed.state,
                    findingCount: completed.allFindings.length,
                    debateState: 'starting',
                    debateRound: completedSession.debateRound,
                    debateActive: true,
                    agents: debateAgents,
                    storage,
                    maxRounds: args.maxRounds ?? 3,
                    decider,
                    consensusThreshold: args.consensusThreshold ?? 0.7,
                    message: 'Review completed and dual-agent debate started on the same session.',
                }, null, 2));
            } catch (err) {
                hub.state = STATES.READY;
                return createMcpError(`Error: ${err instanceof Error ? err.message : String(err)}`);
            }
        },
    );

    mcpServer.tool(
        'hub_get_status',
        'Get detailed status and metadata for a review session, including whether it is persisted on disk and active in memory',
        {
            sessionId: z.string().describe('Session UUID'),
        },
        async (args) => {
            const record = hub.getSessionRecord(args.sessionId);
            if (!record) {
                return createMcpError(`Session ${args.sessionId} not found`);
            }
            const { server, session } = record;
            const storage = getSessionStorageMetadata(server, args.sessionId);

            return {
                content: [{
                    type: /** @type {const} */ ('text'),
                    text: JSON.stringify({
                        ...session.toJSON(),
                        storage,
                        watchdog: session.getWatchdogStatus(),
                        // Collaboration fields
                        collabState: session.collabState,
                        assignments: session.assignments,
                        turn: { ...session.turn, token: undefined },
                        pendingAction: session.pendingAction,
                        messageCount: session.messages.length,
                        // Debate fields
                        debateState: session.debateState,
                        debateRound: session.debateRound,
                        debateAgents: session.debateAgents,
                        debateActive: session.debateActive,
                    }, null, 2),
                }],
            };
        },
    );

    // ── Tool: hub_get_findings ───────────────────────

    mcpServer.tool(
        'hub_get_findings',
        'Get all findings (grouped, merged, with rebuttal outcomes) for a session',
        {
            sessionId: z.string().describe('Session UUID'),
        },
        async (args) => {
            const record = hub.getSessionRecord(args.sessionId);
            if (!record) {
                return {
                    content: [{ type: /** @type {const} */ ('text'), text: `Session ${args.sessionId} not found` }],
                    isError: true,
                };
            }
            const { session } = record;

            return {
                content: [{
                    type: /** @type {const} */ ('text'),
                    text: JSON.stringify({
                        grouped: session.groupedFindings,
                        merged: session.mergedFindings,
                        mergeStats: session.mergeStats,
                        totalRaw: session.allFindings.length,
                        rebuttals: session.rebuttals,
                        rebuttalOutcomes: session.rebuttalOutcomes,
                    }, null, 2),
                }],
            };
        },
    );

    // ── Tool: hub_evaluate_findings ──────────────────

    mcpServer.tool(
        'hub_evaluate_findings',
        'Evaluate findings — accept, reject, or dispute with reasoning',
        {
            sessionId: z.string().describe('Session UUID'),
            evaluations: z.array(z.object({
                dedupeKey: z.string().describe('Finding dedupe key'),
                verdict: z.enum(['accepted', 'rejected', 'disputed']).describe('Evaluation verdict'),
                rationale: z.string().optional().describe('Reason for verdict'),
            })).describe('Array of finding evaluations'),
        },
        async (args) => {
            const record = hub.getSessionRecord(args.sessionId);
            if (!record) {
                return {
                    content: [{ type: /** @type {const} */ ('text'), text: `Session ${args.sessionId} not found` }],
                    isError: true,
                };
            }
            const { server, session } = record;

            // Collab path enforcement: block legacy evaluate when collab is active
            const evalBlock = getLegacyToolBlock(session, "hub_evaluate_findings");
            if (evalBlock) return evalBlock;

            try {
                const rebuttals = args.evaluations.map((e) => ({
                    target: e.dedupeKey,
                    verdict: e.verdict,
                    rationale: e.rationale || '',
                }));

                // Store evaluations (using session's rebuttal mechanism)
                if (!session.rebuttals) session.rebuttals = [];
                if (!session.evaluations) session.evaluations = [];
                session.rebuttals.push(...rebuttals);
                session.evaluations.push(...rebuttals);

                // Persist to store so evaluations survive restarts
                server.store.save(session);

                return {
                    content: [{
                        type: /** @type {const} */ ('text'),
                        text: JSON.stringify({
                            evaluated: rebuttals.length,
                            message: `${rebuttals.length} findings evaluated`,
                        }, null, 2),
                    }],
                };
            } catch (err) {
                return createMcpError(`Error: ${err instanceof Error ? err.message : String(err)}`);
            }
        },
    );

    // ── Tool: hub_rerun_review ───────────────────────

    mcpServer.tool(
        'hub_rerun_review',
        'Rerun a review session with updated context or prompt',
        {
            sessionId: z.string().describe('Session UUID to rerun'),
            prompt: z.string().optional().describe('Override prompt for retry'),
            waitForCompletion: z.boolean().optional().describe('Wait for review to complete'),
        },
        async (args) => {
            const record = hub.getSessionRecord(args.sessionId);
            if (!record) {
                return createMcpError(`Session ${args.sessionId} not found`);
            }
            const { server, session } = record;

            const blocked = getLegacyToolBlock(session, 'hub_rerun_review');
            if (blocked) {
                return blocked;
            }

            // Allow rerun for terminal states AND stalled sessions
            const isTerminal = ['completed', 'failed', 'timeout', 'cancelled'].includes(session.state);
            const isStalled = typeof session.getWatchdogStatus === 'function'
                && session.getWatchdogStatus()?.stalled === true;

            if (!isTerminal && !isStalled) {
                return createMcpError(`Cannot rerun: session is still ${session.state}. Wait for completion or stall detection.`);
            }

            try {
                const retry = session.createRetry({
                    prompt: args.prompt,
                });

                server.activeSessions.set(retry.id, retry);
                server.store.save(retry);
                hub.trackSession(retry.id, retry.projectDir);

                server.runSession(retry.id).catch((err) => {
                    console.error(`[MCP] rerun error for ${retry.id}:`, err);
                });

                if (args.waitForCompletion) {
                    const completed = await hub.waitForCompletion(retry.id);
                    return {
                        content: [{
                            type: /** @type {const} */ ('text'),
                            text: JSON.stringify({
                                sessionId: completed.id,
                                parentSessionId: args.sessionId,
                                state: completed.state,
                                findingCount: completed.allFindings.length,
                            }, null, 2),
                        }],
                    };
                }

                return {
                    content: [{
                        type: /** @type {const} */ ('text'),
                        text: JSON.stringify({
                            sessionId: retry.id,
                            parentSessionId: args.sessionId,
                            state: retry.state,
                            message: 'Rerun started. Use hub_get_status to check progress.',
                        }, null, 2),
                    }],
                };
            } catch (err) {
                return createMcpError(`Error: ${err instanceof Error ? err.message : String(err)}`);
            }
        },
    );

    // ── Collaboration Tools ─────────────────────────

    registerCollabTools(mcpServer, hub);

    return { mcpServer, hubManager: hub };
}

// ── Main ─────────────────────────────────────────────

async function main() {
    const { mcpServer, hubManager } = buildMcpServer();

    let shuttingDown = false;
    const shutdown = async (/** @type {string} */ reason, exitCode = 0) => {
        if (shuttingDown) {
            return;
        }

        shuttingDown = true;
        console.error(`[extension-hub MCP] Shutting down (${reason})`);

        try {
            await hubManager.shutdown();
        } catch (err) {
            console.error('[extension-hub MCP] Shutdown error:', err);
            exitCode = 1;
        }

        process.exit(exitCode);
    };

    process.stdin.on('end', () => void shutdown('stdin_end'));
    process.stdin.on('close', () => void shutdown('stdin_close'));
    process.on('disconnect', () => void shutdown('disconnect'));

    // Unhandled rejection handler
    process.on('unhandledRejection', (reason, promise) => {
        console.error('[extension-hub MCP] Unhandled Rejection:', reason);
    });

    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    process.on('SIGHUP', () => void shutdown('SIGHUP'));
    if (process.platform === 'win32') {
        process.on('SIGBREAK', () => void shutdown('SIGBREAK'));
    }

    const transport = new StdioServerTransport();
    await mcpServer.connect(transport);
    console.error('[extension-hub MCP] Server started on stdio');
}

// Only run main when executed directly (not when imported for testing)
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    main().catch((err) => {
        console.error('[extension-hub MCP] Fatal:', err);
        process.exit(1);
    });
}

export { buildMcpServer, createMcpError, getLegacyToolBlock, HubManager, STATES };

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
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { registerCollabTools } from './mcp-collab-tools.js';

// ── Constants ────────────────────────────────────────

const SERVER_INFO = { name: 'extension-hub', version: '1.0.0' };

const STATES = /** @type {const} */ ({
    IDLE: 'idle',
    STARTING: 'starting',
    READY: 'ready',
    BUSY: 'busy',
    ERROR: 'error',
});

// ── Hub Manager (lazy init) ──────────────────────────

class HubManager {
    constructor() {
        /** @type {typeof STATES[keyof typeof STATES]} */
        this.state = STATES.IDLE;

        /** @type {HubServer | null} */
        this._hub = null;

        /** @type {string | null} */
        this._lastError = null;

        /** @type {Promise<HubServer> | null} */
        this._startPromise = null;
    }

    /**
     * Ensure Hub is started and ready. Lazy-initializes on first call.
     * Concurrent callers share the same startup promise to prevent races.
     * @returns {Promise<HubServer>}
     */
    async ensureReady() {
        if (this.state === STATES.READY && this._hub) {
            return this._hub;
        }

        // Memoize startup — concurrent callers share the same promise
        if (this._startPromise) {
            return this._startPromise;
        }

        this.state = STATES.STARTING;
        this._startPromise = (async () => {
            try {
                this._hub = new HubServer({ port: 0 }); // random port
                await this._hub.start();
                this.state = STATES.READY;
                this._lastError = null;
                return this._hub;
            } catch (err) {
                this._lastError = err instanceof Error ? err.message : String(err);
                this.state = STATES.ERROR;
                this._startPromise = null; // allow retry on next call
                throw err;
            }
        })();

        return this._startPromise;
    }

    /**
     * Get session from active or stored sessions.
     * @param {string} sessionId
     * @returns {import('./hub/session.js').Session | null}
     */
    getSession(sessionId) {
        if (!this._hub) return null;
        return this._hub.activeSessions.get(sessionId) ?? this._hub.store.load(sessionId);
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
            const session = this.getSession(sessionId);
            if (!session) throw new Error(`Session ${sessionId} not found`);

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
            const server = await hub.ensureReady();
            const ids = server.store.list();
            const sessions = ids.map((id) => {
                const active = server.activeSessions.get(id);
                if (active) return active.toSummaryJSON();
                const stored = server.store.load(id);
                return stored ? stored.toSummaryJSON() : { id, state: 'unknown' };
            });
            return {
                content: [{
                    type: 'text',
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
            prompt: z.string().optional().describe('Review instructions/prompt'),
            agentId: z.string().optional().describe('Agent ID (default: mcp-codex)'),
            reviewTarget: z.string().optional().describe('Review target: uncommitted, staged, or file path'),
            filePath: z.string().optional().describe('Specific file to review'),
            maxFindings: z.number().optional().describe('Max findings to return (default: 10)'),
            waitForCompletion: z.boolean().optional().describe('Wait for review to complete before returning (default: false)'),
        },
        async (args) => {
            const server = await hub.ensureReady();
            hub.state = STATES.BUSY;

            try {
                const session = new Session({
                    projectDir: args.projectDir,
                    prompt: args.prompt ?? 'Review this code for bugs and issues',
                    agentId: args.agentId ?? 'mcp-codex',
                    reviewOptions: {
                        review_target: args.reviewTarget ?? 'uncommitted',
                        file_path: args.filePath,
                        max_findings: args.maxFindings ?? 10,
                    },
                });

                server.activeSessions.set(session.id, session);
                server.store.save(session);

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
                            type: 'text',
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
                        type: 'text',
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
                        type: 'text',
                        text: `Error: ${err instanceof Error ? err.message : String(err)}`,
                    }],
                    isError: true,
                };
            }
        },
    );

    // ── Tool: hub_get_status ─────────────────────────

    mcpServer.tool(
        'hub_get_status',
        'Get detailed status and metadata for a review session',
        {
            sessionId: z.string().describe('Session UUID'),
        },
        async (args) => {
            await hub.ensureReady();
            const session = hub.getSession(args.sessionId);
            if (!session) {
                return {
                    content: [{ type: 'text', text: `Session ${args.sessionId} not found` }],
                    isError: true,
                };
            }

            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        ...session.toJSON(),
                        watchdog: session.getWatchdogStatus(),
                        // Collaboration fields
                        collabState: session.collabState,
                        assignments: session.assignments,
                        turn: { ...session.turn, token: undefined },
                        pendingAction: session.pendingAction,
                        messageCount: session.messages.length,
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
            await hub.ensureReady();
            const session = hub.getSession(args.sessionId);
            if (!session) {
                return {
                    content: [{ type: 'text', text: `Session ${args.sessionId} not found` }],
                    isError: true,
                };
            }

            return {
                content: [{
                    type: 'text',
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
            await hub.ensureReady();
            const session = hub.getSession(args.sessionId);
            if (!session) {
                return {
                    content: [{ type: 'text', text: `Session ${args.sessionId} not found` }],
                    isError: true,
                };
            }

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
                const server = await hub.ensureReady();
                server.store.save(session);

                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify({
                            evaluated: rebuttals.length,
                            message: `${rebuttals.length} findings evaluated`,
                        }, null, 2),
                    }],
                };
            } catch (err) {
                return {
                    content: [{
                        type: 'text',
                        text: `Error: ${err instanceof Error ? err.message : String(err)}`,
                    }],
                    isError: true,
                };
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
            const server = await hub.ensureReady();
            const session = hub.getSession(args.sessionId);
            if (!session) {
                return {
                    content: [{ type: 'text', text: `Session ${args.sessionId} not found` }],
                    isError: true,
                };
            }

            // Allow rerun for terminal states AND stalled sessions
            const isTerminal = ['completed', 'failed', 'timeout', 'cancelled'].includes(session.state);
            const isStalled = typeof session.getWatchdogStatus === 'function'
                && session.getWatchdogStatus()?.stalled === true;

            if (!isTerminal && !isStalled) {
                return {
                    content: [{
                        type: 'text',
                        text: `Cannot rerun: session is still ${session.state}. Wait for completion or stall detection.`,
                    }],
                    isError: true,
                };
            }

            try {
                const retry = session.createRetry({
                    prompt: args.prompt,
                });

                server.activeSessions.set(retry.id, retry);
                server.store.save(retry);

                server.runSession(retry.id).catch((err) => {
                    console.error(`[MCP] rerun error for ${retry.id}:`, err);
                });

                if (args.waitForCompletion) {
                    const completed = await hub.waitForCompletion(retry.id);
                    return {
                        content: [{
                            type: 'text',
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
                        type: 'text',
                        text: JSON.stringify({
                            sessionId: retry.id,
                            parentSessionId: args.sessionId,
                            state: retry.state,
                            message: 'Rerun started. Use hub_get_status to check progress.',
                        }, null, 2),
                    }],
                };
            } catch (err) {
                return {
                    content: [{
                        type: 'text',
                        text: `Error: ${err instanceof Error ? err.message : String(err)}`,
                    }],
                    isError: true,
                };
            }
        },
    );

    // ── Collaboration Tools ─────────────────────────

    registerCollabTools(mcpServer, hub);

    return { mcpServer, hubManager: hub };
}

// ── Main ─────────────────────────────────────────────

async function main() {
    const { mcpServer } = buildMcpServer();
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

export { buildMcpServer, HubManager, STATES };

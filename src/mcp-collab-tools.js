// @ts-check
/**
 * MCP Collaboration Tool Registrations.
 *
 * Registers 5 collab tools on the MCP server:
 *   hub_post_message, hub_list_messages, hub_claim_turn,
 *   hub_assign_agent, hub_advance_session
 *
 * Each tool follows the pattern: ensureReady → load session → call domain method
 *   → save → emit event → return JSON.
 *
 * @module mcp-collab-tools
 */

import { z } from 'zod';
import { createEvent } from './schema/events.js';
import { hasAdapter } from './adapters/adapter-registry.js';

/**
 * F-8: Block manual collab tools while debate is active.
 * Returns error response if blocked, null if allowed.
 * @param {import('./hub/session.js').Session} session
 * @param {string} toolName
 * @returns {{ content: Array<{ type: string, text: string }>, isError: true } | null}
 */
function getDebateGatingBlock(session, toolName) {
    if (!session.debateActive) return null;
    return {
        content: [{
            type: /** @type {const} */ ('text'),
            text: `DEBATE_ACTIVE: ${toolName} is blocked while a debate is in progress `
                + `(debateState=${session.debateState}). Wait for the debate to resolve.`,
        }],
        isError: true,
    };
}

/**
 * Validate that a session/config can start a debate.
 * Returns MCP error payload when invalid, otherwise null.
 *
 * @param {import('./hub/session.js').Session} session
 * @param {{ agents: string[], decider?: string, sessionId?: string }} options
 * @returns {{ content: Array<{ type: string, text: string }>, isError: true } | null}
 */
export function validateDebateRequest(session, { agents, decider, sessionId }) {
    const resolvedSessionId = sessionId ?? session.id;

    if (session.debateActive) {
        return {
            content: [{
                type: /** @type {const} */ ('text'),
                text: `Debate already active on session ${resolvedSessionId} (state: ${session.debateState})`,
            }],
            isError: true,
        };
    }

    if (session.state !== 'completed') {
        return {
            content: [{
                type: /** @type {const} */ ('text'),
                text: `hub_start_debate requires a completed review session, got state "${session.state}"`,
            }],
            isError: true,
        };
    }

    if (!agents || agents.length === 0 || agents.length > 2) {
        return {
            content: [{
                type: /** @type {const} */ ('text'),
                text: `Debate requires 1-2 agents, got ${agents?.length ?? 0}`,
            }],
            isError: true,
        };
    }

    if (agents.length === 2 && !decider) {
        return {
            content: [{
                type: /** @type {const} */ ('text'),
                text: 'Decider is required for 2-agent debates',
            }],
            isError: true,
        };
    }

    const allAgentIds = [...agents, ...(decider ? [decider] : [])];
    const uniqueIds = [...new Set(allAgentIds)];
    for (const id of uniqueIds) {
        if (!hasAdapter(id)) {
            return {
                content: [{
                    type: /** @type {const} */ ('text'),
                    text: `Unknown agent adapter: "${id}". No adapter registered for this agent ID.`,
                }],
                isError: true,
            };
        }
    }

    return null;
}

/**
 * Start debate asynchronously and log background failures.
 *
 * @param {import('./server.js').HubServer} server
 * @param {string} sessionId
 * @param {{ agents: string[], maxRounds?: number, decider?: string, consensusThreshold?: number, seedFindings?: import('./schema/events.js').Finding[] }} options
 */
export function startDebateInBackground(server, sessionId, options) {
    server.runDebate(sessionId, {
        agents: options.agents,
        maxRounds: options.maxRounds ?? 3,
        decider: options.decider ?? undefined,
        consensusThreshold: options.consensusThreshold ?? 0.7,
        seedFindings: options.seedFindings ?? undefined,
    }).catch((err) => {
        console.error(`[MCP] runDebate error for ${sessionId}:`, err);
    });
}

/**
 * @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} mcpServer
 * @param {import('./mcp-server.js').HubManager} hub
 */
export function registerCollabTools(mcpServer, hub) {
    // ── hub_post_message ─────────────────────────────
    mcpServer.tool(
        'hub_post_message',
        'Post a message to the session collaboration thread',
        {
            sessionId: z.string().describe('Session UUID'),
            agentId: z.string().describe('Agent posting the message'),
            role: z.enum(['reviewer', 'responder', 'decider', 'system']).describe('Agent role'),
            type: z.enum(['note', 'review_summary', 'finding_reply', 'decision', 'rerun_request', 'resolution', 'system']).describe('Message type'),
            content: z.string().describe('Message content'),
            findingRefs: z.string().optional().describe('JSON array of finding refs, e.g. [{"findingId":"f-1"}]'),
            replyToMessageId: z.string().optional().describe('Reply to existing message ID'),
            turnToken: z.string().optional().describe('Turn token for turn-sensitive messages'),
            metadata: z.string().optional().describe('JSON object of additional metadata'),
        },
        async ({ sessionId, agentId, role, type, content, findingRefs, replyToMessageId, turnToken, metadata }) => {
            try {
                const record = hub.getSessionRecord(sessionId);
                if (!record) {
                    return { content: [{ type: /** @type {const} */ ('text'), text: `Session not found: ${sessionId}` }], isError: true };
                }
                const { server, session } = record;

                const parsedFindingRefs = findingRefs ? JSON.parse(findingRefs) : [];
                const parsedMetadata = metadata ? JSON.parse(metadata) : {};

                // F-8: Block during active debate
                const debateBlock = getDebateGatingBlock(session, 'hub_post_message');
                if (debateBlock) return debateBlock;

                const message = session.addMessage({
                    agentId,
                    role,
                    type,
                    content,
                    findingRefs: parsedFindingRefs,
                    replyToMessageId: replyToMessageId ?? null,
                    turnToken: turnToken ?? null,
                    metadata: parsedMetadata,
                });

                // Emit event
                const event = createEvent(sessionId, agentId, 'message_posted', {
                    messageId: message.id,
                    type: message.type,
                    role: message.role,
                    seq: message.seq,
                });
                session.addEvent(event, { force: true });
                server.store.save(session);
                server.broadcast(sessionId, event);

                return {
                    content: [{
                        type: /** @type {const} */ ('text'),
                        text: JSON.stringify({
                            message: { id: message.id, seq: message.seq, type: message.type },
                            collabState: session.collabState,
                        }, null, 2),
                    }],
                };
            } catch (err) {
                return { content: [{ type: /** @type {const} */ ('text'), text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
            }
        }
    );

    // ── hub_list_messages ─────────────────────────────
    mcpServer.tool(
        'hub_list_messages',
        'List messages in a session collaboration thread with filtering',
        {
            sessionId: z.string().describe('Session UUID'),
            afterSeq: z.number().optional().describe('Return messages after this sequence number'),
            limit: z.number().optional().describe('Maximum messages to return'),
            types: z.string().optional().describe('Comma-separated message types to filter'),
            agentId: z.string().optional().describe('Filter by agent ID'),
        },
        async ({ sessionId, afterSeq, limit, types, agentId }) => {
            try {
                const record = hub.getSessionRecord(sessionId);
                if (!record) {
                    return { content: [{ type: /** @type {const} */ ('text'), text: `Session not found: ${sessionId}` }], isError: true };
                }
                const { session } = record;

                const parsedTypes = types ? types.split(',').map(t => t.trim()) : undefined;
                const messages = session.listMessages({ afterSeq, limit, types: parsedTypes, agentId });

                // Redact turnToken from responses
                const redacted = messages.map(m => ({ ...m, turnToken: undefined }));

                return {
                    content: [{
                        type: /** @type {const} */ ('text'),
                        text: JSON.stringify({
                            messages: redacted,
                            total: session.messages.length,
                            nextAfterSeq: messages.length > 0 ? messages[messages.length - 1].seq : (afterSeq ?? -1),
                            collabState: session.collabState,
                            turn: { ...session.turn, token: undefined },
                        }, null, 2),
                    }],
                };
            } catch (err) {
                return { content: [{ type: /** @type {const} */ ('text'), text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
            }
        }
    );

    // ── hub_claim_turn ───────────────────────────────
    mcpServer.tool(
        'hub_claim_turn',
        'Claim the current turn for an agent. Only the expected agent can claim.',
        {
            sessionId: z.string().describe('Session UUID'),
            agentId: z.string().describe('Agent claiming the turn'),
            ttlSeconds: z.number().optional().describe('Turn TTL in seconds (default: 600)'),
        },
        async ({ sessionId, agentId, ttlSeconds }) => {
            try {
                const record = hub.getSessionRecord(sessionId);
                if (!record) {
                    return { content: [{ type: /** @type {const} */ ('text'), text: `Session not found: ${sessionId}` }], isError: true };
                }
                const { server, session } = record;

                // Fix #5: Block manual turn claims during active debates
                const debateBlock = getDebateGatingBlock(session, 'hub_claim_turn');
                if (debateBlock) return debateBlock;

                const previousState = session.collabState;
                const { token } = session.claimTurn(agentId, ttlSeconds ?? 600);

                // Emit turn_claimed (redact token from broadcast)
                const claimEvent = createEvent(sessionId, agentId, 'turn_claimed', {
                    ownerId: agentId,
                    expiresAt: session.turn.claimExpiresAt,
                });
                session.addEvent(claimEvent, { force: true });

                if (previousState !== session.collabState) {
                    const stateEvent = createEvent(sessionId, agentId, 'collab_state_changed', {
                        from: previousState,
                        to: session.collabState,
                    });
                    session.addEvent(stateEvent, { force: true });
                    server.broadcast(sessionId, stateEvent);
                }

                server.store.save(session);
                server.broadcast(sessionId, claimEvent);

                return {
                    content: [{
                        type: /** @type {const} */ ('text'),
                        text: JSON.stringify({
                            token,
                            collabState: session.collabState,
                            turn: session.turn,
                        }, null, 2),
                    }],
                };
            } catch (err) {
                return { content: [{ type: /** @type {const} */ ('text'), text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
            }
        }
    );

    // ── hub_assign_agent ─────────────────────────────
    mcpServer.tool(
        'hub_assign_agent',
        'Assign an agent to a collaboration role (reviewer, responder, decider)',
        {
            sessionId: z.string().describe('Session UUID'),
            role: z.enum(['reviewer', 'responder', 'decider']).describe('Role to assign'),
            agentId: z.string().describe('Agent ID to assign to the role'),
        },
        async ({ sessionId, role, agentId }) => {
            try {
                const record = hub.getSessionRecord(sessionId);
                if (!record) {
                    return { content: [{ type: /** @type {const} */ ('text'), text: `Session not found: ${sessionId}` }], isError: true };
                }
                const { server, session } = record;

                // Fix #5: Block manual agent assignment during active debates
                const debateBlock2 = getDebateGatingBlock(session, 'hub_assign_agent');
                if (debateBlock2) return debateBlock2;

                const previousState = session.collabState;
                session.assignAgent(role, agentId);

                // Emit agent_assigned event
                const assignEvent = createEvent(sessionId, 'system', 'agent_assigned', {
                    role,
                    agentId,
                    assignments: session.assignments,
                });
                session.addEvent(assignEvent, { force: true });

                // Emit state change if assignments triggered transition
                if (previousState !== session.collabState) {
                    const stateEvent = createEvent(sessionId, 'system', 'collab_state_changed', {
                        from: previousState,
                        to: session.collabState,
                    });
                    session.addEvent(stateEvent, { force: true });
                    server.broadcast(sessionId, stateEvent);
                }

                server.store.save(session);
                server.broadcast(sessionId, assignEvent);

                return {
                    content: [{
                        type: /** @type {const} */ ('text'),
                        text: JSON.stringify({
                            assignments: session.assignments,
                            collabState: session.collabState,
                        }, null, 2),
                    }],
                };
            } catch (err) {
                return { content: [{ type: /** @type {const} */ ('text'), text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
            }
        }
    );

    // ── hub_advance_session ──────────────────────────
    mcpServer.tool(
        'hub_advance_session',
        'Advance the collaboration state machine. Actions: review_complete, request_response, request_rerun, resolve, close, release_turn',
        {
            sessionId: z.string().describe('Session UUID'),
            agentId: z.string().describe('Agent performing the action'),
            action: z.enum(['review_complete', 'request_response', 'request_rerun', 'resolve', 'close', 'release_turn']).describe('Advance action'),
            payload: z.string().optional().describe('JSON object of action-specific payload'),
            turnToken: z.string().optional().describe('Required for release_turn; token of the agent currently holding the turn'),
        },
        async ({ sessionId, agentId, action, payload, turnToken }) => {
            try {
                const record = hub.getSessionRecord(sessionId);
                if (!record) {
                    return { content: [{ type: /** @type {const} */ ('text'), text: `Session not found: ${sessionId}` }], isError: true };
                }
                const { server, session } = record;

                const parsedPayload = payload ? JSON.parse(payload) : undefined;

                // F-8: Block during active debate
                const debateBlock = getDebateGatingBlock(session, 'hub_advance_session');
                if (debateBlock) return debateBlock;

                const result = session.advanceCollabState(action, agentId, {
                    payload: parsedPayload,
                    turnToken,
                });

                // Emit collab_state_changed
                const stateEvent = createEvent(sessionId, agentId, 'collab_state_changed', {
                    action,
                    from: result.previousState,
                    to: result.nextState,
                    pendingAction: result.pendingAction ?? null,
                });
                session.addEvent(stateEvent, { force: true });

                // Emit specific lifecycle events
                if (action === 'resolve') {
                    const resolveEvent = createEvent(sessionId, agentId, 'session_resolved', {
                        from: result.previousState,
                    });
                    session.addEvent(resolveEvent, { force: true });
                    server.broadcast(sessionId, resolveEvent);
                } else if (action === 'close') {
                    const closeEvent = createEvent(sessionId, agentId, 'session_closed', {
                        from: result.previousState,
                    });
                    session.addEvent(closeEvent, { force: true });
                    server.broadcast(sessionId, closeEvent);
                }

                // Save after all events appended
                server.store.save(session);
                server.broadcast(sessionId, stateEvent);

                return {
                    content: [{
                        type: /** @type {const} */ ('text'),
                        text: JSON.stringify({
                            action,
                            previousState: result.previousState,
                            nextState: result.nextState,
                            collabState: session.collabState,
                            pendingAction: result.pendingAction ?? null,
                            turn: session.turn,
                        }, null, 2),
                    }],
                };
            } catch (err) {
                return { content: [{ type: /** @type {const} */ ('text'), text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
            }
        }
    );

    // ── hub_start_debate ─────────────────────────────
    mcpServer.tool(
        'hub_start_debate',
        'Start an automated multi-round debate between AI agents on an existing review session',
        {
            sessionId: z.string().describe('Session UUID — must be a completed review session'),
            agents: z.array(z.string()).min(1).max(2).describe('Agent IDs to debate (1-2 agents, e.g. ["codex"] or ["codex", "claude-code"])'),
            maxRounds: z.number().optional().describe('Maximum debate rounds (default: 3)'),
            decider: z.string().optional().describe('Decider agent ID for tie-breaks (required if 2 agents)'),
            consensusThreshold: z.number().optional().describe('Agreement threshold 0.0-1.0 (default: 0.7)'),
        },
        async ({ sessionId, agents, maxRounds, decider, consensusThreshold }) => {
            try {
                const record = hub.getSessionRecord(sessionId);
                if (!record) {
                    return { content: [{ type: /** @type {const} */ ('text'), text: `Session not found: ${sessionId}` }], isError: true };
                }
                const { server, session } = record;

                const invalid = validateDebateRequest(session, { agents, decider, sessionId });
                if (invalid) return invalid;

                startDebateInBackground(server, sessionId, {
                    agents,
                    maxRounds,
                    decider,
                    consensusThreshold,
                });

                return {
                    content: [{
                        type: /** @type {const} */ ('text'),
                        text: JSON.stringify({
                            sessionId,
                            debateState: 'starting',
                            debateRound: session.debateRound,
                            debateActive: true,
                            agents,
                            maxRounds: maxRounds ?? 3,
                            decider: decider ?? null,
                            consensusThreshold: consensusThreshold ?? 0.7,
                            message: 'Debate started in background. Use hub_get_status to watch progress.',
                        }, null, 2),
                    }],
                };
            } catch (err) {
                return { content: [{ type: /** @type {const} */ ('text'), text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
            }
        }
    );
}

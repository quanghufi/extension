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
                const server = await hub.ensureReady();
                const session = server.activeSessions.get(sessionId) ?? server.store.load(sessionId);
                if (!session) {
                    return { content: [{ type: 'text', text: `Session not found: ${sessionId}` }], isError: true };
                }

                const parsedFindingRefs = findingRefs ? JSON.parse(findingRefs) : [];
                const parsedMetadata = metadata ? JSON.parse(metadata) : {};

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
                        type: 'text',
                        text: JSON.stringify({
                            message: { id: message.id, seq: message.seq, type: message.type },
                            collabState: session.collabState,
                        }, null, 2),
                    }],
                };
            } catch (err) {
                return { content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
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
                const server = await hub.ensureReady();
                const session = server.activeSessions.get(sessionId) ?? server.store.load(sessionId);
                if (!session) {
                    return { content: [{ type: 'text', text: `Session not found: ${sessionId}` }], isError: true };
                }

                const parsedTypes = types ? types.split(',').map(t => t.trim()) : undefined;
                const messages = session.listMessages({ afterSeq, limit, types: parsedTypes, agentId });

                // Redact turnToken from responses
                const redacted = messages.map(m => ({ ...m, turnToken: undefined }));

                return {
                    content: [{
                        type: 'text',
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
                return { content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
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
                const server = await hub.ensureReady();
                const session = server.activeSessions.get(sessionId) ?? server.store.load(sessionId);
                if (!session) {
                    return { content: [{ type: 'text', text: `Session not found: ${sessionId}` }], isError: true };
                }

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
                        type: 'text',
                        text: JSON.stringify({
                            token,
                            collabState: session.collabState,
                            turn: session.turn,
                        }, null, 2),
                    }],
                };
            } catch (err) {
                return { content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
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
                const server = await hub.ensureReady();
                const session = server.activeSessions.get(sessionId) ?? server.store.load(sessionId);
                if (!session) {
                    return { content: [{ type: 'text', text: `Session not found: ${sessionId}` }], isError: true };
                }

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
                        type: 'text',
                        text: JSON.stringify({
                            assignments: session.assignments,
                            collabState: session.collabState,
                        }, null, 2),
                    }],
                };
            } catch (err) {
                return { content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
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
        },
        async ({ sessionId, agentId, action, payload }) => {
            try {
                const server = await hub.ensureReady();
                const session = server.activeSessions.get(sessionId) ?? server.store.load(sessionId);
                if (!session) {
                    return { content: [{ type: 'text', text: `Session not found: ${sessionId}` }], isError: true };
                }

                const parsedPayload = payload ? JSON.parse(payload) : undefined;
                const result = session.advanceCollabState(action, agentId, { payload: parsedPayload });

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
                        type: 'text',
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
                return { content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
            }
        }
    );
}

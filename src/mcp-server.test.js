// @ts-check
/**
 * Unit tests for MCP Server — Hub tools exposed via MCP protocol.
 *
 * @module mcp-server.test
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { getLegacyToolBlock, HubManager, STATES, buildMcpServer } from './mcp-server.js';

// ── HubManager ───────────────────────────────────────

describe('HubManager', () => {
    it('starts in idle state', () => {
        const mgr = new HubManager();
        assert.equal(mgr.state, STATES.IDLE);
    });

    it('getSession returns null before hub is started', () => {
        const mgr = new HubManager();
        assert.equal(mgr.getSession('nonexistent'), null);
    });

    it('STATES has all required states', () => {
        assert.ok('IDLE' in STATES);
        assert.ok('STARTING' in STATES);
        assert.ok('READY' in STATES);
        assert.ok('BUSY' in STATES);
        assert.ok('ERROR' in STATES);
    });
});

// ── buildMcpServer ───────────────────────────────────

describe('buildMcpServer', () => {
    it('returns mcpServer and hubManager', () => {
        const { mcpServer, hubManager } = buildMcpServer();
        assert.ok(mcpServer);
        assert.ok(hubManager);
        assert.equal(hubManager.state, STATES.IDLE);
    });

    it('hubManager starts in idle and has correct interface', () => {
        const { hubManager } = buildMcpServer();
        assert.equal(typeof hubManager.ensureReady, 'function');
        assert.equal(typeof hubManager.getSession, 'function');
        assert.equal(typeof hubManager.waitForCompletion, 'function');
    });

    it('lists all MCP tools over stdio without schema errors', async () => {
        const testDir = path.dirname(fileURLToPath(import.meta.url));
        const serverPath = path.join(testDir, 'mcp-server.js');
        const client = new Client({ name: 'mcp-server-test-client', version: '1.0.0' });
        const transport = new StdioClientTransport({
            command: process.execPath,
            args: [serverPath],
            stderr: 'pipe',
        });

        const stderrChunks = [];
        transport.stderr?.on('data', (chunk) => {
            stderrChunks.push(chunk.toString('utf8'));
        });

        try {
            await client.connect(transport);
            const result = await client.listTools();
            const toolNames = result.tools.map((tool) => tool.name);

            assert.equal(result.tools.length, 12);
            assert.deepEqual(toolNames, [
                'hub_list_sessions',
                'hub_create_review',
                'hub_get_status',
                'hub_get_findings',
                'hub_evaluate_findings',
                'hub_rerun_review',
                'hub_post_message',
                'hub_list_messages',
                'hub_claim_turn',
                'hub_assign_agent',
                'hub_advance_session',
                'hub_start_debate',
            ]);

            assert.ok(result.tools.every((tool) => typeof tool.inputSchema === 'object' && tool.inputSchema !== null));
            assert.ok(!stderrChunks.join('').includes("Cannot read properties of undefined (reading '_zod')"));
        } finally {
            await client.close();
        }
    });

    it('rejects hub_start_debate unless the review session is completed', async () => {
        const testDir = path.dirname(fileURLToPath(import.meta.url));
        const serverPath = path.join(testDir, 'mcp-server.js');
        const client = new Client({ name: 'mcp-server-test-client', version: '1.0.0' });
        const transport = new StdioClientTransport({
            command: process.execPath,
            args: [serverPath],
            stderr: 'pipe',
        });

        try {
            await client.connect(transport);

            const createResult = await client.callTool({
                name: 'hub_create_review',
                arguments: {
                    projectDir: testDir,
                    prompt: 'Test review',
                    waitForCompletion: false,
                },
            });
            const createPayload = JSON.parse(createResult.content[0].text);

            const debateResult = await client.callTool({
                name: 'hub_start_debate',
                arguments: {
                    sessionId: createPayload.sessionId,
                    agents: ['codex'],
                },
            });

            assert.equal(debateResult.isError, true);
            assert.match(debateResult.content[0].text, /completed review session/i);
        } finally {
            await client.close();
        }
    });
});

describe('getLegacyToolBlock', () => {
    it('blocks evaluate_findings during active turn-based collaboration', () => {
        const result = getLegacyToolBlock({ collabState: 'antigravity_reviewing' }, 'hub_evaluate_findings');

        assert.ok(result);
        assert.equal(result.isError, true);
        assert.match(result.content[0].text, /COLLAB_PATH_ACTIVE/);
        assert.match(result.content[0].text, /hub_post_message/);
    });

    it('blocks rerun_review during active turn-based collaboration', () => {
        const result = getLegacyToolBlock({ collabState: 'awaiting_resolution' }, 'hub_rerun_review');

        assert.ok(result);
        assert.equal(result.isError, true);
        assert.match(result.content[0].text, /request_rerun/);
    });

    it('allows legacy tools outside the active collaboration path', () => {
        assert.equal(getLegacyToolBlock({ collabState: 'draft' }, 'hub_evaluate_findings'), null);
        assert.equal(getLegacyToolBlock({ collabState: 'failed' }, 'hub_rerun_review'), null);
        assert.equal(getLegacyToolBlock({ collabState: 'resolved' }, 'hub_evaluate_findings'), null);
    });
});

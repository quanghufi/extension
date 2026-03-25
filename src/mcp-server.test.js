// @ts-check
/**
 * Unit tests for MCP Server — Hub tools exposed via MCP protocol.
 *
 * @module mcp-server.test
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
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

            assert.equal(result.tools.length, 13);
            assert.deepEqual(toolNames, [
                'hub_list_sessions',
                'hub_create_review',
                'hub_create_review_and_start_dual_debate',
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

    it('exposes dual debate tool as a fixed codex-first single-round flow', async () => {
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

            const result = await client.listTools();
            const dualTool = result.tools.find((tool) => tool.name === 'hub_create_review_and_start_dual_debate');

            assert.ok(dualTool);
            const properties = dualTool.inputSchema.properties ?? {};
            assert.ok(!('agentId' in properties));
            assert.ok(!('agents' in properties));
            assert.ok(!('decider' in properties));
            assert.ok(!('maxRounds' in properties));
            assert.ok(!('consensusThreshold' in properties));
        } finally {
            await client.close();
        }
    });

    it('dual debate response includes persisted storage path', async () => {
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

            const result = await client.callTool({
                name: 'hub_create_review_and_start_dual_debate',
                arguments: {
                    projectDir: testDir,
                    reviewTarget: 'file',
                    filePath: 'src/http-utils.js',
                    prompt: 'Review only src/http-utils.js',
                },
            }, undefined, { timeout: 720000 });
            const payload = JSON.parse(result.content[0].text);

            assert.equal(payload.storage.persisted, true);
            assert.equal(typeof payload.storage.storePath, 'string');
            assert.equal(payload.reviewAgent, 'codex');
            assert.equal(payload.maxRounds, 1);
            assert.equal(payload.debateMode, 'codex_findings_only');
            const expectedSessionsDir = path.join(testDir, 'data', 'sessions');
            assert.ok(payload.storage.storePath.startsWith(expectedSessionsDir));
            assert.match(payload.storage.storePath, /sessions[\\/].+\.json$/i);
        } finally {
            await client.close();
        }
    });

    it('rejects filePath without reviewTarget=file for hub_create_review', async () => {
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

            const result = await client.callTool({
                name: 'hub_create_review',
                arguments: {
                    projectDir: testDir,
                    filePath: 'src/http-utils.js',
                    prompt: 'Review src/http-utils.js',
                },
            });

            assert.equal(result.isError, true);
            assert.match(result.content[0].text, /filePath requires reviewTarget="file"/i);
        } finally {
            await client.close();
        }
    });

    it('auto-anchors file review prompts for hub_create_review', async () => {
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
                    reviewTarget: 'file',
                    filePath: 'src/http-utils.js',
                    prompt: 'Check for bugs.',
                    waitForCompletion: false,
                },
            });
            const createPayload = JSON.parse(createResult.content[0].text);

            const statusResult = await client.callTool({
                name: 'hub_get_status',
                arguments: { sessionId: createPayload.sessionId },
            });
            const statusPayload = JSON.parse(statusResult.content[0].text);

            assert.match(statusPayload.prompt, /Review only src\/http-utils\.js/i);
            assert.match(statusPayload.prompt, /Stay focused on this file/i);
        } finally {
            await client.close();
        }
    });

    it('hub_get_status reports persisted storage metadata', async () => {
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

            const statusResult = await client.callTool({
                name: 'hub_get_status',
                arguments: { sessionId: createPayload.sessionId },
            });
            const statusPayload = JSON.parse(statusResult.content[0].text);

            assert.equal(statusPayload.storage.persisted, true);
            assert.equal(typeof statusPayload.storage.storePath, 'string');
            const expectedSessionsDir = path.join(testDir, 'data', 'sessions');
            assert.ok(statusPayload.storage.storePath.startsWith(expectedSessionsDir));
            assert.match(statusPayload.storage.storePath, /sessions[\\/].+\.json$/i);
            assert.equal(statusPayload.storage.activeInMemory, true);
        } finally {
            await client.close();
        }
    });

    it('stores sessions under each projectDir instead of the MCP cwd', async () => {
        const testDir = path.dirname(fileURLToPath(import.meta.url));
        const projectA = await fs.mkdtemp(path.join(os.tmpdir(), 'extension-mcp-a-'));
        const projectB = await fs.mkdtemp(path.join(os.tmpdir(), 'extension-mcp-b-'));
        const serverPath = path.join(testDir, 'mcp-server.js');
        const client = new Client({ name: 'mcp-server-test-client', version: '1.0.0' });
        const transport = new StdioClientTransport({
            command: process.execPath,
            args: [serverPath],
            stderr: 'pipe',
        });

        try {
            await client.connect(transport);

            const first = await client.callTool({
                name: 'hub_create_review',
                arguments: {
                    projectDir: projectA,
                    prompt: 'Review project A',
                    waitForCompletion: false,
                },
            });
            const firstPayload = JSON.parse(first.content[0].text);

            const second = await client.callTool({
                name: 'hub_create_review',
                arguments: {
                    projectDir: projectB,
                    prompt: 'Review project B',
                    waitForCompletion: false,
                },
            });
            const secondPayload = JSON.parse(second.content[0].text);

            const firstStatus = await client.callTool({
                name: 'hub_get_status',
                arguments: { sessionId: firstPayload.sessionId },
            });
            const secondStatus = await client.callTool({
                name: 'hub_get_status',
                arguments: { sessionId: secondPayload.sessionId },
            });

            const firstStatusPayload = JSON.parse(firstStatus.content[0].text);
            const secondStatusPayload = JSON.parse(secondStatus.content[0].text);

            assert.ok(firstStatusPayload.storage.storePath.startsWith(path.join(projectA, 'data', 'sessions')));
            assert.ok(secondStatusPayload.storage.storePath.startsWith(path.join(projectB, 'data', 'sessions')));
            assert.notEqual(firstStatusPayload.storage.storePath, secondStatusPayload.storage.storePath);
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

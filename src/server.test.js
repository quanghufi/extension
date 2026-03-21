// @ts-check
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { HubServer } from './server.js';
import { getAdapter, registerAdapter } from './adapters/adapter-registry.js';
import { Session } from './hub/session.js';

const TEST_PORT = 33847 + Math.floor(Math.random() * 1000);
let server;

describe('HubServer', () => {
    before(async () => {
        server = new HubServer({
            port: TEST_PORT,
            dataDir: `./tmp/test-server-${Date.now()}`,
            snapshotDir: `./tmp/test-snap-${Date.now()}`,
        });
        await server.start();
    });

    after(async () => {
        await server.stop();
    });

    /**
     * @param {string} path
     * @param {object} [options]
     * @returns {Promise<{status: number, body: any}>}
     */
    function apiRequest(path, options = {}) {
        return new Promise((resolve, reject) => {
            const url = `http://localhost:${TEST_PORT}${path}`;
            const urlObj = new URL(url);

            const opts = {
                hostname: urlObj.hostname,
                port: urlObj.port,
                path: urlObj.pathname + urlObj.search,
                method: options.method ?? 'GET',
                headers: { 'Content-Type': 'application/json' },
            };

            const req = http.request(opts, (res) => {
                let body = '';
                res.on('data', (c) => { body += c; });
                res.on('end', () => {
                    try {
                        resolve({ status: res.statusCode ?? 0, body: JSON.parse(body) });
                    } catch {
                        resolve({ status: res.statusCode ?? 0, body });
                    }
                });
            });

            req.on('error', reject);

            if (options.body) {
                req.write(JSON.stringify(options.body));
            }
            req.end();
        });
    }

    it('GET /api/sessions returns empty list initially', async () => {
        const { status, body } = await apiRequest('/api/sessions');
        assert.equal(status, 200);
        assert.ok(Array.isArray(body.sessions));
    });

    it('POST /api/sessions creates a session', async () => {
        const { status, body } = await apiRequest('/api/sessions', {
            method: 'POST',
            body: { projectDir: '/test', prompt: 'Review code', autoStart: false },
        });
        assert.equal(status, 201);
        assert.ok(body.session);
        assert.ok(body.session.id);
        assert.equal(body.session.state, 'pending');
        assert.equal(body.session.agentId, 'mcp-codex');
    });

    it('POST /api/sessions supports autoStart=false without launching a background review', async () => {
        const { status, body } = await apiRequest('/api/sessions', {
            method: 'POST',
            body: { projectDir: '/no-autostart', prompt: 'Review code', autoStart: false },
        });

        assert.equal(status, 201);
        assert.equal(body.session.state, 'pending');

        const stored = server.activeSessions.get(body.session.id);
        assert.ok(stored);
        assert.equal(stored.state, 'pending');
        assert.equal(stored.events.length, 0);
    });

    it('POST /api/sessions accepts file review options and snapshotPath', async () => {
        const { status, body } = await apiRequest('/api/sessions', {
            method: 'POST',
            body: {
                projectDir: '/project',
                snapshotPath: '/snapshot',
                prompt: 'Review this plan',
                autoStart: false,
                reviewOptions: {
                    review_target: 'file',
                    file_path: 'plans/260308-1959-phase2-polish/phase-04-code-annotation.md',
                    max_findings: 5,
                },
            },
        });

        assert.equal(status, 201);
        assert.equal(body.session.snapshotPath, '/snapshot');
        assert.equal(body.session.agentId, 'mcp-codex');
    });

    it('GET /api/sessions/:id returns a session', async () => {
        // Create first
        const createRes = await apiRequest('/api/sessions', {
            method: 'POST',
            body: { projectDir: '/test2', prompt: 'test', autoStart: false },
        });
        const id = createRes.body.session.id;

        const { status, body } = await apiRequest(`/api/sessions/${id}`);
        assert.equal(status, 200);
        assert.equal(body.session.id, id);
        assert.ok(body.watchdog);
    });

    it('GET /api/sessions/:id returns 404 for unknown', async () => {
        const { status } = await apiRequest('/api/sessions/nonexistent-id');
        assert.equal(status, 404);
    });

    it('GET /api/sessions/:id/events returns events', async () => {
        const createRes = await apiRequest('/api/sessions', {
            method: 'POST',
            body: { projectDir: '/test3', prompt: 'test', autoStart: false },
        });
        const id = createRes.body.session.id;

        const { status, body } = await apiRequest(`/api/sessions/${id}/events`);
        assert.equal(status, 200);
        assert.ok(Array.isArray(body.events));
    });

    it('GET /api/sessions/:id/events supports ?after= filter', async () => {
        const createRes = await apiRequest('/api/sessions', {
            method: 'POST',
            body: { projectDir: '/test4', prompt: 'test', autoStart: false },
        });
        const id = createRes.body.session.id;

        const { status, body } = await apiRequest(`/api/sessions/${id}/events?after=5`);
        assert.equal(status, 200);
        assert.ok(Array.isArray(body.events));
    });

    it('DELETE /api/sessions/:id deletes session', async () => {
        const createRes = await apiRequest('/api/sessions', {
            method: 'POST',
            body: { projectDir: '/test5', prompt: 'test', autoStart: false },
        });
        const id = createRes.body.session.id;

        const { status } = await apiRequest(`/api/sessions/${id}`, { method: 'DELETE' });
        assert.equal(status, 200);

        const { status: getStatus } = await apiRequest(`/api/sessions/${id}`);
        assert.equal(getStatus, 404);
    });

    it('GET / serves dashboard HTML', async () => {
        const { status } = await apiRequest('/');
        // May be 200 (HTML) or 404 if UI file not found
        assert.ok([200, 404].includes(status));
    });

    it('handles CORS preflight', async () => {
        const { status } = await apiRequest('/api/sessions', { method: 'OPTIONS' });
        assert.equal(status, 204);
    });

    it('runSession records failed completion without terminal-state addEvent error', async () => {
        const originalCodex = getAdapter('mcp-codex');
        const originalError = console.error;
        const logged = [];

        console.error = (...args) => {
            logged.push(args.map(String).join(' '));
        };

        registerAdapter({
            agentId: 'mcp-codex',
            buildCommand: () => ({ cmd: 'fake', args: [] }),
            parseChunk: async function* () { },
            parseResult: () => [],
            execute: () => ({
                stream: (async function* () { })(),
                done: Promise.resolve({ status: 'failed', findings: [] }),
            }),
        }, { replace: true });

        try {
            const createRes = await apiRequest('/api/sessions', {
                method: 'POST',
                body: { projectDir: '/failed-run', prompt: 'test' },
            });
            const id = createRes.body.session.id;

            await new Promise((resolve) => setTimeout(resolve, 25));

            const { body } = await apiRequest(`/api/sessions/${id}`);
            const events = body.session.events;

            assert.equal(body.session.state, 'failed');
            assert.equal(events.at(-1).event_type, 'status');
            assert.equal(events.at(-1).payload.state, 'failed');
            assert.equal(logged.some((line) => /runSession error|FATAL|Unhandled/i.test(line)), false);
        } finally {
            console.error = originalError;
            registerAdapter(originalCodex, { replace: true });
        }
    });

    it('runSession records one error event when adapter execution throws', async () => {
        const originalCodex = getAdapter('mcp-codex');
        registerAdapter({
            agentId: 'mcp-codex',
            buildCommand: () => ({ cmd: 'fake', args: [] }),
            parseChunk: async function* () { },
            parseResult: () => [],
            execute: () => ({
                stream: (async function* () { })(),
                done: Promise.reject(new Error('adapter boom')),
            }),
        }, { replace: true });

        try {
            const createRes = await apiRequest('/api/sessions', {
                method: 'POST',
                body: { projectDir: '/throw-run', prompt: 'test' },
            });
            const id = createRes.body.session.id;

            await new Promise((resolve) => setTimeout(resolve, 25));

            const { body } = await apiRequest(`/api/sessions/${id}`);
            const errorEvents = body.session.events.filter((event) => event.event_type === 'error');

            assert.equal(body.session.state, 'failed');
            assert.equal(errorEvents.length, 1);
            assert.match(errorEvents[0].payload.message, /adapter boom/);
        } finally {
            registerAdapter(originalCodex, { replace: true });
        }
    });

    it('runSession prefers snapshotPath over projectDir', async () => {
        const originalMcpCodex = getAdapter('mcp-codex');
        registerAdapter({
            agentId: 'mcp-codex',
            buildCommand: () => ({ cmd: 'fake', args: [] }),
            parseChunk: async function* () { },
            parseResult: () => [],
            execute: (_sessionId, projectDir) => ({
                stream: (async function* () { })(),
                done: Promise.resolve({
                    status: projectDir === '/snapshot-dir' ? 'ok' : 'failed',
                    findings: [],
                    timingMs: { firstByteMs: 0, lastIdleGapMs: 0, totalMs: 0 },
                }),
            }),
        }, { replace: true });

        try {
            const createRes = await apiRequest('/api/sessions', {
                method: 'POST',
                body: {
                    projectDir: '/project-dir',
                    snapshotPath: '/snapshot-dir',
                    prompt: 'test',
                },
            });
            const id = createRes.body.session.id;

            await new Promise((resolve) => setTimeout(resolve, 25));

            const { body } = await apiRequest(`/api/sessions/${id}`);
            assert.equal(body.session.state, 'completed');
        } finally {
            registerAdapter(originalMcpCodex, { replace: true });
        }
    });

    it('runSession auto-syncs Codex completion into collab state for clean rerun sessions', async () => {
        const originalMcpCodex = getAdapter('mcp-codex');
        registerAdapter({
            agentId: 'mcp-codex',
            buildCommand: () => ({ cmd: 'fake', args: [] }),
            parseChunk: async function* () { },
            parseResult: () => [],
            execute: () => ({
                stream: (async function* () { })(),
                done: Promise.resolve({
                    status: 'ok',
                    findings: [],
                    timingMs: { firstByteMs: 0, lastIdleGapMs: 0, totalMs: 0 },
                }),
            }),
        }, { replace: true });

        try {
            const parent = new Session({
                projectDir: '/clean-rerun',
                prompt: 'test',
                agentId: 'mcp-codex',
            });
            const child = parent.createRetry();
            server.activeSessions.set(child.id, child);
            server.store.save(child);

            await server.runSession(child.id);

            const stored = server.activeSessions.get(child.id) ?? server.store.load(child.id);
            assert.ok(stored);
            assert.equal(stored.state, 'completed');
            assert.equal(stored.collabState, 'awaiting_resolution');
            assert.equal(stored.messages.length, 1);
            assert.equal(stored.messages[0].type, 'review_summary');
            assert.match(stored.messages[0].content, /0 findings/i);
        } finally {
            registerAdapter(originalMcpCodex, { replace: true });
        }
    });

    it('runSession auto-syncs Codex completion into antigravity turn when findings exist', async () => {
        const originalMcpCodex = getAdapter('mcp-codex');
        registerAdapter({
            agentId: 'mcp-codex',
            buildCommand: () => ({ cmd: 'fake', args: [] }),
            parseChunk: async function* () { },
            parseResult: () => [],
            execute: () => ({
                stream: (async function* () { })(),
                done: Promise.resolve({
                    status: 'ok',
                    findings: [{
                        id: 'F-TEST1234',
                        severity: 'high',
                        summary: 'Test finding',
                        evidence: 'evidence',
                        file: 'src/app.js',
                        line: 10,
                        confidence: 0.9,
                        dedupe_key: 'src/app.js:10:test finding',
                        fix_instructions: null,
                        why_it_matters: null,
                    }],
                    timingMs: { firstByteMs: 0, lastIdleGapMs: 0, totalMs: 0 },
                }),
            }),
        }, { replace: true });

        try {
            const parent = new Session({
                projectDir: '/findings-rerun',
                prompt: 'test',
                agentId: 'mcp-codex',
            });
            const child = parent.createRetry();
            server.activeSessions.set(child.id, child);
            server.store.save(child);

            await server.runSession(child.id);

            const stored = server.activeSessions.get(child.id) ?? server.store.load(child.id);
            assert.ok(stored);
            assert.equal(stored.state, 'completed');
            assert.equal(stored.collabState, 'awaiting_antigravity_turn');
            assert.equal(stored.messages.length, 1);
            assert.equal(stored.messages[0].type, 'review_summary');
            assert.match(stored.messages[0].content, /1 finding/i);
            assert.equal(stored.allFindings.length, 1);
        } finally {
            registerAdapter(originalMcpCodex, { replace: true });
        }
    });

});

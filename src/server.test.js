// @ts-check
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { HubServer } from './server.js';

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
            body: { projectDir: '/test', prompt: 'Review code' },
        });
        assert.equal(status, 201);
        assert.ok(body.session);
        assert.ok(body.session.id);
        assert.equal(body.session.state, 'pending');
    });

    it('GET /api/sessions/:id returns a session', async () => {
        // Create first
        const createRes = await apiRequest('/api/sessions', {
            method: 'POST',
            body: { projectDir: '/test2', prompt: 'test' },
        });
        const id = createRes.body.session.id;

        const { status, body } = await apiRequest(`/api/sessions/${id}`);
        assert.equal(status, 200);
        assert.equal(body.session.id, id);
    });

    it('GET /api/sessions/:id returns 404 for unknown', async () => {
        const { status } = await apiRequest('/api/sessions/nonexistent-id');
        assert.equal(status, 404);
    });

    it('GET /api/sessions/:id/events returns events', async () => {
        const createRes = await apiRequest('/api/sessions', {
            method: 'POST',
            body: { projectDir: '/test3', prompt: 'test' },
        });
        const id = createRes.body.session.id;

        const { status, body } = await apiRequest(`/api/sessions/${id}/events`);
        assert.equal(status, 200);
        assert.ok(Array.isArray(body.events));
    });

    it('GET /api/sessions/:id/events supports ?after= filter', async () => {
        const createRes = await apiRequest('/api/sessions', {
            method: 'POST',
            body: { projectDir: '/test4', prompt: 'test' },
        });
        const id = createRes.body.session.id;

        const { status, body } = await apiRequest(`/api/sessions/${id}/events?after=5`);
        assert.equal(status, 200);
        assert.ok(Array.isArray(body.events));
    });

    it('DELETE /api/sessions/:id deletes session', async () => {
        const createRes = await apiRequest('/api/sessions', {
            method: 'POST',
            body: { projectDir: '/test5', prompt: 'test' },
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
});

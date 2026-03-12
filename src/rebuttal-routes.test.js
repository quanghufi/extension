import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';

import { Session } from './hub/session.js';
import { createFinding } from './schema/events.js';
import { apiEvaluateFindings, apiRerunSession } from './rebuttal-routes.js';

function makeReq(body) {
    const req = new PassThrough();
    req.end(JSON.stringify(body));
    return req;
}

function makeRes() {
    const chunks = [];
    return {
        headers: {},
        statusCode: 200,
        setHeader(name, value) { this.headers[name] = value; },
        writeHead(status) { this.statusCode = status; },
        end(chunk = '') { chunks.push(Buffer.from(chunk)); },
        json() { return JSON.parse(Buffer.concat(chunks).toString('utf-8')); },
    };
}

function makeServer(session, runSessionImpl = async () => {}) {
    const saved = new Map([[session.id, session]]);
    return {
        activeSessions: new Map([[session.id, session]]),
        store: {
            save(value) { saved.set(value.id, value); },
            load(id) { return saved.get(id) ?? null; },
        },
        runSession: runSessionImpl,
    };
}

function completedSession() {
    const session = new Session({ projectDir: '/repo', prompt: 'Review changes', label: 'Round 1' });
    const finding = createFinding({
        severity: 'high',
        summary: 'Race condition on cache write',
        evidence: 'Concurrent update overwrites value',
        file: 'src/cache.js',
        line: 44,
    });
    session.finalize('completed', [finding]);
    return { session, finding };
}

test('apiEvaluateFindings rejects invalid verdicts', async () => {
    const { session, finding } = completedSession();
    const server = makeServer(session);
    const req = makeReq({ rebuttals: [{ findingId: finding.id, verdict: 'maybe' }] });
    const res = makeRes();

    await apiEvaluateFindings(server, session.id, req, res);

    assert.equal(res.statusCode, 400);
    assert.match(res.json().error, /Invalid rebuttal verdict/);
});

test('apiEvaluateFindings stores structured rebuttals and legacy evaluations', async () => {
    const { session, finding } = completedSession();
    const server = makeServer(session);
    const req = makeReq({
        rebuttals: [{
            dedupeKey: finding.dedupe_key,
            verdict: 'reject',
            reasonCode: 'stale_revision',
            rationale: 'Code changed after finding was produced.',
        }],
    });
    const res = makeRes();

    await apiEvaluateFindings(server, session.id, req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(session.rebuttals.length, 1);
    assert.equal(session.evaluations.length, 1);
    assert.equal(session.rebuttals[0].target.dedupeKey, finding.dedupe_key);
});

test('apiRerunSession blocks rerun before terminal state', async () => {
    const session = new Session({ projectDir: '/repo', prompt: 'Review changes' });
    const server = makeServer(session);
    const req = makeReq({ mode: 'appeal' });
    const res = makeRes();

    await apiRerunSession(server, session.id, req, res);

    assert.equal(res.statusCode, 409);
    assert.match(res.json().error, /terminal state/);
});

test('apiRerunSession appeal mode builds prompt and records withdrawn outcome', async () => {
    const { session, finding } = completedSession();
    const server = makeServer(session, async (childId) => {
        const child = server.activeSessions.get(childId);
        child.finalize('completed', []);
    });

    await apiEvaluateFindings(server, session.id, makeReq({
        rebuttals: [{
            findingId: finding.id,
            verdict: 'reject',
            reasonCode: 'insufficient_evidence',
            rationale: 'Need proof from production path.',
        }],
    }), makeRes());

    const res = makeRes();
    await apiRerunSession(server, session.id, makeReq({ mode: 'appeal' }), res);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const body = res.json();
    const child = server.activeSessions.get(body.childSessionId);
    assert.equal(res.statusCode, 201);
    assert.equal(child.retryMode, 'appeal');
    assert.match(child.prompt, /Structured rebuttal bundle from Antigravity/);
    assert.match(child.prompt, new RegExp(finding.dedupe_key));
    assert.equal(child.rebuttalOutcomes[0].outcome, 'withdrawn');
});

test('apiRerunSession reverify mode can override snapshot without appeal text', async () => {
    const { session } = completedSession();
    const server = makeServer(session, async (childId) => {
        const child = server.activeSessions.get(childId);
        child.finalize('completed', []);
    });
    const res = makeRes();

    await apiRerunSession(server, session.id, makeReq({
        mode: 'reverify',
        snapshotPath: '/snapshots/fixed',
        context: 'Verify the updated patch only.',
    }), res);

    const child = server.activeSessions.get(res.json().childSessionId);
    assert.equal(child.retryMode, 'reverify');
    assert.equal(child.snapshotPath, '/snapshots/fixed');
    assert.doesNotMatch(child.prompt, /Structured rebuttal bundle from Antigravity/);
});

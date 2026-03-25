// @ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { HubServer } from './server.js';
import { Session } from './hub/session.js';
import { getAdapter, registerAdapter } from './adapters/adapter-registry.js';

describe('HubServer debate orchestration', () => {
    it('runDebate can seed a single-round debate from existing Codex findings', async () => {
        const server = new HubServer({
            port: 0,
            dataDir: `./tmp/test-debate-seeded-${Date.now()}`,
            snapshotDir: `./tmp/test-debate-seeded-snap-${Date.now()}`,
        });

        const originalCodex = getAdapter('codex');
        const originalClaude = getAdapter('claude-code');
        const prompts = new Map();

        const seedFinding = {
            id: `F-SEEDED-${Date.now()}`,
            severity: 'high',
            summary: 'Unbounded request body read',
            evidence: 'No size limit on incoming request body',
            file: 'src/http-utils.js',
            line: 42,
            confidence: 0.92,
            dedupe_key: 'seeded-unbounded-read',
            fix_instructions: 'Add bounds checks before reading the request body.',
            why_it_matters: 'Unbounded reads can exhaust memory under load.',
        };

        const makeAdapter = (agentId, findings) => ({
            agentId,
            buildCommand: () => ({ cmd: 'fake', args: [] }),
            parseChunk: async function* () { },
            parseResult: () => [],
            execute: (_sessionId, _projectDir, prompt) => {
                prompts.set(agentId, String(prompt));
                return {
                    stream: (async function* () { })(),
                    done: Promise.resolve({
                        status: 'ok',
                        findings,
                        timingMs: { firstByteMs: 0, lastIdleGapMs: 0, totalMs: 0 },
                    }),
                };
            },
        });

        registerAdapter(makeAdapter('codex', [{
            ...seedFinding,
            rationale: 'Codex still reproduces the issue in the reviewed scope.',
        }]), { replace: true });
        registerAdapter(makeAdapter('claude-code', []), { replace: true });

        try {
            const session = new Session({
                projectDir: '/debate-project',
                prompt: 'Review only src/http-utils.js',
                agentId: 'codex',
                reviewOptions: {
                    review_target: 'file',
                    file_path: 'src/http-utils.js',
                    max_findings: 10,
                },
            });
            session.start();
            session.finalize('completed', [seedFinding]);
            server.store.save(session);

            const result = await server.runDebate(session.id, {
                agents: ['codex', 'claude-code'],
                maxRounds: 1,
                decider: 'codex',
                seedFindings: [seedFinding],
            });

            const stored = server.store.load(session.id);
            assert.ok(stored);
            // Judge mode: Codex does NOT run review (auto-accepts), only Claude runs as judge
            assert.equal(prompts.has('codex'), false, 'Codex should NOT receive a review prompt in judge mode');
            assert.match(prompts.get('claude-code') ?? '', /Findings to judge \(from initial automated review\)/i);
            assert.match(prompts.get('claude-code') ?? '', /independent code review JUDGE/i);
            assert.doesNotMatch(prompts.get('claude-code') ?? '', /Codex/i, 'Judge prompt must be agent-blind — no agent names');
            assert.match(prompts.get('claude-code') ?? '', /bias guardrails/i, 'Judge prompt must include bias guardrails');
            assert.doesNotMatch(prompts.get('claude-code') ?? '', /Review the requested code scope directly\./i);
            assert.equal(stored.debateState, 'resolved');
            assert.equal(stored.debateRound, 1);
            // Claude rejected the finding → allFindings should be empty (only confirmed survive)
            assert.equal(stored.allFindings.length, 0, 'Rejected findings must NOT appear in allFindings');
            assert.equal(stored.mergedFindings.length, 0, 'Rejected findings must NOT appear in mergedFindings');
            assert.equal(result.finalFindings.length, 0, 'finalFindings should only contain confirmed findings');
            // Judge verdicts should still contain the rejection with rationale
            assert.ok(Array.isArray(stored.judgeVerdicts), 'judgeVerdicts should be an array');
            assert.equal(stored.judgeVerdicts.length, 1);
            assert.equal(stored.judgeVerdicts[0].dedupeKey, 'seeded-unbounded-read');
            assert.equal(stored.judgeVerdicts[0].verdict, 'rejected');
            assert.ok(stored.judgeVerdicts[0].rationale.length > 0, 'Rejected verdict must include rationale');
            assert.equal(stored.judgeVerdicts[0].judgeAgent, 'claude-code');
        } finally {
            registerAdapter(originalCodex, { replace: true });
            registerAdapter(originalClaude, { replace: true });
        }
    });

    it('runDebate resolves disputed findings after a rebuttal round', async () => {
        const server = new HubServer({
            port: 0,
            dataDir: `./tmp/test-debate-${Date.now()}`,
            snapshotDir: `./tmp/test-debate-snap-${Date.now()}`,
        });

        const originalCodex = getAdapter('codex');
        const originalClaude = getAdapter('claude-code');

        registerAdapter({
            agentId: 'codex',
            buildCommand: () => ({ cmd: 'fake', args: [] }),
            parseChunk: async function* () { },
            parseResult: () => [],
            execute: () => ({
                stream: (async function* () { })(),
                done: Promise.resolve({
                    status: 'ok',
                    findings: [{
                        id: `F-CODEX-${Date.now()}`,
                        severity: 'high',
                        summary: 'Shared debate finding',
                        evidence: 'codex evidence',
                        file: 'src/debate.js',
                        line: 12,
                        confidence: 0.9,
                        dedupe_key: 'debate-shared-finding',
                        fix_instructions: 'Add abort/error handling before awaiting the request body.',
                        why_it_matters: 'Requests can hang forever during debate runs.',
                    }],
                    timingMs: { firstByteMs: 0, lastIdleGapMs: 0, totalMs: 0 },
                }),
            }),
        }, { replace: true });

        registerAdapter({
            agentId: 'claude-code',
            buildCommand: () => ({ cmd: 'fake', args: [] }),
            parseChunk: async function* () { },
            parseResult: () => [],
            execute: (_sessionId, _projectDir, prompt) => {
                const rebuttalRound = String(prompt).includes('Debate round 1');
                return {
                    stream: (async function* () { })(),
                    done: Promise.resolve({
                        status: 'ok',
                        findings: rebuttalRound ? [{
                            id: `F-CLAUDE-${Date.now()}`,
                            severity: 'high',
                            summary: 'Shared debate finding',
                            evidence: 'claude evidence',
                            file: 'src/debate.js',
                            line: 12,
                            confidence: 0.85,
                            dedupe_key: 'debate-shared-finding',
                            fix_instructions: null,
                            why_it_matters: null,
                        }] : [],
                        timingMs: { firstByteMs: 0, lastIdleGapMs: 0, totalMs: 0 },
                    }),
                };
            },
        }, { replace: true });

        try {
            const session = new Session({
                projectDir: '/debate-project',
                prompt: 'Review this project',
                agentId: 'codex',
            });
            session.start();
            session.finalize('completed', []);
            server.store.save(session);

            const result = await server.runDebate(session.id, {
                agents: ['codex', 'claude-code'],
                maxRounds: 2,
                decider: 'codex',
                consensusThreshold: 1.0,
            });

            const stored = server.store.load(session.id);
            assert.ok(stored);
            assert.equal(stored.debateState, 'resolved');
            assert.equal(stored.debateActive, false);
            assert.equal(stored.debateRound, 1);
            assert.equal(stored.groupedFindings.length, 1);
            assert.equal(stored.allFindings.length, 2);
            assert.equal(stored.mergedFindings.length, 1);
            assert.equal(stored.mergedFindings[0].fix_instructions, 'Add abort/error handling before awaiting the request body.');
            assert.equal(stored.mergedFindings[0].why_it_matters, 'Requests can hang forever during debate runs.');
            assert.equal(result.logicalFindings.length, 1);
            assert.ok(stored.events.some((event) => event.event_type === 'debate_started'));
            assert.ok(stored.events.some((event) => event.event_type === 'debate_resolved'));
        } finally {
            registerAdapter(originalCodex, { replace: true });
            registerAdapter(originalClaude, { replace: true });
        }
    });

    it('keeps singly-supported disputed findings for broad reviews in soft-union mode', async () => {
        const server = new HubServer({
            port: 0,
            dataDir: `./tmp/test-debate-union-${Date.now()}`,
            snapshotDir: `./tmp/test-debate-union-snap-${Date.now()}`,
        });

        const originalCodex = getAdapter('codex');
        const originalClaude = getAdapter('claude-code');

        registerAdapter({
            agentId: 'codex',
            buildCommand: () => ({ cmd: 'fake', args: [] }),
            parseChunk: async function* () { },
            parseResult: () => [],
            execute: (_sessionId, _projectDir, prompt) => {
                const rebuttalRound = String(prompt).includes('Debate round 1');
                return {
                    stream: (async function* () { })(),
                    done: Promise.resolve({
                        status: 'ok',
                        findings: rebuttalRound ? [] : [{
                            id: `F-CODEX-${Date.now()}`,
                            severity: 'high',
                            summary: 'Codex-only initial finding',
                            evidence: 'codex evidence',
                            file: 'src/a.js',
                            line: 10,
                            confidence: 0.9,
                            dedupe_key: 'codex-finding',
                            fix_instructions: 'fix codex',
                            why_it_matters: 'matters codex',
                        }],
                        timingMs: { firstByteMs: 0, lastIdleGapMs: 0, totalMs: 0 },
                    }),
                };
            },
        }, { replace: true });

        registerAdapter({
            agentId: 'claude-code',
            buildCommand: () => ({ cmd: 'fake', args: [] }),
            parseChunk: async function* () { },
            parseResult: () => [],
            execute: (_sessionId, _projectDir, prompt) => {
                const rebuttalRound = String(prompt).includes('Debate round 1');
                return {
                    stream: (async function* () { })(),
                    done: Promise.resolve({
                        status: 'ok',
                        findings: rebuttalRound ? [{
                            id: `F-CLAUDE-${Date.now()}`,
                            severity: 'high',
                            summary: 'Claude-only disputed finding survives',
                            evidence: 'claude evidence',
                            file: 'src/b.js',
                            line: 20,
                            confidence: 0.85,
                            dedupe_key: 'claude-finding',
                            fix_instructions: 'fix claude',
                            why_it_matters: 'matters claude',
                        }] : [{
                            id: `F-CLAUDE-INIT-${Date.now()}`,
                            severity: 'high',
                            summary: 'Claude-only initial finding',
                            evidence: 'claude init evidence',
                            file: 'src/b.js',
                            line: 20,
                            confidence: 0.85,
                            dedupe_key: 'claude-finding',
                            fix_instructions: 'fix claude',
                            why_it_matters: 'matters claude',
                        }],
                        timingMs: { firstByteMs: 0, lastIdleGapMs: 0, totalMs: 0 },
                    }),
                };
            },
        }, { replace: true });

        try {
            const session = new Session({
                projectDir: '/debate-project',
                prompt: 'Review the whole project for bugs',
                agentId: 'codex',
                reviewOptions: {
                    review_target: 'uncommitted',
                    max_findings: 10,
                },
            });
            session.start();
            session.finalize('completed', []);
            server.store.save(session);

            const result = await server.runDebate(session.id, {
                agents: ['codex', 'claude-code'],
                maxRounds: 1,
                decider: 'codex',
                consensusThreshold: 1.0,
            });

            const stored = server.store.load(session.id);
            assert.ok(stored);
            assert.equal(stored.debateState, 'resolved');
            assert.ok(result.logicalFindings.some((finding) => finding.dedupeKey === 'claude-finding'));
            assert.ok(stored.mergedFindings.some((finding) => finding.dedupe_key === 'claude-finding'));
        } finally {
            registerAdapter(originalCodex, { replace: true });
            registerAdapter(originalClaude, { replace: true });
        }
    });

    it('persists debate startup state before the background run finishes', async () => {
        const server = new HubServer({
            port: 0,
            dataDir: `./tmp/test-debate-startup-${Date.now()}`,
            snapshotDir: `./tmp/test-debate-startup-snap-${Date.now()}`,
        });

        const originalCodex = getAdapter('codex');
        const originalClaude = getAdapter('claude-code');

        let releaseReviews;
        const reviewGate = new Promise((resolve) => {
            releaseReviews = resolve;
        });

        const sharedFinding = (id) => ({
            id,
            severity: 'medium',
            summary: 'Persist debate startup state',
            evidence: 'shared evidence',
            file: 'src/http-utils.js',
            line: 42,
            confidence: 0.8,
            dedupe_key: 'persist-startup-state',
            fix_instructions: 'Persist debate state before async work continues.',
            why_it_matters: 'MCP pollers can fall back to stale disk state otherwise.',
        });

        const blockedAdapter = (agentId) => ({
            agentId,
            buildCommand: () => ({ cmd: 'fake', args: [] }),
            parseChunk: async function* () { },
            parseResult: () => [],
            execute: () => ({
                stream: (async function* () { })(),
                done: (async () => {
                    await reviewGate;
                    return {
                        status: 'ok',
                        findings: [sharedFinding(`F-${agentId}-${Date.now()}`)],
                        timingMs: { firstByteMs: 0, lastIdleGapMs: 0, totalMs: 0 },
                    };
                })(),
            }),
        });

        registerAdapter(blockedAdapter('codex'), { replace: true });
        registerAdapter(blockedAdapter('claude-code'), { replace: true });

        try {
            const session = new Session({
                projectDir: '/debate-project',
                prompt: 'Review only src/http-utils.js',
                agentId: 'codex',
            });
            session.start();
            session.finalize('completed', []);
            server.store.save(session);

            const debatePromise = server.runDebate(session.id, {
                agents: ['codex', 'claude-code'],
                maxRounds: 1,
                decider: 'codex',
                consensusThreshold: 1.0,
            });

            await new Promise((resolve) => setTimeout(resolve, 25));

            // Verify state was persisted to disk during startup.
            // Note: store.load() applies ghost debate recovery (debateActive
            // is cleared on cold load because no background executor owns it).
            // The in-memory session (via activeSessions) is the live reference.
            const activeDuringStartup = server.activeSessions.get(session.id);
            assert.ok(activeDuringStartup);
            assert.equal(activeDuringStartup.debateActive, true);
            assert.equal(activeDuringStartup.debateState, 'reviewing');
            assert.ok(activeDuringStartup.events.some((event) => event.event_type === 'debate_started'));

            // Cold load from disk triggers ghost recovery — this is expected.
            const coldLoadDuringStartup = server.store.load(session.id);
            assert.ok(coldLoadDuringStartup);
            assert.equal(coldLoadDuringStartup.debateActive, false,
                'Ghost recovery clears debateActive on cold load');
            assert.equal(coldLoadDuringStartup.debateState, 'failed',
                'Ghost recovery transitions non-terminal debateState to failed');

            server.activeSessions.delete(session.id);

            // After removing from activeSessions, cold load still recovers.
            const persistedAfterActiveDrop = server.store.load(session.id);
            assert.ok(persistedAfterActiveDrop);
            assert.equal(persistedAfterActiveDrop.debateActive, false);
            assert.equal(persistedAfterActiveDrop.debateState, 'failed');

            releaseReviews();
            const result = await debatePromise;
            assert.equal(result.logicalFindings.length, 1);
        } finally {
            registerAdapter(originalCodex, { replace: true });
            registerAdapter(originalClaude, { replace: true });
        }
    });
});

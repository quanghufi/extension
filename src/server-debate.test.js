// @ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { HubServer } from './server.js';
import { Session } from './hub/session.js';
import { getAdapter, registerAdapter } from './adapters/adapter-registry.js';

describe('HubServer debate orchestration', () => {
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
                        fix_instructions: null,
                        why_it_matters: null,
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
            assert.equal(result.logicalFindings.length, 1);
            assert.ok(stored.events.some((event) => event.event_type === 'debate_started'));
            assert.ok(stored.events.some((event) => event.event_type === 'debate_resolved'));
        } finally {
            registerAdapter(originalCodex, { replace: true });
            registerAdapter(originalClaude, { replace: true });
        }
    });
});

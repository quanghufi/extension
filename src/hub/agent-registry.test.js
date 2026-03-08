// @ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AgentRegistry, InvalidTransitionError, TRANSITIONS } from './agent-registry.js';

describe('AgentRegistry', () => {
    it('register() creates agent with state "pending"', () => {
        const reg = new AgentRegistry();
        reg.register('codex');
        const agent = reg.get('codex');
        assert.equal(agent?.state, 'pending');
        assert.equal(agent?.startedAt, null);
        assert.equal(agent?.findingCount, 0);
    });

    it('register() is no-op for already registered agent', () => {
        const reg = new AgentRegistry();
        reg.register('codex');
        reg.transition('codex', 'running', { startedAt: '2026-01-01T00:00:00Z' });
        reg.register('codex'); // should not reset
        assert.equal(reg.get('codex')?.state, 'running');
    });

    it('valid transition: pending → running → completed', () => {
        const reg = new AgentRegistry();
        reg.register('codex');
        reg.transition('codex', 'running', { startedAt: '2026-01-01T00:00:00Z' });
        assert.equal(reg.get('codex')?.state, 'running');
        reg.transition('codex', 'completed', { completedAt: '2026-01-01T00:01:00Z', status: 'ok', findingCount: 3 });
        assert.equal(reg.get('codex')?.state, 'completed');
        assert.equal(reg.get('codex')?.findingCount, 3);
    });

    it('valid transition: running → failed', () => {
        const reg = new AgentRegistry();
        reg.register('claude');
        reg.transition('claude', 'running');
        reg.transition('claude', 'failed', { status: 'timeout' });
        assert.equal(reg.get('claude')?.state, 'failed');
        assert.equal(reg.get('claude')?.status, 'timeout');
    });

    it('valid transition: failed → running (retry)', () => {
        const reg = new AgentRegistry();
        reg.register('codex');
        reg.transition('codex', 'running');
        reg.transition('codex', 'failed');
        // Retry — failed agent can re-enter running
        reg.transition('codex', 'running', { startedAt: '2026-01-01T00:05:00Z' });
        assert.equal(reg.get('codex')?.state, 'running');
    });

    it('invalid transition: pending → completed throws InvalidTransitionError', () => {
        const reg = new AgentRegistry();
        reg.register('codex');
        assert.throws(
            () => reg.transition('codex', 'completed'),
            (err) => {
                assert.ok(err instanceof InvalidTransitionError);
                assert.equal(err.agentId, 'codex');
                assert.equal(err.from, 'pending');
                assert.equal(err.to, 'completed');
                return true;
            },
        );
    });

    it('invalid transition: completed → running throws InvalidTransitionError', () => {
        const reg = new AgentRegistry();
        reg.register('codex');
        reg.transition('codex', 'running');
        reg.transition('codex', 'completed');
        assert.throws(
            () => reg.transition('codex', 'running'),
            InvalidTransitionError,
        );
    });

    it('transition() on unregistered agent throws', () => {
        const reg = new AgentRegistry();
        assert.throws(
            () => reg.transition('ghost', 'running'),
            /Agent not registered/,
        );
    });

    it('allInState() filters correctly', () => {
        const reg = new AgentRegistry();
        reg.register('codex');
        reg.register('claude');
        reg.register('gemini');
        reg.transition('codex', 'running');
        reg.transition('claude', 'running');
        // gemini stays pending
        const running = reg.allInState('running');
        assert.equal(running.length, 2);
        assert.deepEqual(running.map(a => a.agentId).sort(), ['claude', 'codex']);
        assert.equal(reg.allInState('pending').length, 1);
    });

    it('toJSON() / fromJSON() roundtrip preserves states', () => {
        const reg = new AgentRegistry();
        reg.register('codex');
        reg.transition('codex', 'running', { startedAt: '2026-01-01T00:00:00Z' });
        reg.register('claude');

        const json = reg.toJSON();
        const restored = AgentRegistry.fromJSON(json);

        assert.equal(restored.get('codex')?.state, 'running');
        assert.equal(restored.get('codex')?.startedAt, '2026-01-01T00:00:00Z');
        assert.equal(restored.get('claude')?.state, 'pending');
        assert.ok(restored.has('codex'));
        assert.ok(!restored.has('ghost'));
    });
});

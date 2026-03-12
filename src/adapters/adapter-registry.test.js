// @ts-check
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
    registerAdapter,
    getAdapter,
    hasAdapter,
    listAdapters,
    unregisterAdapter,
    resetRegistry,
    ESLINT_PRESET,
    SEMGREP_PRESET,
} from './adapter-registry.js';

// Reset between tests to avoid cross-test contamination
beforeEach(() => {
    resetRegistry();
});

// ── Built-in Adapters ────────────────────────────────

describe('Built-in adapters', () => {
    it('pre-registers codex adapter', () => {
        assert.ok(hasAdapter('codex'));
        const adapter = getAdapter('codex');
        assert.equal(adapter.agentId, 'codex');
    });

    it('lists built-in adapters', () => {
        const ids = listAdapters();
        assert.ok(ids.includes('codex'));
    });
});

// ── Registration ─────────────────────────────────────

describe('registerAdapter', () => {
    it('registers a config-based adapter', () => {
        registerAdapter({
            agentId: 'custom-lint',
            buildCommand: (path) => ({ cmd: 'lint', args: [path] }),
        });
        assert.ok(hasAdapter('custom-lint'));
        const adapter = getAdapter('custom-lint');
        assert.equal(adapter.agentId, 'custom-lint');
    });

    it('registers an adapter instance directly', () => {
        // Create a minimal adapter-like object
        const fakeAdapter = /** @type {any} */ ({
            agentId: 'fake',
            buildCommand: () => ({ cmd: 'fake', args: [] }),
            parseChunk: () => [],
            parseResult: () => [],
            timeouts: { firstByteMs: 1000, idleMs: 500, hardMs: 5000 },
        });
        registerAdapter(fakeAdapter);
        assert.ok(hasAdapter('fake'));
    });

    it('throws on duplicate registration', () => {
        registerAdapter({
            agentId: 'dup',
            buildCommand: () => ({ cmd: 'dup', args: [] }),
        });
        assert.throws(
            () => registerAdapter({
                agentId: 'dup',
                buildCommand: () => ({ cmd: 'dup', args: [] }),
            }),
            /already registered/
        );
    });

    it('allows replacing with replace option', () => {
        registerAdapter({
            agentId: 'replaceable',
            buildCommand: () => ({ cmd: 'v1', args: [] }),
        });
        registerAdapter({
            agentId: 'replaceable',
            buildCommand: () => ({ cmd: 'v2', args: [] }),
        }, { replace: true });

        const adapter = getAdapter('replaceable');
        const { cmd } = adapter.buildCommand('', '');
        assert.equal(cmd, 'v2');
    });

    it('rejects overwriting built-in without replace flag', () => {
        assert.throws(
            () => registerAdapter({
                agentId: 'codex',
                buildCommand: () => ({ cmd: 'fake', args: [] }),
            }),
            /already registered/
        );
    });
});

// ── Retrieval ────────────────────────────────────────

describe('getAdapter', () => {
    it('throws for unknown agentId', () => {
        assert.throws(
            () => getAdapter('nonexistent'),
            /No adapter registered.*nonexistent/
        );
    });

    it('includes available adapters in error message', () => {
        try {
            getAdapter('missing');
            assert.fail('Should have thrown');
        } catch (err) {
            assert.ok(err.message.includes('codex'));
        }
    });
});

// ── Unregister ───────────────────────────────────────

describe('unregisterAdapter', () => {
    it('removes a registered adapter', () => {
        registerAdapter({
            agentId: 'temp',
            buildCommand: () => ({ cmd: 'temp', args: [] }),
        });
        assert.ok(hasAdapter('temp'));
        const removed = unregisterAdapter('temp');
        assert.equal(removed, true);
        assert.ok(!hasAdapter('temp'));
    });

    it('returns false for non-existent adapter', () => {
        const removed = unregisterAdapter('ghost');
        assert.equal(removed, false);
    });
});

// ── Reset ────────────────────────────────────────────

describe('resetRegistry', () => {
    it('clears custom adapters and re-registers built-ins', () => {
        registerAdapter({
            agentId: 'custom',
            buildCommand: () => ({ cmd: 'c', args: [] }),
        });
        assert.ok(hasAdapter('custom'));

        resetRegistry();

        assert.ok(!hasAdapter('custom'));
        assert.ok(hasAdapter('codex'));
        assert.ok(hasAdapter('mcp-codex'));
    });
});

// ── Presets ──────────────────────────────────────────

describe('Presets', () => {
    it('ESLINT_PRESET has correct agentId', () => {
        assert.equal(ESLINT_PRESET.agentId, 'eslint');
    });

    it('ESLINT_PRESET builds npx eslint command', () => {
        const { cmd, args } = ESLINT_PRESET.buildCommand('/src', '');
        assert.equal(cmd, 'npx');
        assert.ok(args.includes('eslint'));
        assert.ok(args.includes('--format'));
        assert.ok(args.includes('json'));
        assert.ok(args.includes('/src'));
    });

    it('ESLINT_PRESET severity mapper handles ESLint levels', () => {
        assert.equal(ESLINT_PRESET.mapSeverity?.('2'), 'high');
        assert.equal(ESLINT_PRESET.mapSeverity?.('error'), 'high');
        assert.equal(ESLINT_PRESET.mapSeverity?.('1'), 'medium');
        assert.equal(ESLINT_PRESET.mapSeverity?.('warning'), 'medium');
    });

    it('SEMGREP_PRESET has correct agentId', () => {
        assert.equal(SEMGREP_PRESET.agentId, 'semgrep');
    });

    it('SEMGREP_PRESET builds semgrep --json command', () => {
        const { cmd, args } = SEMGREP_PRESET.buildCommand('/src', '');
        assert.equal(cmd, 'semgrep');
        assert.ok(args.includes('--json'));
        assert.ok(args.includes('/src'));
    });

    it('presets can be registered', () => {
        registerAdapter(ESLINT_PRESET);
        registerAdapter(SEMGREP_PRESET);
        assert.ok(hasAdapter('eslint'));
        assert.ok(hasAdapter('semgrep'));
    });
});

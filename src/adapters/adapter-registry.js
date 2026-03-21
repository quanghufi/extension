// @ts-check
/**
 * Adapter Registry
 *
 * Central registry for reviewer adapters:
 * - Pre-registers Codex adapter
 * - Allows registering new agents via config objects (GenericAdapter)
 * - Provides retrieval by agentId
 * - Thread-safe singleton pattern
 *
 * Usage:
 *   import { getAdapter, registerAdapter } from './adapter-registry.js';
 *   const codex = getAdapter('codex');
 *   registerAdapter({ agentId: 'semgrep', buildCommand: ... });
 *   const semgrep = getAdapter('semgrep');
 *
 * @module adapters/adapter-registry
 */

import { CodexAdapter } from './codex-adapter.js';
import { ClaudeCodeAdapter } from './claude-code-adapter.js';
import { GenericAdapter, defaultSeverityMapper } from './generic-adapter.js';
import { McpCodexAdapter } from './mcp-adapter.js';

// ── Type Definitions ─────────────────────────────────

/**
 * @typedef {import('./base-adapter.js').BaseAdapter} BaseAdapter
 * @typedef {import('./generic-adapter.js').GenericAdapterConfig} GenericAdapterConfig
 */

// ── Registry ─────────────────────────────────────────

/** @type {Map<string, BaseAdapter>} */
const registry = new Map();

const SHARED_REVIEW_TIMEOUTS = Object.freeze({
    firstByteMs: 90_000,
    idleMs: 120_000,
    hardMs: 360_000,
});

/**
 * Register a built-in adapter instance directly.
 * @param {BaseAdapter} adapter
 * @throws {Error} if agentId already registered
 */
function registerBuiltin(adapter) {
    const id = adapter.agentId;
    if (registry.has(id)) {
        throw new Error(`Adapter "${id}" is already registered`);
    }
    registry.set(id, adapter);
}

// ── Pre-register built-in adapters ───────────────────

// LLM agents need longer idle+hard timeouts than CLI tools — they "think" silently
registerBuiltin(new CodexAdapter(SHARED_REVIEW_TIMEOUTS));
registerBuiltin(new ClaudeCodeAdapter(SHARED_REVIEW_TIMEOUTS));
registerBuiltin(new McpCodexAdapter());

// ── Public API ───────────────────────────────────────

/**
 * Register a new adapter by config (creates GenericAdapter) or instance.
 *
 * @param {GenericAdapterConfig | BaseAdapter} configOrAdapter
 *   - If GenericAdapterConfig: wraps in GenericAdapter
 *   - If BaseAdapter instance: registers directly
 * @param {object} [options]
 * @param {boolean} [options.replace=false] - Allow replacing existing adapter
 * @throws {Error} if agentId already registered (unless replace=true)
 */
export function registerAdapter(configOrAdapter, options = {}) {
    const { replace = false } = options;

    /** @type {BaseAdapter} */
    let adapter;

    // Duck-type check: if it has buildCommand as a method on the prototype chain,
    // it's already an adapter instance; otherwise it's a config object
    if (typeof configOrAdapter.buildCommand === 'function'
        && typeof configOrAdapter.parseChunk === 'function'
        && typeof configOrAdapter.parseResult === 'function'
        && 'agentId' in configOrAdapter) {
        adapter = /** @type {BaseAdapter} */ (configOrAdapter);
    } else {
        adapter = new GenericAdapter(/** @type {GenericAdapterConfig} */(configOrAdapter));
    }

    const id = adapter.agentId;

    if (registry.has(id) && !replace) {
        throw new Error(
            `Adapter "${id}" is already registered. Use { replace: true } to overwrite.`
        );
    }

    registry.set(id, adapter);
}

/**
 * Get a registered adapter by agentId.
 *
 * @param {string} agentId
 * @returns {BaseAdapter}
 * @throws {Error} if not found
 */
export function getAdapter(agentId) {
    const adapter = registry.get(agentId);
    if (!adapter) {
        const available = [...registry.keys()].join(', ');
        throw new Error(
            `No adapter registered for "${agentId}". Available: [${available}]`
        );
    }
    return adapter;
}

/**
 * Check if an adapter is registered.
 * @param {string} agentId
 * @returns {boolean}
 */
export function hasAdapter(agentId) {
    return registry.has(agentId);
}

/**
 * List all registered adapter IDs.
 * @returns {string[]}
 */
export function listAdapters() {
    return [...registry.keys()];
}

/**
 * Unregister an adapter. Mainly for testing.
 * @param {string} agentId
 * @returns {boolean} true if found and removed
 */
export function unregisterAdapter(agentId) {
    return registry.delete(agentId);
}

/**
 * Reset registry to built-in adapters only. For testing.
 */
export function resetRegistry() {
    registry.clear();
    registerBuiltin(new CodexAdapter(SHARED_REVIEW_TIMEOUTS));
    registerBuiltin(new ClaudeCodeAdapter(SHARED_REVIEW_TIMEOUTS));
    registerBuiltin(new McpCodexAdapter());
}

// ── Preset Configurations ────────────────────────────
// Ready-to-use configs for common CLI tools

/**
 * ESLint adapter preset.
 * Uses `eslint --format json` for structured output.
 * @type {GenericAdapterConfig}
 */
export const ESLINT_PRESET = {
    agentId: 'eslint',
    buildCommand: (snapshotPath, _prompt) => ({
        cmd: 'npx',
        args: ['eslint', '--format', 'json', snapshotPath],
    }),
    timeouts: {
        firstByteMs: 30_000,
        idleMs: 15_000,
        hardMs: 120_000,
    },
    mapSeverity: (raw) => {
        const n = raw.toLowerCase().trim();
        if (n === '2' || n === 'error') return 'high';
        if (n === '1' || n === 'warning') return 'medium';
        return 'low';
    },
};

/**
 * Semgrep adapter preset.
 * Uses `semgrep --json` for structured output.
 * @type {GenericAdapterConfig}
 */
export const SEMGREP_PRESET = {
    agentId: 'semgrep',
    buildCommand: (snapshotPath, _prompt) => ({
        cmd: 'semgrep',
        args: ['--json', '--config', 'auto', snapshotPath],
    }),
    timeouts: {
        firstByteMs: 45_000,
        idleMs: 20_000,
        hardMs: 300_000,
    },
    mapSeverity: defaultSeverityMapper,
};

export { defaultSeverityMapper };

// @ts-check
/**
 * Base Adapter — Abstract streaming adapter for CLI agent processes.
 *
 * Provides:
 * - `execute()` returning `{ stream: AsyncIterable<Event>, done: Promise<AdapterResult> }`
 * - 3-tier timeout (firstByte / idle / hard)
 * - UTF-8 garble detection (U+FFFD)
 *
 * Subclasses MUST override:
 * - `buildCommand(snapshotPath, prompt)` → { cmd, args }
 * - `parseChunk(chunk)` → Event[]
 * - `parseResult(allChunks)` → Finding[]
 *
 * @module adapters/base-adapter
 */

import { executeProcess } from './adapter-execution.js';

// ── Constants ────────────────────────────────────────

/** @type {Readonly<{firstByteMs: number, idleMs: number, hardMs: number}>} */
const DEFAULT_TIMEOUTS = Object.freeze({
    firstByteMs: 60_000,  // 60s to get first output (Claude MCP init can be slow)
    idleMs: 30_000,       // 30s of silence → assume stalled
    hardMs: 300_000,      // 5min hard cap per agent run
});

// ── Base Adapter ────────────────────────────────────

export class BaseAdapter {
    /**
     * @param {string} agentId - 'codex' | 'claude-code'
     * @param {object} [options]
     * @param {number} [options.firstByteMs]
     * @param {number} [options.idleMs]
     * @param {number} [options.hardMs]
     */
    constructor(agentId, options = {}) {
        if (new.target === BaseAdapter) {
            throw new Error('BaseAdapter is abstract — use CodexAdapter or ClaudeAdapter');
        }
        /** @type {string} */
        this.agentId = agentId;

        /** @type {Readonly<{firstByteMs: number, idleMs: number, hardMs: number}>} */
        this.timeouts = Object.freeze({
            firstByteMs: options.firstByteMs ?? DEFAULT_TIMEOUTS.firstByteMs,
            idleMs: options.idleMs ?? DEFAULT_TIMEOUTS.idleMs,
            hardMs: options.hardMs ?? DEFAULT_TIMEOUTS.hardMs,
        });
    }

    // ── Abstract methods (MUST override) ─────────────

    /**
     * Build the CLI command and arguments.
     * @param {string} _snapshotPath - Path to code snapshot
     * @param {string} _prompt - Review prompt
     * @returns {{ cmd: string, args: string[] }}
     */
    buildCommand(_snapshotPath, _prompt) {
        throw new Error('buildCommand() must be overridden by subclass');
    }

    /**
     * Parse a raw chunk of output into zero or more Events.
     * Return empty array if the chunk has no actionable content.
     * @param {string} _chunk - Raw output chunk
     * @param {string} _sessionId - Current session ID
     * @returns {import('../schema/events.js').Event[]}
     */
    parseChunk(_chunk, _sessionId) {
        throw new Error('parseChunk() must be overridden by subclass');
    }

    /**
     * Parse accumulated output into final Findings after process exits.
     * @param {string} _allOutput - All concatenated output
     * @param {string} _sessionId - Current session ID
     * @returns {import('../schema/events.js').Finding[]}
     */
    parseResult(_allOutput, _sessionId) {
        throw new Error('parseResult() must be overridden by subclass');
    }

    /**
     * Optional execution overrides for the child process.
     * Subclasses can provide env/cwd adjustments without reimplementing execute().
     *
     * @param {string} _snapshotPath - Path to code snapshot
     * @returns {{ env?: Record<string, string> }}
     */
    getExecutionOptions(_snapshotPath) {
        return {};
    }

    // ── Core Execute ─────────────────────────────────

    /**
     * Execute the agent CLI process and return a streaming interface.
     *
     * @param {string} sessionId - Session UUID
     * @param {string} snapshotPath - Absolute path to code snapshot
     * @param {string} prompt - Review prompt text
     * @returns {{ stream: AsyncIterable<import('../schema/events.js').Event>, done: Promise<import('../schema/events.js').AdapterResult> }}
     */
    execute(sessionId, snapshotPath, prompt) {
        const { cmd, args } = this.buildCommand(snapshotPath, prompt);
        const execution = this.getExecutionOptions(snapshotPath);

        return executeProcess({
            sessionId,
            snapshotPath,
            agentId: this.agentId,
            command: { cmd, args },
            env: execution.env,
            timeouts: this.timeouts,
            parseChunk: (chunk, sid) => this.parseChunk(chunk, sid),
            parseResult: (allOutput, sid) => this.parseResult(allOutput, sid),
        });
    }
}

// ── Utility Functions ────────────────────────────────

/**
 * Detect UTF-8 garbled output (replacement character U+FFFD).
 * @param {string} text
 * @returns {boolean}
 */
export function containsGarble(text) {
    return text.includes('\ufffd');
}

export { DEFAULT_TIMEOUTS };

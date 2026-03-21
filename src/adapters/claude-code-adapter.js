// @ts-check
/**
 * Claude Code CLI Adapter
 *
 * Uses `claude -p <prompt> --output-format stream-json --verbose`
 * to run Claude Code as a code reviewer.
 *
 * Output goes to stderr (same as Codex behavior).
 * Stream format: NDJSON lines {type:"system"|"assistant"|"result"}
 *
 * @module adapters/claude-code-adapter
 */

import { BaseAdapter } from './base-adapter.js';
import {
    buildReviewPrompt,
    parseStreamLine,
    parseClaudeResult,
    mapSeverity,
} from './claude-code-parsing.js';

// ── Constants ────────────────────────────────────────

/** Claude Code review takes 5-8 minutes (similar to Codex) — generous timeouts */
const CLAUDE_TIMEOUTS = Object.freeze({
    firstByteMs: 300_000,  // 5min — Claude reads & analyzes code before first output
    idleMs: 60_000,        // 60s — may pause between reasoning chunks
    hardMs: 600_000,       // 10min hard cap for full review
});

// ── Claude Code Adapter ─────────────────────────────

export class ClaudeCodeAdapter extends BaseAdapter {
    /**
     * @param {object} [options]
     * @param {number} [options.firstByteMs]
     * @param {number} [options.idleMs]
     * @param {number} [options.hardMs]
     */
    constructor(options = {}) {
        super('claude-code', {
            firstByteMs: options.firstByteMs ?? CLAUDE_TIMEOUTS.firstByteMs,
            idleMs: options.idleMs ?? CLAUDE_TIMEOUTS.idleMs,
            hardMs: options.hardMs ?? CLAUDE_TIMEOUTS.hardMs,
        });
    }

    /**
     * Build the Claude Code CLI command.
     *
     * @param {string} snapshotPath - Path to code snapshot
     * @param {string} prompt - Review prompt
     * @returns {{ cmd: string, args: string[] }}
     */
    buildCommand(snapshotPath, prompt) {
        const reviewPrompt = buildReviewPrompt(prompt);
        return {
            cmd: 'claude',
            args: [
                '-p', reviewPrompt,
                '--output-format', 'stream-json',
                '--verbose',
            ],
        };
    }

    /**
     * Parse a chunk of Claude Code stream-json output.
     *
     * @param {string} chunk - Raw output chunk (may contain multiple NDJSON lines)
     * @param {string} sessionId - Current session ID
     * @returns {import('../schema/events.js').Event[]}
     */
    parseChunk(chunk, sessionId) {
        const events = [];
        // Split chunk into individual NDJSON lines
        const lines = chunk.split('\n');
        for (const line of lines) {
            const lineEvents = parseStreamLine(line, sessionId, this.agentId);
            events.push(...lineEvents);
        }
        return events;
    }

    /**
     * Parse accumulated output into final Findings.
     *
     * @param {string} allOutput - All concatenated output
     * @param {string} sessionId - Current session ID
     * @returns {import('../schema/events.js').Finding[]}
     */
    parseResult(allOutput, sessionId) {
        return parseClaudeResult(allOutput, sessionId);
    }

    /**
     * Execution options — set cwd to snapshot path.
     *
     * @param {string} snapshotPath - Path to code snapshot
     * @returns {{ env?: Record<string, string> }}
     */
    getExecutionOptions(snapshotPath) {
        return {
            env: {
                // Claude Code CLI needs to operate within the snapshot directory
                // Note: cwd is handled by adapter-execution.js via snapshotPath
            },
        };
    }
}

export { mapSeverity, CLAUDE_TIMEOUTS };

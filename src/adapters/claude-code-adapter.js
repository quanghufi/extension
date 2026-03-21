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

/** Claude Code must match Codex review timeouts in debate runs. */
const CLAUDE_TIMEOUTS = Object.freeze({
    firstByteMs: 90_000,
    idleMs: 120_000,
    hardMs: 360_000,
});

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
     * @param {string} _snapshotPath
     * @param {string} prompt
     * @returns {{ cmd: string, args: string[], stdinText: string }}
     */
    buildCommand(_snapshotPath, prompt) {
        const reviewPrompt = buildReviewPrompt(prompt);
        return {
            cmd: 'claude',
            args: [
                '-p', '-',
                '--output-format', 'stream-json',
                '--verbose',
            ],
            stdinText: reviewPrompt,
        };
    }

    /**
     * Parse a chunk of Claude Code stream-json output.
     *
     * @param {string} chunk
     * @param {string} sessionId
     * @returns {import('../schema/events.js').Event[]}
     */
    parseChunk(chunk, sessionId) {
        const events = [];
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
     * @param {string} allOutput
     * @param {string} sessionId
     * @returns {import('../schema/events.js').Finding[]}
     */
    parseResult(allOutput, sessionId) {
        return parseClaudeResult(allOutput, sessionId);
    }

    /**
     * Execution options.
     *
     * @param {string} _snapshotPath
     * @returns {{ env?: Record<string, string> }}
     */
    getExecutionOptions(_snapshotPath) {
        return {
            env: {},
        };
    }
}

export { mapSeverity, CLAUDE_TIMEOUTS };

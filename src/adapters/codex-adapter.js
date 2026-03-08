// @ts-check
/**
 * Codex CLI Adapter
 *
 * Handles Codex CLI specifics:
 * - Output comes from STDERR (stdout = 0 bytes)
 * - Uses `codex review` with --output-format stream-json --verbose
 * - Parses JSON-line output from stderr
 *
 * @module adapters/codex-adapter
 */

import { BaseAdapter } from './base-adapter.js';
import { createEvent, createFinding } from '../schema/events.js';
import { normalizeFindingPath } from '../utils/paths.js';

export class CodexAdapter extends BaseAdapter {
    /**
     * @param {object} [options]
     * @param {number} [options.firstByteMs]
     * @param {number} [options.idleMs]
     * @param {number} [options.hardMs]
     */
    constructor(options = {}) {
        super('codex', options);
    }

    /**
     * Build Codex CLI command.
     * @param {string} snapshotPath
     * @param {string} prompt
     * @returns {{ cmd: string, args: string[] }}
     */
    buildCommand(snapshotPath, prompt) {
        return {
            cmd: 'codex',
            args: [
                'review',
                prompt,
            ],
        };
    }

    /**
     * Parse a chunk of Codex stderr output.
     * Codex in stream-json mode emits newline-delimited JSON objects.
     *
     * @param {string} chunk
     * @param {string} sessionId
     * @returns {import('../schema/events.js').Event[]}
     */
    parseChunk(chunk, sessionId) {
        return [createEvent(sessionId, this.agentId, 'status', { state: 'progress', text: chunk })];
    }

    /**
     * Parse all accumulated Codex output into findings.
     * @param {string} allOutput
     * @param {string} _sessionId
     * @returns {import('../schema/events.js').Finding[]}
     */
    parseResult(allOutput, _sessionId) {
        if (allOutput.trim().length === 0) {
            return [];
        }
        return [createFinding({
            severity: 'medium',
            summary: 'Codex Review',
            evidence: allOutput,
            file: 'unknown',
            line: null,
            confidence: 0.8,
        })];
    }
}

// ── Utility ──────────────────────────────────────────

/**
 * Map various severity strings to our canonical set.
 * @param {string} raw
 * @returns {'critical' | 'high' | 'medium' | 'low'}
 */
function mapSeverity(raw) {
    const normalized = (raw ?? '').toString().toLowerCase().trim();
    if (normalized === 'critical' || normalized === 'error' || normalized === 'fatal') return 'critical';
    if (normalized === 'high' || normalized === 'warning' || normalized === 'warn') return 'high';
    if (normalized === 'medium' || normalized === 'info' || normalized === 'note') return 'medium';
    if (normalized === 'low' || normalized === 'hint' || normalized === 'suggestion') return 'low';
    return 'medium'; // default
}

export { mapSeverity };

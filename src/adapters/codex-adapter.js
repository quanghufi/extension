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
                '--output-format', 'stream-json',
                '--verbose',
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
        /** @type {import('../schema/events.js').Event[]} */
        const events = [];
        const lines = chunk.split('\n').filter((l) => l.trim().length > 0);

        for (const line of lines) {
            try {
                const parsed = JSON.parse(line);

                // Codex emits various event types
                if (parsed.type === 'finding' || parsed.finding) {
                    const finding = parsed.finding ?? parsed;
                    events.push(createEvent(sessionId, this.agentId, 'finding', { raw: finding }));
                } else if (parsed.type === 'status' || parsed.status) {
                    events.push(createEvent(sessionId, this.agentId, 'status', parsed));
                } else if (parsed.type === 'error') {
                    events.push(createEvent(sessionId, this.agentId, 'error', parsed));
                }
                // Other JSON lines are silently discarded (heartbeats, progress, etc.)
            } catch {
                // Non-JSON lines are common (progress bars, status text)
                // Only emit if it looks like substantive content
                if (line.trim().length > 10 && !line.includes('█') && !line.includes('▓')) {
                    events.push(createEvent(sessionId, this.agentId, 'status', {
                        state: 'progress',
                        text: line.trim(),
                    }));
                }
            }
        }

        return events;
    }

    /**
     * Parse all accumulated Codex output into findings.
     * Processes newline-delimited JSON and extracts finding objects.
     *
     * @param {string} allOutput
     * @param {string} _sessionId
     * @returns {import('../schema/events.js').Finding[]}
     */
    parseResult(allOutput, _sessionId) {
        /** @type {import('../schema/events.js').Finding[]} */
        const findings = [];
        const lines = allOutput.split('\n').filter((l) => l.trim().length > 0);

        for (const line of lines) {
            try {
                const parsed = JSON.parse(line);
                const raw = parsed.finding ?? parsed;

                // Only process if it has finding-like fields
                if (raw.summary || raw.message || raw.description) {
                    findings.push(createFinding({
                        severity: mapSeverity(raw.severity ?? raw.level ?? 'medium'),
                        summary: raw.summary ?? raw.message ?? raw.description ?? 'Unknown issue',
                        evidence: raw.evidence ?? raw.details ?? raw.context ?? '',
                        file: raw.file ?? raw.path ?? 'unknown',
                        line: typeof raw.line === 'number' ? raw.line : null,
                        confidence: typeof raw.confidence === 'number'
                            ? Math.min(1, Math.max(0, raw.confidence))
                            : 0.5,
                    }));
                }
            } catch {
                // Non-JSON lines — skip
            }
        }

        return findings;
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

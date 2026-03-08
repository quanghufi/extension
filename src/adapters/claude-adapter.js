// @ts-check
/**
 * Claude Code CLI Adapter
 *
 * Handles Claude Code CLI specifics:
 * - Uses `--output-format json` (verified viable in spike v3)
 * - Falls back to text parsing if JSON mode fails
 * - Needs longer firstByte timeout (120s for MCP server init)
 * - Output comes from STDOUT
 *
 * @module adapters/claude-adapter
 */

import { BaseAdapter } from './base-adapter.js';
import { createEvent, createFinding } from '../schema/events.js';
import { normalizeFindingPath } from '../utils/paths.js';

/** Default Claude-specific timeout overrides */
const CLAUDE_DEFAULTS = {
    firstByteMs: 120_000, // 120s for MCP server initialization
    idleMs: 45_000,       // 45s — Claude can pause between analyses
    hardMs: 600_000,      // 10min — Claude reviews are thorough
};

export class ClaudeAdapter extends BaseAdapter {
    /**
     * @param {object} [options]
     * @param {number} [options.firstByteMs]
     * @param {number} [options.idleMs]
     * @param {number} [options.hardMs]
     */
    constructor(options = {}) {
        super('claude-code', {
            firstByteMs: options.firstByteMs ?? CLAUDE_DEFAULTS.firstByteMs,
            idleMs: options.idleMs ?? CLAUDE_DEFAULTS.idleMs,
            hardMs: options.hardMs ?? CLAUDE_DEFAULTS.hardMs,
        });
    }

    /**
     * Build Claude Code CLI command.
     * @param {string} snapshotPath
     * @param {string} prompt
     * @returns {{ cmd: string, args: string[] }}
     */
    buildCommand(snapshotPath, prompt) {
        return {
            cmd: 'claude',
            args: [
                '--output-format', 'json',
                '--print',
                prompt,
            ],
        };
    }

    /**
     * Parse a chunk of Claude output.
     * Claude in JSON mode outputs a single JSON object at the end,
     * but may emit progress text during processing.
     *
     * @param {string} chunk
     * @param {string} sessionId
     * @returns {import('../schema/events.js').Event[]}
     */
    parseChunk(chunk, sessionId) {
        /** @type {import('../schema/events.js').Event[]} */
        const events = [];
        const trimmed = chunk.trim();

        // Try to parse as JSON (Claude might emit complete JSON at once)
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
            try {
                const parsed = JSON.parse(trimmed);
                // If parsed successfully, it's likely the final result
                events.push(createEvent(sessionId, this.agentId, 'status', {
                    state: 'processing',
                    hasJson: true,
                }));
                return events;
            } catch {
                // Incomplete JSON — buffer and wait
            }
        }

        // Text output — emit as progress
        if (trimmed.length > 0) {
            events.push(createEvent(sessionId, this.agentId, 'status', {
                state: 'progress',
                text: trimmed.slice(0, 500), // Limit progress text size
            }));
        }

        return events;
    }

    /**
     * Parse accumulated Claude output into findings.
     * Tries JSON parse first, falls back to text extraction.
     *
     * @param {string} allOutput
     * @param {string} _sessionId
     * @returns {import('../schema/events.js').Finding[]}
     */
    parseResult(allOutput, _sessionId) {
        // Strategy 1: Parse as JSON
        const jsonFindings = this._tryParseJson(allOutput);
        if (jsonFindings !== null) return jsonFindings;

        // Strategy 2: Fall back to text extraction
        return this._parseTextOutput(allOutput);
    }

    /**
     * Attempt to parse output as JSON.
     * Claude with --output-format json may wrap the review in a result object.
     *
     * @param {string} output
     * @returns {import('../schema/events.js').Finding[] | null}
     */
    _tryParseJson(output) {
        // Find the last complete JSON object/array in the output
        const jsonMatch = output.match(/(\{[\s\S]*\}|\[[\s\S]*\])\s*$/);
        if (!jsonMatch) return null;

        try {
            const parsed = JSON.parse(jsonMatch[1]);

            // Handle different JSON formats Claude might produce
            if (Array.isArray(parsed)) {
                return this._extractFindingsFromArray(parsed);
            }

            // Single object with result/findings/issues field
            const items = parsed.result ?? parsed.findings ?? parsed.issues
                ?? parsed.review ?? parsed.output;

            if (Array.isArray(items)) {
                return this._extractFindingsFromArray(items);
            }

            // If `result` is a string, it's Claude's envelope — fall back to text parsing
            if (typeof items === 'string') {
                return null; // Signal caller to use _parseTextOutput()
            }

            // If it's a single finding-like object (must have both a summary AND a file reference)
            const hasSummary = parsed.summary || parsed.message || parsed.description;
            const hasFile = parsed.file || parsed.path || parsed.filename || parsed.location;
            if (hasSummary && hasFile) {
                return this._extractFindingsFromArray([parsed]);
            }

            // JSON was valid but didn't contain findings — return null to try text fallback
            return null;
        } catch {
            return null; // JSON parse failed
        }
    }

    /**
     * Extract findings from an array of raw finding-like objects.
     *
     * @param {Array<Record<string, unknown>>} items
     * @returns {import('../schema/events.js').Finding[]}
     */
    _extractFindingsFromArray(items) {
        /** @type {import('../schema/events.js').Finding[]} */
        const findings = [];

        for (const item of items) {
            if (!item || typeof item !== 'object') continue;

            // Extract summary — Claude uses various field names
            const summary = String(
                item.summary ?? item.message ?? item.description
                ?? item.title ?? item.issue ?? ''
            );
            if (!summary) continue;

            const rawFile = String(item.file ?? item.path ?? item.filename ?? item.location ?? 'unknown');
            let normalizedFile;
            try {
                normalizedFile = normalizeFindingPath(rawFile, process.cwd());
            } catch {
                normalizedFile = rawFile; // Traversal or other error — use raw
            }
            findings.push(createFinding({
                severity: mapClaudeSeverity(String(item.severity ?? item.level ?? item.priority ?? 'medium')),
                summary,
                evidence: String(item.evidence ?? item.details ?? item.explanation ?? item.context ?? ''),
                file: normalizedFile,
                line: typeof item.line === 'number' ? item.line
                    : typeof item.lineNumber === 'number' ? item.lineNumber
                        : typeof item.line_number === 'number' ? item.line_number
                            : null,
                confidence: typeof item.confidence === 'number'
                    ? Math.min(1, Math.max(0, item.confidence))
                    : 0.5,
            }));
        }

        return findings;
    }

    /**
     * Fallback: extract findings from plain text output.
     * Uses heuristic pattern matching for common review formats.
     *
     * @param {string} output
     * @returns {import('../schema/events.js').Finding[]}
     */
    _parseTextOutput(output) {
        /** @type {import('../schema/events.js').Finding[]} */
        const findings = [];

        // Pattern: "**file:line** - summary" or "file:line: summary"
        const fileLinePattern = /(?:\*\*)?([^\s*:]+\.\w+):(\d+)(?:\*\*)?[\s:—-]+(.+)/g;
        let match;

        while ((match = fileLinePattern.exec(output)) !== null) {
            const [, file, lineStr, summary] = match;
            let normalizedFile;
            try {
                normalizedFile = normalizeFindingPath(file, process.cwd());
            } catch {
                normalizedFile = file;
            }
            findings.push(createFinding({
                severity: 'medium',
                summary: summary.trim(),
                evidence: '',
                file: normalizedFile,
                line: parseInt(lineStr, 10),
                confidence: 0.3, // Lower confidence for text-extracted findings
            }));
        }

        // Pattern: numbered list with file references
        // "1. **Issue Title** in `file.js`: description"
        const numberedPattern = /\d+\.\s+\*\*(.+?)\*\*\s+(?:in\s+)?[`']([^\s`']+)[`'](?::(\d+))?\s*[:\-—]\s*(.+)/g;
        while ((match = numberedPattern.exec(output)) !== null) {
            const [, title, file, lineStr, description] = match;
            // Avoid duplicates from fileLinePattern
            const alreadyFound = findings.some((f) =>
                f.file === file && f.summary === title.trim()
            );
            if (!alreadyFound) {
                let normalizedFile2;
                try {
                    normalizedFile2 = normalizeFindingPath(file, process.cwd());
                } catch {
                    normalizedFile2 = file;
                }
                findings.push(createFinding({
                    severity: 'medium',
                    summary: title.trim(),
                    evidence: description.trim(),
                    file: normalizedFile2,
                    line: lineStr ? parseInt(lineStr, 10) : null,
                    confidence: 0.25,
                }));
            }
        }

        return findings;
    }
}

// ── Utility ──────────────────────────────────────────

/**
 * Map Claude severity strings to canonical set.
 * @param {string} raw
 * @returns {'critical' | 'high' | 'medium' | 'low'}
 */
function mapClaudeSeverity(raw) {
    const normalized = (raw ?? '').toString().toLowerCase().trim();
    if (['critical', 'blocker', 'severe', 'p0'].includes(normalized)) return 'critical';
    if (['high', 'major', 'important', 'p1'].includes(normalized)) return 'high';
    if (['medium', 'moderate', 'normal', 'p2'].includes(normalized)) return 'medium';
    if (['low', 'minor', 'trivial', 'nit', 'p3', 'p4'].includes(normalized)) return 'low';
    return 'medium';
}

export { mapClaudeSeverity, CLAUDE_DEFAULTS };

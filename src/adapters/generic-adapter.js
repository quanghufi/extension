// @ts-check
/**
 * Generic CLI Adapter
 *
 * Config-driven adapter that handles ANY CLI reviewer agent.
 * Eliminates the need for per-agent adapter classes by using a
 * configuration object to describe agent-specific behavior.
 *
 * Configuration includes:
 * - CLI command construction
 * - Timeout tuning
 * - Output source (stdout vs stderr)
 * - Chunk/result parsing via pluggable strategies
 *
 * @module adapters/generic-adapter
 */

import { BaseAdapter } from './base-adapter.js';
import { createEvent, createFinding } from '../schema/events.js';
import { normalizeFindingPath } from '../utils/paths.js';

// ── Defaults ─────────────────────────────────────────

/** @type {Readonly<import('./base-adapter.js').TimeoutConfig>} */
const GENERIC_TIMEOUT_DEFAULTS = Object.freeze({
    firstByteMs: 60_000,  // 60s
    idleMs: 30_000,       // 30s
    hardMs: 300_000,      // 5min
});

// ── Type Definitions ─────────────────────────────────

/**
 * @typedef {'critical' | 'high' | 'medium' | 'low'} Severity
 */

/**
 * @typedef {Object} GenericAdapterConfig
 * @property {string} agentId - Unique agent identifier (e.g. 'semgrep', 'eslint')
 * @property {CommandBuilder} buildCommand - Builds the CLI command to execute
 * @property {Partial<import('./base-adapter.js').TimeoutConfig>} [timeouts] - Override defaults
 * @property {SeverityMapper} [mapSeverity] - Maps raw severity to canonical set
 * @property {OutputParser} [parseOutput] - Custom full-output parser
 * @property {ChunkParser} [parseChunk] - Custom streaming chunk parser
 */

/**
 * @callback CommandBuilder
 * @param {string} snapshotPath - Path to the code snapshot
 * @param {string} prompt - Review prompt
 * @returns {{ cmd: string, args: string[] }}
 */

/**
 * @callback SeverityMapper
 * @param {string} raw - Raw severity string from CLI output
 * @returns {Severity}
 */

/**
 * @callback OutputParser
 * @param {string} allOutput - Accumulated output
 * @param {string} sessionId
 * @param {string} snapshotRoot - For path normalization
 * @returns {import('../schema/events.js').Finding[]}
 */

/**
 * @callback ChunkParser
 * @param {string} chunk - Raw output chunk
 * @param {string} sessionId
 * @param {string} agentId
 * @returns {import('../schema/events.js').Event[]}
 */

// ── Built-in Parsing Strategies ─────────────────────

/**
 * Default severity mapper — handles common severity labels.
 * @type {SeverityMapper}
 */
export function defaultSeverityMapper(raw) {
    const n = (raw ?? '').toString().toLowerCase().trim();
    if (['critical', 'blocker', 'severe', 'p0', 'error'].includes(n)) return 'critical';
    if (['high', 'major', 'important', 'p1', 'warning'].includes(n)) return 'high';
    if (['medium', 'moderate', 'normal', 'p2', 'info'].includes(n)) return 'medium';
    if (['low', 'minor', 'trivial', 'nit', 'p3', 'p4', 'style'].includes(n)) return 'low';
    return 'medium';
}

/**
 * Default chunk parser — emits progress events for non-empty text.
 * @type {ChunkParser}
 */
export function defaultChunkParser(chunk, sessionId, agentId) {
    /** @type {import('../schema/events.js').Event[]} */
    const events = [];
    const trimmed = chunk.trim();

    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
            JSON.parse(trimmed);
            events.push(createEvent(sessionId, agentId, 'status', {
                state: 'processing',
                hasJson: true,
            }));
            return events;
        } catch {
            // Incomplete JSON — fall through to progress
        }
    }

    if (trimmed.length > 0) {
        events.push(createEvent(sessionId, agentId, 'status', {
            state: 'progress',
            text: trimmed.slice(0, 500),
        }));
    }

    return events;
}

/**
 * Default JSON output parser — extracts findings from JSON output.
 * Handles arrays, wrapped objects, and NDJSON.
 *
 * @param {string} allOutput
 * @param {string} _sessionId
 * @param {string} snapshotRoot
 * @param {SeverityMapper} mapSeverity
 * @returns {import('../schema/events.js').Finding[]}
 */
export function parseJsonOutput(allOutput, _sessionId, snapshotRoot, mapSeverity) {
    // Strategy 1: Find last JSON object/array
    const jsonMatch = allOutput.match(/(\{[\s\S]*\}|\[[\s\S]*\])\s*$/);
    if (jsonMatch) {
        try {
            const parsed = JSON.parse(jsonMatch[1]);
            const items = Array.isArray(parsed)
                ? parsed
                : (parsed.result ?? parsed.findings ?? parsed.issues
                    ?? parsed.review ?? parsed.output ?? parsed.results
                    ?? parsed.diagnostics ?? parsed.errors ?? parsed.warnings);

            if (Array.isArray(items)) {
                return extractFindingsFromArray(items, snapshotRoot, mapSeverity);
            }

            // Single finding-like object
            const hasSummary = parsed.summary || parsed.message || parsed.description;
            const hasFile = parsed.file || parsed.path || parsed.filename || parsed.location;
            if (hasSummary && hasFile) {
                return extractFindingsFromArray([parsed], snapshotRoot, mapSeverity);
            }
        } catch {
            // JSON parse failed — fall through
        }
    }

    // Strategy 2: NDJSON (newline-delimited JSON)
    const lines = allOutput.split('\n').filter((l) => l.trim().startsWith('{'));
    if (lines.length > 0) {
        /** @type {Array<Record<string, unknown>>} */
        const parsed = [];
        for (const line of lines) {
            try {
                parsed.push(JSON.parse(line.trim()));
            } catch {
                // Skip invalid lines
            }
        }
        if (parsed.length > 0) {
            return extractFindingsFromArray(parsed, snapshotRoot, mapSeverity);
        }
    }

    return [];
}

/**
 * Default text output parser — extracts findings from plain text.
 * Handles common patterns: file:line: message, numbered lists.
 *
 * @param {string} allOutput
 * @param {string} _sessionId
 * @param {string} snapshotRoot
 * @param {SeverityMapper} mapSeverity
 * @returns {import('../schema/events.js').Finding[]}
 */
export function parseTextOutput(allOutput, _sessionId, snapshotRoot, mapSeverity) {
    /** @type {import('../schema/events.js').Finding[]} */
    const findings = [];

    // Pattern 1: "file:line: message" or "file:line:col: message"
    const fileLinePattern = /(?:\*\*)?([^\s*:]+\.\w+):(\d+)(?::\d+)?(?:\*\*)?[\s:—-]+(.+)/g;
    let match;

    while ((match = fileLinePattern.exec(allOutput)) !== null) {
        const [, file, lineStr, summary] = match;
        let normalizedFile;
        try {
            normalizedFile = normalizeFindingPath(file, snapshotRoot);
        } catch {
            normalizedFile = file;
        }
        findings.push(createFinding({
            severity: mapSeverity('medium'),
            summary: summary.trim(),
            evidence: '',
            file: normalizedFile,
            line: parseInt(lineStr, 10),
            confidence: 0.3,
        }));
    }

    // Pattern 2: "N. **Title** in `file`: description"
    const numberedPattern = /\d+\.\s+\*\*(.+?)\*\*\s+(?:in\s+)?[`']([^\s`']+)[`'](?::(\d+))?\s*[:\-—]\s*(.+)/g;
    while ((match = numberedPattern.exec(allOutput)) !== null) {
        const [, title, file, lineStr, description] = match;
        const alreadyFound = findings.some((f) =>
            f.file === file && f.summary === title.trim()
        );
        if (!alreadyFound) {
            let normalizedFile;
            try {
                normalizedFile = normalizeFindingPath(file, snapshotRoot);
            } catch {
                normalizedFile = file;
            }
            findings.push(createFinding({
                severity: mapSeverity('medium'),
                summary: title.trim(),
                evidence: description.trim(),
                file: normalizedFile,
                line: lineStr ? parseInt(lineStr, 10) : null,
                confidence: 0.25,
            }));
        }
    }

    return findings;
}

/**
 * Extract findings from an array of raw finding-like objects.
 *
 * @param {Array<Record<string, unknown>>} items
 * @param {string} snapshotRoot
 * @param {SeverityMapper} mapSeverity
 * @returns {import('../schema/events.js').Finding[]}
 */
export function extractFindingsFromArray(items, snapshotRoot, mapSeverity) {
    /** @type {import('../schema/events.js').Finding[]} */
    const findings = [];

    for (const item of items) {
        if (!item || typeof item !== 'object') continue;

        const summary = String(
            item.summary ?? item.message ?? item.description
            ?? item.title ?? item.issue ?? item.check_id ?? ''
        );
        if (!summary) continue;

        const rawFile = String(item.file ?? item.path ?? item.filename ?? item.location ?? 'unknown');
        let normalizedFile;
        try {
            normalizedFile = normalizeFindingPath(rawFile, snapshotRoot);
        } catch {
            normalizedFile = rawFile;
        }

        findings.push(createFinding({
            severity: mapSeverity(String(item.severity ?? item.level ?? item.priority ?? 'medium')),
            summary,
            evidence: String(item.evidence ?? item.details ?? item.explanation ?? item.context ?? item.fix ?? ''),
            file: normalizedFile,
            line: typeof item.line === 'number' ? item.line
                : typeof item.lineNumber === 'number' ? item.lineNumber
                    : typeof item.line_number === 'number' ? item.line_number
                        : typeof item.start === 'object' && item.start !== null
                            && typeof (/** @type {any} */ (item.start)).line === 'number'
                            ? /** @type {any} */ (item.start).line
                            : null,
            confidence: typeof item.confidence === 'number'
                ? Math.min(1, Math.max(0, item.confidence))
                : 0.5,
        }));
    }

    return findings;
}

// ── GenericAdapter Class ─────────────────────────────

export class GenericAdapter extends BaseAdapter {
    /** @type {GenericAdapterConfig} */
    #config;

    /**
     * @param {GenericAdapterConfig} config
     */
    constructor(config) {
        if (!config || !config.agentId) {
            throw new Error('GenericAdapter requires config.agentId');
        }
        if (typeof config.buildCommand !== 'function') {
            throw new Error('GenericAdapter requires config.buildCommand function');
        }

        super(config.agentId, {
            firstByteMs: config.timeouts?.firstByteMs ?? GENERIC_TIMEOUT_DEFAULTS.firstByteMs,
            idleMs: config.timeouts?.idleMs ?? GENERIC_TIMEOUT_DEFAULTS.idleMs,
            hardMs: config.timeouts?.hardMs ?? GENERIC_TIMEOUT_DEFAULTS.hardMs,
        });

        this.#config = config;
    }

    /**
     * Build CLI command using config's builder function.
     * @param {string} snapshotPath
     * @param {string} prompt
     * @returns {{ cmd: string, args: string[] }}
     */
    buildCommand(snapshotPath, prompt) {
        return this.#config.buildCommand(snapshotPath, prompt);
    }

    /**
     * Parse a chunk of streaming output.
     * @param {string} chunk
     * @param {string} sessionId
     * @returns {import('../schema/events.js').Event[]}
     */
    parseChunk(chunk, sessionId) {
        if (this.#config.parseChunk) {
            return this.#config.parseChunk(chunk, sessionId, this.agentId);
        }
        return defaultChunkParser(chunk, sessionId, this.agentId);
    }

    /**
     * Parse accumulated output into findings.
     * Tries custom parser first, then JSON, then text fallback.
     *
     * @param {string} allOutput
     * @param {string} sessionId
     * @returns {import('../schema/events.js').Finding[]}
     */
    parseResult(allOutput, sessionId) {
        const snapshotRoot = process.cwd();
        const mapSev = this.#config.mapSeverity ?? defaultSeverityMapper;

        // Custom parser — full control
        if (this.#config.parseOutput) {
            return this.#config.parseOutput(allOutput, sessionId, snapshotRoot);
        }

        // Default: JSON first, text fallback
        const jsonFindings = parseJsonOutput(allOutput, sessionId, snapshotRoot, mapSev);
        if (jsonFindings.length > 0) return jsonFindings;

        return parseTextOutput(allOutput, sessionId, snapshotRoot, mapSev);
    }
}

export { GENERIC_TIMEOUT_DEFAULTS };

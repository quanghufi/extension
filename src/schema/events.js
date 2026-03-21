// @ts-check
/**
 * Event Schema & Finding Model
 * 
 * Event factory functions matching BRIEF.md schema.
 * Events are created WITHOUT seq — Hub assigns monotonic seq on receipt.
 * Finding dedupe_key excludes severity (R3 finding 3).
 * 
 * @module schema/events
 */

import { createHash } from 'node:crypto';
import { v4 as uuidv4 } from 'uuid';

// ── Constants ────────────────────────────────────────

/** @type {readonly string[]} */
const SEVERITY_LEVELS = /** @type {const} */ (['critical', 'high', 'medium', 'low']);

/** @type {readonly string[]} */
const COLLAB_EVENT_TYPES = /** @type {const} */ ([
    'message_posted', 'turn_claimed', 'turn_released', 'turn_expired',
    'agent_assigned', 'collab_state_changed',
    'resolution_requested', 'session_resolved', 'session_closed',
]);

/** @type {readonly string[]} */
const DEBATE_EVENT_TYPES = /** @type {const} */ ([
    'debate_started', 'debate_phase_changed', 'debate_agent_completed',
    'debate_resolved', 'debate_failed',
]);

/** @type {readonly string[]} */
const EVENT_TYPES = /** @type {const} */ ([
    'finding', 'status', 'error', 'heartbeat', 'raw_output',
    ...COLLAB_EVENT_TYPES,
    ...DEBATE_EVENT_TYPES,
]);

// ── Event Factory ────────────────────────────────────

/**
 * Creates a validated event envelope.
 * NOTE: No `seq` field — Hub assigns it on receipt (R3 finding 5).
 *
 * @param {string} sessionId - Session UUID
 * @param {string} agentId - Agent identifier (e.g. 'codex')
 * @param {string} eventType - One of EVENT_TYPES
 * @param {Record<string, unknown>} payload - Event-specific data
 * @returns {Event}
 */
export function createEvent(sessionId, agentId, eventType, payload) {
    if (!sessionId || typeof sessionId !== 'string') {
        throw new Error('sessionId is required and must be a string');
    }
    if (!agentId || typeof agentId !== 'string') {
        throw new Error('agentId is required and must be a string');
    }
    if (!EVENT_TYPES.includes(eventType)) {
        throw new Error(`eventType must be one of: ${EVENT_TYPES.join(', ')}`);
    }

    return {
        session_id: sessionId,
        agent_id: agentId,
        // seq is NOT set here — Hub assigns it
        event_type: eventType,
        timestamp: new Date().toISOString(),
        payload: payload ?? {},
    };
}

// ── Finding Factory ──────────────────────────────────

/**
 * Creates a finding with auto-generated dedupe_key.
 * Severity is NOT in the dedupe fingerprint (R3 finding 3).
 * Summary is normalized before hashing.
 *
 * @param {Object} opts
 * @param {string} opts.severity - 'critical' | 'high' | 'medium' | 'low'
 * @param {string} opts.summary - Short description of the issue
 * @param {string} opts.evidence - Detailed evidence / code quotes
 * @param {string} opts.file - File path (should be normalized before calling)
 * @param {number|null} [opts.line] - Line number (null if not applicable)
 * @param {number} [opts.confidence] - 0.0 to 1.0 (default 0.5)
 * @param {string|null} [opts.fix_instructions] - How to fix (from Codex schema)
 * @param {string|null} [opts.why_it_matters] - Why this matters (from Codex schema)
 * @returns {Finding}
 */
export function createFinding({ severity, summary, evidence, file, line = null, confidence = 0.5, fix_instructions = null, why_it_matters = null }) {
    if (!SEVERITY_LEVELS.includes(severity)) {
        throw new Error(`severity must be one of: ${SEVERITY_LEVELS.join(', ')}`);
    }
    if (!summary || typeof summary !== 'string') {
        throw new Error('summary is required and must be a string');
    }
    if (!file || typeof file !== 'string') {
        throw new Error('file is required and must be a string');
    }
    if (typeof confidence !== 'number' || confidence < 0 || confidence > 1) {
        throw new Error('confidence must be a number between 0 and 1');
    }

    const id = `F-${uuidv4().slice(0, 8).toUpperCase()}`;
    const dedupe_key = computeDedupeKey({ file, line, summary });

    return {
        id,
        severity,
        summary,
        evidence: evidence ?? '',
        file,
        line,
        confidence,
        dedupe_key,
        fix_instructions: fix_instructions ?? null,
        why_it_matters: why_it_matters ?? null,
    };
}

// ── Dedup Utilities ──────────────────────────────────

/**
 * Normalize summary for dedup comparison.
 * Lowercase, strip punctuation, collapse whitespace.
 *
 * @param {string} text
 * @returns {string}
 */
export function normalizeSummary(text) {
    return text
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, '') // strip non-letter, non-number, non-space (Unicode-safe)
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Compute dedupe key from finding fields.
 * Hash of: normalizedFile + line + normalizedSummary.
 * Severity is EXCLUDED from fingerprint (R3 finding 3).
 *
 * @param {Object} opts
 * @param {string} opts.file - Already-normalized file path
 * @param {number|null} [opts.line] - Line number
 * @param {string} opts.summary - Raw summary (will be normalized)
 * @returns {string} SHA-256 hex hash (first 16 chars)
 */
export function computeDedupeKey({ file, line, summary }) {
    const normalizedSummary = normalizeSummary(summary);
    const input = `${file}:${line ?? 'null'}:${normalizedSummary}`;
    return createHash('sha256').update(input, 'utf-8').digest('hex').slice(0, 16);
}

// ── Type Definitions (JSDoc) ─────────────────────────

/**
 * @typedef {Object} Event
 * @property {string} session_id
 * @property {string} agent_id
 * @property {number} [seq] - Assigned by Hub, not by creator
 * @property {string} event_type
 * @property {string} timestamp - ISO-8601
 * @property {Record<string, unknown>} payload
 */

/**
 * @typedef {Object} Finding
 * @property {string} id - Unique ID (F-XXXXXXXX)
 * @property {string} severity - 'critical' | 'high' | 'medium' | 'low'
 * @property {string} summary
 * @property {string} evidence
 * @property {string} file
 * @property {number|null} line
 * @property {number} confidence - 0.0 to 1.0
 * @property {string} dedupe_key - SHA-256 fingerprint (16 chars)
 * @property {string|null} fix_instructions - How to fix (from Codex schema)
 * @property {string|null} why_it_matters - Why this matters (from Codex schema)
 */

/**
 * @typedef {Object} GroupedFinding
 * @property {string} dedupe_key
 * @property {Finding} finding - Representative finding
 * @property {string[]} agents - Which agents found this (e.g. ['codex', 'semgrep'])
 * @property {Finding[]} raw_findings - All original per-agent findings
 */

/**
 * @typedef {Object} AdapterResult
 * @property {'ok'|'failed'|'timeout'} status
 * @property {Finding[]} findings
 * @property {TimingTelemetry} timingMs
 */

/**
 * @typedef {Object} TimingTelemetry
 * @property {number} firstByteMs
 * @property {number} lastIdleGapMs
 * @property {number} totalMs
 */

export { SEVERITY_LEVELS, EVENT_TYPES, COLLAB_EVENT_TYPES, DEBATE_EVENT_TYPES };

// @ts-check
/**
 * Codex adapter prompt + JSONL parsing helpers.
 *
 * Supports Codex CLI v0.112+ `codex exec --json` output.
 *
 * @module adapters/codex-adapter-parsing
 */

import { createEvent, createFinding } from '../schema/events.js';

/** Marker that signals a prompt already contains debate instructions — adapters skip wrapping. */
export const DEBATE_PROMPT_MARKER = '__DEBATE_PROMPT__';

/** @type {RegExp} Progress bar characters (block elements U+2580–U+259F) */
const PROGRESS_BAR_RE = /^[\u2580-\u259F\s.#=\-|/\\>]+$/;

/** Minimum characters for a text line to be treated as progress */
const MIN_PROGRESS_LENGTH = 5;

/**
 * Add a structured-output contract to the user prompt.
 * The final agent message should be a JSON array of finding-like objects.
 *
 * @param {string} prompt
 * @returns {string}
 */
export function formatReviewPrompt(prompt) {
    // Debate prompts already contain output instructions — pass through verbatim.
    if (prompt.includes(/** @type {string} */ ('__DEBATE_PROMPT__'))) {
        return prompt;
    }

    return [
        prompt.trim(),
        '',
        'Review the requested code scope directly.',
        'You may inspect other files only if needed to verify a concrete interaction or call site.',
        'Do not inspect git diff, git history, or unrelated files unless the prompt explicitly asks for that.',
        'Report only findings supported by the code you actually inspected.',
        '',
        'Return the final answer as a JSON object.',
        'The object must have keys: status, summary, findings, fix_plan, rerun_review.',
        'Each finding in findings must have: severity, title, why_it_matters, file, line, fix_instructions, confidence.',
        'Use severity from: critical, high, medium, low.',
        'Use confidence from: high, medium, low.',
        'Use null for unknown line numbers. Use "unknown" for unknown files.',
        'Do not wrap the JSON in markdown fences.',
    ].join('\n');
}

/**
 * Parse a chunk of Codex exec JSONL output into hub events.
 *
 * @param {string} chunk
 * @param {string} sessionId
 * @param {string} agentId
 * @returns {import('../schema/events.js').Event[]}
 */
export function parseCodexExecChunk(chunk, sessionId, agentId) {
    if (!chunk || chunk.trim().length === 0) {
        return [];
    }

    const events = [];
    const lines = chunk.split('\n');

    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;

        try {
            const parsed = JSON.parse(line);
            const event = mapJsonlEventToHubEvent(parsed, sessionId, agentId);
            if (event) {
                events.push(event);
            }
            continue;
        } catch {
            if (PROGRESS_BAR_RE.test(line) || (!/[\p{L}\p{N}]/u.test(line) && line.length >= MIN_PROGRESS_LENGTH) || line.length < MIN_PROGRESS_LENGTH) {
                continue;
            }

            events.push(createEvent(sessionId, agentId, 'status', {
                state: 'progress',
                text: line,
            }));
        }
    }

    return events;
}

/**
 * Parse all Codex output into final findings.
 *
 * @param {string} allOutput
 * @returns {import('../schema/events.js').Finding[]}
 */
export function parseCodexExecResult(allOutput) {
    if (!allOutput || allOutput.trim().length === 0) {
        return [];
    }

    /** @type {string[]} */
    const finalMessages = [];

    for (const rawLine of allOutput.split('\n')) {
        const line = rawLine.trim();
        if (!line || !line.startsWith('{')) continue;

        let parsed;
        try {
            parsed = JSON.parse(line);
        } catch {
            continue;
        }

        const messageText = extractAgentMessageText(parsed);
        if (messageText) {
            finalMessages.push(messageText);
        }
    }

    for (let index = finalMessages.length - 1; index >= 0; index -= 1) {
        const findings = parseFindingsFromAgentMessage(finalMessages[index]);
        if (findings.length > 0) {
            return findings;
        }
    }

    return [];
}

/**
 * @param {any} parsed
 * @param {string} sessionId
 * @param {string} agentId
 * @returns {import('../schema/events.js').Event | null}
 */
function mapJsonlEventToHubEvent(parsed, sessionId, agentId) {
    const type = parsed?.type ?? '';

    if (type === 'item.completed') {
        const item = parsed.item ?? {};

        if (item.type === 'agent_message') {
            return createEvent(sessionId, agentId, 'status', {
                state: 'agent_message',
                text: item.text ?? '',
            });
        }

        if (item.type === 'command_execution') {
            return createEvent(sessionId, agentId, 'status', {
                state: 'command_completed',
                text: item.command ?? '',
            });
        }
    }

    if (type === 'item.started') {
        const item = parsed.item ?? {};
        if (item.type === 'command_execution') {
            return createEvent(sessionId, agentId, 'status', {
                state: 'command_started',
                text: item.command ?? '',
            });
        }
    }

    if (type === 'turn.completed') {
        return createEvent(sessionId, agentId, 'status', {
            state: 'turn_completed',
            text: '',
        });
    }

    return null;
}

/** @param {any} parsed @returns {string | null} */
function extractAgentMessageText(parsed) {
    if (parsed?.type !== 'item.completed') {
        return null;
    }

    const item = parsed.item ?? {};
    if (item.type !== 'agent_message' || typeof item.text !== 'string') {
        return null;
    }

    return item.text;
}

/**
 * @param {string} text
 * @returns {import('../schema/events.js').Finding[]}
 */
function parseFindingsFromAgentMessage(text) {
    const normalized = text.trim();
    let parsed;
    try {
        parsed = JSON.parse(normalized);
    } catch {
        return [];
    }

    let items = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed?.findings)
            ? parsed.findings
            : null;

    if (Array.isArray(items) && items.length === 0 && typeof parsed?.summary === 'string') {
        const fallbackItems = tryParseEmbeddedItems(parsed.summary);
        if (fallbackItems) {
            items = fallbackItems;
        }
    }

    if (!items) {
        return [];
    }

    return items
        .map((item) => normalizeFinding(item))
        .filter(Boolean);
}

/** @param {any} item @returns {import('../schema/events.js').Finding | null} */
function normalizeFinding(item) {
    if (!item || typeof item !== 'object') {
        return null;
    }

    const explicitDedupeKey = typeof item.dedupeKey === 'string'
        ? item.dedupeKey.trim()
        : typeof item.dedupe_key === 'string'
            ? item.dedupe_key.trim()
            : '';
    const rationale = typeof item.rationale === 'string' ? item.rationale.trim() : '';
    const summary = item.summary ?? item.title ?? item.message ?? item.description ?? explicitDedupeKey ?? null;
    if (!summary) {
        return null;
    }

    const confidence = normalizeConfidence(item.confidence);
    const finding = createFinding({
        severity: mapSeverity(item.severity ?? 'medium'),
        summary,
        evidence: item.evidence ?? item.body ?? rationale ?? item.why_it_matters ?? item.fix_instructions ?? '',
        file: item.file ?? 'unknown',
        line: typeof item.line === 'number' ? item.line : null,
        confidence,
        fix_instructions: item.fix_instructions ?? null,
        why_it_matters: item.why_it_matters ?? rationale ?? null,
    });

    if (explicitDedupeKey) {
        finding.dedupe_key = explicitDedupeKey;
    }

    return finding;
}

/**
 * @param {string} text
 * @returns {any[]|null}
 */
function tryParseEmbeddedItems(text) {
    const trimmed = text.trim();
    try {
        const parsed = JSON.parse(trimmed);
        return Array.isArray(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

/**
 * Normalize Codex-ish severity labels to hub schema.
 * @param {string} severity
 * @returns {'critical'|'high'|'medium'|'low'}
 */
export function mapSeverity(severity) {
    const s = String(severity || '').toLowerCase();
    if (['critical', 'error', 'fatal'].includes(s)) return 'critical';
    if (['high', 'warning', 'warn'].includes(s)) return 'high';
    if (['medium', 'info', 'note'].includes(s)) return 'medium';
    if (['low', 'hint', 'suggestion'].includes(s)) return 'low';
    return 'medium';
}

/**
 * @param {unknown} confidence
 * @returns {number}
 */
function normalizeConfidence(confidence) {
    if (typeof confidence === 'number') {
        return Math.max(0, Math.min(1, confidence));
    }

    const normalized = String(confidence ?? '').toLowerCase();
    if (normalized === 'high') return 0.9;
    if (normalized === 'medium') return 0.6;
    if (normalized === 'low') return 0.3;
    return 0.5;
}

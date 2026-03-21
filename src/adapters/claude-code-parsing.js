// @ts-check
/**
 * Claude Code CLI — Parsing module
 *
 * Handles:
 * - Review prompt generation for Claude Code CLI
 * - NDJSON stream-json event parsing → Hub Events
 * - Final result → structured Findings extraction
 *
 * Claude Code CLI stream-json format:
 *   {"type":"system","subtype":"init",...}
 *   {"type":"assistant","content":[{"type":"text","text":"..."}],...}
 *   {"type":"result","subtype":"success","result":"...","duration_ms":...}
 *
 * @module adapters/claude-code-parsing
 */

import { createEvent, createFinding } from '../schema/events.js';

// ── Prompt Template ─────────────────────────────────

/**
 * Build a structured review prompt for Claude Code CLI.
 * Uses explicit JSON output instructions so findings can be parsed.
 *
 * @param {string} prompt - User's review prompt
 * @param {string} [contextSnippet] - Optional code snippet for context
 * @returns {string}
 */
export function buildReviewPrompt(prompt, contextSnippet) {
    const parts = [
        prompt,
        '',
        'Review the requested code scope directly.',
        'You may inspect other files only if needed to verify a concrete interaction or call site.',
        'Do not inspect git diff, git history, or unrelated files unless the prompt explicitly asks for that.',
        'Report only findings supported by the code you actually inspected.',
        'Prefer fewer, stronger findings over a long list of weak suspicions.',
        'For every finding, explain why it matters in production and give a concrete remediation that another agent can implement directly.',
        '',
        'IMPORTANT: Return your findings as a JSON array. Each finding must have:',
        '- "summary": short description of the issue',
        '- "evidence": detailed explanation / code quotes',
        '- "why_it_matters": specific impact if left unfixed',
        '- "fix_instructions": concrete change to make, not generic advice',
        '- "severity": one of "critical", "high", "medium", "low"',
        '- "file": relative file path',
        '- "line": line number (null if not applicable)',
        '- "confidence": number from 0.0 to 1.0',
        '- When adjudicating disputed findings that already include a "dedupeKey", copy that exact "dedupeKey" into each surviving finding.',
        '',
        'Format your response as:',
        '```json',
        '[{"summary":"...","evidence":"...","why_it_matters":"...","fix_instructions":"...","severity":"...","file":"...","line":0,"confidence":0.9}]',
        '```',
        '',
        'If the prompt is asking you to adjudicate disputed findings, return ONLY a JSON array and nothing before or after it.',
        'If a finding is real but you cannot provide a useful fix, explain the blocker in "fix_instructions" instead of leaving it empty.',
        'If no issues found, return: []',
    ];

    if (contextSnippet) {
        parts.push('', '--- Code Context ---', contextSnippet);
    }

    return parts.join('\n');
}

// ── Stream Parsing ──────────────────────────────────

/**
 * Parse a single Claude Code stream-json line into Hub Events.
 *
 * Claude emits NDJSON lines:
 * - {type:"system",subtype:"init"} → status event (started)
 * - {type:"assistant",content:[{type:"text",text:"..."}]} → raw_output + agent_message
 * - {type:"result",subtype:"success",result:"..."} → status event (done)
 *
 * @param {string} line - Single NDJSON line
 * @param {string} sessionId
 * @param {string} agentId
 * @returns {import('../schema/events.js').Event[]}
 */
export function parseStreamLine(line, sessionId, agentId) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith('{')) return [];

    /** @type {any} */
    let parsed;
    try {
        parsed = JSON.parse(trimmed);
    } catch {
        return [];
    }

    const events = [];

    if (parsed.type === 'system' && parsed.subtype === 'init') {
        return events;
    } else if (parsed.type === 'assistant') {
        // Extract text content from assistant message
        const text = extractAssistantText(parsed);
        if (text) {
            // Note: raw_output is already emitted by handleProcessOutput in adapter-execution.js
            // Only emit semantic agent_message event here to avoid duplicate raw_output
            events.push(createEvent(sessionId, agentId, 'status', {
                state: 'agent_message', text,
            }));
        }
    }

    return events;
}

/**
 * Extract text content from a Claude assistant message.
 * @param {any} parsed - Parsed assistant JSON
 * @returns {string|null}
 */
function extractAssistantText(parsed) {
    // Format: {type:"assistant", content:[{type:"text", text:"..."}]}
    if (Array.isArray(parsed.content)) {
        const texts = parsed.content
            .filter((/** @type {any} */ c) => c.type === 'text' && c.text)
            .map((/** @type {any} */ c) => c.text);
        return texts.length > 0 ? texts.join('\n') : null;
    }
    // Fallback: direct message field
    if (typeof parsed.message === 'string') return parsed.message;
    return null;
}

// ── Result Parsing ──────────────────────────────────

/**
 * Parse all Claude Code output into structured Findings.
 *
 * Strategy:
 * 1. Find the last "result" NDJSON line → extract result text
 * 2. Try to parse JSON array from result text (from ```json``` blocks)
 * 3. Fallback: parse structured text into findings
 *
 * @param {string} allOutput - Concatenated NDJSON output
 * @param {string} sessionId
 * @returns {import('../schema/events.js').Finding[]}
 */
export function parseClaudeResult(allOutput, sessionId) {
    // Strategy 1: Find result line in NDJSON stream-json format
    const resultText = extractResultText(allOutput);

    if (resultText) {
        // Strategy 2: Try JSON array extraction from NDJSON result text
        const jsonFindings = tryParseJsonFindings(resultText, sessionId);
        if (jsonFindings.length > 0) return jsonFindings;
    }

    // Strategy 3: Try extracting from assistant messages in NDJSON
    const assistantText = extractAllAssistantText(allOutput);
    if (assistantText) {
        const fromAssistant = tryParseJsonFindings(assistantText, sessionId);
        if (fromAssistant.length > 0) return fromAssistant;
    }

    // Strategy 4: Try parsing allOutput directly as text with embedded JSON
    // (Claude Code CLI may send plain text to stdout instead of NDJSON)
    const directFindings = tryParseJsonFindings(allOutput, sessionId);
    if (directFindings.length > 0) return directFindings;

    // Strategy 5: If there's meaningful text with actual issue patterns, create a single finding
    const textToCheck = resultText || allOutput;
    const issuePatterns = /\b(bug|error|vulnerability|issue|problem|fix|warning|risk|security|flaw|defect|leak)\b/i;
    if (textToCheck.length > 50 && issuePatterns.test(textToCheck) && !textToCheck.toLowerCase().includes('no issues')) {
        return [createFinding({
            summary: 'Claude Code Review Summary',
            evidence: textToCheck.substring(0, 2000),
            severity: 'medium',
            file: '(review)',
        })];
    }

    return [];
}

/**
 * Extract the result text from NDJSON output.
 * @param {string} allOutput
 * @returns {string|null}
 */
function extractResultText(allOutput) {
    const lines = allOutput.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (!line.startsWith('{')) continue;
        try {
            const parsed = JSON.parse(line);
            if (parsed.type === 'result' && typeof parsed.result === 'string') {
                return parsed.result;
            }
        } catch {
            // not JSON, skip
        }
    }
    return null;
}

/**
 * Extract all assistant text from NDJSON output.
 * @param {string} allOutput
 * @returns {string|null}
 */
function extractAllAssistantText(allOutput) {
    const texts = [];
    for (const line of allOutput.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('{')) continue;
        try {
            const parsed = JSON.parse(trimmed);
            if (parsed.type === 'assistant') {
                const text = extractAssistantText(parsed);
                if (text) texts.push(text);
            }
        } catch {
            // skip
        }
    }
    return texts.length > 0 ? texts.join('\n') : null;
}

/**
 * Try to parse JSON findings array from text.
 * Handles: raw JSON, ```json blocks, embedded arrays.
 *
 * @param {string} text
 * @param {string} _sessionId
 * @returns {import('../schema/events.js').Finding[]}
 */
function tryParseJsonFindings(text, _sessionId) {
    // Try 1: Direct JSON parse
    const directResult = tryDirectParse(text);
    if (directResult) return directResult;

    // Try 2: Extract from ```json code block
    const jsonBlockMatch = text.match(/```json\s*\n?([\s\S]*?)\n?\s*```/);
    if (jsonBlockMatch) {
        const blockResult = tryDirectParse(jsonBlockMatch[1]);
        if (blockResult) return blockResult;
    }

    // Try 3: Find first [ ... ] array in text
    const arrayMatch = text.match(/\[[\s\S]*?\]/);
    if (arrayMatch) {
        const arrayResult = tryDirectParse(arrayMatch[0]);
        if (arrayResult) return arrayResult;
    }

    return [];
}

/**
 * Try to directly parse a JSON string into Findings.
 * @param {string} jsonStr
 * @returns {import('../schema/events.js').Finding[]|null}
 */
function tryDirectParse(jsonStr) {
    try {
        const parsed = JSON.parse(jsonStr.trim());
        const arr = Array.isArray(parsed)
            ? parsed
            : Array.isArray(parsed?.findings)
                ? parsed.findings
                : null;
        if (!arr) return null;
        if (arr.length === 0) return [];

        return arr
            .filter((/** @type {any} */ item) => item && (item.summary || item.title || item.description || item.issue))
            .map(normalizeClaudeFinding);
    } catch {
        return null;
    }
}

/**
 * @param {any} item
 * @returns {import('../schema/events.js').Finding}
 */
function normalizeClaudeFinding(item) {
    const finding = createFinding({
        summary: item.summary || item.title || item.issue || item.description || 'Untitled finding',
        evidence: item.evidence || item.detail || item.description || item.why_it_matters || item.fix_instructions || item.recommendation || item.suggestion || '',
        severity: mapSeverity(item.severity),
        file: item.file || '(review)',
        line: typeof item.line === 'number' ? item.line : null,
        confidence: normalizeConfidence(item.confidence),
        fix_instructions: item.fix_instructions || item.recommendation || item.suggestion || null,
        why_it_matters: item.why_it_matters || item.impact || item.risk || null,
    });

    const explicitDedupeKey = typeof item.dedupeKey === 'string'
        ? item.dedupeKey.trim()
        : typeof item.dedupe_key === 'string'
            ? item.dedupe_key.trim()
            : '';
    if (explicitDedupeKey) {
        finding.dedupe_key = explicitDedupeKey;
    }

    return finding;
}

/**
 * @param {unknown} confidence
 * @returns {number}
 */
function normalizeConfidence(confidence) {
    if (typeof confidence === 'number') {
        return Math.max(0, Math.min(1, confidence));
    }

    const normalized = String(confidence ?? '').toLowerCase().trim();
    if (normalized === 'high') return 0.9;
    if (normalized === 'medium') return 0.6;
    if (normalized === 'low') return 0.3;
    return 0.5;
}

// ── Mappers ─────────────────────────────────────────

/**
 * Map severity string to normalized value.
 * @param {string} [severity]
 * @returns {'critical'|'high'|'medium'|'low'}
 */
export function mapSeverity(severity) {
    if (!severity) return 'medium';
    const s = String(severity).toLowerCase().trim();
    if (['critical', 'error'].includes(s)) return 'critical';
    if (['high', 'major', 'important'].includes(s)) return 'high';
    if (['low', 'minor', 'trivial', 'suggestion', 'info'].includes(s)) return 'low';
    return 'medium';
}

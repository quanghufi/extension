// @ts-check

import { v4 as uuidv4 } from 'uuid';

export const REBUTTAL_VERDICTS = /** @type {const} */ ([
    'accept', 'reject', 'defer', 'needs_evidence',
]);

export const REBUTTAL_REASON_CODES = /** @type {const} */ ([
    'valid_finding',
    'not_a_bug',
    'intended_behavior',
    'duplicate',
    'insufficient_evidence',
    'wrong_location',
    'stale_revision',
    'needs_investigation',
    'other',
]);

export const REBUTTAL_ACTIONS = /** @type {const} */ ([
    'fix', 'drop', 'revise', 'defend', 'escalate',
]);

/**
 * @param {import('./session.js').Session} session
 * @param {Record<string, unknown>} input
 * @param {object} [options]
 * @param {string} [options.createdBy]
 * @returns {RebuttalRecord}
 */
export function normalizeRebuttalInput(session, input, options = {}) {
    const target = resolveTarget(session, input);
    const verdict = String(input.verdict ?? '').trim();
    if (!REBUTTAL_VERDICTS.includes(/** @type {typeof REBUTTAL_VERDICTS[number]} */ (verdict))) {
        throw new Error(`Invalid rebuttal verdict: ${verdict || '(empty)'}`);
    }

    const reasonCode = String(input.reasonCode ?? defaultReasonCodeForVerdict(verdict));
    if (!REBUTTAL_REASON_CODES.includes(/** @type {typeof REBUTTAL_REASON_CODES[number]} */ (reasonCode))) {
        throw new Error(`Invalid rebuttal reasonCode: ${reasonCode || '(empty)'}`);
    }

    const rationale = String(input.rationale ?? input.reason ?? '').trim();
    if (['reject', 'defer', 'needs_evidence'].includes(verdict) && rationale.length === 0) {
        throw new Error(`rationale is required for verdict ${verdict}`);
    }

    const requestedAction = String(input.requestedAction ?? defaultActionForVerdict(verdict));
    if (!REBUTTAL_ACTIONS.includes(/** @type {typeof REBUTTAL_ACTIONS[number]} */ (requestedAction))) {
        throw new Error(`Invalid rebuttal requestedAction: ${requestedAction || '(empty)'}`);
    }

    return {
        id: `R-${uuidv4().slice(0, 8).toUpperCase()}`,
        sourceSessionId: session.id,
        target,
        verdict,
        reasonCode,
        rationale,
        requestedAction,
        createdAt: new Date().toISOString(),
        createdBy: String(options.createdBy ?? input.createdBy ?? 'antigravity'),
        status: 'open',
    };
}

/**
 * @param {import('./session.js').Session} session
 * @param {RebuttalRecord} rebuttal
 * @returns {RebuttalRecord[]}
 */
export function upsertRebuttal(session, rebuttal) {
    const retained = session.rebuttals.filter((entry) => !sameRebuttalTarget(entry, rebuttal));
    return [...retained, rebuttal];
}

/**
 * @param {import('./session.js').Session} session
 * @param {string} [context]
 * @returns {string}
 */
export function buildAppealPrompt(session, context) {
    const basePrompt = context ?? session.prompt;
    const rebuttals = session.rebuttals.filter((entry) => entry.verdict !== 'accept');
    if (rebuttals.length === 0) {
        return basePrompt;
    }

    const lines = rebuttals.map((entry, index) => [
        `Case ${index + 1}`,
        `- dedupe_key: ${entry.target.dedupeKey}`,
        `- finding_id: ${entry.target.findingId}`,
        `- file: ${entry.target.file}`,
        `- line: ${entry.target.line ?? 'null'}`,
        `- summary: ${entry.target.summary}`,
        `- verdict: ${entry.verdict}`,
        `- reason_code: ${entry.reasonCode}`,
        `- rationale: ${entry.rationale || '(none provided)'}`,
        `- requested_action: ${entry.requestedAction}`,
        'Required response: withdraw, revise, or defend with stronger evidence.',
    ].join('\n'));

    return [
        basePrompt,
        '',
        'Structured rebuttal bundle from Antigravity:',
        ...lines,
        '',
        'Review only these rebutted findings first before adding any new findings.',
    ].join('\n');
}

/**
 * @param {import('./session.js').Session} parentSession
 * @param {import('./session.js').Session} childSession
 * @returns {RebuttalOutcome[]}
 */
export function deriveAppealOutcomes(parentSession, childSession) {
    const childFindings = childSession.allFindings ?? [];
    return parentSession.rebuttals
        .filter((entry) => entry.verdict !== 'accept')
        .map((entry) => {
            const exact = childFindings.find((finding) => finding.dedupe_key === entry.target.dedupeKey);
            if (exact) {
                return createOutcome(entry, childSession, 'maintained', exact);
            }

            const revised = childFindings.find((finding) => isPotentialRevision(entry.target, finding));
            if (revised) {
                return createOutcome(entry, childSession, 'revised', revised);
            }

            return createOutcome(entry, childSession, 'withdrawn');
        });
}

/**
 * @param {RebuttalRecord} rebuttal
 * @returns {{findingId: string, verdict: string, reason: string, action: string}}
 */
export function toLegacyEvaluation(rebuttal) {
    return {
        findingId: rebuttal.target.findingId,
        verdict: rebuttal.verdict === 'accept' ? 'agree' : rebuttal.verdict === 'reject' ? 'disagree' : 'defer',
        reason: rebuttal.rationale,
        action: rebuttal.requestedAction,
    };
}

/**
 * @param {RebuttalRecord} left
 * @param {RebuttalRecord} right
 * @returns {boolean}
 */
function sameRebuttalTarget(left, right) {
    return left.target.dedupeKey === right.target.dedupeKey && left.createdBy === right.createdBy;
}

/**
 * @param {import('./session.js').Session} session
 * @param {Record<string, unknown>} input
 * @returns {RebuttalTarget}
 */
function resolveTarget(session, input) {
    const dedupeKey = String(input.dedupeKey ?? input.dedupe_key ?? '').trim();
    const findingId = String(input.findingId ?? input.finding_id ?? '').trim();
    const finding = session.allFindings.find((item) => item.dedupe_key === dedupeKey || item.id === findingId);
    if (!finding) {
        throw new Error('Rebuttal target must reference a finding in the session');
    }

    return {
        findingId: finding.id,
        dedupeKey: finding.dedupe_key,
        file: finding.file,
        line: finding.line,
        summary: finding.summary,
    };
}

/**
 * @param {string} verdict
 * @returns {string}
 */
function defaultReasonCodeForVerdict(verdict) {
    if (verdict === 'accept') return 'valid_finding';
    if (verdict === 'defer') return 'needs_investigation';
    if (verdict === 'needs_evidence') return 'insufficient_evidence';
    return 'other';
}

/**
 * @param {string} verdict
 * @returns {string}
 */
function defaultActionForVerdict(verdict) {
    if (verdict === 'accept') return 'fix';
    if (verdict === 'reject') return 'drop';
    if (verdict === 'needs_evidence') return 'defend';
    if (verdict === 'defer') return 'escalate';
    return 'revise';
}

/**
 * @param {RebuttalTarget} target
 * @param {import('../schema/events.js').Finding} finding
 * @returns {boolean}
 */
function isPotentialRevision(target, finding) {
    if (target.file !== finding.file) return false;
    return normalizeText(target.summary) === normalizeText(finding.summary);
}

/**
 * @param {string} value
 * @returns {string}
 */
function normalizeText(value) {
    return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * @param {RebuttalRecord} entry
 * @param {import('./session.js').Session} childSession
 * @param {'maintained'|'revised'|'withdrawn'} outcome
 * @param {import('../schema/events.js').Finding} [finding]
 * @returns {RebuttalOutcome}
 */
function createOutcome(entry, childSession, outcome, finding) {
    return {
        rebuttalId: entry.id,
        targetDedupeKey: entry.target.dedupeKey,
        childSessionId: childSession.id,
        outcome,
        findingId: finding?.id ?? null,
        dedupeKey: finding?.dedupe_key ?? null,
        recordedAt: new Date().toISOString(),
    };
}

/**
 * @typedef {{
 *   findingId: string,
 *   dedupeKey: string,
 *   file: string,
 *   line: number|null,
 *   summary: string,
 * }} RebuttalTarget
 *
 * @typedef {{
 *   id: string,
 *   sourceSessionId: string,
 *   target: RebuttalTarget,
 *   verdict: 'accept'|'reject'|'defer'|'needs_evidence',
 *   reasonCode: string,
 *   rationale: string,
 *   requestedAction: 'fix'|'drop'|'revise'|'defend'|'escalate',
 *   createdAt: string,
 *   createdBy: string,
 *   status: 'open',
 * }} RebuttalRecord
 *
 * @typedef {{
 *   rebuttalId: string,
 *   targetDedupeKey: string,
 *   childSessionId: string,
 *   outcome: 'maintained'|'revised'|'withdrawn',
 *   findingId: string|null,
 *   dedupeKey: string|null,
 *   recordedAt: string,
 * }} RebuttalOutcome
 */

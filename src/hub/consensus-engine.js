// @ts-check
/**
 * Consensus Engine — calculates agreement between agents and merges findings.
 *
 * Pure logic, no I/O. Used by the debate orchestrator to determine
 * whether agents agree or need another debate round.
 *
 * @module hub/consensus-engine
 */

// ── Types ────────────────────────────────────────────

/**
 * @typedef {{
 *   dedupeKey: string,
 *   severity: string,
 *   title: string,
 *   agentId: string,
 *   confidence?: number,
 *   round?: number,
 *   timestamp?: string,
 * }} FindingEntry
 *
 * @typedef {{
 *   dedupeKey: string,
 *   verdict: 'accepted' | 'rejected' | 'disputed',
 *   agentId: string,
 *   rationale?: string,
 *   round?: number,
 * }} EvaluationEntry
 *
 * @typedef {{
 *   dedupeKey: string,
 *   severity: string,
 *   title: string,
 *   originalAgent: string,
 *   status: 'agreed' | 'disputed' | 'dropped',
 *   confidence: number,
 *   originalConfidence: 'certain' | 'likely' | 'inference',
 *   evaluations: EvaluationEntry[],
 * }} MergedFinding
 *
 * @typedef {{
 *   ratio: number,
 *   agreed: FindingEntry[],
 *   disputed: FindingEntry[],
 *   dropped: FindingEntry[],
 * }} AgreementResult
 */

// ── Severity Ordering ────────────────────────────────

/** @type {Record<string, number>} */
const SEVERITY_RANK = Object.freeze({
    critical: 4,
    high: 3,
    medium: 2,
    low: 1,
    info: 0,
});

/** @param {string} confidence @returns {number} */
function confidenceWeight(confidence) {
    switch (confidence) {
        case 'certain':  return 1.0;
        case 'likely':   return 0.6;
        case 'inference': return 0.2;
        default:          return 0.5;
    }
}

/**
 * Map numeric confidence (0.0-1.0) to confidence enum.
 * @param {number} [numericConfidence]
 * @returns {'certain' | 'likely' | 'inference'}
 */
function toConfidenceLevel(numericConfidence) {
    if (numericConfidence == null) return 'likely';
    if (numericConfidence >= 0.8) return 'certain';
    if (numericConfidence >= 0.4) return 'likely';
    return 'inference';
}

/**
 * Compare two severities. Returns > 0 if a is more severe.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function compareSeverity(a, b) {
    return (SEVERITY_RANK[a] ?? 0) - (SEVERITY_RANK[b] ?? 0);
}

/**
 * Deduplicate raw findings so consensus operates on logical issues rather than
 * multiple agent submissions of the same dedupeKey.
 *
 * Keeps the highest-severity representative and preserves first-seen order
 * across unique dedupe keys.
 *
 * @param {FindingEntry[]} findings
 * @returns {FindingEntry[]}
 */
function normalizeFindings(findings) {
    /** @type {Map<string, { finding: FindingEntry, index: number }>} */
    const byDedupeKey = new Map();

    findings.forEach((finding, index) => {
        const existing = byDedupeKey.get(finding.dedupeKey);
        if (!existing) {
            byDedupeKey.set(finding.dedupeKey, { finding, index });
            return;
        }

        if (compareSeverity(finding.severity, existing.finding.severity) > 0) {
            byDedupeKey.set(finding.dedupeKey, { finding, index: existing.index });
        }
    });

    return [...byDedupeKey.values()]
        .sort((a, b) => a.index - b.index)
        .map((entry) => entry.finding);
}

// ── Consensus Engine ─────────────────────────────────

export class ConsensusEngine {
    /**
     * @param {{ threshold?: number }} [options]
     */
    constructor(options = {}) {
        /** @type {number} Agreement ratio needed for consensus (0.0 - 1.0) */
        this.threshold = options.threshold ?? 0.7;
    }

    /**
     * Calculate agreement ratio between agent evaluations for a set of findings.
     *
     * For each finding, checks if evaluating agents accepted or rejected it:
     * - All accept → agreed (confidence 1.0)
     * - All reject → dropped
     * - Mixed → disputed
     *
     * @param {FindingEntry[]} findings - All findings from all agents
     * @param {EvaluationEntry[]} evaluations - All cross-evaluations
     * @returns {AgreementResult}
     */
    calculateAgreement(findings, evaluations) {
        const uniqueFindings = normalizeFindings(findings);

        if (uniqueFindings.length === 0) {
            return { ratio: 1.0, agreed: [], disputed: [], dropped: [] };
        }

        /** @type {Map<string, EvaluationEntry[]>} dedupeKey → evaluations for that finding */
        const evalsByFinding = new Map();
        for (const ev of evaluations) {
            const existing = evalsByFinding.get(ev.dedupeKey) ?? [];
            existing.push(ev);
            evalsByFinding.set(ev.dedupeKey, existing);
        }

        /** @type {FindingEntry[]} */
        const agreed = [];
        /** @type {FindingEntry[]} */
        const disputed = [];
        /** @type {FindingEntry[]} */
        const dropped = [];

        for (const finding of uniqueFindings) {
            const evalsForThis = evalsByFinding.get(finding.dedupeKey) ?? [];

            if (evalsForThis.length === 0) {
                // No evaluations → auto-agree (finding is uncontested)
                agreed.push(finding);
                continue;
            }

            const accepted = evalsForThis.filter(e => e.verdict === 'accepted').length;
            const rejected = evalsForThis.filter(e => e.verdict === 'rejected').length;
            const total = evalsForThis.length;

            if (rejected === 0 && accepted > 0) {
                // All evaluators accepted
                agreed.push(finding);
            } else if (accepted === 0 && rejected > 0) {
                // All evaluators rejected
                dropped.push(finding);
            } else {
                // Mixed verdicts
                disputed.push(finding);
            }
        }

        const total = uniqueFindings.length;
        const consensusCount = agreed.length + dropped.length;
        const ratio = total > 0 ? consensusCount / total : 1.0;

        return { ratio, agreed, disputed, dropped };
    }

    /**
     * Check whether consensus has been reached.
     *
     * @param {number} agreementRatio - Result from calculateAgreement
     * @param {number} round - Current debate round
     * @returns {boolean}
     */
    hasConsensus(agreementRatio, round) {
        return agreementRatio >= this.threshold;
    }

    /**
     * Merge all findings into a final report, resolving disputes.
     *
     * Agreed findings pass through with confidence 1.0.
     * Disputed findings use severity resolution: higher severity wins.
     * Dropped findings are excluded.
     *
 * @param {FindingEntry[]} allFindings
 * @param {EvaluationEntry[]} evaluations
 * @param {{ decider?: string, policy?: 'strict'|'soft_union' }} [options]
 * @returns {MergedFinding[]}
 */
    mergeFinalFindings(allFindings, evaluations, options = {}) {
        const normalizedFindings = normalizeFindings(allFindings);
        const { agreed, disputed } = this.calculateAgreement(normalizedFindings, evaluations);
        const policy = options.policy ?? 'strict';

        /** @type {MergedFinding[]} */
        const merged = [];

        // Agreed findings → confidence 1.0
        for (const f of agreed) {
            const evalsForThis = evaluations.filter(e => e.dedupeKey === f.dedupeKey);
            merged.push({
                dedupeKey: f.dedupeKey,
                severity: f.severity,
                title: f.title,
                originalAgent: f.agentId,
                status: 'agreed',
                confidence: 1.0,
                originalConfidence: toConfidenceLevel(f.confidence),
                evaluations: evalsForThis,
            });
        }

        // Disputed findings → include with reduced confidence, decider breaks tie
        for (const f of disputed) {
            const evalsForThis = evaluations.filter(e => e.dedupeKey === f.dedupeKey);
            const accepted = evalsForThis.filter(e => e.verdict === 'accepted').length;
            const total = evalsForThis.length;
            const confidence = total > 0 ? accepted / total : 0.5;

            // Decider tie-break: if decider accepted → keep, if rejected → drop
            if (options.decider) {
                const deciderEval = evalsForThis.find(e => e.agentId === options.decider);
                if (deciderEval) {
                    if (deciderEval.verdict === 'rejected') {
                        if (policy === 'strict' || accepted === 0) {
                            // Strict mode treats decider rejection as final.
                            continue;
                        }
                    }
                }
            }

            merged.push({
                dedupeKey: f.dedupeKey,
                severity: f.severity,
                title: f.title,
                originalAgent: f.agentId,
                status: 'disputed',
                confidence,
                originalConfidence: toConfidenceLevel(f.confidence),
                evaluations: evalsForThis,
            });
        }

        // Sort: highest severity first, then earliest timestamp
        merged.sort((a, b) => {
            const sevDiff = compareSeverity(b.severity, a.severity);
            if (sevDiff !== 0) return sevDiff;
            // Same severity → keep original order (stable sort)
            return 0;
        });

        return merged;
    }
}

export { SEVERITY_RANK, compareSeverity };

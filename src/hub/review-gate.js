// @ts-check
/**
 * Review Gate — post-consensus validation before debate resolves.
 * Inspired by codex-plugin-cc Stop Hook mechanism.
 *
 * @module hub/review-gate
 */

/**
 * @typedef {{
 *   enabled: boolean,
 *   judge?: string,
 *   blockOnRegression?: boolean,
 *   maxSeverityToSkip?: string,
 *   confirmThreshold?: number,
 * }} GateConfig
 *
 * @typedef {'pending' | 'passed' | 'blocked'} GateState
 *
 * @typedef {{
 *   dedupeKey: string,
 *   severity: string,
 *   title: string,
 *   status: 'confirmed' | 'downgraded' | 'rejected',
 *   rationale: string,
 *   regression?: string|null,
 * }} GateVerdict
 *
 * @typedef {{
 *   gateState: GateState,
 *   gateConfig: GateConfig,
 *   verdicts: GateVerdict[],
 *   confirmedCount: number,
 *   totalCount: number,
 *   confirmedRatio: number,
 *   blockedReason?: string|null,
 * }} GateResult
 */

// ── Gate Prompt Builder ───────────────────────────────

/**
 * Build the prompt for the judge agent to validate findings.
 * @param {Array<{dedupeKey: string, severity: string, title: string, file?: string|null, line?: number|null, evidence?: string|null, why_it_matters?: string|null, fix_instructions?: string|null}>} agreedFindings
 * @param {{prompt?: string}} session
 * @returns {string}
 */
export function buildGatePrompt(agreedFindings, session) {
    const findingsJson = JSON.stringify(
        agreedFindings.map((f) => ({
            dedupeKey: f.dedupeKey,
            severity: f.severity,
            title: f.title,
            file: f.file ?? null,
            line: f.line ?? null,
            evidence: f.evidence ?? null,
            why_it_matters: f.why_it_matters ?? null,
            fix_instructions: f.fix_instructions ?? null,
        })),
        null,
        2,
    );

    return [
        'You are the REVIEW GATE — a quality checkpoint before a debate concludes.',
        'Your job: independently verify each agreed finding against the ACTUAL SOURCE CODE.',
        'Read the relevant files yourself. Do NOT trust the finding claims at face value.',
        '',
        'For EACH finding, determine:',
        '  - "confirmed": The issue is real and backed by current code evidence',
        '  - "downgraded": The issue exists but severity should be lower',
        '  - "rejected": False positive or the code has changed since the finding was filed',
        '',
        'IMPORTANT — bias guardrails:',
        '- Do NOT defer to the original reviewer. You are the independent auditor.',
        '- A finding with no concrete code evidence is a false positive — reject it.',
        '- If the finding references code that no longer exists or has been fixed, reject it.',
        '',
        'Also check for REGRESSION: did the code change in a way that INTRODUCES a new issue?',
        'If a regression is found, set regression: "<brief description of the regression>"',
        '',
        'Return a JSON array. Each entry must have:',
        '  - dedupeKey: copied exactly from input',
        '  - status: "confirmed" | "downgraded" | "rejected"',
        '  - rationale: your independent reasoning (2-3 sentences)',
        '  - regression: null or a brief string describing any new issue introduced',
        'Do not add new findings. Do not wrap in markdown fences.',
        '',
        '--- BEGIN ORIGINAL REVIEW PROMPT ---',
        session.prompt ?? '(not provided)',
        '--- END ORIGINAL REVIEW PROMPT ---',
        '',
        'Findings to verify:',
        findingsJson,
    ].join('\n');
}

// ── Gate Decision Logic ───────────────────────────────

/**
 * @param {GateVerdict[]} verdicts
 * @param {GateConfig} config
 * @returns {{ gateState: GateState, blockedReason: string|null }}
 */
export function computeGateDecision(verdicts, config) {
    const confirmThreshold = config.confirmThreshold ?? 0.7;
    const confirmedCount = verdicts.filter((v) => v.status === 'confirmed').length;
    const totalCount = verdicts.length;

    if (totalCount === 0) {
        return { gateState: 'passed', blockedReason: null };
    }

    const confirmedRatio = confirmedCount / totalCount;

    // Check for regression
    const regressions = verdicts.filter((v) => v.regression != null);
    if (config.blockOnRegression && regressions.length > 0) {
        return {
            gateState: 'blocked',
            blockedReason: `Regression detected: ${regressions.map((r) => r.regression).join('; ')}`,
        };
    }

    if (confirmedRatio >= confirmThreshold) {
        return { gateState: 'passed', blockedReason: null };
    }

    return {
        gateState: 'blocked',
        blockedReason: `Only ${confirmedCount}/${totalCount} findings confirmed (threshold: ${confirmThreshold})`,
    };
}

/**
 * Build final GateResult from verdicts and config.
 * @param {GateVerdict[]} verdicts
 * @param {GateConfig} config
 * @returns {GateResult}
 */
export function buildGateResult(verdicts, config) {
    const { gateState, blockedReason } = computeGateDecision(verdicts, config);
    const confirmedCount = verdicts.filter((v) => v.status === 'confirmed').length;

    return {
        gateState,
        gateConfig: config,
        verdicts,
        confirmedCount,
        totalCount: verdicts.length,
        confirmedRatio: verdicts.length > 0 ? confirmedCount / verdicts.length : 1.0,
        blockedReason,
    };
}

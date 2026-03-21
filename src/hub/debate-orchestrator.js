// @ts-check
/**
 * Debate Orchestrator — automated multi-round debate between AI agents.
 *
 * Split into two layers per F-4 finding:
 * - DebateReducer: pure logic, returns action descriptors
 * - DebateExecutor: effectful, drives adapters and session mutations
 *
 * @module hub/debate-orchestrator
 */

import { getAdapter, hasAdapter } from '../adapters/adapter-registry.js';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { groupFindings, mergeFindingsSmart } from './finding-aggregation.js';
import {
    isDebateTerminal,
    deriveNextDebateState,
} from './debate-state.js';
import { ConsensusEngine } from './consensus-engine.js';

// ── Per-Agent Timeout Profiles ───────────────────────

/** @type {Readonly<Record<string, { reviewTimeoutMs: number, evalTimeoutMs: number, rebuttalTimeoutMs: number }>>} */
export const DEBATE_AGENT_PROFILES = Object.freeze({
    codex: {
        reviewTimeoutMs: 360_000,
        evalTimeoutMs: 180_000,
        rebuttalTimeoutMs: 360_000,
    },
    'claude-code': {
        reviewTimeoutMs: 360_000,
        evalTimeoutMs: 60_000,
        rebuttalTimeoutMs: 360_000,
    },
});

/**
 * @typedef {'START_REVIEW' | 'START_CROSS_EVAL' | 'CHECK_CONSENSUS' | 'START_REBUTTAL' | 'TIE_BREAK' | 'RESOLVE' | 'FAIL'} ActionType
 *
 * @typedef {{
 *   type: ActionType,
 *   payload: Record<string, any>,
 * }} ActionDescriptor
 */

/**
 * @typedef {{
 *   dedupeKey: string,
 *   severity: string,
 *   title: string,
 *   agentId: string,
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
 */

/**
 * @param {import('../schema/events.js').Finding} finding
 * @param {string} agentId
 * @param {number} round
 * @returns {FindingEntry}
 */
function toFindingEntry(finding, agentId, round) {
    return {
        dedupeKey: finding.dedupe_key,
        severity: finding.severity,
        title: finding.summary,
        agentId,
        round,
        timestamp: new Date().toISOString(),
    };
}

/**
 * @param {Array<FindingEntry|import('../schema/events.js').Finding>} findings
 * @returns {string[]}
 */
function uniqueDedupeKeys(findings) {
    return [...new Set(findings.map((finding) => 'dedupeKey' in finding ? finding.dedupeKey : finding.dedupe_key))];
}

/**
 * @param {FindingEntry[]} disputed
 * @returns {string}
 */
function formatDisputedFindings(disputed) {
    if (disputed.length === 0) {
        return 'No disputed findings.';
    }

    return disputed.map((finding, index) => (
        `${index + 1}. [${finding.severity}] ${finding.title} (dedupeKey=${finding.dedupeKey})`
    )).join('\n');
}

/**
 * @param {import('./session.js').Session|{ prompt?: string, reviewOptions?: Record<string, any>|null }} session
 * @returns {{ reviewTarget: string, filePath: string|null, isFileReview: boolean, isPlanFile: boolean }}
 */
function getReviewScope(session) {
    const reviewTarget = String(session.reviewOptions?.review_target ?? 'uncommitted');
    const filePath = typeof session.reviewOptions?.file_path === 'string'
        ? session.reviewOptions.file_path
        : null;
    const isFileReview = reviewTarget === 'file' && Boolean(filePath);
    const normalizedFilePath = filePath?.toLowerCase() ?? '';
    const isPlanFile = isFileReview && (
        normalizedFilePath.endsWith('.md')
        || normalizedFilePath.includes('/plan')
        || normalizedFilePath.includes('\\plan')
        || normalizedFilePath.includes('phase-')
    );

    return {
        reviewTarget,
        filePath,
        isFileReview,
        isPlanFile,
    };
}

/**
 * @param {import('./session.js').Session|{ prompt?: string, reviewOptions?: Record<string, any>|null }} session
 * @returns {string[]}
 */
function buildScopeGuidance(session) {
    const scope = getReviewScope(session);
    if (scope.isFileReview && scope.filePath) {
        if (scope.isPlanFile) {
            return [
                `Primary review target: ${scope.filePath}`,
                'This is a document or implementation plan review, not a repository-wide bug sweep.',
                'Review the document itself for contradictions, missing guardrails, and implementation risks.',
                'Inspect neighboring files only if the plan explicitly depends on them.',
                `Target file content (${scope.filePath}) is the primary evidence source.`,
            ];
        }

        return [
            `Primary review target: ${scope.filePath}`,
            'This is a file-scoped review. Re-review the same target scope throughout the debate.',
            'Review the target code itself, not the debate process around it.',
            'Inspect directly referenced neighbors only when a disputed finding cannot be decided from the target file alone.',
            `Target file content (${scope.filePath}) is the primary evidence source.`,
        ];
    }

    return [
        'This is a broad-scope review of the provided codebase snapshot.',
        'Treat this as a repository-wide or multi-file review.',
        'Prioritize fewer, stronger findings over speculative edge cases.',
    ];
}

/**
 * @param {FindingEntry[]} disputed
 * @returns {string}
 */
function formatDisputedFindingsJson(disputed) {
    return JSON.stringify(
        disputed.map((finding) => ({
            dedupeKey: finding.dedupeKey,
            severity: finding.severity,
            title: finding.title,
            agentId: finding.agentId,
            file: 'file' in finding ? finding.file ?? null : null,
            line: 'line' in finding ? finding.line ?? null : null,
            evidence: 'evidence' in finding ? finding.evidence ?? null : null,
            why_it_matters: 'why_it_matters' in finding ? finding.why_it_matters ?? null : null,
            fix_instructions: 'fix_instructions' in finding ? finding.fix_instructions ?? null : null,
        })),
        null,
        2,
    );
}

const FILE_REVIEW_REBUTTAL_BATCH_SIZE = 1;
const BROAD_REVIEW_REBUTTAL_BATCH_SIZE = 2;

/**
 * @template T
 * @param {T[]} items
 * @param {number} batchSize
 * @returns {T[][]}
 */
function chunkItems(items, batchSize) {
    if (items.length <= batchSize) {
        return [items];
    }

    /** @type {T[][]} */
    const batches = [];
    for (let index = 0; index < items.length; index += batchSize) {
        batches.push(items.slice(index, index + batchSize));
    }
    return batches;
}

/**
 * @param {FindingEntry[]} disputed
 * @param {{ fileReview?: boolean }} [options]
 * @returns {FindingEntry[][]}
 */
function splitDisputedIntoBatches(disputed, options = {}) {
    if (disputed.length <= 1) {
        return [disputed];
    }

    if (options.fileReview) {
        return chunkItems(disputed, FILE_REVIEW_REBUTTAL_BATCH_SIZE);
    }

    /** @type {Map<string, FindingEntry[]>} */
    const byFile = new Map();
    for (const finding of disputed) {
        const bucket = finding.file ?? `__${finding.dedupeKey}`;
        const existing = byFile.get(bucket) ?? [];
        existing.push(finding);
        byFile.set(bucket, existing);
    }

    return [...byFile.values()]
        .flatMap((group) => chunkItems(group, BROAD_REVIEW_REBUTTAL_BATCH_SIZE));
}

/**
 * @param {import('./session.js').Session} session
 * @returns {string}
 */
export function buildInitialReviewPrompt(session) {
    return [
        'You are participating in a structured multi-agent code review debate.',
        ...buildScopeGuidance(session),
        'Ignore any stale review outputs, handoff artifacts, debate transcripts, or session history unless the prompt explicitly asks for them.',
        'This is not a review of debate artifacts or orchestration prompts.',
        'Use the normal review schema expected by your adapter.',
        '',
        'Original review prompt:',
        session.prompt,
    ].join('\n');
}

/**
 * @param {FindingEntry[]} disputed
 * @param {number} round
 * @param {import('./session.js').Session|{ prompt?: string, reviewOptions?: Record<string, any>|null }} [session]
 * @returns {string}
 */
export function buildRebuttalPrompt(disputed, round, session = {}) {
    return [
        `Debate round ${round}: reconsider only the disputed findings listed below.`,
        ...buildScopeGuidance(session),
        'Re-review the same target scope. Do not broaden this into a fresh repo audit.',
        'This is not a review of debate artifacts, prompts, or orchestration state.',
        'The disputed findings are already included below. Do not ask for them again.',
        'Return ONLY a JSON array containing the disputed issues you still believe are valid.',
        'If you keep a finding, copy the exact dedupeKey from the disputed findings JSON.',
        'If you now disagree with a disputed issue, omit it from your output.',
        '',
        'Original review prompt:',
        session.prompt ?? '(not provided)',
        '',
        'Disputed findings JSON (exact items to adjudicate):',
        formatDisputedFindingsJson(disputed),
    ].join('\n');
}

/**
 * @param {FindingEntry[]} disputed
 * @param {import('./session.js').Session|{ prompt?: string, reviewOptions?: Record<string, any>|null }} [session]
 * @returns {string}
 */
export function buildTieBreakPrompt(disputed, session = {}) {
    return [
        'You are the tie-break reviewer for disputed findings.',
        ...buildScopeGuidance(session),
        'Do not audit debate artifacts, prompts, or repository instructions.',
        'Return ONLY a JSON array containing the disputed issues that should survive final resolution.',
        'If you keep a finding, copy the exact dedupeKey from the disputed findings JSON.',
        '',
        'Original review prompt:',
        session.prompt ?? '(not provided)',
        '',
        'Disputed findings JSON (exact items to adjudicate):',
        formatDisputedFindingsJson(disputed),
    ].join('\n');
}

/**
 * @param {import('../schema/events.js').Finding[][]} findingGroups
 * @returns {import('../schema/events.js').Finding[]}
 */
function flattenFindings(findingGroups) {
    return findingGroups.flatMap((group) => group);
}

// ── DebateReducer (Pure) ─────────────────────────────

export class DebateReducer {
    /**
     * @param {{ maxRounds?: number, consensusThreshold?: number }} [options]
     */
    constructor(options = {}) {
        this.maxRounds = options.maxRounds ?? 3;
        this.consensusThreshold = options.consensusThreshold ?? 0.7;
        this.consensus = new ConsensusEngine({ threshold: this.consensusThreshold });
    }

    /**
     * @param {{
     *   debateState: string,
     *   debateRound: number,
     *   agents: string[],
     *   findings: FindingEntry[],
     *   evaluations: EvaluationEntry[],
     *   completedReviews: string[],
     *   completedEvals: string[],
     * }} context
     * @returns {ActionDescriptor}
     */
    getNextAction(context) {
        const { debateState, debateRound, agents, findings, evaluations, completedReviews, completedEvals } = context;

        switch (debateState) {
            case 'idle':
                return { type: 'START_REVIEW', payload: { agents } };

            case 'reviewing': {
                const allDone = agents.every((agent) => completedReviews.includes(agent));
                if (allDone) {
                    return { type: 'START_CROSS_EVAL', payload: { agents, findings } };
                }
                const pending = agents.filter((agent) => !completedReviews.includes(agent));
                return { type: 'START_REVIEW', payload: { agents: pending } };
            }

            case 'cross_eval': {
                const allDone = agents.every((agent) => completedEvals.includes(agent));
                if (allDone) {
                    return { type: 'CHECK_CONSENSUS', payload: { findings, evaluations } };
                }
                const pending = agents.filter((agent) => !completedEvals.includes(agent));
                return { type: 'START_CROSS_EVAL', payload: { agents: pending, findings } };
            }

            case 'consensus_check': {
                const agreement = this.consensus.calculateAgreement(findings, evaluations);
                if (this.consensus.hasConsensus(agreement.ratio, debateRound)) {
                    return { type: 'RESOLVE', payload: { agreement } };
                }
                if (debateRound >= this.maxRounds) {
                    return { type: 'TIE_BREAK', payload: { agreement } };
                }
                return { type: 'START_REBUTTAL', payload: { disputed: agreement.disputed } };
            }

            case 'debate_round':
                return { type: 'START_CROSS_EVAL', payload: { agents, findings } };

            case 'tie_break':
                return { type: 'RESOLVE', payload: { findings, evaluations, forceTieBreak: true } };

            case 'resolved':
            case 'failed':
                return { type: 'RESOLVE', payload: {} };

            default:
                return { type: 'FAIL', payload: { reason: `Unknown debate state: ${debateState}` } };
        }
    }

    /**
     * @param {ActionType} actionType
     * @param {{ success: boolean, [key: string]: any }} result
     * @returns {string}
     */
    getEventFromResult(actionType, result) {
        if (!result.success) return 'error';

        switch (actionType) {
            case 'START_REVIEW': return 'all_reviews_done';
            case 'START_CROSS_EVAL': return 'all_evals_done';
            case 'CHECK_CONSENSUS': return result.consensus ? 'consensus_reached' : (result.maxRoundsHit ? 'max_rounds' : 'no_consensus');
            case 'START_REBUTTAL': return 'rebuttals_done';
            case 'TIE_BREAK': return 'tie_broken';
            case 'RESOLVE': return 'consensus_reached';
            default: return 'error';
        }
    }
}

// ── DebateExecutor (Effectful) ───────────────────────

export class DebateExecutor {
    /**
     * @param {{
     *   session: import('./session.js').Session,
     *   adapterMap?: Record<string, any>,
     *   agentProfiles?: Record<string, { reviewTimeoutMs: number, evalTimeoutMs: number, rebuttalTimeoutMs: number }>,
     *   onSystemMessage?: (message: string) => void,
     *   onEvent?: (event: import('../schema/events.js').Event) => void,
     *   onCheckpoint?: () => void,
     * }} options
     */
    constructor(options) {
        this.session = options.session;
        this.adapterMap = options.adapterMap ?? {};
        this.agentProfiles = options.agentProfiles ?? DEBATE_AGENT_PROFILES;
        this.onSystemMessage = options.onSystemMessage ?? (() => {});
        this.onEvent = options.onEvent ?? (() => {});
        this.onCheckpoint = options.onCheckpoint ?? (() => {});
        this.reducer = new DebateReducer({
            maxRounds: this.session.debateMaxRounds ?? 3,
        });

        /** @type {FindingEntry[]} */
        this.findings = [];

        /** @type {EvaluationEntry[]} */
        this.evaluations = [];

        /** @type {string[]} */
        this.completedReviews = [];

        /** @type {string[]} */
        this.completedEvals = [];

        /** @type {Array<{ agentId: string, phase: string, startedAt: number, completedAt: number|null, timedOut: boolean }>} */
        this.timings = [];

        /** @type {Map<string, import('../schema/events.js').Finding[]>} */
        this.rawFindingsByAgent = new Map();

        /** @type {FindingEntry[]} */
        this.disputedFindings = [];

        /** @type {ReturnType<ConsensusEngine['calculateAgreement']>|null} */
        this.lastAgreement = null;

        /** @type {string|null} */
        this.fileScopedWorkspace = null;

        this.hasPrunedOldSandboxes = false;
    }

    /**
     * @param {{ agents: string[], maxRounds?: number, decider?: string, consensusThreshold?: number }} config
     * @returns {{ debateState: string, round: number, agents: string[], maxRounds: number }}
     */
    initDebate(config) {
        const { agents, maxRounds = 3, decider, consensusThreshold = 0.7 } = config;

        if (!agents || agents.length === 0 || agents.length > 2) {
            throw new Error(`Debate requires 1-2 agents, got ${agents?.length ?? 0}`);
        }

        if (agents.length === 2 && !decider) {
            throw new Error('Decider is required for 2-agent debates');
        }

        // Warn if decider is also a debating agent (tie-break won't be independent)
        if (decider && agents.includes(decider)) {
            console.warn(`[Debate] Warning: decider "${decider}" is also a debating agent — tie-break will not be independent`);
        }

        this.session.debateState = 'idle';
        this.session.debateRound = 0;
        this.session.debateMaxRounds = maxRounds;
        this.session.debateAgents = [...agents];
        this.session.debateActive = true;
        this.session.debateRoundEvals = {};
        this.session.debateTimings = [];

        if (decider && this.session.assignments) {
            this.session.assignments.decider = decider;
        }

        this.reducer = new DebateReducer({
            maxRounds,
            consensusThreshold,
        });

        this.onSystemMessage(`Debate initialized: agents=[${agents.join(', ')}], maxRounds=${maxRounds}, decider=${decider ?? 'N/A'}`);
        this.onCheckpoint();

        return {
            debateState: 'idle',
            round: 0,
            agents: [...agents],
            maxRounds,
        };
    }

    /**
     * @param {string} event
     * @returns {{ state: string, valid: boolean }}
     */
    transition(event) {
        const current = this.session.debateState;
        const result = deriveNextDebateState(current, event);

        if (result.valid) {
            this.session.debateState = result.state;

            if (result.state === 'debate_round') {
                this.session.debateRound = (this.session.debateRound ?? 0) + 1;
            }

            if (isDebateTerminal(result.state)) {
                this.session.debateActive = false;
            }

            this.onSystemMessage(`Debate transition: ${current} → ${result.state} (event: ${event})`);
            this.onCheckpoint();
        }

        return result;
    }

    /**
     * @param {string} agentId
     * @param {string} phase
     * @param {number} startedAt
     * @param {number|null} completedAt
     * @param {boolean} timedOut
     */
    recordTiming(agentId, phase, startedAt, completedAt, timedOut) {
        const entry = { agentId, phase, startedAt, completedAt, timedOut };
        this.timings.push(entry);
        this.session.debateTimings = [...this.timings];

        if (completedAt) {
            const durationSec = Math.round((completedAt - startedAt) / 1000);
            this.onSystemMessage(`${agentId} ${phase} completed in ${durationSec}s${timedOut ? ' (TIMEOUT)' : ''}`);
        }
    }

    /**
     * @returns {{
     *   debateState: string|null,
     *   debateRound: number,
     *   debateMaxRounds: number,
     *   debateAgents: string[]|null,
     *   debateActive: boolean,
     *   findingsCount: number,
     *   evaluationsCount: number,
     * }}
     */
    getDebateStatus() {
        return {
            debateState: this.session.debateState ?? null,
            debateRound: this.session.debateRound ?? 0,
            debateMaxRounds: this.session.debateMaxRounds ?? 3,
            debateAgents: this.session.debateAgents ?? null,
            debateActive: this.session.debateActive ?? false,
            findingsCount: this.findings.length,
            evaluationsCount: this.evaluations.length,
        };
    }

    /**
     * @param {string} agentId
     * @returns {any}
     */
    resolveAdapter(agentId) {
        return this.adapterMap[agentId] ?? getAdapter(agentId);
    }

    /**
     * @param {string} agentId
     * @param {'review'|'rebuttal'|'tie_break'} phase
     * @returns {{ firstByteMs: number, idleMs: number, hardMs: number }|undefined}
     */
    getPhaseTimeouts(agentId, phase) {
        const profile = this.agentProfiles[agentId];
        if (!profile) {
            return undefined;
        }

        const timeoutMs = phase === 'review'
            ? profile.reviewTimeoutMs
            : phase === 'rebuttal'
                ? profile.rebuttalTimeoutMs
                : profile.evalTimeoutMs;

        return {
            firstByteMs: timeoutMs,
            idleMs: timeoutMs,
            hardMs: timeoutMs,
        };
    }

    pruneStaleSandboxDirs() {
        if (this.hasPrunedOldSandboxes) {
            return;
        }
        this.hasPrunedOldSandboxes = true;

        const cutoffMs = Date.now() - (2 * 60 * 60 * 1000);
        try {
            const tempRoot = os.tmpdir();
            for (const entry of fs.readdirSync(tempRoot, { withFileTypes: true })) {
                if (!entry.isDirectory() || !entry.name.startsWith('extension-debate-file-')) {
                    continue;
                }

                const fullPath = path.join(tempRoot, entry.name);
                if (this.fileScopedWorkspace && path.resolve(fullPath) === path.resolve(this.fileScopedWorkspace)) {
                    continue;
                }

                try {
                    const stat = fs.statSync(fullPath);
                    if (stat.mtimeMs < cutoffMs) {
                        fs.rmSync(fullPath, { recursive: true, force: true });
                    }
                } catch {
                    // Ignore stale cleanup failures — temp artifacts are best-effort only.
                }
            }
        } catch {
            // Ignore tempdir enumeration failures.
        }
    }

    cleanupFileScopedWorkspace() {
        if (!this.fileScopedWorkspace) {
            return;
        }

        const workspacePath = this.fileScopedWorkspace;
        this.fileScopedWorkspace = null;
        try {
            fs.rmSync(workspacePath, { recursive: true, force: true });
        } catch {
            // Ignore cleanup failures — temp artifacts can be pruned next run.
        }
    }

    /**
     * @returns {string}
     */
    resolveExecutionPath(agentId) {
        const scope = getReviewScope(this.session);
        const basePath = this.session.snapshotPath ?? this.session.projectDir;
        if (!scope.isFileReview || !scope.filePath) {
            return basePath;
        }

        this.pruneStaleSandboxDirs();

        if (this.fileScopedWorkspace) {
            return this.fileScopedWorkspace;
        }

        try {
            const sourceRoot = basePath;
            const sourceFile = path.join(sourceRoot, scope.filePath);
            if (!fs.existsSync(sourceFile)) {
                return basePath;
            }

            const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'extension-debate-file-'));
            const relativeDir = path.dirname(scope.filePath);
            const targetDir = path.join(tempRoot, relativeDir);
            fs.mkdirSync(targetDir, { recursive: true });
            fs.copyFileSync(sourceFile, path.join(targetDir, path.basename(sourceFile)));

            // Codex CLI requires a git repository for sandboxed reviews.
            const gitInit = spawnSync('git', ['init'], {
                cwd: tempRoot,
                windowsHide: true,
                stdio: 'ignore',
            });
            if (gitInit.status !== 0) {
                return basePath;
            }

            this.fileScopedWorkspace = tempRoot;
            return tempRoot;
        } catch {
            return basePath;
        }
    }

    /**
     * @param {string[]} agentIds
     * @param {{ phase: 'review'|'rebuttal'|'tie_break', prompt: string, disputedKeys?: string[] }} options
     */
    async runReviewPass(agentIds, options) {
        const round = this.session.debateRound ?? 0;
        this.completedEvals = [];

        const results = await Promise.all(agentIds.map(async (agentId) => {
            const adapter = this.resolveAdapter(agentId);
            const executionPath = this.resolveExecutionPath(agentId);
            const startedAt = Date.now();
            const { stream, done } = adapter.execute(
                this.session.id,
                executionPath,
                options.prompt,
                { timeouts: this.getPhaseTimeouts(agentId, options.phase) },
            );

            for await (const event of stream) {
                this.onEvent(event);
            }

            const result = await done;
            const completedAt = Date.now();
            this.recordTiming(agentId, options.phase, startedAt, completedAt, result.status === 'timeout');

            if (result.status !== 'ok') {
                throw new Error(`${agentId} ${options.phase} failed with status "${result.status}"`);
            }

            return { agentId, findings: result.findings };
        }));

        for (const { agentId, findings } of results) {
            if (options.phase === 'rebuttal' && options.disputedKeys) {
                const retained = (this.rawFindingsByAgent.get(agentId) ?? [])
                    .filter((finding) => !options.disputedKeys.includes(finding.dedupe_key));
                const updated = findings.filter((finding) => options.disputedKeys.includes(finding.dedupe_key));
                this.rawFindingsByAgent.set(agentId, [...retained, ...updated]);
            } else {
                this.rawFindingsByAgent.set(agentId, findings);
            }

            this.completedReviews = [...new Set([...this.completedReviews, agentId])];
            this.onSystemMessage(`${agentId} produced ${(this.rawFindingsByAgent.get(agentId) ?? []).length} active findings in ${options.phase}.`);
        }

        this.rebuildFindingEntries();
    }

    rebuildFindingEntries() {
        const round = this.session.debateRound ?? 0;
        this.findings = [...this.rawFindingsByAgent.entries()]
            .flatMap(([agentId, findings]) => findings.map((finding) => toFindingEntry(finding, agentId, round)));
    }

    inferEvaluations() {
        const round = this.session.debateRound ?? 0;
        const agents = this.session.debateAgents ?? [];
        const currentByAgent = new Map(
            [...this.rawFindingsByAgent.entries()].map(([agentId, findings]) => [
                agentId,
                new Set(findings.map((finding) => finding.dedupe_key)),
            ]),
        );

        const dedupeKeys = uniqueDedupeKeys(this.findings);
        /** @type {EvaluationEntry[]} */
        const evaluations = [];

        for (const dedupeKey of dedupeKeys) {
            for (const agentId of agents) {
                const hasFinding = currentByAgent.get(agentId)?.has(dedupeKey) ?? false;
                evaluations.push({
                    dedupeKey,
                    verdict: hasFinding ? 'accepted' : 'rejected',
                    agentId,
                    round,
                    rationale: hasFinding
                        ? `Agent ${agentId} still reports this finding in round ${round}.`
                        : `Agent ${agentId} does not report this finding in round ${round}.`,
                });
            }
        }

        this.evaluations = evaluations;
        this.completedEvals = [...agents];
        this.session.debateRoundEvals[String(round)] = evaluations.reduce((acc, evaluation) => {
            const existing = acc[evaluation.dedupeKey] ?? [];
            existing.push(evaluation);
            acc[evaluation.dedupeKey] = existing;
            return acc;
        }, /** @type {Record<string, EvaluationEntry[]>} */ ({}));
    }

    /**
     * @param {FindingEntry[]} disputed
     */
    async runRebuttal(disputed) {
        this.disputedFindings = disputed;
        const scope = getReviewScope(this.session);
        const batches = splitDisputedIntoBatches(disputed, { fileReview: scope.isFileReview });

        for (const [index, batch] of batches.entries()) {
            const batchLabel = batches.length > 1
                ? `\n\nRebuttal batch ${index + 1} of ${batches.length}.`
                : '';
            await this.runReviewPass(this.session.debateAgents ?? [], {
                phase: 'rebuttal',
                prompt: `${buildRebuttalPrompt(batch, this.session.debateRound ?? 0, this.session)}${batchLabel}`,
                disputedKeys: batch.map((finding) => finding.dedupeKey),
            });
        }
    }

    /**
     * @returns {Promise<EvaluationEntry[]>}
     */
    async runTieBreakerIfNeeded() {
        const decider = this.session.assignments?.decider;
        if (!decider) {
            return [];
        }

        if ((this.session.debateAgents ?? []).includes(decider)) {
            return [];
        }

        if (!hasAdapter(decider) || this.disputedFindings.length === 0) {
            this.onSystemMessage(`Decider "${decider}" has no registered adapter. Falling back to confidence-based resolution.`);
            return [];
        }

        const adapter = this.resolveAdapter(decider);
        const startedAt = Date.now();
        const { stream, done } = adapter.execute(
            this.session.id,
            this.resolveExecutionPath(decider),
            buildTieBreakPrompt(this.disputedFindings, this.session),
            { timeouts: this.getPhaseTimeouts(decider, 'tie_break') },
        );

        for await (const event of stream) {
            this.onEvent(event);
        }

        const result = await done;
        const completedAt = Date.now();
        this.recordTiming(decider, 'tie_break', startedAt, completedAt, result.status === 'timeout');

        if (result.status !== 'ok') {
            this.onSystemMessage(`Decider "${decider}" tie-break failed with status "${result.status}". Falling back to confidence-based resolution.`);
            return [];
        }

        const acceptedKeys = new Set(result.findings.map((finding) => finding.dedupe_key));
        return this.disputedFindings.map((finding) => ({
            dedupeKey: finding.dedupeKey,
            verdict: acceptedKeys.has(finding.dedupeKey) ? 'accepted' : 'rejected',
            agentId: decider,
            round: this.session.debateRound ?? 0,
            rationale: `Tie-break review by ${decider}`,
        }));
    }

    /**
     * @param {import('../schema/events.js').Finding[]} findings
     */
    applyResolvedFindings(findings) {
        /** @type {Map<string, string>} */
        const findingAgentMap = new Map();

        for (const [agentId, agentFindings] of this.rawFindingsByAgent.entries()) {
            for (const finding of agentFindings) {
                if (findings.some((entry) => entry.id === finding.id)) {
                    findingAgentMap.set(finding.id, agentId);
                }
            }
        }

        this.session.allFindings = findings;
        this.session.groupedFindings = groupFindings(findings, findingAgentMap);
        const mergeResult = mergeFindingsSmart(findings, findingAgentMap);
        this.session.mergedFindings = mergeResult.merged;
        this.session.mergeStats = mergeResult.stats;
    }

    async resolveFinalFindings() {
        const engine = new ConsensusEngine({ threshold: this.reducer.consensusThreshold });
        const tieBreakEvaluations = this.session.debateState === 'tie_break'
            ? await this.runTieBreakerIfNeeded()
            : [];
        const evaluations = [...this.evaluations, ...tieBreakEvaluations];
        const authoritativeDecider = tieBreakEvaluations.length > 0
            ? this.session.assignments?.decider
            : undefined;
        const logical = engine.mergeFinalFindings(this.findings, evaluations, {
            decider: authoritativeDecider,
        });
        const keptKeys = new Set(logical.map((finding) => finding.dedupeKey));
        const finalFindings = flattenFindings([...this.rawFindingsByAgent.values()])
            .filter((finding) => keptKeys.has(finding.dedupe_key));

        this.applyResolvedFindings(finalFindings);
        this.onSystemMessage(`Debate resolved with ${logical.length} surviving finding(s).`);

        return {
            logicalFindings: logical,
            finalFindings,
            evaluations,
        };
    }

    /**
     * @param {{ agents: string[], maxRounds?: number, decider?: string, consensusThreshold?: number }} config
     */
    async run(config) {
        try {
            this.initDebate(config);
            this.transition('start');

            await this.runReviewPass(config.agents, {
                phase: 'review',
                prompt: buildInitialReviewPrompt(this.session),
            });

            this.transition('all_reviews_done');

            while (!isDebateTerminal(this.session.debateState ?? 'failed')) {
                const action = this.reducer.getNextAction({
                    debateState: this.session.debateState ?? 'failed',
                    debateRound: this.session.debateRound ?? 0,
                    agents: this.session.debateAgents ?? [],
                    findings: this.findings,
                    evaluations: this.evaluations,
                    completedReviews: this.completedReviews,
                    completedEvals: this.completedEvals,
                });

                switch (action.type) {
                    case 'START_CROSS_EVAL':
                        this.inferEvaluations();
                        this.transition('all_evals_done');
                        break;

                    case 'CHECK_CONSENSUS': {
                        const agreement = this.reducer.consensus.calculateAgreement(this.findings, this.evaluations);
                        this.lastAgreement = agreement;
                        this.disputedFindings = agreement.disputed;
                        if (this.reducer.consensus.hasConsensus(agreement.ratio, this.session.debateRound ?? 0)) {
                            const resolution = await this.resolveFinalFindings();
                            this.transition('consensus_reached');
                            return resolution;
                        }
                        if ((this.session.debateRound ?? 0) >= (this.session.debateMaxRounds ?? 3)) {
                            this.transition('max_rounds');
                            break;
                        }
                        this.transition('no_consensus');
                        await this.runRebuttal(agreement.disputed);
                        this.transition('rebuttals_done');
                        break;
                    }

                    case 'RESOLVE': {
                        const resolution = await this.resolveFinalFindings();
                        if (this.session.debateState === 'tie_break') {
                            this.transition('tie_broken');
                        } else if (this.session.debateState === 'consensus_check') {
                            this.transition('consensus_reached');
                        }
                        return resolution;
                    }

                    case 'TIE_BREAK':
                        this.transition('max_rounds');
                        break;

                    case 'START_REBUTTAL':
                        this.transition('no_consensus');
                        await this.runRebuttal(/** @type {FindingEntry[]} */ (action.payload.disputed ?? []));
                        this.transition('rebuttals_done');
                        break;

                    case 'FAIL':
                        this.transition('error');
                        throw new Error(String(action.payload.reason ?? 'Debate failed'));

                    case 'START_REVIEW':
                        throw new Error(`Unexpected action ${action.type} in executor loop`);

                    default:
                        throw new Error(`Unhandled action ${action.type}`);
                }
            }

            throw new Error(`Debate terminated unexpectedly in state "${this.session.debateState}"`);
        } finally {
            this.cleanupFileScopedWorkspace();
        }
    }
}

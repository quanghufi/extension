// @ts-check

import { v4 as uuidv4 } from 'uuid';
import { isSimilar } from '../utils/similarity.js';

const SEVERITY_RANK = { critical: 4, high: 3, medium: 2, low: 1 };
const DEFAULTS = {
    threshold: 0.7,
    lineTolerance: 3,
    severityStrategy: /** @type {'highest'} */ ('highest'),
};
const AGENT_PRIORITY = ['semgrep', 'codex', 'eslint', 'claude', 'mcp-codex'];

export class MergeEngine {
    /** @param {MergeOptions} [options] */
    constructor(options = {}) {
        this.threshold = options.threshold ?? DEFAULTS.threshold;
        this.lineTolerance = options.lineTolerance ?? DEFAULTS.lineTolerance;
        this.severityStrategy = options.severityStrategy ?? DEFAULTS.severityStrategy;
    }

    /**
     * @param {import('../schema/events.js').Finding[]} findings
     * @param {Map<string, string>} [findingAgentMap]
     * @returns {MergeResult}
     */
    merge(findings, findingAgentMap) {
        const agentMap = findingAgentMap ?? new Map();
        if (!findings || findings.length === 0) {
            return { merged: [], stats: { total: 0, merged: 0, unique: 0, conflicts: 0 } };
        }

        /** @type {{ representative: import('../schema/events.js').Finding, sources: import('../schema/events.js').Finding[], agents: string[], confidence: number }[]} */
        const groups = [];
        let mergedCount = 0;
        let conflicts = 0;

        for (const finding of findings) {
            const agentId = agentMap.get(finding.id) ?? null;
            let matched = false;

            for (const group of groups) {
                const matchResult = this._tryMatch(finding, group.representative);
                if (!matchResult.matched) {
                    continue;
                }

                group.sources.push(finding);
                appendAgent(group.agents, agentId);
                group.confidence = Math.min(group.confidence, matchResult.confidence);

                if (finding.severity !== group.representative.severity) {
                    conflicts++;
                }

                group.representative = this._resolveRepresentative(group.sources, agentMap, group.agents);
                if (finding.summary.length > group.representative.summary.length) {
                    group.representative = { ...group.representative, summary: finding.summary };
                }

                mergedCount++;
                matched = true;
                break;
            }

            if (!matched) {
                groups.push({
                    representative: finding,
                    sources: [finding],
                    agents: agentId ? [agentId] : [],
                    confidence: 1,
                });
            }
        }

        return {
            merged: groups.map((group) => this._buildMergedFinding(group, agentMap)),
            stats: { total: findings.length, merged: mergedCount, unique: groups.length, conflicts },
        };
    }

    /**
     * @param {import('../schema/events.js').Finding} finding
     * @param {import('../schema/events.js').Finding} representative
     * @returns {{ matched: boolean, confidence: number }}
     */
    _tryMatch(finding, representative) {
        if (finding.dedupe_key === representative.dedupe_key) {
            return { matched: true, confidence: 1 };
        }
        if (finding.file !== representative.file) {
            return { matched: false, confidence: 0 };
        }
        if (!this._linesClose(finding.line, representative.line)) {
            return { matched: false, confidence: 0 };
        }

        const { similar, score } = isSimilar(finding.summary, representative.summary, this.threshold);
        return { matched: similar, confidence: score };
    }

    /** @param {number|null} lineA @param {number|null} lineB */
    _linesClose(lineA, lineB) {
        if (lineA === null || lineB === null) return true;
        return Math.abs(lineA - lineB) <= this.lineTolerance;
    }

    /**
     * @param {import('../schema/events.js').Finding[]} sources
     * @param {Map<string, string>} agentMap
     * @param {string[]} agents
     */
    _resolveRepresentative(sources, agentMap, agents) {
        return sources.reduce((winner, current) => {
            const winnerRank = SEVERITY_RANK[winner.severity] ?? 0;
            const currentRank = SEVERITY_RANK[current.severity] ?? 0;
            if (currentRank > winnerRank) return current;
            if (currentRank < winnerRank) return winner;

            const winnerAgent = agentMap.get(winner.id) ?? null;
            const currentAgent = agentMap.get(current.id) ?? null;
            if (compareAgentPriority(currentAgent, winnerAgent) < 0) return current;
            if (compareAgentPriority(currentAgent, winnerAgent) > 0) return winner;
            if (current.summary.length > winner.summary.length) return current;
            return winner;
        });
    }

    /**
     * @param {{ representative: import('../schema/events.js').Finding, sources: import('../schema/events.js').Finding[], agents: string[], confidence: number }} group
     * @param {Map<string, string>} agentMap
     * @returns {MergedFinding}
     */
    _buildMergedFinding(group, agentMap) {
        const why_it_matters = pickBestFindingText(group.sources, agentMap, 'why_it_matters');
        const fix_instructions = pickBestFindingText(group.sources, agentMap, 'fix_instructions');
        const evidence = pickBestFindingText(group.sources, agentMap, 'evidence');

        return {
            id: `M-${uuidv4().slice(0, 8).toUpperCase()}`,
            file: group.representative.file,
            line: group.representative.line,
            severity: group.representative.severity,
            summary: group.representative.summary,
            agents: [...group.agents].sort(compareAgentPriority),
            sources: group.sources,
            confidence: group.sources.length === 1 ? 1 : group.confidence,
            dedupe_key: group.representative.dedupe_key,
            evidence,
            why_it_matters,
            fix_instructions,
        };
    }
}

function appendAgent(agents, agentId) {
    if (!agentId || agents.includes(agentId)) return;
    agents.push(agentId);
}

function compareAgentPriority(left, right) {
    return agentPriority(left) - agentPriority(right);
}

function agentPriority(agentId) {
    if (!agentId) return Number.MAX_SAFE_INTEGER;
    const index = AGENT_PRIORITY.indexOf(agentId);
    return index === -1 ? AGENT_PRIORITY.length + 1 : index;
}

/**
 * Prefer actionable, non-empty text from the highest-priority source.
 * When priority ties, keep the longer explanation.
 *
 * @param {import('../schema/events.js').Finding[]} findings
 * @param {Map<string, string>} agentMap
 * @param {'evidence'|'why_it_matters'|'fix_instructions'} field
 * @returns {string|null}
 */
function pickBestFindingText(findings, agentMap, field) {
    let best = null;

    for (const finding of findings) {
        const value = typeof finding[field] === 'string' ? finding[field].trim() : '';
        if (!value) {
            continue;
        }

        if (!best) {
            best = finding;
            continue;
        }

        const bestPriority = agentPriority(agentMap.get(best.id) ?? null);
        const currentPriority = agentPriority(agentMap.get(finding.id) ?? null);
        if (currentPriority < bestPriority) {
            best = finding;
            continue;
        }
        if (currentPriority === bestPriority && value.length > String(best[field] ?? '').trim().length) {
            best = finding;
        }
    }

    if (!best) {
        return null;
    }

    return String(best[field] ?? '').trim() || null;
}

/**
 * @typedef {Object} MergeOptions
 * @property {number} [threshold]
 * @property {number} [lineTolerance]
 * @property {'highest'} [severityStrategy]
 *
 * @typedef {Object} MergedFinding
 * @property {string} id
 * @property {string} file
 * @property {number|null} line
 * @property {string} severity
 * @property {string} summary
 * @property {string[]} agents
 * @property {import('../schema/events.js').Finding[]} sources
 * @property {number} confidence
 * @property {string} dedupe_key
 * @property {string|null} evidence
 * @property {string|null} why_it_matters
 * @property {string|null} fix_instructions
 *
 * @typedef {Object} MergeStats
 * @property {number} total
 * @property {number} merged
 * @property {number} unique
 * @property {number} conflicts
 *
 * @typedef {{ merged: MergedFinding[], stats: MergeStats }} MergeResult
 */

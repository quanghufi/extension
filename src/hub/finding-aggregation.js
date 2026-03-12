// @ts-check

import { MergeEngine } from './merge.js';

const SEVERITY_RANK = { critical: 4, high: 3, medium: 2, low: 1 };

/**
 * @param {import('../schema/events.js').Finding} finding
 * @returns {string}
 */
function findingFingerprint(finding) {
    return JSON.stringify({
        dedupe_key: finding.dedupe_key,
        file: finding.file,
        line: finding.line,
        summary: finding.summary,
    });
}

/**
 * Build a stable finding→agent map from finding events.
 * Prefers exact fingerprint matches, then falls back to dedupe_key order.
 *
 * @param {import('../schema/events.js').Event[]} events
 * @param {import('../schema/events.js').Finding[]} findings
 * @returns {Map<string, string>}
 */
export function buildFindingAgentMap(events, findings) {
    const entries = events
        .filter((event) => event.event_type === 'finding' && event.agent_id && event.payload?.raw)
        .map((event) => ({
            agentId: event.agent_id,
            dedupeKey: event.payload.raw.dedupe_key,
            fingerprint: findingFingerprint(event.payload.raw),
            consumed: false,
        }));

    /** @type {Map<string, string>} */
    const findingAgentMap = new Map();

    for (const finding of findings) {
        const fingerprint = findingFingerprint(finding);

        let match = entries.find((entry) => !entry.consumed && entry.fingerprint === fingerprint);
        if (!match) {
            match = entries.find((entry) => !entry.consumed && entry.dedupeKey === finding.dedupe_key);
        }

        if (!match) continue;
        match.consumed = true;
        findingAgentMap.set(finding.id, match.agentId);
    }

    return findingAgentMap;
}

/**
 * Group findings by dedupe_key across agents.
 *
 * @param {import('../schema/events.js').Finding[]} findings
 * @param {Map<string, string>} findingAgentMap
 * @returns {import('../schema/events.js').GroupedFinding[]}
 */
export function groupFindings(findings, findingAgentMap) {
    /** @type {Map<string, import('../schema/events.js').GroupedFinding>} */
    const groups = new Map();

    for (const finding of findings) {
        const key = finding.dedupe_key;
        const agentId = findingAgentMap.get(finding.id) ?? null;

        if (groups.has(key)) {
            const group = /** @type {import('../schema/events.js').GroupedFinding} */ (groups.get(key));
            if (agentId && !group.agents.includes(agentId)) {
                group.agents.push(agentId);
            }
            group.raw_findings.push(finding);
            if ((SEVERITY_RANK[finding.severity] ?? 0) > (SEVERITY_RANK[group.finding.severity] ?? 0)) {
                group.finding = finding;
            }
            continue;
        }

        groups.set(key, {
            dedupe_key: key,
            finding,
            agents: agentId ? [agentId] : [],
            raw_findings: [finding],
        });
    }

    return Array.from(groups.values());
}

/**
 * @param {import('../schema/events.js').Finding[]} findings
 * @param {Map<string, string>} findingAgentMap
 * @returns {{ merged: import('./merge.js').MergedFinding[], stats: import('./merge.js').MergeStats }}
 */
export function mergeFindingsSmart(findings, findingAgentMap) {
    if (findings.length === 0) {
        return {
            merged: [],
            stats: { total: 0, merged: 0, unique: 0, conflicts: 0 },
        };
    }

    const engine = new MergeEngine();
    return engine.merge(findings, findingAgentMap);
}

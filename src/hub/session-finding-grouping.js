// @ts-check

/**
 * @param {import('../schema/events.js').Finding[]} findings
 * @param {import('../schema/events.js').Event[]} events
 * @returns {import('../schema/events.js').GroupedFinding[]}
 */
export function groupFindings(findings, events) {
    /** @type {Map<string, import('../schema/events.js').GroupedFinding>} */
    const groups = new Map();

    for (const finding of findings) {
        const key = finding.dedupe_key;
        if (groups.has(key)) {
            const group = /** @type {import('../schema/events.js').GroupedFinding} */ (groups.get(key));
            const agentFromEvent = findAgentForFinding(finding, events);
            if (agentFromEvent && !group.agents.includes(agentFromEvent)) {
                group.agents.push(agentFromEvent);
            }
            group.raw_findings.push(finding);
            if (severityRank(finding.severity) > severityRank(group.finding.severity)) {
                group.finding = finding;
            }
        } else {
            const agent = findAgentForFinding(finding, events);
            groups.set(key, {
                dedupe_key: key,
                finding,
                agents: agent ? [agent] : [],
                raw_findings: [finding],
            });
        }
    }

    return Array.from(groups.values());
}

/**
 * @param {import('../schema/events.js').Finding} finding
 * @param {import('../schema/events.js').Event[]} events
 * @returns {string|null}
 */
export function findAgentForFinding(finding, events) {
    for (const event of events) {
        if (event.event_type === 'finding' && event.payload?.raw?.dedupe_key === finding.dedupe_key) {
            return event.agent_id;
        }
    }

    for (const event of events) {
        if (event.event_type === 'finding' && event.agent_id) {
            const raw = event.payload?.raw;
            if (raw && (raw.file === finding.file || raw.path === finding.file)
                && (raw.summary === finding.summary || raw.message === finding.summary)) {
                return event.agent_id;
            }
        }
    }

    return null;
}

/**
 * @param {string} severity
 * @returns {number}
 */
export function severityRank(severity) {
    const ranks = { critical: 4, high: 3, medium: 2, low: 1 };
    return ranks[/** @type {keyof typeof ranks} */ (severity)] ?? 0;
}

// @ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ConsensusEngine, SEVERITY_RANK, compareSeverity } from './consensus-engine.js';

describe('consensus-engine', () => {

    // ── Constants ────────────────────────────────────

    describe('SEVERITY_RANK', () => {
        it('ranks critical > high > medium > low > info', () => {
            assert.ok(SEVERITY_RANK.critical > SEVERITY_RANK.high);
            assert.ok(SEVERITY_RANK.high > SEVERITY_RANK.medium);
            assert.ok(SEVERITY_RANK.medium > SEVERITY_RANK.low);
            assert.ok(SEVERITY_RANK.low > SEVERITY_RANK.info);
        });
    });

    describe('compareSeverity', () => {
        it('critical > medium → positive', () => {
            assert.ok(compareSeverity('critical', 'medium') > 0);
        });

        it('low < high → negative', () => {
            assert.ok(compareSeverity('low', 'high') < 0);
        });

        it('same severity → 0', () => {
            assert.equal(compareSeverity('high', 'high'), 0);
        });

        it('unknown severity → treated as 0', () => {
            assert.equal(compareSeverity('unknown', 'info'), 0);
        });
    });

    // ── calculateAgreement ──────────────────────────

    describe('calculateAgreement', () => {
        const engine = new ConsensusEngine();

        it('empty findings → ratio 1.0', () => {
            const result = engine.calculateAgreement([], []);
            assert.equal(result.ratio, 1.0);
            assert.equal(result.agreed.length, 0);
            assert.equal(result.disputed.length, 0);
            assert.equal(result.dropped.length, 0);
        });

        it('findings with no evaluations → all agreed (uncontested)', () => {
            const findings = [
                { dedupeKey: 'f1', severity: 'high', title: 'Bug 1', agentId: 'codex' },
                { dedupeKey: 'f2', severity: 'medium', title: 'Bug 2', agentId: 'codex' },
            ];
            const result = engine.calculateAgreement(findings, []);
            assert.equal(result.ratio, 1.0);
            assert.equal(result.agreed.length, 2);
            assert.equal(result.disputed.length, 0);
            assert.equal(result.dropped.length, 0);
        });

        it('all evaluators accept → agreed, ratio 1.0', () => {
            const findings = [
                { dedupeKey: 'f1', severity: 'high', title: 'Bug', agentId: 'codex' },
            ];
            const evaluations = [
                { dedupeKey: 'f1', verdict: 'accepted', agentId: 'claude-code' },
            ];
            const result = engine.calculateAgreement(findings, evaluations);
            assert.equal(result.ratio, 1.0);
            assert.equal(result.agreed.length, 1);
        });

        it('all evaluators reject → dropped, ratio 1.0 (rejection is consensus)', () => {
            const findings = [
                { dedupeKey: 'f1', severity: 'low', title: 'False positive', agentId: 'codex' },
            ];
            const evaluations = [
                { dedupeKey: 'f1', verdict: 'rejected', agentId: 'claude-code' },
            ];
            const result = engine.calculateAgreement(findings, evaluations);
            assert.equal(result.ratio, 1.0);
            assert.equal(result.dropped.length, 1);
            assert.equal(result.agreed.length, 0);
        });

        it('mixed verdicts → disputed', () => {
            const findings = [
                { dedupeKey: 'f1', severity: 'medium', title: 'Maybe bug', agentId: 'codex' },
            ];
            const evaluations = [
                { dedupeKey: 'f1', verdict: 'accepted', agentId: 'claude-code' },
                { dedupeKey: 'f1', verdict: 'rejected', agentId: 'codex-run2' },
            ];
            const result = engine.calculateAgreement(findings, evaluations);
            assert.equal(result.disputed.length, 1);
            assert.ok(result.ratio < 1.0);
        });

        it('multiple findings → correct ratio', () => {
            const findings = [
                { dedupeKey: 'f1', severity: 'high', title: 'A', agentId: 'codex' },
                { dedupeKey: 'f2', severity: 'medium', title: 'B', agentId: 'codex' },
                { dedupeKey: 'f3', severity: 'low', title: 'C', agentId: 'claude-code' },
            ];
            const evaluations = [
                { dedupeKey: 'f1', verdict: 'accepted', agentId: 'claude-code' },  // agreed
                { dedupeKey: 'f2', verdict: 'rejected', agentId: 'claude-code' },  // dropped
                { dedupeKey: 'f3', verdict: 'accepted', agentId: 'codex' },        // agreed
            ];
            const result = engine.calculateAgreement(findings, evaluations);
            assert.equal(result.agreed.length, 2);
            assert.equal(result.dropped.length, 1);
            assert.equal(result.disputed.length, 0);
            // ratio = (2 agreed + 1 dropped) / 3 = 1.0
            assert.equal(result.ratio, 1.0);
        });

        it('single agent → all uncontested (trivial consensus)', () => {
            const findings = [
                { dedupeKey: 'f1', severity: 'high', title: 'Solo', agentId: 'codex' },
            ];
            const result = engine.calculateAgreement(findings, []);
            assert.equal(result.ratio, 1.0);
            assert.equal(result.agreed.length, 1);
        });

        it('deduplicates findings by dedupeKey before calculating agreement', () => {
            const findings = [
                { dedupeKey: 'f1', severity: 'high', title: 'Shared bug', agentId: 'codex' },
                { dedupeKey: 'f1', severity: 'medium', title: 'Shared bug', agentId: 'claude-code' },
                { dedupeKey: 'f2', severity: 'low', title: 'Another bug', agentId: 'codex' },
            ];
            const evaluations = [
                { dedupeKey: 'f1', verdict: 'accepted', agentId: 'antigravity' },
                { dedupeKey: 'f2', verdict: 'rejected', agentId: 'antigravity' },
            ];

            const result = engine.calculateAgreement(findings, evaluations);

            assert.equal(result.agreed.length, 1);
            assert.equal(result.agreed[0].dedupeKey, 'f1');
            assert.equal(result.dropped.length, 1);
            assert.equal(result.dropped[0].dedupeKey, 'f2');
            assert.equal(result.ratio, 1.0);
        });

        it('counts dropped findings as consensus (not just agreed)', () => {
            const engine = new ConsensusEngine({ threshold: 0.7 });

            // 3 findings: 1 agreed, 1 dropped (both reject), 1 disputed
            const findings = [
                { dedupeKey: 'f1', severity: 'high', title: 'Real bug', agentId: 'codex' },
                { dedupeKey: 'f2', severity: 'low', title: 'False positive', agentId: 'codex' },
                { dedupeKey: 'f3', severity: 'medium', title: 'Debatable', agentId: 'codex' },
            ];
            const evaluations = [
                { dedupeKey: 'f1', verdict: 'accepted', agentId: 'claude-code' },
                { dedupeKey: 'f2', verdict: 'rejected', agentId: 'claude-code' },
                { dedupeKey: 'f2', verdict: 'rejected', agentId: 'codex' },
                { dedupeKey: 'f3', verdict: 'accepted', agentId: 'codex' },
                { dedupeKey: 'f3', verdict: 'rejected', agentId: 'claude-code' },
            ];

            const result = engine.calculateAgreement(findings, evaluations);

            assert.equal(result.agreed.length, 1);
            assert.equal(result.dropped.length, 1);
            assert.equal(result.disputed.length, 1);

            const expected = 2 / 3;
            assert.ok(Math.abs(result.ratio - expected) < 0.01,
                `Expected ratio ~${expected.toFixed(3)} but got ${result.ratio.toFixed(3)}`);
        });

        it('returns ratio 1.0 when all findings are dropped (full rejection consensus)', () => {
            const engine = new ConsensusEngine({ threshold: 0.7 });

            const findings = [
                { dedupeKey: 'f1', severity: 'low', title: 'FP1', agentId: 'codex' },
                { dedupeKey: 'f2', severity: 'low', title: 'FP2', agentId: 'codex' },
            ];
            const evaluations = [
                { dedupeKey: 'f1', verdict: 'rejected', agentId: 'claude-code' },
                { dedupeKey: 'f1', verdict: 'rejected', agentId: 'codex' },
                { dedupeKey: 'f2', verdict: 'rejected', agentId: 'claude-code' },
                { dedupeKey: 'f2', verdict: 'rejected', agentId: 'codex' },
            ];

            const result = engine.calculateAgreement(findings, evaluations);
            assert.equal(result.ratio, 1.0);
            assert.equal(result.agreed.length, 0);
            assert.equal(result.dropped.length, 2);
            assert.equal(result.disputed.length, 0);
        });
    });

    // ── hasConsensus ─────────────────────────────────

    describe('hasConsensus', () => {
        it('ratio >= threshold → true', () => {
            const engine = new ConsensusEngine({ threshold: 0.7 });
            assert.equal(engine.hasConsensus(0.8, 1), true);
            assert.equal(engine.hasConsensus(0.7, 1), true);
            assert.equal(engine.hasConsensus(1.0, 0), true);
        });

        it('ratio < threshold → false', () => {
            const engine = new ConsensusEngine({ threshold: 0.7 });
            assert.equal(engine.hasConsensus(0.5, 1), false);
            assert.equal(engine.hasConsensus(0.0, 0), false);
            assert.equal(engine.hasConsensus(0.69, 1), false);
        });

        it('custom threshold works', () => {
            const strict = new ConsensusEngine({ threshold: 1.0 });
            assert.equal(strict.hasConsensus(0.99, 1), false);
            assert.equal(strict.hasConsensus(1.0, 1), true);
        });

        it('default threshold is 0.7', () => {
            const engine = new ConsensusEngine();
            assert.equal(engine.threshold, 0.7);
        });
    });

    // ── mergeFinalFindings ───────────────────────────

    describe('mergeFinalFindings', () => {
        const engine = new ConsensusEngine();

        it('empty findings → empty output', () => {
            const result = engine.mergeFinalFindings([], []);
            assert.equal(result.length, 0);
        });

        it('agreed findings have confidence 1.0', () => {
            const findings = [
                { dedupeKey: 'f1', severity: 'high', title: 'Real bug', agentId: 'codex' },
            ];
            const evals = [
                { dedupeKey: 'f1', verdict: 'accepted', agentId: 'claude-code' },
            ];
            const merged = engine.mergeFinalFindings(findings, evals);
            assert.equal(merged.length, 1);
            assert.equal(merged[0].status, 'agreed');
            assert.equal(merged[0].confidence, 1.0);
        });

        it('dropped findings are excluded', () => {
            const findings = [
                { dedupeKey: 'f1', severity: 'low', title: 'FP', agentId: 'codex' },
            ];
            const evals = [
                { dedupeKey: 'f1', verdict: 'rejected', agentId: 'claude-code' },
            ];
            const merged = engine.mergeFinalFindings(findings, evals);
            assert.equal(merged.length, 0);
        });

        it('disputed findings included with reduced confidence', () => {
            const findings = [
                { dedupeKey: 'f1', severity: 'medium', title: 'Debatable', agentId: 'codex' },
            ];
            const evals = [
                { dedupeKey: 'f1', verdict: 'accepted', agentId: 'agent-a' },
                { dedupeKey: 'f1', verdict: 'rejected', agentId: 'agent-b' },
            ];
            const merged = engine.mergeFinalFindings(findings, evals);
            assert.equal(merged.length, 1);
            assert.equal(merged[0].status, 'disputed');
            assert.equal(merged[0].confidence, 0.5);
        });

        it('decider rejection drops disputed finding', () => {
            const findings = [
                { dedupeKey: 'f1', severity: 'medium', title: 'Debatable', agentId: 'codex' },
            ];
            const evals = [
                { dedupeKey: 'f1', verdict: 'accepted', agentId: 'codex' },
                { dedupeKey: 'f1', verdict: 'rejected', agentId: 'antigravity' },
            ];
            const merged = engine.mergeFinalFindings(findings, evals, { decider: 'antigravity' });
            assert.equal(merged.length, 0); // decider rejected → dropped
        });

        it('soft_union keeps disputed finding even when decider rejects it', () => {
            const findings = [
                { dedupeKey: 'f1', severity: 'medium', title: 'Debatable', agentId: 'codex' },
            ];
            const evals = [
                { dedupeKey: 'f1', verdict: 'accepted', agentId: 'codex' },
                { dedupeKey: 'f1', verdict: 'rejected', agentId: 'antigravity' },
            ];

            const merged = engine.mergeFinalFindings(findings, evals, {
                decider: 'antigravity',
                policy: 'soft_union',
            });

            assert.equal(merged.length, 1);
            assert.equal(merged[0].status, 'disputed');
            assert.equal(merged[0].confidence, 0.5);
        });

        it('sorts by severity (highest first)', () => {
            const findings = [
                { dedupeKey: 'f1', severity: 'low', title: 'Low', agentId: 'codex' },
                { dedupeKey: 'f2', severity: 'critical', title: 'Critical', agentId: 'codex' },
                { dedupeKey: 'f3', severity: 'high', title: 'High', agentId: 'codex' },
            ];
            const merged = engine.mergeFinalFindings(findings, []);
            assert.equal(merged[0].severity, 'critical');
            assert.equal(merged[1].severity, 'high');
            assert.equal(merged[2].severity, 'low');
        });

        it('merges duplicate dedupeKey findings into a single final finding', () => {
            const findings = [
                { dedupeKey: 'f1', severity: 'medium', title: 'Shared issue', agentId: 'codex' },
                { dedupeKey: 'f1', severity: 'high', title: 'Shared issue', agentId: 'claude-code' },
            ];
            const evals = [
                { dedupeKey: 'f1', verdict: 'accepted', agentId: 'antigravity' },
            ];

            const merged = engine.mergeFinalFindings(findings, evals);

            assert.equal(merged.length, 1);
            assert.equal(merged[0].dedupeKey, 'f1');
            assert.equal(merged[0].severity, 'high');
            assert.equal(merged[0].status, 'agreed');
        });
    });
});

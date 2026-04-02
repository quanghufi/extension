import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
    computeGateDecision,
    buildGateResult,
} from './review-gate.js';

describe('computeGateDecision', () => {
    it('passes with no findings', () => {
        const result = computeGateDecision([], { enabled: true });
        assert.equal(result.gateState, 'passed');
    });

    it('passes when confirmed ratio >= threshold', () => {
        const verdicts = [
            { dedupeKey: 'a', severity: 'high', title: 'A', status: 'confirmed', rationale: 'ok' },
            { dedupeKey: 'b', severity: 'high', title: 'B', status: 'confirmed', rationale: 'ok' },
            { dedupeKey: 'c', severity: 'high', title: 'C', status: 'rejected', rationale: 'fp' },
        ];
        const result = computeGateDecision(verdicts, { enabled: true, confirmThreshold: 0.66 });
        assert.equal(result.gateState, 'passed');
    });

    it('blocks when confirmed ratio < threshold', () => {
        const verdicts = [
            { dedupeKey: 'a', severity: 'high', title: 'A', status: 'confirmed', rationale: 'ok' },
            { dedupeKey: 'b', severity: 'high', title: 'B', status: 'rejected', rationale: 'fp' },
            { dedupeKey: 'c', severity: 'high', title: 'C', status: 'rejected', rationale: 'fp' },
        ];
        const result = computeGateDecision(verdicts, { enabled: true, confirmThreshold: 0.7 });
        assert.equal(result.gateState, 'blocked');
        assert.match(result.blockedReason, /1\/3/);
    });

    it('blocks on regression when blockOnRegression is true', () => {
        const verdicts = [
            { dedupeKey: 'a', severity: 'high', title: 'A', status: 'confirmed', rationale: 'ok', regression: 'race condition introduced' },
        ];
        const result = computeGateDecision(verdicts, { enabled: true, blockOnRegression: true });
        assert.equal(result.gateState, 'blocked');
        assert.match(result.blockedReason, /regression/i);
    });

    it('passes on regression when blockOnRegression is false', () => {
        const verdicts = [
            { dedupeKey: 'a', severity: 'high', title: 'A', status: 'confirmed', rationale: 'ok', regression: 'minor' },
        ];
        const result = computeGateDecision(verdicts, { enabled: true, blockOnRegression: false });
        assert.equal(result.gateState, 'passed');
    });
});

describe('buildGateResult', () => {
    it('computes correct counts', () => {
        const verdicts = [
            { dedupeKey: 'a', severity: 'high', title: 'A', status: 'confirmed', rationale: 'ok' },
            { dedupeKey: 'b', severity: 'high', title: 'B', status: 'rejected', rationale: 'fp' },
        ];
        const result = buildGateResult(verdicts, { enabled: true, confirmThreshold: 0.5 });
        assert.equal(result.confirmedCount, 1);
        assert.equal(result.totalCount, 2);
        assert.equal(result.confirmedRatio, 0.5);
        assert.equal(result.gateState, 'passed');
    });
});

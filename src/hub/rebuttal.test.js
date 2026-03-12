import test from 'node:test';
import assert from 'node:assert/strict';

import { Session } from './session.js';
import { createFinding } from '../schema/events.js';
import { buildAppealPrompt, deriveAppealOutcomes, normalizeRebuttalInput } from './rebuttal.js';

function makeSessionWithFinding() {
    const session = new Session({ projectDir: '/repo', prompt: 'Review changes' });
    const finding = createFinding({
        severity: 'high',
        summary: 'Null dereference risk',
        evidence: 'foo may be undefined',
        file: 'src/app.js',
        line: 12,
        confidence: 0.9,
    });
    session.finalize('completed', [finding]);
    return { session, finding };
}

test('normalizeRebuttalInput resolves target by dedupe key', () => {
    const { session, finding } = makeSessionWithFinding();
    const rebuttal = normalizeRebuttalInput(session, {
        dedupeKey: finding.dedupe_key,
        verdict: 'reject',
        reasonCode: 'intended_behavior',
        rationale: 'Guard exists in caller contract.',
        requestedAction: 'drop',
    });

    assert.equal(rebuttal.target.dedupeKey, finding.dedupe_key);
    assert.equal(rebuttal.target.findingId, finding.id);
    assert.equal(rebuttal.verdict, 'reject');
});

test('normalizeRebuttalInput rejects unknown targets', () => {
    const { session } = makeSessionWithFinding();
    assert.throws(() => normalizeRebuttalInput(session, {
        dedupeKey: 'missing',
        verdict: 'reject',
        rationale: 'Nope',
    }), /must reference a finding/);
});

test('buildAppealPrompt produces structured rebuttal bundle', () => {
    const { session, finding } = makeSessionWithFinding();
    session.rebuttals = [normalizeRebuttalInput(session, {
        findingId: finding.id,
        verdict: 'reject',
        reasonCode: 'wrong_location',
        rationale: 'Issue is in upstream caller.',
    })];

    const prompt = buildAppealPrompt(session);
    assert.match(prompt, /Structured rebuttal bundle from Antigravity/);
    assert.match(prompt, new RegExp(finding.dedupe_key));
    assert.match(prompt, /Required response: withdraw, revise, or defend/);
});

test('deriveAppealOutcomes marks maintained revised and withdrawn', () => {
    const { session, finding } = makeSessionWithFinding();
    session.rebuttals = [normalizeRebuttalInput(session, {
        findingId: finding.id,
        verdict: 'reject',
        reasonCode: 'other',
        rationale: 'Please reconsider.',
    })];

    const maintainedChild = new Session({ projectDir: '/repo', prompt: 'retry', parentSessionId: session.id });
    maintainedChild.finalize('completed', [createFinding({
        severity: 'medium',
        summary: finding.summary,
        evidence: 'still present',
        file: finding.file,
        line: finding.line,
    })]);
    maintainedChild.allFindings[0].dedupe_key = finding.dedupe_key;

    const revisedChild = new Session({ projectDir: '/repo', prompt: 'retry', parentSessionId: session.id });
    revisedChild.finalize('completed', [createFinding({
        severity: 'medium',
        summary: finding.summary,
        evidence: 'line moved',
        file: finding.file,
        line: 30,
    })]);

    const withdrawnChild = new Session({ projectDir: '/repo', prompt: 'retry', parentSessionId: session.id });
    withdrawnChild.finalize('completed', []);

    assert.equal(deriveAppealOutcomes(session, maintainedChild)[0].outcome, 'maintained');
    assert.equal(deriveAppealOutcomes(session, revisedChild)[0].outcome, 'revised');
    assert.equal(deriveAppealOutcomes(session, withdrawnChild)[0].outcome, 'withdrawn');
});

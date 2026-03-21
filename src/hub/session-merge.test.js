// @ts-check

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Session } from './session.js';
import { createEvent, createFinding } from '../schema/events.js';

describe('Session merge integration', () => {
    it('preserves distinct agents for duplicate dedupe_key findings', () => {
        const session = new Session({ projectDir: '/project', prompt: 'review' });
        session.start();

        const codexFinding = createFinding({
            severity: 'high',
            summary: 'Missing null check in handler',
            evidence: '',
            file: 'src/app.js',
            line: 10,
        });
        const claudeFinding = createFinding({
            severity: 'medium',
            summary: 'Missing null check in handler',
            evidence: '',
            file: 'src/app.js',
            line: 10,
        });

        session.addEvent(createEvent(session.id, 'codex', 'finding', { raw: codexFinding }));
        session.addEvent(createEvent(session.id, 'semgrep', 'finding', { raw: claudeFinding }));

        session.finalize('completed', [codexFinding, claudeFinding]);

        assert.equal(session.groupedFindings.length, 1);
        assert.deepEqual(session.groupedFindings[0].agents, ['codex', 'semgrep']);
        assert.equal(session.groupedFindings[0].raw_findings.length, 2);

        assert.equal(session.mergedFindings.length, 1);
        assert.deepEqual(session.mergedFindings[0].agents, ['semgrep', 'codex']);
        assert.equal(session.mergedFindings[0].sources.length, 2);
    });

    it('matches repeated identical findings in event order', () => {
        const session = new Session({ projectDir: '/project', prompt: 'review' });
        session.start();

        const findings = [
            createFinding({ severity: 'high', summary: 'Bug X', evidence: '', file: 'a.js', line: 1 }),
            createFinding({ severity: 'high', summary: 'Bug X', evidence: '', file: 'a.js', line: 1 }),
            createFinding({ severity: 'high', summary: 'Bug X', evidence: '', file: 'a.js', line: 1 }),
        ];

        session.addEvent(createEvent(session.id, 'codex', 'finding', { raw: findings[0] }));
        session.addEvent(createEvent(session.id, 'semgrep', 'finding', { raw: findings[1] }));
        session.addEvent(createEvent(session.id, 'eslint', 'finding', { raw: findings[2] }));

        session.finalize('completed', findings);

        assert.deepEqual(session.groupedFindings[0].agents, ['codex', 'semgrep', 'eslint']);
        assert.deepEqual(session.mergedFindings[0].agents, ['semgrep', 'codex', 'eslint']);
    });

    it('surfaces actionable remediation from merged sources', () => {
        const session = new Session({ projectDir: '/project', prompt: 'review' });
        session.start();

        const codexFinding = createFinding({
            severity: 'high',
            summary: 'Body reader can hang forever on aborted request',
            evidence: 'No aborted/error handlers are attached to the stream.',
            file: 'src/http-utils.js',
            line: 44,
            fix_instructions: 'Listen for error and aborted, then reject and clean up listeners.',
            why_it_matters: 'Production requests can hang until upstream timeout.',
        });
        const semgrepFinding = createFinding({
            severity: 'high',
            summary: 'Body reader can hang forever on aborted request',
            evidence: '',
            file: 'src/http-utils.js',
            line: 44,
        });

        session.addEvent(createEvent(session.id, 'codex', 'finding', { raw: codexFinding }));
        session.addEvent(createEvent(session.id, 'semgrep', 'finding', { raw: semgrepFinding }));

        session.finalize('completed', [codexFinding, semgrepFinding]);

        assert.equal(session.mergedFindings.length, 1);
        assert.equal(session.mergedFindings[0].why_it_matters, 'Production requests can hang until upstream timeout.');
        assert.equal(session.mergedFindings[0].fix_instructions, 'Listen for error and aborted, then reject and clean up listeners.');
        assert.equal(session.mergedFindings[0].evidence, 'No aborted/error handlers are attached to the stream.');
    });
});

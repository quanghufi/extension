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
});

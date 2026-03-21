// @ts-check

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * @returns {Array<{ path: string }>}
 */
function getPackedFiles() {
    const output = process.platform === 'win32'
        ? execFileSync(
            process.env.ComSpec ?? 'cmd.exe',
            ['/d', '/s', '/c', 'npm pack --json --dry-run'],
            { cwd: repoRoot, encoding: 'utf8' },
        )
        : execFileSync(
            'npm',
            ['pack', '--json', '--dry-run'],
            { cwd: repoRoot, encoding: 'utf8' },
        );
    const parsed = JSON.parse(output);
    return parsed[0]?.files ?? [];
}

describe('package distribution', () => {
    it('excludes repo state and dev artifacts from the npm tarball', () => {
        const files = getPackedFiles().map((entry) => entry.path);

        assert.ok(files.length > 0);
        assert.ok(!files.some((file) => file.startsWith('src/data/')));
        assert.ok(!files.some((file) => file.startsWith('data/')));
        assert.ok(!files.some((file) => file.includes('__pycache__')));
        assert.ok(!files.some((file) => file.endsWith('.test.js')));
    });

    it('keeps the MCP runtime assets needed after global install', () => {
        const files = getPackedFiles().map((entry) => entry.path);

        assert.ok(files.includes('bin/extension-hub.js'));
        assert.ok(files.includes('src/mcp-server.js'));
        assert.ok(files.includes('src/mcp/codex_review_mcp.py'));
        assert.ok(files.includes('src/mcp/codex_review_schema.json'));
        assert.ok(files.includes('src/mcp/register_antigravity_codex_review.ps1'));
        assert.ok(files.includes('src/mcp/register_antigravity_codex_review_global.ps1'));
    });

    it('register scripts target the packaged src/mcp runtime layout', async () => {
        const localScript = await fs.readFile(
            path.join(repoRoot, 'src', 'mcp', 'register_antigravity_codex_review.ps1'),
            'utf8',
        );
        const globalScript = await fs.readFile(
            path.join(repoRoot, 'src', 'mcp', 'register_antigravity_codex_review_global.ps1'),
            'utf8',
        );

        assert.match(localScript, /src\\mcp\\codex_review_mcp\.py/i);
        assert.match(localScript, /src\\mcp\\codex_review_schema\.json/i);
        assert.doesNotMatch(localScript, /scripts1?\\codex_review_mcp\.py/i);
        assert.doesNotMatch(localScript, /scripts1?\\codex_review_schema\.json/i);

        assert.match(globalScript, /src\\mcp\\codex_review_mcp\.py/i);
        assert.match(globalScript, /src\\mcp\\codex_review_schema\.json/i);
        assert.doesNotMatch(globalScript, /scripts1?\\codex_review_mcp\.py/i);
        assert.doesNotMatch(globalScript, /scripts1?\\codex_review_schema\.json/i);
    });
});

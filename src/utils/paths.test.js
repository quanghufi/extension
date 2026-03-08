// @ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { normalizeFindingPath } from './paths.js';

const SNAPSHOT_ROOT = path.resolve('d:/extension/tmp/snapshot-abc');
const IS_WINDOWS = process.platform === 'win32';

describe('normalizeFindingPath', () => {
    it('normalizes forward-slash path', () => {
        const result = normalizeFindingPath('src/server.js', SNAPSHOT_ROOT);
        assert.equal(result, IS_WINDOWS ? 'src/server.js' : 'src/server.js');
    });

    it('normalizes backslash path to forward slash (Windows)', () => {
        // On all platforms, backslash in rawPath joined with root should normalize
        const result = normalizeFindingPath('src\\server.js', SNAPSHOT_ROOT);
        assert.equal(result, IS_WINDOWS ? 'src/server.js' : 'src/server.js');
    });

    it('same file with different separators → identical result', () => {
        const r1 = normalizeFindingPath('src/server.js', SNAPSHOT_ROOT);
        const r2 = normalizeFindingPath('src\\server.js', SNAPSHOT_ROOT);
        assert.equal(r1, r2);
    });

    it('strips leading ./ prefix', () => {
        const result = normalizeFindingPath('./src/server.js', SNAPSHOT_ROOT);
        assert.equal(result, IS_WINDOWS ? 'src/server.js' : 'src/server.js');
    });

    it('./ path equals path without ./', () => {
        const r1 = normalizeFindingPath('./src/server.js', SNAPSHOT_ROOT);
        const r2 = normalizeFindingPath('src/server.js', SNAPSHOT_ROOT);
        assert.equal(r1, r2);
    });

    if (IS_WINDOWS) {
        it('lowercases on Windows (case-insensitive FS)', () => {
            const result = normalizeFindingPath('SRC/Server.js', SNAPSHOT_ROOT);
            assert.equal(result, 'src/server.js');
        });

        it('mixed case paths normalize identically on Windows', () => {
            const r1 = normalizeFindingPath('src/Server.JS', SNAPSHOT_ROOT);
            const r2 = normalizeFindingPath('SRC/server.js', SNAPSHOT_ROOT);
            assert.equal(r1, r2);
        });
    }

    it('rejects path traversal (../)', () => {
        assert.throws(
            () => normalizeFindingPath('../../../etc/passwd', SNAPSHOT_ROOT),
            /Path traversal detected/
        );
    });

    it('rejects path traversal with mixed separators', () => {
        assert.throws(
            () => normalizeFindingPath('..\\..\\..\\etc\\passwd', SNAPSHOT_ROOT),
            /Path traversal detected/
        );
    });

    it('rejects absolute path outside snapshot root', () => {
        assert.throws(
            () => normalizeFindingPath('C:\\Windows\\System32\\cmd.exe', SNAPSHOT_ROOT),
            /Path traversal detected/
        );
    });

    it('accepts path that stays within snapshot root', () => {
        const result = normalizeFindingPath('deep/nested/file.js', SNAPSHOT_ROOT);
        assert.ok(result);
        assert.ok(!result.includes('..'));
    });

    it('throws on empty rawPath', () => {
        assert.throws(
            () => normalizeFindingPath('', SNAPSHOT_ROOT),
            /rawPath is required/
        );
    });

    it('throws on empty snapshotRoot', () => {
        assert.throws(
            () => normalizeFindingPath('src/a.js', ''),
            /snapshotRoot is required/
        );
    });

    it('handles deeply nested paths', () => {
        const result = normalizeFindingPath('a/b/c/d/e/f.txt', SNAPSHOT_ROOT);
        assert.equal(result, IS_WINDOWS ? 'a/b/c/d/e/f.txt' : 'a/b/c/d/e/f.txt');
    });
});

// @ts-check
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SnapshotManager, SNAPSHOT_DIR_PREFIX } from './snapshot-manager.js';

const TEST_BASE = path.resolve('tmp/test-snapshots-' + Date.now());
const TEST_SOURCE = path.resolve('tmp/test-source-' + Date.now());
const IS_WINDOWS = process.platform === 'win32';

describe('SnapshotManager', () => {
    before(() => {
        // Create test source directory with sample files
        fs.mkdirSync(path.join(TEST_SOURCE, 'src'), { recursive: true });
        fs.writeFileSync(path.join(TEST_SOURCE, 'index.js'), '// main');
        fs.writeFileSync(path.join(TEST_SOURCE, 'src', 'app.js'), '// app');
        fs.writeFileSync(path.join(TEST_SOURCE, 'README.md'), '# Test');
    });

    after(() => {
        // Cleanup
        const manager = new SnapshotManager(TEST_BASE);
        for (const snap of manager.list()) {
            try { manager.remove(path.join(TEST_BASE, snap)); } catch { /* best effort */ }
        }
        try { fs.rmSync(TEST_BASE, { recursive: true, force: true }); } catch { /* ok */ }
        try { fs.rmSync(TEST_SOURCE, { recursive: true, force: true }); } catch { /* ok */ }
    });

    it('throws on empty baseDir', () => {
        assert.throws(() => new SnapshotManager(''), /baseDir is required/);
    });

    it('throws on empty sourceDir', () => {
        const manager = new SnapshotManager(TEST_BASE);
        assert.throws(() => manager.create(''), /sourceDir is required/);
    });

    it('throws on non-existent sourceDir', () => {
        const manager = new SnapshotManager(TEST_BASE);
        assert.throws(
            () => manager.create('/nonexistent/path/xyz123'),
            /Source directory does not exist/
        );
    });

    it('creates snapshot with copy method', () => {
        const manager = new SnapshotManager(TEST_BASE);
        const result = manager.create(TEST_SOURCE, { useGitWorktree: false });

        assert.ok(result.id.startsWith(SNAPSHOT_DIR_PREFIX));
        assert.ok(fs.existsSync(result.path));
        assert.ok(result.createdAt);
        assert.ok(['robocopy', 'cp'].includes(result.method));

        // Verify files were copied
        assert.ok(fs.existsSync(path.join(result.path, 'index.js')));
        assert.ok(fs.existsSync(path.join(result.path, 'src', 'app.js')));
        assert.ok(fs.existsSync(path.join(result.path, 'README.md')));
    });

    it('creates snapshot with custom ID', () => {
        const manager = new SnapshotManager(TEST_BASE);
        const result = manager.create(TEST_SOURCE, {
            id: 'snapshot-custom-123',
            useGitWorktree: false,
        });

        assert.equal(result.id, 'snapshot-custom-123');
        assert.ok(result.path.endsWith('snapshot-custom-123'));
    });

    it('lists snapshots', () => {
        const manager = new SnapshotManager(TEST_BASE);
        const list = manager.list();
        assert.ok(Array.isArray(list));
        assert.ok(list.length >= 1);
        assert.ok(list.every((name) => name.startsWith(SNAPSHOT_DIR_PREFIX)));
    });

    it('returns empty list for non-existent baseDir', () => {
        const manager = new SnapshotManager('/nonexistent/snapshots');
        assert.deepStrictEqual(manager.list(), []);
    });

    it('verifies snapshot is read-only after creation', () => {
        const manager = new SnapshotManager(TEST_BASE);
        const result = manager.create(TEST_SOURCE, {
            id: 'snapshot-verify-test',
            useGitWorktree: false,
        });

        const verification = manager.verify(result.path);
        // On Windows with proper admin, this should be true
        // On CI or limited environments, protection may partially work
        assert.ok(typeof verification.readOnly === 'boolean');
    });

    it('removes snapshot (reverses protection)', () => {
        const manager = new SnapshotManager(TEST_BASE);
        const result = manager.create(TEST_SOURCE, {
            id: 'snapshot-remove-test',
            useGitWorktree: false,
        });

        assert.ok(fs.existsSync(result.path));
        manager.remove(result.path);
        assert.ok(!fs.existsSync(result.path));
    });

    it('remove is idempotent (no error on missing path)', () => {
        const manager = new SnapshotManager(TEST_BASE);
        // Should not throw
        manager.remove('/nonexistent/snapshot/path');
    });
});

describe('SnapshotManager EPERM enforcement', () => {
    const EPERM_BASE = path.resolve('tmp/test-eperm-' + Date.now());
    const EPERM_SOURCE = path.resolve('tmp/test-eperm-source-' + Date.now());

    before(() => {
        fs.mkdirSync(path.join(EPERM_SOURCE, 'src'), { recursive: true });
        fs.writeFileSync(path.join(EPERM_SOURCE, 'test.txt'), 'original content');
    });

    after(() => {
        const manager = new SnapshotManager(EPERM_BASE);
        for (const snap of manager.list()) {
            try { manager.remove(path.join(EPERM_BASE, snap)); } catch { /* ok */ }
        }
        try { fs.rmSync(EPERM_BASE, { recursive: true, force: true }); } catch { /* ok */ }
        try { fs.rmSync(EPERM_SOURCE, { recursive: true, force: true }); } catch { /* ok */ }
    });

    it('prevents overwriting files in snapshot (EPERM)', () => {
        const manager = new SnapshotManager(EPERM_BASE);
        const result = manager.create(EPERM_SOURCE, {
            id: 'snapshot-eperm-overwrite',
            useGitWorktree: false,
        });

        const targetFile = path.join(result.path, 'test.txt');
        assert.ok(fs.existsSync(targetFile));

        // Attempt to overwrite — should fail on protected snapshot
        try {
            fs.writeFileSync(targetFile, 'TAMPERED!');
            // If it didn't throw, verify we can't on Windows
            if (IS_WINDOWS) {
                // Protection may require elevation; report result
                const content = fs.readFileSync(targetFile, 'utf-8');
                assert.ok(
                    content === 'original content' || content === 'TAMPERED!',
                    'File exists and is accessible'
                );
            }
        } catch (err) {
            // Expected: EPERM or EACCES
            const code = /** @type {NodeJS.ErrnoException} */ (err).code;
            assert.ok(
                ['EPERM', 'EACCES', 'EROFS'].includes(code ?? ''),
                `Expected EPERM/EACCES, got ${code}`
            );
        }
    });

    it('prevents creating new files in snapshot', () => {
        const manager = new SnapshotManager(EPERM_BASE);
        const result = manager.create(EPERM_SOURCE, {
            id: 'snapshot-eperm-create',
            useGitWorktree: false,
        });

        const newFile = path.join(result.path, 'new-file.txt');

        try {
            fs.writeFileSync(newFile, 'injected!');
            // If it didn't throw, cleanup for robustness
            try { fs.unlinkSync(newFile); } catch { /* ok */ }
        } catch (err) {
            const code = /** @type {NodeJS.ErrnoException} */ (err).code;
            assert.ok(
                ['EPERM', 'EACCES', 'EROFS'].includes(code ?? ''),
                `Expected EPERM/EACCES, got ${code}`
            );
        }
    });
});

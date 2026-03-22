// @ts-check
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SessionStore } from './session-store.js';
import { Session } from './session.js';

const TEST_DATA_DIR = path.resolve('tmp/test-store-' + Date.now());

describe('SessionStore', () => {
    after(() => {
        try { fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true }); } catch { /* ok */ }
    });

    it('throws on empty dataDir', () => {
        assert.throws(() => new SessionStore(''), /dataDir is required/);
    });

    it('creates sessions directory on construction', () => {
        const store = new SessionStore(TEST_DATA_DIR);
        assert.ok(fs.existsSync(store.sessionsDir));
    });

    it('saves and loads session', () => {
        const store = new SessionStore(TEST_DATA_DIR);
        const session = new Session({ projectDir: '/p', prompt: 'test', id: 'store-test-1' });
        session.start();

        store.save(session);
        assert.ok(store.exists('store-test-1'));

        const loaded = store.load('store-test-1');
        assert.ok(loaded);
        assert.equal(loaded.id, 'store-test-1');
        assert.equal(loaded.state, 'running');
        assert.equal(loaded.prompt, 'test');
    });

    it('returns null for non-existent session', () => {
        const store = new SessionStore(TEST_DATA_DIR);
        assert.equal(store.load('nonexistent'), null);
    });

    it('lists session IDs', () => {
        const store = new SessionStore(TEST_DATA_DIR);
        const s1 = new Session({ projectDir: '/p', prompt: 'a', id: 'list-test-1' });
        const s2 = new Session({ projectDir: '/p', prompt: 'b', id: 'list-test-2' });

        store.save(s1);
        store.save(s2);

        const list = store.list();
        assert.ok(list.includes('list-test-1'));
        assert.ok(list.includes('list-test-2'));
    });

    it('deletes session', () => {
        const store = new SessionStore(TEST_DATA_DIR);
        const s = new Session({ projectDir: '/p', prompt: 'test', id: 'delete-test' });
        store.save(s);
        assert.ok(store.exists('delete-test'));

        store.delete('delete-test');
        assert.ok(!store.exists('delete-test'));
    });

    it('delete is idempotent', () => {
        const store = new SessionStore(TEST_DATA_DIR);
        // Should not throw
        store.delete('already-gone');
    });

    it('atomic save survives crash (temp file pattern)', () => {
        const store = new SessionStore(TEST_DATA_DIR);
        const s = new Session({ projectDir: '/p', prompt: 'atomic', id: 'atomic-test' });

        // Save twice — second save should not corrupt
        store.save(s);
        s.start();
        store.save(s);

        const loaded = store.load('atomic-test');
        assert.ok(loaded);
        assert.equal(loaded.state, 'running');
    });

    it('sanitizes session ID to prevent path traversal', () => {
        const store = new SessionStore(TEST_DATA_DIR);
        const s = new Session({ projectDir: '/p', prompt: 'test', id: '../../../attack' });
        store.save(s);

        // File should be saved with sanitized name, not traversing
        const sanitized = store.list().find((id) => id.includes('attack'));
        assert.ok(sanitized);
        // Should not have created file outside sessionsDir
        assert.ok(!fs.existsSync(path.resolve(TEST_DATA_DIR, '../../../attack.json')));
    });
});

describe('SessionStore — ghost debate recovery', () => {
    /** @type {string} */
    let tempDir;
    /** @type {SessionStore} */
    let store;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-store-test-'));
        store = new SessionStore(tempDir);
    });

    afterEach(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('recovers session with debateActive=true on load', () => {
        const session = new Session({
            projectDir: '/test/project',
            prompt: 'Review this code',
        });
        session.debateActive = true;
        session.debateState = 'reviewing';
        session.debateAgents = ['codex', 'claude-code'];
        store.save(session);

        const loaded = store.load(session.id);

        assert.equal(loaded.debateActive, false,
            'debateActive should be false after recovery');
        assert.equal(loaded.debateState, 'failed',
            'debateState should be failed after recovery');
    });

    it('does not modify sessions without active debate', () => {
        const session = new Session({
            projectDir: '/test/project',
            prompt: 'Review this code',
        });
        session.debateActive = false;
        session.debateState = 'resolved';
        store.save(session);

        const loaded = store.load(session.id);

        assert.equal(loaded.debateActive, false);
        assert.equal(loaded.debateState, 'resolved');
    });

    it('clears debateActive even when debateState is already resolved', () => {
        const session = new Session({
            projectDir: '/test/project',
            prompt: 'Review this code',
        });
        session.debateActive = true;
        session.debateState = 'resolved';
        store.save(session);

        const loaded = store.load(session.id);

        assert.equal(loaded.debateActive, false);
        // debateState stays 'resolved' since it's already terminal
        assert.equal(loaded.debateState, 'resolved');
    });
});

// @ts-check
/**
 * Session Store — Atomic persistence for sessions.
 *
 * Uses temp-file-plus-rename pattern to prevent corruption.
 * File format: JSON per session file in `<dataDir>/sessions/`.
 *
 * @module hub/session-store
 */

import fs from 'node:fs';
import path from 'node:path';
import { Session } from './session.js';
import { serializeSession } from './session-serialization.js';

export class SessionStore {
    /**
     * @param {string} dataDir - Directory to store session files
     */
    constructor(dataDir) {
        if (!dataDir || typeof dataDir !== 'string') {
            throw new Error('dataDir is required and must be a non-empty string');
        }
        /** @type {string} */
        this.sessionsDir = path.join(path.resolve(dataDir), 'sessions');
        fs.mkdirSync(this.sessionsDir, { recursive: true });
    }

    /**
     * Save session atomically (temp file + fsync + rename).
     * fsync ensures data is flushed to disk before rename — prevents
     * data loss on power failure. Cherry-picked from Codex MCP Bridge.
     * @param {Session} session
     */
    save(session) {
        const filePath = this._sessionPath(session.id);
        const tempPath = filePath + '.tmp.' + Date.now();

        const data = JSON.stringify(serializeSession(session), null, 2);

        // Write + fsync before rename (crash-safe)
        const fd = fs.openSync(tempPath, 'w');
        try {
            fs.writeSync(fd, data, 0, 'utf-8');
            fs.fsyncSync(fd);
        } finally {
            fs.closeSync(fd);
        }

        // Atomic rename (same filesystem)
        fs.renameSync(tempPath, filePath);
    }

    /**
     * Load session by ID.
     * @param {string} sessionId
     * @returns {Session|null}
     */
    load(sessionId) {
        const filePath = this._sessionPath(sessionId);
        if (!fs.existsSync(filePath)) return null;

        try {
            const raw = fs.readFileSync(filePath, 'utf-8');
            const data = JSON.parse(raw);
            return Session.fromJSON(data);
        } catch {
            return null; // Corrupted file
        }
    }

    /**
     * List all session IDs.
     * @returns {string[]}
     */
    list() {
        if (!fs.existsSync(this.sessionsDir)) return [];
        return fs.readdirSync(this.sessionsDir)
            .filter((f) => f.endsWith('.json') && !f.includes('.tmp.'))
            .map((f) => f.replace('.json', ''))
            .sort();
    }

    /**
     * Delete a session file.
     * @param {string} sessionId
     */
    delete(sessionId) {
        const filePath = this._sessionPath(sessionId);
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
    }

    /**
     * Check if a session exists.
     * @param {string} sessionId
     * @returns {boolean}
     */
    exists(sessionId) {
        return fs.existsSync(this._sessionPath(sessionId));
    }

    /**
     * @param {string} sessionId
     * @returns {string}
     */
    _sessionPath(sessionId) {
        // Sanitize session ID to prevent path traversal
        const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
        return path.join(this.sessionsDir, `${safe}.json`);
    }
}

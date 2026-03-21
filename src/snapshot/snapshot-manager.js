// @ts-check
/**
 * Snapshot Manager
 *
 * Creates read-only snapshots of project code for agent review.
 * Layered protection:
 *   1. `attrib +R /S /D` — prevents overwriting existing files
 *   2. `icacls <path> /deny Everyone:(W,D)` — prevents create/delete/rename
 *
 * Primary method: `git worktree add --detach`
 * Fallback: `robocopy /MIR`
 *
 * @module snapshot/snapshot-manager
 */

import fs from 'node:fs';
import path from 'node:path';
import spawn from 'cross-spawn';
import { v4 as uuidv4 } from 'uuid';

// ── Constants ────────────────────────────────────────

const SNAPSHOT_DIR_PREFIX = 'snapshot-';
const IS_WINDOWS = process.platform === 'win32';

// ── Snapshot Manager ─────────────────────────────────

export class SnapshotManager {
    /**
     * @param {string} baseDir - Directory to store snapshots (e.g., project/tmp/)
     */
    constructor(baseDir) {
        if (!baseDir || typeof baseDir !== 'string') {
            throw new Error('baseDir is required and must be a non-empty string');
        }
        /** @type {string} */
        this.baseDir = path.resolve(baseDir);
    }

    /**
     * Create an immutable snapshot of the source project.
     *
     * @param {string} sourceDir - Project directory to snapshot
     * @param {object} [options]
     * @param {string} [options.id] - Custom snapshot ID (default: auto-generated)
     * @param {boolean} [options.useGitWorktree] - Try git worktree first (default: true)
     * @returns {SnapshotResult}
     */
    create(sourceDir, options = {}) {
        if (!sourceDir || typeof sourceDir !== 'string') {
            throw new Error('sourceDir is required and must be a non-empty string');
        }

        const resolvedSource = path.resolve(sourceDir);
        if (!fs.existsSync(resolvedSource)) {
            throw new Error(`Source directory does not exist: ${resolvedSource}`);
        }

        const snapshotId = options.id ?? `${SNAPSHOT_DIR_PREFIX}${uuidv4().slice(0, 8)}`;
        const snapshotPath = path.join(this.baseDir, snapshotId);

        // Ensure base dir exists
        fs.mkdirSync(this.baseDir, { recursive: true });

        // Detect snapshot method
        const useGitWorktree = options.useGitWorktree !== false;
        let method = /** @type {'git-worktree' | 'robocopy' | 'cp'} */ ('cp');

        if (useGitWorktree && this._isGitRepo(resolvedSource)) {
            try {
                this._createGitWorktree(resolvedSource, snapshotPath);
                method = 'git-worktree';
            } catch {
                // Fallback to copy
                this._createCopy(resolvedSource, snapshotPath);
                method = IS_WINDOWS ? 'robocopy' : 'cp';
            }
        } else {
            this._createCopy(resolvedSource, snapshotPath);
            method = IS_WINDOWS ? 'robocopy' : 'cp';
        }

        // Apply layered protection
        if (IS_WINDOWS) {
            this._applyWindowsProtection(snapshotPath);
        } else {
            this._applyPosixProtection(snapshotPath);
        }

        return {
            id: snapshotId,
            path: snapshotPath,
            method,
            createdAt: new Date().toISOString(),
        };
    }

    /**
     * Remove a snapshot (reverses protections first).
     *
     * @param {string} snapshotPath - Absolute path to snapshot directory
     */
    remove(snapshotPath) {
        const resolved = path.resolve(snapshotPath);

        if (!fs.existsSync(resolved)) {
            return; // Already gone
        }

        // Reverse protections before deletion
        if (IS_WINDOWS) {
            this._removeWindowsProtection(resolved);
        } else {
            this._removePosixProtection(resolved);
        }

        // Clean up git worktree metadata if this was a worktree-based snapshot
        try {
            runCommand('git', ['worktree', 'remove', '--force', resolved]);
        } catch {
            // Not a git worktree or git not available — fall through to rmSync
        }

        // Remove directory tree (handles robocopy/cp snapshots, or if worktree remove didn't fully clean up)
        if (fs.existsSync(resolved)) {
            fs.rmSync(resolved, { recursive: true, force: true });
        }
    }

    /**
     * List all snapshots in the base directory.
     * @returns {string[]} Snapshot directory names
     */
    list() {
        if (!fs.existsSync(this.baseDir)) return [];
        return fs.readdirSync(this.baseDir)
            .filter((name) => name.startsWith(SNAPSHOT_DIR_PREFIX))
            .sort();
    }

    /**
     * Verify snapshot is read-only by attempting a write operation.
     *
     * @param {string} snapshotPath
     * @returns {{ readOnly: boolean, error?: string }}
     */
    verify(snapshotPath) {
        const testFile = path.join(snapshotPath, '.write-test-' + Date.now());
        try {
            fs.writeFileSync(testFile, 'test');
            // If write succeeded, protection failed
            try { fs.unlinkSync(testFile); } catch { /* cleanup */ }
            return { readOnly: false, error: 'Write succeeded — protection not enforced' };
        } catch (err) {
            const code = /** @type {NodeJS.ErrnoException} */ (err).code;
            if (code === 'EPERM' || code === 'EACCES' || code === 'EROFS') {
                return { readOnly: true };
            }
            return { readOnly: true }; // Other errors also mean we can't write
        }
    }

    // ── Private: Snapshot Creation ────────────────────

    /**
     * @param {string} sourceDir
     * @returns {boolean}
     */
    _isGitRepo(sourceDir) {
        try {
            runCommand('git', ['rev-parse', '--is-inside-work-tree'], {
                cwd: sourceDir,
            });
            return true;
        } catch {
            return false;
        }
    }

    /**
     * @param {string} sourceDir
     * @param {string} snapshotPath
     */
    _createGitWorktree(sourceDir, snapshotPath) {
        runCommand('git', ['worktree', 'add', '--detach', snapshotPath], {
            cwd: sourceDir,
        });
    }

    /**
     * @param {string} sourceDir
     * @param {string} snapshotPath
     */
    _createCopy(sourceDir, snapshotPath) {
        if (IS_WINDOWS) {
            // robocopy /MIR excludes .git and node_modules for speed
            const excludeDirs = ['.git', 'node_modules', '.next', 'dist', 'build'];
            runCommand(
                'robocopy',
                [sourceDir, snapshotPath, '/MIR', '/XD', ...excludeDirs, '/NFL', '/NDL', '/NJH', '/NJS', '/NC', '/NS', '/NP'],
                { acceptedExitCodes: [0, 1, 2, 3, 4, 5, 6, 7] },
            );
        } else {
            fs.cpSync(sourceDir, snapshotPath, {
                recursive: true,
                force: true,
                verbatimSymlinks: true,
                filter: (src) => {
                    const basename = path.basename(src);
                    return basename !== '.git' && basename !== 'node_modules';
                },
            });
        }
    }

    // ── Private: Protection ──────────────────────────

    /**
     * Apply Windows layered protection:
     * Layer 1: attrib +R /S /D — prevents overwriting
     * Layer 2: icacls deny Everyone:(W,D) — prevents create/delete/rename
     * @param {string} snapshotPath
     */
    _applyWindowsProtection(snapshotPath) {
        try {
            // Layer 1: Mark all files and directories as read-only
            runCommand('attrib', ['+R', '/S', '/D', `${snapshotPath}\\*`]);
            runCommand('attrib', ['+R', snapshotPath]);
        } catch {
            // attrib may partially fail, continue to icacls
        }

        try {
            // Layer 2: Deny write/delete via ACL
            runCommand('icacls', [snapshotPath, '/deny', 'Everyone:(W,D)', '/T', '/C', '/Q']);
        } catch {
            // icacls may fail in some environments (non-admin, containers)
        }
    }

    /**
     * Remove Windows protections (reverse order).
     * @param {string} snapshotPath
     */
    _removeWindowsProtection(snapshotPath) {
        try {
            // Remove ACL deny first
            runCommand('icacls', [snapshotPath, '/remove:d', 'Everyone', '/T', '/C', '/Q']);
        } catch { /* may not have been applied */ }

        try {
            // Remove read-only attributes
            runCommand('attrib', ['-R', '/S', '/D', `${snapshotPath}\\*`]);
            runCommand('attrib', ['-R', snapshotPath]);
        } catch { /* best effort */ }
    }

    /**
     * Apply POSIX protection: chmod -R a-w
     * @param {string} snapshotPath
     */
    _applyPosixProtection(snapshotPath) {
        try {
            runCommand('chmod', ['-R', 'a-w', snapshotPath]);
        } catch { /* best effort */ }
    }

    /**
     * Remove POSIX protection: chmod -R u+w
     * @param {string} snapshotPath
     */
    _removePosixProtection(snapshotPath) {
        try {
            runCommand('chmod', ['-R', 'u+w', snapshotPath]);
        } catch { /* best effort */ }
    }
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd?: string, acceptedExitCodes?: number[] }} [options]
 */
function runCommand(command, args, options = {}) {
    const result = spawn.sync(command, args, {
        cwd: options.cwd,
        stdio: 'pipe',
        shell: false,
        encoding: 'utf8',
    });

    if (result.error) {
        throw result.error;
    }

    const exitCode = result.status ?? 0;
    const acceptedExitCodes = options.acceptedExitCodes ?? [0];
    if (!acceptedExitCodes.includes(exitCode)) {
        const stderr = result.stderr?.trim();
        const stdout = result.stdout?.trim();
        throw new Error(
            `${command} exited with code ${exitCode}`
            + (stderr ? `: ${stderr}` : stdout ? `: ${stdout}` : '')
        );
    }

    return result;
}

// ── Types ────────────────────────────────────────────

/**
 * @typedef {Object} SnapshotResult
 * @property {string} id - Snapshot identifier
 * @property {string} path - Absolute path to snapshot
 * @property {'git-worktree' | 'robocopy' | 'cp'} method - Creation method used
 * @property {string} createdAt - ISO-8601 timestamp
 */

export { SNAPSHOT_DIR_PREFIX };

// @ts-check
/**
 * Path Normalization Utility
 * 
 * Central path normalization applied BEFORE hashing or storage.
 * Ensures Windows backslash paths and POSIX slash paths hash identically.
 * Rejects path traversal attempts.
 * 
 * @module utils/paths
 */

import path from 'node:path';

/**
 * Normalize a finding file path for consistent hashing and display.
 *
 * 1. Resolve relative to snapshotRoot
 * 2. Reject traversal — throw if resolved path escapes snapshotRoot
 * 3. Convert to forward slashes
 * 4. Lowercase on Windows (case-insensitive FS)
 * 5. Strip leading './'
 * 6. Return relative path from snapshotRoot
 *
 * @param {string} rawPath - Raw file path from CLI output
 * @param {string} snapshotRoot - Absolute path to snapshot directory
 * @returns {string} Normalized relative path (forward slashes)
 * @throws {Error} If path traversal detected or rawPath is empty
 */
export function normalizeFindingPath(rawPath, snapshotRoot) {
    if (!rawPath || typeof rawPath !== 'string') {
        throw new Error('rawPath is required and must be a non-empty string');
    }
    if (!snapshotRoot || typeof snapshotRoot !== 'string') {
        throw new Error('snapshotRoot is required and must be a non-empty string');
    }

    // 1. Resolve relative to snapshotRoot
    const resolved = path.resolve(snapshotRoot, rawPath);

    // 2. Normalize snapshotRoot for comparison (ensure trailing separator stripped)
    const normalizedRoot = path.resolve(snapshotRoot);

    // 3. Reject traversal — resolved must be inside snapshotRoot
    if (!resolved.startsWith(normalizedRoot + path.sep) && resolved !== normalizedRoot) {
        throw new Error(`Path traversal detected: "${rawPath}" resolves outside snapshot root`);
    }

    // 4. Get relative path from snapshot root
    let relative = path.relative(normalizedRoot, resolved);

    // 5. Convert to forward slashes (Windows compat)
    relative = relative.split(path.sep).join('/');

    // 6. Lowercase on Windows (case-insensitive filesystem)
    if (process.platform === 'win32') {
        relative = relative.toLowerCase();
    }

    // 7. Strip leading './' (shouldn't happen after path.relative, but defensive)
    if (relative.startsWith('./')) {
        relative = relative.slice(2);
    }

    return relative;
}

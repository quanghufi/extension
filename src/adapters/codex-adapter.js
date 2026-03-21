// @ts-check
/**
 * Codex CLI Adapter
 *
 * Uses `codex exec review --json` for machine-readable automation,
 * while keeping isolated `CODEX_HOME` per workspace.
 *
 * @module adapters/codex-adapter
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BaseAdapter } from './base-adapter.js';
import {
    formatReviewPrompt,
    mapSeverity,
    parseCodexExecChunk,
    parseCodexExecResult,
} from './codex-adapter-parsing.js';

export class CodexAdapter extends BaseAdapter {
    /**
     * @param {object} [options]
     * @param {number} [options.firstByteMs]
     * @param {number} [options.idleMs]
     * @param {number} [options.hardMs]
     */
    constructor(options = {}) {
        super('codex', options);
    }

    /**
     * @param {string} _snapshotPath
     * @param {string} prompt
     * @returns {{ cmd: string, args: string[] }}
     */
    buildCommand(_snapshotPath, prompt) {
        return {
            cmd: 'codex',
            args: [
                'exec',
                'review',
                '--json',
                formatReviewPrompt(prompt),
            ],
        };
    }

    /**
     * @param {string} snapshotPath
     * @returns {{ env: Record<string, string> }}
     */
    getExecutionOptions(snapshotPath) {
        const { env } = this.prepareIsolatedHome(snapshotPath);
        return { env };
    }

    /**
     * @param {string} workspacePath
     * @returns {{ homePath: string, env: Record<string, string> }}
     */
    prepareIsolatedHome(workspacePath) {
        const hash = createHash('sha256')
            .update(workspacePath, 'utf-8')
            .digest('hex')
            .slice(0, 12);

        const homeRoot = path.join(os.tmpdir(), 'codex-review-home', hash);
        const codexDir = path.join(homeRoot, '.codex');
        fs.mkdirSync(codexDir, { recursive: true });

        const sourceCodexDir = path.join(os.homedir(), '.codex');
        for (const filename of ['auth.json', 'config.toml']) {
            const sourcePath = path.join(sourceCodexDir, filename);
            const targetPath = path.join(codexDir, filename);
            try {
                if (!fs.existsSync(sourcePath)) continue;

                const sourceBytes = fs.readFileSync(sourcePath);
                let needsCopy = true;
                if (fs.existsSync(targetPath)) {
                    const targetBytes = fs.readFileSync(targetPath);
                    needsCopy = !sourceBytes.equals(targetBytes);
                }

                if (needsCopy) {
                    fs.writeFileSync(targetPath, sourceBytes);
                }
            } catch {
                // Non-fatal — user auth/config may not exist yet.
            }
        }

        return {
            homePath: homeRoot,
            env: {
                HOME: homeRoot,
                USERPROFILE: homeRoot,
                CODEX_HOME: codexDir,
            },
        };
    }

    /**
     * @param {string} chunk
     * @param {string} sessionId
     * @returns {import('../schema/events.js').Event[]}
     */
    parseChunk(chunk, sessionId) {
        return parseCodexExecChunk(chunk, sessionId, this.agentId);
    }

    /**
     * @param {string} allOutput
     * @param {string} _sessionId
     * @returns {import('../schema/events.js').Finding[]}
     */
    parseResult(allOutput, _sessionId) {
        return parseCodexExecResult(allOutput);
    }
}

export { mapSeverity };

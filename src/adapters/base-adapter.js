// @ts-check
/**
 * Base Adapter — Abstract streaming adapter for CLI agent processes.
 *
 * Provides:
 * - `execute()` returning `{ stream: AsyncIterable<Event>, done: Promise<AdapterResult> }`
 * - 3-tier timeout (firstByte / idle / hard)
 * - UTF-8 garble detection (U+FFFD)
 * - Windows process-tree cleanup via `taskkill /T /F`
 * - Telemetry: firstByteMs, lastIdleGapMs, totalMs
 *
 * Subclasses MUST override:
 * - `buildCommand(snapshotPath, prompt)` → { cmd, args }
 * - `parseChunk(chunk)` → Event[]
 * - `parseResult(allChunks)` → Finding[]
 *
 * @module adapters/base-adapter
 */

import { createEvent } from '../schema/events.js';
import spawn from 'cross-spawn';
import { execSync } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

// ── Constants ────────────────────────────────────────

/** @type {Readonly<{firstByteMs: number, idleMs: number, hardMs: number}>} */
const DEFAULT_TIMEOUTS = Object.freeze({
    firstByteMs: 60_000,  // 60s to get first output (Claude MCP init can be slow)
    idleMs: 30_000,       // 30s of silence → assume stalled
    hardMs: 300_000,      // 5min hard cap per agent run
});

// ── Base Adapter ────────────────────────────────────

export class BaseAdapter {
    /**
     * @param {string} agentId - 'codex' | 'claude-code'
     * @param {object} [options]
     * @param {number} [options.firstByteMs]
     * @param {number} [options.idleMs]
     * @param {number} [options.hardMs]
     */
    constructor(agentId, options = {}) {
        if (new.target === BaseAdapter) {
            throw new Error('BaseAdapter is abstract — use CodexAdapter or ClaudeAdapter');
        }
        /** @type {string} */
        this.agentId = agentId;

        /** @type {Readonly<{firstByteMs: number, idleMs: number, hardMs: number}>} */
        this.timeouts = Object.freeze({
            firstByteMs: options.firstByteMs ?? DEFAULT_TIMEOUTS.firstByteMs,
            idleMs: options.idleMs ?? DEFAULT_TIMEOUTS.idleMs,
            hardMs: options.hardMs ?? DEFAULT_TIMEOUTS.hardMs,
        });
    }

    // ── Abstract methods (MUST override) ─────────────

    /**
     * Build the CLI command and arguments.
     * @param {string} _snapshotPath - Path to code snapshot
     * @param {string} _prompt - Review prompt
     * @returns {{ cmd: string, args: string[] }}
     */
    buildCommand(_snapshotPath, _prompt) {
        throw new Error('buildCommand() must be overridden by subclass');
    }

    /**
     * Parse a raw chunk of output into zero or more Events.
     * Return empty array if the chunk has no actionable content.
     * @param {string} _chunk - Raw output chunk
     * @param {string} _sessionId - Current session ID
     * @returns {import('../schema/events.js').Event[]}
     */
    parseChunk(_chunk, _sessionId) {
        throw new Error('parseChunk() must be overridden by subclass');
    }

    /**
     * Parse accumulated output into final Findings after process exits.
     * @param {string} _allOutput - All concatenated output
     * @param {string} _sessionId - Current session ID
     * @returns {import('../schema/events.js').Finding[]}
     */
    parseResult(_allOutput, _sessionId) {
        throw new Error('parseResult() must be overridden by subclass');
    }

    // ── Core Execute ─────────────────────────────────

    /**
     * Execute the agent CLI process and return a streaming interface.
     *
     * @param {string} sessionId - Session UUID
     * @param {string} snapshotPath - Absolute path to code snapshot
     * @param {string} prompt - Review prompt text
     * @returns {{ stream: AsyncIterable<import('../schema/events.js').Event>, done: Promise<import('../schema/events.js').AdapterResult> }}
     */
    execute(sessionId, snapshotPath, prompt) {
        const { cmd, args } = this.buildCommand(snapshotPath, prompt);
        const adapter = this;

        /** @type {import('../schema/events.js').Event[]} */
        const eventQueue = [];
        let queueResolve = /** @type {(() => void) | null} */ (null);
        let streamDone = false;

        // Telemetry
        const startTime = Date.now();
        /** @type {number | null} */
        let firstByteTime = null;
        let lastActivityTime = startTime;

        /**
         * Push event to the internal queue and wake the async iterator.
         * @param {import('../schema/events.js').Event} event
         */
        function enqueue(event) {
            eventQueue.push(event);
            if (queueResolve) {
                const r = queueResolve;
                queueResolve = null;
                r();
            }
        }

        /**
         * Signal end of stream.
         */
        function endStream() {
            streamDone = true;
            if (queueResolve) {
                const r = queueResolve;
                queueResolve = null;
                r();
            }
        }

        // ── Async Iterable stream ────────────────────
        /** @type {AsyncIterable<import('../schema/events.js').Event>} */
        const stream = {
            [Symbol.asyncIterator]() {
                return {
                    async next() {
                        while (eventQueue.length === 0 && !streamDone) {
                            await new Promise((resolve) => {
                                queueResolve = resolve;
                            });
                        }
                        if (eventQueue.length > 0) {
                            return { value: /** @type {import('../schema/events.js').Event} */ (eventQueue.shift()), done: false };
                        }
                        return { value: undefined, done: true };
                    },
                };
            },
        };

        // ── done Promise (resolves with AdapterResult) ──
        const done = new Promise((resolveDone) => {
            const child = spawn(cmd, args, {
                cwd: snapshotPath,
                stdio: ['ignore', 'pipe', 'pipe'],
                shell: false,
                env: { ...process.env },
            });

            /** @type {string} */
            let allOutput = '';
            let killed = false;

            // StringDecoder instances for proper multibyte UTF-8 handling
            const stdoutDecoder = new StringDecoder('utf-8');
            const stderrDecoder = new StringDecoder('utf-8');

            // Emit status: started
            enqueue(createEvent(sessionId, adapter.agentId, 'status', { state: 'started', cmd, args }));

            // ── Timeout timers ────────────────────────
            let firstByteTimer = setTimeout(() => {
                if (firstByteTime === null && !killed) {
                    killChild('timeout:firstByte');
                }
            }, adapter.timeouts.firstByteMs);

            let idleTimer = /** @type {ReturnType<typeof setTimeout> | null} */ (null);
            function resetIdleTimer() {
                if (idleTimer) clearTimeout(idleTimer);
                idleTimer = setTimeout(() => {
                    if (!killed) {
                        killChild('timeout:idle');
                    }
                }, adapter.timeouts.idleMs);
            }

            const hardTimer = setTimeout(() => {
                if (!killed) {
                    killChild('timeout:hard');
                }
            }, adapter.timeouts.hardMs);

            /**
             * @param {string} source - 'stdout' | 'stderr'
             * @param {Buffer} data
             * @param {StringDecoder} decoder
             */
            function handleOutput(source, data, decoder) {
                const chunk = decoder.write(data);

                // Record first byte timing
                if (firstByteTime === null) {
                    firstByteTime = Date.now();
                    clearTimeout(firstByteTimer);
                    resetIdleTimer(); // Start idle timer after first byte
                }

                // Reset idle on every output
                lastActivityTime = Date.now();
                resetIdleTimer();

                // Garble detection — skip chunks with UTF-8 replacement chars
                if (containsGarble(chunk)) {
                    enqueue(createEvent(sessionId, adapter.agentId, 'raw_output', {
                        source,
                        data: chunk,
                        garbled: true,
                    }));
                    return;
                }

                allOutput += chunk;

                // Let subclass parse chunk into events
                try {
                    const events = adapter.parseChunk(chunk, sessionId);
                    for (const evt of events) {
                        enqueue(evt);
                    }
                } catch (err) {
                    enqueue(createEvent(sessionId, adapter.agentId, 'error', {
                        message: `parseChunk error: ${err instanceof Error ? err.message : String(err)}`,
                        source,
                    }));
                }

                // Always emit raw_output for UI display
                enqueue(createEvent(sessionId, adapter.agentId, 'raw_output', {
                    source,
                    data: chunk,
                    garbled: false,
                }));
            }

            if (child.stdout) {
                child.stdout.on('data', (data) => handleOutput('stdout', data, stdoutDecoder));
            }
            if (child.stderr) {
                child.stderr.on('data', (data) => handleOutput('stderr', data, stderrDecoder));
            }

            // ── Process exit ──────────────────────────
            child.on('close', (code, signal) => {
                clearAllTimers();
                const totalMs = Date.now() - startTime;
                const firstByteMs = firstByteTime ? firstByteTime - startTime : totalMs;
                const lastIdleGapMs = Date.now() - lastActivityTime;

                /** @type {import('../schema/events.js').AdapterResult['status']} */
                let status = 'ok';
                /** @type {import('../schema/events.js').Finding[]} */
                let findings = [];

                if (killed) {
                    status = 'timeout';
                } else if (code !== 0) {
                    status = 'failed';
                }

                // Parse findings from accumulated output
                if (status !== 'timeout') {
                    try {
                        findings = adapter.parseResult(allOutput, sessionId);
                    } catch (err) {
                        enqueue(createEvent(sessionId, adapter.agentId, 'error', {
                            message: `parseResult error: ${err instanceof Error ? err.message : String(err)}`,
                        }));
                        if (status === 'ok') status = 'failed';
                    }
                }

                // Emit status: done
                enqueue(createEvent(sessionId, adapter.agentId, 'status', {
                    state: 'done',
                    exitCode: code,
                    signal,
                    status,
                    findingCount: findings.length,
                }));

                endStream();

                /** @type {import('../schema/events.js').AdapterResult} */
                const result = {
                    status,
                    findings,
                    timingMs: { firstByteMs, lastIdleGapMs, totalMs },
                };

                resolveDone(result);
            });

            // ── Error handling ────────────────────────
            child.on('error', (err) => {
                clearAllTimers();
                enqueue(createEvent(sessionId, adapter.agentId, 'error', {
                    message: `spawn error: ${err.message}`,
                }));
                endStream();
                resolveDone({
                    status: 'failed',
                    findings: [],
                    timingMs: {
                        firstByteMs: firstByteTime ? firstByteTime - startTime : Date.now() - startTime,
                        lastIdleGapMs: Date.now() - lastActivityTime,
                        totalMs: Date.now() - startTime,
                    },
                });
            });

            // ── Kill helper ───────────────────────────
            /**
             * @param {string} reason
             */
            function killChild(reason) {
                if (killed) return;
                killed = true;
                clearAllTimers();

                enqueue(createEvent(sessionId, adapter.agentId, 'status', {
                    state: 'killing',
                    reason,
                }));

                const pid = child.pid;
                if (pid) {
                    if (process.platform === 'win32') {
                        // Windows: taskkill entire process tree
                        try {
                            execSync(`taskkill /T /F /PID ${pid}`, { stdio: 'ignore' });
                        } catch {
                            // Process may already be gone
                        }
                    } else {
                        // POSIX: send SIGTERM, then SIGKILL fallback
                        child.kill('SIGTERM');
                        setTimeout(() => {
                            try { child.kill('SIGKILL'); } catch { /* already dead */ }
                        }, 5000);
                    }
                }
            }

            function clearAllTimers() {
                clearTimeout(firstByteTimer);
                if (idleTimer) clearTimeout(idleTimer);
                clearTimeout(hardTimer);
            }
        });

        return { stream, done };
    }
}

// ── Utility Functions ────────────────────────────────

/**
 * Detect UTF-8 garbled output (replacement character U+FFFD).
 * @param {string} text
 * @returns {boolean}
 */
export function containsGarble(text) {
    return text.includes('\ufffd');
}

export { DEFAULT_TIMEOUTS };

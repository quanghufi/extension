// @ts-check
/**
 * Adapter Execution Engine — streaming process runner with timeout management.
 *
 * Handles:
 * - Spawning CLI processes with cross-platform support
 * - 3-tier timeout (firstByte / idle / hard)
 * - UTF-8 streaming via StringDecoder
 * - Windows process-tree cleanup via `taskkill /T /F`
 * - Async iterable event stream with backpressure
 * - Telemetry: firstByteMs, lastIdleGapMs, totalMs
 *
 * @module adapters/adapter-execution
 */

import { createEvent } from '../schema/events.js';
import spawn from 'cross-spawn';
import { exec } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { containsGarble } from './base-adapter.js';

// ── Event Queue (async iterable infrastructure) ─────

/**
 * Create an event queue with async iterable support.
 * @returns {{ enqueue: (event: import('../schema/events.js').Event) => void, endStream: () => void, stream: AsyncIterable<import('../schema/events.js').Event> }}
 */
export function createEventQueue() {
    /** @type {import('../schema/events.js').Event[]} */
    const eventQueue = [];
    let queueResolve = /** @type {(() => void) | null} */ (null);
    let streamDone = false;

    /** @param {import('../schema/events.js').Event} event */
    function enqueue(event) {
        eventQueue.push(event);
        if (queueResolve) {
            const r = queueResolve;
            queueResolve = null;
            r();
        }
    }

    function endStream() {
        streamDone = true;
        if (queueResolve) {
            const r = queueResolve;
            queueResolve = null;
            r();
        }
    }

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

    return { enqueue, endStream, stream };
}

// ── Timeout Management ──────────────────────────────

/**
 * @typedef {Object} TimeoutSet
 * @property {ReturnType<typeof setTimeout>} firstByte
 * @property {ReturnType<typeof setTimeout> | null} idle
 * @property {ReturnType<typeof setTimeout>} hard
 */

/**
 * Create and manage 3-tier timeout timers.
 * @param {object} params
 * @param {Readonly<{firstByteMs: number, idleMs: number, hardMs: number}>} params.timeouts
 * @param {Record<string, string> | undefined} [params.env]
 * @param {() => boolean} params.hasFirstByte - Returns true if first byte was received
 * @param {(reason: string) => void} params.onTimeout - Called when a timeout fires
 * @returns {{ resetIdle: () => void, clearAll: () => void }}
 */
export function createTimeoutManager({ timeouts, hasFirstByte, onTimeout }) {
    let firstByteTimer = setTimeout(() => {
        if (!hasFirstByte()) {
            onTimeout('timeout:firstByte');
        }
    }, timeouts.firstByteMs);

    let idleTimer = /** @type {ReturnType<typeof setTimeout> | null} */ (null);

    function resetIdle() {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
            onTimeout('timeout:idle');
        }, timeouts.idleMs);
    }

    const hardTimer = setTimeout(() => {
        onTimeout('timeout:hard');
    }, timeouts.hardMs);

    function clearAll() {
        clearTimeout(firstByteTimer);
        if (idleTimer) clearTimeout(idleTimer);
        clearTimeout(hardTimer);
    }

    return { resetIdle, clearAll, clearFirstByte: () => clearTimeout(firstByteTimer) };
}

// ── Process Kill ────────────────────────────────────

/**
 * Kill a child process with platform-specific tree kill.
 * @param {import('child_process').ChildProcess} child
 * @param {string} reason
 * @param {string} sessionId
 * @param {string} agentId
 * @param {(event: import('../schema/events.js').Event) => void} enqueue
 * @returns {void}
 */
export function killChildProcess(child, reason, sessionId, agentId, enqueue) {
    enqueue(createEvent(sessionId, agentId, 'status', {
        state: 'killing',
        reason,
    }));

    const pid = child.pid;
    if (pid) {
        if (process.platform === 'win32') {
            // Windows: taskkill entire process tree
            try {
                exec(`taskkill /T /F /PID ${pid}`, { stdio: 'ignore' }, (err) => {
                    // Log error if taskkill fails, but don't block.
                    // Process might already be gone, which is fine.
                    if (err) {
                        console.warn(`taskkill failed for PID ${pid}:`, err.message);
                    }
                });
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

// ── Output Handler ──────────────────────────────────

/**
 * Handle raw output from a child process stream.
 * @param {object} params
 * @param {string} params.source - 'stdout' | 'stderr'
 * @param {Buffer} params.data
 * @param {StringDecoder} params.decoder
 * @param {string} params.sessionId
 * @param {string} params.agentId
 * @param {(event: import('../schema/events.js').Event) => void} params.enqueue
 * @param {(chunk: string, sessionId: string) => import('../schema/events.js').Event[]} params.parseChunk
 * @param {{ firstByteTime: number | null, lastActivityTime: number, allOutput: string }} params.state
 * @param {{ resetIdle: () => void, clearFirstByte: () => void }} params.timers
 * @returns {void}
 */
export function handleProcessOutput({ source, data, decoder, sessionId, agentId, enqueue, parseChunk, state, timers }) {
    const chunk = decoder.write(data);

    // Record first byte timing
    if (state.firstByteTime === null) {
        state.firstByteTime = Date.now();
        timers.clearFirstByte();
        timers.resetIdle();
    }

    // Reset idle on every output
    state.lastActivityTime = Date.now();
    timers.resetIdle();

    // Garble detection — skip chunks with UTF-8 replacement chars
    if (containsGarble(chunk)) {
        enqueue(createEvent(sessionId, agentId, 'raw_output', {
            source,
            data: chunk,
            garbled: true,
        }));
        return;
    }

    state.allOutput += chunk;

    // Let subclass parse chunk into events
    try {
        const events = parseChunk(chunk, sessionId);
        for (const evt of events) {
            enqueue(evt);
        }
    } catch (err) {
        enqueue(createEvent(sessionId, agentId, 'error', {
            message: `parseChunk error: ${err instanceof Error ? err.message : String(err)}`,
            source,
        }));
    }

    // Always emit raw_output for UI display
    enqueue(createEvent(sessionId, agentId, 'raw_output', {
        source,
        data: chunk,
        garbled: false,
    }));
}

// ── Execute Process ─────────────────────────────────

/**
 * Execute a CLI process and return streaming events + result promise.
 *
 * @param {object} params
 * @param {string} params.sessionId
 * @param {string} params.snapshotPath
 * @param {string} params.agentId
 * @param {{ cmd: string, args: string[], stdinText?: string }} params.command
 * @param {Readonly<{firstByteMs: number, idleMs: number, hardMs: number}>} params.timeouts
 * @param {(chunk: string, sessionId: string) => import('../schema/events.js').Event[]} params.parseChunk
 * @param {(allOutput: string, sessionId: string) => import('../schema/events.js').Finding[]} params.parseResult
 * @returns {{ stream: AsyncIterable<import('../schema/events.js').Event>, done: Promise<import('../schema/events.js').AdapterResult> }}
 */
export function executeProcess({ sessionId, snapshotPath, agentId, command, env, timeouts, parseChunk, parseResult }) {
    const { cmd, args, stdinText } = command;
    const { enqueue, endStream, stream } = createEventQueue();

    const startTime = Date.now();
    const state = {
        /** @type {number | null} */
        firstByteTime: null,
        lastActivityTime: startTime,
        allOutput: '',
    };
    let killed = false;

    const done = new Promise((resolveDone) => {
        const child = spawn(cmd, args, {
            cwd: snapshotPath,
            stdio: ['pipe', 'pipe', 'pipe'],
            shell: false,
            env: { ...process.env, ...(env ?? {}) },
        });

        // StringDecoder instances for proper multibyte UTF-8 handling
        const stdoutDecoder = new StringDecoder('utf-8');
        const stderrDecoder = new StringDecoder('utf-8');

        // Emit status: started
        enqueue(createEvent(sessionId, agentId, 'status', { state: 'started', cmd, args }));

        if (stdinText != null && child.stdin) {
            child.stdin.write(stdinText);
            child.stdin.end();
        }

        // ── Kill helper ───────────────────────────
        function killChild(reason) {
            if (killed) return;
            killed = true;
            timers.clearAll();
            killChildProcess(child, reason, sessionId, agentId, enqueue);
        }

        // ── Timeout timers ────────────────────────
        const timers = createTimeoutManager({
            timeouts,
            hasFirstByte: () => state.firstByteTime !== null,
            onTimeout: (reason) => {
                if (!killed) killChild(reason);
            },
        });

        // ── Pipe stdout/stderr ────────────────────
        if (child.stdout) {
            child.stdout.on('data', (data) => handleProcessOutput({
                source: 'stdout', data, decoder: stdoutDecoder,
                sessionId, agentId, enqueue,
                parseChunk, state, timers,
            }));
        }
        if (child.stderr) {
            child.stderr.on('data', (data) => handleProcessOutput({
                source: 'stderr', data, decoder: stderrDecoder,
                sessionId, agentId, enqueue,
                parseChunk, state, timers,
            }));
        }

        // ── Process exit ──────────────────────────
        child.on('close', (code, signal) => {
            timers.clearAll();
            const totalMs = Date.now() - startTime;
            const firstByteMs = state.firstByteTime ? state.firstByteTime - startTime : totalMs;
            const lastIdleGapMs = Date.now() - state.lastActivityTime;

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
                    findings = parseResult(state.allOutput, sessionId);
                } catch (err) {
                    enqueue(createEvent(sessionId, agentId, 'error', {
                        message: `parseResult error: ${err instanceof Error ? err.message : String(err)}`,
                    }));
                    if (status === 'ok') status = 'failed';
                }
            }

            // Emit status: done
            enqueue(createEvent(sessionId, agentId, 'status', {
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
            timers.clearAll();
            enqueue(createEvent(sessionId, agentId, 'error', {
                message: `spawn error: ${err.message}`,
            }));
            endStream();
            resolveDone({
                status: 'failed',
                findings: [],
                timingMs: {
                    firstByteMs: state.firstByteTime ? state.firstByteTime - startTime : Date.now() - startTime,
                    lastIdleGapMs: Date.now() - state.lastActivityTime,
                    totalMs: Date.now() - startTime,
                },
            });
        });
    });

    return { stream, done };
}

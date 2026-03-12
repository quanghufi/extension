// @ts-check
/**
 * MCP Adapter — Bridges Python MCP review server into the Hub pipeline.
 *
 * State machine:
 *   idle → spawning → initializing → reviewing → done_ok | done_error
 *
 * Spawns `python src/mcp/codex_review_mcp.py` as a child process,
 * communicates via MCP protocol (Content-Length framed messages),
 * and converts MCP review responses into Hub Finding[] objects.
 *
 * @module adapters/mcp-adapter
 */

import { createEvent, createFinding } from '../schema/events.js';
import spawn from 'cross-spawn';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Constants ────────────────────────────────────────

const MCP_SCRIPT = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..', 'mcp', 'codex_review_mcp.py'
);

const MCP_SCHEMA = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..', 'mcp', 'codex_review_schema.json'
);

const STATES = /** @type {const} */ ({
    IDLE: 'idle',
    SPAWNING: 'spawning',
    INITIALIZING: 'initializing',
    REVIEWING: 'reviewing',
    DONE_OK: 'done_ok',
    DONE_ERROR: 'done_error',
});

/** @type {Readonly<{firstByteMs: number, idleMs: number, hardMs: number}>} */
const MCP_TIMEOUTS = Object.freeze({
    firstByteMs: 30_000,
    idleMs: 60_000,
    hardMs: 600_000, // 10min — MCP reviews can take a while
});

const SEVERITY_MAP = /** @type {Record<string, 'critical'|'high'|'medium'|'low'>} */ ({
    critical: 'critical',
    high: 'high',
    medium: 'medium',
    low: 'low',
    error: 'critical',
    warning: 'high',
    info: 'medium',
    hint: 'low',
});

// ── MCP Protocol Helpers ─────────────────────────────

/**
 * Write a Content-Length framed MCP message.
 * @param {import('stream').Writable} stream
 * @param {object} payload
 */
function writeMcpMessage(stream, payload) {
    const body = JSON.stringify(payload);
    const data = Buffer.from(body, 'utf-8');
    stream.write(`Content-Length: ${data.length}\r\n\r\n`);
    stream.write(data);
}

/**
 * Read Content-Length framed MCP messages from a buffer.
 * Returns parsed messages and the remaining buffer.
 *
 * @param {Buffer} buffer
 * @returns {{ messages: object[], remaining: Buffer }}
 */
function parseMcpMessages(buffer) {
    /** @type {object[]} */
    const messages = [];
    let pos = 0;

    while (pos < buffer.length) {
        // Find header/body separator
        const headerEnd = buffer.indexOf('\r\n\r\n', pos);
        if (headerEnd === -1) break;

        // Parse Content-Length from headers
        const headerStr = buffer.subarray(pos, headerEnd).toString('ascii');
        const match = headerStr.match(/Content-Length:\s*(\d+)/i);
        if (!match) break;

        const contentLength = parseInt(match[1], 10);
        const bodyStart = headerEnd + 4;
        const bodyEnd = bodyStart + contentLength;

        if (bodyEnd > buffer.length) break; // Incomplete body

        const bodyStr = buffer.subarray(bodyStart, bodyEnd).toString('utf-8');
        try {
            messages.push(JSON.parse(bodyStr));
        } catch {
            // Skip malformed JSON
        }

        pos = bodyEnd;
    }

    return { messages, remaining: buffer.subarray(pos) };
}

// ── Finding Conversion ───────────────────────────────

/**
 * Convert MCP review findings to Hub Finding[] format.
 *
 * @param {Array<Record<string, unknown>>} mcpFindings - Findings from MCP review
 * @returns {import('../schema/events.js').Finding[]}
 */
function convertMcpFindings(mcpFindings) {
    /** @type {import('../schema/events.js').Finding[]} */
    const results = [];
    for (const f of mcpFindings) {
        const summary = String(f.summary || f.title || f.message || '');
        if (!summary) continue;

        const rawSeverity = String(f.severity || 'medium').toLowerCase();
        const severity = SEVERITY_MAP[rawSeverity] ?? 'medium';
        const rawConfidence = typeof f.confidence === 'number'
            ? Math.max(0, Math.min(1, f.confidence))
            : 0.5;

        results.push(createFinding({
            severity,
            summary,
            evidence: String(f.evidence || f.why_it_matters || ''),
            file: String(f.file || 'unknown'),
            line: typeof f.line === 'number' ? f.line : null,
            confidence: rawConfidence,
            fix_instructions: f.fix_instructions ? String(f.fix_instructions) : null,
            why_it_matters: f.why_it_matters ? String(f.why_it_matters) : null,
        }));
    }
    return results;
}

// ── MCP Adapter Class ────────────────────────────────

export class McpCodexAdapter {
    constructor() {
        /** @type {string} */
        this.agentId = 'mcp-codex';

        /** @type {typeof STATES[keyof typeof STATES]} */
        this._state = STATES.IDLE;

        /** @type {Readonly<{firstByteMs: number, idleMs: number, hardMs: number}>} */
        this.timeouts = MCP_TIMEOUTS;
    }

    /**
     * Optional execution overrides (BaseAdapter interface compatibility).
     * @param {string} _snapshotPath
     * @returns {{ env?: Record<string, string> }}
     */
    getExecutionOptions(_snapshotPath) {
        return {};
    }

    /**
     * Transition state machine.
     * @param {typeof STATES[keyof typeof STATES]} newState
     */
    _transition(newState) {
        this._state = newState;
    }

    /**
     * Build CLI command (BaseAdapter interface compatibility).
     * @param {string} snapshotPath
     * @param {string} _prompt
     * @returns {{ cmd: string, args: string[] }}
     */
    buildCommand(snapshotPath, _prompt) {
        const args = [
            MCP_SCRIPT,
            '--workspace', snapshotPath,
            '--schema', MCP_SCHEMA,
        ];
        // On Windows, Python subprocess.run needs the .cmd extension
        if (process.platform === 'win32') {
            args.push('--codex-command', 'codex.cmd');
        }
        return { cmd: 'python', args };
    }

    /**
     * Parse chunk — not used for MCP (we handle the protocol directly).
     * @param {string} _chunk
     * @param {string} _sessionId
     * @returns {import('../schema/events.js').Event[]}
     */
    parseChunk(_chunk, _sessionId) {
        return [];
    }

    /**
     * Parse result — not used for MCP (we handle the protocol directly).
     * @param {string} _allOutput
     * @param {string} _sessionId
     * @returns {import('../schema/events.js').Finding[]}
     */
    parseResult(_allOutput, _sessionId) {
        return [];
    }

    /**
     * Execute MCP review — main entry point.
     *
     * Spawns the Python MCP server, sends initialize + tools/call requests,
     * parses the structured response, and converts to Hub Finding[].
     *
     * @param {string} sessionId
     * @param {string} projectDir - Project directory to review
     * @param {string|object} prompt - Review prompt string or options object
     *   Options: { prompt, review_target, file_path, max_findings }
     * @returns {{ stream: AsyncIterable<import('../schema/events.js').Event>, done: Promise<import('../schema/events.js').AdapterResult> }}
     */
    execute(sessionId, projectDir, prompt) {
        const agentId = this.agentId;
        const self = this;

        // Parse review options from prompt
        /** @type {{ prompt: string, review_target: string, file_path?: string, max_findings: number }} */
        let reviewOpts;
        if (typeof prompt === 'object' && prompt !== null) {
            const opts = /** @type {Record<string, unknown>} */ (prompt);
            reviewOpts = {
                prompt: String(opts.prompt || ''),
                review_target: String(opts.review_target || 'uncommitted'),
                file_path: opts.file_path ? String(opts.file_path) : undefined,
                max_findings: Number(opts.max_findings || 10),
            };
        } else {
            reviewOpts = {
                prompt: String(prompt || ''),
                review_target: 'uncommitted',
                max_findings: 10,
            };
        }

        /** @type {import('../schema/events.js').Event[]} */
        const eventQueue = [];
        let streamDone = false;
        /** @type {((value?: any) => void) | null} */
        let pendingResolve = null;

        /** @param {import('../schema/events.js').Event} event */
        function enqueue(event) {
            if (pendingResolve) {
                const r = pendingResolve;
                pendingResolve = null;
                r();
            }
            eventQueue.push(event);
        }

        function endStream() {
            streamDone = true;
            if (pendingResolve) {
                const r = pendingResolve;
                pendingResolve = null;
                r();
            }
        }

        /** @type {AsyncIterable<import('../schema/events.js').Event>} */
        const stream = {
            [Symbol.asyncIterator]() {
                return {
                    /** @returns {Promise<IteratorResult<import('../schema/events.js').Event>>} */
                    next() {
                        const item = eventQueue.shift();
                        if (item) {
                            return Promise.resolve(/** @type {IteratorResult<import('../schema/events.js').Event>} */({ value: item, done: false }));
                        }
                        if (streamDone) {
                            return Promise.resolve(/** @type {IteratorResult<import('../schema/events.js').Event>} */({ value: /** @type {any} */ (undefined), done: true }));
                        }
                        return new Promise((resolve) => {
                            pendingResolve = () => {
                                const next = eventQueue.shift();
                                if (next) {
                                    resolve(/** @type {IteratorResult<import('../schema/events.js').Event>} */({ value: next, done: false }));
                                } else {
                                    resolve(/** @type {IteratorResult<import('../schema/events.js').Event>} */({ value: /** @type {any} */ (undefined), done: true }));
                                }
                            };
                        });
                    },
                };
            },
        };

        const startMs = Date.now();

        const done = (async () => {
            /** @type {import('../schema/events.js').Finding[]} */
            let findings = [];
            /** @type {'ok'|'failed'|'timeout'} */
            let status = 'failed';

            try {
                // ── Spawn ────────────────────────────
                self._transition(STATES.SPAWNING);
                enqueue(createEvent(sessionId, agentId, 'status', {
                    state: 'started',
                    text: 'Spawning MCP review server...',
                }));

                const { cmd, args } = self.buildCommand(projectDir, prompt);
                const child = spawn(cmd, args, {
                    stdio: ['pipe', 'pipe', 'pipe'],
                    env: { ...process.env },
                });

                const childStdin = child.stdin;
                const childStdout = child.stdout;
                const childStderr = child.stderr;
                if (!childStdin || !childStdout || !childStderr) {
                    throw new Error('Failed to spawn MCP process — missing stdio');
                }

                let stderrLog = '';
                childStderr.on('data', (/** @type {Buffer} */ chunk) => {
                    stderrLog += chunk.toString('utf-8');
                });

                /** @type {Buffer<ArrayBuffer>} */
                let stdoutBuffer = Buffer.alloc(0);

                /**
                 * Send MCP request and wait for response.
                 * @param {string} method
                 * @param {object} [params]
                 * @param {number} [id]
                 * @returns {Promise<object>}
                 */
                function sendMcpRequest(method, params = {}, id = 1) {
                    return new Promise((resolve, reject) => {
                        const timeoutId = setTimeout(() => {
                            reject(new Error(`MCP request "${method}" timed out after ${self.timeouts.hardMs}ms`));
                        }, self.timeouts.hardMs);

                        /** @param {Buffer} data */
                        function onData(data) {
                            stdoutBuffer = /** @type {Buffer<ArrayBuffer>} */ (Buffer.concat([stdoutBuffer, data]));
                            const { messages, remaining } = parseMcpMessages(stdoutBuffer);
                            stdoutBuffer = /** @type {Buffer<ArrayBuffer>} */ (remaining);

                            for (const msg of messages) {
                                const m = /** @type {Record<string,unknown>} */ (msg);
                                if (m.id === id) {
                                    clearTimeout(timeoutId);
                                    childStdout.removeListener('data', onData);
                                    resolve(m);
                                    return;
                                }
                            }
                        }

                        childStdout.on('data', onData);
                        writeMcpMessage(childStdin, { jsonrpc: '2.0', id, method, params });
                    });
                }

                // ── Initialize ───────────────────────
                self._transition(STATES.INITIALIZING);
                enqueue(createEvent(sessionId, agentId, 'status', {
                    state: 'progress',
                    text: 'Initializing MCP protocol...',
                }));

                await sendMcpRequest('initialize', {
                    protocolVersion: '2025-03-26',
                    capabilities: {},
                    clientInfo: { name: 'extension-hub', version: '0.1.0' },
                }, 1);

                // Send initialized notification (no response expected)
                writeMcpMessage(childStdin, {
                    jsonrpc: '2.0',
                    method: 'notifications/initialized',
                });

                // ── Run Review ───────────────────────
                self._transition(STATES.REVIEWING);
                enqueue(createEvent(sessionId, agentId, 'status', {
                    state: 'progress',
                    text: 'Running Codex review via MCP...',
                }));

                /** @type {Record<string, unknown>} */
                const mcpArgs = {
                    workspace: projectDir,
                    review_target: reviewOpts.review_target,
                    max_findings: reviewOpts.max_findings,
                    instructions: reviewOpts.prompt,
                };
                if (reviewOpts.file_path) {
                    mcpArgs.file_path = reviewOpts.file_path;
                }

                const reviewResponse = await sendMcpRequest('tools/call', {
                    name: 'run_codex_review',
                    arguments: mcpArgs,
                }, 2);

                // ── Parse Response ───────────────────
                const result = /** @type {Record<string,unknown>} */ (reviewResponse);
                const resultPayload = /** @type {Record<string,unknown>} */ (result.result ?? {});
                const structuredContent = /** @type {Record<string,unknown>} */ (
                    resultPayload.structuredContent ?? {}
                );
                const review = /** @type {Record<string,unknown>} */ (
                    structuredContent.review ?? {}
                );
                const mcpFindings = /** @type {Array<Record<string,unknown>>} */ (
                    review.findings ?? []
                );
                const reviewStatus = String(review.status || 'has_findings');

                findings = convertMcpFindings(mcpFindings);

                enqueue(createEvent(sessionId, agentId, 'status', {
                    state: 'progress',
                    text: `Review complete: ${reviewStatus} — ${findings.length} findings`,
                }));

                // Emit individual finding events
                for (const finding of findings) {
                    enqueue(createEvent(sessionId, agentId, 'finding', {
                        finding,
                    }));
                }

                status = 'ok';
                self._transition(STATES.DONE_OK);

                // ── Cleanup ──────────────────────────
                try { childStdin.end(); } catch { /* ignore */ }
                child.kill();

            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                self._transition(STATES.DONE_ERROR);
                enqueue(createEvent(sessionId, agentId, 'error', { message }));

                if (message.includes('timed out')) {
                    status = 'timeout';
                }
            } finally {
                const totalMs = Date.now() - startMs;

                enqueue(createEvent(sessionId, agentId, 'status', {
                    state: 'done',
                    status,
                    findingCount: findings.length,
                }));

                endStream();
            }

            return /** @type {import('../schema/events.js').AdapterResult} */ ({
                status,
                findings,
                timingMs: {
                    firstByteMs: 0,
                    lastIdleGapMs: 0,
                    totalMs: Date.now() - startMs,
                },
            });
        })();

        return { stream, done };
    }
}

export { STATES as MCP_STATES, MCP_TIMEOUTS, convertMcpFindings, parseMcpMessages, writeMcpMessage };

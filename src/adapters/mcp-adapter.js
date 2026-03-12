// @ts-check
/**
 * MCP Adapter — Bridges Python MCP review server into the Hub pipeline.
 *
 * Uses @modelcontextprotocol/sdk Client for protocol handling.
 * Includes error classification and auto-retry for transient failures.
 *
 * State machine:
 *   idle → spawning → initializing → reviewing → done_ok
 *                                               ↘ RECOVERING → spawning (retry)
 *                                               ↘ done_error
 *
 * @module adapters/mcp-adapter
 */

import { createEvent, createFinding } from '../schema/events.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
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
    RECOVERING: 'recovering',
    DONE_OK: 'done_ok',
    DONE_ERROR: 'done_error',
});

/** @type {Readonly<{firstByteMs: number, idleMs: number, hardMs: number}>} */
const MCP_TIMEOUTS = Object.freeze({
    firstByteMs: 30_000,
    idleMs: 60_000,
    hardMs: 600_000, // 10min — MCP reviews can take a while
});

const MAX_RETRIES = 2;

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

// ── Error Classification ─────────────────────────────

/**
 * @typedef {'spawn_error'|'timeout'|'stall'|'protocol_error'|'unknown'} McpErrorType
 */

/**
 * Classify an MCP error into a category for retry decisions.
 *
 * @param {Error|unknown} err
 * @returns {McpErrorType}
 */
function classifyMcpError(err) {
    const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();

    // Spawn failures (ENOENT, missing python, etc.)
    if (msg.includes('enoent') || msg.includes('spawn') || msg.includes('no such file')) {
        return 'spawn_error';
    }

    // Stall detection (idle too long, watchdog) — check before timeout!
    if (msg.includes('stall') || msg.includes('idle') || msg.includes('hung')) {
        return 'stall';
    }

    // Hard timeout
    if (msg.includes('timed out') || msg.includes('timeout')) {
        return 'timeout';
    }

    // Protocol errors (JSON parse, framing, unexpected close)
    if (msg.includes('json') || msg.includes('parse') || msg.includes('unexpected')
        || msg.includes('protocol') || msg.includes('framing') || msg.includes('content-length')) {
        return 'protocol_error';
    }

    return 'unknown';
}

/**
 * Check if an error type is retryable.
 *
 * @param {McpErrorType} errorType
 * @returns {boolean}
 */
function isRetryable(errorType) {
    return errorType === 'spawn_error' || errorType === 'stall';
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

// ── Legacy Protocol Helpers (deprecated) ─────────────

/**
 * Write a Content-Length framed MCP message.
 * @deprecated Use MCP SDK Client instead. Kept for backward compatibility.
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
 * @deprecated Use MCP SDK Client instead. Kept for backward compatibility.
 * @param {Buffer} buffer
 * @returns {{ messages: object[], remaining: Buffer }}
 */
function parseMcpMessages(buffer) {
    /** @type {object[]} */
    const messages = [];
    let pos = 0;

    while (pos < buffer.length) {
        const headerEnd = buffer.indexOf('\r\n\r\n', pos);
        if (headerEnd === -1) break;

        const headerStr = buffer.subarray(pos, headerEnd).toString('ascii');
        const match = headerStr.match(/Content-Length:\s*(\d+)/i);
        if (!match) break;

        const contentLength = parseInt(match[1], 10);
        const bodyStart = headerEnd + 4;
        const bodyEnd = bodyStart + contentLength;

        if (bodyEnd > buffer.length) break;

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
     * Spawns the Python MCP server via SDK Client, calls tools,
     * parses responses, and converts to Hub Finding[].
     * Auto-retries on spawn/stall errors (max 2 retries).
     *
     * @param {string} sessionId
     * @param {string} projectDir - Project directory to review
     * @param {string|object} prompt - Review prompt string or options object
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

            for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
                /** @type {Client | null} */
                let mcpClient = null;
                /** @type {StdioClientTransport | null} */
                let transport = null;

                try {
                    // ── Spawn ────────────────────────────
                    self._transition(STATES.SPAWNING);
                    enqueue(createEvent(sessionId, agentId, 'status', {
                        state: 'started',
                        text: attempt === 0
                            ? 'Spawning MCP review server...'
                            : `Retry ${attempt}/${MAX_RETRIES}: Respawning MCP server...`,
                    }));

                    const { cmd, args } = self.buildCommand(projectDir, prompt);

                    transport = new StdioClientTransport({
                        command: cmd,
                        args,
                        env: { ...process.env },
                        stderr: 'pipe',
                    });

                    // Capture stderr for diagnostics
                    let stderrLog = '';
                    const stderrStream = transport.stderr;
                    if (stderrStream) {
                        stderrStream.on('data', (/** @type {Buffer} */ chunk) => {
                            stderrLog += chunk.toString('utf-8');
                        });
                    }

                    // ── Initialize ───────────────────────
                    self._transition(STATES.INITIALIZING);
                    enqueue(createEvent(sessionId, agentId, 'status', {
                        state: 'progress',
                        text: 'Initializing MCP protocol via SDK...',
                    }));

                    mcpClient = new Client(
                        { name: 'extension-hub', version: '1.0.0' },
                        { capabilities: {} },
                    );

                    // Connect with hard timeout
                    await Promise.race([
                        mcpClient.connect(transport),
                        new Promise((_, reject) => setTimeout(
                            () => reject(new Error(`MCP initialize timed out after ${self.timeouts.firstByteMs}ms`)),
                            self.timeouts.firstByteMs,
                        )),
                    ]);

                    // ── Run Review ───────────────────────
                    self._transition(STATES.REVIEWING);
                    enqueue(createEvent(sessionId, agentId, 'status', {
                        state: 'progress',
                        text: 'Running Codex review via MCP SDK...',
                    }));

                    /** @type {Record<string, unknown>} */
                    const toolArgs = {
                        workspace: projectDir,
                        review_target: reviewOpts.review_target,
                        max_findings: reviewOpts.max_findings,
                        instructions: reviewOpts.prompt,
                    };
                    if (reviewOpts.file_path) {
                        toolArgs.file_path = reviewOpts.file_path;
                    }

                    const result = await Promise.race([
                        mcpClient.callTool({
                            name: 'run_codex_review',
                            arguments: toolArgs,
                        }, undefined, {
                            // Override SDK's DEFAULT_REQUEST_TIMEOUT_MSEC (60s).
                            // Codex reviews take 4-10 minutes.
                            timeout: self.timeouts.hardMs,
                        }),
                        new Promise((_, reject) => setTimeout(
                            () => reject(new Error(`MCP review timed out after ${self.timeouts.hardMs}ms`)),
                            self.timeouts.hardMs,
                        )),
                    ]);

                    // ── Parse Response ───────────────────
                    const resultPayload = /** @type {Record<string,unknown>} */ (result ?? {});
                    const structuredContent = /** @type {Record<string,unknown>} */ (
                        resultPayload.structuredContent ?? {}
                    );
                    const review = /** @type {Record<string,unknown>} */ (
                        structuredContent.review ?? {}
                    );

                    // Also check content array (text-based response fallback)
                    if (!review.findings && Array.isArray(resultPayload.content)) {
                        const textContent = resultPayload.content.find(
                            (/** @type {any} */ c) => c.type === 'text'
                        );
                        if (textContent) {
                            try {
                                const parsed = JSON.parse(/** @type {any} */(textContent).text);
                                if (parsed.review) {
                                    Object.assign(review, parsed.review);
                                } else if (parsed.findings) {
                                    review.findings = parsed.findings;
                                    review.status = parsed.status;
                                }
                            } catch {
                                // Text wasn't JSON, skip
                            }
                        }
                    }

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
                    try { await mcpClient.close(); } catch { /* ignore */ }

                    break; // Success — exit retry loop

                } catch (err) {
                    const message = err instanceof Error ? err.message : String(err);
                    const errorType = classifyMcpError(err);

                    // Cleanup on error
                    try { if (mcpClient) await mcpClient.close(); } catch { /* ignore */ }
                    try { if (transport) await transport.close(); } catch { /* ignore */ }

                    // Check if retryable and retries remain
                    if (isRetryable(errorType) && attempt < MAX_RETRIES) {
                        self._transition(STATES.RECOVERING);
                        enqueue(createEvent(sessionId, agentId, 'status', {
                            state: 'progress',
                            text: `Error: ${message} (${errorType}). Recovering — retry ${attempt + 1}/${MAX_RETRIES}...`,
                        }));

                        // Backoff before retry
                        const delay = Math.min(1000 * 2 ** attempt, 5000);
                        await new Promise((r) => setTimeout(r, delay));
                        continue;
                    }

                    // Non-retryable or retries exhausted
                    self._transition(STATES.DONE_ERROR);
                    enqueue(createEvent(sessionId, agentId, 'error', {
                        message: attempt > 0
                            ? `${message} (${errorType}, after ${attempt + 1} attempts)`
                            : message,
                    }));

                    if (errorType === 'timeout') {
                        status = 'timeout';
                    }
                    break;
                }
            }

            const totalMs = Date.now() - startMs;

            enqueue(createEvent(sessionId, agentId, 'status', {
                state: 'done',
                status,
                findingCount: findings.length,
            }));

            endStream();

            return /** @type {import('../schema/events.js').AdapterResult} */ ({
                status,
                findings,
                timingMs: {
                    firstByteMs: 0,
                    lastIdleGapMs: 0,
                    totalMs,
                },
            });
        })();

        return { stream, done };
    }
}

export { STATES as MCP_STATES, MCP_TIMEOUTS, convertMcpFindings, parseMcpMessages, writeMcpMessage, classifyMcpError, isRetryable, MAX_RETRIES };

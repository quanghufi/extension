// @ts-check
/**
 * Minimal smoke test for the real Codex adapter.
 *
 * Verifies:
 * - current Codex CLI command shape works end-to-end
 * - JSONL streaming does not crash parsing
 * - final structured output `[]` is parsed successfully
 *
 * Usage:
 *   node scripts/codex-smoke.js
 */

import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexAdapter } from '../src/adapters/codex-adapter.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

const adapter = new CodexAdapter({
    firstByteMs: 20_000,
    idleMs: 15_000,
    hardMs: 60_000,
});

const sessionId = `smoke-${randomUUID()}`;
const snapshotPath = repoRoot;
const prompt = 'Return exactly [] as the final answer. Do not run shell commands.';

console.log('[codex-smoke] Starting real Codex adapter smoke test');
console.log(`[codex-smoke] sessionId=${sessionId}`);
console.log(`[codex-smoke] snapshotPath=${snapshotPath} (resolved from import.meta.url)`);

try {
    const { stream, done } = adapter.execute(sessionId, snapshotPath, prompt);

    let eventCount = 0;
    let sawAgentMessage = false;
    /** @type {string | undefined} */
    let lastAgentMessageText;
    for await (const event of stream) {
        eventCount += 1;
        if (event.event_type === 'status' && event.payload?.state === 'agent_message') {
            if (typeof event.payload?.text === 'string') {
                sawAgentMessage = true;
                lastAgentMessageText = event.payload.text;
            }
        }
    }

    const result = await done;

    console.log(`[codex-smoke] status=${result.status}`);
    console.log(`[codex-smoke] eventCount=${eventCount}`);
    console.log(`[codex-smoke] findingCount=${result.findings.length}`);
    console.log(`[codex-smoke] totalMs=${result.timingMs.totalMs}`);

    if (result.status !== 'ok') {
        console.error('[codex-smoke] FAIL: adapter status is not ok');
        process.exit(1);
    }

    if (!sawAgentMessage || lastAgentMessageText === undefined) {
        console.error('[codex-smoke] FAIL: no agent_message event with valid text seen — cannot verify final [] payload');
        process.exit(1);
    }

    // Validate the last agent_message actually contains a valid empty JSON array
    try {
        const parsed = JSON.parse(lastAgentMessageText);
        if (!Array.isArray(parsed)) {
            console.error('[codex-smoke] FAIL: last agent_message is not a JSON array');
            process.exit(1);
        }
        if (parsed.length !== 0) {
            console.error(`[codex-smoke] FAIL: expected empty array [], got array with ${parsed.length} items`);
            process.exit(1);
        }
        console.log('[codex-smoke] lastAgentMessage verified as empty JSON array []');
    } catch {
        console.error('[codex-smoke] FAIL: last agent_message is not valid JSON — cannot verify structured output');
        process.exit(1);
    }

    if (result.findings.length !== 0) {
        console.error('[codex-smoke] FAIL: expected zero findings for [] smoke prompt');
        process.exit(1);
    }

    console.log('[codex-smoke] PASS');
    process.exit(0);
} catch (error) {
    console.error('[codex-smoke] FAIL:', error instanceof Error ? error.message : String(error));
    process.exit(1);
}

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
import { CodexAdapter } from '../src/adapters/codex-adapter.js';

const adapter = new CodexAdapter({
    firstByteMs: 20_000,
    idleMs: 15_000,
    hardMs: 60_000,
});

const sessionId = `smoke-${randomUUID()}`;
const snapshotPath = process.cwd();
const prompt = 'Return exactly [] as the final answer. Do not run shell commands.';

console.log('[codex-smoke] Starting real Codex adapter smoke test');
console.log(`[codex-smoke] sessionId=${sessionId}`);
console.log(`[codex-smoke] snapshotPath=${snapshotPath}`);

try {
    const { stream, done } = adapter.execute(sessionId, snapshotPath, prompt);

    let eventCount = 0;
    for await (const _event of stream) {
        eventCount += 1;
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

// @ts-check
/**
 * E2E Integration Test — Agent Communication Hub
 *
 * Tests the full pipeline:
 *   Server → Snapshot → Adapter(s) → Session → WebSocket → Dashboard
 *
 * Usage:
 *   node scripts/e2e-test.js                          # Run both agents
 *   node scripts/e2e-test.js --agent codex             # Run only Codex
 *   node scripts/e2e-test.js --agent claude            # Run only Claude
 *   node scripts/e2e-test.js --project d:\some\path    # Custom project dir
 *   node scripts/e2e-test.js --no-browser              # Skip browser open
 *   node scripts/e2e-test.js --dry-run                 # Create session but skip agent execution
 *   node scripts/e2e-test.js --auto-exit               # Exit after finalization (CI-friendly)
 *
 * Exit codes:
 *   0 = success (findings may or may not exist, but pipeline worked)
 *   1 = infrastructure failure (server, snapshot, adapter crash)
 */

import { HubServer } from '../src/server.js';
import { Session } from '../src/hub/session.js';
import { SnapshotManager } from '../src/snapshot/snapshot-manager.js';
import { CodexAdapter } from '../src/adapters/codex-adapter.js';
import { ClaudeAdapter } from '../src/adapters/claude-adapter.js';
import { createEvent } from '../src/schema/events.js';
import path from 'node:path';
import { execSync } from 'node:child_process';

// ── CLI Args ─────────────────────────────────────────

const args = process.argv.slice(2);
const getArg = (name) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
};
const hasFlag = (name) => args.includes(`--${name}`);

const AGENT_FILTER = getArg('agent'); // 'codex' | 'claude' | null (both)
const PROJECT_DIR = getArg('project') ?? process.cwd();
const NO_BROWSER = hasFlag('no-browser');
const DRY_RUN = hasFlag('dry-run');
const AUTO_EXIT = hasFlag('auto-exit');
const PORT = parseInt(getArg('port') ?? '3847', 10);

// ── Logger ───────────────────────────────────────────

const log = {
    step: (n, msg) => console.log(`\n${'─'.repeat(60)}\n  Step ${n}: ${msg}\n${'─'.repeat(60)}`),
    info: (msg) => console.log(`  ℹ ${msg}`),
    ok: (msg) => console.log(`  ✅ ${msg}`),
    warn: (msg) => console.log(`  ⚠ ${msg}`),
    fail: (msg) => console.error(`  ❌ ${msg}`),
    data: (label, value) => console.log(`  📊 ${label}: ${typeof value === 'object' ? JSON.stringify(value, null, 2) : value}`),
};

// ── Main ─────────────────────────────────────────────

async function main() {
    console.log(`
╔════════════════════════════════════════════════════════╗
║  🧪 E2E Integration Test — Agent Communication Hub    ║
║  Project: ${PROJECT_DIR.padEnd(44)}║
║  Agents:  ${(AGENT_FILTER ?? 'codex + claude').padEnd(44)}║
║  Port:    ${String(PORT).padEnd(44)}║
╚════════════════════════════════════════════════════════╝
`);

    let server = null;
    let snapshotPath = null;
    const snapshotManager = new SnapshotManager(path.join(PROJECT_DIR, 'tmp', 'e2e-snapshots'));

    // Expose to SIGINT handler (FB-20260308-E2E-002)
    _sigintSnapshotMgr = snapshotManager;

    try {
        // ── Step 1: Start Hub Server ──────────────────

        log.step(1, 'Starting Hub Server');
        server = new HubServer({
            port: PORT,
            dataDir: path.join(PROJECT_DIR, 'tmp', 'e2e-data'),
            snapshotDir: path.join(PROJECT_DIR, 'tmp', 'e2e-snapshots'),
        });
        await server.start();
        _sigintServer = server; // Expose to SIGINT handler
        log.ok(`Server listening on http://localhost:${PORT}`);

        // Quick health check
        const healthRes = await fetch(`http://localhost:${PORT}/api/sessions`);
        if (!healthRes.ok) throw new Error(`Health check failed: ${healthRes.status}`);
        log.ok('Health check passed');

        // ── Step 2: Create Snapshot ───────────────────

        log.step(2, 'Creating Code Snapshot');
        const snapshot = snapshotManager.create(PROJECT_DIR, { useGitWorktree: true });
        snapshotPath = snapshot.path;
        _sigintSnapshotPath = snapshotPath; // Expose to SIGINT handler
        log.ok(`Snapshot created: ${snapshot.id}`);
        log.data('Method', snapshot.method);
        log.data('Path', snapshot.path);

        // Verify read-only
        const verify = snapshotManager.verify(snapshot.path);
        if (verify.readOnly) {
            log.ok('Snapshot is read-only ✓');
        } else {
            log.warn(`Snapshot protection incomplete: ${verify.error}`);
        }

        // ── Step 3: Create Session ────────────────────

        log.step(3, 'Creating Review Session');
        const session = new Session({
            projectDir: PROJECT_DIR,
            prompt: 'Review this code for bugs, security issues, and code quality problems. Focus on: error handling, input validation, race conditions, and resource leaks.',
            snapshotPath: snapshot.path,
        });
        server.activeSessions.set(session.id, session);
        server.store.save(session);
        session.start();

        log.ok(`Session created: ${session.id}`);
        log.data('State', session.state);

        // Verify via REST API
        const sessionRes = await fetch(`http://localhost:${PORT}/api/sessions/${session.id}`);
        const sessionData = await sessionRes.json();
        log.ok(`Session visible via API: ${sessionData.session.state}`);

        if (DRY_RUN) {
            log.step(4, 'DRY RUN — Skipping agent execution');
            log.info('Session created and server running. Open the dashboard to verify.');

            if (!NO_BROWSER) {
                openBrowser(`http://localhost:${PORT}`);
            }

            if (AUTO_EXIT) {
                log.ok('--auto-exit: exiting after dry-run setup');
                await cleanup(server, snapshotManager, snapshotPath);
                process.exit(0);
            }

            log.info('Press Ctrl+C to stop.');
            await new Promise(() => { }); // block forever
        }

        // ── Step 4: Run Agent Adapters ────────────────

        log.step(4, 'Running Agent Adapters');

        const adapters = [];
        if (!AGENT_FILTER || AGENT_FILTER === 'codex') {
            adapters.push({ name: 'Codex', adapter: new CodexAdapter() });
        }
        if (!AGENT_FILTER || AGENT_FILTER === 'claude') {
            adapters.push({ name: 'Claude', adapter: new ClaudeAdapter() });
        }

        log.info(`Running ${adapters.length} adapter(s): ${adapters.map(a => a.name).join(', ')}`);

        /** @type {{ name: string, findings: any[], error: string|null }[]} */
        const results = [];

        // Run adapters in parallel
        const adapterPromises = adapters.map(async ({ name, adapter }) => {
            log.info(`[${name}] Starting...`);
            session.registerAgent(adapter.agentId);

            // Emit "started" event
            const startEvent = createEvent(session.id, adapter.agentId, 'status', { state: 'started' });
            const seqStart = session.addEvent(startEvent);
            server.broadcast(session.id, seqStart);

            try {
                const { stream, done } = adapter.execute(session.id, snapshot.path, session.prompt);

                // Stream events to session + WebSocket
                let eventCount = 0;
                for await (const event of stream) {
                    const seqEvent = session.addEvent(event);
                    server.broadcast(session.id, seqEvent);
                    eventCount++;

                    // Progress log every 10 events
                    if (eventCount % 10 === 0) {
                        log.info(`[${name}] ${eventCount} events streamed...`);
                    }
                }

                // Await final result
                const result = await done;
                log.info(`[${name}] Process finished: status=${result.status}, findings=${result.findings.length}`);

                // Emit "done" event
                const doneEvent = createEvent(session.id, adapter.agentId, 'status', {
                    state: 'done',
                    status: result.status,
                    findingCount: result.findings.length,
                    timingMs: result.timingMs,
                });
                const seqDone = session.addEvent(doneEvent);
                server.broadcast(session.id, seqDone);

                results.push({ name, findings: result.findings, error: null });
            } catch (err) {
                const errorMsg = err instanceof Error ? err.message : String(err);
                log.fail(`[${name}] Adapter error: ${errorMsg}`);

                // Emit error event
                const errorEvent = createEvent(session.id, adapter.agentId, 'error', {
                    message: errorMsg,
                });
                try {
                    const seqErr = session.addEvent(errorEvent);
                    server.broadcast(session.id, seqErr);
                } catch { /* session may be terminal */ }

                results.push({ name, findings: [], error: errorMsg });
            }
        });

        await Promise.allSettled(adapterPromises);

        // ── Step 5: Finalize Session ──────────────────

        log.step(5, 'Finalizing Session');

        const allFindings = results.flatMap(r => r.findings);
        const allErrors = results.filter(r => r.error);
        const finalState = allErrors.length === results.length
            ? 'failed'
            : allErrors.length > 0
                ? 'partial_completion'
                : 'completed';

        session.finalize(finalState, allFindings);
        server.store.save(session);

        log.ok(`Session finalized: ${finalState}`);
        log.data('Total findings', allFindings.length);
        log.data('Grouped findings', session.groupedFindings.length);
        log.data('Total events', session.events.length);

        // ── Step 6: Verify Results ────────────────────

        log.step(6, 'Verification');

        // Check REST API returns correct data
        const finalRes = await fetch(`http://localhost:${PORT}/api/sessions/${session.id}`);
        const finalData = await finalRes.json();

        const checks = [
            { test: 'Session state matches', pass: finalData.session.state === finalState },
            { test: 'Events recorded', pass: finalData.session.events.length > 0 },
            { test: 'Findings preserved', pass: finalData.session.allFindings.length === allFindings.length },
            { test: 'Findings grouped', pass: Array.isArray(finalData.session.groupedFindings) },
            { test: 'CompletedAt set', pass: !!finalData.session.completedAt },
        ];

        let allPassed = true;
        for (const check of checks) {
            if (check.pass) {
                log.ok(check.test);
            } else {
                log.fail(check.test);
                allPassed = false;
            }
        }

        // ── Step 7: Report ────────────────────────────

        log.step(7, 'Report');

        console.log(`
╔════════════════════════════════════════════════════════╗
║  E2E INTEGRATION TEST REPORT                          ║
╠════════════════════════════════════════════════════════╣
║  Session ID:      ${session.id.slice(0, 36).padEnd(37)}║
║  Final State:     ${finalState.padEnd(37)}║
║  Events:          ${String(session.events.length).padEnd(37)}║
║  Raw Findings:    ${String(allFindings.length).padEnd(37)}║
║  Grouped (dedup): ${String(session.groupedFindings.length).padEnd(37)}║
║  Verification:    ${(allPassed ? '✅ ALL PASSED' : '❌ SOME FAILED').padEnd(37)}║
╚════════════════════════════════════════════════════════╝`);

        // Per-agent breakdown
        for (const r of results) {
            const status = r.error ? `❌ ${r.error.slice(0, 50)}` : `✅ ${r.findings.length} findings`;
            log.data(r.name, status);
        }

        // Severity breakdown
        if (allFindings.length > 0) {
            const bySeverity = { critical: 0, high: 0, medium: 0, low: 0 };
            for (const f of allFindings) {
                bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;
            }
            console.log('\n  📊 Severity Breakdown:');
            for (const [sev, count] of Object.entries(bySeverity)) {
                if (count > 0) console.log(`     ${sev}: ${count}`);
            }
        }

        // ── Step 8: Dashboard ─────────────────────────

        if (!NO_BROWSER && !AUTO_EXIT) {
            log.step(8, 'Opening Dashboard');
            openBrowser(`http://localhost:${PORT}`);
            log.ok('Dashboard opened — select the session from the dropdown');
            log.info('Press Ctrl+C to stop the server');

            // Keep server running for manual inspection
            await new Promise(() => { }); // block forever
        } else if (AUTO_EXIT) {
            log.ok('--auto-exit: skipping dashboard, exiting cleanly');
        }

        // Exit
        await cleanup(server, snapshotManager, snapshotPath);
        process.exit(allPassed ? 0 : 1);

    } catch (err) {
        log.fail(`Fatal error: ${err instanceof Error ? err.message : String(err)}`);
        if (err instanceof Error && err.stack) {
            console.error(err.stack);
        }
        await cleanup(server, snapshotManager, snapshotPath);
        process.exit(1);
    }
}

// ── Helpers ──────────────────────────────────────────

async function cleanup(server, snapshotManager, snapshotPath) {
    console.log('\n🧹 Cleaning up...');
    try {
        if (server) await server.stop();
    } catch { /* ignore */ }
    try {
        if (snapshotPath && snapshotManager) {
            snapshotManager.remove(snapshotPath);
        }
    } catch { /* ignore */ }
}

function openBrowser(url) {
    try {
        if (process.platform === 'win32') {
            execSync(`start "" "${url}"`, { stdio: 'pipe' });
        } else if (process.platform === 'darwin') {
            execSync(`open "${url}"`, { stdio: 'pipe' });
        } else {
            execSync(`xdg-open "${url}"`, { stdio: 'pipe' });
        }
    } catch {
        log.warn(`Could not open browser. Visit manually: ${url}`);
    }
}

// ── Signal Handling ──────────────────────────────────

// FB-20260308-E2E-002: Wire cleanup into SIGINT to remove stale snapshots
let _sigintServer = null;
let _sigintSnapshotMgr = null;
let _sigintSnapshotPath = null;

process.on('SIGINT', async () => {
    console.log('\n\n🛑 Interrupted — cleaning up...');
    await cleanup(_sigintServer, _sigintSnapshotMgr, _sigintSnapshotPath);
    process.exit(0);
});

// ── Run ──────────────────────────────────────────────
main();

// @ts-check
/**
 * Codex Review via Hub — "Dogfooding" Script
 *
 * Uses the Agent Communication Hub to orchestrate a real Codex review
 * of the extension project itself.
 *
 * Pipeline:
 *   1. Start Hub server
 *   2. Create session
 *   3. Spawn Codex review (via PowerShell wrapper for gpt-5.4/xhigh)
 *   4. Parse Codex output → events → session
 *   5. Display results on dashboard
 *
 * Usage:
 *   node scripts/hub-codex-review.js                    # Review uncommitted changes
 *   node scripts/hub-codex-review.js --all              # Review entire codebase
 *   node scripts/hub-codex-review.js --no-browser       # Skip opening browser
 *   node scripts/hub-codex-review.js --auto-exit        # Exit after review (CI-friendly)
 */

import http from 'node:http';
import { HubServer } from '../src/server.js';
import { Session } from '../src/hub/session.js';
import { SnapshotManager } from '../src/snapshot/snapshot-manager.js';
import { createEvent, createFinding } from '../src/schema/events.js';
import { normalizeFindingPath } from '../src/utils/paths.js';
import { execSync, spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

// ── Config ───────────────────────────────────────────

const args = process.argv.slice(2);
const hasFlag = (/** @type {string} */ name) => args.includes(`--${name}`);

const PROJECT_DIR = path.resolve('.');
const PORT = 3847;
const NO_BROWSER = hasFlag('no-browser');
const REVIEW_ALL = hasFlag('all');
const AUTO_EXIT = hasFlag('auto-exit');
const CODEX_SCRIPT = path.join(
    process.env.USERPROFILE ?? '',
    '.gemini', 'antigravity', 'scripts', 'codex-xhigh-review.ps1'
);

// ── Main ─────────────────────────────────────────────

async function main() {
    console.log(`
╔════════════════════════════════════════════════════════════╗
║  🧪 Codex Review via Hub — Dogfooding Edition             ║
║  Project: ${PROJECT_DIR.padEnd(48)}║
║  Mode:    ${(REVIEW_ALL ? 'Full codebase' : 'Uncommitted changes').padEnd(48)}║
╚════════════════════════════════════════════════════════════╝
`);

    // ── Step 1: Start Hub Server ──────────────────────

    console.log('📡 Step 1: Starting Hub Server...');
    const server = new HubServer({
        port: PORT,
        dataDir: path.join(PROJECT_DIR, 'tmp', 'hub-data'),
        snapshotDir: path.join(PROJECT_DIR, 'tmp', 'hub-snapshots'),
    });

    try {
        await server.start();
    } catch (err) {
        // Port might be in use
        console.error(`❌ Failed to start server on port ${PORT}: ${err}`);
        console.log('   Try: npx kill-port 3847');
        process.exit(1);
    }

    // ── Step 2: Create Session ────────────────────────

    console.log('📝 Step 2: Creating review session...');
    const session = new Session({
        projectDir: PROJECT_DIR,
        prompt: 'Codex review via Hub (gpt-5.4 / reasoning: xhigh)',
    });
    server.activeSessions.set(session.id, session);
    server.store.save(session);
    session.start();
    session.registerAgent('codex');

    // Emit started event
    const startEvt = createEvent(session.id, 'codex', 'status', { state: 'started' });
    const seqStart = session.addEvent(startEvt);
    server.broadcast(session.id, seqStart);
    server.store.save(session);

    console.log(`   Session: ${session.id}`);

    // ── Step 3: Create Snapshot (FB-20260308-SNAP-003) ──

    console.log('📸 Step 3: Creating immutable snapshot...');
    const snapshotManager = new SnapshotManager(path.join(PROJECT_DIR, 'tmp', 'hub-snapshots'));
    // Expose to SIGINT handler for cleanup
    _sigintSnapshotMgr = snapshotManager;
    _sigintServer = server;

    let snapshotPath;
    try {
        const snapshot = snapshotManager.create(PROJECT_DIR, { useGitWorktree: true });
        snapshotPath = snapshot.path;
        _sigintSnapshotPath = snapshotPath;
        session.snapshotPath = snapshotPath;
        console.log(`   Snapshot: ${snapshot.id} (${snapshot.method})`);
    } catch (snapErr) {
        console.warn(`   ⚠ Snapshot creation failed: ${snapErr}`);
        console.warn('   Falling back to live tree (mutable)');
        snapshotPath = PROJECT_DIR;
    }

    // ── Step 4: Open Dashboard ────────────────────────

    if (!NO_BROWSER && !AUTO_EXIT) {
        console.log('🌐 Step 4: Opening dashboard...');
        try {
            execSync(`start "" "http://localhost:${PORT}"`, { stdio: 'pipe' });
        } catch {
            console.log(`   ⚠ Open manually: http://localhost:${PORT}`);
        }
    }

    // ── Step 5: Run Codex Review ──────────────────────

    console.log('🤖 Step 5: Running Codex review (gpt-5.4 / xhigh)...');
    console.log('   This may take 2-5 minutes...');
    console.log(`   CWD: ${snapshotPath}`);

    const outputFile = path.join(PROJECT_DIR, 'tmp', `codex-review-${Date.now()}.md`);

    // Build PowerShell command
    const psArgs = [
        '-NoProfile', '-ExecutionPolicy', 'Bypass',
        '-File', CODEX_SCRIPT,
        '-OutputFile', outputFile,
    ];

    if (!REVIEW_ALL) {
        psArgs.push('-Uncommitted');
    }

    // Progress events while waiting
    const progressInterval = setInterval(() => {
        try {
            const evt = createEvent(session.id, 'codex', 'status', {
                state: 'progress',
                text: 'Codex is reviewing code...',
            });
            if (!session.isTerminal()) {
                const seqEvt = session.addEvent(evt);
                server.broadcast(session.id, seqEvt);
            }
        } catch { /* ignore if session terminal */ }
    }, 15_000);

    try {
        // Run Codex review synchronously (it takes a while)
        const result = execSync(
            `powershell.exe ${psArgs.map(a => `"${a}"`).join(' ')}`,
            {
                cwd: snapshotPath, // FB-20260308-SNAP-003: Run against immutable snapshot
                encoding: 'utf-8',
                timeout: 600_000, // 10min max
                stdio: ['pipe', 'pipe', 'pipe'],
            }
        );

        clearInterval(progressInterval);
        console.log('   ✅ Codex review completed');

        // Read output
        let codexOutput = '';
        if (fs.existsSync(outputFile)) {
            codexOutput = fs.readFileSync(outputFile, 'utf-8');
        } else if (result) {
            codexOutput = result;
        }

        // Emit raw output event
        const rawEvt = createEvent(session.id, 'codex', 'raw_output', {
            source: 'stdout',
            data: codexOutput.slice(0, 5000), // First 5KB for UI display
            garbled: false,
        });
        const seqRaw = session.addEvent(rawEvt);
        server.broadcast(session.id, seqRaw);

        // ── Step 6: Parse Findings ────────────────────

        console.log('🔍 Step 6: Parsing findings...');
        const findings = parseCodexMarkdownOutput(codexOutput, PROJECT_DIR);
        console.log(`   Found ${findings.length} findings`);

        // ── Step 7: Finalize Session ──────────────────

        console.log('📊 Step 7: Finalizing session...');

        // Emit done event
        const doneEvt = createEvent(session.id, 'codex', 'status', {
            state: 'done',
            status: 'ok',
            findingCount: findings.length,
        });
        const seqDone = session.addEvent(doneEvt);
        server.broadcast(session.id, seqDone);

        session.finalize('completed', findings);
        server.store.save(session);

        // ── Step 8: Save to .feedback ─────────────────

        console.log('💾 Step 8: Saving to .feedback/...');
        const feedbackDir = path.join(PROJECT_DIR, '.feedback');
        if (!fs.existsSync(feedbackDir)) {
            fs.mkdirSync(feedbackDir, { recursive: true });
        }

        // Save raw output as inbox
        const inboxVersion = getNextVersion(feedbackDir, 'inbox');
        const inboxPath = path.join(feedbackDir, `inbox-${inboxVersion}.md`);
        fs.writeFileSync(inboxPath, codexOutput, 'utf-8');
        console.log(`   📥 Saved: ${inboxPath}`);

        // ── Report ────────────────────────────────────

        console.log(`
╔════════════════════════════════════════════════════════════╗
║  CODEX REVIEW VIA HUB — RESULTS                          ║
╠════════════════════════════════════════════════════════════╣
║  Session:     ${session.id.padEnd(44)}║
║  State:       completed                                   ║
║  Events:      ${String(session.events.length).padEnd(44)}║
║  Findings:    ${String(findings.length).padEnd(44)}║
║  Grouped:     ${String(session.groupedFindings.length).padEnd(44)}║
║  Inbox saved: ${inboxVersion.padEnd(44)}║
║  Dashboard:   http://localhost:${PORT}${' '.repeat(28)}║
╚════════════════════════════════════════════════════════════╝`);

        // Print severity summary
        if (findings.length > 0) {
            console.log('\n  📊 Severity Breakdown:');
            const counts = { critical: 0, high: 0, medium: 0, low: 0 };
            for (const f of findings) {
                counts[/** @type {keyof typeof counts} */ (f.severity)] =
                    (counts[/** @type {keyof typeof counts} */ (f.severity)] ?? 0) + 1;
            }
            for (const [sev, cnt] of Object.entries(counts)) {
                if (cnt > 0) console.log(`     ${sev}: ${cnt}`);
            }
        }

        console.log('\n  💡 Next steps:');
        console.log('     1. View findings on dashboard: select session from dropdown');
        console.log('     2. Triage findings: create responses file');
        console.log('     3. Press Ctrl+C when done to stop server');

        // Keep server alive for dashboard inspection OR auto-exit
        if (AUTO_EXIT) {
            console.log('\n  🚀 --auto-exit: exiting cleanly...');
            await cleanupResources(server, snapshotManager, snapshotPath);
            process.exit(0);
        }

        await new Promise(() => { });

    } catch (/** @type {any} */ err) {
        clearInterval(progressInterval);

        // Emit error
        const errEvt = createEvent(session.id, 'codex', 'error', {
            message: err?.message ?? String(err),
        });
        try {
            const seqErr = session.addEvent(errEvt);
            server.broadcast(session.id, seqErr);
        } catch { /* */ }

        // Emit done with failed status
        const doneEvt = createEvent(session.id, 'codex', 'status', {
            state: 'done',
            status: 'failed',
            findingCount: 0,
        });
        try {
            const seqDone = session.addEvent(doneEvt);
            server.broadcast(session.id, seqDone);
        } catch { /* */ }

        session.finalize('failed', []);
        server.store.save(session);

        console.error(`\n❌ Codex review failed: ${err?.message ?? err}`);

        // Check common issues
        if (!fs.existsSync(CODEX_SCRIPT)) {
            console.error(`   Script not found: ${CODEX_SCRIPT}`);
        }

        console.log('\n   Dashboard is still running for debugging.');
        console.log('   Press Ctrl+C to stop.');

        if (AUTO_EXIT) {
            console.log('\n  🚀 --auto-exit: exiting after failure...');
            await cleanupResources(server, snapshotManager, snapshotPath);
            process.exit(1);
        }

        await new Promise(() => { });
    }
}

// ── Codex Output Parser ──────────────────────────────

/**
 * Parse Codex markdown review output into structured findings.
 * Codex outputs in markdown format with sections for each finding.
 *
 * @param {string} output - Raw Codex markdown output
 * @param {string} projectDir - Project root for path normalization
 * @returns {import('../src/schema/events.js').Finding[]}
 */
function parseCodexMarkdownOutput(output, projectDir) {
    /** @type {import('../src/schema/events.js').Finding[]} */
    const findings = [];

    if (!output || output.trim().length === 0) return findings;

    // Pattern 1: ### Finding blocks with severity markers
    // Looks for patterns like:
    //   ### [Critical] Summary here
    //   **File**: `path/to/file.js:42`
    //   **Evidence**: ...
    const findingBlockRegex = /###\s*\[?(critical|high|medium|low|warning|error|info|note)\]?\s*[:\-–]?\s*(.+?)(?:\n|\r\n)([\s\S]*?)(?=###\s*\[|##\s|$)/gi;

    let match;
    while ((match = findingBlockRegex.exec(output)) !== null) {
        const severity = mapSeverity(match[1]);
        const summary = match[2].trim();
        const body = match[3];

        // Extract file reference
        const fileMatch = body.match(/\*?\*?(?:File|Path|Location)\*?\*?\s*:?\s*`?([^`\n]+?(?:\.\w+)(?::\d+)?)`?/i);
        const rawFile = fileMatch ? fileMatch[1].replace(/:\d+$/, '') : 'unknown';
        const lineMatch = fileMatch ? fileMatch[1].match(/:(\d+)$/) : null;

        let normalizedFile;
        try {
            normalizedFile = normalizeFindingPath(rawFile, projectDir);
        } catch {
            normalizedFile = rawFile;
        }

        findings.push(createFinding({
            severity,
            summary,
            evidence: body.trim().slice(0, 500),
            file: normalizedFile,
            line: lineMatch ? parseInt(lineMatch[1], 10) : null,
            confidence: 0.7,
        }));
    }

    // Pattern 2: Numbered list items with severity
    // 1. **[High]** Summary — `file.js:10`
    if (findings.length === 0) {
        const listRegex = /\d+\.\s*\*?\*?\[?(critical|high|medium|low|warning|error|info)\]?\*?\*?\s*[:\-–]?\s*(.+?)(?:\s*[—–-]\s*`([^`]+)`)?(?:\n|$)/gi;

        while ((match = listRegex.exec(output)) !== null) {
            const severity = mapSeverity(match[1]);
            const summary = match[2].trim();
            const rawFile = match[3] ?? 'unknown';
            const lineMatch = rawFile.match(/:(\d+)$/);

            let normalizedFile;
            try {
                normalizedFile = normalizeFindingPath(rawFile.replace(/:\d+$/, ''), projectDir);
            } catch {
                normalizedFile = rawFile.replace(/:\d+$/, '');
            }

            findings.push(createFinding({
                severity,
                summary,
                evidence: '',
                file: normalizedFile,
                line: lineMatch ? parseInt(lineMatch[1], 10) : null,
                confidence: 0.6,
            }));
        }
    }

    return findings;
}

/**
 * @param {string} raw
 * @returns {'critical'|'high'|'medium'|'low'}
 */
function mapSeverity(raw) {
    const s = (raw ?? '').toLowerCase().trim();
    if (s === 'critical' || s === 'error' || s === 'fatal') return 'critical';
    if (s === 'high' || s === 'warning' || s === 'warn') return 'high';
    if (s === 'medium' || s === 'info' || s === 'note') return 'medium';
    if (s === 'low' || s === 'hint' || s === 'suggestion') return 'low';
    return 'medium';
}

/**
 * Get next version number for feedback files.
 * @param {string} feedbackDir
 * @param {string} prefix
 * @returns {string}
 */
function getNextVersion(feedbackDir, prefix) {
    const files = fs.readdirSync(feedbackDir);
    let maxVersion = 0;
    for (const f of files) {
        const match = f.match(new RegExp(`^${prefix}-v(\\d+)\\.md$`));
        if (match) {
            maxVersion = Math.max(maxVersion, parseInt(match[1], 10));
        }
        // Also check unversioned
        if (f === `${prefix}.md` && maxVersion === 0) {
            maxVersion = 1;
        }
    }
    return `v${maxVersion + 1}`;
}

// ── Cleanup ──────────────────────────────────────────

async function cleanupResources(server, snapshotManager, snapshotPath) {
    console.log('🧹 Cleaning up...');
    try {
        if (snapshotPath && snapshotManager && snapshotPath !== PROJECT_DIR) {
            snapshotManager.remove(snapshotPath);
        }
    } catch { /* ignore */ }
    try {
        if (server) await server.stop();
    } catch { /* ignore */ }
}

// ── Signal Handling ──────────────────────────────────

let _sigintServer = null;
let _sigintSnapshotMgr = null;
let _sigintSnapshotPath = null;

process.on('SIGINT', async () => {
    console.log('\n\n🛑 Stopping server...');
    await cleanupResources(_sigintServer, _sigintSnapshotMgr, _sigintSnapshotPath);
    process.exit(0);
});

// ── Run ──────────────────────────────────────────────
main();

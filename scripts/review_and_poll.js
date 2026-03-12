// Codex Review: create session → poll with stall detection → fetch findings
import http from 'node:http';

const HUB = 'http://localhost:3849';
const MAX_WAIT_MS = 720_000; // 12 min
const POLL_INTERVAL_MS = 15_000; // 15s between polls

function httpReq(method, path, body) {
    return new Promise((resolve, reject) => {
        const url = new URL(path, HUB);
        const opts = { hostname: url.hostname, port: url.port, path: url.pathname, method, timeout: 15000 };
        if (body) opts.headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) };
        const req = http.request(opts, (res) => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('HTTP timeout')); });
        if (body) req.write(body);
        req.end();
    });
}

async function main() {
    // Step 1: Create session
    console.log('=== Creating review session ===');
    const createBody = JSON.stringify({
        projectDir: 'd:/extension',
        prompt: 'Review this plan document for bugs, logical issues, missing edge cases, security gaps, and implementation risks. Check for: inconsistencies between requirements and implementation steps, missing error handling, XSS/security gaps, contradictions, unclear specifications, and potential implementation pitfalls.',
        reviewOptions: {
            review_target: 'file',
            file_path: 'plans/260308-1959-phase2-polish/phase-04-code-annotation.md',
            max_findings: 15
        }
    });

    const createResult = await httpReq('POST', '/api/sessions', createBody);
    const sessionId = createResult?.session?.id;
    if (!sessionId) {
        console.error('FAIL: Could not create session:', JSON.stringify(createResult).substring(0, 500));
        process.exit(1);
    }
    console.log(`Session: ${sessionId}`);

    // Step 2: Poll — rely on Hub watchdog for stall detection
    console.log(`\n=== Polling (max ${MAX_WAIT_MS / 60000} min, interval ${POLL_INTERVAL_MS / 1000}s) ===`);
    const start = Date.now();

    while (Date.now() - start < MAX_WAIT_MS) {
        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));

        let status;
        try {
            status = await httpReq('GET', `/api/sessions/${sessionId}`);
        } catch (e) {
            console.log(`[${elapsed()}] POLL ERROR: ${e.message}`);
            continue;
        }

        const state = status?.session?.state;
        const display = status?.session?.displayState;
        const fc = status?.session?.findingCount ?? 0;
        const stalled = status?.watchdog?.stalled;
        const idleMs = status?.watchdog?.idleMs ?? 0;

        console.log(`[${elapsed()}] state=${state} display=${display} findings=${fc} idle=${(idleMs / 1000).toFixed(0)}s watchdog_stalled=${stalled}`);

        // Terminal states
        if (state === 'completed') {
            console.log('\n✅ COMPLETED!');
            await fetchAndPrintFindings(sessionId);
            return;
        }
        if (state === 'failed' || state === 'cancelled') {
            console.log(`\n❌ ${state.toUpperCase()}`);
            try { await fetchAndPrintFindings(sessionId); } catch { }
            process.exit(1);
        }
        // Only use Hub watchdog for stall detection — findings arrive in bulk at review end
        if (stalled) {
            console.log(`\n⚠️ STALLED (watchdog=${stalled})`);
            process.exit(2);
        }
    }

    console.log(`\n⏰ TIMEOUT after ${MAX_WAIT_MS / 60000} minutes`);
    process.exit(3);

    function elapsed() {
        return `${((Date.now() - start) / 1000).toFixed(0)}s`;
    }
}

async function fetchAndPrintFindings(sessionId) {
    const data = await httpReq('GET', `/api/sessions/${sessionId}/findings`);
    console.log('\n=== FINDINGS ===');
    console.log(JSON.stringify(data, null, 2));
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });

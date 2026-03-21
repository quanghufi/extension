import http from 'node:http';

function httpGet(path) {
    return new Promise((resolve, reject) => {
        const req = http.get(`http://localhost:3849${path}`, { timeout: 10000 }, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
                    return;
                }
                try { resolve(JSON.parse(data)); }
                catch (e) { reject(new Error(`Parse error: ${data.substring(0, 200)}`)); }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    });
}

function requireId(action) {
    const id = process.argv[3];
    if (!id) {
        console.error(`Usage: poll_hub.js ${action} <session-id>`);
        process.exit(1);
    }
    return id;
}

async function main() {
    const action = process.argv[2] || 'list';

    if (action === 'list') {
        const response = await httpGet('/api/sessions');
        const sessions = response.sessions ?? [];
        if (sessions.length === 0) {
            console.log('No sessions found.');
            return;
        }
        const latest = sessions.sort((a, b) =>
            new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        )[0];
        console.log(JSON.stringify(latest, null, 2));
    } else if (action === 'status') {
        const id = requireId('status');
        const data = await httpGet(`/api/sessions/${id}`);
        console.log(JSON.stringify({
            id: data.session?.id,
            state: data.session?.state,
            displayState: data.session?.displayState,
            findingCount: data.session?.findingCount,
            watchdog: data.watchdog
        }, null, 2));
    } else if (action === 'findings') {
        const id = requireId('findings');
        const data = await httpGet(`/api/sessions/${id}/findings`);
        console.log(JSON.stringify(data, null, 2));
    } else if (action === 'poll') {
        const id = requireId('poll');
        const maxWait = 120000;
        const start = Date.now();
        while (Date.now() - start < maxWait) {
            let data;
            try {
                data = await httpGet(`/api/sessions/${id}`);
            } catch (err) {
                console.error(`[${new Date().toISOString()}] poll error: ${err.message}`);
                await new Promise(r => setTimeout(r, 5000));
                continue;
            }
            const state = data.session?.state;
            const display = data.session?.displayState;
            console.log(`[${new Date().toISOString()}] state=${state} display=${display}`);
            if (state === 'completed' || state === 'partial_completion') {
                console.log(state === 'completed' ? 'COMPLETED' : 'PARTIAL_COMPLETION');
                return;
            }
            if (state === 'failed' || state === 'cancelled') { console.log('TERMINAL: ' + state); return; }
            if (display === 'stalled' || data.watchdog?.stalled) { console.log('STALLED'); return; }
            await new Promise(r => setTimeout(r, 5000));
        }
        console.log('TIMEOUT');
    } else {
        console.error(`Unknown action: ${action}. Use: list, status, findings, poll`);
        process.exit(1);
    }
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });

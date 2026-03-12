import http from 'node:http';

function httpGet(path) {
    return new Promise((resolve, reject) => {
        const req = http.get(`http://localhost:3849${path}`, { timeout: 10000 }, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch (e) { reject(new Error(`Parse error: ${data.substring(0, 200)}`)); }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    });
}

async function main() {
    const action = process.argv[2] || 'list';

    if (action === 'list') {
        const response = await httpGet('/api/sessions');
        const sessions = response.sessions ?? [];
        const latest = sessions[sessions.length - 1];
        console.log(JSON.stringify(latest, null, 2));
    } else if (action === 'status') {
        const id = process.argv[3];
        const data = await httpGet(`/api/sessions/${id}`);
        console.log(JSON.stringify({
            id: data.session?.id,
            state: data.session?.state,
            displayState: data.session?.displayState,
            findingCount: data.session?.findingCount,
            watchdog: data.watchdog
        }, null, 2));
    } else if (action === 'findings') {
        const id = process.argv[3];
        const data = await httpGet(`/api/sessions/${id}/findings`);
        console.log(JSON.stringify(data, null, 2));
    } else if (action === 'poll') {
        const id = process.argv[3];
        const maxWait = 120000;
        const start = Date.now();
        while (Date.now() - start < maxWait) {
            const data = await httpGet(`/api/sessions/${id}`);
            const state = data.session?.state;
            const display = data.displayState;
            console.log(`[${new Date().toISOString()}] state=${state} display=${display}`);
            if (state === 'completed') { console.log('COMPLETED'); return; }
            if (state === 'failed' || state === 'cancelled') { console.log('TERMINAL: ' + state); return; }
            if (display === 'stalled' || data.watchdog?.stalled) { console.log('STALLED'); return; }
            await new Promise(r => setTimeout(r, 5000));
        }
        console.log('TIMEOUT');
    }
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });

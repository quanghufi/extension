import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { resolve as pathResolve } from 'node:path';

const DEFAULT_MAX_BODY_BYTES = 20 * 1024 * 1024; // 20 MB default

function parseMaxBytes(val) {
    if (val == null) return DEFAULT_MAX_BODY_BYTES;
    const n = Number(val);
    return (Number.isFinite(n) && n > 0) ? Math.floor(n) : DEFAULT_MAX_BODY_BYTES;
}

function httpGet(path, options = {}) {
    const MAX_BODY_BYTES = parseMaxBytes(options.maxBodyBytes ?? process.env.SESSION_DETAIL_MAX_BYTES);
    const HARD_TIMEOUT_MS = options.hardTimeoutMs ?? 30000; // 30s wall-clock deadline

    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (fn, val) => { if (!settled) { settled = true; clearTimeout(hardTimer); fn(val); } };

        const hardTimer = setTimeout(() => {
            req.destroy();
            finish(reject, new Error(`Hard timeout: request exceeded ${HARD_TIMEOUT_MS}ms`));
        }, HARD_TIMEOUT_MS);

        const req = http.get(`http://127.0.0.1:3849${path}`, { timeout: 10000 }, (res) => {
            const chunks = [];
            let bytes = 0;
            res.on('error', (e) => { req.destroy(); finish(reject, e); });
            res.on('aborted', () => { req.destroy(); finish(reject, new Error('Response aborted by server')); });
            res.on('data', (chunk) => {
                bytes += chunk.length;
                if (bytes > MAX_BODY_BYTES) {
                    req.destroy();
                    finish(reject, new Error(`Response too large (>${MAX_BODY_BYTES} bytes)`));
                    return;
                }
                chunks.push(chunk);
            });
            res.on('end', () => {
                const contentType = res.headers['content-type'] || 'unknown';
                let data;
                try { data = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); }
                catch { finish(reject, new Error(`UTF-8 decode error (status=${res.statusCode}, bytes=${bytes}, content-type=${contentType})`)); return; }
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    finish(reject, new Error(`HTTP ${res.statusCode} (bytes=${bytes}, content-type=${contentType})`));
                    return;
                }
                try { finish(resolve, JSON.parse(data)); }
                catch { finish(reject, new Error(`JSON parse error (status=${res.statusCode}, bytes=${bytes}, content-type=${contentType})`)); }
            });
        });
        req.on('error', (e) => finish(reject, e));
        req.on('timeout', () => { req.destroy(); finish(reject, new Error('Idle timeout')); });
    });
}

async function main() {
    const id = process.argv[2];
    if (!id) {
        console.error('Usage: session_detail.js <session-id>');
        process.exit(1);
    }
    const data = await httpGet(`/api/sessions/${encodeURIComponent(id)}`);
    console.log(JSON.stringify(data, null, 2));
}

// Support both direct execution and import for testing
export { httpGet, main };

const isDirectRun = process.argv[1] &&
    pathResolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
    main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
}

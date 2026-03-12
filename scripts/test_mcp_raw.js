// Test: directly send MCP initialize message to Python server and see response
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MCP_SCRIPT = path.resolve(__dirname, '..', 'src', 'mcp', 'codex_review_mcp.py');
const MCP_SCHEMA = path.resolve(__dirname, '..', 'src', 'mcp', 'codex_review_schema.json');

console.log('Spawning Python MCP server...');

const child = spawn('python', [
    MCP_SCRIPT,
    '--workspace', 'd:/extension',
    '--schema', MCP_SCHEMA,
    '--codex-command', 'codex.cmd'
], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env },
});

let stderrBuf = '';
child.stderr.on('data', (chunk) => {
    stderrBuf += chunk.toString();
    console.log('[STDERR]', chunk.toString().trim());
});

child.on('error', (err) => {
    console.log('[SPAWN ERROR]', err.message);
});

child.on('exit', (code, signal) => {
    console.log(`[EXIT] code=${code} signal=${signal}`);
});

// Wait for process to start
await new Promise(r => setTimeout(r, 1000));

// Send MCP initialize request
const initMsg = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test-client", version: "1.0.0" }
    }
});

const initData = Buffer.from(initMsg, 'utf-8');
const header = `Content-Length: ${initData.length}\r\n\r\n`;

console.log(`[SEND] Header: ${header.trim()}`);
console.log(`[SEND] Body: ${initMsg}`);
console.log(`[SEND] Body length: ${initData.length}`);

child.stdin.write(header);
child.stdin.write(initData);

// Read response
let responseBuf = Buffer.alloc(0);
let gotResponse = false;

child.stdout.on('data', (chunk) => {
    responseBuf = Buffer.concat([responseBuf, chunk]);
    const str = responseBuf.toString('utf-8');
    console.log(`[STDOUT raw bytes] ${chunk.length} bytes: ${chunk.toString('hex').substring(0, 200)}`);
    console.log(`[STDOUT text] ${str.substring(0, 500)}`);
    gotResponse = true;
});

// Wait for response
await new Promise(r => setTimeout(r, 5000));

if (!gotResponse) {
    console.log('[TIMEOUT] No response received after 5 seconds');
    console.log('[STDERR accumulated]', stderrBuf);
}

// Send notifications/initialized
const initializedMsg = JSON.stringify({
    jsonrpc: "2.0",
    method: "notifications/initialized"
});
const initializedData = Buffer.from(initializedMsg, 'utf-8');
child.stdin.write(`Content-Length: ${initializedData.length}\r\n\r\n`);
child.stdin.write(initializedData);

await new Promise(r => setTimeout(r, 1000));

child.kill();
console.log('Done');

#!/usr/bin/env node

/**
 * Extension Hub CLI — Global entry point
 *
 * Usage:
 *   extension-hub              # Start on default port 3849
 *   extension-hub --port 4000  # Start on custom port
 */

import { HubServer } from '../src/server.js';

// ── Parse CLI args ───────────────────────────────
const args = process.argv.slice(2);

function getArg(name) {
    const idx = args.indexOf(name);
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

if (args.includes('--help') || args.includes('-h')) {
    console.log(`
  Extension Hub — Multi-agent communication hub

  Usage:
    extension-hub [options]

  Options:
    --port <number>   Port to listen on (default: 3849)
    --help, -h        Show this help message
    --version, -v     Show version

  Examples:
    extension-hub
    extension-hub --port 4000
`);
    process.exit(0);
}

if (args.includes('--version') || args.includes('-v')) {
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    const pkg = require('../package.json');
    console.log(`extension-hub v${pkg.version}`);
    process.exit(0);
}

const portStr = getArg('--port');
const port = portStr ? parseInt(portStr, 10) : undefined;

if (portStr && (isNaN(port) || port < 1 || port > 65535)) {
    console.error(`Error: Invalid port "${portStr}". Must be 1-65535.`);
    process.exit(1);
}

// ── Start server ─────────────────────────────────
const server = new HubServer({ port });
server.start().catch((err) => {
    console.error('Failed to start Extension Hub:', err.message);
    process.exit(1);
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n🛑 Shutting down...');
    await server.stop();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    await server.stop();
    process.exit(0);
});

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MCP_SCRIPT = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..', 'src', 'mcp', 'codex_review_mcp.py'
);

const MCP_SCHEMA = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..', 'src', 'mcp', 'codex_review_schema.json'
);

async function main() {
    console.log('Script:', MCP_SCRIPT);
    console.log('Schema:', MCP_SCHEMA);

    const args = [
        MCP_SCRIPT,
        '--workspace', 'd:/extension',
        '--schema', MCP_SCHEMA,
        '--codex-command', 'codex.cmd'
    ];

    console.log('Spawning: python', args.join(' '));

    const transport = new StdioClientTransport({
        command: 'python',
        args,
        env: { ...process.env },
        stderr: 'pipe',
    });

    let stderrLog = '';
    if (transport.stderr) {
        transport.stderr.on('data', (chunk) => {
            const text = chunk.toString('utf-8');
            stderrLog += text;
            process.stderr.write(text);
        });
    }

    const client = new Client(
        { name: 'test-client', version: '1.0.0' },
        { capabilities: {} }
    );

    try {
        console.log('Connecting...');
        await Promise.race([
            client.connect(transport),
            new Promise((_, reject) => setTimeout(
                () => reject(new Error('Connect timeout after 30s')),
                30000
            ))
        ]);
        console.log('Connected! Listing tools...');

        const tools = await client.listTools();
        console.log('Available tools:', tools.tools?.map(t => t.name));

        console.log('Calling run_codex_review...');
        const result = await Promise.race([
            client.callTool({
                name: 'run_codex_review',
                arguments: {
                    workspace: 'd:/extension',
                    review_target: 'file',
                    file_path: 'plans/260308-1959-phase2-polish/phase-04-code-annotation.md',
                    max_findings: 15,
                    instructions: 'Review this plan document for bugs, logical issues, missing edge cases, security gaps, and implementation risks.'
                }
            }),
            new Promise((_, reject) => setTimeout(
                () => reject(new Error('Review timeout after 5min')),
                300000
            ))
        ]);

        console.log('\n=== RESULT ===');
        console.log(JSON.stringify(result, null, 2));

        await client.close();
    } catch (err) {
        console.error('ERROR:', err.message);
        console.error('STDERR:', stderrLog.substring(0, 1000));
        try { await client.close(); } catch { }
    }
}

main();

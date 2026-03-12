import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const client = new Client({ name: 'debug-client', version: '0.0.0' });
const transport = new StdioClientTransport({
  command: 'node',
  args: ['src/mcp-server.js'],
  stderr: 'pipe'
});

transport.stderr?.on('data', (chunk) => {
  process.stderr.write('[server-stderr] ' + chunk.toString());
});

try {
  await client.connect(transport);
  const result = await client.listTools();
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error('CLIENT_ERROR', error);
  process.exitCode = 1;
} finally {
  try { await client.close(); } catch {}
}

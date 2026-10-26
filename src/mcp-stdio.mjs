import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { Store } from './store.mjs';
import { createMcpServer } from './mcp.mjs';

try {
  const { values } = parseArgs({ options: { db: { type: 'string' } } });
  // Hosts choose their own working directory; the default DB belongs to this project.
  const store = new Store(values.db ?? fileURLToPath(new URL('../.data/trials.sqlite', import.meta.url)));
  let closed = false; let landscapeService;
  const closeStore = () => { if (!closed) { closed = true; store.close(); } };
  const handle = serveStdio(() => {
    const server = createMcpServer(store);
    landscapeService = server.landscapes;
    server.server.onclose = async () => { await landscapeService.close(); closeStore(); };
    return server;
  }, { onerror: error => process.stderr.write(`MCP transport error: ${error.message}\n`) });
  const shutdown = () => { Promise.resolve(landscapeService?.close()).then(() => handle.close()).finally(closeStore).catch(error => {
    process.stderr.write(`MCP shutdown error: ${error.message}\n`); process.exitCode = 1;
  }); };
  process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
  process.once('exit', closeStore);
} catch (error) {
  process.stderr.write(`Cannot start clinical-trials MCP: ${error.message}\n`);
  process.exitCode = 1;
}

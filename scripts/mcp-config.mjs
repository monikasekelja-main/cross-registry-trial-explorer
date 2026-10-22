import { fileURLToPath } from 'node:url';

// Generate machine-specific absolute paths; no assumptions about a host's cwd or PATH.
console.log(JSON.stringify({ mcpServers: {
  'clinical-trials': {
    command: process.execPath,
    args: [fileURLToPath(new URL('../src/mcp-stdio.mjs', import.meta.url)), '--db',
      fileURLToPath(new URL('../.data/trials.sqlite', import.meta.url))],
  },
} }, null, 2));

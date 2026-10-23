import { parseArgs } from 'node:util';
import { Store } from './store.mjs';
import { sync } from './sync.mjs';
import { createApi } from './server.mjs';
import { validateId } from './adapters.mjs';

const usage = `Usage (Node.js 24+):
  node src/cli.mjs sync [--source all|ctgov|ctis] [--query melanoma] [--searchMode condition|keyword] [--limit 5] [--db PATH]
  node src/cli.mjs search [--q melanoma] [--country Italy] [--source ctis] [--limit 20] [--cursor TOKEN] [--db PATH]
  node src/cli.mjs get SOURCE ID [--db PATH]
  node src/cli.mjs status [--db PATH]
  node src/cli.mjs serve [--port 3010] [--db PATH]`;

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: Object.fromEntries(
    ['source','query','searchMode','q','limit','db','port','country','recruitmentStatus','cursor'].map(k => [k, { type: 'string' }])) });
  const [command, source, id] = positionals;
  if (!['sync','search','get','status','serve'].includes(command)) throw new Error(usage);
  const store = new Store(values.db);
  const controller = new AbortController();
  const abort = () => controller.abort(new Error('Cancelled'));
  process.once('SIGINT', abort); process.once('SIGTERM', abort);
  let serving = false;
  try {
    let result;
    if (command === 'sync') {
      result = await sync(store, { sources: !values.source || values.source === 'all' ? undefined : [values.source],
        query: values.query, searchMode: values.searchMode, limit: values.limit === undefined ? 10 : Number(values.limit), signal: controller.signal });
      if (result.status !== 'ok') process.exitCode = 1;
    } else if (command === 'search') {
      result = store.search({ q: values.q, source: values.source, country: values.country,
        recruitmentStatus: values.recruitmentStatus, limit: values.limit, cursor: values.cursor });
    } else if (command === 'get') {
      validateId(source, id);
      result = store.get(source, id, { raw: true });
      if (!result) { result = { error: 'Record not imported' }; process.exitCode = 1; }
    } else if (command === 'status') result = store.sourceStatus();
    else {
      const port = Number(values.port ?? 3010);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
      const server = createApi(store);
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
      serving = true;
      process.stderr.write(`Read-only API: http://127.0.0.1:${port}/trials\n`);
      controller.signal.addEventListener('abort', () => server.close(() => store.close()), { once: true });
    }
    if (result !== undefined) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } finally {
    if (!serving) { store.close(); process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort); }
  }
} catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }

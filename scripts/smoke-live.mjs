import { mkdirSync, writeFileSync } from 'node:fs';
import { Store } from '../src/store.mjs';
import { sync } from '../src/sync.mjs';

mkdirSync('.data', { recursive: true });
const store = new Store('.data/live-smoke.sqlite');
try {
  const result = await sync(store, { limit: 2, query: 'melanoma', signal: AbortSignal.timeout(120000) });
  const report = { executedAt: new Date().toISOString(), runtime: process.version, ...result,
    allImported: store.search(), localSearch: store.search({ q: 'melanoma' }),
    checks: { allSourcesImported: result.sources.every(x => x.status === 'ok' && x.imported > 0) } };
  writeFileSync('.data/live-smoke-report.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: result.status, sources: result.sources,
    importedRecordCount: report.allImported.totalCount, localKeywordMatches: report.localSearch.totalCount,
    report: '.data/live-smoke-report.json' }, null, 2));
  if (!report.checks.allSourcesImported) process.exitCode = 1;
} finally { store.close(); }

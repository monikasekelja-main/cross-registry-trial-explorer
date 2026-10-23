import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const root = new URL('../', import.meta.url);
mkdirSync(new URL('.data/', root), { recursive: true });
const client = new Client({ name: 'clinical-trials-live-check', version: '1.0.0' });
const transport = new StdioClientTransport({ command: process.execPath,
  args: [fileURLToPath(new URL('src/mcp-stdio.mjs', root)), '--db', fileURLToPath(new URL('.data/mcp-live-smoke.sqlite', root))], stderr: 'pipe' });
let stderr = ''; transport.stderr.on('data', chunk => { stderr += chunk; });
try {
  await client.connect(transport);
  const tools = await client.listTools();
  const live = await client.callTool({ name: 'search_trials', arguments: { query: 'melanoma', limitPerSource: 2 } }, { timeout: 150000 });
  assert.notEqual(live.isError, true, JSON.stringify(live.content));
  assert.equal(live.structuredContent.status, 'ok');
  assert.equal(live.structuredContent.sources.length, 2);
  assert.equal(live.structuredContent.searchMode, 'condition');
  for (const source of live.structuredContent.sources) {
    assert.equal(source.status, 'ok'); assert.equal(source.records.length, 2);
    assert.deepEqual(source.searchCriteria, source.source === 'ctgov'
      ? { 'query.term': 'AREA[Condition]"melanoma"' } : { medicalCondition: 'melanoma' });
    for (const record of source.records) assert.ok(record.conditions.some(condition => /melanoma/i.test(condition)), `Unexpected condition for ${record.sourceId}`);
    const first = source.records[0];
    const detail = await client.callTool({ name: 'get_trial', arguments: { source: first.source, id: first.sourceId } });
    assert.notEqual(detail.isError, true); assert.equal(detail.structuredContent.sourceId, first.sourceId);
  }
  const cached = await client.callTool({ name: 'search_imported_trials', arguments: {} });
  const status = await client.callTool({ name: 'get_source_status', arguments: {} });
  assert.notEqual(cached.isError, true); assert.notEqual(status.isError, true);
  const report = { executedAt: new Date().toISOString(), runtime: process.version, server: client.getServerVersion(),
    tools: tools.tools.map(t => t.name), live: live.structuredContent, cached: cached.structuredContent, sources: status.structuredContent, stderr };
  writeFileSync(new URL('.data/mcp-live-smoke-report.json', root), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.live.status, tools: report.tools,
    searchMode: report.live.searchMode,
    sources: report.live.sources.map(s => ({ source: s.source, imported: s.imported, upstreamTotal: s.upstreamTotal,
      searchCriteria: s.searchCriteria, conditions: s.records.map(r => ({ id: r.sourceId, conditions: r.conditions })) })),
    returned: report.live.returned, report: fileURLToPath(new URL('.data/mcp-live-smoke-report.json', root)) }, null, 2));
} finally { await client.close(); }

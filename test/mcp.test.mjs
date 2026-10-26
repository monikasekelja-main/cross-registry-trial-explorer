import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { Store } from '../src/store.mjs';
import { createMcpServer } from '../src/mcp.mjs';
import { normalizeCtgov, normalizeCtis } from '../src/adapters.mjs';
import { ctgovRecord, ctisRecord, ctisSummary } from './fixtures.mjs';

const entry = fileURLToPath(new URL('../src/mcp-stdio.mjs', import.meta.url));
const time = '2026-10-22T09:00:00.000Z';
function collection(source, id) {
  const raw = source === 'ctgov' ? ctgovRecord(id) : { detail: ctisRecord(id), summary: ctisSummary(id) };
  const trial = source === 'ctgov' ? normalizeCtgov(raw, time) : normalizeCtis(raw.detail, raw.summary, time);
  return { records: [{ trial, raw }], upstreamTotal: 10, truncated: true };
}
function output(result) {
  assert.notEqual(result.isError, true, JSON.stringify(result.content));
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  return result.structuredContent;
}
async function inMemory(t, adapters) {
  const store = new Store(':memory:'); const server = createMcpServer(store, { adapters });
  const [clientWire, serverWire] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'mcp-test', version: '1.0.0' });
  t.after(async () => { await client.close(); await server.close(); store.close(); });
  await server.connect(serverWire); await client.connect(clientWire);
  return { client, store };
}

for (const mode of ['legacy', 'auto']) {
  test(`stdio ${mode} handshake, discovery, local search, validation and retrieval`, { timeout: 15000 }, async t => {
    const directory = mkdtempSync(join(tmpdir(), 'trials-mcp-')); const db = join(directory, 'test.sqlite');
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const store = new Store(db);
    for (const source of ['ctgov','ctis']) store.commitSource(source, collection(source), {}, time);
    store.close();
    const transport = new StdioClientTransport({ command: process.execPath, args: [entry, '--db', db], cwd: directory, stderr: 'pipe' });
    let stderr = ''; transport.stderr.on('data', chunk => { stderr += chunk; });
    const client = new Client({ name: 'stdio-test', version: '1.0.0' }, mode === 'auto' ? { versionNegotiation: { mode: 'auto' } } : {});
    t.after(() => client.close());
    await client.connect(transport);
    assert.equal(client.getServerVersion().name, 'clinical-trials');
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(x => x.name).sort(), ['get_source_status','get_trial','search_imported_trials','search_trials','resolve_intervention','get_drug_targets','get_clinical_target_landscape','get_landscape_job','resume_landscape_job','cancel_landscape_job','export_landscape','compare_landscapes'].sort());
    assert.equal(tools.find(x => x.name === 'search_trials').annotations.readOnlyHint, false);
    const searched = output(await client.callTool({ name: 'search_imported_trials', arguments: { q: 'melanoma', limit: 1 } }));
    assert.equal(searched.totalCount, 2); assert.equal(searched.countUnit, 'source_records'); assert.ok(searched.nextCursor);
    const pageTwo = output(await client.callTool({ name: 'search_imported_trials', arguments: { q: 'melanoma', limit: 1, cursor: searched.nextCursor } }));
    assert.equal(pageTwo.records[0].source, 'ctis'); assert.equal(pageTwo.records[0].recruitmentStatus, 'unknown');
    const record = output(await client.callTool({ name: 'get_trial', arguments: { source: 'ctis', id: '2026-500001-01-00', includeRaw: true } }));
    assert.ok(record.raw.detail); assert.equal(record.regulatoryStatus, 'Authorised');
    const status = output(await client.callTool({ name: 'get_source_status', arguments: {} }));
    assert.equal(status.sources.length, 3);
    for (const args of [
      { name: 'get_trial', arguments: { source: 'ctgov', id: 'NCT99999999' } },
      { name: 'get_trial', arguments: { source: 'ctgov', id: '../../etc/passwd' } },
      { name: 'search_trials', arguments: { query: '   ' } },
      { name: 'search_trials', arguments: { query: 'melanoma', sources: [] } },
      { name: 'search_trials', arguments: { query: 'melanoma', searchMode: 'invalid' } },
      { name: 'search_imported_trials', arguments: { limit: 101 } },
      { name: 'search_imported_trials', arguments: { unknownFilter: true } },
    ]) assert.equal((await client.callTool(args)).isError, true);
    const pid = transport.pid;
    await client.close();
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    assert.doesNotMatch(stderr, /Cannot start|MCP transport error|MCP shutdown error/);
  });
}

test('live MCP search returns this call only, caches records and preserves partial failures', async t => {
  let calls = 0; let failCtis = false;
  const { client, store } = await inMemory(t, {
    ctgov: { collect: async ({ query, searchMode, limit, signal }) => {
      assert.equal(query, 'melanoma'); assert.equal(limit, 1); assert.equal(signal.aborted, false); calls++;
      assert.equal(searchMode, 'condition');
      return collection('ctgov', 'NCT00000002');
    } },
    ctis: { collect: async () => { if (failCtis) throw new Error('CTIS unavailable'); return collection('ctis'); } },
  });
  store.commitSource('ctgov', collection('ctgov'), {}, time);
  const live = output(await client.callTool({ name: 'search_trials', arguments: { query: 'melanoma', sources: ['ctgov', 'ctis'], limitPerSource: 1 } }));
  assert.equal(live.status, 'ok'); assert.equal(live.returned, 2);
  assert.equal(live.searchMode, 'condition');
  assert.deepEqual(live.sources[0].searchCriteria, { 'query.term': 'AREA[Condition]"melanoma"' });
  assert.deepEqual(live.sources[1].searchCriteria, { medicalCondition: 'melanoma' });
  assert.equal(store.sourceStatus()[0].lastSuccess.scope.searchMode, 'condition');
  assert.equal(live.sources[0].records[0].sourceId, 'NCT00000002');
  assert.equal(store.search().totalCount, 3);
  failCtis = true;
  const partial = output(await client.callTool({ name: 'search_trials', arguments: { query: 'melanoma', sources: ['ctgov', 'ctis'], limitPerSource: 1 } }));
  assert.equal(partial.status, 'partial_failure'); assert.equal(partial.returned, 1);
  assert.equal(partial.sources[1].status, 'failed'); assert.equal(partial.sources[1].records, undefined);
  assert.equal(store.search({ source: 'ctis' }).totalCount, 1); assert.equal(calls, 2);
});

test('MCP keyword opt-in reaches the adapter and is recorded in result provenance', async t => {
  const { client, store } = await inMemory(t, { ctgov: { collect: async ({ query, searchMode }) => {
    assert.equal(query, 'AREA[Condition]melanoma'); assert.equal(searchMode, 'keyword');
    return collection('ctgov');
  } } });
  const broad = output(await client.callTool({ name: 'search_trials', arguments: {
    query: 'AREA[Condition]melanoma', sources: ['ctgov'], searchMode: 'keyword',
  } }));
  assert.equal(broad.searchMode, 'keyword');
  assert.deepEqual(broad.sources[0].searchCriteria, { 'query.term': 'AREA[Condition]melanoma' });
  assert.equal(store.sourceStatus()[0].lastSuccess.scope.searchMode, 'keyword');
});

test('all upstream failures become an explicit MCP tool error', async t => {
  const fail = { collect: async () => { throw new Error('Registry unavailable'); } };
  const { client } = await inMemory(t, { ctgov: fail, ctis: fail });
  const result = await client.callTool({ name: 'search_trials', arguments: { query: 'melanoma', sources: ['ctgov', 'ctis'] } });
  assert.equal(result.isError, true); assert.equal(result.structuredContent.returned, 0);
  assert.equal(result.structuredContent.sources.length, 2);
});

test('MCP cancellation propagates to upstream work and does not import cancelled records', { timeout: 5000 }, async t => {
  let entered; const started = new Promise(resolve => { entered = resolve; });
  let aborted; const stopped = new Promise(resolve => { aborted = resolve; });
  const { client, store } = await inMemory(t, { ctgov: { collect: async ({ signal }) => {
    entered();
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => {
      aborted(); reject(signal.reason);
    }, { once: true }));
  } } });
  const controller = new AbortController();
  const call = client.callTool({ name: 'search_trials', arguments: { query: 'melanoma', sources: ['ctgov'] } }, { signal: controller.signal });
  const rejected = assert.rejects(call);
  await started; controller.abort(); await rejected; await stopped;
  assert.equal(store.search().totalCount, 0);
});

test('MCP local pagination reports invalidated cursors as recoverable tool errors', async t => {
  const { client, store } = await inMemory(t, {});
  for (const source of ['ctgov','ctis']) store.commitSource(source, collection(source), {}, time);
  const first = output(await client.callTool({ name: 'search_imported_trials', arguments: { limit: 1 } }));
  store.commitSource('ctgov', collection('ctgov'), {}, time);
  const stale = await client.callTool({ name: 'search_imported_trials', arguments: { limit: 1, cursor: first.nextCursor } });
  assert.equal(stale.isError, true); assert.equal(stale.structuredContent.reason, 'index_changed');
});

test('default MCP search includes ISRCTN, caches parsed XML and isolates its failure', async t => {
  const { XMLParser } = await import('fast-xml-parser');
  const { normalizeIsrctn } = await import('../src/adapters.mjs');
  const { isrctnXml } = await import('./fixtures.mjs');
  const raw = new XMLParser({ ignoreAttributes: false, parseTagValue: false }).parse(isrctnXml()).allTrials.fullTrial;
  let fail = false;
  const { client } = await inMemory(t, {
    ctgov: { collect: async () => collection('ctgov') }, ctis: { collect: async () => collection('ctis') },
    isrctn: { collect: async ({ query, searchMode }) => {
      assert.equal(query, 'melanoma'); assert.equal(searchMode, 'condition');
      if (fail) throw new Error('ISRCTN unavailable');
      return { records: [{ raw, trial: normalizeIsrctn(raw) }], upstreamTotal: 1, truncated: false };
    } },
  });
  const args = { name: 'search_trials', arguments: { query: 'melanoma', limitPerSource: 1 } };
  const live = output(await client.callTool(args));
  assert.deepEqual(live.sources.map(x => x.source), ['ctgov', 'ctis', 'isrctn']); assert.equal(live.returned, 3);
  assert.deepEqual(live.sources[2].searchCriteria, { q: 'condition:"melanoma"' });
  const saved = output(await client.callTool({ name: 'get_trial', arguments: { source: 'isrctn', id: 'ISRCTN12345678', includeRaw: true } }));
  assert.equal(saved.raw.trial['@_publicIdentifierCanonical'], 'ISRCTN12345678');
  const cached = output(await client.callTool({ name: 'search_imported_trials', arguments: { source: 'isrctn', q: 'melanoma' } }));
  assert.equal(cached.totalCount, 1);
  fail = true;
  const partial = output(await client.callTool(args));
  assert.equal(partial.status, 'partial_failure'); assert.equal(partial.returned, 2);
  assert.equal(partial.sources[2].records, undefined);
});

test('MCP exposes filters, passes them to adapters and applies them to saved search', async t => {
  const filters = { recruitmentStatus: 'recruiting', studyType: 'interventional', primaryPurpose: 'treatment' };
  const { client } = await inMemory(t, { ctgov: { collect: async args => {
    for (const key of Object.keys(filters)) assert.equal(args[key], filters[key]);
    const data = collection('ctgov'); Object.assign(data.records[0].trial, filters); return data;
  } } });
  const args = { query: 'melanoma', sources: ['ctgov'], ...filters };
  const live = output(await client.callTool({ name: 'search_trials', arguments: args }));
  assert.deepEqual(live.filters, filters); assert.equal(live.returned, 1);
  const cached = output(await client.callTool({ name: 'search_imported_trials', arguments: filters }));
  assert.equal(cached.totalCount, 1);
  for (const invalid of [{ studyType: 'treatment' }, { recruitmentStatus: 'open' }, { studyType: 'observational', primaryPurpose: 'treatment' }]) {
    assert.equal((await client.callTool({ name: 'search_trials', arguments: { query: 'melanoma', sources: ['ctgov'], ...invalid } })).isError, true);
  }
});

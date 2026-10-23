import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Store, canonical } from '../src/store.mjs';
import { normalizeCtgov, normalizeCtis, createAdapters, buildSearchCriteria } from '../src/adapters.mjs';
import { JsonClient, SourceError, retryAfterMs, isTransient } from '../src/http-client.mjs';
import { sync } from '../src/sync.mjs';
import { createApi } from '../src/server.mjs';
import { ctgovRecord, ctisRecord, ctisSummary } from './fixtures.mjs';

const time = '2026-10-22T09:00:00.000Z';
function collection(source = 'ctgov') {
  const raw = source === 'ctgov' ? ctgovRecord() : { detail: ctisRecord(), summary: ctisSummary() };
  const trial = source === 'ctgov' ? normalizeCtgov(raw, time) : normalizeCtis(raw.detail, raw.summary, time);
  return { records: [{ trial, raw }], upstreamTotal: 5, truncated: true };
}
function storeFor(t) { const store = new Store(':memory:'); t.after(() => store.close()); return store; }
function importOne(store, source = 'ctgov', data = collection(source)) { store.commitSource(source, data, { mode: 'test' }, time); }

test('condition names use scoped fields, including multiword and punctuation-bearing names', () => {
  for (const query of ['melanoma', 'non-small cell lung cancer', "Alzheimer's disease", 'melanoma OR lung cancer']) {
    assert.deepEqual(buildSearchCriteria('ctgov', query), { 'query.term': `AREA[Condition]"${query}"` });
    assert.deepEqual(buildSearchCriteria('ctis', query), { medicalCondition: query });
  }
  assert.throws(() => buildSearchCriteria('ctgov', 'melanoma" OR AREA[Condition]cancer'), /plain condition text/);
  assert.throws(() => buildSearchCriteria('ctis', 'melanoma', 'invalid'), /searchMode/);
  assert.deepEqual(buildSearchCriteria('ctgov'), {});
});

test('condition search excludes incidental broad hits before applying the requested limit', async () => {
  const lung = ctgovRecord('NCT00000003');
  lung.protocolSection.conditionsModule.conditions = ['Non-Small Cell Lung Cancer'];
  lung.protocolSection.descriptionModule = { briefSummary: 'Prior melanoma is an exclusion.' };
  const melanoma = [ctgovRecord(), ctgovRecord('NCT00000002')];
  const requested = [];
  const adapter = createAdapters({ clients: { ctgov: { json: async url => {
    const query = url.searchParams.get('query.term'); requested.push(query);
    assert.equal(url.searchParams.get('pageSize'), '2');
    return { studies: query === 'AREA[Condition]"melanoma"' ? melanoma : [lung, melanoma[0]], totalCount: 2 };
  } } } }).ctgov;
  const focused = await adapter.collect({ query: 'melanoma', limit: 2 });
  assert.deepEqual(focused.records.map(x => x.trial.sourceId), ['NCT00000001','NCT00000002']);
  const broad = await adapter.collect({ query: 'melanoma', searchMode: 'keyword', limit: 2 });
  assert.equal(broad.records[0].trial.sourceId, 'NCT00000003');
  assert.deepEqual(requested, ['AREA[Condition]"melanoma"', 'melanoma']);
});

test('keyword mode preserves expressions and CTIS broad search is explicit', async () => {
  const expression = 'AREA[Condition]melanoma OR AREA[InterventionName]pembrolizumab';
  assert.deepEqual(buildSearchCriteria('ctgov', expression, 'keyword'), { 'query.term': expression });
  let criteria;
  const adapter = createAdapters({ clients: { ctis: { json: async (_url, options) => {
    criteria = JSON.parse(options.body).searchCriteria;
    return { data: [], pagination: { totalRecords: 0, nextPage: false } };
  } } } }).ctis;
  await adapter.collect({ query: 'melanoma', searchMode: 'keyword' });
  assert.deepEqual(criteria, { containAny: 'melanoma' });
});

test('zero condition matches do not trigger a broader fallback', async () => {
  let calls = 0;
  const adapter = createAdapters({ clients: { ctgov: { json: async url => {
    calls++; assert.equal(url.searchParams.get('query.term'), 'AREA[Condition]"rare condition"');
    return { studies: [], totalCount: 0 };
  } } } }).ctgov;
  const response = await adapter.collect({ query: 'rare condition', limit: 2 });
  assert.equal(response.records.length, 0); assert.equal(response.upstreamTotal, 0); assert.equal(calls, 1);
});

test('normalization preserves false, missing fields, partial dates, and original statuses', () => {
  const trial = normalizeCtgov(ctgovRecord(), time);
  assert.equal(trial.hasResults, false); assert.equal(trial.recruitmentStatus, 'recruiting');
  assert.equal(trial.sourceUpdatedAt, '2026-10');
  const sparse = normalizeCtgov({ protocolSection: { identificationModule: { nctId: 'NCT00000002', briefTitle: 'Sparse' } } });
  assert.equal(sparse.hasResults, null); assert.equal(sparse.recruitmentStatus, 'unknown');
  assert.equal(sparse.sourceUpdatedAt, null); assert.deepEqual(sparse.countries, []);
});
test('CTIS authorization and recruitment start do not imply recruiting', () => {
  const raw = ctisRecord(); raw.authorizedApplication.authorizedPartsII[0].mscInfo.hasRecruitmentStarted = true;
  const trial = normalizeCtis(raw, ctisSummary(), time);
  assert.equal(trial.regulatoryStatus, 'Authorised'); assert.equal(trial.recruitmentStatus, 'unknown');
  assert.equal(trial.hasResults, false); assert.equal(trial.sourceUpdatedAt, '2026-10-21');
  assert.deepEqual(trial.countries, ['Italy']); assert.equal(trial.countryStatuses[0].hasRecruitmentStarted, true);
});
test('malformed identities and CTIS ID mismatches are rejected', () => {
  assert.throws(() => normalizeCtgov({}), /protocolSection/);
  assert.throws(() => normalizeCtis({}), /CTIS number/);
  assert.throws(() => normalizeCtis(ctisRecord(), { ctNumber: '2026-500002-01-00' }), /mismatch/);
  const raw = ctgovRecord(); raw.protocolSection.conditionsModule.conditions = 'Melanoma';
  assert.throws(() => normalizeCtgov(raw), /array/);
});
test('explicit cross-registry identifiers are preserved without merging trials', () => {
  const raw = ctisRecord();
  raw.authorizedApplication.authorizedPartI.trialDetails.clinicalTrialIdentifiers.secondaryIdentifyingNumbers = { nctNumber: { number: 'NCT00000001' } };
  assert.deepEqual(normalizeCtis(raw).identifiers, [
    { registry: 'ctis', value: '2026-500001-01-00' }, { registry: 'ctgov', value: 'NCT00000001' },
  ]);
});
test('ClinicalTrials.gov follows cursors and retains the first total', async () => {
  let calls = 0;
  const adapter = createAdapters({ clients: { ctgov: { json: async url => {
    calls++; if (calls === 1) return { studies: [ctgovRecord()], nextPageToken: 'next', totalCount: 2 };
    assert.equal(url.searchParams.get('pageToken'), 'next');
    return { studies: [ctgovRecord('NCT00000002')] };
  } } } }).ctgov;
  const result = await adapter.collect({ limit: 2 });
  assert.equal(result.records.length, 2); assert.equal(result.upstreamTotal, 2); assert.equal(result.truncated, false);
});
test('ClinicalTrials.gov detects cyclic cursors and invalid page shapes', async () => {
  let call = 0;
  const adapter = createAdapters({ clients: { ctgov: { json: async () => ({ studies: [ctgovRecord()], nextPageToken: ++call % 2 ? 'A' : 'B' }) } } }).ctgov;
  await assert.rejects(adapter.collect({ limit: 3 }), /repeated/);
  const bad = createAdapters({ clients: { ctgov: { json: async () => ({}) } } }).ctgov;
  await assert.rejects(bad.collect({ limit: 1 }), /missing studies/);
});
test('CTIS uses POST search, GET detail, fixed page sizes, and validates details', async () => {
  const sizes = []; let nextId = 0;
  const adapter = createAdapters({ clients: { ctis: { json: async (url, options) => {
    if (options.method === 'POST') {
      const body = JSON.parse(options.body); sizes.push(body.pagination.size);
      assert.deepEqual(body.searchCriteria, { medicalCondition: 'melanoma' });
      const ids = body.pagination.page === 1 ? ['2026-500001-01-00','2026-500002-01-00'] : ['2026-500003-01-00'];
      return { data: ids.map(ctisSummary), pagination: { nextPage: body.pagination.page === 1, totalRecords: 3 } };
    }
    nextId++; return ctisRecord(url.split('/').at(-1));
  } } } }).ctis;
  const result = await adapter.collect({ limit: 3, query: 'melanoma' });
  assert.equal(result.records.length, 3); assert.equal(nextId, 3); assert.deepEqual(sizes, [3,3]);
  const bad = createAdapters({ clients: { ctis: { json: async (_url, options) => options.method === 'POST'
    ? { data: [ctisSummary()], pagination: { nextPage: false, totalRecords: 1 } } : {} } } }).ctis;
  await assert.rejects(bad.collect({ limit: 1 }), /empty or missing/);
});
test('JSON client rejects HTML and malformed JSON even with HTTP 200', async () => {
  for (const response of [new Response('<html>blocked</html>'), new Response('{bad', { headers: { 'content-type': 'application/json' } })]) {
    const client = new JsonClient({ intervalMs: 0, fetchImpl: async () => response });
    await assert.rejects(client.json('https://example.test'), /non-JSON|malformed/);
  }
});
test('retry classification recognizes Node wrapped network errors and Retry-After', () => {
  assert.equal(isTransient(new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } })), true);
  assert.equal(isTransient(new TypeError('Invalid URL')), false);
  assert.equal(retryAfterMs('12'), 12000);
  assert.equal(retryAfterMs('Thu, 22 Oct 2026 10:00:01 GMT', Date.parse('2026-10-22T10:00:00Z')), 1000);
});
test('transient network failures retry; permanent HTTP errors do not', async () => {
  let calls = 0;
  const client = new JsonClient({ intervalMs: 0, fetchImpl: async () => {
    if (++calls === 1) throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } });
    return Response.json({ ok: true });
  } });
  assert.deepEqual(await client.json('https://example.test'), { ok: true }); assert.equal(calls, 2);
  calls = 0;
  const forbidden = new JsonClient({ intervalMs: 0, fetchImpl: async () => { calls++; return new Response('', { status: 403 }); } });
  await assert.rejects(forbidden.json('https://example.test'), { status: 403 }); assert.equal(calls, 1);
});
test('response size is bounded', async () => {
  const client = new JsonClient({ maxBytes: 2, fetchImpl: async () => Response.json({ long: 'value' }) });
  await assert.rejects(client.json('https://example.test'), /size limit/);
});
test('cancellation releases the caller promptly and does not poison the queue', async () => {
  const client = new JsonClient({ intervalMs: 1000, fetchImpl: async () => Response.json({}) });
  await client.json('https://example.test');
  const controller = new AbortController(); const start = Date.now();
  const promise = client.json('https://example.test', { signal: controller.signal });
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(promise); assert.ok(Date.now() - start < 500);
  client.intervalMs = 0; client.nextAt = 0;
  await client.json('https://example.test');
});
test('version history is idempotent and raw key ordering does not create versions', t => {
  const store = storeFor(t); const data = collection(); importOne(store, 'ctgov', data);
  importOne(store, 'ctgov', data);
  assert.equal(store.history('ctgov', 'NCT00000001').length, 1);
  const changed = structuredClone(data); changed.records[0].raw.hasResults = true;
  changed.records[0].trial.hasResults = true; importOne(store, 'ctgov', changed);
  assert.equal(store.history('ctgov', 'NCT00000001').length, 2);
  importOne(store, 'ctgov', data);
  assert.equal(store.get('ctgov', 'NCT00000001', { raw: true }).raw.hasResults, false);
  assert.equal(store.history('ctgov', 'NCT00000001').length, 2);
  assert.equal(canonical({ a: 1, b: 2 }), canonical({ b: 2, a: 1 }));
});
test('source import rollback leaves records, search index and revision intact', t => {
  const store = storeFor(t); importOne(store); const revision = store.revision();
  const data = collection(); data.records.push({ trial: { source: 'ctis' }, raw: {} });
  assert.throws(() => importOne(store, 'ctgov', data), /mismatch/);
  assert.equal(store.revision(), revision); assert.equal(store.search({ q: 'melanoma' }).totalCount, 1);
});
test('one failed source retains old data while the other source succeeds', async t => {
  const store = storeFor(t); importOne(store, 'ctis');
  const result = await sync(store, { adapters: {
    ctgov: { collect: async () => collection() }, ctis: { collect: async () => { throw new SourceError('Registry returned HTTP 503'); } },
  } });
  assert.equal(result.status, 'partial_failure'); assert.equal(store.search().totalCount, 2);
  const status = store.sourceStatus().find(x => x.source === 'ctis');
  assert.equal(status.lastRun.status, 'failed'); assert.equal(status.lastSuccess.status, 'ok');
});
test('search applies exact facets and treats FTS syntax as literal input', t => {
  const store = storeFor(t); importOne(store); importOne(store, 'ctis');
  assert.equal(store.search({ q: 'melanoma', country: 'italy' }).totalCount, 2);
  assert.equal(store.search({ recruitmentStatus: 'recruiting' }).totalCount, 1);
  assert.equal(store.search({ source: 'ctis', recruitmentStatus: 'recruiting' }).totalCount, 0);
  assert.equal(store.search({ q: 'melanoma OR nonexistent' }).totalCount, 0);
  assert.doesNotThrow(() => store.search({ q: '" OR * --' }));
  assert.throws(() => store.search({ limit: 'bad' }));
});
test('pagination rejects changed queries and index revisions', t => {
  const store = storeFor(t); importOne(store); importOne(store, 'ctis');
  const page = store.search({ limit: 1 }); assert.ok(page.nextCursor);
  const next = store.search({ limit: 1, cursor: page.nextCursor });
  assert.equal(next.records.length, 1); assert.notEqual(next.records[0].source, page.records[0].source);
  assert.throws(() => store.search({ q: 'other', limit: 1, cursor: page.nextCursor }), /match query/);
  importOne(store);
  assert.throws(() => store.search({ limit: 1, cursor: page.nextCursor }), { status: 409 });
  assert.throws(() => store.search({ cursor: Buffer.from('null').toString('base64url') }), { status: 400 });
});
test('sync validates scope before performing any network calls', async t => {
  const store = storeFor(t);
  await assert.rejects(sync(store, { sources: ['other'] }), /Sources/);
  await assert.rejects(sync(store, { limit: -1 }), /limit/);
  await assert.rejects(sync(store, { searchMode: 'invalid' }), /searchMode/);
});
test('HTTP API supports search, raw provenance, history and explicit failures', async t => {
  const store = storeFor(t); importOne(store);
  const server = createApi(store); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const results = await (await fetch(base + '/trials?q=melanoma')).json();
  assert.equal(results.totalCount, 1); assert.equal(results.countUnit, 'source_records');
  const detail = await (await fetch(base + '/trials/ctgov/NCT00000001')).json(); assert.ok(detail.raw);
  assert.equal((await fetch(base + '/trials/ctgov/NCT00000001/history')).status, 200);
  assert.equal((await fetch(base + '/trials/ctgov/NCT00000002')).status, 404);
  assert.equal((await fetch(base + '/trials?ignored=1')).status, 400);
  assert.equal((await fetch(base + '/trials?limit=0')).status, 400);
  assert.equal((await fetch(base + '/trials?source=ctgov&source=ctis')).status, 400);
  assert.equal((await fetch(base + '/trials', { method: 'POST' })).status, 405);
});

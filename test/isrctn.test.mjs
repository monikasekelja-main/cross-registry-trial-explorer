import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { JsonClient } from '../src/http-client.mjs';
import { createAdapters, buildSearchCriteria, normalizeIsrctn, validateId } from '../src/adapters.mjs';
import { Store } from '../src/store.mjs';
import { createApi } from '../src/server.mjs';
import { isrctnXml } from './fixtures.mjs';

function adapter(body, inspect = () => {}) {
  return createAdapters({ clients: { isrctn: new JsonClient({ intervalMs: 0, fetchImpl: async (url, options) => {
    inspect(url, options); return new Response(body, { headers: { 'content-type': 'application/xml;charset=UTF-8' } });
  } }) } }).isrctn;
}
test('ISRCTN condition and keyword queries use the documented bounded XML endpoint', async () => {
  let calls = 0;
  const source = adapter(isrctnXml(), (url, options) => {
    assert.equal(url.pathname, '/api/query/format/default');
    assert.equal(url.searchParams.get('limit'), '2');
    assert.equal(url.searchParams.get('q'), ++calls === 1 ? 'condition:"melanoma"' : 'melanoma OR cancer');
    assert.match(options.headers.Accept, /xml/);
  });
  const result = await source.collect({ query: 'melanoma', limit: 2 });
  assert.equal(result.upstreamTotal, 1); assert.equal(result.truncated, false);
  const { trial, raw } = result.records[0];
  assert.equal(trial.title, 'Melanoma & treatment'); assert.equal(trial.sourceId, 'ISRCTN12345678');
  assert.equal(trial.recruitmentStatus, 'recruiting'); assert.equal(trial.hasResults, true);
  assert.deepEqual(trial.countries, ['United Kingdom']); assert.equal(trial.sponsor, 'Example sponsor');
  assert.deepEqual(trial.identifiers[1], { registry: 'ctgov', value: 'NCT00000001' });
  assert.equal(raw.trial['@_lastUpdated'], trial.sourceUpdatedAt);
  await source.collect({ query: 'melanoma OR cancer', searchMode: 'keyword', limit: 2 });
  assert.deepEqual(buildSearchCriteria('isrctn', 'lung cancer'), { q: 'condition:"lung cancer"' });
});
test('ISRCTN handles zero, multiple, bounded and missing optional records', async () => {
  assert.deepEqual(await adapter('<allTrials totalCount="0"/>').collect({}), { records: [], upstreamTotal: 0, truncated: false, scanned: 0, filterCoverage: 'upstream', upstreamTotalScope: 'source query before local filters; approximate' });
  const one = isrctnXml().match(/<fullTrial>[\s\S]*<\/fullTrial>/)[0];
  const response = await adapter(`<allTrials totalCount="4">${one}${one.replaceAll('ISRCTN12345678', 'ISRCTN87654321')}</allTrials>`).collect({ limit: 2 });
  assert.equal(response.records.length, 2); assert.equal(response.truncated, true);
  const sparse = normalizeIsrctn({ trial: { '@_publicIdentifierCanonical': 'ISRCTN12345678', trialDescription: { title: 'Sparse' } } });
  assert.equal(sparse.recruitmentStatus, 'unknown'); assert.equal(sparse.hasResults, null); assert.deepEqual(sparse.conditions, []);
});
test('ISRCTN rejects malformed, unsafe, HTML, missing identifiers and inconsistent counts', async () => {
  for (const body of ['<allTrials>', '<html/>', '<!DOCTYPE a [<!ENTITY x "hi">]><allTrials totalCount="0"/>',
    '<allTrials totalCount="bad"/>', '<allTrials totalCount="1"/>', isrctnXml('bad')]) {
    await assert.rejects(adapter(body).collect({ query: 'melanoma' }));
  }
  assert.throws(() => validateId('isrctn', '../12345678'));
  const html = new JsonClient({ fetchImpl: async () => new Response('<html/>', { headers: { 'content-type': 'text/html' } }) });
  await assert.rejects(html.xml('https://example.test'), /non-XML/);
  const oversized = new JsonClient({ maxBytes: 2, fetchImpl: async () => new Response(isrctnXml(), { headers: { 'content-type': 'text/xml' } }) });
  await assert.rejects(oversized.xml('https://example.test'), /size limit/);
});
test('ISRCTN imports work with local filtering, raw retrieval and HTTP routes', async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  store.commitSource('isrctn', await adapter(isrctnXml()).collect({}), {}, new Date().toISOString());
  assert.equal(store.search({ source: 'isrctn', q: 'melanoma' }).totalCount, 1);
  assert.ok(store.get('isrctn', 'ISRCTN12345678', { raw: true }).raw.trial);
  const server = createApi(store); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base + '/trials/isrctn/ISRCTN12345678')).status, 200);
  assert.equal((await fetch(base + '/trials/isrctn/ISRCTN12345678/history')).status, 200);
});

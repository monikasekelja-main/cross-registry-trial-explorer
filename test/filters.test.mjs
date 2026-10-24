import test from 'node:test';
import assert from 'node:assert/strict';
import { XMLParser } from 'fast-xml-parser';
import { buildSearchCriteria, normalizeCtgov, normalizeCtis, normalizeIsrctn, createAdapters, matchesFilters } from '../src/adapters.mjs';
import { Store } from '../src/store.mjs';
import { sync } from '../src/sync.mjs';
import { ctgovRecord, ctisRecord, ctisSummary, isrctnXml } from './fixtures.mjs';
const filters = { recruitmentStatus: 'recruiting', studyType: 'interventional', primaryPurpose: 'treatment' };
function ctgovTreatment() {
  const raw = ctgovRecord(); raw.protocolSection.designModule = { studyType: 'INTERVENTIONAL', designInfo: { primaryPurpose: 'TREATMENT' } }; return raw;
}
function ctisTreatment(id) {
  const raw = ctisRecord(id); raw.ctPublicStatusCode = 4;
  raw.authorizedApplication.authorizedPartI.trialDetails.trialInformation = { trialObjective: { trialScopes: [{ code: '3' }] } }; return raw;
}
test('filters compose with AND and preserve keyword expression grouping', () => {
  assert.deepEqual(buildSearchCriteria('ctgov', 'melanoma', 'condition', filters), {
    'query.term': 'AREA[Condition]"melanoma" AND AREA[StudyType]INTERVENTIONAL AND AREA[DesignPrimaryPurpose]TREATMENT', 'filter.overallStatus': 'RECRUITING',
  });
  assert.match(buildSearchCriteria('ctgov', 'melanoma OR cancer', 'keyword', filters)['query.term'], /^\(melanoma OR cancer\) AND/);
  assert.deepEqual(buildSearchCriteria('ctis', 'melanoma', 'condition', filters), { medicalCondition: 'melanoma', status: [3,4] });
  assert.deepEqual(buildSearchCriteria('isrctn', 'melanoma', 'condition', filters), { q: 'condition:"melanoma"' });
  for (const bad of [{ recruitmentStatus: 'anything' }, { studyType: 'anything' }, { primaryPurpose: 'anything' }, { studyType: 'observational', primaryPurpose: 'treatment' }]) assert.throws(() => buildSearchCriteria('ctgov', 'melanoma', 'condition', bad));
});
test('normalization requires explicit treatment evidence and status, excluding diagnostics and invitations', () => {
  const trial = normalizeCtgov(ctgovTreatment()); assert.equal(matchesFilters(trial, filters), true);
  const observational = ctgovTreatment(); observational.protocolSection.designModule.studyType = 'OBSERVATIONAL';
  assert.equal(matchesFilters(normalizeCtgov(observational), filters), false);
  const invited = ctgovTreatment(); invited.protocolSection.statusModule.overallStatus = 'ENROLLING_BY_INVITATION';
  assert.equal(matchesFilters(normalizeCtgov(invited), filters), false);
  const raw = ctisTreatment(); assert.equal(matchesFilters(normalizeCtis(raw), filters), true);
  raw.ctPublicStatusCode = 2; assert.equal(normalizeCtis(raw).recruitmentStatus, 'not_yet_recruiting');
  raw.ctPublicStatusCode = 5; assert.equal(normalizeCtis(raw).recruitmentStatus, 'active_not_recruiting');
  delete raw.ctPublicStatusCode; raw.authorizedApplication.authorizedPartsII[0].mscInfo.hasRecruitmentStarted = true;
  assert.equal(normalizeCtis(raw).recruitmentStatus, 'unknown');
  const sparse = normalizeCtgov(ctgovRecord()); assert.equal(matchesFilters(sparse, filters), false);
});
test('CTIS scans past non-treatment hits before applying result limit', async () => {
  const summaries = ['2026-500001-01-00','2026-500002-01-00','2026-500003-01-00'].map(ctisSummary);
  let details = 0;
  const adapter = createAdapters({ clients: { ctis: { json: async (url, options) => {
    if (options.method === 'POST') {
      assert.deepEqual(JSON.parse(options.body).searchCriteria, { medicalCondition: 'melanoma', status: [3,4] });
      return { data: summaries, pagination: { totalRecords: 3, nextPage: false } };
    }
    details++; const raw = ctisTreatment(url.split('/').at(-1));
    if (details === 1) raw.authorizedApplication.authorizedPartI.trialDetails.trialInformation.trialObjective.trialScopes = [{ code: '1' }];
    return raw;
  } } } }).ctis;
  const result = await adapter.collect({ query: 'melanoma', limit: 2, ...filters });
  assert.equal(result.records.length, 2); assert.equal(result.scanned, 3);
  assert.equal(result.records[0].trial.sourceId, '2026-500002-01-00'); assert.equal(result.truncated, false);
});
test('CTIS bounded scan reports truncation when more candidates remain', async () => {
  let detailCount = 0;
  const adapter = createAdapters({ clients: { ctis: { json: async (url, options) => {
    if (options.method === 'POST') return { data: Array.from({ length: 40 }, (_,i) => ctisSummary(`2026-${String(500000+i)}-01-00`)), pagination: { totalRecords: 100, nextPage: true } };
    detailCount++; return ctisRecord(url.split('/').at(-1));
  } } } }).ctis;
  const result = await adapter.collect({ query: 'melanoma', limit: 2, ...filters });
  assert.equal(detailCount, 40); assert.equal(result.records.length, 0); assert.equal(result.truncated, true);
});
test('ISRCTN joins published WHO statuses by ID, scans past diagnostics, and retains status evidence', async () => {
  const original = isrctnXml().match(/<fullTrial>[\s\S]*<\/fullTrial>/)[0];
  const treatment = original.replace('ISRCTN12345678','ISRCTN87654321').replace('</trial>', '<trialDesign><primaryStudyDesign>Interventional</primaryStudyDesign><trialTypes><trialType>Treatment</trialType></trialTypes></trialDesign></trial>');
  const parsed = new XMLParser({ ignoreAttributes: false, parseTagValue: false });
  const adapter = createAdapters({ clients: { isrctn: { xml: async url => {
    assert.equal(url.searchParams.get('limit'), '100');
    assert.equal(url.searchParams.get('q'), 'condition:"melanoma"');
    return parsed.parse(url.pathname.endsWith('/who') ? '<trials><trial><main><trial_id>ISRCTN87654321</trial_id><recruitment_status>Recruiting</recruitment_status></main></trial><trial><main><trial_id>ISRCTN12345678</trial_id><recruitment_status>No longer recruiting</recruitment_status></main></trial></trials>' : `<allTrials totalCount="2">${original}${treatment}</allTrials>`);
  } } } }).isrctn;
  const result = await adapter.collect({ query: 'melanoma', limit: 1, ...filters });
  assert.equal(result.records.length, 1); assert.equal(result.records[0].trial.sourceId, 'ISRCTN87654321');
  assert.equal(result.scanned, 2); assert.equal(result.upstreamTotal, 2);
  assert.equal(result.records[0].raw.who.main.recruitment_status, 'Recruiting');
  assert.match(result.records[0].trial.recruitmentStatusBasis, /WHO/);
  assert.equal(normalizeIsrctn(result.records[0].raw).studyType, 'interventional');
});
test('sync records filters and refuses mismatching adapter results without replacing cache', async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  let called = false;
  const adapters = { ctgov: { collect: async received => {
    called = true; assert.equal(received.primaryPurpose, 'treatment');
    const raw = ctgovTreatment(); return { records: [{ raw, trial: normalizeCtgov(raw) }], upstreamTotal: 1, truncated: false };
  } } };
  const result = await sync(store, { sources: ['ctgov'], query: 'melanoma', ...filters, adapters });
  assert.equal(called, true); assert.equal(result.status, 'ok');
  assert.equal(store.sourceStatus()[0].lastSuccess.scope.studyType, 'interventional');
  assert.equal(store.search({ ...filters }).totalCount, 1);
  const page = store.search({ limit: 1 });
  assert.equal(page.records[0].primaryPurpose, 'treatment');
  adapters.ctgov.collect = async () => ({ records: [{ raw: ctgovRecord(), trial: normalizeCtgov(ctgovRecord()) }] });
  const failed = await sync(store, { sources: ['ctgov'], ...filters, adapters });
  assert.equal(failed.status, 'partial_failure'); assert.equal(store.search({ ...filters }).totalCount, 1);
  await assert.rejects(sync(store, { studyType: 'invalid' }), /studyType/);
});


test('saved study-type filters exclude older unclassified records and bind pagination cursors', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const raw = ctgovTreatment(); const trial = normalizeCtgov(raw);
  store.commitSource('ctgov', { records: [{raw, trial}, {raw, trial: {...trial, sourceId: 'NCT00000002'}}] }, {}, new Date().toISOString());
  const page = store.search({studyType: 'interventional', limit: 1});
  assert.ok(page.nextCursor);
  assert.throws(() => store.search({studyType: 'observational', limit: 1, cursor: page.nextCursor}), /match query/);
  assert.equal(store.search({studyType: 'observational'}).totalCount, 0);
});


test('ISRCTN melanoma condition search excludes non-melanoma-only hits before limiting', async () => {
  const original = isrctnXml().match(/<fullTrial>[\s\S]*<\/fullTrial>/)[0];
  const excluded = original.replace('<description>Melanoma</description>', '<description>Non-melanoma skin cancer</description>');
  const included = original.replace('ISRCTN12345678', 'ISRCTN87654321');
  const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false });
  const adapter = createAdapters({ clients: { isrctn: { xml: async () => parser.parse(`<allTrials totalCount="2">${excluded}${included}</allTrials>`) } } }).isrctn;
  const result = await adapter.collect({ query: 'melanoma', studyType: undefined, limit: 1, primaryPurpose: undefined, recruitmentStatus: undefined });
  // An unfiltered call is bounded by its requested sample, so use a larger sample to inspect both.
  const full = await adapter.collect({ query: 'melanoma', limit: 2 });
  assert.equal(result.records.length, 1); assert.equal(full.records.length, 1);
  assert.equal(full.records[0].trial.sourceId, 'ISRCTN87654321');
});


test('ClinicalTrials.gov unknown-status filter scans candidates rather than reporting mismatching records', async () => {
  const unknown = ctgovRecord('NCT00000002'); unknown.protocolSection.statusModule.overallStatus = 'UNKNOWN';
  const adapter = createAdapters({clients: {ctgov: {json: async () => ({studies: [ctgovRecord(), unknown], totalCount: 2})}}}).ctgov;
  const result = await adapter.collect({query: 'melanoma', recruitmentStatus: 'unknown', limit: 1});
  assert.equal(result.records[0].trial.sourceId, 'NCT00000002'); assert.equal(result.scanned, 2);
});

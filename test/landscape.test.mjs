import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { Store } from '../src/store.mjs';
import { JsonClient } from '../src/http-client.mjs';
import { EvidenceService } from '../src/evidence.mjs';
import { LandscapeService, extractInterventions, groupRegistrations, splitIntervention } from '../src/landscape.mjs';
import { createMcpServer } from '../src/mcp.mjs';
import { normalizeCtgov } from '../src/adapters.mjs';
import { ctgovRecord } from './fixtures.mjs';

// Reviewed identity/mechanism anchors from the live ChEMBL/OT ivacaftor records;
// fictional names below exercise failures and must never substitute for registry data.
const molecule = { molecule_chembl_id: 'CHEMBL2010601', pref_name: 'IVACAFTOR', structure_type: 'MOL', molecule_type: 'Small molecule',
  molecule_hierarchy: { parent_chembl_id: 'CHEMBL2010601' }, molecule_synonyms: [{ molecule_synonym: 'KALYDECO' }] };
const mechanism = { mec_id: 965, molecule_chembl_id: 'CHEMBL2010601', target_chembl_id: 'CHEMBL4051', direct_interaction: 1, disease_efficacy: 1,
  mechanism_of_action: 'Cystic fibrosis transmembrane conductance regulator positive modulator', action_type: 'POSITIVE MODULATOR',
  mechanism_refs: [{ ref_type: 'DailyMed', ref_url: 'https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=0ab0c9f8-3eee-4e0f-9f3f-c1e16aaffe25' }] };
function fakeEvidence(store, { ambiguous = false, failOT = false, failChembl = false } = {}) {
  let calls = 0;
  const chembl = new JsonClient({ intervalMs: 0, attempts: 1, fetchImpl: async url => {
    calls++; url = new URL(url); const path = url.pathname;
    if (failChembl) return new Response('', { status: 503 });
    if (path.endsWith('/status.json')) return Response.json({ chembl_db_version: 'test-release', chembl_release_date: '2026-10-26' });
    if (path.endsWith('/molecule.json')) {
      const q = [...url.searchParams].find(([key]) => key.endsWith('iexact'))?.[1];
      const rows = ['ivacaftor','kalydeco'].includes(q?.toLowerCase()) ? [molecule] : [];
      return Response.json({ molecules: ambiguous && rows.length ? [...rows, { ...molecule, molecule_chembl_id: 'CHEMBL999', molecule_hierarchy: { parent_chembl_id: 'CHEMBL999' } }] : rows, page_meta: { next: null } });
    }
    if (path.endsWith('/molecule/CHEMBL2010601.json')) return Response.json(molecule);
    if (path.endsWith('/mechanism.json')) return Response.json({ mechanisms: [mechanism], page_meta: { next: null } });
    if (path.endsWith('/target/CHEMBL4051.json')) return Response.json({ target_chembl_id: 'CHEMBL4051', pref_name: 'CFTR', target_type: 'SINGLE PROTEIN', organism: 'Homo sapiens', target_components: [{ accession: 'P13569', component_description: 'CFTR', target_component_synonyms: [{ component_synonym: 'CFTR', syn_type: 'GENE_SYMBOL' }] }] });
    throw new Error(`Unexpected fixture URL ${url}`);
  } });
  const openTargets = new JsonClient({ intervalMs: 0, attempts: 1, fetchImpl: async (_url, options) => {
    calls++; const { query } = JSON.parse(options.body);
    if (query.includes('search(')) return Response.json({ data: { search: { hits: [{ id: 'MONDO_0009061', name: 'cystic fibrosis', entity: 'disease' }] } } });
    if (failOT) return Response.json({ errors: [{ message: 'Unavailable' }] });
    return Response.json({ data: { drug: { id: 'CHEMBL2010601', mechanismsOfAction: { rows: [{ mechanismOfAction: 'CFTR positive modulator', targets: [{ id: 'ENSG00000001626', approvedSymbol: 'CFTR' }], references: [] }] } } } });
  } });
  return { evidence: new EvidenceService(store, { chembl, openTargets }), calls: () => calls };
}
function collection({ id = 'NCT00000001', role = 'EXPERIMENTAL', status = 'RECRUITING', name = 'ivacaftor' } = {}) {
  const raw = ctgovRecord(id); raw.protocolSection.conditionsModule.conditions = ['Cystic Fibrosis']; raw.protocolSection.statusModule.overallStatus = status;
  raw.protocolSection.designModule = { studyType: 'INTERVENTIONAL', phases: ['PHASE2'], designInfo: { primaryPurpose: 'TREATMENT' } };
  raw.protocolSection.armsInterventionsModule = { armGroups: [{ label: 'arm', type: role }], interventions: [{ name, type: 'DRUG', armGroupLabels: ['arm'] }] };
  return { records: [{ raw, trial: normalizeCtgov(raw) }], upstreamTotal: 1, truncated: false };
}
async function finished(service, id) {
  for (let i = 0; i < 500; i++) { const j = service.get(id); if (!['queued','running'].includes(j.status)) return j; await setTimeout(2); }
  throw new Error('Fixture job timed out');
}
function setup(t, opts = {}) {
  const store = new Store(':memory:'); const { evidence, calls } = fakeEvidence(store, opts);
  t.after(() => store.close()); return { store, evidence, calls };
}
test('exact generic/brand identity resolves; fuzzy codes, mixtures and ambiguous identities do not auto-resolve', async t => {
  const { evidence, store } = setup(t);
  for (const name of ['ivacaftor','Kalydeco','CHEMBL2010601']) assert.equal((await evidence.resolve(name)).candidates[0].id, 'CHEMBL2010601');
  assert.equal((await evidence.resolve('VX-unknown')).status, 'unresolved');
  assert.equal((await evidence.resolve('placebo')).status, 'not_a_drug');
  assert.equal((await fakeEvidence(store, { ambiguous: true }).evidence.resolve('ivacaftor', { refresh: true })).status, 'ambiguous');
});
test('curated target evidence retains direct relationship, species, references and shared lineage', async t => {
  const { evidence } = setup(t); const result = await evidence.targets('CHEMBL2010601');
  assert.equal(result.mechanisms.length, 1); assert.equal(result.mechanisms[0].target.organism, 'Homo sapiens');
  assert.equal(result.mechanisms[0].target.components[0].accession, 'P13569'); assert.equal(result.mechanisms[0].relationship, 'direct');
  assert.ok(result.mechanisms[0].references.length); assert.equal(result.integratedMechanisms[0].targets[0].approvedSymbol, 'CFTR');
  assert.match(result.notice, /reuses ChEMBL/); assert.ok(result.evidence.every(e => e.hash && e.retrievedAt && !e.raw));
  await assert.rejects(evidence.targets('../etc'), /identifier/);
});
test('evidence cache avoids repeat calls, refresh preserves versions and failures do not substitute stale data', async t => {
  const { evidence, store, calls } = setup(t);
  await evidence.resolve('ivacaftor'); const before = calls(); await evidence.resolve('ivacaftor'); assert.equal(calls(), before);
  await evidence.resolve('ivacaftor', { refresh: true }); assert.ok(calls() > before);
  assert.ok(store.db.prepare('SELECT count(*) AS n FROM evidence').get().n >= 2);
  await assert.rejects(fakeEvidence(store, { failChembl: true }).evidence.resolve('ivacaftor', { refresh: true }), /503/);
  const partial = await fakeEvidence(store, { failOT: true }).evidence.targets('CHEMBL2010601', { refresh: true });
  assert.equal(partial.status, 'partial_failure'); assert.equal(partial.mechanisms.length, 1);
});
test('disease names require exact canonical identity and never silently choose a complication', async t => {
  const { evidence } = setup(t); assert.equal((await evidence.disease('Cystic fibrosis')).id, 'MONDO_0009061');
  assert.equal((await evidence.disease('MONDO_0009061')).name, 'cystic fibrosis');
  assert.equal((await evidence.disease('mucoviscidosis')).id, 'MONDO_0009061');
  await assert.rejects(evidence.disease('CF'), /ambiguous/);
});
test('intervention roles preserve comparator, unknown, experimental and explicit test evidence', () => {
  const sample = collection(); assert.equal(extractInterventions(sample.records[0].trial, sample.records[0].raw)[0].role, 'experimental_arm');
  const comparator = collection({ role: 'ACTIVE_COMPARATOR' }); assert.equal(extractInterventions(comparator.records[0].trial, comparator.records[0].raw)[0].role, 'comparator');
  const ctis = extractInterventions({ source: 'ctis' }, { detail: { authorizedApplication: { authorizedPartI: { products: [{ productName: 'Kalydeco', mpRoleInTrial: '1', productDictionaryInfo: { productSubstances: [{ actSubstName: 'ivacaftor' }] } }] } } } });
  assert.equal(ctis[0].role, 'investigational'); assert.deepEqual(ctis[0].ingredients, ['ivacaftor']);
  assert.equal(extractInterventions({source:'isrctn'}, {trial:{interventions:{intervention:{drugNames:'ivacaftor'}}}})[0].role, 'unknown');
  assert.deepEqual(splitIntervention('elexacaftor/tezacaftor/ivacaftor'), ['elexacaftor','tezacaftor','ivacaftor']);
  assert.deepEqual(splitIntervention('drug 10 mg/mL'), ['drug 10 mg/mL']);
  assert.deepEqual(splitIntervention('n/a'), ['n/a']);
});
test('explicit-ID grouping is transitive, keeps registrations and never merges titles alone', () => {
  const a = collection().records[0].trial;
  const b = { ...a, source: 'ctis', sourceId: '2026-500001-01-00', identifiers: [{registry:'ctgov', value: a.sourceId}] };
  const c = { ...a, source: 'isrctn', sourceId: 'ISRCTN12345678', identifiers: [{registry:'ctis',value:b.sourceId}] };
  const d = { ...a, sourceId: 'NCT00000002', identifiers: [] };
  const groups = groupRegistrations([a,b,c,d]); assert.equal(groups.length, 2); assert.equal(groups[0].registrations.length, 3);
});
test('landscape preserves drug/trial evidence and does not turn comparator or experimental background into confirmed programs', async t => {
  const { store, evidence } = setup(t); const dir = mkdtempSync(join(tmpdir(),'landscape-')); t.after(() => rmSync(dir,{recursive:true,force:true}));
  const service = new LandscapeService(store, { evidence, exportRoot: dir, adapters: { ctgov: { collect: async () => {
    const a = collection(); a.records.push(...collection({id:'NCT00000002',role:'ACTIVE_COMPARATOR'}).records, ...collection({id:'NCT00000003',name:'unknown-gene-therapy'}).records);
    return a;
  } } } }); t.after(() => service.close());
  const started = service.start({ disease:'cystic fibrosis', sources:['ctgov'] }); const job = await finished(service, started.jobId);
  assert.equal(job.status,'complete',JSON.stringify(job.errors)); assert.equal(job.total,1); assert.equal(job.items[0].highestSupportedPhaseInDisease,null);
  assert.equal(job.items[0].highestPhaseObservedInDiseaseTrials,2);
  assert.ok(job.items[0].supportingRegistrations.every(s=>!s.clinicalDevelopmentEvidence)); assert.equal(job.coverage.complete,false);
  const unresolved = service.get(job.jobId,{section:'unresolved'}); assert.equal(unresolved.total,1); assert.equal(unresolved.items[0].name,'unknown-gene-therapy');
  const files=service.export(job.jobId); const snapshot=JSON.parse(readFileSync(files.json)); assert.equal(snapshot.rows.length,1); assert.ok(snapshot.rawRegistrations[0].raw); assert.ok(snapshot.rawEnrichmentEvidence[0].raw); assert.ok(readFileSync(files.csv,'utf8').includes('CFTR'));
  const second=await finished(service,service.start({disease:'cystic fibrosis',sources:['ctgov']}).jobId);
  assert.deepEqual(service.compare(job.jobId,second.jobId).added,[]);
});
test('failed-source checkpoints are retried without recollecting successful sources', async t => {
  const {store,evidence}=setup(t); let ctgov=0; let fail=true;
  const service=new LandscapeService(store,{evidence,adapters:{ctgov:{collect:async()=>{ctgov++;return collection();}},ctis:{collect:async()=>{if(fail)throw new Error('Unavailable');return {records:[],upstreamTotal:0,truncated:false};}}}});t.after(()=>service.close());
  const first=await finished(service,service.start({disease:'cystic fibrosis',sources:['ctgov','ctis']}).jobId);assert.equal(first.status,'partial_failure');
  fail=false; service.resume(first.jobId);const second=await finished(service,first.jobId);assert.equal(second.status,'complete');assert.equal(ctgov,1);
  assert.notEqual(first.snapshotId,second.snapshotId);
  assert.equal(service.get(first.snapshotId).status,'partial_failure');
  assert.equal(service.get(second.snapshotId).status,'complete');
  assert.throws(()=>service.resume(first.snapshotId),/immutable/);
});
test('cancellation checkpoints survive reopening the service and can resume', async t => {
  const {store,evidence}=setup(t);let block=true;let entered;const enteredPromise=new Promise(r=>{entered=r;});
  const adapters={ctgov:{collect:async({signal})=>{if(!block)return collection();entered();await new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));}}};
  const first=new LandscapeService(store,{evidence,adapters});const id=first.start({disease:'cystic fibrosis',sources:['ctgov']}).jobId;await enteredPromise;first.cancel(id);await first.close();
  assert.equal(first.get(id).status,'interrupted');block=false;const next=new LandscapeService(store,{evidence,adapters});t.after(()=>next.close());next.resume(id);assert.equal((await finished(next,id)).status,'complete');
});
test('MCP landscape tools start, poll, expose evidence and reject invalid inputs', async t => {
  const {store,evidence}=setup(t);const landscapes=new LandscapeService(store,{evidence,adapters:{ctgov:{collect:async()=>collection()}}});
  const server=createMcpServer(store,{evidence,landscapes});const [a,b]=InMemoryTransport.createLinkedPair();const client=new Client({name:'landscape-test',version:'1'});
  t.after(async()=>{await client.close();await landscapes.close();await server.close();});await server.connect(b);await client.connect(a);
  const resolve=await client.callTool({name:'resolve_intervention',arguments:{name:'ivacaftor'}});assert.equal(resolve.structuredContent.status,'resolved');
  const start=await client.callTool({name:'get_clinical_target_landscape',arguments:{disease:'cystic fibrosis',sources:['ctgov']}});assert.notEqual(start.isError,true);
  await finished(landscapes,start.structuredContent.jobId);const result=await client.callTool({name:'get_landscape_job',arguments:{jobId:start.structuredContent.jobId}});assert.equal(result.structuredContent.total,1);
  assert.equal((await client.callTool({name:'get_drug_targets',arguments:{drugId:'../etc'}})).isError,true);
  assert.equal((await client.callTool({name:'get_landscape_job',arguments:{jobId:'not-a-uuid'}})).isError,true);
});


test('completed snapshots and evidence persist across database reopen', async t => {
  const dir=mkdtempSync(join(tmpdir(),'landscape-db-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const path=join(dir,'trials.sqlite');let store=new Store(path);const {evidence}=fakeEvidence(store);
  const service=new LandscapeService(store,{evidence,adapters:{ctgov:{collect:async()=>collection()}}});
  const job=await finished(service,service.start({disease:'cystic fibrosis',sources:['ctgov']}).jobId);
  await service.close();store.close();store=new Store(path);t.after(()=>store.close());
  const reopened=new LandscapeService(store);t.after(()=>reopened.close());assert.equal(reopened.get(job.snapshotId).total,1);
  assert.equal(reopened.get(job.jobId).snapshotId,job.snapshotId);assert.ok(store.db.prepare('SELECT count(*) AS n FROM evidence').get().n>0);
});
test('source evidence never uses a mismatched explicit molecule identifier', async t => {
  const {store}=setup(t);const client=new JsonClient({intervalMs:0,fetchImpl:async()=>Response.json({...molecule,molecule_chembl_id:'CHEMBL999'})});
  await assert.rejects(new EvidenceService(store,{chembl:client}).resolve('CHEMBL2010601'),/ID mismatch/);
});
test('another service cannot resume a live job and oversized/noncanonical input is rejected', async t => {
  const {store,evidence}=setup(t);let entered;const ready=new Promise(r=>{entered=r;});
  const service=new LandscapeService(store,{evidence,adapters:{ctgov:{collect:async({signal})=>{entered();await new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));}}}});t.after(()=>service.close());
  const id=service.start({disease:'cystic fibrosis',sources:['ctgov']}).jobId;await ready;
  const other=new LandscapeService(store,{evidence});t.after(()=>other.close());assert.throws(()=>other.resume(id),/running/);
  assert.throws(()=>service.start({disease:'cystic fibrosis'}),/running/);service.cancel(id);await service.close();
  assert.throws(()=>other.start({disease:'cystic fibrosis',limitPerSource:501}),/1–500/);
});


test('an explicit CTIS test role supports disease-specific phase while genetic payloads remain unresolved', async t => {
  const {store,evidence}=setup(t);
  const raw={detail:{authorizedApplication:{authorizedPartI:{products:[{productName:'Kalydeco',mpRoleInTrial:'1',productDictionaryInfo:{productSubstances:[{actSubstName:'ivacaftor'}]}}]}}}};
  const trial={...collection().records[0].trial,source:'ctis',sourceId:'2026-500001-01-00',phases:['Therapeutic confirmatory (Phase III)'],primaryPurpose:'treatment'};
  const genetic=collection({id:'NCT00000002',name:'CFTR gene replacement'});genetic.records[0].raw.protocolSection.armsInterventionsModule.interventions[0].type='GENETIC';
  const service=new LandscapeService(store,{evidence,adapters:{ctis:{collect:async()=>({records:[{raw,trial}],upstreamTotal:1,truncated:false})},ctgov:{collect:async()=>genetic}}});t.after(()=>service.close());
  const job=await finished(service,service.start({disease:'cystic fibrosis',sources:['ctis','ctgov']}).jobId);
  assert.equal(job.items[0].highestSupportedPhaseInDisease,3);assert.equal(job.items[0].mechanismInThisDisease,'pilot_reference_anchor');
  const unresolved=service.get(job.jobId,{section:'unresolved'});assert.equal(unresolved.items[0].intervention.interventionCategory,'gene_or_rna_therapy');
  assert.equal(unresolved.items[0].name,'CFTR gene replacement');
});


test('ongoing includes active-not-recruiting while recruiting view excludes it and unknown status', async t => {
  const {store,evidence}=setup(t);const adapter={collect:async()=>({records:[...collection({status:'ACTIVE_NOT_RECRUITING'}).records,...collection({id:'NCT00000002',status:'UNKNOWN'}).records],upstreamTotal:2,truncated:false})};
  const service=new LandscapeService(store,{evidence,adapters:{ctgov:adapter}});t.after(()=>service.close());
  const ongoing=await finished(service,service.start({disease:'cystic fibrosis',sources:['ctgov'],view:'ongoing'}).jobId);assert.equal(ongoing.coverage.selectedRegistrations,1);
  const recruiting=await finished(service,service.start({disease:'cystic fibrosis',sources:['ctgov'],view:'recruiting'}).jobId);assert.equal(recruiting.coverage.selectedRegistrations,0);assert.equal(recruiting.total,0);
});
test('export escapes spreadsheet formulas and keeps immutable source evidence', async t => {
  const {store,evidence}=setup(t);const dir=mkdtempSync(join(tmpdir(),'landscape-csv-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const service=new LandscapeService(store,{evidence,exportRoot:dir,adapters:{ctgov:{collect:async()=>collection()}}});t.after(()=>service.close());
  const job=await finished(service,service.start({disease:'cystic fibrosis',sources:['ctgov']}).jobId);
  const original=store.loadLandscape(job.jobId);const changed=structuredClone(original);changed.rows[0].drug.name='=UNTRUSTED()';store.saveLandscape(changed);
  const current=service.export(job.jobId);assert.ok(readFileSync(current.csv,'utf8').includes("'=UNTRUSTED()"));
  const historical=service.export(job.snapshotId);assert.equal(JSON.parse(readFileSync(historical.json)).rows[0].drug.name,'IVACAFTOR');
  // A historical snapshot uses its original registry/evidence versions even if the current record changes.
  const newData=collection();newData.records[0].raw.hasResults=true;store.commitSource('ctgov',newData,{},new Date().toISOString());
  const preserved=JSON.parse(readFileSync(service.export(job.snapshotId).json));assert.equal(preserved.rawRegistrations[0].raw.hasResults,false);
});

test('full landscape modes override only CT.gov sampling and attempt every intervention', async t => {
  const {store,evidence}=setup(t);let allFlag;
  const service=new LandscapeService(store,{evidence,adapters:{ctgov:{collect:async args=>{
    allFlag=args.allRecords;const data=collection();data.records.push(...collection({id:'NCT00000002',name:'unknown-one'}).records,...collection({id:'NCT00000003',name:'unknown-two'}).records);
    return {...data,upstreamTotal:3,reconciled:true};
  }}}});t.after(()=>service.close());
  const job=await finished(service,service.start({disease:'cystic fibrosis',sources:['ctgov'],limitPerSource:1,maxInterventions:1,collectAllCtgov:true,enrichAllInterventions:true}).jobId);
  assert.equal(allFlag,true);assert.equal(job.coverage.ctgovComplete,true);assert.equal(job.coverage.omittedInterventionNames.length,0);assert.equal(job.coverage.allInterventionNamesAttempted,true);assert.equal(job.progress.interventionsCompleted,3);
});

test('deuterated drug identity is retained rather than collapsed to its non-isotopic parent', async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const isotope = { ...molecule, molecule_chembl_id: 'CHEMBL4297603', pref_name: 'DEUTIVACAFTOR', molecule_structures: { standard_inchi: 'InChI=1S/fixture/i1D3' } };
  const evidence = new EvidenceService(store, { chembl: { json: async () => ({ molecules: [isotope], page_meta: { next: null } }) } });
  const resolved = await evidence.resolve('deutivacaftor');
  assert.equal(resolved.status, 'resolved'); assert.equal(resolved.candidates[0].id, 'CHEMBL4297603');
});

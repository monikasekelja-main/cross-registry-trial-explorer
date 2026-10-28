import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Client,InMemoryTransport} from '@modelcontextprotocol/client';
import {Store} from '../src/store.mjs';
import {LandscapeService,extractInterventions} from '../src/landscape.mjs';
import {createMcpServer} from '../src/mcp.mjs';
import {normalizeCtgov} from '../src/adapters.mjs';
import {ctgovRecord} from './fixtures.mjs';
import {CF_REVIEW,reviewContext,cfScope} from '../src/cf-review.mjs';
const nameHash=n=>createHash('sha256').update(n).digest('hex');
// Synthetic protocols and targets: test applicability, never substitute for medical evidence.
function record(id='NCT05248230',name='4D-710') {
  const raw=ctgovRecord(id);const p=raw.protocolSection;
  p.conditionsModule={conditions:['Cystic Fibrosis']};p.descriptionModule={briefSummary:'Synthetic gene therapy trial'};
  p.designModule={studyType:'INTERVENTIONAL',phases:['PHASE2'],designInfo:{primaryPurpose:'TREATMENT'}};
  p.armsInterventionsModule={armGroups:[{label:'arm',type:'EXPERIMENTAL'}],interventions:[{name,type:'GENETIC',armGroupLabels:['arm']}]};
  return {raw,trial:normalizeCtgov(raw)};
}
function bundleFor(records,names=['4d-710'],products=['4d-710']) {
  return {ledger:{...structuredClone(CF_REVIEW.ledger),items:names.map(name=>({nameHash:nameHash(name),registrations:[{id:`ctgov:${records[0].trial.sourceId}`,versionHash:'reviewed-version',url:'https://example.org/synthetic'}],decision:'identified',note:'Synthetic reviewed mapping',products,references:[]})),excludedRegistrations:[]},
    contexts:{ledgerVersion:CF_REVIEW.ledger.version,contextSchema:1,registrations:{[`ctgov:${records[0].trial.sourceId}`]:{reviewedSourceVersion:'reviewed-version',contextHash:reviewContext(records[0].trial,records[0].raw)}}}};
}
function evidenceFor(store,{fail=false,diseaseId='MONDO_0009061'}={}) {
  const e=store.evidencePut('fixture',{source:'fixture',url:'https://example.org/synthetic',raw:{fixture:true},retrievedAt:new Date().toISOString()});const {raw,...ref}=e;let attempts=0;
  return {get attempts(){return attempts;},disease:async()=>({id:diseaseId,name:'cystic fibrosis',evidence:ref}),versions:async()=>({evidence:ref}),
    resolve:async name=>{attempts++;if(fail)throw new Error('Fixture service failed');return {status:name.startsWith('ingredient')?'resolved':'unresolved',query:name,candidates:name.startsWith('ingredient')?[{id:`CHEMBL${name.endsWith('one')?1:2}`,name}]:[],evidence:[ref]};},
    targets:async id=>({status:'ok',evidence:[ref],integratedMechanisms:[],mechanisms:[{target:{id:`target:${id}`,name:'Synthetic target'},relationship:'direct',mechanism:'Synthetic',actionType:'AGONIST',references:[]}]})};
}
async function finish(service,input={}) {const id=service.start({disease:'cystic fibrosis',sources:['ctgov'],...input}).jobId;await service.running.get(id).promise;return service.get(id);}
function setup(t,records,cfReview,options) {
  const store=new Store(':memory:');const evidence=evidenceFor(store,options);const dir=mkdtempSync(join(tmpdir(),'cf-runtime-'));
  const service=new LandscapeService(store,{evidence,cfReview,exportRoot:dir,adapters:{ctgov:{collect:async()=>({records,upstreamTotal:records.length,truncated:false})}}});
  t.after(async()=>{await service.close();store.close();rmSync(dir,{recursive:true,force:true});});return {store,evidence,service};
}
test('CF scope excludes negated disease and retains qualified mixed cohorts and historical completed trials',()=>{
  assert.equal(Object.keys(CF_REVIEW.contexts.registrations).length,140);
  for (const item of CF_REVIEW.ledger.items) for (const ref of item.registrations) {
    const context=CF_REVIEW.contexts.registrations[ref.id];assert.equal(context.reviewedSourceVersion,ref.versionHash);assert.match(context.contextHash,/^[a-f0-9]{64}$/);
  }
  for(const text of ['Non-cystic fibrosis bronchiectasis','Bronchiectasis, non‑cystic fibrosis','bronchiectasis unrelated to cystic fibrosis','Non CF bronchiectasis']) {
    assert.equal(cfScope({source:'ctgov',sourceId:'NCT1',conditions:[text],title:text},CF_REVIEW,'ongoing').status,'excluded');
  }
  assert.equal(cfScope({source:'ctgov',sourceId:'NCT1',conditions:['Cystic Fibrosis','Non-cystic fibrosis bronchiectasis'],title:'Mixed cohort'},CF_REVIEW,'ongoing').reason,'mixed_cf_and_non_cf_scope');
  const id='isrctn:ISRCTN71164341';const trial={source:'isrctn',sourceId:'ISRCTN71164341',title:'CF gene therapy',conditions:['Cystic Fibrosis'],reviewContextHash:CF_REVIEW.contexts.registrations[id].contextHash};
  assert.equal(cfScope(trial,CF_REVIEW,'ongoing').reason,'reviewed_completed_trial');assert.equal(cfScope(trial,CF_REVIEW,'historical').status,'retained');
  trial.reviewContextHash='changed';assert.equal(cfScope(trial,CF_REVIEW,'ongoing').status,'review_required');
});
test('routine status updates retain mappings; changed protocols and unreviewed registrations cannot borrow them',async t=>{
  const reviewed=record();const bundle=bundleFor([reviewed]);
  reviewed.raw.protocolSection.statusModule.overallStatus='ACTIVE_NOT_RECRUITING';reviewed.trial=normalizeCtgov(reviewed.raw);
  const other=record('NCT00000002');const {service}=setup(t,[reviewed,other],bundle);
  const job=await finish(service);assert.equal(job.status,'complete');assert.equal(job.total,1);
  assert.equal(job.items[0].mechanismCategory,'gene_delivery');assert.equal(job.items[0].highestSupportedPhaseInDisease,null);
  assert.deepEqual(job.items[0].supportingRegistrations.map(s=>s.registration),['ctgov:NCT05248230']);assert.equal(service.get(job.jobId,{section:'unresolved'}).total,1);
  reviewed.raw.protocolSection.descriptionModule.briefSummary='Changed protocol';reviewed.raw.protocolSection.armsInterventionsModule.interventions[0].otherNames=['ingredient-one'];reviewed.trial=normalizeCtgov(reviewed.raw);
  const changed=await finish(service);assert.equal(changed.total,0);assert.equal(service.get(changed.jobId,{section:'reviewApplications'}).items[0].status,'review_required');
});
test('multi-component mappings preserve all ingredients, partial failures and pinned review on resume',async t=>{
  const rec=record('NCT02690064','Acute antioxidant');const bundle=bundleFor([rec],['acute antioxidant'],['ingredient-one','ingredient-two']);
  const {service,store}=setup(t,[rec],bundle,{fail:true});
  const failed=await finish(service);assert.equal(failed.status,'partial_failure');assert.equal(failed.summary.mechanismFailures,1);
  const pinned=failed.cfReview.hash;service.evidence=evidenceFor(store);service.cfReview={ledger:{version:'future'},contexts:{}};
  service.resume(failed.jobId);await service.running.get(failed.jobId).promise;const result=service.get(failed.jobId);
  assert.equal(result.status,'complete');assert.equal(result.total,2);assert.equal(result.cfReview.hash,pinned);assert.equal(result.items[0].highestSupportedPhaseInDisease,null);
  assert.ok(service.compare(failed.snapshotId,result.snapshotId).added.length === 2);
});
test('unknown targets, non-drug decisions and non-CF source exclusions remain inspectable through MCP and exports',async t=>{
  const rec=record('NCT07437105','VX-272');const excluded=record('NCT00000002');excluded.raw.protocolSection.conditionsModule.conditions=['Non-cystic fibrosis bronchiectasis'];excluded.trial=normalizeCtgov(excluded.raw);
  const bundle=bundleFor([rec],['vx-272'],['vx-272']);bundle.ledger.items[0].decision='identified_target_unknown';const {service,store,evidence}=setup(t,[rec,excluded],bundle);
  const server=createMcpServer(store,{evidence,landscapes:service});const [a,b]=InMemoryTransport.createLinkedPair();const client=new Client({name:'cf-runtime',version:'1'});
  await server.connect(b);await client.connect(a);t.after(async()=>{await client.close();await server.close();});
  const start=await client.callTool({name:'get_clinical_target_landscape',arguments:{disease:'cystic fibrosis',sources:['ctgov']}});const id=start.structuredContent.jobId;await service.running.get(id).promise;
  const review=await client.callTool({name:'get_landscape_job',arguments:{jobId:id,section:'reviewApplications'}});assert.equal(review.structuredContent.items[0].decision,'identified_target_unknown');
  const excludedPage=await client.callTool({name:'get_landscape_job',arguments:{jobId:id,section:'excludedRegistrations'}});assert.equal(excludedPage.structuredContent.items[0].reason,'explicit_non_cf_scope');
  const job=service.get(id);assert.equal(job.items[0].target,null);assert.equal(service.get(id,{section:'unresolved'}).items[0].reason,'identified_drug_target_unknown');assert.equal(job.coverage.statusSelectedRegistrations,2);assert.equal(job.coverage.selectedRegistrations,1);
  const files=service.export(job.snapshotId);const snapshot=JSON.parse(readFileSync(files.json));assert.ok(snapshot.rawEnrichmentEvidence.some(e=>e.source==='cf_review' && e.raw.ledger.version===bundle.ledger.version));assert.ok(readFileSync(files.csv,'utf8').includes('reviewPolicy'));
  const contentHash=snapshot.contentHash;service.cfReview={ledger:{version:'future'},contexts:{}};assert.equal(JSON.parse(readFileSync(service.export(job.snapshotId).json)).contentHash,contentHash);
});
test('review policy is CF-only and no legacy snapshots are retroactively changed',async t=>{
  const rec=record();const {service,store}=setup(t,[rec],bundleFor([rec]),{diseaseId:'OTHER'});const job=await finish(service);assert.equal(job.cfReview,undefined);assert.equal(job.total,0);
  const legacy=store.loadLandscape(job.jobId);delete legacy.processingVersion;delete legacy.snapshotId;legacy.status='interrupted';legacy.disease={...legacy.disease,id:'MONDO_0009061'};store.saveLandscape(legacy);service.evidence=evidenceFor(store);service.resume(legacy.id);await service.running.get(legacy.id).promise;assert.equal(service.get(legacy.id).cfReview,undefined);
});

test('reviewed non-drug entries skip drug lookup and policy revisions cannot be compared as like-for-like',async t=>{
  const rec=record('NCT06120465','Yoga');const bundle=bundleFor([rec],['yoga'],[]);bundle.ledger.items[0].decision='non_drug';
  const {service,evidence}=setup(t,[rec],bundle);const first=await finish(service);assert.equal(first.total,0);assert.equal(evidence.attempts,0);
  const excluded=service.get(first.jobId,{section:'excluded'});assert.equal(excluded.items[0].review.decision,'non_drug');
  const changed=structuredClone(bundle);changed.ledger.version='future';changed.contexts.ledgerVersion='future';service.cfReview=changed;
  const second=await finish(service);assert.notEqual(first.cfReview.hash,second.cfReview.hash);assert.throws(()=>service.compare(first.snapshotId,second.snapshotId),/same disease and collection parameters/);
});

test('VX-581 review update supports CFTR correction without direct binding or CF efficacy claims',async t=>{
  const rec=record('NCT07813039','VX-581');const bundle=bundleFor([rec],['vx-581'],['vx-581']);
  const {service}=setup(t,[rec],bundle);const job=await finish(service);
  assert.equal(job.items[0].target.id,'CHEMBL4051');assert.equal(job.items[0].relationship,'corrector');
  assert.notEqual(job.items[0].mechanismCategory,'direct_molecular_target');assert.equal(job.items[0].highestSupportedPhaseInDisease,null);
  assert.equal(job.items[0].supportingRegistrations[0].clinicalDevelopmentEvidence,false);
  assert.equal(job.items[0].supportingRegistrations[0].review.evidenceBasis,'sponsor_reported_mechanism');
  assert.equal(CF_REVIEW.ledger.items.find(i=>i.namePreview==='vx-581').reviewedAt,'2026-10-28');
  assert.equal(CF_REVIEW.ledger.items.find(i=>i.namePreview==='vx-272').reviewedAt,undefined);
  assert.equal(CF_REVIEW.ledger.products['vx-272'].target,null);
});

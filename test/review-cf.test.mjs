import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {reviewSnapshot,nameHash,csvCell} from '../scripts/review-cf-landscape.mjs';
function fixture() {
  const registrations=['ctgov:NCT00000001','ctgov:NCT00000002'].map((id,i)=>({source:'ctgov',sourceId:id.split(':')[1],versionHash:`version${i}`,sourceUrl:`https://clinicaltrials.gov/study/${id.split(':')[1]}`,phases:['PHASE2'],recruitmentStatus:'recruiting',conditions:[i?'Non-Cystic Fibrosis Bronchiectasis':'Cystic Fibrosis']}));
  const snapshot={snapshotId:'fixture',contentHash:'hash',disease:{id:'CF'},coverage:{ctgovComplete:true},resolutions:{'mixture':{resolution:{status:'ambiguous'}}},registrations,unresolved:registrations.map(t=>({registration:`ctgov:${t.sourceId}`,name:'mixture',intervention:{name:'mixture',role:'unknown',roleBasis:'fixture'}})),rows:[]};
  const review={inputSnapshotId:'fixture',inputContentHash:'hash',diseaseId:'CF',version:'test',reviewedAt:'2026-10-27',products:{gene:{name:'Gene therapy',mechanism:'Gene delivery',relationship:'gene_delivery',target:{id:'HGNC:1884',name:'CFTR',type:'GENE'},references:['https://example.org/synthetic']},osmotic:{name:'Saline',mechanism:'Osmotic',relationship:'osmotic',target:null,references:[]}},excludedRegistrations:[{registration:'ctgov:NCT00000002',versionHash:'version1'}],items:[{nameHash:nameHash('mixture'),previousOutcome:'ambiguous',decision:'identified',note:'Two ingredients',registrations:registrations.map(t=>({id:`ctgov:${t.sourceId}`,versionHash:t.versionHash,url:t.sourceUrl})),products:['gene','osmotic'],references:[]}]};
  return {snapshot,review};
}
test('review preserves separate components and relationship types, excludes non-CF supports, and does not mutate input',async()=>{
  const {snapshot,review}=fixture();const before=JSON.stringify(snapshot);
  const result=await reviewSnapshot(snapshot,review,{});
  assert.equal(result.rows.length,2);assert.equal(result.summary.namedTargetLinks,1);assert.equal(result.summary.retainedOngoingRegistrations,1);
  assert.equal(result.rows[0].relationship,'gene_delivery');assert.equal(result.rows[1].target,null);
  assert.ok(result.rows.every(r=>r.supportingRegistrations.every(s=>s.registration==='ctgov:NCT00000001' && s.clinicalDevelopmentEvidence===false)));
  assert.equal(JSON.stringify(snapshot),before);
});
test('review rejects stale snapshots, changed registration versions and missing decisions',async()=>{
  for(const mutate of [x=>x.review.inputContentHash='other',x=>x.review.items[0].registrations[0].versionHash='stale',x=>x.review.items=[]]) {
    const x=fixture();mutate(x);await assert.rejects(reviewSnapshot(x.snapshot,x.review,{}));
  }
});
test('review fails visibly on incomplete external evidence and CSV cells escape formula prefixes',async()=>{
  const {snapshot,review}=fixture();review.items[0].products=['canonical'];
  await assert.rejects(reviewSnapshot(snapshot,review,{resolve:async()=>({status:'resolved',candidates:[{id:'CHEMBL1'}],evidence:[]}),targets:async()=>({status:'partial_failure'})}),/Incomplete target/);
  assert.equal(csvCell('=1+1'),'"\'=1+1"');assert.equal(csvCell('a"b'),'"a""b"');
});
test('review dataset distinguishes deuterated drugs, gene restoration, multi-ingredient alternatives and unknown targets',()=>{
  const review=JSON.parse(readFileSync(new URL('../data/cf-intervention-review.json',import.meta.url),'utf8'));
  assert.equal(review.products.deutivacaftor.drugId,'CHEMBL4297603');
  assert.equal(review.products['4d-710'].relationship,'gene_delivery');
  assert.equal(review.products.nesolicaftor.relationship,'indirect_expression');
  assert.equal(review.items.find(i=>i.nameHash===nameHash('acute antioxidant')).products.length,5);
  assert.equal(review.items.find(i=>i.nameHash===nameHash('vx-581')).decision,'identified_target_unknown');
  assert.equal(review.items.length,165);assert.equal(review.excludedRegistrations.length,26);
});
test('review removes ivacaftor evidence mistakenly attached to a deutivacaftor-only intervention',async()=>{
  const {snapshot,review}=fixture();
  const trial=snapshot.registrations[0];
  trial.interventionDetails=[{name:'deutivacaftor',role:'unknown'}];snapshot.registrations[1].interventionDetails=[];
  snapshot.resolutions.deutivacaftor={resolution:{status:'resolved'},targets:{mechanisms:[{}]}};
  snapshot.rows=[{key:'old',drug:{id:'CHEMBL2010601'},supportingRegistrations:[{registration:'ctgov:NCT00000001',intervention:'deutivacaftor'}]}];
  review.products.deuti={name:'Deutivacaftor',drugId:'CHEMBL4297603',target:{id:'CHEMBL4051'},mechanism:'CFTR potentiation',relationship:'direct',references:[]};
  review.items.push({nameHash:nameHash('deutivacaftor'),decision:'identity_corrected',previousOutcome:'resolved_wrong_parent_identity',registrations:[{id:'ctgov:NCT00000001',versionHash:'version0',url:trial.sourceUrl}],products:['deuti'],references:[]});
  const result=await reviewSnapshot(snapshot,review,{});
  assert.equal(result.rows.some(r=>r.drug.id==='CHEMBL2010601'),false);
  assert.equal(result.rows.find(r=>r.drug.id==='CHEMBL4297603').supportingRegistrations[0].intervention,'deutivacaftor');
});

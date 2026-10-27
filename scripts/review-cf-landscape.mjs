import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { EvidenceService } from '../src/evidence.mjs';
import { splitIntervention } from '../src/landscape.mjs';

export const nameHash = name => createHash('sha256').update(name).digest('hex');
const keyOf = trial => `${trial.source}:${trial.sourceId}`;
const ongoing = new Set(['recruiting','active_not_recruiting','not_yet_recruiting','by_invitation']);
const needed = value => ['unresolved','ambiguous'].includes(value.resolution?.status) || (value.resolution?.status === 'resolved' && !value.targets?.mechanisms.length);
const urls = values => [...new Set(values.filter(Boolean))];
export function csvCell(value) {
  let text = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (/^(?:\s*[=+\-@]|[\t\r])/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"','""')}"`;
}

// This review is pinned to an immutable snapshot. It cannot silently become a global alias rule.
export async function reviewSnapshot(snapshot, review, evidence, onProgress = () => {}) {
  assert.equal(snapshot.snapshotId, review.inputSnapshotId, 'Review belongs to a different snapshot');
  assert.equal(snapshot.contentHash, review.inputContentHash, 'Input content hash changed');
  assert.equal(snapshot.disease.id, review.diseaseId, 'Disease scope changed');
  const trials = new Map(snapshot.registrations.map(t => [keyOf(t), t]));
  const names = new Map(Object.keys(snapshot.resolutions).map(n => [nameHash(n), n]));
  const decisions = new Map(review.items.map(i => [i.nameHash, i]));
  assert.equal(decisions.size, review.items.length, 'Duplicate review decisions');
  for (const [name,value] of Object.entries(snapshot.resolutions)) if (needed(value)) assert.ok(decisions.has(nameHash(name)), `Missing review: ${name}`);
  const excluded = new Set(review.excludedRegistrations.map(e => {
    assert.equal(trials.get(e.registration)?.versionHash, e.versionHash, 'Disease exclusion source changed');
    return e.registration;
  }));
  const occurrencesOf = name => snapshot.registrations.filter(t => ongoing.has(t.recruitmentStatus)).flatMap(t => t.interventionDetails.flatMap(intervention => {
    const parts = intervention.ingredients?.length ? intervention.ingredients.flatMap(splitIntervention) : splitIntervention(intervention.name);
    return parts.filter(n => n.trim().toLowerCase() === name).map(n => ({registration:keyOf(t),intervention,name:n}));
  }));
  const corrected = review.items.filter(i => i.decision === 'identity_corrected').flatMap(i => occurrencesOf(names.get(i.nameHash)));
  const rows = structuredClone(snapshot.rows).flatMap(row => {
    row.supportingRegistrations = row.supportingRegistrations.filter(s => !excluded.has(s.registration) && !(row.drug.id === 'CHEMBL2010601' && corrected.some(e => e.registration === s.registration && e.intervention.name === s.intervention))); 
    for (const support of row.supportingRegistrations) support.sourceConditions = trials.get(support.registration)?.conditions;
    // Aggregate phase claims must be recalculated after changing scope; export registration phases instead.
    delete row.highestSupportedPhaseInDisease; delete row.highestPhaseObservedInDiseaseTrials;
    return row.supportingRegistrations.length ? [row] : [];
  });
  const outcome = []; const cache = new Map();
  async function lookup(name) {
    if (!cache.has(name)) {
      const r = await evidence.resolve(name);
      const t = r.status === 'resolved' ? await evidence.targets(r.candidates[0].id) : null;
      if (t?.status === 'partial_failure') throw new Error(`Incomplete target evidence for ${name}`);
      cache.set(name, { resolution:r, targets:t });
    }
    return cache.get(name);
  }
  for (const item of review.items) {
    const name = names.get(item.nameHash); assert.ok(name, 'Review name not present in snapshot');
    const occurrences = item.decision === 'identity_corrected' ? occurrencesOf(name) : snapshot.unresolved.filter(e => e.name.trim().toLowerCase() === name);
    assert.ok(occurrences.length, `No unresolved occurrences for ${name}`);
    assert.deepEqual([...new Set(occurrences.map(e => e.registration))].sort(), item.registrations.map(r => r.id).sort(), 'Review registration scope mismatch');
    for (const source of item.registrations) assert.equal(trials.get(source.id)?.versionHash, source.versionHash, `Source version changed: ${source.id}`);
    const result = { ...item, name, components:[] };
    for (const productName of item.products) {
      const curated = review.products[productName];
      let drug, mechanisms, provenance = [];
      if (curated) {
        drug = { id:curated.drugId ?? `reviewed:${productName}`, name:curated.name };
        mechanisms = [{ target:curated.target, mechanism:curated.mechanism, relationship:curated.relationship, actionType:curated.relationship, references:[] }];
      } else {
        const found = await lookup(productName); provenance = [...found.resolution.evidence, ...(found.targets?.evidence ?? [])];
        drug = found.resolution.status === 'resolved' ? found.resolution.candidates[0] : { id:null, name:productName };
        mechanisms = found.targets?.mechanisms ?? [];
        if (!mechanisms.length) mechanisms = [{ target:null, mechanism:'No curated molecular mechanism established in this review', relationship:'not_established', actionType:null, references:[] }];
      }
      result.components.push({ name:productName, drug, namedTargets:mechanisms.filter(m => m.target).map(m => m.target), mechanismStatus:mechanisms.every(m => m.relationship === 'not_established') ? 'not_established' : 'supported' });
      for (const mechanism of mechanisms) {
        const references = urls([...item.references, ...(curated?.references ?? []), ...item.registrations.map(r => r.url), ...mechanism.references.map(r => r.ref_url)]);
        const rowKey = `${drug.id ?? drug.name}:${mechanism.target?.id ?? 'no_molecular_target'}:${mechanism.actionType}:${mechanism.relationship}`;
        let row = rows.find(r => r.key === rowKey);
        if (!row) { row = { key:rowKey, drug, target:mechanism.target, mechanism:mechanism.mechanism, actionType:mechanism.actionType, relationship:mechanism.relationship,
          diseaseRelevance:curated?.diseaseRelevance ?? 'unreviewed_disease_context', mechanismInThisDisease:'AI-assisted review; clinical interpretation required',
          references:references.map(ref_url => ({ref_url})), evidence:provenance, supportingRegistrations:[], reviewVersion:review.version }; rows.push(row); }
        row.references = [...new Map([...row.references,...references.map(ref_url => ({ref_url}))].map(r => [r.ref_url,r])).values()];
        for (const occurrence of occurrences.filter(e => !excluded.has(e.registration))) {
          const trial = trials.get(occurrence.registration);
          const support = { registration:occurrence.registration, sourceUrl:trial.sourceUrl, versionHash:trial.versionHash, sourceUpdatedAt:trial.sourceUpdatedAt, retrievedAt:trial.retrievedAt,
            phases:trial.phases, recruitmentStatus:trial.recruitmentStatus, intervention:occurrence.intervention.name, role:occurrence.intervention.role,
            roleEvidence:occurrence.intervention.roleBasis, clinicalDevelopmentEvidence:false, reviewRequired:true,
            reviewedComponent:productName, reviewNote:item.note, reviewReferences:references, programStatus:curated?.programStatus, evidenceBasis:curated ? 'reviewed_primary_source_or_sponsor_mechanism' : 'reviewed_identity_plus_ChEMBL_mechanism',
            sourceConditions:trial.conditions, cohortCaveat:'Registration phase may include healthy volunteers or background drugs; does not establish drug-specific phase in CF patients' };
          if (!row.supportingRegistrations.some(s => s.registration === support.registration && s.intervention === support.intervention && s.reviewedComponent === productName)) row.supportingRegistrations.push(support);
        }
      }
    }
    result.retainedRegistrations = item.registrations.filter(r => !excluded.has(r.id)).map(r => r.id);
    outcome.push(result); onProgress({completed:outcome.length,total:review.items.length,name:name.slice(0,80)});
  }
  const retainedRows = rows.filter(r => r.supportingRegistrations.length);
  return { reviewId:`${snapshot.snapshotId}-review-${review.version}`, parentSnapshotId:snapshot.snapshotId, parentContentHash:snapshot.contentHash,
    generatedAt:new Date().toISOString(), reviewContentHash:nameHash(JSON.stringify(review)), review, coverage:snapshot.coverage, rows:retainedRows, interventionReview:outcome,
    summary:{ reviewedNames:outcome.length, originallyUnresolvedOrAmbiguousNames:outcome.filter(i => ['unresolved','ambiguous'].includes(i.previousOutcome)).length,
      excludedRegistrations:excluded.size, excludedNonCfRegistrations:review.excludedRegistrations.filter(e => e.reason === 'non_cf').length, retainedOngoingRegistrations:snapshot.registrations.filter(t => ongoing.has(t.recruitmentStatus) && !excluded.has(keyOf(t))).length,
      drugMechanismRows:retainedRows.length, namedTargetLinks:retainedRows.filter(r => r.target).length,
      trialEvidenceRows:retainedRows.reduce((n,r) => n+r.supportingRegistrations.length,0),
      reviewDecisions:Object.fromEntries([...new Set(outcome.map(i => i.decision))].map(d => [d,outcome.filter(i => i.decision === d).length])) },
    notice:'Reviewed overlay, not a new registry refresh. Source coverage remains the original query coverage. Registry ongoing status is not independent confirmation of current development. Target identity, substrate, organism and indirect gene restoration are separate relationships. Review is not expert clinical validation.' };
}

export function exportReview(result, directory) {
  mkdirSync(directory,{recursive:true});
  const prefix = join(directory,`cystic-fibrosis-reviewed-${result.review.version}`);
  const fields = ['target_id','target','target_type','species','drug_id','drug','interaction_relationship','mechanism','disease_relevance','registration','registry_url','trial_phases','recruitment_status','intervention','intervention_role','role_evidence','clinical_development_evidence','review_required','reviewed_component','review_note','evidence_basis','mechanism_references','source_evidence_urls','source_conditions','source_version_hash','source_updated_at','retrieved_at','reviewed_at','cohort_caveat','program_status_caveat'];
  const lines = [fields.map(csvCell).join(',')];
  for (const row of result.rows) for (const support of row.supportingRegistrations) {
    const t = row.target ?? {};
    const values = [t.id,t.name,t.type,t.organism,row.drug.id,row.drug.name,row.relationship,row.mechanism,row.diseaseRelevance,support.registration,support.sourceUrl,support.phases.join('; '),support.recruitmentStatus,support.intervention,support.role,support.roleEvidence,support.clinicalDevelopmentEvidence,support.reviewRequired,support.reviewedComponent,support.reviewNote,support.evidenceBasis ?? 'original_ChEMBL_mechanism',urls(row.references.map(r => r.ref_url)).join('; '),urls(row.evidence.map(e => e.url)).join('; '),support.sourceConditions,support.versionHash,support.sourceUpdatedAt,support.retrievedAt,result.review.reviewedAt,support.cohortCaveat ?? 'Registration phase and role need drug-specific clinical review',support.programStatus];
    lines.push(values.map(csvCell).join(','));
  }
  const auditFields = ['intervention','previous_outcome','review_decision','review_note','identified_components','component_results','retained_registrations','source_versions','references','reviewed_at'];
  const audit = [auditFields.map(csvCell).join(','),...result.interventionReview.map(i => [i.name,i.previousOutcome,i.decision,i.note,i.products,i.components,i.retainedRegistrations,i.registrations,urls([...i.references,...i.registrations.map(r => r.url),...i.products.flatMap(p => result.review.products[p]?.references ?? [])]),result.review.reviewedAt].map(csvCell).join(','))];
  writeFileSync(`${prefix}.json`,JSON.stringify(result,null,2)+'\n');
  writeFileSync(`${prefix}.csv`,lines.join('\n')+'\n');
  writeFileSync(`${prefix}-intervention-review.csv`,audit.join('\n')+'\n');
  writeFileSync(`${prefix}-excluded-registrations.csv`,['registration,source_version_hash,registry_url,reason,additional_references',...result.review.excludedRegistrations.map(r => [r.registration,r.versionHash,r.url,r.note,r.references].map(csvCell).join(','))].join('\n')+'\n');
  return {json:`${prefix}.json`,csv:`${prefix}.csv`,audit:`${prefix}-intervention-review.csv`,exclusions:`${prefix}-excluded-registrations.csv`};
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let store;
  try {
    const {values,positionals} = parseArgs({allowPositionals:true,options:{db:{type:'string'},out:{type:'string'},review:{type:'string'}}});
    assert.ok(positionals[0], 'Usage: node scripts/review-cf-landscape.mjs SNAPSHOT.json --db PATH --out DIRECTORY');
    const snapshot = JSON.parse(readFileSync(positionals[0],'utf8'));
    const review = JSON.parse(readFileSync(values.review ?? new URL('../data/cf-intervention-review.json',import.meta.url),'utf8'));
    store = new Store(values.db);
    const result = await reviewSnapshot(snapshot,review,new EvidenceService(store),p => process.stderr.write(JSON.stringify(p)+'\n'));
    const files = exportReview(result,resolve(values.out ?? '.data/exports'));
    process.stdout.write(JSON.stringify({summary:result.summary,files},null,2)+'\n');
  } catch (error) { process.stderr.write(error.stack+'\n'); process.exitCode=1; }
  finally { store?.close(); }
}

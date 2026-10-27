import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { canonical } from './store.mjs';

export const hashReview = value => createHash('sha256').update(canonical(value)).digest('hex');
const nameHash = name => createHash('sha256').update(name.trim().toLowerCase()).digest('hex');
const keyOf = trial => `${trial.source}:${trial.sourceId}`;
export const CF_REVIEW = {
  ledger: JSON.parse(readFileSync(new URL('../data/cf-intervention-review.json', import.meta.url), 'utf8')),
  contexts: JSON.parse(readFileSync(new URL('../data/cf-review-contexts.json', import.meta.url), 'utf8')),
};

// Status/contact timestamps are not protocol evidence; changed protocols must be reviewed again.
export function reviewContext(trial, raw) {
  let protocol;
  if (trial.source === 'ctgov') {
    const p = raw.protocolSection ?? {};
    protocol = { description:p.descriptionModule ?? null, interventions:p.armsInterventionsModule ?? null, design:p.designModule ?? null };
  } else if (trial.source === 'ctis') protocol = raw.detail?.authorizedApplication?.authorizedPartI ?? null;
  else protocol = { description:raw.trial?.trialDescription ?? null, interventions:raw.trial?.interventions ?? null };
  return hashReview({ title:trial.title, conditions:trial.conditions, phases:trial.phases, primaryPurpose:trial.primaryPurpose ?? null, protocol });
}
export function cfScope(trial, bundle, view) {
  const text = `${trial.conditions.join(' ')} ${trial.title}`.toLowerCase().replace(/[‐‑‒–—−]/g,'-');
  const stripped = text.replace(/\bnon[\s-]*(?:cystic[\s-]*fibrosis|cf)\b/g,'').replace(/\b(?:unrelated to|without|not related to)\s+cystic[\s-]*fibrosis\b/g,'');
  const negative = stripped !== text;
  const positive = /\bcystic[\s-]*fibrosis\b|\bcf\b/.test(stripped);
  if (negative && !positive) return { status:'excluded', reason:'explicit_non_cf_scope', evidence:{conditions:trial.conditions,title:trial.title}, references:[trial.sourceUrl] };
  const completed = bundle.ledger.excludedRegistrations.find(e => e.registration === keyOf(trial) && e.reason === 'completed_trial');
  if (completed && view !== 'historical') {
    if (bundle.contexts.registrations[keyOf(trial)]?.contextHash === trial.reviewContextHash) return {status:'excluded',reason:'reviewed_completed_trial',note:completed.note,references:completed.references,reviewedAt:bundle.ledger.reviewedAt};
    return {status:'review_required',reason:'completed_trial_context_changed',references:completed.references};
  }
  return {status:negative ? 'review_required' : 'retained',reason:negative ? 'mixed_cf_and_non_cf_scope' : 'registry_disease_context_not_independently_validated'};
}
export function reviewedEntry(entry, trial, bundle) {
  const item = bundle.ledger.items.find(i => i.nameHash === nameHash(entry.name) && i.registrations.some(r => r.id === keyOf(trial)));
  if (!item) {
    const context = bundle.contexts.registrations[keyOf(trial)];
    return context && context.contextHash !== trial.reviewContextHash ? {status:'review_required',reason:'known_registration_protocol_changed',registration:keyOf(trial),name:entry.name,version:bundle.ledger.version,reviewedAt:bundle.ledger.reviewedAt,currentSourceVersion:trial.versionHash,references:[trial.sourceUrl]} : null;
  }
  const context = bundle.contexts.registrations[keyOf(trial)];
  const source = item.registrations.find(r => r.id === keyOf(trial));
  const matches = context?.reviewedSourceVersion === source.versionHash && context?.contextHash && context.contextHash === trial.reviewContextHash;
  return {status:matches ? 'applied' : 'review_required',reason:matches ? 'reviewed_protocol_context_matches' : 'reviewed_protocol_context_changed_or_missing',
    version:bundle.ledger.version,reviewedAt:bundle.ledger.reviewedAt,registration:keyOf(trial),name:entry.name,decision:item.decision,note:item.note,
    reviewedSourceVersion:source.versionHash,currentSourceVersion:trial.versionHash,contextHash:trial.reviewContextHash,
    references:[...new Set([...item.references,source.url])],item};
}
export async function resolveReviewed(review, bundle, evidence, options, reviewEvidence) {
  const components = [];
  if (!review.item.products.length) return { status:'ok',review,components:[],resolution:{status:['non_drug','diagnostic','placebo'].includes(review.decision) ? 'not_a_drug' : 'unresolved',reason:review.note,candidates:[],evidence:[reviewEvidence]} };
  for (const name of review.item.products) {
    try {
      const product = bundle.ledger.products[name];
      if (product) {
        const resolution = {status:'resolved',method:'registration-scoped reviewed identity',query:name,candidates:[{id:product.drugId ?? `reviewed:${name}`,name:product.name}],evidence:[reviewEvidence]};
        const references = [...new Set([...review.references,...product.references])].map(ref_url => ({ref_url}));
        const targets = {status:'ok',evidence:[reviewEvidence],integratedMechanisms:[],mechanisms:[{target:product.target,mechanism:product.mechanism,relationship:product.relationship,actionType:product.relationship,references}]};
        components.push({status:'ok',resolution,targets,review:{...review,component:name,programStatus:product.programStatus,diseaseRelevance:product.diseaseRelevance}});
      } else {
        const resolution = await evidence.resolve(name,options);
        const targets = resolution.status === 'resolved' ? await evidence.targets(resolution.candidates[0].id,options) : null;
        components.push({status:'ok',resolution,targets,review:{...review,component:name}});
      }
    } catch (error) { options.signal?.throwIfAborted(); components.push({status:'failed',error:error.message,review:{...review,component:name}}); }
  }
  return {status:components.some(c => c.status === 'failed') ? 'failed' : 'ok',review,components};
}
export function publicReview(review) {
  if (!review) return undefined;
  const {item,...publicFields} = review; return publicFields;
}

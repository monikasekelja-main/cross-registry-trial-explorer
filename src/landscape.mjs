import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { SOURCES, createAdapters, validateId } from './adapters.mjs';
import { EvidenceService, validateName, CF_REFERENCE } from './evidence.mjs';
import { CF_REVIEW, hashReview, reviewContext, cfScope, reviewedEntry, resolveReviewed, publicReview } from './cf-review.mjs';

const ongoing = new Set(['recruiting', 'not_yet_recruiting', 'active_not_recruiting', 'by_invitation']);
const list = value => value == null || value === '' ? [] : Array.isArray(value) ? value : [value];
const txt = value => typeof value === 'string' ? value : value?.['#text'] ?? '';
const keyOf = trial => `${trial.source}:${trial.sourceId}`;
function exists(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
function phase(trial) {
  const values = { I: 1, II: 2, III: 3, IV: 4, '1': 1, '2': 2, '3': 3, '4': 4 };
  const found = trial.phases.flatMap(p => [...p.toUpperCase().matchAll(/(?:PHASE\s*|\/)(III|IV|II|I|[1-4])\b/g)].map(m => values[m[1]]));
  return found.length ? Math.max(...found) : null;
}
export function splitIntervention(name) {
  if (/^n\s*\/\s*a$/i.test(name.trim())) return [name];
  // Only explicit ingredient separators, never inferred brand compositions or narrative text.
  const parts = name.split(/\s*[+/,;]\s*/);
  return parts.length > 1 && parts.every(x => /^[A-Za-z][A-Za-z0-9-]*(?: [A-Za-z]+)?$/.test(x)) ? parts : [name];
}
export function extractInterventions(trial, raw) {
  if (trial.source === 'ctgov') {
    const p = raw.protocolSection;
    return (p?.armsInterventionsModule?.interventions ?? []).map(x => {
      const arms = (x.armGroupLabels ?? []).map(label => (p.armsInterventionsModule.armGroups ?? []).find(a => a.label === label)?.type);
      const role = arms.length && arms.every(a => a === 'EXPERIMENTAL') ? 'experimental_arm' : arms.length && arms.every(a => ['ACTIVE_COMPARATOR','PLACEBO_COMPARATOR','SHAM_COMPARATOR'].includes(a)) ? 'comparator' : 'unknown';
      return { name: x.name, aliases: x.otherNames ?? [], modality: x.type ?? 'unknown', interventionCategory: x.type === 'GENETIC' ? 'gene_or_rna_therapy' : 'source_declared_intervention', role,
        roleBasis: { armGroupLabels: x.armGroupLabels ?? [], armTypes: arms }, roleCaveat: 'Experimental-arm membership alone does not distinguish background therapy' };
    }).filter(x => typeof x.name === 'string');
  }
  if (trial.source === 'ctis') {
    return (raw.detail?.authorizedApplication?.authorizedPartI?.products ?? []).map(x => {
      const substances = x.productDictionaryInfo?.productSubstances?.map(s => s.actSubstName).filter(Boolean) ?? [];
      return { name: x.productName ?? x.productDictionaryInfo?.prodName ?? '', aliases: [],
        ingredients: substances.length ? substances : [x.jsonActiveSubstanceNames ?? x.productDictionaryInfo?.activeSubstanceName].filter(Boolean),
        modality: 'medicinal_product', role: ({ '1': 'investigational', '2': 'comparator', '3': 'placebo', '4': 'auxiliary' })[x.mpRoleInTrial] ?? 'unknown', roleBasis: { mpRoleInTrial: x.mpRoleInTrial ?? null } };
    }).filter(x => x.name);
  }
  return list(raw.trial?.interventions?.intervention).map(x => ({ name: txt(x.drugNames) || txt(x.description), aliases: [], modality: txt(x.interventionType) || 'unknown', role: 'unknown', roleBasis: 'ISRCTN export does not establish an investigational/comparator role' })).filter(x => x.name);
}
export function groupRegistrations(trials) {
  const parent = trials.map((_,i) => i);
  const root = i => parent[i] === i ? i : (parent[i] = root(parent[i]));
  const seen = new Map();
  trials.forEach((trial, i) => {
    for (const entry of [{ registry: trial.source, value: trial.sourceId }, ...trial.identifiers]) {
      try { validateId(entry.registry, entry.value); } catch { continue; }
      const key = `${entry.registry}:${entry.value}`;
      if (seen.has(key)) parent[root(i)] = root(seen.get(key)); else seen.set(key, i);
    }
  });
  const groups = new Map();
  trials.forEach((trial, i) => { const r = root(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(keyOf(trial)); });
  return [...groups.values()].map(registrations => ({ id: registrations.slice().sort().join('|'), registrations, basis: 'Explicit registry identifiers only; unlinked registrations may still duplicate trials' }));
}
function digest(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function csvCell(value) {
  let text = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (/^(?:\s*[=+\-@]|[\t\r])/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export class LandscapeService {
  constructor(store, { evidence = new EvidenceService(store), adapters = createAdapters(), exportRoot, cfReview = CF_REVIEW } = {}) {
    Object.assign(this, { store, evidence, adapters, cfReview });
    this.exportRoot = exportRoot ?? resolve(store.path === ':memory:' ? '.data' : dirname(store.path), 'exports');
    this.running = new Map(); this.closed = false;
  }
  start({ disease, view = 'ongoing', sources = SOURCES, limitPerSource = 100, maxInterventions = 100, collectAllCtgov = false, enrichAllInterventions = false, refreshEvidence = false } = {}) {
    if (this.running.size || this.closed) throw new Error('A landscape job is running or the service is closing');
    disease = validateName(disease);
    if (!['ongoing','recruiting','historical'].includes(view)) throw new Error('view must be ongoing, recruiting or historical');
    if (!Array.isArray(sources) || !sources.length || sources.some(s => !SOURCES.includes(s))) throw new Error('Invalid sources');
    if (!Number.isInteger(limitPerSource) || limitPerSource < 1 || limitPerSource > 500) throw new Error('limitPerSource must be 1–500');
    if (!Number.isInteger(maxInterventions) || maxInterventions < 1 || maxInterventions > 200) throw new Error('maxInterventions must be 1–200');
    if (typeof collectAllCtgov !== 'boolean' || typeof enrichAllInterventions !== 'boolean') throw new Error('Full-collection flags must be booleans');
    if (collectAllCtgov && !sources.includes('ctgov')) throw new Error('collectAllCtgov requires the ctgov source');
    const job = { id: randomUUID(), processingVersion: 'cf-review-v1', status: 'queued', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      parameters: { disease, view, sources: [...new Set(sources)], limitPerSource, maxInterventions, collectAllCtgov, enrichAllInterventions, refreshEvidence },
      progress: { stage: 'queued', sourcesCompleted: 0, interventionsCompleted: 0 }, sources: [], registrations: [], resolutions: {}, errors: [] };
    this.save(job); this.launch(job); return this.get(job.id);
  }
  save(job) { job.updatedAt = new Date().toISOString(); this.store.saveLandscape(job); }
  load(id) {
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid job ID');
    const job = this.store.loadLandscape(id) ?? this.store.loadLandscapeSnapshot(id); if (!job) throw new Error('Landscape job not found'); return job;
  }
  launch(job, expected = JSON.stringify(this.load(job.id))) {
    if (this.closed) throw new Error('Landscape service is closing');
    if (this.running.size >= 1) throw new Error('A landscape job is already running; poll it before starting another');
    job.status = 'running'; job.ownerPid = process.pid; job.updatedAt = new Date().toISOString();
    if (!this.store.claimLandscape(job, expected)) throw new Error('Job changed concurrently; reload its status');
    const controller = new AbortController();
    const promise = new Promise(resolve => setImmediate(resolve)).then(() => this.run(job, AbortSignal.any([controller.signal, AbortSignal.timeout((job.parameters.collectAllCtgov || job.parameters.enrichAllInterventions ? 360 : 15) * 60000)])))
      .catch(error => { job.status = controller.signal.aborted ? 'interrupted' : 'failed'; job.errors.push({ stage: job.progress.stage, error: error.message }); this.save(job); })
      .finally(() => this.running.delete(job.id));
    this.running.set(job.id, { controller, promise });
  }
  resume(id) {
    const job = this.load(id);
    if (id !== job.id) throw new Error('Snapshot is immutable; resume using the job ID');
    if (job.status === 'complete') throw new Error('Job is complete; start a new job to refresh it');
    if (this.running.has(id) || (job.status === 'running' && exists(job.ownerPid))) throw new Error('Job is already running');
    const expected = JSON.stringify(job);
    if (job.snapshotId) job.previousSnapshotId = job.snapshotId;
    delete job.snapshotId; delete job.rows; delete job.summary; delete job.unresolved; delete job.excluded;
    // Successful checkpoints are reused; only failed source/enrichment steps are retried.
    job.sources = job.sources.filter(s => s.status === 'ok');
    job.resolutions = Object.fromEntries(Object.entries(job.resolutions).filter(([,r]) => r.status !== 'failed' && r.targets?.status !== 'partial_failure' && !r.components?.some(c => c.status === 'failed' || c.targets?.status === 'partial_failure')));
    this.launch(job, expected); return this.get(id);
  }
  cancel(id) {
    const job = this.load(id);
    if (id !== job.id) throw new Error('Snapshot is immutable; cancel using the job ID');
    const active = this.running.get(id);
    if (job.status === 'complete') throw new Error('Job is already complete');
    if (!active && job.status === 'running' && exists(job.ownerPid)) throw new Error('Job belongs to another live server process');
    if (active) active.controller.abort(new Error('Landscape cancelled; checkpoints retained for resume'));
    else { job.status = 'interrupted'; this.save(job); }
    return { jobId: id, status: active ? 'cancelling' : 'interrupted' };
  }
  async close() {
    this.closed = true;
    for (const { controller } of this.running.values()) controller.abort(new Error('Server shutdown; resume job after reconnect'));
    await Promise.allSettled([...this.running.values()].map(x => x.promise));
  }
  async run(job, signal) {
    const options = { signal, refresh: job.parameters.refreshEvidence };
    job.progress.stage = 'resolving_disease'; this.save(job);
    job.disease ??= await this.evidence.disease(job.parameters.disease, options);
    job.versions ??= await this.evidence.versions(options);
    let bundle;
    if (job.processingVersion === 'cf-review-v1' && job.disease.id === CF_REFERENCE.diseaseId) {
      if (!job.cfReview) {
        if (![1,2].includes(this.cfReview.contexts.contextSchema) || this.cfReview.contexts.ledgerVersion !== this.cfReview.ledger.version) throw new Error('CF review/context versions do not match');
        const hash = hashReview(this.cfReview);
        const {raw,...evidence} = this.store.evidencePut(hash, {source:'cf_review',url:`local:cf-review/${hash}`,raw:this.cfReview,retrievedAt:new Date().toISOString(),lineage:'AI-assisted registration-scoped review; references are not independent clinical validation'});
        job.cfReview = {version:this.cfReview.ledger.version,reviewedAt:this.cfReview.ledger.reviewedAt,updatedAt:this.cfReview.ledger.updatedAt ?? this.cfReview.ledger.reviewedAt,reviewStatus:this.cfReview.ledger.reviewStatus,contextSchema:this.cfReview.contexts.contextSchema,hash,evidence}; this.save(job);
      }
      const e = job.cfReview.evidence;
      bundle = this.store.evidenceVersion(e.key,e.hash,e.retrievedAt)?.raw;
      if (!bundle) throw new Error('Pinned CF review evidence is missing');
    }
    for (const source of job.parameters.sources) {
      signal.throwIfAborted(); if (job.sources.some(s => s.source === source)) continue;
      job.progress.stage = `collecting_${source}`; this.save(job);
      const started = new Date().toISOString();
      try {
        const collection = await this.adapters[source].collect({ query: job.disease.name, studyType: 'interventional', limit: job.parameters.limitPerSource, includeRecruitment: true, ...(source === 'ctgov' ? { allRecords: job.parameters.collectAllCtgov ?? false } : {}), signal });
        signal.throwIfAborted();
        this.store.commitSource(source, collection, { query: job.disease.name, landscapeJobId: job.id, limit: job.parameters.limitPerSource }, started);
        for (const { trial, raw } of collection.records) {
          const saved = this.store.get(source, trial.sourceId);
          job.registrations.push({ ...trial, versionHash: saved.versionHash, interventionDetails: extractInterventions(trial, raw), ...(bundle ? {reviewContextHash:reviewContext(trial,raw,bundle.contexts.contextSchema)} : {}) });
        }
        job.sources.push({ source, status: 'ok', imported: collection.records.length, upstreamTotal: collection.upstreamTotal, truncated: collection.truncated,
          scanned: collection.scanned, reconciled: collection.reconciled, reportedTotals: collection.reportedTotals, upstreamTotalScope: collection.upstreamTotalScope, completedAt: new Date().toISOString() });
      } catch (error) {
        signal.throwIfAborted();
        this.store.failSource(source, { landscapeJobId: job.id }, started, error);
        job.sources.push({ source, status: 'failed', error: error.message });
      }
      job.progress.sourcesCompleted = job.sources.length; this.save(job);
    }
    const statusSelected = job.registrations.filter(t => job.parameters.view === 'historical' || (job.parameters.view === 'recruiting' ? t.recruitmentStatus === 'recruiting' : ongoing.has(t.recruitmentStatus)));
    if (bundle) for (const trial of job.registrations) trial.cfScope = cfScope(trial,bundle,job.parameters.view);
    const selected = statusSelected.filter(t => t.cfScope?.status !== 'excluded');
    job.excludedRegistrations = job.registrations.filter(t => !selected.includes(t)).map(t => ({ registration:keyOf(t),status:t.recruitmentStatus,statusRaw:t.statusRaw,activityStatusBasis:t.activityStatusBasis,reportedCompletionDate:t.reportedCompletionDate,sourceUrl:t.sourceUrl,versionHash:t.versionHash,
      reason:t.cfScope?.status === 'excluded' ? t.cfScope.reason : 'Status does not establish membership in requested view; unknown excluded',scopeReview:t.cfScope }));
    job.groups = groupRegistrations(selected);
    const entries = selected.flatMap(t => t.interventionDetails.flatMap(intervention => {
      const names = intervention.ingredients?.length ? intervention.ingredients.flatMap(splitIntervention) : splitIntervention(intervention.name);
      return names.map(name => ({ registration: keyOf(t), intervention, name }));
    }));
    const priority = { investigational: 0, experimental_arm: 1, unknown: 2, comparator: 3, auxiliary: 4, placebo: 5 };
    entries.sort((a,b) => (priority[a.intervention.role] ?? 2) - (priority[b.intervention.role] ?? 2));
    const nameKey = name => name.trim().toLowerCase();
    const names = [...new Set(entries.map(e => nameKey(e.name)))];
    for (const entry of entries) entry.enrichmentKey = bundle ? digest({registration:entry.registration,name:entry.name,intervention:entry.intervention}) : nameKey(entry.name);
    const work = [...new Map(entries.map(e => [e.enrichmentKey,e])).values()];
    const workByName = new Map(names.map(name => [name,work.filter(e => nameKey(e.name) === name)]));
    const completedNames = () => [...workByName.values()].filter(units => units.every(e => job.resolutions[e.enrichmentKey])).length;
    const interventionLimit = job.parameters.enrichAllInterventions ? names.length : job.parameters.maxInterventions;
    job.progress.interventionsTotal = Math.min(names.length, interventionLimit);
    const selectedNames = new Set(names.slice(0,interventionLimit));
    const selectedWork = work.filter(e => selectedNames.has(nameKey(e.name)));
    const ctgov = job.sources.find(s => s.source === 'ctgov');
    job.coverage = { bounded: true, complete: false, ctgovComplete: Boolean(job.parameters.collectAllCtgov && ctgov?.status === 'ok' && ctgov.reconciled && !ctgov.truncated),
      reason: 'See per-source exhaustion/reconciliation and enrichment coverage; this is not a complete global clinical pipeline',
      registrations: job.registrations.length, selectedRegistrations: selected.length, explicitIdentifierGroups: job.groups.length,
      distinctInterventionNames: names.length, enrichmentLimit: job.parameters.enrichAllInterventions ? null : job.parameters.maxInterventions, allInterventionsRequested: job.parameters.enrichAllInterventions ?? false, omittedInterventionNames: names.slice(interventionLimit),
      failures: job.sources.filter(s => s.status === 'failed'), sourceCoverage: job.sources,
      reviewPolicy:job.cfReview ? {version:job.cfReview.version,hash:job.cfReview.hash} : null,
      statusSelectedRegistrations:statusSelected.length, scopeExcludedRegistrations:statusSelected.length-selected.length,
      diseaseScope: 'Disease-context trials; underlying disease versus complications requires evidence review', statusView: job.parameters.view };
    for (const entry of selectedWork) {
      const name = nameKey(entry.name); const checkpoint = entry.enrichmentKey;
      signal.throwIfAborted(); if (job.resolutions[checkpoint]) continue;
      job.progress.stage = 'enriching_interventions'; job.progress.currentIntervention = name; this.save(job);
      try {
        const review = bundle ? reviewedEntry(entry,selected.find(t => keyOf(t) === entry.registration),bundle) : null;
        if (review?.status === 'applied') {
          const value = await resolveReviewed(review,bundle,this.evidence,options,job.cfReview.evidence);
          value.review = publicReview(value.review);
          for (const component of value.components ?? []) component.review = publicReview(component.review);
          job.resolutions[checkpoint] = value;
          job.progress.interventionsCompleted = completedNames();
          this.save(job); continue;
        }
        const parens = /^([A-Za-z0-9 -]+)\s*\(([A-Za-z0-9 -]+)\)$/.exec(name);
        // Changed reviewed context cannot reuse ingredient-like aliases to collapse a regimen.
        const aliases = review?.status === 'review_required' ? [name] : [...new Set([name, ...(parens ? [parens[1].trim(), parens[2].trim()] : []), ...entry.intervention.aliases].filter(x => x && x.length <= 200))];
        let resolution;
        if (['placebo','auxiliary'].includes(entry.intervention.role) || /^(DEVICE|PROCEDURE|BEHAVIORAL|DIAGNOSTIC_TEST)$/i.test(entry.intervention.modality)) {
          resolution = { query: name, status: 'not_a_drug', candidates: [], evidence: [], reason: 'Explicit non-drug or placebo/auxiliary role; no target inferred' };
        } else if (name.length > 200) {
          resolution = { query: name.slice(0,200), status: 'unresolved', candidates: [], evidence: [], reason: 'Narrative intervention description exceeds identity-search limit' };
        } else {
          const results = [];
          for (const alias of aliases) results.push(await this.evidence.resolve(alias, options));
          const resolved = results.filter(r => r.status === 'resolved');
          const ids = new Set(resolved.map(r => r.candidates[0].id));
          resolution = ids.size === 1 ? { ...resolved[0], query: name, matchedAlias: resolved[0].query, attemptedNames: aliases }
            : ids.size > 1 ? { query: name, status: 'ambiguous', candidates: resolved.flatMap(r => r.candidates), evidence: results.flatMap(r => r.evidence), reason: 'Source aliases resolve to different drugs' }
            : results[0];
        }
        const targets = resolution.status === 'resolved' ? await this.evidence.targets(resolution.candidates[0].id, options) : null;
        job.resolutions[checkpoint] = { status: 'ok', resolution, targets, review:publicReview(review) };
      } catch (error) { signal.throwIfAborted(); job.resolutions[checkpoint] = { status: 'failed', error: error.message }; }
      job.progress.interventionsCompleted = completedNames(); this.save(job);
    }
    const rows = new Map(); job.unresolved = []; job.excluded = [];
    job.reviewApplications = work.flatMap(e => job.resolutions[e.enrichmentKey]?.review ? [{...job.resolutions[e.enrichmentKey].review,enrichmentKey:e.enrichmentKey,enrichmentStatus:job.resolutions[e.enrichmentKey].status,components:(job.resolutions[e.enrichmentKey].components ?? []).map(c => ({component:c.review?.component,status:c.status,error:c.error,identityStatus:c.resolution?.status,drug:c.resolution?.candidates?.[0],targetStatus:c.targets?.status}))}] : []);
    for (const entry of entries) {
      const value = job.resolutions[entry.enrichmentKey]; const trial = selected.find(t => keyOf(t) === entry.registration);
      for (const component of value?.components?.length ? value.components : [value]) {
        const resolution = component?.resolution;
        if (resolution?.status === 'not_a_drug') { job.excluded.push({ ...entry, review:component?.review ?? value?.review, reason: resolution.reason ?? 'Placebo or non-drug intervention' }); continue; }
        if (!resolution || resolution.status !== 'resolved' || !component.targets?.mechanisms.length) {
          job.unresolved.push({ ...entry, reason: component?.error ?? resolution?.reason ?? resolution?.status ?? 'enrichment_budget_or_checkpoint', candidates: resolution?.candidates ?? [], review:component?.review ?? value?.review, mechanismStatus: component?.targets ? 'no_curated_mechanism_found' : null }); continue;
        }
        for (const mechanism of component.targets.mechanisms) {
          const drug = resolution.candidates[0]; const target = mechanism.target;
          const key = `${drug.id}:${target?.id ?? 'no_molecular_target'}:${mechanism.actionType}:${mechanism.relationship}`;
          if (!rows.has(key)) rows.set(key, { key, drug, target, mechanism: mechanism.mechanism, actionType: mechanism.actionType, relationship: mechanism.relationship,
            mechanismCategory: ['gene_delivery','mrna_replacement','splice_correction','indirect_expression','substrate_hydrolysis','organism_directed','vaccine_antigen'].includes(mechanism.relationship) ? mechanism.relationship : target ? (mechanism.relationship === 'direct' ? 'direct_molecular_target' : 'indirect_or_unspecified_target') : mechanism.relationship === 'not_established' ? 'mechanism_unknown' : 'mechanism_without_molecular_target',
            diseaseRelevance:component.review?.diseaseRelevance ?? 'unreviewed_disease_context; do not infer disease modification', mechanismInThisDisease:component.review?.status === 'applied' ? 'AI-assisted source review; clinical interpretation required' : 'unreviewed', references: mechanism.references,
            evidence: [...resolution.evidence, ...component.targets.evidence], integratedAnnotations: component.targets.integratedMechanisms,
            lineage:component.review?.status === 'applied' ? 'Registration-scoped review plus linked source evidence; not independent clinical validation' : 'ChEMBL mechanism evidence; Open Targets may reuse it', supportingRegistrations: [], highestSupportedPhaseInDisease: null, highestPhaseObservedInDiseaseTrials: null });
          const row = rows.get(key);
          row.evidence = [...new Map([...row.evidence,...resolution.evidence,...component.targets.evidence,...(component.review ? [job.cfReview.evidence] : [])].map(e => [`${e.key}:${e.hash}:${e.retrievedAt}`,e])).values()];
          row.references = [...new Map([...row.references, ...(mechanism.references ?? []), ...((component.review?.references ?? []).map(ref_url => ({ref_url})))].map(reference => [JSON.stringify(reference), reference])).values()];
          const anchor = job.disease.id === CF_REFERENCE.diseaseId ? CF_REFERENCE.mechanismAnchors.find(a => a.drugId === drug.id && a.targetId === target?.id && a.relationship === mechanism.relationship) : null;
          if (anchor) { row.diseaseRelevance = anchor.diseaseRelevance; row.mechanismInThisDisease = 'pilot_reference_anchor'; row.diseaseMechanismReference = anchor.reference; }
          const roleEstablished = entry.intervention.role === 'investigational';
          const candidate = roleEstablished && trial.primaryPurpose === 'treatment' && !component.review && trial.cfScope?.status !== 'review_required';
          const support = { registration: entry.registration, groupId: job.groups.find(g => g.registrations.includes(entry.registration))?.id,
            sourceUrl: trial.sourceUrl, retrievedAt: trial.retrievedAt, sourceUpdatedAt: trial.sourceUpdatedAt, versionHash: trial.versionHash,
            phases: trial.phases, recruitmentStatus: trial.recruitmentStatus, primaryPurpose: trial.primaryPurpose,
            intervention: entry.intervention.name, role: entry.intervention.role, roleEvidence: entry.intervention.roleBasis,
            clinicalDevelopmentEvidence: candidate, reviewRequired: !candidate || !anchor || mechanism.relationship !== 'direct',
            review:component.review ?? value?.review, scopeReview:trial.cfScope, reviewedComponent:component.review?.component,
            caveat: entry.intervention.roleCaveat ?? null };
          if (!row.supportingRegistrations.some(s => s.registration === support.registration && s.intervention === support.intervention && s.reviewedComponent === support.reviewedComponent)) row.supportingRegistrations.push(support);
          const observed = phase(trial);
          if (observed !== null) row.highestPhaseObservedInDiseaseTrials = Math.max(row.highestPhaseObservedInDiseaseTrials ?? 0, observed);
          const p = candidate ? observed : null;
          if (p !== null) row.highestSupportedPhaseInDisease = Math.max(row.highestSupportedPhaseInDisease ?? 0, p);
        }
        if (component?.targets?.mechanisms.some(m => m.relationship === 'not_established')) job.unresolved.push({...entry,reason:'identified_drug_target_unknown',review:component.review});
      }
    }
    job.rows = [...rows.values()];
    job.summary = { mappedDrugTargetRows: job.rows.length, rowsWithEstablishedInvestigationalRole: job.rows.filter(r => r.supportingRegistrations.some(s => s.clinicalDevelopmentEvidence)).length,
      unresolvedInterventionOccurrences: job.unresolved.length, excludedNonDrugOccurrences: job.excluded.length, mechanismFailures: Object.values(job.resolutions).filter(r => r.status === 'failed' || r.targets?.status === 'partial_failure' || r.components?.some(c => c.status === 'failed' || c.targets?.status === 'partial_failure')).length,
      interpretation: 'Rows are candidate drug–mechanism links in disease-context trials. Comparator, background and unknown-role evidence must not be reported as active target programs. Highest phase uses only explicit investigational treatment evidence; null means not established.' };
    job.coverage.reviewApplications = job.reviewApplications.filter(r => r.status === 'applied').length;
    job.coverage.reviewContextsRequiringReview = job.reviewApplications.filter(r => r.status === 'review_required').length;
    job.coverage.enrichmentAttemptsComplete = selectedWork.every(e => job.resolutions[e.enrichmentKey]);
    job.coverage.allInterventionNamesAttempted = work.every(e => job.resolutions[e.enrichmentKey]);
    job.contentHash = digest({ parameters: job.parameters, disease: job.disease, versions: job.versions, rows: job.rows, coverage: job.coverage, unresolved: job.unresolved, excluded: job.excluded, registrations: job.registrations, cfReview:job.cfReview, reviewApplications:job.reviewApplications, excludedRegistrations:job.excludedRegistrations });
    job.status = job.sources.some(s => s.status === 'failed') || job.summary.mechanismFailures || (job.parameters.collectAllCtgov && !job.coverage.ctgovComplete) ? 'partial_failure' : 'complete';
    job.progress.stage = 'finished'; job.snapshotId = randomUUID(); this.save(job); this.store.saveLandscapeSnapshot(job);
  }
  get(id, { offset = 0, limit = 20, section = 'rows' } = {}) {
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 50 || !['rows','unresolved','registrations','excluded','reviewApplications','excludedRegistrations'].includes(section)) throw new Error('Invalid landscape page');
    const j = this.load(id); const items = j[section] ?? [];
    return { jobId: j.id, snapshotId: j.snapshotId, previousSnapshotId: j.previousSnapshotId, status: j.status === 'running' && !this.running.has(j.id) && !exists(j.ownerPid) ? 'interrupted' : j.status, createdAt: j.createdAt, updatedAt: j.updatedAt, parameters: j.parameters, disease: j.disease,
      cfReview:j.cfReview, processingVersion:j.processingVersion, progress: j.progress, versions: j.versions, summary: j.summary, coverage: j.coverage, sources: j.sources, errors: j.errors,
      section, total: items.length, offset, nextOffset: offset + limit < items.length ? offset + limit : null, items: items.slice(offset, offset + limit),
      notice: 'Poll while running. Resume interrupted/failed work. Inspect unresolved and registrations sections; all results are bounded and evidence-qualified.' };
  }
  export(id) {
    const j = this.load(id);
    if (!['complete','partial_failure'].includes(j.status)) throw new Error('Wait for the job to finish before exporting');
    mkdirSync(this.exportRoot, { recursive: true });
    const json = resolve(this.exportRoot, `${j.snapshotId ?? j.id}.json`); const csv = resolve(this.exportRoot, `${j.snapshotId ?? j.id}.csv`);
    const references = [j.disease.evidence, j.versions.evidence, ...(j.cfReview ? [j.cfReview.evidence] : []), ...Object.values(j.resolutions).flatMap(r => [r,...(r.components ?? [])]).flatMap(r => [...(r.resolution?.evidence ?? []), ...(r.targets?.evidence ?? [])])];
    const rawEnrichmentEvidence = [...new Map(references.map(e => [`${e.key}:${e.hash}:${e.retrievedAt}`, e])).values()].map(e => {
      const version = this.store.evidenceVersion(e.key, e.hash, e.retrievedAt);
      if (!version) throw new Error('Snapshot evidence version is missing; refusing to substitute current data');
      return version;
    });
    const rawRegistrations = j.registrations.map(t => {
      const version = this.store.registrationVersion(t.source, t.sourceId, t.versionHash);
      if (!version) throw new Error('Snapshot registry version is missing'); return version;
    });
    writeFileSync(json, JSON.stringify({ ...j, rawRegistrations, rawEnrichmentEvidence }, null, 2) + '\n');
    const columns = ['drugId','drugName','targetId','targetName','organism','mechanism','relationship','highestSupportedPhaseInDisease','supportingRegistrations','references','mechanismCategory','diseaseRelevance','reviewPolicy'];
    const data = j.rows.map(r => [r.drug.id,r.drug.name,r.target?.id,r.target?.name,r.target?.organism,r.mechanism,r.relationship,r.highestSupportedPhaseInDisease,r.supportingRegistrations,r.references,r.mechanismCategory,r.diseaseRelevance,j.cfReview ? {version:j.cfReview.version,hash:j.cfReview.hash} : null]);
    writeFileSync(csv, [columns, ...data].map(row => row.map(csvCell).join(',')).join('\n') + '\n');
    return { jobId: j.id, snapshotId: j.snapshotId, json, csv, contentHash: j.contentHash, notice: 'JSON contains unresolved interventions, coverage, checkpoints and evidence references. CSV rows require the role and uncertainty qualifications in supportingRegistrations.' };
  }
  compare(firstId, secondId) {
    const a = this.load(firstId); const b = this.load(secondId);
    if (![a,b].every(j => ['complete','partial_failure'].includes(j.status))) throw new Error('Compare finished snapshots only');
    const scope = j => ({ processingVersion:j.processingVersion ?? 'legacy',cfReviewHash:j.cfReview?.hash ?? null,disease: j.disease.id, view: j.parameters.view, sources: j.parameters.sources.slice().sort(), limitPerSource: j.parameters.limitPerSource, maxInterventions: j.parameters.maxInterventions, collectAllCtgov: j.parameters.collectAllCtgov ?? false, enrichAllInterventions: j.parameters.enrichAllInterventions ?? false });
    const comparableRow = row => ({ ...row, evidence: row.evidence.map(({retrievedAt, ...e}) => e), supportingRegistrations: row.supportingRegistrations.map(({retrievedAt, ...s}) => s) });
    if (a.disease.id !== b.disease.id || digest(scope(a)) !== digest(scope(b))) throw new Error('Snapshots need the same disease and collection parameters, processing version and review policy');
    const left = new Map(a.rows.map(r => [r.key, r])); const right = new Map(b.rows.map(r => [r.key, r]));
    return { firstId, secondId, coverageBefore: a.coverage, coverageAfter: b.coverage, added: [...right.keys()].filter(k => !left.has(k)), absentFromSecondSample: [...left.keys()].filter(k => !right.has(k)),
      changed: [...right.keys()].filter(k => left.has(k) && digest(comparableRow(left.get(k))) !== digest(comparableRow(right.get(k)))), notice: 'Differences are between bounded samples and evidence snapshots. Absence does not establish program discontinuation.' };
  }
}

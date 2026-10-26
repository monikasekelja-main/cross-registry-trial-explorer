import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { JsonClient, SourceError } from './http-client.mjs';

const CHEMBL = 'https://www.ebi.ac.uk/chembl/api/data/';
export const CF_REFERENCE = JSON.parse(readFileSync(new URL('../data/cf-reference.json', import.meta.url), 'utf8'));
const OT = 'https://api.platform.opentargets.org/api/v4/graphql';
const normalized = value => value.trim().toLowerCase().replace(/\s+/g, ' ');
function list(value, label) { if (!Array.isArray(value)) throw new SourceError(`Missing ${label}`); return value; }
function chemblId(id) { if (!/^CHEMBL\d+$/.test(id)) throw new Error('Expected a ChEMBL identifier'); return id; }
export function validateName(name) {
  if (typeof name !== 'string' || !name.trim() || name.length > 200) throw new Error('Name must contain 1–200 characters');
  return name.trim();
}

// Exact names/aliases only: search ranking is never evidence of drug identity.
export class EvidenceService {
  constructor(store, { chembl = new JsonClient(), openTargets = new JsonClient(), ttlMs = 7 * 86400000 } = {}) {
    Object.assign(this, { store, chembl, openTargets, ttlMs });
  }
  async request(source, url, body, { signal, refresh = false } = {}) {
    const key = createHash('sha256').update(JSON.stringify({ source, url: String(url), body })).digest('hex');
    const previous = this.store.evidenceGet(key);
    if (!refresh && previous && Date.now() - Date.parse(previous.retrievedAt) < this.ttlMs) return previous;
    const client = source === 'chembl' ? this.chembl : this.openTargets;
    const raw = await client.json(url, { signal, ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    if (source === 'opentargets' && (raw.errors?.length || !raw.data)) throw new SourceError('Open Targets returned GraphQL errors or missing data');
    return this.store.evidencePut(key, { source, url: String(url), request: body ?? null, raw, retrievedAt: new Date().toISOString(), lineage: 'ChEMBL mechanism annotations; Open Targets is not independent confirmation' });
  }
  async graphql(query, variables, options) { return this.request('opentargets', OT, { query, variables }, options); }
  async chemblPage(resource, parameters, options) {
    const url = new URL(resource, CHEMBL);
    for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, String(value));
    return this.request('chembl', url, undefined, options);
  }
  provenance(evidence) { const { raw, request, ...meta } = evidence; return meta; }
  async disease(name, options) {
    name = validateName(name);
    // CF's abbreviation is intentionally not accepted: it is ambiguous outside this disease context.
    const input = name === CF_REFERENCE.diseaseId || CF_REFERENCE.reviewedSynonyms.includes(normalized(name)) ? CF_REFERENCE.canonicalName : name;
    const evidence = await this.graphql('query($q:String!){search(queryString:$q,entityNames:["disease"],page:{index:0,size:10}){hits{id name entity}}}', { q: input }, options);
    const candidates = list(evidence.raw.data.search?.hits, 'Open Targets disease hits');
    const exact = candidates.filter(x => normalized(x.name) === normalized(input));
    if (exact.length !== 1) throw new Error(`Disease name is unresolved or ambiguous; use a canonical name. Candidates: ${candidates.map(x => `${x.name} (${x.id})`).join('; ')}`);
    return { id: exact[0].id, name: exact[0].name, searchedNames: [exact[0].name], reviewedSynonyms: exact[0].id === CF_REFERENCE.diseaseId ? CF_REFERENCE.reviewedSynonyms : [], profileVersion: exact[0].id === CF_REFERENCE.diseaseId ? CF_REFERENCE.version : null, synonymPolicy: 'Canonical name and explicitly reviewed aliases only; no automatic descendant or complication expansion', evidence: this.provenance(evidence) };
  }
  async resolve(name, options) {
    name = validateName(name);
    if (/^(placebo(?:\b.*)?|saline|usual care|standard of care|no intervention|n\/a)$/i.test(name)) return { query: name, status: 'not_a_drug', candidates: [], evidence: [] };
    const evidence = [];
    let molecules;
    if (/^CHEMBL\d+$/.test(name)) {
      const e = await this.chemblPage(`molecule/${name}.json`, {}, options); evidence.push(this.provenance(e));
      if (e.raw.molecule_chembl_id !== name) throw new SourceError('ChEMBL molecule ID mismatch');
      molecules = [e.raw];
    } else {
      molecules = [];
      for (const field of ['pref_name__iexact', 'molecule_synonyms__molecule_synonym__iexact']) {
        const e = await this.chemblPage('molecule.json', { [field]: name, limit: 20 }, options);
        evidence.push(this.provenance(e));
        const rows = list(e.raw.molecules, 'ChEMBL molecules');
        if (e.raw.page_meta?.next) return { query: name, status: 'ambiguous', candidates: [], evidence, reason: 'Exact-match candidate set exceeds limit; use an explicit ChEMBL ID' };
        molecules.push(...rows.filter(m => normalized(m.pref_name ?? '') === normalized(name) ||
          (m.molecule_synonyms ?? []).some(s => normalized(s.molecule_synonym ?? s.synonyms ?? '') === normalized(name))));
      }
    }
    const candidates = [...new Map(molecules.map(m => {
      const id = chemblId(m.molecule_hierarchy?.parent_chembl_id ?? m.molecule_chembl_id);
      return [id, { id, name: m.pref_name ?? name, matchedFormId: m.molecule_chembl_id, moleculeType: m.molecule_type ?? null, structureType: m.structure_type ?? null, sourceUrl: `https://www.ebi.ac.uk/chembl/explore/compound/${id}` }];
    })).values()];
    return { query: name, status: candidates.length === 1 && candidates[0].structureType !== 'MIX' ? 'resolved' : candidates.length ? 'ambiguous' : 'unresolved', candidates, evidence, method: 'exact preferred name or exact source synonym; salt forms grouped by parent ID' };
  }
  async targets(id, options) {
    chemblId(id);
    const evidence = []; const mechanisms = []; const errors = [];
    let offset = 0; let truncated = false;
    do {
      const e = await this.chemblPage('mechanism.json', { molecule_chembl_id: id, limit: 100, offset }, options);
      evidence.push(this.provenance(e)); mechanisms.push(...list(e.raw.mechanisms, 'ChEMBL mechanisms'));
      truncated = Boolean(e.raw.page_meta?.next); offset += 100;
    } while (truncated && offset < 1000);
    const rows = [];
    for (const m of mechanisms) {
      let target = null;
      if (m.target_chembl_id) {
        const e = await this.chemblPage(`target/${chemblId(m.target_chembl_id)}.json`, {}, options); evidence.push(this.provenance(e));
        const t = e.raw;
        if (t.target_chembl_id !== m.target_chembl_id) throw new SourceError('ChEMBL target ID mismatch');
        target = { id: t.target_chembl_id, name: t.pref_name, type: t.target_type, organism: t.organism,
          components: list(t.target_components, 'target components').map(c => ({ accession: c.accession, name: c.component_description,
            geneSymbols: (c.target_component_synonyms ?? []).filter(x => x.syn_type === 'GENE_SYMBOL').map(x => x.component_synonym) })) };
      }
      rows.push({ target, mechanism: m.mechanism_of_action, actionType: m.action_type,
        relationship: m.direct_interaction === 1 ? 'direct' : 'indirect_or_unspecified',
        diseaseEfficacy: m.disease_efficacy === 1, references: m.mechanism_refs ?? [], lineage: 'ChEMBL', mechanismId: m.mec_id });
    }
    let integrated = [];
    try {
      const e = await this.graphql('query($id:String!){drug(chemblId:$id){id name mechanismsOfAction{rows{mechanismOfAction actionType targets{id approvedSymbol} references{source ids urls}}}}}', { id }, options);
      evidence.push(this.provenance(e));
      if (e.raw.data.drug && e.raw.data.drug.id !== id) throw new SourceError('Open Targets drug ID mismatch');
      integrated = list(e.raw.data.drug?.mechanismsOfAction?.rows ?? [], 'Open Targets mechanisms');
    } catch (error) { options?.signal?.throwIfAborted(); errors.push({ source: 'opentargets', error: error.message }); }
    return { drugId: id, status: errors.length ? 'partial_failure' : 'ok', mechanisms: rows, integratedMechanisms: integrated,
      evidence, errors, truncated, notice: 'Mechanism annotations describe the drug, not proof of target engagement in a particular trial. Open Targets reuses ChEMBL; assay hits are not promoted to therapeutic targets.' };
  }
  async versions(options) {
    const e = await this.chemblPage('status.json', {}, options);
    return { chembl: e.raw.chembl_db_version, chemblReleaseDate: e.raw.chembl_release_date, evidence: this.provenance(e), openTargets: 'API responses content-versioned; release version not asserted' };
  }
}

import * as z from 'zod/v4';
import { SOURCES } from './adapters.mjs';
import { EvidenceService } from './evidence.mjs';
import { LandscapeService } from './landscape.mjs';

export function registerLandscapeTools(server, store, result, { evidence = new EvidenceService(store), adapters, landscapes = new LandscapeService(store, { evidence, adapters }) } = {}) {
  const outputSchema = z.record(z.string(), z.unknown());
  const annotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
  const id = z.string().uuid();
  const register = (name, description, shape, action, local = false) => server.registerTool(name, {
    description, inputSchema: z.object(shape).strict(), outputSchema,
    annotations: local ? { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } : annotations,
  }, async (input, ctx) => {
    try { return result(await action(input, { signal: AbortSignal.any([ctx.mcpReq.signal, AbortSignal.timeout(120000)]) })); }
    catch (error) { return result({ reason: 'landscape_error', message: error.message }, true); }
  });
  register('resolve_intervention', 'Resolve an intervention by exact ChEMBL name or source synonym. Returns ambiguity rather than choosing a fuzzy hit. Does not infer brand-combination ingredients. Writes versioned evidence to the local cache.', {
    name: z.string().trim().min(1).max(200), refresh: z.boolean().default(false),
  }, ({ name, refresh }, options) => evidence.resolve(name, { ...options, refresh }));
  register('get_drug_targets', 'Retrieve curated ChEMBL drug mechanisms and target components plus Open Targets annotations. Preserves references, species, direct versus unspecified interaction and shared source lineage. No inference from assay hits; not a claim about a particular clinical trial.', {
    drugId: z.string().regex(/^CHEMBL\d+$/), refresh: z.boolean().default(false),
  }, ({ drugId, refresh }, options) => evidence.targets(drugId, { ...options, refresh }));
  register('get_clinical_target_landscape', 'Start a durable background disease-context target landscape. Returns a job ID immediately: poll get_landscape_job. Uses all three registries by default, bounded collection and intervention enrichment, explicit-ID registration grouping, versioned mechanism evidence and unresolved lists. CF jobs automatically apply registration-scoped reviewed mappings when the protocol context matches and exclude explicit non-CF scope. Changed review contexts, unknown targets, mixed cohorts and source evidence remain visible. Does not promise a complete pipeline. Unknown/comparator/background roles do not establish an investigational program. Ongoing includes recruiting, pending recruitment, active-not-recruiting and invitation-only trials. Historical includes ended trials. Jobs stop when this server exits; resume checkpoints after reconnect.', {
    disease: z.string().trim().min(1).max(200), view: z.enum(['ongoing','recruiting','historical']).default('ongoing'),
    sources: z.array(z.enum(SOURCES)).min(1).max(3).optional(), limitPerSource: z.number().int().min(1).max(500).default(100),
    collectAllCtgov: z.boolean().default(false).describe('Follow the ClinicalTrials.gov cursor to exhaustion and reconcile its total, overriding that source’s sample bound. Other registries retain their source bounds.'),
    enrichAllInterventions: z.boolean().default(false).describe('Attempt every distinct intervention name in the selected status view; overrides maxInterventions. Missing or ambiguous mechanisms remain explicit.'),
    maxInterventions: z.number().int().min(1).max(200).default(100), refreshEvidence: z.boolean().default(false),
  }, input => landscapes.start(input));
  register('get_landscape_job', 'Read durable job progress and paginated results. A completed response includes an immutable snapshotId, which can also be passed as jobId for historical reads. Poll while running; use unresolved, registrations, reviewApplications and excludedRegistrations sections to inspect gaps and evidence. Classifications and highest phase require role-qualified interpretation. Unknown roles are not active target programs.', {
    jobId: id, section: z.enum(['rows','unresolved','registrations','excluded','reviewApplications','excludedRegistrations']).default('rows'), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(50).default(20),
  }, ({ jobId, ...page }) => landscapes.get(jobId, page), true);
  register('resume_landscape_job', 'Resume an interrupted, failed or partial-failure landscape from successful source and enrichment checkpoints. Running jobs cannot be resumed concurrently. Successful source samples are preserved; start a new job for a fresh snapshot.', { jobId: id }, ({ jobId }) => landscapes.resume(jobId));
  register('cancel_landscape_job', 'Cancel this server’s landscape work, retaining checkpoints for resume. Does not delete trial records or evidence.', { jobId: id }, ({ jobId }) => landscapes.cancel(jobId));
  register('export_landscape', 'Export a finished snapshot to local JSON and CSV files. JSON includes coverage, unresolved entries and evidence. Returned absolute paths can be linked in chat. Does not publish data or send it to anyone.', { jobId: id }, ({ jobId }) => landscapes.export(jobId));
  register('compare_landscapes', 'Compare two finished snapshots with identical collection parameters and processing/review policy. Pass immutable snapshot IDs in firstId and secondId to preserve historical comparisons. Differences describe bounded samples and evidence, not proof of clinical program discontinuation.', { firstId: id, secondId: id }, ({ firstId, secondId }) => landscapes.compare(firstId, secondId), true);
  return landscapes;
}

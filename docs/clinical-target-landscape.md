# Clinical target landscapes

The same local MCP server can now collect disease-context trials, resolve interventions and retrieve curated mechanisms from ChEMBL and Open Targets. It produces an evidence-qualified landscape, not an automatically validated or complete clinical pipeline.

## Try it from chat

After updating, reconnect `clinical-trials` so the client discovers the new tools. Ask:

> Build an ongoing clinical target landscape for cystic fibrosis across all three registries. Collect up to 100 registrations per source and enrich up to 100 intervention names. Poll the job to completion, show the targets and mechanisms with their trial evidence and uncertainties, and export JSON and CSV.

The assistant starts `get_clinical_target_landscape`, receives a job ID, then calls `get_landscape_job`. Work continues in the local server between calls. It stops if the server closes; successful checkpoints survive and can be resumed after reconnecting.

Direct tool arguments:

```json
{
  "disease": "cystic fibrosis",
  "view": "ongoing",
  "sources": ["ctgov", "ctis", "isrctn"],
  "limitPerSource": 100,
  "maxInterventions": 100,
  "refreshEvidence": false
}
```

Use `get_landscape_job` with the returned `jobId`. Its `section` is `rows`, `unresolved`, `registrations` or `excluded`; pass `nextOffset` as the next `offset`. Pages default to 20 items, maximum 50. Poll at a reasonable interval, such as every 5–10 seconds, rather than repeatedly calling without a pause. A single very large row can exceed the MCP response bound; use the JSON export in that case.

### Views

| View | Included statuses |
|---|---|
| `ongoing` | Recruiting, not yet recruiting, active not recruiting, enrolling by invitation |
| `recruiting` | Recruiting only |
| `historical` | All fetched statuses, including ended and unknown |

These views describe trial registrations. They do not establish that a sponsor's entire drug program is active or discontinued. Unknown statuses are excluded from ongoing/recruiting and retained with exclusion reasons in the exported snapshot. Suspended work is not counted as ongoing by this policy.

## Tools

| Tool | Purpose |
|---|---|
| `resolve_intervention` | Exact preferred-name or source-synonym match to ChEMBL; ambiguity remains visible |
| `get_drug_targets` | Curated mechanisms, action types, species, target components, references and source lineage |
| `get_clinical_target_landscape` | Start one background collection/enrichment job per server process |
| `get_landscape_job` | Read progress or a page of results; accepts an immutable snapshot ID as `jobId` for historical reads |
| `resume_landscape_job` | Retry failed/interrupted work from successful source and intervention checkpoints |
| `cancel_landscape_job` | Stop local work and retain checkpoints |
| `export_landscape` | Write complete JSON evidence and a CSV summary locally |
| `compare_landscapes` | Compare immutable snapshot IDs for the same disease and collection scope |

The existing four trial-search tools remain available. Direct identity and target tools accept `refresh: true` to bypass their evidence cache.

## Interpret each result

The evidence chain is:

**Disease identity → registry record and version → intervention and role → exact drug identity → curated mechanism and target → original references.**

A result row contains a ChEMBL drug ID, target ID/type/species/components where available, action type, direct versus indirect/unspecified relationship, supporting registrations, role evidence, source timestamps, trial-specific phases and references. Open Targets gene IDs and symbols appear in its integrated annotations. Protein complexes and families remain targets in their own right; their components are not falsely reported as individually validated targets.

**A drug's known mechanism is not automatically its mechanism in a particular CF trial.** `mechanismInThisDisease` remains unreviewed unless it matches a specific reference anchor. Most disease relevance requires review before labelling it disease-modifying, anti-infective or supportive care. A CFTR–ivacaftor anchor is included as a developer-reviewed pilot case, with the [Kalydeco prescribing information](https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=0ab0c9f8-3eee-4e0f-9f3f-c1e16aaffe25). It is not an independent clinical audit and does not assert the role or efficacy of any trial.

### Roles and phases

- CTIS's explicit Test/Comparator/Placebo/Auxiliary roles are preserved. Only explicit investigational treatment evidence can contribute to `highestSupportedPhaseInDisease`.
- ClinicalTrials.gov experimental-arm membership is preserved, but it can include background therapies. It does not independently establish an investigational program.
- ISRCTN role remains unknown when the export does not distinguish investigational treatment from a comparator or background therapy.
- `highestPhaseObservedInDiseaseTrials` describes the fetched supporting registrations, including role-qualified candidates and comparators. It is not the highest phase of an established target program.
- Drug-wide ChEMBL maximum phase is never used as the phase for CF. A null supported phase means the required chain has not been established.
- Source scope/phase labels and raw record versions are retained. A terminated trial does not mark a target or whole program abandoned.

### Identity and unresolved interventions

Only exact preferred-name or exact source-synonym matches are accepted automatically. Salt forms are grouped by their source parent molecule ID. Ambiguous identities and mixtures remain unresolved. Explicit combination separators or CTIS active-substance lists are used to consider ingredients independently; brand compositions are not invented. Source aliases and simple parenthesized names/codes can help resolve a label, but conflicting resolved aliases remain ambiguous.

Placebo, auxiliary products and explicitly non-drug procedures/devices do not acquire invented targets. Genetic interventions retain a genetic-therapy category where the registry supplies one. Gene/RNA therapies, phages, cells, narrative descriptions and unrecognised sponsor codes can remain unresolved; a gene payload is never assumed to be a direct protein-binding target. Inspect the unresolved section and full JSON export, rather than reading a short target table as comprehensive.

## Disease scope

The initial reviewed disease profile is cystic fibrosis (`MONDO_0009061`) and its alias mucoviscidosis. The alias resolves to the canonical name for registry searches. `CF` alone is rejected as ambiguous. Other diseases require an exact canonical Open Targets search match. Automatic descendant expansion, all ontology synonyms and complication-specific searches are not enabled: even ontology exact-synonym lists can include manifestations that need review.

The profile and pilot mechanism anchor are in [data/cf-reference.json](../data/cf-reference.json). Generalisation to another disease must not silently inherit the CF anchor. Registrations with the disease in a multi-condition record are disease-context evidence; they do not prove that each intervention targets that disease.

## Coverage, reliability and refresh

- Collection defaults to 100 registrations per registry, maximum 500. Existing CT.gov cursor and CTIS page pagination operate inside that bound. ISRCTN uses a bounded XML export. Different source totals can overlap and are not added.
- All views collect an interventional sample first, then apply the requested status view. Therefore, a small sample can omit older recruiting records. Increase the collection bound if necessary; neither a short result nor zero rows proves no programs exist.
- Enrichment defaults to 100 distinct intervention names, maximum 200. Explicit investigational products are prioritised before unknown/comparator/placebo roles. Omitted names and source truncation are reported. Successful completion means the requested bounded job finished, not that global coverage is complete.
- Requests use the existing paced, bounded, retrying HTTP client. A bounded job has a 15-minute execution budget; jobs requesting either full-collection option have a six-hour budget. Successful checkpoints are saved after each source and intervention. A failed source resumes from the start of that source; page-level resumability is not implemented.
- Source failures never substitute an unrelated old search. Enrichment failures and missing mappings remain visible. Open Targets enrichment failure preserves available ChEMBL evidence as partial failure.
- Evidence responses are content-versioned in SQLite and cached for seven days. Returned evidence retains its actual retrieval date and content hash. New jobs fetch registries again; `refreshEvidence: true` also refreshes enrichment. Expired evidence is not silently used when a refresh fails.
- ChEMBL release metadata is recorded. Open Targets responses are hashed and dated; no unverified release identifier is asserted. Open Targets mechanism annotations may reuse ChEMBL, so they are not counted as independent corroboration.

## Snapshots and exports

Finished jobs receive an immutable `snapshotId`. Save that ID for later comparison. Resuming a partial job creates a new snapshot while preserving the previous snapshot. Use job IDs to resume/cancel work; use snapshot IDs to inspect historical results. One job per server process avoids accidental bursts; atomic claims prevent concurrent resumption of the same job.

JSON and CSV files are written under `exports/` beside the SQLite database. The JSON includes the full evidence chain, coverage, unresolved entries, intentionally excluded non-drug occurrences, checkpoints and the exact raw registry/enrichment versions used. It does not substitute newer source records for a historical snapshot. CSV contains summary rows and structured supporting-registration fields; retain those qualifications when sharing it. Spreadsheet formula-like values are escaped. Data exports remain local and ignored by Git.

`compare_landscapes` requires matching disease, view, source selection and collection/enrichment bounds. It reports additions, changes, absence from the second sample and coverage differences. Absence is not evidence of program discontinuation. Registry retrieval timestamps alone are excluded from row comparisons; source record/evidence changes remain detectable.

No background schedule is installed. Full incremental mirrors, automated literature extraction, a general manual-curation interface and independent expert validation are outside this first release.

## Terminal use and validation

```sh
# Keep the process running until the bounded job finishes.
node src/landscape-cli.mjs run --disease "cystic fibrosis" --view ongoing --limitPerSource 100 --maxInterventions 100

node src/landscape-cli.mjs get JOB_ID --section unresolved
node src/landscape-cli.mjs resume JOB_ID
node src/landscape-cli.mjs export SNAPSHOT_ID
node src/landscape-cli.mjs compare FIRST_SNAPSHOT_ID SECOND_SNAPSHOT_ID
node src/landscape-cli.mjs resolve ivacaftor
node src/landscape-cli.mjs targets CHEMBL2010601

# Offline regression tests, then an optional live CF check.
npm test
npm run smoke:landscape:live
```

The live check uses the official MCP client and a real stdio server. It verifies ivacaftor's ChEMBL identity and direct CFTR mechanism, checks Open Targets annotations, collects a bounded CF sample from all three registries, waits for completion and exports results. This is a functionality check and developer-reviewed pilot, not a sensitivity estimate for all clinical targets in CF.

## Data access

- [ChEMBL API](https://chembl.gitbook.io/chembl-interface-documentation/web-services/chembl-data-web-services): identities, mechanisms, target components and release metadata.
- [Open Targets API](https://platform-docs.opentargets.org/data-access/graphql-api): canonical disease identity and integrated drug mechanism annotations.
- [Open Targets drug sources](https://platform-docs.opentargets.org/drug): shared ChEMBL lineage and modality coverage limitations.

No additional API keys are needed for these integrations. IUPHAR/BPS is not connected in this release; its current API requires a key. Publications, sponsor material and full protocol review are not automatically ingested. Software licensing does not replace source-data terms: check those before redistributing exported datasets.

### Expanded collection

Set `collectAllCtgov: true` on `get_clinical_target_landscape` to follow ClinicalTrials.gov pagination to exhaustion, overriding its `limitPerSource` sample cap. The query remains condition-focused and interventional; the selected status view is applied afterward. CTIS and ISRCTN keep their requested source bounds. `coverage.ctgovComplete` requires exhausted pagination, a stable reported total and an equal collected count. A changing registry total is reported as unreconciled rather than complete.

Set `enrichAllInterventions: true` to override `maxInterventions` and attempt every distinct intervention name in that view. `coverage.allInterventionNamesAttempted` confirms attempts, not successful identification or proof that every clinical target is known. Unknown identities and failed evidence requests remain explicit. Existing successful evidence checkpoints and the seven-day evidence cache are reused.

CLI equivalent:

```sh
node src/landscape-cli.mjs run --disease "cystic fibrosis" --view ongoing --collectAllCtgov --enrichAllInterventions
```

### Reviewed CF overlay

`data/cf-intervention-review.json` records an AI-assisted evidence review of the expanded CF snapshot. It covers every unresolved or ambiguous name, previously identified drugs lacking curated mechanisms, and the incorrect parent grouping of deutivacaftor. Evidence includes exact stored registry versions, product labeling, primary research and sponsor sources. Drug-wide pharmacology does not establish disease-specific clinical activity.

Run `node scripts/review-cf-landscape.mjs SNAPSHOT.json --db PATH --out DIRECTORY`. The script refuses mismatched snapshot IDs/content hashes, changed registration versions, duplicate decisions and missing decisions. Additional canonical identities and mechanisms use the existing evidence cache and bounded HTTP client; incomplete target-service responses fail visibly. It writes an overlay without modifying the source snapshot or changing MCP landscape semantics. The original collection coverage and the reviewed retained-registration count are reported separately.

Review outputs include the target/drug/trial evidence CSV, a complete decision audit, excluded registrations with reasons and a JSON containing all review data and a review-content hash. Local `reviewed:` identifiers denote curated concepts, not database accessions. Gene delivery, mRNA replacement, splice correction, indirect expression, protein interactions, nucleic-acid substrates, organism-directed therapy and mechanisms without a unique molecular target remain distinct. Multi-ingredient alternatives do not become aliases of one molecule.

The review excludes 25 non-CF bronchiectasis registrations and the pGM169/GL67A registration whose linked EU results establish completion in 2014. SP-101 remains flagged because external development-status evidence conflicts with registry/sponsor descriptions. Other registry statuses have not undergone a full independent currency audit. Experimental-arm membership and registration phase still do not establish a drug-specific phase in CF patients; the overlay makes no new confirmed-program claims.

The ledger is snapshot-specific, not a universal synonym dictionary. Start a new ledger version after reviewing new source versions; do not carry these decisions to an arbitrary new snapshot. This is not independent clinical expert validation.

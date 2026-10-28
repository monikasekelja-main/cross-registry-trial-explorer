# Verification — updated 27 October 2026

## Environment

Node.js v24.19.0 using built-in SQLite and the native test runner. The MCP transport uses the official `@modelcontextprotocol/server` 2.3.1 SDK and Zod 4.6.5. The official client SDK 2.3.1 is a development dependency for protocol tests. Exact versions and integrity hashes are in `pnpm-lock.yaml`.

## Live verification — initial broad search, 22 October 2026

The adapters were exercised against the actual ClinicalTrials.gov and CTIS hosts, without credentials. A bounded `melanoma` import returned:

| Source | Imported records | Source-reported query total | Import bounded? |
|---|---:|---:|---|
| ClinicalTrials.gov | 2 | 4,580 | Yes |
| CTIS | 2 | 213 | Yes |

These totals were observed during this run, can change, and are not directly comparable measures of coverage. Search semantics and source coverage differ. No cross-registry deduplication was performed.

The initial sample contained four source records. Three matched the local literal `melanoma` search. This difference is expected for broad keyword mode: the source engines also search fields outside the compact local index. Databases accumulate records across subsequent imports.

The adapter smoke command is `node scripts/smoke-live.mjs`. It now uses condition mode by default. Local artifacts are `.data/live-smoke.sqlite` and `.data/live-smoke-report.json`; the directory is ignored by Git. The table above is a historical observation from keyword mode, not a substitute for re-running the smoke check.

## Default condition search — 23 October 2026

`node scripts/smoke-mcp-live.mjs` passed through the actual MCP subprocess with plain `query: "melanoma"`, no manual AREA expression, and two records per source. All four records explicitly listed melanoma in their condition fields. The script now asserts this relevance check as well as the exact source query criteria.

| Source | Applied criteria | Source total | Returned IDs |
|---|---|---:|---|
| ClinicalTrials.gov | `query.term=AREA[Condition]"melanoma"` | 3,448 | NCT07364474; NCT07328516 |
| CTIS | `medicalCondition=melanoma` | 180 | 2026-526261-14-00; 2025-524405-33-00 |

Totals are observations, not fixed expectations. The previous broad ClinicalTrials.gov query returned a lung-cancer record that did not list melanoma as a condition; the new condition query did not. Keyword mode remains available explicitly. Condition mode does not automatically fall back to broad search or expand synonyms; ClinicalTrials.gov treats a multiword condition as a literal phrase.

## Automated tests

All **30 tests passed** on 23 October with `node --test test/*.test.mjs`. The original 19 prototype tests cover:

- Sparse records, false versus unknown values, partial dates, malformed identities, and CTIS search/detail ID mismatches.
- Regulatory authorization remaining separate from recruitment, including explicit recruitment-start flags.
- Explicit cross-registry IDs retained without an automatic merge.
- ClinicalTrials.gov cursor pagination and cyclic-token rejection; CTIS search/detail sequencing and fixed page-size pagination.
- HTML returned with HTTP 200, malformed JSON, oversized bodies, permanent HTTP errors, wrapped transient network failures, and Retry-After parsing.
- Prompt cancellation and a usable queue after cancellation.
- Idempotent content versioning, return to an older version, atomic rollback, and retaining data when one source fails.
- Literal full-text queries, exact source/country/status facets, and cursor invalidation after an import.
- Read-only loopback HTTP search, raw provenance, history, missing records, and invalid query parameters.

Fixtures in `test/fixtures.mjs` are synthetic and labeled as such. Network calls are mocked in automated adapter tests; the separate live smoke run tests real source access. The HTTP integration test binds an ephemeral loopback port.

Four additional adapter tests cover condition-field criteria for multiword names, prevention of query-scope escape through quotes, exclusion of incidental broad hits before the requested result limit, explicit keyword mode with preserved expressions, and no broad fallback after zero condition matches. The CTIS pagination test also checks `medicalCondition` on every page.

## MCP verification

Seven MCP tests cover stdio handshakes (legacy and automatic protocol negotiation), tool discovery, schema validation, cached search and cursor continuation, raw retrieval, process exit after disconnect, per-call live results without old cached matches, explicit partial and total source failures, cancellation, stale-cursor errors, the default condition mode, and keyword opt-in. They check that the selected mode and exact criteria appear in results and persisted import scope. The stdio server is spawned with an unrelated working directory to validate absolute configuration paths. Other tool tests use the official client's in-memory transport and mock only the upstream adapters.

The initial keyword-mode MCP check on 22 October discovered all four tools, returned two registrations from each registry, retrieved one imported record from each, and exercised cached search and source status. Source-reported totals for `melanoma` were 4,580 (ClinicalTrials.gov) and 213 (CTIS). The 23 October condition-mode check is recorded above. These are source-specific totals, not a combined unique-trial count.

Local evidence is saved in `.data/mcp-live-smoke-report.json`, with the imported database in `.data/mcp-live-smoke.sqlite`. A machine-specific connection config is in `.data/mcp-config.json`; regenerate it with `node scripts/mcp-config.mjs` after moving the project or changing Node installations.

`pnpm audit --prod` reported no known vulnerabilities for the installed runtime dependency tree during this verification. This is a point-in-time check.

## Not established

Complete or incremental registry ingestion, long-term CTIS endpoint stability, source-wide removal detection, multilingual recall, medical synonym matching, deduplication quality, patient matching, individual desktop-host configuration, hosted Streamable HTTP MCP, distributed rate limiting, production load, and production redistribution permissions were not validated.


## ISRCTN integration — 24 October 2026

- All 35 offline automated tests passed with Node.js 24+, including real stdio handshakes, default three-source discovery/search, ISRCTN normalization and local retrieval, partial failures, XML validation, unsafe declarations, malformed/count failures and HTTP routes.
- `node scripts/smoke-mcp-live.mjs` passed through an official MCP client and a real stdio server process. Default condition query `melanoma`, limit two per source, returned six registrations: two each from ClinicalTrials.gov, CTIS and ISRCTN. Source totals at execution: 3448, 180 and approximately 59 respectively; these are separate, overlapping source counts.
- ISRCTN records: `ISRCTN62918594` and `ISRCTN16858627`; both explicitly include melanoma in their condition descriptions. Imported-record retrieval worked for every source. The local report is ignored under `.data/mcp-live-smoke-report.json`.
- Existing SQLite databases need no schema migration. Reconnect the MCP client after updating to discover `isrctn`. No full mirror, scheduled refresh or cross-registry deduplication was added.


## Recruitment, study type and treatment purpose — 24 October 2026

The shared live tool, saved search, CLI and local HTTP search now accept `recruitmentStatus`, `studyType` and `primaryPurpose: treatment`. Normalizer version 3 records classifications and recruitment provenance; import history retains requested filters, scan counts and total-count scope.

`node scripts/smoke-mcp-live.mjs --filtered` passed through the official MCP client and real stdio server. Query melanoma with recruiting + interventional + treatment and limit two returned six registrations:

- ClinicalTrials.gov: NCT05629546, NCT07565285. Upstream total 278 includes requested filters.
- CTIS: 2025-521562-95-00, 2024-519605-36-00. Sixteen candidates scanned; upstream 62 includes recruiting but precedes local therapy-scope filtering.
- ISRCTN: ISRCTN20735014, ISRCTN14643179. Fifty-nine candidates scanned; approximate upstream 59 precedes local status, study-design and purpose filtering. Non-melanoma-only matches were excluded. ISRCTN classifies the preoperative planning study as Treatment; no title-based clinical reclassification is performed.

The offline suite covers filter composition/validation, real MCP input schemas, filter provenance, exclusion of unknown/invitation/observational/diagnostic classifications, scan limits, WHO status joins, local facets and cursor invalidation. All 45 tests passed. Live records and report remain ignored under `.data/mcp-filtered-smoke-report.json`.

Limits: CTIS scope 3 is a conservative treatment criterion. ISRCTN status is registry-published and may be date-derived. The scans are bounded, registry statuses can be stale, and recruiting at trial/country level does not guarantee a particular site is enrolling. No patient eligibility assessment or full registry mirror is implemented.

## Clinical target landscape pilot — 26 October 2026

Implemented within the existing MCP server, version 0.2.0:

- Exact ChEMBL preferred-name/synonym identity resolution, ambiguity handling, parent/form identity and explicit combination/active-substance handling.
- Curated mechanism/target retrieval from ChEMBL, integrated Open Targets annotations, references, species/components, directness and shared lineage.
- Canonical disease resolution with a narrowly reviewed CF profile. A developer-reviewed ivacaftor–CFTR anchor uses the Kalydeco label; it is not a general clinical expert audit.
- Bounded multi-registry jobs with ongoing/recruiting/historical views, explicit-ID grouping, intervention-role evidence, unresolved/excluded sections and role-qualified phases. Drug-wide maximum phase is not used as disease-specific phase.
- Durable per-source/per-intervention checkpoints, cancellation/resume, atomic job claims, immutable completed snapshots, comparison and local JSON/CSV exports. JSON includes the exact raw source versions and enrichment responses referenced by the snapshot.
- Existing trial tools remain compatible. Added CLI, tool guide and live MCP smoke script.

All **61 automated tests passed** using Node.js 24+. They cover the existing 45 registry/transport cases and 16 landscape cases: identity anchors/ambiguity, source mismatch, partial failures, cache refresh, status views, role separation, gene-payload non-inference, disease-specific phase, grouping, restart persistence, cancellation, concurrent resume protection, snapshot immutability, historical raw evidence and CSV escaping.

`node scripts/smoke-landscape-live.mjs` uses the official MCP client and a real stdio server. It verifies ivacaftor/CHEMBL2010601 → direct CFTR/CHEMBL4051 and the Open Targets CFTR gene annotation, then runs a CF historical sample with ten registrations per registry and up to forty intervention names. The pilot returned thirty source registrations and nine drug–mechanism rows. These are candidate landscape links, not nine proven active target programs or nine unique targets. Source totals at verification were 1125 CT.gov interventional registrations, 38 CTIS candidates and approximately 73 ISRCTN candidates; totals overlap and are not combined.

Live reports, jobs, immutable snapshots and exports remain local under ignored `.data/`. They preserve unresolved classifications and conservative role limitations. The CLI identity lookup and historical snapshot export were also exercised. Details and remaining scope limits are in [the landscape guide](clinical-target-landscape.md).

Not established in this pilot: complete global target coverage, general disease-specific curation, automatic complication classification, independent expert validation, page-level ingestion resume, full incremental registry mirrors or automatic literature extraction. Completion refers to the requested bounded job, not scientific completeness.

Final pilot snapshot: `cd4ea28a-efd6-4d1e-952f-fdf4e140cd9b` (job `cdb0729a-5373-4ccc-b13b-ca73bd395b44`). It contains 30 source registrations, nine candidate drug–mechanism rows, 35 unresolved intervention occurrences and nine intentionally excluded non-drug occurrences. The exact raw versions of all 30 registry records and 95 enrichment responses were exported and their hashes verified. No complete investigational-treatment evidence chain was established by this small sample (`rowsWithEstablishedInvestigationalRole=0`); observed phases and candidate mechanisms must not be presented as nine confirmed active target programs. This conservative result is retained rather than filled with inferred roles or mechanisms.

## Expanded ClinicalTrials.gov collection — 27 October 2026

All 64 automated tests pass, including cursor exhaustion beyond a one-record sample bound, rejection of count drift as reconciled coverage, and full-mode enrichment beyond the configured name cap. Live MCP verification collected 1,125 of 1,125 condition-matching interventional ClinicalTrials.gov records with stable totals and exhausted pagination, plus 38 CTIS and 56 interventional ISRCTN registrations (73 ISRCTN condition candidates scanned). The ongoing view selected 189 registrations and 249 distinct intervention names. These counts are observations from this run and do not establish global registry or target completeness.

The expanded job completed through the official MCP client/stdio transport with all 249 names attempted, zero omitted names and zero evidence-service failures. Outcomes: 47 resolved, 142 unresolved, 3 ambiguous and 57 non-drug/excluded names. The immutable snapshot contains 26 candidate drug–mechanism rows; the flattened local CSV contains 136 supporting registration/intervention rows. Only one mechanism row meets the current strict investigational-treatment-role criterion. These are evidence links, not 26 confirmed active target programs. Snapshot: `add13327-8afa-489d-b44b-571c047e45ec`; local ignored artifacts include `.data/cf-expanded-report.json`, the JSON snapshot, trial-evidence CSV and a 249-name intervention-outcome audit CSV.

## Reviewed CF interventions — 27 October 2026

All 70 automated tests pass, including isotope-preserving drug identity, scoped review application, source-version rejection, multi-component mechanisms, exclusion of non-CF evidence, partial-service failure reporting and CSV formula escaping. The live reviewed overlay covers 165 names: all 145 unresolved/ambiguous names, 19 previously identified names without mechanisms, and one deutivacaftor identity correction. Primary registry/label/research and sponsor evidence is linked in the pinned review ledger. The existing source snapshot was preserved.

Final export: 234 supporting evidence rows; 76 drug–mechanism rows, including entries without a named molecular target. Excluded 25 non-CF bronchiectasis registrations and one trial independently documented as completed; 163 registrations remain in the registry-derived ongoing CF view. Remaining class/mixture/target uncertainties are explicit in the 165-name audit. CSV row counts, source/version references, unique evidence rows, exclusion membership and deutivacaftor's distinct identifier were checked. These counts are not counts of unique genes or confirmed active clinical programs.

## Automatic CF review in MCP — 27 October 2026

Version 0.3.0 applies the reviewed identities/mechanisms and disease-scope policy during new CF landscape jobs. The bundled protocol fingerprints cover 140 reviewed registrations. All 76 automated tests pass, including material-context changes versus routine status updates, registration isolation, multi-component resolution and failures, policy pinning across resume, immutable export, non-CF/mixed scopes, historical completed-trial handling, unknown targets and real MCP audit-section access. No database migration or dependencies were added.

Live verification through the official MCP client and actual stdio server collected 1,125/1,125 ClinicalTrials.gov records, 38 CTIS records and 56 interventional ISRCTN records. The updated ongoing view selected 188 registrations before scope checks and 162 after 26 scope/completion exclusions. There were 170 applied per-registration intervention reviews and one changed-context flag (VX-581, NCT07813039); it did not inherit its old reviewed mapping. All 209 distinct selected names were attempted, with zero mechanism-service failures. The resulting snapshot contains 71 candidate drug–mechanism rows and 224 supporting registration/intervention rows, including distinct gene/RNA restoration relationships. These are not counts of unique genes or confirmed programs. Snapshot `f8023381-66d1-4fc3-a6d9-5a95e675df73` and report `.data/cf-integrated-report.json` are local ignored artifacts.

JSON export was checked for original raw registry versions and the raw hashed review/context bundle; excluded registrations did not appear in target support, and genetic-therapy rows did not gain unsupported disease-specific phase claims. Registry classifications and the original clinical review limitations remain in force.

## VX-581 protocol review — 28 October 2026

Compared the current official ClinicalTrials.gov responses for NCT07813039 and NCT07283770 with their exact original reviewed versions. NCT07813039 changed enrollment type from ESTIMATED to ACTUAL, recruitment to ACTIVE_NOT_RECRUITING and update/contact fields. The intervention, formulation-comparison descriptions, phase and healthy-volunteer population did not change. The companion protocol differed only in the derived registry version date. Raw versions and a local comparison report were retained.

Vertex's 3 August 2026 quarterly disclosure explicitly identifies VX-581 as an additional next-generation 3.0 CFTR corrector. Runtime review update `2026-10-28.1` therefore supports VX-581 → CFTR with relationship `corrector` and sponsor-reported evidence, preserving uncertainty about binding site, efficacy and cohort-specific clinical development. The original ledger/context files and standalone historical overlay were preserved; the new runtime bundle contains the scoped update and source statement. Only the VX-581 item is dated as reviewed on 28 October.

All 77 tests passed, including updated mapping/date provenance, unchanged unrelated decisions and absence of direct-target or disease-specific efficacy/phase claims. A fresh official-client MCP run collected the full 1,125-record ClinicalTrials.gov query plus 38 CTIS and 56 interventional ISRCTN records. Scope checks retained 162 ongoing registrations from 188 status-selected registrations. All 209 distinct names were attempted; 171 review applications succeeded, no protocol-context flags remained and no mechanism service failed. Snapshot `30774b2d-933c-4c4a-bbca-d39a3b2e47b8` exports 225 trial-evidence CSV rows, including two qualified VX-581 supports. The CSV's target ID, corrector relationship, review date, source references and lack of confirmed-development evidence were checked. Local report: `.data/cf-vx581-updated-report.json`; protocol comparison: `.data/vx581-protocol-review.json`.

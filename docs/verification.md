# Verification — updated 23 October 2026

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

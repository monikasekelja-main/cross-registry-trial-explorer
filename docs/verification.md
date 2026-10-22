# Verification — 22 October 2026

## Environment

Node.js v24.19.0 using built-in SQLite and the native test runner. The MCP transport uses the official `@modelcontextprotocol/server` 2.3.1 SDK and Zod 4.6.5. The official client SDK 2.3.1 is a development dependency for protocol tests. Exact versions and integrity hashes are in `pnpm-lock.yaml`.

## Live verification

The adapters were exercised against the actual ClinicalTrials.gov and CTIS hosts, without credentials. A bounded `melanoma` import returned:

| Source | Imported records | Source-reported query total | Import bounded? |
|---|---:|---:|---|
| ClinicalTrials.gov | 2 | 4,580 | Yes |
| CTIS | 2 | 213 | Yes |

These totals were observed during this run, can change, and are not directly comparable measures of coverage. Search semantics and source coverage differ. No cross-registry deduplication was performed.

The local database contains four source records. Three match the local literal `melanoma` search. This difference is expected: the upstream search engines also match text beyond the compact fields indexed locally. A blank local search returns all four records.

The reproducible command is `node scripts/smoke-live.mjs`. Local artifacts are `.data/live-smoke.sqlite` and `.data/live-smoke-report.json`; the directory is ignored by Git. This report is a dated observation, not a substitute for re-running the smoke check.

## Automated tests

All **25 tests passed** with `node --test test/*.test.mjs`. The original 19 prototype tests cover:

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

## MCP verification

Six additional tests cover stdio handshakes (legacy and automatic protocol negotiation), tool discovery, schema validation, cached search and cursor continuation, raw retrieval, process exit after disconnect, per-call live results without old cached matches, explicit partial and total source failures, cancellation, and stale-cursor errors. The stdio server is spawned with an unrelated working directory to validate absolute configuration paths. Other tool tests use the official client's in-memory transport and mock only the upstream adapters.

`node scripts/smoke-mcp-live.mjs` also passed against both real registries through an actual stdio MCP subprocess. It discovered all four tools, returned two registrations from each registry, retrieved one imported record from each, and exercised cached search and source status. Source-reported totals for `melanoma` were 4,580 (ClinicalTrials.gov) and 213 (CTIS). These are source-specific totals, not a combined unique-trial count.

Local evidence is saved in `.data/mcp-live-smoke-report.json`, with the imported database in `.data/mcp-live-smoke.sqlite`. A machine-specific connection config is in `.data/mcp-config.json`; regenerate it with `node scripts/mcp-config.mjs` after moving the project or changing Node installations.

`pnpm audit --prod` reported no known vulnerabilities for the installed runtime dependency tree during this verification. This is a point-in-time check.

## Not established

Complete or incremental registry ingestion, long-term CTIS endpoint stability, source-wide removal detection, multilingual recall, medical synonym matching, deduplication quality, patient matching, individual desktop-host configuration, hosted Streamable HTTP MCP, distributed rate limiting, production load, and production redistribution permissions were not validated.

# Cross-registry Trial Explorer

A local data service and **single MCP server for ClinicalTrials.gov and EU CTIS**. It fetches bounded samples from the real registries, keeps versioned source JSON, and provides live MCP search plus cached search through MCP, a CLI, and a read-only HTTP API.

Search two registries through one interface while keeping each source's records, update dates, and limitations visible. The [source-access matrix](docs/source-access-matrix.md) describes the integrations; implementation lives in `src/`.

## Run

Requires **Node.js 24+**. The MCP transport uses the official SDK and Zod; install the pinned dependencies once with `pnpm install --frozen-lockfile` (or `npm install` if pnpm is unavailable). No API keys or database server are needed. Node's built-in SQLite module is used; it may emit an experimental-feature warning on some Node versions.

```sh
# Import five records per source. This makes real network requests.
node src/cli.mjs sync --query melanoma --limit 5

# Search the imported corpus, or restrict it to a source/country.
node src/cli.mjs search --q melanoma
node src/cli.mjs search --source ctis --country Italy
node src/cli.mjs status

# Start the local read-only API.
node src/cli.mjs serve --port 3010
```

If Node is available only through the Codex bundled runtime, replace `node` with:

```sh
"$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
```

The default database is `.data/trials.sqlite`. Use `--db PATH` to select another one. Ingesting a new query adds or refreshes records; it never deletes records imported by an earlier query.

To generate and query a sample from both live registries:

```sh
node scripts/smoke-live.mjs
node src/cli.mjs search --db .data/live-smoke.sqlite
node src/cli.mjs serve --db .data/live-smoke.sqlite
```

## Connect an MCP client

The **stdio** entry point is `node src/mcp-stdio.mjs`. Your MCP client starts it as a child process; you do not need to run the HTTP API. stdout is reserved for MCP messages, and errors go to stderr.

Generate a client configuration with this machine's actual Node executable and absolute paths:

```sh
node scripts/mcp-config.mjs
```

Copy the generated `clinical-trials` entry into your client's `mcpServers` configuration, then reload that client. The generator prints configuration without changing any application's settings. Clients that use a different configuration format need the same executable and arguments translated into their format.

The generated object has this form:

```json
{
  "mcpServers": {
    "clinical-trials": {
      "command": "/absolute/path/to/node",
      "args": [
        "/absolute/path/to/clinical-trials/src/mcp-stdio.mjs",
        "--db",
        "/absolute/path/to/clinical-trials/.data/trials.sqlite"
      ]
    }
  }
}
```

The MCP default database is anchored to the project directory, independent of the client's working directory. The CLI and HTTP commands still use a relative database path unless `--db` is supplied. No pre-import is required for live search.

| MCP tool | Behavior |
|---|---|
| `search_trials` | Live search of both registries by default. Takes `query`, optional `sources`, and `limitPerSource` (default 5, maximum 20). Returns only this call's fetched records and saves them locally. |
| `search_imported_trials` | Local-only search using `q`, `source`, `country`, `recruitmentStatus`, `limit`, and `cursor`, with import scope and freshness. |
| `get_trial` | Retrieve an imported registration using `source` and `id`; optional `includeRaw` returns original evidence. No network lookup. |
| `get_source_status` | Cached coverage, latest successes/failures, source links, and access limitations. No arguments. |

Example tool calls:

```json
{"name":"search_trials","arguments":{"query":"melanoma","limitPerSource":2}}
{"name":"search_trials","arguments":{"query":"lung cancer","sources":["ctis"],"limitPerSource":5}}
{"name":"search_imported_trials","arguments":{"source":"ctis","country":"Italy"}}
{"name":"get_trial","arguments":{"source":"ctis","id":"2025-524405-33-00","includeRaw":true}}
```

Or ask your connected assistant: **“Search ClinicalTrials.gov and CTIS for melanoma trials, returning two from each registry. Show the source and recruitment information.”**

Live results are grouped by source, with individual totals and truncation. A partial failure remains visible and does not substitute older cached records. Failure of every selected source returns an MCP tool error. The local cache is intentionally updated by `search_trials`, so it is annotated as a non-destructive write; the other three tools are read-only. No upstream data is modified.

MCP clients should allow up to 150 seconds for a live call; the server caps it at 120 seconds and propagates cancellation. The default five-record search normally needs only a few seconds. Tool results carry the same JSON in text and structured output. Responses over 1 MB return an error with a hint to reduce the limit or omit raw data. CTIS authorization is never presented as a recruitment guarantee.

The implementation follows the [official SDK's stdio factory](https://ts.sdk.modelcontextprotocol.io/v2/serving/stdio.html) and uses SDK input validation and protocol negotiation. Streamable HTTP MCP is not enabled; the existing HTTP API remains a separate REST interface.

## HTTP API

The server binds to `127.0.0.1` and does not accept imports or writes over HTTP.

| Route | Returns |
|---|---|
| `GET /healthz` | Process health and local index revision; not upstream health |
| `GET /sources` | Counts, last successful imports, latest failures, and source-access limitations |
| `GET /trials?q=melanoma&limit=20` | Common search results and coverage metadata |
| `GET /trials?source=ctis&country=Italy` | Exact source/country filters |
| `GET /trials?recruitmentStatus=recruiting` | Explicit normalized recruitment status |
| `GET /trials/ctgov/NCT07287917` | Imported record, provenance, version hash, and raw source payload |
| `GET /trials/ctis/2025-524405-33-00` | Imported CTIS record with country regulatory information |
| `GET /trials/ctis/2025-524405-33-00/history` | Distinct content versions and first-observed timestamps |

Search parameters are `q`, `source`, `country`, `recruitmentStatus`, `limit` (1–100), and `cursor`. Unknown or repeated parameters fail with HTTP 400. Pass `nextCursor` back with the **same filters and limit**. Imports change the index revision; an older cursor returns HTTP 409, asking the caller to restart. A read transaction keeps each response's counts and records consistent.

`q` uses literal AND terms over title, conditions, interventions, and sponsor. SQLite handles full-text tokenization; this prototype has no medical synonym expansion. Registry searches use their own broader search languages, so a record imported for a registry query may not match the same local keyword query.

HTTP 404 for a record means **not imported locally**, not absent from the upstream registry. All totals count **source records**, not deduplicated trials.

## Data and behavior

- `source` plus `sourceId` identifies a registration. Explicit NCT references in CTIS and recognizable secondary registry IDs in ClinicalTrials.gov are preserved without automatically merging records.
- `sourceUpdatedAt` is the registry's update date when supplied. `retrievedAt` is when this program observed it. Partial dates are preserved, not padded to invented days.
- CTIS `regulatoryStatus` and ClinicalTrials.gov `recruitmentStatus` stay separate. In particular, **Authorised does not mean recruiting**. CTIS recruitment status remains `unknown`; published country flags and raw records remain available.
- `hasResults: null` means not established from the imported fields. False and missing are distinct.
- CTIS search summaries and detail responses are both stored as raw input. Other unnormalized fields, document references, translations, and secondary identifiers remain accessible there.
- Raw records are content-hashed with the normalizer version. Re-importing unchanged content refreshes observation time without adding another content version. Returning to earlier content selects its existing version. History is a catalog of distinct versions, not a full event log of every observation.
- Each source import is atomic. Fetching or validating any record in a source batch fails that source's import and preserves its previous records. The other source still runs. CLI sync exits nonzero on partial failure.
- Requests are paced at one per second **per source in this process**, with bounded pending work, cancellation, per-fetch timeouts, response size limits, transient retries, and `Retry-After` handling. This pacing is a conservative prototype setting, not a claimed provider quota.

No patient profiles, matching, eligibility decisions, document downloads, or external write operations are implemented.

## Verify

```sh
node --test test/*.test.mjs
node scripts/smoke-live.mjs
node scripts/smoke-mcp-live.mjs
```

Tests use clearly marked synthetic records. The adapter smoke command imports two records per source into `.data/live-smoke.sqlite` and writes `.data/live-smoke-report.json`. The MCP smoke command launches the real stdio server through the official MCP client, searches both registries, retrieves a record from each, and checks cached search and source status. Its artifacts are `.data/mcp-live-smoke.sqlite` and `.data/mcp-live-smoke-report.json`.

Live smoke tests require network access. The ordinary test suite requires no registry access, but needs loopback binding for its HTTP integration test and subprocess permission for its stdio integration tests.

See [verification notes](docs/verification.md) for the run performed on 22 October 2026.

## Structure

```text
src/adapters.mjs      Registry requests, validation, normalization
src/http-client.mjs   Pacing, cancellation, bounded JSON reads, retries
src/store.mjs         SQLite, raw versions, FTS search, coverage, cursors
src/sync.mjs          Independent source imports and failure reporting
src/server.mjs        Read-only HTTP routes
src/cli.mjs           Command-line entry point
src/mcp.mjs           MCP tool definitions over the same adapters and store
src/mcp-stdio.mjs     Stdio MCP process entry point
test/                Synthetic fixtures and automated tests
docs/                Source-access matrix and verification notes
```

## Deliberate prototype limits

Imports are bounded samples (1–1000 records per source), **not complete mirrors**. There is no incremental checkpoint, deletion detection, scheduler, resumable failed import, or claim of snapshot consistency across upstream pages. A source's last successful import may cover only one query; `/sources` displays that scope. The local corpus accumulates records from different imports and dates.

CTIS's portal endpoint worked in live probes but no supported, versioned public API contract was verified. Country recruitment inference, code-list normalization, and unverified field mappings are deliberately omitted. CTIS's regulatory phase labels remain source text rather than being equated with ClinicalTrials.gov phase enums.

There is no fuzzy deduplication, unique-trial count, geographic radius search, multilingual expansion, authentication, or hosted MCP transport. The local HTTP service is a development interface. Do not expose it publicly without deployment controls.

The next ingestion step is an incremental, resumable worker with provider-approved access and source-specific update semantics. PostgreSQL becomes useful when moving beyond a single local process; it is not required to validate these two adapters.

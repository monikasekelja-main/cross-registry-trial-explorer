# Cross-registry Trial Explorer

Search **ClinicalTrials.gov**, the **EU Clinical Trials Information System (CTIS)** and **ISRCTN** from one AI assistant connection. Build evidence-backed drug–target landscapes with ChEMBL and Open Targets.

The app searches all three registries, shows which source each result came from, and saves the records on your computer so you can search them again later.

**Main contributor:** [monikasekelja-main](https://github.com/monikasekelja-main)

## What you can do

- Search all three registries at once, or choose just one.
- Read trial information and inspect the original source data.
- Search records you have already saved, without contacting the registries again.
- Check when records were retrieved and whether a source failed.
- Build a disease-specific drug–target landscape, inspect unresolved interventions, and export the evidence.

## Set up

You need **Node.js 24 or newer** and an AI application that supports local MCP servers. MCP is the connection that lets an AI assistant use this app’s search tools.

### 1. Download and install

```sh
git clone https://github.com/monikasekelja-main/cross-registry-trial-explorer.git
cd cross-registry-trial-explorer
npm install
```

If you use pnpm, run `pnpm install --frozen-lockfile` instead of `npm install`.

No registry API keys or separate database server are needed.

### 2. Generate your connection settings

From the project folder, run:

```sh
node scripts/mcp-config.mjs
```

This prints a `mcpServers` configuration with the correct paths for your computer.

### 3. Connect your AI application

Add the generated `clinical-trials` entry to your application’s MCP server settings, then reload the application. If it already has other MCP servers, keep those entries.

Some applications use a different settings format. In that case, use the same command and arguments printed by the script in the corresponding fields.

Your application starts the server when it connects. You do not need to start the HTTP API or import records first.

### 4. Try a search

Ask your connected assistant:

> Search ClinicalTrials.gov, CTIS and ISRCTN for melanoma trials. Return two results from each registry and show the source and recruitment information.

Then try:

> Show me the original source data for one of those trials.

> Search my saved CTIS records for trials in Italy.

## Clinical target landscapes

Ask your assistant:

> Build an ongoing clinical target landscape for cystic fibrosis across all three registries. Poll the job until it finishes, show the supporting trials and unresolved interventions, and export JSON and CSV.

By default, the server collects a bounded trial sample, resolves drug names with ChEMBL, and adds curated target/mechanism evidence with Open Targets annotations. It keeps comparators, background-treatment uncertainty, unknown identities, sources and retrieval dates visible. A drug mentioned in a trial is not automatically a new target program. To collect every matching interventional ClinicalTrials.gov record, set `collectAllCtgov: true`; to attempt every intervention in the selected status view, set `enrichAllInterventions: true`. Other registries keep their source bounds. Unresolved names remain visible, and full collection is reported only when cursor exhaustion and the registry total reconcile.

Landscape work returns a **job ID** immediately. Your assistant can check progress, resume interrupted work, inspect paginated results and export an immutable snapshot. Keep the local MCP server running while work proceeds. Reconnect after updating to discover the new tools.

See the [landscape guide](docs/clinical-target-landscape.md) for parameters, evidence rules, terminal commands, limits and validation. The first release is a developer-validated CF pilot; broader clinical completeness and expert review are not established.

## Available MCP tools

| Tool | What it does |
|---|---|
| `search_trials` | Searches condition fields in all three live registries and saves the returned records. Broad keyword search is optional. |
| `search_imported_trials` | Searches records already saved on your computer. |
| `get_trial` | Opens a saved record. Set `includeRaw` to `true` to include its original source data. |
| `get_source_status` | Shows saved-record counts, previous imports, and source failures. |
| `resolve_intervention` | Resolves exact drug names and source aliases, preserving ambiguity. |
| `get_drug_targets` | Retrieves curated mechanisms, targets and references. |
| `get_clinical_target_landscape` | Starts a disease landscape job with explicit collection and enrichment limits. |
| `get_landscape_job` | Checks progress and reads results, unresolved entries or registrations. |
| `resume_landscape_job` / `cancel_landscape_job` | Controls work while retaining checkpoints. |
| `export_landscape` / `compare_landscapes` | Exports evidence and compares saved snapshots. |

A live search returns up to **5 records per source by default**. You can request up to 20 per source. Larger searches take longer because CTIS retrieves each trial’s details separately.

Enter a plain condition name such as `melanoma` or `non-small cell lung cancer`. By default, live search checks the registered condition fields, rather than mentions elsewhere in the record. No manual query wrapper is needed.

Live search accepts `query`, optional `recruitmentStatus`, `studyType`, `primaryPurpose`, `sources` (`ctgov`, `ctis` and/or `isrctn`), `limitPerSource`, and `searchMode`. Saved-record search also supports country and recruitment-status filters. For example:

```json
{"query": "melanoma", "sources": ["ctgov", "ctis", "isrctn"], "limitPerSource": 2}
```

These are arguments for `search_trials`, not a terminal command.

To find **currently recruiting treatment trials**, use:

```json
{
  "query": "melanoma",
  "recruitmentStatus": "recruiting",
  "studyType": "interventional",
  "primaryPurpose": "treatment",
  "limitPerSource": 2
}
```

All filters are optional and combined with AND. `studyType` accepts `interventional`, `observational` or `expanded_access`. Interventional includes diagnostic and preventive research, so add `primaryPurpose: "treatment"` for treatment trials. Unknown classifications do not match a requested filter. Recruitment values are `recruiting`, `not_yet_recruiting`, `active_not_recruiting`, `by_invitation`, `completed`, `terminated`, `withdrawn`, `suspended` and `unknown`.

ClinicalTrials.gov applies filters upstream. CTIS applies supported recruitment codes upstream, then checks explicit therapy scope in fetched details. ISRCTN filters a sample of up to 100 candidates (or the CLI import limit if larger), using its published WHO-format recruitment status and explicit treatment purpose/type. CTIS checks up to 40 candidates (or the CLI limit if larger). The server stops within its existing 120-second budget. Fewer results can mean that the scan bound was reached, not that no further matches exist. Responses disclose `scanned`, `filterCoverage`, `truncated` and `upstreamTotalScope`; upstream totals may be **before** local filters.

Saved-record search accepts the same filters, using classifications stored at import time. Older records may lack study type or purpose; run a fresh live search to classify them. Registry classifications and recruitment statuses can be stale; follow the source link to check details. A planning or diagnostic-looking study may still be classified as treatment by its registry.


For drugs, sponsors, trial IDs, or a broad search across other fields, explicitly choose `"searchMode": "keyword"`. Registry query expressions also belong in keyword mode. Condition mode uses a literal condition phrase on ClinicalTrials.gov; there is no automatic synonym expansion or switch to broad search when nothing matches. Each response includes the mode and the exact criteria sent to each registry.

### Reviewed CF evidence export

The CF review ledger adds source-backed identities and mechanisms to the 27 October snapshot, including gene/RNA therapies and multi-ingredient regimens. It separates non-CF trials, completed trials, diagnostic agents and drug classes. Every decision is pinned to the original registration version.

```sh
node scripts/review-cf-landscape.mjs PATH_TO_SNAPSHOT.json --db .data/landscape-live.sqlite --out .data/exports
```

This creates a new reviewed JSON, evidence CSV, intervention-review CSV and exclusion CSV. It preserves the original snapshot. The ledger applies only to its recorded snapshot; it is not automatically applied to new MCP jobs. Unknown targets remain blank, and registry phases/statuses require clinical review. See [the review workflow](docs/clinical-target-landscape.md#reviewed-cf-overlay).

## Understand the results

- **These are limited search results.** The app does not download any registry in full.
- **Saved search covers your local records only.** It may return different results from a new live search.
- **The same trial can appear in multiple registries.** Records are not automatically merged, so counts are not counts of unique trials.
- **CTIS “Authorised” does not mean recruiting.** Explicit CTIS public status codes identify recruitment; regulatory authorisation and recruitment-start flags alone do not. Recruiting means at least one country, not every listed site.
- **A source failure is reported explicitly.** A failed live search does not quietly substitute older saved results.
- **This app does not assess patient eligibility.** Review the registry record and trial criteria before drawing conclusions.

Each record includes a link to its registry page, the retrieval time, and the source’s update date when available. Records are stored in `.data/trials.sqlite`. There is no background refresh.

ISRCTN uses its documented public XML API. Condition mode sends `condition:"<query>"`; keyword mode sends the query unchanged. Source evidence is stored as parsed XML, with attribute names prefixed by `@_`. When a recruitment filter is requested, the server also retrieves the WHO-format export and matches records by ID to obtain the registry’s published status. Otherwise it uses explicit overrides when present. ISRCTN may derive its published status from dates; the server does not calculate it locally. ISRCTN reports an approximate match total, and the app fetches only the requested bounded sample.

If you already connected this server, reconnect it or restart your AI application after updating and installing dependencies so it discovers the `isrctn` source. The server command and database path stay the same.

CTIS access currently uses its public website’s JSON endpoint. It worked in live testing, but a stable public API contract has not been verified. See the [source-access matrix](docs/source-access-matrix.md) for access details and reuse limitations.

## Use the terminal instead

Run these commands from the project folder:

```sh
# Fetch and save five records from each registry.
node src/cli.mjs sync --query melanoma --limit 5

# Fetch currently recruiting treatment trials.
node src/cli.mjs sync --query melanoma --recruitmentStatus recruiting --studyType interventional --primaryPurpose treatment --limit 2

# Opt into a broad keyword search instead of condition search.
node src/cli.mjs sync --query pembrolizumab --searchMode keyword --limit 5

# Search the records you have saved.
node src/cli.mjs search --q melanoma

# Check import history and failures.
node src/cli.mjs status
```

To use the local HTTP API, run `node src/cli.mjs serve`, then open [http://127.0.0.1:3010/trials](http://127.0.0.1:3010/trials). This API searches saved records. It is separate from the MCP connection.

## Tests and troubleshooting

```sh
# Automated tests; no registry requests.
npm test

# Test the MCP connection against all three live registries.
npm run smoke:mcp:live
```

If your AI application cannot connect, check that Node.js is version 24 or newer, install the dependencies, and regenerate the connection settings. Regenerate them whenever you move the project or change your Node installation.

If a live search times out, request fewer records. Where your client allows it, set its tool timeout to 150 seconds; the server stops live calls after 120 seconds.

The server runs locally over stdio. Hosted MCP access and full registry synchronization are not implemented. Landscape jobs group registrations only through explicit registry identifiers; ordinary trial searches retain separate source records.

For implementation details and test evidence, see the [verification notes](docs/verification.md).

## License

Licensed under the [MIT License](LICENSE). Copyright (c) 2026 monikasekelja-main.

You may use, modify, and distribute the software under the license terms. Registry data and third-party dependencies remain subject to their own terms; see the [source-access matrix](docs/source-access-matrix.md).

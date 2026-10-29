# Search tools and reference

Start with the [quick start](../README.md#quick-start) to connect your assistant. This guide covers tool arguments, filters, result limits and terminal commands.

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
| `get_landscape_job` | Checks progress and reads results, unresolved entries, review decisions and excluded registrations. |
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

## Understand the results

- **These are limited search results.** The app does not download any registry in full.
- **Saved search covers your local records only.** It may return different results from a new live search.
- **The same trial can appear in multiple registries.** Records are not automatically merged, so counts are not counts of unique trials.
- **CTIS “Authorised” does not mean recruiting.** Explicit CTIS public status codes identify recruitment; regulatory authorisation and recruitment-start flags alone do not. Recruiting means at least one country, not every listed site.
- **A source failure is reported explicitly.** A failed live search does not quietly substitute older saved results.
- **This app does not assess patient eligibility.** Review the registry record and trial criteria before drawing conclusions.

Each record includes a link to its registry page, the retrieval time, and the source’s update date when available. Records are stored in `.data/trials.sqlite`. There is no background refresh.

ISRCTN uses its documented public XML API. Condition mode sends `condition:"<query>"`; keyword mode sends the query unchanged. Source evidence is stored as parsed XML, with attribute names prefixed by `@_`. When a recruitment filter is requested, the server also retrieves the WHO-format export and matches records by ID to obtain the registry’s published status. Otherwise it uses explicit overrides when present. ISRCTN may derive its published status from dates; the server does not calculate it locally. “No longer recruiting” is treated as unknown overall activity, not active-not-recruiting. A reported completion date alone does not establish actual completion. ISRCTN reports an approximate match total, and the app fetches only the requested bounded sample.

If you already connected this server, reconnect it or restart your AI application after updating and installing dependencies so it discovers the `isrctn` source. The server command and database path stay the same.

CTIS access currently uses its public website’s JSON endpoint. It worked in live testing, but a stable public API contract has not been verified. See the [source-access matrix](source-access-matrix.md) for access details and reuse limitations.

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

For implementation details and test evidence, see the [verification notes](verification.md).


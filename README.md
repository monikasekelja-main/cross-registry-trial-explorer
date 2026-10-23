# Cross-registry Trial Explorer

Search **ClinicalTrials.gov** and the **EU Clinical Trials Information System (CTIS)** from one AI assistant connection.

The app searches both registries, shows which source each result came from, and saves the records on your computer so you can search them again later.

**Main contributor:** [monikasekelja-main](https://github.com/monikasekelja-main)

## What you can do

- Search both registries at once, or choose just one.
- Read trial information and inspect the original source data.
- Search records you have already saved, without contacting the registries again.
- Check when records were retrieved and whether a source failed.

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

> Search ClinicalTrials.gov and CTIS for melanoma trials. Return two results from each registry and show the source and recruitment information.

Then try:

> Show me the original source data for one of those trials.

> Search my saved CTIS records for trials in Italy.

## Available MCP tools

| Tool | What it does |
|---|---|
| `search_trials` | Searches condition fields in both live registries and saves the returned records. Broad keyword search is optional. |
| `search_imported_trials` | Searches records already saved on your computer. |
| `get_trial` | Opens a saved record. Set `includeRaw` to `true` to include its original source data. |
| `get_source_status` | Shows saved-record counts, previous imports, and source failures. |

A live search returns up to **5 records per source by default**. You can request up to 20 per source. Larger searches take longer because CTIS retrieves each trial’s details separately.

Enter a plain condition name such as `melanoma` or `non-small cell lung cancer`. By default, live search checks the registered condition fields, rather than mentions elsewhere in the record. No manual query wrapper is needed.

Live search accepts `query`, optional `sources` (`ctgov` and/or `ctis`), `limitPerSource`, and `searchMode`. Saved-record search also supports country and recruitment-status filters. For example:

```json
{"query": "melanoma", "sources": ["ctgov", "ctis"], "limitPerSource": 2}
```

These are arguments for `search_trials`, not a terminal command.

For drugs, sponsors, trial IDs, or a broad search across other fields, explicitly choose `"searchMode": "keyword"`. Registry query expressions also belong in keyword mode. Condition mode uses a literal condition phrase on ClinicalTrials.gov; there is no automatic synonym expansion or switch to broad search when nothing matches. Each response includes the mode and the exact criteria sent to each registry.

## Understand the results

- **These are limited search results.** The app does not download either registry in full.
- **Saved search covers your local records only.** It may return different results from a new live search.
- **The same trial can appear in both registries.** Records are not automatically merged, so counts are not counts of unique trials.
- **CTIS “Authorised” does not mean recruiting.** CTIS recruitment status remains unknown in this prototype; the original country information is retained.
- **A source failure is reported explicitly.** A failed live search does not quietly substitute older saved results.
- **This app does not assess patient eligibility.** Review the registry record and trial criteria before drawing conclusions.

Each record includes a link to its registry page, the retrieval time, and the source’s update date when available. Records are stored in `.data/trials.sqlite`. There is no background refresh.

CTIS access currently uses its public website’s JSON endpoint. It worked in live testing, but a stable public API contract has not been verified. See the [source-access matrix](docs/source-access-matrix.md) for access details and reuse limitations.

## Use the terminal instead

Run these commands from the project folder:

```sh
# Fetch and save five records from each registry.
node src/cli.mjs sync --query melanoma --limit 5

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

# Test the MCP connection against both live registries.
npm run smoke:mcp:live
```

If your AI application cannot connect, check that Node.js is version 24 or newer, install the dependencies, and regenerate the connection settings. Regenerate them whenever you move the project or change your Node installation.

If a live search times out, request fewer records. Where your client allows it, set its tool timeout to 150 seconds; the server stops live calls after 120 seconds.

The server runs locally over stdio. Hosted MCP access, automatic deduplication, and full registry synchronization are not implemented.

For implementation details and test evidence, see the [verification notes](docs/verification.md).

# Cross-registry Trial Explorer

**Explore clinical trials across three registries from one AI chat.**

Search [ClinicalTrials.gov](https://clinicaltrials.gov), the [EU Clinical Trials Information System (CTIS)](https://euclinicaltrials.eu) and [ISRCTN](https://www.isrctn.com) together. Find trials for a condition, compare their details and follow each result back to its source.

For research questions, you can also build a disease-specific overview of drugs and targets, with supporting trials and evidence, then export it as CSV or JSON.

**Main contributor:** [monikasekelja-main](https://github.com/monikasekelja-main)

## Quick start

You need **Node.js 24 or newer**, Git, and an AI application that supports local **MCP servers**. MCP lets your assistant call this project's search tools. No registry API keys or separate database server are needed.

### 1. Install

```sh
git clone https://github.com/monikasekelja-main/cross-registry-trial-explorer.git
cd cross-registry-trial-explorer
npm install
```

### 2. Connect your assistant

From the project folder, generate the connection settings:

```sh
npm run mcp:config
```

Copy the printed `clinical-trials` entry into your AI application's MCP settings, keeping any existing servers. Reload the application to connect.

Settings screens vary between applications. If yours uses separate fields, enter the `command` and `args` printed by the script. Your application starts the server automatically; there is no need to launch it separately or import trials first.

### 3. Ask your first question

> Search ClinicalTrials.gov, CTIS and ISRCTN for melanoma trials. Return two from each registry, with recruitment status and source links.

You can then ask:

> Find melanoma treatment trials that are currently recruiting across all three registries.

> Show the original registry data for one of those trials.

> Search my saved records for trials in Italy.

## How it works

1. **You ask a question.** Your assistant sends a search to the local server. Searches use registered condition fields by default; you can ask for a broader keyword search.
2. **The server checks the registries.** It returns trial details, source links and available recruitment information. If a source fails, it tells you.
3. **Records are saved on your computer.** You can inspect the original data or search saved records later. Saved records are not refreshed automatically.

The server runs on your computer and contacts the registries when you request a live search. Records are stored in `.data/trials.sqlite`. Your AI application's own data handling still applies to your chats and tool results.

## Explore drugs and targets

Try:

> Build an ongoing clinical target landscape for cystic fibrosis across all three registries. Wait for the job to finish, show the drugs, targets, trial phases and unresolved interventions, and export CSV and JSON.

A **target landscape** is an overview of drugs and their known biological targets in trials for a disease. The server uses ChEMBL to identify drugs and retrieve curated mechanisms, with additional annotations from Open Targets. It keeps the supporting trial records, references and uncertainties alongside the results.

These jobs may take longer than a search. Your assistant receives a job ID and can check progress or resume interrupted work. Keep the local server running until the job finishes.

Cystic fibrosis has additional reviewed mappings and disease-scope checks. Changes to a reviewed trial's protocol or population trigger another review before its mapping can be reused. This is a developer-validated pilot; a known drug target does not by itself prove an active clinical target program.

See the [landscape guide](docs/clinical-target-landscape.md) for collection limits, evidence rules, reviewed mappings and exports.

## What to know about the results

- **Searches return a limited set of records.** Live search defaults to five per registry, with up to 20 per registry on request. Fewer matches may reflect a search limit. Landscapes have separate collection limits.
- **The same trial may appear in several registries.** Ordinary search keeps those records separate, so record counts are not unique-trial counts.
- **Recruitment information needs context.** CTIS “Authorised” does not mean recruiting. ISRCTN “No longer recruiting” does not establish that a study is still ongoing; uncertain statuses are excluded from ongoing landscapes.
- **Saved results are a local collection.** They can differ from a fresh live search. Check the source links and update dates when currency matters.
- **The tool does not assess patient eligibility or validate treatment claims.** Trial criteria, drug identities, roles and target evidence still need review.

CTIS access uses its public website's JSON endpoint, whose stability is not guaranteed. Access details and data reuse limits are in the [source-access matrix](docs/source-access-matrix.md).

## More ways to use it

- [Search guide](docs/search-guide.md): tools, filters, terminal commands and troubleshooting.
- [Landscape guide](docs/clinical-target-landscape.md): drug and target evidence, background jobs and exports.
- [Verification notes](docs/verification.md): checks performed and known limitations.

Contributions are welcome. To check a code change locally, run `npm test`. If a connection fails, confirm Node.js is version 24 or newer, install dependencies and regenerate the MCP settings. After updating the project, reconnect your assistant so it discovers the current tools.

## License

[MIT](LICENSE) — copyright (c) 2026 monikasekelja-main. You may use, modify and distribute the software under the license terms. Registry data and third-party dependencies have their own terms.

# Source-access matrix

Evaluated **22 October 2026**; condition-search endpoints rechecked **23 October 2026**. This distinguishes documented access, observed live behavior, and access that still needs investigation. “Public” describes visibility, not a blanket redistribution licence. Only ClinicalTrials.gov and CTIS were live-probed in this prototype.

## Prioritization

| Source | Coverage contribution | Access evidence | Authentication / bulk and updates | Reuse and operational questions | Prototype decision |
|---|---|---|---|---|---|
| **ClinicalTrials.gov** | International registrations, protocol records, and posted results | [Official API v2 documentation](https://clinicaltrials.gov/data-api/about-api); live `GET /api/v2/studies` returned JSON | No key required for tested request. Cursor pagination verified. Source update date is retained. Complete download and incremental policies need separate implementation. | Retain source links and attribution. Review [source terms](https://clinicaltrials.gov/about-site/terms-conditions) for intended distribution; rendering of terms was not sufficient here to certify a licence. No precise quota asserted. | **Implemented; live search/import passed.** |
| **CTIS** | EU/EEA human medicinal-product trials; regulatory and country information | [EMA portal description](https://euclinicaltrials.eu/about-this-website/) and [official download guidance](https://euclinicaltrials.eu/search-tips-and-guidance/?lang=en). Live portal JSON search and detail retrieval verified. | No key or cookie was needed in tested requests. Search is POST; detail is GET. No stable, supported public API contract or published quota verified. | [EMA legal notice](https://www.ema.europa.eu/en/about-us/about-website/legal-notice) distinguishes EMA-owned and third-party material; do not assume it grants unrestricted rights to sponsor documents. Confirm production automation and redistribution scope. | **Implemented as an observed portal adapter; live import passed.** |
| **EU Clinical Trials Register** | Historical European records and results outside the new prototype's CTIS corpus | EMA points users to the [legacy register](https://www.clinicaltrialsregister.eu/) for earlier records. [EMA explanation](https://euclinicaltrials.eu/about-this-website/). | Programmatic access, bulk format, refresh cadence, and limits not tested. Country records and CTIS transitions need identity rules. | Confirm permitted extraction and retention; preserve historical source identity. | Planned historical adapter; not represented by current CTIS coverage. |
| **DRKS** | German registrations, including research outside CTIS's medicinal-product focus | [BfArM manual](https://www.bfarm.de/SharedDocs/Downloads/EN/BfArM/DRKS/drks-help-application-public.pdf?__blob=publicationFile) documents JSON exports and schema. [German manual](https://www.bfarm.de/SharedDocs/Downloads/DE/BfArM/DRKS/drks-hilfe-anwendung-oeffentlich.pdf?__blob=publicationFile) documents all-record JSON download. | Documented bulk JSON; not downloaded or normalized here. Manual says export data generally reflect the preceding day. Incremental access not verified. | Verify redistribution conditions and snapshot consistency before scheduling imports. | Strong next candidate for a documented bulk-import adapter. |
| **ISRCTN** | Additional international registrations | [Official help](https://beta.isrctn.com/page/help) describes CSV exports and XML API access. | API and export documentation identified; live responses, bulk limits, and incremental behavior not tested. | Confirm endpoint stability and specific data licence. | Strong next candidate after the two-source prototype. |
| **jRCT** | Japan | Listed in [WHO's primary registry network](https://www.who.int/tools/clinical-trials-registry-platform/network/primary-registries). [Official site](https://jrct.mhlw.go.jp/); [official URL migration notice](https://www.niph.go.jp/topics/attachment/rctikan202504.pdf). | Supported API/feed/export, authentication, limits, and update mechanism not verified. Use current MHLW domain. | Determine permitted machine access, language availability, and historical-network coverage. | First Asian integration investigation. |
| **ChiCTR** | China | Listed in [WHO's primary registry network](https://www.who.int/tools/clinical-trials-registry-platform/network/primary-registries). | Direct machine-readable access and terms not verified. Registry membership does not establish an API. | Assess Chinese/English records, update timestamps, direct-source rights, and bulk access with the provider. | Planned; no undocumented ingestion promise. |
| **China Drug Trials platform** | Additional Chinese drug-trial information | [Official public platform](https://www.chinadrugtrials.org.cn/index.html) supports trial search. | Programmatic or bulk access not verified. Kept separate from ChiCTR. | Confirm overlap, identifier semantics, access, and reuse terms. | Separate investigation for drug-development coverage. |
| **CTRI** | India | Listed by [WHO](https://www.who.int/tools/clinical-trials-registry-platform/network/primary-registries); [official FAQ](https://www.ctri.nic.in/Clinicaltrials/faq.php) describes public and ICTRP discovery. | API, exports, authentication for automation, and limits not verified. | Confirm direct-feed access rather than assuming ICTRP availability grants direct-source rights. | Planned access investigation. |
| **CRiS** | South Korea | Listed in [WHO's primary registry network](https://www.who.int/tools/clinical-trials-registry-platform/network/primary-registries). | Direct API/export and update route not verified. | Confirm supported access, Korean/English coverage, licensing, and identifiers. | Planned access investigation. |
| **WHO ICTRP** | Aggregated discovery across registries | [WHO access page](https://www.who.int/tools/clinical-trials-registry-platform) identifies access routes; [download guidance](https://www.who.int/tools/clinical-trials-registry-platform/network/who-data-set/downloading-records-from-the-ictrp-database) describes CSV/XML. | WHO describes weekly updates. API/service eligibility and full-update access require separate verification. No ICTRP data ingested. | Published download terms prohibit commercial use and require attribution and processing-date disclosure. Resolve intended-use permission before adopting it. Do not count aggregate copies as new trials. | Excluded from this prototype; useful later subject to permitted use. |

## Exact access verified for the implemented sources

### ClinicalTrials.gov

```http
GET https://clinicaltrials.gov/api/v2/studies?format=json&countTotal=true&pageSize=2&sort=LastUpdatePostDate%3Adesc&query.term=AREA%5BCondition%5D%22melanoma%22
Accept: application/json
```

Observed HTTP 200 and a JSON object containing `studies`, `totalCount`, and `nextPageToken`. The adapter follows the opaque token until it reaches its explicit import bound or the source is exhausted. Tests also cover repeating tokens and malformed envelopes.

Condition mode is the default: plain condition text becomes `AREA[Condition]"<condition>"` in `query.term`, with multiword names kept as one phrase. This excludes hits found only in other fields. Explicit keyword mode sends the supplied text or registry expression directly as `query.term`. No client-side removal changes the source's reported total.

Normalized inputs: NCT ID, title, condition and intervention text, lead sponsor, phase labels, countries from sites, explicit overall recruitment status, result availability, and last posted update date. The original full response record is retained. No enrollment-sentinel exclusion changes the requested source cohort.

### CTIS

```http
POST https://euclinicaltrials.eu/ctis-public-api/search
Accept: application/json
Content-Type: application/json

{
  "pagination": { "page": 1, "size": 2 },
  "sort": { "property": "decisionDate", "direction": "DESC" },
  "searchCriteria": { "medicalCondition": "melanoma" }
}
```

Observed HTTP 200 with `data[]` and `pagination.{totalRecords,currentPage,totalPages,nextPage,prevPage}`. This differs from some third-party descriptions of the response; the adapter is based on the live `data` envelope. It keeps page size fixed while advancing page number.

Condition mode uses `medicalCondition`. Explicit keyword mode uses `containAny`. Both were live-probed; their totals differ because they search different fields. CTIS applies its own matching semantics, so its condition search is not assumed identical to the ClinicalTrials.gov phrase search.

```http
GET https://euclinicaltrials.eu/ctis-public-api/retrieve/2025-524405-33-00
Accept: application/json
```

Observed HTTP 200 with `ctNumber`, `ctStatus`, `authorizedApplication.authorizedPartI`, country-specific `authorizedPartsII`, and other trial information. The importer requires a returned trial ID and rejects an empty detail object. Both search row and detail are retained as source evidence. No authentication workaround or browser impersonation is used.

Normalized inputs include title, conditions, products, sponsor, country names, source phase text, regulatory status, country regulatory status and recruitment-start flags, source update date, and explicit NCT references. `Authorised` and numeric status suffixes are **not** mapped to recruiting. Full recruitment-event interpretation and numeric code-list mappings need a separate validated implementation.

### Refresh and failure policy

This prototype imports selected samples. It does not claim that `decisionDate` order is an incremental update feed; this is particularly important for amendments to older CTIS trials. Every import records query, search mode, exact source criteria, limit, truncation, upstream total, and success/failure. Existing data remain available after failures. Older imports retain the scope metadata captured when they ran; changing the default does not reclassify saved records.

The provisional rate is one outbound request per second per source per process. This is an implementation choice, not evidence of a published rate limit. A deployed shared service needs coordinated limits across workers. Production access confirmation, complete synchronization, and freshness targets remain next steps.

## Acceptance and next checks

Completed: live reads from both sources; bounded two-source import; source-specific validation; raw version retention; local common search; disclosed source counts, freshness, and partial failures; automated regression tests.

MCP is now available over one stdio server: live search of both registries, cached search, imported-record retrieval, and source diagnostics. This transport does not change either source's access status or reuse limitations. See the [connection guide](../README.md#set-up) and [MCP verification](verification.md#mcp-verification).

Before treating either source as a production mirror: document intended-use permissions, agreed or supported automation, source update semantics, import checkpoints, completeness reconciliation, removals, and the acceptable maximum data age. For CTIS, request a supported feed/API contract if available; keep the portal endpoint isolated so it can be replaced.

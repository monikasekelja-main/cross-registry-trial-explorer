import { JsonClient, SourceError } from './http-client.mjs';

export const SOURCES = ['ctgov', 'ctis'];
export const NORMALIZER_VERSION = '2';
export const SOURCE_INFO = {
  ctgov: {
    name: 'ClinicalTrials.gov', access: 'Documented public API v2',
    documentation: 'https://clinicaltrials.gov/data-api/about-api',
    terms: 'https://clinicaltrials.gov/about-site/terms-conditions',
  },
  ctis: {
    name: 'EU CTIS', access: 'Observed public-portal JSON endpoint; no stable API contract verified',
    documentation: 'https://euclinicaltrials.eu/about-this-website/',
    terms: 'https://www.ema.europa.eu/en/about-us/about-website/legal-notice',
  },
};

export function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SourceError(`Invalid ${label}: expected object`);
  return value;
}
function array(value, label) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new SourceError(`Invalid ${label}: expected array`);
  return value;
}
function text(value) { return typeof value === 'string' && value.trim() ? value.trim() : null; }
function strings(values, label) {
  return [...new Set(array(values, label).map(value => {
    if (typeof value !== 'string') throw new SourceError(`Invalid ${label}: expected strings`);
    return value.trim();
  }).filter(Boolean))];
}
function requiredText(value, label) {
  const result = text(value);
  if (!result) throw new SourceError(`Missing ${label}`);
  return result;
}
function isoDay(value) {
  const day = text(value);
  if (!day) return null;
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(day);
  return match ? `${match[3]}-${match[2]}-${match[1]}` : day;
}
const recruitment = {
  RECRUITING: 'recruiting', NOT_YET_RECRUITING: 'not_yet_recruiting',
  ACTIVE_NOT_RECRUITING: 'active_not_recruiting', COMPLETED: 'completed',
  TERMINATED: 'terminated', WITHDRAWN: 'withdrawn', SUSPENDED: 'suspended',
  ENROLLING_BY_INVITATION: 'by_invitation',
};
export function validateId(source, id) {
  if (!SOURCES.includes(source)) throw new Error('Source must be ctgov or ctis');
  if (!(source === 'ctgov' ? /^NCT\d{8}$/ : /^\d{4}-\d{6}-\d{2}-\d{2}$/).test(id)) {
    throw new Error(`Invalid ${source} identifier`);
  }
  return id;
}

export function normalizeCtgov(raw, retrievedAt = new Date().toISOString()) {
  object(raw, 'ClinicalTrials.gov record');
  const p = object(raw.protocolSection, 'protocolSection');
  const ids = object(p.identificationModule, 'identificationModule');
  const sourceId = validateId('ctgov', requiredText(ids.nctId, 'NCT ID'));
  const statusRaw = text(p.statusModule?.overallStatus);
  const sites = array(p.contactsLocationsModule?.locations, 'locations');
  return {
    source: 'ctgov', sourceId, title: requiredText(ids.briefTitle, 'briefTitle'),
    conditions: strings(p.conditionsModule?.conditions, 'conditions'),
    interventions: array(p.armsInterventionsModule?.interventions, 'interventions').map(x => text(x?.name)).filter(Boolean),
    sponsor: text(p.sponsorCollaboratorsModule?.leadSponsor?.name),
    countries: [...new Set(sites.map(x => text(x?.country)).filter(Boolean))],
    phases: strings(p.designModule?.phases, 'phases'),
    recruitmentStatus: recruitment[statusRaw] ?? 'unknown',
    regulatoryStatus: null, statusRaw,
    countryStatuses: [],
    hasResults: typeof raw.hasResults === 'boolean' ? raw.hasResults : null,
    sourceUpdatedAt: text(p.statusModule?.lastUpdatePostDateStruct?.date),
    retrievedAt, sourceUrl: `https://clinicaltrials.gov/study/${sourceId}`,
    identifiers: [{ registry: 'ctgov', value: sourceId }, ...array(ids.secondaryIdInfos, 'secondaryIdInfos')
      .map(x => text(x?.id)).filter(Boolean).map(value => ({ registry: /^NCT\d{8}$/.test(value) ? 'ctgov' : /^\d{4}-\d{6}-\d{2}-\d{2}$/.test(value) ? 'ctis' : 'unspecified', value }))],
    normalizerVersion: NORMALIZER_VERSION,
  };
}

export function normalizeCtis(detail, summary = {}, retrievedAt = new Date().toISOString()) {
  object(detail, 'CTIS record'); object(summary, 'CTIS search row');
  const sourceId = validateId('ctis', requiredText(detail.ctNumber, 'CTIS number'));
  if (summary.ctNumber && summary.ctNumber !== sourceId) throw new SourceError('CTIS detail/search ID mismatch');
  const app = detail.authorizedApplication ?? {};
  const part = app.authorizedPartI ?? {};
  const identifiers = part.trialDetails?.clinicalTrialIdentifiers ?? {};
  const countryStatuses = array(app.authorizedPartsII, 'authorizedPartsII').map(x => ({
    country: text(x?.mscInfo?.countryName),
    regulatoryStatus: text(x?.mscInfo?.reportingStatusCode),
    trialStatusRaw: text(x?.mscInfo?.trialStatus),
    hasRecruitmentStarted: typeof x?.mscInfo?.hasRecruitmentStarted === 'boolean' ? x.mscInfo.hasRecruitmentStarted : null,
  }));
  const countries = countryStatuses.map(x => x.country).filter(Boolean);
  // Portal country suffixes are regulatory codes, never recruitment statuses.
  const summaryCountries = strings(summary.trialCountries, 'trialCountries').map(x => x.replace(/:\d+$/, ''));
  const detailedConditions = array(part.medicalConditions, 'medicalConditions').map(x => text(x?.medicalCondition)).filter(Boolean);
  const resultRaw = text(summary.resultsFirstReceived);
  return {
    source: 'ctis', sourceId,
    title: requiredText(identifiers.publicTitle ?? identifiers.fullTitle ?? summary.ctTitle, 'CTIS title'),
    conditions: detailedConditions.length ? detailedConditions : [text(summary.conditions)].filter(Boolean),
    interventions: array(part.products, 'products').map(x => text(x?.productName)).filter(Boolean),
    sponsor: text(array(part.sponsors, 'sponsors').find(x => x?.primary)?.organisation?.name) ?? text(summary.sponsor),
    countries: [...new Set([...countries, ...summaryCountries])],
    // Preserve CTIS's own phase language; no inferred numeric code mappings.
    phases: [text(summary.trialPhase)].filter(Boolean),
    recruitmentStatus: 'unknown', regulatoryStatus: text(detail.ctStatus),
    statusRaw: text(detail.ctStatus), countryStatuses,
    hasResults: resultRaw === 'Yes' ? true : resultRaw === 'No' ? false : null,
    sourceUpdatedAt: isoDay(summary.lastUpdated),
    publishedAtRaw: text(detail.publishDate),
    retrievedAt, sourceUrl: `https://euclinicaltrials.eu/search-for-clinical-trials/?lang=en&EUCT=${sourceId}`,
    identifiers: [{ registry: 'ctis', value: sourceId },
      ...(/^NCT\d{8}$/.test(identifiers.secondaryIdentifyingNumbers?.nctNumber?.number ?? '')
        ? [{ registry: 'ctgov', value: identifiers.secondaryIdentifyingNumbers.nctNumber.number }] : [])],
    normalizerVersion: NORMALIZER_VERSION,
  };
}

export function createAdapters({ clients = {} } = {}) {
  const ctgov = clients.ctgov ?? new JsonClient();
  const ctis = clients.ctis ?? new JsonClient();
  return {
    ctgov: {
      async collect({ query = '', limit = 10, signal }) {
        const records = []; const seen = new Set(); const tokens = new Set(); let token; let upstreamTotal = null;
        do {
          const url = new URL('https://clinicaltrials.gov/api/v2/studies');
          url.searchParams.set('format', 'json'); url.searchParams.set('countTotal', 'true');
          url.searchParams.set('pageSize', String(Math.min(100, limit - records.length)));
          url.searchParams.set('sort', 'LastUpdatePostDate:desc');
          if (query) url.searchParams.set('query.term', query);
          if (token) url.searchParams.set('pageToken', token);
          const page = object(await ctgov.json(url, { signal }), 'ClinicalTrials.gov page');
          if (!Array.isArray(page.studies)) throw new SourceError('ClinicalTrials.gov page is missing studies');
          if (page.totalCount !== undefined) {
            if (!Number.isSafeInteger(page.totalCount) || page.totalCount < 0) throw new SourceError('Invalid ClinicalTrials.gov totalCount');
            upstreamTotal = page.totalCount;
          }
          for (const raw of page.studies) {
            const trial = normalizeCtgov(raw);
            if (!seen.has(trial.sourceId)) { seen.add(trial.sourceId); records.push({ trial, raw }); }
          }
          if (page.nextPageToken != null && typeof page.nextPageToken !== 'string') throw new SourceError('Invalid nextPageToken');
          const next = page.nextPageToken;
          if (next && tokens.has(next)) throw new SourceError('ClinicalTrials.gov repeated pagination token');
          if (next) tokens.add(next);
          if (next && page.studies.length === 0) throw new SourceError('ClinicalTrials.gov returned an empty continuation page');
          token = next;
          if (records.length >= limit || !token) return { records: records.slice(0, limit), upstreamTotal, truncated: Boolean(token) || records.length > limit };
        } while (true);
      },
    },
    ctis: {
      async collect({ query = '', limit = 10, signal }) {
        const records = []; const seen = new Set(); let pageNumber = 1;
        do {
          const page = object(await ctis.json('https://euclinicaltrials.eu/ctis-public-api/search', {
            signal, method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pagination: { page: pageNumber, size: Math.min(100, limit) },
              sort: { property: 'decisionDate', direction: 'DESC' }, searchCriteria: { containAny: query || null } }),
          }), 'CTIS search page');
          if (!Array.isArray(page.data)) throw new SourceError('CTIS search page is missing data');
          const pagination = object(page.pagination, 'CTIS pagination');
          if (typeof pagination.nextPage !== 'boolean') throw new SourceError('Invalid CTIS nextPage');
          if (!Number.isSafeInteger(pagination.totalRecords) || pagination.totalRecords < 0) throw new SourceError('Invalid CTIS totalRecords');
          let added = 0;
          for (const summary of page.data) {
            object(summary, 'CTIS search row');
            const id = validateId('ctis', requiredText(summary.ctNumber, 'CTIS number'));
            if (seen.has(id)) continue;
            const detail = object(await ctis.json(`https://euclinicaltrials.eu/ctis-public-api/retrieve/${id}`, { signal }), 'CTIS detail');
            if (!detail.ctNumber) throw new SourceError('CTIS returned an empty or missing trial detail');
            const trial = normalizeCtis(detail, summary);
            seen.add(id); added++; records.push({ trial, raw: { detail, summary } });
            if (records.length >= limit) break;
          }
          if (pagination.nextPage && !added) throw new SourceError('CTIS pagination made no progress');
          if (records.length >= limit || !pagination.nextPage) return {
            records, upstreamTotal: pagination.totalRecords ?? null,
            truncated: pagination.nextPage || page.data.length > added,
          };
          pageNumber++;
        } while (true);
      },
    },
  };
}

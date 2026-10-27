import { JsonClient, SourceError } from './http-client.mjs';

export const SOURCES = ['ctgov', 'ctis', 'isrctn'];
export const NORMALIZER_VERSION = '4';
export const RECRUITMENT_STATUSES = ['unknown','recruiting','not_yet_recruiting','active_not_recruiting','completed','terminated','withdrawn','suspended','by_invitation'];
export const STUDY_TYPES = ['interventional', 'observational', 'expanded_access'];
export function validateFilters({ recruitmentStatus, studyType, primaryPurpose } = {}) {
  if (recruitmentStatus !== undefined && !RECRUITMENT_STATUSES.includes(recruitmentStatus)) throw new Error('Invalid recruitmentStatus');
  if (studyType !== undefined && !STUDY_TYPES.includes(studyType)) throw new Error('Invalid studyType');
  if (primaryPurpose !== undefined && primaryPurpose !== 'treatment') throw new Error('Invalid primaryPurpose; supported value is treatment');
  if (primaryPurpose && studyType && studyType !== 'interventional') throw new Error('Treatment requires interventional studyType');
}
export function matchesFilters(trial, filters = {}) {
  if (filters.primaryPurpose && trial.studyType !== 'interventional') return false;
  return ['recruitmentStatus', 'studyType', 'primaryPurpose'].every(key => filters[key] === undefined || trial[key] === filters[key]);
}
const ctisRecruitment = { 2: 'not_yet_recruiting', 3: 'recruiting', 4: 'recruiting', 5: 'active_not_recruiting', 6: 'suspended', 7: 'suspended', 8: 'completed' };
const ctisStatusFilters = { recruiting: [3,4], not_yet_recruiting: [2], active_not_recruiting: [5], suspended: [6,7], completed: [8] };

export function buildSearchCriteria(source, query = '', searchMode = 'condition', filters = {}) {
  validateFilters(filters);
  if (!SOURCES.includes(source)) throw new Error('Source must be ctgov, ctis or isrctn');
  if (!['condition', 'keyword'].includes(searchMode)) throw new Error('searchMode must be condition or keyword');
  if (typeof query !== 'string' || query.length > 500) throw new Error('query must be at most 500 characters');
  query = query.trim();

  if (searchMode === 'condition' && query.includes('"')) {
    throw new Error('Condition search takes plain condition text without double quotes. Use searchMode="keyword" for registry query expressions.');
  }
  if (source === 'ctgov') {
    const terms = query ? [searchMode === 'condition' ? `AREA[Condition]"${query}"` : (filters.studyType || filters.primaryPurpose ? `(${query})` : query)] : [];
    if (filters.studyType || filters.primaryPurpose) terms.push(`AREA[StudyType]${(filters.studyType ?? 'interventional').toUpperCase()}`);
    if (filters.primaryPurpose) terms.push('AREA[DesignPrimaryPurpose]TREATMENT');
    return { ...(terms.length ? { 'query.term': terms.join(' AND ') } : {}),
      ...(filters.recruitmentStatus && filters.recruitmentStatus !== 'unknown' ? { 'filter.overallStatus': Object.entries(recruitment).find(([,v]) => v === filters.recruitmentStatus)?.[0] } : {}) };
  }
  if (source === 'isrctn') return query ? { q: searchMode === 'condition' ? `condition:"${query}"` : query } : {};
  return { ...(query ? { [searchMode === 'condition' ? 'medicalCondition' : 'containAny']: query } : {}), ...(ctisStatusFilters[filters.recruitmentStatus] ? { status: ctisStatusFilters[filters.recruitmentStatus] } : {}) };
}
export const SOURCE_INFO = {
  isrctn: {
    name: 'ISRCTN', access: 'Documented public XML API (draft v0.6)',
    documentation: 'https://www.isrctn.com/page/help',
    terms: 'https://www.isrctn.com/page/terms',
  },
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
  if (!SOURCES.includes(source)) throw new Error('Source must be ctgov, ctis or isrctn');
  if (!(source === 'ctgov' ? /^NCT\d{8}$/ : source === 'isrctn' ? /^ISRCTN\d{8}$/ : /^\d{4}-\d{6}-\d{2}-\d{2}$/).test(id)) {
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
    studyType: text(p.designModule?.studyType)?.toLowerCase() ?? 'unknown',
    primaryPurpose: text(p.designModule?.designInfo?.primaryPurpose)?.toLowerCase() ?? 'unknown',
    recruitmentStatus: recruitment[statusRaw] ?? 'unknown',
    recruitmentStatusBasis: 'ClinicalTrials.gov overallStatus',
    regulatoryStatus: null, statusRaw,
    countryStatuses: [],
    hasResults: typeof raw.hasResults === 'boolean' ? raw.hasResults : null,
    sourceUpdatedAt: text(p.statusModule?.lastUpdatePostDateStruct?.date),
    retrievedAt, sourceUrl: `https://clinicaltrials.gov/study/${sourceId}`,
    identifiers: [{ registry: 'ctgov', value: sourceId }, ...array(ids.secondaryIdInfos, 'secondaryIdInfos')
      .map(x => text(x?.id)).filter(Boolean).map(value => ({ registry: /^NCT\d{8}$/.test(value) ? 'ctgov' : /^ISRCTN\d{8}$/.test(value) ? 'isrctn' : /^\d{4}-\d{6}-\d{2}-\d{2}$/.test(value) ? 'ctis' : 'unspecified', value }))],
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
  // Strip portal status suffixes for country names; recruitment uses the explicit public status code.
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
    studyType: 'interventional',
    primaryPurpose: array(part.trialDetails?.trialInformation?.trialObjective?.trialScopes, 'trialScopes').some(x => x?.code === '3') ? 'treatment' : 'unknown',
    recruitmentStatus: ctisRecruitment[detail.ctPublicStatusCode] ?? 'unknown',
    recruitmentStatusBasis: 'CTIS ctPublicStatusCode; recruiting means at least one country, not every site',
    regulatoryStatus: text(detail.ctStatus),
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

// XML collections may contain a single object, multiple objects, or an empty element.
function xmlList(value) { return value === undefined || value === '' ? [] : Array.isArray(value) ? value : [value]; }
function xmlText(value) { return text(typeof value === 'object' && value ? value['#text'] : value); }

export function normalizeIsrctn(raw, retrievedAt = new Date().toISOString()) {
  object(raw, 'ISRCTN fullTrial');
  const trial = object(raw.trial, 'ISRCTN trial');
  const sourceId = validateId('isrctn', requiredText(trial['@_publicIdentifierCanonical'], 'ISRCTN ID'));
  const interventions = xmlList(trial.interventions?.intervention);
  const statusRaw = xmlText(raw.who?.main?.recruitment_status) ?? xmlText(trial.participants?.recruitmentStatusOverride);
  const identifiers = [{ registry: 'isrctn', value: sourceId }];
  for (const entry of xmlList(trial.externalRefs?.secondaryNumbers?.secondaryNumber)) {
    const value = xmlText(entry);
    if (value) identifiers.push({ registry: /^NCT\d{8}$/.test(value) ? 'ctgov' : /^ISRCTN\d{8}$/.test(value) ? 'isrctn' : /^\d{4}-\d{6}-\d{2}-\d{2}$/.test(value) ? 'ctis' : 'unspecified', value });
  }
  const nct = xmlText(trial.externalRefs?.clinicalTrialsGovNumber);
  if (/^NCT\d{8}$/.test(nct ?? '') && !identifiers.some(x => x.value === nct)) identifiers.push({ registry: 'ctgov', value: nct });
  return {
    source: 'isrctn', sourceId,
    title: requiredText(xmlText(trial.trialDescription?.title), 'ISRCTN title'),
    conditions: xmlList(trial.conditions?.condition).map(x => xmlText(x.description)).filter(Boolean),
    interventions: interventions.map(x => xmlText(x.drugNames) ?? xmlText(x.description)).filter(Boolean),
    sponsor: xmlList(raw.sponsor).map(x => xmlText(x.organisation)).filter(Boolean).join('; ') || null,
    countries: xmlList(trial.participants?.recruitmentCountries?.country).map(xmlText).filter(Boolean),
    phases: [...new Set(interventions.map(x => xmlText(x.phase)).filter(Boolean))],
    studyType: xmlText(trial.trialDesign?.primaryStudyDesign)?.toLowerCase() ?? 'unknown',
    primaryPurpose: [...xmlList(trial.trialDesign?.interventionalTrialDesign?.purposes?.purpose), ...xmlList(trial.trialDesign?.trialTypes?.trialType)].some(x => xmlText(x)?.toLowerCase() === 'treatment') ? 'treatment' : 'unknown',
    recruitmentStatusBasis: raw.who ? 'ISRCTN WHO export recruitment_status (registry may derive it from dates)' : 'ISRCTN explicit override; otherwise unknown',
    // Use the registry's published status rather than computing it from dates locally.
    recruitmentStatus: ({ Recruiting: 'recruiting', 'Not yet recruiting': 'not_yet_recruiting',
      'No longer recruiting': 'active_not_recruiting', 'No longer recruited': 'active_not_recruiting', Stopped: 'terminated', Suspended: 'suspended', Completed: 'completed', 'Enrolling by invitation': 'by_invitation' })[statusRaw] ?? 'unknown',
    statusRaw, regulatoryStatus: null, countryStatuses: [],
    hasResults: xmlList(trial.outputs?.output).some(x => ['basicresults', 'plainenglishresults', 'results'].includes(x['@_outputType'])) ? true : null,
    sourceUpdatedAt: text(trial['@_lastUpdated']), retrievedAt,
    sourceUrl: `https://www.isrctn.com/${sourceId}`, identifiers, normalizerVersion: NORMALIZER_VERSION,
  };
}

export function createAdapters({ clients = {} } = {}) {
  const isrctn = clients.isrctn ?? new JsonClient();
  const ctgov = clients.ctgov ?? new JsonClient();
  const ctis = clients.ctis ?? new JsonClient();
  return {
    isrctn: {
      async collect({ query = '', searchMode = 'condition', limit = 10, signal, includeRecruitment = false, ...filters }) {
        const url = new URL('https://www.isrctn.com/api/query/format/default');
        for (const [key, value] of Object.entries(buildSearchCriteria('isrctn', query, searchMode, filters))) url.searchParams.set(key, value);
        const filtered = Object.values(filters).some(x => x !== undefined);
        const scanLimit = filtered ? Math.max(limit, 100) : limit;
        url.searchParams.set('limit', String(scanLimit));
        const page = object((await isrctn.xml(url, { signal })).allTrials, 'ISRCTN allTrials');
        const count = page['@_totalCount'];
        if (typeof count !== 'string' || !/^\d+$/.test(count) || !Number.isSafeInteger(Number(count))) throw new SourceError('Invalid ISRCTN totalCount');
        const rows = xmlList(page.fullTrial);
        let statuses = new Map();
        if ((filters.recruitmentStatus || includeRecruitment) && rows.length) {
          const whoUrl = new URL(url); whoUrl.pathname = '/api/query/format/who';
          const whoPage = await isrctn.xml(whoUrl, { signal });
          if (!Object.hasOwn(whoPage, 'trials')) throw new SourceError('Missing ISRCTN WHO trials');
          statuses = new Map(xmlList(whoPage.trials?.trial).map(row => [xmlText(row.main?.trial_id), row]));
          if (rows.some(row => !statuses.has(row.trial?.['@_publicIdentifierCanonical']))) throw new SourceError('ISRCTN default/WHO export mismatch; retry search');
        }
        const scanned = rows.map(row => {
          const who = statuses.get(row.trial?.['@_publicIdentifierCanonical']);
          const raw = who ? { ...row, who } : row;
          return { trial: normalizeIsrctn(raw), raw };
        });
        // ISRCTN also matches melanoma within 'non-melanoma'; that alone is not a melanoma condition.
        const matching = scanned.filter(({ trial }) => matchesFilters(trial, filters) &&
          !(searchMode === 'condition' && query.trim().toLowerCase() === 'melanoma' &&
            !trial.conditions.some(condition => /\bmelanoma\b/i.test(condition.replace(/\bnon[-\s]+melanoma\b/gi, '')))));
        const records = matching.slice(0, limit);
        if (new Set(records.map(x => x.trial.sourceId)).size !== records.length) throw new SourceError('ISRCTN returned duplicate identifiers');
        const upstreamTotal = Number(count);
        if (upstreamTotal < rows.length || (upstreamTotal > 0 && !rows.length)) throw new SourceError('Inconsistent ISRCTN result count');
        return { records, upstreamTotal, truncated: upstreamTotal > rows.length || matching.length > records.length, scanned: rows.length, filterCoverage: filtered ? 'bounded_scan' : 'upstream', upstreamTotalScope: 'source query before local filters; approximate' };
      },
    },
    ctgov: {
      async collect({ query = '', searchMode = 'condition', limit = 10, signal, allRecords = false, ...filters }) {
        const searchCriteria = buildSearchCriteria('ctgov', query, searchMode, filters);
        const records = []; const seen = new Set(); const tokens = new Set(); let token; let upstreamTotal = null; let scanned = 0;
        const resultLimit = allRecords ? Infinity : limit;
        const scanLimit = allRecords ? Infinity : filters.recruitmentStatus === 'unknown' ? Math.max(limit, 100) : limit;
        const totals = new Set();
        do {
          const url = new URL('https://clinicaltrials.gov/api/v2/studies');
          url.searchParams.set('format', 'json'); url.searchParams.set('countTotal', 'true');
          url.searchParams.set('pageSize', String(Math.min(100, scanLimit - scanned)));
          url.searchParams.set('sort', 'LastUpdatePostDate:desc');
          for (const [key, value] of Object.entries(searchCriteria)) url.searchParams.set(key, value);
          if (token) url.searchParams.set('pageToken', token);
          const page = object(await ctgov.json(url, { signal }), 'ClinicalTrials.gov page');
          if (!Array.isArray(page.studies)) throw new SourceError('ClinicalTrials.gov page is missing studies');
          if (page.totalCount !== undefined) {
            if (!Number.isSafeInteger(page.totalCount) || page.totalCount < 0) throw new SourceError('Invalid ClinicalTrials.gov totalCount');
            upstreamTotal = page.totalCount; totals.add(upstreamTotal);
          }
          for (const raw of page.studies) {
            const trial = normalizeCtgov(raw);
            if (!seen.has(trial.sourceId)) {
              seen.add(trial.sourceId); scanned++;
              if (matchesFilters(trial, filters)) records.push({ trial, raw });
            }
          }
          if (page.nextPageToken != null && typeof page.nextPageToken !== 'string') throw new SourceError('Invalid nextPageToken');
          const next = page.nextPageToken;
          if (next && tokens.has(next)) throw new SourceError('ClinicalTrials.gov repeated pagination token');
          if (next) tokens.add(next);
          if (next && page.studies.length === 0) throw new SourceError('ClinicalTrials.gov returned an empty continuation page');
          token = next;
          if (records.length >= resultLimit || scanned >= scanLimit || !token) return { records: records.slice(0, resultLimit), upstreamTotal, truncated: Boolean(token) || records.length > resultLimit, scanned, reconciled: !token && totals.size === 1 && records.length === upstreamTotal, reportedTotals: [...totals], filterCoverage: filters.recruitmentStatus === 'unknown' ? 'bounded_scan' : 'upstream', upstreamTotalScope: filters.recruitmentStatus === 'unknown' ? 'before local unknown-status filter' : 'includes requested source filters' };
        } while (true);
      },
    },
    ctis: {
      async collect({ query = '', searchMode = 'condition', limit = 10, signal, ...filters }) {
        const searchCriteria = buildSearchCriteria('ctis', query, searchMode, filters);
        const records = []; const seen = new Set(); let pageNumber = 1; let scanned = 0;
        const scanLimit = Object.values(filters).some(x => x !== undefined) ? Math.max(limit, 40) : limit;
        do {
          const page = object(await ctis.json('https://euclinicaltrials.eu/ctis-public-api/search', {
            signal, method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pagination: { page: pageNumber, size: Math.min(100, scanLimit) },
              sort: { property: 'decisionDate', direction: 'DESC' }, searchCriteria }),
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
            seen.add(id); added++; scanned++;
            if (matchesFilters(trial, filters)) records.push({ trial, raw: { detail, summary } });
            if (records.length >= limit || scanned >= scanLimit) break;
          }
          if (pagination.nextPage && !added) throw new SourceError('CTIS pagination made no progress');
          if (records.length >= limit || scanned >= scanLimit || !pagination.nextPage) return {
            records, upstreamTotal: pagination.totalRecords ?? null,
            truncated: pagination.nextPage || page.data.length > added, scanned, filterCoverage: 'bounded_scan', upstreamTotalScope: 'source query before local study-type/purpose and unsupported status filters',
          };
          pageNumber++;
        } while (true);
      },
    },
  };
}

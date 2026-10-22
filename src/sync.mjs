import { SOURCES, createAdapters } from './adapters.mjs';

export async function sync(store, { sources = SOURCES, query = '', limit = 10, signal, adapters = createAdapters(), includeRecords = false } = {}) {
  if (!Array.isArray(sources) || !sources.length || sources.some(s => !SOURCES.includes(s))) throw new Error('Sources must contain ctgov and/or ctis');
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('limit must be an integer from 1 to 1000');
  if (typeof query !== 'string' || query.length > 500) throw new Error('query must be at most 500 characters');
  const result = [];
  for (const source of [...new Set(sources)]) {
    signal?.throwIfAborted();
    const startedAt = new Date().toISOString();
    const scope = { query, limit, mode: 'bounded_sample',
      searchSemantics: source === 'ctgov' ? 'ClinicalTrials.gov query.term' : 'CTIS containAny; not equivalent to ClinicalTrials.gov relevance search' };
    try {
      const collection = await adapters[source].collect({ query, limit, signal });
      signal?.throwIfAborted();
      store.commitSource(source, collection, scope, startedAt);
      result.push({ source, status: 'ok', imported: collection.records.length, upstreamTotal: collection.upstreamTotal, truncated: collection.truncated,
        ...(includeRecords ? { records: collection.records.map(({ trial }) => trial) } : {}) });
    } catch (error) {
      store.failSource(source, scope, startedAt, error);
      signal?.throwIfAborted();
      result.push({ source, status: 'failed', error: error.message });
    }
  }
  return { status: result.every(r => r.status === 'ok') ? 'ok' : 'partial_failure', sources: result };
}

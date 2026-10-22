import { createServer } from 'node:http';
import { validateId } from './adapters.mjs';
import { QueryError } from './store.mjs';

export function createApi(store) {
  return createServer((req, res) => {
    const send = (status, value) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(JSON.stringify(value));
    };
    if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return send(405, { error: 'Read-only API' }); }
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/healthz') return send(200, { status: 'ok', revision: store.revision() });
      if (url.pathname === '/sources') return send(200, { sources: store.sourceStatus() });
      if (url.pathname === '/trials') {
        const allowed = new Set(['q','source','country','recruitmentStatus','limit','cursor']);
        for (const key of url.searchParams.keys()) {
          if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1) throw new QueryError(`Unsupported or repeated parameter: ${key}`);
        }
        return send(200, store.search(Object.fromEntries(url.searchParams)));
      }
      const match = /^\/trials\/(ctgov|ctis)\/([^/]+)(\/history)?$/.exec(url.pathname);
      if (match) {
        const [, source, id, history] = match;
        try { validateId(source, id); } catch { throw new QueryError('Invalid trial identifier'); }
        const record = store.get(source, id, { raw: true });
        if (!record) return send(404, { error: 'Record not imported; this does not establish absence from the registry' });
        return send(200, history ? { source, sourceId: id, versions: store.history(source, id) } : record);
      }
      send(404, { error: 'Route not found' });
    } catch (error) {
      send(error instanceof QueryError ? error.status : 500, { error: error instanceof QueryError ? error.message : 'Internal query error' });
    }
  });
}

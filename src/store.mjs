import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { SOURCES, SOURCE_INFO, validateFilters } from './adapters.mjs';

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
export class QueryError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
function integer(value, fallback, max) {
  if (value === undefined || value === null) return fallback;
  const n = Number(value);
  if (String(value).trim() === '' || !Number.isInteger(n) || n < 1 || n > max) throw new QueryError(`Expected an integer from 1 to ${max}`);
  return n;
}

export class Store {
  constructor(path = '.data/trials.sqlite') {
    this.path = path;
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS evidence (key TEXT NOT NULL, hash TEXT NOT NULL, retrieved_at TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(key,hash,retrieved_at));
      CREATE TABLE IF NOT EXISTS landscape_snapshots (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS landscape_jobs (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
      INSERT OR IGNORE INTO metadata VALUES ('revision',0);
      CREATE TABLE IF NOT EXISTS versions (
        source TEXT NOT NULL, source_id TEXT NOT NULL, hash TEXT NOT NULL,
        captured_at TEXT NOT NULL, normalizer_version TEXT NOT NULL, raw TEXT NOT NULL,
        PRIMARY KEY(source,source_id,hash));
      CREATE TABLE IF NOT EXISTS records (
        source TEXT NOT NULL, source_id TEXT NOT NULL, version_hash TEXT NOT NULL,
        normalized TEXT NOT NULL, PRIMARY KEY(source,source_id));
      CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(source UNINDEXED, source_id UNINDEXED, text);
      CREATE TABLE IF NOT EXISTS runs (
        id INTEGER PRIMARY KEY, source TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT NOT NULL,
        status TEXT NOT NULL, scope TEXT NOT NULL, imported INTEGER NOT NULL, error TEXT);
    `);
  }
  evidenceGet(key) {
    const row = this.db.prepare('SELECT data FROM evidence WHERE key=? ORDER BY retrieved_at DESC,rowid DESC LIMIT 1').get(key);
    return row ? JSON.parse(row.data) : null;
  }
  evidenceVersion(key, checksum, retrievedAt) {
    const row = this.db.prepare('SELECT data FROM evidence WHERE key=? AND hash=? AND retrieved_at=?').get(key, checksum, retrievedAt);
    return row ? JSON.parse(row.data) : null;
  }
  registrationVersion(source, id, checksum) {
    const row = this.db.prepare('SELECT * FROM versions WHERE source=? AND source_id=? AND hash=?').get(source, id, checksum);
    return row ? { source, sourceId: id, versionHash: checksum, retrievedAt: row.captured_at, normalizerVersion: row.normalizer_version, raw: JSON.parse(row.raw) } : null;
  }
  evidencePut(key, value) {
    const evidence = { ...value, key, hash: hash(value.raw) };
    this.db.prepare('INSERT OR REPLACE INTO evidence VALUES (?,?,?,?)').run(key, evidence.hash, evidence.retrievedAt, JSON.stringify(evidence));
    return evidence;
  }
  saveLandscape(job) { this.db.prepare('INSERT INTO landscape_jobs VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(job.id, JSON.stringify(job)); }
  claimLandscape(job, expected) {
    return this.db.prepare('UPDATE landscape_jobs SET data=? WHERE id=? AND data=?').run(JSON.stringify(job), job.id, expected).changes === 1;
  }
  saveLandscapeSnapshot(job) { this.db.prepare('INSERT INTO landscape_snapshots VALUES (?,?)').run(job.snapshotId, JSON.stringify(job)); }
  loadLandscapeSnapshot(id) { const row = this.db.prepare('SELECT data FROM landscape_snapshots WHERE id=?').get(id); return row ? JSON.parse(row.data) : null; }
  loadLandscape(id) { const row = this.db.prepare('SELECT data FROM landscape_jobs WHERE id=?').get(id); return row ? JSON.parse(row.data) : null; }
  close() { this.db.close(); }
  revision() { return Number(this.db.prepare("SELECT value FROM metadata WHERE key='revision'").get().value); }

  commitSource(source, collection, scope, startedAt) {
    const now = new Date().toISOString();
    const version = this.db.prepare('INSERT OR IGNORE INTO versions VALUES (?,?,?,?,?,?)');
    const record = this.db.prepare('INSERT INTO records VALUES (?,?,?,?) ON CONFLICT(source,source_id) DO UPDATE SET version_hash=excluded.version_hash, normalized=excluded.normalized');
    const remove = this.db.prepare('DELETE FROM search_index WHERE source=? AND source_id=?');
    const index = this.db.prepare('INSERT INTO search_index VALUES (?,?,?)');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const { trial, raw } of collection.records) {
        if (trial.source !== source) throw new Error('Source mismatch in import');
        const checksum = hash({ raw, normalizerVersion: trial.normalizerVersion });
        version.run(source, trial.sourceId, checksum, trial.retrievedAt, trial.normalizerVersion, JSON.stringify(raw));
        record.run(source, trial.sourceId, checksum, JSON.stringify(trial));
        remove.run(source, trial.sourceId);
        index.run(source, trial.sourceId, [trial.title, ...trial.conditions, ...trial.interventions, trial.sponsor].filter(Boolean).join(' '));
      }
      this.db.prepare("UPDATE metadata SET value=value+1 WHERE key='revision'").run();
      this.db.prepare('INSERT INTO runs(source,started_at,finished_at,status,scope,imported) VALUES (?,?,?,?,?,?)')
        .run(source, startedAt, now, 'ok', JSON.stringify({ ...scope, scanned: collection.scanned, filterCoverage: collection.filterCoverage, upstreamTotalScope: collection.upstreamTotalScope, upstreamTotal: collection.upstreamTotal, truncated: collection.truncated }), collection.records.length);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  failSource(source, scope, startedAt, error) {
    this.db.prepare('INSERT INTO runs(source,started_at,finished_at,status,scope,imported,error) VALUES (?,?,?,?,?,?,?)')
      .run(source, startedAt, new Date().toISOString(), 'failed', JSON.stringify(scope), 0, error.message);
  }
  sourceStatus() {
    return SOURCES.map(source => {
      const lastRun = this.db.prepare('SELECT * FROM runs WHERE source=? ORDER BY id DESC LIMIT 1').get(source);
      const lastSuccess = this.db.prepare("SELECT * FROM runs WHERE source=? AND status='ok' ORDER BY id DESC LIMIT 1").get(source);
      const count = Number(this.db.prepare('SELECT count(*) AS count FROM records WHERE source=?').get(source).count);
      const format = run => run ? { startedAt: run.started_at, finishedAt: run.finished_at, status: run.status, scope: JSON.parse(run.scope), imported: run.imported, error: run.error } : null;
      return { source, ...SOURCE_INFO[source], recordCount: count, lastRun: format(lastRun), lastSuccess: format(lastSuccess),
        coverage: 'Bounded imports only; not a complete registry mirror' };
    });
  }
  get(source, id, { raw = false } = {}) {
    const row = this.db.prepare('SELECT * FROM records WHERE source=? AND source_id=?').get(source, id);
    if (!row) return null;
    const result = { ...JSON.parse(row.normalized), versionHash: row.version_hash };
    if (raw) result.raw = JSON.parse(this.db.prepare('SELECT raw FROM versions WHERE source=? AND source_id=? AND hash=?').get(source, id, row.version_hash).raw);
    return result;
  }
  history(source, id) {
    return this.db.prepare('SELECT hash,captured_at,normalizer_version FROM versions WHERE source=? AND source_id=? ORDER BY captured_at,hash').all(source, id);
  }
  search({ q = '', source, country, recruitmentStatus, studyType, primaryPurpose, limit, cursor } = {}) {
    if (typeof q !== 'string' || q.length > 500) throw new QueryError('q must be at most 500 characters');
    if (source && !SOURCES.includes(source)) throw new QueryError('Unknown source');
    if (country && (typeof country !== 'string' || country.length > 100)) throw new QueryError('Invalid country');
    if (recruitmentStatus && !['unknown','recruiting','not_yet_recruiting','active_not_recruiting','completed','terminated','withdrawn','suspended','by_invitation'].includes(recruitmentStatus)) throw new QueryError('Unknown recruitmentStatus');
    try { validateFilters({ recruitmentStatus, studyType, primaryPurpose }); } catch (error) { throw new QueryError(error.message); }
    limit = integer(limit, 20, 100);
    // One SQLite read transaction pins count, records, cursor revision, and freshness together.
    this.db.exec('BEGIN');
    try {
      const revision = this.revision();
      const signature = hash({ q, source: source ?? null, country: country ?? null, recruitmentStatus: recruitmentStatus ?? null, studyType: studyType ?? null, primaryPurpose: primaryPurpose ?? null, limit });
      let offset = 0;
      if (cursor) {
        let decoded;
        try { decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString()); }
        catch { throw new QueryError('Invalid cursor'); }
        if (!decoded || typeof decoded !== 'object' || !Number.isSafeInteger(decoded.revision) ||
          typeof decoded.signature !== 'string' || !Number.isSafeInteger(decoded.offset) || decoded.offset < 0) throw new QueryError('Invalid cursor');
        if (decoded.revision !== revision) throw new QueryError('Index changed; restart pagination', 409);
        if (decoded.signature !== signature) throw new QueryError('Cursor does not match query');
        offset = decoded.offset;
      }
      const clauses = []; const params = [];
      const tokens = q.trim().split(/\s+/u).filter(Boolean);
      if (tokens.length) {
        clauses.push('r.rowid IN (SELECT r2.rowid FROM search_index s JOIN records r2 ON r2.source=s.source AND r2.source_id=s.source_id WHERE search_index MATCH ?)');
        params.push(tokens.map(t => `"${t.replaceAll('"', '""')}"`).join(' AND '));
      }
      if (source) { clauses.push('r.source=?'); params.push(source); }
      if (country) { clauses.push("EXISTS (SELECT 1 FROM json_each(r.normalized,'$.countries') WHERE value = ? COLLATE NOCASE)"); params.push(country); }
      if (recruitmentStatus) { clauses.push("json_extract(r.normalized,'$.recruitmentStatus')=?"); params.push(recruitmentStatus); }
      for (const [key, value] of Object.entries({ studyType, primaryPurpose })) {
        if (value) { clauses.push(`json_extract(r.normalized,'$.${key}')=?`); params.push(value); }
      }
      const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
      const totalCount = Number(this.db.prepare(`SELECT count(*) AS count FROM records r${where}`).get(...params).count);
      const rows = this.db.prepare(`SELECT r.normalized,r.version_hash FROM records r${where} ORDER BY r.source,r.source_id LIMIT ? OFFSET ?`).all(...params, limit, offset);
      const nextCursor = offset + rows.length < totalCount ? Buffer.from(JSON.stringify({ revision, signature, offset: offset + rows.length })).toString('base64url') : null;
      const response = { records: rows.map(row => ({ ...JSON.parse(row.normalized), versionHash: row.version_hash })),
        totalCount, countUnit: 'source_records', revision, nextCursor, sources: this.sourceStatus(),
        notice: 'Search covers locally imported records only. Cross-registry registrations have not been deduplicated.' };
      this.db.exec('COMMIT'); return response;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
}

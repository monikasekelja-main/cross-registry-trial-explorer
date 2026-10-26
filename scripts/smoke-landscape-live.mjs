import { mkdirSync, writeFileSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
const root = new URL('../', import.meta.url);
mkdirSync(new URL('.data/', root), { recursive: true });
const client = new Client({ name: 'cf-landscape-live-check', version: '1.0.0' });
const transport = new StdioClientTransport({ command: process.execPath,
  args: [fileURLToPath(new URL('src/mcp-stdio.mjs', root)), '--db', fileURLToPath(new URL('.data/landscape-live.sqlite', root))], stderr: 'pipe' });
transport.stderr.on('data', () => {});
async function call(name, args) {
  const r = await client.callTool({ name, arguments: args }, { timeout: 150000 });
  assert.notEqual(r.isError, true, JSON.stringify(r.content)); return r.structuredContent;
}
try {
  await client.connect(transport);
  const resolution = await call('resolve_intervention', { name: 'ivacaftor' });
  assert.equal(resolution.status, 'resolved'); assert.equal(resolution.candidates[0].id, 'CHEMBL2010601');
  const targets = await call('get_drug_targets', { drugId: 'CHEMBL2010601' });
  assert.ok(targets.mechanisms.some(m => m.target?.id === 'CHEMBL4051' && m.relationship === 'direct'));
  assert.ok(targets.integratedMechanisms.some(m => m.targets.some(t => t.approvedSymbol === 'CFTR')));
  const started = await call('get_clinical_target_landscape', { disease: 'cystic fibrosis', view: 'historical', limitPerSource: 10, maxInterventions: 40 });
  console.log(JSON.stringify({ jobId: started.jobId, stage: started.progress.stage }));
  let job; let lastStage; const deadline = Date.now() + 12 * 60000;
  do {
    await setTimeout(2000); job = await call('get_landscape_job', { jobId: started.jobId, limit: 5 });
    const stage = `${job.progress.stage}:${job.progress.interventionsCompleted}`;
    if (stage !== lastStage) { console.log(JSON.stringify({ jobId: job.jobId, progress: job.progress })); lastStage = stage; }
    assert.ok(Date.now() < deadline, 'Landscape smoke timed out');
  } while (['queued','running'].includes(job.status));
  assert.ok(['complete','partial_failure'].includes(job.status), JSON.stringify(job));
  assert.equal(job.sources.length, 3); assert.ok(job.sources.every(s => s.status === 'ok'), JSON.stringify(job.sources));
  assert.ok(job.total > 0, 'Expected at least one mapped drug-mechanism row in the CF sample');
  const exported = await call('export_landscape', { jobId: job.jobId });
  const unresolved = await call('get_landscape_job', { jobId: job.jobId, section: 'unresolved', limit: 20 });
  const report = { executedAt: new Date().toISOString(), resolution, targets, job, unresolved, exported };
  writeFileSync(new URL('.data/landscape-live-report.json', root), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: job.status, summary: job.summary, sources: job.sources, exported, report: fileURLToPath(new URL('.data/landscape-live-report.json', root)) }, null, 2));
} finally { await client.close(); }

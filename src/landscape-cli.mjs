import { parseArgs } from 'node:util';
import { Store } from './store.mjs';
import { EvidenceService } from './evidence.mjs';
import { LandscapeService } from './landscape.mjs';

let store; let landscapes;
try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    ...Object.fromEntries(['db','disease','view','limitPerSource','maxInterventions','section','offset','limit'].map(name => [name,{type:'string'}])),
    refreshEvidence: { type:'boolean', default:false },
  } });
  const [command,id,otherId] = positionals;
  if (!['run','get','resume','export','compare','resolve','targets'].includes(command)) throw new Error('Usage: node src/landscape-cli.mjs run --disease "cystic fibrosis" [--view ongoing|recruiting|historical] [--limitPerSource 100] [--maxInterventions 100] [--db PATH]; or get|resume|export JOB_ID; compare FIRST_ID SECOND_ID; resolve NAME; targets CHEMBL_ID');
  store = new Store(values.db); const evidence = new EvidenceService(store); landscapes = new LandscapeService(store,{evidence});
  const controller = new AbortController();
  process.once('SIGINT', () => { controller.abort(new Error('Cancelled')); landscapes.close().catch(()=>{}); });
  process.once('SIGTERM', () => { controller.abort(new Error('Cancelled')); landscapes.close().catch(()=>{}); });
  let output;
  if (command === 'resolve') output = await evidence.resolve(id,{refresh:values.refreshEvidence,signal:controller.signal});
  else if (command === 'targets') output = await evidence.targets(id,{refresh:values.refreshEvidence,signal:controller.signal});
  else if (command === 'get') output = landscapes.get(id,{section:values.section,offset:values.offset === undefined ? 0 : Number(values.offset),limit:values.limit === undefined ? 20 : Number(values.limit)});
  else if (command === 'export') output = landscapes.export(id);
  else if (command === 'compare') output = landscapes.compare(id,otherId);
  else {
    output = command === 'resume' ? landscapes.resume(id) : landscapes.start({disease:values.disease,view:values.view,
      limitPerSource:values.limitPerSource === undefined ? 100 : Number(values.limitPerSource),maxInterventions:values.maxInterventions === undefined ? 100 : Number(values.maxInterventions),refreshEvidence:values.refreshEvidence});
    process.stderr.write(`Landscape job ${output.jobId}; checkpoints saved in ${store.path}\n`);
    await landscapes.running.get(output.jobId).promise;
    output = landscapes.get(output.jobId);
    if (output.status !== 'complete') process.exitCode = 1;
  }
  process.stdout.write(JSON.stringify(output,null,2)+'\n');
} catch (error) { process.stderr.write(error.message+'\n'); process.exitCode=1; }
finally { await landscapes?.close(); store?.close(); }

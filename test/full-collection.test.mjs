import test from 'node:test';
import assert from 'node:assert/strict';
import { createAdapters } from '../src/adapters.mjs';
import { ctgovRecord } from './fixtures.mjs';

test('all ClinicalTrials.gov records follow cursors beyond the sample limit and reconcile totals', async () => {
  let calls=0;
  const adapter=createAdapters({clients:{ctgov:{json:async url=>{
    assert.equal(url.searchParams.get('pageSize'),'100');
    const i=++calls; if(i>1)assert.equal(url.searchParams.get('pageToken'),`p${i}`);
    return {studies:[ctgovRecord(`NCT${String(i).padStart(8,'0')}`)],totalCount:3,...(i<3?{nextPageToken:`p${i+1}`}:{})};
  }}}}).ctgov;
  const result=await adapter.collect({query:'cystic fibrosis',limit:1,allRecords:true});
  assert.equal(calls,3);assert.equal(result.records.length,3);assert.equal(result.reconciled,true);assert.equal(result.truncated,false);
});
test('a changed upstream count is not reported as reconciled full coverage', async()=>{
  let call=0;
  const adapter=createAdapters({clients:{ctgov:{json:async()=>++call===1?{studies:[ctgovRecord()],totalCount:1,nextPageToken:'next'}:{studies:[ctgovRecord('NCT00000002')],totalCount:2}}}}).ctgov;
  const result=await adapter.collect({allRecords:true});assert.equal(result.reconciled,false);assert.deepEqual(result.reportedTotals,[1,2]);
});

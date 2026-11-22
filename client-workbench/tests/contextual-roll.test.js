import test from 'node:test';
import assert from 'node:assert/strict';
import {prepare,requestPath,createApi} from '../src/api.js';

test('new host responses request player rolls while legacy request serialization stays compatible',async()=>{
  const request={requestId:'id',expectedVersion:7,rulingId:'r',outcome:'check',rationale:'需要检定',ruleSource:'DM',ability:'wisdom',skill:'Perception',dc:12,mode:'normal',checkType:'ability',selected:20};
  const modern=prepare('rulings/respond',request);const legacy=prepare('rulings/resolve',request);
  assert.deepEqual(modern,legacy);assert.ok(!Object.hasOwn(modern,'selected'));
  assert.equal(requestPath('rulings/respond',{campaignId:'c'}),'/api/v1/campaigns/c/rulings/respond');
  let sent;
  const api=createApi({fetchImpl:async(path,options)=>{sent={path,options};return {ok:true,text:async()=>JSON.stringify({snapshot:{id:'c',version:8},resolution:{status:'awaiting_roll'},replayed:false})};}});
  const result=await api.request('rulings/respond',{campaignId:'c',accessToken:'fixture'},request);
  assert.equal(sent.options.method,'POST');assert.deepEqual(JSON.parse(sent.options.body),modern);assert.equal(result.resolution.status,'awaiting_roll');
});

test('optional private ruling text is sent as privateText only when present',()=>{
  const base={requestId:'id',expectedVersion:7,rulingId:'r',outcome:'narrative',rationale:'公开说明',ruleSource:'DM'};
  assert.ok(!Object.hasOwn(prepare('rulings/respond',base),'privateText'));
  assert.equal(prepare('rulings/respond',{...base,privateText:'只有你察觉'}).privateText,'只有你察觉');
  assert.equal(prepare('rulings/resolve',{...base,privateText:'只有你察觉'}).privateText,'只有你察觉');
});

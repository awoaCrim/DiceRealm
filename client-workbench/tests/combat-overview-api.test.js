import test from 'node:test';
import assert from 'node:assert/strict';
import {createApi,requestPath} from '../src/api.js';

const session={campaignId:'campaign-1',accessToken:'token',timelineId:'branch-1'};
const wait={id:'roll-1',actorId:'p1',actorName:'Lyra',kind:'roll',label:'先攻',description:'由本人确认',state:'pending',reason:''};
const view={campaignId:'campaign-1',timelineId:'branch-1',version:7,combat:null,waits:[wait]};
const apiFor=body=>createApi({fetchImpl:async()=>new Response(JSON.stringify(body),{status:200})});

test('combat overview and unit detail are authenticated GETs without action payloads',async()=>{
  const sent=[];
  const api=createApi({fetchImpl:async(url,options)=>{sent.push({url,options});return new Response(JSON.stringify(url.endsWith('/combat/overview')?view:{version:7,id:'npc/1',name:'守卫',kind:'creature',summary:'',icon:'',actorId:'',factionId:'',canControl:false,statistics:null,source:null,character:null}),{status:200});}});
  assert.equal(requestPath('combat-overview',session),'/api/v1/campaigns/campaign-1/combat/overview');
  assert.equal(requestPath('board-token',session,{entityId:'npc/1'}),'/api/v1/campaigns/campaign-1/board/tokens/npc%2F1');
  await api.request('combat-overview',session);await api.request('board-token',session,{entityId:'npc/1'});
  assert.ok(sent.every(x=>x.options.method==='GET'&&!Object.hasOwn(x.options,'body')&&x.options.headers.Authorization==='Bearer token'));
});

test('incomplete overview waits and wrong campaign identity are rejected',async()=>{
  assert.deepEqual(await apiFor(view).request('combat-overview',session),view);
  for(const invalid of [
    {...view,campaignId:'other'},{...view,version:0},{...view,timelineId:42},{...view,waits:null},
    {...view,waits:[{...wait,actorName:undefined}]},{...view,waits:[{...wait,kind:'command'}]},
    {...view,waits:[{...wait,state:'executed'}]},{...view,waits:[{...wait,reason:null}]}
  ])await assert.rejects(apiFor(invalid).request('combat-overview',session));
  for(const state of ['pending','confirmed','stale','blocked'])assert.equal((await apiFor({...view,waits:[{...wait,state}]}).request('combat-overview',session)).waits[0].state,state);
});

test('board detail rejects a mismatched entity and an unversioned response',async()=>{
  const detail={version:7,id:'unit-1',name:'守卫',kind:'creature',summary:'',icon:'',actorId:'',factionId:'',canControl:false,statistics:null,source:null,character:null};
  assert.deepEqual(await apiFor(detail).request('board-token',session,{entityId:'unit-1'}),detail);
  await assert.rejects(apiFor({...detail,id:'unit-2'}).request('board-token',session,{entityId:'unit-1'}));
  await assert.rejects(apiFor({...detail,version:undefined}).request('board-token',session,{entityId:'unit-1'}));
});

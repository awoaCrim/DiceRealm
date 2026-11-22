import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {prepare,createApi,requestPath,versioned,maximumStoryFacts} from '../src/api.js';
import {createPendingStore} from '../src/pending.js';
import {StoryReview,factChanges,paidCosts,rulingContextModel,paidChange,formatSeconds,timeCost} from '../src/activity.js';

const session={baseUrl:'http://127.0.0.1:5186',campaignId:'00000000-0000-0000-0000-000000000001',accessToken:'a'.repeat(64)};
const base=()=>({requestId:'3f2504e0-4f89-41d3-9a0c-0305e82c3301',expectedVersion:9,rulingId:'r-1',mode:'facts',
  rationale:'主持确认',ruleSource:'本场约定',contentActionId:'',outcome:'',facts:[{key:'altar.open',present:true}],hitPoints:999,roll:20});
const memory=()=>{const map=new Map();return{getItem:k=>map.get(k)||null,setItem:(k,v)=>map.set(k,v),removeItem:k=>map.delete(k)};};

test('story commands whitelist bounded fields and keep preview/commit bodies identical',()=>{
  const p=prepare('rulings/story-preview',base()),c=prepare('rulings/story',base());
  assert.deepEqual(p,c);assert.deepEqual(Object.keys(p).sort(),['contentActionId','expectedVersion','facts','mode','rationale','requestId','ruleSource','rulingId','outcome'].sort());
  assert.equal(p.hitPoints,undefined);assert.equal(p.roll,undefined);
  assert.deepEqual(prepare('rulings/story',{...base(),mode:'action',contentActionId:'a1',outcome:'failure',facts:[{key:'x',present:true}]}),
    {requestId:base().requestId,expectedVersion:9,rulingId:'r-1',mode:'action',rationale:'主持确认',ruleSource:'本场约定',contentActionId:'a1',outcome:'failure',facts:[]});
  assert.deepEqual(prepare('rulings/story',{...base(),mode:'none'}).facts,[]);
  assert.equal(prepare('rulings/story',base()).facts[0].key,'altar.open');
  assert.equal(prepare('rulings/story',{...base(),facts:[{key:'f',present:1}]}).facts[0].present,true);
  assert.throws(()=>prepare('rulings/story',{...base(),facts:new Array(maximumStoryFacts+1).fill({key:'f',present:true})}),/16/);
  assert.ok(versioned.has('rulings/story'));
  assert.throws(()=>prepare('rulings/story',{...base(),mode:'unsupported'}),/有效/);
});
test('story and activity endpoints are explicit whitelisted paths',()=>{
  assert.equal(requestPath('rulings/story-options',session,{rulingId:'r-1'}),`/api/v1/campaigns/${session.campaignId}/rulings/story-options?rulingId=r-1`);
  assert.equal(requestPath('activity',session,{after:0,through:12}),`/api/v1/campaigns/${session.campaignId}/activity?after=0&limit=50&through=12`);
  assert.equal(requestPath('activity-entry',session,{sequence:7}),`/api/v1/campaigns/${session.campaignId}/activity/7`);
  assert.throws(()=>requestPath('activity-entry',session,{sequence:0}));
  assert.throws(()=>requestPath('rulings/story-options',session,{}));
  assert.throws(()=>requestPath('activity-history',session,{}));
});
test('a lost preview never licenses a different or re-minted story payload',()=>{
  const review=new StoryReview();
  let payload=prepare('rulings/story',base());
  const revision=review.revision;review.invalidate();
  assert.equal(review.accept(revision,payload,{version:9,rulingId:'r-1',mode:'facts'}),false);
  assert.throws(()=>review.payload(9,'r-1'));
  assert.equal(review.accept(review.revision,payload,{version:8,rulingId:'r-1',mode:'facts'}),false); // stale preview version
  assert.equal(review.accept(review.revision,payload,{version:9,rulingId:'r-2',mode:'facts'}),false); // scope changed
  assert.equal(review.accept(review.revision,payload,{version:9,rulingId:'r-1',mode:'action'}),false); // mode changed
  assert.equal(review.accept(review.revision,payload,{version:9,rulingId:'r-1',mode:'facts'}),true);
  payload.facts[0].present=false;payload.rationale='篡改';
  assert.deepEqual(review.payload(9,'r-1'),prepare('rulings/story',base()));
  assert.throws(()=>review.payload(10,'r-1'));assert.throws(()=>review.payload(9,'r-2'));
  review.invalidate();assert.throws(()=>review.payload(9,'r-1'));
});
test('recorded paid costs come from server diffs only, deduplicated and direction-aware',()=>{
  const changes=[
    {actorId:'host',operation:'inventory',key:'torch',label:'游侠 · 火把',before:'3',after:'2'},
    {actorId:'host',operation:'hp',key:'',label:'游侠 · HP',before:'12',after:'9'},
    {actorId:'host',operation:'resource',key:'Second Wind',label:'游侠 · Second Wind',before:'1',after:'0'},
    {actorId:'host',operation:'inventory',key:'rope',label:'游侠 · 绳索',before:'1',after:'2'},
    {actorId:'host',operation:'conditions',key:'',label:'游侠 · 状态',before:'',after:'中毒'}];
  const entry={sequence:12,legacy:false,origin:{input:'观察祭坛',label:'观察',requestedKind:'observe',target:'',actorName:'游侠',sceneId:'s1',sceneTitle:'祭坛',elapsedSecondsBefore:3600,elapsedSecondsAfter:5400,changes},
    initialResult:{check:{ability:'wisdom',skill:'Perception',rolls:[14],modifier:5,total:19,dc:15,success:true,hasDc:true}},
    ruling:{id:'r-1',originSequence:12,effects:[{operation:'exhaustion',key:'',label:'游侠 · Exhaustion',before:'0',after:'1'},
      {operation:'inventory',key:'torch',label:'游侠 · 火把',before:'3',after:'2'}]}};
  const costs=paidCosts(entry,entry.ruling);
  assert.deepEqual(costs.map(c=>c.key),['torch','','Second Wind','']);assert.deepEqual(costs.map(c=>c.source),['原行动','原行动','原行动','裁定记录']);
  assert.equal(paidChange('inventory','1','2'),false);assert.equal(paidChange('exhaustion','0','1'),true);assert.equal(paidChange('conditions','','中毒'),false);
  const model=rulingContextModel(entry,entry.ruling);
  assert.equal(model.legacy,false);assert.equal(model.input,'观察祭坛');assert.equal(model.sceneTitle,'祭坛');assert.equal(model.check.total,19);
  assert.deepEqual(model.timeCost,{before:3600,after:5400,seconds:1800},'authoritative elapsed seconds surface as a time cost');
  assert.deepEqual(timeCost({elapsedSecondsBefore:3600,elapsedSecondsAfter:5400}),{before:3600,after:5400,seconds:1800});
  assert.equal(timeCost({elapsedSecondsBefore:600,elapsedSecondsAfter:600}),null);
  assert.equal(timeCost({elapsedSecondsBefore:600}),null);
  assert.equal(timeCost({}),null);
  assert.equal(timeCost(null),null);
  assert.equal(formatSeconds(5400),'1 小时 30 分');assert.equal(formatSeconds(1800),'30 分');assert.equal(formatSeconds(45),'45 秒');assert.equal(formatSeconds(0),'0 秒');
  assert.equal(rulingContextModel({origin:{...entry.origin,elapsedSecondsAfter:3600}},entry.ruling).timeCost,null,'equal seconds are not shown as a cost');
  assert.equal(rulingContextModel({origin:{...entry.origin,elapsedSecondsBefore:undefined,elapsedSecondsAfter:undefined}},entry.ruling).timeCost,null,'a missing pair is never invented');
  const legacy=rulingContextModel(null,{originSequence:0,actorId:'guest',sceneId:'s2'});
  assert.equal(legacy.legacy,true);assert.equal(legacy.sequence,0);assert.equal(legacy.actorName,'guest');assert.deepEqual(legacy.costs,[]);assert.equal(legacy.timeCost,null);
});
test('facts submit only the differences',()=>{
  const facts=[{key:'altar.open',present:true},{key:'guard.calm',present:false},{key:'gate.open',present:false}];
  assert.deepEqual(factChanges(facts,new Set(['altar.open','guard.calm'])),[{key:'guard.calm',present:true}]);
  assert.deepEqual(factChanges(facts,new Set()),[{key:'altar.open',present:false}]);
  assert.deepEqual(factChanges(facts,new Set(['altar.open'])),[]);
});
test('workbench reads real activity/story contracts and refuses malformed or guest-only data',async()=>{
  const page={campaignId:session.campaignId,version:9,through:9,after:0,nextAfter:5,hasMore:true,entries:[]};
  let request;
  const api=createApi({fetchImpl:async(url,init)=>{request={url,...init};return new Response(JSON.stringify(page));}});
  assert.deepEqual(await api.request('activity',session,{after:0,through:9}),page);
  assert.equal(request.method,'GET');assert.ok(request.url.endsWith('/activity?after=0&limit=50&through=9'));
  await assert.rejects(createApi({fetchImpl:async()=>new Response(JSON.stringify({...page,entries:null}))}).request('activity',session,{after:0}),e=>e.unconfirmed);
  const entry={sequence:5,version:9,actorId:'host',createdAt:'2025-01-01T00:00:00+00:00',kind:'observe',status:'awaiting_ruling',legacy:false,origin:null,initialResult:null,narrative:'',narrativeSource:'',ruling:null};
  assert.equal((await createApi({fetchImpl:async()=>new Response(JSON.stringify(entry))}).request('activity-entry',session,{sequence:5})).sequence,5);
  const preview={version:9,rulingId:'r-1',mode:'facts',actionLabel:'确认剧情事实',resultText:'已确认',changes:[],warnings:['预览只对当前版本有效。']};
  await assert.rejects(createApi({fetchImpl:async()=>new Response(JSON.stringify({...preview,warnings:null}))}).request('rulings/story-preview',session,base()),e=>e.unconfirmed);
  let posted;
  assert.deepEqual(await createApi({fetchImpl:async(url,init)=>{posted=JSON.parse(init.body);return new Response(JSON.stringify(preview));}}).request('rulings/story-preview',session,base()),preview);
  assert.equal(posted.rationale,'主持确认');assert.equal(posted.hitPoints,undefined);
  await assert.rejects(createApi({fetchImpl:async()=>new Response(JSON.stringify({code:'unauthorized',message:'需要队长席位。'}),{status:403})}).request('rulings/story-options',session,{rulingId:'r-1'}),e=>e.unconfirmed===false&&e.code==='unauthorized');
  const response={snapshot:{id:session.campaignId,version:10},resolution:{status:'resolved'}};
  assert.deepEqual(await createApi({fetchImpl:async()=>new Response(JSON.stringify(response))}).request('rulings/story',session,base()),response);
});
test('story settlement survives a lost response with one durable exact payload',async()=>{
  const storage=memory();const pending=await createPendingStore({storage,session,cryptoObj:webcrypto});
  const payload=prepare('rulings/story',base());pending.capture('rulings/story',payload);
  const loaded=await createPendingStore({storage,session,cryptoObj:webcrypto});
  const bodies=[];let first=true;
  const api=createApi({fetchImpl:async(url,init)=>{bodies.push(init.body);if(first){first=false;throw new Error('lost');}return new Response(JSON.stringify({snapshot:{id:session.campaignId,version:10},resolution:{status:'resolved'}}));}});
  await assert.rejects(api.request(loaded.read().endpoint,session,JSON.parse(loaded.read().payloadJson)));
  await api.request(loaded.read().endpoint,session,JSON.parse(loaded.read().payloadJson));
  assert.equal(bodies[0],bodies[1]);assert.equal(JSON.parse(bodies[0]).requestId,payload.requestId);
  assert.equal(JSON.parse(bodies[0]).expectedVersion,9);assert.deepEqual(loaded.read().endpoint,'rulings/story');
});

test('intent clarification context preserves original text and distinct unexecuted states',async()=>{
  const {activityStatusLabels}=await import('../src/activity.js');
  const clarifications=[{question:'你指的是哪种来源？',answer:'法师职业的魔法飞弹'}];
  const model=rulingContextModel({sequence:18,origin:{input:'我想用魔法打开门',clarifications}},null);
  assert.equal(model.input,'我想用魔法打开门');assert.deepEqual(model.clarifications,clarifications);
  assert.deepEqual(rulingContextModel({sequence:1},null).clarifications,[]);
  assert.equal(activityStatusLabels.awaiting_clarification,'等待补充说明');
  assert.equal(activityStatusLabels.awaiting_confirmation,'等待确认行动');
  assert.equal(activityStatusLabels.cancelled,'已放弃');
  assert.deepEqual(model.costs,[],'clarification does not invent any paid resources');
});

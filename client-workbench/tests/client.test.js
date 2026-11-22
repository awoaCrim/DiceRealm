import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {normalizeSession,saveSession,loadSession,SESSION_KEY} from '../src/session.js';
import {createApi,prepare,randomHex,newUuid,requestPath} from '../src/api.js';
import {createPendingStore} from '../src/pending.js';
const origin='http://127.0.0.1:5182';
const session={baseUrl:origin,campaignId:'00000000-0000-0000-0000-000000000001',accessToken:'a'.repeat(64)};
const memory=()=>{const map=new Map();return{getItem:k=>map.get(k)||null,setItem:(k,v)=>map.set(k,v),removeItem:k=>map.delete(k)};};

test('saved connections are exact-origin, bounded identity and tab-only',()=>{
  const store=memory();saveSession(store,session,origin);assert.deepEqual(loadSession(store,origin),session);
  for(const baseUrl of ['https://example.com',origin+'/wrong',origin+'/?key=a','http://user:pass@127.0.0.1:5182'])assert.throws(()=>normalizeSession({...session,baseUrl},origin));
  assert.throws(()=>normalizeSession({...session,campaignId:'../assets'},origin));
  assert.throws(()=>normalizeSession({...session,accessToken:'short'},origin));
  assert.ok(store.getItem(SESSION_KEY));
});
test('capabilities use secure crypto or fail closed',()=>{
  assert.match(randomHex(32,webcrypto),/^[a-f0-9]{64}$/);assert.equal(newUuid(webcrypto).length,36);
  assert.throws(()=>randomHex(32,{}));assert.throws(()=>newUuid({}));
});
test('pending persists exact request before send, blocks second capture and isolates seats',async()=>{
  const storage=memory();const a=await createPendingStore({storage,session,cryptoObj:webcrypto});
  const payload={requestId:'same',expectedVersion:7,rulingId:'r',rationale:'reason'};
  a.capture('rulings/resolve',payload);payload.expectedVersion=8;
  assert.equal(JSON.parse(a.read().payloadJson).expectedVersion,7);assert.throws(()=>a.capture('archive',{}));
  const restored=await createPendingStore({storage,session,cryptoObj:webcrypto});assert.deepEqual(restored.read(),a.read());
  const guest=await createPendingStore({storage,session:{...session,accessToken:'b'.repeat(64)},cryptoObj:webcrypto});assert.equal(guest.read(),null);
  assert.ok(!a.key.includes(session.accessToken));restored.complete();assert.equal(a.read(),null);
  storage.setItem(a.key,'broken');assert.throws(()=>a.read());assert.throws(()=>a.capture('archive',{}));
});
test('versioned commands whitelist fields; resource endpoints use their own comparison identities',()=>{
  const p=prepare('rulings/resolve',{requestId:'id',expectedVersion:2,rulingId:'r',outcome:'narrative',rationale:'reason',ruleSource:'source',hitPoints:999,roll:20});
  assert.equal(p.hitPoints,undefined);assert.equal(p.roll,undefined);assert.equal(p.dc,0);
  assert.deepEqual(prepare('asset-retry',{assetId:'x',failureId:'f',requestId:'no'}),{failureId:'f'});
  assert.deepEqual(prepare('asset-reference',{assetId:'x'}),{});
  const revision=prepare('scene-asset',{expectedAssetId:'x',referenceImages:['ref']});assert.deepEqual(revision.referenceImages,['ref']);assert.equal(revision.requestId,undefined);
  assert.throws(()=>requestPath('actions',session,{})); // This frontend has no gameplay command port.
});
test('unconfirmed retries keep byte-identical body and never follow redirects',async()=>{
  const attempts=[];let first=true;
  const api=createApi({fetchImpl:async(url,init)=>{attempts.push({url,...init});if(first){first=false;throw Error('network');}return new Response(JSON.stringify({snapshot:{id:session.campaignId,version:3},resolution:{status:'resolved'}}));}});
  const payload={requestId:'same',expectedVersion:2,archived:true};
  await assert.rejects(api.request('archive',session,payload),e=>e.unconfirmed===true);
  await api.request('archive',session,payload);
  assert.equal(attempts[0].body,attempts[1].body);assert.equal(attempts[0].redirect,'error');assert.equal(attempts[0].credentials,'omit');assert.ok(!attempts[0].url.includes(session.accessToken));
});
test('malformed success and 5xx stay unconfirmed, explicit 409 is definitive',async()=>{
  for(const body of ['null','{}','not json'])await assert.rejects(createApi({fetchImpl:async()=>new Response(body)}).request('archive',session,{}),e=>e.unconfirmed);
  await assert.rejects(createApi({fetchImpl:async()=>new Response('{}',{status:503})}).request('snapshot',session),e=>e.unconfirmed);
  await assert.rejects(createApi({fetchImpl:async()=>new Response(JSON.stringify({code:'stale_version',message:'stale'}),{status:409})}).request('archive',session,{}),e=>!e.unconfirmed&&e.code==='stale_version');
});
test('deadline includes response body, not just receipt of headers',async()=>{
  const api=createApi({timeoutMs:10,fetchImpl:async(url,init)=>({ok:true,text:()=>new Promise((resolve,reject)=>init.signal.addEventListener('abort',()=>reject(Error('abort'))))})});
  await assert.rejects(api.request('snapshot',session),e=>e.unconfirmed);
});
test('reference library uses the server array contract',async()=>{
  const refs=[{id:'ref',name:'Reference'}];
  assert.deepEqual(await createApi({fetchImpl:async()=>new Response(JSON.stringify(refs))}).request('references',session),refs);
});
test('character references are a read-only actor path with strictly indexed full rules',async()=>{
  const data={version:2,actorId:'peer/1',characterId:'c1',notice:'',featureDetails:[{index:3,name:'机智',text:'完整正文',notice:'',group:'物种能力'}]};
  const calls=[],api=createApi({fetchImpl:async(url,init)=>{calls.push({url,...init});return new Response(JSON.stringify(data));}});
  assert.deepEqual(await api.request('character-references',session,{actorId:'peer/1'}),data);
  assert.ok(calls[0].url.endsWith('/characters/peer%2F1/references'));assert.equal(calls[0].method,'GET');assert.equal(calls[0].body,undefined);
  for(const bad of [{...data,featureDetails:[...data.featureDetails,...data.featureDetails]},{...data,featureDetails:[{index:-1}]},{...data,notice:null}])
    await assert.rejects(createApi({fetchImpl:async()=>new Response(JSON.stringify(bad))}).request('character-references',session,{actorId:'p'}));
  assert.throws(()=>requestPath('character-references',session,{}));
});

test('journal preserves frozen horizon and export rejects partial transcript',async()=>{
  const url=requestPath('journal',session,{after:50,through:121});assert.ok(url.endsWith('after=50&limit=50&through=121'));
  await assert.rejects(createApi({fetchImpl:async()=>new Response('{"header":true}')}).request('export',session));
  assert.equal(await createApi({fetchImpl:async()=>new Response('{"header":true}\n')}).request('export',session),'{"header":true}\n');
});

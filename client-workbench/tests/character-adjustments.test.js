import test from 'node:test';
import assert from 'node:assert/strict';
import {prepare,createApi,requestPath} from '../src/api.js';
import {createPendingStore} from '../src/pending.js';
import {webcrypto} from 'node:crypto';
const session={baseUrl:'http://127.0.0.1:5184',campaignId:'00000000-0000-0000-0000-000000000001',accessToken:'a'.repeat(64)};
const payload=()=>({requestId:'same',expectedVersion:7,actorId:'guest',rationale:'理由',ruleSource:'DM',rulingId:'r',changes:[{operation:'hp',key:'',value:3,name:'',maximum:999}],abilityScore:999});
test('adjustments whitelist bounded fields and share identical preview/commit payload',()=>{
 const p=prepare('characters/adjust-preview',payload());assert.equal(p.abilityScore,undefined);assert.equal(p.changes[0].maximum,undefined);
 assert.deepEqual(p,prepare('characters/adjust',payload()));assert.ok(requestPath('characters/adjust-preview',session).endsWith('/characters/adjust-preview'));
 assert.equal(requestPath('character-play/catalog',session),'/api/v1/character-play/catalog');
});
test('read-only preview uses POST, does not need a mutation receipt, validates response',async()=>{
 let request;const result={version:7,actorId:'guest',characterName:'Guest',changes:[],warnings:[]};
 const api=createApi({fetchImpl:async(url,init)=>{request={url,...init};return new Response(JSON.stringify(result));}});
 assert.deepEqual(await api.request('characters/adjust-preview',session,payload()),result);assert.equal(request.method,'POST');
 await assert.rejects(createApi({fetchImpl:async()=>new Response('{}')}).request('characters/adjust-preview',session,payload()));
});
test('adjustment response loss and tab reload preserve exact request and target',async()=>{
 const entries=new Map(),storage={getItem:k=>entries.get(k)||null,setItem:(k,v)=>entries.set(k,v),removeItem:k=>entries.delete(k)};
 const pending=await createPendingStore({storage,session,cryptoObj:webcrypto});const p=prepare('characters/adjust',payload());pending.capture('characters/adjust',p);
 const loaded=await createPendingStore({storage,session,cryptoObj:webcrypto});assert.deepEqual(loaded.read(),pending.read());
 const calls=[];let first=true;const api=createApi({fetchImpl:async(url,init)=>{calls.push(init.body);if(first){first=false;throw new Error('lost');}return new Response(JSON.stringify({snapshot:{id:session.campaignId,version:8},resolution:{status:'resolved'}}));}});
 await assert.rejects(api.request(loaded.read().endpoint,session,JSON.parse(loaded.read().payloadJson)));await api.request(loaded.read().endpoint,session,JSON.parse(loaded.read().payloadJson));
 assert.equal(calls[0],calls[1]);assert.equal(JSON.parse(calls[0]).actorId,'guest');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {installDom,settle} from './dom-shim.mjs';
import {createApi,prepare,requestPath,versioned,seatMutations} from '../src/api.js';
import {renderInitialAdventure,confirmInitialAdventure} from '../src/initial-adventure.js';
installDom();
let counter=0;
const button=(root,text)=>root.querySelectorAll('button').find(b=>b.textContent===text);
const input=(root,name)=>root.querySelectorAll('textarea').find(b=>b.getAttribute('aria-label')===name);
const session={campaignId:'campaign'};
async function fixture(scope='setup-'+(++counter)){
  const root=document.createElement('div'),writes=[];
  const ctx={scope,snapshot:{version:2,content:{initialSetup:true},party:{isHost:true}},hasPending:()=>false,refresh:async()=>{},
    submit:async(endpoint,payload)=>{writes.push({endpoint,payload});confirmInitialAdventure(scope,endpoint,payload);return {};}};
  await renderInitialAdventure(root,ctx,{parseImport:JSON.parse,downloadJson:()=>{}});
  return {root,ctx,writes};
}
function fill(f,name,text){const el=input(f.root,name);el.value=text;el.dispatchEvent('input');}
function confirm(){const dialog=document.body.querySelector('dialog');assert.ok(dialog);button(dialog,'确认启用').dispatchEvent('click');}
test('new creation uses explicit room endpoint and setup is frozen host-only, with no draft metadata on wire',()=>{
  assert.equal(requestPath('create',session),'/api/v1/rooms');
  assert.equal(requestPath('initial-adventure',session),'/api/v1/campaigns/campaign/adventure/setup');
  assert.equal(versioned.has('initial-adventure'),true);assert.equal(seatMutations.has('initial-adventure'),false);
  const raw='  原提示词\r\n';assert.deepEqual(prepare('initial-adventure',{requestId:'r',expectedVersion:2,adventure:{},prompt:raw,methods:[],setupDraftRevision:9}),{requestId:'r',expectedVersion:2,adventure:{},prompt:raw,methods:[]});
});
test('post-creation setup retains raw input across routes and confirmed refresh failure does not revive it',async()=>{
  const f=await fixture();fill(f,'剧本 JSON','{"name":"测试"}');fill(f,'叙事提示词原文','  原文\r\n下一行');
  f.root.dispatchEvent('dispose');const next=await fixture(f.ctx.scope);
  assert.equal(input(next.root,'叙事提示词原文').value,'  原文\r\n下一行');
  next.ctx.refresh=async()=>{throw Error('offline');};button(next.root,'校验并启用首次设定').dispatchEvent('click');await settle();assert.equal(next.writes.length,0);confirm();await settle();
  assert.equal(next.writes.length,1);assert.equal(next.writes[0].payload.prompt,'  原文\r\n下一行');assert.match(next.root.textContent,/已启用，但刷新失败/);
  const reopened=await fixture(f.ctx.scope);assert.equal(input(reopened.root,'叙事提示词原文').value,'');
});
test('setup confirmation freezes draft and game version and cannot cross disposal',async()=>{
  for(const change of [f=>fill(f,'叙事提示词原文','新稿'),f=>f.ctx.snapshot.version++,f=>f.root.dispatchEvent('dispose'),f=>f.ctx.hasPending=()=>true]){
    const f=await fixture();fill(f,'剧本 JSON','{"name":"test"}');fill(f,'叙事提示词原文','old');button(f.root,'校验并启用首次设定').dispatchEvent('click');await settle();change(f);confirm();await settle();assert.equal(f.writes.length,0);
  }
});
test('late setup acknowledgement preserves newer unsent input and original request metadata is bounded',async()=>{
  const f=await fixture();fill(f,'剧本 JSON','{"name":"test"}');fill(f,'叙事提示词原文','old');
  let resolve;f.ctx.submit=(endpoint,payload)=>{f.writes.push({endpoint,payload});return new Promise(r=>resolve=r);};
  button(f.root,'校验并启用首次设定').dispatchEvent('click');await settle();confirm();await settle();fill(f,'叙事提示词原文','new');resolve({});await settle();
  const next=await fixture(f.ctx.scope);assert.equal(input(next.root,'叙事提示词原文').value,'new');
});

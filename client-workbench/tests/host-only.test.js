import test from 'node:test';
import assert from 'node:assert/strict';
import {installDom} from './dom-shim.mjs';
installDom();
const {prepare,createApi}=await import('../src/api.js');
const {renderCampaigns}=await import('../src/views.js');
const host={id:'dm',version:1,character:null,party:{isHost:true,members:[]},scene:{title:'准备开始',summary:'等待玩家'},content:{status:'active'}};

test('snapshot transport accepts explicit host-only null but rejects missing and guest null roles',async()=>{
  for(const value of [host,{...host,character:{id:'old-character'}}]){
    const api=createApi({fetchImpl:async()=>new Response(JSON.stringify(value),{status:200})});
    assert.deepEqual(await api.request('snapshot',{campaignId:'dm',accessToken:'isolated'}),value);
  }
  for(const value of [{...host,character:undefined},{...host,party:{isHost:false}},{...host,party:null}]){
    const api=createApi({fetchImpl:async()=>new Response(JSON.stringify(value),{status:200})});
    await assert.rejects(api.request('snapshot',{campaignId:'dm',accessToken:'isolated'}),/响应不完整/);
  }
});
test('workbench creation serializes no character, build or template even with obsolete caller fields',()=>{
  const old={name:'新战役',characterName:'不得生成',templateId:'human-fighter-soldier-2024',build:{identity:{name:'不得生成'}},creation:{}};
  assert.deepEqual(prepare('create',old),{name:'新战役'});
  const adventure={id:'fixture'};
  assert.deepEqual(prepare('campaign-from-content',{...old,adventure,prompt:' 原文 ',methods:[]}),{name:'新战役',adventure,prompt:' 原文 ',methods:[]});
});
test('blank campaign creation has no player form and sends only campaign name',async()=>{
  const mount=document.createElement('div'),sent=[];
  renderCampaigns(mount,{origin:'http://127.0.0.1:51234',account:{user:{isAdmin:false}},accountApi:()=>({campaigns:async()=>({campaigns:[]})}),report:e=>{throw e;},create:async body=>sent.push(body)});
  const input=mount.querySelectorAll('input').find(e=>e.getAttribute('aria-label')==='战役名称');
  input.value='主持的新战役';
  assert.equal(mount.querySelector('select'),null);
  assert.equal(mount.querySelectorAll('input').some(e=>e.getAttribute('aria-label')==='角色名称'),false);
  const form=mount.querySelectorAll('form').find(f=>f.getAttribute('aria-label')==='创建战役');
  await form.onsubmit({preventDefault(){}});
  assert.deepEqual(sent,[{name:'主持的新战役'}]);
  mount.dispatchEvent({type:'dispose'});
});

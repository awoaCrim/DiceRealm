import test from 'node:test';
import assert from 'node:assert/strict';
import {installDom,settle} from './dom-shim.mjs';
installDom();
const {createOperatorApi,renderAiSettings}=await import('../src/ai-settings.js');
const profile=()=>({enabled:true,provider:'openai-chat',baseUrl:'https://fake.invalid/v1',model:'test',hasApiKey:true});
const state=version=>({version,main:profile(),helper:profile()});
const button=(mount,label)=>mount.querySelectorAll('button').find(x=>x.textContent===label);
const click=async el=>{assert.ok(el);el.dispatchEvent({type:'click'});await settle();};
const field=(mount,label)=>mount.querySelectorAll('input').find(x=>x.getAttribute('aria-label')===label);

test('image settings save independently without a provider probe and preserve exact secret retry',async()=>{
  const originalFetch=globalThis.fetch,posts=[];let lost=true;
  const image={enabled:false,endpoint:'',editsEndpoint:'',model:'',hasApiKey:false,allowReferenceUpload:false,sendResponseFormat:true};
  let current={...state(0),image};
  globalThis.fetch=async(url,options)=>{
    assert.ok(!url.endsWith('/test'));
    if(options.method==='POST'){
      posts.push(options.body);const p=JSON.parse(options.body);
      current={...state(1),image:{...p.image,hasApiKey:true}};delete current.image.apiKey;delete current.image.keyAction;
      if(lost){lost=false;throw Error('lost ack');}
    }
    return new Response(JSON.stringify(current));
  };
  try{
    const mount=document.createElement('div');renderAiSettings(mount,{});await settle();
    const set=(name,value)=>{const f=field(mount,'地图图片服务'+name);f.value=value;f.dispatchEvent('input');};
    set('生成接口','https://image.invalid/v1/images/generations');set('模型名称','image-model');
    const enabled=field(mount,'地图图片服务启用');enabled.checked=true;enabled.dispatchEvent('change');
    const key=mount.querySelectorAll('select').find(x=>x.getAttribute('aria-label')==='地图图片服务密钥操作');
    key.value='replace';key.dispatchEvent('change');set(' API Key','image-secret');
    await click(button(mount,'保存 AI 配置'));assert.equal(posts.length,1);
    await click(button(mount,'重试原请求'));assert.equal(posts[0],posts[1]);
    const sent=JSON.parse(posts[0]);assert.equal(sent.image.apiKey,'image-secret');assert.equal(sent.image.model,'image-model');
    assert.equal(sent.main.keyAction,'keep');assert.equal(sent.helper.keyAction,'keep');
    assert.equal(field(mount,'地图图片服务 API Key').value,'');
    assert.equal(mount.querySelectorAll('button').filter(x=>x.textContent==='测试连通').length,2);
    mount.dispatchEvent('dispose');
  }finally{globalThis.fetch=originalFetch;}
  const api=createOperatorApi({fetchImpl:async()=>new Response(JSON.stringify({...state(0),image:{...image,apiKey:'leak'}}))});
  await assert.rejects(api.read(),error=>error.unconfirmed===true);
});

test('operator transport freezes account authority, exact retry body and no redirect',async()=>{
  const calls=[],api=createOperatorApi({accessToken:'account-session',fetchImpl:async(url,options)=>{calls.push({url,options});return new Response(JSON.stringify(state(1)));}});
  const body=JSON.stringify({requestId:'id',expectedVersion:0,main:{apiKey:'secret'},helper:{}});
  await api.save(body);await api.save(body);
  assert.equal(calls[0].options.body,calls[1].options.body);
  assert.equal(calls[0].options.headers.Authorization,'Bearer account-session');
  assert.equal(calls[0].options.headers['X-DiceRealm-Local-Settings'],'1');
  assert.equal(calls[0].options.headers['X-DiceRealm-Operator-Token'],undefined);
  assert.equal(calls[0].options.credentials,'omit');assert.equal(calls[0].options.redirect,'error');

});
test('unexpected key projection, wrong receipt version and mismatched test receipt fail closed',async()=>{
  for(const result of [{...state(1),main:{...profile(),apiKey:'must-not-return'}},state(9)]){
    const api=createOperatorApi({fetchImpl:async()=>new Response(JSON.stringify(result))});
    await assert.rejects(api.save(JSON.stringify({expectedVersion:0})),error=>error.unconfirmed===true);
  }
  const api=createOperatorApi({fetchImpl:async()=>new Response(JSON.stringify({requestId:'other',version:1,role:'main',status:'success',message:'done'}))});
  await assert.rejects(api.test(JSON.stringify({requestId:'expected'})),/测试回执/);
});
test('settings opens directly; save and test each work in one click without unlock or confirmation',async()=>{
  document.body.replaceChildren();const originalFetch=globalThis.fetch,requests=[];
  const storage={getItem(){throw Error('credentials must not be persisted');},setItem(){throw Error('credentials must not be persisted');}};
  globalThis.sessionStorage=globalThis.localStorage=storage;
  let version=0;
  globalThis.fetch=async(url,options)=>{
    requests.push({url,options});
    if(url.endsWith('/test')){const p=JSON.parse(options.body);return new Response(JSON.stringify({requestId:p.requestId,version,role:p.role,status:'success',message:'测试已完成'}));}
    if(options.method==='POST')version++;
    return new Response(JSON.stringify(state(version)));
  };
  try{
    const mount=document.createElement('div');renderAiSettings(mount,{});await settle();
    assert.equal(requests.length,1);assert.equal(field(mount,'本机服务管理凭证'),undefined);
    assert.equal(button(mount,'解锁本机 AI 配置'),undefined);
    await click(button(mount,'保存 AI 配置'));
    assert.equal(document.body.querySelectorAll('dialog').length,0);
    assert.equal(requests.length,3);assert.equal(button(mount,'保存 AI 配置').disabled,false);
    assert.equal(JSON.parse(requests[1].options.body).main.keyAction,'keep');
    await click(button(mount,'测试连通'));
    assert.equal(document.body.querySelectorAll('dialog').length,0);
    assert.equal(requests.length,4);assert.match(mount.textContent,/测试已完成/);
    assert.equal(JSON.parse(requests[3].options.body).confirmProviderUse,true);
    mount.dispatchEvent({type:'dispose'});
    assert.ok(mount.querySelectorAll('input[type="password"]').every(x=>x.value===''));
  }finally{globalThis.fetch=originalFetch;delete globalThis.sessionStorage;delete globalThis.localStorage;}
});
test('test buttons explain unsaved changes and test saved configuration after reverting',async()=>{
  const originalFetch=globalThis.fetch;let calls=0;
  globalThis.fetch=async()=>{calls++;return new Response(JSON.stringify(state(0)));};
  try{
    const mount=document.createElement('div');renderAiSettings(mount,{});await settle();
    const model=field(mount,'DM 叙事主模型模型名称');
    assert.match(mount.textContent,/测试已保存的模型 test/);
    model.value='changed';model.dispatchEvent({type:'input'});
    const tests=mount.querySelectorAll('button').filter(x=>x.textContent==='测试连通');
    assert.ok(tests.every(x=>x.disabled&&x.title.includes('未保存')));
    assert.match(mount.textContent,/请先保存 AI 配置后测试/);
    model.value='test';model.dispatchEvent({type:'input'});
    assert.ok(tests.every(x=>!x.disabled));assert.equal(calls,1,'editing never sends a provider request');
  }finally{globalThis.fetch=originalFetch;}
});

test('unknown save retries original bytes instead of adding a new operation',async()=>{
  document.body.replaceChildren();const originalFetch=globalThis.fetch,posts=[];let fail=true;
  globalThis.fetch=async(url,options)=>{
    if(options.method==='POST'){posts.push(options.body);if(fail){fail=false;throw Error('lost response');}return new Response(JSON.stringify(state(1)));}
    return new Response(JSON.stringify(state(0)));
  };
  try{
    const mount=document.createElement('div');renderAiSettings(mount,{});await settle();
    await click(button(mount,'保存 AI 配置'));
    assert.equal(button(mount,'保存 AI 配置').disabled,true);await click(button(mount,'重试原请求'));
    assert.equal(posts.length,2);assert.equal(posts[0],posts[1]);assert.equal(button(mount,'保存 AI 配置').disabled,false);
  }finally{globalThis.fetch=originalFetch;}
});

test('a replayed older save confirms only that operation, then displays the current server version',async()=>{
  document.body.replaceChildren();const originalFetch=globalThis.fetch;let reads=0,posts=0;
  globalThis.fetch=async(url,options)=>{
    if(options.method==='POST'){posts++;if(posts===1)throw Error('lost ack');return new Response(JSON.stringify(state(1)));}
    reads++;const value=state(reads===1?0:2);value.main.model=reads===1?'initial':'other-operator-model';return new Response(JSON.stringify(value));
  };
  try{
    const mount=document.createElement('div');renderAiSettings(mount,{});await settle();
    await click(button(mount,'保存 AI 配置'));
    await click(button(mount,'重试原请求'));
    assert.equal(field(mount,'DM 叙事主模型模型名称').value,'other-operator-model');assert.match(mount.textContent,/原保存请求已确认.*最新配置/);
    assert.equal(reads,2);assert.equal(posts,2);
  }finally{globalThis.fetch=originalFetch;}
});

test('confirmed save plus failed latest read never revives the secret request or enables stale editing',async()=>{
  document.body.replaceChildren();const originalFetch=globalThis.fetch;let reads=0,posts=0;
  globalThis.fetch=async(url,options)=>{
    if(options.method==='POST'){posts++;return new Response(JSON.stringify(state(1)));}
    reads++;if(reads>1)throw Error('read unavailable');return new Response(JSON.stringify(state(0)));
  };
  try{
    const mount=document.createElement('div');renderAiSettings(mount,{});await settle();
    await click(button(mount,'保存 AI 配置'));
    assert.match(mount.textContent,/保存请求已确认.*最新配置读取失败/);assert.equal(button(mount,'重试原请求').hidden,true);
    assert.equal(button(mount,'保存 AI 配置').disabled,true);assert.equal(button(mount,'重新读取配置').disabled,false);assert.equal(posts,1);
  }finally{globalThis.fetch=originalFetch;}
});

test('helper supports native Gemini and sends the selected protocol and base URL',async()=>{
  document.body.replaceChildren();const originalFetch=globalThis.fetch,posts=[];let current=state(0);
  globalThis.fetch=async(url,options)=>{
    if(options.method==='POST'){
      const p=JSON.parse(options.body);posts.push(p);
      current={version:1,main:{...p.main,hasApiKey:true},helper:{...p.helper,hasApiKey:true}};
      delete current.main.apiKey;delete current.helper.apiKey;
    }
    return new Response(JSON.stringify(current));
  };
  try{
    const mount=document.createElement('div');renderAiSettings(mount,{});await settle();
    const select=label=>mount.querySelectorAll('select').find(x=>x.getAttribute('aria-label')===label);
    const provider=select('轻量辅助模型 Provider');
    assert.ok(provider.children.some(x=>x.value==='gemini'));
    provider.value='gemini';provider.dispatchEvent({type:'change'});
    assert.equal(select('轻量辅助模型地址模式').value,'base');
    assert.equal(select('轻量辅助模型地址模式').disabled,true);
    const address=field(mount,'轻量辅助模型 Base URL');address.value='https://fake.invalid/v1beta';address.dispatchEvent({type:'input'});
    await click(button(mount,'保存 AI 配置'));
    assert.equal(posts.length,1);assert.equal(posts[0].helper.provider,'gemini');
    assert.equal(posts[0].helper.baseUrl,'https://fake.invalid/v1beta');
    assert.equal(posts[0].helper.endpointIsComplete,false);
    assert.equal(select('轻量辅助模型 Provider').value,'gemini');
    mount.dispatchEvent({type:'dispose'});
  }finally{globalThis.fetch=originalFetch;}
});

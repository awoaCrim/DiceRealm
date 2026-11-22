import test from 'node:test';
import assert from 'node:assert/strict';
import {parseImport,maximumImportBytes} from '../src/content-page.js';
import {prepare,requestPath,createApi,versioned} from '../src/api.js';
const prompts={formatVersion:1,id:'p',version:'1',name:'Host text',intent:'exact\r\nsource',narration:'exact source'};
const adventure={formatVersion:1,id:'a',version:'1',name:'Host data',startSceneId:'x',scenes:[{id:'x',title:'User title',actions:[]} ]};
test('content preview preserves user text, rejects malformed documents and never supplies author prose',()=>{
  assert.deepEqual(parseImport('\ufeff'+JSON.stringify(adventure),'adventure'),adventure);
  assert.throws(()=>parseImport(JSON.stringify({...adventure,name:''}),'adventure'),/name/);
  assert.throws(()=>parseImport(JSON.stringify(prompts),'prompts'),/未知导入类型/);
  assert.throws(()=>parseImport('{"id":"a","id":"b"}','adventure'),/重复字段/);
  assert.throws(()=>parseImport(JSON.stringify({...adventure,unexpected:'x'}),'adventure'),/未知顶层字段/);
  assert.throws(()=>parseImport(JSON.stringify({...adventure,startSceneId:'missing'}),'adventure'),/startSceneId/);
  assert.throws(()=>parseImport('x'.repeat(maximumImportBytes+1),'adventure'),/1 MiB/);
  assert.deepEqual(parseImport(JSON.stringify({...adventure,sourceText:'literal { "key": 1, "key": 2 } in text'}),'adventure').sourceText,'literal { "key": 1, "key": 2 } in text');
});
test('content commands retain exact document with version and idempotency keys',()=>{
  for(const endpoint of ['content/adventure','content/prompts']){
    assert.ok(versioned.has(endpoint));
    assert.deepEqual(prepare(endpoint,{requestId:'r',expectedVersion:4,document:prompts,hp:999}),{requestId:'r',expectedVersion:4,document:prompts});
    assert.equal(requestPath(endpoint,{campaignId:'c'}),'/api/v1/campaigns/c/'+endpoint);
  }
  assert.deepEqual(prepare('content/activate',{requestId:'r',expectedVersion:5,document:adventure}),{requestId:'r',expectedVersion:5});
});
test('blank campaign creation sends no default scenario or prompt and no bearer',async()=>{
  let sent;
  const api=createApi({fetchImpl:async(url,init)=>{sent={url,init};return new Response(JSON.stringify({accessToken:'a'.repeat(64),snapshot:{id:'campaign',content:{status:'draft'}}}));}});
  await api.request('create',null,{name:'Host',characterName:'Player',templateId:'human-fighter-soldier-2024',adventure:'do not send'});
  assert.equal(sent.url,'/api/v1/rooms');assert.equal(sent.init.headers.Authorization,undefined);
  assert.equal(JSON.parse(sent.init.body).adventure,undefined);assert.equal(JSON.parse(sent.init.body).prompts,undefined);
});

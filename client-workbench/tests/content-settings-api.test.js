import test from 'node:test';
import assert from 'node:assert/strict';
import {prepare,requestPath,createApi,validAdventureSettings} from '../src/api.js';

const session={campaignId:'campaign-1',accessToken:'token'};
const content=(over={})=>({contentId:'primary',contentVersion:1,prompt:'原始提示词',methods:[{id:'m1',description:'调查',content:'先核对来源'}],fingerprint:'f1',...over});
const settingsView=(over={})=>({settingsVersion:1,activeRevision:1,latestRevision:1,draft:content(),active:content(),matchesActive:true,...over});
const result=(over={})=>({settings:over.settings||settingsView(),replayed:!!over.replayed});

test('content preparation requests use neutral business paths only',()=>{
  assert.equal(requestPath('settings',session),'/api/v1/campaigns/campaign-1/adventure/settings');
  assert.equal(requestPath('settings-preview',session),'/api/v1/campaigns/campaign-1/adventure/settings/preview');
  assert.equal(requestPath('settings-draft',session),'/api/v1/campaigns/campaign-1/adventure/settings/draft');
  assert.equal(requestPath('settings-publish',session),'/api/v1/campaigns/campaign-1/adventure/settings/publish');
  assert.equal(requestPath('settings-activate',session),'/api/v1/campaigns/campaign-1/adventure/settings/activate');
  assert.equal(requestPath('settings-history',session,{limit:20,before:9}),'/api/v1/campaigns/campaign-1/adventure/settings/history?limit=20&before=9');
  assert.equal(requestPath('settings-revision',session,{revision:4}),'/api/v1/campaigns/campaign-1/adventure/settings/history/4');
  assert.equal(requestPath('settings-export',session,{revision:2,includeDraft:true}),'/api/v1/campaigns/campaign-1/adventure/settings/export?revision=2&includeDraft=true');
  // 旧工作区端点保留，只供应存旧 pending 原样重放。
  assert.equal(requestPath('workspace-publish',session),'/api/v1/campaigns/campaign-1/harness/workspace/publish');
  assert.equal(requestPath('workspace-activate',session),'/api/v1/campaigns/campaign-1/harness/workspace/activate');
});

test('content identity is frozen with the draft and never rebuilt from local state',()=>{
  const draft=prepare('settings-draft',{requestId:'d1',expectedSettingsVersion:7,contentId:'primary',contentVersion:3,
    prompt:'  原文\n',methods:[{id:'m1',description:'d',content:'c'}],localRevision:9,revision:2,preset:{id:'ignored'}});
  assert.deepEqual(draft,{requestId:'d1',expectedSettingsVersion:7,contentId:'primary',contentVersion:3,prompt:'  原文\n',methods:[{id:'m1',description:'d',content:'c'}]});
  assert.deepEqual(prepare('settings-preview',{contentId:'primary',contentVersion:3,prompt:'原文',methods:[]}),{contentId:'primary',contentVersion:3,prompt:'原文',methods:[]});
  assert.deepEqual(prepare('settings-publish',{requestId:'p1',expectedSettingsVersion:8,revision:99}),{requestId:'p1',expectedSettingsVersion:8});
  assert.deepEqual(prepare('settings-activate',{requestId:'a1',expectedSettingsVersion:8,revision:2}),{requestId:'a1',expectedSettingsVersion:8,revision:2});
});

test('three independent commands send their exact bodies and validate their responses',async()=>{
  const sent=[];
  const api=createApi({fetchImpl:async(url,options)=>{sent.push({url,options});return new Response(JSON.stringify(result()),{status:200,headers:{'content-type':'application/json'}});}});
  await api.request('settings-draft',session,{requestId:'d1',expectedSettingsVersion:1,contentId:'primary',contentVersion:2,prompt:'p',methods:[]});
  assert.deepEqual(JSON.parse(sent[0].options.body),{requestId:'d1',expectedSettingsVersion:1,contentId:'primary',contentVersion:2,prompt:'p',methods:[]});
  await api.request('settings-publish',session,{requestId:'p1',expectedSettingsVersion:2});
  assert.deepEqual(JSON.parse(sent[1].options.body),{requestId:'p1',expectedSettingsVersion:2});
  await api.request('settings-activate',session,{requestId:'a1',expectedSettingsVersion:3,revision:2});
  assert.deepEqual(JSON.parse(sent[2].options.body),{requestId:'a1',expectedSettingsVersion:3,revision:2});
  // 不完整的 2xx 不能被当成已确认结果。
  const incomplete=createApi({fetchImpl:async()=>new Response(JSON.stringify({settings:{settingsVersion:3}}),{status:200,headers:{'content-type':'application/json'}})});
  await assert.rejects(incomplete.request('settings-draft',session,{requestId:'d1',expectedSettingsVersion:1,contentId:'primary',contentVersion:2,prompt:'p',methods:[]}),error=>error.unconfirmed===true);
  const guess=createApi({fetchImpl:async()=>new Response(JSON.stringify(result({settings:settingsView({matchesActive:'yes'})})),{status:200,headers:{'content-type':'application/json'}})});
  await assert.rejects(guess.request('settings-publish',session,{requestId:'p1',expectedSettingsVersion:2}),error=>error.unconfirmed===true);
});

test('settings view validator requires content identity and explicit version state',()=>{
  assert.equal(validAdventureSettings(settingsView()),true);
  assert.equal(validAdventureSettings(settingsView({draft:content({contentVersion:0})})),false);
  assert.equal(validAdventureSettings(settingsView({draft:content({contentId:''})})),false);
  assert.equal(validAdventureSettings(settingsView({latestRevision:0})),false);
  assert.equal(validAdventureSettings({...settingsView(),hash:'sha256'}),true); // 额外字段不构成业务契约
});

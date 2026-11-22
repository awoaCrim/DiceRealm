import test from 'node:test';
import assert from 'node:assert/strict';
import {prepare,requestPath,createApi,validAdventureSession,validAdventureSettings,adventurePhases,confirmationKinds} from '../src/api.js';

const session={campaignId:'campaign-1',accessToken:'token'};
const sessionView=(over={})=>({sessionId:'11111111-1111-4111-8111-111111111111',phase:'needsAnswer',question:'你要做什么？',confirmation:null,outcome:'',notice:'',actionText:'我推开门',replayed:false,...over});
const result=(over={})=>({settings:{settingsVersion:4,activeRevision:1,latestRevision:2,
  draft:{contentId:'primary',contentVersion:2,prompt:'原文',methods:[],fingerprint:'d2'},
  active:{contentId:'primary',contentVersion:1,prompt:'原文',methods:[],fingerprint:'a1'},matchesActive:false},replayed:false,...over});

test('normal product requests use neutral business paths and never the kernel routes',()=>{
  assert.equal(requestPath('campaign-from-content',session),'/api/v1/campaigns/from-content');
  assert.equal(requestPath('adventure',session),'/api/v1/campaigns/campaign-1/adventure');
  assert.equal(requestPath('adventure-session',session,{sessionId:'s1'}),'/api/v1/campaigns/campaign-1/adventure/sessions/s1');
  assert.equal(requestPath('adventure-act',session),'/api/v1/campaigns/campaign-1/adventure/actions');
  assert.equal(requestPath('adventure-continue',session,{sessionId:'s1'}),'/api/v1/campaigns/campaign-1/adventure/sessions/s1/continue');
  assert.equal(requestPath('adventure-stop',session,{sessionId:'s1'}),'/api/v1/campaigns/campaign-1/adventure/sessions/s1/stop');
  assert.equal(requestPath('adventure-memory',session),'/api/v1/campaigns/campaign-1/adventure/memory');
  assert.equal(requestPath('settings',session),'/api/v1/campaigns/campaign-1/adventure/settings');
  assert.equal(requestPath('settings-draft',session),'/api/v1/campaigns/campaign-1/adventure/settings/draft');
  assert.equal(requestPath('settings-publish',session),'/api/v1/campaigns/campaign-1/adventure/settings/publish');
  assert.equal(requestPath('settings-activate',session),'/api/v1/campaigns/campaign-1/adventure/settings/activate');
  assert.equal(requestPath('settings-revision',session,{revision:3}),'/api/v1/campaigns/campaign-1/adventure/settings/history/3');
  // 旧工作区/运行端点保留，只供应存旧 pending 原样重放。
  assert.equal(requestPath('workspace-draft',session),'/api/v1/campaigns/campaign-1/harness/workspace/draft');
  assert.equal(requestPath('harness-run',session),'/api/v1/campaigns/campaign-1/harness/runs');
});

test('business serialization keeps raw user text and drops local bookkeeping',()=>{
  const adventure={formatVersion:1,id:'adv',version:'1',name:'我的剧本',startSceneId:'s1',sourceText:'原文',scenes:[{id:'s1',actions:[]}]};
  const created=prepare('campaign-from-content',{name:'战役',characterName:'角色',adventure,prompt:'  原文\n第二行  ',
    methods:[{id:'m1',description:'d',content:' c '}],localScope:'nope',templateId:'human-fighter-wizard-2024'});
  assert.equal(created.prompt,'  原文\n第二行  ');
  assert.deepEqual(created.methods,[{id:'m1',description:'d',content:' c '}]);
  assert.equal(created.adventure,adventure);
  assert.equal(created.localScope,undefined);
  assert.deepEqual(Object.keys(created).sort(),['adventure','methods','name','prompt']);

  assert.deepEqual(prepare('adventure-act',{requestId:'r1',expectedVersion:9,text:'行动',runId:'ignored',sessionId:'ignored'}),
    {requestId:'r1',expectedVersion:9,text:'行动'});
  assert.deepEqual(prepare('adventure-continue',{requestId:'r2',expectedVersion:9,text:'',sessionId:'s1'}),{requestId:'r2',expectedVersion:9,text:''});
  // 停止必须无 body。
  assert.equal(prepare('adventure-stop',{sessionId:'s1'}),undefined);
  // 内容身份随草稿冻结并显式发送。
  assert.deepEqual(prepare('settings-draft',{requestId:'d1',expectedSettingsVersion:7,contentId:'primary',contentVersion:2,prompt:'p',methods:[{id:'m',description:'d',content:'c'}],localRevision:3}),
    {requestId:'d1',expectedSettingsVersion:7,contentId:'primary',contentVersion:2,prompt:'p',methods:[{id:'m',description:'d',content:'c'}]});
  assert.deepEqual(prepare('settings-publish',{requestId:'p1',expectedSettingsVersion:8}),{requestId:'p1',expectedSettingsVersion:8});
  assert.deepEqual(prepare('settings-activate',{requestId:'a1',expectedSettingsVersion:8,revision:2}),{requestId:'a1',expectedSettingsVersion:8,revision:2});
});

test('stop POSTs with bearer auth and no body while business writes send their exact bodies',async()=>{
  const sent=[];
  const api=createApi({fetchImpl:async(url,options)=>{sent.push({url,options});return new Response(JSON.stringify(sessionView()),{status:202,headers:{'content-type':'application/json'}});}});
  await api.request('adventure-stop',session,{sessionId:sessionView().sessionId});
  assert.equal(sent[0].options.method,'POST');
  assert.equal(Object.hasOwn(sent[0].options,'body'),false);
  assert.equal(sent[0].options.headers.Authorization,'Bearer token');
  await api.request('adventure-act',session,{requestId:sessionView().sessionId,expectedVersion:9,text:'行动'});
  assert.deepEqual(JSON.parse(sent[1].options.body),{requestId:sessionView().sessionId,expectedVersion:9,text:'行动'});
});

test('an incomplete or mismatched success body stays unconfirmed instead of being adopted',async()=>{
  const bad=createApi({fetchImpl:async()=>new Response(JSON.stringify({sessionId:'x',phase:'瞎编'}),{status:202,headers:{'content-type':'application/json'}})});
  await assert.rejects(bad.request('adventure-act',session,{requestId:'x',expectedVersion:1,text:'x'}),error=>error.unconfirmed===true);
  const mismatched=createApi({fetchImpl:async()=>new Response(JSON.stringify(sessionView()),{status:202})});
  await assert.rejects(mismatched.request('adventure-act',session,{requestId:'another',expectedVersion:1,text:'x'}),error=>error.unconfirmed===true);
  const missing=createApi({fetchImpl:async()=>new Response(JSON.stringify({sessionId:sessionView().sessionId,phase:'done'}),{status:200})});
  await assert.rejects(missing.request('adventure-session',session,{sessionId:sessionView().sessionId}),error=>error.unconfirmed===true);
  const ok=createApi({fetchImpl:async()=>new Response(JSON.stringify(sessionView()),{status:202})});
  assert.equal((await ok.request('adventure-act',session,{requestId:sessionView().sessionId,expectedVersion:1,text:'x'})).phase,'needsAnswer');
});

test('business session and settings validators reject invented shapes',()=>{
  assert.equal(validAdventureSession(sessionView()),true);
  assert.equal(validAdventureSession(sessionView({phase:'needsConfirmation'})),false); // 缺精确确认事项
  assert.equal(validAdventureSession(sessionView({phase:'needsConfirmation',confirmation:{kind:'intent',waitId:'i1',prompt:'?'}})),true);
  assert.equal(validAdventureSession(sessionView({phase:'needsAnswer',confirmation:{kind:'roll',waitId:'r1',prompt:'?'}})),false);
  assert.equal(validAdventureSession(sessionView({phase:'done',confirmation:{kind:'guess',waitId:'r',prompt:'?'}})),false);
  // 停止/正在停止的内核 DTO 仍保留原确认事项：合法残留必须被接受，业务界面据此单独放弃。
  assert.equal(validAdventureSession(sessionView({phase:'stopped',confirmation:{kind:'roll',waitId:'r1',prompt:'请投掷'}})),true);
  assert.equal(validAdventureSession(sessionView({phase:'stopping',confirmation:{kind:'intent',waitId:'i1',prompt:'选择'}})),true);
  assert.equal(validAdventureSession(sessionView({phase:'stopped',confirmation:{kind:'roll',waitId:'',prompt:'请投掷'}})),false);
  assert.equal(validAdventureSession(sessionView({phase:'working',confirmation:{kind:'roll',waitId:'r1',prompt:'请投掷'}})),false);
  assert.equal(validAdventureSession({...sessionView(),phase:'completed'}),false); // 内核状态名不是业务阶段
  assert.equal(validAdventureSession({id:"r1",status:"completed",modelAttempts:1,toolSteps:0}),false); // 内核运行形状不是业务行动视图
  assert.equal(adventurePhases.has('unconfirmed'),true);
  assert.equal(confirmationKinds.has('roll'),true);
  assert.equal(validAdventureSettings(result().settings),true);
  assert.equal(validAdventureSettings({...result().settings,activeRevision:0}),false);
  assert.equal(validAdventureSettings({...result().settings,matchesActive:'yes'}),false);
});

// 已知内核专用错误码 → 中性业务指引：只按 code 匹配，保留 code/status/unconfirmed 与终态语义，
// 未知错误码（含用户原文里的 Harness 字样）必须逐字保留。
test('known internal kernel errors are neutralized without changing code, status or confirmation state',async()=>{
  const failing=(body,status)=>createApi({fetchImpl:async()=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}})});
  const action={requestId:'11111111-1111-4111-8111-111111111111',expectedVersion:1,text:'我推开门'};

  // 真实业务新战役上走旧内容入口：409 harness_input_required 的中性化。
  const inputRequired=failing({code:'harness_input_required',message:'此战役使用 Harness 输入；旧自然语言入口不会调用另一套模型。确认候选和投掷仍使用原专用入口。'},409);
  await assert.rejects(inputRequired.request('adventure-act',session,action),error=>{
    assert.equal(error.code,'harness_input_required');
    assert.equal(error.status,409);
    assert.equal(error.unconfirmed,false); // 明确的 409 终态不能被改成未确认
    assert.doesNotMatch(error.message,/Harness|运行|预设|Skill/);
    assert.match(error.message,/我的行动/);
    return true;
  });

  // invalid_harness_profile 原文含预设/Skill 概念，必须换成只讲提示词与工作方法说明的指引。
  const badProfile=failing({code:'invalid_harness_profile',message:'需要有版本的原始预设和有界只读 Skill 内容。不会加载本机文件或默认提示词。'},400);
  await assert.rejects(badProfile.request('settings-draft',session,{requestId:'d1',expectedSettingsVersion:1,contentId:'primary',contentVersion:1,prompt:'p',methods:[]}),error=>{
    assert.equal(error.code,'invalid_harness_profile');
    assert.equal(error.status,400);
    assert.doesNotMatch(error.message,/预设|Skill|Harness/);
    assert.match(error.message,/工作方法说明/);
    return true;
  });

  // 同组其它内核错误共用「运行无法继续…」原文：同样不得把运行器概念带到产品界面，code 仍可用于既有分支。
  const runConflict=failing({code:'harness_run_pending',message:'运行无法继续。请查看已保存的结果；不会自动重试、重掷或替换版本。'},409);
  await assert.rejects(runConflict.request('adventure-continue',session,{...action,sessionId:'s1'}),error=>{
    assert.equal(error.code,'harness_run_pending');
    assert.equal(error.status,409);
    assert.equal(error.unconfirmed,false);
    assert.doesNotMatch(error.message,/运行|工作区|Harness/);
    return true;
  });
  // 旧工作区错误码保持 code 可用（设定页仍按 code 给专门文案），显示文案本身不泄漏内核概念。
  const workspaceError=failing({code:'workspace_stale_version',message:'运行无法继续。请查看已保存的结果；不会自动重试、重掷或替换版本。'},409);
  await assert.rejects(workspaceError.request('settings-publish',session,{requestId:'p1',expectedSettingsVersion:2}),error=>{
    assert.equal(error.code,'workspace_stale_version');
    assert.equal(error.status,409);
    assert.doesNotMatch(error.message,/运行|工作区|Harness/);
    return true;
  });
});

test('context errors explain the cause without suggesting resending the action',async()=>{
  for(const [code,reason] of [['harness_transport_limit','传输容量'],['harness_context_budget_unknown','无法确认'],['harness_context_preparation_failed','上下文整理'],['harness_context_limit','上下文容量']]){
    const api=createApi({fetchImpl:async()=>new Response(JSON.stringify({code,message:'PRIVATE'}),{status:409,headers:{'content-type':'application/json'}})});
    await assert.rejects(api.request('adventure-act',session,{requestId:'r1',expectedVersion:1,text:'继续'}),error=>{
      assert.equal(error.code,code);assert.equal(error.unconfirmed,false);
      assert.ok(error.message.includes(reason));assert.match(error.message,/已保存/);
      assert.doesNotMatch(error.message,/PRIVATE|换句话|重新发送/);return true;
    });
  }
});

test('unknown error codes keep the server text verbatim even when it contains Harness',async()=>{
  const api=createApi({fetchImpl:async()=>new Response(JSON.stringify({code:'invalid_input',message:'你的剧本原文写了 Harness 这个词；请保留你自己的写法。'}),{status:400,headers:{'content-type':'application/json'}})});
  await assert.rejects(api.request('adventure-act',session,{requestId:'r1',expectedVersion:1,text:'x'}),error=>{
    assert.equal(error.code,'invalid_input');
    assert.equal(error.status,400);
    assert.equal(error.message,'你的剧本原文写了 Harness 这个词；请保留你自己的写法。');
    return true;
  });
});

// 回退文案只说明本次未完成与状态查看，不泛化推荐重试或放弃，也不鼓励补发新行动。
test('the unknown kernel-namespace fallback never advises blind retry, abandoning or resending',async()=>{
  const api=createApi({fetchImpl:async()=>new Response(JSON.stringify({code:'harness_runtime_eof',message:'运行无法继续。请查看已保存的结果；不会自动重试、重掷或替换版本。'}),{status:409,headers:{'content-type':'application/json'}})});
  await assert.rejects(api.request('adventure-act',session,{requestId:'r1',expectedVersion:1,text:'行动'}),error=>{
    assert.equal(error.code,'harness_runtime_eof');
    assert.equal(error.status,409);
    assert.equal(error.unconfirmed,false);
    assert.doesNotMatch(error.message,/运行|工作区|Harness|预设|Skill/);
    assert.doesNotMatch(error.message,/重试|放弃|重新发送/);
    assert.match(error.message,/未确认/);
    return true;
  });
});

test('prototype keys are never treated as known codes and keep the server message verbatim',async()=>{
  for(const code of ['constructor','toString','hasOwnProperty']){
    const api=createApi({fetchImpl:async()=>new Response(JSON.stringify({code,message:'服务器原文：'+code}),{status:400,headers:{'content-type':'application/json'}})});
    await assert.rejects(api.request('adventure-act',session,{requestId:'r1',expectedVersion:1,text:'x'}),error=>{
      assert.equal(error.code,code);
      assert.equal(error.message,'服务器原文：'+code);
      return true;
    });
  }
});

test('the adventure board may name teammates the host is working on, as seat ids only',async()=>{
  const board=body=>createApi({fetchImpl:async()=>new Response(JSON.stringify(body),{status:200,headers:{'content-type':'application/json'}})});
  assert.deepEqual((await board({sessions:[],othersActing:['actor-2']}).request('adventure',session)).othersActing,['actor-2']);
  assert.equal((await board({sessions:[]}).request('adventure',session)).othersActing,undefined);
  for(const othersActing of [['',1],'actor-2',[{id:'actor-2'}]])
    await assert.rejects(board({sessions:[],othersActing}).request('adventure',session));
});

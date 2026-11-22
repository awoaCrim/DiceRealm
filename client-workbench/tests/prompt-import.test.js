import test from 'node:test';
import assert from 'node:assert/strict';
import {installDom,settle} from './dom-shim.mjs';
installDom();
const {renderPromptEditor,readPromptFile}=await import('../src/prompt-editor.js');
const file=(text,name='prompt.md')=>Object.assign(new Blob([text]),{name});
const button=(root,label)=>root.querySelectorAll('button').find(b=>b.textContent===label);
const area=root=>root.querySelector('.prompt-editor').querySelector('textarea');
const profile={contentId:'primary',contentVersion:3,prompt:'# 原文\n保留规则。',methods:[{id:'notes',description:'工作方法',content:'实际保存后才报告成功。'}],fingerprint:'fixture'};
const defaultCombatPrompt='内置战斗主持\n只承接实际交锋。';
function setup(extra={}){
  let view={settingsVersion:5,latestRevision:3,activeRevision:3,active:structuredClone(profile),draft:structuredClone(profile),matchesActive:true,defaultCombatPrompt};
  let draft,disposed=false;
  const calls=[],mount=document.createElement('div');
  const connection={settings:async()=>view,confirmed:()=>{},
    settingsDraft:async p=>{calls.push(['draft',structuredClone(p)]);draft=p;return {settings:{...view,settingsVersion:6}};},
    settingsPublish:async p=>{calls.push(['publish',p]);return {settings:{...view,settingsVersion:7,latestRevision:4}};},
    settingsActivate:async p=>{calls.push(['activate',p]);view={...view,settingsVersion:8,active:{...view.active,...draft},draft:{...view.active,...draft},activeRevision:4};return {settings:view};}};
  return {mount,calls,connection,dispose:()=>{disposed=true;mount.dispatchEvent(new Event('dispose'));},render:()=>renderPromptEditor(mount,{...extra,contentSettingsConnection:()=>connection},{isDisposed:()=>disposed})};
}
async function choose(mount,chosen){const input=mount.querySelector('input[type=file]');input.files=chosen?[chosen]:[];input.value='C:/fakepath/prompt.md';input.dispatchEvent({type:'change'});await settle();return input;}

function draftStorage(){
  const values=new Map();return {getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)};
}
const draftKey=scope=>'dicerealm.workbench.prompt-draft.v1.'+scope;

test('combat prompt is a separate imported draft, restores and saves without replacing exploration or methods',async()=>{
  const sessionStorage=draftStorage(),ctx={sessionStorage,scope:'combat-prompt'};
  const s=setup(ctx);await s.render();
  assert.match(s.mount.textContent,/战斗使用内置默认提示词/);
  const select=s.mount.querySelector('select[aria-label="正在编辑的主持提示词"]');
  select.value='combat';select.dispatchEvent({type:'change'});
  await choose(s.mount,file('  战斗独立原文\r\n交涉不能替玩家决定。\t','combat.md'));
  assert.equal(s.mount.querySelector('textarea[aria-label="战斗主持提示词全文"]').value,'  战斗独立原文\r\n交涉不能替玩家决定。\t');
  assert.equal(s.calls.length,0);s.dispose();
  const next=setup(ctx);await next.render();
  assert.equal(area(next.mount).value,'保留规则。');
  assert.equal(next.mount.querySelector('textarea[aria-label="战斗主持提示词全文"]').value,'  战斗独立原文\r\n交涉不能替玩家决定。\t');
  button(next.mount,'保存并应用').dispatchEvent({type:'click'});await settle();
  assert.equal(next.calls.length,3);
  assert.equal(next.calls[0][1].prompt,profile.prompt);
  assert.deepEqual(next.calls[0][1].methods,profile.methods);
  assert.equal(next.calls[0][1].combatPrompt,'  战斗独立原文\r\n交涉不能替玩家决定。\t');
  assert.equal(next.calls[0][1].contentVersion,4);
  assert.match(next.mount.textContent,/新行动使用已应用的正文；在途会话不变/);
  assert.doesNotMatch(next.mount.textContent,/还没有战斗主持提示词，遇到战斗时 AI 无法切换到独立战斗/);
  assert.equal(sessionStorage.getItem(draftKey(ctx.scope)),null);next.dispose();
});

test('saving only combat retains untouched exploration bytes and browser-normalized combat draft',async()=>{
  const s=setup(),original='# 探索\r\n原文不能因保存战斗而改写。\r\n';
  s.connection.settings=async()=>({settingsVersion:5,active:{...structuredClone(profile),prompt:original}});
  await s.render();
  const select=s.mount.querySelector('select[aria-label="正在编辑的主持提示词"]');
  select.value='combat';select.dispatchEvent({type:'change'});
  const combat='战斗独立正文\r\n保持换行。\r\n';await choose(s.mount,file(combat,'combat.md'));
  // Real textarea.value normalizes CRLF on assignment; the DOM shim does not.
  s.mount.querySelector('textarea[aria-label="战斗主持提示词全文"]').value=combat.replace(/\r\n/g,'\n');
  button(s.mount,'保存并应用').dispatchEvent({type:'click'});await settle();
  assert.equal(s.calls[0][1].prompt,original);assert.equal(s.calls[0][1].combatPrompt,combat);
  assert.deepEqual(s.calls[0][1].methods,profile.methods);s.dispose();
});

test('built-in combat is readable without saving and exploration edits do not pin the default',async()=>{
  const s=setup();await s.render();
  const select=s.mount.querySelector('select[aria-label="正在编辑的主持提示词"]');
  select.value='combat';select.dispatchEvent({type:'change'});
  assert.equal(s.mount.querySelector('textarea[aria-label="战斗主持提示词全文"]').value,defaultCombatPrompt);
  assert.equal(button(s.mount,'保存并应用').disabled,true);
  button(s.mount,'查看已应用原文').dispatchEvent({type:'click'});
  const dialog=document.body.querySelector('dialog');
  assert.equal(dialog.querySelector('pre').textContent,defaultCombatPrompt);
  assert.match(dialog.textContent,/内置默认/);
  dialog.querySelectorAll('button').find(b=>b.getAttribute('aria-label')==='关闭查看已应用原文').dispatchEvent({type:'click'});
  select.value='exploration';select.dispatchEvent({type:'change'});
  await choose(s.mount,file('# 探索\n新的探索要求'));
  button(s.mount,'保存并应用').dispatchEvent({type:'click'});await settle();
  assert.equal(s.calls[0][1].combatPrompt,undefined);
  assert.match(s.mount.textContent,/战斗使用内置默认提示词/);s.dispose();
});

test('clearing a custom combat prompt restores the default through the existing save chain',async()=>{
  const s=setup();
  s.connection.settings=async()=>({settingsVersion:5,active:{...structuredClone(profile),combatPrompt:'自定义原文'},defaultCombatPrompt});
  await s.render();
  const select=s.mount.querySelector('select[aria-label="正在编辑的主持提示词"]');
  select.value='combat';select.dispatchEvent({type:'change'});
  const combat=s.mount.querySelector('textarea[aria-label="战斗主持提示词全文"]');
  assert.equal(combat.value,'自定义原文');combat.value='';combat.dispatchEvent({type:'input'});
  button(s.mount,'保存并应用').dispatchEvent({type:'click'});await settle();
  assert.equal(s.calls[0][1].combatPrompt,undefined);assert.equal(s.calls[0][1].contentVersion,4);
  assert.equal(combat.value,defaultCombatPrompt);assert.match(s.mount.textContent,/战斗使用内置默认提示词/);s.dispose();
});

test('combat prompt wire fields are optional and do not alter legacy settings payloads',async()=>{
  const {prepare}=await import('../src/api.js');
  const payload={requestId:'request',expectedSettingsVersion:3,contentId:'primary',contentVersion:2,prompt:'探索',methods:[]};
  assert.deepEqual(prepare('settings-draft',payload),payload);
  assert.deepEqual(prepare('settings-draft',{...payload,combatPrompt:' 战斗\r\n '}),{...payload,combatPrompt:' 战斗\r\n '});
  const preset={id:'primary',version:2,systemPrompt:'探索',combatSystemPrompt:' 战斗\r\n '};
  assert.deepEqual(prepare('workspace-preview',{preset,skills:[]}),{preset,skills:[]});
});

test('editable system and exact active original stay distinct without a duplicate preview or arrow folds',async()=>{
  const s=setup();
  const raw='原文\r\n# 规则\r\n<b>普通文本</b>\r\n# 结尾';
  s.connection.settings=async()=>({settingsVersion:5,active:{...structuredClone(profile),prompt:raw}});
  await s.render();
  assert.equal(s.mount.querySelector('.prompt-injection-blocks'),null);
  assert.equal(s.mount.querySelectorAll('details').length,0);
  assert.match(s.mount.textContent,/systemInstruction.parts\[0\].text/);
  await choose(s.mount,file('# 新稿\n尚未采用'));
  button(s.mount,'查看已应用原文').dispatchEvent({type:'click'});
  const dialog=document.body.querySelector('dialog');
  assert.equal(dialog.querySelector('pre').textContent,raw,'current active bytes are not the normalized draft');
  assert.equal(dialog.querySelector('b'),null,'literal text is not markup');
  dialog.querySelectorAll('button').find(b=>b.getAttribute('aria-label')==='关闭查看已应用原文').dispatchEvent({type:'click'});
  button(s.mount,'AI 输入组成说明').dispatchEvent({type:'click'});
  assert.match(s.mount.textContent,/首条 user 消息中的 input、ruleset、memory/);
  assert.match(s.mount.textContent,/最后一条 user 消息，kind=execution_state/);
  assert.match(s.mount.textContent,/derived_context_extracts/);
  button(s.mount,'编辑主持要求').dispatchEvent({type:'click'});
  button(s.mount,'保存并应用').dispatchEvent({type:'click'});await settle();
  button(s.mount,'查看已应用原文').dispatchEvent({type:'click'});
  assert.equal(document.body.querySelector('dialog').querySelector('pre').textContent,s.calls[0][1].prompt);
  assert.equal(s.calls.length,3);s.dispose();
});

test('prompt page reads actual campaign-scoped requests, not current settings or a guessed next request',async()=>{
  const reads=[],summary={id:8,campaignId:'room',runId:'old-run',client:'GeminiHarnessModel',input:'检查矿坑',startedAt:'2026-10-14T12:00:00Z',finished:true,status:200,attempt:2};
  const request={systemInstruction:{parts:[{text:'# 旧冻结版本\n不是当前编辑稿'}]},contents:[
    {role:'user',parts:[{text:JSON.stringify({input:'检查矿坑',ruleset:'dnd2024',memory:{version:7,entries:['真实历史']}})}]},
    {role:'user',parts:[{text:JSON.stringify({kind:'execution_state',version:8,self:{hitPoints:4},supplies:{remaining:3}})}]}
  ],tools:[{functionDeclarations:[{name:'context_read',description:'读取',parametersJsonSchema:{type:'object'}}]}]};
  const s=setup({snapshot:{name:'测试战役'},read:async(key,p)=>{reads.push([key,p]);
    return key==='model-requests'?{requests:[summary],nextBefore:null}:{summary,requestBody:JSON.stringify(request),responseBody:'实际响应'};}});
  await s.render();assert.equal(reads.length,0,'request log is read only when selected');
  button(s.mount,'查看历史请求').dispatchEvent({type:'click'});await settle();
  assert.deepEqual(reads,[['model-requests',{limit:10,failed:false,before:null}]]);
  button(s.mount,'查看').dispatchEvent({type:'click'});await settle();
  const dialog=document.body.querySelector('dialog');
  assert.deepEqual(reads[1],['model-request',{requestId:8}]);
  assert.match(dialog.textContent,/旧冻结版本/);assert.match(dialog.textContent,/真实历史/);
  assert.match(dialog.textContent,/execution_state/);assert.match(dialog.textContent,/hitPoints/);
  assert.match(dialog.textContent,/context_read/);assert.doesNotMatch(dialog.textContent,/保留规则/);
  assert.equal(dialog.querySelectorAll('details').length,0);
  button(dialog,'原始请求 JSON').dispatchEvent({type:'click'});
  assert.deepEqual(JSON.parse(dialog.querySelector('.req-json').textContent),request);
  assert.equal(s.calls.length,0);s.dispose();assert.equal(document.body.querySelector('dialog'),null);
});

test('missing or failed request reads remain explicit and do not replace the editor',async()=>{
  for(const fails of [false,true]){
    const s=setup({read:async()=>{if(fails)throw Error('日志读取失败');return {requests:[],nextBefore:null};}});
    await s.render();await choose(s.mount,file('# 我的草稿\n必须保留'));
    button(s.mount,'查看历史请求').dispatchEvent({type:'click'});await settle();
    assert.match(s.mount.textContent,fails?/日志读取失败/:/还没有模型请求/);
    button(s.mount,'编辑主持要求').dispatchEvent({type:'click'});assert.equal(area(s.mount).value,'必须保留');
    assert.equal(s.calls.length,0);s.dispose();
  }
});

test('prompt drafts restore across page instances and refresh, isolated by account/campaign scope',async()=>{
  const sessionStorage=draftStorage(),ctx={sessionStorage,scope:'account-a-campaign-a'};
  const first=setup(ctx);await first.render();
  await choose(first.mount,file('# 草稿\n切页不能丢失。'));
  const method=first.mount.querySelectorAll('textarea').find(x=>x.getAttribute('aria-label')==='内容');
  method.value='未保存的方法';method.dispatchEvent({type:'input'});
  first.dispose();
  const restored=setup(ctx);await restored.render();
  assert.equal(area(restored.mount).value,'切页不能丢失。');
  assert.match(restored.mount.textContent,/未保存.*本标签页已保留/);
  assert.equal(restored.mount.querySelectorAll('textarea').find(x=>x.getAttribute('aria-label')==='内容').value,'未保存的方法');
  for(const scope of ['account-b-campaign-a','account-a-campaign-b']){
    const other=setup({sessionStorage,scope});await other.render();assert.equal(area(other.mount).value,'保留规则。');
  }
  button(restored.mount,'放弃草稿修改').dispatchEvent({type:'click'});
  assert.equal(sessionStorage.getItem(draftKey(ctx.scope)),null);
  const reset=setup(ctx);await reset.render();assert.equal(area(reset.mount).value,'保留规则。');
});

test('server version changes preserve the draft until explicitly adopting a base or discarding',async()=>{
  const sessionStorage=draftStorage(),ctx={sessionStorage,scope:'conflict'};
  const first=setup(ctx);await first.render();await choose(first.mount,file('# 草稿\n我的新文'));first.dispose();
  const next=setup(ctx);
  next.connection.settings=async()=>({settingsVersion:9,active:{...structuredClone(profile),prompt:'# 别人\n服务端新文'}});
  await next.render();assert.equal(area(next.mount).value,'我的新文');
  assert.equal(button(next.mount,'保存并应用').disabled,true);assert.match(next.mount.textContent,/服务端版本已变化/);
  button(next.mount,'刷新已应用内容').dispatchEvent({type:'click'});await settle();
  assert.equal(area(next.mount).value,'我的新文');assert.equal(button(next.mount,'保存并应用').disabled,true);
  button(next.mount,'保留草稿，覆盖新版本').dispatchEvent({type:'click'});
  assert.equal(button(next.mount,'保存并应用').disabled,false);
  assert.equal(JSON.parse(sessionStorage.getItem(draftKey(ctx.scope))).baseVersion,9);
  button(next.mount,'保存并应用').dispatchEvent({type:'click'});await settle();
  assert.equal(next.calls[0][1].expectedSettingsVersion,9);assert.equal(sessionStorage.getItem(draftKey(ctx.scope)),null);
});

test('confirmed late activation clears only its own persisted draft',async()=>{
  for(const newer of [false,true]){
    const sessionStorage=draftStorage(),ctx={sessionStorage,scope:'late-'+newer};
    const s=setup(ctx);await s.render();await choose(s.mount,file('# 新文\n冻结内容'));
    let finish;
    s.connection.settingsActivate=()=>new Promise(resolve=>{finish=resolve;});
    button(s.mount,'保存并应用').dispatchEvent({type:'click'});await settle();s.dispose();
    if(newer){const record=JSON.parse(sessionStorage.getItem(draftKey(ctx.scope)));record.prompt='# 新文\n更晚草稿';sessionStorage.setItem(draftKey(ctx.scope),JSON.stringify(record));}
    finish({settings:{}});await settle();
    if(newer)assert.match(sessionStorage.getItem(draftKey(ctx.scope)),/更晚草稿/);
    else assert.equal(sessionStorage.getItem(draftKey(ctx.scope)),null);
  }
});

test('a late activation settles a reopened editor without resurrecting the same draft or erasing newer input',async()=>{
  for(const newer of [false,true]){
    const sessionStorage=draftStorage(),ctx={sessionStorage,scope:'reopened-'+newer};
    const first=setup(ctx);await first.render();await choose(first.mount,file('# 新文\n冻结内容'));
    let finish;first.connection.settingsActivate=()=>new Promise(resolve=>{finish=resolve;});
    button(first.mount,'保存并应用').dispatchEvent({type:'click'});await settle();first.dispose();
    const next=setup(ctx);await next.render();
    if(newer)await choose(next.mount,file('# 新文\n保存之后的新输入'));
    finish({settings:{settingsVersion:8,active:{...structuredClone(profile),prompt:'# 新文\n冻结内容'}}});await settle();
    button(next.mount,'切换为全文编辑').dispatchEvent({type:'click'});
    if(newer){assert.match(sessionStorage.getItem(draftKey(ctx.scope)),/保存之后的新输入/);assert.equal(button(next.mount,'保存并应用').disabled,true);assert.match(next.mount.textContent,/版本已变化/);}
    else {assert.equal(sessionStorage.getItem(draftKey(ctx.scope)),null);assert.equal(button(next.mount,'保存并应用').disabled,true);assert.doesNotMatch(next.mount.textContent,/未保存|版本已变化/);}
    next.dispose();
  }
});

test('unavailable or corrupt browser draft storage is reported without overwriting the old record',async()=>{
  const sessionStorage=draftStorage(),scope='broken';sessionStorage.setItem(draftKey(scope),'{broken');
  const s=setup({sessionStorage,scope});await s.render();await choose(s.mount,file('# 编辑\n仍可编辑'));
  assert.match(s.mount.textContent,/草稿无法读取.*原记录已保留/);assert.equal(sessionStorage.getItem(draftKey(scope)),'{broken');
});

test('UTF-8 prompt files preserve literal text, reject malformed/empty/oversized input before changing the editor',async()=>{
  assert.equal(await readPromptFile(file('\uFEFF# 标题\r\n“<b>对白</b>”')),'# 标题\r\n“<b>对白</b>”');
  for(const source of ['', ' '.repeat(4), 'x'.repeat(32769),'正文\0尾巴'])await assert.rejects(readPromptFile(file(source)));
  await assert.rejects(readPromptFile({size:1024*1024+1,arrayBuffer:()=>assert.fail('must not read oversized file')}),/1 MiB/);
  await assert.rejects(readPromptFile(new Blob([new Uint8Array([0xff,0xfe,0x20])])),/UTF-8/);
  await assert.rejects(readPromptFile({size:1,arrayBuffer:async()=>{throw Error('read failed');}}),/无法读取/);
});

test('re-import changes only the prompt; save publishes a new version preserving working methods',async()=>{
  const s=setup();await s.render();
  const input=await choose(s.mount,file('# 叙事与对白\n只写当前场景。'));
  assert.equal(input.value,'','same filename can be selected again');assert.equal(s.calls.length,0);
  assert.equal(area(s.mount).value,'只写当前场景。');assert.equal(button(s.mount,'保存并应用').disabled,false);
  await choose(s.mount,file('# 叙事与对白\n文件已经再次修改。'));
  button(s.mount,'保存并应用').dispatchEvent({type:'click'});await settle();
  assert.deepEqual(s.calls.map(c=>c[0]),['draft','publish','activate']);
  assert.equal(s.calls[0][1].prompt,'# 叙事与对白\n文件已经再次修改。');
  assert.deepEqual(s.calls[0][1].methods,profile.methods);assert.equal(s.calls[0][1].contentVersion,4);
  assert.equal(s.calls[0][1].expectedSettingsVersion,5);assert.equal(s.calls[1][1].expectedSettingsVersion,6);
  assert.equal(s.calls[2][1].expectedSettingsVersion,7);assert.equal(s.calls[2][1].revision,4);
  assert.match(s.mount.textContent,/已保存并生效/);assert.equal(button(s.mount,'保存并应用').disabled,true);
});

test('cancel, bad file and late disposed read preserve the existing editor and never write',async()=>{
  const s=setup();await s.render();
  await choose(s.mount,file('# 编辑中\n保留我'));
  for(const source of [null,file(''),file('x'.repeat(32769))]){
    await choose(s.mount,source);assert.equal(area(s.mount).value,'保留我');
  }
  let finish;
  const pending={size:5,name:'late.md',arrayBuffer:()=>new Promise(resolve=>{finish=resolve;})};
  await choose(s.mount,pending);assert.equal(s.mount.querySelector('fieldset').disabled,true);
  s.dispose();finish(await file('# 迟到\n不得覆盖').arrayBuffer());await settle();
  assert.equal(area(s.mount).value,'保留我');assert.equal(s.calls.length,0);
});

test('save locks file/reload editing; a disposed page never continues publish or activation',async()=>{
  const s=setup();let finish,reads=0;
  s.connection.settings=async()=>{reads++;return {settingsVersion:5,active:structuredClone(profile)};};
  s.connection.settingsDraft=p=>{s.calls.push(['draft',structuredClone(p)]);return new Promise(resolve=>{finish=resolve;});};
  await s.render();await choose(s.mount,file('# 新文\n已冻结'));
  button(s.mount,'保存并应用').dispatchEvent({type:'click'});await settle();
  assert.equal(s.mount.querySelector('fieldset').disabled,true);
  await choose(s.mount,file('# 不应载入\n保存还在进行'));
  button(s.mount,'刷新已应用内容').dispatchEvent({type:'click'});await settle();
  assert.equal(reads,1);assert.equal(area(s.mount).value,'已冻结');
  s.dispose();finish({settings:{settingsVersion:6}});await settle();assert.equal(s.calls.length,1);
});

test('discard after import returns to the known active prompt; reload failure keeps local text',async()=>{
  const s=setup();await s.render();await choose(s.mount,file('# 新文\n未保存'));
  s.connection.settings=async()=>{throw Error('读取中断');};
  button(s.mount,'刷新已应用内容').dispatchEvent({type:'click'});await settle();
  assert.equal(area(s.mount).value,'未保存');assert.match(s.mount.textContent,/读取中断/);
  button(s.mount,'放弃草稿修改').dispatchEvent({type:'click'});
  assert.equal(area(s.mount).value,'保留规则。');assert.equal(button(s.mount,'保存并应用').disabled,true);assert.equal(s.calls.length,0);
});

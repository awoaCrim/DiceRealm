import test from 'node:test';
import assert from 'node:assert/strict';
import {installDom,settle} from './dom-shim.mjs';
import {describeRequest,describeResponse} from '../src/request-body.js';
import {splitPrompt,joinPrompt,splitPromptRaw} from '../src/prompt-sections.js';
installDom();
const {storyMessages,createStoryFeed,rollText}=await import('../src/story.js');
const {renderPromptEditor}=await import('../src/prompt-editor.js');
const {requestLogCard,outcomeLabel}=await import('../src/request-log.js');

test('a Gemini request is split into system prompt, turns, tools and parameters',()=>{
  const body={systemInstruction:{parts:[{text:'你是 DM。'}]},
    contents:[{role:'user',parts:[{text:'{"input":"这是哪里"}'}]},{role:'model',parts:[{thought:true,text:'想一想'},{functionCall:{name:'actions_propose',args:{candidateId:'option-0'}}}]},
      {role:'user',parts:[{functionResponse:{name:'actions_propose',response:{ok:true}}}]}],
    tools:[{functionDeclarations:[{name:'actions_propose',description:'提交候选',parametersJsonSchema:{type:'object'}}]}],
    generationConfig:{thinkingConfig:{thinkingLevel:'high'}}};
  const sections=describeRequest(JSON.stringify(body));
  assert.deepEqual(sections.map(s=>s.title),['系统提示词','对话内容（3 条）','工具定义（1 个）','生成参数']);
  assert.equal(sections[0].items[0].text,'你是 DM。');
  const turns=sections[1].items;
  assert.deepEqual(turns[0].json,{input:'这是哪里'},'JSON player turns are shown structured');
  assert.equal(turns[1].label,'#2 model · 思考');
  assert.equal(turns[2].label,'#2 model · 调用工具 actions_propose');assert.deepEqual(turns[2].json,{candidateId:'option-0'});
  assert.equal(turns[3].label,'#3 user · 工具结果 actions_propose');
  assert.equal(sections[2].items[0].label,'actions_propose');assert.deepEqual(sections[2].items[0].json,{type:'object'});
});
test('OpenAI requests/responses and errors are readable; unknown text stays raw',()=>{
  const sections=describeRequest(JSON.stringify({model:'m',messages:[{role:'system',content:'规则'},{role:'assistant',content:null,tool_calls:[{function:{name:'world_record',arguments:'{"narrative":"雾"}'}}]}],tools:[]}));
  assert.deepEqual(sections.map(s=>s.title),['系统提示词','消息（1 条）','工具定义（0 个）','参数']);
  assert.equal(sections[0].items[0].text,'规则');
  assert.equal(sections[1].items[0].label,'#2 调用工具 world_record');assert.deepEqual(sections[1].items[0].json,{narrative:'雾'});
  assert.equal(describeResponse(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'好'}}],usage:{total_tokens:3}}))[0].note,'stop');
  assert.deepEqual(describeResponse(JSON.stringify({error:{message:'bad key'}}))[0].items[0].json,{message:'bad key'});
  assert.equal(describeResponse('upstream error: do request failed')[0].items[0].text,'upstream error: do request failed');
  assert.deepEqual(describeResponse(''),[]);
  const gemini=describeResponse(JSON.stringify({candidates:[{finishReason:'STOP',content:{parts:[{text:'叙事'}]}}],usageMetadata:{totalTokenCount:9}}));
  assert.equal(gemini[0].items[0].text,'叙事');assert.deepEqual(gemini[1].items[0].json,{totalTokenCount:9});
});
test('response readers omit missing usage while preserving reported zero usage and tool labels',()=>{
  for(const [body,key,zero] of [
    [{choices:[{message:{content:'回复正文'}}]},'usage',{total_tokens:0}],
    [{candidates:[{content:{parts:[{text:'回复正文'},{thought:true,text:'思考正文'},{functionCall:{name:'rules_lookup',args:{query:'动作'}}}]}}]},'usageMetadata',{totalTokenCount:0}]
  ]){
    for(const missing of [undefined,null,{}]){
      const result=describeResponse(JSON.stringify({...body,[key]:missing}));
      assert.deepEqual(result.map(section=>section.title),['回复']);
      assert.equal(result[0].items[0].label,'');assert.equal(result[0].items[0].text,'回复正文');
      if(key==='usageMetadata')assert.deepEqual(result[0].items.slice(1).map(item=>item.label),['思考','调用工具 rules_lookup']);
    }
    const result=describeResponse(JSON.stringify({...body,[key]:zero}));
    assert.deepEqual(result[1].items[0].json,zero);
  }
});
test('system preview and both wire readers use exact original slices, without synthetic separators',()=>{
  for(const prompt of ['', '开头\r\n# 原则\r\n<b>不执行</b>\r\n# 收尾', '# A\n\n# B\n最后\n', '{"不是":"动态注入"}']){
    const blocks=splitPromptRaw(prompt);
    assert.equal(blocks.map(b=>b.text).join(''),prompt);
    assert.ok(blocks.every(b=>b.title===null||!b.title.includes('\r')));
    for(const body of [{systemInstruction:{parts:[{text:prompt}]},contents:[]}, {messages:[{role:'system',content:prompt}]}]){
      const items=describeRequest(JSON.stringify(body))[0].items;
      assert.deepEqual(items.map(i=>i.text),blocks.map(b=>b.text));
      assert.equal(items.map(i=>i.text).join(''),prompt);
    }
  }
  const gemini=describeRequest(JSON.stringify({systemInstruction:{parts:[{text:'# A\n一'},{text:'# B\r\n二'}]},contents:[]}));
  assert.equal(gemini[0].items.map(i=>i.text).join(''),'# A\n一# B\r\n二');
  const openai=describeRequest(JSON.stringify({messages:[{role:'system',content:[{type:'text',text:'# A\n一'},{type:'text',text:'# B\r\n二'}]},{role:'user',content:'不入system'}]}));
  assert.equal(openai[0].items.map(i=>i.text).join(''),'# A\n一# B\r\n二');
  assert.equal(openai[1].items[0].text,'不入system');
});
test('prompt sections round-trip byte for byte and keep headings on their own line',()=>{
  for(const text of ['','只有开头','# A\n正文\n\n# B\n第二段\n','开头\n# A\nx','# A','# A\n','# A\n\n# B'])
    assert.equal(joinPrompt(splitPrompt(text)),text,JSON.stringify(text));
  const sections=splitPrompt('开头\n# 主持原则\n- 规则\n# 文风\n- 白描\n');
  assert.deepEqual(sections.map(s=>s.title),[null,'主持原则','文风']);
  sections[1].body='- 改过的规则';sections.push({title:'新段落',body:'内容',hasBreak:true});
  assert.equal(joinPrompt(sections),'开头\n# 主持原则\n- 改过的规则\n# 文风\n- 白描\n# 新段落\n内容');
  assert.equal(splitPrompt('a\r\n# B\r\nc')[1].body,'c','CRLF is normalized');
});

const entry=(sequence,extra={})=>({sequence,version:sequence,actorId:'p1',createdAt:'2026-10-05T12:00:00Z',kind:'harness',status:'completed',
  origin:{input:'我看看码头',actorName:'xxk'},narrative:'咸湿的风扑面而来。\n\n远处灯塔黑着。',...extra});
test('combat continuations keep one player input and a separate tail reply',async()=>{
  const parent=entry(3,{actionId:'parent',narrative:''});
  const child=entry(4,{actionId:'child',continuationOf:3,narrative:'交锋开始。'});
  const later=entry(7,{actionId:'later',origin:{input:'我退开。'},narrative:'你已撤离。'});
  const returned=entry(9,{actionId:'parent',continuationOf:3,narrative:'现在停在路边。'});
  const before=JSON.stringify([parent,child,later,returned]);
  const ctx={snapshot:{party:{isHost:false,members:[]}},read:async()=>({nextAfter:9,hasMore:false,entries:[returned,parent,later,child]})};
  const feed=createStoryFeed(ctx,{isDisposed:()=>false});await feed.loadLatest(9);
  assert.equal(feed.element.querySelectorAll('.msg-player').length,2);
  assert.deepEqual(feed.element.querySelectorAll('.msg-dm').map(n=>n.querySelectorAll('p').map(p=>p.textContent).join('')),['交锋开始。','你已撤离。','现在停在路边。']);
  assert.deepEqual(feed.element.querySelectorAll('.msg-group').map(n=>n.dataset.sequence),['3','4','7','9']);
  assert.equal(JSON.stringify([parent,child,later,returned]),before);
  feed.dispose?.();
});
test('equipment controls do not become conversation but explicit input and other actions still do',()=>{
  for(const kind of ['character.equip','character.loadout','character.wear','character.unpack','equipment.equip','equipment.armor']){
    const saved=entry(3,{kind,origin:{input:'  ',label:'equip · shortsword',actorName:'xxk'},initialResult:{summary:'经过 0 秒。未自动攻击。'},narrative:'经过 0 秒。未自动攻击。'});
    const before=JSON.stringify(saved);
    assert.deepEqual(storyMessages(saved,{}),[]);assert.equal(JSON.stringify(saved),before,'audit data is not mutated');
    saved.origin.input='我拔出短剑走向门口';assert.ok(storyMessages(saved,{}).some(n=>n.textContent.includes(saved.origin.input)));
    saved.origin.input='';saved.initialResult.intentId='natural-root';assert.ok(storyMessages(saved,{}).length);
  }
  for(const kind of ['intent.request','character.spell','character.use','character.attunement','combat.attack'])
    assert.ok(storyMessages(entry(1,{kind,origin:{label:'实际行动'},privateText:'私密记录',status:'awaiting_roll'}),{}).length,kind);
});
test('equipment-only window leaves no empty groups and still pages back to real story',async()=>{
  const gear=Array.from({length:50},(_,i)=>entry(i+51,{kind:'character.loadout',origin:{label:'使用近战'},narrative:'未自动攻击。'}));
  const reads=[];const ctx={snapshot:{party:{isHost:false,members:[]}},read:async(endpoint,p)=>{
    reads.push(p);return {nextAfter:p.through,hasMore:false,entries:[entry(1),...gear].filter(e=>e.sequence>p.after&&e.sequence<=p.through)};
  }};
  const feed=createStoryFeed(ctx,{isDisposed:()=>false});await feed.loadLatest(100);
  assert.equal(feed.element.querySelectorAll('.msg-group').length,0);assert.match(feed.element.textContent,/还没有剧情记录/);
  const older=feed.element.querySelectorAll('button').find(b=>b.textContent==='更早的记录');assert.equal(older.hidden,false);
  older.dispatchEvent({type:'click'});await settle();
  assert.deepEqual(reads,[{after:50,through:100},{after:0,through:50}]);assert.equal(feed.element.querySelectorAll('.msg-group').length,1);
  assert.match(feed.element.textContent,/我看看码头/);assert.doesNotMatch(feed.element.textContent,/未自动攻击/);
});
test('one activity entry becomes player line, roll, DM narration, private note and waiting state',()=>{
  const box=document.createElement('div');
  box.append(...storyMessages(entry(3,{status:'awaiting_ruling',privateText:'你注意到木板下有绿光。',
    initialResult:{check:{ability:'wisdom',skill:'Perception',rolls:[12],modifier:3,total:15,dc:13,success:true,hasDc:true}}}),{party:{selfActorId:'p1',members:[]}}));
  const text=box.textContent;
  for(const part of ['xxk','我看看码头','察觉检定','d20 12 + 3 = 15','DC 13','咸湿的风扑面而来。','远处灯塔黑着。','仅你和主持可见','你注意到木板下有绿光。','等待裁定'])
    assert.ok(text.includes(part),part);
  const privateLine=box.querySelector('.msg-private');
  assert.equal(privateLine.querySelector('p').children[0].classList.contains('secret-tag'),true,'the visibility tag opens the private paragraph instead of boxing it');
  assert.ok(text.indexOf('我看看码头')<text.indexOf('察觉检定')&&text.indexOf('察觉检定')<text.indexOf('咸湿的风'),'order follows what happened');
  assert.equal(rollText({ability:'dexterity',skill:'',total:9,hasDc:false,rolls:[],testKind:'save'}),'敏捷豁免 · DC — · 掷骰 9');
});
test('saved host responses, check receipts and authorized private text remain visible without a story followup',()=>{
  const ruling={status:'resolved',outcome:'check',rationale:'主持已回应，不应要求再做一次收尾。',privateText:'仅本人获知',
    check:{ability:'intelligence',skill:'Arcana',rolls:[13],modifier:2,total:15,dc:14,hasDc:true,success:true}};
  // Current API supplies exact private parts; legacy convenience fields must not duplicate them.
  const privateParts=[{actorId:'p1',text:ruling.privateText,source:{kind:'ruling',id:'r1',sequence:1,revision:'a'.repeat(64)}}];
  const box=document.createElement('div');box.append(...storyMessages(entry(1,{ruling,privateText:ruling.privateText,privateParts}),{}));
  assert.match(box.textContent,/主持回应/);assert.match(box.textContent,/主持已回应/);assert.match(box.textContent,/DC 14/);
  assert.equal(box.querySelectorAll('.msg-private').length,1);assert.equal(box.textContent.split('仅本人获知').length,2);
  const guest=document.createElement('div');guest.append(...storyMessages(entry(2,{ruling:{...ruling,privateText:''}}),{}));
  assert.doesNotMatch(guest.textContent,/仅本人获知/);
});

test('opposed roll cards retain the saved numeric thresholds without inventing a single DC',()=>{
  assert.equal(rollText({ability:'wisdom',skill:'Perception',total:18,hasDc:false,difficultyClasses:[16,20]}),'察觉检定 · DC 16 / 20 · 掷骰 18');
});

test('check lines read in one line: who, check, authoritative DC, saved dice and the server verdict stamp',()=>{
  for(const extra of [
    {hasDc:true,success:true,dc:13},
    {hasDc:true,success:false,dc:20},
    {hasDc:false,success:false,dc:0,testKind:'save'}
  ]){
    const check={ability:'dexterity',rolls:[4,18],modifier:-2,total:16,...extra};
    const card=storyMessages(entry(1,{initialResult:{check}}),{}).find(node=>node.classList.contains('msg-roll'));
    assert.equal(card.getAttribute('aria-label'),'xxk · '+rollText(check));
    const part=name=>card.querySelector('.roll-'+name)?.textContent??null;
    assert.equal(part('name'),'xxk');
    assert.equal(part('label'),'敏捷'+(extra.testKind==='save'?'豁免':'检定'));
    assert.equal(part('dc'),'DC '+(extra.hasDc?extra.dc:'—'));
    assert.equal(part('math'),'d20 4/18 − 2 = 16','saved dice and modifier only');
    assert.equal(part('result'),extra.hasDc?(extra.success?'成功':'失败'):null,'the stamp is the server verdict against one DC');
    assert.equal(card.getAttribute('title'),'d20 4/18 −2');
    if(!extra.hasDc){assert.doesNotMatch(card.textContent,/DC 0|失败|待 DM 判定|未指定难度/);assert.match(card.textContent,/敏捷豁免/);}
    assert.equal(card.querySelectorAll('button').length,0);
  }
});
test('automatic failure card never invents a die or a total',()=>{
  const check={ability:'dexterity',testKind:'save',mode:'automatic-failure',hasDc:true,dc:12,total:0,rolls:[],success:false};
  const card=storyMessages(entry(1,{initialResult:{check}}),{}).find(node=>node.classList.contains('msg-roll'));
  assert.equal(card.querySelector('.roll-math').textContent,'未掷骰');assert.equal(card.querySelector('.roll-result').textContent,'失败');
  assert.doesNotMatch(card.textContent,/d20|= 0|掷骰 0/);
  assert.equal(card.getAttribute('title'),null);
  assert.doesNotMatch(card.getAttribute('aria-label'),/= 0|d20/);
});
test('the feed loads the newest window, pages older entries and appends new versions once',async()=>{
  const reads=[],all=Array.from({length:120},(_,i)=>entry(i+1,{origin:{input:'第'+(i+1)+'句',actorName:'xxk'}}));
  const ctx={snapshot:{party:{isHost:false,members:[]}},read:async(endpoint,p)=>{reads.push(p);assert.equal(endpoint,'activity');
    const entries=all.filter(e=>e.sequence>p.after&&e.sequence<=p.through);
    return {after:p.after,nextAfter:p.through,through:p.through,hasMore:false,entries};}};
  const feed=createStoryFeed(ctx,{isDisposed:()=>false});
  await feed.loadLatest(100);
  assert.deepEqual(reads[0],{after:50,through:100});
  const text=()=>feed.element.textContent;
  assert.ok(text().includes('第100句')&&text().includes('第51句')&&!text().includes('第50句'));
  feed.element.querySelectorAll('button').find(b=>b.textContent==='更早的记录').dispatchEvent({type:'click'});await settle();
  assert.deepEqual(reads[1],{after:0,through:50});assert.ok(text().includes('第1句'));
  await feed.loadLatest(100);assert.equal(reads.length,2,'an unchanged version reads nothing');
  all[10].narrative='旧行动的新回应';
  await feed.loadLatest(120);assert.deepEqual(reads[2],{after:0,through:120});
  assert.ok(text().includes('旧行动的新回应'),'later replies refresh their original root');
  assert.equal(text().split('第120句').length,2,'each entry appears once');
  assert.ok(text().indexOf('第1句')<text().indexOf('第120句'),'oldest first, newest at the bottom');
});

test('the time column shows each minute once, with the full time on hover',async()=>{
  const at=(sequence,createdAt)=>entry(sequence,{actionId:'a'+sequence,createdAt});
  const ctx={snapshot:{party:{isHost:false,members:[]}},read:async()=>({nextAfter:3,hasMore:false,entries:[at(1,'2026-10-05T12:00:05Z'),at(2,'2026-10-05T12:00:40Z'),at(3,'2026-10-05T12:01:00Z')]})};
  const feed=createStoryFeed(ctx,{isDisposed:()=>false});await feed.loadLatest(3);
  const clocks=feed.element.querySelectorAll('.msg-time');
  assert.equal(clocks.filter(n=>n.textContent).length,2,'one clock per minute');
  assert.ok(clocks.every(n=>n.getAttribute('title')),'every line keeps its exact time on hover');
});
test('a version arriving during an activity read is fetched after it settles',async()=>{
  let release;const gate=new Promise(resolve=>{release=resolve;}),reads=[];
  const ctx={snapshot:{party:{isHost:false,members:[]}},read:async(endpoint,p)=>{
    reads.push(p);if(reads.length===1)await gate;
    return {nextAfter:p.through,hasMore:false,entries:[entry(p.through)]};
  }};
  const feed=createStoryFeed(ctx,{isDisposed:()=>false});
  const first=feed.loadLatest(40);await feed.loadLatest(41);release();await first;await settle();
  assert.deepEqual(reads,[{after:0,through:40},{after:0,through:41}]);
  assert.equal(feed.element.querySelectorAll('.msg-group').length,2);
});

test('resolved text responses offer optional story changes in history, never a forced second task',async()=>{
  const ruling={id:'narrative-ruling',status:'resolved',outcome:'narrative',story:null};
  const opened=[];
  const ctx={snapshot:{party:{isHost:true}},read:async()=>({nextAfter:1,hasMore:false,entries:[entry(1,{ruling})]})};
  const feed=createStoryFeed(ctx,{isDisposed:()=>false,openStory:r=>opened.push(r)});
  await feed.loadLatest(1);
  const button=feed.element.querySelectorAll('button').find(b=>b.textContent==='追加剧情变化（可选）');
  assert.ok(button);assert.equal(opened.length,0);
  button.dispatchEvent({type:'click'});assert.deepEqual(opened,[ruling]);
  ruling.outcome='check';ruling.effectsRequestId='already-settled-effect';
  const applied=createStoryFeed(ctx,{isDisposed:()=>false,openStory:r=>opened.push(r)});await applied.loadLatest(1);
  assert.match(applied.element.textContent,/追加剧情变化（可选）/,'character effects do not close optional story changes');
  ctx.snapshot.party.isHost=false;
  const guest=createStoryFeed(ctx,{isDisposed:()=>false,openStory:()=>assert.fail('guest')});
  await guest.loadLatest(1);assert.doesNotMatch(guest.element.textContent,/追加剧情变化/);
});

const settingsView=(version,prompt)=>({settingsVersion:version,activeRevision:1,latestRevision:version,matchesActive:true,
  draft:{contentId:'primary',contentVersion:1,prompt,methods:[],fingerprint:'f'},active:{contentId:'primary',contentVersion:1,prompt,methods:[],fingerprint:'f'}});
test('prompt editor edits a section and saves through draft, publish and activate in order',async()=>{
  const calls=[];let view=settingsView(1,'# 主持原则\n- 规则\n# 文风\n- 白描');
  const connection={settings:async()=>view,confirmed:()=>{},
    settingsDraft:async p=>{calls.push(['draft',p]);return {settings:{...view,settingsVersion:2},replayed:false};},
    settingsPublish:async p=>{calls.push(['publish',p]);return {settings:{...view,settingsVersion:3,latestRevision:2},replayed:false};},
    settingsActivate:async p=>{calls.push(['activate',p]);view=settingsView(4,'# 主持原则\n- 新规则\n# 文风\n- 白描');return {settings:view,replayed:false};}};
  const mount=document.createElement('div');
  await renderPromptEditor(mount,{contentSettingsConnection:()=>connection},{isDisposed:()=>false});
  const save=mount.querySelectorAll('button').find(b=>b.textContent==='保存并应用');
  assert.equal(save.disabled,true,'nothing to save before an edit');
  const body=mount.querySelectorAll('textarea')[0];body.value='- 新规则';body.dispatchEvent({type:'input'});
  assert.equal(save.disabled,false);
  save.dispatchEvent({type:'click'});await settle();
  assert.deepEqual(calls.map(c=>c[0]),['draft','publish','activate']);
  assert.equal(calls[0][1].prompt,'# 主持原则\n- 新规则\n# 文风\n- 白描');
  assert.equal(calls[0][1].expectedSettingsVersion,1);assert.equal(calls[0][1].contentVersion,2,'a changed prompt gets a new content version');
  assert.equal(calls[1][1].expectedSettingsVersion,2);
  assert.equal(calls[2][1].expectedSettingsVersion,3);assert.equal(calls[2][1].revision,2,'activates the revision just published');
  assert.ok(mount.textContent.includes('已保存并生效'));assert.equal(save.disabled,true);
});
test('prompt directory edits one section at a time without dropping the other sections or methods',async()=>{
  const prompt='开场原文\n# 原则\n守住规则\n# 文风\n描述环境';
  const view=settingsView(1,prompt);view.active.methods=[{id:'reference',description:'按需参考',content:'不自动注入'}];view.draft.methods=view.active.methods;
  const mount=document.createElement('div');await renderPromptEditor(mount,{contentSettingsConnection:()=>({settings:async()=>view})},{isDisposed:()=>false});
  const choose=async index=>{mount.querySelectorAll('.outline-section-item')[index].dispatchEvent({type:'click'});await settle();};
  assert.equal(mount.querySelector('.prompt-editor').querySelectorAll('textarea').length,1);
  await choose(1);let body=mount.querySelector('.prompt-editor').querySelector('textarea');assert.equal(body.value,'守住规则\n');
  body.value='修改后的规则\n';body.dispatchEvent({type:'input'});
  await choose(2);assert.equal(mount.querySelector('.prompt-editor').querySelector('textarea').value,'描述环境');
  await choose(1);assert.equal(mount.querySelector('.prompt-editor').querySelector('textarea').value,'修改后的规则\n');
  mount.querySelectorAll('button').find(b=>b.textContent==='切换为全文编辑').dispatchEvent({type:'click'});
  assert.equal(mount.querySelector('.prompt-raw').value,'开场原文\n# 原则\n修改后的规则\n# 文风\n描述环境');
  assert.equal(mount.querySelector('.method-list').querySelector('textarea').value,'不自动注入');
});

test('request log lists newest first, filters failures and opens one request in detail',async()=>{
  const requests=[{id:2,startedAt:'2026-10-05T15:00:51Z',client:'GeminiHarnessModel',campaignId:'c',runId:'r',input:'这是哪里',attempt:4,method:'POST',url:'https://p/v1beta?key=***',
    status:null,error:'请求被取消（单次超时或本轮结束）',durationMs:180000,requestBytes:10,responseBytes:0,finished:true},
    {id:1,startedAt:'2026-10-05T15:00:00Z',client:'OpenAiText',campaignId:'',runId:'',input:'',attempt:1,method:'POST',url:'https://p/v1',status:200,error:'',durationMs:900,requestBytes:5,responseBytes:5,finished:true}];
  const lists=[];
  const mount=document.createElement('div');
  const log=requestLogCard(mount,{list:async p=>{lists.push(p);return {requests:p.failed?requests.slice(0,1):requests,nextBefore:null};},
    detail:async id=>({summary:requests.find(r=>r.id===id),requestBody:JSON.stringify({systemInstruction:{parts:[{text:'你是 DM'}]},contents:[]}),responseBody:''})});
  await log.reload();
  assert.ok(mount.textContent.indexOf('“这是哪里”')<mount.textContent.indexOf('行动理解/叙事（旧接口）'));
  assert.ok(mount.textContent.includes('180.0 秒')&&mount.textContent.includes('请求被取消'));
  const filter=mount.querySelectorAll('input').find(i=>i.attrs['aria-label']==='只看 HTTP 失败的请求');
  filter.checked=true;filter.dispatchEvent({type:'change'});await settle();
  assert.equal(lists[1].failed,true);
  mount.querySelectorAll('button').find(b=>b.textContent==='查看').dispatchEvent({type:'click'});await settle();
  const dialog=document.body.querySelector('dialog');
  assert.ok(dialog.querySelector('.trace-reader'));
  assert.equal(dialog.querySelectorAll('.trace-choice').length,1);
  assert.ok(dialog.textContent.includes('没有可显示的响应正文'));
  dialog.querySelectorAll('button').find(b=>b.textContent==='请求').dispatchEvent({type:'click'});
  assert.ok(dialog.textContent.includes('系统提示词')&&dialog.textContent.includes('你是 DM'));
  assert.equal(dialog.querySelectorAll('details').length,0);
  assert.ok(dialog.textContent.includes('复制请求原文'));
  dialog.querySelectorAll('button').find(b=>b.textContent==='概况').dispatchEvent({type:'click'});
  assert.ok(dialog.textContent.includes('第几次尝试'));
  assert.equal(dialog.querySelectorAll('.req-section').length,0);
  assert.equal(outcomeLabel({...requests[1],finished:false}),'进行中…');
  assert.equal(outcomeLabel(requests[1]),'HTTP 200');
  assert.ok(mount.textContent.includes('HTTP 成功不等于行动已保存'));
  mount.dispatchEvent({type:'dispose'});
});

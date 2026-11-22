import test from 'node:test';
import assert from 'node:assert/strict';
import {installDom,settle} from './dom-shim.mjs';
installDom();
const {dialogueParts,storyParagraphs,proseText}=await import('../src/story-dialogue.js');
const {characterSheet}=await import('../src/character-sheet.js');
const {renderStory,storyMessages}=await import('../src/story.js');
const {createHostTasks,openIntentTask}=await import('../src/pending-panel.js');
const {createDialogHost,createDrawerHost}=await import('../src/workspace-dialog.js');
const {initial}=await import('../src/dom.js');
const click=(root,label)=>{const b=root.querySelectorAll('button').find(b=>b.textContent===label);assert.ok(b,label);b.dispatchEvent({type:'click'});};
const character={id:'c1',name:'同名旅人',species:'Human',className:'Wizard',background:'Sage',level:2,hitPoints:9,maxHitPoints:15,armorClass:13,
  abilities:[{name:'intelligence',score:16,modifier:3}],features:['奥术恢复'],conditions:['poisoned'],temporaryHitPoints:3,
  concentration:{spellId:'bless',source:'XPHB',expiresAtSeconds:180},effects:[{id:'aid',name:'Aid',expiresAtSeconds:120}],
  resources:[{name:'Hit Dice (d6)',current:1,maximum:2,recovery:'long'}],inventory:[{id:'dagger',name:'Dagger',quantity:2,equipped:true}],
  spellcasting:{ability:'intelligence',attackBonus:5,saveDc:13,spells:[{id:'light',name:'Light',level:0,prepared:true,summary:'权威说明',castingTime:'动作',source:'XPHB'}]},
  buildMechanics:{skills:[{id:'arcana',name:'Arcana',modifier:5,proficient:true}],savingThrows:[{ability:'wisdom',modifier:2,proficient:true}],
    spellGrants:[{id:'light',source:'物种特性',ability:'charisma',mode:'cantrip',attackBonus:3,saveDc:11}]},
  build:{identity:{name:'同名旅人',appearance:'灰斗篷',personality:'谨慎',backstory:'来自海港'}}};
const references=(s,actorId)=>({version:s.version,actorId,characterId:'c1',notice:'',featureDetails:[{index:0,name:'奥术恢复',text:'完整规则正文 <b>不是HTML</b>',notice:'',group:'职业能力'}]});
test('ability rules use original feature indices, stable keys, acquired groups and safe full text',()=>{
  const rules={notice:'',featureDetails:[{index:2,name:'机智',text:'# 机智\n**完整** <img src=x> 正文',notice:'',group:'物种能力'},
    {index:0,name:'战斗风格',text:'职业正文',notice:'',group:'职业能力'}]};
  const root=characterSheet({...character,features:['Fighting Style',null,'Resourceful','unknown']},{rules,section:'features',selection:'feature:2'});
  assert.equal(root.querySelector('.sheet-body').dataset.entry,'feature:2');
  assert.match(root.querySelector('.sheet-reader').textContent,/完整 <img src=x> 正文/);
  assert.equal(root.querySelectorAll('img').length,0);assert.doesNotMatch(root.querySelector('.sheet-reader').textContent,/#|\*\*/);
  assert.deepEqual(root.querySelectorAll('.sheet-entry').map(b=>b.dataset.sheetEntry),['feature:2','feature:0','feature:3']);
  click(root,'unknown');assert.match(root.querySelector('.sheet-reader').textContent,/尚未匹配/);
});

const entry={sequence:1,actionId:'a1',actorId:'p1',origin:{actorName:'同名旅人',input:'看看码头'},narrative:'守卫抬头。“说吧。”他放下笔。',status:'completed'};
const snapshot=()=>({id:'test',version:1,elapsedSeconds:60,party:{isHost:true,members:[{id:'p1',character:structuredClone(character)},{id:'p2',character:{...structuredClone(character),hitPoints:4}}]},pendingRulings:[]});

test('ruling reader keeps the current pending action visible as literal text without writing',async()=>{
  const ruling={id:'reader-ruling',actorId:'p1',status:'pending',text:'我查看 <b>箱子</b>。\n先不打开。',reason:'移动箱子会不会惊动守卫？'};
  const state=snapshot();state.pendingRulings=[ruling];
  const ctx={snapshot:state,read:()=>assert.fail('legacy action has no trace to load'),submit:()=>assert.fail('opening must not submit')};
  let body;const host={open:({render})=>{body=document.createElement('div');render({body,isDisposed:()=>false});}};
  openIntentTask(ctx,()=>false,{...ruling,text:'旧内容'},null,host);
  assert.equal(body.querySelector('.ruling-intent-text').textContent,ruling.text);
  assert.equal(body.querySelectorAll('b').length,0);
  assert.ok(body.textContent.includes(ruling.reason));
  assert.ok(body.querySelector('form'));
  ruling.originSequence=1;ctx.read=async()=>({origin:{input:ruling.text},initialResult:{},legacy:false});
  openIntentTask(ctx,()=>false,ruling,null,host);await settle();
  assert.equal(body.textContent.split(ruling.text).length-1,1,'the traced action must not be duplicated');
  ruling.status='resolved';
  openIntentTask(ctx,()=>false,ruling,null,host);
  assert.equal(body.querySelector('form'),null);assert.match(body.textContent,/请求状态已变化/);
});

test('matched quotations preserve literal source; incomplete quotes stay plain',()=>{
  for(const text of ['他说：“<b>不是HTML</b>。”然后走开。','「一」『二』"three"','没有结束的“引号','a\n\nb','']){
    const parts=dialogueParts(text);assert.equal(parts.map(p=>p.text).join(''),text);
    if(text==='没有结束的“引号')assert.ok(parts.every(p=>!p.dialogue));
  }
  const root=document.createElement('div');root.append(...storyParagraphs('他说：“<img src=x>”\n\n「第二段」'));
  assert.equal(root.querySelectorAll('p').length,2);assert.equal(root.querySelectorAll('.story-dialogue').length,2);
  assert.equal(root.querySelectorAll('img').length,0);assert.match(root.textContent,/<img src=x>/);
});

test('prose hides paired bold markers without rewriting player input or interpreting HTML',()=>{
  const raw='伤势 **5/10**。他说：“**<img src=x>**”\n\n未闭合 **标记';
  const record={...entry,narrative:raw,privateText:'**仅本人**',origin:{...entry.origin,input:'**我的原话**'}};
  const root=document.createElement('div');root.append(...storyMessages(record,snapshot()));
  assert.match(root.querySelector('.msg-player').textContent,/\*\*我的原话\*\*/);
  assert.match(root.querySelector('.msg-dm').textContent,/伤势 5\/10/);
  assert.match(root.querySelector('.msg-dm').textContent,/<img src=x>/);
  assert.equal(root.querySelectorAll('img').length,0);
  assert.match(root.querySelector('.msg-private').textContent,/仅本人/);
  assert.equal(record.narrative,raw);
  assert.equal(proseText("**保留\\**"),"**保留\\**");
  for(const text of ['**未闭合','***不是双星***','\\**保留**','**跨\n行**'])assert.equal(proseText(text),text);
});

test('an answer to the host follows the player\'s words; a place\'s arrival reads as narration',()=>{
  const asked={...entry,origin:{...entry.origin,clarifications:[{question:'',answer:'那我跟上去，先不进门。'}]}};
  const rows=storyMessages(asked,snapshot());
  assert.deepEqual(rows.filter(r=>r.classList.contains('msg-player')).map(r=>r.textContent.replace(/\d\d:\d\d$/,'')),
    ['同名旅人：看看码头','同名旅人：回答主持那我跟上去，先不进门。']);
  const travel={sequence:2,actionId:'a2',actorId:'p1',kind:'travel',status:'completed',narrative:'',origin:{actorName:'同名旅人',input:'',label:'前往下游浅滩'},
    initialResult:{kind:'travel',status:'resolved',summary:'水面淹过原先露出的踏脚石。'}};
  const arrival=storyMessages(travel,snapshot());
  assert.equal(arrival.filter(r=>r.classList.contains('msg-system')).length,0);
  assert.match(arrival.find(r=>r.classList.contains('msg-narrative')).textContent,/水面淹过原先露出的踏脚石/);
  // Any other summary-only result stays a system line.
  const rest=storyMessages({...travel,initialResult:{kind:'rest.short',status:'resolved',summary:'短休完成。'}},snapshot());
  assert.equal(rest.filter(r=>r.classList.contains('msg-system')).length,1);
  // A board placement is seen on the map, not as a line.
  assert.equal(storyMessages({...travel,initialResult:{kind:'board.spawn',status:'resolved',summary:'已保存棋盘操作；未验证地形或支付资源。'}},snapshot()).length,1);
});

test('portrait resolves actor id, never a duplicate name; missing/revoked seats are disabled',()=>{
  const s=snapshot(),opened=[];
  const rows=storyMessages(entry,s,[],id=>opened.push(id));const avatar=rows[0].querySelector('button');
  assert.equal(avatar.dataset.actor,'p1');avatar.dispatchEvent({type:'click'});assert.deepEqual(opened,['p1']);
  for(const actorId of ['missing','p2']){
    s.party.members[1].revoked=true;
    const disabled=storyMessages({...entry,actorId},s,[],()=>assert.fail('unavailable'))[0].querySelector('button');
    assert.equal(disabled.hasAttribute('disabled'),true);
  }
  const emoji=storyMessages({...entry,origin:{actorName:'👩‍🚀旅人',input:'hello'}},s,[],()=>{})[0].querySelector('button');
  assert.equal(emoji.textContent,'👩‍🚀旅人','the speaker name opens the reader');
  assert.equal(initial('👩‍🚀旅人'),'👩‍🚀','seals keep a whole grapheme');
});

test('authorized character reader exposes five read-only sections and source-specific casting',()=>{
  const root=characterSheet(character,{elapsedSeconds:60});
  assert.deepEqual(root.querySelector('.sheet-tabs').children.map(b=>b.textContent),['人物','状态','能力','法术','背包']);
  assert.match(root.querySelector('.sheet-stat-band').textContent,/9 \/ 15/);
  click(root,'技能与熟练');assert.match(root.querySelector('.sheet-reader').textContent,/奥秘\+5/);
  click(root,'角色设定');assert.match(root.querySelector('.sheet-reader').textContent,/灰斗篷.*谨慎.*来自海港/);
  click(root,'状态');assert.match(root.textContent,/生命骰（d6）/);click(root,'专注 · 祝福术');assert.match(root.querySelector('.sheet-reader').textContent,/2 分钟/);
  click(root,'能力');assert.match(root.textContent,/奥术恢复/);
  click(root,'法术');assert.match(root.querySelector('.sheet-reader').textContent,/权威说明/);assert.match(root.querySelector('.sheet-reader').textContent,/取得来源 · 物种特性/);
  click(root,'背包');assert.equal(root.querySelector('.sheet-reader').hidden,true);
  root.querySelector('.sheet-entry').dispatchEvent({type:'click'});assert.equal(root.querySelector('.sheet-reader').hidden,false);assert.match(root.querySelector('.sheet-reader').textContent,/已装备/);
  assert.equal(root.querySelectorAll('input').length,0);assert.equal(root.querySelectorAll('select').length,0);
  assert.doesNotMatch(root.textContent,/使用物品|卸下|保存纠错/);
  const peer=characterSheet({...character,build:null});assert.doesNotMatch(peer.textContent,/角色设定|建卡选择/);
});

test('equipment reader uses authorized AC sources and real issues without deriving or writing effects',()=>{
  const root=characterSheet({...character,equipmentStatus:{armor:'皮甲',current:'短剑＋盾牌',reserve:'短弓',
    armorClassSources:['皮甲 11＋敏捷 2','防护披风 +1'],issues:['防护戒指未同调','<b>复杂能力尚未自动结算</b>']}});
  click(root,'防御与装备');const body=root.querySelector('.sheet-reader');
  assert.match(body.textContent,/皮甲 11＋敏捷 2/);assert.match(body.textContent,/防护披风 \+1/);
  assert.match(body.textContent,/待处理：防护戒指未同调/);assert.match(body.textContent,/<b>复杂能力尚未自动结算<\/b>/);
  assert.equal(body.querySelectorAll('b').length,0);assert.equal(body.querySelectorAll('button').length,0);
  assert.doesNotMatch(characterSheet(character).textContent,/防御与装备/);
});

test('task strip shows only real tasks and errors, and a failed error read waits for explicit recovery',async()=>{
  document.body.replaceChildren();const owner=document.createElement('div'),column=document.createElement('aside');document.body.append(owner);owner.append(column);
  let requests=[],failure=false;
  const ctx={snapshot:snapshot(),read:async key=>{assert.equal(key,'model-requests');if(failure)throw Error('读取中断');return {requests,nextBefore:null};}};
  const pane=createDrawerHost(column,owner),tasks=createHostTasks(ctx,{isDisposed:()=>false,pane});owner.append(tasks.element);
  await tasks.refresh();assert.equal(tasks.element.hidden,true);assert.equal(tasks.element.querySelectorAll('.todo-row').length,0);
  assert.doesNotMatch(owner.textContent,/无待确认|没有待确认/);
  requests=[{id:1,finished:true,status:503,error:'上游失败',attempt:1}];await tasks.reloadErrors();
  assert.equal(tasks.element.hidden,false);assert.match(tasks.element.textContent,/1 个模型请求失败/);
  requests=[];await tasks.reloadErrors();assert.equal(tasks.element.hidden,true);
  failure=true;await tasks.reloadErrors();assert.equal(tasks.element.hidden,false);assert.match(tasks.element.textContent,/读取中断/);
  failure=false;await tasks.reloadErrors();assert.match(tasks.element.textContent,/读取中断/,'failed polling waits for explicit recovery');
  click(tasks.element,'重试读取错误日志');await settle();assert.equal(tasks.element.hidden,true);
  ctx.snapshot.pendingRulings=[{id:'r',text:'等待检定',status:'awaiting_roll',actorId:'p1'}];tasks.draw();
  assert.equal(tasks.element.hidden,false);assert.match(tasks.element.textContent,/等待检定/);
  click(tasks.element,'查看');assert.match(column.textContent,/等待检定/);assert.equal(column.querySelectorAll('form').length,0,'a roll the player owes is read-only');
  owner.dispatchEvent(new Event('dispose'));
});

test('story exposes failed log reads and recovers through the docked task pane',async()=>{
  document.body.replaceChildren();const mount=document.createElement('div');document.body.append(mount);
  let failed=true;
  const ctx={snapshot:snapshot(),read:async(key,p)=>{
    if(key==='activity')return {nextAfter:p.through,hasMore:false,entries:[]};
    if(key==='adventure-progress')return {runs:[]};
    if(key==='model-requests'){if(failed)throw Error('隔离日志断线');return {requests:[],nextBefore:null};}
    throw Error(key);
  }};
  try{
    await renderStory(mount,ctx);
    assert.equal(mount.querySelector('.task-pane').hidden,true);
    assert.match(mount.querySelector('[aria-label="主持事项"]').textContent,/错误日志读取失败/);
    failed=false;click(mount,'重试读取错误日志');await settle();
    assert.equal(mount.querySelector('.task-pane').hidden,false);
    assert.match(mount.querySelector('.task-pane').textContent,/失败请求列表/);
    assert.equal(mount.querySelector('[aria-label="主持事项"]').hidden,true);
    mount.querySelector('button[aria-label="关闭请求错误日志"]').dispatchEvent({type:'click'});
    assert.equal(mount.querySelector('.task-pane').hidden,true);
  }finally{mount.dispatchEvent(new Event('dispose'));}
});

test('the right pane switches between overview and one task without covering the story',async()=>{
  document.body.replaceChildren();const mount=document.createElement('div');document.body.append(mount);
  const s=snapshot();s.id='switch';s.timelineId='t';s.party.members[0].review={status:'pending',revision:1};
  const overview={campaignId:'switch',timelineId:'t',version:1,party:[],scene:{id:'s',title:'码头',summary:'',npcs:[],records:[]},encounter:{version:1,encounter:null,roster:[]},board:null};
  const ctx={snapshot:s,hasPending:()=>false,read:async(key,p)=>{
    if(key==='activity')return {nextAfter:p.through,hasMore:false,entries:[entry]};
    if(key==='adventure-progress')return {runs:[]};if(key==='model-requests')return {requests:[],nextBefore:null};
    if(key==='dm-overview')return overview;throw Error(key);
  }};
  try{
    await renderStory(mount,ctx);
    const page=mount.querySelector('.story-page'),side=mount.querySelector('.story-side'),overviewPane=mount.querySelector('.pane-overview');
    assert.equal(side.hidden,false);assert.equal(overviewPane.hidden,false);assert.equal(mount.querySelector('.task-pane').hidden,true);
    assert.equal(page.classList.contains('has-side'),true);
    click(mount,'审阅');
    assert.equal(overviewPane.hidden,true,'the task takes the overview\'s place');
    assert.equal(mount.querySelector('.task-pane').hidden,false);assert.equal(document.body.querySelector('dialog'),null);
    assert.equal(mount.querySelector('.todo-row').classList.contains('is-open'),true);
    assert.ok(mount.querySelector('.msg-dm'),'the story stays readable beside the task');
    mount.querySelector('.pane-back').dispatchEvent({type:'click'});
    assert.equal(mount.querySelector('.task-pane').hidden,true);assert.equal(overviewPane.hidden,false);
    assert.equal(mount.querySelector('.todo-row').classList.contains('is-open'),false);
    click(mount,'收起');assert.equal(side.hidden,true);assert.equal(page.classList.contains('has-side'),false);
    click(mount,'审阅');assert.equal(side.hidden,false);assert.equal(overviewPane.hidden,true);
    mount.querySelector('button[aria-label="关闭角色审核"]').dispatchEvent({type:'click'});
    assert.equal(side.hidden,true,'closing the task restores the collapsed overview');
  }finally{mount.dispatchEvent(new Event('dispose'));}
});

test('redrawing the task strip does not silently kill an already-open review',async()=>{
  document.body.replaceChildren();const owner=document.createElement('div'),column=document.createElement('aside');document.body.append(owner);owner.append(column);
  const s=snapshot();s.party.members[0].review={status:'pending',revision:1};
  const ctx={snapshot:s,hasPending:()=>false,read:async()=>({requests:[],nextBefore:null}),submit:()=>assert.fail('stale review must not submit')};
  const pane=createDrawerHost(column,owner),tasks=createHostTasks(ctx,{isDisposed:()=>false,pane});owner.append(tasks.element);await tasks.refresh();
  click(tasks.element,'审阅');assert.ok(column.querySelector('textarea'));
  s.version++;await tasks.refresh();
  click(column,'批准加入');await settle();assert.match(column.textContent,/资料已更新/);
  owner.dispatchEvent(new Event('dispose'));assert.equal(column.hidden,true);
});

test('on-demand members opens an approved character without messages and never restores a permanent sidebar',async()=>{
  document.body.replaceChildren();const mount=document.createElement('div');document.body.append(mount);
  const s=snapshot();s.party.members[1].review={status:'approved'};
  s.party.members.push({id:'revoked',revoked:true,character:{...character,name:'撤销角色'}},{id:'host',character:null});
  const reads=[];
  const ctx={snapshot:s,read:async(key,p)=>{
    reads.push(key);if(key==='activity')return {nextAfter:p.through,hasMore:false,entries:[]};
    if(key==='adventure-progress')return {runs:[]};if(key==='model-requests')return {requests:[],nextBefore:null};
    if(key==='character-references')return references(s,p.actorId);
    throw Error('unexpected '+key);
  },submit:()=>assert.fail('readonly entry')};
  try{
    await renderStory(mount,ctx);assert.equal(mount.querySelector('.msg-speaker'),null);
    click(mount,'队伍成员');let dialog=document.body.querySelector('dialog');
    assert.doesNotMatch(dialog.textContent,/撤销角色/);assert.match(dialog.textContent,/已批准/);
    dialog.querySelectorAll('button').find(b=>b.dataset.member==='p2').dispatchEvent({type:'click'});
    dialog=document.body.querySelector('dialog');assert.match(dialog.textContent,/4 \/ 15/);
    await settle();click(dialog,'能力');assert.match(dialog.textContent,/完整规则正文/);
    click(dialog,'返回成员列表');dialog=document.body.querySelector('dialog');
    assert.equal(dialog.querySelectorAll('button').filter(b=>b.dataset.member).length,2);
    s.party.members[1].revoked=true;dialog.querySelectorAll('button').find(b=>b.dataset.member==='p2').dispatchEvent({type:'click'});
    assert.equal(document.body.querySelector('dialog'),dialog,'stale entry cannot reopen a revoked character');
    assert.equal(mount.querySelector('.task-pane').hidden,true);assert.equal(reads.filter(key=>key==='character-references').length,1);assert.ok(reads.every(key=>!['character','character-play','sheet','room'].includes(key)));
  }finally{mount.dispatchEvent(new Event('dispose'));}
});

test('late rules respect dialog identity, preserve reading selection and expose retry on malformed response',async()=>{
  document.body.replaceChildren();const mount=document.createElement('div');document.body.append(mount);
  const s=snapshot(),pending=[];
  const ctx={snapshot:s,read:async(key,p)=>{
    if(key==='character-references')return new Promise(resolve=>pending.push({actor:p.actorId,resolve}));
    if(key==='activity')return {nextAfter:p.through,hasMore:false,entries:[entry]};
    if(key==='adventure-progress')return {runs:[]};if(key==='model-requests')return {requests:[],nextBefore:null};throw Error(key);
  }};
  try{
    await renderStory(mount,ctx);mount.querySelector('.msg-speaker').dispatchEvent({type:'click'});
    const old=document.body.querySelector('dialog');click(old,'能力');
    click(mount,'队伍成员');let dialog=document.body.querySelector('dialog');
    dialog.querySelectorAll('button').find(b=>b.dataset.member==='p2').dispatchEvent({type:'click'});
    dialog=document.body.querySelector('dialog');click(dialog,'能力');
    pending[0].resolve({...references(s,'p1'),featureDetails:[{index:0,name:'过期名称',text:'旧内容',group:'职业能力',notice:''}]});await settle();
    assert.doesNotMatch(dialog.textContent,/过期名称|旧内容/);
    pending[1].resolve({...references(s,'p2'),version:99});await settle();assert.match(dialog.textContent,/角色资料已更新/);
    click(dialog,'重新读取规则资料');assert.equal(pending.length,3);
    const reader=dialog.querySelector('.sheet-reader');reader.scrollTop=42;
    pending[2].resolve(references(s,'p2'));await settle();
    assert.equal(dialog.querySelector('.sheet-body').dataset.entry,'feature:0');
    assert.equal(dialog.querySelector('.sheet-reader').scrollTop,42);assert.match(dialog.textContent,/完整规则正文/);
  }finally{mount.dispatchEvent(new Event('dispose'));}
});

test('story removes permanent right cards, reads only authorized member and closes on revoke',async()=>{
  document.body.replaceChildren();const mount=document.createElement('div');document.body.append(mount);
  const timers=[],original=globalThis.setTimeout;globalThis.setTimeout=(fn,delay,...args)=>delay===2500?(timers.push(fn),{unref(){}}):original(fn,delay,...args);
  let ctx,errors=[],reads=[];
  ctx={snapshot:snapshot(),report:e=>{throw e;},liveConnection:()=>({snapshot:async()=>ctx.snapshot}),read:async(key,p)=>{
    reads.push(key);if(key==='activity')return {nextAfter:p.through,hasMore:false,entries:[entry]};
    if(key==='adventure-progress')return {runs:[]};if(key==='model-requests')return {requests:errors,nextBefore:null};
    if(key==='character-references')return references(ctx.snapshot,p.actorId);
    throw Error('unexpected '+key);
  }};
  try{
    await renderStory(mount,ctx);assert.equal(mount.querySelector('.task-pane').hidden,true);
    assert.doesNotMatch(mount.textContent,/队伍状态|无待确认|房间与席位/);assert.ok(!reads.includes('room'));
    mount.querySelector('.msg-speaker').dispatchEvent({type:'click'});assert.match(document.body.querySelector('dialog').textContent,/9 \/ 15/);
    errors=[{id:2,status:500,finished:true,error:'同版本错误',attempt:1}];timers.shift()();await settle();
    assert.equal(mount.querySelector('.task-pane').hidden,true,'a reminder does not open the task pane');
    assert.equal(mount.querySelector('[aria-label="主持事项"]').hidden,false);assert.match(mount.querySelector('[aria-label="主持事项"]').textContent,/1 个模型请求失败/);
    const dialog=document.body.querySelector('dialog');click(dialog,'法术');
    ctx.snapshot.party.members[0].character.hitPoints=8;ctx.snapshot.version++;timers.shift()();await settle();
    assert.equal(dialog.querySelector('.sheet-body').dataset.section,'spells');assert.equal(dialog.querySelector('.sheet-body').dataset.entry,'光亮术');
    assert.match(dialog.querySelector('.sheet-reader').textContent,/权威说明/);
    assert.equal(reads.filter(key=>key==='character-references').length,1,'HP sync does not refetch fixed rules');
    ctx.snapshot.party.members[0].revoked=true;ctx.snapshot.version++;timers.shift()();await settle();
    assert.equal(document.body.querySelector('dialog'),null);assert.ok(reads.every(key=>!key.includes('character-play')));
  }finally{mount.dispatchEvent(new Event('dispose'));globalThis.setTimeout=original;}
});

test('a result the server only summarised is shown once, and never over a narration or a wait',()=>{
  const rest={...entry,kind:'party.rest.short',status:'completed',origin:null,narrative:'',narrativeSource:'system',
    initialResult:{status:'resolved',kind:'party.rest.short',summary:'DM 发起的全队短休已完成，共经过 1 小时。',check:null}};
  const root=document.createElement('div');root.append(...storyMessages(rest,snapshot()));
  assert.equal(root.querySelector('.msg-result').textContent,'DM 发起的全队短休已完成，共经过 1 小时。');
  const die={...entry,kind:'roll.request',status:'completed',narrative:'',origin:{...entry.origin,input:'',label:'再花 1 颗生命骰'},
    initialResult:{status:'resolved',kind:'rest.hit_die',summary:'花费 1 颗生命骰：d10 [6] + CON 2，实际恢复 5 HP。',check:null}};
  const rows=document.createElement('div');rows.append(...storyMessages(die,snapshot()));
  assert.match(rows.querySelector('.msg-player').textContent,/再花 1 颗生命骰/);
  assert.match(rows.querySelector('.msg-result').textContent,/实际恢复 5 HP/);
  for(const quiet of [{...die,narrative:'米洛喘了口气。'},{...die,status:'awaiting_roll'}]){
    const r=document.createElement('div');r.append(...storyMessages(quiet,snapshot()));
    assert.equal(r.querySelector('.msg-result'),null);
  }
});

test('a wait on a teammate action names the teammate; the seat own wait and host waits do not',()=>{
  const seat={...snapshot(),party:{...snapshot().party,isHost:false,selfActorId:'p1'}};
  seat.party.members[1].character.name='林砚';
  const line=(actorId,status)=>storyMessages({sequence:3,actionId:'a3',actorId,status,origin:{input:'后退两步'}},seat)
    .find(n=>n.classList.contains('msg-system'))?.textContent;
  assert.equal(line('p2','awaiting_confirmation'),'等待林砚确认行动');
  assert.equal(line('p2','awaiting_roll'),'等待林砚投掷');
  assert.equal(line('p1','awaiting_confirmation'),'等待确认行动');
  assert.equal(line('p2','awaiting_ruling'),'等待裁定');
});

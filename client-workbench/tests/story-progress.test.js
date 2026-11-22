import test from 'node:test';
import assert from 'node:assert/strict';
import {installDom,settle} from './dom-shim.mjs';
import {validAdventureProgress} from '../src/api.js';
installDom();
const {watchStoryProgress}=await import('../src/story-progress.js');
const {storyMessages,createStoryFeed}=await import('../src/story.js');
const step=(number,kind='model',status='started',tool='')=>({number,kind,status,tool,waitKind:'',version:null});
const run=(extra={})=>({id:'run',actionId:'action',version:1,actorId:'p',actorName:'琳',status:'running',succeeded:false,steps:[step(1)],...extra});
const entry=(sequence,actionId,actorId='p')=>({sequence,actionId,actorId,createdAt:'2026-10-06T12:00:00Z',status:'completed',
  origin:{input:'玩家发言 '+sequence,actorName:'琳'},narrative:'DM正文 '+sequence});
const feedFor=(entries=[],version=1)=>{
  const ctx={snapshot:{version,party:{isHost:true}},read:async(key,p)=>{
    assert.equal(key,'activity');return {nextAfter:p.through,hasMore:false,entries:entries.filter(e=>e.sequence>p.after&&e.sequence<=p.through)};
  }};
  return {ctx,feed:createStoryFeed(ctx,{isDisposed:()=>false})};
};
const group=(feed,key)=>feed.element.querySelectorAll('.msg-group').find(g=>g.dataset.message===key);

test('host polls same-version steps into the matching DM message; success collapses, failure stays',async()=>{
  let value={runs:[run()]},calls=0;const scheduled=[];
  const {ctx,feed}=feedFor([entry(1,'action')]);await feed.loadLatest(1);
  const activityRead=ctx.read;ctx.read=async key=>{if(key==='activity')return activityRead(key,{after:0,through:1});calls++;return value;};
  const view=watchStoryProgress(feed.element,ctx,feed.updateProgress,{schedule:fn=>{scheduled.push(fn);return scheduled.length;},cancel:()=>{}});
  await settle();assert.match(group(feed,'action:action').textContent,/本轮步骤 · 1 步 · 执行中仅主持/);
  assert.ok(group(feed,'action:action').textContent.indexOf('DM正文')<group(feed,'action:action').textContent.indexOf('本轮步骤'));
  assert.equal(feed.element.querySelectorAll('.story-progress').length,0);
  value={runs:[run({steps:[step(1,'model','done'),step(2,'tool','started','memory_semantic_search')]})]};
  await view.poll();assert.match(group(feed,'action:action').textContent,/检索相关经历/);assert.equal(ctx.snapshot.version,1);
  value={runs:[run({status:'waiting',steps:[step(1,'tool','done','ask_player')]})]};await view.poll();assert.match(group(feed,'action:action').textContent,/等待回应或确认/);
  value={runs:[run({status:'failed'})]};await view.poll();assert.match(group(feed,'action:action').textContent,/执行失败.*未完成/);
  value={runs:[run({status:'completed',succeeded:true})]};await view.poll();assert.equal(feed.element.querySelectorAll('.progress-run').length,1);
  assert.equal(feed.element.querySelector('.progress-run').open,false);assert.match(feed.element.textContent,/本轮步骤 · 1 步 · 已完成/);
  assert.match(feed.element.textContent,/DM正文 1/);assert.equal(calls,5);feed.element.dispatchEvent({type:'dispose'});
});

test('context failure notice is shown without inventing a recovery action',async()=>{
  const {feed}=feedFor([entry(1,'action')]);await feed.loadLatest(1);
  const value=run({status:'failed',notice:'无法确认模型输入容量，已保存的行动与骰点保留。'});
  assert.equal(validAdventureProgress({runs:[value]}),true);feed.updateProgress([value]);
  const node=group(feed,'action:action').querySelector('.progress-run');
  assert.match(node.textContent,/无法确认模型输入容量/);
  assert.equal(node.querySelector('[role="status"]').hidden,false);
  assert.doesNotMatch(node.textContent,/等待恢复交接/);
});

test('saved delegation shows read-only recovery without claiming generation is running',async()=>{
  const {feed}=feedFor([entry(1,'action')]);await feed.loadLatest(1);
  for(const recovery of ['delegation','return','blocked']){
    const value=run({status:'delegated',recovery,notice:'已保存结果；恢复原身份后继续。'});
    assert.equal(validAdventureProgress({runs:[value]}),true);feed.updateProgress([value]);
    const node=group(feed,'action:action').querySelector('.progress-run');
    assert.match(node.textContent,/已保存结果；恢复原身份后继续/);
    assert.doesNotMatch(node.textContent,/战斗主持正在继续/);
    assert.match(node.querySelector('summary').textContent,recovery==='blocked'?/权限已失效/:/等待恢复交接/);
    assert.equal(validAdventureProgress({runs:[{...value,notice:undefined}]}),false);
  }
  feed.updateProgress([run({status:'delegated'})]);
  const node=group(feed,'action:action').querySelector('.progress-run');
  assert.match(node.textContent,/战斗主持正在继续/);assert.doesNotMatch(node.textContent,/已保存结果/);
  assert.equal(validAdventureProgress({runs:[run({recovery:'other',notice:'invalid'})]}),false);
});

test('same actor multiple rounds and different actors attach by action AND actor, not arrival order',async()=>{
  const {feed}=feedFor([entry(1,'a'),entry(2,'b'),entry(3,'c','other')]);await feed.loadLatest(3);
  feed.updateProgress([
    run({id:'r3',actionId:'c',actorId:'other',status:'waiting'}),
    run({id:'r2',actionId:'b',steps:[step(1,'tool','started','world_record')]}),
    run({id:'r1',actionId:'a',status:'failed'})
  ]);
  for(const [action,id] of [['a','r1'],['b','r2'],['c','r3']])assert.equal(group(feed,'action:'+action).querySelector('.progress-run').dataset.run,id);
  assert.deepEqual(feed.element.querySelectorAll('.progress-run').map(n=>n.dataset.run),['r1','r2','r3']);
  feed.updateProgress([run({id:'wrong-seat',actionId:'c',actorId:'p',version:4})]);
  assert.equal(feed.element.querySelectorAll('[data-sequence="3"]')[0].querySelectorAll('.progress-run').length,0,'a foreign actor cannot acquire the existing reply');
});

test('an uncommitted run has its own chronological DM placeholder, then migrates without duplicates',async()=>{
  const entries=[entry(1,'a'),entry(4,'later')],{feed}=feedFor(entries);await feed.loadLatest(4);
  feed.updateProgress([run({id:'pending',actionId:'b',version:2,input:'本轮刚提交的行动'})]);
  const pending=group(feed,'action:b');assert.equal(pending.querySelector('.msg-player').textContent.includes('本轮刚提交的行动'),true);
  assert.ok(pending.textContent.indexOf('本轮刚提交的行动')<pending.textContent.indexOf('本轮步骤'));
  assert.deepEqual(feed.element.querySelectorAll('.msg-group').map(n=>n.dataset.message),['action:a','action:b','action:later']);
  assert.match(group(feed,'action:b').textContent,/执行中.*主持处理中 · 主持回应 琳/);
  entries.push(entry(3,'b'));await feed.loadLatest(5);
  assert.equal(feed.element.querySelectorAll('.progress-run').length,1);assert.match(group(feed,'action:b').textContent,/DM正文 3/);
  assert.equal(feed.element.querySelectorAll('.msg-group').length,3);
  assert.equal(group(feed,'action:b').querySelectorAll('.msg-player').length,1);
  feed.updateProgress([]);assert.equal(feed.element.querySelectorAll('.progress-run').length,0);assert.match(group(feed,'action:b').textContent,/DM正文 3/);
});

test('paging older roots relocates their progress and legacy runs never guess a matching line',async()=>{
  const {feed}=feedFor([entry(2,'old'),entry(80,'new')]);await feed.loadLatest(100);
  feed.updateProgress([run({actionId:'old',version:3,status:'failed'})]);
  assert.equal(group(feed,'action:old').querySelectorAll('.msg-dm').length,0);
  feed.element.querySelector('button').dispatchEvent({type:'click'});await settle();
  assert.equal(group(feed,'action:old').querySelectorAll('.msg-dm').length,1);
  assert.equal(feed.element.querySelectorAll('.progress-run').length,1);
  feed.updateProgress([run({id:'legacy',actionId:undefined,version:undefined})]);
  assert.match(group(feed,'run:legacy').textContent,/主持回应 琳/);assert.equal(group(feed,'action:new').querySelectorAll('.progress-run').length,0);
});

test('failure pauses until retry and disposal rejects a late read; guest never polls or renders progress',async()=>{
  const scheduled=[];let calls=0,resolve,updates=0;
  const mount=document.createElement('div');const view=watchStoryProgress(mount,{snapshot:{party:{isHost:true}},read:()=>{calls++;if(calls===1)throw new Error('离线');return new Promise(r=>resolve=r);}},()=>updates++,{schedule:fn=>scheduled.push(fn),cancel:()=>{}});
  await settle();assert.match(mount.textContent,/同步已暂停/);assert.equal(scheduled.length,0);
  const pending=view.poll();mount.dispatchEvent({type:'dispose'});resolve({runs:[run()]});await pending;assert.equal(updates,0);
  const guest=document.createElement('div');const g=watchStoryProgress(guest,{snapshot:{party:{isHost:false}},read:()=>{throw new Error('must not read');}},()=>{});await g.poll();assert.equal(guest.children[0].hidden,true);guest.dispatchEvent({type:'dispose'});
  const {ctx,feed}=feedFor([entry(1,'action')]);await feed.loadLatest(1);ctx.snapshot.party.isHost=false;feed.updateProgress([run()]);assert.equal(feed.element.querySelectorAll('.progress-run').length,0);
});

test('progress refresh preserves nested step reading and never erases an activity read failure',async()=>{
  const {ctx,feed}=feedFor([entry(1,'action')]);await feed.loadLatest(1);
  feed.updateProgress([run()]);feed.element.querySelector('.progress-run').querySelector('ol').scrollTop=75;
  feed.updateProgress([run({steps:[step(1,'model','done'),step(2)]})]);
  assert.equal(feed.element.querySelector('.progress-run').querySelector('ol').scrollTop,75);
  const read=ctx.read;ctx.read=async()=>{throw new Error('剧情读取失败');};await feed.loadLatest(2);
  feed.updateProgress([run({status:'waiting'})]);assert.match(feed.element.textContent,/剧情读取失败/);
  ctx.read=read;await feed.loadLatest(2);assert.doesNotMatch(feed.element.textContent,/剧情读取失败/);
});

test('safe shape supports additive identity and rejects malformed progress metadata',()=>{
  for(const tool of ['world_routes','world_route_propose','rules_read','map_request','memory_digest'])assert.equal(validAdventureProgress({runs:[run({steps:[step(1,'tool','done',tool)]})]}),true);
  assert.equal(validAdventureProgress({runs:[run({actionId:undefined,version:undefined})]}),true,'legacy response remains readable');
  for(const bad of [{succeeded:true},{steps:[step(2)]},{steps:[step(1,'tool','done','<private>')]},{actionId:3},{version:-1},{version:1.5}])assert.equal(validAdventureProgress({runs:[run(bad)]}),false);
});
test('old story rounds load exact history on expand and survive subsequent recent polls',async()=>{
  const old={...entry(1,'old'),narrativeSource:'harness'};
  const {ctx,feed}=feedFor([old]);const activity=ctx.read,calls=[];
  ctx.read=async(key,p)=>{
    if(key==='activity')return activity(key,p);
    calls.push([key,p]);
    if(key==='adventure-progress')return {runs:[run({id:'old-run',actionId:'old',status:'completed',succeeded:true})]};
    if(key==='model-requests')return {requests:[],nextBefore:null};
    throw new Error(key);
  };
  await feed.loadLatest(1);assert.equal(calls.length,0);
  const placeholder=feed.element.querySelector('.progress-history');assert.equal(placeholder.open,false);
  placeholder.open=true;placeholder.dispatchEvent({type:'toggle'});await settle();
  assert.deepEqual(calls[0],['adventure-progress',{actorId:'p',actionId:'old'}]);
  const node=group(feed,'action:old').querySelector('.progress-run');assert.equal(node.dataset.run,'old-run');assert.equal(node.open,true);
  feed.updateProgress([run({id:'next-run',actionId:'new',status:'completed',succeeded:true})]);
  assert.equal(group(feed,'action:old').querySelector('.progress-run'),node);assert.equal(node.open,true);
  feed.updateProgress([]);assert.equal(group(feed,'action:old').querySelector('.progress-run'),node);
});
test('late historical read respects a collapsed placeholder and transfers summary focus',async()=>{
  const {ctx,feed}=feedFor([{...entry(1,'old'),narrativeSource:'harness'}]);const activity=ctx.read;let resolve;
  ctx.read=(key,p)=>key==='activity'?activity(key,p):new Promise(r=>resolve=r);
  await feed.loadLatest(1);const placeholder=feed.element.querySelector('.progress-history');
  placeholder.open=true;placeholder.querySelector('summary').focus();placeholder.dispatchEvent({type:'toggle'});
  placeholder.open=false;
  resolve({runs:[run({id:'old-run',actionId:'old',status:'completed',succeeded:true})]});await settle();
  const node=group(feed,'action:old').querySelector('.progress-run');assert.equal(node.open,false);
  assert.equal(document.activeElement,node.querySelector('summary'));
});
test('first attached mount scrolls to bottom; user scroll prevents late font reset',async()=>{
  let ready;document.fonts={ready:new Promise(r=>ready=r)};
  const {feed}=feedFor([entry(1,'a')]);await feed.loadLatest(1);
  const list=feed.element.querySelector('.story-feed');list.scrollHeight=1200;list.clientHeight=400;list.scrollTop=0;
  feed.mounted();assert.equal(list.scrollTop,1200);
  list.dispatchEvent({type:'wheel'});list.scrollTop=150;ready();await settle();assert.equal(list.scrollTop,150);
  delete document.fonts;
});
test('inventory receipt is visible, correct recipient, no repeated compatibility changes or prose parsing',()=>{
  const changes=[{actorId:'p',operation:'inventory',key:'rope',label:'琳 · Rope',before:'1',after:'2'}];
  const value={...entry(1,'a'),origin:{actorName:'琳',input:'拿东西',changes},steps:[{result:{kind:'inventory.grant'},origin:{changes}}]};
  const messages=storyMessages(value,{});assert.equal(messages.filter(m=>m.classList.contains('msg-loot')).length,1);
  assert.match(messages.find(m=>m.classList.contains('msg-loot')).textContent,/琳获得.*×1，已放入背包/);
  value.steps=[];value.origin.changes=[];value.narrative='获得10根火把';assert.equal(storyMessages(value,{}).filter(m=>m.classList.contains('msg-loot')).length,0);
});
test('mechanical steps do not repeat the compatibility last roll',()=>{
  const check={ability:'wisdom',rolls:[11],total:11,dc:10,success:true};
  const messages=storyMessages({sequence:1,initialResult:{check},steps:[{result:{check}}]},{});
  assert.equal(messages.filter(m=>m.classList.contains('msg-roll')).length,1);
});

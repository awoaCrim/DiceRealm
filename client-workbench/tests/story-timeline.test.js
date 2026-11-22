import test from 'node:test';
import assert from 'node:assert/strict';
import {installDom,settle} from './dom-shim.mjs';
import {h} from '../src/dom.js';
import {stepSummary} from '../src/story-step-summary.js';
import {createStoryProgress} from '../src/story-progress.js';
import {createStoryFeed,storyMessages} from '../src/story.js';
import {createPresentationMotion} from '../src/presentation-motion.js';
installDom();
const tool=(number,name)=>({number,kind:'tool',status:'done',tool:name});
const run={id:'r',actorId:'a',actorName:'琳',actionId:'act',succeeded:true,status:'completed',steps:[tool(1,'dm_reference'),tool(2,'world_record'),tool(3,'world_record')]};
const detail=(step,content,request={},isError=false)=>({...step,runId:'r',actorId:'a',actionId:'act',request,response:{content:JSON.stringify(content),isError}});
const check={ability:'wisdom',skill:'Perception',mode:'normal',rolls:[18],selected:18,modifier:-3,total:15,dc:13,hasDc:true,success:true};

test('timeline uses saved roll results, never proposed DCs or private reasoning as completed dice',()=>{
  let s=tool(1,'check_request');
  const proposed=stepSummary(s,detail(s,{resolution:{status:'awaiting_roll'}},{skill:'Perception',dc:13,reason:'PRIVATE'}),'请求检定');
  assert.match(proposed.text,/DC13/);assert.equal(proposed.state,'已请求');assert.doesNotMatch(proposed.text,/掷骰|成功|PRIVATE/);
  s=tool(2,'checks_result');
  const rolled=stepSummary(s,detail(s,{rolls:[{result:{check}}]}),'读取检定结果');
  assert.equal(rolled.category,'roll');assert.match(rolled.text,/察觉.*DC 13.*掷骰 15.*成功/);
  const model=stepSummary({kind:'model',status:'done'},{response:{text:'PRIVATE',reasoning:'SECRET'}},'模型调用');
  assert.equal(model.text,'模型调用');
  s=tool(4,'rules_read');assert.equal(stepSummary(s,detail(s,{name:'物件 AC',text:'PRIVATE'}),'读取规则').text,'查阅规则：物件 AC');
});

test('expanded host timeline reads completed tools once, labels rejected retry, keeps scroll and original detail reader',async()=>{
  document.body.replaceChildren();const reads=[];
  const ctx={snapshot:{id:'c',timelineId:'t',party:{isHost:true}},read:async(key,p)=>{
    reads.push([key,p]);const s=run.steps[p.number-1];return detail(s,p.number===2?{code:'invalid_world_memory'}:{},p.number===1?{topic:'objects'}:{},p.number===2);
  }};
  const view=createStoryProgress(run,{ctx});document.body.append(view.element);assert.equal(reads.length,0);
  view.element.open=true;view.element.dispatchEvent({type:'toggle'});await settle();
  assert.equal(reads.length,3);assert.match(view.element.textContent,/物件 AC 与生命.*被拒绝：invalid_world_memory，已重试.*未写入/);
  const steps=view.element.querySelector('ol');steps.scrollTop=90;
  view.update({...run});view.element.dispatchEvent({type:'toggle'});await settle();assert.equal(reads.length,3);assert.equal(steps.scrollTop,90);
  view.element.querySelector('[data-step="2"]').dispatchEvent({type:'click'});await settle();
  assert.match(document.body.querySelector('dialog').textContent,/工具返回错误/);
  assert.deepEqual(reads.at(-1),['adventure-step',{actorId:'a',actionId:'act',number:2}]);
  assert.equal(view.element.querySelectorAll('pre').length,0);view.dispose();
});

test('summary failures can retry, and mismatched / late details cannot be shown after timeline change or disposal',async()=>{
  const single={...run,steps:[run.steps[1]]};let bad=true,resolve;
  const ctx={snapshot:{id:'c',timelineId:'t',party:{isHost:true}},read:async()=>bad?{...detail(single.steps[0],{code:'PRIVATE'}, {},true),runId:'foreign'}:new Promise(r=>resolve=r)};
  const view=createStoryProgress(single,{ctx});view.element.open=true;view.element.dispatchEvent({type:'toggle'});await settle();
  assert.match(view.element.textContent,/部分步骤摘要暂未读到/);assert.doesNotMatch(view.element.textContent,/PRIVATE/);
  bad=false;view.element.querySelectorAll('button').find(b=>b.textContent==='重试读取步骤摘要').dispatchEvent({type:'click'});
  ctx.snapshot.timelineId='new';resolve(detail(single.steps[0],{code:'LATE'}, {},true));await settle();assert.doesNotMatch(view.element.textContent,/LATE/);view.dispose();
  ctx.snapshot.party.isHost=false;const guest=createStoryProgress({...single,succeeded:false},{ctx});await settle();guest.dispose();
});

test('new messages animate once, initial/history/reconnect stay static; saved verdict colors respect no-DC checks',async()=>{
  const entries=[{sequence:1,actionId:'a',narrative:'历史'}];
  const ctx={snapshot:{version:1,party:{members:[]}},read:async()=>({entries,nextAfter:ctx.snapshot.version,hasMore:false})};
  const feed=createStoryFeed(ctx,{isDisposed:()=>false});await feed.loadLatest(1);
  assert.equal(feed.element.querySelectorAll('.presentation-arrive').length,0);
  entries.push({sequence:2,actionId:'b',narrative:'新结果'});ctx.snapshot.version=2;await feed.loadLatest(2);
  assert.equal(feed.element.querySelectorAll('.presentation-arrive').length,1);assert.match(feed.element.querySelector('.presentation-arrive').textContent,/新结果$/);
  feed.refreshShared();assert.equal(feed.element.querySelectorAll('.presentation-arrive').length,0);
  entries.push({sequence:3,actionId:'c',narrative:'重连结果'});ctx.snapshot.version=3;await feed.loadLatest(3,{live:false});
  assert.equal(feed.element.querySelectorAll('.presentation-arrive').length,0);
  for(const [value,outcome] of [[check,'success'],[{...check,success:false},'failure'],[{...check,hasDc:false},'neutral']]){
    const nodes=storyMessages({initialResult:{check:value}},{});assert.equal(nodes.find(n=>n.classList.contains('msg-roll')).dataset.outcome,outcome);
  }
  feed.element.dispatchEvent({type:'dispose'});
});

test('presentation effects stop on pointer/key, respect reduced motion and release on disposal',()=>{
  const owner=h('div'),node=h('div');owner.append(node);const motion=createPresentationMotion(owner);
  motion(node);assert.ok(node.classList.contains('presentation-arrive'));owner.dispatchEvent({type:'pointerdown'});assert.equal(node.className,'');
  motion(node,'slide');owner.dispatchEvent({type:'keydown'});assert.equal(node.className,'');
  document.documentElement={dataset:{reduceMotion:'true'}};motion(node);assert.equal(node.className,'');
  document.documentElement.dataset.reduceMotion='false';motion(node,'change');owner.dispatchEvent({type:'dispose'});assert.equal(node.className,'');
  motion(node);assert.equal(node.className,'');delete document.documentElement;
});

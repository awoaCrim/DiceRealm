import test from 'node:test';
import assert from 'node:assert/strict';
import {installDom,settle} from './dom-shim.mjs';
import {createApi,requestPath,validWorldMemoryPage} from '../src/api.js';
import {worldMemoryCard} from '../src/world-memory.js';

installDom();
const entry=(id='cold-600')=>({id,kind:'clue',name:'远地书信',summary:'没有获得通行许可。',status:'known',sceneId:'',revision:3,
  originSequence:1,updatedSequence:3,actorId:'player',source:'fixture',hidden:false,visibility:'public',revealSceneId:''});
const page=(entries=[entry()])=>({version:4,scope:'host',entries,total:1,nextOffset:null});
const session={campaignId:'example',accessToken:'not-in-query'};
const button=(root,text)=>root.querySelectorAll('button').find(b=>b.textContent===text);
const input=(root,label)=>['input','textarea','select'].flatMap(tag=>root.querySelectorAll(tag)).find(e=>e.getAttribute('aria-label')?.startsWith(label));
const click=async element=>{element.dispatchEvent({type:'click'});await settle();};
function context(){return {scope:'world-page-seat',snapshot:{id:'example',version:4,party:{isHost:true},worldMemory:Array.from({length:256},(_,i)=>entry('warm-'+i)),
  worldMemoryPaging:{total:600,nextOffset:256}},hasPending:()=>false,refresh:async()=>{},report:()=>{}};}

test('world page transport is an authorized readonly GET with frozen version and validated bounds',async()=>{
  const payload={expectedVersion:4,query:'海灯 & key',offset:300,limit:32,scope:'host'};
  const url=requestPath('world/memory',session,payload);
  assert.match(url,/expectedVersion=4/);assert.match(url,/offset=300/);assert.ok(!url.includes(session.accessToken));
  let sent;
  const api=createApi({fetchImpl:async(path,options)=>{sent={path,options};return new Response(JSON.stringify({...page(),total:600,nextOffset:301}));}});
  assert.equal((await api.request('world/memory',session,payload)).entries[0].id,'cold-600');
  assert.equal(sent.options.method,'GET');assert.equal(sent.options.body,undefined);
  assert.equal(sent.options.headers.Authorization,'Bearer '+session.accessToken);
  for(const bad of [{...page(),version:5},{...page(),scope:'public'},{...page(),entries:[entry(),entry()]},{...page(),total:9000},
    {...page(),nextOffset:301,total:600,entries:[]},{...page(),entries:[{...entry(),revision:0}]}]){
    const invalid=createApi({fetchImpl:async()=>new Response(JSON.stringify(bad))});
    await assert.rejects(invalid.request('world/memory',session,payload));
  }
  assert.equal(validWorldMemoryPage({...page(),entries:Array.from({length:33},(_,i)=>entry('m'+i)),total:100}),false);
});

test('large world reader pages without expanding snapshot and can correct a cold record at its read version',async()=>{
  const ctx=context(),reads=[],writes=[];
  ctx.read=async(name,args)=>{reads.push({name,args});return args.offset===0?{...page(Array.from({length:32},(_,i)=>entry('warm-'+i))),total:600,nextOffset:32}:page();};
  ctx.submit=async(name,args)=>{writes.push({name,args});};
  const card=worldMemoryCard(ctx,()=>false,{selectedKind:'clue'});
  assert.equal(card.querySelectorAll('.world-record').length,0,'incomplete snapshot cannot provide category totals');
  await settle();assert.equal(reads[0].args.kind,'clue');assert.equal(reads[0].args.offset,0);
  assert.equal(card.querySelectorAll('.world-record').length,32);
  assert.ok(card.textContent.includes('600 条'));assert.ok(card.textContent.includes('第 1–32'));
  assert.equal(card.querySelector('.world-paging').hidden,false,'more records keep pagination visible');
  await click(button(card,'下一页'));assert.equal(reads[1].name,'world/memory');
  assert.deepEqual(reads[1].args,{expectedVersion:4,query:'',kind:'clue',offset:32,limit:32,scope:'host'});
  assert.equal(card.querySelectorAll('.world-record').length,1);
  assert.equal(card.querySelector('.world-paging').hidden,false,'last page must retain a way back');
  assert.equal(ctx.snapshot.worldMemory.some(e=>e.id==='cold-600'),false,'do not merge cold records into the authority snapshot');
  const form=card.querySelector('.world-correct');
  const reason=input(form,'更正理由');reason.value='核实书信中的笔误';reason.dispatchEvent({type:'input'});
  await click(button(form,'保存更正（保留旧记录）'));
  assert.equal(writes.length,1);assert.equal(writes[0].args.memoryId,'cold-600');assert.equal(writes[0].args.revision,3);
  assert.equal(writes[0].args.expectedVersion,4);
});

test('late world page never replaces a changed campaign, version or disposed view; IME enter is not search',async()=>{
  for(const change of ['campaign','version','dispose']){
    const ctx=context();delete ctx.snapshot.worldMemoryPaging;let resolve,disposed=false,calls=0;
    ctx.read=()=>{calls++;return new Promise(r=>{resolve=r;});};
    const card=worldMemoryCard(ctx,()=>disposed),query=input(card,'检索世界信息');
    query.value='old';query.dispatchEvent({type:'keydown',key:'Enter',isComposing:true});assert.equal(calls,0);
    button(card,'检索').dispatchEvent({type:'click'});assert.equal(calls,1);
    if(change==='campaign')ctx.snapshot.id='other';else if(change==='version')ctx.snapshot.version++;else disposed=true;
    resolve(page([{...entry(),name:'LATE-SECRET'}]));await settle();
    assert.ok(!card.textContent.includes('LATE-SECRET'));
  }
});

test('category switches keep query, reset offset and ignore older requests including their busy state',async()=>{
  const ctx=context(),reads=[];
  ctx.read=(name,args)=>new Promise((resolve,reject)=>reads.push({args,resolve,reject}));
  const card=worldMemoryCard(ctx),tabs=card.querySelectorAll('[role=tab]');
  assert.equal(reads[0].args.kind,'npc');
  assert.ok(!card.textContent.includes('600 条'),'recent mixed snapshot is not a category total');
  await click(button(card,'地点'));assert.equal(reads[1].args.kind,'place');
  assert.equal(tabs[2].getAttribute('aria-selected'),'true');
  reads[0].resolve({...page([{...entry(),kind:'npc',name:'过时的人物'}])});await settle();
  assert.ok(!card.textContent.includes('过时的人物'));assert.equal(button(card,'检索').disabled,true);
  reads[1].resolve(page([{...entry(),kind:'place',name:'远方灯塔'}]));await settle();
  assert.match(card.textContent,/远方灯塔/);assert.equal(button(card,'检索').disabled,false);
  const query=input(card,'检索世界信息');query.value='灯';await click(button(card,'任务'));
  assert.deepEqual(reads[2].args,{expectedVersion:4,query:'灯',kind:'quest',offset:0,limit:32,scope:'host'});
  reads[2].reject(new Error('临时读取失败'));await settle();assert.match(card.textContent,/临时读取失败/);
  assert.equal(tabs[1].getAttribute('aria-selected'),'true');assert.equal(query.value,'灯');
  await click(button(card,'检索'));assert.equal(reads[3].args.kind,'quest');
  reads[3].resolve({...page([]),total:0});await settle();assert.match(card.textContent,/没有符合条件的任务记录/);
  tabs[1].dispatchEvent({type:'keydown',key:'ArrowRight',preventDefault(){}});
  assert.equal(document.activeElement,tabs[2]);assert.equal(reads[4].args.kind,'place');
  assert.deepEqual(tabs.map(tab=>tab.tabIndex),[-1,-1,0,-1]);
  reads[4].resolve({...page([]),total:0});await settle();
});

test('switching categories preserves correction drafts and invalidates detached controls',async()=>{
  const ctx=context();delete ctx.snapshot.worldMemoryPaging;
  ctx.snapshot.worldMemory=[{...entry(),kind:'npc',name:'守望人'}, {...entry('place'),kind:'place',name:'灯塔'}];
  let writes=0;ctx.submit=async()=>{writes++;};
  const card=worldMemoryCard(ctx),old=card.querySelector('.world-correct');
  const reason=input(old,'更正理由');reason.value='保留我的纠错草稿';reason.dispatchEvent({type:'input'});
  await click(button(card,'地点'));await click(button(old,'保存更正（保留旧记录）'));assert.equal(writes,0);
  await click(button(card,'人物'));assert.equal(input(card.querySelector('.world-correct'),'更正理由').value,'保留我的纠错草稿');
});

test('guest query stays public, renders empty match and never opens correction UI',async()=>{
  const ctx=context();ctx.snapshot.party.isHost=false;let requested;
  ctx.read=async(name,args)=>{requested=args;return {...page([]),scope:'public',total:0};};
  const card=worldMemoryCard(ctx);await click(button(card,'检索'));
  assert.equal(requested.scope,'public');assert.ok(card.textContent.includes('暂无人物记录'));
  assert.equal(card.querySelectorAll('.world-correct').length,0);
  assert.equal(button(card,'下一页').disabled,true);
  assert.equal(card.querySelector('.world-paging').hidden,true,'empty or single-page results do not show two disabled controls');
});

// Render-level tests for the continuity UI. They use the real views/activity modules against a
// tiny DOM stand-in and assert the actual reads and payloads, not element counts.
import test from 'node:test';
import assert from 'node:assert/strict';
import {installDom,settle} from './dom-shim.mjs';

installDom();
const {renderRulingContext,renderStoryFollowup}=await import('../src/activity.js');

const entry={sequence:12,version:9,actorId:'player',createdAt:'2025-01-01T00:00:00+00:00',kind:'observe',status:'awaiting_ruling',legacy:false,
  origin:{input:'观察祭坛',label:'观察',requestedKind:'observe',target:'',actorName:'游侠',sceneId:'s1',sceneTitle:'祭坛',elapsedSecondsBefore:3600,elapsedSecondsAfter:5400,
    changes:[{actorId:'player',operation:'inventory',key:'torch',label:'游侠 · 火把',before:'3',after:'2'},{actorId:'player',operation:'hp',key:'',label:'游侠 · HP',before:'12',after:'9'}]},
  initialResult:{check:{ability:'wisdom',skill:'Perception',rolls:[14],modifier:5,total:19,dc:15,success:true,hasDc:true}},narrative:'',narrativeSource:'',ruling:null};
const options={version:9,rulingId:'r-1',facts:[{key:'altar.open',present:false},{key:'guard.calm',present:true}],
  actions:[{id:'a1',label:'推开石门',outcome:'success',available:true,reason:''},{id:'a2',label:'独自祈祷',outcome:'failure',available:false,reason:'条件不满足'}],
  notice:'仅列出导入内容声明或引用的事实。'};
const page={campaignId:'c1',version:9,through:9,after:0,nextAfter:9,hasMore:false,
  entries:[entry,{...entry,sequence:11,status:'completed',ruling:{id:'r-0',originSequence:11,story:null}}]};
const catalog={ruleset:'dnd2024',equipment:[],conditions:['中毒']};
const rulings=[
  {id:'r-1',text:'观察祭坛',status:'pending',reason:'需要裁定',actorId:'player',sceneId:'s1',outcome:'',rationale:'',ruleSource:'',originSequence:12},
  {id:'r-2',text:'检定后的行动',status:'resolved',reason:'需要裁定',actorId:'player',sceneId:'s1',outcome:'check',rationale:'理由',ruleSource:'DM',originSequence:11,
    check:{ability:'wisdom',skill:'Perception',rolls:[14],modifier:5,total:19,dc:15,success:true,hasDc:true},
    effects:[{operation:'inventory',key:'torch',label:'游侠 · 火把',before:'3',after:'2'}],resolvedAt:'2025-01-02T00:00:00+00:00'},
  {id:'r-3',text:'推开石门',status:'resolved',reason:'需要裁定',actorId:'player',sceneId:'s1',outcome:'story',rationale:'理由',ruleSource:'DM',originSequence:10,
    story:{resultText:'石门已开启',mode:'facts',rationale:'理由',ruleSource:'DM',resolvedBy:'host',resolvedAt:'2025-01-03T00:00:00+00:00',
      changes:[{kind:'fact',key:'gate.open',label:'事实 · gate.open',before:'未确认',after:'已确认'}]}}];
const character={name:'游侠',className:'Ranger',level:3,hitPoints:9,maxHitPoints:12,armorClass:15,exhaustion:0,conditions:[],resources:[],inventory:[]};
const base={id:'c1',name:'测试战役',version:9,chapter:1,archived:false,scene:{id:'s1',title:'祭坛',summary:'祭坛'},
  party:{isHost:true,selfActorId:'player',canInvite:true,invitations:[],members:[{id:'player',role:'player',revoked:false,character}]},
  pendingRulings:rulings,combat:null,content:{status:'active'},facts:[],events:[],availableActions:[]};

function drive({host,optionsVersion=9}){
  const calls=[],submitted=[],refreshed=[];
  const snapshot={...base,party:{...base.party,isHost:host}};
  const ctx={origin:'http://127.0.0.1:5186',snapshot,hasPending:()=>false,invitation:()=>null,
    report:error=>{throw error;},refresh:async()=>{refreshed.push(true);},submit:async(endpoint,payload)=>{submitted.push({endpoint,payload});},
    read:async(endpoint,payload)=>{calls.push({endpoint,payload});
      if(endpoint==='activity-entry')return entry;
      if(endpoint==='rulings/story-options')return {...options,version:optionsVersion};
      if(endpoint==='character-play/catalog')return catalog;
      if(endpoint==='activity')return page;
      if(endpoint==='rulings/story-preview')return {version:optionsVersion,rulingId:payload.rulingId,mode:payload.mode,actionLabel:'确认剧情事实',
        resultText:'主持已确认剧情事实。',changes:[{kind:'fact',key:'altar.open',label:'事实 · altar.open',before:'未确认',after:'已确认'}],warnings:['预览只对当前版本有效。']};
      throw new Error('unexpected read '+endpoint);}};
  return {ctx,calls,submitted,refreshed};
}
function renderRulings(mount,ctx){
  // The pending panel opens one ruling at a time: its original action plus the story follow-up.
  for(const ruling of ctx.snapshot.pendingRulings.filter(r=>r.status==='pending'||r.outcome==='check')){
    mount.append(renderRulingContext(ctx,ruling,{auto:ruling.status==='pending'}));
    const followup=renderStoryFollowup(ctx,ruling);if(followup)mount.append(followup);
  }
  return settle();
}
async function openFollowup(mount){
  const form=mount.querySelectorAll('.story-followup')[0];
  form.open=true;form.dispatchEvent({type:'toggle'});await settle();
  return form;
}

test('rulings show original action context and read-only activity for the host',async()=>{
  const {ctx,calls}=drive({host:true});
  const mount=document.createElement('div');
  await renderRulings(mount,ctx);
  assert.ok(calls.some(c=>c.endpoint==='activity-entry'&&c.payload.sequence===12),'pending ruling loads its original action');
  assert.ok(mount.textContent.includes('观察祭坛'),'original input is rendered from server data');
  const details=mount.querySelector('.ruling-origin-detail');
  assert.ok(details.textContent.includes('火把：3 → 2'),'recorded paid costs are shown');
  assert.ok(details.textContent.includes('冒险时间成本：1 小时 0 分 → 1 小时 30 分'),'authoritative time cost shows before-to-after only when it differs');
  assert.ok(details.textContent.includes('察觉')&&!details.textContent.includes('Perception'),'linked recorded check is shown with its Chinese label');
});

test('story settlement keeps preview, exact confirmation and no auto-write',async()=>{
  const {ctx,calls,submitted,refreshed}=drive({host:true});
  const mount=document.createElement('div');
  await renderRulings(mount,ctx);
  assert.equal(mount.querySelectorAll('.story-followup').length,2,'resolved checks still get a follow-up form');
  const form=await openFollowup(mount);
  assert.ok(calls.some(c=>c.endpoint==='rulings/story-options'&&c.payload.rulingId==='r-1'),'options come from the server');
  assert.ok(form.textContent.includes('服务端结果'),'action options expose the server-chosen outcome');
  assert.ok(form.textContent.includes('不可用'),'unavailable actions are shown with their reason');
  form.querySelector('select').value='facts';
  const factBox=form.querySelectorAll('fieldset')[0].querySelectorAll('input')[0];
  factBox.checked=true;factBox.dispatchEvent({type:'change'});
  form.querySelectorAll('textarea')[0].value='确认祭坛已开启';
  form.querySelectorAll('input[type=text]')[0].value='本场约定';
  const buttons=form.querySelectorAll('.btn');
  buttons[0].dispatchEvent({type:'click'});await settle();
  const preview=calls.find(c=>c.endpoint==='rulings/story-preview');
  assert.ok(preview,'preview is an explicit server call');
  assert.equal(preview.payload.mode,'facts');assert.equal(preview.payload.expectedVersion,9);assert.equal(preview.payload.rationale,'确认祭坛已开启');
  assert.deepEqual(preview.payload.facts,[{key:'altar.open',present:true}],'only changed declared facts are submitted');
  assert.equal(submitted.length,0,'preview alone never writes');
  assert.equal(buttons[1].disabled,false,'confirm enables only after a server preview');
  buttons[1].dispatchEvent({type:'click'});await settle();
  const confirm=document.body.querySelectorAll('.btn').find(b=>b.textContent==='确认落实');
  assert.ok(confirm,'commit needs an explicit dialog');
  confirm.dispatchEvent({type:'click'});await settle();
  assert.equal(submitted.length,1);assert.equal(submitted[0].endpoint,'rulings/story');
  assert.equal(submitted[0].payload.requestId,preview.payload.requestId,'commit reuses the previewed requestId');
  assert.equal(submitted[0].payload.expectedVersion,9);assert.equal(refreshed.length,1);
});

test('guests and stale options never see or request story options',async()=>{
  const guest=drive({host:false});
  const guestMount=document.createElement('div');
  await renderRulings(guestMount,guest.ctx);
  assert.equal(guestMount.querySelectorAll('.story-followup').length,0,'guests get no settlement form');
  assert.ok(!guest.calls.some(c=>c.endpoint==='rulings/story-options'),'guests never request host-only options');
  const stale=drive({host:true,optionsVersion:8});
  const staleMount=document.createElement('div');
  await renderRulings(staleMount,stale.ctx);
  const form=await openFollowup(staleMount);
  assert.ok(form.textContent.includes('请刷新页面后重新展开此表单'),'version drift is called out before preview');
  form.querySelectorAll('.btn')[0].dispatchEvent({type:'click'});await settle();
  assert.ok(!stale.calls.some(c=>c.endpoint==='rulings/story-preview'),'stale options never trigger preview');
  assert.equal(stale.submitted.length,0,'stale options never commit');
  assert.ok(form.textContent.includes('战役状态已更新'),'stale preview is refused with an explicit reason');
});

test('failed context and story-options GETs retry locally without losing another form draft',async()=>{
  const {ctx,submitted}=drive({host:true});const original=ctx.read;const attempts={};
  ctx.read=async(endpoint,payload)=>{
    attempts[endpoint]=(attempts[endpoint]||0)+1;
    if(attempts[endpoint]===1)throw new Error('读取暂时失败');
    if(endpoint==='activity-entry')return {...entry,initialResult:{...entry.initialResult,summary:'古代封印是否会回应这次触碰？ <b>原文</b>'}};
    return original(endpoint,payload);
  };
  const mount=document.createElement('div'),note=document.createElement('textarea');note.value='尚未发送的裁定理由';mount.append(note);
  const context=renderRulingContext(ctx,{...rulings[0],reason:''},{auto:true,inline:true});
  const story=renderStoryFollowup(ctx,rulings[0],{auto:true,inline:true});mount.append(context,story);await settle();
  for(const [box,label] of [[context,'重新读取行动'],[story,'重新读取剧情选项']]){
    const retry=box.querySelectorAll('button').find(b=>b.textContent===label);assert.ok(retry);
    retry.dispatchEvent({type:'click'});retry.dispatchEvent({type:'click'});
  }
  await settle();assert.equal(attempts['activity-entry'],2);assert.equal(attempts['rulings/story-options'],2);
  assert.ok(context.textContent.includes('古代封印是否会回应'));assert.ok(context.textContent.includes('<b>原文</b>'));assert.equal(context.querySelector('b'),null);
  assert.equal(note.value,'尚未发送的裁定理由');assert.equal(submitted.length,0);assert.ok(story.querySelector('textarea'));
});

test('ruling question uses the authorized reason, not the public waiting summary',async()=>{
  const question='请裁定隐匿阈值；<b>原文</b>';
  const publicSummary='已交给主持判断，等待回应。';
  const box=renderRulingContext({read:async()=>({...entry,initialResult:{summary:publicSummary}})},
    {...rulings[0],reason:question},{auto:true,inline:true});
  await settle();assert.ok(box.textContent.includes(question));assert.ok(!box.textContent.includes(publicSummary));
  assert.equal(box.querySelector('b'),null);
});

test('closed ruling context ignores late retry results',async()=>{
  let closed=false,release,calls=0;
  const box=renderRulingContext({read:async()=>{if(++calls===1)throw new Error('读取失败');return new Promise(resolve=>release=resolve);}},rulings[0],{auto:true,inline:true,isDisposed:()=>closed});
  await settle();box.querySelector('button').dispatchEvent({type:'click'});closed=true;release(entry);await settle();
  assert.ok(!box.textContent.includes('火把：'));assert.equal(calls,2);
});

test('intent clarifications stay plain text in ruling context',async()=>{
  const clarified={...entry,kind:'intent.request',status:'awaiting_confirmation',origin:{...entry.origin,
    input:'我要施法',changes:[],clarifications:[{question:'哪种施法来源？',answer:'<img src=x onerror=alert(1)> 法师职业'}]}};
  const calls=[];
  const box=renderRulingContext({read:async(endpoint,payload)=>{calls.push({endpoint,payload});return clarified;}},rulings[0],{auto:true,compact:true});
  await settle();
  assert.equal(calls.length,1);assert.equal(calls[0].payload.sequence,12);
  assert.ok(box.textContent.includes('我要施法'));assert.ok(box.textContent.includes('哪种施法来源？'));
  assert.ok(box.textContent.includes('<img src=x onerror=alert(1)> 法师职业'));
  assert.equal(box.querySelectorAll('img').length,0,'player-supplied answer must not become markup');
});

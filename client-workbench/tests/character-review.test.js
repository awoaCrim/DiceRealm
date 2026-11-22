import test from 'node:test';
import assert from 'node:assert/strict';
import {installDom,settle} from './dom-shim.mjs';
import {prepare,requestPath,versioned,createApi,ApiError} from '../src/api.js';
import {clearCampaignDrafts,readDraft,draftKey,writeDraft} from '../src/drafts.js';
installDom();
const {characterReview,openCharacterReview,confirmCharacterReview}=await import('../src/character-review.js');
const {createHostTasks}=await import('../src/pending-panel.js');
const {createDrawerHost}=await import('../src/workspace-dialog.js');
// The review body and its foot (note + decisions) read as one card in these tests.
function characterReviewsCard(ctx,isDisposed=()=>false){
  const member=ctx.snapshot.party.members.find(m=>!m.revoked&&m.review?.status==='pending');
  const view=characterReview(ctx,member,isDisposed);const card=document.createElement('div');card.append(view.body,view.foot);return card;
}

function fixture(scope='review-test'){
  clearCampaignDrafts(scope);
  const errors=[],submits=[];
  const ctx={scope,snapshot:{id:'campaign',version:3,chapter:1,archived:false,scene:{title:'港口'},pendingRulings:[],facts:[],
    party:{isHost:true,members:[{id:'guest',revoked:false,role:'player',character:{name:'新法师',species:'Human',className:'Wizard',level:1,abilities:[],inventory:[]},review:{status:'pending',revision:1,submission:'寻找老师'}}]}},
    hasPending:()=>false,read:async()=>null,refresh:async()=>{},report:e=>errors.push(e.message),submit:async(endpoint,payload)=>submits.push({endpoint,payload})};
  return {ctx,errors,submits};
}
const button=(card,label)=>card.querySelectorAll('button').find(b=>b.textContent===label);
const click=async b=>{b.dispatchEvent({type:'click'});await settle();};

test('review API is versioned, allowlisted and sends no character state',async()=>{
  const p={requestId:'id',expectedVersion:3,actorId:'guest',revision:2,decision:'approve',reason:'已阅读',hitPoints:999};
  assert.ok(versioned.has('characters/review'));
  assert.deepEqual(prepare('characters/review',p),{requestId:'id',expectedVersion:3,actorId:'guest',revision:2,decision:'approve',reason:'已阅读'});
  assert.equal(requestPath('characters/review',{campaignId:'c'}),'/api/v1/campaigns/c/characters/review');
  const api=createApi({fetchImpl:async()=>({ok:true,text:async()=>JSON.stringify({snapshot:{id:'c',version:4},resolution:{status:'resolved'}})})});
  assert.equal((await api.request('characters/review',{campaignId:'c',accessToken:'test'},p)).snapshot.version,4);
  const incomplete=createApi({fetchImpl:async()=>({ok:true,text:async()=>JSON.stringify({snapshot:{id:'c'}})})});
  await assert.rejects(incomplete.request('characters/review',{campaignId:'c',accessToken:'test'},p),e=>e instanceof ApiError&&e.unconfirmed);
});

test('character review hides book provenance without losing choices or mutating data',()=>{
  const {ctx}=fixture('review-provenance');
  const ch=ctx.snapshot.party.members[0].character;
  ch.source='XPHB';ch.hitPoints=7;ch.maxHitPoints=12;ch.armorClass=14;
  ch.features=['background:sage 法术来源'];ch.build={ruleset:'dnd2024',revision:'private-source-revision',identity:{backstory:'玩家自己的 XMM 故事'},selections:[{key:'species:human/skill',values:['Arcana']}]};
  const original=JSON.stringify(ch);const card=characterReviewsCard(ctx);
  assert.ok(!card.textContent.includes('规则来源'));assert.ok(!card.textContent.includes('XPHB'));assert.ok(!card.textContent.includes('private-source-revision'));
  assert.ok(card.textContent.includes('学者 法术来源'));assert.ok(card.textContent.includes('技能熟练（人类）'));assert.ok(card.textContent.includes('7/12'));
  assert.ok(card.textContent.includes('玩家自己的 XMM 故事'));assert.equal(JSON.stringify(ch),original);
});

test('character review shows a real build in Chinese without raw JSON',()=>{
  const {ctx}=fixture('review-chinese');
  const ch=ctx.snapshot.party.members[0].character;
  Object.assign(ch,{species:'Human',className:'Rogue',background:'Acolyte',hitPoints:10,maxHitPoints:10,armorClass:12,
    features:['Sneak Attack',"Thieves' Cant",'Magic Initiate','Languages: common, common-sign-language, thieves-cant','Size: S; speed: 30 ft','Saving throw proficiencies: dexterity, intelligence'],
    skills:['Insight','Sleight of Hand'],abilities:[{name:'strength',score:8,modifier:-1},{name:'dexterity',score:15,modifier:2}],
    inventory:[{id:'leather-armor',name:'Leather Armor',quantity:1},{id:'gold-piece',name:'Gold Piece',quantity:16}],
    build:{revision:'r',abilityMethod:'point-buy',backgroundBonuses:[0,0,0,2,1,0],classSkills:['sleight-of-hand'],expertise:['sleight-of-hand'],
      selections:[{key:'species:human/origin-feat',values:['alert']},{key:'background:acolyte/feat:magic-initiate/cleric/cantrips',values:['guidance','light']},{key:'class:rogue/masteries',values:['dagger']}],
      cantrips:[],preparedSpells:[],spellbook:[],classEquipment:'A',backgroundEquipment:'A',purchases:[],equipped:[],identity:{name:'xxk',alignment:'neutral-evil',backstory:''}}});
  const card=characterReviewsCard(ctx),text=card.textContent;
  assert.deepEqual(card.querySelectorAll('.ab').map(cell=>cell.getAttribute('aria-label')),['力量 8（−1）','敏捷 15（+2）']);
  for(const part of ['人类','游荡者','侍僧','中立邪恶','偷袭','盗贼黑话','魔法初学者','通用语、通用手语、盗贼黑话语','小型 · 速度：30 尺','敏捷、智力',
    '巧手（专精）','皮甲 ×1','购点','智力 +2、感知 +1','起源专长（人类）','警觉','戏法（侍僧 · 魔法初学者 · 牧师）','神导术','武器精通（游荡者）','匕首','选项 A'])
    assert.ok(text.includes(part),part);
  for(const raw of ['Human','Rogue','Sneak Attack','strength','"cantrips"','neutral-evil','Languages:'])assert.ok(!text.includes(raw),raw);
  assert.ok(text.includes('物种')&&!text.includes('种族'),'the same term as the game');
});

test('host sees review first in the task strip, opens it in the pane; guests never get approval controls',async()=>{
  document.body.replaceChildren();const {ctx}=fixture();
  ctx.snapshot.pendingRulings=[{id:'r',status:'pending',text:'我想撬开箱子',actorId:'guest'}];
  ctx.read=async key=>{assert.equal(key,'model-requests');return {requests:[{id:1,finished:true,status:503,error:'上游失败',attempt:1}],nextBefore:null};};
  const owner=document.createElement('div'),column=document.createElement('aside');document.body.append(owner);owner.append(column);
  const pane=createDrawerHost(column,owner),tasks=createHostTasks(ctx,{isDisposed:()=>false,pane});owner.append(tasks.element);await tasks.refresh();
  assert.deepEqual(tasks.element.querySelectorAll('.kind').map(n=>n.textContent),['角色审核','需人工裁定','请求错误']);
  assert.equal(tasks.element.querySelector('details'),null);
  assert.ok(!tasks.element.textContent.includes('寻找老师'),'long character details do not expand the task strip');
  await click(tasks.element.querySelectorAll('button')[0]);
  assert.equal(document.body.querySelector('dialog'),null,'the review docks beside the story instead of opening a modal');
  assert.ok(column.textContent.includes('寻找老师'));assert.ok(!column.textContent.includes('部分能力仍需主持裁定'));
  assert.equal(column.querySelector('details'),null);
  assert.equal(tasks.element.querySelector('.todo-row').classList.contains('is-open'),true);
  assert.equal(tasks.element.querySelectorAll('button')[0].textContent,'处理中');
  owner.dispatchEvent({type:'dispose'});
  ctx.snapshot.party.isHost=false;let opened=false;
  assert.equal(openCharacterReview(ctx,'guest',{open:()=>{opened=true;}}),false);assert.equal(opened,false);
});

test('a task strip redraw leaves the selected review pane alive and retains its draft',async()=>{
  document.body.replaceChildren();const {ctx,submits}=fixture('drawer-review-poll');
  ctx.read=async()=>({requests:[],nextBefore:null});
  const owner=document.createElement('div'),column=document.createElement('aside');
  document.body.append(owner);owner.append(column);const pane=createDrawerHost(column,owner);
  const tasks=createHostTasks(ctx,{isDisposed:()=>false,pane});owner.append(tasks.element);await tasks.refresh();
  await click(tasks.element.querySelectorAll('button')[0]);const note=column.querySelector('textarea');
  note.value='轮询过程中保留意见';note.dispatchEvent({type:'input'});
  await tasks.refresh();
  assert.equal(column.querySelector('textarea'),note);assert.equal(pane.isOpen(),true);
  await click(button(column,'退回修改'));assert.equal(submits.length,1);assert.equal(submits[0].payload.reason,'轮询过程中保留意见');
  owner.dispatchEvent({type:'dispose'});assert.equal(pane.isOpen(),false);
});

test('return requires a reason, approval freezes actor and revision, double-click writes once',async()=>{
  const {ctx,submits}=fixture();const card=characterReviewsCard(ctx);
  await click(button(card,'退回修改'));assert.equal(submits.length,0);assert.ok(card.textContent.includes('请说明'));
  const note=card.querySelector('textarea');note.value='  请补角色动机  ';note.dispatchEvent({type:'input'});
  const btn=button(card,'退回修改');btn.dispatchEvent({type:'click'});btn.dispatchEvent({type:'click'});await settle();
  assert.equal(submits.length,1);assert.deepEqual(submits[0],{endpoint:'characters/review',payload:{expectedVersion:3,actorId:'guest',revision:1,decision:'return',reason:'请补角色动机'}});
});

test('drafts stay in seat and revision; stale snapshot or disposed view cannot approve',async()=>{
  const {ctx,submits}=fixture();const card=characterReviewsCard(ctx);const note=card.querySelector('textarea');
  note.value='尚未发送意见';note.dispatchEvent({type:'input'});
  assert.equal(characterReviewsCard(ctx).querySelector('textarea').value,'尚未发送意见');
  assert.equal(characterReviewsCard({...ctx,scope:'other-seat'}).querySelector('textarea').value,'');
  ctx.snapshot.version++;await click(button(card,'批准加入'));assert.equal(submits.length,0);
  assert.ok(card.textContent.includes('资料已更新'));
  ctx.snapshot.party.members[0].review.revision=2;assert.equal(characterReviewsCard(ctx).querySelector('textarea').value,'');
  const disposed=characterReviewsCard(ctx,()=>true);await click(button(disposed,'批准加入'));assert.equal(submits.length,0);
});

test('explicit reread adopts current version in place and keeps edits made during its GET',async()=>{
  const {ctx,submits}=fixture('review-reload');let reads=0,release;
  ctx.liveConnection=()=>({snapshot:async()=>{reads++;await new Promise(resolve=>release=resolve);return ctx.snapshot;}});
  const card=characterReviewsCard(ctx),note=card.querySelector('textarea');
  note.value='先保留的意见';note.dispatchEvent({type:'input'});ctx.snapshot.version=4;
  await click(button(card,'批准加入'));assert.equal(submits.length,0);
  button(card,'重新读取当前资料').dispatchEvent({type:'click'});
  button(card,'重新读取当前资料').dispatchEvent({type:'click'});
  note.value='读取期间的新意见';note.dispatchEvent({type:'input'});
  ctx.snapshot.party.members[0].review.revision=2;ctx.snapshot.party.members[0].character.name='更新后的角色';
  release();await settle();assert.equal(reads,1);assert.equal(submits.length,0);
  assert.equal(card.querySelector('textarea'),note);assert.equal(note.value,'读取期间的新意见');
  assert.ok(card.textContent.includes('更新后的角色'));assert.ok(card.textContent.includes('第 2 次提交'));
  await click(button(card,'批准加入'));assert.equal(submits.length,1);
  assert.equal(submits[0].payload.expectedVersion,4);assert.equal(submits[0].payload.revision,2);assert.equal(submits[0].payload.reason,'读取期间的新意见');
});

test('reread failure can retry and a disposed dialog ignores the late GET',async()=>{
  const {ctx,submits}=fixture('review-reload-failure');let fail=true,closed=false,release;
  ctx.liveConnection=()=>({snapshot:async()=>{if(fail)throw new Error('临时读取失败');await new Promise(resolve=>release=resolve);return ctx.snapshot;}});
  const card=characterReviewsCard(ctx,()=>closed),note=card.querySelector('textarea');
  note.value='不可丢失';note.dispatchEvent({type:'input'});
  await click(button(card,'重新读取当前资料'));assert.ok(card.textContent.includes('临时读取失败'));assert.equal(note.value,'不可丢失');
  fail=false;button(card,'重新读取当前资料').dispatchEvent({type:'click'});closed=true;
  ctx.snapshot.party.members[0].character.name='迟到资料';release();await settle();
  assert.ok(!card.textContent.includes('迟到资料'));assert.equal(submits.length,0);
});

test('known admission blockers explain approval without blocking a return',async()=>{
  const {ctx,submits}=fixture('review-blocker');ctx.snapshot.combat={status:'active'};
  const card=characterReviewsCard(ctx);assert.ok(button(card,'批准加入').disabled);assert.ok(!button(card,'退回修改').disabled);
  assert.ok(card.textContent.includes('战斗尚未结束'));
  await click(button(card,'批准加入'));assert.equal(submits.length,0);
  card.querySelector('textarea').value='请补充';await click(button(card,'退回修改'));assert.equal(submits.length,1);
  ctx.snapshot.combat=null;ctx.snapshot.pendingRoll={id:'r'};
  assert.ok(characterReviewsCard(ctx).textContent.includes('有待投掷请求'));
});

test('unconfirmed response retains exact draft; original success cannot clear later edits',async()=>{
  const {ctx,errors}=fixture();ctx.submit=async()=>{throw new Error('原请求待确认');};
  const card=characterReviewsCard(ctx),note=card.querySelector('textarea');note.value='核对完成';note.dispatchEvent({type:'input'});
  await click(button(card,'批准加入'));assert.deepEqual(errors,['原请求待确认']);
  assert.equal(characterReviewsCard(ctx).querySelector('textarea').value,'核对完成');
  const key=draftKey(ctx.scope,'character-review:guest:1');writeDraft(key,'后续意见');
  confirmCharacterReview(ctx.scope,{actorId:'guest',revision:1,reason:'核对完成'});assert.equal(readDraft(key),'后续意见');
  confirmCharacterReview(ctx.scope,{actorId:'guest',revision:1,reason:'后续意见'});assert.equal(readDraft(key),'');
});

test('review names species features like the sheet and labels starting-pack choices',async()=>{
  const {featureText,selectionRow}=await import('../src/rule-labels.js');
  assert.equal(featureText('Versatile'),'全能','the human trait, not the weapon property');
  assert.equal(featureText('Resourceful'),'机智');
  const [label,value]=selectionRow({key:'equipment:background/A/0',values:['dice-set']});
  assert.equal(label,'装备包内自选（背景起始方案 A）');
  assert.ok(!/background|[A-Za-z]-[a-z]/.test(value),value);
});

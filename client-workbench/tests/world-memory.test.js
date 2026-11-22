// Focused tests for world-memory read/correction: permissions, frozen versions,
// draft survival, exact retry and read-only legacy narrative corrections.
import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {installDom,settle} from './dom-shim.mjs';
import {prepare,requestPath,versioned,createApi,ApiError} from '../src/api.js';
import {createPendingStore} from '../src/pending.js';
import {clearCampaignDrafts,writeDraft,readDraft,draftKey} from '../src/drafts.js';

installDom();
const {worldMemoryCard,WorldMemoryDraft,confirmWorldMemoryDraft}=await import('../src/world-memory.js');
const {confirmAdventureCorrection,correctionNotice}=await import('../src/activity.js');
const {storyMessages}=await import('../src/story.js');
const storyRow=(entry,options)=>{const box=document.createElement('div');box.append(...storyMessages(entry,options?.ctx?.snapshot));return box;};

const session={baseUrl:'http://127.0.0.1:5199',campaignId:'c-one',accessToken:'a'.repeat(64)};
const memory=()=>{const map=new Map();return{getItem:k=>map.get(k)||null,setItem:(k,v)=>map.set(k,v),removeItem:k=>map.delete(k)};};
const byLabel=(root,prefix)=>['input','textarea','select'].flatMap(tag=>root.querySelectorAll(tag)).find(el=>(el.getAttribute('aria-label')||'').startsWith(prefix));
const byText=(root,text)=>root.querySelectorAll('button').find(el=>el.textContent===text);
const click=async el=>{el.dispatchEvent({type:'click'});await settle();};

const record={id:'m1',kind:'npc',name:'守卫',summary:'认识码头',status:'known',sceneId:'s1',revision:2,originSequence:10,updatedSequence:11,actorId:'p1',source:'ai',hidden:false};
const hidden={...record,id:'m2',kind:'clue',name:'密信',summary:'尚未公开',hidden:true};
const place={...record,id:'m3',kind:'place',name:'灯塔',summary:'海岸边',sceneId:'s2',updatedSequence:9};
function snapshot(host,campaignId='wm-campaign',version=4){return {id:campaignId,version,chapter:1,archived:false,scene:{id:'s1',title:'港口'},
  party:{isHost:host,selfActorId:'p1',members:[]},worldMemory:[record,hidden,place]};}
function drive(host,scope,campaignId,version=4){
  const submits=[],refreshed=[];
  const ctx={scope,snapshot:snapshot(host,campaignId,version),hasPending:()=>false,report:error=>{throw error;},
    refresh:async()=>{refreshed.push(true);},submit:async(endpoint,payload)=>{submits.push({endpoint,payload});}};
  return {ctx,submits,refreshed};
}

test('world correction commands are versioned, allowlisted endpoints with local draft metadata stripped',()=>{
  assert.ok(versioned.has('world/correct'));assert.ok(versioned.has('adventure/correct'));
  const world=prepare('world/correct',{requestId:'id',expectedVersion:4,memoryId:'m1',revision:2,name:'守卫',summary:'认识码头',
    status:'known',hidden:false,reason:'名字笔误',worldDraftRevision:'local-only',actorId:'not-a-field'});
  assert.deepEqual(world,{requestId:'id',expectedVersion:4,memoryId:'m1',revision:2,name:'守卫',summary:'认识码头',status:'known',hidden:false,reason:'名字笔误'});
  const adventure=prepare('adventure/correct',{requestId:'id',expectedVersion:4,originSequence:12,text:'更正正文',reason:'原作写错',
    adventureDraftRevision:'local-only',extra:'nope'});
  assert.deepEqual(adventure,{requestId:'id',expectedVersion:4,originSequence:12,text:'更正正文',reason:'原作写错'});
  assert.equal(requestPath('world/correct',session),'/api/v1/campaigns/c-one/world/correct');
  assert.equal(requestPath('adventure/correct',session),'/api/v1/campaigns/c-one/adventure/correct');
});

test('the correction endpoints accept only a complete action response and stay unconfirmed otherwise',async()=>{
  const payload={requestId:'id',expectedVersion:4,memoryId:'m1',revision:2,name:'守卫',summary:'认识码头',status:'known',hidden:false,reason:'笔误'};
  const ok=createApi({fetchImpl:async()=>new Response(JSON.stringify({snapshot:{id:'c-one',version:5},resolution:{status:'resolved'},replayed:false}))});
  assert.equal((await ok.request('world/correct',session,payload)).snapshot.version,5);
  const partial=createApi({fetchImpl:async()=>new Response(JSON.stringify({snapshot:{id:'c-one'},resolution:{status:'resolved'}}))});
  await assert.rejects(partial.request('adventure/correct',session,{...payload,originSequence:12,text:'x'}),e=>e instanceof ApiError&&e.unconfirmed);
  const conflict=createApi({fetchImpl:async()=>new Response(JSON.stringify({code:'stale_version',message:'stale'}),{status:409})});
  await assert.rejects(conflict.request('world/correct',session,payload),e=>!e.unconfirmed&&e.code==='stale_version');
});

test('world category tabs show one kind at a time and members never see hidden records or correction forms',async()=>{
  const host={snapshot:snapshot(true)},guest={snapshot:snapshot(false)};
  const hostCard=worldMemoryCard(host);
  assert.deepEqual(hostCard.querySelectorAll('[role=tab]').map(tab=>tab.textContent),['人物','任务','地点','线索']);
  assert.ok(hostCard.textContent.includes('守卫'));assert.ok(!hostCard.textContent.includes('密信'));
  assert.equal(hostCard.querySelectorAll('.world-correct').length,1);
  await click(byText(hostCard,'线索'));
  assert.ok(hostCard.textContent.includes('密信'),'the host reads hidden records in their category');
  assert.ok(hostCard.textContent.includes('仅主持可见'));
  assert.ok(!hostCard.textContent.includes('守卫'));
  const empty=worldMemoryCard({snapshot:{...snapshot(false),worldMemory:[]}});
  assert.equal(empty.querySelectorAll('[role=tab]').length,4);
  assert.equal(empty.querySelectorAll('.world-record').length,0,'nothing is invented when the server sends no records');

  // Even if a snapshot wrongly carried hidden records, a member view must not render them.
  const guestCard=worldMemoryCard(guest);await click(byText(guestCard,'线索'));
  assert.ok(!guestCard.textContent.includes('密信'));assert.ok(!guestCard.textContent.includes('尚未公开'));
  assert.equal(guestCard.querySelectorAll('.world-correct').length,0);
  assert.equal(guestCard.querySelectorAll('textarea').length,0);
});

test('world memory drafts freeze campaign version and record revision and reject stale submits',async()=>{
  clearCampaignDrafts('wm-render');
  const {ctx,submits}=drive(true,'wm-render');
  const card=worldMemoryCard(ctx,()=>false);
  const row=card.querySelectorAll('.world-record').find(r=>r.textContent.includes('守卫'));
  const form=row.querySelector('.world-correct');
  await click(byText(form,'保存更正（保留旧记录）'));
  assert.equal(submits.length,0);
  assert.ok(form.textContent.includes('请填写更正理由'));

  const reason=byLabel(form,'更正理由');reason.value='  名字笔误  ';reason.dispatchEvent({type:'input'});
  await click(byText(form,'保存更正（保留旧记录）'));
  assert.equal(submits.length,1);
  assert.equal(submits[0].endpoint,'world/correct');
  assert.deepEqual({...submits[0].payload,worldDraftRevision:undefined},
    {expectedVersion:4,memoryId:'m1',revision:2,name:'守卫',summary:'认识码头',status:'known',hidden:false,reason:'名字笔误',worldDraftRevision:undefined});
  assert.equal(submits[0].payload.worldDraftRevision.length,36,'the local draft revision travels only with the retained request');
  clearCampaignDrafts('wm-render');

  const stale=drive(true,'wm-stale');
  const staleCard=worldMemoryCard(stale.ctx,()=>false);
  const staleRow=staleCard.querySelectorAll('.world-record').find(r=>r.textContent.includes('守卫'));
  const staleForm=staleRow.querySelector('.world-correct');
  const staleReason=byLabel(staleForm,'更正理由');staleReason.value='笔误';staleReason.dispatchEvent({type:'input'});
  stale.ctx.snapshot.version=5; // another action landed after this record was read
  await click(byText(staleForm,'保存更正（保留旧记录）'));
  assert.equal(stale.submits.length,0,'a frozen campaign version never auto-rebases');
  assert.ok(staleForm.textContent.includes('请放弃草稿并载入当前记录'));
  clearCampaignDrafts('wm-stale');
});

test('world memory drafts survive a re-render, stay seat-scoped and only clear on the matching ack',()=>{
  clearCampaignDrafts('wm-seat');clearCampaignDrafts('wm-other');
  const draft=new WorldMemoryDraft('wm-seat',record,4);
  assert.equal(draft.dirty,false);
  draft.values.name='守卫队长';draft.change();
  const reopened=new WorldMemoryDraft('wm-seat',record,4);
  assert.equal(reopened.values.name,'守卫队长');
  assert.equal(new WorldMemoryDraft('wm-other',record,4).values.name,'守卫');
  assert.deepEqual(reopened.submission(record),
    {expectedVersion:4,memoryId:'m1',revision:2,name:'守卫队长',summary:'认识码头',status:'known',hidden:false,reason:''});
  assert.equal(reopened.conflicts({...record,revision:3},4),true,'a newer record revision is a conflict');
  assert.equal(new WorldMemoryDraft('wm-clean',{...record,revision:3,name:'守卫队长'},4).values.name,'守卫队长','an untouched draft loads the current record');
  assert.equal(new WorldMemoryDraft('wm-clean',{...record,revision:3,name:'守卫队长'},5).dirty,false,'a clean draft never reports unsaved edits');
  clearCampaignDrafts('wm-seat');clearCampaignDrafts('wm-other');clearCampaignDrafts('wm-clean');
});

test('a late world memory ack clears only the exact draft revision it confirms',()=>{
  clearCampaignDrafts('wm-ack');
  const draft=new WorldMemoryDraft('wm-ack',record,4);
  draft.values.reason='笔误';draft.change();
  const confirmed=draft.state.revision;
  const payload={...draft.submission(record),worldDraftRevision:confirmed};
  confirmWorldMemoryDraft('other-seat',payload);
  assert.equal(new WorldMemoryDraft('wm-ack',record,4).dirty,true,'another seat cannot clear this seat draft');
  confirmWorldMemoryDraft('wm-ack',{...payload,expectedVersion:99});
  assert.equal(new WorldMemoryDraft('wm-ack',record,4).dirty,true,'a confirmation for another version never clears the draft');
  draft.values.reason='继续改';draft.change();
  confirmWorldMemoryDraft('wm-ack',payload);
  assert.equal(new WorldMemoryDraft('wm-ack',record,4).dirty,true,'an older confirmation never clears newer input');
  confirmWorldMemoryDraft('wm-ack',{...payload,worldDraftRevision:draft.state.revision});
  assert.equal(new WorldMemoryDraft('wm-ack',record,4).dirty,false);
  writeDraft(draftKey('wm-ack','world-memory:m1'),'{broken'); // a corrupt in-tab record is ignored, not thrown
  confirmWorldMemoryDraft('wm-ack',{memoryId:'m1',expectedVersion:4,worldDraftRevision:'x'});
  clearCampaignDrafts('wm-ack');
});

const narrativeEntry={sequence:12,version:9,actorId:'p1',createdAt:'2025-01-01T00:00:00+00:00',kind:'intent.request',status:'completed',legacy:false,
  origin:{input:'推门',label:'推门',requestedKind:'observe',target:'',actorName:'游侠',sceneId:'s1',sceneTitle:'祭坛',changes:[]},
  initialResult:{check:null},narrative:'你推开了门。',narrativeSource:'ai',ruling:null,correction:null};

test('story records never offer narrative correction, including completed host records',()=>{
  for(const host of [true,false])for(const status of ['completed','rejected','awaiting_ruling','awaiting_roll','awaiting_consequence','awaiting_confirmation','awaiting_clarification','cancelled']){
    const row=storyRow({...narrativeEntry,status},{ctx:{snapshot:snapshot(host)}});
    assert.equal(row.querySelectorAll('textarea').length,0);
    assert.equal(row.querySelectorAll('.narrative-correction').length,0);
    assert.ok(!row.textContent.includes('更正这段叙事'));
  }
});

test('the story feed keeps the original input and narrative while showing the latest correction',()=>{
  const corrected={...narrativeEntry,correction:{originSequence:12,text:'你推开的是侧门。',reason:'原作与场景不符',correctedBy:'host',correctedAt:'2025-01-02T00:00:00+00:00',sequence:13}};
  const row=storyRow(corrected);
  assert.ok(row.textContent.includes('推门'),'the original input is preserved');
  assert.ok(row.textContent.includes('你推开了门。'),'the original narrative is preserved');
  assert.ok(row.textContent.includes('最新更正'));assert.ok(row.textContent.includes('你推开的是侧门。'));
  assert.ok(row.textContent.includes('原作与场景不符'));
  assert.equal(row.querySelectorAll('.narrative-correction').length,0,'no ctx means a read-only row');
  assert.ok(!storyRow(corrected,{ctx:{snapshot:snapshot(false)}}).textContent.includes('更正这段叙事'));
  const hostRow=storyRow(corrected,{ctx:{snapshot:snapshot(true)}});
  assert.equal(hostRow.querySelectorAll('.narrative-correction').length,0);
  assert.ok(hostRow.textContent.includes('最新更正'));
  assert.equal(correctionNotice(null),null);
});

test('lost world and legacy narrative corrections retry byte-identically without local draft metadata',async()=>{
  for(const [endpoint,fields] of [
    ['world/correct',{memoryId:'m1',revision:2,name:'守卫',summary:'认识码头',status:'known',hidden:false,worldDraftRevision:'local-rev'}],
    ['adventure/correct',{originSequence:12,text:'旧叙事更正',adventureDraftRevision:'local-rev'}]
  ]){
    const pending=await createPendingStore({storage:memory(),session,cryptoObj:webcrypto});
    const payload=prepare(endpoint,{requestId:'same-id',expectedVersion:4,reason:'笔误',...fields});
    pending.capture(endpoint,payload);
    const sent=[];
    const api=createApi({fetchImpl:async(url,request)=>{sent.push(request.body);
      return new Response(JSON.stringify(sent.length===1?{snapshot:{id:'c-one'},resolution:{status:'resolved'}}:{snapshot:{id:'c-one',version:5},resolution:{status:'resolved'}}));}});
    await assert.rejects(()=>api.request(endpoint,session,JSON.parse(pending.read().payloadJson)),e=>e.unconfirmed);
    await api.request(endpoint,session,JSON.parse(pending.read().payloadJson));
    assert.equal(sent[0],sent[1],'the retry body is byte-identical');
    assert.equal(sent[0].includes('local-rev'),false,'local draft bookkeeping never leaves the tab');
    assert.equal(JSON.parse(sent[0]).expectedVersion,4,'the frozen version is not re-minted');
    pending.complete();assert.equal(pending.read(),null);
  }
});

test('world page shows recorded information, keeping host secrets and corrections host-only',async()=>{
  document.body.replaceChildren();const {renderWorld}=await import('../src/world.js');
  const host=drive(true,'live-a',undefined,4),hostMount=document.createElement('div');
  renderWorld(hostMount,host.ctx);
  await click(byText(hostMount,'线索'));assert.match(hostMount.textContent,/密信/);
  const fixes=hostMount.querySelectorAll('button').filter(b=>b.textContent==='纠正这条信息');
  assert.equal(fixes.length,1);
  fixes[0].dispatchEvent({type:'click'});await settle();
  assert.equal(document.body.querySelectorAll('dialog').length,1);assert.equal(document.body.querySelectorAll('.world-correct').length,1);
  hostMount.dispatchEvent({type:'dispose'});assert.equal(document.body.querySelector('dialog'),null);
  const guest=drive(false,'live-b',undefined,4),guestMount=document.createElement('div');
  renderWorld(guestMount,guest.ctx);
  assert.match(guestMount.textContent,/世界信息|冒险记录/);assert.doesNotMatch(guestMount.textContent,/密信/);
  assert.equal(guestMount.querySelectorAll('button').some(b=>b.textContent==='纠正这条信息'),false);guestMount.dispatchEvent({type:'dispose'});
});

test('legacy narrative correction acknowledgements clear only their matching draft',()=>{
  const scope='narrative-ack',key=draftKey(scope,'adventure-correction:12');
  const original=JSON.stringify({revision:'new-revision',version:9,sequence:12,dirty:true,text:'再改'});
  writeDraft(key,original);
  const payload={originSequence:12,expectedVersion:9,adventureDraftRevision:'new-revision'};
  for(const [seat,change] of [['other-seat',{}],[scope,{originSequence:11}],[scope,{expectedVersion:10}],[scope,{adventureDraftRevision:'old-revision'}]]){
    confirmAdventureCorrection(seat,{...payload,...change});assert.equal(readDraft(key),original);
  }
  confirmAdventureCorrection(scope,payload);assert.ok(!readDraft(key));
  clearCampaignDrafts(scope);
});

test('confirmed correction drafts stay cleared when follow-up refresh fails or a late toggle fires',async()=>{
  {
    const scope='confirmed-refresh-world';clearCampaignDrafts(scope);
    const {ctx}=drive(true,scope,undefined,9);const errors=[];
    ctx.refresh=async()=>{throw new Error('snapshot disconnected');};ctx.report=e=>errors.push(e.message);
    const form=worldMemoryCard(ctx).querySelector('.world-correct');
    const reason=byLabel(form,'更正理由');reason.value='有依据的修订';reason.dispatchEvent({type:'input'});
    await click(byText(form,'保存更正（保留旧记录）'));
    assert.deepEqual(errors,['snapshot disconnected']);
    form.open=true;form.dispatchEvent({type:'toggle'});await settle();
    const draft=new WorldMemoryDraft(scope,record,9);
    assert.equal(draft.dirty,false,'a confirmed old instance must not write its cleared draft back');
    assert.ok(form.textContent.includes('更正已保存'));
    clearCampaignDrafts(scope);
  }
});

test('newer edits made during a correction request survive its acknowledgement and a failed refresh',async()=>{
  {
    const scope='newer-during-world';clearCampaignDrafts(scope);
    const {ctx}=drive(true,scope,undefined,9);let release;
    ctx.submit=()=>new Promise(r=>{release=r;});ctx.refresh=async()=>{throw new Error('offline');};ctx.report=()=>{};
    const form=worldMemoryCard(ctx).querySelector('.world-correct');
    const reason=byLabel(form,'更正理由');reason.value='第一次说明';reason.dispatchEvent({type:'input'});
    byText(form,'保存更正（保留旧记录）').dispatchEvent({type:'click'});
    reason.value='请求发出后又写的说明';reason.dispatchEvent({type:'input'});release();await settle();
    const draft=new WorldMemoryDraft(scope,record,10);
    assert.equal(draft.dirty,true);assert.equal(draft.values.reason,'请求发出后又写的说明');
    clearCampaignDrafts(scope);
  }
});

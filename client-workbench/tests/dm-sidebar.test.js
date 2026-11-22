import test from 'node:test';
import assert from 'node:assert/strict';
import {installDom,settle} from './dom-shim.mjs';
import {createApi,requestPath} from '../src/api.js';
installDom();
const {createDmSidebar}=await import('../src/dm-sidebar.js');
const snapshot=(version=1,id='campaign-1',timelineId='branch-1',isHost=true)=>({id,version,timelineId,party:{isHost,selfActorId:'player'}});
const overview=(s,secret='本场秘密')=>({campaignId:s.id,timelineId:s.timelineId,version:s.version,
  party:[{id:'p1',character:{name:'云雀',className:'Wizard',level:1,hitPoints:6,maxHitPoints:8,temporaryHitPoints:3,armorClass:12,
    conditions:['Poisoned'],resources:[{name:'Spell Slots (1st)',current:1,maximum:2}],concentration:{spellId:'blade-ward'}}}],
  scene:{id:'harbor',title:'雾港码头',summary:'夜雾中的栈桥',npcs:[],records:[{id:'note',kind:'clue',name:'主持备注',summary:secret,visibility:'host'}]},
  encounter:{version:s.version,encounter:null,roster:[]},board:null});
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
function reader(read,s=snapshot(),options={}){
  const owner=document.createElement('div'),ctx={snapshot:s,read};let visible;
  const storage=new Map();const panel=createDmSidebar(owner,ctx,{storage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v)},
    dialogs:{open(){throw Error('Unexpected dialog');}},onVisibility:v=>visible=v,...options});
  owner.append(panel.element,panel.toggle);return {panel,owner,ctx,storage,visible:()=>visible};
}

test('DM overview is an authenticated read; rejects another campaign or mismatched board version',async()=>{
  const s=snapshot(),view=overview(s),session={campaignId:s.id,accessToken:'token'};let sent;
  const api=createApi({fetchImpl:async(url,options)=>{sent={url,options};return new Response(JSON.stringify(view));}});
  assert.equal(requestPath('dm-overview',session),'/api/v1/campaigns/campaign-1/dm/overview');
  await api.request('dm-overview',session);assert.equal(sent.options.method,'GET');assert.equal(sent.options.headers.Authorization,'Bearer token');assert.equal(sent.options.body,undefined);
  for(const invalid of [{...view,campaignId:'other'},{...view,scene:null},{...view,encounter:{version:2}},{...view,board:{version:2,map:{id:'m'},tokens:[]}}]){
    const broken=createApi({fetchImpl:async()=>new Response(JSON.stringify(invalid))});await assert.rejects(broken.request('dm-overview',session));
  }
});

test('shows resources and private notes; character card reuses the existing reader, a task takes its place and collapse is remembered',async()=>{
  let opened,expanded=0;const r=reader(async()=>overview(snapshot()),snapshot(),{openCharacter:id=>opened=id,onExpand:()=>expanded++});await r.panel.load();
  assert.match(r.panel.element.textContent,/本场秘密/);assert.match(r.panel.element.textContent,/1 环法术位 1\/2/);
  assert.match(r.panel.element.textContent,/临时生命 \+3/);assert.match(r.panel.element.textContent,/专注/);
  assert.match(r.panel.element.textContent,/没有可用地图/);
  r.panel.element.querySelector('[data-dm-member]').onclick();assert.equal(opened,'p1');
  assert.equal(r.panel.toggle.hidden,true,'the reopen entry only appears while collapsed');
  r.panel.setBlocked(true);assert.equal(r.panel.element.hidden,true);assert.equal(r.visible(),true,'a task replaces the overview without collapsing it');
  r.panel.setBlocked(false);assert.equal(r.panel.element.hidden,false);
  r.panel.element.querySelectorAll('button').find(b=>b.textContent==='收起').dispatchEvent(new Event('click'));
  assert.equal(r.panel.element.hidden,true);assert.equal(r.visible(),false);assert.equal([...r.storage.values()][0],'true');assert.equal(r.panel.toggle.hidden,false);
  r.panel.setBlocked(true);r.panel.setBlocked(false);assert.equal(r.panel.element.hidden,true);
  r.panel.toggle.dispatchEvent(new Event('click'));assert.equal(r.panel.element.hidden,false);assert.equal(expanded,1);assert.equal([...r.storage.values()][0],'false');
});

test('older response cannot paint after version, timeline, or campaign changes; dispose and lost host access clear secrets',async()=>{
  const waiting=[];const r=reader(()=>{const d=deferred();waiting.push(d);return d.promise;});
  const first=r.panel.load();r.ctx.snapshot=snapshot(2);const second=r.panel.update();
  waiting[1].resolve(overview(r.ctx.snapshot,'新版本秘密'));await second;
  waiting[0].resolve(overview(snapshot(),'旧秘密'));await first;
  assert.match(r.panel.element.textContent,/新版本秘密/);assert.doesNotMatch(r.panel.element.textContent,/旧秘密/);
  const third=r.panel.update();r.ctx.snapshot=snapshot(2,'campaign-2','branch-2');const fourth=r.panel.update();
  waiting[3].resolve(overview(r.ctx.snapshot,'另一战役'));await fourth;waiting[2].resolve(overview(snapshot(2),'旧战役'));await third;
  assert.match(r.panel.element.textContent,/另一战役/);assert.doesNotMatch(r.panel.element.textContent,/旧战役/);
  const fifth=r.panel.update();r.ctx.snapshot=snapshot(2,'campaign-2','branch-2',false);await r.panel.update();
  waiting[4].resolve(overview(snapshot(2,'campaign-2','branch-2'),'迟到秘密'));await fifth;
  assert.equal(r.panel.element.hidden,true);assert.equal(r.panel.toggle.hidden,true);assert.doesNotMatch(r.owner.textContent,/秘密|另一战役/);
  r.ctx.snapshot=snapshot(3);const sixth=r.panel.update();r.owner.dispatchEvent(new Event('dispose'));waiting[5].resolve(overview(r.ctx.snapshot,'销毁后秘密'));await sixth;
  assert.doesNotMatch(r.owner.textContent,/销毁后秘密/);
});

test('ordinary seat makes no overview call; errors require explicit retry, ahead-of-snapshot data waits for dashboard',async()=>{
  let calls=0;const guest=reader(async()=>{calls++;},snapshot(1,'campaign-1','branch-1',false));await guest.panel.load();assert.equal(calls,0);
  let reply=()=>Promise.reject(Error('离线'));const r=reader(()=>{calls++;return reply();});
  await r.panel.load();assert.match(r.panel.element.textContent,/离线/);await r.panel.update();assert.equal(calls,1);
  reply=async()=>overview(snapshot(2));await r.panel.load(true);assert.doesNotMatch(r.owner.textContent,/本场秘密/);
  r.ctx.snapshot=snapshot(2);await r.panel.update();assert.match(r.panel.element.textContent,/本场秘密/);
});

test('restoring the same campaign version on another timeline rejects the old in-flight secrets',async()=>{
  const waiting=[];const r=reader(()=>{const d=deferred();waiting.push(d);return d.promise;});
  const oldRead=r.panel.load();
  r.ctx.snapshot=snapshot(1,'campaign-1','restored-branch');
  const restoredRead=r.panel.update();
  waiting[1].resolve(overview(r.ctx.snapshot,'读档后的场景'));await restoredRead;
  waiting[0].resolve(overview(snapshot(),'原时间线秘密'));await oldRead;
  assert.match(r.panel.element.textContent,/读档后的场景/);
  assert.doesNotMatch(r.panel.element.textContent,/原时间线秘密/);
});

test('overview map is read-only with hidden markers; the full DM map keeps names and no draggable tokens',async()=>{
  const s=snapshot(),view=overview(s);view.board={version:1,map:{id:'m',version:1,contentHash:'a',title:'码头图',width:768,height:512},
    tokens:[{id:'hidden',name:'暗处伏兵',visibility:'gm',onMap:true,x:.4,y:.3}]};
  let writes=0;const mapBody=document.createElement('div');
  const r=reader(async endpoint=>{if(endpoint==='dm-overview')return view;if(endpoint==='map-image')return new Blob(['png']);writes++;},s,
    {dialogs:{open:({render})=>render({body:mapBody,isDisposed:()=>false,close:()=>{}})}});
  await r.panel.load();await settle();
  assert.equal(r.panel.mapButton.hidden,false);assert.equal(r.panel.element.contains(r.panel.mapButton),true);
  const mini=r.panel.element.querySelector('.mini');
  assert.equal(mini.querySelectorAll('img').length,1);assert.equal(mini.querySelectorAll('.dm-token-hidden').length,1,'unknown-to-players markers are hollow');
  r.panel.mapButton.dispatchEvent(new Event('click'));
  assert.match(mapBody.textContent,/暗处伏兵/);assert.match(mapBody.textContent,/未公开/);
  assert.equal(mapBody.querySelectorAll('.dm-token-hidden').length,1);assert.equal(writes,0);
  assert.equal(r.owner.querySelectorAll('[draggable="true"]').length,0);
  r.owner.dispatchEvent(new Event('dispose'));
  assert.equal(r.panel.element.querySelectorAll('img').length,0,'disposed overview removes private markers and images');
});

test('changed values highlight only on live updates; initial read and reconnected snapshot stay static',async()=>{
  let hp=6;const r=reader(async()=>{const value=overview(r.ctx.snapshot);value.party[0].character.hitPoints=hp;return value;});
  await r.panel.load();assert.equal(r.panel.element.querySelectorAll('.presentation-change').length,0);
  hp=4;r.ctx.snapshot=snapshot(2);await r.panel.update();
  assert.match(r.panel.element.querySelector('.presentation-change').textContent,/生命 4 \/ 8/);
  hp=2;r.ctx.snapshot=snapshot(3);await r.panel.update({live:false});assert.equal(r.panel.element.querySelectorAll('.presentation-change').length,0);
  r.owner.dispatchEvent(new Event('dispose'));
});

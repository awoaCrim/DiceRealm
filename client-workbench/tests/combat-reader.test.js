import test from 'node:test';
import assert from 'node:assert/strict';
import {installDom,settle} from './dom-shim.mjs';
installDom();
const {createCombatReader,orderedCombatUnits,combatGrid}=await import('../src/combat-reader.js');
const {createDialogHost}=await import('../src/workspace-dialog.js');
const unit=(id,name,extra={})=>({id,name,team:id==='p'?'party':'enemy',x:id==='p'?0:2,y:1,hitPoints:9,maxHitPoints:12,armorClass:14,
  initiative:14,initiativeRoll:12,initiativeModifier:2,speed:30,movementRemaining:20,actionAvailable:true,bonusActionAvailable:false,reactionAvailable:true,...extra});
const fight=()=>({id:'battle-1',title:'桥边交锋',status:'active',width:4,height:3,cellFeet:5,round:2,activeActorId:'p',turnOrder:['e','p'],
  cells:[{x:1,y:1,terrain:'blocked'}],units:[unit('p','旅人',{initiative:99}),unit('e','守卫',{boardEntityId:'board-e'})],
  log:[{sequence:1,round:1,kind:'initiative',actorId:'p',text:'先攻已记录',presentation:{combatId:'battle-1',text:'双方进入交锋',activeActorId:'p',units:[]}}]});
const snapshot=()=>({id:'campaign',timelineId:'branch-1',version:3,elapsedSeconds:60,combat:fight(),party:{isHost:true,selfActorId:'dm',members:[{id:'p',character:{id:'c',name:'旅人',resources:[{name:'Second Wind',current:1,maximum:2}]}}]}});
const view=s=>({campaignId:s.id,timelineId:s.timelineId,version:s.version,combat:s.combat,waits:[]});
const wait={id:'roll',actorId:'p',actorName:'旅人',kind:'roll',label:'先攻',description:'本人确认后投掷',state:'pending',reason:''};
const click=(root,label)=>{const button=root.querySelectorAll('button').find(b=>b.textContent===label);assert.ok(button,label);button.dispatchEvent({type:'click'});};
function setup(read){
  document.body.replaceChildren();const owner=document.createElement('div');document.body.append(owner);
  const ctx={snapshot:snapshot(),submit:()=>assert.fail('combat reader must not write'),read:read||(async(key)=>{assert.equal(key,'combat-overview');return view(ctx.snapshot);})};
  const reader=createCombatReader(owner,ctx,{dialogs:createDialogHost(owner)});owner.append(reader.element);
  return {owner,ctx,reader,close:()=>owner.dispatchEvent(new Event('dispose'))};
}

test('authoritative order and real grid coordinates are used without sorting or moving',()=>{
  const combat=fight();assert.deepEqual(orderedCombatUnits(combat).map(u=>u.id),['e','p']);
  const selected=[];const grid=combatGrid(combat,{selected:'e',select:id=>selected.push(id)});
  assert.equal(grid.querySelectorAll('td').length,12);assert.equal(grid.querySelectorAll('[data-terrain="blocked"]').length,1);
  const player=grid.querySelector('[data-combat-focus="grid:p"]');assert.match(player.getAttribute('aria-label'),/2 · 旅人 · 格位 \(0, 1\)/);
  player.dispatchEvent({type:'click'});assert.deepEqual(selected,['p']);assert.equal(combat.units[0].x,0);
});

test('pre-combat consent is visible to a characterless DM and empty/guest views stay empty',async()=>{
  const state=setup(async()=>({...view(state.ctx.snapshot),waits:[wait,{...wait,id:'second',actorId:'q',actorName:'同伴',state:'confirmed',reason:'等其他队员'}]}));
  try{
    state.ctx.snapshot.combat=null;await state.reader.load();assert.equal(state.reader.element.hidden,false);assert.match(state.reader.element.textContent,/开战等待/);
    state.reader.open();const dialog=document.body.querySelector('dialog');assert.match(dialog.textContent,/旅人.*先攻/);assert.match(dialog.textContent,/已确认，等待同伴/);assert.equal(dialog.querySelectorAll('.combat-grid').length,0);
    state.ctx.read=async()=>view(state.ctx.snapshot);state.ctx.snapshot.version++;state.reader.update();await settle();assert.equal(state.reader.element.hidden,true);assert.equal(document.body.querySelector('dialog'),null);
    state.ctx.snapshot.party.isHost=false;state.ctx.snapshot.combat=fight();state.ctx.read=()=>assert.fail('guest may not fetch host overview');state.reader.update();await state.reader.load();state.reader.open();assert.equal(state.reader.element.hidden,true);
  }finally{state.close();}
});

test('unit selection, scroll, tab and focus survive updates; stale detail never replaces current data',async()=>{
  const reads=[];const state=setup(async(key,p)=>{if(key==='combat-overview')return view(state.ctx.snapshot);assert.equal(key,'board-token');return new Promise(resolve=>reads.push({p,resolve}));});
  try{
    await state.reader.load();state.reader.open();let dialog=document.body.querySelector('dialog');
    dialog.querySelector('[data-combat-focus="unit:e"]').dispatchEvent({type:'click'});assert.equal(reads.length,1);
    const detail=dialog.querySelector('[data-combat-scroll="unit-detail"]');detail.scrollTop=120;detail.focus();
    state.ctx.snapshot.version++;state.ctx.snapshot.combat.units[1].hitPoints=5;state.reader.update();await settle();assert.equal(reads.length,2);
    reads[0].resolve({id:'board-e',version:3,name:'STALE_DETAIL',summary:'STALE_DETAIL',statistics:{resources:[{name:'STALE_RESOURCE',current:9,maximum:9}]}});await settle();assert.doesNotMatch(dialog.textContent,/STALE_DETAIL|STALE_RESOURCE/);
    reads[1].resolve({id:'board-e',version:4,name:'守卫',summary:'当前持久单位',statistics:{resources:[{name:'Fresh pool',current:1,maximum:3}],concentration:{spellId:'bless',expiresAtSeconds:120}}});await settle();
    dialog=document.body.querySelector('dialog');assert.match(dialog.textContent,/当前持久单位/);assert.match(dialog.textContent,/Fresh pool/);
    assert.equal(dialog.querySelector('[data-combat-focus="unit:e"]').getAttribute('aria-pressed'),'true');
    assert.equal(dialog.querySelector('[data-combat-scroll="unit-detail"]').scrollTop,120);assert.equal(document.activeElement.dataset.combatFocus,'unit-detail');
    click(dialog,'战报');dialog.querySelector('[data-combat-scroll="log-detail"]').scrollTop=80;
    state.ctx.snapshot.version++;state.reader.update();await settle();assert.equal(dialog.querySelector('.combat-battle-panel').hidden,true);assert.equal(dialog.querySelector('.combat-log-panel').hidden,false);assert.equal(dialog.querySelector('[data-combat-scroll="log-detail"]').scrollTop,80);
    state.ctx.snapshot.timelineId='loaded-branch';state.ctx.snapshot.version=2;state.ctx.snapshot.combat=null;state.reader.update();await settle();assert.equal(document.body.querySelector('dialog'),null);assert.equal(state.reader.element.hidden,true);
  }finally{state.close();}
});

test('read failures stop until explicit retry, and closed windows discard late details',async()=>{
  let fail=true,pending;const state=setup(async(key)=>{if(key==='combat-overview'){if(fail)throw Error('断线');return view(state.ctx.snapshot);}return new Promise(resolve=>{pending=resolve;});});
  try{
    await state.reader.load();assert.match(state.reader.element.textContent,/读取失败.*断线/);fail=false;
    state.ctx.snapshot.version++;state.reader.update();await settle();assert.match(state.reader.element.textContent,/断线/);
    await state.reader.load(true);assert.doesNotMatch(state.reader.element.textContent,/断线/);state.reader.open();let dialog=document.body.querySelector('dialog');
    dialog.querySelector('[data-combat-focus="unit:e"]').dispatchEvent({type:'click'});assert.ok(pending);dialog.close();
    pending({id:'board-e',version:4,name:'late',summary:'LATE_CLOSED_DETAIL',statistics:null});await settle();assert.equal(document.body.querySelector('dialog'),null);
    state.reader.open();dialog=document.body.querySelector('dialog');assert.doesNotMatch(dialog.textContent,/LATE_CLOSED_DETAIL/);
  }finally{state.close();}
});

test('new combat resets unit/log identities and ended combat does not claim a current actor',async()=>{
  const state=setup();try{
    await state.reader.load();state.reader.open();const dialog=document.body.querySelector('dialog');click(dialog,'战报');
    state.ctx.snapshot.version++;state.ctx.snapshot.combat={...fight(),id:'battle-2',status:'victory',units:[unit('new','新对手')],turnOrder:['new'],activeActorId:'new',log:[{sequence:1,round:1,kind:'victory',text:'新一场已结束',actorId:'new'}]};state.reader.update();await settle();
    assert.match(dialog.textContent,/新一场已结束/);assert.doesNotMatch(dialog.querySelector('.combat-window-heading').textContent,/当前/);assert.equal(dialog.querySelectorAll('[data-current="true"]').length,0);
    assert.equal(dialog.querySelector('[data-combat-focus="unit:new"]').getAttribute('aria-pressed'),'true');
  }finally{state.close();}
});

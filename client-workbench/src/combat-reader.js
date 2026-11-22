import {h,kv} from './dom.js';
import {ruleName,buildName,abilityName,featureText,sizeName} from './rule-labels.js';
import {combatEntryCard,combatEntryText} from './combat-log.js';

const number=value=>Number.isFinite(value)?String(value):'未记录';
const signed=value=>Number.isFinite(value)?(value>=0?'+':'−')+Math.abs(value):'未记录';
const available=value=>typeof value==='boolean'?(value?'可用':'已用'):'未记录';
const yesNo=value=>typeof value==='boolean'?(value?'是':'否'):'未记录';
const statusNames={active:'战斗中',victory:'战斗胜利',defeated:'战斗失败',retreated:'已撤退'};
const teamNames={party:'队伍',player:'队伍',ally:'友方',enemy:'敌方',neutral:'中立'};
const waitStates={pending:'待本人回应',confirmed:'已确认，等待同伴',stale:'等待已过期',blocked:'当前无法推进'};
const waitNames={death:'死亡豁免',concentration:'专注豁免',shield:'护盾术回应',opportunity:'借机攻击回应'};
const terrainNames={blocked:'障碍',difficult:'困难地形',normal:'平地',open:'平地'};
const timeline=snapshot=>snapshot.timelineId||'';
const contextKey=snapshot=>JSON.stringify([snapshot.id,timeline(snapshot)]);
const combatKey=snapshot=>snapshot.combat?.id||'';
const resourceName=name=>{
  const slots=/^Spell Slots \((\d+)(?:st|nd|rd|th)\)$/.exec(name||'');
  const hitDice=/^Hit Dice \((d\d+)\)$/.exec(name||'');
  return slots?slots[1]+' 环法术位':hitDice?'生命骰（'+hitDice[1]+'）':featureText(name);
};

// TurnOrder is already authoritative. The final append only keeps units not yet
// listed there visible; no initiative sorting or client-side tie breaking occurs.
export function orderedCombatUnits(combat){
  const units=combat?.units||[],byId=new Map(units.map(unit=>[unit.id,unit]));
  const result=[],seen=new Set();
  for(const id of combat?.turnOrder||[]){const unit=byId.get(id);if(unit&&!seen.has(id)){seen.add(id);result.push(unit);}}
  for(const unit of units)if(!seen.has(unit.id)){seen.add(unit.id);result.push(unit);}
  return result;
}

export function combatUnitConditions(unit,character=null,statistics=null){
  return [...new Set([...(unit.standard?.conditions||[]),...(unit.boardBody?.conditions||[]),
    ...(character?.conditions||[]),...(statistics?.conditions||[])])].map(ruleName);
}

function partyCharacter(snapshot,unit){
  return snapshot.party?.members?.find(member=>member.id===unit.id&&!member.revoked)?.character||
    (snapshot.party?.selfActorId===unit.id?snapshot.character:null);
}
function temporaryHp(unit,statistics,character){
  return unit.standard?.temporaryHitPoints??unit.boardBody?.temporaryHitPoints??statistics?.temporaryHitPoints??character?.temporaryHitPoints;
}
function unitState(unit){
  const labels=[];
  if(unit.standard?.dead)labels.push('已死亡');
  else if(unit.standard?.stable)labels.push('已稳定');
  if(unit.standard?.zeroHitPointUnconscious)labels.push('零生命昏迷');
  if(unit.withdrawn)labels.push('已离场');
  if(unit.dodging)labels.push('闪避中');
  if(unit.disengaging)labels.push('撤离中');
  if(unit.recoveryRestRequired)labels.push('需要恢复休整');
  return labels;
}
function budgetText(unit){
  return '移动 '+number(unit.movementRemaining)+' 尺 · 动作 '+available(unit.actionAvailable)+
    ' · 附赠 '+available(unit.bonusActionAvailable)+' · 反应 '+available(unit.reactionAvailable);
}
function nameFor(combat,snapshot,id){
  return combat?.units?.find(unit=>unit.id===id)?.name||snapshot.party?.members?.find(member=>member.id===id)?.character?.name||id||'未记录';
}
function standardWaitText(combat,snapshot){
  const wait=combat?.standard?.wait;
  if(!wait||combat.status!=='active')return '';
  return [wait.actorId?nameFor(combat,snapshot,wait.actorId):'',wait.description||waitNames[wait.kind]||'等待战斗回应'].filter(Boolean).join(' · ');
}
function initiativeText(unit){
  return number(unit.initiative)+(Number.isFinite(unit.initiativeRoll)?'（d20 '+unit.initiativeRoll+' '+signed(unit.initiativeModifier)+'）':'');
}

/** A real local grid, with numbered keyboard buttons shared with the initiative list. */
export function combatGrid(combat,{selected='',select=()=>{}}={}){
  if(!Number.isInteger(combat?.width)||combat.width<1||!Number.isInteger(combat.height)||combat.height<1)
    return h('p.muted',{},'这场战斗没有已记录的格位。');
  const units=orderedCombatUnits(combat),numbers=new Map(units.map((unit,index)=>[unit.id,index+1]));
  const cells=new Map((combat.cells||[]).map(cell=>[cell.x+','+cell.y,cell]));
  const positions=new Map();
  for(const unit of units){
    if(unit.withdrawn)continue;
    const key=unit.x+','+unit.y;
    if(!positions.has(key))positions.set(key,[]);
    positions.get(key).push(unit);
  }
  const rows=[];
  for(let y=0;y<combat.height;y++){
    const row=h('tr',{},h('th',{scope:'row'},String(y)));
    for(let x=0;x<combat.width;x++){
      const terrain=cells.get(x+','+y)?.terrain||'';
      const occupants=positions.get(x+','+y)||[];
      row.append(h('td',{'data-terrain':terrain,'aria-label':`格位 (${x}, ${y})`+(terrain?' · '+(terrainNames[terrain]||terrain):'')},
        ...occupants.map(unit=>h('button.combat-grid-token',{
          type:'button','data-team':unit.team,'data-current':String(combat.status==='active'&&combat.activeActorId===unit.id),
          'data-combat-focus':'grid:'+unit.id,'aria-pressed':String(selected===unit.id),
          title:numbers.get(unit.id)+' · '+unit.name,
          'aria-label':numbers.get(unit.id)+' · '+unit.name+` · 格位 (${x}, ${y})`,onclick:()=>select(unit.id)
        },String(numbers.get(unit.id)))),
        !occupants.length&&terrain&&terrain!=='normal'&&terrain!=='open'?h('span.combat-terrain',{},terrainNames[terrain]||terrain):null));
    }
    rows.push(row);
  }
  return h('section.combat-grid-section',{},h('h3',{},'战术格位'),
    h('p.combat-grid-caption',{},[Number.isFinite(combat.cellFeet)?'每格 '+combat.cellFeet+' 尺':'',
      combat.width+' × '+combat.height+' 格','编号对应先攻列表'].filter(Boolean).join(' · ')),
    h('div.combat-grid-scroll',{'data-combat-scroll':'grid','data-combat-focus':'grid-scroll',tabindex:0,'aria-label':'战术格位图'},
      h('table.combat-grid',{},
        h('thead',{},h('tr',{},h('th',{'aria-label':'坐标'}),
          ...Array.from({length:combat.width},(_,x)=>h('th',{scope:'col'},String(x))))),
        h('tbody',{},...rows))));
}

function unitList(combat,snapshot,selected,select){
  const units=orderedCombatUnits(combat);
  return h('section.combat-roster',{},h('h3',{},'先攻顺序'),
    h('ol.combat-unit-list',{'data-combat-scroll':'units'},...units.map((unit,index)=>{
      const current=combat.status==='active'&&unit.id===combat.activeActorId;
      const character=partyCharacter(snapshot,unit),conditions=combatUnitConditions(unit,character),state=unitState(unit);
      const temp=temporaryHp(unit,null,character);
      return h('li',{},h('button.combat-unit',{
        type:'button','aria-pressed':String(unit.id===selected),'data-combat-focus':'unit:'+unit.id,
        'data-current':String(current),onclick:()=>select(unit.id)
      },h('span.combat-unit-heading',{},h('span.combat-unit-number',{},String(index+1)),
        h('strong',{},unit.name||'未命名单位'),h('span.combat-team',{},teamNames[unit.team]||unit.team),
        current?h('span.combat-current',{},'当前行动者'):null),
        h('span.combat-unit-values',{},'先攻 '+number(unit.initiative)+' · HP '+number(unit.hitPoints)+' / '+number(unit.maxHitPoints)+
          (Number.isFinite(temp)?' · 临时 HP '+temp:'')+' · AC '+number(unit.armorClass)),
        state.length||conditions.length?h('span.combat-unit-states',{},[...state,...conditions].join(' · ')):null,
        h('span.combat-unit-budget',{},budgetText(unit))));
    })),!units.length?h('p.muted',{},'尚未建立参战单位。'):null);
}
function section(title,...children){return h('section.combat-detail-section',{},h('h4',{},title),...children);}
function detailsUnit(combat,snapshot,unit,index,detail,detailStatus,retry){
  const character=detail?.character||partyCharacter(snapshot,unit),stats=detail?.statistics;
  const standard=unit.standard,temp=temporaryHp(unit,stats,character);
  const conditions=combatUnitConditions(unit,character,stats),states=unitState(unit);
  const basics=[['阵营',teamNames[unit.team]||unit.team],['格位',unit.withdrawn?'已离场':`(${number(unit.x)}, ${number(unit.y)})`],
    ['先攻',initiativeText(unit)],['生命 HP',number(unit.hitPoints)+' / '+number(unit.maxHitPoints)],['护甲 AC',number(unit.armorClass)],
    ['速度',number(unit.speed)+' 尺'],['剩余移动',number(unit.movementRemaining)+' 尺'],
    ['动作',available(unit.actionAvailable)],['附赠动作',available(unit.bonusActionAvailable)],['反应',available(unit.reactionAvailable)]];
  if(Number.isFinite(temp))basics.splice(4,0,['临时生命',String(temp)]);
  if(states.length)basics.push(['战斗状态',states.join('、')]);
  basics.push(['异常状态',conditions.length?conditions.join('、'):'无已记录异常']);
  if(unit.surgeAction)basics.push(['额外动作','来自动作如潮']);
  if(unit.savageAttackerUsed)basics.push(['凶蛮打手','本回合已用']);
  if(unit.droppedWeaponId)basics.push(['掉落武器',buildName('equipment',unit.droppedWeaponId)]);
  const content=[h('h3',{},index+' · '+(unit.name||'未命名单位')),kv(basics)];
  if(detailStatus)content.push(h('div.combat-detail-status',{},h('p',{role:'status'},detailStatus),
    retry?h('button.btn.btn-ghost',{type:'button','data-combat-focus':'retry-detail',onclick:retry},'重试读取单位资料'):null));
  if(detail?.summary)content.push(h('p.combat-prose',{},detail.summary));
  if(standard){
    content.push(section('死亡豁免与本回合记录',kv([
      ['死亡豁免',number(standard.deathSuccesses)+' 次成功 / '+number(standard.deathFailures)+' 次失败'],
      ['已稳定',yesNo(standard.stable)],['已死亡',yesNo(standard.dead)],
      ['零生命昏迷',yesNo(standard.zeroHitPointUnconscious)],['剩余攻击',number(standard.attacksRemaining)],
      ['本回合疾走次数',number(standard.dashesThisTurn)],['已用动作如潮',yesNo(standard.actionSurgeUsed)],
      ['护盾术生效',yesNo(standard.shieldActive)],['反应受抑制',yesNo(standard.reactionsSuppressed)],
      ...(Number.isFinite(combat.standard?.turnSerial)&&Number.isFinite(standard.slotSpentTurn)
        ?[['本行动轮已耗法术位',yesNo(standard.slotSpentTurn>0&&standard.slotSpentTurn===combat.standard.turnSerial)]]:[])
    ])));
    if(standard.masteryEffects?.length)content.push(section('武器精通效果',...standard.masteryEffects.map(effect=>h('p',{},
      ruleName(effect.kind)+(effect.sourceId?' · 来源 '+nameFor(combat,snapshot,effect.sourceId):'')+
      (Number.isFinite(effect.turnEndsRemaining)?' · 剩余 '+effect.turnEndsRemaining+' 次回合结束':'')))));
    if(standard.droppedItems?.length)content.push(section('掉落物',...standard.droppedItems.map(item=>h('p',{},
      buildName('equipment',item.id)+` · 格位 (${number(item.x)}, ${number(item.y)})`))));
  }
  const supplementary=stats||character;
  if(supplementary){
    const concentration=stats?.concentration??character?.concentration;
    content.push(section('专注',concentration?h('div',{},
      h('p',{},buildName('spell',concentration.spellId)),
      Number.isFinite(concentration.expiresAtSeconds)&&Number.isFinite(snapshot.elapsedSeconds)
        ?h('p.small.muted',{},'剩余 '+Math.max(0,concentration.expiresAtSeconds-snapshot.elapsedSeconds)+' 秒'):null)
      :h('p.muted',{},'无已记录专注。')));
    const resources=stats?.resources??character?.resources;
    content.push(section('资源',resources?.length?kv(resources.map(resource=>[resourceName(resource.name),number(resource.current)+' / '+number(resource.maximum)]))
      :h('p.muted',{},resources?'未记录资源池。':'未提供资源资料。')));
    const effects=stats?.effects??character?.effects;
    if(effects?.length)content.push(section('持续效果',...effects.map(effect=>h('p.combat-prose',{},
      ruleName(effect.name||effect.id)+(effect.description?' · '+effect.description:'')+
      (Number.isFinite(effect.expiresAtSeconds)&&Number.isFinite(snapshot.elapsedSeconds)?' · 剩余 '+Math.max(0,effect.expiresAtSeconds-snapshot.elapsedSeconds)+' 秒':'')))));
    if(character?.exhaustion>0)content.push(section('力竭',h('p',{},character.exhaustion+' 级')));
    const casting=stats?.spellcasting??character?.spellcasting;
    if(casting){
      content.push(h('details.combat-extra',{'data-combat-fold':'spells'},h('summary',{'data-combat-focus':'fold-spells'},'已记录法术'),
        kv([...(casting.ability&&casting.ability!=='multiple'?[['施法属性',abilityName(casting.ability)],['法术攻击',signed(casting.attackBonus)],['豁免 DC',number(casting.saveDc)]]:[])]),
        ...(casting.spells||[]).map(spell=>h('p',{},buildName('spell',spell.id,spell.name||spell.id)+
          (Number.isFinite(spell.level)?' · '+(spell.level===0?'戏法':spell.level+' 环'):'')+
          (typeof spell.prepared==='boolean'?' · '+(spell.prepared?'已准备':'未准备'):'')))));
    }
    const traits=[['体型',stats?.size?sizeName(stats.size):''],['生物类型',stats?.creatureType],['挑战等级',stats?.challengeRating],
      ['抗性',stats?.resistances?.map(ruleName).join('、')],['免疫',stats?.immunities?.map(ruleName).join('、')],
      ['易伤',stats?.vulnerabilities?.map(ruleName).join('、')],['感官',stats?.senses?.map(ruleName).join('、')]]
      .filter(pair=>pair[1]);
    if(traits.length||stats?.features?.length||stats?.actions?.length)content.push(h('details.combat-extra',{'data-combat-fold':'traits'},
      h('summary',{'data-combat-focus':'fold-traits'},'单位特征与行动资料'),kv(traits),
      ...(stats?.features||[]).map(text=>h('p.combat-prose',{},featureText(text))),
      ...(stats?.actions||[]).map(text=>h('p.combat-prose',{},text))));
  }else if(!unit.boardEntityId)content.push(h('p.muted',{},'该单位没有额外的角色或棋盘资料。'));
  return content;
}

function waitsBlock(combat,waits,snapshot,loading,error){
  const standard=standardWaitText(combat,snapshot);
  if(!standard&&!waits.length&&!loading&&!error)return null;
  return h('section.combat-waits',{'aria-label':'正在等待的战斗事项','data-combat-scroll':'waits','data-combat-focus':'waits',tabindex:0},
    standard?h('p',{},standard):null,
    ...waits.map(wait=>h('div.combat-wait',{'data-state':wait.state},
      h('strong',{},wait.actorName||'未命名角色'),h('span',{},wait.label|| (wait.kind==='roll'?'等待投掷':'等待行动确认')),
      h('span.combat-wait-state',{},waitStates[wait.state]),
      wait.description?h('p',{},wait.description):null,wait.reason?h('p',{},wait.reason):null)),
    loading?h('p.small.muted',{role:'status'},loading):null,
    error?h('p.error-box',{role:'alert'},error):null);
}

// Rebuilding changed facts must not steal the tab, selected row, scroll or focus.
function preserveReading(root,draw){
  const offsets=new Map([...root.querySelectorAll('[data-combat-scroll]')].map(node=>[node.dataset.combatScroll,[node.scrollTop,node.scrollLeft]]));
  const folds=new Map([...root.querySelectorAll('[data-combat-fold]')].map(node=>[node.dataset.combatFold,node.open]));
  const active=document.activeElement,key=root.contains(active)?active?.dataset?.combatFocus:null;
  draw();
  for(const node of root.querySelectorAll('[data-combat-scroll]')){
    const offset=offsets.get(node.dataset.combatScroll);if(offset){node.scrollTop=offset[0];node.scrollLeft=offset[1];}
  }
  for(const node of root.querySelectorAll('[data-combat-fold]'))if(folds.has(node.dataset.combatFold))node.open=folds.get(node.dataset.combatFold);
  if(key)[...root.querySelectorAll('[data-combat-focus]')].find(node=>node.dataset.combatFocus===key)?.focus({preventScroll:true});
}

/** Page-owned, host-only, read-only controller. update() is driven by watchDashboard. */
export function createCombatReader(owner,ctx,{dialogs}={}){
  let disposed=false,overview=null,error='',busy=false,request=0,pending=false,awaitingSnapshot=false;
  let identity=contextKey(ctx.snapshot),battle=combatKey(ctx.snapshot),version=ctx.snapshot.version;
  let windowState=null;
  const title=h('strong.combat-strip-title'),summary=h('span.combat-strip-summary'),notice=h('span.combat-strip-status',{role:'status'});
  const openButton=h('button.btn.btn-ghost',{type:'button','data-combat-open':true,onclick:()=>open()},'查看战况');
  const retryButton=h('button.btn.btn-ghost',{type:'button',hidden:true,'data-combat-retry':true,onclick:()=>load(true)},'重试读取战况');
  const element=h('section.combat-strip',{hidden:true,'aria-label':'战斗概况'},
    h('div.combat-strip-copy',{},title,summary,notice),h('div.combat-strip-actions',{},openButton,retryButton));
  const host=()=>!disposed&&!!ctx.snapshot.party?.isHost;
  const currentOverview=()=>overview&&overview.campaignId===ctx.snapshot.id&&overview.version===ctx.snapshot.version
    &&overview.timelineId===timeline(ctx.snapshot)?overview:null;
  const combat=()=>currentOverview()?.combat??ctx.snapshot.combat;
  const syncText=()=>busy?'正在同步等待事项…':awaitingSnapshot?'战况已变化，等待剧情同步…':'';
  function closeWindow(){if(windowState&&!windowState.isDisposed())windowState.close();windowState=null;}
  owner.addEventListener('dispose',()=>{disposed=true;++request;closeWindow();},{once:true});
  function drawStrip(){
    if(!host()){element.hidden=true;closeWindow();return;}
    const data=currentOverview(),fight=combat(),waits=data?.waits||[];
    element.hidden=!fight&&!waits.length&&!error;
    openButton.hidden=!fight&&!waits.length;
    retryButton.hidden=!error;retryButton.disabled=busy;
    title.textContent=fight?.title|| (waits.length?'开战等待':'战况读取失败');
    const actor=fight?.status==='active'?nameFor(fight,ctx.snapshot,fight.activeActorId):'';
    const firstWait=waits[0];
    const waiting=firstWait?[firstWait.actorName,waitStates[firstWait.state],firstWait.label].filter(Boolean).join(' · ')
      +(waits.length>1?'（共 '+waits.length+' 项）':''):standardWaitText(fight,ctx.snapshot);
    summary.textContent=fight?[
      statusNames[fight.status]||fight.status,'第 '+number(fight.round)+' 回合',
      actor&&fight.activeActorId?'当前：'+actor:'',waiting
    ].filter(Boolean).join(' · '):waiting;
    notice.textContent=error||((fight||waits.length)?syncText():'');
    if(data&&!fight&&!waits.length&&!error)closeWindow();
  }
  function resetWindow(){
    if(!windowState)return;
    windowState.selectedUnit='';windowState.selectedLog=null;windowState.detail=null;windowState.detailError='';
    windowState.detailLoading=false;windowState.detailKey='';windowState.detailRequest++;
    windowState.signature='';windowState.initialSelection=true;
  }
  async function load(retry=false){
    if(!host())return;
    if(busy){pending=true;return;}
    if(error&&!retry)return;
    busy=true;error='';pending=false;awaitingSnapshot=false;
    const own=++request,snapshot=ctx.snapshot,key=contextKey(snapshot),expected=snapshot.version,expectedCombat=combatKey(snapshot);
    drawStrip();drawWindow();
    try{
      const value=await ctx.read('combat-overview');
      if(!host()||own!==request||key!==contextKey(ctx.snapshot))return;
      if(ctx.snapshot.version!==expected||combatKey(ctx.snapshot)!==expectedCombat){pending=true;return;}
      if(value.campaignId!==snapshot.id)throw new Error('战况概览不属于当前战役。');
      // The read may reach the server after the snapshot's version. Do not
      // fight normal game progress with a retry loop or turn it into an error;
      // the existing snapshot connection will drive the next read.
      if(value.timelineId!==timeline(snapshot)||value.version>expected){awaitingSnapshot=true;return;}
      if(value.version!==expected||(value.combat?.id||'')!==expectedCombat)
        throw new Error('战况响应与当前进度不匹配，请重新读取。');
      overview=value;
    }catch(cause){
      if(host()&&own===request&&key===contextKey(ctx.snapshot)&&ctx.snapshot.version===expected){
        error=cause.status===404?'服务端尚未支持战况概览，请更新服务后重试。':'战况读取失败：'+cause.message;
      }
    }finally{
      if(own===request){
        busy=false;
        if(host()){drawStrip();drawWindow();if(pending&&!error)void load();}
      }
    }
  }
  function update(){
    if(!host()){++request;busy=false;overview=null;error='';awaitingSnapshot=false;drawStrip();return;}
    const snapshot=ctx.snapshot,key=contextKey(snapshot),nextBattle=combatKey(snapshot);
    if(key!==identity){
      ++request;busy=false;overview=null;error='';awaitingSnapshot=false;identity=key;version=-1;closeWindow();
    }
    if(nextBattle!==battle){battle=nextBattle;overview=null;resetWindow();}
    const changed=version!==snapshot.version;
    version=snapshot.version;
    if(changed)awaitingSnapshot=false;
    if(windowState?.detailKey&&!windowState.detailKey.endsWith(':'+version)){
      windowState.detail=null;windowState.detailError='';windowState.detailKey='';windowState.detailRequest++;windowState.detailLoading=false;
    }
    drawStrip();drawWindow();
    if(changed&&!error)void load();
  }
  function selectUnit(id){
    const state=windowState;if(!state||state.isDisposed()||!combat()?.units.some(unit=>unit.id===id))return;
    state.selectedUnit=id;state.initialSelection=false;state.detail=null;state.detailError='';state.detailLoading=false;state.detailKey='';state.detailRequest++;
    drawWindow();
    const reader=state.body.querySelector('[data-combat-scroll="unit-detail"]');if(reader)reader.scrollTop=0;
  }
  async function readUnit(retry=false){
    const state=windowState,fight=combat();
    if(!host()||!state||state.isDisposed())return;
    const unit=fight?.units.find(unit=>unit.id===state.selectedUnit);
    if(!unit?.boardEntityId)return;
    const snapshot=ctx.snapshot,scope=contextKey(snapshot),fightId=fight.id,entityId=unit.boardEntityId,unitId=unit.id;
    const key=JSON.stringify([scope,fightId,unitId,entityId])+':'+snapshot.version;
    if(state.detailKey===key&&!retry)return;
    state.detailKey=key;state.detailLoading=true;state.detail=null;state.detailError='';
    const own=++state.detailRequest,expected=snapshot.version;
    drawWindow();
    const current=()=>host()&&windowState===state&&!state.isDisposed()&&state.detailRequest===own&&state.detailKey===key&&
      contextKey(ctx.snapshot)===scope&&ctx.snapshot.version===expected&&combat()?.id===fightId&&state.selectedUnit===unitId;
    try{
      const value=await ctx.read('board-token',{entityId});
      if(!current())return;
      if(value.id!==entityId)throw new Error('单位资料与所选单位不匹配。');
      if(value.version>expected)return; // Wait for the normal snapshot update, then read this selection again.
      if(value.version!==expected)throw new Error('单位资料早于当前进度，请重新读取。');
      state.detail=value;
    }catch(cause){if(current())state.detailError='单位补充资料读取失败：'+cause.message;}
    finally{if(current()){state.detailLoading=false;drawWindow();}}
  }
  function drawWindow(){
    const state=windowState;if(!host()||!state||state.isDisposed())return;
    const snapshot=ctx.snapshot,fight=combat(),data=currentOverview(),waits=data?.waits||[];
    const units=orderedCombatUnits(fight),logs=fight?.log||[];
    if(state.initialSelection){
      state.selectedUnit=units.find(unit=>unit.id===fight?.activeActorId)?.id||units[0]?.id||'';
      state.selectedLog=logs.at(-1)?.sequence??null;state.initialSelection=false;
    }
    const signature=JSON.stringify([fight,waits,busy,error,awaitingSnapshot,state.selectedUnit,state.selectedLog,state.detail,state.detailLoading,state.detailError,
      snapshot.version,snapshot.elapsedSeconds]);
    if(signature===state.signature)return;
    state.signature=signature;
    preserveReading(state.body,()=>{
      state.heading.textContent=fight?[fight.title||'战斗',statusNames[fight.status]||fight.status,'第 '+number(fight.round)+' 回合',
        fight.status==='active'&&fight.activeActorId?'当前：'+nameFor(fight,snapshot,fight.activeActorId):''].filter(Boolean).join(' · '):'开战等待';
      state.waits.replaceChildren(...[waitsBlock(fight,waits,snapshot,syncText(),error)].filter(Boolean));
      state.retry.hidden=!error;state.retry.disabled=busy;
      if(!fight){
        state.battle.replaceChildren(h('p.muted',{},waits.length?'先攻与单位格位会在战斗建立后显示。':'当前没有战斗或开战等待。'));
        state.logList.replaceChildren();state.logDetail.replaceChildren(h('p.muted',{},'当前没有近期战报。'));state.logNote.textContent='近期战报';return;
      }
      const unit=units.find(unit=>unit.id===state.selectedUnit);
      state.battle.replaceChildren(
        h('div.combat-position',{'data-combat-scroll':'position'},unitList(fight,snapshot,state.selectedUnit,selectUnit),
          combatGrid(fight,{selected:state.selectedUnit,select:selectUnit})),
        h('section.combat-unit-detail',{'data-combat-scroll':'unit-detail','data-combat-focus':'unit-detail',tabindex:0,'aria-label':'所选单位资料'},
          ...(unit?detailsUnit(fight,snapshot,unit,units.indexOf(unit)+1,state.detail,
            state.detailError||(state.detailLoading?'正在读取单位补充资料…':state.detailKey&&!state.detail?'单位资料已变化，等待剧情同步…':''),
            state.detailError?()=>readUnit(true):null)
            :[h('p.muted',{},'所选单位已不在当前战斗中。')])));
      state.logNote.textContent='近期战报 · '+logs.length+' 条'+(logs.length?' · #'+logs[0].sequence+'—#'+logs.at(-1).sequence:'')+'；更早记录请在剧情页加载。';
      state.logList.replaceChildren(...logs.map(log=>h('button.combat-log-choice',{
        type:'button','data-combat-focus':'log:'+log.sequence,'aria-pressed':String(log.sequence===state.selectedLog),
        onclick:()=>{state.selectedLog=log.sequence;drawWindow();state.logDetail.scrollTop=0;}
      },h('span.combat-log-index',{},'#'+number(log.sequence)+' · 第 '+number(log.round)+' 回合'),
        h('span',{},log.presentation?.text||combatEntryText(log,{host:true})||'已保存的战斗记录'))));
      const chosen=logs.find(log=>log.sequence===state.selectedLog);
      state.logDetail.replaceChildren(chosen?combatEntryCard(chosen,{host:true,nameFor:id=>nameFor(fight,snapshot,id)}):
        h('p.muted',{},logs.length?'所选记录已不在近期战报中，请在剧情页读取更早记录或选择其他记录。':'尚无已保存的战斗动作。'));
    });
    if(state.mode==='battle')void readUnit();
  }
  function open(){
    if(!host())return;
    if(!combat()&&!currentOverview()?.waits.length)return;
    dialogs.open({title:'战况与战报',wide:true,
      returnFocus:()=>element.hidden?owner.querySelector('.story-head button'):openButton,render:dialog=>{
      const heading=h('p.combat-window-heading'),waits=h('div'),battlePanel=h('div.combat-battle-panel');
      const logList=h('div.combat-log-list',{'data-combat-scroll':'logs','aria-label':'选择近期战报'});
      const logDetail=h('div.combat-log-reading',{'data-combat-scroll':'log-detail','data-combat-focus':'log-detail',tabindex:0,'aria-label':'所选战报详情'}),logNote=h('p.small.muted');
      const logPanel=h('div.combat-log-panel',{hidden:true},logNote,h('div.combat-log-layout',{},logList,logDetail));
      const retry=h('button.btn.btn-ghost',{type:'button',hidden:true,'data-combat-focus':'retry-overview',onclick:()=>load(true)},'重试读取战况');
      const battleTab=h('button.btn',{type:'button','aria-pressed':'true',onclick:()=>show('battle')},'战况');
      const logTab=h('button.btn',{type:'button','aria-pressed':'false',onclick:()=>show('log')},'战报');
      dialog.body.classList.add('combat-reader');
      dialog.body.append(h('div.combat-window-bar',{},h('div.combat-tabs',{'aria-label':'战斗信息分类'},battleTab,logTab),retry),heading,waits,battlePanel,logPanel);
      const state={...dialog,heading,waits,battle:battlePanel,logList,logDetail,logNote,retry,mode:'battle',selectedUnit:'',selectedLog:null,
        detail:null,detailKey:'',detailError:'',detailLoading:false,detailRequest:0,signature:'',initialSelection:true};
      windowState=state;
      dialog.body.addEventListener('dispose',()=>{state.detailRequest++;if(windowState===state)windowState=null;},{once:true});
      function show(mode){
        if(state.isDisposed())return;
        state.mode=mode;battlePanel.hidden=mode!=='battle';logPanel.hidden=mode!=='log';
        battleTab.setAttribute('aria-pressed',String(mode==='battle'));logTab.setAttribute('aria-pressed',String(mode==='log'));
        if(mode==='battle')void readUnit();
      }
      drawWindow();
    }});
  }
  drawStrip();
  return {element,update,load,open};
}

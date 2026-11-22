// Combat on the player page (visual-v3 §3, §5): the turn budget and action buttons above the input.
// The server owns every rule. Buttons, cells and targets come only from the snapshot's action list
// (availableActions is the whitelist; actionOptions adds prices and the reasons a choice is closed),
// and a choice is sent as its kind/target, never as client-computed movement or damage.
import {h} from '../dom.js';
import {actionLabel} from '../rule-labels.js';
import {detailLines,playerText} from './wording.js';

// Unity sent these without a review step; everything else shows its price first. A death save and
// the final missile cast only open the server's own consent card, which states the cost.
const DIRECT=new Set(['combat.move','combat.attack','combat.dodge','combat.dash','combat.disengage','combat.end_turn',
  'combat.death_save','combat.missile_cast']);
const NAMES={'combat.attack':'攻击','combat.cast':'施法','combat.dodge':'闪避','combat.dash':'疾走','combat.disengage':'撤离',
  'combat.second_wind':'回气','combat.action_surge':'动作如潮','combat.react':'反应','combat.stand':'起身','combat.search':'搜寻',
  'combat.pick_up':'拾取','combat.retreat':'撤退','combat.stabilize':'稳定伤者','combat.death_save':'死亡豁免',
  'combat.concentration_save':'专注豁免','combat.concentration_end':'结束专注','combat.area_save':'区域豁免',
  'combat.missile_allocate':'分配飞弹','combat.missile_cast':'施放飞弹','combat.recover_stable':'恢复','combat.quick_dash':'疾走',
  'combat.end_turn':'结束回合'};

const WAITS={shield:'护盾术反应',opportunity:'借机攻击',death:'死亡豁免',concentration:'专注豁免','area-save':'区域豁免',
  'missile-allocation':'分配魔法飞弹'};

// The wait the battle holds for this seat (a reaction, save or missile allocation), often in someone
// else's turn, with the choices that answer it. `key` names it so the card opens by itself only once.
export function respondModel(s){
  const combat=s?.combat,wait=combat?.status==='active'?combat.standard?.wait:null;
  if(!wait||wait.actorId!==(s.party?.selfActorId??'player'))return null;
  const options=combatView(s).groups.filter(g=>g.kind!=='combat.end_turn').flatMap(g=>g.options);
  return {key:[combat.id,combat.standard.turnSerial,wait.kind,wait.targetId].join(':'),title:WAITS[wait.kind]||'需要你回应',
    why:playerText(wait.description),options};
}

// The snapshot's choices that `keep` selects. One is open only if whitelisted and the server gave no
// reason against it; a closed one keeps that reason.
export function offeredChoices(s,keep){
  const allowed=new Set((s?.availableActions||[]).map(a=>a.kind+'\n'+a.target));
  const listed=s?.actionOptions?.length?s.actionOptions:s?.availableActions||[];
  return listed.filter(a=>a?.kind&&keep(a)).map(a=>{
    const reason=a.details?.unavailableReason||'';
    const available=allowed.has(a.kind+'\n'+a.target)&&!reason;
    return {kind:a.kind,target:a.target||'',label:actionLabel(a.label)||NAMES[a.kind]||a.kind,details:a.details||null,area:a.area||null,available,
      reason:available?'':reason||'当前不可用'};
  });
}

export function combatView(s){
  const combat=s?.combat;
  if(combat?.status!=='active')return null;
  const self=s.party?.selfActorId??'player';
  const options=offeredChoices(s,a=>a.kind.startsWith('combat.')&&a.kind!=='combat.start');
  const moves=new Map(options.filter(o=>o.kind==='combat.move').map(o=>[o.target,o]));
  const attacks=new Map();
  for(const o of options.filter(o=>o.kind==='combat.attack'))attacks.set(o.target,[...(attacks.get(o.target)||[]),o]);
  const groups=[];
  for(const o of options){
    if(o.kind==='combat.move')continue;
    let group=groups.find(g=>g.kind===o.kind);
    if(!group)groups.push(group={kind:o.kind,options:[]});
    group.options.push(o);
  }
  for(const group of groups){
    const open=group.options.filter(o=>o.available);
    group.name=NAMES[group.kind]||(group.options.length===1?group.options[0].label:group.kind);
    group.available=open.length>0;
    group.reason=group.available?'':group.options[0].reason;
    // One open choice of a plain kind goes straight to the server; the rest open the review card.
    group.direct=DIRECT.has(group.kind)&&group.kind!=='combat.attack'&&open.length===1&&group.options.length===1;
  }
  const order=kind=>kind==='combat.attack'?0:kind==='combat.end_turn'?2:1;
  groups.sort((a,b)=>order(a.kind)-order(b.kind));
  const unit=(combat.units||[]).find(u=>u.id===self)||null;
  return {combat,self,unit,mine:combat.activeActorId===self,moves,attacks,groups,layout:combat.boardLayout||null};
}

// An area spell that can land on many cells (Acid Splash) is listed once and its centre is picked on
// the map; the picked centre then opens its own card with the server's note. The server builds such a
// label as "<spell> / <targetLabel>（<source>）", so dropping the target part names the spell.
export function reviewEntries(options){
  const key=o=>o.area&&o.details?.targetLabel?o.label.replace(' / '+o.details.targetLabel,''):'';
  const count=new Map();
  for(const o of options){const k=key(o);if(k)count.set(k,(count.get(k)||0)+1);}
  const entries=[];
  for(const o of options){
    const k=key(o);
    if(!k||count.get(k)<2){entries.push(o);continue;}
    let entry=entries.find(e=>e.pick&&e.label===k);
    if(!entry)entries.push(entry={kind:o.kind,target:'',label:k,pick:true,options:[]});
    entry.options.push(o);
  }
  for(const e of entries.filter(e=>e.pick)){
    const open=e.options.filter(o=>o.available).length;
    e.available=open>0;e.reason=open?'':e.options[0].reason;
    e.details={targetLabel:'在地图上选择中心（'+open+' 处可选）',cost:e.options[0].details?.cost||''};
  }
  return entries;
}

// The review card's lines for one choice, in the player's words (wording.js), and why it is closed.
export const optionLines=o=>[...detailLines(o.label,o.details),...(o.available||!o.reason?[]:[o.reason])];
// A card's lines once each: what every server choice shares (a common note) goes under the title, not
// under each choice. The page's own helper (click targets on the map) has no say in it; an area spell
// grouped for a pick on the map is a real choice and does. A line repeating the card's own
// explanation is dropped.
export function cardLines(options,why=''){
  const lines=options.map(optionLines),server=lines.filter((list,i)=>!options[i].pick||options[i].options);
  const shared=server.length>1?server[0].filter(text=>text!==why&&server.every(list=>list.includes(text))):[];
  return {shared,each:lines.map(list=>list.filter(text=>text!==why&&!shared.includes(text)))};
}

export function createCombatBar({onGroup}){
  const budget=h('div.pl-budget');
  const buttons=h('div.pl-acts');
  const element=h('div.pl-combat',{hidden:true,'aria-label':'战斗行动'},budget,buttons);
  let key='';
  function chip(label,open,text=''){
    return h('span.pl-chip'+(open?'':'.is-spent'),{title:label+(open?'可用':'已用')},h('b',{},label),text?h('span',{},text):null);
  }
  function update(view,{busy=false,targeting=false,picking=false}={}){
    const unit=view?.unit,show=!!view&&(view.mine||view.groups.length>0);
    element.hidden=!show;
    if(!show){key='';return;}
    const next=JSON.stringify([unit&&[unit.movementRemaining,unit.speed,unit.actionAvailable,unit.bonusActionAvailable,unit.reactionAvailable],
      view.groups.map(g=>[g.kind,g.name,g.available,g.reason,g.options.length]),busy,targeting,picking,view.mine]);
    if(next===key)return;
    key=next;
    budget.replaceChildren(...(unit?[
      h('span.pl-budget-who',{},view.mine?'本回合':'回合外'),
      chip('移动',unit.movementRemaining>0,unit.movementRemaining+'/'+unit.speed+' 尺'),
      chip('动作',unit.actionAvailable),chip('附赠',unit.bonusActionAvailable),chip('反应',unit.reactionAvailable)]:[]));
    buttons.replaceChildren(...view.groups.map(group=>{
      const attack=group.kind==='combat.attack',cast=group.kind==='combat.cast';
      // aria-disabled, not disabled: a closed choice still shows the server's reason on hover.
      return h('button.pl-act'+(group.kind==='combat.end_turn'?'.is-end':''),{type:'button','aria-disabled':busy||!group.available?'true':null,
        'aria-pressed':attack?String(targeting):cast?String(picking):null,
        title:group.available?(attack?'选择目标（Esc 取消）':reviewEntries(group.options).map(o=>o.label).join('、')):group.reason,
        onclick:()=>{if(!busy&&group.available)onGroup(group);}},group.name+(group.options.length>1&&!attack?' ▾':''));
    }));
  }
  return {element,update};
}

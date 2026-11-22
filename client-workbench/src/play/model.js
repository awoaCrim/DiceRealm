// What the adventure stage shows for one snapshot: book, chapter, party, goal and the notice bar.
// Pure data so the rules are testable without a page; screen.js only draws the result.
import {ruleName,buildName,actionLabel} from '../rule-labels.js';
import {orderedCombatUnits,combatUnitConditions} from '../combat-reader.js';
import * as turn from './turn.js';

const digits=['零','一','二','三','四','五','六','七','八','九'];
export function numeral(n){
  if(n<10)return digits[n];
  if(n<20)return '十'+(n%10?digits[n%10]:'');
  if(n<100)return digits[Math.floor(n/10)]+'十'+(n%10?digits[n%10]:'');
  return String(n);
}
// Companions show a wound word, never their exact hit points.
export function health(hp,max){
  if(!Number.isFinite(hp))return '伤势未明';
  if(hp<=0)return '倒地';
  if(!(max>0))return '伤势未明';
  if(hp>=max)return '完好';
  return hp*4<=max?'濒危':hp*2<=max?'重伤':'轻伤';
}

export function bookModel(s){
  return {title:s.name||'未命名战役',sub:[s.chapter>0?'第'+numeral(s.chapter)+'章':'',s.archived?'已归档':''].filter(Boolean).join(' · ')};
}
export function chapterModel(s){
  const fight=s.combat?.status==='active';
  return {place:s.scene?.title||'',state:s.archived?'已归档':fight?'战斗':'探索',fight,situation:s.scene?.summary||''};
}
const slug=v=>String(v||'').trim().toLowerCase().replace(/\s+/g,'-');
// A rail entry's hover card (visual-v3 §5): who this is and how they stand. Same rule as the rail:
// exact hit points only for oneself (`life` is worked out by the caller), a wound word for the rest.
function characterCard(c,self,life,extra=[]){
  return {sub:[c.species?buildName('species',slug(c.species),c.species):'',
      [c.className?ruleName(c.className):'',c.level>0?c.level+' 级':''].filter(Boolean).join(' '),
      c.background?buildName('background',slug(c.background),c.background):''].filter(Boolean).join(' · '),
    rows:[['生命',life],Number.isFinite(c.armorClass)?['护甲等级',String(c.armorClass)]:null,...extra,
      c.concentration?['专注',buildName('spell',c.concentration.spellId)]:null].filter(Boolean),
    hint:self?'按 C 查看完整角色':''};
}
function member(id,c,self){
  const conditions=c.conditions||[],dead=conditions.includes('Dead'),wound=dead?'死亡':health(c.hitPoints,c.maxHitPoints);
  return {id,self,name:c.name||'',detail:[c.className?ruleName(c.className):'',c.level>0?c.level+' 级':''].filter(Boolean).join(' '),
    hp:c.hitPoints,maxHp:c.maxHitPoints,health:wound,
    tags:conditions.filter(t=>t!=='Dead').map(ruleName),card:characterCard(c,self,self?c.hitPoints+' / '+c.maxHitPoints:wound)};
}
// In a fight the same rail lists the initiative order (visual-v3 §3): own hit points and AC, a wound
// word for everyone else. The order is the server's; nothing is sorted here.
// A character down at 0 HP shows its death saves so far; three of either ends it.
function combatant(u,combat,self,ch){
  const st=u.standard||{},mine=u.id===self,wound=st.dead?'死亡':u.withdrawn?'已离场':health(u.hitPoints,u.maxHitPoints),focus=ch?.concentration;
  const initiative=Number.isFinite(u.initiative)?['先攻',String(u.initiative)]:null;
  const saving=st.zeroHitPointUnconscious&&!st.dead&&!st.stable;
  return {id:u.id,self:mine,current:u.id===combat.activeActorId,foe:u.team==='enemy',name:u.name||'',
    detail:['先攻 '+(Number.isFinite(u.initiative)?u.initiative:'—'),mine&&Number.isFinite(u.armorClass)?'AC '+u.armorClass:''].filter(Boolean).join(' · '),
    hp:u.hitPoints,maxHp:u.maxHitPoints,health:wound,
    tags:[...new Set([saving?'死亡豁免 成功'+(st.deathSuccesses||0)+' · 失败'+(st.deathFailures||0):'',...combatUnitConditions(u),
      st.stable?'已稳定':'',u.dodging?'闪避中':'',u.disengaging?'撤离中':'',focus?'专注 · '+buildName('spell',focus.spellId):''])].filter(t=>t&&t!==wound),
    // In a fight the battle unit holds the hit points; an enemy has no character to describe.
    card:ch?characterCard(ch,mine,mine?u.hitPoints+' / '+u.maxHitPoints:wound,[initiative].filter(Boolean))
      :{sub:u.team==='enemy'?'敌人':'',rows:[['伤势',wound],initiative].filter(Boolean),hint:''}};
}
export function partyModel(s){
  if(s.combat?.status==='active'){
    const self=s.party?.selfActorId??'player';
    // Concentration and identity live on the character, not the battle unit.
    const character=id=>id===self?s.character:(s.party?.members||[]).find(m=>m.id===id)?.character;
    return orderedCombatUnits(s.combat).map(u=>combatant(u,s.combat,self,character(u.id)));
  }
  const members=(s.party?.members||[]).filter(m=>m&&!m.revoked&&m.character);
  if(!members.length)return s.character?[member('self',s.character,true)]:[];
  return members.map(m=>member(m.id,m.character,m.id===s.party.selfActorId));
}
// The quest under way; when none is, the last one finished stays in view with its outcome.
export function goalModel(s){
  const quests=(s.world?.quests||[]).filter(q=>q?.title),quest=quests.find(q=>q.status==='active');
  // The hover card lists the quest's summary and objectives; clues are author keys, so only counted.
  const card=q=>({summary:String(q.summary||'').trim(),objectives:(q.objectives||[]).filter(o=>o?.text).map(o=>({text:o.text,done:!!o.complete}))});
  if(!quest){const done=quests.filter(q=>q.status==='completed').at(-1);return done?{title:done.title,sub:'已完成',...card(done)}:null;}
  const objectives=quest.objectives||[],clues=s.facts?.length||0;
  return {title:quest.title,sub:[objectives.length?'目标 '+objectives.filter(o=>o.complete).length+'/'+objectives.length:'',clues?'已知线索 '+clues:''].filter(Boolean).join(' · '),...card(quest)};
}

// One bar above the input: what needs the player now. Retry comes first (nothing else may be sent),
// then the player's own waits, then whose turn it is. `act` names what the bar's button does.
export function noticeModel(t,{pending=false,sending=false,recovery=false}={}){
  const s=t.snapshot,session=t.session;
  if(pending)return {tone:'idle',label:'尚未确认',text:'上一请求等待确认；原样重试不会重复执行',action:sending?'':'重试',act:'retry'};
  if(!turn.lifecycleAllowsActions(s)&&(s.pendingRoll||s.pendingIntent))
    return {tone:'roll',label:s.pendingRoll?'原投掷':'原意图',text:'不能继续行动，可以明确放弃',action:'查看',act:s.pendingRoll?'roll':'intent'};
  // A roll the server holds back (own consent given, the party not yet; or the context moved on) shows
  // why, and the card it opens offers only the reason and the way out.
  if(turn.canConfirmRoll(session,s))return s.pendingRoll.available===false
    ?{tone:'idle',label:'等待投掷',text:s.pendingRoll.reason||actionLabel(s.pendingRoll.label),action:'查看',act:'roll'}
    :{tone:'roll',label:'等待投掷',text:actionLabel(s.pendingRoll.label),action:'投掷',act:'roll'};
  if(s.pendingIntent&&turn.matchesConfirmation(session,s,'intent',s.pendingIntent.id))
    return {tone:'roll',label:'等待选择',text:s.pendingIntent.question||s.pendingIntent.text||'',action:'选择',act:'intent'};
  if(t.mode==='business'&&!session&&t.active.length>1)return {tone:'roll',label:'多条行动',text:'请选择要查看的一条',action:'选择',act:'sessions'};
  // The question itself stands whole under the story (screen.js); the bar says where to answer.
  if(session?.phase==='needsAnswer')return {tone:'turn',label:'需要回答',text:'在输入框写下你的回答，队友也会看到',action:'放弃这次行动',act:'stop',quiet:true};
  if(recovery)return {tone:'roll',label:'待继续',text:'上一步的结果已记录，可以继续这次行动',action:'继续',act:'continue'};
  if(session?.phase==='needsConfirmation'&&session.confirmation?.kind==='ruling')
    return {tone:'idle',label:'等待主持',text:session.confirmation.prompt||'主持正在裁定',action:'',act:''};
  if(s.pendingRoll)return {tone:'idle',label:'等待投掷',text:actionLabel(s.pendingRoll.label),action:'',act:''};
  if(s.pendingIntent)return {tone:'idle',label:'等待选择',text:s.pendingIntent.question||'',action:'',act:''};
  const combat=s.combat;
  if(combat?.status==='active'&&combat.activeActorId){
    const self=s.party?.selfActorId??'player';
    // A reaction, save or allocation the battle holds for this seat, often in someone else's turn.
    if(combat.standard?.wait?.actorId===self)return {tone:'roll',label:'需要你回应',text:combat.standard.wait.description||'',action:'回应',act:'respond'};
    if(combat.activeActorId===self)return {tone:'turn',label:'轮到你行动',text:'第 '+combat.round+' 轮',action:'',act:''};
    return {tone:'idle',label:'等待他人',text:((combat.units||[]).find(u=>u.id===combat.activeActorId)?.name||'其他角色')+' 正在行动',action:'',act:''};
  }
  return null;
}

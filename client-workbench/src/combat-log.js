import {h,kv} from './dom.js';
import {checkLabel,buildName,ruleName} from './rule-labels.js';

const number=value=>Number.isFinite(value)?String(value):'未记录';
const signed=value=>Number.isFinite(value)?(value>=0?'+':'−')+Math.abs(value):'未记录';
const dice=values=>Array.isArray(values)&&values.length?'['+values.join(', ')+']':'未记录骰点';
const modes={normal:'普通',advantage:'优势',disadvantage:'劣势'};
const checkKey=check=>check?JSON.stringify([check.ability,check.skill,check.testKind,check.mode,check.rolls,
  check.selected,check.modifier,check.total,check.hasDc,check.dc,check.difficultyClasses,check.success,check.bonusRolls,check.bonusSource]):'';

// One recorded check as reading parts. Only saved values; the verdict is the server's against one DC.
export function recordedCheckParts(check){
  const combatLabels={Initiative:'先攻','Death Saving Throw':'死亡豁免',Concentration:'专注豁免'};
  const label=combatLabels[check.skill]||(checkLabel(check)||'已记录')+(check.testKind==='save'?'豁免':'检定');
  const dc=check.skill==='Initiative'?'—':Array.isArray(check.difficultyClasses)&&check.difficultyClasses.length?check.difficultyClasses.join(' / '):check.hasDc===false||!Number.isFinite(check.dc)?'—':String(check.dc);
  const automatic=check.mode==='automatic-failure';
  // No verdict for initiative, opposed or multi-DC records.
  const single=check.skill!=='Initiative'&&check.hasDc!==false&&Number.isFinite(check.dc)&&!(Array.isArray(check.difficultyClasses)&&check.difficultyClasses.length);
  const verdict=automatic?'失败':single&&typeof check.success==='boolean'?(check.success?'成功':'失败'):'';
  const rolls=Array.isArray(check.rolls)?check.rolls:[];
  const die=rolls.length>1?'d20 '+rolls.join('/')+(Number.isFinite(check.selected)?' 取 '+check.selected:''):rolls.length?'d20 '+rolls[0]:'';
  const modifier=die&&Number.isFinite(check.modifier)&&check.modifier!==0?(check.modifier>0?' + ':' − ')+Math.abs(check.modifier):'';
  const bonus=die&&Array.isArray(check.bonusRolls)&&check.bonusRolls.length?' + '+check.bonusRolls.join(' + '):'';
  const math=automatic?'未掷骰':die?die+modifier+bonus+' = '+number(check.total):'总值 '+number(check.total);
  return {label,dc,verdict,math,automatic};
}
export function recordedCheckText(check){
  const {label,dc,verdict,automatic}=recordedCheckParts(check);
  return label+' · DC '+dc+' · '+(automatic?'未掷骰':'掷骰 '+number(check.total))+(verdict?' · '+verdict:'');
}
// "d20 4/18 取 18 −2": the saved dice behind the total, for a hover title rather than the line.
export function recordedCheckDice(check){
  if(check.mode==='automatic-failure'||!Array.isArray(check.rolls)||!check.rolls.length)return '';
  const die=check.rolls.length>1?'d20 '+check.rolls.join('/')+(Number.isFinite(check.selected)?' 取 '+check.selected:''):'d20 '+check.rolls[0];
  const bonus=Array.isArray(check.bonusRolls)&&check.bonusRolls.length?' +'+check.bonusRolls.join('+'):'';
  return die+(Number.isFinite(check.modifier)?' '+signed(check.modifier):'')+bonus;
}

// presentation.text is the saved concise recap. Guests consume only the authorized
// projection already delivered to them; they never fetch the host overview/detail.
export function combatEntryText(entry,{host=false}={}){
  return host?entry.text||entry.presentation?.text||'':entry.presentation?.text||entry.text||'';
}

/** Human-readable facts from saved dice only. Source-book/audit fields stay out of normal UI. */
export function combatRollFacts(entry,{includeCheck=true,nameFor=id=>id}={}){
  const facts=[],attack=entry.attack,spell=entry.spell;
  if(attack){
    const mode=modes[attack.mode]||attack.mode;
    facts.push(['攻击投掷',[
      mode,'d20 '+dice(attack.rolls),Number.isFinite(attack.selected)?'取 '+attack.selected:'',
      '修正 '+signed(attack.modifier),'总值 '+number(attack.total),'目标 AC '+number(attack.armorClass)
    ].filter(Boolean).join(' · ')]);
    facts.push(['攻击结果',attack.critical===true?'重击':attack.hit===true?'命中':attack.graze===true?'擦伤':attack.hit===false?'未命中':'未记录']);
    if(attack.damageRolls?.length)facts.push(['伤害骰',dice(attack.damageRolls)]);
    if(attack.alternateRolls?.length)facts.push(['备选伤害骰',dice(attack.alternateRolls)]);
    if(attack.effectiveDice?.length)facts.push(['采用伤害骰',dice(attack.effectiveDice)]);
    if(Number.isFinite(attack.damageModifier))facts.push(['伤害修正',signed(attack.damageModifier)]);
    if(Number.isFinite(attack.damage))facts.push(['造成伤害',String(attack.damage)]);
  }
  if(spell){
    facts.push(['法术',buildName('spell',spell.spellId)]);
    if(spell.targetId)facts.push(['目标',nameFor(spell.targetId)]);
    if(Number.isFinite(spell.slotLevel))facts.push(['施放环级',spell.slotLevel===0?'戏法':spell.slotLevel+' 环']);
    if(spell.damageRolls?.length)facts.push(['法术伤害骰',dice(spell.damageRolls)]);
    if(Number.isFinite(spell.damage))facts.push(['法术伤害',String(spell.damage)+(spell.damageType?' · '+ruleName(spell.damageType):'')]);
  }
  if(includeCheck&&entry.check){
    const check=entry.check;
    facts.push(['已存'+(check.testKind==='save'?'豁免':'检定'),recordedCheckText(check)]);
    if(check.mode!=='automatic-failure'){
      const selection=[modes[check.mode]||check.mode,Number.isFinite(check.selected)?'采用 '+check.selected:''].filter(Boolean).join(' · ');
      facts.push(['检定骰点','d20 '+dice(check.rolls)+' · 修正 '+signed(check.modifier)]);
      if(check.bonusRolls?.length)facts.push(['额外骰',dice(check.bonusRolls)]);
      if(selection)facts.push(['检定取值',selection]);
    }
  }
  return facts;
}

export function combatEntryCard(entry,{host=false,includeCheck=true,nameFor=id=>id,compact=false}={}){
  const facts=combatRollFacts(entry,{includeCheck,nameFor}),text=combatEntryText(entry,{host});
  return h('section'+(compact?'.msg.msg-combat':'.combat-log-detail'),{
    'data-combat-sequence':String(entry.sequence),'data-combat-id':entry.presentation?.combatId||'',
    'aria-label':'战报 · 第 '+number(entry.round)+' 回合 · 记录 '+number(entry.sequence)
  },h('div.combat-entry-head',{},h('strong',{},'战报'),h('span',{},'第 '+number(entry.round)+' 回合 · #'+number(entry.sequence))),
    text?h('p.combat-prose',{},text):h('p.muted',{},'这条记录未保存简报文字。'),
    facts.length?(compact?h('details.combat-roll-details',{},h('summary',{},'骰点明细'),kv(facts)):kv(facts)):null);
}

/**
 * Steps own their order. InitialResult is often a copy of the last mechanical
 * step, so it contributes only facts not present in those steps. Combat sequence
 * alone is not an identity: each new combat starts counting again.
 */
export function activityResultItems(entry){
  const steps=(entry.steps||[]).filter(step=>step.result);
  const sources=steps.length?steps.map(step=>({result:step.result,fallback:false})):
    entry.initialResult?[{result:entry.initialResult,fallback:false}]:[];
  if(steps.length&&entry.initialResult)sources.push({result:entry.initialResult,fallback:true});
  const items=[],combatSeen=new Set(),stepLogs=new Set(),stepChecks=new Set();
  for(const {result,fallback} of sources){
    const logs=result.combatLog||[],key=checkKey(result.check);
    // A save/check may be attached both to Resolution and to its CombatEntry.
    const inLog=key&&logs.some(log=>checkKey(log.check)===key);
    if(result.check&&!inLog&&(!fallback||!stepChecks.has(key)))items.push({type:'check',check:result.check});
    if(!fallback&&key)stepChecks.add(key);
    for(const log of logs){
      const combatId=log.presentation?.combatId;
      const identity=combatId?JSON.stringify([combatId,log.sequence]):'';
      const saved=JSON.stringify(log);
      if(identity&&combatSeen.has(identity)||fallback&&!identity&&stepLogs.has(saved))continue;
      if(identity)combatSeen.add(identity);
      if(!fallback)stepLogs.add(saved);
      const logCheck=checkKey(log.check);
      // A fallback can carry additional combat text, but must not repeat a
      // check already displayed in an earlier step of this same activity.
      const includeCheck=!fallback||!stepChecks.has(logCheck);
      items.push({type:'combat',entry:log,includeCheck});
      if(!fallback&&logCheck)stepChecks.add(logCheck);
    }
  }
  if(!items.some(item=>item.type==='check'||item.entry.check)&&entry.ruling?.check)
    items.push({type:'check',check:entry.ruling.check});
  return items;
}

// Only the exact system-generated copy is redundant. Authored narrative and the
// old combat.start instructional summary retain their own text.
export function duplicatesCombatNarrative(entry){
  if(entry.narrativeSource!=='system'||!entry.narrative)return false;
  const results=[entry.initialResult,...(entry.steps||[]).map(step=>step.result)].filter(Boolean);
  return results.some(result=>result.combatLog?.length&&entry.narrative===result.combatLog.map(log=>log.text).join('\n'));
}

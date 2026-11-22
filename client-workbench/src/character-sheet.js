import {h,kv} from './dom.js';
import {ruleName,buildName,abilityName,featureText,sizeName} from './rule-labels.js';
import {buildDetails} from './character-review.js';

const signed=value=>Number.isFinite(value)?(value>=0?'+':'−')+Math.abs(value):'—';
const number=value=>Number.isFinite(value)?String(value):'—';
const values=items=>(items||[]).filter(item=>item!=null);
const names=(items,name=ruleName)=>values(items).map(name).filter(Boolean).join('、');
const facts=pairs=>kv(pairs.filter(pair=>pair&&pair[1]!==''&&pair[1]!=null));
const prose=text=>h('p.sheet-prose',{},text||'暂无详细记录。');
export const resourceName=name=>{
  const die=/^Hit Dice \((d\d+)\)$/.exec(name||'');
  if(die)return '生命骰（'+die[1]+'）';
  const slots=/^Spell Slots \((\d+)(?:st|nd|rd|th)\)$/.exec(name||'');
  return slots?slots[1]+' 环法术位':featureText(name);
};
// Display-only rule Markdown, matching the Unity feature reader; never applied to personal prose.
const ruleText=text=>String(text||'').replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm,'').replace(/\*\*([^\r\n]+?)\*\*/g,'$1');
const detailNotice=text=>text==='规则说明仅供查阅；当前次数、加值和可执行选项以角色状态与服务端操作条件为准。'?'':text;
const recoveries={short:'短休或长休全部恢复','short-one':'短休一次，长休全部',long:'长休全部恢复',manual:'主持调整'};
const abilityKeys=['strength','dexterity','constitution','intelligence','wisdom','charisma'];
const shortKeys=['str','dex','con','int','wis','cha'];

// This reader only receives the server-authorized party Character. No self-only command
// catalog, account details, raw JSON or inferred private build is requested for a teammate.
// `operations` (the seat's own window only) adds tabs and a per-tab panel of commands: {tabs:[[id,label]], render:id=>node|null}.
export function characterSheet(character,{elapsedSeconds=0,review=null,section='overview',selection='',rules=null,rulesStatus='',retryRules=null,operations=null}={}){
  const ch=character||{},m=ch.buildMechanics,identity=ch.build?.identity;
  const entry=(label,render,extra={})=>({label,render,...extra});
  const basic=()=>facts([
    ['物种',ruleName(ch.species)],['背景',ruleName(ch.background)],['熟练加值',signed(ch.proficiencyBonus)],
    m?.speed?['速度',m.speed+' 尺']:null,m?.size?['体型',sizeName(m.size)]:null,
    m?.hitDie?['生命骰',`d${m.hitDie}`]:null,
    Number.isFinite(m?.currencyCp)?['钱币',`${Math.floor(m.currencyCp/100)} 金 ${Math.floor(m.currencyCp%100/10)} 银 ${m.currencyCp%10} 铜`]:null,
    Number.isFinite(m?.initiativeBonus)?['先攻',signed(m.initiativeBonus)]:null,
    Number.isFinite(m?.passivePerception)?['被动察觉',m.passivePerception]:null,
    review?['角色审核',({pending:'待审核',approved:'已批准',returned:'已退回'})[review.status]||review.status]:null,
    review?.reason?['审核说明',review.reason]:null
  ]);
  const overview=[entry('基本信息',basic),entry('技能与熟练',()=>h('div',{},
    m?.skills?.length?facts(m.skills.map(s=>[ruleName(s.name||s.id),signed(s.modifier)+(s.expertise?' · 专精':s.proficient?' · 熟练':'')])):
      facts([['技能',names(ch.skills)],['专精',names(ch.expertise)]]),
    facts(values(m?.savingThrows).map(s=>[abilityName(s.ability)+'豁免',signed(s.modifier)+(s.proficient?' · 熟练':'')])),
    facts([['护甲训练',names(m?.armorTraining)],['武器训练',names(m?.weaponTraining)],['工具',names(m?.tools,id=>buildName('equipment',id))],
      ['语言',names(m?.languages,id=>buildName('language',id))],['专长',names(m?.feats,id=>buildName('feat',id))],
      ['武器精通',names(m?.masteries,id=>buildName('equipment',id))],['抗性',names(m?.resistances)]]),
    !m?prose(values(ch.features).map(featureText).filter(f=>/^(语言|体型|豁免熟练)：/.test(f)).join('\n')):null))];
  if(ch.equipmentStatus)overview.push(entry('防御与装备',()=>h('div',{},
    facts([['护甲',ch.equipmentStatus.armor],['当前',ch.equipmentStatus.current],['备用',ch.equipmentStatus.reserve]]),
    ...values(ch.equipmentStatus.armorClassSources).map(prose),
    ...values(ch.equipmentStatus.issues).map(issue=>prose('待处理：'+issue)))));
  if(identity)overview.push(entry('角色设定',()=>facts([['称谓',identity.pronouns],['阵营',identity.alignment?buildName('alignment',identity.alignment):''],
    ['外貌',identity.appearance],['性格',identity.personality],['背景故事',identity.backstory]])));
  if(ch.advancement)overview.push(entry('职业与成长',()=>h('div',{},
    facts(values(ch.advancement.classes).map(c=>[ruleName(c.classId),`${c.level} 级`+(c.subclassId?' · '+ruleName(c.subclassId):'')])),
    ...values(ch.advancement.steps).map(s=>prose(`等级 ${s.characterLevel}：${ruleName(s.classId)} ${s.classLevel} 级 · 生命上限 +${s.hitPointIncrease}`)))));
  if(ch.build)overview.push(entry('建卡选择',()=>buildDetails(ch.build)));

  const states=values(ch.conditions).map(condition=>entry(ruleName(condition),()=>prose('当前状态：'+ruleName(condition)),{group:'状态'}));
  if(ch.exhaustion>0)states.push(entry('力竭 · '+ch.exhaustion+' 级',()=>prose('当前力竭：'+ch.exhaustion+' 级'),{group:'状态'}));
  if(ch.temporaryHitPoints>0)states.push(entry('临时生命 · '+ch.temporaryHitPoints,()=>prose('临时生命：'+ch.temporaryHitPoints),{group:'状态'}));
  if(ch.concentration)states.push(entry('专注 · '+buildName('spell',ch.concentration.spellId),()=>facts([
    ['法术',buildName('spell',ch.concentration.spellId)],['来源',featureText(ch.concentration.source)],
    ['剩余时间',Math.max(0,Math.ceil((ch.concentration.expiresAtSeconds-elapsedSeconds)/60))+' 分钟']
  ]),{group:'状态'}));
  for(const effect of values(ch.effects)){
    const remaining=Number.isFinite(effect.expiresAtSeconds)?Math.max(0,effect.expiresAtSeconds-elapsedSeconds):null;
    states.push(entry(ruleName(effect.name||effect.id),()=>facts([
      ['效果',ruleName(effect.name||effect.id)],remaining!=null?['剩余时间',remaining?Math.ceil(remaining/60)+' 分钟':'已到期']:null,
      effect.description?['说明',effect.description]:null
    ]),{group:'状态'}));
  }
  if(!states.length)states.push(entry('无异常状态',()=>prose('无异常状态。'),{group:'状态'}));
  for(const resource of values(ch.resources))states.push(entry(resourceName(resource.name),()=>facts([
    ['剩余',number(resource.current)+' / '+number(resource.maximum)],['恢复',recoveries[resource.recovery]||resource.recovery],['说明',resource.description]
  ]),{group:'资源',badge:number(resource.current)+' / '+number(resource.maximum)}));

  const references=new Map(values(rules?.featureDetails).map(detail=>[detail.index,detail]));
  const features=(ch.features||[]).map((raw,index)=>({raw,index,label:featureText(raw)})).filter(item=>item.raw!=null)
    .filter(item=>!/^(语言|体型|豁免熟练)：/.test(item.label)).map(item=>{
      const full=references.get(item.index),label=full?.name||item.label;
      return entry(label,()=>h('div',{},prose(full?.text?ruleText(full.text):'尚未匹配这项能力的完整规则说明。'),
        detailNotice(full?.notice)?prose(detailNotice(full.notice)):null),{group:full?.group||'其他能力',key:'feature:'+item.index});
    });
  const groupOrder=['物种能力','职业能力','专长','其他能力'];
  features.sort((a,b)=>groupOrder.indexOf(a.group)-groupOrder.indexOf(b.group));
  const inventory=values(ch.inventory).filter(item=>item.quantity>0).map(item=>entry(buildName('equipment',item.id,item.name),()=>facts([
    ['名称',buildName('equipment',item.id,item.name)],['数量',item.quantity],['状态',item.equipped?'已装备':'背包中'],['说明',item.description||item.details]
  ]),{badge:'×'+item.quantity+(item.equipped?' · 已装备':'')}));
  const spellMap=new Map(values(ch.spellcasting?.spells).map(spell=>[spell.id,spell]));
  for(const grant of values(m?.spellGrants))if(!spellMap.has(grant.id))spellMap.set(grant.id,{id:grant.id});
  const spells=[...spellMap.values()].sort((a,b)=>(a.level??99)-(b.level??99)).map(spell=>{
    const grants=values(m?.spellGrants).filter(g=>g.id===spell.id);
    const casting=ch.spellcasting;
    return entry(buildName('spell',spell.id,spell.name||spell.id),()=>h('div',{},facts([
      Number.isFinite(spell.level)?['环级',spell.level===0?'戏法':spell.level+' 环']:null,
      typeof spell.prepared==='boolean'?['准备状态',spell.prepared?'已准备':'未准备']:null,
      ['施法时间',spell.castingTime],['规则来源',spell.source],
      casting?.ability&&casting.ability!=='multiple'?['施法属性',abilityName(casting.ability)]:null,
      casting?.ability&&casting.ability!=='multiple'?['法术攻击',signed(casting.attackBonus)]:null,
      casting?.ability&&casting.ability!=='multiple'?['豁免 DC',number(casting.saveDc)]:null
    ]),spell.summary?prose(spell.summary):null,
    ...grants.map(g=>h('section.sheet-source',{},h('h4',{},'取得来源 · '+featureText(g.source)),facts([
      ['施法属性',abilityName(g.ability)],['攻击',signed(g.attackBonus)],['豁免 DC',number(g.saveDc)],
      ['用法',({'free-use':'免费施放',free:'免费施放',known:'已知',prepared:'始终准备',cantrip:'戏法','spellbook':'法术书'})[g.mode]||g.mode],
      g.freeUses>0?['来源免费次数',g.freeUses]:null
    ])))),{group:spell.level===0?'戏法':Number.isFinite(spell.level)?spell.level+' 环':'其他来源',badge:spell.prepared?'已准备':''});
  });

  const tabs=[['overview','人物',overview],['status','状态',states],['features','能力',features],['spells','法术',spells],['inventory','背包',inventory],
    ...(operations?.tabs||[]).map(([id,label])=>[id,label,[]])];
  let active='overview';
  const nav=h('div.tabs.sheet-tabs',{'aria-label':'角色资料分类'}),list=h('div.sheet-entry-list'),reader=h('section.sheet-reader',{'aria-live':'polite'});
  const body=h('div.sheet-body',{},list,reader),actions=h('div.sheet-operations',{hidden:true});
  const controls=new Map();
  function showTab(id){
    active=id;const rows=tabs.find(t=>t[0]===id)[2];
    for(const [key,button] of controls){button.classList.toggle('active',key===id);button.setAttribute('aria-pressed',String(key===id));}
    body.dataset.section=id;body.dataset.entry='';list.replaceChildren();reader.replaceChildren();
    reader.hidden=id==='inventory';
    const panel=operations?.render(id)||null;
    actions.replaceChildren(...(panel?[panel]:[]));actions.hidden=!panel;body.hidden=false;
    // A tab added by `operations` has no reader rows; it is only its panel.
    if(operations?.tabs?.some(tab=>tab[0]===id)){body.hidden=true;return;}
    if(!rows.length){list.append(h('p.muted',{},id==='spells'?'当前没有法术资料。':id==='inventory'?'背包里还没有物品。':'本分类暂无记录。'));reader.hidden=true;return;}
    let group='';
    for(const item of rows){
      if(item.group&&item.group!==group){group=item.group;list.append(h('h4.sheet-group',{},group));}
      const button=h('button.btn.sheet-entry',{type:'button','data-sheet-entry':item.key||item.label,onclick:()=>select(item,button)},
        h('span',{},item.label),item.badge?h('span.small.muted',{},item.badge):null);
      list.append(button);
    }
    function select(item,button){
      if(active!==id)return;
      for(const b of list.querySelectorAll('button')){b.classList.toggle('active',b===button);b.setAttribute('aria-pressed',String(b===button));}
      body.dataset.entry=item.key||item.label;
      reader.hidden=false;reader.replaceChildren(h('h3',{},item.label),item.render());reader.scrollTop=0;
    }
    // Inventory retains its full grid. A selected item is read below it, never squeezes it into two columns.
    const chosen=rows.find(item=>(item.key||item.label)===selection);
    if(chosen||id!=='inventory'){
      const item=chosen||rows[0];
      select(item,[...list.querySelectorAll('button')].find(button=>button.dataset.sheetEntry===(item.key||item.label)));
    }
    selection='';
  }
  for(const [id,label] of tabs){const button=h('button',{type:'button','data-sheet-tab':id,onclick:()=>showTab(id)},label);controls.set(id,button);nav.append(button);}
  const stat=(label,value)=>h('div.sheet-stat',{},h('span.small.muted',{},label),h('strong',{},value));
  const header=h('div.sheet-stat-band',{},stat('生命',number(ch.hitPoints)+' / '+number(ch.maxHitPoints)),stat('护甲',number(ch.armorClass)),
    ...abilityKeys.map((key,index)=>{
      const a=values(ch.abilities).find(a=>a.name===key||a.name===shortKeys[index]);
      return stat(abilityName(key)+(a?' '+a.score:''),a?signed(a.modifier??Math.floor((a.score-10)/2)):'—');
    }));
  const root=h('section.character-sheet',{},h('div.sheet-identity',{},h('h2',{},ch.name||'角色'),
    h('p.muted',{},[ruleName(ch.species),ruleName(ch.className)+(ch.level?' · '+ch.level+' 级':'')].filter(Boolean).join(' / '))),header,
    ch.temporaryHitPoints>0?h('p.small',{},'临时生命 +'+ch.temporaryHitPoints):null,
    rulesStatus||rules?.notice?h('div.sheet-rules-status',{},h('p.hint',{role:'status'},rulesStatus||rules.notice),
      retryRules?h('button.btn.btn-ghost',{type:'button',onclick:retryRules},'重新读取规则资料'):null):null,nav,
    // The open tab's page (its operations and entries): the part a fixed-size window scrolls.
    h('div.sheet-page',{},actions,body));
  showTab(tabs.some(tab=>tab[0]===section)?section:'overview');return root;
}

// Display-only Chinese labels for D&D rule identifiers. Requests and stored values keep
// the canonical IDs; skill names match the Unity rules translation.
import data from './rule-names-generated.js';
export const abilityLabels={strength:'力量',dexterity:'敏捷',constitution:'体质',intelligence:'智力',wisdom:'感知',charisma:'魅力'};
export const skillLabels={
  Acrobatics:'体操','Animal Handling':'驯兽',Arcana:'奥秘',Athletics:'运动',Deception:'欺瞒',History:'历史',
  Insight:'洞悉',Intimidation:'威吓',Investigation:'调查',Medicine:'医药',Nature:'自然',Perception:'察觉',
  Performance:'表演',Persuasion:'游说',Religion:'宗教','Sleight of Hand':'巧手',Stealth:'隐匿',Survival:'求生'
};
export const conditionLabels={
  Blinded:'目盲',Charmed:'魅惑',Deafened:'耳聋',Frightened:'恐慌',Grappled:'受擒',Incapacitated:'失能',Invisible:'隐形',
  Paralyzed:'麻痹',Petrified:'石化',Poisoned:'中毒',Prone:'倒地',Restrained:'束缚',Stunned:'震慑',Unconscious:'昏迷'
};
const lookup=(labels,value)=>Object.hasOwn(labels,value)?labels[value]:value;
export const abilityLabel=value=>lookup(abilityLabels,value);
export const skillLabel=value=>lookup(skillLabels,value);
export const conditionLabel=value=>lookup(conditionLabels,value);
/** A recorded check is named by its skill, else by its ability. */
export const checkLabel=check=>check.skill?skillLabel(check.skill):abilityLabel(check.ability);

// Generated names shared with Unity (scripts/build_character_reference.py).
const ABILITIES={str:'力量',dex:'敏捷',con:'体质',int:'智力',wis:'感知',cha:'魅力',...abilityLabels};
const ABILITY_ORDER=['str','dex','con','int','wis','cha'];
const SIZES={T:'微型',S:'小型',M:'中型',L:'大型',H:'巨型',G:'超巨型'};

export function ruleName(value){
  const text=String(value??'').trim();
  return data.names[text.toLowerCase()]??text;
}
export function buildName(kind,id,fallback=id){
  return data.build[kind+':'+id]??ruleName(fallback);
}
export const abilityName=id=>ABILITIES[id]??ruleName(id);
export const sizeName=id=>SIZES[id]??ruleName(id);
const list=(values,name)=>values.map(v=>name(v.trim())).filter(Boolean).join('、');

// Source ids inside server prose ("Acid Splash（class:wizard）") as names ("Acid Splash（法师）").
export const sourceText=text=>String(text??'').replace(/(?:class|species|background):[a-z0-9-]+(?:\/[a-z0-9:-]+)*/g,m=>m.split('/').map(sourcePart).join(' · '));
// Composite feature strings built by the server's BuildEvaluator.
export function featureText(text){
  const value=String(text??'');
  if(value.startsWith('Languages: '))return '语言：'+list(value.slice(11).split(','),id=>buildName('language',id));
  if(value.startsWith('Size: ')){
    const [size,speed]=value.slice(6).split('; speed: ');
    return '体型：'+sizeName(size)+(speed?' · 速度：'+speed.replace(' ft',' 尺'):'');
  }
  if(value.startsWith('Saving throw proficiencies: '))return '豁免熟练：'+list(value.slice(28).split(','),ruleName);
  const sourced=sourceText(value);
  // A bare feature uses its feature translation: "Versatile" is also a weapon property (多用).
  return sourced===value?(data.build['feature:'+value]??ruleName(value)):sourced;
}

const GROUPS={languages:'语言',language:'语言',size:'体型',skill:'技能熟练',skills:'技能熟练','origin-feat':'起源专长',feat:'专长',
  versatile:'额外起源专长','spell-ability':'施法属性',masteries:'武器精通',spell:'法术',spells:'法术',cantrip:'戏法',cantrips:'戏法',
  invocation:'魔能祈唤',expertise:'专精',lineage:'血统',subclass:'子职业'};
const VALUE_KIND={languages:'language',language:'language',skill:'skill',skills:'skill',expertise:'skill','origin-feat':'feat',feat:'feat',
  versatile:'feat',masteries:'equipment',spell:'spell',spells:'spell',cantrip:'spell',cantrips:'spell'};
const SOURCE_KIND={class:'class',species:'species',background:'background',feat:'feat'};

function sourcePart(part){
  const [kind,id]=part.split(':');
  if(id&&SOURCE_KIND[kind])return buildName(SOURCE_KIND[kind],id);
  return id?ruleName(id):buildName('class',part);
}
function selectionValue(group,value){
  if(group==='size')return sizeName(value);
  if(group==='spell-ability')return abilityName(value);
  if(VALUE_KIND[group])return buildName(VALUE_KIND[group],value);
  if(group.startsWith('tools'))return buildName('equipment',value);
  for(const kind of ['feat','spell','equipment','language','skill','class','species','background','feature']){
    const name=data.build[kind+':'+value];if(name)return name;
  }
  return ruleName(value);
}
// "background:acolyte/feat:magic-initiate/cleric/cantrips" -> ["戏法（侍僧 · 魔法初学者 · 牧师）", "神导术、光亮术"]
export function selectionRow({key,values}){
  // "equipment:background/A/0": a choice inside starting-equipment option A of the background.
  const pack=/^equipment:(class|background)\/([A-Z])\//.exec(String(key||''));
  if(pack)return [`装备包内自选（${pack[1]==='class'?'职业':'背景'}起始方案 ${pack[2]}）`,(values||[]).map(v=>buildName('equipment',v)).join('、')||'未选择'];
  const parts=String(key||'').split('/'),group=parts.pop()||'';
  const label=GROUPS[group]??(group.startsWith('tools')?'工具熟练':'其他选择');
  const source=parts.map(sourcePart).join(' · ');
  return [source?`${label}（${source}）`:label,(values||[]).map(v=>selectionValue(group,v)).join('、')||'未选择'];
}
export function abilityBonuses(bonuses){
  return (bonuses||[]).map((amount,i)=>amount?`${abilityName(ABILITY_ORDER[i])} +${amount}`:'').filter(Boolean).join('、');
}

// Server prose that still carries canonical English names ("Human · 额外技能熟练") or source keys,
// read in Chinese. Whole names only, longest first, never inside a longer word.
let namePattern=null;
export function ruleText(text){
  // "Magic动作" is the 2024 Magic action, already a whole phrase ("Magic" alone reads 魔法动作);
  // a Shield reaction is the spell, not the armour.
  const value=String(text??'').replace(/Magic ?动作/g,'魔法动作').replace(/Shield ?反应/g,'护盾术反应')
    .replace(/(?:class|species|background):[a-z0-9-]+(?:\/[a-z0-9:-]+)*/g,m=>m.split('/').map(sourcePart).join(' · '));
  namePattern??=new RegExp('(?<![A-Za-z0-9_-])(?:'+Object.keys(data.names).filter(k=>data.names[k]!==k).sort((a,b)=>b.length-a.length)
    .map(k=>k.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|')+')(?![A-Za-z0-9_-])','gi');
  return value.replace(namePattern,m=>data.names[m.toLowerCase()]??m);
}
// A server action label ("Acid Splash / 中心(3,3)（class:wizard）") in Chinese. Its leading name is read as a
// spell first: in a cast or reaction "Shield" is the spell, not the armour. The engine's bilingual self
// actions ("Dodge / 闪避") keep their Chinese half.
const BILINGUAL=/^(?:Dodge|Dash|Disengage|Search|Second Wind|Action Surge) \/ /;
// Ability abbreviations in engine prose ("CON豁免") read as their names.
export const abilityAbbreviations=text=>String(text??'').replace(/(?<![A-Za-z])(?:STR|DEX|CON|INT|WIS|CHA)(?![A-Za-z])/g,m=>ABILITIES[m.toLowerCase()]);
export function actionLabel(text){
  const value=String(text??'').replace(BILINGUAL,''),cut=value.indexOf(' / ');
  const head=cut<0?value:value.slice(0,cut);
  const spell=data.build['spell:'+head.trim().toLowerCase().replace(/[^a-z0-9]+/g,'-')];
  return abilityAbbreviations(spell?spell+ruleText(value.slice(head.length)):ruleText(value));
}
// The name of one option in a build choice group; special keys hold top-level build arrays.
const SPECIAL_KIND={$classSkills:'skill',$expertise:'skill',$cantrips:'spell',$spellbook:'spell',$preparedSpells:'spell'};
export function optionName(key,id){
  if(SPECIAL_KIND[key])return buildName(SPECIAL_KIND[key],id);
  if(String(key).startsWith('equipment:'))return buildName('equipment',id);
  return selectionValue(String(key).split('/').pop(),id);
}

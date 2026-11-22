// A whole level-one character from a class (and, if the player cares, a species): every other choice
// takes a starting suggestion, the way a table hands a new player a ready character. The server checks
// the result like any build; the full builder can change any of it. Product suggestions, not rules.
import * as draft from './build-draft.js';

// What playing each class is like, for a player choosing without the rulebook.
export const ROLES={
  barbarian:['冲在最前、狂暴时硬扛伤害的近战。','上手容易'],
  bard:['用音乐与魔法鼓舞队友、扰乱敌人，什么都会一点。','中等'],
  cleric:['治疗与守护队伍的神术施法者，也能穿甲上前。','中等'],
  druid:['借自然之力施法，治疗与控场都行。','中等'],
  fighter:['武器与护甲最全面的战斗好手。','上手最容易'],
  monk:['身手敏捷、徒手连击，靠走位取胜的近战。','中等'],
  paladin:['重甲近战，能治疗，也能用神圣斩击爆发。','上手容易'],
  ranger:['擅长弓箭与野外追踪的远程战士。','上手容易'],
  rogue:['潜行、开锁、偷袭要害，技能最多。','中等'],
  sorcerer:['天生魔力的施法者，法术不多但威力集中。','较难'],
  warlock:['与异界存在立约，靠法术持续远程输出。','中等'],
  wizard:['法术最多最灵活的学者，身体脆弱。','较难']};

// A background whose ability increases fit the class (2024: +2/+1 among the background's three).
const BACKGROUND={barbarian:'soldier',bard:'entertainer',cleric:'acolyte',druid:'hermit',fighter:'soldier',monk:'guide',
  paladin:'noble',ranger:'guide',rogue:'criminal',sorcerer:'charlatan',warlock:'charlatan',wizard:'sage'};
// Spells the standard combat engine casts from its buttons come first, so a caster can act in a fight;
// then Detect Magic, the spell players reach for when exploring (a wizard casts it as a ritual from the book).
const SPELLS=['magic-missile','shield','cure-wounds','healing-word','acid-splash','thunderclap','arms-of-hadar','blade-ward','expeditious-retreat','detect-magic'];
const FEATS=['tough','alert'];
const ARMOR=new Set(['LA','MA','HA']);

function rank(group,catalog,build){
  const priority=draft.recommended({...build,baseScores:[],backgroundBonuses:[]},catalog).baseScores;
  const known=new Set(catalog.backgrounds.find(b=>b.id===build.backgroundId)?.skills||[]);
  if(group.key!=='$classSkills')build.classSkills.forEach(id=>known.add(id));
  for(const other of build.selections)if(other.key!==group.key)other.values.forEach(id=>known.add(id));
  const score=option=>{
    const id=option.id,skill=catalog.skills.find(s=>s.id===id);
    if(skill)return (known.has(id)?100:0)-(priority[catalog.abilities.indexOf(skill.ability)]||0);
    if(SPELLS.includes(id))return SPELLS.indexOf(id)-50;
    if(FEATS.includes(id))return FEATS.indexOf(id)-50;
    if(id==='medium'||id==='M')return -1;
    return 0;
  };
  return group.options.map((option,index)=>({option,index})).sort((a,b)=>score(a.option)-score(b.option)||a.index-b.index).map(x=>x.option.id);
}

// One pass over the current check: every group not yet full takes its best-ranked free options.
function fill(build,groups,catalog){
  let next=build;
  for(const group of groups){
    const chosen=draft.selected(next,group.key);
    if(chosen.length>=group.count)continue;
    for(const id of rank(group,catalog,next)){
      if(draft.selected(next,group.key).length>=group.count)break;
      if(draft.selected(next,group.key).includes(id))continue;
      next=draft.toggle(next,groups,group,id)??next;
    }
  }
  return next===build?null:next;
}

// Armor the character owns is worn (one suit, and a shield); unworn armor counts as none.
function wear(build,catalog){
  const {items}=draft.owned(build,catalog),pieces=[...items.keys()].map(id=>catalog.equipment.find(e=>e.id===id)).filter(Boolean);
  const suit=pieces.filter(e=>ARMOR.has(e.kind)).at(-1),shield=pieces.find(e=>e.kind==='S');
  return {...build,equipped:[suit?.id,shield?.id].filter(Boolean)};
}

export function startBuild(catalog,classId,speciesId='human'){
  const cls=catalog.classes.find(c=>c.id===classId),backgroundId=BACKGROUND[classId]||catalog.backgrounds[0].id;
  const bg=catalog.backgrounds.find(b=>b.id===backgroundId);
  const build=draft.recommended({...draft.emptyBuild(catalog),classId,speciesId,backgroundId},catalog);
  build.classEquipment=cls.equipment.find(p=>p.items.length)?.id||cls.equipment[0]?.id||'';
  build.backgroundEquipment=bg.equipment.find(p=>p.items.length)?.id||bg.equipment[0]?.id||'';
  return build;
}

// Fill and re-check until the server shows no open group; a later group may appear once its source is chosen.
export async function quickBuild(catalog,evaluate,{classId,speciesId='human',name=''}){
  let build=startBuild(catalog,classId,speciesId);
  build.identity={...build.identity,name};
  for(let round=0;round<12;round++){
    const evaluation=await evaluate(build);
    const next=fill(build,evaluation.groups,catalog);
    if(next){build=next;continue;}
    const worn=wear(build,catalog);
    if(JSON.stringify(worn.equipped)===JSON.stringify(build.equipped))return {build,evaluation};
    build=worn;
  }
  throw new Error('推荐配置没有完成，可以改用详细调整。');
}

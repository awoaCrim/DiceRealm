// The level-one build being edited (docs/full-character-creation.md). Only input editing lives here:
// choices, dependency clearing and the point-buy arithmetic. The server evaluates every build and
// owns all derived rules; nothing here makes a build legal. Ported from Unity BuildDraftState.

export const STEPS=['class','origin','abilities','choices','spells','equipment','details','review'];
export const STEP_NAMES=['职业','起源','属性','选择','法术','装备','人物','复核'];

export function emptyBuild(catalog){
  return {ruleset:catalog.ruleset,revision:catalog.revision,classId:'',speciesId:'',backgroundId:'',abilityMethod:'point-buy',
    baseScores:[],backgroundBonuses:[],classSkills:[],expertise:[],selections:[],cantrips:[],preparedSpells:[],spellbook:[],
    classEquipment:'',backgroundEquipment:'',purchases:[],equipped:[],
    identity:{name:'',pronouns:'',appearance:'',personality:'',backstory:'',alignment:'neutral'}};
}

// Special group keys hold top-level arrays; every other group lives in `selections`.
const ARRAYS={$classSkills:'classSkills',$expertise:'expertise',$cantrips:'cantrips',$spellbook:'spellbook',$preparedSpells:'preparedSpells'};
export const selected=(build,key)=>ARRAYS[key]?build[ARRAYS[key]]:build.selections.find(s=>s.key===key)?.values||[];
function put(build,key,values){
  if(ARRAYS[key]){build[ARRAYS[key]]=values;return;}
  build.selections=build.selections.filter(s=>s.key!==key);
  if(values.length)build.selections.push({key,values});
}
// Every group whose source depends, directly or not, on this key.
function descendants(groups,key){
  const all=new Set([key]);let changed=true;
  while(changed){
    changed=false;
    for(const group of groups)if(!all.has(group.key)&&group.dependsOn.some(k=>all.has(k))){all.add(group.key);changed=true;}
  }
  all.delete(key);
  // Removing a spell from the book drops only that spell from the prepared list (below).
  if(key==='$spellbook')all.delete('$preparedSpells');
  return all;
}

// A changed source clears what was chosen under it, including groups the last partial check could not show.
export function edit(build,groups,key,change){
  const next=structuredClone(build);
  const keep=prefixes=>next.selections=next.selections.filter(s=>!prefixes.some(p=>s.key.startsWith(p)));
  if(key==='$class'){
    Object.assign(next,{baseScores:[],classSkills:[],expertise:[],cantrips:[],preparedSpells:[],spellbook:[],classEquipment:'',purchases:[],equipped:[]});
    keep(['class:','equipment:class/']);
  }
  if(key==='$species'){next.expertise=[];keep(['species:']);}
  if(key==='$background'){
    Object.assign(next,{backgroundBonuses:[],backgroundEquipment:'',expertise:[],purchases:[],equipped:[]});
    keep(['background:','equipment:background/','species:human/origin-feat','species:human/versatile/']);
  }
  if(key==='$classEquipment'||key==='$backgroundEquipment'){
    keep([key==='$classEquipment'?'equipment:class/':'equipment:background/']);next.equipped=[];
  }
  if(key==='$abilityMethod')next.baseScores=[];
  for(const child of descendants(groups,key))put(next,child,[]);
  change(next);
  if(key==='$spellbook')next.preparedSpells=next.preparedSpells.filter(id=>next.spellbook.includes(id));
  return next;
}
// One click on an option: a single choice is replaced, a full multi-choice must be emptied first.
// Returns the edited build, or null when the group is already full.
export function toggle(build,groups,group,id){
  if(!group.options.some(o=>o.id===id))return build;
  const values=[...selected(build,group.key)];
  if(values.includes(id)){if(group.count===1)return build;values.splice(values.indexOf(id),1);}
  else if(group.count===1)values.splice(0,values.length,id);
  else if(values.length<group.count)values.push(id);
  else return null;
  return edit(build,groups,group.key,b=>put(b,group.key,values));
}

// Point buy: 8..15, every point within the catalog budget.
export const pointSpent=(build,catalog)=>build.baseScores.filter(s=>s>=8&&s<=15).reduce((sum,s)=>sum+catalog.pointCosts[s-8],0);
export function canAdjust(build,catalog,index,delta){
  const old=build.baseScores[index],value=old+delta;
  return build.baseScores.length===6&&old>=8&&old<=15&&value>=8&&value<=15
    &&pointSpent(build,catalog)-catalog.pointCosts[old-8]+catalog.pointCosts[value-8]<=catalog.pointBudget;
}

// A product starting suggestion, not a rule: the class's priorities take 15/14/14/12/8/8 (exactly 27
// points) and the background's +2/+1 go to its two highest priorities. Every value stays editable.
const PRIORITY={barbarian:['str','con','dex','wis','cha','int'],fighter:['str','con','dex','wis','cha','int'],
  bard:['cha','dex','con','wis','int','str'],cleric:['wis','con','dex','str','cha','int'],druid:['wis','con','dex','int','cha','str'],
  monk:['dex','wis','con','str','cha','int'],paladin:['str','cha','con','wis','dex','int'],ranger:['dex','wis','con','str','int','cha'],
  rogue:['dex','con','int','wis','cha','str'],sorcerer:['cha','con','dex','wis','int','str'],warlock:['cha','con','dex','wis','int','str'],
  wizard:['int','con','dex','wis','cha','str']};
export const primaryAbility=classId=>PRIORITY[classId]?.[0]||'';
export function recommended(build,catalog){
  const priority=PRIORITY[build.classId];if(!priority)return build;
  const next=structuredClone(build),values=[15,14,14,12,8,8];
  if(next.baseScores.length!==6){next.abilityMethod='point-buy';next.baseScores=catalog.abilities.map(id=>values[priority.indexOf(id)]);}
  const background=catalog.backgrounds.find(b=>b.id===next.backgroundId);
  if(background&&next.backgroundBonuses.length!==6){
    const [two,one]=priority.filter(id=>background.abilities.includes(id)).map(id=>catalog.abilities.indexOf(id));
    next.backgroundBonuses=[0,0,0,0,0,0];next.backgroundBonuses[two]=2;next.backgroundBonuses[one]=1;
  }
  return next;
}

// What the chosen starting plans, pack choices and purchases hold, and the coins left. Display only:
// the server checks the budget and the final inventory.
export function owned(build,catalog){
  const items=new Map(),add=(id,quantity)=>items.set(id,(items.get(id)||0)+quantity);let remaining=0;
  const plans=[catalog.classes.find(c=>c.id===build.classId)?.equipment.find(p=>p.id===build.classEquipment),
    catalog.backgrounds.find(b=>b.id===build.backgroundId)?.equipment.find(p=>p.id===build.backgroundEquipment)];
  for(const plan of plans)if(plan){remaining+=plan.copper;for(const item of plan.items)add(item.id,item.quantity);}
  for(const choice of build.selections)if(choice.key.startsWith('equipment:'))for(const id of choice.values)add(id,1);
  for(const p of build.purchases){add(p.id,p.quantity);remaining-=(catalog.equipment.find(e=>e.id===p.id)?.price??0)*p.quantity;}
  return {items,remaining};
}
export function money(cp){
  if(!cp)return '0 金币';
  const value=Math.abs(cp),parts=[];
  if(Math.floor(value/100))parts.push(Math.floor(value/100)+' 金币');
  if(Math.floor(value%100/10))parts.push(Math.floor(value%100/10)+' 银币');
  if(value%10)parts.push(value%10+' 铜币');
  return (cp<0?'−':'')+parts.join(' ');
}
export const wearable=item=>!!item.weaponCategory||['LA','MA','HA','S'].includes(item.kind);
export const SHOP=[['all','全部'],['weapons','武器'],['armor','护甲与盾牌'],['tools','工具'],['gear','冒险用品']];
export function inCategory(item,category){
  const weapon=!!item.weaponCategory,armor=['LA','MA','HA','S'].includes(item.kind),tool=['T','AT','GS','INS'].includes(item.kind);
  return category==='all'||category==='weapons'&&weapon||category==='armor'&&armor||category==='tools'&&tool||category==='gear'&&!weapon&&!armor&&!tool;
}
export function purchase(build,groups,catalog,id,delta){
  const item=catalog.equipment.find(e=>e.id===id);
  if(delta>0&&(!item?.hasPrice||item.price>owned(build,catalog).remaining))return null;
  return edit(build,groups,'$purchases',b=>{
    const old=b.purchases.find(p=>p.id===id)?.quantity||0,quantity=Math.max(0,Math.min(999,old+delta));
    b.purchases=b.purchases.filter(p=>p.id!==id);if(quantity)b.purchases.push({id,quantity});
  });
}

// "Choices" and "spells" are pages only when the current check has something there.
export function applicable(index,groups,evaluation){
  if(index!==3&&index!==4)return true;
  const step=STEPS[index];
  return groups.some(g=>g.step===step)||!!evaluation?.issues.some(i=>i.step===step);
}

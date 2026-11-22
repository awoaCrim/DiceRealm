// Level-up choices (docs/character-advancement.md), ported from Unity AdvancementDraftState. Local
// choices only: the server previews every draft and owns eligibility, growth rules and results.

export function newDraft(character){
  return {revision:character.build?.revision||'',classId:character.build?.classId||'',subclassId:'',selections:[]};
}
export const chooseClass=(draft,classId)=>({...draft,classId,subclassId:'',selections:[]});
export function selectedIn(draft,group){
  if(group.key==='subclass')return draft.subclassId?[draft.subclassId]:[];
  return draft.selections.find(s=>s.key===group.key)?.values??group.selected;
}
// Groups are answered in order: a changed answer drops the answers and groups after it until the
// next preview lists them again. A subclass starts the list over. Returns null for a full group.
export function select(draft,groups,group,id){
  if(!group.options.some(o=>o.id===id))return null;
  let values=[...selectedIn(draft,group)];
  if(group.count===1)values=[id];
  else if(values.includes(id))values=values.filter(v=>v!==id);
  else if(values.length<group.count)values.push(id);
  else return null;
  if(group.key==='subclass')return {draft:{...draft,subclassId:values[0]||'',selections:[]},groups:[group]};
  const index=groups.findIndex(g=>g.key===group.key),later=new Set(groups.slice(index+1).map(g=>g.key));
  return {draft:{...draft,selections:[...draft.selections.filter(s=>s.key!==group.key&&!later.has(s.key)),{key:group.key,values}]},
    groups:groups.slice(0,index+1)};
}

// What the campaign currently knows: where the party is, quests, people, factions, and the
// places/people/clues the system recorded during play.
// Organized into catalog/tabs + details to reuse existing on-demand reading.
import {h,card,kv,pageHead} from './dom.js';
import {goals,questStatusLabels,sceneLabel} from './tasking.js';
import {worldMemoryCard} from './world-memory.js';
import {createDialogHost} from './workspace-dialog.js';

function questsCard(snapshot){
  const quests=goals(snapshot);
  return card('剧本任务进度','',quests.length?h('ul.goal-list',{},...quests.map(q=>h('li',{},
    h('h4',{},q.title,q.status?h('span.tag',{},questStatusLabels[q.status]||q.status):null),
    q.summary?h('p.small',{},q.summary):null,
    q.objectives.length?h('ul.obj-list',{},...q.objectives.map(o=>h('li',{class:o.complete?'done':''},(o.complete?'✓ ':'○ ')+o.text))):null)))
    :h('p.small.muted',{},'剧本没有声明任务。'));
}

function peopleCard(snapshot){
  const npcs=(snapshot.world?.npcs||[]).filter(Boolean),factions=(snapshot.world?.factions||[]).filter(Boolean);
  const faction=id=>factions.find(f=>f.id===id)?.name||'';
  return card('剧本人物与阵营','',
    npcs.length?h('ul.plain.people-list',{},...npcs.map(n=>h('li',{},h('strong',{},n.name),
      h('span.small.muted',{},` · ${sceneLabel(snapshot,n.sceneId)}${faction(n.factionId)?' · '+faction(n.factionId):''} · ${n.met?'已见过':'尚未见过'}`),
      n.summary?h('p.small',{},n.summary):null))):h('p.small.muted',{},'剧本没有声明人物。'),
    factions.length?h('div',{},h('h4',{},'阵营好感'),kv(factions.map(f=>[f.name,String(f.score??0)]))):null);
}

// The player page shows this inside its own titled window, without the page head.
export function renderWorld(mount,ctx,{head=true}={}){
  let disposed=false;
  mount.addEventListener('dispose',()=>{disposed=true;},{once:true});
  const snapshot=ctx.snapshot,dialogs=createDialogHost(mount);

  const memoryPanel=h('section',{'aria-label':'冒险记录'},worldMemoryCard(ctx,()=>disposed,{dialogs}));
  const authoredPanel=h('section',{'aria-label':'剧本任务与人物',hidden:true},h('div.world-grid',{},questsCard(snapshot),peopleCard(snapshot)));
  const scenePanel=h('section',{'aria-label':'当前地点',hidden:true},
    card('当前地点',`第 ${snapshot.chapter} 章`,
      h('h3',{},snapshot.scene?.title||'未开始'),
      snapshot.scene?.summary?h('p',{},snapshot.scene.summary):null,
      kv([['已到访地点',String((snapshot.visitedScenes||[]).length)]])));

  const panels=[
    {id:'memory',label:'冒险记录',element:memoryPanel},
    {id:'authored',label:'剧本设定与任务',element:authoredPanel},
    {id:'scene',label:'当前地点',element:scenePanel}
  ];

  const tabs=panels.map(p=>{
    const tab=h('button.btn',{type:'button',onclick:()=>selectPanel(p.id)},p.label);
    tab.panelId=p.id;
    return tab;
  });

  function selectPanel(id){
    panels.forEach(p=>{
      p.element.hidden=p.id!==id;
    });
    tabs.forEach(t=>{
      const on=t.panelId===id;
      t.classList.toggle('active',on);
      t.setAttribute('aria-pressed',String(on));
    });
  }

  mount.append(h('div.view',{},
    head?pageHead('世界记录'):null,
    h('div.page-tabs',{},...tabs),
    memoryPanel,
    authoredPanel,
    scenePanel));

  selectPanel('memory');
}

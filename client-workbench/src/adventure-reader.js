// Read-only view of an imported adventure document: scenes, routes, actions, encounters,
// quests, people, items and opening knowledge, in the author's own words.
// Organized into catalog/list + details to avoid dumping giant walls of text.
import {h,card,kv} from './dom.js';
import {skillLabel,abilityLabel} from './rule-labels.js';

const visibilityLabels={public:'公开',host:'仅主持',arrival:'到达后公开'};
const kindLabels={npc:'人物',quest:'任务',place:'地点',clue:'线索'};

function condition(when){
  const c=when||{},parts=[];
  if(c.all?.length)parts.push('全部满足：'+c.all.join('、'));
  if(c.any?.length)parts.push('任一满足：'+c.any.join('、'));
  if(c.none?.length)parts.push('都不满足：'+c.none.join('、'));
  return parts.join('；')||'无条件';
}

function effects(list){
  return (list||[]).map(e=>e.op==='fact'?'记录 '+e.key:e.op==='removeFact'?'移除 '+e.key:e.op==='item'?`物品 ${e.key} ${e.amount>0?'+':''}${e.amount}`:e.op==='chapter'?'推进到第 '+e.amount+' 章':e.op).join('、');
}

const outcome=(label,o)=>o?.text||o?.effects?.length?h('p.small',{},`${label}：${o.text||''}${o.effects?.length?'（'+effects(o.effects)+'）':''}`):null;

function action(a){
  const check=a.check?`${skillLabel(a.check.skill)||abilityLabel(a.check.ability)} DC ${a.check.dc}`:'无需检定';
  return h('li',{},h('strong',{},a.label),h('span.small.muted',{},` · ${check}${a.repeatable?' · 可重复':''}`),
    condition(a.when)!=='无条件'?h('p.small.muted',{},'出现条件：'+condition(a.when)):null,
    outcome('成功',a.success),a.check?outcome('失败',a.failure):null);
}

function sceneDetails(s,titles){
  return h('article.adventure-scene-card',{},
    h('div.adventure-scene-head',{},
      h('h3',{},s.title),
      s.safeRest?h('span.tag',{},'可休整'):null
    ),
    s.summary?h('p',{},s.summary):null,
    s.arrival?h('div',{},h('h4',{},'到达描写'),h('p',{},s.arrival)):null,
    s.exits?.length?h('div',{},h('h4',{},'路线'),h('ul.plain',{},...s.exits.map(e=>h('li',{},`→ ${titles.get(e.target)||e.target} · ${Math.round((e.seconds??600)/60)} 分钟`,
      condition(e.when)!=='无条件'?h('span.small.muted',{},' · '+condition(e.when)):null)))):null,
    s.actions?.length?h('div',{},h('h4',{},'可做的事'),h('ul.plain',{},...s.actions.map(action))):null,
    s.encounter?h('div',{},h('h4',{},'遭遇：'+s.encounter.title),
      h('ul.plain',{},...s.encounter.enemies.map(e=>h('li',{},`${e.name} · HP ${e.hitPoints} · AC ${e.armorClass} · 攻击 +${e.attackBonus} · ${e.damageDice}d${e.damageDie}+${e.damageBonus}`))),
      outcome('胜利',s.encounter.victory)):null);
}

export function adventureReader(doc){
  if(!doc)return card('剧本','',h('p.muted',{},'还没有导入剧本。'));
  const titles=new Map((doc.scenes||[]).map(s=>[s.id,s.title]));

  // Panels for each section
  const overviewPanel=h('div.catalog-panel',{},
    card(doc.name,`版本 ${doc.version}`,
      kv([
        ['起点',titles.get(doc.startSceneId)||doc.startSceneId],
        ['场景数',String(doc.scenes?.length||0)],
        doc.level2Milestone?['升到 2 级的条件',condition(doc.level2Milestone)]:null
      ])));

  const scenes=doc.scenes||[];
  let selectedSceneIndex=0;
  const sceneDetailBox=h('div.scene-detail-box');
  const sceneNavList=h('div.sub-nav-list',{'role':'tablist','aria-label':'场景列表'});

  function updateSceneView(){
    const s=scenes[selectedSceneIndex];
    if(s)sceneDetailBox.replaceChildren(sceneDetails(s,titles));
    else sceneDetailBox.replaceChildren(h('p.muted',{},'暂无场景'));
    sceneNavList.querySelectorAll('button').forEach((btn,idx)=>{
      const on=idx===selectedSceneIndex;
      btn.classList.toggle('active',on);
      btn.setAttribute('aria-selected',String(on));
    });
  }

  scenes.forEach((s,idx)=>{
    const btn=h('button.btn.btn-ghost.sub-nav-item',{
      type:'button',
      role:'tab',
      onclick:()=>{selectedSceneIndex=idx;updateSceneView();}
    },s.title||('场景 '+(idx+1)));
    sceneNavList.append(btn);
  });
  updateSceneView();

  const scenesPanel=h('div.catalog-panel',{},
    card('场景','',
      h('div.catalog-sub-shell',{},
        sceneNavList,
        sceneDetailBox)));

  const quests=doc.quests||[];
  const questsPanel=quests.length?h('div.catalog-panel',{},
    card('任务',`${quests.length} 项任务`,
      ...quests.map(q=>h('div.adventure-quest',{},
        h('h4',{},q.title),
        q.summary?h('p.small',{},q.summary):null,
        q.reward?h('p.small',{},'奖励：'+q.reward):null,
        h('ul.obj-list',{},...q.objectives.map(o=>h('li',{},o.text))))))):null;

  const npcs=doc.npcs||[];
  const npcsPanel=npcs.length?h('div.catalog-panel',{},
    card('人物',`${npcs.length} 位人物`,
      h('ul.plain',{},...npcs.map(n=>h('li',{},
        h('strong',{},n.name),' · '+(titles.get(n.sceneId)||n.sceneId),
        n.summary?h('p.small',{},n.summary):null))))):null;

  const items=doc.items||[];
  const itemsPanel=items.length?h('div.catalog-panel',{},
    card('物品',`${items.length} 件物品`,
      h('ul.plain',{},...items.map(i=>h('li',{},i.name))))):null;

  const knowledge=doc.initialKnowledge||[];
  const knowledgePanel=knowledge.length?h('div.catalog-panel',{},
    card('开局知识',`${knowledge.length} 条知识`,
      h('ul.plain',{},...knowledge.map(k=>h('li',{},
        h('strong',{},k.name),` · ${kindLabels[k.kind]||k.kind} · ${visibilityLabels[k.visibility]||k.visibility}`,
        h('p.small',{},k.summary)))))):null;

  const sourcePanel=doc.sourceText?h('div.catalog-panel',{},
    card('剧本原文','导入时的原始文本',
      h('pre.req-text',{},doc.sourceText))):null;

  const sectionsList=[
    {id:'overview',label:'战役概况',panel:overviewPanel},
    {id:'scenes',label:`场景 (${scenes.length})`,panel:scenesPanel},
    ...(questsPanel?[{id:'quests',label:`任务 (${quests.length})`,panel:questsPanel}]:[]),
    ...(npcsPanel?[{id:'npcs',label:`人物 (${npcs.length})`,panel:npcsPanel}]:[]),
    ...(itemsPanel?[{id:'items',label:`物品 (${items.length})`,panel:itemsPanel}]:[]),
    ...(knowledgePanel?[{id:'knowledge',label:`开局知识 (${knowledge.length})`,panel:knowledgePanel}]:[]),
    ...(sourcePanel?[{id:'source',label:'剧本原文',panel:sourcePanel}]:[])
  ];

  const catalogNav=h('aside.catalog-nav',{'role':'tablist','aria-label':'剧本目录'});
  const detailContainer=h('div.catalog-main');

  function chooseSection(targetId){
    sectionsList.forEach(item=>{
      const on=item.id===targetId;
      item.panel.hidden=!on;
    });
    catalogNav.querySelectorAll('button').forEach(btn=>{
      const on=btn.dataset.section===targetId;
      btn.classList.toggle('active',on);
      btn.setAttribute('aria-selected',String(on));
    });
  }

  sectionsList.forEach(item=>{
    const btn=h('button.navitem',{
      type:'button',
      role:'tab',
      'data-section':item.id,
      onclick:()=>chooseSection(item.id)
    },h('span',{},item.label));
    catalogNav.append(btn);
    detailContainer.append(item.panel);
  });

  chooseSection('overview');

  return h('div.adventure-reader.catalog-shell',{},
    catalogNav,
    detailContainer);
}

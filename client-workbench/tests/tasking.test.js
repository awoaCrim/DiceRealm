import test from 'node:test';
import assert from 'node:assert/strict';
import {groupRulings,hostTaskCount,actorLabel,sceneLabel,recentConfirmations,goals,nextChoices,prepChecklist,advancedFacts,outcomeLabels} from '../src/tasking.js';

const base=()=>({id:'c1',version:9,chapter:2,archived:false,facts:['gate.open'],
  scene:{id:'s1',title:'祭坛',summary:'潮湿的祭坛'},map:{nodes:[{id:'s2',title:'石门'}]},
  party:{isHost:true,members:[{id:'host',character:{name:'主持'}},{id:'p1',character:{name:'游侠'}}]},
  world:{quests:[{id:'q1',title:'寻找祭坛',status:'active',summary:'线索',objectives:[{text:'进入祭坛',complete:true},{text:'读懂铭文',complete:false}]}],
    branches:[{id:'b1',label:'选择阵营',choice:'帮守门人'}]},
  availableActions:[{kind:'observe',label:'观察祭坛',details:{cost:'无',range:'近距'}},{kind:'travel',label:'进入石门',details:{unavailableReason:'需要钥匙'}}],
  content:{status:'ready_to_activate',message:'需要重新检查',adventure:{name:'我的剧本',version:'2'},prompts:null}});

test('rulings split into unresolved, awaiting consequence and responded groups',()=>{
  const pending={id:'r1',status:'pending',text:'推门',outcome:''};
  const awaiting={id:'r2',status:'resolved',text:'搜索',outcome:'check',story:null};
  const settled={id:'r3',status:'resolved',text:'越过石门',outcome:'check',story:{resultText:'石门开启'}};
  const rejected={id:'r4',status:'resolved',text:'偷门',outcome:'reject',story:null};
  const {pending:p,awaitingStory:a,settled:s}=groupRulings([pending,awaiting,settled,rejected,null]);
  assert.deepEqual(p.map(r=>r.id),['r1']);
  assert.deepEqual(a.map(r=>r.id),['r2'],'a resolved check without story still needs a consequence');
  assert.deepEqual(s.map(r=>r.id),['r3','r4'],'settled story and explicit rejection are already responded');
  assert.equal(outcomeLabels.board_move,'已结算移动');assert.equal(outcomeLabels.effects,'已落实角色效果');
});

test('ordinary responses and settled board movement do not manufacture a second DM task',()=>{
  const narrative={id:'n',status:'resolved',outcome:'narrative',resolvedAt:'2026-10-15'};
  const move={id:'m',status:'resolved',outcome:'board_move',resolvedAt:'2026-10-15'};
  const applied={id:'e',status:'resolved',outcome:'check',effectsRequestId:'confirmed-effect'};
  const groups=groupRulings([narrative,move,applied]);
  assert.deepEqual(groups.awaitingStory,[]);
  assert.deepEqual(groups.settled,[narrative,move,applied]);
  assert.equal(recentConfirmations([narrative,move,applied]).length,3);
});

test('labels and recent confirmations never invent names or order',()=>{
  const snapshot=base();
  assert.equal(actorLabel(snapshot,'p1'),'游侠');
  assert.equal(actorLabel(snapshot,'missing'),'missing');
  assert.equal(sceneLabel(snapshot,'s1'),'祭坛');
  assert.equal(sceneLabel(snapshot,'s2'),'石门');
  assert.equal(sceneLabel(snapshot,'unknown-scene'),'unknown-scene');
  const recent=recentConfirmations([
    {id:'old',status:'resolved',outcome:'reject',resolvedAt:'2025-01-01T00:00:00+00:00'},
    {id:'new',status:'resolved',outcome:'check',story:{resultText:'x'},resolvedAt:'2025-03-01T00:00:00+00:00'},
    {id:'mid',status:'resolved',outcome:'check',story:{resultText:'y'},resolvedAt:'2025-02-01T00:00:00+00:00'},
    {id:'pending',status:'pending'}],2);
  assert.deepEqual(recent.map(r=>r.id),['new','mid']);
});

test('goals and next choices come only from declared snapshot data',()=>{
  const snapshot=base();
  assert.equal(goals(snapshot)[0].objectives[0].complete,true);
  assert.deepEqual(goals(snapshot)[0].objectives[1],{text:'读懂铭文',complete:false});
  assert.deepEqual(goals({world:null}),[]);
  const choices=nextChoices(snapshot);
  assert.deepEqual(choices.branches,[{id:'b1',label:'选择阵营',choice:'帮守门人'}]);
  assert.deepEqual(choices.available.map(a=>a.label),['观察祭坛']);
  assert.deepEqual(choices.blocked,[{label:'进入石门',reason:'需要钥匙'}]);
  const empty=nextChoices({});
  assert.deepEqual(empty,{branches:[],available:[],blocked:[]},'no declared content means no fabricated options');
});

test('prep checklist reflects real binding status and advanced facts hide version',()=>{
  const snapshot=base();
  const checklist=prepChecklist(snapshot);
  assert.deepEqual(checklist.map(i=>[i.key,i.done]),[['adventure',true],['prompts',false],['activate',false]]);
  assert.equal(checklist[2].detail,'需要重新检查','activation shows the server message, not an invented one');
  const active={...snapshot,content:{status:'active',adventure:{name:'a',version:'1'},prompts:{name:'p',version:'1'}}};
  assert.ok(prepChecklist(active).every(i=>i.done));
  assert.deepEqual(advancedFacts(snapshot),{campaignId:'c1',version:9,archived:false,facts:['gate.open']});
  assert.deepEqual(advancedFacts({}).facts,[]);
});

test('a requested roll is neither a completed check nor a pending host form',()=>{
  const record={id:'roll',status:'awaiting_roll',outcome:'check',check:null};
  const groups=groupRulings([record]);
  assert.deepEqual(groups.awaitingRoll,[record]);
  assert.deepEqual(groups.pending,[]);assert.deepEqual(groups.awaitingStory,[]);assert.deepEqual(groups.settled,[]);
});

test('the story nav badge counts real host tasks only, and never for a guest seat',()=>{
  const snapshot={party:{isHost:true,members:[{id:'a',review:{status:'pending'}},{id:'b',review:{status:'pending'},revoked:true},{id:'c',review:{status:'approved'}}]},
    pendingRulings:[{status:'pending'},{status:'awaiting_roll'},{status:'resolved',outcome:'check'},{status:'resolved',outcome:'narrative'}]};
  assert.equal(hostTaskCount(snapshot),4);
  assert.equal(hostTaskCount({...snapshot,party:{...snapshot.party,isHost:false}}),0);
});

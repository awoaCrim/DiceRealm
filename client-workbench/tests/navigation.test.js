import test from 'node:test';
import assert from 'node:assert/strict';
import {sections,adminPages,resolveRoute,primaryNavigation,defaultRoute,navigationGroups} from '../src/navigation.js';
const host={party:{isHost:true},content:{status:'active'},character:null};
const guest={party:{isHost:false},content:{status:'active'},character:{id:'player'}};
test('campaign navigation keeps invitations visible for hosts with existing players',()=>{
  assert.deepEqual(sections.map(s=>s.id),['story','world','room','saves','campaign','maps','prompts']);
  assert.deepEqual(primaryNavigation({...host,party:{...host.party,members:[{id:'existing',character:{name:'旅人'}}],canInvite:false}}).map(s=>s.id),['story','world','room','saves','campaign','maps','prompts']);
  assert.deepEqual(navigationGroups(host).map(g=>[g.id,g.items.map(s=>s.id)]),[['session',['story','world']],['campaign',['room','saves']],['content',['campaign','maps','prompts']]]);
  assert.deepEqual(navigationGroups(host,{admin:true}).map(g=>g.numeral+g.label),['壹本场','贰战役','叁内容','肆管理']);
  assert.deepEqual(navigationGroups(guest).flatMap(g=>g.items.map(s=>s.id)),['story','world']);
  // Host-gated groups must disappear for a guest instead of rendering an empty heading.
  assert.deepEqual(navigationGroups(guest).map(g=>[g.id,g.items.map(s=>s.id)]),[['session',['story','world']]]);
  assert.deepEqual(navigationGroups(null,{admin:true}).map(g=>[g.id,g.items.map(s=>s.id)]),[['admin',['requests','ai']]]);
  assert.deepEqual(navigationGroups(guest,{admin:true}).map(g=>[g.id,g.items.map(s=>s.id)]),[['session',['story','world']],['admin',['requests','ai']]]);
  assert.deepEqual(navigationGroups(null),[]);
  assert.deepEqual(primaryNavigation(guest).map(s=>s.id),['story','world']);
  assert.deepEqual(adminPages.map(p=>p.id),['requests','ai']);
  assert.equal(defaultRoute(),'story');
  assert.equal(defaultRoute({party:{isHost:true},content:{initialSetup:true}}),'campaign');
  assert.equal(defaultRoute({party:{isHost:false},content:{initialSetup:true}}),'story');
  assert.equal(resolveRoute('#/content',{snapshot:guest}).denied,true);
  assert.equal(resolveRoute('#/content',{snapshot:host}).denied,false);
  assert.equal(resolveRoute('#/room',{snapshot:guest}).denied,true);
  assert.equal(resolveRoute('#/room',{snapshot:host}).view,'room');
  assert.equal(resolveRoute('#/saves',{snapshot:guest}).denied,true);
  assert.equal(resolveRoute('#/saves',{snapshot:host}).view,'saves');
});
test('old bookmarks land on the page that now owns the job',()=>{
  const expected={live:'story',adventure:'story','live/rulings':'story',room:'room',party:'room',journal:'story','journal/system':'story',system:'story',
    prepare:'campaign','prepare/settings':'campaign',content:'campaign','content-settings':'campaign','prepare/maps':'maps',maps:'maps',prompt:'prompts',unknown:'story'};
  for(const [old,path] of Object.entries(expected))assert.equal(resolveRoute('#/'+old,{snapshot:host}).path,path,old);
});

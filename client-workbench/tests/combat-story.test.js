import test from 'node:test';
import assert from 'node:assert/strict';
import {installDom} from './dom-shim.mjs';
installDom();
const {storyMessages}=await import('../src/story.js');
const snapshot=host=>({id:'campaign',version:12,party:{isHost:host,members:[{id:'p',character:{id:'c',name:'旅人'}}]}});
const check={ability:'dexterity',skill:'Initiative',rolls:[17],selected:17,modifier:2,total:19,dc:0,hasDc:false,success:true,mode:'normal'};
const log=(sequence,text,combatId='battle-a',extra={})=>({sequence,round:1,kind:'move',actorId:'p',text,
  presentation:{combatId,text:'公开：'+text,activeActorId:'p',units:[]},...extra});
const entry=result=>({sequence:8,actionId:'action',actorId:'p',status:'completed',origin:{actorName:'旅人',input:'行动'},initialResult:result,narrative:'',narrativeSource:'system'});
const render=(record,host=true)=>{const root=document.createElement('div');root.append(...storyMessages(record,snapshot(host)));return root;};

test('system combat results are readable without an AI narrative',()=>{
  const record=entry({combatLog:[log(1,'旅人移动至桥边'),log(2,'守卫受到七点伤害')]});
  const root=render(record);assert.match(root.textContent,/旅人移动至桥边/);assert.match(root.textContent,/守卫受到七点伤害/);
  assert.equal(root.textContent.split('守卫受到七点伤害').length-1,1);assert.equal(root.querySelectorAll('pre').length,0);
});

test('multi-step combat order is retained, duplicate outer results are not rendered twice',()=>{
  const first=log(1,'第一步：移动'),second=log(2,'第二步：攻击'),third=log(3,'第三步：伤害');
  const record={...entry({combatLog:[third]}),steps:[{number:1,result:{combatLog:[first]}},{number:2,result:{combatLog:[second,third]}}]};
  const text=render(record).textContent;
  assert.ok(text.indexOf(first.text)<text.indexOf(second.text)&&text.indexOf(second.text)<text.indexOf(third.text));
  assert.equal(text.split(third.text).length-1,1);
});

test('reused sequence numbers in a later battle remain distinct',()=>{
  const record={...entry({}),steps:[{number:1,result:{combatLog:[log(1,'前一场开始','old-battle')]}},{number:2,result:{combatLog:[log(1,'后一场开始','new-battle')]}}]};
  const text=render(record).textContent;assert.match(text,/前一场开始/);assert.match(text,/后一场开始/);
});

test('guests see authorized compact presentation while hosts can read exact recorded mechanics',()=>{
  const attack={attackerId:'p',targetId:'enemy',attackerName:'旅人',targetName:'守卫',mode:'normal',rolls:[15],selected:15,modifier:5,total:20,armorClass:12,hit:true,critical:false,damageRolls:[3,4],damageModifier:3,damage:10,damageType:'slashing',damageDice:'2d6',damageApplied:10};
  const item=log(4,'HOST_ONLY_FULL_MECHANICAL_TEXT','battle-a',{kind:'attack',attack,presentation:{combatId:'battle-a',text:'旅人命中了守卫。',activeActorId:'p',units:[]}});
  const host=render(entry({combatLog:[item]}));assert.match(host.textContent,/HOST_ONLY_FULL_MECHANICAL_TEXT/);
  const guest=render(entry({combatLog:[item]}),false);assert.match(guest.textContent,/旅人命中了守卫/);assert.doesNotMatch(guest.textContent,/HOST_ONLY_FULL_MECHANICAL_TEXT|targetArmorClass|attackerId/);
});

test('recorded checks do not fabricate a DC and combat text is always inert',()=>{
  const item=log(1,'<img src=x onerror=alert(1)>先攻记录','battle-a',{kind:'initiative',check});
  const root=render(entry({combatLog:[item]}));assert.equal(root.querySelectorAll('img').length,0);assert.match(root.textContent,/先攻记录/);
  assert.doesNotMatch(root.textContent,/DC\s*0/);
});

test('combat check labels name initiative and death saves in Chinese without duplicated suffixes',()=>{
  const initiative=render(entry({combatLog:[log(1,'先攻结果','battle-a',{check})]}));
  assert.doesNotMatch(initiative.textContent,/Initiative/);
  const death={...check,ability:'',skill:'Death Saving Throw',testKind:'save',rolls:[1],selected:1,total:1,modifier:0,hasDc:true,dc:10,success:false};
  const root=render(entry({combatLog:[log(2,'倒地角色的已存结果','battle-a',{check:death})]}));
  assert.match(root.textContent,/死亡豁免 · DC 10 · 掷骰 1/);assert.doesNotMatch(root.textContent,/Death Saving Throw|豁免豁免/);
});

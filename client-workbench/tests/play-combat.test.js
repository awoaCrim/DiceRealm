// Combat on the player page: choices come only from the server's lists, closed ones keep their
// reason, the grid sits on the battle's frozen map, and the rail lists the initiative order.
import test from 'node:test';
import assert from 'node:assert/strict';
import {installDom} from './dom-shim.mjs';

installDom();
const {combatView,respondModel,reviewEntries,createCombatBar}=await import('../src/play/combat.js');
const {battleMap,gridFrame}=await import('../src/play/map.js');
const {partyModel}=await import('../src/play/model.js');
const {prepare}=await import('../src/api.js');

const option=(kind,target='',label=kind,details={})=>({kind,target,label,details});
function snapshot(extra={}){
  const units=[
    {id:'player',name:'Arden',team:'party',x:3,y:4,hitPoints:9,maxHitPoints:12,armorClass:16,initiative:23,speed:30,movementRemaining:20,
      actionAvailable:false,bonusActionAvailable:true,reactionAvailable:true,standard:{conditions:[]}},
    {id:'g1',name:'堤道守卫',team:'enemy',x:6,y:3,hitPoints:20,maxHitPoints:50,initiative:2,standard:{conditions:['Prone']}}];
  const offered=[option('combat.move','2,3','移动至 2,3',{cost:'5 尺移动'}),option('combat.attack','g1','Greatsword / 堤道守卫'),
    option('combat.dodge','','Dodge / 闪避'),option('combat.cast','spell/a','Shield'),option('combat.cast','spell/b','Sleep'),
    option('combat.end_turn','','结束回合'),option('combat.start','','挑战')];
  return {combat:{id:'c1',status:'active',width:12,height:8,activeActorId:'player',turnOrder:['player','g1'],units,cells:[],
      boardLayout:{mapId:'m1',contentHash:'h1',firstColumn:2,firstRow:1,grid:{cellPixels:64,offsetX:10,offsetY:-6}}},
    party:{selfActorId:'player'},availableActions:offered,
    actionOptions:[...offered,option('combat.dash','','Dash / 疾走',{unavailableReason:'本回合动作已用完'})],...extra};
}

test('combat choices come from the whitelist and keep the server reason when closed', ()=>{
  const view=combatView(snapshot());
  assert.equal(view.mine,true);
  assert.deepEqual([...view.moves.keys()],['2,3']);
  assert.deepEqual([...view.attacks.keys()],['g1']);
  // Attack first, end turn last; the exploration start never shows in a fight.
  assert.deepEqual(view.groups.map(g=>g.kind),['combat.attack','combat.dodge','combat.cast','combat.dash','combat.end_turn']);
  const by=kind=>view.groups.find(g=>g.kind===kind);
  assert.deepEqual([by('combat.dodge').direct,by('combat.cast').direct,by('combat.attack').direct,by('combat.end_turn').direct],[true,false,false,true]);
  assert.deepEqual([by('combat.dash').available,by('combat.dash').reason],[false,'本回合动作已用完']);
  assert.equal(by('combat.cast').name,'施法');
  // Listed but not whitelisted is closed, even without a reason.
  const stale=combatView(snapshot({availableActions:[option('combat.end_turn','','结束回合')]}));
  assert.deepEqual([stale.groups.find(g=>g.kind==='combat.dodge').available,stale.moves.get('2,3').reason],[false,'当前不可用']);
  assert.equal(combatView({combat:{status:'victory'}}),null);
});

test('the bar shows the turn budget and sends only open choices', ()=>{
  const picked=[],bar=createCombatBar({onGroup:g=>picked.push(g.kind)});
  bar.update(combatView(snapshot()));
  assert.equal(bar.element.hidden,false);
  assert.match(bar.element.textContent,/本回合.*移动20\/30 尺.*动作.*附赠.*反应/);
  assert.equal(bar.element.querySelectorAll('.pl-chip.is-spent').length,1);
  const buttons=[...bar.element.querySelectorAll('.pl-act')];
  assert.deepEqual(buttons.map(b=>b.textContent),['攻击','闪避','施法 ▾','疾走','结束回合']);
  buttons[3].dispatchEvent('click');buttons[1].dispatchEvent('click');
  assert.deepEqual(picked,['combat.dodge']);
  assert.equal(buttons[3].getAttribute('title'),'本回合动作已用完');
  picked.length=0;bar.update(combatView(snapshot()),{busy:true});
  [...bar.element.querySelectorAll('.pl-act')].forEach(b=>b.dispatchEvent('click'));
  assert.deepEqual(picked,[]);
  bar.update(null);assert.equal(bar.element.hidden,true);
});

test('the grid sits on the frozen map image, or stands alone', ()=>{
  const layout=snapshot().combat.boardLayout;
  assert.deepEqual(gridFrame(layout,true),{left:10+2*64,top:-6+64,cell:64});
  assert.deepEqual(gridFrame(layout,false),{left:0,top:0,cell:64});
  const ready={id:'m1',contentHash:'h1',published:true,edition:'player',status:'ready'};
  assert.equal(battleMap({maps:[ready]},layout),ready);
  // A redrawn image under the same id is not the battle's map.
  assert.equal(battleMap({maps:[{...ready,contentHash:'h2'}]},layout),null);
  assert.equal(battleMap({maps:[{...ready,published:false}]},layout),null);
});

test('in a fight the rail lists initiative with own AC and others as wound words', ()=>{
  const rail=partyModel(snapshot());
  assert.deepEqual(rail.map(m=>[m.name,m.self,m.current,m.foe,m.detail,m.health]),
    [['Arden',true,true,false,'先攻 23 · AC 16','轻伤'],['堤道守卫',false,false,true,'先攻 2','重伤']]);
  assert.deepEqual(rail[1].tags,['倒地']);
});

test('a structured action sends kind and target only', ()=>{
  assert.deepEqual(prepare('actions/propose',{requestId:'r',expectedVersion:4,kind:'combat.move',target:'2,3',label:'x'}),
    {requestId:'r',expectedVersion:4,kind:'combat.move',target:'2,3',text:''});
});

test('a wait held for this seat asks for a response even in the enemy turn', async ()=>{
  const {noticeModel}=await import('../src/play/model.js');
  const s=snapshot({availableActions:[option('combat.react','spell/x','Shield'),option('combat.react','pass','放弃')],actionOptions:[]});
  s.combat.activeActorId='g1';
  s.combat.standard={wait:{kind:'shield',actorId:'player',description:'攻击已命中；可用Shield反应或明确放弃。'}};
  const notice=noticeModel({snapshot:s,session:null,mode:'business',ready:true,active:[]});
  assert.deepEqual([notice.label,notice.act,notice.text],['需要你回应','respond','攻击已命中；可用Shield反应或明确放弃。']);
  s.combat.standard.wait.actorId='other';
  assert.equal(noticeModel({snapshot:s,session:null,mode:'business',ready:true,active:[]}).label,'等待他人');
  const view=combatView(s);
  assert.equal(view.mine,false);
  assert.deepEqual(view.groups.map(g=>[g.kind,g.direct,g.options.length]),[['combat.react',false,2]]);
});

test('a missile allocation is answered from one card; a downed caster shows its death saves', ()=>{
  const allocate=[option('combat.missile_allocate','one/g1','Magic Missile / 分配一枚至 堤道守卫'),
    option('combat.missile_allocate','all/g1','Magic Missile / 剩余全部 2枚至 堤道守卫'),option('combat.missile_allocate','undo','撤销最后一枚飞弹分配')];
  const s=snapshot({availableActions:allocate,actionOptions:[]});
  s.combat.standard={turnSerial:3,wait:{kind:'missile-allocation',actorId:'player',targetId:'player',description:'Magic Missile已分配1/3枚。'}};
  const wait=respondModel(s);
  assert.deepEqual([wait.key,wait.title,wait.why,wait.options.map(o=>o.target)],
    ['c1:3:missile-allocation:player','分配魔法飞弹','魔法飞弹已分配1/3枚。',['one/g1','all/g1','undo']]);
  s.combat.standard.wait.actorId='other';
  assert.equal(respondModel(s),null);
  // The re-request of a cancelled death save only opens the server's consent card, so it goes straight.
  const down=snapshot({availableActions:[option('combat.death_save','','进行死亡豁免')],actionOptions:[]});
  assert.equal(combatView(down).groups[0].direct,true);
  const me=down.combat.units[0];
  Object.assign(me,{hitPoints:0,standard:{zeroHitPointUnconscious:true,deathSuccesses:1,deathFailures:2,conditions:['Unconscious','Prone']}});
  const row=partyModel(down)[0];
  assert.deepEqual([row.health,row.tags],['倒地',['死亡豁免 成功1 · 失败2','昏迷']]);
  me.standard={...me.standard,stable:true};
  assert.deepEqual(partyModel(down)[0].tags,['昏迷','已稳定']);
});

test('an area spell with many centres is listed once and its centre is picked on the map', ()=>{
  const area=(x,y,targets)=>({x,y,radius:1,targets});
  const splash=(x,y,targets,why='')=>({...option('combat.cast','spell/'+x+y,`Acid Splash / 中心(${x},${y})（class:wizard）`,
    {targetLabel:`中心(${x},${y})`,cost:'1 Magic动作',unavailableReason:why}),area:area(x,y,targets)});
  const offered=[splash(5,3,['g1']),splash(3,4,['player','g1']),
    {...option('combat.cast','spell/t','Thunderclap / Arden（class:wizard）',{targetLabel:'Arden'}),area:area(3,4,[])},
    option('combat.cast','spell/b','Blade Ward / Arden（class:wizard）',{targetLabel:'Arden'})];
  const s=snapshot({availableActions:offered,actionOptions:[...offered,splash(9,9,[],'超出60尺')]});
  const entries=reviewEntries(combatView(s).groups.find(g=>g.kind==='combat.cast').options);
  // One emanation stays an ordinary card entry; the centres become one map pick with their areas.
  assert.deepEqual(entries.map(e=>[e.label,!!e.pick]),
    // The server's source id and English spell names read in Chinese.
    [['酸液飞溅（法师）',true],['雷鸣迸发 / Arden（法师）',false],['剑刃防护 / Arden（法师）',false]]);
  assert.deepEqual(entries[0].options.map(o=>[o.area.x,o.area.targets.length,o.available]),[[5,1,true],[3,2,true],[9,0,false]]);
  assert.deepEqual([entries[0].available,entries[0].details.targetLabel],[true,'在地图上选择中心（2 处可选）']);
  // The rail shows who is concentrating, from the character, not the battle unit.
  s.character={concentration:{spellId:'blade-ward',source:'class:wizard',expiresAtSeconds:60}};
  assert.ok(partyModel(s)[0].tags.includes('专注 · 剑刃防护'));
});

test('a rail entry hovers a character card: own hit points, a wound word for everyone else', ()=>{
  const s=snapshot();
  s.character={name:'Arden',species:'Human',className:'Wizard',level:1,background:'Soldier',hitPoints:9,maxHitPoints:12,armorClass:16,conditions:[]};
  const [me,guard]=partyModel(s);
  // In a fight the battle unit holds the hit points; an enemy has no character to describe.
  assert.deepEqual(me.card,{sub:'人类 · 法师 1 级 · 士兵',rows:[['生命','9 / 12'],['护甲等级','16'],['先攻','23']],hint:'按 C 查看完整角色'});
  assert.deepEqual(guard.card,{sub:'敌人',rows:[['伤势','重伤'],['先攻','2']],hint:''});
  const bram={...s.character,name:'Bram',className:'Fighter',hitPoints:3,armorClass:18,concentration:{spellId:'blade-ward'}};
  const party=partyModel({character:s.character,party:{selfActorId:'player',members:[{id:'player',character:s.character},{id:'b',character:bram}]}});
  assert.deepEqual(party[1].card,{sub:'人类 · 战士 1 级 · 士兵',rows:[['生命','濒危'],['护甲等级','18'],['专注','剑刃防护']],hint:''});
});

test('pins: one per spot led by the place, never a GM pin or a hidden one', async ()=>{
  const {mapPins}=await import('../src/play/map.js');
  const marker=(id,kind,x,y,extra={})=>({id,kind,targetId:id,x,y,visibility:'player',label:id,summary:'',state:'discovered',...extra});
  const map={markers:[marker('harbor','scene',.1,.9),marker('beacon','scene',.9,.1,{visibility:'gm'}),marker('reed','scene',.5,.5,{state:'hidden'}),
      marker('watch','scene',.8,.8)],automaticMarkers:[marker('rumour','memory',.1,.9,{state:'active'})]};
  const pins=mapPins(map);
  assert.deepEqual(pins.map(p=>[p.lead.targetId,p.others.map(o=>o.targetId)]),[['harbor',['rumour']],['watch',[]]]);
  assert.deepEqual(mapPins(null),[]);
});

test('a card names what every choice shares once, and nothing the label or the card already says', async ()=>{
  const {cardLines}=await import('../src/play/combat.js');
  const missile=(label,target)=>({label,available:true,details:{targetLabel:target,cost:'只编辑分配',range:'标准2024模式 · 每格5尺',note:'已分配：；剩余3枚。'}});
  const lines=cardLines([missile('Magic Missile / 分配一枚至 Arden','Arden'),missile('Magic Missile / 分配一枚至 堤道守卫','堤道守卫'),
    {label:'取消本次飞弹分配',available:true,details:{targetLabel:'Arden',cost:'无消耗',range:'标准2024模式 · 每格5尺',note:'清除尚未施放的分配。'}}],'已分配：；剩余3枚。');
  // The ruleset marker on every standard choice says nothing about any of them and is not shown.
  assert.deepEqual(lines,{shared:[],each:[['只编辑分配'],['只编辑分配'],['Arden','无消耗','清除尚未施放的分配。']]});
  // The page's own map entry does not stop the server choices' common line from rising.
  const pick={label:'在地图上点选目标',pick:true,available:true,details:{targetLabel:'每次点击分配一枚'}};
  assert.deepEqual(cardLines([pick,missile('Magic Missile / 分配一枚至 Arden','Arden'),missile('Magic Missile / 分配一枚至 堤道守卫','堤道守卫')]).shared,
    ['只编辑分配','已分配：；剩余3枚。']);
  // An area spell grouped for a centre pick is a choice of its own: another spell's note stays with that spell.
  const ward=target=>({label:'Blade Ward / '+target,available:true,details:{targetLabel:target,cost:'1 Magic动作',note:'专注最多1分钟；每次针对自己的攻击掷骰减1d4。'}});
  const acid={label:'Acid Splash',pick:true,available:true,options:[{}],details:{targetLabel:'在地图上选择中心（24 处可选）',cost:'1 Magic动作'}};
  assert.deepEqual(cardLines([acid,ward('林砚'),ward('林砚（学者）')]),
    {shared:['动作'],each:[['在地图上选择中心（24 处可选）'],['专注最多1分钟；每次针对自己的攻击掷骰减1d4。'],['专注最多1分钟；每次针对自己的攻击掷骰减1d4。']]});
  // One choice keeps its own lines; nothing is hoisted.
  assert.deepEqual(cardLines([missile('Magic Missile / 分配一枚至 Arden','Arden')]).shared,[]);
});

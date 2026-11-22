// Player page character builder and room join: draft editing rules and the one durable join request.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as draft from '../src/play/build-draft.js';
import * as join from '../src/play/join.js';
import {createApi} from '../src/api.js';
import {optionName,ruleText} from '../src/rule-labels.js';

const catalog={ruleset:'dnd2024',revision:'r1',abilities:['str','dex','con','int','wis','cha'],pointCosts:[0,1,2,3,4,5,7,9],pointBudget:27,
  classes:[{id:'wizard',equipment:[{id:'A',items:[{id:'quarterstaff',quantity:1}],copper:500,choices:[]},{id:'B',items:[],copper:5500,choices:[]}]}],
  backgrounds:[{id:'sage',abilities:['con','int','wis'],skills:['arcana','history'],equipment:[{id:'A',items:[{id:'book',quantity:1}],copper:800,choices:[]}]}],
  equipment:[{id:'dagger',price:200,hasPrice:true,kind:'',weaponCategory:'simple'},{id:'rope',price:100,hasPrice:true,kind:'G',weaponCategory:''}]};
const group=(key,step,count,ids,dependsOn=[])=>({key,step,count,dependsOn,options:ids.map(id=>({id,label:id,description:''}))});
const groups=[group('$classSkills','choices',2,['arcana','history','insight'],['$class']),
  group('$cantrips','spells',3,['light','mage-hand','fire-bolt','prestidigitation'],['$class']),
  group('$spellbook','spells',2,['sleep','shield','magic-missile'],['$class']),
  group('$preparedSpells','spells',1,['sleep','shield'],['$class','$spellbook']),
  group('background:sage/feat:magic-initiate/spell-list','spells',1,['wizard','cleric'],['$background']),
  group('background:sage/feat:magic-initiate/wizard/cantrips','spells',2,['light','fire-bolt'],['$background','background:sage/feat:magic-initiate/spell-list'])];
const built=()=>({...draft.emptyBuild(catalog),classId:'wizard',backgroundId:'sage',baseScores:[8,14,14,15,12,8],backgroundBonuses:[0,0,1,2,0,0],
  classSkills:['arcana'],cantrips:['light'],spellbook:['sleep','shield'],preparedSpells:['shield'],classEquipment:'A',equipped:['quarterstaff'],
  selections:[{key:'background:sage/feat:magic-initiate/spell-list',values:['wizard']},{key:'background:sage/feat:magic-initiate/wizard/cantrips',values:['light']},
    {key:'equipment:class/A/0',values:['dagger']}]});

test('changing a source clears what was chosen under it and leaves the rest',()=>{
  const before=built();
  const cls=draft.edit(before,groups,'$class',b=>{b.classId='fighter';});
  assert.equal(cls.classId,'fighter');
  assert.deepEqual([cls.baseScores,cls.classSkills,cls.cantrips,cls.spellbook,cls.preparedSpells,cls.equipped],[[],[],[],[],[],[]]);
  assert.equal(cls.classEquipment,'');
  assert.deepEqual(cls.selections.map(s=>s.key),['background:sage/feat:magic-initiate/spell-list','background:sage/feat:magic-initiate/wizard/cantrips']);
  assert.deepEqual(before.classSkills,['arcana'],'the old build is not changed');
  // The spell list chosen under the background feat clears the cantrips that depend on it, transitively.
  const list=draft.edit(before,groups,'background:sage/feat:magic-initiate/spell-list',b=>{b.selections[0].values=['cleric'];});
  assert.deepEqual(draft.selected(list,'background:sage/feat:magic-initiate/wizard/cantrips'),[]);
  assert.deepEqual(list.cantrips,['light'],'class cantrips do not depend on the feat');
  // Removing a spell from the book drops only that spell from the prepared list.
  const book=draft.toggle(before,groups,groups[2],'shield');
  assert.deepEqual([book.spellbook,book.preparedSpells],[['sleep'],[]]);
  const kept=draft.toggle(before,groups,groups[2],'sleep');
  assert.deepEqual(kept.preparedSpells,['shield']);
  const bg=draft.edit(before,groups,'$background',b=>{b.backgroundId='acolyte';});
  assert.deepEqual([bg.backgroundBonuses,bg.backgroundEquipment,bg.equipped,bg.selections.map(s=>s.key)],[[],'',[],['equipment:class/A/0']],'class pack choices stay');
});

test('a single choice is replaced; a full multi-choice must be emptied first',()=>{
  const b=built(),prepared=groups[3];
  assert.deepEqual(draft.toggle(b,groups,prepared,'sleep').preparedSpells,['sleep']);
  assert.equal(draft.toggle(b,groups,prepared,'shield'),b,'clicking the only choice keeps it');
  const two=draft.toggle(b,groups,groups[0],'history');
  assert.deepEqual(two.classSkills,['arcana','history']);
  assert.equal(draft.toggle(two,groups,groups[0],'insight'),null,'full');
  assert.deepEqual(draft.toggle(two,groups,groups[0],'arcana').classSkills,['history']);
  assert.equal(draft.toggle(b,groups,groups[0],'not-offered'),b);
  const feat=draft.toggle(b,groups,groups[5],'fire-bolt');
  assert.deepEqual(draft.selected(feat,groups[5].key),['light','fire-bolt']);
});

test('point buy stays within 8..15 and the budget; the suggestion follows the class and background',()=>{
  const b=draft.recommended({...draft.emptyBuild(catalog),classId:'wizard',backgroundId:'sage'},catalog);
  assert.deepEqual(b.baseScores,[8,14,14,15,12,8]);
  assert.equal(draft.pointSpent(b,catalog),27);
  assert.deepEqual(b.backgroundBonuses,[0,0,1,2,0,0],'+2 to Intelligence, +1 to Constitution');
  assert.equal(draft.canAdjust(b,catalog,0,1),false,'no points left');
  assert.equal(draft.canAdjust(b,catalog,0,-1),false,'8 is the floor');
  assert.equal(draft.canAdjust(b,catalog,3,1),false,'15 is the ceiling');
  assert.equal(draft.canAdjust(b,catalog,1,-1),true);
  const own={...b,baseScores:[10,10,10,10,10,10],backgroundBonuses:[0,0,1,1,1,0]};
  assert.deepEqual(draft.recommended(own,catalog),own,'values the player set are kept');
  assert.equal(draft.primaryAbility('wizard'),'int');
});

test('the wallet counts plans, pack choices and purchases; pages without choices are skipped',()=>{
  const b=built();
  let {items,remaining}=draft.owned(b,catalog);
  assert.equal(remaining,500);
  assert.deepEqual([...items],[['quarterstaff',1],['dagger',1]]);
  const bought=draft.purchase(b,groups,catalog,'dagger',1);
  assert.deepEqual(bought.purchases,[{id:'dagger',quantity:1}]);
  ({items,remaining}=draft.owned(bought,catalog));
  assert.equal(remaining,300);assert.equal(items.get('dagger'),2);
  assert.equal(draft.purchase({...b,classEquipment:''},groups,catalog,'dagger',1),null,'no coins');
  assert.deepEqual(draft.purchase(bought,groups,catalog,'dagger',-1).purchases,[]);
  assert.equal(draft.money(1234),'12 金币 3 银币 4 铜币');assert.equal(draft.money(0),'0 金币');assert.equal(draft.money(-50),'−5 银币');
  assert.equal(draft.applicable(3,[],null),false);
  assert.equal(draft.applicable(3,[],{issues:[{step:'choices'}]}),true);
  assert.equal(draft.applicable(4,groups,null),true);
  assert.equal(draft.applicable(5,[],null),true);
});

test('option and label names read in Chinese, keeping unknown text',()=>{
  assert.equal(optionName('$classSkills','arcana'),'奥秘');
  assert.equal(optionName('species:human/size','S'),'小型');
  assert.equal(ruleText('Human · 额外技能熟练'),'人类 · 额外技能熟练');
  assert.equal(ruleText('Humanoid · x'),'Humanoid · x','only whole names');
});

const origin='http://127.0.0.1:5180',T='a'.repeat(64),C='44444444-4444-4444-8444-444444444444';
const memory=()=>{const map=new Map();return{getItem:k=>map.get(k)??null,setItem:(k,v)=>map.set(k,String(v)),removeItem:k=>map.delete(k),map};};
const answer=(status,body)=>async()=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
const seat=token=>({accessToken:token,snapshot:{id:C,version:3,name:'雨港',character:{name:'阿岚'},party:{isHost:false,selfActorId:'p2'}}});

test('a join is written down first and only that request is retried until answered',async()=>{
  const storage=memory(),b={...built(),identity:{...built().identity,name:'阿岚'}};
  join.saveDraft(storage,{build:b,step:7});
  const request=join.beginJoin(storage,'12345678','pw',b);
  assert.match(request.accessToken,/^[a-f0-9]{64}$/);
  assert.throws(()=>join.beginJoin(storage,'12345678','pw',b),/还没有确认/);
  let sent=[];
  const via=reply=>createApi({fetchImpl:async(url,init)=>{sent.push([url,init.headers.Authorization,JSON.parse(init.body)]);return reply();}});
  for(const [status,body] of [[503,{code:'unavailable',message:'忙'}],[429,{code:'rate_limited',message:'稍后'}]]){
    await assert.rejects(join.sendJoin(via(answer(status,body)),storage,origin),e=>!e.cleared);
    assert.deepEqual(join.pendingJoin(storage),request);
  }
  // An answer that does not carry this request's seat is not a join.
  await assert.rejects(join.sendJoin(via(answer(200,seat('b'.repeat(64)))),storage,origin),/不匹配/);
  assert.ok(join.pendingJoin(storage));
  assert.ok(sent.every(([url,auth,body])=>url==='/api/v1/rooms/join'&&auth===undefined&&JSON.stringify(body)===JSON.stringify(request)),'the same body, no seat token');
  const {session}=await join.sendJoin(via(answer(200,seat(request.accessToken))),storage,origin);
  assert.deepEqual(session,{baseUrl:origin,campaignId:C,accessToken:request.accessToken});
  assert.equal(join.pendingJoin(storage),null);
  assert.equal(join.savedDraft(storage,catalog),null,'the submitted draft is done');
  assert.deepEqual(join.seats(storage,origin).map(s=>s.label),['阿岚 · 雨港']);
  assert.deepEqual(join.currentSeat(storage,origin),session);
});

test('a refused join can be changed and sent again; saved seats survive leaving',async()=>{
  const storage=memory(),b=built();
  join.beginJoin(storage,'12345678','wrong',b);
  const denied=createApi({fetchImpl:answer(401,{code:'room_access_denied',message:'房间号或密码不正确，或房间已关闭加入。'})});
  await assert.rejects(join.sendJoin(denied,storage,origin),e=>e.cleared&&/密码不正确/.test(e.message));
  assert.equal(join.pendingJoin(storage),null);
  assert.ok(join.beginJoin(storage,'12345678','right',b));
  const old={baseUrl:origin,campaignId:C,accessToken:T};
  join.rememberSeat(storage,origin,old,'米洛 · 雨港');
  join.leaveSeat(storage);
  assert.equal(join.currentSeat(storage,origin),null);
  assert.deepEqual(join.seats(storage,origin).map(s=>s.label),['米洛 · 雨港'],'leaving keeps the token');
  join.rememberSeat(storage,origin,old);
  assert.equal(join.seats(storage,origin)[0].label,'米洛 · 雨港','a later visit keeps the label');
  join.forgetSeat(storage,origin,old);
  assert.deepEqual([join.seats(storage,origin),join.currentSeat(storage,origin)],[[],null]);
  storage.setItem('dicerealm.play.join.v1','{bad');
  assert.throws(()=>join.pendingJoin(storage),/损坏/);
  assert.equal(join.savedDraft(storage,{revision:'other'}),null);
});

test('character window: one exact command per choice, effects under their section',async()=>{
  const {choiceRequest,preparations,effectSection}=await import('../src/play/character.js');
  const {prepare,requestPath}=await import('../src/api.js');
  const options=[{id:'shield'},{id:'sleep'},{id:'alarm'}];
  assert.deepEqual(choiceRequest('prepare','wizard',2,options,['sleep','shield']),{operation:'prepare',key:'wizard',value:1,choices:['shield','sleep']});
  assert.equal(choiceRequest('prepare','wizard',2,options,['sleep']),null,'exactly the listed count');
  assert.equal(choiceRequest('rest-choice','k',1,options,['fireball']),null,'only listed ids');
  const idle={available:false,reason:'不适用',count:0,maxChanges:0,options:[],selected:[],classId:''};
  assert.deepEqual(preparations({preparation:idle}),[],'a class without a list says nothing');
  const wizard={...idle,available:true,count:4,options,classId:'wizard'};
  assert.deepEqual(preparations({preparation:idle,classPreparations:[wizard]}),[wizard]);
  assert.deepEqual([{spellSource:'class:wizard'},{itemId:'potion'},{}].map(effectSection),['spells','inventory','status']);
  const body=prepare('character-command',{requestId:'r',expectedVersion:7,operation:'equip',key:'dagger',value:0,characterId:'c'});
  assert.deepEqual(body,{requestId:'r',expectedVersion:7,operation:'equip',key:'dagger',value:0,mode:'normal',choices:[]},'the local character id is not sent');
  assert.equal(requestPath('character-command',{campaignId:'x'},body),'/api/v1/campaigns/x/character/commands');
});

test('growth draft: groups are answered in order and a subclass starts over',async()=>{
  const growth=await import('../src/play/growth.js');
  const draft=growth.newDraft({build:{revision:'r1',classId:'wizard'}});
  assert.deepEqual(draft,{revision:'r1',classId:'wizard',subclassId:'',selections:[]});
  const g=(key,count,ids)=>({key,count,selected:[],options:ids.map(id=>({id,label:id}))});
  const groups=[g('spellbook',2,['a','b','c']),g('cantrip',1,['x','y'])];
  let step=growth.select(draft,groups,groups[1],'x');
  step=growth.select(step.draft,groups,groups[0],'a');
  assert.deepEqual(step.draft.selections,[{key:'spellbook',values:['a']}],'a changed earlier answer drops the later one');
  assert.deepEqual(step.groups.map(x=>x.key),['spellbook']);
  step=growth.select(step.draft,step.groups,groups[0],'b');
  assert.equal(growth.select(step.draft,step.groups,groups[0],'c'),null,'full');
  const sub=growth.select(step.draft,step.groups,g('subclass',1,['evoker']),'evoker');
  assert.deepEqual([sub.draft.subclassId,sub.draft.selections],['evoker',[]]);
  assert.deepEqual(growth.chooseClass(sub.draft,'fighter'),{revision:'r1',classId:'fighter',subclassId:'',selections:[]});
});

test('a returned character goes back with a note, and a rebuild carries its full build and name', async ()=>{
  const {prepare,requestPath,seatMutations,versioned}=await import('../src/api.js');
  assert.ok(seatMutations.has('character/resubmit')&&versioned.has('character/resubmit'),'a seat sends it, at the snapshot version');
  const keep=prepare('character/resubmit',{requestId:'r',expectedVersion:9,revision:2,submission:'补充了背景故事'});
  assert.deepEqual(keep,{requestId:'r',expectedVersion:9,revision:2,submission:'补充了背景故事',characterName:'',templateId:''},'the character stays');
  assert.equal(requestPath('character/resubmit',{campaignId:'x'},keep),'/api/v1/campaigns/x/character/resubmit');
  const build={...draft.emptyBuild({ruleset:'dnd2024',revision:'r1'}),classId:'wizard',identity:{name:'米洛',pronouns:'',appearance:'',personality:'',backstory:'',alignment:'neutral'}};
  const rebuilt=prepare('character/resubmit',{requestId:'r',expectedVersion:9,revision:2,submission:'改成法师',build});
  assert.equal(rebuilt.characterName,'米洛','the name is the build\'s own');
  assert.equal(rebuilt.build.classId,'wizard');
  assert.equal(rebuilt.templateId,'');
});

test('known places: here first, then where a route leads, each with the server note or the travel reason', async ()=>{
  const {placeRows}=await import('../src/play/places.js');
  const map={title:'雾港',nodes:[
    {id:'old',title:'旧仓库',state:'discovered',hint:'已知地点 · 当前没有直达路线'},
    {id:'dock',title:'码头',state:'visited',hint:'已探索 · 请先返回相邻地点'},
    {id:'tower',title:'灯塔',state:'discovered',canTravel:true,hint:'可沿当前路线前往'},
    {id:'here',title:'广场',state:'current',hint:'你在这里'},
    {id:'gate',title:'城门',state:'visited',canTravel:true,hint:'可沿当前路线前往'}]};
  const travel=new Map([['tower',{target:'tower',available:true,reason:''}],['gate',{target:'gate',available:false,reason:'等待投掷'}]]);
  const rows=placeRows(map,travel);
  assert.deepEqual(rows.map(r=>[r.id,r.rank]),[['here','current'],['tower','travel'],['gate','travel'],['dock','visited'],['old','discovered']]);
  assert.equal(rows[2].note,'暂不能前往：等待投掷','a blocked route says why');
  assert.equal(rows[1].note,'可沿当前路线前往');
  assert.equal(rows[0].go,null,'no travel to where you are');
  assert.deepEqual(placeRows(null,new Map()),[]);
});

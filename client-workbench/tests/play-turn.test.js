// Player page turn rules: what may be sent, when the page may continue on its own, and what the notice bar asks.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import * as turn from '../src/play/turn.js';
import {health,numeral,noticeModel,partyModel,goalModel} from '../src/play/model.js';
import {currentSceneMap} from '../src/play/map.js';
import {prepare,requestPath,createApi} from '../src/api.js';

const S1='11111111-1111-4111-8111-111111111111',S2='22222222-2222-4222-8222-222222222222',B='33333333-3333-4333-8333-333333333333';
const snap=(over={})=>({id:'c',version:5,timelineId:'',party:{selfActorId:'me',members:[{id:'me',character:{name:'米洛'},review:{status:'approved'}}]},events:[],pendingRulings:[],...over});
const view=(over={})=>({sessionId:S1,phase:'done',question:'',confirmation:null,outcome:'',notice:'',actionText:'推门',replayed:false,...over});
const ready=(over={})=>({snapshot:snap(),mode:'business',ready:true,session:null,active:[],...over});
const rollWait=(over={})=>view({phase:'needsConfirmation',confirmation:{kind:'roll',waitId:'r1',prompt:''},...over});

test('a new action is sent only when nothing of the player waits',()=>{
  assert.equal(turn.canSend(ready()),true);
  assert.equal(turn.canSend(ready({mode:'unknown'})),false,'the action board must be read first');
  assert.equal(turn.canSend(ready({snapshot:snap({pendingIntent:{id:'i'}})})),false);
  assert.equal(turn.canSend(ready({active:[view({sessionId:S2,phase:'working'})]})),false,'another own action still blocks');
  assert.equal(turn.canSend(ready({session:view({phase:'working'})})),false);
  assert.equal(turn.canSend(ready({session:view({phase:'needsAnswer',question:'哪扇门？'})})),true);
  const unapproved=snap({party:{selfActorId:'me',members:[{id:'me',character:{name:'米洛'},review:{status:'pending'}}]}});
  assert.equal(turn.canSend(ready({snapshot:unapproved})),false);
  assert.match(turn.lifecycleNotice(unapproved),/等待 DM 审核/);
  assert.match(turn.lifecycleNotice(snap({lifecycle:{canAct:false,status:'game_over'}})),/游戏结束/);
});

test('the composer turns text into exactly one request, or says why not',()=>{
  assert.deepEqual(turn.composerRequest(ready(),'  我推开\n门 '),{endpoint:'adventure-act',payload:{text:'我推开 门'}});
  assert.match(turn.composerRequest(ready(),'   ').message,/先写下/);
  const answer=view({phase:'needsAnswer',question:'哪扇门？'});
  assert.deepEqual(turn.composerRequest(ready({session:answer}),'左边'),{endpoint:'adventure-continue',payload:{sessionId:S1,text:'左边'}});
  const lost=view({phase:'unconfirmed',actionText:'推门'});
  assert.match(turn.composerRequest(ready({session:lost}),'推门').message,/不能按相同原文补发/);
  assert.equal(turn.composerRequest(ready({session:lost}),'翻窗').endpoint,'adventure-act');
  // Roll consent: only the two words count; a stale wait can only be cancelled.
  const roll={id:'r1',version:5,available:true,label:'察觉'};
  const waiting=ready({snapshot:snap({pendingRoll:roll}),session:rollWait()});
  assert.deepEqual(turn.composerRequest(waiting,'投掷'),{endpoint:'rolls/respond',payload:{rollId:'r1',decision:'roll'}});
  assert.deepEqual(turn.composerRequest(waiting,'取消'),{endpoint:'rolls/respond',payload:{rollId:'r1',decision:'cancel'}});
  assert.match(turn.composerRequest(waiting,'好').message,/投掷/);
  const stale=ready({snapshot:snap({pendingRoll:{...roll,version:4,reason:'情况已变化'}}),session:rollWait()});
  assert.equal(turn.composerRequest(stale,'投掷').message,'情况已变化');
  assert.equal(turn.composerRequest(stale,'取消').payload.decision,'cancel');
  // Entering the scene needs no text and only starts when nothing else is open.
  const opening=snap({opening:{needed:true}});
  assert.deepEqual(turn.composerRequest(ready({snapshot:opening}),''),{endpoint:'adventure-opening',payload:{}});
  assert.ok(turn.composerRequest(ready({snapshot:opening,active:[view({phase:'working'})]}),'') instanceof Error);
});

test('the page continues on its own only after an exact saved result, once per result',()=>{
  const session=rollWait();
  assert.equal(turn.canAutoContinue(session,snap({pendingRoll:{id:'r1'}})),false,'still waiting');
  assert.equal(turn.canContinue(session,snap()),true,'a vanished wait may be resumed by hand');
  assert.equal(turn.canAutoContinue(session,snap()),false,'but a vanished wait is not proof of a result');
  const rolled=snap({events:[{sequence:9,resolution:{rollId:'r1',check:{total:14}}}]});
  assert.equal(turn.canAutoContinue(session,rolled),true);
  assert.equal(turn.autoContinueKey(session,rolled),S1+'/roll/r1');
  const intent=view({phase:'needsConfirmation',confirmation:{kind:'intent',waitId:'i1',prompt:''}});
  const first=snap({events:[{sequence:3,resolution:{intentId:'i1',status:'awaiting_roll'}}]});
  const later=snap({events:[{sequence:3,resolution:{intentId:'i1',status:'awaiting_roll'}},{sequence:7,resolution:{intentId:'i1',status:'resolved'}}]});
  assert.notEqual(turn.autoContinueKey(intent,first),turn.autoContinueKey(intent,later),'each saved step of one intent continues once');
  assert.equal(turn.canAutoContinue(rollWait(),snap({lifecycle:{canAct:false}})),false);
});

test('a DM-requested roll is consented only through its exact public receipt',()=>{
  const ruling=view({phase:'needsConfirmation',confirmation:{kind:'ruling',waitId:'u1',prompt:''}});
  const base={pendingRoll:{id:'r9'},pendingRulings:[{id:'u1',status:'awaiting_roll'}]};
  assert.equal(turn.canConfirmRoll(ruling,snap(base)),false);
  assert.equal(turn.canConfirmRoll(ruling,snap({...base,events:[{resolution:{rulingId:'u1',rollId:'r9'}}]})),true);
  assert.equal(turn.canConfirmRoll(null,snap({pendingRoll:{id:'r2',battleSessionId:B}})),true,'a battle group wait is confirmed by its own id');
  // A teammate started the fight: this seat's own last action ended long before and does not block it;
  // an own action still running in another battle does.
  assert.equal(turn.canConfirmRoll(view({phase:'done'}),snap({pendingRoll:{id:'r2',battleSessionId:B}})),true);
  assert.equal(turn.canConfirmRoll(view({phase:'working',battleSessionId:'44444444-4444-4444-8444-444444444444'}),snap({pendingRoll:{id:'r2',battleSessionId:B}})),false);
  // A roll of a server choice the page proposed itself (a hit die after a rest) is this seat's own.
  const own=(kind,actorId='me',intentId='')=>snap({pendingRoll:{id:'r3'},events:[{kind:'roll.request',actorId,origin:{requestedKind:kind},resolution:{rollId:'r3',status:'awaiting_roll',intentId}}]});
  assert.equal(turn.canConfirmRoll(null,own('rest.hit_die')),true);
  assert.equal(turn.canConfirmRoll(null,own('combat.attack')),true);
  assert.equal(turn.canConfirmRoll(null,own('observe')),false,'a session action is confirmed through its session');
  assert.equal(turn.canConfirmRoll(null,own('rest.hit_die','someone-else')),false);
  assert.equal(turn.canConfirmRoll(null,own('rest.hit_die','me','i1')),false,'a roll tied to an intent waits for it');
});

test('a finished battle action hands the view back to its exploration action',()=>{
  const combat=view({sessionId:S2,role:'combat',phase:'done',parentSessionId:S1,battleSessionId:B});
  const parent=view({role:'exploration',phase:'delegated',battleSessionId:'44444444-4444-4444-8444-444444444444'});
  assert.equal(turn.needsBattleParent(combat,[]),true);
  assert.equal(turn.shouldFollowBattleParent(combat,parent),true);
  const next=view({sessionId:'55555555-5555-4555-8555-555555555555',role:'combat',phase:'working',battleSessionId:B});
  assert.equal(turn.needsBattleParent(combat,[next]),false,'another combat action of the battle still waits');
  assert.equal(turn.selectBattleInput(null,[next]),next);
});

test('the notice bar asks for the most urgent thing first',()=>{
  const roll={id:'r1',version:5,available:true,label:'察觉检定'};
  const t=ready({snapshot:snap({pendingRoll:roll}),session:rollWait()});
  assert.equal(noticeModel(t,{pending:true}).act,'retry','an unconfirmed request blocks everything else');
  assert.deepEqual(noticeModel(t),{tone:'roll',label:'等待投掷',text:'察觉检定',action:'投掷',act:'roll'});
  // A spell's roll names its source as the player knows it, not by the rule id.
  const spell=ready({snapshot:snap({pendingRoll:{...roll,label:'Acid Splash / 中心(4,3)（class:wizard）'}}),session:rollWait()});
  assert.equal(noticeModel(spell).text,'酸液飞溅 / 中心(4,3)（法师）');
  // Own consent to a party start is given; the server holds the roll until everyone has.
  const held={...roll,available:false,reason:'你已确认，等待其他队员确认。'};
  assert.deepEqual(noticeModel(ready({snapshot:snap({pendingRoll:held}),session:rollWait()})),
    {tone:'idle',label:'等待投掷',text:'你已确认，等待其他队员确认。',action:'查看',act:'roll'});
  // The question stands whole under the story; the bar points to the input and offers a quiet way out.
  assert.deepEqual(noticeModel(ready({session:view({phase:'needsAnswer',question:'哪扇门？'})})),
    {tone:'turn',label:'需要回答',text:'在输入框写下你的回答，队友也会看到',action:'放弃这次行动',act:'stop',quiet:true});
  assert.equal(noticeModel(ready(),{recovery:true}).act,'continue');
  assert.equal(noticeModel(ready({active:[view(),view({sessionId:S2})]})).act,'sessions');
  const fight=c=>ready({snapshot:snap({combat:{status:'active',round:2,activeActorId:c,units:[{id:'g',name:'哥布林'}]}})});
  assert.equal(noticeModel(fight('me')).label,'轮到你行动');
  assert.equal(noticeModel(fight('g')).text,'哥布林 正在行动');
  assert.equal(noticeModel(ready()),null);
});

test('party, goal, chapter numerals and the current map follow the snapshot',()=>{
  assert.deepEqual(['完好','轻伤','重伤','濒危','倒地','伤势未明'],[health(10,10),health(6,10),health(5,10),health(2,10),health(0,10),health(undefined,10)]);
  assert.deepEqual([numeral(3),numeral(10),numeral(12),numeral(40),numeral(47)],['三','十','十二','四十','四十七']);
  const s=snap({party:{selfActorId:'me',members:[{id:'me',character:{name:'米洛',hitPoints:7,maxHitPoints:12,conditions:['Dead']}},{id:'x',revoked:true,character:{name:'走了'}}]}});
  const [me]=partyModel(s);
  assert.equal(partyModel(s).length,1);assert.equal(me.self,true);assert.equal(me.health,'死亡');assert.deepEqual(me.tags,[]);
  assert.equal(goalModel(snap()),null);
  assert.deepEqual(goalModel(snap({world:{quests:[{status:'active',title:'找到灯塔守',summary:' 守灯人失踪三天。 ',objectives:[{text:'找到守灯人',complete:true},{text:'带他回港',complete:false}]}]},facts:[1,2,3]})),
    {title:'找到灯塔守',sub:'目标 1/2 · 已知线索 3',summary:'守灯人失踪三天。',objectives:[{text:'找到守灯人',done:true},{text:'带他回港',done:false}]});
  // A finished quest stays in view until another starts.
  const done=(t,status='completed')=>({status,title:t,objectives:[{text:t,complete:true}]});
  assert.deepEqual(goalModel(snap({world:{quests:[done('寻人'),done('送信'),done('未接','available')]}})),{title:'送信',sub:'已完成',summary:'',objectives:[{text:'送信',done:true}]});
  assert.equal(goalModel(snap({world:{quests:[done('寻人'),{status:'active',title:'下一程',objectives:[]}]}})).title,'下一程');
  const m=(id,over={})=>({id,published:true,edition:'player',status:'ready',currentScene:true,...over});
  assert.equal(currentSceneMap({maps:[m('gm',{edition:'gm'}),m('old',{currentScene:false}),m('a'),m('b')]}).id,'a');
  assert.equal(currentSceneMap({selectedMapId:'b',maps:[m('a'),m('b')]}).id,'b');
  assert.equal(currentSceneMap({selectedMapId:'old',maps:[m('old',{currentScene:false})]}),null,'a selected map of another place is not shown');
});

test('entering the scene is a seat command with only its identity and frozen version',async()=>{
  assert.deepEqual(prepare('adventure-opening',{requestId:S1,expectedVersion:4,text:'ignored'}),{requestId:S1,expectedVersion:4});
  assert.equal(requestPath('adventure-opening',{campaignId:'c'}),'/api/v1/campaigns/c/adventure/opening');
  let body;
  const api=createApi({fetchImpl:async(path,options)=>{body=JSON.parse(options.body);return {ok:true,text:async()=>JSON.stringify(view({sessionId:S2,opening:true,phase:'working'}))};}});
  await assert.rejects(api.request('adventure-opening',{campaignId:'c',accessToken:'t'},{requestId:S1,expectedVersion:4}),/编号不匹配/,'the receipt must be this request');
  assert.deepEqual(body,{requestId:S1,expectedVersion:4});
});

test('the player page module graph links',async()=>{
  const entry=new URL('../src/play/main.js',import.meta.url);
  const source=await readFile(entry,'utf8');
  for(const specifier of new Set([...source.matchAll(/\bfrom\s+'(\.[^']+)'/g)].map(m=>m[1])))
    await assert.doesNotReject(()=>import(new URL(specifier,entry).href),'模块链接失败：'+specifier);
  const html=await readFile(new URL('../play.html',import.meta.url),'utf8');
  assert.match(html,/src="\.\/src\/play\/main\.js"/);
});

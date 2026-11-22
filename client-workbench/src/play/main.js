// Player page (/play/): one seat's adventure in the browser. The server owns every rule and result;
// this page reads the seat's snapshot and actions, shows them, and sends one durable request at a
// time. An unconfirmed request is only ever retried as-is (docs/adventure-sessions.md).
import {createApi,newUuid} from '../api.js';
import {createPendingStore} from '../pending.js';
import {createStoryFeed} from '../story.js';
import {createDialogHost} from '../workspace-dialog.js';
import {renderWorld} from '../world.js';
import {createCharacterWindow} from './character.js';
import {createResubmit} from './resubmit.js';
import {createScreen} from './screen.js';
import {createCard} from './card.js';
import {createMapPane} from './map.js';
import {combatView,respondModel,reviewEntries,offeredChoices,createCombatBar} from './combat.js';
import * as turn from './turn.js';
import {showEntrance} from './entrance.js';
import {rememberSeat,currentSeat,leaveSeat} from './join.js';
import {bookModel,chapterModel,partyModel,goalModel,noticeModel} from './model.js';

const POLL_MS=2500;
// What the character window says after the server settled one of its commands.
const CHARACTER_DONE={equip:'装备已更新。',loadout:'装备已更新。',wear:'装备已更新。',unpack:'套装内容已放入背包。',
  attunement:'同调已更新。',prepare:'准备清单已更新。','rest-choice':'休息选择已记录。'};
const root=document.getElementById('play'),origin=location.origin,storage=localStorage,api=createApi();
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const readJson=key=>{try{return JSON.parse(storage.getItem(key)||'null');}catch{return null;}};

const showConnect=(message='')=>showEntrance(root,{api,storage,origin,start},message);

async function start(connection){
  let pending,snapshot;
  try{
    pending=await createPendingStore({storage,session:connection});
    snapshot=await api.request('snapshot',connection);
    rememberSeat(storage,origin,connection,[snapshot.character?.name,snapshot.name].filter(Boolean).join(' · '));
  }catch(error){
    showConnect((error.status===401||error.status===404?'这个席位已无法访问：':'暂时无法连接：')+error.message);
    return;
  }
  play(connection,pending,snapshot);
}

function play(connection,pending,first){
  let snapshot=first,alive=true,mode='unknown',ready=false,session=null,active=[],adventureNotice='正在读取本人行动…',othersActing=[];
  let readGeneration=0,sending=false,status='',offline=false,refreshing=null,library=null;
  // targeting: 'attack' or 'missile' (Magic Missile allocation, one missile per click on the map).
  let openingAttempted=false,openingError='',autoAttempt='',sentText=null,targeting=null,picking=null,returnedFailure='';
  const seenRolls=new Set(),seenIntents=new Set(),seenWaits=new Set();
  const draftKey='dicerealm.play.draft.'+pending.scope,stateKey='dicerealm.play.adventure.'+pending.scope;
  const timeline=()=>snapshot.timelineId??'';
  const ctx={get snapshot(){return snapshot;},read:(endpoint,payload)=>api.request(endpoint,connection,payload),
    hasPending:()=>!!pendingRecord(),sharedAcknowledgements:new Set()};

  function newFeed(){return createStoryFeed(ctx,{isDisposed:()=>!alive,player:true});}
  let feed=newFeed();
  const bar=createCombatBar({onGroup:pickGroup});
  const screen=createScreen({feed:feed.element,combat:bar.element,onSend:submit,onDraft:saveDraft,onNotice:noticeAction,
    onCharacter:section=>character.show(section),onJournal:openJournal,onMap:openMap,
    onQuick:option=>review(option.kind==='rest.recover'?'起身':'短休之后',[option]),
    onResubmit:()=>{const review=turn.ownReview(snapshot);if(review?.status==='returned')resubmit.open(snapshot,review);},onDisconnect:disconnect});
  const dialogs=createDialogHost(screen.element);
  const resubmit=createResubmit({dialogs,read:ctx.read,send:payload=>void command('character/resubmit',payload)});
  const character=createCharacterWindow({dialogs,read:ctx.read,snapshot:()=>snapshot,busy:()=>sending||!!pendingRecord(),status:()=>status,
    send:(endpoint,payload)=>{if(snapshot.character)void command(endpoint,endpoint==='character-command'?{...payload,characterId:snapshot.character.id}:payload);}});
  const card=createCard(screen.map,{
    onRoll:()=>respondRoll('roll'),onCancelRoll:()=>respondRoll('cancel'),
    onChoose:optionId=>respondIntent('choose',optionId),onRuling:()=>respondIntent('ruling'),onCancelIntent:()=>respondIntent('cancel'),
    onSelect:selectSession,onAction:choose});
  const map=createMapPane(screen.mapSlot,{read:ctx.read,onMove:act,onTarget:(id,options)=>targeting==='missile'?allocate(options[0]):aim(options),onPick:pickCentre,
    onTravel:option=>review('前往',[option])});
  root.replaceChildren(screen.element);
  screen.input.value=storage.getItem(draftKey)||'';
  feed.mounted();void feed.loadLatest(snapshot.version,{live:false});
  document.addEventListener('keydown',onKey);

  function pendingRecord(){
    try{return pending.read();}
    catch(error){status=error.message;return {endpoint:'',payloadJson:'{}',corrupt:true};}
  }
  function saveDraft(text){
    try{storage.setItem(draftKey,text);}catch{/* The text stays in the input. */}
    // A message about the last attempt is stale once the player writes again.
    if(status&&!sending){status='';render();}
  }
  const turnState=()=>({snapshot,mode,ready,session,active});
  const recovery=()=>turn.canContinue(session,snapshot)&&(!turn.canAutoContinue(session,snapshot)||autoAttempt===turn.autoContinueKey(session,snapshot)&&!sending&&!pendingRecord());

  // Teammates whose action the host is on now (from the adventure board), by name.
  function othersNote(){
    if(!othersActing.length)return '';
    const names=othersActing.map(id=>snapshot.party?.members?.find(m=>m.id===id)?.character?.name).filter(Boolean);
    return '主持正在回应'+(names.length?names.join('、'):'其他行动')+'…';
  }
  function render(){
    if(!alive)return;
    const t=turnState(),record=pendingRecord(),closed=mode==='legacy'?'这个战役使用旧的行动方式，网页暂不支持，请用 Unity 客户端继续。':turn.lifecycleNotice(snapshot);
    const opening=turn.openingNeeded(snapshot),sendable=opening?turn.canStartOpening(t):turn.canSend(t);
    const sessionNote=['failed','unconfirmed','stopped'].includes(session?.phase)
      ?session.notice||session.outcome||(session.phase==='failed'?'主持没能处理这次行动，原话已放回输入框，可以再发一次。':''):'';
    // What this seat just sent stays readable while the host works on it (the record comes later).
    feed.setOwnAction(session?.actionId&&session.actionText&&!['failed','stopped','blocked'].includes(session.phase)
      ?{actorId:snapshot.party?.selfActorId||'',actionId:session.actionId,input:session.actionText}:null);
    screen.update({
      book:bookModel(snapshot),chapter:chapterModel(snapshot),party:partyModel(snapshot),goal:goalModel(snapshot),
      thinking:sending||['working','stopping'].includes(session?.phase),others:othersNote(),
      ask:session?.phase==='needsAnswer'?session.question||'':'',
      status:offline?'连接中断，正在重试…':status||adventureNotice||sessionNote||'',
      notice:noticeModel(t,{pending:!!record,sending,recovery:recovery()}),busy:sending,
      composer:{closed,quick:snapshot.combat?.status==='active'?[]:offeredChoices(snapshot,a=>a.kind.startsWith('rest.')),resubmit:turn.ownReview(snapshot)?.status==='returned'&&!sending&&!record,editable:!sending&&!opening,canSend:!sending&&!record&&sendable,needsText:!opening,
        word:opening?'开场':session?.phase==='needsAnswer'?'回答':'发送',
        placeholder:opening?'入场开场由主持生成，点「开场」开始':turn.canConfirmRoll(session,snapshot)&&snapshot.pendingRoll.available!==false?'输入“投掷”或“取消”':session?.phase==='needsAnswer'?'回答主持的问题（队友也会看到回答）':'写下你想做的事'}
    });
    // Combat buttons wait while anything else is open: a request, a roll or choice, or the host's narration.
    const view=combatView(snapshot),held=sending||!!record||!!snapshot.pendingRoll||!!snapshot.pendingIntent
      ||!turn.lifecycleAllowsActions(snapshot)||active.some(s=>s.phase==='working');
    const wait=respondModel(snapshot),missiles=missileTargets(wait);
    // Missile allocation outlives each click's request; once nothing is left to place (or the wait
    // ends) it hands back to the response card, which then offers the cast.
    if(targeting==='missile'){if(!missiles.size&&!held){targeting=null;const next=respondCard();if(next)card.show(next);}}
    else if(!view?.mine||held){targeting=null;picking=null;}
    // Re-read the centres from the current list; a spell that is no longer offered ends the picking.
    else if(picking)picking=reviewEntries(view.groups.find(g=>g.kind===picking.kind)?.options||[]).find(e=>e.pick&&e.label===picking.label)||null;
    const aiming=targeting==='attack'?{hint:'选择攻击目标 · Esc 取消',verb:'攻击',targets:view.attacks,foes:true}
      :targeting==='missile'?{hint:(wait?.why.split(/[；。]/)[0]||'Magic Missile')+' · 点击目标分配一枚 · Esc 回到卡片',verb:'分配一枚飞弹',targets:missiles,foes:false}:null;
    bar.update(view,{busy:held,targeting:targeting==='attack',picking:!!picking});map.combat(view,{busy:held,targeting:aiming,picking});
    map.travel(new Map(offeredChoices(snapshot,a=>a.kind==='travel').map(o=>[o.target,o])),held,snapshot.map);
    character.update();
  }
  function openMap(open=!screen.mapOpen){screen.openMap(open);map.reframe(open);}
  // The seat's quests, people, places and clues: the workbench world record, read-only for a player.
  function openJournal(){
    const world={get snapshot(){return snapshot;},read:ctx.read,scope:pending.scope,hasPending:()=>!!pendingRecord(),
      refresh:()=>refresh(),report:error=>{status=error.message;render();}};
    dialogs.open({title:'冒险手记',wide:true,render:({body})=>renderWorld(body,world,{head:false})});
  }

  // GET only. A same-version snapshot can still carry newer action progress, so actions are always re-read.
  function refresh(){
    refreshing??=(async()=>{
      try{
        const value=await api.request('snapshot',connection);
        if(!alive)return;
        offline=false;
        if(JSON.stringify(value)!==JSON.stringify(snapshot))apply(value);
        await readAdventure();
        await readMaps();
        afterRead();
      }finally{refreshing=null;}
    })();
    return refreshing;
  }
  function apply(value){
    const rewound=(value.timelineId??'')!==timeline()||value.version<snapshot.version;
    snapshot=value;
    if(rewound){
      // A load or restart replaces history: rebuild the feed rather than appending to the old one.
      const old=feed.element;old.dispatchEvent(new Event('dispose'));
      feed=newFeed();old.replaceWith(feed.element);feed.mounted();session=null;
      void feed.loadLatest(snapshot.version,{live:false});
    }else void feed.loadLatest(snapshot.version);
    render();
  }
  async function readAdventure(){
    if(mode==='legacy')return;
    const generation=++readGeneration,current=()=>alive&&generation===readGeneration;
    try{
      let board;
      try{board=await api.request('adventure',connection);}
      catch(error){
        // Only this explicit answer marks an old campaign; a network failure never does.
        if(error.status===409&&error.code==='harness_campaign_required'){if(current()){mode='legacy';ready=true;session=null;active=[];adventureNotice='';}return;}
        throw error;
      }
      if(!current())return;
      const list=board.sessions,saved=readJson(stateKey);
      const id=session?.sessionId??(saved?.timelineId===timeline()?saved.sessionId:'');
      let selected=list.find(s=>s.sessionId===id)||null,note='';
      if(!selected&&id){
        try{selected=await api.request('adventure-session',connection,{sessionId:id});}
        catch(error){if(error.status!==404)throw error;note='先前行动暂不可读；不会重新发送原意图。';}
        if(!current())return;
      }
      if(turn.needsBattleParent(selected,list)){
        const parent=list.find(s=>s.sessionId===selected.parentSessionId)||await api.request('adventure-session',connection,{sessionId:selected.parentSessionId});
        if(!current())return;
        if(turn.shouldFollowBattleParent(selected,parent))selected=parent;
      }
      selected=turn.selectBattleInput(selected,list);
      if(!selected&&list.length===1)selected=list[0];
      if(!selected&&!list.length&&!note)note=turn.openingNeeded(snapshot)
        ?openingAttempted&&openingError?'开场没有生成：'+openingError+' 可点「开场」再试一次。':''
        :turn.canAct(snapshot)?'写下你想做的事，开始下一步行动。':'';
      if(selected?.opening&&selected.phase==='unconfirmed'&&turn.openingNeeded(snapshot))
        note='原开场的生成结果未确认，没有已保存的入场补充。可以稍后再读取；点「开场」会发起新的生成。';
      if(selected&&saved?.sessionId!==selected.sessionId)storage.setItem(stateKey,JSON.stringify({timelineId:timeline(),sessionId:selected.sessionId}));
      mode='business';ready=true;session=selected;active=list;adventureNotice=note;othersActing=board.othersActing||[];
      // A run that failed took the player's words with it; they go back into an empty box once.
      if(selected?.phase==='failed'&&selected.actionText&&returnedFailure!==selected.sessionId){
        returnedFailure=selected.sessionId;
        if(!screen.input.value.trim()){screen.input.value=selected.actionText;saveDraft(selected.actionText);}
      }
    }catch{
      if(!current())return;
      ready=false;othersActing=[];adventureNotice='暂时无法读取本人行动，稍后会自动重试。当前结果与草稿已保留。';
    }
  }
  async function readMaps(){
    try{library=await api.request('maps',connection);}catch{return;}
    if(alive)void map.update(library);
  }
  // After every read: start the opening once, continue after an exact saved result once, offer consent.
  function afterRead(){
    if(!alive)return;
    const t=turnState(),record=pendingRecord();
    if(!sending&&!record&&!openingAttempted&&!session&&turn.canStartOpening(t)){
      openingAttempted=true;void command('adventure-opening',{});
    }else if(!sending&&!record&&mode==='business'&&ready&&turn.canAct(snapshot)&&!snapshot.archived&&turn.canAutoContinue(session,snapshot)){
      const key=turn.autoContinueKey(session,snapshot);
      if(autoAttempt!==key){autoAttempt=key;void command('adventure-continue',{sessionId:session.sessionId});}
    }
    syncCard();render();
  }
  function rollCard(){
    const roll=snapshot.pendingRoll,stale=!roll.available||roll.version!==snapshot.version;
    return {kind:'roll',roll,ready:!stale&&turn.canConfirmRoll(session,snapshot),busy:sending||!!pendingRecord(),note:stale?roll.reason||'投掷条件已变化，可以明确放弃后重新描述。':''};
  }
  function intentCard(){
    const intent=snapshot.pendingIntent,stale=!intent.available||intent.version!==snapshot.version;
    return {kind:'intent',intent,canChoose:!stale&&turn.lifecycleAllowsActions(snapshot)&&turn.matchesConfirmation(session,snapshot,'intent',intent.id),
      busy:sending||!!pendingRecord(),note:stale?intent.reason||'情况已变化，可以放弃后重新描述。':''};
  }
  // The battle's wait for this seat; a roll or choice in progress comes first.
  function respondCard(){
    const wait=respondModel(snapshot);
    if(!wait?.options.length||snapshot.pendingRoll||snapshot.pendingIntent)return null;
    return {kind:'actions',respond:true,key:wait.key,title:wait.title,why:wait.why,options:respondOptions(wait),busy:sending||!!pendingRecord(),version:snapshot.version};
  }
  // Magic Missile's targets as the server offers them: "one/<unit id>" places one missile there.
  function missileTargets(wait){
    const targets=new Map();
    for(const o of wait?.options||[])if(o.kind==='combat.missile_allocate'&&o.target.startsWith('one/'))targets.set(o.target.slice(4),[o]);
    return targets;
  }
  // While missiles are left to place, the response card also offers placing them on the map.
  function respondOptions(wait){
    return missileTargets(wait).size?[{kind:'map.missile',target:'',label:'在地图上点选目标',pick:true,available:true,reason:'',
      details:{targetLabel:'每次点击分配一枚；分配完回到这张卡确认施放'}},...wait.options]:wait.options;
  }
  // Own consent and a battle's wait open once by themselves; afterwards only the notice bar reopens
  // them. A response card stays open through several edits (missile allocation) until the wait ends,
  // and follows the battle into the next wait for this seat (Shield passed, then a concentration save).
  function syncCard(){
    const view=card.view,roll=snapshot.pendingRoll,intent=snapshot.pendingIntent,wait=respondModel(snapshot);
    if(view?.kind==='roll')roll?.id===view.roll.id?card.show(rollCard()):card.hide();
    else if(view?.kind==='intent')intent?.id===view.intent.id?card.show(intentCard()):card.hide();
    else if(view?.kind==='sessions'&&session)card.hide();
    else if(view?.kind==='actions'&&view.respond){
      // While the narration of an edit runs the server lists no choices: keep the card, paused.
      const busy=sending||!!pendingRecord()||!wait?.options.length,same=wait?.key===view.key;
      if(!wait||roll||intent)card.hide();
      else if(!same||view.version!==snapshot.version||view.busy!==busy){
        seenWaits.add(wait.key);
        card.show({...view,key:wait.key,title:wait.title,why:wait.why,options:wait.options.length||!same?respondOptions(wait):view.options,busy,version:snapshot.version});
      }
    }else if(view?.kind==='actions'&&view.version!==snapshot.version)card.hide();
    if(card.view)return;
    if(roll&&turn.canConfirmRoll(session,snapshot)&&!seenRolls.has(roll.id)){
      // A death save comes as a roll with its wait; cancelling the roll must not pop the wait up again.
      seenRolls.add(roll.id);if(wait)seenWaits.add(wait.key);card.show(rollCard());
    }else if(intent&&turn.matchesConfirmation(session,snapshot,'intent',intent.id)&&!seenIntents.has(intent.id)){seenIntents.add(intent.id);card.show(intentCard());}
    else if(wait&&!seenWaits.has(wait.key)){const next=respondCard();if(next){seenWaits.add(wait.key);card.show(next);}}
  }

  // Freeze identity and version once, keep the request durable, then send it.
  async function command(endpoint,payload,text=null){
    if(pendingRecord()){status='上一请求尚未确认，请先点「重试」。';render();return;}
    const frozen=endpoint==='adventure-stop'?payload:{...payload,requestId:newUuid(),expectedVersion:snapshot.version};
    if(endpoint==='adventure-continue'&&frozen.text===undefined)frozen.text='';
    pending.capture(endpoint,frozen,{timelineId:timeline()});
    sentText=text;
    await send();
  }
  async function send(){
    const record=pendingRecord();
    if(!record||record.corrupt||sending)return;
    const payload=JSON.parse(record.payloadJson);
    sending=true;status='正在确认本次行动…';render();
    try{
      const data=await api.request(record.endpoint,connection,payload,{timelineId:record.timelineId??''});
      if(!alive)return;
      pending.complete();status='';
      if(sentText!=null&&turn.normalizeText(screen.input.value)===sentText){screen.input.value='';saveDraft('');}
      sentText=null;
      if(record.endpoint.startsWith('adventure-')){
        session=data;mode='business';ready=true;adventureNotice='';
        if(record.endpoint==='adventure-opening')openingError='';
        storage.setItem(stateKey,JSON.stringify({timelineId:timeline(),sessionId:data.sessionId}));
      }
      if(record.endpoint==='rolls/respond'){
        const check=data.resolution?.check;
        if(payload.decision==='roll'&&check)card.show({kind:'result',check,live:!data.replayed});else card.hide();
      }
      if(record.endpoint==='intents/respond')card.hide();
      if(record.endpoint==='character-command'){status=CHARACTER_DONE[payload.operation]||data.resolution?.summary||'已完成。';character.settled(true);}
      if(record.endpoint==='character/advancement/apply'){status='已升到 '+data.snapshot.character.level+' 级。';character.settled(true);}
      if(data.replayed)status='已恢复原请求的结果，没有重复执行。';
      await refresh().catch(()=>{status='行动已记录，但最新进度暂不可读。请稍候，不要重发。';});
    }catch(error){
      if(!alive)return;
      if(error.unconfirmed||error.status===401){
        status='结果尚未确认，已保留原请求。检查连接后点「重试」，不要重新描述同一行动。';
      }else{
        // An explicit rejection settles the original request; the draft stays for the player to decide.
        // A host busy with a teammate's action is not resent by itself: that action may change the
        // scene, so the player reads its answer first and sends, or rewrites, the kept draft.
        pending.complete();sentText=null;
        if(record.endpoint==='adventure-opening')openingError=error.message;
        if(['character-command','character/advancement/apply'].includes(record.endpoint))character.settled(false);
        status=error.code==='harness_busy'?'主持正在回应其他行动（通常是队友的），这次没有发出，草稿保留；看到回应后再发送。'
          :error.code==='campaign_timeline_changed'?'全队进度已被读档或重开，原请求没有执行。':error.message+' 原请求已明确拒绝，草稿保留。';
        await refresh().catch(()=>{});
      }
    }finally{sending=false;afterRead();}
  }

  function submit(text){
    if(sending)return;
    const request=turn.composerRequest(turnState(),text);
    if(request instanceof Error){status=request.message;render();return;}
    if(request.endpoint==='adventure-opening')openingAttempted=true;
    void command(request.endpoint,request.payload,request.endpoint==='adventure-opening'?null:turn.normalizeText(text));
  }
  function respondRoll(decision){
    const roll=snapshot.pendingRoll;if(!roll||sending)return;
    void command('rolls/respond',{rollId:roll.id,decision});
  }
  function respondIntent(decision,optionId=''){
    const intent=snapshot.pendingIntent;if(!intent||sending)return;
    void command('intents/respond',{intentId:intent.id,decision,optionId,text:''});
  }
  // Combat choices are sent as their kind/target only; the server prices, rolls and resolves them.
  function act(option){
    if(!option?.available||sending)return;
    targeting=null;picking=null;
    if(card.view?.kind==='actions')card.view.respond?card.show({...card.view,busy:true}):card.hide();
    void command('actions/propose',{kind:option.kind,target:option.target});
  }
  function review(title,options){card.show({kind:'actions',title,options,busy:sending||!!pendingRecord(),version:snapshot.version});}
  function pickGroup(group){
    picking=null;
    if(group.kind==='combat.attack'){targeting=targeting==='attack'?null:'attack';render();}
    else if(group.direct)act(group.options[0]);
    else{targeting=null;render();review(group.name,reviewEntries(group.options));}
  }
  // A spell listed once for many centres is placed on the map; the chosen centre's card names
  // everyone it reaches (the server's consent card names only the centre).
  function choose(option){
    if(!option.pick)return act(option);
    if(!option.available||sending)return;
    card.hide();
    if(option.kind==='map.missile')targeting='missile';else picking=option;
    render();
  }
  // One missile per click; the card stays away until the allocation is done or Esc brings it back.
  function allocate(option){
    if(option?.available&&!sending)void command('actions/propose',{kind:option.kind,target:option.target});
  }
  function pickCentre(option){
    const title=picking?.label||option.label;
    picking=null;render();review(title,[option]);
  }
  function aim(options){
    const open=options.filter(o=>o.available);
    if(open.length===1)act(open[0]);else review('选择攻击方式',options);
  }
  async function selectSession(id){
    try{
      const value=await api.request('adventure-session',connection,{sessionId:id});
      if(!alive)return;
      session=value;storage.setItem(stateKey,JSON.stringify({timelineId:timeline(),sessionId:id}));card.hide();afterRead();
    }catch(error){status=error.message;render();}
  }
  function noticeAction(){
    const notice=noticeModel(turnState(),{pending:!!pendingRecord(),sending,recovery:recovery()});
    switch(notice?.act){
      case 'retry':void send();break;
      case 'roll':if(snapshot.pendingRoll)card.show(rollCard());break;
      case 'intent':if(snapshot.pendingIntent)card.show(intentCard());break;
      case 'sessions':card.show({kind:'sessions',sessions:active});break;
      case 'continue':void command('adventure-continue',{sessionId:session.sessionId});break;
      case 'stop':void command('adventure-stop',{sessionId:session.sessionId});break;
      case 'respond':{const next=respondCard();if(next)card.show(next);break;}
    }
  }
  function onKey(event){
    // An open window (character, journal) or the rebuild page owns the keyboard; the native dialog closes itself on Esc.
    if(document.querySelector('dialog[open],.pl-rebuild'))return;
    const typing=event.target instanceof HTMLInputElement||event.target instanceof HTMLTextAreaElement;
    if(event.key===' '&&!typing&&!(event.target instanceof HTMLButtonElement)&&(card.space()||feed.finishReveal()))event.preventDefault();
    else if(event.key==='Escape'&&card.view)card.hide();
    else if(event.key==='Escape'&&(targeting||picking)){
      const back=targeting==='missile';targeting=null;picking=null;render();
      const next=back?respondCard():null;if(next)card.show(next);
    }
    else if(event.key==='Escape'&&screen.mapOpen)openMap(false);
    else if(!typing&&!event.ctrlKey&&!event.metaKey&&!event.altKey){
      const key=event.key.toLowerCase();
      if(key==='c'||key==='i'){event.preventDefault();character.show(key==='i'?'inventory':'overview');}
      else if(key==='j'){event.preventDefault();openJournal();}
      else if(key==='m'){event.preventDefault();openMap();}
    }
  }
  function disconnect(){
    alive=false;document.removeEventListener('keydown',onKey);screen.element.dispatchEvent(new Event('dispose'));
    feed.element.dispatchEvent(new Event('dispose'));map.dispose();
    leaveSeat(storage);showConnect();
  }

  render();
  void (async()=>{
    try{await refresh();}catch{offline=true;render();}
    // A request left unconfirmed by an earlier visit waits for an explicit retry.
    while(alive){
      await sleep(POLL_MS);
      if(!alive||sending)continue;
      try{await refresh();}
      catch(error){
        if(!alive)continue;
        if(error.status===401){status='当前席位凭证已失效或已被撤销。已保留原请求与草稿，可以返回入口。';offline=false;}
        else offline=true;
        render();
      }
    }
  })();
}

const saved=currentSeat(storage,origin);
if(saved)void start(saved);else showConnect();

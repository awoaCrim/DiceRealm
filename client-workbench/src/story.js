// The story owns the page: a novel-style reading column, the host's task strip above it and,
// for the host, a docked right pane that switches between the overview and one open task.
// Character readers open from a speaker's name or the party list; nothing covers the story.
import {h,fmtTime,fmtClock,iconButton} from './dom.js';
import {newUuid,validPrivateSource,samePrivateSource,latestSharedStory,privateSourceKey} from './api.js';
import {actionBlockReason} from './campaign-state.js';
import {ruleName,actionLabel} from './rule-labels.js';
import {activityStatusLabels,correctionNotice} from './activity.js';
import {actorLabel} from './tasking.js';
import {characterSheet} from './character-sheet.js';
import {storyParagraphs} from './story-dialogue.js';
import {createHostTasks} from './pending-panel.js';
import {watchDashboard} from './dashboard-sync.js';
import {createDialogHost,createDrawerHost} from './workspace-dialog.js';
import {createCombatReader} from './combat-reader.js';
import {createDmSidebar} from './dm-sidebar.js';
import {createPresentationMotion} from './presentation-motion.js';
import {createReveal} from './story-reveal.js';
import {recordedCheckText,recordedCheckParts,recordedCheckDice,combatEntryCard,activityResultItems,duplicatesCombatNarrative} from './combat-log.js';
import {watchStoryProgress,storyProgressMessage,createStoryProgress} from './story-progress.js';

const WINDOW=50;
// Only states that still need someone are worth a line; finished actions speak for themselves.
const waitingStates=new Set(['awaiting_clarification','awaiting_confirmation','awaiting_roll','awaiting_ruling','awaiting_consequence','rejected','cancelled']);
// What another seat's action waits on is that player's to do, so it says who: a teammate reading
// "等待确认行动" under someone else's line took it as their own.
const OTHERS_WAITING={awaiting_clarification:'补充说明',awaiting_confirmation:'确认行动',awaiting_roll:'投掷'};
function waitingLabel(entry,snapshot){
  const self=snapshot?.party?.selfActorId,other=OTHERS_WAITING[entry.status];
  return other&&entry.actorId&&self&&entry.actorId!==self?'等待'+actorLabel(snapshot,entry.actorId)+other
    :activityStatusLabels[entry.status]||entry.status;
}

export const rollText=recordedCheckText;
const paragraphs=storyParagraphs;
const memberFor=(snapshot,id)=>(snapshot.party?.members||[]).find(m=>m.id===id&&!m.revoked&&m.character);
// The right-hand clock; the feed shows each minute once (see draw).
function clock(iso){
  const text=fmtClock(iso);if(!text)return null;
  return h('time.msg-time',{datetime:iso,title:fmtTime(iso),'data-clock':text,'data-minute':String(Math.floor(new Date(iso).getTime()/60000))});
}
const tag=(text,className='msg-label')=>h('span.'+className,{},text);
// The d20 mark at the head of a check line; decorative, drawn with the story's ink.
export function dieMark(){
  const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
  svg.setAttribute('viewBox','0 0 100 104');svg.setAttribute('class','roll-die');svg.setAttribute('aria-hidden','true');
  for(const d of ['M50 4 92 28 92 76 50 100 8 76 8 28Z','M50 24 80 72 20 72Z']){
    const path=document.createElementNS('http://www.w3.org/2000/svg','path');path.setAttribute('d',d);svg.append(path);
  }
  return svg;
}
// One check, read in a single line: who, what, DC, saved dice, and the server's verdict.
function rollCard(check,name,time){
  const parts=recordedCheckParts(check),dice=recordedCheckDice(check);
  const outcome=parts.verdict==='成功'?'success':parts.verdict==='失败'?'failure':'neutral';
  return h('div.msg.msg-roll',{'data-outcome':outcome,'aria-label':name+' · '+rollText(check),...(dice?{title:dice}:{})},
    h('p.roll-line.msg-c',{},dieMark(),h('span.roll-name',{},name),h('span.roll-label',{},parts.label),
      h('span.roll-dc',{},'DC '+parts.dc),h('span.roll-sep',{'aria-hidden':'true'},'·'),h('span.roll-math',{},parts.math),
      parts.verdict?h('span.roll-result',{},parts.verdict):null),clock(time));
}

// Direct equipment controls stay in activity/audit data, not in the story feed.
// Explicit natural-language input and intent roots remain real conversation.
function equipmentControl(entry){
  return ['character.equip','character.loadout','character.wear','character.unpack','equipment.equip','equipment.armor'].includes(entry.kind)
    && !(entry.origin?.input||'').trim() && !entry.initialResult?.intentId;
}

// One activity entry -> story lines, in the order they happened. Dialogue is "name：words"
// in body ink, narration one shade lighter, private text a lead tag plus ochre prose.
// `host` picks the host's wording of combat entries; the player page passes false even for a host seat.
export function storyMessages(entry,snapshot,progress=[],openCharacter,progressMessage=storyProgressMessage,sharePrivate,{seen=new Set(),acknowledged=new Set(),sharing=false,host=!!snapshot?.party?.isHost}={}){
  if(equipmentControl(entry))return [];
  const name=entry.origin?.actorName||actorLabel(snapshot,entry.actorId),time=entry.createdAt,messages=[];
  const said=entry.continuationOf>0?null:entry.origin?.input||actionLabel(entry.origin?.label);
  if(said){
    const available=!!openCharacter&&!!memberFor(snapshot,entry.actorId),portraitKey=String(entry.sequence);
    const line=(...words)=>{
      const speaker=h('button.msg-speaker',{type:'button','data-actor':entry.actorId,'data-portrait':portraitKey,'aria-label':'查看 '+name+' 的角色资料',
        title:available?'查看角色资料':'该角色资料当前不可用',disabled:!available,onclick:()=>openCharacter?.(entry.actorId,portraitKey)},name);
      return h('div.msg.msg-player',{},h('p.say.msg-c',{},speaker,h('span.colon',{'aria-hidden':'true'},'：'),...words),clock(time));
    };
    messages.push(line(h('span',{},said)));
    // The player's answers to the host's questions continue this action; the questions stay with the asker.
    for(const item of entry.origin?.clarifications||[]){
      const answer=String(item?.answer??'').trim();
      if(answer)messages.push(line(tag('回答主持'),h('span',{},answer)));
    }
  }
  const steps=(entry.steps||[]).filter(s=>s.result);
  const combatDetails=[],narrated=entry.narrativeSource==='harness'&&!!entry.narrative?.trim();
  const results=activityResultItems(entry);
  for(const item of results){
    if(item.type==='check')messages.push(rollCard(item.check,name,time));
    else (narrated?combatDetails:messages).push(combatEntryCard(item.entry,{host,includeCheck:item.includeCheck,compact:true,
      nameFor:id=>(snapshot.combat&&item.entry.presentation?.combatId===snapshot.combat.id?snapshot.combat.units.find(unit=>unit.id===id)?.name:'')
        ||memberFor(snapshot,id)?.character.name||id}));
  }
  if(entry.narrative&&!duplicatesCombatNarrative(entry))messages.push(h('div.msg.msg-dm.msg-narrative',{},h('div.msg-c',{},...paragraphs(entry.narrative)),clock(time)));
  // A result the server only summarised (a rest, a hit die, an award): its summary, when no check,
  // battle line or narration tells it already.
  // A board change shows on the map; its receipt is the engine's audit wording.
  const summary=entry.initialResult?.status==='resolved'&&!String(entry.initialResult.kind||'').startsWith('board.')
    ?String(entry.initialResult.summary||'').trim():'';
  // A place's own prose (the arrival after travel, a look around) reads as narration.
  if(summary&&!results.length&&!entry.narrative?.trim()&&!waitingStates.has(entry.status))messages.push(['travel','observe'].includes(entry.initialResult.kind)
    ?h('div.msg.msg-dm.msg-narrative',{},h('div.msg-c',{},...paragraphs(summary)),clock(time)):h('p.msg-system.msg-result',{},summary));
  if(combatDetails.length)messages.push(h('details.msg-combat-details',{'data-entry':String(entry.sequence)},h('summary',{},'查看战斗记录'),...combatDetails));
  const ruling=entry.ruling;
  if(ruling?.rationale&&['resolved','awaiting_roll'].includes(ruling.status))messages.push(h('div.msg.msg-dm.msg-ruling',{},
    h('div.msg-c',{},...paragraphs(ruling.rationale,{lead:tag('主持回应')}))));
  if(ruling?.story?.resultText)messages.push(h('div.msg.msg-dm.msg-ruling',{},h('div.msg-c',{},...paragraphs(ruling.story.resultText,{lead:tag('剧情变化')}))));
  const changes=steps.length?steps.flatMap(step=>step.origin?.changes||[]):entry.origin?.changes||[];
  for(const change of changes){
    const before=Number(change.before),after=Number(change.after);
    if(change.operation!=='inventory'||!change.actorId||change.before===''||change.after===''||!Number.isInteger(before)||!Number.isInteger(after)||before<0||after<=before)continue;
    const character=memberFor(snapshot,change.actorId)?.character,actor=character?.name||(entry.actorId===change.actorId?name:actorLabel(snapshot,change.actorId));
    const item=character?.inventory?.find(item=>item.id===change.key),prefix=actor+' · ';
    const label=item?.name||(change.label?.startsWith(prefix)?change.label.slice(prefix.length):change.label)||change.key;
    messages.push(h('p.msg-system.msg-loot',{},actor+'获得「'+ruleName(label)+'」×'+(after-before)+'，已放入背包。'));
  }
  // 新活动把事件与裁定的私人片段统一放在 privateParts；旧单字段仍作阅读兼容。
  const privateParts=[];
  const addPrivateParts=list=>{for(const part of list||[])if(part)privateParts.push(part);};
  if(entry.privateParts?.length)addPrivateParts(entry.privateParts);
  else if(entry.privateText)addPrivateParts([{actorId:entry.actorId,text:entry.privateText}]);
  if(ruling?.privateParts?.length)addPrivateParts(ruling.privateParts);
  else if(ruling?.privatePart)addPrivateParts([ruling.privatePart]);
  else if(!entry.privateParts?.length&&ruling?.privateText)addPrivateParts([{actorId:ruling.actorId,text:ruling.privateText}]);
  const frozenShares=snapshot?.sharedStories||[];
  for(const part of privateParts){
    if(!part?.text)continue;
    const key=privateSourceKey(part.source);if(key&&seen.has(key))continue;if(key)seen.add(key);
    const self=part.actorId===snapshot?.party?.selfActorId;
    // canShare 是服务端按当前实际收件人给出的授权（主持代读他人消息为 false，收件人即使有队长席位仍为 true）；
    // 旧服务缺该字段时回退到行动者本人。
    const recipient=typeof part.canShare==='boolean'?part.canShare:self;
    const available=recipient&&validPrivateSource(part.source)&&!!sharePrivate;
    // 只有旧全文公开算“已公开”；转述只发布所说文字，不封锁本条来源。
    const shared=part.shared===true||(!!key&&acknowledged.has(key))||frozenShares.some(s=>!s.publication&&samePrivateSource(s.source,part.source));
    const share=shared&&recipient?h('div.msg-share-row',{},iconButton('已公开','✓',{disabled:true}))
      :available?h('div.msg-share-row',{},
        iconButton('快速转述','↗',{'data-quick-share-source':key,disabled:!!sharing||snapshot?.archived||!!actionBlockReason(snapshot),title:actionBlockReason(snapshot)||'快速转述：生成后发给队伍',onclick:()=>{if(!sharing&&!snapshot?.archived&&!actionBlockReason(snapshot))sharePrivate(part,true);}}),
        iconButton('手写转述','✎',{'data-share-source':key,disabled:!!sharing||snapshot?.archived||!!actionBlockReason(snapshot),title:actionBlockReason(snapshot)||'手写转述',onclick:()=>{if(!sharing&&!snapshot?.archived&&!actionBlockReason(snapshot))sharePrivate(part);}}))
      :null;
    // A single legacy recipient is named; new multi-recipient parts keep the general label.
    const label=part.source?.partId?'指定玩家与主持可见':recipient?'仅你和主持可见':'仅 '+actorLabel(snapshot,part.actorId)+' 可见';
    messages.push(h('div.msg.msg-private',{},h('div.msg-c',{},...paragraphs(part.text,{lead:tag(label,'secret-tag')}),share),clock(time)));
  }
  const correction=correctionNotice(entry.correction);if(correction)messages.push(correction);
  // This round's host-only steps close the DM message they belong to.
  messages.push(...progress.map(run=>progressMessage(run,{hasNarrative:!!entry.narrative})));
  if(waitingStates.has(entry.status))messages.push(h('p.msg-system',{},waitingLabel(entry,snapshot)));
  return messages;
}

// Accumulates activity windows; older pages prepend, newer versions append.
// `player` (the /play/ page) shows a host seat what any player sees: no run steps, no host wording.
export function createStoryFeed(ctx,{isDisposed,openCharacter,openStory,sharePrivate,onLoaded=()=>{},player=false}){
  const dm=()=>!player&&!!ctx.snapshot.party?.isHost;
  const entries=new Map(),progressViews=new Map(),historyRuns=new Map(),historyViews=new Map();let oldestAfter=null,newestThrough=0,busy=false,pendingVersion=0,runs=[],activityError='';
  const list=h('div.story-feed',{role:'log','aria-label':'剧情记录'}),status=h('p.small.muted',{role:'status'});
  const motion=createPresentationMotion(list),seenMessages=new Set();
  let progressLive=false,pendingLive=true,ownAction=null,ownKey='';
  let touched=false;
  // An empty feed says what has to happen before the first story appears.
  function emptyGuide(){
    const host=dm(),step=player?['写下你想做的事，故事从这里开始。']:!host?['开场后，剧情会出现在这里。']
      :ctx.adventureAvailable===false?['先在「剧本」页启用剧本库里的剧本，或导入自己的内容。',h('a.btn',{href:'#/campaign'},'前往剧本')]
      :['在「邀请玩家」开启加入；玩家完成角色并开场后，剧情会出现在这里。',h('a.btn',{href:'#/room'},'邀请玩家')];
    return h('div.story-empty',{},h('p.story-empty-title',{},'还没有剧情记录'),h('p',{},step[0]),step[1]||null);
  }
  // A reader at the newest line stays there when the column itself changes height (a row above the
  // input comes or goes), not only when messages arrive. Only the reader's own scrolling unpins: the
  // browser also scrolls on its own (clamping, scroll anchoring) right after the column shrinks, and
  // judging that by the new geometry once left the newest line half under the input.
  let pinned=true,readerAt=-Infinity;
  for(const event of ['wheel','pointerdown','keydown','touchmove'])list.addEventListener(event,()=>{touched=true;readerAt=performance.now();},{passive:true});
  list.addEventListener('scroll',()=>{
    if(list.scrollHeight-list.scrollTop-list.clientHeight<48)pinned=true;
    else if(performance.now()-readerAt<1000)pinned=false;
  },{passive:true});
  if(typeof ResizeObserver==='function')new ResizeObserver(()=>{if(pinned&&!isDisposed())follow();}).observe(list);
  // The player page reveals new narration, public and private, character by character (story-reveal.js); the host's
  // workbench shows it whole. A reader at the newest line follows the line being revealed rather than
  // the bottom of the still-blank rest, and lands at the bottom when it is done.
  let revealFollow=false;
  const reducedMotion=()=>document.documentElement?.dataset.reduceMotion==='true'||!!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  function keepInView(rest){
    const edge=list.getBoundingClientRect?.().bottom,at=rest.getBoundingClientRect?.().top;
    if(edge!=null&&at!=null&&at+72>edge)list.scrollTop+=at+72-edge;
  }
  // The newest line, or while narration is being revealed, the line being revealed.
  function follow(){
    const rest=revealFollow?list.querySelector('.reveal-rest'):null;
    if(rest)keepInView(rest);else list.scrollTop=list.scrollHeight;
  }
  const reveal=player?createReveal({onPaint:rest=>{if(isDisposed())reveal.stop();else if(revealFollow)keepInView(rest);},
    onDone:()=>{if(revealFollow&&!isDisposed())list.scrollTop=list.scrollHeight;revealFollow=false;}}):null;
  // Reading on (a click, a scroll) shows the narration whole.
  if(reveal)for(const event of ['pointerdown','wheel','touchmove'])list.addEventListener(event,()=>reveal.finish(),{passive:true});
  function mounted(){
    if(isDisposed())return;
    list.scrollTop=list.scrollHeight;
    void document.fonts?.ready.then(()=>{if(!isDisposed()&&!touched)list.scrollTop=list.scrollHeight;});
  }
  const older=h('button.linkish',{type:'button',hidden:true,onclick:()=>loadOlder()},'更早的记录');
  async function loadWindow(after,through){
    let page,next=after;const added=[];
    do{
      page=await ctx.read('activity',{after:next,through});if(isDisposed())return;
      if(page.nextAfter<next||page.nextAfter>through||page.hasMore&&page.nextAfter<=next)throw new Error('剧情记录响应不完整。');
      added.push(...page.entries);next=page.nextAfter;
    }while(page.hasMore);
    for(const entry of added)entries.set(entry.sequence,entry);
    return page;
  }
  function progressMessage(run,options={}){
    let view=progressViews.get(run.id);
    if(!view){view=createStoryProgress(run,{...options,live:progressLive,ctx,isDisposed:()=>isDisposed()||!dm()});progressViews.set(run.id,view);}
    else view.update(run,{...options,live:progressLive});
    return view.element;
  }
  const actionKey=value=>value.actorId+'/'+value.actionId;
  function historyMessage(entry){
    const key=actionKey(entry);let view=historyViews.get(key);if(view)return view;
    const body=h('div'),retry=h('button.linkish',{type:'button',onclick:()=>load()},'重试读取本轮步骤');
    view=h('details.msg-progress.progress-history',{},h('summary',{},h('span.progress-label',{},'本轮步骤'),h('span.progress-mark',{},'仅主持')),body);historyViews.set(key,view);
    let busy=false,loaded=false;
    async function load(){
      if(busy||loaded||isDisposed()||!dm())return;busy=true;body.textContent='正在读取本轮步骤…';
      try{
        const value=await ctx.read('adventure-progress',{actorId:entry.actorId,actionId:entry.actionId});
        if(isDisposed()||!dm())return;
        if(value.runs.some(run=>actionKey(run)!==key))throw new Error('本轮步骤不属于这次行动。');
        loaded=true;
        if(!value.runs.length){body.textContent='没有可读取的本轮步骤。';return;}
        const run=value.runs[0];historyRuns.set(key,run);
        const transferFocus=view.querySelector('summary')===document.activeElement;
        const node=progressMessage(run,{hasNarrative:!!entry.narrative});node.open=view.open;
        draw();
        if(transferFocus)node.querySelector('summary')?.focus({preventScroll:true});
        if(node.open)node.dispatchEvent(new Event('toggle'));
      }catch(error){if(!isDisposed()){body.replaceChildren(h('p.error-box',{},error.message),retry);}}
      finally{busy=false;}
    }
    view.addEventListener('toggle',()=>{if(view.open)void load();});return view;
  }
  function draw({first=false,prepend=false,live=false}={}){
    // The reader's place as of their last scroll: the column may have just shrunk (a bar appeared above
    // the input in the same tick) before the resize observer moved the view back down.
    const atBottom=pinned||list.scrollHeight-list.scrollTop-list.clientHeight<48;
    const top=list.scrollTop,height=list.scrollHeight,edge=list.getBoundingClientRect?.().top;
    const anchor=[...list.children].find(node=>node.getBoundingClientRect?.().bottom>edge);
    const anchorKey=anchor?.dataset.message,anchorTop=anchor?.getBoundingClientRect().top;
    const stepOffsets=new Map([...list.querySelectorAll('.progress-run')].map(node=>[node.dataset.run,node.querySelector('ol')?.scrollTop||0]));
    const combatDetails=[...list.querySelectorAll('.msg-combat-details')];
    const expandedCombat=new Set(combatDetails.filter(node=>node.open).map(node=>node.dataset.entry));
    const focusedCombat=combatDetails.find(node=>node.contains?.(document.activeElement))?.dataset.entry;
    const matched=new Set(),rows=[],privateOptions={seen:new Set(),acknowledged:ctx.sharedAcknowledgements||new Set(),host:dm()};
    const opening=ctx.snapshot.opening;
    // 公共正文可以为空；有私人补充时仍要交付，且不画空壳或秘密提示。
    if(opening&&(opening.publicText||opening.privateParts?.length)){
      const key='opening:'+opening.publicSequence;
      rows.push({order:opening.publicSequence,key,node:h('div.msg-group',{'data-message':key},...storyMessages({sequence:key,narrative:opening.publicText,privateParts:opening.privateParts||[]},ctx.snapshot,[],openCharacter,progressMessage,sharePrivate,privateOptions))});
    }
    // A player who entered after the shared opening, in their own public line.
    for(const arrival of opening?.arrivals||[]){
      const key='arrival:'+arrival.sequence;
      rows.push({order:arrival.sequence,key,node:h('div.msg-group',{'data-message':key},...storyMessages({sequence:key,narrative:arrival.text},ctx.snapshot,[],openCharacter,progressMessage,sharePrivate,privateOptions))});
    }
    const visibleRuns=dm()?[...new Map([...historyRuns.values(),...runs].map(run=>[run.id,run])).values()]:[];
    const focused=document.activeElement;
    const restoreFocus=[...list.querySelectorAll('.progress-run')].some(node=>node.contains?.(focused));
    const latestByAction=new Map([...entries.values()].sort((a,b)=>a.sequence-b.sequence).map(entry=>[actionKey(entry),entry.sequence]));
    for(const entry of [...entries.values()].sort((a,b)=>a.sequence-b.sequence)){
      if(equipmentControl(entry))continue;
      const latest=latestByAction.get(actionKey(entry))===entry.sequence;
      const progress=latest?visibleRuns.filter(run=>run.actionId&&run.actionId===entry.actionId&&run.actorId===entry.actorId):[];
      progress.forEach(run=>matched.add(run.id));
      const key=entry.continuationOf>0?'entry:'+entry.sequence:entry.actionId?'action:'+entry.actionId:'entry:'+entry.sequence;
      rows.push({order:entry.sequence,key,node:h('div.msg-group',{'data-message':key,'data-sequence':String(entry.sequence)},
        ...storyMessages(entry,ctx.snapshot,progress,openCharacter,progressMessage,sharePrivate,privateOptions),
        dm()&&openStory&&entry.ruling?.status==='resolved'&&!entry.ruling.story&&(['narrative','board_move','effects'].includes(entry.ruling.outcome)||entry.ruling.outcome==='check'&&entry.ruling.effectsRequestId)
          ?h('button.btn.btn-ghost.btn-sm',{type:'button',onclick:()=>openStory(entry.ruling)},'追加剧情变化（可选）'):null,
        dm()&&latest&&!progress.length&&entry.actionId&&(entry.narrativeSource==='harness'||entry.steps?.length)?historyMessage(entry):null)});
    }
    // The player's own action in flight: its words stand last until the server's record of that
    // action arrives under the same key, as the host's run progress does below.
    if(ownAction&&!latestByAction.has(actionKey(ownAction))){
      const key='action:'+ownAction.actionId;
      rows.push({order:Infinity,key,node:h('div.msg-group',{'data-message':key},
        ...storyMessages({sequence:key,actorId:ownAction.actorId,origin:{input:ownAction.input}},ctx.snapshot,[],openCharacter))});
    }
    for(const run of visibleRuns){
      if(matched.has(run.id))continue;
      // The host sees the exact submitted input even before a domain activity is
      // published. It is replaced by the matching actor/action root, never duplicated.
      const key=run.actionId?'action:'+run.actionId:'run:'+run.id;
      const input=run.input?storyMessages({sequence:'run:'+run.id,actorId:run.actorId,origin:{input:run.input,actorName:run.actorName}},ctx.snapshot,[],openCharacter):[];
      rows.push({order:(run.version||newestThrough)+0.5,key,node:h('div.msg-group',{'data-message':key},...input,progressMessage(run))});
    }
    for(const share of ctx.snapshot.sharedStories||[]){
      const key='shared:'+share.sequence,retelling=share.publication==='retelling';
      rows.push({order:share.atVersion+.25,shareSequence:share.sequence,key,node:h('div.msg-group',{'data-message':key},h('div.msg.msg-dm.msg-shared',{},
        h('div.msg-c',{},...paragraphs(share.text,{lead:tag(share.actorName+(retelling?' · 转述给队伍':' · 公开私人信息'))}),
          retelling?null:h('p.msg-note',{},'原文中的“你”指 '+share.actorName+'。')),clock(share.createdAt)))});
    }
    // An event with no visible messages must not leave an empty divider in the reading column.
    for(let i=rows.length-1;i>=0;i--)if(!rows[i].node.children.length)rows.splice(i,1);
    rows.sort((a,b)=>a.order-b.order||(a.shareSequence||0)-(b.shareSequence||0)||a.key.localeCompare(b.key));
    motion.stop();
    for(const row of rows)for(const node of row.node.children){
      if(node.classList.contains('msg-progress'))continue;
      const content=['msg-player','msg-dm','msg-private','msg-roll'].some(c=>node.classList.contains(c))?[...node.querySelectorAll('p')].map(p=>p.textContent).join('\n'):node.textContent;
      const key=row.key+':'+node.className+':'+content;
      if(live&&!first&&!prepend&&!seenMessages.has(key)){motion(node);if(reveal&&['msg-narrative','msg-private'].some(c=>node.classList.contains(c))&&!reducedMotion())reveal.add(key);}
      seenMessages.add(key);
      reveal?.attach(key,node);
    }
    list.replaceChildren(...rows.map(row=>row.node));
    // Same minute, one clock: later lines of that minute leave the time column empty.
    let minute='';
    for(const node of list.querySelectorAll('.msg-time')){node.textContent=node.dataset.minute!==minute?node.dataset.clock:'';minute=node.dataset.minute;}
    if(!rows.length&&!activityError)list.append(emptyGuide());
    for(const node of list.querySelectorAll('.msg-combat-details')){
      node.open=expandedCombat.has(node.dataset.entry);
      if(node.dataset.entry===focusedCombat)node.querySelector('summary')?.focus({preventScroll:true});
    }
    if(restoreFocus&&focused?.isConnected)focused.focus({preventScroll:true});
    for(const node of list.querySelectorAll('.progress-run')){
      const steps=node.querySelector('ol');if(steps)steps.scrollTop=stepOffsets.get(node.dataset.run)||0;
    }
    status.textContent=activityError;
    older.hidden=oldestAfter===0||oldestAfter===null;
    const revealing=!first&&atBottom&&!prepend?list.querySelector('.reveal-rest'):null;
    if(revealing){revealFollow=true;list.scrollTop=top;keepInView(revealing);}
    else if(first||atBottom&&!prepend)list.scrollTop=list.scrollHeight;
    else{
      const replacement=[...list.children].find(node=>node.dataset.message===anchorKey);
      list.scrollTop=replacement&&anchorTop!=null?top+replacement.getBoundingClientRect().top-anchorTop
        :prepend?top+list.scrollHeight-height:top;
    }
  }
  function updateProgress(value,{live=false}={}){
    if(isDisposed())return;
    if(!dm())for(const view of progressViews.values())view.close();
    for(const run of value)if(run.actionId&&run.succeeded)historyRuns.set(actionKey(run),run);
    runs=value;progressLive=live;draw({live});progressLive=false;
  }
  async function guarded(task){
    if(busy||isDisposed())return;busy=true;older.disabled=true;
    try{await task();}catch(error){if(!isDisposed()){activityError=error.message;status.textContent=activityError;}}
    finally{
      busy=false;if(!isDisposed()){
        older.disabled=false;
        if(pendingVersion){const version=pendingVersion,live=pendingLive;pendingVersion=0;pendingLive=true;void loadLatest(version,{live});}
      }
    }
  }
  const loadOlder=()=>guarded(async()=>{
    await loadWindow(Math.max(0,oldestAfter-WINDOW),oldestAfter);oldestAfter=Math.max(0,oldestAfter-WINDOW);
    if(isDisposed())return;activityError='';draw({prepend:true});
  });
  const loadLatest=(version,{live=true}={})=>{
    if(busy){pendingVersion=Math.max(pendingVersion,version);pendingLive&&=live;return Promise.resolve();}
    return guarded(async()=>{
    const first=oldestAfter===null;
    // A later event may finish/correct an older root, so refresh the loaded range too.
    const after=first?Math.max(0,version-WINDOW):oldestAfter;
    if(!first&&version<=newestThrough)return;
    await loadWindow(after,version);if(first)oldestAfter=after;newestThrough=version;
    if(isDisposed())return;
    const animate=live&&!activityError;activityError='';draw({first,live:animate});onLoaded(version);
    });
  };
  const element=h('div.story-column',{},h('div.story-older',{},older),list,status);
  element.addEventListener('dispose',()=>{list.dispatchEvent(new Event('dispose'));for(const view of progressViews.values())view.dispose();},{once:true});
  function setOwnAction(value){
    const key=value?JSON.stringify(value):'';
    if(key===ownKey||isDisposed())return;
    ownKey=key;ownAction=value;draw({live:true});
  }
  // Space on the page shows narration being revealed whole; false when there is none.
  const finishReveal=()=>reveal?.finish()||false;
  return {element,loadLatest,updateProgress,mounted,setOwnAction,refreshShared:draw,loadedVersion:()=>newestThrough,finishReveal};
}

export async function renderStory(mount,ctx){
  let disposed=false,openedSheet=null,openedMembers=null,updateShare=null,drawerHost=null,tasks=null,overviewWanted=false;const isDisposed=()=>disposed;
  mount.addEventListener('dispose',()=>{disposed=true;},{once:true});
  const snapshot=ctx.snapshot,host=!!snapshot.party?.isHost,dialogs=createDialogHost(mount);
  // Battle details follow the snapshot whose story has actually reached the feed.
  // Keep authority in ctx untouched for commands and permission checks.
  let combatSnapshot=snapshot;
  const combatContext={...ctx,get snapshot(){return ctx.snapshot.party?.isHost?combatSnapshot:ctx.snapshot;}};
  const combatReader=host?createCombatReader(mount,combatContext,{dialogs}):null;
  function updateSheet(){
    if(!openedSheet||openedSheet.isDisposed())return;
    const member=memberFor(ctx.snapshot,openedSheet.actorId);
    if(!member){openedSheet.close();openedSheet=null;return;}
    const character=member.character;
    const rulesKey=JSON.stringify([member.id,character.id,character.features,character.species,character.className,character.level,
      character.build?.speciesId,character.build?.selections,character.advancement,character.buildMechanics?.feats]);
    if(openedSheet.rulesKey!==rulesKey){
      openedSheet.rulesKey=rulesKey;openedSheet.rules=null;openedSheet.rulesStatus='正在读取能力规则…';
      openedSheet.rulesRevision++;void readSheetRules(openedSheet,rulesKey);
    }
    const signature=JSON.stringify([character,member.review,ctx.snapshot.elapsedSeconds,openedSheet.rulesRevision]);
    if(signature===openedSheet.signature)return;
    const body=openedSheet.body,old=body.querySelector('.sheet-body');
    const section=old?.dataset.section||'overview',selection=old?.dataset.entry||'',sheetTop=old?.scrollTop||0;
    const focus=document.activeElement?.dataset,focusedEntry=focus?.sheetEntry,focusedTab=focus?.sheetTab;
    const readerTop=body.querySelector('.sheet-reader')?.scrollTop||0,listTop=body.querySelector('.sheet-entry-list')?.scrollTop||0,top=body.scrollTop;
    openedSheet.signature=signature;
    body.replaceChildren(...(openedSheet.fromMembers?[h('button.linkish.sheet-back',{type:'button',onclick:showMembers},'返回成员列表')]:[]),
      characterSheet(member.character,{elapsedSeconds:ctx.snapshot.elapsedSeconds,review:member.review,section,selection,
        rules:openedSheet.rules,rulesStatus:openedSheet.rulesStatus,retryRules:openedSheet.rulesError?retrySheetRules:null}));
    body.querySelector('.sheet-reader').scrollTop=readerTop;body.querySelector('.sheet-entry-list').scrollTop=listTop;
    body.querySelector('.sheet-body').scrollTop=sheetTop;body.scrollTop=top;
    const target=[...body.querySelectorAll('button')].find(button=>focusedEntry?button.dataset.sheetEntry===focusedEntry:focusedTab&&button.dataset.sheetTab===focusedTab);
    target?.focus({preventScroll:true});
  }
  async function readSheetRules(state,key){
    const request=++state.rulesRequest,version=ctx.snapshot.version;
    const characterId=memberFor(ctx.snapshot,state.actorId)?.character.id;
    const current=()=>!isDisposed()&&!state.isDisposed()&&openedSheet===state&&state.rulesKey===key&&state.rulesRequest===request;
    try{
      const rules=await ctx.read('character-references',{actorId:state.actorId});
      if(!current())return;
      if(!memberFor(ctx.snapshot,state.actorId)){state.close();return;}
      if(rules.actorId!==state.actorId||rules.characterId!==characterId||rules.version!==version)
        throw Error('角色资料已更新，请刷新后重新读取规则。');
      state.rules=rules;state.rulesError=false;state.rulesStatus='';
    }catch(error){if(current()){state.rulesError=true;state.rulesStatus='能力规则读取失败：'+error.message;}}
    finally{if(current()){state.rulesRevision++;updateSheet();}}
  }
  function retrySheetRules(){
    if(!openedSheet||openedSheet.isDisposed())return;
    openedSheet.rulesError=false;openedSheet.rulesStatus='正在读取能力规则…';openedSheet.rulesRevision++;
    void readSheetRules(openedSheet,openedSheet.rulesKey);updateSheet();
  }
  function openCharacter(actorId,portraitKey,sourceButton=null){
    const member=memberFor(ctx.snapshot,actorId);if(!member||isDisposed())return;
    dialogs.open({title:member.character.name+' 的角色资料',wide:true,
      returnFocus:()=>sourceButton||(portraitKey==null?membersButton:[...mount.querySelectorAll('.msg-speaker')].find(button=>button.dataset.actor===actorId&&button.dataset.portrait===portraitKey&&!button.disabled)),
      render:state=>{openedSheet={...state,actorId,fromMembers:portraitKey==null&&!sourceButton,signature:'',rulesKey:null,rulesRequest:0,rulesRevision:0,rules:null,rulesStatus:'',rulesError:false};updateSheet();}});
  }
  function updateMembers(){
    if(!openedMembers||openedMembers.isDisposed())return;
    const members=(ctx.snapshot.party?.members||[]).filter(member=>!!memberFor(ctx.snapshot,member.id));
    const signature=JSON.stringify(members.map(member=>[member.id,member.character.name,member.character.className,member.character.level,member.review?.status]));
    if(openedMembers.signature===signature)return;
    const body=openedMembers.body,top=body.scrollTop,focused=document.activeElement?.dataset?.member;
    openedMembers.signature=signature;
    body.replaceChildren(members.length?h('div.sheet-entry-list',{},...members.map(member=>h('button.btn.sheet-entry',
      {type:'button','data-member':member.id,onclick:()=>openCharacter(member.id,null)},
      h('span',{},member.character.name),h('span.small.muted',{},
        [ruleName(member.character.className),member.character.level?member.character.level+' 级':'',
          ({pending:'待审核',returned:'已退回',approved:'已批准'})[member.review?.status]||''].filter(Boolean).join(' · ')))))
      :h('p.muted',{},'当前没有可查看的角色。'));
    body.scrollTop=top;
    if(focused)[...body.querySelectorAll('button')].find(button=>button.dataset.member===focused)?.focus({preventScroll:true});
  }
  function showMembers(){
    if(isDisposed())return;
    dialogs.open({title:'队伍成员',wide:false,returnFocus:()=>membersButton,render:state=>{
      openedMembers={...state,signature:null};updateMembers();
    }});
  }
  const membersButton=h('button.linkish',{type:'button',onclick:showMembers},'队伍成员');
  const feed=createStoryFeed(ctx,{isDisposed,openCharacter,openStory:ruling=>tasks?.openConsequence(ruling),sharePrivate:openSharePrivate,onLoaded:version=>{
    if(!isDisposed()&&ctx.snapshot.version===version){combatSnapshot=ctx.snapshot;combatReader?.update();}
  }});
  // 转述只在用户提交时写入：编辑中的文字不回传服务端，关窗即零写入。
  let quickSharing=false;
  async function openSharePrivate(part,quick=false){
    if(isDisposed()||quickSharing||ctx.hasPending?.()||ctx.snapshot?.archived||!part||!validPrivateSource(part.source)||actionBlockReason(ctx.snapshot))return;
    const source=part.source;
    if(quick){
      quickSharing=true;
      try{
        await ctx.submit('story-share',{requestId:newUuid(),source,quick:true});
        if(!isDisposed())feed.refreshShared({live:true});
      }catch(error){if(!isDisposed())ctx.report(error);}
      finally{quickSharing=false;}
      return;
    }
    dialogs.open({title:'转述给队友',wide:false,returnFocus:()=>[...feed.element.querySelectorAll('button[data-share-source]')].find(button=>button.dataset.shareSource===privateSourceKey(source)),
      render:({body,isDisposed:closed,close})=>{
        let sending=false;
        const textArea=h('textarea',{rows:5,maxLength:1024,'aria-label':'要转述的内容',placeholder:'用自己的话写下要让队友知道的内容。'});
        const counter=h('p.small.muted',{},'0 / 1024');
        const notice=h('p.small.muted',{},'只公开本次转述，保留原私人消息。');
        const submit=h('button.btn.btn-primary',{type:'submit',disabled:true},'转述给队友');
        function update(){
          counter.textContent=textArea.value.length+' / 1024';
          const blocked=actionBlockReason(ctx.snapshot);
          submit.disabled=sending||ctx.hasPending?.()||ctx.snapshot?.archived||!!blocked||!textArea.value.trim()||textArea.value.length>1024;
          textArea.disabled=sending||!!blocked;
          if(blocked)notice.textContent=blocked;
        }
        updateShare=update;
        body.addEventListener('dispose',()=>{if(updateShare===update)updateShare=null;},{once:true});
        textArea.addEventListener('input',update);
        const form=h('form',{},h('label.f',{},h('span',{},'要转述的内容'),textArea,counter),
          h('div.msg.msg-private',{},h('div.msg-c',{},...paragraphs(part.text,{lead:h('span.secret-tag',{},'原私人消息')}))),
          notice,h('div.btn-row',{},submit));
        form.onsubmit=async event=>{
          event.preventDefault();
          if(sending||closed()||ctx.hasPending?.()||ctx.snapshot?.archived)return;
          if(actionBlockReason(ctx.snapshot)){notice.textContent=actionBlockReason(ctx.snapshot);update();return;}
          const value=textArea.value.trim();
          if(!value){notice.textContent='请先写下要转述的内容。';textArea.focus();return;}
          if(value.length>1024){notice.textContent='最多 1024 字。';textArea.focus();return;}
          sending=true;update();notice.textContent='正在提交…';
          try{
            await ctx.submit('story-share',{requestId:newUuid(),source,text:value});
            if(!closed()){feed.refreshShared({live:true});close();}
          }catch(error){
            if(closed())return;
            sending=false;notice.textContent='';update();
            if(ctx.hasPending?.())submit.disabled=true;
            ctx.report(error);
          }
        };
        body.append(form);update();
        textArea.focus();
      }});
  }
  mount.addEventListener('mounted',feed.mounted,{once:true});
  const sync=h('div.story-sync');
  const page=h('div.view.story-page');
  // The right pane is the overview or one open task; without either the story takes the width.
  const side=h('aside.story-side',{hidden:true,'aria-label':'主持停靠栏'});
  const taskColumn=h('div.task-pane',{hidden:true});
  function layoutSide(){
    side.hidden=!host||!overviewWanted&&!drawerHost?.isOpen();
    page.classList.toggle('has-side',!side.hidden);
  }
  const dmSidebar=host?createDmSidebar(mount,ctx,{dialogs,openCharacter:(id,button)=>openCharacter(id,null,button),
    onVisibility:visible=>{overviewWanted=visible;layoutSide();},onExpand:()=>drawerHost?.close()}):null;
  drawerHost=createDrawerHost(taskColumn,mount,{
    onOpen:()=>{dmSidebar?.setBlocked(true);layoutSide();},
    onClose:()=>{dmSidebar?.setBlocked(false);layoutSide();},
    onBack:dmSidebar?()=>dmSidebar.toggle.dispatchEvent(new Event('click')):null
  });
  tasks=host?createHostTasks(ctx,{isDisposed,pane:drawerHost}):null;
  side.append(...(dmSidebar?[dmSidebar.element]:[]),taskColumn);
  if(host)watchStoryProgress(feed.element,ctx,feed.updateProgress);
  for(const child of [feed.element,sync])mount.addEventListener('dispose',()=>child.dispatchEvent(new Event('dispose')),{once:true});
  const lifecycleBanner=h('section.story-notice',{'aria-label':'游戏状态',role:'status',hidden:true});
  function updateLifecycle(){
    const reason=actionBlockReason(ctx.snapshot),over=ctx.snapshot.lifecycle?.status==='game_over';
    lifecycleBanner.hidden=!reason;updateShare?.();
    lifecycleBanner.replaceChildren(...(reason?[h('div',{},h('strong',{},over?'游戏结束':'角色无法行动'),h('p',{},reason))]:[]),
      ...(over&&host?[h('a.btn.btn-primary',{href:'#/saves'},'DM 读档 / 重开')]:[]));
  }
  updateLifecycle();
  const sceneLine=h('span.story-scene');
  function updateSceneHeading(){
    sceneLine.textContent=[ctx.snapshot.scene?.title||ctx.snapshot.name,ctx.snapshot.chapter>1?'第 '+ctx.snapshot.chapter+' 章':''].filter(Boolean).join(' · ');
  }
  updateSceneHeading();
  const head=h('header.story-head',{},h('h1.story-title',{},'剧情'),
    h('div.story-sub',{},sceneLine,h('span.story-tools',{},membersButton,dmSidebar?.toggle)));
  page.append(h('section.story-main',{},h('div.story-top',{},head,sync,lifecycleBanner,combatReader?.element,tasks?.element),feed.element),side);
  mount.append(page);
  layoutSide();
  const connection=ctx.liveConnection?.();
  if(connection){
    const lifecycleKey=value=>JSON.stringify([value.lifecycle,actionBlockReason(value)]);
    let shown=snapshot.version,shownShared=latestSharedStory(snapshot),shownAcks=ctx.sharedAcknowledgements?.size||0,shownLifecycle=lifecycleKey(snapshot);
    watchDashboard(sync,connection,(value,{live=true}={})=>{
      if(value.id!==snapshot.id||isDisposed())return;
      updateSceneHeading();
      if(!value.party?.isHost)combatReader?.update();
      void dmSidebar?.update({live});
      if(lifecycleKey(value)!==shownLifecycle){shownLifecycle=lifecycleKey(value);updateLifecycle();feed.refreshShared({live});}
      if(latestSharedStory(value)!==shownShared||(ctx.sharedAcknowledgements?.size||0)!==shownAcks){shownShared=latestSharedStory(value);shownAcks=ctx.sharedAcknowledgements?.size||0;feed.refreshShared({live});}
      if(value.version>feed.loadedVersion())void feed.loadLatest(value.version,{live});
      if(value.version>shown){shown=value.version;updateSheet();updateMembers();void tasks?.refresh();}
      else void tasks?.reloadErrors(); // Model HTTP errors may arrive without changing the game version.
    });
  }
  await Promise.all([feed.loadLatest(snapshot.version),tasks?.refresh(),combatReader?.load(),dmSidebar?.load()]);
}

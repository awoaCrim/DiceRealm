// The host's task strip above the story: one compact row per real task — character reviews,
// rulings, consequences to settle, rolls the players still owe, and this campaign's failed
// model requests. Nothing is rendered when there is nothing to do. Choosing a row opens it in
// the docked task pane beside the story; the story itself is never covered.
import {h,kv} from './dom.js';
import {renderRulingContext,renderStoryFollowup} from './activity.js';
import {openCharacterReview} from './character-review.js';
import {rulingEditor} from './ruling-editor.js';
import {groupRulings,actorLabel,sceneLabel,outcomeLabels} from './tasking.js';
import {ruleName} from './rule-labels.js';
import {requestLogCard} from './request-log.js';

// `content` feeds check guidance only; undefined reads it on open, null skips it.
export function openIntentTask(ctx,isDisposed,ruling,content,host,{key=''}={}){
  const actor=actorLabel(ctx.snapshot,ruling.actorId);
  const scene=ruling.sceneId?sceneLabel(ctx.snapshot,ruling.sceneId):'';
  host.open({key,title:'人工裁定',flag:'等待你的决定',subtitle:actor+(scene?' · '+scene:''),
    render:async({body,isDisposed:closed})=>{
      const dead=()=>isDisposed()||closed();
      const current=ctx.snapshot.pendingRulings?.find(value=>value.id===ruling.id&&value.status==='pending');
      if(!current){body.append(h('p',{},'请求状态已变化，请刷新后重新处理。'));return;}
      body.append(renderRulingContext(ctx,current,{auto:true,inline:true,compact:true,isDisposed:dead}));
      if(content===undefined)try{content=await ctx.read('content');}catch{content=null;/* Manual ruling still works without guidance. */}
      if(dead())return;
      body.append(h('div.response',{},rulingEditor(ctx,current,{isDisposed:dead,content})),
        h('details.advanced',{},h('summary',{},'请求资料（技术细节）'),kv([['请求编号',current.id],['场景编号',current.sceneId||'']])));
    }});
}

export function openConsequenceTask(ctx,isDisposed,ruling,host,{key=''}={}){
  const actor=actorLabel(ctx.snapshot,ruling.actorId);
  host.open({key,title:'追加剧情变化',subtitle:actor+' · '+(outcomeLabels[ruling.outcome]||ruling.outcome||'已裁定'),
    render:({body,isDisposed:closed})=>{
      const current=ctx.snapshot.pendingRulings?.find(value=>value.id===ruling.id&&value.status==='resolved'&&!value.story&&value.outcome!=='reject');
      if(!current){body.append(h('p',{},'剧情后果状态已变化，请刷新后重新处理。'));return;}
      body.append(renderStoryFollowup(ctx,current,{isDisposed:()=>isDisposed()||closed(),auto:true,inline:true}));
    }});
}

function openRollTask(ctx,ruling,host,key){
  host.open({key,title:'等待掷骰',flag:'只读',subtitle:actorLabel(ctx.snapshot,ruling.actorId),render:({body})=>{
    body.append(h('section.ruling-intent',{},h('p.eyebrow',{},'玩家行动'),h('p.ruling-intent-text',{},ruling.text)),
      ruling.rationale?h('section.review-sec',{},h('h4.sec-h',{},'裁定说明'),h('p',{},ruling.rationale)):null,
      ruling.sceneId?h('p.small.muted',{},'场景：'+sceneLabel(ctx.snapshot,ruling.sceneId)):null,
      h('p.small.muted',{},'已由主持裁定，正等待对应玩家投掷；骰点由服务端结算。'));
  }});
}

const memberSummary=member=>{
  const ch=member.character||{};
  return [ch.name,[ruleName(ch.species),ruleName(ch.className),ch.level?ch.level+' 级':''].filter(Boolean).join(' ')].filter(Boolean).join(' · ');
};

export function createHostTasks(ctx,{isDisposed,pane}){
  let failed=0,more=false,readError='',loadingErrors=false;
  const rows=h('div.dock-rows'),count=h('span.badge'),done=h('span.dock-done');
  const element=h('section.task-dock',{'aria-label':'主持事项',hidden:true},h('div.dock-h',{},h('h2.dock-t',{},'主持事项'),count,done),rows);
  const rowButton=key=>[...rows.querySelectorAll('button')].find(button=>button.dataset.task===key);
  // The open row carries the selected state; rows are redrawn on every sync, so closing a task
  // returns focus to its current row.
  const taskPane={open:options=>{
    pane.open({...options,returnFocus:()=>rowButton(options.key),onClose:draw});
    draw();
  }};
  function openFailedRequests(key){
    taskPane.open({key,title:'请求错误日志',subtitle:'本战役尚未恢复的模型请求',render:({body})=>{
      const log=requestLogCard(body,{title:'失败请求列表',hint:'重试成功后移出提醒，完整尝试仍在请求日志中。',limit:10,failedOnly:true,showFilter:false,compact:true,
        list:params=>ctx.read('model-requests',{...params,unresolved:true}),detail:requestId=>ctx.read('model-request',{requestId})});
      void log.reload();
    }});
  }
  function tasks(){
    const snapshot=ctx.snapshot;
    if(!snapshot.party?.isHost)return {list:[],settled:0};
    const {pending,awaitingRoll,awaitingStory,settled}=groupRulings(snapshot.pendingRulings||[]);
    const reviews=(snapshot.party.members||[]).filter(m=>!m.revoked&&m.review?.status==='pending');
    const list=[
      ...reviews.map(m=>({key:'review:'+m.id,kind:'角色审核',summary:memberSummary(m),meta:`第 ${m.review.revision} 次提交`,action:'审阅',
        open:key=>openCharacterReview(ctx,m.id,taskPane,isDisposed,{key})})),
      ...pending.map(r=>({key:'ruling:'+r.id,kind:'需人工裁定',summary:'「'+r.text+'」',meta:[actorLabel(snapshot,r.actorId),r.sceneId?sceneLabel(snapshot,r.sceneId):''].filter(Boolean).join(' · '),action:'裁定',
        open:key=>openIntentTask(ctx,isDisposed,r,undefined,taskPane,{key})})),
      ...awaitingStory.map(r=>({key:'story:'+r.id,kind:'待落实后果',summary:r.text,meta:[actorLabel(snapshot,r.actorId),outcomeLabels[r.outcome]||r.outcome].filter(Boolean).join(' · '),action:'落实',
        open:key=>openConsequenceTask(ctx,isDisposed,r,taskPane,{key})})),
      ...awaitingRoll.map(r=>({key:'roll:'+r.id,kind:'等待掷骰',summary:r.text,meta:actorLabel(snapshot,r.actorId),action:'查看',
        open:key=>openRollTask(ctx,r,taskPane,key)}))];
    if(readError)list.push({key:'errors',kind:'请求错误',summary:'错误日志读取失败：'+readError,meta:'',action:'重试读取错误日志',
      open:key=>{void retryErrors().then(()=>{if(!isDisposed())openFailedRequests(key);});}});
    else if(failed)list.push({key:'errors',kind:'请求错误',summary:failed+(more?'+':'')+' 个模型请求失败，尚未恢复',meta:'完整尝试见请求日志',action:'查看',
      open:key=>{void retryErrors();openFailedRequests(key);}});
    return {list,settled:settled.length};
  }
  function draw(){
    if(isDisposed())return;
    const {list,settled}=tasks(),open=pane.currentKey(),focused=document.activeElement?.dataset?.task;
    element.hidden=!list.length;
    count.textContent=String(list.length);count.setAttribute('aria-label',list.length+' 项');
    done.textContent=settled?'已解决 '+settled+' 项':'';
    rows.replaceChildren(...list.map(task=>{
      const selected=task.key===open;
      return h('div.todo-row',{'data-task':task.key,class:selected?'is-open':null},
        h('span.kind',{},task.kind),h('span.sum',{title:task.summary},task.summary),h('span.tmeta',{},task.meta),
        h('button.btn.btn-sm',{type:'button','data-task':task.key,'aria-pressed':String(selected),onclick:()=>task.open(task.key)},selected?'处理中':task.action));
    }));
    if(focused)rowButton(focused)?.focus({preventScroll:true});
  }
  // A failed read waits for an explicit retry; background polling does not hide it.
  async function loadErrors(explicit){
    if(isDisposed()||loadingErrors||readError&&!explicit)return;
    loadingErrors=true;
    try{
      const page=await ctx.read('model-requests',{limit:10,failed:true,before:null,unresolved:true});
      if(isDisposed())return;
      failed=page.requests.length;more=page.nextBefore!=null;readError='';
    }catch(error){if(!isDisposed())readError=error.message||'错误日志读取失败';}
    finally{loadingErrors=false;draw();}
  }
  const retryErrors=()=>loadErrors(true);
  return {element,draw,
    refresh:()=>{draw();return retryErrors();},
    reloadErrors:()=>loadErrors(false),retryErrors,
    openConsequence:ruling=>openConsequenceTask(ctx,isDisposed,ruling,taskPane,{key:'story:'+ruling.id})};
}

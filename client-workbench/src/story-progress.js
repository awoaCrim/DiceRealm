import {h} from './dom.js';
import {createDialogHost} from './workspace-dialog.js';
import {renderTraceReader} from './story-trace-reader.js';
import {stepSummary} from './story-step-summary.js';
import {createPresentationMotion} from './presentation-motion.js';

const statuses={running:'执行中',delegated:'战斗主持正在继续',waiting:'等待回应或确认',interrupted:'执行已中断',unknown:'结果未确认',failed:'执行失败',cancelling:'正在停止',cancelled:'已停止',completed:'未取得最终输出'};
const tools={combat_delegate:'交接战斗主持',context_read:'读取当前情境',actions_list:'查找可用行动',actions_propose:'提出行动',checks_result:'读取检定结果',
  world_record:'保存叙事与世界记录',ask_player:'请求玩家回答',ruling_request:'请求主持裁定',skills_list:'查看工作方法',skills_read:'读取工作方法',
  rules_scope:'读取规则范围',rules_search:'查找规则',rules_read:'读取规则',memory_search:'查找历史',memory_read:'读取历史',
  dm_reference:'查阅主持参考',encounter_plan:'规划遭遇',treasure_generate:'生成战利品方案',
  memory_semantic_search:'检索相关经历',memory_digest:'读取历史摘要',world_search:'查找世界信息',world_routes:'读取路线',world_route_propose:'提出路线',map_request:'请求地图',
  map_select:'切换地图',map_state_read:'读取地图状态',token_spawn:'放置棋子',token_move:'移动棋子',token_update:'更新棋子',token_remove:'移除棋子',
  encounter_read:'读取遭遇',encounter_prepare:'准备遭遇',encounter_engage:'开始战斗',combat_continue:'推进战斗回合',combat_history_read:'读取战斗记录',
  check_request:'请求检定',ctx_search:'查找历史原文',ctx_expand:'展开历史原文',story_shared_read:'读取玩家公开的私密内容',opening_commit:'保存开场'};
const kinds={model:'模型调用',query:'查询',roll:'检定',write:'写入',error:'被拒绝'};
export function progressLabel(step){
  if(step.kind==='model')return '模型调用';
  if(step.kind==='final')return '保存最终输出';
  // The internal tool id only shows when there is no Chinese name for it.
  return step.tool?tools[step.tool]||'执行工具 · '+step.tool:'工具执行';
}

// Expanded timelines read only completed tools, retaining compact summaries.
// Full bodies and model replies remain in the independent step reader.
export function createStoryProgress(run,{hasNarrative=false,ctx,isDisposed=()=>false,live=false}={}){
  const head=h('p.progress-for'),label=h('span.progress-label'),title=h('summary',{},label,h('span.progress-mark',{},'仅主持')),steps=h('ol'),empty=h('p.small.muted');
  const recovery=h('p.small',{role:'status',hidden:true});
  const element=h('details.msg-progress.progress-run',{'data-run':run.id,'aria-label':'本轮步骤（仅主持）',open:!run.succeeded},title,head,recovery,steps,empty);
  const dialogs=createDialogHost(element);
  const motion=createPresentationMotion(element),summaries=new Map(),pending=new Set(),failures=new Set();
  const scope=()=>JSON.stringify([ctx?.snapshot?.id,ctx?.snapshot?.timelineId,ctx?.snapshot?.party?.selfActorId,ctx?.snapshot?.party?.isHost]);
  const ownScope=scope();let disposed=false;
  const valid=()=>!disposed&&!isDisposed()&&scope()===ownScope;
  element.addEventListener('dispose',()=>{disposed=true;summaries.clear();},{once:true});
  const summaryStatus=h('p.small.muted',{role:'status',hidden:true});
  const summaryRetry=h('button.linkish',{type:'button',hidden:true,onclick:()=>{failures.clear();void loadSummaries();}},'重试读取步骤摘要');
  element.append(summaryStatus,summaryRetry);
  let succeeded=run.succeeded,signature='',current=run;
  function paint(){
    const feed=element.isConnected?element.closest?.('.story-feed'):null;
    const feedTop=feed?.scrollTop,atBottom=feed&&feed.scrollHeight-feed.scrollTop-feed.clientHeight<48;
    const edge=feed?.getBoundingClientRect().top,anchor=feed&&[...feed.children].find(n=>n.getBoundingClientRect().bottom>edge),anchorTop=anchor?.getBoundingClientRect().top;
    const top=steps.scrollTop,focus=document.activeElement?.dataset?.step;
    const active=current.status==='running'||current.status==='cancelling';
    steps.replaceChildren(...current.steps.map(step=>{
      const summary=summaries.get(step.number)||stepSummary(step,null,progressLabel(step));
      const retried=summary.category==='error'&&current.steps.some(later=>later.number>step.number&&later.tool===step.tool);
      const text=summary.text+(retried?'，已重试':''),working=active&&step.status!=='done';
      return h('li',{'data-state':step.status,'data-category':retried?'retry':summary.category,'aria-current':working?'step':'false'},
        h('span.step-kind',{},retried?'被拒后重试':kinds[summary.category]),
        h('span.progress-step',{},text),
        h('span.progress-state',{},step.status!=='done'?(active?'进行中':'未完成'):summary.state),
        ctx?h('button.step-more',{type:'button','data-step':String(step.number),'aria-label':'步骤详情：'+text,onclick:()=>open(step.number)},'详情'):null);
    }));
    if(focus)steps.querySelector('[data-step="'+focus+'"]')?.focus({preventScroll:true});
    steps.scrollTop=top;steps.hidden=!current.steps.length;empty.hidden=!!current.steps.length;
    empty.textContent=active?'等待执行第一步…':'尚无已记录的执行步骤。';
    summaryStatus.hidden=!failures.size;summaryRetry.hidden=!failures.size;
    summaryStatus.textContent=failures.size?'部分步骤摘要暂未读到，可重试或点步骤查看详情。':'';
    if(feed)feed.scrollTop=atBottom?feed.scrollHeight:feedTop+(anchor?anchor.getBoundingClientRect().top-anchorTop:0);
  }
  async function loadSummaries(){
    if(!valid()||!element.open||!ctx?.snapshot?.party?.isHost)return;
    await Promise.all(current.steps.filter(s=>s.kind==='tool'&&s.status==='done'&&!summaries.has(s.number)&&!pending.has(s.number)&&!failures.has(s.number)).map(async step=>{
      pending.add(step.number);
      try{
        const detail=await ctx.read('adventure-step',{actorId:run.actorId,actionId:run.actionId,number:step.number});
        if(!valid())return;
        if(detail.runId!==run.id||detail.actionId!==run.actionId||detail.actorId!==run.actorId||detail.number!==step.number||detail.kind!=='tool'||detail.tool!==step.tool||detail.status!=='done')throw Error('步骤不匹配');
        summaries.set(step.number,stepSummary(step,detail,progressLabel(step)));
      }catch{if(valid())failures.add(step.number);}
      finally{pending.delete(step.number);if(valid())paint();}
    }));
  }
  element.addEventListener('toggle',()=>{if(element.open)void loadSummaries();});
  function open(selected){
    if(!ctx||!valid())return;
    dialogs.open({title:'执行详情 · '+current.actorName,returnFocus:()=>selected==='http'?http:steps.querySelector('[data-step="'+selected+'"]'),
      render:state=>renderTraceReader(state.body,{ctx,run:current,selected,label:progressLabel,isDisposed:()=>isDisposed()||state.isDisposed()})});
  }
  const http=ctx?h('button.linkish.progress-http',{type:'button',onclick:()=>open('http')},'查看本轮 HTTP 请求'):null;
  if(http)element.append(http);
  function update(value,{hasNarrative=false,live=false}={}){
    if(value.succeeded&&!succeeded)element.open=false;
    succeeded=value.succeeded;current=value;
    const text='本轮步骤 · '+value.steps.length+' 步 · '+(value.recovery==='blocked'?'原委派权限已失效':value.recovery?'等待恢复交接':succeeded?'已完成':statuses[value.status]);
    const active=value.status==='running'||value.status==='cancelling';
    element.dataset.active=String(active);
    if(label.textContent!==text){motion.stop();label.textContent=text;}
    recovery.hidden=!value.notice;recovery.textContent=value.notice||'';
    head.hidden=hasNarrative;head.textContent=(active?'主持处理中 · ':'')+'主持回应 '+value.actorName;
    const next=JSON.stringify([value.status,value.steps]);
    if(next!==signature){
      signature=next;paint();
      motion.stop();label.textContent=text;
      if(live&&active){
        const indicator=h('span.progress-indicator',{'aria-hidden':'true'});label.append(indicator);motion(indicator,'working');
      }else if(live)motion(title,'change');
    }
    void loadSummaries();
  }
  update(run,{hasNarrative,live});return {element,update,close:dialogs.close,dispose:()=>element.dispatchEvent(new Event('dispose'))};
}
export function storyProgressMessage(run,options={}){return createStoryProgress(run,options).element;}

// A separate host-only read: model/tool steps can change without advancing the game version.
// The feed owns placement; this watcher only owns polling and its read-error recovery.
export function watchStoryProgress(mount,ctx,onUpdate,{schedule=setTimeout,cancel=clearTimeout,delay=1500}={}){
  const message=h('p.small',{role:'status'});
  const retry=h('button.btn.btn-ghost',{type:'button',hidden:true,onclick:()=>poll()},'重试读取进度');
  const notice=h('div.progress-sync',{hidden:true},message,retry);mount.append(notice);
  let disposed=false,loading=false,timer=null,signature='',resumed=false;
  function later(){if(!disposed)timer=schedule(()=>{timer=null;if(globalThis.document?.hidden)later();else poll();},delay);}
  function clear(){signature='';onUpdate([]);notice.hidden=true;}
  async function poll(){
    if(disposed||loading)return;
    if(timer!=null){cancel(timer);timer=null;}
    if(!ctx.snapshot?.party?.isHost){clear();return;}
    loading=true;retry.disabled=true;
    try{
      const value=await ctx.read('adventure-progress');if(disposed)return;
      if(!ctx.snapshot?.party?.isHost){clear();return;}
      const visible=value.runs,next=JSON.stringify(visible);
      if(next!==signature){const live=!!signature&&!resumed;signature=next;onUpdate(visible,{live});}resumed=false;
      notice.hidden=true;message.textContent='';retry.hidden=true;later();
    }catch(error){
      if(disposed)return;
      if(error.code==='harness_campaign_required'){clear();return;}
      resumed=true;notice.hidden=false;message.textContent='进度同步已暂停：'+error.message;retry.hidden=false;
    }finally{loading=false;if(!disposed)retry.disabled=false;}
  }
  mount.addEventListener('dispose',()=>{disposed=true;if(timer!=null)cancel(timer);},{once:true});
  if(ctx.snapshot?.party?.isHost)void poll();
  return {poll};
}

import {h,fmtTime} from './dom.js';
import {requestDetail,outcomeLabel} from './request-log.js';
import {progressLabel} from './story-progress.js';

const parse=value=>{try{return JSON.parse(value);}catch{return value;}};
function valueBlock(title,value){
  const content=typeof value==='string'?parse(value):value;
  return h('section.trace-section',{},h('h4',{},title),content==null?h('p.muted',{},'尚无已保存的内容。'):
    h('pre', {class:typeof content==='string'?'req-text':'req-json'},typeof content==='string'?content:JSON.stringify(content,null,2)));
}
// Technical view: keep the tool id next to its Chinese name for matching request bodies.
function callTitle(name){
  const label=progressLabel({tool:name});
  return label.endsWith(name)?'调用 '+name:'调用 '+label+'（'+name+'）';
}
function stepBody(detail){
  const result=detail.response;
  const body=h('div.trace-step-detail',{},h('p.small.muted',{},detail.status==='done'?'已保存的执行结果':'此步骤尚未完成；可刷新读取，刷新不会重新执行。'));
  if(detail.kind==='model'){
    body.append(h('p.small.muted',{},'本次模型的公开输出。发送的完整提示词与上下文见「HTTP 请求」。'));
    if(result){
      if(result.text)body.append(valueBlock('模型回复',result.text));
      for(const call of result.toolCalls||[])body.append(valueBlock(callTitle(call.name),call.arguments));
      body.append(h('p.small.muted',{},`输入 ${result.inputTokens} · 输出 ${result.outputTokens} Token`));
    }else body.append(valueBlock('模型回复',null));
  }else{
    body.append(detail.request==null?h('p.small.muted',{},'旧记录未保存可核对的调用参数。'):valueBlock('调用参数',detail.request));
    if(result?.isError)body.append(h('p.error-box',{},'工具返回错误，不能视为执行成功。'));
    body.append(valueBlock('返回内容',result?.content??null));
    if(result?.stop)body.append(h('p.small.muted',{},'本步骤结束了这一段执行。'));
  }
  return body;
}

// The dialog owns a bounded navigation list and one full-width reading pane.
// No long request bodies or nested scrolling JSON are inserted into the chat feed.
export function renderTraceReader(body,{ctx,run,selected=1,isDisposed,label}){
  const nav=h('div.trace-nav',{'aria-label':'选择执行步骤'}),reader=h('div.trace-reading',{'aria-live':'polite'});
  const status=h('p.small.muted',{role:'status'});
  const stepTab=h('button.btn',{type:'button',onclick:()=>showSteps()},'步骤详情');
  const httpTab=h('button.btn',{type:'button',onclick:()=>showRequests()},'HTTP 请求');
  const refreshList=h('button.btn.btn-ghost',{type:'button',onclick:()=>loadRequests(true)},'刷新列表');
  const content=h('div.trace-layout',{},nav,reader);
  body.classList.add('trace-reader');body.append(h('div.trace-toolbar',{},stepTab,httpTab,refreshList),status,content);
  let mode='',generation=0,requests=[],next=null,listLoaded=false,listBusy=false,selectedRequestId=null;
  const cache=new Map();
  function select(button){for(const node of nav.querySelectorAll('button'))node.setAttribute('aria-pressed',String(node===button));}
  function tabs(value){mode=value;refreshList.hidden=value!=='http';stepTab.setAttribute('aria-pressed',String(value==='steps'));httpTab.setAttribute('aria-pressed',String(value==='http'));}
  async function readStep(step,button,refresh=false){
    select(button);const own=++generation;reader.replaceChildren(h('p.muted',{},'正在读取…'));status.textContent='';
    try{
      const key='step:'+step.number;let detail=refresh?null:cache.get(key);
      if(!detail)detail=await ctx.read('adventure-step',{actorId:run.actorId,actionId:run.actionId,number:step.number});
      if(isDisposed()||own!==generation)return;
      if(detail.runId!==run.id||detail.actorId!==run.actorId||detail.actionId!==run.actionId||detail.number!==step.number)throw new Error('详情不属于此执行步骤。');
      if(detail.status==='done')cache.set(key,detail);
      reader.replaceChildren(h('div.trace-reading-head',{},h('h3',{},`${step.number}. ${label({...step,tool:detail.tool})}`),
        h('button.btn.btn-ghost',{type:'button',onclick:()=>readStep(step,button,true)},'刷新')),stepBody(detail));
      reader.scrollTop=0;
    }catch(error){if(!isDisposed()&&own===generation)reader.replaceChildren(h('p.error-box',{},error.message),h('button.btn',{type:'button',onclick:()=>readStep(step,button,true)},'重试读取'));}
  }
  function showSteps(){
    ++generation;tabs('steps');status.textContent='';nav.setAttribute('aria-label','选择执行步骤');
    nav.replaceChildren(...run.steps.map(step=>{
      const button=h('button.trace-choice',{type:'button','data-step':String(step.number),onclick:()=>readStep(step,button)},
        h('span',{},`${step.number}. ${label(step)}`),h('span.small.muted',{},step.status==='done'?'已完成':'尚未完成'));return button;
    }));
    const index=Math.max(0,run.steps.findIndex(step=>step.number===selected));
    if(run.steps[index])void readStep(run.steps[index],nav.children[index]);else reader.replaceChildren(h('p.muted',{},'尚无执行步骤。'));
  }
  async function readRequest(summary,button){
    selectedRequestId=summary.id;select(button);const own=++generation;reader.replaceChildren(h('p.muted',{},'正在读取请求…'));
    try{
      const key='http:'+summary.id;let detail=cache.get(key);
      if(!detail)detail=await ctx.read('model-request',{requestId:summary.id,publicOnly:true});
      if(isDisposed()||own!==generation)return;
      if(detail.summary.runId!==run.id)throw new Error('请求不属于本轮行动。');
      if(detail.summary.finished)cache.set(key,detail);
      reader.replaceChildren(requestDetail(detail,{publicOnly:true}));reader.scrollTop=0;
    }catch(error){if(!isDisposed()&&own===generation)reader.replaceChildren(h('p.error-box',{},error.message),h('button.btn',{type:'button',onclick:()=>readRequest(summary,button)},'重试读取'));}
  }
  function drawRequests(){
    nav.replaceChildren(...requests.map(summary=>{
      const button=h('button.trace-choice',{type:'button','aria-pressed':String(summary.id===selectedRequestId),onclick:()=>readRequest(summary,button)},
        h('span',{},fmtTime(summary.startedAt)),h('span.small.muted',{},outcomeLabel(summary)+' · 第 '+summary.attempt+' 次尝试'));return button;
    }));
    if(next!=null)nav.append(h('button.btn.btn-ghost',{type:'button',onclick:()=>loadRequests()},'更早的请求'));
  }
  async function loadRequests(reset=false){
    if(listBusy||isDisposed())return;listBusy=true;status.textContent='正在读取本轮请求…';
    try{
      const page=await ctx.read('model-requests',{runId:run.id,limit:50,before:reset?null:next});
      if(isDisposed())return;
      if(page.requests.some(r=>r.runId!==run.id))throw new Error('请求列表不属于本轮行动。');
      requests=reset?page.requests:[...requests,...page.requests];next=page.nextBefore;listLoaded=true;
      if(mode!=='http')return;
      drawRequests();status.textContent='HTTP 日志保留全局最近 300 条，最新在前；过期日志不影响已保存的工具步骤。';
      if(requests.length){
        if(reset||selectedRequestId==null){const index=Math.max(0,requests.findIndex(r=>r.id===selectedRequestId));void readRequest(requests[index],nav.children[index]);}
      }else reader.replaceChildren(h('p.muted',{},'没有保留本轮 HTTP 请求。'));
    }catch(error){if(!isDisposed()&&mode==='http'){status.textContent=error.message;reader.replaceChildren(h('button.btn',{type:'button',onclick:()=>loadRequests(reset)},'重试读取请求列表'));}}
    finally{listBusy=false;}
  }
  function showRequests(){
    ++generation;tabs('http');nav.setAttribute('aria-label','选择模型请求');nav.replaceChildren();reader.replaceChildren();
    status.textContent='HTTP 日志保留全局最近 300 条，最新在前。';
    if(!listLoaded)void loadRequests(true);else{drawRequests();if(requests.length)void readRequest(requests[0],nav.children[0]);}
  }
  if(selected==='http')showRequests();else showSteps();
}

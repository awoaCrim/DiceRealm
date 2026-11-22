// LLM request log: what was sent to the model, what came back, how long it took.
// Admin reads every request; a campaign host reads only that campaign's requests.
import {h,card,kv,fmtTime,pageHead} from './dom.js';
import {createDialogHost} from './workspace-dialog.js';
import {describeRequest,describeResponse} from './request-body.js';

export const clientLabels={GeminiHarnessModel:'冒险引擎 · Gemini',OpenAiHarnessModel:'冒险引擎 · OpenAI 兼容',OpenAiText:'行动理解/叙事（旧接口）',OpenAiPreparation:'内容整理',PrivateStoryRetellings:'快速转述',ConfiguredHarnessHistorian:'历史整理'};
const clientLabel=client=>clientLabels[client]||client;
const pretty=text=>{try{return JSON.stringify(JSON.parse(text),null,2);}catch{return text;}};
export function outcomeLabel(r){
  if(!r.finished)return '进行中…';
  if(r.error)return r.error;
  return 'HTTP '+r.status;
}
const failed=r=>r.finished&&!(r.status>=200&&r.status<300);
const seconds=ms=>ms==null?'—':(ms/1000).toFixed(1)+' 秒';

function copyButton(label,text){
  const button=h('button.btn.btn-ghost',{type:'button'},label);
  button.addEventListener('click',async()=>{
    try{await navigator.clipboard.writeText(text);button.textContent='已复制';}
    catch{button.textContent='复制失败，请查看原文手动选择';}
  });
  return button;
}
function item(entry){
  const parts=[entry.label?h('p.req-item-label',{},entry.label):null];
  if(entry.text)parts.push(h('pre.req-text',{},entry.text));
  if(entry.json!==undefined)parts.push(h('pre.req-json',{},JSON.stringify(entry.json,null,2)));
  if(!entry.text&&entry.json===undefined)parts.push(h('p.small.muted',{},'（空）'));
  return h('div.req-item',{},...parts);
}
function sections(list){
  return list.map(section=>h('section.req-section',{},
    h('h4',{},section.title,section.note?h('span.hint',{},' '+section.note):null),...section.items.map(item)));
}
// Detail view shared by the global log and the campaign panel.
export function requestDetail(detail,{campaignName=id=>id,publicOnly=false,initialTab='response'}={}){
  const s=detail.summary;
  // Story callers request the server's publicOnly projection; raw diagnostics remain separate.
  const request=detail.requestBody,response=detail.responseBody;
  const header=kv([['时间',fmtTime(s.startedAt)],['来源',clientLabel(s.client)],s.campaignId?['战役',campaignName(s.campaignId)]:null,
      s.input?['玩家行动',s.input]:null,['第几次尝试',String(s.attempt)],['地址',h('span.mono',{},s.method+' '+s.url)],
      ['HTTP 结果',outcomeLabel(s)],['耗时',seconds(s.durationMs)],['大小',`请求 ${s.requestBytes} 字节 · 响应 ${s.responseBytes??'—'} 字节`]]);
  const pane=h('div'),tabs=h('div.trace-toolbar');
  function bodySections(text,isRequest){
    const content=text?sections(isRequest?describeRequest(text):describeResponse(text)):
      [h('p.muted',{},isRequest?'没有保留请求正文。':s.finished?'没有可显示的响应正文。':'尚未收到响应。')];
    if(publicOnly||!text)return content;
    const reading=h('div',{},...content),modes=h('div.trace-toolbar');
    function chooseRaw(raw){
      structured.setAttribute('aria-pressed',String(!raw));original.setAttribute('aria-pressed',String(raw));
      reading.replaceChildren(...(raw?[h('pre.req-json',{},pretty(text))]:content));
    }
    const structured=h('button.btn',{type:'button',onclick:()=>chooseRaw(false)},'分段内容');
    const original=h('button.btn',{type:'button',onclick:()=>chooseRaw(true)},isRequest?'原始请求 JSON':'原始响应');
    modes.append(structured,original,copyButton(isRequest?'复制请求原文':'复制响应原文',text));
    chooseRaw(false);
    return [modes,reading];
  }
  const choices=[['响应',()=>bodySections(response,false)],['请求',()=>bodySections(request,true)],['概况',()=>[header]]];
  function select(index){
    for(const [i,button] of [...tabs.children].entries())button.setAttribute('aria-pressed',String(i===index));
    pane.replaceChildren(...choices[index][1]());
    pane.setAttribute('data-tab',choices[index][0]);
  }
  tabs.append(...choices.map(([label],i)=>h('button.btn',{type:'button',onclick:()=>select(i)},label)));
  select(initialTab==='request'?1:0);
  return h('div.request-detail',{},tabs,pane);
}
function compactRow(r,open){
  return h('li',{class:failed(r)?'req-failed':null},
    h('div.request-list-head',{},h('span.small.muted',{},fmtTime(r.startedAt)+' · 第 '+r.attempt+' 次'),h('button.btn.btn-ghost',{type:'button',onclick:()=>open(r)},'查看')),
    r.input?h('div',{},'“'+r.input+'”'):null,h('div.small',{},outcomeLabel(r)+' · '+seconds(r.durationMs)));
}
function row(r,open,{campaignName}){
  return h('tr',{class:failed(r)?'req-failed':null},
    h('td',{},fmtTime(r.startedAt)),
    h('td',{},h('div',{},clientLabel(r.client)),r.campaignId?h('div.small.muted',{},campaignName(r.campaignId)):null,
      r.input?h('div.small',{},'“'+r.input+'”'):null),
    h('td',{},String(r.attempt)),h('td',{},seconds(r.durationMs)),h('td',{},outcomeLabel(r)),
    h('td',{},h('button.btn.btn-ghost',{type:'button',onclick:()=>open(r)},'查看')));
}
// list(params) -> {requests,nextBefore}; detail(id) -> {summary,requestBody,responseBody}.
export function requestLogCard(mount,{list,detail,campaignName=id=>id,title='请求记录',hint='',limit=50,failedOnly=false,showFilter=true,compact=false,hideEmpty=false,onVisibility=()=>{},initialTab='response',inline=false}){
  let disposed=false,busy=false,rows=[],next=null,readError=false,selectedId='',selectionGeneration=0;
  mount.addEventListener('dispose',()=>{disposed=true;},{once:true});
  const dialogs=createDialogHost(mount),body=h('tbody'),status=h('p.small.muted',{role:'status'});
  const filter=h('input',{type:'checkbox',checked:failedOnly,'aria-label':'只看 HTTP 失败的请求'});
  const reload=h('button.btn',{type:'button',onclick:()=>load(true)},'刷新');
  reload.hidden=inline;
  const older=h('button.btn.btn-ghost',{type:'button',hidden:true,onclick:()=>load(false)},'更早的记录');
  const inlineList=h('nav.request-index',{'aria-label':'选择模型请求'}),inlineReader=h('section.request-reading',{'aria-label':'所选请求详情','aria-live':'polite'});
  filter.addEventListener('change',()=>load(true));
  async function readDetail(summary){
    const value=await detail(summary.id);
    if(value.summary.id!==summary.id||value.summary.campaignId!==summary.campaignId
      ||(summary.runId&&value.summary.runId!==summary.runId))throw Error('详情不属于选中的请求。');
    return value;
  }
  async function selectRequest(summary){
    if(disposed)return;
    selectedId=summary.id;const own=++selectionGeneration;
    for(const button of inlineList.children)button.setAttribute('aria-pressed',String(button.dataset.requestId===String(selectedId)));
    inlineReader.replaceChildren(h('p.muted',{},'正在读取请求…'));inlineReader.scrollTop=0;
    try{
      const value=await readDetail(summary);
      if(disposed||own!==selectionGeneration)return;
      inlineReader.replaceChildren(h('h2',{},clientLabel(summary.client)),requestDetail(value,{campaignName,initialTab}));
    }catch(error){
      if(!disposed&&own===selectionGeneration)inlineReader.replaceChildren(h('p.error-box',{},error.message),
        h('button.btn',{type:'button',onclick:()=>selectRequest(summary)},'重试读取'));
    }
  }
  function drawInline(){
    inlineList.replaceChildren(...rows.map(summary=>h('button.trace-choice',{
      type:'button','data-request-id':summary.id,onclick:()=>selectRequest(summary)},
      h('strong.request-excerpt',{},summary.input||clientLabel(summary.client)),
      h('span.small.muted',{},fmtTime(summary.startedAt)),
      summary.input?h('span.small.muted',{},clientLabel(summary.client)):null,
      summary.campaignId?h('span.small.muted',{},campaignName(summary.campaignId)):null,
      h('span.status-tag',{'data-state':failed(summary)?'error':summary.finished?'ok':'busy'},outcomeLabel(summary)+' · '+seconds(summary.durationMs)))));
    const selected=rows.find(summary=>summary.id===selectedId)||rows[0];
    if(selected)void selectRequest(selected);
    else {selectedId='';selectionGeneration++;inlineReader.replaceChildren(h('p.empty',{},'暂无可查看的请求。'));}
  }
  function open(r){
    dialogs.open({title:'请求详情',render:({body:target,isDisposed})=>{
      const nav=h('div.trace-nav',{'aria-label':'选择模型请求'});
      const reader=h('div.trace-reading',{'aria-live':'polite'});
      let generation=0;
      async function readRequest(summary,button){
        const own=++generation;
        for(const node of nav.children)node.setAttribute('aria-pressed',String(node===button));
        reader.replaceChildren(h('p.muted',{},'正在读取请求…'));
        reader.scrollTop=0;
        try{
          const value=await readDetail(summary);
          if(isDisposed()||own!==generation)return;
          reader.replaceChildren(h('div.trace-reading-head',{},
            h('h3',{},clientLabel(summary.client)+' · '+fmtTime(summary.startedAt)),
            h('button.btn.btn-ghost',{type:'button',onclick:()=>readRequest(summary,button)},'刷新')),
            requestDetail(value,{campaignName,initialTab}));
        }catch(error){
          if(!isDisposed()&&own===generation)reader.replaceChildren(h('p.error-box',{},error.message),
            h('button.btn',{type:'button',onclick:()=>readRequest(summary,button)},'重试读取'));
        }
      }
      // Freeze the loaded list for this window; background polling must not replace its selection.
      nav.append(...rows.map(summary=>{
        const button=h('button.trace-choice',{type:'button','aria-pressed':'false',onclick:()=>readRequest(summary,button)},
          h('span',{},fmtTime(summary.startedAt)),
          h('span.small',{},clientLabel(summary.client)),summary.input?h('span.small',{},summary.input):null,
          summary.campaignId?h('span.small.muted',{},campaignName(summary.campaignId)):null,
          h('span.small.muted',{},outcomeLabel(summary)+' · 第 '+summary.attempt+' 次尝试'));
        return button;
      }));
      target.classList.add('trace-reader');
      target.append(h('p.small.muted',{},'更早记录可关闭窗口后加载。'),h('div.trace-layout',{},nav,reader));
      void readRequest(r,nav.children[rows.findIndex(summary=>summary.id===r.id)]);
    }});
  }
  async function load(reset){
    if(busy||disposed)return;busy=true;reload.disabled=older.disabled=true;
    const requestedFailed=filter.checked;
    try{
      const page=await list({limit,failed:requestedFailed,before:reset?null:next});if(disposed||filter.checked!==requestedFailed)return;
      rows=reset?page.requests:[...rows,...page.requests];next=page.nextBefore;
      if(inline)drawInline();else (compact?items:body).replaceChildren(...rows.map(r=>compact?compactRow(r,open):row(r,open,{campaignName})));
      readError=false;
      older.hidden=next==null;status.textContent=rows.length?'':(filter.checked?'没有 HTTP 失败的请求。':'还没有模型请求。');table.hidden=!rows.length;
    }catch(error){if(!disposed&&filter.checked===requestedFailed){readError=true;status.textContent=error.message;}}
    finally{
      busy=false;
      if(!disposed){
        reload.disabled=older.disabled=false;
        const visible=rows.length>0||readError;
        panel.hidden=hideEmpty&&!visible;onVisibility(visible);
        if(filter.checked!==requestedFailed)void load(true);
      }
    }
  }
  const items=h('ul.request-list');
  const table=inline?h('div.request-workspace',{},inlineList,inlineReader):compact?items:h('div.table-scroll',{},h('table.data.request-table',{},
    h('thead',{},h('tr',{},...['时间','来源','尝试','耗时','HTTP 结果',''].map(label=>h('th',{},label)))),body));
  const panel=card(title,hint,h('p.small.muted',{},'HTTP 成功不等于行动已保存；结果见剧情记录。'),h('div.btn-row',{},showFilter?h('label.check',{},filter,'只看 HTTP 失败'):null,reload),status,table,h('div.btn-row',{},older));
  if(inline)panel.classList.add('request-page-panel');
  panel.hidden=hideEmpty;mount.append(panel);
  return {reload:()=>load(true),poll:()=>readError?Promise.resolve():load(true)};
}

export async function renderRequestLog(mount,ctx){
  const view=h('div.view.request-page');mount.append(view);
  mount.addEventListener('dispose',()=>view.dispatchEvent(new Event('dispose')),{once:true});
  view.append(pageHead('请求日志','系统发出的每一次模型请求，最新在前；只保留最近 300 条。'));
  if(!ctx.account?.user.isAdmin){view.append(h('p.error-box',{},'只有管理员可以查看全部请求日志。'));return;}
  const api=ctx.accountApi(),names=new Map();
  try{for(const c of (await api.campaigns()).campaigns)names.set(c.id,c.name);}catch{/* Names are a convenience; ids still identify the campaign. */}
  const log=requestLogCard(view,{list:params=>api.modelRequests(params),detail:id=>api.modelRequest(id),campaignName:id=>names.get(id)||id,inline:true,title:''});
  await log.reload();
}

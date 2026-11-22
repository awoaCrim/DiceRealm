// world-memory.js — 系统自动记录并公开的人物 / 任务 / 地点 / 线索。
// 普通世界信息由服务器与输入流程自动维护：这里只读展示，不提供新建表单或审批队列。
// 唯一的写入口是主持人可选的逐条纠错（保留旧记录、版本与修订都冻结、理由必填）。
import {h,card,kv} from './dom.js';
import {newUuid} from './api.js';
import {draftKey,readDraft,writeDraft,clearDraft} from './drafts.js';
import {sceneLabel} from './tasking.js';

export const worldKindOrder=['npc','quest','place','clue'];
export const worldKindLabels={npc:'人物',quest:'任务',place:'地点',clue:'线索'};
export const worldStatusLabels={known:'已知',active:'进行中',resolved:'已了结'};

const statusLabel=status=>worldStatusLabels[status]||status||'未记录';

const recordValue=record=>({name:record.name||'',summary:record.summary||'',status:record.status||'known',hidden:record.hidden===true,reason:''});
const parseDraft=raw=>{try{const value=JSON.parse(raw);return value&&typeof value==='object'?value:null;}catch{return null;}};

// 单条纠错草稿：与已提交请求分开存放，冻结读取时的战役版本和记录修订。
// 轮询/重渲染只恢复未发送文字；服务端更新过记录时进入冲突，要求明确放弃后重载。
export class WorldMemoryDraft {
  constructor(scope,record,version){
    this.key=draftKey(scope,'world-memory:'+record.id);
    const saved=readDraft(this.key);
    const state=saved?parseDraft(saved):null;
    this.state=state&&state.dirty?state:this.fresh(record,version);
  }
  fresh(record,version){return {revision:newUuid(),version,recordRevision:record.revision,dirty:false,open:false,values:recordValue(record)};}
  remember(){if(!this.state.confirmed)writeDraft(this.key,JSON.stringify(this.state));}
  change(){this.state.dirty=true;this.state.revision=newUuid();this.remember();}
  conflicts(record,version){return this.state.dirty&&(this.state.recordRevision!==record.revision||this.state.version!==version);}
  submission(record){const v=this.state.values;return {expectedVersion:this.state.version,memoryId:record.id,revision:this.state.recordRevision,
    name:v.name.trim(),summary:v.summary.trim(),status:v.status,hidden:v.hidden===true,reason:v.reason.trim()};}
  normalize(sent){this.state.values={name:sent.name,summary:sent.summary,status:sent.status,hidden:sent.hidden,reason:sent.reason};this.remember();}
  discard(record,version){this.state=this.fresh(record,version);this.state.open=true;this.remember();}
  complete(revision){
    if(this.state.revision===revision){this.state.dirty=false;this.state.confirmed=true;}
    const raw=readDraft(this.key);if(!raw)return;
    // 迟到的成功只清除它自己那次修订，不能抹掉之后的新输入。
    const state=parseDraft(raw);
    if(state&&state.revision===revision)clearDraft(this.key);
  }
  get dirty(){return this.state.dirty;}
  get open(){return this.state.open;}
  get values(){return this.state.values;}
}

// 由共享传输层在回执确认（含原样重试成功）后调用；只清理匹配的那份草稿。
export function confirmWorldMemoryDraft(scope,payload){
  if(!payload?.memoryId||!payload.worldDraftRevision)return;
  const key=draftKey(scope,'world-memory:'+payload.memoryId),raw=readDraft(key);
  if(!raw)return;
  const state=parseDraft(raw);
  if(state&&state.revision===payload.worldDraftRevision&&state.version===payload.expectedVersion)clearDraft(key);
}

function bound(ctx,id){return (ctx.snapshot?.worldMemory||[]).find(m=>m.id===id)||null;}

function correctionForm(ctx,record,isDisposed,currentRecord=()=>bound(ctx,record.id),inline=false){
  const version=ctx.snapshot.version;
  const draft=new WorldMemoryDraft(ctx.scope||ctx.snapshot.id,record,version);
  const root=h(inline?'section.world-correct':'details.world-correct',inline?{}:{open:draft.open});
  const status=h('p.small',{role:'status'});
  const name=h('input',{type:'text',maxLength:80,'aria-label':`信息名称：${record.name}`});
  const summary=h('textarea',{rows:3,maxLength:800,'aria-label':`信息摘要：${record.name}`});
  const statusSelect=h('select',{'aria-label':`信息状态：${record.name}`},...Object.entries(worldStatusLabels).map(([value,text])=>h('option',{value},text)));
  const hidden=h('input',{type:'checkbox','aria-label':`对玩家隐藏：${record.name}`});
  const reason=h('textarea',{rows:2,maxLength:1000,'aria-label':`更正理由：${record.name}`});
  const save=h('button.btn.btn-primary',{type:'button','data-write':'true'},'保存更正（保留旧记录）');
  const discard=h('button.btn.btn-ghost',{type:'button'},'放弃草稿并载入当前记录');
  let busy=false,settled=false;
  const field=(label,input)=>h('label.f',{},h('span',{},label),input);
  function sync(){
    name.value=draft.values.name;summary.value=draft.values.summary;statusSelect.value=draft.values.status;
    hidden.checked=draft.values.hidden===true;reason.value=draft.values.reason;
  }
  function update(){
    const conflict=draft.conflicts(record,version);
    save.disabled=busy||settled||conflict||!draft.dirty;
    save.dataset.disabledBase=String(busy||settled||conflict||!draft.dirty);
    discard.hidden=settled||(!draft.dirty&&!conflict);
    discard.disabled=busy||settled;
    for(const input of [name,summary,statusSelect,hidden,reason])input.disabled=settled;
    status.textContent=settled?'更正已保存。较新的输入（如有）仍保留；请刷新当前记录后继续编辑。':conflict
      ? `记录已更新到第 ${record.revision} 次修订（草稿冻结在第 ${draft.state.recordRevision} 次、v${draft.state.version}）。请放弃草稿并载入当前记录后再更正。`
      : !draft.dirty?'尚未修改。更正会保留旧记录，只影响当前公开投影。':'有未保存的更正；关闭页面前请保存。';
  }
  const change=()=>{if(isDisposed()||settled)return;draft.change();update();};
  name.addEventListener('input',()=>{draft.values.name=name.value;change();});
  summary.addEventListener('input',()=>{draft.values.summary=summary.value;change();});
  statusSelect.addEventListener('change',()=>{draft.values.status=statusSelect.value;change();});
  hidden.addEventListener('change',()=>{draft.values.hidden=hidden.checked;change();});
  reason.addEventListener('input',()=>{draft.values.reason=reason.value;change();});
  discard.addEventListener('click',()=>{
    if(busy||settled||isDisposed())return;
    draft.discard(record,ctx.snapshot.version);root.open=true;sync();update();
  });
  save.addEventListener('click',async()=>{
    if(busy||settled||isDisposed()||ctx.hasPending())return;
    const current=currentRecord();
    if(draft.conflicts(current||record,ctx.snapshot.version)||ctx.snapshot.version!==version||current?.revision!==draft.state.recordRevision){
      // 版本或修订已变化：不自动重基，让使用者重新读取当前记录。
      status.textContent='记录或战役版本已更新，请放弃草稿并载入当前记录后再更正。';
      return;
    }
    if(!draft.values.name.trim()||!draft.values.summary.trim()){status.textContent='信息名称与摘要不能为空。';return;}
    if(!draft.values.reason.trim()){status.textContent='请填写更正理由，说明为什么修改这条公开信息。';return;}
    busy=true;update();
    const revision=draft.state.revision,recordId=record.id;
    const sent=draft.submission({...record,id:recordId});
    draft.normalize(sent); // 保留的草稿与服务端收到的正文完全一致
    try{
      await ctx.submit('world/correct',{...sent,worldDraftRevision:revision});
      settled=true;draft.complete(revision);
      // The record id survives a refresh; the local draft revision is local-only metadata.
      confirmWorldMemoryDraft(ctx.scope||ctx.snapshot.id,{memoryId:recordId,expectedVersion:sent.expectedVersion,worldDraftRevision:revision});
      if(!isDisposed())await ctx.refresh();
    }catch(error){if(!isDisposed())ctx.report(error);}
    finally{busy=false;if(!isDisposed())update();}
  });
  root.addEventListener('toggle',()=>{if(!isDisposed()&&!settled){draft.state.open=root.open;draft.remember();update();}});
  sync();update();
  root.append(h(inline?'h4':'summary',{},'纠正这条信息（可选）'),
    h('p.small.muted',{},'更正公开信息，保留旧记录与理由。'),
    h('div.world-fields',{},field('名称',name),field('状态',statusSelect),field('摘要',summary),
      h('label.check',{},hidden,h('span',{},'对玩家隐藏（仍保留在记录中）')),field('更正理由（必填）',reason)),
    status,h('div.btn-row',{},save,discard));
  return root;
}

function recordRow(ctx,record,host,isDisposed,currentRecord,dialogs){
  const scene=record.sceneId?sceneLabel(ctx.snapshot,record.sceneId):'',version=ctx.snapshot.version;
  const provenance=()=>kv([['记录编号',record.id||''],['修订',String(record.revision??0)],['来源',record.source||'—'],
    ['导入公开范围',record.visibility||'public'],['公开所需地点',record.revealSceneId||'—'],['原始行动序号',String(record.originSequence??0)],['最近更新序号',String(record.updatedSequence??0)]]);
  return h('article.world-record',{},
    h('header.world-record-head',{},
      h('h4.world-record-name',{},record.name||'（未命名信息）'),
      h('div.world-record-labels',{},h('span.world-record-status',{},statusLabel(record.status)),
        record.hidden||record.visibility==='host'?h('span.world-record-visibility',{},'仅主持可见'):
          record.visibility==='arrival'&&host?h('span.world-record-visibility',{},'到达指定地点后公开'):null)),
    h('p.world-record-summary',{},record.summary||'没有已记录的摘要。'),
    h('footer.world-record-footer',{},
      h('p.world-record-scene',{},scene?'关联地点：'+scene:'未关联已知地点'),
      dialogs?h('div.world-record-actions',{},
        dialogs.button('查看记录来源',({body})=>body.append(provenance())),
        host?dialogs.button('纠正这条信息',({body,isDisposed:closed})=>{
          if(isDisposed()||ctx.snapshot.version!==version){body.append(h('p',{},'记录依据已更新，请重新打开世界手记后再操作。'));return;}
          body.append(correctionForm(ctx,record,()=>isDisposed()||closed(),currentRecord,true));
        }):null):null),
    !dialogs?h('details.advanced',{},h('summary',{},'记录来源（技术资料）'),provenance()):null,
    host&&!dialogs?correctionForm(ctx,record,isDisposed,currentRecord):null);
}

export function worldMemoryCard(ctx,isDisposed=()=>false,{dialogs=null,selectedKind='npc',queryText=''}={}){
  const host=!!ctx.snapshot?.party?.isHost,version=ctx.snapshot?.version,campaign=ctx.snapshot?.id,scope=ctx.scope;
  const visible=m=>m&&(host||!m.hidden&&m.visibility!=='host'
    &&(m.visibility!=='arrival'||ctx.snapshot?.visitedScenes?.includes(m.revealSceneId)));
  const initial=(ctx.snapshot?.worldMemory||[]).filter(visible),total=ctx.snapshot?.worldMemoryPaging?.total??initial.length;
  const partial=total>initial.length;
  let entries=[],offset=0,next=null,busy=false,generation=0,remote=false,retired=false;
  let activeQuery=queryText,activeKind=worldKindOrder.includes(selectedKind)?selectedKind:'npc',selectedId='';
  const changedContext=()=>retired||isDisposed()||ctx.snapshot?.id!==campaign||ctx.scope!==scope||!!ctx.snapshot?.party?.isHost!==host;
  const expired=()=>changedContext()||ctx.snapshot?.version!==version;
  const id='world-memory-'+newUuid();
  const body=h('div.world-results',{id,role:'tabpanel',tabindex:0}),status=h('p.world-result-status',{role:'status'});
  const query=h('input',{type:'search',value:queryText,maxLength:120,'aria-label':'检索世界信息',placeholder:'检索当前类别的冒险记录'});
  const tabs=worldKindOrder.map((kind,index)=>h('button.btn',{id:id+'-'+kind,type:'button',role:'tab','aria-controls':id,
    onclick:()=>selectKind(kind),onkeydown:event=>{
      if(event.isComposing||event.keyCode===229)return;
      const target=event.key==='ArrowRight'?(index+1)%4:event.key==='ArrowLeft'?(index+3)%4:event.key==='Home'?0:event.key==='End'?3:null;
      if(target===null)return;
      event.preventDefault();tabs[target].focus();selectKind(worldKindOrder[target]);
    }},worldKindLabels[kind]));
  const search=h('button.btn',{type:'button'},'检索'),previous=h('button.btn.btn-ghost',{type:'button'},'上一页'),following=h('button.btn.btn-ghost',{type:'button'},'下一页');
  const refresh=h('button.btn.btn-ghost',{type:'button'},'刷新当前记录');
  query.id=id+'-query';
  // Category, search and refresh share one bar; the page tab above already names this panel.
  const tablist=h('div.world-tabs',{role:'tablist','aria-label':'世界信息类别'},...tabs);
  const controls=h('div.world-search',{},h('label',{for:query.id},'检索'),h('div.world-search-input',{},query,search),refresh);
  const paging=h('div.world-paging',{'aria-label':'世界信息分页'},previous,following);
  const root=card('','',h('div.world-toolbar',{},tablist,...(ctx.read?[controls]:[])),
    h('div.world-result-bar',{},status,...(ctx.read?[paging]:[])),body);
  root.classList.add('world-memory');
  function buttons(){
    search.disabled=busy||expired();
    previous.disabled=busy||expired()||offset===0;following.disabled=busy||expired()||next===null;
    query.disabled=busy;refresh.disabled=busy||!ctx.refresh;
    paging.hidden=offset===0&&next===null;
    body.setAttribute('aria-busy',String(busy));
    body.setAttribute('aria-labelledby',id+'-'+activeKind);
    tabs.forEach((tab,index)=>{
      const selected=worldKindOrder[index]===activeKind;
      tab.classList.toggle('active',selected);tab.setAttribute('aria-selected',String(selected));tab.tabIndex=selected?0:-1;tab.disabled=expired();
    });
  }
  function paint(count,recent=false){
    const rendered=generation;
    const dead=()=>changedContext()||rendered!==generation;
    const renderRecord=record=>recordRow(ctx,record,host,dead,remote?()=>dead()?null:entries.find(e=>e.id===record.id):undefined,dialogs);
    if(dialogs){
      const list=h('nav.world-record-list',{'aria-label':'选择世界记录'}),detail=h('section.world-record-detail',{'aria-label':'所选世界记录'});
      if(!entries.some(record=>record.id===selectedId))selectedId=entries[0]?.id||'';
      function select(record){
        if(dead())return;
        selectedId=record.id;
        for(const button of list.children)button.setAttribute('aria-pressed',String(button.dataset.recordId===selectedId));
        detail.replaceChildren(renderRecord(record));detail.scrollTop=0;
      }
      list.append(...entries.map(record=>h('button.world-record-choice',{type:'button','data-record-id':record.id,
        'aria-pressed':String(record.id===selectedId),onclick:()=>select(record)},
        h('strong',{},record.name||'（未命名信息）'),h('span.small.muted',{},record.summary||'没有已记录的摘要。'),
        h('span.status-tag',{},statusLabel(record.status)))));
      body.replaceChildren(list,detail);body.classList.add('world-catalog');
      const selected=entries.find(record=>record.id===selectedId);
      if(selected)select(selected);else detail.append(h('p.empty',{},'此类别暂无记录。'));
    }else body.replaceChildren(...entries.map(renderRecord));
    status.textContent=recent?'当前仅显示近期'+worldKindLabels[activeKind]+'，请检索完整记录。':entries.length
      ?`${worldKindLabels[activeKind]}：显示第 ${offset+1}–${offset+entries.length} 条，共 ${count} 条${activeQuery?'匹配记录':'可见记录'}。`
      :`${activeQuery?'没有符合条件的':'暂无'}${worldKindLabels[activeKind]}记录。${activeKind==='quest'?'剧本任务另见“剧本任务进度”。':''}`;
    buttons();
  }
  function localPage(start){
    const matches=initial.filter(record=>record.kind===activeKind&&(!activeQuery||(record.name+' '+record.summary).includes(activeQuery)));
    entries=matches.slice(start,start+32);offset=start;next=start+entries.length<matches.length?start+entries.length:null;
    remote=false;paint(matches.length,partial);
  }
  function selectKind(kind){
    if(expired()||kind===activeKind)return;
    activeKind=kind;void load(0,true);
  }
  async function load(start,newSearch=false){
    if(expired()&&!changedContext()){status.textContent='战役已有新进展，请先点「刷新当前记录」再检索或翻页。';buttons();return;}
    if(expired()||busy&&!newSearch)return;
    if(newSearch)activeQuery=query.value;
    const terms=activeQuery,type=activeKind,request=++generation;
    if(!ctx.read){localPage(start);return;}
    busy=true;entries=[];next=null;body.replaceChildren();buttons();
    status.textContent='正在读取'+worldKindLabels[type]+'记录…';
    try{
      const page=await ctx.read('world/memory',{expectedVersion:version,query:terms,kind:type,offset:start,limit:32,scope:host?'host':'public'});
      if(expired()||request!==generation)return;
      if(page.version!==version||page.scope!==(host?'host':'public')||page.entries.some(record=>record.kind!==type))throw new Error('世界信息已变化，请刷新当前记录。');
      entries=page.entries.filter(visible);offset=start;next=page.nextOffset;remote=true;
      paint(page.total);
    }catch(error){if(!expired()&&request===generation){status.textContent=error.message||'读取失败，请重新检索。';ctx.report?.(error);}}
    finally{if(request===generation){busy=false;if(!changedContext())buttons();}}
  }
  search.addEventListener('click',()=>{if(!busy)void load(0,true);});
  query.addEventListener('keydown',event=>{if(!busy&&event.key==='Enter'&&!event.isComposing&&event.keyCode!==229){event.preventDefault();void load(0,true);}});
  previous.addEventListener('click',()=>load(Math.max(0,offset-32)));following.addEventListener('click',()=>{if(next!==null)void load(next);});
  refresh.addEventListener('click',async()=>{
    if(busy||changedContext())return;
    if(dialogs){
      retired=true;generation++;
      const fresh=worldMemoryCard(ctx,isDisposed,{dialogs,selectedKind:activeKind,queryText:query.value});
      root.replaceWith(fresh);fresh.querySelector('input[type=search]')?.focus();return;
    }
    try{await ctx.refresh?.();}catch(error){if(!isDisposed())ctx.report?.(error);}
  });
  if(ctx.read&&(partial||queryText))void load(0,true);else localPage(0);
  return root;
}

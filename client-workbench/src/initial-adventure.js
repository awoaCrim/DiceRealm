import {h,card,confirmDialog,pageHead} from './dom.js';
import {newUuid} from './api.js';
import {readDraft,writeDraft,clearDraft,draftKey} from './drafts.js';
import {parseJsonObject} from './json-document.js';
import {renderAdventureLibrary} from './adventure-library.js';

const key=scope=>draftKey(scope,'initial-adventure');
function read(scope){const raw=readDraft(key(scope));return raw?JSON.parse(raw):{revision:0,adventure:'',prompt:'',methods:'[]'};}
export function confirmInitialAdventure(scope,endpoint,payload){
  if(endpoint!=='initial-adventure')return;
  const draft=read(scope);
  if(draft.revision===payload.setupDraftRevision)clearDraft(key(scope));
}
function methods(text){
  let value;try{value=JSON.parse(text);}catch{throw Error('工作方法须为 JSON 列表。');}
  if(!Array.isArray(value)||value.some(m=>!m||typeof m.id!=='string'||typeof m.description!=='string'||typeof m.content!=='string'||Object.keys(m).some(k=>!['id','description','content'].includes(k))))throw Error('每个工作方法须有 id、description 和 content；没有方法时保留 []。');
  return value;
}
// Reuses per-tab, per-seat draft memory and the shared pending journal. No new credential store.
export async function renderInitialAdventure(mount,ctx,{parseImport,downloadJson}){
  const scope=ctx.scope,version=ctx.snapshot.version;
  let draft=read(scope),disposed=false,confirming=false,submitting=false,settled=false;
  const current=()=>!disposed&&ctx.scope===scope;
  const status=h('p',{role:'status'});
  const inputs={};
  function save(field,value){
    if(!current()||settled)return;
    draft={...draft,[field]:value,revision:draft.revision+1};writeDraft(key(scope),JSON.stringify(draft));
  }
  function field(name,label,rows){
    const input=h('textarea',{rows,value:draft[name],'aria-label':label});inputs[name]=input;
    input.addEventListener('input',()=>save(name,input.value));
    const file=h('input',{type:'file',accept:name==='prompt'?'.txt,.md,text/plain':'.json,application/json','aria-label':'载入'+label+'文件'});
    file.addEventListener('change',async()=>{
      const chosen=file.files?.[0],revision=draft.revision;if(!chosen||!current()||settled)return;
      try{
        if(chosen.size>1024*1024)throw Error('文件最大 1 MiB。');
        const raw=await chosen.text();if(!current()||settled||draft.revision!==revision)return;
        save(name,raw);input.value=raw;status.textContent='已载入原文，尚未启用。';
      }catch(error){if(current())status.textContent=error.message;}
    });
    return h('label.f',{},h('span',{},label),input,file);
  }
  const submit=h('button.btn.btn-primary',{type:'button','data-write':'true','data-disabled-base':String(!!ctx.snapshot.archived),disabled:!!ctx.snapshot.archived,onclick:activate},'校验并启用首次设定');
  const library=h('section',{'aria-label':'剧本库'});
  const manual=h('section',{'aria-label':'手动导入'},
    card('手动导入剧本与叙事','启用后剧本固定，提示词可在「提示词」页修改。',
      field('adventure','剧本 JSON',8),field('prompt','叙事提示词原文',8),
      h('section',{},h('h4',{},'可选：工作方法（按需参考文档）'),
        h('p.small.muted',{},'模型按需读取；无工作方法时保留 []。'),field('methods','工作方法 JSON',5)),
      h('p.small',{},'草稿仅在本标签页内保留；刷新或关闭前请下载备份。'),
      h('div.btn-row',{},submit,h('button.btn',{type:'button',onclick:()=>downloadJson('initial-adventure-draft.json',{format:1,...draft})},'下载设定草稿')),status));
  // Most rooms start from the library; the long import form is its own tab, opened first
  // only when this tab already holds an import draft.
  const tabs=[['从剧本库选择',library],['手动导入',manual]].map(([label,panel])=>{
    const tab=h('button.btn',{type:'button',onclick:()=>choose(panel)},label);tab.panel=panel;return tab;
  });
  function choose(panel){
    for(const tab of tabs){const on=tab.panel===panel;tab.panel.hidden=!on;tab.classList.toggle('active',on);tab.setAttribute('aria-pressed',String(on));}
  }
  const view=h('div.view',{},pageHead('首次冒险设定','选择一个剧本开始这场战役。'),h('div.page-tabs',{},...tabs),library,manual);
  choose(draft.adventure||draft.prompt?manual:library);
  const backup=h('input',{type:'file',accept:'.json,application/json','aria-label':'载入设定草稿备份'});
  backup.addEventListener('change',async()=>{
    const chosen=backup.files?.[0],revision=draft.revision;if(!chosen||!current()||settled)return;
    try{
      if(chosen.size>2*1024*1024)throw Error('草稿备份过大。');
      const candidate=parseJsonObject(await chosen.text());
      if(candidate.format!==1||['adventure','prompt','methods'].some(k=>typeof candidate[k]!=='string'))throw Error('草稿备份不完整。');
      if(!current()||settled||revision!==draft.revision)return;
      const accepted=await confirmDialog({title:'载入设定草稿？',lines:['将替换当前尚未发送的表单，不启用战役。'],confirmText:'载入'});
      if(!accepted||!current()||settled||revision!==draft.revision)return;
      for(const name of ['adventure','prompt','methods']){save(name,candidate[name]);inputs[name].value=draft[name];}
    }catch(error){if(current())status.textContent=error.message;}
  });
  manual.append(card('恢复下载的设定草稿','只载入编辑稿，不启用战役。',backup));mount.append(view);
  mount.addEventListener('dispose',()=>{disposed=true;library.dispatchEvent(new Event('dispose'));},{once:true});
  await renderAdventureLibrary(library,ctx);
  async function activate(){
    if(!current()||confirming||submitting||settled||ctx.hasPending?.()||ctx.snapshot.archived)return;
    const captured=draft;
    try{
      const adventure=parseImport(captured.adventure,'adventure'),list=methods(captured.methods);
      if(!captured.prompt.trim())throw Error('请提供自己的叙事提示词。');
      const payload={requestId:newUuid(),expectedVersion:version,adventure,prompt:captured.prompt,methods:list,setupDraftRevision:captured.revision};
      confirming=true;
      const accepted=await confirmDialog({title:'启用首次冒险设定？',lines:[adventure.name,'剧本将固定到当前房间；已有队员与审核状态保留。启用不生成图片、不调用模型。'],confirmText:'确认启用'});
      confirming=false;
      if(!accepted||!current()||draft!==captured||read(scope).revision!==captured.revision||ctx.snapshot.version!==version||ctx.hasPending?.())return;
      submitting=true;submit.disabled=true;
      await ctx.submit('initial-adventure',payload);
      settled=true;confirmInitialAdventure(scope,'initial-adventure',payload);
      if(!current())return;
      status.textContent='首次设定已启用。';await ctx.refresh();
    }catch(error){if(current())status.textContent=(settled?'已启用，但刷新失败：':'')+error.message;}
    finally{confirming=false;submitting=false;if(current())submit.disabled=settled||!!ctx.snapshot.archived||!!ctx.hasPending?.();}
  }
}

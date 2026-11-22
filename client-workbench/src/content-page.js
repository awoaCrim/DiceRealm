// 剧本、地图图册与提示词：首次设定导入剧本和叙事提示词；启用后查看剧本、图册与结构化提示词。
import {renderInitialAdventure} from './initial-adventure.js';
import {h,card,downloadJson,pageHead} from './dom.js';
import {parseJsonObject} from './json-document.js';
import {adventureReader} from './adventure-reader.js';
import {renderPromptEditor} from './prompt-editor.js';
import {splitPrompt} from './prompt-sections.js';
import {renderAdventureLibrary} from './adventure-library.js';
import {renderMapReader} from './map-reader.js';

export const maximumImportBytes=1024*1024;

export function parseImport(text,kind){
  if(kind!=='adventure')throw new Error('未知导入类型。');
  if(new TextEncoder().encode(text).length>maximumImportBytes)throw new Error('导入文件最大 1 MiB。');
  const doc=parseJsonObject(text);
  if(doc.formatVersion!==1)throw new Error('formatVersion 必须为 1。');
  for(const field of ['id','version','name'])if(typeof doc[field]!=='string'||!doc[field].trim())throw new Error(field+' 不能为空。');
  const allowed=['formatVersion','id','version','name','startSceneId','sourceText','styleProfile','visualConstraints','level2Milestone','scenes','items','quests','npcs','factions','branches','initialKnowledge'];
  for(const key of Object.keys(doc))if(!allowed.includes(key))throw new Error('未知顶层字段：'+key);
  if(!Array.isArray(doc.scenes)||!doc.scenes.length)throw new Error('剧本需要至少一个 scenes 场景节点。');
  if(!doc.scenes.some(s=>s?.id===doc.startSceneId))throw new Error('startSceneId 必须引用剧本中的场景。');
  return doc;
}

// Older campaigns bound a prompt bundle (intent + narration); show it by section, read-only.
export function legacyPrompts(prompts){
  if(!prompts)return card('提示词','',h('p.muted',{},'这场战役没有绑定提示词。'));
  return card('提示词',`${prompts.name} · 版本 ${prompts.version} · 旧格式只读`,...['intent','narration'].map(role=>h('details',{open:role==='narration'},
    h('summary',{},role==='intent'?'行动理解提示词':'叙事提示词'),
    ...splitPrompt(prompts[role]).map(s=>h('div.prompt-section',{},s.title!==null?h('h4',{},s.title):null,h('pre.req-text',{},s.body))))));
}

// 剧本页面：启用后按目录/详情查看剧本，子入口可浏览剧本库；首次设定承接空房向导。
export async function renderCampaignPage(mount,ctx){
  const snapshot=ctx.snapshot;
  if(!snapshot.party?.isHost){
    mount.append(h('div.view',{},pageHead('剧本'),card('仅主持人可查看','',h('p',{},'剧本可能包含未公开的设定与剧情。'))));
    return;
  }
  if(snapshot.content?.initialSetup===true){
    await renderInitialAdventure(mount,ctx,{parseImport,downloadJson});
    return;
  }
  let disposed=false;
  mount.addEventListener('dispose',()=>{disposed=true;},{once:true});
  let content=null;
  const download=h('button.btn.btn-ghost',{type:'button',hidden:true,onclick:()=>downloadJson('adventure-export.json',content.adventure)},'下载剧本 JSON');
  const view=h('div.view',{},pageHead('剧本','',download));
  mount.append(view);

  content=await ctx.read('content');
  if(disposed)return;
  download.hidden=!content.adventure;

  const story=h('section',{'aria-label':'剧本内容'},adventureReader(content.adventure));
  const library=h('section',{'aria-label':'剧本库',hidden:true});
  mount.addEventListener('dispose',()=>library.dispatchEvent(new Event('dispose')),{once:true});

  const tabs=[['剧本内容',story],['剧本库',library]].map(([label,panel])=>{
    const tab=h('button.btn',{type:'button',onclick:()=>choose(panel)},label);
    tab.panel=panel;
    return tab;
  });

  function choose(panel){
    for(const tab of tabs){
      const on=tab.panel===panel;
      tab.panel.hidden=!on;
      tab.classList.toggle('active',on);
      tab.setAttribute('aria-pressed',String(on));
    }
  }

  view.append(h('div.page-tabs',{},...tabs),story,library);
  choose(story);
  if(!disposed)await renderAdventureLibrary(library,ctx);
}

// 地图图册页面：仅主持可查看；原图全幅显示，区分主持版与玩家版。
export async function renderMapsPage(mount,ctx){
  const snapshot=ctx.snapshot;
  if(!snapshot.party?.isHost){
    mount.append(h('div.view',{},pageHead('地图图册'),card('仅主持人可查看','',h('p',{},'地图图册可能包含未公开的地点与标注。'))));
    return;
  }
  if(snapshot.content?.initialSetup===true){
    mount.append(h('div.view',{},pageHead('地图图册','请先完成首次战役设定。'),
      card('未完成首次设定','',h('p',{},'空房间需要先导入或选择剧本。'),h('a.btn.btn-primary',{href:'#/campaign'},'前往首次设定'))));
    return;
  }
  const view=h('div.view',{},pageHead('地图图册'));
  mount.addEventListener('dispose',()=>view.dispatchEvent(new Event('dispose')),{once:true});
  mount.append(view);
  await renderMapReader(view,ctx);
}

// 提示词页面：段落目录 + 正文编辑固定保存/版本状态，透明度与实际请求。
export async function renderPromptsPage(mount,ctx){
  const snapshot=ctx.snapshot;
  if(!snapshot.party?.isHost){
    mount.append(h('div.view',{},pageHead('提示词'),card('仅主持人可查看','',h('p',{},'提示词可能包含模型系统指令与工作方法。'))));
    return;
  }
  if(snapshot.content?.initialSetup===true){
    mount.append(h('div.view',{},pageHead('提示词','请先完成首次战役设定。'),
      card('未完成首次设定','',h('p',{},'空房间需要先导入或选择剧本后，才能编辑提示词。'),h('a.btn.btn-primary',{href:'#/campaign'},'前往首次设定'))));
    return;
  }
  let disposed=false;
  const isDisposed=()=>disposed;
  mount.addEventListener('dispose',()=>{disposed=true;},{once:true});
  const view=h('div.view.prompt-page',{},pageHead('提示词'));
  mount.append(view);

  if(ctx.adventureAvailable===true){
    await renderPromptEditor(view,ctx,{isDisposed});
  }else{
    const content=await ctx.read('content');
    if(disposed)return;
    view.append(legacyPrompts(content.prompts));
  }
}

// 保持历史导出兼容
export const renderContentPage=renderCampaignPage;

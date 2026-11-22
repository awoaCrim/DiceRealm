// Structured view/editor of the active narrative prompt: section outline + main editor,
// working methods, and fixed save/version status. Saving runs draft → publish → activate.
import {h,card} from './dom.js';
import {newUuid} from './api.js';
import {splitPrompt,joinPrompt} from './prompt-sections.js';
import {createDialogHost} from './workspace-dialog.js';
import {requestLogCard} from './request-log.js';

const methodsEqual=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
// Only currently mounted editors; activation may finish after navigating away and back.
const openEditors=new Map();
const rows=text=>Math.min(24,Math.max(6,String(text).split('\n').length+1));

export async function readPromptFile(file){
  if(file.size>1024*1024)throw Error('文件最大 1 MiB。');
  let text;
  try{text=new TextDecoder('utf-8',{fatal:true}).decode(await file.arrayBuffer());}
  catch{throw Error('无法读取提示词，请选择 UTF-8 编码的 .md 或 .txt 文件。');}
  if(!text.trim())throw Error('提示词不能为空。');
  if(text.length>32768)throw Error('提示词最多 32768 字符。');
  if(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(text))throw Error('提示词含有不可用的控制字符。');
  return text;
}

export async function renderPromptEditor(mount,ctx,{isDisposed}){
  const connection=ctx.contentSettingsConnection();
  const storage=ctx.sessionStorage,key=ctx.scope?'dicerealm.workbench.prompt-draft.v1.'+ctx.scope:null;
  let view=await connection.settings();if(isDisposed())return;
  const effectiveCombat=custom=>custom||view.defaultCombatPrompt||'';
  let base=view.active,baseVersion=view.settingsVersion;
  let sections=[],methods=[],combatPrompt='',editingCombat=false,raw=false,saving=false,reading=false,storageError='';
  let activeSectionIndex=0,activeMethodIndex=null;
  let restored=null;

  if(storage&&key){
    try{
      const saved=storage.getItem(key);
      if(saved){
        restored=JSON.parse(saved);
        if(restored.schemaVersion!==1||typeof restored.prompt!=='string'||!Array.isArray(restored.methods)
          ||typeof restored.base?.prompt!=='string'||!Array.isArray(restored.base?.methods)||!Number.isSafeInteger(restored.baseVersion)
          ||restored.combatPrompt!==undefined&&typeof restored.combatPrompt!=='string')throw Error();
      }
    }catch{restored=null;storageError='本标签页草稿无法读取，原记录已保留；当前修改暂不能保存到浏览器。';}
  }

  const form=h('fieldset.prompt-form');
  const editor=h('div.prompt-editor'),status=h('p',{role:'status'}),count=h('span.hint');
  const role=h('select',{'aria-label':'正在编辑的主持提示词'},
    h('option',{value:'exploration'},'探索主持'),h('option',{value:'combat'},'战斗主持'));
  const combatArea=h('textarea',{rows:24,'aria-label':'战斗主持提示词全文',maxLength:32768});
  const combatEditor=h('section.prompt-combat-editor',{hidden:true},h('h3',{},'战斗主持要求'),
    h('p.hint',{},'已内置战斗主持提示词，可直接使用或修改。清空后保存，将使用内置默认。'),combatArea);
  role.addEventListener('change',()=>{sync();editingCombat=role.value==='combat';draw();});
  combatArea.addEventListener('input',()=>{combatPrompt=combatArea.value;changed();});
  const modeButton=h('button.btn.btn-ghost',{type:'button',onclick:()=>{sync();activeMethodIndex=null;raw=!raw;draw();}},'');
  const save=h('button.btn.btn-primary',{type:'button',title:'保存当前草稿，之后的新行动使用这些要求；不会改变已经开始的行动。',onclick:()=>saveAll()},'保存并应用');
  const reset=h('button.btn.btn-ghost',{type:'button',onclick:()=>{if(saving||reading||isDisposed())return;load();status.textContent='已恢复为当前生效的内容。';}},'放弃草稿修改');
  const rebase=h('button.btn.btn-ghost',{type:'button',hidden:true,onclick:()=>{
    if(saving||reading||isDisposed())return;
    base=view.active;baseVersion=view.settingsVersion;changed();
    status.textContent='已保留你的整份草稿，未合并服务器改动；保存后将用草稿替换当前已应用内容。';
  }},'保留草稿，覆盖新版本');
  const methodList=h('div.method-list'),activeVersion=h('p.hint');
  const dialogs=createDialogHost(mount);
  const activeText=dialogs.button('查看已应用原文',({body})=>{
    const applied=editingCombat?effectiveCombat(view.active.combatPrompt):view.active.prompt;
    const source=editingCombat&&!view.active.combatPrompt?'内置默认':`第 ${view.active.contentVersion} 版`;
    body.append(h('p.small.muted',{},`本页最近读取的已应用${editingCombat?'战斗':'探索'}主持正文 · ${source} · ${applied.length} 字。不含未保存草稿及按需参考资料；核对最新版本请先“刷新已应用内容”。`),
      h('pre.req-text',{},applied||'尚未设置战斗主持正文。'));
  });

  activeText.title='只读查看最近一次读取到的已应用原文，不是当前正在编辑的草稿。';

  function load(){
    base=view.active;baseVersion=view.settingsVersion;
    sections=splitPrompt(base.prompt);methods=base.methods.map(m=>({...m}));combatPrompt=base.combatPrompt??'';
    activeSectionIndex=0;activeMethodIndex=null;draw();
  }

  const text=()=>joinPrompt(sections);
  const dirty=()=>text()!==base.prompt.replace(/\r\n/g,'\n')||combatPrompt!==(base.combatPrompt??'')||!methodsEqual(methods,base.methods);
  const conflict=()=>dirty()&&baseVersion!==view.settingsVersion;
  const draftJson=()=>JSON.stringify({schemaVersion:1,baseVersion,base,prompt:text(),methods,combatPrompt});

  function persist(){
    if(!storage||!key||storageError||isDisposed())return;
    try{
      if(dirty())storage.setItem(key,draftJson());
      else storage.removeItem(key);
    }catch{storageError='浏览器未能保存草稿；请保留本页，刷新可能丢失修改。';}
  }

  // In full-text mode the textarea is the source of truth until switching back.
  function sync(){
    if(editingCombat){
      // Browsers normalize textarea line endings even without an edit.
      if(combatArea.value!==effectiveCombat(combatPrompt).replace(/\r\n/g,'\n'))combatPrompt=combatArea.value;
      return;
    }
    if(raw){
      const area=editor.querySelector('textarea.prompt-raw');
      if(area)sections=splitPrompt(area.value);
    }else{
      const currentArea=editor.querySelector('textarea');
      if(currentArea&&sections[activeSectionIndex]){
        sections[activeSectionIndex].body=currentArea.value;
      }
    }
  }

  function changed(){
    persist();
    count.textContent=`探索 ${text().length} 字 · 战斗 ${effectiveCombat(combatPrompt).length} 字`+(dirty()?' · 未保存'+(storage&&key&&!storageError?'（本标签页已保留，刷新可恢复）':''):' · 没有待保存的修改')
      +(conflict()?' · 服务端版本已变化：可保留草稿以覆盖新版本，或放弃草稿修改。':'')+(storageError?' · '+storageError:'');
    save.disabled=saving||reading||!dirty()||conflict();
    reset.hidden=!dirty();
    rebase.hidden=!conflict();
    form.disabled=saving||reading;
    activeVersion.textContent=`探索使用第 ${view.active.contentVersion} 版 · 战斗使用${view.active.combatPrompt?'自定义提示词':'内置默认提示词'}。新行动使用已应用的正文；在途会话不变。`;
  }

  function sectionCard(section,index){
    const title=h('input',{type:'text',value:section.title??'',maxLength:200,'aria-label':'段落标题',disabled:section.title===null});
    const body=h('textarea',{rows:rows(section.body),'aria-label':(section.title||'开头')+' 正文'});
    body.value=section.body;
    title.addEventListener('input',()=>{section.title=title.value;changed();updateOutlineTitles();});
    body.addEventListener('input',()=>{section.body=body.value;changed();});
    const move=(delta,label)=>h('button.btn.btn-ghost',{type:'button',disabled:index+delta<0||index+delta>=sections.length||section.title===null||sections[index+delta]?.title===null,
      onclick:()=>{
        sync();
        sections.splice(index+delta,0,sections.splice(index,1)[0]);
        activeSectionIndex=index+delta;
        draw();
      }},label);
    const remove=h('button.btn.btn-ghost',{type:'button',onclick:()=>{
      sync();
      sections.splice(index,1);
      if(!sections.length)sections.push({title:null,body:'',hasBreak:false});
      activeSectionIndex=Math.max(0,Math.min(activeSectionIndex,sections.length-1));
      draw();
    }},'删除');
    return h('section.prompt-section',{},
      h('div.prompt-section-head',{},
        section.title===null?h('strong',{},'开头（第一个标题之前）'):h('label.f',{},h('span',{},'# 标题'),title),
        h('div.btn-row',{},move(-1,'上移'),move(1,'下移'),remove)),
      body);
  }

  function methodCard(method,index){
    const field=(label,fieldKey,attrs)=>{
      const input=h(fieldKey==='content'?'textarea':'input',{...attrs,'aria-label':label});
      input.value=method[fieldKey];
      input.addEventListener('input',()=>{method[fieldKey]=input.value;changed();
        if(fieldKey==='id')outlineContainer.querySelectorAll('.outline-method-item')[index].textContent=input.value||'工作方法 '+(index+1);
      });
      return h('label.f',{},h('span',{},label),input);
    };
    return h('section.prompt-section',{},
      h('div.prompt-section-head',{},
        h('strong',{},'参考资料 '+(index+1)),
        h('button.btn.btn-ghost',{type:'button',onclick:()=>{methods.splice(index,1);activeMethodIndex=methods.length?Math.min(index,methods.length-1):null;draw();}},'删除')),
      h('div.grid-2',{},field('标识（英文、数字、-_.）','id',{type:'text',maxLength:80}),field('一句话说明','description',{type:'text',maxLength:240})),
      field('内容','content',{rows:rows(method.content)}));
  }

  const outlineContainer=h('aside.outline');

  function updateOutlineTitles(){
    const navItems=outlineContainer.querySelectorAll('.outline-section-item');
    navItems.forEach((btn,idx)=>{
      btn.textContent=sections[idx]?.title||(sections[idx]?.title===null?'开头':'段落 '+(idx+1));
    });
  }

  function draw({focusTarget=null}={}){
    editorShell.hidden=editingCombat;combatEditor.hidden=!editingCombat;combatArea.value=effectiveCombat(combatPrompt);
    modeButton.hidden=editingCombat;
    modeButton.textContent=raw?'切换为分段编辑':'切换为全文编辑';
    modeButton.title=raw?'将同一份草稿按标题分段编辑，不改变已保存的内容。':'在一个编辑框中修改主持正文草稿；参考资料请切回分段编辑。';
    editor.hidden=activeMethodIndex!==null;methodSection.hidden=activeMethodIndex===null;
    if(activeSectionIndex>=sections.length)activeSectionIndex=Math.max(0,sections.length-1);

    if(raw){
      const area=h('textarea.prompt-raw',{rows:30,'aria-label':'提示词全文'});
      area.value=text();
      area.addEventListener('input',()=>{sections=splitPrompt(area.value);changed();});
      editor.replaceChildren(area);
      outlineContainer.hidden=true;
      if(focusTarget==='editor')area.focus();
    }else{
      outlineContainer.hidden=false;
      const sectionButtons=sections.map((s,idx)=>{
        const btn=h('button.navitem.outline-section-item',{
          type:'button',
          class:activeMethodIndex===null&&idx===activeSectionIndex?'active on':'',
          onclick:()=>{sync();activeMethodIndex=null;activeSectionIndex=idx;draw({focusTarget:'outline'});}
        },s.title||(s.title===null?'开头':'段落 '+(idx+1)));
        return btn;
      });

      const addSectionBtn=h('button.btn.btn-ghost.outline-add-btn',{
        type:'button',
        onclick:()=>{
          sync();
          sections.push({title:'新段落',body:'',hasBreak:true});
          activeSectionIndex=sections.length-1;activeMethodIndex=null;
          draw({focusTarget:'editor'});
        }
      },'添加段落');

      const methodButtons=methods.map((m,idx)=>{
        return h('button.navitem.outline-method-item',{
          type:'button',class:idx===activeMethodIndex?'active on':'',
          onclick:()=>{sync();activeMethodIndex=idx;draw({focusTarget:'method'});}
        },m.id||m.description||('方法 '+(idx+1)));
      });

      outlineContainer.replaceChildren(
        h('label.group-label',{},'主持要求 · 段落目录'),
        ...sectionButtons,
        addSectionBtn,
        h('div.outline-divider'),
        h('label.group-label',{},'参考资料 · AI 按需阅读'),
        ...methodButtons,
        h('button.btn.btn-ghost.outline-add-btn',{type:'button',onclick:()=>{
          sync();methods.push({id:'method-'+(methods.length+1),description:'',content:''});activeMethodIndex=methods.length-1;draw({focusTarget:'method-editor'});
        }},'添加参考资料')
      );

      const activeSection=sections[activeSectionIndex]||sections[0];
      editor.replaceChildren(
        activeSection?sectionCard(activeSection,activeSectionIndex):null
      );

      methodList.replaceChildren(...methods.map((method,index)=>{
        const row=methodCard(method,index);row.hidden=index!==activeMethodIndex;return row;
      }));

      if(focusTarget==='method')methodButtons[activeMethodIndex]?.focus({preventScroll:true});
      else if(focusTarget==='method-editor')methodList.children[activeMethodIndex]?.querySelector('input')?.focus({preventScroll:true});
      else if(focusTarget==='outline'){
        const activeBtn=sectionButtons[activeSectionIndex];
        activeBtn?.focus();
      }else if(focusTarget==='editor'){
        const activeField=editor.querySelector('input[type=text]:not(:disabled), textarea');
        activeField?.focus();
      }
    }
    changed();
  }

  async function saveAll(){
    sync();if(saving||reading||isDisposed()||!dirty()||conflict())return;
    const edited=text(),prompt=edited===base.prompt.replace(/\r\n/g,'\n')?base.prompt:edited;
    if(!prompt.trim()){status.textContent='提示词不能为空。';return;}
    saving=true;changed();status.textContent='正在保存…';
    let savedDraft=null;
    try{savedDraft=storage&&key?storage.getItem(key):null;}catch{/* The visible storage warning remains. */}
    try{
      const active=view.active;
      let result=await connection.settingsDraft({requestId:newUuid(),expectedSettingsVersion:view.settingsVersion,
        contentId:active.contentId,contentVersion:prompt===active.prompt&&combatPrompt===(active.combatPrompt??'')?active.contentVersion:active.contentVersion+1,
        prompt,methods,...(combatPrompt.trim()?{combatPrompt}: {})});
      if(isDisposed())return;
      result=await connection.settingsPublish({requestId:newUuid(),expectedSettingsVersion:result.settings.settingsVersion});
      if(isDisposed())return;
      result=await connection.settingsActivate({requestId:newUuid(),expectedSettingsVersion:result.settings.settingsVersion,revision:result.settings.latestRevision});
      // Settle this exact local draft even if activation finished after leaving the page.
      try{if(savedDraft&&storage.getItem(key)===savedDraft)storage.removeItem(key);}
      catch{storageError='保存已确认，但浏览器草稿未能清理；刷新后请核对当前生效内容。';}
      if(savedDraft&&key)openEditors.get(key)?.(savedDraft,result.settings);
      if(isDisposed())return;
      view=result.settings;connection.confirmed();load();status.textContent='已保存并生效。';
    }catch(error){if(!isDisposed())status.textContent=error.message+' 可点「刷新已应用内容」读取当前已应用的版本；你的草稿会保留。';}
    finally{saving=false;if(!isDisposed())changed();}
  }

  const file=h('input',{type:'file',accept:'.md,.txt,text/markdown,text/plain','aria-label':'导入提示词文件'});
  file.addEventListener('change',async()=>{
    const chosen=file.files?.[0];file.value=''; // Choosing the same edited file again must fire change.
    if(!chosen||saving||reading||isDisposed())return;
    const targetCombat=editingCombat;
    reading=true;changed();status.textContent='正在读取文件…';
    try{
      const imported=await readPromptFile(chosen);if(isDisposed())return;
      if(targetCombat)combatPrompt=imported;
      else {sections=splitPrompt(imported);activeSectionIndex=0;activeMethodIndex=null;}
      draw(); // The other system prompt and methods are not replaced by this file.
      status.textContent='已将 '+chosen.name+' 载入草稿，尚未应用；点击「保存并应用」后，新行动才会使用。';
    }catch(error){if(!isDisposed())status.textContent=error.message;}
    finally{reading=false;if(!isDisposed())changed();}
  });

  const reload=h('button.btn.btn-ghost',{type:'button',title:'重新读取服务器上当前已应用的版本；有未保存的草稿时会保留草稿。不会重新读取本地文件。',onclick:async()=>{
    if(saving||reading||isDisposed())return;
    reading=true;changed();
    try{const current=await connection.settings();if(!isDisposed()){
      const keep=dirty();view=current;
      if(!keep)load();else changed();
      status.textContent=keep?'已读取服务端当前内容，未保存草稿仍保留。':'已读取服务端当前内容。';
    }}
    catch(error){if(!isDisposed())status.textContent=error.message;}
    finally{reading=false;if(!isDisposed())changed();}
  }},'刷新已应用内容');

  const methodSection=h('section.prompt-methods',{hidden:true},
    h('h3',{},'给 AI 按需阅读的参考资料'),
    h('p.small.muted',{},'AI 按需查阅；必需遵守的要求请写入“主持要求”。'),methodList);
  const editorShell=h('div.editor-shell',{},outlineContainer,h('div.editor-main',{},editor,methodSection));
  file.hidden=true;
  form.append(
    // One bar: what is edited and how on the left, saving on the right; facts go on one line below.
    h('div.prompt-bar',{},
      h('label.prompt-role',{},h('span',{},'正在编辑'),role),
      h('div.btn-row',{'aria-label':'修改草稿'},modeButton,
        h('button.btn.btn-ghost',{type:'button',title:'选择 UTF-8 的 .md 或 .txt 文件，替换当前提示词草稿；参考资料保留，导入后仍需保存。',onclick:()=>file.click()},'导入提示词文件')),
      h('div.btn-row',{'aria-label':'核对 AI 当前使用的内容'},activeText,reload),file,
      h('div.btn-row.prompt-save',{},rebase,reset,save)),
    h('div.prompt-meta',{},count,activeVersion),status,editorShell,combatEditor);

  const requests=h('section',{'aria-label':'本战役实际请求'});
  mount.addEventListener('dispose',()=>requests.dispatchEvent(new Event('dispose')),{once:true});
  const guide=injectionGuide(),panels=[form,guide,requests];
  let logLoaded=false;

  const tabs=[['编辑主持要求',form],['AI 输入组成说明',guide],['查看历史请求',requests]].map(([label,panel])=>
    h('button.btn',{type:'button',onclick:()=>choosePanel(panel)},label));

  function choosePanel(panel){
    panels.forEach(value=>{value.hidden=value!==panel;});
    tabs.forEach((tab,index)=>{const on=panels[index]===panel;tab.classList.toggle('active',on);tab.setAttribute('aria-pressed',String(on));});
    if(panel===requests&&!logLoaded){logLoaded=true;void log.reload();}
  }

  mount.append(h('div.page-tabs',{'aria-label':'编辑要求、了解输入或查看历史'},...tabs),...panels);

  if(restored){
    base=restored.base;baseVersion=restored.baseVersion;
    sections=splitPrompt(restored.prompt);methods=restored.methods.map(m=>({...m}));combatPrompt=restored.combatPrompt??restored.base.combatPrompt??'';draw();
    status.textContent='已恢复本标签页未保存的草稿。';
  }else load();

  if(key){
    const settle=(saved,settings)=>{
      if(isDisposed())return;
      const matches=draftJson()===saved;view=settings;
      if(matches){load();status.textContent='已保存并生效。';}
      else {changed();status.textContent='之前的保存已生效；当前的新修改仍保留。';}
    };
    openEditors.set(key,settle);
    mount.addEventListener('dispose',()=>{if(openEditors.get(key)===settle)openEditors.delete(key);},{once:true});
  }

  const log=requestLogCard(requests,{title:'AI 过去实际收到的内容',
    hint:'选择一次历史调用，查看当时发送的提示词、场景资料和工具。这里不是当前草稿，也不是下一次请求的预览。',
    limit:10,showFilter:false,initialTab:'request',
    list:params=>ctx.read('model-requests',params),detail:requestId=>ctx.read('model-request',{requestId}),
    campaignName:()=>ctx.snapshot?.name||'当前战役'});

  choosePanel(form);
}

// These are locations in the existing main adventure request, not a fabricated next request.
// Field values and old tool versions are read from the retained HTTP body below.
function injectionGuide(){
  const rows=[
    ['System 原文','OpenAI：messages[0].content（role=system）；Gemini：systemInstruction.parts[0].text',
      '「编辑主持要求」中保存并应用的叙事提示词，逐字发送；每个行动开始时冻结版本，不额外拼接内置 System。'],
    ['玩家输入与来源化记忆','首条 user 消息中的 input、ruleset、memory',
      'input 是本轮玩家原话，ruleset 是规则版本；memory 来自本人已完成的公开行动、近期叙事、连续性记录和相关旧文摘录。新版本每次请求重投影，含来源及省略标记，不是完整历史。'],
    ['本轮对话与工具结果','System 之后、execution_state 之前的消息',
      '本轮玩家回答、模型回复、工具调用和实际返回。超出上下文预算时，部分历史交换改为 kind=derived_context_extracts 的来源摘要，不是新增主持指令。'],
    ['当前执行状态','最后一条 user 消息，kind=execution_state',
      '每次请求按当前权威状态生成；具体字段和按需内容见下面的字段表。它不是 System，不能在提示词编辑框修改。'],
    ['当次可用工具','OpenAI：tools；Gemini：tools[].functionDeclarations',
      '来自行动冻结的工具版本，再按当次可用性裁剪。actions_propose 的候选 ID 会更新；没有可执行候选、不能保存叙事、地图不满足生成条件或未导入方法时，相应工具不提供。名称、用途和参数 schema 都在此处发送。'],
    ['按需读取的资料','工具调用后返回到对话消息中',
      '规则、完整角色、世界记录、历史和工作方法均按具体工具读取。方法目录由 skills_list 返回，正文由 skills_read 返回，不自动附在 System 或首条输入中。']
  ];
  const fields=[
    ['context','当前场景与公开世界、本人意图、候选行动、已知记录、活动裁定；来自服务端当前投影。'],
    ['self / detailedSelf','本人角色、身份、背包、装备、生命与资源；普通对白使用精简投影，完整能力可由 context_read(scope=character) 读取。省略不代表没有。'],
    ['combat','当前战斗状态；无战斗时为空，不由叙事正文推断。'],
    ['workingContext','当前场景的人物、公开来源记录及当前场景显式允许的主持资料；不是全剧本或全部私密资料。'],
    ['scenePresentation','当前地点标题、现状摘要和入场资料；新版本入场原文只在进入、观察等满足条件时提供，不每轮重复。'],
    ['supplies','当前场景已登记物资、领取权限、已领取数量和剩余量；不代表尚未登记的东西不存在。'],
    ['map','当前公开地点地图的状态及是否启用生成；不是图片像素或私密制图提示词。'],
    ['version / phase / availableTools / hasImportedSkills','当次状态版本、执行阶段、可用工具名单及是否有导入方法。旧行动的字段由其冻结工具版本决定。']
  ];
  const table=(head,values)=>h('div.table-scroll',{},h('table.data.prompt-injection-table',{},
    h('thead',{},h('tr',{},...head.map(label=>h('th',{},label)))),
    h('tbody',{},...values.map(row=>h('tr',{},...row.map(value=>h('td',{},value)))))));
  return card('AI 每次会收到哪些内容','除了你编辑的主持要求，系统还会提供玩家行动、场景和角色状态。下表解释各部分的来源；某次实际发了什么，请看“查看历史请求”。',
    table(['内容','发送位置','来源与触发条件'],rows),
    h('h4',{},'execution_state 字段'),table(['字段','会注入什么'],fields),
    h('p.small.muted',{},'user 消息在 OpenAI 中位于 messages[].content，在 Gemini 中位于 contents[].parts[].text；结构化内容以 JSON 文本发送。辅助整理、旧接口和图片请求有各自的提示词与输入，不套用主叙事结构。日志只保留全局最近 300 条，未保留的请求不会用当前数据补造。'));
}

import {h,pageHead,kv,fmtTime,confirmDialog} from './dom.js';
import {newUuid} from './api.js';
import {timelineOf} from './campaign-state.js';
import {formatSeconds} from './activity.js';
import {createDialogHost} from './workspace-dialog.js';

const kindLabel=entry=>entry.kind==='recovery'?'自动恢复点':'手动存档';

// One selected slot, one concrete operation. Naming a new save is the operation itself;
// destructive commands confirm once and keep their captured version/revision afterwards.
export async function renderSaves(mount,ctx){
  if(!ctx.snapshot?.party?.isHost){
    mount.append(h('div.view',{},pageHead('存档与重开'),h('p',{},'只有 DM 可以管理全队存档。')));
    return;
  }
  let disposed=false,reading=false,sending=false,confirming=false,ready=false,selectedId='',entries=[],canSave=false,reason='';
  mount.addEventListener('dispose',()=>{disposed=true;},{once:true});
  const dialogs=createDialogHost(mount),timeline=timelineOf(ctx.snapshot);
  const current=()=>!disposed&&timelineOf(ctx.snapshot)===timeline;
  const blocked=()=>sending||confirming||reading||!!ctx.hasPending?.();
  const selected=()=>entries.find(entry=>entry.id===selectedId);
  const status=h('p',{role:'status','aria-live':'polite'});
  const saveReason=h('p.warning-text',{role:'status',hidden:true});
  const list=h('aside.catalog-nav',{'aria-label':'存档列表'});
  const detail=h('section.catalog-main',{'aria-label':'所选存档详情'});
  const create=h('button.btn.btn-primary',{type:'button',onclick:openNew},'新建存档');
  const restart=h('button.btn',{type:'button',onclick:()=>destroy('restart')},'重开游戏');
  // Restarting replaces the whole run, so it sits apart from everyday saving.
  const page=h('div.view',{},pageHead('存档与重开','',create),status,saveReason,
    h('div.catalog-shell',{},list,detail),
    h('section.danger-zone',{'aria-label':'重开游戏'},
      h('div',{},h('h3',{},'重开游戏'),h('p.small.muted',{},'从当前剧本重新开始；替换前自动保留恢复点，房间、玩家席位与初始角色不变。')),restart));
  mount.append(page);

  function update(){
    status.hidden=!status.textContent;
    create.disabled=blocked()||!ready||!canSave;
    restart.disabled=blocked();
    saveReason.hidden=!ready||canSave;
    saveReason.textContent=reason||'当前进度暂时不能保存。';
    for(const button of detail.querySelectorAll('button[data-save-operation]')){
      button.disabled=blocked()||!ready||button.dataset.saveOperation==='overwrite'&&!canSave;
    }
    for(const button of list.querySelectorAll('button'))button.disabled=sending||confirming;
  }
  function draw(){
    if(!current())return;
    const focus=document.activeElement?.dataset?.saveId;
    // With no saves the list column has nothing to show; the detail column explains the first step.
    list.hidden=ready&&!entries.length;
    list.replaceChildren(...(entries.length?[]:[h('p.muted',{},'尚未读取存档。')]),
      ...entries.map(entry=>h('button.btn.sheet-entry',{
        type:'button','data-save-id':entry.id,'aria-pressed':String(entry.id===selectedId),
        class:entry.id===selectedId?'active on':'',onclick:()=>{
          if(!current()||sending||confirming)return;
          selectedId=entry.id;draw();
        }},h('strong',{},entry.name),h('span.small.muted',{},fmtTime(entry.createdAt)),
        h('span.small.muted',{},kindLabel(entry)+' · '+(entry.sceneTitle||'尚未开始')))));
    const entry=selected();
    if(!entry){
      detail.replaceChildren(...(!ready?[h('p',{},'正在读取存档…')]:entries.length?[h('p.muted',{},'选择左侧的存档查看详情。')]
        :[h('h2',{},'还没有存档'),h('p.muted',{},'「新建存档」会记下全队当前进度，以后可以读档恢复。')]));
    }else{
      const loadButton=h('button.btn.btn-primary',{type:'button','data-save-operation':'load',onclick:()=>destroy('load')},'读取此存档');
      const overwrite=h('button.btn',{type:'button','data-save-operation':'overwrite',onclick:()=>destroy('overwrite')},'用当前进度覆盖');
      const remove=h('button.btn.btn-ghost',{type:'button','data-save-operation':'delete',onclick:()=>destroy('delete')},'删除存档');
      detail.replaceChildren(h('h2',{},entry.name),
        h('div.btn-row',{},loadButton,overwrite,remove),
        kv([['保存时间',fmtTime(entry.createdAt)],['场景',entry.sceneTitle||'尚未开始'],
          ['冒险时间',formatSeconds(entry.elapsedSeconds)],['类型',kindLabel(entry)]]),
        h('h3',{},'队伍'),entry.party.length?h('ul.plain',{},...entry.party.map(member=>h('li',{},
          member.name+' · '+member.level+' 级',member.dead?h('span.tag',{},'已死亡'):null)))
          :h('p.muted',{},'保存时尚无玩家角色。'));
    }
    update();
    if(focus)[...list.querySelectorAll('button')].find(button=>button.dataset.saveId===focus)?.focus({preventScroll:true});
  }
  function focusSelected(){
    const button=[...list.querySelectorAll('button')].find(button=>button.dataset.saveId===selectedId);
    (button||(create.disabled?restart:create)).focus({preventScroll:true});
  }
  async function load(preferred=selectedId){
    if(!current()||reading||sending||confirming)return;
    reading=true;status.textContent='正在读取存档…';update();
    try{
      const value=await ctx.read('adventure-saves');if(!current())return;
      entries=value.entries;canSave=value.canSave;reason=value.reason;ready=true;
      selectedId=entries.some(entry=>entry.id===preferred)?preferred:entries[0]?.id||'';
      status.textContent=entries.length?'共 '+entries.length+' 个存档':'';draw();return true;
    }catch(error){
      if(current()){ready=false;status.textContent='存档读取失败：'+error.message;update();if(error.status===401)ctx.report(error);}
      return false;
    }finally{reading=false;if(current())update();}
  }
  function openNew(){
    if(!current()||blocked()||!ready||!canSave)return;
    dialogs.open({title:'新建存档',wide:false,returnFocus:()=>create,render:({body,isDisposed,close})=>{
      let saving=false;
      const name=h('input',{type:'text',maxLength:80,required:true,'aria-label':'存档名称',autocomplete:'off'});
      const feedback=h('p',{role:'status'}),save=h('button.btn.btn-primary',{type:'submit',disabled:true},'保存');
      const fields=h('fieldset',{},h('legend',{},'命名存档'),h('label.f',{},h('span',{},'存档名称'),name),feedback,h('div.btn-row',{},save));
      const form=h('form',{},fields);body.append(form);
      function updateForm(){save.disabled=saving||!!ctx.hasPending?.()||!name.value.trim()||name.value.trim().length>80;}
      name.addEventListener('input',updateForm);
      form.addEventListener('submit',async event=>{
        event.preventDefault();
        if(isDisposed()||!current()||saving||blocked()||!canSave)return;
        const value=name.value.trim();if(!value||value.length>80){feedback.textContent='请填写 1–80 字的名称。';name.focus();return;}
        const payload={requestId:newUuid(),expectedVersion:ctx.snapshot.version,name:value};
        saving=true;sending=true;fields.disabled=true;feedback.textContent='正在保存…';update();
        let accepted=false;
        try{
          const result=await ctx.submit('adventure-save',payload);accepted=true;
          if(!current())return;
          const wasClosed=isDisposed();if(!wasClosed)close();
          sending=false;const loaded=await load(result.saveId);
          if(current()){
            status.textContent='已保存「'+value+'」。'+(loaded?'':' '+status.textContent);
            if(loaded&&!wasClosed)focusSelected();
          }
        }catch(error){
          if(current()){
            const message=(accepted?'存档已保存，列表读取失败：':'')+error.message;
            status.textContent=message;if(!isDisposed())feedback.textContent=message;
            if(!accepted)ctx.report(error);
          }
        }finally{saving=false;sending=false;if(current())update();if(!isDisposed()){fields.disabled=false;updateForm();}}
      });
      name.focus();
    }});
  }
  async function destroy(operation){
    if(!current()||blocked())return;
    const entry=selected();
    if(operation!=='restart'&&(!ready||!entry))return;
    if(operation==='overwrite'&&!canSave)return;
    const version=ctx.snapshot.version,revision=entry?.revision,id=entry?.id,name=entry?.name;
    const common={requestId:newUuid(),expectedVersion:version};
    const commands={
      load:{endpoint:'adventure-save-load',title:'读取「'+name+'」？',confirm:'读取存档',
        lines:['全队进度将恢复到这个存档。替换前会自动保留当前恢复点。','当前房间、玩家席位与连接保留。'],
        payload:{...common,saveId:id,expectedSaveRevision:revision},done:'已读取「'+name+'」。'},
      overwrite:{endpoint:'adventure-save',title:'覆盖「'+name+'」？',confirm:'覆盖存档',
        lines:['将用当前全队进度替换这个档位，原档位内容会被覆盖。'],
        payload:{...common,name,saveId:id,expectedSaveRevision:revision},done:'已覆盖「'+name+'」。'},
      delete:{endpoint:'adventure-save-delete',title:'删除「'+name+'」？',confirm:'删除存档',
        lines:['此存档将被删除；当前正在进行的游戏不受影响。'],
        payload:{requestId:common.requestId,saveId:id,expectedSaveRevision:revision},done:'已删除「'+name+'」。'},
      restart:{endpoint:'adventure-restart',title:'重开这场游戏？',confirm:'重开游戏',
        lines:['全队进度将从当前剧本重新开始，替换前会自动保留当前恢复点。','保留当前房间、玩家席位与初始角色，无需重新建卡或加入。'],
        payload:common,done:'游戏已重开。'}
    };
    const command=commands[operation];
    if(!command)return;
    confirming=true;let stale=false;
    try{
      const accepted=await confirmDialog({title:command.title,lines:command.lines,confirmText:command.confirm,danger:true});
      if(!accepted||!current()||ctx.hasPending?.())return;
      if(operation!=='delete'&&ctx.snapshot.version!==version||operation!=='restart'&&(selected()?.id!==id||selected()?.revision!==revision)){
        stale=true;return;
      }
      sending=true;status.textContent='正在'+command.confirm+'…';update();
      const result=await ctx.submit(command.endpoint,command.payload);
      if(!current())return;
      sending=false;confirming=false;const loaded=await load(operation==='delete'?'':result.saveId||selectedId);
      if(current()){
        status.textContent=command.done+(loaded?'':' '+status.textContent);
        if(loaded)focusSelected();
      }
    }catch(error){
      if(current()){status.textContent=error.message;ctx.report(error);}
    }finally{confirming=false;sending=false;if(current())update();}
    if(stale&&current()&&await load())status.textContent='进度或存档已改变，已重新读取列表，请重新选择。';
  }
  draw();await load();
}

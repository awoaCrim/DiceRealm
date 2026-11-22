import {h,card,pageHead,kv,errorBox} from './dom.js';
import {newUuid} from './api.js';

// Shared room credentials admit new players; existing private seats remain unchanged.
export async function renderRoomSettings(mount,ctx){
  if(!ctx.snapshot.party?.isHost)return;
  const scope=ctx.scope;
  let disposed=false,loading=false,submitting=false,metadata=null;
  const current=()=>!disposed&&ctx.scope===scope;
  const details=h('div'),status=h('div',{'aria-live':'polite'});
  const password=h('input',{type:'password',autocomplete:'new-password',required:true,minLength:8,maxLength:128,'aria-label':'共享密码'});
  const enable=h('button.btn.btn-primary',{type:'submit','data-write':'true'},'设置密码并开启加入');
  const disable=h('button.btn',{type:'button','data-write':'true',onclick:()=>configure(false)},'关闭新玩家加入');
  const fields=h('fieldset.plain-fieldset',{},h('label.f',{},h('span',{},'共享密码（8–128 个字符）'),password),
    h('p.small.muted',{},'密码不回显；关闭或换密码不影响已有玩家。'),h('div.btn-row',{},enable,disable));
  const form=h('form',{'aria-label':'邀请玩家设置'},fields);
  form.onsubmit=event=>{event.preventDefault();void configure(true);};
  // What to tell players sits beside how to change it; the join steps are the reference below.
  const members=(ctx.snapshot.party?.members||[]).filter(member=>!member.revoked&&member.character);
  mount.append(h('div.view',{},pageHead('邀请玩家','把房间号和共享密码告诉玩家，他们在游戏端加入。'),
    h('div.grid-2.room-grid',{},card('房间与队伍','',details,
      h('h3',{},'已有玩家'),members.length?h('ul.room-members',{},...members.map(member=>h('li',{},
        h('strong',{},member.character.name),h('span.small.muted',{},member.character.level+' 级'),
        h('span.status-tag',{'data-state':member.review?.status==='approved'?'ok':'off'},({approved:'已通过',pending:'待审核',returned:'已退回'})[member.review?.status]||'尚未提交')))):
        h('p.muted',{},'还没有玩家角色。')),
      card('共享密码','',form,status,h('h3',{},'玩家怎么加入'),h('ol.steps',{},
      h('li',{},'打开游戏端，在主页点「加入房间」。'),
      h('li',{},'填写本服务器地址、房间号和共享密码。'),
      h('li',{},'完成建卡并提交；角色出现在「剧情」页待你审核。'))))));
  mount.addEventListener('dispose',()=>{disposed=true;password.value='';},{once:true});
  function controls(){
    const blocked=loading||submitting||!metadata||!!ctx.hasPending?.();
    fields.disabled=blocked;
    password.disabled=ctx.snapshot.archived===true;
    enable.disabled=blocked||ctx.snapshot.archived===true;
    disable.disabled=blocked||!metadata?.enabled;
    enable.dataset.disabledBase=String(enable.disabled);
    disable.dataset.disabledBase=String(disable.disabled);
  }
  function draw(){
    const members=(ctx.snapshot.party?.members||[]).filter(member=>!member.revoked&&member.character);
    details.replaceChildren(h('p.small.muted.room-label',{},'房间号'),
      h('p.room-number',{},metadata.roomNumber?h('span.mono',{},metadata.roomNumber):h('span.muted',{},'尚未开启，设置密码后生成')),
      kv([['新玩家加入',h('span.status-tag',{'data-state':metadata.enabled?'ok':'off'},metadata.enabled?'已开启':'已关闭')],
        ['已有玩家',members.length+' 人（角色仍需主持审核）']]));
    enable.textContent=metadata.enabled?'更换共享密码':'设置密码并开启加入';disable.hidden=!metadata.enabled;
    if(ctx.snapshot.archived)details.append(h('p',{},'此房间已归档，不能开启新加入；仍可关闭已开启的加入。'));
    if(ctx.hasPending?.())details.append(h('p',{},'有未确认操作，请先在上方重试原请求。'));
  }
  async function configure(enabled){
    if(!current()||submitting||loading||!metadata||ctx.hasPending?.())return;
    if(enabled&&ctx.snapshot.archived)return;
    const value=enabled?password.value:'';
    if(enabled&&(value.length<8||value.length>128||!value.trim()||/[\u0000-\u001f\u007f]/.test(value))){
      status.replaceChildren(errorBox('共享密码须为 8–128 个字符，不能全为空白或包含控制字符。'));return;
    }
    if(metadata.version!==ctx.snapshot.version){status.replaceChildren(errorBox('房间状态已变化，请点顶栏「刷新」后再设置。'));return;}
    const payload={requestId:newUuid(),expectedVersion:metadata.version,enabled,password:value};
    submitting=true;controls();status.replaceChildren();
    let accepted=false;
    try{
      await ctx.submit('room-config',payload);accepted=true;
      if(!current())return;
      password.value='';status.textContent=enabled?'加入设置已保存。把房间号与本次共享密码告诉新玩家即可。':'已关闭新玩家加入，已有玩家仍可继续。';
      await ctx.refresh();
    }catch(error){if(current())status.replaceChildren(errorBox((accepted?'设置已保存，但刷新失败：':'')+error.message));}
    finally{submitting=false;if(current())controls();}
  }
  loading=true;controls();status.textContent='正在读取房间…';
  try{metadata=await ctx.read('room');if(!current())return;draw();status.replaceChildren();}
  catch(error){if(current())status.replaceChildren(errorBox('房间读取失败：'+error.message));}
  finally{loading=false;if(current())controls();}
}

// The page before a seat is open: seats saved on this browser, joining a room with a new character,
// and retrying an unconfirmed join.
import {h} from '../dom.js';
import {openBuilder} from './builder.js';
import {openQuickBuild} from './quick.js';
import * as join from './join.js';

export function showEntrance(root,{api,storage,origin,start},message=''){
  const error=h('p.pl-connect-error',{role:'alert'},message);
  const fail=text=>{error.textContent=text;};
  let pending=null;
  try{pending=join.pendingJoin(storage);}catch(e){fail(e.message);}
  const again=text=>showEntrance(root,{api,storage,origin,start},text);

  async function submit(){
    root.replaceChildren(h('div.pl-connect',{},h('h1',{},'正在加入房间…'),h('p',{},'请稍候，结果确认前不要重复加入。')));
    try{const {session}=await join.sendJoin(api,storage,origin);await start(session);}
    catch(e){again(e.cleared?'没有加入：'+e.message:'加入结果尚未确认：'+e.message+' 已保留原请求，可以重试。');}
  }
  // Character creation starts on the quick page; 「详细调整」 opens the full builder on the same build and
  // closing it comes back. Either one joins with the build it adopts.
  async function build(roomNumber,password){
    let catalog;
    try{catalog=await api.request('build-catalog',null);}
    catch(e){fail('暂时无法读取建卡规则：'+e.message);return;}
    const evaluate=value=>api.request('build-evaluate',null,{build:value});
    const onSave=value=>{try{join.saveDraft(storage,value);}catch{/* The draft stays open in this page. */}};
    const onAdopt=value=>{
      try{join.beginJoin(storage,roomNumber,password,value);}catch(e){again(e.message);return;}
      void submit();
    };
    const quick=()=>{root.replaceChildren();openQuickBuild(root,{catalog,saved:join.savedDraft(storage,catalog),evaluate,roomNumber,onSave,onAdopt,
      onDetailed:value=>{root.replaceChildren();openBuilder(root,{catalog,saved:{build:value,step:0},evaluate,onSave,onAdopt,onClose:quick});},
      onClose:()=>again('')});};
    quick();
  }

  const sections=[];
  if(pending){
    sections.push(h('section.pl-part',{},h('h2',{},'加入尚未确认'),
      h('p',{},'房间 '+pending.roomNumber+' · 角色「'+pending.build.identity.name+'」。上次没有收到明确结果，只能重试这一次原请求，不会多占一个席位。'),
      h('div.pl-connect-actions',{},h('button.btn.btn-primary',{type:'button',onclick:submit},'重试原请求'))));
  }
  const list=join.seats(storage,origin);
  if(list.length)sections.push(h('section.pl-part',{},h('h2',{},'我的席位'),
    h('ul.pl-seats',{},...list.map(seat=>h('li',{},
      h('span',{},seat.label||'席位 '+seat.campaignId.slice(0,8)),
      h('button.btn.btn-primary.btn-sm',{type:'button',onclick:()=>start(seat)},'进入'),
      h('button.btn.btn-sm',{type:'button',onclick:()=>{
        if(!confirm('移除后，这台电脑不再保存该席位的凭证，之后无法用它进入。确定移除？'))return;
        join.forgetSeat(storage,origin,seat);again('');
      }},'移除'))))));

  const room=h('input',{type:'text',inputmode:'numeric',maxlength:'8',autocomplete:'off','aria-label':'房间号',placeholder:'8 位数字'});
  const password=h('input',{type:'password',autocomplete:'off','aria-label':'共享密码'});
  sections.push(h('section.pl-part',{},h('h2',{},'加入房间'),
    h('p',{},'向主持要房间号和共享密码。下一步选职业、起名字就能加入；主持批准前可以阅读剧情，不能行动。'),
    h('div.pl-join',{},h('label',{},h('span',{},'房间号'),room),h('label',{},h('span',{},'共享密码'),password),
      h('button.btn.btn-primary',{type:'button',disabled:!!pending,onclick:()=>{
        const number=room.value.trim();
        if(!join.validRoomNumber(number)){fail('房间号是 8 位数字。');return;}
        if(!password.value){fail('请输入共享密码。');return;}
        void build(number,password.value);
      }},'创建角色并加入'))));

  root.replaceChildren(h('div.pl-connect',{},h('h1',{},'进入冒险'),error,...sections));
}

import {h,card,pageHead,errorBox} from './dom.js';
import {createDialogHost} from './workspace-dialog.js';

const field=(label,input)=>h('label.f',{},h('span',{},label),input);
const passwordInput=label=>h('input',{type:'password',autocomplete:'new-password',required:true,minLength:8,maxLength:128,'aria-label':label});

export function renderLogin(mount,ctx){
  let disposed=false,busy=false;
  const username=h('input',{type:'text',autocomplete:'username',required:true,maxLength:64,'aria-label':'用户名'});
  const password=h('input',{type:'password',autocomplete:'current-password',required:true,maxLength:128,'aria-label':'密码'});
  const submit=h('button.btn.btn-primary',{type:'submit'},'登录');
  const message=h('div',{'aria-live':'polite'});
  const form=h('form',{'aria-label':'账户登录'},field('用户名',username),field('密码',password),h('div.btn-row',{},submit),message);
  mount.append(h('div.account-login',{},
    h('div.login-brand',{},h('span.seal',{'aria-hidden':'true'},h('i',{},'卷')),h('div',{},h('h1',{},'DiceRealm'),h('p',{},'主持工作台'))),
    h('section.login-card',{},h('h2',{},'账户登录'),form),
    h('p.login-note',{},'账户由管理员创建。登录状态只保存在当前标签页。')));
  mount.addEventListener('dispose',()=>{disposed=true;password.value='';},{once:true});
  form.onsubmit=async event=>{
    event.preventDefault();if(busy||disposed)return;
    busy=true;submit.disabled=true;message.replaceChildren();
    try{await ctx.login(username.value.trim(),password.value);}
    catch(error){if(!disposed){message.append(errorBox(error.message));password.value='';password.focus();}}
    finally{busy=false;if(!disposed)submit.disabled=false;}
  };
}

export async function renderUsers(mount,ctx){
  let disposed=false,loading=false;
  mount.addEventListener('dispose',()=>{disposed=true;},{once:true});
  if(!ctx.account?.user.isAdmin){mount.append(errorBox('只有管理员可以管理用户。'));return;}
  const api=ctx.accountApi(),dialogs=createDialogHost(mount),list=h('div'),message=h('div',{'aria-live':'polite'});
  const add=h('button.btn.btn-primary',{type:'button',onclick:()=>openUserForm(null)},'创建用户');
  mount.append(h('div.view',{},pageHead('用户管理','停用账户不删除战役与历史。',add),message,h('section.card',{},list)));
  async function load(){
    if(loading||disposed)return;
    loading=true;message.replaceChildren();
    try{
      const {users}=await api.users();if(disposed)return;
      const rows=users.map(user=>{
        const actions=h('div.btn-row',{},h('button.btn',{type:'button',onclick:()=>ctx.showUserCampaigns(user.id)},'查看战役'));
        if(!user.isAdmin){
          const toggle=h('button.btn',{type:'button',onclick:()=>setDisabled(user,toggle)},user.disabled?'恢复用户':'停用用户');
          actions.append(h('button.btn',{type:'button',onclick:()=>openUserForm(user)},'重置密码'),toggle);
        }
        return h('tr',{},h('td',{},user.username),h('td',{},user.isAdmin?'管理员':'用户'),h('td',{},user.disabled?'已停用':'可登录'),h('td',{},actions));
      });
      list.replaceChildren(h('div.table-scroll',{},h('table.data',{},
        h('thead',{},h('tr',{},...['用户名','身份','状态','操作'].map(label=>h('th',{},label)))),h('tbody',{},...rows))));
    }catch(error){if(!disposed){message.append(errorBox(error.message));if(error.status===401)ctx.report(error);}}
    finally{loading=false;}
  }
  async function setDisabled(user,button){
    if(disposed||button.disabled)return;
    button.disabled=true;message.replaceChildren();
    try{await api.setDisabled(user.id,!user.disabled);if(!disposed)await load();}
    catch(error){if(!disposed){message.append(errorBox(error.message));if(error.status===401)ctx.report(error);}}
    finally{if(!disposed)button.disabled=false;}
  }
  function openUserForm(user){
    dialogs.open({title:user?'重置 '+user.username+' 的密码':'创建用户',wide:false,render:({body,isDisposed,close})=>{
      let busy=false;
      const username=h('input',{type:'text',required:true,maxLength:64,autocomplete:'off','aria-label':'新用户名'});
      const password=passwordInput('新密码'),status=h('div',{'aria-live':'polite'});
      const submit=h('button.btn.btn-primary',{type:'submit'},user?'保存新密码':'创建用户');
      const form=h('form',{'aria-label':user?'重置用户密码':'创建用户'},...(!user?[field('用户名',username)]:[]),
        field('新密码（8–128 个字符）',password),user?h('p.small.muted',{},'保存后，该用户需要重新登录。'):null,h('div.btn-row',{},submit),status);
      body.append(form);body.addEventListener('dispose',()=>{password.value='';},{once:true});
      form.onsubmit=async event=>{
        event.preventDefault();if(busy||isDisposed())return;busy=true;submit.disabled=true;status.replaceChildren();
        try{
          if(user)await api.resetPassword(user.id,password.value);else await api.createUser(username.value.trim(),password.value);
          password.value='';if(isDisposed())return;
          close();if(!disposed)await load();
        }catch(error){if(!isDisposed()){status.append(errorBox(error.message));if(error.status===401)ctx.report(error);}}
        finally{busy=false;if(!isDisposed())submit.disabled=false;}
      };
    }});
  }
  await load();
}

export function renderAccountPassword(mount,ctx){
  let disposed=false,busy=false;
  const api=ctx.accountApi(),current=passwordInput('当前密码'),next=passwordInput('新密码');
  current.setAttribute('autocomplete','current-password');
  const message=h('div',{'aria-live':'polite'}),submit=h('button.btn.btn-primary',{type:'submit'},'保存新密码');
  const form=h('form',{'aria-label':'修改本人密码'},field('当前密码',current),field('新密码（8–128 个字符）',next),h('div.btn-row',{},submit,h('a.btn',{href:'#/campaigns'},'返回战役列表')),message);
  mount.append(h('div.view.narrow-view',{},pageHead('修改密码','保存后需要使用新密码重新登录；战役与未确认操作保留。'),card('账户 '+ctx.account.user.username,'',form)));
  mount.addEventListener('dispose',()=>{disposed=true;current.value=next.value='';},{once:true});
  form.onsubmit=async event=>{
    event.preventDefault();if(busy||disposed)return;busy=true;submit.disabled=true;message.replaceChildren();
    try{await api.changePassword(current.value,next.value);if(!disposed)await ctx.passwordChanged();}
    catch(error){if(!disposed)message.append(errorBox(error.message));}
    finally{current.value=next.value='';busy=false;if(!disposed)submit.disabled=false;}
  };
}

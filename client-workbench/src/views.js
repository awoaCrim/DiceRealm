import {h,card,pageHead as heading} from './dom.js';

const field=(label,input)=>{if(!input.hasAttribute('aria-label'))input.setAttribute('aria-label',label);return h('label.f',{},h('span',{},label),input);};
const input=(value='',attrs={})=>h('input',{type:'text',value,...attrs});
const button=(label,click,{write=false,disabled=false,primary=false}={})=>h('button.btn'+(primary?'.btn-primary':'.btn-ghost'),{type:'button',disabled,'data-write':write?'true':null,'data-disabled-base':String(disabled),onclick:click},label);
const table=(columns,rows)=>h('div.table-scroll',{},h('table.data',{},h('thead',{},h('tr',{},...columns.map(c=>h('th',{},c)))),h('tbody',{},...rows.map(row=>h('tr',{},...row.map(cell=>h('td',{},cell)))))));
async function guarded(ctx,operation){try{await operation();}catch(error){ctx.report(error);}}

export function renderCampaigns(mount,ctx){
  let disposed=false;
  mount.classList.add('connect-wrap');
  mount.addEventListener('dispose',()=>{disposed=true;},{once:true});
  const name=input('',{required:true,maxLength:80,'aria-label':'战役名称'});
  const submit=h('button.btn.btn-primary',{type:'submit'},'创建战役');
  const cancel=h('button.btn.btn-ghost',{type:'button',onclick:()=>showCreate(false)},'取消');
  const form=h('form',{'aria-label':'创建战役'},field('战役名称',name),h('div.btn-row',{},submit,cancel));
  // Creating is the occasional task; the list stays the page and the form opens on demand.
  const creation=h('section.card',{hidden:true,'aria-label':'创建新战役'},h('h3',{},'创建新战役',h('span.hint',{},'创建后再选择剧本、邀请玩家。')),form);
  const open=h('button.btn.btn-primary',{type:'button','aria-expanded':'false',onclick:()=>showCreate(true)},'创建新战役');
  function showCreate(visible){
    if(disposed)return;
    creation.hidden=!visible;open.hidden=visible;open.setAttribute('aria-expanded',String(visible));
    if(visible)name.focus?.();
  }
  const list=h('section',{'aria-label':'已有战役'});
  mount.append(h('div.view',{},heading('你的战役','',open),creation,list));
  campaignList(list,ctx,{isDisposed:()=>disposed,onEmpty:()=>showCreate(true)});
  form.onsubmit=event=>{
    event.preventDefault();
    if(submit.disabled||disposed)return;
    return guarded(ctx,async()=>{
      const title=name.value.trim();
      if(!title)throw new Error('请输入战役名称。');
      submit.disabled=true;
      try{await ctx.create({name:title});}
      finally{if(!disposed)submit.disabled=false;}
    });
  };
}
function campaignList(mount,ctx,{isDisposed,onEmpty}){
  let busy=false,rows=[],initialFilter=ctx.campaignOwnerFilter||'';
  const api=ctx.accountApi(),list=h('div'),status=h('p',{role:'status'});
  const query=input('',{type:'search','aria-label':'搜索战役',placeholder:'按战役或用户名称查找'});
  const filter=h('select',{'aria-label':'战役归属'},h('option',{value:''},'全部可访问战役'));
  mount.append(card('','',h('div.btn-row.filter-row',{},field('搜索',query),...(ctx.account.user.isAdmin?[field('归属用户',filter)]:[])),status,list));
  query.addEventListener('input',draw);filter.addEventListener('change',draw);
  function draw(){
    if(isDisposed())return;
    const search=query.value.trim().toLocaleLowerCase();
    const visible=rows.filter(c=>(!filter.value||ownerKey(c)===filter.value)&&(!search||(c.name+' '+(c.ownerUsername||'')+' '+(c.unavailable?c.id:'')).toLocaleLowerCase().includes(search)));
    list.replaceChildren(visible.length?table(['战役','状态',...(ctx.account.user.isAdmin?['归属用户']:[]),''],visible.map(c=>[
      c.unavailable?h('div',{},c.name,h('p.small.mono',{},c.id)):c.name,
      c.unavailable?'损坏或不支持':c.archived?'已归档':'进行中',...(ctx.account.user.isAdmin?[ownerLabel(c)]:[]),
      c.unavailable?h('p.small.muted',{},'暂不可进入；原存档已保留，请检查备份。'):button(c.archived?'查看战役':'继续战役',()=>guarded(ctx,async()=>{if(busy||isDisposed())return;busy=true;draw();try{await ctx.openCampaign(c.id);}finally{busy=false;if(!isDisposed())draw();}}),{disabled:busy})
    ])):h('p.empty',{},rows.length?'没有符合条件的战役。':'还没有战役，在上方创建第一场。'));
  }
  const ownerKey=c=>c.unavailable?'unavailable':c.ownerUserId||'legacy';
  const ownerLabel=c=>c.unavailable?'归属无法确认':c.ownerUsername||'旧战役（未关联账户）';
  async function load(){
    if(busy||isDisposed())return;busy=true;status.textContent='正在读取战役…';
    try{
      const result=await api.campaigns();if(isDisposed())return;rows=result.campaigns;
      if(!rows.length)onEmpty();
      const owners=new Map(rows.map(c=>[ownerKey(c),ownerLabel(c)]));
      const selected=initialFilter??filter.value;initialFilter=null;
      if(selected&&!owners.has(selected))owners.set(selected,'所选用户（暂无战役）');
      filter.replaceChildren(h('option',{value:''},'全部可访问战役'),...Array.from(owners,([value,label])=>h('option',{value},label)));
      filter.value=selected;
      const unavailable=rows.filter(c=>c.unavailable).length;
      status.textContent=(rows.length-unavailable)+' 场可访问战役'+(unavailable?'；另有 '+unavailable+' 条损坏或不支持的记录，其他战役可正常进入。':'');
    }catch(error){if(!isDisposed()){status.textContent='列表读取失败，请点顶栏「刷新」重试。';ctx.report(error);}}
    finally{busy=false;if(!isDisposed())draw();}
  }
  void load();
}

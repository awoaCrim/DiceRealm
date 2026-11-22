import test from 'node:test';
import assert from 'node:assert/strict';
import {installDom,settle} from './dom-shim.mjs';
installDom();
const {createDialogHost,createDrawerHost}=await import('../src/workspace-dialog.js');
const {h}=await import('../src/dom.js');

test('drawer replacement and owner disposal invalidate late renders without opening a modal',async()=>{
  document.body.replaceChildren();const owner=h('div'),column=h('aside');owner.append(column);document.body.append(owner);
  const drawer=createDrawerHost(column,owner);let reject,dead,disposed=0;
  drawer.open({title:'审核',render:({body,isDisposed})=>{dead=isDisposed;body.addEventListener('dispose',()=>disposed++);return new Promise((_,r)=>reject=r);}});
  assert.equal(column.hidden,false);assert.equal(document.body.querySelector('dialog'),null);
  drawer.open({title:'裁定',render:({body})=>body.append(h('p',{},'保留表单'))});
  assert.equal(dead(),true);assert.equal(disposed,1);reject(Error('旧请求'));await settle();
  assert.match(column.textContent,/保留表单/);assert.doesNotMatch(column.textContent,/旧请求/);
  owner.dispatchEvent({type:'dispose'});assert.equal(column.hidden,true);assert.equal(drawer.isOpen(),false);
  drawer.open({title:'迟到',render:()=>assert.fail('disposed owner')});assert.equal(column.hidden,true);
});
test('drawer Escape respects IME and native-modal priority',()=>{
  document.body.replaceChildren();const owner=h('div'),column=h('aside');document.body.append(owner,column);const drawer=createDrawerHost(column,owner);
  drawer.open({title:'审核',render:()=>{}});
  const escape=(props={})=>{const e=new Event('keydown',{cancelable:true});Object.assign(e,{key:'Escape',...props});window.dispatchEvent(e);return e;};
  escape({isComposing:true});assert.equal(drawer.isOpen(),true);escape({keyCode:229});assert.equal(drawer.isOpen(),true);
  const modal=h('dialog',{open:true});document.body.append(modal);escape();assert.equal(drawer.isOpen(),true);modal.remove();
  assert.equal(escape().defaultPrevented,true);assert.equal(drawer.isOpen(),false);owner.dispatchEvent({type:'dispose'});
});

test('tool windows never mount in-flow, and queued old close cannot dispose replacement',async()=>{
  document.body.replaceChildren();const owner=h('div'),dialogs=createDialogHost(owner);let firstDisposed=false,secondDisposed=false;
  dialogs.open({title:'第一个工具',render:({body})=>{body.append(h('p',{},'第一条'));body.addEventListener('dispose',()=>firstDisposed=true);}});
  const old=document.body.querySelector('dialog');old.close=()=>setTimeout(()=>old.dispatchEvent({type:'close'}),0);
  dialogs.open({title:'第二个工具',render:({body})=>{body.append(h('p',{},'第二条'));body.addEventListener('dispose',()=>secondDisposed=true);}});
  await settle();assert.equal(owner.textContent,'');assert.equal(document.body.querySelectorAll('dialog').length,1);
  assert.match(document.body.querySelector('dialog').textContent,/第二条/);assert.equal(firstDisposed,true);assert.equal(secondDisposed,false);
  owner.dispatchEvent({type:'dispose'});assert.equal(secondDisposed,true);assert.equal(document.body.querySelector('dialog'),null);
  dialogs.open({title:'迟到打开',render:()=>assert.fail('disposed owner')});assert.equal(document.body.querySelector('dialog'),null);
});
test('nested record window closes with its source tool and late failure stays detached',async()=>{
  document.body.replaceChildren();const owner=h('div'),dialogs=createDialogHost(owner);let reject,dead;
  dialogs.open({title:'世界手记',render:({body})=>{
    const records=createDialogHost(body);
    records.open({title:'记录详情',render:({isDisposed})=>{dead=isDisposed;return new Promise((_,r)=>reject=r);}});
  }});
  assert.equal(document.body.querySelectorAll('dialog').length,2);owner.dispatchEvent({type:'dispose'});
  assert.equal(dead(),true);reject(Error('late read'));await settle();assert.equal(document.body.querySelector('dialog'),null);
});

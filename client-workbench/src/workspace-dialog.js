import {h,closeButton} from './dom.js';
import {attachDialogDrag} from './dialog-drag.js';
import {createPresentationMotion} from './presentation-motion.js';

// A view owns its tool window. Closing the view invalidates late reads and closes the
// window; opening another tool replaces it without expanding the document flow.
export function createDialogHost(owner,options={}){
  let disposed=false,current=null;
  function finish(state){
    if(state.closed)return;
    state.closed=true;
    if(current===state)current=null;
    state.body.dispatchEvent(new Event('dispose'));
    state.dialog.close();state.dialog.remove();
    const target=state.returnFocus?.()||state.opener;
    if(target?.isConnected)target.focus({preventScroll:true});
  }
  function close(){if(current)finish(current);}
  owner.addEventListener('dispose',()=>{disposed=true;close();},{once:true});
  function open({title,render,wide=true,returnFocus}){
    if(disposed)return;
    close();
    const body=h('div.workspace-dialog-body'),opener=document.activeElement;
    const dialog=h('dialog.modal.workspace-dialog',{'aria-label':title},
      h('div.modal-head',{},h('h3',{},title),closeButton('关闭'+title,()=>finish(state))),body);
    if(wide)dialog.classList.add('workspace-dialog-wide');
    const state={dialog,body,opener,returnFocus,closed:false};current=state;
    const isDisposed=()=>disposed||state.closed;
    dialog.addEventListener('close',()=>{if(!state.closed)finish(state);},{once:true});
    document.body.append(dialog);attachDialogDrag(dialog);dialog.showModal();
    try{
      Promise.resolve(render({body,isDisposed,close:()=>finish(state)})).catch(error=>{
        if(!isDisposed())body.append(h('p.error-box',{role:'alert'},error.message||'暂时无法读取，请关闭后重试。'));
      });
    }catch(error){if(!isDisposed())body.append(h('p.error-box',{role:'alert'},error.message||'暂时无法读取，请关闭后重试。'));}
  }
  function button(label,render,{note='',wide=true,className='btn btn-ghost'}={}){
    return h('button',{type:'button',class:className,onclick:()=>open({title:label,render,wide})},
      note?h('strong',{},label):label,note?h('span.small',{},note):null);
  }
  return {open,button,close};
}

// The story's docked task pane: one task at a time beside the story, never modal.
// Esc respects IME and lets native dialogs and topbar panels go first; closing restores focus.
// `key` names the open task so the task strip can mark it; `onBack` returns to the overview.
export function createDrawerHost(container,owner=container,{onOpen,onClose,onBack}={}){
  let disposed=false,current=null;
  const motion=createPresentationMotion(owner);

  function finish(state){
    if(state.closed)return;
    state.closed=true;
    if(current===state)current=null;
    state.body.dispatchEvent(new Event('dispose'));
    state.element.remove();
    container.hidden=true;
    onClose?.();
    state.onClose?.();
    const target=state.returnFocus?.()||state.opener;
    if(target?.isConnected)target.focus({preventScroll:true});
  }

  function close(){
    if(current)finish(current);
  }

  function onKeyDown(event){
    if(event.key!=='Escape'||event.isComposing||event.keyCode===229||event.defaultPrevented)return;
    if(document.querySelector('dialog[open]'))return;
    if(document.querySelector('.reading-help[open]'))return;
    if(!current||current.closed)return;
    event.preventDefault();
    close();
  }

  window.addEventListener('keydown',onKeyDown);
  owner.addEventListener('dispose',()=>{
    disposed=true;
    close();
    window.removeEventListener('keydown',onKeyDown);
  },{once:true});

  function open({key='',title,flag='',subtitle='',render,returnFocus,onClose:itemClose}){
    if(disposed)return;
    close();
    container.hidden=false;
    const body=h('div.pane-body');
    const foot=h('div.pane-foot');
    const opener=document.activeElement;
    const errorSlot=h('div.pane-alerts',{'aria-live':'polite'});
    const back=onBack?h('button.pane-back',{type:'button',onclick:()=>{finish(state);onBack();}},h('span',{'aria-hidden':'true'},'←'),'主持概览'):h('span');
    const nav=h('div.pane-nav',{},back,closeButton('关闭'+title,()=>finish(state)));
    const head=h('header.pane-head',{},h('div.side-h',{},h('h2.side-title',{},title),flag?h('span.side-flag',{},flag):null),
      subtitle?h('p.pane-sub',{},subtitle):null);
    const element=h('section.pane.pane-task',{'aria-label':title},nav,head,errorSlot,body,foot);
    container.replaceChildren(element);
    motion.stop();motion(element,'slide');
    const state={key,element,body,errorSlot,opener,returnFocus,onClose:itemClose,closed:false};
    current=state;
    onOpen?.(key);
    const isDisposed=()=>disposed||state.closed;
    const settleFoot=()=>{foot.hidden=!foot.children.length;};
    const failed=error=>{if(!isDisposed())body.append(h('p.error-box',{role:'alert'},error.message||'暂时无法读取，请关闭后重试。'));};
    try{
      Promise.resolve(render({body,foot,errorSlot,isDisposed,close:()=>finish(state)})).then(settleFoot,failed);
    }catch(error){failed(error);}
    settleFoot();
  }

  return {
    open,
    close,
    currentKey(){return current&&!current.closed?current.key:'';},
    isOpen(){return !!current&&!current.closed;}
  };
}

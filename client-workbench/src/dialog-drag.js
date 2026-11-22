// Numeric-only movement through the Web Animations API: no inline style or CSP changes.
// Native dialog top-layer ordering and its inert background remain browser-owned.
export function clampDialogOffset(rect, viewport, offset) {
  const margin=8;
  const fit=(size,space,value)=>Math.max(margin,Math.min(value,Math.max(margin,space-size-margin)));
  return {x:fit(rect.width,viewport.width,rect.left+offset.x)-rect.left,
    y:fit(rect.height,viewport.height,rect.top+offset.y)-rect.top};
}

export function attachDialogDrag(dialog) {
  const head=dialog.querySelector('.modal-head'),view=dialog.ownerDocument.defaultView;
  if(!head)return;
  let pointer=null,start=null,offset={x:0,y:0},animation=null,disposed=false;
  head.classList.add('dialog-drag-handle');
  function apply(next){
    const rect=dialog.getBoundingClientRect();
    const base={left:rect.left-offset.x,top:rect.top-offset.y,width:rect.width,height:rect.height};
    offset=clampDialogOffset(base,{width:view.innerWidth,height:view.innerHeight},next);
    // Two identical endpoints apply the final transform even while paused at time zero.
    const transform=`translate(${offset.x}px, ${offset.y}px)`,frames=[{transform},{transform}];
    if(!animation){animation=dialog.animate(frames,{duration:1,fill:'both'});animation.pause();}
    else animation.effect.setKeyframes(frames);
  }
  function down(event){
    if(disposed||event.button!==0||event.target.closest('button,input,select,textarea,a,[contenteditable]'))return;
    pointer=event.pointerId;start={x:event.clientX,y:event.clientY,offsetX:offset.x,offsetY:offset.y};
    head.setPointerCapture(pointer);head.classList.add('dragging');event.preventDefault();
  }
  function move(event){
    if(event.pointerId!==pointer||!start)return;
    apply({x:start.offsetX+event.clientX-start.x,y:start.offsetY+event.clientY-start.y});
  }
  function end(){
    if(pointer!==null&&head.hasPointerCapture(pointer))head.releasePointerCapture(pointer);
    pointer=null;start=null;head.classList.remove('dragging');
  }
  function resize(){if(!disposed&&dialog.open&&animation)apply(offset);}
  function dispose(){
    if(disposed)return;disposed=true;end();animation?.cancel();observer?.disconnect();
    view.removeEventListener('resize',resize);
    head.removeEventListener('pointerdown',down);head.removeEventListener('pointermove',move);
    head.removeEventListener('pointerup',end);head.removeEventListener('pointercancel',end);head.removeEventListener('lostpointercapture',end);
  }
  head.addEventListener('pointerdown',down);head.addEventListener('pointermove',move);
  head.addEventListener('pointerup',end);head.addEventListener('pointercancel',end);head.addEventListener('lostpointercapture',end);
  view.addEventListener('resize',resize);
  const observer=typeof ResizeObserver==='undefined'?null:new ResizeObserver(resize);observer?.observe(dialog);
  dialog.addEventListener('close',dispose,{once:true});
  return dispose;
}

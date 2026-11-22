import test from 'node:test';
import assert from 'node:assert/strict';
import {clampDialogOffset,attachDialogDrag} from '../src/dialog-drag.js';
import {installDom} from './dom-shim.mjs';
import {h} from '../src/dom.js';

test('title drag clamps all fitting dialog edges within viewport',()=>{
  const rect={left:300,top:200,width:680,height:480},view={width:1280,height:720};
  assert.deepEqual(clampDialogOffset(rect,view,{x:-900,y:-900}),{x:-292,y:-192});
  assert.deepEqual(clampDialogOffset(rect,view,{x:900,y:900}),{x:292,y:32});
  assert.deepEqual(clampDialogOffset(rect,view,{x:12,y:15}),{x:12,y:15});
});

test('drag is title-only, uses pointer capture and cleans movement on close',()=>{
  const doc=installDom(),head=h('div.modal-head',{},h('h3',{},'标题'));
  const dialog=h('dialog.modal',{},head);doc.body.append(dialog);
  let captured=null,cancelled=0,frames;
  head.setPointerCapture=id=>captured=id;head.hasPointerCapture=id=>captured===id;head.releasePointerCapture=()=>{captured=null;};
  dialog.getBoundingClientRect=()=>({left:300,top:200,width:680,height:480});
  dialog.animate=f=>{frames=f;return {pause(){},cancel(){cancelled++;},effect:{setKeyframes(f){frames=f;}}};};
  attachDialogDrag(dialog);
  const down={type:'pointerdown',button:0,pointerId:1,clientX:350,clientY:220,preventDefault(){},target:{closest:()=>true}};
  head.dispatchEvent(down);assert.equal(captured,null,'buttons and fields are excluded');
  down.target={closest:()=>null};head.dispatchEvent(down);assert.equal(captured,1);
  head.dispatchEvent({type:'pointermove',pointerId:1,clientX:400,clientY:250});
  assert.deepEqual(frames,[{transform:'translate(50px, 30px)'},{transform:'translate(50px, 30px)'}]);
  dialog.close();assert.equal(captured,null);assert.equal(cancelled,1);
  assert.equal(head.listeners.pointerdown.length,0);assert.equal(head.listeners.pointermove.length,0);
});

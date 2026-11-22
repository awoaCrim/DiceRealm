import test from 'node:test';
import assert from 'node:assert/strict';
import {installDom,settle} from './dom-shim.mjs';
installDom();
const {rulingEditor}=await import('../src/ruling-editor.js');

test('board settlement submits only the saved ruling identity, not editable coordinates or mechanics',async()=>{
  const sent=[];
  const ctx={scope:'isolated-board',snapshot:{id:'board-fixture'},submit:async(path,body)=>sent.push({path,body}),refresh:async()=>{},report:e=>{throw e;}};
  const ordinary=rulingEditor(ctx,{id:'ordinary',text:'普通请求'});
  assert.ok(!ordinary.querySelector('select').options.some(o=>o.value==='board_move'));
  const form=rulingEditor(ctx,{id:'board-ruling',boardMoveId:'saved-intention',text:'移动到已记录位置'});
  assert.ok(form.querySelector('select').options.some(o=>o.value==='board_move'));
  form.querySelector('select').value='board_move';
  form.querySelector('input[type=text]').value='原限制已经解除';
  form.querySelector('textarea').value='按原移动意图落实';
  form.onsubmit({preventDefault(){}});await settle();
  assert.equal(document.body.querySelector('dialog'),null,'the explicit submit is the only confirmation');
  assert.ok(form.textContent.includes('当前仍有移动限制时会拒绝'));
  assert.equal(sent.length,1);assert.equal(sent[0].path,'rulings/respond');
  assert.equal(sent[0].body.outcome,'board_move');assert.equal(sent[0].body.rulingId,'board-ruling');
  assert.ok(!('destination' in sent[0].body));assert.ok(!('hitPoints' in sent[0].body));assert.equal(sent[0].body.dc,0);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {installDom,settle} from './dom-shim.mjs';
installDom();
const {rulingEditor}=await import('../src/ruling-editor.js');
const {readDraft,draftKey}=await import('../src/drafts.js');
let serial=0;
function setup(overrides={}){
  const sent=[],errors=[],scope='ruling-editor-'+(++serial);
  const ctx={scope,snapshot:{id:scope,version:9},submit:async(path,body)=>{sent.push({path,body});},refresh:async()=>{},report:e=>errors.push(e.message),...overrides};
  const ruling={id:'ruling',text:'观察周围',sceneId:'scene'};
  return {ctx,ruling,sent,errors,form:rulingEditor(ctx,ruling)};
}
const field=(form,label)=>form.querySelector(`[aria-label="${label}"]`);
function input(el,value){el.value=value;el.dispatchEvent({type:'input'});}
const send=form=>form.onsubmit({preventDefault(){}});

test('ordinary response has one required text and optional collapsed additions, submits once without modal',async()=>{
  const s=setup();
  assert.equal(s.form.querySelector('details').open,false);
  assert.equal(s.form.querySelectorAll('fieldset')[1].hidden,true);
  input(field(s.form,'给玩家的回应'),'可以看到路边的车辙。');
  send(s.form);send(s.form);await settle();
  assert.equal(s.sent.length,1);
  assert.equal(s.sent[0].body.ruleSource,'主持根据当前情境裁定');
  assert.equal(s.sent[0].body.outcome,'narrative');
  assert.equal(s.sent[0].body.dc,0);
  assert.equal(document.body.querySelector('dialog'),null);
  assert.ok(!readDraft(draftKey(s.ctx.scope,s.ruling.id)));
  send(s.form);await settle();assert.equal(s.sent.length,1);
});

test('check requires explicit DC and keeps player consent boundary and private/source fields',async()=>{
  const s=setup();
  input(field(s.form,'给玩家的回应'),'辨认留下的踪迹。');
  const outcome=field(s.form,'处理方式');outcome.value='check';outcome.onchange();
  assert.equal(s.form.querySelectorAll('fieldset')[1].hidden,false);
  assert.match(s.form.textContent,/玩家确认后才掷骰/);
  send(s.form);await settle();assert.equal(s.sent.length,0);assert.match(s.errors[0],/DC/);
  input(field(s.form,'DC（5 至 30）'),'14');
  input(field(s.form,'裁定依据'),'剧本中的踪迹条件');
  input(field(s.form,'仅该玩家与你可见'),'你想起旧日经历。');
  send(s.form);await settle();
  assert.equal(s.sent[0].path,'rulings/respond');
  assert.equal(s.sent[0].body.dc,14);assert.equal(s.sent[0].body.privateText,'你想起旧日经历。');
  assert.equal(s.sent[0].body.ruleSource,'剧本中的踪迹条件');
  assert.ok(!('rolls' in s.sent[0].body));
});

test('late success from a closed editor preserves a newer draft and does not refresh another view',async()=>{
  let finish,closed=false,refreshes=0;
  const s=setup({submit:()=>new Promise(resolve=>{finish=resolve;}),refresh:async()=>{refreshes++;}});
  const old=rulingEditor(s.ctx,s.ruling,{isDisposed:()=>closed});
  input(field(old,'给玩家的回应'),'已发送的回应');send(old);closed=true;
  const reopened=rulingEditor(s.ctx,s.ruling);input(field(reopened,'给玩家的回应'),'之后补充的新草稿');
  finish();await settle();assert.equal(refreshes,0);
  assert.match(readDraft(draftKey(s.ctx.scope,s.ruling.id)),/之后补充的新草稿/);
});

test('stale and disposed forms never submit; failures retain unsent draft; acknowledged refresh failure cannot resubmit',async()=>{
  const s=setup();input(field(s.form,'给玩家的回应'),'保留这份回应');
  s.ctx.snapshot.version=10;send(s.form);await settle();assert.equal(s.sent.length,0);assert.match(s.errors[0],/重新打开/);
  const restored=rulingEditor(s.ctx,s.ruling);assert.equal(field(restored,'给玩家的回应').value,'保留这份回应');
  const closed=rulingEditor(s.ctx,s.ruling,{isDisposed:()=>true});send(closed);await settle();assert.equal(s.sent.length,0);
  s.ctx.submit=async()=>{throw Error('请求未确认');};send(restored);await settle();
  assert.match(s.errors.at(-1),/请求未确认/);assert.ok(readDraft(draftKey(s.ctx.scope,s.ruling.id)));
  s.ctx.submit=async()=>s.sent.push('ack');s.ctx.refresh=async()=>{throw Error('刷新失败');};
  send(restored);await settle();assert.equal(s.sent.length,1);assert.ok(!readDraft(draftKey(s.ctx.scope,s.ruling.id)));
  input(field(restored,'给玩家的回应'),'迟到输入');send(restored);await settle();
  assert.equal(s.sent.length,1);assert.ok(!readDraft(draftKey(s.ctx.scope,s.ruling.id)));
});

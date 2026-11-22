import test from 'node:test';
import assert from 'node:assert/strict';
import {installDom,settle} from './dom-shim.mjs';
import {createStoryProgress} from '../src/story-progress.js';
import {modelRequestQuery} from '../src/api.js';
installDom();
const run={id:'run-a',actorName:'琳',actorId:'a',actionId:'action-a',status:'completed',succeeded:true,steps:[{number:1,kind:'model',status:'done'},{number:2,kind:'tool',tool:'ask_player',status:'done'}]};
const summary={id:3,runId:'run-a',client:'OpenAiHarnessModel',startedAt:'2026-10-06T12:00:00Z',method:'POST',url:'https://fixture/v1',attempt:1,status:200,finished:true};
const open=async node=>{node.open=true;node.dispatchEvent({type:'toggle'});await settle();};
const click=async node=>{node.dispatchEvent({type:'click'});await settle();};
const button=(root,text)=>root.querySelectorAll('button').find(b=>b.textContent===text);
const stepDetail={runId:'run-a',actionId:'action-a',actorId:'a',number:2,kind:'tool',tool:'ask_player',status:'done',request:{question:'去哪儿？'},response:{content:'{"question":"去哪儿？"}',stop:true,isError:false}};

test('compact steps open independent reader with exact args/results, including terminal tool; close and refresh do not expand chat',async()=>{
  const calls=[];const ctx={read:async(key,p)=>{calls.push([key,p]);return stepDetail;}};
  const view=createStoryProgress(run,{ctx});assert.equal(view.element.open,false);await open(view.element);assert.equal(calls.length,0);
  await click(view.element.querySelector('[data-step="2"]'));
  const dialog=document.body.querySelector('dialog');assert.ok(dialog);assert.match(dialog.textContent,/调用参数.*去哪儿.*返回内容.*去哪儿/s);
  assert.deepEqual(calls,[['adventure-step',{actorId:'a',actionId:'action-a',number:2}]]);
  assert.equal(view.element.querySelectorAll('pre').length,0);
  view.update({...run});assert.equal(document.body.querySelector('dialog'),dialog);
  dialog.close();assert.equal(document.body.querySelector('dialog'),null);
  view.dispose();
});

test('HTTP bodies load on request selection, in a dialog with response/request tabs and no raw copies',async()=>{
  const calls=[];const ctx={read:async(key,p)=>{calls.push([key,p]);
    if(key==='model-requests')return {requests:[summary],nextBefore:null};
    return {summary,requestBody:JSON.stringify({messages:[{role:'user',content:'搭话'}],tools:[]}),responseBody:JSON.stringify({choices:[{message:{role:'assistant',content:'公开对白'}}]})};
  }};
  const view=createStoryProgress(run,{ctx});await open(view.element);assert.equal(calls.length,0);
  await click(button(view.element,'查看本轮 HTTP 请求'));
  const dialog=document.body.querySelector('dialog');
  assert.deepEqual(calls[0],['model-requests',{runId:'run-a',limit:50,before:null}]);
  assert.deepEqual(calls[1],['model-request',{requestId:3,publicOnly:true}]);
  assert.match(dialog.textContent,/公开对白/);assert.doesNotMatch(dialog.textContent,/复制响应原文|原始响应/);
  assert.ok(button(dialog,'刷新列表'));await click(button(dialog,'刷新列表'));assert.equal(calls.filter(([k])=>k==='model-requests').length,2);
  await click(button(dialog,'请求'));assert.match(dialog.textContent,/搭话/);assert.equal(dialog.querySelectorAll('details').length,0);
  assert.equal(view.element.querySelectorAll('.request-detail').length,0);
  assert.equal(new URLSearchParams(modelRequestQuery({runId:'run-a'})).get('runId'),'run-a');view.dispose();
});

test('HTTP pagination preserves selected response, its scroll, and selection',async()=>{
  const reads=[];const ctx={read:async(key,p)=>{
    if(key==='model-requests')return p.before==null?{requests:[summary,{...summary,id:2}],nextBefore:2}:{requests:[{...summary,id:1}],nextBefore:null};
    reads.push(p.requestId);return {summary:{...summary,id:p.requestId},requestBody:'{}',responseBody:'正文 '+p.requestId};
  }};
  const view=createStoryProgress(run,{ctx});await click(button(view.element,'查看本轮 HTTP 请求'));
  const dialog=document.body.querySelector('dialog');await click(dialog.querySelectorAll('.trace-choice')[1]);
  const pane=dialog.querySelector('.trace-reading'),detail=pane.firstChild;pane.scrollTop=81;
  await click(button(dialog,'更早的请求'));
  assert.equal(pane.firstChild,detail);assert.equal(pane.scrollTop,81);assert.deepEqual(reads,[3,2]);
  assert.equal(dialog.querySelectorAll('.trace-choice')[1].getAttribute('aria-pressed'),'true');view.dispose();
});

test('failed step/detail can retry; closing and selecting a different step invalidate late reads',async()=>{
  let fail=true,resolve;const ctx={read:async()=>{if(fail)throw new Error('读取失败');return new Promise(r=>resolve=r);}};
  const view=createStoryProgress(run,{ctx});await click(view.element.querySelector('[data-step="2"]'));
  const dialog=document.body.querySelector('dialog');assert.match(dialog.textContent,/读取失败/);
  fail=false;await click(button(dialog,'重试读取'));dialog.close();resolve(stepDetail);await settle();
  assert.doesNotMatch(dialog.textContent,/去哪儿/);assert.equal(document.body.querySelector('dialog'),null);view.dispose();
});

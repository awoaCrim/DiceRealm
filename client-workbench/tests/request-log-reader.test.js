import test from 'node:test';
import assert from 'node:assert/strict';
import {installDom,settle} from './dom-shim.mjs';
import {requestLogCard,requestDetail} from '../src/request-log.js';
installDom();
const button=(root,text)=>root.querySelectorAll('button').find(b=>b.textContent===text);
const click=async node=>{node.dispatchEvent({type:'click'});await settle();};
const summaries=[2,1].map(id=>({id,startedAt:'2026-10-06T12:00:00Z',client:'OpenAiHarnessModel',campaignId:'campaign',input:'行动 '+id,attempt:id,status:200,finished:true,method:'POST',url:'https://fixture/v1'}));
const detail=id=>({summary:summaries.find(s=>s.id===id),requestBody:JSON.stringify({messages:[{role:'system',content:'系统长提示词'},{role:'user',content:'行动 '+id}]}),responseBody:JSON.stringify({choices:[{message:{content:'响应 '+id}}]})});

test('filter changes during a list read discard its result or error and reload the selected filter',async()=>{
  for(const rejectOld of [false,true]){
    const mount=document.createElement('div');document.body.append(mount);
    let finish;const reads=[];
    const log=requestLogCard(mount,{list:params=>{
      reads.push(params);
      if(reads.length===1)return new Promise((resolve,reject)=>{finish=()=>rejectOld?reject(Error('旧筛选失败')):resolve({requests:summaries,nextBefore:1});});
      return Promise.resolve({requests:[],nextBefore:null});
    },detail});
    const loading=log.reload(),filter=mount.querySelector('input');
    filter.checked=true;filter.dispatchEvent({type:'change'});
    finish();await loading;await settle();
    assert.deepEqual(reads.map(r=>[r.failed,r.before]),[[false,null],[true,null]]);
    assert.match(mount.textContent,/没有 HTTP 失败的请求/);
    assert.doesNotMatch(mount.textContent,/旧筛选失败/);
    assert.equal(mount.querySelectorAll('tbody tr').length,0);
    mount.dispatchEvent({type:'dispose'});mount.remove();
  }
});

test('shared detail uses visible sections and explicit raw buttons, with no raw diagnostics in public readers',async()=>{
  const node=requestDetail(detail(2),{campaignName:()=> '隔离战役'});
  assert.match(node.textContent,/响应 2/);assert.doesNotMatch(node.textContent,/系统长提示词/);
  assert.equal(button(node,'响应').getAttribute('aria-pressed'),'true');
  assert.ok(button(node,'复制响应原文'));
  assert.equal(node.querySelectorAll('details').length,0);
  await click(button(node,'原始响应'));assert.match(node.querySelector('pre').textContent,/响应 2/);
  await click(button(node,'分段内容'));
  await click(button(node,'请求'));assert.match(node.textContent,/系统长提示词/);
  assert.equal(node.querySelectorAll('details').length,0);assert.ok(button(node,'复制请求原文'));
  await click(button(node,'原始请求 JSON'));assert.deepEqual(JSON.parse(node.querySelector('pre').textContent),JSON.parse(detail(2).requestBody));
  await click(button(node,'概况'));assert.match(node.textContent,/隔离战役/);assert.equal(node.querySelectorAll('pre').length,0);
  const safe=requestDetail(detail(2),{publicOnly:true});
  for(const tab of ['响应','请求']){await click(button(safe,tab));assert.doesNotMatch(safe.textContent,/复制.*原文|原始响应|原始请求 JSON/);}
});

test('request dialog navigates loaded rows, ignores stale reads, retries failures and closes on owner disposal',async()=>{
  const mount=document.createElement('div');document.body.append(mount);
  let resolveOld,mode='held';const reads=[];
  const log=requestLogCard(mount,{list:async()=>({requests:summaries,nextBefore:null}),detail:async id=>{
    reads.push(id);
    if(id===2&&mode==='held')return new Promise(resolve=>resolveOld=resolve);
    if(mode==='failed')throw Error('读取暂时失败');
    return detail(id);
  }});
  await log.reload();await click(button(mount,'查看'));
  const dialog=document.body.querySelector('dialog'),choices=dialog.querySelectorAll('.trace-choice');
  assert.equal(choices.length,2);
  await click(choices[1]);assert.match(dialog.textContent,/响应 1/);
  resolveOld(detail(2));await settle();assert.doesNotMatch(dialog.textContent,/响应 2/);
  assert.equal(choices[1].getAttribute('aria-pressed'),'true');
  const reader=dialog.querySelector('.trace-reading'),content=reader.firstChild;reader.scrollTop=80;
  await log.poll();assert.equal(reader.firstChild,content);assert.equal(reader.scrollTop,80);
  mode='failed';await click(button(dialog,'刷新'));assert.match(dialog.textContent,/读取暂时失败/);
  mode='ready';await click(button(dialog,'重试读取'));assert.match(dialog.textContent,/响应 1/);
  mode='held';await click(choices[0]);mount.dispatchEvent({type:'dispose'});
  resolveOld(detail(2));await settle();assert.equal(document.body.querySelector('dialog'),null);assert.doesNotMatch(reader.textContent,/响应 2/);
  assert.deepEqual(reads,[2,1,1,1,2]);mount.remove();
});

test('inline request selection clears old text and rejects late, mismatched and disposed responses',async()=>{
  const mount=document.createElement('div');document.body.append(mount);
  let resolveOld,mode='held';
  const log=requestLogCard(mount,{inline:true,list:async()=>({requests:summaries,nextBefore:null}),detail:async id=>{
    if(id===2&&mode==='held')return new Promise(resolve=>resolveOld=resolve);
    if(mode==='wrong')return detail(2);
    return detail(id);
  }});
  await log.reload();await settle();
  const reader=mount.querySelector('.request-reading'),choices=mount.querySelectorAll('.trace-choice');
  assert.match(reader.textContent,/正在读取/);
  await click(choices[1]);assert.match(reader.textContent,/响应 1/);
  resolveOld(detail(2));await settle();assert.doesNotMatch(reader.textContent,/响应 2/);
  assert.equal(choices[1].getAttribute('aria-pressed'),'true');
  mode='wrong';await click(choices[1]);assert.match(reader.textContent,/不属于选中的请求/);assert.doesNotMatch(reader.textContent,/响应 1/);
  mode='ready';await click(button(reader,'重试读取'));assert.match(reader.textContent,/响应 1/);
  mode='held';await click(choices[0]);mount.dispatchEvent({type:'dispose'});
  resolveOld(detail(2));await settle();assert.doesNotMatch(reader.textContent,/响应 2/);mount.remove();
});

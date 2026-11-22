import test from 'node:test';
import assert from 'node:assert/strict';
import {installDom} from './dom-shim.mjs';
installDom();
const {watchDashboard}=await import('../src/dashboard-sync.js');
const button=(mount,text)=>mount.querySelectorAll('button').find(b=>b.textContent===text);

test('watch dashboard is sequential, stops on failure, retries explicitly, and ignores disposed responses',async()=>{
  const mount=document.createElement('div'),seen=[],tasks=[];let calls=0,resolve,fail=false;
  const watcher=watchDashboard(mount,{snapshot:()=>{calls++;if(fail)return Promise.reject(Error('断网'));return new Promise(r=>{resolve=r;});}},value=>seen.push(value),{schedule:fn=>{tasks.push(fn);return tasks.length;},cancel:()=>{}});
  const first=watcher.poll();await watcher.poll();assert.equal(calls,1);resolve({version:1});await first;assert.equal(seen.length,1);
  fail=true;await watcher.poll();assert.match(mount.textContent,/实时同步已暂停/);assert.equal(button(mount,'重新连接看板').hidden,false);
  fail=false;const last=watcher.poll();mount.dispatchEvent({type:'dispose'});resolve({version:2});await last;assert.equal(seen.length,1);
  await watcher.poll();assert.equal(calls,3);
});
